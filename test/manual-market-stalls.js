// Manual check for the Trading Post's clickable iron/gold/silver stalls,
// plus its fourth interactable: a "Join Trading Station" desk on the
// Trading Post sign itself that reuses the same "issue" action already
// used by the Plaza's wearable stalls (see #144 Phase 1's
// atlas.tradingstation.membership and the wallet-panel "Join Trading
// Station" button it already had) — so walking up and clicking the sign is
// now an alternative to opening the wallet's Trade tab -> Sell and using
// its Join button. Covers: clicking each of the iron/gold/silver stalls
// mints that resource for self (v1.15 fixed the gold stall, which used to
// mint to a "counterparty" identity by mistake, and added the silver
// stall — all three now behave identically, no counterparty needed for
// any of them), clicking the membership desk issues a real
// atlas.tradingstation.membership credential (with the same once-per-user
// dedupe every "issue" stall gets), and that having joined this way is
// correctly recognized by the wallet panel's own Join button (it hides
// itself rather than offering a redundant second join). Not part of the
// permanent suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

// Same established pattern as manual-drop-pickup.js's projectItemMarkers:
// project() and window.__atlasScene are bare top-level identifiers in
// viewer.js's classic <script>, reachable directly here.
async function projectInteractables(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        const scene = window.__atlasScene;
        // Wait specifically for the Trading Post's own interactables
        // (atlas.element.* stalls), not just any non-empty array — placeLabel
        // updates before window.__atlasScene is reassigned during a world
        // transition, so a naive "is it non-empty" check can resolve on the
        // previous world's still-present interactables (e.g. the Plaza's
        // Compass/Ring stalls) instead of waiting for the real ones here.
        if (scene && scene.interactables && scene.interactables.some((m) => m.class && m.class.startsWith('atlas.element.'))) {
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
  const userDataDir = path.resolve(__dirname, '.chrome-profile-market-stalls');
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

    console.log('SETUP: creating an identity and walking to the Trading Post');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('market-stall-password');
    await frame.locator('#newPasswordConfirmInput').fill('market-stall-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#walletBtn').click(); // close panel so canvas clicks land on the scene
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

    const plazaHb = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        if (portalHitboxes.length) {
          const marketHb = portalHitboxes.find((h) => h.marker.portal && h.marker.portal.to === 'market');
          if (marketHb) return resolve({ sx: marketHb.sx, sy: marketHb.sy });
        }
        requestAnimationFrame(check);
      };
      check();
    }));
    await frame.locator('#scene').click({ position: { x: plazaHb.sx, y: plazaHb.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Trading Post'), { timeout: 10000 });
    console.log('PASS: reached the Trading Post');

    console.log('STEP 1: clicking the iron stall mints 20 iron for self, no counterparty needed');
    const [ironStall, goldStall, silverStall, membershipDesk] = await projectInteractables(frame);
    if (!ironStall || ironStall.class !== 'atlas.element.iron') throw new Error('Expected the first interactable to be the iron stall, got: ' + JSON.stringify(ironStall));
    await frame.locator('#scene').click({ position: { x: ironStall.sx, y: ironStall.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Collected'), { timeout: 10000 });
    const statusAfterIron = await frame.locator('#status').textContent();
    if (!statusAfterIron.includes('atlas.element.iron')) throw new Error('Expected the status line to mention iron: ' + statusAfterIron);
    // Confirm it actually landed in the wallet, not just a status message.
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 5000 });
    const ironCardText = await frame.locator('#selfCollectiblesList .wallet-item').first().textContent();
    if (!ironCardText.includes('atlas.element.iron')) throw new Error('Expected iron in the self resource list: ' + ironCardText);
    console.log('PASS: clicking the iron stall actually minted iron into the wallet ->', statusAfterIron);
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

    console.log('STEP 2: clicking the gold stall mints 10 gold for self — v1.15 fixed this stall, which used to require a counterparty');
    if (!goldStall || goldStall.class !== 'atlas.element.gold') throw new Error('Expected the second interactable to be the gold stall, got: ' + JSON.stringify(goldStall));
    // Status still reads STEP 1's "Collected ... iron." here — startsWith
    // ('Collected') alone would resolve instantly against that stale text
    // (same race the membership-desk step below already guards against),
    // so wait for it to actually change first.
    const statusBeforeGold = await frame.locator('#status').textContent();
    await frame.locator('#scene').click({ position: { x: goldStall.sx, y: goldStall.sy } });
    await frame.waitForFunction((prev) => {
      const t = document.getElementById('status').textContent;
      return t !== prev && t.startsWith('Collected');
    }, statusBeforeGold, { timeout: 10000 });
    const statusAfterGold = await frame.locator('#status').textContent();
    if (!statusAfterGold.includes('atlas.element.gold')) throw new Error('Expected the status line to mention gold: ' + statusAfterGold);
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 2, { timeout: 5000 });
    console.log('PASS: gold stall minted gold for self, with no counterparty in play at all ->', statusAfterGold);
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

    console.log('STEP 3: clicking the new silver stall mints 15 silver for self');
    if (!silverStall || silverStall.class !== 'atlas.element.silver') throw new Error('Expected the third interactable to be the silver stall, got: ' + JSON.stringify(silverStall));
    const statusBeforeSilver = await frame.locator('#status').textContent();
    await frame.locator('#scene').click({ position: { x: silverStall.sx, y: silverStall.sy } });
    await frame.waitForFunction((prev) => {
      const t = document.getElementById('status').textContent;
      return t !== prev && t.startsWith('Collected');
    }, statusBeforeSilver, { timeout: 10000 });
    const statusAfterSilver = await frame.locator('#status').textContent();
    if (!statusAfterSilver.includes('atlas.element.silver')) throw new Error('Expected the status line to mention silver: ' + statusAfterSilver);
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 3, { timeout: 5000 });
    console.log('PASS: silver stall minted silver for self ->', statusAfterSilver);
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });

    console.log('STEP 4: clicking the "Join Trading Station" desk on the Trading Post sign issues a real membership credential');
    if (!membershipDesk || membershipDesk.class !== 'atlas.tradingstation.membership') throw new Error('Expected the fourth interactable to be the membership desk, got: ' + JSON.stringify(membershipDesk));
    // Status already reads "Collected 15 × atlas.element.silver." from
    // STEP 3 — startsWith('Collected') alone would resolve instantly
    // against that stale text, so wait for it to actually change first.
    const statusBeforeMembership = await frame.locator('#status').textContent();
    await frame.locator('#scene').click({ position: { x: membershipDesk.sx, y: membershipDesk.sy } });
    await frame.waitForFunction((prev) => {
      const t = document.getElementById('status').textContent;
      return t !== prev && t.startsWith('Collected');
    }, statusBeforeMembership, { timeout: 10000 });
    const statusAfterMembership = await frame.locator('#status').textContent();
    if (!statusAfterMembership.includes('Join Trading Station')) throw new Error('Expected the status line to name the desk\'s label: ' + statusAfterMembership);
    const hasMembership = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.some((e) => e.credential.asset.class === 'atlas.tradingstation.membership');
    });
    if (!hasMembership) throw new Error('Expected a real atlas.tradingstation.membership credential in the wallet after clicking the desk');
    console.log('PASS: membership desk issued a real credential ->', statusAfterMembership);

    console.log('STEP 5: clicking the desk again is a no-op (once-per-user dedupe), same as every other "issue" stall');
    await frame.locator('#scene').click({ position: { x: membershipDesk.sx, y: membershipDesk.sy } });
    await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Already collected'), { timeout: 10000 });
    console.log('PASS: second click was rejected client-side ->', await frame.locator('#status').textContent());

    console.log('STEP 6: the wallet panel\'s own "Join Trading Station" button recognizes the desk-issued membership and does not offer a redundant second join');
    // v1.14 replaced the single Remote sub-tab with Buy/Sell/Listings — the
    // shared #tradingStationJoinSection (see viewer.html) now lives above
    // all three rather than inside one Remote screen, so Sell (which is
    // where a real join actually gets used, to post a listing) stands in
    // for what used to be the one and only Remote sub-tab here.
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#tradeTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('tradeScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#tradingSellSubtabBtn').click();
    await frame.waitForFunction(() => document.getElementById('tradingSellSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.waitForFunction(() => document.getElementById('tradingStationJoinSection').hidden, { timeout: 5000 });
    console.log('PASS: Join Trading Station section stayed hidden for self — the two join paths agree with each other');

    console.log('\nALL MARKET STALL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
