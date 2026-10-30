// Real-browser check: a page may LINK a manifest from another origin for world discovery (the Enter
// button), but only a manifest on the page's OWN origin can grant it wallet bridge access.
//   xvfb-run -a node test/manual-bridge-foreign-manifest.js
// EXT_PATH may point at another extension copy (used to confirm this test fails against older code).
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = process.env.EXT_PATH || path.resolve(__dirname, '..', 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-foreign-profile-'));
const CLASS = 'atlas.wearable.ring';

function manifestFor(domain, withBridge) {
  return {
    spec: 'domain-atlas/1.0', domain, owner: { name: 'Test', contact: 'demo@localhost' }, defaultWorld: 'plaza',
    worlds: [
      { id: 'plaza', name: 'Plaza', entry: { scene: '/spatial/plaza/scene.json', renderer: ['procedural-v1'] },
        policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' } },
      { id: 'bridge', name: 'Bridge', policy: { walletBridge: withBridge ? { read: true, sign: ['login'], offer: [CLASS] } : { read: false } } },
    ],
    updated: '2026-10-02T00:00:00Z',
  };
}

function serve(port, files) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = files(req.url.split('#')[0]);
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': f.type, 'Access-Control-Allow-Origin': '*' });
      res.end(f.body);
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function assertTrue(c, m) { if (!c) throw new Error(m); }

(async () => {
  const A = 8731, B = 8732;
  const html = (link) => '<!doctype html><title>t</title><link rel="spatial" href="' + link + '"><body>page</body>';
  const bSrv = await serve(B, (u) => u === '/.well-known/spatial.json' ? { type: 'application/json', body: JSON.stringify(manifestFor('localhost:' + B, true)) } : null);
  const aSrv = await serve(A, (u) => {
    if (u === '/.well-known/spatial.json') return { type: 'application/json', body: JSON.stringify(manifestFor('localhost:' + A, true)) };
    if (u === '/foreign.html') return { type: 'text/html', body: html('http://localhost:' + B + '/.well-known/spatial.json#bridge') };
    if (u === '/foreign-world.html') return { type: 'text/html', body: html('http://localhost:' + B + '/.well-known/spatial.json#plaza') };
    if (u === '/own.html') return { type: 'text/html', body: html('/.well-known/spatial.json#bridge') };
    return null;
  });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, executablePath: '/opt/pw-browsers/chromium',
    args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox'],
  });
  let ok = false;
  try {
    if (!context.serviceWorkers()[0]) await context.waitForEvent('serviceworker');
    console.log('STEP 1: a page on A linking a bridge-granting manifest on B gets NO bridge access');
    const foreign = await context.newPage();
    await foreign.goto('http://localhost:' + A + '/foreign.html', { waitUntil: 'load' });
    const id = await foreign.evaluate(() => window.atlasWallet.getIdentity());
    assertTrue(id.allowed === false, 'getIdentity must be denied, got ' + JSON.stringify(id));
    const sign = await foreign.evaluate(() => window.atlasWallet.requestSignature({ purpose: 'login', nonce: 'n' }));
    assertTrue(sign.allowed === false && sign.result === null, 'requestSignature must be denied, got ' + JSON.stringify(sign));
    assertTrue(await foreign.locator('#domain-atlas-bridge-confirm').count() === 0, 'no confirmation prompt may appear');
    const offer = await foreign.evaluate(() => window.atlasWallet.offerAsset({ credential: 'domain-atlas-asset/1.0', id: 'x', asset: { class: 'atlas.wearable.ring' } }));
    assertTrue(offer.allowed === false, 'offerAsset must be denied, got ' + JSON.stringify(offer));
    assertTrue(await foreign.locator('#domain-atlas-bridge-confirm').count() === 0, 'no offer prompt may appear');
    console.log('PASS: read, sign and offer all denied, no prompt');

    console.log('STEP 2: cross-domain world discovery still works (Enter button for the linked world)');
    const disc = await context.newPage();
    await disc.goto('http://localhost:' + A + '/foreign-world.html', { waitUntil: 'load' });
    await disc.waitForSelector('#domain-atlas-enter-btn', { timeout: 10000 });
    console.log('PASS: Enter button offered for the linked foreign world');

    console.log('STEP 3: a page linking its own origin\'s manifest keeps bridge access');
    const own = await context.newPage();
    await own.goto('http://localhost:' + A + '/own.html', { waitUntil: 'load' });
    const o = await own.evaluate(() => window.atlasWallet.getIdentity());
    assertTrue(o.allowed === true, 'own-origin manifest must grant read, got ' + JSON.stringify(o));
    console.log('PASS: same-origin manifest still grants the bridge');
    ok = true;
  } finally {
    await context.close().catch(() => {});
    aSrv.close(); bSrv.close();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  console.log(ok ? '\nAll foreign-manifest checks passed' : '\nFAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
