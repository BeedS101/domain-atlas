#!/usr/bin/env node
// Read-only check of a deployed domain against site-shared/demos.json: every page the domain runs answers, the pages it does not run are
// absent, and every backend route those pages call exists. Only GET requests are sent and nothing is created, minted or spent.
//
//   node tools/check-demo-deployment.js evtec.co.za
//   node tools/check-demo-deployment.js domain-atlas.co.za
//   node tools/check-demo-deployment.js http://127.0.0.1:8080 --site demo-domain-b      (a local or test copy)
//
// A POST-only route answers a GET with 405; a route that needs a parameter answers 400 or a JSON 404. An HTML 404 means the route is
// not deployed. The domain is matched to a site in demos.json by host name; --site names it when the address is not one of them.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'site-shared', 'demos.json'), 'utf8'));
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--') && a !== args[args.indexOf('--site') + 1]);
if (!target) { console.log('usage: node tools/check-demo-deployment.js <host or base url> [--site demo-domain-a|demo-domain-b]'); process.exit(2); }
const base = /^https?:\/\//.test(target) ? target.replace(/\/$/, '') : 'https://' + target;
const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
const site = siteArg || Object.keys(cfg.sites).find((s) => cfg.sites[s].host === new URL(base).host);
if (!site || !cfg.sites[site]) { console.log('cannot tell which site this is; pass --site demo-domain-a or demo-domain-b'); process.exit(2); }

// "atlas/demo/reserve/*" is every route file under that folder in issuer-php; "atlas/asset/issue" is one route.
function routes(entry) {
  if (!entry.endsWith('/*')) return ['/' + entry];
  const dir = entry.slice(0, -2), out = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(ROOT, 'issuer-php', rel), { withFileTypes: true })) {
      if (e.isDirectory()) { if (!/^(inc|tools)$/.test(e.name)) walk(rel + '/' + e.name); continue; }
      if (!e.name.endsWith('.php')) continue;
      out.push(e.name === 'index.php' ? '/' + rel + '/' : '/' + rel + '/' + e.name.replace(/\.php$/, ''));
    }
  })(dir);
  return out;
}

const get = async (p) => { try { const r = await fetch(base + p, { redirect: 'manual', headers: { 'User-Agent': 'domain-atlas-deployment-check/1' } }); await r.arrayBuffer().catch(() => null); return { status: r.status, type: r.headers.get('content-type') || '' }; } catch (e) { return { status: 0, type: '', error: e.message }; } };
let bad = 0;
const report = (ok, text, detail) => { if (!ok) bad++; console.log((ok ? 'ok   ' : 'FAIL ') + text + (!ok && detail ? '  (' + detail + ')' : '')); };

(async () => {
  console.log('Checking ' + base + ' as ' + site + ' (' + cfg.sites[site].host + ')\n');
  const mine = cfg.demos.filter((d) => (d.runsOn || Object.keys(cfg.sites)).includes(site));
  const away = cfg.demos.filter((d) => !mine.includes(d));
  const home = await get('/');
  report(home.status === 200, 'home page answers', home.status);
  for (const d of mine) { const r = await get('/' + d.file); report(r.status === 200, '/' + d.file, r.error || r.status); }
  for (const d of away) { const r = await get('/' + d.file); report(r.status === 404 || r.status === 403, '/' + d.file + ' is not served here, it runs on ' + cfg.sites[(d.runsOn)[0]].host, r.status); }
  const seen = new Set();
  for (const d of mine) for (const entry of d.backend) for (const route of routes(entry)) {
    if (seen.has(route)) continue; seen.add(route);
    const r = await get(route);
    const present = r.status !== 0 && (r.status !== 404 || /json/.test(r.type)) && r.status < 500;
    report(present, 'route ' + route + ' is deployed (' + r.status + ')', r.error || ('HTTP ' + r.status));
  }
  console.log('\n' + (bad === 0 ? 'ALL CHECKS PASSED' : bad + ' CHECK(S) FAILED') + ' (' + (mine.length + away.length + seen.size + 1) + ' read-only requests)');
  process.exit(bad === 0 ? 0 : 1);
})();
