// Runs identity creation from a real top-level extension window instead of
// the cross-origin iframe the rest of the wallet panel lives in. See the
// note in content.js's openOverlay() for why the iframe needs its own
// Permissions-Policy delegation just to use WebAuthn at all — this file
// exists because delegation is not the whole story: a page's WebAuthn
// ceremony can still be limited to roaming (security-key) authenticators
// only, with no platform (Windows Hello / Touch ID) option offered, when
// the calling document isn't a genuine top-level browsing context. A
// window opened with chrome.windows.create() (see viewer.js), even from
// inside that iframe, is one.
//
// This window is opened via chrome.windows.create() from viewer.js, not
// window.open() — that's what gives it real chrome.storage/chrome.runtime
// bindings. It has no window.opener, so it doesn't try to message one back;
// viewer.js instead notices the new identity via chrome.storage.onChanged,
// which works regardless of how this window was opened.

const createBtn = document.getElementById('createBtn');
const statusEl = document.getElementById('status');

createBtn.addEventListener('click', async () => {
  createBtn.disabled = true;
  statusEl.className = '';
  statusEl.textContent = 'Waiting for your authenticator…';
  try {
    await AtlasWallet.createIdentity();
    statusEl.className = 'ok';
    statusEl.textContent = 'Identity created — you can close this tab.';
    setTimeout(() => window.close(), 900);
  } catch (err) {
    statusEl.className = 'error';
    statusEl.textContent = 'No authenticator available: ' + err.message;
    createBtn.disabled = false;
  }
});
