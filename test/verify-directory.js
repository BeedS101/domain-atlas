// Verifies the directory service (directory-server/server.js, SPEC.md
// §3.3) against real HTTP traffic — no mocking. Assumes the issuer
// (localhost:8001), the plain static server for demo-domain-b
// (localhost:8002), and the directory service itself (localhost:8003) are
// already running, same convention as the other verify-*.js scripts.
//
// Covers:
//   1. Submitting both demo manifests indexes exactly the discoverable
//      worlds, no more, no less.
//   2. Ranking is actually computed from the real inbound "kind":"domain"
//      portal graph, not just returned in submission order — proven with
//      three synthetic temp-server manifests whose only inbound links are
//      the ones this test wires up itself.
//   3. Structured filters (genre/scale/combat/domain) and free-text query
//      each narrow results correctly.
//   4. The background scheduler actually re-crawls: a manifest that
//      changes its genre gets updated on the next scheduled pass, and a
//      world that flips discoverable:false gets removed from the index —
//      run against a short-lived, isolated directory-server child process
//      so this doesn't wait out the real 60s default interval.
//   5. A key-anchored manifest is verified the same way a client would:
//      accepted when validly signed, rejected (and the prior good entry
//      left untouched — "stale but cached", not wiped) when tampered.

const http = require('http');
const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;
const path = require('path');
const fs = require('fs');

const DIRECTORY = 'http://localhost:8003';

function assert(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(str) { return new Uint8Array(Buffer.from(str, 'base64url')); }

// Byte-for-byte the same as directory-server/server.js's own copy.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// A tiny mutable manifest server: serves whatever `state.manifest` currently
// holds, JSON-stringified fresh on every request — so a test can mutate
// `state.manifest` between requests to simulate a domain updating its own
// manifest between crawls, without needing a real filesystem-backed site.
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

function worldFixture(overrides = {}) {
  return {
    id: 'room',
    name: 'Test Room',
    entry: { scene: '/spatial/room/scene.json', renderer: ['procedural-v1'] },
    policy: {
      guestAccess: 'open', discoverable: true, identityRequired: false,
      itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any'
    },
    profile: { genre: 'test-genre', scale: 'room', capabilities: { building: 'none', vehicles: false, combat: 'none', landOwnership: false } },
    portals: [],
    ...overrides
  };
}

async function main() {
  console.log('STEP 1: submitting both demo manifests');
  const plazaRes = await fetch(DIRECTORY + '/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest: 'http://localhost:8001/.well-known/spatial.json' })
  }).then((r) => r.json());
  assert(plazaRes.indexed === 5, 'expected 5 discoverable worlds indexed from demo-domain-a, got ' + plazaRes.indexed);

  const workshopRes = await fetch(DIRECTORY + '/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest: 'http://localhost:8002/.well-known/spatial.json' })
  }).then((r) => r.json());
  assert(workshopRes.indexed === 1, 'expected 1 discoverable world indexed from demo-domain-b, got ' + workshopRes.indexed);
  console.log('PASS: 5 + 1 worlds indexed');

  console.log('STEP 2: ranking reflects the real inbound "kind":"domain" portal graph');
  const y = await startMutableManifestServer(null);
  const x = await startMutableManifestServer(null);
  const z = await startMutableManifestServer(null);
  const domY = 'localhost:' + y.port, domX = 'localhost:' + x.port, domZ = 'localhost:' + z.port;
  y.state.manifest = { spec: 'domain-atlas/1.0', domain: domY, owner: { name: 'Y' }, defaultWorld: 'room', worlds: [worldFixture({ profile: { genre: 'ranktest', scale: 'room', capabilities: { building: 'none', vehicles: false, combat: 'none', landOwnership: false } } })], updated: new Date().toISOString() };
  x.state.manifest = { spec: 'domain-atlas/1.0', domain: domX, owner: { name: 'X' }, defaultWorld: 'room', worlds: [worldFixture({ portals: [{ kind: 'domain', to: domY, label: 'to Y' }] })], updated: new Date().toISOString() };
  z.state.manifest = { spec: 'domain-atlas/1.0', domain: domZ, owner: { name: 'Z' }, defaultWorld: 'room', worlds: [worldFixture({ portals: [{ kind: 'domain', to: domY, label: 'to Y' }] })], updated: new Date().toISOString() };

  for (const url of [`http://127.0.0.1:${y.port}/`, `http://127.0.0.1:${x.port}/`, `http://127.0.0.1:${z.port}/`]) {
    const r = await fetch(DIRECTORY + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: url }) }).then((res) => res.json());
    assert(r.indexed === 1, 'expected 1 world indexed from ' + url + ', got ' + JSON.stringify(r));
  }
  const yEntry = await fetch(DIRECTORY + `/search?domain=${encodeURIComponent(domY)}`).then((r) => r.json());
  const xEntry = await fetch(DIRECTORY + `/search?domain=${encodeURIComponent(domX)}`).then((r) => r.json());
  assert(yEntry.results[0].inboundPortalCount === 2, 'expected Y to have 2 inbound domain-portals (from X and Z), got ' + yEntry.results[0].inboundPortalCount);
  assert(xEntry.results[0].inboundPortalCount === 0, 'expected X to have 0 inbound domain-portals, got ' + xEntry.results[0].inboundPortalCount);
  console.log('PASS: inbound portal counts computed correctly from the real link graph (Y=2, X=0)');
  y.server.close(); x.server.close(); z.server.close();

  console.log('STEP 3: structured filters and free-text query');
  const genreHit = await fetch(DIRECTORY + '/search?genre=marketplace').then((r) => r.json());
  assert(genreHit.results.length === 1 && genreHit.results[0].worldId === 'plaza', 'expected genre=marketplace to find exactly the plaza world');
  const scaleHit = await fetch(DIRECTORY + '/search?scale=building').then((r) => r.json());
  assert(scaleHit.results.some((w) => w.worldId === 'museum') && scaleHit.results.some((w) => w.worldId === 'workshop'), 'expected scale=building to include both museum and workshop');
  const combatHit = await fetch(DIRECTORY + '/search?combat=pvp').then((r) => r.json());
  assert(combatHit.results.length === 1 && combatHit.results[0].worldId === 'arena', 'expected combat=pvp to find exactly the arena world');
  const qHit = await fetch(DIRECTORY + '/search?q=workshop').then((r) => r.json());
  assert(qHit.results.length === 1 && qHit.results[0].worldId === 'workshop', 'expected q=workshop to find exactly the workshop world');
  const qMiss = await fetch(DIRECTORY + '/search?q=zzz-no-such-token').then((r) => r.json());
  assert(qMiss.results.length === 0, 'expected a nonsense query to return zero results, got ' + qMiss.results.length);
  console.log('PASS: genre/scale/combat filters and free-text query all narrow correctly');

  console.log('STEP 4: background scheduler re-crawls on a schedule and picks up changes');
  const mutable = await startMutableManifestServer(null);
  mutable.state.manifest = {
    spec: 'domain-atlas/1.0', domain: 'localhost:' + mutable.port, owner: { name: 'Mutable' },
    defaultWorld: 'room', worlds: [worldFixture({ profile: { genre: 'genre-alpha', scale: 'room', capabilities: { building: 'none', vehicles: false, combat: 'none', landOwnership: false } } })],
    updated: new Date().toISOString()
  };
  const snapshotPath = path.join('/tmp', 'test-directory-index-' + Date.now() + '.json');
  const child = spawn('node', [path.resolve(__dirname, '..', 'directory-server', 'server.js')], {
    env: { ...process.env, PORT: '8099', DIRECTORY_CRAWL_INTERVAL_MS: '2000', DIRECTORY_SNAPSHOT_FILE: snapshotPath },
    stdio: 'pipe'
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated directory-server did not start in time')), 8000);
    child.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
  });
  try {
    const manifestUrl = `http://127.0.0.1:${mutable.port}/`;
    const submitRes = await fetch('http://localhost:8099/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: manifestUrl }) }).then((r) => r.json());
    assert(submitRes.indexed === 1, 'expected the mutable manifest to index 1 world initially');
    const before = await fetch('http://localhost:8099/search?domain=' + encodeURIComponent('localhost:' + mutable.port)).then((r) => r.json());
    assert(before.results[0].genre === 'genre-alpha', 'expected initial genre to be genre-alpha, got ' + before.results[0].genre);

    // Change the served manifest's genre without resubmitting — only the
    // background scheduler, not this test, should pick it up.
    mutable.state.manifest.worlds[0].profile.genre = 'genre-beta';
    mutable.state.manifest.updated = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 4000)); // > CRAWL_INTERVAL_MS(2000) + a scheduler tick
    const after = await fetch('http://localhost:8099/search?domain=' + encodeURIComponent('localhost:' + mutable.port)).then((r) => r.json());
    assert(after.results[0].genre === 'genre-beta', 'expected the scheduler to have picked up the genre change to genre-beta, got ' + after.results[0].genre);
    console.log('PASS: scheduler re-crawled unattended and picked up the genre change');

    // Now flip discoverable:false — the world should disappear from the
    // index entirely on the next crawl, not just show stale data.
    mutable.state.manifest.worlds[0].policy.discoverable = false;
    await new Promise((r) => setTimeout(r, 4000));
    const afterHidden = await fetch('http://localhost:8099/search?domain=' + encodeURIComponent('localhost:' + mutable.port)).then((r) => r.json());
    assert(afterHidden.results.length === 0, 'expected the world to be removed from the index once discoverable:false, got ' + afterHidden.results.length);
    console.log('PASS: a world that turns discoverable:false is removed from the index on its next crawl');
  } finally {
    child.kill();
    mutable.server.close();
    try { fs.unlinkSync(snapshotPath); } catch {}
  }

  console.log('STEP 5: key-anchored manifest — accepted when validly signed, rejected when tampered');
  const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPub = await subtle.exportKey('raw', keyPair.publicKey);
  const identityKey = b64url(rawPub);
  const keyServer = await startMutableManifestServer(null);

  async function buildSignedManifest(name) {
    const unsigned = {
      spec: 'domain-atlas/1.0', identityKey, owner: { name: 'Key Owner', contact: 'owner@example.net' },
      defaultWorld: 'room', worlds: [worldFixture({ name, profile: { genre: 'key-anchored-test', scale: 'room', capabilities: { building: 'none', vehicles: false, combat: 'none', landOwnership: false } } })],
      updated: new Date().toISOString()
    };
    const data = new TextEncoder().encode(canonicalize(unsigned));
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, data);
    return { ...unsigned, signature: b64url(sig) };
  }

  keyServer.state.manifest = await buildSignedManifest('Key World');
  const keyUrl = `http://127.0.0.1:${keyServer.port}/`;
  const keySubmit = await fetch(DIRECTORY + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: keyUrl }) }).then((r) => r.json());
  assert(keySubmit.indexed === 1, 'expected the validly-signed key-anchored manifest to index 1 world, got ' + JSON.stringify(keySubmit));
  const keyResult = await fetch(DIRECTORY + `/search?q=${encodeURIComponent(identityKey.slice(0, 8))}`).then((r) => r.json());
  // identityKey isn't tokenized into the free-text index by design (it's not
  // name/genre/domain/worldId) — confirm instead via the domain-anchored
  // filter's sibling: fetch everything and find our world by name.
  const allResults = await fetch(DIRECTORY + '/search').then((r) => r.json());
  const found = allResults.results.find((w) => w.name === 'Key World');
  assert(found && found.anchorType === 'key', 'expected the key-anchored world to be indexed and labeled anchorType "key"');
  console.log('PASS: validly-signed key-anchored manifest accepted and correctly labeled');

  // Tamper: change the name in the SERVED manifest without re-signing.
  keyServer.state.manifest = { ...keyServer.state.manifest, worlds: [{ ...keyServer.state.manifest.worlds[0], name: 'Tampered Name' }] };
  const tamperSubmit = await fetch(DIRECTORY + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: keyUrl }) }).then((r) => r.json());
  assert(tamperSubmit.error && /signature/i.test(tamperSubmit.error), 'expected a tampered key-anchored manifest to be rejected with a signature error, got ' + JSON.stringify(tamperSubmit));
  const afterTamper = await fetch(DIRECTORY + '/search').then((r) => r.json());
  const stillThere = afterTamper.results.find((w) => w.name === 'Key World');
  const tamperedNotIndexed = afterTamper.results.find((w) => w.name === 'Tampered Name');
  assert(stillThere, 'expected the last-known-GOOD entry ("Key World") to remain indexed after a failed re-crawl, not be wiped');
  assert(!tamperedNotIndexed, 'expected the tampered content to never make it into the index at all');
  console.log('PASS: tampered key-anchored manifest rejected; prior good entry left untouched (cached, not wiped)');
  keyServer.server.close();

  console.log('\nALL DIRECTORY SERVICE CHECKS PASSED');
}

main().catch((err) => {
  console.error('FAILURE:', err);
  process.exitCode = 1;
});
