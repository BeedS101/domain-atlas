// Domain Atlas — wallet-bridge confirmation (SPEC.md §3.8.1 signing, §3.8.2
// asset offers, §3.8.3 trusted offer domains)
//
// Loaded as an extension-origin iframe by content.js's
// openBridgeConfirmOverlay(). The host page cannot script into it or read
// it. The request (origin, kind, detail, payload) is read from
// background.js by the token in this page's URL, never from a
// window message: the host page can post messages to this iframe as
// easily as content.js can, so nothing received that way is trusted.
//
// A page's payload is never signed as it stands. What gets signed is
// { ctx: 'atlas.bridge.sign/1', origin, payload }, with the origin
// background.js recorded, so the signature cannot be mistaken for any
// protocol request (a transfer intent, an admin request, a mail check), all
// of which issuers refuse when they carry this ctx.
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
//
// The 'buy' kind runs the wallet's own Buy with Gold step for one chain labs coin. The page supplies only the authority domain
// and the coin id; the terms, the Gold credentials and the receiving identity all come from the wallet, which reads the terms
// from the domain itself. It uses the same getChainLabs() functions as the Ledger tab (offer, prepareBuy, buy), so the
// signed purchase intent and the settlement are exactly the ones the tab produces. Nothing is signed until the visitor presses
// Sign and buy on the summary of quantity, Gold cost, credential and receiving key.
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
  const buyState = document.getElementById('buyState');
  const buyOriginEl = document.getElementById('buyOrigin');
  const buyBody = document.getElementById('buyBody');

  let decided = false;
  let currentKind = null;
  let currentOrigin = null;
  let currentPayload = null; // 'sign': the page-supplied payload object. 'offer': the credential.

  let inactivityTimer = null;
  function restartInactivity(ms) {
    clearTimeout(inactivityTimer);
    if (!decided) inactivityTimer = setTimeout(() => decide(false, null), ms || 120000);
  }

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
  restartInactivity(120000);

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
    buyState.style.display = (unlocked && kind === 'buy') ? 'block' : 'none';
    // Explicit 'block'/'none' on all three, not '' — '' only clears an
    // inline override and falls back to the stylesheet rule, which is
    // `display: none` for each of these (so every state starts hidden
    // before the request is loaded); '' would leave the intended one
    // hidden forever instead of actually showing it.
    lockedState.style.display = unlocked ? 'none' : 'block';
  }

  async function loadRequest() {
    const token = location.hash.slice(1);
    let request = null;
    try {
      request = await chrome.runtime.sendMessage({ type: 'domain-atlas-bridge-confirm-fetch', token });
    } catch (err) {
      request = null;
    }
    if (!request || !request.ok || typeof request.origin !== 'string') {
      decide(false, null);
      return;
    }
    const { origin, kind, detail, payload } = request;
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
      if (kind === 'buy') {
        lockedDetailLine.textContent = 'This site asked to buy a coin with Gold, but there’s nothing unlocked to buy with. Unlock your wallet, then press Buy with Gold again.';
      }
      originLockedEl.textContent = origin;

      const unlocked = await AtlasWallet.isUnlocked().catch(() => false);
      showState(kind, unlocked);
      if (unlocked && kind === 'buy') startBuy(origin, payload);
    } catch (err) {
      // Nothing sensible to show if even this broke — deny rather than
      // leave a half-rendered prompt sitting there with no way out.
      decide(false, null);
    }
  }

  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    try {
      if (currentKind !== 'sign' || !currentOrigin) throw new Error('no signing request loaded');
      const signedPayload = { ctx: 'atlas.bridge.sign/1', origin: currentOrigin, payload: currentPayload };
      const envelope = await AtlasWallet.signWithSelf(signedPayload);
      // The proof envelope's own fields stay at the top level; signedPayload
      // is the exact object the signature covers.
      decide(true, Object.assign({}, envelope, { signedPayload }));
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

  // ---------- 'buy': the wallet's Buy with Gold step for one coin ----------

  function bel(tag, props, text) {
    const n = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => { if (k === 'className') n.className = props[k]; else n.setAttribute(k, props[k]); });
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function buyLine(label, value) {
    const row = bel('div', { className: 'line' });
    row.appendChild(bel('span', { className: 'k' }, label + ' '));
    row.appendChild(document.createTextNode(value));
    return row;
  }
  function buyButtons(list) {
    const row = bel('div', { className: 'buttons' });
    list.forEach((b) => { const x = bel('button', { type: 'button', className: b.primary ? 'primary' : 'secondary' }, b.label); x.addEventListener('click', () => { restartInactivity(300000); b.onClick(x); }); row.appendChild(x); });
    return row;
  }
  function buyProblem(text) { return bel('div', { className: 'line problem', role: 'status' }, text); }
  function shortKey(key) { return key.length > 28 ? key.slice(0, 16) + '…' + key.slice(-8) : key; }

  async function startBuy(origin, request) {
    buyOriginEl.textContent = origin;
    restartInactivity(300000);
    const domain = request && request.domain, coinId = request && request.coinId;
    const close = (result) => decide(!!result, result);
    const chain = AtlasWallet.getChainLabs();
    const show = (...nodes) => { buyBody.textContent = ''; nodes.forEach((n) => buyBody.appendChild(n)); };
    const failure = (text) => show(buyProblem(text), buyButtons([{ label: 'Close', onClick: () => close(null) }]));

    async function formStep() {
      let offer, golds, report;
      try { offer = await chain.offer(domain, coinId); report = await AtlasWallet.inspectChainLabsGold(); golds = report.usable; }
      catch (err) { failure(err && err.message ? err.message : 'This coin cannot be bought now.'); return; }
      const unit = AtlasChainLabs.formatUnits(String(offer.unitsPerPrice), offer.decimals);
      const parts = [buyLine('Coin:', offer.symbol + ' from ' + offer.domain), buyLine('Price:', '1 Gold buys ' + unit + ' ' + offer.symbol + '. The smallest purchase is ' + offer.minPrice + ' Gold for ' + AtlasChainLabs.formatUnits(String(offer.unitsPerPrice * offer.minPrice), offer.decimals) + ' ' + offer.symbol + '.')];
      if (!golds.length) { show(...parts, buyProblem(AtlasChainLabs.describeNoGold(report)), buyButtons([{ label: 'Close', onClick: () => close(null) }])); return; }
      const select = bel('select', { id: 'buyGold', 'aria-label': 'Gold to pay with' });
      golds.forEach((g, i) => { const o = bel('option', { value: String(i) }, g.label + ' · ' + shortKey(String(g.credential.id || (g.credential.asset && g.credential.asset.id) || ''))); select.appendChild(o); });
      const price = bel('input', { id: 'buyPrice', type: 'text', autocomplete: 'off', 'aria-label': 'Gold to spend', value: String(offer.minPrice) });
      const problem = bel('div', { className: 'line problem', role: 'status' });
      show(...parts, bel('div', { className: 'label' }, 'Gold to pay with'), select, bel('div', { className: 'label' }, 'Gold to spend'), price, problem,
        buyButtons([
          { label: 'Cancel', onClick: () => close(null) },
          { label: 'Review purchase', primary: true, onClick: async () => {
            problem.textContent = '';
            const g = golds[Number(select.value)];
            try { confirmStep(await chain.prepareBuy(domain, coinId, g.credential, g.quantity, price.value.trim()), g, offer); }
            catch (err) { problem.textContent = err && err.message ? err.message : 'That did not work.'; }
          } }
        ]));
    }

    function confirmStep(prepared, gold, offer) {
      const credId = String(gold.credential.id || (gold.credential.asset && gold.credential.asset.id) || '');
      const summary = bel('div', { className: 'summary', id: 'buySummary' });
      summary.appendChild(buyLine('You receive:', AtlasChainLabs.formatUnits(prepared.units, prepared.decimals) + ' ' + prepared.symbol));
      summary.appendChild(buyLine('You pay:', prepared.price + ' Gold'));
      summary.appendChild(buyLine('Gold credential:', gold.label + (credId ? ' (' + credId + ')' : '')));
      summary.appendChild(buyLine('Receiving identity:', prepared.recipient));
      summary.appendChild(buyLine('Sold by:', prepared.domain));
      summary.appendChild(buyLine('Asked by:', origin));
      const problem = bel('div', { className: 'line problem', role: 'status' });
      show(summary,
        bel('div', { className: 'line k' }, 'Approving signs this one purchase with your key and sends the Gold credential to ' + prepared.domain + '. It spends the Gold you pay and gives back the rest of the credential. It sells at most ' + AtlasChainLabs.formatUnits(String(offer.perKeyUnits), offer.decimals) + ' ' + offer.symbol + ' to one key. The requesting site cannot see or change what is shown here.'),
        problem,
        buyButtons([
          { label: 'Cancel', onClick: () => close(null) },
          { label: 'Sign and buy', primary: true, onClick: async () => {
            buyBody.querySelectorAll('button').forEach((x) => { x.disabled = true; });
            clearTimeout(inactivityTimer); // a purchase that is running is never abandoned by the timer
            problem.textContent = '';
            try {
              const r = await chain.buy(prepared);
              const done = r.status === 'done';
              show(bel('div', { className: 'line', id: 'buyResult', role: 'status' }, done
                  ? 'Bought ' + AtlasChainLabs.formatUnits(prepared.units, prepared.decimals) + ' ' + prepared.symbol + '. ' + prepared.domain + ' delivered the coin and returned the rest of your Gold. It now shows in your wallet’s Ledger tab.'
                  : 'The sale is waiting for the other domains. The wallet keeps it; open the Ledger tab and choose Try again to finish it.'),
                buyButtons([{ label: 'Close', primary: true, onClick: () => close({ status: r.status }) }]));
            } catch (err) {
              show(buyProblem(err && err.message ? err.message : 'The purchase did not go through.'), buyButtons([{ label: 'Close', onClick: () => close(null) }]));
            }
            restartInactivity(300000);
          } }
        ]));
    }

    let listed = false;
    try { listed = (await chain.domains()).some((d) => d.domain === domain); } catch (err) { failure('The wallet could not read its list of domains.'); return; }
    if (listed) { await formStep(); return; }
    // Reading a domain's terms needs its signing key pinned, which is what adding it to the list does.
    show(buyLine('Domain:', domain),
      bel('div', { className: 'line' }, domain + ' is not on your chain labs list. Continuing adds it: the wallet fetches the key the domain signs with, pins it, and asks the domain what your key holds. Nothing is bought yet.'),
      buyButtons([
        { label: 'Cancel', onClick: () => close(null) },
        { label: 'Add and continue', primary: true, onClick: async (btn) => {
          btn.disabled = true;
          try { await chain.addDomain(domain); await chain.lookup(domain).catch(() => null); }
          catch (err) { if (!(err && err.code === 'exists')) { failure(err && err.message ? err.message : 'That domain could not be added.'); return; } }
          await formStep();
        } }
      ]));
  }

  loadRequest();
})();
