// Real-browser check of the Bronze Compass demonstration: the actual extension, the demo domain's own plaza and
// lobby scenes and manifest, and a real PHP issuer (isolated copy, using the catalog as shipped). Run with a
// display, for example
//   xvfb-run -a node test/manual-compass-demo.js
//
// Proves: (1) the plaza Compass Stall hands out a newly issued, standard-conforming compass (trinket slot,
// atlas.cap.compass, signed spec digest) without touching the older Bronze Compass class; (2) equipped in either
// trinket slot it shows a compass HUD in the 3D lobby, with all eight points, that turns with the character's
// actual facing; (3) the HUD is hidden when the compass is unequipped, in a 2D world, in a 3D world whose policy
// does not enable the capability, and after a portal to another domain, and comes back when returning;
// (4) existing hat buffs and equipment are unaffected.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioLab } = require('./studio-lab');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-demo-profile-'));
const SHOT_DIR = process.env.COMPASS_SHOT_DIR || null;

function assertTrue(cond, msg) { if (!cond) throw new Error(msg); }

const CLASS = 'atlas.tool.bronze_compass';
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

(async () => {
  const lab = await StudioLab.start({ mint: true, config: { mintsPerIpPerHour: 100, challengesPerIpPerHour: 100 } });

  // The demo domain's worlds, models and manifest, served by the isolated issuer.
  const A = path.join(REPO, 'demo-domain-a');
  const B = path.join(REPO, 'demo-domain-b');
  for (const root of [A, B]) for (const dir of ['spatial', 'assets']) fs.cpSync(path.join(root, dir), path.join(lab.docroot, dir), { recursive: true, force: true });
  fs.copyFileSync(path.join(A, 'index.html'), path.join(lab.docroot, 'index.html'));
  fs.copyFileSync(path.join(A, 'favicon.svg'), path.join(lab.docroot, 'favicon.svg'));
  const manifest = JSON.parse(fs.readFileSync(path.join(A, '.well-known', 'spatial.json'), 'utf8'));
  manifest.domain = lab.host;
  for (const w of manifest.worlds) w.portals = (w.portals || []).filter((p) => p.kind === 'world');
  const lobby = manifest.worlds.find((w) => w.id === 'lobby');
  assertTrue(lobby.policy.itemEffects && lobby.policy.itemEffects.capabilities.includes('atlas.cap.compass'), 'the shipped lobby policy enables the compass capability');
  // A second 3D world in this domain that does not enable the capability.
  const nofx = JSON.parse(JSON.stringify(lobby));
  nofx.id = 'lobby-nofx';
  nofx.name = 'Lobby Without Effects';
  delete nofx.policy.itemEffects;
  nofx.portals = [];
  manifest.worlds.push(nofx);
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(manifest, null, 2));

  // The other domain: the shipped gallery world, which declares no itemEffects.
  const other = JSON.parse(fs.readFileSync(path.join(B, '.well-known', 'spatial.json'), 'utf8'));
  other.domain = 'second.example.test';
  other.defaultWorld = 'gallery';
  other.worlds = other.worlds.filter((w) => w.id === 'gallery');
  other.worlds[0].portals = [];
  assertTrue(!other.worlds[0].policy.itemEffects && !other.itemEffects, 'the other domain declares no itemEffects');
  fs.mkdirSync(path.join(lab.docroot, 'second', '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, 'second', '.well-known', 'spatial.json'), JSON.stringify(other, null, 2));
  console.log('SETUP: issuer with the demo plaza and lobby on ' + lab.origin);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, executablePath: '/opt/pw-browsers/chromium',
    args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
    viewport: { width: 1280, height: 800 },
  });
  let ok = false;
  await context.route('https://' + lab.host + '/**', async (route) => {
    const res = await route.fetch({ url: route.request().url().replace(/^https:/, 'http:') });
    await route.fulfill({ response: res, headers: { ...res.headers(), 'access-control-allow-origin': '*' } });
  });
  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;

    console.log('STEP 1: creating a real wallet identity');
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 40000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('compass-demo-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('compass-demo-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const identity = await walletPage.evaluate(async () => { const i = await AtlasWallet.getIdentity(); return i ? { publicKey: i.publicKey } : null; });
    assertTrue(identity && identity.publicKey, 'identity created');
    console.log('PASS: identity ' + identity.publicKey.slice(0, 12) + '…');

    // An ordinary hat from the lobby's own class list, to prove existing buffs are untouched.
    const hat = await lab.postRaw('/atlas/asset/issue', { ownerPublicKey: identity.publicKey, assetClass: 'atlas.avatar.hat.sunhat' });
    assertTrue(hat.status === 200, 'issue legacy hat: ' + hat.text);
    const hatSpeed = Number(hat.json.asset.properties['atlas.avatar.hatSpeedMultiplier']);
    assertTrue(hatSpeed > 0, 'the hat has a speed multiplier');
    const hatId = await walletPage.evaluate(async ({ o, origin, cred }) => { const e = await AtlasWallet.queueBridgeOffer(o, origin, cred); await AtlasWallet.claimBridgeOffer(o, e.id); return cred.id; }, { o: identity.publicKey, origin: lab.origin, cred: hat.json });

    console.log('STEP 2: entering the plaza and collecting the compass from the Compass Stall');
    const site = await context.newPage();
    site.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
    await site.goto(lab.origin + '/', { waitUntil: 'load' });
    await site.locator('#domain-atlas-enter-btn').click();
    const overlay = await site.waitForSelector('#domain-atlas-overlay', { timeout: 40000 });
    const frame = await overlay.contentFrame();
    frame.on('pageerror', (e) => console.log('FRAMEERROR', String(e)));
    site.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Plaza'), null, { timeout: 40000 });
    const stall = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        if (scene && scene.interactables && scene.interactables.length) {
          const canvas = document.getElementById('scene');
          const m = scene.interactables.find((i) => i.label === 'Bronze Compass');
          const p = project(m.position[0], m.position[1] || 0, m.position[2], canvas.width / 2, canvas.height / 2 + 40);
          resolve({ sx: p.x, sy: p.y - 16, cls: m.class });
        } else requestAnimationFrame(check);
      };
      check();
    }));
    assertTrue(stall.cls === CLASS, 'the stall issues ' + CLASS + ', not the older wearable: ' + stall.cls);
    await site.mouse.move(5, 5);
    await frame.locator('#scene').click({ position: { x: stall.sx, y: stall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent === 'Collected Bronze Compass.', null, { timeout: 15000 });
    await frame.locator('#scene').click({ position: { x: stall.sx, y: stall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Already collected'), null, { timeout: 15000 });
    const held = await walletPage.evaluate(async (o) => (await AtlasWallet.getWallet(o)).filter((e) => e.credential.asset.class === 'atlas.tool.bronze_compass').map((e) => ({ id: e.credential.id, props: e.credential.asset.properties, name: e.credential.asset.name, slots: AtlasWallet.avatarSlotsOfAsset(e.credential.asset) })), identity.publicKey);
    assertTrue(held.length === 1, 'exactly one standard compass was collected');
    const props = held[0].props;
    assertTrue(props['atlas.item.standard'] === '0.1' && props['atlas.item.category'] === 'tool' && props['atlas.avatar.slot'] === 'trinket' && JSON.stringify(props['atlas.item.capabilities']) === JSON.stringify(['atlas.cap.compass']) && /^[0-9a-f]{64}$/.test(props['atlas.item.specDigest']), 'signed standard properties: ' + JSON.stringify(props));
    assertTrue(JSON.stringify(held[0].slots) === JSON.stringify(['trinket1', 'trinket2']), 'it fits either trinket slot: ' + JSON.stringify(held[0].slots));
    assertTrue(held[0].name !== 'Bronze Compass', 'it is named apart from the older compass: ' + held[0].name);
    const compassId = held[0].id;
    console.log('PASS: collected "' + held[0].name + '", a second click is refused as already collected');

    await frame.evaluate(() => { window.__fxEvents = 0; window.addEventListener('atlas-item-effects-changed', () => { window.__fxEvents += 1; }); });
    const equip = (fn, ...args) => walletPage.evaluate(async ({ fn, args }) => AtlasWallet[fn](...args), { fn, args });
    const hud = () => frame.evaluate(() => {
      const el = document.getElementById('atlasCompassHud');
      if (!el) return { exists: false, visible: false };
      const cs = getComputedStyle(el);
      const labels = Array.from(el.querySelectorAll('.ch-pt')).map((n) => n.dataset.point);
      return { exists: true, visible: cs.display !== 'none' && el.classList.contains('active'), heading: Number(el.dataset.heading), facing: el.dataset.facing, labels, top: Array.from(el.querySelectorAll('.ch-pt.front')).map((n) => n.dataset.point) };
    });
    const waitHud = async (visible) => {
      try {
        await frame.waitForFunction((v) => { const el = document.getElementById('atlasCompassHud'); return !!(el && el.classList.contains('active')) === v; }, visible, { timeout: 20000 });
      } catch (err) {
        const diag = await frame.evaluate(async () => ({ events: window.__fxEvents, hudActive: !!document.querySelector('#atlasCompassHud.active'), reapplyError: await reapplyEquipment().then(() => null, (e) => String(e && e.stack || e)), caps: Object.keys(await AtlasCapabilities.active()), slots: await AtlasWallet.getAvatarSlotIds(), world: currentWorld && currentWorld.id, has3D: !!active3D }));
        throw new Error('HUD did not become ' + (visible ? 'visible' : 'hidden') + ': ' + JSON.stringify(diag));
      }
    };
    const caps = () => frame.evaluate(async () => { const c = await AtlasCapabilities.active(); return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.map((p) => p.slot + ':' + p.source)])); });
    const enter = async (worldId, name) => {
      await frame.evaluate(() => { window.__prev3D = window.__atlasActive3D || null; });
      await frame.evaluate((id) => followPortal({ kind: 'world', to: id }), worldId);
      await frame.waitForFunction((n) => document.getElementById('placeLabel').textContent.includes(n), name, { timeout: 40000 });
      await frame.waitForFunction(() => window.__atlasActive3D && window.__atlasActive3D !== window.__prev3D, null, { timeout: 60000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
    };

    console.log('STEP 3: equipped in the plaza (a 2D world with no item effects), the HUD stays hidden');
    await equip('setAvatarHat', hatId);
    await equip('setAvatarSlot', 'trinket1', compassId);
    await frame.evaluate(() => reapplyEquipment());
    await new Promise((r) => setTimeout(r, 500));
    assertTrue(!(await hud()).visible, 'no HUD in the plaza');
    assertTrue(Object.keys(await caps()).length === 0, 'and no capability is active there');
    console.log('PASS: hidden in the plaza');

    console.log('STEP 4: entering the 3D lobby with the compass in trinket 1');
    await enter('lobby', 'Lobby');
    await waitHud(true);
    let h = await hud();
    assertTrue(JSON.stringify(h.labels) === JSON.stringify(POINTS), 'the HUD shows all eight points in order: ' + JSON.stringify(h.labels));
    assertTrue(JSON.stringify(await caps()) === JSON.stringify({ 'atlas.cap.compass': ['trinket1:equipped'] }), 'the capability is active from trinket 1: ' + JSON.stringify(await caps()));
    const live = await frame.evaluate(() => window.__atlasActive3D.getLocalAvatarHatSpeedMultiplier());
    assertTrue(Math.abs(live - hatSpeed) < 1e-6, 'the existing hat speed buff still applies in the lobby: ' + live + ' vs ' + hatSpeed);
    console.log('PASS: HUD visible, capability from trinket1, hat buff ' + live + ' retained');

    console.log('STEP 5: the HUD follows the character\'s actual facing in all eight directions');
    await frame.locator('#scene3d').focus();
    const facing = () => frame.evaluate(() => {
      const d = window.__atlasActive3D.getCharacterFacingWorldDir();
      return { dir: d, yaw: window.__atlasActive3D.getCharacterYaw() };
    });
    const walk = async (keys, expectPoint, expectHeading) => {
      // Back to the middle of the room first, so walking never reaches a wall or the lobby's portal.
      await frame.evaluate(() => { const c = window.__atlasActive3D.camera.pos; c[0] = 0.5; c[2] = 0.5; });
      for (const k of keys) await site.keyboard.down(k);
      await frame.waitForFunction((p) => { const el = document.getElementById('atlasCompassHud'); return el && el.dataset.facing === p; }, expectPoint, { timeout: 8000 });
      const state = await hud();
      const f = await facing();
      for (const k of keys.slice().reverse()) await site.keyboard.up(k);
      const expectedFromRender = (Math.atan2(f.dir[0], -f.dir[1]) * 180 / Math.PI + 360) % 360;
      assertTrue(Math.abs(((state.heading - expectedFromRender + 540) % 360) - 180) <= 1.5, expectPoint + ': HUD heading ' + state.heading + ' matches the rendered facing ' + expectedFromRender.toFixed(1));
      assertTrue(Math.abs(((state.heading - expectHeading + 540) % 360) - 180) <= 1.5, expectPoint + ': heading ' + state.heading + ' is ' + expectHeading);
      assertTrue(state.facing === expectPoint, 'facing label ' + state.facing + ' is ' + expectPoint);
      return state;
    };
    const cases = [
      [['KeyW'], 'N', 0], [['KeyW', 'KeyD'], 'NE', 45], [['KeyD'], 'E', 90], [['KeyS', 'KeyD'], 'SE', 135],
      [['KeyS'], 'S', 180], [['KeyS', 'KeyA'], 'SW', 225], [['KeyA'], 'W', 270], [['KeyW', 'KeyA'], 'NW', 315]
    ];
    for (const [keys, point, heading] of cases) {
      await walk(keys, point, heading);
      console.log('  ' + point.padEnd(2) + ' ' + heading + ' deg ok');
    }
    // The dial turns: with the character facing east, the N label sits to the left of the centre.
    await walk(['KeyD'], 'E', 90);
    const geom = await frame.evaluate(() => {
      const el = document.getElementById('atlasCompassHud');
      const c = el.getBoundingClientRect();
      const pos = (p) => { const r = el.querySelector('.ch-pt[data-point="' + p + '"]').getBoundingClientRect(); return { x: r.x - (c.x + c.width / 2), y: r.y - (c.y + c.height / 2) }; };
      return { N: pos('N'), E: pos('E'), S: pos('S'), W: pos('W') };
    });
    assertTrue(geom.E.y < -20 && Math.abs(geom.E.x) < 4, 'facing east, E is at the top: ' + JSON.stringify(geom.E));
    assertTrue(geom.N.x < -20 && Math.abs(geom.N.y) < 4, 'N is to the left: ' + JSON.stringify(geom.N));
    assertTrue(geom.S.x > 20 && geom.W.y > 20, 'S is to the right and W below: ' + JSON.stringify(geom));
    if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await site.screenshot({ path: path.join(SHOT_DIR, 'compass-hud-east.png') }); }
    console.log('PASS: the dial turns with the character');

    console.log('STEP 6: unequip, then use the other trinket slot, then both');
    await equip('setAvatarSlot', 'trinket1', null);
    await waitHud(false);
    assertTrue(Object.keys(await caps()).length === 0, 'no capability once unequipped');
    await equip('setAvatarSlot', 'trinket2', compassId);
    await waitHud(true);
    assertTrue(JSON.stringify(await caps()) === JSON.stringify({ 'atlas.cap.compass': ['trinket2:equipped'] }), 'trinket 2 provides it: ' + JSON.stringify(await caps()));
    await equip('setAvatarSlot', 'trinket2', null);
    await waitHud(false);
    console.log('PASS: hidden when unequipped, shown from either trinket slot');

    console.log('STEP 7: a 3D world whose policy does not enable the capability');
    await equip('setAvatarSlot', 'trinket1', compassId);
    await waitHud(true);
    await enter('lobby-nofx', 'Lobby Without Effects');
    await waitHud(false);
    assertTrue(Object.keys(await caps()).length === 0, 'no capability there');
    const reason = await frame.evaluate(async () => { const fx = await AtlasWallet.getEquipmentEffects(); return fx.items.map((i) => i.effects.map((e) => e.id + ':' + (e.active ? 'on' : e.reason))).flat(); });
    assertTrue(reason.includes('atlas.cap.compass:world-effects-off'), 'the wallet names the reason: ' + JSON.stringify(reason));
    await enter('lobby', 'Lobby');
    await waitHud(true);
    console.log('PASS: hidden where the world does not support it, back in the lobby it returns');

    console.log('STEP 8: a portal to another domain (no itemEffects) and back');
    await frame.evaluate((url) => { window.__prev3D = window.__atlasActive3D; return followPortal({ kind: 'domain', to: location.host, manifest: url }); }, lab.origin + '/second/.well-known/spatial.json');
    await frame.waitForFunction(() => window.__atlasActive3D && window.__atlasActive3D !== window.__prev3D, null, { timeout: 60000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    await waitHud(false);
    assertTrue(Object.keys(await caps()).length === 0, 'the other domain activates no capability');
    const stillEquipped = await walletPage.evaluate(async () => (await AtlasWallet.getAvatarSlotIds()).trinket1);
    assertTrue(!!stillEquipped, 'the compass stays equipped across the portal');
    await frame.evaluate((url) => followPortal({ kind: 'domain', to: location.host, manifest: url }), lab.origin + '/.well-known/spatial.json');
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Plaza'), null, { timeout: 40000 });
    assertTrue(!(await hud()).visible, 'the plaza (2D) shows no HUD');
    await enter('lobby', 'Lobby');
    await waitHud(true);
    console.log('PASS: hidden in the other domain, shown again after returning to the lobby');

    ok = true;
  } catch (err) {
    console.log('FAIL: ' + (err && err.stack ? err.stack : err));
  } finally {
    await context.close();
    await lab.stop();
    lab.cleanup();
  }
  console.log(ok ? '\nCOMPASS DEMO BROWSER CHECK PASSED' : '\nCOMPASS DEMO BROWSER CHECK FAILED');
  process.exit(ok ? 0 : 1);
})();
