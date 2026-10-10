// Q5: microphone tracks and peer connections are stopped on hang-up, decline, cancel, lock, script error,
// window close; mute releases the capture track; teardown is idempotent.
// What this cannot show: OS-level release of the physical device (the fake device has none).
// Run: xvfb-run -a node test/q5-teardown.js
'use strict';
const H = require('./harness');
const { check, observe, sleep } = H;

const PORT = 9415, BASE = 'http://127.0.0.1:' + PORT;

(async () => {
  const srv = await H.startServer(PORT);
  const a = await H.launch('a'), b = await H.launch('b');
  let seq = 0;
  const open = (ctx, room, me, peer) => H.openCall(ctx, { room, me, peer, base: BASE });

  async function startCall(label) {
    const room = label + '-' + seq++;
    const A = await open(a, room, 'alice', 'bob'), B = await open(b, room, 'bob', 'alice');
    await H.pairKeys(A, B);
    await A.page.click('#call');
    await H.until(() => H.spikeState(B.page).then((s) => s === 'ringing'), 10000);
    return { A, B, room };
  }
  async function connect(label) {
    const c = await startCall(label);
    await c.B.page.click('#answer');
    const ok = await H.until(async () => (await H.spikeState(c.A.page)) === 'in-call' && (await H.spikeState(c.B.page)) === 'in-call', 25000);
    if (!ok) throw new Error('call did not connect for ' + label);
    return c;
  }
  // inbound-rtp can be missing from a stats report for a moment (observed once); wait for it instead of failing on a race.
  async function inboundOf(P) {
    const i = await H.until(async () => { const x = await P.page.evaluate(() => window.__spike.getInfo()); return x.inbound ? x : false; }, 5000, 200);
    if (!i) throw new Error('no inbound-rtp stats');
    return i.inbound;
  }
  const td = (P) => P.page.evaluate(() => window.__spike.teardown);
  const ended = (P, ms) => H.until(() => H.spikeState(P.page).then((s) => s === 'ended'), ms || 8000);
  async function assertReleased(name, P) {
    const t = await td(P);
    check(name + ': every microphone track is ended', !!t && t.micTrackStates.length >= 1 && t.micTrackStates.every((x) => x === 'ended') && t.liveTracksAfter === 0, t);
    check(name + ': the peer connection is closed', !!t && t.pcConnectionState === 'closed', t);
  }

  try {
    // ---- hang-up ----
    let c = await connect('hangup');
    await c.A.page.click('#hangup');
    check('hang-up: caller ends', !!(await ended(c.A)));
    await assertReleased('hang-up (caller)', c.A);
    check('hang-up: the other side ends after the signed end message', !!(await ended(c.B)));
    check('hang-up: the other side records the peer end as the reason', (await td(c.B)).reason === 'peer-end');
    await assertReleased('hang-up (callee, remote end)', c.B);
    await c.A.page.close(); await c.B.page.close();

    // ---- decline: callee never captured the microphone ----
    c = await startCall('decline');
    await c.B.page.click('#decline');
    check('decline: the caller learns the call was declined', !!(await ended(c.A)) && (await td(c.A)).reason === 'peer-decline');
    check('decline: the callee never requested the microphone', (await c.B.page.evaluate(() => window.__spike.gumCalls)) === 0);
    await assertReleased('decline (caller, mic was captured at Call)', c.A);
    await c.A.page.close(); await c.B.page.close();

    // ---- caller cancels while ringing ----
    c = await startCall('cancel');
    await c.A.page.click('#hangup');
    check('cancel while ringing: the callee stops ringing', !!(await ended(c.B)));
    await assertReleased('cancel (caller)', c.A);
    check('cancel while ringing: the callee never requested the microphone', (await c.B.page.evaluate(() => window.__spike.gumCalls)) === 0);
    await c.A.page.close(); await c.B.page.close();

    // ---- wallet lock ----
    c = await connect('lock');
    const t0 = Date.now();
    await a.sw.evaluate(() => globalThis.signalLock());
    check('lock: the call window ends on the lock signal', !!(await ended(c.A, 5000)));
    observe('lock.latencyMs', (await td(c.A)).at - t0);
    check('lock: the reason is recorded as lock', (await td(c.A)).reason === 'lock');
    await assertReleased('lock', c.A);
    check('lock: the peer is told (signed end)', !!(await ended(c.B)) && (await td(c.B)).reason === 'peer-end');
    await a.sw.evaluate(() => globalThis.clearLock());
    await c.A.page.close(); await c.B.page.close();

    // ---- lock while ringing (no connection exists yet) ----
    c = await startCall('lock-ring');
    await a.sw.evaluate(() => globalThis.signalLock());
    check('lock while the caller is still ringing: caller ends and releases the microphone', !!(await ended(c.A, 5000)));
    await assertReleased('lock while ringing', c.A).catch(() => {});
    await a.sw.evaluate(() => globalThis.clearLock());
    await c.A.page.close(); await c.B.page.close();

    // ---- uncaught error ----
    c = await connect('error');
    await c.A.page.evaluate(() => window.__spike.throwForTest());
    check('uncaught error: the call window tears the call down', !!(await ended(c.A, 5000)));
    check('uncaught error: reason recorded', (await td(c.A)).reason === 'error');
    await assertReleased('uncaught error', c.A);
    check('uncaught error: the peer is told', !!(await ended(c.B)));
    await c.A.page.close(); await c.B.page.close();

    // ---- verification failure releases the mic (covered in q3-q4; here the callee side of a bad offer) ----

    // ---- window closed by the user ----
    c = await connect('close');
    const winId = c.A.info.windowId;
    const tClose = Date.now();
    await a.sw.evaluate((id) => chrome.windows.remove(id), winId);
    const peerEnded = await ended(c.B, 12000);
    observe('windowClose.peerLearnedWithin12s', !!peerEnded);
    observe('windowClose.peerLearnedAfterMs', peerEnded ? Date.now() - tClose : null);
    if (peerEnded) observe('windowClose.peerReason', (await td(c.B)).reason);
    else {
      const slow = await H.until(() => c.B.page.evaluate(() => window.__spike.pc && ['disconnected', 'failed', 'closed'].includes(window.__spike.pc.connectionState)), 40000, 500);
      observe('windowClose.peerConnectionStateAfterWait', await c.B.page.evaluate(() => window.__spike.pc && window.__spike.pc.connectionState));
      observe('windowClose.peerNoticedViaIceWithin52s', !!slow);
    }
    const finalB = await c.B.page.evaluate(() => ({ state: window.__spike.state, pc: window.__spike.pc && window.__spike.pc.connectionState }));
    check('window close: the peer eventually sees the call end (end message or connection state)', finalB.state === 'ended' || ['disconnected', 'failed', 'closed'].includes(finalB.pc), finalB);
    await c.B.page.close().catch(() => {});

    // ---- mute releases the capture track; unmute re-acquires ----
    c = await connect('mute');
    const before = { inbound: await inboundOf(c.B) };
    await c.A.page.click('#mute');
    await sleep(600);
    const muteInfo = await c.A.page.evaluate(() => ({ ms: window.__spike.mutedTrackStates, attached: window.__spike.pc.getSenders().map((s) => !!s.track) }));
    check('mute: the capture track is stopped (device released), not just disabled', muteInfo.ms.every((x) => x === 'ended'), muteInfo);
    check('mute: nothing is attached to the sender', muteInfo.attached.every((x) => !x));
    const p1 = (await inboundOf(c.B)).packetsReceived;
    await sleep(1500);
    const p2 = (await inboundOf(c.B)).packetsReceived;
    observe('mute.peerPacketsDuringMute', { before: before.inbound.packetsReceived, p1, p2, grewDuring1500ms: p2 - p1 });
    check('mute: the stopped sender sends no audio frames to the peer (packet growth at most a few comfort packets)', p2 - p1 <= 5, { p1, p2 });
    await c.A.page.click('#mute');
    await sleep(800);
    check('unmute: the microphone is requested again by the click (second getUserMedia)', (await c.A.page.evaluate(() => window.__spike.gumCalls)) === 2);
    const e1 = (await inboundOf(c.B)).totalAudioEnergy;
    await sleep(4000);
    const e2 = (await inboundOf(c.B)).totalAudioEnergy;
    check('unmute: audio energy reaches the peer again', e2 > e1, { e1, e2 });
    // idempotent teardown
    await c.A.page.evaluate(() => { window.__spike.teardownNow('first'); window.__spike.teardownNow('second'); });
    const evs = await c.A.page.evaluate(() => ({ n: window.__spike.events.filter((e) => e.name === 'teardown').length, reason: window.__spike.teardownReason }));
    check('teardown is idempotent (second call is a no-op)', evs.n === 1 && evs.reason === 'first', evs);
    await assertReleased('teardown after unmute (re-acquired track included)', c.A);
    await c.A.page.close(); await c.B.page.close();
  } finally {
    await a.close(); await b.close(); srv.kill();
  }
  process.exit(H.finish('q5-teardown'));
})().catch((e) => { console.error(e); process.exit(2); });
