// Real-browser check of the action bar: the actual extension, the demo domain's plaza (2D) and lobby (3D), a
// second domain, and a real PHP issuer (isolated copy) with a few standard-conforming test items injected.
// Run with a display, for example
//   xvfb-run -a node test/manual-action-bar.js
//
// Proves: (1) the bar shows in 2D and 3D worlds, lays out clear of the chat widget, the hints and the compass
// HUD; (2) keys 1-5 give slot feedback, and in 3D play cosmetic poses on the character (block holds while the key
// is held); (3) 6-8 tap to cycle, hold to open a selector, arrows and Enter confirm, Escape cancels, and none of
// it equips, uses or spends anything; Shift + key is a separate use request that does nothing; (4) keys are
// ignored while typing in a field and while the wallet or the Character window is open, and the bar and the
// compass HUD step aside then; (5) movement, the compass HUD, portals and equipment are unaffected, and the
// selection survives world and domain changes while a held block ends with the world.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { StudioLab, makeIdentity, signPayload } = require('./studio-lab');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'action-bar-profile-'));

function assertTrue(cond, msg) { if (!cond) throw new Error(msg); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SHOT_DIR = process.env.ACTION_BAR_SHOT_DIR || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODEL = '/assets/studio/badge.glb';
const CLASSES = {
  'atlas.tool.fx_pickaxe': { name: 'Fx Pickaxe', modelPath: MODEL, properties: { 'atlas.cap.mine.tier': '2' }, itemSpec: { category: 'tool', slot: 'hand', capabilities: ['atlas.cap.mine'], capabilityParams: { 'atlas.cap.mine': { tier: { min: '1', max: '3' } } } } },
  'atlas.tool.fx_torch': { name: 'Fx Torch', modelPath: MODEL, properties: { 'atlas.cap.light.radius': '5' }, itemSpec: { category: 'tool', slot: 'offhand', capabilities: ['atlas.cap.light'], capabilityParams: { 'atlas.cap.light': { radius: { min: '1', max: '8' } } } } },
  'atlas.consumable.fx_potion': { name: 'Fx Potion', modelPath: MODEL, properties: { 'atlas.cap.blast.radius': '3' }, itemSpec: { category: 'consumable', uses: '1', capabilities: ['atlas.cap.blast'], capabilityParams: { 'atlas.cap.blast': { radius: { min: '2', max: '6' } } } } }
};

function phpValue(v, indent) {
  const pad = '  '.repeat(indent);
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (Array.isArray(v)) return '[' + v.map((x) => phpValue(x, indent + 1)).join(', ') + ']';
  const keys = Object.keys(v);
  if (!keys.length) return '[]';
  return '[\n' + keys.map((k) => pad + '  ' + phpValue(k, 0) + ' => ' + phpValue(v[k], indent + 1)).join(',\n') + '\n' + pad + ']';
}
function injectClasses(docroot) {
  const store = path.join(docroot, 'lib', 'store.php');
  const text = fs.readFileSync(store, 'utf8');
  const anchor = "define('ATLAS_ASSET_CATALOG', array_merge(ATLAS_ASSET_CATALOG_BASE, atlas_elements_catalog()));";
  if (!text.includes(anchor)) throw new Error('store.php no longer has the catalog line this test injects at');
  fs.writeFileSync(store, text.replace(anchor, "define('ATLAS_ASSET_CATALOG', array_merge(ATLAS_ASSET_CATALOG_BASE, atlas_elements_catalog(), require __DIR__ . '/fx-test-classes.php'));"));
  const entries = Object.entries(CLASSES).map(([cls, d]) => '  ' + phpValue(cls, 0) + ' => ' + phpValue({ name: d.name, modelPath: d.modelPath, fungible: false, presentation: 'collectible', properties: d.properties, itemSpec: d.itemSpec }, 1));
  fs.writeFileSync(path.join(docroot, 'lib', 'fx-test-classes.php'), '<?php\nreturn [\n' + entries.join(',\n') + '\n];\n');
}

(async () => {
  const lab = await StudioLab.start({ mint: true, config: { mintsPerIpPerHour: 100, challengesPerIpPerHour: 100 } });
  injectClasses(lab.docroot);
  const admin = makeIdentity('raw-ecdsa');
  fs.writeFileSync(path.join(lab.docroot, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKeyB64, addedAt: new Date().toISOString() }] }));

  const A = path.join(REPO, 'demo-domain-a');
  const B = path.join(REPO, 'demo-domain-b');
  for (const root of [A, B]) for (const dir of ['spatial', 'assets']) fs.cpSync(path.join(root, dir), path.join(lab.docroot, dir), { recursive: true, force: true });
  fs.copyFileSync(path.join(A, 'index.html'), path.join(lab.docroot, 'index.html'));
  fs.copyFileSync(path.join(A, 'favicon.svg'), path.join(lab.docroot, 'favicon.svg'));
  const manifest = JSON.parse(fs.readFileSync(path.join(A, '.well-known', 'spatial.json'), 'utf8'));
  manifest.domain = lab.host;
  for (const w of manifest.worlds) w.portals = (w.portals || []).filter((p) => p.kind === 'world');
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(manifest, null, 2));
  const other = JSON.parse(fs.readFileSync(path.join(B, '.well-known', 'spatial.json'), 'utf8'));
  other.domain = 'second.example.test';
  other.defaultWorld = 'gallery';
  other.worlds = other.worlds.filter((w) => w.id === 'gallery');
  other.worlds[0].portals = [];
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

    console.log('STEP 1: creating a real wallet identity and minting test items');
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 40000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('action-bar-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('action-bar-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const identity = await walletPage.evaluate(async () => { const i = await AtlasWallet.getIdentity(); return i ? { publicKey: i.publicKey } : null; });
    assertTrue(identity && identity.publicKey, 'identity created');
    assertTrue(!(await walletPage.evaluate(() => !!document.getElementById('actionBar'))), 'a page with no world has no action bar');
    const claim = (credential) => walletPage.evaluate(async ({ o, origin, cred }) => { const e = await AtlasWallet.queueBridgeOffer(o, origin, cred); await AtlasWallet.claimBridgeOffer(o, e.id); return cred.id; }, { o: identity.publicKey, origin: lab.origin, cred: credential });
    const adminCall = async (route, body) => {
      const payload = Object.assign({}, body, { adminAuth: { action: route, domain: lab.host, issuedAt: new Date().toISOString(), nonce: crypto.randomBytes(12).toString('hex') } });
      return lab.postRaw(route, { payload, proof: signPayload(admin, payload) });
    };
    const ids = {};
    for (const [key, cls] of Object.entries({ pick: 'atlas.tool.fx_pickaxe', torch: 'atlas.tool.fx_torch', potion: 'atlas.consumable.fx_potion' })) {
      const r = await adminCall('/atlas/asset/mint', { ownerPublicKey: identity.publicKey, assetClass: cls });
      assertTrue(r.status === 200, 'mint ' + key + ': ' + r.text);
      ids[key] = await claim(r.json);
    }
    const hat = await lab.postRaw('/atlas/asset/issue', { ownerPublicKey: identity.publicKey, assetClass: 'atlas.avatar.hat.sunhat' });
    assertTrue(hat.status === 200, 'issue hat: ' + hat.text);
    const hatSpeed = Number(hat.json.asset.properties['atlas.avatar.hatSpeedMultiplier']);
    ids.hat = await claim(hat.json);
    console.log('PASS: identity ' + identity.publicKey.slice(0, 12) + '…, ' + Object.keys(ids).length + ' items claimed');

    console.log('STEP 2: entering the plaza (2D)');
    const site = await context.newPage();
    site.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
    await site.goto(lab.origin + '/', { waitUntil: 'load' });
    await site.locator('#domain-atlas-enter-btn').click();
    const overlay = await site.waitForSelector('#domain-atlas-overlay', { timeout: 40000 });
    const frame = await overlay.contentFrame();
    frame.on('pageerror', (e) => console.log('FRAMEERROR', String(e)));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Plaza'), null, { timeout: 40000 });
    await frame.waitForFunction(() => { const b = document.getElementById('actionBar'); return b && b.classList.contains('shown'); }, null, { timeout: 20000 });
    await frame.evaluate(() => { window.__abEvents = []; window.addEventListener('atlas-action-bar', (e) => window.__abEvents.push(e.detail)); });

    const bar = () => frame.evaluate(() => {
      const b = document.getElementById('actionBar');
      const slots = Array.from(b.querySelectorAll('.ab-slot')).map((s) => ({ id: s.dataset.slot, key: s.dataset.key, name: s.querySelector('.ab-name').textContent, pick: s.querySelector('.ab-pick').textContent, firing: s.classList.contains('firing'), holding: s.classList.contains('holding') }));
      const sel = b.querySelector('.ab-selector');
      const toast = b.querySelector('.ab-toast');
      return {
        shown: b.classList.contains('shown') && getComputedStyle(b).display !== 'none', slots,
        selectorOpen: sel.classList.contains('open'), rows: Array.from(sel.querySelectorAll('.ab-opt')).map((r) => ({ text: r.querySelector('.ab-oname').textContent, cursor: r.classList.contains('cursor'), current: r.classList.contains('current') })),
        toast: toast.classList.contains('show') ? toast.textContent : null
      };
    });
    const events = (from) => frame.evaluate((n) => window.__abEvents.slice(n), from || 0);
    const eventCount = () => frame.evaluate(() => window.__abEvents.length);
    const rect = (sel) => frame.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return cs.display === 'none' || (!r.width && !r.height) ? null : { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
    const overlaps = (a, b) => !!(a && b) && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const walletState = () => walletPage.evaluate(async (o) => {
      const w = await AtlasWallet.getWallet(o);
      return { entries: w.map((e) => e.credential.id + ':' + (e.credential.asset.properties['atlas.item.uses'] || '') + ':' + !!e.hidden).sort(), slots: await AtlasWallet.getAvatarSlotIds(), hand: await AtlasWallet.getAvatarHandAssetId() };
    }, identity.publicKey);
    const focusFrame = async () => { await frame.evaluate(() => { window.focus(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }); await frame.locator('#placeLabel').click(); };
    const press = async (code, hold) => { await site.keyboard.down(code); if (hold) await sleep(hold); await site.keyboard.up(code); };

    const baseline = await walletState();
    let b = await bar();
    assertTrue(b.shown, 'the bar shows in the 2D plaza');
    assertTrue(same(b.slots.map((s) => s.key), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']), 'ten slots in order');
    assertTrue(same(b.slots.map((s) => s.name), ['R Strike', 'L Strike', 'R Kick', 'L Kick', 'Block', 'L Item', 'R Item', 'Potion', '', '']), 'slot names: ' + JSON.stringify(b.slots.map((s) => s.name)));
    const barRect = await rect('#actionBar');
    assertTrue(barRect.y + barRect.h < 800 && barRect.y > 400 && Math.abs(barRect.x + barRect.w / 2 - 640) < 5, 'the bar sits low and centred: ' + JSON.stringify(barRect));
    for (const sel of ['#chatWidget', '#hint', '#scene3dHint', '#scene3dInteractHint', '#previewerWidget']) assertTrue(!overlaps(barRect, await rect(sel)), 'the bar does not cover ' + sel);
    console.log('PASS: ten slots, laid out clear of the chat widget and hints');

    console.log('STEP 3: keys 1-5 in the 2D world give slot feedback');
    await focusFrame();
    let n = await eventCount();
    for (const [code, id] of [['Digit1', 'strike-right'], ['Digit2', 'strike-left'], ['Digit3', 'kick-right'], ['Digit4', 'kick-left']]) {
      await site.keyboard.down(code);
      await frame.waitForFunction((slot) => document.querySelector('.ab-slot[data-slot="' + slot + '"]').classList.contains('firing'), id, { timeout: 3000 });
      await site.keyboard.up(code);
    }
    let ev = await events(n);
    assertTrue(same(ev.filter((e) => e.phase === 'start').map((e) => e.id), ['strike-right', 'strike-left', 'kick-right', 'kick-left']), 'each key reports its own action: ' + JSON.stringify(ev));
    await site.keyboard.down('Digit5');
    await frame.waitForFunction(() => document.querySelector('.ab-slot[data-slot="block"]').classList.contains('holding'), null, { timeout: 3000 });
    await sleep(400);
    assertTrue((await bar()).slots[4].holding, 'block stays highlighted while the key is held');
    await site.keyboard.up('Digit5');
    await frame.waitForFunction(() => !document.querySelector('.ab-slot[data-slot="block"]').classList.contains('holding'), null, { timeout: 3000 });
    n = await eventCount();
    await press('Digit9'); await press('Digit0');
    ev = await events(n);
    assertTrue(same(ev.map((e) => e.type), ['reserved', 'reserved']), 'keys 9 and 0 do nothing yet');
    console.log('PASS: strikes, kicks and block react in 2D');

    console.log('STEP 4: 6-8 tap to cycle, using only eligible wallet items');
    await frame.waitForFunction(() => window.__atlasActionBar.model.options('item-right').length === 1 && window.__atlasActionBar.model.options('item-left').length === 1 && window.__atlasActionBar.model.options('potion').length === 1, null, { timeout: 15000 });
    const opts = await frame.evaluate(() => ({ left: window.__atlasActionBar.model.options('item-left').map((o) => o.label), right: window.__atlasActionBar.model.options('item-right').map((o) => o.label), potion: window.__atlasActionBar.model.options('potion').map((o) => o.label) }));
    assertTrue(same(opts, { left: ['Fx Torch'], right: ['Fx Pickaxe'], potion: ['Fx Potion'] }), 'eligible items per slot: ' + JSON.stringify(opts));
    await press('Digit6');
    await frame.waitForFunction(() => window.__atlasActionBar.model.selectedId('item-left') !== null, null, { timeout: 3000 });
    b = await bar();
    assertTrue(b.slots[5].pick === 'Fx Torch' && !b.selectorOpen, 'a tap on 6 selects the torch without opening the selector: ' + JSON.stringify(b.slots[5]));
    await press('Digit6');
    await frame.waitForFunction(() => window.__atlasActionBar.model.selectedId('item-left') === null, null, { timeout: 3000 });
    assertTrue((await bar()).slots[5].pick === '', 'the next tap clears it (none)');
    await press('Digit6');
    await press('Digit7');
    await press('Digit8');
    b = await bar();
    assertTrue(b.slots[5].pick === 'Fx Torch' && b.slots[6].pick === 'Fx Pickaxe' && b.slots[7].pick === 'Fx Potion', 'each slot shows its own selection: ' + JSON.stringify(b.slots.map((s) => s.pick)));
    console.log('PASS: taps cycle through eligible items');

    console.log('STEP 5: hold opens the selector; confirming only records the choice');
    await press('Digit7', 450);
    await frame.waitForFunction(() => document.querySelector('#actionBar .ab-selector').classList.contains('open'), null, { timeout: 3000 });
    b = await bar();
    assertTrue(same(b.rows.map((r) => r.text), ['Fx Pickaxe', 'None']) && b.rows[0].current && b.rows[0].cursor, 'selector rows: ' + JSON.stringify(b.rows));
    if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await site.screenshot({ path: path.join(SHOT_DIR, 'action-bar-selector-2d.png') }); }
    await site.keyboard.press('ArrowDown');
    b = await bar();
    assertTrue(b.rows[1].cursor, 'the arrow key moves the cursor to None');
    await site.keyboard.press('Enter');
    await frame.waitForFunction(() => !document.querySelector('#actionBar .ab-selector').classList.contains('open'), null, { timeout: 3000 });
    assertTrue((await bar()).slots[6].pick === '', 'Enter confirmed "None" for the right hand');
    await press('Digit7', 450);
    await frame.waitForFunction(() => document.querySelector('#actionBar .ab-selector').classList.contains('open'), null, { timeout: 3000 });
    await frame.locator('#actionBar .ab-opt[data-choice="0"]').click();
    await frame.waitForFunction(() => window.__atlasActionBar.model.selectedId('item-right') !== null, null, { timeout: 3000 });
    assertTrue((await bar()).slots[6].pick === 'Fx Pickaxe', 'clicking a row selects it');
    await press('Digit8', 450);
    await frame.waitForFunction(() => document.querySelector('#actionBar .ab-selector').classList.contains('open'), null, { timeout: 3000 });
    const walletOpenBefore = await frame.evaluate(() => document.getElementById('walletPanel').classList.contains('open'));
    await site.keyboard.press('Escape');
    b = await bar();
    assertTrue(!b.selectorOpen && b.slots[7].pick === 'Fx Potion', 'Escape closes the selector and keeps the selection');
    assertTrue((await frame.evaluate(() => document.getElementById('walletPanel').classList.contains('open'))) === walletOpenBefore, 'and that Escape did not also open the wallet');
    const after = await walletState();
    assertTrue(same(after, baseline), 'the wallet is unchanged: nothing equipped, used, spent or hidden. before ' + JSON.stringify(baseline) + ' after ' + JSON.stringify(after));
    const useEvents = (await events(0)).filter((e) => e.type === 'use-request');
    assertTrue(useEvents.length === 0, 'no use request was raised by selecting');
    console.log('PASS: selecting is only selecting');

    console.log('STEP 6: a use request is separate, explicit, and does nothing');
    n = await eventCount();
    await site.keyboard.down('Shift'); await site.keyboard.down('Digit8'); await site.keyboard.up('Digit8'); await site.keyboard.up('Shift');
    await frame.waitForFunction(() => document.querySelector('#actionBar .ab-toast').classList.contains('show'), null, { timeout: 3000 });
    ev = (await events(n)).filter((e) => e.type !== 'options');
    assertTrue(same(ev.map((e) => e.type), ['use-request']) && ev[0].id === 'potion', 'one use request for the potion slot: ' + JSON.stringify(ev));
    assertTrue(/not available.*Nothing was used/.test((await bar()).toast), 'the bar says nothing was used: ' + (await bar()).toast);
    assertTrue(same(await walletState(), baseline), 'the potion still has its use and the wallet is unchanged');
    console.log('PASS: use request raised an event and nothing else');

    console.log('STEP 7: keys are ignored while typing and while the wallet or Character window is open');
    await frame.evaluate(() => { const i = document.createElement('input'); i.type = 'text'; i.id = 'abTestInput'; i.style.cssText = 'position:fixed;left:10px;top:70px;z-index:99'; document.body.appendChild(i); i.focus(); });
    n = await eventCount();
    await site.keyboard.press('Digit1'); await site.keyboard.press('Digit6');
    assertTrue((await eventCount()) === n, 'digits typed into a text field do nothing');
    assertTrue((await frame.evaluate(() => document.getElementById('abTestInput').value)) === '16', 'and they reach the field');
    await frame.evaluate(() => document.getElementById('abTestInput').remove());
    await focusFrame();
    await site.keyboard.press('KeyC');
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open') && document.getElementById('characterScreen').classList.contains('active'), null, { timeout: 15000 });
    assertTrue((await rect('#actionBar')) === null, 'the bar steps aside while the Character window is open');
    n = await eventCount();
    await site.keyboard.press('Digit1'); await site.keyboard.press('Digit5'); await site.keyboard.press('Digit6');
    assertTrue((await eventCount()) === n, 'digits are ignored while the Character window is open');
    await site.keyboard.press('KeyC');
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 5000 });
    await frame.waitForFunction(() => { const r = document.getElementById('actionBar').getBoundingClientRect(); return r.width > 0; }, null, { timeout: 3000 });
    await site.keyboard.press('Escape');
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 5000 });
    assertTrue((await rect('#actionBar')) === null, 'the bar steps aside while the wallet is open');
    n = await eventCount();
    await site.keyboard.press('Digit2');
    assertTrue((await eventCount()) === n, 'digits are ignored while the wallet is open');
    await site.keyboard.press('Escape');
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 5000 });
    await site.keyboard.press('Digit2');
    assertTrue((await eventCount()) > n, 'and work again once it closes');
    console.log('PASS: no keys while typing or with the wallet open; the bar steps aside');

    console.log('STEP 8: collecting the compass, then entering the 3D lobby');
    const stall = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        if (scene && scene.interactables && scene.interactables.length) {
          const canvas = document.getElementById('scene');
          const m = scene.interactables.find((i) => i.label === 'Bronze Compass');
          const p = project(m.position[0], m.position[1] || 0, m.position[2], canvas.width / 2, canvas.height / 2 + 40);
          resolve({ sx: p.x, sy: p.y - 16 });
        } else requestAnimationFrame(check);
      };
      check();
    }));
    await site.mouse.move(5, 5);
    await frame.locator('#scene').click({ position: { x: stall.sx, y: stall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent === 'Collected Bronze Compass.', null, { timeout: 15000 });
    const compassId = await walletPage.evaluate(async (o) => (await AtlasWallet.getWallet(o)).find((e) => e.credential.asset.class === 'atlas.tool.bronze_compass').credential.id, identity.publicKey);
    await walletPage.evaluate(async ({ hat, compass }) => { await AtlasWallet.setAvatarHat(hat); await AtlasWallet.setAvatarSlot('trinket1', compass); }, { hat: ids.hat, compass: compassId });
    const equippedBefore = await walletState();
    const enter = async (worldId, name) => {
      await frame.evaluate(() => { window.__prev3D = window.__atlasActive3D || null; });
      await frame.evaluate((id) => followPortal({ kind: 'world', to: id }), worldId);
      await frame.waitForFunction((x) => document.getElementById('placeLabel').textContent.includes(x), name, { timeout: 40000 });
    };
    const enter3D = async (worldId, name) => {
      await enter(worldId, name);
      await frame.waitForFunction(() => window.__atlasActive3D && window.__atlasActive3D !== window.__prev3D, null, { timeout: 60000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
    };
    await enter3D('lobby', 'Lobby');
    await frame.waitForFunction(() => { const el = document.getElementById('atlasCompassHud'); return el && el.classList.contains('active'); }, null, { timeout: 30000 });
    b = await bar();
    assertTrue(b.shown && b.slots[5].pick === 'Fx Torch' && b.slots[6].pick === 'Fx Pickaxe' && b.slots[7].pick === 'Fx Potion', 'the bar is still there with the same selections after the world change');
    const barRect3D = await rect('#actionBar');
    const hudRect = await rect('#atlasCompassHud');
    assertTrue(hudRect && !overlaps(barRect3D, hudRect), 'the bar and the compass HUD do not overlap');
    for (const sel of ['#chatWidget', '#scene3dHint', '#scene3dInteractHint']) assertTrue(!overlaps(barRect3D, await rect(sel)), 'the bar does not cover ' + sel + ' in 3D');
    console.log('PASS: the bar and the compass HUD coexist in the lobby');

    console.log('STEP 9: cosmetic poses on the 3D character, movement untouched');
    await focusFrame();
    await frame.locator('#scene3d').focus();
    // Records the largest pose value of each limb over a window, sampled every frame.
    const samplePose = (code, hold) => frame.evaluate(async ({ hold }) => {
      const max = { armL: 0, armR: 0, legL: 0, legR: 0 };
      let live = true;
      const tick = () => { const p = window.__atlasActive3D.getActionPose(); for (const k of Object.keys(max)) max[k] = Math.max(max[k], p[k]); if (live) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      window.__poseSampler = { stop: () => { live = false; return max; } };
      void hold;
      return true;
    }, { hold });
    const poseResult = () => frame.evaluate(() => window.__poseSampler.stop());
    const camBefore = await frame.evaluate(() => window.__atlasActive3D.camera.pos.slice());
    for (const [code, limb] of [['Digit1', 'armR'], ['Digit2', 'armL'], ['Digit3', 'legR'], ['Digit4', 'legL']]) {
      await samplePose(code);
      await press(code);
      await sleep(600);
      const m = await poseResult();
      assertTrue(m[limb] > 0.5, code + ' raised ' + limb + ' to ' + m[limb].toFixed(2));
      const others = Object.keys(m).filter((k) => k !== limb);
      assertTrue(others.every((k) => m[k] < 0.01), code + ' left the other limbs alone: ' + JSON.stringify(m));
      const rest = await frame.evaluate(() => window.__atlasActive3D.getActionPose());
      assertTrue(Object.values(rest).every((v) => v < 0.01), 'and the pose returned to rest');
    }
    await samplePose('Digit5');
    await site.keyboard.down('Digit5');
    await sleep(700);
    if (SHOT_DIR) await site.screenshot({ path: path.join(SHOT_DIR, 'action-bar-block-3d.png') });
    const held = await frame.evaluate(() => window.__atlasActive3D.getActionPose());
    assertTrue(held.armL > 1.2 && held.armR > 1.2 && held.legL < 0.01, 'block raises both arms while held: ' + JSON.stringify(held));
    await site.keyboard.up('Digit5');
    await sleep(700);
    await poseResult();
    const released = await frame.evaluate(() => window.__atlasActive3D.getActionPose());
    assertTrue(Object.values(released).every((v) => v < 0.01), 'releasing block lowers the arms');
    const camAfter = await frame.evaluate(() => window.__atlasActive3D.camera.pos.slice());
    assertTrue(same(camBefore, camAfter), 'the action keys do not move the character');
    console.log('PASS: strikes, kicks and block pose the character and nothing else');

    console.log('STEP 10: movement, equipment and buffs are unaffected');
    await frame.evaluate(() => { const c = window.__atlasActive3D.camera.pos; c[0] = 0.5; c[2] = 0.5; });
    await site.keyboard.down('KeyD');
    await frame.waitForFunction(() => { const el = document.getElementById('atlasCompassHud'); return el && el.dataset.facing === 'E'; }, null, { timeout: 8000 });
    await site.keyboard.up('KeyD');
    assertTrue((await frame.evaluate(() => window.__atlasActive3D.getLocalAvatarHatSpeedMultiplier())) === hatSpeed, 'the hat speed buff still applies');
    assertTrue(same((await walletState()).slots, equippedBefore.slots), 'equipment slots are untouched');
    // A selector that is open does not let the arrow keys walk the character away.
    await press('Digit7', 450);
    await frame.waitForFunction(() => document.querySelector('#actionBar .ab-selector').classList.contains('open'), null, { timeout: 3000 });
    const cam1 = await frame.evaluate(() => window.__atlasActive3D.camera.pos.slice());
    await site.keyboard.down('ArrowRight'); await sleep(300); await site.keyboard.up('ArrowRight');
    const cam2 = await frame.evaluate(() => window.__atlasActive3D.camera.pos.slice());
    assertTrue(same(cam1, cam2), 'arrow keys steer the selector, not the character, while it is open');
    await site.keyboard.press('Escape');
    // Typing in a text field stops action keys in 3D too.
    await frame.evaluate(() => { const i = document.createElement('input'); i.type = 'text'; i.id = 'abTestInput'; i.style.cssText = 'position:fixed;left:10px;top:70px;z-index:99'; document.body.appendChild(i); i.focus(); });
    await samplePose('Digit1');
    await site.keyboard.press('Digit1'); await sleep(500);
    const typed = await poseResult();
    assertTrue(Object.values(typed).every((v) => v < 0.01), 'no pose while typing in a text field');
    await frame.evaluate(() => document.getElementById('abTestInput').remove());
    await frame.locator('#scene3d').focus();
    // The wallet opening hides the bar and the compass HUD.
    await site.keyboard.press('Escape');
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 5000 });
    assertTrue((await rect('#actionBar')) === null && (await rect('#atlasCompassHud')) === null, 'the bar and the compass HUD both step aside for the wallet');
    await site.keyboard.press('Escape');
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 5000 });
    assertTrue((await rect('#actionBar')) && (await rect('#atlasCompassHud')), 'and come back when it closes');
    console.log('PASS: movement, buffs and equipment unchanged; layers step aside');

    console.log('STEP 10b: the controls hint is at the top of the canvas, the bar at the bottom, and back is a slow backpedal');
    {
      const hintRect = await rect('#scene3dHint'), barRect3 = await rect('#actionBar');
      assertTrue(hintRect && barRect3, 'both are visible in the 3D world');
      assertTrue(hintRect.y < 100 && hintRect.y >= 56, 'the hint sits at the top of the canvas, just below the header: ' + JSON.stringify(hintRect));
      assertTrue(barRect3.y + barRect3.h > 800 - 40 && barRect3.y + barRect3.h <= 800, 'the bar sits on the bottom edge: ' + JSON.stringify(barRect3));
      assertTrue(!overlaps(barRect3, hintRect) && !overlaps(barRect3, await rect('#chatWidget')), 'and they cover neither each other nor the chat');
      if (SHOT_DIR) await site.screenshot({ path: path.join(SHOT_DIR, 'world-hint-top-bar-bottom.png') });
      await frame.locator('#scene3d').focus();
      const walk = async (code, ms) => {
        await frame.evaluate(() => { const c = window.__atlasActive3D.camera.pos; c[0] = 0.5; c[2] = 0.5; });
        const a = await frame.evaluate(() => window.__atlasActive3D.camera.pos.slice());
        await site.keyboard.down(code); await sleep(ms); await site.keyboard.up(code);
        const b = await frame.evaluate(() => window.__atlasActive3D.camera.pos.slice());
        return Math.hypot(b[0] - a[0], b[2] - a[2]);
      };
      const forwardDist = await walk('KeyW', 600);
      const yawBefore = await frame.evaluate(() => ({ cam: window.__atlasActive3D.camera.yaw, face: window.__atlasActive3D.getCharacterYaw() }));
      const backDist = await walk('KeyS', 600);
      const yawAfter = await frame.evaluate(() => ({ cam: window.__atlasActive3D.camera.yaw, face: window.__atlasActive3D.getCharacterYaw() }));
      assertTrue(forwardDist > 0.3, 'walking forward moves the character: ' + forwardDist);
      assertTrue(backDist > 0.1 && backDist < forwardDist * 0.65, 'backpedalling is slower than a walk: ' + backDist.toFixed(2) + ' against ' + forwardDist.toFixed(2));
      const diff = Math.abs(Math.atan2(Math.sin(yawAfter.face - yawAfter.cam), Math.cos(yawAfter.face - yawAfter.cam)));
      assertTrue(diff < 0.01, 'the character keeps facing the way the camera looks while backing up: ' + JSON.stringify(yawAfter));
    }
    console.log('PASS: hint on top, bar on the bottom edge, back is a slower backpedal that does not turn the character');

    console.log('STEP 11: world transitions');
    await frame.locator('#scene3d').focus();
    await site.keyboard.down('Digit5');
    await sleep(500);
    assertTrue((await frame.evaluate(() => window.__atlasActive3D.getActionPose())).armL > 1.2, 'block is up before the portal');
    await enter('plaza', 'Plaza');
    await site.keyboard.up('Digit5');
    await frame.waitForFunction(() => !window.__atlasActive3D, null, { timeout: 20000 });
    b = await bar();
    assertTrue(b.shown && !b.slots[4].holding && b.slots[6].pick === 'Fx Pickaxe', 'in the 2D plaza the bar is shown, nothing is held, the selection stays');
    assertTrue(!(await frame.evaluate(() => !!document.querySelector('#atlasCompassHud.active'))), 'and the compass HUD is hidden there');
    await frame.evaluate(() => { window.__prev3D = null; });
    await frame.evaluate((url) => followPortal({ kind: 'domain', to: location.host, manifest: url }), lab.origin + '/second/.well-known/spatial.json');
    await frame.waitForFunction(() => window.__atlasActive3D, null, { timeout: 60000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.length > 0, null, { timeout: 10000 });
    b = await bar();
    assertTrue(b.shown && b.slots[5].pick === 'Fx Torch', 'in the other domain the bar is shown with the same selection');
    assertTrue(!(await frame.evaluate(() => !!document.querySelector('#atlasCompassHud.active'))), 'the compass HUD stays hidden where the world does not enable it');
    await frame.locator('#scene3d').focus();
    await samplePose('Digit1');
    await press('Digit1'); await sleep(600);
    assertTrue((await poseResult()).armR > 0.5, 'strikes still pose the character in the other domain');
    await frame.evaluate((url) => followPortal({ kind: 'domain', to: location.host, manifest: url }), lab.origin + '/.well-known/spatial.json');
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Plaza'), null, { timeout: 40000 });
    assertTrue(same(await walletState(), equippedBefore), 'after all the transitions the wallet and equipment are what they were');
    console.log('PASS: the bar follows the character across 2D, 3D and domain changes');

    ok = true;
  } catch (err) {
    console.log('FAIL: ' + (err && err.stack ? err.stack : err));
  } finally {
    await context.close();
    await lab.stop();
    lab.cleanup();
  }
  console.log(ok ? '\nACTION BAR BROWSER CHECK PASSED' : '\nACTION BAR BROWSER CHECK FAILED');
  process.exit(ok ? 0 : 1);
})();
