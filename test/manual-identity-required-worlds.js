// Manual check for #63: a world can declare policy.identityRequired: true
// (SPEC.md §3, already sitting inert on Arena/Market in demo-domain-a's own
// spatial.json since early on) and, until now, nothing anywhere read or
// enforced it — enterWorld() loaded any world regardless of wallet state.
//
// Design, exactly as scoped across the conversation that led here:
//   - effectiveIdentityRequired(manifest, world) follows the same two-tier
//     shape as effectiveAcceptedItemClasses (SPEC.md §3.4.1): a world's own
//     policy.identityRequired wins outright when present, the manifest's
//     top-level identityRequired is only a fallback for a world that omits
//     the field entirely.
//   - Every way to reach a world funnels through one gate before anything
//     about "where you are" changes: a same-domain portal (followPortal),
//     a cross-domain portal / Favorites / Recent Worlds (all go through
//     loadManifest). If the destination requires an identity the wallet
//     doesn't have, the wallet panel opens (onboarding if none exists yet,
//     unlock if one exists but is locked) and navigation waits — completing
//     it auto-resumes into the destination with no second click; closing
//     the panel without completing it leaves the visitor exactly where they
//     were, nothing half-entered.
//   - Mid-visit lock is entry-time-only: locking while already standing in
//     a gated world does NOT evict you (see the resolved design — matches
//     how every other policy field here works, and how locking behaves
//     everywhere else already). Instead, any IN-WORLD action that needs an
//     identity (an "issue"/"mint" stall, the Trade button) uses the exact
//     same open-wallet-and-wait-then-resume pattern the entry gate uses,
//     scoped only to worlds that actually require identity — an ordinary
//     world's actions are untouched.
//
// Requires domain A's issuer-server on 8001 (see README §1) — nothing here
// needs 8002 or presence-server. Not part of the permanent suite, same
// reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

async function projectPortals(frame) {
  return frame.evaluate(() => new Promise((resolve) => {
    const check = () => {
      if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
        const canvas = document.getElementById('scene');
        const originX = canvas.width / 2;
        const originY = canvas.height / 2 + 40;
        const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
        resolve(window.__atlasScene.portalMarkers.map((m) => {
          const [x, , z] = m.position;
          return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, kind: m.portal && m.portal.kind, to: m.portal && m.portal.to };
        }));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  }));
}

async function projectInteractables(frame) {
  return frame.evaluate(() => new Promise((resolve) => {
    const check = () => {
      const scene = window.__atlasScene;
      if (scene && scene.interactables && scene.interactables.length) {
        const canvas = document.getElementById('scene');
        const originX = canvas.width / 2;
        const originY = canvas.height / 2 + 40;
        resolve(scene.interactables.map((m) => {
          const [x, y, z] = m.position;
          const p = project(x, y || 0, z, originX, originY);
          return { sx: p.x, sy: p.y - 16, label: m.label, class: m.class, action: m.action };
        }));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  }));
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-identity-required-worlds');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    console.log('SETUP: fresh profile, no identity created yet, landed in Example Plaza (identityRequired: false) with no prompt');
    const walletOpen = await frame.evaluate(() => document.getElementById('walletPanel').classList.contains('open'));
    if (walletOpen) throw new Error('Expected no wallet prompt entering a world that does not require identity');

    console.log('STEP 1: effectiveIdentityRequired — two-tier composition (SPEC.md §3.4.1), synthetic objects');
    const composition = await frame.evaluate(() => ({
      perWorldTrueWins: effectiveIdentityRequired({ identityRequired: false }, { policy: { identityRequired: true } }),
      perWorldFalseWinsOverDomainTrue: effectiveIdentityRequired({ identityRequired: true }, { policy: { identityRequired: false } }),
      domainDefaultFillsInWhenWorldOmitsIt: effectiveIdentityRequired({ identityRequired: true }, { policy: {} }),
      absentEverywhereDefaultsFalse: effectiveIdentityRequired({}, { policy: {} })
    }));
    if (!composition.perWorldTrueWins) throw new Error('Expected a world\'s own identityRequired:true to win over a domain-level false');
    if (composition.perWorldFalseWinsOverDomainTrue) throw new Error('Expected a world\'s own identityRequired:false to win over a domain-level true');
    if (!composition.domainDefaultFillsInWhenWorldOmitsIt) throw new Error('Expected the domain-level default to fill in when the world omits the field entirely');
    if (composition.absentEverywhereDefaultsFalse) throw new Error('Expected identityRequired to default to false when declared nowhere');
    console.log('PASS: world\'s own value always wins when present; domain default only fills in when absent; false by default');

    console.log('STEP 2: clicking the portal into Arena (identityRequired: true) does NOT navigate yet — opens the wallet to onboarding instead (no identity exists at all)');
    let portals = await projectPortals(frame);
    const toArena = portals.find((p) => p.to === 'arena');
    if (!toArena) throw new Error('Expected a portal to Arena from the Plaza');
    await frame.locator('#scene').click({ position: { x: toArena.sx, y: toArena.sy } });
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    const stillPlazaAfterClick = await frame.locator('#placeLabel').textContent();
    if (!stillPlazaAfterClick.includes('Example Plaza')) throw new Error('Expected to still be in the Plaza while the wallet is being sorted out, got: ' + stillPlazaAfterClick);
    console.log('PASS: navigation paused, wallet opened straight to onboarding, still standing in the Plaza');

    console.log('STEP 3: closing the wallet WITHOUT creating an identity leaves the visitor exactly where they were — no half-entered state');
    await frame.locator('#walletBtn').click(); // toggles closed
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    const stillPlazaAfterCancel = await frame.locator('#placeLabel').textContent();
    if (!stillPlazaAfterCancel.includes('Example Plaza')) throw new Error('Expected to still be in the Plaza after cancelling, got: ' + stillPlazaAfterCancel);
    console.log('PASS: cancelled cleanly, still in the Plaza, nothing half-configured');

    console.log('STEP 4: clicking the Arena portal again, this time completing onboarding, auto-resumes straight into Arena — no second click on the portal');
    portals = await projectPortals(frame);
    const toArenaAgain = portals.find((p) => p.to === 'arena');
    await frame.locator('#scene').click({ position: { x: toArenaAgain.sx, y: toArenaAgain.sy } });
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('identity-required-test-pw');
    await frame.locator('#newPasswordConfirmInput').fill('identity-required-test-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Arena'), { timeout: 10000 });
    const walletClosedAfterResume = await frame.evaluate(() => !document.getElementById('walletPanel').classList.contains('open'));
    if (!walletClosedAfterResume) throw new Error('Expected the wallet panel to close itself once entry actually resumed');
    console.log('PASS: identity created -> auto-resumed straight into Arena, wallet closed itself, no second click on the portal');

    console.log('STEP 5: locking the wallet WHILE STANDING in Arena does NOT evict the visitor (entry-time-only enforcement, resolved design)');
    await frame.locator('#quickLockWalletBtn').click();
    await frame.waitForFunction(() => document.getElementById('quickLockWalletBtn').style.display === 'none', { timeout: 5000 });
    const stillArenaAfterLock = await frame.locator('#placeLabel').textContent();
    if (!stillArenaAfterLock.includes('Example Arena')) throw new Error('Expected locking mid-visit to leave the visitor standing in Arena, got: ' + stillArenaAfterLock);
    console.log('PASS: still in Arena after locking — no eviction, matching the resolved design');

    console.log('STEP 6: back to the Plaza (identityRequired: false) works immediately even while locked — the gate only ever checks the DESTINATION');
    portals = await projectPortals(frame);
    const backToPlaza = portals.find((p) => p.to === 'plaza');
    await frame.locator('#scene').click({ position: { x: backToPlaza.sx, y: backToPlaza.sy } });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    const walletStillClosed = await frame.evaluate(() => !document.getElementById('walletPanel').classList.contains('open'));
    if (!walletStillClosed) throw new Error('Expected no wallet prompt entering a non-gated world even while locked');
    console.log('PASS: entered the Plaza instantly while locked — an ungated destination never triggers the gate at all');

    console.log('STEP 7: from the Plaza, clicking into Market (identityRequired: true) while LOCKED opens the wallet to the UNLOCK screen this time (identity exists, just locked) — same pause/resume flow');
    // Guards against a real race: placeLabel updates early in enterWorld(),
    // before the new scene has actually finished loading and replaced
    // window.__atlasScene's contents — projectPortals()'s own wait only
    // checks .length truthy, which Arena's leftover single-portal scene
    // object can still satisfy for a moment after "Example Plaza" already
    // shows. Plaza's own scene.json declares exactly 5 portalMarkers, so
    // waiting for that exact count is a cheap, specific way to know the
    // NEW scene has actually landed before trusting its portal data.
    await frame.waitForFunction(() => window.__atlasScene && window.__atlasScene.portalMarkers.length === 5, { timeout: 10000 });
    portals = await projectPortals(frame);
    const toMarket = portals.find((p) => p.to === 'market');
    if (!toMarket) throw new Error('Expected a portal to Market from the Plaza');
    await frame.locator('#scene').click({ position: { x: toMarket.sx, y: toMarket.sy } });
    await frame.waitForFunction(() => document.getElementById('unlockScreen').classList.contains('active'), { timeout: 5000 });
    const stillPlazaBeforeUnlock = await frame.locator('#placeLabel').textContent();
    if (!stillPlazaBeforeUnlock.includes('Example Plaza')) throw new Error('Expected to still be in the Plaza while unlocking, got: ' + stillPlazaBeforeUnlock);
    await frame.locator('#unlockPasswordInput').fill('identity-required-test-pw');
    await frame.locator('#unlockBtn').click();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Market') || document.getElementById('placeLabel').textContent.includes('Example Trading Post'), { timeout: 10000 });
    console.log('PASS: unlocked -> auto-resumed straight into Market, no second click on the portal');

    console.log('STEP 8: an IN-WORLD action that needs identity (the "Mine Iron" stall) opens the wallet and waits when locked, then completes automatically once unlocked — scoped to this identity-required world only');
    await frame.locator('#quickLockWalletBtn').click();
    await frame.waitForFunction(() => document.getElementById('quickLockWalletBtn').style.display === 'none', { timeout: 5000 });
    const stillMarketAfterLock = await frame.locator('#placeLabel').textContent();
    if (!(stillMarketAfterLock.includes('Example Market') || stillMarketAfterLock.includes('Example Trading Post'))) throw new Error('Expected locking mid-visit in Market to leave the visitor standing there too, got: ' + stillMarketAfterLock);
    const interactables = await projectInteractables(frame);
    const ironStall = interactables.find((m) => m.label === 'Mine Iron');
    if (!ironStall) throw new Error('Expected a "Mine Iron" interactable in the Market scene');
    await frame.locator('#scene').click({ position: { x: ironStall.sx, y: ironStall.sy } });
    await frame.waitForFunction(() => document.getElementById('unlockScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: clicking the stall while locked opened the wallet to Unlock, instead of just failing the mint with an error');
    await frame.locator('#unlockPasswordInput').fill('identity-required-test-pw');
    await frame.locator('#unlockBtn').click();
    await frame.waitForFunction(() => document.getElementById('status').textContent.includes('Collected') && document.getElementById('status').textContent.includes('iron'), { timeout: 10000 });
    const walletClosedAfterActionResume = await frame.evaluate(() => !document.getElementById('walletPanel').classList.contains('open'));
    if (!walletClosedAfterActionResume) throw new Error('Expected the wallet panel to close itself once the in-world action actually resumed');
    console.log('PASS: unlocking auto-completed the mint with no second click on the stall, and the wallet closed itself ->', await frame.locator('#status').textContent());

    console.log('\nALL IDENTITY-REQUIRED-WORLD CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
