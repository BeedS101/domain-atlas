// Real-browser check of Mining Burrow v0.1: the actual extension, the demo domain's own manifest and Lobby scene,
// and a real issuer lab. Run with a display, for example
//   xvfb-run -a node test/manual-mining-burrow.js
// Set BURROW_SHOT_DIR to also save screenshots.
//
// Proves: (1) walking into the mine mouth in the 3D Lobby enters the side-view burrow; (2) the character walks,
// jumps, is stopped by rock and by the blocked tunnel, and the tunnel only explains itself (no reward, nothing
// in the wallet changes); (3) the exit takes the character back to the Lobby just outside the mine mouth, facing
// away, without bouncing back in; (4) three visits in a row, entered by walking, by a portal call and by walking
// again, leave no listeners or loops behind; (5) the wallet, the equipped hat and compass, the compass HUD, the
// Action Bar and 3D movement all behave the same before and after; (6) keys are ignored while typing and while
// the wallet is open.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioLab } = require('./studio-lab');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mining-burrow-profile-'));
const SHOT_DIR = process.env.BURROW_SHOT_DIR || null;

function assertTrue(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const lab = await StudioLab.start({ mint: true, config: { mintsPerIpPerHour: 100, challengesPerIpPerHour: 100 } });
  const A = path.join(REPO, 'demo-domain-a');
  for (const dir of ['spatial', 'assets']) fs.cpSync(path.join(A, dir), path.join(lab.docroot, dir), { recursive: true, force: true });
  fs.copyFileSync(path.join(A, 'index.html'), path.join(lab.docroot, 'index.html'));
  fs.copyFileSync(path.join(A, 'favicon.svg'), path.join(lab.docroot, 'favicon.svg'));
  const manifest = JSON.parse(fs.readFileSync(path.join(A, '.well-known', 'spatial.json'), 'utf8'));
  manifest.domain = lab.host;
  for (const w of manifest.worlds) w.portals = (w.portals || []).filter((p) => p.kind === 'world');
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(manifest, null, 2));
  console.log('SETUP: issuer lab with the shipped demo domain on ' + lab.origin);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, executablePath: '/opt/pw-browsers/chromium',
    args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
    viewport: { width: 1280, height: 800 }
  });
  let ok = false;
  await context.route('https://' + lab.host + '/**', async (route) => {
    const res = await route.fetch({ url: route.request().url().replace(/^https:/, 'http:') });
    await route.fulfill({ response: res, headers: { ...res.headers(), 'access-control-allow-origin': '*' } });
  });
  const pageErrors = [];
  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;

    console.log('STEP 1: a wallet with a hat and a Bronze Compass equipped');
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 40000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('mining-burrow-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('mining-burrow-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const identity = await walletPage.evaluate(async () => { const i = await AtlasWallet.getIdentity(); return i ? { publicKey: i.publicKey } : null; });
    assertTrue(identity && identity.publicKey, 'identity created');
    const give = async (assetClass) => {
      const r = await lab.postRaw('/atlas/asset/issue', { ownerPublicKey: identity.publicKey, assetClass });
      assertTrue(r.status === 200, 'issue ' + assetClass + ': ' + r.text);
      await walletPage.evaluate(async ({ o, origin, cred }) => { const e = await AtlasWallet.queueBridgeOffer(o, origin, cred); await AtlasWallet.claimBridgeOffer(o, e.id); }, { o: identity.publicKey, origin: lab.origin, cred: r.json });
      return r.json;
    };
    const hat = await give('atlas.avatar.hat.sunhat');
    const compass = await give('atlas.tool.bronze_compass');
    const hatSpeed = Number(hat.asset.properties['atlas.avatar.hatSpeedMultiplier']);
    const hatColor = await walletPage.evaluate(async (id) => { await AtlasWallet.setAvatarHat(id); return (await AtlasWallet.getAvatarHat()).hatColor; }, hat.id);
    await walletPage.evaluate((id) => AtlasWallet.setAvatarSlot('trinket1', id), compass.id);
    assertTrue(hatSpeed > 0 && hatColor, 'the hat has a speed buff and a colour');
    console.log('PASS: identity ' + identity.publicKey.slice(0, 10) + ', hat ' + hatColor + ' (x' + hatSpeed + '), compass in trinket 1');

    const site = await context.newPage();
    site.on('pageerror', (e) => { pageErrors.push(String(e)); console.log('PAGEERROR', String(e)); });
    await site.goto(lab.origin + '/', { waitUntil: 'load' });
    await site.locator('#domain-atlas-enter-btn').click();
    const overlay = await site.waitForSelector('#domain-atlas-overlay', { timeout: 40000 });
    const frame = await overlay.contentFrame();
    frame.on('pageerror', (e) => { pageErrors.push(String(e)); console.log('FRAMEERROR', String(e)); });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Plaza'), null, { timeout: 40000 });
    await frame.evaluate(() => reapplyEquipment());

    // ---- helpers ----
    const world = () => frame.evaluate(() => currentWorld && currentWorld.id);
    const focusFrame = async () => { await frame.evaluate(() => { window.focus(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }); await frame.locator('#placeLabel').click(); };
    const enter3D = async (worldId, name) => {
      await frame.evaluate(() => { window.__prev3D = window.__atlasActive3D || null; });
      await frame.evaluate((id) => followPortal({ kind: 'world', to: id }), worldId);
      await frame.waitForFunction((x) => document.getElementById('placeLabel').textContent.includes(x), name, { timeout: 40000 });
      await frame.waitForFunction(() => window.__atlasActive3D && window.__atlasActive3D !== window.__prev3D, null, { timeout: 60000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
      await sleep(600);
    };
    const s3 = () => frame.evaluate(() => { const a = window.__atlasActive3D; return a ? Object.assign({}, a.getMovementState(), { pos: a.camera.pos.slice(), yaw: a.camera.yaw }) : null; });
    const settle3 = async () => {
      for (let i = 0; i < 120; i++) { const s = await s3(); if (s && s.grounded && Math.abs(s.vy) < 1e-6 && !s.crouched) return s; await sleep(50); }
      throw new Error('3D character never settled: ' + JSON.stringify(await s3()));
    };
    const place3 = async (x, z) => {
      await frame.evaluate(({ x, z }) => { const a = window.__atlasActive3D; a.camera.pos[0] = x; a.camera.pos[2] = z; a.camera.yaw = 0; }, { x, z });
      return settle3();
    };
    const sv = () => frame.evaluate(() => (window.__atlasSideView ? window.__atlasSideView.getState() : null));
    const svUntil = async (fn, timeout) => {
      const end = Date.now() + (timeout || 8000);
      let s = await sv();
      while (!(s && fn(s)) && Date.now() < end) { await sleep(30); s = await sv(); }
      return s;
    };
    const down = (c) => site.keyboard.down(c);
    const up = (c) => site.keyboard.up(c);
    const tap = async (c, ms) => { await down(c); await sleep(ms || 200); await up(c); };
    const view = () => frame.evaluate(() => ({
      world: currentWorld && currentWorld.id,
      canvas2d: getComputedStyle(document.getElementById('scene')).display !== 'none',
      canvas3d: document.getElementById('scene3d').classList.contains('active'),
      active3D: !!window.__atlasActive3D, side: !!window.__atlasSideView,
      hint2d: getComputedStyle(document.getElementById('hint')).display !== 'none',
      bar: (() => { const b = document.getElementById('actionBar'); return !!b && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0; })(),
      hud: !!document.querySelector('#atlasCompassHud.active'),
      label: document.getElementById('placeLabel').textContent,
      status: document.getElementById('status').textContent
    }));
    const walletState = () => walletPage.evaluate(async (o) => {
      const w = await AtlasWallet.getWallet(o);
      return { entries: w.map((e) => e.credential.id + ':' + !!e.hidden).sort(), slots: await AtlasWallet.getAvatarSlotIds(), hat: (await AtlasWallet.getAvatarHat() || {}).hatColor };
    }, identity.publicKey);
    const caps = () => frame.evaluate(async () => { const c = await AtlasCapabilities.active(); return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.map((p) => p.slot + ':' + p.source)])); });
    const shot = async (name) => { if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await site.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); } };
    const waitHud = (visible) => frame.waitForFunction((v) => !!document.querySelector('#atlasCompassHud.active') === v, visible, { timeout: 20000 });

    // keydown listeners the side view adds minus the ones it removes; a leak would leave this above zero
    await frame.evaluate(() => {
      window.__sideKeyListeners = 0;
      const add = window.addEventListener.bind(window), rem = window.removeEventListener.bind(window);
      window.addEventListener = (t, f, o) => { if (t === 'keydown' && f && f.name === 'sideKeyDown') window.__sideKeyListeners++; return add(t, f, o); };
      window.removeEventListener = (t, f, o) => { if (t === 'keydown' && f && f.name === 'sideKeyDown') window.__sideKeyListeners--; return rem(t, f, o); };
    });

    console.log('STEP 2: the Lobby with its equipment, before the trip');
    await enter3D('lobby', 'Lobby');
    await waitHud(true);
    let before = await s3();
    await settle3();
    const walletBefore = await walletState();
    const capsBefore = await caps();
    await frame.evaluate(() => { window.__barRef = window.__atlasActionBar; });
    assertTrue(same(Object.keys(capsBefore), ['atlas.cap.compass']), 'the compass capability is active in the Lobby: ' + JSON.stringify(capsBefore));
    const hatBefore = await frame.evaluate(() => window.__atlasActive3D.getLocalAvatarHatSpeedMultiplier());
    assertTrue(Math.abs(hatBefore - hatSpeed) < 1e-6, 'the hat buff applies: ' + hatBefore);
    let v = await view();
    assertTrue(v.world === 'lobby' && v.canvas3d && !v.canvas2d && v.bar && v.hud && !v.side, 'Lobby view state: ' + JSON.stringify(v));
    console.log('PASS: Lobby with the compass HUD, the Action Bar, hat buff x' + hatBefore);

    console.log('STEP 3: the mine entrance in the Lobby is visible and does nothing until walked into');
    await place3(-11.6, -8.5);
    await frame.evaluate(() => { const a = window.__atlasActive3D; a.camera.yaw = 0; });
    await sleep(900);
    await shot('01-lobby-at-mine');
    assertTrue((await world()) === 'lobby', 'standing near the mine does not enter it');
    await place3(-11.6, -10.4);
    await sleep(900);
    assertTrue((await world()) === 'lobby', 'standing 1.6 from the mouth does not enter it');
    console.log('PASS: no entry without walking into the mouth');

    console.log('STEP 4: walking north into the mine mouth enters the Mining Burrow');
    await place3(-11.6, -9.4);
    await focusFrame();
    await down('KeyW');
    await frame.waitForFunction(() => window.__atlasSideView !== null && window.__atlasSideView !== undefined, null, { timeout: 40000 });
    await up('KeyW');
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Mining Burrow'), null, { timeout: 10000 });
    let st = await svUntil((s) => s.grounded && s.frames > 3);
    v = await view();
    assertTrue(v.world === 'mining-burrow' && v.canvas2d && !v.canvas3d && !v.active3D && v.side && !v.hint2d && v.bar, 'burrow view state: ' + JSON.stringify(v));
    assertTrue(st.grounded && Math.abs(st.x - 7) < 0.3 && Math.abs(st.y - 12) < 0.05, 'arrives at the spawn, on the floor: ' + JSON.stringify(st));
    assertTrue(!v.hud, 'the compass HUD is hidden in the side view (it needs a 3D scene)');
    assertTrue(same(await caps(), capsBefore), 'the compass capability itself is still active: ' + JSON.stringify(await caps()));
    assertTrue(st.look.hat === hatColor, 'the character wears the equipped hat: ' + st.look.hat + ' vs ' + hatColor);
    await sleep(500);
    await shot('02-burrow-arrival');
    console.log('PASS: entered by walking into the mouth: ' + v.label.trim().slice(0, 60));

    console.log('STEP 5: walking, jumping, rock');
    await focusFrame();
    let s0 = await sv();
    await down('KeyD'); await sleep(600); await up('KeyD');
    st = await svUntil((s) => Math.abs(s.vx) < 0.05);
    assertTrue(st.x - s0.x > 1.5 && st.facing === 1, 'D walks right: ' + (st.x - s0.x).toFixed(2));
    s0 = st;
    await down('KeyA'); await sleep(400); await up('KeyA');
    st = await svUntil((s) => Math.abs(s.vx) < 0.05);
    assertTrue(s0.x - st.x > 0.8 && st.facing === -1, 'A walks left: ' + (s0.x - st.x).toFixed(2));
    console.log('PASS: A and D walk');

    // a full jump, sampled in the page so the peak is not missed
    await frame.evaluate(() => { const st = { peak: 99, live: true, groundedAgain: false }; window.__jmp = st; const t = () => { const s = window.__atlasSideView && window.__atlasSideView.getState(); if (s) st.peak = Math.min(st.peak, s.y); if (st.live) requestAnimationFrame(t); }; requestAnimationFrame(t); });
    s0 = await sv();
    await down('Space'); await sleep(450); await up('Space');
    await svUntil((s) => s.grounded && s.y > s0.y - 0.01 && Math.abs(s.vy) < 1e-6, 5000);
    const jm = await frame.evaluate(() => { window.__jmp.live = false; return window.__jmp; });
    st = await sv();
    assertTrue(s0.y - jm.peak > 1.8 && s0.y - jm.peak < 2.6, 'Space jumps about 2.3 tiles, peak rise ' + (s0.y - jm.peak).toFixed(2));
    assertTrue(st.grounded && Math.abs(st.y - 12) < 0.01, 'and lands on the floor again');
    console.log('PASS: Space jumps ' + (s0.y - jm.peak).toFixed(2) + ' tiles and lands');

    // up the timber hall to the lookout using real keys: platform stand heights 10, 8, 6
    await frame.evaluate(() => window.__atlasSideView.teleport(12.2, 12));
    await svUntil((s) => s.grounded);
    const hop = async (ms, jumpMs) => { await down('KeyD'); await down('Space'); await sleep(jumpMs || 400); await up('Space'); await sleep(Math.max(0, ms - (jumpMs || 400))); await up('KeyD'); };
    await hop(380, 380);
    st = await svUntil((s) => s.grounded && Math.abs(s.y - 10) < 0.02, 5000);
    assertTrue(st && Math.abs(st.y - 10) < 0.02 && st.x > 12.9 && st.x < 15.1, 'jumped up onto the first timber platform: ' + JSON.stringify(st && { x: st.x, y: st.y }));
    console.log('PASS: jumped onto a timber platform (x ' + st.x.toFixed(1) + ', y ' + st.y + ')');

    // rock: walk into the left wall from beside the mouth is the exit, so use the blocked tunnel and the pit wall instead
    await frame.evaluate(() => window.__atlasSideView.teleport(55.2, 19));
    await svUntil((s) => s.grounded && Math.abs(s.y - 19) < 0.02);
    await focusFrame();
    st = await sv();
    assertTrue(st.nearLandmark === 'rockfall', 'the Collapsed Tunnel landmark shows near it: ' + st.nearLandmark);
    await down('KeyD'); await sleep(900); await up('KeyD');
    st = await svUntil((s) => Math.abs(s.vx) < 0.05);
    assertTrue(st.x < 57 - 0.3 + 0.01 && st.x > 56.4, 'the blocked tunnel stops the character at its face, x ' + st.x.toFixed(2));
    await down('KeyD'); await down('Space'); await sleep(500); await up('Space'); await sleep(300); await up('KeyD');
    st = await svUntil((s) => s.grounded);
    assertTrue(st.x < 57 - 0.3 + 0.01, 'jumping against it does not get through, x ' + st.x.toFixed(2));
    await shot('03-blocked-tunnel');
    const walletMid = await walletState();
    await tap('KeyE', 150);
    st = await svUntil((s) => !!s.toast);
    assertTrue(st.toast && /pick/i.test(st.toast), 'E reads the tunnel\'s hint: ' + st.toast);
    assertTrue(same(await walletState(), walletBefore) && same(walletMid, walletBefore), 'nothing in the wallet changed: no reward, no cost');
    assertTrue(same(await frame.evaluate(() => window.__atlasSideView.scene.blocked.map((b) => b.rect)), [[57, 15, 4, 4]]), 'and the tunnel is still blocked (no mining implemented)');
    await shot('04-tunnel-hint');
    console.log('PASS: the blocked tunnel blocks, explains itself on E, and changes nothing');

    // The climb out of the shaft is covered on foot in test/mining-burrow.js; here only check that a drop lands on
    // the shaft's timber, that walking off it carries on down to the lower floor, and that the character stays alive.
    await frame.evaluate(() => window.__atlasSideView.teleport(24.5, 10));
    st = await svUntil((s) => s.grounded && s.y > 12.5, 8000);
    assertTrue(st && Math.abs(st.y - 15) < 0.02, 'a drop into the shaft lands on its timber: ' + JSON.stringify(st && { x: st.x, y: st.y }));
    await focusFrame();
    await down('KeyD');
    st = await svUntil((s) => s.grounded && s.y > 18.9, 8000);
    await up('KeyD');
    assertTrue(st && Math.abs(st.y - 19) < 0.02 && st.x > 22 && st.x < 29, 'walking off the timber drops to the lower floor: ' + JSON.stringify(st && { x: st.x, y: st.y }));
    await shot('05-lower-tunnel');
    console.log('PASS: a fall down the shaft lands on timber, then the lower floor');

    // an explorer shot of the crystal cavern and the lookout for the record
    await frame.evaluate(() => window.__atlasSideView.teleport(47.5, 19));
    await svUntil((s) => s.grounded); await sleep(600); await shot('06-crystal-cavern');
    await frame.evaluate(() => window.__atlasSideView.teleport(18.6, 6));
    await svUntil((s) => s.grounded && Math.abs(s.y - 6) < 0.02); await sleep(600); await shot('07-lookout');

    console.log('STEP 6: keys are ignored while typing and while the wallet is open');
    await frame.evaluate(() => window.__atlasSideView.teleport(30, 12));
    await svUntil((s) => s.grounded);
    await frame.evaluate(() => { const i = document.createElement('input'); i.type = 'text'; i.id = 'burrowTestInput'; i.style.cssText = 'position:fixed;left:10px;top:70px;z-index:99'; document.body.appendChild(i); i.focus(); });
    s0 = await sv();
    await down('KeyD'); await sleep(400); await up('KeyD');
    st = await sv();
    assertTrue(Math.abs(st.x - s0.x) < 0.05, 'typing "d" into a field does not move the character');
    assertTrue((await frame.evaluate(() => document.getElementById('burrowTestInput').value)) === 'd', 'and the letter reaches the field');
    await frame.evaluate(() => document.getElementById('burrowTestInput').remove());
    await focusFrame();
    await frame.evaluate(() => document.getElementById('walletPanel').classList.add('open'));
    s0 = await sv();
    await down('KeyD'); await sleep(400); await up('KeyD');
    st = await sv();
    assertTrue(Math.abs(st.x - s0.x) < 0.05, 'with the wallet open the character stays put');
    await frame.evaluate(() => document.getElementById('walletPanel').classList.remove('open'));
    await focusFrame();
    s0 = await sv();
    await down('KeyD'); await sleep(400); await up('KeyD');
    st = await svUntil((s) => Math.abs(s.vx) < 0.05);
    assertTrue(st.x - s0.x > 0.8, 'and walking works again once it is closed');
    console.log('PASS: input is ignored while typing and while the wallet is open');

    console.log('STEP 7: the Action Bar in the burrow');
    assertTrue(await frame.evaluate(() => window.__atlasActionBar === window.__barRef), 'the burrow uses the same Action Bar');
    await site.keyboard.down('Digit1');
    await frame.waitForFunction(() => document.querySelector('.ab-slot[data-slot="strike-right"]').classList.contains('firing'), null, { timeout: 4000 });
    await site.keyboard.up('Digit1');
    await site.keyboard.down('Digit5');
    await frame.waitForFunction(() => document.querySelector('.ab-slot[data-slot="block"]').classList.contains('holding'), null, { timeout: 4000 });
    await site.keyboard.up('Digit5');
    console.log('PASS: slot keys still flash in the burrow (poses are drawn on the 3D character only)');

    console.log('STEP 8: the exit takes the character back to the Lobby, outside the mine mouth');
    await frame.evaluate(() => { window.__oldSide = window.__atlasSideView; });
    await frame.evaluate(() => window.__atlasSideView.teleport(6, 12));
    await svUntil((s) => s.grounded);
    await focusFrame();
    await down('KeyA');
    await frame.waitForFunction(() => window.__atlasActive3D && !window.__atlasSideView, null, { timeout: 60000 });
    await up('KeyA');
    await frame.evaluate(() => window.__atlasActive3D.ready);
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Lobby'), null, { timeout: 10000 });
    await sleep(800);
    let after = await settle3();
    v = await view();
    assertTrue(v.world === 'lobby' && v.canvas3d && !v.canvas2d && v.active3D && !v.side && v.bar, 'back in the Lobby: ' + JSON.stringify(v));
    assertTrue(/Mine Entrance/.test(v.label), 'the place label names the anchor: ' + v.label);
    assertTrue(Math.abs(after.pos[0] + 11.6) < 0.6 && Math.abs(after.pos[2] + 10.2) < 0.6, 'standing just outside the mine mouth: ' + after.pos.map((n) => n.toFixed(2)));
    const dFromMouth = Math.hypot(after.pos[0] + 11.6, after.pos[2] + 12.0);
    assertTrue(dFromMouth > 1.2, 'clear of the trigger (' + dFromMouth.toFixed(2) + ' from its centre)');
    assertTrue(Math.abs(Math.cos(after.yaw) + 1) < 0.05, 'facing away from the hill (yaw ' + after.yaw.toFixed(2) + ')');
    await sleep(1500);
    assertTrue((await world()) === 'lobby', 'it does not bounce back into the mine');
    await waitHud(true);
    await shot('08-back-at-lobby');
    console.log('PASS: back at (' + after.pos[0].toFixed(1) + ', ' + after.pos[2].toFixed(1) + '), facing out, compass HUD back');

    const frozen = await frame.evaluate(() => window.__oldSide.getState().frames);
    await sleep(600);
    assertTrue((await frame.evaluate(() => window.__oldSide.getState().frames)) === frozen, 'the old side view stopped drawing');
    assertTrue((await frame.evaluate(() => window.__sideKeyListeners)) === 0, 'its key listeners are gone');
    console.log('PASS: the old side view is torn down');

    console.log('STEP 9: wallet, equipment, compass, Action Bar and 3D movement after the trip');
    assertTrue(same(await walletState(), walletBefore), 'the wallet, equipment and hat colour are unchanged');
    assertTrue(same(await caps(), capsBefore), 'the same capabilities are active');
    const hatAfter = await frame.evaluate(() => window.__atlasActive3D.getLocalAvatarHatSpeedMultiplier());
    assertTrue(Math.abs(hatAfter - hatBefore) < 1e-9, 'the hat buff is the same: ' + hatAfter);
    assertTrue(await frame.evaluate(() => window.__atlasActionBar === window.__barRef), 'the Action Bar is the same instance');
    assertTrue(await frame.evaluate(() => !document.querySelector('#actionBar .ab-slot.holding') && !document.querySelector('#actionBar .ab-selector.open')), 'no key is left held on the bar');
    await focusFrame();
    await site.keyboard.down('Digit1');
    await frame.waitForFunction(() => document.querySelector('.ab-slot[data-slot="strike-right"]').classList.contains('firing'), null, { timeout: 4000 });
    await site.keyboard.up('Digit1');
    await frame.evaluate(() => { window.__mv = { peak: 0, live: true }; const t = () => { const a = window.__atlasActive3D; if (a) window.__mv.peak = Math.max(window.__mv.peak, a.getMovementState().feetY); if (window.__mv.live) requestAnimationFrame(t); }; requestAnimationFrame(t); });
    await tap('Space', 250);
    await sleep(1500);
    const mv = await frame.evaluate(() => { window.__mv.live = false; return window.__mv; });
    assertTrue(mv.peak > 0.5 && mv.peak < 0.65, '3D jumping works as before, peak ' + mv.peak.toFixed(3));
    await down('ControlLeft'); await sleep(600);
    assertTrue((await s3()).crouched, '3D crouching works');
    await up('ControlLeft');
    await settle3();
    console.log('PASS: wallet, hat, compass capability and HUD, Action Bar and 3D jump/crouch are as before');

    console.log('STEP 10: repeat visits');
    // second visit: walk in again, then walk out; third: a portal call in, walk out
    for (let visit = 2; visit <= 3; visit++) {
      await place3(-11.6, -9.4);
      await focusFrame();
      if (visit === 2) {
        await down('KeyW');
        await frame.waitForFunction(() => !!window.__atlasSideView, null, { timeout: 40000 });
        await up('KeyW');
      } else {
        await frame.evaluate(() => followPortal(currentWorld.portals[1]));
        await frame.waitForFunction(() => !!window.__atlasSideView, null, { timeout: 40000 });
      }
      st = await svUntil((s) => s.grounded && s.frames > 3);
      assertTrue(Math.abs(st.x - 7) < 0.3 && Math.abs(st.y - 12) < 0.05, 'visit ' + visit + ' starts at the spawn again: ' + JSON.stringify({ x: st.x, y: st.y }));
      assertTrue((await frame.evaluate(() => window.__sideKeyListeners)) === 1, 'exactly one set of side-view key listeners');
      await focusFrame();
      s0 = await sv();
      await down('KeyD'); await sleep(400); await up('KeyD');
      st = await svUntil((s) => Math.abs(s.vx) < 0.05);
      assertTrue(st.x - s0.x > 0.8, 'visit ' + visit + ': movement works');
      await frame.evaluate(() => window.__atlasSideView.teleport(6, 12));
      await svUntil((s) => s.grounded);
      await focusFrame();
      await down('KeyA');
      await frame.waitForFunction(() => window.__atlasActive3D && !window.__atlasSideView, null, { timeout: 60000 });
      await up('KeyA');
      await frame.evaluate(() => window.__atlasActive3D.ready);
      await sleep(700);
      after = await settle3();
      assertTrue(Math.abs(after.pos[0] + 11.6) < 0.6 && Math.abs(after.pos[2] + 10.2) < 0.6, 'visit ' + visit + ' returns outside the mouth: ' + after.pos.map((n) => n.toFixed(2)));
      assertTrue((await frame.evaluate(() => window.__sideKeyListeners)) === 0, 'visit ' + visit + ': no listeners left behind');
      await waitHud(true);
      assertTrue(same(await walletState(), walletBefore), 'visit ' + visit + ': wallet unchanged');
      console.log('PASS: visit ' + visit + ' (' + (visit === 2 ? 'walked in' : 'portal call') + ', walked out)');
    }

    console.log('STEP 11: the Plaza route still works around it');
    await frame.evaluate(() => followPortal({ kind: 'world', to: 'plaza' }));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Plaza'), null, { timeout: 40000 });
    await sleep(500);
    v = await view();
    assertTrue(v.world === 'plaza' && v.canvas2d && !v.active3D && !v.side && v.bar && !v.hud, 'the Plaza: ' + JSON.stringify(v));
    await enter3D('lobby', 'Lobby');
    await waitHud(true);
    console.log('PASS: Lobby -> Plaza -> Lobby unaffected');

    assertTrue(pageErrors.length === 0, 'no page errors: ' + pageErrors.join(' | '));
    ok = true;
    console.log('\nAll Mining Burrow browser checks passed.');
  } catch (err) {
    console.log('FAIL:', err && err.stack || err);
    process.exitCode = 1;
  } finally {
    await context.close();
    await lab.stop();
    if (!ok) process.exitCode = 1;
  }
})();
