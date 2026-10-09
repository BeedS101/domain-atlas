// Server-side check of POST /atlas/mail/delete, run against either issuer:
//
//   node test/manual-mail-delete.js node
//   node test/manual-mail-delete.js php
//
//   1. The holder's signed request removes the named messages and only those.
//   2. Another holder cannot remove them (their request deletes nothing), nor
//      by presenting the first holder's credential with their own signature.
//   3. A forged credential (not signed by this domain) deletes nothing.
//   4. Repeating a request is harmless; malformed requests are refused.
//
// Starts its own issuer on an isolated state directory. Not part of the
// permanent suite, same reasoning as the other manual-*.js scripts.

const path = require('path');
const H = require('./lib/delivery-harness');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = 8244;
const BASE = 'http://localhost:' + PORT;
const MEMBERSHIP = 'atlas.postoffice.membership';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}

(async () => {
  console.log('Mail delete endpoint (' + KIND + ' issuer)');
  const issuer = KIND === 'node'
    ? await H.startNodeIssuer({ port: PORT, stateDir: H.tmpDir('atlas-mail-delete-'), docrootDir: path.join(H.ROOT, 'demo-domain-a') })
    : await H.startPhpIssuer({ port: PORT, bundleDir: H.preparePhpBundle() });
  try {
    const sender = await H.genIdentity();
    const alice = await H.genIdentity();
    const mallory = await H.genIdentity();
    await H.issueAsset(BASE, sender.publicKey, MEMBERSHIP);
    const aliceCard = await H.issueAsset(BASE, alice.publicKey, MEMBERSHIP);
    const malloryCard = await H.issueAsset(BASE, mallory.publicKey, MEMBERSHIP);

    const send = async (to, subject) => {
      const payload = { to: { publicKey: to.publicKey }, subject, body: 'b' };
      const r = await H.postJson(BASE, '/atlas/postoffice/send', { payload, proof: await H.signWithSelf(sender, payload) });
      if (r.status !== 200) throw new Error('send failed: ' + JSON.stringify(r.body));
      return r.body.id;
    };
    const mailbox = async (who, card) => {
      const r = await H.mailCheck(BASE, who, card);
      return r.body.messages.filter((m) => /^(m\d|x\d)$/.test(m.subject)).map((m) => m.subject).sort();
    };
    const del = async (who, credentials, ids) => {
      const payload = { messageIds: ids };
      return H.postJson(BASE, '/atlas/mail/delete', { credentials, payload, proof: await H.signWithSelf(who, payload) });
    };

    const m1 = await send(alice, 'm1');
    const m2 = await send(alice, 'm2');
    const m3 = await send(alice, 'm3');
    const x1 = await send(mallory, 'x1');
    check('setup: alice has three messages', (await mailbox(alice, aliceCard)).join() === 'm1,m2,m3', (await mailbox(alice, aliceCard)).join());

    let r = await del(alice, [aliceCard], [m1, m2]);
    check('holder deletes two of her messages', r.status === 200 && r.body.deleted === 2, JSON.stringify(r));
    check('only the named messages are gone', (await mailbox(alice, aliceCard)).join() === 'm3', (await mailbox(alice, aliceCard)).join());

    r = await del(mallory, [malloryCard], [m3]);
    check('another holder naming her message deletes nothing', r.status === 200 && r.body.deleted === 0, JSON.stringify(r));
    r = await del(mallory, [aliceCard], [m3]);
    check('presenting her credential with the wrong signer deletes nothing', r.status === 200 && r.body.deleted === 0, JSON.stringify(r));
    const forged = JSON.parse(JSON.stringify(aliceCard));
    forged.owner.publicKey = mallory.publicKey;
    r = await del(mallory, [forged], [m3]);
    check('a credential with a changed owner deletes nothing', r.status === 200 && r.body.deleted === 0, JSON.stringify(r));
    check('her message is untouched by all of that', (await mailbox(alice, aliceCard)).join() === 'm3', (await mailbox(alice, aliceCard)).join());
    check('mallory\'s own mailbox is untouched', (await mailbox(mallory, malloryCard)).join() === 'x1', (await mailbox(mallory, malloryCard)).join());

    r = await del(alice, [aliceCard], [m1, m2]);
    check('repeating a delete is harmless', r.status === 200 && r.body.deleted === 0, JSON.stringify(r));

    const payload = { messageIds: [m3] };
    const badProof = await H.signWithSelf(alice, { messageIds: [m1] });
    r = await H.postJson(BASE, '/atlas/mail/delete', { credentials: [aliceCard], payload, proof: badProof });
    check('a signature over different ids is refused', r.status === 400, JSON.stringify(r));
    r = await H.postJson(BASE, '/atlas/mail/delete', { credentials: [aliceCard], payload: { messageIds: [] }, proof: await H.signWithSelf(alice, { messageIds: [] }) });
    check('an empty id list is refused', r.status === 400, JSON.stringify(r));
    r = await H.postJson(BASE, '/atlas/mail/delete', {});
    check('an empty request is refused', r.status === 400, JSON.stringify(r));
    check('alice\'s last message survived the refused requests', (await mailbox(alice, aliceCard)).join() === 'm3', (await mailbox(alice, aliceCard)).join());

    r = await del(alice, [aliceCard], [m3]);
    check('the last message can be deleted', r.status === 200 && r.body.deleted === 1 && (await mailbox(alice, aliceCard)).length === 0, JSON.stringify(r));
    void x1;
  } finally {
    await H.stopIssuer(issuer);
  }
  if (failures) { console.error('\nFAILURE: ' + failures + ' check(s) failed'); process.exit(1); }
  console.log('\nMAIL DELETE CHECKS PASSED (' + KIND + ')');
})().catch((err) => { console.error('FAILURE:', err); process.exit(1); });
