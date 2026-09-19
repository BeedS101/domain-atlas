// Manual check for task #202 (SPEC.md §7's new "Catalog discovery"
// paragraph): GET /atlas/trade/catalog — a station's own tradable fungible
// classes, exposed for the first time so a client can populate the Sell
// tab's "You want" dropdown live instead of the hardcoded 3-option list
// that used to live in extension/viewer.html (see viewer.js's
// refreshTradingSellWantOptions, wallet.js's fetchTradableClasses).
//
// Run at the HTTP layer directly against BOTH backends — same "prove the
// wire shapes match before trusting a browser against them" reasoning
// manual-trade-submit-php.js already uses for the rest of Trading Station.
// Spins up its own fully isolated issuer-server instance (fresh port,
// ATLAS_STATE_DIR/ATLAS_DOCROOT under a temp dir, ATLAS_DOMAIN matching
// that port) rather than depending on the shared localhost:8001/:8002
// instances other cross-domain tests assume are already running — this
// endpoint touches no state file at all (ASSET_CATALOG is a static, in-
// memory object), so there's no reason to share a mutable instance with
// anything else and every reason not to (no leftover state to reset
// between runs). Same "own isolated instance" reasoning
// manual-federation-relay-php.js already uses for its two PHP copies.
//
// Covers:
//   1. Node: GET /atlas/trade/catalog returns iron/gold/silver plus every
//      one of task #204's 115 periodic-table elements — 118 fungible,
//      non-bound classes exactly, no more, no fewer. (Originally this
//      asserted an EXACT 3-class list; #204's expansion widened it to "the
//      original 3 are present, PLUS the 115 new ones, PLUS nothing else"
//      — see assertCatalogShape below.)
//   2. Node: every bound or non-fungible class (atlas.membership,
//      atlas.postoffice.membership, atlas.tradingstation.membership,
//      atlas.wearable, atlas.badge, atlas.wearable.ring, atlas.trophy.chess)
//      is excluded.
//   3. Node: each returned entry carries the right shape (class/name/
//      thumbnail/tradeScope), tradeScope defaulting to "local" the same
//      way mintAssetByClass's own `catalogEntry.tradeScope || 'local'`
//      does, and the response's own `domain` field matches ATLAS_DOMAIN.
//   4. Node: the response is genuinely ungated — a plain GET with no
//      identity, membership, or credential presented at all.
//   5. PHP: issuer-php's atlas/trade/catalog.php port returns the exact
//      same 118-class set, in the same shape, off its own independent
//      ATLAS_ASSET_CATALOG (base + elements-catalog.php merge) — proving
//      the port didn't silently drift from the Node original.
//   6. A couple of #204's new element entries carry exchangeRate (every
//      element in the catalog is rated) and the isBaseCurrency flag still
//      lands only on gold, not on any of the 115 new ones.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8093; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const PHP_PORT = 8094; // isolated — distinct from manual-trade-submit-php.js's 8096, manual-chat-php.js's 8097, manual-presence-php.js's 8098
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-catalog-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-catalog-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-catalog-php-'));

const ORIGINAL_THREE = ['atlas.element.gold', 'atlas.element.iron', 'atlas.element.silver'];
// Task #204 added the other 115 periodic-table elements (118 total fungible
// classes) — a fixed count check plus "the original 3 are in there" is more
// maintainable than hand-listing all 118 names here.
const EXPECTED_TOTAL_CLASSES = 118;
const EXCLUDED_CLASSES = [
  'atlas.membership', 'atlas.postoffice.membership', 'atlas.tradingstation.membership',
  'atlas.wearable', 'atlas.badge', 'atlas.wearable.ring', 'atlas.trophy.chess'
];

function get(base, urlPath) {
  return fetch(base + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function assertCatalogShape(label, classes) {
  const names = classes.map((c) => c.class).sort();
  if (names.length !== EXPECTED_TOTAL_CLASSES) {
    throw new Error(label + ': expected exactly ' + EXPECTED_TOTAL_CLASSES + ' classes, got ' + names.length + ': ' + JSON.stringify(names));
  }
  for (const original of ORIGINAL_THREE) {
    if (!names.includes(original)) throw new Error(label + ': expected the original ' + original + ' to still be present, it was missing');
  }
  for (const excluded of EXCLUDED_CLASSES) {
    if (names.includes(excluded)) throw new Error(label + ': expected ' + excluded + ' to be excluded (bound or non-fungible), but it was present');
  }
  let baseCurrencyCount = 0;
  for (const entry of classes) {
    if (!entry.name || typeof entry.name !== 'string') throw new Error(label + ': expected a string name on ' + entry.class + ', got ' + JSON.stringify(entry));
    if (entry.tradeScope !== 'local') throw new Error(label + ': expected tradeScope "local" (the unset default) on ' + entry.class + ', got ' + JSON.stringify(entry));
    if (!('thumbnail' in entry)) throw new Error(label + ': expected a thumbnail field (even if null) on ' + entry.class + ', got ' + JSON.stringify(entry));
    if (typeof entry.exchangeRate !== 'number') throw new Error(label + ': expected every class to carry a numeric exchangeRate (task #204: every element is rated), missing on ' + entry.class);
    if (entry.isBaseCurrency) baseCurrencyCount++;
  }
  if (baseCurrencyCount !== 1) throw new Error(label + ': expected exactly one isBaseCurrency: true entry (gold), found ' + baseCurrencyCount);
}

(async () => {
  console.log('SETUP: starting an isolated issuer-server instance on port ' + NODE_PORT);
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(NODE_PORT),
      ATLAS_DOMAIN: NODE_DOMAIN,
      ATLAS_STATE_DIR: NODE_STATE_DIR,
      ATLAS_DOCROOT: NODE_DOCROOT_DIR
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + NODE_PORT);

  console.log('SETUP: copying issuer-php into an isolated bundle dir and starting its own dev server on port ' + PHP_PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), PHP_BUNDLE_DIR, { recursive: true });
  const phpProc = spawn('php', ['-S', 'localhost:' + PHP_PORT, 'test-router.php'], { cwd: PHP_BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    phpProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    phpProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-php dev server up on port ' + PHP_PORT);

  try {
    console.log('STEP 1: Node — GET /atlas/trade/catalog with no headers, no credential, no identity at all (ungated)');
    const nodeRes = await get('http://localhost:' + NODE_PORT, '/atlas/trade/catalog');
    if (nodeRes.status !== 200) throw new Error('Expected 200 from an ungated GET, got ' + nodeRes.status + ': ' + JSON.stringify(nodeRes.body));
    if (nodeRes.body.domain !== NODE_DOMAIN) throw new Error('Expected domain ' + NODE_DOMAIN + ', got ' + JSON.stringify(nodeRes.body.domain));
    console.log('PASS: 200, ungated, domain matches ->', nodeRes.body.domain);

    console.log('STEP 2: Node — the original 3 fungible elements plus task #204\'s 115 periodic-table elements (118 total), no membership cards or unique items leaking in');
    assertCatalogShape('Node', nodeRes.body.classes);
    console.log('PASS: Node catalog ->', nodeRes.body.classes.length, 'classes, including', JSON.stringify(ORIGINAL_THREE));

    console.log('STEP 3: Node — tradeScope defaults to "local" for every entry, matching mintAssetByClass\'s own `catalogEntry.tradeScope || \'local\'` convention, and every entry carries a numeric exchangeRate with exactly one isBaseCurrency: true (gold)');
    console.log('PASS: checked inside assertCatalogShape above, for all 118 entries');

    console.log('STEP 4: PHP — GET /atlas/trade/catalog on an independent bundle copy returns the exact same 118-class set, same shape');
    const phpRes = await get(PHP_BASE, '/atlas/trade/catalog');
    if (phpRes.status !== 200) throw new Error('Expected 200 from PHP\'s ungated GET, got ' + phpRes.status + ': ' + JSON.stringify(phpRes.body));
    assertCatalogShape('PHP', phpRes.body.classes);
    console.log('PASS: PHP catalog matches Node\'s ->', phpRes.body.classes.length, 'classes');

    console.log('STEP 5: cross-backend parity — same names, same thumbnails (once each domain prefix is stripped), same exchangeRate, for every one of the 118 shared classes');
    const nodeByClass = new Map(nodeRes.body.classes.map((c) => [c.class, c]));
    const phpByClass = new Map(phpRes.body.classes.map((c) => [c.class, c]));
    for (const cls of nodeByClass.keys()) {
      const n = nodeByClass.get(cls), p = phpByClass.get(cls);
      if (!p) throw new Error('PHP is missing class ' + cls + ' that Node has');
      if (n.name !== p.name) throw new Error('Name mismatch for ' + cls + ': Node="' + n.name + '" PHP="' + p.name + '"');
      if (n.exchangeRate !== p.exchangeRate) throw new Error('exchangeRate mismatch for ' + cls + ': Node=' + n.exchangeRate + ' PHP=' + p.exchangeRate);
      const nodeThumbPath = n.thumbnail && n.thumbnail.replace('https://' + NODE_DOMAIN, '');
      const phpThumbPath = p.thumbnail && p.thumbnail.replace('https://localhost:' + PHP_PORT, '');
      if (nodeThumbPath !== phpThumbPath) throw new Error('Thumbnail path mismatch for ' + cls + ': Node="' + nodeThumbPath + '" PHP="' + phpThumbPath + '"');
    }
    console.log('PASS: Node and PHP agree on name + thumbnail path + exchangeRate for all 118 shared classes — the port did not drift from the original');

    console.log('\nALL TRADING CATALOG (TASK #202) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    nodeProc.kill();
    phpProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PHP_BUNDLE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
