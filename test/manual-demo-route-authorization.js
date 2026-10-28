// Who may use the self-serve /atlas/demo/* routes, against either issuer:
//
//   node test/manual-demo-route-authorization.js node
//   node test/manual-demo-route-authorization.js php
//
// Two separate kinds of authorization (issuer-php/lib/demo-authority.php):
// owner consent, for what a holder may do to their own credential (redeem a
// cafeteria item, revoke their own login badge); and a demo authority, a key a
// demo page generates to play the issuer, retailer or bank, written into the
// credential only by a demo mint route. Mallory holds only copies of Alice's
// credentials and her own key.
//
//   1. Clawback demo: suspend, unsuspend and clawback refuse no signature,
//      Mallory, the owner herself, a signature for another credential or
//      action, an old request and a request for another domain; the demo
//      authority's own requests work.
//   2. Demo routes never overwrite or lift an admin suspension or a trade lock,
//      and never claw back a credential held by one.
//   3. Credentials without a demo authority (minted by /atlas/asset/issue) and
//      real currencies are out of reach of the demo routes.
//   4. Cafeteria and login: only the owner's signature redeems or revokes.
//   5. Warranty: only a serial number can be set at mint, the class is the
//      self-serve one, only the demo authority stamps a sale, once, and only
//      with the three sale properties.
//   6. Demo funds (one item carrying its amount) move by the owner's
//      ordinary signed transfer and can be
//      clawed back by the demo authority (reserve-bank-demo.html Act 7);
//      demo classes buy nothing and convert to nothing.
//
// Starts its own isolated issuer. Not part of the permanent suite, same
// reasoning as the other manual-*.js scripts.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/delivery-harness');
const { withAdminAuth } = require('./lib/admin-auth');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = KIND === 'php' ? 9362 : 9361;
const BASE = 'http://localhost:' + PORT;
const DOMAIN = 'localhost:' + PORT;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}
const show = (r) => JSON.stringify({ status: r.status, body: r.body }).slice(0, 300);
const post = (route, body) => H.postJson(BASE, route, body);
let docroot = null;

async function startIssuer() {
  if (KIND === 'node') {
    docroot = H.tmpDir('atlas-demo-auth-docroot-');
    fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
    const stateDir = H.tmpDir('atlas-demo-auth-state-');
    const issuer = await H.startNodeIssuer({ port: PORT, stateDir, docrootDir: docroot });
    issuer.location = stateDir;
    return issuer;
  }
  const bundleDir = H.preparePhpBundle();
  docroot = bundleDir;
  const issuer = await H.startPhpIssuer({ port: PORT, bundleDir, env: { PHP_CLI_SERVER_WORKERS: '4' } });
  issuer.location = bundleDir;
  return issuer;
}

// A demo request as the pages build it.
async function demoRequest(signer, action, credential, fields, overrides) {
  const payload = Object.assign({ purpose: 'atlas.demo.request/1', action, credentialId: credential.id, domain: DOMAIN,
    issuedAt: new Date().toISOString() }, fields || {}, overrides || {});
  return { payload, proof: await H.signWithSelf(signer, payload) };
}
async function revokedIds() {
  const doc = await (await fetch(BASE + '/.well-known/atlas-revocations.json', { cache: 'no-store' })).json();
  return new Set((doc.revoked || []).map((r) => r.id));
}
async function suspensions() {
  try { return (await (await fetch(BASE + '/.well-known/atlas-suspensions.json', { cache: 'no-store' })).json()).suspended || []; } catch (e) { return []; }
}
const suspensionOf = async (id) => (await suspensions()).find((s) => s.id === id) || null;
const refused = (r) => r.status === 403 && r.body && r.body.code === 'demo-authorization-required';

(async () => {
  console.log('SETUP: isolated ' + KIND + ' issuer on port ' + PORT);
  const issuer = await startIssuer();
  try {
    const alice = await H.genIdentity(), mallory = await H.genIdentity(), authority = await H.genIdentity(), admin = await H.genIdentity();
    H.writeAdminRoster(KIND, issuer.location, [admin]);
    const mint = (cls, quantity, owner, auth) => post('/atlas/demo/clawback/mint', { ownerPublicKey: (owner || alice).publicKey,
      authorityPublicKey: (auth || authority).publicKey, assetClass: cls, ...(quantity ? { amount: quantity } : {}) });

    console.log('STEP 1: clawback demo, who may act');
    {
      let r = await mint('atlas.demo.clawback.token', null, alice, alice);
      check('mint refuses an authority that is the owner', r.status === 400, show(r));
      r = await mint('atlas.currency.beta', 100);
      check('mint refuses a real currency', r.status === 400, show(r));
      r = await mint('atlas.demo.clawback.token');
      check('mint a demo token with a demo authority', r.status === 200 && r.body.asset.properties['atlas.demo.authority'] === authority.publicKey, show(r));
      const token = r.body;
      const other = (await mint('atlas.demo.clawback.token')).body;
      for (const [route, action, fields] of [['/atlas/demo/clawback/suspend', 'demo-suspend', {}],
        ['/atlas/demo/clawback/unsuspend', 'demo-unsuspend', {}],
        ['/atlas/demo/clawback/clawback', 'demo-clawback', { toPublicKey: mallory.publicKey }]]) {
        const base = { credential: token, ...(fields.toPublicKey ? { toPublicKey: fields.toPublicKey } : {}) };
        const attempts = [
          ['no signature', base],
          ['signed by Mallory', { ...base, intent: await demoRequest(mallory, action, token, fields) }],
          ['signed by the owner', { ...base, intent: await demoRequest(alice, action, token, fields) }],
          ['the authority, for another credential', { ...base, intent: await demoRequest(authority, action, other, fields) }],
          ['the authority, for another action', { ...base, intent: await demoRequest(authority, action === 'demo-suspend' ? 'demo-unsuspend' : 'demo-suspend', token, fields) }],
          ['the authority, ten minutes old', { ...base, intent: await demoRequest(authority, action, token, fields, { issuedAt: new Date(Date.now() - 600000).toISOString() }) }],
          ['the authority, for another domain', { ...base, intent: await demoRequest(authority, action, token, fields, { domain: 'example.org' }) }]
        ];
        if (fields.toPublicKey) attempts.push(['the authority, for another recipient', { ...base, intent: await demoRequest(authority, action, token, { toPublicKey: alice.publicKey }) }]);
        for (const [label, body] of attempts) {
          const res = await post(route, body);
          check(route + ' refuses ' + label, refused(res), show(res));
        }
      }
      check('nothing happened to the token', !(await revokedIds()).has(token.id) && !(await suspensionOf(token.id)));
      r = await post('/atlas/demo/clawback/suspend', { credential: token, intent: await demoRequest(authority, 'demo-suspend', token) });
      check('the demo authority suspends', r.status === 200 && (await suspensionOf(token.id)) !== null, show(r));
      r = await post('/atlas/demo/clawback/suspend', { credential: token, intent: await demoRequest(authority, 'demo-suspend', token) });
      check('a second suspend is refused rather than replacing the first', r.status === 409, show(r));
      r = await post('/atlas/demo/clawback/unsuspend', { credential: token, intent: await demoRequest(authority, 'demo-unsuspend', token) });
      check('the demo authority lifts its own suspension', r.status === 200 && r.body.wasSuspended === true && !(await suspensionOf(token.id)), show(r));
      await post('/atlas/demo/clawback/suspend', { credential: token, intent: await demoRequest(authority, 'demo-suspend', token) });
      r = await post('/atlas/demo/clawback/clawback', { credential: token, toPublicKey: mallory.publicKey, intent: await demoRequest(authority, 'demo-clawback', token, { toPublicKey: mallory.publicKey }) });
      check('the demo authority claws back a token it suspended', r.status === 200 && r.body.newCredential.owner.publicKey === mallory.publicKey
        && r.body.newCredential.asset.properties['atlas.demo.authority'] === authority.publicKey, show(r));
      check('the original is revoked and its demo suspension cleared', (await revokedIds()).has(token.id) && !(await suspensionOf(token.id)));
    }

    console.log('STEP 2: admin suspensions and trade locks are never touched');
    {
      const funds = (await mint('atlas.demo.clawback.funds', 500)).body;
      const adminPayload = withAdminAuth({ id: funds.id, reason: 'issuer-request' }, BASE, '/atlas/suspend');
      let r = await post('/atlas/suspend', { payload: adminPayload, proof: await H.signWithSelf(admin, adminPayload) });
      check('setup: the admin suspends the funds', r.status === 200, show(r));
      r = await post('/atlas/demo/clawback/suspend', { credential: funds, intent: await demoRequest(authority, 'demo-suspend', funds) });
      check('a demo suspend does not replace an admin suspension', r.status === 409 && (await suspensionOf(funds.id)).reason === 'issuer-request', show(r));
      r = await post('/atlas/demo/clawback/unsuspend', { credential: funds, intent: await demoRequest(authority, 'demo-unsuspend', funds) });
      check('a demo unsuspend does not lift an admin suspension', r.status === 409 && (await suspensionOf(funds.id)).reason === 'issuer-request', show(r));
      r = await post('/atlas/demo/clawback/clawback', { credential: funds, toPublicKey: mallory.publicKey, intent: await demoRequest(authority, 'demo-clawback', funds, { toPublicKey: mallory.publicKey }) });
      check('a demo clawback refuses a credential under an admin suspension', r.status === 409 && !(await revokedIds()).has(funds.id), show(r));

      // A trade lock, as /atlas/trade/relay-lock writes one.
      const locked = (await mint('atlas.demo.clawback.funds', 300)).body;
      const file = path.join(docroot, '.well-known', 'atlas-suspensions.json');
      const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { suspended: [] };
      doc.suspended.push({ id: locked.id, suspendedAt: new Date().toISOString(), reason: 'trade-lock:test-trade', expiresAt: new Date(Date.now() + 3600000).toISOString(), onExpire: 'lift' });
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
      for (const [route, action, fields] of [['/atlas/demo/clawback/suspend', 'demo-suspend', {}], ['/atlas/demo/clawback/unsuspend', 'demo-unsuspend', {}],
        ['/atlas/demo/clawback/clawback', 'demo-clawback', { toPublicKey: mallory.publicKey }]]) {
        r = await post(route, { credential: locked, ...fields, intent: await demoRequest(authority, action, locked, fields) });
        check(route + ' leaves a trade lock alone', r.status === 409, show(r));
      }
      const lock = await suspensionOf(locked.id);
      check('the trade lock is still in place, unchanged', lock && lock.reason === 'trade-lock:test-trade' && !!lock.expiresAt && !(await revokedIds()).has(locked.id), JSON.stringify(lock));
    }

    console.log('STEP 3: credentials without a demo authority, and real currencies');
    {
      const plain = await H.issueAsset(BASE, alice.publicKey, 'atlas.demo.clawback.token');
      let r = await post('/atlas/demo/clawback/suspend', { credential: plain, intent: await demoRequest(authority, 'demo-suspend', plain) });
      check('a token minted without a demo authority cannot be suspended', refused(r), show(r));
      r = await post('/atlas/demo/clawback/clawback', { credential: plain, toPublicKey: mallory.publicKey, intent: await demoRequest(alice, 'demo-clawback', plain, { toPublicKey: mallory.publicKey }) });
      check('nor clawed back, even by its owner', refused(r), show(r));
      const beta = await H.issueAsset(BASE, alice.publicKey, 'atlas.currency.beta', 100);
      for (const [route, action, fields] of [['/atlas/demo/clawback/suspend', 'demo-suspend', {}], ['/atlas/demo/clawback/unsuspend', 'demo-unsuspend', {}],
        ['/atlas/demo/clawback/clawback', 'demo-clawback', { toPublicKey: mallory.publicKey }]]) {
        r = await post(route, { credential: beta, ...fields, intent: await demoRequest(alice, action, beta, fields) });
        check(route + ' refuses a real currency (Beta Dollars)', r.status === 400, show(r));
      }
      check('nothing was revoked or suspended', !(await revokedIds()).has(plain.id) && !(await revokedIds()).has(beta.id) && !(await suspensionOf(beta.id)));
    }

    console.log('STEP 4: cafeteria and login, owner only');
    for (const [cls, route, action] of [['atlas.demo.cafeteria.sandwich', '/atlas/demo/cafeteria/fulfill', 'demo-fulfill'],
      ['atlas.demo.login.badge', '/atlas/demo/login/revoke', 'demo-login-revoke']]) {
      const item = await H.issueAsset(BASE, alice.publicKey, cls);
      for (const [label, body] of [['no signature', { credential: item }],
        ['signed by Mallory', { credential: item, intent: await demoRequest(mallory, action, item) }],
        ['signed by a demo authority', { credential: item, intent: await demoRequest(authority, action, item) }],
        ['the owner, for another action', { credential: item, intent: await demoRequest(alice, action === 'demo-fulfill' ? 'demo-login-revoke' : 'demo-fulfill', item) }]]) {
        const r = await post(route, body);
        check(route + ' refuses ' + label, refused(r), show(r));
      }
      check(cls + ' is untouched', !(await revokedIds()).has(item.id));
      const intent = await demoRequest(alice, action, item);
      let r = await post(route, { credential: item, intent });
      check(route + ' accepts the owner', r.status === 200 && (await revokedIds()).has(item.id), show(r));
      r = await post(route, { credential: item, intent });
      check(route + ' does not repeat', r.status === 400, show(r));
    }

    console.log('STEP 5: warranty');
    {
      const mintW = (properties, extra) => post('/atlas/demo/warranty/mint', { ownerPublicKey: alice.publicKey, authorityPublicKey: authority.publicKey, properties, ...(extra || {}) });
      let r = await mintW({ 'com.example.serialNumber': 'SN-1', 'com.example.manufacturer': 'Anyone' });
      check('mint refuses any property but the serial', r.status === 400, show(r));
      r = await mintW({ 'com.example.serialNumber': '<script>' });
      check('mint refuses a malformed serial', r.status === 400, show(r));
      r = await mintW({ 'com.example.serialNumber': 'SN-1' }, { authorityPublicKey: alice.publicKey });
      check('mint refuses an authority that is the owner', r.status === 400, show(r));
      r = await mintW({ 'com.example.serialNumber': 'SN-1' });
      check('mint makes a self-serve certificate', r.status === 200 && r.body.asset.class === 'atlas.demo.warranty.selfserve'
        && r.body.asset.properties['com.example.serialNumber'] === 'SN-1', show(r));
      const cert = r.body;
      const sale = { 'com.example.saleDate': '2026-10-28', 'com.example.warrantyMonths': 24, 'com.example.retailer': 'Corner Store' };
      for (const [label, body] of [['no signature', { credential: cert, properties: sale }],
        ['signed by the owner', { credential: cert, properties: sale, intent: await demoRequest(alice, 'demo-stamp-sale', cert, { properties: sale }) }],
        ['signed by Mallory', { credential: cert, properties: sale, intent: await demoRequest(mallory, 'demo-stamp-sale', cert, { properties: sale }) }],
        ['the authority, for other properties', { credential: cert, properties: sale, intent: await demoRequest(authority, 'demo-stamp-sale', cert, { properties: { ...sale, 'com.example.warrantyMonths': 120 } }) }]]) {
        const res = await post('/atlas/demo/warranty/stamp-sale', body);
        check('stamp-sale refuses ' + label, refused(res), show(res));
      }
      r = await post('/atlas/demo/warranty/stamp-sale', { credential: cert, properties: { ...sale, 'com.example.serialNumber': 'SN-2' },
        intent: await demoRequest(authority, 'demo-stamp-sale', cert, { properties: { ...sale, 'com.example.serialNumber': 'SN-2' } }) });
      check('stamp-sale refuses changing the serial', r.status === 400, show(r));
      r = await post('/atlas/demo/warranty/stamp-sale', { credential: cert, properties: sale, intent: await demoRequest(authority, 'demo-stamp-sale', cert, { properties: sale }) });
      check('the demo authority stamps the sale', r.status === 200 && r.body.newCredential.asset.properties['com.example.retailer'] === 'Corner Store'
        && r.body.newCredential.asset.properties['com.example.serialNumber'] === 'SN-1' && r.body.newCredential.owner.publicKey === alice.publicKey, show(r));
      const stamped = r.body.newCredential;
      const lapsed = { ...sale, 'com.example.saleDate': '2024-01-01', 'com.example.warrantyMonths': 12 };
      r = await post('/atlas/demo/warranty/stamp-sale', { credential: stamped, properties: lapsed, intent: await demoRequest(alice, 'demo-stamp-sale', stamped, { properties: lapsed }) });
      check('the owner cannot restamp the sale', refused(r), show(r));
      r = await post('/atlas/demo/warranty/stamp-sale', { credential: stamped, properties: lapsed, intent: await demoRequest(authority, 'demo-stamp-sale', stamped, { properties: lapsed }) });
      check('the demo authority may restamp the sale', r.status === 200 && r.body.newCredential.asset.properties['com.example.saleDate'] === '2024-01-01', show(r));
      const factory = await H.issueAsset(BASE, alice.publicKey, 'atlas.demo.warranty.certificate');
      r = await post('/atlas/demo/warranty/stamp-sale', { credential: factory, properties: sale, intent: await demoRequest(authority, 'demo-stamp-sale', factory, { properties: sale }) });
      check('the factory class is never stamped here', r.status === 400, show(r));
    }

    console.log('STEP 6: demo funds (reserve-bank Act 7)');
    {
      const bank = alice, fraudster = mallory;
      const funds = (await mint('atlas.demo.clawback.funds', 15000, bank)).body;
      const t = await H.walletTransfer(BASE, funds, bank, fraudster.publicKey);
      check('the owner moves demo funds by an ordinary signed transfer', t.status === 200 && t.body.credential.owner.publicKey === fraudster.publicKey
        && t.body.credential.asset.properties['atlas.demo.authority'] === authority.publicKey, show(t));
      const stolen = t.body.credential;
      let r = await post('/atlas/demo/clawback/clawback', { credential: stolen, toPublicKey: bank.publicKey, intent: await demoRequest(fraudster, 'demo-clawback', stolen, { toPublicKey: bank.publicKey }) });
      check('the new holder cannot use the demo routes on it', refused(r), show(r));
      await post('/atlas/demo/clawback/suspend', { credential: stolen, intent: await demoRequest(authority, 'demo-suspend', stolen) });
      r = await post('/atlas/demo/clawback/clawback', { credential: stolen, toPublicKey: bank.publicKey, intent: await demoRequest(authority, 'demo-clawback', stolen, { toPublicKey: bank.publicKey }) });
      check('the bank\'s demo authority claws it back', r.status === 200 && r.body.newCredential.owner.publicKey === bank.publicKey
        && r.body.newCredential.asset.properties['com.example.amount'] === 15000, show(r));
      const back = r.body.newCredential;
      r = await post('/atlas/asset/purchase', { balance: back, credential: back, purchaseClass: 'atlas.currency.alpha' });
      check('demo funds do not buy a currency', r.status >= 400, show(r));
      r = await post('/atlas/asset/purchase', { balance: back, credential: back, purchaseClass: 'atlas.element.gold' });
      check('demo funds do not buy gold', r.status >= 400, show(r));
      r = await post('/atlas/convert', { credential: back, spendAmount: 100, toClass: 'atlas.element.gold' });
      check('demo funds do not convert', r.status === 403, show(r));
      check('the recovered funds are intact', !(await revokedIds()).has(back.id));
    }
  } catch (err) {
    failures++;
    console.log('FAIL: unexpected error => ' + (err && err.stack || err));
  } finally {
    await H.stopIssuer(issuer);
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
