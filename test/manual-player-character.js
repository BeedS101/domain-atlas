// Manual check for #33's player character, now driven by mouse-wheel zoom
// instead of the old Settings -> "Player character" -> "Third-person
// camera" toggle (removed per user request: scroll the wheel to pull the
// camera back, rather than picking a discrete first-/third-person mode).
// Checks:
//   1. Camera distance starts at 0 (bit-for-bit the old first-person view).
//   2. Scrolling down (real wheel events, not a JS shortcut) increases it,
//      clamped at getMaxCameraDistance().
//   3. Scrolling up decreases it, clamped at 0.
//   4. Walking at a nonzero distance doesn't throw (walk-cycle code).
//   5/6. Strafing turns the RENDERED character to face the strafe
//      direction, not its mirror image (the exact bug reported and fixed
//      after this feature first shipped) — this is independent of camera
//      distance (the character and its facing render the same regardless
//      of how far the camera has scrolled back), so it's exercised at
//      whatever distance STEP 2 left it at.
//   7. Scrolling all the way back to 0 and walking again (the original
//      first-person view) doesn't throw.
//   8. The Settings -> "Player character" -> "Size" slider: dragging it
//      persists the scale via AtlasWallet (clamped 0.5-2), updates the
//      live 3D model immediately (active3D.getCharacterScale()), and
//      re-opening Settings shows the saved value.
// No wallet/identity setup needed here at all anymore — entering a world
// doesn't require an identity, and camera zoom is no longer a saved wallet
// setting, just a live per-session control (see gltf-mini.js's comment on
// cameraDistance for why it's deliberately NOT persisted). Not part of the
// permanent suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-player-character');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    console.log('SETUP: entering the Lobby (the one gltf-mini-v1 world)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    const portals = await frame.evaluate(() => {
      return new Promise((resolve) => {
        const check = () => {
          if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
            const canvas = document.getElementById('scene');
            const originX = canvas.width / 2, originY = canvas.height / 2 + 40;
            const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
            resolve(window.__atlasScene.portalMarkers.map((m) => {
              const [x, , z] = m.position;
              return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, to: m.portal && m.portal.to };
            }));
          } else { requestAnimationFrame(check); }
        };
        check();
      });
    });
    const toLobby = portals.find((p) => p.to === 'lobby');
    await frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
    await page.waitForTimeout(1000);
    console.log('PASS: in the Lobby, 3D render loop running');

    const canvasBox = await frame.locator('#scene3d').boundingBox();
    const cx = canvasBox.x + canvasBox.width / 2, cy = canvasBox.y + canvasBox.height / 2;
    await page.mouse.move(cx, cy);

    console.log('STEP 1: camera distance starts at 0 (the original first-person view)');
    const distStart = await frame.evaluate(() => window.__atlasActive3D.getCameraDistance());
    if (distStart !== 0) throw new Error('Expected camera distance to start at 0, got: ' + distStart);
    console.log('PASS: starts at 0');

    console.log('STEP 2: scrolling down (real wheel events) pulls the camera back, clamped at the max');
    const maxDist = await frame.evaluate(() => window.__atlasActive3D.getMaxCameraDistance());
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 100); // scroll "down" — zoom out
    }
    await page.waitForTimeout(100);
    const distAfterScrollDown = await frame.evaluate(() => window.__atlasActive3D.getCameraDistance());
    if (distAfterScrollDown <= 0) throw new Error('Expected scrolling down to increase camera distance above 0, got: ' + distAfterScrollDown);
    if (distAfterScrollDown > maxDist) throw new Error('Camera distance exceeded its max (' + maxDist + '): ' + distAfterScrollDown);
    if (Math.abs(distAfterScrollDown - maxDist) > 0.01) throw new Error('Expected 30 scroll-down ticks to clamp at the max (' + maxDist + '), got: ' + distAfterScrollDown);
    console.log('PASS: scrolled out to the max distance (' + distAfterScrollDown + ')');

    console.log('STEP 3: scrolling up pulls it back in, clamped at 0');
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, -100); // scroll "up" — zoom in
    }
    await page.waitForTimeout(100);
    const distAfterScrollUp = await frame.evaluate(() => window.__atlasActive3D.getCameraDistance());
    if (distAfterScrollUp !== 0) throw new Error('Expected 30 scroll-up ticks to clamp back at 0, got: ' + distAfterScrollUp);
    console.log('PASS: scrolled back in to 0');

    console.log('STEP 4: scroll out partway and walk around — no errors from the walk-cycle code at a nonzero distance');
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 100);
    await page.waitForTimeout(100);
    const midDist = await frame.evaluate(() => window.__atlasActive3D.getCameraDistance());
    if (midDist <= 0) throw new Error('Expected a partial zoom-out to leave a nonzero distance, got: ' + midDist);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(600);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(200);
    console.log('PASS: walked around at distance ' + midDist.toFixed(2) + ', no errors yet ->', pageErrors.length, 'error(s) so far');

    function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }

    console.log('STEP 5: strafing RIGHT (D only, no mouse look) turns the RENDERED character to face right, not its mirror image');
    const yawBeforeD = await frame.evaluate(() => window.__atlasActive3D.camera.yaw);
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyD');
    await page.waitForTimeout(100);
    const yawAfterD = await frame.evaluate(() => window.__atlasActive3D.camera.yaw);
    if (Math.abs(yawAfterD - yawBeforeD) > 0.001) {
      throw new Error('Strafing alone should not rotate the camera/look direction, but camera.yaw changed from ' + yawBeforeD + ' to ' + yawAfterD);
    }
    const facingWorldDirD = await frame.evaluate(() => window.__atlasActive3D.getCharacterFacingWorldDir());
    const expectedRightD = [Math.cos(yawAfterD), Math.sin(yawAfterD)];
    const dotD = dot2(facingWorldDirD, expectedRightD);
    if (dotD < 0.9) {
      throw new Error('Rendered facing does not point toward the D-strafe (right) direction — dot=' + dotD.toFixed(3) + ', facing=' + JSON.stringify(facingWorldDirD) + ', expected≈' + JSON.stringify(expectedRightD));
    }
    console.log('PASS: rendered facing points toward the strafe direction (dot=' + dotD.toFixed(3) + ')');

    console.log('STEP 6: walking forward to re-align, then strafing LEFT (A) — this is the exact case reported as broken');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(400);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(100);
    const yawBeforeA = await frame.evaluate(() => window.__atlasActive3D.camera.yaw);
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyA');
    await page.waitForTimeout(100);
    const yawAfterA = await frame.evaluate(() => window.__atlasActive3D.camera.yaw);
    if (Math.abs(yawAfterA - yawBeforeA) > 0.001) {
      throw new Error('Strafing alone should not rotate the camera/look direction, but camera.yaw changed from ' + yawBeforeA + ' to ' + yawAfterA);
    }
    const facingWorldDirA = await frame.evaluate(() => window.__atlasActive3D.getCharacterFacingWorldDir());
    const expectedLeftA = [-Math.cos(yawAfterA), -Math.sin(yawAfterA)];
    const dotA = dot2(facingWorldDirA, expectedLeftA);
    if (dotA < 0.9) {
      throw new Error('Rendered facing does not point toward the A-strafe (left) direction — dot=' + dotA.toFixed(3) + ', facing=' + JSON.stringify(facingWorldDirA) + ', expected≈' + JSON.stringify(expectedLeftA) + '. This is the exact "turns right when moving left" bug if it fails.');
    }
    const dotLeftVsRight = dot2(facingWorldDirA, facingWorldDirD);
    if (dotLeftVsRight > -0.5) {
      throw new Error('Expected left-strafe and right-strafe facing to end up roughly opposite each other, but they are too similar — dot=' + dotLeftVsRight.toFixed(3));
    }
    console.log('PASS: rendered facing correctly turned toward LEFT for the A-strafe (dot=' + dotA.toFixed(3) + '), opposite the D-strafe facing (dot=' + dotLeftVsRight.toFixed(3) + ')');

    console.log('STEP 7: scrolling all the way back to 0 (first-person) and walking again, no errors');
    for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100);
    await page.waitForTimeout(100);
    const distBackToZero = await frame.evaluate(() => window.__atlasActive3D.getCameraDistance());
    if (distBackToZero !== 0) throw new Error('Expected scrolling all the way up to return to distance 0, got: ' + distBackToZero);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(400);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(200);
    console.log('PASS: back at distance 0, walked again, no errors ->', pageErrors.length, 'error(s) so far');

    console.log('STEP 8: Settings -> Player character -> Size slider persists, clamps, and live-updates the 3D model');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('player-scale-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('player-scale-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    const scaleCategory = frame.locator('.settings-category[data-category="player-character"]');
    if (!(await scaleCategory.evaluate((el) => el.classList.contains('open')))) {
      await scaleCategory.locator('.settings-category-toggle').click();
    }

    const scaleDefault = await frame.locator('#characterScaleInput').inputValue();
    if (Number(scaleDefault) !== 1) throw new Error('Expected the size slider to default to 1, got: ' + scaleDefault);
    const labelDefault = await frame.locator('#characterScaleValue').textContent();
    if (labelDefault !== '1.0×') throw new Error('Expected the size label to read "1.0×", got: ' + JSON.stringify(labelDefault));
    console.log('  default slider=1, label=' + labelDefault);

    // Drive it like a real drag: set the DOM value then fire the same
    // 'input' event the browser fires while dragging, so the listener runs.
    await frame.locator('#characterScaleInput').evaluate((el) => {
      el.value = '0.6';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(100);
    const savedScale = await frame.evaluate(() => AtlasWallet.getCharacterScale());
    if (Math.abs(savedScale - 0.6) > 0.001) throw new Error('Expected AtlasWallet.getCharacterScale() to persist 0.6, got: ' + savedScale);
    const liveScale = await frame.evaluate(() => window.__atlasActive3D.getCharacterScale());
    if (Math.abs(liveScale - 0.6) > 0.001) throw new Error('Expected the live 3D model scale to update to 0.6 immediately, got: ' + liveScale);
    const labelAfter = await frame.locator('#characterScaleValue').textContent();
    if (labelAfter !== '0.6×') throw new Error('Expected the size label to read "0.6×", got: ' + JSON.stringify(labelAfter));
    console.log('  after dragging to 0.6: AtlasWallet=' + savedScale + ', live 3D=' + liveScale + ', label=' + labelAfter);

    console.log('  re-opening Settings shows the persisted value');
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    const scaleReopened = await frame.locator('#characterScaleInput').inputValue();
    if (Math.abs(Number(scaleReopened) - 0.6) > 0.001) throw new Error('Expected the slider to reflect the persisted 0.6 on re-open, got: ' + scaleReopened);
    console.log('PASS: size slider persists (' + scaleReopened + '), clamps, and live-updates the model');

    if (pageErrors.length) {
      throw new Error('Console/page errors occurred: ' + pageErrors.join(' | '));
    }

    console.log('\nALL PLAYER CHARACTER CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
