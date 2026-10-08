// Manual check: SPEC.md §3.8's read-only wallet bridge — an ordinary page's
// own script (window.atlasWallet.getIdentity(), via page-bridge.js's
// MAIN-world injection) asking the wallet whether an identity is active and
// what its public key is, gated by that page's own manifest-declared
// policy.walletBridge.read, composed exactly like every other §3.4.1 field
// (world's own value wins outright when present, domain-level default fills
// in only when the world omits it, hard default "false" when neither says
// anything).
//
// This also exercises the one change content.js needed to make `entry`
// optional (§3.8): a world with no entry.scene must never be offered as the
// Enter-Space button's target, but a manifest mixing enterable and
// entry-less worlds together must still find and offer the enterable one —
// STEP 1/7 below is the regression check for that filtering.
//
// Isolated throwaway docroot + issuer-server instance, same pattern as
// manual-toolbar-wallet-open.js and its siblings — this one hand-authors its
// own .well-known/spatial.json and three plain HTML pages rather than
// copying demo-domain-a, since the whole point here is a manifest shape
// (entry-less, policy-only worlds; an explicit false override against a
// true domain default) demo-domain-a's own manifest doesn't declare.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8202; // isolated — distinct from every other manual-*.js test's own port
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-page-bridge-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-page-bridge-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-page-bridge-profile-'));

const SPATIAL_JSON = {
  spec: 'domain-atlas/1.0',
  domain: DOMAIN,
  owner: { name: 'Bridge Test Domain', contact: 'demo@localhost' },
  // Domain-level default — deliberately true, so bridge-deny's own false
  // below is a real override proving a world's own value wins outright,
  // not just "nothing to inherit."
  walletBridge: { read: true },
  defaultWorld: 'lobby',
  worlds: [
    {
      id: 'lobby',
      name: 'Bridge Test Lobby',
      entry: { scene: '/spatial/lobby/scene.json', renderer: ['procedural-v1'] },
      policy: {
        guestAccess: 'open', discoverable: true, identityRequired: false,
        itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any'
      }
    },
    // SPEC.md §3.8 — no `entry` at all: carries a policy only, never
    // offered as something to walk into.
    { id: 'bridge-allow', name: 'Bridge Allow', policy: { walletBridge: { read: true } } },
    { id: 'bridge-deny', name: 'Bridge Deny', policy: { walletBridge: { read: false } } }
  ],
  updated: '2026-10-02T00:00:00Z'
};

const LOBBY_SCENE = {
  format: 'procedural-v1',
  floor: { size: [10, 10], color: '#1b2830' },
  objects: [],
  portalMarkers: [],
  anchors: []
};

function pageHtml(title, linkTag) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
    (linkTag ? linkTag + '\n' : '') +
    '</head><body><h1>' + title + '</h1></body></html>';
}

(async () => {
  console.log('SETUP: hand-authoring an isolated docroot with its own spatial.json (entry-optional worlds, a true domain default overridden by one explicit false)');
  fs.mkdirSync(path.join(DOCROOT_DIR, '.well-known'), { recursive: true });
  fs.mkdirSync(path.join(DOCROOT_DIR, 'spatial', 'lobby'), { recursive: true });
  fs.writeFileSync(path.join(DOCROOT_DIR, '.well-known', 'spatial.json'), JSON.stringify(SPATIAL_JSON, null, 2));
  fs.writeFileSync(path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json'), JSON.stringify(LOBBY_SCENE, null, 2));
  // No <link rel="spatial"> tag at all — only the domain-level default
  // applies; also the page this test uses for the Enter-Space regression
  // check (defaultWorld names the one enterable world).
  fs.writeFileSync(path.join(DOCROOT_DIR, 'page-default.html'), pageHtml('Default Page', ''));
  // Links to the entry-less, policy-only "bridge-allow" world.
  fs.writeFileSync(path.join(DOCROOT_DIR, 'page-allow.html'),
    pageHtml('Allow Page', '<link rel="spatial" href="/.well-known/spatial.json#bridge-allow">'));
  // Links to "bridge-deny" — explicit policy.walletBridge.read:false against
  // a true domain-level default.
  fs.writeFileSync(path.join(DOCROOT_DIR, 'page-deny.html'),
    pageHtml('Deny Page', '<link rel="spatial" href="/.well-known/spatial.json#bridge-deny">'));
  console.log('PASS: docroot ready');

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

    async function getIdentityFrom(urlPath) {
      const page = await context.newPage();
      await page.goto('http://' + DOMAIN + urlPath, { waitUntil: 'load' });
      const result = await page.evaluate(() => window.atlasWallet.getIdentity());
      await page.close();
      return result;
    }

    console.log('STEP 1: no identity yet — page-default.html (no <link>, domain-level walletBridge.read:true default) resolves allowed:true, publicKey:null');
    let result = await getIdentityFrom('/page-default.html');
    if (result.allowed !== true || result.publicKey !== null) throw new Error('Expected {allowed:true, publicKey:null} from the domain default pre-identity, got: ' + JSON.stringify(result));
    console.log('PASS: domain-level default grants read access; no identity yet so publicKey is null');

    console.log('STEP 2: page-allow.html (links to entry-less "bridge-allow", policy.walletBridge.read:true) resolves allowed:true, publicKey:null');
    result = await getIdentityFrom('/page-allow.html');
    if (result.allowed !== true || result.publicKey !== null) throw new Error('Expected {allowed:true, publicKey:null} from the world-level true override pre-identity, got: ' + JSON.stringify(result));
    console.log('PASS: world-level override to true grants read access, same as the domain default here');

    console.log('STEP 3: page-deny.html (links to entry-less "bridge-deny", policy.walletBridge.read:false) resolves allowed:false, publicKey:null — the explicit override winning over a true domain default, even with no identity involved yet');
    result = await getIdentityFrom('/page-deny.html');
    if (result.allowed !== false || result.publicKey !== null) throw new Error('Expected {allowed:false, publicKey:null} — world-level false must win outright over the domain default, got: ' + JSON.stringify(result));
    console.log('PASS: the explicit world-level false override withholds access despite a true domain-level default');

    console.log('STEP 4: Enter-Space button still appears for the one enterable world ("lobby") despite two entry-less worlds sharing the same manifest (regression check on the entry-optional filtering change)');
    const enterPage = await context.newPage();
    await enterPage.goto('http://' + DOMAIN + '/page-default.html', { waitUntil: 'load' });
    const btnText = await enterPage.locator('#domain-atlas-enter-btn').innerText();
    if (!btnText.includes('Bridge Test Lobby')) throw new Error('Expected the Enter-Space button to target the lobby world, got: ' + btnText);
    await enterPage.locator('#domain-atlas-enter-btn').click();
    const overlayHandle = await enterPage.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const overlayFrame = await overlayHandle.contentFrame();
    await overlayFrame.waitForFunction(() => !document.getElementById('placeLabel').textContent.includes('Loading'), null, { timeout: 10000 });
    console.log('PASS: the lobby world is still enterable and actually loads, with two policy-only worlds alongside it in the same manifest');
    await overlayFrame.locator('#closeBtn').click();
    await enterPage.waitForSelector('#domain-atlas-overlay', { state: 'detached', timeout: 10000 });
    await enterPage.close();

    console.log('STEP 5: creating a real wallet identity (side panel, standalone mode)');
    const walletPage = await context.newPage();
    await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
    await walletPage.locator('#chooseNewBtn').click();
    await walletPage.locator('#newPasswordInput').fill('page-bridge-test-pw');
    await walletPage.locator('#newPasswordConfirmInput').fill('page-bridge-test-pw');
    await walletPage.locator('#confirmCreateBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await walletPage.locator('#seedConfirmCheck').check();
    await walletPage.locator('#seedConfirmBtn').click();
    await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const realPublicKey = await walletPage.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      return identity ? identity.publicKey : null;
    });
    if (!realPublicKey || typeof realPublicKey !== 'string') throw new Error('Expected a real public key right after creating the identity, got: ' + JSON.stringify(realPublicKey));
    console.log('PASS: a real identity now exists, extension-wide (not tied to the tab that created it)');

    // chrome.storage.session's own write lands synchronously from the
    // caller's point of view (the await above already waited for it), but
    // background.js's service worker reading it right back can still lag a
    // tick behind in practice (same cross-context propagation gap
    // manual-toolbar-wallet-open.js's STEP 3b already polls around for the
    // toolbar icon) — polled directly against background's own AtlasWallet
    // rather than against a page's bridge call, so this isolates that
    // propagation gap from the actual thing STEP 6 is testing.
    let seenInBackground = null;
    for (let i = 0; i < 25 && seenInBackground !== realPublicKey; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      seenInBackground = await background.evaluate(async () => {
        const identity = await AtlasWallet.getIdentity();
        return identity ? identity.publicKey : null;
      });
    }
    if (seenInBackground !== realPublicKey) throw new Error('Expected background.js\'s own AtlasWallet.getIdentity() to see the new identity, got: ' + JSON.stringify(seenInBackground));
    console.log('PASS: background.js\'s own AtlasWallet.getIdentity() sees the new identity too');

    console.log('STEP 6: with an identity now active, page-default.html and page-allow.html both resolve the SAME real publicKey');
    result = await getIdentityFrom('/page-default.html');
    if (result.allowed !== true || result.publicKey !== realPublicKey) throw new Error('Expected the real public key via the domain default, got: ' + JSON.stringify(result));
    console.log('PASS: page-default.html — allowed:true, publicKey matches the real identity');
    result = await getIdentityFrom('/page-allow.html');
    if (result.allowed !== true || result.publicKey !== realPublicKey) throw new Error('Expected the real public key via the world-level true override, got: ' + JSON.stringify(result));
    console.log('PASS: page-allow.html — allowed:true, publicKey matches the real identity');

    console.log('STEP 7: page-deny.html STILL resolves publicKey:null even with a real identity active — the explicit false override withholds the key itself, not just a convenience default');
    result = await getIdentityFrom('/page-deny.html');
    if (result.allowed !== false || result.publicKey !== null) throw new Error('Expected {allowed:false, publicKey:null} even with an identity active — the gate must withhold the real key, got: ' + JSON.stringify(result));
    console.log('PASS: the explicit world-level false override still withholds the public key with a real identity active — the actual proof the gate holds data back, not just a flag');

    console.log('\nALL CHECKS PASSED — SPEC.md §3.8\'s read-only wallet bridge resolves window.atlasWallet.getIdentity() correctly for a true domain-level default, a world-level true override, and (critically) a world-level false override that wins outright over a true domain default both before and after a real identity exists; the entry-optional manifest change does not regress the Enter-Space button when entry-less, policy-only worlds share a manifest with a real enterable one.');
  } finally {
    await context.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
