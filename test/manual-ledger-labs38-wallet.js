// The wallet's Labs 38 signed-receipt interface, in a real Chromium with the extension loaded,
// against the receipt endpoint of the real PHP issuer (issuer-php) and the Node test mirror.
//
// The browser asks for https://evtec.co.za/..., which Chromium resolves to a local HTTPS front (a
// throwaway certificate, accepted for this run only). The front sends /chain-labs/ to the Labs 29
// ledger service when there is one, and everything else to the issuer; it can also alter what the
// issuer answers, which is how the wallet is shown an attacker or a misbehaving issuer. The Labs 29
// databases are Core's own when CORE_LABS_DIR (or the staged Core checkout) is available, and the
// Labs 29 balance service is then Core's real ledger29.php under PHP; otherwise a schema stand-in
// and the parts that need that service are skipped, and say so. Nothing touches a live site.
//
// Run: xvfb-run -a node test/manual-ledger-labs38-wallet.js
'use strict';
const fs = require('fs');
const E = require('./call-e2e-lib');
const R = require('./ledger-receipts-lib');
const { makeCert, chromiumArgs } = require('./ledger-https-front');
const { check } = E;
const { DOMAIN, NETWORK, ROUTE } = R;
const BIG = { perClientPerMinute: 1000, perOwnerPerHour: 1000, globalPerHour: 10000 };
const SIGNED_LABEL = 'Signed ledger report — Not final or spendable';
const UNSIGNED_LABEL = 'Reported — Not Cryptographically Verified';
const LABS29_PATH = '/chain-labs/ledger29.php?action=balance';
const clone = (x) => JSON.parse(JSON.stringify(x));

async function run(kind, ledger, tls) {
  const tag = '[' + kind + '] ';
  const t = (name, ok, detail) => check(tag + name, ok, detail);
  const issuer = await R.startReceiptIssuer(kind, ledger); // receipts left OFF: the operator enables them below
  const hits = [];
  const mutators = [];
  const fr = await R.receiptFront(issuer, ledger.base ? ledger : null, tls, hits, mutators);
  const w = await E.launchWallet('l38-' + kind, { args: chromiumArgs(fr.port) });
  const W = w.wallet;
  const receiptPosts = () => hits.filter((h) => h.method === 'POST' && h.url === ROUTE);
  const receiptGets = () => hits.filter((h) => h.method === 'GET' && h.url === ROUTE);
  const labs29Hits = () => hits.filter((h) => h.url === LABS29_PATH);
  const keyDocGets = () => hits.filter((h) => h.url === '/.well-known/atlas-key.json');
  const overview = () => W(() => AtlasWallet.getLedgerOverview());
  const acct = async () => (await overview()).accounts[0];
  const refresh = (id, reason) => W(([i, r]) => AtlasWallet.refreshLedgerAccount(i, { reason: r || 'manual' }), [id, reason]);
  const setExp = (name, on) => W(([n, o]) => AtlasWallet.setLedgerExperimental(n, o), [name, on]);
  const mutate = (re, fn, method) => { mutators.push({ re, fn, method }); return mutators[mutators.length - 1]; };
  const clearMutators = () => { mutators.length = 0; };
  const recordAnswers = [];
  try {
    const created = await W((pw) => AtlasWallet.createIdentity(pw), 'labs38-test-password');
    const mine = created.publicKey;
    const id = R.derivedId(NETWORK, 'GOPH', mine);
    ledger.addAccountRow(mine, 'GOPH', 4200000);
    const cred = await issuer.credentialFor(mine, 'GOPH');
    const added = await W((c) => AtlasWallet.addLedgerAccount(c, { allowNetwork: true }), cred);
    t('the wallet holds a reference to the account, checked against the issuer\'s published key', added && added.id === id);

    console.log('--- ' + tag + 'off by default: nothing is contacted ---');
    let ov = await overview();
    const x38 = ov.experimental.find((x) => x.name === 'labs38'), x29 = ov.experimental.find((x) => x.name === 'labs29');
    t('the signed-report interface is listed, is a separate switch from Labs 29, and is off', x38 && x38.enabled === false && x38.available === true && x38.signed === true && x29 && x29.enabled === false, ov.experimental);
    const baseHits = hits.length;
    let r = await refresh(id);
    t('a lookup without permission is refused', r.ok === false && r.code === 'no-consent' && hits.length === baseHits, r);
    await W((i) => AtlasWallet.grantLedgerConsent(i), id);
    r = await refresh(id);
    t('with permission but the interface off, there is no way to reach the ledger and nothing is sent', r.ok === false && r.code === 'no-adapter' && hits.length === baseHits, r);
    ov = await overview();
    t('background checking is off', ov.accounts[0].backgroundSync === false);
    t('the Ledger tab says there is no balance', ov.accounts[0].balance === null);

    console.log('--- ' + tag + 'the interface is on, the issuer\'s receipts are off: a failure, not a fallback ---');
    await setExp('labs38', true);
    r = await refresh(id);
    t('the lookup fails because the issuer is not signing reports', r.ok === false && r.code === 'receipts-off', r);
    t('exactly one request was made: the status document at the exact receipt address', receiptGets().length === 1 && receiptPosts().length === 0 && hits.length === baseHits + 1, hits.slice(baseHits).map((h) => h.method + ' ' + h.url));
    t('nothing was sent to the Labs 29 balance address, and no unsigned answer was used', labs29Hits().length === 0);
    let a = await acct();
    t('no balance was recorded and the problem is shown in words', a.balance === null && a.problem && a.problem.code === 'receipts-off' && /fall back/.test(a.problem.text), a.problem);

    console.log('--- ' + tag + 'the operator enables receipts: a verified, signed report ---');
    issuer.enable(BIG);
    mutate(new RegExp('^' + ROUTE.replace(/\//g, '\\/') + '$'), ({ json }) => { recordAnswers.push(clone(json)); }, 'POST');
    const issuedBefore = hits.length;
    r = await refresh(id);
    t('the lookup succeeds and is marked signed', r.ok === true && r.balance.verification === 'signed' && r.balance.text === '4.200000', r);
    a = await acct();
    t('the tab shows the signed label, and only that label', a.balance && a.balance.verification.label === SIGNED_LABEL && a.balance.verification.level === 'signed' && a.balance.text === '4.200000', a.balance && a.balance.verification);
    t('it names the signing domain, the signing key and the statement time', a.balance.signed && a.balance.signed.by === DOMAIN && a.balance.signed.signerKey === issuer.publishedKey() && a.balance.signed.at === recordAnswers[0].payload.observedAt && a.balance.asOf === a.balance.signed.at, a.balance.signed);
    t('the interface shown is Labs 38', a.balance.interface && a.balance.interface.contract === 'chainblock-ledger38/signed-receipt-experimental', a.balance.interface);
    t('the pinned address is the receipt address, not the Labs 29 one', a.pinnedEndpoint === R.RECEIPT_URL, a.pinnedEndpoint);
    const sent = hits.slice(issuedBefore);
    t('the wallet made the status request, the receipt request, and read the issuer\'s published keys and revocations', sent.map((h) => h.method + ' ' + h.url).sort().join('|') === ['GET ' + ROUTE, 'POST ' + ROUTE, 'GET /.well-known/atlas-key.json', 'GET /.well-known/atlas-revocations.json'].sort().join('|'), sent.map((h) => h.method + ' ' + h.url));
    const body = JSON.parse(receiptPosts()[receiptPosts().length - 1].body);
    t('the request body is exactly a seven-field payload and a key-and-signature proof', JSON.stringify(Object.keys(body).sort()) === '["payload","proof"]' && JSON.stringify(Object.keys(body.payload).sort()) === '["audience","coin","issuedAt","network","nonce","type","v"]' && JSON.stringify(Object.keys(body.proof).sort()) === '["publicKey","signature"]', body);
    t('it names the receipt request type and the exact address, and carries no quantity', body.payload.type === 'atlas.ledger.balance-receipt.request' && body.payload.audience === R.RECEIPT_URL && body.payload.coin === 'GOPH' && body.payload.network === NETWORK && body.proof.publicKey === mine && !/amount|quantity|units/i.test(Object.keys(body.payload).concat(Object.keys(body.proof)).join()));
    const independent = await R.verifyReceipt(recordAnswers[0], body, issuer.keyDoc());
    t('an independent check of the same answer agrees', independent.ok, independent);
    if (kind === 'php' && ledger.real) {
      const cli = R.runVerify38(require('os').tmpdir(), issuer.keyDoc(), body, recordAnswers[0]);
      t('Core\'s verify38.php agrees', cli.code === 0 && /^PASS/.test(cli.out), cli);
    }
    t('the ledger itself was not changed by looking', (await ledger.balanceOf(mine, 'GOPH')) === 4200000);
    t('background checking is still off', (await acct()).backgroundSync === false);

    console.log('--- ' + tag + 'what the Ledger tab shows ---');
    const page = await w.context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.click('#ledgerSubtabBtn');
    await page.waitForSelector('#ledgerSubscreen.active');
    await page.waitForSelector('.ledger-account .ledger-verify');
    const card = page.locator('.ledger-account').first();
    const cardText = await card.innerText();
    t('the card carries the signed label', (await card.locator('.ledger-verify').innerText()) === SIGNED_LABEL, cardText);
    t('...and not the unsigned one', !cardText.includes(UNSIGNED_LABEL));
    t('it shows the signed figure with the signing domain and the statement time', /Signed balance: 4\.200000/.test(cardText) && cardText.includes('Signed by ' + DOMAIN) && /statement time/.test(cardText) && cardText.includes('(key ' + await page.evaluate(async () => (await AtlasWallet.getLedgerOverview()).accounts[0].balance.signed.signerShort) + ')'), cardText);
    t('it still says the report is not final or spendable', /not a final or spendable balance/.test(await card.locator('[data-role=verification]').innerText()));
    await page.click('#ledgerExperimental summary');
    await page.waitForSelector('#exp-labs38');
    t('the signed-report switch is its own switch, already on here', (await page.isChecked('#exp-labs38')) && !(await page.isChecked('#exp-labs29')));
    await page.click('#exp-labs38');
    await page.waitForFunction(() => /is off/.test(document.getElementById('ledgerStatus').textContent));
    await page.click('#exp-labs38');
    const ask = await page.innerText('#ledgerConfirmText');
    t('turning it on asks first, in its own words: signed report, own address, checked, no unsigned fallback, not spendable, background off', /Labs 38/.test(ask) && /signed balance report/.test(ask) && /own address/.test(ask) && /publishes/.test(ask) && /no unsigned lookup is tried/.test(ask) && /not a final or spendable balance/.test(ask) && /Background checks stay off/.test(ask), ask);
    await page.click('#ledgerConfirmOk');
    await page.waitForFunction(() => document.getElementById('exp-labs38').checked);
    t('the wallet page raised no errors', pageErrors.length === 0, pageErrors);
    await page.close();

    console.log('--- ' + tag + 'a receipt that has been tampered with is never used ---');
    const kept = (await acct()).balance;
    const postCount = () => receiptPosts().length;
    const attack = async (name, fn, code) => {
      clearMutators();
      mutate(new RegExp('^' + ROUTE.replace(/\//g, '\\/') + '$'), ({ json }) => { const j = clone(json); fn(j); return { json: j }; }, 'POST');
      const before = postCount(), l29 = labs29Hits().length;
      const out = await refresh(id);
      const now = await acct();
      t('a ' + name + ' is refused as ' + code, out.ok === false && out.code === code, out);
      t('...exactly one attempt, no retry, no unsigned fallback', postCount() === before + 1 && labs29Hits().length === l29);
      t('...and the balance on show is unchanged, with the failure beside it', now.balance && now.balance.signed.at === kept.signed.at && now.balance.text === kept.text && now.problem && now.problem.code === code, now.problem);
    };
    await attack('changed amount', (j) => { j.payload.amount = '999999999'; }, 'receipt-invalid');
    await attack('changed decimals', (j) => { j.payload.decimals = 2; }, 'receipt-invalid');
    await attack('changed owner', (j) => { j.payload.owner = 'B' + 'A'.repeat(86); }, 'receipt-invalid');
    await attack('changed account', (j) => { j.payload.account = 'urn:atlas:ledger-account:' + 'ab'.repeat(32); }, 'receipt-invalid');
    await attack('changed coin', (j) => { j.payload.coin = 'MWC'; }, 'receipt-invalid');
    await attack('changed network', (j) => { j.payload.network = 'chainblock-labs29-domain-atlas.co.za'; }, 'receipt-invalid');
    await attack('changed request hash', (j) => { j.payload.request.hash = '0'.repeat(64); }, 'receipt-invalid');
    await attack('changed request nonce', (j) => { j.payload.request.nonce = 'ff'.repeat(16); }, 'receipt-invalid');
    await attack('changed statement time', (j) => { j.payload.observedAt = '2026-01-01T00:00:00Z'; }, 'receipt-invalid');
    await attack('claimed ledger state', (j) => { j.payload.state = { sequence: '0', asOf: j.payload.observedAt }; }, 'receipt-invalid');
    await attack('corrupted signature', (j) => { j.signature = j.signature.slice(0, -2) + (j.signature.endsWith('AA') ? 'BB' : 'AA'); }, 'receipt-invalid');
    await attack('receipt with an unknown field', (j) => { j.payload.spendable = true; }, 'receipt-invalid');
    await attack('receipt with an unknown outer field', (j) => { j.verified = true; }, 'receipt-invalid');
    await attack('receipt naming a signer the issuer does not publish', (j) => { j.signerKey = 'B' + 'A'.repeat(86); }, 'signer-unknown');

    console.log('--- ' + tag + 'a genuine receipt for some other request is not today\'s answer ---');
    clearMutators();
    const stored = recordAnswers[0];
    mutate(new RegExp('^' + ROUTE.replace(/\//g, '\\/') + '$'), () => ({ json: stored }), 'POST');
    let before = postCount();
    r = await refresh(id);
    t('yesterday\'s genuine receipt replayed to the wallet is refused', r.ok === false && r.code === 'receipt-invalid', r);
    const second = await R.newOwner();
    ledger.addAccountRow(second.key, 'GOPH', 777);
    const theirs = (await issuer.post(await R.buildReceiptRequest(second, 'GOPH'))).json;
    t('(set-up) another owner\'s genuine receipt exists', theirs && theirs.ok === true && theirs.payload.amount === '777');
    clearMutators();
    mutate(new RegExp('^' + ROUTE.replace(/\//g, '\\/') + '$'), () => ({ json: theirs }), 'POST');
    r = await refresh(id);
    t('another owner\'s genuine receipt is refused', r.ok === false && r.code === 'receipt-invalid', r);
    t('...and the balance on show is still the earlier signed one', (await acct()).balance.text === '4.200000' && (await acct()).balance.signed.at === kept.signed.at);
    clearMutators();

    console.log('--- ' + tag + 'the issuer\'s key is decided by what it publishes ---');
    const attackDocs = async (name, re, fn, expectOk, code) => {
      clearMutators();
      mutate(re, fn);
      const out = await refresh(id);
      const ok = expectOk ? out.ok === true && out.balance.verification === 'signed' : out.ok === false && out.code === code;
      t(name + (expectOk ? ' still gives a signed report' : ' is refused as ' + code), ok, out);
      clearMutators();
    };
    const KEYS = /^\/\.well-known\/atlas-key\.json$/, REVS = /^\/\.well-known\/atlas-revocations\.json$/;
    await attackDocs('a key document that lists no keys', KEYS, () => ({ json: { keys: [] } }), false, 'signer-unknown');
    await attackDocs('a key that has expired', KEYS, ({ json }) => ({ json: { keys: json.keys.map((k) => Object.assign({}, k, { validUntil: R.iso(Date.now() - 60000) })) } }), false, 'signer-unknown');
    await attackDocs('a key that is not valid yet', KEYS, ({ json }) => ({ json: { keys: json.keys.map((k) => Object.assign({}, k, { validFrom: R.iso(Date.now() + 3600000) })) } }), false, 'signer-unknown');
    await attackDocs('a key document that cannot be reached (502)', KEYS, () => ({ status: 502, text: 'bad gateway' }), false, 'signer-unknown');
    await attackDocs('a key document that is missing (404)', KEYS, () => ({ status: 404, text: '{}' }), false, 'signer-unknown');
    await attackDocs('a key document that is not JSON', KEYS, () => ({ text: '<html>' }), false, 'signer-unknown');
    await attackDocs('a key document that redirects', KEYS, () => ({ status: 302, text: '' }), false, 'signer-unknown');
    await attackDocs('a revocation list that lists the signing key', REVS, () => ({ json: { revoked: [{ id: issuer.publishedKey() }] } }), false, 'signer-unknown');
    await attackDocs('a revocation list that lists the account', REVS, () => ({ json: { revoked: [{ id }] } }), false, 'account-revoked');
    await attackDocs('a revocation list that cannot be read (500)', REVS, () => ({ status: 500, text: 'oops' }), false, 'signer-unknown');
    await attackDocs('a revocation list that is not JSON', REVS, () => ({ status: 200, text: 'nope' }), false, 'signer-unknown');
    await attackDocs('a revocation list the domain does not publish (404)', REVS, () => ({ status: 404, text: '{}' }), true);
    await attackDocs('a revocation list that revokes other accounts', REVS, () => ({ json: { revoked: [{ id: 'urn:atlas:ledger-account:' + 'cd'.repeat(32) }] } }), true);
    if (kind === 'php') {
      // The real issuer's own checks as well: its published key document decides, and the wallet agrees.
      const keep = issuer.keyDoc();
      issuer.setKeyDoc({ keys: keep.keys.map((k) => Object.assign({}, k, { validUntil: R.iso(Date.now() - 60000) })) });
      r = await refresh(id);
      t('the issuer itself refuses to sign when its published key has ended (not the wallet\'s doing)', r.ok === false && r.code === 'receipt-unavailable', r);
      issuer.setKeyDoc(keep);
    }

    console.log('--- ' + tag + 'the issuer\'s other answers become the wallet\'s problems, never a balance ---');
    clearMutators();
    for (const [code, status, want] of [['ledger-unavailable', 502, 'receipt-unavailable'], ['account-not-found', 404, 'not-found'], ['account-revoked', 409, 'account-revoked'], ['rate-limited', 429, 'rate-limited'], ['replayed-request', 409, 'busy'], ['stale-request', 401, 'clock'], ['issuer-key-unavailable', 503, 'receipt-unavailable']]) {
      clearMutators();
      mutate(new RegExp('^' + ROUTE.replace(/\//g, '\\/') + '$'), () => ({ status, json: { ok: false, code } }), 'POST');
      const l29 = labs29Hits().length;
      r = await refresh(id);
      t('"' + code + '" is shown as "' + want + '", with no fallback', r.ok === false && r.code === want && labs29Hits().length === l29, r);
    }
    clearMutators();
    r = await refresh(id);
    t('once the answers are right again the lookup works', r.ok === true && r.balance.verification === 'signed', r);

    console.log('--- ' + tag + 'issuing references being off does not matter ---');
    t('(receipts were enabled throughout; the credential-issuance switch was never created)', !fs.existsSync(issuer.issuanceConfigPath || '/nonexistent'));

    console.log('--- ' + tag + 'turning the interface off ---');
    const latest = (await acct()).balance;
    await setExp('labs38', false);
    before = hits.length;
    r = await refresh(id);
    t('with the interface off the wallet cannot look up, and sends nothing', r.ok === false && r.code === 'no-adapter' && hits.length === before, r);
    a = await acct();
    t('the signed statement it already holds is still shown as signed, with its own time', a.balance && a.balance.verification.label === SIGNED_LABEL && a.balance.signed.at === latest.signed.at && a.balance.stale === (Date.now() - Date.parse(a.balance.signed.at) > 30 * 60 * 1000), a.balance);
    await setExp('labs38', true);

    console.log('--- ' + tag + 'background checks are separate, and opt-in ---');
    let bgRun = await W(() => AtlasWallet.runLedgerBackgroundSync({ now: Date.now() + 3600000 }));
    before = hits.length;
    t('with nothing turned on, a background pass checks nothing', bgRun.ran === 0 && hits.length === before, bgRun);
    await W((i) => AtlasWallet.setLedgerBackgroundSync(i, true), id);
    before = receiptPosts().length;
    bgRun = await W(() => AtlasWallet.runLedgerBackgroundSync({ now: Date.now() + 3600000 }));
    a = await acct();
    t('once the person turns it on, the pass uses the signed interface and the result is signed', bgRun.ran === 1 && receiptPosts().length === before + 1 && a.balance.verification.label === SIGNED_LABEL, { bgRun, label: a.balance.verification.label });
    await W((i) => AtlasWallet.setLedgerBackgroundSync(i, false), id);

    if (kind === 'php' && ledger.real) {
      console.log('--- ' + tag + 'Labs 29 stays as it was, and each address is approved on its own (real Core ledger29.php) ---');
      await W((i) => AtlasWallet.revokeLedgerConsent(i), id);
      await setExp('labs38', false);
      await setExp('labs29', true);
      await W((i) => AtlasWallet.grantLedgerConsent(i), id);
      r = await refresh(id);
      a = await acct();
      t('Labs 29 alone: the answer is still labelled "Reported — Not Cryptographically Verified"', r.ok === true && r.balance.verification === 'unsigned' && a.balance.verification.label === UNSIGNED_LABEL && !a.balance.signed && a.balance.text === '4.200000', r);
      t('...and its address is the Labs 29 one', a.pinnedEndpoint === 'https://' + DOMAIN + LABS29_PATH && labs29Hits().length >= 1);
      const posts0 = receiptPosts().length;
      await setExp('labs38', true);
      r = await refresh(id);
      t('turning Labs 38 on does not move an account that is pinned to Labs 29', r.ok === true && r.balance.verification === 'unsigned' && receiptPosts().length === posts0, r);
      await setExp('labs29', false);
      r = await refresh(id);
      a = await acct();
      t('with only Labs 38 on, the receipt address is new to this account: nothing is sent there until it is allowed', r.ok === false && r.code === 'endpoint-changed' && receiptPosts().length === posts0 && a.pendingEndpoint === R.RECEIPT_URL, { r, pending: a.pendingEndpoint });
      t('...and the unsigned balance already held stays labelled unsigned', a.balance.verification.label === UNSIGNED_LABEL);
      await W((i) => AtlasWallet.approveLedgerEndpoint(i), id);
      r = await refresh(id);
      a = await acct();
      t('after the person allows the new address, the report is signed', r.ok === true && r.balance.verification === 'signed' && a.balance.verification.label === SIGNED_LABEL && a.pinnedEndpoint === R.RECEIPT_URL, r);
      await setExp('labs29', true);
      const l29 = labs29Hits().length;
      issuer.enable({ enabled: false });
      r = await refresh(id);
      t('both interfaces on, but pinned to receipts, and the issuer stops signing: a failure, and Labs 29 is NOT tried', r.ok === false && r.code === 'receipts-off' && labs29Hits().length === l29, r);
      a = await acct();
      t('the signed statement it already holds is not downgraded or replaced', a.balance.verification.label === SIGNED_LABEL);
      issuer.enable(BIG);
      await setExp('labs38', false);
      r = await refresh(id);
      t('switching Labs 38 off while Labs 29 is on asks the person again rather than silently going back to Labs 29', r.ok === false && r.code === 'endpoint-changed' && labs29Hits().length === l29, r);
      await setExp('labs29', false);
      await setExp('labs38', true);
      await W((i) => AtlasWallet.approveLedgerEndpoint(i), id).catch(() => {});
    } else {
      console.log('SKIP ' + tag + 'the Labs 29 coexistence checks need the real Labs 29 ledger service (CORE_LABS_DIR) and the PHP issuer');
    }

    console.log('--- ' + tag + 'a passkey identity makes no request ---');
    await W(() => {
      self.__credCalls = 0;
      Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: async () => { self.__credCalls++; throw new Error('no authenticator'); } } });
    });
    before = hits.length;
    const kp = await require('crypto').webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const spki = Buffer.from(await require('crypto').webcrypto.subtle.exportKey('spki', kp.publicKey)).toString('base64url');
    await W(({ spki }) => chrome.storage.local.set({ atlasWebAuthnIdentity: { credentialId: 'AAAAAAAAAAAAAAAAAAAAAA', publicKey: spki, createdAt: new Date().toISOString() }, atlasIdentityMode: 'webauthn' }), { spki });
    r = await refresh(id);
    t('no request is made and no authenticator is asked', r.ok === false && hits.length === before && (await W(() => self.__credCalls)) === 0, r);
    await W(() => chrome.storage.local.set({ atlasIdentityMode: 'local' }));
  } finally {
    await w.close();
    await fr.close();
    issuer.close();
  }
}

(async () => {
  const tls = makeCert();
  const ledger = await R.makeLedger();
  console.log('ledger databases: ' + ledger.label + (ledger.base ? '; Labs 29 balance service: Core\'s ledger29.php' : '; no Labs 29 balance service'));
  try {
    for (const kind of ['php', 'node']) await run(kind, ledger, tls);
  } finally {
    ledger.close();
    fs.rmSync(tls.dir, { recursive: true, force: true });
  }
  process.exit(E.finish('manual-ledger-labs38-wallet'));
})().catch((err) => { console.log('FATAL', err && err.stack || err); process.exit(1); });
