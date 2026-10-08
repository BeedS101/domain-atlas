// Coverage for the one narrower gap README.md tracked after SPEC.md §3.5
// landed: the 3D gltf-mini-v1 renderer had no distinct visual of its own
// for a key-anchored portal (§3.6) — only the 2D procedural-v1 renderer
// did. gltf-mini.js's buildPortalRing/buildPortalBeacon now take a
// three-way kind ('same-domain'/'cross-domain'/'key') instead of a
// same-domain/cross-domain boolean, matching the 2D renderer's own
// portalPalette() exactly, and a new debug/test hook,
// getPortalTriggerKind(), reads the real resolved kind for a given
// portalIndex the same way every other gltf-mini.js test hook reads real
// internal state instead of rendered pixels.
//
// The actual demo-domain-a Lobby does NOT carry a key-anchored portal of
// its own — one was tried and pulled back out, since a portal sitting in
// the middle of the room read as clutter with no real narrative reason to
// be there (Plaza's own 2D key-anchored portal already demos the concept
// for visitors). So this test builds its own throwaway copy of
// demo-domain-a instead, with a second Lobby portal added ONLY to that
// isolated copy's own spatial.json/scene.json — same "copy demo-domain-a
// into an isolated docroot" pattern manual-warranty-demo.js and its
// siblings already use — so the real 3D rendering code still gets
// exercised end to end without permanently living in the shared demo
// content.
//
// Checks:
//   1. Both Lobby portals resolve to the right kind: index 0 (world, same
//      domain) -> 'same-domain', index 1 (key, injected for this test) ->
//      'key'.
//   2. Regression: walking into the ordinary same-domain portal's radius
//      still auto-enters Plaza with no disclosure of any kind — the kind
//      rework didn't touch that path's behavior, only its color.
//   3. Walking into the key-anchored portal's radius fetches+verifies the
//      manifest and opens the mandatory disclosure — the Lobby is NOT left
//      yet, same "before ever rendering one" requirement §3.6.1 already
//      enforces for the 2D renderer.
//   4. "Stay here" closes the disclosure with no world change.
//   5. Walking out of the trigger radius and back in re-opens the
//      disclosure (the walk-in trigger has its own cooldown, distinct from
//      a 2D click's re-click).
//   6. "Enter anyway" actually enters — no domain shown, persistent amber
//      badge, exactly as the 2D entry path already does.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8150; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-key-portal-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-key-portal-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-key-portal-profile-'));

const KEYWORLD_MANIFEST_PATH = path.join(DOCROOT_DIR, 'keyworld', 'spatial.json');
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
const LOBBY_SCENE_PATH = path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json');

function placeLabelText(frame) {
  return frame.evaluate(() => document.getElementById('placeLabel').textContent);
}
function keyAnchorModalActive(frame) {
  return frame.evaluate(() => document.getElementById('keyAnchorModal').classList.contains('active'));
}
function keyAnchorBadgePresent(frame) {
  return frame.evaluate(() => !!document.querySelector('#placeLabel .keyAnchorBadge'));
}
async function waitFor(frame, fn, description, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    if (await frame.evaluate(fn)) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
}
// Same "write camera.pos directly, no WASD simulation needed" convention
// gltf-mini.js's own getCharacterYaw/getInteractPrompt comments already
// establish — the portal proximity check reads camera.pos every frame
// regardless of how it got there.
async function teleportTo(frame, position) {
  await frame.evaluate((p) => { window.__atlasActive3D.camera.pos[0] = p[0]; window.__atlasActive3D.camera.pos[1] = p[1]; window.__atlasActive3D.camera.pos[2] = p[2]; }, position);
}

(async () => {
  console.log('SETUP: copying demo-domain-a into an isolated docroot and adding a Lobby key-anchored portal only there');
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const realIdentityKey = JSON.parse(fs.readFileSync(KEYWORLD_MANIFEST_PATH, 'utf8')).identityKey;

  const mainManifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  mainManifest.domain = DOMAIN; // keep the manifest's own declared domain honest for this isolated port
  const lobbyWorld = mainManifest.worlds.find((w) => w.id === 'lobby');
  lobbyWorld.portals.push({
    kind: 'key',
    identityKey: realIdentityKey,
    manifest: 'http://' + DOMAIN + '/keyworld/spatial.json',
    label: 'Step into the Unlisted Atrium'
  });
  fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(mainManifest, null, 2));

  const lobbyScene = JSON.parse(fs.readFileSync(LOBBY_SCENE_PATH, 'utf8'));
  lobbyScene.portalMarkers.push({ position: [1.6, 0, -0.2], radius: 0.8, portalIndex: 1 });
  fs.writeFileSync(LOBBY_SCENE_PATH, JSON.stringify(lobbyScene, null, 2));

  console.log('SETUP: starting a throwaway issuer-server instance on port ' + PORT + ' (isolated docroot, isolated state dir)');
  const serverProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + PORT + ', serving the isolated demo-domain-a copy');

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      executablePath: '/opt/pw-browsers/chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
    });
    const page = await context.newPage();
    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });

    console.log('SETUP: entering the Lobby directly (same loadManifest() path a Lobby portal click already uses)');
    await frame.evaluate(() => loadManifest(currentManifestUrl, 'lobby', null));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 15000 });

    console.log('STEP 1: both Lobby portals resolve to the right kind');
    const kind0 = await frame.evaluate(() => window.__atlasActive3D.getPortalTriggerKind(0));
    const kind1 = await frame.evaluate(() => window.__atlasActive3D.getPortalTriggerKind(1));
    if (kind0 !== 'same-domain') throw new Error('Expected portal 0 (Back to the Plaza) to resolve to "same-domain", got: ' + kind0);
    if (kind1 !== 'key') throw new Error('Expected portal 1 (the test-injected Unlisted Atrium portal) to resolve to "key", got: ' + kind1);
    console.log('PASS: portal 0 -> same-domain, portal 1 -> key');

    console.log('STEP 2 (regression): walking into the ordinary same-domain portal still auto-enters Plaza, no disclosure');
    await teleportTo(frame, [0.3, 1.6, 3.9]); // inside portal 0's radius ([0,0,4.2], radius 0.8)
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    if (await keyAnchorModalActive(frame)) throw new Error('Expected no disclosure at all for an ordinary same-domain portal');
    console.log('PASS: ordinary walk-in portal still enters directly, unaffected by the kind rework');

    console.log('SETUP: back into the Lobby for the key-anchored portal checks');
    await frame.evaluate(() => loadManifest(currentManifestUrl, 'lobby', null));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 15000 });

    console.log('STEP 3: walking into the key-anchored portal fetches+verifies the manifest and opens the mandatory disclosure — the Lobby is not left yet');
    await teleportTo(frame, [1.6, 1.6, -0.2]); // inside portal 1's radius ([1.6,0,-0.2], radius 0.8)
    await waitFor(frame, () => document.getElementById('keyAnchorModal').classList.contains('active'), 'the key-anchored disclosure modal to open');
    if (!(await placeLabelText(frame)).includes('Example Lobby')) throw new Error('Expected to still be in the Lobby while the disclosure is open');
    const fingerprint = await frame.evaluate(() => document.getElementById('keyAnchorFingerprint').textContent);
    if (fingerprint !== realIdentityKey) throw new Error('Expected the disclosure to show the real identityKey, got: ' + fingerprint);
    console.log('PASS: walking into a 3D key-anchored portal opens the same real disclosure as the 2D path, before entering anything');

    console.log('STEP 4: "Stay here" closes the disclosure with no world change');
    await frame.locator('#keyAnchorStayBtn').click();
    await waitFor(frame, () => !document.getElementById('keyAnchorModal').classList.contains('active'), 'the disclosure to close after Stay');
    if (!(await placeLabelText(frame)).includes('Example Lobby')) throw new Error('Expected to still be in the Lobby after Stay here');
    if (await keyAnchorBadgePresent(frame)) throw new Error('Expected no key-anchor badge while still in the Lobby');
    console.log('PASS: Stay here leaves the visitor exactly where they were');

    console.log('STEP 5: walking out of the trigger radius and back in re-opens the disclosure');
    await teleportTo(frame, [0, 1.6, 0]); // well outside portal 1's radius — clears the walk-in cooldown
    await new Promise((r) => setTimeout(r, 300));
    await teleportTo(frame, [1.6, 1.6, -0.2]); // back inside
    await waitFor(frame, () => document.getElementById('keyAnchorModal').classList.contains('active'), 'the disclosure to reopen after leaving and re-entering the trigger radius');
    console.log('PASS: the walk-in trigger re-fires once you actually leave and re-enter its radius');

    console.log('STEP 6: "Enter anyway" actually enters — no domain shown, persistent amber badge');
    await frame.locator('#keyAnchorEnterBtn').click();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Unlisted Atrium'), null, { timeout: 10000 });
    if (await keyAnchorModalActive(frame)) throw new Error('Expected the disclosure to be closed once inside');
    const label = await placeLabelText(frame);
    if (label.includes('localhost')) throw new Error('Expected NO domain string anywhere in the place label, got: ' + label);
    if (!(await keyAnchorBadgePresent(frame))) throw new Error('Expected the persistent amber key-anchor badge while standing in the key-anchored world');
    console.log('PASS: entered the key-anchored world from the 3D Lobby with no domain shown and the persistent badge visible');

    console.log('\nALL 3D KEY-ANCHORED PORTAL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
