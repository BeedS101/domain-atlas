// Microphone permission behaviour of the calling window, with the browser denying capture.
// A caller whose microphone is blocked places no call; a callee whose microphone is blocked
// cannot answer, the caller learns the call was not answered, and nothing stays open.
// Needs the local demo domain on 8002 (see manual-call-e2e.js).
// Run: xvfb-run -a node test/manual-call-mic.js
'use strict';
const L = require('./call-e2e-lib');
const { check, until } = L;

const LIMITS = { limits: { invitesPerCallerPerMin: 100, invitesPerCalleePerMin: 100, invitesPerSourcePerMin: 200 } };

async function callerBlocked() {
  const svc = await L.startCallService(null, LIMITS);
  const { alice, bob } = await L.makePair(svc, { alice: { denyMic: true } });
  try {
    await alice.openCallWindow(); await bob.openCallWindow();
    await bob.available();
    const perm = await alice.callPage.evaluate(async () => { try { return (await navigator.permissions.query({ name: 'microphone' })).state; } catch (e) { return 'unknown'; } });
    console.log('INFO microphone permission state in the blocked window: ' + perm);
    const invitesBefore = svc.svc.counters.invites;
    await alice.dial('Bob');
    const t = await until(async () => alice.teardown(), 10000, 150);
    check('with the microphone blocked the caller\'s attempt ends as mic-denied', t && t.reason === 'mic-denied', t);
    check('the caller sent no invitation to the service', svc.svc.counters.invites === invitesBefore);
    check('nothing rang at the callee', (await bob.callState()) === 'none');
    check('the caller is told why', /microphone/i.test(await alice.text()));
    check('no connection was created and no track is live', t && t.pcState === null && t.liveTracksAfter === 0, t);
  } finally { await alice.close(); await bob.close(); await svc.close(); }
}

async function calleeBlocked() {
  const svc = await L.startCallService(null, LIMITS);
  const { alice, bob } = await L.makePair(svc, { bob: { denyMic: true } });
  try {
    await alice.openCallWindow(); const pb = await bob.openCallWindow();
    await bob.available();
    await alice.dial('Bob');
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    check('the callee rings without any microphone request', (await bob.snap()).call.micRequests === 0);
    await pb.click('#btnAnswer');
    const tb = await until(async () => bob.teardown(), 10000, 150);
    check('answering with the microphone blocked ends the call on the callee as mic-denied', tb && tb.reason === 'mic-denied', tb);
    check('the callee never built a connection and holds no live track', tb && tb.pcState === null && tb.liveTracksAfter === 0);
    const ta = await until(async () => alice.teardown(), 15000, 150);
    check('the caller sees the call was not answered', ta && /declined|noanswer|unavailable/.test(ta.reason), ta);
    check('the caller released everything', ta && ta.liveTracksAfter === 0 && ta.pcState === 'closed' || ta && ta.pcState === null, ta);
    await until(() => svc.svc.stats().liveCalls === 0, 8000, 200);
    check('the service holds no live call', svc.svc.stats().liveCalls === 0);
    check('the callee is still Available', (await bob.snap()).listening);
  } finally { await alice.close(); await bob.close(); await svc.close(); }
}

(async () => {
  try { await callerBlocked(); await calleeBlocked(); } catch (e) { check('test run completed', false, String(e && e.stack || e)); }
  process.exit(L.finish('manual-call-mic'));
})();
