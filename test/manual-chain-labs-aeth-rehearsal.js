// A rehearsal, in isolation, of what the live AETH coin needs: a two domain coin with AETH's purchase policy (6 decimals, 10 AETH per Au,
// smallest purchase 1 Au, 3,000 AETH per key, 30,000 AETH per 24 hours), an authority and a partner whose configuration is written by
// tools/chainlabs-gold-setup.js, and a throw-away Domain Atlas issuer with test Gold. The tool's own output is what is installed.
//   1. before the configuration the market shows what the live market shows today: a policy, no adapter, no price, no Buy
//   2. after it, both domains can take a purchase, the market prices the coin and a signed-in wallet is offered Buy
//   3. one purchase of test Gold for AETH goes through, and every balance is checked (coin on both ledgers, Gold at the issuer, market figures)
//   4. a partner that is down delays a sale without losing it; the sale cannot be cancelled without the partner
//   5. deleting the authority's adapter switches purchases off again
//
//   xvfb-run -a node test/manual-chain-labs-aeth-rehearsal.js
'use strict';
const fs = require('fs');
const os = require('os');
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
const wallet = () => { const w = rawWallet(); register({ publicKey: w.key, privateKey: w.privateKey }); return w; };
let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };

(async () => {
  const issuer = await startPhp(9261 + Math.floor(Math.random() * 100), { workers: 0 });
  const IA = api(issuer);
  const issuerKey = JSON.parse(fs.readFileSync(issuer.keyFile, 'utf8')).keys[0].publicKey;
  const a = nodes[A], b = nodes[B];
  // The domains as they are before any Gold configuration: no gold-adapter.php, no hold config. (The harness writes adapters; remove them.)
  for (const n of Object.values(nodes)) fs.rmSync(n.adapter, { force: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aeth-setup-'));
  const holdsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(issuer.bundle, 'lib', 'holds', 'holds.json'), 'utf8')).holds; } catch (e) { return {}; } };
  const revoked = () => (IA.revocations() || []).map((r) => r.id);
  const mint = async (w, qty) => { const r = await IA.post('/atlas/asset/issue', { ownerPublicKey: w.key, assetClass: GOLD, quantity: qty }); if (r.status !== 200) throw new Error('mint ' + r.status); return r.body; };
  const intent = (w, coinId, cred, price, requestId) => {
    const payload = { type: 'atlas.ledger.purchase.intent', v: 1, coinId, credentialId: cred.id, price, recipient: w.key, requestId, expiresAt: iso(NOW() + 300) };
    return { payload, signature: w.sign(payload) };
  };
  const buy = async (w, coinId, cred, price) => { const requestId = hex(16); return { requestId, res: await post(a, 'action=purchase', { coinId, intent: intent(w, coinId, cred, price, requestId), credential: cred }) }; };
  for (const n of Object.values(nodes)) await start(n);
  const browser = await playwright.chromium.launch();
  try {
    console.log('== AETH\'s coin, created and opened the way the Studio does it');
    fs.writeFileSync(path.join(a.priv, 'chainlabs-gold-issuers.json'), JSON.stringify({ issuers: [{ name: 'Test issuer', domain: issuer.domain, key: issuerKey, classes: [GOLD] }] }));
    const body = { name: 'Aether', symbol: 'AETH', decimals: 6, maxSupply: '1000000', initialSupply: '500000', description: 'rehearsal', mode: 'multi', partners: [B], threshold: 2, adminToken: a.token };
    const policy = { coinsPerAu: '10', minPrice: 1, perKey: '3000', perDay: '30000', priceClass: GOLD, issuerKey };
    const prev = await call(a, 'coin26', 'POST', 'action=preview', { ...body, purchase: policy });
    const made = await call(a, 'coin26', 'POST', 'action=create', { ...body, purchase: policy, purchaseDigest: prev.json.digest });
    const coinId = made.json.id;
    const opened = await op(a, 'open', { coinId });
    const gp = opened.json.coin.genesis.purchase;
    line(made.status === 201 && opened.status === 201 && gp.unitsPerPrice === 10000000 && gp.minPrice === 1 && gp.perKeyUnits === '3000000000' && gp.perDayUnits === '30000000000', 'a 2-of-2 coin with the live AETH numbers: 10,000,000 units per Au, 1 Au minimum, 3,000 AETH per key, 30,000 per day', gp);

    console.log('\n== 1. before the configuration (what the live market shows)');
    const m0 = (await scan(a, 'action=market')).json.coins.find((c) => c.coinId === coinId);
    line(m0.offer.available === false && m0.offer.unavailableBecause === 'this domain has no Gold adapter' && m0.price === null && m0.marketCap === null, 'the market lists the policy but "this domain has no Gold adapter", with no price and no market cap', m0);
    const pe = (n) => get(n, 'action=coin&coin=' + coinId);
    line((await pe(a)).json.purchasesEnabled === false && (await pe(b)).json.purchasesEnabled === false, 'purchasesEnabled is false on the authority and on the partner');

    console.log('\n== 2. the configuration written by tools/chainlabs-gold-setup.js');
    for (const [n, f] of [[a, 'a.pem'], [b, 'b.pem']]) fs.writeFileSync(path.join(work, f), n.pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const run = execFileSync('node', [path.join(__dirname, '..', 'tools', 'chainlabs-gold-setup.js'), '--out', path.join(work, 'out'), '--issuer-url', issuer.base, '--issuer-domain', issuer.domain, '--issuer-key', issuerKey,
      '--authority', A, '--domain', A + '=' + path.join(work, 'a.pem'), '--domain', B + '=' + path.join(work, 'b.pem'), '--web-path', '']).toString();
    const outDir = path.join(work, 'out');
    const holdCfg = JSON.parse(fs.readFileSync(path.join(outDir, 'issuer', 'atlas-gold-hold-config.json'), 'utf8'));
    const aAdapter = fs.readFileSync(path.join(outDir, A, 'gold-adapter.php'), 'utf8'), bAdapter = fs.readFileSync(path.join(outDir, B, 'gold-adapter.php'), 'utf8');
    const token = (/"token":"([a-f0-9]{64})"/.exec(aAdapter) || [])[1];
    line(holdCfg.enabled === true && holdCfg.tokenSha256 === crypto.createHash('sha256').update(token || '').digest('hex') && Object.keys(holdCfg.ledgerAuthorities).sort().join() === [A, B].sort().join(), 'the issuer config holds the token\'s hash and both domains\' keys', Object.keys(holdCfg));
    line(token && !bAdapter.includes(token) && !run.includes(token) && !fs.readFileSync(path.join(outDir, 'SETUP.txt'), 'utf8').includes(token), 'only the authority\'s adapter holds the token; the partner\'s, the printed summary and SETUP.txt do not');
    fs.copyFileSync(path.join(outDir, 'issuer', 'atlas-gold-hold-config.json'), path.join(issuer.bundle, 'lib', 'atlas-gold-hold-config.json'));
    fs.copyFileSync(path.join(outDir, A, 'gold-adapter.php'), a.adapter);
    fs.copyFileSync(path.join(outDir, B, 'gold-adapter.php'), b.adapter);
    await S.sleep(2500);
    line((await pe(a)).json.purchasesEnabled === true && (await pe(b)).json.purchasesEnabled === true, 'purchasesEnabled is true on both domains');
    const m1 = (await scan(a, 'action=market')).json.coins.find((c) => c.coinId === coinId);
    line(m1.offer.available === true && m1.offer.unavailableBecause === null && m1.price && m1.price.gold === '0.1', 'the market prices the coin: 0.1 Au per AETH, and the offer is available', m1.price);
    const hs = await fetch(issuer.base + '/atlas/ledger/gold-hold-status?credentialId=probe&requestId=' + '0'.repeat(32));
    line(hs.status === 404 && (await hs.json()).code === 'unknown-hold', 'the issuer\'s hold status answers (404 unknown hold for a probe)');
    const noToken = await fetch(issuer.base + '/atlas/ledger/gold-hold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status' }) });
    line(noToken.status === 401, 'the hold endpoint refuses a caller without the token');

    console.log('\n== 3. one purchase of test Gold for AETH');
    const w = wallet();
    const cred = await mint(w, 100);
    const sale = await buy(w, coinId, cred, 5);
    line(sale.res.status === 201 && sale.res.json.receipt.entry.amount === '50000000', '5 Au buys 50 AETH (50,000,000 units)', sale.res);
    line(await units(a, w, coinId) === '50000000', 'the buyer holds 50,000,000 units on the authority');
    line(await units(b, w, coinId) === '50000000', 'and the partner\'s copy of the ledger says the same');
    line(S.levelOk(await S.level(coinId, [A, B])), 'both ledgers have the same head');
    const remainder = JSON.parse(sale.res.json.balance.balance.gold);
    line(remainder.quantity === 95 && remainder.owner.publicKey === w.key, 'the Gold: a signed remainder of 95 comes back to the owner', remainder);
    line(revoked().filter((id) => id === cred.id).length === 1 && holdsFile()[cred.id].state === 'finalized', 'the original credential is revoked once and its hold is finalized');
    const m2 = (await scan(a, 'action=market')).json.coins.find((c) => c.coinId === coinId);
    line(m2.circulatingUnits === '50000000' && m2.volume24h.gold === '5' && m2.volume24h.purchases === 1, 'the market: 50 AETH circulating, 5 Au sold in 24h, 1 purchase', m2);

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
    const row = page.locator('#rows tr:not(:has(td.detail))', { has: page.locator('.symbol', { hasText: /^AETH$/ }) });
    await row.waitFor();
    const cells = (await row.locator('td').allInnerTexts()).map((t) => t.trim());
    line(/^0\.1 Au per AETH$/.test(cells[2]) && cells[3] === '5 Au' && cells[4] === '5 Au', 'the market page shows 0.1 Au per AETH, a market cap of 5 Au and 5 Au of volume', cells);
    line((await row.getByRole('button', { name: 'Buy with Gold' }).count()) === 0, 'with no wallet signed in there is no Buy button');
    signedIn = true;
    await page.reload();
    await row.waitFor();
    line((await row.getByRole('button', { name: 'Buy with Gold' }).count()) === 1, 'with a wallet signed in, AETH has a Buy with Gold button');
    line(errors.length === 0, 'the page logged no errors', errors);

    console.log('\n== 4. a partner that is down');
    const w2 = wallet();
    const cred2 = await mint(w2, 50);
    await stop(b);
    const held = await buy(w2, coinId, cred2, 2);
    line(held.res.status !== 201 && await units(a, w2, coinId) === '0' && holdsFile()[cred2.id].state === 'delivering', 'a sale made while the partner is down is not delivered; the Gold stays held', [held.res.status, held.res.json]);
    const cancelDown = await op(a, 'purchase-cancel', { coinId, requestId: held.requestId });
    line(cancelDown.status !== 200 && holdsFile()[cred2.id].state === 'delivering', 'and it cannot be cancelled without the partner either', cancelDown);
    await start(b);
    const rec = await op(a, 'purchase-recover', { coinId });
    line(await units(a, w2, coinId) === '20000000' && revoked().filter((id) => id === cred2.id).length === 1, 'when the partner is back, recovery delivers 20 AETH once and spends the Gold once', [rec.json, await units(a, w2, coinId)]);

    console.log('\n== 5. the switch');
    fs.rmSync(a.adapter);
    await S.sleep(2500);
    const m3 = (await scan(a, 'action=market')).json.coins.find((c) => c.coinId === coinId);
    line((await pe(a)).json.purchasesEnabled === false && m3.offer.available === false && m3.price === null, 'deleting the authority\'s adapter turns purchases off at once: no price, purchasesEnabled false');
    const off = await post(a, 'action=purchase', { coinId, intent: intent(w2, coinId, cred2, 2, hex(16)), credential: cred2 });
    line(off.status === 503, 'and a purchase request is refused', off);
  } catch (e) {
    console.log('ERROR ' + e.stack);
    failures++;
  } finally {
    await browser.close();
    issuer.stop();
    S.cleanup();
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' AETH REHEARSAL CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
