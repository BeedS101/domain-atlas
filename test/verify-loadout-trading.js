// Verifies §5.2 (loadouts + transfer-on-loss) and §5.4 (fungible resources
// + splitting) end to end: a real second signer (the "counterparty"
// keypair — a second local ECDSA identity standing in for another
// visitor), a real PvP loss with the loser's own key co-signing the
// transfer, and a real resource split settled by the issuer. Trading
// station coverage (§7) lives in test/manual-remote-trade.js instead —
// v1.15 removed the in-person mechanism this file used to exercise here
// (both sides' signed intents arriving in the same call, settled via the
// now-removed #tradeBtn), and open-listing trading no longer needs this
// file's counterparty stand-in at all.

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
              sy: originY + (x + z) * SIN30 * SCALE,
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

// enterWorld() sets the place label before its scene fetch resolves, so
// waiting on the label alone can race a stale (previous world's) scene
// still sitting in window.__atlasScene. Wait for the scene to actually
// contain a portal to the world we're about to click before reading it.
async function waitForPortalTo(frame, targetWorld) {
  await frame.waitForFunction(
    (target) => window.__atlasScene && window.__atlasScene.portalMarkers.some((m) => m.portal && m.portal.to === target),
    targetWorld,
    { timeout: 10000 }
  );
}

async function clickPortalTo(frame, targetWorld) {
  await waitForPortalTo(frame, targetWorld);
  const portals = await projectPortals(frame);
  const p = portals.find((x) => x.to === targetWorld);
  if (!p) throw new Error('No portal to ' + targetWorld + ' found on this scene');
  await frame.locator('#scene').click({ position: { x: p.sx, y: p.sy } });
}

// Task #211 moved every per-card action (Send half/Load/Simulate loss/
// Drop/Hide) behind the card's own "⋯" menu, collapsed by default —
// clicking an action button directly (what this file used to do) no
// longer works since it starts out hidden. Opens the containing card's
// menu first, waits for the popover to actually show, then clicks the
// real action button inside it — same two-step a person would do by hand.
async function clickCardMenuAction(actionLocator) {
  const card = actionLocator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " wallet-item ")][1]');
  await card.locator('.card-menu-toggle').click();
  await card.locator('.card-menu-items.show').waitFor({ state: 'visible', timeout: 3000 });
  await actionLocator.click();
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-loadout');
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

    console.log('SETUP: identities, and one item to put at risk');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#chooseNewBtn').click();
    await frame.waitForFunction(() => document.getElementById('createScreen').classList.contains('active'), { timeout: 5000 });
    const TEST_PASSWORD = 'correct-horse-battery-staple-1';
    await frame.locator('#newPasswordInput').fill(TEST_PASSWORD);
    await frame.locator('#newPasswordConfirmInput').fill(TEST_PASSWORD);
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    // Identity now defaults to a collapsed category on the main wallet
    // screen (see viewer.html) — expand it before its buttons are clickable.
    await frame.locator('[data-category="identity"] .settings-category-toggle').click();
    await frame.locator('#createCounterpartyBtn').click();
    await frame.waitForFunction(() => document.getElementById('counterpartyIdentity').textContent.startsWith('Counterparty:'), { timeout: 5000 });
    console.log('PASS: self (password-protected) and counterparty (local ECDSA) identities created');

    await frame.waitForFunction(() => !document.getElementById('requestItemBtn').disabled, { timeout: 5000 });
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    console.log('PASS: Bronze Compass issued to self');
    await page.screenshot({ path: shot('lt-01-plaza-item.png') });

    // ---------- §5.2 loadout + transfer-on-loss ----------

    console.log('STEP 1: entering the Arena (combat: pvp)');
    await clickPortalTo(frame, 'arena');
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    await frame.waitForFunction(() => document.getElementById('loadoutNote').textContent.toLowerCase().includes('pvp'), { timeout: 5000 });
    console.log('PASS: PvP warning shown for this world');

    console.log('STEP 2: loading the item into this world');
    await clickCardMenuAction(frame.locator('#selfCollectiblesList [data-action="toggle-load"]'));
    await frame.waitForFunction(() => !!document.querySelector('#selfCollectiblesList [data-action="lose"]'), { timeout: 5000 });
    console.log('PASS: item loaded, "Simulate PvP loss" now available');
    await page.screenshot({ path: shot('lt-02-loaded-in-arena.png') });

    console.log('STEP 3: simulating a PvP loss (real ECDSA-signed transfer to the counterparty key)');
    await clickCardMenuAction(frame.locator('#selfCollectiblesList [data-action="lose"]'));
    await frame.waitForFunction(
      () => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 0 &&
            document.querySelectorAll('#counterpartyCollectiblesList .wallet-item').length > 0,
      { timeout: 15000 }
    );
    const selfItemsAfterLoss = await frame.locator('#selfCollectiblesList').textContent();
    const cpItemsAfterLoss = await frame.locator('#counterpartyCollectiblesList').textContent();
    if (selfItemsAfterLoss.includes('Bronze Compass')) throw new Error('Item should be gone from self wallet after loss');
    if (!cpItemsAfterLoss.includes('Bronze Compass')) throw new Error('Item should now be in counterparty wallet');
    console.log('PASS: item moved to counterparty — real owner-signed transfer, not a server reassignment');
    await page.screenshot({ path: shot('lt-03-item-transferred.png') });

    // ---------- §5.4 resources + split ----------

    console.log('STEP 4: back to Plaza, then into the Trading Post');
    await clickPortalTo(frame, 'plaza');
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await clickPortalTo(frame, 'market');
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Trading Post'), { timeout: 10000 });
    console.log('PASS: in the Trading Post');

    console.log('STEP 5: mining resources — 20 iron to self, 10 gold to counterparty');
    // Task #211 removed the wallet panel's own always-available mint
    // shortcuts (Inventory category's "Mine 20 iron (self)"/"Mine 10 gold
    // (counterparty)" buttons) — this now mints the exact same way those
    // handlers used to (AtlasWallet.mintAsset then refreshInventoryDisplay()),
    // still deliberately minting the gold to 'counterparty' (unchanged by
    // v1.15's market-stall fix, which only touched the market scene's own
    // "Mine Gold" interactable): this file, and test/manual-wallet-search.js,
    // both rely on this to seed the counterparty's own list with a distinct
    // fungible class.
    await frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.iron', 20); await refreshInventoryDisplay(); });
    await frame.waitForFunction(() => document.getElementById('selfCollectiblesList').textContent.includes('Iron (Fe) ×20 g'), { timeout: 15000 });
    await frame.evaluate(async () => { await AtlasWallet.mintAsset('counterparty', 'localhost:8001', 'atlas.element.gold', 10); await refreshInventoryDisplay(); });
    await frame.waitForFunction(() => document.getElementById('counterpartyCollectiblesList').textContent.includes('Gold (Au) ×10 g'), { timeout: 15000 });
    console.log('PASS: both real resource balances minted and verified');
    await page.screenshot({ path: shot('lt-04-resources-minted.png') });

    console.log('STEP 6: splitting — sending 10 of self\'s iron to the counterparty');
    await clickCardMenuAction(frame.locator('#selfCollectiblesList [data-action="split"]'));
    await frame.waitForFunction(
      () => document.getElementById('selfCollectiblesList').textContent.includes('Iron (Fe) ×10 g') &&
            document.getElementById('counterpartyCollectiblesList').textContent.includes('Iron (Fe) ×10 g'),
      { timeout: 15000 }
    );
    console.log('PASS: split settled — self kept the remainder, counterparty received a fresh balance, old one revoked');
    await page.screenshot({ path: shot('lt-05-split-settled.png') });

    console.log('\nALL LOADOUT + RESOURCE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
