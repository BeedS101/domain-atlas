// PHP mirror of test/manual-suspend-onexpire.js — see that file's header
// for the full rationale. Exercises atlas_suspend()/read_suspensions()'s
// new `$onExpire` parameter in issuer-php/lib/store.php, plus the
// mail/check.php fix that reads revocations fresh after checking
// suspension instead of caching a snapshot taken before a 'finalize'
// entry's expiry could have revoked the id as a side effect of this same
// request.
//
// Same "own isolated bundle copy, php -S + test-router.php" pattern as
// every other manual-*-php.js test. No real admin endpoint plumbs
// `onExpire` yet (the redemption endpoint that will set it doesn't exist
// — this round only locks the primitive and the design), so a tiny
// test-only route (atlas/test/suspend-with-onexpire.php) is dropped into
// the copied bundle, calling atlas_suspend() directly with all 4
// arguments. The real issuer-php/ tree is never touched.
//
// Checks (same as the Node version):
//   1. A 'finalize' suspension with a past expiresAt reads back as
//      genuinely revoked (status 'revoked', reason 'redeemed').
//   2. A 'lift' (explicit) suspension with the same past expiresAt reads
//      back as neither suspended nor revoked.
//   3. Omitting onExpire (the 3-argument shape every existing call site
//      uses) behaves identically to explicit 'lift'.
//   4. A 'finalize' suspension that hasn't expired yet is still only
//      suspended, not revoked.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8174; // isolated — distinct from every other manual-*.js/-php.js test's chosen port
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-suspend-onexpire-php-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function postJson(urlPath, body) {
  return fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}
async function issueAsset(ownerPublicKey, assetClass) {
  const res = await postJson('/atlas/asset/issue', { ownerPublicKey, assetClass });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function mailCheckStatus(id) {
  const res = await postJson('/atlas/mail/check', { credentialIds: [id] });
  if (res.status !== 200) throw new Error('mail check failed: ' + JSON.stringify(res.body));
  return res.body.updates.find((u) => u.id === id) || null;
}
async function testSuspend(id, reason, expiresAt, onExpire) {
  const res = await postJson('/atlas/test/suspend-with-onexpire', { id, reason, expiresAt, onExpire });
  if (res.status !== 200) throw new Error('test backdoor suspend failed: ' + JSON.stringify(res.body));
  return res.body;
}

function writeBackdoorRoute() {
  const dir = path.join(BUNDLE_DIR, 'atlas', 'test');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'suspend-with-onexpire.php'), `<?php
// Test-only route, not part of the deployable bundle — calls
// atlas_suspend() directly with all 4 arguments, bypassing admin auth,
// since nothing outside test/manual-suspend-onexpire-php.js needs it and
// no real admin endpoint plumbs onExpire yet.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}
atlas_suspend($body['id'], $body['reason'] ?? 'test', $body['expiresAt'] ?? null, $body['onExpire'] ?? 'lift');
send_json(200, ['ok' => true]);
`);
}

(async () => {
  console.log('SETUP: copying issuer-php into an isolated bundle dir, adding the test-only onExpire backdoor route, starting its own dev server on port ' + PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), BUNDLE_DIR, { recursive: true });
  writeBackdoorRoute();
  const proc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-php dev server up on port ' + PORT);

  try {
    console.log('SETUP: minting four throwaway credentials, one per check below');
    const fakeOwnerKey = 'b64url-placeholder-owner-key-not-used-for-signing';
    const credFinalizeExpired = await issueAsset(fakeOwnerKey, 'atlas.demo.attestation.filing');
    const credLiftExpired = await issueAsset(fakeOwnerKey, 'atlas.demo.attestation.filing');
    const credDefaultExpired = await issueAsset(fakeOwnerKey, 'atlas.demo.attestation.filing');
    const credFinalizeNotYetExpired = await issueAsset(fakeOwnerKey, 'atlas.demo.attestation.filing');

    const past = new Date(Date.now() - 60000).toISOString();
    const future = new Date(Date.now() + 3600000).toISOString();

    console.log('STEP 1: a \'finalize\' suspension with a past expiresAt reads back as genuinely revoked, reason \'redeemed\'');
    await testSuspend(credFinalizeExpired.id, 'event-ended', past, 'finalize');
    const status1 = await mailCheckStatus(credFinalizeExpired.id);
    assert(status1 !== null, 'expected mail/check to report something for the finalize-expired id, got null');
    assert(status1.status === 'revoked', 'expected status "revoked", got: ' + JSON.stringify(status1));
    assert(status1.reason === 'redeemed', 'expected reason "redeemed", got: ' + JSON.stringify(status1));
    console.log('PASS: finalize-on-expiry revoked the credential ->', JSON.stringify(status1));

    console.log('STEP 2: a \'lift\' suspension with the same past expiresAt reads back as neither suspended nor revoked');
    await testSuspend(credLiftExpired.id, 'temporary-hold', past, 'lift');
    const status2 = await mailCheckStatus(credLiftExpired.id);
    assert(status2 === null, 'expected an expired lift-suspension to be invisible to mail/check, got: ' + JSON.stringify(status2));
    console.log('PASS: lift-on-expiry left the credential alone, same as today\'s only behavior');

    console.log('STEP 3: omitting onExpire entirely (the 3-argument shape every existing call site uses) behaves identically to explicit \'lift\'');
    await testSuspend(credDefaultExpired.id, 'temporary-hold', past, undefined);
    const status3 = await mailCheckStatus(credDefaultExpired.id);
    assert(status3 === null, 'expected the default (unspecified onExpire) to behave like lift, got: ' + JSON.stringify(status3));
    console.log('PASS: default onExpire matches explicit \'lift\' — zero behavior change for existing callers');

    console.log('STEP 4: a \'finalize\' suspension that has NOT yet expired is still only suspended, not revoked');
    await testSuspend(credFinalizeNotYetExpired.id, 'event-in-progress', future, 'finalize');
    const status4 = await mailCheckStatus(credFinalizeNotYetExpired.id);
    assert(status4 !== null && status4.status === 'suspended', 'expected status "suspended" while still within the window, got: ' + JSON.stringify(status4));
    assert(status4.reason === 'event-in-progress', 'expected the suspension reason to come through, got: ' + JSON.stringify(status4));
    console.log('PASS: finalize does not fire early ->', JSON.stringify(status4));

    console.log('\nALL SUSPEND ONEXPIRE CHECKS PASSED (PHP)');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  }
})();
