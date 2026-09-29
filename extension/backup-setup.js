// Runs the automatic-backup consent/picker flow from a real top-level
// extension window instead of the cross-origin iframe the rest of the
// wallet panel lives in — see wallet.js's own top comment on the
// "automatic encrypted local backup replication" section for why the File
// System Access API's picker methods specifically require that (there is
// no Permissions-Policy delegation for it the way iframe.allow covers
// WebAuthn). Opened via chrome.windows.create() from viewer.js, same
// pattern identity-popup.js already established — no window.opener, no
// postMessage back; viewer.js instead notices the change via
// chrome.storage.onChanged, which works regardless of how this window was
// opened, and this window's own status area is all the feedback the
// person needs before closing it.

const setupScreen = document.getElementById('setupScreen');
const blockedScreen = document.getElementById('blockedScreen');
const doneScreen = document.getElementById('doneScreen');
const confirmPasswordInput = document.getElementById('confirmPasswordInput');
const chooseFileBtn = document.getElementById('chooseFileBtn');
const skipBtn = document.getElementById('skipBtn');
const statusEl = document.getElementById('status');
const doneText = document.getElementById('doneText');
const closeBtn = document.getElementById('closeBtn');

function setStatus(message, cls) {
  statusEl.className = cls || '';
  statusEl.textContent = message || '';
}

(async () => {
  if (!window.showSaveFilePicker) {
    setupScreen.classList.add('hidden');
    blockedScreen.classList.remove('hidden');
    blockedScreen.querySelector('h1').textContent = 'Not supported in this browser';
    blockedScreen.querySelector('p').textContent =
      'Automatic backup needs the File System Access API, which this browser build doesn’t offer. ' +
      'Use Settings → Full backup for a manual export/import instead.';
    return;
  }
  const identity = await AtlasWallet.getIdentity();
  if (!identity || identity.mode !== 'local') {
    setupScreen.classList.add('hidden');
    blockedScreen.classList.remove('hidden');
    return;
  }
})();

skipBtn.addEventListener('click', () => {
  window.close();
});

chooseFileBtn.addEventListener('click', async () => {
  const password = confirmPasswordInput.value;
  if (!password) {
    setStatus('Enter your wallet password first.', 'error');
    return;
  }
  chooseFileBtn.disabled = true;
  skipBtn.disabled = true;
  setStatus('Opening the file picker…');
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: 'atlas-wallet-backup.json',
      types: [{ description: 'Atlas wallet backup', accept: { 'application/json': ['.json'] } }]
    });
  } catch (err) {
    // AbortError just means the person closed/cancelled the native
    // picker — not a real failure, back to the same screen either way.
    chooseFileBtn.disabled = false;
    skipBtn.disabled = false;
    if (err && err.name !== 'AbortError') setStatus('Could not open the file picker: ' + err.message, 'error');
    else setStatus('');
    return;
  }

  setStatus('Turning on automatic backup…');
  try {
    const result = await AtlasWallet.setUpAutoBackup(handle, password);
    setupScreen.classList.add('hidden');
    doneScreen.classList.remove('hidden');
    doneText.textContent = 'Saving to "' + (result.fileName || handle.name) +
      '". It will stay up to date on its own from now on — you can close this tab.';
  } catch (err) {
    chooseFileBtn.disabled = false;
    skipBtn.disabled = false;
    setStatus(err.message, 'error');
  }
});

closeBtn.addEventListener('click', () => window.close());
