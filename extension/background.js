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
// case (a detected manifest's own Enter-Space button) is unrelated and
// unchanged: that one still needs the full tab, since a real 3D/2D scene
// is about to render there.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
