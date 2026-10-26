// Browser regression for the Lobby's character scale. scene.json's
// characterScale (0.5 for the Lobby) is authoritative: a scale the user saved
// from the settings slider (chrome.storage.local, key atlasCharacterScale)
// does not override it, and is only used in a scene that declares none.
// (manual-domain-b-gallery.js covers switching between scenes.)
//
// Checks:
//   1. A profile with no saved scale gets 0.5 in the Lobby, with nothing
//      written to storage.
//   2. A saved 1.4, or an explicitly saved 1.0, does not change the Lobby's 0.5
//      and is left in storage.
//   3. The scale does not move the camera: eye height, collision and the
//      interaction radius are the same at 0.5 and at 1.0.
//   4. The settings slider shows the scale in effect (0.5) and is locked.
//   5. A scene that declares no characterScale uses the saved preference, then 1.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8352;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-charscale-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-charscale-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-charscale-profile-'));
const SCENE_PATH = path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json');
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps = 0.011) => Math.abs(a - b) < eps;

const scaleInfo = (frame) => frame.evaluate(() => {
  const w = window.__atlasActive3D;
  return { scale: w.getCharacterScale(), scene: w.getSceneCharacterScale(), owned: w.isCharacterScaleSceneOwned(), override: w.hasCharacterScaleOverride() };
});
const stored = (frame) => frame.evaluate(async () => (await chrome.storage.local.get('atlasCharacterScale')).atlasCharacterScale);
const setStored = (frame, v) => frame.evaluate(async (value) => {
  if (value === undefined) await chrome.storage.local.remove('atlasCharacterScale');
  else await chrome.storage.local.set({ atlasCharacterScale: value });
}, v);
async function enterLobby(frame) {
  await frame.evaluate(() => loadManifest(currentManifestUrl, 'lobby', null));
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 30000 });
  await frame.evaluate(() => window.__atlasActive3D.ready);
  await sleep(500);
}
// Collision, eye height and interaction range at the current scale, probed at fixed points.
async function probe(frame, crate) {
  return frame.evaluate(async ([cx, cz]) => {
    const w = window.__atlasActive3D;
    const c = w.camera;
    const out = { eye: c.pos[1], blocked: {}, nearby: {} };
    for (const [k, x, z] of [['deskEdge', -0.45, -4.6], ['insideDesk', -0.45, -4.84], ['open', -0.45, -3.8]]) out.blocked[k] = w.isPositionBlocked(x, z);
    for (const d of [1.6, 1.8]) {
      c.pos[0] = cx; c.pos[2] = cz + d; c.yaw = Math.PI; c.pitch = 0;
      await new Promise((r) => setTimeout(r, 400));
      out.nearby[d] = w.getNearbyInteractMarkers().some((m) => Math.abs(m.position[0] - cx) < 1e-6 && Math.abs(m.position[2] - cz) < 1e-6);
    }
    return out;
  }, crate);
}

(async () => {
  console.log('SETUP: isolated copy of demo-domain-a');
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const scene = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8'));
  assert(scene.characterScale === 0.5, 'Expected the Lobby scene to declare characterScale 0.5, got ' + scene.characterScale);
  const crate = [scene.interactables[0].position[0], scene.interactables[0].position[2]];

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

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
    });
    const page = await context.newPage();
    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });

    console.log('STEP 1: no saved scale -> the scene value 0.5');
    assert(await stored(frame) === undefined, 'Expected no saved character scale on a fresh profile');
    assert(await frame.evaluate(() => AtlasWallet.getSavedCharacterScale()) === null, 'Expected getSavedCharacterScale() to be null when nothing was saved');
    await enterLobby(frame);
    let info = await scaleInfo(frame);
    assert(info.scale === 0.5 && info.scene === 0.5 && info.owned === true && info.override === false, 'Expected scale 0.5 owned by the scene, got ' + JSON.stringify(info));
    assert(await stored(frame) === undefined, 'Entering the Lobby must not write the scene value into storage');
    console.log('PASS: Lobby is 0.5, scene-owned, nothing stored');

    console.log('STEP 2: a saved scale does not override the scene value, and is kept');
    for (const saved of [1.4, 1]) {
      await setStored(frame, saved);
      await enterLobby(frame);
      info = await scaleInfo(frame);
      assert(info.scale === 0.5 && info.owned === true && info.override === false, 'Expected the Lobby to stay at 0.5 with ' + saved + ' saved, got ' + JSON.stringify(info));
      assert(await stored(frame) === saved, 'The saved ' + saved + ' must be left in storage');
    }
    await setStored(frame, undefined);
    console.log('PASS: saved 1.4 and saved 1.0 both leave the Lobby at 0.5');

    console.log('STEP 3: eye height, collision and interaction range do not depend on the scale');
    await enterLobby(frame);
    const at05 = await probe(frame, crate);
    assert(near(at05.eye, 1.6), 'Expected eye height 1.6 at scale 0.5, got ' + at05.eye);
    assert(at05.blocked.deskEdge && at05.blocked.insideDesk && !at05.blocked.open, 'Expected the reception desk to block and open floor not to, got ' + JSON.stringify(at05.blocked));
    assert(at05.nearby[1.6] === true && at05.nearby[1.8] === false, 'Expected the crate prompt inside 1.7 and not beyond, got ' + JSON.stringify(at05.nearby));
    const plain = JSON.parse(JSON.stringify(scene)); delete plain.characterScale;
    fs.writeFileSync(SCENE_PATH, JSON.stringify(plain, null, 2));
    await enterLobby(frame);
    info = await scaleInfo(frame);
    assert(info.scale === 1 && info.owned === false, 'Expected 1 for a scene that declares none, got ' + JSON.stringify(info));
    const at1 = await probe(frame, crate);
    assert(JSON.stringify(at1) === JSON.stringify(at05), 'Expected identical eye height, collision and interaction range at 1.0 and 0.5, got ' + JSON.stringify(at1) + ' vs ' + JSON.stringify(at05));
    console.log('PASS: camera height, collision and interaction radius are identical at 0.5 and 1.0');

    console.log('STEP 4: a scene without characterScale uses the saved preference');
    await setStored(frame, 1.4);
    await enterLobby(frame);
    info = await scaleInfo(frame);
    assert(near(info.scale, 1.4) && info.owned === false && info.override === true, 'Expected the saved 1.4 when the scene declares none, got ' + JSON.stringify(info));
    await setStored(frame, undefined);
    await enterLobby(frame);
    info = await scaleInfo(frame);
    assert(info.scale === 1 && info.override === false, 'Expected 1 with nothing saved, got ' + JSON.stringify(info));
    console.log('PASS: saved 1.4 applies in a scene without characterScale; 1 when nothing is saved');

    console.log('STEP 5: the settings slider shows the scale in effect and is locked while the scene owns it');
    fs.writeFileSync(SCENE_PATH, JSON.stringify(scene, null, 2));
    await enterLobby(frame);
    await frame.evaluate(() => openSettings());
    await sleep(300);
    const slider = await frame.evaluate(() => ({ value: document.getElementById('characterScaleInput').value, label: document.getElementById('characterScaleValue').textContent, disabled: document.getElementById('characterScaleInput').disabled }));
    assert(near(parseFloat(slider.value), 0.5) && slider.label.startsWith('0.5') && slider.disabled === true, 'Expected the slider to show 0.5 and be locked, got ' + JSON.stringify(slider));
    console.log('PASS: slider shows 0.5 (' + slider.label + ') and is disabled');

    console.log('\nALL CHARACTER SCALE DEFAULT CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) {} }
  }
})();
