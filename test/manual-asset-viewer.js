// Manual check for #150: the Asset Viewer hover panel on the wallet's
// Resources/Items lists (Collectibles/Documents, both rendered by
// renderAssetCard() in viewer.js — see refreshInventoryDisplay() for how
// both sub-tabs and both the self/counterparty columns of each all feed
// through it). Hovering an asset card opens a floating panel with its
// name/class/issuer/full properties (no click-to-expand toggle — the
// panel has room), plus its thumbnail image and a click-to-render 3D model
// preview whenever the credential declares those optional SPEC.md §5
// fields (`asset.thumbnail`/`asset.model`).
//
// Covers, live: opening on hover with the right content; the thumbnail
// actually loading; the sticky hover-bridge (moving from the card straight
// onto the panel keeps it open, rather than closing before "Show model"
// can ever be reached); a real "Show model" click creating an actual
// canvas + WebGL context; moving away from both the card and the panel
// (past the close-grace window) closing it AND explicitly losing that
// WebGL context (not just hiding/removing the canvas); and the settings
// popover's opacity/text-size sliders persisting across a reload.
//
// A note on the demo data: the catalog's Bronze Compass (atlas.wearable,
// issuer-server/server.js's ASSET_CATALOG) already declared both
// `asset.thumbnail` and `asset.model` before this feature existed — it's
// SPEC.md §5's own example asset, and every class in this demo catalog
// happens to set both fields, so there was nothing to add there. Those
// URLs point at https://localhost:8001/assets/compass.{png,glb}, but the
// local dev issuer only ever speaks plain HTTP (no TLS setup exists for
// it) — a pre-existing catalog/dev-server mismatch this feature didn't
// create and isn't the place to fix. So: two real files were added at
// demo-domain-a/assets/compass.{png,glb} (the .glb is a copy of an
// existing, already-proven-loadable furniture-kit model — see this repo's
// own assets/furniture — the .png a small placeholder icon), and this
// script intercepts those exact two https:// URLs at the network level,
// fulfilling them from those real local files, so the rest of the script
// exercises the actual fetch → image-load / fetch → parseGLB → WebGL-
// upload pipeline end to end rather than skip the live check. Since no
// demo class omits BOTH fields, the "neither field present" fallback
// (task #150 point 6) is exercised by calling the real, page-global
// renderAssetViewerContent() directly against a synthetic asset object —
// still real application code, running in the real page, just without a
// full mint round-trip for a class that doesn't exist in this catalog.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const COMPASS_PNG = path.resolve(__dirname, '..', 'demo-domain-a', 'assets', 'compass.png');
const COMPASS_GLB = path.resolve(__dirname, '..', 'demo-domain-a', 'assets', 'compass.glb');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-asset-viewer');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    // See header comment: work around the local-only https/http mismatch
    // on the catalog's own thumbnail/model URLs by serving the real local
    // files for exactly those two requests, rather than mocking any part
    // of the feature itself.
    await context.route('https://localhost:8001/assets/compass.png', (route) => {
      route.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(COMPASS_PNG) });
    });
    await context.route('https://localhost:8001/assets/compass.glb', (route) => {
      route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: fs.readFileSync(COMPASS_GLB) });
    });

    const page = await context.newPage();

    console.log('SETUP: fresh identity + one Bronze Compass (has both thumbnail and model)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('asset-viewer-test-pw');
    await frame.locator('#newPasswordConfirmInput').fill('asset-viewer-test-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    console.log('PASS: identity + Bronze Compass ready');

    console.log('STEP 1: hovering the card opens the Asset Viewer with the correct name/class/issuer/properties');
    const card = frame.locator('#selfCollectiblesList .wallet-item').first();
    await card.hover();
    await frame.waitForFunction(() => document.getElementById('assetViewerWidget').hidden === false, { timeout: 3000 });
    const content = await frame.evaluate(() => ({
      name: document.querySelector('#assetViewerBody .name').textContent,
      meta: document.querySelector('#assetViewerBody .meta').textContent,
      propCount: document.querySelectorAll('#assetViewerBody .asset-viewer-properties > div').length
    }));
    if (!content.name.includes('Bronze Compass')) throw new Error('Expected "Bronze Compass" in the viewer name, got: ' + content.name);
    if (!content.meta.includes('atlas.wearable') || !content.meta.includes('localhost:8001')) throw new Error('Expected class + issuer domain in the viewer meta, got: ' + content.meta);
    if (content.propCount !== 4) throw new Error('Expected all 4 properties shown directly (no click-to-expand toggle), got ' + content.propCount);
    console.log('PASS: viewer shows name/class/issuer and the full properties list, no toggle needed');

    console.log('STEP 2: the Bronze Compass HAS a thumbnail — the viewer shows it, and it actually loads');
    await frame.waitForFunction(() => {
      const img = document.querySelector('#assetViewerBody .asset-viewer-thumbnail');
      return !!img && img.complete && img.naturalWidth > 0;
    }, { timeout: 5000 });
    console.log('PASS: thumbnail image is present and actually loaded (not a broken image)');

    console.log('STEP 3: the Bronze Compass HAS a model — "Show model" is offered');
    const showModelBtnCount = await frame.locator('#assetViewerShowModelBtn').count();
    if (showModelBtnCount !== 1) throw new Error('Expected exactly one Show model button for an asset with asset.model, got ' + showModelBtnCount);
    console.log('PASS: Show model button present');

    console.log('STEP 4: moving the mouse from the card straight onto the viewer panel keeps it open (not just leaving the card)');
    await frame.locator('#assetViewerBody').hover();
    await frame.page().waitForTimeout(300); // past the 200ms close-grace window, if it had (wrongly) started on the card's own mouseleave
    const stillOpenAfterMovingOntoViewer = await frame.evaluate(() => document.getElementById('assetViewerWidget').hidden === false);
    if (!stillOpenAfterMovingOntoViewer) throw new Error('Viewer closed even though the mouse moved from the card straight onto the panel itself');
    console.log('PASS: viewer stays open once the mouse is on the panel');

    console.log('STEP 5: clicking "Show model" actually creates a canvas with a live WebGL context');
    await frame.locator('#assetViewerShowModelBtn').click();
    await frame.waitForFunction(() => {
      const c = document.querySelector('.asset-viewer-model-canvas');
      return !!c && c.width > 0 && c.height > 0;
    }, { timeout: 10000 });
    const glInfo = await frame.evaluate(() => {
      const c = document.querySelector('.asset-viewer-model-canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      window.__assetViewerTestCtx = gl; // stashed so STEP 6 can confirm real context loss, not just DOM/canvas removal
      return { width: c.width, height: c.height, hasGl: !!gl, isLost: gl ? gl.isContextLost() : null };
    });
    if (!glInfo.hasGl || glInfo.width === 0 || glInfo.height === 0 || glInfo.isLost) {
      throw new Error('Expected a live, non-lost WebGL context on a non-zero-size canvas, got: ' + JSON.stringify(glInfo));
    }
    console.log('PASS: Show model created a real canvas with a live WebGL context: ' + JSON.stringify(glInfo));

    console.log('STEP 6: moving away from both the card and the viewer (past the grace window) closes it and disposes the live preview');
    await frame.page().mouse.move(5, 5); // nowhere near either the card or the panel
    await frame.page().waitForTimeout(500); // past ASSET_VIEWER_CLOSE_GRACE_MS (200ms)
    const closedState = await frame.evaluate(() => ({
      hidden: document.getElementById('assetViewerWidget').hidden,
      canvasGone: !document.querySelector('.asset-viewer-model-canvas'),
      contextLost: window.__assetViewerTestCtx ? window.__assetViewerTestCtx.isContextLost() : null
    }));
    if (!closedState.hidden) throw new Error('Expected the viewer to close after leaving both the card and the panel');
    if (!closedState.canvasGone) throw new Error('Expected the model preview canvas to be removed on close');
    if (closedState.contextLost !== true) throw new Error('Expected the WebGL context to be explicitly lost on close (WEBGL_lose_context), not just hidden/removed — isContextLost()=' + closedState.contextLost);
    console.log('PASS: viewer closed and the WebGL context was actually lost, not just hidden');

    console.log('STEP 7: an asset with NEITHER thumbnail nor model shows no image area and no Show model link');
    // No demo catalog class actually omits both fields (see header
    // comment) — this calls the real renderAssetViewerContent() directly,
    // in the real page, against a synthetic asset lacking them.
    const fallback = await frame.evaluate(() => {
      const fakeEntry = {
        credential: {
          id: 'urn:atlas:asset:test-fallback',
          issuer: { domain: 'localhost:8001' },
          quantity: 1,
          asset: {
            name: 'Plain Test Rock', class: 'com.example.rock', fungible: false,
            properties: { 'atlas.rarity': 'common' }
            // deliberately no thumbnail, no model
          }
        }
      };
      renderAssetViewerContent(fakeEntry);
      return {
        hasImage: !!document.querySelector('#assetViewerBody .asset-viewer-thumbnail'),
        hasShowModelBtn: !!document.getElementById('assetViewerShowModelBtn'),
        name: document.querySelector('#assetViewerBody .name').textContent
      };
    });
    if (fallback.hasImage) throw new Error('Expected no thumbnail image for an asset with no asset.thumbnail');
    if (fallback.hasShowModelBtn) throw new Error('Expected no Show model button for an asset with no asset.model');
    if (!fallback.name.includes('Plain Test Rock')) throw new Error('Expected the fallback asset to still render its name: ' + fallback.name);
    console.log('PASS: an asset with neither field renders cleanly, no image area and no Show model link, nothing thrown');
    await frame.evaluate(() => closeAssetViewer()); // tidy state before STEP 8 re-hovers the real card

    console.log('STEP 8: changing the opacity/text-size sliders persists across a reload of the wallet panel');
    await card.hover();
    await frame.waitForFunction(() => document.getElementById('assetViewerWidget').hidden === false, { timeout: 3000 });
    await frame.locator('#assetViewerSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('assetViewerSettingsPopover').hidden === false, { timeout: 3000 });
    await frame.locator('#assetViewerOpacityInput').evaluate((el) => { el.value = '0.55'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await frame.locator('#assetViewerTextSizeInput').evaluate((el) => { el.value = '17'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await frame.page().waitForTimeout(200); // let setAssetViewerSettings()/chrome.storage round-trip settle, same margin manual-chat-history-toggle.js uses for its own settings write
    const savedSettings = await frame.evaluate(() => AtlasWallet.getAssetViewerSettings());
    if (savedSettings.opacity !== 0.55 || savedSettings.textSize !== 17) {
      throw new Error('Expected the new opacity/text-size to already be persisted before reload, got: ' + JSON.stringify(savedSettings));
    }

    await page.reload({ waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle2 = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame2 = await frameHandle2.contentFrame();
    await frame2.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame2.page().waitForTimeout(300); // let AtlasWallet.getAssetViewerSettings().then(applyAssetViewerSettings) run at startup
    const restoredSettings = await frame2.evaluate(() => AtlasWallet.getAssetViewerSettings());
    if (restoredSettings.opacity !== 0.55 || restoredSettings.textSize !== 17) {
      throw new Error('Expected opacity/text-size to survive a reload, got: ' + JSON.stringify(restoredSettings));
    }
    const restoredPanelStyle = await frame2.evaluate(() => ({
      opacity: document.getElementById('assetViewerPanel').style.opacity,
      fontSize: document.getElementById('assetViewerBody').style.fontSize
    }));
    if (restoredPanelStyle.opacity !== '0.55' || restoredPanelStyle.fontSize !== '17px') {
      throw new Error('Expected the restored settings to actually be APPLIED to the panel on load (not just sitting in storage), got: ' + JSON.stringify(restoredPanelStyle));
    }
    console.log('PASS: opacity/text-size persist across a reload, and are re-applied to the panel on load');

    console.log('\nALL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
