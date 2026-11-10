// The "Chain labs coins" section at the top of the wallet's Ledger tab: the list of domains, what each says the key
// holds, and the Send and Buy with Gold steps. The rules live in chain-labs-wallet.js and the signer in wallet.js; this
// file only draws them and asks the person before anything is signed. Every piece of text that comes from a domain is
// set with textContent.
(function () {
  'use strict';

  let busy = false;       // a step the person started is running
  let refreshing = false; // the domains are being asked again; the person can still act meanwhile
  let notice = '';
  let panel = null; // the step in progress: { kind: 'add' | 'send' | 'buy', ... }
  let renderSeq = 0;

  function el(tag, props, kids) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      if (k === 'className' || k === 'textContent' || k === 'id' || k === 'type' || k === 'disabled' || k === 'value' || k === 'hidden') node[k] = props[k];
      else node.setAttribute(k, props[k]);
    });
    (kids || []).forEach((c) => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  function chain() { return AtlasWallet.getChainLabs(); }
  function root() { return document.getElementById('chainLabsSection'); }

  function say(text) { notice = text || ''; const n = document.getElementById('chainLabsStatus'); if (n) n.textContent = notice; }

  function when(iso) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? '' : new Date(t).toLocaleString();
  }

  function age(ms) {
    if (ms === null || ms === undefined) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return 'a moment ago';
    if (s < 5400) return Math.round(s / 60) + ' minutes ago';
    if (s < 129600) return Math.round(s / 3600) + ' hours ago';
    return Math.round(s / 86400) + ' days ago';
  }

  async function act(fn, done) {
    if (busy) return;
    busy = true;
    notice = '';
    // The message is drawn by render() together with the new state, so it never shows beside a form that is about to be replaced.
    try { await fn(); if (done) notice = done; } catch (err) { notice = err && err.message ? err.message : 'That did not work.'; }
    busy = false;
    await render();
  }

  function button(label, onClick, extra) {
    const b = el('button', { type: 'button', textContent: label });
    if (extra) b.className = extra;
    b.addEventListener('click', onClick);
    return b;
  }

  function coinLine(domain, coin, row) {
    const line = el('div', { className: 'info-card chain-labs-coin', role: 'group', 'aria-label': coin.symbol + ' at ' + domain.domain });
    const stateWord = coin.state === 'frozen' ? ' It is frozen: the domains disagree about its history, so it takes no new transfers.' : '';
    line.appendChild(el('div', { className: 'chain-labs-balance', textContent: domain.domain + ' says you hold ' + coin.amount + ' ' + coin.symbol + (domain.asOf ? ', as of ' + when(domain.asOf) : '') + '.' + stateWord }));
    const mode = coin.mode === 'multi' ? 'needs ' + coin.threshold + ' of ' + coin.roster + ' domains' : 'one authority';
    line.appendChild(el('div', { className: 'meta', textContent: [mode, coin.visibility, domain.proven ? 'proven with your signature' : 'reported to anyone who asks', coin.state === 'frozen' ? 'frozen' : null].filter(Boolean).join(' · ') }));
    const actions = el('div', { className: 'item-actions' });
    if (coin.state === 'active') {
      actions.appendChild(button('Send…', () => { panel = { kind: 'send', domain: domain.domain, coin, step: 'form' }; render(); }));
      // Buy with Gold is offered only where the authority has published terms and can take the Gold; otherwise the coin says it is not for sale.
      const sale = offers.get(domain.domain + '/' + coin.coinId);
      if (sale && sale.usable) actions.appendChild(button('Buy with Gold…', () => { panel = { kind: 'buy', domain: domain.domain, coin, step: 'form' }; render(); }));
      else if (sale) line.appendChild(el('div', { className: 'meta', textContent: sale.code === 'no-purchase-policy' ? 'Not for sale: this coin has no purchase terms.' : 'Not for sale now: ' + sale.reason }));
    }
    line.appendChild(actions);
    return line;
  }

  function domainCard(d) {
    const card = el('div', { className: 'info-card chain-labs-domain', role: 'group', 'aria-label': d.domain });
    card.appendChild(el('div', { className: 'chain-labs-domain-name', textContent: d.domain }));
    const bits = ['key ' + (d.fingerprint || 'unknown') + ' pinned'];
    if (d.fetchedAt) bits.push('last answer ' + age(d.fetchedAt)); else bits.push('not asked yet');
    card.appendChild(el('div', { className: 'meta', textContent: bits.join(' · ') }));
    if (d.problem) card.appendChild(el('div', { className: 'ledger-problem', role: 'status', textContent: d.problem + (d.coins.length ? ' Showing its last answer.' : '') }));
    else if (d.stale && !d.never) card.appendChild(el('div', { className: 'meta', textContent: 'This answer is out of date.' }));
    if (!d.coins.length && !d.problem && !d.never) card.appendChild(el('div', { className: 'meta', textContent: 'This domain lists nothing for your key.' }));
    d.coins.forEach((c) => card.appendChild(coinLine(d, c)));
    const actions = el('div', { className: 'item-actions' });
    actions.appendChild(button('Ask again', () => act(() => chain().lookup(d.domain).then(() => null))));
    actions.appendChild(button('Remove from list', () => { panel = { kind: 'remove', domain: d.domain }; render(); }, 'danger-btn'));
    card.appendChild(actions);
    return card;
  }

  function stepBox(title, body, buttons) {
    const box = el('div', { className: 'info-card ledger-confirm', role: 'group', 'aria-label': title });
    box.appendChild(el('div', { textContent: body }));
    const actions = el('div', { className: 'item-actions' });
    buttons.forEach((b) => actions.appendChild(b));
    box.appendChild(actions);
    return box;
  }

  function field(label, id, placeholder, value) {
    const wrap = el('div');
    wrap.appendChild(el('label', { className: 'ledger-open-label', for: id, textContent: label }));
    wrap.appendChild(el('input', { type: 'text', id, placeholder: placeholder || '', value: value || '', autocomplete: 'off' }));
    return wrap;
  }

  function cancel() { return button('Cancel', () => { panel = null; render(); }); }

  async function sendPanel() {
    const p = panel;
    const box = el('div', { className: 'info-card ledger-confirm', role: 'group', 'aria-label': 'Send ' + p.coin.symbol });
    box.appendChild(el('div', { textContent: 'Send ' + p.coin.symbol + ' held at ' + p.domain }));
    if (p.step === 'form') {
      box.appendChild(field('Recipient\'s wallet key', 'chainLabsSendTo', 'Paste the key the recipient shows in their wallet'));
      box.appendChild(field('Amount (' + p.coin.symbol + ')', 'chainLabsSendAmount', 'e.g. 12.5'));
      const actions = el('div', { className: 'item-actions' });
      actions.appendChild(button('Check…', () => act(async () => {
        const prepared = await chain().prepareSend(p.domain, p.coin.coinId, document.getElementById('chainLabsSendTo').value.trim(), document.getElementById('chainLabsSendAmount').value);
        panel = { kind: 'send', domain: p.domain, coin: p.coin, step: 'confirm', prepared };
      })));
      actions.appendChild(cancel());
      box.appendChild(actions);
    } else {
      box.appendChild(el('div', { textContent: p.prepared.text }));
      box.appendChild(el('div', { className: 'meta', textContent: 'Approving signs this one transfer with your key. The domain cannot reuse it for anything else.' }));
      const actions = el('div', { className: 'item-actions' });
      actions.appendChild(button('Sign and send', () => act(async () => {
        const prepared = p.prepared;
        panel = null;
        const r = await chain().send(prepared);
        notice = r.status === 'done' ? 'Sent. The domain\'s receipt matches what you signed.' : 'The domain is waiting for the other domains to approve. The wallet keeps this transfer and will check on it.';
      })));
      actions.appendChild(cancel());
      box.appendChild(actions);
    }
    return box;
  }

  let offers = new Map();

  async function buyPanel() {
    const p = panel;
    const box = el('div', { className: 'info-card ledger-confirm', role: 'group', 'aria-label': 'Buy ' + p.coin.symbol + ' with Gold' });
    box.appendChild(el('div', { textContent: 'Buy ' + p.coin.symbol + ' with Gold from ' + p.domain }));
    if (p.step === 'form') {
      let offer = null, golds = [], report = null;
      try { offer = await chain().offer(p.domain, p.coin.coinId); report = await AtlasWallet.inspectChainLabsGold(); golds = report.usable; } catch (err) { box.appendChild(el('div', { className: 'ledger-problem', role: 'status', textContent: err.message })); }
      if (offer) {
        box.appendChild(el('div', { className: 'meta', textContent: '1 Gold buys ' + AtlasChainLabs.formatUnits(String(offer.unitsPerPrice), offer.decimals) + ' ' + offer.symbol + '. The smallest purchase is ' + offer.minPrice + ' Gold for ' + AtlasChainLabs.formatUnits(String(offer.unitsPerPrice * offer.minPrice), offer.decimals) + ' ' + offer.symbol + '.' }));
        if (!golds.length) box.appendChild(el('div', { className: 'meta', textContent: AtlasChainLabs.describeNoGold(report) }));
        else {
          box.appendChild(el('label', { className: 'ledger-open-label', for: 'chainLabsGold', textContent: 'Gold to pay with' }));
          const select = el('select', { id: 'chainLabsGold' });
          golds.forEach((g, i) => select.appendChild(el('option', { value: String(i), textContent: g.label })));
          box.appendChild(select);
          box.appendChild(field('Gold to spend', 'chainLabsPrice', 'At least ' + offer.minPrice));
          const actions = el('div', { className: 'item-actions' });
          actions.appendChild(button('Check…', () => act(async () => {
            const g = golds[Number(document.getElementById('chainLabsGold').value)];
            const prepared = await chain().prepareBuy(p.domain, p.coin.coinId, g.credential, g.quantity, document.getElementById('chainLabsPrice').value.trim());
            panel = { kind: 'buy', domain: p.domain, coin: p.coin, step: 'confirm', prepared };
          })));
          actions.appendChild(cancel());
          box.appendChild(actions);
          return box;
        }
      }
      const actions = el('div', { className: 'item-actions' });
      actions.appendChild(cancel());
      box.appendChild(actions);
    } else {
      box.appendChild(el('div', { textContent: p.prepared.text }));
      box.appendChild(el('div', { className: 'meta', textContent: 'Approving signs this one purchase with your key and sends the Gold credential to the domain.' }));
      const actions = el('div', { className: 'item-actions' });
      actions.appendChild(button('Sign and buy', () => act(async () => {
        const prepared = p.prepared;
        panel = null;
        const r = await chain().buy(prepared);
        notice = r.status === 'done' ? 'Bought. The domain delivered the coin and returned the rest of your Gold.' : 'The sale is waiting for the other domains. The wallet keeps it; try again from the list below.';
      })));
      actions.appendChild(cancel());
      box.appendChild(actions);
    }
    return box;
  }

  function pendingList(view) {
    const wrap = el('div');
    view.pendingSends.forEach((p) => {
      const card = el('div', { className: 'info-card chain-labs-pending' });
      card.appendChild(el('div', { textContent: 'Waiting at ' + p.domain + ': sending ' + (AtlasChainLabs.formatUnits(p.amount, p.decimals) || p.amount) + ' ' + p.symbol + '.' }));
      const actions = el('div', { className: 'item-actions' });
      actions.appendChild(button('Check now', () => act(async () => {
        const done = await chain().checkPending();
        notice = done.length ? done.map((x) => (x.outcome === 'done' ? 'A waiting transfer was made.' : 'A waiting transfer ended: ' + x.outcome + '.')).join(' ') : 'Still waiting.';
      })));
      card.appendChild(actions);
      wrap.appendChild(card);
    });
    view.pendingBuys.forEach((p) => {
      const card = el('div', { className: 'info-card chain-labs-pending' });
      card.appendChild(el('div', { textContent: 'Waiting at ' + p.domain + ': a purchase for ' + p.price + ' Gold.' }));
      const actions = el('div', { className: 'item-actions' });
      actions.appendChild(button('Try again', () => act(async () => {
        const r = await chain().resumeBuy(p.requestId);
        notice = r.status === 'done' ? 'Bought. The domain delivered the coin and returned the rest of your Gold.' : 'Still waiting.';
      })));
      actions.appendChild(button('Forget', () => act(() => chain().dropBuy(p.requestId), 'Forgotten here. If the domain was already holding the Gold for it, ask the domain\'s operator to cancel it.'), 'danger-btn'));
      card.appendChild(actions);
      wrap.appendChild(card);
    });
    return wrap;
  }

  async function render() {
    const host = root();
    if (!host) return;
    const seq = ++renderSeq;
    let view;
    try { view = await chain().rows(); } catch (err) { host.textContent = ''; host.appendChild(el('div', { className: 'ledger-problem', role: 'status', textContent: 'Chain labs coins could not be loaded: ' + (err && err.message) })); return; }
    if (seq !== renderSeq) return;
    offers = new Map();
    await Promise.all(view.domains.flatMap((d) => d.coins.filter((c) => c.state === 'active').map(async (c) => { offers.set(d.domain + '/' + c.coinId, await chain().offerState(d.domain, c.coinId)); })));
    if (seq !== renderSeq) return;
    let stepEl = null;
    if (panel && panel.kind === 'send') stepEl = await sendPanel();
    else if (panel && panel.kind === 'buy') stepEl = await buyPanel();
    if (seq !== renderSeq) return;
    host.textContent = '';
    host.appendChild(el('div', { className: 'subhead', id: 'chainLabsHeading', textContent: 'Chain labs coins' }));
    host.appendChild(el('p', { className: 'meta', textContent: 'These coins are kept by the domains below, not by this wallet. Each domain you list is asked what your key holds and signs its answer; the wallet shows that answer with its time. Adding a domain is your permission to ask it.' }));
    host.appendChild(el('div', { id: 'chainLabsStatus', className: 'empty-note', role: 'status', 'aria-live': 'polite', textContent: notice }));
    if (panel && panel.kind === 'remove') {
      host.appendChild(stepBox('Remove ' + panel.domain, 'Take ' + panel.domain + ' off the list? It stops being asked, and the wallet forgets its last answer and any transfer or purchase waiting there. Nothing at the domain changes.',
        [button('Remove', () => act(async () => { const d = panel.domain; panel = null; await chain().removeDomain(d); }, 'Removed.'), 'danger-btn'), cancel()]));
    }
    if (panel && panel.kind === 'add') {
      host.appendChild(stepBox('Add ' + panel.domain, 'Ask ' + panel.domain + ' what your key holds? The wallet will fetch the key the domain signs with and pin it, then check every answer against it. Your public key is sent to the domain with each lookup.',
        [button('Add and ask', () => act(async () => { const d = panel.domain; panel = null; await chain().addDomain(d); await chain().lookup(d).catch(() => null); }, 'Added.')), cancel()]));
    }
    if (stepEl) host.appendChild(stepEl);
    if (!view.domains.length) host.appendChild(el('div', { className: 'empty-note', textContent: 'No domains on the list yet.' }));
    view.domains.forEach((d) => host.appendChild(domainCard(d)));
    host.appendChild(pendingList(view));
    const addRow = el('div', { className: 'btn-row', style: 'margin-top:8px;' });
    addRow.appendChild(el('input', { type: 'text', id: 'chainLabsAddInput', 'aria-label': 'Domain to add', placeholder: 'Domain to ask, e.g. example.com', autocomplete: 'off' }));
    addRow.appendChild(button('Add…', () => {
      const d = AtlasChainLabs.normalizeDomain(document.getElementById('chainLabsAddInput').value);
      if (!d) { say('That is not a domain name.'); return; }
      panel = { kind: 'add', domain: d };
      render();
    }));
    host.appendChild(addRow);
    if (view.domains.length) host.appendChild(el('div', { className: 'btn-row', style: 'margin-top:6px;' }, [button('Ask all domains again', () => act(() => chain().refresh().then(() => null)))]));
  }

  // Opening the tab draws the last answers at once, then asks every listed domain again.
  async function open() {
    await render();
    if (refreshing) return;
    refreshing = true;
    try { await chain().refresh(); } catch (err) { /* each domain reports its own problem */ }
    refreshing = false;
    await render();
  }

  // A purchase approved in the page prompt changes the cache from another extension page; the open tab redraws so the new
  // coin appears without reopening the tab. A step the person is in the middle of is never replaced.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.atlasChainLabsCache || busy || panel || !root()) return;
      render();
    });
  }

  window.AtlasChainLabsTab = { open, render };
})();
