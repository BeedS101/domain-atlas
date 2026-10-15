// Two real wallets call each other through a Call Service that advertises an operator STUN
// server. A small STUN responder on loopback stands in for the operator's own server. Shows
// that a wallet passes the browser only the operator's plain STUN URLs (never more than three,
// never TURN or other schemes, never anything when none is configured), that the browser
// really queries that server, and that calls still work with and without it.
//
// Needs the local demo domain on 8002 (see test/run-call-tests.sh).
// Run: xvfb-run -a node test/manual-call-stun.js
//
// Loopback only: this does not show that STUN helps across two NATs or two networks.
'use strict';
const dgram = require('dgram');
const L = require('./call-e2e-lib');
const { check, sleep, until } = L;

// A minimal RFC 5389 binding responder: answers every Binding request with the sender's address.
function startStun() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const seen = [];
    sock.on('message', (msg, rinfo) => {
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== 0x2112A442) return;
      seen.push({ at: Date.now(), from: rinfo.address + ':' + rinfo.port });
      const attr = Buffer.alloc(12);
      attr.writeUInt16BE(0x0020, 0); attr.writeUInt16BE(8, 2);
      attr.writeUInt8(0, 4); attr.writeUInt8(1, 5);
      attr.writeUInt16BE(rinfo.port ^ 0x2112, 6);
      const octets = rinfo.address.split('.').map(Number);
      const cookie = [0x21, 0x12, 0xA4, 0x42];
      for (let i = 0; i < 4; i++) attr.writeUInt8(octets[i] ^ cookie[i], 8 + i);
      const head = Buffer.alloc(20);
      head.writeUInt16BE(0x0101, 0); head.writeUInt16BE(attr.length, 2); head.writeUInt32BE(0x2112A442, 4);
      msg.copy(head, 8, 8, 20);
      sock.send(Buffer.concat([head, attr]), rinfo.port, rinfo.address);
    });
    sock.bind(0, '127.0.0.1', () => resolve({ sock, seen, port: sock.address().port, close: () => sock.close() }));
  });
}

const ended = async (w) => until(async () => { const t = await w.teardown(); return t || false; }, 15000, 200);

(async () => {
  const stun = await startStun();
  const good = 'stun:127.0.0.1:' + stun.port;
  const svc = await L.startCallService(null, { limits: { invitesPerCallerPerMin: 100, invitesPerCalleePerMin: 100, invitesPerSourcePerMin: 200 } });
  const record = () => {
    if (!/\/call\.html/.test(location.pathname)) return;
    window.__iceConfigs = [];
    const Orig = window.RTCPeerConnection;
    const Wrapped = function (cfg, ...rest) { window.__iceConfigs.push(JSON.parse(JSON.stringify((cfg && cfg.iceServers) || []))); return new Orig(cfg, ...rest); };
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
  };
  const { alice, bob } = await L.makePair(svc, { alice: { init: record }, bob: { init: record } });
  let exit = 0;
  try {
    const pa = await alice.openCallWindow();
    const pb = await bob.openCallWindow();
    // Four calls in a row from one caller would otherwise trip the callee's own limit on rings.
    await bob.setTimers({ ringRateWindowMs: 300 });
    await bob.available();
    const configs = (w) => w.callPage.evaluate(() => window.__iceConfigs);
    const placeCall = async () => {
      await alice.dial('Bob');
      await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
      await pb.click('#btnAnswer');
      const live = await until(async () => { const a = await alice.snap(), b = await bob.snap(); return a.call && b.call && a.call.audioOn && b.call.audioOn; }, 30000, 250);
      return !!live;
    };
    const hangUp = async () => {
      await pa.click('#btnHangup');
      await ended(alice);
      await ended(bob);
      await pa.click('#btnDismiss').catch(() => {}); await pb.click('#btnDismiss').catch(() => {});
      await until(() => svc.svc.stats().liveCalls === 0, 8000, 200);
    };

    // ---------- 1. no STUN configured ----------
    check('with no STUN configured the service offers none', (await fetch(svc.origin + '/atlas/call/info').then((r) => r.json())).ice.stun.length === 0);
    check('a call works with no STUN server', await placeCall());
    let ca = await configs(alice), cb = await configs(bob);
    check('with none configured the browser is given no ICE server (both sides)', ca.length === 1 && cb.length === 1 && ca[0].length === 0 && cb[0].length === 0, { ca, cb });
    check('and nothing asked the STUN responder', stun.seen.length === 0, stun.seen);
    await hangUp();

    // ---------- 2. the operator's STUN server ----------
    svc.cfg.stunUrls = [good];
    check('a call works with the operator STUN server configured', await placeCall());
    ca = await configs(alice); cb = await configs(bob);
    const want = JSON.stringify([{ urls: [good] }]);
    check('the browser is given exactly the operator\'s STUN URL, with no credentials (both sides)', ca.length === 2 && cb.length === 2 && JSON.stringify(ca[1]) === want && JSON.stringify(cb[1]) === want, { ca, cb });
    const asked = await until(() => stun.seen.length > 0, 5000, 200);
    check('the browser really asked the operator\'s STUN server', !!asked, stun.seen);
    const sa = await (async () => { await sleep(1500); return alice.stats(); })();
    check('audio flows with STUN configured', sa.inBytes > 0 && sa.outBytes > 0, sa);
    await hangUp();

    // ---------- 3. a service that hands out more than STUN ----------
    const g2 = 'stun:127.0.0.1:' + (stun.port + 1), g3 = 'stun:127.0.0.1:' + (stun.port + 2), g4 = 'stun:127.0.0.1:' + (stun.port + 3);
    svc.cfg.stunUrls = [good, 'turn:127.0.0.1:3478', 'turns:127.0.0.1:5349?transport=tcp', 'http://127.0.0.1/x', 'stun:bad host', 'stun:127.0.0.1:99999x', 'stun:user:pw@127.0.0.1', g2, g3, g4, good];
    check('a call works when the service advertises unusable URLs among good ones', await placeCall());
    ca = await configs(alice); cb = await configs(bob);
    const want3 = JSON.stringify([{ urls: [good, g2, g3] }]);
    check('the wallet drops other schemes and malformed URLs, removes duplicates and keeps at most three (caller)', ca.length === 3 && JSON.stringify(ca[2]) === want3, ca[2]);
    check('and the same on the callee side', cb.length === 3 && JSON.stringify(cb[2]) === want3, cb[2]);
    await hangUp();

    // ---------- 4. only unusable URLs ----------
    svc.cfg.stunUrls = ['turn:127.0.0.1:3478', 'https://127.0.0.1/x'];
    check('a call works when every advertised URL is unusable', await placeCall());
    ca = await configs(alice);
    check('the browser is then given no ICE server at all', ca.length === 4 && ca[3].length === 0, ca[3]);
    await hangUp();
  } catch (e) {
    console.log('FAIL test aborted :: ' + (e && e.stack || e));
    exit = 1;
  } finally {
    await alice.close(); await bob.close(); await svc.close(); stun.close();
  }
  process.exit(L.finish('manual-call-stun') || exit);
})().catch((e) => { console.error(e); process.exit(2); });
