// Manual check for the 3D mouse-hover cursor hint (Bruno's confirmed spec,
// verbatim: "cursor as hint only the rest stays the same, build it now").
// Hovering the mouse over an on-screen interactable/dropped item in a
// gltf-mini-v1 (3D) world now swaps canvas.style.cursor to 'pointer', at
// ANY distance — not gated by the proximity radius that already drives the
// walk-up "E — <label>" prompt/Previewer. This is deliberately the ONLY
// visible effect: it never opens anything from a distance, and the existing
// proximity-triggered E-press flow is untouched by it.
//
// This test only exercises the NEW hover wiring (ray-cast -> cursor style).
// The pre-existing proximity/E-press pipeline this feature must leave alone
// already has its own dedicated coverage in manual-lobby-interactables.js
// (same lobby, same crates) — re-run that one alongside this file to prove
// no regression, rather than duplicating its assertions here.
//
// Positions/radius below are hardcoded from spatial/lobby/scene.json's own
// `interactables` entry and `camera.start` eye height, same reasoning
// manual-lobby-interactables.js's own header comment already gives for
// hardcoding scene content instead of reading it back live (gltf-mini.js
// deliberately never exposes a live interactables list to test against).
//
// Not part of the permanent suite (test/verify*.js) — same reasoning as the
// other manual-*3d*/manual-lobby-*.js files: depends on the heavier
// WebGL/xvfb machinery those already use.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

// spatial/lobby/scene.json: interactables[0] ("Open the crate").
const CRATE = { position: [0.3, 0, -0.8], radius: 1.7 };
// spatial/lobby/scene.json: camera.start === [0, 1.6, 2.4] — the first-
// person eye height every frame's render loop pins camera.pos[1] back to
// (standingEyeY) whenever airborne/crouch are both false, which they are
// throughout this test (no movement keys are ever pressed).
const EYE_Y = 1.6;
const FAR_AWAY = { x: 20, z: 20 };
// A closer stand point than FAR_AWAY, used for STEP 2 below, chosen so the
// crate's angular footprint at both the old (raw, pre-fix) radius and the
// new tightened one are comfortably far apart in degrees — see that step's
// own comment for the actual numbers.
const NEAR_STAND = { x: 5, z: CRATE.position[2] };

async function teleport(frame, x, z) {
  await frame.evaluate(({ x, z }) => {
    window.__atlasActive3D.camera.pos[0] = x;
    window.__atlasActive3D.camera.pos[2] = z;
  }, { x, z });
}

// Points the camera from (eyeX, EYE_Y, eyeZ) exactly at `target`, using the
// same yaw/pitch convention gltf-mini.js's own fwd vector is built from
// (fwd = [sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch)] — see
// mat4View and currentEyeAndBasis()) — plain "look-at" trigonometry, kept
// separate from (and not reused from) the ray-casting code under test, so
// this test isn't just checking the feature against its own math.
function lookAtAngles(eyeX, eyeZ, target) {
  const dx = target[0] - eyeX, dy = target[1] - EYE_Y, dz = target[2] - eyeZ;
  const horizDist = Math.hypot(dx, dz);
  const pitch = Math.atan2(dy, horizDist);
  const yaw = Math.atan2(dx, -dz);
  return { yaw, pitch };
}

async function aimAt(frame, eyeX, eyeZ, target) {
  await teleport(frame, eyeX, eyeZ);
  const { yaw, pitch } = lookAtAngles(eyeX, eyeZ, target);
  await frame.evaluate(({ yaw, pitch }) => {
    window.__atlasActive3D.camera.yaw = yaw;
    window.__atlasActive3D.camera.pitch = pitch;
  }, { yaw, pitch });
}

async function cursorStyle(frame) {
  return frame.evaluate(() => document.getElementById('scene3d').style.cursor);
}

// Converts an angular offset from dead-center (radians, purely horizontal)
// into a CSS-pixel position within the canvas element, using the exact same
// tan(fov/2)*aspect relationship onCanvasHoverMove() itself uses to turn a
// mouse position into a ray direction (fovY = Math.PI/3, same as the
// projection matrix in the render loop) — this is shared, already-exercised
// screen/ray geometry (STEP 1's dead-center hit already proves it lines up),
// not the radius-shrink fix STEP 2 below is actually testing, so using it to
// place the mouse at a precise, known angle isn't circular for that check.
function pixelForAngle(canvasBox, aspect, angleRad) {
  const tanFov = Math.tan(Math.PI / 6); // half of the 60° vertical FOV
  const ndcX = Math.tan(angleRad) / (tanFov * aspect);
  return { x: ((ndcX + 1) / 2) * canvasBox.width, y: canvasBox.height / 2 };
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-3d-hover-cursor-hint');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--use-gl=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist'
    ]
  });

  try {
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));

    console.log('SETUP: creating an identity and walking into the lobby');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    frame.on('pageerror', (err) => console.log('FRAMEERROR:', String(err)));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('3d-hover-cursor-hint-password');
    await frame.locator('#newPasswordConfirmInput').fill('3d-hover-cursor-hint-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

    const lobbyHb = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        if (portalHitboxes.length) {
          const hb = portalHitboxes.find((h) => h.marker.portal && h.marker.portal.to === 'lobby');
          if (hb) return resolve({ sx: hb.sx, sy: hb.sy });
        }
        requestAnimationFrame(check);
      };
      check();
    }));
    await frame.locator('#scene').click({ position: { x: lobbyHb.sx, y: lobbyHb.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
    await frame.waitForFunction(() => !!window.__atlasActive3D, { timeout: 10000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    console.log('PASS: entered the 3D lobby with a fresh wallet');

    const canvasBox = await frame.locator('#scene3d').boundingBox();
    if (!canvasBox) throw new Error('Expected #scene3d to have a visible bounding box once the 3D lobby is active');

    console.log('STEP 1: standing FAR AWAY from the crate (well outside its E-press radius), aim the camera at it and hover dead center — the cursor should still become a pointer, proving the hint is not gated by proximity');
    await teleport(frame, FAR_AWAY.x, FAR_AWAY.z);
    await aimAt(frame, FAR_AWAY.x, FAR_AWAY.z, CRATE.position);
    await frame.waitForTimeout(100); // let a render frame settle camera.pos[1] back to EYE_Y
    await frame.locator('#scene3d').hover({ position: { x: canvasBox.width / 2, y: canvasBox.height / 2 } });
    await frame.waitForFunction(() => document.getElementById('scene3d').style.cursor === 'pointer', { timeout: 5000 });
    const promptWhileFarHover = await frame.evaluate(() => window.__atlasActive3D.getInteractPrompt());
    if (promptWhileFarHover !== null) throw new Error('Expected no E-press prompt while merely hovering from far away, got: ' + JSON.stringify(promptWhileFarHover));
    console.log('PASS: cursor became a pointer at long range, and the E-prompt/Previewer stayed completely untouched — hover is purely a cursor hint, exactly as specced');

    console.log('STEP 2: Bruno\'s feedback on the first version — the cursor lit up well before the mouse was actually over the object, because the raw walk-up radius (1.7 for this crate) was reused as-is for the hover sphere. Standing closer (so the angular math is comfortable) and looking at the crate dead-on, a mouse position 12deg off-center sits OUTSIDE the tightened hover radius (~5.8deg angular footprint after the shrink) but would have been comfortably INSIDE the old raw radius\'s ~20deg footprint — the cursor should stay put, not go pointer');
    await aimAt(frame, NEAR_STAND.x, NEAR_STAND.z, CRATE.position);
    await frame.waitForTimeout(100);
    const aspect = await frame.evaluate(() => { const c = document.getElementById('scene3d'); return c.width / c.height; });
    const offCenterPos = pixelForAngle(canvasBox, aspect, 12 * Math.PI / 180);
    await frame.locator('#scene3d').hover({ position: offCenterPos });
    await frame.waitForTimeout(150); // no waitForFunction target here — proving a NEGATIVE (cursor never becomes pointer), so give it a beat and check once
    const cursorAtModerateOffset = await cursorStyle(frame);
    if (cursorAtModerateOffset === 'pointer') throw new Error('Expected the cursor to stay off the crate at a 12deg offset (outside the tightened hover radius) — got pointer, meaning the hit sphere is still too wide');
    console.log('PASS: at a moderate offset that used to fall inside the old wide radius, the cursor no longer lights up — the hint now tracks the object much more closely');

    console.log('STEP 3: back to dead-center from the same near stand point — should still hit (sanity check that STEP 2\'s miss is about the offset, not the closer distance)');
    await frame.locator('#scene3d').hover({ position: { x: canvasBox.width / 2, y: canvasBox.height / 2 } });
    await frame.waitForFunction(() => document.getElementById('scene3d').style.cursor === 'pointer', { timeout: 5000 });
    console.log('PASS: dead-center still hits from the closer distance too');

    console.log('STEP 4: moving the mouse to a far corner of the canvas points the ray well away from the crate — the cursor should reset');
    await frame.locator('#scene3d').hover({ position: { x: 2, y: 2 } });
    await frame.waitForFunction(() => document.getElementById('scene3d').style.cursor !== 'pointer', { timeout: 5000 });
    console.log('PASS: cursor reset once the ray no longer points at anything interactable');

    console.log('STEP 5: hovering back over the crate\'s on-screen position brings the pointer cursor right back (proves this is live per-mousemove tracking, not a one-shot state)');
    await frame.locator('#scene3d').hover({ position: { x: canvasBox.width / 2, y: canvasBox.height / 2 } });
    await frame.waitForFunction(() => document.getElementById('scene3d').style.cursor === 'pointer', { timeout: 5000 });
    console.log('PASS: cursor tracks the mouse live');

    console.log('STEP 6: dragging to look around (mouse button held) suppresses the hover ray entirely, so it never fights with camera rotation');
    const dragStart = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    const yawBeforeDrag = await frame.evaluate(() => window.__atlasActive3D.camera.yaw);
    await page.mouse.move(dragStart.x + 120, dragStart.y, { steps: 5 });
    const yawDuringDrag = await frame.evaluate(() => window.__atlasActive3D.camera.yaw);
    await page.mouse.up();
    if (yawDuringDrag === yawBeforeDrag) throw new Error('Expected camera.yaw to change from a click-drag (pre-existing look-around behavior) — the new hover listener may be interfering with it');
    console.log('PASS: click-drag camera look still works unaffected by the new mousemove listener (yaw changed from ' + yawBeforeDrag + ' to ' + yawDuringDrag + ')');

    console.log('\nALL 3D HOVER-CURSOR-HINT CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
