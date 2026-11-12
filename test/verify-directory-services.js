// The directory as a directory of the whole network, not just of worlds: a manifest's top-level service declarations
// (postOffice, mailRelay, chat, assetStudio, chainLabs, ... as `true` or { enabled, url }) are indexed next to its
// discoverable worlds, and search?groupBy=site reports both, with counts that stay right across pages.
//
// Part 1 runs the table of cases in test/support/directory-service-vectors.json through the Node reader (the PHP one runs the
// same table in test/verify-directory-services.php) and checks that both implementations list the same services.
// Part 2 starts a throw-away directory (Node by default, DIRECTORY_IMPL=php for the PHP one) and its own small manifest servers
// on 127.0.0.1, so no real domain is contacted and nothing outside this machine is fetched.
//
//   node test/verify-directory-services.js
//   DIRECTORY_IMPL=php node test/verify-directory-services.js
'use strict';
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { webcrypto } = require('crypto');
const { startDirectory } = require('./support/directory-harness');
const { canonicalize, SERVICE_TYPES, SERVICE_CATEGORIES, readServices, safeServiceUrl } = require('../directory-server/server.js');
const vectors = require('./support/directory-service-vectors.json');

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log('PASS ' + label);
  else { failures++; console.log('FAIL ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const caps = (combat) => ({ building: 'none', vehicles: false, combat, landOwnership: false });
const world = (id, genre, scale, combat, over = {}) => ({
  id, name: id, entry: { scene: '/s/' + id + '.json', renderer: ['procedural-v1'] },
  policy: { guestAccess: 'open', discoverable: true, itemDropsAllowed: false, trustedIssuers: 'any' },
  profile: { genre, scale, capabilities: caps(combat) }, portals: [], ...over
});
// A manifest server whose answer can be changed, and made to fail, while the test runs.
function serve(build) {
  return new Promise((resolve) => {
    const site = { build, broken: false, hits: 0 };
    site.server = http.createServer((req, res) => {
      site.hits++;
      if (site.broken) { res.writeHead(500); return res.end('nope'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(site.build(site.host)));
    });
    site.server.listen(0, '127.0.0.1', () => {
      site.host = '127.0.0.1:' + site.server.address().port;
      site.url = 'http://' + site.host + '/.well-known/spatial.json';
      resolve(site);
    });
  });
}

(async () => {
  console.log('--- part 1: reading declarations and addresses (Node) ---');
  for (const c of vectors.urlCases) {
    const got = safeServiceUrl(c.url, c.anchorType, c.anchorKey);
    check(c.note + ' (' + JSON.stringify(c.url).slice(0, 50) + ')', got === c.expect, { got, want: c.expect });
  }
  for (const c of vectors.declarationCases) {
    const got = readServices(c.manifest, c.anchorType, c.anchorKey);
    check(c.note, JSON.stringify(got) === JSON.stringify(c.expect), { got, want: c.expect });
  }
  const php = spawnSync('php', [path.join(__dirname, 'verify-directory-services.php'), 'registry'], { encoding: 'utf8' });
  if (php.status === 0) {
    const theirs = JSON.parse(php.stdout);
    const mine = { types: SERVICE_TYPES.map((t) => ({ key: t.key, label: t.label, category: t.category, ...(t.aliases ? { aliases: t.aliases } : {}) })), categories: SERVICE_CATEGORIES };
    check('the Node and PHP directories list the same services, labels, categories and aliases, in the same order', JSON.stringify(theirs) === JSON.stringify(mine), { node: mine, php: theirs });
  } else console.log('SKIP comparing with the PHP service list: php is not available here');

  console.log('--- part 2: indexing, search and crawling ---');
  const dir = await startDirectory({ port: 8096, env: { DIRECTORY_ALLOW_LOCAL: '1', DIRECTORY_SUBMITS_PER_HOUR: '1000' } });
  const probe = await serve(() => ({}));
  const servers = [probe];
  const submit = async (site) => {
    const r = await fetch(dir.base + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: site.url }) });
    return { status: r.status, ...(await r.json()) };
  };
  const sites = async (qs = '') => (await fetch(dir.base + '/search?groupBy=site&limit=100' + qs)).json();
  const byDomain = (res) => Object.fromEntries(res.groups.map((g) => [g.domain || 'key', g]));
  const labels = (g) => g.services.map((s) => s.label);
  const summary = (res) => `${res.count} sites, ${res.worldCount} worlds, ${res.serviceCount} services`;
  try {
    // A: worlds only, as every manifest was before services existed.
    const A = await serve((h) => ({ spec: 'domain-atlas/1.0', domain: h, owner: { name: 'World Makers' }, worlds: [world('a1', 'marketplace', 'room', 'none'), world('a2', 'arena', 'district', 'pvp')] }));
    // B: a Post Office and a mail relay and nothing else: no worlds, and no fake world either.
    const B = await serve((h) => ({ spec: 'domain-atlas/1.0', domain: h, owner: { name: 'Mail House' }, postOffice: true, mailRelay: true, worlds: [] }));
    // C: object-style declarations, one under an alias, with addresses a directory must not link (it is on an IP address,
    // so it has no web address of its own). The probe server counts any request for the "service" addresses.
    const C = await serve((h) => ({ spec: 'domain-atlas/1.0', domain: h, assetStudio: { enabled: true, url: `https://${h}/atlas/studio/` }, trading: { enabled: true, url: `http://127.0.0.1:${probe.server.address().port}/market` },
      directory: { enabled: true, url: `https://127.0.0.1:${probe.server.address().port}/dir` }, worlds: [] }));
    // D: worlds and services together.
    const D = await serve((h) => ({ spec: 'domain-atlas/1.0', domain: h, owner: { name: 'Everything Inc' }, postOffice: true, chainlabs: { enabled: true }, scanner: true, calendar: true, worlds: [world('d1', 'marketplace', 'room', 'none'), world('d2', 'museum', 'building', 'none')] }));
    // E: nothing public at all: a world that is not discoverable and no services.
    const E = await serve((h) => ({ spec: 'domain-atlas/1.0', domain: h, worlds: [world('e1', 'secret', 'room', 'none', { policy: { guestAccess: 'open', discoverable: false, itemDropsAllowed: false, trustedIssuers: 'any' } })] }));
    // G: services declared and switched off, and one world.
    const G = await serve((h) => ({ spec: 'domain-atlas/1.0', domain: h, postOffice: false, chat: { enabled: false }, mailRelay: { enabled: 'true' }, worlds: [world('g1', 'garden', 'building', 'none')] }));
    servers.push(A, B, C, D, E, G);

    console.log('--- submitting ---');
    const sa = await submit(A), sb = await submit(B), sc = await submit(C), sd = await submit(D), se = await submit(E), sg = await submit(G);
    check('a world-only manifest is accepted as before', sa.status === 200 && sa.indexed === 2 && sa.services === 0, sa);
    check('a service-only manifest with "worlds": [] is accepted, with no world indexed', sb.status === 200 && sb.indexed === 0 && sb.services === 2, sb);
    check('object-style and aliased declarations are accepted', sc.status === 200 && sc.indexed === 0 && sc.services === 3, sc);
    check('a mixed manifest indexes both', sd.status === 200 && sd.indexed === 2 && sd.services === 4, sd);
    check('a manifest with nothing public is accepted but shows nothing', se.status === 200 && se.indexed === 0 && se.services === 0, se);
    check('services that are switched off are not advertised', sg.status === 200 && sg.indexed === 1 && sg.services === 0, sg);

    console.log('--- what the directory page asks for: sites with worlds and services ---');
    let all = await sites();
    let g = byDomain(all);
    check('every site with a world or a service is there, and the empty one is not', all.count === 5 && !g[E.host] && [A, B, C, D, G].every((s) => g[s.host]), summary(all) + ' ' + Object.keys(g));
    check('the totals count worlds and services separately', all.worldCount === 5 && all.serviceCount === 9, summary(all));
    check('a world-only site shows its worlds and no services', g[A.host].worldCount === 2 && g[A.host].serviceCount === 0 && g[A.host].services.length === 0 && g[A.host].worlds.length === 2);
    check('a service-only site shows 0 worlds and its services, with human-friendly names and categories', g[B.host].worldCount === 0 && g[B.host].worlds.length === 0 && JSON.stringify(g[B.host].services) === JSON.stringify([{ key: 'postOffice', label: 'Post Office', category: 'communication', url: null }, { key: 'mailRelay', label: 'Mail Relay', category: 'communication', url: null }]), g[B.host]);
    check('a mixed site shows both, services in the registry order', g[D.host].worldCount === 2 && labels(g[D.host]).join() === 'Post Office,Chain Labs,Scanner,Calendar', labels(g[D.host]));
    check('services declared under their alias are listed under the main name', labels(g[C.host]).join() === 'Asset Studio,Trading station,Directory' && g[C.host].services[1].key === 'tradingStation', g[C.host].services);
    check('disabled services do not appear', g[G.host].serviceCount === 0 && g[G.host].worldCount === 1);
    check('an address that cannot be linked safely is left off, and the service is still listed', g[C.host].services.every((s) => s.url === null), g[C.host].services);
    check('the directory never fetched an address a manifest advertised', probe.hits === 0, probe.hits);
    check('a service-only site has a last-seen time, as every site does', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(g[B.host].lastSeenAt) && Math.abs(Date.now() - Date.parse(g[B.host].lastSeenAt)) < 60000, g[B.host].lastSeenAt);
    check('the owner of a service-only site is shown', g[B.host].ownerName === 'Mail House');
    const stats = await (await fetch(dir.base + '/stats')).json();
    check('the stats count the services', stats.servicesIndexed === 9 && stats.worldsIndexed === 5, stats);

    console.log('--- flat world search is unchanged ---');
    const flat = await (await fetch(dir.base + '/search?limit=100')).json();
    check('the flat list is worlds only, with the same fields', flat.count === 5 && flat.results.length === 5 && flat.results.every((r) => r.worldId && !('services' in r)) && !('groups' in flat), { count: flat.count, keys: Object.keys(flat) });
    const flatService = await (await fetch(dir.base + '/search?limit=100&category=communication')).json();
    check('...and ignores a category', flatService.count === 5);
    const flatDomain = await (await fetch(dir.base + '/search?domain=' + encodeURIComponent(B.host))).json();
    check('a site with services and no worlds has nothing in the flat list', flatDomain.count === 0);

    console.log('--- browsing by functionality ---');
    const cat = async (c, extra = '') => sites('&category=' + c + extra);
    let r = await cat('communication');
    check('communication: the two sites that advertise it, only their communication services', r.count === 2 && r.worldCount === 0 && r.serviceCount === 3 && r.groups.every((x) => x.worldCount === 0 && x.services.every((s) => s.category === 'communication')), summary(r));
    r = await cat('assets');
    check('assets', r.count === 1 && r.serviceCount === 1 && labels(r.groups[0]).join() === 'Asset Studio', summary(r));
    r = await cat('ledger');
    check('ledger / Chain Labs', r.count === 1 && r.serviceCount === 2 && labels(r.groups[0]).join() === 'Chain Labs,Scanner' && r.groups[0].domain === D.host, summary(r));
    r = await cat('trading');
    check('trading', r.count === 1 && labels(r.groups[0]).join() === 'Trading station', summary(r));
    r = await cat('directory');
    check('directories', r.count === 1 && labels(r.groups[0]).join() === 'Directory', summary(r));
    r = await cat('other');
    check('other services', r.count === 1 && labels(r.groups[0]).join() === 'Calendar', summary(r));
    r = await cat('worlds');
    check('worlds: the sites with worlds, no services', r.count === 3 && r.worldCount === 5 && r.serviceCount === 0 && r.groups.every((x) => x.serviceCount === 0 && x.worldCount > 0), summary(r));
    r = await cat('all');
    check('all', r.count === 5 && r.worldCount === 5 && r.serviceCount === 9, summary(r));
    r = await cat('no-such-category');
    check('an unknown category is the same as all', r.count === 5 && r.serviceCount === 9, summary(r));

    console.log('--- search and world filters with services ---');
    r = await sites('&scale=room');
    check('a world filter narrows to the sites with such worlds, and leaves services out', r.count === 2 && r.worldCount === 2 && r.serviceCount === 0, summary(r));
    r = await cat('communication', '&scale=room');
    check('...but is ignored when browsing a kind of service', r.count === 2 && r.serviceCount === 3, summary(r));
    r = await cat('worlds', '&scale=room');
    check('...and applies when browsing worlds', r.count === 2 && r.worldCount === 2, summary(r));
    r = await sites('&combat=pvp');
    check('combat=pvp finds the one arena world and no services', r.count === 1 && r.worldCount === 1 && r.serviceCount === 0 && r.groups[0].domain === A.host, summary(r));
    r = await sites('&q=relay');
    check('a search for a service name finds the sites that advertise it', r.count === 1 && r.groups[0].domain === B.host && labels(r.groups[0]).join() === 'Mail Relay' && r.worldCount === 0, summary(r));
    r = await sites('&q=' + encodeURIComponent('post office'));
    check('...by its human name, not just the manifest field name', r.count === 2 && r.serviceCount === 2 && r.groups.every((x) => labels(x).join() === 'Post Office'), summary(r));
    r = await sites('&q=marketplace');
    check('a search for a world still finds worlds', r.worldCount === 2 && r.groups.length === 2, summary(r));
    r = await sites('&domain=' + encodeURIComponent(B.host));
    check('the domain filter finds one site and its services', r.count === 1 && r.serviceCount === 2 && r.groups[0].domain === B.host, summary(r));

    console.log('--- counts across pages ---');
    const pages = [];
    for (let offset = 0; offset < 5; offset += 2) pages.push(await (await fetch(dir.base + '/search?groupBy=site&limit=2&offset=' + offset)).json());
    check('every page reports the totals for all pages', pages.every((p) => p.count === 5 && p.worldCount === 5 && p.serviceCount === 9), pages.map(summary));
    const seen = pages.flatMap((p) => p.groups.map((x) => x.domain));
    check('the pages together hold every site once', pages.map((p) => p.groups.length).join() === '2,2,1' && new Set(seen).size === 5, seen);
    check('and the per-site counts add up to the totals', pages.flatMap((p) => p.groups).reduce((n, x) => n + x.worldCount, 0) === 5 && pages.flatMap((p) => p.groups).reduce((n, x) => n + x.serviceCount, 0) === 9);
    const again = await (await fetch(dir.base + '/search?groupBy=site&limit=2&offset=2')).json();
    check('the order is the same every time', JSON.stringify(again.groups.map((x) => x.domain)) === JSON.stringify(pages[1].groups.map((x) => x.domain)));

    console.log('--- a key-anchored manifest ---');
    const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const identityKey = b64url(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
    const sign = async (extra) => {
      const unsigned = { spec: 'domain-atlas/1.0', identityKey, owner: { name: 'Key Keeper' }, postOffice: true, assetStudio: { enabled: true, url: 'https://studio.example.com/' }, worlds: [], updated: new Date().toISOString(), ...extra };
      return { ...unsigned, signature: b64url(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, new TextEncoder().encode(canonicalize(unsigned)))) };
    };
    const K = await serve(() => K.manifest);
    K.manifest = await sign({});
    servers.push(K);
    const sk = await submit(K);
    check('a signed key-anchored manifest with services and no worlds is accepted', sk.status === 200 && sk.indexed === 0 && sk.services === 2, sk);
    all = await sites();
    const kg = all.groups.find((x) => x.identityKey === identityKey);
    check('it is listed under its verified key, with no domain and no website invented', kg && kg.anchorType === 'key' && kg.domain === null && kg.worldCount === 0 && labels(kg).join() === 'Post Office,Asset Studio' && kg.services.every((s) => s.url === null), kg);
    check('and has a last-seen time', kg && /Z$/.test(kg.lastSeenAt));
    const seenKey = kg.lastSeenAt;
    K.manifest = { ...K.manifest, postOffice: false, mailRelay: true };
    const tampered = await submit(K);
    check('a manifest whose signature no longer matches is refused', tampered.status === 422 && /signature/i.test(tampered.error), tampered);
    const kgAfter = (await sites()).groups.find((x) => x.identityKey === identityKey);
    check('...and its last good services and last-seen time stay', labels(kgAfter).join() === 'Post Office,Asset Studio' && kgAfter.lastSeenAt === seenKey, kgAfter);

    console.log('--- changes: switched off and removed services ---');
    await sleep(1100);
    const before = (byDomain(await sites()))[B.host];
    B.build = (h) => ({ spec: 'domain-atlas/1.0', domain: h, owner: { name: 'Mail House' }, postOffice: { enabled: false }, voiceCalling: true, worlds: [] });
    const sb2 = await submit(B);
    g = byDomain(await sites());
    check('resubmitting refreshes the services: one removed, one switched off, one added', sb2.status === 200 && sb2.services === 1 && labels(g[B.host]).join() === 'Voice calling', { sb2, got: labels(g[B.host]) });
    check('the counts follow', (await sites()).serviceCount === 10 && (await sites()).count === 6, summary(await sites()));
    check('a good crawl moves the last-seen time forward', Date.parse(g[B.host].lastSeenAt) > Date.parse(before.lastSeenAt), { before: before.lastSeenAt, after: g[B.host].lastSeenAt });
    D.build = (h) => ({ spec: 'domain-atlas/1.0', domain: h, owner: { name: 'Everything Inc' }, postOffice: true, chainlabs: { enabled: true }, scanner: true, worlds: [world('d1', 'marketplace', 'room', 'none'), world('d2', 'museum', 'building', 'none')] });
    await sleep(4500); // longer than the crawl interval (2 s) and a scheduler tick: nobody resubmits D
    g = byDomain(await sites());
    check('a scheduled crawl removes a service that is no longer advertised', labels(g[D.host]).join() === 'Post Office,Chain Labs,Scanner' && g[D.host].worldCount === 2, labels(g[D.host]));
    // A site that stops advertising everything and has no worlds disappears from the list, as a site with nothing public.
    B.build = (h) => ({ spec: 'domain-atlas/1.0', domain: h, worlds: [] });
    await submit(B);
    g = byDomain(await sites());
    check('a site that advertises nothing and has no worlds is no longer listed', !g[B.host] && (await sites()).count === 5 && (await sites()).serviceCount === 8, summary(await sites()));
    B.build = (h) => ({ spec: 'domain-atlas/1.0', domain: h, owner: { name: 'Mail House' }, postOffice: true, mailRelay: true, worlds: [] });
    await submit(B);

    console.log('--- a failed crawl changes nothing ---');
    g = byDomain(await sites());
    const good = { services: labels(g[B.host]), seen: g[B.host].lastSeenAt, worlds: g[D.host].worldCount, dServices: labels(g[D.host]) };
    await sleep(1100);
    B.broken = true;
    D.broken = true;
    const failed = await submit(B);
    check('a manifest that cannot be fetched is reported as failed', failed.status === 422, failed);
    await submit(B);
    await submit(B);
    await sleep(2600); // the scheduler also fails against the broken servers
    g = byDomain(await sites());
    check('after repeated failures a service-only site is marked stale, as a world site would be', g[B.host].stale === true, g[B.host].stale);
    check('the last good services stay listed', labels(g[B.host]).join() === good.services.join() && labels(g[D.host]).join() === good.dServices.join() && g[D.host].worldCount === good.worlds, { b: labels(g[B.host]), d: labels(g[D.host]) });
    check('and the last-seen time does not move', g[B.host].lastSeenAt === good.seen, { was: good.seen, now: g[B.host].lastSeenAt });
    B.broken = false;
    D.broken = false;
    await sleep(1100);
    await submit(B);
    g = byDomain(await sites());
    check('after it recovers the time moves forward and it is no longer stale', Date.parse(g[B.host].lastSeenAt) > Date.parse(good.seen) && g[B.host].stale === false, g[B.host]);
    check('Chain Labs and the rest of the data are exactly as before the failure', (await sites()).serviceCount === 10 && (await sites()).worldCount === 5, summary(await sites()));
  } finally {
    servers.forEach((s) => s.server.close());
    dir.stop();
  }
  console.log(failures === 0 ? '\nALL DIRECTORY SERVICE CHECKS PASSED (' + dir.impl + ')' : '\n' + failures + ' DIRECTORY SERVICE CHECK(S) FAILED (' + dir.impl + ')');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILURE:', e); process.exit(1); });
