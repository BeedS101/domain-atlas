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

chrome.runtime.onMessage.addListener((message, sender) => {
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
  }
});
