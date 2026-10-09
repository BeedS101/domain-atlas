// Regression test for a real bug Bruno hit live: a mailed trade-gift
// credential stuck forever as "Claim failed: gift credential does not
// check out: revoked by issuer", surviving even a fresh retry days
// later.
//
// Distinct from (and worse than) the already-fixed "failed second leg"
// bug test/manual-trade-failed-second-leg-refund.js covers, where the
// relay-settle call to a foreign domain is rejected outright (an
// explicit error, nothing mutated there). THIS bug is the two-generals
// case: the relay-settle call actually REACHES the foreign domain and
// the foreign domain actually COMPLETES the settlement (transfers the
// poster's asset, mails the poster their payment) — but the HTTP
// response carrying that success back to the relaying station never
// arrives (a dropped connection, a timeout after the remote already
// committed). Before this fix, /atlas/trade/claim had no way to tell
// this apart from a genuine failure, so it took the exact same "the
// second leg failed" path refundFailedSecondLeg() handles — REVOKING
// the very credential it just told the foreign domain to mail to the
// poster, and minting the claimant a fresh refund of a balance that was
// never actually lost. Net effect: the poster's mailed gift became
// permanently unclaimable (its own issuer revoked it out from under
// her), and the claimant got a double grant (kept what the foreign
// domain legitimately transferred AND got their own offered balance
// refunded).
//
// Fix (SPEC.md §7 v1.35): /atlas/trade/relay-settle is now idempotent
// per (tradeId, credentialId) — see RELAY_SETTLE_RESULTS_FILE's own
// comment in issuer-server/server.js and
// atlas_relay_settle_results_file()'s in issuer-php/lib/store.php. A
// retry of the exact same settle attestation replays the already-
// recorded result instead of erroring on "already revoked" or
// re-mutating anything. relayTradeSettle() / atlas_relay_trade_settle()
// now retries ONCE on any failure before giving up, so a genuinely lost
// response self-heals on the retry — the overall trade completes
// correctly, nothing gets revoked that shouldn't, and nobody gets a
// double grant. Only when BOTH attempts fail does the old refund-or-
// tell-them fallback in /atlas/trade/claim still apply, for an actually
// failed settle.
//
// Reproduced/verified by patching a throwaway copy of the RELAYING
// station's own server.js — not the foreign domain's route handler
// (that's what the other test patches) — so the FIRST ever call to
// relayTradeSettle()'s underlying HTTP attempt throws AFTER a real,
// successful round trip to the foreign domain, simulating the response
// being lost in transit after the remote already committed. The SECOND
// call (this fix's own internal retry) runs for real, against the
// unpatched foreign domain. Not part of the permanent suite, same
// reasoning as every other manual-*.js script.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { subtle } = webcrypto;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-server');
const PORT_A = 8151; // foreign domain — issues Alice's iron, real/unpatched
const PORT_B = 8152; // the Trading Station — relays to A, PATCHED here
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

// Patches the RELAYING station's own copy of relayTradeSettle()'s
// underlying HTTP attempt so that ONLY THE FIRST EVER call (across the
// whole process) throws AFTER a real, successful round trip — every
// later call (this fix's own internal retry, or a genuinely fresh
// settle) behaves normally. This is what actually distinguishes "the
// fix recovers a lost-after-success response" from "the fix is just
// retrying into a server that never fails" — the foreign domain's own
// bundle is never patched at all, so its half of the settle is 100%
// real either way.
function injectFirstResponseLostThenRecovers(bundleDir) {
  const serverPath = path.join(bundleDir, 'server.js');
  let src = fs.readFileSync(serverPath, 'utf8');
  const marker = "if (!res.ok) throw new Error(body.error || (domain + ' refused the trade settle (HTTP ' + res.status + ')'));\n      return body;";
  if (!src.includes(marker)) throw new Error('marker not found in server.js — shape changed, update this test');
  const replacement = "if (!res.ok) throw new Error(body.error || (domain + ' refused the trade settle (HTTP ' + res.status + ')'));\n" +
    "      global.__ATLAS_TEST_RELAY_SETTLE_CALLS = (global.__ATLAS_TEST_RELAY_SETTLE_CALLS || 0) + 1;\n" +
    "      if (global.__ATLAS_TEST_RELAY_SETTLE_CALLS === 1) throw new Error('could not reach ' + domain + \" (INJECTED: simulated dropped connection AFTER the remote already applied the settle, for this test only — call #1 only)\");\n" +
    "      return body;";
  src = src.replace(marker, replacement);
  fs.writeFileSync(serverPath, src);
}

// Signed mail check (SPEC.md §11.8): the credential's owner asks for its mailbox.
async function mailCheckAs(base, identity, credential) {
  const payload = { action: 'mail-check', domain: new URL(base).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: b64url(webcrypto.getRandomValues(new Uint8Array(18))) };
  const proof = await signPayload(identity, payload);
  return post(base, '/atlas/mail/check', { credentials: [credential], payload, proof });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ambiguous-settle-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });
  injectFirstResponseLostThenRecovers(bundleB); // the RELAYING station, not the foreign domain

  const stateA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ambiguous-settle-state-a-'));
  const stateB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ambiguous-settle-state-b-'));
  const docrootA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ambiguous-settle-docroot-a-'));
  const docrootB = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ambiguous-settle-docroot-b-'));
  setTrustedPeers(stateA, [DOMAIN_B]);
  setTrustedPeers(stateB, [DOMAIN_A]);

  let procA, procB;
  try {
    [procA, procB] = await Promise.all([
      startNodeServer(bundleA, PORT_A, DOMAIN_A, stateA, docrootA),
      startNodeServer(bundleB, PORT_B, DOMAIN_B, stateB, docrootB)
    ]);
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

    console.log('\nALL CHECKS PASSED — a response lost after the foreign domain already committed now self-heals via retry + idempotent replay, instead of stranding a legitimate gift and double-granting the claimant.');
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
