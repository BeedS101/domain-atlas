// Sends the same runtime message the call page sends, from a different
// extension page, so a test can see whether the background script answers.
window.askBackground = () => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ answered: false }), 1500);
  chrome.runtime.sendMessage({ type: 'spike-ping' }, (resp) => {
    clearTimeout(timer);
    resolve({ answered: !!resp, resp: resp || null, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
  });
});
