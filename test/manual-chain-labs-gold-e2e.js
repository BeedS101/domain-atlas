// One new experimental coin, end to end, in an isolated environment (throw-away PHP servers, a throw-away Domain Atlas issuer with
// test Gold; nothing live is read or written):
//   1. the Coin Creation Studio checks a Gold purchase policy, shows it, and creates the coin only with the confirmed fingerprint
//   2. the ledger is opened and the signed genesis carries that policy
//   3. a buyer pays with a test Gold credential: the issuer holds it from the owner's signed intent, the ledger delivers the units, the
//      issuer spends the credential and returns the remainder
//   4. both balances are verified: the coin on the ledger (buyer and treasury) and the Gold at the issuer (burned, remainder, hold)
//   5. the market page shows the right price, market cap and purchase volume
//
//   xvfb-run -a node test/manual-chain-labs-gold-e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const S = require('./support/chain-labs-servers');
const { startPhp, api } = require('./lib/gen1-issuers');
const { register } = require('./lib/owner-auth');
const { A, B, nodes, wallet: rawWallet, start, stop, post, get, scan, call, op, NOW, iso, hex, units } = S;
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/home/claude/.npm-global/lib/node_modules/playwright'); }

const GOLD = 'atlas.element.gold';
const TOKEN = crypto.randomBytes(24).toString('hex');
const TOKEN_SHA = crypto.createHash('sha256').update(TOKEN).digest('hex');
const wallet = () => { const w = rawWallet(); register({ publicKey: w.key, privateKey: w.privateKey }); return w; };
let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };

const adapterFile = (n, issuer, o) => "<?php\nrequire_once '" + path.join(n.root, 'lib', 'gold-issuer.php') + "';\n$cfg = json_decode('" + JSON.stringify({
  issuerUrl: issuer.base, issuerDomain: issuer.domain, issuerKey: o.issuerKey, token: o.token || undefined, timeout: 5 }) + "', true);\n$o = __DIR__ . '/issuer-key-override.txt';\nif (is_file($o)) $cfg['issuerKey'] = trim((string) file_get_contents($o));\n$u = __DIR__ . '/issuer-url-override.txt';\nif (is_file($u)) $cfg['issuerUrl'] = trim((string) file_get_contents($u));\n$g = gold_issuer_adapter($cfg);\n$m = is_file(__DIR__ . '/rogue-mode.txt') ? trim((string) file_get_contents(__DIR__ . '/rogue-mode.txt')) : '';\nif ($m === 'nohold') { $g['lock'] = fn() => null; $g['begin'] = fn() => null; $g['release'] = fn() => null; $g['finish'] = fn($r, $c, $p) => ['balance' => null]; }\nif ($m === 'nobegin') { $g['begin'] = fn() => null; }\nif ($m === 'nolockbegin') { $g['lock'] = fn() => null; $g['begin'] = fn() => null; $g['release'] = fn() => null; }\n"
  + "$g['crash'] = function (string $p) { $f = __DIR__ . '/crash-at.txt'; if (is_file($f) && trim((string) file_get_contents($f)) === $p) { @unlink($f); exit(86); } };\nreturn $g;\n";
const crashAt = (n, point) => fs.writeFileSync(path.join(n.priv, 'crash-at.txt'), point);

const GOOD = { decimals: 2, maxSupply: '100000', initialSupply: '10000' };

(async () => {
  const issuer = await startPhp(9161 + Math.floor(Math.random() * 100), { workers: 0 });
  const IA = api(issuer);
  const issuerKey = JSON.parse(fs.readFileSync(issuer.keyFile, 'utf8')).keys[0].publicKey;
  const a = nodes[A], b = nodes[B];
  fs.writeFileSync(path.join(issuer.bundle, 'lib', 'atlas-gold-hold-config.json'), JSON.stringify({ enabled: true, tokenSha256: TOKEN_SHA, ledgerAuthorities: { [A]: a.pair.publicKey.export({ type: 'spki', format: 'pem' }) } }));
  // The operator's list of issuers the Studio may sell for: this issuer, the Gold class only.
  fs.writeFileSync(path.join(a.priv, 'chainlabs-gold-issuers.json'), JSON.stringify({ issuers: [{ name: 'Test issuer', domain: issuer.domain, key: issuerKey, classes: [GOLD] }] }));
  for (const n of Object.values(nodes)) fs.writeFileSync(n.adapter, adapterFile(n, issuer, { issuerKey, token: n.domain === A ? TOKEN : null }));
  for (const n of Object.values(nodes)) await start(n);
  const holds = () => { try { return JSON.parse(fs.readFileSync(path.join(issuer.bundle, 'lib', 'holds', 'holds.json'), 'utf8')).holds; } catch (e) { return {}; } };
  const revoked = () => (IA.revocations() || []).map((r) => r.id);
  const mint = async (w, qty) => { const r = await IA.post('/atlas/asset/issue', { ownerPublicKey: w.key, assetClass: GOLD, quantity: qty }); if (r.status !== 200) throw new Error('mint ' + r.status); return r.body; };
  const intent = (w, coinId, cred, price, requestId) => {
    const payload = { type: 'atlas.ledger.purchase.intent', v: 1, coinId, credentialId: cred.id, price, recipient: w.key, requestId, expiresAt: iso(NOW() + 300) };
    return { payload, signature: w.sign(payload) };
  };
  const buy = async (w, coinId, cred, price) => { const requestId = hex(16); return post(a, 'action=purchase', { coinId, intent: intent(w, coinId, cred, price, requestId), credential: cred }); };
  const browser = await playwright.chromium.launch();
  try {
    console.log('== 1. the Studio: policy checked, shown, confirmed');
    const policy = { coinsPerAu: '50', minPrice: 2, perKey: '2000', perDay: '10000', priceClass: GOLD, issuerKey };
    const body = { name: 'Experimental Gold Coin', symbol: 'EXPC', ...GOOD, description: 'end to end test', adminToken: a.token };
    const prev = await call(a, 'coin26', 'POST', 'action=preview', { ...body, purchase: policy });
    line(prev.status === 200 && prev.json.lines.some((t) => /1 EXPC costs 0\.02 Au \(50\.00 EXPC for 1 Au\)/.test(t)) && prev.json.lines.some((t) => /Test issuer/.test(t)), 'the review reads: 1 EXPC costs 0.02 Au, and names the listed issuer', prev.json);
    const refusedRate = await call(a, 'coin26', 'POST', 'action=create', { ...body, purchase: policy });
    line(refusedRate.status === 409 && refusedRate.json.code === 'policy-not-confirmed', 'creating without the fingerprint is refused', refusedRate.json);
    const made = await call(a, 'coin26', 'POST', 'action=create', { ...body, purchase: policy, purchaseDigest: prev.json.digest });
    line(made.status === 201 && made.json.state === 'registered' && made.json.purchase.unitsPerPrice === 5000, 'the coin is created with the confirmed policy', made.json);
    const coinId = made.json.id;
    line((await scan(a, 'action=coins')).json.coins.length === 0, 'nothing is on a ledger yet');

    console.log('\n== 2. opening the ledger');
    const opened = await op(a, 'open', { coinId });
    const g = opened.json.coin && opened.json.coin.genesis;
    line(opened.status === 201 && g.purchase.unitsPerPrice === 5000 && g.purchase.minPrice === 2 && g.purchase.perKeyUnits === '200000' && g.purchase.perDayUnits === '1000000' && g.purchase.issuerKey === issuerKey && g.purchase.priceClass === GOLD,
      'the signed genesis carries the policy exactly as confirmed', opened.json);
    const sc = (await scan(a, 'action=coin&coin=' + coinId)).json;
    line(sc.ok && sc.supply === '1000000' && JSON.stringify(sc.genesis.purchase) === JSON.stringify(g.purchase), 'the scanner shows the same genesis; the treasury holds all 10,000 EXPC (1,000,000 units)', sc.supply);

    console.log('\n== 3. a purchase with a test Gold credential');
    const w = wallet();
    const cred = await mint(w, 100);
    const sale = await buy(w, coinId, cred, 20);
    line(sale.status === 201 && sale.json.receipt.entry.amount === '100000' && sale.json.receipt.entry.purchase.price === 20, '20 Au buys 1,000.00 EXPC (100,000 units) at 50 EXPC per Au', sale.json);

    console.log('\n== 4. both balances');
    line(await units(a, w, coinId) === '100000', 'the buyer holds 100,000 units (1,000.00 EXPC) on the ledger');
    const after = (await scan(a, 'action=coin&coin=' + coinId)).json;
    line(after.supply === '1000000', 'the supply is unchanged: the treasury paid the units out', after.supply);
    const remainder = sale.json.balance.balance && JSON.parse(sale.json.balance.balance.gold);
    line(remainder && remainder.quantity === 80 && remainder.owner.publicKey === w.key && remainder.supersedes === cred.id, 'the Gold: the buyer gets a signed remainder of 80 back', remainder);
    line(revoked().filter((id) => id === cred.id).length === 1, 'and the original 100 is revoked at the issuer, once');
    const hold = holds()[cred.id];
    line(hold && hold.state === 'finalized' && hold.price === 20 && hold.coinId === coinId && hold.recipient === w.key && hold.result.balance.quantity === 80, 'the issuer\'s hold ended finalized with exactly what the owner signed', hold && { state: hold.state, price: hold.price });
    const again = await post(a, 'action=purchase', { coinId, intent: sale.json ? intent(w, coinId, cred, 20, sale.json.requestId) : null, credential: cred });
    line(again.status !== 201 || again.json.receipt.entry.index === sale.json.receipt.entry.index, 'asking for the same sale again gives the stored answer, not a second delivery', again.json);
    line(await units(a, w, coinId) === '100000' && revoked().filter((id) => id === cred.id).length === 1, 'the balances did not move');

    console.log('\n== the limits of the policy');
    const g2 = await mint(w, 100);
    const small = await buy(w, coinId, g2, 1);
    line(small.json.code === 'purchase-too-small' && small.status !== 201, 'a purchase below the smallest (2 Au) is refused', small.json);
    const big = await buy(w, coinId, g2, 21);
    line(big.status === 409 && big.json.code === 'purchase-key-limit', '21 Au (1,050 EXPC) would take this key past its limit of 2,000 EXPC and is refused', big.json);
    line(!holds()[g2.id] && !revoked().includes(g2.id), 'a refused purchase holds and spends nothing');
    const second = await buy(w, coinId, remainder, 4);
    line(second.status === 201 && await units(a, w, coinId) === '120000', 'a second purchase with the remainder the first one returned (4 Au = 200.00 EXPC) works, so that remainder is valid Gold: the buyer now holds 120,000 units', second.json);
    const rem2 = JSON.parse(second.json.balance.balance.gold);
    line(rem2.quantity === 76, 'and the Gold left is 76: 24 Au spent in total');

    console.log('\n== 5. the market page');
    const market = (await scan(a, 'action=market')).json;
    const mrow = (market.coins || []).find((c) => c.id === coinId || c.coinId === coinId);
    line(mrow && JSON.stringify(mrow).includes('0.02'), 'the market figures price 1 EXPC at 0.02 Au', mrow);
    const context = await browser.newContext();
    await context.route(/^https:\/\/[abc]\.example\/chain-labs\//, async (route) => {
      const u = new URL(route.request().url());
      const file = u.pathname.replace(/^\/chain-labs\//, '');
      if (file === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, '..', 'chain-labs', 'index.html')) });
      if (file === 'market-login28.php') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, loggedIn: false }) });
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
    const row = page.locator('#rows tr:not(:has(td.detail))', { has: page.locator('.symbol', { hasText: /^EXPC$/ }) });
    await row.waitFor();
    const cells = (await row.locator('td').allInnerTexts()).map((t) => t.trim());
    line(/^0\.02 Au per EXPC$/.test(cells[2]), 'the page shows the price: 0.02 Au per EXPC', cells);
    line(cells[3] === '24 Au', 'the market cap is 1,200 EXPC in circulation x 0.02 = 24 Au', cells);
    line(cells[4] === '24 Au', 'the 24h purchase volume is the 24 Au actually paid (20 + 4)', cells);
    await row.getByRole('button', { name: 'View' }).click();
    const detail = await page.locator('td.detail.open').innerText();
    line(/Issued on the ledger: 10,000/.test(detail) && /In the treasury: 8,800/.test(detail) && /Circulating: 1,200/.test(detail), 'the details show 10,000 issued, 8,800 in the treasury and 1,200 circulating', detail);
    line(errors.length === 0, 'the page logged no errors', errors);
  } catch (e) {
    console.log('ERROR ' + e.stack);
    failures++;
  } finally {
    await browser.close();
    issuer.stop();
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' END-TO-END CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
