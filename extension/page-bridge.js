// Domain Atlas — page-side wallet bridge (SPEC.md §3.8)
//
// Runs in the PAGE's own MAIN-world JS context (manifest.json's
// content_scripts "world": "MAIN"), not the isolated content-script world
// content.js runs in — the whole point of this file is to be something a
// page's own script can call directly, the same way window.ethereum-style
// wallet injections work. It never touches wallet.js itself (nothing in
// this execution context can — see content.js's own comment on why), it
// only relays to content.js next door via a same-document postMessage,
// which in turn relays to background.js (see that file's own §3.8 comment
// for where the real AtlasWallet.getIdentity() call happens).
//
// Defined unconditionally on every page, same as window.ethereum is —
// whether a call actually returns anything is gated at content.js by that
// page's own manifest declaration (SPEC.md §3.8's policy.walletBridge),
// never by whether this object exists at all.
(function () {
  if (window.atlasWallet) return; // already injected — never double-wrap

  let nextRequestId = 1;
  const pending = new Map(); // requestId -> {resolve, reject}

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.__atlasBridge !== true || data.direction !== 'to-page') return;
    const waiter = pending.get(data.requestId);
    if (!waiter) return;
    pending.delete(data.requestId);
    waiter.resolve(data.result);
  });

  // A request content.js never answers (extension reloaded mid-flight, a
  // page calling this before the content script finished attaching) must
  // still resolve rather than hang a caller's await forever — same
  // "fail to the closed/denied state, never to a silent stall" posture
  // the rest of this bridge already takes.
  function sendBridgeRequest(action, timeoutMs = 4000) {
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
      pending.set(requestId, { resolve });
      window.postMessage({ __atlasBridge: true, direction: 'to-content', requestId, action }, location.origin);
      setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        resolve({ allowed: false, publicKey: null });
      }, timeoutMs);
    });
  }

  window.atlasWallet = {
    // SPEC.md §3.8 — read-only for now. Resolves { allowed, publicKey }:
    // allowed is false whenever this page/domain hasn't been granted
    // policy.walletBridge.read (or the manifest-level default), regardless
    // of whether a visitor actually has an identity; publicKey is null
    // either when access isn't allowed or when it is but no identity is
    // currently active. Never throws — a page checking "is Domain Atlas
    // usable here" shouldn't need a try/catch to find out.
    async getIdentity() {
      const result = await sendBridgeRequest('getIdentity');
      return (result && typeof result === 'object') ? result : { allowed: false, publicKey: null };
    }
  };
})();
