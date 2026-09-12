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
const portalTooltipEl = document.getElementById('portalHoverTooltip');

// Task #137 — duplicate-identity join guard UI (see the presence section
// further below for the actual logic these are driven by).
const presenceJoinWaitingHintEl = document.getElementById('presenceJoinWaitingHint');
const presenceTransientHintEl = document.getElementById('presenceTransientHint');
const duplicateJoinModalEl = document.getElementById('duplicateJoinModal');
const duplicateJoinCountdownEl = document.getElementById('duplicateJoinCountdown');
const duplicateJoinLeaveBtn = document.getElementById('duplicateJoinLeaveBtn');
const duplicateJoinKeepBtn = document.getElementById('duplicateJoinKeepBtn');

// In-world chat (#105-109) — anchored bottom-left of the canvas, see the
// "in-world chat" section further below (right after presence) for the
// connection logic these elements are driven by.
const chatWidgetEl = document.getElementById('chatWidget');
const chatPanelEl = document.getElementById('chatPanel');
const chatTabBarEl = document.getElementById('chatTabBar');
const chatSettingsBtn = document.getElementById('chatSettingsBtn');
const chatResizeHandleEl = document.getElementById('chatResizeHandle');
const chatSettingsPopoverEl = document.getElementById('chatSettingsPopover');
const chatOpacityInput = document.getElementById('chatOpacityInput');
const chatTextSizeInput = document.getElementById('chatTextSizeInput');
const chatDefaultTabInput = document.getElementById('chatDefaultTabInput');
const chatHistoryOnJoinInput = document.getElementById('chatHistoryOnJoinInput');
const chatMinimizeToggleBtn = document.getElementById('chatMinimizeToggleBtn');
const chatLoginNoteEl = document.getElementById('chatLoginNote');
const chatMessagesEl = document.getElementById('chatMessages');
const chatInputRowEl = document.getElementById('chatInputRow');
const chatTextInput = document.getElementById('chatTextInput');
const chatSendStatusEl = document.getElementById('chatSendStatus');
// #115/#116 — hover tooltip and right-click menu for chat sender names.
// Declared here (not down by hiddenAssetsListEl/etc., where the OTHER
// Settings-screen list elements live) because the mouseover/contextmenu
// listeners wired further below run at script-init time and need these
// already initialized — a `const` declared later in the file would still
// be in its temporal dead zone at that point.
const chatUserTooltipEl = document.getElementById('chatUserTooltip');
const chatUserContextMenuEl = document.getElementById('chatUserContextMenu');

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
// Task #139 — the currently-attached visibilitychange listener for
// whichever poll attempt is live right now, so disconnectPresence() can
// remove it explicitly instead of leaking a new one on every reconnect
// (world switch, or the auto-rejoin pollPresence() itself now performs —
// see its own comment). Exactly one of these is ever attached at a time.
let presencePollVisibilityHandler = null;

// This visitor's own identity as announced to the current presence room
// (Friends, #67) — null/null for an anonymous visitor with no unlocked
// wallet, same as what actually gets sent in the join message. Needed by
// the "Add friend" action so it can announce who's asking, without having
// to re-look-up the wallet identity at click time (the identity might get
// locked between joining a room and clicking Add friend on someone in it —
// this keeps the signal consistent with whatever was actually announced).
let presenceOwnPublicKey = null;
let presenceOwnName = null;

// Task #137 — duplicate-identity join guard, client-side state.
//
// presenceJoinPendingChallengeId: set when THIS connection's own join
// came back "pending" (requestJoin() on the server found this identity
// already active elsewhere in the room) — drives the waiting-hint pill
// and, for the polling transport only, the join-status poll loop below
// (a WS connection instead gets the eventual 'welcome'/'join-denied'
// pushed straight down the same socket it's already holding open, so it
// needs no separate poll of its own).
let presenceJoinPendingChallengeId = null;
let presenceJoinStatusPollTimer = null;

// duplicateJoinActiveChallengeId: set when THIS connection is the
// EXISTING half of a challenge someone else just triggered — i.e. the
// Leave-now/Keep-this-session-active modal is currently open and these
// are which challenge its buttons should answer.
let duplicateJoinActiveChallengeId = null;
let duplicateJoinCountdownTimer = null;
let presenceTransientHintTimer = null;

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
//
// Task #137's two kinds ('duplicate-join-request'/'duplicate-join-lost')
// are a server-initiated notice about THIS connection's own membership,
// not a relay from another member — they carry no `from` at all, so
// they're checked before the friend-request family's `from`-requiring
// guard below, not folded into the same branch chain.
function handleIncomingSignal(msg) {
  if (!msg) return;
  if (msg.kind === 'duplicate-join-request') {
    openDuplicateJoinModal(msg.challengeId, msg.countdownMs);
    return;
  }
  if (msg.kind === 'duplicate-join-lost') {
    closeDuplicateJoinModal();
    // Task #137 — this session just lost the identity race: the server
    // already evicted its presence membership (see resolveChallenge()'s
    // own 'yield' branch), so tearing this connection down locally too
    // is just catching up to what already happened server-side, whether
    // this arrived because of this session's own "Leave now" click or
    // because the countdown lapsed unanswered.
    disconnectPresence();
    showPresenceTransientHint('You left this world — another session using your identity connected.');
    return;
  }
  if (typeof msg.from !== 'string') return;
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

// Task #137 — a one-off "shows itself, clears itself a few seconds
// later" pill notice, reused both for a duplicate-join eviction notice
// and for the silent-404-on-poll-sync fix (see pollPresence() further
// below). Calling it again while one is already showing just replaces
// the message and restarts the timer rather than stacking or racing.
function showPresenceTransientHint(text, durationMs = 6000) {
  if (!presenceTransientHintEl) return;
  if (presenceTransientHintTimer) clearTimeout(presenceTransientHintTimer);
  presenceTransientHintEl.textContent = text;
  presenceTransientHintEl.classList.add('active');
  presenceTransientHintTimer = setTimeout(() => {
    presenceTransientHintEl.classList.remove('active');
    presenceTransientHintTimer = null;
  }, durationMs);
}

function showPresenceJoinWaitingHint() {
  if (presenceJoinWaitingHintEl) presenceJoinWaitingHintEl.classList.add('active');
}
function hidePresenceJoinWaitingHint() {
  if (presenceJoinWaitingHintEl) presenceJoinWaitingHintEl.classList.remove('active');
}

// Sends this connection's own activity ping — see noteActivity()'s own
// comment in presence-server.js/store.php for what this is for. Wired
// to AtlasWallet.onWalletChanged further below; a no-op if presence
// isn't even connected right now (nothing to ping).
function sendPresenceActivityPing() {
  if (presenceSocket && presenceSocket.readyState === WebSocket.OPEN) {
    presenceSocket.send(JSON.stringify({ type: 'activity' }));
    return;
  }
  if (presencePollId && presencePollHttpBase) {
    fetch(presencePollHttpBase + '/presence/poll/activity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: presencePollId })
    }).catch(() => {});
  }
}

// This connection's own explicit answer (Leave now / Keep this session
// active) to a duplicate-join-request notice it's the EXISTING half of.
function sendDuplicateJoinResponse(challengeId, decision) {
  if (presenceSocket && presenceSocket.readyState === WebSocket.OPEN) {
    presenceSocket.send(JSON.stringify({ type: 'duplicate-join-response', challengeId, decision }));
    return;
  }
  if (presencePollId && presencePollHttpBase) {
    fetch(presencePollHttpBase + '/presence/poll/duplicate-response', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: presencePollId, challengeId, decision })
    }).catch(() => {});
  }
}

function closeDuplicateJoinModal() {
  duplicateJoinActiveChallengeId = null;
  if (duplicateJoinCountdownTimer) { clearInterval(duplicateJoinCountdownTimer); duplicateJoinCountdownTimer = null; }
  if (duplicateJoinModalEl) duplicateJoinModalEl.classList.remove('active');
}

// Opens the modal and starts its visible countdown — purely cosmetic,
// the SERVER'S OWN timer is what actually decides the default outcome;
// this one just ticks a number down so the visitor can see roughly how
// long they have, and stops cleanly at 0 rather than going negative if
// the server's own resolution message is a beat late to arrive.
function openDuplicateJoinModal(challengeId, countdownMs) {
  duplicateJoinActiveChallengeId = challengeId;
  const endsAt = Date.now() + (countdownMs || 60000);
  const tick = () => {
    const secondsLeft = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    if (duplicateJoinCountdownEl) duplicateJoinCountdownEl.textContent = String(secondsLeft);
    if (secondsLeft <= 0 && duplicateJoinCountdownTimer) { clearInterval(duplicateJoinCountdownTimer); duplicateJoinCountdownTimer = null; }
  };
  if (duplicateJoinCountdownTimer) clearInterval(duplicateJoinCountdownTimer);
  tick();
  duplicateJoinCountdownTimer = setInterval(tick, 1000);
  if (duplicateJoinModalEl) duplicateJoinModalEl.classList.add('active');
}

duplicateJoinLeaveBtn && duplicateJoinLeaveBtn.addEventListener('click', () => {
  if (!duplicateJoinActiveChallengeId) return;
  sendDuplicateJoinResponse(duplicateJoinActiveChallengeId, 'yield');
  closeDuplicateJoinModal();
  // The server's own 'duplicate-join-lost' push (sent to this exact
  // connection right before it evicts it) is what actually tears this
  // session's presence down — see handleIncomingSignal()'s own branch —
  // so nothing more needs to happen here than closing the dialog.
});

duplicateJoinKeepBtn && duplicateJoinKeepBtn.addEventListener('click', () => {
  if (!duplicateJoinActiveChallengeId) return;
  sendDuplicateJoinResponse(duplicateJoinActiveChallengeId, 'keep');
  closeDuplicateJoinModal();
});

// Task #137 — wallet activity (minting, trading, splitting, PvP-loss,
// mail-gift claims, etc.) has no presence connection of its own to ping
// through; wallet.js has no idea presence even exists. This is the one
// subscription point that bridges the two: AtlasWallet.onWalletChanged()
// fires for every saveWallet() call regardless of which action triggered
// it (see that function's own comment in wallet.js for why one hook
// there covers effectively everything), and this only actually pings the
// presence server when the change was for the SAME identity presence is
// currently announcing as — a save for the local "counterparty" stand-in
// (PvP-loss, split's "send to") should never count as activity for a
// wholly different identity's own presence session.
AtlasWallet.onWalletChanged((ownerPublicKey) => {
  if (presenceIsConnected() && presenceOwnPublicKey && ownerPublicKey === presenceOwnPublicKey) {
    sendPresenceActivityPing();
  }
});

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
  if (presencePollVisibilityHandler) { document.removeEventListener('visibilitychange', presencePollVisibilityHandler); presencePollVisibilityHandler = null; }
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
  // Task #137 — a pending join of THIS visitor's own, or a challenge THIS
  // visitor was the existing half of, is equally moot the moment presence
  // disconnects for any reason (a fast world switch, an explicit leave,
  // or the eviction handled in handleIncomingSignal's own
  // 'duplicate-join-lost' branch, which calls this function too).
  presenceJoinPendingChallengeId = null;
  if (presenceJoinStatusPollTimer) { clearInterval(presenceJoinStatusPollTimer); presenceJoinStatusPollTimer = null; }
  hidePresenceJoinWaitingHint();
  closeDuplicateJoinModal();
  if (socialFriendsTabActive()) refreshFriendsDisplay();
  updateSocialBadge();
}

function pollPresence(domain, worldId, displayName, httpBase, publicKey) {
  const base = httpBase || PRESENCE_DEFAULT_BASE;
  const token = {}; // this attempt's own identity — see the presencePollToken comment above
  presencePollToken = token;
  presenceOwnPublicKey = publicKey || null;
  presenceOwnName = displayName;

  // Finalizes this attempt once it actually has a real room membership —
  // called either immediately below (the common case) or later, once a
  // task #137 duplicate-join challenge this attempt was waiting on
  // resolves in its favor (see the 'pending' branch further down).
  function finishJoin(id, roster) {
    // Superseded by a later enterWorld() call (or a WS attempt that
    // succeeded in the meantime) before this join actually resolved —
    // leave the room we just joined rather than let a visitor "linger"
    // server-side in a world they've already left, and don't touch any
    // state a newer attempt now owns.
    if (presencePollToken !== token || !active3D) {
      fetch(base + '/presence/poll/leave', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
      }).catch(() => {});
      return;
    }
    presencePollId = id;
    presencePollHttpBase = base;
    window.__atlasPresenceOwnId = id;
    (roster || []).forEach((m) => notePresenceRosterMeta(m.id, m.name, m.publicKey));
    reconcilePollRoster(roster);
    if (socialFriendsTabActive()) refreshFriendsDisplay();

    // One heartbeat + move + roster-fetch tick. Named (not just the
    // interval's own inline callback) so a task #139 visibilitychange
    // wake-up, below, can also trigger one immediately rather than only
    // on the regular PRESENCE_POLL_INTERVAL_MS cadence.
    function syncTick() {
      if (presencePollToken !== token) return; // disconnectPresence() already clears this timer too — just a defensive guard
      const pose = currentLocalPose() || {};
      fetch(base + '/presence/poll/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ id }, pose))
      })
        .then((r) => r.json().then((body) => ({ status: r.status, body })).catch(() => ({ status: r.status, body: {} })))
        .then(({ status, body }) => {
          if (status === 404) {
            // This poll session no longer exists server-side. Two very
            // different reasons, told apart by `body.reason` (task #139):
            //   'duplicate-join-lost' — evicted after losing a task #137
            //     duplicate-join challenge elsewhere, with no separate push
            //     notice the way the WS side's 'duplicate-join-lost' signal
            //     gives. Auto-rejoining here would just immediately
            //     re-trigger a fresh challenge against whichever session
            //     actually won, fighting it forever — so this case is
            //     surfaced and left for the visitor to re-enter manually,
            //     same as before.
            //   anything else (the common case: plain staleness — most
            //     often this very tab having been backgrounded long enough
            //     for the browser to throttle this interval well past the
            //     server's staleness timeout) — nothing else is contesting
            //     this identity, so it's safe to silently self-heal:
            //     rejoin fresh with the same identity and carry on. This
            //     used to render an empty roster forever with no recovery
            //     at all; now it recovers within one tick.
            if (presencePollToken === token) {
              disconnectPresence();
              if (body.reason === 'duplicate-join-lost') {
                showPresenceTransientHint('Your presence in this world was lost — re-enter to reconnect.');
              } else {
                showPresenceTransientHint('Reconnected after a pause — your position was reset.');
                pollPresence(domain, worldId, displayName, base, publicKey);
              }
            }
            return Promise.reject(new Error('presence id expired'));
          }
          return body;
        })
        .then((res) => {
          if (presencePollToken !== token) return;
          (res.roster || []).forEach((m) => notePresenceRosterMeta(m.id, m.name, m.publicKey));
          presencePollKnownIds.forEach((pid) => { if (!(res.roster || []).some((m) => m.id === pid)) presenceRosterMeta.delete(pid); });
          reconcilePollRoster(res.roster);
          if (socialFriendsTabActive()) refreshFriendsDisplay();
          (res.signals || []).forEach((sig) => handleIncomingSignal(sig)); // friend requests etc (#67) — see poll/sync.php and its Node twin
        })
        .catch(() => {}); // a dropped tick (network hiccup, or the 404 handling above) just tries again next interval — no need to escalate
    }

    presencePollTimer = setInterval(syncTick, PRESENCE_POLL_INTERVAL_MS);
    // Task #139 — a backgrounded tab's setInterval can be throttled by the
    // browser to well beyond the server's staleness timeout, so the
    // roster can go stale long before the next tick would naturally fire.
    // Sync immediately the moment this tab becomes visible again instead
    // of waiting out however much of the throttled interval is left —
    // shrinks the "stale and about to be swept" window as much as
    // possible, on top of the self-heal above that recovers from it
    // cleanly even if it does happen.
    presencePollVisibilityHandler = () => { if (presencePollToken === token && document.visibilityState === 'visible') syncTick(); };
    document.addEventListener('visibilitychange', presencePollVisibilityHandler);
  }

  fetch(base + '/presence/poll/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, world: worldId, name: displayName, publicKey })
  })
    .then((r) => r.json())
    .then((welcome) => {
      if (presencePollToken !== token || !active3D) {
        fetch(base + '/presence/poll/leave', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: welcome.id })
        }).catch(() => {});
        return;
      }
      if (welcome.status !== 'pending') {
        finishJoin(welcome.id, welcome.roster);
        return;
      }

      // Task #137 — this identity is already active elsewhere in the
      // room; the join is held pending until that other session responds
      // or its countdown lapses. Polling has no push channel of its own,
      // so this attempt has to ask /presence/poll/join-status instead of
      // just waiting on a message the way the WS side does.
      presenceJoinPendingChallengeId = welcome.challengeId;
      showPresenceJoinWaitingHint();
      presenceJoinStatusPollTimer = setInterval(() => {
        if (presencePollToken !== token) { clearInterval(presenceJoinStatusPollTimer); presenceJoinStatusPollTimer = null; return; }
        fetch(base + '/presence/poll/join-status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId: welcome.challengeId })
        })
          .then((r) => (r.ok ? r.json() : { status: 'denied' })) // a 404 here (challenge already swept away) is functionally the same as an explicit denial — nothing left to join
          .then((status) => {
            if (presencePollToken !== token) return;
            if (status.status === 'pending') return; // still waiting — nothing to do yet
            clearInterval(presenceJoinStatusPollTimer);
            presenceJoinStatusPollTimer = null;
            presenceJoinPendingChallengeId = null;
            hidePresenceJoinWaitingHint();
            if (status.status === 'joined') {
              finishJoin(status.id, status.roster);
            } else {
              showPresenceTransientHint('The other session chose to stay — join declined.');
            }
          })
          .catch(() => {}); // a dropped tick just tries again next interval
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
      // Task #137 — a 'welcome' here can arrive either immediately (the
      // common case) or later, pushed down this SAME still-open socket
      // once a pending duplicate-join challenge this connection was
      // waiting on resolves in its favor — clearing the pending state is
      // a harmless no-op in the immediate case.
      presenceJoinPendingChallengeId = null;
      hidePresenceJoinWaitingHint();
      window.__atlasPresenceOwnId = msg.id; // test-observability, same convention as window.__atlasActive3D/__atlasScene
      (msg.roster || []).forEach((m) => { active3D.upsertRemotePlayer(m.id, m); notePresenceRosterMeta(m.id, m.name, m.publicKey); });
      if (socialFriendsTabActive()) refreshFriendsDisplay();
    } else if (msg.type === 'join-pending') {
      // Task #137 — this identity is already active elsewhere in the
      // room; held pending until that other session responds or its
      // countdown lapses. The eventual outcome arrives as a further
      // 'welcome' (see above) or 'join-denied' (below) pushed down this
      // same socket — no separate status polling needed on this
      // transport, unlike the polling fallback's own equivalent.
      presenceJoinPendingChallengeId = msg.challengeId;
      showPresenceJoinWaitingHint();
    } else if (msg.type === 'join-denied') {
      presenceJoinPendingChallengeId = null;
      hidePresenceJoinWaitingHint();
      showPresenceTransientHint('The other session chose to stay — join declined.');
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

// ---------- in-world chat (#105-109, polling fallback #110) ----------
// A read-by-anyone, send-when-unlocked text chat, riding the SAME
// presence-server process (see server.js's own "chat" section) but as a
// fully INDEPENDENT WebSocket connection from presence's — presence's own
// 'message' listener bails out whenever !active3D (see connectPresence
// above), which would silently break chat for every 2D (procedural-v1)
// world if chat piggybacked on that connection instead of getting its
// own. Two tabs, one live stream: the server scopes its room+history by
// DOMAIN alone and tags every message with `world`, so "This World" vs
// "Domain" is purely a client-side filter over the same chatMessages
// array — see renderChatMessages().
//
// Same WS-then-poll fallback shape as presence (#68): connectChat() tries
// a WebSocket first, and falls back to HTTP polling (pollChat(), the
// chat-join/-sync/-send/-leave routes) the moment that attempt fails or
// hangs past CHAT_WS_CONNECT_TIMEOUT_MS — a plain cPanel/PHP host that
// can't run a persistent WebSocket process (see presence-php/README.txt,
// and presence-php/presence/poll/chat-*.php for the deployable PHP side of
// this) simply never completes the WS handshake, and this falls back the
// same way presence already does. sendSignal() above is the template for
// "one call site, branch on which transport is actually live" — the
// Enter-key send handler below does the same thing for chat-send.
//
// Read access needs no identity at all (matches #63's "entering a world
// never requires a wallet" principle) — connectChat()/pollChat() join
// with publicKey: null for an anonymous visitor, and history/broadcasts
// go to every member of the room regardless. Sending is gated purely on
// chatOwnPublicKey being set (see refreshChatSendability()); the server
// enforces the same gate authoritatively (reason: 'login-required') on
// BOTH transports, since the client-side gate alone is just UX, never
// trusted as the real check.
const CHAT_DEFAULT_BASE = PRESENCE_DEFAULT_BASE; // same server, same base resolution as presence (manifest.presence, falling back to localhost:8004)
const CHAT_MESSAGES_CAP = 200; // client-side cap across both tabs — the server's own chatHistory buffer (CHAT_HISTORY_LIMIT) is what a late joiner actually receives
const CHAT_WS_CONNECT_TIMEOUT_MS = 2500; // matches PRESENCE_WS_CONNECT_TIMEOUT_MS — how long to let a WS attempt hang before giving up and trying polling instead
const CHAT_POLL_INTERVAL_MS = 2000; // matches PRESENCE_POLL_INTERVAL_MS — one "what's new since my cursor?" sync per tick
// Mirrors wallet.js's own CHAT_MIN_WIDTH/CHAT_MAX_WIDTH/CHAT_MIN_HEIGHT/
// CHAT_MAX_HEIGHT exactly — duplicated rather than exported so a live
// resize drag can clamp responsively before the persisted value round-
// trips through AtlasWallet.setChatPanelSettings() (which clamps again,
// authoritatively, same "never trust one layer alone" posture as the
// profanity filter's client+server duplication).
const CHAT_MIN_WIDTH = 220;
const CHAT_MAX_WIDTH = 640;
const CHAT_MIN_HEIGHT = 120;
const CHAT_MAX_HEIGHT = 480;

let chatSocket = null;
let chatMessages = []; // flat list, each tagged with `world` — see renderChatMessages() for how the active tab filters this same array
let chatDomain = null;
let chatWorldId = null;
let chatOwnPublicKey = null; // this chat connection's own announced identity — independent of presenceOwnPublicKey, since chat can be live in a 2D world where presence never connects at all
// chatTabs/chatActiveTab (dynamic tab list, replacing the old fixed
// This-World/Domain pair — see computeChatTabs()/refreshChatAvailability()
// below): chatTabs is the ordered list of {id, label} entries currently
// available for wherever the visitor is right now — 'domain' at most once,
// leftmost, plus 'world:<id>' for every world.chat-opted-in world in the
// CURRENT manifest, in manifest.worlds order. chatActiveTab is just one of
// those ids (or null before the very first refreshChatAvailability() call
// has ever run, briefly, at extension load).
let chatTabs = [];
let chatActiveTab = null;
let chatSendStatusTimer = null;

// Polling-fallback state (#68's chat counterpart) — parallels
// presencePollToken/presencePollId/presencePollTimer/presencePollHttpBase
// above exactly, including the "token" trick: a join fetch has no
// server-assigned id to compare identity against until it resolves, so
// chatPollToken is set synchronously the moment pollChat() is called and
// checked when that fetch comes back, so a superseded attempt (a fast
// world switch, or a WS attempt that succeeded in the meantime) can
// recognize it's stale and back out instead of resurrecting chat for a
// world already left behind.
let chatPollToken = null;
let chatPollId = null; // server-assigned id, set once join resolves and this attempt is still current
let chatPollTimer = null;
let chatPollHttpBase = null; // the base this poll session's id belongs to — needed by disconnectChat()'s leave beacon

function chatIsConnected() {
  return !!(chatSocket && chatSocket.readyState === WebSocket.OPEN) || !!chatPollId;
}

// Preserves "was scrolled near the bottom" across a full innerHTML
// replace, so an already-open chat keeps auto-scrolling to new messages
// while someone who's scrolled up to read history isn't yanked back down.
//
// Each sender name carries data-key/data-name/data-sentat (#115/#116) —
// everything the hover tooltip and right-click context menu below need,
// read straight back off the element the event fired on rather than
// re-looking the message up in chatMessages by index.
function renderChatList(container, msgs, emptyText) {
  if (!container) return;
  const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 24;
  if (!msgs.length) {
    container.innerHTML = '<div class="empty-note">' + escapeHtml(emptyText) + '</div>';
    return;
  }
  container.innerHTML = msgs.map((m) =>
    '<div class="chat-line"><span class="chat-name" data-key="' + escapeHtml(m.publicKey || '') + '" data-name="' + escapeHtml(m.name || 'Visitor') + '" data-sentat="' + escapeHtml(m.sentAt || '') + '">' + escapeHtml(m.name || 'Visitor') + ':</span> ' + escapeHtml(m.text) + '</div>'
  ).join('');
  if (wasNearBottom) container.scrollTop = container.scrollHeight;
}

// chatMutedKeys/chatBlockedKeys (#116) filter muted/blocked senders out of
// whichever tab is active before it ever reaches renderChatList — see
// refreshChatModerationCache() below for how this stays in sync with
// AtlasWallet's own lists.
//
// Single shared container now (was two, #chatMessagesWorld/#chatMessagesDomain,
// one per fixed tab, both always rendered and one just hidden via CSS) —
// only the CURRENTLY ACTIVE tab's filtered view is ever rendered into it,
// same "domain" = unfiltered / "world:<id>" = tagged-to-that-world-only
// split as before, just picked by chatActiveTab instead of by which of two
// containers a given render call happened to target.
function renderChatMessages() {
  const visible = chatMessages.filter((m) => !chatMutedKeys.has(m.publicKey) && !chatBlockedKeys.has(m.publicKey));
  if (chatActiveTab === 'domain') {
    renderChatList(chatMessagesEl, visible, 'No messages in this domain yet.');
  } else {
    const worldId = chatActiveTab && chatActiveTab.indexOf('world:') === 0 ? chatActiveTab.slice('world:'.length) : chatWorldId;
    renderChatList(chatMessagesEl, visible.filter((m) => m.world === worldId), 'No messages in this world yet.');
  }
}

// chatTabForWorld() is the one place the 'world:' + id convention is
// spelled out — every other call site goes through this (or compares
// against chatActiveTab directly) rather than concatenating the prefix
// itself, so the convention only has to be right once.
function chatTabForWorld(worldId) {
  return 'world:' + worldId;
}

// Recomputes the ordered tab list for a given manifest — 'domain' at most
// once, always leftmost, when manifest.chat === true; then one
// 'world:<id>' entry per manifest.worlds[] entry (in that array's declared
// order) with its own world.chat === true. Called fresh on every world
// entry (see refreshChatAvailability()) rather than cached, so a domain
// that changes its manifest between visits is picked up automatically,
// same as every other manifest-derived bit of UI in this file.
function computeChatTabs(manifest) {
  const tabs = [];
  if (manifest && manifest.chat === true) tabs.push({ id: 'domain', label: 'Domain' });
  if (manifest && Array.isArray(manifest.worlds)) {
    for (const w of manifest.worlds) {
      if (w && w.chat === true) tabs.push({ id: chatTabForWorld(w.id), label: w.name });
    }
  }
  return tabs;
}

// Renders the tab bar from chatTabs/chatActiveTab — a "(current)" suffix
// (no space, e.g. "Lobby(current)") is appended to whichever tab is the
// world the visitor is PHYSICALLY standing in right now, i.e. currentWorld
// — never the "Domain" tab, which by construction never matches a
// 'world:<id>' id. Re-run on every refreshChatAvailability() (a fresh
// tab list, so the suffix naturally moves off a world you've left) and
// after every manual tab click (so the active-tab highlight follows).
function renderChatTabBar() {
  if (!chatTabBarEl) return;
  const currentWorldTabId = currentWorld ? chatTabForWorld(currentWorld.id) : null;
  chatTabBarEl.innerHTML = chatTabs.map((tab) => {
    const suffix = tab.id === currentWorldTabId ? '(current)' : '';
    const activeClass = tab.id === chatActiveTab ? ' active-subtab' : '';
    return '<button type="button" class="chat-tab' + activeClass + '" data-tab-id="' + escapeHtml(tab.id) + '">' + escapeHtml(tab.label + suffix) + '</button>';
  }).join('');
}

// Manual tab click (delegated — the tab list is rebuilt wholesale on every
// world entry, so a per-button listener would need constant re-attaching,
// same reasoning as every other delegated list handler in this file).
chatTabBarEl && chatTabBarEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab-id]');
  if (!btn) return;
  showChatTab(btn.dataset.tabId);
});

function showChatTab(tabId) {
  chatActiveTab = tabId;
  if (chatTabBarEl) {
    chatTabBarEl.querySelectorAll('[data-tab-id]').forEach((btn) => {
      btn.classList.toggle('active-subtab', btn.dataset.tabId === tabId);
    });
  }
  renderChatMessages();
  refreshChatSendability(); // which tab is active is now part of whether sending is currently allowed — see refreshChatSendability()'s own comment
}

// ---------- chat moderation: mute/block local cache (#116) ----------
// renderChatMessages() needs a synchronous yes/no per message (it's called
// from a WebSocket 'message' handler, among other non-async call sites), so
// the two AtlasWallet-backed lists are mirrored here as plain Sets, kept
// current by refreshChatModerationCache() — called once at load and again
// after every mute/unmute/block/unblock action anywhere in this file.
let chatMutedKeys = new Set();
let chatBlockedKeys = new Set();
async function refreshChatModerationCache() {
  const [muted, blocked] = await Promise.all([AtlasWallet.getMutedChatUsers(), AtlasWallet.getBlockedChatUsers()]);
  chatMutedKeys = new Set(muted.map((m) => m.publicKey));
  chatBlockedKeys = new Set(blocked.map((b) => b.publicKey));
}
refreshChatModerationCache();

// ---------- chat username hover tooltip (#115) ----------
// Same floating-singleton-div approach as renderPortalTooltip/
// #portalHoverTooltip above: one element, moved and filled in per-hover
// rather than one per message. "Online" is checked against
// presenceRosterMeta, the SAME live roster the Friends screen already uses
// for "people here now" — not a new presence mechanism. That roster is
// presence's own (3D-world-only, see connectPresence()), so a 2D world (or
// a sender who was never a 3D presence member, e.g. they've since left)
// simply won't show up in it; the tooltip words this as "not currently
// shown as present" rather than a flat "offline" it can't actually prove.
function isChatSenderOnline(publicKey) {
  if (!publicKey) return false;
  if (publicKey === chatOwnPublicKey || publicKey === presenceOwnPublicKey) return true; // this viewer's own identity is obviously online right now
  for (const meta of presenceRosterMeta.values()) {
    if (meta.publicKey === publicKey) return true;
  }
  return false;
}

function renderChatUserTooltip(name, sentAt, online) {
  if (!chatUserTooltipEl) return;
  const when = sentAt ? new Date(sentAt).toLocaleString() : 'unknown time';
  chatUserTooltipEl.innerHTML =
    '<div style="font-weight:600;margin-bottom:2px;">' + escapeHtml(name) + '</div>' +
    '<div>Sent ' + escapeHtml(when) + '</div>' +
    '<div>' + (online ? '🟢 Online now' : '⚪ Not currently shown as present') + '</div>';
}

function hideChatUserTooltip() {
  if (chatUserTooltipEl) chatUserTooltipEl.style.display = 'none';
}

// Delegated on #chatPanel (the shared ancestor of #chatMessages, the
// single message-list container) rather than per-span, same reasoning as
// every other delegated list handler in this file — messages come and go
// with every render, a per-element listener would need constant re-attaching.
// 'mouseover'/'mouseout' (not 'mouseenter'/'mouseleave', which don't
// bubble) is what makes delegation possible at all here.
chatPanelEl && chatPanelEl.addEventListener('mouseover', (e) => {
  const nameEl = e.target.closest('.chat-name');
  if (!nameEl) return;
  const rect = nameEl.getBoundingClientRect();
  renderChatUserTooltip(nameEl.dataset.name, nameEl.dataset.sentat, isChatSenderOnline(nameEl.dataset.key || null));
  chatUserTooltipEl.style.left = rect.left + 'px';
  chatUserTooltipEl.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  chatUserTooltipEl.style.display = 'block';
});
chatPanelEl && chatPanelEl.addEventListener('mouseout', (e) => {
  const nameEl = e.target.closest('.chat-name');
  if (!nameEl) return;
  // Only hide if the pointer actually left the name span, not just moved
  // to a child of it (it has none today, but this is the correct general
  // check, same as e.g. the mail-card-menu's own outside-click guard).
  if (nameEl.contains(e.relatedTarget)) return;
  hideChatUserTooltip();
});

// ---------- chat username right-click menu (#116): private message / mute / block ----------
// Visual/interaction pattern reused from mail's own "⋯" block-sender menu
// (renderMailCard's blockHtml, .mail-card-menu-items in viewer.html) — dark
// card, thin border, full-width stacked buttons — via #chatUserContextMenu's
// own CSS, just a standalone singleton positioned at the click point
// (there's no one fixed toggle button to anchor a right-click menu under)
// instead of `position:absolute` under a per-card toggle.
let chatContextMenuTarget = null; // {key, name} for whichever name this menu is currently open for

function closeChatUserContextMenu() {
  if (chatUserContextMenuEl) chatUserContextMenuEl.classList.remove('show');
  chatContextMenuTarget = null;
}

chatPanelEl && chatPanelEl.addEventListener('contextmenu', (e) => {
  const nameEl = e.target.closest('.chat-name');
  if (!nameEl || !chatUserContextMenuEl) return;
  e.preventDefault();
  chatContextMenuTarget = { key: nameEl.dataset.key || null, name: nameEl.dataset.name || 'Visitor' };
  hideChatUserTooltip(); // don't leave the hover tooltip floating over an open menu
  // Clamped so a name near the right/bottom edge of the viewport doesn't
  // open a menu that spills off-screen — same rough idea as any other
  // viewport-aware popover, just done by hand since this one isn't CSS-
  // anchored to anything.
  const menuWidth = 170;
  const menuHeight = 110;
  const left = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
  const top = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
  chatUserContextMenuEl.style.left = Math.max(8, left) + 'px';
  chatUserContextMenuEl.style.top = Math.max(8, top) + 'px';
  chatUserContextMenuEl.classList.add('show');
});

document.addEventListener('click', (e) => {
  if (e.target.closest('#chatUserContextMenu')) return;
  closeChatUserContextMenu();
});

// Private message: no live/real-time private-chat feature exists yet (a
// separate, not-in-scope backlog item) — instead this jumps straight to
// Mail's Compose tab, pre-addressed to this chat user's public key, reusing
// openComposeReply() exactly as Quick Reply on a mail card already does
// (including its own friend-picker resolution — a public key that happens
// to match a saved friend shows that friend's name instead of the raw key,
// with no separate recipient-resolution logic written for chat at all).
async function openChatPrivateMessage(key, name) {
  if (!key) { showChatSendStatus('This visitor has no identity to message.'); return; }
  walletPanel.classList.add('open');
  if (!(await AtlasWallet.isUnlocked())) {
    await routeWalletScreen();
    showChatSendStatus('Unlock your wallet, then try Private message again.');
    return;
  }
  await openComposeReply({ domain: chatDomain || (currentManifest && currentManifest.domain), key, handle: null, subject: '' });
}

chatUserContextMenuEl && chatUserContextMenuEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || !chatContextMenuTarget) return;
  const { key, name } = chatContextMenuTarget;
  closeChatUserContextMenu();

  if (btn.dataset.action === 'chat-pm') {
    await openChatPrivateMessage(key, name);
  } else if (btn.dataset.action === 'chat-mute') {
    if (!key) { showChatSendStatus('This visitor has no identity to mute.'); return; }
    await AtlasWallet.muteChatUser(key, name);
    await refreshChatModerationCache();
    renderChatMessages();
  } else if (btn.dataset.action === 'chat-block') {
    if (!key) { showChatSendStatus('This visitor has no identity to block.'); return; }
    await AtlasWallet.blockChatUser(key, name);
    await refreshChatModerationCache();
    renderChatMessages();
  }
});

// ---------- chat capability opt-in (#111/#112) ----------
// Chat used to activate unconditionally for every world on any domain with
// a working presence backend. Now a domain has to actually ask for it, via
// two new implementation-only manifest fields (same category as the
// existing `presence`/`postOffice` fields — not part of SPEC.md, just
// client+demo-content convenience): manifest.chat === true turns chat on
// for every world in the domain, and an individual world.chat === true
// turns it on for just that one world regardless of the domain-wide flag.
// Effective-enabled is simply "either one says yes" — see enterWorld()
// below for where this actually gates connectChat()/disconnectChat() and
// the widget's own visibility.
//
// Deliberately a client-side-only gate — a UX/product opt-in layer, not a
// security boundary. There's no server-side check on either presence-
// server or presence-php enforcing it (and there couldn't meaningfully be
// one yet): same as presence itself, a "domain" here is just whatever the
// client claims when it joins a room, so this only ever controls whether
// the CLIENT bothers to connect and show the widget at all, never whether
// the server would accept the connection.
function chatEnabledForWorld(manifest, world) {
  return !!(manifest && manifest.chat === true) || !!(world && world.chat === true);
}

// Called every time enterWorld() lands on a (possibly new) world — shows or
// hides the whole chat widget, recomputes the dynamic tab list (see
// computeChatTabs()) to match what THIS domain+world actually declared,
// and picks the initially-active tab per the defaultTabPreference setting
// (#113, revised below for a tab list that's no longer a fixed pair).
// #chatWidget sets its own `display: flex` in CSS (needed for its flex
// column layout), which beats the `[hidden]` attribute's UA-stylesheet
// `display: none` regardless of specificity — author rules always win
// over user-agent ones — so this uses .style.display for the widget
// itself, same convention as canvas/hintEl/portalTooltipEl elsewhere in
// this file for elements with an explicit CSS display.
async function refreshChatAvailability(manifest, world) {
  const enabled = chatEnabledForWorld(manifest, world);
  if (chatWidgetEl) chatWidgetEl.style.display = enabled ? '' : 'none';
  if (!enabled) { chatTabs = []; chatActiveTab = null; return; }

  chatTabs = computeChatTabs(manifest);
  const currentWorldTabId = world ? chatTabForWorld(world.id) : null;
  const hasOwnWorldTab = !!currentWorldTabId && chatTabs.some((t) => t.id === currentWorldTabId);
  const hasDomainTab = chatTabs.some((t) => t.id === 'domain');

  // defaultTabPreference (#113) decides which tab a freshly-entered world
  // opens on. The old fixed This-World/Domain pair had a real "whichever
  // tab is already selected" concept for 'auto' to preserve — every tab
  // is now a distinct named world (or Domain), so that concept doesn't
  // carry over. 'auto' is a deliberate, permanent alias for 'world' from
  // here on, not merely "not implemented yet" — see the setting's own
  // comment in viewer.html for the same note facing the settings UI.
  const { defaultTabPreference } = await AtlasWallet.getChatPanelSettings();
  const preference = defaultTabPreference === 'auto' ? 'world' : defaultTabPreference;

  let nextTab;
  if (preference === 'domain') {
    nextTab = hasDomainTab ? 'domain' : (hasOwnWorldTab ? currentWorldTabId : null);
  } else { // 'world'
    nextTab = hasOwnWorldTab ? currentWorldTabId : (hasDomainTab ? 'domain' : null);
  }
  // Edge-case fallback — should only ever matter if the computed
  // preference somehow names a tab that isn't actually in the list;
  // there's always at least one tab here, since the widget is only shown
  // at all once `enabled` above has already confirmed something is.
  if (!nextTab || !chatTabs.some((t) => t.id === nextTab)) nextTab = chatTabs.length ? chatTabs[0].id : null;

  chatActiveTab = nextTab;
  renderChatTabBar();
  renderChatMessages();
  refreshChatSendability();
}

function chatErrorText(reason) {
  if (reason === 'login-required') return 'Unlock your wallet to send chat messages.';
  if (reason === 'blocked') return 'Message blocked — please rephrase.';
  if (reason === 'empty') return 'Type a message first.';
  return 'Message not sent.';
}

function showChatSendStatus(text) {
  if (!chatSendStatusEl) return;
  chatSendStatusEl.textContent = text || '';
  if (chatSendStatusTimer) clearTimeout(chatSendStatusTimer);
  if (text) chatSendStatusTimer = setTimeout(() => { chatSendStatusEl.textContent = ''; }, 4000);
}

// Send eligibility depends on two independent things now: whether an
// identity is currently announced to this connection (as before — not the
// socket's live open/closed state, checked separately at send time in the
// Enter-key handler, so a momentary reconnect shouldn't visibly flicker
// the input disabled/enabled on every world switch), AND whether the
// ACTIVE tab is one sending is even allowed from. All of the tabs feed off
// the same domain-scoped stream (that's what makes browsing another
// world's tab possible at all — see chatEnabledForWorld()/connectChat()),
// but a message is only ever allowed to go out while the visitor is
// looking at "Domain" or their own current-location tab — not while
// they're merely BROWSING some other world's tab they happen to also have
// access to. Sent messages are still tagged with chatWorldId (the world
// you're actually connected to chat FOR) exactly as before regardless —
// this only ever gates whether sending is currently allowed, never what a
// sent message ends up tagged with.
function refreshChatSendability() {
  if (!chatTextInput) return;
  const onSendableTab = chatActiveTab === 'domain' || chatActiveTab === chatTabForWorld(chatWorldId);
  const canSend = !!chatOwnPublicKey && onSendableTab;
  chatTextInput.disabled = !canSend;
  if (!chatOwnPublicKey) {
    chatTextInput.placeholder = 'Sign in to chat…';
  } else if (!onSendableTab) {
    chatTextInput.placeholder = 'Switch here or to Domain to send a message';
  } else {
    chatTextInput.placeholder = 'Message this domain…';
  }
  if (chatLoginNoteEl) {
    chatLoginNoteEl.textContent = !chatOwnPublicKey
      ? 'Unlock your wallet to send messages. Anyone can still read chat.'
      : (!onSendableTab ? 'You can read every tab, but only send from Domain or your current world.' : '');
  }
}

function disconnectChat() {
  if (chatSocket) {
    const socket = chatSocket;
    chatSocket = null;
    try { socket.send(JSON.stringify({ type: 'chat-leave' })); } catch (err) {}
    try { socket.close(); } catch (err) {}
  }
  chatPollToken = null; // invalidates any in-flight join or running poll interval from this point on, see pollChat()
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  if (chatPollId) {
    const id = chatPollId;
    const base = chatPollHttpBase;
    chatPollId = null;
    chatPollHttpBase = null;
    // Best-effort, same as disconnectPresence()'s own leave beacon — a
    // closed tab won't reach this, that's what the server's staleness
    // sweep is for.
    fetch(base + '/presence/poll/chat-leave', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
    }).catch(() => {});
  }
  chatDomain = null;
  chatWorldId = null;
  chatOwnPublicKey = null;
  chatMessages = [];
  renderChatMessages();
  refreshChatSendability();
}

// Polling counterpart of connectChat()'s WebSocket path — same shape as
// pollPresence() above, including the "superseded before this resolved"
// guard (chatPollToken) and immediately leaving a room this attempt just
// joined if a newer attempt has already taken over by the time the join
// fetch actually comes back.
function pollChat(domain, worldId, displayName, publicKey, httpBase, historyOnJoin) {
  const base = httpBase || CHAT_DEFAULT_BASE;
  const token = {};
  chatPollToken = token;

  fetch(base + '/presence/poll/chat-join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, world: worldId, name: displayName, publicKey })
  })
    .then((r) => r.json())
    .then((welcome) => {
      if (chatPollToken !== token || chatDomain !== domain || chatWorldId !== worldId) {
        fetch(base + '/presence/poll/chat-leave', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: welcome.id })
        }).catch(() => {});
        return;
      }
      chatPollId = welcome.id;
      chatPollHttpBase = base;
      chatOwnPublicKey = publicKey;
      refreshChatSendability();
      // historyOnJoin off (purely local — see wallet.js's comment):
      // discard the join response's history batch instead of asking the
      // server to withhold it; the list starts empty and only grows from
      // whatever a later chat-sync delta actually delivers.
      chatMessages = historyOnJoin ? (welcome.messages || []).slice(-CHAT_MESSAGES_CAP) : [];
      renderChatMessages();

      chatPollTimer = setInterval(() => {
        if (chatPollToken !== token) return; // disconnectChat() already clears this timer too — just a defensive guard
        fetch(base + '/presence/poll/chat-sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: welcome.id })
        })
          .then((r) => r.json())
          .then((res) => {
            if (chatPollToken !== token) return;
            const delta = res.messages || [];
            if (!delta.length) return;
            chatMessages = chatMessages.concat(delta);
            if (chatMessages.length > CHAT_MESSAGES_CAP) chatMessages = chatMessages.slice(-CHAT_MESSAGES_CAP);
            renderChatMessages();
          })
          .catch(() => {}); // a dropped tick just tries again next interval — no need to escalate
      }, CHAT_POLL_INTERVAL_MS);
    })
    .catch(() => {}); // chat is a pure enhancement, including its fallback — never surfaced as an error
}

function connectChat(domain, worldId, presenceBase) {
  chatDomain = domain;
  chatWorldId = worldId;
  chatMessages = [];
  renderChatMessages();

  const base = presenceBase || CHAT_DEFAULT_BASE;
  AtlasWallet.getIdentity().then(async (identity) => {
    const alias = identity ? await AtlasWallet.getAlias(identity.publicKey) : null;
    const displayName = alias || (identity ? short(identity.publicKey, 10) : 'Visitor');
    const publicKey = identity ? identity.publicKey : null;
    // historyOnJoin (purely local — see wallet.js's own comment on this
    // setting): read once per connectChat() attempt, used below to decide
    // whether the history batch this join is about to receive gets shown
    // or discarded. Neither transport is asked to change what IT sends —
    // this only ever affects what the client does with it after the fact.
    const { historyOnJoin } = await AtlasWallet.getChatPanelSettings();

    // Superseded before the identity lookup even resolved (a fast world
    // switch, or refreshChatIdentity() firing again before this settled)
    // — never let a stale attempt clobber a newer one's state.
    if (chatDomain !== domain || chatWorldId !== worldId) return;

    let socket;
    try {
      socket = new WebSocket(presenceWsUrlFor(base));
    } catch (err) {
      pollChat(domain, worldId, displayName, publicKey, base, historyOnJoin); // WebSocket unsupported/blocked outright — go straight to polling
      return;
    }
    if (chatDomain !== domain || chatWorldId !== worldId) { try { socket.close(); } catch (err) {} return; }

    // Same fallback-timer shape as connectPresence() above: if the WS
    // attempt hasn't opened OR failed within this window (a server that
    // exists but never completes the handshake — the exact plain-PHP-
    // hosting case this fallback is for, see presence-php/presence/poll/
    // chat-*.php), stop waiting on it and fall back to polling anyway.
    let settled = false;
    const fallbackTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (chatSocket !== socket) return; // superseded — nothing to fall back FOR
      chatSocket = null;
      try { socket.close(); } catch (err) {}
      pollChat(domain, worldId, displayName, publicKey, base, historyOnJoin);
    }, CHAT_WS_CONNECT_TIMEOUT_MS);

    chatSocket = socket;
    chatOwnPublicKey = publicKey;
    refreshChatSendability();

    socket.addEventListener('open', () => {
      if (chatSocket !== socket) { try { socket.close(); } catch (err) {} return; }
      settled = true;
      clearTimeout(fallbackTimer);
      socket.send(JSON.stringify({ type: 'chat-join', domain, world: worldId, name: displayName, publicKey }));
    });

    socket.addEventListener('message', (ev) => {
      if (chatSocket !== socket) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (err) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'chat-history') {
        // historyOnJoin off (purely local — see wallet.js's comment):
        // discard the batch the server just sent instead of asking it to
        // withhold anything — the list simply starts empty and only grows
        // from whatever 'chat-message' pushes arrive from here on.
        chatMessages = historyOnJoin ? (msg.messages || []).slice(-CHAT_MESSAGES_CAP) : [];
        renderChatMessages();
      } else if (msg.type === 'chat-message') {
        chatMessages.push(msg.message);
        if (chatMessages.length > CHAT_MESSAGES_CAP) chatMessages.shift();
        renderChatMessages();
      } else if (msg.type === 'chat-error') {
        showChatSendStatus(chatErrorText(msg.reason));
      }
    });

    socket.addEventListener('close', () => {
      const wasCurrent = chatSocket === socket;
      if (wasCurrent) chatSocket = null;
      // A close that arrives before the WS ever opened (handshake
      // rejected, connection refused) is exactly the "try polling
      // instead" case — but only if this attempt was still the live one
      // AND nothing has settled it yet, same wasCurrent guard
      // connectPresence()'s own close listener uses and for the same
      // reason (a disconnectChat() that closed this socket on its way
      // out must not then resurrect chat for a world already left).
      if (!settled) {
        settled = true;
        clearTimeout(fallbackTimer);
        if (wasCurrent) pollChat(domain, worldId, displayName, publicKey, base, historyOnJoin);
      }
    });

    // presence-server unreachable/down, or the connection dropped mid-
    // world. The 'close' listener above (which always fires after
    // 'error' for a WebSocket) does the actual fallback decision — this
    // just has to exist so the failed connection doesn't surface as an
    // unhandled error.
    socket.addEventListener('error', () => {});
  }).catch(() => {});
}

// Re-announces this chat connection's identity the moment the wallet locks
// or unlocks, without waiting for the visitor to leave and re-enter the
// world — wired into the unlock/lock button handlers below. Captures the
// current domain/world into locals BEFORE calling disconnectChat() (which
// clears chatDomain/chatWorldId to null), otherwise there'd be nothing
// left to reconnect to.
function refreshChatIdentity() {
  if (!chatDomain || !chatWorldId) { refreshChatSendability(); return; }
  // Defensive gate (#111) — chatDomain/chatWorldId are only ever set by a
  // connectChat() call that already passed this same check in enterWorld(),
  // so this should never actually trip in practice, but a call site that
  // reconnects chat has to honor the opt-in gate too, not just the two that
  // establish the connection in the first place.
  if (!chatEnabledForWorld(currentManifest, currentWorld)) {
    disconnectChat();
    refreshChatAvailability(currentManifest, currentWorld);
    return;
  }
  const domain = chatDomain;
  const worldId = chatWorldId;
  const presenceBase = (currentManifest && currentManifest.domain === domain) ? currentManifest.presence : null;
  disconnectChat();
  connectChat(domain, worldId, presenceBase);
}

// Sends over whichever transport is actually live right now, same
// WS-first-else-poll-relay branch sendSignal() above uses for presence's
// friend requests. The poll path posts straight to chat-send and handles
// the response inline (no separate "on next sync" round trip needed for
// the sender's own message) rather than waiting for it to come back
// through a later chat-sync poll — that would mean seeing your own
// message appear up to CHAT_POLL_INTERVAL_MS after sending it, and the
// server's sendChatMessage() already advances the sender's own cursor so
// it never arrives a second time via chat-sync either.
chatTextInput && chatTextInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const text = chatTextInput.value.trim();
  if (!text) return;
  if (!chatOwnPublicKey) { showChatSendStatus(chatErrorText('login-required')); return; }
  // Defensive — the input is already .disabled while browsing a
  // non-sendable tab (see refreshChatSendability()), so Enter shouldn't
  // normally even reach here in that state, but a tab switch racing this
  // keydown (or any other path that bypasses the disabled attribute) must
  // not be able to send tagged-elsewhere despite what the UI shows.
  if (chatActiveTab !== 'domain' && chatActiveTab !== chatTabForWorld(chatWorldId)) {
    showChatSendStatus('Switch here or to Domain to send a message');
    return;
  }
  if (!chatIsConnected()) { showChatSendStatus('Not connected — try again in a moment.'); return; }
  if (AtlasWallet.chatMessageContainsBlockedWord(text)) { showChatSendStatus(chatErrorText('blocked')); return; }

  if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
    chatSocket.send(JSON.stringify({ type: 'chat-send', text }));
    chatTextInput.value = '';
    return;
  }
  if (chatPollId && chatPollHttpBase) {
    const requestId = chatPollId;
    fetch(chatPollHttpBase + '/presence/poll/chat-send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: requestId, text })
    })
      .then((r) => r.json())
      .then((result) => {
        if (chatPollId !== requestId) return; // superseded (a world switch, or a lock/unlock reconnect) mid-request — don't touch state a newer attempt now owns
        if (result.ok) {
          chatMessages.push(result.message);
          if (chatMessages.length > CHAT_MESSAGES_CAP) chatMessages.shift();
          renderChatMessages();
        } else {
          showChatSendStatus(chatErrorText(result.reason));
        }
      })
      .catch(() => showChatSendStatus('Not connected — try again in a moment.'));
    chatTextInput.value = '';
  }
});

// ---------- chat panel settings: opacity, text size, resize, minimize ----------
// Persisted via AtlasWallet.get/setChatPanelSettings() (wallet.js,
// chrome.storage.local, global scope — a display preference usable even
// without an unlocked identity, same convention as atlasCharacterScale).

function applyChatPanelSize(settings) {
  if (!chatPanelEl) return;
  chatPanelEl.style.width = settings.width + 'px';
  if (chatInputRowEl) chatInputRowEl.style.width = settings.width + 'px';
  if (chatWidgetEl) chatWidgetEl.style.opacity = String(settings.opacity);
  if (chatMessagesEl) chatMessagesEl.style.fontSize = settings.textSize + 'px';
  if (chatTextInput) chatTextInput.style.fontSize = settings.textSize + 'px';
  if (chatOpacityInput) chatOpacityInput.value = String(settings.opacity);
  if (chatTextSizeInput) chatTextSizeInput.value = String(settings.textSize);
  if (chatDefaultTabInput) chatDefaultTabInput.value = settings.defaultTabPreference;
  if (chatHistoryOnJoinInput) chatHistoryOnJoinInput.checked = !!settings.historyOnJoin;
  if (chatWidgetEl) chatWidgetEl.classList.toggle('minimized', !!settings.minimized);
  if (chatMinimizeToggleBtn) chatMinimizeToggleBtn.textContent = settings.minimized ? 'Show' : 'Minimize';
  if (!settings.minimized) chatPanelEl.style.height = settings.height + 'px';
}

chatSettingsBtn && chatSettingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  chatSettingsPopoverEl.hidden = !chatSettingsPopoverEl.hidden;
});
// Outside-click closes the popover — same pattern as the mail card's "⋯"
// menu (#101): a single delegated document listener rather than one per
// popover.
document.addEventListener('click', (e) => {
  if (chatSettingsPopoverEl && !chatSettingsPopoverEl.hidden && !chatSettingsPopoverEl.contains(e.target) && e.target !== chatSettingsBtn) {
    chatSettingsPopoverEl.hidden = true;
  }
});

chatOpacityInput && chatOpacityInput.addEventListener('input', async () => {
  applyChatPanelSize(await AtlasWallet.setChatPanelSettings({ opacity: parseFloat(chatOpacityInput.value) }));
});
chatTextSizeInput && chatTextSizeInput.addEventListener('input', async () => {
  applyChatPanelSize(await AtlasWallet.setChatPanelSettings({ textSize: parseInt(chatTextSizeInput.value, 10) }));
});
chatDefaultTabInput && chatDefaultTabInput.addEventListener('change', async () => {
  applyChatPanelSize(await AtlasWallet.setChatPanelSettings({ defaultTabPreference: chatDefaultTabInput.value }));
});
chatHistoryOnJoinInput && chatHistoryOnJoinInput.addEventListener('change', async () => {
  applyChatPanelSize(await AtlasWallet.setChatPanelSettings({ historyOnJoin: chatHistoryOnJoinInput.checked }));
});

chatMinimizeToggleBtn && chatMinimizeToggleBtn.addEventListener('click', async () => {
  const current = await AtlasWallet.getChatPanelSettings();
  const settings = current.minimized
    // Restoring — bring back the size captured right before minimizing.
    ? await AtlasWallet.setChatPanelSettings({ minimized: false, width: current.lastSize.width, height: current.lastSize.height })
    : await AtlasWallet.setChatPanelSettings({ minimized: true, lastSize: { width: current.width, height: current.height } });
  applyChatPanelSize(settings);
});

// Drag-resize: the handle sits at the panel header's top-right corner
// (its "far corner" from the bottom-left anchor, see viewer.html) —
// dragging right grows width normally, but dragging UP grows height,
// since the panel's BOTTOM edge is what stays anchored in place, not its
// top (see #chatWidget's bottom-anchored CSS).
let chatResizeDrag = null;
chatResizeHandleEl && chatResizeHandleEl.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const rect = chatPanelEl.getBoundingClientRect();
  chatResizeDrag = { startX: e.clientX, startY: e.clientY, startWidth: rect.width, startHeight: rect.height };
});
document.addEventListener('mousemove', (e) => {
  if (!chatResizeDrag) return;
  const width = Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, chatResizeDrag.startWidth + (e.clientX - chatResizeDrag.startX)));
  const height = Math.max(CHAT_MIN_HEIGHT, Math.min(CHAT_MAX_HEIGHT, chatResizeDrag.startHeight + (chatResizeDrag.startY - e.clientY)));
  chatPanelEl.style.width = width + 'px';
  if (chatInputRowEl) chatInputRowEl.style.width = width + 'px';
  chatPanelEl.style.height = height + 'px';
});
document.addEventListener('mouseup', async () => {
  if (!chatResizeDrag) return;
  chatResizeDrag = null;
  const rect = chatPanelEl.getBoundingClientRect();
  // Snaps back to the clamped/persisted value if anything drifted mid-drag.
  applyChatPanelSize(await AtlasWallet.setChatPanelSettings({ width: Math.round(rect.width), height: Math.round(rect.height) }));
});

const walletBtn = document.getElementById('walletBtn');
const walletBadge = document.getElementById('walletBadge');
const walletPanel = document.getElementById('walletPanel');
const quickLockWalletBtn = document.getElementById('quickLockWalletBtn');

// Social tab (#61/#67): Mail, Contacts, Favorites as three sub-screens of
// one top-level tab — see showWalletScreen()/showSocialSubtab() below for
// how the two levels of tabbing interact.
const socialTabBtn = document.getElementById('socialTabBtn');
const socialBadge = document.getElementById('socialBadge');
const socialScreen = document.getElementById('socialScreen');
const mailSubtabBtn = document.getElementById('mailSubtabBtn');
const contactsSubtabBtn = document.getElementById('contactsSubtabBtn');
const favoritesSubtabBtn = document.getElementById('favoritesSubtabBtn');
const mailSubscreen = document.getElementById('mailSubscreen');
const contactsSubscreen = document.getElementById('contactsSubscreen');
const favoritesSubscreen = document.getElementById('favoritesSubscreen');
const friendRequestsBadge = document.getElementById('friendRequestsBadge');

// Contacts' own inner sub-tab bar (Contacts / Add Contact / Groups) — see
// showContactsSubtab() below. Same nested pattern as Mail's own inner
// sub-tab bar right below.
const contactsListSubtabBtn = document.getElementById('contactsListSubtabBtn');
const addContactSubtabBtn = document.getElementById('addContactSubtabBtn');
const contactGroupsSubtabBtn = document.getElementById('contactGroupsSubtabBtn');
const contactsListSubscreen = document.getElementById('contactsListSubscreen');
const addContactSubscreen = document.getElementById('addContactSubscreen');
const contactGroupsSubscreen = document.getElementById('contactGroupsSubscreen');
const addContactBadge = document.getElementById('addContactBadge');

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
const mailSenderFilterInput = document.getElementById('mailSenderFilterInput');
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
const composeFriendPickerInput = document.getElementById('composeFriendPickerInput');
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
const contactsListEl = document.getElementById('contactsList');
const contactsSearchInput = document.getElementById('contactsSearchInput');

// Manual add-by-address form (Add Contact sub-tab) — same handle-vs-raw-key
// toggle pattern as Compose's recipient field, see postOfficeToggleRawKeyBtn.
const manualAddNameInput = document.getElementById('manualAddNameInput');
const manualAddHandleInput = document.getElementById('manualAddHandleInput');
const manualAddPublicKeyInput = document.getElementById('manualAddPublicKeyInput');
const manualAddToggleRawKeyBtn = document.getElementById('manualAddToggleRawKeyBtn');
const manualAddContactBtn = document.getElementById('manualAddContactBtn');
const manualAddContactStatusEl = document.getElementById('manualAddContactStatus');

// Groups sub-tab (new, local-only — see AtlasWallet.getContactGroups et al.
// in wallet.js).
const newGroupNameInput = document.getElementById('newGroupNameInput');
const createGroupBtn = document.getElementById('createGroupBtn');
const groupsStatusEl = document.getElementById('groupsStatus');
const contactGroupsListEl = document.getElementById('contactGroupsList');

const addCurrentFavoriteBtn = document.getElementById('addCurrentFavoriteBtn');
const addCurrentFavoriteStatusEl = document.getElementById('addCurrentFavoriteStatus');
const favoritesListEl = document.getElementById('favoritesList');

// Calendar (Social's fourth sub-tab) — see AtlasWallet.getCalendarEvents
// and refreshCalendarDisplay() below.
const calendarSubtabBtn = document.getElementById('calendarSubtabBtn');
const calendarSubscreen = document.getElementById('calendarSubscreen');
const calendarBadge = document.getElementById('calendarBadge');
const calendarEventTitleInput = document.getElementById('calendarEventTitleInput');
const calendarEventDateTimeInput = document.getElementById('calendarEventDateTimeInput');
const calendarEventEndDateTimeInput = document.getElementById('calendarEventEndDateTimeInput');
const calendarEventNotesInput = document.getElementById('calendarEventNotesInput');
const calendarSaveEventBtn = document.getElementById('calendarSaveEventBtn');
const calendarCancelEditBtn = document.getElementById('calendarCancelEditBtn');
const calendarEventStatusEl = document.getElementById('calendarEventStatus');
const calendarEventsListEl = document.getElementById('calendarEventsList');
const calendarMonthLabelEl = document.getElementById('calendarMonthLabel');
const calendarMonthGridEl = document.getElementById('calendarMonthGrid');
const calendarPrevMonthBtn = document.getElementById('calendarPrevMonthBtn');
const calendarNextMonthBtn = document.getElementById('calendarNextMonthBtn');
const calendarDayViewerEl = document.getElementById('calendarDayViewer');
const calendarDayViewerHeaderEl = document.getElementById('calendarDayViewerHeader');
const calendarDayViewerBodyEl = document.getElementById('calendarDayViewerBody');

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
const chatMutedUsersListEl = document.getElementById('chatMutedUsersList');
const chatBlockedUsersListEl = document.getElementById('chatBlockedUsersList');
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
const tradeTabBtn = document.getElementById('tradeTabBtn');
const tradeScreen = document.getElementById('tradeScreen');
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
const collectiblesCompatOnlyCheckbox = document.getElementById('collectiblesCompatOnlyCheckbox');
const selfCollectiblesListEl = document.getElementById('selfCollectiblesList');
const counterpartyCollectiblesListEl = document.getElementById('counterpartyCollectiblesList');
const droppedItemsSectionEl = document.getElementById('droppedItemsSection');
const droppedItemsListEl = document.getElementById('droppedItemsList');
const documentsSearchInput = document.getElementById('documentsSearchInput');
const documentsCompatOnlyCheckbox = document.getElementById('documentsCompatOnlyCheckbox');
const selfDocumentsListEl = document.getElementById('selfDocumentsList');
const counterpartyDocumentsListEl = document.getElementById('counterpartyDocumentsList');
// Task #144 Phase 1 — Remote trade sub-tab of the Trading station category.
const tradingBuySubtabBtn = document.getElementById('tradingBuySubtabBtn');
const tradingSellSubtabBtn = document.getElementById('tradingSellSubtabBtn');
const tradingListingsSubtabBtn = document.getElementById('tradingListingsSubtabBtn');
const tradingBuySubscreen = document.getElementById('tradingBuySubscreen');
const tradingSellSubscreen = document.getElementById('tradingSellSubscreen');
const tradingListingsSubscreen = document.getElementById('tradingListingsSubscreen');
const tradingStationBarEl = document.getElementById('tradingStationBar');
const tradingStationJoinSectionEl = document.getElementById('tradingStationJoinSection');
const tradingStationJoinBtn = document.getElementById('tradingStationJoinBtn');
const tradingStationJoinStatusEl = document.getElementById('tradingStationJoinStatus');
const remoteTradeStationDomainSelect = document.getElementById('remoteTradeStationDomainSelect');
const tradingBuyRefreshBtn = document.getElementById('tradingBuyRefreshBtn');
const tradingBuyListEl = document.getElementById('tradingBuyList');
const tradingBuyStatusEl = document.getElementById('tradingBuyStatus');
const tradingSellOfferClassSelect = document.getElementById('tradingSellOfferClassSelect');
const tradingSellOfferQtyInput = document.getElementById('tradingSellOfferQtyInput');
const tradingSellWantClassSelect = document.getElementById('tradingSellWantClassSelect');
const tradingSellWantQtyInput = document.getElementById('tradingSellWantQtyInput');
const tradingSellExpiresHoursInput = document.getElementById('tradingSellExpiresHoursInput');
const tradingSellSubmitBtn = document.getElementById('tradingSellSubmitBtn');
const tradingSellStatusEl = document.getElementById('tradingSellStatus');
const tradingListingsListEl = document.getElementById('tradingListingsList');
const tradingListingsStatusEl = document.getElementById('tradingListingsStatus');

// Asset Viewer (task #150) — see the big comment block above
// openAssetViewer() (further below, near renderAssetCard) for the whole
// hover/sticky-bridge/resize/settings design; these are just its DOM refs,
// declared alongside the other Inventory-screen elements above since
// renderAssetCard() (which wires the hover) lives right next to them.
const assetViewerWidgetEl = document.getElementById('assetViewerWidget');
const assetViewerPanelEl = document.getElementById('assetViewerPanel');
const assetViewerHeaderEl = document.getElementById('assetViewerHeader');
const assetViewerBodyEl = document.getElementById('assetViewerBody');
const assetViewerSettingsBtn = document.getElementById('assetViewerSettingsBtn');
const assetViewerResizeHandleEl = document.getElementById('assetViewerResizeHandle');
const assetViewerSettingsPopoverEl = document.getElementById('assetViewerSettingsPopover');
const assetViewerOpacityInput = document.getElementById('assetViewerOpacityInput');
const assetViewerTextSizeInput = document.getElementById('assetViewerTextSizeInput');

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
  const targetWorldId = worldId || manifest.defaultWorld;
  const targetWorld = manifest.worlds.find((w) => w.id === targetWorldId) || manifest.worlds[0];
  // Task #63: checked BEFORE any currentManifest/currentManifestUrl/
  // currentOrigin assignment below — this is what makes "stay exactly
  // where you are" on cancel actually true. Covers every loadManifest()
  // caller in one place: a domain portal (followPortal), Favorites/Recent
  // Worlds (travelToRecentWorld), and the very first landing on a domain.
  if (!(await ensureIdentityForEntry(manifest, targetWorld))) return;
  currentManifest = manifest;
  currentManifestUrl = manifestUrl;
  currentOrigin = new URL(manifestUrl).origin;
  await enterWorld(targetWorldId);
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
  await refreshTradingStationJoinButton();
  await refreshRemoteTradeStationOptions();
  await refreshMyPublicKeyDisplay();
  refreshWorldGates();

  placeLabel.innerHTML = world.name + ' <span class="domain">' + manifest.domain + ' · ' + world.id + '</span>';
  // document.title here is a no-op for anything actually visible — this
  // document is an extension-origin IFRAME, cross-origin from the host page,
  // and an iframe doesn't own the top-level browser tab title no matter what
  // it sets its own .title to. The real tab title lives in the host page's
  // document, reachable only via postMessage — content.js's message
  // listener is the other half of this, mirroring the existing
  // 'domain-atlas-close' pattern. Sent on every enterWorld() landing (both
  // the 3D and 2D branches below reach this same line, and so does the very
  // first world on initial page load via loadManifest()), independent of
  // whether chat happens to be enabled for this world — the tab title isn't
  // a chat feature and shouldn't silently stop updating just because a
  // world hasn't opted into chat.
  document.title = 'Domain Atlas — ' + world.name;
  window.parent.postMessage({ type: 'domain-atlas-title', title: manifest.domain + ': ' + world.name }, '*');
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
  disconnectChat(); // ...and its chat room — chat reconnects fresh below for whichever renderer path this world actually takes (2D or 3D), unlike presence which is 3D-only, but ONLY if the new world actually opted in (#111) — see refreshChatAvailability() just below
  await refreshChatAvailability(manifest, world); // shows/hides the widget + Domain tab for wherever we just landed, whether or not a scene ends up loading successfully below
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
      if (chatEnabledForWorld(manifest, world)) connectChat(manifest.domain, world.id, manifest.presence); // #111 — only if this world (or the whole domain) actually opted in
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
    // Chat has no visible character to attach to (unlike presence, #66),
    // so unlike connectPresence() it isn't gated on the 3D renderer at
    // all — a 2D (procedural-v1) world gets a live chat room too. Still
    // gated on the world/domain actually opting in (#111) same as the 3D
    // branch above.
    if (chatEnabledForWorld(manifest, world)) connectChat(manifest.domain, world.id, manifest.presence);
  } catch (err) {
    statusEl.textContent = 'Could not load world: ' + err.message;
    window.__atlasScene = { floor: { size: [10, 10], color: '#2a1a1a' }, objects: [], portalMarkers: [], itemMarkers: [], interactables: [] };
  }
}

async function followPortal(portal) {
  if (!portal) return;
  if (portal.kind === 'world') {
    // Same-origin scene swap: reuse the already-cached manifest, no re-fetch.
    // Task #63: gate checked here, before enterWorld() touches anything —
    // loadManifest() below covers its own callers, but a same-world portal
    // never goes through loadManifest() at all, so it needs its own check.
    const targetWorld = currentManifest.worlds.find((w) => w.id === portal.to);
    if (!(await ensureIdentityForEntry(currentManifest, targetWorld))) return;
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
  ctx.fillText(marker.action === 'open-chess' ? 'click to play' : 'click to collect', base.x, base.y + 22);

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

// ---------- portal hover tooltip ----------
//
// Same idea as content.js's Enter-Space hover tooltip (task #65) — richer
// scene detail than the small name/kind label drawPortal() already draws
// permanently under a portal, surfaced only on hover instead of cluttering
// the scene at all times. Only for THIS 2D/procedural-v1 renderer: portals
// here are canvas-drawn shapes with no individual DOM element to attach a
// native hover listener to, so hit-testing rides on the exact same
// portalHitboxes distance check the click handler above already does.
// (The gltf-mini-v1/3D renderer's portals are walk-into proximity
// triggers — see gltf-mini.js's portalTriggers — with no mouse-hover
// interaction model to hang a tooltip off of, so this doesn't apply there.)
//
// A "world" portal's destination is already fully known — same cached
// manifest, just a different entry in currentManifest.worlds — so that
// case never needs a fetch. A "domain" portal's destination lives on a
// different origin entirely, so its detail arrives async (one fetch per
// distinct target manifest, cached in domainPortalInfoCache so re-hovering
// the same portal, or several portals to the same domain, doesn't repeat
// it); the tooltip shows what it already knows (the portal's own label)
// immediately and fills in genre/scale/capabilities once that resolves —
// same "show a placeholder, then fill it in" shape as content.js's tooltip.
let hoveredPortalMarker = null;
const domainPortalInfoCache = new Map(); // manifest URL -> Promise<world|null>

// Task #152 (follow-up to #151, prompted by Bruno hitting both gaps live
// while writing his own evtec.co.za manifest):
//
// 1. A domain-level DEFAULT for acceptedItemClasses. Same two-level shape
//    as manifest.chat/world.chat (see chatEnabledForWorld() above), except
//    "world wins outright if it declares anything at all" rather than an
//    OR — a world's own array, even an empty one, is a deliberate
//    "recognizes nothing via this mechanism" statement (per SPEC.md line
//    334 and task #151's own notes) and must never be silently merged with
//    or overridden by the domain default. Only a world that omits the
//    field entirely falls back to manifest.acceptedItemClasses. This is
//    what lets a domain with many worlds declare its shared class list
//    ONCE instead of copy-pasting the identical array into every world's
//    policy block.
// 2. Trailing-".*" CATEGORY matching — "atlas.element.*" matches
//    "atlas.element.iron", "atlas.element.gold", etc. without hand-listing
//    every element, the exact friction Bruno hit trying "atlas.element" and
//    "atlas.wearable" expecting them to cover their whole families. Plain
//    prefix-of-the-dotted-string matching, not a general glob: the "*" only
//    ever appears as the trailing segment after a literal ".", so
//    "atlas.element.*" won't accidentally also match an unrelated
//    "atlas.elementary.thing". An entry with no trailing ".*" still means
//    exactly that one class, same as before either of these existed.
function effectiveAcceptedItemClasses(manifest, world) {
  const policy = (world && world.policy) || {};
  if (Array.isArray(policy.acceptedItemClasses)) return policy.acceptedItemClasses;
  if (manifest && Array.isArray(manifest.acceptedItemClasses)) return manifest.acceptedItemClasses;
  return [];
}
function classMatchesPattern(cls, pattern) {
  return pattern.endsWith('.*') ? cls.startsWith(pattern.slice(0, -1)) : cls === pattern;
}
function classMatchesAny(cls, patterns) {
  return patterns.some((p) => classMatchesPattern(cls, p));
}

// Task #63, SPEC.md §3.4.1: same two-tier shape as effectiveAcceptedItemClasses
// just above — a world's own policy.identityRequired wins outright when
// present (including an explicit `false` under a domain-wide `true`
// default), the manifest's top-level identityRequired is only a fallback
// for a world that omits the field entirely. Both demo domains already
// declare it explicitly on every world today (nothing currently relies on
// the domain-level fallback branch), so this is here mainly for a future
// manifest that wants to set the default once instead of repeating it.
function effectiveIdentityRequired(manifest, world) {
  const policy = (world && world.policy) || {};
  if (policy.identityRequired !== undefined) return !!policy.identityRequired;
  if (manifest && manifest.identityRequired !== undefined) return !!manifest.identityRequired;
  return false;
}

// Task #63: the one check that has to pass before a visitor actually lands
// in a world, no matter which of the three ways they got there (a portal,
// a direct Favorites/Recent-Worlds jump, or the very first landing on a
// domain) — see loadManifest()/followPortal() below, both of which call
// this BEFORE touching any currentManifest/currentWorld state. Returns
// true immediately if the world doesn't require an identity, or already
// has one; otherwise hands off to waitForIdentityViaWallet() and returns
// whatever that resolves to. A false result means the visitor should stay
// exactly where they were — safe by construction here, since neither
// caller has mutated anything yet by the time this runs.
async function ensureIdentityForEntry(manifest, world) {
  if (!effectiveIdentityRequired(manifest, world)) return true;
  if (await AtlasWallet.getIdentity()) return true;
  return waitForIdentityViaWallet();
}

// `manifest` is the world's OWNING manifest — needed alongside `world`
// itself because manifest.chat (domain-wide chat opt-in, see
// chatEnabledForWorld() above) and now manifest.acceptedItemClasses (task
// #152, just above) both live one level up from their per-world
// counterparts. Also surfaces (task #151): a "trading" bit for a world a
// client can recognize as a trading venue by its declared genre (SPEC.md
// §7 — "profile.genre as a venue for live exchange"; "trading-station" is
// this reference implementation's own convention, same as the demo domains
// use), and an "accepts drops"/"issuers" bit built from the exact same
// policy.acceptedItemClasses/policy.trustedIssuers fields
// isAssetCompatibleWithWorld() reads for the Inventory checkbox — nothing
// new to declare, just the same already-existing manifest data finally
// surfaced somewhere a visitor sees it BEFORE stepping through the portal.
function portalCapabilitySummary(world, manifest) {
  const cap = (world.profile && world.profile.capabilities) || {};
  const bits = [];
  if (cap.combat && cap.combat !== 'none') bits.push('combat: ' + cap.combat);
  if (cap.building && cap.building !== 'none') bits.push('building: ' + cap.building);
  if (cap.vehicles) bits.push('vehicles');
  if (cap.landOwnership) bits.push('land ownership');
  if (chatEnabledForWorld(manifest, world)) bits.push('chat');
  if (world.profile && world.profile.genre === 'trading-station') bits.push('trading');
  const policy = world.policy || {};
  if (policy.itemDropsAllowed) {
    const classes = effectiveAcceptedItemClasses(manifest, world);
    bits.push('accepts drops' + (classes.length ? ': ' + classes.join(', ') : ''));
    if (policy.trustedIssuers && policy.trustedIssuers !== 'any') {
      bits.push('issuers: ' + (Array.isArray(policy.trustedIssuers) ? policy.trustedIssuers.join(', ') : policy.trustedIssuers));
    }
  }
  return bits.length ? bits.join(' · ') : 'no special capabilities declared';
}

async function fetchDomainPortalWorld(portal) {
  if (!portal.manifest) return null;
  if (domainPortalInfoCache.has(portal.manifest)) return domainPortalInfoCache.get(portal.manifest);
  const promise = (async () => {
    try {
      const res = await fetch(portal.manifest, { cache: 'no-store' });
      if (!res.ok) return null;
      const manifest = await res.json();
      const world = manifest.worlds.find((w) => w.id === manifest.defaultWorld) || manifest.worlds[0] || null;
      return world ? { manifest, world } : null;
    } catch (err) {
      return null; // unreachable domain — tooltip just stays label-only, not an error worth surfacing here
    }
  })();
  domainPortalInfoCache.set(portal.manifest, promise);
  return promise;
}

// `world` is undefined while a domain portal's detail is still loading
// (shows "…"), null once it's known to be unavailable (fetch failed, or a
// same-domain portal pointing at an id this manifest doesn't actually
// have), or the resolved world object otherwise. `manifest` is that world's
// own owning manifest (currentManifest for a same-domain "world" portal,
// the fetched cross-domain manifest for a "domain" one) — needed only for
// the chat bit in portalCapabilitySummary above.
function renderPortalTooltip(portal, world, manifest) {
  if (!portalTooltipEl) return;
  const isCrossDomain = portal.kind === 'domain';
  const lines = [
    '<div style="font-weight:600;margin-bottom:2px;">' + escapeHtml(portal.label || (isCrossDomain ? 'Cross-domain portal' : 'Portal')) + '</div>'
  ];
  if (isCrossDomain) lines.push('<div style="color:#a9b8bf;">⇢ ' + escapeHtml(portal.to) + '</div>');
  if (world === undefined) {
    lines.push('<div>…</div>');
  } else if (world === null) {
    lines.push('<div>Scene details unavailable</div>');
  } else {
    const genre = (world.profile && world.profile.genre) || 'unspecified';
    const scale = (world.profile && world.profile.scale) || 'unspecified';
    lines.push('<div>' + escapeHtml(world.name) + ' · Genre: ' + escapeHtml(genre) + ' · Scale: ' + escapeHtml(scale) + '</div>');
    lines.push('<div>' + escapeHtml(portalCapabilitySummary(world, manifest)) + '</div>');
  }
  portalTooltipEl.innerHTML = lines.join('');
}

canvas.addEventListener('mousemove', (e) => {
  if (pendingDropCredentialId) return; // mid-drop crosshair takes priority — see the click handler's own comment above

  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  let hit = null;
  for (const hb of portalHitboxes) {
    const dist = Math.hypot(cx - hb.sx, cy - hb.sy);
    if (dist < hb.radius && hb.marker.portal) { hit = hb; break; }
  }

  if (!hit) {
    hoveredPortalMarker = null;
    canvas.style.cursor = '';
    portalTooltipEl.style.display = 'none';
    return;
  }

  canvas.style.cursor = 'pointer';
  portalTooltipEl.style.left = (rect.left + hit.sx + 18) + 'px';
  portalTooltipEl.style.top = (rect.top + hit.sy - 10) + 'px';
  portalTooltipEl.style.display = 'block';

  // hb.marker is stable across animation frames (rebuilt only on
  // enterWorld — see window.__atlasScene above), unlike hb itself, which
  // render() reconstructs every frame; comparing the marker rather than hb
  // is what keeps this to one lookup/fetch per genuinely NEW portal
  // hovered, not once per mousemove event.
  if (hoveredPortalMarker === hit.marker) return;
  hoveredPortalMarker = hit.marker;
  const portal = hit.marker.portal;

  if (portal.kind === 'world') {
    const world = (currentManifest && currentManifest.worlds.find((w) => w.id === portal.to)) || null;
    renderPortalTooltip(portal, world, currentManifest);
  } else if (portal.kind === 'domain') {
    renderPortalTooltip(portal, undefined, null);
    fetchDomainPortalWorld(portal).then((result) => {
      if (hoveredPortalMarker === hit.marker) renderPortalTooltip(portal, result ? result.world : null, result ? result.manifest : null);
    });
  } else {
    renderPortalTooltip(portal, null, null);
  }
});

canvas.addEventListener('mouseleave', () => {
  hoveredPortalMarker = null;
  portalTooltipEl.style.display = 'none';
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

// The give-away button hands out ONE specific, concrete class — unlike the
// Inventory compatibility check (which matches an ownership set against a
// declared list), this has to pick a single mintable class name out of the
// world's (or domain's, task #152) effective accepted list. A trailing-".*"
// category entry like "atlas.element.*" isn't itself a real class (nothing
// in any ASSET_CATALOG is literally named that), so this skips over any
// wildcard entries and returns the first concrete one. A world/domain that
// declares only wildcard categories — nothing concrete at all — behaves
// the same as declaring no accepted classes: null here, same as before
// this feature existed, and refreshRequestButton()'s existing "This world
// issues nothing" message covers it with no extra casing needed.
function giveawayClassFor(world) {
  if (!world || !world.policy || !world.policy.itemDropsAllowed) return null;
  const classes = effectiveAcceptedItemClasses(currentManifest, world);
  return classes.find((c) => !c.endsWith('.*')) || null;
}

// Same oncePerUser courtesy check handleInteractable() uses for an in-scene
// "issue" stall (see the note there) — extended here so the generic
// "Request item from this world" button behaves the same way instead of
// letting repeated clicks quietly fill the wallet with duplicates. Still
// just a per-device courtesy, not real protocol-level scarcity (SPEC.md).
async function alreadyHasRequestableItem(world) {
  const cls = giveawayClassFor(world);
  if (!cls) return false;
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return false;
  const wallet = await AtlasWallet.getWallet(identity.publicKey);
  return wallet.some((e) => e.credential.asset.class === cls && e.credential.issuer.domain === manifestDomainOf(currentManifest));
}

async function refreshRequestButton() {
  const world = currentWorld;
  const cls = giveawayClassFor(world);
  if (!cls) {
    requestItemBtn.disabled = true;
    requestItemBtn.textContent = 'This world issues nothing';
    return;
  }
  if (await alreadyHasRequestableItem(world)) {
    requestItemBtn.disabled = true;
    requestItemBtn.textContent = 'Already collected ' + cls + ' from ' + world.name;
    return;
  }
  requestItemBtn.disabled = false;
  requestItemBtn.textContent = 'Request ' + cls + ' from ' + world.name;
}

function refreshWorldGates() {
  const world = currentWorld;
  const risky = combatOf(world) !== 'none';
  loadoutNoteEl.textContent = risky
    ? '⚠ This world is flagged "' + combatOf(world) + '" — items you load here can be lost under its rules. Anything left in your wallet stays safe.'
    : '';

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
  // Tabs only make sense between Wallet, Social, Trade, and Settings —
  // everything else (onboarding, unlock, create) has nothing to tab
  // between yet and keeps its own dedicated navigation.
  const showTabs = id === 'mainWalletScreen' || id === 'socialScreen' || id === 'tradeScreen' || id === 'settingsScreen';
  if (walletTabBar) walletTabBar.classList.toggle('visible', showTabs);
  if (walletTabBtn) walletTabBtn.classList.toggle('active-tab', id === 'mainWalletScreen');
  if (socialTabBtn) socialTabBtn.classList.toggle('active-tab', id === 'socialScreen');
  if (tradeTabBtn) tradeTabBtn.classList.toggle('active-tab', id === 'tradeScreen');
  if (settingsTabBtn) settingsTabBtn.classList.toggle('active-tab', id === 'settingsScreen');
}

// Social tab's own second level of tabbing (#61/#67): Mail / Contacts /
// Favorites / Calendar, same show-one-hide-the-rest idea as
// showWalletScreen() one level up, just scoped to .social-subscreen instead
// of .wallet-screen.
function showSocialSubtab(id) {
  [mailSubscreen, contactsSubscreen, favoritesSubscreen, calendarSubscreen].forEach((el) => el && el.classList.toggle('active', el && el.id === id));
  if (mailSubtabBtn) mailSubtabBtn.classList.toggle('active-subtab', id === 'mailSubscreen');
  if (contactsSubtabBtn) contactsSubtabBtn.classList.toggle('active-subtab', id === 'contactsSubscreen');
  if (favoritesSubtabBtn) favoritesSubtabBtn.classList.toggle('active-subtab', id === 'favoritesSubscreen');
  if (calendarSubtabBtn) calendarSubtabBtn.classList.toggle('active-subtab', id === 'calendarSubscreen');
}

function socialFriendsTabActive() {
  return !!(contactsSubscreen && contactsSubscreen.classList.contains('active'));
}

// Contacts' own third level of tabbing: Contacts (the saved list, default)
// / Add Contact (People here now, Friend requests, manual add-by-address)
// / Groups. Same show-one-hide-the-rest pattern as showMailInnerSubtab()
// below, just scoped to Contacts' three .subscreen elements.
function showContactsSubtab(id) {
  [contactsListSubscreen, addContactSubscreen, contactGroupsSubscreen].forEach((el) => el && el.classList.toggle('active', el && el.id === id));
  if (contactsListSubtabBtn) contactsListSubtabBtn.classList.toggle('active-subtab', id === 'contactsListSubscreen');
  if (addContactSubtabBtn) addContactSubtabBtn.classList.toggle('active-subtab', id === 'addContactSubscreen');
  if (contactGroupsSubtabBtn) contactGroupsSubtabBtn.classList.toggle('active-subtab', id === 'contactGroupsSubscreen');
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

// Trading station category's own In-person / Buy / Sell / Listings split
// (task #144 Phase 1, reshaped to open listings in v1.14) — same
// show-one-hide-the-rest idea as showInventorySubtab just above.
// tradingStationBarEl is shared across Buy/Sell/Listings (see its own
// comment in viewer.html) rather than being one of the four .subscreen
// elements, so it's toggled separately here instead of via the forEach.
// Refreshes whatever the newly-shown screen displays on the way in, same
// "refresh whatever a tab shows the moment it's opened" convention as
// refreshComposeFriendPicker on Compose-tab open.
function showTradingSubtab(id) {
  [tradingBuySubscreen, tradingSellSubscreen, tradingListingsSubscreen]
    .forEach((el) => el && el.classList.toggle('active', el && el.id === id));
  if (tradingBuySubtabBtn) tradingBuySubtabBtn.classList.toggle('active-subtab', id === 'tradingBuySubscreen');
  if (tradingSellSubtabBtn) tradingSellSubtabBtn.classList.toggle('active-subtab', id === 'tradingSellSubscreen');
  if (tradingListingsSubtabBtn) tradingListingsSubtabBtn.classList.toggle('active-subtab', id === 'tradingListingsSubscreen');

  if (id === 'tradingBuySubscreen') {
    refreshTradingStationJoinButton();
    refreshRemoteTradeStationOptions();
    if (tradingBuyStatusEl) tradingBuyStatusEl.textContent = '';
    refreshTradingBuyList();
  } else if (id === 'tradingSellSubscreen') {
    refreshTradingStationJoinButton();
    refreshRemoteTradeStationOptions();
    refreshTradingSellOfferOptions();
  } else if (id === 'tradingListingsSubscreen') {
    refreshTradingListingsList();
  }
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
    // Mail/friend-request badges already refresh themselves off their own
    // triggers (a mail check tick, a live presence signal, visiting Social)
    // — Calendar has neither of those, it's pure local storage, so opening
    // the wallet panel at all is this feature's own refresh trigger (see
    // calendarSubscreen's comment in viewer.html on why nothing fires while
    // the panel is closed).
    await updateSocialBadge();
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

// Task #63: opens the wallet panel to whichever screen actually fits
// (routeWalletScreen already resolves onboarding vs. unlock vs.
// already-unlocked) and waits for either an identity to become available
// or the panel to be closed without one. Deliberately doesn't care HOW the
// visitor got there — a password unlock, a fresh local identity, or a
// fresh WebAuthn one all end the same way, AtlasWallet.getIdentity()
// turning truthy — so this polls that rather than hooking every
// onboarding/unlock/import code path individually (there are several, and
// they'd all need to remember to call back into whatever was waiting).
// Closes the panel again on success so whatever was waiting on this —
// entering a world, an in-world action — is immediately visible with no
// second click; leaves everything untouched on cancel, since "the panel
// is closed" is literally the condition that resolves this false.
function waitForIdentityViaWallet() {
  walletPanel.classList.add('open');
  routeWalletScreen();
  statusEl.textContent = 'This requires an unlocked wallet identity — finish that in the panel to continue.';
  return new Promise((resolve) => {
    const POLL_MS = 300;
    const check = async () => {
      // Deliberately NOT just "does an identity exist" — createIdentity()
      // (confirmCreateBtn) unlocks the identity immediately, well before
      // the user has actually confirmed they saved their seed phrase on
      // the screen shown right after it (seedRevealBox, outside the normal
      // screen system — see showWalletScreen(null) there). Resolving on
      // raw identity-existence would yank the wallet panel closed out from
      // under that still-visible confirmation step. mainWalletScreen only
      // ever becomes active once every onboarding/unlock path has actually
      // finished end to end (confirmCreateBtn's own seedConfirmBtn, the
      // unlock button, import, WebAuthn create all land there explicitly)
      // — that, plus a real identity existing, is the right "actually
      // done" signal.
      if (mainWalletScreen.classList.contains('active') && (await AtlasWallet.getIdentity())) {
        walletPanel.classList.remove('open');
        resolve(true);
        return;
      }
      if (!walletPanel.classList.contains('open')) {
        statusEl.textContent = 'Cancelled — the wallet was closed before unlocking.';
        resolve(false);
        return;
      }
      setTimeout(check, POLL_MS);
    };
    check();
  });
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
// ---------- Asset Viewer hover panel (task #150) ----------
//
// Hovering an asset card in either Inventory list (Collectibles or
// Documents — both rendered by renderAssetCard() below, whichever
// side/owner they belong to) opens this floating panel near the card: full
// name/class/issuer/properties (no click-to-expand toggle here — unlike
// the card itself, this panel has room to just show everything), the
// asset's thumbnail if its credential has one, and a "Show model" button
// if it also has a model (SPEC.md §5's optional `asset.thumbnail`/
// `asset.model` fields — an issuer may set neither, either, or both; see
// renderAssetViewerContent() below for the "neither" fallback).
//
// The tricky part isn't showing it — it's NOT closing it the instant the
// mouse leaves the card, or "Show model" (which only exists once the
// panel is already open) could never actually be reached: the panel would
// close before the mouse finishes traveling from the card onto it. So this
// is a sticky hover bridge, same idea as a CSS-only dropdown menu's own
// "bridge" trick, done in JS because this panel's positioning already is:
// leaving the CARD starts a short close timer (ASSET_VIEWER_CLOSE_GRACE_MS)
// rather than closing immediately; entering the PANEL before that timer
// fires cancels it outright; leaving the panel with no re-entry into
// either the card or the panel within the same grace window is what
// actually closes it. See scheduleAssetViewerClose()/
// cancelAssetViewerCloseTimer() below, and the mouseenter/mouseleave
// wiring at the bottom of renderAssetCard() plus on assetViewerPanelEl
// itself just below this block.
//
// Settings (opacity/text size) and the resize handle are this panel's own
// equivalents of the chat panel's #chatSettingsBtn/#chatSettingsPopover and
// #chatResizeHandle (see viewer.js's "chat panel settings" section above),
// backed by AtlasWallet.get/setAssetViewerSettings() (wallet.js) instead of
// get/setChatPanelSettings() — same shape, same clamp-on-read-and-write
// discipline, just this panel's own fields.

const ASSET_VIEWER_CLOSE_GRACE_MS = 200;

let assetViewerSettingsCache = null; // last-applied settings, used for position math (see positionAssetViewer) without a synchronous storage read
let assetViewerCurrentEntry = null; // the wallet entry the panel is currently showing, or null while closed
let assetViewerCloseTimer = null;
let assetViewerModelPreview = null; // {dispose()} from window.MiniGLTF.previewModel(), or null while no model canvas is live
let assetViewerModelLoadToken = 0; // bumped on every dispose/re-open so a slow in-flight fetch can tell it's stale and drop its result silently
let assetViewerDragActive = false; // true for the duration of a resize drag — suspends the close timer entirely (see its own comment below)

function applyAssetViewerSettings(settings) {
  assetViewerSettingsCache = settings;
  if (!assetViewerPanelEl) return;
  assetViewerPanelEl.style.width = settings.width + 'px';
  assetViewerPanelEl.style.height = settings.height + 'px';
  assetViewerPanelEl.style.opacity = String(settings.opacity);
  if (assetViewerBodyEl) assetViewerBodyEl.style.fontSize = settings.textSize + 'px';
  if (assetViewerOpacityInput) assetViewerOpacityInput.value = String(settings.opacity);
  if (assetViewerTextSizeInput) assetViewerTextSizeInput.value = String(settings.textSize);
}

// Positions the widget near the hovered card, same "float close enough for
// the hover bridge to feel continuous, clamp to the viewport" approach as
// renderPortalTooltip/renderChatUserTooltip above. #walletPanel docks along
// the screen's right edge (see its own CSS), so every asset card lives
// near that edge too — this opens to the card's LEFT by default (toward
// the middle of the screen, where there's actually room), falling back to
// the right only if the viewport is too narrow for that.
function positionAssetViewer(cardEl) {
  const rect = cardEl.getBoundingClientRect();
  const width = assetViewerSettingsCache ? assetViewerSettingsCache.width : 280;
  const height = assetViewerSettingsCache ? assetViewerSettingsCache.height : 240;
  const gap = 10;
  let left = rect.left - gap - width;
  if (left < 8) left = rect.right + gap; // not enough room to the left — try the right instead
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8));
  assetViewerWidgetEl.style.left = left + 'px';
  assetViewerWidgetEl.style.top = top + 'px';
}

// Full, non-toggled properties list — deliberately NOT renderPropertiesToggle()
// (below): the card's own inline version is a click-to-expand toggle to
// save space on a small card; this panel has the room to just show
// everything directly, per task #150.
function renderAssetViewerProperties(properties) {
  if (!properties || typeof properties !== 'object') return '';
  const entries = Object.entries(properties);
  if (entries.length === 0) return '';
  return '<div class="asset-viewer-properties">' +
    entries.map(([key, value]) => '<div>' + key + ': ' + formatPropertyValue(value) + '</div>').join('') +
    '</div>';
}

function renderAssetViewerContent(entry) {
  const asset = entry.credential.asset;
  const fungible = !!asset.fungible;
  let html =
    '<div class="name">' + asset.name + (fungible ? ' ×' + entry.credential.quantity : '') + '</div>' +
    '<div class="meta">' + asset.class + ' · issued by ' + entry.credential.issuer.domain + '</div>';
  // Graceful fallback (task #150 point 6): both fields are optional per
  // SPEC.md §5 — an issuer may set neither, so a class minted without them
  // just skips straight to properties with no image area and no button,
  // never a broken-image icon or a thrown error.
  if (asset.thumbnail) {
    html += '<img class="asset-viewer-thumbnail" src="' + asset.thumbnail + '" alt="">';
  }
  html += renderAssetViewerProperties(asset.properties);
  if (asset.model) {
    html += '<button type="button" id="assetViewerShowModelBtn" data-model="' + asset.model + '">Show model</button>';
  }
  html += '<div id="assetViewerModelArea"></div>';
  assetViewerBodyEl.innerHTML = html;
  // The broken-image fallback above used to be an inline onerror="..."
  // attribute in the HTML string — Chrome's built-in extension-page CSP
  // (script-src with no 'unsafe-inline') blocks ALL inline event handler
  // attributes outright, so that never actually ran; it just logged a CSP
  // violation to the console every time a thumbnail was shown. Wiring the
  // same behavior as a real property assignment after the element exists
  // isn't "inline execution" under CSP, so it works — and does the exact
  // same thing (remove the element if its image 404s or otherwise fails).
  if (asset.thumbnail) {
    const thumbnailEl = assetViewerBodyEl.querySelector('.asset-viewer-thumbnail');
    if (thumbnailEl) thumbnailEl.onerror = () => thumbnailEl.remove();
  }
}

// Only ever one live preview context at a time (task #150 point 2's
// WebGL-lifecycle requirement) — called before starting a new one AND on
// every path that ends the panel's current one (switching to a different
// asset, or closing the panel outright).
function disposeAssetViewerModelPreview() {
  assetViewerModelLoadToken++; // invalidates any fetch/parse still in flight for whatever this was previewing
  if (assetViewerModelPreview) {
    assetViewerModelPreview.dispose();
    assetViewerModelPreview = null;
  }
}

// Lazy, click-triggered only (task #150 point 2 — never automatic): fetches
// the .glb via plain fetch()+arrayBuffer(), same `cache: 'no-store'`
// convention every other binary/JSON fetch in this file already uses (see
// e.g. the manifest/scene fetches above), then hands the raw bytes to
// window.MiniGLTF.previewModel() (gltf-mini.js) to parse and render — NOT
// window.MiniGLTF.init(), which is the full first-person world renderer and
// would drag in camera controls, a floor, a character, and input handling
// this small preview has no use for.
async function showAssetViewerModel(url, areaEl) {
  disposeAssetViewerModelPreview();
  const token = assetViewerModelLoadToken;
  areaEl.innerHTML = '<div class="asset-viewer-model-status">Loading model…</div>';
  let buffer;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('Could not fetch model: ' + url);
    buffer = await res.arrayBuffer();
  } catch (err) {
    if (token !== assetViewerModelLoadToken) return; // the panel moved on (closed/switched asset) while this was in flight — drop it silently
    areaEl.innerHTML = '<div class="asset-viewer-model-status">Could not load this model.</div>';
    return;
  }
  if (token !== assetViewerModelLoadToken) return; // same race, the success path
  const canvas = document.createElement('canvas');
  canvas.className = 'asset-viewer-model-canvas';
  canvas.width = 240;
  canvas.height = 160;
  areaEl.innerHTML = '';
  areaEl.appendChild(canvas);
  try {
    assetViewerModelPreview = window.MiniGLTF.previewModel(canvas, buffer, {});
  } catch (err) {
    areaEl.innerHTML = '<div class="asset-viewer-model-status">Could not render this model.</div>';
  }
}

assetViewerBodyEl && assetViewerBodyEl.addEventListener('click', (e) => {
  const btn = e.target.closest('#assetViewerShowModelBtn');
  if (!btn) return;
  const area = document.getElementById('assetViewerModelArea');
  if (area) showAssetViewerModel(btn.dataset.model, area);
});

function cancelAssetViewerCloseTimer() {
  if (assetViewerCloseTimer) { clearTimeout(assetViewerCloseTimer); assetViewerCloseTimer = null; }
}

function closeAssetViewer() {
  cancelAssetViewerCloseTimer();
  assetViewerCurrentEntry = null;
  disposeAssetViewerModelPreview();
  if (assetViewerBodyEl) assetViewerBodyEl.innerHTML = '';
  if (assetViewerWidgetEl) assetViewerWidgetEl.hidden = true;
  if (assetViewerSettingsPopoverEl) assetViewerSettingsPopoverEl.hidden = true;
}

// Starts (or restarts) the short close-timer the sticky hover bridge relies
// on — called on the card's mouseleave AND the panel's own mouseleave.
// Task #150 point 5's real edge case: while a resize drag is in progress,
// this is suspended ENTIRELY (never started, and any already-pending timer
// stays cancelled) — a drag naturally carries the cursor outside the
// panel's current bounds, and that must never read as "the user is done
// with this panel." See the resize-drag mouseup handler below for how
// normal hover tracking resumes the moment the drag actually ends.
function scheduleAssetViewerClose() {
  if (assetViewerDragActive) return;
  cancelAssetViewerCloseTimer();
  assetViewerCloseTimer = setTimeout(() => {
    assetViewerCloseTimer = null;
    closeAssetViewer();
  }, ASSET_VIEWER_CLOSE_GRACE_MS);
}

// Opens (or, if already open for a different card, switches) the viewer.
// Cancels any pending close first — re-entering a card (or the panel) mid-
// grace-window is exactly what the sticky bridge is for.
function openAssetViewer(entry, cardEl) {
  cancelAssetViewerCloseTimer();
  if (assetViewerCurrentEntry === entry) return; // already showing this exact card — leave its (possibly live) model preview alone
  disposeAssetViewerModelPreview(); // switching assets — never leave the PREVIOUS card's preview context running
  assetViewerCurrentEntry = entry;
  renderAssetViewerContent(entry);
  assetViewerWidgetEl.hidden = false;
  positionAssetViewer(cardEl);
}

// Wired on the WIDGET (the fixed-positioned wrapper), not just the visible
// #assetViewerPanel card — #assetViewerSettingsPopover is a DOM sibling of
// the panel but still a descendant of the widget (see viewer.html's own
// comment on why the popover lives outside the panel's overflow-clipped
// box), so hovering the opacity/text-size sliders would otherwise register
// as having left the panel and start the close timer mid-adjustment.
// mouseenter/mouseleave (unlike mouseover/mouseout) don't fire for moves
// between an element and its descendants, so this one listener correctly
// treats "still somewhere inside the widget" — panel OR popover — as
// "still hovering," with no separate popover-specific listener needed.
assetViewerWidgetEl && assetViewerWidgetEl.addEventListener('mouseenter', cancelAssetViewerCloseTimer);
assetViewerWidgetEl && assetViewerWidgetEl.addEventListener('mouseleave', scheduleAssetViewerClose);

// ---------- Asset Viewer settings popover (opacity / text size) ----------
// Exact same pattern as chatSettingsBtn/chatSettingsPopoverEl above, just
// this panel's own settings storage (AtlasWallet.get/setAssetViewerSettings).
assetViewerSettingsBtn && assetViewerSettingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  assetViewerSettingsPopoverEl.hidden = !assetViewerSettingsPopoverEl.hidden;
});
document.addEventListener('click', (e) => {
  if (assetViewerSettingsPopoverEl && !assetViewerSettingsPopoverEl.hidden && !assetViewerSettingsPopoverEl.contains(e.target) && e.target !== assetViewerSettingsBtn) {
    assetViewerSettingsPopoverEl.hidden = true;
  }
});
assetViewerOpacityInput && assetViewerOpacityInput.addEventListener('input', async () => {
  applyAssetViewerSettings(await AtlasWallet.setAssetViewerSettings({ opacity: parseFloat(assetViewerOpacityInput.value) }));
});
assetViewerTextSizeInput && assetViewerTextSizeInput.addEventListener('input', async () => {
  applyAssetViewerSettings(await AtlasWallet.setAssetViewerSettings({ textSize: parseInt(assetViewerTextSizeInput.value, 10) }));
});

// ---------- Asset Viewer resize handle ----------
// Same document-level mousemove/mouseup drag-tracking as chatResizeHandleEl
// above (see that block's own comment for why document-level, not the
// handle's own element: a fast drag can momentarily carry the cursor
// outside the panel's current bounds mid-resize, and tracking on the
// document rather than the shrinking/growing panel itself is what keeps
// the drag from "losing" the mouse when that happens). Grows from the
// bottom-right corner since this panel is positioned by its top-left (see
// positionAssetViewer), the mirror image of chat's own top-right handle
// growing away from ITS bottom-left anchor.
let assetViewerResizeDrag = null;
assetViewerResizeHandleEl && assetViewerResizeHandleEl.addEventListener('mousedown', (e) => {
  e.preventDefault();
  cancelAssetViewerCloseTimer();
  assetViewerDragActive = true; // suspends the close timer for the whole drag — see scheduleAssetViewerClose()'s own comment
  const rect = assetViewerPanelEl.getBoundingClientRect();
  assetViewerResizeDrag = { startX: e.clientX, startY: e.clientY, startWidth: rect.width, startHeight: rect.height };
});
document.addEventListener('mousemove', (e) => {
  if (!assetViewerResizeDrag) return;
  const width = Math.max(220, Math.min(480, assetViewerResizeDrag.startWidth + (e.clientX - assetViewerResizeDrag.startX)));
  const height = Math.max(180, Math.min(560, assetViewerResizeDrag.startHeight + (e.clientY - assetViewerResizeDrag.startY)));
  assetViewerPanelEl.style.width = width + 'px';
  assetViewerPanelEl.style.height = height + 'px';
});
document.addEventListener('mouseup', async () => {
  if (!assetViewerResizeDrag) return;
  assetViewerResizeDrag = null;
  const rect = assetViewerPanelEl.getBoundingClientRect();
  applyAssetViewerSettings(await AtlasWallet.setAssetViewerSettings({ width: Math.round(rect.width), height: Math.round(rect.height) }));
  assetViewerDragActive = false;
  // Resume normal hover tracking the instant the drag ends (task #150
  // point 5): if the cursor ended up outside the panel (the overwhelmingly
  // common case for a resize-by-dragging-outward), schedule the close
  // timer now rather than leaving the panel open with nothing left to ever
  // trigger its mouseleave again — no further mouse movement is guaranteed
  // once the button is already up.
  if (assetViewerPanelEl && !assetViewerPanelEl.matches(':hover')) scheduleAssetViewerClose();
});

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
// Task #151 — "compatible with this world" needs no new manifest field:
// SPEC.md line 334 already defines policy.acceptedItemClasses as which
// classes a world recognizes, and policy.trustedIssuers (line 172,
// orthogonal to class) as whose issuers it trusts at all ("any" | "self" |
// an explicit domain array). An asset is compatible iff BOTH pass. A world
// that declares an empty/absent acceptedItemClasses recognizes nothing via
// this mechanism — SPEC.md's own "an asset outside that list has no
// defined behavior" wording already implies that default, so this
// deliberately returns false rather than treating "declares nothing" as
// "accepts everything". `manifest` (task #152) is needed only for the
// domain-level acceptedItemClasses default — see effectiveAcceptedItemClasses()
// and classMatchesAny() above, which is also what makes a trailing-".*"
// category entry (e.g. "atlas.element.*") match here.
function isAssetCompatibleWithWorld(entry, world, manifest) {
  if (!world || !world.policy) return false;
  const classes = effectiveAcceptedItemClasses(manifest, world);
  if (!classMatchesAny(entry.credential.asset.class, classes)) return false;
  const trusted = world.policy.trustedIssuers;
  const issuerDomain = entry.credential.issuer && entry.credential.issuer.domain;
  if (trusted === 'any') return true;
  // "self" means self relative to THIS world's own owning manifest — the
  // one passed in, never the module-global currentManifest, even though in
  // every call site today they happen to be the same object (renderAssetCard
  // only ever checks compatibility against the world you're currently in).
  // Caught by test/manual-item-category-defaults.js exercising this against
  // a synthetic manifest/world pair that ISN'T the live currentManifest —
  // using the global here silently passed for the real call sites but was
  // still the wrong thing to read now that manifest is an explicit argument.
  if (trusted === 'self') return issuerDomain === manifestDomainOf(manifest);
  if (Array.isArray(trusted)) return trusted.includes(issuerDomain);
  return false; // no recognized trustedIssuers value declared — safest default is nothing passes
}

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
  // opts.checkCompat is the CURRENT world, passed only for the self
  // ("Yours") lists — see refreshInventoryDisplay() below. Counterparty
  // cards never get a dataset.compatible at all, which is fine since the
  // compatibility checkbox is only ever wired to the self lists.
  // opts.checkCompatManifest (task #152) is that world's owning manifest,
  // needed only for the domain-level acceptedItemClasses default.
  if (opts.checkCompat) el.dataset.compatible = isAssetCompatibleWithWorld(entry, opts.checkCompat, opts.checkCompatManifest) ? '1' : '0';
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

  // Asset Viewer (task #150) — wired once, here, so every place
  // renderAssetCard() is used (both Collectibles and Documents, both the
  // self and counterparty column of each — see refreshInventoryDisplay()
  // above) gets the hover panel generically, with no per-call-site
  // special-casing. See the big comment block above openAssetViewer() for
  // the full hover/sticky-bridge design.
  el.addEventListener('mouseenter', () => openAssetViewer(entry, el));
  el.addEventListener('mouseleave', scheduleAssetViewerClose);
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
    renderAssetList(selfCollectibles, selfCollectiblesListEl, { loadable: risky, loadout, risky, droppable: true, otherLabel: 'counterparty', checkCompat: currentWorld, checkCompatManifest: currentManifest });
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
    renderAssetList(selfDocuments, selfDocumentsListEl, { loadable: risky, loadout, risky, droppable: true, otherLabel: 'counterparty', checkCompat: currentWorld, checkCompatManifest: currentManifest });
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
  applyListFilter(selfCollectiblesListEl, collectiblesSearchInput.value, collectiblesCompatMatch());
  applyListFilter(counterpartyCollectiblesListEl, collectiblesSearchInput.value);
  applyListFilter(selfDocumentsListEl, documentsSearchInput.value, documentsCompatMatch());
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
// extraMatch (task #151) is an optional (card) => boolean predicate ANDed
// in alongside the text search — used to layer the "only show items
// compatible with this world" checkbox on top of whatever's already typed
// into the search box, without the two filters stepping on each other's
// toes (both ultimately just set `card.hidden`, so they have to be combined
// in one pass rather than applied as two independent overwrites).
function applyListFilter(listEl, rawQuery, extraMatch) {
  if (!listEl) return;
  const query = (rawQuery || '').trim().toLowerCase();
  const filtering = !!query || !!extraMatch;
  const cards = listEl.querySelectorAll('.wallet-item, .info-card');
  const groupHasVisible = new Map();
  cards.forEach((card) => {
    const searchMatch = !query || (card.dataset.search || '').includes(query);
    const match = searchMatch && (!extraMatch || extraMatch(card));
    card.hidden = !match;
    if (card.dataset.group) {
      groupHasVisible.set(card.dataset.group, groupHasVisible.get(card.dataset.group) || match);
    }
  });
  listEl.querySelectorAll('.resource-group-header').forEach((header) => {
    header.hidden = filtering && !groupHasVisible.get(header.dataset.group);
  });

  let noMatchEl = listEl.querySelector('.filter-empty-note');
  const anyVisible = Array.from(cards).some((card) => !card.hidden);
  if (filtering && cards.length > 0 && !anyVisible) {
    if (!noMatchEl) {
      noMatchEl = document.createElement('div');
      noMatchEl.className = 'empty-note filter-empty-note';
      listEl.appendChild(noMatchEl);
    }
    noMatchEl.textContent = query ? ('No matches for "' + rawQuery.trim() + '".') : 'No items compatible with this world.';
  } else if (noMatchEl) {
    noMatchEl.remove();
  }
}

// Task #151 — the (card) => boolean predicate for each subtab's "only show
// items compatible with this world" checkbox, or null when it's unchecked
// (meaning applyListFilter falls back to text-search-only). Kept as
// functions rather than inline at every call site since both the search
// input's own 'input' listener and the checkbox's 'change' listener below
// need to re-derive the same predicate.
function collectiblesCompatMatch() {
  return (collectiblesCompatOnlyCheckbox && collectiblesCompatOnlyCheckbox.checked)
    ? (card) => card.dataset.compatible === '1' : null;
}
function documentsCompatMatch() {
  return (documentsCompatOnlyCheckbox && documentsCompatOnlyCheckbox.checked)
    ? (card) => card.dataset.compatible === '1' : null;
}

collectiblesSearchInput && collectiblesSearchInput.addEventListener('input', () => {
  applyListFilter(selfCollectiblesListEl, collectiblesSearchInput.value, collectiblesCompatMatch());
  applyListFilter(counterpartyCollectiblesListEl, collectiblesSearchInput.value);
});
documentsSearchInput && documentsSearchInput.addEventListener('input', () => {
  applyListFilter(selfDocumentsListEl, documentsSearchInput.value, documentsCompatMatch());
  applyListFilter(counterpartyDocumentsListEl, documentsSearchInput.value);
});
// Only the "Yours" list re-filters here — the checkbox never applies to
// Counterparty's, since "compatible with this world" is about what YOU
// could meaningfully load/drop here, not what they're holding.
collectiblesCompatOnlyCheckbox && collectiblesCompatOnlyCheckbox.addEventListener('change', () => {
  applyListFilter(selfCollectiblesListEl, collectiblesSearchInput.value, collectiblesCompatMatch());
});
documentsCompatOnlyCheckbox && documentsCompatOnlyCheckbox.addEventListener('change', () => {
  applyListFilter(selfDocumentsListEl, documentsSearchInput.value, documentsCompatMatch());
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

// ---------- chat admin: muted/blocked chat users (Settings -> "Chat Admin", #116) ----------
// Same "info-card with an undo button" shape as renderHiddenAssetCard above,
// just listing the two local moderation lists AtlasWallet.getMutedChatUsers()/
// getBlockedChatUsers() maintain rather than wallet assets.

function renderChatModerationCard(entry, container, action) {
  const el = document.createElement('div');
  el.className = 'info-card';
  el.innerHTML =
    '<div class="name">' + escapeHtml(entry.name || 'Visitor') + '</div>' +
    '<div class="meta mono">' + escapeHtml(entry.publicKey.slice(0, 24)) + '…</div>' +
    '<div class="item-actions">' +
    '<button type="button" data-action="' + action + '" data-key="' + escapeHtml(entry.publicKey) + '" class="danger-btn">' + (action === 'unmute-chat-user' ? 'Unmute' : 'Unblock') + '</button>' +
    '</div>';
  container.appendChild(el);
}

async function refreshChatAdminDisplay() {
  if (chatMutedUsersListEl) {
    const muted = await AtlasWallet.getMutedChatUsers();
    chatMutedUsersListEl.innerHTML = '';
    if (muted.length === 0) {
      chatMutedUsersListEl.innerHTML = '<div class="empty-note">No muted users.</div>';
    } else {
      muted.forEach((entry) => renderChatModerationCard(entry, chatMutedUsersListEl, 'unmute-chat-user'));
    }
  }
  if (chatBlockedUsersListEl) {
    const blocked = await AtlasWallet.getBlockedChatUsers();
    chatBlockedUsersListEl.innerHTML = '';
    if (blocked.length === 0) {
      chatBlockedUsersListEl.innerHTML = '<div class="empty-note">No blocked users.</div>';
    } else {
      blocked.forEach((entry) => renderChatModerationCard(entry, chatBlockedUsersListEl, 'unblock-chat-user'));
    }
  }
}

async function handleChatAdminListClick(e) {
  const btn = e.target.closest('button[data-action="unmute-chat-user"], button[data-action="unblock-chat-user"]');
  if (!btn) return;
  if (btn.dataset.action === 'unmute-chat-user') {
    await AtlasWallet.unmuteChatUser(btn.dataset.key);
  } else {
    await AtlasWallet.unblockChatUser(btn.dataset.key);
  }
  await refreshChatModerationCache();
  renderChatMessages();
  await refreshChatAdminDisplay();
}
chatMutedUsersListEl && chatMutedUsersListEl.addEventListener('click', handleChatAdminListClick);
chatBlockedUsersListEl && chatBlockedUsersListEl.addEventListener('click', handleChatAdminListClick);

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
  refreshChatIdentity(); // a freshly-created identity is unlocked immediately — chat should recognize it right away, same as the unlock/lock paths
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
    refreshChatIdentity(); // imported identity is unlocked immediately too — same reasoning as seedConfirmBtn above
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
    refreshChatIdentity(); // an in-progress chat session should reflect the newly-unlocked identity immediately, without requiring leaving the world
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
  refreshChatIdentity(); // same immediate reflection as the unlock path above — locking should drop back to anonymous chat right away
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
  refreshChatIdentity(); // same immediate reflection the other two lock/unlock paths get
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
  await refreshChatAdminDisplay();
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

// friendNameByKey: publicKey -> saved friend name (see refreshMailDisplay),
// used below so a message from someone already saved as a friend reads as
// their name instead of a bare key fragment.
function renderMailCard(entry, container, friendNameByKey) {
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
  //
  // A registered handle still wins over a saved friend name when both are
  // available — the handle came from the domain itself at send time, a
  // friend name is just a local label this wallet chose, so the more
  // authoritative one takes the front line. Friend name is the fallback
  // for the raw-key case specifically, not a replacement for handles.
  const friendName = entry.message.from && friendNameByKey && friendNameByKey.get(entry.message.from.publicKey);
  const fromLine = entry.message.from
    ? 'From ' + (entry.message.from.handle
        ? escapeHtml(entry.message.from.handle) + '#' + escapeHtml(entry.message.domain)
        : friendName
          ? escapeHtml(friendName) + ' (friend) via ' + escapeHtml(entry.message.domain)
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
  // Quick reply: only relayed mail (has `from`) has an addressable sender
  // to reply to — ordinary domain-to-subscriber mail's "sender" IS the
  // domain, and there's no user-to-user Compose path back to a domain.
  // Carries everything openComposeReply() needs in data-* rather than
  // looking entry back up from a click handler — same "the button already
  // has what it needs" approach block-sender below already used.
  const replyHtml = !entry.message.from ? '' :
    '<button type="button" data-action="reply" data-domain="' + escapeHtml(entry.message.domain) + '" data-key="' + escapeHtml(entry.message.from.publicKey) + '" data-handle="' + escapeHtml(entry.message.from.handle || '') + '" data-subject="' + escapeHtml(entry.message.subject) + '">Reply</button>';
  // Task #94 (consent/block model): only relayed mail (has `from`) has a
  // sender worth blocking — ordinary domain-to-subscriber mail's "sender"
  // IS the domain, and blocking that would just be a confusing way to spell
  // deleting/unsubscribing, so this button only ever shows up on the same
  // kind of card fromLine above already treats specially.
  //
  // Tucked behind a small "⋯" menu (mail-card-menu) rather than sitting
  // directly in the action row — it used to (for Block sender), but sitting
  // right next to Delete/Reply made it too easy to hit by accident on a
  // click meant for one of those. "Add to calendar" (a bridge to the
  // Calendar sub-tab, see prefillCalendarEventFromMail) joined it here for
  // the same reason: a per-message action that isn't the everyday
  // Delete/Reply pair. See the delegated toggle-mail-menu handler below for
  // how it opens/closes, and the outside-click listener that closes it
  // again. Always has at least "Add to calendar" — Block sender only joins
  // it on relayed mail (has `from`), same condition as replyHtml above.
  const addToCalendarHtml =
    '<button type="button" data-action="add-mail-to-calendar" data-subject="' + escapeHtml(entry.message.subject) + '" data-body="' + escapeHtml(entry.message.body) + '">Add to calendar</button>';
  // Task #154: turn a message's sender into a saved Contact without
  // retyping their key into the Contacts tab's manual-add form. Same
  // condition as Reply/Block above (only relayed mail has an addressable
  // sender), PLUS gated on the sender not ALREADY being a saved friend —
  // friendName is computed above from the same friendNameByKey lookup the
  // From line already uses, so this reuses that instead of re-deriving it.
  // addFriend() is purely local (see wallet.js's own header comment on
  // it — no signal ever reaches the other person), same reasoning already
  // vetted for the analogous chat-menu version in task #148, so there's no
  // "unsolicited request" concern here to design around.
  const addContactHtml = (!entry.message.from || friendName) ? '' :
    '<button type="button" data-action="add-contact-from-mail" data-key="' + escapeHtml(entry.message.from.publicKey) + '" data-handle="' + escapeHtml(entry.message.from.handle || '') + '">Add Contact</button>';
  const blockSenderHtml = !entry.message.from ? '' :
    '<button type="button" data-action="block-sender" data-domain="' + escapeHtml(entry.message.domain) + '" data-key="' + escapeHtml(entry.message.from.publicKey) + '" class="danger-btn">Block sender</button>';
  // An unclaimed gift is the only copy of that credential anywhere —
  // claimMailGift() is the sole path it ever enters the wallet (see its
  // own comment in wallet.js) — so deleting the message before claiming
  // would destroy it with no way to get it back. Disabling the button
  // (rather than a confirm()-time check) keeps this consistent with how
  // disabled controls read elsewhere in this file, e.g. requestItemBtn.
  const deleteBlockedByGift = gift && !entry.claimed;
  const menuHtml =
    '<div class="mail-card-menu">' +
    '<button type="button" class="link-btn mail-card-menu-toggle" data-action="toggle-mail-menu" title="More actions">⋯</button>' +
    '<div class="mail-card-menu-items">' +
    addToCalendarHtml +
    addContactHtml +
    blockSenderHtml +
    '</div>' +
    '</div>';
  el.innerHTML =
    '<div class="mail-domain">' + fromLine + '</div>' +
    '<div class="mail-subject">' + escapeHtml(entry.message.subject) + '</div>' +
    '<div class="mail-meta">' + sentAt + (entry.read ? '' : ' · unread') + '</div>' +
    '<div class="mail-body">' + escapeHtml(entry.message.body) + '</div>' +
    giftHtml +
    '<div class="item-actions">' +
    '<button type="button" data-action="delete" class="danger-btn"' +
      (deleteBlockedByGift ? ' disabled title="Claim the attached gift before deleting this message"' : '') +
      '>Delete</button>' +
    replyHtml +
    menuHtml +
    '</div>';
  container.appendChild(el);
}

// Inbox sender filter: one synthetic key per distinct sender, so ordinary
// domain-to-subscriber mail (no `from`) can still be filtered on even
// though it has no public key of its own — grouped by relaying domain
// instead, prefixed so it can never collide with an actual public key.
function mailFilterKeyFor(entry) {
  return entry.message.from ? entry.message.from.publicKey : 'domain:' + entry.message.domain;
}

function mailFilterLabelFor(entry, friendNameByKey) {
  if (!entry.message.from) return entry.message.domain;
  if (entry.message.from.handle) return entry.message.from.handle + '#' + entry.message.domain;
  const friendName = friendNameByKey && friendNameByKey.get(entry.message.from.publicKey);
  return friendName || (entry.message.from.publicKey.slice(0, 16) + '…');
}

// Rebuilt from the current mail list every refreshMailDisplay() call —
// cheap (a handful of entries at most in this demo), and keeps it in sync
// with mail arriving/leaving without a separate change-tracking path.
// Preserves the current selection across a refresh the same way Compose's
// dropdowns already do, in case a sender's handle/friend name changed
// underneath an already-open Inbox.
function refreshMailSenderFilterOptions(entries, friendNameByKey) {
  if (!mailSenderFilterInput) return;
  const previousValue = mailSenderFilterInput.value;
  const seen = new Map();
  entries.forEach((entry) => {
    const key = mailFilterKeyFor(entry);
    if (!seen.has(key)) seen.set(key, mailFilterLabelFor(entry, friendNameByKey));
  });

  mailSenderFilterInput.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = seen.size ? 'All senders' : 'No mail yet';
  mailSenderFilterInput.appendChild(placeholder);
  seen.forEach((label, key) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = label;
    mailSenderFilterInput.appendChild(opt);
  });
  mailSenderFilterInput.disabled = seen.size === 0;
  if (seen.has(previousValue)) mailSenderFilterInput.value = previousValue;
}

async function refreshMailDisplay() {
  const identity = await AtlasWallet.getIdentity();
  const entries = identity ? await AtlasWallet.getMail(identity.publicKey) : [];
  const unreadCount = entries.filter((e) => !e.read).length;
  // Friend quick-pick's own map (see refreshComposeFriendPicker) reused
  // here for display, not addressing — a saved friend's name standing in
  // for their raw key on a card, same underlying AtlasWallet.getFriends().
  const friendNameByKey = new Map((await AtlasWallet.getFriends()).map((f) => [f.publicKey, f.name]));

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

  refreshMailSenderFilterOptions(entries, friendNameByKey);
  // Filtering only changes what's RENDERED — unread counts/badges above
  // stay based on the full inbox, so switching the filter never makes
  // "something needs attention" quietly disappear just because that
  // message happens to be from someone else right now.
  const activeFilter = mailSenderFilterInput ? mailSenderFilterInput.value : '';
  const visibleEntries = activeFilter ? entries.filter((e) => mailFilterKeyFor(e) === activeFilter) : entries;

  if (mailListEl) {
    mailListEl.innerHTML = '';
    if (entries.length === 0) {
      mailListEl.innerHTML = '<div class="empty-note">No mail yet.</div>';
    } else if (visibleEntries.length === 0) {
      mailListEl.innerHTML = '<div class="empty-note">No mail from this sender.</div>';
    } else {
      visibleEntries.forEach((entry) => renderMailCard(entry, mailListEl, friendNameByKey));
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

mailSenderFilterInput && mailSenderFilterInput.addEventListener('change', async () => {
  await refreshMailDisplay();
});

// Sent tab: a purely local record (AtlasWallet.getSentMail — see its own
// comment on why this exists at all, and sendUserMail's on how entries get
// added) of what this wallet has sent through a Post Office. Same card
// shape/styling as renderMailCard above (.mail-card), just a "To" line
// instead of "From" and no unread/gift/block affordances — none of those
// concepts apply to a message you sent yourself.
function renderSentMailCard(entry, container, friendNameByKey) {
  const el = document.createElement('div');
  el.className = 'wallet-item mail-card';
  el.dataset.id = entry.id;
  const sentAt = new Date(entry.sentAt).toLocaleString();
  const friendName = friendNameByKey && friendNameByKey.get(entry.to.publicKey);
  const toLine = entry.to.handle
    ? 'To ' + escapeHtml(entry.to.handle) + '#' + escapeHtml(entry.domain)
    : friendName
      ? 'To ' + escapeHtml(friendName) + ' (friend) via ' + escapeHtml(entry.domain)
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
  const friendNameByKey = new Map((await AtlasWallet.getFriends()).map((f) => [f.publicKey, f.name]));
  sentMailListEl.innerHTML = '';
  if (entries.length === 0) {
    sentMailListEl.innerHTML = '<div class="empty-note">No sent mail yet.</div>';
  } else {
    entries.forEach((entry) => renderSentMailCard(entry, sentMailListEl, friendNameByKey));
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

// "Due soon" window for the Calendar badge below: an event counts as
// needing attention once it's within this many milliseconds of now (or
// already past). 24 hours is a reasonable "don't let me forget about
// tomorrow" default for a demo with no background alerts — see
// calendarSubscreen's own comment in viewer.html for why there's nothing
// stronger than this badge in this pass.
const CALENDAR_DUE_SOON_MS = 24 * 60 * 60 * 1000;

// The single moment an event's urgency (overdue-ness, and "due soon"
// below) is judged against: its END time when it has one, its start time
// otherwise. An event with a set duration isn't "overdue" the instant it
// BEGINS — a 2pm-3:30pm meeting is still current at 2:15, not overdue —
// so once endDateTime exists, everything that used to read dateTime alone
// for urgency reads this instead. Shared by the event-list card, the
// day-viewer's event chips, and the due-soon count right below.
function calendarEventUrgencyMs(entry) {
  return new Date(entry.endDateTime || entry.dateTime).getTime();
}

// Shared by the Calendar sub-tab's badge and updateSocialBadge()'s combined
// total below — counts events that are overdue OR due within
// CALENDAR_DUE_SOON_MS (per calendarEventUrgencyMs above — an event's END
// time once it has one), from an already-fetched events array so callers
// that already have the list (refreshCalendarDisplay) don't re-fetch it.
function countCalendarEventsDueSoon(events) {
  const cutoff = Date.now() + CALENDAR_DUE_SOON_MS;
  return (events || []).filter((e) => calendarEventUrgencyMs(e) <= cutoff).length;
}

// Combined badge on the top-level Social tab (#61/#67) — unread mail, plus
// pending incoming friend requests, plus calendar events overdue/due soon,
// so there's a single "something needs your attention in here" signal even
// while the panel's closed and nobody can see which sub-tab would show it.
// Each sub-tab ALSO carries its own count (mailBadge, calendarBadge) for
// once you're actually looking. Friend requests now live under Contacts ->
// Add Contact specifically (the Contacts restructuring, #67 follow-up) —
// friendRequestsBadge (the outer Contacts sub-tab button) and
// addContactBadge (the Add Contact inner sub-tab button, where the
// requests themselves actually render) both show the SAME count, same
// two-levels-deep aggregation Mail already does with mailBadge/
// mailBoxInboxBadge above.
async function updateSocialBadge() {
  const identity = await AtlasWallet.getIdentity();
  const entries = identity ? await AtlasWallet.getMail(identity.publicKey) : [];
  const unreadMail = entries.filter((e) => !e.read).length;
  const calendarEvents = await AtlasWallet.getCalendarEvents();
  const calendarDueSoon = countCalendarEventsDueSoon(calendarEvents);
  if (friendRequestsBadge) {
    friendRequestsBadge.textContent = String(presencePendingIncoming.length);
    friendRequestsBadge.classList.toggle('show', presencePendingIncoming.length > 0);
  }
  if (addContactBadge) {
    addContactBadge.textContent = String(presencePendingIncoming.length);
    addContactBadge.classList.toggle('show', presencePendingIncoming.length > 0);
  }
  if (calendarBadge) {
    calendarBadge.textContent = String(calendarDueSoon);
    calendarBadge.classList.toggle('show', calendarDueSoon > 0);
  }
  if (socialBadge) {
    const total = unreadMail + presencePendingIncoming.length + calendarDueSoon;
    socialBadge.textContent = String(total);
    socialBadge.classList.toggle('show', total > 0);
  }
}

// Closes every open block-sender menu (there's realistically at most one
// at a time, but this is cheap either way) — used both when opening a
// different card's menu (so two never sit open together) and on any click
// outside a menu entirely, below.
function closeAllMailCardMenus() {
  mailListEl && mailListEl.querySelectorAll('.mail-card-menu-items.show').forEach((el) => el.classList.remove('show'));
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.mail-card-menu')) return;
  closeAllMailCardMenus();
});

mailListEl && mailListEl.addEventListener('click', async (e) => {
  const card = e.target.closest('.mail-card');
  if (!card) return;
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;

  // The block-sender menu's own "⋯" toggle — opens/closes the popover
  // beside it without touching anything else on the card (in particular,
  // returns before the unread/markMailRead fallthrough at the bottom would
  // otherwise fire, so opening the menu on an unread card doesn't ALSO
  // require a second click to actually read it). See the document-level
  // listener below for closing it again on an outside click.
  const menuToggleBtn = e.target.closest('button[data-action="toggle-mail-menu"]');
  if (menuToggleBtn) {
    const menu = menuToggleBtn.parentElement.querySelector('.mail-card-menu-items');
    const opening = menu && !menu.classList.contains('show');
    closeAllMailCardMenus();
    if (opening && menu) menu.classList.add('show');
    return;
  }

  // "Add to calendar" bridge (see prefillCalendarEventFromMail's own
  // comment on why this only pre-fills a form rather than creating an
  // event outright): jumps straight to Social's Calendar sub-tab with the
  // add-event form pre-filled from this message.
  const addToCalendarBtn = e.target.closest('button[data-action="add-mail-to-calendar"]');
  if (addToCalendarBtn) {
    closeAllMailCardMenus();
    showSocialSubtab('calendarSubscreen');
    resetCalendarGridToToday();
    await refreshCalendarDisplay();
    prefillCalendarEventFromMail(addToCalendarBtn.dataset.subject, addToCalendarBtn.dataset.body);
    return;
  }

  // Task #154: the mail-menu counterpart to the Contacts tab's manual
  // "add by public key" form, pre-filled from this message instead of
  // retyped by hand. addContactHtml above already keeps this hidden once
  // the sender is a saved contact, so no re-check is needed here — just
  // save and refresh. Re-rendering the mail list afterward (not just
  // Friends) matters: it's this same card's own friendName lookup that
  // makes the button disappear and, for a from without a handle, flips
  // the From line to "(friend)" — waiting for some other, unrelated
  // refresh to catch up would leave stale state on screen.
  const addContactBtn = e.target.closest('button[data-action="add-contact-from-mail"]');
  if (addContactBtn) {
    closeAllMailCardMenus();
    const key = addContactBtn.dataset.key;
    const handle = addContactBtn.dataset.handle;
    const name = handle || 'Friend';
    try {
      await AtlasWallet.addFriend(key, name);
      if (socialFriendsTabActive()) await refreshFriendsDisplay();
      await refreshMailDisplay();
      statusEl.textContent = 'Added ' + name + ' to Contacts.';
    } catch (err) {
      statusEl.textContent = 'Add contact failed: ' + err.message;
    }
    return;
  }

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

  // Quick reply: jumps straight to Compose, pre-addressed back to whoever
  // this message is from — see openComposeReply() below for what it fills
  // in and why.
  const replyBtn = e.target.closest('button[data-action="reply"]');
  if (replyBtn) {
    await openComposeReply({
      domain: replyBtn.dataset.domain,
      key: replyBtn.dataset.key,
      handle: replyBtn.dataset.handle,
      subject: replyBtn.dataset.subject
    });
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

// #128: the very first time Mail is reached via a plain click on Social or
// Mail (as opposed to a deliberate deep-link like openComposeReply's quick
// reply/private-message bridge, which already sets this itself — see
// there), land on Inbox specifically rather than whatever inner sub-tab
// happened to be the DOM's default. checkMailOnTabOpen() already fires here
// either way (it doesn't care which inner sub-tab is showing), so this is
// purely about where you visually land on that first visit. Every visit
// after the first respects wherever the user last was (Sent/Compose/Mail
// Settings), exactly like today — this flag is a one-shot, not a reset.
let mailEverOpened = false;

socialTabBtn && socialTabBtn.addEventListener('click', async () => {
  showWalletScreen('socialScreen');
  showSocialSubtab('mailSubscreen');
  if (!mailEverOpened) showMailBoxSubtab('mailBoxInboxSubscreen');
  mailEverOpened = true;
  await checkMailOnTabOpen();
  await refreshMailDisplay();
  await refreshSubscribeButton();
  await refreshPostOfficeJoinButton();
  await refreshMyPublicKeyDisplay();
  await refreshInventoryDisplay();
});

mailSubtabBtn && mailSubtabBtn.addEventListener('click', async () => {
  showSocialSubtab('mailSubscreen');
  if (!mailEverOpened) showMailBoxSubtab('mailBoxInboxSubscreen');
  mailEverOpened = true;
  await checkMailOnTabOpen();
  await refreshMailDisplay();
  await refreshSubscribeButton();
  await refreshPostOfficeJoinButton();
  await refreshMyPublicKeyDisplay();
  await refreshInventoryDisplay();
});

// Trade tab (promoted from Wallet's own "Trading station" category once
// #144 Phase 1 grew it into a real two-part screen) — refreshes every
// sub-tab's state unconditionally on open, same "cheap enough to just do
// all of them, don't bother tracking which one's currently showing"
// approach refreshPostOfficeJoinButton already takes in several places.
tradeTabBtn && tradeTabBtn.addEventListener('click', async () => {
  showWalletScreen('tradeScreen');
  refreshWorldGates();
  await refreshTradingStationJoinButton();
  await refreshRemoteTradeStationOptions();
  if (tradingBuyStatusEl) tradingBuyStatusEl.textContent = '';
  await refreshTradingBuyList();
  await refreshTradingSellOfferOptions();
  await refreshTradingListingsList();
});

contactsSubtabBtn && contactsSubtabBtn.addEventListener('click', async () => {
  showSocialSubtab('contactsSubscreen');
  await refreshFriendsDisplay();
});

// Contacts' own inner sub-tab bar (Contacts / Add Contact / Groups) — same
// idea as Mail's Mail/Mail Settings split right below: the data underneath
// all three is already kept current by refreshFriendsDisplay() (called
// whenever the outer Contacts sub-tab opens or a live signal arrives, see
// socialFriendsTabActive() above), so switching between these three is
// just a visibility toggle, EXCEPT Groups, which is populated lazily on
// its own tab-open since nothing else keeps it current (same lazy-refresh
// convention as Inventory's Collectibles/Documents and Mail's own Sent).
contactsListSubtabBtn && contactsListSubtabBtn.addEventListener('click', () => showContactsSubtab('contactsListSubscreen'));
addContactSubtabBtn && addContactSubtabBtn.addEventListener('click', () => showContactsSubtab('addContactSubscreen'));
contactGroupsSubtabBtn && contactGroupsSubtabBtn.addEventListener('click', async () => {
  showContactsSubtab('contactGroupsSubscreen');
  await refreshContactGroupsDisplay();
});

favoritesSubtabBtn && favoritesSubtabBtn.addEventListener('click', async () => {
  showSocialSubtab('favoritesSubscreen');
  await refreshFavoritesDisplay();
});

calendarSubtabBtn && calendarSubtabBtn.addEventListener('click', async () => {
  showSocialSubtab('calendarSubscreen');
  resetCalendarGridToToday();
  await refreshCalendarDisplay();
});

// Mail's own inner sub-tab bar (Mail / Mail Settings) — data underneath is
// already current from whatever last refreshed it (checkMailOnTabOpen +
// refreshMailDisplay/refreshMyPublicKeyDisplay above, both of which run
// regardless of which inner sub-tab happens to be showing), so switching
// is just a visibility toggle, same as Inventory's Collectibles/Documents.
mailInboxSubtabBtn && mailInboxSubtabBtn.addEventListener('click', () => showMailInnerSubtab('mailInboxSubscreen'));
mailSettingsSubtabBtn && mailSettingsSubtabBtn.addEventListener('click', () => showMailInnerSubtab('mailSettingsSubscreen'));

// The "Mail" heading's own Inbox/Sent/Compose tabs. Compose needs no
// refresh on click — kept current by whatever last called
// refreshMyPublicKeyDisplay() (any send action, or opening Social>Mail).
// Sent is the one sub-tab nothing else keeps current, so it refreshes
// itself on the way in.
//
// Inbox ALSO triggers its own check-now, same as the outer Social/Mail
// tab-open handlers above (socialTabBtn/mailSubtabBtn) already do — added
// here specifically because those only fire once, on the way INTO Social>
// Mail; clicking away to Sent/Compose/Mail Settings and back to Inbox
// without ever leaving Social>Mail entirely used to leave Inbox showing
// whatever it last had, with no way to refresh it short of the manual
// Check now button. This makes returning to Inbox itself a check, too.
mailBoxInboxSubtabBtn && mailBoxInboxSubtabBtn.addEventListener('click', async () => {
  showMailBoxSubtab('mailBoxInboxSubscreen');
  await checkMailOnTabOpen();
  await refreshMailDisplay();
});
mailBoxSentSubtabBtn && mailBoxSentSubtabBtn.addEventListener('click', async () => {
  showMailBoxSubtab('mailBoxSentSubscreen');
  await refreshSentMailDisplay();
});
mailBoxComposeSubtabBtn && mailBoxComposeSubtabBtn.addEventListener('click', async () => {
  showMailBoxSubtab('mailBoxComposeSubscreen');
  await refreshComposeFriendPicker();
});

// Inventory's own sub-tab bar (task #44) — Collectibles/Documents, same
// click-to-switch idea as Social's sub-tabs right above. Data is already
// current from whatever last called refreshInventoryDisplay() (opening
// the Wallet tab, or any asset action), so switching sub-tabs is just a
// visibility toggle — no extra fetch needed.
collectiblesSubtabBtn && collectiblesSubtabBtn.addEventListener('click', () => showInventorySubtab('collectiblesSubscreen'));
documentsSubtabBtn && documentsSubtabBtn.addEventListener('click', () => showInventorySubtab('documentsSubscreen'));
tradingBuySubtabBtn && tradingBuySubtabBtn.addEventListener('click', () => showTradingSubtab('tradingBuySubscreen'));
tradingSellSubtabBtn && tradingSellSubtabBtn.addEventListener('click', () => showTradingSubtab('tradingSellSubscreen'));
tradingListingsSubtabBtn && tradingListingsSubtabBtn.addEventListener('click', () => showTradingSubtab('tradingListingsSubscreen'));

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

// Friend quick-pick: lets Compose fill the recipient's public key from a
// saved friend instead of typing/pasting it by hand. Rebuilt from
// AtlasWallet.getFriends() every time Compose is opened (mailBoxComposeSubtabBtn
// below) — cheap, and keeps it current with anything added/removed over on
// the Friends sub-tab without needing a shared refresh path between the two.
// Preserves the current selection across a refresh the same way
// refreshPostOfficeSendOptions() does above, in case a friend's display name
// changed underneath an already-open Compose tab.
async function refreshComposeFriendPicker() {
  if (!composeFriendPickerInput) return;
  const previousValue = composeFriendPickerInput.value;
  const friends = await AtlasWallet.getFriends();

  composeFriendPickerInput.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = friends.length ? 'Quick-pick a friend as recipient…' : 'No saved friends yet';
  composeFriendPickerInput.appendChild(placeholder);
  composeFriendPickerInput.disabled = friends.length === 0;

  const seen = new Set();
  for (const f of friends) {
    if (seen.has(f.publicKey)) continue;
    seen.add(f.publicKey);
    const opt = document.createElement('option');
    opt.value = f.publicKey;
    opt.textContent = f.name;
    composeFriendPickerInput.appendChild(opt);
  }
  if (seen.has(previousValue)) composeFriendPickerInput.value = previousValue;
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
  // A friend pick only ever means anything on the raw-key side (see
  // refreshComposeFriendPicker's own comment) — clear it either way so it
  // doesn't look selected against a field it no longer filled.
  if (composeFriendPickerInput) composeFriendPickerInput.value = '';
});

// Friend quick-pick (see refreshComposeFriendPicker above): a friend is only
// ever addressed by public key, never a handle, so picking one always drops
// Compose into the raw-key path (switching directly rather than going
// through postOfficeToggleRawKeyBtn's own click handler, which would just
// clear the selection this handler is reacting to) and fills the key in.
composeFriendPickerInput && composeFriendPickerInput.addEventListener('change', () => {
  const publicKey = composeFriendPickerInput.value;
  if (!publicKey) return;
  if (postOfficeToPublicKeyInput.hidden) {
    postOfficeToPublicKeyInput.hidden = false;
    postOfficeToHandleInput.hidden = true;
    postOfficeToHandleInput.value = '';
    postOfficeToggleRawKeyBtn.textContent = 'Use a handle instead';
  }
  postOfficeToPublicKeyInput.value = publicKey;
});

// Quick reply: jumps straight from an Inbox card to Compose, pre-addressed
// back to whoever it's from (see renderMailCard's replyHtml for what's
// carried over). Drives through the exact same show*Subtab() functions a
// person clicking through by hand would trigger, so it lands in a fully
// consistent state — active classes, badge refreshes, everything — rather
// than just flipping .active directly here and risking the two ever
// drifting apart.
//
// A handle survives a reply as-is (handle-first is Compose's own default,
// nothing to switch). A raw key always needs the raw-key mode switch,
// mirroring composeFriendPickerInput's own change handler right above —
// and if that key also happens to belong to a saved friend, the friend
// picker is set to match too, purely so the picker doesn't look wrong
// sitting there blank; sending doesn't depend on it either way.
async function openComposeReply({ domain, key, handle, subject }) {
  mailEverOpened = true; // #128 — a deliberate deep-link to Compose counts as Mail having been "opened"; a later plain Mail-tab click should respect this, not force back to Inbox
  showWalletScreen('socialScreen');
  showSocialSubtab('mailSubscreen');
  showMailInnerSubtab('mailInboxSubscreen');
  showMailBoxSubtab('mailBoxComposeSubscreen');
  await refreshComposeFriendPicker();

  if (postOfficeToDomainInput) postOfficeToDomainInput.value = domain;

  if (handle) {
    postOfficeToHandleInput.hidden = false;
    postOfficeToPublicKeyInput.hidden = true;
    postOfficeToggleRawKeyBtn.textContent = 'Paste a raw public key instead';
    postOfficeToHandleInput.value = handle;
    if (composeFriendPickerInput) composeFriendPickerInput.value = '';
  } else {
    postOfficeToPublicKeyInput.hidden = false;
    postOfficeToHandleInput.hidden = true;
    postOfficeToggleRawKeyBtn.textContent = 'Use a handle instead';
    postOfficeToPublicKeyInput.value = key;
    if (composeFriendPickerInput) {
      const isSavedFriend = [...composeFriendPickerInput.options].some((o) => o.value === key);
      composeFriendPickerInput.value = isSavedFriend ? key : '';
    }
  }

  if (postOfficeSubjectInput) postOfficeSubjectInput.value = subject ? 'Re: ' + subject : '';
  if (postOfficeBodyInput) postOfficeBodyInput.value = '';
  if (postOfficeSendStatusEl) postOfficeSendStatusEl.textContent = '';
}

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
    if (composeFriendPickerInput) composeFriendPickerInput.value = '';
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

// ---------- Trading Station, remote (task #144 Phase 1) ----------
//
// Always this browser's own "self" identity — trading settles between two
// genuinely separate wallets/installs (see the claimant intent's plain
// counterparty public-key string), so there's no in-profile role to pick
// here the way the removed in-person mechanism once had (that flow's
// self/counterparty toggle was a same-room stand-in, gone since v1.15).

// Mirrors alreadyHasPostOfficeMembership exactly.
async function alreadyHasTradingStationMembership(domain) {
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return false;
  const wallet = await AtlasWallet.getWallet(identity.publicKey);
  return wallet.some((e) => e.credential.asset.class === 'atlas.tradingstation.membership' && e.credential.issuer.domain === domain);
}

// Mirrors refreshPostOfficeJoinButton exactly — same "gated on the
// manifest's own opt-in field, hidden entirely once already a member"
// shape.
async function refreshTradingStationJoinButton() {
  if (!tradingStationJoinSectionEl) return;
  if (tradingStationJoinStatusEl) tradingStationJoinStatusEl.textContent = '';
  if (!currentManifest || !currentManifest.tradingStation) {
    tradingStationJoinSectionEl.hidden = true;
    return;
  }
  const domain = manifestDomainOf(currentManifest);
  if (await alreadyHasTradingStationMembership(domain)) {
    tradingStationJoinSectionEl.hidden = true;
    return;
  }
  tradingStationJoinSectionEl.hidden = false;
  tradingStationJoinBtn.disabled = false;
  tradingStationJoinBtn.textContent = 'Join ' + domain + '\'s Trading Station';
}

// Rebuilds the Trading Station select. Mostly this wallet's own
// AtlasWallet.getTradingStationMemberships() — same "only ever offer
// stations this wallet has actually joined" reasoning as Post Office's
// "send via" dropdown (refreshPostOfficeSendOptions) — but v1.14 also adds
// the CURRENT world's own station domain even without a membership yet,
// since browsing Buy is deliberately ungated (SPEC.md §7.1): a visitor
// standing at a Trading Station should be able to window-shop before
// deciding to join. Preserves the current selection across refreshes
// where it's still valid.
async function refreshRemoteTradeStationOptions() {
  if (!remoteTradeStationDomainSelect) return;
  const identity = await AtlasWallet.getIdentity();
  const previous = remoteTradeStationDomainSelect.value;
  const domains = new Set();
  if (identity) {
    const memberships = await AtlasWallet.getTradingStationMemberships(identity.publicKey);
    memberships.forEach((m) => domains.add(m.domain));
  }
  if (currentManifest && currentManifest.tradingStation) domains.add(manifestDomainOf(currentManifest));

  remoteTradeStationDomainSelect.innerHTML = '';
  if (domains.size === 0) {
    remoteTradeStationDomainSelect.appendChild(new Option('No Trading Station available', ''));
    return;
  }
  domains.forEach((d) => remoteTradeStationDomainSelect.appendChild(new Option(d, d)));
  if (domains.has(previous)) remoteTradeStationDomainSelect.value = previous;
}

// Sell tab's "You offer" dropdown — this wallet's own held fungible asset
// classes, grouped and summed across every credential of that class (a
// wallet can hold several separate balances of the same class, same
// "totals, not individual credentials" idea autoConsolidateAssetWallet
// already works toward). Free text here just invited typos ("atlas.elment.
// iron") that would silently fail the submit-time balance lookup with a
// confusing "not enough" error — a dropdown can only ever name something
// actually held. Preserves the current selection across refreshes where
// it's still valid, same convention as refreshRemoteTradeStationOptions.
//
// There's no equivalent dynamic list for "You want" (see the static
// <option>s in viewer.html) — unlike what you already hold, what you
// might WANT has nothing to enumerate from client state, and this demo's
// entire protocol only defines three fungible classes to begin with
// (atlas.element.iron/gold/silver, see issuer-server/server.js's
// ASSET_CATALOG). A real deployment with more fungible classes would need
// the issuer to expose a catalog-listing endpoint for this to grow beyond a
// hardcoded list; nothing like that exists yet.
async function refreshTradingSellOfferOptions() {
  if (!tradingSellOfferClassSelect) return;
  const identity = await AtlasWallet.getIdentity();
  const previous = tradingSellOfferClassSelect.value;
  const totals = new Map(); // class -> { quantity, name }
  if (identity) {
    const wallet = await AtlasWallet.getWallet(identity.publicKey);
    wallet.forEach((e) => {
      const c = e.credential;
      if (!c.asset.fungible) return;
      const existing = totals.get(c.asset.class);
      if (existing) existing.quantity += c.quantity;
      else totals.set(c.asset.class, { quantity: c.quantity, name: c.asset.name });
    });
  }

  tradingSellOfferClassSelect.innerHTML = '';
  if (totals.size === 0) {
    tradingSellOfferClassSelect.appendChild(new Option('No fungible assets to offer', ''));
    tradingSellOfferClassSelect.disabled = true;
    return;
  }
  tradingSellOfferClassSelect.disabled = false;
  Array.from(totals.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([cls, info]) => {
      tradingSellOfferClassSelect.appendChild(new Option(info.name + ' ×' + info.quantity + ' (' + cls + ')', cls));
    });
  if (totals.has(previous)) tradingSellOfferClassSelect.value = previous;
}

// Browse (Buy tab, v1.14) — the selected station's own open, unexpired
// listings (AtlasWallet.fetchTradeListings, ungated GET). Filters out this
// wallet's own posted listings (nothing stops self-claim server-side, but
// it can never actually settle — the poster's own balance was already
// staked into the listing, so there's nothing left to mirror-claim with —
// and surfacing it as claimable would just be confusing). Each remaining
// row gets its own Trade button (labeled "Trade" rather than "Claim" —
// this is a barter, nothing is bought with currency) carrying the
// listing's pendingId in a data attribute for the delegated click handler
// below.
// Deliberately does NOT clear tradingBuyStatusEl itself — the claim
// handler below calls this from its own `finally` block AFTER already
// setting a "✓ Traded"/"Trade failed" message, and clearing it here would
// wipe that message out from under the user the instant the list
// refreshes. Callers that want a clean status area (the Refresh button,
// the claim handler's own start) clear it themselves.
// Renders a listing's expiresAt as a short human countdown ("expires in
// 3h 20m") for the Buy/Listings cards below. Purely a display helper —
// the authoritative expired/not-expired call is still made by comparing
// expiresAt to Date.now() wherever that already happens (readPendingTrades
// server-side, and the `status` computation in refreshTradingListingsList
// below); this only formats time that's already known to still be left.
// Now that Sell's own expiry input (v1.15) can run into days, this shows
// a day component too, not just hours/minutes.
function formatExpiryCountdown(expiresAtIso) {
  const msLeft = new Date(expiresAtIso).getTime() - Date.now();
  if (msLeft <= 0) return 'expires any moment';
  const totalMinutes = Math.floor(msLeft / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `expires in ${days}d ${hours}h`;
  if (hours > 0) return `expires in ${hours}h ${minutes}m`;
  return `expires in ${minutes}m`;
}

async function refreshTradingBuyList() {
  if (!tradingBuyListEl) return;
  const domain = remoteTradeStationDomainSelect && remoteTradeStationDomainSelect.value;
  if (!domain) {
    tradingBuyListEl.innerHTML = '<div class="empty-note">No Trading Station selected.</div>';
    return;
  }
  const identity = await AtlasWallet.getIdentity();
  let listings;
  try {
    listings = await AtlasWallet.fetchTradeListings(domain);
  } catch (err) {
    tradingBuyListEl.innerHTML = '';
    if (tradingBuyStatusEl) tradingBuyStatusEl.textContent = 'Could not load listings: ' + err.message;
    return;
  }
  if (identity) listings = listings.filter((l) => l.posterPublicKey !== identity.publicKey);
  if (listings.length === 0) {
    tradingBuyListEl.innerHTML = '<div class="empty-note">Nothing listed right now.</div>';
    return;
  }
  tradingBuyListEl.innerHTML = listings.map((l) => `
    <div class="wallet-item">
      ${l.offer.quantity} ${l.offer.class} → ${l.want.quantity} ${l.want.class}
      <span class="empty-note">from ${l.posterPublicKey.slice(0, 16)}… — ${formatExpiryCountdown(l.expiresAt)}</span>
      <button type="button" class="btn-secondary trading-claim-btn" data-pending-id="${l.pendingId}">Trade</button>
    </div>
  `).join('');
}

// This wallet's own posted listings (Listings tab, v1.14) — same local
// record Sell's submitTradeIntent call writes, same "pending/settled from
// the stored record, expired computed at render time" shape
// refreshRemoteTradeList had before this reshape. Adds a Cancel button
// (POST /atlas/trade/cancel) for anything still actually withdrawable, and
// a local-only Delete button for a settled or expired card — there's
// nothing left to withdraw from either (settled already paid out,
// expired never will), so this just clears the record out of the list;
// unlike Cancel it never talks to the server, purely
// AtlasWallet.deleteSubmittedTrade() removing this wallet's own local
// bookkeeping entry. Deliberately NOT offered on 'pending' (still live —
// Cancel is the right action) or 'canceled' (not asked for; easy to add
// later if wanted).
async function refreshTradingListingsList() {
  if (!tradingListingsListEl) return;
  const identity = await AtlasWallet.getIdentity();
  if (!identity) {
    tradingListingsListEl.innerHTML = '<div class="empty-note">No identity yet.</div>';
    return;
  }
  const records = await AtlasWallet.getSubmittedTrades(identity.publicKey);
  if (records.length === 0) {
    tradingListingsListEl.innerHTML = '<div class="empty-note">Nothing posted yet.</div>';
    return;
  }
  const now = Date.now();
  tradingListingsListEl.innerHTML = records.slice().reverse().map((r) => {
    const status = r.status === 'pending' && new Date(r.expiresAt).getTime() < now ? 'expired' : r.status;
    // Only a still-pending listing has a countdown worth showing —
    // settled/expired/canceled are all already-final states.
    const countdown = status === 'pending' ? ` <span class="empty-note">(${formatExpiryCountdown(r.expiresAt)})</span>` : '';
    const actionBtn = status === 'pending'
      ? `<button type="button" class="btn-secondary trading-cancel-btn" data-pending-id="${r.pendingId}" data-domain="${r.domain}">Cancel</button>`
      : (status === 'settled' || status === 'expired' || status === 'canceled')
        ? `<button type="button" class="danger-btn trading-delete-listing-btn" data-pending-id="${r.pendingId}">Delete</button>`
        : '';
    return `<div class="wallet-item">${r.offer.quantity} ${r.offer.class} → ${r.want.quantity} ${r.want.class} @ ${r.domain} — <strong>${status}</strong>${countdown} ${actionBtn}</div>`;
  }).join('');
}

tradingStationJoinBtn && tradingStationJoinBtn.addEventListener('click', async () => {
  const domain = manifestDomainOf(currentManifest);
  tradingStationJoinBtn.disabled = true;
  tradingStationJoinBtn.textContent = 'Joining…';
  let errorMessage = '';
  try {
    await AtlasWallet.mintAsset('self', domain, 'atlas.tradingstation.membership');
  } catch (err) {
    errorMessage = 'Join failed: ' + err.message;
  } finally {
    await refreshTradingStationJoinButton();
    await refreshRemoteTradeStationOptions();
    if (tradingStationJoinStatusEl) tradingStationJoinStatusEl.textContent = errorMessage;
  }
});

remoteTradeStationDomainSelect && remoteTradeStationDomainSelect.addEventListener('change', () => {
  if (tradingBuyStatusEl) tradingBuyStatusEl.textContent = '';
  refreshTradingBuyList();
});

tradingBuyRefreshBtn && tradingBuyRefreshBtn.addEventListener('click', () => {
  if (tradingBuyStatusEl) tradingBuyStatusEl.textContent = '';
  refreshTradingBuyList();
});

// Delegated click handler (Buy tab) — one listener on the list container
// rather than one per rendered row, same reasoning the Mail/Contacts cards
// elsewhere in this file already use for their own per-row action buttons,
// since refreshTradingBuyList() rebuilds this container's innerHTML wholesale
// on every refresh.
tradingBuyListEl && tradingBuyListEl.addEventListener('click', async (evt) => {
  const btn = evt.target.closest('.trading-claim-btn');
  if (!btn) return;
  const pendingId = btn.dataset.pendingId;
  const domain = remoteTradeStationDomainSelect && remoteTradeStationDomainSelect.value;
  btn.disabled = true;
  btn.textContent = 'Trading…';
  if (tradingBuyStatusEl) tradingBuyStatusEl.textContent = '';
  try {
    const identity = await AtlasWallet.getIdentity();
    if (!identity) throw new Error('Create your identity first.');
    const memberships = await AtlasWallet.getTradingStationMemberships(identity.publicKey);
    const membership = memberships.find((m) => m.domain === domain);
    if (!membership) throw new Error('No Trading Station membership held for ' + domain + ' — join it first.');

    const listings = await AtlasWallet.fetchTradeListings(domain);
    const listing = listings.find((l) => l.pendingId === pendingId);
    if (!listing) throw new Error('That listing is no longer available.');

    const wallet = await AtlasWallet.getWallet(identity.publicKey);
    const balance = wallet.map((e) => e.credential).find((c) => c.asset.class === listing.want.class && c.asset.fungible && c.quantity >= listing.want.quantity);
    if (!balance) throw new Error('Not enough ' + listing.want.class + ' to claim this listing.');

    // This 10-minute figure is NOT a listing lifetime the way Sell's
    // expiry input is — the claimant is always live for this call (see
    // claimTradeListing's own comment), so the server checks and settles
    // this intent within the same request; it just needs a signed
    // expiresAt that hasn't already passed by the time the request lands.
    // Left as a fixed short value on purpose, unlike Sell's now-configurable
    // per-listing expiry above.
    const result = await AtlasWallet.claimTradeListing(domain, membership.credential, listing, balance, 10);
    await refreshInventoryDisplay();
    if (tradingBuyStatusEl) tradingBuyStatusEl.textContent = '✓ Traded: sent ' + listing.want.quantity + ' ' + listing.want.class + ', received ' + listing.offer.quantity + ' ' + listing.offer.class + '.';
  } catch (err) {
    if (tradingBuyStatusEl) tradingBuyStatusEl.textContent = 'Trade failed: ' + err.message;
  } finally {
    await refreshTradingBuyList();
  }
});

tradingSellSubmitBtn && tradingSellSubmitBtn.addEventListener('click', async () => {
  tradingSellSubmitBtn.disabled = true;
  tradingSellStatusEl.textContent = 'Posting…';
  try {
    const domain = remoteTradeStationDomainSelect && remoteTradeStationDomainSelect.value;
    if (!domain) throw new Error('Join a Trading Station first.');
    const identity = await AtlasWallet.getIdentity();
    if (!identity) throw new Error('Create your identity first.');

    const offerClass = tradingSellOfferClassSelect.value;
    const offerQty = parseInt(tradingSellOfferQtyInput.value, 10);
    const wantClass = tradingSellWantClassSelect.value;
    const wantQty = parseInt(tradingSellWantQtyInput.value, 10);
    const expiresHours = parseFloat(tradingSellExpiresHoursInput.value);
    if (!offerClass || !Number.isInteger(offerQty) || offerQty <= 0) throw new Error('A valid offer class + quantity is required.');
    if (!wantClass || !Number.isInteger(wantQty) || wantQty <= 0) throw new Error('A valid want class + quantity is required.');
    if (!(expiresHours > 0)) throw new Error('Expiry must be a positive number of hours.');

    const memberships = await AtlasWallet.getTradingStationMemberships(identity.publicKey);
    const membership = memberships.find((m) => m.domain === domain);
    if (!membership) throw new Error('No Trading Station membership held for ' + domain + '.');

    const wallet = await AtlasWallet.getWallet(identity.publicKey);
    const balance = wallet.map((e) => e.credential).find((c) => c.asset.class === offerClass && c.asset.fungible && c.quantity >= offerQty);
    if (!balance) throw new Error('Not enough ' + offerClass + ' to offer ' + offerQty + '.');

    // wallet.js's proposeIntent still takes expiresMinutes (v1.14 shape,
    // unchanged) — this per-listing hours input (v1.15) is purely a
    // viewer-side convenience converted at the one call site that reads it.
    await AtlasWallet.submitTradeIntent(
      domain, membership.credential,
      { class: offerClass, quantity: offerQty }, { class: wantClass, quantity: wantQty },
      balance, expiresHours * 60
    );
    tradingSellStatusEl.textContent = '✓ Posted — visible to anyone browsing Buy at ' + domain + '.';
    await refreshTradingSellOfferOptions(); // the offered balance is now staked into the listing — the dropdown's held-quantity totals should reflect that immediately
  } catch (err) {
    tradingSellStatusEl.textContent = 'Post failed: ' + err.message;
  } finally {
    tradingSellSubmitBtn.disabled = false;
  }
});

// Delegated click handler (Listings tab) — same "one listener on the
// container, rebuilt wholesale on refresh" shape as the Buy tab's claim
// handler above. Handles both actions refreshTradingListingsList() can
// render: Cancel (still-pending, talks to the server) and Delete
// (settled/expired/canceled, purely local).
tradingListingsListEl && tradingListingsListEl.addEventListener('click', async (evt) => {
  const cancelBtn = evt.target.closest('.trading-cancel-btn');
  if (cancelBtn) {
    const pendingId = cancelBtn.dataset.pendingId;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Canceling…';
    if (tradingListingsStatusEl) tradingListingsStatusEl.textContent = '';
    try {
      await AtlasWallet.cancelTradeListing(cancelBtn.dataset.domain, pendingId);
    } catch (err) {
      if (tradingListingsStatusEl) tradingListingsStatusEl.textContent = 'Cancel failed: ' + err.message;
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'Cancel';
      return;
    }
    await refreshTradingListingsList();
    return;
  }

  const deleteBtn = evt.target.closest('.trading-delete-listing-btn');
  if (deleteBtn) {
    const identity = await AtlasWallet.getIdentity();
    if (!identity) return;
    await AtlasWallet.deleteSubmittedTrade(identity.publicKey, deleteBtn.dataset.pendingId);
    await refreshTradingListingsList();
  }
});

// ---------- contacts (Social -> Contacts tab, #67, restructured) ----------
//
// Three ways in, one saved list:
//  - Add Contact: who's actually standing in this world with you right now
//    (from the live presence roster, see presenceRosterMeta), any friend
//    requests aimed at you that are still live (presencePendingIncoming —
//    only exists while both sides remain in the same room, see its own
//    comment up near disconnectPresence), and a manual add-by-address form
//    (below, near manualAddContactBtn) for when you already know someone's
//    handle or public key. Adding a friend live, and answering a request,
//    both go out as a signal over the CURRENT presence connection
//    (sendSignal) — there's no other channel this can use, by design (see
//    README.md's Friends section for why mail can't do this). The manual
//    form is the one path that doesn't need that live connection at all.
//  - Contacts: the actual saved list (AtlasWallet.getFriends(), persists
//    across sessions/worlds — see wallet.js), now searchable and carrying
//    a free-text notes field per entry.
//  - Groups: local-only personal organization over that same saved list —
//    see refreshContactGroupsDisplay further below.
//
// The underlying data model is still "friends" throughout wallet.js
// (getFriends/addFriend/removeFriend/updateFriendNotes, the atlasFriends
// storage key) — only this tab's own chrome renamed to "Contacts". See
// this restructuring's own commit message for why that line was drawn
// there: getFriends() alone is called from half a dozen OTHER features
// (mail's friend-name lookups and quick-pick, Favorites' live
// cross-reference, the friends-only mail mode) that have nothing to do
// with tab navigation — renaming the data model would ripple into all of
// those for no user-visible benefit, where renaming just the tab/screen
// ids and labels here is fully contained to this file.

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

// Contacts sub-tab's own card (task #67 follow-up): now carries a search
// index (dataset.search, matched by applyListFilter below — same
// mechanism Inventory's Collectibles/Documents search already uses) built
// from name AND notes, an inline notes textarea (saves on blur, see the
// focusout listener below), and a two-click remove — a bare "Remove"
// link-btn reveals an inline "Remove this contact?" confirm row rather
// than removing immediately, since the old direct danger-btn Remove had
// no confirmation at all (see the remove-contact-ask/-confirm/-cancel
// actions below). Confirm itself is briefly disabled after the row
// appears — see REMOVE_CONTACT_CONFIRM_GRACE_MS at the remove-contact-ask
// handler below for why (a misclick guard, not a cosmetic delay).
const REMOVE_CONTACT_CONFIRM_GRACE_MS = 400;

function renderFriendCard(f, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  el.dataset.search = (f.name + ' ' + (f.notes || '')).toLowerCase();
  el.innerHTML =
    '<div class="name">' + escapeHtml(f.name) + '</div>' +
    '<div class="meta">' + short(f.publicKey, 20) + '</div>' +
    '<textarea class="contact-notes-input" data-key="' + f.publicKey + '" placeholder="Notes (just for you)…" rows="2" style="margin-top:6px;width:100%;box-sizing:border-box;font-family:inherit;font-size:12px;">' + escapeHtml(f.notes || '') + '</textarea>' +
    '<div class="item-actions">' +
    '<button type="button" data-action="remove-contact-ask" data-key="' + f.publicKey + '" class="link-btn">Remove</button>' +
    '</div>' +
    '<div class="remove-confirm-row empty-note" data-key="' + f.publicKey + '" hidden style="margin-top:6px;">' +
    'Remove this contact? ' +
    '<button type="button" data-action="remove-contact-confirm" data-key="' + f.publicKey + '" class="danger-btn">Confirm</button> ' +
    '<button type="button" data-action="remove-contact-cancel" data-key="' + f.publicKey + '" class="btn-secondary">Cancel</button>' +
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

  if (contactsListEl) {
    contactsListEl.innerHTML = '';
    if (friends.length === 0) {
      contactsListEl.innerHTML = '<div class="empty-note">No contacts saved yet — add one from the Add Contact tab.</div>';
    } else {
      friends.forEach((f) => renderFriendCard(f, contactsListEl));
      // Every refresh rebuilds the list from scratch, so any active search
      // text has to be re-applied — same convention as
      // refreshInventoryDisplay's own applyListFilter calls.
      applyListFilter(contactsListEl, contactsSearchInput ? contactsSearchInput.value : '');
    }
  }

  await updateSocialBadge();
}

// Notes save on blur (task #67 follow-up) — a textarea's own 'blur' event
// doesn't bubble, so this listens for 'focusout' instead (which does),
// delegated on the list container same as every other Contacts action.
// Deliberately not a Save button: this is a private per-contact scratch
// field, not something that needs its own explicit commit step the way an
// address book entry with real consequences (Save Handle, Save mail mode)
// does elsewhere in this file.
contactsListEl && contactsListEl.addEventListener('focusout', async (e) => {
  const textarea = e.target.closest('.contact-notes-input');
  if (!textarea) return;
  try {
    await AtlasWallet.updateFriendNotes(textarea.dataset.key, textarea.value);
    // Keep the card's own search index (see renderFriendCard's
    // dataset.search) in sync with the note just saved — a full
    // refreshFriendsDisplay() would also work but would rebuild every
    // card from scratch (losing whatever's mid-edit in any OTHER
    // contact's notes textarea at the same moment); patching this one
    // card's dataset directly avoids that.
    const card = textarea.closest('.info-card');
    const nameEl = card && card.querySelector('.name');
    if (card && nameEl) card.dataset.search = (nameEl.textContent + ' ' + textarea.value).toLowerCase();
  } catch (err) {
    // Nothing to show for this — the card doesn't have its own status
    // line, and a lost keystroke here isn't worth a disruptive alert. The
    // note is just left in the textarea as typed; the next successful
    // blur (e.g. after fixing whatever went wrong) saves it.
  }
});

contactsSearchInput && contactsSearchInput.addEventListener('input', () => {
  applyListFilter(contactsListEl, contactsSearchInput.value);
});

// One delegated listener covers Add Contact's two live lists AND the
// Contacts list's own per-card actions (notes textarea aside, handled
// separately above) — same pattern as recentWorldsListEl's own click
// handler.
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

  // Remove-contact safety fix: a bare danger-btn used to remove
  // immediately on one click. Now "Remove" just reveals an inline confirm
  // row (see renderFriendCard above) — removing itself only happens on
  // remove-contact-confirm, a genuinely separate, deliberate click.
  //
  // Reported issue: the Confirm button appears in EXACTLY the screen spot
  // the Remove link just was (row swaps in in place, same layout position)
  // — so a double-click, or a mouse with a twitchy/sticky button firing two
  // click events close together, can land its second click squarely on
  // Confirm before anyone consciously decided to click it, defeating the
  // whole point of the two-click safety. REMOVE_CONTACT_CONFIRM_GRACE_MS
  // fixes this directly rather than trying to reposition Confirm somewhere
  // less natural: the button starts disabled the instant the row appears
  // and only becomes clickable after a short pause, so the fastest an
  // accidental double-click/twitch can manage still can't reach it. Reset
  // fresh every time the row is (re)opened — cancelling and asking again
  // requires living through the same grace window again, not just once.
  if (action === 'remove-contact-ask') {
    const card = btn.closest('.info-card');
    const row = card && card.querySelector('.remove-confirm-row');
    if (row) {
      btn.hidden = true;
      row.hidden = false;
      const confirmBtn = row.querySelector('button[data-action="remove-contact-confirm"]');
      if (confirmBtn) {
        confirmBtn.disabled = true;
        setTimeout(() => {
          if (!row.hidden) confirmBtn.disabled = false; // still open — a cancel in the meantime leaves it disabled, harmlessly, since the row's hidden anyway
        }, REMOVE_CONTACT_CONFIRM_GRACE_MS);
      }
    }
    return;
  }

  if (action === 'remove-contact-cancel') {
    const card = btn.closest('.info-card');
    const row = btn.closest('.remove-confirm-row');
    const askBtn = card && card.querySelector('button[data-action="remove-contact-ask"]');
    if (row) row.hidden = true;
    if (askBtn) askBtn.hidden = false;
    return;
  }

  if (action === 'remove-contact-confirm') {
    await AtlasWallet.removeFriend(btn.dataset.key);
    await refreshFriendsDisplay();
    return;
  }

  // ---- Groups (Contacts -> Groups sub-tab) ----

  if (action === 'rename-group') {
    const card = btn.closest('.info-card');
    const input = card && card.querySelector('.group-name-input');
    if (!input) return;
    try {
      await AtlasWallet.renameContactGroup(btn.dataset.id, input.value);
      await refreshContactGroupsDisplay();
    } catch (err) {
      if (groupsStatusEl) groupsStatusEl.textContent = 'Rename failed: ' + err.message;
    }
    return;
  }

  if (action === 'delete-group') {
    if (!confirm('Delete this group? The contacts in it are not removed, just the group itself.')) return;
    await AtlasWallet.removeContactGroup(btn.dataset.id);
    await refreshContactGroupsDisplay();
    return;
  }
});

// Group membership checkboxes (task #67 follow-up, Groups v1): a plain
// change listener rather than the button-click delegation above, since
// these are checkboxes, not buttons. Re-renders the whole Groups list
// afterward — cheap given how small this data realistically is, and
// keeps the member count in each card's .meta line honest without a
// second, separate "just patch this one number" code path.
contactGroupsListEl && contactGroupsListEl.addEventListener('change', async (e) => {
  const checkbox = e.target.closest('input[data-action="toggle-group-member"]');
  if (!checkbox) return;
  try {
    if (checkbox.checked) {
      await AtlasWallet.addContactToGroup(checkbox.dataset.group, checkbox.dataset.key);
    } else {
      await AtlasWallet.removeContactFromGroup(checkbox.dataset.group, checkbox.dataset.key);
    }
  } catch (err) {
    if (groupsStatusEl) groupsStatusEl.textContent = 'Could not update group membership: ' + err.message;
  }
  await refreshContactGroupsDisplay();
});

function renderContactGroupCard(group, friends, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  const memberCount = group.memberPublicKeys.length;
  let membersHtml;
  if (friends.length === 0) {
    membersHtml = '<div class="empty-note">No contacts saved yet — add some from the Add Contact tab, then come back here to group them.</div>';
  } else {
    membersHtml = friends.map((f) => {
      const checked = group.memberPublicKeys.includes(f.publicKey) ? ' checked' : '';
      return '<label style="display:block;margin-top:4px;font-size:12px;">' +
        '<input type="checkbox" data-action="toggle-group-member" data-group="' + group.id + '" data-key="' + f.publicKey + '"' + checked + '> ' +
        escapeHtml(f.name) + '</label>';
    }).join('');
  }
  el.innerHTML =
    '<div class="btn-row">' +
    '<input type="text" class="group-name-input" value="' + escapeHtml(group.name) + '" maxlength="40" style="flex:1;">' +
    '<button type="button" data-action="rename-group" data-id="' + group.id + '" class="btn-secondary">Save name</button>' +
    '<button type="button" data-action="delete-group" data-id="' + group.id + '" class="danger-btn">Delete</button>' +
    '</div>' +
    '<div class="meta" style="margin-top:6px;">' + memberCount + ' member' + (memberCount === 1 ? '' : 's') + '</div>' +
    '<div class="subhead" style="margin-top:8px;">Members</div>' +
    '<div class="group-members-list">' + membersHtml + '</div>';
  container.appendChild(el);
}

// Groups (task #67 follow-up): populated lazily on its own inner sub-tab
// open (contactGroupsSubtabBtn's click handler) and after every mutation
// below — nothing else keeps this current, same lazy-refresh convention
// as Mail's own Sent sub-tab.
async function refreshContactGroupsDisplay() {
  if (!contactGroupsListEl) return;
  const groups = await AtlasWallet.getContactGroups();
  const friends = await AtlasWallet.getFriends();
  contactGroupsListEl.innerHTML = '';
  if (groups.length === 0) {
    contactGroupsListEl.innerHTML = '<div class="empty-note">No groups yet — create one above.</div>';
  } else {
    groups.forEach((g) => renderContactGroupCard(g, friends, contactGroupsListEl));
  }
}

createGroupBtn && createGroupBtn.addEventListener('click', async () => {
  const name = (newGroupNameInput.value || '').trim();
  if (!name) {
    if (groupsStatusEl) groupsStatusEl.textContent = 'Enter a name for the group.';
    return;
  }
  try {
    await AtlasWallet.addContactGroup(name);
    newGroupNameInput.value = '';
    if (groupsStatusEl) groupsStatusEl.textContent = '';
    await refreshContactGroupsDisplay();
  } catch (err) {
    if (groupsStatusEl) groupsStatusEl.textContent = 'Could not create group: ' + err.message;
  }
});

// Manual add-by-address (new, Add Contact sub-tab): the one way to add a
// contact that needs neither person to be standing in the same world at
// the same moment. Same handle-vs-raw-key toggle pattern as Compose's
// recipient field — see postOfficeToggleRawKeyBtn's own comment above for
// the original.
manualAddToggleRawKeyBtn && manualAddToggleRawKeyBtn.addEventListener('click', () => {
  const showingRawKey = !manualAddPublicKeyInput.hidden;
  manualAddPublicKeyInput.hidden = showingRawKey;
  manualAddHandleInput.hidden = !showingRawKey;
  manualAddToggleRawKeyBtn.textContent = showingRawKey ? 'Paste a raw public key instead' : 'Use a handle instead';
  (showingRawKey ? manualAddPublicKeyInput : manualAddHandleInput).value = '';
});

// Unlike Compose (which has its own Post Office domain dropdown to fall
// back on for a bare handle), this form has no domain picker at all — so
// the handle path here only ever accepts a FULL "handle#domain" address,
// not a bare handle. Same domain-already-joined check and error copy as
// Compose's own handle parsing (postOfficeSendBtn above), reusing that
// same postOfficeToDomainInput select as the source of truth for "domains
// this wallet has actually joined" — populated by refreshMyPublicKeyDisplay
// on every world entry, so it's already current by the time anyone reaches
// this tab.
manualAddContactBtn && manualAddContactBtn.addEventListener('click', async () => {
  const name = (manualAddNameInput.value || '').trim();
  if (!name) {
    manualAddContactStatusEl.textContent = 'Enter a name for this contact.';
    return;
  }
  const usingRawKey = !manualAddPublicKeyInput.hidden;
  manualAddContactStatusEl.textContent = '';

  if (usingRawKey) {
    const key = (manualAddPublicKeyInput.value || '').trim();
    if (!key) {
      manualAddContactStatusEl.textContent = "Enter the contact's public key.";
      return;
    }
    manualAddContactBtn.disabled = true;
    try {
      await AtlasWallet.addFriend(key, name);
      manualAddContactStatusEl.textContent = 'Added.';
      manualAddNameInput.value = '';
      manualAddPublicKeyInput.value = '';
      await refreshFriendsDisplay();
    } catch (err) {
      manualAddContactStatusEl.textContent = 'Add failed: ' + err.message;
    } finally {
      manualAddContactBtn.disabled = false;
    }
    return;
  }

  const rawHandleInput = (manualAddHandleInput.value || '').trim();
  const hashIndex = rawHandleInput.indexOf('#');
  if (!rawHandleInput || hashIndex <= 0 || hashIndex === rawHandleInput.length - 1) {
    manualAddContactStatusEl.textContent = 'Enter a full address like bruno#localhost:8002 — there\'s no separate domain picker here.';
    return;
  }
  const handle = rawHandleInput.slice(0, hashIndex).trim();
  const domain = rawHandleInput.slice(hashIndex + 1).trim();
  const knownDomains = postOfficeToDomainInput ? [...postOfficeToDomainInput.options].map((o) => o.value).filter(Boolean) : [];
  if (!knownDomains.includes(domain)) {
    manualAddContactStatusEl.textContent = 'You haven\'t joined ' + domain + '\'s Post Office yet — join it first (Mail\'s Post Office section), then try again.';
    return;
  }
  manualAddContactBtn.disabled = true;
  manualAddContactStatusEl.textContent = 'Looking up…';
  try {
    const resolved = await AtlasWallet.resolvePostOfficeHandle(domain, handle);
    await AtlasWallet.addFriend(resolved.publicKey, name);
    manualAddContactStatusEl.textContent = 'Added.';
    manualAddNameInput.value = '';
    manualAddHandleInput.value = '';
    await refreshFriendsDisplay();
  } catch (err) {
    manualAddContactStatusEl.textContent = err.message;
  } finally {
    manualAddContactBtn.disabled = false;
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

// ---------- calendar events (Social -> Calendar) ----------
//
// Purely local reminders (AtlasWallet.getCalendarEvents/addCalendarEvent/
// updateCalendarEvent/removeCalendarEvent in wallet.js) — no domain, no
// credential, no counterparty involved. An event's end time (endDateTime,
// see wallet.js) is optional — everywhere below that used to read
// entry.dateTime alone for display or urgency now accounts for it too:
// formatCalendarWhen (a "start–end" range on the list card),
// calendarEventUrgencyMs (overdue/due-soon judged by the END once one
// exists), renderCalendarMonthGrid (a multi-day event's dot appears on
// EVERY day it spans), and calendarDayRoleForEntry/renderCalendarDayEventChip
// (the day-viewer widget showing the right portion of a multi-day event on
// each day it touches). `calendarEditingEventId` is this
// screen's own bit of transient UI state (which existing event, if any,
// the form below is currently editing) — null means the form is in
// "add a new event" mode, same "plain module-level let for transient panel
// state" convention as e.g. chatResizeDrag elsewhere in this file.
let calendarEditingEventId = null;

// The persistent month-grid widget's own bit of transient, session-only
// state — neither is ever persisted (a fresh session, or just reopening
// the Calendar sub-tab, always starts back on the real current month, see
// resetCalendarGridToToday()):
//   calendarGridViewDate — a Date standing in for "the month currently
//     shown" (only its year/month are read; day is pinned to 1 to avoid
//     any end-of-month rollover surprises when stepping months).
//   calendarSelectedDate — the 'YYYY-MM-DD' (local) of the last day
//     clicked in the grid, or null once the form's been reset/submitted
//     and nothing is selected.
let calendarGridViewDate = null;
let calendarSelectedDate = null;

// Sanity cap on how many days a multi-day event's month-grid dot walk
// (renderCalendarMonthGrid below) will ever mark — comfortably more than
// any real event (a year-long conference isn't a thing), just a guard
// against a bogus or fat-fingered endDateTime years in the future turning
// one event into thousands of dots / a slow render.
const CALENDAR_GRID_DOT_SPAN_CAP_DAYS = 366;

// Local-calendar-day key ('YYYY-MM-DD' in THIS device's timezone, not
// UTC) — used to match a Date against both "is this today" and "does this
// day have an event", the same local-time reasoning toDatetimeLocalValue
// below already uses for the add/edit form's own date field.
function toLocalDateKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Snaps the month-grid widget back to the real current month and clears
// any day selection — called every time the Calendar sub-tab is actually
// opened (its own subtab button, and the "Add to calendar" mail bridge),
// per the widget's own "always start on the real current month" rule.
// Stepping months with the ‹/› buttons afterward is deliberately NOT
// undone by re-rendering the event list (refreshCalendarDisplay), only by
// leaving and reopening the sub-tab — see refreshCalendarMonthGrid below.
function resetCalendarGridToToday() {
  calendarGridViewDate = new Date();
  calendarSelectedDate = null;
}

// Renders the month-grid widget for whatever month calendarGridViewDate
// currently points at, from an already-fetched `events` list (callers
// that already have one — refreshCalendarDisplay — pass it straight
// through rather than this function re-fetching it itself, same
// "don't re-fetch if a caller already has it" convention
// countCalendarEventsDueSoon's own comment mentions). Always renders a
// clean 7-column rectangle: leading/trailing days from the adjacent
// months fill out the first/last week rather than leaving it ragged.
function renderCalendarMonthGrid(events) {
  if (!calendarMonthGridEl) return;
  if (!calendarGridViewDate) calendarGridViewDate = new Date();

  const viewYear = calendarGridViewDate.getFullYear();
  const viewMonth = calendarGridViewDate.getMonth(); // 0-11

  if (calendarMonthLabelEl) {
    calendarMonthLabelEl.textContent = calendarGridViewDate.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  }

  const startWeekday = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun, whatever Date's own default week-start is
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();
  const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;

  const todayKey = toLocalDateKey(new Date());
  // Matched by local calendar day, not exact timestamp — an event at
  // 11pm and one at 1am on the same wall-clock day both mark that one day.
  // For a multi-day event (endDateTime on a later local day than
  // dateTime), EVERY day it spans gets a dot, not just its start day —
  // this grid is meant as a quick "what's happening" glance, and an event
  // that's still ongoing three days after it started is still very much
  // "happening" on day three, not just on day one. A capped walk (see
  // CALENDAR_GRID_DOT_SPAN_CAP_DAYS) guards against a bogus/absurdly
  // far-future endDateTime turning this into a slow, pointless loop.
  const eventDateKeys = new Set();
  events.forEach((entry) => {
    const start = new Date(entry.dateTime);
    if (isNaN(start.getTime())) return;
    const end = entry.endDateTime ? new Date(entry.endDateTime) : null;
    if (!end || isNaN(end.getTime())) { eventDateKeys.add(toLocalDateKey(start)); return; }
    let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    for (let i = 0; cursor <= endDay && i < CALENDAR_GRID_DOT_SPAN_CAP_DAYS; i++) {
      eventDateKeys.add(toLocalDateKey(cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
  });

  calendarMonthGridEl.innerHTML = '';
  for (let i = 0; i < totalCells; i++) {
    const dayOffset = i - startWeekday;
    let cellDate, otherMonth;
    if (dayOffset < 0) {
      cellDate = new Date(viewYear, viewMonth - 1, daysInPrevMonth + dayOffset + 1);
      otherMonth = true;
    } else if (dayOffset >= daysInMonth) {
      cellDate = new Date(viewYear, viewMonth + 1, dayOffset - daysInMonth + 1);
      otherMonth = true;
    } else {
      cellDate = new Date(viewYear, viewMonth, dayOffset + 1);
      otherMonth = false;
    }
    const key = toLocalDateKey(cellDate);
    const cell = document.createElement('div');
    // The "today" marker only ever lands on a real (non-leaked) day of the
    // month actually being viewed — a leaked day from an adjacent month
    // that happens to equal the real today (e.g. viewing next month while
    // today is the last day of this one) stays a plain dimmed other-month
    // cell, matching "whenever the currently-displayed month includes
    // today" rather than "whenever today happens to appear anywhere".
    cell.className = 'calendar-grid-day' +
      (otherMonth ? ' other-month' : '') +
      (!otherMonth && key === todayKey ? ' today' : '') +
      (key === calendarSelectedDate ? ' selected' : '');
    cell.dataset.date = key;
    cell.innerHTML = '<span>' + cellDate.getDate() + '</span>' +
      (eventDateKeys.has(key) ? '<span class="calendar-grid-dot"></span>' : '');
    calendarMonthGridEl.appendChild(cell);
  }
}

// Re-fetches events and re-renders just the month-grid widget — used by
// the ‹/› month-step buttons, which don't touch the event list below and
// so don't need refreshCalendarDisplay's fuller re-render. Also re-renders
// the day-viewer widget below it (cheap even when nothing changed there —
// stepping months doesn't itself change or clear calendarSelectedDate, so
// a day selected before stepping months stays selected and showing after).
async function refreshCalendarMonthGrid() {
  const events = await AtlasWallet.getCalendarEvents();
  renderCalendarMonthGrid(events);
  renderCalendarDayViewer(events);
}

// The day-viewer widget's own hour range. A full midnight-to-midnight list
// of 24 slots is visually excessive for the wallet panel's fixed ~360px
// width (mostly-empty rows pushing the add/edit form far down the panel),
// so this picks the more commonly-relevant 6am-11pm window instead. An
// event whose local hour falls outside it (rare — before 6am) still shows,
// just up in the "Other times" bucket rather than in an hour row.
const CALENDAR_DAY_VIEW_START_HOUR = 6; // 6am
const CALENDAR_DAY_VIEW_END_HOUR = 23; // 11pm

// "6" -> "6 AM", "13" -> "1 PM", "0"/"24"-never-passed edge cases aside.
function formatCalendarHourLabel(hour) {
  const suffix = hour < 12 ? 'AM' : 'PM';
  let h = hour % 12;
  if (h === 0) h = 12;
  return h + ' ' + suffix;
}

const CALENDAR_HOUR_MINUTE_OPTS = { hour: 'numeric', minute: '2-digit' };
const CALENDAR_SHORT_DATE_OPTS = { month: 'short', day: 'numeric' };

// What a given local day ('YYYY-MM-DD') is TO an event, for the day-viewer
// widget's purposes — null if the event doesn't touch that day at all:
//   'point'  — an instant event (no end), or a same-day start/end pair —
//              on its one and only day.
//   'start'  — the FIRST day of a multi-day (different local start/end
//              day) event.
//   'end'    — the LAST day of a multi-day event (not also its first).
//   'through'— a day strictly BETWEEN a multi-day event's start and end
//              days — the event is running all day, with nothing of its
//              own happening at any particular hour on this day.
// Kept separate from renderCalendarDayEventChip below so the "which day
// role is this" decision and the "how do I draw that role" decision each
// live in exactly one place.
function calendarDayRoleForEntry(entry, dayKey) {
  const start = new Date(entry.dateTime);
  if (isNaN(start.getTime())) return null;
  const startKey = toLocalDateKey(start);
  if (!entry.endDateTime) return startKey === dayKey ? 'point' : null;
  const end = new Date(entry.endDateTime);
  if (isNaN(end.getTime())) return startKey === dayKey ? 'point' : null;
  const endKey = toLocalDateKey(end);
  if (startKey === endKey) return startKey === dayKey ? 'point' : null;
  if (dayKey === startKey) return 'start';
  if (dayKey === endKey) return 'end';
  // Strictly-between check done via real Date comparisons (not string
  // comparison on the 'YYYY-MM-DD' keys, which WOULD happen to sort
  // correctly here but only by accident of that format being zero-padded
  // and lexicographic) — same local-y/m/d parsing renderCalendarDayViewer
  // itself already uses for calendarSelectedDate below.
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  const [dy, dm, dd] = dayKey.split('-').map(Number);
  const startMs = new Date(sy, sm - 1, sd).getTime();
  const endMs = new Date(ey, em - 1, ed).getTime();
  const dayMs = new Date(dy, dm - 1, dd).getTime();
  return (dayMs > startMs && dayMs < endMs) ? 'through' : null;
}

// One clickable event chip inside the day-viewer widget — clicking it
// opens the SAME edit flow the event-list's own "Edit" button uses (see
// openCalendarEventForEdit below and the click handler on
// calendarDayViewerEl), not a separate copy of it. `role` (see
// calendarDayRoleForEntry above) decides what the chip's time label says
// and whether it gets the .has-duration accent — a multi-day event never
// renders identically to a plain instant event, on any of the days it
// touches.
function renderCalendarDayEventChip(entry, role) {
  role = role || 'point';
  const overdue = calendarEventUrgencyMs(entry) < Date.now();
  const startTime = new Date(entry.dateTime).toLocaleTimeString(undefined, CALENDAR_HOUR_MINUTE_OPTS);
  let timeLabel;
  let hasDuration = false;
  if (role === 'point' && entry.endDateTime) {
    const endTime = new Date(entry.endDateTime).toLocaleTimeString(undefined, CALENDAR_HOUR_MINUTE_OPTS);
    timeLabel = startTime + '–' + endTime;
    hasDuration = true;
  } else if (role === 'point') {
    timeLabel = startTime;
  } else if (role === 'start') {
    timeLabel = startTime + ' – (continues)';
    hasDuration = true;
  } else if (role === 'end') {
    const endTime = new Date(entry.endDateTime).toLocaleTimeString(undefined, CALENDAR_HOUR_MINUTE_OPTS);
    const startDateLabel = new Date(entry.dateTime).toLocaleDateString(undefined, CALENDAR_SHORT_DATE_OPTS);
    timeLabel = '(from ' + startDateLabel + ') – ' + endTime;
    hasDuration = true;
  } else { // 'through'
    timeLabel = 'All day (continues)';
    hasDuration = true;
  }
  const chip = document.createElement('div');
  chip.className = 'calendar-day-event' + (overdue ? ' overdue' : '') + (hasDuration ? ' has-duration' : '');
  chip.dataset.id = entry.id;
  chip.innerHTML = '<span class="calendar-day-event-time">' + escapeHtml(timeLabel) + '</span>' + escapeHtml(entry.title);
  return chip;
}

// Renders the day-viewer widget for whatever day calendarSelectedDate
// currently names, from an already-fetched `events` list (same
// don't-refetch-if-a-caller-already-has-one convention renderCalendarMonthGrid
// above follows). This is the ONE place that reads calendarSelectedDate
// back into "does the widget show at all" — hides itself the moment that's
// null, which is exactly the state resetCalendarGridToToday/resetCalendarForm
// leave it in, so a fresh sub-tab open or a form reset/submit clears this
// widget for free as long as something eventually calls this again (both
// of those are always immediately followed by either a refreshCalendarDisplay/
// refreshCalendarMonthGrid call, or resetCalendarForm's own direct hide
// below, in every call site in this file).
function renderCalendarDayViewer(events) {
  if (!calendarDayViewerEl) return;
  if (!calendarSelectedDate) {
    calendarDayViewerEl.hidden = true;
    return;
  }
  calendarDayViewerEl.hidden = false;

  // Parsed as local y/m/d (not `new Date(calendarSelectedDate)`, which
  // Date treats as UTC midnight and can print as the PREVIOUS day in a
  // negative-UTC-offset timezone) — same local-date reasoning toLocalDateKey
  // itself relies on.
  const [y, m, d] = calendarSelectedDate.split('-').map(Number);
  const dayDate = new Date(y, m - 1, d);
  if (calendarDayViewerHeaderEl) {
    calendarDayViewerHeaderEl.textContent = dayDate.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  if (!calendarDayViewerBodyEl) return;
  calendarDayViewerBodyEl.innerHTML = '';

  // Includes not just events that START on this day, but any multi-day
  // event that's still running through it or ends on it (calendarDayRoleForEntry
  // returning anything other than null) — a 3-day trip shows up in the day
  // viewer on all 3 of its days, each showing only the portion relevant to
  // that day (see renderCalendarDayEventChip's per-role time labels).
  const dayEvents = events
    .map((entry) => ({ entry, role: calendarDayRoleForEntry(entry, calendarSelectedDate) }))
    .filter((x) => x.role !== null)
    .sort((a, b) => new Date(a.entry.dateTime) - new Date(b.entry.dateTime));

  if (dayEvents.length === 0) {
    // Same empty-state wording/visual style refreshCalendarDisplay's own
    // event-list empty state uses ("No events yet — add one above."),
    // adapted to name the specific day instead of the list as a whole.
    calendarDayViewerBodyEl.innerHTML = '<div class="empty-note">No events on this day.</div>';
    return;
  }

  const throughEvents = []; // 'through' role — running all day, no hour of its own on THIS day
  const otherEvents = []; // this day's relevant hour (start hour, or end hour for an 'end' row) falls outside the 6am-11pm range
  const hourBuckets = new Map(); // hour (0-23) -> {entry, role}[]
  dayEvents.forEach(({ entry, role }) => {
    if (role === 'through') { throughEvents.push({ entry, role }); return; }
    // 'end' rows are keyed by the END time's hour (that's what's actually
    // happening on this day) — 'point' and 'start' rows both key off the
    // start time, which for 'point' is the only time and for 'start' is
    // the only part of the event that occurs on this particular day.
    const relevant = role === 'end' ? new Date(entry.endDateTime) : new Date(entry.dateTime);
    const hour = relevant.getHours();
    if (hour < CALENDAR_DAY_VIEW_START_HOUR || hour > CALENDAR_DAY_VIEW_END_HOUR) {
      otherEvents.push({ entry, role });
    } else {
      if (!hourBuckets.has(hour)) hourBuckets.set(hour, []);
      hourBuckets.get(hour).push({ entry, role });
    }
  });

  if (throughEvents.length > 0) {
    const throughSection = document.createElement('div');
    throughSection.className = 'calendar-day-viewer-other';
    throughSection.innerHTML = '<div class="calendar-day-viewer-other-label">All day</div>';
    throughEvents.forEach(({ entry, role }) => throughSection.appendChild(renderCalendarDayEventChip(entry, role)));
    calendarDayViewerBodyEl.appendChild(throughSection);
  }

  if (otherEvents.length > 0) {
    const otherSection = document.createElement('div');
    otherSection.className = 'calendar-day-viewer-other';
    otherSection.innerHTML = '<div class="calendar-day-viewer-other-label">Other times</div>';
    otherEvents.forEach(({ entry, role }) => otherSection.appendChild(renderCalendarDayEventChip(entry, role)));
    calendarDayViewerBodyEl.appendChild(otherSection);
  }

  const hoursEl = document.createElement('div');
  hoursEl.className = 'calendar-day-viewer-hours';
  for (let hour = CALENDAR_DAY_VIEW_START_HOUR; hour <= CALENDAR_DAY_VIEW_END_HOUR; hour++) {
    const row = document.createElement('div');
    row.className = 'calendar-day-hour-row';
    const label = document.createElement('div');
    label.className = 'calendar-day-hour-label';
    label.textContent = formatCalendarHourLabel(hour);
    row.appendChild(label);
    const slot = document.createElement('div');
    slot.className = 'calendar-day-hour-events';
    (hourBuckets.get(hour) || []).forEach(({ entry, role }) => slot.appendChild(renderCalendarDayEventChip(entry, role)));
    row.appendChild(slot);
    hoursEl.appendChild(row);
  }
  calendarDayViewerBodyEl.appendChild(hoursEl);
}

// Shared by both the event-list's own "Edit" button and a click on an
// event chip inside the day-viewer widget above, so the actual
// enter-edit-mode setup lives in exactly one place. Also jumps the
// month-grid AND day-viewer widgets to this event's month/day (same as
// before this function existed, when only the month grid did) so neither
// widget sits showing something stale while the form below edits it.
function openCalendarEventForEdit(entry, events) {
  calendarEditingEventId = entry.id;
  if (calendarEventTitleInput) calendarEventTitleInput.value = entry.title;
  if (calendarEventDateTimeInput) calendarEventDateTimeInput.value = toDatetimeLocalValue(entry.dateTime);
  // toDatetimeLocalValue('' falsy input) already round-trips to '' — same
  // call handles both "this event has an end time" and "it doesn't" here.
  if (calendarEventEndDateTimeInput) calendarEventEndDateTimeInput.value = toDatetimeLocalValue(entry.endDateTime);
  if (calendarEventNotesInput) calendarEventNotesInput.value = entry.notes || '';
  if (calendarSaveEventBtn) calendarSaveEventBtn.textContent = 'Save changes';
  if (calendarCancelEditBtn) calendarCancelEditBtn.hidden = false;
  if (calendarEventStatusEl) calendarEventStatusEl.textContent = 'Editing "' + entry.title + '".';
  calendarEventTitleInput && calendarEventTitleInput.focus();
  const entryDate = new Date(entry.dateTime);
  if (!isNaN(entryDate.getTime())) {
    calendarGridViewDate = new Date(entryDate.getFullYear(), entryDate.getMonth(), 1);
    calendarSelectedDate = toLocalDateKey(entryDate);
    renderCalendarMonthGrid(events);
    renderCalendarDayViewer(events);
  }
}

calendarPrevMonthBtn && calendarPrevMonthBtn.addEventListener('click', async () => {
  if (!calendarGridViewDate) calendarGridViewDate = new Date();
  calendarGridViewDate = new Date(calendarGridViewDate.getFullYear(), calendarGridViewDate.getMonth() - 1, 1);
  await refreshCalendarMonthGrid();
});

calendarNextMonthBtn && calendarNextMonthBtn.addEventListener('click', async () => {
  if (!calendarGridViewDate) calendarGridViewDate = new Date();
  calendarGridViewDate = new Date(calendarGridViewDate.getFullYear(), calendarGridViewDate.getMonth() + 1, 1);
  await refreshCalendarMonthGrid();
});

// Click-to-select: sets the DATE portion only of the add/edit form's
// datetime-local field to the clicked day, leaving whatever time portion
// was already typed (defaulting to a sensible 09:00 if the field was
// empty) — the widget only ever picks a day, never a time. Also (re)renders
// the day-viewer widget below for the newly-clicked day, live, whether or
// not one was already showing for some other day.
calendarMonthGridEl && calendarMonthGridEl.addEventListener('click', async (e) => {
  const cell = e.target.closest('.calendar-grid-day');
  if (!cell) return;
  const key = cell.dataset.date;
  calendarSelectedDate = key;
  calendarMonthGridEl.querySelectorAll('.calendar-grid-day.selected').forEach((el) => el.classList.remove('selected'));
  cell.classList.add('selected');
  if (calendarEventDateTimeInput) {
    const existing = calendarEventDateTimeInput.value;
    const timePart = (existing && existing.includes('T')) ? existing.split('T')[1] : '09:00';
    calendarEventDateTimeInput.value = key + 'T' + timePart;
  }
  const events = await AtlasWallet.getCalendarEvents();
  renderCalendarDayViewer(events);
});

// Delegated click on the day-viewer widget's event chips (see
// renderCalendarDayEventChip) — opens the SAME edit flow the event-list's
// "Edit" button uses below, via the shared openCalendarEventForEdit.
calendarDayViewerEl && calendarDayViewerEl.addEventListener('click', async (e) => {
  const chip = e.target.closest('.calendar-day-event');
  if (!chip) return;
  const events = await AtlasWallet.getCalendarEvents();
  const entry = events.find((ev) => ev.id === chip.dataset.id);
  if (!entry) return;
  openCalendarEventForEdit(entry, events);
});

// Renders an event's "when" line. With no end time, exactly the same plain
// `toLocaleString()` this always rendered. With one, shows a "start–end"
// range instead — same-day range collapses to one date plus two times
// ("Sep 5, 2026, 2:00 PM – 3:30 PM"); a multi-day range shows the date
// alongside BOTH times ("Sep 8, 2026, 2:00 PM – Sep 9, 2026, 10:00 AM") so
// which end is which day is never ambiguous. The date is always shown
// (unlike the day-viewer widget's chips, which can omit it because their
// own header already names the day) since this flat list has no other
// per-entry date context — it's sorted chronologically, but nothing else
// on the card says what day a given entry falls on.
function formatCalendarWhen(entry) {
  const start = new Date(entry.dateTime);
  if (isNaN(start.getTime())) return 'No date set';
  if (!entry.endDateTime) return start.toLocaleString();
  const end = new Date(entry.endDateTime);
  if (isNaN(end.getTime())) return start.toLocaleString();
  const startTime = start.toLocaleTimeString(undefined, CALENDAR_HOUR_MINUTE_OPTS);
  const endTime = end.toLocaleTimeString(undefined, CALENDAR_HOUR_MINUTE_OPTS);
  if (toLocalDateKey(start) === toLocalDateKey(end)) {
    const dateLabel = start.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return dateLabel + ', ' + startTime + ' – ' + endTime;
  }
  const startDateLabel = start.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const endDateLabel = end.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return startDateLabel + ', ' + startTime + ' – ' + endDateLabel + ', ' + endTime;
}

function renderCalendarEventCard(entry, container) {
  const el = document.createElement('div');
  el.className = 'info-card calendar-event';
  // Overdue now means the event's END has passed when it has one, not
  // just its start — see calendarEventUrgencyMs's own comment above.
  const overdue = calendarEventUrgencyMs(entry) < Date.now();
  el.classList.toggle('overdue', overdue);
  el.innerHTML =
    '<div class="name">' + escapeHtml(entry.title) + '</div>' +
    '<div class="calendar-event-when">' + escapeHtml(formatCalendarWhen(entry)) + (overdue ? ' · overdue' : '') + '</div>' +
    (entry.notes ? '<div class="calendar-event-notes">' + escapeHtml(entry.notes) + '</div>' : '') +
    '<div class="item-actions">' +
    '<button type="button" data-action="edit-calendar-event" data-id="' + escapeHtml(entry.id) + '">Edit</button>' +
    '<button type="button" data-action="delete-calendar-event" data-id="' + escapeHtml(entry.id) + '" class="danger-btn">Delete</button>' +
    '</div>';
  container.appendChild(el);
}

async function refreshCalendarDisplay() {
  // getCalendarEvents() already returns soonest-first (see its own comment
  // in wallet.js) — nothing to sort here, just render in the order given.
  // Fetched once and shared with the month-grid widget below rather than
  // each re-fetching its own copy.
  const events = await AtlasWallet.getCalendarEvents();
  renderCalendarMonthGrid(events);
  renderCalendarDayViewer(events);
  if (calendarEventsListEl) {
    calendarEventsListEl.innerHTML = '';
    if (events.length === 0) {
      calendarEventsListEl.innerHTML = '<div class="empty-note">No events yet — add one above.</div>';
    } else {
      events.forEach((entry) => renderCalendarEventCard(entry, calendarEventsListEl));
    }
  }
  await updateSocialBadge();
}

// Converts a stored ISO string into the "YYYY-MM-DDTHH:mm" shape
// <input type="datetime-local"> needs for its value, in LOCAL time (not
// UTC) so an edited event reopens showing the same wall-clock time it was
// saved with. Empty/invalid input round-trips to '' rather than throwing —
// used both to populate an edit and (indirectly, via '') to clear the field.
function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// Resets the Add-event form back to "add a new event" mode — used after a
// successful save, after Cancel edit, and before pre-filling from a mail
// message (so filling one in never leaves a stray edit-in-progress on some
// other event).
function resetCalendarForm() {
  calendarEditingEventId = null;
  // Clears the month-grid widget's own "selected day" highlight (a plain
  // class toggle on whatever cell currently has it — no need to re-fetch
  // events and re-render the whole grid just for this).
  calendarSelectedDate = null;
  if (calendarMonthGridEl) {
    calendarMonthGridEl.querySelectorAll('.calendar-grid-day.selected').forEach((el) => el.classList.remove('selected'));
  }
  // Same "just clear the DOM directly, no re-fetch needed" reasoning as the
  // month-grid's .selected class right above — calendarSelectedDate is now
  // null, and that's the only thing renderCalendarDayViewer needs to decide
  // to hide, so there's no need to await a fresh events fetch just for this.
  if (calendarDayViewerEl) calendarDayViewerEl.hidden = true;
  if (calendarEventTitleInput) calendarEventTitleInput.value = '';
  if (calendarEventDateTimeInput) calendarEventDateTimeInput.value = '';
  if (calendarEventEndDateTimeInput) calendarEventEndDateTimeInput.value = '';
  if (calendarEventNotesInput) calendarEventNotesInput.value = '';
  if (calendarSaveEventBtn) calendarSaveEventBtn.textContent = 'Add event';
  if (calendarCancelEditBtn) calendarCancelEditBtn.hidden = true;
  if (calendarEventStatusEl) calendarEventStatusEl.textContent = '';
}

calendarSaveEventBtn && calendarSaveEventBtn.addEventListener('click', async () => {
  const title = calendarEventTitleInput ? calendarEventTitleInput.value.trim() : '';
  const rawDateTime = calendarEventDateTimeInput ? calendarEventDateTimeInput.value : '';
  const rawEndDateTime = calendarEventEndDateTimeInput ? calendarEventEndDateTimeInput.value : '';
  const notes = calendarEventNotesInput ? calendarEventNotesInput.value.trim() : '';
  if (!title) { calendarEventStatusEl.textContent = 'A title is required.'; return; }
  if (!rawDateTime) { calendarEventStatusEl.textContent = 'A date/time is required.'; return; }
  // <input type="datetime-local">'s value has no timezone of its own (it's
  // "wall clock" local time) — `new Date(rawDateTime)` parses that as THIS
  // device's local time, same zone toDatetimeLocalValue() above renders
  // back into, so round-tripping through storage as an ISO string never
  // shifts what the user actually typed.
  const dateTime = new Date(rawDateTime).toISOString();
  // The end field is optional — leaving it blank keeps the event a plain
  // instant with no duration, exactly as it always behaved before this
  // field existed. Validated here (same inline calendarEventStatusEl
  // pattern the two checks above already use, rather than only relying on
  // AtlasWallet's own defensive check) so the message actually names
  // what's wrong instead of falling through to the generic "Could not
  // save:" catch-all below.
  let endDateTime = null;
  if (rawEndDateTime) {
    endDateTime = new Date(rawEndDateTime).toISOString();
    if (new Date(endDateTime).getTime() <= new Date(dateTime).getTime()) {
      calendarEventStatusEl.textContent = 'The end time must be after the start time.';
      return;
    }
  }
  try {
    if (calendarEditingEventId) {
      await AtlasWallet.updateCalendarEvent(calendarEditingEventId, { title, dateTime, endDateTime, notes });
    } else {
      await AtlasWallet.addCalendarEvent({ title, dateTime, endDateTime, notes });
    }
    resetCalendarForm();
    await refreshCalendarDisplay();
  } catch (err) {
    calendarEventStatusEl.textContent = 'Could not save: ' + err.message;
  }
});

calendarCancelEditBtn && calendarCancelEditBtn.addEventListener('click', () => {
  resetCalendarForm();
});

calendarEventsListEl && calendarEventsListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === 'edit-calendar-event') {
    const events = await AtlasWallet.getCalendarEvents();
    const entry = events.find((ev) => ev.id === id);
    if (!entry) return;
    openCalendarEventForEdit(entry, events);
    return;
  }

  if (action === 'delete-calendar-event') {
    if (!confirm('Delete this event? This cannot be undone.')) return;
    await AtlasWallet.removeCalendarEvent(id);
    if (calendarEditingEventId === id) resetCalendarForm(); // was mid-edit on the thing just deleted
    await refreshCalendarDisplay();
    return;
  }
});

// "Add to calendar" bridge from a mail card's "⋯" menu (see renderMailCard)
// — jumps to Calendar and pre-fills the add-event form from that message,
// but does NOT create the event itself: mail body text can't be reliably
// parsed for a real event date, so the date/time field is left blank for
// the user to actually set before saving. A lightweight bridge, not
// automatic event extraction.
function prefillCalendarEventFromMail(subject, body) {
  resetCalendarForm();
  const EXCERPT_LEN = 200;
  const trimmedBody = (body || '').trim();
  const excerpt = trimmedBody.length > EXCERPT_LEN ? trimmedBody.slice(0, EXCERPT_LEN) + '…' : trimmedBody;
  if (calendarEventTitleInput) calendarEventTitleInput.value = subject || '';
  if (calendarEventNotesInput) calendarEventNotesInput.value = excerpt ? 'From mail: ' + excerpt : '';
  if (calendarEventStatusEl) calendarEventStatusEl.textContent = 'Pre-filled from a mail message — pick a date/time, then Add event.';
  calendarEventDateTimeInput && calendarEventDateTimeInput.focus();
}

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

// ---------- in-world chess (task #195, win rewards task #201) ----------
//
// A scene-local minigame — see chess.js's own header comment for why it
// deliberately involves no manifest field, credential, or SPEC.md change.
// Human vs. bot only; two-player is future work (tracked in the private
// backlog, not this file). One game lives in memory (chessGame below) for
// as long as this page stays open — closing the modal (chessCloseBtn)
// only hides it, it doesn't end the game, so walking back up to the stall
// and clicking it again resumes exactly where you left off. A page
// reload, or clicking "New game," does lose it; there's no persistence
// across a reload for this v1, the same "worth noting, not a bug" scope
// cut chat's own message history already makes.
//
// Task #201 adds the one exception to "chess never touches the wallet":
// beating the bot mints a real reward (gold, plus a trophy for a Hard win)
// via AtlasWallet.mintAsset — see CHESS_WIN_REWARDS / maybeAwardChessWin()
// further down. Playing still needs no identity at all; only collecting a
// win's reward does, exactly like every other mint/issue interactable.
const chessModalEl = document.getElementById('chessModal');
const chessBoardEl = document.getElementById('chessBoard');
const chessStatusEl = document.getElementById('chessStatus');
const chessCapturedByWhiteEl = document.getElementById('chessCapturedByWhite');
const chessCapturedByBlackEl = document.getElementById('chessCapturedByBlack');
const chessDifficultyInput = document.getElementById('chessDifficultyInput');
const chessPlayerColorInput = document.getElementById('chessPlayerColorInput');
const chessNewGameBtn = document.getElementById('chessNewGameBtn');
const chessCloseBtn = document.getElementById('chessCloseBtn');
const chessPromotionPickerEl = document.getElementById('chessPromotionPicker');

const CHESS_PIECE_GLYPHS = {
  wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
  bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚',
};

let chessGame = null; // null until the first "New game" — see openChessModal()
let chessSelectedSquare = null; // a from-square index, or null when nothing is selected
let chessLegalTargets = []; // AtlasChess.getLegalMovesFrom() result for chessSelectedSquare
let chessPendingPromotion = null; // {from, to}, only while the promotion picker is up
let chessBotThinking = false; // guards clicks landing while the bot's move is in flight

function renderChessBoard() {
  if (!chessGame) { chessBoardEl.innerHTML = ''; return; }
  const board = chessGame.board;
  const inCheck = chessGame.status === 'active' && AtlasChess.isInCheck(chessGame, chessGame.turn);
  const kingSquare = inCheck ? board.findIndex((p) => p === chessGame.turn + 'k') : -1;
  chessBoardEl.innerHTML = '';
  // Rendered with rank 8 at the top and rank 1 at the bottom (a real
  // board's own orientation) when playing White, flipped when playing
  // Black, so "your side" always sits nearest you regardless of color.
  for (let displayRow = 0; displayRow < 8; displayRow++) {
    for (let displayCol = 0; displayCol < 8; displayCol++) {
      const rank = chessGame.playerColor === 'w' ? 7 - displayRow : displayRow;
      const file = chessGame.playerColor === 'w' ? displayCol : 7 - displayCol;
      const square = rank * 8 + file;
      const div = document.createElement('div');
      div.className = 'chess-square ' + ((rank + file) % 2 === 0 ? 'dark' : 'light');
      const piece = board[square];
      if (piece) {
        const glyph = document.createElement('span');
        glyph.className = 'chess-piece ' + (AtlasChess.colorOf(piece) === 'w' ? 'white' : 'black');
        glyph.textContent = CHESS_PIECE_GLYPHS[piece];
        div.appendChild(glyph);
      }
      if (chessSelectedSquare === square) div.classList.add('selected');
      if (chessGame.lastMove && (chessGame.lastMove.from === square || chessGame.lastMove.to === square)) div.classList.add('last-move');
      if (square === kingSquare) div.classList.add('in-check');
      if (chessLegalTargets.some((m) => m.to === square)) {
        div.classList.add('legal-move');
        if (piece) div.classList.add('has-piece');
      }
      div.dataset.square = String(square);
      chessBoardEl.appendChild(div);
    }
  }
}

function renderChessCaptured() {
  chessCapturedByWhiteEl.textContent = chessGame.captured.w.map((p) => CHESS_PIECE_GLYPHS[p]).join(' ');
  chessCapturedByBlackEl.textContent = chessGame.captured.b.map((p) => CHESS_PIECE_GLYPHS[p]).join(' ');
}

function chessColorName(c) { return c === 'w' ? 'White' : 'Black'; }

function renderChessStatus() {
  if (!chessGame) { chessStatusEl.textContent = ''; return; }
  if (chessGame.status === 'checkmate') {
    const youWon = chessGame.winner === chessGame.playerColor;
    chessStatusEl.textContent = 'Checkmate — ' + chessColorName(chessGame.winner) + ' wins. ' + (youWon ? 'You won!' : 'The bot won.');
    return;
  }
  if (chessGame.status === 'stalemate') { chessStatusEl.textContent = 'Draw by stalemate.'; return; }
  if (chessGame.status === 'draw') { chessStatusEl.textContent = 'Draw — insufficient material or the fifty-move rule.'; return; }
  if (chessBotThinking) { chessStatusEl.textContent = 'Bot is thinking…'; return; }
  const toMove = chessGame.turn === chessGame.playerColor ? 'Your move' : "Bot's move";
  const check = AtlasChess.isInCheck(chessGame, chessGame.turn) ? ' — check!' : '';
  chessStatusEl.textContent = toMove + ' (' + chessColorName(chessGame.turn) + ')' + check;
}

function renderChessAll() {
  renderChessBoard();
  renderChessCaptured();
  renderChessStatus();
}

// Task #201: a real minted reward for a real win. Gold scales with
// difficulty, and beating Hard also earns a one-off trophy keepsake. Reuses
// the exact same AtlasWallet.mintAsset() path the market's own Mine Gold
// stall uses (see handleInteractable's 'mint' branch) — chess stays
// scene-local right up until the instant it actually wins, at which point
// handing over a real signed credential is the whole point, so this is the
// one deliberate place chess reaches into the wallet. Keyed by the
// difficulty dropdown's value at the moment of victory, same as
// maybeTriggerChessBotMove() already reads it live rather than freezing it
// at "New game" time — difficulty has always been a live setting in this
// build, not something pinned to a given game.
const CHESS_WIN_REWARDS = {
  easy: { gold: 5 },
  medium: { gold: 10 },
  hard: { gold: 20, trophy: true }
};

// Fires once, right after a move that ends the game with the player as the
// winner — never on a draw, stalemate, or a bot win (see this function's two
// call sites below; the bot's own move-application site doesn't call this at
// all, since a side can never deliver checkmate to itself). No identity yet
// isn't an error here — chess never required one to play in the first place
// (see handleInteractable's 'open-chess' comment) — it just means there's
// nowhere to mint the reward into yet, so the visitor gets a plain note
// instead of a raw mint failure. `game` is captured up front and re-checked
// against the live chessGame after each await, so a visitor who starts a new
// game (or reopens later) while this is still in flight never has a stale
// result overwrite the wrong game's status line.
async function maybeAwardChessWin() {
  const game = chessGame;
  if (!game || game.status !== 'checkmate' || game.winner !== game.playerColor) return;
  const reward = CHESS_WIN_REWARDS[chessDifficultyInput.value];
  if (!reward) return;
  const identity = await AtlasWallet.getIdentity();
  if (chessGame !== game) return;
  if (!identity) {
    chessStatusEl.textContent += ' Create a wallet identity to claim your reward next time!';
    return;
  }
  try {
    const domain = manifestDomainOf(currentManifest);
    await AtlasWallet.mintAsset('self', domain, 'atlas.element.gold', reward.gold);
    let trophyNote = '';
    if (reward.trophy) {
      // Client-side dedupe, same spirit as handleInteractable's 'issue'
      // oncePerUser check — a trophy is a singular achievement, not
      // something repeated Hard wins should keep re-minting duplicates of.
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      const alreadyHasTrophy = wallet.some((e) => e.credential.asset.class === 'atlas.trophy.chess' && e.credential.issuer.domain === domain);
      if (!alreadyHasTrophy) {
        await AtlasWallet.mintAsset('self', domain, 'atlas.trophy.chess');
        trophyNote = ' + a trophy';
      }
    }
    await refreshInventoryDisplay();
    if (chessGame === game) chessStatusEl.textContent += ' You earned ' + reward.gold + ' gold' + trophyNote + '!';
  } catch (err) {
    if (chessGame === game) chessStatusEl.textContent += ' (Reward mint failed: ' + err.message + ')';
  }
}

function startNewChessGame() {
  chessGame = AtlasChess.createGame(chessPlayerColorInput.value);
  chessSelectedSquare = null;
  chessLegalTargets = [];
  chessPendingPromotion = null;
  chessPromotionPickerEl.classList.remove('active');
  chessBotThinking = false;
  renderChessAll();
  maybeTriggerChessBotMove();
}

function openChessModal() {
  chessModalEl.classList.add('active');
  if (!chessGame) startNewChessGame();
  else renderChessAll();
}

function closeChessModal() {
  chessModalEl.classList.remove('active');
}

// Runs the bot's move if it's currently the bot's turn — called after
// every real move (the player's, or "New game" when the player chose to
// play Black) so the bot always replies on its own, with no separate
// "bot's turn" button to click. The setTimeout(0)-ish delay (rather than
// calling AtlasChess.getBotMove() synchronously in the same tick) exists
// so "Bot is thinking…" actually paints before the search runs — the
// search itself is still a single synchronous, blocking call with no
// worker thread behind it (see chess.js's own comment on why Hard is
// capped at depth 3 specifically so that block stays short).
function maybeTriggerChessBotMove() {
  if (!chessGame || chessGame.status !== 'active') return;
  if (chessGame.turn === chessGame.playerColor) return;
  chessBotThinking = true;
  renderChessStatus();
  setTimeout(() => {
    if (!chessGame || chessGame.status !== 'active') { chessBotThinking = false; return; }
    const move = AtlasChess.getBotMove(chessGame, chessDifficultyInput.value);
    chessBotThinking = false;
    if (!move) { renderChessAll(); return; } // shouldn't happen — finalizeStatus would already have ended the game
    chessGame = AtlasChess.makeMove(chessGame, move);
    renderChessAll();
  }, 30);
}

function handleChessSquareClick(square) {
  if (!chessGame || chessGame.status !== 'active') return;
  if (chessBotThinking || chessPendingPromotion) return;
  if (chessGame.turn !== chessGame.playerColor) return; // not your move — clicks are inert

  if (chessSelectedSquare !== null) {
    const target = chessLegalTargets.find((m) => m.to === square);
    if (target) {
      if (target.needsPromotion) {
        chessPendingPromotion = { from: target.from, to: target.to };
        chessPromotionPickerEl.classList.add('active');
        return;
      }
      chessGame = AtlasChess.makeMove(chessGame, target);
      chessSelectedSquare = null;
      chessLegalTargets = [];
      renderChessAll();
      maybeTriggerChessBotMove();
      maybeAwardChessWin();
      return;
    }
  }
  // Clicking your own piece (nothing was selected yet, or re-clicking a
  // different piece of your own) reselects; clicking the already-selected
  // square, an empty square, or an opponent piece with no legal capture
  // there just clears the selection — there's no explicit "deselect"
  // control, this covers every case that isn't "make the move."
  const piece = chessGame.board[square];
  if (piece && AtlasChess.colorOf(piece) === chessGame.playerColor) {
    chessSelectedSquare = square;
    chessLegalTargets = AtlasChess.getLegalMovesFrom(chessGame, square);
  } else {
    chessSelectedSquare = null;
    chessLegalTargets = [];
  }
  renderChessBoard();
}

chessBoardEl.addEventListener('click', (e) => {
  const squareEl = e.target.closest('.chess-square');
  if (!squareEl) return;
  handleChessSquareClick(Number(squareEl.dataset.square));
});

chessPromotionPickerEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-promo]');
  if (!btn || !chessPendingPromotion) return;
  const { from, to } = chessPendingPromotion;
  chessPendingPromotion = null;
  chessPromotionPickerEl.classList.remove('active');
  chessGame = AtlasChess.makeMove(chessGame, { from, to, promotion: btn.dataset.promo });
  chessSelectedSquare = null;
  chessLegalTargets = [];
  renderChessAll();
  maybeTriggerChessBotMove();
  maybeAwardChessWin();
});

chessNewGameBtn.addEventListener('click', startNewChessGame);
chessCloseBtn.addEventListener('click', closeChessModal);

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
  const assetClass = giveawayClassFor(world);
  // Defensive re-check: the button's disabled state already reflects this
  // (see refreshRequestButton), but a click event queued right before a
  // refresh could still slip through, same double-click concern
  // handleInteractable() guards against for stalls. A null assetClass here
  // (nothing concrete left to give away — task #152's wildcard categories
  // made this newly possible) is the same defensive shape: the button
  // should already be disabled/relabeled by refreshRequestButton, so this
  // is a courtesy no-op, not a new failure mode.
  if (!assetClass) {
    statusEl.textContent = 'This world issues nothing.';
    await refreshRequestButton();
    return;
  }
  // Task #63, scoped: same identity-wait pattern as handleInteractable()
  // above, checked before alreadyHasRequestableItem() below — that check
  // already treats "no identity" as "haven't collected it yet" (see its
  // own comment), which would otherwise let a locked visitor race straight
  // into a failed mint attempt instead of being prompted first.
  if (effectiveIdentityRequired(currentManifest, world) && !(await AtlasWallet.getIdentity())) {
    if (!(await waitForIdentityViaWallet())) return;
  }
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
// note in enterWorld). Two actions exist today: "mint" (does exactly what
// the Settings-panel mine buttons above do, just triggered by clicking
// the stall itself instead of opening the wallet) and "open-chess" (task
// #195 — opens the chess modal; see that section further down). The busy
// guard exists because — unlike a portal (leaves the scene) or a dropped
// item (removes its own marker once picked up) — a stall stays put and
// stays clickable, so nothing else stops a fast double-click from firing
// two mints (or two modal-opens) at once.
async function handleInteractable(marker) {
  if (interactableBusy) return;
  interactableBusy = true;
  try {
    // Chess needs no identity at all — unlike every other interactable
    // here, it never touches the wallet, so it deliberately skips the
    // identityRequired gate just below rather than making a visitor
    // create or unlock an identity just to play a local minigame.
    if (marker.action === 'open-chess') { openChessModal(); return; }
    // Task #63, scoped: inside a world that requires identity, a locked
    // wallet shouldn't just fail this click with an error message the way
    // it would in any ordinary world (see the 'issue' branch's own
    // pre-existing "Create an identity first." throw below) — open the
    // wallet and wait, then carry on with the actual action once one
    // exists, no second click needed. An ordinary (non-identityRequired)
    // world is untouched — this only ever fires when the world itself
    // demands it.
    if (effectiveIdentityRequired(currentManifest, currentWorld) && !(await AtlasWallet.getIdentity())) {
      if (!(await waitForIdentityViaWallet())) return; // cancelled — leave the stall exactly as it was
    }
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
  refreshChatIdentity(); // an auto-lock should drop chat back to anonymous immediately too, same as the manual lock paths
  // Same re-routing the two manual lock buttons already trigger (Settings'
  // Lock wallet, and the top-bar Quick lock) — if the panel's open to a
  // screen that only makes sense unlocked, route it to wherever locking
  // now actually leads, so all three ways of locking behave consistently.
  if (walletPanel.classList.contains('open')) await routeWalletScreen();
}, AUTO_LOCK_CHECK_INTERVAL_MS);

refreshIdentityDisplay();
refreshInventoryDisplay();
refreshMailDisplay();
AtlasWallet.getChatPanelSettings().then(applyChatPanelSize); // restore the chat panel's persisted size/opacity/text-size/minimized state before any world is entered
AtlasWallet.getAssetViewerSettings().then(applyAssetViewerSettings); // restore the Asset Viewer panel's persisted size/opacity/text-size, same reasoning
refreshChatSendability();

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
