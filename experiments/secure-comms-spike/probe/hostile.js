// A page trying to control the spike extension. Everything here is expected
// to fail; the test reads window.__hostile. The extension id comes from ?ext=.
(async function () {
  const ext = new URLSearchParams(location.search).get('ext');
  const r = {};
  try { const res = await fetch('chrome-extension://' + ext + '/call.html'); r.fetchCallPage = 'status ' + res.status; } catch (e) { r.fetchCallPage = 'blocked: ' + e.name; }
  r.chromeRuntime = typeof (window.chrome && window.chrome.runtime);
  r.sendMessage = 'not available';
  if (window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
    try { chrome.runtime.sendMessage(ext, { type: 'open-call' }, (resp) => { r.sendMessage = resp ? 'answered' : 'no answer: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message); }); await new Promise((x) => setTimeout(x, 500)); } catch (e) { r.sendMessage = 'threw: ' + e.name; }
  }
  const frame = document.createElement('iframe');
  frame.src = 'chrome-extension://' + ext + '/call.html';
  document.body.appendChild(frame);
  await new Promise((x) => setTimeout(x, 800));
  try { r.iframeAccess = frame.contentDocument ? 'accessible' : 'null document'; } catch (e) { r.iframeAccess = 'blocked: ' + e.name; }
  r.windowOpen = 'skipped';
  window.postMessage({ type: 'spike-start-call' }, '*');
  window.__hostile = r;
})();
