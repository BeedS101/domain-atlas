// Manual check for the new Settings -> Cache category: shows a real total
// and a real per-site breakdown of what's actually in the asset cache
// (populated by visiting the Lobby, a real gltf-mini-v1 world), clearing
// one site's cache actually clears it, and export/import round-trips a
// real file. Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

async function projectPortals(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
          const points = window.__atlasScene.portalMarkers.map((m) => {
            const [x, , z] = m.position;
            return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, to: m.portal && m.portal.to };
          });
          resolve(points);
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  });
}

async function openCacheCategory(frame) {
  await frame.locator('#settingsTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
  const category = frame.locator('.settings-category[data-category="cache"]');
  if (!(await category.evaluate((el) => el.classList.contains('open')))) {
    await category.locator('.settings-category-toggle').click();
  }
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-cache-settings');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: entering the Lobby to populate the asset cache with real GLB downloads');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    let portals = await projectPortals(frame);
    const toLobby = portals.find((p) => p.to === 'lobby');
    await frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
    await page.waitForTimeout(4000); // let all 19 GLBs finish downloading + caching
    console.log('PASS: entered the Lobby, assets should now be cached');

    console.log('STEP 1: opening Settings -> Cache shows a real total and one site (localhost:8001)');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('cache-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('cache-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    await openCacheCategory(frame);
    await frame.waitForFunction(() => document.getElementById('cacheTotalLine').textContent.includes('total across'), { timeout: 5000 });
    const totalLine = await frame.locator('#cacheTotalLine').textContent();
    console.log('  cache total line ->', totalLine);
    if (!totalLine.includes('1 site')) throw new Error('Expected exactly 1 site so far, got: ' + totalLine);
    const siteCards = frame.locator('#cacheSitesList .info-card');
    if (await siteCards.count() !== 1) throw new Error('Expected exactly one site card');
    const siteMeta = await siteCards.first().locator('.meta').textContent();
    if (!siteMeta.includes('19 files')) throw new Error('Expected 19 cached files for localhost:8001, got: ' + siteMeta);
    console.log('PASS: Cache category shows a real total and the right per-site breakdown ->', siteMeta);

    console.log('STEP 2: exporting the cache — should download a real file with 19 entries');
    const downloadPromise = page.waitForEvent('download');
    await frame.locator('#exportCacheBtn').click();
    const download = await downloadPromise;
    const exportPath = path.resolve(__dirname, 'cache-export-tmp.json');
    await download.saveAs(exportPath);
    const fs = require('fs');
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    if (exported.format !== 'domain-atlas-asset-cache/1.0') throw new Error('Unexpected export format: ' + exported.format);
    if (exported.entries.length !== 19) throw new Error('Expected 19 exported entries, got: ' + exported.entries.length);
    if (!exported.entries.every((e) => e.url && e.lastModified && e.bytesBase64)) throw new Error('Some exported entry is missing url/lastModified/bytesBase64');
    console.log('PASS: exported a real file — 19 entries, each with url/lastModified/bytesBase64');

    console.log('STEP 3: clearing localhost:8001\'s cache — site disappears, total goes to zero');
    page.once('dialog', (d) => d.accept());
    await siteCards.first().locator('button[data-action="clear-site"]').click();
    await frame.waitForFunction(() => document.getElementById('cacheTotalLine').textContent === 'Nothing cached yet.', { timeout: 5000 });
    console.log('PASS: cache cleared for that site, total line confirms nothing left');

    console.log('STEP 4: importing the previously exported file — 19 entries restored');
    await frame.locator('#importCacheBtn').click();
    await frame.locator('#importCacheFileInput').setInputFiles(exportPath);
    await frame.waitForFunction(() => document.getElementById('importCacheStatus').textContent.includes('19 cached file(s) imported'), { timeout: 5000 });
    await frame.waitForFunction(() => document.getElementById('cacheTotalLine').textContent.includes('1 site'), { timeout: 5000 });
    const restoredMeta = await frame.locator('#cacheSitesList .info-card').first().locator('.meta').textContent();
    if (!restoredMeta.includes('19 files')) throw new Error('Expected 19 files restored after import, got: ' + restoredMeta);
    console.log('PASS: import round-tripped correctly — same site, same 19 files ->', restoredMeta);

    fs.unlinkSync(exportPath);

    console.log('\nALL CACHE SETTINGS CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
