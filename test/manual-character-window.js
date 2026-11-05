// Real-browser check of the character window: the actual wallet extension, the gallery scene and a real PHP
// issuer (isolated copy). Run with a display, for example
//   xvfb-run -a node test/manual-character-window.js
//
// Proves: (1) the Mining Pick from the gallery chest carries the hand-item flag; (2) the C key opens the
// window on the Character screen and a second press closes the panel; (3) the Hand block starts empty and
// lists the pick; (4) a slot with nothing fitting says so; (5) choosing the pick equips it live in the world
// and in the window's own preview, and the block shows it; (6) the held model survives re-entering the
// world; (7) clicking the equipped item again puts it away; (8) typing in an input does not open the window.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioLab } = require('./studio-lab');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'char-window-profile-'));
const CLASS = 'atlas.demo.studio.collectible';

function assertTrue(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const lab = await StudioLab.start({ mint: true, config: { mintsPerIpPerHour: 100, challengesPerIpPerHour: 100 } });
  // The gallery world and its models, served by the same PHP issuer that signs the keys and rewards.
  const B = path.join(REPO, 'demo-domain-b');
  for (const dir of ['spatial', 'assets']) fs.cpSync(path.join(B, dir), path.join(lab.docroot, dir), { recursive: true });
  fs.copyFileSync(path.join(B, 'index.html'), path.join(lab.docroot, 'index.html'));
  fs.copyFileSync(path.join(B, 'favicon.svg'), path.join(lab.docroot, 'favicon.svg'));
  const manifest = JSON.parse(fs.readFileSync(path.join(B, '.well-known', 'spatial.json'), 'utf8'));
  manifest.domain = lab.host;
  manifest.worlds.push({ id: 'studio', name: 'Asset Studio', policy: { walletBridge: { read: true, sign: ['atlas.studio.mint/1'], offer: [CLASS] } } });
  for (const w of manifest.worlds) for (const p of w.portals || []) if (p.kind === 'domain') p.to = 'localhost:1', p.manifest = 'http://localhost:1/.well-known/spatial.json';
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(manifest, null, 2));
  const revokedIds = () => JSON.parse(fs.readFileSync(path.join(lab.docroot, '.well-known', 'atlas-revocations.json'), 'utf8')).revoked.map((r) => r.id);
  console.log('SETUP: PHP issuer with the gallery on ' + lab.origin);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, executablePath: '/opt/pw-browsers/chromium',
    args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
    viewport: { width: 1280, height: 800 },
  });
  let ok = false;
  // The issuer names asset files with https://<host>; the lab host speaks plain http, so those requests are
  // answered from the http origin.
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
    await walletPage.locator('#newPasswordInput').fill('char-window-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('char-window-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const identity = await walletPage.evaluate(async () => { const i = await AtlasWallet.getIdentity(); return i ? { publicKey: i.publicKey } : null; });
    assertTrue(identity && identity.publicKey, 'identity created');
    console.log('PASS: identity ' + identity.publicKey.slice(0, 12) + '…');

    console.log('STEP 2: entering the gallery');
    const site = await context.newPage();
    site.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
    await site.goto(lab.origin + '/', { waitUntil: 'load' });
    await site.locator('#domain-atlas-enter-btn').click();
    const overlay = await site.waitForSelector('#domain-atlas-overlay', { timeout: 40000 });
    const frame = await overlay.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), null, { timeout: 40000 });
    await frame.evaluate(() => followPortal({ kind: 'world', to: 'gallery' }));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Atlas Showcase Gallery'), null, { timeout: 40000 });
    await frame.waitForFunction(() => !!window.__atlasActive3D, null, { timeout: 40000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    const markers = await frame.evaluate(async () => { const sc = await (await fetch(currentOrigin + currentWorld.entry.scene, { cache: 'no-store' })).json(); window.__chestMarkers = sc.interactables.filter((m) => m.action === 'open-chest'); return window.__chestMarkers; }).then((list) => list.map((m) => ({ chestId: m.chestId, class: m.class, label: m.label })));
    assertTrue(markers.length === 2 && markers.map((m) => m.chestId).sort().join() === 'gallery-gem,gallery-pick', 'the gallery declares both chests: ' + JSON.stringify(markers));
    const touch = (chestId) => frame.evaluate((id) => { window.__chestRun = handleInteractable(window.__chestMarkers.find((m) => m.chestId === id)); }, chestId);
    const modalText = async () => ({
      title: await frame.locator('#chestTitle').innerText(), message: await frame.locator('#chestMessage').innerText(),
      confirm: await frame.locator('#chestConfirmBtn').innerText(), cancel: await frame.locator('#chestCancelBtn').innerText(),
    });
    const settle = () => frame.evaluate(() => window.__chestRun);
    const status = () => frame.locator('#status').innerText();
    const walletNow = () => walletPage.evaluate((o) => AtlasWallet.getWallet(o), identity.publicKey);
    console.log('PASS: gallery loaded with both chests declared');

    console.log('STEP 3: opening the Asset Studio from a locked chest');
    const popupPromise = context.waitForEvent('page');
    await frame.evaluate(() => { window.__chestRun = handleInteractable(window.__chestMarkers.find((m) => m.chestId === 'gallery-gem')); });
    await frame.waitForSelector('#chestModal.active', { timeout: 15000 });
    await frame.locator('#chestConfirmBtn').click();
    const studio = await popupPromise;
    await frame.evaluate(() => window.__chestRun);
    await studio.waitForLoadState('load');

    console.log('STEP 4: making a key through the Studio\'s own flow');
    await studio.waitForFunction(() => document.getElementById('walletStatus').textContent.length > 0 && !/Checking/.test(document.getElementById('walletStatus').textContent), null, { timeout: 45000 });
    await studio.bringToFront();
    await studio.evaluate(() => window.dispatchEvent(new Event('focus')));
    await studio.waitForFunction(() => !document.getElementById('mint').disabled, null, { timeout: 45000 });
    await studio.locator('#templateTiles [data-value="key"]').click();
    await studio.locator('#assetName').fill('Gallery Key');
    await studio.locator('#mint').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 45000 });
    let bridge = studio.frameLocator('#domain-atlas-bridge-confirm');
    await bridge.locator('#readyState').waitFor({ state: 'visible', timeout: 45000 });
    await bridge.locator('#approveBtn').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { state: 'detached', timeout: 45000 }).catch(() => {});
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 45000 });
    bridge = studio.frameLocator('#domain-atlas-bridge-confirm');
    await bridge.locator('#offerState').waitFor({ state: 'visible', timeout: 45000 });
    await bridge.locator('#offerApproveBtn').click();
    await studio.waitForFunction(() => /Offered to your wallet|Added to your wallet/.test(document.getElementById('message').textContent), null, { timeout: 45000 });
    const offers = await walletPage.evaluate((o) => AtlasWallet.getBridgeOffers(o), identity.publicKey);
    const offer = offers.find((e) => e.credential && e.credential.asset && e.credential.asset.properties && e.credential.asset.properties['atlas.studio.template'] === 'key');
    assertTrue(offer && !offer.claimed, 'a key is queued for the wallet');
    const claim = await walletPage.evaluate(({ o, id }) => AtlasWallet.claimBridgeOffer(o, id), { o: identity.publicKey, id: offer.id });
    assertTrue(claim.verdict && claim.verdict.valid === true, 'the key verifies: ' + JSON.stringify(claim.verdict));
    const keyId = offer.credential.id;
    await studio.close();
    console.log('PASS: key ' + keyId.slice(-8) + ' is in the wallet');

    console.log('STEP 5: opening the pick chest with that key');
    await frame.evaluate(() => { window.__chestRun = handleInteractable(window.__chestMarkers.find((m) => m.chestId === 'gallery-pick')); });
    await frame.waitForSelector('#chestModal.active', { timeout: 15000 });
    await frame.locator('#chestConfirmBtn').click();
    await frame.evaluate(() => window.__chestRun);
    const pick = (await walletPage.evaluate((o) => AtlasWallet.getWallet(o), identity.publicKey)).find((e) => e.credential.asset.class === 'atlas.tool.pickaxe');
    assertTrue(pick, 'the Mining Pick is in the wallet');
    assertTrue(pick.credential.asset.properties['atlas.avatar.handItem'] === 'true', 'the pick carries the hand-item flag');
    assertTrue(/^https?:\/\//.test(pick.credential.asset.model), 'the pick has an absolute model URL: ' + pick.credential.asset.model);
    console.log('PASS: Mining Pick received, flagged as holdable');

    console.log('STEP 6: C opens the Character screen; C again closes the panel');
    await frame.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })); });
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open') && document.getElementById('characterScreen').classList.contains('active') && !!window.__atlasCharacterPreview, null, { timeout: 40000 });
    assertTrue(await frame.evaluate(() => document.getElementById('characterTabBtn').classList.contains('active-tab')), 'Character tab highlighted');
    const slotText = (slot) => frame.locator('.character-slot[data-slot="' + slot + '"] .slot-item').innerText();
    assertTrue(await slotText('hand') === 'Nothing in hand', 'hand starts empty: ' + await slotText('hand'));
    assertTrue(await slotText('hat') === 'No hat on', 'hat starts empty');
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 5000 });
    console.log('PASS: C toggles the window');

    console.log('STEP 7: slots list what fits; an empty slot says so');
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => document.getElementById('characterScreen').classList.contains('active') && !!window.__atlasCharacterPreview, null, { timeout: 40000 });
    await frame.locator('.character-slot[data-slot="hat"]').click();
    await frame.waitForFunction(() => /Nothing in your wallet fits/.test(document.getElementById('characterSlotNote').textContent), null, { timeout: 40000 });
    await frame.locator('.character-slot[data-slot="hand"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#characterSlotList .character-choice').length === 1, null, { timeout: 40000 });
    assertTrue((await frame.locator('#characterSlotList .character-choice').innerText()).includes('Mining Pick'), 'the pick is listed for the hand');
    console.log('PASS: hand lists the pick, hat says nothing fits');

    console.log('STEP 8: choosing the pick equips it in the world and in the preview');
    await frame.locator('#characterSlotList .character-choice').click();
    await frame.waitForFunction((model) => window.__atlasActive3D.getLocalAvatarHandModel() === model && window.__atlasCharacterPreview.getHandModel() === model, pick.credential.asset.model, { timeout: 40000 });
    await frame.waitForFunction(() => window.__atlasCharacterPreview.isHandModelLoaded(), null, { timeout: 40000 });
    assertTrue(await slotText('hand') === 'Mining Pick', 'hand block shows the pick: ' + await slotText('hand'));
    assertTrue(await frame.evaluate(() => !!document.querySelector('.character-slot[data-slot="hand"] .slot-icon img')), 'the block shows the pick thumbnail');
    assertTrue(await frame.evaluate(async () => (await AtlasWallet.getAvatarHandAssetId()) !== null), 'the choice is stored');
    console.log('PASS: pick held live and shown in the window');
    await frame.waitForTimeout(1500);
    await frame.locator('.character-stage').screenshot({ path: process.env.CHAR_SHOT || '/tmp/character-window.png' });

    console.log('STEP 8a: another player\'s held item is accepted only as an absolute http(s) URL');
    const remoteHeld = await frame.evaluate((model) => {
      const a = window.__atlasActive3D;
      a.upsertRemotePlayer('remote-ok', { x: 3, y: 0, z: -3, yaw: 0, handModel: model });
      a.upsertRemotePlayer('remote-js', { x: 4, y: 0, z: -3, yaw: 0, handModel: 'javascript:alert(1)' });
      a.upsertRemotePlayer('remote-rel', { x: 5, y: 0, z: -3, yaw: 0, handModel: '/assets/pickaxe.glb' });
      const out = ['remote-ok', 'remote-js', 'remote-rel'].map((id) => a.getRemotePlayerRenderState(id).handModel);
      ['remote-ok', 'remote-js', 'remote-rel'].forEach((id) => a.removeRemotePlayer(id));
      return out;
    }, pick.credential.asset.model);
    assertTrue(remoteHeld[0] === pick.credential.asset.model && remoteHeld[1] === null && remoteHeld[2] === null, 'remote held items: ' + JSON.stringify(remoteHeld));
    console.log('PASS: remote held items validated');

    console.log('STEP 8b: the pick is drawn in the character\'s hand in the world (third person)');
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 40000 });
    await frame.evaluate(() => { const a = window.__atlasActive3D; a.setCameraDistance(3); });
    await frame.waitForFunction(() => window.__atlasActive3D.getHandModelState && window.__atlasActive3D.getHandModelState(window.__atlasActive3D.getLocalAvatarHandModel()) === 'ready', null, { timeout: 40000 });
    await frame.waitForTimeout(1500);
    await site.screenshot({ path: process.env.WORLD_SHOT || '/tmp/character-world.png' });
    await frame.evaluate(() => window.__atlasActive3D.setCameraDistance(0));
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 40000 });
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 40000 });

    console.log('STEP 9: the held pick survives leaving and re-entering the world');
    await frame.evaluate(() => followPortal({ kind: 'world', to: 'workshop' }));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), null, { timeout: 40000 });
    await frame.evaluate(() => followPortal({ kind: 'world', to: 'gallery' }));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Atlas Showcase Gallery') && !!window.__atlasActive3D, null, { timeout: 40000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    assertTrue(await frame.evaluate((m) => window.__atlasActive3D.getLocalAvatarHandModel() === m, pick.credential.asset.model), 'the pick is still in hand');
    console.log('PASS: still holding it');

    console.log('STEP 10: clicking the equipped item again puts it away');
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => document.getElementById('characterScreen').classList.contains('active') && !!window.__atlasCharacterPreview, null, { timeout: 40000 });
    await frame.locator('.character-slot[data-slot="hand"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#characterSlotList .character-choice.equipped').length === 1, null, { timeout: 40000 });
    await frame.locator('#characterSlotList .character-choice').click();
    await frame.waitForFunction(() => window.__atlasActive3D.getLocalAvatarHandModel() === null && window.__atlasCharacterPreview.getHandModel() === null, null, { timeout: 40000 });
    assertTrue(await slotText('hand') === 'Nothing in hand', 'hand empty again');
    console.log('PASS: put away');

    console.log('STEP 11: typing C in a text field does not open the window');
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 40000 });
    await frame.evaluate(() => { const i = document.getElementById('chatTextInput'); i.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })); });
    await frame.waitForTimeout(300);
    assertTrue(await frame.evaluate(() => !document.getElementById('walletPanel').classList.contains('open')), 'panel stayed closed');
    console.log('PASS: ignored while typing');
    console.log('STEP 12: the tool chest is reopenable once the pick is gone from the wallet');
    await frame.evaluate(() => { window.__chestRun = handleInteractable(window.__chestMarkers.find((m) => m.chestId === 'gallery-pick')); });
    await frame.evaluate(() => window.__chestRun);
    assertTrue(/already have Mining Pick/.test(await frame.locator('#status').innerText()), 'holding the pick blocks a second one: ' + await frame.locator('#status').innerText());
    assertTrue(await frame.locator('#chestModal.active').count() === 0, 'no prompt while the pick is held');
    await walletPage.evaluate(async ({ o, id }) => AtlasWallet.deleteAsset(o, id), { o: identity.publicKey, id: pick.credential.id });
    await frame.evaluate(() => { window.__chestRun = handleInteractable(window.__chestMarkers.find((m) => m.chestId === 'gallery-pick')); });
    await frame.waitForSelector('#chestModal.active', { timeout: 40000 });
    assertTrue(/locked/i.test(await frame.locator('#chestTitle').innerText()), 'with the pick gone and no key, the chest offers the Studio');
    await frame.locator('#chestCancelBtn').click();
    await frame.evaluate(() => window.__chestRun);
    console.log('PASS: held pick blocks a second one; a lost pick lets the chest be looted again');
    ok = true;
  } finally {
    await context.close().catch(() => {});
    await lab.stop();
    lab.cleanup();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  console.log(ok ? '\nAll character-window checks passed' : '\nFAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
