// A partner operator's consent to a proposed coin, in the Coin Creation Studio (chain-labs/coin26.html), in a real browser against live PHP
// servers (a.example the authority, b.example and c.example partners):
//   - the authority's Open button sends the proposal and says which partners have not accepted
//   - the partner's page lists the proposal with every term and the genesis digest, and never a reference secret
//   - listing, accepting and declining need a key file: the operator token is not used for them
//   - the Accept button waits for the operator to confirm the terms and the digest; the exact coin and digest are what is signed and sent
//   - decline then accept; and after the domain has signed, no Decline button is offered and the page says it cannot be taken back
//   - accepting does not open the coin: the authority presses Open again, which is a new signed request
//
//   xvfb-run -a node test/manual-chain-labs-studio-consent.js
'use strict';
const S = require('./support/chain-labs-servers');
const { A, B, C, nodes, start, createCoin, get } = S;
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/home/claude/.npm-global/lib/node_modules/playwright'); }

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };
const a = nodes[A], b = nodes[B], c = nodes[C];

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const browser = await playwright.chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route(/^https:\/\/[abc]\.example\/chain-labs\//, async (route) => {
      const u = new URL(route.request().url());
      const n = nodes[u.hostname];
      try {
        const res = await route.fetch({ url: 'http://127.0.0.1:' + n.port + u.pathname.replace(/^\/chain-labs/, '') + u.search, headers: { ...route.request().headers(), host: u.hostname } });
        await route.fulfill({ response: res });
      } catch (e) { await route.abort('connectionrefused'); }
    });
    const sent = [];
    const errors = [];
    const open = async (host) => {
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => { if (r.method() === 'POST') sent.push({ url: r.url(), body: r.postData() || '' }); });
      await page.goto('https://' + host + '/chain-labs/coin26.html');
      return page;
    };
    const keyFile = (identity) => ({ name: 'operator.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(identity)) });
    const loadKey = async (page, identity) => { await page.setInputFiles('#keyFile', keyFile(identity)); await page.waitForFunction(() => /^(Key loaded|Could not use)/.test(document.getElementById('keyState').innerText)); };
    const authority = await open('a.example');
    const partner = await open('b.example');
    const partnerC = await open('c.example');
    const card = (symbol) => authority.locator('.coin', { hasText: '(' + symbol + ')' });
    const opMsg = (page) => page.locator('#opMessage').innerText();
    const waitOp = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('opMessage').innerText), re.source, { timeout: 20000 });
    const propMsg = (page) => page.locator('#propMessage').innerText();
    const waitProp = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('propMessage').innerText), re.source, { timeout: 20000 });
    const stateOf = async (n, id) => { const r = await get(n, 'action=coin&coin=' + id); return r.json && r.json.ok ? r.json.state : 'none'; };
    const authorityOpens = async (symbol) => { await loadKey(authority, a.operator); await authority.evaluate(() => { document.getElementById('opMessage').textContent = ''; }); await card(symbol).getByRole('button', { name: /(Open|Finish opening) on the ledger/ }).click(); };

    const def = { decimals: 6, maxSupply: '1000000', initialSupply: '10000' };
    const one = (await createCoin(a, 'CNS', { ...def, mode: 'multi', partners: [B], threshold: 2 })).json;
    await authority.getByRole('button', { name: 'Refresh registry' }).click();
    await card('CNS').waitFor();

    console.log('== the authority sends the proposal');
    await authorityOpens('CNS');
    await waitOp(authority, /Could not open/);
    const m1 = await opMsg(authority);
    line(/has not accepted yet/.test(m1) && /b\.example/.test(m1) && /press the button again/.test(m1), 'Open says which partner has not accepted, and that pressing it again is a new signed request', m1);
    line((await stateOf(a, one.id)) === 'pending', 'the coin is still pending');

    console.log('\n== the partner operator reviews it');
    await partner.getByRole('button', { name: 'Load proposals' }).click();
    await waitProp(partner, /Could not load/);
    line(/Choose an operator key file first/.test(await propMsg(partner)), 'listing needs a key file');
    await partner.locator('#legacyBox summary').click();
    await partner.fill('#opToken', b.token);
    await partner.getByRole('button', { name: 'Load proposals' }).click();
    await waitProp(partner, /Could not load/);
    line(/Choose an operator key file first/.test(await propMsg(partner)) && !sent.some((s) => s.body.includes(b.token)), 'the operator token is not used for it, and is not sent');
    await loadKey(partner, b.operator);
    await partner.getByRole('button', { name: 'Load proposals' }).click();
    await waitProp(partner, /1 proposal loaded/);
    const prop = partner.locator('[data-coin="' + one.id + '"]');
    const text = await prop.innerText();
    const digest = (await get(a, 'action=coin&coin=' + one.id)).json.genesisDigest;
    line(/CNS · Coin CNS/.test(text) && /a\.example/.test(text) && /2 of 2 domains/.test(text) && /1000000\.000000/.test(text) && /10000\.000000/.test(text) && /Faucet/.test(text) && /Gold purchase\s*none/.test(text) && /\[authority\]/.test(text) && /\[this domain\]/.test(text), 'the proposal shows the symbol, authority, threshold, supply, faucet, purchase policy and roster', text);
    line(text.includes(digest) && /Waiting for you\. This domain has not signed\./.test(text), 'and the genesis digest the authority shows, with its state', digest);
    line(!/ref_secret|"refSecret"/.test(await partner.locator('#propList').innerHTML()), 'no reference secret is in the proposal');
    line(/No key loaded/.test(await partner.locator('#keyState').innerText()), 'the key was forgotten after the list, as it is by default');

    console.log('\n== accepting needs confirmation, a key, and names the coin and digest');
    const accept = prop.getByRole('button', { name: 'Accept this coin' });
    line(await accept.isDisabled(), 'Accept is disabled until the operator confirms the terms and the digest');
    await prop.locator('.propConfirm').check();
    await accept.click();
    await waitProp(partner, /Not done/);
    line(/Choose an operator key file first/.test(await propMsg(partner)) && (await accept.isEnabled()), 'with no key nothing is sent, and the button is available again');
    sent.length = 0;
    await loadKey(partner, b.operator);
    await accept.click();
    await waitProp(partner, /Accepted CNS/);
    const acc = sent.find((s) => /action=consent-accept/.test(s.url));
    const signed = acc ? JSON.parse(acc.body) : null;
    line(signed && signed.payload.request.coinId === one.id && signed.payload.request.digest === digest && signed.payload.adminAuth.action === 'spend34/consent-accept' && !('adminToken' in signed) && !acc.body.includes('"d":'), 'the signed request names the coin and the genesis digest, carries no token and no private key', signed && signed.payload);
    const after = await partner.locator('[data-coin="' + one.id + '"]').innerText();
    line(/Accepted on/.test(after) && /No signature has been issued yet/.test(after) && (await partner.locator('[data-coin="' + one.id + '"]').getByRole('button', { name: 'Decline this coin' }).count()) === 1, 'the card says accepted and not yet signed, and still offers to decline', after);
    line(/does not open the coin|not open/.test(await propMsg(partner)) && (await stateOf(a, one.id)) === 'pending', 'accepting does not open the coin');

    console.log('\n== opening takes a new signed request');
    await authorityOpens('CNS');
    await waitOp(authority, /is open on the ledger|Could not open/);
    line(/CNS is open on the ledger/.test(await opMsg(authority)) && /b\.example: signed; it reports that consent was recorded at/.test(await opMsg(authority)) && /not independent evidence/.test(await opMsg(authority)), 'the authority opens it and sees what the partner reported, described as its own report', await opMsg(authority));
    line((await stateOf(b, one.id)) === 'active', 'and the partner holds the coin as open');

    console.log('\n== decline, then accept');
    const two = (await createCoin(a, 'CN2', { ...def, mode: 'multi', partners: [B], threshold: 2 })).json;
    await authority.getByRole('button', { name: 'Refresh registry' }).click();
    await card('CN2').waitFor();
    await authorityOpens('CN2');
    await waitOp(authority, /Could not open/);
    await loadKey(partner, b.operator);
    await partner.getByRole('button', { name: 'Load proposals' }).click();
    await waitProp(partner, /1 proposal loaded/);
    const p2 = partner.locator('[data-coin="' + two.id + '"]');
    line((await partner.locator('[data-coin="' + one.id + '"]').count()) === 0, 'a coin that is open is no longer listed as a proposal');
    await p2.locator('.propReason').fill('I want a higher threshold');
    await loadKey(partner, b.operator);
    await p2.getByRole('button', { name: 'Decline this coin' }).click();
    await waitProp(partner, /Declined CN2/);
    const dtext = await partner.locator('[data-coin="' + two.id + '"]').innerText();
    line(/Declined on/.test(dtext) && /higher threshold/.test(dtext) && /You can still accept it/.test(dtext), 'a decline is shown with its reason, and can still be reversed', dtext);
    await authorityOpens('CN2');
    await waitOp(authority, /Could not open/);
    line(/b\.example: declined/.test(await opMsg(authority)), 'the authority sees it as declined');
    await partner.locator('[data-coin="' + two.id + '"] .propConfirm').check();
    await loadKey(partner, b.operator);
    await partner.locator('[data-coin="' + two.id + '"]').getByRole('button', { name: 'Accept this coin' }).click();
    await waitProp(partner, /Accepted CN2/);
    line(/Accepted on/.test(await partner.locator('[data-coin="' + two.id + '"]').innerText()), 'and then it is accepted');

    console.log('\n== after the domain has signed, declining is not offered');
    const three = (await createCoin(a, 'CN3', { ...def, mode: 'multi', partners: [B, C], threshold: 2 })).json;
    await authority.getByRole('button', { name: 'Refresh registry' }).click();
    await card('CN3').waitFor();
    await authorityOpens('CN3');
    await waitOp(authority, /Could not open/);
    await loadKey(partner, b.operator);
    await partner.getByRole('button', { name: 'Load proposals' }).click();
    await waitProp(partner, /proposals? loaded/);
    const p3 = partner.locator('[data-coin="' + three.id + '"]');
    await p3.locator('.propConfirm').check();
    await loadKey(partner, b.operator);
    await p3.getByRole('button', { name: 'Accept this coin' }).click();
    await waitProp(partner, /Accepted CN3/);
    await authorityOpens('CN3');
    await waitOp(authority, /Could not open/);
    const m3 = await opMsg(authority);
    line(/b\.example: signed/.test(m3) && /c\.example: has not accepted yet/.test(m3), 'the authority reports b.example signed and c.example still waiting', m3);
    await loadKey(partner, b.operator);
    await partner.getByRole('button', { name: 'Load proposals' }).click();
    await waitProp(partner, /proposals? loaded/);
    const s3 = partner.locator('[data-coin="' + three.id + '"]');
    const t3 = await s3.innerText();
    line(/has signed the genesis/.test(t3) && /cannot be taken back/.test(t3) && /can no longer be declined/.test(t3), 'the card says that the signature cannot be taken back', t3);
    line((await s3.getByRole('button', { name: 'Decline this coin' }).count()) === 0 && (await s3.locator('.propReason').count()) === 0, 'and offers no Decline button or reason box');
    line(!/revoke|withdraw|undo/i.test(t3.replace(/cannot be taken back|can no longer be declined/g, '')), 'nothing on it suggests the signature can be revoked');

    console.log('\n== the proposals are for the partner only');
    await loadKey(partnerC, c.operator);
    await partnerC.getByRole('button', { name: 'Load proposals' }).click();
    await waitProp(partnerC, /proposals? loaded/);
    line(/Waiting for you/.test(await partnerC.locator('[data-coin="' + three.id + '"]').innerText()), 'c.example, which has not accepted, sees the same coin as waiting for it');
    await loadKey(authority, a.operator);
    await authority.locator('#propRefresh').click();
    await waitProp(authority, /No coin is proposed|proposals? loaded|Could not/);
    line(/No coin is proposed to this domain|0 proposals loaded/.test((await propMsg(authority)) + (await authority.locator('#propList').innerText())), 'the authority has no proposals of its own to accept');

    line(errors.length === 0, 'no page errors', errors);
  } catch (e) {
    line(false, 'unexpected error: ' + (e.stack || e));
  } finally {
    await browser.close();
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
