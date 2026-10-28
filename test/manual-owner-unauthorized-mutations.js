// Checks that nobody but a credential's owner can change it, against either
// issuer:
//
//   node test/manual-owner-unauthorized-mutations.js node
//   node test/manual-owner-unauthorized-mutations.js php
//
// A credential is not a secret, so every check here is made by Mallory, who
// holds only a copy of Alice's credentials and none of Alice's keys.
//
//   1. Split, consolidate and convert refuse every request with
//      403 owner-authorization-required, including one carrying a request id,
//      and change nothing.
//   2. Every other route that spends, moves or replaces a credential refuses
//      Mallory's request, with no intent and with an intent Mallory signed
//      herself, and changes nothing.
//   3. GET /atlas/capabilities no longer lists split, consolidate or convert
//      and still lists the other operations.
//   4. Alice's own signed transfer still works.
//
// Starts its own isolated issuer. Not part of the permanent suite, same
// reasoning as the other manual-*.js scripts.

const fs = require('fs');
const path = require('path');
const H = require('./lib/delivery-harness');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = KIND === 'php' ? 9352 : 9351;
const BASE = 'http://localhost:' + PORT;
const IRON = 'atlas.element.iron';
const GOLD = 'atlas.element.gold';
const RING = 'atlas.wearable.ring';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}
const show = (r) => JSON.stringify({ status: r.status, body: r.body }).slice(0, 300);

async function revokedIds() {
  const doc = await (await fetch(BASE + '/.well-known/atlas-revocations.json')).json();
  return new Set((doc.revoked || []).map((r) => r.id));
}

async function startIssuer() {
  if (KIND === 'node') {
    const docroot = H.tmpDir('atlas-owner-mut-docroot-');
    fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
    return H.startNodeIssuer({ port: PORT, stateDir: H.tmpDir('atlas-owner-mut-state-'), docrootDir: docroot });
  }
  return H.startPhpIssuer({ port: PORT, bundleDir: H.preparePhpBundle() });
}

(async () => {
  console.log('SETUP: isolated ' + KIND + ' issuer on port ' + PORT);
  const issuer = await startIssuer();
  try {
    const alice = await H.genIdentity();
    const mallory = await H.genIdentity();
    const iron1 = await H.issueAsset(BASE, alice.publicKey, IRON, 10);
    const iron2 = await H.issueAsset(BASE, alice.publicKey, IRON, 5);
    const ring = await H.issueAsset(BASE, alice.publicKey, RING);
    const watched = [iron1.id, iron2.id, ring.id];

    console.log('STEP 1: split, consolidate and convert are refused');
    const disabled = [
      ['/atlas/asset/split', { credential: iron1, sendAmount: 9, toPublicKey: mallory.publicKey }],
      ['/atlas/asset/split', { credential: iron1, sendAmount: 9, toPublicKey: mallory.publicKey, requestId: 'req-' + Date.now() + '-split-abcdef' }],
      ['/atlas/asset/consolidate', { credentials: [iron1, iron2] }],
      ['/atlas/asset/consolidate', { credentials: [iron1, iron2], requestId: 'req-' + Date.now() + '-cons-abcdef' }],
      ['/atlas/convert', { credential: iron1, spendAmount: 5, toClass: GOLD }],
      ['/atlas/convert', { credential: iron1, spendAmount: 5, toClass: GOLD, requestId: 'req-' + Date.now() + '-conv-abcdef' }],
      ['/atlas/asset/split', {}]
    ];
    for (const [route, body] of disabled) {
      const r = await H.postJson(BASE, route, body);
      check(route + (body.requestId ? ' (with a request id)' : Object.keys(body).length ? '' : ' (empty body)') + ': 403 owner-authorization-required',
        r.status === 403 && r.body && r.body.code === 'owner-authorization-required', show(r));
    }

    console.log('STEP 2: every other spending route refuses a request not signed by the owner');
    const unsigned = [
      ['/atlas/asset/transfer', { credential: ring, recipientPublicKey: mallory.publicKey }, { action: 'transfer', credentialId: ring.id, recipientPublicKey: mallory.publicKey }],
      ['/atlas/asset/redeem', { credential: ring }, { action: 'redeem', credentialId: ring.id }],
      ['/atlas/asset/transfer-to-file', { credential: ring }, { action: 'transfer-to-file', credentialId: ring.id }],
      ['/atlas/asset/transfer-to-email', { credential: ring, recipientEmail: 'mallory@example.com' }, { action: 'transfer-to-email', credentialId: ring.id, recipientEmail: 'mallory@example.com' }],
      ['/atlas/asset/purchase', { balance: iron1, credential: iron1, purchaseClass: GOLD }, { action: 'purchase', credentialId: iron1.id, balanceId: iron1.id }],
      ['/atlas/asset/fulfill', { credential: ring }, { action: 'fulfill', credentialId: ring.id }],
      ['/atlas/asset/reissue', { credential: ring, properties: { 'atlas.note': 'x' } }, { action: 'reissue', credentialId: ring.id }],
      ['/atlas/trade/submit', { balance: iron1, offer: { class: IRON, quantity: 9 }, want: { class: GOLD, quantity: 1 } }, { action: 'trade-submit', credentialId: iron1.id }],
      ['/atlas/world/drop', { credential: ring, world: 'lobby', position: [0, 0, 0] }, { action: 'drop', credentialId: ring.id }],
      ['/atlas/revoke', { id: ring.id, reason: 'test' }, { action: 'revoke', id: ring.id }],
      ['/atlas/clawback', { credential: ring, toPublicKey: mallory.publicKey }, { action: 'clawback', credentialId: ring.id }]
    ];
    // A refusal counts only from a route that exists: 404 and 405 would mean
    // the request never reached the code being checked.
    const refused = (r) => r.status >= 400 && r.status < 500 && r.status !== 404 && r.status !== 405;
    for (const [route, body, intentPayload] of unsigned) {
      let r = await H.postJson(BASE, route, body);
      check(route + ' with no signature: refused', refused(r), show(r));
      const proof = await H.signWithSelf(mallory, intentPayload);
      r = await H.postJson(BASE, route, { ...body, intent: { payload: intentPayload, proof }, payload: intentPayload, proof });
      check(route + ' signed by Mallory: refused', refused(r), show(r));
    }
    const revoked = await revokedIds();
    check('none of Alice\'s credentials was revoked or replaced', watched.every((id) => !revoked.has(id)), JSON.stringify(watched.filter((id) => revoked.has(id))));

    console.log('STEP 3: capabilities');
    const caps = await H.getJson(BASE, '/atlas/capabilities');
    const ops = (caps.body && caps.body.requestIds && caps.body.requestIds.operations) || [];
    check('split, consolidate and convert are not listed', !ops.includes('split') && !ops.includes('consolidate') && !ops.includes('convert'), JSON.stringify(ops));
    check('issue and purchase are still listed', ops.includes('issue') && ops.includes('purchase'), JSON.stringify(ops));

    console.log('STEP 4: the owner\'s own signed transfer still works');
    const r = await H.walletTransfer(BASE, ring, alice, mallory.publicKey);
    check('Alice transfers her ring', r.status === 200 && r.body.status === 'transferred' && r.body.credential.owner.publicKey === mallory.publicKey, show(r));
  } finally {
    await H.stopIssuer(issuer);
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
