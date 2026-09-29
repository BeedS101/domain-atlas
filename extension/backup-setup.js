// Runs the automatic-backup consent/picker flow — and now also the
// ongoing "keep this open" and reconnect flows — from a real top-level
// extension window instead of the cross-origin iframe the rest of the
// wallet panel lives in. See wallet.js's own top comment on the
// "automatic encrypted local backup replication" section for why the File
// System Access API's picker and permission methods specifically require
// a real top-level page (there is no Permissions-Policy delegation for it
// the way iframe.allow covers WebAuthn) — and why, as a direct
// consequence, this same window has to stay open for every later silent
// write too, not just the first one: wallet.js's IS_AUTO_BACKUP_WRITER_CONTEXT
// gates real writes to exactly this page. Opened via chrome.windows.create()
// from viewer.js, same pattern identity-popup.js already established — no
// window.opener, no postMessage back; viewer.js instead notices changes via
// chrome.storage.onChanged and this page's own heartbeat, which both work
// regardless of how this window was opened.

const setupScreen = document.getElementById('setupScreen');
const blockedScreen = document.getElementById('blockedScreen');
const reconnectScreen = document.getElementById('reconnectScreen');
const doneScreen = document.getElementById('doneScreen');
const confirmPasswordInput = document.getElementById('confirmPasswordInput');
const chooseFileBtn = document.getElementById('chooseFileBtn');
const skipBtn = document.getElementById('skipBtn');
const statusEl = document.getElementById('status');
const doneTitle = document.getElementById('doneTitle');
const doneText = document.getElementById('doneText');
const minimizeBtn = document.getElementById('minimizeBtn');
const closeBtn = document.getElementById('closeBtn');
const reconnectBtn = document.getElementById('reconnectBtn');
const reconnectReasonText = document.getElementById('reconnectReasonText');
const reconnectStatusEl = document.getElementById('reconnectStatus');

// This window is designed to stay open (minimized) indefinitely so silent
// backup writes keep working — see the top comment above. Minimizing used
// to be manual-only, which meant a copy of this window could sit forgotten
// on screen at full size for as long as nobody clicked the button. Once
// the "keep this open" screen is showing, there's nothing left for a
// person to do here, so auto-minimize after a short delay instead of
// waiting on a click; the button stays for anyone who wants it sooner.
const AUTO_MINIMIZE_DELAY_MS = 4000;
let autoMinimizeTimer = null;

function minimizeThisWindow() {
  if (autoMinimizeTimer) {
    clearTimeout(autoMinimizeTimer);
    autoMinimizeTimer = null;
  }
  if (!chrome.windows || !chrome.windows.getCurrent) { window.blur(); return; }
  chrome.windows.getCurrent((win) => {
    if (win && win.id !== undefined) chrome.windows.update(win.id, { state: 'minimized' });
  });
}

function showOnly(screen) {
  for (const el of [setupScreen, blockedScreen, reconnectScreen, doneScreen]) {
    if (el) el.classList.toggle('hidden', el !== screen);
  }
}

function setStatus(message, cls, target) {
  const el = target || statusEl;
  if (!el) return;
  el.className = cls || '';
  el.textContent = message || '';
}

function showKeepOpenScreen(fileName) {
  showOnly(doneScreen);
  doneTitle.textContent = 'Automatic backup is on';
  doneText.textContent = fileName
    ? 'Saving to "' + fileName + '". It stays up to date on its own from here.'
    : 'It stays up to date on its own from here.';
  if (autoMinimizeTimer) clearTimeout(autoMinimizeTimer);
  autoMinimizeTimer = setTimeout(minimizeThisWindow, AUTO_MINIMIZE_DELAY_MS);
}

(async () => {
  if (!window.showSaveFilePicker) {
    showOnly(blockedScreen);
    blockedScreen.querySelector('h1').textContent = 'Not supported in this browser';
    blockedScreen.querySelector('p').textContent =
      'Automatic backup needs the File System Access API, which this browser build doesn’t offer. ' +
      'Use Settings → Full backup for a manual export/import instead.';
    return;
  }
  const identity = await AtlasWallet.getIdentity();
  if (!identity || identity.mode !== 'local') {
    showOnly(blockedScreen);
    return;
  }

  // Reopened from Settings (Setup, Reconnect, or Reopen all point here) —
  // route straight to whatever screen matches the current state instead
  // of always starting from the consent screen again.
  const settings = await AtlasWallet.getAutoBackupSettings();
  if (settings && settings.enabled) {
    if (settings.lapsed) {
      showOnly(reconnectScreen);
      reconnectReasonText.textContent = settings.lastError || 'Backup file access was revoked in the browser.';
    } else {
      showKeepOpenScreen(settings.fileName);
    }
    return;
  }
  showOnly(setupScreen);
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
    showKeepOpenScreen(result.fileName || handle.name);
  } catch (err) {
    chooseFileBtn.disabled = false;
    skipBtn.disabled = false;
    setStatus(err.message, 'error');
  }
});

// Unlike writeAutoBackupNow()'s own reconnect path, this one genuinely
// runs from a real click in the correct top-level context, so it's the
// one place requestPermission() is expected to actually succeed.
reconnectBtn.addEventListener('click', async () => {
  reconnectBtn.disabled = true;
  setStatus('Reconnecting…', null, reconnectStatusEl);
  try {
    await AtlasWallet.reconnectAutoBackupPermission();
    const settings = await AtlasWallet.getAutoBackupSettings();
    showKeepOpenScreen(settings && settings.fileName);
  } catch (err) {
    reconnectBtn.disabled = false;
    setStatus('Could not reconnect: ' + err.message, 'error', reconnectStatusEl);
  }
});

minimizeBtn.addEventListener('click', minimizeThisWindow);

closeBtn.addEventListener('click', () => {
  if (autoMinimizeTimer) {
    clearTimeout(autoMinimizeTimer);
    autoMinimizeTimer = null;
  }
  window.close();
});
