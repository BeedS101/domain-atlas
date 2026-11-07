// Real-browser check of standard-item effects in the wallet and the viewer: the actual extension, the gallery and
// workshop scenes, and a real PHP issuer (isolated copy) with standard-conforming classes injected for the test.
// Run with a display, for example
//   xvfb-run -a node test/manual-item-effects.js
//
// Proves: (1) a standard item is recognised and verified against the issuer's spec by its signed digest, and a
// legacy hat keeps its speed buff in every world; (2) policy.itemEffects decides per world which stats,
// multipliers and capabilities apply: not declared, false, a narrow list, everything, a manifest-level default
// the world's own value overrides; (3) the accepted-classes and trusted-issuers filters are honoured; (4) an item
// the issuer says it never signed, or whose issuer cannot be reached, applies nothing, and appearance is kept;
// (5) the Stats sub-menu shows active buffs, capabilities, and the withheld effects with the world's reason;
// (6) the 3D renderer receives only the effective multipliers, and the 2D workshop uses its own policy;
// (7) a verified credential supersession keeps the item equipped; (8) the capability interface lists the active
// capabilities, carried consumables included, and tells listeners when the world changes; (9) a second
// domain reached through a portal applies its own policy.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { StudioLab, makeIdentity, signPayload } = require('./studio-lab');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'item-effects-profile-'));

function assertTrue(cond, msg) { if (!cond) throw new Error(msg); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const MODEL = '/assets/studio/badge.glb';
const CLASSES = {
  'atlas.wearable.ring.fx_luck': { name: 'Fx Luck Ring', modelPath: MODEL, properties: { 'atlas.avatar.stat.luck': '3' }, itemSpec: { category: 'equipment', slot: 'ring', stats: { luck: { min: '1', max: '5' } } } },
  'atlas.wearable.ring.fx_ghost': { name: 'Fx Ghost Ring', modelPath: MODEL, properties: { 'atlas.avatar.stat.luck': '2' }, itemSpec: { category: 'equipment', slot: 'ring', stats: { luck: { min: '1', max: '4' } } } },
  'atlas.wearable.ring.fx_offline': { name: 'Fx Offline Ring', modelPath: MODEL, properties: { 'atlas.avatar.stat.luck': '2' }, itemSpec: { category: 'equipment', slot: 'ring', stats: { luck: { min: '1', max: '6' } } } },
  'atlas.wearable.boots.fx_boots': { name: 'Fx Boots', modelPath: MODEL, properties: { 'atlas.avatar.shoeColor': '#3366aa', 'atlas.avatar.stat.agility': '4', 'atlas.avatar.speedMultiplier': '1.4', 'atlas.avatar.jumpMultiplier': '1.2' }, itemSpec: { category: 'equipment', slot: 'shoes', stats: { agility: { min: '1', max: '5' } }, multipliers: { speed: { min: '1', max: '1.5' }, jump: { min: '1', max: '1.5' } } } },
  'atlas.wearable.hat.fx_hat': { name: 'Fx Hat', modelPath: MODEL, properties: { 'atlas.avatar.hatColor': '#aa3333', 'atlas.avatar.speedMultiplier': '1.3' }, itemSpec: { category: 'equipment', slot: 'hat', multipliers: { speed: { min: '1', max: '1.5' } } } },
  'atlas.tool.fx_pickaxe': { name: 'Fx Pickaxe', modelPath: MODEL, properties: { 'atlas.cap.mine.tier': '2' }, itemSpec: { category: 'tool', slot: 'hand', capabilities: ['atlas.cap.mine'], capabilityParams: { 'atlas.cap.mine': { tier: { min: '1', max: '3' } } } } },
  'atlas.tool.fx_compass': { name: 'Fx Compass', modelPath: MODEL, properties: {}, itemSpec: { category: 'tool', slot: 'trinket', capabilities: ['atlas.cap.compass'] } },
  'atlas.consumable.fx_dynamite': { name: 'Fx Dynamite', modelPath: MODEL, properties: { 'atlas.cap.blast.radius': '3' }, itemSpec: { category: 'consumable', uses: '1', capabilities: ['atlas.cap.blast'], capabilityParams: { 'atlas.cap.blast': { radius: { min: '2', max: '6' } } } } }
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

  // The gallery (3D) and workshop (2D) worlds and their models, served by the same PHP issuer.
  const B = path.join(REPO, 'demo-domain-b');
  for (const dir of ['spatial', 'assets']) fs.cpSync(path.join(B, dir), path.join(lab.docroot, dir), { recursive: true });
  fs.copyFileSync(path.join(B, 'index.html'), path.join(lab.docroot, 'index.html'));
  fs.copyFileSync(path.join(B, 'favicon.svg'), path.join(lab.docroot, 'favicon.svg'));
  const manifest = JSON.parse(fs.readFileSync(path.join(B, '.well-known', 'spatial.json'), 'utf8'));
  manifest.domain = lab.host;
  const gallery = manifest.worlds.find((w) => w.id === 'gallery');
  const workshop = manifest.worlds.find((w) => w.id === 'workshop');
  for (const w of manifest.worlds) for (const p of w.portals || []) if (p.kind === 'domain') p.to = 'localhost:1', p.manifest = 'http://localhost:1/.well-known/spatial.json';
  const ALL = { stats: 'all', multipliers: 'all', capabilities: ['atlas.cap.compass', 'atlas.cap.mine', 'atlas.cap.dig', 'atlas.cap.light', 'atlas.cap.blast', 'atlas.cap.unlock'] };
  const clone = (id, name, policy) => {
    const policyBase = Object.assign({}, gallery.policy);
    delete policyBase.acceptedItemClasses;
    manifest.worlds.push(Object.assign({}, gallery, { id, name, policy: Object.assign(policyBase, policy), portals: [] }));
  };
  manifest.itemEffects = { stats: ['luck'] };
  // Policy-only cases run in 2D clones of the workshop, which load much faster than a 3D scene.
  const clone2d = (id, name, policy) => {
    const policyBase = Object.assign({}, workshop.policy);
    delete policyBase.acceptedItemClasses;
    manifest.worlds.push(Object.assign({}, workshop, { id, name, policy: Object.assign(policyBase, policy), portals: [] }));
  };
  clone2d('fx-default', 'Fx Default', {});
  clone('fx-off', 'Fx Off', { itemEffects: false });
  clone2d('fx-empty', 'Fx Empty', { itemEffects: {} });
  clone('fx-narrow', 'Fx Narrow', { itemEffects: { stats: ['luck'], multipliers: ['speed'], capabilities: ['atlas.cap.compass'] } });
  clone('fx-all', 'Fx All', { itemEffects: ALL });
  clone2d('fx-tools', 'Fx Tools Only', { itemEffects: ALL, acceptedItemClasses: ['atlas.tool.*', 'atlas.consumable.*'] });
  clone2d('fx-distrust', 'Fx Distrust', { itemEffects: ALL, trustedIssuers: ['other.example.net'] });
  clone2d('fx-self', 'Fx Self', { itemEffects: ALL, trustedIssuers: 'self' });
  workshop.policy = Object.assign({}, workshop.policy, { itemEffects: { stats: ['luck', 'agility'] } });
  delete workshop.policy.acceptedItemClasses;
  // A second domain, reached through a portal, with its own policy.
  const other = JSON.parse(JSON.stringify(manifest));
  other.itemEffects = undefined;
  other.defaultWorld = 'fx-all';
  other.worlds = other.worlds.filter((w) => w.id === 'fx-all' || w.id === 'fx-off');
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(manifest, null, 2));
  fs.mkdirSync(path.join(lab.docroot, 'second', '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, 'second', '.well-known', 'spatial.json'), JSON.stringify(other, null, 2));
  console.log('SETUP: PHP issuer with the gallery, the workshop and ' + (manifest.worlds.length - 2) + ' policy worlds on ' + lab.origin);

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
  // Spec lookups the test makes fail on purpose: by digest, 'unknown' (the issuer says it never signed it) or
  // 'down' (the issuer cannot answer).
  const specFaults = new Map();
  let specFetches = 0;
  await context.route((url) => url.pathname === '/atlas/asset/class' && url.searchParams.has('specDigest'), async (route) => {
    specFetches += 1;
    const digest = new URL(route.request().url()).searchParams.get('specDigest');
    const fault = specFaults.get(digest);
    const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (fault === 'unknown') return route.fulfill({ status: 404, headers: cors, body: JSON.stringify({ error: 'unknown item spec', code: 'item-spec-unknown' }) });
    if (fault === 'down') return route.fulfill({ status: 503, headers: cors, body: JSON.stringify({ error: 'try later' }) });
    return route.fallback();
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
    await walletPage.locator('#newPasswordInput').fill('item-effects-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('item-effects-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const identity = await walletPage.evaluate(async () => { const i = await AtlasWallet.getIdentity(); return i ? { publicKey: i.publicKey } : null; });
    assertTrue(identity && identity.publicKey, 'identity created');
    console.log('PASS: identity ' + identity.publicKey.slice(0, 12) + '…');

    console.log('STEP 2: minting standard items and a legacy hat from the issuer');
    const claim = (credential) => walletPage.evaluate(async ({ o, origin, cred }) => { const e = await AtlasWallet.queueBridgeOffer(o, origin, cred); await AtlasWallet.claimBridgeOffer(o, e.id); return cred.id; }, { o: identity.publicKey, origin: lab.origin, cred: credential });
    const adminPayload = (action, body) => Object.assign({}, body, { adminAuth: { action, domain: lab.host, issuedAt: new Date().toISOString(), nonce: crypto.randomBytes(12).toString('hex') } });
    const adminCall = async (route, body) => { const payload = adminPayload(route, body); return lab.postRaw(route, { payload, proof: signPayload(admin, payload) }); };
    const ids = {};
    const creds = {};
    for (const [key, cls] of Object.entries({
      luck: 'atlas.wearable.ring.fx_luck', ghost: 'atlas.wearable.ring.fx_ghost', offline: 'atlas.wearable.ring.fx_offline', boots: 'atlas.wearable.boots.fx_boots', hat: 'atlas.wearable.hat.fx_hat',
      pick: 'atlas.tool.fx_pickaxe', compass: 'atlas.tool.fx_compass', dynamite: 'atlas.consumable.fx_dynamite'
    })) {
      const r = await adminCall('/atlas/asset/mint', { ownerPublicKey: identity.publicKey, assetClass: cls });
      assertTrue(r.status === 200, 'mint ' + key + ': ' + r.text);
      assertTrue(r.json.asset.properties['atlas.item.standard'] === '0.1' && /^[0-9a-f]{64}$/.test(r.json.asset.properties['atlas.item.specDigest']), key + ' carries the standard marker and a spec digest');
      creds[key] = r.json;
      ids[key] = await claim(r.json);
    }
    const legacy = await lab.postRaw('/atlas/asset/issue', { ownerPublicKey: identity.publicKey, assetClass: 'atlas.avatar.hat.sunhat' });
    assertTrue(legacy.status === 200, 'issue legacy hat: ' + legacy.text);
    ids.legacyHat = await claim(legacy.json);
    const legacySpeed = Number(legacy.json.asset.properties['atlas.avatar.hatSpeedMultiplier']);
    assertTrue(legacySpeed > 0 && !Object.keys(legacy.json.asset.properties).some((k) => k.startsWith('atlas.item.')), 'the legacy hat has a speed multiplier ' + legacySpeed + ' and no standard properties');
    specFaults.set(creds.ghost.asset.properties['atlas.item.specDigest'], 'unknown');
    specFaults.set(creds.offline.asset.properties['atlas.item.specDigest'], 'down');
    console.log('PASS: ' + Object.keys(ids).length + ' items in the wallet');

    console.log('STEP 3: entering the gallery');
    const site = await context.newPage();
    site.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
    await site.goto(lab.origin + '/', { waitUntil: 'load' });
    await site.locator('#domain-atlas-enter-btn').click();
    const overlay = await site.waitForSelector('#domain-atlas-overlay', { timeout: 40000 });
    const frame = await overlay.contentFrame();
    frame.on('pageerror', (e) => console.log('FRAMEERROR', String(e)));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), null, { timeout: 40000 });

    const enter = async (worldId, name, is3D) => {
      await frame.evaluate(() => { window.__prev3D = window.__atlasActive3D || null; window.__effectEvents = 0; window.AtlasCapabilities.onChange(() => { window.__effectEvents += 1; }); });
      await frame.evaluate((id) => followPortal({ kind: 'world', to: id }), worldId);
      await frame.waitForFunction((n) => document.getElementById('placeLabel').textContent.includes(n), name, { timeout: 40000 });
      if (is3D) {
        await frame.waitForFunction(() => window.__atlasActive3D && window.__atlasActive3D !== window.__prev3D, null, { timeout: 40000 });
        await frame.evaluate(() => window.__atlasActive3D.ready);
      }
    };
    const equip = (fn, ...args) => walletPage.evaluate(async ({ fn, args }) => AtlasWallet[fn](...args), { fn, args });
    const reapply = () => frame.evaluate(() => reapplyEquipment());
    const state = () => frame.evaluate(async () => {
      const fx = await AtlasWallet.getEquipmentEffects();
      const caps = await AtlasCapabilities.active();
      const bySlot = {};
      for (const i of fx.items) bySlot[i.slot] = { standard: i.standard, verdict: i.verdict, effects: Object.fromEntries(i.effects.map((e) => [e.kind + ':' + e.id, e.active ? 'on' : e.reason])) };
      return {
        stats: Object.fromEntries(fx.sheet.stats.map((s) => [s.id, s.total])), movement: fx.sheet.movement, bySlot,
        caps: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.map((p) => p.source + ':' + (p.slot || '-') + ':' + JSON.stringify(p.params))])),
        hat: localAvatarHatInfo, shoes: localAvatarShoesInfo, extras: localAvatarExtrasInfo,
        hatNow: await AtlasWallet.getAvatarHat(), shoesNow: await AtlasWallet.getAvatarShoes(),
        live: active3D ? { hatSpeed: active3D.getLocalAvatarHatSpeedMultiplier(), shoeSpeed: active3D.getLocalAvatarShoeSpeedMultiplier(), shoeJump: active3D.getLocalAvatarShoeJumpMultiplier(), extras: active3D.getLocalAvatarExtras() } : null,
        ctxWorld: AtlasWallet.getItemEffectsContext() && AtlasWallet.getItemEffectsContext().worldId
      };
    });
    const near = (a, b) => Math.abs(a - b) < 1e-6;

    console.log('STEP 4: a world that turns itemEffects off: standard items are recognised but add nothing, legacy gear still works');
    await equip('setAvatarHat', ids.legacyHat);
    await equip('setAvatarShoes', ids.boots);
    await equip('setAvatarSlot', 'ring1', ids.luck);
    await equip('setAvatarHand', ids.pick);
    await equip('setAvatarSlot', 'trinket1', ids.compass);
    await enter('fx-off', 'Fx Off', true);
    let s = await state();
    assertTrue(s.ctxWorld === 'fx-off', 'the wallet knows the current world');
    assertTrue(s.bySlot.shoes.standard && s.bySlot.shoes.verdict === 'verified', 'the boots are recognised and verified against the issuer spec: ' + JSON.stringify(s.bySlot.shoes));
    assertTrue(s.bySlot.ring1.effects['stat:luck'] === 'world-effects-off' && s.bySlot.shoes.effects['multiplier:speed'] === 'world-effects-off' && s.bySlot.hand.effects['capability:atlas.cap.mine'] === 'world-effects-off', 'their effects are withheld as unsupported: ' + JSON.stringify(s.bySlot));
    assertTrue(s.bySlot.hat.standard === false && s.bySlot.hat.verdict === 'legacy', 'the legacy hat is not treated as standard');
    assertTrue(near(s.hat.speedMultiplier, legacySpeed) && near(s.live.hatSpeed, legacySpeed), 'the legacy hat keeps its speed multiplier ' + legacySpeed + ' in the 2D-less 3D world, live in the renderer');
    assertTrue(s.stats.luck === 10 && s.stats.agility === 10, 'stats stay at base: ' + JSON.stringify(s.stats));
    assertTrue(near(s.shoes.speedMultiplier, 1) && near(s.live.shoeSpeed, 1) && near(s.live.shoeJump, 1), 'the renderer gets no shoe multiplier');
    assertTrue(s.shoes.shoeColor === '#3366aa', 'but the boots still look like boots');
    assertTrue(Object.keys(s.caps).length === 0, 'no capabilities are active');
    const fits = await walletPage.evaluate(async (o) => {
      const wallet = await AtlasWallet.getWallet(o);
      return Object.fromEntries(wallet.map((e) => [e.credential.asset.class, AtlasWallet.avatarSlotsOfAsset(e.credential.asset)]));
    }, identity.publicKey);
    assertTrue(same(fits['atlas.tool.fx_pickaxe'], ['hand']) && same(fits['atlas.tool.fx_compass'], ['trinket1', 'trinket2']) && same(fits['atlas.wearable.ring.fx_luck'], ['ring1', 'ring2']) && same(fits['atlas.wearable.boots.fx_boots'], ['shoes']) && same(fits['atlas.wearable.hat.fx_hat'], ['hat']), 'each standard item is offered for the slot its spec names, and a standard hand tool is holdable: ' + JSON.stringify(fits));
    assertTrue(fits['atlas.consumable.fx_dynamite'].length === 0, 'a consumable fits no equipment slot');
    assertTrue(await frame.evaluate(() => window.__effectEvents) >= 1, 'listeners were told the world changed');
    console.log('PASS: nothing applies where nothing is declared; legacy gear and appearance are unaffected');

    console.log('STEP 5: the Stats sub-menu names what is active and what is not');
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => document.getElementById('characterScreen').classList.contains('active') && !!window.__atlasCharacterPreview, null, { timeout: 60000 });
    await frame.locator('.character-subtab[data-view="stats"]').click();
    await frame.waitForFunction(() => !document.getElementById('characterStatsView').hidden, null, { timeout: 5000 });
    const panel = () => frame.evaluate(() => ({
      stats: Object.fromEntries(Array.from(document.querySelectorAll('#characterStatsList .stat-row')).map((r) => [r.dataset.stat, r.querySelector('.stat-value').textContent])),
      buffs: Array.from(document.querySelectorAll('#characterBuffList .buff-row')).map((r) => r.dataset.buff),
      caps: Array.from(document.querySelectorAll('#characterCapabilityList .buff-row')).map((r) => r.dataset.capability),
      inactive: Object.fromEntries(Array.from(document.querySelectorAll('#characterInactiveList .buff-row')).map((r) => [r.dataset.inactive, r.dataset.reason])),
      inactiveText: Array.from(document.querySelectorAll('#characterInactiveList .buff-row')).map((r) => r.textContent)
    }));
    let p = await panel();
    assertTrue(p.buffs.length === 0 || !p.buffs.includes('luck'), 'no luck buff is listed: ' + JSON.stringify(p.buffs));
    assertTrue(p.inactive['ring1:stat:luck'] === 'world-effects-off' && p.inactive['shoes:multiplier:speed'] === 'world-effects-off' && p.inactive['hand:capability:atlas.cap.mine'] === 'world-effects-off' && p.inactive['trinket1:capability:atlas.cap.compass'] === 'world-effects-off', 'the window lists the withheld effects with the world reason: ' + JSON.stringify(p.inactive));
    assertTrue(p.inactiveText.some((t) => t.includes("This world doesn't support item effects") && t.includes('Luck +3') && t.includes('Fx Luck Ring')), 'with readable text: ' + JSON.stringify(p.inactiveText.slice(0, 2)));
    assertTrue(p.caps.length === 0, 'no capability is listed as active');
    console.log('PASS: the window separates buffs from effects this world does not support');

    console.log('STEP 6: a narrow policy enables only what it lists');
    await enter('fx-narrow', 'Fx Narrow', true);
    s = await state();
    assertTrue(s.stats.luck === 13 && s.stats.agility === 10, 'luck +3 applies, agility +4 does not: ' + JSON.stringify(s.stats));
    assertTrue(near(s.shoes.speedMultiplier, 1.4) && near(s.live.shoeSpeed, 1.4), 'the enabled shoe speed multiplier reaches the renderer');
    assertTrue(near(s.shoes.jumpMultiplier, 1) && near(s.live.shoeJump, 1), 'the shoe jump multiplier, not listed, does not');
    assertTrue(s.bySlot.shoes.effects['stat:agility'] === 'effect-not-enabled' && s.bySlot.shoes.effects['multiplier:jump'] === 'effect-not-enabled', 'the rest are withheld as not enabled');
    assertTrue(same(Object.keys(s.caps), ['atlas.cap.compass']) && s.caps['atlas.cap.compass'][0] === 'equipped:trinket1:{}', 'only the compass capability is active: ' + JSON.stringify(s.caps));
    assertTrue(s.bySlot.hand.effects['capability:atlas.cap.mine'] === 'effect-not-enabled', 'the pickaxe stays inert');
    assertTrue(near(s.hat.speedMultiplier, legacySpeed), 'the legacy hat is unchanged');
    await frame.waitForFunction(() => !!document.querySelector('#characterCapabilityList [data-capability="atlas.cap.compass"]'), null, { timeout: 15000 });
    p = await panel();
    assertTrue(p.buffs.includes('luck') && p.buffs.includes('speed') && !p.buffs.includes('agility'), 'the window lists luck and speed as active buffs: ' + JSON.stringify(p.buffs));
    assertTrue(p.caps.join() === 'atlas.cap.compass' && p.inactive['hand:capability:atlas.cap.mine'] === 'effect-not-enabled' && p.inactive['shoes:stat:agility'] === 'effect-not-enabled', 'and the capability and withheld effects: ' + JSON.stringify(p.inactive));
    console.log('PASS: per-effect gating works for stats, multipliers and capabilities');

    console.log('STEP 7: a world that enables everything');
    await equip('setAvatarHat', ids.hat);
    await enter('fx-all', 'Fx All', true);
    s = await state();
    assertTrue(s.stats.luck === 13 && s.stats.agility === 14, 'luck and agility both apply: ' + JSON.stringify(s.stats));
    assertTrue(near(s.shoes.speedMultiplier, 1.4) && near(s.shoes.jumpMultiplier, 1.2) && near(s.live.shoeJump, 1.2), 'both shoe multipliers apply');
    assertTrue(near(s.hat.speedMultiplier, 1.3) && near(s.live.hatSpeed, 1.3), "the standard hat's generic speed multiplier is applied as the hat's: " + s.hat.speedMultiplier);
    assertTrue(near(s.extras.speedMultiplier, 1.04) && near(s.live.extras.speed, 1.04), 'the agility bonus reaches movement (+4%)');
    assertTrue(same(Object.keys(s.caps).sort(), ['atlas.cap.blast', 'atlas.cap.compass', 'atlas.cap.mine']), 'compass and mine (equipped) and blast (carried dynamite) are active: ' + JSON.stringify(s.caps));
    assertTrue(s.caps['atlas.cap.mine'][0] === 'equipped:hand:{"tier":2}', 'mine reports its tier and slot');
    assertTrue(Object.values(s.bySlot).every((i) => Object.values(i.effects).every((v) => v === 'on')), 'nothing is withheld');
    await frame.waitForFunction(() => document.getElementById('characterInactiveList').textContent.includes('Everything equipped works'), null, { timeout: 15000 });
    p = await panel();
    assertTrue(p.inactiveText.length === 0 && (await frame.evaluate(() => document.getElementById('characterInactiveList').textContent)).includes('Everything equipped works'), 'the window says everything works here');
    console.log('PASS: everything applies where everything is enabled');

    console.log('STEP 8: the capability interface includes carried consumables and follows the world');
    assertTrue(s.caps['atlas.cap.blast'][0] === 'carried:-:{"radius":3}', 'the carried dynamite provides blast with its radius');
    const iface = await frame.evaluate(async () => ({
      ids: AtlasItemEffects.CAPABILITY_IDS,
      mine: (await AtlasCapabilities.providers('atlas.cap.mine')).map((x) => x.slot + ':' + x.params.tier + ':' + x.name),
      dig: (await AtlasCapabilities.providers('atlas.cap.dig')).length,
      blast: (await AtlasCapabilities.providers('atlas.cap.blast')).map((x) => x.source + ':' + x.uses)
    }));
    assertTrue(same(iface.ids, ['atlas.cap.compass', 'atlas.cap.mine', 'atlas.cap.dig', 'atlas.cap.light', 'atlas.cap.blast', 'atlas.cap.unlock']), 'the six capability ids are published in order');
    assertTrue(same(iface.mine, ['hand:2:Fx Pickaxe']) && iface.dig === 0 && same(iface.blast, ['carried:1']), 'providers() answers per capability: ' + JSON.stringify(iface));
    await equip('setAvatarHand', null);
    await reapply();
    assertTrue(!('atlas.cap.mine' in (await state()).caps), 'putting the pickaxe away removes the capability');
    await equip('setAvatarHand', ids.pick);
    await reapply();
    assertTrue((await state()).caps['atlas.cap.mine'].length === 1, 'and equipping it brings it back');
    console.log('PASS: the capability interface is ready for an action bar to read');

    console.log('STEP 9: accepted classes, trusted issuers and the manifest-level default');
    await equip('setAvatarHat', ids.legacyHat);
    await enter('fx-tools', 'Fx Tools Only', false);
    s = await state();
    assertTrue(s.bySlot.ring1.effects['stat:luck'] === 'class-not-accepted' && s.bySlot.shoes.effects['multiplier:speed'] === 'class-not-accepted', 'wearables are withheld where only tools are accepted: ' + JSON.stringify(s.bySlot.ring1));
    assertTrue(s.bySlot.hand.effects['capability:atlas.cap.mine'] === 'on' && s.bySlot.trinket1.effects['capability:atlas.cap.compass'] === 'on' && s.caps['atlas.cap.blast'], 'tools and the consumable still work');
    assertTrue(s.stats.luck === 10 && near(s.shoesNow.speedMultiplier, 1) && near(s.hatNow.speedMultiplier, legacySpeed), 'stats and shoe multipliers are withheld, the legacy hat is not');
    await enter('fx-distrust', 'Fx Distrust', false);
    s = await state();
    assertTrue(Object.values(s.bySlot).filter((i) => i.standard).every((i) => Object.values(i.effects).every((v) => v === 'issuer-not-trusted')), 'an untrusted issuer gets nothing: ' + JSON.stringify(s.bySlot));
    assertTrue(Object.keys(s.caps).length === 0 && near(s.hatNow.speedMultiplier, legacySpeed), 'no capabilities, legacy hat unchanged');
    await enter('fx-self', 'Fx Self', false);
    s = await state();
    assertTrue(s.stats.luck === 13 && Object.values(s.bySlot).every((i) => Object.values(i.effects).every((v) => v === 'on')), "trustedIssuers 'self' accepts the world's own domain");
    await enter('fx-default', 'Fx Default', false);
    s = await state();
    assertTrue(s.stats.luck === 13 && s.stats.agility === 10, 'a world without itemEffects uses the manifest default (luck only): ' + JSON.stringify(s.stats));
    assertTrue(s.bySlot.shoes.effects['stat:agility'] === 'effect-not-enabled' && near(s.shoesNow.speedMultiplier, 1), 'the default does not enable the rest');
    await enter('fx-off', 'Fx Off', true);
    s = await state();
    assertTrue(s.stats.luck === 10 && s.bySlot.ring1.effects['stat:luck'] === 'world-effects-off', "the world's own false wins over the default");
    await enter('fx-empty', 'Fx Empty', false);
    s = await state();
    assertTrue(s.stats.luck === 10 && s.bySlot.ring1.effects['stat:luck'] === 'effect-not-enabled', "the world's own empty object wins over the default and enables nothing");
    assertTrue(near(s.hatNow.speedMultiplier, legacySpeed), 'the legacy hat still has its buff in every one of these worlds');
    console.log('PASS: filters and the section 3.4.1 default and override behave as specified');

    console.log('STEP 10: an item the issuer disowns, or cannot confirm, applies nothing');
    await enter('fx-all', 'Fx All', true);
    await equip('setAvatarSlot', 'ring2', ids.ghost);
    await reapply();
    s = await state();
    assertTrue(s.bySlot.ring2.verdict === 'invalid' && s.bySlot.ring2.effects['stat:luck'] === 'item-invalid', 'an item whose spec the issuer never signed is invalid: ' + JSON.stringify(s.bySlot.ring2));
    assertTrue(s.stats.luck === 13, 'its luck bonus does not count');
    await equip('setAvatarSlot', 'ring2', ids.offline);
    await reapply();
    s = await state();
    assertTrue(s.bySlot.ring2.verdict === 'unverified' && s.bySlot.ring2.effects['stat:luck'] === 'item-unverified' && s.stats.luck === 13, 'an item the issuer cannot confirm is unverified and adds nothing');
    await frame.waitForFunction(() => !!document.querySelector('#characterInactiveList [data-inactive="ring2:stat:luck"]'), null, { timeout: 15000 });
    p = await panel();
    assertTrue(p.inactive['ring2:stat:luck'] === 'item-unverified', 'the window says so');
    const fetchesBefore = specFetches;
    await state();
    await state();
    assertTrue(specFetches === fetchesBefore, 'verified specs are cached and a failed lookup is not retried at once (' + (specFetches - fetchesBefore) + ' extra lookups)');
    await equip('setAvatarSlot', 'ring2', null);
    await reapply();
    console.log('PASS: unknown and unreachable specs are inert, and lookups are not repeated');

    console.log('STEP 11: a verified supersession keeps the item equipped');
    const reissued = await adminCall('/atlas/asset/reissue', { credential: creds.luck, properties: { 'atlas.avatar.stat.luck': '4' } });
    assertTrue(reissued.status === 200 && reissued.json.newCredential && reissued.json.newCredential.supersedes === ids.luck, 'the issuer reissued the ring: ' + reissued.text.slice(0, 200));
    const newId = reissued.json.newCredential.id;
    await walletPage.evaluate(async () => { try { await AtlasWallet.checkAllMail(); } catch (err) { /* reported below through the wallet state */ } });
    await frame.waitForFunction(async (id) => (await AtlasWallet.getAvatarSlotAssetId('ring1')) === id, newId, { timeout: 20000 });
    const walletAfter = await walletPage.evaluate((o) => AtlasWallet.getWallet(o).then((w) => w.map((e) => e.credential.id)), identity.publicKey);
    assertTrue(walletAfter.includes(newId) && !walletAfter.includes(ids.luck), 'the wallet holds the replacement and not the old credential');
    await frame.waitForFunction(async () => (await AtlasWallet.getEquipmentEffects()).sheet.stats.find((x) => x.id === 'luck').total === 14, null, { timeout: 10000 });
    s = await state();
    assertTrue(s.bySlot.ring1.verdict === 'verified' && s.bySlot.ring1.effects['stat:luck'] === 'on' && s.stats.luck === 14, 'the ring is still equipped, verified, and now gives +4: ' + JSON.stringify(s.stats));
    ids.luck = newId;
    console.log('PASS: the equipped slot followed the superseded credential');

    console.log('STEP 12: the 2D workshop uses its own policy');
    await enter('workshop', 'Neighbor Workshop', false);
    assertTrue(await frame.evaluate(() => !window.__atlasActive3D || window.__atlasActive3D === window.__prev3D), 'the workshop is not a 3D scene');
    s = await state();
    assertTrue(s.ctxWorld === 'workshop', 'the wallet context follows the 2D world');
    assertTrue(s.stats.luck === 14 && s.stats.agility === 14, 'the workshop enables luck and agility: ' + JSON.stringify(s.stats));
    assertTrue(s.bySlot.shoes.effects['multiplier:speed'] === 'effect-not-enabled' && s.bySlot.hand.effects['capability:atlas.cap.mine'] === 'effect-not-enabled', 'multipliers and capabilities are not enabled there');
    assertTrue(Object.keys(s.caps).length === 0, 'no capability is active in the workshop');
    // The character window opened in step 5 is still open and follows the world.
    await frame.waitForFunction(() => document.getElementById('characterScreen').classList.contains('active') && !!document.querySelector('#characterInactiveList [data-inactive="shoes:multiplier:speed"]'), null, { timeout: 30000 });
    p = await panel();
    assertTrue(p.buffs.includes('luck') && p.buffs.includes('agility') && p.inactive['shoes:multiplier:speed'] === 'effect-not-enabled', 'the Stats window in the 2D world shows the same split');
    console.log('PASS: 2D worlds apply their own policy');

    console.log('STEP 13: a portal to another domain switches policy');
    await enter('fx-off', 'Fx Off', true);
    assertTrue((await state()).stats.luck === 10, 'luck is withheld in the first domain');
    await frame.evaluate((url) => { window.__prev3D = window.__atlasActive3D; return followPortal({ kind: 'domain', to: location.host, manifest: url }); }, lab.origin + '/second/.well-known/spatial.json');
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Fx All') && window.__atlasActive3D && window.__atlasActive3D !== window.__prev3D, null, { timeout: 60000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    s = await state();
    assertTrue(s.ctxWorld === 'fx-all' && s.stats.luck === 14 && s.stats.agility === 14, 'the second domain enables everything, so luck and agility apply: ' + JSON.stringify(s.stats));
    assertTrue(near(s.live.shoeSpeed, 1.4), 'and the renderer received the shoe multiplier');
    console.log('PASS: the policy follows the character across a domain portal');

    ok = true;
  } catch (err) {
    console.log('FAIL: ' + (err && err.stack ? err.stack : err));
  } finally {
    await context.close();
    await lab.stop();
    lab.cleanup();
  }
  console.log(ok ? '\nITEM EFFECTS BROWSER CHECK PASSED' : '\nITEM EFFECTS BROWSER CHECK FAILED');
  process.exit(ok ? 0 : 1);
})();
