// Manual check for the Class-wide patch form's own pre-fill behavior
// (issuer-server/admin-panel/index.html's classPatchClass 'input'
// listener, and the POST /atlas/admin/asset-classes fields it reads).
//
// Reported live: the properties/tradeScope fields started out blank no
// matter which class was picked, so setting a patch meant typing it
// against nothing — no way to see what a class's properties actually are
// before overwriting them, an easy way to misspell a key or wipe out a
// fact by accident. The fix: picking a class now pre-fills both fields
// with what its credentials actually look like right now (the catalog's
// own base properties/tradeScope, with any already-active class patch
// merged on top, since that's the fact actually in force once one
// exists) — editing means changing only what's different, not guessing
// blind.
//
// This drives the real admin panel PAGE directly rather than through the
// wallet extension's button/handoff (manual-admin-panel.js already proves
// that plumbing end to end) — it's the page's own JS this change touches,
// so a real admin session token dropped straight into sessionStorage (the
// exact shape content.js's handoff already writes there) is enough to
// reach it. Node backend only: the page served is byte-identical between
// issuer-server and issuer-php, and the /atlas/admin/asset-classes data
// contract itself is already checked on both backends by test/manual-
// class-wide-reissue.js — this test's job is what the browser does with
// that data, which doesn't depend on which backend produced it.
//
// Checks:
//   1. Picking a class with an existing class patch (atlas.trophy.chess,
//      patched to change com.example.awardedFor) pre-fills the properties
//      box with the ORIGINAL catalog properties AND the patched fact
//      together (the merge), and tradeScope with the class's own default
//      (local, since this class's patch never touched tradeScope).
//   2. Picking a different, never-patched class (atlas.wearable, a BOUND
//      class) pre-fills straight from the plain catalog entry: its own
//      properties, and tradeScope: bound.
//   3. Picking a class whose real values are rolled per-instance at mint
//      time (atlas.wearable.ring, randomizeProperties) shows the
//      random-stats caveat note; switching to a non-randomized class
//      hides it again.
//   4. Picking a class whose active patch already deletes a property
//      (atlas.badge, com.example.season set to null — see test/manual-
//      properties-patch-delete.js for the deletion mechanism itself)
//      shows that property as a literal null in the pre-fill, not
//      silently omitted, so the operator can actually see a deletion is
//      in effect; an untouched property on the same class still
//      pre-fills normally alongside it.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8121; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-class-patch-prefill-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-class-patch-prefill-docroot-'));

function postJson(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Same canonicalize() shape as extension/wallet.js and issuer-server/
// server.js's own crypto helpers — sorted-key JSON, no whitespace.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { kp, publicKey: b64url(raw) };
}
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
// Same nonce/sign/start flow the admin panel itself runs on a real login —
// used here only to obtain a real, server-valid token to hand the page.
async function login(admin) {
  const nonce = (await fetch(NODE_BASE + '/atlas/admin/session/nonce').then((r) => r.json())).nonce;
  const payload = { nonce };
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  const res = await postJson(NODE_BASE, '/atlas/admin/session/start', { payload, proof });
  if (res.status !== 200) throw new Error('login failed: ' + JSON.stringify(res));
  return res.body;
}

(async () => {
  console.log('SETUP: starting an isolated issuer-server instance on port ' + NODE_PORT);
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(NODE_PORT),
      ATLAS_DOMAIN: NODE_DOMAIN,
      ATLAS_STATE_DIR: NODE_STATE_DIR,
      ATLAS_DOCROOT: NODE_DOCROOT_DIR
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + NODE_PORT);

  console.log('SETUP: seeding an admin identity and two pre-existing class patches (a plain one on the trophy, a delete-a-property one on the badge)');
  const admin = await genIdentity();
  fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
  const patchPayload = { assetClass: 'atlas.trophy.chess', properties: { 'com.example.awardedFor': 'Season 2 Champion' } };
  const patchProof = await signWithSelf(admin.kp, admin.publicKey, patchPayload);
  const patchRes = await postJson(NODE_BASE, '/atlas/admin/class-patch', { payload: patchPayload, proof: patchProof });
  assert(patchRes.status === 200, 'expected seeding the class patch to succeed, got: ' + JSON.stringify(patchRes));
  // A property deleted via a class patch (mergeProperties()'s null marker
  // — see test/manual-properties-patch-delete.js for the mechanism itself)
  // has to show up in the pre-fill as a literal null, not be silently
  // dropped from what the operator sees — otherwise they'd have no way to
  // tell a deletion is already in effect for this class. A DIFFERENT
  // class from every other step here (atlas.badge, untouched elsewhere in
  // this file) so it doesn't interfere with step 2's "never patched"
  // premise for atlas.wearable.
  const deletePatchPayload = { assetClass: 'atlas.badge', properties: { 'com.example.season': null } };
  const deletePatchProof = await signWithSelf(admin.kp, admin.publicKey, deletePatchPayload);
  const deletePatchRes = await postJson(NODE_BASE, '/atlas/admin/class-patch', { payload: deletePatchPayload, proof: deletePatchProof });
  assert(deletePatchRes.status === 200, 'expected seeding the delete-property class patch to succeed, got: ' + JSON.stringify(deletePatchRes));
  const { token, expiresAt } = await login(admin);
  console.log('PASS: admin seeded, both class patches set, session token obtained');

  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
    const page = await browser.newPage();
    // Same shape content.js's real handoff writes — this page never
    // creates its own session, only ever reads one back out.
    await page.addInitScript(([sessionToken, sessionExpiresAt]) => {
      sessionStorage.setItem('atlasAdminSession', JSON.stringify({ token: sessionToken, expiresAt: sessionExpiresAt }));
    }, [token, expiresAt]);
    await page.goto(NODE_BASE + '/atlas-admin/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('classPatchClass') && getComputedStyle(document.getElementById('hidden-while-logged-out')).display !== 'none', { timeout: 10000 });
    // Both refreshes the page kicks off on login (class list, active
    // patches) are fire-and-forget — wait for their real effects rather
    // than racing ahead of them.
    await page.waitForFunction(() => document.querySelectorAll('#classPatchClassOptions option').length > 0, { timeout: 5000 });
    await page.waitForFunction(() => document.getElementById('classPatchCurrent').textContent.includes('atlas.trophy.chess') && document.getElementById('classPatchCurrent').textContent.includes('atlas.badge'), { timeout: 5000 });

    console.log('STEP 1: a class with an existing patch pre-fills the ORIGINAL catalog properties merged with the patched fact, and its own default tradeScope');
    await page.locator('#classPatchClass').fill('atlas.trophy.chess');
    const trophyProperties = JSON.parse(await page.locator('#classPatchProperties').inputValue());
    assert(trophyProperties['atlas.rarity'] === 'rare', 'expected the untouched catalog property to be pre-filled, got: ' + JSON.stringify(trophyProperties));
    assert(trophyProperties['com.example.awardedFor'] === 'Season 2 Champion', 'expected the active patch\'s fact to be pre-filled (merged over the catalog default), got: ' + JSON.stringify(trophyProperties));
    const trophyTradeScope = await page.locator('#classPatchTradeScope').inputValue();
    assert(trophyTradeScope === 'local', 'expected this class\'s own default tradeScope (never patched) to be pre-filled, got: ' + trophyTradeScope);
    const trophyNoteVisible = await page.locator('#classPatchRandomNote').isVisible();
    assert(!trophyNoteVisible, 'expected no random-stats caveat for a non-randomized class');
    console.log('PASS: properties pre-fill merges the catalog default with the active patch; tradeScope shows the class\'s own default');

    console.log('STEP 2: a never-patched, BOUND class pre-fills straight from the plain catalog entry');
    await page.locator('#classPatchClass').fill('atlas.wearable');
    const compassProperties = JSON.parse(await page.locator('#classPatchProperties').inputValue());
    assert(compassProperties['com.example.material'] === 'brass' && compassProperties['com.example.era'] === 'Victorian', 'expected the Bronze Compass\'s own catalog properties to be pre-filled, got: ' + JSON.stringify(compassProperties));
    const compassTradeScope = await page.locator('#classPatchTradeScope').inputValue();
    assert(compassTradeScope === 'bound', 'expected the BOUND class\'s own tradeScope to be pre-filled (the whole point — a bound class is still a valid patch target), got: ' + compassTradeScope);
    console.log('PASS: an unpatched bound class pre-fills correctly too, not just tradeable ones');

    console.log('STEP 3: a class with per-instance randomized stats shows the caveat note; switching away hides it again');
    await page.locator('#classPatchClass').fill('atlas.wearable.ring');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('classPatchRandomNote')).display !== 'none', { timeout: 3000 });
    console.log('PASS: the randomized-class caveat shows for the Signet Ring');
    await page.locator('#classPatchClass').fill('atlas.trophy.chess');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('classPatchRandomNote')).display === 'none', { timeout: 3000 });
    console.log('PASS: the caveat hides again once a non-randomized class is picked');

    console.log('STEP 4: a class with a property already deleted via its active patch shows the deletion as a literal null, not omitted');
    await page.locator('#classPatchClass').fill('atlas.badge');
    const badgeProperties = JSON.parse(await page.locator('#classPatchProperties').inputValue());
    assert('com.example.season' in badgeProperties && badgeProperties['com.example.season'] === null, 'expected the deleted property to show up as a literal null so the operator can see the deletion is active, got: ' + JSON.stringify(badgeProperties));
    assert(badgeProperties['com.example.issuedFor'] === 'Plaza visit', 'expected an untouched property to still pre-fill normally alongside the deletion marker, got: ' + JSON.stringify(badgeProperties));
    console.log('PASS: an active property deletion shows as null in the pre-fill, not silently hidden');

    console.log('\nALL CLASS-PATCH PRE-FILL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    nodeProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
