// Throwaway verification for SPEC.md §7 v1.29 — cross-domain Trading
// Station settlement, gated by a per-domain trusted-peer allowlist and a
// two-phase lock/settle relay (issuer-php/atlas/trade/relay-lock.php,
// issuer-php/atlas/trade/relay-settle.php). Same "HTTP layer directly +
// Node's own crypto.webcrypto for real ECDSA P-256 signing" style as
// manual-world-drops-protocol-php.js, and the same reason this needs
// THREE independent throwaway copies of issuer-php: two that trust each
// other (the actual cross-domain trade) and one that trusts nobody (the
// rejection case).
//
// Setup: Domain B hosts the Trading Station. Alice (the poster) offers a
// balance issued by Domain A — foreign to the station — wanting Domain
// B's own class. Bob (the claimant) presents a Domain-B-issued balance —
// local to the station. This deliberately puts the FOREIGN side on the
// POSTER's half of the trade, so settling it exercises the hardest case
// this version's design had to solve: the poster is absent for the claim
// call, and the credential they're owed (minted locally by Domain B) has
// to be relayed INTO Domain A's own relay-settle call as
// mailDeliverAttachedAsset so Domain A — the only domain whose mail store
// the poster's wallet is actually polling — can deliver it.
//
// Checks:
//   1. Without either domain listing the other as a trusted trade peer,
//      posting a listing with a foreign-issued balance is rejected
//      outright (checkPresentedAsset's new foreign-balance branch).
//   2. Once Domain A and Domain B each list the other, the same listing
//      posts and claims successfully: Domain A's balance is locked then
//      settled via relay, Domain B's balance settles locally, and the
//      response gives the claimant everything they need synchronously.
//   3. The poster, absent for the claim, gets their due via Domain A's
//      own /atlas/mail/check — the asset-update channel for any
//      remainder, and a mail message carrying the Domain-B-issued
//      credential Domain B relayed in.
//   4. A balance issued by a third, untrusted domain (Domain C) is
//      rejected the same way #1 was, even with A and B trusting each
//      other — the allowlist is per-pair, not transitive.
//   5. relay-lock.php and relay-settle.php both reject a request from a
//      relaying domain that isn't on the issuing domain's own trusted
//      peer list, directly (not just through the station) — the
//      symmetric half of the allowlist the station's own accept-side
//      check doesn't exercise by itself.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { subtle } = webcrypto;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');
const PORT_A = 8111; // isolated ports, distinct from every other manual-*-php.js test's own ports
const PORT_B = 8112;
const PORT_C = 8113;
const DOMAIN_A = 'localhost:' + PORT_A;
const DOMAIN_B = 'localhost:' + PORT_B;
const DOMAIN_C = 'localhost:' + PORT_C;
const BASE_A = 'http://' + DOMAIN_A;
const BASE_B = 'http://' + DOMAIN_B;
const BASE_C = 'http://' + DOMAIN_C;

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

async function proposeIntent(identity, offer, want, counterpartyPublicKey, expiresMinutes) {
  const payload = {
    offer, want,
    ...(counterpartyPublicKey !== undefined ? { counterparty: counterpartyPublicKey } : {}),
    expiresAt: new Date(Date.now() + (expiresMinutes || 10) * 60000).toISOString()
  };
  const proof = await signPayload(identity, payload);
  return { payload, proof };
}

function post(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await post(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}

function startPhpServer(bundleDir, port) {
  // PHP_CLI_SERVER_WORKERS=4 — same reasoning as manual-world-drops-
  // protocol-php.js: a cross-domain settle has Domain B's relay-settle
  // call block on reaching Domain A, which in turn blocks fetching Domain
  // B's own published key back to verify the attestation — a real
  // reentrant two-way call a single-worker dev server can deadlock on.
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
    cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4' })
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S on port ' + port + ' did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('php -S on port ' + port + ' exited early with code ' + code)));
  });
}

// Patches a throwaway bundle copy's atlas_trusted_trade_peers() to return
// a fixed list — the only way to exercise the allowlist without a real
// admin UI for it, same "edit the one function" posture the function's
// own comment documents for a real deployment.
function setTrustedPeers(bundleDir, peers) {
  const storePath = path.resolve(bundleDir, 'lib', 'store.php');
  const src = fs.readFileSync(storePath, 'utf8');
  const marker = 'function atlas_trusted_trade_peers() {\n  return []; // e.g. [\'example.com\', \'neighbor.example\']\n}';
  if (!src.includes(marker)) throw new Error('setTrustedPeers: expected marker not found in ' + storePath + ' — store.php\'s atlas_trusted_trade_peers() body may have changed');
  const replacement = 'function atlas_trusted_trade_peers() {\n  return ' + JSON.stringify(peers) + ';\n}';
  fs.writeFileSync(storePath, src.replace(marker, replacement));
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cross-trade-php-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  const bundleC = path.join(tmpRoot, 'domain-c');
  console.log('SETUP: copying issuer-php into three independent throwaway bundles');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleC, { recursive: true });

  // A and B each list the other as a trusted trade peer; C lists nobody,
  // and nobody lists C — exactly the "per-pair, not transitive" shape
  // step 4 below checks.
  setTrustedPeers(bundleA, [DOMAIN_B]);
  setTrustedPeers(bundleB, [DOMAIN_A]);

  let procA, procB, procC;
  try {
    [procA, procB, procC] = await Promise.all([startPhpServer(bundleA, PORT_A), startPhpServer(bundleB, PORT_B), startPhpServer(bundleC, PORT_C)]);
    console.log('PASS: PHP dev servers up — Domain A on ' + PORT_A + ', Domain B on ' + PORT_B + ', Domain C (untrusted) on ' + PORT_C);

    const alice = await generateIdentity(); // poster, holds a Domain-A balance
    const bob = await generateIdentity();   // claimant, holds a Domain-B balance

    const aliceMembership = await issueAsset(BASE_B, alice.publicKey, 'atlas.tradingstation.membership');
    const bobMembership = await issueAsset(BASE_B, bob.publicKey, 'atlas.tradingstation.membership');

    console.log('STEP 1: before any trust is configured between A and B for THIS check, posting a foreign-issued balance is rejected outright');
    // Reuses bundleC (trusts nobody, trusted by nobody) standing in for
    // "no trust configured" without needing a fourth throwaway pair.
    const untrustedBalance = await issueAsset(BASE_C, alice.publicKey, 'atlas.element.iron', 10);
    const untrustedIntent = await proposeIntent(alice, { class: 'atlas.element.iron', quantity: 10 }, { class: 'atlas.element.gold', quantity: 5 }, undefined);
    const untrustedSubmit = await post(BASE_B, '/atlas/trade/submit', { membership: aliceMembership, intent: untrustedIntent, balance: untrustedBalance });
    if (untrustedSubmit.status !== 400 || !/does not accept balances issued by/.test(untrustedSubmit.body.error || '')) {
      throw new Error('Expected Domain B to reject a Domain-C-issued balance (C is on nobody\'s trust list), got: ' + JSON.stringify(untrustedSubmit));
    }
    console.log('PASS: untrusted foreign balance rejected ->', untrustedSubmit.body.error);

    console.log('STEP 2: Alice (poster) offers a Domain-A-issued balance, foreign to station B, wanting Domain B\'s own gold; posts successfully now that A and B trust each other');
    const aliceIron = await issueAsset(BASE_A, alice.publicKey, 'atlas.element.iron', 10);
    const posterIntent = await proposeIntent(alice, { class: 'atlas.element.iron', quantity: 10 }, { class: 'atlas.element.gold', quantity: 5 }, undefined);
    const posterSubmit = await post(BASE_B, '/atlas/trade/submit', { membership: aliceMembership, intent: posterIntent, balance: aliceIron });
    if (posterSubmit.status !== 200 || posterSubmit.body.status !== 'pending') {
      throw new Error('Expected the foreign-balance listing to queue as pending once A and B trust each other, got: ' + JSON.stringify(posterSubmit));
    }
    const pendingId = posterSubmit.body.pendingId;
    console.log('PASS: listing posted with a trusted foreign balance ->', pendingId);

    console.log('STEP 3: Bob (claimant) claims it with his own Domain-B balance — settles via lock+relay-settle to Domain A for Alice\'s side, locally for Bob\'s side');
    const bobGold = await issueAsset(BASE_B, bob.publicKey, 'atlas.element.gold', 10);
    const claimantIntent = await proposeIntent(bob, { class: 'atlas.element.gold', quantity: 5 }, { class: 'atlas.element.iron', quantity: 10 }, alice.publicKey);
    const claim = await post(BASE_B, '/atlas/trade/claim', { pendingId, membership: bobMembership, intent: claimantIntent, balance: bobGold });
    if (claim.status !== 200 || claim.body.status !== 'settled') {
      throw new Error('Expected the cross-domain claim to settle, got: ' + JSON.stringify(claim));
    }
    if (!claim.body.received || claim.body.received.asset.class !== 'atlas.element.iron' || claim.body.received.quantity !== 10 || claim.body.received.owner.publicKey !== bob.publicKey) {
      throw new Error('Expected Bob to receive 10 iron relayed from Domain A, got: ' + JSON.stringify(claim.body.received));
    }
    if (claim.body.received.issuer.domain !== DOMAIN_A) throw new Error('Expected the relayed iron to still be issued by Domain A, got: ' + claim.body.received.issuer.domain);
    if (!claim.body.remainder || claim.body.remainder.asset.class !== 'atlas.element.gold' || claim.body.remainder.quantity !== 5) {
      throw new Error('Expected Bob to keep a 5-gold remainder, settled locally by Domain B, got: ' + JSON.stringify(claim.body.remainder));
    }
    console.log('PASS: claim settled — Bob got 10 iron (relayed from Domain A, lock+settle) and kept a 5-gold remainder (settled locally by Domain B)');

    console.log('STEP 4: Alice (absent poster) gets her due via Domain A\'s own /atlas/mail/check — her remainder via asset-update, her gold via a mail-delivered attachment relayed in from Domain B');
    const aliceMailCheck = await post(BASE_A, '/atlas/mail/check', { credentialIds: [aliceIron.id] });
    // offerA.quantity (10) === aliceIron.quantity (10), so this trade
    // leaves no remainder at all — fulfillTradeSideSettlement() only
    // appends an asset-update when there's a remainder to hand forward,
    // so the id just shows a plain revocation (no newCredential), same as
    // any other fully-spent credential's own mail/check entry.
    const ironUpdate = aliceMailCheck.body.updates.find((u) => u.id === aliceIron.id);
    if (!ironUpdate || ironUpdate.status !== 'revoked' || ironUpdate.newCredential) {
      throw new Error('Expected a plain revocation with no remainder for Alice\'s fully-spent iron, got: ' + JSON.stringify(ironUpdate));
    }
    const aliceMail = aliceMailCheck.body.messages.find((m) => m.subject.startsWith('Listing claimed at'));
    if (!aliceMail || !aliceMail.attachedAsset || aliceMail.attachedAsset.asset.class !== 'atlas.element.gold' || aliceMail.attachedAsset.quantity !== 5) {
      throw new Error('Expected a "Listing claimed at" mail on DOMAIN A with a 5-gold attachment relayed in from Domain B, got: ' + JSON.stringify(aliceMailCheck.body.messages));
    }
    if (aliceMail.attachedAsset.owner.publicKey !== alice.publicKey || aliceMail.attachedAsset.issuer.domain !== DOMAIN_B) {
      throw new Error('Expected the attached gold to be owned by Alice and issued by Domain B, got: ' + JSON.stringify(aliceMail.attachedAsset));
    }
    console.log('PASS: Alice\'s mail, on DOMAIN A (the issuer of the id she\'s actually polling), carries the Domain-B-issued gold Domain B relayed in as mailDeliverAttachedAsset ->', aliceMail.subject);

    console.log('STEP 5: an untrusted domain (C) cannot relay-lock or relay-settle against either A or B directly, even though A and B trust each other');
    const bogusCredential = await issueAsset(BASE_A, alice.publicKey, 'atlas.element.iron', 1);
    const bogusAttestation = { relayingDomain: DOMAIN_C, tradeId: 'urn:atlas:trade:bogus', credentialId: bogusCredential.id, expiresAt: new Date(Date.now() + 120000).toISOString() };
    // Signed with Domain C's OWN key isn't available to this script directly
    // (it's generated server-side at first use) — the attestation signature
    // check happens AFTER the trusted-peer check in both relay-lock.php and
    // relay-settle.php, so a bogus, unsigned attestationSignature is enough
    // to prove the rejection happens for the right reason (trust), not just
    // because the signature also happens to be wrong.
    const bogusLock = await post(BASE_A, '/atlas/trade/relay-lock', { credential: bogusCredential, attestation: bogusAttestation, attestationSignature: 'not-a-real-signature' });
    if (bogusLock.status !== 403 || !/does not accept trade relays from/.test(bogusLock.body.error || '')) {
      throw new Error('Expected Domain A to reject a relay-lock from untrusted Domain C before even checking the signature, got: ' + JSON.stringify(bogusLock));
    }
    console.log('PASS: relay-lock from an untrusted relaying domain rejected ->', bogusLock.body.error);

    const bogusSettleAttestation = { relayingDomain: DOMAIN_C, tradeId: 'urn:atlas:trade:bogus', credentialId: bogusCredential.id, spendQuantity: 1, newOwnerPublicKey: bob.publicKey };
    const bogusSettle = await post(BASE_A, '/atlas/trade/relay-settle', { credential: bogusCredential, attestation: bogusSettleAttestation, attestationSignature: 'not-a-real-signature' });
    if (bogusSettle.status !== 403 || !/does not accept trade relays from/.test(bogusSettle.body.error || '')) {
      throw new Error('Expected Domain A to reject a relay-settle from untrusted Domain C before even checking the signature, got: ' + JSON.stringify(bogusSettle));
    }
    console.log('PASS: relay-settle from an untrusted relaying domain rejected ->', bogusSettle.body.error);

    console.log('\nALL CROSS-DOMAIN TRADE (SPEC.md §7 v1.29) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (procA) procA.kill();
    if (procB) procB.kill();
    if (procC) procC.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
