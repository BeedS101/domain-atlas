// A page that asks the wallet bridge for the identity as soon as it loads, before the extension's content script has
// attached, still gets an answer within a few seconds: page-bridge.js sends the request again until the content script
// acknowledges it. A page that waited for a lost request for minutes would leave its "wallet" status stuck (the Asset
// Studio checks the wallet exactly this way). A scratch profile and a local page; nothing leaves this machine.
//
// Run: xvfb-run -a node test/manual-bridge-early-request.js
'use strict';
const http = require('http');
const L = require('./call-e2e-lib');
const { check } = L;

const PAGE = `<!doctype html><meta charset="utf-8"><title>early</title>
<script>
  // Runs while the document is still being parsed, long before the content script (document_idle) attaches.
  window.__early = { startedAt: Date.now(), result: null, elapsed: null };
  window.atlasWallet.getIdentity().then((r) => { window.__early.result = r; window.__early.elapsed = Date.now() - window.__early.startedAt; });
</script>
<body>early request page</body>`;

(async () => {
  let origin = '';
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/.well-known/spatial.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ spec: 'domain-atlas/1.0', domain: new URL(origin).host, owner: { name: 'T', contact: 'd@localhost' }, defaultWorld: 'main',
        walletBridge: { read: true },
        worlds: [{ id: 'main', name: 'Main', entry: { scene: '/s.json', renderer: ['procedural-v1'] }, policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' } }],
        updated: '2026-10-02T00:00:00Z' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  origin = 'http://127.0.0.1:' + server.address().port;
  const w = await L.launchWallet('bridge-early');
  try {
    console.log('--- no wallet yet ---');
    let page = await w.context.newPage();
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__early && window.__early.result, null, { timeout: 9000 }).catch(() => {});
    let early = await page.evaluate(() => window.__early);
    check('an early request is answered, not left waiting', !!early.result, early);
    check('and answered quickly (it was not lost for minutes)', early.elapsed !== null && early.elapsed < 4000, early);
    check('it reports read access allowed and no identity', early.result && early.result.allowed === true && early.result.publicKey === null, early);
    await page.close();

    console.log('--- with an unlocked wallet ---');
    const pub = (await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'bridge-early-password')).publicKey;
    page = await w.context.newPage();
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__early && window.__early.result, null, { timeout: 9000 }).catch(() => {});
    early = await page.evaluate(() => window.__early);
    check('the early request returns the wallet identity', early.result && early.result.allowed === true && early.result.publicKey === pub, early);
    check('quickly', early.elapsed !== null && early.elapsed < 4000, early);

    console.log('--- a repeated request is answered once ---');
    const second = await page.evaluate(async () => { const a = await window.atlasWallet.getIdentity(); const b = await window.atlasWallet.getIdentity(); return [a, b]; });
    check('later requests are answered normally', second.every((r) => r.allowed === true && typeof r.publicKey === 'string'), second);
  } finally {
    await w.close();
    server.close();
  }
  process.exit(L.finish('manual-bridge-early-request'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
