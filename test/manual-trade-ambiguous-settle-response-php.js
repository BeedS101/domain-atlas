// PHP counterpart to test/manual-trade-ambiguous-settle-response.js —
// same scenario (a cross-domain trade's relay-settle call genuinely
// reaches and is completed by the foreign domain, but the HTTP response
// carrying that success is lost in transit), proving issuer-php's own
// live port behaves the same way issuer-server/server.js's does. See
// that file's own header for the full writeup of the bug (a mailed
// trade-gift left permanently "revoked by issuer", surviving retries)
// and the fix (SPEC.md §7 v1.35 — record_relay_settle_result() /
// find_relay_settle_result() in issuer-php/lib/store.php,
// atlas/trade/relay-settle.php's own idempotent-replay check,
// atlas_relay_trade_settle()'s own retry in issuer-php/lib/bootstrap.php).
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
const PORT_A = 8161; // foreign domain — issues Alice's iron, real/unpatched
const PORT_B = 8162; // the Trading Station — relays to A, PATCHED here
const DOMAIN_A = 'localhost:' + PORT_A;
const DOMAIN_B = 'localhost:' + PORT_B;
const BASE_A = 'http://' + DOMAIN_A;
const BASE_B = 'http://' + DOMAIN_B;

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
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
  const payload = { offer, want, ...(counterpartyPublicKey !== undefined ? { counterparty: counterpartyPublicKey } : {}), expiresAt: new Date(Date.now() + (expiresMinutes || 10) * 60000).toISOString() };
  const proof = await signPayload(identity, payload);
  return { payload, proof };
}
function post(base, urlPath, body) {
  return fetch(base + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await post(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}
function startPhpServer(bundleDir, port) {
  // PHP_CLI_SERVER_WORKERS=4 — same reasoning as manual-cross-domain-
  // trade-php.js: a cross-domain settle has Domain B's relay-settle call
  // block on reaching Domain A, which in turn blocks fetching Domain B's
  // own published key back to verify the attestation.
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
    cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4' })
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S on port ' + port + ' did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('php -S on port ' + port + ' exited early with code ' + code)));
  });
}
function setTrustedPeers(bundleDir, peers) {
  fs.writeFileSync(path.resolve(bundleDir, 'lib', 'atlas-trusted-trade-peers-store.json'), JSON.stringify({ peers }));
}

// Patches the RELAYING station's own copy of atlas_relay_trade_settle()'s
// $attempt closure so that ONLY THE FIRST EVER call (across this PHP
// process's lifetime, via a static variable) throws AFTER a real,
// successful round trip — every later call (this fix's own internal
// retry) behaves normally. The foreign domain's own bundle is never
// patched at all.
function injectFirstResponseLostThenRecovers(bundleDir) {
  const filePath = path.join(bundleDir, 'lib', 'bootstrap.php');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = "if ($res['status'] !== 200) {\n      throw new Exception(isset($res['body']['error']) ? $res['body']['error'] : ($domain . ' refused the trade settle (HTTP ' . $res['status'] . ')'));\n    }\n    return $res['body'];";
  if (!src.includes(marker)) throw new Error('marker not found in bootstrap.php — shape changed, update this test');
  const replacement = "if ($res['status'] !== 200) {\n      throw new Exception(isset($res['body']['error']) ? $res['body']['error'] : ($domain . ' refused the trade settle (HTTP ' . $res['status'] . ')'));\n    }\n    static $calls = 0;\n    $calls++;\n    if ($calls === 1) throw new Exception('could not reach ' . $domain . \" (INJECTED: simulated dropped connection AFTER the remote already applied the settle, for this test only -- call #1 only)\");\n    return $res['body'];";
  src = src.replace(marker, replacement);
  fs.writeFileSync(filePath, src);
}

// Signed mail check (SPEC.md §11.8): the credential's owner asks for its mailbox.
async function mailCheckAs(base, identity, credential) {
  const payload = { action: 'mail-check', domain: new URL(base).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: b64url(webcrypto.getRandomValues(new Uint8Array(18))) };
  const proof = await signPayload(identity, payload);
  return post(base, '/atlas/mail/check', { credentials: [credential], payload, proof });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ambiguous-settle-php-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });
  injectFirstResponseLostThenRecovers(bundleB); // the RELAYING station, not the foreign domain
  setTrustedPeers(bundleA, [DOMAIN_B]);
  setTrustedPeers(bundleB, [DOMAIN_A]);

  let procA, procB;
  try {
    [procA, procB] = await Promise.all([startPhpServer(bundleA, PORT_A), startPhpServer(bundleB, PORT_B)]);
    console.log('PASS: Domain A (foreign, real/unpatched) and Domain B (station, first relay-settle response simulated lost) both up');

    const alice = await generateIdentity(); // poster, balance issued by foreign Domain A
    const bob = await generateIdentity();   // claimant, balance issued locally by Domain B (the station)
    const aliceMembership = await issueAsset(BASE_B, alice.publicKey, 'atlas.tradingstation.membership');
    const bobMembership = await issueAsset(BASE_B, bob.publicKey, 'atlas.tradingstation.membership');

    const aliceIron = await issueAsset(BASE_A, alice.publicKey, 'atlas.element.iron', 10);
    const posterIntent = await proposeIntent(alice, { class: 'atlas.element.iron', quantity: 10 }, { class: 'atlas.element.gold', quantity: 5 }, undefined);
    const posterSubmit = await post(BASE_B, '/atlas/trade/submit', { membership: aliceMembership, intent: posterIntent, balance: aliceIron });
    if (posterSubmit.status !== 200) throw new Error('listing post failed: ' + JSON.stringify(posterSubmit));
    const pendingId = posterSubmit.body.pendingId;

    const bobGold = await issueAsset(BASE_B, bob.publicKey, 'atlas.element.gold', 10);
    console.log('STEP 1: Alice posted 10 iron (foreign, Domain A) wanting 5 gold; Bob holds', bobGold.quantity, 'gold (local, Domain B)');

    const claimantIntent = await proposeIntent(bob, { class: 'atlas.element.gold', quantity: 5 }, { class: 'atlas.element.iron', quantity: 10 }, alice.publicKey);
    const claim = await post(BASE_B, '/atlas/trade/claim', { pendingId, membership: bobMembership, intent: claimantIntent, balance: bobGold });

    console.log('STEP 2: despite the simulated lost response, the claim now SUCCEEDS — the internal retry recovered it');
    if (claim.status !== 200) throw new Error('Expected the claim to succeed (the retry should have recovered the lost response), got: ' + JSON.stringify(claim));
    if (!claim.body.received || claim.body.received.asset.class !== 'atlas.element.iron' || claim.body.received.quantity !== 10) {
      throw new Error('Expected Bob to receive 10 iron in the claim response, got: ' + JSON.stringify(claim.body.received));
    }
    if (claim.body.received.owner.publicKey !== bob.publicKey) throw new Error('Expected the received iron to be owned by Bob, got: ' + JSON.stringify(claim.body.received.owner));
    console.log('PASS: claim settled normally ->', JSON.stringify({ status: claim.body.status, received: claim.body.received.asset.class + ' x' + claim.body.received.quantity }));

    console.log('STEP 3: Alice\'s mailed payment (the gold) is clean and claimable — NOT revoked by a wrongful refund');
    const aliceMailCheck = await mailCheckAs(BASE_A, alice, aliceIron);
    const aliceMailMessage = aliceMailCheck.body.messages.find((m) => m.credentialId === aliceIron.id);
    if (!aliceMailMessage || !aliceMailMessage.attachedAsset) throw new Error('Expected Alice to have a mail message at Domain A with her gold attached, got: ' + JSON.stringify(aliceMailCheck.body.messages));
    const mailedGold = aliceMailMessage.attachedAsset;
    if (mailedGold.asset.class !== 'atlas.element.gold' || mailedGold.quantity !== 5) throw new Error('Expected the mailed gift to be 5 gold, got: ' + JSON.stringify(mailedGold));
    const mailedGoldCheck = await mailCheckAs(BASE_B, alice, mailedGold);
    const mailedGoldUpdate = mailedGoldCheck.body.updates.find((u) => u.id === mailedGold.id);
    if (mailedGoldUpdate) throw new Error('Expected Alice\'s mailed gold gift to be CLEAN (no revocation), got: ' + JSON.stringify(mailedGoldUpdate));
    console.log('PASS: the gift Alice is owed (' + mailedGold.id + ') is unrevoked and genuinely claimable — the bug this test guards against is gone');

    console.log('STEP 4: Bob was NOT double-granted — his gold was spent exactly once, no refund exists for it');
    const bobGoldCheck = await mailCheckAs(BASE_B, bob, bobGold);
    const bobGoldUpdate = bobGoldCheck.body.updates.find((u) => u.id === bobGold.id);
    if (!bobGoldUpdate || bobGoldUpdate.status !== 'revoked') throw new Error('Expected Bob\'s offered gold to be genuinely spent (revoked), got: ' + JSON.stringify(bobGoldUpdate));
    console.log('PASS: Bob\'s gold was spent exactly once for exactly one iron credential — no double grant');

    console.log('\nALL CHECKS PASSED (PHP) — a response lost after the foreign domain already committed now self-heals via retry + idempotent replay, instead of stranding a legitimate gift and double-granting the claimant.');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    if (procA) procA.kill();
    if (procB) procB.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
