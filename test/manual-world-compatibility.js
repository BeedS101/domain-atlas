// Manual check for #151: "only show items compatible with this world" in
// Wallet -> Inventory -> Yours, plus surfacing the same already-existing
// manifest data (policy.acceptedItemClasses/policy.trustedIssuers, plus
// chat/trading) in the two places a visitor sees BEFORE stepping into a
// world: content.js's Enter-Space hover tooltip, and viewer.js's in-scene
// portal hover tooltip.
//
// No new manifest field was needed for any of this — see task #151's own
// notes: SPEC.md line 334 already defines policy.acceptedItemClasses as
// "which classes a world recognizes", and line 172 defines
// policy.trustedIssuers (orthogonal to class) as whose issuers it trusts.
// isAssetCompatibleWithWorld() in viewer.js is the one place both fields
// get checked together; portalCapabilitySummary()/content.js's
// capabilitySummary() just render the same two fields (plus chat/trading)
// as text, no new logic of their own beyond that.
//
// Demo data used (see demo-domain-a/.well-known/spatial.json):
// - plaza: acceptedItemClasses ["atlas.wearable","atlas.badge","atlas.wearable.ring"],
//   trustedIssuers "any" — the Bronze Compass (atlas.wearable, via
//   #requestItemBtn) is compatible; mined iron (atlas.element.iron, via
//   AtlasWallet.mintAsset() — task #211 removed the dev-only mine buttons
//   this used to click, see STEP 0's setup below) is NOT (wrong class) —
//   exactly the two catalog items the existing #44/#150 tests already
//   mint, no new catalog entries needed.
// - museum: itemDropsAllowed false, acceptedItemClasses [] — portal
//   tooltip must NOT show an "accepts drops" bit for it.
// - market: profile.genre "trading-station" — portal tooltip must show
//   "trading".
// - localhost:8002 (Neighbor Workshop, cross-domain portal): chat: true,
//   itemDropsAllowed true with 2 classes — exercises the cross-domain
//   portal path (fetchDomainPortalWorld now threads the fetched manifest
//   through too, not just the resolved world, so chatEnabledForWorld has
//   what it needs).
// - manifest-level "chat": true on demo-domain-a covers every one of its
//   worlds via chatEnabledForWorld()'s domain-OR-world check, so every
//   plaza-side portal tooltip should show "chat" regardless of that
//   world's own per-world chat field.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts. Assumes issuer-server is already running on 8001
// and 8002 (see README §1).

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-world-compat');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: fresh identity in Example Plaza, Bronze Compass (compatible) + mined iron (not compatible)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });

    console.log('STEP 0: content.js Enter-Space tooltip shows chat + accepts drops (no trading — plaza is not a trading-station)');
    await page.locator('#domain-atlas-enter-btn').hover();
    await page.waitForFunction(() => document.getElementById('domain-atlas-info-tooltip').style.display === 'block', { timeout: 5000 });
    const enterTooltipText = await page.locator('#domain-atlas-info-tooltip').innerText();
    if (!enterTooltipText.includes('chat')) throw new Error('Expected "chat" in the Enter-Space tooltip (manifest.chat is true), got: ' + enterTooltipText);
    if (!enterTooltipText.includes('accepts drops: atlas.wearable, atlas.badge, atlas.wearable.ring')) throw new Error('Expected plaza\'s full accepted-classes list in the Enter-Space tooltip, got: ' + enterTooltipText);
    if (enterTooltipText.includes('trading')) throw new Error('Plaza is not a trading-station — "trading" should not appear, got: ' + enterTooltipText);
    console.log('PASS: Enter-Space tooltip shows chat + the full accepted-classes list, no trading');
    await page.locator('#domain-atlas-enter-btn').click();

    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('world-compat-test-pw');
    await frame.locator('#newPasswordConfirmInput').fill('world-compat-test-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    // Task #211 removed the dev-only "Mine 20 iron (self)" Settings button
    // — mints the same way its handler used to (AtlasWallet.mintAsset then
    // the same refreshInventoryDisplay() call).
    await frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.iron', 20); await refreshInventoryDisplay(); });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item, #selfCollectiblesList .resource-group-header').length >= 2, { timeout: 15000 });
    console.log('PASS: wallet holds both a Bronze Compass and mined iron');

    console.log('STEP 1: dataset.compatible is correct on both cards before any filtering');
    const compat = await frame.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      return cards.map((c) => ({ name: c.querySelector('.name').textContent, compatible: c.dataset.compatible }));
    });
    const compass = compat.find((c) => c.name.includes('Bronze Compass'));
    const iron = compat.find((c) => c.name.includes('Iron'));
    if (!compass || compass.compatible !== '1') throw new Error('Expected Bronze Compass dataset.compatible === "1", got: ' + JSON.stringify(compass));
    if (!iron || iron.compatible !== '0') throw new Error('Expected mined iron dataset.compatible === "0" (wrong class for plaza), got: ' + JSON.stringify(iron));
    console.log('PASS: compass compatible, iron not — matches plaza\'s acceptedItemClasses');

    console.log('STEP 2: checking "only show items compatible with this world" hides the iron card, keeps the compass');
    await frame.locator('#collectiblesCompatOnlyCheckbox').check();
    await frame.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const compass = cards.find((c) => c.querySelector('.name').textContent.includes('Bronze Compass'));
      const iron = cards.find((c) => c.querySelector('.name').textContent.includes('Iron'));
      return compass && !compass.hidden && iron && iron.hidden;
    }, { timeout: 3000 });
    console.log('PASS: incompatible iron hidden, compatible compass still shown');

    console.log('STEP 3: combining the checkbox with a search that matches only the (now-hidden) iron shows "no compatible" empty state');
    await frame.locator('#collectiblesSearchInput').fill('iron');
    await frame.waitForFunction(() => {
      const note = document.querySelector('#selfCollectiblesList .filter-empty-note');
      const compass = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item')).find((c) => c.querySelector('.name').textContent.includes('Bronze Compass'));
      return !!note && compass && compass.hidden;
    }, { timeout: 3000 });
    console.log('PASS: search + compatibility filter combine correctly (AND, not OR)');
    await frame.locator('#collectiblesSearchInput').fill('');

    console.log('STEP 4: unchecking the checkbox restores both cards');
    await frame.locator('#collectiblesCompatOnlyCheckbox').uncheck();
    await frame.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      return cards.every((c) => !c.hidden);
    }, { timeout: 3000 });
    console.log('PASS: unchecking restores the full list');

    console.log('STEP 5: portal tooltip on a same-domain world portal (Museum) shows chat but NOT accepts-drops (itemDropsAllowed is false there)');
    const museumHb = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        if (typeof portalHitboxes !== 'undefined' && portalHitboxes.length) {
          const hb = portalHitboxes.find((h) => h.marker.portal && h.marker.portal.to === 'museum');
          if (hb) return resolve({ sx: hb.sx, sy: hb.sy });
        }
        requestAnimationFrame(check);
      };
      check();
    }));
    await frame.locator('#scene').hover({ position: { x: museumHb.sx, y: museumHb.sy } });
    await frame.waitForFunction(() => document.getElementById('portalHoverTooltip').style.display === 'block', { timeout: 3000 });
    const museumTooltip = await frame.locator('#portalHoverTooltip').innerText();
    if (!museumTooltip.includes('chat')) throw new Error('Expected "chat" in the Museum portal tooltip (domain-wide manifest.chat), got: ' + museumTooltip);
    if (museumTooltip.includes('accepts drops')) throw new Error('Museum has itemDropsAllowed:false — should not show accepts drops, got: ' + museumTooltip);
    console.log('PASS: Museum tooltip shows chat, correctly omits accepts-drops');

    console.log('STEP 6: portal tooltip on the Trading Post (market, genre trading-station) shows "trading"');
    const marketHb = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        const hb = portalHitboxes.find((h) => h.marker.portal && h.marker.portal.to === 'market');
        if (hb) return resolve({ sx: hb.sx, sy: hb.sy });
        requestAnimationFrame(check);
      };
      check();
    }));
    await frame.locator('#scene').hover({ position: { x: 0, y: 0 } }); // move off first so the marker-equality re-hover check re-fires
    await frame.locator('#scene').hover({ position: { x: marketHb.sx, y: marketHb.sy } });
    await frame.waitForFunction(() => document.getElementById('portalHoverTooltip').innerText.includes('trading'), { timeout: 3000 });
    console.log('PASS: Trading Post portal tooltip shows "trading"');

    console.log('STEP 7: cross-domain portal tooltip (Neighbor Workshop) resolves the fetched manifest\'s own chat flag + accepted classes');
    const domainHb = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        const hb = portalHitboxes.find((h) => h.marker.portal && h.marker.portal.to === 'localhost:8002');
        if (hb) return resolve({ sx: hb.sx, sy: hb.sy });
        requestAnimationFrame(check);
      };
      check();
    }));
    await frame.locator('#scene').hover({ position: { x: 0, y: 0 } });
    await frame.locator('#scene').hover({ position: { x: domainHb.sx, y: domainHb.sy } });
    await frame.waitForFunction(() => {
      const text = document.getElementById('portalHoverTooltip').innerText;
      return text.includes('chat') && text.includes('accepts drops: atlas.wearable, atlas.badge');
    }, { timeout: 5000 });
    console.log('PASS: cross-domain portal tooltip correctly resolved localhost:8002\'s own manifest.chat + acceptedItemClasses');

    console.log('\nALL CHECKS PASSED — #151 compatibility checkbox + chat/trading/accepted-classes tooltip surfacing all working live.');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
