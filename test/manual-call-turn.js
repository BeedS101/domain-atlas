// Two real wallets (two Chromium profiles) place calls whose audio is forced through a TURN relay.
//
// WHAT IS REAL AND WHAT IS NOT
//   Real: both wallets, the Call Service, Chromium's own TURN client and WebRTC stack, the
//   DTLS-SRTP handshake and audio carried through the relay, the fingerprint check.
//   Simulated: the TURN server. test/turn-fixture-lib.js is a small stand-in written for these
//   tests; it is not coturn. A pass here shows the wallets and the service behave correctly against
//   a server that enforces coturn-style time-limited credentials. It does not show that coturn,
//   configured as the deployment guide describes, behaves the same.
//   Real coturn: set TURN_URL (for example turn:turn.example.net:3478) and TURN_SECRET (the
//   static-auth-secret) and the relay scenario is repeated against that server, whose address must
//   be reachable from this machine. Without them that part is reported as SKIPPED.
//
// Needs the local demo domain on 8002 (see test/run-call-tests.sh).
// Run: xvfb-run -a node test/manual-call-turn.js
//
// Both browsers run on one machine, so this shows nothing about NATs, firewalls or two networks.
'use strict';
const crypto = require('crypto');
const L = require('./call-e2e-lib');
const { startTurnFixture, selfSignedCert, localIPv4 } = require('./turn-fixture-lib');
const { check, sleep, until } = L;

const SECRET = crypto.randomBytes(32).toString('hex');
const hmac = (secret, user) => crypto.createHmac('sha1', secret).update(user).digest('base64');

// Test-only page script: records the ICE configuration handed to every RTCPeerConnection and, when
// asked, forces the browser to use relay candidates only. The wallet itself never does the latter.
const instrument = () => {
  if (!/\/call\.html/.test(location.pathname)) return;
  window.__iceConfigs = [];
  window.__relayOnly = false;
  const Orig = window.RTCPeerConnection;
  const Wrapped = function (cfg, ...rest) {
    window.__iceConfigs.push(JSON.parse(JSON.stringify((cfg && cfg.iceServers) || [])));
    const c = Object.assign({}, cfg);
    if (window.__relayOnly) c.iceTransportPolicy = 'relay';
    return new Orig(c, ...rest);
  };
  Wrapped.prototype = Orig.prototype;
  Object.setPrototypeOf(Wrapped, Orig);
  window.RTCPeerConnection = Wrapped;
};

const ended = async (w) => until(async () => { const t = await w.teardown(); return t || false; }, 40000, 200);

// The candidate pair the call is actually using, as the browser reports it.
const selectedPair = (w) => w.callPage.evaluate(async () => {
  const c = window.__atlasCall.getCall();
  if (!c || !c.pc) return null;
  const stats = await c.pc.getStats();
  const by = {};
  stats.forEach((s) => { by[s.id] = s; });
  let pair = null;
  stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = by[s.selectedCandidatePairId]; });
  if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
  if (!pair) return null;
  const l = by[pair.localCandidateId] || {}, r = by[pair.remoteCandidateId] || {};
  return { local: l.candidateType, localProtocol: l.protocol, relayProtocol: l.relayProtocol || null, remote: r.candidateType, remoteProtocol: r.protocol };
});

(async () => {
  const host = localIPv4();
  const cert = selfSignedCert(host);
  const fx = await startTurnFixture({ secret: SECRET, host, tls: cert || undefined });
  const svc = await L.startCallService({ turnUrls: [fx.urls.udp], turnSecret: SECRET, turnTtlSeconds: 600 }, { limits: { invitesPerCallerPerMin: 200, invitesPerCalleePerMin: 200, invitesPerSourcePerMin: 400, perSourcePerMin: 5000 } });
  // Chromium sends TCP and TLS connections to TURN through the browser's proxy settings. This
  // sandbox sets an HTTP proxy in the environment that cannot reach the test addresses, so the
  // browsers are told to connect directly.
  const tlsArgs = ['--no-proxy-server'].concat(cert ? ['--ignore-certificate-errors'] : []);
  const { alice, bob } = await L.makePair(svc, { alice: { init: instrument, args: tlsArgs }, bob: { init: instrument, args: tlsArgs } });
  let exit = 0;
  try {
    const pa = await alice.openCallWindow();
    const pb = await bob.openCallWindow();
    await bob.setTimers({ ringRateWindowMs: 300 });
    for (const w of [alice, bob]) await w.setTimers({ iceMs: 12000 });
    await bob.available();

    const relayOnly = (on) => Promise.all([alice, bob].map((w) => w.callPage.evaluate((v) => { window.__relayOnly = v; }, on)));
    const configs = (w) => w.callPage.evaluate(() => window.__iceConfigs);
    const flowing = async () => !!(await until(async () => { const a = await alice.snap(), b = await bob.snap(); return a.call && b.call && a.call.audioOn && b.call.audioOn; }, 40000, 250));
    const placeCall = async () => {
      await alice.dial('Bob');
      await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
      await pb.click('#btnAnswer');
    };
    const hangUp = async () => {
      await pa.click('#btnHangup').catch(() => {});
      await ended(alice); await ended(bob);
      await pa.click('#btnDismiss').catch(() => {}); await pb.click('#btnDismiss').catch(() => {});
      await until(() => svc.svc.stats().liveCalls === 0, 8000, 200);
    };
    const dismiss = async () => { await pa.click('#btnDismiss').catch(() => {}); await pb.click('#btnDismiss').catch(() => {}); await until(() => svc.svc.stats().liveCalls === 0, 15000, 200); };
    const media = async () => { await sleep(1500); const a = await alice.stats(), b = await bob.stats(); return { a, b, ok: a.inBytes > 0 && a.outBytes > 0 && b.inBytes > 0 && b.outBytes > 0 }; };
    const clearTeardown = () => Promise.all([alice, bob].map((w) => w.callPage.evaluate(() => { window.__atlasCall.lastTeardown = null; })));
    const zero = () => { fx.stats.relayedPackets = 0; fx.stats.relayedBytes = 0; fx.stats.relayedClasses = {}; };

    // ---------- 1. audio through the relay over UDP ----------
    console.log('\n-- SIMULATED TURN server; real Chromium TURN client and real DTLS-SRTP --');
    await relayOnly(true);
    zero();
    await placeCall();
    check('[simulated TURN] a call completes when the browser may use only relay candidates (UDP)', await flowing());
    let ca = await configs(alice), cb = await configs(bob);
    const t0 = ca[0].find((s) => s.credential);
    check('the browser was given the operator\'s TURN URL with a time-limited credential (both sides)', ca.length === 1 && cb.length === 1 && t0 && JSON.stringify(t0.urls) === JSON.stringify([fx.urls.udp]) && /^\d{10}:[A-Za-z0-9_-]+$/.test(t0.username) && t0.credential === hmac(SECRET, t0.username) && cb[0].some((s) => s.credential), { ca, cb });
    check('the two wallets were given different credentials', ca[0].find((s) => s.credential).username !== cb[0].find((s) => s.credential).username);
    const sa = await selectedPair(alice), sb = await selectedPair(bob);
    check('both wallets report a relay candidate as their selected path', sa && sb && sa.local === 'relay' && sb.local === 'relay', { sa, sb });
    check('and the relay is reached over UDP', sa && sa.relayProtocol === 'udp' && sb.relayProtocol === 'udp', { sa, sb });
    const m = await media();
    check('audio flows in both directions through the relay', m.ok, m);
    check('the simulated server authenticated clients with the minted credentials', fx.stats.authOk > 0 && fx.stats.allocations >= 2 && fx.stats.byTransport.udp > 0, fx.stats);
    check('the relay carried DTLS handshake records and SRTP packets, never anything it could read as media', (fx.stats.relayedClasses.dtls || 0) > 0 && (fx.stats.relayedClasses.rtp || 0) > 0, fx.stats.relayedClasses);
    const tr = await alice.trace();
    const early = tr.filter((e) => e.ev === 'replaceTrack' && e.track && !(e.ownConfirmed && e.peerConfirmed && e.certOk));
    check('no microphone track was attached before both fingerprints were confirmed (relay in use)', tr.some((e) => e.ev === 'replaceTrack' && e.track) && early.length === 0, tr);
    const lg = await alice.log();
    check('the remote certificate was checked against the signed fingerprint and the peer confirmed, as without TURN', lg.some((l) => /^remote-certificate-check:\{"ok":true/.test(l)) && lg.includes('peer-confirmed'), lg);
    await hangUp();
    check('after the call the simulated server shows the allocations released or expired by the client', await until(() => fx.allocationCount() === 0, 8000, 200) !== false, fx.allocationCount());

    // ---------- 2. over TCP, for networks that block UDP ----------
    svc.cfg.turnUrls = [fx.urls.tcp];
    zero();
    const tcpBefore = fx.stats.byTransport.tcp;
    await placeCall();
    check('[simulated TURN] a call completes through the relay with the browser reaching TURN over TCP', await flowing());
    const ta = await selectedPair(alice), tb = await selectedPair(bob);
    check('both wallets use a relay candidate reached over TCP', ta && tb && ta.local === 'relay' && tb.local === 'relay' && ta.relayProtocol === 'tcp' && tb.relayProtocol === 'tcp', { ta, tb });
    check('the simulated server saw TCP clients', fx.stats.byTransport.tcp > tcpBefore, fx.stats.byTransport);
    check('audio flows in both directions (TCP)', (await media()).ok);
    await hangUp();

    // ---------- 3. over TLS (turns:) ----------
    if (cert) {
      svc.cfg.turnUrls = [fx.urls.tls];
      zero();
      const tlsBefore = fx.stats.byTransport.tls;
      await placeCall();
      const tlsOk = await flowing();
      check('[simulated TURN] a call completes through the relay with the browser reaching TURN over TLS (turns:)', tlsOk, { tls: fx.stats.byTransport, log: await alice.log().catch(() => null) });
      if (tlsOk) {
        const xa = await selectedPair(alice);
        check('the selected path is a relay reached over TLS', xa && xa.local === 'relay' && fx.stats.byTransport.tls > tlsBefore, { xa, tls: fx.stats.byTransport });
        check('audio flows in both directions (TLS)', (await media()).ok);
      }
      await hangUp().catch(() => {}); await dismiss().catch(() => {});
    } else console.log('SKIPPED turns: test (openssl is not installed here to make a certificate)');

    // ---------- 4. TURN available but not needed ----------
    svc.cfg.turnUrls = [fx.urls.udp];
    await relayOnly(false);
    zero();
    await placeCall();
    check('a call completes with TURN offered and relay not forced', await flowing());
    const da = await selectedPair(alice), db = await selectedPair(bob);
    check('when a direct path exists the call uses it, not the relay', da && db && da.local !== 'relay' && db.local !== 'relay', { da, db });
    await media();
    check('so no DTLS or SRTP crossed the TURN server', !fx.stats.relayedClasses.dtls && !fx.stats.relayedClasses.rtp, fx.stats.relayedClasses);
    await hangUp();

    // ---------- 5. TURN server unavailable ----------
    const dead = await startTurnFixture({ secret: SECRET, host });
    const deadUrls = { udp: dead.urls.udp, tcp: dead.urls.tcp };
    await dead.close();
    svc.cfg.turnUrls = [deadUrls.udp, deadUrls.tcp];
    await relayOnly(false);
    await placeCall();
    check('[simulated TURN] with the TURN server down and a direct path available the call still completes', await flowing());
    const fa = await selectedPair(alice);
    check('and it uses the direct path', fa && fa.local !== 'relay', fa);
    check('the wallet logged that it was given TURN', (await alice.log()).some((l) => /^ice-servers:.*"turn":true/.test(l)));
    await hangUp();

    await relayOnly(true);
    await clearTeardown();
    const downSince = Date.now();
    await placeCall();
    const downA = await ended(alice);
    check('with the TURN server down and relay forced the call ends as not connected', downA && downA.reason === 'connect-failed', downA);
    const trDown = await alice.trace();
    const downLog = await alice.log();
    check('the wallet logged why TURN failed as a code and a scheme only', downLog.some((l) => /^turn-error:\{"code":\d+,"scheme":"turn"\}$/.test(l)) && !downLog.some((l) => l.startsWith('turn-error') && /\d+\.\d+\.\d+\.\d+/.test(l)), downLog.filter((l) => l.startsWith('turn-error')));
    check('and no microphone track was attached during that call', !trDown.some((e) => e.t >= downSince && e.ev === 'replaceTrack' && e.track), trDown.filter((e) => e.t >= downSince));
    await dismiss();

    // ---------- 6. credentials the server rejects ----------
    svc.cfg.turnUrls = [fx.urls.udp];
    fx.clockOffsetMs = 3 * 3600 * 1000;
    zero();
    const failedBefore = fx.stats.authFailed.expired;
    await clearTeardown();
    await placeCall();
    const expA = await ended(alice);
    check('[simulated TURN] credentials the server considers expired give no relay: with relay forced the call ends as not connected', expA && expA.reason === 'connect-failed', expA);
    check('the simulated server refused them as expired', fx.stats.authFailed.expired > failedBefore, fx.stats.authFailed);
    check('and relayed nothing', fx.stats.relayedPackets === 0, fx.stats);
    await dismiss();
    await relayOnly(false);
    await clearTeardown();
    await placeCall();
    check('with relay not forced the same expired credentials leave a working direct call', await flowing());
    await hangUp();
    fx.clockOffsetMs = 0;
    await relayOnly(true);
    await clearTeardown();
    await placeCall();
    check('once the server accepts the credentials again a relayed call works', await flowing());
    await hangUp();

    // ---------- 7. nothing reusable is kept ----------
    const secrets = [];
    for (const cfgs of [await configs(alice), await configs(bob)]) for (const c of cfgs) for (const s of c) if (s.credential) secrets.push(s.credential, s.username);
    check('the browser was handed credentials in every relayed call', secrets.length >= 6, secrets.length);
    const scan = async (w) => {
      const store = await w.wallet(async () => {
        const grab = async (area) => { try { return JSON.stringify(await chrome.storage[area].get(null)); } catch (e) { return ''; } };
        return (await grab('local')) + (await grab('session')) + (await grab('sync'));
      });
      const page = await w.callPage.evaluate(() => {
        let ls = '', ss = '';
        try { ls = JSON.stringify(localStorage); ss = JSON.stringify(sessionStorage); } catch (e) { /* none */ }
        const c = window.__atlasCall;
        return ls + ss + document.documentElement.innerText + JSON.stringify(c.log) + JSON.stringify(c.history) + JSON.stringify(c.snapshot());
      });
      return store + page;
    };
    const sa2 = await scan(alice), sb2 = await scan(bob);
    check('no TURN username, credential or the shared secret is in either wallet\'s storage, call log, history or page', secrets.every((s) => !sa2.includes(s) && !sb2.includes(s)) && !sa2.includes(SECRET) && !sb2.includes(SECRET));
    const ice = (await alice.log()).filter((l) => l.startsWith('ice-servers'));
    check('the wallet logged only counts and reasons for ICE servers', ice.length > 0 && ice.every((l) => /^ice-servers:\{"stun":\d+,"turn":(true|false),"dropped":\[[^\]]*\]\}$/.test(l)), ice);
    check('no page errors in either window', alice.errors.length === 0 && bob.errors.length === 0, { a: alice.errors, b: bob.errors });
  } catch (e) {
    console.log('FAIL test aborted :: ' + (e && e.stack || e));
    exit = 1;
  } finally {
    await alice.close(); await bob.close(); await svc.close(); await fx.close();
  }

  // ---------- a real coturn, when the person running the tests supplies one ----------
  if (process.env.TURN_URL && process.env.TURN_SECRET) {
    console.log('\n-- REAL TURN server from TURN_URL --');
    exit = (await realCoturn(process.env.TURN_URL, process.env.TURN_SECRET)) || exit;
  } else {
    console.log('\nSKIPPED real coturn: set TURN_URL and TURN_SECRET to repeat the relayed call against your own coturn server. Nothing in this run involved coturn.');
  }
  process.exit(L.finish('manual-call-turn') || exit);
})().catch((e) => { console.error(e); process.exit(2); });

// One relayed call, UDP or whatever the URL says, against a TURN server the person runs.
async function realCoturn(url, secret) {
  const svc = await L.startCallService({ turnUrls: [url], turnSecret: secret, turnTtlSeconds: 600 }, { limits: { invitesPerCallerPerMin: 100, invitesPerCalleePerMin: 100, invitesPerSourcePerMin: 200 } });
  const { alice, bob } = await L.makePair(svc, { alice: { init: instrument, args: ['--no-proxy-server'] }, bob: { init: instrument, args: ['--no-proxy-server'] } });
  let exit = 0;
  try {
    const pa = await alice.openCallWindow(), pb = await bob.openCallWindow();
    for (const w of [alice, bob]) { await w.setTimers({ iceMs: 20000 }); await w.callPage.evaluate(() => { window.__relayOnly = true; }); }
    await bob.available();
    await alice.dial('Bob');
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    await pb.click('#btnAnswer');
    const live = await until(async () => { const a = await alice.snap(), b = await bob.snap(); return a.call && b.call && a.call.audioOn && b.call.audioOn; }, 40000, 250);
    check('[REAL coturn] a call completes with relay forced', !!live, await alice.log());
    if (live) {
      const a = await selectedPair(alice), b = await selectedPair(bob);
      check('[REAL coturn] both wallets use a relay candidate', a && b && a.local === 'relay' && b.local === 'relay', { a, b });
      await sleep(1500);
      const sa = await alice.stats(), sb = await bob.stats();
      check('[REAL coturn] audio flows both ways', sa.inBytes > 0 && sa.outBytes > 0 && sb.inBytes > 0 && sb.outBytes > 0, { sa, sb });
    }
  } catch (e) { console.log('FAIL real coturn test aborted :: ' + (e && e.stack || e)); exit = 1; } finally {
    await alice.close(); await bob.close(); await svc.close();
  }
  return exit;
}
