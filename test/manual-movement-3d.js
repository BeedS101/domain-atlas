// Real-browser check of 3D movement (single and double jump, landing on and clearing obstacles, crouching and
// standing clearance, barriers) in the actual extension: the demo Lobby and a purpose-built obstacle scene
// (test/fixtures/movement-obstacles/scene.json), served by an isolated issuer lab. Run with a display, for example
//   xvfb-run -a node test/manual-movement-3d.js
//
// Lanes in the obstacle scene run along z; each walker starts at z = 4 facing -z (W) and meets the obstacle at z = 0:
//   x = -11 low crate 0.28   -8 crate 0.56   -5 sofa 0.46   -2 bookcase 0.79   1 wall 2.06
//   x =   4 lintel (underside 1.4)   7 beam (underside 2.2)   10 hedge 1.1
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioLab } = require('./studio-lab');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'movement-3d-profile-'));

function assertTrue(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  const lab = await StudioLab.start({});
  const A = path.join(REPO, 'demo-domain-a');
  for (const dir of ['spatial', 'assets']) fs.cpSync(path.join(A, dir), path.join(lab.docroot, dir), { recursive: true, force: true });
  fs.copyFileSync(path.join(A, 'index.html'), path.join(lab.docroot, 'index.html'));
  fs.copyFileSync(path.join(A, 'favicon.svg'), path.join(lab.docroot, 'favicon.svg'));
  fs.mkdirSync(path.join(lab.docroot, 'spatial', 'movement-test'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'test', 'fixtures', 'movement-obstacles', 'scene.json'), path.join(lab.docroot, 'spatial', 'movement-test', 'scene.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(A, '.well-known', 'spatial.json'), 'utf8'));
  manifest.domain = lab.host;
  for (const w of manifest.worlds) w.portals = (w.portals || []).filter((p) => p.kind === 'world');
  const lobbyWorld = manifest.worlds.find((w) => w.id === 'lobby');
  manifest.worlds.push(Object.assign({}, JSON.parse(JSON.stringify(lobbyWorld)), {
    id: 'movement-test', name: 'Movement Obstacles', portals: [],
    entry: { scene: '/spatial/movement-test/scene.json', renderer: ['gltf-mini-v1'] }
  }));
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(manifest, null, 2));
  console.log('SETUP: demo domain with the Lobby and an obstacle world on ' + lab.origin);

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
  try {
    const site = await context.newPage();
    const pageErrors = [];
    site.on('pageerror', (e) => { pageErrors.push(String(e)); console.log('PAGEERROR', String(e)); });
    await site.goto(lab.origin + '/', { waitUntil: 'load' });
    await site.locator('#domain-atlas-enter-btn').click();
    const overlay = await site.waitForSelector('#domain-atlas-overlay', { timeout: 40000 });
    const frame = await overlay.contentFrame();
    frame.on('pageerror', (e) => { pageErrors.push(String(e)); console.log('FRAMEERROR', String(e)); });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Plaza'), null, { timeout: 40000 });

    const enter3D = async (worldId, name) => {
      await frame.evaluate(() => { window.__prev3D = window.__atlasActive3D || null; });
      await frame.evaluate((id) => followPortal({ kind: 'world', to: id }), worldId);
      await frame.waitForFunction((x) => document.getElementById('placeLabel').textContent.includes(x), name, { timeout: 40000 });
      await frame.waitForFunction(() => window.__atlasActive3D && window.__atlasActive3D !== window.__prev3D, null, { timeout: 60000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
      await frame.evaluate(() => { window.focus(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
      await frame.locator('#scene3d').focus();
    };
    const state = () => frame.evaluate(() => {
      const a = window.__atlasActive3D;
      return Object.assign({}, a.getMovementState(), { pos: a.camera.pos.slice(), floorY: a.getCharacterFloorY() });
    });
    const sampleStart = () => frame.evaluate(() => {
      const st = { peak: 0, maxJumps: 0, minModelY: 1e9, minFloorY: 1e9, minSquash: 1e9, frames: 0, live: true };
      window.__mvs = st;
      const tick = () => {
        const a = window.__atlasActive3D;
        if (a) {
          const m = a.getMovementState();
          st.peak = Math.max(st.peak, m.feetY); st.maxJumps = Math.max(st.maxJumps, m.jumpsUsed);
          st.minModelY = Math.min(st.minModelY, m.modelBaseY); st.minFloorY = Math.min(st.minFloorY, a.getCharacterFloorY());
          st.minSquash = Math.min(st.minSquash, m.modelSquash); st.frames++;
        }
        if (st.live) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sampleStop = () => frame.evaluate(() => { window.__mvs.live = false; return window.__mvs; });
    const down = (code) => site.keyboard.down(code);
    const up = (code) => site.keyboard.up(code);
    const tap = async (code, ms) => { await down(code); await sleep(ms || 220); await up(code); };
    const settle = async () => {
      for (let i = 0; i < 120; i++) { const s = await state(); if (s.grounded && Math.abs(s.vy) < 1e-6 && !s.crouched) return s; await sleep(50); }
      throw new Error('never settled: ' + JSON.stringify(await state()));
    };
    const place = async (x, z) => {
      await frame.evaluate(({ x, z }) => { const a = window.__atlasActive3D; a.camera.pos[0] = x; a.camera.pos[2] = z; a.camera.yaw = 0; }, { x, z });
      return settle();
    };
    // Polls the state until fn(state) is true or the timeout passes; returns the last state.
    const until = async (fn, timeout) => {
      const end = Date.now() + timeout;
      let s = await state();
      while (!fn(s) && Date.now() < end) { await sleep(25); s = await state(); }
      return s;
    };

    const onlyObstacles = process.env.MOVEMENT_ONLY === 'obstacles';
    if (!onlyObstacles) {
      // ---------------- Lobby ----------------
      console.log('STEP 1: the Lobby, single jump, double jump, crouch');
      await enter3D('lobby', 'Lobby');
      await sleep(1000);
      let s = await settle();
      assertTrue(s.grounded && s.feetY === 0 && s.jumpsUsed === 0 && s.floorY === 0 && near(s.modelSquash, 1, 1e-3) && s.bodyHeight === 1.8, 'starts standing on the floor: ' + JSON.stringify(s));
      const eyeStanding = s.pos[1];

      await place(-1.6, -2.0);
      await sampleStart();
      await tap('Space', 250);
      await sleep(1500);
      let m = await sampleStop();
      s = await state();
      assertTrue(m.peak > 0.5 && m.peak < 0.65, 'single jump peak is the usual ~0.57, got ' + m.peak.toFixed(3));
      assertTrue(m.maxJumps === 1, 'one jump used');
      assertTrue(s.grounded && s.feetY === 0 && s.jumpsUsed === 0, 'landed on the floor with the jump count reset: ' + JSON.stringify(s));
      console.log('PASS: a single jump peaks at ' + m.peak.toFixed(2) + ' and lands');

      await sampleStart();
      await down('Space'); await sleep(250); await up('Space'); await sleep(150); await down('Space'); await sleep(250); await up('Space');
      await sleep(2200);
      m = await sampleStop();
      s = await state();
      assertTrue(m.maxJumps === 2 && m.peak > 0.8, 'a second press in the air jumps again: peak ' + m.peak.toFixed(3) + ' jumps ' + m.maxJumps);
      assertTrue(s.grounded && s.feetY === 0 && s.jumpsUsed === 0, 'double jump lands and resets: ' + JSON.stringify(s));
      console.log('PASS: the double jump reaches ' + m.peak.toFixed(2));

      await sampleStart();
      await down('Space'); await sleep(200); await up('Space'); await sleep(120);
      await down('Space'); await sleep(200); await up('Space'); await sleep(120);
      await down('Space'); await sleep(200); await up('Space');
      await sleep(2200);
      m = await sampleStop();
      assertTrue(m.maxJumps === 2 && m.peak < 1.7, 'a third press adds nothing: jumps ' + m.maxJumps + ' peak ' + m.peak.toFixed(3));
      console.log('PASS: a third press in the air does nothing');

      await sampleStart();
      await down('ControlLeft');
      await sleep(900);
      s = await state();
      m = await sampleStop();
      assertTrue(s.crouched && s.bodyHeight === 1.2 && s.crouchBlend === 1, 'crouched at the lower body height: ' + JSON.stringify(s));
      assertTrue(near(s.modelSquash, 1.2 / 1.8, 0.01), 'the model is squashed, not sunk: squash ' + s.modelSquash);
      assertTrue(m.minModelY >= -1e-6 && m.minFloorY >= -1e-6 && s.modelBaseY === 0 && s.floorY === 0, 'the feet stay on the floor while crouching (min model y ' + m.minModelY + ')');
      assertTrue(s.pos[1] < eyeStanding - 0.3, 'the eye is lower while crouched: ' + s.pos[1] + ' vs ' + eyeStanding);
      await up('ControlLeft');
      await sleep(900);
      s = await state();
      assertTrue(!s.crouched && s.bodyHeight === 1.8 && near(s.modelSquash, 1, 1e-3) && near(s.pos[1], eyeStanding, 1e-3), 'stands up again when clear: ' + JSON.stringify(s));
      console.log('PASS: crouching squashes the model above the floor and lowers the eye; releasing stands up');

      console.log('STEP 2: ground speed is unchanged');
      await place(-1.6, 3.0);
      let before = (await state()).pos;
      await down('KeyW'); await sleep(1000); await up('KeyW');
      let after = (await state()).pos;
      const walked = Math.hypot(after[0] - before[0], after[2] - before[2]);
      assertTrue(walked > 0.9 && walked < 3.2, 'walking covers a normal distance in about a second: ' + walked.toFixed(2));
      console.log('PASS: walking still moves (' + walked.toFixed(2) + ' m in ~1 s)');

      console.log('STEP 3: the Lobby wall cannot be jumped or double-jumped');
      await place(-1.6, -3.0);
      const free = await frame.evaluate(() => window.__atlasActive3D.isPositionBlocked(-1.6, -3.0));
      assertTrue(!free, 'start point is free');
      await down('KeyW');
      for (let i = 0; i < 14; i++) { await down('Space'); await sleep(200); await up('Space'); await sleep(110); }
      await up('KeyW');
      s = await state();
      assertTrue(s.pos[2] > -5.3 && s.pos[2] < -4.3, 'pressed against the inside of the wall, never over it: z=' + s.pos[2].toFixed(2));
      await settle();
      console.log('PASS: z stopped at ' + s.pos[2].toFixed(2) + ' against the wall (face at -5.46)');

      console.log('STEP 4: jumping over the portal marker still enters it');
      await place(0, 2.6);
      await down('KeyS');
      for (let i = 0; i < 10; i++) { await tap('Space', 130); await sleep(120); }
      await up('KeyS');
      await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Plaza'), null, { timeout: 40000 });
      console.log('PASS: the portal is entered by planar distance even while jumping');
    }

    // ---------------- Obstacle scene ----------------
    console.log('STEP 5: the obstacle scene');
    await enter3D('movement-test', 'Movement Obstacles');
    await sleep(800);
    await settle();

    const lane = async (x) => place(x, 4.0);
    // Holds W until the walker is against the face, then returns the state.
    // (Frame rate under software GL varies, so wait for the walker to reach the face rather than for a fixed time.)
    const pushIn = async (ms) => {
      await down('KeyW');
      await until((v) => v.pos[2] < 0.62, ms);
      await sleep(500);
      await up('KeyW');
      return state();
    };

    // 5a: low crate: blocks walking, a jump clears it
    await lane(-11);
    s = await pushIn(8000);
    assertTrue(s.pos[2] > 0.3 && s.pos[2] < 0.55 && s.feetY === 0, 'a 0.28 crate blocks walking: z=' + s.pos[2].toFixed(2));
    await lane(-11);
    await down('KeyW');
    await until((x) => x.pos[2] < 1.7, 4000);
    await tap('Space', 220);
    s = await until((x) => x.pos[2] < -0.7 && x.grounded, 4000);
    await up('KeyW');
    assertTrue(s.pos[2] < -0.5 && s.grounded && s.feetY === 0, 'hopped over the low crate and landed beyond it: ' + JSON.stringify(s));
    console.log('PASS: a low crate blocks walking and a jump clears it');

    // Climbs onto an obstacle by pushing against its face and jumping. The walker keeps pushing forward the whole
    // time, so it can only get up if its feet reach the top; the frame it does, it is moved over the middle of the
    // obstacle and W is released in the page (the frame rate under software GL is too uneven to time a stop from
    // outside) and it is left to land.
    const climb = async (x, topY, presses) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await lane(x);
        await frame.evaluate((top) => {
          const st = { top, caught: false, live: true };
          window.__catch = st;
          const tick = () => {
            const a = window.__atlasActive3D;
            const m = a.getMovementState();
            if (!st.caught && !m.grounded && m.feetY >= st.top - 0.03) { a.camera.pos[2] = 0; st.caught = true; window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' })); }
            if (st.live) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }, topY);
        await down('KeyW');
        await until((v) => v.pos[2] < 1.2 && v.pos[2] > 0 && v.grounded, 8000);
        await sleep(600); // pushed up against the face
        for (let i = 0; i < presses; i++) { await down('Space'); await sleep(250); await up('Space'); if (i + 1 < presses) await sleep(150); }
        const top = await until((v) => v.grounded && v.feetY > topY - 0.05, 3000);
        await up('KeyW');
        const caught = await frame.evaluate(() => { window.__catch.live = false; return window.__catch.caught; });
        if (process.env.MOVEMENT_DEBUG) console.log('  climb x=' + x + ' attempt ' + attempt + ': caught=' + caught + ' ' + JSON.stringify(top));
        if (caught && top.grounded && near(top.feetY, topY, 0.01)) return top;
        await settle();
      }
      return state();
    };

    // 5b: tall crate (0.56) and sofa (0.46): one jump lands on top
    for (const [x, h, label] of [[-8, 0.56, 'a 0.56 crate'], [-5, 0.46, 'the sofa']]) {
      s = await climb(x, h, 1);
      assertTrue(s.grounded && near(s.feetY, h, 0.01) && s.jumpsUsed === 0, label + ': standing on top: ' + JSON.stringify(s));
      assertTrue(near(s.modelBaseY, h, 0.01) && near(s.floorY, h, 0.01), label + ': the model and the broadcast height follow the top');
      await down('KeyW');
      s = await until((v) => v.feetY === 0 && v.grounded, 4000);
      await up('KeyW');
      assertTrue(s.feetY === 0 && s.grounded && s.pos[2] < -0.3, label + ': walking off the far edge drops back to the floor: ' + JSON.stringify(s));
      console.log('PASS: one jump lands on ' + label + ' and walking off falls back to the floor');
    }

    // 5c: bookcase (0.79): one jump is not enough, the double jump is
    await lane(-2);
    await down('KeyW');
    await until((v) => v.pos[2] < 1.2 && v.grounded, 8000);
    await sleep(600);
    for (let i = 0; i < 4; i++) { await tap('Space', 250); await sleep(1200); }
    s = await state();
    await up('KeyW');
    assertTrue(s.feetY === 0 && s.pos[2] > 0.3, 'single jumps never get onto the 0.79 bookcase: ' + JSON.stringify(s));
    console.log('PASS: repeated single jumps do not reach a 0.79 bookcase');
    s = await climb(-2, 0.79, 2);
    assertTrue(s.grounded && near(s.feetY, 0.79, 0.01) && s.jumpsUsed === 0, 'the double jump lands on the bookcase: ' + JSON.stringify(s));
    console.log('PASS: the double jump reaches the bookcase and landing resets the jumps');
    await up('KeyW');
    await place(-2, 4);

    // 5d: the wall and the hedge stay barriers under heavy jumping
    for (const [x, label, minZ] of [[1, 'the 2.06 wall', 0.3], [10, 'the 1.1 hedge', 0.6]]) {
      await lane(x);
      await down('KeyW');
      for (let i = 0; i < 16; i++) {
        await down('Space'); await sleep(200); await up('Space'); await sleep(120);
        await down('Space'); await sleep(200); await up('Space'); await sleep(300);
      }
      await up('KeyW');
      s = await state();
      assertTrue(s.pos[2] > minZ, label + ' stayed in front of: z=' + s.pos[2].toFixed(2));
      await settle();
      console.log('PASS: ' + label + ' cannot be hopped (z=' + s.pos[2].toFixed(2) + ')');
    }

    // 5e: crouching under the lintel, standing refused beneath it
    await lane(4);
    s = await pushIn(8000);
    assertTrue(s.pos[2] > 0.3 && s.pos[2] < 0.5, 'standing is stopped by the lintel: z=' + s.pos[2].toFixed(2));
    await lane(4);
    await down('ControlLeft');
    await sleep(600);
    await down('KeyW');
    s = await until((v) => v.pos[2] < -0.5, 5000);
    assertTrue(s.pos[2] < -0.5 && s.crouched, 'crouched, the walker goes under the lintel: ' + JSON.stringify(s));
    await up('KeyW');
    await up('ControlLeft');
    s = await until((v) => !v.crouched, 3000);
    assertTrue(!s.crouched, 'clear of the lintel, releasing Ctrl stands up');
    console.log('PASS: crouching clears the lintel that stops a standing walker');

    await lane(4);
    await down('ControlLeft');
    await sleep(500);
    await frame.evaluate(() => { const c = window.__atlasActive3D.camera.pos; c[2] = 0.0; });
    await sleep(300);
    await up('ControlLeft');
    await sleep(700);
    s = await state();
    assertTrue(s.crouched && s.bodyHeight === 1.2, 'under the lintel with Ctrl released: stays crouched ' + JSON.stringify(s));
    await sampleStart();
    await tap('Space', 300);
    await sleep(500);
    m = await sampleStop();
    s = await state();
    assertTrue(m.peak === 0 && s.crouched, 'jumping is refused while the standing height is blocked: peak ' + m.peak);
    await down('KeyW');
    s = await until((v) => !v.crouched, 4000);
    await up('KeyW');
    assertTrue(!s.crouched, 'stands up once out from under it');
    console.log('PASS: standing up and jumping are refused under the lintel, allowed once clear');

    // 5f: the beam: walk under standing, jump capped
    await lane(7);
    await down('KeyW');
    s = await until((v) => v.pos[2] < -0.7, 5000);
    await up('KeyW');
    assertTrue(s.pos[2] < -0.5 && s.feetY === 0, 'a beam above head height is walked under: ' + JSON.stringify(s));
    await place(7, 0);
    await sampleStart();
    await tap('Space', 300);
    await sleep(1500);
    m = await sampleStop();
    assertTrue(m.peak > 0.2 && m.peak <= 0.42, 'the head stops at the beam underside (peak ' + m.peak.toFixed(3) + ', limit 0.4)');
    console.log('PASS: a jump under the beam is capped at ' + m.peak.toFixed(2));

    // 5g: floor limits at every height
    await place(12.5, 5);
    await down('KeyD');
    for (let i = 0; i < 12; i++) { await down('Space'); await sleep(200); await up('Space'); await sleep(200); }
    await up('KeyD');
    s = await state();
    assertTrue(s.pos[0] <= 14.2, 'jumping at the edge does not leave the floor: x=' + s.pos[0].toFixed(2));
    console.log('PASS: floor limits hold while jumping (x=' + s.pos[0].toFixed(2) + ')');

    // 5h: action bar poses do not disturb jump or crouch
    await place(12.5, 8);
    await down('Digit5'); // block
    await sampleStart();
    await tap('Space', 250);
    await sleep(1500);
    m = await sampleStop();
    assertTrue(m.peak > 0.5 && m.peak < 0.65, 'jumping while blocking: peak ' + m.peak.toFixed(3));
    await down('ControlLeft');
    await sleep(800);
    s = await state();
    assertTrue(s.crouched && near(s.modelSquash, 1.2 / 1.8, 0.01) && s.modelBaseY === 0, 'crouching while blocking: ' + JSON.stringify(s));
    await up('ControlLeft');
    await up('Digit5');
    await sleep(700);
    await sampleStart();
    await tap('Space', 250);
    await sleep(150);
    await tap('Digit1', 150);
    await sleep(1500);
    m = await sampleStop();
    s = await state();
    assertTrue(m.peak > 0.5 && m.peak < 0.65 && s.grounded && s.feetY === 0, 'a strike in mid-air does not change the jump: peak ' + m.peak.toFixed(3));
    console.log('PASS: Action Bar poses and blocking leave jumping and crouching alone');

    assertTrue(pageErrors.length === 0, 'no runtime errors: ' + pageErrors.slice(0, 3).join(' | '));
    ok = true;
  } catch (err) {
    console.log('FAIL: ' + (err && err.stack ? err.stack : err));
  } finally {
    await context.close();
    await lab.stop();
    lab.cleanup();
  }
  console.log(ok ? '\nMOVEMENT 3D BROWSER CHECK PASSED' : '\nMOVEMENT 3D BROWSER CHECK FAILED');
  process.exit(ok ? 0 : 1);
})();
