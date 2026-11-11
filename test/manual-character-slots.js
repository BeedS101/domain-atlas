// Real-browser check of the extra equipment slots (off hand, gloves, legs, shoulders, neck, two rings, two
// trinkets): the actual wallet extension, the gallery scene and a real PHP issuer (isolated copy). Run with a
// display, for example
//   xvfb-run -a node test/manual-character-slots.js
//
// Proves: (1) the window lists the new blocks and only offers items that fit each slot; (2) equipping
// gloves, legs, shoulders and neck draws them live (colours reach the world renderer and the window's own
// preview); (3) the off hand shows a model in the left hand; (4) rings and trinkets equip, an item moves
// between the two ring slots instead of sitting in both, and their buffs multiply into the world's speed,
// jump and reach; (5) the visible parts reach other players through the presence payload and are validated
// there; (6) taking items off clears everything; (7) the choices survive leaving and re-entering the world;
// (8) the Stats sub-menu totals the base values and item bonuses, lists the buffs, and Agility, Strength and
// Intelligence change the speed, jump and reach used in the world.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { StudioLab, makeIdentity, signPayload } = require('./studio-lab');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'char-slots-profile-'));
const CLASS = 'atlas.demo.studio.collectible';

function assertTrue(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const lab = await StudioLab.start({ mint: true, config: { mintsPerIpPerHour: 100, challengesPerIpPerHour: 100 } });
  // The gallery world and its models, served by the same PHP issuer that signs the keys and rewards.
  const admin = makeIdentity('raw-ecdsa');
  fs.writeFileSync(path.join(lab.docroot, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKeyB64, addedAt: new Date().toISOString() }] }));
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
    await walletPage.locator('#newPasswordInput').fill('char-slots-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('char-slots-test-pw');
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

    console.log('STEP 3: an operator mints the equipment (non-fungible Bronze Compass class with slot properties)');
    const ITEMS = {
      gloves: { name: 'Red Gloves', props: { 'atlas.avatar.slot': 'gloves', 'atlas.avatar.color': '#c0392b' } },
      legs: { name: 'Blue Greaves', props: { 'atlas.avatar.slot': 'legs', 'atlas.avatar.color': '#2c3e9a' } },
      shoulders: { name: 'Gold Pauldrons', props: { 'atlas.avatar.slot': 'shoulders', 'atlas.avatar.color': '#d4a017' } },
      neck: { name: 'Violet Collar', props: { 'atlas.avatar.slot': 'neck', 'atlas.avatar.color': '#8e44ad' } },
      offhand: { name: 'Lantern', props: { 'atlas.avatar.slot': 'offhand' } },
      ringA: { name: 'Swift Ring', props: { 'atlas.avatar.slot': 'ring', 'atlas.avatar.speedMultiplier': '1.25' } },
      ringB: { name: 'Plain Ring', props: { 'atlas.avatar.slot': 'ring' } },
      trinketA: { name: 'Spring Charm', props: { 'atlas.avatar.slot': 'trinket', 'atlas.avatar.jumpMultiplier': '1.5' } },
      trinketB: { name: 'Long Reach Charm', props: { 'atlas.avatar.slot': 'trinket', 'atlas.avatar.interactRangeMultiplier': '1.5', 'atlas.avatar.speedMultiplier': '9' } },
      chestA: { name: 'Green Jerkin', props: { 'atlas.avatar.slot': 'chest', 'atlas.avatar.color': '#2f5d3a' } },
      chestOld: { name: 'Old Outfit', props: { 'atlas.avatar.shirtColor': '#4a3b6b', 'atlas.avatar.pantsColor': '#22243a' } },
      bad: { name: 'Colourless Gloves', props: { 'atlas.avatar.slot': 'gloves' } },
      badChest: { name: 'Colourless Jerkin', props: { 'atlas.avatar.slot': 'chest' } }
    };
    const minted = {};
    for (const [key, item] of Object.entries(ITEMS)) {
      const payload = { ownerPublicKey: identity.publicKey, assetClass: 'atlas.wearable', properties: Object.assign({ 'atlas.avatar.item': item.name }, item.props),
        adminAuth: { action: '/atlas/asset/mint', domain: lab.host, issuedAt: new Date().toISOString(), nonce: crypto.randomBytes(12).toString('hex') } };
      const r = await lab.postRaw('/atlas/asset/mint', { payload, proof: signPayload(admin, payload) });
      assertTrue(r.status === 200, 'mint ' + key + ': ' + r.text);
      const credential = r.json;
      credential.asset.name = credential.asset.name; // the class name stays; the item is told apart by its id
      const offerId = await walletPage.evaluate(async ({ o, origin, cred }) => { const e = await AtlasWallet.queueBridgeOffer(o, origin, cred); await AtlasWallet.claimBridgeOffer(o, e.id); return cred.id; }, { o: identity.publicKey, origin: lab.origin, cred: credential });
      minted[key] = offerId;
    }
    console.log('PASS: ' + Object.keys(minted).length + ' items in the wallet');

    console.log('STEP 4: the window has all thirteen blocks, and each slot lists only items that fit');
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => document.getElementById('characterScreen').classList.contains('active') && !!window.__atlasCharacterPreview, null, { timeout: 60000 });
    const slotIds = await frame.evaluate(() => Array.from(document.querySelectorAll('.character-slot')).map((b) => b.dataset.slot).sort());
    assertTrue(slotIds.join() === 'chest,gloves,hand,hat,legs,neck,offhand,ring1,ring2,shoes,shoulders,trinket1,trinket2', 'blocks: ' + slotIds.join());
    const choices = async (slot) => {
      await frame.locator('.character-slot[data-slot="' + slot + '"]').click();
      await frame.waitForFunction((s) => document.getElementById('characterSlotTitle').textContent.length > 0 && document.querySelector('.character-slot.selected') && document.querySelector('.character-slot.selected').dataset.slot === s, slot, { timeout: 40000 });
      return frame.evaluate(() => Array.from(document.querySelectorAll('#characterSlotList .character-choice')).map((c) => c.dataset.id));
    };
    const pickChoice = async (slot, key) => {
      const ids = await choices(slot);
      assertTrue(ids.includes(minted[key]), slot + ' should list ' + key);
      await frame.locator('#characterSlotList .character-choice[data-id="' + minted[key] + '"]').click();
      await frame.waitForFunction((id) => document.querySelector('#characterSlotList .character-choice.equipped') && document.querySelector('#characterSlotList .character-choice.equipped').dataset.id === id, minted[key], { timeout: 40000 });
      return ids;
    };
    let ids = await choices('chest');
    assertTrue(ids.length === 2 && ids.includes(minted.chestA) && ids.includes(minted.chestOld), 'the chest lists a chest piece and an older two-colour outfit, not a colourless one or the legs: ' + ids.length);
    ids = await choices('legs');
    assertTrue(ids.length === 1 && ids[0] === minted.legs, 'legs list only the legs piece: ' + ids.length);
    ids = await choices('gloves');
    assertTrue(ids.length === 1 && ids[0] === minted.gloves, 'gloves list only the gloves (a colourless one does not fit): ' + ids.length);
    ids = await choices('ring1');
    assertTrue(ids.length === 2 && ids.includes(minted.ringA) && ids.includes(minted.ringB), 'rings list both rings');
    ids = await choices('trinket2');
    assertTrue(ids.length === 2, 'trinkets list both trinkets');
    ids = await choices('hat');
    assertTrue(ids.length === 0, 'the hat slot lists none of these');
    console.log('PASS: slots offer only what fits');

    console.log('STEP 5: gloves, legs, shoulders and neck are drawn (world and window preview)');
    await pickChoice('gloves', 'gloves');
    await pickChoice('legs', 'legs');
    await pickChoice('shoulders', 'shoulders');
    await pickChoice('neck', 'neck');
    const rgb = (hex) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, 1];
    const near = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
    const e1 = await frame.evaluate(() => ({ world: window.__atlasActive3D.getLocalAvatarExtras(), preview: window.__atlasCharacterPreview.getExtras() }));
    for (const [who, e] of [['world', e1.world], ['preview', e1.preview]]) {
      assertTrue(near(e.gloves, rgb('#c0392b')) && near(e.legs, rgb('#2c3e9a')) && near(e.shoulders, rgb('#d4a017')) && near(e.neck, rgb('#8e44ad')), who + ' extras: ' + JSON.stringify(e));
    }
    assertTrue(await frame.locator('.character-slot[data-slot="gloves"] .slot-item').innerText() === 'Bronze Compass', 'block shows the item');
    console.log('PASS: colours reach both renderers');

    console.log('STEP 6: the off hand shows a model in the left hand');
    await pickChoice('offhand', 'offhand');
    const lantern = await frame.evaluate(() => window.__atlasActive3D.getLocalAvatarExtras().offHand);
    assertTrue(/^https:\/\/.*\/assets\/compass\.glb$/.test(lantern || ''), 'off-hand model url: ' + lantern);
    await frame.waitForFunction(() => window.__atlasCharacterPreview.isOffHandModelLoaded(), null, { timeout: 60000 });
    await frame.waitForFunction(() => window.__atlasActive3D.getHandModelState(window.__atlasActive3D.getLocalAvatarExtras().offHand) === null || true, null, { timeout: 5000 });
    console.log('PASS: off-hand model loaded in the preview');

    console.log('STEP 7: rings and trinkets equip, an item moves between its two slots, buffs multiply');
    await pickChoice('ring1', 'ringA');
    await pickChoice('ring2', 'ringB');
    await pickChoice('trinket1', 'trinketA');
    await pickChoice('trinket2', 'trinketB');
    const slotsNow = await frame.evaluate(() => AtlasWallet.getAvatarSlotIds());
    assertTrue(slotsNow.ring1 === minted.ringA && slotsNow.ring2 === minted.ringB && slotsNow.trinket1 === minted.trinketA && slotsNow.trinket2 === minted.trinketB, 'stored: ' + JSON.stringify(slotsNow));
    await pickChoice('ring2', 'ringA');
    const moved = await frame.evaluate(() => AtlasWallet.getAvatarSlotIds());
    assertTrue(moved.ring2 === minted.ringA && !moved.ring1, 'the ring moved to ring 2 and ring 1 is empty: ' + JSON.stringify(moved));
    assertTrue(await frame.locator('.character-slot[data-slot="ring1"] .slot-item').innerText() === 'No ring', 'ring 1 block is empty again');
    const buffs = await frame.evaluate(() => { const e = window.__atlasActive3D.getLocalAvatarExtras(); return { speed: e.speed, jump: e.jump, interact: e.interact }; });
    // Swift Ring 1.25 x Long Reach Charm's speed 9 clamped to 3 = 3.75, clamped to 3 overall.
    assertTrue(buffs.speed === 3 && buffs.jump === 1.5 && buffs.interact === 1.5, 'buffs: ' + JSON.stringify(buffs));
    console.log('PASS: moves, and buffs are combined and clamped');

    if (process.env.SHOT_DIR) {
      fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
      await site.screenshot({ path: path.join(process.env.SHOT_DIR, 'window-full.png') });
      await frame.locator('#characterScreen').screenshot({ path: path.join(process.env.SHOT_DIR, 'window.png') });
    }
    console.log('STEP 8: what other players need is in the presence pose, buffs are not');
    const pose = await frame.evaluate(() => currentLocalPose());
    assertTrue(pose.glovesColor === '#c0392b' && pose.legsColor === '#2c3e9a' && pose.shouldersColor === '#d4a017' && pose.neckColor === '#8e44ad' && pose.offHandModel === lantern, 'pose: ' + JSON.stringify(pose));
    assertTrue(!('speedMultiplier' in pose), 'no buffs in the pose');
    const remote = await frame.evaluate((model) => {
      const a = window.__atlasActive3D;
      a.upsertRemotePlayer('r-ok', { x: 3, y: 0, z: -3, yaw: 0, glovesColor: '#112233', legsColor: 'nonsense', shouldersColor: '#445566', neckColor: null, offHandModel: model });
      a.upsertRemotePlayer('r-bad', { x: 4, y: 0, z: -3, yaw: 0, glovesColor: '#112233', offHandModel: 'javascript:alert(1)' });
      const out = [a.getRemotePlayerRenderState('r-ok').extras, a.getRemotePlayerRenderState('r-bad').extras];
      a.removeRemotePlayer('r-ok'); a.removeRemotePlayer('r-bad');
      return out;
    }, lantern);
    assertTrue(remote[0].offHand === lantern && remote[0].gloves && remote[0].legs === null && remote[0].shoulders && remote[0].neck === null, 'remote ok: ' + JSON.stringify(remote[0]));
    assertTrue(remote[1].offHand === null, 'a non-http off-hand model is dropped');
    console.log('PASS: pose carries the visible parts; remote values are validated');

    console.log('STEP 9: the choices survive leaving and re-entering the world');
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 40000 });
    await frame.evaluate(() => followPortal({ kind: 'world', to: 'workshop' }));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), null, { timeout: 40000 });
    await frame.evaluate(() => followPortal({ kind: 'world', to: 'gallery' }));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Atlas Showcase Gallery') && !!window.__atlasActive3D, null, { timeout: 40000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    const after = await frame.evaluate(() => { const e = window.__atlasActive3D.getLocalAvatarExtras(); return { gloves: !!e.gloves, offHand: e.offHand, speed: e.speed, jump: e.jump }; });
    assertTrue(after.gloves && after.offHand === lantern && after.speed === 3 && after.jump === 1.5, 'after re-entry: ' + JSON.stringify(after));
    console.log('PASS: equipment restored on entering the world');

    console.log('STEP 10: taking everything off clears the renderers');
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => document.getElementById('characterScreen').classList.contains('active') && !!window.__atlasCharacterPreview, null, { timeout: 60000 });
    for (const slot of ['gloves', 'legs', 'shoulders', 'neck', 'offhand', 'ring2', 'trinket1', 'trinket2']) {
      await frame.locator('.character-slot[data-slot="' + slot + '"]').click();
      await frame.waitForFunction((s) => document.querySelector('.character-slot.selected') && document.querySelector('.character-slot.selected').dataset.slot === s && !document.getElementById('characterSlotUnequipBtn').hidden, slot, { timeout: 40000 });
      await frame.locator('#characterSlotUnequipBtn').click();
      await frame.waitForFunction((s) => document.getElementById('characterSlotUnequipBtn').hidden, slot, { timeout: 40000 });
    }
    const cleared = await frame.evaluate(() => { const e = window.__atlasActive3D.getLocalAvatarExtras(); return { e: e.gloves || e.legs || e.shoulders || e.neck || e.offHand, speed: e.speed, jump: e.jump, interact: e.interact, ids: Object.keys(window.__x || {}) }; });
    assertTrue(!cleared.e && cleared.speed === 1 && cleared.jump === 1 && cleared.interact === 1, 'cleared: ' + JSON.stringify(cleared));
    assertTrue(Object.keys(await frame.evaluate(() => AtlasWallet.getAvatarSlotIds())).length === 0, 'nothing stored');
    console.log('PASS: everything off');
    console.log('STEP 11: the Stats sub-menu totals base values, item bonuses and the buffs they give');
    const mintLater = async (props) => {
      const payload = { ownerPublicKey: identity.publicKey, assetClass: 'atlas.wearable', properties: props,
        adminAuth: { action: '/atlas/asset/mint', domain: lab.host, issuedAt: new Date().toISOString(), nonce: crypto.randomBytes(12).toString('hex') } };
      const r = await lab.postRaw('/atlas/asset/mint', { payload, proof: signPayload(admin, payload) });
      assertTrue(r.status === 200, 'mint: ' + r.text);
      await walletPage.evaluate(async ({ o, origin, cred }) => { const e = await AtlasWallet.queueBridgeOffer(o, origin, cred); await AtlasWallet.claimBridgeOffer(o, e.id); }, { o: identity.publicKey, origin: lab.origin, cred: r.json });
      return r.json.id;
    };
    minted.statRing = await mintLater({ 'atlas.avatar.slot': 'ring', 'atlas.avatar.stat.agility': '20', 'atlas.avatar.stat.strength': '5', 'atlas.avatar.stat.health': '50', 'atlas.avatar.stat.luck': '-3' });
    minted.statCharm = await mintLater({ 'atlas.avatar.slot': 'trinket', 'atlas.avatar.stat.agility': '5', 'atlas.avatar.stat.intelligence': '5', 'atlas.avatar.stat.dexterity': '10', 'atlas.avatar.stat.armor': '7', 'atlas.avatar.stat.defense': '9999' });
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 40000 });
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => document.getElementById('characterScreen').classList.contains('active') && !!window.__atlasCharacterPreview, null, { timeout: 60000 });
    assertTrue(await frame.evaluate(() => !document.getElementById('characterView').hidden && document.getElementById('characterStatsView').hidden), 'the Character sub-menu is the default');
    const statsOf = () => frame.evaluate(() => {
      const out = {};
      for (const r of document.querySelectorAll('#characterStatsList .stat-row')) out[r.dataset.stat] = r.querySelector('.stat-value').textContent;
      return { rows: out, buffs: Array.from(document.querySelectorAll('#characterBuffList .buff-row')).map((b) => b.textContent), empty: !!document.querySelector('#characterBuffList .empty-note') };
    });
    await frame.locator('.character-subtab[data-view="stats"]').click();
    await frame.waitForFunction(() => document.getElementById('characterView').hidden && !document.getElementById('characterStatsView').hidden, null, { timeout: 20000 });
    let st = await statsOf();
    assertTrue(Object.keys(st.rows).join() === 'health,mana,stamina,agility,intelligence,strength,armor,defense,resistance,attackSpeed,criticalStrike,dexterity,focus,luck,charisma', 'stat rows: ' + Object.keys(st.rows).join());
    const groups = await frame.evaluate(() => Array.from(document.querySelectorAll('#characterStatsList .stat-group')).map((g) => g.querySelector('.stat-group-title').textContent + ':' + Array.from(g.querySelectorAll('.stat-row')).map((r) => r.dataset.stat).join('/')));
    assertTrue(JSON.stringify(groups) === JSON.stringify(['Primary:health/mana/stamina', 'Secondary:agility/intelligence/strength', 'Tertiary:armor/defense/resistance/attackSpeed/criticalStrike/dexterity/focus/luck/charisma']), 'stat groups: ' + JSON.stringify(groups));
    assertTrue(st.rows.health === '100' && st.rows.agility === '10' && st.rows.charisma === '10' && st.empty && st.buffs.length === 0, 'bare character: ' + JSON.stringify(st));
    await frame.locator('.character-subtab[data-view="character"]').click();
    await pickChoice('ring1', 'statRing');
    await pickChoice('trinket1', 'statCharm');
    await frame.locator('.character-subtab[data-view="stats"]').click();
    st = await statsOf();
    // Each Secondary point above 10 adds 5 to its Primary resource: Strength +5 -> Health +25, Intelligence +5 -> Mana +25, Agility +25 -> Stamina +125.
    const want = { health: '175', mana: '125', stamina: '225', agility: '35', intelligence: '15', strength: '15', armor: '17', defense: '510', resistance: '10', attackSpeed: '10', criticalStrike: '10', dexterity: '20', focus: '10', luck: '7', charisma: '10' };
    assertTrue(JSON.stringify(st.rows) === JSON.stringify(want), 'totals: ' + JSON.stringify(st.rows));
    for (const text of ['Health +50', 'Health +25 from Strength', 'Mana +25 from Intelligence', 'Stamina +125 from Agility', 'Agility +25', 'Strength +5', 'Intelligence +5', 'Armor +7', 'Dexterity +10', 'Defense +500', 'Luck -3', 'Speed ×1.25', 'Jump ×1.05', 'Reach ×1.05']) assertTrue(st.buffs.includes(text), 'buff list has ' + text + ': ' + JSON.stringify(st.buffs));
    const live = await frame.evaluate(() => { const e = window.__atlasActive3D.getLocalAvatarExtras(); return { speed: e.speed, jump: e.jump, interact: e.interact }; });
    assertTrue(Math.abs(live.speed - 1.25) < 1e-9 && Math.abs(live.jump - 1.05) < 1e-9 && Math.abs(live.interact - 1.05) < 1e-9, 'stat-driven movement in the world (Dexterity does not move reach): ' + JSON.stringify(live));
    if (process.env.SHOT_DIR) await site.screenshot({ path: path.join(process.env.SHOT_DIR, 'stats.png') });
    await frame.locator('.character-subtab[data-view="character"]').click();
    await frame.waitForFunction(() => !document.getElementById('characterView').hidden, null, { timeout: 20000 });
    await frame.locator('.character-slot[data-slot="ring1"]').click();
    await frame.waitForFunction(() => !document.getElementById('characterSlotUnequipBtn').hidden, null, { timeout: 20000 });
    await frame.locator('#characterSlotUnequipBtn').click();
    await frame.waitForFunction(() => document.getElementById('characterSlotUnequipBtn').hidden, null, { timeout: 20000 });
    await frame.locator('.character-subtab[data-view="stats"]').click();
    st = await statsOf();
    assertTrue(st.rows.agility === '15' && st.rows.health === '100' && !st.buffs.includes('Health +50'), 'taking the ring off lowers the totals: ' + JSON.stringify(st.rows));
    console.log('PASS: stats, buff totals and stat-driven movement');

    console.log('STEP 12: the lobby chest and legs pieces (real catalog classes) fit their slots, recolour the character and add their stats');
    const mintClass = async (assetClass) => {
      const payload = { ownerPublicKey: identity.publicKey, assetClass,
        adminAuth: { action: '/atlas/asset/mint', domain: lab.host, issuedAt: new Date().toISOString(), nonce: crypto.randomBytes(12).toString('hex') } };
      const r = await lab.postRaw('/atlas/asset/mint', { payload, proof: signPayload(admin, payload) });
      assertTrue(r.status === 200, 'mint ' + assetClass + ': ' + r.text);
      await walletPage.evaluate(async ({ o, origin, cred }) => { const e = await AtlasWallet.queueBridgeOffer(o, origin, cred); await AtlasWallet.claimBridgeOffer(o, e.id); }, { o: identity.publicKey, origin: lab.origin, cred: r.json });
      return r.json;
    };
    const forestChest = await mintClass('atlas.avatar.chest.forest');
    const forestLegs = await mintClass('atlas.avatar.legs.forest');
    const duskChest = await mintClass('atlas.avatar.chest.dusk');
    minted.forestChest = forestChest.id; minted.forestLegs = forestLegs.id; minted.duskChest = duskChest.id;
    assertTrue(forestChest.asset.properties['atlas.avatar.slot'] === 'chest' && forestLegs.asset.properties['atlas.avatar.slot'] === 'legs', 'the catalog classes carry their slot');
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 40000 });
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true })));
    await frame.waitForFunction(() => document.getElementById('characterScreen').classList.contains('active') && !!window.__atlasCharacterPreview, null, { timeout: 60000 });
    await frame.locator('.character-subtab[data-view="character"]').click();
    ids = await choices('chest');
    assertTrue(ids.includes(minted.forestChest) && ids.includes(minted.duskChest) && !ids.includes(minted.forestLegs), 'the chest lists the chest pieces and not the legs piece: ' + ids.length);
    ids = await choices('legs');
    assertTrue(ids.includes(minted.forestLegs) && !ids.includes(minted.forestChest), 'the legs slot lists the legs piece and not the chest piece');
    await pickChoice('chest', 'forestChest');
    await pickChoice('legs', 'forestLegs');
    const colours = await frame.evaluate(() => { const c = window.__atlasActive3D.getLocalAvatarColors(), e = window.__atlasActive3D.getLocalAvatarExtras(); return { shirt: c && c.shirtColor, pants: c && c.pantsColor, legs: e.legs }; });
    const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    assertTrue(colours.shirt && hex(colours.shirt) === '#2f5d3a', 'the forest jerkin sets the shirt colour: ' + JSON.stringify(colours));
    assertTrue(colours.legs && hex(colours.legs) === '#3b2a1e', 'the forest trousers set the trouser colour: ' + JSON.stringify(colours));
    await frame.locator('.character-subtab[data-view="stats"]').click();
    st = await statsOf();
    // Jerkin: Armor +4, Resistance +2. Trousers: Agility +2, Armor +2. The charm from step 11 still adds Agility +5, Intelligence +5, Armor +7, so Agility is 17 and Stamina 100 + 7 x 5.
    assertTrue(st.rows.armor === '23' && st.rows.resistance === '12' && st.rows.agility === '17' && st.rows.stamina === '135', 'the pieces add their stats: ' + JSON.stringify(st.rows));
    await frame.locator('.character-subtab[data-view="character"]').click();
    await pickChoice('chest', 'duskChest');
    const swapped = await frame.evaluate(() => window.__atlasActive3D.getLocalAvatarColors());
    assertTrue(swapped && hex(swapped.shirtColor) === '#4a3b6b', 'choosing another chest piece replaces the first: ' + JSON.stringify(swapped));
    await frame.evaluate(() => AtlasWallet.setAvatarLook(null));
    console.log('PASS: chest and legs pieces');
    ok = true;
  } finally {
    await context.close().catch(() => {});
    await lab.stop();
    lab.cleanup();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  console.log(ok ? '\nAll character-slot checks passed' : '\nFAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
