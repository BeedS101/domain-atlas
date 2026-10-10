// Hostile-service and hostile-peer tests against the real calling windows.
//
// A relay between the windows and a real Call Service rewrites, duplicates and fabricates what the
// service says (a service that has been taken over), and two page-level patches stand in for a
// peer that signs one thing and does another, and for a man in the middle on the media path. The
// requirement under test: the windows never ring, accept or attach the microphone to a connection
// on the strength of anything the service or the network says that the other wallet did not sign.
//
// Needs the local demo domain on 8002 (see manual-call-e2e.js).
// Run: xvfb-run -a node test/manual-call-adversary.js
'use strict';
const L = require('./call-e2e-lib');
const T = require('./call-test-lib');
const { startRelay } = require('./call-relay-lib');
const { check, sleep, until } = L;
const P = T.P;

// Test-only switches in the calling window, installed before its scripts run. They are never
// part of the extension: they stand for a modified peer or a network attacker.
function hostileInit() {
  if (!/\/call\.html/.test(location.pathname)) return;
  window.__hostile = {};
  let proto;
  Object.defineProperty(window, 'AtlasCallProtocol', {
    configurable: true,
    get() { return proto; },
    set(v) {
      proto = v;
      const origAllowed = v.candidateAddressAllowed;
      v.candidateAddressAllowed = function () { return window.__hostile.allowAllCandidates ? true : origAllowed.apply(this, arguments); };
      const orig = v.checkSdpAgainstFingerprints;
      v.checkSdpAgainstFingerprints = function (sdp, fps) { return window.__hostile.skipOwnSdpCheck ? { ok: true } : orig.apply(this, arguments); };
    }
  });
  const co = RTCPeerConnection.prototype.createOffer;
  RTCPeerConnection.prototype.createOffer = async function () {
    const o = await co.apply(this, arguments);
    if (window.__hostile.offerFingerprint) o.sdp = o.sdp.replace(/a=fingerprint:sha-256 [0-9A-Fa-f:]+/g, 'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'));
    return o;
  };
  const desc = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'onicecandidate');
  Object.defineProperty(RTCPeerConnection.prototype, 'onicecandidate', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(fn) {
      desc.set.call(this, function (e) {
        if (window.__hostile.extraCandidates && e.candidate && !window.__hostile.sentExtra) {
          window.__hostile.sentExtra = true;
          for (const line of window.__hostile.extraCandidates) fn.call(this, { candidate: { candidate: line, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } });
        }
        return fn.call(this, e);
      });
    }
  });
  const sld = RTCPeerConnection.prototype.setLocalDescription;
  RTCPeerConnection.prototype.setLocalDescription = function (d) {
    if (window.__hostile.offerFingerprint && d && d.type === 'offer') return sld.call(this);
    return sld.apply(this, arguments);
  };
  const bogus = new Uint8Array(180).fill(7);
  const grc = RTCDtlsTransport.prototype.getRemoteCertificates;
  RTCDtlsTransport.prototype.getRemoteCertificates = function () {
    if (window.__hostile.cert === 'mismatch') return [bogus.buffer.slice(0)];
    if (window.__hostile.cert === 'unknown') return [];
    return grc.apply(this, arguments);
  };
  const gs = RTCPeerConnection.prototype.getStats;
  RTCPeerConnection.prototype.getStats = async function () {
    const r = await gs.apply(this, arguments);
    if (!window.__hostile.cert) return r;
    const out = new Map();
    r.forEach((v, k) => {
      if (v.type === 'certificate') {
        if (window.__hostile.cert === 'unknown') return;
        out.set(k, Object.assign({}, v, { base64Certificate: btoa(String.fromCharCode(...bogus)) }));
      } else out.set(k, v);
    });
    return out;
  };
}

const LIMITS = { invitesPerCallerPerMin: 200, invitesPerCalleePerMin: 200, invitesPerSourcePerMin: 400, perSourcePerMin: 6000 };

(async () => {
  const relayPort = await L.freePort();
  const H = {}; // per-scenario hooks
  const svc = await L.startCallService({ origin: 'http://127.0.0.1:' + relayPort }, { limits: LIMITS, timers: { listenHoldMs: 600 } });
  const relay = await startRelay(svc.cfg.port, relayPort, {
    listen: (json, ctx) => (H.listen ? H.listen(json, ctx) : undefined),
    poll: (json, ctx) => (H.poll ? H.poll(json, ctx) : undefined)
  });
  const { alice, bob } = await L.makePair(svc, { alice: { init: hostileInit }, bob: { init: hostileInit } });
  const mallory = await T.newIdentity();
  const mallCk = await T.newIdentity();
  const service = svc.origin;
  try {
    const pa = await alice.openCallWindow();
    const pb = await bob.openCallWindow();
    await bob.setTimers({ ringRateWindowMs: 200 });
    await bob.available();
    const reset = async () => {
      for (const p of [pa, pb]) {
        for (const sel of ['#btnHangup', '#btnDecline']) { if (await p.locator(sel + ':not([hidden])').count()) await p.click(sel).catch(() => {}); }
      }
      await until(async () => ['none', 'ended'].includes(await alice.callState()) && ['none', 'ended'].includes(await bob.callState()), 10000, 150);
      for (const p of [pa, pb]) await p.click('#btnDismiss').catch(() => {});
      await sleep(300);
      H.listen = null; H.poll = null;
      await alice.callPage.evaluate(() => { window.__hostile = {}; }); await bob.callPage.evaluate(() => { window.__hostile = {}; });
      scenarioStart = Date.now();
    };
    const dropCount = async (reason) => (await bob.log()).filter((x) => x === 'invite-dropped:' + reason).length;
    const audioAttached = async (w, from) => (await w.trace()).some((t) => t.ev === 'replaceTrack' && t.track === 'audio' && t.t >= (from === undefined ? scenarioStart : from));
    const failSince = async (w, since, pred) => until(async () => { const t = await w.teardown(); return t && t.at > since && t.failReason && (!pred || pred(t.failReason)) && t; }, 25000, 150);
    let scenarioStart = 0;
    const dump = async (why) => { for (const w of [alice, bob]) { console.log('  [' + why + '] ' + w.label + ': ' + (await w.log()).slice(-8).join(' | ')); } };
    const bobNeverRang = async () => (await bob.callState()) === 'none' && (await bob.trace()).length === 0;

    // ---------- forged invitations delivered through the listening channel ----------
    const mkInvite = (over) => {
      const o = over || {};
      return {
        payload: Object.assign(T.base('atlas.call.invite', service, {
          callId: P.randomId(16), tag: P.randomId(16), nonce: P.randomId(16), expiresAt: T.iso(Date.now() + 45000),
          caller: { kind: 'wallet', publicKey: mallory.pub }, callee: { publicKey: bob.pub }, callKey: mallCk.pub,
          media: { kind: 'audio', fingerprints: [T.fp('M')] }
        }), o)
      };
    };
    const inject = async (invite, proofFrom, expectReason) => {
      const before = await dropCount(expectReason);
      let sent = false;
      H.listen = (json) => { if (!sent) { sent = true; json.events.push({ id: 9000 + Math.floor(Math.random() * 1000), type: 'invite', callId: invite.payload.callId, invite }); } return json; };
      return !!(await until(async () => (await dropCount(expectReason)) > before, 10000, 150));
    };
    const signByMallory = async (inv) => { inv.proof = await T.sign(inv.payload, mallory); return inv; };
    const signByAlice = async (inv) => { inv.proof = await alice.wallet((p) => AtlasWallet.signCallPayload(p), inv.payload); return inv; };

    let inv = await signByMallory(mkInvite());
    check('an invitation from a stranger with a valid signature and an invented tag does not ring', (await inject(inv, null, 'policy')) && await bobNeverRang());
    inv = await signByMallory(mkInvite({ caller: { kind: 'wallet', publicKey: alice.pub } }));
    check('an invitation naming Alice as caller but signed by someone else does not ring', (await inject(inv, null, 'signature-or-shape')) && await bobNeverRang());
    inv = await signByAlice(mkInvite({ caller: { kind: 'wallet', publicKey: alice.pub } }));
    check('an invitation genuinely signed by Alice but with a tag Bob never gave her does not ring', (await inject(inv, null, 'policy')) && await bobNeverRang());
    inv = await signByAlice(mkInvite({ caller: { kind: 'wallet', publicKey: alice.pub }, callee: { publicKey: mallory.pub } }));
    check('an invitation signed by Alice but addressed to another wallet does not ring', (await inject(inv, null, 'wrong-callee')) && await bobNeverRang());
    inv = await signByAlice(mkInvite({ caller: { kind: 'wallet', publicKey: alice.pub }, audience: 'http://127.0.0.1:1' }));
    check('an invitation signed for a different call service does not ring', (await inject(inv, null, 'audience')) && await bobNeverRang());
    inv = await signByAlice(mkInvite({ caller: { kind: 'wallet', publicKey: alice.pub }, issuedAt: T.iso(Date.now() - 600000), expiresAt: T.iso(Date.now() - 540000) }));
    check('an expired invitation does not ring', (await inject(inv, null, 'time')) && await bobNeverRang());
    H.listen = null;

    // ---------- replays ----------
    await alice.dial('Bob');
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    const recorded = relay.seen.listen.filter((e) => e.type === 'invite').pop();
    await pb.click('#btnDecline');
    await until(async () => (await bob.callState()) !== 'incoming', 5000, 100);
    await reset();
    check('a genuine invitation was recorded for the replay test', !!recorded);
    const replayDropped = await inject(recorded.invite, null, 'replay');
    const replayQuiet = await bobNeverRang();
    if (!(replayDropped && replayQuiet)) { await dump('replay'); console.log('  replay: dropped=' + replayDropped + ' state=' + (await bob.callState()) + ' trace=' + JSON.stringify(await bob.trace())); }
    check('the same invitation delivered again is not rung twice', replayDropped && replayQuiet);
    H.listen = null;

    // ---------- tampered offer ----------
    await reset();
    H.poll = (json) => {
      for (const e of json.events) if (e.type === 'signal' && e.message.payload.kind === 'offer') e.message.payload.body.sdp = e.message.payload.body.sdp.replace('a=ice-ufrag:', 'a=ice-ufrag:X');
      return json;
    };
    let since = Date.now();
    await alice.dial('Bob'); await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 }); await pb.click('#btnAnswer');
    let tb = await failSince(bob, since);
    check('an offer whose content was changed in transit fails signature verification', tb && tb.failReason === 'bad-signature', tb);
    check('the callee never attached audio to the connection', !(await audioAttached(bob)));
    check('the caller ends too and never attached audio', !!(await until(async () => (await alice.callState()) === 'ended', 15000, 150)) && !(await audioAttached(alice)));

    // ---------- tampered accept ----------
    await reset();
    H.poll = (json) => {
      for (const e of json.events) if (e.type === 'signal' && e.message.payload.kind === 'accept') e.message.payload.body.fingerprints = [T.fp('Z')];
      return json;
    };
    since = Date.now();
    await alice.dial('Bob'); await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 }); await pb.click('#btnAnswer');
    let ta = await failSince(alice, since);
    check('an accept whose fingerprints were changed in transit fails verification at the caller', ta && ta.failReason === 'accept-bad-signature', ta);
    check('the caller never attached audio', !(await audioAttached(alice)));

    // ---------- forged callee ----------
    await reset();
    let forgedOnce = false;
    H.target = null;
    H.poll = async (json, ctx) => {
      if (forgedOnce || !H.target || ctx.req.payload.callId !== H.target) return json;
      const inviteSeen = relay.seen.listen.filter((e) => e.type === 'invite' && e.callId === H.target).pop() || relay.seen.listen.filter((e) => e.type === 'invite').pop();
      if (!inviteSeen) return json;
      forgedOnce = true;
      const payload = {
        type: 'atlas.call.signal', v: 1, audience: service, callId: ctx.req.payload.callId, kind: 'accept',
        body: { inviteHash: await P.payloadHash(inviteSeen.invite.payload), calleeNonce: P.randomId(16), callKey: mallCk.pub, fingerprints: [T.fp('M')] }
      };
      json.events.push({ n: ctx.nextN(), type: 'signal', message: { payload, proof: await T.sign(payload, mallory) } });
      return json;
    };
    since = Date.now();
    await alice.dial('Bob');
    await until(async () => (await alice.snap()).call, 5000, 50);
    H.target = (await alice.snap()).call.id;
    await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 });
    ta = await failSince(alice, since);
    if (!ta) await dump('forged accept');
    check('an accept signed by someone other than the contact is rejected by the caller', ta && ta.failReason === 'accept-wrong-signer', ta);
    check('the caller never attached audio and Bob did not answer', !(await audioAttached(alice)));
    await pb.click('#btnDecline').catch(() => {});

    // ---------- substituted fingerprint in a validly signed offer ----------
    await reset();
    await alice.callPage.evaluate(() => { window.__hostile = { skipOwnSdpCheck: true, offerFingerprint: true }; });
    since = Date.now();
    await alice.dial('Bob'); await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 }); await pb.click('#btnAnswer');
    tb = await failSince(bob, since);
    if (!tb) await dump('fingerprint');
    check('a signed offer whose SDP fingerprint differs from the signed fingerprints is rejected', tb && /^offer:/.test(tb.failReason), tb);
    check('the callee never attached audio', !(await audioAttached(bob)));

    // ---------- another certificate on the media path ----------
    await reset();
    await bob.callPage.evaluate(() => { window.__hostile = { cert: 'mismatch' }; });
    since = Date.now();
    await alice.dial('Bob'); await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 }); await pb.click('#btnAnswer');
    tb = await failSince(bob, since);
    check('a remote certificate that is not the signed one fails the call before any audio', tb && tb.failReason === 'remote-cert-mismatch', tb);
    check('neither side attached audio', !(await audioAttached(bob)) && !(await audioAttached(alice)));
    check('the caller ends as well', !!(await until(async () => (await alice.callState()) === 'ended', 15000, 150)));

    await reset();
    await bob.callPage.evaluate(() => { window.__hostile = { cert: 'unknown' }; });
    since = Date.now();
    await alice.dial('Bob'); await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 }); await pb.click('#btnAnswer');
    tb = await failSince(bob, since);
    check('a remote certificate that cannot be read fails closed', tb && tb.failReason === 'remote-cert-unknown', tb);
    check('neither side attached audio', !(await audioAttached(bob)) && !(await audioAttached(alice)));

    // ---------- candidate addresses the browser must not be asked to contact ----------
    await reset();
    await alice.callPage.evaluate(() => { window.__hostile = { allowAllCandidates: true, extraCandidates: ['candidate:9 1 udp 2122260223 127.0.0.1 9 typ host', 'candidate:8 1 udp 2122260223 169.254.169.254 9 typ host', 'candidate:7 1 udp 2122260223 metadata.internal 9 typ host'] }; });
    await alice.dial('Bob'); await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 }); await pb.click('#btnAnswer');
    check('a call whose peer also sent unusable candidate addresses still connects', !!(await until(async () => (await alice.callState()) === 'active' && (await bob.callState()) === 'active', 30000, 250)));
    const droppedAddr = (await bob.log()).filter((x) => x === 'candidate-dropped:address').length;
    check('the callee dropped loopback, link-local and named candidates without using them', droppedAddr === 3, droppedAddr);

    // ---------- the other side's confirmation never arrives ----------
    await reset();
    await bob.setTimers({ confirmMs: 3000 });
    H.poll = (json) => { for (const e of json.events) if (e.type === 'signal' && e.message.payload.kind === 'confirm' && H.dropConfirmFor) e.drop = true; json.events = json.events.filter((e) => !e.drop); return json; };
    H.dropConfirmFor = true;
    since = Date.now();
    await alice.dial('Bob'); await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 }); await pb.click('#btnAnswer');
    tb = await failSince(bob, since);
    check('a call whose confirmation is withheld ends on the confirm timer', tb && tb.failReason === 'confirm-timeout', tb);
    check('the side that never got a confirmation sent no audio and attached no track', !(await audioAttached(bob)) && (await bob.teardown()).audioWasOn === false);
    H.dropConfirmFor = false; H.poll = null;
    await bob.setTimers({ confirmMs: 10000 });

    // ---------- duplicates, replays and forgeries during a call ----------
    await reset();
    H.poll = (json) => { const copies = json.events.map((e) => JSON.parse(JSON.stringify(e))); json.events.push(...copies); return json; };
    since = Date.now();
    await alice.dial('Bob'); await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 }); await pb.click('#btnAnswer');
    const dupLive = !!(await until(async () => (await alice.callState()) === 'active' && (await bob.callState()) === 'active', 30000, 250));
    if (!dupLive) await dump('duplicates');
    check('events delivered twice with the same number are processed once and the call still connects', dupLive);
    check('the duplicates were ignored, not treated as attacks', (await bob.log()).some((x) => x.startsWith('duplicate-event-ignored')) || (await alice.log()).some((x) => x.startsWith('duplicate-event-ignored')));
    H.poll = null;

    // Replay of a message that was valid once, now with a fresh event number.
    const bobFirst = relay.seen.poll.filter((e) => e.event.type === 'signal' && e.event.message.payload.kind === 'candidates').pop();
    let replayed = false;
    H.poll = (json, ctx) => { if (!replayed && bobFirst && ctx.req.payload.callId === bobFirst.callId && ctx.req.proof.publicKey === bobFirst.poller) { replayed = true; json.events.push({ n: ctx.nextN(), type: 'signal', message: bobFirst.event.message }); } return json; };
    since = Date.now();
    const failed = await until(async () => { const a = await alice.teardown(), b = await bob.teardown(); const hit = [a, b].find((t) => t && t.at > since && t.failReason); return hit || false; }, 20000, 200);
    check('a valid earlier message replayed with a new event number ends the call', failed && failed.failReason === 'bad-sequence', failed);
    check('both sides end with everything released', !!(await until(async () => (await alice.callState()) === 'ended' && (await bob.callState()) === 'ended', 15000, 200)) && (await alice.teardown()).liveTracksAfter === 0 && (await bob.teardown()).liveTracksAfter === 0);

    await reset();
    await alice.dial('Bob'); await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 }); await pb.click('#btnAnswer');
    check('a fresh call connects for the forged end test', !!(await until(async () => (await alice.callState()) === 'active' && (await bob.callState()) === 'active', 30000, 250)));
    let forgedEnd = false;
    H.poll = async (json, ctx) => {
      if (forgedEnd) return json;
      forgedEnd = true;
      const payload = { type: 'atlas.call.signal', v: 1, audience: service, callId: ctx.req.payload.callId, kind: 'end', body: { reason: 'hangup' }, seq: 99 };
      json.events.push({ n: ctx.nextN(), type: 'signal', message: { payload, proof: await T.sign(payload, mallCk) } });
      return json;
    };
    since = Date.now();
    const f2 = await until(async () => { const a = await alice.teardown(), b = await bob.teardown(); return [a, b].find((t) => t && t.failReason && t.at > since) || false; }, 15000, 200);
    check('an end message not signed by the other side\'s call key ends the call as a verification failure, not a hang-up', f2 && f2.reason === 'verify-failed' && ['wrong-signer', 'bad-sequence'].includes(f2.failReason), f2);
    H.poll = null;

    // ---------- a call event from an earlier call ----------
    await reset();
    const oldOffer = relay.seen.poll.filter((e) => e.event.type === 'signal' && e.event.message.payload.kind === 'offer').pop();
    let crossed = false;
    H.poll = (json, ctx) => {
      if (!crossed && oldOffer && ctx.req.payload.callId !== oldOffer.callId && json.events.some((e) => e.type === 'signal' && e.message.payload.kind === 'accept') === false && ctx.req.payload.after >= 0) {
        crossed = true; json.events.push({ n: ctx.nextN(), type: 'signal', message: oldOffer.event.message });
      }
      return json;
    };
    since = Date.now();
    await alice.dial('Bob'); await pb.waitForSelector('#btnAnswer:not([hidden])', { timeout: 15000 }); await pb.click('#btnAnswer');
    const f3 = await until(async () => [await alice.teardown(), await bob.teardown()].find((t) => t && t.at > since && t.failReason && ['wrong-call', 'illegal-kind:offer'].includes(t.failReason)) || false, 20000, 200);
    check('a message from an earlier call injected into a new call is rejected', !!f3, f3);

    // ---------- one certificate per call ----------
    const aliceInvites = relay.seen.listen.filter((e) => e.type === 'invite' && e.invite.payload.caller.publicKey === alice.pub);
    const fps = new Set(aliceInvites.map((e) => e.invite.payload.media.fingerprints[0]));
    const cks = new Set(aliceInvites.map((e) => e.invite.payload.callKey));
    check('every call used its own certificate and its own call key', aliceInvites.length >= 6 && fps.size === new Set(aliceInvites.map((e) => e.invite.payload.callId)).size && cks.size === fps.size, { calls: aliceInvites.length, fingerprints: fps.size, callKeys: cks.size });

    check('no uncaught page errors on either side', alice.errors.length === 0 && bob.errors.length === 0, { a: alice.errors, b: bob.errors });
  } catch (e) {
    check('test run completed', false, String(e && e.stack || e));
    for (const w of [alice, bob]) { try { console.log('--- ' + w.label + ' log tail'); console.log((await w.log()).slice(-14).join('\n')); } catch (e2) { /* gone */ } }
  } finally {
    await alice.close(); await bob.close(); await relay.close(); await svc.close();
  }
  process.exit(L.finish('manual-call-adversary'));
})();
