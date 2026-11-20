// The Coin Creation Studio page as it was before signed requests, against the server that has them: until 1 March 2027 it still creates,
// opens and grants with the token, and once signed requests are activated its actions that change something are refused with a message that
// says what to do, with nothing changed.
//
//   xvfb-run -a node test/manual-chain-labs-studio-legacy.js
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./support/chain-labs-servers');
const { A, nodes, start, wallet, get, scan } = S;
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/home/claude/.npm-global/lib/node_modules/playwright'); }

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
// The page as it was before signed requests, kept as it was.
const OLD = fs.readFileSync(path.join(__dirname, 'fixtures', 'chain-labs-coin26-token-only.html'), 'utf8');

(async () => {
  if (Date.now() >= Date.UTC(2027, 2, 1)) { console.log('The token has ended; nothing to check here.'); process.exit(0); }
  await start(nodes[A]);
  const a = nodes[A];
  fs.writeFileSync(path.join(a.root, 'coin26.html'), OLD);
  const browser = await playwright.chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route(/^https:\/\/a\.example\/chain-labs\//, async (route) => {
      const u = new URL(route.request().url());
      const res = await route.fetch({ url: 'http://127.0.0.1:' + a.port + u.pathname.replace(/^\/chain-labs/, '') + u.search, headers: { ...route.request().headers(), host: u.hostname } });
      await route.fulfill({ response: res });
    });
    const page = await context.newPage();
    await page.goto('https://a.example/chain-labs/coin26.html');
    await page.waitForSelector('#opToken');
    line(await page.locator('[name=adminToken]').count() === 1, 'the page is the one from before: it has the token fields');
    const fillCoin = async (symbol) => { await page.fill('[name=name]', 'Legacy ' + symbol); await page.fill('[name=symbol]', symbol); await page.selectOption('[name=decimals]', '2'); await page.fill('[name=maxSupply]', '100000'); await page.fill('[name=initialSupply]', '1000'); };

    console.log('== before activation');
    await fillCoin('OLD');
    await page.fill('[name=adminToken]', a.token);
    await page.click('#create');
    await page.waitForFunction(() => /CREATED|Could not create/.test(document.getElementById('message').innerText));
    line(/OLD CREATED/.test(await page.locator('#message').innerText()), 'it creates a coin with the token', await page.locator('#message').innerText());
    const coin = (await S.call(a, 'coin26', 'GET', 'action=list')).json.coins.find((c) => c.symbol === 'OLD');
    await page.locator('.coin', { hasText: '(OLD)' }).getByRole('button', { name: 'Open on the ledger' }).click();
    await page.locator('#opToken').fill(a.token);
    await page.locator('.coin', { hasText: '(OLD)' }).getByRole('button', { name: 'Open on the ledger' }).click();
    await page.waitForFunction(() => /OLD is open on the ledger|Could not open OLD: (?!Enter)/.test(document.getElementById('opMessage').innerText));
    line(/OLD is open on the ledger/.test(await page.locator('#opMessage').innerText()), 'opens it', await page.locator('#opMessage').innerText());
    const w = wallet();
    await page.locator('#grantCoin').selectOption(coin.id);
    await page.locator('#grantTo').fill(w.key);
    await page.locator('#grantAmount').fill('5');
    await page.locator('#opToken').fill(a.token);
    await page.getByRole('button', { name: 'Grant from the treasury' }).click();
    await page.waitForFunction(() => /Granted|Could not grant: (?!Enter)/.test(document.getElementById('opMessage').innerText));
    line(/Granted 5 OLD/.test(await page.locator('#opMessage').innerText()) && (await S.units(a, w, coin.id)) === '500', 'and grants', await page.locator('#opMessage').innerText());

    console.log('\n== after signed requests are activated');
    const signed = await S.signedOp(a, 'operator/check', {});
    const act = await S.signedOp(a, 'operator/activate', { confirm: 'activate-signed-operator' });
    line(signed.status === 200 && act.status === 200, 'the operator verifies a key and activates', act.json);
    await fillCoin('NEW');
    await page.fill('[name=adminToken]', a.token);
    await page.click('#create');
    await page.waitForFunction(() => /Could not create/.test(document.getElementById('message').innerText));
    const refused = await page.locator('#message').innerText();
    line(/needs a signed operator request/.test(refused), 'the old page is told that a signed request is needed', refused);
    line((await S.call(a, 'coin26', 'GET', 'action=list')).json.coins.every((c) => c.symbol !== 'NEW'), 'and no coin was created');
    await page.locator('#grantCoin').selectOption(coin.id);
    await page.locator('#grantTo').fill(w.key);
    await page.locator('#grantAmount').fill('5');
    await page.locator('#opToken').fill(a.token);
    await page.getByRole('button', { name: 'Grant from the treasury' }).click();
    await page.waitForFunction(() => /Could not grant: (?!Enter)/.test(document.getElementById('opMessage').innerText));
    line(/needs a signed operator request/.test(await page.locator('#opMessage').innerText()) && (await S.units(a, w, coin.id)) === '500', 'nor is a grant made', await page.locator('#opMessage').innerText());
    line((await page.locator('.coin', { hasText: '(OLD)' }).getByRole('link', { name: 'View in the scanner' }).count()) === 1, 'the registry and the scanner link still load');
    line((await scan(a, 'action=coins')).json.coins.length === 1 && (await get(a, 'action=coins')).status === 200, 'as does the public ledger');
  } finally {
    await browser.close();
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' LEGACY STUDIO CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
