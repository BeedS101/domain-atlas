// The Gold purchase policy fields of the Coin Creation Studio (chain-labs/coin26.html) in a real browser against a live PHP server:
// the fields are optional, the policy is checked and shown before anything is created, changing a field starts the review again,
// the coin is created with exactly what was shown, and the coin list shows its policy.
//
//   xvfb-run -a node test/manual-chain-labs-studio-policy.js
'use strict';
const S = require('./support/chain-labs-servers');
const { A, nodes, start, stop, issuerKey, call } = S;
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/home/claude/.npm-global/lib/node_modules/playwright'); }

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A];
  const browser = await playwright.chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route(/^https:\/\/[abc]\.example\/chain-labs\//, async (route) => {
      const u = new URL(route.request().url());
      const n = nodes[u.hostname];
      const res = await route.fetch({ url: 'http://127.0.0.1:' + n.port + u.pathname.replace(/^\/chain-labs/, '') + u.search, headers: { ...route.request().headers(), host: u.hostname } });
      await route.fulfill({ response: res });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://a.example/chain-labs/coin26.html');
    await page.waitForSelector('#goldOn');
    const text = (sel) => page.locator(sel).innerText();
    const msg = () => text('#message');
    const settle = async (re) => { await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message').innerText), re.source, { timeout: 15000 }); return msg(); };
    const fill = async (name, value) => page.fill('[name=' + name + ']', value);
    const base = async (symbol) => { await fill('name', 'Experiment ' + symbol); await fill('symbol', symbol); await page.selectOption('[name=decimals]', '2'); await fill('maxSupply', '100000'); await fill('initialSupply', '1000'); await fill('adminToken', a.token); };

    console.log('== the fields are optional');
    line(await page.locator('#goldFields').isHidden(), 'the policy fields are hidden until the box is ticked');
    await base('NOG');
    await page.click('#create');
    await settle(/Experimental coin|registered|NOG/);
    const noGold = (await call(a, 'coin26', 'GET', 'action=list')).json.coins.find((c) => c.symbol === 'NOG');
    line(noGold && noGold.purchase === null, 'a coin made without ticking it has no policy', noGold);
    line(/No Gold purchase policy/.test(await page.locator('.coin', { hasText: '(NOG)' }).innerText()), 'and the list says so');

    console.log('\n== the policy is shown before anything is created');
    await base('AUC');
    await page.check('#goldOn');
    line(await page.locator('#goldFields').isVisible(), 'ticking the box shows the fields');
    line((await page.inputValue('#issuerKey')) === '' && (await text('#issuerHint')).includes('not checked'), 'the issuer key is typed in and the page says it is not checked against a list');
    await fill('coinsPerAu', '100');
    line((await page.inputValue('#pricePerCoin')) === '0.01 Au', 'the price of one coin is worked out: 0.01 Au', await page.inputValue('#pricePerCoin'));
    await fill('minPrice', '2'); await fill('perKey', '1000'); await fill('perDay', '10000'); await fill('issuerKey', issuerKey);
    await page.click('#create');
    await settle(/Nothing is created yet/);
    line(await page.locator('#review').isVisible(), 'the first press shows the review');
    const lines = await page.locator('#reviewLines li').allInnerTexts();
    line(lines.length >= 6 && lines.some((t) => /1 AUC costs 0\.01 Au/.test(t)) && lines.some((t) => /Smallest purchase: 2 Au = 200\.00 AUC/.test(t)) && lines.some((t) => t.includes(issuerKey)), 'it lists the price, the smallest purchase and the issuer key', lines);
    line((await call(a, 'coin26', 'GET', 'action=list')).json.coins.every((c) => c.symbol !== 'AUC'), 'nothing was created by the first press');
    line(/^[0-9a-f]{64}$/.test(await text('#reviewDigest')), 'the review shows the fingerprint');

    console.log('\n== changing a field starts the review again');
    await fill('perDay', '9000');
    line(await page.locator('#review').isHidden() && /Review the purchase policy/.test(await text('#create')), 'the review is withdrawn and the button asks for a review again');
    await page.fill('[name=adminToken]', a.token);
    await page.click('#create');
    await settle(/Nothing is created yet/);
    const lines2 = await page.locator('#reviewLines li').allInnerTexts();
    line(lines2.some((t) => /Most sold in 24 hours: 9000\.00 AUC/.test(t)), 'the new review shows the new limit', lines2);

    console.log('\n== the second press creates exactly what was shown');
    line(/Confirm the policy and create the coin/.test(await text('#create')), 'the button now says it confirms the policy');
    await page.click('#create');
    await settle(/Gold purchase policy: recorded|Could not create/);
    const made = (await call(a, 'coin26', 'GET', 'action=list')).json.coins.find((c) => c.symbol === 'AUC');
    line(made && made.purchase && made.purchase.unitsPerPrice === 10000 && made.purchase.minPrice === 2 && made.purchase.perDayUnits === '900000' && made.purchase.issuerKey === issuerKey, 'the coin is registered with the policy that was shown', made);
    const card = await page.locator('.coin', { hasText: '(AUC)' }).innerText();
    line(/Sells for Au: 100 AUC per 1 Au, smallest purchase 2 Au/.test(card) && /9000 per 24 hours/.test(card), 'the coin list shows the policy', card);
    line(/Review the purchase policy/.test(await text('#create')) || /Create experimental coin/.test(await text('#create')), 'the form is ready for the next coin');

    console.log('\n== a refused policy is explained and nothing is created');
    await base('BAD');
    await fill('coinsPerAu', '100'); await fill('minPrice', '1'); await fill('perKey', '5000'); await fill('perDay', '4000'); await fill('issuerKey', issuerKey);
    await page.click('#create');
    const refused = await settle(/Could not create coin: .*Purchase policy/);
    line(/above the limit per 24 hours/.test(refused) && await page.locator('#review').isHidden(), 'the reason is shown and no review appears', refused);
    line((await call(a, 'coin26', 'GET', 'action=list')).json.coins.every((c) => c.symbol !== 'BAD'), 'nothing was created');
    line(errors.length === 0, 'the page raised no errors', errors);
  } finally {
    await browser.close();
    for (const n of Object.values(nodes)) await stop(n);
    S.cleanup();
  }
  console.log('\n' + (total - failures) + '/' + total + ' passed');
  process.exit(failures ? 1 : 0);
})();
