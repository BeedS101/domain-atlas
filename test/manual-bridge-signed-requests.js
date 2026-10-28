// Checks that a signature made through the wallet bridge (SPEC.md §3.8.1)
// cannot be used as a protocol request, against either issuer:
//
//   node test/manual-bridge-signed-requests.js node
//   node test/manual-bridge-signed-requests.js php
//
// A wallet signs a page's payload as { ctx: 'atlas.bridge.sign/1', origin,
// payload }. Signatures here are made with raw keys in exactly that shape,
// the way the wallet produces them.
//
//   1. A transfer intent signed directly by the owner still works.
//   2. The same transfer intent, bridge-signed, is refused and the
//      credential stays valid. This includes a page payload that also
//      carries a purpose, as a page's request must.
//   3. A bridge-signed admin request (mint) is refused.
//   4. A bridge-signed mail check is refused.
//   5. The moderation grant route accepts a bridge-signed request made on
//      this domain's own origin, and refuses one made on another origin,
//      one with extra fields around the payload, and one with no origin.
//   6. A directly signed grant request is still accepted.
//
// Starts its own isolated issuer. Not part of the permanent suite, same
// reasoning as the other manual-*.js scripts.

const fs = require('fs');
const path = require('path');
const H = require('./lib/delivery-harness');
const { withAdminAuth } = require('./lib/admin-auth');
const M = require('../tools/lib/moderation-grant');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = KIND === 'php' ? 9342 : 9341;
const BASE = 'http://localhost:' + PORT;
const OWN_ORIGIN = 'http://localhost:' + PORT;
const AUDIENCE = 'https://presence.test.example';
const BRIDGE_CTX = 'atlas.bridge.sign/1';
const RING = 'atlas.wearable.ring';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}
const show = (r) => JSON.stringify({ status: r.status, body: r.body });

function bridgeWrap(payload, origin) {
  return { ctx: BRIDGE_CTX, origin: origin === undefined ? OWN_ORIGIN : origin, payload };
}
async function revoked(id) {
  const doc = await (await fetch(BASE + '/.well-known/atlas-revocations.json')).json();
  return (doc.revoked || []).some((r) => r.id === id);
}

async function startIssuer() {
  if (KIND === 'node') {
    const docroot = H.tmpDir('atlas-bridge-ctx-docroot-');
    fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
    const stateDir = H.tmpDir('atlas-bridge-ctx-state-');
    const issuer = await H.startNodeIssuer({ port: PORT, stateDir, docrootDir: docroot, env: { ATLAS_MODERATION_AUDIENCES: AUDIENCE } });
    issuer.location = stateDir;
    return issuer;
  }
  const bundleDir = H.preparePhpBundle();
  fs.writeFileSync(path.join(bundleDir, 'lib', 'atlas-moderation-config.json'), JSON.stringify({ domain: 'localhost:' + PORT, audiences: [AUDIENCE] }));
  const issuer = await H.startPhpIssuer({ port: PORT, bundleDir, env: { PHP_CLI_SERVER_WORKERS: '4' } });
  issuer.location = bundleDir;
  return issuer;
}

(async () => {
  console.log('SETUP: isolated ' + KIND + ' issuer on port ' + PORT);
  const issuer = await startIssuer();
  try {
    const alice = await H.genIdentity();
    const admin = await H.genIdentity();
    const mallory = await H.genIdentity();
    H.writeAdminRoster(KIND, issuer.location, [admin]);

    console.log('STEP 1: a directly signed transfer intent still works');
    const ring1 = await H.issueAsset(BASE, alice.publicKey, RING);
    let r = await H.walletTransfer(BASE, ring1, alice, mallory.publicKey);
    check('direct transfer accepted', r.status === 200 && r.body.status === 'transferred', show(r));

    console.log('STEP 2: a bridge-signed transfer intent is refused');
    const ring2 = await H.issueAsset(BASE, alice.publicKey, RING);
    for (const [label, inner] of [
      ['bare transfer fields', { action: 'transfer', credentialId: ring2.id, recipientPublicKey: mallory.publicKey }],
      ['transfer fields next to a page purpose', { purpose: 'login', action: 'transfer', credentialId: ring2.id, recipientPublicKey: mallory.publicKey }]
    ]) {
      const signed = bridgeWrap(inner);
      const proof = await H.signWithSelf(alice, signed);
      r = await H.postJson(BASE, '/atlas/asset/transfer', { credential: ring2, recipientPublicKey: mallory.publicKey, intent: { payload: signed, proof } });
      check('wrapped intent (' + label + ') refused', r.status === 400, show(r));
      r = await H.postJson(BASE, '/atlas/asset/transfer', { credential: ring2, recipientPublicKey: mallory.publicKey, intent: { payload: inner, proof } });
      check('its signature does not verify over the inner payload either (' + label + ')', r.status === 400, show(r));
    }
    check('the credential is still valid', !(await revoked(ring2.id)), 'ring2 was revoked');

    console.log('STEP 3: a bridge-signed admin request is refused');
    const mintInner = JSON.parse(JSON.stringify(withAdminAuth({ ownerPublicKey: mallory.publicKey, assetClass: RING }, BASE, '/atlas/asset/mint')));
    const mintSigned = bridgeWrap(mintInner);
    const mintProof = await H.signWithSelf(admin, mintSigned);
    r = await H.postJson(BASE, '/atlas/asset/mint', { payload: mintSigned, proof: mintProof });
    check('wrapped mint refused', r.status >= 400 && r.status < 500, show(r));
    r = await H.postJson(BASE, '/atlas/asset/mint', { payload: mintInner, proof: mintProof });
    check('wrapped mint signature does not verify over the inner payload', r.status === 401, show(r));

    console.log('STEP 4: a bridge-signed mail check is refused');
    const member = await H.issueAsset(BASE, alice.publicKey, RING);
    const mailInner = { action: 'mail-check', domain: 'localhost:' + PORT, nonce: 'n' + Date.now() + 'abcdefghijklmnop', issuedAt: new Date().toISOString(), credentialIds: [member.id] };
    const mailSigned = bridgeWrap(mailInner);
    r = await H.postJson(BASE, '/atlas/mail/check', { payload: mailSigned, proof: await H.signWithSelf(alice, mailSigned) });
    check('wrapped mail check refused', r.status >= 400 && r.status < 500, show(r));

    console.log('STEP 5: the moderation grant route and bridge-signed requests');
    async function grantInner() {
      const pop = await M.generatePopKey();
      return JSON.parse(JSON.stringify(withAdminAuth({ purpose: 'moderation-grant', audience: AUDIENCE, worlds: ['alpha'], operations: ['chat.mute'], popPublicKey: pop.publicKey }, BASE, '/atlas/admin/moderation/grant')));
    }
    const ownSigned = bridgeWrap(await grantInner());
    r = await H.postJson(BASE, '/atlas/admin/moderation/grant', { payload: ownSigned, proof: await H.signWithSelf(admin, ownSigned) });
    check('signed on this domain\'s own origin: grant issued', r.status === 200 && r.body.grant, show(r));
    for (const [label, signed] of [
      ['another origin', bridgeWrap(await grantInner(), 'https://attacker.example')],
      ['the https origin of a different port', bridgeWrap(await grantInner(), 'https://localhost:1')],
      ['an extra field around the payload', Object.assign(bridgeWrap(await grantInner()), { note: 'x' })],
      ['no origin', (() => { const w = { ctx: BRIDGE_CTX, payload: null }; return w; })()]
    ]) {
      if (signed.payload === null) signed.payload = await grantInner();
      r = await H.postJson(BASE, '/atlas/admin/moderation/grant', { payload: signed, proof: await H.signWithSelf(admin, signed) });
      check('refused when signed with ' + label, r.status === 401 && r.body.code === 'wrong-origin', show(r));
    }

    console.log('STEP 6: a directly signed grant request is still accepted');
    const direct = await grantInner();
    r = await H.postJson(BASE, '/atlas/admin/moderation/grant', { payload: direct, proof: await H.signWithSelf(admin, direct) });
    check('direct grant request accepted', r.status === 200 && r.body.grant, show(r));
  } finally {
    await H.stopIssuer(issuer);
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
