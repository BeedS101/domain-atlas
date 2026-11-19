// The wallet's recent-messages dropdown in the real viewer page: every message the top-bar status line shows is
// captured, listed newest first with a time and a kind, capped at twenty, kept across a reload, copied as plain text and
// cleared, with mouse and keyboard, in a narrow window, and without changing what the status line itself shows.
// Scratch Chromium profile, no network.
//
// Run: xvfb-run -a node test/wallet-status-history-ui.js
'use strict';
const L = require('./call-e2e-lib');
const { check } = L;

(async () => {
  const w = await L.launchWallet('status-history-ui');
  try {
    await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'status-history-ui-password');
    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const open = async () => { await page.goto('chrome-extension://' + w.extId + '/viewer.html'); await page.waitForFunction(() => typeof AtlasWallet !== 'undefined' && !!document.getElementById('statusHistoryPanel'), null, { timeout: 15000 }); };
    await open();

    const say = (messages) => page.evaluate((list) => { const el = document.getElementById('status'); for (const m of list) el.textContent = m; }, messages);
    const shownItems = () => page.evaluate(() => [...document.querySelectorAll('#statusHistoryList li:not(.sh-empty)')].map((li) => ({
      cls: li.className, text: li.querySelector('.sh-text').textContent, level: li.querySelector('.sh-level').textContent,
      at: li.querySelector('time').getAttribute('datetime'), label: li.querySelector('time').textContent
    })));
    const panelOpen = () => page.evaluate(() => !document.getElementById('statusHistoryPanel').hidden);
    const stored = () => w.wallet(async () => { const { atlasStatusHistory } = await chrome.storage.local.get('atlasStatusHistory'); return atlasStatusHistory || null; });
    const settle = (ms) => new Promise((r) => setTimeout(r, ms || 400));
    const openPanel = async () => { await page.click('#status'); await page.waitForFunction(() => !document.getElementById('statusHistoryPanel').hidden && document.activeElement && document.activeElement.id === 'statusHistoryPanel'); };
    const clearAll = async () => { await settle(1200); if (!(await panelOpen())) await openPanel(); await page.click('#statusHistoryClear', { timeout: 3000 }).catch(() => {}); await settle(); await page.keyboard.press('Escape'); };

    await clearAll();

    console.log('--- the status line itself is unchanged ---');
    await say(['Picked it up.', 'Drop failed: the hosting domain refused it', 'This requires an unlocked wallet identity.']);
    check('the top bar shows the latest message exactly as before', (await page.textContent('#status')) === 'This requires an unlocked wallet identity.');
    await say(['']);
    check('an emptied status line stays empty (the history is not echoed into it)', (await page.textContent('#status')) === '');

    console.log('--- opening with the mouse ---');
    check('the dropdown is closed to begin with', !(await panelOpen()) && (await page.getAttribute('#status', 'aria-expanded')) === 'false');
    await settle();
    await openPanel();
    check('clicking the status area opens it', (await panelOpen()) && (await page.getAttribute('#status', 'aria-expanded')) === 'true');
    let items = await shownItems();
    check('three messages were captured, newest first', items.map((i) => i.text).join('|') === 'This requires an unlocked wallet identity.|Drop failed: the hosting domain refused it|Picked it up.', items.map((i) => i.text));
    check('each shows a time and a kind that tells errors, warnings and successes apart', items.map((i) => i.level).join() === 'Warning,Error,Success' && items.every((i) => /^\d{4}-\d{2}-\d{2}T/.test(i.at) && i.label.length >= 5), items);
    check('the kinds also set the row styling (not colour alone: a label is shown)', items.map((i) => i.cls).join() === 'sh-warning,sh-error,sh-success', items.map((i) => i.cls));
    check('times run newest to oldest', items[0].at >= items[1].at && items[1].at >= items[2].at);
    await page.click('#status');
    check('clicking the status area again closes it', !(await panelOpen()));
    await openPanel();
    await page.mouse.click(40, 300);
    check('clicking elsewhere closes it', !(await panelOpen()));

    console.log('--- keyboard ---');
    await page.focus('#status');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.getElementById('statusHistoryPanel').hidden);
    check('Enter on the status area opens it and moves focus into it', (await panelOpen()) && (await page.evaluate(() => document.activeElement.id)) === 'statusHistoryPanel');
    const order = [];
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.id)); }
    check('Tab reaches Copy log, Clear history, Close and the list, in that order, all inside the dropdown', order.join() === 'statusHistoryCopy,statusHistoryClear,statusHistoryClose,statusHistoryList', order);
    await page.keyboard.press('Escape');
    check('Escape closes it and returns focus to the status area', !(await panelOpen()) && (await page.evaluate(() => document.activeElement.id)) === 'status');
    await page.keyboard.press(' ');
    await page.waitForFunction(() => !document.getElementById('statusHistoryPanel').hidden && document.activeElement.id === 'statusHistoryPanel');
    check('Space opens it too', await panelOpen());
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    check('tabbing past the end of the dropdown closes it and returns focus to the status area', !(await panelOpen()) && (await page.evaluate(() => document.activeElement.id)) === 'status');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.getElementById('statusHistoryPanel').hidden && document.activeElement.id === 'statusHistoryPanel');
    await page.keyboard.press('Shift+Tab');
    check('Shift+Tab out of the start of the dropdown closes it the same way', !(await panelOpen()) && (await page.evaluate(() => document.activeElement.id)) === 'status');

    console.log('--- the 20-message limit ---');
    await clearAll();
    await say(Array.from({ length: 25 }, (_, i) => 'msg ' + (i + 1)));
    await settle(800);
    await openPanel();
    items = await shownItems();
    check('twenty messages are listed', items.length === 20, items.length);
    check('the newest is first and the five oldest were dropped', items[0].text === 'msg 25' && items[19].text === 'msg 6', [items[0] && items[0].text, items[19] && items[19].text]);
    const keptStored = await stored();
    check('what is stored is encrypted and no longer than twenty', JSON.stringify(keptStored).includes('__atlasEncrypted') && !JSON.stringify(keptStored).includes('msg 25'));
    await page.keyboard.press('Escape');

    console.log('--- live update while open ---');
    await openPanel();
    await say(['a message while the list is open']);
    await page.waitForFunction(() => document.querySelector('#statusHistoryList li .sh-text') && document.querySelector('#statusHistoryList li .sh-text').textContent === 'a message while the list is open');
    check('a new message appears at the top without reopening, still twenty rows', (await shownItems()).length === 20);
    await page.keyboard.press('Escape');

    console.log('--- survives a reload ---');
    await clearAll();
    await say(['persisted one', 'persisted two', 'persisted three']);
    await settle(800);
    await open();
    await settle(800);
    await openPanel();
    const texts = (await shownItems()).map((i) => i.text);
    const at = texts.indexOf('persisted three');
    check('earlier messages are still there after the page was reloaded, in order, behind whatever the reload itself said', at >= 0 && texts.slice(at, at + 3).join('|') === 'persisted three|persisted two|persisted one' && texts.length <= 20, texts);
    await page.keyboard.press('Escape');

    console.log('--- copy log ---');
    await clearAll();
    await say(['Picked it up.', 'Drop failed: boom']);
    await settle(800);
    await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
    await openPanel();
    const rows = await shownItems();
    await page.click('#statusHistoryCopy');
    const copied = await page.evaluate(() => window.__copied);
    const copiedLines = (copied || '').split('\n');
    check('Copy log copies one plain-text line per displayed message, newest first, each with its timestamp and kind', copiedLines.length === rows.length && rows.every((r, i) => copiedLines[i] === r.at + ' [' + r.level.toLowerCase() + '] ' + r.text), { copied, rows });
    check('the button confirms it, without writing into the status line', (await page.textContent('#statusHistoryCopy')) === 'Copied' && (await page.textContent('#status')) === 'Drop failed: boom');
    await page.waitForFunction(() => document.getElementById('statusHistoryCopy').textContent === 'Copy log', null, { timeout: 4000 });
    await page.evaluate(() => {
      window.__fallbackCopied = null;
      navigator.clipboard.writeText = async () => { throw new Error('refused'); };
      document.addEventListener('copy', (e) => { const t = e.target; window.__fallbackCopied = t && typeof t.value === 'string' ? t.value.substring(t.selectionStart, t.selectionEnd) : null; }, true);
    });
    await page.click('#statusHistoryCopy');
    check('when the clipboard API is refused, a copy command still copies the same text', (await page.evaluate(() => window.__fallbackCopied)) === copied, await page.evaluate(() => window.__fallbackCopied));
    check('copying added nothing to the history', (await shownItems()).length === rows.length);

    console.log('--- clear history ---');
    const keysBefore = await w.wallet(async () => { const all = await chrome.storage.local.get(null); delete all.atlasStatusHistory; return JSON.stringify(all); });
    await page.click('#statusHistoryClear');
    await page.waitForFunction(() => document.querySelectorAll('#statusHistoryList li.sh-empty').length === 1);
    check('Clear history empties the list and says so', (await shownItems()).length === 0 && (await page.textContent('#statusHistoryList')).includes('No messages yet.'));
    check('Copy log and Clear history are disabled when there is nothing to act on', await page.evaluate(() => document.getElementById('statusHistoryCopy').disabled && document.getElementById('statusHistoryClear').disabled));
    check('the stored history for this identity is gone', (await stored()) === null || Object.keys(await stored()).length === 0);
    const keysAfter = await w.wallet(async () => { const all = await chrome.storage.local.get(null); delete all.atlasStatusHistory; return JSON.stringify(all); });
    check('nothing else in extension storage changed (the Activity Log and wallet are untouched)', keysBefore === keysAfter);
    check('the status line itself still shows the last message', (await page.textContent('#status')) === 'Drop failed: boom');
    check('focus stays inside the dropdown', await page.evaluate(() => document.getElementById('statusHistoryPanel').contains(document.activeElement)));
    await page.keyboard.press('Escape');

    console.log('--- nothing sensitive is listed ---');
    const secret = 'A'.repeat(60);
    await say(['Pick up failed: ' + JSON.stringify({ signature: secret, error: 'refused', credential: { proof: secret } }), 'Failed: Bearer ' + secret]);
    await settle(800);
    await openPanel();
    const listed = (await shownItems()).map((i) => i.text).join('\n');
    check('keys, tokens and request bodies are not shown', !listed.includes('AAAAAAAA') && listed.includes('Pick up failed: refused'), listed);
    check('and not stored', !JSON.stringify(await stored()).includes('AAAAAAAA'));
    await page.keyboard.press('Escape');

    console.log('--- narrow window ---');
    await say(['A long message to wrap: ' + 'word '.repeat(60)]);
    await settle(800);
    await page.setViewportSize({ width: 340, height: 520 });
    await openPanel();
    const box = await page.evaluate(() => { const r = document.getElementById('statusHistoryPanel').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight, scrollW: document.getElementById('statusHistoryList').scrollWidth, clientW: document.getElementById('statusHistoryList').clientWidth }; });
    check('the dropdown fits inside a 340px window', box.left >= 0 && box.right <= box.w && box.bottom <= box.h, box);
    check('long messages wrap instead of scrolling sideways', box.scrollW <= box.clientW + 1, box);
    const reachable = await page.evaluate(() => ['statusHistoryCopy', 'statusHistoryClear', 'statusHistoryClose'].every((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth && r.left >= 0; }));
    check('all three buttons stay on screen', reachable);
    await page.click('#statusHistoryClose');
    check('the close button works with the mouse', !(await panelOpen()));

    check('no page errors', errors.length === 0, errors);
  } finally {
    await w.close();
  }
  process.exit(L.finish('wallet-status-history-ui'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
