// The scanner page (chain-labs/scan35.html) in a real browser against live PHP servers: a public coin, a private coin and a
// multi authority coin; every view, the paging, the verification button, damage to the data on its way to the page, and text
// from the server that tries to become markup.
//
//   xvfb-run -a node test/manual-chain-labs-scanner.js
'use strict';
const http = require('http');
const S = require('./support/chain-labs-servers');
const { A, B, C, nodes, start, wallet, createCoin, op, post, transfer } = S;
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/home/claude/.npm-global/lib/node_modules/playwright'); }

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const keysIn = (text) => (text.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{87}(?![A-Za-z0-9_-])/g) || []).filter((x) => { const b = Buffer.from(x, 'base64url'); return b.length === 65 && b[0] === 4; });

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A];
  const browser = await playwright.chromium.launch();
  try {
    const alice = wallet(), bob = wallet();
    const pub = (await createCoin(a, 'PUB')).json, prv = (await createCoin(a, 'PRV', { visibility: 'private' })).json;
    const mul = (await createCoin(a, 'MUL', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    for (const coin of [pub, prv, mul]) await op(a, 'open', { coinId: coin.id });
    for (let i = 0; i < 58; i++) await op(a, 'grant', { coinId: pub.id, to: i % 2 ? alice.key : bob.key, amount: '1' });
    for (const coin of [prv, mul]) {
      await op(a, 'grant', { coinId: coin.id, to: alice.key, amount: '500' });
      await post(a, 'action=propose', { authorization: await transfer(alice, a, coin.id, bob.key, '40') });
    }
    for (const n of [nodes[B], nodes[C]]) await S.get(n, 'action=coin&coin=' + mul.id);

    const context = await browser.newContext();
    const state = { tamper: null, inject: false };
    await context.route(/^https:\/\/[abc]\.example\/chain-labs\//, async (route) => {
      const u = new URL(route.request().url());
      const n = nodes[u.hostname];
      try {
        const res = await route.fetch({ url: 'http://127.0.0.1:' + n.port + u.pathname.replace(/^\/chain-labs/, '') + u.search, headers: { ...route.request().headers(), host: u.hostname } });
        let body = await res.text();
        const action = u.searchParams.get('action');
        if (state.tamper && action === 'entries' && u.pathname.endsWith('.php')) body = state.tamper(JSON.parse(body));
        if (state.inject && action === 'coins') { const j = JSON.parse(body); j.coins[0].name = '<img src=x onerror="window.__xss=1">'; j.coins[0].symbol = '<script>window.__xss=2</script>'; body = JSON.stringify(j); }
        await route.fulfill({ status: res.status(), headers: { 'content-type': res.headers()['content-type'] || 'text/html' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      } catch (e) { await route.abort('connectionrefused'); }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // The 404 answers of the wrong-address checks are logged by the browser itself; the page's own errors are not.
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    const base = 'https://a.example/chain-labs/scan35.html';
    const go = async (hash) => { await page.goto(base + '#' + hash); await page.waitForFunction(() => !/^Loading/.test(document.getElementById('view').innerText), null, { timeout: 15000 }); };
    const text = () => page.evaluate(() => document.getElementById('view').innerText);
    const seen = { private: [] };
    const remember = async (into) => { into.push(await page.evaluate(() => document.documentElement.outerHTML + '\n' + document.body.innerText)); };

    console.log('== coins');
    await go('/coins');
    let t = await text();
    line(/Coins on a\.example/.test(t) && /PUB/.test(t) && /PRV/.test(t) && /MUL/.test(t) && /private/.test(t) && /multi authority/.test(t) && /single authority/.test(t), 'the list shows each coin with its visibility and authority', t);
    await go('');
    line(/Coins on a\.example/.test(await text()), 'with no route the list is the start page');
    await page.getByRole('link', { name: 'PUB' }).click();
    await page.waitForFunction(() => /Total supply/.test(document.getElementById('view').innerText));

    console.log('\n== a public coin');
    t = await text();
    line(/Coin PUB \(PUB\)/.test(t) && /Public: accounts are shown by key/.test(t) && /Single authority, a\.example/.test(t) && /Total supply\s+1000 PUB/.test(t) && /Entry 58, 59 entries/.test(t), 'the coin page shows its terms, supply and head', t.slice(0, 700));
    line(/Treasury\s+[\d.]+ PUB held by/.test(t) && /Recent entries/.test(t) && /Open an account/.test(t), 'the treasury, the recent entries and a way into an account');
    await page.getByRole('button', { name: 'Verify the whole log' }).click();
    await page.waitForFunction(() => /Verified|Does not verify/.test(document.querySelector('[role=status]').innerText), null, { timeout: 15000 });
    t = await page.locator('[role=status]').innerText();
    line(/^Verified 59 entries, 0 to 58\./.test(t) && /Balances were not replayed/.test(t), 'the whole log verifies in the browser', t);
    await page.getByRole('link', { name: 'All entries' }).click();
    await page.waitForFunction(() => /Entries 0 to 24 of 59/.test(document.getElementById('view').innerText));
    line((await page.locator('#view table tr').count()) === 26, 'the entries page shows a page of 25');
    await page.getByRole('link', { name: 'Later' }).click();
    await page.waitForFunction(() => /Entries 25 to 49 of 59/.test(document.getElementById('view').innerText));
    line(true, 'and the next page');
    await page.getByRole('link', { name: 'Later' }).click();
    await page.waitForFunction(() => /Entries 50 to 58 of 59/.test(document.getElementById('view').innerText));
    line((await page.getByRole('link', { name: 'Later' }).count()) === 0, 'the last page has no later page');
    await page.getByRole('link', { name: 'Earlier' }).click();
    await page.waitForFunction(() => /Entries 25 to 49 of 59/.test(document.getElementById('view').innerText));
    line(true, 'and goes back');
    await page.getByRole('link', { name: 'Latest page' }).click();
    await page.waitForFunction(() => /Entries 50 to 58/.test(document.getElementById('view').innerText));
    line(true, 'the latest page is one click away');

    await go('/coin/' + pub.id + '/entry/7');
    t = await text();
    line(/entry 7/.test(t) && /Type\s+transfer/.test(t) && /Authority signature\s+a\.example/.test(t) && t.includes(alice.key) || t.includes(bob.key), 'an entry shows all of its fields, with the keys in full on a public coin', t.slice(0, 500));
    line((await page.getByRole('link', { name: 'Previous entry' }).count()) === 1 && (await page.getByRole('link', { name: 'Next entry' }).count()) === 1, 'with the entries either side');
    await page.getByRole('button', { name: 'Verify entries 0 to 7' }).click();
    await page.waitForFunction(() => /Verified|Does not verify/.test(document.querySelector('[role=status]').innerText), null, { timeout: 15000 });
    t = await page.locator('[role=status]').innerText();
    line(/^Verified 8 entries, 0 to 7\./.test(t), 'the chain verifies from the genesis to this entry', t);
    await go('/coin/' + pub.id + '/entry/0');
    line(/genesis/.test(await text()) && (await page.getByRole('link', { name: 'Previous entry' }).count()) === 0, 'the first entry has no entry before it');
    await go('/coin/' + pub.id + '/entry/999');
    line(/no such entry/.test(await text()), 'an entry that does not exist says so');

    await go('/coin/' + pub.id + '/account/' + alice.key);
    t = await text();
    line(t.includes(alice.key) && /Balance\s+0\.29 PUB/.test(t) && /Transfers sent\s+0/.test(t) && /received/.test(t), 'a public account is reached by its key and shows its history', t.slice(0, 400));
    line((await page.locator('#view table tr').count()) === 26 && (await page.getByRole('link', { name: 'Later' }).count()) === 1, 'in pages');
    await go('/coin/' + pub.id);
    await page.getByLabel('Account key').fill(bob.key);
    await page.getByRole('button', { name: 'Open account' }).click();
    await page.waitForFunction(() => /Balance/.test(document.getElementById('view').innerText));
    line(/Balance\s+0\.29 PUB/.test(await text()), 'the account form finds an account by its key');
    await go('/coin/' + pub.id);
    await page.getByLabel('Account key').fill('not a key');
    await page.getByRole('button', { name: 'Open account' }).click();
    line((await page.evaluate(() => location.hash)) === '#/coin/' + pub.id && !/Balance/.test(await text()), 'and refuses what is not one');

    console.log('\n== a private coin');
    await go('/coin/' + prv.id);
    t = await text();
    line(/Private: accounts are shown by reference and keys are never shown/.test(t) && /Open an account/.test(t), 'the page says that accounts are references', t.slice(0, 300));
    await remember(seen.private);
    await page.getByLabel('Account reference').count().then((n) => line(n === 1, 'and asks for a reference, not a key'));
    await page.getByRole('button', { name: 'Verify the whole log' }).click();
    await page.waitForFunction(() => /Verified|Does not verify/.test(document.querySelector('[role=status]').innerText), null, { timeout: 15000 });
    line(/^Verified 3 entries/.test(await page.locator('[role=status]').innerText()), 'its log verifies too');
    await go('/coin/' + prv.id + '/entries');
    await remember(seen.private);
    const links = await page.locator('#view a[href*="/account/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    line(links.length >= 3 && links.every((h) => /\/account\/[A-Za-z0-9_-]{43}$/.test(h)), 'every account link is a 43 character reference', links.slice(0, 3));
    await page.locator('#view a[href*="/account/"]').first().click();
    await page.waitForFunction(() => /Balance/.test(document.getElementById('view').innerText));
    t = await text();
    line(/This coin is private: the account is known only by its reference/.test(t) && /Reference\s+[A-Za-z0-9_-]{43}/.test(t), 'an account of a private coin is known by its reference', t.slice(0, 300));
    await remember(seen.private);
    await go('/coin/' + prv.id + '/entry/1');
    await remember(seen.private);
    await go('/coin/' + prv.id + '/domains');
    await remember(seen.private);
    await go('/coin/' + prv.id + '/account/' + alice.key);
    line(/no such account/.test(await text()), 'a key opens nothing in a private coin');
    await remember(seen.private);
    const all = seen.private.join('\n');
    line(seen.private.length >= 6 && keysIn(all).length === 0 && !all.includes(alice.key) && !all.includes(bob.key), 'no page of the private coin, in its text or its markup, holds an account key', keysIn(all));

    console.log('\n== a multi authority coin and its domains');
    await go('/coin/' + mul.id);
    t = await text();
    line(/Multi authority, 2 of 3 domains approve each entry/.test(t) && /a\.example \(authority\)/.test(t) && /b\.example/.test(t) && /c\.example/.test(t) && /key [a-f0-9]{16}/.test(t), 'the roster, threshold and key fingerprints are shown', t.slice(0, 600));
    await page.getByRole('button', { name: 'Verify the whole log' }).click();
    await page.waitForFunction(() => /Verified|Does not verify/.test(document.querySelector('[role=status]').innerText), null, { timeout: 15000 });
    t = await page.locator('[role=status]').innerText();
    line(/^Verified 3 entries/.test(t) && /at least 2 of 3 approvals/.test(t), 'its approvals verify', t);
    await page.getByRole('link', { name: 'Domains' }).first().click();
    await page.waitForFunction(() => /Do the domains agree/.test(document.getElementById('view').innerText) && !/Loading/.test(document.getElementById('view').innerText));
    t = await text();
    line(/All domains state the same head\./.test(t) && (t.match(/verified here/g) || []).length === 3 && /this domain/.test(t) && /same head/.test(t), 'three domains at the same head agree and each signature is checked here', t);
    line(!/did not verify|failed/.test(t), 'and none failed');

    console.log('\n== damage on the way to the page');
    state.tamper = (j) => { if (j.entries[2]) j.entries[2].entry.amount = '9999'; return JSON.stringify(j); };
    await go('/coin/' + pub.id);
    await page.getByRole('button', { name: 'Verify the whole log' }).click();
    await page.waitForFunction(() => /Verified|Does not verify/.test(document.querySelector('[role=status]').innerText), null, { timeout: 15000 });
    t = await page.locator('[role=status]').innerText();
    line(/^Does not verify at entry 2 \(hash\)/.test(t) && /2 earlier entries were fine/.test(t), 'an entry changed on its way is found', t);
    state.tamper = (j) => { j.entries.splice(1, 1); return JSON.stringify(j); };
    await go('/coin/' + pub.id);
    await page.getByRole('button', { name: 'Verify the whole log' }).click();
    await page.waitForFunction(() => /Verified|Does not verify/.test(document.querySelector('[role=status]').innerText), null, { timeout: 15000 });
    line(/^Does not verify at entry 1 \(index\)/.test(await page.locator('[role=status]').innerText()), 'and so is an entry that was left out');
    state.tamper = null;

    console.log('\n== text from the server stays text');
    state.inject = true;
    await go('/coins');
    t = await text();
    line(t.includes('<img src=x') && t.includes('<script>window.__xss=2</script>'), 'a name with markup is shown as the characters it is made of', t.slice(0, 200));
    line((await page.evaluate(() => window.__xss === undefined && document.querySelectorAll('#view img, #view script').length === 0)), 'and nothing ran, and no element was made');
    state.inject = false;

    console.log('\n== wrong addresses');
    await go('/coin/zzz');
    line(/There is no such page/.test(await text()), 'a coin id that is not one');
    await go('/coin/' + '0'.repeat(32));
    line(/no such coin/.test(await text()), 'a coin that does not exist');
    await go('/coin/' + pub.id + '/entry/abc');
    line(/There is no such page/.test(await text()), 'an entry number that is not a number');
    await go('/nowhere');
    line(/There is no such page/.test(await text()), 'a page that does not exist');
    await go('/coin/' + pub.id + '/account/%E0%A4%A');
    line(/There is no such page/.test(await text()), 'a broken escape');
    line(errors.length === 0, 'the page logged no errors', errors);
  } finally {
    await browser.close();
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' SCANNER PAGE CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
