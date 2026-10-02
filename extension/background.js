// Domain Atlas — background service worker
//
// Only job: a toolbar-button click opens the wallet on whatever page is
// currently active, independent of whether that page declares a spatial
// manifest at all. A service worker has no DOM of its own to show
// anything in, so this just asks content.js (already injected on every
// page via manifest.json's content_scripts) to open its overlay — the
// same overlay a detected manifest's own entry button already opens,
// just without a manifest to go with it. content.js/viewer.js own the
// rest of what "no manifest" actually looks like.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  // A page the content script never loaded on (chrome://, the extension
  // gallery, a tab still mid-navigation) has nothing listening on the
  // other end — sendMessage rejects, not throws, and there's nothing
  // useful to do about it from here, so this is deliberately silent
  // rather than surfacing an error for something the user can't act on.
  chrome.tabs.sendMessage(tab.id, { type: 'domain-atlas-open-wallet' }).catch(() => {});
});
