// Q1: microphone only after an explicit trusted click, from the dedicated call window.
// Q2: two independent browser contexts establish WebRTC audio; transport facts; audio gated by confirm.
// Run: xvfb-run -a node test/q1-q2-mic-and-call.js
'use strict';
const H = require('./harness');
const { check, observe } = H;

(async () => {
  const PORT2 = 9419, PORT = 9412, BASE = 'http://127.0.0.1:' + PORT;
  const srv = await H.startServer(PORT);
  const a = await H.launch('a'), b = await H.launch('b');
  try {
    const room = 'q12';
    const A = await H.openCall(a, { room, me: 'alice', peer: 'bob', base: BASE });
    const B = await H.openCall(b, { room, me: 'bob', peer: 'alice', base: BASE });
    await H.pairKeys(A, B);

    // ---- Q1 ----
    check('call window is an extension page opened as a popup window', A.page.url().startsWith('chrome-extension://' + a.extId + '/call.html'));
    check('no getUserMedia request when the window opens (caller)', (await A.page.evaluate(() => window.__spike.gumCalls)) === 0);
    check('no getUserMedia request when the window opens (callee)', (await B.page.evaluate(() => window.__spike.gumCalls)) === 0);
    check('no microphone track exists before the click', (await A.page.evaluate(() => window.__spike.getInfo().then((i) => i.tracks.length))) === 0);

    // a script-generated click is not a user gesture
    await A.page.evaluate(() => document.getElementById('call').click());
    await H.sleep(300);
    check('untrusted (script-generated) click does not start a call or capture', (await A.page.evaluate(() => window.__spike.gumCalls)) === 0 && (await H.spikeState(A.page)) === 'idle');
    check('untrusted click is counted as ignored', (await A.page.evaluate(() => window.__spike.untrustedClicksIgnored)) === 1);

    // Hold alice's confirm so we can look at what flows before both sides have confirmed.
    await A.page.evaluate(() => { window.__spike.options.holdConfirm = true; });

    await A.page.click('#call'); // trusted: Playwright dispatches real input events
    check('trusted click on Call requests the microphone exactly once', (await A.page.evaluate(() => window.__spike.gumCalls)) === 1);
    check('callee still has no capture while the phone is ringing', await H.until(() => H.spikeState(B.page).then((s) => s === 'ringing'), 10000) && (await B.page.evaluate(() => window.__spike.gumCalls)) === 0);
    check('incoming invite is shown but the callee did not auto-accept', (await H.spikeState(B.page)) === 'ringing');
    await B.page.evaluate(() => document.getElementById('answer').click());
    await H.sleep(300);
    check('untrusted click on Answer is ignored', (await H.spikeState(B.page)) === 'ringing' && (await B.page.evaluate(() => window.__spike.gumCalls)) === 0);
    await B.page.click('#answer');
    check('trusted click on Answer requests the microphone exactly once', (await B.page.evaluate(() => window.__spike.gumCalls)) === 1);

    // ---- Q2 ----
    const connected = await H.until(async () => (await A.page.evaluate(() => window.__spike.pc && window.__spike.pc.connectionState)) === 'connected' && (await B.page.evaluate(() => window.__spike.pc && window.__spike.pc.connectionState)) === 'connected', 25000);
    check('two independent browser contexts establish a WebRTC connection', !!connected);

    // alice is holding her confirm: bob must not have enabled his audio yet, and alice's mic is muted at the source
    await H.sleep(2500);
    const aInfoHeld = await A.page.evaluate(() => window.__spike.getInfo());
    const bInfoHeld = await B.page.evaluate(() => window.__spike.getInfo());
    observe('held.alice.track', aInfoHeld.tracks);
    observe('held.bob.track', bInfoHeld.tracks);
    const attachedA = await A.page.evaluate(() => window.__spike.pc.getSenders().map((s) => !!s.track));
    const attachedB = await B.page.evaluate(() => window.__spike.pc.getSenders().map((s) => !!s.track));
    check('before the confirm exchange completes, the microphone is captured but not attached to the connection (alice)', aInfoHeld.tracks.length === 1 && aInfoHeld.tracks[0].readyState === 'live' && attachedA.every((x) => !x), attachedA);
    check('before the confirm exchange completes, the microphone is captured but not attached to the connection (bob)', bInfoHeld.tracks.length === 1 && bInfoHeld.tracks[0].readyState === 'live' && attachedB.every((x) => !x), attachedB);
    observe('held.outbound', { alice: aInfoHeld.outbound || null, bob: bInfoHeld.outbound || null });
    check('no RTP audio packets are sent before both confirms (alice)', !aInfoHeld.outbound || aInfoHeld.outbound.packetsSent === 0, aInfoHeld.outbound);
    check('no RTP audio packets are sent before both confirms (bob)', !bInfoHeld.outbound || bInfoHeld.outbound.packetsSent === 0, bInfoHeld.outbound);
    check('no audio energy reaches either side before both confirms', (aInfoHeld.inbound ? aInfoHeld.inbound.totalAudioEnergy || 0 : 0) < 1e-6 && (bInfoHeld.inbound ? bInfoHeld.inbound.totalAudioEnergy || 0 : 0) < 1e-6, { a: aInfoHeld.inbound, b: bInfoHeld.inbound });
    check('neither side is in-call while a confirm is outstanding', (await H.spikeState(A.page)) !== 'in-call' && (await H.spikeState(B.page)) !== 'in-call');

    await A.page.evaluate(() => window.__spike.releaseConfirm());
    check('after both confirms alice enters in-call', !!(await H.until(() => H.spikeState(A.page).then((s) => s === 'in-call'), 10000)));
    check('after both confirms bob enters in-call', !!(await H.until(() => H.spikeState(B.page).then((s) => s === 'in-call'), 10000)));

    // The Chromium fake microphone beeps periodically; allow it time.
    const heard = await H.until(async () => {
      const ia = await A.page.evaluate(() => window.__spike.getInfo());
      const ib = await B.page.evaluate(() => window.__spike.getInfo());
      return (ia.inbound.totalAudioEnergy > 0.001 && ib.inbound.totalAudioEnergy > 0.001) ? { ia, ib } : false;
    }, 20000, 500);
    check('audio energy flows in both directions after confirm', !!heard);
    const ia = await A.page.evaluate(() => window.__spike.getInfo());
    const ib = await B.page.evaluate(() => window.__spike.getInfo());
    observe('inbound.alice', ia.inbound); observe('inbound.bob', ib.inbound);
    check('alice received RTP packets', ia.inbound.packetsReceived > 20);
    check('bob received RTP packets', ib.inbound.packetsReceived > 20);
    check('DTLS transport state is connected on both sides', ia.transport.dtlsState === 'connected' && ib.transport.dtlsState === 'connected');
    observe('transport', ia.transport);
    observe('selectedPair', { alice: ia.pair, bob: ib.pair });
    check('media is protected with SRTP (srtpCipher reported)', /AES/.test(ia.transport.srtpCipher || ''), ia.transport);
    const sdpA = await A.page.evaluate(() => window.__spike.sdp()), sdpB = await B.page.evaluate(() => window.__spike.sdp());
    check('no SDES a=crypto line in any SDP', ![sdpA.local, sdpA.remote, sdpB.local, sdpB.remote].some((s) => /a=crypto:/.test(s)));
    check('SDP carries exactly one audio m-section and no video', [sdpA.local, sdpB.local].every((s) => (s.match(/^m=/gm) || []).length === 1 && /^m=audio /m.test(s)));
    observe('localSdpContainsCandidatesAfterGathering', /a=candidate:/.test(sdpA.local)); // the strict checker refuses SDP with candidates, so only the initial description is sent
    observe('candidateTypes', { alice: await A.page.evaluate(() => window.__spike.candidateTypes), bob: await B.page.evaluate(() => window.__spike.candidateTypes) });
    check('post-connect certificate check passed on both sides', (await A.page.evaluate(() => window.__spike.remoteCert.match)) && (await B.page.evaluate(() => window.__spike.remoteCert.match)));
    const exp = await A.page.evaluate(() => window.__spike.exportCheck());
    check('identity and per-call test keys refuse export', exp.identity === 'refused' && exp.call === 'refused', exp);
    check('exactly one getUserMedia per side for the whole call', (await A.page.evaluate(() => window.__spike.gumCalls)) === 1 && (await B.page.evaluate(() => window.__spike.gumCalls)) === 1);
  } finally {
    await a.close(); await b.close(); srv.kill();
  }

  // ---- Q1 continued: without the fake-UI flag, what does the browser really do? ----
  const srv2 = await H.startServer(PORT2);
  const c = await H.launch('c', [], { noFakeUi: true });
  try {
    const C = await H.openCall(c, { room: 'q1real', me: 'alice', peer: 'bob', base: 'http://127.0.0.1:' + (PORT2) });
    const permBefore = await C.page.evaluate(() => navigator.permissions.query({ name: 'microphone' }).then((p) => p.state, (e) => 'query-failed:' + e.message));
    observe('realPrompt.permissionStateBeforeClick', permBefore);
    check('no capture before the click even without auto-grant', (await C.page.evaluate(() => window.__spike.gumCalls)) === 0);
    const k = await C.page.evaluate(() => window.__spike.idPub);
    await C.page.evaluate((x) => window.__spike.setPeerKey(x), k);
    await C.page.click('#call');
    await H.sleep(6000);
    const outcome = await C.page.evaluate(() => ({ state: window.__spike.state, failure: window.__spike.failure, events: window.__spike.events.map((e) => e.name + (typeof e.data === 'string' ? ':' + e.data : '')) }));
    observe('realPrompt.outcomeAfter6s', outcome);
    check('without auto-grant the call does not proceed to media on its own', outcome.state !== 'in-call');
    const permAfter = await C.page.evaluate(() => navigator.permissions.query({ name: 'microphone' }).then((p) => p.state, (e) => 'query-failed:' + e.message));
    observe('realPrompt.permissionStateAfterClick', permAfter);
    // Can automation pre-grant the permission for the extension origin? Recorded as an observation only.
    try {
      await c.context.grantPermissions(['microphone'], { origin: 'chrome-extension://' + c.extId });
      observe('realPrompt.grantPermissionsForExtensionOrigin', 'accepted');
    } catch (err) {
      observe('realPrompt.grantPermissionsForExtensionOrigin', String(err.message).split('\n')[0]);
    }
  } finally {
    await c.close(); srv2.kill();
  }
  process.exit(H.finish('q1-q2-mic-and-call'));
})().catch((e) => { console.error(e); process.exit(2); });
