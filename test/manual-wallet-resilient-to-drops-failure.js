// Regression check for a real bug Bruno hit right after World Drops
// (task #250, SPEC.md §5.5) shipped: refreshInventoryDisplay() called
// AtlasWallet.getWorldDrops() directly and unguarded, near the very top of
// the function, well before it ever got to rendering the owner's own
// Collectibles/Documents lists. Any failure fetching "what's dropped in
// this world" — the world's server not yet running the new endpoints, a
// network hiccup, a cross-domain world whose host is briefly unreachable —
// threw an uncaught error there and aborted the WHOLE function, so the
// wallet panel showed no assets at all, even ones that had nothing to do
// with drops. Fixed by routing every AtlasWallet.getWorldDrops() call
// through a new getWorldDropsSafely() wrapper in viewer.js that swallows
// the failure and degrades to "no dropped-items list" instead of "no
// wallet".
//
// Spins up its own throwaway issuer-server instance on port 8001 (an
// isolated state dir, so it starts with a clean ledger — but the SAME
// port and domain manual-drop-pickup.js's already-running domain A uses)
// using the real demo-domain-a docroot so the actual Example Plaza
// overlay/scene loads normally. Port 8001 specifically because
// demo-domain-a/.well-known/spatial.json hardcodes "domain":
// "localhost:8001" — the client reads that field to know where to send
// asset-issue/drop/etc requests, so any OTHER port here would leave the
// overlay trying to reach a domain nothing is actually listening on. Only
// safe to run standalone (not concurrently with anything else already
// bound to 8001), same as any other manual-*.js script that talks to
// domain A.
//
// Checks:
//   1. Baseline: a fresh identity requests an item (Bronze Compass) and it
//      shows up in the wallet's Collectibles list.
//   2. AtlasWallet.getWorldDrops is monkey-patched in-page to always throw
//      (standing in for an unreachable/outdated world-drops endpoint), and
//      refreshInventoryDisplay() is called again directly: the Bronze
//      Compass must STILL be visible in Collectibles — the drops-fetch
//      failure must not blank the wallet.
//   3. The "Dropped in this world" section is simply absent/empty in that
//      degraded state (not required to invent stale contents), rather than
//      throwing or leaving the panel in some broken half-rendered state.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8001; // must match demo-domain-a/.well-known/spatial.json's hardcoded "domain" — see file header
const DOMAIN = 'localhost:' + PORT;
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-wallet-resilience-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-wallet-resilience-profile-'));

(async () => {
  console.log('SETUP: starting a throwaway issuer-server instance on port ' + PORT + ' (real demo-domain-a docroot, isolated state dir)');
  const serverProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + PORT);

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      executablePath: '/opt/pw-browsers/chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
    });
    const page = await context.newPage();
    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    console.log('SETUP: overlay opened at Example Plaza');

    console.log('STEP 1: create an identity and request an item; it should appear in Collectibles');
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('resilience-test-pw');
    await frame.locator('#newPasswordConfirmInput').fill('resilience-test-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(
      () => document.querySelector('#selfCollectiblesList')?.textContent.includes('Bronze Compass'),
      { timeout: 5000 }
    );
    console.log('PASS: Bronze Compass shows up in Collectibles normally');

    console.log('STEP 2: monkey-patch AtlasWallet.getWorldDrops to always throw (stands in for an unreachable/outdated drops endpoint), then re-run refreshInventoryDisplay()');
    await frame.evaluate(() => {
      AtlasWallet.getWorldDrops = () => { throw new Error('simulated: this world\'s drops endpoint is unreachable'); };
    });
    await frame.evaluate(() => refreshInventoryDisplay());

    const collectiblesTextAfter = await frame.locator('#selfCollectiblesList').textContent();
    if (!collectiblesTextAfter.includes('Bronze Compass')) {
      throw new Error('Expected the Bronze Compass to still be visible in Collectibles after a getWorldDrops() failure, got: ' + collectiblesTextAfter);
    }
    console.log('PASS: Collectibles still shows the Bronze Compass despite the simulated drops-fetch failure');

    console.log('STEP 3: the "Dropped in this world" section degrades to empty/hidden rather than breaking anything else');
    const droppedSectionHidden = await frame.evaluate(() => document.getElementById('droppedItemsSection').hidden);
    if (!droppedSectionHidden) throw new Error('Expected the "Dropped in this world" section to be hidden when its own data source is unreachable');
    console.log('PASS: "Dropped in this world" section is simply empty, nothing else broke');

    console.log('\nALL WALLET-RESILIENT-TO-DROPS-FAILURE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
