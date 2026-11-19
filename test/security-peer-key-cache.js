// A burst of messages or claims from one peer costs one lookup of its published key, not one per request, so ordinary
// traffic stays under the key-lookup rate limit, and turning the memory off restores a lookup per request.
//
// Run: STACK=node node test/security-peer-key-cache.js   (or STACK=php)
'use strict';
const S = require('./support/issuer-stack');

const STACK = process.env.STACK || 'node';
const BASE_PORT = STACK === 'php' ? 8560 : 8550;
let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name); else { failures++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 220))); }
}
const uuid = () => require('crypto').randomUUID();

// A relay-claim that reaches the key lookup (every intent is genuine) and is then refused because the attestation is not
// signed by the peer's key. That refusal is the same however the key was obtained.
async function relayAttempt(issuer, peer, owner, claimant, credential, signer) {
  const dropId = 'urn:atlas:worlddrop:' + uuid();
  const world = 'world-' + uuid();
  const drop = { action: 'drop', credentialId: credential.id, world, domain: peer.domain, dropId, droppedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
  const claim = { action: 'claim', dropId, domain: peer.domain, claimedAt: new Date().toISOString() };
  const attestation = { relayingDomain: peer.domain, world, dropId, credentialId: credential.id, claimantPublicKey: claimant.publicKey };
  return S.post(issuer.base, '/atlas/world/drops/relay-claim', {
    credential, attestation, attestationSignature: await S.signDetached(signer, attestation),
    dropIntent: { payload: drop, proof: await S.signPayload(owner, drop) },
    claimIntent: { payload: claim, proof: await S.signPayload(claimant, claim) }
  });
}
const keyHits = (peer) => peer.state.hits.filter((u) => u.startsWith('/.well-known/atlas-key.json')).length;

(async () => {
  const peer = await S.startStandInIssuer(BASE_PORT + 2);
  const cached = await S.startIssuer(STACK, BASE_PORT, { ATLAS_OUTBOUND_KEY_RATE: '3', ATLAS_OUTBOUND_KEY_CACHE_MS: '60000' });
  const uncached = await S.startIssuer(STACK, BASE_PORT + 1, { ATLAS_OUTBOUND_KEY_RATE: '3', ATLAS_OUTBOUND_KEY_CACHE_MS: '0' });
  try {
    const owner = await S.generateIdentity();
    const claimant = await S.generateIdentity();
    const stranger = await S.generateIdentity();
    for (const [label, issuer, expectLookups] of [['with the memory on', cached, 1], ['with the memory off', uncached, 3]]) {
      const before = keyHits(peer);
      const issued = await S.post(issuer.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: 'atlas.trophy.chess', quantity: 1 });
      const results = [];
      for (let i = 0; i < 8; i++) results.push(await relayAttempt(issuer, peer, owner, claimant, issued.body, stranger));
      const lookups = keyHits(peer) - before;
      const reached = results.filter((r) => /attestation signature/i.test(JSON.stringify(r.body))).length;
      check(label + ': ' + expectLookups + ' attempt(s) at least reach the signature check, the rest are refused', reached >= expectLookups && results.every((r) => r.status >= 400 && r.status < 500 || r.status === 502), results.map((r) => [r.status, r.body.error]));
      check(label + ': ' + (expectLookups === 1 ? 'one lookup serves all eight' : 'lookups are made until the rate limit stops them (three)'), lookups === expectLookups, lookups);
    }
    check('failures are not remembered: the peer is looked up again after it answers badly', await (async () => {
      peer.state.key = '500';
      const fresh = await S.startIssuer(STACK, BASE_PORT + 3, { ATLAS_OUTBOUND_KEY_CACHE_MS: '60000' });
      try {
        const issued = await S.post(fresh.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: 'atlas.trophy.chess', quantity: 1 });
        const before = keyHits(peer);
        await relayAttempt(fresh, peer, owner, claimant, issued.body, peer.identity);
        await relayAttempt(fresh, peer, owner, claimant, issued.body, peer.identity);
        return keyHits(peer) - before === 2;
      } finally { fresh.stop(); peer.state.key = 'ok'; }
    })());
  } finally {
    cached.stop(); uncached.stop(); peer.stop();
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
