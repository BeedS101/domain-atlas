// Slow test (about 2 minutes), not part of the default run. What happens to a relayed call when
// the TURN credential's lifetime is shorter than the call?
//
// A TURN allocation is kept alive by Refresh requests from the browser, and a TURN server that
// checks credential expiry on every request (the REST scheme's intent) refuses a Refresh made with
// an expired credential, so the allocation ends at its own lifetime. The browser keeps the
// credential it was given when the call began; the wallet cannot hand it a new one.
//
// SIMULATED TURN server (test/turn-fixture-lib.js) with a short allocation lifetime, real Chromium
// TURN client. It shows how Chromium behaves against a server that does enforce expiry on Refresh;
// whether coturn does is for the person running coturn to check with the probe and a long call.
//
// Needs the local demo domain on 8002 (see test/run-call-tests.sh).
// Run: xvfb-run -a node test/manual-call-turn-longcall.js
'use strict';
const crypto = require('crypto');
const L = require('./call-e2e-lib');
const { startTurnFixture, localIPv4 } = require('./turn-fixture-lib');
const { check, sleep, until } = L;

const SECRET = crypto.randomBytes(32).toString('hex');
const CRED_SECONDS = 60, ALLOC_SECONDS = 120, WATCH_MS = 150000;

(async () => {
  const fx = await startTurnFixture({ secret: SECRET, host: localIPv4(), lifetime: ALLOC_SECONDS });
  const svc = await L.startCallService({ turnUrls: [fx.urls.udp], turnSecret: SECRET, turnTtlSeconds: CRED_SECONDS }, { limits: { invitesPerCallerPerMin: 100, invitesPerCalleePerMin: 100, invitesPerSourcePerMin: 200 } });
  // Test-only page script: the browser may use relay candidates only.
  const init = () => {
    if (!/\/call\.html/.test(location.pathname)) return;
    const O = window.RTCPeerConnection;
    const W = function (c, ...r) { return new O(Object.assign({}, c, { iceTransportPolicy: 'relay' }), ...r); };
    W.prototype = O.prototype;
    Object.setPrototypeOf(W, O);
    window.RTCPeerConnection = W;
  };
  const { alice, bob } = await L.makePair(svc, { alice: { init, args: ['--no-proxy-server'] }, bob: { init, args: ['--no-proxy-server'] } });
  let exit = 0;
  try {
    const pa = await alice.openCallWindow(), pb = await bob.openCallWindow();
    await bob.available();
    await alice.dial('Bob');
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    await pb.click('#btnAnswer');
    const up = await until(async () => { const a = await alice.snap(), b = await bob.snap(); return a.call && b.call && a.call.audioOn && b.call.audioOn; }, 40000, 250);
    check('[simulated TURN] a relayed call starts with a ' + CRED_SECONDS + ' s credential and ' + ALLOC_SECONDS + ' s allocations', !!up);
    const t0 = Date.now();
    let last = await alice.stats(), lastIn = last.inBytes, stalledAt = null, firstFlowing = false;
    while (Date.now() - t0 < WATCH_MS) {
      await sleep(15000);
      const s = await alice.stats().catch(() => null);
      const t = Math.round((Date.now() - t0) / 1000);
      const flowing = s && s.inBytes > lastIn;
      console.log('  t=' + t + ' s audio ' + (flowing ? 'flowing' : 'NOT flowing') + ', refreshes accepted ' + fx.stats.refreshes + ', refused as expired ' + fx.stats.authFailed.expired + ', allocations ' + fx.allocationCount());
      if (flowing && stalledAt === null) firstFlowing = true;
      if (!flowing && stalledAt === null) stalledAt = t;
      if (s) lastIn = s.inBytes;
      if ((await alice.teardown())) break;
    }
    const td = await alice.teardown();
    console.log('  outcome: ' + (td ? 'the call ended (' + td.reason + ')' : 'the call was still up') + (stalledAt !== null ? '; audio stalled by t=' + stalledAt + ' s' : '; audio never stalled'));
    check('[simulated TURN] audio flowed while the credential was valid', firstFlowing);
    check('[simulated TURN] Chromium\'s Refresh with the expired credential was refused by a server that enforces expiry', fx.stats.authFailed.expired > 0 && fx.stats.refreshes === 0, fx.stats);
    check('[simulated TURN] a relayed call therefore ends at the first Refresh after its credential expires (the documented limit on call length)', !!td && stalledAt !== null, { td, stalledAt });
  } catch (e) {
    console.log('FAIL test aborted :: ' + (e && e.stack || e));
    exit = 1;
  } finally {
    await alice.close(); await bob.close(); await svc.close(); await fx.close();
  }
  process.exit(L.finish('manual-call-turn-longcall') || exit);
})().catch((e) => { console.error(e); process.exit(2); });
