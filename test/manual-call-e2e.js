// Two real wallets in two Chromium profiles place a mutually authenticated call through a real
// Call Service on loopback. Covers the normal flow and the resource-cleanup paths.
//
// Needs the local demo domain on 8002 (it issues the Post Office membership the Call Service
// admits and carries the contact cards):
//   PORT=8002 ATLAS_DOMAIN=localhost:8002 ATLAS_DOCROOT=demo-domain-b \
//     ATLAS_STATE_DIR=issuer-server/domain-b-state node issuer-server/server.js
// Run: xvfb-run -a node test/manual-call-e2e.js
//
// Chromium's fake capture device stands in for a microphone; the real microphone prompt, a
// passkey identity and two separate computers are not exercised here.
'use strict';
const L = require('./call-e2e-lib');
const { check, sleep, until } = L;

const ended = async (w, reason) => until(async () => { const t = await w.teardown(); return t && (reason ? t.reason === reason : true) ? t : false; }, 15000, 200);
const callCount = (w) => w.callPage.evaluate(() => window.__atlasCall.history.length);

(async () => {
  const svc = await L.startCallService(null, { limits: { invitesPerCallerPerMin: 100, invitesPerCalleePerMin: 100, invitesPerSourcePerMin: 200 } });
  const { alice, bob } = await L.makePair(svc);
  let exit = 0;
  try {
    const pa = await alice.openCallWindow();
    const pb = await bob.openCallWindow();
    check('the calling window opens locked-in to the wallet with no call and no listener', (await alice.snap()).call === null && !(await alice.snap()).listening);

    // The callee's own limit on rings per caller is exercised separately below.
    await bob.setTimers({ ringRateWindowMs: 300 });

    // ---------- 1. normal call ----------
    await bob.available();
    check('Bob goes Available and starts listening', (await bob.snap()).listening);
    await alice.dial('Bob');
    check('Alice requested the microphone when she pressed Call, once', !!(await until(async () => (await alice.trace()).filter((t) => t.ev === 'getUserMedia').length === 1, 5000, 100)));
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    const ringing = await bob.snap();
    check('Bob is ringing with no microphone request and no connection yet', ringing.call.state === 'incoming' && ringing.call.micRequests === 0 && (await bob.trace()).length === 0);
    check('the incoming call names the saved contact and does not claim verification', /Alice/.test(await bob.text()) && /Not verified/.test(await bob.text()));
    await pb.click('#btnAnswer');
    const live = await until(async () => { const a = await alice.snap(), b = await bob.snap(); return a.call && b.call && a.call.audioOn && b.call.audioOn; }, 30000, 250);
    check('both sides reach an active call with audio enabled', !!live);
    const ta = await alice.trace(), tb = await bob.trace();
    const attachA = ta.find((t) => t.ev === 'replaceTrack' && t.track === 'audio'), attachB = tb.find((t) => t.ev === 'replaceTrack' && t.track === 'audio');
    check('the microphone is attached to the connection only after both confirmations and a verified remote certificate (caller)', !!attachA && attachA.ownConfirmed && attachA.peerConfirmed && attachA.certOk, attachA);
    check('the microphone is attached to the connection only after both confirmations and a verified remote certificate (callee)', !!attachB && attachB.ownConfirmed && attachB.peerConfirmed && attachB.certOk, attachB);
    check('no track was attached to the connection before that point', ta.filter((t) => t.ev === 'replaceTrack' && t.track === 'audio').length === 1 && tb.filter((t) => t.ev === 'replaceTrack' && t.track === 'audio').length === 1);
    const la = await alice.log(), lb = await bob.log();
    check('the remote certificate check ran before audio was enabled on both sides', la.findIndex((x) => x.startsWith('remote-certificate-check:{"ok":true')) > -1 && la.findIndex((x) => x.startsWith('remote-certificate-check')) < la.indexOf('audio-enabled') && lb.findIndex((x) => x.startsWith('remote-certificate-check:{"ok":true')) < lb.indexOf('audio-enabled'));
    await sleep(2500);
    const sa = await alice.stats(), sb = await bob.stats();
    check('audio actually flows in both directions', sa.inBytes > 0 && sa.outBytes > 0 && sb.inBytes > 0 && sb.outBytes > 0, { sa, sb });
    check('the service holds one live call', svc.svc.stats().liveCalls === 1);

    // ---------- 2. mute / unmute ----------
    await pa.click('#btnMute');
    await until(async () => (await alice.snap()).call.muted, 5000);
    let td = await pa.evaluate(() => { const c = window.__atlasCall.getCall(); return { sender: c.audioSender.track, micStates: c.mic.map((t) => t.readyState) }; });
    check('Mute detaches the track from the connection and stops the capture device', td.sender === null && td.micStates.every((s) => s === 'ended'), td);
    check('the other side is still connected after Mute', (await bob.snap()).call.state === 'active');
    await pa.click('#btnMute');
    await until(async () => !(await alice.snap()).call.muted, 8000);
    td = await pa.evaluate(() => { const c = window.__atlasCall.getCall(); return { sender: !!c.audioSender.track, micStates: c.mic.map((t) => t.readyState), requests: c.micRequests }; });
    check('Unmute re-acquires the microphone on the click and re-attaches it', td.sender && td.micStates.includes('live') && td.requests === 2, td);

    // ---------- 3. hang up ----------
    await pa.click('#btnHangup');
    const tA = await ended(alice, 'hangup'), tB = await ended(bob);
    check('Hang up releases the microphone, detaches senders and closes the connection (caller)', tA && tA.micTrackStates.every((s) => s === 'ended') && tA.liveTracksAfter === 0 && tA.pcState === 'closed' && (tA.senderTracks || []).every((x) => x === null || x === 'ended'), tA);
    check('the other side ends and releases everything too', tB && tB.liveTracksAfter === 0 && tB.pcState === 'closed' && tB.micTrackStates.every((s) => s === 'ended'), tB);
    check('the callee saw the end as a hang-up by the other person', tB && tB.reason === 'hangup');
    await until(() => svc.svc.stats().liveCalls === 0, 8000, 200);
    check('the service marks the call ended', svc.svc.stats().liveCalls === 0);

    // ---------- 4. decline ----------
    await pa.click('#btnDismiss').catch(() => {}); await pb.click('#btnDismiss').catch(() => {});
    await alice.dial('Bob');
    await pb.waitForSelector('#btnDecline:not([hidden])', { timeout: 15000 });
    await pb.click('#btnDecline');
    const dA = await until(async () => { const t = await alice.teardown(); return t && t.at > tA.at && t; }, 15000, 200);
    check('Decline ends the caller\'s attempt as not answered', dA && /declined|noanswer/.test(dA.reason), dA);
    const dB = await bob.teardown();
    check('declining never requested the microphone or built a connection', dB && dB.micRequests === 0 && dB.pcState === null, dB);
    check('Bob is still Available after declining', (await bob.snap()).listening);

    // ---------- 5. caller cancels while ringing ----------
    await pa.click('#btnDismiss').catch(() => {}); await pb.click('#btnDismiss').catch(() => {});
    await alice.dial('Bob');
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    await pa.click('#btnHangup');
    const cB = await until(async () => { const t = await bob.teardown(); return t && t.at > dB.at && t; }, 15000, 200);
    check('cancelling while it rings stops the ringing on the other side', cB && cB.reason === 'cancelled', cB);
    check('the cancelled call never touched Bob\'s microphone', cB && cB.micRequests === 0 && cB.pcState === null);

    // ---------- 6. nobody answers ----------
    await pa.click('#btnDismiss').catch(() => {}); await pb.click('#btnDismiss').catch(() => {});
    await alice.setTimers({ ringMs: 2500 });
    await alice.dial('Bob');
    const nA = await until(async () => { const t = await alice.teardown(); return t && t.reason === 'noanswer' && t; }, 15000, 200);
    check('an unanswered call ends on the caller\'s ring timer', !!nA, nA);
    check('the callee stops ringing after the caller gives up', !!(await until(async () => (await bob.teardown()).reason === 'cancelled' && (await bob.callState()) !== 'incoming', 15000, 200)));
    await alice.setTimers({ ringMs: 45000 });

    // ---------- 7. do not disturb ----------
    await pa.click('#btnDismiss').catch(() => {}); await pb.click('#btnDismiss').catch(() => {});
    await bob.dnd();
    await alice.dial('Bob');
    const uA = await until(async () => { const t = await alice.teardown(); return t && t.at > nA.at && t; }, 15000, 200);
    check('calling a contact in Do Not Disturb ends as not available and nothing rings', uA && uA.reason === 'unavailable' && (await bob.callState()) === 'none', uA);
    await pa.click('#btnDismiss').catch(() => {});

    // ---------- 8. permission revoked ----------
    await bob.available();
    const oldTag = (await alice.wallet((k) => AtlasWallet.getCallCardFor(k), bob.pub)).tag;
    await bob.wallet((k) => AtlasWallet.revokeCalling(k), alice.pub);
    await pa.evaluate(() => window.__atlasCall.refresh());
    await alice.dial('Bob').catch(() => {});
    const rA = await until(async () => { const t = await alice.teardown(); return t && t.at > uA.at && t; }, 15000, 200);
    check('after Bob revokes the permission Alice\'s call is refused as not available', rA && rA.reason === 'unavailable', rA);
    check('and nothing rings at Bob', (await bob.callState()) === 'none');
    await bob.wallet((k) => AtlasWallet.grantCalling(k), alice.pub);
    check('Bob\'s new permission arrives as a card with a new tag', !!(await until(async () => { await alice.wallet(() => AtlasWallet.checkAllMail()); const c = await alice.wallet((k) => AtlasWallet.getCallCardFor(k), bob.pub); return c && c.tag !== oldTag; }, 15000, 500)));
    await pa.evaluate(() => window.__atlasCall.refresh());

    // ---------- 9. wallet lock during a call ----------
    await pa.click('#btnDismiss').catch(() => {});
    await alice.dial('Bob');
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    await pb.click('#btnAnswer');
    check('a call is active again before the lock test', !!(await until(async () => (await alice.callState()) === 'active' && (await bob.callState()) === 'active', 30000, 250)));
    const before = await callCount(alice);
    await alice.wallet(() => AtlasWallet.lockIdentity());
    const lA = await until(async () => (await callCount(alice)) > before && (await alice.teardown()), 15000, 200);
    check('locking the wallet ends the call and releases the microphone at once', lA && lA.liveTracksAfter === 0 && lA.pcState === 'closed', lA);
    check('the calling window shows the locked screen', /locked/.test(await alice.screen()) || /Locked/.test(await alice.screen()));
    check('the other side ends the call', !!(await until(async () => (await bob.callState()) !== 'active', 15000, 250)));
    check('the locked window is no longer listening or calling', (await alice.snap()).call === null && !(await alice.snap()).listening);
    await alice.wallet((pw) => AtlasWallet.unlockIdentity(pw), 'alice-test-password');
    await pa.evaluate(() => window.__atlasCall.refresh());
    await pb.click('#btnDismiss').catch(() => {});

    // ---------- 10. window closed during a call ----------
    await sleep(500);
    await alice.dial('Bob').catch(async () => { await pa.click('#btnDismiss').catch(() => {}); await alice.dial('Bob'); });
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    await pb.click('#btnAnswer');
    check('a call is active again before the window-close test', !!(await until(async () => (await alice.callState()) === 'active' && (await bob.callState()) === 'active', 30000, 250)));
    const bBefore = await callCount(bob);
    await pa.close();
    const closedEnd = await until(async () => (await callCount(bob)) > bBefore && (await bob.teardown()), 15000, 200);
    check('closing the calling window ends the call for the other side', closedEnd && closedEnd.reason === 'hangup', closedEnd);
    check('Bob\'s microphone and connection are released', closedEnd && closedEnd.liveTracksAfter === 0 && closedEnd.pcState === 'closed');
    await until(() => svc.svc.stats().liveCalls === 0, 8000, 200);
    check('the service holds no live call afterwards', svc.svc.stats().liveCalls === 0);
    // ---------- 11. a contact cannot ring the callee without limit ----------
    const pa2 = await alice.openCallWindow();
    await bob.setTimers({ ringRateWindowMs: 60000 });
    let rang = 0;
    for (let i = 0; i < 5; i++) {
      await pa2.click('#btnDismiss').catch(() => {});
      await pb.click('#btnDismiss').catch(() => {});
      await alice.dial('Bob');
      const outcome = await until(async () => {
        if ((await bob.callState()) === 'incoming') return 'rang';
        if ((await bob.log()).filter((x) => x === 'invite-dropped:rate').length > i - rang) return 'dropped';
        return false;
      }, 6000, 150);
      if (outcome === 'rang') rang++;
      await pa2.click('#btnHangup').catch(() => {});
      await until(async () => (await bob.callState()) !== 'incoming', 8000, 150);
    }
    const drops = (await bob.log()).filter((x) => x === 'invite-dropped:rate').length;
    check('the callee\'s own limit stops repeated rings from one contact', rang <= 3 && drops >= 1, { rang, drops });

    check('no uncaught page errors on either side', alice.errors.length === 0 && bob.errors.length === 0, { a: alice.errors, b: bob.errors });
  } catch (e) {
    console.log('FAIL test aborted :: ' + (e && e.stack || e));
    check('test run completed', false, String(e && e.message));
    for (const w of [alice, bob]) { try { console.log('--- ' + w.label + ' log tail'); console.log((await w.log()).slice(-14).join('\n')); } catch (e2) { /* page gone */ } }
  } finally {
    await alice.close(); await bob.close(); await svc.close();
  }
  exit = L.finish('manual-call-e2e');
  process.exit(exit);
})();
