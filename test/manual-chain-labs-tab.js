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

    // While set, the receipts a domain gives for a transfer are made not to verify, the way a dishonest domain's would be.
    let breakReceipts = false;
    // While set, a transfer request is carried out by the domain but its answer never arrives.
    let dropAnswers = false;
    // While set, holdings lookups reach the domain without their nonce, the way a server that has not been updated sees them, so it
    // answers in the earlier form. Only meaningful before that form is switched off.
    let stripNonce = false;
    await w.context.route(/^https:\/\/[abc]\.example\/chain-labs\//, async (route) => {
      const u = new URL(route.request().url());
      const n = nodes[u.hostname];
      const headers = { ...route.request().headers(), host: u.hostname };
      try {
        const options = { url: 'http://127.0.0.1:' + n.port + u.pathname.replace(/^\/chain-labs/, '') + u.search, headers };
        if (stripNonce && /action=holdings/.test(u.search) && route.request().method() === 'POST') {
          const sent = JSON.parse(route.request().postData() || '{}');
          delete sent.nonce;
          options.postData = JSON.stringify(sent);
          delete headers['content-length'];
        }
        const res = await route.fetch(options);
        if (dropAnswers && /action=propose/.test(u.search)) {
          await route.abort('timedout');
          return;
        }
        if (breakReceipts && /action=(propose|proposal)/.test(u.search)) {
          const j = await res.json();
          const r = j.receipt || (j.proposal && j.proposal.receipt);
          if (r) r.authoritySignature = 'AAAA';
          await route.fulfill({ response: res, json: j });
          return;
        }
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
    const gone = await page.evaluate(() => ['ledgerAccountsList', 'ledgerAddBtn', 'ledgerFindBtn', 'ledgerOpenBtn', 'ledgerExperimental', 'ledgerCredentialInput'].every((id) => !document.getElementById(id)));
    check('the Ledger tab shows only the chain labs coins; the old account controls are gone', gone && (await page.$('#chainLabsSection')) !== null);
    check('it says the coins are kept by the domains and that adding a domain is the permission to ask', /kept by the domains below, not by this wallet/.test(await section()) && /permission to ask it/.test(await section()));

    if (process.env.LEDGER_SHOT) await page.screenshot({ path: process.env.LEDGER_SHOT });
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
    await page.evaluate((key) => AtlasWallet.addFriend(key, 'Bob Contact'), bob.key);
    await page.evaluate((key) => AtlasWallet.addFriend(key.slice(0, -1), 'Odd Key'), bob.key);
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
    check('the form offers the saved contacts, and one whose key cannot receive is not selectable', (await page.$$eval('#chainLabsSendContact option', (o) => o.map((x) => x.textContent + (x.disabled ? '|disabled' : '')))).some((t) => /^Bob Contact/.test(t) && !/disabled/.test(t)) && (await page.$$eval('#chainLabsSendContact option', (o) => o.some((x) => /^Odd Key/.test(x.textContent) && x.disabled))));
    await page.selectOption('#chainLabsSendContact', bob.key);
    check('choosing a contact fills in their key', (await page.inputValue('#chainLabsSendTo')) === bob.key);
    await page.fill('#chainLabsSendTo', 'edited by hand');
    check('typing a different key clears the contact choice', (await page.inputValue('#chainLabsSendContact')) === '');
    await page.selectOption('#chainLabsSendContact', bob.key);
    if (process.env.SEND_SHOT) await page.screenshot({ path: process.env.SEND_SHOT });
    await page.fill('#chainLabsSendAmount', '12.5');
    await page.getByRole('button', { name: 'Check…' }).click();
    await waitFor(/Send 12\.5 SGL to key/);
    check('the confirmation names the saved contact', /Saved contact: Bob Contact/.test(await section()));
    check('a valid transfer is described in words, and nothing is signed until it is approved', /Send 12\.5 SGL to key .* through a\.example\. You hold 50 SGL there/.test(await section()) && /signs this one transfer/.test(await section()));
    const before = (await S.post(nodes[A], 'action=holdings', { key: bob.key })).json.statement.coins.length;
    await page.getByRole('button', { name: 'Sign and send' }).click();
    await waitFor(/a\.example says you hold 37\.5 SGL/);
    check('approving sends it and the tab shows the new balance', /Sent\. The domain's receipt matches/.test(await text('#chainLabsStatus')) && /37\.5 SGL/.test(await section()));
    const got = (await S.post(nodes[A], 'action=holdings', { key: bob.key })).json.statement.coins;
    check('the recipient holds it at the domain', before === 0 && got.length === 1 && got[0].units === '1250');
    // A domain that made the transfer but whose receipt does not verify: the transfer stays on the list as unconfirmed.
    breakReceipts = true;
    await page.locator('.chain-labs-coin', { hasText: 'SGL' }).getByRole('button', { name: 'Send…' }).click();
    await page.fill('#chainLabsSendTo', bob.key);
    await page.fill('#chainLabsSendAmount', '1');
    await page.getByRole('button', { name: 'Check…' }).click();
    await waitFor(/Send 1 SGL to key/);
    await page.getByRole('button', { name: 'Sign and send' }).click();
    await waitFor(/Unconfirmed at a\.example: sending 1 SGL/);
    check('a transfer whose receipt does not verify is shown as unconfirmed, with the reason, and is not called failed', /receipt could not be verified \(/.test(await section()) && /will not send it again/.test(await section()) && /unconfirmed/i.test(await text('#chainLabsStatus')));
    const listed = await page.locator('.chain-labs-pending').count();
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.waitForFunction(() => /^A transfer is unconfirmed/.test(document.getElementById('chainLabsStatus').textContent), null, { timeout: 15000 });
    check('asking again while the receipt still fails keeps it listed and says it is unconfirmed', (await page.locator('.chain-labs-pending').count()) === listed && /unconfirmed/i.test(await text('#chainLabsStatus')));
    breakReceipts = false;
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.waitForFunction(() => !/Unconfirmed at a\.example/.test(document.getElementById('chainLabsSection').innerText), null, { timeout: 15000 });
    // A background refresh may settle it before Check now does; either way the transfer ends as made.
    check('and a receipt that verifies later settles it', (await page.locator('.chain-labs-pending').count()) === listed - 1 && !/Unconfirmed at a\.example/.test(await section()));
    // A transfer whose answer never arrives: the domain made it, the wallet keeps it as unknown and shows that.
    dropAnswers = true;
    await page.locator('.chain-labs-coin', { hasText: 'SGL' }).getByRole('button', { name: 'Send…' }).click();
    await page.fill('#chainLabsSendTo', bob.key);
    await page.fill('#chainLabsSendAmount', '1.5');
    await page.getByRole('button', { name: 'Check…' }).click();
    await waitFor(/Send 1\.5 SGL to key/);
    await page.getByRole('button', { name: 'Sign and send' }).click();
    await waitFor(/Outcome unknown at a\.example: sending 1\.5 SGL/);
    check('a transfer that gets no answer is shown as unknown, kept, and not called failed or sent', /may or may not have been made/.test(await section()) && /will not send it again/.test(await section()) && /may or may not have been made/.test(await text('#chainLabsStatus')));
    dropAnswers = false;
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.waitForFunction(() => !/Outcome unknown at a\.example/.test(document.getElementById('chainLabsSection').innerText), null, { timeout: 15000 });
    check('and the domain\'s answer about it settles it', (await page.locator('.chain-labs-pending').count()) === listed - 1);

    console.log('--- buying with Gold ---');
    const sglCoin = page.locator('.chain-labs-coin', { hasText: 'SGL' }), prvCoin = page.locator('.chain-labs-coin', { hasText: 'PRV' });
    check('Buy with Gold is offered on the coin that has purchase terms', (await sglCoin.getByRole('button', { name: 'Buy with Gold…' }).count()) === 1);
    check('and not on the coin that has none, which says so', (await prvCoin.getByRole('button', { name: 'Buy with Gold…' }).count()) === 0 && /Not for sale: this coin has no purchase terms/.test(await prvCoin.innerText()) && (await prvCoin.getByRole('button', { name: 'Send…' }).count()) === 1);
    await page.locator('.chain-labs-coin', { hasText: 'SGL' }).getByRole('button', { name: 'Buy with Gold…' }).click();
    await waitFor(/holds no Gold credential/);
    check('with no Gold in the wallet the step says so', /1 Gold buys 0\.1 SGL\. The smallest purchase is 5 Gold for 0\.5 SGL/.test(await section()) && /holds no Gold credential/.test(await section()));
    await page.getByRole('button', { name: 'Cancel' }).click();
    const gold = S.credential(100, { key: w.pub });
    await page.evaluate((g) => { AtlasWallet.inspectChainLabsGold = async () => ({ usable: [{ credential: g, quantity: 100, label: 'test · 100 Gold' }], excluded: [], identity: null }); }, gold);
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
    await waitFor(/a\.example says you hold 37 SGL/);
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
    check('a coin the domain calls frozen says so and offers neither Send nor Buy', (await page.locator('.chain-labs-coin', { hasText: 'SGL' }).getByRole('button').count()) === 0 && (await page.locator('.chain-labs-coin', { hasText: 'PRV' }).getByRole('button').count()) === 1);
    await page.evaluate(() => { AtlasWallet.getChainLabs().rows = window.__realRows; return AtlasChainLabsTab.render(); });
    await waitFor(/a\.example says you hold 37 SGL, as of/);
    await page.evaluate(() => {
      const chain = AtlasWallet.getChainLabs();
      const rows = chain.rows.bind(chain);
      window.__realRows = rows;
      window.__accepted = [];
      chain.acceptHead = async (domain, coinId, confirm) => { window.__accepted.push([domain, coinId, confirm]); };
      chain.rows = async () => { const v = await rows(); v.domains.forEach((d) => d.coins.forEach((c) => { if (c.symbol === 'SGL') c.integrity = { code: 'rollback-suspected', message: 'This domain now shows an older state of this coin than it did before.', trusted: { index: 4, hash: 'a'.repeat(64) }, seen: { index: 1, hash: 'b'.repeat(64) } }; })); return v; };
      return AtlasChainLabsTab.render();
    });
    await waitFor(/shows an older state of this coin/);
    const marked = page.locator('.chain-labs-coin', { hasText: 'SGL' });
    check('a coin whose domain went backwards says what was trusted and what is seen, and offers neither Send nor Buy', /entry 4 before and entry 1 now/.test(await marked.innerText()) && (await marked.getByRole('button', { name: /Send|Buy/ }).count()) === 0 && (await marked.getByRole('button', { name: /Trust what it says now/ }).count()) === 1 && (await page.locator('.chain-labs-coin', { hasText: 'PRV' }).getByRole('button', { name: 'Send…' }).count()) === 1, await marked.innerText());
    await marked.getByRole('button', { name: /Trust what it says now/ }).click();
    await waitFor(/This wallet last saw a\.example at entry 4 of SGL/);
    const trustText = await section();
    check('trusting asks first, says what it means and what it does not repair, and changes nothing yet', /put an old copy of its database back/.test(trustText) && /balances that were already spent can show again/.test(trustText) && /does not repair anything at the domain/.test(trustText) && /Nothing is changed until you press the button/.test(trustText) && (await page.evaluate(() => window.__accepted.length)) === 0, trustText.slice(0, 200));
    await page.getByRole('button', { name: 'Cancel' }).click();
    await until(async () => !/This wallet last saw a\.example at entry 4/.test(await section()), 5000);
    check('cancelling leaves the mark and accepts nothing', (await page.evaluate(() => window.__accepted.length)) === 0 && (await page.getByRole('button', { name: 'Trust the state it shows now' }).count()) === 0);
    await page.evaluate(() => AtlasChainLabsTab.render());
    await new Promise((r) => setTimeout(r, 300));
    check('and redrawing the tab does not accept it either', (await page.evaluate(() => window.__accepted.length)) === 0);
    await marked.getByRole('button', { name: /Trust what it says now/ }).click();
    await waitFor(/This wallet last saw a\.example at entry 4 of SGL/);
    await page.getByRole('button', { name: 'Trust the state it shows now' }).click();
    await until(async () => (await page.evaluate(() => window.__accepted.length)) === 1, 5000);
    const accepted = await page.evaluate(() => window.__accepted[0]);
    check('only the button in the confirmation accepts, and it repeats exactly the state that was shown', accepted[1].length === 32 && accepted[2].index === 1 && accepted[2].hash === 'b'.repeat(64), accepted);
    await page.evaluate(() => { AtlasWallet.getChainLabs().rows = window.__realRows; return AtlasChainLabsTab.render(); });
    await waitFor(/a\.example says you hold 37 SGL, as of/);
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
    check('the domain that is down says so, keeps its last answer, and the other is unaffected', /The domain did not answer\. Showing its last answer/.test(down) && /a\.example says you hold 37 SGL/.test(down) && /b\.example/.test(down));
    await S.start(nodes[A]);

    console.log('--- reopening ---');
    await page.reload();
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    check('the list and the last answers are kept on this device', (await page.evaluate(() => AtlasWallet.getChainLabs().domains())).length === 2 && (await page.evaluate(() => AtlasWallet.getChainLabs().rows())).domains[0].coins.length === 2);

    const raw = await page.evaluate(async () => { const g = await chrome.storage.local.get(['atlasChainLabsCache', 'atlasChainLabsDomains']); return { cache: JSON.stringify(g.atlasChainLabsCache || {}), domains: JSON.stringify(g.atlasChainLabsDomains || {}) }; });
    check('the cache of answers is stored encrypted, not as readable balances', /__atlasEncrypted/.test(raw.cache) && !/"SGL"|"units"/.test(raw.cache), raw.cache.slice(0, 120));
    check('the list itself holds host names, the public keys pinned for them and the newest entry shown for each coin, never a balance or a secret', /a\.example/.test(raw.domains) && !/seed|private|privateKey|units/i.test(raw.domains));

    console.log('--- the backup ---');
    const seed = created.seedPhrase;
    const pinOf = (list, domain) => { const d = list.find((x) => x.domain === domain); return d && d.holdings ? d.holdings.v : null; };
    const pinned = await page.evaluate(() => AtlasWallet.getChainLabs().domains());
    check('each domain that answered with a statement tied to its request is recorded as doing so, and the card shows no older-form note', pinOf(pinned, A) === 2 && pinOf(pinned, B) === 2 && (await page.evaluate(() => AtlasWallet.getChainLabs().rows())).domains.every((d) => d.legacy === false) && !/older holdings form/.test(await section()), pinned.map((d) => d.holdings));
    const backup = await w.wallet((a) => AtlasWallet.exportFullBackup(a.pw, a.seed), { pw: 'chain-labs-tab-password', seed });
    await w.wallet(async () => { await chrome.storage.local.clear(); await chrome.storage.session.clear(); });
    await w.wallet((a) => AtlasWallet.importFullBackup(a.file, a.pw, a.seed), { file: backup, pw: 'chain-labs-tab-password', seed });
    const restored = await page.evaluate(() => AtlasWallet.getChainLabs().domains());
    check('a restored wallet has the same domains with their pinned keys', restored.map((d) => d.domain).sort().join() === A + ',' + B && restored.every((d) => /BEGIN PUBLIC KEY/.test(d.key)), restored.map((d) => d.domain));
    check('and the record that each domain answers in the request-tied form is in the backup, so a restored wallet still refuses the earlier form', pinOf(restored, A) === 2 && pinOf(restored, B) === 2, restored.map((d) => d.holdings));
    const rows = await page.evaluate(() => AtlasWallet.getChainLabs().rows());
    check('and the answers cached before are not carried: it asks again', rows.domains.every((d) => d.never));
    await page.evaluate(() => AtlasWallet.getChainLabs().refresh());
    const again = await page.evaluate(() => AtlasWallet.getChainLabs().rows());
    check('after asking, the restored wallet finds its coins again', again.domains.find((d) => d.domain === A).coins.map((c) => c.symbol).sort().join() === 'PRV,SGL', again.domains.map((d) => [d.domain, d.problem, d.coins.length]));

    if (Date.now() < Date.UTC(2027, 1, 1)) {
      stripNonce = true;
      const refused = await page.evaluate(() => AtlasWallet.getChainLabs().lookup('a.example'));
      stripNonce = false;
      const keptRows = await page.evaluate(() => AtlasWallet.getChainLabs().rows());
      const keptA = keptRows.domains.find((d) => d.domain === A);
      check('a restored wallet refuses a domain that goes back to the earlier form, says why, and keeps its last answer', refused.ok === false && refused.reason === 'downgrade' && /redeploy/.test(keptA.problem) && keptA.coins.length === 2, [refused.reason, keptA.problem]);
      check('nothing it pinned for that domain was removed', pinOf(await page.evaluate(() => AtlasWallet.getChainLabs().domains()), A) === 2);
      await page.evaluate(() => AtlasWallet.getChainLabs().lookup('a.example'));
      check('and the next lookup, once the domain answers properly again, works with nothing to reset', (await page.evaluate(() => AtlasWallet.getChainLabs().rows())).domains.find((d) => d.domain === A).problem === null);
      // A wallet that has never seen this domain answer in the request-tied form: the mark is taken off the stored record.
      await page.evaluate(async (owner) => {
        const g = await chrome.storage.local.get('atlasChainLabsDomains');
        const all = g.atlasChainLabsDomains || {};
        all[owner] = (all[owner] || []).map((d) => { const c = Object.assign({}, d); delete c.holdings; return c; });
        await chrome.storage.local.set({ atlasChainLabsDomains: all });
      }, w.pub);
      stripNonce = true;
      await page.evaluate(() => AtlasWallet.getChainLabs().lookup('a.example'));
      await page.reload();
      await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
      await page.evaluate(() => routeWalletScreen());
      await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
      await openLedger();
      await waitFor(/older holdings form/);
      check('a domain still answering in the earlier form is read, and the card says until when', /still answers in the older holdings form\. It works until 31 January 2027/.test(await section()) && (await page.evaluate(() => AtlasWallet.getChainLabs().rows())).domains.find((d) => d.domain === A).coins.length === 2);
      stripNonce = false;
      await page.evaluate(() => AtlasWallet.getChainLabs().lookup('a.example'));
      await page.reload();
      await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
      await page.evaluate(() => routeWalletScreen());
      await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
      await openLedger();
      await page.waitForFunction(() => { const t = document.getElementById('chainLabsSection').innerText; return /a\.example says you hold/.test(t) && !/older holdings form/.test(t); }, null, { timeout: 15000 }).catch(() => null);
      check('once it answers in the request-tied form the note goes and the mark is recorded again', !/older holdings form/.test(await section()) && pinOf(await page.evaluate(() => AtlasWallet.getChainLabs().domains()), A) === 2, [(await section()).includes("older holdings form"), await page.evaluate(() => AtlasWallet.getChainLabs().domains().then((l) => l.map((d) => [d.domain, d.holdings])))]);
    }

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
