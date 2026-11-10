// Buy with Gold on the market page (chain-labs/index.html) opening the real wallet extension's purchase prompt, against live PHP
// servers (test/support/chain-labs-servers.js):
//   - a wallet that owns none of the coin can buy it: the prompt adds the authority domain only after the owner agrees
//   - the prompt shows the exact coin quantity, Gold cost, selected credential and receiving identity before anything is signed
//   - nothing is signed or spent until Sign and buy; Cancel and a closed prompt leave the ledger untouched
//   - after settlement the coin appears in the wallet's Ledger tab without reopening it
//   - a missing, outdated, locked or not-permitted wallet gets a clear message instead of a dead button
//   - the page can only name a domain and a coin; malformed requests and coins with no offer open nothing that can sign
//
// The wallet holds a real Gold credential minted by a throw-away Domain Atlas issuer (the issuer-php code), and the authority uses the
// real Gold adapter against it: the issuer holds the credential from the owner's signed intent, the ledger delivers the coin, the issuer
// spends the credential and returns the rest, which the wallet takes in place of the spent one.
// The target is the controlled purchase: 1 Gold buys 10 of a 6-decimal coin, using one Gold credential.
//   xvfb-run -a node test/manual-chain-labs-market-buy.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./call-e2e-lib');
const S = require('./support/chain-labs-servers');
const crypto = require('crypto');
const { startPhp, api } = require('./lib/gen1-issuers');
const { check, until } = L;
const { A, nodes } = S;
const GOLD = 'atlas.element.gold';
const TOKEN = crypto.randomBytes(24).toString('hex');
const adapterFile = (n, issuer, issuerKey, token) => "<?php\nrequire_once '" + path.join(n.root, 'lib', 'gold-issuer.php') + "';\n$cfg = json_decode('" + JSON.stringify({ issuerUrl: issuer.base, issuerDomain: issuer.domain, issuerKey, token: token || undefined, timeout: 5 }) + "', true);\nreturn gold_issuer_adapter($cfg);\n";
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/home/claude/.npm-global/lib/node_modules/playwright'); }

const policyFor = (issuerKey) => ({ priceClass: GOLD, issuerKey, unitsPerPrice: 10000000, minPrice: 1, perKeyUnits: '3000000000', perDayUnits: '30000000000' });
const def = { decimals: 6, maxSupply: '1000000', initialSupply: '100000' };

(async () => {
  const issuer = await startPhp(9261 + Math.floor(Math.random() * 100), { workers: 0 });
  const IA = api(issuer);
  const issuerKey = JSON.parse(fs.readFileSync(issuer.keyFile, 'utf8')).keys[0].publicKey;
  const POLICY = policyFor(issuerKey);
  const a0 = nodes[A];
  fs.writeFileSync(path.join(issuer.bundle, 'lib', 'atlas-gold-hold-config.json'), JSON.stringify({ enabled: true, tokenSha256: crypto.createHash('sha256').update(TOKEN).digest('hex'), ledgerAuthorities: { [A]: a0.pair.publicKey.export({ type: 'spki', format: 'pem' }) } }));
  for (const n of Object.values(nodes)) fs.writeFileSync(n.adapter, adapterFile(n, issuer, issuerKey, n.domain === A ? TOKEN : null));
  for (const n of Object.values(nodes)) await S.start(n);
  const w = await L.launchWallet('market-buy');
  let plain = null;
  try {
    const created = await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'market-buy-password');
    w.pub = created.publicKey;
    const a = nodes[A];
    const aeth = (await S.createCoin(a, 'AETH', def)).json, flat = (await S.createCoin(a, 'FLAT', def)).json;
    await S.op(a, 'open', { coinId: aeth.id, purchase: POLICY });
    await S.op(a, 'open', { coinId: flat.id });
    let gold = null;
    const owned = async () => (await S.units(a, { key: w.pub }, aeth.id));

    let manifestReadable = true, signedIn = true;
    const route = async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/.well-known/spatial.json') {
        if (!manifestReadable) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ spec: 'domain-atlas/1.0', domain: A, walletBridge: { read: true }, worlds: [{ id: 'market', name: 'Market', policy: {} }] }) });
      }
      const file = u.pathname.replace(/^\/chain-labs\//, '');
      if (file === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, '..', 'chain-labs', 'index.html')) });
      if (file === 'market-login28.php') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(signedIn ? { ok: true, loggedIn: true, publicKey: w.pub } : { ok: true, loggedIn: false }) });
      if (file === 'market27.php') {
        const coins = (await S.call(a, 'coin26', 'GET', 'action=list')).json.coins;
        const stats = { [A]: (await S.scan(a, 'action=market')).json, 'b.example': { ok: true, coins: [] } };
        const out = execFileSync('php', [path.join(__dirname, 'support', 'market-merge.php')], { input: JSON.stringify({ coins, stats }) }).toString();
        return route.fulfill({ status: 200, contentType: 'application/json', body: out });
      }
      try {
        const res = await route.fetch({ url: 'http://127.0.0.1:' + a.port + '/' + file + u.search, headers: { ...route.request().headers(), host: A } });
        await route.fulfill({ response: res });
      } catch (err) { await route.abort('connectionrefused'); }
    };
    await w.context.route(/^https:\/\/a\.example\//, route);

    const errors = [];
    const market = await w.context.newPage();
    market.on('pageerror', (e) => errors.push(e.message));
    const openMarket = async () => {
      await market.bringToFront();
      await market.goto('https://a.example/chain-labs/index.html');
      await market.locator('#rows .symbol', { hasText: /^AETH$/ }).waitFor();
      await market.waitForFunction(() => /Buy with Gold/.test(document.getElementById('loginState').textContent) || document.getElementById('walletTag').textContent !== 'Wallet not connected', null, { timeout: 10000 });
    };
    const buyButton = () => market.locator('#rows tr', { has: market.locator('.symbol', { hasText: /^AETH$/ }) }).getByRole('button', { name: 'Buy with Gold' });
    const prompt = () => market.frameLocator('#domain-atlas-bridge-confirm');
    const note = () => market.locator('#buyNote').innerText();
    const waitNote = (re) => market.waitForFunction((s) => new RegExp(s).test(document.getElementById('buyNote').textContent), re.source, { timeout: 20000 }).catch(async (e) => { console.log('TIMEOUT waiting for ' + re + '\n' + (await note())); throw e; });
    const domains = () => ledger.evaluate(() => AtlasWallet.getChainLabs().domains());

    const ledger = await w.context.newPage();
    ledger.on('pageerror', (e) => errors.push(e.message));
    await ledger.goto('chrome-extension://' + w.extId + '/viewer.html');
    await ledger.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    await ledger.evaluate(() => routeWalletScreen());
    await ledger.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    await ledger.click('#ledgerSubtabBtn');
    await ledger.waitForSelector('#ledgerSubscreen.active');
    await ledger.waitForFunction(() => /No domains on the list yet/.test(document.getElementById('chainLabsSection').innerText), null, { timeout: 15000 });
    check('the wallet starts with no domains and so no AETH in its Ledger tab', (await domains()).length === 0 && !/AETH/.test(await ledger.locator('#chainLabsSection').innerText()));

    console.log('--- the market button ---');
    await openMarket();
    check('the market shows Buy with Gold on AETH at 0.1 Au per coin', (await buyButton().count()) === 1 && /0\.1 Au per AETH/.test(await market.locator('#rows tr', { has: market.locator('.symbol', { hasText: /^AETH$/ }) }).first().innerText()));
    await buyButton().click();
    await market.locator('#domain-atlas-bridge-confirm').waitFor({ timeout: 15000 });
    check('clicking opens the wallet\'s own prompt over the page', (await market.locator('#domain-atlas-bridge-confirm').count()) === 1);
    check('the page says it is waiting for the wallet and that nothing is signed until approval', /Opening your wallet to buy AETH/.test(await note()) && /nothing is signed until you approve/.test(await note()));
    await prompt().getByText('is not on your chain labs list').waitFor();
    check('a coin the wallet owns none of starts by saying the authority domain is not on the list and what adding does', /a\.example is not on your chain labs list\. Continuing adds it/.test(await prompt().locator('#buyBody').innerText()) && /Nothing is bought yet/.test(await prompt().locator('#buyBody').innerText()));
    check('the prompt names the requesting site', /a\.example/.test(await prompt().locator('#buyOrigin').innerText()));
    check('nothing has been added or bought yet', (await domains()).length === 0 && (await owned()) === '0');
    await prompt().getByRole('button', { name: 'Cancel' }).click();
    await waitNote(/No purchase was made/);
    check('cancelling ends the request with a message, adds no domain and buys nothing', (await domains()).length === 0 && (await owned()) === '0' && (await market.locator('#domain-atlas-bridge-confirm').count()) === 0 && (await buyButton().isEnabled()));

    console.log('--- no Gold yet ---');
    await buyButton().click();
    await prompt().getByRole('button', { name: 'Add and continue' }).click();
    await prompt().locator('#buyBody .problem').waitFor({ timeout: 15000 });
    check('the terms are read once the owner agrees, and a wallet with no Gold says exactly that', /1 Gold buys 10 AETH/.test(await prompt().locator('#buyBody').innerText()) && /holds no Gold credential \(atlas\.element\.gold\) for the active identity/.test(await prompt().locator('#buyBody').innerText()), await prompt().locator('#buyBody').innerText());
    check('the domain is on the list now, because the owner agreed', (await domains()).map((d) => d.domain).join() === A);
    await prompt().getByRole('button', { name: 'Close' }).click();
    await waitNote(/No purchase was made/);

    console.log('--- a real Gold credential in the wallet ---');
    const minted = await w.wallet(([d, q]) => AtlasWallet.mintAsset('self', d, 'atlas.element.gold', q), [issuer.domain, 10]);
    gold = minted.credential || minted;
    check('the issuer signed a 10 Gold credential for the wallet\'s key, with the quantity on the credential itself', gold.credential === 'domain-atlas-asset/1.0' && gold.quantity === 10 && gold.owner.publicKey === w.pub && gold.asset.class === GOLD && gold.asset.fungible === true, { quantity: gold.quantity, asset: gold.asset });
    const report = await ledger.evaluate(() => AtlasWallet.inspectChainLabsGold());
    check('the wallet\'s inventory lists it as usable Gold', report.usable.length === 1 && report.usable[0].quantity === 10 && report.excluded.length === 0 && report.usable[0].credential.id === gold.id, report);

    console.log('--- review before approval ---');
    await buyButton().click();
    await prompt().getByText('Gold to pay with').first().waitFor({ timeout: 15000 }).catch(async (e) => { console.log('BODY', await prompt().locator('#buyBody').innerText()); throw e; });
    const form = await prompt().locator('#buyBody').innerText();
    check('the form states the terms read from the domain: 1 Gold buys 10 AETH, smallest purchase 1 Gold', /AETH from a\.example/.test(form) && /1 Gold buys 10 AETH\. The smallest purchase is 1 Gold for 10 AETH/.test(form), form);
    check('the Gold credential is offered by label and id', (await prompt().locator('#buyGold option').count()) === 1 && (await prompt().locator('#buyGold option').innerText()).includes('10 Gold') && (await prompt().locator('#buyGold option').innerText()).includes(gold.id.slice(0, 16)));
    check('the price defaults to the smallest purchase', (await prompt().locator('#buyPrice').inputValue()) === '1');
    await prompt().locator('#buyPrice').fill('0');
    await prompt().getByRole('button', { name: 'Review purchase' }).click();
    await prompt().getByText('below the smallest price').waitFor();
    check('a price under the minimum is refused before anything is signed', (await owned()) === '0');
    await prompt().locator('#buyPrice').fill('11');
    await prompt().getByRole('button', { name: 'Review purchase' }).click();
    await prompt().getByText('more Gold than the credential holds').waitFor();
    check('more Gold than the credential holds is refused', (await owned()) === '0');
    await prompt().locator('#buyPrice').fill('1');
    await prompt().getByRole('button', { name: 'Review purchase' }).click();
    await prompt().locator('#buySummary').waitFor();
    const sum = await prompt().locator('#buySummary').innerText();
    check('the summary gives the exact quantity received', /You receive: 10 AETH/.test(sum), sum);
    check('the summary gives the Gold cost', /You pay: 1 Gold/.test(sum), sum);
    check('the summary names the selected credential', sum.includes(issuer.domain + ' · 10 Gold') && sum.includes(gold.id), sum);
    check('the summary names the receiving identity: the wallet\'s own key', sum.includes('Receiving identity: ' + w.pub), sum);
    check('the summary names the seller and the asking site', /Sold by: a\.example/.test(sum) && /Asked by: https:\/\/a\.example/.test(sum), sum);
    check('the prompt says approving signs one purchase and sends the credential', /signs this one purchase with your key and sends the Gold credential to a\.example/.test(await prompt().locator('#buyBody').innerText()));
    check('nothing has been signed or spent while the summary is showing', (await owned()) === '0');
    await prompt().getByRole('button', { name: 'Cancel' }).click();
    await waitNote(/No purchase was made/);
    check('cancelling from the summary buys nothing', (await owned()) === '0');

    console.log('--- approval and settlement ---');
    await ledger.bringToFront();
    check('the Ledger tab is open and still shows no AETH', !/AETH/.test(await ledger.locator('#chainLabsSection').innerText()) || /holds nothing|lists nothing/.test(await ledger.locator('#chainLabsSection').innerText()));
    await market.bringToFront();
    await buyButton().click();
    await prompt().locator('#buyGold').waitFor();
    await prompt().getByRole('button', { name: 'Review purchase' }).click();
    await prompt().locator('#buySummary').waitFor();
    await prompt().getByRole('button', { name: 'Sign and buy' }).click();
    await prompt().locator('#buyResult').waitFor({ timeout: 30000 });
    const result = await prompt().locator('#buyResult').innerText();
    check('the prompt reports the purchase and that it shows in the Ledger tab', /Bought 10 AETH\. a\.example delivered the coin and returned the rest of your Gold/.test(result) && /Ledger tab/.test(result), result);
    check('the authority delivered exactly 10 AETH to the wallet\'s key', (await owned()) === '10000000', await owned());
    await prompt().getByRole('button', { name: 'Close' }).click();
    await waitNote(/Bought AETH/);
    check('the page confirms and the prompt is gone', /It now shows in your wallet/.test(await note()) && (await market.locator('#domain-atlas-bridge-confirm').count()) === 0);
    await until(async () => /a\.example says you hold 10 AETH/.test(await ledger.locator('#chainLabsSection').innerText()), 15000, 300);
    check('AETH appears in the open Ledger tab without reopening it', /a\.example says you hold 10 AETH/.test(await ledger.locator('#chainLabsSection').innerText()));
    check('the purchase left no unfinished request in the wallet', (await ledger.evaluate(() => AtlasWallet.getChainLabs().rows())).pendingBuys.length === 0);
    const holds = (() => { try { return JSON.parse(fs.readFileSync(path.join(issuer.bundle, 'lib', 'holds', 'holds.json'), 'utf8')).holds; } catch (e) { return {}; } })();
    check('the issuer\'s hold for it ended finalized with exactly what the owner signed: 1 Gold, 10 AETH worth, to the wallet\'s key', holds[gold.id] && holds[gold.id].state === 'finalized' && holds[gold.id].price === 1 && holds[gold.id].recipient === w.pub && holds[gold.id].coinId === aeth.id, holds[gold.id]);
    check('the spent 10 Gold credential is revoked at the issuer, once', (IA.revocations() || []).filter((r) => r.id === gold.id).length === 1);
    const after = await ledger.evaluate(() => AtlasWallet.inspectChainLabsGold());
    check('the wallet now holds the issuer\'s remainder of 9 Gold in its place', after.usable.length === 1 && after.usable[0].quantity === 9 && after.usable[0].credential.supersedes === gold.id && after.excluded.length === 0, after);
    const remainder = after.usable[0].credential;
    const second = await S.post(a, 'action=purchase', { coinId: aeth.id, intent: { payload: { type: 'atlas.ledger.purchase.intent', v: 1, coinId: aeth.id, credentialId: remainder.id, price: 1, recipient: w.pub, requestId: S.hex(16), expiresAt: S.iso(S.NOW() + 300) }, signature: 'x'.repeat(86) }, credential: remainder });
    check('the authority still refuses an intent that was not signed by the owner', second.status >= 400 && (await owned()) === '10000000', second.json);

    console.log('--- why a Gold credential cannot be used ---');
    const reasons = await ledger.evaluate((c) => {
      const entry = (over, cred) => Object.assign({ credential: Object.assign(JSON.parse(JSON.stringify(c)), cred || {}) }, over);
      const id = { publicKey: c.owner.publicKey };
      const t = (e) => AtlasWallet.chainLabsGoldProblem(e, e.credential, id, Date.now());
      return {
        ok: t(entry({})),
        spent: t(entry({ spent: { reason: 'revoked' } })),
        revoked: t(entry({ lastVerdict: { status: 'revoked', reason: 'clawback' } })),
        pending: t(entry({ pendingOutcome: { state: 'pending' } })),
        stranger: t(entry({}, { owner: { publicKey: 'other' } })),
        bound: t(entry({}, { asset: Object.assign({}, c.asset, { tradeScope: 'bound' }) })),
        fractional: t(entry({}, { quantity: 1.5 })),
        expired: t(entry({}, { asset: Object.assign({}, c.asset, { expiresAt: '2020-01-01T00:00:00Z' }) })),
        local: t(entry({}, { asset: Object.assign({}, c.asset, { tradeScope: 'local' }) }))
      };
    }, remainder);
    check('a normal local-scope credential has no problem', reasons.ok === null && reasons.local === null, reasons);
    check('spent, revoked, unfinished, foreign, bound, fractional and expired credentials each get their own reason', /marked it spent/.test(reasons.spent) && /revoked it \(clawback\)/.test(reasons.revoked) && /not finished/.test(reasons.pending) && /different key/.test(reasons.stranger) && /bound to its owner/.test(reasons.bound) && /whole number/.test(reasons.fractional) && /expired/.test(reasons.expired), reasons);
    const described = await ledger.evaluate(() => AtlasChainLabs.describeNoGold({ excluded: [{ id: 'urn:x', label: 'issuer · 10 Gold', reason: 'the issuer has marked it spent' }] }));
    check('and the prompt\'s sentence names the credential and the reason', /issuer · 10 Gold \(urn:x\) cannot be used because the issuer has marked it spent/.test(described), described);

    console.log('--- missing, locked and not-permitted wallets ---');
    plain = await playwright.chromium.launch();
    const bare = await plain.newContext();
    await bare.route(/^https:\/\/a\.example\//, route);
    const barePage = await bare.newPage();
    await barePage.goto('https://a.example/chain-labs/index.html');
    await barePage.locator('#rows .symbol', { hasText: /^AETH$/ }).waitFor();
    await barePage.evaluate(() => { window.chainblockMarketWallet = 'key'; window.dispatchEvent(new Event('chainblock-login-change')); });
    await barePage.getByRole('button', { name: 'Buy with Gold' }).first().click();
    const bareNote = await barePage.locator('#buyNote').innerText();
    check('with no wallet extension the button says so and what to do', /wallet extension was not detected/.test(bareNote) && /Install it, unlock your wallet/.test(bareNote), bareNote);
    await barePage.evaluate(() => { window.atlasWallet = { getIdentity: async () => ({ allowed: true, publicKey: 'k' }) }; });
    await barePage.getByRole('button', { name: 'Buy with Gold' }).first().click();
    check('an extension without the purchase call says it is too old', /too old to buy from this page/.test(await barePage.locator('#buyNote').innerText()));
    await bare.close();

    await w.wallet(() => AtlasWallet.lockIdentity());
    await openMarket();
    await buyButton().click();
    await market.locator('#domain-atlas-bridge-confirm').waitFor({ timeout: 15000 });
    await prompt().getByText('No wallet identity is unlocked right now').waitFor();
    check('a locked wallet shows a clear prompt that says to unlock and try again', /Unlock your wallet, then press Buy with Gold again/.test(await prompt().locator('#lockedDetailLine').innerText()));
    await prompt().getByRole('button', { name: 'Dismiss' }).click();
    await waitNote(/wallet may be locked/);
    check('and the page says no purchase was made, and what to do', /Unlock your wallet and choose Buy with Gold again/.test(await note()) && (await owned()) === '10000000');
    await w.wallet((pw) => AtlasWallet.unlockIdentity(pw), 'market-buy-password');

    manifestReadable = false;
    await openMarket();
    await buyButton().click();
    await waitNote(/did not open/);
    check('a site whose manifest does not allow the wallet bridge gets a message, and no prompt opens', (await market.locator('#domain-atlas-bridge-confirm').count()) === 0 && /allowed to work with this site/.test(await note()));
    manifestReadable = true;

    console.log('--- what a page can ask for ---');
    await openMarket();
    const bad = await market.evaluate(async () => {
      const out = {};
      out.noArgs = await window.atlasWallet.requestPurchase();
      out.badCoin = await window.atlasWallet.requestPurchase({ domain: 'a.example', coinId: 'nope' });
      out.badDomain = await window.atlasWallet.requestPurchase({ domain: 'a.example/../x', coinId: '0'.repeat(32) });
      return out;
    });
    check('a malformed request is refused at once with no prompt', [bad.noArgs, bad.badCoin, bad.badDomain].every((r) => r.allowed === false && r.result === null) && (await market.locator('#domain-atlas-bridge-confirm').count()) === 0, bad);
    await market.evaluate(() => { window.__extra = window.atlasWallet.requestPurchase({ domain: 'a.example', coinId: '0'.repeat(32), price: 999, recipient: 'attacker', credential: {} }); });
    await market.locator('#domain-atlas-bridge-confirm').waitFor({ timeout: 10000 });
    await prompt().locator('#buyBody .problem').waitFor({ timeout: 15000 });
    const extra = await prompt().locator('#buyBody').innerText();
    check('a price, recipient or credential smuggled into the request is ignored: the prompt shows only the wallet\'s own figures', !/999|attacker/.test(extra), extra);
    check('a coin the authority does not know is not for sale', /This coin is not for sale/.test(extra) && (await prompt().getByRole('button', { name: 'Sign and buy' }).count()) === 0, extra);
    await prompt().getByRole('button', { name: 'Close' }).click();
    await market.evaluate(() => new Promise((r) => setTimeout(r, 300)));

    const flatResult = market.evaluate((id) => window.atlasWallet.requestPurchase({ domain: 'a.example', coinId: id }), flat.id);
    await market.locator('#domain-atlas-bridge-confirm').waitFor({ timeout: 10000 });
    await prompt().locator('#buyBody .problem').waitFor({ timeout: 15000 });
    const flatText = await prompt().locator('#buyBody').innerText();
    check('a coin with no purchase terms says it is not for sale and offers no way to sign', /This coin is not for sale/.test(flatText) && (await prompt().getByRole('button', { name: 'Sign and buy' }).count()) === 0, flatText);
    await prompt().getByRole('button', { name: 'Close' }).click();
    const fr = await flatResult;
    check('and the page gets a null result for it', fr.allowed === true && fr.result === null, fr);

    check('no page errors on the market page or the wallet', errors.length === 0, errors);
  } finally {
    if (plain) await plain.close().catch(() => {});
    issuer.stop();
    await w.close();
    S.cleanup();
  }
  process.exit(L.finish('MARKET BUY'));
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
