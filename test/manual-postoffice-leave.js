// Server-side check of POST /atlas/postoffice/leave, run against either issuer:
//
//   node test/manual-postoffice-leave.js node
//   node test/manual-postoffice-leave.js php
//
//   1. Leaving empties the mailbox, releases the handle (resolve fails, and
//      someone else can claim it) and stops mail in both directions.
//   2. Only the owner can leave: another member's request is refused and
//      changes nothing.
//   3. Repeating the request is harmless; malformed requests are refused.
//   4. A member with two cards who leaves the older one keeps mail
//      addressed to the newer.
//
// Starts its own issuer on an isolated state directory. Not part of the
// permanent suite, same reasoning as the other manual-*.js scripts.

const path = require('path');
const H = require('./lib/delivery-harness');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = 8245;
const BASE = 'http://localhost:' + PORT;
const MEMBERSHIP = 'atlas.postoffice.membership';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}

(async () => {
  console.log('Post Office leave endpoint (' + KIND + ' issuer)');
  const issuer = KIND === 'node'
    ? await H.startNodeIssuer({ port: PORT, stateDir: H.tmpDir('atlas-po-leave-'), docrootDir: path.join(H.ROOT, 'demo-domain-a') })
    : await H.startPhpIssuer({ port: PORT, bundleDir: H.preparePhpBundle() });
  try {
    const alice = await H.genIdentity();
    const bob = await H.genIdentity();
    const carol = await H.genIdentity();
    const aliceCard = await H.issueAsset(BASE, alice.publicKey, MEMBERSHIP);
    const bobCard = await H.issueAsset(BASE, bob.publicKey, MEMBERSHIP);
    await H.issueAsset(BASE, carol.publicKey, MEMBERSHIP);

    const signed = async (who, route, payload) => H.postJson(BASE, route, { payload, proof: await H.signWithSelf(who, payload) });
    const send = (from, to, subject) => signed(from, '/atlas/postoffice/send', { to: { publicKey: to.publicKey }, subject, body: 'b' });
    const mailbox = async (who, card) => ((await H.mailCheck(BASE, who, card)).body.messages || []).filter((m) => /^m\d$/.test(m.subject)).length;
    const resolve = (handle) => H.postJson(BASE, '/atlas/postoffice/resolve', { handle });

    let r = await signed(alice, '/atlas/postoffice/handle', { handle: 'Alice' + KIND });
    check('setup: alice claims a handle', r.status === 200, JSON.stringify(r));
    await send(bob, alice, 'm1');
    await send(bob, alice, 'm2');
    check('setup: alice has two messages', (await mailbox(alice, aliceCard)) === 2, String(await mailbox(alice, aliceCard)));
    check('setup: her handle resolves', (await resolve('Alice' + KIND)).status === 200, 'does not resolve');

    r = await signed(bob, '/atlas/postoffice/leave', { credentialId: aliceCard.id });
    check('another member cannot end her membership', r.status === 400, JSON.stringify(r));
    check('...and nothing changed', (await mailbox(alice, aliceCard)) === 2 && (await resolve('Alice' + KIND)).status === 200, 'state changed');

    r = await signed(alice, '/atlas/postoffice/leave', { credentialId: aliceCard.id });
    check('the owner leaves', r.status === 200 && r.body.deleted >= 2, JSON.stringify(r));
    check('her mailbox is empty', (await mailbox(alice, aliceCard)) === 0, String(await mailbox(alice, aliceCard)));
    check('her handle no longer resolves', (await resolve('Alice' + KIND)).status !== 200, 'still resolves');
    r = await signed(carol, '/atlas/postoffice/handle', { handle: 'Alice' + KIND });
    check('someone else can now claim the released handle', r.status === 200, JSON.stringify(r));
    r = await send(bob, alice, 'm3');
    check('mail to her is refused', r.status >= 400, JSON.stringify(r));
    r = await send(alice, bob, 'm4');
    check('mail from her is refused', r.status >= 400, JSON.stringify(r));
    check('bob\'s mailbox was untouched', (await mailbox(bob, bobCard)) === 0 && r.status >= 400, 'unexpected');

    r = await signed(alice, '/atlas/postoffice/leave', { credentialId: aliceCard.id });
    check('repeating it is harmless', r.status === 200, JSON.stringify(r));
    r = await H.postJson(BASE, '/atlas/postoffice/leave', {});
    check('an empty request is refused', r.status === 400, JSON.stringify(r));
    r = await signed(alice, '/atlas/postoffice/leave', { credentialId: 'urn:nonexistent' });
    check('an unknown membership is refused', r.status === 400, JSON.stringify(r));

    const second = await H.issueAsset(BASE, bob.publicKey, MEMBERSHIP);
    await send(carol, bob, 'm5');
    r = await signed(bob, '/atlas/postoffice/leave', { credentialId: bobCard.id });
    check('a member with two cards leaves the older one', r.status === 200, JSON.stringify(r));
    const m = ((await H.mailCheck(BASE, bob, second)).body.messages || []).filter((x) => x.subject === 'm5').length;
    check('mail for the newer card survives', m === 1, String(m));
    r = await send(carol, bob, 'm6');
    check('and mail to her still goes through', r.status === 200, JSON.stringify(r));
  } finally {
    await H.stopIssuer(issuer);
  }
  if (failures) { console.error('\nFAILURE: ' + failures + ' check(s) failed'); process.exit(1); }
  console.log('\nPOST OFFICE LEAVE CHECKS PASSED (' + KIND + ')');
})().catch((err) => { console.error('FAILURE:', err); process.exit(1); });
