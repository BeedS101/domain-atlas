const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

function shot(name) {
  return path.resolve(__dirname, name);
}

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
            return {
              sx: originX + (x - z) * COS30 * SCALE,
              sy: originY + (x + z) * SIN30 * SCALE, // canvas-local y (bar is outside canvas)
              kind: m.portal && m.portal.kind,
              to: m.portal && m.portal.to
            };
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

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    const page = await context.newPage();
    const manifestFetches = [];
    page.on('request', (req) => {
      if (req.url().includes('/.well-known/spatial.json')) manifestFetches.push(req.url());
    });

    console.log('STEP 1: visiting http://localhost:8001 (Example Plaza, 5 worlds: plaza/museum/arena/market/lobby)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });

    const btn = page.locator('#domain-atlas-enter-btn');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    const btnText = await btn.textContent();
    console.log('PASS: manifest detected, button ->', btnText);
    if (!btnText.includes('+4 more')) throw new Error('Expected button to advertise the other four worlds');

    await page.screenshot({ path: shot('01-plaza-page-with-button.png') });

    console.log('STEP 2: entering the space (opens defaultWorld: plaza)');
    await btn.click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    console.log('PASS: viewer rendered Plaza world (localhost:8001 · plaza)');
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot('02-plaza-world.png') });

    const fetchesBeforeWorldPortal = manifestFetches.length;
    console.log('STEP 3: clicking the WORLD portal (plaza -> museum, same origin, index 0)');
    let portals = await projectPortals(frame);
    const toMuseum = portals.find((p) => p.kind === 'world');
    await frame.locator('#scene').click({ position: { x: toMuseum.sx, y: toMuseum.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Museum'), { timeout: 10000 });
    await page.waitForTimeout(500);
    const fetchesAfterWorldPortal = manifestFetches.length;
    console.log('PASS: rendered Museum world (localhost:8001 · museum)');
    if (fetchesAfterWorldPortal !== fetchesBeforeWorldPortal) {
      throw new Error('World portal caused a manifest re-fetch — spec says same-origin portals should not');
    }
    console.log('PASS: confirmed NO manifest re-fetch on the world portal (same cached manifest reused)');
    await page.screenshot({ path: shot('03-museum-world-no-refetch.png') });

    console.log('STEP 4: walking back to Plaza, then crossing the DOMAIN portal to localhost:8002');
    portals = await projectPortals(frame);
    const backToPlaza = portals.find((p) => p.kind === 'world');
    await frame.locator('#scene').click({ position: { x: backToPlaza.sx, y: backToPlaza.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.waitForFunction(() => window.__atlasScene && window.__atlasScene.portalMarkers.some((m) => m.portal && m.portal.kind === 'domain'), { timeout: 10000 });

    portals = await projectPortals(frame);
    const toNeighbor = portals.find((p) => p.kind === 'domain');
    const fetchesBeforeDomainPortal = manifestFetches.length;
    await frame.locator('#scene').click({ position: { x: toNeighbor.sx, y: toNeighbor.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), { timeout: 10000 });
    await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8002'), { timeout: 10000 });
    const fetchesAfterDomainPortal = manifestFetches.length;
    console.log('PASS: crossed to localhost:8002 · workshop (Neighbor Workshop)');
    if (fetchesAfterDomainPortal <= fetchesBeforeDomainPortal) {
      throw new Error('Domain portal should have fetched a new manifest and did not');
    }
    console.log('PASS: confirmed the domain portal DID fetch a fresh manifest (real trust-boundary crossing)');
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot('04-neighbor-workshop-domain.png') });

    console.log('STEP 5: walking back across the domain portal to Example Plaza');
    portals = await projectPortals(frame);
    const backToDomainA = portals.find((p) => p.kind === 'domain');
    await frame.locator('#scene').click({ position: { x: backToDomainA.sx, y: backToDomainA.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.includes('8001'), { timeout: 10000 });
    console.log('PASS: back at localhost:8001 · plaza (defaultWorld resolved correctly on re-entry)');

    console.log('\nManifest fetches observed over the whole run:', manifestFetches.length, '—', JSON.stringify(manifestFetches));
    console.log('ALL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
