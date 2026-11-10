// The "Chain labs coins" section of the wallet's Ledger tab, driven the way a person would, in the real extension against
// three live PHP servers running the chain labs endpoint (test/support/chain-labs-servers.js): adding a domain, reading
// what it holds, sending, buying with Gold, a domain that stops answering, removing a domain, and the backup.
//
// The domains are reached through the browser's request routing, which sends https://a.example/chain-labs/... to the local
// server for that domain. The wallet's Gold is replaced by test credentials, since no issuer is running here.
//
// Needs no demo domain. Run: xvfb-run -a node test/manual-chain-labs-tab.js
'use strict';
const L = require('./call-e2e-lib');
const S = require('./support/chain-labs-servers');
const { check, until } = L;
const { A, B, nodes } = S;

(async () => {
  for (const n of Object.values(nodes)) await S.start(n);
  const w = await L.launchWallet('chain-labs-tab');
  try {
    const created = await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'chain-labs-tab-password');
    w.pub = created.publicKey;
    const bob = S.wallet();

    const sgl = (await S.createCoin(nodes[A], 'SGL')).json;
    const prv = (await S.createCoin(nodes[A], 'PRV', { visibility: 'private' })).json;
    await S.op(nodes[A], 'open', { coinId: sgl.id, purchase: S.POLICY });
    await S.op(nodes[A], 'open', { coinId: prv.id });
    await S.op(nodes[A], 'grant', { coinId: sgl.id, to: w.pub, amount: '5000' });
    await S.op(nodes[A], 'grant', { coinId: prv.id, to: w.pub, amount: '700' });

    await w.context.route(/^https:\/\/[abc]\.example\/chain-labs\//, async (route) => {
      const u = new URL(route.request().url());
      const n = nodes[u.hostname];
      const headers = { ...route.request().headers(), host: u.hostname };
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
    const text = (sel) => page.locator(sel).innerText();
    const section = () => text('#chainLabsSection');
    const openLedger = async () => { await page.click('#ledgerSubtabBtn'); await page.waitForSelector('#ledgerSubscreen.active'); };
    const waitFor = (re) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById('chainLabsSection').innerText), re.source, { timeout: 15000 }).catch(async (e) => { console.log('TIMEOUT waiting for ' + re + '\n' + (await section())); throw e; });

    console.log('--- the section ---');
    await openLedger();
    await waitFor(/No domains on the list yet/);
    const order = await page.evaluate(() => { const s = document.getElementById('chainLabsSection'), a = document.getElementById('ledgerAccountsList'); return !!(s.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); });
    check('it sits above the ledger account list, which is still there', order && (await page.$('#ledgerAddBtn')) !== null);
    check('it says the coins are kept by the domains and that adding a domain is the permission to ask', /kept by the domains below, not by this wallet/.test(await section()) && /permission to ask it/.test(await section()));

    console.log('--- adding a domain ---');
    await page.fill('#chainLabsAddInput', 'not a domain');
    await page.getByRole('button', { name: 'Add…', exact: true }).click();
    check('something that is not a domain is refused on the spot', /not a domain name/.test(await text('#chainLabsStatus')));
    await page.fill('#chainLabsAddInput', A);
    await page.getByRole('button', { name: 'Add…', exact: true }).click();
    await waitFor(/Ask a\.example what your key holds/);
    check('adding asks first and says what will be fetched and pinned', /Ask a\.example what your key holds/.test(await section()) && /pin it/.test(await section()));
    await page.getByRole('button', { name: 'Cancel' }).click();
    check('cancelling adds nothing', /No domains on the list yet/.test(await section()) && (await page.evaluate(() => AtlasWallet.getChainLabs().domains())).length === 0);
    await page.fill('#chainLabsAddInput', A);
    await page.getByRole('button', { name: 'Add…', exact: true }).click();
    await page.getByRole('button', { name: 'Add and ask' }).click();
    await waitFor(/a\.example says you hold 50 SGL/);
    const t = await section();
    check('the domain\'s signed answer is shown as the domain\'s statement, with the coin and balance', /a\.example says you hold 50 SGL, as of /.test(t) && /a\.example says you hold 7 PRV/.test(t), t);
    check('each coin says its mode, visibility and that the answer was proven by the wallet\'s signature', /one authority · public · proven with your signature/.test(t) && /one authority · private · proven/.test(t));
    check('the card shows the pinned key\'s fingerprint', /key [a-f0-9]{16} pinned/.test(t));
    check('the wallet\'s own lists are untouched by any of it', (await page.$$eval('#selfCollectiblesList .wallet-item, #selfDocumentsList .wallet-item', (e) => e.length)) === 0);

    console.log('--- sending ---');
    await page.locator('.chain-labs-coin', { hasText: 'SGL' }).getByRole('button', { name: 'Send…' }).click();
    await page.fill('#chainLabsSendTo', 'nonsense');
    await page.fill('#chainLabsSendAmount', '1');
    await page.getByRole('button', { name: 'Check…' }).click();
    await page.waitForFunction(() => /not a wallet key/.test(document.getElementById('chainLabsStatus').textContent));
    check('a recipient that is not a key is refused before anything is signed', /not a wallet key/.test(await text('#chainLabsStatus')));
    await page.fill('#chainLabsSendTo', bob.key);
    await page.fill('#chainLabsSendAmount', '12.345');
    await page.getByRole('button', { name: 'Check…' }).click();
    await page.waitForFunction(() => /decimal places/.test(document.getElementById('chainLabsStatus').textContent));
    check('an amount with too many decimal places is refused', /at most 2 decimal places/.test(await text('#chainLabsStatus')));
    await page.fill('#chainLabsSendTo', bob.key);
    await page.fill('#chainLabsSendAmount', '12.5');
    await page.getByRole('button', { name: 'Check…' }).click();
    await waitFor(/Send 12\.5 SGL to key/);
    check('a valid transfer is described in words, and nothing is signed until it is approved', /Send 12\.5 SGL to key .* through a\.example\. You hold 50 SGL there/.test(await section()) && /signs this one transfer/.test(await section()));
    const before = (await S.post(nodes[A], 'action=holdings', { key: bob.key })).json.statement.coins.length;
    await page.getByRole('button', { name: 'Sign and send' }).click();
    await waitFor(/a\.example says you hold 37\.5 SGL/);
    check('approving sends it and the tab shows the new balance', /Sent\. The domain's receipt matches/.test(await text('#chainLabsStatus')) && /37\.5 SGL/.test(await section()));
    const got = (await S.post(nodes[A], 'action=holdings', { key: bob.key })).json.statement.coins;
    check('the recipient holds it at the domain', before === 0 && got.length === 1 && got[0].units === '1250');

    console.log('--- buying with Gold ---');
    await page.locator('.chain-labs-coin', { hasText: 'SGL' }).getByRole('button', { name: 'Buy with Gold…' }).click();
    await waitFor(/holds no Gold to pay with/);
    check('with no Gold in the wallet the step says so', /Each Gold buys 10 units/.test(await section()) && /holds no Gold/.test(await section()));
    await page.getByRole('button', { name: 'Cancel' }).click();
    const gold = S.credential(100, { key: w.pub });
    await page.evaluate((g) => { AtlasWallet.getChainLabsGold = async () => [{ credential: g, quantity: 100, label: 'test · 100 Gold' }]; }, gold);
    await page.locator('.chain-labs-coin', { hasText: 'SGL' }).getByRole('button', { name: 'Buy with Gold…' }).click();
    await waitFor(/Gold to pay with/);
    await page.fill('#chainLabsPrice', '3');
    await page.getByRole('button', { name: 'Check…' }).click();
    await page.waitForFunction(() => /smallest/.test(document.getElementById('chainLabsStatus').textContent));
    check('a price under the coin\'s minimum is refused before signing', /The smallest is 5/.test(await text('#chainLabsStatus')));
    await page.fill('#chainLabsPrice', '20');
    await page.getByRole('button', { name: 'Check…' }).click();
    await waitFor(/Pay 20 Gold to get 2 SGL from a\.example/);
    check('the purchase is described: what is paid, what is received and that the Gold credential is sent', /sends the Gold credential to the domain/.test(await section()));
    await page.getByRole('button', { name: 'Sign and buy' }).click();
    await waitFor(/a\.example says you hold 39\.5 SGL/);
    check('approving delivers the coin and the tab shows it', /Bought\. The domain delivered the coin/.test(await text('#chainLabsStatus')));

    console.log('--- a frozen coin and the page structure ---');
    await page.evaluate(() => {
      const chain = AtlasWallet.getChainLabs();
      const rows = chain.rows.bind(chain);
      window.__realRows = rows;
      chain.rows = async () => { const v = await rows(); v.domains.forEach((d) => d.coins.forEach((c) => { if (c.symbol === 'SGL') c.state = 'frozen'; })); return v; };
      return AtlasChainLabsTab.render();
    });
    await waitFor(/It is frozen: the domains disagree/);
    check('a coin the domain calls frozen says so and offers neither Send nor Buy', (await page.locator('.chain-labs-coin', { hasText: 'SGL' }).getByRole('button').count()) === 0 && (await page.locator('.chain-labs-coin', { hasText: 'PRV' }).getByRole('button').count()) === 2);
    await page.evaluate(() => { AtlasWallet.getChainLabs().rows = window.__realRows; return AtlasChainLabsTab.render(); });
    await waitFor(/a\.example says you hold 39\.5 SGL, as of/);
    check('the section is a labelled group for screen readers', await page.evaluate(() => { const s = document.getElementById('chainLabsSection'); const h = document.getElementById(s.getAttribute('aria-labelledby')); return !!h && /Chain labs coins/.test(h.textContent); }));

    console.log('--- what the signer will sign ---');
    const signed = await page.evaluate(async () => { try { return await AtlasWallet.signChainLabs({ type: 'atlas.ledger.transfer', v: 1 }); } catch (e) { return { error: e.message }; } });
    check('the signer makes a raw 64-byte signature with the wallet\'s key for a chain labs message', signed.publicKey === w.pub && /^[A-Za-z0-9_-]{86}$/.test(signed.signature), signed);
    const refused = await page.evaluate(async () => {
      const out = {};
      for (const type of ['atlas.ledger.account.open', 'atlas.call.offer', 'something.else', undefined]) { try { await AtlasWallet.signChainLabs({ type }); out[String(type)] = 'signed'; } catch (e) { out[String(type)] = 'refused'; } }
      try { await AtlasWallet.signWithSelf({ type: 'atlas.ledger.transfer', v: 1 }); out.generic = 'signed'; } catch (e) { out.generic = 'refused'; }
      return out;
    });
    check('it refuses any other kind of message, and the generic signer still refuses ledger messages', Object.values(refused).every((v) => v === 'refused'), refused);

    console.log('--- a domain that stops answering ---');
    await page.fill('#chainLabsAddInput', B);
    await page.getByRole('button', { name: 'Add…', exact: true }).click();
    await page.getByRole('button', { name: 'Add and ask' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chain-labs-domain').length === 2);
    await S.stop(nodes[A]);
    await page.getByRole('button', { name: 'Ask all domains again' }).click();
    await waitFor(/The domain did not answer/);
    const down = await section();
    check('the domain that is down says so, keeps its last answer, and the other is unaffected', /The domain did not answer\. Showing its last answer/.test(down) && /a\.example says you hold 39\.5 SGL/.test(down) && /b\.example/.test(down));
    await S.start(nodes[A]);

    console.log('--- reopening ---');
    await page.reload();
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    check('the list and the last answers are kept on this device', (await page.evaluate(() => AtlasWallet.getChainLabs().domains())).length === 2 && (await page.evaluate(() => AtlasWallet.getChainLabs().rows())).domains[0].coins.length === 2);

    const raw = await page.evaluate(async () => { const g = await chrome.storage.local.get(['atlasChainLabsCache', 'atlasChainLabsDomains']); return { cache: JSON.stringify(g.atlasChainLabsCache || {}), domains: JSON.stringify(g.atlasChainLabsDomains || {}) }; });
    check('the cache of answers is stored encrypted, not as readable balances', /__atlasEncrypted/.test(raw.cache) && !/SGL|units/.test(raw.cache), raw.cache.slice(0, 120));
    check('the list itself holds only host names and the public keys pinned for them', /a\.example/.test(raw.domains) && !/seed|private|privateKey/i.test(raw.domains));

    console.log('--- the backup ---');
    const seed = created.seedPhrase;
    const backup = await w.wallet((a) => AtlasWallet.exportFullBackup(a.pw, a.seed), { pw: 'chain-labs-tab-password', seed });
    await w.wallet(async () => { await chrome.storage.local.clear(); await chrome.storage.session.clear(); });
    await w.wallet((a) => AtlasWallet.importFullBackup(a.file, a.pw, a.seed), { file: backup, pw: 'chain-labs-tab-password', seed });
    const restored = await page.evaluate(() => AtlasWallet.getChainLabs().domains());
    check('a restored wallet has the same domains with their pinned keys', restored.map((d) => d.domain).sort().join() === A + ',' + B && restored.every((d) => /BEGIN PUBLIC KEY/.test(d.key)), restored.map((d) => d.domain));
    const rows = await page.evaluate(() => AtlasWallet.getChainLabs().rows());
    check('and the answers cached before are not carried: it asks again', rows.domains.every((d) => d.never));
    await page.evaluate(() => AtlasWallet.getChainLabs().refresh());
    const again = await page.evaluate(() => AtlasWallet.getChainLabs().rows());
    check('after asking, the restored wallet finds its coins again', again.domains.find((d) => d.domain === A).coins.map((c) => c.symbol).sort().join() === 'PRV,SGL', again.domains.map((d) => [d.domain, d.problem, d.coins.length]));

    console.log('--- removing a domain ---');
    await page.reload();
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    await openLedger();
    await waitFor(/b\.example/);
    await page.locator('.chain-labs-domain', { hasText: 'b.example' }).getByRole('button', { name: 'Remove from list' }).click();
    await waitFor(/Take b\.example off the list/);
    check('removing asks first and says nothing changes at the domain', /Take b\.example off the list\? .* Nothing at the domain changes/.test(await section()));
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await until(async () => (await page.$$('.chain-labs-domain')).length === 1, 8000);
    check('after agreeing the domain is gone and the other stays', (await page.$$('.chain-labs-domain')).length === 1 && !/b\.example/.test((await section()).replace(/Take b\.example.*/, '')));
    check('no page errors in the wallet page', errors.length === 0, errors);
  } finally {
    await w.close();
    S.cleanup();
  }
  process.exit(L.finish('manual-chain-labs-tab'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); S.cleanup(); process.exit(1); });
