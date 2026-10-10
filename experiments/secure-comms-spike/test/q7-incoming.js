// Q7: can an inactive extension call window receive and display an incoming call, and what can the
// extension service worker do on its own?
// NOT exercised here: a real window manager (minimize / occlusion), OS notification centre, clicking a
// notification, laptop sleep. Xvfb has no window manager, so "inactive" below means a background tab,
// a CDP-frozen page, or no window at all.
// Run: xvfb-run -a node test/q7-incoming.js   (about 4 minutes: includes a 150 s service-worker observation)
'use strict';
const H = require('./harness');
const { check, observe, sleep } = H;

const PORT = 9417, BASE = 'http://127.0.0.1:' + PORT;

(async () => {
  const srv = await H.startServer(PORT);
  const a = await H.launch('caller'), b = await H.launch('listener');
  let seq = 0;
  const open = (ctx, room, me, peer) => H.openCall(ctx, { room, me, peer, base: BASE });

  async function ringFrom(A, B) {
    const sentAt = Date.now();
    await A.page.click('#call');
    return sentAt;
  }

  try {
    // ---------- L1: visible, focused popup window ----------
    let room = 'q7-visible-' + seq++;
    let A = await open(a, room, 'alice', 'bob'), B = await open(b, room, 'bob', 'alice');
    await H.pairKeys(A, B);
    let sentAt = await ringFrom(A, B);
    check('visible window: incoming call is shown (ringing)', !!(await H.until(() => H.spikeState(B.page).then((s) => s === 'ringing'), 10000)));
    let inc = await B.page.evaluate(() => window.__spike.incoming);
    observe('L1.visible.incoming', inc);
    observe('L1.visible.latencyMs', inc.at - sentAt);
    check('visible window: tab title changed to announce the call', /Incoming call/.test(inc.titleAfter));
    await sleep(1000);
    const att1 = await B.page.evaluate(() => window.__spike.attention);
    observe('L1.visible.attention', att1);
    check('visible window: chrome.windows.update(drawAttention) was accepted by the browser (no API error)', att1.drawAttention === 'called-ok', att1);
    check('visible window: chrome.notifications.create succeeded', /^created:/.test(att1.notification || ''), att1);
    check('no microphone was requested by the listener while ringing', (await B.page.evaluate(() => window.__spike.gumCalls)) === 0);
    await A.page.click('#hangup'); await sleep(500);
    await A.page.close(); await B.page.close();

    check('extension id derived from the unpacked path matches the id Chromium assigned', H.extensionIdForPath(H.EXT_PATH) === b.extId, { computed: H.extensionIdForPath(H.EXT_PATH), actual: b.extId });
  } finally {
    await a.close(); await b.close();
  }

  // ---------- Part B: Chromium started directly, no debugger attached ----------
  // L2 hidden background tab, L3 long hidden period, L4 service-worker poll lifetime (with and without a
  // chrome.* API call per cycle). Observations come back through the relay.
    const a2 = await H.launch('caller2');
  let raw = null;
  try {
    const roomL = 'q7raw-L';
    const A = await H.openCall(a2, { room: roomL, me: 'alice', peer: 'bob', base: BASE, reusable: '1' });
    const alicePub = await A.page.evaluate(() => window.__spike.idPub);
    const q = (o) => new URLSearchParams(Object.assign({ base: BASE, report: '1' }, o)).toString();
    const startup = {
      tabs: [{ path: 'call.html?' + q({ room: roomL, me: 'bob', peer: 'alice', peerKey: alicePub, reusable: '1' }), active: false }],
      swpolls: [
        { base: BASE, room: 'q7raw-swTouch', me: 'bob', label: 'touch', touch: true },
        { base: BASE, room: 'q7raw-swPlain', me: 'bob', label: 'plain', touch: false }
      ]
    };
    const extCopy = H.prepareExtensionCopy(startup);
    const id2 = H.extensionIdForPath(extCopy);
    raw = H.launchRaw(['about:blank'], [], extCopy);
    const tStart = Date.now();
    const ready = await H.until(async () => { const l = await H.readObs(BASE, roomL, 'bob'); return l.find((e) => e.kind === 'ready') || false; }, 30000, 500);
    check('directly launched Chromium loads the listener window', !!ready);
    observe('L2.listener.readyVisibility', ready && ready.data.visibilityState);
    await A.page.evaluate((k) => window.__spike.setPeerKey(k), ready.data.idPub);

    async function ring(label) {
      const AA = A; // one reusable caller window (its key is the one the listener pinned)
      const before = (await H.readObs(BASE, roomL, 'bob')).filter((e) => e.kind === 'incoming').length;
      const sentAt = Date.now();
      await AA.page.click('#call');
      const got = await H.until(async () => { const l = (await H.readObs(BASE, roomL, 'bob')).filter((e) => e.kind === 'incoming'); return l.length > before ? l[l.length - 1] : false; }, 20000, 200);
      await sleep(1500);
      const obs = await H.readObs(BASE, roomL, 'bob');
      const att = obs.filter((e) => e.kind === 'attention').pop();
      const rec = { label, atSecondsSinceLaunch: Math.round((Date.now() - tStart) / 1000), received: !!got, latencyMs: got ? got.data.at - sentAt : null, visibilityState: got ? got.data.visibilityState : null, hasFocus: got ? got.data.hasFocus : null, attention: att ? att.data : null };
      observe('ring.' + label, rec);
      await AA.page.click('#hangup'); await sleep(1200);
      return rec;
    }
    async function swInvite(room, mailbox, n) {
      const sentAt = Date.now();
      await H.relay(BASE, '/send', { room, to: 'bob', msg: { type: 'invite', n, sentAt } });
      const ack = await H.until(async () => { const ev2 = await H.pollMailbox(BASE, room, mailbox, 0); const m = ev2.map((e) => e.msg).find((x) => x.n === n); return m || false; }, 15000, 500);
      return ack ? { received: true, latencyMs: ack.receivedAt - sentAt, beats: ack.beats, instance: ack.instance } : { received: false };
    }
    const polls = async () => { const h = await (await fetch(BASE + '/health')).json(); return h.polls; };

    await sleep(Math.max(0, 25000 - (Date.now() - tStart)));
    const r1 = await ring('t+25s');
    check('hidden background tab: the incoming call is received and the page is in a hidden state when it arrives', r1.received && r1.visibilityState === 'hidden', r1);
    check('hidden background tab: drawAttention and notification calls do not error', r1.attention && r1.attention.drawAttention && r1.attention.drawAttention.startsWith('called-ok') && /^created:/.test(r1.attention.notification || ''), r1.attention);
    const sw1 = { touch: await swInvite('q7raw-swTouch', 'ack-touch', 1), plain: await swInvite('q7raw-swPlain', 'ack-plain', 1) };
    observe('sw.invite.t+30s', sw1);
    check('service worker (API call per cycle): receives an invite with no call window open', sw1.touch.received, sw1);
    check('service worker (pure fetch loop): receives an invite with no call window open', sw1.plain.received, sw1);

    const checkpoints = [{ at: 120, n: 2 }, { at: 400, n: 3 }];
    for (const cp of checkpoints) {
      await sleep(Math.max(0, cp.at * 1000 - (Date.now() - tStart)));
      const pl = await polls();
      const now = Date.now();
      observe('sw.pollActivity.t+' + cp.at + 's', { touch: pl['q7raw-swTouch|bob'] && { count: pl['q7raw-swTouch|bob'].count, secondsSinceLastPollStart: Math.round((now - pl['q7raw-swTouch|bob'].last) / 1000) }, plain: pl['q7raw-swPlain|bob'] && { count: pl['q7raw-swPlain|bob'].count, secondsSinceLastPollStart: Math.round((now - pl['q7raw-swPlain|bob'].last) / 1000) } });
      const rr = await ring('t+' + cp.at + 's');
      check('hidden listener tab at t+' + cp.at + ' s still receives and presents the call', rr.received && rr.visibilityState === 'hidden', rr);
      const sw = { touch: await swInvite('q7raw-swTouch', 'ack-touch', cp.n), plain: await swInvite('q7raw-swPlain', 'ack-plain', cp.n) };
      observe('sw.invite.t+' + cp.at + 's', sw);
      check('service worker (API call per cycle) still receives an invite at t+' + cp.at + ' s', sw.touch.received, sw);
      observe('sw.pureFetchLoopReceivedAt.t+' + cp.at + 's', sw.plain.received);
    }
    const events = (await H.readObs(BASE, roomL, 'bob')).filter((e) => /freeze|resume|visibility/.test(e.kind)).map((e) => e.kind + (typeof e.data === 'string' ? ':' + e.data : ''));
    observe('L3.listenerPageLifecycleEvents', events);
  } finally {
    await a2.close(); if (raw) await raw.close();
    srv.kill();
  }
  process.exit(H.finish('q7-incoming'));
})().catch((e) => { console.error(e); process.exit(2); });
