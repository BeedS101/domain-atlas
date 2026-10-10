// Call window of the secure-comms feasibility spike (test only).
//
// Synthetic, non-extractable test keys; simplified message shapes. This is a
// probe for browser behavior (microphone gating, DTLS fingerprint binding,
// teardown, incoming-call visibility). It is NOT the Atlas calling protocol
// and nothing it prints is a verification result in the product sense.
//
// window.__spike is the test hook. It lives in the extension page's own
// context; web pages cannot reach it (checked by the hostile-page test).
'use strict';
(function () {
  const L = window.SpikeLib;
  const params = new URLSearchParams(location.search);
  const room = params.get('room') || 'room';
  const me = params.get('me') || 'alice';
  const peerName = params.get('peer') || 'bob';
  const base = params.get('base') || 'http://127.0.0.1:9401';
  const attacker = params.get('attacker') === '1';
  const reusable = params.get('reusable') === '1'; // test only: return to idle after a call so one window can ring repeatedly
  const reportToRelay = params.get('report') === '1'; // test only: lets a harness without a debugger read what the page saw

  const $ = (id) => document.getElementById(id);
  $('peer').textContent = peerName + ' (as ' + me + ')';

  const spike = window.__spike = {
    me, peer: peerName, room, attacker,
    state: 'idle',
    role: null,
    callId: null,
    events: [],
    gumCalls: 0,
    gumAfterPermission: [],
    untrustedClicksIgnored: 0,
    options: {
      checkMessageSignature: true,
      checkBindingSignature: true,
      checkSdpFingerprints: true,
      checkRemoteCert: true,
      holdConfirm: false
    },
    idPub: null,
    lastOwnBinding: null,
    stolenAccept: null,
    localFingerprints: null,
    peerFingerprints: null,
    remoteCert: null,
    failure: null,
    teardown: null,
    teardownReason: null,
    incoming: null,
    attention: {},
    candidateTypes: [],
    audioEnabledAt: null
  };

  let idKey = null, ckKey = null, ckPub = null;
  let peerIdPub = null, peerCk = null, peerFps = null;
  let cert = null, pc = null, stream = null;
  let callId = null, role = null;
  let offerSdp = null, answerSdp = null;
  let remoteDescSet = false;
  const iceQueue = [];
  let peerConfirmed = false, ownConfirmSent = false, ownVerified = false, confirmHeld = false;
  let micTracks = [];
  let connectTimer = null;
  let muted = false;
  let audioSender = null;
  let tornDown = false;
  let pollAfter = 0;
  let inviteBinding = null;

  function ev(name, data) {
    spike.events.push({ t: Date.now(), name, data: data === undefined ? null : data });
    const log = $('log');
    if (log) { log.textContent += name + (data === undefined ? '' : ' ' + JSON.stringify(data)) + '\n'; }
  }
  function setState(s) {
    spike.state = s; $('state').textContent = s; ev('state', s);
    $('call').disabled = !(s === 'idle' && !!peerIdPub);
    $('answer').disabled = s !== 'ringing';
    $('decline').disabled = s !== 'ringing';
    $('mute').disabled = !(s === 'connecting' || s === 'in-call');
    $('hangup').disabled = !(s === 'calling' || s === 'accepted' || s === 'connecting' || s === 'in-call' || s === 'ringing');
  }

  // ---------- transport (loopback relay, test only) ----------

  async function post(path, body, signal) {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, keepalive: !signal });
    return res.json();
  }
  async function send(to, msg) {
    try { await post('/send', { room, to, msg }); } catch (err) { ev('send-failed', String(err)); }
  }
  async function signedSend(to, msg) {
    const payload = Object.assign({ callId, from: me, to }, msg);
    const sig = ckKey ? await L.signJson(ckKey, payload) : null;
    await send(to, Object.assign({}, payload, { sig }));
  }

  // ---------- identity / keys ----------

  async function init() {
    const ik = await L.generateTestKeyPair(false); // non-extractable
    idKey = ik.privateKey; spike.idPub = ik.publicKey;
    $('mykey').value = spike.idPub;
    setState('idle');
    if (params.get('peerKey')) spike.setPeerKey(params.get('peerKey'));
    report('ready', { idPub: spike.idPub, visibilityState: document.visibilityState });
    poll();
  }
  function report(kind, data) {
    if (!reportToRelay) return;
    post('/__test/obs', { room, me, kind, data }).catch(() => {});
  }
  spike.setPeerKey = (pub) => { peerIdPub = pub; $('call').disabled = spike.state !== 'idle'; ev('peer-key-set'); };
  spike.exportCheck = async () => { // proves the private keys cannot be exported
    const out = {};
    try { await crypto.subtle.exportKey('pkcs8', idKey); out.identity = 'exported'; } catch (e) { out.identity = 'refused'; }
    if (ckKey) { try { await crypto.subtle.exportKey('pkcs8', ckKey); out.call = 'exported'; } catch (e) { out.call = 'refused'; } }
    return out;
  };

  // ---------- microphone: only inside a trusted click handler ----------

  async function acquireMic(why) {
    spike.gumCalls++;
    ev('gum-request', why);
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const t = s.getAudioTracks()[0];
    micTracks.push(t);
    t.addEventListener('ended', () => ev('track-ended-event'));
    return s;
  }

  function trusted(e) {
    if (e && e.isTrusted) return true;
    spike.untrustedClicksIgnored++;
    ev('untrusted-click-ignored');
    return false;
  }

  // ---------- peer connection ----------

  async function preparePc() {
    cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    const fps = cert.getFingerprints().filter((f) => f.algorithm.toLowerCase() === 'sha-256');
    spike.localFingerprints = fps.map((f) => f.value.toUpperCase()); // getFingerprints() is lower-case in Chromium
    const ck = await L.generateTestKeyPair(false);
    ckKey = ck.privateKey; ckPub = ck.publicKey;

    pc = new RTCPeerConnection({ certificates: [cert], iceServers: [] });
    spike.pc = pc;
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const m = /typ (\w+)/.exec(e.candidate.candidate);
      if (m) spike.candidateTypes.push(m[1]);
      if (spike.options.holdIce) return;
      signedSend(peerName, { type: 'ice', candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } });
    };
    pc.onconnectionstatechange = () => {
      ev('pc-connection', pc.connectionState);
      if (pc.connectionState === 'connected') onConnected();
      if (pc.connectionState === 'failed') teardown('connection-failed');
    };
    pc.oniceconnectionstatechange = () => ev('pc-ice', pc.iceConnectionState);
    pc.ontrack = (e) => { ev('remote-track'); const a = $('remote'); a.srcObject = e.streams[0] || new MediaStream([e.track]); };
    // The sender starts with no track: the microphone is captured (the click happened) but nothing
    // is attached to the connection, so no RTP is sent until both sides have confirmed.
    if (role === 'caller') audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    // The answering side adopts the transceiver created by the remote offer (adoptOfferedTransceiver);
    // adding one before the offer arrives is not matched to the offered m-line in Chromium.
    connectTimer = setTimeout(() => { if (spike.state !== 'in-call') teardown('connect-timeout'); }, 30000);
  }

  function adoptOfferedTransceiver() {
    const tx = pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
    tx.direction = 'sendrecv';
    audioSender = tx.sender;
  }

  async function flushIce() {
    while (iceQueue.length) {
      const c = iceQueue.shift();
      try { await pc.addIceCandidate(c); } catch (err) { ev('ice-add-failed', String(err)); }
    }
  }

  function fail(reason) {
    spike.failure = reason; ev('verification-failed', reason);
    teardown('verification-failed');
  }

  // ---------- verification pieces ----------

  async function verifyBinding(signed, expected) {
    if (!spike.options.checkBindingSignature) {
      return signed && signed.payload ? { ok: true, payload: signed.payload } : { ok: false, reason: 'malformed' };
    }
    return L.verifySignedBinding(signed, peerIdPub, expected);
  }
  async function verifyMessage(msg) {
    if (!spike.options.checkMessageSignature) return true;
    if (!peerCk || typeof msg.sig !== 'string') return false;
    const payload = Object.assign({}, msg); delete payload.sig;
    return L.verifyJson(peerCk, payload, msg.sig);
  }
  function checkSdp(sdp) {
    if (!spike.options.checkSdpFingerprints) return { ok: true, skipped: true };
    return L.checkSdpAgainstFingerprints(sdp, peerFps);
  }

  async function transcriptHash() {
    const callerFps = role === 'caller' ? spike.localFingerprints : peerFps;
    const calleeFps = role === 'caller' ? peerFps : spike.localFingerprints;
    return L.sha256B64url(L.canonicalize({ callId, offer: await L.sha256B64url(offerSdp || ''), answer: await L.sha256B64url(answerSdp || ''), callerFps, calleeFps }));
  }

  async function remoteCertHashes() {
    const out = { viaApi: null, viaStats: null, apiError: null, apiAttempts: 0, apiEmptyAttempts: 0, dtlsStates: [] };
    try {
      const receiver = pc.getReceivers().find((r) => r.track && r.track.kind === 'audio');
      const transport = receiver && receiver.transport;
      if (transport && typeof transport.getRemoteCertificates === 'function') {
        // getRemoteCertificates() can return an empty list right after the connection reports 'connected';
        // an empty list is "not yet known", never a pass, so it is retried briefly.
        for (let i = 0; i < 20; i++) {
          out.apiAttempts++; out.dtlsStates.push(transport.state);
          const certs = transport.getRemoteCertificates();
          if (certs.length) { out.viaApi = await Promise.all(certs.map((c) => L.certFingerprintSha256(c))); break; }
          out.apiEmptyAttempts++;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } catch (err) { out.apiError = String(err); }
    try {
      const report = await pc.getStats();
      const byId = {}; report.forEach((s) => { byId[s.id] = s; });
      let tr = null; report.forEach((s) => { if (s.type === 'transport') tr = s; });
      const c = tr && byId[tr.remoteCertificateId];
      if (c && c.base64Certificate) {
        const der = Uint8Array.from(atob(c.base64Certificate), (ch) => ch.charCodeAt(0));
        out.viaStats = [await L.certFingerprintSha256(der)];
      }
    } catch (err) { out.statsError = String(err); }
    return out;
  }

  async function onConnected() {
    if (attacker) return;
    if (spike.state === 'in-call' || ownVerified) return;
    setState('connecting');
    const h = await remoteCertHashes();
    const allowed = new Set((peerFps || []).map((f) => f.toUpperCase()));
    const sets = [h.viaApi, h.viaStats].filter((x) => x && x.length);
    const match = sets.length > 0 && sets.every((s) => s.every((f) => allowed.has(f)));
    spike.remoteCert = Object.assign({}, h, { expected: peerFps, match, methods: sets.length });
    ev('remote-cert-checked', { match, api: !!h.viaApi, stats: !!h.viaStats });
    if (spike.options.checkRemoteCert && !match) { fail('remote-cert-mismatch'); return; }
    ownVerified = true;
    if (spike.options.holdConfirm) { confirmHeld = true; ev('confirm-held'); return; }
    await sendConfirm();
  }
  async function sendConfirm() {
    if (ownConfirmSent || tornDown) return;
    ownConfirmSent = true;
    await signedSend(peerName, { type: 'confirm', th: await transcriptHash() });
    ev('confirm-sent');
    maybeEnableAudio();
  }
  spike.releaseConfirm = async () => { confirmHeld = false; spike.options.holdConfirm = false; await sendConfirm(); };

  async function maybeEnableAudio() {
    if (!ownConfirmSent || !peerConfirmed || tornDown || spike.state === 'in-call') return;
    const live = micTracks.find((t) => t.readyState === 'live');
    if (live && !muted && audioSender) { live.enabled = true; await audioSender.replaceTrack(live); }
    spike.audioEnabledAt = Date.now();
    setState('in-call');
  }

  // ---------- incoming message handling ----------

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || tornDown) return;
    ev('recv', msg.type);
    if (attacker) return handleAttacker(msg);

    if (msg.type === 'invite') {
      if (spike.state !== 'idle' || !peerIdPub) { ev('invite-ignored', spike.state); return; }
      const v = await verifyBinding(msg.binding, { role: 'caller', to: me, from: peerName });
      if (!v.ok) { ev('invite-rejected', v.reason); return; }
      if (v.payload.callId !== msg.callId) { ev('invite-rejected', 'callId-mismatch'); return; }
      inviteBinding = v.payload; callId = v.payload.callId; role = 'callee';
      spike.role = role; spike.callId = callId;
      peerFps = v.payload.fingerprints; spike.peerFingerprints = peerFps; peerCk = v.payload.ck;
      setState('ringing');
      onIncoming();
      return;
    }
    if (msg.callId !== callId) { ev('ignored-other-call'); return; }

    if (msg.type === 'accept' && role === 'caller' && spike.state === 'calling') {
      const v = await verifyBinding(msg.binding, { role: 'callee', callId, from: peerName, to: me });
      if (!v.ok) { fail('accept:' + v.reason); return; }
      peerFps = v.payload.fingerprints; spike.peerFingerprints = peerFps; peerCk = v.payload.ck;
      setState('connecting');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      offerSdp = pc.localDescription.sdp;
      await signedSend(peerName, { type: 'offer', sdp: offerSdp });
      return;
    }
    if (msg.type === 'offer' && role === 'callee' && spike.state === 'accepted') {
      if (!(await verifyMessage(msg))) { fail('offer:bad-message-signature'); return; }
      const c = checkSdp(msg.sdp);
      if (!c.ok) { fail('offer:' + c.reason); return; }
      offerSdp = msg.sdp;
      setState('connecting');
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      adoptOfferedTransceiver();
      remoteDescSet = true; await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      answerSdp = pc.localDescription.sdp;
      await signedSend(peerName, { type: 'answer', sdp: answerSdp });
      return;
    }
    if (msg.type === 'answer' && role === 'caller' && spike.state === 'connecting') {
      if (!(await verifyMessage(msg))) { fail('answer:bad-message-signature'); return; }
      const c = checkSdp(msg.sdp);
      if (!c.ok) { fail('answer:' + c.reason); return; }
      answerSdp = msg.sdp;
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      remoteDescSet = true; await flushIce();
      return;
    }
    if (msg.type === 'ice' && pc) {
      if (!(await verifyMessage(msg))) { ev('ice-rejected', 'bad-signature'); return; }
      if (remoteDescSet) { try { await pc.addIceCandidate(msg.candidate); } catch (err) { ev('ice-add-failed', String(err)); } } else iceQueue.push(msg.candidate);
      return;
    }
    if (msg.type === 'confirm' && pc) {
      if (!(await verifyMessage(msg))) { fail('confirm:bad-message-signature'); return; }
      if (msg.th !== (await transcriptHash())) { fail('confirm:transcript-mismatch'); return; }
      peerConfirmed = true; ev('peer-confirmed');
      maybeEnableAudio();
      return;
    }
    if (msg.type === 'end' || msg.type === 'decline') {
      if (peerCk && !(await verifyMessage(msg))) { ev('end-rejected', 'bad-signature'); return; }
      teardown('peer-' + msg.type);
    }
  }

  // ---------- adversary (test only): answers in place of the real callee ----------

  async function handleAttacker(msg) {
    if (msg.type === 'accept') { spike.stolenAccept = msg.binding; ev('attacker-copied-accept'); return; }
    if (msg.type === 'offer') {
      callId = msg.callId; role = 'attacker';
      stream = await acquireMic('attacker');
      await preparePc();
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      adoptOfferedTransceiver();
      remoteDescSet = true; await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (audioSender && micTracks[0]) await audioSender.replaceTrack(micTracks[0]); // an attacker sends whatever it likes
      offerSdp = msg.sdp; answerSdp = pc.localDescription.sdp;
      const stolen = spike.stolenAccept && spike.stolenAccept.payload;
      peerFps = stolen ? stolen.fingerprints : []; // for its own transcript copy
      await signedSend(peerName, { type: 'answer', sdp: answerSdp });
      spike.peerFingerprints = null;
      // Confirm with the transcript the victim will compute (all of it is public to the relay).
      const callerFps = L.parseSdpFingerprints(offerSdp).map((f) => f.value);
      const th = await L.sha256B64url(L.canonicalize({ callId, offer: await L.sha256B64url(offerSdp), answer: await L.sha256B64url(answerSdp), callerFps, calleeFps: peerFps }));
      pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') signedSend(peerName, { type: 'confirm', th }); });
      setState('connecting');
      return;
    }
    if (msg.type === 'ice' && pc) {
      if (remoteDescSet) { try { await pc.addIceCandidate(msg.candidate); } catch (e) { /* ignore */ } } else iceQueue.push(msg.candidate);
    }
  }

  // ---------- incoming-call presentation ----------

  function onIncoming() {
    spike.incoming = {
      at: Date.now(), visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
      hidden: document.hidden, title: document.title
    };
    document.title = 'Incoming call from ' + peerName;
    spike.incoming.titleAfter = document.title;
    ev('incoming', spike.incoming);
    report('incoming', spike.incoming);
    try {
      chrome.windows.getCurrent((w) => {
        if (chrome.runtime.lastError || !w) { spike.attention.drawAttention = 'no-window: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message); return; }
        spike.attention.windowState = w.state; spike.attention.windowFocused = w.focused;
        chrome.windows.update(w.id, { drawAttention: true }, () => {
          spike.attention.drawAttention = chrome.runtime.lastError ? 'error: ' + chrome.runtime.lastError.message : 'called-ok';
        });
      });
    } catch (err) { spike.attention.drawAttention = 'threw: ' + err; }
    try {
      chrome.notifications.create('incoming-' + callId, { type: 'basic', iconUrl: 'icon.png', title: 'Incoming call (test)', message: 'from ' + peerName, requireInteraction: true }, (id) => {
        spike.attention.notification = chrome.runtime.lastError ? 'error: ' + chrome.runtime.lastError.message : 'created:' + id;
      });
      setTimeout(() => report('attention', spike.attention), 700);
    } catch (err) { spike.attention.notification = 'threw: ' + err; }
  }
  document.addEventListener('visibilitychange', () => { ev('visibility', document.visibilityState); report('visibility', document.visibilityState); });
  document.addEventListener('freeze', () => { ev('page-freeze'); report('freeze'); });
  document.addEventListener('resume', () => { ev('page-resume'); report('resume'); });

  // ---------- long poll ----------

  async function poll() {
    for (;;) {
      try {
        const body = await post('/poll', { room, me, after: pollAfter, waitMs: 20000 });
        for (const e of body.events || []) {
          pollAfter = Math.max(pollAfter, e.id);
          try { await handle(e.msg); } catch (err) { ev('handler-error', String(err)); fail('handler-error'); }
        }
      } catch (err) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  // ---------- user actions (trusted clicks only) ----------

  $('setpeer').addEventListener('click', () => { const v = $('peerkey').value.trim(); if (v) spike.setPeerKey(v); });

  $('call').addEventListener('click', async (e) => {
    if (!trusted(e)) return;
    if (spike.state !== 'idle' || !peerIdPub) return;
    try {
      role = 'caller'; spike.role = role; callId = L.randomId(12); spike.callId = callId;
      setState('calling');
      stream = await acquireMic('call-click');
      await preparePc();
      const invite = await L.makeSignedBinding(idKey, spike.idPub, { role: 'caller', callId, from: me, to: peerName, fingerprints: spike.localFingerprints, ck: ckPub });
      spike.lastOwnBinding = invite;
      await send(peerName, { type: 'invite', callId, binding: invite });
    } catch (err) { ev('call-failed', String(err && err.name || err)); spike.failure = 'call-failed:' + (err && err.name); teardown('call-failed'); }
  });

  $('answer').addEventListener('click', async (e) => {
    if (!trusted(e)) return;
    if (spike.state !== 'ringing') return;
    try {
      setState('accepted');
      stream = await acquireMic('answer-click');
      await preparePc();
      const accept = await L.makeSignedBinding(idKey, spike.idPub, { role: 'callee', callId, from: me, to: peerName, fingerprints: spike.localFingerprints, ck: ckPub });
      spike.lastOwnBinding = accept;
      await send(peerName, { type: 'accept', callId, binding: accept });
    } catch (err) { ev('answer-failed', String(err && err.name || err)); spike.failure = 'answer-failed:' + (err && err.name); teardown('answer-failed'); }
  });

  $('decline').addEventListener('click', async (e) => {
    if (!trusted(e)) return;
    if (spike.state !== 'ringing') return;
    const msg = { type: 'decline', callId, from: me, to: peerName };
    tornDown = false; teardown('declined');
    await send(peerName, msg);
  });

  $('mute').addEventListener('click', async (e) => {
    if (!trusted(e)) return;
    if (!pc) return;
    const sender = audioSender;
    if (!muted) {
      // Release the capture device, not just silence the track.
      for (const t of micTracks) t.stop();
      try { await sender.replaceTrack(null); } catch (err) { ev('replace-null-failed', String(err)); }
      muted = true; spike.mutedTrackStates = micTracks.map((t) => t.readyState);
      $('mute').textContent = 'Unmute'; ev('muted');
    } else {
      const s = await acquireMic('unmute-click');
      const t = s.getAudioTracks()[0];
      t.enabled = true;
      if (spike.state === 'in-call') await sender.replaceTrack(t); // before the confirms it stays unattached
      muted = false; $('mute').textContent = 'Mute'; ev('unmuted');
    }
  });

  $('hangup').addEventListener('click', async (e) => {
    if (!trusted(e)) return;
    await hangup('hangup');
  });

  // Releases everything synchronously, then tells the peer (signed with the key captured before it was dropped).
  async function hangup(reason) {
    const key = ckKey, p = peerName, cid = callId;
    teardown(reason);
    if (!cid) return;
    const payload = { type: 'end', callId: cid, from: me, to: p };
    const sig = key ? await L.signJson(key, payload) : null;
    await send(p, Object.assign({}, payload, { sig }));
  }
  // Test hook: the same path as the button, without needing a click (for lock / external triggers).
  spike.hangupFromTest = () => hangup('hangup');

  // ---------- teardown: idempotent, releases every capture track and the connection ----------

  function teardown(reason) {
    if (tornDown) return;
    tornDown = true;
    spike.teardownReason = reason;
    clearTimeout(connectTimer);
    const trackStates = [];
    for (const t of micTracks) { try { t.stop(); } catch (e) { /* ignore */ } trackStates.push(t.readyState); }
    if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch (e) { /* ignore */ } }
    let senderTracks = null;
    if (pc) {
      try { senderTracks = pc.getSenders().map((s) => (s.track ? s.track.readyState : null)); } catch (e) { /* ignore */ }
      try { pc.getSenders().forEach((s) => { try { s.replaceTrack(null); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
      try { pc.close(); } catch (e) { /* ignore */ }
    }
    const a = $('remote'); a.srcObject = null;
    spike.teardown = {
      reason, at: Date.now(), micTrackStates: trackStates, senderTracks,
      pcConnectionState: pc ? pc.connectionState : null, pcSignalingState: pc ? pc.signalingState : null,
      liveTracksAfter: micTracks.filter((t) => t.readyState === 'live').length
    };
    ckKey = null; peerCk = null; cert = null; stream = null;
    setState('ended');
    ev('teardown', spike.teardown);
    if (reusable) setTimeout(resetForNextCall, 100);
  }

  function resetForNextCall() {
    (spike.history = spike.history || []).push({ teardown: spike.teardown, incoming: spike.incoming, failure: spike.failure, callId });
    peerCk = null; peerFps = null; cert = null; pc = null; stream = null; callId = null; role = null;
    offerSdp = null; answerSdp = null; remoteDescSet = false; iceQueue.length = 0;
    peerConfirmed = false; ownConfirmSent = false; ownVerified = false; confirmHeld = false;
    micTracks = []; muted = false; audioSender = null; tornDown = false; inviteBinding = null; ckKey = null;
    Object.assign(spike, { role: null, callId: null, failure: null, incoming: null, attention: {}, audioEnabledAt: null, remoteCert: null, candidateTypes: [], teardown: null, teardownReason: null, pc: null });
    setState('idle');
  }
  spike.teardownNow = (reason) => teardown(reason || 'test');

  // pagehide: release everything and send a best-effort 'end' (keepalive fetch) so the peer need not wait for ICE consent to expire.
  window.addEventListener('pagehide', () => { hangup('pagehide'); });
  window.addEventListener('error', () => hangup('error'));
  window.addEventListener('unhandledrejection', () => hangup('error'));
  spike.throwForTest = () => { setTimeout(() => { throw new Error('spike forced error'); }, 0); };

  // Lock: the real wallet drops the unlocked identity; the spike models it with a storage flag.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes.spikeLocked && changes.spikeLocked.newValue) { ev('lock-signal'); hangup('lock'); }
    });
  } catch (err) { ev('no-storage-listener', String(err)); }

  // ---------- diagnostics for the tests ----------

  spike.getInfo = async () => {
    const info = { state: spike.state, connectionState: pc ? pc.connectionState : null, tracks: micTracks.map((t) => ({ readyState: t.readyState, enabled: t.enabled })) };
    if (!pc || pc.connectionState === 'closed') return info;
    const report = await pc.getStats();
    const byId = {}; report.forEach((s) => { byId[s.id] = s; });
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') info.inbound = { packetsReceived: s.packetsReceived, bytesReceived: s.bytesReceived, totalAudioEnergy: s.totalAudioEnergy, totalSamplesReceived: s.totalSamplesReceived };
      if (s.type === 'outbound-rtp' && s.kind === 'audio') info.outbound = { packetsSent: s.packetsSent, bytesSent: s.bytesSent };
      if (s.type === 'transport') {
        info.transport = { dtlsState: s.dtlsState, tlsVersion: s.tlsVersion, dtlsCipher: s.dtlsCipher, srtpCipher: s.srtpCipher };
        const pair = byId[s.selectedCandidatePairId];
        if (pair) {
          const l = byId[pair.localCandidateId], r = byId[pair.remoteCandidateId];
          info.pair = { local: l && l.candidateType, remote: r && r.candidateType, localAddressKnown: !!(l && l.address), localAddress: l && l.address };
        }
      }
    });
    return info;
  };
  spike.sdp = () => ({ local: pc && pc.localDescription ? pc.localDescription.sdp : null, remote: pc && pc.remoteDescription ? pc.remoteDescription.sdp : null });

  init().catch((err) => { ev('init-failed', String(err)); });
})();
