// The wallet's Activity Log in the real viewer page: collapsible cards (collapsed by default, one line each; any number open
// at once; opening or closing never follows an action link; mouse and keyboard), the entry count in the accordion heading
// following new, recycled and removed entries, the retention choice under Settings -> Profile (50 / 100 / 250 / 500, an
// existing history left alone until a limit is chosen, newest entries kept when it is lowered), and a click on the tab that
// is already showing scrolling the panel's own content back to the top on all five main tabs.
// Scratch Chromium profile, no network.
//
// Run: xvfb-run -a node test/wallet-activity-log-ui.js
'use strict';
const L = require('./call-e2e-lib');
const { check } = L;

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

(async () => {
  const w = await L.launchWallet('activity-log-ui');
  try {
    const me = (await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'activity-log-ui-password')).publicKey;
    const now = Date.now();
    const sameYearPast = new Date(now); sameYearPast.setMonth(0, 5); sameYearPast.setHours(9, 7, 0, 0); // 5 Jan, this year (before today unless today is that day)
    const earlier = Math.min(sameYearPast.getTime(), now - 2 * DAY);
    const older = now - 400 * DAY;
    const leg = (over) => Object.assign({ direction: 'in', assetClass: 'atlas.gold', assetName: 'Gold', symbol: 'AU', domain: 'issuer.example', fungible: true, unit: 'g', quantity: 5, previousBalance: 10, newBalance: 15, assetId: 'urn:atlas:asset:1111' }, over || {});
    const entries = [
      { id: 'act-a', type: 'asset', text: 'Minted 5 atlas.gold from issuer.example', at: iso(now - 60000),
        meta: { kind: 'mint', movement: true, assetId: 'urn:atlas:asset:1111', assetClass: 'atlas.gold', domain: 'issuer.example', legs: [leg()], identity: { label: 'Main identity', publicKey: me }, world: { domain: 'issuer.example', id: 'plaza' }, requestId: 'req-1234' } },
      { id: 'act-b', type: 'trade', text: 'Traded 3 atlas.gold for 7 atlas.silver', at: iso(now - 3600000),
        meta: { kind: 'trade', movement: true, legs: [leg({ direction: 'out', quantity: 3, previousBalance: 15, newBalance: 12 }), leg({ assetClass: 'atlas.silver', assetName: 'Silver', symbol: 'AG', quantity: 7, previousBalance: 0, newBalance: 7, assetId: 'urn:atlas:asset:2222' })], identity: { label: 'Main identity', publicKey: me }, station: 'station.example', offerId: 'offer-9' } },
      { id: 'act-c', type: 'identity', text: 'Wallet password changed', at: iso(earlier), meta: null },
      { id: 'act-d', type: 'asset', text: 'Received 2 g atlas.copper', at: iso(older),
        meta: { kind: 'mail-claim', movement: true, assetClass: 'atlas.copper', assetName: 'Copper', symbol: 'CU', domain: 'issuer.example', fungible: true, quantity: 2, previousBalance: 1, newBalance: 3, source: 'Gift from a friend', messageId: 'msg-1' } }
    ];
    const seed = (list) => w.wallet(async ([pk, l]) => { const { atlasActivityLog } = await chrome.storage.local.get('atlasActivityLog'); const all = atlasActivityLog || {}; all[pk] = l; await chrome.storage.local.set({ atlasActivityLog: all }); }, [me, list]);
    await seed(entries);

    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let dialogs = [];
    let dialogAnswer = true;
    page.on('dialog', async (d) => { dialogs.push(d.message()); if (dialogAnswer) await d.accept(); else await d.dismiss(); });
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof AtlasWallet !== 'undefined' && !!document.getElementById('walletPanel') && typeof routeWalletScreen === 'function', null, { timeout: 15000 });
    const settle = (ms) => new Promise((r) => setTimeout(r, ms || 400));
    const showWallet = async () => { await page.evaluate(async () => { document.getElementById('walletPanel').classList.add('open'); await routeWalletScreen(); }); await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 8000 }); };
    await showWallet();
    await page.waitForFunction(() => document.querySelectorAll('#activityLogList .activity-card').length === 4, null, { timeout: 8000 });

    const heading = () => page.textContent('#activityLogHeading');
    const cardOf = (key) => '#activityLogList .activity-card[data-key="' + key + '"]';
    const state = (key) => page.evaluate((sel) => {
      const c = document.querySelector(sel); if (!c) return null;
      const head = c.querySelector('.activity-head'), body = c.querySelector('.activity-body');
      const vis = (el) => !!el && el.getClientRects().length > 0;
      return { expanded: c.classList.contains('expanded'), aria: head.getAttribute('aria-expanded'), bodyVisible: vis(body), bodyHidden: body.hidden, title: c.querySelector('.name').textContent, time: c.querySelector('.activity-time').textContent, chevron: vis(c.querySelector('.activity-chevron')), visibleText: c.innerText.replace(/\s+/g, ' ').trim() };
    }, cardOf(key));
    const clickHead = (key) => page.click(cardOf(key) + ' .activity-head');
    const openAccordion = () => page.evaluate(() => document.querySelector('.settings-category[data-category="activity-log"]').classList.add('open'));
    await openAccordion();

    console.log('--- the heading shows how many entries are stored ---');
    check('the heading reads "Activity log (4)"', (await heading()) === 'Activity log (4)', await heading());
    check('and is displayed in capitals like the other headings', (await page.evaluate(() => getComputedStyle(document.getElementById('activityLogHeading').parentElement).textTransform)) === 'uppercase');

    console.log('--- cards are collapsed by default ---');
    let all = await Promise.all(['act-a', 'act-b', 'act-c', 'act-d'].map(state));
    check('every card starts collapsed (aria-expanded false, details hidden)', all.every((s) => s && !s.expanded && s.aria === 'false' && s.bodyHidden && !s.bodyVisible), all);
    check('a collapsed card shows the title, a compact time and a chevron, and nothing else', all.every((s) => s.chevron && s.time && s.visibleText === s.title + ' ' + s.time + ' \u25b8'), all.map((s) => s.visibleText));
    check('today\'s time is just hours and minutes', /^\d{2}:\d{2}$/.test(all[0].time) && /^\d{2}:\d{2}$/.test(all[1].time), [all[0].time, all[1].time]);
    check('an earlier one this year adds the day', /^[A-Z][a-z]{2} \d{1,2}, (\d{4}, )?\d{2}:\d{2}$/.test(all[2].time), all[2].time);
    check('a previous year includes the year', /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}$/.test(all[3].time), all[3].time);
    check('the full date and time are still on the time\'s tooltip', await page.evaluate(() => [...document.querySelectorAll('#activityLogList .activity-time')].every((t) => t.title.length > 10 && /^\d{4}-/.test(t.getAttribute('datetime')))));
    const heights = await page.evaluate(() => [...document.querySelectorAll('#activityLogList .activity-card')].map((c) => Math.round(c.getBoundingClientRect().height)));
    check('collapsed cards are compact (one or two lines)', heights.every((h) => h <= 70), heights);

    console.log('--- opening a card shows everything it shows today ---');
    await clickHead('act-b');
    let b = await state('act-b');
    check('clicking a card opens it', b.expanded && b.aria === 'true' && b.bodyVisible && !b.bodyHidden, b);
    for (const piece of ['Issuer:', 'issuer.example', 'Identity:', 'Main identity', 'Trading Station:', 'station.example', 'Gave 3 g Gold (AU)', 'Received 7 g Silver (AG)', 'Previous balance:', 'Change:', 'New balance:', 'Details']) {
      check('the open card shows "' + piece + '"', b.visibleText.includes(piece), b.visibleText);
    }
    check('and the full date and time', /\d{4}|\d{1,2}[/.:]\d{1,2}/.test(await page.textContent(cardOf('act-b') + ' .activity-body .meta')));
    await clickHead('act-a');
    let a = await state('act-a');
    for (const piece of ['Issuer:', 'World:', 'issuer.example/plaza', 'Identity:', 'Main identity', 'Previous balance:', 'Change:', 'New balance:', 'Show in inventory']) {
      check('a mint shows "' + piece + '"', a.visibleText.includes(piece), a.visibleText);
    }
    check('the technical identifiers sit in a Details section that starts closed', await page.evaluate((sel) => { const d = document.querySelector(sel + ' details.activity-tech'); return !!d && !d.open && d.textContent.includes('req-1234') && d.textContent.includes('urn:atlas:asset:1111'); }, cardOf('act-a')));
    await clickHead('act-d');
    const d0 = await state('act-d');
    check('an older mail-claim entry opens with its source and balances', d0.visibleText.includes('Gift from a friend') && d0.visibleText.includes('New balance:') && d0.visibleText.includes('Issuer:'), d0.visibleText);
    await clickHead('act-d');

    console.log('--- several cards stay open together ---');
    const open2 = await Promise.all(['act-a', 'act-b'].map(state));
    check('two cards are open at the same time', open2.every((s) => s.expanded && s.bodyVisible));
    await clickHead('act-b');
    const afterClose = await Promise.all(['act-a', 'act-b'].map(state));
    check('closing one leaves the other open', afterClose[0].expanded && !afterClose[1].expanded && !afterClose[1].bodyVisible, afterClose);
    await clickHead('act-b'); await clickHead('act-c');
    check('three open at once', (await Promise.all(['act-a', 'act-b', 'act-c'].map(state))).every((s) => s.expanded));
    const c0 = await state('act-c');
    check('an entry with no extra details still opens, showing its full time', c0.expanded && c0.bodyVisible && c0.visibleText.length > c0.title.length, c0);

    console.log('--- opening and closing never follows an action link ---');
    await page.evaluate(() => { window.__follow = []; window.showAssetInInventory = (ref) => { window.__follow.push(ref); }; });
    await clickHead('act-a'); await clickHead('act-a'); await clickHead('act-a');
    await page.focus(cardOf('act-a') + ' .activity-head'); await page.keyboard.press('Enter'); await page.keyboard.press(' ');
    check('toggling a card with the mouse and the keyboard follows nothing', (await page.evaluate(() => window.__follow.length)) === 0);
    if (!(await state('act-a')).expanded) await clickHead('act-a');
    check('the link is a separate button inside the details', await page.evaluate((sel) => { const go = document.querySelector(sel + ' .activity-body button.activity-go'); return !!go && !document.querySelector(sel + ' .activity-head').contains(go); }, cardOf('act-a')));
    check('a card with no inventory item has no link', (await page.locator(cardOf('act-c') + ' .activity-go').count()) === 0);
    await page.click(cardOf('act-a') + ' .activity-go');
    check('the link itself still works, and opens that item', await page.evaluate(() => window.__follow.length === 1 && window.__follow[0].id === 'urn:atlas:asset:1111'), await page.evaluate(() => window.__follow));
    check('using the link does not close the card', (await state('act-a')).expanded);
    await page.focus(cardOf('act-a') + ' .activity-go'); await page.keyboard.press('Enter');
    check('and works from the keyboard too', (await page.evaluate(() => window.__follow.length)) === 2);
    await page.click(cardOf('act-a') + ' details.activity-tech summary');
    check('opening the Details section neither closes the card nor follows the link', (await state('act-a')).expanded && (await page.evaluate((sel) => document.querySelector(sel + ' details').open, cardOf('act-a'))) && (await page.evaluate(() => window.__follow.length)) === 2);

    console.log('--- keyboard ---');
    await page.focus(cardOf('act-d') + ' .activity-head');
    await page.keyboard.press('Enter');
    check('Enter opens a focused card', (await state('act-d')).expanded);
    await page.keyboard.press('Space');
    check('Space closes it', !(await state('act-d')).expanded);
    check('the card head is a real button reachable by Tab, with aria-expanded and aria-controls', await page.evaluate((sel) => { const h = document.querySelector(sel + ' .activity-head'); return h.tagName === 'BUTTON' && h.tabIndex === 0 && h.getAttribute('aria-controls') === document.querySelector(sel + ' .activity-body').id; }, cardOf('act-d')));
    await page.focus(cardOf('act-c') + ' .activity-head');
    await page.keyboard.press('Tab');
    check('Tab from an open card with nothing to follow goes on to the next card\'s head', (await page.evaluate(() => document.activeElement.classList.contains('activity-head') && document.activeElement.closest('.activity-card').dataset.key)) === 'act-d');

    console.log('--- open cards stay open while the list refreshes ---');
    await page.evaluate(() => refreshActivityLogDisplay());
    check('a refresh keeps the cards that were open open', (await Promise.all(['act-a', 'act-c'].map(state))).every((s) => s.expanded) && !(await state('act-d')).expanded);
    await page.focus(cardOf('act-d') + ' .activity-head');
    await page.evaluate(() => refreshActivityLogDisplay());
    check('and keyboard focus stays on the same card', await page.evaluate(() => document.activeElement.classList.contains('activity-head') && document.activeElement.closest('.activity-card').dataset.key === 'act-d'));

    console.log('--- the count follows new entries ---');
    await w.wallet(() => AtlasWallet.changePassword('activity-log-ui-password', 'activity-log-ui-password-2'));
    await page.waitForFunction(() => document.getElementById('activityLogHeading').textContent === 'Activity log (5)', null, { timeout: 8000 });
    check('a new entry raises the count in the heading without reopening anything', (await heading()) === 'Activity log (5)');
    const newest = await page.evaluate(() => document.querySelector('#activityLogList .activity-card .name').textContent);
    check('and the new entry is first, collapsed, with the open ones still open', newest === 'Wallet password changed' && !(await page.evaluate(() => document.querySelector('#activityLogList .activity-card').classList.contains('expanded'))) && (await state('act-a')).expanded);

    console.log('--- retention: the control ---');
    await page.evaluate(async () => { await openSettings(); document.querySelector('.settings-category[data-category="profile"]').classList.add('open'); });
    const opts = async () => page.evaluate(() => [...document.querySelectorAll('#activityLogRetentionSelect option')].map((o) => ({ v: o.value, t: o.textContent, sel: o.selected })));
    let o = await opts();
    check('Settings -> Profile offers 50 Small, 100 Standard (recommended), 250 Extended and 500 Maximum', o.map((x) => x.t).join('|') === '50 entries — Small|100 entries — Standard (recommended)|250 entries — Extended|500 entries — Maximum', o);
    check('a small history on an identity that has not chosen shows the recommended Standard', o.find((x) => x.sel).v === '100', o);
    check('the section says what it affects and that nothing else changes', /oldest entry is recycled/.test(await page.textContent('[data-category="profile"] .settings-category-body')) && /never changed/.test(await page.textContent('[data-category="profile"] .settings-category-body')));

    console.log('--- retention: an existing history is left alone until a limit is chosen ---');
    const big = Array.from({ length: 130 }, (_, i) => ({ id: 'old-' + i, type: 'asset', text: 'entry ' + (130 - i), at: iso(now - (i + 5) * 60000), meta: null }));
    await seed(big);
    await page.waitForFunction(() => document.getElementById('activityLogHeading').textContent === 'Activity log (130)', null, { timeout: 8000 });
    await page.evaluate(() => openSettings());
    o = await opts();
    check('130 stored entries and no choice: all 130 shown in the heading, none removed', (await heading()) === 'Activity log (130)' && (await page.locator('#activityLogList .activity-card').count()) === 130);
    check('the control says the history is being kept whole and offers all four choices', o[0].v === '' && o[0].sel && /Not chosen yet.*keeping all 130 entries/.test(o[0].t) && o.length === 5, o);
    await page.evaluate(() => AtlasWallet.getActivityLog());
    await page.reload(); await page.waitForFunction(() => typeof routeWalletScreen === 'function'); await showWallet();
    check('reloading the wallet does not truncate it either', (await w.wallet(async (pk) => (await AtlasWallet.getActivityLog()).length)) === 130);
    await page.evaluate(async () => { document.querySelector('.settings-category[data-category="activity-log"]').classList.add('open'); await openSettings(); document.querySelector('.settings-category[data-category="profile"]').classList.add('open'); });

    console.log('--- retention: choosing a limit ---');
    const otherKeys = () => w.wallet(async () => { const all = await chrome.storage.local.get(null); delete all.atlasActivityLog; delete all.atlasActivityLogRetention; delete all.atlasStatusHistory; return JSON.stringify(all); });
    const keysBefore = await otherKeys();
    dialogs = []; dialogAnswer = false;
    await page.selectOption('#activityLogRetentionSelect', '50');
    await settle(600);
    check('lowering below what is stored asks first, and says how many will go and that nothing else is touched', dialogs.length === 1 && /newest 50/.test(dialogs[0]) && /80 oldest entries/.test(dialogs[0]) && /items, credentials and history at issuers are not affected/.test(dialogs[0]), dialogs);
    check('declining changes nothing: still 130 entries, and the control goes back to where it was', (await heading()) === 'Activity log (130)' && (await page.inputValue('#activityLogRetentionSelect')) === '' && (await w.wallet(async () => (await AtlasWallet.getActivityLogRetention()).chosen)) === null);
    dialogAnswer = true; dialogs = [];
    await page.selectOption('#activityLogRetentionSelect', '250');
    await settle(600);
    check('choosing a larger limit removes nothing and asks nothing', dialogs.length === 0 && (await heading()) === 'Activity log (130)' && (await page.inputValue('#activityLogRetentionSelect')) === '250' && (await page.textContent('#activityLogRetentionStatus')) === 'Saved.');
    check('the placeholder is gone once a limit is chosen', (await opts()).length === 4);
    await page.selectOption('#activityLogRetentionSelect', '50');
    await page.waitForFunction(() => document.getElementById('activityLogHeading').textContent === 'Activity log (50)', null, { timeout: 8000 });
    check('accepting keeps the newest 50 and updates the heading', (await heading()) === 'Activity log (50)' && /newest 50/.test(dialogs[0]) && /80 oldest/.test(dialogs[0]), dialogs);
    const names = await page.evaluate(() => [...document.querySelectorAll('#activityLogList .activity-card .name')].map((n) => n.textContent));
    check('they are the newest ones, in order', names.length === 50 && names[0] === 'entry 130' && names[49] === 'entry 81', [names[0], names[49], names.length]);
    check('the status line says what happened', /Saved\. The newest 50 entries are kept; the 80 oldest were removed\./.test(await page.textContent('#activityLogRetentionStatus')), await page.textContent('#activityLogRetentionStatus'));
    check('the choice is stored encrypted, with the log', await w.wallet(async () => { const { atlasActivityLogRetention, atlasActivityLog } = await chrome.storage.local.get(['atlasActivityLogRetention', 'atlasActivityLog']); return JSON.stringify(atlasActivityLogRetention).includes('__atlasEncrypted') && JSON.stringify(atlasActivityLog).includes('__atlasEncrypted') && !JSON.stringify(atlasActivityLog).includes('entry 100'); }));
    check('nothing outside the Activity Log changed (wallet, credentials, holdings, status messages)', (await otherKeys()) === keysBefore);

    console.log('--- retention: the count tracks recycling ---');
    await w.wallet(() => AtlasWallet.changePassword('activity-log-ui-password-2', 'activity-log-ui-password-3'));
    await w.wallet(() => AtlasWallet.changePassword('activity-log-ui-password-3', 'activity-log-ui-password-2'));
    await w.wallet(() => AtlasWallet.changePassword('activity-log-ui-password-2', 'activity-log-ui-password-3'));
    await settle(800);
    check('at the limit new entries recycle the oldest, so the count holds at 50', (await heading()) === 'Activity log (50)' && (await page.locator('#activityLogList .activity-card').count()) === 50);
    check('and the oldest shown moved on by three', (await page.evaluate(() => [...document.querySelectorAll('#activityLogList .activity-card .name')].pop().textContent)) === 'entry 84');
    await page.selectOption('#activityLogRetentionSelect', '500');
    await settle(600);
    check('Maximum is accepted', (await w.wallet(async () => (await AtlasWallet.getActivityLogRetention()).chosen)) === 500 && (await heading()) === 'Activity log (50)');

    console.log('--- the status-message history is separate ---');
    check('it still keeps its own twenty', await w.wallet(async () => { for (let i = 0; i < 25; i++) await AtlasWallet.recordStatusMessage('status ' + i); return (await AtlasWallet.getStatusHistory()).length === 20; }));

    console.log('--- clearing ---');
    await showWallet();
    await page.evaluate(() => { document.querySelector('.settings-category[data-category="activity-log"]').classList.add('open'); });
    await page.click('#clearActivityLogBtn');
    await page.waitForFunction(() => document.getElementById('activityLogHeading').textContent === 'Activity log (0)', null, { timeout: 8000 });
    check('Clear log empties the list and the count', (await heading()) === 'Activity log (0)' && (await page.textContent('#activityLogList')).includes('Nothing logged yet.'));

    console.log('--- narrow window ---');
    await page.setViewportSize({ width: 340, height: 560 });
    await seed(entries);
    await page.waitForFunction(() => document.querySelectorAll('#activityLogList .activity-card').length === 4, null, { timeout: 8000 });
    await showWallet();
    await clickHead('act-b'); await clickHead('act-a');
    const fit = await page.evaluate(() => { const cards = [...document.querySelectorAll('#activityLogList .activity-card')]; const panel = document.getElementById('walletPanel'); return { overflowX: panel.scrollWidth > panel.clientWidth + 1, cards: cards.every((c) => { const r = c.getBoundingClientRect(), pr = panel.getBoundingClientRect(); return r.left >= pr.left && r.right <= pr.right; }), inner: [...document.querySelectorAll('#activityLogList .activity-body')].every((b) => b.scrollWidth <= b.clientWidth + 1) }; });
    check('cards, open ones included, fit inside the 360px wallet panel with no sideways scrolling', !fit.overflowX && fit.cards && fit.inner, fit);
    await page.setViewportSize({ width: 1280, height: 800 });

    console.log('--- clicking the active tab scrolls to the top (all five tabs) ---');
    const tabs = [
      { id: 'walletTabBtn', screen: 'mainWalletScreen' },
      { id: 'socialTabBtn', screen: 'socialScreen' },
      { id: 'tradeTabBtn', screen: 'tradeScreen' },
      { id: 'characterTabBtn', screen: 'characterScreen' },
      { id: 'settingsTabBtn', screen: 'settingsScreen' }
    ];
    await page.evaluate(() => {
      window.__scrolls = [];
      const panel = document.getElementById('walletPanel');
      const real = panel.scrollTo.bind(panel);
      panel.scrollTo = (opts) => { window.__scrolls.push(opts); return real(opts); };
    });
    // Each screen is made taller than the panel so there is somewhere to scroll from.
    const makeTall = (screenId) => page.evaluate((id) => { const s = document.getElementById(id); let pad = s.querySelector('.__tall'); if (!pad) { pad = document.createElement('div'); pad.className = '__tall'; pad.style.cssText = 'height:3000px'; s.appendChild(pad); } }, screenId);
    const scrollTop = () => page.evaluate(() => document.getElementById('walletPanel').scrollTop);
    const pageScroll = () => page.evaluate(() => window.scrollY + document.documentElement.scrollTop + document.body.scrollTop);
    await page.evaluate(() => document.querySelector('.settings-category[data-category="activity-log"]').classList.add('open'));
    for (const t of tabs) {
      await page.click('#' + t.id);
      await page.waitForFunction((s) => document.getElementById(s).classList.contains('active'), t.screen, { timeout: 8000 });
      await settle(700);
      await makeTall(t.screen);
      await page.evaluate(() => { window.__scrolls.length = 0; document.getElementById('walletPanel').scrollTop = 900; });
      await settle(100);
      const before = await scrollTop();
      const accordionsBefore = await page.evaluate(() => [...document.querySelectorAll('.settings-category.open')].map((c) => c.dataset.category).join());
      await page.click('#' + t.id);
      const mid = await scrollTop();
      await page.waitForFunction(() => document.getElementById('walletPanel').scrollTop === 0, null, { timeout: 5000 }).catch(() => {});
      const after = await scrollTop();
      const calls = await page.evaluate(() => window.__scrolls.slice());
      check(t.id + ': the panel was scrolled down first (' + before + 'px)', before > 300, before);
      check(t.id + ': clicking the tab that is already showing smoothly scrolls the wallet content back to the top', after === 0 && calls.length === 1 && calls[0].top === 0 && calls[0].behavior === 'smooth', { before, mid, after, calls });
      check(t.id + ': it stays the current tab', await page.evaluate((s) => document.getElementById(s).classList.contains('active'), t.screen) && await page.evaluate((id) => document.getElementById(id).classList.contains('active-tab'), t.id));
      check(t.id + ': the open accordion sections are as they were', (await page.evaluate(() => [...document.querySelectorAll('.settings-category.open')].map((c) => c.dataset.category).join())) === accordionsBefore);
      check(t.id + ': the page behind the wallet did not scroll', (await pageScroll()) === 0);
      check(t.id + ': the tab bar is still in view', await page.evaluate(() => { const r = document.getElementById('walletTabBar').getBoundingClientRect(); const p = document.getElementById('walletPanel').getBoundingClientRect(); return Math.abs(r.top - p.top) < 2; }));
    }

    console.log('--- switching tabs is unchanged ---');
    await page.click('#settingsTabBtn'); await settle(500);
    await page.evaluate(() => { window.__scrolls.length = 0; document.getElementById('walletPanel').scrollTop = 600; });
    await page.click('#tradeTabBtn');
    await page.waitForFunction(() => document.getElementById('tradeScreen').classList.contains('active'));
    await settle(500);
    check('moving to a different tab does not trigger the scroll-to-top', (await page.evaluate(() => window.__scrolls.length)) === 0);
    check('and lands on that tab as before', await page.evaluate(() => document.getElementById('tradeTabBtn').classList.contains('active-tab') && !document.getElementById('settingsTabBtn').classList.contains('active-tab')));

    console.log('--- keyboard ---');
    for (const key of ['Enter', ' ']) {
      await makeTall('tradeScreen');
      await page.evaluate(() => { window.__scrolls.length = 0; document.getElementById('walletPanel').scrollTop = 700; });
      await page.focus('#tradeTabBtn');
      await page.keyboard.press(key);
      await page.waitForFunction(() => document.getElementById('walletPanel').scrollTop === 0, null, { timeout: 5000 }).catch(() => {});
      check((key === ' ' ? 'Space' : key) + ' on the focused active tab scrolls to the top', (await scrollTop()) === 0 && (await page.evaluate(() => window.__scrolls.length)) === 1);
    }

    console.log('--- reduced motion ---');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { window.__scrolls.length = 0; document.getElementById('walletPanel').scrollTop = 800; });
    await page.click('#tradeTabBtn');
    const calls = await page.evaluate(() => window.__scrolls.slice());
    check('with reduced motion requested the jump is immediate, not animated', calls.length === 1 && calls[0].top === 0 && calls[0].behavior === 'auto', calls);
    await page.waitForFunction(() => document.getElementById('walletPanel').scrollTop === 0, null, { timeout: 3000 });
    check('and it still reaches the top', (await scrollTop()) === 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    console.log('--- narrow window ---');
    await page.setViewportSize({ width: 340, height: 520 });
    await page.evaluate(() => { window.__scrolls.length = 0; document.getElementById('walletPanel').scrollTop = 800; });
    await page.click('#tradeTabBtn');
    await page.waitForFunction(() => document.getElementById('walletPanel').scrollTop === 0, null, { timeout: 5000 });
    check('works in a 340px window, with the tab bar still on screen', (await scrollTop()) === 0 && await page.evaluate(() => { const r = document.getElementById('tradeTabBtn').getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth && r.left >= 0; }));

    check('no page errors', errors.length === 0, errors);
  } finally {
    await w.close();
  }
  process.exit(L.finish('wallet-activity-log-ui'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
