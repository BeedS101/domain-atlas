// Domain Atlas — wallet-bridge confirmation (SPEC.md §3.8.1 signing, §3.8.2
// asset offers, §3.8.3 trusted offer domains)
//
// Loaded as an extension-origin iframe by content.js's
// openBridgeConfirmOverlay() — the host page that injected this iframe is
// a different origin and has no way to script into it, read its contents,
// or change what's displayed; everything on screen here comes from this
// file's own code, never from the page that asked for a signature or
// offered an asset. That's the entire point of this file existing as a
// separate page rather than being drawn by content.js directly inside the
// host page's own DOM, where a sufficiently creative page script could at
// least try to interfere with it.
//
// Acts on an approval directly (loads wallet.js via a plain <script> tag,
// same as viewer.html already does) rather than asking background.js to —
// see content.js's own comment on openBridgeConfirmOverlay() for why
// routing through one more extension context wouldn't add any actual
// trust boundary here. For 'sign' this means calling
// AtlasWallet.signWithSelf(); for 'offer' it means calling
// AtlasWallet.queueBridgeOffer() by default — SPEC.md §3.8.2 is explicit
// that approving an offer must NOT add it straight to the wallet, so this
// is a queue call, not a mint or an adopt, same as every other call site
// that already respects that rule (claimMailGift's own deferred-
// verification comment in wallet.js) — UNLESS the visitor also checked
// the offer prompt's own trust checkbox, in which case this calls
// trustBridgeDomain() then claims immediately: SPEC.md §3.8.3 is explicit
// that this is a one-time, visitor-initiated decision this exact prompt
// is the only place allowed to make, never a page-triggered default.
(function () {
  const readyState = document.getElementById('readyState');
  const offerState = document.getElementById('offerState');
  const lockedState = document.getElementById('lockedState');
  const originEl = document.getElementById('origin');
  const offerOriginEl = document.getElementById('offerOrigin');
  const originLockedEl = document.getElementById('originLocked');
  const purposeText = document.getElementById('purposeText');
  const payloadBox = document.getElementById('payloadBox');
  const offerAssetName = document.getElementById('offerAssetName');
  const offerAssetClass = document.getElementById('offerAssetClass');
  const offerAssetQtyLine = document.getElementById('offerAssetQtyLine');
  const offerAssetQty = document.getElementById('offerAssetQty');
  const offerTrustCheckbox = document.getElementById('offerTrustCheckbox');
  const offerTrustOrigin = document.getElementById('offerTrustOrigin');
  const offerTrustClass = document.getElementById('offerTrustClass');
  const lockedDetailLine = document.getElementById('lockedDetailLine');
  const approveBtn = document.getElementById('approveBtn');
  const denyBtn = document.getElementById('denyBtn');
  const offerApproveBtn = document.getElementById('offerApproveBtn');
  const offerDenyBtn = document.getElementById('offerDenyBtn');
  const dismissBtn = document.getElementById('dismissBtn');

  let decided = false;
  let currentKind = null;
  let currentOrigin = null;
  let currentPayload = null; // 'sign': the page-supplied payload object. 'offer': the credential.

  function decide(approved, result) {
    if (decided) return; // the inactivity timer and a real click can both fire — only the first counts
    decided = true;
    clearTimeout(inactivityTimer);
    window.parent.postMessage({ type: 'domain-atlas-bridge-confirm-decision', approved, result: result || null }, '*');
  }

  // A visitor who never answers at all (switches tabs and forgets, closes
  // the laptop) must still resolve eventually rather than leave this
  // request — and the queue behind it, see content.js — stuck forever.
  // Denial, never a default approval: silence is never consent here.
  const inactivityTimer = setTimeout(() => decide(false, null), 120000);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Plain key: value lines, every field in the payload the page supplied —
  // full disclosure of exactly what's about to be signed, per SPEC.md
  // §3.8.1's "the payload in a human-readable form" requirement. Nested
  // objects/arrays render as their own JSON rather than one opaque
  // "[object Object]" line, since those are exactly the values a visitor
  // most needs to actually be able to read here.
  function renderPayload(payload) {
    const lines = Object.keys(payload).sort().map((key) => {
      const value = payload[key];
      const text = (typeof value === 'string') ? value : JSON.stringify(value);
      return '<div><span class="k">' + escapeHtml(key) + ':</span> ' + escapeHtml(text) + '</div>';
    });
    payloadBox.innerHTML = lines.join('');
  }

  function showState(kind, unlocked) {
    readyState.style.display = (unlocked && kind === 'sign') ? 'block' : 'none';
    offerState.style.display = (unlocked && kind === 'offer') ? 'block' : 'none';
    // Explicit 'block'/'none' on all three, not '' — '' only clears an
    // inline override and falls back to the stylesheet rule, which is
    // `display: none` for each of these (so every state starts hidden
    // before this message ever arrives); '' would leave the intended one
    // hidden forever instead of actually showing it. (This is the exact
    // bug this file's own history already hit once for the sign/locked
    // pair — see the private notes.)
    lockedState.style.display = unlocked ? 'none' : 'block';
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent) return;
    if (!event.data || event.data.type !== 'domain-atlas-bridge-confirm-init') return;
    const { origin, kind, detail, payload } = event.data;
    currentKind = kind;
    currentOrigin = origin;
    currentPayload = payload;

    try {
      if (kind === 'sign') {
        originEl.textContent = origin;
        purposeText.textContent = detail;
        renderPayload(payload && typeof payload === 'object' ? payload : {});
        lockedDetailLine.textContent = 'This site asked to sign a "' + detail + '" request, but there’s nothing active to sign it with.';
      } else if (kind === 'offer') {
        const asset = (payload && payload.asset) || {};
        offerOriginEl.textContent = origin;
        offerAssetName.textContent = asset.name || detail || '(unnamed asset)';
        offerAssetClass.textContent = asset.class || detail || '…';
        const quantity = (payload && typeof payload.quantity === 'number') ? payload.quantity : 1;
        offerAssetQtyLine.style.display = quantity > 1 ? 'block' : 'none';
        offerAssetQty.textContent = String(quantity);
        // SPEC.md §3.8.3 — the checkbox always starts unchecked; checking
        // it is an affirmative act the visitor takes HERE, on THIS
        // prompt, never a remembered or page-influenced default.
        offerTrustCheckbox.checked = false;
        offerTrustOrigin.textContent = origin;
        offerTrustClass.textContent = asset.class || detail || '…';
        lockedDetailLine.textContent = 'This site offered to add a "' + (asset.class || detail) + '" asset to your wallet, but there’s nothing active to accept it with.';
      }
      originLockedEl.textContent = origin;

      const unlocked = await AtlasWallet.isUnlocked().catch(() => false);
      showState(kind, unlocked);
    } catch (err) {
      // Nothing sensible to show if even this broke — deny rather than
      // leave a half-rendered prompt sitting there with no way out.
      decide(false, null);
    }
  });

  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    try {
      const envelope = await AtlasWallet.signWithSelf(currentPayload);
      decide(true, envelope);
    } catch (err) {
      // Unlocked a moment ago (checked on init) but not anymore by the
      // time of the click (locked mid-prompt, a race rather than the
      // common case) — reads the same as any other way this comes back
      // with nothing to sign.
      decide(false, null);
    }
  });
  denyBtn.addEventListener('click', () => decide(false, null));

  // SPEC.md §3.8.2/§3.8.3 — by default, Accept never adds currentPayload
  // (the credential) to the live wallet itself; queueBridgeOffer only
  // ever writes to the separate, sandboxed pending-offers store
  // (wallet.js's own comment on that function). getIdentity() here can't
  // actually disagree with the isUnlocked() check init already did and
  // used to show this button in the first place — guarded anyway for the
  // same locked-mid-prompt race the sign path above guards against.
  //
  // Checking the trust box changes what THIS click does, not what a
  // future one will need to: trustBridgeDomain() first (so a prompt this
  // domain never needs to show again is recorded before anything else),
  // then queue-and-claim immediately in the same click, rather than
  // leaving this one specific offer sitting in Pending when the visitor
  // just said they don't need to be asked about this domain going
  // forward.
  offerApproveBtn.addEventListener('click', async () => {
    offerApproveBtn.disabled = true;
    offerDenyBtn.disabled = true;
    try {
      const identity = await AtlasWallet.getIdentity();
      if (!identity) throw new Error('no active identity');
      if (offerTrustCheckbox.checked) {
        await AtlasWallet.trustBridgeDomain(identity.publicKey, currentOrigin);
        const entry = await AtlasWallet.queueBridgeOffer(identity.publicKey, currentOrigin, currentPayload);
        const { verdict } = await AtlasWallet.claimBridgeOffer(identity.publicKey, entry.id);
        decide(true, { claimed: !!verdict.valid, offerId: entry.id });
      } else {
        const entry = await AtlasWallet.queueBridgeOffer(identity.publicKey, currentOrigin, currentPayload);
        decide(true, { queued: true, offerId: entry.id });
      }
    } catch (err) {
      decide(false, null);
    }
  });
  offerDenyBtn.addEventListener('click', () => decide(false, null));

  dismissBtn.addEventListener('click', () => decide(false, null));

  window.parent.postMessage({ type: 'domain-atlas-bridge-confirm-ready' }, '*');
})();
