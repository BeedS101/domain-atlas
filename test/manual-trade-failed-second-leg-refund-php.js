// PHP counterpart to test/manual-trade-failed-second-leg-refund.js — same
// scenario (a cross-domain trade's second settlement leg fails AFTER the
// first leg already spent the claimant's balance), proving issuer-php's
// own port behaves the same way issuer-server/server.js's does. See that
// file's own header for the full writeup of the bug and the fix
// (refund_failed_second_leg() in issuer-php/lib/bootstrap.php,
// atlas/trade/claim.php's own catch block around the A-side settle).
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
const PORT_A = 8141;
const PORT_B = 8142;
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

// Patches a throwaway copy of relay-settle.php so it unconditionally
// fails right after its legitimacy checks and before
// fulfill_trade_side_settlement() ever runs — nothing it touches gets
// mutated, same as a real timeout talking to this domain. Safe to make
// unconditional: this bundle is disposable, exclusive to this one test
// run, on its own port.
function injectUnconditionalSettleFailure(bundleDir) {
  const filePath = path.join(bundleDir, 'atlas', 'trade', 'relay-settle.php');
  let src = fs.readFileSync(filePath, 'utf8');
  const marker = "$settled = fulfill_trade_side_settlement($kp, $credential, $spendQuantity, $newOwnerPublicKey, $mailNotice);";
  if (!src.includes(marker)) throw new Error('marker not found in relay-settle.php — shape changed, update this test');
  src = src.replace(marker, "send_json(500, ['error' => 'INJECTED: simulated relay-settle failure for this test only']);\n" + marker);
  fs.writeFileSync(filePath, src);
}

// Signed mail check (SPEC.md §11.8): the credential's owner asks for its mailbox.
async function mailCheckAs(base, identity, credential) {
  const payload = { action: 'mail-check', domain: new URL(base).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: b64url(webcrypto.getRandomValues(new Uint8Array(18))) };
  const proof = await signPayload(identity, payload);
  return post(base, '/atlas/mail/check', { credentials: [credential], payload, proof });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-failed-second-leg-php-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });
  injectUnconditionalSettleFailure(bundleA);
  setTrustedPeers(bundleA, [DOMAIN_B]);
  setTrustedPeers(bundleB, [DOMAIN_A]);

  let procA, procB;
  try {
    [procA, procB] = await Promise.all([startPhpServer(bundleA, PORT_A), startPhpServer(bundleB, PORT_B)]);
    console.log('PASS: Domain A (relay-settle.php rigged to always fail) and Domain B both up');

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
    console.log('STEP 1: Bob\'s balance before the claim:', bobGold.id, 'qty', bobGold.quantity);

    const claimantIntent = await proposeIntent(bob, { class: 'atlas.element.gold', quantity: 5 }, { class: 'atlas.element.iron', quantity: 10 }, alice.publicKey);
    const claim = await post(BASE_B, '/atlas/trade/claim', { pendingId, membership: bobMembership, intent: claimantIntent, balance: bobGold });

    console.log('STEP 2: the claim reports failure (the injected second-leg failure), but carries a refund');
    if (claim.status !== 502) throw new Error('Expected the claim to fail with 502 (injected second-leg failure), got: ' + JSON.stringify(claim));
    if (!/automatically refunded/.test(claim.body.error || '')) throw new Error('Expected the error to say the balance was automatically refunded, got: ' + JSON.stringify(claim.body));
    if (!claim.body.refund || claim.body.refund.asset.class !== 'atlas.element.gold' || claim.body.refund.quantity !== 5) {
      throw new Error('Expected a 5-gold refund credential in the failure response, got: ' + JSON.stringify(claim.body.refund));
    }
    if (claim.body.refund.owner.publicKey !== bob.publicKey) throw new Error('Expected the refund to be owned by Bob, got: ' + JSON.stringify(claim.body.refund.owner));
    console.log('PASS: claim failed as expected, carrying a valid 5-gold refund for Bob ->', claim.body.error);

    console.log('STEP 3: the refund credential itself is NOT revoked (Bob can actually hold it)');
    const refundCheck = await mailCheckAs(BASE_B, bob, claim.body.refund);
    const refundUpdate = refundCheck.body.updates.find((u) => u.id === claim.body.refund.id);
    if (refundUpdate) throw new Error('Expected no revocation/supersession update for the fresh refund credential, got: ' + JSON.stringify(refundUpdate));
    console.log('PASS: refund credential is clean — no revocation recorded against it');

    console.log('STEP 4: Bob\'s ORIGINAL balance is genuinely revoked (the first leg really did spend it) -- but he was compensated, so this is expected, not a loss');
    const originalCheck = await mailCheckAs(BASE_B, bob, bobGold);
    const originalUpdate = originalCheck.body.updates.find((u) => u.id === bobGold.id);
    if (!originalUpdate || originalUpdate.status !== 'revoked') throw new Error('Expected the original spent balance to be revoked, got: ' + JSON.stringify(originalUpdate));
    console.log('PASS: original balance correctly shows revoked, exactly matching the refund that replaces it');

    console.log('\nALL CHECKS PASSED — a failed second settlement leg now refunds the claimant instead of silently stranding a revoked balance (PHP).');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    if (procA) procA.kill();
    if (procB) procB.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
