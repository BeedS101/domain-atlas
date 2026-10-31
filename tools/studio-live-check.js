#!/usr/bin/env node
// Probes a deployed Asset Studio over HTTP. Read-only: it never mints and never changes issuer state.
//
//   node tools/studio-live-check.js https://example.com
//
// Checks: the Studio page and its files; the status endpoint (reports whether minting is on, and a switched-off
// state is not a failure); the stateless design validator; the approved model files; that the private helper
// files are not web-readable; and that the domain manifest lets the Studio page use the wallet bridge.
// Exit code 0 when every check passes, 1 otherwise.
'use strict';
const https = require('https');
const http = require('http');

const base = (process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
if (!base) {
  console.error('usage: node tools/studio-live-check.js <base url, e.g. https://example.com>');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
};
const note = (text) => console.log('NOTE ' + text);

// Does not follow redirects: a redirect on these paths would itself be a finding.
function request(method, path, body) {
  return new Promise((resolve) => {
    const url = new URL(base + path);
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = mod.request(url, { method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch (e) { return null; } };

(async () => {
  // 1. Page and static files.
  const page = await request('GET', '/atlas/studio/index.html');
  check('Studio page loads', page.status === 200 && /Asset Studio/.test(page.body.toString('utf8')), 'HTTP ' + page.status + (page.error ? ' ' + page.error : ''));
  check('Studio page carries the Terms link and footer', /href="\/terms\/"/.test(page.body.toString('utf8')) && /Experimental Platform/.test(page.body.toString('utf8')));
  for (const f of ['studio.js', 'studio.css']) {
    const r = await request('GET', '/atlas/studio/' + f);
    check(f + ' loads', r.status === 200 && r.body.length > 100, 'HTTP ' + r.status);
  }

  // 2. Status and validator (both stateless).
  const status = await request('GET', '/atlas/studio/api.php?op=status');
  const s = json(status);
  check('status endpoint answers', status.status === 200 && s && s.ok === true && typeof s.mintEnabled === 'boolean', 'HTTP ' + status.status + ' ' + status.body.toString('utf8').slice(0, 120));
  if (s && s.ok) note('minting is ' + (s.mintEnabled ? 'ENABLED' : 'off') + ' on this site');
  const design = { schema: 'atlas.asset-studio.design/0.1', template: 'trophy', name: 'Deployment check', description: 'Validator probe, nothing is minted.', finish: 'gold' };
  const v = await request('POST', '/atlas/studio/api.php?op=validate', design);
  const vj = json(v);
  check('design validator works', v.status === 200 && vj && vj.ok === true && /^[0-9a-f]{64}$/.test(String(vj.designDigest || '')), 'HTTP ' + v.status);
  const bad = await request('POST', '/atlas/studio/api.php?op=validate', Object.assign({}, design, { template: 'sword' }));
  check('validator rejects an unknown template', bad.status === 400);
  const unknown = await request('GET', '/atlas/studio/api.php?op=nonsense');
  check('unknown operation is refused', unknown.status === 404);

  // 3. Studio's own models (assets/studio/). The site's other models in assets/ are not Studio's and are not checked.
  for (const [name, magic] of [['trophy.glb', 'glTF'], ['badge.glb', 'glTF'], ['key.glb', 'glTF'], ['trophy.png', '\x89PNG'], ['badge.png', '\x89PNG'], ['key.png', '\x89PNG']]) {
    const r = await request('GET', '/assets/studio/' + name);
    check('/assets/studio/' + name, r.status === 200 && r.body.length > 16 && r.body.subarray(0, magic.length).toString('latin1') === magic, 'HTTP ' + r.status + ', ' + r.body.length + ' bytes');
  }

  // 4. Private files must not be readable over the web.
  const hidden = [
    '/atlas/studio/inc/storage.php', '/atlas/studio/inc/studio-mint.php', '/atlas/studio/inc/storage-root.php',
    '/studio-config.json', '/atlas/studio/studio-config.json', '/lib/store.php', '/lib/bootstrap.php', '/lib/replacement.php',
  ];
  for (const p of hidden) {
    const r = await request('GET', p);
    const body = r.body.toString('utf8');
    const leaked = r.status === 200 && (/<\?php|"mintEnabled"|\/home\//m.test(body));
    // A PHP file that runs and prints nothing (storage-root.php) is as good as a refusal.
    check('not readable: ' + p, !leaked && (r.status !== 200 || r.body.length === 0), 'HTTP ' + r.status + (r.status === 200 ? ' (empty)' : ''));
  }

  // 5. Manifest lets the Studio page use the wallet bridge.
  const man = await request('GET', '/.well-known/spatial.json');
  const m = json(man);
  check('domain manifest loads', man.status === 200 && m && Array.isArray(m.worlds), 'HTTP ' + man.status);
  if (m && Array.isArray(m.worlds)) {
    const world = m.worlds.find((w) => w && w.id === 'studio');
    const wb = world && world.policy && world.policy.walletBridge;
    check('manifest has the "studio" policy world', !!world);
    check('studio world allows read, the mint signature purpose and the collectible offer',
      !!wb && wb.read === true && Array.isArray(wb.sign) && wb.sign.includes('atlas.studio.mint/1') && Array.isArray(wb.offer) && wb.offer.includes('atlas.demo.studio.collectible'));
    check('studio world has no entry (policy-only, never an enterable space)', !!world && !world.entry);
    note('manifest domain: ' + m.domain);
  }

  // 6. The issuer publishes its signing key (the wallet verifies claimed credentials against it).
  const key = await request('GET', '/.well-known/atlas-key.json');
  const kj = json(key);
  check('issuer key is published', key.status === 200 && kj && typeof kj === 'object', 'HTTP ' + key.status);

  // 7. Existing issuer routes still answer.
  const catalog = await request('GET', '/atlas/trade/catalog');
  check('trade catalog answers', catalog.status === 200 && json(catalog) !== null, 'HTTP ' + catalog.status);

  console.log(failures === 0 ? '\nAll checks passed.' : '\n' + failures + ' check(s) failed.');
  process.exit(failures === 0 ? 0 : 1);
})();
