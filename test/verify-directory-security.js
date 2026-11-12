// The directory's protections, against real HTTP traffic, for the Node reference or the PHP port
// (DIRECTORY_IMPL=php). Each check names what a hostile or careless submitter could try:
//   - listing a world under another site's name, or from the wrong path
//   - redirects, oversize manifests, oversize or malformed request bodies
//   - private, loopback, link-local and credential-bearing URLs (public mode)
//   - flooding /submit, and growing the index without bound
//   - raising a rank by linking to yourself, and reaching the service's own files over HTTP
// and the behaviours that keep results honest: domain-level defaults (SPEC.md 3.4.1), per-field
// limits, pagination, and a failed submission leaving nothing behind.
//
// Run: node test/verify-directory-security.js            (Node)
//      DIRECTORY_IMPL=php node test/verify-directory-security.js
'use strict';
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { startDirectory } = require('./support/directory-harness');

const IMPL = process.env.DIRECTORY_IMPL || 'node';
let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log('PASS ' + label);
  else { failures++; console.log('FAIL ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); }
}

const WELL_KNOWN = '/.well-known/spatial.json';

function world(id, extra = {}) {
  return {
    id, name: 'World ' + id, entry: { scene: '/s/' + id + '.json', renderer: ['procedural-v1'] },
    policy: { guestAccess: 'open', discoverable: true, itemDropsAllowed: false, trustedIssuers: 'any' },
    profile: { genre: 'security-test', scale: 'room', capabilities: { building: 'none', vehicles: false, combat: 'none', landOwnership: false } },
    portals: [], ...extra
  };
}

// A small web server. `handler(req, res, host)` answers; `host` is "127.0.0.1:<port>", the name a
// domain-anchored manifest served here has to claim.
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res, '127.0.0.1:' + server.address().port));
    server.listen(0, '127.0.0.1', () => resolve({ server, host: '127.0.0.1:' + server.address().port, url: 'http://127.0.0.1:' + server.address().port + WELL_KNOWN }));
  });
}

function manifestServer(build) {
  return serve((req, res, host) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(build(host)));
  });
}

async function post(base, bodyText, headers = {}) {
  const r = await fetch(base + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: bodyText });
  let json = null;
  try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json };
}
const submit = (base, url) => post(base, JSON.stringify({ manifest: url }));
const search = async (base, query) => (await fetch(base + '/search?' + query)).json();
const stats = async (base) => (await fetch(base + '/stats')).json();

async function main() {
  const servers = [];
  const track = (s) => { servers.push(s.server); return s; };
  console.log('Directory implementation: ' + IMPL);

  const local = await startDirectory({ port: 8201, env: { DIRECTORY_ALLOW_LOCAL: '1', DIRECTORY_SUBMITS_PER_HOUR: '1000', DIRECTORY_CRAWL_INTERVAL_MS: '3600000' } });
  const L = local.base;
  const publicMode = await startDirectory({ port: 8202, env: { DIRECTORY_ALLOW_LOCAL: '0' } });
  const rateLimited = await startDirectory({ port: 8203, env: { DIRECTORY_ALLOW_LOCAL: '1', DIRECTORY_SUBMITS_PER_HOUR: '3' } });
  const blocking = await startDirectory({ port: 8205, env: { DIRECTORY_ALLOW_LOCAL: '1', DIRECTORY_SUBMITS_PER_HOUR: '1000' } });
  const capped = await startDirectory({ port: 8204, env: { DIRECTORY_ALLOW_LOCAL: '1', DIRECTORY_MAX_MANIFESTS: '1', DIRECTORY_SUBMITS_PER_HOUR: '1000' } });
  try {
    console.log('--- a normal submission works ---');
    const good = track(await manifestServer((host) => ({ spec: 'domain-atlas/1.0', domain: host, owner: { name: 'Honest' }, worlds: [world('hall')] })));
    let r = await submit(L, good.url);
    check('a manifest served from its own domain is indexed', r.status === 200 && r.json.indexed === 1, r);

    console.log('--- listing under another site\'s name ---');
    const before = (await stats(L)).manifestsTracked;
    const spoof = track(await manifestServer(() => ({ spec: 'domain-atlas/1.0', domain: 'victim.example', owner: { name: 'Not them' }, worlds: [world('fake')] })));
    r = await submit(L, spoof.url);
    check('a manifest claiming a different domain than the host that served it is refused', r.status === 422 && /served from/.test(r.json.error), r);
    check('...and nothing is listed under the claimed name', (await search(L, 'domain=victim.example')).count === 0);
    check('...and the failed submission left nothing behind', (await stats(L)).manifestsTracked === before);

    const wrongPath = track(await serve((req, res, host) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ spec: 'domain-atlas/1.0', domain: host, worlds: [world('other')] })); }));
    r = await submit(L, 'http://' + wrongPath.host + '/some/other/place.json');
    check('a domain-anchored manifest from anywhere but /.well-known/spatial.json is refused', r.status === 422 && /well-known/.test(r.json.error), r);

    console.log('--- redirects and size ---');
    const redirect = track(await serve((req, res) => { res.writeHead(302, { Location: good.url }); res.end(); }));
    r = await submit(L, redirect.url);
    check('a redirect is not followed', r.status === 422 && /redirect/i.test(r.json.error), r);
    const huge = track(await serve((req, res, host) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ spec: 'domain-atlas/1.0', domain: host, worlds: [world('big')], padding: 'x'.repeat(300 * 1024) }));
    }));
    r = await submit(L, huge.url);
    check('a manifest over the size limit is refused', r.status === 422 && /larger/.test(r.json.error), r);
    const endless = track(await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const timer = setInterval(() => res.write('x'.repeat(65536)), 5);
      res.on('close', () => clearInterval(timer));
    }));
    r = await submit(L, endless.url);
    check('a body that never ends is cut off at the limit', r.status === 422 && /larger/.test(r.json.error), r);
    const notJson = track(await serve((req, res) => { res.writeHead(200); res.end('<html>nope</html>'); }));
    r = await submit(L, notJson.url);
    check('something that is not JSON is refused', r.status === 422 && /JSON/.test(r.json.error), r);

    console.log('--- malformed and oversize requests ---');
    r = await post(L, '{nope');
    check('a request that is not JSON is a 400, not a crash', r.status === 400, r);
    r = await post(L, JSON.stringify({ manifest: 42 }));
    check('a manifest that is not a string is a 400', r.status === 400, r);
    r = await post(L, JSON.stringify({ manifest: 'https://example.com/x', pad: 'y'.repeat(6000) }));
    check('a request body over the limit is a 413', r.status === 413, r);
    r = await post(L, JSON.stringify({ manifest: 'x'.repeat(2500) }));
    check('an absurdly long URL is a 400', r.status === 400, r);
    r = await post(L, JSON.stringify({ manifest: 'ftp://example.com/x' }));
    check('a scheme other than https is a 400', r.status === 400, r);

    console.log('--- what the service serves over HTTP ---');
    const exposed = IMPL === 'php'
      ? ['/atlas/directory/lib/store.php', '/atlas/directory/lib/atlas-directory-index.json', '/atlas/directory/lib/bootstrap.php']
      : ['/server.js', '/package.json', '/directory-index.json', '/../server.js', '/%2e%2e/server.js'];
    for (const p of exposed) {
      const res = await fetch(L.replace(/\/atlas\/directory$/, '') + p);
      const text = await res.text();
      check('GET ' + p + ' does not return the file', res.status >= 400 && !/require\(|<\?php|"manifests"/.test(text), res.status);
    }
    if (IMPL === 'php') {
      const res = await fetch(L + '/cron');
      check('the cron script cannot be run over the web', res.status === 404);
    }

    console.log('--- ranking cannot be inflated by linking to yourself ---');
    const target = track(await manifestServer((host) => ({ spec: 'domain-atlas/1.0', domain: host, worlds: [world('target')] })));
    const linker = track(await manifestServer((host) => ({ spec: 'domain-atlas/1.0', domain: host, worlds: [
      world('l1', { portals: [{ kind: 'domain', to: target.host }, { kind: 'domain', to: host }] }),
      world('l2', { portals: [{ kind: 'domain', to: target.host }] }),
      world('l3', { portals: [{ kind: 'domain', to: target.host }, { kind: 'domain', to: target.host }] })
    ] })));
    await submit(L, target.url);
    await submit(L, linker.url);
    const t = await search(L, 'domain=' + encodeURIComponent(target.host));
    const l = await search(L, 'domain=' + encodeURIComponent(linker.host));
    check('five portals from one site count as one inbound link', t.results[0].inboundPortalCount === 1, t.results[0]);
    check('a site\'s portal to itself counts for nothing', l.results.every((w) => w.inboundPortalCount === 0), l.results.map((w) => w.inboundPortalCount));

    console.log('--- domain-level defaults (SPEC.md 3.4.1) ---');
    const defaults = track(await manifestServer((host) => ({
      spec: 'domain-atlas/1.0', domain: host, acceptedItemClasses: ['atlas.wearable'], identityRequired: true,
      worlds: [
        world('inherits'),
        world('overrides', { policy: { guestAccess: 'open', discoverable: true, identityRequired: false, acceptedItemClasses: [] } })
      ]
    })));
    await submit(L, defaults.url);
    const d = await search(L, 'domain=' + encodeURIComponent(defaults.host));
    const inherits = d.results.find((w) => w.worldId === 'inherits');
    const overrides = d.results.find((w) => w.worldId === 'overrides');
    check('a world without its own value takes the domain default', inherits && inherits.identityRequired === true && JSON.stringify(inherits.acceptedItemClasses) === '["atlas.wearable"]', inherits);
    check('a world\'s own value wins, even false and an empty list', overrides && overrides.identityRequired === false && overrides.acceptedItemClasses.length === 0, overrides);
    check('identityRequired can be used as a filter', (await search(L, 'domain=' + encodeURIComponent(defaults.host) + '&identityRequired=true')).results.length === 1);

    console.log('--- limits on what is stored ---');
    const bulky = track(await manifestServer((host) => ({
      spec: 'domain-atlas/1.0', domain: host, owner: { name: 'O'.repeat(500) },
      worlds: Array.from({ length: 150 }, (_, i) => world('w' + i, { name: i === 0 ? 'N'.repeat(500) : 'World ' + i, description: 'D'.repeat(1000) }))
    })));
    r = await submit(L, bulky.url);
    check('only the first 100 worlds of one manifest are indexed', r.status === 200 && r.json.indexed === 100, r);
    const b = await search(L, 'domain=' + encodeURIComponent(bulky.host) + '&limit=5');
    check('long text fields are cut to their limits', b.results.every((w) => w.name.length <= 120 && (w.description || '').length <= 300 && (w.ownerName || '').length <= 120), b.results.map((w) => [w.name.length, (w.description || '').length]));
    check('limit is honoured and count reports the total', b.results.length === 5 && b.count === 100 && b.limit === 5, { n: b.results.length, count: b.count });
    const page2 = await search(L, 'domain=' + encodeURIComponent(bulky.host) + '&limit=5&offset=5');
    check('offset pages through the results', page2.results.length === 5 && page2.results[0].worldId !== b.results[0].worldId && page2.offset === 5);
    check('limit is capped', (await search(L, 'limit=100000')).limit === 100);
    const tied = track(await manifestServer((host) => ({
      spec: 'domain-atlas/1.0', domain: host,
      worlds: Array.from({ length: 40 }, (_, i) => world('t' + String(i).padStart(2, '0'), { name: 'Same name' }))
    })));
    await submit(L, tied.url);
    const tiedAll = (await search(L, 'domain=' + encodeURIComponent(tied.host) + '&limit=100')).results.map((w) => w.worldId);
    const tiedPaged = [];
    for (let off = 0; off < 40; off += 7) tiedPaged.push(...(await search(L, 'domain=' + encodeURIComponent(tied.host) + '&limit=7&offset=' + off)).results.map((w) => w.worldId));
    check('worlds that tie on name and rank come back in one fixed order, the same on every page', tiedAll.length === 40 && tiedAll.join() === [...tiedAll].sort().join() && tiedPaged.join() === tiedAll.join(), { first: tiedAll.slice(0, 5), paged: tiedPaged.slice(0, 5) });

    console.log('--- public mode: addresses a directory must never contact ---');
    const refused = [
      'https://localhost/.well-known/spatial.json', 'https://foo.localhost/.well-known/spatial.json',
      'https://127.0.0.1/.well-known/spatial.json', 'https://10.0.0.5/.well-known/spatial.json', 'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data/', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://100.64.0.1/x',
      'https://intranet/.well-known/spatial.json', 'https://example.com:8443/.well-known/spatial.json',
      'https://user:secret@example.com/.well-known/spatial.json', 'http://example.com/.well-known/spatial.json',
      'http://' + good.host + WELL_KNOWN, 'https://example.com/x#frag', 'javascript:alert(1)'
    ];
    for (const url of refused) {
      r = await submit(publicMode.base, url);
      check('refused before any request is made: ' + url, r.status === 400, r);
    }
    check('...and nothing was tracked', (await stats(publicMode.base)).manifestsTracked === 0);

    console.log('--- the address rules themselves ---');
    const table = [
      ['8.8.8.8', true], ['1.1.1.1', true], ['93.184.216.34', true], ['2606:4700:4700::1111', true],
      ['0.0.0.0', false], ['10.1.2.3', false], ['100.64.0.1', false], ['127.0.0.1', false], ['169.254.169.254', false],
      ['172.16.0.1', false], ['172.31.255.255', false], ['172.32.0.1', true], ['192.168.0.1', false], ['198.18.0.1', false],
      ['224.0.0.1', false], ['255.255.255.255', false], ['::1', false], ['::', false], ['fc00::1', false], ['fe80::1', false],
      ['::ffff:10.0.0.1', false], ['::ffff:8.8.8.8', true], ['2001:db8::1', false], ['64:ff9b::1', false], ['ff02::1', false]
    ];
    let actual;
    if (IMPL === 'php') {
      const code = 'require ' + JSON.stringify(path.resolve(__dirname, '..', 'directory-php', 'atlas', 'directory', 'lib', 'fetch.php')) + ';'
        + 'echo json_encode(array_map(function ($ip) { return dir_is_public_address($ip); }, json_decode(' + JSON.stringify(JSON.stringify(table.map((t) => t[0]))) + ')));';
      actual = JSON.parse(spawnSync('php', ['-r', 'function dir_config(){return [];}' + code], { encoding: 'utf8' }).stdout);
    } else {
      const { isPublicAddress } = require('../directory-server/server.js');
      actual = table.map((t) => isPublicAddress(t[0]));
    }
    const wrong = table.filter((t, i) => actual[i] !== t[1]).map((t) => t[0]);
    check('every address in the table is classified correctly', wrong.length === 0, wrong);

    console.log('--- flooding /submit ---');
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push((await submit(rateLimited.base, good.url)).status);
    check('submissions beyond the hourly limit are answered 429', outcomes.slice(0, 3).every((s) => s === 200) && outcomes.slice(3).every((s) => s === 429), outcomes);

    console.log('--- growing the index without bound ---');
    const first = track(await manifestServer((host) => ({ spec: 'domain-atlas/1.0', domain: host, worlds: [world('a')] })));
    const second = track(await manifestServer((host) => ({ spec: 'domain-atlas/1.0', domain: host, worlds: [world('b')] })));
    r = await submit(capped.base, first.url);
    check('the first manifest fits', r.status === 200, r);
    r = await submit(capped.base, second.url);
    check('a new manifest beyond the cap is refused with a 503', r.status === 503, r);
    r = await submit(capped.base, first.url);
    check('re-submitting one already tracked still works', r.status === 200, r);

    console.log('--- a site the operator does not want listed ---');
    const blockedSite = track(await manifestServer((host) => ({ spec: 'domain-atlas/1.0', domain: host, worlds: [world('b')] })));
    const blockHost = blockedSite.host;
    const blockingBlocked = await startDirectory({ port: 8206, env: { DIRECTORY_ALLOW_LOCAL: '1', DIRECTORY_BLOCKED: 'someone.else, ' + blockHost.toUpperCase() } });
    try {
      r = await submit(blockingBlocked.base, blockedSite.url);
      check('a blocked site is refused', r.status === 422 && /does not list/.test(r.json.error), r);
      check('...and nothing of it is indexed', (await search(blockingBlocked.base, 'domain=' + encodeURIComponent(blockHost))).count === 0);
    } finally { blockingBlocked.stop(); }
  } finally {
    [local, publicMode, rateLimited, blocking, capped].forEach((d) => d.stop());
    servers.forEach((s) => s.close());
  }
  console.log(failures === 0 ? '\nALL DIRECTORY SECURITY CHECKS PASSED (' + IMPL + ')' : '\n' + failures + ' CHECK(S) FAILED (' + IMPL + ')');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FAILURE:', err); process.exit(1); });
