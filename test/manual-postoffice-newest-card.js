// A wallet that holds two live Post Office membership cards at one domain
// (a card deleted and joined again) receives its mail under the newest
// card, which is the one the wallet polls with:
//
//   node test/manual-postoffice-newest-card.js node
//   node test/manual-postoffice-newest-card.js php
//
// Starts its own issuer on an isolated state directory. Not part of the
// permanent suite, same reasoning as the other manual-*.js scripts.

const H = require('./lib/delivery-harness');
const path = require('path');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = 8242;
const BASE = 'http://localhost:' + PORT;
const MEMBERSHIP = 'atlas.postoffice.membership';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}

async function mailFor(owner, card) {
  const res = await H.mailCheck(BASE, owner, card);
  // Issuing a card also files a welcome message under it; only the test message counts.
  return (res.body.messages || []).filter((m) => m.subject === 'hello');
}

(async () => {
  console.log('Newest-card mail addressing (' + KIND + ' issuer)');
  let issuer;
  if (KIND === 'node') {
    const stateDir = H.tmpDir('atlas-newest-card-');
    issuer = await H.startNodeIssuer({ port: PORT, stateDir, docrootDir: path.join(H.ROOT, 'demo-domain-a') });
  } else {
    issuer = await H.startPhpIssuer({ port: PORT, bundleDir: H.preparePhpBundle() });
  }
  try {
    const sender = await H.genIdentity();
    const owner = await H.genIdentity();
    await H.issueAsset(BASE, sender.publicKey, MEMBERSHIP);
    const oldCard = await H.issueAsset(BASE, owner.publicKey, MEMBERSHIP);
    const newCard = await H.issueAsset(BASE, owner.publicKey, MEMBERSHIP);

    const payload = { to: { publicKey: owner.publicKey }, subject: 'hello', body: 'to the newest card' };
    const res = await H.postJson(BASE, '/atlas/postoffice/send', { payload, proof: await H.signWithSelf(sender, payload) });
    check('send accepted', res.status === 200, JSON.stringify(res.body));

    const underNew = await mailFor(owner, newCard);
    const underOld = await mailFor(owner, oldCard);
    check('mail is filed under the newest card', underNew.length === 1, 'newest card has ' + underNew.length);
    check('nothing is filed under the older card', underOld.length === 0, 'older card has ' + underOld.length);
  } finally {
    await H.stopIssuer(issuer);
  }
  if (failures) { console.error('\nFAILURE: ' + failures + ' check(s) failed'); process.exit(1); }
  console.log('\nNEWEST-CARD CHECKS PASSED (' + KIND + ')');
})().catch((err) => { console.error('FAILURE:', err); process.exit(1); });
