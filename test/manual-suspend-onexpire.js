// Regression test for suspend()'s `onExpire` parameter (SPEC.md §13.4 —
// supports the email-delivered bearer credential redemption flow, where a
// door-scanned ticket is suspended for an event's duration rather than
// instantly revoked). Before this change, every suspension's expiresAt
// meant the same thing: once the deadline passes, the suspension LIFTS
// and the credential goes back to active — correct for the mechanism's
// original "temporary hold pending review" purpose, but wrong for a
// ticket that should end up permanently used once its event ends.
//
// `onExpire` picks between the two outcomes: 'lift' (the default, every
// existing call site's unchanged behavior) reactivates on expiry same as
// before; 'finalize' revokes the credential instead (reason 'redeemed')
// once its suspension window passes.
//
// No HTTP endpoint exposes `onExpire` yet — the redemption endpoint that
// will set it doesn't exist (this round only locks the suspend()
// primitive and the design, not the feature itself) — so this test
// patches a throwaway copy of issuer-server/server.js with a minimal
// test-only route that calls suspend() directly with the 4th argument,
// same "patch a copy, never the real file" approach already used by
// test/manual-trade-ambiguous-settle-response.js. The real file is never
// touched.
//
// Checks:
//   1. A 'finalize' suspension with a past expiresAt reads back as
//      genuinely revoked (status 'revoked', reason 'redeemed') on the
//      next /atlas/mail/check — not merely "no longer suspended".
//   2. A 'lift' (explicit) suspension with the same past expiresAt reads
//      back as neither suspended nor revoked — it simply stopped being
//      in effect, exactly like today's only behavior.
//   3. Omitting onExpire entirely (the 3-argument call every existing
//      site still makes) behaves identically to explicit 'lift' — the
//      default didn't change anything for them.
//   4. A 'finalize' suspension that has NOT yet expired is still only
//      "suspended", not revoked — finalize only fires once the deadline
//      actually passes, not at creation time.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8173; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-server');

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
const H = require('./lib/delivery-harness');
let statusOwner = null; // the identity that owns the credentials below
async function mailCheckStatus(credential) {
  return H.mailCheckStatus(BASE, statusOwner, credential);
}
// Test-only backdoor added to the patched copy below — calls suspend()
// directly with all 4 arguments, bypassing admin auth, since nothing
// outside this test needs it and no real admin endpoint plumbs onExpire
// yet.
async function testSuspend(id, reason, expiresAt, onExpire) {
  const res = await postJson('/atlas/test/suspend-with-onexpire', { id, reason, expiresAt, onExpire });
  if (res.status !== 200) throw new Error('test backdoor suspend failed: ' + JSON.stringify(res.body));
  return res.body;
}

function buildPatchedCopy() {
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-suspend-onexpire-bundle-')) + '-dir';
  fs.cpSync(BUNDLE_DIR, bundleDir, { recursive: true });
  const serverPath = path.join(bundleDir, 'server.js');
  let src = fs.readFileSync(serverPath, 'utf8');

  const marker = "      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);";
  if (!src.includes(marker)) throw new Error('marker not found in server.js — shape changed, update this test');
  const backdoor = `      if (req.method === 'POST' && req.url === '/atlas/test/suspend-with-onexpire') {
        const { id, reason, expiresAt, onExpire } = JSON.parse((await readBody(req)) || '{}');
        suspend(id, reason || 'test', expiresAt || null, onExpire);
        return sendJson(res, 200, { ok: true });
      }

`;
  src = src.replace(marker, backdoor + marker);
  fs.writeFileSync(serverPath, src);
  return bundleDir;
}

(async () => {
  console.log('SETUP: building a patched copy of issuer-server with a test-only onExpire backdoor route');
  const bundleDir = buildPatchedCopy();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-suspend-onexpire-state-'));
  const docrootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-suspend-onexpire-docroot-'));

  console.log('SETUP: starting the patched issuer-server instance on port ' + PORT);
  const proc = spawn('node', ['server.js'], {
    cwd: bundleDir,
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docrootDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: patched issuer-server up on port ' + PORT);

  try {
    console.log('SETUP: minting four throwaway credentials, one per check below');
    // The owner signs the mail check that reads each credential's status.
    statusOwner = await H.genIdentity();
    const fakeOwnerKey = statusOwner.publicKey;
    const credFinalizeExpired = await issueAsset(fakeOwnerKey, 'atlas.demo.attestation.filing');
    const credLiftExpired = await issueAsset(fakeOwnerKey, 'atlas.demo.attestation.filing');
    const credDefaultExpired = await issueAsset(fakeOwnerKey, 'atlas.demo.attestation.filing');
    const credFinalizeNotYetExpired = await issueAsset(fakeOwnerKey, 'atlas.demo.attestation.filing');

    const past = new Date(Date.now() - 60000).toISOString();
    const future = new Date(Date.now() + 3600000).toISOString();

    console.log('STEP 1: a \'finalize\' suspension with a past expiresAt reads back as genuinely revoked, reason \'redeemed\'');
    await testSuspend(credFinalizeExpired.id, 'event-ended', past, 'finalize');
    const status1 = await mailCheckStatus(credFinalizeExpired);
    assert(status1 !== null, 'expected mail/check to report something for the finalize-expired id, got null');
    assert(status1.status === 'revoked', 'expected status "revoked", got: ' + JSON.stringify(status1));
    assert(status1.reason === 'redeemed', 'expected reason "redeemed", got: ' + JSON.stringify(status1));
    console.log('PASS: finalize-on-expiry revoked the credential ->', JSON.stringify(status1));

    console.log('STEP 2: a \'lift\' suspension with the same past expiresAt reads back as neither suspended nor revoked');
    await testSuspend(credLiftExpired.id, 'temporary-hold', past, 'lift');
    const status2 = await mailCheckStatus(credLiftExpired);
    assert(status2 === null, 'expected an expired lift-suspension to be invisible to mail/check, got: ' + JSON.stringify(status2));
    console.log('PASS: lift-on-expiry left the credential alone, same as today\'s only behavior');

    console.log('STEP 3: omitting onExpire entirely (the 3-argument shape every existing call site uses) behaves identically to explicit \'lift\'');
    await testSuspend(credDefaultExpired.id, 'temporary-hold', past, undefined);
    const status3 = await mailCheckStatus(credDefaultExpired);
    assert(status3 === null, 'expected the default (unspecified onExpire) to behave like lift, got: ' + JSON.stringify(status3));
    console.log('PASS: default onExpire matches explicit \'lift\' — zero behavior change for existing callers');

    console.log('STEP 4: a \'finalize\' suspension that has NOT yet expired is still only suspended, not revoked');
    await testSuspend(credFinalizeNotYetExpired.id, 'event-in-progress', future, 'finalize');
    const status4 = await mailCheckStatus(credFinalizeNotYetExpired);
    assert(status4 !== null && status4.status === 'suspended', 'expected status "suspended" while still within the window, got: ' + JSON.stringify(status4));
    assert(status4.reason === 'event-in-progress', 'expected the suspension reason to come through, got: ' + JSON.stringify(status4));
    console.log('PASS: finalize does not fire early ->', JSON.stringify(status4));

    console.log('\nALL SUSPEND ONEXPIRE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(bundleDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(docrootDir, { recursive: true, force: true });
  }
})();
