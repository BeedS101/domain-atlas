// The Ledger tab while the wallet switches between the main identity and a sub-identity, in the real extension against live
// chain labs servers (test/support/chain-labs-servers.js). Each identity has its own domain list and cached answers; the open
// tab has to show the identity that is acting now without being reopened, and an answer that was still on its way for the
// previous identity must not be shown or stored for the new one.
//
// Throw-away identities and local servers only. Run: xvfb-run -a node test/manual-chain-labs-identity-switch.js
// ATLAS_TEST_EXT=<path> runs it against another copy of the extension (used to confirm the checks fail without the fix).
'use strict';
const L = require('./call-e2e-lib');
const S = require('./support/chain-labs-servers');
const { check, until } = L;
const { A, nodes } = S;

(async () => {
  for (const n of Object.values(nodes)) await S.start(n);
  const w = await L.launchWallet('chain-labs-identity-switch');
  try {
    const main = (await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'chain-labs-switch-password')).publicKey;
    const shopping = await w.wallet(() => AtlasWallet.createSubIdentity('Shopping'));
    const coin = (await S.createCoin(nodes[A], 'SGL')).json;
    await S.op(nodes[A], 'open', { coinId: coin.id });
    await S.op(nodes[A], 'grant', { coinId: coin.id, to: main, amount: '5000' });
    await S.op(nodes[A], 'grant', { coinId: coin.id, to: shopping.publicKey, amount: '700' });

    // Answers for the main identity's key can be held back, to leave a lookup in flight across a switch.
    let holdMainMs = 0;
    await w.context.route(/^https:\/\/[abc]\.example\/chain-labs\//, async (route) => {
      const u = new URL(route.request().url());
      const n = nodes[u.hostname];
      const headers = { ...route.request().headers(), host: u.hostname };
      if (holdMainMs && /action=holdings/.test(u.search) && (route.request().postData() || '').includes(main)) await S.sleep(holdMainMs);
      try {
        const res = await route.fetch({ url: 'http://127.0.0.1:' + n.port + u.pathname.replace(/^\/chain-labs/, '') + u.search, headers });
        await route.fulfill({ response: res });
      } catch (err) {
        await route.abort('connectionrefused');
      }
    });

    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    const asMain = () => w.wallet(() => AtlasWallet.switchIdentity(null));
    const asShopping = () => w.wallet((id) => AtlasWallet.switchIdentity(id), shopping.id);
    // Each identity lists the domain for itself.
    const listDomain = () => page.evaluate(async () => { const c = AtlasWallet.getChainLabs(); await c.addDomain('a.example'); await c.lookup('a.example'); });
    await listDomain();
    await asShopping();
    await listDomain();
    await asMain();

    const section = () => page.locator('#chainLabsSection').innerText();
    const shows = (re, ms) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById('chainLabsSection').innerText), re.source, { timeout: ms || 8000 }).then(() => true, () => false);
    const stored = (who) => page.evaluate(async (id) => { await AtlasWallet.switchIdentity(id); const r = await AtlasWallet.getChainLabs().rows(); return r.domains.map((d) => d.coins.map((c) => c.amount + ' ' + c.symbol).join()).join(); }, who);

    await page.click('#ledgerSubtabBtn');
    await page.waitForSelector('#ledgerSubscreen.active');
    check('the main identity\'s ledger shows its balance', await shows(/a\.example says you hold 50 SGL/), await section());

    console.log('--- switching while the Ledger tab is open ---');
    for (let round = 1; round <= 3; round++) {
      // Alternate between switching from this page and from another extension page (the wallet window).
      if (round % 2) await page.evaluate((id) => AtlasWallet.switchIdentity(id), shopping.id); else await asShopping();
      check('round ' + round + ': Shopping\'s balance appears without reopening the tab', await shows(/a\.example says you hold 7 SGL/), await section());
      check('round ' + round + ': nothing of the main identity\'s balance is left', !/50 SGL/.test(await section()), await section());
      if (round % 2) await page.evaluate(() => AtlasWallet.switchIdentity(null)); else await asMain();
      check('round ' + round + ': the main identity\'s balance returns', await shows(/a\.example says you hold 50 SGL/), await section());
      check('round ' + round + ': nothing of Shopping\'s balance is left', !/\b7 SGL/.test(await section()), await section());
    }

    console.log('--- a step left open belongs to the identity that began it ---');
    await page.locator('.chain-labs-coin', { hasText: 'SGL' }).getByRole('button', { name: 'Send…' }).click();
    await page.waitForSelector('#chainLabsSendTo');
    await page.fill('#chainLabsSendTo', 'typed for the main identity');
    await page.evaluate((id) => AtlasWallet.switchIdentity(id), shopping.id);
    check('switching closes the send step', await page.waitForSelector('#chainLabsSendTo', { state: 'detached', timeout: 6000 }).then(() => true, () => false));
    check('and the new identity\'s tab shows its own balance', await shows(/a\.example says you hold 7 SGL/), await section());
    await page.evaluate(() => AtlasWallet.switchIdentity(null));
    check('switching back does not bring the old step back', await shows(/a\.example says you hold 50 SGL/) && (await page.$('#chainLabsSendTo')) === null);

    console.log('--- an answer still on its way for the previous identity ---');
    holdMainMs = 2500;
    page.evaluate(() => AtlasWallet.getChainLabs().refresh()).catch(() => {}); // asks for the main identity's key; held back
    await S.sleep(400);
    await page.evaluate((id) => AtlasWallet.switchIdentity(id), shopping.id);
    check('the tab shows Shopping while the old answer is held', await shows(/a\.example says you hold 7 SGL/), await section());
    await S.sleep(holdMainMs + 1200);
    holdMainMs = 0;
    check('after the old answer arrives the tab still shows Shopping', /a\.example says you hold 7 SGL/.test(await section()) && !/50 SGL/.test(await section()), await section());
    check('and Shopping\'s stored answer is still its own', (await stored(shopping.id)) === '7 SGL', await stored(shopping.id));
    check('while the main identity\'s is its own too', (await stored(null)) === '50 SGL', await stored(null));

    console.log('--- the transfers still work ---');
    const bob = S.wallet();
    await page.evaluate(() => AtlasWallet.switchIdentity(null));
    await shows(/a\.example says you hold 50 SGL/);
    await page.locator('.chain-labs-coin', { hasText: 'SGL' }).getByRole('button', { name: 'Send…' }).click();
    await page.fill('#chainLabsSendTo', bob.key);
    await page.fill('#chainLabsSendAmount', '5');
    await page.getByRole('button', { name: 'Check…' }).click();
    await page.waitForFunction(() => /Send 5 SGL to key/.test(document.getElementById('chainLabsSection').innerText), null, { timeout: 15000 }).catch(async (e) => { console.log('SECTION ' + (await section()) + ' STATUS ' + (await page.locator('#chainLabsStatus').innerText())); throw e; });
    await page.getByRole('button', { name: 'Sign and send' }).click();
    check('a send from the main identity completes and shows the new balance', await shows(/a\.example says you hold 45 SGL/, 15000), await section());
    check('no page errors in the wallet page', errors.length === 0, errors);
  } finally {
    await w.close();
    S.cleanup();
  }
  process.exit(L.finish('manual-chain-labs-identity-switch'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); S.cleanup(); process.exit(1); });
