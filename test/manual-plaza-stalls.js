// Manual check for the Plaza's clickable item stalls: the Compass Stall
// issues a Bronze Compass capped at one per user (a second click says
// "already collected" instead of issuing a duplicate), and the Ring Stall
// issues a Merchant's Signet Ring whose properties bag demonstrates both
// plain static values AND one array-valued property
// (com.example.enchantments) — checking both that the array survives
// issuance/verification and that the wallet UI renders it readably rather
// than JS's default "a,b,c" stringification. Not part of the permanent
// suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

async function projectInteractables(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        if (scene && scene.interactables && scene.interactables.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2;
          const originY = canvas.height / 2 + 40;
          const points = scene.interactables.map((m) => {
            const [x, y, z] = m.position;
            const p = project(x, y || 0, z, originX, originY);
            return { sx: p.x, sy: p.y - 16, label: m.label, class: m.class };
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
  const userDataDir = path.resolve(__dirname, '.chrome-profile-plaza-stalls');
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

    console.log('SETUP: creating an identity in the Plaza');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('plaza-stall-password');
    await frame.locator('#newPasswordConfirmInput').fill('plaza-stall-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    console.log('PASS: identity created');

    const [compassStall, ringStall] = await projectInteractables(frame);
    if (!compassStall || compassStall.class !== 'atlas.wearable') throw new Error('Expected the first interactable to be the compass stall: ' + JSON.stringify(compassStall));
    if (!ringStall || ringStall.class !== 'atlas.wearable.ring') throw new Error('Expected the second interactable to be the ring stall: ' + JSON.stringify(ringStall));

    console.log('STEP 1: clicking the Compass Stall collects a Bronze Compass');
    await frame.locator('#scene').click({ position: { x: compassStall.sx, y: compassStall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Collected'), { timeout: 10000 });
    const statusAfterFirstCompass = await frame.locator('#status').textContent();
    if (!statusAfterFirstCompass.includes('Bronze Compass')) throw new Error('Expected the status to mention the Bronze Compass: ' + statusAfterFirstCompass);
    console.log('PASS:', statusAfterFirstCompass);

    console.log('STEP 2: clicking the Compass Stall again does NOT issue a second one (oncePerUser)');
    await frame.locator('#scene').click({ position: { x: compassStall.sx, y: compassStall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Already collected'), { timeout: 10000 });
    const statusAfterSecondCompass = await frame.locator('#status').textContent();
    console.log('PASS:', statusAfterSecondCompass);
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 5000 });
    const compassCount = await frame.evaluate(() => {
      return [...document.querySelectorAll('#selfCollectiblesList .wallet-item .name')].filter((el) => el.textContent.includes('Bronze Compass')).length;
    });
    if (compassCount !== 1) throw new Error('Expected exactly one Bronze Compass in the wallet, got ' + compassCount);
    console.log('PASS: exactly one Bronze Compass in the wallet despite two clicks');

    console.log('STEP 3: clicking the Ring Stall collects a Signet Ring with a rich properties bag');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#scene').click({ position: { x: ringStall.sx, y: ringStall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Collected'), { timeout: 10000 });
    const statusAfterRing = await frame.locator('#status').textContent();
    if (!statusAfterRing.includes('Signet Ring')) throw new Error('Expected the status to mention the Signet Ring: ' + statusAfterRing);
    console.log('PASS:', statusAfterRing);

    console.log('STEP 4: the ring card\'s Properties panel shows the array value readably, not as "a,b,c"');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const ringCard = frame.locator('#selfCollectiblesList .wallet-item', { hasText: 'Signet Ring' });
    await ringCard.locator('button[data-action="toggle-properties"]').click();
    const detailText = await ringCard.locator('.properties-detail').textContent();
    if (!detailText.includes('fire resistance, silent step, luck +2')) {
      throw new Error('Expected the array property to render as a comma-and-space-joined list, got: ' + detailText);
    }
    if (!detailText.includes('atlas.rarity: rare') || !detailText.includes('com.example.material: silver') || !detailText.includes('com.example.origin: Coastal Bazaar')) {
      throw new Error('Expected the static properties to also be present: ' + detailText);
    }
    console.log('PASS: properties panel shows both static values and the array value readably ->', detailText);

    console.log('\nALL PLAZA STALL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
