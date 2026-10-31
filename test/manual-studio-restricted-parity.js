// Studio collectibles are restrictedIssuance: the Node and PHP issuers must refuse every general or
// administrative path that would mint, reissue or patch one. Both backends run isolated, at the HTTP layer.
//   node test/manual-studio-restricted-parity.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { withAdminAuth } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const CLASS = 'atlas.demo.studio.collectible';
const NODE_PORT = 8195, PHP_PORT = 8196;
const NODE_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'restricted-node-'));
const NODE_DOCROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'restricted-docroot-'));
const PHP_BUNDLE = fs.mkdtempSync(path.join(os.tmpdir(), 'restricted-php-'));

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { kp, publicKey: b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))) };
}
async function post(base, route, body) {
  const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json };
}
async function adminPost(base, admin, route, payload) {
  payload = withAdminAuth(payload, base, route);
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, admin.kp.privateKey, new TextEncoder().encode(canonicalize(payload))));
  return post(base, route, { payload, proof: { signerRole: 'raw-ecdsa', publicKey: admin.publicKey, signature: b64url(sig) } });
}
function check(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); console.log('PASS: ' + msg); }

(async () => {
  const procs = [];
  const node = spawn('node', ['issuer-server/server.js'], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(NODE_PORT), ATLAS_DOMAIN: 'localhost:' + NODE_PORT, ATLAS_STATE_DIR: NODE_STATE, ATLAS_DOCROOT: NODE_DOCROOT } });
  procs.push(node);
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('node did not start')), 10000); node.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); res(); } }); });
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), PHP_BUNDLE, { recursive: true });
  const php = spawn('php', ['-S', 'localhost:' + PHP_PORT, 'test-router.php'], { cwd: PHP_BUNDLE, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(php);
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('php did not start')), 5000); php.stderr.on('data', (d) => { if (String(d).includes('started')) { clearTimeout(t); res(); } }); });
  let failed = null;
  try {
    const admin = await genIdentity(), owner = await genIdentity();
    const roster = JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] });
    fs.writeFileSync(path.join(NODE_STATE, 'atlas-admin-keys-store.json'), roster);
    fs.writeFileSync(path.join(PHP_BUNDLE, 'lib', 'atlas-admin-keys-store.json'), roster);
    for (const [name, base, domain] of [['node', 'http://localhost:' + NODE_PORT, 'localhost:' + NODE_PORT], ['php', 'http://localhost:' + PHP_PORT, 'localhost:' + PHP_PORT]]) {
      console.log('--- ' + name);
      const issue = await post(base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: CLASS, quantity: 1 });
      check(issue.status === 403 && issue.json.code === 'studio-authorization-required', name + ': general issue refused');
      const mint = await adminPost(base, admin, '/atlas/asset/mint', { ownerPublicKey: owner.publicKey, assetClass: CLASS });
      check(mint.status === 403, name + ': admin mint refused (' + mint.status + ' ' + JSON.stringify(mint.json) + ')');
      // The restricted-class check runs before the signature check, so an unsigned stand-in is enough to reach it.
      const stand = { credential: 'domain-atlas-asset/1.0', id: 'urn:atlas:asset:00000000-0000-4000-8000-000000000000', quantity: 1, supersedes: null,
        asset: { class: CLASS, name: 'x', fungible: false, tradeScope: 'bound', properties: { note: 'stand-in' } }, owner: { publicKey: owner.publicKey }, issuer: { domain, publicKey: 'x' }, signature: 'x' };
      for (const patch of [{ tradeScope: 'local' }, { properties: { a: 'b' } }]) {
        const r = await adminPost(base, admin, '/atlas/asset/reissue', Object.assign({ credential: stand }, patch));
        check(r.status === 403 && r.json.code === 'studio-authorization-required', name + ': reissue ' + JSON.stringify(patch) + ' refused');
        const c = await adminPost(base, admin, '/atlas/admin/class-patch', Object.assign({ assetClass: CLASS }, patch));
        check(c.status === 403 && c.json.code === 'studio-authorization-required', name + ': class patch ' + JSON.stringify(patch) + ' refused');
      }
      const clear = await adminPost(base, admin, '/atlas/admin/class-patch', { assetClass: CLASS, clear: true });
      // Node's catalog does not list the Studio class at all, so there is never a patch there to clear.
      check(clear.status === 200 || (name === 'node' && clear.status === 400), name + ': clearing a patch is not blocked as a restricted action (' + clear.status + ')');
    }
    console.log('\nAll restricted-class parity checks passed.');
  } catch (e) { failed = e; console.error(String(e && e.stack || e)); }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }
  for (const d of [NODE_STATE, NODE_DOCROOT, PHP_BUNDLE]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
