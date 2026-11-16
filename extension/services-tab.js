// The Services tab of the wallet: the domains the person added, the services of each that need a membership card or another
// credential held in this wallet, and one settings page per service. The rules
// live in services-core.js and the operations in wallet.js (the Post Office calls, joining, checking); this file only draws them and
// asks the person before anything is added or joined. Every piece of text that comes from a domain is set with textContent, so a
// domain can name a service and give an address but cannot put markup or script into the wallet.
//
// Things that belong to the page the wallet is shown in (which site is open, how a credential card is drawn, how to open the
// Ledger) are handed in by viewer.js through configure(); this file does not reach for them.
(function () {
  'use strict';

  let cfg = {};
  let busy = false;       // a step the person started is running
  let notice = '';
  let panel = null;       // the step in progress: { kind: 'add' | 'remove' | 'join', ... }
  let view = null;        // the settings page that is open: { domain, key }; null for the list
  let discovery = null;   // what the site the person is visiting advertises, read but not added
  let mailSettings = null; // what the domain said about this identity's Global Mail account, after the person asked
  let renderSeq = 0;

  function el(tag, props, kids) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      if (k === 'className' || k === 'textContent' || k === 'id' || k === 'type' || k === 'disabled' || k === 'value' || k === 'hidden' || k === 'checked') node[k] = props[k];
      else node.setAttribute(k, props[k]);
    });
    (kids || []).forEach((c) => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  function services() { return AtlasWallet.getServices(); }
  async function whoKey() { const identity = await AtlasWallet.getIdentity(); return identity ? identity.publicKey : null; }
  function root() { return document.getElementById('servicesSection'); }
  function say(text) { notice = text || ''; const n = document.getElementById('servicesStatus'); if (n) n.textContent = notice; }
  function configure(options) { cfg = Object.assign({}, cfg, options || {}); }

  function age(ms) {
    if (ms === null || ms === undefined) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return 'a moment ago';
    if (s < 5400) return Math.round(s / 60) + ' minutes ago';
    if (s < 129600) return Math.round(s / 3600) + ' hours ago';
    return Math.round(s / 86400) + ' days ago';
  }

  function shortKey(key) { return key ? key.slice(0, 8) + '…' + key.slice(-4) : ''; }

  async function act(fn, done) {
    if (busy) return;
    busy = true;
    notice = '';
    // The message is drawn by render() together with the new state, so it never shows beside a page that is about to be replaced.
    try { await fn(); if (done) notice = done; } catch (err) { notice = err && err.message ? err.message : 'That did not work.'; }
    busy = false;
    await render();
  }

  // A switch the person flips while another step is still finishing waits for it instead of being dropped, so the box never shows
  // a choice that was not saved. If the other step does not finish, the page is drawn again from what is saved.
  async function whenIdle() {
    const end = Date.now() + 10000;
    while (busy && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
    return !busy;
  }

  function button(label, onClick, extra, id) {
    const b = el('button', { type: 'button', textContent: label });
    if (extra) b.className = extra;
    if (id) b.id = id;
    b.addEventListener('click', onClick);
    return b;
  }

  function stepBox(title, lines, buttons) {
    const box = el('div', { className: 'info-card svc-step', role: 'group', 'aria-label': title });
    box.appendChild(el('div', { className: 'name', textContent: title }));
    lines.forEach((t) => box.appendChild(el('div', { className: 'meta', textContent: t })));
    const actions = el('div', { className: 'item-actions' });
    buttons.forEach((b) => actions.appendChild(b));
    box.appendChild(actions);
    return box;
  }

  function cancel() { return button('Cancel', () => { panel = null; render(); }); }

  // ---------- status ----------

  const ICONS = { active: '✔', disabled: '⏸', problem: '✖', unknown: '?' };

  // Colour is never the only signal: the shape of the icon and the words say the same thing.
  function statusBadge(status) {
    const badge = el('span', { className: 'svc-status svc-' + status.state, 'data-state': status.state, 'data-code': status.code });
    badge.appendChild(el('span', { className: 'svc-icon', 'aria-hidden': 'true', textContent: ICONS[status.state] || '?' }));
    badge.appendChild(el('span', { className: 'svc-status-label', textContent: status.label }));
    return badge;
  }

  const CARD_STATE_WORDS = {
    valid: 'Verified', revoked: 'Revoked by the domain', expired: 'Expired', spent: 'Marked spent by the domain',
    invalid: 'Does not verify', unverified: 'Not verified yet', pending: 'Part of an unfinished transaction'
  };

  const WARNING_TEXT = (w, labels) => {
    if (w.startsWith('duplicate-key:')) return 'This domain\'s manifest names "' + w.slice(14) + '" more than once. The wallet used the last one; the domain should fix it.';
    if (w.startsWith('url-ignored:')) return 'The page address given for ' + (labels[w.slice(12)] || 'a service') + ' is not on this domain, so it is not shown.';
    if (w.startsWith('credential-descriptor-ignored:')) return 'This domain\'s description of the card ' + (labels[w.slice(30)] || 'a service') + ' needs is not valid, so the wallet ignored it.';
    if (w.startsWith('credential-class-ignored:')) return 'This domain names a different card for ' + (labels[w.slice(25)] || 'a service') + ' than the one the wallet uses for it. The wallet kept its own.';
    return '';
  };

  // ---------- the list ----------

  function serviceRow(d, s) {
    const row = el('div', { className: 'svc-service', role: 'group', 'aria-label': s.label + ' at ' + d.domain, 'data-domain': d.domain, 'data-service': s.key });
    const head = el('div', { className: 'svc-service-head' });
    head.appendChild(el('span', { className: 'svc-service-name', textContent: s.label }));
    head.appendChild(statusBadge(s.status));
    row.appendChild(head);
    const bits = [];
    if (s.implied) bits.push('not announced by the domain');
    else if (!s.advertised) bits.push('from the membership card you hold');
    if (s.operates) bits.push(s.enabled ? 'switched on' : 'switched off');
    else bits.push('card shown, service not used from here');
    if (bits.length) row.appendChild(el('div', { className: 'meta', textContent: bits.join(' · ') }));
    if (s.status.state === 'problem') row.appendChild(el('div', { className: 'svc-issue', role: 'status', textContent: s.status.text }));
    const actions = el('div', { className: 'item-actions' });
    actions.appendChild(button(s.status.state === 'problem' ? 'See what needs attention' : 'Settings', () => { view = { domain: d.domain, key: s.key }; mailSettings = null; notice = ''; render(); }, 'svc-open'));
    row.appendChild(actions);
    return row;
  }

  function domainCard(d) {
    const card = el('div', { className: 'info-card svc-domain', role: 'group', 'aria-label': d.domain, 'data-domain': d.domain });
    card.appendChild(el('div', { className: 'svc-domain-name', textContent: d.domain }));
    card.appendChild(el('div', { className: 'meta', textContent: d.fetchedAt ? 'Services read ' + age(d.fetchedAt) : 'Services not read yet' }));
    const labels = {};
    d.services.forEach((s) => { labels[s.key] = s.label; });
    (d.warnings || []).map((w) => WARNING_TEXT(w, labels)).filter(Boolean).forEach((t) => card.appendChild(el('div', { className: 'svc-issue', role: 'status', textContent: t })));
    if (d.problem) card.appendChild(el('div', { className: 'svc-issue', role: 'status', textContent: d.problem + ' Showing what it advertised before.' }));
    if (!d.services.length) card.appendChild(el('div', { className: 'meta', textContent: 'This domain advertises no services that need a membership card.' }));
    d.services.forEach((s) => card.appendChild(serviceRow(d, s)));
    const actions = el('div', { className: 'item-actions' });
    actions.appendChild(button('Refresh', () => act(() => services().refresh(d.domain).then(() => null), 'Read again.'), '', null));
    actions.appendChild(button('Remove…', () => { panel = { kind: 'remove', domain: d.domain, switchedOff: d.services.filter((s) => s.explicit === false).map((s) => s.label) }; render(); }, 'danger-btn'));
    card.appendChild(actions);
    return card;
  }

  // What the domain advertises that needs a card. Services that do not need one are not part of Services; they are only counted.
  function advertisedList(found) {
    const box = el('div', { className: 'svc-advertised' });
    if (!found.services.length) box.appendChild(el('div', { className: 'meta', textContent: 'It advertises no services that need a membership card.' }));
    found.services.forEach((s) => box.appendChild(el('div', { className: 'svc-advertised-item', textContent: s.label + (s.implied ? ' (not announced by the domain; you can still ask for the card)' : '') })));
    if (found.others > 0) box.appendChild(el('div', { className: 'meta', textContent: (found.others === 1 ? 'It advertises one more service that does not' : 'It advertises ' + found.others + ' more services that do not') + ' need a card, so ' + (found.others === 1 ? 'it is' : 'they are') + ' not listed here.' }));
    return box;
  }

  function discoverSection(found) {
    const box = el('div', { className: 'info-card svc-discover', id: 'svcDiscover', role: 'group', 'aria-labelledby': 'svcDiscoverHeading' });
    box.appendChild(el('div', { className: 'name', id: 'svcDiscoverHeading', textContent: 'Services on this domain that need a membership card' }));
    box.appendChild(el('div', { className: 'meta', textContent: 'Currently visiting: ' + found.domain }));
    box.appendChild(advertisedList(found));
    box.appendChild(el('div', { className: 'meta', textContent: 'Nothing has been added, switched on or sent. Adding only lists the domain here.' }));
    if (found.services.length) {
      const actions = el('div', { className: 'item-actions' });
      actions.appendChild(button('Add domain to Services…', () => { panel = { kind: 'add', domain: found.domain, preview: found }; render(); }, '', 'svcDiscoverAdd'));
      box.appendChild(actions);
    }
    return box;
  }

  async function startAdd(input, holdsCard) {
    if (busy) return;
    busy = true;
    notice = '';
    try {
      const found = await services().discover(input);
      const listed = (await services().load()).domains.some((x) => x.domain === found.domain);
      if (listed) throw new Error(found.domain + ' is already in Services.');
      panel = { kind: 'add', domain: found.domain, preview: found, holdsCard: !!holdsCard };
    } catch (err) { notice = err && err.message ? err.message : 'That did not work.'; }
    busy = false;
    await render();
  }

  function addPanel() {
    const p = panel;
    const labels = {};
    p.preview.services.forEach((s) => { labels[s.key] = s.label; });
    const warnings = p.preview.warnings.map((w) => WARNING_TEXT(w, labels)).filter(Boolean);
    // A domain with nothing that needs a card has nothing to list, unless the person already holds one of its cards.
    if (!p.preview.services.length && !p.holdsCard) {
      const none = stepBox(p.domain + ' has nothing to add', ['Services lists what needs a membership card or another credential held in this wallet, and this domain advertises none. Nothing was added or sent.'].concat(warnings), [button('Close', () => { panel = null; render(); }, '', 'svcAddClose')]);
      none.insertBefore(advertisedList(p.preview), none.children[1]);
      return none;
    }
    const lines = ['The wallet will remember this domain and the services it advertises that need a membership card. Nothing is switched on, you are not registered, and nothing about your identity or credentials is sent to it.'];
    const box = stepBox('Add ' + p.domain + ' to Services?', lines.concat(warnings), [
      button('Add domain to Services', () => act(async () => { const d = p.domain; const preview = p.preview; panel = null; await services().addDomain(d, preview); discovery = null; }, 'Added.'), '', 'svcAddConfirm'),
      cancel()
    ]);
    box.insertBefore(advertisedList(p.preview), box.children[1]);
    return box;
  }

  async function listPage(host, data) {
    host.appendChild(el('p', { className: 'meta', textContent: 'Services are what a domain offers that needs a membership card or another credential held in this wallet, such as Global Mail, a Trading Station or Domain Membership. Add a domain to see them, join one, set it up, and switch each on or off. Other documents you hold are under Other documents. This list is kept separately for each identity.' }));
    host.appendChild(el('div', { id: 'servicesStatus', className: 'empty-note', role: 'status', 'aria-live': 'polite', textContent: notice }));
    if (panel && panel.kind === 'remove') {
      const lines = ['It comes off this list, with your on and off choices for it. Your membership cards and any registration at the domain are not touched, and nothing is sent to the domain.'];
      if (panel.switchedOff.length) lines.push('You switched ' + panel.switchedOff.join(', ') + ' off here. Without this entry the wallet goes back to checking for cards you hold there. Keep the domain listed to keep it off.');
      host.appendChild(stepBox('Remove ' + panel.domain + '?', lines, [button('Remove', () => act(async () => { const d = panel.domain; panel = null; await services().removeDomain(d); }, 'Removed.'), 'danger-btn', 'svcRemoveConfirm'), cancel()]));
    }
    if (panel && panel.kind === 'add') host.appendChild(addPanel());
    if (discovery && !panel && !data.domains.some((d) => d.domain === discovery.domain)) host.appendChild(discoverSection(discovery));
    if (!data.domains.length) host.appendChild(el('div', { className: 'empty-note', textContent: 'No domains added yet.' }));
    data.domains.forEach((d) => host.appendChild(domainCard(d)));
    if (data.found.length) {
      host.appendChild(el('div', { className: 'subhead', textContent: 'Found in your wallet' }));
      host.appendChild(el('p', { className: 'meta', textContent: 'You hold membership cards from these domains but have not added them. Adding one shows its services and the cards that belong to them.' }));
      data.found.forEach((f) => {
        const card = el('div', { className: 'info-card svc-found', role: 'group', 'aria-label': f.domain, 'data-domain': f.domain });
        card.appendChild(el('div', { className: 'svc-domain-name', textContent: f.domain }));
        card.appendChild(el('div', { className: 'meta', textContent: 'You hold: ' + f.services.map((s) => s.label).join(', ') }));
        const actions = el('div', { className: 'item-actions' });
        actions.appendChild(button('Add to Services…', () => startAdd(f.domain, true), '', null));
        card.appendChild(actions);
        host.appendChild(card);
      });
    }
    const addRow = el('div', { className: 'btn-row', style: 'margin-top:8px;' });
    const addInput = el('input', { type: 'text', id: 'servicesAddInput', 'aria-label': 'Domain to add', placeholder: 'Domain to add, e.g. example.com', autocomplete: 'off' });
    addRow.appendChild(addInput);
    addRow.appendChild(button('Add…', () => { const box = document.getElementById('servicesAddInput'); const v = box.value.trim(); box.value = ''; if (!v) { say('Type a domain first.'); return; } startAdd(v); }, '', 'servicesAddBtn'));
    host.appendChild(addRow);
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('servicesAddBtn').click(); } });
  }

  // ---------- one service ----------

  function row(label, ...kids) {
    const r = el('div', { className: 'svc-row' });
    r.appendChild(el('div', { className: 'svc-row-label', textContent: label }));
    kids.forEach((k) => r.appendChild(typeof k === 'string' ? el('div', { className: 'meta', textContent: k }) : k));
    return r;
  }

  async function credentialsSection(host, d, s) {
    host.appendChild(el('div', { className: 'subhead', textContent: 'Membership card' }));
    if (!s.credentials.length) {
      host.appendChild(el('div', { className: 'empty-note', textContent: s.operates
        ? 'You have not joined ' + s.label + ' at ' + d.domain + ' with this identity.'
        : 'You do not hold the card ' + s.label + ' needs (' + s.credentialClass + ') from ' + d.domain + ' with this identity.' }));
      if (s.operates && (s.advertised || s.implied)) {
        host.appendChild(el('div', { className: 'item-actions' }, [button('Join…', () => { panel = { kind: 'join', domain: d.domain, key: s.key, label: s.label, implied: !!s.implied }; render(); }, '', 'svcJoin')]));
      }
      return;
    }
    s.credentials.forEach((c) => host.appendChild(el('div', { className: 'meta svc-card-state', 'data-state': c.state, textContent: 'Verification: ' + (CARD_STATE_WORDS[c.state] || c.state) })));
    const list = el('div', { className: 'item-list svc-credentials', id: 'svcCredentials' });
    host.appendChild(list);
    if (cfg.renderCredentials) await cfg.renderCredentials(s.credentials.map((c) => c.entry), list);
  }

  async function mailSection(host, d, s) {
    host.appendChild(el('div', { className: 'subhead', textContent: 'Your Global Mail account at ' + d.domain }));
    if (!mailSettings || mailSettings.domain !== d.domain) {
      host.appendChild(el('div', { className: 'meta', textContent: 'Loading these asks ' + d.domain + ' for your account, with a request signed by the identity shown above.' }));
      host.appendChild(el('div', { className: 'item-actions' }, [button('Load settings from ' + d.domain, () => act(async () => { mailSettings = { domain: d.domain, data: await AtlasWallet.getPostOfficeSettings(d.domain) }; }), '', 'svcLoadSettings')]));
      return;
    }
    const data = mailSettings.data;
    host.appendChild(row('Username (handle)',
      el('input', { type: 'text', id: 'svcHandleInput', 'aria-label': 'Handle', value: data.handle || '', placeholder: 'e.g. bruno', autocomplete: 'off', maxlength: '40' }),
      el('div', { className: 'item-actions' }, [button('Save handle', () => act(async () => { const v = document.getElementById('svcHandleInput').value.trim(); await AtlasWallet.setPostOfficeHandle(d.domain, v); mailSettings = { domain: d.domain, data: await AtlasWallet.getPostOfficeSettings(d.domain) }; }, 'Handle saved.'), '', 'svcHandleSave')])));
    if (data.handle) host.appendChild(el('div', { className: 'meta', id: 'svcHandleShown', textContent: 'People can reach you as ' + data.handle + '#' + d.domain + '.' }));
    const select = el('select', { id: 'svcModeSelect', 'aria-label': 'Who can write to you' });
    [['open', 'Any member of this Post Office'], ['friendsOnly', 'Only your contacts']].forEach(([v, t]) => { const o = el('option', { value: v, textContent: t }); if ((data.mailMode || 'open') === v) o.selected = true; select.appendChild(o); });
    host.appendChild(row('Who can write to you', select,
      el('div', { className: 'meta', textContent: 'Only your contacts shares your contacts’ public keys with ' + d.domain + ' so it can filter.' }),
      el('div', { className: 'item-actions' }, [button('Apply', () => act(async () => { await AtlasWallet.setPostOfficeMailMode(d.domain, document.getElementById('svcModeSelect').value); mailSettings = { domain: d.domain, data: await AtlasWallet.getPostOfficeSettings(d.domain) }; }, 'Saved.'), '', 'svcModeSave')])));
    host.appendChild(el('div', { className: 'meta', id: 'svcBlockedCount', textContent: (data.blockedSenders || []).length + ' blocked sender(s) · ' + (data.friendsCount || 0) + ' contact(s) shared with this domain' }));
    if (cfg.openMail) host.appendChild(el('div', { className: 'item-actions' }, [button('Open Mail settings', () => cfg.openMail(), '', 'svcOpenMail')]));
  }

  // What switching a service on or off does, in words that match what the wallet really sends. One signed mail check per domain
  // carries everything addressed to a card, so Global Mail cannot be switched off for mail alone.
  function enabledNotes(d, s) {
    if (s.key === 'tradingStation') return ['Switching this off only changes what this page shows; the wallet does not contact a Trading Station in the background.'];
    if (s.key === 'membership') {
      return [
        'When on, the wallet presents your Domain Membership card to ' + d.domain + ' with its regular check, so that anything addressed to the card and any notice about it (revoked, replaced, suspended) reaches you.',
        'When off, the card is not presented and none of that arrives.'
      ];
    }
    return [
      'When on, the wallet presents this card to ' + d.domain + ' with a signed check about once a minute while a wallet page is open and unlocked. That one check is also how private mail, friend requests, chat, call invitations and notices about the card (revoked, replaced, suspended) reach you.',
      'When off, the card is not presented, so none of those arrive for it and the wallet will not hear if the domain revokes it. Nothing is sent for it in the background, and nothing else you hold is affected.'
    ];
  }

  // The interval of the automatic check, which is one setting for the whole wallet. One minute is the usual rate; it is a target.
  async function intervalSection(host, d, s) {
    let settings = null;
    try { settings = await AtlasWallet.getMailSettings(); } catch (err) { settings = null; }
    if (!settings) return;
    const minutes = settings.intervalMinutes;
    const line = 'Automatic check: every ' + (minutes === 1 ? 'minute' : minutes + ' minutes') + (settings.intervalIsDefault ? ' (the usual rate)' : ' (a rate you set)') + '. This is a target, not a promise: a check waits while another is running or while the domain asks the wallet to slow down, so mail can arrive a little later.';
    const kids = [el('div', { className: 'meta', id: 'svcInterval', textContent: line }), 'The status above comes from the checks the wallet already makes; it adds no requests of its own.'];
    if (!settings.intervalIsDefault && minutes !== 1) {
      kids.push(el('div', { className: 'item-actions' }, [button('Use the 1-minute default', () => act(async () => { await AtlasWallet.resetMailCheckInterval(); if (cfg.intervalChanged) await cfg.intervalChanged(); }, 'Now checking about once a minute.'), '', 'svcResetInterval')]));
    }
    host.appendChild(row('Checking rate', ...kids));
  }

  async function settingsPage(host, data, current) {
    const d = data.domains.find((x) => x.domain === view.domain);
    const s = d && d.services.find((x) => x.key === view.key);
    if (!s) { view = null; return listPage(host, data); }
    const identity = cfg.identityInfo ? await cfg.identityInfo() : null;
    if (!(await current())) return;
    const page = el('div', { id: 'svcSettings', 'data-domain': d.domain, 'data-service': s.key });
    page.appendChild(el('div', { className: 'btn-row' }, [button('← All services', () => { view = null; mailSettings = null; notice = ''; panel = null; render(); }, '', 'svcBack')]));
    page.appendChild(el('div', { className: 'svc-title', id: 'svcTitle', textContent: s.label + ' — ' + d.domain }));
    const st = el('div', { className: 'svc-status-block', id: 'svcStatusBlock' });
    st.appendChild(statusBadge(s.status));
    st.appendChild(el('div', { className: s.status.state === 'problem' ? 'svc-issue' : 'meta', id: 'svcStatusText', role: 'status', textContent: s.status.text }));
    page.appendChild(st);
    page.appendChild(el('div', { id: 'servicesStatus', className: 'empty-note', role: 'status', 'aria-live': 'polite', textContent: notice }));
    if (panel && panel.kind === 'join') {
      page.appendChild(stepBox('Join ' + panel.label + ' at ' + panel.domain + '?', [
        'The domain will issue a membership card to this identity: ' + (identity ? identity.label + ' (' + shortKey(identity.publicKey) + ')' : 'the identity the wallet is acting as') + '.',
        'You can switch the service off again at any time. Joining does not delete or change anything you already hold.'
      ].concat(panel.implied ? [panel.domain + ' has not announced Domain Membership. This sends the same request as Subscribe inside the domain, and the domain may decline it.'] : []), [button('Join', () => act(async () => { const p = panel; panel = null; await AtlasWallet.joinService(p.domain, p.key); if (cfg.afterJoin) await cfg.afterJoin(); }, 'Joined.'), '', 'svcJoinConfirm'), cancel()]));
    }

    if (s.operates) {
      const box = el('input', { type: 'checkbox', id: 'svcEnabled', checked: !!s.enabled });
      const label = el('label', { className: 'check-row', for: 'svcEnabled' }, [box, el('span', { textContent: 'Service enabled' })]);
      box.addEventListener('change', async () => {
        const want = box.checked;
        if (!(await whenIdle())) { await render(); return; }
        await act(() => services().setEnabled(d.domain, s.key, want).then(() => null));
      });
      page.appendChild(row('Enabled', label, ...enabledNotes(d, s)));
    } else {
      page.appendChild(row('Enabled', 'Not applicable: this wallet shows the card for ' + s.label + ' but does not use the service from here yet.'));
    }
    page.appendChild(row('Identity', identity ? identity.label + ' · ' + shortKey(identity.publicKey) : 'Not available',
      'Services are kept separately for each identity. To use another one, switch identity in the wallet.'));

    await credentialsSection(page, d, s);
    if (s.operates && (s.key === 'postOffice' || s.key === 'membership')) await intervalSection(page, d, s);

    if (s.operates && s.credentials.length && s.explicit !== false) {
      page.appendChild(el('div', { className: 'item-actions' }, [button('Check now', () => act(async () => { await AtlasWallet.checkService(d.domain, s.key); }, 'Checked.'), '', 'svcCheckNow')]));
    }
    if (s.key === 'postOffice' && s.credentials.some((c) => c.state === 'valid')) await mailSection(page, d, s);
    if (s.key === 'tradingStation' && s.credentials.length && cfg.openTrade) page.appendChild(el('div', { className: 'item-actions' }, [button('Open Trade', () => cfg.openTrade(d.domain), '', 'svcOpenTrade')]));
    if (!s.operates) {
      page.appendChild(el('div', { className: 'meta', id: 'svcDeclared', textContent: 'This domain says ' + s.label + ' needs a membership card (' + s.credentialClass + '). The wallet shows the card you hold and whether it verifies, and sends nothing to the domain for this service.' }));
    }
    if (s.url) {
      const a = el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', id: 'svcServiceLink' });
      a.textContent = 'Open this service’s page (' + s.url + ')';
      page.appendChild(el('div', { className: 'svc-link' }, [a]));
    }
    host.appendChild(page);
  }

  // ---------- drawing ----------

  async function render() {
    const host = root();
    if (!host) return;
    const seq = ++renderSeq;
    // A draw belongs to the identity it started for. If the wallet switches meanwhile, what was read is dropped and the redraw
    // that the switch triggers shows the new identity instead.
    const startedFor = await whoKey();
    const current = async () => seq === renderSeq && (await whoKey()) === startedFor;
    host.setAttribute('aria-busy', 'true');
    let data = null, problem = '';
    if (startedFor) {
      try { data = await services().rows(); } catch (err) {
        if (err && err.code === 'identity-changed') return;
        problem = 'Services could not be loaded: ' + (err && err.message ? err.message : 'unknown problem');
      }
    }
    if (!(await current())) return;
    const frag = document.createElement('div');
    frag.appendChild(el('div', { className: 'subhead', id: 'servicesHeading', textContent: view ? 'Service' : 'Services' }));
    if (!startedFor) frag.appendChild(el('div', { className: 'empty-note', textContent: 'Unlock your wallet to see your services.' }));
    else if (problem) frag.appendChild(el('div', { className: 'svc-issue', role: 'status', textContent: problem }));
    else if (view) await settingsPage(frag, data, current);
    else await listPage(frag, data);
    if (!(await current())) return;
    // What was typed into the add box is carried over at the moment of the swap, so text typed while the draw was in flight is kept.
    const typedBox = document.getElementById('servicesAddInput');
    const typed = typedBox ? typedBox.value : '';
    const hadFocus = !!typedBox && document.activeElement === typedBox;
    host.textContent = '';
    while (frag.firstChild) host.appendChild(frag.firstChild);
    host.removeAttribute('aria-busy');
    const box = document.getElementById('servicesAddInput');
    if (box) { if (typed) box.value = typed; if (hadFocus) box.focus(); }
  }

  // The site the person is visiting, if it advertises services and is not on the list yet. One public file is read from that site,
  // only when the tab is opened.
  async function discoverCurrentSite() {
    if (!cfg.currentSite) return;
    const key = await whoKey();
    if (!key) return;
    let site = null;
    try { site = await cfg.currentSite(); } catch (err) { site = null; }
    try {
      if (!site || (await services().load()).domains.some((d) => d.domain === site.domain)) discovery = null;
      else discovery = await services().discover(site.domain);
    } catch (err) { discovery = null; }
    if ((await whoKey()) === key && !panel) await render();
  }

  async function open() {
    discovery = null;
    await render();
    await discoverCurrentSite();
  }

  // Shows the service a credential belongs to, from the inventory or an activity entry.
  async function revealCredential(ref) {
    const domain = ref.domain && AtlasWallet.servicesDomain(ref.domain);
    if (domain && ref.assetClass) {
      const data = await services().rows();
      const d = data.domains.find((x) => x.domain === domain);
      const s = d && d.services.find((x) => x.credentialClass === ref.assetClass);
      view = s ? { domain, key: s.key } : null;
    }
    await render();
  }

  // The wallet now acts as another identity: whatever step was open belonged to the previous one, so it is dropped, any draw still
  // in flight is invalidated, and an open tab is drawn again for the new identity.
  function identityChanged() {
    panel = null; notice = ''; mailSettings = null; discovery = null; view = null;
    renderSeq++;
    const host = root();
    if (!host || !host.offsetParent) return Promise.resolve();
    return open();
  }

  window.AtlasServicesTab = { open, render, identityChanged, configure, revealCredential };
})();
