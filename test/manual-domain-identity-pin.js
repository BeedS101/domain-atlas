// End-to-end check for SPEC.md §3.7 (optional domain identity pinning) —
// the server-side signing/serving mechanism (issuer-server/server.js's
// preparePinnedManifest(), opt-in via ATLAS_PIN_MANIFEST_IDENTITY), the
// directory-server/server.js acceptance fix (a manifest carrying BOTH
// "domain" and "identityKey" together used to be wrongly rejected), and the
// extension/content.js client-side disclosure — a non-blocking warning,
// deliberately NOT §3.6.1's mandatory modal.
//
// Drives the actual wallet extension against the repo's own real dev
// instance on localhost:8001 (same convention as
// manual-museum-ticket-stall.js and every other extension-driven
// manual-*.js test), so the git-ignored state files it produces are
// cleaned up before and after. Also spins its own isolated directory-server
// child process, same as verify-directory.js's own background-scheduler
// step.
//
// Checks:
//   1. With ATLAS_PIN_MANIFEST_IDENTITY set, .well-known/spatial.json is
//      served with a real identityKey + signature that verifies, naming
//      exactly the key published in this domain's own atlas-key.json.
//   2. directory-server accepts a domain+identityKey manifest (the old
//      validateManifestShape bug rejected this shape outright) and
//      populates the world's identityKey field from the validated pin.
//   3. directory-server never rejects a manifest for a BROKEN pin — the
//      domain+worlds content still indexes, just without the identityKey
//      field. A manifest with neither domain nor identityKey is still the
//      one shape that's actually invalid.
//   4. First visit: the extension records the pin silently — no
//      disclosure, no visible change to the Enter button.
//   5. An unchanged key across visits stays silent.
//   6. A changed key that the domain's own atlas-key.json still lists in
//      its history (an ordinary, recorded rotation) stays silent too.
//   7. A changed key with NO rotation record anywhere triggers the visible
//      non-blocking disclosure — a "⚠" label prefix, a changed button
//      color, and a warning line in the hover tooltip — never a blocking
//      modal, never a lockout.
//   8. A manifest whose pin fails its own signature check is never
//      disclosed and never remembered as if it were real.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const NODE_BASE = 'http://localhost:8001';
const DOMAIN = 'localhost:8001';

const ISSUER_SERVER_DIR = path.resolve(__dirname, '..', 'issuer-server');
const WELL_KNOWN_DIR = path.resolve(__dirname, '..', 'demo-domain-a', '.well-known');
const KEY_FILE = path.join(ISSUER_SERVER_DIR, 'issuer-private-key.jwk.json');
const PUBLIC_KEY_FILE = path.join(WELL_KNOWN_DIR, 'atlas-key.json');
const CHROME_PROFILE_DIR = path.resolve(__dirname, '.chrome-profile-domain-identity-pin');

function cleanGeneratedFiles() {
  try { fs.rmSync(KEY_FILE, { force: true }); } catch (err) {}
  try {
    for (const name of fs.readdirSync(ISSUER_SERVER_DIR)) {
      if (name.startsWith('atlas-') && name.endsWith('.json')) fs.rmSync(path.join(ISSUER_SERVER_DIR, name), { force: true });
    }
  } catch (err) {}
  try { fs.rmSync(path.join(WELL_KNOWN_DIR, 'atlas-key.json'), { force: true }); } catch (err) {}
  try { fs.rmSync(path.join(WELL_KNOWN_DIR, 'atlas-revocations.json'), { force: true }); } catch (err) {}
  try { fs.rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
}

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(str) { return new Uint8Array(Buffer.from(str, 'base64url')); }
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

function spawnIssuerServer() {
  const proc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ATLAS_PIN_MANIFEST_IDENTITY: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
}
function killAndWait(proc) {
  return new Promise((resolve) => {
    proc.on('exit', resolve);
    proc.kill();
  });
}

function worldFixture(overrides = {}) {
  return {
    id: 'room', name: 'Test Room',
    entry: { scene: '/spatial/room/scene.json', renderer: ['procedural-v1'] },
    policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' },
    profile: { genre: 'test-genre', scale: 'room', capabilities: { building: 'none', vehicles: false, combat: 'none', landOwnership: false } },
    portals: [],
    ...overrides
  };
}
function startMutableManifestServer(initialManifest) {
  const state = { manifest: initialManifest };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.manifest));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

// A plain static server (HTML root + a manifest with a genuinely BROKEN
// pin: real-shaped identityKey, garbage signature bytes) — used for the
// "a broken pin is never disclosed" browser check. Its own domain is a
// throwaway, unrelated to demo-domain-a's, so it can't collide with any of
// this test's other atlasPinnedIdentities entries.
async function startTamperedPinPage() {
  const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const identityKey = b64url(new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey)));
  const garbageSignature = b64url(webcrypto.getRandomValues(new Uint8Array(64))); // right length, provably not a real signature over anything
  let manifestJson;
  const server = http.createServer((req, res) => {
    if (req.url === '/.well-known/spatial.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(manifestJson);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>tampered pin test</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const manifest = {
    spec: 'domain-atlas/1.0', domain: 'localhost:' + port, identityKey, signature: garbageSignature,
    owner: { name: 'Tampered Pin Test' }, defaultWorld: 'room', worlds: [worldFixture()], updated: new Date().toISOString()
  };
  manifestJson = JSON.stringify(manifest);
  return { server, port, url: `http://localhost:${port}/` };
}

function readKeyDoc() { return JSON.parse(fs.readFileSync(PUBLIC_KEY_FILE, 'utf8')); }
function writeKeyDoc(doc) { fs.writeFileSync(PUBLIC_KEY_FILE, JSON.stringify(doc, null, 2)); }

function enterBtnText(page) { return page.locator('#domain-atlas-enter-btn').textContent(); }
function enterBtnBg(page) { return page.locator('#domain-atlas-enter-btn').evaluate((el) => getComputedStyle(el).backgroundColor); }
async function waitSettle(ms = 1500) { await new Promise((r) => setTimeout(r, ms)); }

(async () => {
  cleanGeneratedFiles();
  let issuerProc = null;
  let directoryProc = null;
  let context = null;
  let tamperedPage = null;

  try {
    console.log('STEP 1: with ATLAS_PIN_MANIFEST_IDENTITY set, spatial.json is served pinned, verifying against this domain\'s own atlas-key.json');
    issuerProc = await spawnIssuerServer();
    const manifestA = await fetch(NODE_BASE + '/.well-known/spatial.json').then((r) => r.json());
    assert(manifestA.domain === DOMAIN, 'expected the pinned manifest to keep its original domain field, got: ' + manifestA.domain);
    assert(typeof manifestA.identityKey === 'string' && manifestA.identityKey.length > 0, 'expected a real identityKey on the pinned manifest');
    assert(await verifyManifestSignature(manifestA), 'expected the pinned manifest\'s signature to verify against its own identityKey');
    const keyDocA = await fetch(NODE_BASE + '/.well-known/atlas-key.json').then((r) => r.json());
    assert(keyDocA.keys.some((k) => k.publicKey === manifestA.identityKey), 'expected the pinned identityKey to be the one published in atlas-key.json');
    const keyA = manifestA.identityKey;
    console.log('PASS: pinned manifest signed for real, naming this domain\'s own published key —', keyA.slice(0, 20) + '...');

    console.log('STEP 2/3: directory-server accepts a domain+identityKey manifest, populates identityKey from a valid pin, never rejects for a broken one, and still rejects a manifest with neither');
    const dirPort = 8146;
    const snapshotPath = path.join('/tmp', 'test-directory-index-pin-' + Date.now() + '.json');
    directoryProc = spawn('node', [path.resolve(__dirname, '..', 'directory-server', 'server.js')], {
      env: { ...process.env, PORT: String(dirPort), DIRECTORY_SNAPSHOT_FILE: snapshotPath },
      stdio: 'pipe'
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('isolated directory-server did not start in time')), 8000);
      directoryProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    });
    const DIRECTORY = 'http://localhost:' + dirPort;

    const submitA = await fetch(DIRECTORY + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: NODE_BASE + '/.well-known/spatial.json' }) }).then((r) => r.json());
    assert(submitA.indexed > 0, 'expected the pinned demo-domain-a manifest to index at least one world, got: ' + JSON.stringify(submitA));
    const searchA = await fetch(DIRECTORY + '/search?domain=' + encodeURIComponent(DOMAIN)).then((r) => r.json());
    assert(searchA.results.length > 0 && searchA.results.every((w) => w.identityKey === keyA), 'expected every indexed demo-domain-a world to carry the validated pin\'s identityKey, got: ' + JSON.stringify(searchA.results.map((w) => w.identityKey)));
    console.log('PASS: a valid domain+identityKey pin is accepted and populated on every indexed world');

    const brokenPinServer = await startMutableManifestServer(null);
    const brokenDomain = 'localhost:' + brokenPinServer.port;
    brokenPinServer.state.manifest = { spec: 'domain-atlas/1.0', domain: brokenDomain, identityKey: keyA, signature: 'not-a-real-signature', owner: { name: 'Broken Pin' }, defaultWorld: 'room', worlds: [worldFixture()], updated: new Date().toISOString() };
    const brokenSubmit = await fetch(DIRECTORY + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: `http://127.0.0.1:${brokenPinServer.port}/` }) }).then((r) => r.json());
    assert(brokenSubmit.indexed === 1, 'expected a manifest with a BROKEN pin to still index normally on its domain anchor, got: ' + JSON.stringify(brokenSubmit));
    const brokenSearch = await fetch(DIRECTORY + '/search?domain=' + encodeURIComponent(brokenDomain)).then((r) => r.json());
    assert(brokenSearch.results.length === 1 && brokenSearch.results[0].identityKey === null, 'expected a broken pin to leave identityKey null rather than rejecting the manifest, got: ' + JSON.stringify(brokenSearch.results));
    brokenPinServer.server.close();
    console.log('PASS: a broken pin never blocks indexing — dropped silently, identityKey left null');

    const neitherServer = await startMutableManifestServer({ spec: 'domain-atlas/1.0', owner: { name: 'Neither' }, defaultWorld: 'room', worlds: [worldFixture()], updated: new Date().toISOString() });
    const neitherSubmit = await fetch(DIRECTORY + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: `http://127.0.0.1:${neitherServer.port}/` }) }).then((r) => r.json());
    assert(neitherSubmit.error && /domain.*identityKey|identityKey.*domain/i.test(neitherSubmit.error), 'expected a manifest with NEITHER domain nor identityKey to be rejected, got: ' + JSON.stringify(neitherSubmit));
    neitherServer.server.close();
    console.log('PASS: a manifest anchored by nothing at all (neither domain nor identityKey) is still rejected');

    await killAndWait(directoryProc);
    directoryProc = null;
    try { fs.unlinkSync(snapshotPath); } catch (err) {}

    console.log('STEP 4: first visit — the extension records the pin silently, no visible change to the Enter button');
    context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
      headless: false,
      executablePath: '/opt/pw-browsers/chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
    });
    const page = await context.newPage();
    await page.goto(NODE_BASE, { waitUntil: 'load' });
    await page.waitForSelector('#domain-atlas-enter-btn', { timeout: 10000 });
    await waitSettle();
    let text = await enterBtnText(page);
    assert(!text.includes('⚠'), 'expected no warning on a first-ever visit, got button text: ' + text);
    console.log('PASS: first visit is silent —', text);

    console.log('STEP 5: reloading with an unchanged key stays silent');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#domain-atlas-enter-btn', { timeout: 10000 });
    await waitSettle();
    text = await enterBtnText(page);
    assert(!text.includes('⚠'), 'expected no warning when the key has not changed, got: ' + text);
    console.log('PASS: unchanged key across visits stays silent');

    console.log('STEP 6: a changed key that the domain\'s own atlas-key.json still lists in its history (a recorded rotation) stays silent');
    await killAndWait(issuerProc);
    fs.rmSync(KEY_FILE, { force: true }); // forces loadOrCreateKeypair() to generate a genuinely new key on next boot
    issuerProc = await spawnIssuerServer();
    const manifestB = await fetch(NODE_BASE + '/.well-known/spatial.json').then((r) => r.json());
    const keyB = manifestB.identityKey;
    assert(keyB !== keyA, 'expected a fresh key after deleting the persisted key file');
    // Simulate the domain having dutifully recorded its own rotation —
    // patch atlas-key.json (a plain static file, re-read fresh on every
    // request, same as every other .well-known file here) to ALSO list the
    // old key with a validUntil, exactly the §5.3 "concurrent keys" history
    // shape a real rotating domain would publish.
    const keyDocRotated = readKeyDoc();
    keyDocRotated.keys.unshift({ publicKey: keyA, validFrom: new Date(Date.now() - 86400000).toISOString(), validUntil: new Date().toISOString() });
    writeKeyDoc(keyDocRotated);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#domain-atlas-enter-btn', { timeout: 10000 });
    await waitSettle();
    text = await enterBtnText(page);
    assert(!text.includes('⚠'), 'expected no warning for a changed key that IS in the domain\'s own rotation history, got: ' + text);
    console.log('PASS: a recorded rotation stays silent —', text);

    console.log('STEP 7: a changed key with NO rotation record anywhere triggers the visible, non-blocking disclosure');
    await killAndWait(issuerProc);
    fs.rmSync(KEY_FILE, { force: true });
    issuerProc = await spawnIssuerServer(); // boots fresh — ensureWellKnownFiles() overwrites atlas-key.json with ONLY this new key, wiping the history patched in above
    const manifestC = await fetch(NODE_BASE + '/.well-known/spatial.json').then((r) => r.json());
    const keyC = manifestC.identityKey;
    assert(keyC !== keyA && keyC !== keyB, 'expected yet another fresh key');
    const keyDocC = readKeyDoc();
    assert(!keyDocC.keys.some((k) => k.publicKey === keyB), 'expected the previous key\'s history to be gone — an undocumented rotation is exactly this test\'s point');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#domain-atlas-enter-btn', { timeout: 10000 });
    await waitSettle();
    text = await enterBtnText(page);
    assert(text.startsWith('⚠'), 'expected the "⚠" disclosure prefix for an undocumented key change, got: ' + text);
    const bg = await enterBtnBg(page);
    assert(bg !== 'rgb(192, 90, 31)', 'expected the button\'s background color to change away from its normal orange when disclosing, got: ' + bg);
    await page.locator('#domain-atlas-enter-btn').hover();
    await page.waitForFunction(() => {
      const el = document.getElementById('domain-atlas-info-tooltip');
      return el && getComputedStyle(el).display !== 'none' && el.innerHTML.toLowerCase().includes('identity key changed');
    }, { timeout: 5000 });
    console.log('PASS: undocumented key change discloses plainly — label prefix, color change, and a tooltip line — with the button still fully clickable, never a blocking modal');

    console.log('STEP 8: a manifest whose pin fails its own signature check is never disclosed');
    tamperedPage = await startTamperedPinPage();
    const page2 = await context.newPage();
    await page2.goto(tamperedPage.url, { waitUntil: 'load' });
    await page2.waitForSelector('#domain-atlas-enter-btn', { timeout: 10000 });
    await waitSettle();
    const tamperedText = await enterBtnText(page2);
    assert(!tamperedText.includes('⚠'), 'expected a manifest with a broken pin to never trigger disclosure, got: ' + tamperedText);
    console.log('PASS: a broken pin is silently ignored, never disclosed');

    console.log('\nALL DOMAIN IDENTITY PIN (SPEC.md §3.7) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    if (tamperedPage) tamperedPage.server.close();
    if (directoryProc) directoryProc.kill();
    if (issuerProc) issuerProc.kill();
    cleanGeneratedFiles();
  }
})();
