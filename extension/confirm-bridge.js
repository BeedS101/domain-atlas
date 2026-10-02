// Domain Atlas — wallet-bridge signing confirmation (SPEC.md §3.8.1)
//
// Loaded as an extension-origin iframe by content.js's
// openBridgeConfirmOverlay() — the host page that injected this iframe is
// a different origin and has no way to script into it, read its contents,
// or change what's displayed; everything on screen here comes from this
// file's own code, never from the page that asked for a signature. That's
// the entire point of this file existing as a separate page rather than
// being drawn by content.js directly inside the host page's own DOM, where
// a sufficiently creative page script could at least try to interfere with
// it.
//
// Signs directly (loads wallet.js via a plain <script> tag, same as
// viewer.html already does) rather than asking background.js to — see
// content.js's own comment on openBridgeConfirmOverlay() for why routing
// through one more extension context wouldn't add any actual trust
// boundary here.
(function () {
  const readyState = document.getElementById('readyState');
  const lockedState = document.getElementById('lockedState');
  const originEl = document.getElementById('origin');
  const originLockedEl = document.getElementById('originLocked');
  const purposeText = document.getElementById('purposeText');
  const purposeTextLocked = document.getElementById('purposeTextLocked');
  const payloadBox = document.getElementById('payloadBox');
  const approveBtn = document.getElementById('approveBtn');
  const denyBtn = document.getElementById('denyBtn');
  const dismissBtn = document.getElementById('dismissBtn');

  let decided = false;
  let currentPayload = null;

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

  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent) return;
    if (!event.data || event.data.type !== 'domain-atlas-bridge-confirm-init') return;
    const { origin, purpose, payload } = event.data;
    currentPayload = payload;

    try {
      originEl.textContent = origin;
      originLockedEl.textContent = origin;
      purposeText.textContent = purpose;
      purposeTextLocked.textContent = purpose;
      renderPayload(payload && typeof payload === 'object' ? payload : {});

      const unlocked = await AtlasWallet.isUnlocked().catch(() => false);
      // Explicit 'block'/'none' on both, not '' — '' only clears an
      // inline override and falls back to the stylesheet rule, which is
      // `display: none` for #lockedState (so the prompt starts hidden
      // before this message ever arrives); '' would leave it hidden
      // forever instead of actually showing it.
      readyState.style.display = unlocked ? 'block' : 'none';
      lockedState.style.display = unlocked ? 'none' : 'block';
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
  dismissBtn.addEventListener('click', () => decide(false, null));

  window.parent.postMessage({ type: 'domain-atlas-bridge-confirm-ready' }, '*');
})();
