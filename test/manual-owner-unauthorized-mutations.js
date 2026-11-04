// Checks that nobody but a credential's owner can split, consolidate, convert or
// otherwise change it, against either issuer:
//
//   node test/manual-owner-unauthorized-mutations.js node
//   node test/manual-owner-unauthorized-mutations.js php
//
// A credential is not a secret, so every refusal here is for Mallory, who holds
// only a copy of Alice's credentials and none of Alice's keys.
//
//   1. Split, consolidate and convert refuse a request with no intent
//      (403 owner-authorization-required), with or without a request id.
//   2. They refuse an intent Mallory signed herself over the right payload
//      (403 not-owner), and an intent whose signature is not the signer's own
//      (403 owner-signature-invalid).
//   3. They refuse an intent of Alice's that does not match the request
//      (403 owner-authorization-required): a changed recipient, amount, target
//      class, credential or request id, or a credential added to a consolidation.
//   4. A stored answer for a request id is not returned to anyone but the owner.
//   5. Every other route that spends, moves or replaces a credential refuses
//      Mallory's request, with no intent and with an intent Mallory signed herself.
//   6. Nothing Mallory sent changed any of Alice's credentials.
//   7. GET /atlas/capabilities lists split, consolidate and convert.
//   8. Alice's own signed split, consolidate, convert and transfer work, and a
//      repeated signed request returns the same answer.
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
const rid = (tag) => 'req-' + Date.now() + '-' + tag + '-' + Math.random().toString(36).slice(2, 10);
const refusedWith = (r, code) => r.status === 403 && r.body && r.body.code === code;

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

// What the owner signs for each of the three operations; `domain` is the issuer named on the credential.
const payloads = {
  split: (c, sendAmount, toPublicKey, requestId) => ({ action: 'split', credentialId: c.id, sendAmount, toPublicKey, requestId: requestId || null, domain: c.issuer.domain }),
  consolidate: (cs, requestId) => ({ action: 'consolidate', credentialIds: cs.map((c) => c.id), requestId: requestId || null, domain: cs[0].issuer.domain }),
  convert: (c, spendAmount, toClass, requestId) => ({ action: 'convert', credentialId: c.id, spendAmount, toClass, requestId: requestId || null, domain: c.issuer.domain })
};
async function intentBy(signer, payload) {
  return { payload, proof: await H.signWithSelf(signer, payload) };
}

(async () => {
  console.log('SETUP: isolated ' + KIND + ' issuer on port ' + PORT);
  const issuer = await startIssuer();
  try {
    const alice = await H.genIdentity();
    const mallory = await H.genIdentity();
    const bob = await H.genIdentity();
    const iron1 = await H.issueAsset(BASE, alice.publicKey, IRON, 10);
    const iron2 = await H.issueAsset(BASE, alice.publicKey, IRON, 5);
    const iron3 = await H.issueAsset(BASE, alice.publicKey, IRON, 100);
    const ring = await H.issueAsset(BASE, alice.publicKey, RING);
    const watched = [iron1.id, iron2.id, iron3.id, ring.id];
    const unchanged = async () => watched.every((id) => !(revoked.has(id)));
    let revoked = await revokedIds();
    const countBefore = revoked.size;
    const ok = async (name) => {
      revoked = await revokedIds();
      check(name, revoked.size === countBefore && await unchanged(), JSON.stringify([...revoked].filter((id) => watched.includes(id))));
    };

    // The three requests Mallory can build from copies; `intent` is added per step.
    const requests = {
      split: { route: '/atlas/asset/split', body: (rq) => ({ credential: iron1, sendAmount: 9, toPublicKey: mallory.publicKey, ...rq }), payload: (rq) => payloads.split(iron1, 9, mallory.publicKey, rq && rq.requestId) },
      consolidate: { route: '/atlas/asset/consolidate', body: (rq) => ({ credentials: [iron1, iron2], ...rq }), payload: (rq) => payloads.consolidate([iron1, iron2], rq && rq.requestId) },
      convert: { route: '/atlas/convert', body: (rq) => ({ credential: iron3, spendAmount: 100, toClass: GOLD, ...rq }), payload: (rq) => payloads.convert(iron3, 100, GOLD, rq && rq.requestId) }
    };
    const variants = [['', undefined], [' (with a request id)', 'with-id']];

    console.log('STEP 1: no intent');
    for (const [op, spec] of Object.entries(requests)) {
      for (const [label, tag] of variants) {
        const rq = tag ? { requestId: rid(op) } : undefined;
        const r = await H.postJson(BASE, spec.route, spec.body(rq));
        check(op + label + ' with no intent: 403 owner-authorization-required', refusedWith(r, 'owner-authorization-required'), show(r));
      }
    }
    for (const spec of Object.values(requests)) {
      const r = await H.postJson(BASE, spec.route, {});
      check(spec.route + ' with an empty body: refused, nothing spent', r.status >= 400 && r.status < 500, show(r));
    }
    await ok('nothing changed after the unsigned requests');

    console.log('STEP 2: an intent Mallory signed herself, and a signature that is not the signer\'s');
    for (const [op, spec] of Object.entries(requests)) {
      for (const [label, tag] of variants) {
        const rq = tag ? { requestId: rid(op) } : undefined;
        const r = await H.postJson(BASE, spec.route, { ...spec.body(rq), intent: await intentBy(mallory, spec.payload(rq)) });
        check(op + label + ' signed by Mallory over the right payload: 403 not-owner', refusedWith(r, 'not-owner'), show(r));
      }
      const payload = spec.payload();
      const aliceSays = await intentBy(alice, payload);
      const mallorySig = await H.signWithSelf(mallory, payload);
      const forged = { payload, proof: { ...aliceSays.proof, signature: mallorySig.signature } };
      const r = await H.postJson(BASE, spec.route, { ...spec.body(), intent: forged });
      check(op + ' claiming Alice\'s key with Mallory\'s signature: 403 owner-signature-invalid', refusedWith(r, 'owner-signature-invalid'), show(r));
    }
    await ok('nothing changed after the Mallory-signed requests');

    console.log('STEP 3: an intent of Alice\'s that does not match the request');
    const aliceSplit = await intentBy(alice, payloads.split(iron1, 9, alice.publicKey));
    const aliceConsolidate = await intentBy(alice, payloads.consolidate([iron1, iron2]));
    const aliceConvert = await intentBy(alice, payloads.convert(iron3, 100, GOLD));
    const mismatches = [
      ['split sent to Mallory instead of the signed recipient', '/atlas/asset/split', { credential: iron1, sendAmount: 9, toPublicKey: mallory.publicKey, intent: aliceSplit }],
      ['split of a larger amount than signed', '/atlas/asset/split', { credential: iron1, sendAmount: 10, toPublicKey: alice.publicKey, intent: aliceSplit }],
      ['split of another credential', '/atlas/asset/split', { credential: iron2, sendAmount: 9, toPublicKey: alice.publicKey, intent: aliceSplit }],
      ['split with a request id that was not signed', '/atlas/asset/split', { credential: iron1, sendAmount: 9, toPublicKey: alice.publicKey, requestId: rid('x'), intent: aliceSplit }],
      ['split with an extra field in the signed payload', '/atlas/asset/split', { credential: iron1, sendAmount: 9, toPublicKey: alice.publicKey, intent: await intentBy(alice, { ...payloads.split(iron1, 9, alice.publicKey), extra: true }) }],
      ['consolidate with a third credential added', '/atlas/asset/consolidate', { credentials: [iron1, iron2, iron3], intent: aliceConsolidate }],
      ['consolidate with the credentials in another order', '/atlas/asset/consolidate', { credentials: [iron2, iron1], intent: aliceConsolidate }],
      ['convert into another class', '/atlas/convert', { credential: iron3, spendAmount: 100, toClass: 'atlas.element.silver', intent: aliceConvert }],
      ['convert of a larger amount', '/atlas/convert', { credential: iron3, spendAmount: 101, toClass: GOLD, intent: aliceConvert }],
      ['an intent for one operation on another operation', '/atlas/convert', { credential: iron3, spendAmount: 100, toClass: GOLD, intent: aliceSplit }]
    ];
    for (const [name, route, body] of mismatches) {
      const r = await H.postJson(BASE, route, body);
      check(name + ': 403 owner-authorization-required', refusedWith(r, 'owner-authorization-required'), show(r));
    }
    await ok('nothing changed after the mismatched requests');

    console.log('STEP 4: a stored answer is only returned to the owner');
    const first = rid('own');
    const ownSplit = await H.postSpend(BASE, '/atlas/asset/split', { credential: iron1, sendAmount: 4, toPublicKey: bob.publicKey, requestId: first });
    check('Alice\'s signed split with a request id works', ownSplit.status === 200 && ownSplit.body.sent && ownSplit.body.sent.quantity === 4 && ownSplit.body.sent.owner.publicKey === bob.publicKey
      && ownSplit.body.remainder && ownSplit.body.remainder.quantity === 6 && ownSplit.body.remainder.owner.publicKey === alice.publicKey, show(ownSplit));
    let r = await H.postJson(BASE, '/atlas/asset/split', { credential: iron1, sendAmount: 4, toPublicKey: bob.publicKey, requestId: first });
    check('the same request id with a copy of the credential and no intent: 403, not the stored answer', refusedWith(r, 'owner-authorization-required') && !r.body.sent, show(r));
    r = await H.postJson(BASE, '/atlas/asset/split', { credential: iron1, sendAmount: 4, toPublicKey: bob.publicKey, requestId: first, intent: await intentBy(mallory, payloads.split(iron1, 4, bob.publicKey, first)) });
    check('the same request id signed by Mallory: 403 not-owner, not the stored answer', refusedWith(r, 'not-owner') && !r.body.sent, show(r));
    r = await H.postSpend(BASE, '/atlas/asset/split', { credential: iron1, sendAmount: 4, toPublicKey: bob.publicKey, requestId: first });
    check('Alice repeating her request gets the same answer', r.status === 200 && r.body.sent && r.body.sent.id === ownSplit.body.sent.id, show(r));

    console.log('STEP 5: every other spending route refuses a request not signed by the owner');
    const unsigned = [
      ['/atlas/asset/transfer', { credential: ring, recipientPublicKey: mallory.publicKey }, { action: 'transfer', credentialId: ring.id, recipientPublicKey: mallory.publicKey }],
      ['/atlas/asset/redeem', { credential: ring }, { action: 'redeem', credentialId: ring.id }],
      ['/atlas/asset/transfer-to-file', { credential: ring }, { action: 'transfer-to-file', credentialId: ring.id }],
      ['/atlas/asset/transfer-to-email', { credential: ring, recipientEmail: 'mallory@example.com' }, { action: 'transfer-to-email', credentialId: ring.id, recipientEmail: 'mallory@example.com' }],
      ['/atlas/asset/purchase', { balance: iron3, credential: iron3, purchaseClass: GOLD }, { action: 'purchase', credentialId: iron3.id, balanceId: iron3.id }],
      ['/atlas/asset/fulfill', { credential: ring }, { action: 'fulfill', credentialId: ring.id }],
      ['/atlas/asset/reissue', { credential: ring, properties: { 'atlas.note': 'x' } }, { action: 'reissue', credentialId: ring.id }],
      ['/atlas/trade/submit', { balance: iron3, offer: { class: IRON, quantity: 9 }, want: { class: GOLD, quantity: 1 } }, { action: 'trade-submit', credentialId: iron3.id }],
      ['/atlas/world/drop', { credential: ring, world: 'lobby', position: [0, 0, 0] }, { action: 'drop', credentialId: ring.id }],
      ['/atlas/revoke', { id: ring.id, reason: 'test' }, { action: 'revoke', id: ring.id }],
      ['/atlas/clawback', { credential: ring, toPublicKey: mallory.publicKey }, { action: 'clawback', credentialId: ring.id }]
    ];
    // A refusal counts only from a route that exists: 404 and 405 would mean
    // the request never reached the code being checked.
    const refused = (res) => res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 405;
    for (const [route, body, intentPayload] of unsigned) {
      let res = await H.postJson(BASE, route, body);
      check(route + ' with no signature: refused', refused(res), show(res));
      const proof = await H.signWithSelf(mallory, intentPayload);
      res = await H.postJson(BASE, route, { ...body, intent: { payload: intentPayload, proof }, payload: intentPayload, proof });
      check(route + ' signed by Mallory: refused', refused(res), show(res));
    }

    console.log('STEP 6: none of Alice\'s credentials was changed by Mallory');
    revoked = await revokedIds();
    check('iron2, iron3 and the ring are not revoked; iron1 only by Alice\'s own split',
      !revoked.has(iron2.id) && !revoked.has(iron3.id) && !revoked.has(ring.id) && revoked.has(iron1.id), JSON.stringify([...revoked].filter((id) => watched.includes(id))));

    console.log('STEP 7: capabilities');
    const caps = await H.getJson(BASE, '/atlas/capabilities');
    const ops = (caps.body && caps.body.requestIds && caps.body.requestIds.operations) || [];
    check('split, consolidate and convert are listed', ['split', 'consolidate', 'convert'].every((o) => ops.includes(o)), JSON.stringify(ops));
    check('issue and purchase are still listed', ops.includes('issue') && ops.includes('purchase'), JSON.stringify(ops));

    console.log('STEP 8: the owner\'s own signed requests');
    const cons = await H.postSpend(BASE, '/atlas/asset/consolidate', { credentials: [ownSplit.body.remainder, iron2], requestId: rid('cons') });
    check('Alice consolidates her 6 and 5 into 11', cons.status === 200 && cons.body.quantity === 11 && cons.body.owner.publicKey === alice.publicKey, show(cons));
    const conv = await H.postSpend(BASE, '/atlas/convert', { credential: iron3, spendAmount: 100, toClass: GOLD });
    check('Alice converts 100 iron into gold, with no request id', conv.status === 200 && conv.body.received && conv.body.received.asset.class === GOLD && conv.body.received.owner.publicKey === alice.publicKey, show(conv));
    const spentCopy = await H.postSpend(BASE, '/atlas/convert', { credential: iron3, spendAmount: 100, toClass: GOLD });
    check('a second signed request on the spent credential is refused', spentCopy.status === 400, show(spentCopy));
    const sent = await H.walletTransfer(BASE, ring, alice, mallory.publicKey);
    check('Alice transfers her ring', sent.status === 200 && sent.body.status === 'transferred' && sent.body.credential.owner.publicKey === mallory.publicKey, show(sent));
  } finally {
    await H.stopIssuer(issuer);
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
