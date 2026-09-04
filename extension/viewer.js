// Domain Atlas — viewer (v1.0)
// Fetches a manifest, resolves a world within it, and renders that world's
// scene isometrically on a plain <canvas> — no external rendering library.
// A "world" portal swaps to another entry in the SAME cached manifest with
// no re-fetch (proving the spec's "no network round-trip" claim for
// same-origin portals); a "domain" portal fetches a different origin's
// manifest entirely. (A production client would prefer WebXR + glTF per
// the spec; this renderer exists so the prototype has zero dependencies.)

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const scene3dCanvas = document.getElementById('scene3d');
const scene3dHint = document.getElementById('scene3dHint');
const hintEl = document.getElementById('hint');
const placeLabel = document.getElementById('placeLabel');
const statusEl = document.getElementById('status');
const closeBtn = document.getElementById('closeBtn');
const sceneLoadProgressEl = document.getElementById('sceneLoadProgress');
const sceneLoadProgressCountEl = document.getElementById('sceneLoadProgressCount');
const sceneLoadProgressFillEl = document.getElementById('sceneLoadProgressFill');
const sceneLoadProgressSpeedEl = document.getElementById('sceneLoadProgressSpeed');

// Scene asset download progress (#36) — driven by gltf-mini.js's
// loadScene() via the onLoadProgress option passed into MiniGLTF.init
// below, counting UNIQUE model urls loaded so far vs the total for this
// scene (see that file's own comment on why unique-url, not per-placed-
// object). total===0 means either a scene with no GLB objects at all (a
// bare procedural room) or the progress hook simply wasn't used — either
// way there's nothing meaningful to show, so the bar stays hidden rather
// than flashing a 0/0.
//
// Task #74 adds a third, optional argument: {loadedBytes, totalBytes,
// speedBps, etaSeconds}, sent alongside (not instead of) the existing
// count — gltf-mini.js also still calls this with just (loaded, total)
// once a model finishes, so byteInfo can be undefined on any given call.
// formatBytes() (below, already used by the cache management panel) and
// formatDuration() turn the raw numbers into the "1.4 MB/s · ~6s left"
// line; either half is omitted on its own when its input is null —
// totalBytes/etaSeconds legitimately go unknown when a server didn't send
// Content-Length (see gltf-mini.js's fetchModelBuffer), and that's shown
// honestly as "speed only," never a frozen or fabricated estimate.
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return Math.ceil(seconds) + 's';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m + 'm ' + s + 's';
}
function updateSceneLoadProgress(loaded, total, byteInfo) {
  if (!sceneLoadProgressEl) return;
  if (!total) { sceneLoadProgressEl.classList.remove('active'); return; }
  sceneLoadProgressEl.classList.add('active');
  if (sceneLoadProgressCountEl) sceneLoadProgressCountEl.textContent = loaded + ' / ' + total;
  if (sceneLoadProgressFillEl) sceneLoadProgressFillEl.style.width = Math.round((loaded / total) * 100) + '%';
  if (sceneLoadProgressSpeedEl && byteInfo) {
    const parts = [];
    if (byteInfo.speedBps && byteInfo.speedBps > 1) {
      parts.push(formatBytes(byteInfo.speedBps) + '/s');
      const etaText = byteInfo.totalBytes != null ? formatDuration(byteInfo.etaSeconds) : null;
      parts.push(etaText ? '~' + etaText + ' left' : 'size unknown');
    }
    sceneLoadProgressSpeedEl.textContent = parts.join(' · ');
  }
}
function hideSceneLoadProgress() {
  if (sceneLoadProgressEl) sceneLoadProgressEl.classList.remove('active');
  if (sceneLoadProgressSpeedEl) sceneLoadProgressSpeedEl.textContent = '';
}

// ---------- stale extension context ----------
// Reloading the unpacked extension (chrome://extensions -> Reload, or an
// auto-update) invalidates every chrome.* binding any ALREADY-OPEN page
// still holds — this overlay iframe included. Nothing short of reloading
// this page can restore it, so every chrome.storage/chrome.runtime call
// wallet.js makes from that point on throws the same
// "Extension context invalidated" error. Without this handler that surfaces
// as an opaque uncaught-promise-rejection in the console (e.g. from the
// unawaited refreshIdentityDisplay() call at the bottom of this file,
// which runs on load and touches chrome.storage right away); with it, the
// user gets a plain-language, actionable status message instead.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = (reason && reason.message) || (typeof reason === 'string' ? reason : '');
  if (!message.includes('Extension context invalidated')) return;
  event.preventDefault();
  if (statusEl) statusEl.textContent = 'This page lost its connection to the extension (it was reloaded) — refresh the page to reconnect.';
  console.warn('[Domain Atlas] Extension context invalidated — refresh this page to reconnect.');
});

// Which world is "in front" right now can use either renderer: the
// original flat-canvas isometric one (below), or gltf-mini.js's small
// hand-rolled WebGL renderer for worlds that declare "gltf-mini-v1". Only
// one is ever active — entering a world tears down whichever was running
// for the previous one. See enterWorld().
let active3D = null;

// ---------- presence (multiplayer, #66 + polling fallback #68) ----------
// A live connection to presence-server telling this domain+world "room"
// who else is here and where. Only meaningful for 3D (gltf-mini-v1)
// worlds, since that's the only renderer with a visible character at all
// (#33) — see enterWorld() for where this connects/disconnects. Its own
// small lifecycle, deliberately separate from active3D's: a presence
// server that's down, slow, or unreachable must never block or break
// entering a world — multiplayer is an enhancement layered on top of
// single-player, not a requirement of it (see the try/catch/'error'
// listener below, and pollPresence()'s own silent give-up).
//
// Two transports, one visible API (connectPresence/disconnectPresence):
// WebSocket is tried first (real-time, what presence-server's /presence
// endpoint is built for). If that fails outright — most commonly because
// the actual deployment target can't run a persistent WebSocket process at
// all, e.g. plain cPanel/Apache+PHP shared hosting (see presence-server/
// server.js's own header comment on why, and issuer-php/README.txt for
// the same constraint already hit once for the issuer) — this falls back
// to plain HTTP polling against the SAME server's /presence/poll/* routes,
// which share the exact same rooms as the WebSocket side. Either way,
// active3D.upsertRemotePlayer()/removeRemotePlayer() is all either path
// ever calls; gltf-mini.js's rendering/interpolation has no idea which
// transport is in use, and doesn't need to.
//
// The presence endpoint is now a per-domain, manifest-declared thing —
// enterWorld() passes manifest.presence through to connectPresence() as
// `presenceBase`. This is NOT part of SPEC.md; it's a plain, optional,
// implementation-only convenience field the same way `presence-server`
// itself isn't part of the formal protocol. A manifest with no `presence`
// field (every existing local demo domain) falls back to
// PRESENCE_DEFAULT_BASE below, so nothing about local dev changes.
//
// Given a base like "https://example.com" or "http://localhost:8004",
// presenceWsUrlFor() derives the WebSocket URL by swapping the scheme
// (http->ws, https->wss) and appending /presence; the HTTP polling base
// is the base as given, with /presence/poll/* appended per call. A domain
// whose presence lives entirely on plain PHP/Apache (see presence-php/,
// task #68) simply has no working WebSocket route at that derived
// wss://.../presence URL — the connection attempt fails fast, and the
// existing WS-then-poll fallback logic (unchanged, added for task #68)
// picks up the SAME base for polling automatically. No separate
// "transport capability" flag needed in the manifest: a domain either
// answers the WS upgrade or it doesn't, and the client already handles
// both outcomes.
const PRESENCE_DEFAULT_BASE = 'http://localhost:8004';
function presenceWsUrlFor(base) {
  return base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/presence';
}
const PRESENCE_MOVE_INTERVAL_MS = 150; // WebSocket: how often a move is sent
const PRESENCE_POLL_INTERVAL_MS = 2000; // polling fallback: one sync (move + roster fetch) per tick — server's staleness timeout is generous enough to tolerate a couple of missed ticks
const PRESENCE_WS_CONNECT_TIMEOUT_MS = 2500; // how long to let a WebSocket attempt hang before giving up on it and trying polling instead

let presenceSocket = null;
let presenceMoveTimer = null;
// A polling attempt has no server-assigned id to compare identity against
// until its join fetch actually resolves — unlike the WebSocket path,
// where `socket` itself is that identity from the very first line of
// connectPresence(). presencePollToken plays the same role for polling:
// set synchronously the moment pollPresence() is called, so a join
// response that comes back after a NEWER attempt has already taken over
// (a fast enterWorld() -> enterWorld() -> enterWorld(), or a WS attempt
// that succeeded in the meantime) can recognize it's stale and back out,
// instead of resurrecting presence for a world already left behind.
let presencePollToken = null;
let presencePollId = null; // server-assigned id, set once join resolves and this attempt is still current
let presencePollTimer = null;
let presencePollHttpBase = null; // the base this poll session's id belongs to — needed by disconnectPresence()'s leave beacon

// This visitor's own identity as announced to the current presence room
// (Friends, #67) — null/null for an anonymous visitor with no unlocked
// wallet, same as what actually gets sent in the join message. Needed by
// the "Add friend" action so it can announce who's asking, without having
// to re-look-up the wallet identity at click time (the identity might get
// locked between joining a room and clicking Add friend on someone in it —
// this keeps the signal consistent with whatever was actually announced).
let presenceOwnPublicKey = null;
let presenceOwnName = null;

// Live roster metadata (Friends, #67): id -> {name, publicKey}, separate
// from gltf-mini.js's remotePlayers (render-only — position/yaw for
// interpolation, no name or publicKey at all). Used by the Friends screen
// to show "who's here right now" with an Add-friend action, and to
// recognize an incoming signal's `from` id as someone actually present.
let presenceRosterMeta = new Map();
function notePresenceRosterMeta(id, name, publicKey) {
  presenceRosterMeta.set(id, { name: name || 'Visitor', publicKey: publicKey || null });
}
function clearPresenceRosterMeta() { presenceRosterMeta = new Map(); }

// Friend-request state (Friends, #67), scoped to the CURRENT presence
// connection — same "live through presence" design as the rest of this
// feature: a request only makes sense while both parties are simultaneously
// in the room, so none of this survives disconnectPresence() (see there).
// presencePendingIncoming: requests aimed at THIS visitor, waiting on an
// Accept/Decline click, {from, publicKey, name, receivedAt}[].
// presencePendingSentRequests: ids THIS visitor has already sent a
// friend-request to, so the "Add friend" button can show "Request sent"
// instead of letting a second request pile up.
let presencePendingIncoming = [];
let presencePendingSentRequests = new Set();

function presenceIsConnected() {
  return !!(presenceSocket && presenceSocket.readyState === WebSocket.OPEN) || !!presencePollId;
}

// True once a domain+world's presence backend has relayed a signal back at
// this visitor — routed to the Friends screen's "Friend requests" /
// "Add friend" state, and to the top Social tab's badge count. See
// ALLOWED_SIGNAL_KINDS in presence-server.js/store.php for the closed
// vocabulary this handles; anything else is simply not sent by either
// backend, so there's nothing else to branch on here.
function handleIncomingSignal(msg) {
  if (!msg || typeof msg.from !== 'string') return;
  if (msg.kind === 'friend-request') {
    if (presencePendingIncoming.some((r) => r.from === msg.from)) return; // already have one from them, don't duplicate
    presencePendingIncoming.push({ from: msg.from, publicKey: msg.publicKey || null, name: msg.name || 'Visitor', receivedAt: Date.now() });
  } else if (msg.kind === 'friend-request-accepted') {
    presencePendingSentRequests.delete(msg.from);
    if (msg.publicKey) {
      // Save using the identity THEY just confirmed in this reply, not
      // whatever roster snapshot was on screen when the request was sent —
      // that snapshot could in principle be stale by the time they answer.
      AtlasWallet.addFriend(msg.publicKey, msg.name || 'Friend').then(() => { if (socialFriendsTabActive()) refreshFriendsDisplay(); }).catch(() => {});
    }
  } else if (msg.kind === 'friend-request-declined') {
    presencePendingSentRequests.delete(msg.from);
  }
  updateSocialBadge();
  if (socialFriendsTabActive()) refreshFriendsDisplay();
}

// Sends a friend-request-family signal to another member of the CURRENT
// room, over whichever transport is actually connected right now — a
// live WS send if one's open, otherwise the polling relay route. No-op if
// neither transport is connected (nothing to relay through).
function sendSignal(toId, kind, publicKey, name) {
  if (presenceSocket && presenceSocket.readyState === WebSocket.OPEN) {
    presenceSocket.send(JSON.stringify({ type: 'signal', to: toId, kind, publicKey, name }));
    return;
  }
  if (presencePollId && presencePollHttpBase) {
    fetch(presencePollHttpBase + '/presence/poll/signal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: presencePollId, to: toId, kind, publicKey, name })
    }).catch(() => {});
  }
}

// Read-only "who's in this world right now" for a domain+world the caller
// ISN'T necessarily present in (Favorites, #61) — a favorited domain the
// visitor hasn't opened this session. Never throws; an unreachable or
// misconfigured presence backend just reads as "nobody's status
// available," same "presence is a pure enhancement, never an error"
// posture connectPresence/pollPresence already have.
async function fetchPresenceStatus(domain, worldId, presenceBase) {
  const base = presenceBase || PRESENCE_DEFAULT_BASE;
  try {
    const res = await fetch(base + '/presence/status?domain=' + encodeURIComponent(domain) + '&world=' + encodeURIComponent(worldId));
    if (!res.ok) return { count: 0, roster: [] };
    const body = await res.json();
    return { count: body.count || 0, roster: body.roster || [] };
  } catch (err) {
    return { count: 0, roster: [] };
  }
}

function currentLocalPose() {
  if (!active3D) return null;
  const pos = active3D.camera.pos;
  // y is FLOOR-relative (getCharacterFloorY()), not pos[1] (the camera's
  // own eye height, ~1.6 units off the ground while standing) — a remote
  // client places the received y directly as where a character's feet
  // stand, so broadcasting eye height renders everyone else hovering
  // roughly at head height instead of standing on the floor. See
  // getCharacterFloorY()'s own comment in gltf-mini.js for the full story.
  return { x: pos[0], y: active3D.getCharacterFloorY(), z: pos[2], yaw: active3D.getCharacterYaw() };
}

// Reconciles a polling roster response (the full "everyone else in the
// room right now" list) against what's currently rendered — upserts
// anyone present, removes anyone that dropped out since the last poll.
// This is polling's substitute for the WebSocket side's individual
// joined/moved/left push events: no persistent connection to push down,
// so every tick just re-syncs the whole picture instead.
let presencePollKnownIds = new Set();
function reconcilePollRoster(roster) {
  if (!active3D) return;
  const seen = new Set();
  (roster || []).forEach((m) => { active3D.upsertRemotePlayer(m.id, m); seen.add(m.id); });
  presencePollKnownIds.forEach((id) => { if (!seen.has(id)) active3D.removeRemotePlayer(id); });
  presencePollKnownIds = seen;
}

function disconnectPresence() {
  if (presenceMoveTimer) { clearInterval(presenceMoveTimer); presenceMoveTimer = null; }
  if (presenceSocket) {
    const socket = presenceSocket;
    presenceSocket = null;
    try { socket.close(); } catch (err) {}
  }
  presencePollToken = null; // invalidates any in-flight join or running interval from this point on, see pollPresence()
  if (presencePollTimer) { clearInterval(presencePollTimer); presencePollTimer = null; }
  if (presencePollId) {
    const id = presencePollId;
    const base = presencePollHttpBase;
    presencePollId = null;
    presencePollHttpBase = null;
    presencePollKnownIds = new Set();
    // Best-effort — a closed tab won't reach this, that's what the
    // server's staleness sweep (task #68) is for. A clean world switch or
    // overlay close reaches it fine, so it's worth sending when possible.
    fetch(base + '/presence/poll/leave', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
    }).catch(() => {});
  }
  window.__atlasPresenceOwnId = null;
  // Friend-request state is scoped to this one presence connection (#67,
  // see presencePendingIncoming's own comment) — leaving the room means
  // any not-yet-answered request can't be replied to anymore anyway (the
  // relay only works within the sender's current room), so there's nothing
  // useful left to keep around.
  presenceOwnPublicKey = null;
  presenceOwnName = null;
  clearPresenceRosterMeta();
  presencePendingIncoming = [];
  presencePendingSentRequests = new Set();
  if (socialFriendsTabActive()) refreshFriendsDisplay();
  updateSocialBadge();
}

function pollPresence(domain, worldId, displayName, httpBase, publicKey) {
  const base = httpBase || PRESENCE_DEFAULT_BASE;
  const token = {}; // this attempt's own identity — see the presencePollToken comment above
  presencePollToken = token;
  presenceOwnPublicKey = publicKey || null;
  presenceOwnName = displayName;

  fetch(base + '/presence/poll/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, world: worldId, name: displayName, publicKey })
  })
    .then((r) => r.json())
    .then((welcome) => {
      // Superseded by a later enterWorld() call (or a WS attempt that
      // succeeded in the meantime) before this join actually resolved —
      // leave the room we just joined rather than let a visitor "linger"
      // server-side in a world they've already left, and don't touch any
      // state a newer attempt now owns.
      if (presencePollToken !== token || !active3D) {
        fetch(base + '/presence/poll/leave', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: welcome.id })
        }).catch(() => {});
        return;
      }
      presencePollId = welcome.id;
      presencePollHttpBase = base;
      window.__atlasPresenceOwnId = welcome.id;
      (welcome.roster || []).forEach((m) => notePresenceRosterMeta(m.id, m.name, m.publicKey));
      reconcilePollRoster(welcome.roster);
      if (socialFriendsTabActive()) refreshFriendsDisplay();
      presencePollTimer = setInterval(() => {
        if (presencePollToken !== token) return; // disconnectPresence() already clears this timer too — just a defensive guard
        const pose = currentLocalPose() || {};
        fetch(base + '/presence/poll/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ id: welcome.id }, pose))
        })
          .then((r) => r.json())
          .then((res) => {
            if (presencePollToken !== token) return;
            (res.roster || []).forEach((m) => notePresenceRosterMeta(m.id, m.name, m.publicKey));
            presencePollKnownIds.forEach((id) => { if (!(res.roster || []).some((m) => m.id === id)) presenceRosterMeta.delete(id); });
            reconcilePollRoster(res.roster);
            if (socialFriendsTabActive()) refreshFriendsDisplay();
            (res.signals || []).forEach((sig) => handleIncomingSignal(sig)); // friend requests etc (#67) — see poll/sync.php and its Node twin
          })
          .catch(() => {}); // a dropped tick just tries again next interval — no need to escalate
      }, PRESENCE_POLL_INTERVAL_MS);
    })
    .catch(() => {}); // presence, including its fallback, stays a pure enhancement — never surfaced as an error
}

function connectPresence(domain, worldId, displayName, presenceBase, publicKey) {
  const base = presenceBase || PRESENCE_DEFAULT_BASE;
  let socket;
  try {
    socket = new WebSocket(presenceWsUrlFor(base));
  } catch (err) {
    pollPresence(domain, worldId, displayName, base, publicKey); // WebSocket unsupported/blocked outright — go straight to polling
    return;
  }

  // If the WebSocket attempt hasn't opened OR failed within this window
  // (a presence server that exists but never completes the handshake,
  // rather than one that's cleanly unreachable and errors fast), stop
  // waiting on it and fall back to polling anyway — a visitor shouldn't
  // go without any presence at all just because one transport hung.
  //
  // Guarded by `presenceSocket === socket`, not just `settled`: if
  // disconnectPresence() already ran (a fast world switch, say), it will
  // have set presenceSocket to null (or a newer socket) and closed this
  // one itself — this timer firing afterward must NOT then call
  // pollPresence() for a world already left behind, since that stale call
  // could otherwise clobber a legitimately newer session's token.
  let settled = false;
  const fallbackTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (presenceSocket !== socket) return; // superseded — nothing to fall back FOR
    presenceSocket = null;
    try { socket.close(); } catch (err) {}
    pollPresence(domain, worldId, displayName, base, publicKey);
  }, PRESENCE_WS_CONNECT_TIMEOUT_MS);

  presenceSocket = socket;
  presenceOwnPublicKey = publicKey || null;
  presenceOwnName = displayName;

  socket.addEventListener('open', () => {
    // Superseded by a later enterWorld() call (disconnectPresence(), then
    // a new connectPresence()) before this particular connection actually
    // finished opening — let it die quietly rather than join a room for a
    // world the visitor has already left.
    if (presenceSocket !== socket) { try { socket.close(); } catch (err) {} return; }
    settled = true;
    clearTimeout(fallbackTimer);
    socket.send(JSON.stringify({ type: 'join', domain, world: worldId, name: displayName, publicKey }));
    presenceMoveTimer = setInterval(() => {
      const pose = currentLocalPose();
      if (!pose || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(Object.assign({ type: 'move' }, pose)));
    }, PRESENCE_MOVE_INTERVAL_MS);
  });

  socket.addEventListener('message', (ev) => {
    if (presenceSocket !== socket || !active3D) return; // stale connection, or the world already changed out from under it
    let msg;
    try { msg = JSON.parse(ev.data); } catch (err) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'welcome') {
      window.__atlasPresenceOwnId = msg.id; // test-observability, same convention as window.__atlasActive3D/__atlasScene
      (msg.roster || []).forEach((m) => { active3D.upsertRemotePlayer(m.id, m); notePresenceRosterMeta(m.id, m.name, m.publicKey); });
      if (socialFriendsTabActive()) refreshFriendsDisplay();
    } else if (msg.type === 'joined') {
      active3D.upsertRemotePlayer(msg.id, msg);
      notePresenceRosterMeta(msg.id, msg.name, msg.publicKey);
      if (socialFriendsTabActive()) refreshFriendsDisplay();
    } else if (msg.type === 'moved') {
      active3D.upsertRemotePlayer(msg.id, msg); // no name/publicKey on a move broadcast — roster meta from join/welcome stands
    } else if (msg.type === 'left') {
      active3D.removeRemotePlayer(msg.id);
      presenceRosterMeta.delete(msg.id);
      if (socialFriendsTabActive()) refreshFriendsDisplay();
    } else if (msg.type === 'signal') {
      handleIncomingSignal(msg); // friend requests etc (#67) — see relaySignal() in presence-server.js
    }
  });

  socket.addEventListener('close', () => {
    const wasCurrent = presenceSocket === socket;
    if (wasCurrent) {
      presenceSocket = null;
      if (presenceMoveTimer) { clearInterval(presenceMoveTimer); presenceMoveTimer = null; }
    }
    // A close that arrives before the WebSocket ever opened (handshake
    // rejected, connection refused) is exactly the "try polling instead"
    // case — but only if this attempt was still the live one (wasCurrent)
    // AND nothing has settled it yet. Without the wasCurrent check, a
    // disconnectPresence() that closed this same socket on its way out
    // (a fast world switch) would land here with settled still false and
    // wrongly kick off polling for the world already left behind.
    if (!settled) {
      settled = true;
      clearTimeout(fallbackTimer);
      if (wasCurrent) pollPresence(domain, worldId, displayName, base, publicKey);
    }
  });

  // presence-server unreachable/down, or the connection dropped mid-world.
  // The 'close' listener above (which always fires after 'error' for a
  // WebSocket) does the actual fallback decision and cleanup — this just
  // has to exist so the failed connection doesn't surface as an unhandled
  // error, per the top-of-section comment.
  socket.addEventListener('error', () => {});
}

const walletBtn = document.getElementById('walletBtn');
const walletBadge = document.getElementById('walletBadge');
const walletPanel = document.getElementById('walletPanel');
const quickLockWalletBtn = document.getElementById('quickLockWalletBtn');

// Social tab (#61/#67): Mail, Friends, Favorites as three sub-screens of
// one top-level tab — see showWalletScreen()/showSocialSubtab() below for
// how the two levels of tabbing interact.
const socialTabBtn = document.getElementById('socialTabBtn');
const socialBadge = document.getElementById('socialBadge');
const socialScreen = document.getElementById('socialScreen');
const mailSubtabBtn = document.getElementById('mailSubtabBtn');
const friendsSubtabBtn = document.getElementById('friendsSubtabBtn');
const favoritesSubtabBtn = document.getElementById('favoritesSubtabBtn');
const mailSubscreen = document.getElementById('mailSubscreen');
const friendsSubscreen = document.getElementById('friendsSubscreen');
const favoritesSubscreen = document.getElementById('favoritesSubscreen');
const friendRequestsBadge = document.getElementById('friendRequestsBadge');

// Mail's own inner sub-tab bar: Mail (inbox, default) vs. Mail Settings —
// see showMailInnerSubtab() below.
const mailInboxSubtabBtn = document.getElementById('mailInboxSubtabBtn');
const mailSettingsSubtabBtn = document.getElementById('mailSettingsSubtabBtn');
const mailInboxSubscreen = document.getElementById('mailInboxSubscreen');
const mailSettingsSubscreen = document.getElementById('mailSettingsSubscreen');

const mailBadge = document.getElementById('mailBadge');

// The "Mail" heading's own inner Inbox/Sent/Compose split — one level
// deeper than the Mail/Mail Settings split above. See showMailBoxSubtab()
// below.
const mailBoxInboxSubtabBtn = document.getElementById('mailBoxInboxSubtabBtn');
const mailBoxSentSubtabBtn = document.getElementById('mailBoxSentSubtabBtn');
const mailBoxComposeSubtabBtn = document.getElementById('mailBoxComposeSubtabBtn');
const mailBoxInboxSubscreen = document.getElementById('mailBoxInboxSubscreen');
const mailBoxSentSubscreen = document.getElementById('mailBoxSentSubscreen');
const mailBoxComposeSubscreen = document.getElementById('mailBoxComposeSubscreen');
const mailBoxInboxBadge = document.getElementById('mailBoxInboxBadge');
const sentMailListEl = document.getElementById('sentMailList');
const clearSentMailBtn = document.getElementById('clearSentMailBtn');

const checkMailNowBtn = document.getElementById('checkMailNowBtn');
const mailLastCheckedEl = document.getElementById('mailLastChecked');
const mailIntervalInput = document.getElementById('mailIntervalInput');
const saveMailIntervalBtn = document.getElementById('saveMailIntervalBtn');
const mailIntervalStatusEl = document.getElementById('mailIntervalStatus');
const autoLockMinutesInput = document.getElementById('autoLockMinutesInput');
const saveAutoLockMinutesBtn = document.getElementById('saveAutoLockMinutesBtn');
const autoLockMinutesStatusEl = document.getElementById('autoLockMinutesStatus');
const mailListEl = document.getElementById('mailList');
const markAllMailReadBtn = document.getElementById('markAllMailReadBtn');
const clearAllMailBtn = document.getElementById('clearAllMailBtn');
const subscribeSectionEl = document.getElementById('subscribeSection');
const subscribeBtn = document.getElementById('subscribeBtn');
const subscribeStatusEl = document.getElementById('subscribeStatus');
const postOfficeJoinSectionEl = document.getElementById('postOfficeJoinSection');
const postOfficeJoinBtn = document.getElementById('postOfficeJoinBtn');
const postOfficeJoinStatusEl = document.getElementById('postOfficeJoinStatus');

const myPublicKeyDisplayEl = document.getElementById('myPublicKeyDisplay');
const copyMyPublicKeyBtn = document.getElementById('copyMyPublicKeyBtn');
const copyMyPublicKeyStatusEl = document.getElementById('copyMyPublicKeyStatus');
const postOfficeToDomainInput = document.getElementById('postOfficeToDomainInput');
const postOfficeToHandleInput = document.getElementById('postOfficeToHandleInput');
const postOfficeToPublicKeyInput = document.getElementById('postOfficeToPublicKeyInput');
const postOfficeToggleRawKeyBtn = document.getElementById('postOfficeToggleRawKeyBtn');
const postOfficeSubjectInput = document.getElementById('postOfficeSubjectInput');
const postOfficeBodyInput = document.getElementById('postOfficeBodyInput');
const postOfficeSendBtn = document.getElementById('postOfficeSendBtn');
const postOfficeSendStatusEl = document.getElementById('postOfficeSendStatus');

// Task #94 (consent/block model + handle addressing)
const postOfficeSettingsDomainInput = document.getElementById('postOfficeSettingsDomainInput');
const postOfficeYourHandleDisplayEl = document.getElementById('postOfficeYourHandleDisplay');
const postOfficeHandleInput = document.getElementById('postOfficeHandleInput');
const postOfficeSaveHandleBtn = document.getElementById('postOfficeSaveHandleBtn');
const postOfficeClearHandleBtn = document.getElementById('postOfficeClearHandleBtn');
const postOfficeHandleStatusEl = document.getElementById('postOfficeHandleStatus');
const postOfficeMailModeInput = document.getElementById('postOfficeMailModeInput');
const postOfficeSaveMailModeBtn = document.getElementById('postOfficeSaveMailModeBtn');
const postOfficeMailModeStatusEl = document.getElementById('postOfficeMailModeStatus');
const postOfficeBlockedListEl = document.getElementById('postOfficeBlockedList');
const postOfficeBlockPublicKeyInput = document.getElementById('postOfficeBlockPublicKeyInput');
const postOfficeBlockBtn = document.getElementById('postOfficeBlockBtn');
const postOfficeBlockStatusEl = document.getElementById('postOfficeBlockStatus');

const friendsHereListEl = document.getElementById('friendsHereList');
const friendRequestsListEl = document.getElementById('friendRequestsList');
const friendsListEl = document.getElementById('friendsList');

const addCurrentFavoriteBtn = document.getElementById('addCurrentFavoriteBtn');
const addCurrentFavoriteStatusEl = document.getElementById('addCurrentFavoriteStatus');
const favoritesListEl = document.getElementById('favoritesList');

// The wallet panel is one of several mutually-exclusive "screens" — see
// showWalletScreen() / routeWalletScreen() below.
const walletScreens = document.querySelectorAll('.wallet-screen');

const onboardingChoiceScreen = document.getElementById('onboardingChoiceScreen');
const chooseNewBtn = document.getElementById('chooseNewBtn');
const chooseImportBtn = document.getElementById('chooseImportBtn');
const chooseWebAuthnBtn = document.getElementById('chooseWebAuthnBtn');

const createScreen = document.getElementById('createScreen');
const newPasswordInput = document.getElementById('newPasswordInput');
const newPasswordConfirmInput = document.getElementById('newPasswordConfirmInput');
const createScreenStatus = document.getElementById('createScreenStatus');
const confirmCreateBtn = document.getElementById('confirmCreateBtn');
const createScreenImportInsteadBtn = document.getElementById('createScreenImportInsteadBtn');
const backFromCreateBtn = document.getElementById('backFromCreateBtn');

const webauthnCreateScreen = document.getElementById('webauthnCreateScreen');
const webauthnCreateScreenStatus = document.getElementById('webauthnCreateScreenStatus');
const confirmWebAuthnCreateBtn = document.getElementById('confirmWebAuthnCreateBtn');
const backFromWebAuthnCreateBtn = document.getElementById('backFromWebAuthnCreateBtn');

const seedRevealBox = document.getElementById('seedRevealBox');
const seedPhraseTextEl = document.getElementById('seedPhraseText');
const seedConfirmCheck = document.getElementById('seedConfirmCheck');
const seedConfirmBtn = document.getElementById('seedConfirmBtn');

const importScreen = document.getElementById('importScreen');
const onboardImportFileInput = document.getElementById('onboardImportFileInput');
const onboardImportPasswordInput = document.getElementById('onboardImportPasswordInput');
const onboardImportSeedInput = document.getElementById('onboardImportSeedInput');
const importScreenStatus = document.getElementById('importScreenStatus');
const confirmImportBtn = document.getElementById('confirmImportBtn');
const backFromImportBtn = document.getElementById('backFromImportBtn');

const unlockScreen = document.getElementById('unlockScreen');
const unlockPasswordInput = document.getElementById('unlockPasswordInput');
const unlockScreenStatus = document.getElementById('unlockScreenStatus');
const unlockBtn = document.getElementById('unlockBtn');

const identityModeLabelEl = document.getElementById('identityModeLabel');
const switchIdentityModeBtn = document.getElementById('switchIdentityModeBtn');
const lockWalletBtn = document.getElementById('lockWalletBtn');
const changePasswordSection = document.getElementById('changePasswordSection');
const changePasswordCurrentInput = document.getElementById('changePasswordCurrentInput');
const changePasswordNewInput = document.getElementById('changePasswordNewInput');
const changePasswordConfirmInput = document.getElementById('changePasswordConfirmInput');
const changePasswordBtn = document.getElementById('changePasswordBtn');
const changePasswordStatusEl = document.getElementById('changePasswordStatus');
const backupLocalSection = document.getElementById('backupLocalSection');
const backupWebAuthnNote = document.getElementById('backupWebAuthnNote');
const exportPasswordInput = document.getElementById('exportPasswordInput');
const exportSeedInput = document.getElementById('exportSeedInput');
const exportIdentityBtn = document.getElementById('exportIdentityBtn');
const exportStatusEl = document.getElementById('exportStatus');
const exportBtn = document.getElementById('exportBtn');
const importWalletBtn = document.getElementById('importWalletBtn');
const importWalletFileInput = document.getElementById('importWalletFileInput');
const importWalletStatusEl = document.getElementById('importWalletStatus');
const hiddenAssetsListEl = document.getElementById('hiddenAssetsList');
const recentWorldsListEl = document.getElementById('recentWorldsList');
const cacheTotalLineEl = document.getElementById('cacheTotalLine');
const cacheSitesListEl = document.getElementById('cacheSitesList');
const exportCacheBtn = document.getElementById('exportCacheBtn');
const importCacheBtn = document.getElementById('importCacheBtn');
const importCacheFileInput = document.getElementById('importCacheFileInput');
const importCacheStatusEl = document.getElementById('importCacheStatus');
const clearAllCacheBtn = document.getElementById('clearAllCacheBtn');
const characterScaleInputEl = document.getElementById('characterScaleInput');
const characterScaleValueEl = document.getElementById('characterScaleValue');
const backFromSettingsBtn = document.getElementById('backFromSettingsBtn');
const walletTabBar = document.getElementById('walletTabBar');
const walletTabBtn = document.getElementById('walletTabBtn');
const assetUpdatesBadge = document.getElementById('assetUpdatesBadge');
const settingsTabBtn = document.getElementById('settingsTabBtn');

const mainWalletScreen = document.getElementById('mainWalletScreen');
const walletIdentityEl = document.getElementById('walletIdentity');
const aliasInput = document.getElementById('aliasInput');
const setAliasBtn = document.getElementById('setAliasBtn');
const aliasStatusEl = document.getElementById('aliasStatus');
const counterpartyIdentityEl = document.getElementById('counterpartyIdentity');
const createCounterpartyBtn = document.getElementById('createCounterpartyBtn');

const requestItemBtn = document.getElementById('requestItemBtn');
const presentBtn = document.getElementById('presentBtn');
const reverifyBtn = document.getElementById('reverifyBtn');
const loadoutNoteEl = document.getElementById('loadoutNote');

// Inventory (task #44): Collectibles/Documents sub-tabs of one merged
// section — see showInventorySubtab() below for how the two levels of
// tabbing (walletTabBar -> inventorySubtabBar) interact, same pattern as
// Social's Mail/Friends/Favorites.
const inventorySubtabBar = document.getElementById('inventorySubtabBar');
const collectiblesSubtabBtn = document.getElementById('collectiblesSubtabBtn');
const documentsSubtabBtn = document.getElementById('documentsSubtabBtn');
const collectiblesSubscreen = document.getElementById('collectiblesSubscreen');
const documentsSubscreen = document.getElementById('documentsSubscreen');
const mintIronBtn = document.getElementById('mintIronBtn');
const mintGoldBtn = document.getElementById('mintGoldBtn');
const collectiblesSearchInput = document.getElementById('collectiblesSearchInput');
const selfCollectiblesListEl = document.getElementById('selfCollectiblesList');
const counterpartyCollectiblesListEl = document.getElementById('counterpartyCollectiblesList');
const droppedItemsSectionEl = document.getElementById('droppedItemsSection');
const droppedItemsListEl = document.getElementById('droppedItemsList');
const documentsSearchInput = document.getElementById('documentsSearchInput');
const selfDocumentsListEl = document.getElementById('selfDocumentsList');
const counterpartyDocumentsListEl = document.getElementById('counterpartyDocumentsList');
const tradeNoteEl = document.getElementById('tradeNote');
const tradeBtn = document.getElementById('tradeBtn');
const tradeStatusEl = document.getElementById('tradeStatus');

let portalHitboxes = []; // [{sx, sy, radius, portal}]
let itemMarkerHitboxes = []; // [{sx, sy, radius, marker}] — dropped items, 2D renderer only for now
let interactableHitboxes = []; // [{sx, sy, radius, marker}] — scene.json-declared clickable stalls (mining, etc.), 2D renderer only
let interactableBusy = false; // guards against a rapid double-click firing two mints at once
let pendingDropCredentialId = null; // set while waiting for the next canvas click to choose a drop spot
let currentManifest = null;   // cached manifest object
let currentManifestUrl = null;
let currentOrigin = null;
let currentWorld = null;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight - 56;
}
resize();
window.addEventListener('resize', resize);

// ---------- fullscreen cursor auto-hide ----------
//
// F11's native browser fullscreen — the only kind of fullscreen this app
// has since #51 removed the in-page Fullscreen API integration (fighting a
// cross-origin iframe's activation requirements wasn't worth it when the
// browser's own shortcut already works) — never fires `fullscreenchange`
// or sets `document.fullscreenElement`, because it's a browser-chrome
// toggle, not a per-element Fullscreen API request. There is no direct "am
// I in F11 fullscreen" signal to listen for.
//
// The practical workaround plenty of other web apps use for this same
// gap: treat "the viewport now exactly fills the physical screen" as
// "probably fullscreen" — a merely-maximized (non-fullscreen) window is
// always a little smaller than the full screen (taskbar, window chrome),
// while real fullscreen fills it exactly. This iframe is 100vw/100vh (see
// content.js), so its own window.innerWidth/Height already track the host
// page's real viewport size.
//
// The cursor hides after a couple of idle seconds — long enough to stay
// out of the way while actually playing, short enough that it's never
// truly unreachable — and reappears instantly on any mouse movement, on
// leaving fullscreen, or on a window resize (covers both leaving
// fullscreen and just resizing the still-fullscreen window).
const CURSOR_IDLE_MS = 2000;
let cursorIdleTimer = null;

function looksFullscreen() {
  return Math.abs(window.innerWidth - window.screen.width) <= 2 &&
         Math.abs(window.innerHeight - window.screen.height) <= 2;
}

function scheduleCursorHide() {
  // Drag-to-look fires continuous mousemove events while the user is
  // actively turning the camera — that's the primary way you look around
  // in this game, so treating it like "moving the mouse toward UI" would
  // mean the cursor can never actually stay hidden while playing. Ignore
  // mousemove-driven resets entirely while a look-drag is in progress; the
  // cursor was already hidden (or on its way to being hidden) before the
  // drag started, and this call is only reached again once the drag ends.
  if (active3D && active3D.isLookDragging && active3D.isLookDragging()) return;
  if (cursorIdleTimer) clearTimeout(cursorIdleTimer);
  document.body.style.cursor = '';
  if (!looksFullscreen()) return;
  cursorIdleTimer = setTimeout(() => {
    if (looksFullscreen()) document.body.style.cursor = 'none';
  }, CURSOR_IDLE_MS);
}

window.addEventListener('mousemove', scheduleCursorHide);
window.addEventListener('resize', scheduleCursorHide);
scheduleCursorHide();

closeBtn.addEventListener('click', () => window.parent.postMessage('domain-atlas-close', '*'));

function startParams() {
  const params = new URLSearchParams(window.location.search);
  return { manifest: params.get('manifest'), world: params.get('world') };
}

async function loadManifest(manifestUrl, worldId) {
  statusEl.textContent = 'Fetching manifest…';
  const res = await fetch(manifestUrl, { cache: 'no-store' });
  const manifest = await res.json();
  currentManifest = manifest;
  currentManifestUrl = manifestUrl;
  currentOrigin = new URL(manifestUrl).origin;
  await enterWorld(worldId || manifest.defaultWorld);
}

function show3DCanvas(active) {
  canvas.style.display = active ? 'none' : '';
  hintEl.style.display = active ? 'none' : '';
  scene3dCanvas.classList.toggle('active', active);
  scene3dHint.classList.toggle('active', active);
}

async function enterWorld(worldId) {
  portalHitboxes = [];
  const manifest = currentManifest;
  const world = manifest.worlds.find((w) => w.id === worldId) || manifest.worlds[0];
  currentWorld = world;
  await refreshRequestButton();
  await refreshSubscribeButton();
  await refreshPostOfficeJoinButton();
  await refreshMyPublicKeyDisplay();
  refreshWorldGates();

  placeLabel.innerHTML = world.name + ' <span class="domain">' + manifest.domain + ' · ' + world.id + '</span>';
  document.title = 'Domain Atlas — ' + world.name;
  await AtlasWallet.recordWorldVisit({
    domain: manifest.domain,
    world: world.id,
    worldName: world.name,
    manifestUrl: currentManifestUrl
  });

  // SPEC.md §5.1.1 — entering a world is the moment a stale item property
  // actually matters to the visitor, so it triggers the same check-in
  // checkAllMail() already runs periodically (see restartMailCheckLoop
  // below), just immediately and scoped to only this domain instead of
  // waiting up to mailIntervalMinutes for every domain. Deliberately not
  // awaited — the world itself has already been recorded/labeled above,
  // and a slow or unreachable domain shouldn't stall getting into it;
  // checkAllMail already swallows a single domain's failure on its own.
  checkItemUpdatesForDomain(manifest.domain);

  // Leaving whichever world was active before — if it was a 3D one, its
  // render loop and input listeners need tearing down before anything else
  // starts, same idea as window.__atlasScene just getting overwritten below
  // for the 2D path.
  if (active3D) { active3D.destroy(); active3D = null; }
  window.__atlasActive3D = null; // same test-observability convention as window.__atlasScene
  disconnectPresence(); // leaving whichever world was active before also means leaving its presence room, 3D or not
  hideSceneLoadProgress(); // whichever world was active before might have left this showing (#36) — never carry it into the next one

  // A pending "click where you want to drop it" from whichever world was
  // active before doesn't carry over to a new one.
  pendingDropCredentialId = null;
  canvas.style.cursor = '';

  // Every renderer this wallet actually knows how to draw. A world that
  // declares something outside this list isn't necessarily broken — it may
  // just be written for a newer wallet than this one — so it gets a clear
  // "can't render this" message instead of silently falling through to the
  // 2D path and drawing something the world never intended.
  const KNOWN_RENDERERS = ['gltf-mini-v1', 'procedural-v1'];
  const declaredRenderers = (world.entry.renderer && world.entry.renderer.length) ? world.entry.renderer : ['procedural-v1'];
  if (!declaredRenderers.some((r) => KNOWN_RENDERERS.includes(r))) {
    show3DCanvas(false);
    statusEl.textContent = 'This world needs a renderer this wallet doesn\'t support yet (' + declaredRenderers.join(', ') + ') — try updating the extension.';
    return;
  }
  const is3D = declaredRenderers.includes('gltf-mini-v1');
  show3DCanvas(is3D);

  if (is3D) {
    try {
      statusEl.textContent = 'Fetching scene…';
      const sceneUrl = currentOrigin + world.entry.scene;
      const sceneRes = await fetch(sceneUrl, { cache: 'no-store' });
      const sceneData = await sceneRes.json();
      // itemMarkers isn't populated for the 3D renderer yet (see the
      // "Dropping items" note in wallet.js) — kept in the shape for
      // consistency, just always empty here for now. Dropping still fully
      // works in a gltf-mini world; there's just no in-scene marker to
      // walk up to, only the "Dropped in this world" list's Pick up button.
      window.__atlasScene = { floor: sceneData.floor || { size: [10, 10], color: '#1b2830' }, objects: [], portalMarkers: [], itemMarkers: [], interactables: [] };

      active3D = MiniGLTF.init(scene3dCanvas, {
        sceneData,
        resolveAssetUrl: (path) => currentOrigin + path,
        isCrossDomainPortal: (portalIndex) => !!(world.portals[portalIndex] && world.portals[portalIndex].kind === 'domain'),
        onPortalEnter: (portalIndex) => followPortal(world.portals[portalIndex]),
        characterScale: await AtlasWallet.getCharacterScale(),
        // Scene asset download progress (#36) — see updateSceneLoadProgress()
        // above and loadScene()'s own comment in gltf-mini.js for why this
        // counts unique models, not placed instances.
        onLoadProgress: updateSceneLoadProgress
      });
      window.__atlasActive3D = active3D;
      await active3D.ready;
      hideSceneLoadProgress(); // loading finished — the render loop is about to take over the canvas
      statusEl.textContent = 'In sync with ' + manifest.domain + ' · ' + world.id;
      history.replaceState(null, '', '?manifest=' + encodeURIComponent(currentManifestUrl) + '&world=' + encodeURIComponent(world.id));

      // Presence (#66) — join this domain+world's room so other current
      // visitors show up as walking characters (see gltf-mini.js's
      // remotePlayers) and this visitor shows up for them too. Uses
      // whatever alias is set for the active identity if there is one
      // (same alias a counterparty/trade partner would see), otherwise a
      // short public-key fragment, otherwise a plain "Visitor" label for
      // someone with no wallet identity at all — entering a world has
      // never required one (see #63) and presence shouldn't start
      // requiring one either.
      const presenceIdentity = await AtlasWallet.getIdentity();
      const presenceAlias = presenceIdentity ? await AtlasWallet.getAlias(presenceIdentity.publicKey) : null;
      const presenceName = presenceAlias || (presenceIdentity ? short(presenceIdentity.publicKey, 10) : 'Visitor');
      // publicKey is optional (#67) — an anonymous visitor with no
      // unlocked identity announces none at all, same "presence never
      // requires an identity" principle #63 established; they simply can't
      // be friend-requested (nothing stable to add), but everything else
      // about presence works exactly as before.
      connectPresence(manifest.domain, world.id, presenceName, manifest.presence, presenceIdentity ? presenceIdentity.publicKey : null);
    } catch (err) {
      hideSceneLoadProgress(); // a failed load shouldn't leave a stuck progress bar over the error message
      statusEl.textContent = 'Could not load world: ' + err.message;
    }
    return;
  }

  try {
    statusEl.textContent = 'Fetching scene…';
    const sceneUrl = currentOrigin + world.entry.scene;
    const sceneRes = await fetch(sceneUrl, { cache: 'no-store' });
    const scene = await sceneRes.json();

    window.__atlasScene = {
      floor: scene.floor || { size: [10, 10], color: '#1b2830' },
      objects: scene.objects || [],
      portalMarkers: (scene.portalMarkers || []).map((m) => ({
        position: m.position,
        portal: world.portals[m.portalIndex]
      })),
      itemMarkers: [],
      // Scene-declared clickable stalls (e.g. the Trading Post's iron/gold
      // stands) — self-contained config, unlike portalMarkers there's no
      // manifest cross-reference needed since every field a mint needs
      // (class, quantity, which identity mines it) lives right in
      // scene.json. See handleInteractable() for what "action" values do.
      interactables: scene.interactables || []
    };
    await refreshSceneItemMarkers();

    statusEl.textContent = 'In sync with ' + manifest.domain + ' · ' + world.id;
    history.replaceState(null, '', '?manifest=' + encodeURIComponent(currentManifestUrl) + '&world=' + encodeURIComponent(world.id));
  } catch (err) {
    statusEl.textContent = 'Could not load world: ' + err.message;
    window.__atlasScene = { floor: { size: [10, 10], color: '#2a1a1a' }, objects: [], portalMarkers: [], itemMarkers: [], interactables: [] };
  }
}

async function followPortal(portal) {
  if (!portal) return;
  if (portal.kind === 'world') {
    // Same-origin scene swap: reuse the already-cached manifest, no re-fetch.
    await enterWorld(portal.to);
  } else if (portal.kind === 'domain') {
    // Crossing a real trust boundary: fetch the other domain's own manifest.
    await loadManifest(portal.manifest);
  }
}

// --- isometric rendering (unchanged mechanics, world-agnostic) ---

const SCALE = 26;
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

function project(x, y, z, originX, originY) {
  return {
    x: originX + (x - z) * COS30 * SCALE,
    y: originY + (x + z) * SIN30 * SCALE - y * SCALE
  };
}

function drawFloor(floor, originX, originY) {
  const [w, d] = floor.size;
  const hw = w / 2, hd = d / 2;
  const corners = [
    project(-hw, 0, -hd, originX, originY),
    project(hw, 0, -hd, originX, originY),
    project(hw, 0, hd, originX, originY),
    project(-hw, 0, hd, originX, originY)
  ];
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  corners.slice(1).forEach((c) => ctx.lineTo(c.x, c.y));
  ctx.closePath();
  ctx.fillStyle = floor.color || '#1b2830';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.stroke();
}

function drawBox(obj, originX, originY) {
  const [x, y, z] = obj.position;
  const [sx, sy, sz] = obj.size;
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const cy = y;
  const top = [
    project(x - hx, cy + hy, z - hz, originX, originY),
    project(x + hx, cy + hy, z - hz, originX, originY),
    project(x + hx, cy + hy, z + hz, originX, originY),
    project(x - hx, cy + hy, z + hz, originX, originY)
  ];
  const frontLeft = [
    project(x - hx, cy - hy, z + hz, originX, originY),
    project(x - hx, cy + hy, z + hz, originX, originY),
    top[3],
    project(x - hx, cy - hy, z - hz, originX, originY)
  ];
  const frontRight = [
    project(x + hx, cy - hy, z + hz, originX, originY),
    project(x + hx, cy + hy, z + hz, originX, originY),
    top[2],
    project(x + hx, cy - hy, z - hz, originX, originY)
  ];

  const base = obj.color || '#c05a1f';
  drawFace(top, shade(base, 1.15));
  drawFace(frontLeft, shade(base, 0.85));
  drawFace(frontRight, shade(base, 0.65));

  if (obj.label) {
    const labelPt = project(x, cy + hy + 0.4, z, originX, originY);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#e7edef';
    ctx.textAlign = 'center';
    ctx.fillText(obj.label, labelPt.x, labelPt.y);
  }
}

function drawFace(points, color) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function shade(hex, factor) {
  const n = parseInt(hex.replace('#', ''), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.min(255, Math.round(r * factor));
  g = Math.min(255, Math.round(g * factor));
  b = Math.min(255, Math.round(b * factor));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function drawPortal(marker, originX, originY, pulse) {
  const [x, y, z] = marker.position;
  const base = project(x, 0, z, originX, originY);
  const top = project(x, 2.2, z, originX, originY);
  const radius = 16 + Math.sin(pulse) * 3;
  const isCrossDomain = marker.portal && marker.portal.kind === 'domain';

  const grad = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
  if (isCrossDomain) {
    grad.addColorStop(0, 'rgba(87,165,147,0.15)');
    grad.addColorStop(1, 'rgba(87,165,147,0.9)');
  } else {
    grad.addColorStop(0, 'rgba(192,90,31,0.15)');
    grad.addColorStop(1, 'rgba(224,138,76,0.85)');
  }

  ctx.beginPath();
  ctx.ellipse((base.x + top.x) / 2, (base.y + top.y) / 2, radius * 0.55, radius, 0, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.shadowColor = isCrossDomain ? '#57a593' : '#e08a4c';
  ctx.shadowBlur = 18 + Math.sin(pulse) * 6;
  ctx.fill();
  ctx.shadowBlur = 0;

  if (marker.portal) {
    const tag = isCrossDomain ? '⇢ domain' : '↻ world';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = isCrossDomain ? '#57a593' : '#e08a4c';
    ctx.textAlign = 'center';
    ctx.fillText(marker.portal.label || tag, (base.x + top.x) / 2, base.y + 18);
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(tag, (base.x + top.x) / 2, base.y + 32);
  }

  return { sx: (base.x + top.x) / 2, sy: (base.y + top.y) / 2, radius: radius + 20, marker };
}

// A dropped item's marker — visually distinct from a portal (a small
// bobbing amber glow at ground level with the item's name above it,
// rather than a tall glowing doorway), since it's a very different kind
// of thing to click: "pick this up," not "go somewhere."
function drawItemMarker(marker, originX, originY, pulse) {
  const [x, , z] = marker.position;
  const bob = Math.sin(pulse * 1.6) * 3;
  const base = project(x, 0, z, originX, originY);
  const cy = base.y - 14 - bob;
  const radius = 9;

  const grad = ctx.createRadialGradient(base.x, cy, 1, base.x, cy, radius);
  grad.addColorStop(0, 'rgba(224,184,76,0.95)');
  grad.addColorStop(1, 'rgba(224,184,76,0.2)');
  ctx.beginPath();
  ctx.arc(base.x, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.shadowColor = '#e0b84c';
  ctx.shadowBlur = 14;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#e0b84c';
  ctx.textAlign = 'center';
  ctx.fillText(marker.name, base.x, cy - radius - 8);
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = '#a9b8bf';
  ctx.fillText('click to pick up', base.x, base.y + 14);

  return { sx: base.x, sy: cy, radius: radius + 12, marker };
}

// A scene-declared clickable stall (see the "interactables" note in
// enterWorld) — visually its own thing again: a small steady teal glow
// (portals are the amber/teal doorway pillars, dropped items are the amber
// ground glow; teal-at-ground-level reads as "a fixture you interact with
// in place," not "go somewhere" or "carry this").
function drawInteractable(marker, originX, originY, pulse) {
  const [x, y, z] = marker.position;
  const base = project(x, y || 0, z, originX, originY);
  const cy = base.y - 16;
  const radius = 10 + Math.sin(pulse * 1.2) * 1.5;

  const grad = ctx.createRadialGradient(base.x, cy, 1, base.x, cy, radius);
  grad.addColorStop(0, 'rgba(87,165,147,0.9)');
  grad.addColorStop(1, 'rgba(87,165,147,0.15)');
  ctx.beginPath();
  ctx.arc(base.x, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.shadowColor = '#57a593';
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#57a593';
  ctx.textAlign = 'center';
  ctx.fillText(marker.label || 'Collect', base.x, cy - radius - 8);
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = '#a9b8bf';
  ctx.fillText('click to collect', base.x, base.y + 22);

  return { sx: base.x, sy: cy, radius: radius + 14, marker };
}

// The inverse of project() at ground level (y=0) — turns a canvas click
// back into the world (x, z) under the cursor, so "drop it here" in the 2D
// renderer can mean an actual chosen spot rather than one fixed location.
// Solving project()'s two equations for x and z:
//   sx - originX = (x - z) * COS30 * SCALE  =>  A = x - z
//   sy - originY = (x + z) * SIN30 * SCALE  =>  B = x + z
//   x = (A + B) / 2, z = (B - A) / 2
function unprojectGround(sx, sy, originX, originY) {
  const a = (sx - originX) / (COS30 * SCALE);
  const b = (sy - originY) / (SIN30 * SCALE);
  return { x: (a + b) / 2, z: (b - a) / 2 };
}

function render(t) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const originX = canvas.width / 2;
  const originY = canvas.height / 2 + 40;
  const scene = window.__atlasScene;
  portalHitboxes = [];
  itemMarkerHitboxes = [];
  interactableHitboxes = [];

  if (scene) {
    drawFloor(scene.floor, originX, originY);

    const drawables = [
      ...scene.objects.map((o) => ({ kind: 'box', obj: o, depth: o.position[0] + o.position[2] })),
      ...scene.portalMarkers.map((m) => ({ kind: 'portal', obj: m, depth: m.position[0] + m.position[2] })),
      ...(scene.itemMarkers || []).map((m) => ({ kind: 'item', obj: m, depth: m.position[0] + m.position[2] })),
      ...(scene.interactables || []).map((m) => ({ kind: 'interactable', obj: m, depth: m.position[0] + m.position[2] }))
    ].sort((a, b) => a.depth - b.depth);

    const pulse = t / 260;
    drawables.forEach((d) => {
      if (d.kind === 'box') {
        drawBox(d.obj, originX, originY);
      } else if (d.kind === 'portal') {
        const hitbox = drawPortal(d.obj, originX, originY, pulse);
        portalHitboxes.push(hitbox);
      } else if (d.kind === 'item') {
        const hitbox = drawItemMarker(d.obj, originX, originY, pulse);
        itemMarkerHitboxes.push(hitbox);
      } else {
        const hitbox = drawInteractable(d.obj, originX, originY, pulse);
        interactableHitboxes.push(hitbox);
      }
    });
  }

  requestAnimationFrame(render);
}

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  // A drop-in-progress claims this click regardless of what's underneath
  // it — the whole point of "click where you want to drop it" is that the
  // next click IS the answer, not a normal scene interaction.
  if (pendingDropCredentialId) {
    const originX = canvas.width / 2;
    const originY = canvas.height / 2 + 40;
    const { x, z } = unprojectGround(cx, cy, originX, originY);
    const id = pendingDropCredentialId;
    pendingDropCredentialId = null;
    canvas.style.cursor = '';
    finalizeDrop(id, [x, 0, z]);
    return;
  }

  for (const hb of itemMarkerHitboxes) {
    const dist = Math.hypot(cx - hb.sx, cy - hb.sy);
    if (dist < hb.radius) {
      pickUpDroppedItem(hb.marker.credentialId);
      return;
    }
  }

  for (const hb of interactableHitboxes) {
    const dist = Math.hypot(cx - hb.sx, cy - hb.sy);
    if (dist < hb.radius) {
      handleInteractable(hb.marker);
      return;
    }
  }

  for (const hb of portalHitboxes) {
    const dist = Math.hypot(cx - hb.sx, cy - hb.sy);
    if (dist < hb.radius && hb.marker.portal) {
      followPortal(hb.marker.portal);
      return;
    }
  }
});

// Escape backs out of "click where you want to drop it" without dropping
// anywhere — otherwise the very next canvas click, whenever it happens
// (possibly long after the person closed the wallet panel and forgot),
// would silently place the item instead of doing whatever they actually
// clicked for. Registered ahead of the pause-menu-style Escape handler
// below (which toggles the wallet panel closed) and stops the event right
// here when it actually cancels a pending drop, so backing out of a drop
// doesn't ALSO slam the wallet panel shut on the person mid-Inventory.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pendingDropCredentialId) {
    pendingDropCredentialId = null;
    canvas.style.cursor = '';
    statusEl.textContent = 'Drop cancelled.';
    e.stopImmediatePropagation();
  }
});

// --- identity + wallet (real WebAuthn + real ECDSA verification, not mocked) ---

function short(b64url, n) {
  return b64url ? b64url.slice(0, n) + '…' : '';
}

function manifestDomainOf(manifest) {
  return manifest.domain;
}

function combatOf(world) {
  return (world && world.profile && world.profile.capabilities && world.profile.capabilities.combat) || 'none';
}

// Same oncePerUser courtesy check handleInteractable() uses for an in-scene
// "issue" stall (see the note there) — extended here so the generic
// "Request item from this world" button behaves the same way instead of
// letting repeated clicks quietly fill the wallet with duplicates. Still
// just a per-device courtesy, not real protocol-level scarcity (SPEC.md).
async function alreadyHasRequestableItem(world) {
  const classes = world && world.policy && world.policy.itemDropsAllowed ? (world.policy.acceptedItemClasses || []) : [];
  if (classes.length === 0) return false;
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return false;
  const wallet = await AtlasWallet.getWallet(identity.publicKey);
  return wallet.some((e) => e.credential.asset.class === classes[0] && e.credential.issuer.domain === manifestDomainOf(currentManifest));
}

async function refreshRequestButton() {
  const world = currentWorld;
  const classes = world && world.policy && world.policy.itemDropsAllowed ? (world.policy.acceptedItemClasses || []) : [];
  if (classes.length === 0) {
    requestItemBtn.disabled = true;
    requestItemBtn.textContent = 'This world issues nothing';
    return;
  }
  if (await alreadyHasRequestableItem(world)) {
    requestItemBtn.disabled = true;
    requestItemBtn.textContent = 'Already collected ' + classes[0] + ' from ' + world.name;
    return;
  }
  requestItemBtn.disabled = false;
  requestItemBtn.textContent = 'Request ' + classes[0] + ' from ' + world.name;
}

function refreshWorldGates() {
  const world = currentWorld;
  const risky = combatOf(world) !== 'none';
  loadoutNoteEl.textContent = risky
    ? '⚠ This world is flagged "' + combatOf(world) + '" — items you load here can be lost under its rules. Anything left in your wallet stays safe.'
    : '';

  const isStation = world && world.profile && world.profile.genre === 'trading-station';
  tradeBtn.disabled = !isStation;
  tradeNoteEl.style.display = isStation ? 'none' : '';

  refreshInventoryDisplay();
}

async function refreshIdentityDisplay() {
  const identity = await AtlasWallet.getIdentity();
  const alias = identity ? await AtlasWallet.getAlias(identity.publicKey) : null;
  walletIdentityEl.textContent = identity
    ? (alias ? alias + ' · ' : 'Identity: ') + short(identity.publicKey, 28)
    : 'Locked.';
  // Reflects whichever identity is active right now — switching identity
  // mode or unlocking a different one re-runs this and repopulates the
  // field with THAT key's own alias (or blank, if it has none yet).
  aliasInput.value = alias || '';
  aliasStatusEl.textContent = '';
  const counterparty = await AtlasWallet.getCounterparty();
  counterpartyIdentityEl.textContent = counterparty
    ? 'Counterparty: ' + short(counterparty.publicKey, 28)
    : 'No counterparty yet — a second local keypair standing in for another visitor (see README).';

  await refreshIdentityModeControls();
  await refreshQuickLockButtonVisibility();
}

// The active "self" mechanism can be either the local password identity or
// a WebAuthn passkey identity — see wallet.js's atlasIdentityMode. This
// keeps the mode label, the switch/set-up button, the Lock button (which
// only means anything for the local password identity), and the Backup
// section (which only applies to the local identity — passkeys can't be
// exported) all in sync with whichever is currently active.
async function refreshIdentityModeControls() {
  const mode = await AtlasWallet.getIdentityMode();
  const hasLocal = await AtlasWallet.hasLocalIdentity();
  const hasWebAuthn = await AtlasWallet.hasWebAuthnIdentity();

  identityModeLabelEl.textContent = mode === 'webauthn'
    ? 'Using: passkey identity'
    : mode === 'local'
      ? 'Using: password identity'
      : '';

  if (mode === 'webauthn') {
    switchIdentityModeBtn.textContent = hasLocal ? 'Switch to password identity' : 'Set up a password identity';
  } else {
    switchIdentityModeBtn.textContent = hasWebAuthn ? 'Switch to passkey identity' : 'Set up a passkey identity';
  }

  lockWalletBtn.style.display = mode === 'webauthn' ? 'none' : '';
  changePasswordSection.style.display = mode === 'webauthn' ? 'none' : '';
  backupLocalSection.style.display = mode === 'webauthn' ? 'none' : '';
  backupWebAuthnNote.style.display = mode === 'webauthn' ? '' : 'none';
}

// ---------- wallet panel screen routing ----------
// Which "screen" shows depends on two things: whether an identity has ever
// been set up on this device (hasIdentity), and whether it's been unlocked
// this browser session (isUnlocked). Exactly one of these ever shows.

function showWalletScreen(id) {
  walletScreens.forEach((el) => el.classList.toggle('active', el.id === id));
  seedRevealBox.classList.remove('show');
  // Tabs only make sense between Wallet, Social, and Settings — everything
  // else (onboarding, unlock, create) has nothing to tab between yet and
  // keeps its own dedicated navigation.
  const showTabs = id === 'mainWalletScreen' || id === 'socialScreen' || id === 'settingsScreen';
  if (walletTabBar) walletTabBar.classList.toggle('visible', showTabs);
  if (walletTabBtn) walletTabBtn.classList.toggle('active-tab', id === 'mainWalletScreen');
  if (socialTabBtn) socialTabBtn.classList.toggle('active-tab', id === 'socialScreen');
  if (settingsTabBtn) settingsTabBtn.classList.toggle('active-tab', id === 'settingsScreen');
}

// Social tab's own second level of tabbing (#61/#67): Mail / Friends /
// Favorites, same show-one-hide-the-rest idea as showWalletScreen() one
// level up, just scoped to .social-subscreen instead of .wallet-screen.
function showSocialSubtab(id) {
  [mailSubscreen, friendsSubscreen, favoritesSubscreen].forEach((el) => el && el.classList.toggle('active', el && el.id === id));
  if (mailSubtabBtn) mailSubtabBtn.classList.toggle('active-subtab', id === 'mailSubscreen');
  if (friendsSubtabBtn) friendsSubtabBtn.classList.toggle('active-subtab', id === 'friendsSubscreen');
  if (favoritesSubtabBtn) favoritesSubtabBtn.classList.toggle('active-subtab', id === 'favoritesSubscreen');
}

function socialFriendsTabActive() {
  return !!(friendsSubscreen && friendsSubscreen.classList.contains('active'));
}

// Mail's own third level of tabbing: Mail (inbox — check-now + Messages,
// the default) vs. Mail Settings (address, handle, who can mail you,
// blocked senders, check frequency). Same show-one-hide-the-rest pattern
// as showSocialSubtab() above, just one level deeper.
function showMailInnerSubtab(id) {
  [mailInboxSubscreen, mailSettingsSubscreen].forEach((el) => el && el.classList.toggle('active', el && el.id === id));
  if (mailInboxSubtabBtn) mailInboxSubtabBtn.classList.toggle('active-subtab', id === 'mailInboxSubscreen');
  if (mailSettingsSubtabBtn) mailSettingsSubtabBtn.classList.toggle('active-subtab', id === 'mailSettingsSubscreen');
}

// The "Mail" heading's own fourth level of tabbing: Inbox / Sent /
// Compose. Same show-one-hide-the-rest pattern as showMailInnerSubtab()
// right above, one level deeper still.
function showMailBoxSubtab(id) {
  [mailBoxInboxSubscreen, mailBoxSentSubscreen, mailBoxComposeSubscreen].forEach((el) => el && el.classList.toggle('active', el && el.id === id));
  if (mailBoxInboxSubtabBtn) mailBoxInboxSubtabBtn.classList.toggle('active-subtab', id === 'mailBoxInboxSubscreen');
  if (mailBoxSentSubtabBtn) mailBoxSentSubtabBtn.classList.toggle('active-subtab', id === 'mailBoxSentSubscreen');
  if (mailBoxComposeSubtabBtn) mailBoxComposeSubtabBtn.classList.toggle('active-subtab', id === 'mailBoxComposeSubscreen');
}

// Inventory tab's own second level of tabbing (task #44): Collectibles /
// Documents, same show-one-hide-the-rest idea as showSocialSubtab() right
// above, just scoped to Inventory's two .subscreen elements.
function showInventorySubtab(id) {
  [collectiblesSubscreen, documentsSubscreen].forEach((el) => el && el.classList.toggle('active', el && el.id === id));
  if (collectiblesSubtabBtn) collectiblesSubtabBtn.classList.toggle('active-subtab', id === 'collectiblesSubscreen');
  if (documentsSubtabBtn) documentsSubtabBtn.classList.toggle('active-subtab', id === 'documentsSubscreen');
}

async function routeWalletScreen() {
  if (await AtlasWallet.isUnlocked()) {
    showWalletScreen('mainWalletScreen');
    await refreshIdentityDisplay();
    await refreshInventoryDisplay();
    // Opening the Wallet tab IS the "read" action for asset-update notices
    // (SPEC.md §5.1.1) — the reissued asset is already shown front and
    // center in the list just rendered above, so there's no separate
    // per-notice click the way mail has. Mark seen, then refresh the badge
    // so it clears immediately instead of on the next unrelated refresh.
    const identity = await AtlasWallet.getIdentity();
    if (identity) await AtlasWallet.markAssetUpdateNoticesSeen(identity.publicKey);
    await refreshAssetUpdatesBadge();
  } else if (await AtlasWallet.hasIdentity()) {
    showWalletScreen('unlockScreen');
    // Land the cursor straight in the password field — every caller of
    // routeWalletScreen() (opening the wallet, Escape re-toggling it,
    // switching identity mode back to a locked one) is a moment where
    // typing the password is the very next thing the user does, so
    // there's no case here where stealing focus is unwelcome.
    unlockPasswordInput.focus();
  } else {
    showWalletScreen('onboardingChoiceScreen');
  }
}

// "Back" from create/import/webauthn-create screens: those screens are
// reachable either from onboarding (no identity yet) or from the main
// wallet's "set up the other identity mechanism" button (an identity
// already exists, just not this kind) — go home to whichever is right.
async function backToWalletHome() {
  if (await AtlasWallet.hasIdentity()) {
    showWalletScreen('mainWalletScreen');
    await refreshIdentityDisplay();
    await refreshInventoryDisplay();
  } else {
    showWalletScreen('onboardingChoiceScreen');
  }
}

// Search/filter: every .wallet-item and .resource-group-header carries a
// lowercased dataset.search (and resource rows a dataset.group linking a
// card back to its group header) so applyListFilter can match on name/
// class/issuer text without re-parsing rendered HTML. See applyListFilter
// below for how these are consumed.
// Open, per-item properties bag (SPEC.md §5.1) — an issuer can attach any
// key it likes at mint time (atlas.rarity, com.example.era, ...); this
// client doesn't need to know any specific key in advance, it just lists
// whatever came back on the credential. `null`/`undefined`/`{}` all mean
// "nothing to show," same as an item minted before this feature existed.
// A property's VALUE (SPEC.md §5.1/§5.4) is deliberately open — the spec
// only constrains the KEY namespacing, not the shape of what's behind it,
// so an issuer is just as free to sign a single static value
// ("atlas.rarity": "rare") as an array of them
// ("com.example.enchantments": ["fire resistance", "silent step"]). Plain
// string-concatenation (`key + ': ' + value`) renders an array as
// "fire resistance,silent step" — technically readable but not a good
// example of "this can be a list," and would render a nested object as the
// useless "[object Object]" — so give each shape its own formatting rather
// than leaning on JS's default stringification.
function formatPropertyValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatItemProperties(properties) {
  if (!properties || typeof properties !== 'object') return '';
  const entries = Object.entries(properties);
  if (entries.length === 0) return '';
  return entries.map(([key, value]) => key + ': ' + formatPropertyValue(value)).join(' · ');
}

// Renders the small "Properties (N) ▸" link + its hidden detail panel for
// a card's open properties bag (SPEC.md §5.1/§5.4) — same idea as the
// settings-category accordion's chevron, just per-card and much smaller
// in scope. Returns '' when there's nothing to show, so a card with no
// properties gets no link at all, same as before this feature existed.
// The toggle itself is a plain show/hide on the very next sibling element
// (see the "toggle-properties" branch in assetActionHandler below) — no
// wallet call, no list refresh, so
// opening it doesn't disturb anything else on the card, and it resets
// closed the next time the list re-renders, same as every other
// per-card DOM detail in this file.
function renderPropertiesToggle(properties) {
  if (!properties || typeof properties !== 'object') return '';
  const entries = Object.entries(properties);
  if (entries.length === 0) return '';
  const detailHtml = entries.map(([key, value]) => '<div>' + key + ': ' + formatPropertyValue(value) + '</div>').join('');
  return (
    '<button type="button" class="properties-link" data-action="toggle-properties">' +
    'Properties (' + entries.length + ')<span class="chevron">▸</span></button>' +
    '<div class="properties-detail" hidden>' + detailHtml + '</div>'
  );
}

// Unified asset card (task #44) — replaces the former separate
// renderItemCard/renderResourceCard pair. Every asset credential now
// carries the same shape (asset.name/class/properties, top-level
// quantity, asset.fungible), so one renderer covers both: a fungible
// (stackable) entry shows its quantity in the name ("Iron Ingot ×47") and
// offers Split instead of Load/PvP-loss; a non-fungible (unique) entry
// shows no quantity at all and offers Load/PvP-loss instead of Split —
// SPEC.md §5's "false moves whole via §5.2, true splits via §5.4" split,
// reflected directly in which actions a card offers.
function renderAssetCard(entry, container, opts) {
  const el = document.createElement('div');
  el.className = 'wallet-item';
  const asset = entry.credential.asset;
  const fungible = !!asset.fungible;
  const propsText = formatItemProperties(asset.properties);
  el.dataset.search = (
    asset.name + ' ' + asset.class + ' ' + entry.credential.issuer.domain + ' ' + propsText
  ).toLowerCase();
  if (opts.groupKey) el.dataset.group = opts.groupKey;
  const v = entry.lastVerdict || { valid: false, reason: 'not yet verified' };
  const supersedesNote = Array.isArray(entry.credential.supersedes)
    ? ' · consolidated from ' + entry.credential.supersedes.length + ' balances'
    : entry.credential.supersedes ? ' · supersedes prior' : '';
  let html =
    '<div class="name">' + asset.name + (fungible ? ' ×' + entry.credential.quantity : '') + '</div>' +
    '<div class="meta">' + asset.class + ' · issued by ' + entry.credential.issuer.domain + supersedesNote + '</div>' +
    renderPropertiesToggle(asset.properties) +
    '<div class="verdict ' + (v.valid ? 'valid' : 'invalid') + '">' + (v.valid ? '✓ ' : '✗ ') + v.reason + '</div>';

  html += '<div class="item-actions">';
  if (fungible) {
    // Splitting/consolidating (SPEC.md §5.4) only makes sense for a
    // fungible balance — send half of what's here to the other side.
    const half = Math.floor(entry.credential.quantity / 2);
    if (half > 0 && opts.otherLabel) {
      html += '<button data-action="split" data-id="' + entry.credential.id + '" data-amount="' + half + '">Send ' + half + ' to ' + opts.otherLabel + '</button>';
    }
  } else if (opts.loadable) {
    // Loadout / PvP-loss (SPEC.md §5.2) only makes sense for a
    // non-fungible asset — a fungible quantity moves via split, not by
    // being "loaded" as a whole unit.
    const loaded = opts.loadout.includes(entry.credential.id);
    html += '<button data-action="toggle-load" data-id="' + entry.credential.id + '">' + (loaded ? 'Unload' : 'Load into this world') + '</button>';
    if (loaded && opts.risky) {
      html += '<button data-action="lose" data-id="' + entry.credential.id + '">Simulate PvP loss</button>';
    }
  }
  if (opts.droppable) {
    html += '<button data-action="drop" data-id="' + entry.credential.id + '" class="btn-secondary">Drop here</button>';
  }
  html += '<button data-action="hide" data-id="' + entry.credential.id + '" class="btn-secondary">Hide</button>';
  html += '</div>';
  el.innerHTML = html;
  container.appendChild(el);
}

// Groups same-wallet FUNGIBLE entries by class + issuer — the two things
// that have to match for balances to be mergeable at all (see
// consolidateAsset in wallet.js). A non-fungible asset is one-of-a-kind by
// definition, so it's never grouped even if another entry shares its
// class — callers pass only the fungible subset in here (see
// renderAssetList below). A group of 2+ gets a header offering to
// consolidate the whole group into one balance; a lone balance renders
// with no header, same as before this feature existed.
function groupFungibleEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.credential.asset.class + '::' + entry.credential.issuer.domain;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()];
}

function renderAssetGroup(group, container, opts) {
  const key = group[0].credential.asset.class + '::' + group[0].credential.issuer.domain;
  if (group.length > 1) {
    const total = group.reduce((sum, e) => sum + e.credential.quantity, 0);
    const header = document.createElement('div');
    header.className = 'resource-group-header';
    header.dataset.group = key;
    header.innerHTML =
      '<span>' + group.length + ' balances of ' + group[0].credential.asset.name + ' (' + total + ' total)</span>' +
      '<button data-action="consolidate-group" data-key="' + key + '">Consolidate</button>';
    container.appendChild(header);
  }
  group.forEach((entry) => renderAssetCard(entry, container, { ...opts, groupKey: group.length > 1 ? key : null }));
}

// Renders one Inventory list (a Yours or Counterparty's column, within
// either the Collectibles or Documents sub-tab): fungible entries grouped
// and offered for consolidation, non-fungible entries rendered
// individually right after.
function renderAssetList(entries, container, opts) {
  const fungible = entries.filter((e) => e.credential.asset.fungible);
  const unique = entries.filter((e) => !e.credential.asset.fungible);
  groupFungibleEntries(fungible).forEach((group) => renderAssetGroup(group, container, opts));
  unique.forEach((entry) => renderAssetCard(entry, container, opts));
}

// The "Dropped in this world" management row — same info-card shape as
// Hidden assets / Recent worlds, and the same reasoning: a click on the
// asset's marker in the scene itself is the primary way to pick it back
// up, but this list is the always-works fallback that doesn't depend on
// finding the marker, being in exactly the right spot, or (for the 2D
// renderer) clicking precisely on a small icon.
function renderDroppedItemCard(entry, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  el.innerHTML =
    '<div class="name">' + entry.credential.asset.name + '</div>' +
    '<div class="meta">' + entry.credential.asset.class + ' · left in the scene</div>' +
    '<div class="item-actions">' +
    '<button data-action="pick-up" data-id="' + entry.credential.id + '">Pick up</button>' +
    '</div>';
  container.appendChild(el);
}

// Inventory (task #44): renders both sub-tabs (Collectibles, Documents —
// split on asset.presentation) from the ONE unified wallet, replacing the
// former separate refreshItemsDisplay()/refreshResourcesDisplay() pair.
async function refreshInventoryDisplay() {
  const identity = await AtlasWallet.getIdentity();
  const counterparty = await AtlasWallet.getCounterparty();
  const loadout = await AtlasWallet.getLoadout();
  const risky = combatOf(currentWorld) !== 'none';
  // refreshInventoryDisplay() runs once, unawaited, at the bottom of this
  // file as soon as the script parses — well before enterWorld() has
  // resolved the manifest fetch and set currentManifest/currentWorld. An
  // identity can already exist at that point (a returning user), so this
  // needs its own guard rather than relying on identity alone, the way
  // combatOf() above already guards on currentWorld being possibly null.
  const droppedHere = (identity && currentManifest && currentWorld)
    ? await AtlasWallet.getDroppedItemsInWorld(identity.publicKey, manifestDomainOf(currentManifest), currentWorld.id)
    : [];

  const selfWalletAll = identity ? await AtlasWallet.getWallet(identity.publicKey) : [];
  // Dropped assets (any world, not just this one — see below) are filtered
  // out here the same way hidden ones are: not in your hands right now, so
  // they don't belong in the normal carrying list. They're not lost —
  // still fully in this wallet's credential store — just visually "left
  // somewhere," surfaced instead via the scene marker and the "Dropped in
  // this world" list below (only for the world they're actually in).
  const allDroppedIds = identity ? new Set((await AtlasWallet.getDroppedItems(identity.publicKey)).map((d) => d.credentialId)) : new Set();
  const selfVisible = selfWalletAll.filter((e) => !e.hidden && !allDroppedIds.has(e.credential.id));

  const cpWalletAll = counterparty ? await AtlasWallet.getWallet(counterparty.publicKey) : [];
  const cpVisible = cpWalletAll.filter((e) => !e.hidden);

  const selfHasAny = (presentation) => selfWalletAll.some((e) => e.credential.asset.presentation === presentation);
  const cpHasAny = (presentation) => cpWalletAll.some((e) => e.credential.asset.presentation === presentation);

  // --- Collectibles ---
  const selfCollectibles = selfVisible.filter((e) => e.credential.asset.presentation === 'collectible');
  const cpCollectibles = cpVisible.filter((e) => e.credential.asset.presentation === 'collectible');
  selfCollectiblesListEl.innerHTML = '';
  if (selfCollectibles.length === 0) {
    selfCollectiblesListEl.innerHTML = '<div class="empty-note">' + (selfHasAny('collectible') ? 'Everything here is hidden or dropped somewhere — manage it below or in Settings.' : 'No collectibles yet.') + '</div>';
  } else {
    renderAssetList(selfCollectibles, selfCollectiblesListEl, { loadable: risky, loadout, risky, droppable: true, otherLabel: 'counterparty' });
  }
  counterpartyCollectiblesListEl.innerHTML = '';
  if (cpCollectibles.length === 0) {
    counterpartyCollectiblesListEl.innerHTML = '<div class="empty-note">' + (cpHasAny('collectible') ? 'Everything here is hidden — manage it in Settings.' : 'Counterparty holds no collectibles yet.') + '</div>';
  } else {
    renderAssetList(cpCollectibles, counterpartyCollectiblesListEl, { loadable: false, droppable: false, otherLabel: 'self' });
  }

  droppedItemsListEl.innerHTML = '';
  droppedItemsSectionEl.hidden = droppedHere.length === 0;
  if (droppedHere.length > 0) {
    const walletById = new Map(selfWalletAll.map((e) => [e.credential.id, e]));
    droppedHere.forEach((d) => {
      const entry = walletById.get(d.credentialId);
      if (entry) renderDroppedItemCard(entry, droppedItemsListEl);
    });
  }

  // --- Documents ---
  const selfDocuments = selfVisible.filter((e) => e.credential.asset.presentation === 'document');
  const cpDocuments = cpVisible.filter((e) => e.credential.asset.presentation === 'document');
  selfDocumentsListEl.innerHTML = '';
  if (selfDocuments.length === 0) {
    selfDocumentsListEl.innerHTML = '<div class="empty-note">' + (selfHasAny('document') ? 'Everything here is hidden — manage it in Settings.' : 'No documents yet.') + '</div>';
  } else {
    renderAssetList(selfDocuments, selfDocumentsListEl, { loadable: risky, loadout, risky, droppable: true, otherLabel: 'counterparty' });
  }
  counterpartyDocumentsListEl.innerHTML = '';
  if (cpDocuments.length === 0) {
    counterpartyDocumentsListEl.innerHTML = '<div class="empty-note">' + (cpHasAny('document') ? 'Everything here is hidden — manage it in Settings.' : 'Counterparty holds no documents yet.') + '</div>';
  } else {
    renderAssetList(cpDocuments, counterpartyDocumentsListEl, { loadable: false, droppable: false, otherLabel: 'self' });
  }

  const totalHeld = selfVisible.length + cpVisible.length;
  walletBadge.textContent = String(totalHeld);
  walletBadge.classList.toggle('show', totalHeld > 0);

  // Every refresh rebuilds these lists from scratch (innerHTML = ''), so
  // any active search text has to be re-applied afterward — it isn't part
  // of the underlying data, just a view-layer filter over freshly-rendered
  // cards.
  applyListFilter(selfCollectiblesListEl, collectiblesSearchInput.value);
  applyListFilter(counterpartyCollectiblesListEl, collectiblesSearchInput.value);
  applyListFilter(selfDocumentsListEl, documentsSearchInput.value);
  applyListFilter(counterpartyDocumentsListEl, documentsSearchInput.value);

  await refreshHiddenAssetsDisplay();
  await refreshRecentWorldsDisplay();
  await refreshAssetUpdatesBadge();
}

// The Wallet tab's own small notification (SPEC.md §5.1.1) — same
// subtab-badge look as mail's unread count, just for "an asset you hold
// was reissued and this wallet already adopted the replacement" instead
// of "new mail arrived". Only ever DISPLAYS the current unseen count;
// marking notices seen is routeWalletScreen()'s job (below), the moment
// the owner actually opens the tab — never here, since
// refreshInventoryDisplay() also runs on page load, well before anyone's
// looked at anything.
async function refreshAssetUpdatesBadge() {
  if (!assetUpdatesBadge) return;
  const identity = await AtlasWallet.getIdentity();
  const notices = identity ? await AtlasWallet.getAssetUpdateNotices(identity.publicKey) : [];
  const unseenCount = notices.filter((n) => !n.seen).length;
  assetUpdatesBadge.textContent = String(unseenCount);
  assetUpdatesBadge.classList.toggle('show', unseenCount > 0);
}

// Rebuilds window.__atlasScene.itemMarkers from whatever's currently
// dropped in THIS world (2D renderer only for now — see the note where
// itemMarkers is set up in enterWorld()'s 3D branch). Called after
// entering a world and after every drop/pick-up, same pattern as the
// portalMarkers it sits alongside.
async function refreshSceneItemMarkers() {
  if (!window.__atlasScene || active3D || !currentManifest || !currentWorld) return;
  const identity = await AtlasWallet.getIdentity();
  if (!identity) {
    window.__atlasScene.itemMarkers = [];
    return;
  }
  const dropped = await AtlasWallet.getDroppedItemsInWorld(identity.publicKey, manifestDomainOf(currentManifest), currentWorld.id);
  if (dropped.length === 0) {
    window.__atlasScene.itemMarkers = [];
    return;
  }
  const wallet = await AtlasWallet.getWallet(identity.publicKey);
  const byId = new Map(wallet.map((e) => [e.credential.id, e]));
  window.__atlasScene.itemMarkers = dropped
    .map((d) => {
      const entry = byId.get(d.credentialId);
      return entry ? { position: d.position, credentialId: d.credentialId, name: entry.credential.asset.name } : null;
    })
    .filter(Boolean);
}

// Entry point for the "Drop here" button on an item card.
function beginDropPlacement(id) {
  if (active3D) {
    // The gltf-mini (3D) renderer doesn't have a place-by-click flow or
    // item-marker rendering yet — drop it immediately with a placeholder
    // position so dropping/picking up still fully works via the "Dropped
    // in this world" list, just without a glowing marker to walk up to
    // here. See the note in wallet.js's dropping-items section.
    finalizeDrop(id, [0, 0, 0]);
    return;
  }
  pendingDropCredentialId = id;
  statusEl.textContent = 'Click where you want to drop it (Esc to cancel).';
  canvas.style.cursor = 'crosshair';
}

async function finalizeDrop(id, position) {
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;
  await AtlasWallet.dropItem(identity.publicKey, id, manifestDomainOf(currentManifest), currentWorld.id, position);
  await refreshInventoryDisplay();
  await refreshSceneItemMarkers();
  statusEl.textContent = 'Dropped. Pick it back up here whenever you like — nobody else can.';
}

async function pickUpDroppedItem(credentialId) {
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;
  await AtlasWallet.pickUpItem(identity.publicKey, credentialId);
  await refreshInventoryDisplay();
  await refreshSceneItemMarkers();
  statusEl.textContent = 'Picked it back up.';
}

// Hides (via the `hidden` attribute, which the existing CSS already
// respects since nothing overrides its default display:none) any
// .wallet-item / .resource-group-header in listEl whose dataset.search
// doesn't contain the query. A resource-group-header stays visible if ANY
// card sharing its dataset.group is still visible after filtering, so
// filtering to one balance inside a multi-balance group doesn't also hide
// that group's "Consolidate" header. Re-run this after every list refresh
// (the lists are fully rebuilt each time) and on every search input event.
function applyListFilter(listEl, rawQuery) {
  if (!listEl) return;
  const query = (rawQuery || '').trim().toLowerCase();
  const cards = listEl.querySelectorAll('.wallet-item, .info-card');
  const groupHasVisible = new Map();
  cards.forEach((card) => {
    const match = !query || (card.dataset.search || '').includes(query);
    card.hidden = !match;
    if (card.dataset.group) {
      groupHasVisible.set(card.dataset.group, groupHasVisible.get(card.dataset.group) || match);
    }
  });
  listEl.querySelectorAll('.resource-group-header').forEach((header) => {
    header.hidden = query && !groupHasVisible.get(header.dataset.group);
  });

  let noMatchEl = listEl.querySelector('.filter-empty-note');
  const anyVisible = Array.from(cards).some((card) => !card.hidden);
  if (query && cards.length > 0 && !anyVisible) {
    if (!noMatchEl) {
      noMatchEl = document.createElement('div');
      noMatchEl.className = 'empty-note filter-empty-note';
      listEl.appendChild(noMatchEl);
    }
    noMatchEl.textContent = 'No matches for "' + rawQuery.trim() + '".';
  } else if (noMatchEl) {
    noMatchEl.remove();
  }
}

collectiblesSearchInput && collectiblesSearchInput.addEventListener('input', () => {
  applyListFilter(selfCollectiblesListEl, collectiblesSearchInput.value);
  applyListFilter(counterpartyCollectiblesListEl, collectiblesSearchInput.value);
});
documentsSearchInput && documentsSearchInput.addEventListener('input', () => {
  applyListFilter(selfDocumentsListEl, documentsSearchInput.value);
  applyListFilter(counterpartyDocumentsListEl, documentsSearchInput.value);
});

// The Settings-screen counterpart to the filtering above: lists every
// hidden asset (self and counterparty) with an Unhide button, so hiding is
// never a one-way trip. Cheap to recompute on every refreshInventoryDisplay —
// this list is normally short, and Settings isn't open most of the time.
function renderHiddenAssetCard(entry, ownerLabel, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  const asset = entry.credential.asset;
  const fungible = !!asset.fungible;
  el.innerHTML =
    '<div class="name">' + asset.name + (fungible ? ' ×' + entry.credential.quantity : '') + '</div>' +
    '<div class="meta">' + asset.class + ' · ' + ownerLabel + '</div>' +
    renderPropertiesToggle(asset.properties) +
    '<div class="item-actions">' +
    '<button data-action="unhide" data-owner="' + ownerLabel + '" data-id="' + entry.credential.id + '">Unhide</button>' +
    '<button data-action="delete" data-owner="' + ownerLabel + '" data-id="' + entry.credential.id + '" class="danger-btn">Delete</button>' +
    '</div>';
  container.appendChild(el);
}

async function refreshHiddenAssetsDisplay() {
  if (!hiddenAssetsListEl) return;
  const identity = await AtlasWallet.getIdentity();
  const counterparty = await AtlasWallet.getCounterparty();
  const selfHidden = identity ? (await AtlasWallet.getWallet(identity.publicKey)).filter((e) => e.hidden) : [];
  const cpHidden = counterparty ? (await AtlasWallet.getWallet(counterparty.publicKey)).filter((e) => e.hidden) : [];
  hiddenAssetsListEl.innerHTML = '';
  if (selfHidden.length === 0 && cpHidden.length === 0) {
    hiddenAssetsListEl.innerHTML = '<div class="empty-note">No hidden assets.</div>';
    return;
  }
  selfHidden.forEach((entry) => renderHiddenAssetCard(entry, 'self', hiddenAssetsListEl));
  cpHidden.forEach((entry) => renderHiddenAssetCard(entry, 'counterparty', hiddenAssetsListEl));
}

hiddenAssetsListEl && hiddenAssetsListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.action === 'toggle-properties') {
    const detail = btn.nextElementSibling;
    if (!detail) return;
    detail.hidden = !detail.hidden;
    btn.classList.toggle('open', !detail.hidden);
    return;
  }
  if (btn.dataset.action !== 'unhide' && btn.dataset.action !== 'delete') return;
  const owner = btn.dataset.owner === 'self' ? await AtlasWallet.getIdentity() : await AtlasWallet.getCounterparty();
  if (!owner) return;
  if (btn.dataset.action === 'delete') {
    // Delete only lives here, in the already-hidden view — a deliberate
    // second step after hiding, not something reachable straight from the
    // main Inventory list. Still irreversible, so still worth a confirm.
    if (!confirm('This permanently removes it — if this was your only copy, it\'s gone for good.')) return;
    await AtlasWallet.deleteAsset(owner.publicKey, btn.dataset.id);
    await refreshHiddenAssetsDisplay();
    return;
  }
  await AtlasWallet.unhideAsset(owner.publicKey, btn.dataset.id);
  await refreshInventoryDisplay();
});

// ---------- recent worlds (Settings -> "Recent worlds") ----------

function renderRecentWorldCard(entry, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  const isHere = !!(currentWorld && currentManifest && entry.domain === currentManifest.domain && entry.world === currentWorld.id);
  el.innerHTML =
    '<div class="name">' + entry.worldName + '</div>' +
    '<div class="meta">' + entry.domain + ' · ' + entry.world + '</div>' +
    '<div class="item-actions">' +
    (isHere
      ? '<span class="empty-note">You are here</span>'
      : '<button data-action="travel" data-manifest="' + entry.manifestUrl + '" data-world="' + entry.world + '">Go</button>') +
    '</div>';
  container.appendChild(el);
}

async function refreshRecentWorldsDisplay() {
  if (!recentWorldsListEl) return;
  const list = await AtlasWallet.getRecentWorlds();
  recentWorldsListEl.innerHTML = '';
  if (list.length === 0) {
    recentWorldsListEl.innerHTML = '<div class="empty-note">Nowhere visited yet.</div>';
    return;
  }
  list.forEach((entry) => renderRecentWorldCard(entry, recentWorldsListEl));
}

// Re-fetches that domain's manifest and enters the specific recorded world
// (not necessarily the manifest's defaultWorld), then closes the wallet
// panel so the newly entered scene is visible — the same effect as
// following a portal, just triggered from Settings instead of the scene.
async function travelToRecentWorld(manifestUrl, worldId) {
  try {
    await loadManifest(manifestUrl, worldId);
    walletPanel.classList.remove('open');
  } catch (err) {
    statusEl.textContent = 'Could not travel there: ' + err.message;
  }
}

recentWorldsListEl && recentWorldsListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.dataset.action !== 'travel') return;
  await travelToRecentWorld(btn.dataset.manifest, btn.dataset.world);
});


// ---------- wallet: onboarding / unlock / create / import / export ----------
//
// One identity, one password. hasIdentity() says whether this device has
// ever set one up; isUnlocked() says whether it's been unlocked THIS
// browser session (chrome.storage.session — memory-only, cleared when the
// browser fully closes). Opening the wallet routes to exactly the right
// screen for that state; every action below re-routes afterward.

walletBtn.addEventListener('click', async () => {
  if (walletPanel.classList.contains('open')) {
    walletPanel.classList.remove('open');
    return;
  }
  walletPanel.classList.add('open');
  await routeWalletScreen();
});

// Escape acts like a pause-menu key: it toggles the wallet, same as
// clicking the Wallet button.
//
// This used to also drive the browser's real Fullscreen API (a dedicated
// button for entering it, Escape/exitFullscreen() for leaving) — removed
// after real-browser testing turned up "API can only be initiated by a
// user gesture" on requestFullscreen() even from a direct in-document
// click in some cases, and activation from a keyboard event doesn't
// reliably propagate into this cross-origin extension iframe at all — a
// known rough edge for gesture-gated APIs in nested iframes, not
// something fixable from this side. Replaced with a plain "F11 for
// fullscreen" hint (see #scene3dHint in viewer.html) — the browser's own
// native fullscreen shortcut works everywhere with zero iframe-activation
// nonsense, so there's no reason to fight the API for something the user
// can already do themselves in one keypress.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;
  if (walletPanel.classList.contains('open')) {
    walletPanel.classList.remove('open');
  } else {
    walletPanel.classList.add('open');
    routeWalletScreen();
  }
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'session' && changes.atlasUnlockedIdentity) {
    await refreshIdentityDisplay();
  }
});

chooseNewBtn.addEventListener('click', () => showWalletScreen('createScreen'));
backFromCreateBtn.addEventListener('click', backToWalletHome);
createScreenImportInsteadBtn.addEventListener('click', () => showWalletScreen('importScreen'));
chooseImportBtn.addEventListener('click', () => showWalletScreen('importScreen'));
backFromImportBtn.addEventListener('click', backToWalletHome);
chooseWebAuthnBtn.addEventListener('click', () => showWalletScreen('webauthnCreateScreen'));
backFromWebAuthnCreateBtn.addEventListener('click', backToWalletHome);

confirmWebAuthnCreateBtn.addEventListener('click', async () => {
  confirmWebAuthnCreateBtn.disabled = true;
  webauthnCreateScreenStatus.textContent = 'Waiting for your passkey…';
  try {
    await AtlasWallet.createWebAuthnIdentity();
    webauthnCreateScreenStatus.textContent = '';
    showWalletScreen('mainWalletScreen');
    await refreshIdentityDisplay();
    await refreshInventoryDisplay();
  } catch (err) {
    webauthnCreateScreenStatus.textContent = err.message;
  } finally {
    confirmWebAuthnCreateBtn.disabled = false;
  }
});

switchIdentityModeBtn.addEventListener('click', async () => {
  const mode = await AtlasWallet.getIdentityMode();
  const targetMode = mode === 'webauthn' ? 'local' : 'webauthn';
  const targetExists = targetMode === 'local' ? await AtlasWallet.hasLocalIdentity() : await AtlasWallet.hasWebAuthnIdentity();

  if (!targetExists) {
    // Nothing to switch to yet — send the user to set it up. Those
    // screens' own confirm handlers activate the new identity as "self"
    // automatically (see createIdentity()/createWebAuthnIdentity() in
    // wallet.js), so returning here will find the switch already done.
    showWalletScreen(targetMode === 'local' ? 'createScreen' : 'webauthnCreateScreen');
    return;
  }

  switchIdentityModeBtn.disabled = true;
  try {
    await AtlasWallet.setIdentityMode(targetMode);
    await routeWalletScreen();
  } catch (err) {
    statusEl.textContent = 'Switch failed: ' + err.message;
  } finally {
    switchIdentityModeBtn.disabled = false;
  }
});

confirmCreateBtn.addEventListener('click', async () => {
  createScreenStatus.textContent = '';
  if (newPasswordInput.value !== newPasswordConfirmInput.value) {
    createScreenStatus.textContent = 'Passwords do not match.';
    return;
  }
  confirmCreateBtn.disabled = true;
  try {
    const { seedPhrase } = await AtlasWallet.createIdentity(newPasswordInput.value);
    newPasswordInput.value = '';
    newPasswordConfirmInput.value = '';
    showWalletScreen(null);
    seedPhraseTextEl.textContent = seedPhrase;
    seedConfirmCheck.checked = false;
    seedConfirmBtn.disabled = true;
    seedRevealBox.classList.add('show');
  } catch (err) {
    createScreenStatus.textContent = err.message;
  } finally {
    confirmCreateBtn.disabled = false;
  }
});

seedConfirmCheck.addEventListener('change', () => {
  seedConfirmBtn.disabled = !seedConfirmCheck.checked;
});

seedConfirmBtn.addEventListener('click', async () => {
  seedRevealBox.classList.remove('show');
  seedPhraseTextEl.textContent = '';
  showWalletScreen('mainWalletScreen');
  await refreshIdentityDisplay();
  await refreshInventoryDisplay();
});

let pendingOnboardImportFile = null;
onboardImportFileInput.addEventListener('change', async () => {
  pendingOnboardImportFile = null;
  const file = onboardImportFileInput.files && onboardImportFileInput.files[0];
  if (!file) return;
  try {
    pendingOnboardImportFile = JSON.parse(await file.text());
    importScreenStatus.textContent = 'File loaded — enter its password and seed phrase.';
  } catch (err) {
    importScreenStatus.textContent = 'Could not read that file: ' + err.message;
  }
});

confirmImportBtn.addEventListener('click', async () => {
  if (!pendingOnboardImportFile) {
    importScreenStatus.textContent = 'Choose a backup file first.';
    return;
  }
  confirmImportBtn.disabled = true;
  importScreenStatus.textContent = 'Decrypting…';
  try {
    await AtlasWallet.importIdentity(pendingOnboardImportFile, onboardImportPasswordInput.value, onboardImportSeedInput.value);
    onboardImportPasswordInput.value = '';
    onboardImportSeedInput.value = '';
    showWalletScreen('mainWalletScreen');
    await refreshIdentityDisplay();
    await refreshInventoryDisplay();
  } catch (err) {
    // Deliberately the same message whether the password, the seed
    // phrase, or both were wrong — see wallet.js's importIdentity.
    importScreenStatus.textContent = err.message;
  } finally {
    confirmImportBtn.disabled = false;
  }
});

unlockBtn.addEventListener('click', async () => {
  unlockBtn.disabled = true;
  unlockScreenStatus.textContent = 'Unlocking…';
  try {
    await AtlasWallet.unlockIdentity(unlockPasswordInput.value);
    unlockPasswordInput.value = '';
    unlockScreenStatus.textContent = '';
    showWalletScreen('mainWalletScreen');
    await refreshIdentityDisplay();
    await refreshInventoryDisplay();
  } catch (err) {
    unlockScreenStatus.textContent = err.message;
  } finally {
    unlockBtn.disabled = false;
  }
});

lockWalletBtn.addEventListener('click', async () => {
  await AtlasWallet.lockIdentity();
  walletPanel.classList.remove('open');
  await refreshQuickLockButtonVisibility();
});

// Quick lock (#67 follow-up): the same lockIdentity() call as the Settings
// button above, reachable straight from the top control bar without
// opening the wallet panel first — for "I need to lock this RIGHT now"
// rather than "I'm already in Settings anyway". Doesn't touch
// walletPanel's open/closed state at all (unlike the Settings button,
// which always closes it) — locking works the same whether the panel
// happens to be open or not, and closing it as a side effect here would
// be surprising if it was already open to something else, like Items.
async function refreshQuickLockButtonVisibility() {
  if (!quickLockWalletBtn) return;
  quickLockWalletBtn.style.display = (await AtlasWallet.isUnlocked()) ? '' : 'none';
}

quickLockWalletBtn && quickLockWalletBtn.addEventListener('click', async () => {
  await AtlasWallet.lockIdentity();
  await refreshQuickLockButtonVisibility();
  // If the wallet panel happens to be open to a screen that only makes
  // sense unlocked (mainWalletScreen, say), route it to wherever locking
  // now actually leads — same re-routing routeWalletScreen already does
  // after the Settings lock button, just triggered from here too so the
  // two lock buttons behave consistently no matter which one was used.
  if (walletPanel.classList.contains('open')) await routeWalletScreen();
});

// Collapsible categories: a .settings-category has a heading (the
// .settings-category-toggle button) and a body (.settings-category-body)
// that's shown only while its category carries an .open class — present in
// the HTML by default on categories meant to start open (Items and
// Resources on the main wallet screen), absent on ones that start closed
// (everything on Settings, plus Identity / Counterparty's items / Trading
// station / Recent worlds on the main wallet screen). One delegated
// listener on walletPanel — the shared ancestor of every wallet-screen —
// covers both screens' categories, and any future one, without needing a
// listener per screen.
walletPanel.addEventListener('click', (e) => {
  const toggle = e.target.closest('.settings-category-toggle');
  if (!toggle) return;
  toggle.closest('.settings-category').classList.toggle('open');
});

// Reached via the top tab bar's Settings tab (settingsTabBtn below) — used
// to also be reachable via a redundant gear-icon button pinned to the
// bottom of #mainWalletScreen, removed once the top tab bar made it a
// second way to get to the exact same place.
async function openSettings() {
  await refreshIdentityModeControls();
  await refreshHiddenAssetsDisplay();
  await refreshCacheDisplay();
  if (characterScaleInputEl) {
    const scale = await AtlasWallet.getCharacterScale();
    characterScaleInputEl.value = String(scale);
    if (characterScaleValueEl) characterScaleValueEl.textContent = scale.toFixed(1) + '×';
  }
  if (autoLockMinutesInput) autoLockMinutesInput.value = String(await AtlasWallet.getAutoLockMinutes());
  showWalletScreen('settingsScreen');
}

// 'input' (not 'change') so it applies while dragging the slider, not just
// on release — and takes effect immediately in whatever 3D world is
// currently open (active3D.setCharacterScale), same "changes should be
// felt right away" expectation as every other live wallet setting.
characterScaleInputEl && characterScaleInputEl.addEventListener('input', async () => {
  const scale = await AtlasWallet.setCharacterScale(characterScaleInputEl.value);
  if (characterScaleValueEl) characterScaleValueEl.textContent = scale.toFixed(1) + '×';
  if (active3D && active3D.setCharacterScale) active3D.setCharacterScale(scale);
});

backFromSettingsBtn.addEventListener('click', routeWalletScreen);

// Top tab bar (Wallet / Social / Settings) — a direct jump between the
// screens that already exist, wired to the exact same logic as the Back
// button above, just reachable without the extra hop.
walletTabBtn && walletTabBtn.addEventListener('click', routeWalletScreen);
settingsTabBtn && settingsTabBtn.addEventListener('click', openSettings);

// ---------- mail (Wallet -> Mail tab) ----------
//
// A message a domain sent about a credential you hold — see
// AtlasWallet.checkAllMail() for the actual fetch-and-verify logic. This
// section is just the tab: opening it, rendering what's stored, letting
// the user trigger a check by hand, and the check-frequency setting. The
// periodic background loop that runs this automatically lives further
// below, right after the file finishes wiring up every button.

// Task #75/#87: Post Office mail means subject/body can now come from an
// arbitrary stranger (anyone who knows a recipient's public key and Post
// Office domain), not just a domain operator this demo already implicitly
// trusted — every renderMailCard field that carries sender-supplied text
// goes through this before hitting innerHTML, closing off the injection
// this widened trust boundary would otherwise open (a crafted subject or
// body running script in the extension's own privileged context the
// moment the recipient opens Mail). Applied to domain-to-subscriber mail's
// fields too, at zero cost, rather than leaving one call path escaped and
// the other not.
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMailCard(entry, container) {
  const el = document.createElement('div');
  el.className = 'wallet-item mail-card' + (entry.read ? '' : ' unread');
  el.dataset.id = entry.message.id;
  const sentAt = new Date(entry.message.sentAt).toLocaleString();
  const gift = entry.message.attachedAsset;
  // Task #75/#87: a Post Office-relayed message carries `from` — who it's
  // actually from — distinct from `domain`, which for THIS kind of message
  // names the relaying domain, not the sender. Ordinary domain-to-subscriber
  // mail has no `from` at all (the domain itself is implicitly the sender),
  // so this only ever shows up on relayed mail.
  //
  // Task #94 (handle addressing): if the sender had a handle registered at
  // send time, the relaying domain stamped it onto `from.handle` (see
  // server.js's own comment on the send handler) — showing "From
  // bruno#domain" instead of a raw key fragment is the whole payoff of
  // that: nothing to resolve here, the domain already did it.
  const fromLine = entry.message.from
    ? 'From ' + (entry.message.from.handle
        ? escapeHtml(entry.message.from.handle) + '#' + escapeHtml(entry.message.domain)
        : escapeHtml(entry.message.from.publicKey.slice(0, 20)) + '… via ' + escapeHtml(entry.message.domain))
    : escapeHtml(entry.message.domain);
  // Task #59: a message can carry an attached gift, sitting inert until
  // claimed (see AtlasWallet.claimMailGift — deliberately never
  // auto-added, so this button is the only path a gift ever enters the
  // wallet). Plain text, no thumbnail — same style every other wallet
  // item card in this file already uses (renderAssetCard never renders
  // asset.thumbnail either), so a gift notice doesn't stand out as a
  // special case visually, just in what it lets you do.
  const giftHtml = !gift ? '' :
    '<div class="mail-gift">Gift: ' + escapeHtml(gift.asset.name) + (gift.quantity > 1 ? ' ×' + gift.quantity : '') +
    (entry.claimed
      ? ' <span class="mail-gift-claimed">(claimed)</span>'
      : ' <button type="button" data-action="claim-gift">Claim</button>') +
    '</div>';
  // Task #94 (consent/block model): only relayed mail (has `from`) has a
  // sender worth blocking — ordinary domain-to-subscriber mail's "sender"
  // IS the domain, and blocking that would just be a confusing way to spell
  // deleting/unsubscribing, so this button only ever shows up on the same
  // kind of card fromLine above already treats specially.
  const blockHtml = !entry.message.from ? '' :
    '<button type="button" data-action="block-sender" data-domain="' + escapeHtml(entry.message.domain) + '" data-key="' + escapeHtml(entry.message.from.publicKey) + '">Block sender</button>';
  el.innerHTML =
    '<div class="mail-domain">' + fromLine + '</div>' +
    '<div class="mail-subject">' + escapeHtml(entry.message.subject) + '</div>' +
    '<div class="mail-meta">' + sentAt + (entry.read ? '' : ' · unread') + '</div>' +
    '<div class="mail-body">' + escapeHtml(entry.message.body) + '</div>' +
    giftHtml +
    '<div class="item-actions">' +
    '<button type="button" data-action="delete" class="danger-btn">Delete</button>' +
    blockHtml +
    '</div>';
  container.appendChild(el);
}

async function refreshMailDisplay() {
  const identity = await AtlasWallet.getIdentity();
  const entries = identity ? await AtlasWallet.getMail(identity.publicKey) : [];
  const unreadCount = entries.filter((e) => !e.read).length;

  mailBadge.textContent = String(unreadCount);
  mailBadge.classList.toggle('show', unreadCount > 0);
  // Same count, mirrored one level deeper onto the Inbox sub-tab itself —
  // the outer badge above says "something needs attention in Mail" before
  // you've even opened it; this one says so again right where the actual
  // Inbox tab is, now that Inbox/Sent/Compose are separate tabs.
  if (mailBoxInboxBadge) {
    mailBoxInboxBadge.textContent = String(unreadCount);
    mailBoxInboxBadge.classList.toggle('show', unreadCount > 0);
  }

  if (mailListEl) {
    mailListEl.innerHTML = '';
    if (entries.length === 0) {
      mailListEl.innerHTML = '<div class="empty-note">No mail yet.</div>';
    } else {
      entries.forEach((entry) => renderMailCard(entry, mailListEl));
    }
  }

  if (mailLastCheckedEl) {
    const settings = await AtlasWallet.getMailSettings();
    mailLastCheckedEl.textContent = settings.lastCheckedAt
      ? 'Last checked ' + new Date(settings.lastCheckedAt).toLocaleString()
      : 'Not checked yet.';
    if (mailIntervalInput) mailIntervalInput.value = settings.intervalMinutes;
  }
  await updateSocialBadge();
}

// Sent tab: a purely local record (AtlasWallet.getSentMail — see its own
// comment on why this exists at all, and sendUserMail's on how entries get
// added) of what this wallet has sent through a Post Office. Same card
// shape/styling as renderMailCard above (.mail-card), just a "To" line
// instead of "From" and no unread/gift/block affordances — none of those
// concepts apply to a message you sent yourself.
function renderSentMailCard(entry, container) {
  const el = document.createElement('div');
  el.className = 'wallet-item mail-card';
  el.dataset.id = entry.id;
  const sentAt = new Date(entry.sentAt).toLocaleString();
  const toLine = entry.to.handle
    ? 'To ' + escapeHtml(entry.to.handle) + '#' + escapeHtml(entry.domain)
    : 'To ' + escapeHtml(entry.to.publicKey.slice(0, 20)) + '… via ' + escapeHtml(entry.domain);
  el.innerHTML =
    '<div class="mail-domain">' + toLine + '</div>' +
    '<div class="mail-subject">' + escapeHtml(entry.subject) + '</div>' +
    '<div class="mail-meta">' + sentAt + '</div>' +
    '<div class="mail-body">' + escapeHtml(entry.body) + '</div>' +
    '<div class="item-actions">' +
    '<button type="button" data-action="delete-sent" class="danger-btn">Delete</button>' +
    '</div>';
  container.appendChild(el);
}

async function refreshSentMailDisplay() {
  if (!sentMailListEl) return;
  const identity = await AtlasWallet.getIdentity();
  const entries = identity ? await AtlasWallet.getSentMail(identity.publicKey) : [];
  sentMailListEl.innerHTML = '';
  if (entries.length === 0) {
    sentMailListEl.innerHTML = '<div class="empty-note">No sent mail yet.</div>';
  } else {
    entries.forEach((entry) => renderSentMailCard(entry, sentMailListEl));
  }
}

sentMailListEl && sentMailListEl.addEventListener('click', async (e) => {
  const deleteBtn = e.target.closest('button[data-action="delete-sent"]');
  if (!deleteBtn) return;
  const card = e.target.closest('.mail-card');
  const identity = await AtlasWallet.getIdentity();
  if (!identity || !card) return;
  if (!confirm('Delete this sent message from your local history? This cannot be undone.')) return;
  await AtlasWallet.deleteSentMailMessage(identity.publicKey, card.dataset.id);
  await refreshSentMailDisplay();
});

clearSentMailBtn && clearSentMailBtn.addEventListener('click', async () => {
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;
  if (!confirm('Clear your ENTIRE sent-mail history? This only removes your local record — it cannot be undone.')) return;
  await AtlasWallet.clearAllSentMail(identity.publicKey);
  await refreshSentMailDisplay();
});

// Combined badge on the top-level Social tab (#61/#67) — unread mail plus
// pending incoming friend requests, so there's a single "something needs
// your attention in here" signal even while the panel's closed and nobody
// can see which sub-tab would show it. Each sub-tab ALSO carries its own
// count (mailBadge, friendRequestsBadge) for once you're actually looking.
async function updateSocialBadge() {
  const identity = await AtlasWallet.getIdentity();
  const entries = identity ? await AtlasWallet.getMail(identity.publicKey) : [];
  const unreadMail = entries.filter((e) => !e.read).length;
  if (friendRequestsBadge) {
    friendRequestsBadge.textContent = String(presencePendingIncoming.length);
    friendRequestsBadge.classList.toggle('show', presencePendingIncoming.length > 0);
  }
  if (socialBadge) {
    const total = unreadMail + presencePendingIncoming.length;
    socialBadge.textContent = String(total);
    socialBadge.classList.toggle('show', total > 0);
  }
}

mailListEl && mailListEl.addEventListener('click', async (e) => {
  const card = e.target.closest('.mail-card');
  if (!card) return;
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;

  const deleteBtn = e.target.closest('button[data-action="delete"]');
  if (deleteBtn) {
    // No hide-then-delete two-step here (unlike items/resources — see
    // #43) — a mail message isn't an asset worth a recycle-bin state, so
    // this is a direct delete, same confirm() guard as Clear all below.
    if (!confirm('Delete this message? This cannot be undone.')) return;
    await AtlasWallet.deleteMailMessage(identity.publicKey, card.dataset.id);
    await refreshMailDisplay();
    return;
  }

  // Task #59: the explicit Claim action — the only path a message's
  // attached gift ever enters the wallet (see AtlasWallet.claimMailGift's
  // own header note on why this is deliberately never automatic).
  // refreshInventoryDisplay() picks up the newly-added credential the
  // same way every other mint/collect action on this screen already
  // does; refreshMailDisplay() re-renders this card showing "(claimed)"
  // in place of the button.
  const claimBtn = e.target.closest('button[data-action="claim-gift"]');
  if (claimBtn) {
    try {
      const { credential } = await AtlasWallet.claimMailGift(identity.publicKey, card.dataset.id);
      await refreshInventoryDisplay();
      await refreshMailDisplay();
      statusEl.textContent = 'Claimed ' + credential.asset.name + '.';
    } catch (err) {
      statusEl.textContent = 'Claim failed: ' + err.message;
    }
    return;
  }

  // Task #94 (consent/block model): the fast path straight from a message
  // you're already looking at — same block underneath as the "Who can
  // mail you" panel's own Block field, just pre-filled from this card
  // instead of asking you to go copy the sender's key over there by hand.
  const blockBtn = e.target.closest('button[data-action="block-sender"]');
  if (blockBtn) {
    const domain = blockBtn.dataset.domain;
    const key = blockBtn.dataset.key;
    if (!confirm('Block this sender at ' + domain + '? They won\'t be able to mail you through that Post Office anymore.')) return;
    blockBtn.disabled = true;
    blockBtn.textContent = 'Blocking…';
    try {
      await AtlasWallet.blockPostOfficeSender(domain, key);
      blockBtn.textContent = 'Blocked';
      // Keep the settings panel in sync if it's currently showing the same
      // membership this block just landed on.
      if (postOfficeSettingsDomainInput && postOfficeSettingsDomainInput.value === domain) {
        await loadPostOfficeSettings();
      }
    } catch (err) {
      blockBtn.disabled = false;
      blockBtn.textContent = 'Block sender';
      statusEl.textContent = 'Block failed: ' + err.message;
    }
    return;
  }

  if (!card.classList.contains('unread')) return;
  await AtlasWallet.markMailRead(identity.publicKey, card.dataset.id);
  await refreshMailDisplay();
});

markAllMailReadBtn && markAllMailReadBtn.addEventListener('click', async () => {
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;
  await AtlasWallet.markAllMailRead(identity.publicKey);
  await refreshMailDisplay();
});

clearAllMailBtn && clearAllMailBtn.addEventListener('click', async () => {
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;
  if (!confirm('Delete ALL mail messages? This cannot be undone.')) return;
  await AtlasWallet.clearAllMail(identity.publicKey);
  await refreshMailDisplay();
});

// Opening the Social tab lands on the Mail sub-tab by default (where the
// standalone Mail tab used to open directly) — Friends/Favorites are one
// click further in via socialSubtabBar, not a second top-level tab.
// Opening the Mail tab (either directly, or by landing on it as Social's
// default sub-tab) now also triggers a real mail check — same underlying
// AtlasWallet.checkAllMail() the "Check now" button and the periodic
// background loop already use. Errors are swallowed the same way
// checkMailNowBtn's own handler swallows them below: checkAllMail already
// handles a single unreachable domain internally, so anything that gets
// here would be something more fundamental (no identity yet, etc.) that
// silently not-checking is the right response to.
async function checkMailOnTabOpen() {
  try {
    await AtlasWallet.checkAllMail();
  } catch (err) {
    // nothing to show for this — see comment above
  }
}

socialTabBtn && socialTabBtn.addEventListener('click', async () => {
  showWalletScreen('socialScreen');
  showSocialSubtab('mailSubscreen');
  await checkMailOnTabOpen();
  await refreshMailDisplay();
  await refreshSubscribeButton();
  await refreshPostOfficeJoinButton();
  await refreshMyPublicKeyDisplay();
  await refreshInventoryDisplay();
});

mailSubtabBtn && mailSubtabBtn.addEventListener('click', async () => {
  showSocialSubtab('mailSubscreen');
  await checkMailOnTabOpen();
  await refreshMailDisplay();
  await refreshSubscribeButton();
  await refreshPostOfficeJoinButton();
  await refreshMyPublicKeyDisplay();
  await refreshInventoryDisplay();
});

friendsSubtabBtn && friendsSubtabBtn.addEventListener('click', async () => {
  showSocialSubtab('friendsSubscreen');
  await refreshFriendsDisplay();
});

favoritesSubtabBtn && favoritesSubtabBtn.addEventListener('click', async () => {
  showSocialSubtab('favoritesSubscreen');
  await refreshFavoritesDisplay();
});

// Mail's own inner sub-tab bar (Mail / Mail Settings) — data underneath is
// already current from whatever last refreshed it (checkMailOnTabOpen +
// refreshMailDisplay/refreshMyPublicKeyDisplay above, both of which run
// regardless of which inner sub-tab happens to be showing), so switching
// is just a visibility toggle, same as Inventory's Collectibles/Documents.
mailInboxSubtabBtn && mailInboxSubtabBtn.addEventListener('click', () => showMailInnerSubtab('mailInboxSubscreen'));
mailSettingsSubtabBtn && mailSettingsSubtabBtn.addEventListener('click', () => showMailInnerSubtab('mailSettingsSubscreen'));

// The "Mail" heading's own Inbox/Sent/Compose tabs. Inbox and Compose need
// no refresh on click — both are kept current by whatever last called
// refreshMailDisplay()/refreshMyPublicKeyDisplay() (checkMailOnTabOpen
// above, or any send/mark-read/delete action), same lazy convention as
// Collectibles/Documents. Sent is the one sub-tab nothing else keeps
// current, so it refreshes itself on the way in.
mailBoxInboxSubtabBtn && mailBoxInboxSubtabBtn.addEventListener('click', () => showMailBoxSubtab('mailBoxInboxSubscreen'));
mailBoxSentSubtabBtn && mailBoxSentSubtabBtn.addEventListener('click', async () => {
  showMailBoxSubtab('mailBoxSentSubscreen');
  await refreshSentMailDisplay();
});
mailBoxComposeSubtabBtn && mailBoxComposeSubtabBtn.addEventListener('click', () => showMailBoxSubtab('mailBoxComposeSubscreen'));

// Inventory's own sub-tab bar (task #44) — Collectibles/Documents, same
// click-to-switch idea as Social's sub-tabs right above. Data is already
// current from whatever last called refreshInventoryDisplay() (opening
// the Wallet tab, or any asset action), so switching sub-tabs is just a
// visibility toggle — no extra fetch needed.
collectiblesSubtabBtn && collectiblesSubtabBtn.addEventListener('click', () => showInventorySubtab('collectiblesSubscreen'));
documentsSubtabBtn && documentsSubtabBtn.addEventListener('click', () => showInventorySubtab('documentsSubscreen'));

// "Subscribing" is just requesting the current domain's atlas.membership
// item directly (see AtlasWallet.checkAllMail's design note: holding the
// credential IS the subscription) — deliberately independent of
// requestItemBtn / any world's acceptedItemClasses, since this is
// "subscribe to the domain you're in", not "pick up this world's
// collectible". The whole #subscribeSection (heading, explainer text,
// button, status line) is hidden entirely, not just the button, once you
// already hold that domain's membership card — nothing further to do, and
// no orphaned "Subscribe" heading left sitting over nothing.
async function alreadyHasMembership(domain) {
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return false;
  const wallet = await AtlasWallet.getWallet(identity.publicKey);
  return wallet.some((e) => e.credential.asset.class === 'atlas.membership' && e.credential.issuer.domain === domain);
}

async function refreshSubscribeButton() {
  if (!subscribeSectionEl) return;
  if (subscribeStatusEl) subscribeStatusEl.textContent = '';
  if (!currentManifest) {
    subscribeSectionEl.hidden = true;
    return;
  }
  const domain = manifestDomainOf(currentManifest);
  if (await alreadyHasMembership(domain)) {
    subscribeSectionEl.hidden = true;
    return;
  }
  subscribeSectionEl.hidden = false;
  subscribeBtn.disabled = false;
  subscribeBtn.textContent = 'Subscribe to ' + domain;
}

async function alreadyHasPostOfficeMembership(domain) {
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return false;
  const wallet = await AtlasWallet.getWallet(identity.publicKey);
  return wallet.some((e) => e.credential.asset.class === 'atlas.postoffice.membership' && e.credential.issuer.domain === domain);
}

// Task #94 — mirrors refreshSubscribeButton() above exactly, same
// "hidden entirely once already true, not just disabled" convention.
// Gated on manifest.postOffice (the new optional field, see the HTML
// comment on #postOfficeJoinSection) in addition to not already being a
// member, so this only ever appears where there's actually something to
// join — a domain that hasn't opted in never shows it, same as a domain
// with no presence field just falling back to the default rather than
// something breaking.
async function refreshPostOfficeJoinButton() {
  if (!postOfficeJoinSectionEl) return;
  if (postOfficeJoinStatusEl) postOfficeJoinStatusEl.textContent = '';
  if (!currentManifest || !currentManifest.postOffice) {
    postOfficeJoinSectionEl.hidden = true;
    return;
  }
  const domain = manifestDomainOf(currentManifest);
  if (await alreadyHasPostOfficeMembership(domain)) {
    postOfficeJoinSectionEl.hidden = true;
    return;
  }
  postOfficeJoinSectionEl.hidden = false;
  postOfficeJoinBtn.disabled = false;
  postOfficeJoinBtn.textContent = 'Join ' + domain + '\'s Post Office';
}

// Post Office (task #75/#87): just surfaces this identity's own public key
// so it's easy to copy and hand to whoever should be able to mail you —
// no wallet state to check, unlike refreshSubscribeButton above, since
// having an address doesn't depend on holding anything from any domain.
// Also refreshes the "send via" options below it (task #94) since both
// are driven by the same identity lookup and belong on the same screen.
async function refreshMyPublicKeyDisplay() {
  const identity = await AtlasWallet.getIdentity();
  if (myPublicKeyDisplayEl) myPublicKeyDisplayEl.value = identity ? identity.publicKey : '';
  await refreshPostOfficeSendOptions(identity);
  await refreshPostOfficeSettingsDomainOptions(identity);
}

// Post Office (task #94): membership is symmetric now — a domain only
// relays mail between two people who BOTH hold ITS OWN Global Mail card —
// so "send via" has to be one of the Post Offices this wallet has
// actually joined, not a domain typed in freehand. Rebuilds the select
// from AtlasWallet.getPostOfficeMemberships(), preserving the current
// selection across refreshes where it's still valid (e.g. after sending).
// Failing that, falls back to whichever domain this wallet last actually
// sent through (AtlasWallet.getLastPostOfficeSendDomain — set by
// sendUserMail itself on a confirmed send, not on every dropdown nudge),
// so a wallet with one regular Post Office doesn't have to reselect it
// on every visit to Compose.
async function refreshPostOfficeSendOptions(identity) {
  if (!postOfficeToDomainInput) return;
  const previousValue = postOfficeToDomainInput.value;
  const memberships = identity ? await AtlasWallet.getPostOfficeMemberships(identity.publicKey) : [];

  postOfficeToDomainInput.innerHTML = '';
  if (!memberships.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No Post Office memberships yet';
    postOfficeToDomainInput.appendChild(opt);
    postOfficeToDomainInput.disabled = true;
    return;
  }

  postOfficeToDomainInput.disabled = false;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a Post Office you belong to…';
  postOfficeToDomainInput.appendChild(placeholder);

  const seen = new Set();
  for (const m of memberships) {
    if (seen.has(m.domain)) continue; // a wallet can hold at most one live membership per domain in practice, but dedupe defensively
    seen.add(m.domain);
    const opt = document.createElement('option');
    opt.value = m.domain;
    opt.textContent = m.domain;
    postOfficeToDomainInput.appendChild(opt);
  }
  if (seen.has(previousValue)) {
    postOfficeToDomainInput.value = previousValue;
  } else if (identity) {
    const lastUsed = await AtlasWallet.getLastPostOfficeSendDomain(identity.publicKey);
    if (lastUsed && seen.has(lastUsed)) postOfficeToDomainInput.value = lastUsed;
  }
}

// Task #94 (consent/block model): the domain picker for the "Who can mail
// you" panel — same "only Post Offices this wallet has actually joined"
// source as refreshPostOfficeSendOptions right above, since settings only
// mean anything against a membership that actually exists. A separate
// select from the "send via" one above rather than reusing it: they answer
// different questions (who to send THROUGH vs. whose inbox to configure)
// and can reasonably end up pointed at different domains at the same time.
async function refreshPostOfficeSettingsDomainOptions(identity) {
  if (!postOfficeSettingsDomainInput) return;
  const previousValue = postOfficeSettingsDomainInput.value;
  const memberships = identity ? await AtlasWallet.getPostOfficeMemberships(identity.publicKey) : [];

  postOfficeSettingsDomainInput.innerHTML = '';
  if (!memberships.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No Post Office memberships yet';
    postOfficeSettingsDomainInput.appendChild(opt);
    postOfficeSettingsDomainInput.disabled = true;
    await renderPostOfficeSettings(null);
    return;
  }

  postOfficeSettingsDomainInput.disabled = false;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a Post Office you belong to…';
  postOfficeSettingsDomainInput.appendChild(placeholder);

  const seen = new Set();
  for (const m of memberships) {
    if (seen.has(m.domain)) continue;
    seen.add(m.domain);
    const opt = document.createElement('option');
    opt.value = m.domain;
    opt.textContent = m.domain;
    postOfficeSettingsDomainInput.appendChild(opt);
  }
  if (seen.has(previousValue)) {
    postOfficeSettingsDomainInput.value = previousValue;
    await loadPostOfficeSettings();
    return;
  }
  // Falls back to whichever domain this wallet last picked here
  // (AtlasWallet.getLastPostOfficeSettingsDomain — persisted by the
  // picker's own 'change' handler below), same UI convenience as
  // refreshPostOfficeSendOptions above, so a wallet with one regular Post
  // Office doesn't have to reselect it on every visit to Mail Settings.
  const lastUsed = identity ? await AtlasWallet.getLastPostOfficeSettingsDomain(identity.publicKey) : null;
  if (lastUsed && seen.has(lastUsed)) {
    postOfficeSettingsDomainInput.value = lastUsed;
    await loadPostOfficeSettings();
  } else {
    await renderPostOfficeSettings(null);
  }
}

// Fetches the currently-selected membership's settings from its domain
// (AtlasWallet.getPostOfficeSettings — self-signed, so it only ever
// returns THIS wallet's own entry) and renders them into the handle
// display, mode select, and blocked-senders list. Called whenever the
// domain picker changes, and after every save/block/unblock so the panel
// always reflects what the domain actually has on file rather than an
// optimistic local guess.
async function loadPostOfficeSettings() {
  const domain = postOfficeSettingsDomainInput ? postOfficeSettingsDomainInput.value : '';
  if (!domain) { await renderPostOfficeSettings(null); return; }
  if (postOfficeBlockedListEl) postOfficeBlockedListEl.textContent = 'Loading…';
  try {
    const settings = await AtlasWallet.getPostOfficeSettings(domain);
    await renderPostOfficeSettings(settings);
  } catch (err) {
    if (postOfficeBlockedListEl) postOfficeBlockedListEl.textContent = "Couldn't load settings: " + err.message;
  }
}

// Last settings actually loaded/saved for the currently-selected
// membership — kept around so a block/unblock/handle-save response (which
// only returns the ONE field it changed) can be merged back in for a
// re-render without a whole extra round trip to mysettings, while still
// staying in sync with what the domain has since a real response always
// wins over any earlier guess.
let currentPostOfficeSettings = null;

function renderPostOfficeSettings(settings) {
  currentPostOfficeSettings = settings;
  if (postOfficeMailModeInput) postOfficeMailModeInput.value = settings ? (settings.mailMode || 'open') : 'open';

  const domain = postOfficeSettingsDomainInput ? postOfficeSettingsDomainInput.value : '';
  if (postOfficeYourHandleDisplayEl) {
    if (!settings) {
      postOfficeYourHandleDisplayEl.textContent = '';
    } else if (settings.handle) {
      postOfficeYourHandleDisplayEl.textContent = 'You\'re reachable as ' + settings.handle + '#' + domain;
    } else {
      postOfficeYourHandleDisplayEl.textContent = 'No handle set here yet — you\'re only reachable by raw public key.';
    }
  }
  if (postOfficeHandleInput && document.activeElement !== postOfficeHandleInput) {
    postOfficeHandleInput.value = settings && settings.handle ? settings.handle : '';
  }

  if (!postOfficeBlockedListEl) return;
  if (!settings) {
    postOfficeBlockedListEl.innerHTML = '';
    postOfficeBlockedListEl.className = 'empty-note';
    postOfficeBlockedListEl.textContent = 'Pick a Post Office membership above.';
    return;
  }
  const blocked = settings.blockedSenders || [];
  if (!blocked.length) {
    postOfficeBlockedListEl.innerHTML = '';
    postOfficeBlockedListEl.className = 'empty-note';
    postOfficeBlockedListEl.textContent = 'No one blocked here.';
    return;
  }
  postOfficeBlockedListEl.className = '';
  postOfficeBlockedListEl.innerHTML = blocked.map((key) =>
    '<div class="item-actions" style="justify-content:space-between;align-items:center;margin-top:4px;">' +
    '<span style="font-family:monospace;font-size:11px;">' + escapeHtml(key.slice(0, 24)) + '…</span>' +
    '<button type="button" data-action="unblock" data-key="' + escapeHtml(key) + '" class="danger-btn">Unblock</button>' +
    '</div>'
  ).join('');
}

postOfficeSettingsDomainInput && postOfficeSettingsDomainInput.addEventListener('change', async () => {
  await loadPostOfficeSettings();
  // Remember this as "last used" for next time (UI convenience only — see
  // refreshPostOfficeSettingsDomainOptions' own comment). A deliberate
  // pick here IS the action, unlike Compose's picker which is recorded at
  // send time instead, so this is recorded right on change.
  const identity = await AtlasWallet.getIdentity();
  if (identity) await AtlasWallet.setLastPostOfficeSettingsDomain(identity.publicKey, postOfficeSettingsDomainInput.value || null);
});

// Task #94 (handle addressing): claims/changes this membership's handle.
// Format/profanity is checked again server-side regardless (see server.js's
// own comment on why a client-only check isn't enough for anything shown
// to someone else) — this client-side pass is purely a faster "that won't
// be accepted" than waiting on a round trip.
postOfficeSaveHandleBtn && postOfficeSaveHandleBtn.addEventListener('click', async () => {
  const domain = postOfficeSettingsDomainInput ? postOfficeSettingsDomainInput.value : '';
  const handle = (postOfficeHandleInput.value || '').trim();
  if (!domain) {
    if (postOfficeHandleStatusEl) postOfficeHandleStatusEl.textContent = 'Pick a Post Office membership first.';
    return;
  }
  if (!handle) {
    if (postOfficeHandleStatusEl) postOfficeHandleStatusEl.textContent = 'Enter a handle, or use Clear to remove your current one.';
    return;
  }
  postOfficeSaveHandleBtn.disabled = true;
  postOfficeSaveHandleBtn.textContent = 'Saving…';
  if (postOfficeHandleStatusEl) postOfficeHandleStatusEl.textContent = '';
  try {
    const result = await AtlasWallet.setPostOfficeHandle(domain, handle);
    renderPostOfficeSettings({ ...currentPostOfficeSettings, handle: result.handle });
    postOfficeHandleStatusEl.textContent = 'Saved — you\'re now ' + result.handle + '#' + domain + '.';
  } catch (err) {
    postOfficeHandleStatusEl.textContent = 'Save failed: ' + err.message;
  } finally {
    postOfficeSaveHandleBtn.disabled = false;
    postOfficeSaveHandleBtn.textContent = 'Save';
  }
});

postOfficeClearHandleBtn && postOfficeClearHandleBtn.addEventListener('click', async () => {
  const domain = postOfficeSettingsDomainInput ? postOfficeSettingsDomainInput.value : '';
  if (!domain) {
    if (postOfficeHandleStatusEl) postOfficeHandleStatusEl.textContent = 'Pick a Post Office membership first.';
    return;
  }
  postOfficeClearHandleBtn.disabled = true;
  postOfficeClearHandleBtn.textContent = 'Clearing…';
  if (postOfficeHandleStatusEl) postOfficeHandleStatusEl.textContent = '';
  try {
    await AtlasWallet.setPostOfficeHandle(domain, null);
    postOfficeHandleInput.value = '';
    renderPostOfficeSettings({ ...currentPostOfficeSettings, handle: null });
    postOfficeHandleStatusEl.textContent = 'Cleared — you\'re only reachable by raw public key here now.';
  } catch (err) {
    postOfficeHandleStatusEl.textContent = 'Clear failed: ' + err.message;
  } finally {
    postOfficeClearHandleBtn.disabled = false;
    postOfficeClearHandleBtn.textContent = 'Clear';
  }
});

// Saves the mode select's current value against whichever membership is
// selected — see AtlasWallet.setPostOfficeMailMode's own comment on what
// switching to "friendsOnly" actually submits (a one-time snapshot of this
// wallet's local Friends list, not an ongoing sync).
postOfficeSaveMailModeBtn && postOfficeSaveMailModeBtn.addEventListener('click', async () => {
  const domain = postOfficeSettingsDomainInput ? postOfficeSettingsDomainInput.value : '';
  const mode = postOfficeMailModeInput ? postOfficeMailModeInput.value : 'open';
  if (!domain) {
    if (postOfficeMailModeStatusEl) postOfficeMailModeStatusEl.textContent = 'Pick a Post Office membership first.';
    return;
  }
  postOfficeSaveMailModeBtn.disabled = true;
  postOfficeSaveMailModeBtn.textContent = 'Saving…';
  if (postOfficeMailModeStatusEl) postOfficeMailModeStatusEl.textContent = '';
  try {
    const result = await AtlasWallet.setPostOfficeMailMode(domain, mode);
    currentPostOfficeSettings = { ...currentPostOfficeSettings, mailMode: result.mailMode, friendsCount: result.friendsCount };
    postOfficeMailModeStatusEl.textContent = mode === 'friendsOnly'
      ? 'Saved — friends only (' + result.friendsCount + ' friend' + (result.friendsCount === 1 ? '' : 's') + ' synced).'
      : 'Saved — open to anyone at this Post Office.';
  } catch (err) {
    postOfficeMailModeStatusEl.textContent = 'Save failed: ' + err.message;
  } finally {
    postOfficeSaveMailModeBtn.disabled = false;
    postOfficeSaveMailModeBtn.textContent = 'Save';
  }
});

postOfficeBlockBtn && postOfficeBlockBtn.addEventListener('click', async () => {
  const domain = postOfficeSettingsDomainInput ? postOfficeSettingsDomainInput.value : '';
  const key = (postOfficeBlockPublicKeyInput.value || '').trim();
  if (!domain) {
    if (postOfficeBlockStatusEl) postOfficeBlockStatusEl.textContent = 'Pick a Post Office membership first.';
    return;
  }
  if (!key) {
    if (postOfficeBlockStatusEl) postOfficeBlockStatusEl.textContent = 'Enter the public key to block.';
    return;
  }
  postOfficeBlockBtn.disabled = true;
  postOfficeBlockBtn.textContent = 'Blocking…';
  if (postOfficeBlockStatusEl) postOfficeBlockStatusEl.textContent = '';
  try {
    const result = await AtlasWallet.blockPostOfficeSender(domain, key);
    renderPostOfficeSettings({ ...currentPostOfficeSettings, blockedSenders: result.blockedSenders });
    postOfficeBlockPublicKeyInput.value = '';
    postOfficeBlockStatusEl.textContent = 'Blocked.';
  } catch (err) {
    postOfficeBlockStatusEl.textContent = 'Block failed: ' + err.message;
  } finally {
    postOfficeBlockBtn.disabled = false;
    postOfficeBlockBtn.textContent = 'Block';
  }
});

// Delegated — the blocked-senders list is rebuilt wholesale on every
// render, same "one listener on the container" approach mailListEl's own
// click handler already uses for its per-card buttons.
postOfficeBlockedListEl && postOfficeBlockedListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="unblock"]');
  if (!btn) return;
  const domain = postOfficeSettingsDomainInput ? postOfficeSettingsDomainInput.value : '';
  const key = btn.dataset.key;
  if (!domain || !key) return;
  btn.disabled = true;
  btn.textContent = 'Unblocking…';
  try {
    const result = await AtlasWallet.unblockPostOfficeSender(domain, key);
    renderPostOfficeSettings({ ...currentPostOfficeSettings, blockedSenders: result.blockedSenders });
  } catch (err) {
    if (postOfficeBlockStatusEl) postOfficeBlockStatusEl.textContent = 'Unblock failed: ' + err.message;
    btn.disabled = false;
    btn.textContent = 'Unblock';
  }
});

copyMyPublicKeyBtn && copyMyPublicKeyBtn.addEventListener('click', async () => {
  const value = myPublicKeyDisplayEl ? myPublicKeyDisplayEl.value : '';
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    if (copyMyPublicKeyStatusEl) copyMyPublicKeyStatusEl.textContent = 'Copied.';
  } catch (err) {
    // Clipboard API can be unavailable/denied in this iframe context —
    // fall back to select-and-copy-yourself rather than fail silently.
    myPublicKeyDisplayEl.select();
    if (copyMyPublicKeyStatusEl) copyMyPublicKeyStatusEl.textContent = "Couldn't auto-copy — selected for you, press Ctrl/Cmd+C.";
  }
  setTimeout(() => { if (copyMyPublicKeyStatusEl) copyMyPublicKeyStatusEl.textContent = ''; }, 3000);
});

// Task #94 (handle addressing): swaps Compose between its two recipient
// input modes — handle-first (the default) and the raw-key fallback for
// someone who hasn't registered a handle yet. Only one is ever visible (and
// only the visible one's value is used on Send, below), so switching also
// clears whichever field is being hidden — leftover text in a hidden field
// would otherwise silently do nothing, which is worse than just not being
// there.
postOfficeToggleRawKeyBtn && postOfficeToggleRawKeyBtn.addEventListener('click', () => {
  const showingRawKey = !postOfficeToPublicKeyInput.hidden;
  postOfficeToPublicKeyInput.hidden = showingRawKey;
  postOfficeToHandleInput.hidden = !showingRawKey;
  postOfficeToggleRawKeyBtn.textContent = showingRawKey ? 'Paste a raw public key instead' : 'Use a handle instead';
  (showingRawKey ? postOfficeToPublicKeyInput : postOfficeToHandleInput).value = '';
});

// Post Office (task #75/#87/#94, SPEC.md §11.3): composes and sends a
// message to another identity's public key through a Post Office this
// wallet already belongs to — see AtlasWallet.sendUserMail's own comment
// for the wire mechanics. Membership is symmetric: the recipient has to
// hold a card at that SAME domain too, or the domain rejects the send —
// this wallet only offers domains it's actually joined in the dropdown
// above, so the common failure here is the recipient not being a member
// yet, not this wallet.
//
// Task #94 (handle addressing): when the handle field is the active one
// (the default), the recipient input can be either a bare handle — resolved
// against whichever Post Office is picked in the dropdown — or a full
// "handle#domain" address, which overrides the dropdown to that domain
// instead (as long as this wallet has actually joined it; if not, that's
// reported directly rather than attempting a resolve that would only fail
// at the membership check anyway). Either way it resolves to a public key
// via AtlasWallet.resolvePostOfficeHandle BEFORE sending, so the actual
// send call underneath is identical to the raw-key path — Post Office
// addressing is purely a lookup layered in front of it.
postOfficeSendBtn && postOfficeSendBtn.addEventListener('click', async () => {
  const subject = (postOfficeSubjectInput.value || '').trim();
  const body = (postOfficeBodyInput.value || '').trim();
  const usingRawKey = !postOfficeToPublicKeyInput.hidden;

  let toDomain = (postOfficeToDomainInput.value || '').trim();
  let toPublicKey = '';
  // Purely a display hint for this wallet's own Sent record (see
  // AtlasWallet.sendUserMail's own comment) — set only on the handle path
  // below, where a handle was actually resolved; the raw-key path leaves
  // it undefined and the Sent card falls back to showing the raw key.
  let toHandleForRecord;

  if (usingRawKey) {
    toPublicKey = (postOfficeToPublicKeyInput.value || '').trim();
    if (!toDomain || !toPublicKey || !subject || !body) {
      postOfficeSendStatusEl.textContent = 'Choose a Post Office to send through, then fill in the recipient\'s public key, subject, and message.';
      return;
    }
  } else {
    const rawHandleInput = (postOfficeToHandleInput.value || '').trim();
    if (!rawHandleInput || !subject || !body) {
      postOfficeSendStatusEl.textContent = 'Fill in the recipient\'s handle, subject, and message.';
      return;
    }
    let handle = rawHandleInput;
    const hashIndex = rawHandleInput.indexOf('#');
    if (hashIndex !== -1) {
      handle = rawHandleInput.slice(0, hashIndex).trim();
      const parsedDomain = rawHandleInput.slice(hashIndex + 1).trim();
      const knownDomains = [...postOfficeToDomainInput.options].map((o) => o.value).filter(Boolean);
      if (!knownDomains.includes(parsedDomain)) {
        postOfficeSendStatusEl.textContent = 'You haven\'t joined ' + parsedDomain + '\'s Post Office yet — join it first (Post Office section above).';
        return;
      }
      toDomain = parsedDomain;
      postOfficeToDomainInput.value = parsedDomain;
    }
    if (!toDomain) {
      postOfficeSendStatusEl.textContent = 'Choose a Post Office to send through first.';
      return;
    }
    if (!handle) {
      postOfficeSendStatusEl.textContent = 'Enter the recipient\'s handle.';
      return;
    }
    postOfficeSendBtn.disabled = true;
    postOfficeSendBtn.textContent = 'Looking up…';
    postOfficeSendStatusEl.textContent = '';
    try {
      const resolved = await AtlasWallet.resolvePostOfficeHandle(toDomain, handle);
      toPublicKey = resolved.publicKey;
      toHandleForRecord = handle;
    } catch (err) {
      postOfficeSendStatusEl.textContent = err.message;
      postOfficeSendBtn.disabled = false;
      postOfficeSendBtn.textContent = 'Send';
      return;
    }
  }

  postOfficeSendBtn.disabled = true;
  postOfficeSendBtn.textContent = 'Sending…';
  postOfficeSendStatusEl.textContent = '';
  try {
    await AtlasWallet.sendUserMail(toDomain, toPublicKey, subject, body, toHandleForRecord);
    postOfficeSendStatusEl.textContent = 'Sent.';
    postOfficeSubjectInput.value = '';
    postOfficeBodyInput.value = '';
    // Keep Sent current in case it's visited right after — cheap either
    // way, and refreshSentMailDisplay() itself no-ops gracefully without
    // an identity.
    await refreshSentMailDisplay();
  } catch (err) {
    postOfficeSendStatusEl.textContent = 'Send failed: ' + err.message;
  } finally {
    postOfficeSendBtn.disabled = false;
    postOfficeSendBtn.textContent = 'Send';
  }
});

subscribeBtn && subscribeBtn.addEventListener('click', async () => {
  const domain = manifestDomainOf(currentManifest);
  subscribeBtn.disabled = true;
  subscribeBtn.textContent = 'Subscribing…';
  let errorMessage = '';
  try {
    await AtlasWallet.mintAsset('self', domain, 'atlas.membership');
    await refreshInventoryDisplay();
  } catch (err) {
    errorMessage = 'Subscribe failed: ' + err.message;
  } finally {
    await refreshSubscribeButton();
  await refreshPostOfficeJoinButton();
  await refreshMyPublicKeyDisplay();
    if (subscribeStatusEl) subscribeStatusEl.textContent = errorMessage;
  }
});

// Task #94 — mints the SAME atlas.postoffice.membership credential the
// in-world stall's "issue" interactable does (see handleInteractable()),
// just reachable directly from the wallet once the manifest says this
// domain offers it, instead of requiring a visitor to already know to go
// find the stall. Refreshes refreshPostOfficeSendOptions() too (via
// refreshMyPublicKeyDisplay(), same as everywhere else this session) so
// the new membership shows up in the "send via" dropdown immediately,
// with no separate check needed.
postOfficeJoinBtn && postOfficeJoinBtn.addEventListener('click', async () => {
  const domain = manifestDomainOf(currentManifest);
  postOfficeJoinBtn.disabled = true;
  postOfficeJoinBtn.textContent = 'Joining…';
  let errorMessage = '';
  try {
    await AtlasWallet.mintAsset('self', domain, 'atlas.postoffice.membership');
  } catch (err) {
    errorMessage = 'Join failed: ' + err.message;
  } finally {
    await refreshPostOfficeJoinButton();
    await refreshMyPublicKeyDisplay();
    if (postOfficeJoinStatusEl) postOfficeJoinStatusEl.textContent = errorMessage;
  }
});

// ---------- friends (Social -> Friends tab, #67) ----------
//
// Three lists: who's actually standing in this world with you right now
// (from the live presence roster, see presenceRosterMeta), any friend
// requests aimed at you that are still live (presencePendingIncoming —
// only exists while both sides remain in the same room, see its own
// comment up near disconnectPresence), and the friends you've actually
// saved (AtlasWallet.getFriends(), persists across sessions/worlds — see
// wallet.js). Adding a friend, and answering a request, both go out as a
// signal over the CURRENT presence connection (sendSignal) — there's no
// other channel this can use, by design (see README.md's Friends section
// for why mail can't do this).

function renderPresentVisitorCard(id, meta, friendKeys, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  const isFriend = !!(meta.publicKey && friendKeys.has(meta.publicKey));
  const requested = presencePendingSentRequests.has(id);
  let actionHtml;
  if (!meta.publicKey) {
    actionHtml = '<span class="empty-note">No identity — can\'t be friended</span>';
  } else if (isFriend) {
    actionHtml = '<span class="empty-note">Already a friend</span>';
  } else if (requested) {
    actionHtml = '<span class="empty-note">Request sent</span>';
  } else {
    actionHtml = '<button type="button" data-action="add-friend" data-id="' + id + '">Add friend</button>';
  }
  el.innerHTML =
    '<div class="name">' + meta.name + '</div>' +
    '<div class="meta">' + (meta.publicKey ? short(meta.publicKey, 20) : 'No wallet identity') + '</div>' +
    '<div class="item-actions">' + actionHtml + '</div>';
  container.appendChild(el);
}

function renderIncomingRequestCard(req, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  el.innerHTML =
    '<div class="name">' + req.name + '</div>' +
    '<div class="meta">' + (req.publicKey ? short(req.publicKey, 20) : '') + '</div>' +
    '<div class="item-actions">' +
    '<button type="button" data-action="accept-request" data-from="' + req.from + '">Accept</button>' +
    '<button type="button" data-action="decline-request" data-from="' + req.from + '" class="danger-btn">Decline</button>' +
    '</div>';
  container.appendChild(el);
}

function renderFriendCard(f, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  el.innerHTML =
    '<div class="name">' + f.name + '</div>' +
    '<div class="meta">' + short(f.publicKey, 20) + '</div>' +
    '<div class="item-actions">' +
    '<button type="button" data-action="remove-friend" data-key="' + f.publicKey + '" class="danger-btn">Remove</button>' +
    '</div>';
  container.appendChild(el);
}

async function refreshFriendsDisplay() {
  const friends = await AtlasWallet.getFriends();
  const friendKeys = new Set(friends.map((f) => f.publicKey));

  if (friendsHereListEl) {
    friendsHereListEl.innerHTML = '';
    if (!presenceIsConnected()) {
      friendsHereListEl.innerHTML = '<div class="empty-note">Enter a 3D world to see who\'s here right now.</div>';
    } else if (presenceRosterMeta.size === 0) {
      friendsHereListEl.innerHTML = '<div class="empty-note">Nobody else here right now.</div>';
    } else {
      presenceRosterMeta.forEach((meta, id) => renderPresentVisitorCard(id, meta, friendKeys, friendsHereListEl));
    }
  }

  if (friendRequestsListEl) {
    friendRequestsListEl.innerHTML = '';
    if (presencePendingIncoming.length === 0) {
      friendRequestsListEl.innerHTML = '<div class="empty-note">No pending requests.</div>';
    } else {
      presencePendingIncoming.forEach((req) => renderIncomingRequestCard(req, friendRequestsListEl));
    }
  }

  if (friendsListEl) {
    friendsListEl.innerHTML = '';
    if (friends.length === 0) {
      friendsListEl.innerHTML = '<div class="empty-note">No friends saved yet.</div>';
    } else {
      friends.forEach((f) => renderFriendCard(f, friendsListEl));
    }
  }

  await updateSocialBadge();
}

// One delegated listener covers all three Friends lists — same pattern as
// recentWorldsListEl's own click handler.
socialScreen && socialScreen.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'add-friend') {
    const id = btn.dataset.id;
    const meta = presenceRosterMeta.get(id);
    if (!meta || !meta.publicKey) return;
    presencePendingSentRequests.add(id);
    sendSignal(id, 'friend-request', presenceOwnPublicKey, presenceOwnName || 'Visitor');
    await refreshFriendsDisplay();
    return;
  }

  if (action === 'accept-request') {
    const from = btn.dataset.from;
    const req = presencePendingIncoming.find((r) => r.from === from);
    if (!req) return;
    presencePendingIncoming = presencePendingIncoming.filter((r) => r.from !== from);
    if (req.publicKey) {
      try { await AtlasWallet.addFriend(req.publicKey, req.name || 'Friend'); } catch (err) {}
    }
    sendSignal(from, 'friend-request-accepted', presenceOwnPublicKey, presenceOwnName || 'Visitor');
    await refreshFriendsDisplay();
    return;
  }

  if (action === 'decline-request') {
    const from = btn.dataset.from;
    presencePendingIncoming = presencePendingIncoming.filter((r) => r.from !== from);
    sendSignal(from, 'friend-request-declined', presenceOwnPublicKey, presenceOwnName || 'Visitor');
    await refreshFriendsDisplay();
    return;
  }

  if (action === 'remove-friend') {
    await AtlasWallet.removeFriend(btn.dataset.key);
    await refreshFriendsDisplay();
    return;
  }
});

// ---------- favorite domains (Social -> Favorites tab, #61) ----------
//
// A bookmarked domain+world, teleported to the same way Recent Worlds
// does (travelToRecentWorld, unchanged, reused as-is below since the
// action is identical: refetch the manifest, enter that world, close the
// panel). What's new here is the live status line — "N here now, friends:
// ..." — pulled fresh from that domain's OWN presence backend every time
// this list renders (fetchPresenceStatus), then cross-referenced against
// the local friends list ENTIRELY CLIENT-SIDE. See presence-server.js's
// /presence/status route and presence-php's status.php for the privacy
// reasoning: the server only ever hands back who's actually there, never
// anyone's friends list.

function renderFavoriteCard(entry, status, friendByKey, index, total, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  const isHere = !!(currentWorld && currentManifest && entry.domain === currentManifest.domain && entry.worldId === currentWorld.id);
  const friendsHere = (status.roster || []).filter((m) => m.publicKey && friendByKey.has(m.publicKey));
  const friendNames = friendsHere.map((m) => friendByKey.get(m.publicKey).name);
  let statusLine = status.count > 0 ? status.count + ' here now' : 'Nobody here right now';
  if (friendNames.length > 0) statusLine += ' · friends here: ' + friendNames.join(', ');
  el.innerHTML =
    '<div class="name">' + entry.worldName + '</div>' +
    '<div class="meta">' + entry.domain + (entry.worldId ? ' · ' + entry.worldId : '') + '</div>' +
    '<div class="meta">' + statusLine + '</div>' +
    '<div class="item-actions">' +
    (isHere
      ? '<span class="empty-note">You are here</span>'
      : '<button type="button" data-action="travel-favorite" data-manifest="' + entry.manifestUrl + '" data-world="' + (entry.worldId || '') + '">Go</button>') +
    (index > 0 ? '<button type="button" data-action="move-favorite-up" data-domain="' + entry.domain + '">Move up</button>' : '') +
    (index < total - 1 ? '<button type="button" data-action="move-favorite-down" data-domain="' + entry.domain + '">Move down</button>' : '') +
    '<button type="button" data-action="remove-favorite" data-domain="' + entry.domain + '" class="danger-btn">Remove</button>' +
    '</div>';
  container.appendChild(el);
}

async function refreshFavoritesDisplay() {
  if (!favoritesListEl) return;
  const favorites = await AtlasWallet.getFavoriteDomains();
  favoritesListEl.innerHTML = '';
  if (favorites.length === 0) {
    favoritesListEl.innerHTML = '<div class="empty-note">No favorites yet — while you\'re in a world, use "Favorite this domain" above.</div>';
  } else {
    const friends = await AtlasWallet.getFriends();
    const friendByKey = new Map(friends.map((f) => [f.publicKey, f]));
    const statuses = await Promise.all(favorites.map((entry) =>
      entry.worldId ? fetchPresenceStatus(entry.domain, entry.worldId, entry.presenceBase) : Promise.resolve({ count: 0, roster: [] })
    ));
    favorites.forEach((entry, i) => renderFavoriteCard(entry, statuses[i], friendByKey, i, favorites.length, favoritesListEl));
  }
  await refreshFavoriteCurrentDomainButton();
}

async function refreshFavoriteCurrentDomainButton() {
  if (!addCurrentFavoriteBtn) return;
  if (!currentManifest || !currentWorld) {
    addCurrentFavoriteBtn.style.display = 'none';
    if (addCurrentFavoriteStatusEl) addCurrentFavoriteStatusEl.textContent = '';
    return;
  }
  const already = await AtlasWallet.isFavoriteDomain(currentManifest.domain);
  addCurrentFavoriteBtn.style.display = already ? 'none' : '';
  if (addCurrentFavoriteStatusEl) addCurrentFavoriteStatusEl.textContent = already ? 'This domain is already a favorite.' : '';
}

addCurrentFavoriteBtn && addCurrentFavoriteBtn.addEventListener('click', async () => {
  if (!currentManifest || !currentWorld) return;
  await AtlasWallet.addFavoriteDomain({
    domain: currentManifest.domain,
    manifestUrl: currentManifestUrl,
    worldId: currentWorld.id,
    worldName: currentWorld.name,
    presenceBase: currentManifest.presence || null
  });
  await refreshFavoritesDisplay();
});

favoritesListEl && favoritesListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'travel-favorite') { await travelToRecentWorld(btn.dataset.manifest, btn.dataset.world || undefined); return; }
  if (action === 'remove-favorite') { await AtlasWallet.removeFavoriteDomain(btn.dataset.domain); await refreshFavoritesDisplay(); return; }
  if (action === 'move-favorite-up') { await AtlasWallet.moveFavoriteDomain(btn.dataset.domain, 'up'); await refreshFavoritesDisplay(); return; }
  if (action === 'move-favorite-down') { await AtlasWallet.moveFavoriteDomain(btn.dataset.domain, 'down'); await refreshFavoritesDisplay(); return; }
});

checkMailNowBtn && checkMailNowBtn.addEventListener('click', async () => {
  checkMailNowBtn.disabled = true;
  checkMailNowBtn.textContent = 'Checking…';
  try {
    await AtlasWallet.checkAllMail();
  } catch (err) {
    // checkAllMail already swallows per-domain failures; this would only
    // be something more fundamental (no identity, storage error, etc).
  } finally {
    checkMailNowBtn.disabled = false;
    checkMailNowBtn.textContent = 'Check now';
    await refreshMailDisplay();
    // checkAllMail (SPEC.md §5.1.1) may have just adopted a reissued item
    // for every domain this wallet holds something from, not only mail —
    // refresh the items list/badge too so a manual "Check now" surfaces
    // that immediately, same as the periodic loop below already does.
    await refreshInventoryDisplay();
  }
});

saveMailIntervalBtn && saveMailIntervalBtn.addEventListener('click', async () => {
  mailIntervalStatusEl.textContent = '';
  try {
    await AtlasWallet.setMailCheckInterval(mailIntervalInput.value);
    mailIntervalStatusEl.textContent = 'Saved.';
    restartMailCheckLoop();
  } catch (err) {
    mailIntervalStatusEl.textContent = err.message;
  }
});

// Task #71 — no restart-the-loop step needed the way mail check has: the
// auto-lock checker (further below, alongside the other periodic timers)
// re-reads AtlasWallet.getAutoLockMinutes() fresh on every tick rather than
// caching it, so a save here just takes effect on the checker's next pass.
saveAutoLockMinutesBtn && saveAutoLockMinutesBtn.addEventListener('click', async () => {
  autoLockMinutesStatusEl.textContent = '';
  try {
    const saved = await AtlasWallet.setAutoLockMinutes(autoLockMinutesInput.value);
    autoLockMinutesInput.value = String(saved);
    autoLockMinutesStatusEl.textContent = saved === 0 ? 'Saved — auto-lock is off.' : 'Saved.';
    markActivity(); // saving this setting shouldn't itself count as the idle clock already having run out
  } catch (err) {
    autoLockMinutesStatusEl.textContent = err.message;
  }
});

// Blank input + Save = clear the alias back to the raw key; anything else
// = set/replace it (setAlias runs the profanity filter — see wallet.js).
setAliasBtn.addEventListener('click', async () => {
  aliasStatusEl.textContent = '';
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;
  setAliasBtn.disabled = true;
  try {
    const clearing = aliasInput.value.trim() === '';
    if (clearing) {
      await AtlasWallet.clearAlias(identity.publicKey);
    } else {
      await AtlasWallet.setAlias(identity.publicKey, aliasInput.value);
    }
    // Refreshes walletIdentityEl and re-fills aliasInput from storage —
    // and, as a side effect, clears aliasStatusEl — so the success message
    // is set AFTER, not before, or this refresh would wipe it right back out.
    await refreshIdentityDisplay();
    aliasStatusEl.textContent = clearing ? 'Nickname cleared.' : 'Saved.';
  } catch (err) {
    aliasStatusEl.textContent = err.message;
  } finally {
    setAliasBtn.disabled = false;
  }
});

createCounterpartyBtn.addEventListener('click', async () => {
  createCounterpartyBtn.disabled = true;
  await AtlasWallet.createCounterparty();
  await refreshIdentityDisplay();
  createCounterpartyBtn.disabled = false;
});

exportIdentityBtn.addEventListener('click', async () => {
  exportIdentityBtn.disabled = true;
  exportStatusEl.textContent = 'Encrypting…';
  try {
    const data = await AtlasWallet.exportIdentity(exportPasswordInput.value, exportSeedInput.value);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'atlas-identity-export.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    exportStatusEl.textContent = 'Exported — keep the file, your password, and your seed phrase stored separately from each other.';
    exportPasswordInput.value = '';
    exportSeedInput.value = '';
  } catch (err) {
    exportStatusEl.textContent = 'Export failed: ' + err.message;
  } finally {
    exportIdentityBtn.disabled = false;
  }
});

changePasswordBtn.addEventListener('click', async () => {
  changePasswordStatusEl.textContent = '';
  if (changePasswordNewInput.value !== changePasswordConfirmInput.value) {
    changePasswordStatusEl.textContent = 'New passwords do not match.';
    return;
  }
  changePasswordBtn.disabled = true;
  try {
    await AtlasWallet.changePassword(changePasswordCurrentInput.value, changePasswordNewInput.value);
    changePasswordCurrentInput.value = '';
    changePasswordNewInput.value = '';
    changePasswordConfirmInput.value = '';
    changePasswordStatusEl.textContent = 'Password changed.';
  } catch (err) {
    changePasswordStatusEl.textContent = 'Change failed: ' + err.message;
  } finally {
    changePasswordBtn.disabled = false;
  }
});

exportBtn.addEventListener('click', async () => {
  const data = await AtlasWallet.exportWallet();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'atlas-wallet-export.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// Import is the counterpart to exportBtn above — re-populates this
// wallet's item/resource lists from a previously exported
// atlas-wallet-export/1.0 file. Every credential in it gets independently
// re-verified against its own issuer before being trusted (see
// importWallet in wallet.js), the same as a freshly issued one.
importWalletBtn.addEventListener('click', () => importWalletFileInput.click());

importWalletFileInput.addEventListener('change', async () => {
  const file = importWalletFileInput.files && importWalletFileInput.files[0];
  importWalletFileInput.value = '';
  if (!file) return;
  importWalletStatusEl.textContent = 'Importing…';
  try {
    const fileData = JSON.parse(await file.text());
    const result = await AtlasWallet.importWallet(fileData);
    const parts = [];
    if (result.assetsAdded) parts.push(result.assetsAdded + ' asset(s) added');
    const skippedDup = result.assetsSkippedDuplicate;
    const skippedOwner = result.assetsSkippedNotOwned;
    if (skippedDup) parts.push(skippedDup + ' already in this wallet');
    if (skippedOwner) parts.push(skippedOwner + ' skipped (belong to a different identity)');
    importWalletStatusEl.textContent = parts.length ? parts.join(', ') + '.' : 'Nothing new to import.';
    await refreshInventoryDisplay();
  } catch (err) {
    importWalletStatusEl.textContent = 'Import failed: ' + err.message;
  }
});

// ---------- cache management (Settings -> Cache) ----------
//
// Reads from gltf-mini.js's asset cache via window.MiniGLTF.cache — same
// document, same origin, so no message-passing needed, just calling
// straight into the other script's exposed API. Same export/import shape
// as the wallet export above: a downloaded JSON file, re-imported via a
// hidden file input.

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderCacheSiteCard(site, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  el.innerHTML =
    '<div class="name">' + site.origin + '</div>' +
    '<div class="meta">' + site.count + ' file' + (site.count === 1 ? '' : 's') + ' · ' + formatBytes(site.bytes) + '</div>' +
    '<div class="item-actions">' +
    '<button data-action="clear-site" data-origin="' + site.origin + '" class="danger-btn">Clear</button>' +
    '</div>';
  container.appendChild(el);
}

async function refreshCacheDisplay() {
  if (!cacheSitesListEl || !window.MiniGLTF || !window.MiniGLTF.cache) return;
  const sites = await window.MiniGLTF.cache.listBySite();
  const total = sites.reduce((sum, s) => sum + s.bytes, 0);
  cacheTotalLineEl.textContent = sites.length
    ? formatBytes(total) + ' total across ' + sites.length + ' site' + (sites.length === 1 ? '' : 's')
    : 'Nothing cached yet.';
  cacheSitesListEl.innerHTML = '';
  sites.forEach((site) => renderCacheSiteCard(site, cacheSitesListEl));
}

cacheSitesListEl && cacheSitesListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.dataset.action !== 'clear-site') return;
  if (!confirm('Clear the cached assets from ' + btn.dataset.origin + '? They\'ll simply re-download next time you visit a world there.')) return;
  await window.MiniGLTF.cache.clearSite(btn.dataset.origin);
  await refreshCacheDisplay();
});

clearAllCacheBtn && clearAllCacheBtn.addEventListener('click', async () => {
  if (!confirm('Clear the entire asset cache, across every site? Everything will simply re-download next time it\'s needed.')) return;
  await window.MiniGLTF.cache.clearAll();
  await refreshCacheDisplay();
});

exportCacheBtn && exportCacheBtn.addEventListener('click', async () => {
  const data = await window.MiniGLTF.cache.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'atlas-asset-cache-export.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

importCacheBtn && importCacheBtn.addEventListener('click', () => importCacheFileInput.click());

importCacheFileInput && importCacheFileInput.addEventListener('change', async () => {
  const file = importCacheFileInput.files && importCacheFileInput.files[0];
  importCacheFileInput.value = '';
  if (!file) return;
  importCacheStatusEl.textContent = 'Importing…';
  try {
    const fileData = JSON.parse(await file.text());
    const result = await window.MiniGLTF.cache.importAll(fileData);
    importCacheStatusEl.textContent = result.imported + ' cached file(s) imported.';
    await refreshCacheDisplay();
  } catch (err) {
    importCacheStatusEl.textContent = 'Import failed: ' + err.message;
  }
});

requestItemBtn.addEventListener('click', async () => {
  const world = currentWorld;
  const assetClass = world.policy.acceptedItemClasses[0];
  // Defensive re-check: the button's disabled state already reflects this
  // (see refreshRequestButton), but a click event queued right before a
  // refresh could still slip through, same double-click concern
  // handleInteractable() guards against for stalls.
  if (await alreadyHasRequestableItem(world)) {
    statusEl.textContent = 'Already collected ' + assetClass + ' — check your wallet.';
    await refreshRequestButton();
    return;
  }
  requestItemBtn.disabled = true;
  requestItemBtn.textContent = 'Requesting…';
  try {
    await AtlasWallet.mintAsset('self', manifestDomainOf(currentManifest), assetClass);
    await refreshInventoryDisplay();
  } catch (err) {
    statusEl.textContent = 'Issuance failed: ' + err.message;
  } finally {
    await refreshRequestButton();
  }
});

presentBtn.addEventListener('click', async () => {
  presentBtn.disabled = true;
  presentBtn.textContent = 'Signing…';
  try {
    const ok = await AtlasWallet.presentIdentity();
    presentBtn.textContent = ok ? '✓ Presented — signature verified' : '✗ Signature check failed';
  } catch (err) {
    presentBtn.textContent = 'Presentation failed';
    statusEl.textContent = err.message;
  } finally {
    setTimeout(() => { presentBtn.disabled = false; presentBtn.textContent = 'Present identity (verify possession)'; }, 2500);
  }
});

reverifyBtn.addEventListener('click', async () => {
  reverifyBtn.disabled = true;
  reverifyBtn.textContent = 'Re-verifying…';
  await AtlasWallet.reverifyAll();
  await refreshInventoryDisplay();
  reverifyBtn.disabled = false;
  reverifyBtn.textContent = 'Re-verify wallet against current issuers';
});

// Event delegation for per-asset-card buttons — load/unload, simulate
// loss, split, consolidate, drop, hide — since cards are re-rendered from
// scratch on every refresh. One handler covers both self's and the
// counterparty's list, for both Collectibles and Documents (task #44
// replaced the former separate itemActionHandler/resourceActionHandler
// pair with this one): self gets the extra loadout/PvP/split/consolidate
// actions where the card itself offers them (see renderAssetCard's own
// fungible-vs-not branching), hide is common to both roles.
function assetActionHandler(listEl, role, toRole) {
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.action) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'toggle-properties') {
      const detail = btn.nextElementSibling;
      if (!detail) return;
      detail.hidden = !detail.hidden;
      btn.classList.toggle('open', !detail.hidden);
      return;
    }
    const who = role === 'self' ? await AtlasWallet.getIdentity() : await AtlasWallet.getCounterparty();
    if (!who) return;

    if (btn.dataset.action === 'toggle-load') {
      const loadout = await AtlasWallet.getLoadout();
      if (loadout.includes(id)) await AtlasWallet.unloadItem(id); else await AtlasWallet.loadItem(id);
      await refreshInventoryDisplay();
    } else if (btn.dataset.action === 'lose') {
      btn.disabled = true;
      btn.textContent = 'Signing…';
      try {
        const wallet = await AtlasWallet.getWallet(who.publicKey);
        const entry = wallet.find((x) => x.credential.id === id);
        await AtlasWallet.loseItemToCounterparty(entry.credential, { domain: manifestDomainOf(currentManifest), world: currentWorld.id });
        await refreshInventoryDisplay();
      } catch (err) {
        statusEl.textContent = 'Transfer failed: ' + err.message;
      }
    } else if (btn.dataset.action === 'drop') {
      beginDropPlacement(id);
    } else if (btn.dataset.action === 'hide') {
      await AtlasWallet.hideAsset(who.publicKey, id);
      await refreshInventoryDisplay();
    } else if (btn.dataset.action === 'split') {
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const wallet = await AtlasWallet.getWallet(who.publicKey);
        const entry = wallet.find((x) => x.credential.id === id);
        await AtlasWallet.splitAsset(role, entry.credential, Number(btn.dataset.amount), toRole);
        await refreshInventoryDisplay();
      } catch (err) {
        statusEl.textContent = 'Split failed: ' + err.message;
      }
    } else if (btn.dataset.action === 'consolidate-group') {
      const sepIndex = btn.dataset.key.indexOf('::');
      const cls = btn.dataset.key.slice(0, sepIndex);
      const issuerDomain = btn.dataset.key.slice(sepIndex + 2);
      btn.disabled = true;
      btn.textContent = 'Consolidating…';
      try {
        const wallet = await AtlasWallet.getWallet(who.publicKey);
        const group = wallet.filter((x) => x.credential.asset.class === cls && x.credential.issuer.domain === issuerDomain && x.credential.asset.fungible);
        await AtlasWallet.consolidateAsset(role, group.map((entry) => entry.credential));
        await refreshInventoryDisplay();
      } catch (err) {
        statusEl.textContent = 'Consolidate failed: ' + err.message;
      }
    }
  });
}
assetActionHandler(selfCollectiblesListEl, 'self', 'counterparty');
assetActionHandler(counterpartyCollectiblesListEl, 'counterparty', 'self');
assetActionHandler(selfDocumentsListEl, 'self', 'counterparty');
assetActionHandler(counterpartyDocumentsListEl, 'counterparty', 'self');

droppedItemsListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.dataset.action !== 'pick-up') return;
  pickUpDroppedItem(btn.dataset.id);
});

mintIronBtn.addEventListener('click', async () => {
  mintIronBtn.disabled = true;
  mintIronBtn.textContent = 'Mining…';
  try {
    await AtlasWallet.mintAsset('self', manifestDomainOf(currentManifest), 'atlas.element.iron', 20);
    await refreshInventoryDisplay();
  } catch (err) {
    statusEl.textContent = 'Mint failed: ' + err.message;
  } finally {
    mintIronBtn.disabled = false;
    mintIronBtn.textContent = 'Mine 20 iron (self)';
  }
});

mintGoldBtn.addEventListener('click', async () => {
  mintGoldBtn.disabled = true;
  mintGoldBtn.textContent = 'Mining…';
  try {
    await AtlasWallet.mintAsset('counterparty', manifestDomainOf(currentManifest), 'atlas.element.gold', 10);
    await refreshInventoryDisplay();
  } catch (err) {
    statusEl.textContent = 'Mint failed: ' + err.message;
  } finally {
    mintGoldBtn.disabled = false;
    mintGoldBtn.textContent = 'Mine 10 gold (counterparty)';
  }
});

// Dispatch for a clicked in-scene interactable (see the "interactables"
// note in enterWorld). Only one action exists today — "mint", which does
// exactly what the Settings-panel mine buttons above do, just triggered by
// clicking the stall itself instead of opening the wallet. The busy guard
// exists because — unlike a portal (leaves the scene) or a dropped item
// (removes its own marker once picked up) — a mint stall stays put and
// stays clickable, so nothing else stops a fast double-click from firing
// two mints at once.
async function handleInteractable(marker) {
  if (interactableBusy) return;
  interactableBusy = true;
  try {
    if (marker.action === 'mint') {
      statusEl.textContent = 'Mining ' + marker.class + '…';
      await AtlasWallet.mintAsset(marker.role || 'self', manifestDomainOf(currentManifest), marker.class, marker.quantity);
      await refreshInventoryDisplay();
      statusEl.textContent = 'Collected ' + marker.quantity + ' × ' + marker.class + '.';
    } else if (marker.action === 'issue') {
      // Unlike a resource balance, an item credential isn't quantity-based
      // — every "collect" issues a brand-new unique credential, and the
      // issuer has no concept of "already gave this owner one" (there's no
      // protocol-level item scarcity — see SPEC.md's item-class section).
      // marker.oncePerUser is a purely client-side stand-in for that: check
      // this wallet for an existing credential of the same class from this
      // same issuer before asking for another, so a stall that's meant to
      // read as "one keepsake per visitor" doesn't let repeated clicks
      // quietly fill the wallet with duplicates. It only looks at THIS
      // wallet, so it's a per-device courtesy, not real scarcity — an
      // intentional, disclosed simplification, same spirit as the drop/
      // pick-up feature being local-only.
      const identity = await AtlasWallet.getIdentity();
      if (!identity) throw new Error('Create an identity first.');
      if (marker.oncePerUser) {
        const wallet = await AtlasWallet.getWallet(identity.publicKey);
        const already = wallet.some((e) => e.credential.asset.class === marker.class && e.credential.issuer.domain === manifestDomainOf(currentManifest));
        if (already) {
          statusEl.textContent = "Already collected " + (marker.label || 'this') + " — check your wallet.";
          return;
        }
      }
      statusEl.textContent = 'Collecting ' + (marker.label || marker.class) + '…';
      await AtlasWallet.mintAsset('self', manifestDomainOf(currentManifest), marker.class);
      await refreshInventoryDisplay();
      statusEl.textContent = 'Collected ' + (marker.label || marker.class) + '.';
    }
  } catch (err) {
    statusEl.textContent = (marker.action === 'mint' ? 'Mint failed: ' : 'Collect failed: ') + err.message;
  } finally {
    interactableBusy = false;
  }
}

tradeBtn.addEventListener('click', async () => {
  tradeBtn.disabled = true;
  tradeStatusEl.textContent = 'Proposing intents…';
  try {
    const identity = await AtlasWallet.getIdentity();
    const counterparty = await AtlasWallet.getCounterparty();
    if (!identity || !counterparty) throw new Error('Create both identities first.');

    const selfWallet = await AtlasWallet.getWallet(identity.publicKey);
    const cpWallet = await AtlasWallet.getWallet(counterparty.publicKey);
    const ironBalance = selfWallet.map((e) => e.credential).find((c) => c.asset.class === 'atlas.element.iron' && c.asset.fungible && c.quantity >= 10);
    const goldBalance = cpWallet.map((e) => e.credential).find((c) => c.asset.class === 'atlas.element.gold' && c.asset.fungible && c.quantity >= 5);
    if (!ironBalance) throw new Error('Self needs at least 10 iron — mine some first.');
    if (!goldBalance) throw new Error('Counterparty needs at least 5 gold — mine some first.');

    const offerSelf = { class: 'atlas.element.iron', quantity: 10 };
    const wantSelf = { class: 'atlas.element.gold', quantity: 5 };
    const intentSelf = await AtlasWallet.proposeIntent('self', offerSelf, wantSelf, counterparty.publicKey, 10);

    const offerCp = { class: 'atlas.element.gold', quantity: 5 };
    const wantCp = { class: 'atlas.element.iron', quantity: 10 };
    const intentCp = await AtlasWallet.proposeIntent('counterparty', offerCp, wantCp, identity.publicKey, 10);

    tradeStatusEl.textContent = 'Settling…';
    await AtlasWallet.settleTrade(manifestDomainOf(currentManifest), intentSelf, intentCp, ironBalance, goldBalance);
    await refreshInventoryDisplay();
    tradeStatusEl.textContent = '✓ Settled: self sent 10 iron and received 5 gold; counterparty mirrored it.';
  } catch (err) {
    tradeStatusEl.textContent = 'Trade failed: ' + err.message;
  } finally {
    tradeBtn.disabled = !(currentWorld && currentWorld.profile && currentWorld.profile.genre === 'trading-station');
  }
});

// Enter-to-submit on the password fields that each drive exactly one
// primary action — unlocking, creating an identity, and changing a
// password. preventDefault just to be safe, though none of these sit in an
// actual <form>. Deliberately NOT applied to the export/import password
// fields: those forms mix a textarea (seed phrase) where Enter should
// insert a newline, not submit.
function bindEnterToClick(input, btn) {
  if (!input || !btn) return;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    btn.click();
  });
}
bindEnterToClick(unlockPasswordInput, unlockBtn);
bindEnterToClick(newPasswordInput, confirmCreateBtn);
bindEnterToClick(newPasswordConfirmInput, confirmCreateBtn);
bindEnterToClick(changePasswordCurrentInput, changePasswordBtn);
bindEnterToClick(changePasswordNewInput, changePasswordBtn);
bindEnterToClick(changePasswordConfirmInput, changePasswordBtn);
bindEnterToClick(aliasInput, setAliasBtn);

// Runs the mail check on the user's configured interval for as long as
// this overlay is open — this is the "even when you're not present in
// that domain's world" part: it checks every domain across ANY currently
// held credential, not just whichever world happens to be in front right
// now. Deliberately scoped to "while a Domain Atlas tab is open" rather
// than a real background service worker — see task notes discussed
// alongside this feature for why (no new extension permissions, fits the
// existing content-script-only architecture). setMailCheckInterval calls
// restartMailCheckLoop() so a changed setting takes effect immediately
// instead of waiting for the next natural fire.
let mailCheckTimer = null;
async function restartMailCheckLoop() {
  if (mailCheckTimer) clearInterval(mailCheckTimer);
  const settings = await AtlasWallet.getMailSettings();
  const ms = Math.max(1, settings.intervalMinutes) * 60 * 1000;
  mailCheckTimer = setInterval(async () => {
    await AtlasWallet.checkAllMail();
    // Cheap either way — this also keeps the tab's unread badge current
    // even when the Mail tab itself isn't the one currently open. Also
    // picks up any item reissue (SPEC.md §5.1.1) checkAllMail just
    // adopted, across every domain this wallet holds something from —
    // this is the "even when you're not standing in that domain's world"
    // half of that feature; entering a world (see checkItemUpdatesForDomain
    // below, called from enterWorld) is the immediate, single-domain half.
    await refreshMailDisplay();
    await refreshInventoryDisplay();
  }, ms);
}

// The single-domain, fire-immediately counterpart to the periodic loop
// above — same underlying AtlasWallet.checkAllMail(), just scoped via
// opts.onlyDomain and triggered by entering a world (see enterWorld)
// instead of waiting on the interval. Not awaited by its caller — see the
// comment at that call site.
function checkItemUpdatesForDomain(domain) {
  AtlasWallet.checkAllMail({ onlyDomain: domain })
    .then(async () => {
      await refreshInventoryDisplay();
      await refreshMailDisplay();
    })
    .catch(() => {
      // AtlasWallet.checkAllMail already swallows a single unreachable
      // domain's failure internally; this would only be something more
      // fundamental (no identity, storage error) — same "don't let a
      // background check disturb what's on screen" reasoning as the mail
      // loop above.
    });
}
restartMailCheckLoop();

// ---------- auto-lock on inactivity (#71) ----------
//
// "Activity" is any mouse/keyboard/wheel/touch input anywhere in this
// overlay — the wallet panel and the 3D/2D view alike — a small, broad set
// of window-level listeners rather than threading a markActivity() call
// into every existing feature-specific one (movement keydowns, cursor-hide's
// own mousemove listener at the top of this file, every wallet button).
// Passive and cheap: each one just stamps a timestamp, nothing else. A
// click on any wallet button fires its own mousedown first, so ordinary
// wallet use already counts as activity with no extra wiring at each
// button.
let lastActivityTime = Date.now();
function markActivity() { lastActivityTime = Date.now(); }
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach((type) => {
  window.addEventListener(type, markActivity, { passive: true });
});

// Checked periodically rather than with one setTimeout per configured
// timeout, so a changed setting (saveAutoLockMinutesBtn above) just takes
// effect on this loop's next pass — same reasoning restartMailCheckLoop
// documents for wanting an immediate restart, just satisfied here by
// re-reading the setting fresh each tick instead. 0 minutes (never) and a
// non-local identity mode (WebAuthn has no locked state at all — see
// wallet.js's isUnlocked()) both mean "nothing to do," checked fresh each
// time since either can change while this loop is running.
const AUTO_LOCK_CHECK_INTERVAL_MS = 15000;
setInterval(async () => {
  const minutes = await AtlasWallet.getAutoLockMinutes();
  if (!minutes) return;
  if ((await AtlasWallet.getIdentityMode()) !== 'local') return;
  if (!(await AtlasWallet.isUnlocked())) return;
  if (Date.now() - lastActivityTime < minutes * 60 * 1000) return;
  await AtlasWallet.lockIdentity();
  await refreshQuickLockButtonVisibility();
  // Same re-routing the two manual lock buttons already trigger (Settings'
  // Lock wallet, and the top-bar Quick lock) — if the panel's open to a
  // screen that only makes sense unlocked, route it to wherever locking
  // now actually leads, so all three ways of locking behave consistently.
  if (walletPanel.classList.contains('open')) await routeWalletScreen();
}, AUTO_LOCK_CHECK_INTERVAL_MS);

refreshIdentityDisplay();
refreshInventoryDisplay();
refreshMailDisplay();

const start = startParams();
if (start.manifest) {
  loadManifest(start.manifest).then(() => {
    if (start.world && start.world !== currentManifest.defaultWorld) {
      return enterWorld(start.world);
    }
  }).then(() => {
    requestAnimationFrame(render);
  });
} else {
  statusEl.textContent = 'No manifest specified.';
}
