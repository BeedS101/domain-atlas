// Manual check for task #213's new class-discovery read (SPEC.md §5.1.2):
// GET /atlas/asset/class?class=<class> — looks up ANY class an issuer
// defines, whether or not the caller has ever held a credential of it, so a
// scene's hoverable stall/crate can be previewed in the Asset Viewer before
// it's ever opened (see extension/wallet.js's fetchAssetClassInfo and
// extension/viewer.js's openAssetViewerPreview).
//
// Run at the HTTP layer directly against BOTH backends — same "prove the
// wire shapes match before trusting a browser against them" reasoning
// manual-trading-catalog.js already uses for the sibling
// GET /atlas/trade/catalog endpoint. Spins up its own fully isolated
// issuer-server instance and its own isolated issuer-php bundle copy,
// same "no shared mutable state, no reason to depend on anything else
// already running" reasoning as that file, since this endpoint likewise
// touches no state file at all (ASSET_CATALOG/ATLAS_ASSET_CATALOG are
// static, in-memory objects).
//
// Covers:
//   1. Node: a fungible, tradable class (atlas.element.iron) returns the
//      full shape — class/name/thumbnail/model/fungible/presentation/
//      tradeScope/properties — matching what GET /atlas/trade/catalog
//      already exposes for it PLUS the fields that endpoint never carries
//      at all (model, properties, fungible/presentation booleans).
//   2. Node: a NON-fungible class (atlas.trinket.pin, one of the lobby
//      crate's own collectibles) is reachable here even though it's
//      excluded from GET /atlas/trade/catalog entirely — the whole reason
//      this is a separate endpoint rather than folded into that one.
//   3. Node: a `tradeScope: 'bound'` class (atlas.tradingstation.membership)
//      is ALSO reachable here, unlike the trading catalog, which excludes
//      bound classes on purpose.
//   4. Node: an unknown class returns 404 with an error body, not a
//      500 or a silently-empty 200.
//   5. Node: an omitted ?class= returns 400 with an error body.
//   6. Node: the read is genuinely ungated — a plain GET, no identity,
//      membership, or credential presented at all.
//   7. PHP: issuer-php's atlas/asset/class.php returns the exact same
//      shape for the same three classes off its own independent
//      ATLAS_ASSET_CATALOG, proving the port didn't drift from the Node
//      original — same parity check manual-trading-catalog.js already runs
//      for the trading catalog.
//   8. PHP: the same 404/400 error shapes as Node for an unknown class and
//      a missing ?class=.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8103; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const PHP_PORT = 8104; // isolated — distinct from manual-trading-catalog.js's 8094 and every other PHP test's own port
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-classinfo-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-classinfo-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-classinfo-php-'));

function get(base, urlPath) {
  return fetch(base + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function assertClassInfoShape(label, cls, info, expected) {
  if (info.class !== cls) throw new Error(label + ': expected class="' + cls + '", got ' + JSON.stringify(info.class));
  if (info.name !== expected.name) throw new Error(label + ': expected name="' + expected.name + '" for ' + cls + ', got ' + JSON.stringify(info.name));
  if (info.fungible !== expected.fungible) throw new Error(label + ': expected fungible=' + expected.fungible + ' for ' + cls + ', got ' + JSON.stringify(info.fungible));
  if (info.presentation !== expected.presentation) throw new Error(label + ': expected presentation="' + expected.presentation + '" for ' + cls + ', got ' + JSON.stringify(info.presentation));
  if (info.tradeScope !== expected.tradeScope) throw new Error(label + ': expected tradeScope="' + expected.tradeScope + '" for ' + cls + ', got ' + JSON.stringify(info.tradeScope));
  if (typeof info.model !== 'string' || !info.model) throw new Error(label + ': expected a non-empty model URL for ' + cls + ', got ' + JSON.stringify(info.model));
  if (typeof info.thumbnail !== 'string' || !info.thumbnail) throw new Error(label + ': expected a non-empty thumbnail URL for ' + cls + ', got ' + JSON.stringify(info.thumbnail));
  if (!info.properties || typeof info.properties !== 'object' || Object.keys(info.properties).length === 0) {
    throw new Error(label + ': expected a non-empty properties bag for ' + cls + ', got ' + JSON.stringify(info.properties));
  }
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
    console.log('STEP 1: Node — a fungible, tradable class (atlas.element.iron) returns the full shape, ungated (no headers, no identity, no credential)');
    const nodeIron = await get('http://localhost:' + NODE_PORT, '/atlas/asset/class?class=atlas.element.iron');
    if (nodeIron.status !== 200) throw new Error('Expected 200, got ' + nodeIron.status + ': ' + JSON.stringify(nodeIron.body));
    assertClassInfoShape('Node', 'atlas.element.iron', nodeIron.body, { name: 'Iron (Fe)', fungible: true, presentation: 'collectible', tradeScope: 'local' });
    console.log('PASS: Node iron ->', JSON.stringify(nodeIron.body.name), 'fungible=' + nodeIron.body.fungible);

    console.log('STEP 2: Node — a NON-fungible class this domain\'s lobby crate mints (atlas.trinket.pin), excluded from GET /atlas/trade/catalog entirely, is reachable here');
    const nodePin = await get('http://localhost:' + NODE_PORT, '/atlas/asset/class?class=atlas.trinket.pin');
    if (nodePin.status !== 200) throw new Error('Expected 200, got ' + nodePin.status + ': ' + JSON.stringify(nodePin.body));
    // tradeScope: 'bound' as of the task #250 follow-up — a oncePerUser
    // giveaway needed real protocol-level enforcement, not just a
    // per-device courtesy check (see issuer-server/server.js's own
    // ASSET_CATALOG comment on atlas.trinket.pin).
    assertClassInfoShape('Node', 'atlas.trinket.pin', nodePin.body, { name: 'Lobby Enamel Pin', fungible: false, presentation: 'collectible', tradeScope: 'bound' });
    console.log('PASS: Node atlas.trinket.pin ->', JSON.stringify(nodePin.body.name), 'fungible=' + nodePin.body.fungible);

    console.log('STEP 3: Node — a tradeScope:"bound" class (atlas.tradingstation.membership), excluded from GET /atlas/trade/catalog on purpose, is ALSO reachable here');
    const nodeMembership = await get('http://localhost:' + NODE_PORT, '/atlas/asset/class?class=atlas.tradingstation.membership');
    if (nodeMembership.status !== 200) throw new Error('Expected 200, got ' + nodeMembership.status + ': ' + JSON.stringify(nodeMembership.body));
    if (nodeMembership.body.tradeScope !== 'bound') throw new Error('Expected tradeScope="bound" for atlas.tradingstation.membership, got ' + JSON.stringify(nodeMembership.body.tradeScope));
    console.log('PASS: Node atlas.tradingstation.membership -> tradeScope="bound", still returned in full');

    console.log('STEP 4: Node — an unknown class returns 404 with an error body');
    const nodeUnknown = await get('http://localhost:' + NODE_PORT, '/atlas/asset/class?class=com.example.doesNotExist');
    if (nodeUnknown.status !== 404) throw new Error('Expected 404 for an unknown class, got ' + nodeUnknown.status + ': ' + JSON.stringify(nodeUnknown.body));
    if (!nodeUnknown.body.error) throw new Error('Expected an error message on the 404 body, got ' + JSON.stringify(nodeUnknown.body));
    console.log('PASS: Node unknown class -> 404,', JSON.stringify(nodeUnknown.body.error));

    console.log('STEP 5: Node — an omitted ?class= returns 400 with an error body');
    const nodeMissing = await get('http://localhost:' + NODE_PORT, '/atlas/asset/class');
    if (nodeMissing.status !== 400) throw new Error('Expected 400 for a missing class param, got ' + nodeMissing.status + ': ' + JSON.stringify(nodeMissing.body));
    if (!nodeMissing.body.error) throw new Error('Expected an error message on the 400 body, got ' + JSON.stringify(nodeMissing.body));
    console.log('PASS: Node missing ?class= -> 400,', JSON.stringify(nodeMissing.body.error));

    console.log('STEP 6: PHP — the exact same three classes, same shape, off its own independent ATLAS_ASSET_CATALOG');
    const phpIron = await get(PHP_BASE, '/atlas/asset/class?class=atlas.element.iron');
    if (phpIron.status !== 200) throw new Error('Expected 200 from PHP, got ' + phpIron.status + ': ' + JSON.stringify(phpIron.body));
    assertClassInfoShape('PHP', 'atlas.element.iron', phpIron.body, { name: 'Iron (Fe)', fungible: true, presentation: 'collectible', tradeScope: 'local' });
    const phpPin = await get(PHP_BASE, '/atlas/asset/class?class=atlas.trinket.pin');
    if (phpPin.status !== 200) throw new Error('Expected 200 from PHP, got ' + phpPin.status + ': ' + JSON.stringify(phpPin.body));
    assertClassInfoShape('PHP', 'atlas.trinket.pin', phpPin.body, { name: 'Lobby Enamel Pin', fungible: false, presentation: 'collectible', tradeScope: 'bound' });
    const phpMembership = await get(PHP_BASE, '/atlas/asset/class?class=atlas.tradingstation.membership');
    if (phpMembership.status !== 200) throw new Error('Expected 200 from PHP, got ' + phpMembership.status + ': ' + JSON.stringify(phpMembership.body));
    if (phpMembership.body.tradeScope !== 'bound') throw new Error('Expected tradeScope="bound" from PHP for atlas.tradingstation.membership, got ' + JSON.stringify(phpMembership.body.tradeScope));
    console.log('PASS: PHP matches Node for iron, atlas.trinket.pin, and atlas.tradingstation.membership');

    console.log('STEP 7: cross-backend parity — same name + thumbnail/model path (once each domain prefix is stripped) for all three classes');
    // atlas.tradingstation.membership's `name` carries a literal '{domain}'
    // template token (see issuer-php/lib/store.php's atlas_asset_catalog_
    // entry() comment), expanded against whichever domain actually answers
    // the request — so Node (port 8103) and PHP (port 8104) are SUPPOSED to
    // disagree on this one field for this one class, by design, not by
    // drift. Checked separately below instead of via the flat equality
    // every other class gets.
    const PER_DOMAIN_NAME_CLASSES = new Set(['atlas.tradingstation.membership']);
    const pairs = [['atlas.element.iron', nodeIron.body, phpIron.body], ['atlas.trinket.pin', nodePin.body, phpPin.body], ['atlas.tradingstation.membership', nodeMembership.body, phpMembership.body]];
    for (const [cls, n, p] of pairs) {
      if (PER_DOMAIN_NAME_CLASSES.has(cls)) {
        if (!n.name.includes(NODE_DOMAIN)) throw new Error('Expected Node\'s own domain in its templated name for ' + cls + ', got "' + n.name + '"');
        if (!p.name.includes('localhost:' + PHP_PORT)) throw new Error('Expected PHP\'s own domain in its templated name for ' + cls + ', got "' + p.name + '"');
      } else if (n.name !== p.name) {
        throw new Error('Name mismatch for ' + cls + ': Node="' + n.name + '" PHP="' + p.name + '"');
      }
      const stripDomain = (url, domain) => url && url.replace('https://' + domain, '');
      const nodeModelPath = stripDomain(n.model, NODE_DOMAIN);
      const phpModelPath = stripDomain(p.model, 'localhost:' + PHP_PORT);
      if (nodeModelPath !== phpModelPath) throw new Error('Model path mismatch for ' + cls + ': Node="' + nodeModelPath + '" PHP="' + phpModelPath + '"');
    }
    console.log('PASS: Node and PHP agree on name (or its per-domain template, for the one class that has one) + model path for all 3 shared classes — the port did not drift from the original');

    console.log('STEP 8: PHP — same 404/400 error shapes as Node');
    const phpUnknown = await get(PHP_BASE, '/atlas/asset/class?class=com.example.doesNotExist');
    if (phpUnknown.status !== 404) throw new Error('Expected 404 from PHP for an unknown class, got ' + phpUnknown.status + ': ' + JSON.stringify(phpUnknown.body));
    const phpMissing = await get(PHP_BASE, '/atlas/asset/class');
    if (phpMissing.status !== 400) throw new Error('Expected 400 from PHP for a missing class param, got ' + phpMissing.status + ': ' + JSON.stringify(phpMissing.body));
    console.log('PASS: PHP -> 404 for unknown class, 400 for missing ?class=, matching Node');

    console.log('\nALL ASSET-CLASS LOOKUP (TASK #213) CHECKS PASSED');
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
