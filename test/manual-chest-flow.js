// Real-browser check of the gallery's key chests: the actual wallet extension, the actual gallery scene and a
// real PHP issuer (isolated copy, fresh key and state). Run with a display, for example
//   xvfb-run -a node test/manual-chest-flow.js
//
// Proves, in order: (1) a chest with no key in the wallet offers the Asset Studio instead and spends
// nothing; (2) a key made through the Studio's own flow reaches the wallet; (3) cancelling the "a key will
// be consumed" prompt spends nothing; (4) confirming spends the key and the reward arrives, verified by
// the wallet against the issuer's published key; (5) the same wallet cannot open the same chest again and
// is told so without a prompt; (6) the second chest, with no key left, offers the Studio again.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioLab } = require('./studio-lab');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chest-flow-profile-'));
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
  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;

    console.log('STEP 1: creating a real wallet identity');
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('chest-flow-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('chest-flow-test-pw');
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
    const overlay = await site.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
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

    console.log('STEP 3: no key in the wallet: the chest points to the Asset Studio and nothing is spent');
    await touch('gallery-gem');
    await frame.waitForSelector('#chestModal.active', { timeout: 15000 });
    let t = await modalText();
    assertTrue(/locked/i.test(t.title), 'locked title: ' + JSON.stringify(t));
    assertTrue(t.message.includes('would you like to go make keys now?') || t.message.includes('Would you like to go make keys now?'), 'offers the Studio: ' + t.message);
    await frame.locator('#chestCancelBtn').click();
    await settle();
    assertTrue(/stays locked/.test(await status()), 'status after declining: ' + await status());
    const popupPromise = context.waitForEvent('page');
    await touch('gallery-gem');
    await frame.waitForSelector('#chestModal.active', { timeout: 15000 });
    await frame.locator('#chestConfirmBtn').click();
    const studio = await popupPromise;
    await settle();
    await studio.waitForLoadState('load');
    assertTrue(studio.url() === lab.origin + '/atlas/studio/', 'the Studio opened: ' + studio.url());
    console.log('PASS: the prompt offered the Studio and "Make keys" opened it');

    console.log('STEP 4: making a key through the Studio\'s own flow');
    await studio.waitForFunction(() => document.getElementById('walletStatus').textContent.length > 0 && !/Checking/.test(document.getElementById('walletStatus').textContent), null, { timeout: 15000 });
    await studio.bringToFront();
    await studio.evaluate(() => window.dispatchEvent(new Event('focus')));
    await studio.waitForFunction(() => !document.getElementById('mint').disabled, null, { timeout: 15000 });
    await studio.locator('#templateTiles [data-value="key"]').click();
    await studio.locator('#assetName').fill('Gallery Key');
    await studio.locator('#mint').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 15000 });
    let bridge = studio.frameLocator('#domain-atlas-bridge-confirm');
    await bridge.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
    await bridge.locator('#approveBtn').click();
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { state: 'detached', timeout: 15000 }).catch(() => {});
    await studio.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 15000 });
    bridge = studio.frameLocator('#domain-atlas-bridge-confirm');
    await bridge.locator('#offerState').waitFor({ state: 'visible', timeout: 15000 });
    await bridge.locator('#offerApproveBtn').click();
    await studio.waitForFunction(() => /Offered to your wallet|Added to your wallet/.test(document.getElementById('message').textContent), null, { timeout: 15000 });
    const offers = await walletPage.evaluate((o) => AtlasWallet.getBridgeOffers(o), identity.publicKey);
    const offer = offers.find((e) => e.credential && e.credential.asset && e.credential.asset.properties && e.credential.asset.properties['atlas.studio.template'] === 'key');
    assertTrue(offer && !offer.claimed, 'a key is queued for the wallet');
    const claim = await walletPage.evaluate(({ o, id }) => AtlasWallet.claimBridgeOffer(o, id), { o: identity.publicKey, id: offer.id });
    assertTrue(claim.verdict && claim.verdict.valid === true, 'the key verifies: ' + JSON.stringify(claim.verdict));
    const keyId = offer.credential.id;
    await studio.close();
    console.log('PASS: key ' + keyId.slice(-8) + ' is in the wallet');

    console.log('STEP 5: cancelling the prompt spends nothing');
    await touch('gallery-gem');
    await frame.waitForSelector('#chestModal.active', { timeout: 15000 });
    t = await modalText();
    assertTrue(t.message.includes('A key will be consumed to open the chest, do you want to continue?'), 'consume prompt: ' + JSON.stringify(t));
    await frame.locator('#chestCancelBtn').click();
    await settle();
    assertTrue(/your key was not used/.test(await status()), 'status after cancelling: ' + await status());
    assertTrue(!revokedIds().includes(keyId), 'the key is still live');
    assertTrue((await walletNow()).some((e) => e.credential.id === keyId), 'the key is still in the wallet');
    console.log('PASS: Cancel left the key untouched');

    console.log('STEP 6: confirming spends the key and the reward arrives');
    await touch('gallery-gem');
    await frame.waitForSelector('#chestModal.active', { timeout: 15000 });
    await frame.locator('#chestConfirmBtn').click();
    await settle();
    assertTrue(/held Ruby\. One key was used\./.test(await status()), 'status after opening: ' + await status());
    const after = await walletNow();
    assertTrue(!after.some((e) => e.credential.id === keyId), 'the key left the wallet');
    const ruby = after.find((e) => e.credential.asset.class === 'atlas.gem.ruby');
    assertTrue(ruby && ruby.credential.owner.publicKey === identity.publicKey, 'the ruby is in the wallet');
    assertTrue(ruby.lastVerdict && ruby.lastVerdict.valid === true, 'the wallet verified the ruby: ' + JSON.stringify(ruby.lastVerdict));
    assertTrue(revokedIds().includes(keyId), 'the issuer revoked the key');
    console.log('PASS: key consumed, Ruby received and verified');

    console.log('STEP 7: the same wallet cannot open the same chest again');
    await touch('gallery-gem');
    await settle();
    assertTrue(/already opened/.test(await status()), 'status on a second visit: ' + await status());
    assertTrue(await frame.locator('#chestModal.active').count() === 0, 'no prompt for an opened chest');
    console.log('PASS: told it was already opened, with no prompt');

    console.log('STEP 8: the other chest, with no key left, offers the Studio again');
    await touch('gallery-pick');
    await frame.waitForSelector('#chestModal.active', { timeout: 15000 });
    t = await modalText();
    assertTrue(/make keys now/i.test(t.message), 'offers the Studio: ' + t.message);
    await frame.locator('#chestCancelBtn').click();
    await settle();
    ok = true;
  } finally {
    await context.close().catch(() => {});
    await lab.stop();
    lab.cleanup();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  console.log(ok ? '\nAll chest-flow checks passed' : '\nFAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
