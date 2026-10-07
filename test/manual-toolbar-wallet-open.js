// Manual check: the toolbar button opens the wallet as a real Chrome side
// panel (manifest.json's side_panel.default_path -> viewer.html), docked
// beside the page instead of drawn over it, on a page that declares no
// spatial manifest at all.
//
// This used to test a content-script-injected overlay iframe for the same
// "no manifest" case — replaced because an overlay is paint order, not
// layout: it can only ever draw IN FRONT of the page, never avoid covering
// it, no matter how it's sized or positioned. A real side panel is a
// genuinely different Chrome browsing context that content.js has no part
// in at all, so there's nothing left for content.js to do for this case —
// background.js's whole job now is chrome.sidePanel.setPanelBehavior().
//
// Two real Playwright limits shape what this can actually exercise:
//   1. Playwright can't click the real toolbar icon (it lives outside any
//      page's accessibility tree) — same limit the old overlay-based
//      version of this test already worked around differently.
//   2. chrome.sidePanel.open() throws "may only be called in response to
//      a user gesture" when called from a service worker's own script
//      (confirmed live, not assumed) — so even the extension's own
//      background script can't fake the open the way background.evaluate()
//      could fake a message send for the old overlay.
// So this test verifies the two things that together make the real,
// icon-clicked side panel work correctly: (a) background.js actually
// registered the click-opens-panel behavior with Chrome, and (b) viewer.js's
// own "no manifest" branch — which is exactly what loading viewer.html with
// no query params boots into, regardless of what surface it's shown in —
// behaves correctly. (a) is unit-testable directly; (b) is tested by
// loading viewer.html as a plain page, since its own JS has no idea
// whether it's inside a side panel or an ordinary tab and behaves
// identically either way.
//
// STEP 3 covers the Asset Viewer hover panel (task #150), which also has
// to stay disabled here: positionAssetViewer() assumes room beside the
// hovered card that a narrow panel doesn't have. Needs a live issuer-server
// to mint a real asset to hover, so this spins up its own throwaway
// instance (isolated docroot copy + isolated state dir), same pattern
// manual-3d-key-anchored-portal.js and its siblings use.
//
// STEP 1b/3b cover the toolbar icon itself swapping between the grey
// "locked" set and the colored "active" set as the wallet's own identity
// state changes, driven by background.js's chrome.storage.onChanged
// listener rather than anything content.js or this test pokes directly.
//
// STEP 4 covers a live bug report against the side panel itself: entering
// a real spatial world still let the toolbar button pop the side panel
// open on top of it, since openPanelOnActionClick is a global behavior
// with no idea a tab's full-tab world overlay exists. content.js/
// background.js now disable (and close, if already open) the side panel
// for exactly that tab for exactly that long — this drives a real
// Enter-Space click against the same isolated docroot STEP 3 already set
// up, and checks chrome.sidePanel.getOptions({tabId}) directly rather than
// trying to click the real toolbar icon (which Playwright still can't do).

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8201; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-toolbar-wallet-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-toolbar-wallet-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-toolbar-wallet-profile-'));

(async () => {
  console.log('SETUP: copying demo-domain-a into an isolated docroot for a throwaway issuer-server (only STEP 3 needs it)');
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });

  console.log('SETUP: starting a throwaway issuer-server instance on port ' + PORT + ' (isolated docroot, isolated state dir)');
  const serverProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + PORT);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;

    console.log('STEP 1: background.js registered the toolbar icon to open the side panel on click');
    const behavior = await background.evaluate(() => chrome.sidePanel.getPanelBehavior());
    if (!behavior || behavior.openPanelOnActionClick !== true) throw new Error('Expected openPanelOnActionClick: true, got: ' + JSON.stringify(behavior));
    console.log('PASS: chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }) took effect');

    console.log('STEP 1b: toolbar icon starts on the locked/grey set with no identity yet');
    // chrome.action has no getIcon() to read the live icon back, so this
    // records what setIcon() is actually called with instead of trusting
    // the call happened at all.
    await background.evaluate(() => {
      self.__iconCalls = [];
      const orig = chrome.action.setIcon.bind(chrome.action);
      chrome.action.setIcon = (opts) => { self.__iconCalls.push(opts.path); return orig(opts); };
      return refreshToolbarIcon();
    });
    const lockedPath = await background.evaluate(() => self.__iconCalls.at(-1));
    if (!lockedPath || !lockedPath[16].includes('icon-locked-16')) throw new Error('Expected the locked icon set with no identity yet, got: ' + JSON.stringify(lockedPath));
    console.log('PASS: locked/grey icon set before any identity exists');

    console.log('STEP 2: viewer.html with no manifest query param (exactly what the side panel shows) boots into standalone mode');
    const page = await context.newPage();
    await page.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 10000 });
    const placeLabelText = await page.locator('#placeLabel').innerText();
    if (!placeLabelText.includes('Wallet')) throw new Error('Expected placeLabel to say something Wallet-related in standalone mode, got: ' + placeLabelText);
    console.log('PASS: wallet panel open immediately, placeLabel reflects standalone mode, not stuck on "Loading space…"');

    console.log('STEP 2b: in-world-only UI that would otherwise show through with nothing behind it stays hidden — #scene, #walletBtn, #closeBtn (meaningless here, see viewer.js\'s own comment), #chatWidget, #hint');
    for (const selector of ['#scene', '#walletBtn', '#closeBtn', '#chatWidget', '#hint']) {
      const display = await page.locator(selector).evaluate((el) => getComputedStyle(el).display);
      if (display !== 'none') throw new Error('Expected ' + selector + ' hidden in standalone mode, got display: ' + display);
    }
    console.log('PASS: no blank canvas, world-only toggle, dead close button, orphaned chat widget, or portal-color hint showing through');

    console.log('STEP 3: a real asset card\'s hover panel stays disabled in standalone mode (task #150)');
    await page.locator('#chooseNewBtn').click();
    await page.locator('#newPasswordInput').fill('toolbar-wallet-test-pw');
    await page.locator('#newPasswordConfirmInput').fill('toolbar-wallet-test-pw');
    await page.locator('#confirmCreateBtn').click();
    await page.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await page.locator('#seedConfirmCheck').check();
    await page.locator('#seedConfirmBtn').click();
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await page.evaluate(async (domain) => {
      await AtlasWallet.mintAsset('self', domain, 'atlas.element.iron', 20);
      await refreshInventoryDisplay();
    }, DOMAIN);
    await page.waitForSelector('#selfCollectiblesList .wallet-item', { timeout: 15000 });
    console.log('PASS: a real asset card is showing in the standalone wallet');

    console.log('STEP 3b: creating that identity flipped the toolbar icon to the active/colored set on its own, via the chrome.storage.onChanged listener (no explicit call from this test)');
    // background is a service worker, not a page/frame — no waitForFunction,
    // so poll it directly for the onChanged listener's own setIcon() call.
    let iconCallCount = 0;
    for (let i = 0; i < 25 && iconCallCount <= 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      iconCallCount = await background.evaluate(() => self.__iconCalls.length);
    }
    if (iconCallCount <= 1) throw new Error('Expected a second setIcon() call once an identity was created, got ' + iconCallCount + ' call(s) total');
    const activePath = await background.evaluate(() => self.__iconCalls.at(-1));
    if (!activePath || !activePath[16].includes('/icon-16') || activePath[16].includes('locked')) throw new Error('Expected the active icon set once an identity exists, got: ' + JSON.stringify(activePath));
    console.log('PASS: active/colored icon set automatically once createIdentity() unlocked a real identity');

    await page.locator('#selfCollectiblesList .wallet-item').first().hover();
    await page.waitForTimeout(300); // give a (wrongly) opening panel a moment to appear if it were going to
    const widgetHidden = await page.locator('#assetViewerWidget').evaluate((el) => el.hidden);
    if (!widgetHidden) throw new Error('Expected #assetViewerWidget to stay hidden on hover in standalone mode (no room to show it beside a card this narrow)');
    console.log('PASS: hovering the asset card did not open the Asset Viewer panel in standalone mode');

    console.log('STEP 4: entering a real spatial world (full-tab overlay) disables the side panel for that tab, live bug report — "its working but its doing it in the spatial worlds too"');
    const worldPage = await context.newPage();
    await worldPage.goto('http://' + DOMAIN + '/', { waitUntil: 'load' });
    await worldPage.locator('#domain-atlas-enter-btn').click();
    const worldFrameHandle = await worldPage.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const worldFrame = await worldFrameHandle.contentFrame();
    await worldFrame.waitForFunction(() => !document.getElementById('placeLabel').textContent.includes('Loading'), { timeout: 10000 });
    const worldTabId = await background.evaluate(async (domain) => {
      const tabs = await chrome.tabs.query({ url: 'http://' + domain + '/*' });
      return tabs[0] && tabs[0].id;
    }, DOMAIN);
    if (typeof worldTabId !== 'number') throw new Error('Expected to find the world tab via chrome.tabs.query');
    const optionsInWorld = await background.evaluate((tabId) => chrome.sidePanel.getOptions({ tabId }), worldTabId);
    if (optionsInWorld.enabled !== false) throw new Error('Expected the side panel disabled for a tab with a real world entered, got: ' + JSON.stringify(optionsInWorld));
    console.log('PASS: side panel disabled for the tab while a real spatial world is open in it');

    await worldFrame.locator('#closeBtn').click();
    await worldPage.waitForSelector('#domain-atlas-overlay', { state: 'detached', timeout: 10000 });
    const optionsAfterClose = await background.evaluate((tabId) => chrome.sidePanel.getOptions({ tabId }), worldTabId);
    if (optionsAfterClose.enabled !== true) throw new Error('Expected the side panel re-enabled for the tab after leaving the world, got: ' + JSON.stringify(optionsAfterClose));
    console.log('PASS: side panel re-enabled for the tab once the world overlay closes');

    console.log('STEP 5: reloading or leaving the page while a world is open must not leave the side panel disabled');
    await worldPage.locator('#domain-atlas-enter-btn').click();
    await worldPage.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    await worldPage.waitForFunction(() => !!document.getElementById('domain-atlas-overlay'), undefined, { timeout: 5000 });
    const optionsInWorldAgain = await background.evaluate((tabId) => chrome.sidePanel.getOptions({ tabId }), worldTabId);
    if (optionsInWorldAgain.enabled !== false) throw new Error('Expected the side panel disabled again while the world is open, got: ' + JSON.stringify(optionsInWorldAgain));
    await worldPage.reload({ waitUntil: 'load' });
    await worldPage.waitForFunction(() => !document.getElementById('domain-atlas-overlay'), undefined, { timeout: 5000 });
    let optionsAfterReload = null;
    for (let i = 0; i < 40; i++) {
      optionsAfterReload = await background.evaluate((tabId) => chrome.sidePanel.getOptions({ tabId }), worldTabId);
      if (optionsAfterReload.enabled === true) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (optionsAfterReload.enabled !== true) throw new Error('Expected the side panel re-enabled after a reload that destroyed the world overlay, got: ' + JSON.stringify(optionsAfterReload));
    console.log('PASS: side panel re-enabled after a reload mid-world');

    console.log('\nALL CHECKS PASSED — the toolbar button is wired to open a real Chrome side panel, viewer.js\'s standalone-mode boot (what that panel actually shows) hides every piece of in-world-only UI and keeps the Asset Viewer hover panel disabled, and the panel stays out of the way while a real spatial world is open in a tab.');
  } finally {
    await context.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
