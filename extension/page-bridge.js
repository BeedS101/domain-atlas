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
  // the rest of this bridge already takes. timeoutMs/defaultResult are
  // per-action: getIdentity is a quick, no-human-involved read (a short
  // timeout is enough), while requestSignature can legitimately sit
  // waiting on a visitor's own decision for a while — its timeout here is
  // deliberately longer than content.js's own confirmation-overlay
  // timeouts (see that file's requestBridgeConfirmation()/
  // openBridgeConfirmOverlay() comments), so under normal conditions the
  // real answer always arrives first and this one never actually fires.
  function sendBridgeRequest(action, payload, timeoutMs, defaultResult) {
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
      pending.set(requestId, { resolve });
      window.postMessage({ __atlasBridge: true, direction: 'to-content', requestId, action, payload }, location.origin);
      setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        resolve(defaultResult);
      }, timeoutMs);
    });
  }

  window.atlasWallet = {
    // SPEC.md §3.8 — read-only. Resolves { allowed, publicKey }: allowed is
    // false whenever this page/domain hasn't been granted
    // policy.walletBridge.read (or the manifest-level default), regardless
    // of whether a visitor actually has an identity; publicKey is null
    // either when access isn't allowed or when it is but no identity is
    // currently active. Never throws — a page checking "is Domain Atlas
    // usable here" shouldn't need a try/catch to find out.
    async getIdentity() {
      const result = await sendBridgeRequest('getIdentity', undefined, 4000, { allowed: false, publicKey: null });
      return (result && typeof result === 'object') ? result : { allowed: false, publicKey: null };
    },

    // SPEC.md §3.8.1 — asks the wallet to sign an application-defined
    // payload, which MUST carry its own string `purpose` field (checked
    // against this domain's manifest-declared policy.walletBridge.sign
    // whitelist before anything else happens — see content.js's
    // handleBridgeRequest()). Resolves { allowed, result }: allowed is
    // false only when `purpose` itself isn't on that whitelist (or the
    // payload is malformed), with no confirmation ever shown in that case;
    // allowed:true with result:null covers every other way this can come
    // back empty-handed (the visitor denied it, no identity was active to
    // sign with, or the request simply timed out) — deliberately
    // indistinguishable from each other, per SPEC.md §3.8.1, since none of
    // them is a page's business to tell apart. Never throws.
    async requestSignature(payload) {
      if (!payload || typeof payload !== 'object' || typeof payload.purpose !== 'string' || !payload.purpose) {
        return { allowed: false, result: null };
      }
      const result = await sendBridgeRequest('requestSignature', payload, 180000, { allowed: false, result: null });
      return (result && typeof result === 'object') ? result : { allowed: false, result: null };
    },

    // SPEC.md §3.8.2/§3.8.3 — hands the wallet a COMPLETE, already-signed
    // domain-atlas-asset/1.0 credential this page's own domain minted
    // (this bridge never mints anything itself). Resolves { allowed,
    // result }: allowed is false only when asset.class itself isn't on
    // this domain's policy.walletBridge.offer whitelist (or the
    // credential is malformed), with no confirmation ever shown in that
    // case — identical refusal posture to requestSignature's purpose
    // check above. allowed:true with result:null covers every other way
    // this can come back empty-handed (the visitor denied it, dismissed
    // a locked prompt, or the request simply timed out); result:
    // {queued:true, offerId} on an ordinary approval — approval there
    // never means the credential is in the wallet yet, only that it's now
    // sitting in the visitor's pending offers for them to separately
    // Claim or Dismiss. If this origin happens to be on the visitor's own
    // trusted-offer-domains list for an already-whitelisted class (§3.8.3,
    // never something this page can set or detect), the prompt may be
    // skipped entirely and result instead reads {claimed:true, offerId} —
    // the credential is already in the wallet in that case, no further
    // action needed. Never throws.
    async offerAsset(credential) {
      if (!credential || typeof credential !== 'object' || credential.credential !== 'domain-atlas-asset/1.0' ||
          !credential.asset || typeof credential.asset.class !== 'string' || !credential.asset.class) {
        return { allowed: false, result: null };
      }
      const result = await sendBridgeRequest('offerAsset', credential, 180000, { allowed: false, result: null });
      return (result && typeof result === 'object') ? result : { allowed: false, result: null };
    },

    // SPEC.md §3.8.5 — asks the wallet to show a credential this page
    // already holds in its own preview panel (drawn by the extension, not
    // this page). Same class gate as offerAsset (the domain's
    // policy.walletBridge.offer whitelist); no confirmation, since it is
    // display-only. Resolves { allowed, shown }. The panel hides itself
    // after a short inactivity limit unless this is called again, so a
    // hover handler should simply call it on mouseenter/mousemove.
    // Never throws.
    async previewAsset(credential) {
      if (!credential || typeof credential !== 'object' || credential.credential !== 'domain-atlas-asset/1.0' ||
          !credential.asset || typeof credential.asset.class !== 'string' || !credential.asset.class) {
        return { allowed: false, shown: false };
      }
      const result = await sendBridgeRequest('previewAsset', credential, 4000, { allowed: false, shown: false });
      return (result && typeof result === 'object') ? result : { allowed: false, shown: false };
    },

    // SPEC.md §3.8.5 — hides whatever preview this page last showed.
    async hidePreview() {
      await sendBridgeRequest('hidePreview', undefined, 2000, { allowed: true });
      return { hidden: true };
    }
  };
})();
