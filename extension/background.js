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
importScripts('wallet.js');

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab || typeof sender.tab.id !== 'number') return;
  const tabId = sender.tab.id;
  if (message && message.type === 'domain-atlas-world-entered') {
    chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    // chrome.sidePanel.close() (Chrome 141+) closes one already open for
    // this tab outright, covering the rarer case where the visitor opened
    // the side panel first and only then entered a world from the same
    // tab — setOptions({enabled:false}) alone only stops it from being
    // opened/reopened from here on, not a panel that's already showing.
    if (chrome.sidePanel.close) chrome.sidePanel.close({ tabId }).catch(() => {});
  } else if (message && message.type === 'domain-atlas-world-exited') {
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
    AtlasWallet.getIdentity().then((identity) => {
      sendResponse({ publicKey: identity ? identity.publicKey : null });
    }).catch(() => {
      sendResponse({ publicKey: null });
    });
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
    // message.origin on the ACTIVE identity's own trusted-offer-domains
    // list. {trusted:false} (no active identity, or this origin was never
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
    (async () => {
      try {
        const identity = await AtlasWallet.getIdentity();
        if (!identity) { sendResponse({ trusted: false }); return; }
        const trusted = await AtlasWallet.isTrustedBridgeDomain(identity.publicKey, message.origin);
        if (!trusted) { sendResponse({ trusted: false }); return; }
        const entry = await AtlasWallet.queueBridgeOffer(identity.publicKey, message.origin, message.credential);
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
