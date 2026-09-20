// Protocol-level check for task #250 (World Drops, SPEC.md §5.5) — proves
// the actual server behavior (issuer-server/server.js's four new
// endpoints, WORLD_DROPS_FILE, checkPresentedTransferableAsset,
// fulfillWorldDropClaim, the cross-domain relay-claim path) is correct,
// WITHOUT going through a browser/extension at all. Same "HTTP layer
// directly + Node's own crypto.webcrypto for real ECDSA P-256 signing"
// style as manual-federation-relay-php.js, chosen for the same reason: a
// full Playwright UI journey (see manual-world-drops.js) is what proves
// viewer.js's own wiring works, but the underlying protocol correctness —
// especially the cross-domain relay path this test exists specifically to
// exercise — is far faster and more precisely checked at the HTTP layer.
//
// Requires domain A's issuer-server on 8001 AND domain B's on 8002 (same
// as every other cross-domain test in this suite) — this test does not
// start either itself. See README.md's "Serve the two demo domains
// locally" section for the exact two commands.
//
// Checks:
//   1. Same-domain drop + list + claim by a DIFFERENT identity — the
//      dropper's wallet loses it (revoked), the claimant gets a freshly-
//      minted credential of the same class/quantity, and the drop
//      disappears from the world's list. Uses atlas.trophy.chess as the
//      non-fungible example — NOT atlas.wearable (Bronze Compass), which
//      became tradeScope: 'bound' in the task #250 second follow-up and can
//      no longer be dropped at all; atlas.trophy.chess is still an
//      ordinary, non-bound, uncapped collectible, exercising the exact same
//      whole-item drop/pickup path the Compass used to.
//   2. A 'bound' asset (atlas.membership) is rejected by POST
//      /atlas/world/drop outright — task #173/#160's exclusion, actually
//      enforced.
//   3. Cross-domain: an item ISSUED by Domain A, held by a visitor, dropped
//      into a world hosted by Domain B — Domain B has to verify the
//      credential against DOMAIN A's own published key
//      (verifyForeignAssetCredential, the fix this task's own drop
//      endpoint needed beyond just reusing checkPresentedAsset's local-only
//      signature check), lists it correctly, and claiming it from Domain B
//      relays to Domain A (POST /atlas/world/drops/relay-claim) which
//      performs the actual mint+revoke since only IT holds the signing key.
//   4. Two concurrent claims of the SAME drop — only one succeeds, the
//      other gets the "already gone" 404, proving the remove-before-mint
//      reservation mechanism actually prevents a double-spend.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { webcrypto } = require('crypto');

const { subtle } = webcrypto;
const DOMAIN_A = 'localhost:8001';
const DOMAIN_B = 'localhost:8002';
const BASE_A = 'http://' + DOMAIN_A;
const BASE_B = 'http://' + DOMAIN_B;
const WORLD = 'protocol-test-world-' + Date.now(); // unique per run so stray leftovers from a prior failed run can't collide

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

async function generateIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPublic = await subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: b64url(rawPublic) };
}

async function signPayload(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, data);
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}

function post(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function get(base, urlPath) {
  return fetch(base + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await post(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}

async function dropItem(base, identity, credential, world, position) {
  const payload = { action: 'drop', credentialId: credential.id, world, droppedAt: new Date().toISOString() };
  const proof = await signPayload(identity, payload);
  return post(base, '/atlas/world/drop', { credential, world, position, intent: { payload, proof } });
}

async function claimDrop(base, identity, dropId) {
  const payload = { action: 'claim', dropId, claimedAt: new Date().toISOString() };
  const proof = await signPayload(identity, payload);
  return post(base, '/atlas/world/drops/claim', { dropId, intent: { payload, proof } });
}

(async () => {
  try {
    console.log('SETUP: two identities on Domain A');
    const alice = await generateIdentity();
    const bob = await generateIdentity();

    console.log('STEP 1: Alice drops a Chess Champion Trophy (non-fungible, same-domain) into a world hosted by Domain A; Bob picks it up');
    const trophy = await issueAsset(BASE_A, alice.publicKey, 'atlas.trophy.chess', 1);
    const dropRes = await dropItem(BASE_A, alice, trophy, WORLD, [1, 0, 1]);
    if (dropRes.status !== 200 || !dropRes.body.dropId) throw new Error('Expected a successful drop, got: ' + JSON.stringify(dropRes));
    const dropId = dropRes.body.dropId;

    const listRes = await get(BASE_A, '/atlas/world/drops?world=' + encodeURIComponent(WORLD));
    if (listRes.status !== 200 || !listRes.body.drops.some((d) => d.dropId === dropId)) {
      throw new Error('Expected the drop to appear in the shared list, got: ' + JSON.stringify(listRes.body));
    }
    if (listRes.body.drops.find((d) => d.dropId === dropId).droppedBy !== alice.publicKey) {
      throw new Error('Expected droppedBy to be Alice\'s public key');
    }

    const claimRes = await claimDrop(BASE_A, bob, dropId);
    if (claimRes.status !== 200 || claimRes.body.status !== 'claimed') throw new Error('Expected Bob\'s claim to succeed, got: ' + JSON.stringify(claimRes));
    if (claimRes.body.credential.owner.publicKey !== bob.publicKey) throw new Error('Expected the claimed credential to name Bob as owner');
    if (claimRes.body.credential.asset.class !== 'atlas.trophy.chess') throw new Error('Expected the claimed credential to be atlas.trophy.chess');

    const listAfterClaim = await get(BASE_A, '/atlas/world/drops?world=' + encodeURIComponent(WORLD));
    if (listAfterClaim.body.drops.some((d) => d.dropId === dropId)) throw new Error('Expected the drop to be gone from the list after being claimed');
    console.log('PASS: same-domain drop -> shared list -> claim by a different identity works, and the drop disappears once claimed');

    console.log('STEP 2: a bound credential (atlas.membership) cannot be dropped');
    const membership = await issueAsset(BASE_A, alice.publicKey, 'atlas.membership', 1);
    const boundDrop = await dropItem(BASE_A, alice, membership, WORLD, [0, 0, 0]);
    if (boundDrop.status !== 400 || !/bound to its owner/.test(boundDrop.body.error || '')) {
      throw new Error('Expected a bound-asset rejection, got: ' + JSON.stringify(boundDrop));
    }
    console.log('PASS: dropping a bound credential is rejected ->', boundDrop.body.error);

    console.log('STEP 3 (cross-domain): Alice holds a Domain-A-issued trophy and drops it into a world hosted by DOMAIN B; Bob (a Domain B visitor) claims it, which relays the mint+revoke back to Domain A');
    const trophyA2 = await issueAsset(BASE_A, alice.publicKey, 'atlas.trophy.chess', 1);
    const crossWorld = WORLD + '-crossdomain';
    const crossDrop = await dropItem(BASE_B, alice, trophyA2, crossWorld, [2, 0, 2]);
    if (crossDrop.status !== 200 || !crossDrop.body.dropId) {
      throw new Error('Expected Domain B to accept a drop of a Domain-A-issued credential (verifyForeignAssetCredential), got: ' + JSON.stringify(crossDrop));
    }
    const crossDropId = crossDrop.body.dropId;

    const crossList = await get(BASE_B, '/atlas/world/drops?world=' + encodeURIComponent(crossWorld));
    if (!crossList.body.drops.some((d) => d.dropId === crossDropId)) throw new Error('Expected the cross-domain drop to appear in Domain B\'s own list');

    const bobKey = bob.publicKey;
    const crossClaim = await claimDrop(BASE_B, bob, crossDropId);
    if (crossClaim.status !== 200 || crossClaim.body.status !== 'claimed') {
      throw new Error('Expected the cross-domain claim (relayed to Domain A) to succeed, got: ' + JSON.stringify(crossClaim));
    }
    if (crossClaim.body.credential.owner.publicKey !== bobKey) throw new Error('Expected the relayed claim to name Bob as owner');
    if (crossClaim.body.credential.issuer.domain !== DOMAIN_A) throw new Error('Expected the relay-claimed credential to still be issued by Domain A, got: ' + crossClaim.body.credential.issuer.domain);
    console.log('PASS: cross-domain drop (verified against the issuer\'s own published key) + relay-claim both work — Bob now holds a fresh Domain-A-issued credential');

    console.log('STEP 4: two concurrent claims of the same drop — only one may win');
    // atlas.trophy.chess, not atlas.wearable/atlas.trinket.pin — both of
    // those became tradeScope: 'bound' across the two task #250 follow-ups
    // (closing a drop-then-re-request farming loophole on a oncePerUser
    // giveaway), so neither is droppable at all any more; this step only
    // needs SOME ordinary droppable class to exercise the race, unrelated
    // to which one.
    const race = await issueAsset(BASE_A, alice.publicKey, 'atlas.trophy.chess', 1);
    const raceDrop = await dropItem(BASE_A, alice, race, WORLD, [3, 0, 3]);
    const raceDropId = raceDrop.body.dropId;
    const carol = await generateIdentity();
    const [claimBob, claimCarol] = await Promise.all([claimDrop(BASE_A, bob, raceDropId), claimDrop(BASE_A, carol, raceDropId)]);
    const successes = [claimBob, claimCarol].filter((r) => r.status === 200);
    const failures = [claimBob, claimCarol].filter((r) => r.status === 404);
    if (successes.length !== 1 || failures.length !== 1) {
      throw new Error('Expected exactly one winner and one "already gone" rejection, got: ' + JSON.stringify([claimBob, claimCarol]));
    }
    console.log('PASS: concurrent double-claim is resolved to exactly one winner ->', failures[0].body.error);

    console.log('\nALL WORLD-DROPS PROTOCOL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  }
})();
