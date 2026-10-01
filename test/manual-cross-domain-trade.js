// Node counterpart to test/manual-cross-domain-trade-php.js — same
// SPEC.md §7 v1.29 scenario (trusted-peer allowlist + two-phase lock/
// relay-settle), proving issuer-server/server.js's own port behaves the
// same way issuer-php's does. Same "copy the bundle, patch its own
// trusted-peer constant, spawn an isolated instance" approach
// manual-trade-unique-item.js already uses for a single isolated Node
// instance, just with two (plus a third, untrusted one) since this is a
// cross-domain scenario.
//
// See manual-cross-domain-trade-php.js's own header for the full scenario
// writeup (Domain B hosts the station; Alice's balance is foreign to it,
// issued by Domain A; Bob's is local) — this file mirrors it exactly,
// against issuer-server/server.js instead of issuer-php.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { subtle } = webcrypto;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-server');
const PORT_A = 8121; // isolated ports, distinct from every other manual-*.js test's own ports
const PORT_B = 8122;
const PORT_C = 8123;
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

// Trusted peers are now admin-panel-managed (POST /atlas/admin/
// trusted-trade-peers/add), file-backed under ATLAS_STATE_DIR rather than
// a hand-edited server.js literal — so a throwaway instance's trust list
// is seeded the same way the real server reads it back: write straight to
// its own copy of TRUSTED_TRADE_PEERS_FILE before the server ever starts,
// instead of patching source. Must run after stateDir exists but before
// startNodeServer() reads it.
function setTrustedPeers(stateDir, peers) {
  fs.writeFileSync(path.join(stateDir, 'atlas-trusted-trade-peers-store.json'), JSON.stringify({ peers }));
}

function startNodeServer(bundleDir, port, domain, stateDir, docrootDir) {
  const proc = spawn('node', ['server.js'], {
    cwd: bundleDir,
    env: { ...process.env, PORT: String(port), ATLAS_DOMAIN: domain, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docrootDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server on port ' + port + ' did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('issuer-server on port ' + port + ' exited early with code ' + code)));
  });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cross-trade-node-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  const bundleC = path.join(tmpRoot, 'domain-c');
  console.log('SETUP: copying issuer-server into three independent throwaway bundles');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleC, { recursive: true });

  const stateA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cross-trade-node-state-a-'));
  const stateB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cross-trade-node-state-b-'));
  const stateC = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cross-trade-node-state-c-'));
  const docrootA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cross-trade-node-docroot-a-'));
  const docrootB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cross-trade-node-docroot-b-'));
  const docrootC = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cross-trade-node-docroot-c-'));
  setTrustedPeers(stateA, [DOMAIN_B]);
  setTrustedPeers(stateB, [DOMAIN_A]);

  let procA, procB, procC;
  try {
    [procA, procB, procC] = await Promise.all([
      startNodeServer(bundleA, PORT_A, DOMAIN_A, stateA, docrootA),
      startNodeServer(bundleB, PORT_B, DOMAIN_B, stateB, docrootB),
      startNodeServer(bundleC, PORT_C, DOMAIN_C, stateC, docrootC)
    ]);
    console.log('PASS: isolated issuer-server instances up — Domain A on ' + PORT_A + ', Domain B on ' + PORT_B + ', Domain C (untrusted) on ' + PORT_C);

    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceMembership = await issueAsset(BASE_B, alice.publicKey, 'atlas.tradingstation.membership');
    const bobMembership = await issueAsset(BASE_B, bob.publicKey, 'atlas.tradingstation.membership');

    console.log('STEP 1: a balance issued by untrusted Domain C is rejected outright');
    const untrustedBalance = await issueAsset(BASE_C, alice.publicKey, 'atlas.element.iron', 10);
    const untrustedIntent = await proposeIntent(alice, { class: 'atlas.element.iron', quantity: 10 }, { class: 'atlas.element.gold', quantity: 5 }, undefined);
    const untrustedSubmit = await post(BASE_B, '/atlas/trade/submit', { membership: aliceMembership, intent: untrustedIntent, balance: untrustedBalance });
    if (untrustedSubmit.status !== 400 || !/does not accept balances issued by/.test(untrustedSubmit.body.error || '')) {
      throw new Error('Expected Domain B to reject a Domain-C-issued balance, got: ' + JSON.stringify(untrustedSubmit));
    }
    console.log('PASS: untrusted foreign balance rejected ->', untrustedSubmit.body.error);

    console.log('STEP 2+3: Alice posts a Domain-A-issued (foreign) balance at station B; Bob claims it with his own Domain-B balance');
    const aliceIron = await issueAsset(BASE_A, alice.publicKey, 'atlas.element.iron', 10);
    const posterIntent = await proposeIntent(alice, { class: 'atlas.element.iron', quantity: 10 }, { class: 'atlas.element.gold', quantity: 5 }, undefined);
    const posterSubmit = await post(BASE_B, '/atlas/trade/submit', { membership: aliceMembership, intent: posterIntent, balance: aliceIron });
    if (posterSubmit.status !== 200 || posterSubmit.body.status !== 'pending') throw new Error('Expected the foreign-balance listing to post, got: ' + JSON.stringify(posterSubmit));
    const pendingId = posterSubmit.body.pendingId;

    const bobGold = await issueAsset(BASE_B, bob.publicKey, 'atlas.element.gold', 10);
    const claimantIntent = await proposeIntent(bob, { class: 'atlas.element.gold', quantity: 5 }, { class: 'atlas.element.iron', quantity: 10 }, alice.publicKey);
    const claim = await post(BASE_B, '/atlas/trade/claim', { pendingId, membership: bobMembership, intent: claimantIntent, balance: bobGold });
    if (claim.status !== 200 || claim.body.status !== 'settled') throw new Error('Expected the cross-domain claim to settle, got: ' + JSON.stringify(claim));
    if (!claim.body.received || claim.body.received.asset.class !== 'atlas.element.iron' || claim.body.received.quantity !== 10 || claim.body.received.issuer.domain !== DOMAIN_A) {
      throw new Error('Expected Bob to receive 10 iron relayed from Domain A, got: ' + JSON.stringify(claim.body.received));
    }
    if (!claim.body.remainder || claim.body.remainder.asset.class !== 'atlas.element.gold' || claim.body.remainder.quantity !== 5) {
      throw new Error('Expected Bob to keep a 5-gold remainder settled locally, got: ' + JSON.stringify(claim.body.remainder));
    }
    console.log('PASS: claim settled — Bob got 10 iron (relayed, lock+settle) and kept a 5-gold remainder (local)');

    console.log('STEP 4: Alice (absent poster) gets her gold via Domain A\'s own mail/check, relayed in as mailDeliverAttachedAsset');
    const aliceMailCheck = await post(BASE_A, '/atlas/mail/check', { credentialIds: [aliceIron.id] });
    const ironUpdate = aliceMailCheck.body.updates.find((u) => u.id === aliceIron.id);
    if (!ironUpdate || ironUpdate.status !== 'revoked' || ironUpdate.newCredential) {
      throw new Error('Expected a plain revocation with no remainder for Alice\'s fully-spent iron, got: ' + JSON.stringify(ironUpdate));
    }
    const aliceMail = aliceMailCheck.body.messages.find((m) => m.subject.startsWith('Listing claimed at'));
    if (!aliceMail || !aliceMail.attachedAsset || aliceMail.attachedAsset.asset.class !== 'atlas.element.gold' || aliceMail.attachedAsset.quantity !== 5 || aliceMail.attachedAsset.issuer.domain !== DOMAIN_B) {
      throw new Error('Expected a mail on Domain A carrying the Domain-B-issued gold, got: ' + JSON.stringify(aliceMailCheck.body.messages));
    }
    console.log('PASS: Alice\'s mail on Domain A carries the Domain-B-issued gold Domain B relayed in ->', aliceMail.subject);

    console.log('STEP 5: an untrusted relaying domain (C) cannot relay-lock or relay-settle against either A or B directly');
    const bogusCredential = await issueAsset(BASE_A, alice.publicKey, 'atlas.element.iron', 1);
    const bogusLock = await post(BASE_A, '/atlas/trade/relay-lock', {
      credential: bogusCredential,
      attestation: { relayingDomain: DOMAIN_C, tradeId: 'urn:atlas:trade:bogus', credentialId: bogusCredential.id, expiresAt: new Date(Date.now() + 120000).toISOString() },
      attestationSignature: 'not-a-real-signature'
    });
    if (bogusLock.status !== 403 || !/does not accept trade relays from/.test(bogusLock.body.error || '')) {
      throw new Error('Expected Domain A to reject a relay-lock from untrusted Domain C, got: ' + JSON.stringify(bogusLock));
    }
    console.log('PASS: relay-lock from an untrusted relaying domain rejected ->', bogusLock.body.error);

    console.log('\nALL CROSS-DOMAIN TRADE (SPEC.md §7 v1.29, Node) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (procA) procA.kill();
    if (procB) procB.kill();
    if (procC) procC.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
    for (const d of [stateA, stateB, stateC, docrootA, docrootB, docrootC]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) {}
    }
  }
})();
