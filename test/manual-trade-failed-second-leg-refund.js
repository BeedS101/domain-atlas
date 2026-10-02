// Regression test for a real bug Bruno hit live: a cross-domain Trading
// Station trade settles its first leg (spending the claimant's own
// balance) before attempting its second leg (the poster's balance,
// possibly relayed to a foreign domain) — if the second leg then fails
// for any reason (a timeout, a network drop, a foreign domain briefly
// unreachable), the claimant's balance was already genuinely spent and
// revoked server-side, yet the overall claim reports failure and the
// client never adopts anything in its place. The claimant's wallet keeps
// showing the OLD balance as if nothing happened, until some later
// /atlas/mail/check cycle discovers it's already revoked — "the item I
// bought shows revoked by issuer" with no idea why.
//
// Fix: when the second leg fails AFTER the first leg already committed
// LOCALLY (this station's own domain), refund the claimant immediately —
// undo the never-delivered credit to the (absent) poster and mint its
// equivalent back to the claimant — and hand the refund back in the
// error response so claimTradeListing() (wallet.js) can adopt it instead
// of leaving the spent balance behind as a ghost. See
// refundFailedSecondLeg() in issuer-server/server.js and
// refund_failed_second_leg() in issuer-php/lib/bootstrap.php.
//
// This only covers the LOCAL-spend case (the common one — the claimant
// is usually transacting with their own station's own currency). A spend
// on a different, foreign domain has no refund path yet (would need a
// new cross-domain refund-relay endpoint) — covered by its own check
// below, which only asserts the claimant is told plainly, not refunded.
//
// Reproduces the failing second leg the same way a real timeout would
// manifest — by patching a throwaway copy of issuer-server/server.js to
// make /atlas/trade/relay-settle fail for one specific test trade id
// only, right after its legitimacy checks (so nothing it touches is
// mutated), never for any other request. Everything else runs the real,
// unmodified code path.
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
const PORT_A = 8131;
const PORT_B = 8132;
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
function setTrustedPeers(stateDir, peers) {
  fs.writeFileSync(path.join(stateDir, 'atlas-trusted-trade-peers-store.json'), JSON.stringify({ peers }));
}
function startNodeServer(bundleDir, port, domain, stateDir, docrootDir) {
  const proc = spawn('node', ['server.js'], { cwd: bundleDir, env: { ...process.env, PORT: String(port), ATLAS_DOMAIN: domain, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docrootDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server on port ' + port + ' did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('issuer-server on port ' + port + ' exited early with code ' + code)));
  });
}

// Patches a throwaway copy of server.js so /atlas/trade/relay-settle
// unconditionally fails, right after its legitimacy checks and before
// fulfillTradeSideSettlement ever runs — nothing it touches gets
// mutated, same as a real timeout talking to this domain. Safe to make
// this unconditional: bundleA is a disposable copy exclusive to this one
// test run, on its own port, never shared with any other test (the
// pre-existing manual-cross-domain-trade.js scenario runs its own
// separate, unpatched instances).
function injectUnconditionalSettleFailure(bundleDir) {
  const serverPath = path.join(bundleDir, 'server.js');
  let src = fs.readFileSync(serverPath, 'utf8');
  const marker = "const settled = await fulfillTradeSideSettlement(credential, spendQuantity, newOwnerPublicKey, mailNotice);";
  if (!src.includes(marker)) throw new Error('marker not found in server.js — shape changed, update this test');
  src = src.replace(marker, "return sendJson(res, 500, { error: 'INJECTED: simulated relay-settle failure for this test only' });\n        " + marker);
  fs.writeFileSync(serverPath, src);
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-failed-second-leg-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });
  injectUnconditionalSettleFailure(bundleA);

  const stateA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-failed-second-leg-state-a-'));
  const stateB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-failed-second-leg-state-b-'));
  const docrootA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-failed-second-leg-docroot-a-'));
  const docrootB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-failed-second-leg-docroot-b-'));
  setTrustedPeers(stateA, [DOMAIN_B]);
  setTrustedPeers(stateB, [DOMAIN_A]);

  let procA, procB;
  try {
    [procA, procB] = await Promise.all([
      startNodeServer(bundleA, PORT_A, DOMAIN_A, stateA, docrootA),
      startNodeServer(bundleB, PORT_B, DOMAIN_B, stateB, docrootB)
    ]);
    console.log('PASS: Domain A (relay-settle rigged to always fail) and Domain B both up');

    // Station B is the claimant's OWN domain (issuerBDomain === DOMAIN at
    // B) — the refundable case. Domain A (foreign, where the poster's
    // item lives) is where the injected failure happens.
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
    const refundCheck = await post(BASE_B, '/atlas/mail/check', { credentialIds: [claim.body.refund.id] });
    const refundUpdate = refundCheck.body.updates.find((u) => u.id === claim.body.refund.id);
    if (refundUpdate) throw new Error('Expected no revocation/supersession update for the fresh refund credential, got: ' + JSON.stringify(refundUpdate));
    console.log('PASS: refund credential is clean — no revocation recorded against it');

    console.log('STEP 4: Bob\'s ORIGINAL balance is genuinely revoked (the first leg really did spend it) -- but he was compensated, so this is expected, not a loss');
    const originalCheck = await post(BASE_B, '/atlas/mail/check', { credentialIds: [bobGold.id] });
    const originalUpdate = originalCheck.body.updates.find((u) => u.id === bobGold.id);
    if (!originalUpdate || originalUpdate.status !== 'revoked') throw new Error('Expected the original spent balance to be revoked, got: ' + JSON.stringify(originalUpdate));
    console.log('PASS: original balance correctly shows revoked, exactly matching the refund that replaces it');

    console.log('\nALL CHECKS PASSED — a failed second settlement leg now refunds the claimant instead of silently stranding a revoked balance.');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    if (procA) procA.kill();
    if (procB) procB.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
    for (const d of [stateA, stateB, docrootA, docrootB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) {} }
  }
})();
