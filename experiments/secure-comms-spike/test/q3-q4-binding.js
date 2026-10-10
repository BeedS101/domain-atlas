// Q3: what the browser exposes about DTLS certificates / fingerprints.
// Q4: is the planned binding (identity key signs the DTLS fingerprints before any SDP exists;
//     the SDP and the live DTLS certificate are then checked against the signed set) implementable
//     with supported APIs, and does each layer stop the attack it is meant to stop?
// Run: xvfb-run -a node test/q3-q4-binding.js
'use strict';
const H = require('./harness');
const { check, observe, sleep } = H;

const PORT = 9413, BASE = 'http://127.0.0.1:' + PORT;
const NAMES = (events) => events.map((e) => e.name + (typeof e.data === 'string' ? ':' + e.data : ''));

async function snapshot(P) {
  return P.page.evaluate(() => ({
    state: window.__spike.state, failure: window.__spike.failure, teardown: window.__spike.teardown,
    audioEnabledAt: window.__spike.audioEnabledAt, remoteCert: window.__spike.remoteCert,
    events: window.__spike.events.map((e) => e.name + (typeof e.data === 'string' ? ':' + e.data : ''))
  }));
}
async function waitEnded(P, ms) { return H.until(() => H.spikeState(P.page).then((s) => s === 'ended'), ms || 15000); }

(async () => {
  const srv = await H.startServer(PORT);
  const a = await H.launch('a'), b = await H.launch('b'), m = await H.launch('m');
  let seq = 0;
  const open = async (ctx, room, me, peer, extra) => H.openCall(ctx, Object.assign({ room, me, peer, base: BASE }, extra || {}));
  try {
    // ---------------- Q3: what the browser exposes (plain web page, no extension APIs) ----------------
    const probe = await a.context.newPage();
    await probe.goto(BASE + '/probe');
    await probe.click('#run');
    await H.until(() => probe.evaluate(() => !!window.__probeResult), 30000);
    const pr = await probe.evaluate(() => window.__probeResult);
    observe('probe', pr);
    await probe.close();
    check('probe ran without an internal error', !pr.error, pr.error);

    // ---------------- honest call: the fingerprint bound by the signature is the one in use ----------------
    let room = 'bind-honest-' + seq++;
    let A = await open(a, room, 'alice', 'bob'), B = await open(b, room, 'bob', 'alice');
    await H.pairKeys(A, B);
    const aliceKey = await A.page.evaluate(() => window.__spike.idPub);
    const bobKey = await B.page.evaluate(() => window.__spike.idPub);
    await A.page.click('#call');
    await H.until(() => H.spikeState(B.page).then((s) => s === 'ringing'), 10000);
    await B.page.click('#answer');
    check('honest call reaches in-call with all checks on', !!(await H.until(() => H.spikeState(A.page).then((s) => s === 'in-call'), 25000)));
    const hs = await Promise.all([snapshot(A), snapshot(B)]);
    const sdpA = await A.page.evaluate(() => window.__spike.sdp()), sdpB = await B.page.evaluate(() => window.__spike.sdp());
    const fpA = await A.page.evaluate(() => window.__spike.localFingerprints), fpB = await B.page.evaluate(() => window.__spike.localFingerprints);
    const sdpFps = (sdp) => (sdp.match(/^a=fingerprint:sha-256 (\S+)/gm) || []).map((l) => l.split(' ')[1]);
    check('certificate fingerprint (getFingerprints, upper-cased) equals the offer SDP fingerprint', JSON.stringify(sdpFps(sdpA.local)) === JSON.stringify(fpA), { sdp: sdpFps(sdpA.local), cert: fpA });
    check('certificate fingerprint equals the answer SDP fingerprint', JSON.stringify(sdpFps(sdpB.local)) === JSON.stringify(fpB));
    check('the live remote DTLS certificate seen via getRemoteCertificates() is the peer\'s signed one (alice)', hs[0].remoteCert.viaApi && hs[0].remoteCert.viaApi[0] === fpB[0], hs[0].remoteCert);
    check('the live remote DTLS certificate seen via getStats() agrees with getRemoteCertificates() (alice)', hs[0].remoteCert.viaStats && hs[0].remoteCert.viaStats[0] === hs[0].remoteCert.viaApi[0]);
    check('both certificate views agree on bob\'s side too', hs[1].remoteCert.viaApi[0] === fpA[0] && hs[1].remoteCert.viaStats[0] === fpA[0]);
    observe('remoteCertificateRetrieval', { alice: { attempts: hs[0].remoteCert.apiAttempts, emptyAttempts: hs[0].remoteCert.apiEmptyAttempts, dtlsStates: hs[0].remoteCert.dtlsStates }, bob: { attempts: hs[1].remoteCert.apiAttempts, emptyAttempts: hs[1].remoteCert.apiEmptyAttempts, dtlsStates: hs[1].remoteCert.dtlsStates } });
    observe('fingerprintLinesInOffer', sdpA.local.split(/\r?\n/).filter((l) => /^a=(fingerprint|setup|identity)/.test(l)));
    observe('fingerprintLevel', { session: /^a=fingerprint/m.test(sdpA.local.split(/^m=/m)[0]), media: /^a=fingerprint/m.test('m=' + sdpA.local.split(/^m=/m)[1]) });
    const bobAccept = await B.page.evaluate(() => window.__spike.lastOwnBinding);
    await A.page.evaluate(() => window.__spike.hangupFromTest());
    await H.until(() => H.spikeState(B.page).then((s) => s === 'ended'), 8000);
    await A.page.close(); await B.page.close();

    // ---------------- replay of a genuine accept into a different call ----------------
    room = 'bind-replay-' + seq++;
    A = await open(a, room, 'alice', 'bob');
    await A.page.evaluate((k) => window.__spike.setPeerKey(k), bobKey);
    await A.page.click('#call');
    const cid = await A.page.evaluate(() => window.__spike.callId);
    await H.relay(BASE, '/send', { room, to: 'alice', msg: { type: 'accept', callId: cid, binding: bobAccept } });
    await waitEnded(A, 8000);
    let s = await snapshot(A);
    check('a genuine accept from another call is rejected (field-mismatch:callId)', s.failure === 'accept:field-mismatch:callId', s.failure);
    check('after a rejected binding the call is torn down and the microphone released', s.teardown && s.teardown.liveTracksAfter === 0 && s.teardown.micTrackStates.every((x) => x === 'ended'), s.teardown);
    await A.page.close();

    // ---------------- impostor: someone else's key answers ----------------
    room = 'bind-impostor-' + seq++;
    A = await open(a, room, 'alice', 'bob'); B = await open(b, room, 'bob', 'alice');
    await H.pairKeys(A, B);
    await A.page.evaluate((k) => window.__spike.setPeerKey(k), aliceKey); // alice pins a key that is not bob's
    await A.page.click('#call');
    await H.until(() => H.spikeState(B.page).then((x) => x === 'ringing'), 10000);
    await B.page.click('#answer');
    await waitEnded(A, 10000);
    s = await snapshot(A);
    check('an accept signed by a key other than the pinned one is rejected (unexpected-signer)', s.failure === 'accept:unexpected-signer', s.failure);
    await A.page.close(); await B.page.close();

    // ---------------- relay rewrites the SDP fingerprint: which layer stops it? ----------------
    const BAD_FP = '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';
    const tamperCases = [
      { name: 'all checks on', opts: {}, expectOn: 'B', expectFailure: 'offer:bad-message-signature' },
      { name: 'message signatures off, SDP-fingerprint check on', opts: { checkMessageSignature: false }, expectOn: 'B', expectFailure: 'offer:fingerprint-not-signed' },
      { name: 'message signatures and SDP-fingerprint check both off (browser DTLS only)', opts: { checkMessageSignature: false, checkSdpFingerprints: false }, expectOn: 'any', expectTeardown: 'connection-failed' }
    ];
    for (const tc of tamperCases) {
      room = 'bind-tamper-' + seq++;
      await H.relay(BASE, '/__test/reset');
      await H.relay(BASE, '/__test/tamper', { mode: 'swap-fingerprint', value: BAD_FP });
      A = await open(a, room, 'alice', 'bob'); B = await open(b, room, 'bob', 'alice');
      await H.pairKeys(A, B);
      for (const P of [A, B]) await P.page.evaluate((o) => Object.assign(window.__spike.options, o), tc.opts);
      await A.page.click('#call');
      await H.until(() => H.spikeState(B.page).then((x) => x === 'ringing'), 10000);
      await B.page.click('#answer');
      const ended = await H.until(async () => (await H.spikeState(A.page)) === 'ended' || (await H.spikeState(B.page)) === 'ended', 20000);
      await sleep(500);
      const sa = await snapshot(A), sb = await snapshot(B);
      check('[fingerprint rewrite / ' + tc.name + '] the call does not reach in-call', ended && sa.state !== 'in-call' && sb.state !== 'in-call', { a: sa.state, b: sb.state });
      if (tc.expectFailure) check('[fingerprint rewrite / ' + tc.name + '] refused with ' + tc.expectFailure, sb.failure === tc.expectFailure, sb.failure);
      if (tc.expectTeardown) check('[fingerprint rewrite / ' + tc.name + '] browser DTLS fails the connection on its own (' + tc.expectTeardown + ')', [sa.teardown, sb.teardown].some((t) => t && t.reason === tc.expectTeardown), { a: sa.teardown && sa.teardown.reason, b: sb.teardown && sb.teardown.reason });
      observe('tamper.' + tc.name, { alice: sa.teardown && sa.teardown.reason, aliceFailure: sa.failure, bob: sb.teardown && sb.teardown.reason, bobFailure: sb.failure });
      check('[fingerprint rewrite / ' + tc.name + '] audio was never attached on either side', [sa, sb].every((x) => x.audioEnabledAt === null));
      await A.page.close().catch(() => {}); await B.page.close().catch(() => {});
    }
    await H.relay(BASE, '/__test/reset');

    // ---------------- man in the middle with bob's genuine, stolen accept ----------------
    // The relay copies bob's accept to mallory and diverts alice's offer / ICE to her. Mallory answers
    // alice's offer with her own certificate while presenting bob's genuine accept to alice.
    const mitmCases = [
      { name: 'all checks on', opts: {}, expectFailure: 'answer:bad-message-signature', expectNoConnect: true },
      { name: 'message signatures off (SDP-fingerprint check on)', opts: { checkMessageSignature: false }, expectFailure: 'answer:fingerprint-not-signed', expectNoConnect: true },
      { name: 'message signatures and SDP check off (post-connect certificate check only)', opts: { checkMessageSignature: false, checkSdpFingerprints: false }, expectFailure: 'remote-cert-mismatch', expectConnectedAtDtls: true },
      { name: 'CONTROL: every check off', opts: { checkMessageSignature: false, checkSdpFingerprints: false, checkRemoteCert: false }, expectControl: true }
    ];
    for (const tc of mitmCases) {
      room = 'bind-mitm-' + seq++;
      await H.relay(BASE, '/__test/reset');
      await H.relay(BASE, '/__test/mirror', { room, to: 'alice', copyTo: 'mallory', types: ['accept'] });
      await H.relay(BASE, '/__test/redirect', { room, from: 'bob', to: 'mallory', types: ['offer', 'ice'] });
      A = await open(a, room, 'alice', 'bob'); B = await open(b, room, 'bob', 'alice');
      const M = await open(m, room, 'mallory', 'alice', { attacker: '1' });
      await H.pairKeys(A, B);
      await A.page.evaluate((o) => Object.assign(window.__spike.options, o), tc.opts);
      await A.page.click('#call');
      await H.until(() => H.spikeState(B.page).then((x) => x === 'ringing'), 10000);
      await B.page.click('#answer');
      if (tc.expectControl) {
        const got = await H.until(async () => {
          const i = await M.page.evaluate(() => window.__spike.getInfo());
          return i.inbound && i.inbound.totalAudioEnergy > 0.001 ? i : false;
        }, 25000, 500);
        const sa = await snapshot(A);
        check('[MITM / ' + tc.name + '] with every check off the attack works: alice is in-call with the attacker and the attacker hears audio', sa.state === 'in-call' && !!got, { alice: sa.state, mallory: got && got.inbound });
        observe('mitm.control', { aliceState: sa.state, malloryInbound: got && got.inbound });
      } else {
        await waitEnded(A, 25000);
        await sleep(500);
        const sa = await snapshot(A);
        const mi = await M.page.evaluate(() => window.__spike.getInfo());
        check('[MITM / ' + tc.name + '] alice refuses with ' + tc.expectFailure, sa.failure === tc.expectFailure, { failure: sa.failure, events: sa.events });
        check('[MITM / ' + tc.name + '] alice never attached her microphone to the connection', sa.audioEnabledAt === null && sa.teardown && sa.teardown.senderTracks.every((x) => x === null), sa.teardown);
        check('[MITM / ' + tc.name + '] the attacker received no audio energy from alice', !mi.inbound || (mi.inbound.totalAudioEnergy || 0) < 1e-6, mi.inbound);
        check('[MITM / ' + tc.name + '] alice released her microphone', sa.teardown && sa.teardown.liveTracksAfter === 0);
        if (tc.expectConnectedAtDtls) {
          check('[MITM / ' + tc.name + '] the browser itself did complete DTLS with the attacker (only our check stopped it)', sa.events.includes('pc-connection:connected'), sa.events);
          check('[MITM / ' + tc.name + '] the live certificate hash differs from the signed one', sa.remoteCert && sa.remoteCert.match === false, sa.remoteCert);
        }
        if (tc.expectNoConnect) check('[MITM / ' + tc.name + '] no peer connection was established with the attacker', !sa.events.includes('pc-connection:connected'), sa.events);
        observe('mitm.' + tc.name, { failure: sa.failure, attackerInbound: mi.inbound || null });
      }
      await A.page.close().catch(() => {}); await B.page.close().catch(() => {}); await M.page.close().catch(() => {});
    }
  } finally {
    await a.close(); await b.close(); await m.close(); srv.kill();
  }
  process.exit(H.finish('q3-q4-binding'));
})().catch((e) => { console.error(e); process.exit(2); });
