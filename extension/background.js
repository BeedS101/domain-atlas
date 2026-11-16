// Domain Atlas — background service worker
//
// Only job: make the toolbar button open the wallet as a real Chrome side
// panel, docked beside whatever page is active rather than drawn over it.
// setPanelBehavior with openPanelOnActionClick is the whole implementation:
// Chrome itself then wires the action icon to toggle the panel open/closed,
// no onClicked listener or message-passing to content.js needed for this
// at all.
// viewer.html (manifest.json's side_panel.default_path) loads with no
// manifest/world/anchor query params in this context — viewer.js's own
// "no manifest" branch (see its own comments) is what that boots into.
//
// This replaced an earlier content-script-injected overlay for the same
// "no manifest" case, which could only ever draw IN FRONT of the page —
// an overlay is paint order, not layout, so it structurally could never
// avoid covering content the way a real side panel does. The in-world
// case (a detected manifest's own Enter-Space button) still uses that
// full-tab overlay, since a real 3D/2D scene needs the whole tab — but
// openPanelOnActionClick is a GLOBAL behavior, with no awareness of
// that overlay already covering the tab. Left alone, the toolbar icon
// would still toggle the side panel open on top of a world the visitor
// already entered, which is exactly the thing a side panel is supposed
// to avoid doing to a page's own content.
//
// content.js tells this script when a tab enters/exits that full-tab
// overlay so the side panel can be disabled for exactly that tab for
// exactly that long — chrome.sidePanel has no access from a content
// script's own context, so this relay is the only way for it to act on
// what content.js already knows.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Toolbar icon: grey/crossed-out until there's an active wallet identity to
// use, colored once there is — the same yes/no wallet.js's own isUnlocked()
// already answers for every other "is self usable right now" check (true
// for a WebAuthn identity the moment it exists, true for a local-password
// identity only once unlocked this session). importScripts pulls wallet.js
// in here just for that read; nothing in the isUnlocked() call path touches
// navigator.credentials (only createWebAuthnIdentity() and the sign/assert
// functions do), so it's safe to call from a service worker with no window.
// This is extension-wide state, not a per-tab one, so a plain setIcon with
// no tabId is all that's needed.
importScripts('item-standard.js', 'item-effects.js', 'services-core.js', 'wallet.js');
// Calling is optional: if its module is missing or fails to load, the wallet worker still starts
// and every other feature works (the call functions then report that calling is unavailable).
try { importScripts('call-protocol.js'); } catch (err) { /* calling stays unavailable */ }

const TOOLBAR_ICON_ACTIVE = {
  16: 'icons/icon-16.png', 32: 'icons/icon-32.png',
  48: 'icons/icon-48.png', 128: 'icons/icon-128.png'
};
const TOOLBAR_ICON_LOCKED = {
  16: 'icons/icon-locked-16.png', 32: 'icons/icon-locked-32.png',
  48: 'icons/icon-locked-48.png', 128: 'icons/icon-locked-128.png'
};

async function refreshToolbarIcon() {
  const unlocked = await AtlasWallet.isUnlocked();
  chrome.action.setIcon({ path: unlocked ? TOOLBAR_ICON_ACTIVE : TOOLBAR_ICON_LOCKED }).catch(() => {});
}

refreshToolbarIcon();

// Covers every way the active identity can change — created, unlocked,
// locked, or switched between local/WebAuthn — without this file needing
// to know each call site: all of them land in one of these three keys.
chrome.storage.onChanged.addListener((changes, areaName) => {
  const watchedKeys = areaName === 'session'
    ? ['atlasUnlockedIdentity']
    : areaName === 'local'
      ? ['atlasIdentityMode', 'atlasIdentity', 'atlasWebAuthnIdentity']
      : [];
  if (watchedKeys.some((key) => key in changes)) refreshToolbarIcon();
});

// Wallet-bridge confirmations (SPEC.md §3.8.1/§3.8.2/§3.8.3) are shown in a window of their own, opened here with
// chrome.windows.create(). The requesting page has no element in it, so no CSS, script, focus or DOM operation of its
// can cover, restyle, navigate, remove or answer the prompt. content.js only asks for one and later hears the outcome.
//
// Each request is filed under a random token this file generates. The prompt page reads it back once by the token in its
// own URL, and the answer travels from that page to this file to the requesting tab, never through anything the page can
// send to. The requesting origin is taken from the sender Chrome reports, never from anything the page can influence.
// Pending requests are kept in session storage, because a service worker can stop while a person is still deciding.
const BRIDGE_CONFIRM_KEY = 'atlasBridgeConfirms';
const BRIDGE_CONFIRM_TTL_MS = 150000;
const BRIDGE_CONFIRM_BUY_TTL_MS = 900000;
const BRIDGE_CONFIRM_MAX_PENDING = 3;
const BRIDGE_CONFIRM_MAX_PAYLOAD_CHARS = 500000;
const BRIDGE_CONFIRM_WIDTH = 460;
const BRIDGE_CONFIRM_HEIGHT = 680;
// An origin whose prompts are declined or closed again and again is refused new ones for a while, so a page cannot keep
// opening windows; the first few refusals cost nothing, so an ordinary retry is never held up.
const BRIDGE_CONFIRM_FREE_DENIALS = 5;
const BRIDGE_CONFIRM_COOLDOWN_BASE_MS = 5000;
const BRIDGE_CONFIRM_COOLDOWN_MAX_MS = 120000;
const BRIDGE_CONFIRM_DENIAL_MEMORY_MS = 60000;
const bridgeConfirmDenials = new Map();
let bridgeConfirmChain = Promise.resolve();

// Serialized read-modify-write over the pending map.
function withBridgeConfirms(fn) {
  const run = bridgeConfirmChain.then(async () => {
    const stored = await chrome.storage.session.get(BRIDGE_CONFIRM_KEY);
    const map = stored[BRIDGE_CONFIRM_KEY] && typeof stored[BRIDGE_CONFIRM_KEY] === 'object' ? stored[BRIDGE_CONFIRM_KEY] : {};
    const out = await fn(map);
    await chrome.storage.session.set({ [BRIDGE_CONFIRM_KEY]: map });
    return out;
  });
  bridgeConfirmChain = run.catch(() => {});
  return run;
}

function senderOrigin(sender) {
  if (sender.origin && sender.origin !== 'null') return sender.origin;
  try { return new URL(sender.url).origin; } catch (err) { return null; }
}

function bridgeConfirmCooldownMs(origin, nowMs) {
  const record = bridgeConfirmDenials.get(origin);
  if (!record) return 0;
  if (nowMs - record.lastAtMs > BRIDGE_CONFIRM_DENIAL_MEMORY_MS) { bridgeConfirmDenials.delete(origin); return 0; }
  return Math.max(0, record.untilMs - nowMs);
}

function noteBridgeConfirmOutcome(origin, approved, nowMs) {
  if (approved) { bridgeConfirmDenials.delete(origin); return; }
  const prior = bridgeConfirmDenials.get(origin);
  const count = prior && nowMs - prior.lastAtMs <= BRIDGE_CONFIRM_DENIAL_MEMORY_MS ? prior.count + 1 : 1;
  const over = count - BRIDGE_CONFIRM_FREE_DENIALS + 1;
  const wait = over > 0 ? Math.min(BRIDGE_CONFIRM_COOLDOWN_MAX_MS, BRIDGE_CONFIRM_COOLDOWN_BASE_MS * Math.pow(2, over - 1)) : 0;
  bridgeConfirmDenials.set(origin, { count, lastAtMs: nowMs, untilMs: nowMs + wait });
}

function validBridgeConfirmRequest(message) {
  const kind = message.kind;
  if (kind !== 'sign' && kind !== 'offer' && kind !== 'buy' && kind !== 'identity') return false;
  if (kind === 'buy' && !(message.payload && typeof message.payload.domain === 'string' && /^[0-9a-f]{32}$/.test(String(message.payload.coinId)))) return false;
  let size = 0;
  try { size = JSON.stringify(message.payload === undefined ? null : message.payload).length + JSON.stringify(message.detail === undefined ? '' : message.detail).length; } catch (err) { return false; }
  return size <= BRIDGE_CONFIRM_MAX_PAYLOAD_CHARS;
}

// Tells the requesting tab how its request ended and closes the prompt window.
async function settleBridgeConfirm(entry, approved, result) {
  noteBridgeConfirmOutcome(entry.origin, approved, Date.now());
  try {
    await chrome.tabs.sendMessage(entry.tabId, { type: 'domain-atlas-bridge-confirm-result', token: entry.token, approved: !!approved, result: approved ? (result || null) : null }, { frameId: 0 });
  } catch (err) {
    // The tab is gone or reloaded; nobody is waiting for the answer.
  }
  if (typeof entry.windowId === 'number') chrome.windows.remove(entry.windowId).catch(() => {});
}

// Ends every pending request matching `test`, as declined when `notify` is set.
async function dropBridgeConfirms(test, notify) {
  let dropped = [];
  try {
    dropped = await withBridgeConfirms((map) => {
      const out = [];
      for (const [token, entry] of Object.entries(map)) {
        if (test(entry)) { out.push(entry); delete map[token]; }
      }
      return out;
    });
  } catch (err) {
    return;
  }
  for (const entry of dropped) {
    if (notify) await settleBridgeConfirm(entry, false, null);
    else if (typeof entry.windowId === 'number') chrome.windows.remove(entry.windowId).catch(() => {});
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  dropBridgeConfirms((entry) => entry.windowId === windowId, true);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  dropBridgeConfirms((entry) => entry.tabId === tabId, false);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A page that navigates or reloads can no longer receive the answer, so the prompt for it goes away.
  if (changeInfo.status === 'loading') dropBridgeConfirms((entry) => entry.tabId === tabId, false);
});

function openBridgeConfirmWindow(token, parentWindowId) {
  return (async () => {
    const options = { url: chrome.runtime.getURL('confirm-bridge.html') + '#' + token, type: 'popup', width: BRIDGE_CONFIRM_WIDTH, height: BRIDGE_CONFIRM_HEIGHT, focused: true };
    try {
      const parent = await chrome.windows.get(parentWindowId);
      if (parent && typeof parent.left === 'number' && typeof parent.top === 'number' && parent.width && parent.height) {
        options.left = Math.max(0, Math.round(parent.left + (parent.width - BRIDGE_CONFIRM_WIDTH) / 2));
        options.top = Math.max(0, Math.round(parent.top + Math.min(80, (parent.height - BRIDGE_CONFIRM_HEIGHT) / 2)));
      }
    } catch (err) {
      // No position to centre on; the browser picks one.
    }
    const win = await chrome.windows.create(options);
    return win && typeof win.id === 'number' ? win.id : null;
  })();
}

// The Services tab asks which site the person is looking at. Only the wallet's own pages are answered, and only with the origin of
// an http(s) page: no path, query or title leaves the browser's own record of the tab.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'services-current-site') return;
  const own = chrome.runtime.getURL('');
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string' || !sender.url.startsWith(own)) { sendResponse({ ok: false }); return; }
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
    let origin = null;
    try {
      const u = new URL(tabs && tabs[0] && tabs[0].url ? tabs[0].url : '');
      if (u.protocol === 'https:' || u.protocol === 'http:') origin = u.origin;
    } catch (err) { origin = null; }
    sendResponse({ ok: true, origin });
  }).catch(() => sendResponse({ ok: false }));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab || typeof sender.tab.id !== 'number') return;
  const tabId = sender.tab.id;
  const ownPage = chrome.runtime.getURL('confirm-bridge.html');
  const fromPrompt = typeof sender.url === 'string' && sender.url.split('#')[0] === ownPage;
  if (message && message.type === 'domain-atlas-bridge-confirm-open') {
    // From content.js, which runs only in a tab's top frame.
    const origin = senderOrigin(sender);
    if (sender.frameId !== 0 || !origin || /^chrome-extension:/.test(origin) || !validBridgeConfirmRequest(message)) {
      sendResponse({ ok: false });
      return;
    }
    (async () => {
      const nowMs = Date.now();
      if (bridgeConfirmCooldownMs(origin, nowMs) > 0) { sendResponse({ ok: false, reason: 'cooldown' }); return; }
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      // The payload is kept as JSON text: session storage keeps objects with their keys re-ordered.
      const entry = { token, tabId, origin, kind: message.kind, detailJson: JSON.stringify(message.detail === undefined ? '' : message.detail), payloadJson: JSON.stringify(message.payload === undefined ? null : message.payload), fetched: false, windowId: null, expiresAtMs: nowMs + (message.kind === 'buy' ? BRIDGE_CONFIRM_BUY_TTL_MS : BRIDGE_CONFIRM_TTL_MS) };
      const room = await withBridgeConfirms((map) => {
        const stale = [];
        for (const [t, e] of Object.entries(map)) {
          if (e.expiresAtMs <= nowMs) { stale.push(e); delete map[t]; }
        }
        for (const e of stale) if (typeof e.windowId === 'number') chrome.windows.remove(e.windowId).catch(() => {});
        const pending = Object.values(map);
        if (pending.length >= BRIDGE_CONFIRM_MAX_PENDING || pending.some((e) => e.tabId === tabId)) return false;
        map[token] = entry;
        return true;
      });
      if (!room) { sendResponse({ ok: false, reason: 'busy' }); return; }
      let windowId = null;
      try {
        windowId = await openBridgeConfirmWindow(token, sender.tab.windowId);
      } catch (err) {
        windowId = null;
      }
      if (windowId === null) {
        await withBridgeConfirms((map) => { delete map[token]; });
        sendResponse({ ok: false });
        return;
      }
      const stillPending = await withBridgeConfirms((map) => {
        if (!map[token]) return false;
        if (map[token].windowId === null) map[token].windowId = windowId;
        return true;
      });
      if (!stillPending) chrome.windows.remove(windowId).catch(() => {});
      sendResponse({ ok: stillPending, token });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  } else if (message && message.type === 'domain-atlas-bridge-confirm-fetch') {
    // From the prompt window only. One read per token, and only from the window opened for it.
    (async () => {
      const entry = await withBridgeConfirms((map) => {
        const e = typeof message.token === 'string' ? map[message.token] : null;
        if (!e || e.fetched || e.expiresAtMs <= Date.now() || !fromPrompt || (e.windowId !== null && e.windowId !== sender.tab.windowId)) return null;
        e.fetched = true;
        if (e.windowId === null) e.windowId = sender.tab.windowId;
        return e;
      });
      sendResponse(entry ? { ok: true, origin: entry.origin, kind: entry.kind, detail: JSON.parse(entry.detailJson), payload: JSON.parse(entry.payloadJson) } : { ok: false });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  } else if (message && message.type === 'domain-atlas-bridge-confirm-decision') {
    // From the prompt window only: the visitor's answer, passed on to the tab that asked.
    (async () => {
      const entry = await withBridgeConfirms((map) => {
        const e = typeof message.token === 'string' ? map[message.token] : null;
        if (!e || !e.fetched || !fromPrompt || e.windowId !== sender.tab.windowId) return null;
        delete map[message.token];
        return e;
      });
      if (entry) await settleBridgeConfirm(entry, message.approved === true, message.result);
      sendResponse({ ok: !!entry });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  } else if (message && message.type === 'domain-atlas-bridge-confirm-cancel') {
    // From content.js when it stops waiting (its own backstop timeout).
    dropBridgeConfirms((e) => e.token === message.token && e.tabId === tabId && sender.frameId === 0, false);
    sendResponse({ ok: true });
    return;
  }
  if (message && message.type === 'domain-atlas-world-entered') {
    chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    // chrome.sidePanel.close() (Chrome 141+) closes one already open for
    // this tab outright, covering the rarer case where the visitor opened
    // the side panel first and only then entered a world from the same
    // tab — setOptions({enabled:false}) alone only stops it from being
    // opened/reopened from here on, not a panel that's already showing.
    if (chrome.sidePanel.close) chrome.sidePanel.close({ tabId }).catch(() => {});
  } else if (message && (message.type === 'domain-atlas-world-exited' || message.type === 'domain-atlas-page-loaded')) {
    chrome.sidePanel.setOptions({ tabId, enabled: true, path: 'viewer.html' }).catch(() => {});
  } else if (message && message.type === 'domain-atlas-bridge-read') {
    // SPEC.md §3.8 — content.js already checked this page's own manifest-
    // declared policy.walletBridge.read before ever sending this; this
    // file's only job is the one thing it has that content.js never could
    // (AtlasWallet, imported above for the toolbar icon): the actual active
    // identity, read exactly the same way refreshToolbarIcon() already
    // does. Read-only, SPEC.md §3.8's own explicit scope — nothing here
    // signs or mints anything.
    //
    // Explicit sendResponse() + return true, not a bare returned promise —
    // a returned promise was observed (live, in test/manual-page-wallet-
    // bridge.js) to sometimes resolve to undefined on the sender's side even
    // though this handler's own promise went on to resolve correctly a few
    // ms later: the sender's message port had already closed by then. The
    // explicit callback form is the older, more conservative contract and
    // doesn't share that race.
    //
    // The answer is the identity bound to the sender's exact origin, never the one the wallet window is
    // showing. A site that still has to be asked gets no identity until the person chooses.
    (async () => {
      try {
        const origin = senderOrigin(sender);
        if (!origin || sender.frameId !== 0) { sendResponse({ publicKey: null }); return; }
        const site = await AtlasWallet.getSiteIdentity(origin);
        sendResponse({ publicKey: site.state === 'bound' || site.state === 'default' ? site.publicKey : null });
      } catch (err) {
        sendResponse({ publicKey: null });
      }
    })();
    return true;
  } else if (message && message.type === 'domain-atlas-bridge-site-identity') {
    // Which identity answers this site: lets content.js open the first-contact prompt before anything else when
    // the person still has to choose. Carries no key material.
    (async () => {
      try {
        const origin = senderOrigin(sender);
        if (!origin || sender.frameId !== 0) { sendResponse({ state: 'denied' }); return; }
        const site = await AtlasWallet.getSiteIdentity(origin);
        sendResponse({ state: site.state, publicKey: site.publicKey || null });
      } catch (err) {
        sendResponse({ state: 'denied' });
      }
    })();
    return true;
  } else if (message && message.type === 'domain-atlas-bridge-preview-dock') {
    // SPEC.md §3.8.5 — which screen corner the visitor docked the world
    // Previewer in; content.js puts a page-supplied preview in the same one.
    AtlasWallet.getPreviewerWindowSettings().then((settings) => {
      sendResponse({ dock: settings.dock });
    }).catch(() => {
      sendResponse({ dock: 'bottom-left' });
    });
    return true;
  } else if (message && message.type === 'domain-atlas-bridge-offer-trusted') {
    // SPEC.md §3.8.3 — content.js already checked message.credential's
    // asset.class against this page's own effective policy.walletBridge.
    // offer whitelist before ever sending this; this file's only job is
    // the one thing it has that content.js never could (AtlasWallet): is
    // the sender's origin (as Chrome reports it) on that site's identity's
    // own trusted-offer-domains list. {trusted:false} (no active identity, or this origin was never
    // trusted for it) tells content.js to fall through to the ordinary
    // confirmation overlay, unchanged from §3.8.2 — this is deliberately
    // the only outcome on any failure path below, never a third shape
    // content.js would need to special-case.
    //
    // {trusted:true} means this file does the rest itself, right here,
    // with no UI at all — every extension context with AtlasWallet access
    // already has the same unrestricted queueBridgeOffer/claimBridgeOffer
    // access (see confirm-bridge.js's own, visitor-driven version of this
    // exact two-call sequence); skipping the prompt is the whole point of
    // being trusted, so there is nothing left for a human to decide here.
    const origin = senderOrigin(sender);
    (async () => {
      try {
        // The site's own identity, not the one the wallet window is showing.
        const site = origin && sender.frameId === 0 ? await AtlasWallet.getSiteIdentity(origin) : null;
        const identity = site && (site.state === 'bound' || site.state === 'default') ? { publicKey: site.publicKey } : null;
        if (!identity) { sendResponse({ trusted: false }); return; }
        const trusted = await AtlasWallet.isTrustedBridgeDomain(identity.publicKey, origin);
        if (!trusted) { sendResponse({ trusted: false }); return; }
        const entry = await AtlasWallet.queueBridgeOffer(identity.publicKey, origin, message.credential);
        try {
          const { verdict } = await AtlasWallet.claimBridgeOffer(identity.publicKey, entry.id);
          sendResponse({ trusted: true, claimed: !!verdict.valid, offerId: entry.id });
        } catch (err) {
          // Queued fine but the real verification failed (a malformed or
          // forged credential, say) — the visitor already decided this
          // domain doesn't need asking, so this stays silent to the page
          // rather than falling back to a prompt now; it's recorded in
          // getBridgeOffers() same as any other queued-but-unclaimed entry.
          sendResponse({ trusted: true, claimed: false, offerId: entry.id });
        }
      } catch (err) {
        sendResponse({ trusted: false });
      }
    })();
    return true;
  }
});
