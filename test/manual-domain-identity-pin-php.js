// Companion to test/manual-domain-identity-pin.js — proves issuer-php's own
// take on SPEC.md §3.7 (optional domain identity pinning): lib/sign-
// manifest.php, the CLI script that signs a domain's own .well-known/
// spatial.json in place with this domain's persisted key.
//
// PHP has no long-lived process to hook a "boot" moment the way Node's
// issuer-server/server.js does (preparePinnedManifest(), signed once and
// cached in memory) — and .well-known/spatial.json is served as a plain
// static file, straight from the webserver, never touching any PHP script
// at all. So PHP-side pinning is a deploy-time step instead of a runtime
// one: this test runs that step directly (php lib/sign-manifest.php),
// exactly the way a real site operator would after dropping this bundle
// into their docroot, then verifies the result the same way a browsing
// client actually would — over real HTTP, checking a real signature
// against the domain's own real published atlas-key.json.
//
// Checks:
//   1. Running the script against a domain-anchored fixture manifest adds a
//      real identityKey + signature, in place, leaving the rest of the
//      manifest's content untouched.
//   2. The manifest, fetched over real HTTP exactly like a browsing client
//      would, carries a signature that verifies against its own
//      identityKey — and that identityKey matches what
//      .well-known/atlas-key.json (also fetched over real HTTP) publishes
//      as this domain's current key.
//   3. A manifest with no "domain" field is refused (§3.7 pinning only
//      applies to a domain-anchored manifest) — the script exits non-zero
//      and leaves the file untouched.
//   4. Re-running the script after editing the manifest's own content
//      re-signs fresh — the new signature verifies against the NEW
//      content, not stale leftover content from the first run.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');
const PORT = 8145; // isolated — distinct from every other manual-*-php.js test's own port
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://localhost:' + PORT;

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(str) { return new Uint8Array(Buffer.from(str, 'base64url')); }

// Same canonicalize() shape as every other crypto helper in this project —
// sorted-key JSON, no whitespace.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function verifyManifestSignature(manifest) {
  if (typeof manifest.signature !== 'string' || !manifest.signature) return false;
  const { signature, ...unsigned } = manifest;
  try {
    const pub = await subtle.importKey('raw', fromB64url(manifest.identityKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const data = new TextEncoder().encode(canonicalize(unsigned));
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(signature), data);
  } catch {
    return false;
  }
}

function fixtureManifest(genre) {
  return {
    spec: 'domain-atlas/1.0',
    domain: DOMAIN,
    owner: { name: 'Pin Test Domain' },
    defaultWorld: 'room',
    worlds: [{
      id: 'room',
      name: 'Test Room',
      entry: { scene: '/spatial/room/scene.json', renderer: ['procedural-v1'] },
      policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' },
      profile: { genre, scale: 'room', capabilities: { building: 'none', vehicles: false, combat: 'none', landOwnership: false } },
      portals: []
    }],
    updated: new Date().toISOString()
  };
}

function startPhpServer(bundleDir, port) {
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
    cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S on port ' + port + ' did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('php -S on port ' + port + ' exited early with code ' + code)));
  });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-domain-pin-php-'));
  const bundle = path.join(tmpRoot, 'domain');
  console.log('SETUP: copying issuer-php into an isolated throwaway bundle, with a fixture .well-known/spatial.json of its own (this bundle, unlike a real deployment, carries no site content of its own)');
  fs.cpSync(BUNDLE_DIR, bundle, { recursive: true });
  const wellKnownDir = path.join(bundle, '.well-known');
  fs.mkdirSync(wellKnownDir, { recursive: true });
  const spatialPath = path.join(wellKnownDir, 'spatial.json');
  fs.writeFileSync(spatialPath, JSON.stringify(fixtureManifest('pin-test-genre'), null, 2));

  let proc;
  try {
    console.log('STEP 1: running lib/sign-manifest.php against the fixture manifest adds identityKey + signature in place');
    const out1 = execFileSync('php', ['lib/sign-manifest.php', '.well-known/spatial.json'], { cwd: bundle }).toString();
    assert(/Signed/.test(out1), 'expected the script to report success, got: ' + out1);
    const signedOnDisk = JSON.parse(fs.readFileSync(spatialPath, 'utf8'));
    assert(typeof signedOnDisk.identityKey === 'string' && signedOnDisk.identityKey.length > 0, 'expected identityKey to be added to the manifest on disk');
    assert(typeof signedOnDisk.signature === 'string' && signedOnDisk.signature.length > 0, 'expected signature to be added to the manifest on disk');
    assert(signedOnDisk.domain === DOMAIN, 'expected the original domain field to survive signing, got: ' + signedOnDisk.domain);
    assert(signedOnDisk.worlds[0].profile.genre === 'pin-test-genre', 'expected the rest of the manifest content to survive signing untouched');
    console.log('PASS: sign-manifest.php added a real identityKey + signature, leaving the rest of the manifest untouched');

    console.log('STEP 2: fetched over real HTTP, the signature verifies against its own identityKey, and that key matches this domain\'s published atlas-key.json');
    proc = await startPhpServer(bundle, PORT);
    const fetchedManifest = await fetch(BASE + '/.well-known/spatial.json').then((r) => r.json());
    assert(fetchedManifest.signature === signedOnDisk.signature, 'expected the manifest served over HTTP to match what sign-manifest.php wrote to disk');
    const sigOk = await verifyManifestSignature(fetchedManifest);
    assert(sigOk, 'expected the pinned manifest\'s signature to verify against its own identityKey');
    const keyDoc = await fetch(BASE + '/.well-known/atlas-key.json').then((r) => r.json());
    assert(Array.isArray(keyDoc.keys) && keyDoc.keys.some((k) => k.publicKey === fetchedManifest.identityKey), 'expected the pinned identityKey to be published in this domain\'s own atlas-key.json');
    console.log('PASS: real HTTP round trip confirms a validly-signed pin naming this domain\'s own published key');
    proc.kill();
    proc = null;

    console.log('STEP 3: a manifest with no "domain" field is refused — the script exits non-zero and leaves the file untouched');
    const noDomainPath = path.join(wellKnownDir, 'no-domain.json');
    const noDomainManifest = { spec: 'domain-atlas/1.0', identityKey: 'placeholder', worlds: [] };
    fs.writeFileSync(noDomainPath, JSON.stringify(noDomainManifest, null, 2));
    let failed = false;
    try {
      execFileSync('php', ['lib/sign-manifest.php', '.well-known/no-domain.json'], { cwd: bundle, stdio: 'pipe' });
    } catch (err) {
      failed = true;
      assert(/domain/i.test(err.stderr.toString()), 'expected a clear error naming the missing "domain" field, got: ' + err.stderr.toString());
    }
    assert(failed, 'expected sign-manifest.php to exit non-zero for a manifest with no "domain" field');
    const untouched = JSON.parse(fs.readFileSync(noDomainPath, 'utf8'));
    assert(JSON.stringify(untouched) === JSON.stringify(noDomainManifest), 'expected the refused manifest to be left completely untouched on disk');
    console.log('PASS: a domain-less manifest is refused, cleanly, with the file left untouched');

    console.log('STEP 4: re-running after editing the manifest\'s own content re-signs fresh — the new signature covers the new content, not stale content from the first run');
    const editedManifest = JSON.parse(fs.readFileSync(spatialPath, 'utf8'));
    editedManifest.worlds[0].profile.genre = 'pin-test-genre-EDITED';
    // Simulate the operator editing their SOURCE manifest (unsigned) rather
    // than hand-editing the already-signed output — strip the previous
    // pin fields first, the same way a real edit-then-resign cycle would.
    delete editedManifest.identityKey;
    delete editedManifest.signature;
    fs.writeFileSync(spatialPath, JSON.stringify(editedManifest, null, 2));
    execFileSync('php', ['lib/sign-manifest.php', '.well-known/spatial.json'], { cwd: bundle });
    const resigned = JSON.parse(fs.readFileSync(spatialPath, 'utf8'));
    assert(resigned.worlds[0].profile.genre === 'pin-test-genre-EDITED', 'expected the edited content to survive re-signing');
    assert(resigned.signature !== signedOnDisk.signature, 'expected re-signing different content to produce a different signature');
    const resignedOk = await verifyManifestSignature(resigned);
    assert(resignedOk, 'expected the re-signed manifest\'s signature to verify against its own (edited) content');
    console.log('PASS: re-running after an edit re-signs fresh, over the new content');

    console.log('\nALL PHP DOMAIN IDENTITY PIN CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (proc) proc.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
