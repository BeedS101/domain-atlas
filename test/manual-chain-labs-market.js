// The market page (chain-labs/index.html) in a real browser against live PHP servers: coins that are open on a ledger with and
// without a purchase offer, and what each column says.
//   - Price, Market cap and 24h volume show the figures of the ledger and the offer, in Au, and a dash where none exist
//   - Buy with Gold shows only for a signed-in wallet and only on a coin with a usable offer, and states the exact price
//   - a multi authority coin is one row
//
//   xvfb-run -a node test/manual-chain-labs-market.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./support/chain-labs-servers');
const { A, B, nodes, issuerKey, wallet, start, call, post, scan, op, createCoin, NOW, iso, hex, credential } = S;
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/home/claude/.npm-global/lib/node_modules/playwright'); }

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const POLICY6 = { priceClass: 'atlas.element.gold', issuerKey, unitsPerPrice: 1000000, minPrice: 1, perKeyUnits: '5000000000', perDayUnits: '8000000000' };
const def = { decimals: 6, maxSupply: '1000000', initialSupply: '10000' };

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B];
  const browser = await playwright.chromium.launch();
  try {
    const goph = (await createCoin(a, 'GOPH', def)).json, sell = (await createCoin(a, 'SELL', def)).json;
    const osc = (await createCoin(a, 'OSC', { ...def, mode: 'multi', partners: [B], threshold: 2 })).json, poor = (await createCoin(a, 'POOR', { ...def, initialSupply: '0.5' })).json;
    const mwc = (await createCoin(b, 'MWC', def)).json;
    await op(a, 'open', { coinId: goph.id });
    await op(a, 'open', { coinId: sell.id, purchase: POLICY6 });
    await op(a, 'open', { coinId: osc.id, purchase: POLICY6 });
    await op(a, 'open', { coinId: poor.id, purchase: POLICY6 });
    const w = wallet();
    await op(a, 'grant', { coinId: goph.id, to: w.key, amount: '12500000' });
    await op(a, 'grant', { coinId: sell.id, to: w.key, amount: '3000000' });
    const cred = credential(100, w), rid = hex(16);
    const payload = { type: 'atlas.ledger.purchase.intent', v: 1, coinId: sell.id, credentialId: cred.id, price: 20, recipient: w.key, requestId: rid, expiresAt: iso(NOW() + 300) };
    const sale = await post(a, 'action=purchase', { coinId: sell.id, intent: { payload, signature: w.sign(payload) }, credential: cred });
    line(sale.status === 201, 'setup: coins are open, one sale has been made', sale.json);

    const context = await browser.newContext();
    let signedIn = false;
    await context.route(/^https:\/\/[abc]\.example\/chain-labs\//, async (route) => {
      const u = new URL(route.request().url());
      const file = u.pathname.replace(/^\/chain-labs\//, '');
      if (file === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, '..', 'chain-labs', 'index.html')) });
      if (file === 'market-login28.php') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(signedIn ? { ok: true, loggedIn: true, publicKey: w.key } : { ok: true, loggedIn: false }) });
      if (file === 'market27.php') {
        const coins = [...(await call(a, 'coin26', 'GET', 'action=list')).json.coins, ...(await call(b, 'coin26', 'GET', 'action=list')).json.coins];
        const stats = { [A]: (await scan(a, 'action=market')).json, [B]: (await scan(b, 'action=market')).json };
        const out = execFileSync('php', [path.join(__dirname, 'support', 'market-merge.php')], { input: JSON.stringify({ coins, stats }) }).toString();
        return route.fulfill({ status: 200, contentType: 'application/json', body: out });
      }
      route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://a.example/chain-labs/index.html');
    await page.locator('tr', { hasText: 'GOPH' }).first().waitFor();
    const row = (symbol) => page.locator('#rows tr:not(:has(td.detail))', { has: page.locator('.symbol', { hasText: new RegExp('^' + symbol + '$') }) });
    const cells = async (symbol) => (await row(symbol).locator('td').allInnerTexts()).map((t) => t.trim());

    console.log('== the columns');
    const g = await cells('GOPH');
    line(g[2] === '—' && g[3] === '—' && g[4] === '—', 'GOPH has no purchase offer, so price, market cap and volume are dashes', g);
    const s = await cells('SELL');
    line(/^1 Au per SELL$/.test(s[2]) && s[3] === '23 Au' && s[4] === '20 Au', 'SELL shows 1 Au per coin, a market cap of 23 Au and a volume of 20 Au', s);
    const o = await cells('OSC');
    line(/^1 Au per OSC$/.test(o[2]) && o[3] === '0 Au' && o[4] === '0 Au', 'OSC: priced, nothing circulating, nothing sold', o);
    const p = await cells('POOR');
    line(p[2] === '—' && p[3] === '—' && p[4] === '0 Au', 'POOR: a treasury below the smallest purchase has no price; its volume is a real 0', p);
    line(/treasury/.test(await row('POOR').locator('td').nth(2).getAttribute('title')), 'and the dash says why when hovered');
    const m = await cells('MWC');
    line(m[2] === '—' && m[3] === '—' && m[4] === '—', 'MWC is registered on the other domain and not open, so it has dashes', m);
    line((await page.locator('#rows .symbol', { hasText: /^OSC$/ }).count()) === 1, 'OSC is one row');
    line((await page.locator('#liveMarkets').innerText()) === '2', 'two coins have a usable offer: SELL and OSC');
    line(!(await page.locator('body').innerText()).includes('TRADE PREVIEW ONLY'), 'the page no longer offers a made-up trade preview');
    await row('SELL').getByRole('button', { name: 'View' }).click();
    const detail = await page.locator('td.detail.open').innerText();
    line(/Issued on the ledger: 10,000 \| In the treasury: 9,977 \| Circulating: 23/.test(detail) && /View in the scanner/.test(detail), 'the details give issued supply, treasury and circulating supply from the ledger', detail);

    console.log('\n== Buy with Gold');
    line((await page.getByRole('button', { name: 'Buy with Gold' }).count()) === 0, 'without a wallet there is no Buy button');
    signedIn = true;
    await page.reload();
    await row('SELL').waitFor();
    line((await page.getByRole('button', { name: 'Buy with Gold' }).count()) === 2, 'with a wallet, Buy with Gold shows on SELL and OSC only');
    line((await row('GOPH').getByRole('button', { name: /Buy/ }).count()) === 0 && (await row('POOR').getByRole('button', { name: /Buy/ }).count()) === 0 && (await row('MWC').getByRole('button', { name: /Buy/ }).count()) === 0, 'and not on GOPH, POOR or MWC, which have no usable offer');
    await row('SELL').getByRole('button', { name: 'Buy with Gold' }).click();
    const note = await page.locator('#buyNote').innerText();
    line(/wallet extension was not detected/.test(note) && /Install it, unlock your wallet/.test(note), 'without the extension the button says so instead of doing nothing', note);
    await page.evaluate(() => { window.__asked = []; window.atlasWallet = { requestPurchase: async (r) => { window.__asked.push(r); return { allowed: true, result: null }; } }; });
    await row('SELL').getByRole('button', { name: 'Buy with Gold' }).click();
    await page.waitForFunction(() => /No purchase was made/.test(document.getElementById('buyNote').textContent));
    const asked = await page.evaluate(() => window.__asked), sellId = sell.id;
    line(asked.length === 1 && asked[0].domain === A && asked[0].coinId === sellId && Object.keys(asked[0]).sort().join() === 'coinId,domain', 'with a wallet it asks for that one coin on its authority domain and passes nothing else', asked);
    line(/1 Au buys one SELL/.test(await page.locator('#buyNote').innerText()), 'and states the offer price when the prompt ends without a purchase');
    line(errors.length === 0, 'the page logged no errors', errors);
  } finally {
    await browser.close();
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' MARKET PAGE CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
