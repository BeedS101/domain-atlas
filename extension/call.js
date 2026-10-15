// Domain Atlas calling window: authenticated wallet-to-wallet voice calls.
//
// This page is the only place a call is placed, answered or ended. It runs in the
// extension's own origin, is not listed as a web-accessible resource, and acts only
// on clicks it receives itself (event.isTrusted). A web page can neither open it as
// a frame nor reach any function here; the page signing bridge refuses atlas.call.*
// payloads and the wallet's generic signer refuses them too.
//
// Protocol: docs/voice-calls-architecture.md and voice-calls-endpoints-and-state.md.
//  - Identity key (IK): signs the invite, the accept, tag creation and the delegation of
//    a throwaway listening-session key (SK). Held by wallet.js; never read here.
//  - Call key (CK): created per call, non-extractable, signs every later message.
//  - The browser does the encryption (DTLS-SRTP). This page adds authentication: the
//    DTLS certificate fingerprints are signed before any SDP exists, every SDP is
//    checked against them, and the certificate the browser actually negotiated is
//    compared with the signed fingerprint before any microphone audio is attached.
'use strict';
(function () {
  const P = AtlasCallProtocol;
  const W = AtlasWallet;
  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();

  // Timer values from docs/voice-calls-endpoints-and-state.md section 4.4. Tests shorten them.
  const timers = {
    ringMs: 45000, inviteMs: 50000, acceptToOfferMs: 20000, offerToAnswerMs: 20000,
    iceMs: 30000, confirmMs: 10000, silentWarnMs: 30000, silentEndMs: 60000,
    sessionMs: 3500000, retryMs: 2000, giveUpMs: 600000, candidateBatchMs: 120, endSendMs: 2000, ringRateWindowMs: 60000
  };

  const LEGAL_FROM_PEER = {
    caller: { ringing: ['accept'], negotiating: ['answer', 'candidates', 'end'], connecting: ['candidates', 'confirm', 'end'], verifying: ['candidates', 'confirm', 'end'], active: ['candidates', 'end'] },
    callee: { 'await-offer': ['offer', 'end'], connecting: ['candidates', 'confirm', 'end'], verifying: ['candidates', 'confirm', 'end'], active: ['candidates', 'end'] }
  };
  const CANDIDATE_RE = /^candidate:\S+ \d+ (udp|tcp|UDP|TCP) \d+ \S+ \d+ typ (host|srflx|prflx|relay)( .*)?$/;

  const REASON_TEXT = {
    declined: 'Not answered.', busy: 'Busy.', noanswer: 'No answer.', cancelled: 'Call cancelled.',
    unavailable: 'Not available right now.', timeout: 'The call timed out.', 'mic-denied': 'The microphone was not allowed, so no call was placed.',
    'verify-failed': 'The call was stopped: the other side could not be authenticated.', 'connect-failed': 'The call could not connect on this network.',
    'network-lost': 'The connection was lost.', hangup: 'Call ended.', 'policy-blocked': 'This contact is not allowed to call you.',
    locked: 'Call ended: the wallet was locked.', 'window-closed': 'Call ended: the window was closed.', error: 'The call ended because of an error.'
  };

  // ---------- state ----------

  const st = {
    identity: null, config: { service: null, domain: null, devAllowHttp: false },
    contacts: [], availability: 'dnd', listen: null, call: null,
    selected: null,        // contact picked for the next outgoing call (by the Call button or by the messaging window)
    seen: new Map(), rings: new Map(), lockHeld: false, started: false
  };
  const hook = window.__atlasCall = { log: [], timers, lastTeardown: null, history: [] };

  function log(name, data) {
    const line = new Date().toISOString().slice(11, 23) + ' ' + name + (data === undefined ? '' : ' ' + (typeof data === 'string' ? data : JSON.stringify(data)));
    hook.log.push({ t: Date.now(), name, data: data === undefined ? null : data });
    if (hook.log.length > 400) hook.log.shift();
    const el = $('log');
    el.textContent = (el.textContent + line + '\n').split('\n').slice(-30).join('\n');
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shortKey = (k) => (k ? k.slice(0, 6) + '…' + k.slice(-6) : '');

  function notice(text, kind) {
    const n = $('notice');
    if (!text) { n.hidden = true; return; }
    n.hidden = false; n.textContent = text; n.className = 'banner' + (kind ? ' ' + kind : '');
  }

  // ---------- small crypto helpers ----------

  async function newKeyPair() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    return { priv: pair.privateKey, pub: P.b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))) };
  }
  async function signRaw(key, payload) {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.priv, enc.encode(P.canonicalize(payload)));
    return { signerRole: 'raw-ecdsa', publicKey: key.pub, signature: P.b64urlEncode(new Uint8Array(sig)) };
  }
  const colonHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
  async function certHash(der) { return colonHex(await P.sha256Bytes(der instanceof Uint8Array ? der : new Uint8Array(der))); }
  const base = (type, audience, extra) => Object.assign({ type, v: 1, audience, issuedAt: new Date().toISOString() }, extra);

  // ---------- status shared with the messaging window ----------

  let statusTimer = null;
  async function publishStatus() {
    try {
      const winId = await new Promise((resolve) => { try { chrome.windows.getCurrent((w) => resolve(w && w.id)); } catch (e) { resolve(null); } });
      await chrome.storage.session.set({
        atlasCallStatus: { availability: st.availability, state: st.call ? st.call.state : 'idle', peerKey: st.call ? st.call.contactKey : null, windowId: winId, updatedAt: Date.now() },
        atlasCallActive: st.call && ['connecting', 'verifying', 'active'].includes(st.call.state) ? Date.now() : 0
      });
    } catch (e) { /* storage unavailable: the window still works */ }
  }
  function startStatusTimer() { if (!statusTimer) statusTimer = setInterval(publishStatus, 10000); }

  // ---------- wallet state ----------

  async function refreshWallet() {
    const prev = st.identity && st.identity.publicKey;
    let identity = null;
    try { identity = (await W.isUnlocked()) ? await W.getIdentity() : null; } catch (e) { identity = null; }
    if (prev && (!identity || identity.publicKey !== prev)) {
      // Locked, signed out or switched: nothing may keep running under the old identity.
      await shutdownAll('locked');
      dismissCall();
    }
    st.identity = identity ? { publicKey: identity.publicKey, mode: identity.mode } : null;
    if (identity) {
      st.config = await W.getCallConfig();
      st.contacts = await W.getCallContacts();
    } else {
      st.contacts = [];
    }
    render();
  }

  // ---------- rendering ----------

  function verifiedBadge(verified) {
    return verified
      ? '<span class="pill verified">Verified contact</span>'
      : '<span class="pill unverified">Not verified</span>';
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }

  function render() {
    const locked = !st.identity;
    $('screenLocked').hidden = !locked;
    $('screenOtherWindow').hidden = st.lockHeld || !st.started ? true : false;
    $('screenHome').hidden = locked || !!st.call || !!st.selected || !st.lockHeld;
    $('screenCall').hidden = !st.call && !st.selected;
    $('availPill').textContent = st.availability === 'available' ? 'Available' : 'Do not disturb';
    $('availPill').className = 'pill' + (st.availability === 'available' ? ' verified' : '');
    $('btnAvailable').disabled = locked || !st.config.service || st.availability === 'available' || busyNow();
    $('btnDnd').disabled = st.availability !== 'available';
    $('availNote').textContent = !st.config.service ? 'Set up a call service first (below).'
      : st.availability === 'available' ? 'People you allowed can ring you while this window stays open. Press Do not disturb to stop.'
      : 'Callers are told you are not available. Press Available to receive calls while this window is open.';
    $('serviceInput').value = $('serviceInput') === document.activeElement ? $('serviceInput').value : (st.config.service || '');
    $('devHttp').checked = !!st.config.devAllowHttp;
    renderContacts();
    renderCallScreen();
    publishStatus();
  }

  function renderContacts() {
    const box = $('contacts');
    box.innerHTML = '';
    $('contactsEmpty').hidden = st.contacts.length > 0;
    for (const c of st.contacts) {
      const row = document.createElement('div');
      row.className = 'contact';
      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = '<b>' + esc(c.name) + '</b>' + verifiedBadge(c.verified) + ' <span class="note">' +
        (c.canCall ? 'You can call' : 'No call permission from them') + ' · ' + (c.allowed ? 'They can call you' : 'They cannot call you') + '</span>';
      row.appendChild(who);
      const mk = (label, cls, fn, disabled) => { const b = document.createElement('button'); b.textContent = label; b.className = 'small ' + (cls || ''); b.disabled = !!disabled; b.addEventListener('click', (e) => { if (e.isTrusted) fn(c); }); row.appendChild(b); return b; };
      mk('Call', 'primary', (x) => selectContact(x.publicKey), !c.canCall || busyNow());
      mk(c.allowed ? 'Stop allowing' : 'Allow calls', '', toggleAllow, false);
      mk('Verify', '', showSafety, false);
      box.appendChild(row);
    }
  }

  function trustLine(call, state) {
    if (!call) return '';
    const name = call.contactName;
    const lead = state === 'select' ? 'The call will go to the key saved for ' + name + '. '
      : state === 'incoming' ? 'This invitation is signed by the key saved for ' + name + '. '
      : 'The other side proved it holds the key saved for ' + name + '. ';
    return lead + (call.verified
      ? 'You compared safety codes with this contact, so the key is the person you verified.'
      : 'You have not compared safety codes with this contact, so this shows the saved name only: it does not prove who holds that key.');
  }

  function renderCallScreen() {
    const call = st.call;
    const sel = !call && st.selected ? st.contacts.find((c) => c.publicKey === st.selected) : null;
    const c = call || (sel ? { contactName: sel.name, contactKey: sel.publicKey, verified: sel.verified, state: 'select' } : null);
    for (const id of ['btnStart', 'btnAnswer', 'btnDecline', 'btnMute', 'btnHangup', 'btnDismiss']) $(id).hidden = true;
    if (!c) return;
    $('callWho').textContent = c.contactName || '';
    $('callVerified').innerHTML = verifiedBadge(c.verified);
    $('callKey').textContent = 'Key ' + shortKey(c.contactKey);
    const s = c.state;
    const label = {
      select: 'Ready to call', preparing: 'Starting…', inviting: 'Contacting…', ringing: 'Ringing…', incoming: 'Incoming call',
      accepting: 'Answering…', 'await-offer': 'Connecting…', negotiating: 'Connecting…', connecting: 'Connecting…', verifying: 'Checking the other side…',
      active: call && call.muted ? 'In call (microphone off)' : 'In call', ended: call && call.endText
    }[s] || s;
    $('callState').textContent = label || '';
    $('callTrust').textContent = (s === 'active' || s === 'verifying' || s === 'incoming' || s === 'select') ? trustLine(c, s) : '';
    if (s === 'active') $('callTrust').textContent += ' Audio is encrypted between the two browsers, and the encryption certificate matched the identity-signed fingerprint.';
    $('btnStart').hidden = s !== 'select';
    $('btnAnswer').hidden = s !== 'incoming';
    $('btnDecline').hidden = s !== 'incoming';
    $('btnMute').hidden = s !== 'active';
    $('btnMute').textContent = call && call.muted ? 'Unmute' : 'Mute';
    $('btnHangup').hidden = !['preparing', 'inviting', 'ringing', 'accepting', 'await-offer', 'negotiating', 'connecting', 'verifying', 'active'].includes(s);
    $('btnDismiss').hidden = s !== 'ended' && s !== 'select';
  }

  // ---------- contacts: permission and verification ----------

  function selectContact(key) {
    if (busyNow()) return;
    if (st.call) dismissCall();
    st.selected = key;
    render();
  }
  async function toggleAllow(c) {
    try {
      notice('Working…');
      if (c.allowed) await W.revokeCalling(c.publicKey); else await W.grantCalling(c.publicKey);
      notice(c.allowed ? c.name + ' can no longer call you.' : c.name + ' can now call you.', 'good');
    } catch (err) { notice(err.message, 'bad'); }
    await refreshWallet();
  }
  let safetyFor = null;
  async function showSafety(c) {
    safetyFor = c.publicKey;
    $('safetyPanel').hidden = false;
    $('safetyWho').textContent = 'Code for you and ' + c.name + ':';
    $('safetyCode').textContent = await W.getContactSafetyCode(c.publicKey);
  }
  $('btnSafetyClose').addEventListener('click', () => { $('safetyPanel').hidden = true; safetyFor = null; });
  $('btnSafetyMatch').addEventListener('click', async (e) => {
    if (!e.isTrusted || !safetyFor) return;
    await W.setContactCallVerified(safetyFor, true);
    $('safetyPanel').hidden = true; safetyFor = null;
    await refreshWallet();
  });

  $('btnSaveService').addEventListener('click', async (e) => {
    if (!e.isTrusted) return;
    $('serviceNote').textContent = 'Checking…';
    try {
      const cfg = await W.setCallConfig({ service: $('serviceInput').value.trim(), devAllowHttp: $('devHttp').checked });
      $('serviceNote').textContent = 'Saved. This service admits members of ' + cfg.domain + '’s Post Office.';
    } catch (err) { $('serviceNote').textContent = err.message; }
    await refreshWallet();
  });
  $('btnClearService').addEventListener('click', async (e) => {
    if (!e.isTrusted) return;
    await goDnd('service-removed');
    try { await W.setCallConfig({ service: null, devAllowHttp: $('devHttp').checked }); } catch (err) { $('serviceNote').textContent = err.message; }
    await refreshWallet();
  });

  // ---------- availability and the listening session ----------

  async function goAvailable() {
    if (!st.identity || !st.config.service || busyNow() || st.availability === 'available') return;
    const service = st.config.service;
    const token = { service, abort: new AbortController(), pendingAck: [], expiresAt: 0, sk: null, delegation: null };
    st.listen = token;
    st.availability = 'available';
    render();
    try {
      const sk = await newKeyPair();
      const now = Date.now();
      const payload = base('atlas.call.listen-session', service, { expiresAt: new Date(now + timers.sessionMs).toISOString(), sessionKey: sk.pub });
      const proof = await W.signCallPayload(payload);
      if (st.listen !== token) return;
      token.sk = sk; token.delegation = { payload, proof }; token.expiresAt = now + timers.sessionMs;
    } catch (err) {
      if (st.listen === token) { st.listen = null; st.availability = 'dnd'; notice('Could not start listening: ' + err.message, 'bad'); render(); }
      return;
    }
    log('listening-started');
    runListen(token);
  }

  async function stopListening(sendStop) {
    const token = st.listen;
    st.listen = null;
    if (!token) return;
    token.abort.abort();
    if (sendStop && token.sk) {
      try {
        const payload = base('atlas.call.listen', token.service, { nonce: P.randomId(16), ack: [], stop: true });
        await W.callPost(token.service, '/atlas/call/listen', { payload, proof: await signRaw(token.sk, payload), session: token.delegation }, { keepalive: true, timeoutMs: 4000 });
      } catch (err) { /* the listener goes stale on its own */ }
    }
    token.sk = null; token.delegation = null;
  }

  async function goDnd(why) {
    st.availability = 'dnd';
    await stopListening(true);
    log('dnd', why);
    render();
  }

  // A call service that has been failing for a long time (stopped, moved, removed) is no longer
  // waited on: availability is turned off and the person is told, instead of retrying for ever.
  async function giveUpListening(token, failingSince) {
    if (Date.now() - failingSince < timers.giveUpMs) return false;
    if (st.listen !== token) return true;
    await goDnd('service-unreachable');
    notice('The call service could not be reached for a while, so you are no longer shown as available. Press Available once it is back.', 'warn');
    return true;
  }

  async function runListen(token) {
    let failures = 0, failingSince = 0;
    while (st.listen === token) {
      if (Date.now() >= token.expiresAt) { await goDnd('session-ended'); notice('Your availability ended after an hour. Press Available to continue receiving calls.', 'warn'); return; }
      try {
        const payload = base('atlas.call.listen', token.service, { nonce: P.randomId(16), ack: token.pendingAck.splice(0, P.LIMITS.ackMax) });
        const res = await W.callPost(token.service, '/atlas/call/listen', { payload, proof: await signRaw(token.sk, payload), session: token.delegation }, { signal: token.abort.signal, timeoutMs: 40000 });
        if (st.listen !== token) return;
        if (res.status === 200 && res.json && Array.isArray(res.json.events)) {
          failures = 0; failingSince = 0;
          if (!$('notice').hidden && $('notice').dataset.listen) notice('');
          for (const ev of res.json.events) {
            token.pendingAck.push(ev.id);
            try { await handleListenEvent(ev); } catch (err) { log('listen-event-error', String(err && err.message)); }
          }
          continue;
        }
        const code = res.json && res.json.code;
        if (code === 'session-expired') { await goDnd('session-expired'); notice('Your availability ended. Press Available to continue.', 'warn'); return; }
        if (code === 'stale-request') { notice('Your computer’s clock is out of step with the call service. Check the date and time.', 'warn'); }
        else if (code === 'calls-not-configured') { await goDnd('service-not-configured'); notice('The call service is not configured.', 'bad'); return; }
        failures++;
        if (!failingSince) failingSince = Date.now();
        if (await giveUpListening(token, failingSince)) return;
        await sleep(res.status === 429 ? 5000 : Math.min(30000, timers.retryMs * failures));
      } catch (err) {
        if (st.listen !== token) return;
        failures++;
        if (!failingSince) failingSince = Date.now();
        if (failures === 3) notice('Cannot reach the call service. Still trying…', 'warn');
        if (await giveUpListening(token, failingSince)) return;
        await sleep(Math.min(30000, timers.retryMs * failures));
      }
    }
  }

  // ---------- incoming invitations ----------

  async function handleListenEvent(ev) {
    if (ev.type === 'invite') return handleInviteEvent(ev);
    const call = st.call;
    if (ev.type === 'cancel' && call && call.role === 'callee' && call.id === ev.callId && call.state === 'incoming') {
      const m = ev.message;
      const good = m && P.validatePayload(m.payload).ok && m.payload.kind === 'cancel' && m.payload.callId === call.id && m.payload.audience === call.service &&
        m.payload.seq === 1 && m.proof && m.proof.publicKey === call.invite.payload.callKey && (await P.verifyEnvelope(m.payload, m.proof));
      if (good) endCall(call, 'cancelled', { notify: false });
      else log('cancel-rejected');
    } else if (ev.type === 'ended' && call && call.role === 'callee' && call.id === ev.callId && call.state === 'incoming') {
      endCall(call, ev.reason === 'timeout' ? 'timeout' : 'cancelled', { notify: false });
    }
  }

  async function sessionSignal(token, kind, callId, reason) {
    const payload = { type: 'atlas.call.signal', v: 1, audience: token.service, callId, kind, body: { reason } };
    return W.callPost(token.service, '/atlas/call/signal', { payload, proof: await signRaw(token.sk, payload), session: token.delegation }, { timeoutMs: 8000, keepalive: true, devAllowHttp: st.config.devAllowHttp });
  }

  // Call ids already rung are kept for the invitation's lifetime plus skew, in session storage, so
  // reloading the window does not make an old invitation ring again.
  const SEEN_KEY = 'atlasCallSeen';
  async function loadSeen() {
    try {
      const stored = (await chrome.storage.session.get(SEEN_KEY))[SEEN_KEY] || {};
      const now = Date.now();
      for (const [id, until] of Object.entries(stored)) if (Number.isFinite(until) && until > now) st.seen.set(id, until);
    } catch (err) { /* storage unavailable: the in-memory list still applies */ }
  }
  function rememberSeen(id, until) {
    const now = Date.now();
    st.seen.set(id, until);
    for (const [k, v] of st.seen) if (v <= now) st.seen.delete(k);
    try { chrome.storage.session.set({ [SEEN_KEY]: Object.fromEntries(st.seen) }); } catch (err) { /* ignore */ }
  }

  async function handleInviteEvent(ev) {
    const token = st.listen;
    if (!token || !st.identity) return;
    const signed = ev.invite;
    // 1. Signature, shape, signer is the named caller.
    const v = await P.verifySigned(signed);
    if (!v.ok || v.payload.type !== 'atlas.call.invite' || v.signer !== v.payload.caller.publicKey) return log('invite-dropped', 'signature-or-shape');
    const p = v.payload;
    // 2. Addressed to this service and this wallet, fresh, not seen before.
    if (p.audience !== token.service) return log('invite-dropped', 'audience');
    if (!P.inviteTimeOk(p)) return log('invite-dropped', 'time');
    if (p.callee.publicKey !== st.identity.publicKey) return log('invite-dropped', 'wrong-callee');
    if (st.seen.has(p.callId)) return log('invite-dropped', 'replay');
    rememberSeen(p.callId, Date.parse(p.expiresAt) + 90000);
    // 3. Policy: a current contact who holds the tag this wallet gave them.
    const contact = await W.getCallPolicyForCaller(p.caller.publicKey, p.tag);
    if (!contact) return log('invite-dropped', 'policy');
    const recent = (st.rings.get(p.caller.publicKey) || []).filter((t) => Date.now() - t < timers.ringRateWindowMs);
    if (recent.length >= 3) return log('invite-dropped', 'rate');
    recent.push(Date.now()); st.rings.set(p.caller.publicKey, recent);
    if (busyNow()) { sessionSignal(token, 'busy', p.callId, 'busy').catch(() => {}); return log('invite-busy'); }
    if (st.call) dismissCall();
    // 4. Ring. No microphone, no peer connection, no network address leaves this window yet.
    const call = newCall('callee', p.callId, contact.publicKey, contact.name, contact.verified, token.service);
    call.invite = signed; call.state = 'incoming'; call.peerCk = p.callKey; call.peerFps = p.media.fingerprints.slice();
    call.expiresAt = Date.parse(p.expiresAt);
    st.call = call;
    log('incoming', { from: shortKey(contact.publicKey), verified: contact.verified });
    call.timer('ring', Math.max(0, call.expiresAt - Date.now()), () => endCall(call, 'noanswer', { notify: false }));
    attention(contact.name);
    render();
  }

  function attention(name) {
    document.title = 'Incoming call from ' + name;
    try { chrome.windows.getCurrent((w) => { if (w) chrome.windows.update(w.id, { drawAttention: true }, () => void chrome.runtime.lastError); }); } catch (e) { /* not available */ }
  }

  // ---------- the call object ----------

  function newCall(role, id, contactKey, contactName, verified, service) {
    const call = {
      role, id, contactKey, contactName, verified: !!verified, service, state: 'preparing',
      invite: null, accept: null, ck: null, fps: null, cert: null, peerCk: null, peerFps: null, th: null,
      seqOut: 0, seqIn: 0, pc: null, mic: [], audioSender: null, muted: false, audioOn: false,
      offerHash: null, answerHash: null, nonces: { caller: null, callee: null },
      pollAfter: 0, abort: new AbortController(), sendChain: Promise.resolve(), candBuf: [], candSent: 0, candRecv: 0, iceQueue: [], remoteSet: false,
      peerConfirmed: false, ownConfirmed: false, endText: '', reason: null, ended: false, timerIds: {}, expiresAt: 0,
      timer(name, ms, fn) { clearTimeout(call.timerIds[name]); call.timerIds[name] = setTimeout(() => { if (!call.ended) fn(); }, ms); },
      clear(name) { clearTimeout(call.timerIds[name]); delete call.timerIds[name]; }
    };
    return call;
  }
  const live = (call) => st.call === call && !call.ended;
  const busyNow = () => !!st.call && !st.call.ended;
  function setState(call, s) { call.state = s; log('state', s); render(); }

  // ---------- outgoing calls ----------

  async function placeCall(contactKey) {
    if (busyNow() || !st.identity) return;
    const contact = st.contacts.find((c) => c.publicKey === contactKey);
    const card = await W.getCallCardFor(contactKey);
    if (!contact || !card) { notice('You do not have permission to call this contact.', 'bad'); st.selected = null; return render(); }
    if (st.call) dismissCall();
    const call = newCall('caller', P.randomId(16), contactKey, contact.name, contact.verified, card.service);
    st.call = call; st.selected = null;
    setState(call, 'preparing');
    let ck = null;
    try {
      // The click that started this is the permission to use the microphone.
      await acquireMic(call);
      if (!live(call)) return;
      await prepareKeysAndCertificate(call);
      ck = call.ck;
      const now = Date.now();
      const payload = base('atlas.call.invite', card.service, {
        nonce: P.randomId(16), callId: call.id, tag: card.tag, expiresAt: new Date(now + timers.inviteMs).toISOString(),
        caller: { kind: 'wallet', publicKey: st.identity.publicKey }, callee: { publicKey: contactKey },
        callKey: call.ck.pub, media: { kind: 'audio', fingerprints: call.fps.slice() }
      });
      setState(call, 'inviting');
      const proof = await W.signCallPayload(payload);
      if (!live(call)) return;
      call.invite = { payload, proof };
      call.nonces.caller = payload.nonce;
      // Not tied to the call's abort signal: if the person hangs up while this is in flight, the
      // invitation may already be queued and has to be cancelled once the answer is known.
      const res = await W.callPost(card.service, '/atlas/call/invite', { tag: card.tag, invite: call.invite }, { timeoutMs: 15000 });
      if (!live(call)) { if (res.status === 202) cancelLate(card.service, call.id, ck); return; }
      if (res.status === 202) {
        setState(call, 'ringing');
        call.timer('ring', timers.ringMs, () => endCall(call, 'noanswer', { notify: true }));
        pollLoop(call);
        return;
      }
      const code = res.json && res.json.code;
      log('invite-refused', code || String(res.status));
      if (code === 'stale-request') return endCall(call, 'error', { text: 'Your computer’s clock is out of step with the call service. Check the date and time.' });
      if (code === 'rate-limited') return endCall(call, 'error', { text: 'Too many call attempts. Try again in a minute.' });
      endCall(call, code === 'unavailable' ? 'unavailable' : 'error');
    } catch (err) {
      if (!live(call)) return;
      log('place-failed', String(err && err.name));
      endCall(call, err && err.name === 'NotAllowedError' ? 'mic-denied' : (err && err.code === 'network' ? 'unavailable' : 'error'));
    }
  }

  // A hang-up during "inviting": the service accepted the invitation after the wallet stopped waiting.
  async function cancelLate(service, callId, ck) {
    try {
      const payload = { type: 'atlas.call.signal', v: 1, audience: service, callId, kind: 'cancel', body: {}, seq: 1 };
      await W.callPost(service, '/atlas/call/signal', { payload, proof: await signRaw(ck, payload) }, { timeoutMs: 8000, keepalive: true, devAllowHttp: st.config.devAllowHttp });
    } catch (err) { /* the invitation expires on its own */ }
  }

  async function acquireMic(call) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    call.mic.push(...stream.getAudioTracks());
    call.micStream = stream;
    call.micRequests = (call.micRequests || 0) + 1;
    log('microphone-allowed');
    return stream.getAudioTracks()[0];
  }

  async function prepareKeysAndCertificate(call) {
    call.ck = await newKeyPair();
    call.cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    const fp = call.cert.getFingerprints().filter((f) => f.algorithm.toLowerCase() === 'sha-256');
    if (!fp.length) throw new Error('No certificate fingerprint');
    call.fps = fp.map((f) => P.normalizeFingerprint(f.algorithm, f.value));
  }

  // ---------- answering ----------

  async function answerCall() {
    const call = st.call;
    if (!call || call.role !== 'callee' || call.state !== 'incoming') return;
    const token = st.listen;
    call.clear('ring');
    setState(call, 'accepting');
    try {
      await acquireMic(call);
      if (!live(call)) return;
      await prepareKeysAndCertificate(call);
      const invitePayload = call.invite.payload;
      const calleeNonce = P.randomId(16);
      const payload = { type: 'atlas.call.signal', v: 1, audience: call.service, callId: call.id, kind: 'accept', body: { inviteHash: await P.payloadHash(invitePayload), calleeNonce, callKey: call.ck.pub, fingerprints: call.fps.slice() } };
      const proof = await W.signCallPayload(payload);
      if (!live(call)) return;
      call.accept = { payload, proof };
      call.th = await P.transcriptHash(invitePayload, payload);
      call.nonces = { caller: invitePayload.nonce, callee: calleeNonce };
      const res = await W.callPost(call.service, '/atlas/call/signal', call.accept, { signal: call.abort.signal, timeoutMs: 15000 });
      if (!live(call)) return;
      if (res.status !== 202) return endCall(call, 'unavailable', { notify: false });
      setState(call, 'await-offer');
      call.timer('offer', timers.acceptToOfferMs, () => endCall(call, 'timeout', { notify: true }));
      pollLoop(call);
    } catch (err) {
      if (!live(call)) return;
      log('answer-failed', String(err && err.name));
      if (token && token.sk) sessionSignal(token, 'decline', call.id, 'declined').catch(() => {});
      endCall(call, err && err.name === 'NotAllowedError' ? 'mic-denied' : 'error', { notify: false });
    }
  }

  function declineCall() {
    const call = st.call;
    if (!call || call.role !== 'callee' || call.state !== 'incoming') return;
    const token = st.listen;
    if (token && token.sk) sessionSignal(token, 'decline', call.id, 'declined').catch(() => {});
    endCall(call, 'declined', { notify: false, text: 'Call declined.' });
  }

  // ---------- sending signed messages ----------

  // Sends are serialized so sequence numbers are used in order. `onBuilt(payload)` runs after
  // the message is built and signed and before it is sent (used to record offer and answer hashes).
  function sendSignal(call, kind, body, onBuilt) {
    const ck = call.ck;
    const final = kind === 'end' || kind === 'cancel';
    const job = call.sendChain.then(async () => {
      if (call.ended && !final) return false;
      const payload = { type: 'atlas.call.signal', v: 1, audience: call.service, callId: call.id, kind, body };
      payload.seq = ++call.seqOut;
      if (call.th) payload.th = call.th;
      const msg = { payload, proof: await signRaw(ck, payload) };
      if (onBuilt) await onBuilt(payload);
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await W.callPost(call.service, '/atlas/call/signal', msg, { signal: final ? undefined : call.abort.signal, timeoutMs: 8000, keepalive: final, devAllowHttp: st.config.devAllowHttp });
          if (res.status === 202 || (attempt > 1 && res.status === 404)) return true;
          return false;
        } catch (err) {
          if (call.ended && !final) return false;
          await sleep(300 * attempt);
        }
      }
      return false;
    });
    call.sendChain = job.catch(() => false);
    return job;
  }

  // ---------- polling ----------

  async function pollLoop(call) {
    let failures = 0;
    while (live(call)) {
      try {
        const payload = base('atlas.call.poll', call.service, { nonce: P.randomId(16), callId: call.id, after: call.pollAfter });
        const res = await W.callPost(call.service, '/atlas/call/poll', { payload, proof: await signRaw(call.ck, payload) }, { signal: call.abort.signal, timeoutMs: 40000 });
        if (!live(call)) return;
        if (res.status === 200 && res.json && Array.isArray(res.json.events)) {
          failures = 0;
          for (const e of res.json.events) {
            if (!live(call)) return;
            if (!e || !Number.isSafeInteger(e.n) || e.n < 1) { fail(call, 'unexpected-event'); return; }
            if (e.n <= call.pollAfter) { log('duplicate-event-ignored', e.n); continue; }
            call.pollAfter = e.n;
            try { await handlePollEvent(call, e); } catch (err) { log('handler-error', String(err && err.message)); fail(call, 'handler-error'); return; }
          }
          continue;
        }
        if (res.status === 404) { if (call.state === 'ringing' || call.state === 'await-offer') return endCall(call, 'unavailable'); failures += 2; }
        else failures++;
      } catch (err) {
        if (!live(call)) return;
        failures++;
      }
      if (failures >= 8) return endCall(call, 'network-lost');
      await sleep(Math.min(5000, timers.retryMs * failures));
    }
  }

  async function handlePollEvent(call, e) {
    if (e.type === 'ended') {
      // A report by the service, not a signed statement by the other wallet: shown as "not answered".
      if (['ringing', 'await-offer', 'negotiating'].includes(call.state) || e.reason === 'timeout') {
        const map = { declined: 'declined', busy: 'busy', timeout: call.state === 'ringing' ? 'noanswer' : 'timeout' };
        return endCall(call, map[e.reason] || 'unavailable', { notify: false });
      }
      return;
    }
    if (e.type !== 'signal' || !e.message) return fail(call, 'unexpected-event');
    return handlePeerMessage(call, e.message);
  }

  // ---------- verifying and acting on the other wallet's messages ----------

  function fail(call, reason) {
    if (!live(call)) return;
    log('verification-failed', reason);
    call.failReason = reason;
    endCall(call, 'verify-failed', { notify: true });
  }

  async function handlePeerMessage(call, msg) {
    // Order: size and schema, call id, audience, kind legal now, sequence, signature, transcript, content.
    const shape = msg && P.validatePayload(msg.payload);
    if (!shape || !shape.ok || msg.payload.type !== 'atlas.call.signal' || !P.validateEnvelope(msg.proof)) return fail(call, 'bad-schema');
    const p = msg.payload;
    if (p.callId !== call.id) return fail(call, 'wrong-call');
    if (p.audience !== call.service) return fail(call, 'wrong-audience');
    const legal = (LEGAL_FROM_PEER[call.role] || {})[call.state] || [];
    if (!legal.includes(p.kind)) return fail(call, 'illegal-kind:' + p.kind);

    if (p.kind === 'accept') return handleAccept(call, msg);

    if (p.seq !== call.seqIn + 1) return fail(call, 'bad-sequence');
    if (msg.proof.signerRole !== 'raw-ecdsa' || msg.proof.publicKey !== call.peerCk) return fail(call, 'wrong-signer');
    if (!(await P.verifyEnvelope(p, msg.proof))) return fail(call, 'bad-signature');
    if ('th' in p ? p.th !== call.th : p.kind !== 'end') return fail(call, 'transcript-mismatch');
    if (!live(call)) return;
    call.seqIn = p.seq;

    if (p.kind === 'end') return endCall(call, 'hangup', { notify: false, text: 'The other person ended the call.' });
    if (p.kind === 'offer') return handleOffer(call, msg);
    if (p.kind === 'answer') return handleAnswer(call, msg);
    if (p.kind === 'candidates') return handleCandidates(call, p);
    if (p.kind === 'confirm') return handleConfirm(call, p);
  }

  async function handleAccept(call, msg) {
    const p = msg.payload;
    if (call.role !== 'caller') return fail(call, 'illegal-kind:accept');
    const expectedCallee = call.invite.payload.callee.publicKey;
    if (msg.proof.publicKey !== expectedCallee || expectedCallee !== call.contactKey) return fail(call, 'accept-wrong-signer');
    if (!(await P.verifyEnvelope(p, msg.proof))) return fail(call, 'accept-bad-signature');
    if (p.body.inviteHash !== (await P.payloadHash(call.invite.payload))) return fail(call, 'accept-wrong-invite');
    if (p.body.callKey === call.ck.pub) return fail(call, 'accept-reused-call-key');
    if (!live(call)) return;
    call.clear('ring');
    call.accept = msg;
    call.peerCk = p.body.callKey;
    call.peerFps = p.body.fingerprints.slice();
    call.th = await P.transcriptHash(call.invite.payload, p);
    call.nonces.callee = p.body.calleeNonce;
    setState(call, 'negotiating');
    call.timer('answer', timers.offerToAnswerMs, () => endCall(call, 'timeout', { notify: true }));
    await buildPeerConnection(call);
    if (!live(call)) return;
    call.audioSender = call.pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    if (!live(call)) return;
    const own = P.checkSdpAgainstFingerprints(offer.sdp, call.fps);
    if (!own.ok) return fail(call, 'own-offer:' + own.reason);
    call.sdpSent = sendSignal(call, 'offer', { sdp: offer.sdp }, async (payload) => { call.offerHash = await P.payloadHash(payload); });
    call.sdpQueued = true;
    const ok = await call.sdpSent;
    if (!ok && live(call)) endCall(call, 'network-lost', { notify: false });
  }

  async function handleOffer(call, msg) {
    const p = msg.payload;
    if (call.role !== 'callee') return fail(call, 'illegal-kind:offer');
    const c = P.checkSdpAgainstFingerprints(p.body.sdp, call.peerFps);
    if (!c.ok) return fail(call, 'offer:' + c.reason);
    call.offerHash = await P.payloadHash(p);
    call.clear('offer');
    await buildPeerConnection(call);
    if (!live(call)) return;
    await call.pc.setRemoteDescription({ type: 'offer', sdp: p.body.sdp });
    const tx = call.pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
    if (!tx) return fail(call, 'offer:no-audio');
    tx.direction = 'sendrecv';
    call.audioSender = tx.sender;
    call.remoteSet = true;
    await flushRemoteCandidates(call);
    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);
    if (!live(call)) return;
    const own = P.checkSdpAgainstFingerprints(answer.sdp, call.fps);
    if (!own.ok) return fail(call, 'own-answer:' + own.reason);
    setState(call, 'connecting');
    call.timer('ice', timers.iceMs, () => endCall(call, 'connect-failed', { notify: true }));
    call.sdpSent = sendSignal(call, 'answer', { sdp: answer.sdp, offerHash: call.offerHash }, async (payload) => { call.answerHash = await P.payloadHash(payload); });
    call.sdpQueued = true;
    const ok = await call.sdpSent;
    if (!ok && live(call)) endCall(call, 'network-lost', { notify: false });
  }

  async function handleAnswer(call, msg) {
    const p = msg.payload;
    if (call.role !== 'caller') return fail(call, 'illegal-kind:answer');
    if (p.body.offerHash !== call.offerHash) return fail(call, 'answer:wrong-offer');
    const c = P.checkSdpAgainstFingerprints(p.body.sdp, call.peerFps);
    if (!c.ok) return fail(call, 'answer:' + c.reason);
    call.answerHash = await P.payloadHash(p);
    call.clear('answer');
    await call.pc.setRemoteDescription({ type: 'answer', sdp: p.body.sdp });
    call.remoteSet = true;
    await flushRemoteCandidates(call);
    setState(call, 'connecting');
    call.timer('ice', timers.iceMs, () => endCall(call, 'connect-failed', { notify: true }));
  }

  async function handleCandidates(call, p) {
    if (!call.pc) return fail(call, 'candidates:no-connection');
    call.candRecv += p.body.candidates.length;
    if (call.candRecv > P.LIMITS.candidatesPerCall) return fail(call, 'candidates:too-many');
    for (const c of p.body.candidates) {
      if (!CANDIDATE_RE.test(c.candidate)) return fail(call, 'candidates:malformed');
      if (!P.candidateAddressAllowed(c.candidate)) { log('candidate-dropped', 'address'); continue; }
      const init = { candidate: c.candidate, sdpMid: c.sdpMid == null ? undefined : c.sdpMid, sdpMLineIndex: c.sdpMLineIndex == null ? undefined : c.sdpMLineIndex };
      if (call.remoteSet) { try { await call.pc.addIceCandidate(init); } catch (err) { log('ice-add-failed', String(err && err.message)); } } else call.iceQueue.push(init);
    }
  }
  async function flushRemoteCandidates(call) {
    while (call.iceQueue.length) { const c = call.iceQueue.shift(); try { await call.pc.addIceCandidate(c); } catch (err) { log('ice-add-failed', String(err && err.message)); } }
  }

  async function handleConfirm(call, p) {
    const b = p.body;
    if (!call.offerHash || !call.answerHash) return fail(call, 'confirm:too-early');
    if (!call.peerFps.includes(b.fingerprints.local)) return fail(call, 'confirm:peer-fingerprint');
    if (!call.fps.includes(b.fingerprints.remote)) return fail(call, 'confirm:own-fingerprint');
    if (b.nonces.caller !== call.nonces.caller || b.nonces.callee !== call.nonces.callee) return fail(call, 'confirm:nonces');
    if (b.offerHash !== call.offerHash) return fail(call, 'confirm:offer');
    if (b.answerHash !== call.answerHash) return fail(call, 'confirm:answer');
    call.peerConfirmed = true;
    log('peer-confirmed');
    maybeActivate(call);
  }

  // ---------- peer connection and the checks before any audio ----------

  async function buildPeerConnection(call) {
    if (call.pc) return;
    let iceServers = [];
    try {
      const payload = base('atlas.call.ice', call.service, { nonce: P.randomId(16), callId: call.id });
      const res = await W.callPost(call.service, '/atlas/call/ice', { payload, proof: await signRaw(call.ck, payload) }, { signal: call.abort.signal, timeoutMs: 8000 });
      if (res.status === 200 && res.json) {
        // STUN and TURN servers that pass the shared checks (address, port, shape, remaining life of
        // a TURN credential). The credential goes to the browser and nowhere else: it is not kept on
        // the call, written to storage or logged, and each call asks for its own.
        const parsed = P.iceServersFromAnswer(res.json, { allowPrivate: !!st.config.devAllowHttp });
        iceServers = parsed.iceServers;
        log('ice-servers', { stun: iceServers.filter((x) => !x.credential).reduce((n, x) => n + x.urls.length, 0), turn: parsed.turn, dropped: parsed.dropped });
      }
    } catch (err) { /* host candidates only */ }
    if (!live(call)) return;
    const pc = new RTCPeerConnection({ certificates: [call.cert], iceServers });
    iceServers = null;
    call.pc = pc;
    // Why a TURN server refused or did not answer: the numeric code and the URL scheme only, so a
    // failed relay can be told apart from a missing one without the log holding an address or credential.
    pc.onicecandidateerror = (e) => {
      if (e && typeof e.url === 'string' && /^turns?:/i.test(e.url)) log('turn-error', { code: e.errorCode, scheme: e.url.slice(0, e.url.indexOf(':')).toLowerCase() });
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate || !live(call)) { if (!e.candidate && live(call)) flushCandidates(call, true); return; }
      if (!P.candidateAddressAllowed(e.candidate.candidate)) { log('own-candidate-skipped'); return; }
      call.candBuf.push({ candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
      if (call.candBuf.length >= P.LIMITS.candidatesPerMessage) flushCandidates(call, false);
      else call.timer('cand', timers.candidateBatchMs, () => flushCandidates(call, false));
    };
    pc.onconnectionstatechange = () => {
      log('pc-state', pc.connectionState);
      if (!live(call)) return;
      if (pc.connectionState === 'connected') onTransportConnected(call);
      if (pc.connectionState === 'failed') endCall(call, 'connect-failed', { notify: true });
      if (pc.connectionState === 'disconnected' && call.state === 'active') call.timer('disc', 15000, () => { if (pc.connectionState !== 'connected') endCall(call, 'network-lost', { notify: true }); });
    };
    pc.ontrack = (e) => { call.remoteStream = e.streams[0] || new MediaStream([e.track]); };
  }

  function flushCandidates(call, end) {
    if (!live(call) || (!call.candBuf.length && !end)) return;
    // Candidates are sent after the SDP message so sequence numbers stay in order.
    if (!call.sdpQueued) { call.timer('cand', timers.candidateBatchMs, () => flushCandidates(call, end)); return; }
    let batch = call.candBuf.splice(0, P.LIMITS.candidatesPerMessage);
    const room = P.LIMITS.candidatesPerCall - call.candSent;
    if (batch.length > room) batch = batch.slice(0, Math.max(0, room));
    if (!batch.length) return;
    call.candSent += batch.length;
    sendSignal(call, 'candidates', { candidates: batch, end: !!end && !call.candBuf.length });
    if (call.candBuf.length) call.timer('cand', timers.candidateBatchMs, () => flushCandidates(call, false));
  }

  async function remoteCertificateSources(call) {
    const out = { api: [], stats: [] };
    const receiver = call.pc.getReceivers().find((r) => r.track && r.track.kind === 'audio');
    const transport = receiver && receiver.transport;
    if (transport && typeof transport.getRemoteCertificates === 'function') {
      // The list can be empty for a moment after "connected"; an empty list means "not known yet".
      for (let i = 0; i < 30 && live(call); i++) {
        const certs = transport.getRemoteCertificates();
        if (certs.length) { out.api = await Promise.all(certs.map(certHash)); break; }
        await sleep(100);
      }
    }
    try {
      const report = await call.pc.getStats();
      const byId = {}; report.forEach((s) => { byId[s.id] = s; });
      let tr = null; report.forEach((s) => { if (s.type === 'transport') tr = s; });
      const c = tr && byId[tr.remoteCertificateId];
      if (c && c.base64Certificate) out.stats = [await certHash(Uint8Array.from(atob(c.base64Certificate), (ch) => ch.charCodeAt(0)))];
    } catch (err) { /* the other source may still be enough */ }
    return out;
  }

  async function onTransportConnected(call) {
    if (call.checkedTransport || !live(call)) return;
    call.checkedTransport = true;
    call.clear('ice');
    setState(call, 'verifying');
    call.timer('confirm', timers.confirmMs, () => fail(call, 'confirm-timeout'));
    const sources = await remoteCertificateSources(call);
    if (!live(call)) return;
    const match = P.remoteCertMatches([sources.api, sources.stats], call.peerFps);
    hook.lastCertCheck = { ok: match.ok, reason: match.reason || null, api: sources.api.length, stats: sources.stats.length };
    log('remote-certificate-check', hook.lastCertCheck);
    if (!match.ok) return fail(call, match.reason);
    call.remoteCertVerified = true;
    // The signed fingerprint that the peer's DTLS certificate actually produced.
    const matchedHash = (sources.api[0] || sources.stats[0]).toUpperCase();
    const remoteSigned = call.peerFps.find((f) => f.slice(8) === matchedHash);
    if (!remoteSigned) return fail(call, 'remote-cert-mismatch');
    try { await call.sdpSent; } catch (err) { /* handled where it was sent */ }
    if (!live(call)) return;
    const body = {
      fingerprints: { local: call.fps[0], remote: remoteSigned },
      nonces: { caller: call.nonces.caller, callee: call.nonces.callee },
      offerHash: call.offerHash, answerHash: call.answerHash
    };
    const ok = await sendSignal(call, 'confirm', body);
    if (!live(call)) return;
    if (!ok) return endCall(call, 'network-lost', { notify: false });
    call.ownConfirmed = true;
    maybeActivate(call);
  }

  // Audio is attached and played only when this side passed the certificate check and the
  // other side's signed confirmation has been verified.
  async function maybeActivate(call) {
    if (!live(call) || call.audioOn || !call.ownConfirmed || !call.peerConfirmed || !call.remoteCertVerified) return;
    call.clear('confirm');
    call.audioOn = true;
    const track = call.mic.find((t) => t.readyState === 'live');
    if (track && !call.muted && call.audioSender) { track.enabled = true; await call.audioSender.replaceTrack(track); }
    if (!live(call)) return;
    if (call.remoteStream) { const a = $('remoteAudio'); a.srcObject = call.remoteStream; a.play().catch(() => {}); }
    setState(call, 'active');
    call.activeAt = Date.now();
    startSilenceWatch(call);
    log('audio-enabled');
  }

  function startSilenceWatch(call) {
    let lastBytes = -1, lastChange = Date.now();
    call.silenceTimer = setInterval(async () => {
      if (!live(call) || !call.pc) return clearInterval(call.silenceTimer);
      let bytes = 0;
      try { (await call.pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes = s.bytesReceived; }); } catch (e) { return; }
      if (bytes !== lastBytes) { lastBytes = bytes; lastChange = Date.now(); if (call.silentWarned) { call.silentWarned = false; notice(''); } return; }
      const quiet = Date.now() - lastChange;
      if (quiet >= timers.silentEndMs) endCall(call, 'network-lost', { notify: true });
      else if (quiet >= timers.silentWarnMs && !call.silentWarned) { call.silentWarned = true; notice('No audio is arriving. The connection may be lost.', 'warn'); }
    }, Math.min(5000, Math.max(200, timers.silentWarnMs / 3)));
  }

  // ---------- mute ----------

  async function toggleMute() {
    const call = st.call;
    if (!call || call.state !== 'active') return;
    if (!call.muted) {
      // Release the capture device, not just silence the track.
      for (const t of call.mic) { try { t.stop(); } catch (e) { /* already stopped */ } }
      try { await call.audioSender.replaceTrack(null); } catch (err) { log('replace-null-failed'); }
      call.muted = true;
      log('muted');
    } else {
      try {
        const track = await acquireMic(call);
        if (!live(call)) { track.stop(); return; }
        track.enabled = true;
        await call.audioSender.replaceTrack(track);
        call.muted = false;
        log('unmuted');
      } catch (err) { notice('The microphone could not be turned on again.', 'bad'); }
    }
    render();
  }

  // ---------- ending and cleanup ----------

  // Releases everything synchronously (microphone, connection, timers, keys), then tells the other
  // side with a signed end or cancel, best effort.
  function endCall(call, reason, opts) {
    opts = opts || {};
    if (!call || call.ended) return;
    call.ended = true;
    call.reason = reason;
    call.endText = opts.text || REASON_TEXT[reason] || 'Call ended.';
    for (const k of Object.keys(call.timerIds)) clearTimeout(call.timerIds[k]);
    clearInterval(call.silenceTimer);
    call.abort.abort();
    const trackStates = [];
    for (const t of call.mic) { try { t.stop(); } catch (e) { /* ignore */ } trackStates.push(t.readyState); }
    if (call.micStream) for (const t of call.micStream.getTracks()) { try { t.stop(); } catch (e) { /* ignore */ } }
    let senders = null;
    if (call.pc) {
      try { senders = call.pc.getSenders().map((s) => (s.track ? s.track.readyState : null)); call.pc.getSenders().forEach((s) => { try { s.replaceTrack(null); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
      try { call.pc.close(); } catch (e) { /* ignore */ }
    }
    const a = $('remoteAudio'); a.srcObject = null;
    const info = {
      reason, at: Date.now(), role: call.role, micTrackStates: trackStates, senderTracks: senders, liveTracksAfter: call.mic.filter((t) => t.readyState === 'live').length,
      pcState: call.pc ? call.pc.connectionState : null, micRequests: call.micRequests || 0, failReason: call.failReason || null, audioWasOn: call.audioOn
    };
    hook.lastTeardown = info; hook.history.push(info);
    log('call-ended', { reason, failReason: call.failReason || null });
    // A signed cancel (before the other side accepted) or end (after) goes out best effort. The
    // call key is captured by the send and the call's own reference to it is dropped at once.
    const wasRinging = call.state === 'ringing';
    const accepted = !!call.accept;
    call.state = 'ended';
    if (opts.notify !== false && call.ck && call.invite && ((call.role === 'caller' && (wasRinging || accepted)) || (call.role === 'callee' && accepted))) {
      const kind = call.role === 'caller' && !accepted ? 'cancel' : 'end';
      sendSignal(call, kind, kind === 'end' ? { reason: P.END_REASONS.includes(reason) ? reason : 'error' } : {}).catch(() => {});
    }
    call.ck = null; call.peerCk = null;
    call.cert = null; call.pc = null; call.audioSender = null; call.remoteStream = null; call.iceQueue.length = 0; call.candBuf.length = 0;
    document.title = 'Domain Atlas Calls';
    render();
    publishStatus();
    if (call.keepOpen !== true) {
      call.dismissTimer = setTimeout(() => { if (st.call === call) dismissCall(); }, 20000);
    }
  }

  function dismissCall() {
    if (st.call && st.call.ended) { clearTimeout(st.call.dismissTimer); st.call = null; }
    st.selected = null;
    render();
  }

  async function shutdownAll(reason) {
    if (st.call) endCall(st.call, reason, { notify: true });
    st.availability = 'dnd';
    await stopListening(true);
    log('shutdown', reason);
  }

  // ---------- user actions ----------

  const trusted = (e) => !!(e && e.isTrusted);
  $('btnAvailable').addEventListener('click', (e) => { if (trusted(e)) goAvailable(); });
  $('btnDnd').addEventListener('click', (e) => { if (trusted(e)) goDnd('user'); });
  $('btnStart').addEventListener('click', (e) => { if (trusted(e) && st.selected) placeCall(st.selected); });
  $('btnAnswer').addEventListener('click', (e) => { if (trusted(e)) answerCall(); });
  $('btnDecline').addEventListener('click', (e) => { if (trusted(e)) declineCall(); });
  $('btnMute').addEventListener('click', (e) => { if (trusted(e)) toggleMute(); });
  $('btnHangup').addEventListener('click', (e) => { if (trusted(e) && st.call) endCall(st.call, st.call.state === 'ringing' || st.call.state === 'inviting' ? 'cancelled' : 'hangup', { notify: true, text: st.call.state === 'ringing' ? 'Call cancelled.' : 'Call ended.' }); });
  $('btnDismiss').addEventListener('click', (e) => { if (trusted(e)) { st.call ? dismissCall() : (st.selected = null, render()); } });

  // ---------- messages from the messaging window ----------

  // Accepted only from this extension's own pages. A content script running inside a web page has
  // that page's URL as its sender URL, so it is refused.
  function trustedSender(sender) {
    return !!sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'atlas-call-ui') return;
    if (!trustedSender(sender)) { sendResponse({ ok: false, error: 'refused' }); return; }
    if (message.action === 'dial' && typeof message.key === 'string') {
      // Selecting a contact shows the call screen; the microphone is only requested by the Call button here.
      refreshWallet().then(() => { selectContact(message.key); sendResponse({ ok: true }); });
      return true;
    }
    if (message.action === 'ping') { sendResponse({ ok: true, availability: st.availability, state: st.call ? st.call.state : 'idle' }); return; }
  });
  hook.trustedSender = trustedSender;

  // ---------- wallet lock, identity changes, window close ----------

  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'session' && 'atlasUnlockedIdentity' in changes) || (area === 'local' && ('atlasIdentityMode' in changes || 'atlasIdentity' in changes || 'atlasWebAuthnIdentity' in changes || 'atlasCallState' in changes))) {
      refreshWallet();
    }
  });

  function closing() {
    // pagehide: free the microphone and connection now; tell the other side with a keepalive request.
    if (st.call) endCall(st.call, 'window-closed', { notify: true });
    const token = st.listen;
    if (token) { st.listen = null; token.abort.abort(); if (token.sk) { const payload = base('atlas.call.listen', token.service, { nonce: P.randomId(16), ack: [], stop: true }); signRaw(token.sk, payload).then((proof) => W.callPost(token.service, '/atlas/call/listen', { payload, proof, session: token.delegation }, { keepalive: true, timeoutMs: 3000, devAllowHttp: st.config.devAllowHttp })).catch(() => {}); } }
    try { chrome.storage.session.set({ atlasCallStatus: null, atlasCallActive: 0 }); } catch (e) { /* ignore */ }
  }
  window.addEventListener('pagehide', closing);
  window.addEventListener('error', () => { if (st.call) endCall(st.call, 'error', { notify: true }); });
  window.addEventListener('unhandledrejection', () => { if (st.call) endCall(st.call, 'error', { notify: true }); });

  // ---------- test hooks (read-only views; the page is unreachable from web pages) ----------

  hook.snapshot = () => ({
    availability: st.availability, listening: !!st.listen, call: st.call ? { state: st.call.state, role: st.call.role, reason: st.call.reason, failReason: st.call.failReason || null, muted: st.call.muted, audioOn: st.call.audioOn, contactKey: st.call.contactKey, verified: st.call.verified, id: st.call.id, micRequests: st.call.micRequests || 0 } : null,
    selected: st.selected, locked: !st.identity, config: st.config, lockHeld: st.lockHeld
  });
  hook.refresh = refreshWallet;
  hook.getCall = () => st.call;
  hook.throwForTest = () => { setTimeout(() => { throw new Error('forced error'); }, 0); };

  // ---------- start ----------

  async function start() {
    // One calling window at a time: the lock is held for the life of this page.
    if (navigator.locks) {
      await new Promise((resolve) => {
        navigator.locks.request('atlas-call-window', { ifAvailable: true }, (lock) => {
          st.started = true;
          st.lockHeld = !!lock;
          resolve();
          return lock ? new Promise(() => {}) : undefined;
        });
      });
    } else { st.started = true; st.lockHeld = true; }
    if (!st.lockHeld) { render(); return; }
    startStatusTimer();
    await loadSeen();
    await refreshWallet();
    const dial = /(?:^|[#&])dial=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (dial && st.identity) selectContact(dial[1]);
    log('ready');
  }
  start().catch((err) => log('start-failed', String(err && err.message)));
})();
