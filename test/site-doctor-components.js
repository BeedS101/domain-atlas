// Site doctor, component by component: which parts of Domain Atlas are installed on a domain, what is expected of each,
// and the service checks that read the deployment (signing key, private storage, owner proof, mail stores, Chain Labs,
// directory, verifier, presence, call). Served by PHP's built-in server over temporary document roots; nothing here
// contacts a live domain.
//   node test/site-doctor-components.js
'use strict';
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log('ok   ' + name), (e) => { failures++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-doctor-comp-'));
const servers = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const everything = [];
const SECRET = 'SECRET-MARKER-c4e91b';

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const tracked = (dir) => execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean).map((f) => f.slice(dir.length + 1));
function copyTree(srcDir, destRoot, mount) {
  for (const rel of tracked(srcDir)) {
    const dest = path.join(destRoot, mount, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, srcDir, rel), dest);
  }
}

const built = (() => {
  const out = fs.mkdtempSync(path.join(tmp, 'build-'));
  execFileSync('node', [path.join(REPO, 'tools/site-doctor-build.js'), out, '--allow-dirty'], { encoding: 'utf8' });
  const token = (fs.readFileSync(path.join(out, 'ACCESS.txt'), 'utf8').match(/Token:\s+([0-9a-f-]{39})/) || [])[1];
  return { out, php: path.join(out, 'site-doctor.php'), token };
})();
const manifest = (() => { const src = fs.readFileSync(built.php, 'utf8'); return JSON.parse(src.split("<<<'ATLAS_DOCTOR_JSON'\n")[1].split('\nATLAS_DOCTOR_JSON')[0]); })();

// A document root as uploads would produce it. parts: which optional services were uploaded as well.
function deployment(parts) {
  const p = parts || {};
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  copyTree('demo-domain-b', root, '');
  copyTree('issuer-php', root, '');
  fs.mkdirSync(path.join(root, 'assets/studio'), { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO, 'demo-domain-a/assets/studio'))) fs.copyFileSync(path.join(REPO, 'demo-domain-a/assets/studio', f), path.join(root, 'assets/studio', f));
  if (p.chainlabs) copyTree('chain-labs', root, 'chain-labs/');
  if (p.directory) copyTree('directory-php', root, '');
  if (p.verifier) copyTree('verifier-php', root, p.verifier === true ? 'atlas-verify/' : p.verifier + '/');
  if (p.call) copyTree('call-php', root, '');
  if (p.presence) copyTree('presence-php', root, '');
  for (const rel of p.remove || []) fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  if (p.edit) { const f = path.join(root, '.well-known/spatial.json'); const m = JSON.parse(fs.readFileSync(f, 'utf8')); p.edit(m); fs.writeFileSync(f, JSON.stringify(m)); }
  fs.copyFileSync(built.php, path.join(root, 'site-doctor.php'));
  return root;
}
async function serve(root, env) {
  const port = await freePort();
  const child = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root], { stdio: 'ignore', env: Object.assign({}, process.env, env || {}) });
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    if (await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })) break;
    await sleep(50);
  }
  const host = '127.0.0.1:' + port;
  const call = (token) => async (action, extra) => {
    const r = await fetch('http://' + host + '/site-doctor.php', { method: 'POST', body: new URLSearchParams(Object.assign({ action, token }, extra || {})) });
    const text = await r.text();
    everything.push(text);
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: r.status, json, text };
  };
  return { host, stop: () => child.kill(), call: call(built.token), callWith: call };
}
const issues = (r) => r.json.results.map((x) => x[0] + ' ' + x[1]);
const comps = async (s, mods) => Object.fromEntries((await s.call('components', mods ? { mods } : {})).json.components.map((c) => [c.id, c]));
const svc = async (s, mods) => (await s.call('services', mods ? { mods } : {})).json.checks;
const find = (checks, id) => checks.find((c) => c.id === id);
const writeJson = (file, doc) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(doc)); };

function ecPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { pem: privateKey.export({ type: 'sec1', format: 'pem' }), pub: raw.toString('base64url') };
}
const hasExt = (name) => execFileSync('php', ['-m'], { encoding: 'utf8' }).split('\n').map((x) => x.trim().toLowerCase()).includes(name);

(async () => {
  await check('the manifest carries the component registry, and every file belongs to a known component', () => {
    const ids = manifest.components.map((c) => c.id);
    for (const id of ['core', 'site', 'studio', 'postoffice', 'mail', 'trade', 'ledger', 'moderation', 'drops', 'demos', 'call', 'presence', 'directory', 'chainlabs', 'verifier']) assert.ok(ids.includes(id), id);
    const bad = manifest.entries.filter((e) => !ids.includes(e[6]));
    assert.deepStrictEqual(bad.map((e) => e[0]), []);
    const byComp = (id) => manifest.entries.filter((e) => e[6] === id).map((e) => e[0]);
    assert.ok(byComp('chainlabs').length > 30 && byComp('chainlabs').every((p) => p.startsWith('chain-labs/')));
    assert.ok(byComp('verifier').length >= 8 && byComp('verifier').every((p) => p.startsWith('atlas-verify/')));
    assert.ok(byComp('chainlabs').includes('chain-labs/spend34.php') && byComp('chainlabs').includes('chain-labs/lib/ledger.php'));
    assert.ok(byComp('postoffice').every((p) => p.startsWith('atlas/postoffice/')) && byComp('mail').every((p) => p.startsWith('atlas/mail/')));
    assert.ok(byComp('directory').includes('atlas/directory/search.php') && byComp('call').includes('atlas/call/info.php') && byComp('presence').includes('presence/status.php'));
    const optionalFlag = (p) => manifest.entries.find((e) => e[0] === p)[4].includes('o');
    assert.ok(optionalFlag('chain-labs/README.md') && optionalFlag('chain-labs/SOURCE.sha256') && optionalFlag('atlas-verify/README.md'));
    assert.ok(!optionalFlag('chain-labs/spend34.php') && !optionalFlag('atlas-verify/verify.php'));
  });

  await check('a full deployment: every component installed, no file reported', async () => {
    const root = deployment({ chainlabs: true, directory: true, verifier: true, call: true, presence: true });
    const s = await serve(root);
    const c = await comps(s);
    for (const id of ['studio', 'postoffice', 'mail', 'trade', 'ledger', 'moderation', 'drops', 'demos', 'call', 'presence', 'directory', 'chainlabs', 'verifier']) assert.strictEqual(c[id].status, 'installed', id + ' ' + c[id].status);
    assert.strictEqual(c.verifier.mount, 'atlas-verify');
    assert.ok(Object.values(c).every((x) => x.present === x.total), 'all files present');
    const scan = await s.call('scan', { site: 'b' });
    assert.deepStrictEqual(issues(scan), []);
    s.stop();
  });

  await check('a minimal issuer: nothing optional is reported missing and every optional part says not installed', async () => {
    const root = deployment({ remove: ['atlas/studio', 'assets/studio', 'atlas/postoffice', 'atlas/mail', 'atlas/trade', 'atlas/admin/trusted-trade-peers', 'atlas/ledger', 'atlas/moderation', 'atlas/admin/moderation', 'atlas/world', 'atlas/demo', 'atlas/login', 'atlas/attestation', 'txlab'], edit: (m) => { delete m.postOffice; delete m.chat; } });
    const s = await serve(root);
    const c = await comps(s);
    for (const id of ['studio', 'postoffice', 'mail', 'trade', 'ledger', 'moderation', 'drops', 'demos', 'call', 'presence', 'directory', 'chainlabs', 'verifier']) assert.strictEqual(c[id].status, 'not-installed', id + ' ' + c[id].status);
    assert.deepStrictEqual(issues(await s.call('scan', { site: 'none' })), []);
    const extras = (await s.call('extras')).json;
    assert.ok(extras.ok);
    s.stop();
  });

  await check('a component with some of its files is installed, and the rest are reported; Node-only and development files are never expected', async () => {
    const root = deployment({ remove: ['atlas/trade/claim.php', 'atlas/postoffice/relay.php'] });
    const s = await serve(root);
    const found = issues(await s.call('scan', { site: 'none' }));
    assert.deepStrictEqual(found.sort(), ['atlas/postoffice/relay.php missing', 'atlas/trade/claim.php missing']);
    const paths = manifest.entries.map((e) => e[0]);
    assert.ok(!paths.some((p) => /^(issuer-server|extension|test|docs|directory-server|call-server|presence-server)\//.test(p)), 'no Node, extension or development path in the manifest');
    assert.ok(manifest.entries.filter((e) => e[0].startsWith('tools/')).every((e) => e[4].includes('o')), 'command-line helpers are optional');
    s.stop();
  });

  await check('Chain Labs: not installed is silent; installed reports a missing, a changed and an unknown file; optional files may be absent', async () => {
    const none = await serve(deployment());
    assert.strictEqual((await comps(none)).chainlabs.status, 'not-installed');
    assert.deepStrictEqual(issues(await none.call('scan', { site: 'none' })), []);
    none.stop();
    const root = deployment({ chainlabs: true, remove: ['chain-labs/lib/spend.php', 'chain-labs/README.md', 'chain-labs/SOURCE.sha256'] });
    fs.appendFileSync(path.join(root, 'chain-labs/coin26.php'), '\n// edited\n');
    fs.writeFileSync(path.join(root, 'chain-labs/old-lab.php'), '<?php echo 1;');
    const s = await serve(root);
    const found = issues(await s.call('scan', { site: 'none' })).sort();
    assert.deepStrictEqual(found, ['chain-labs/coin26.php differs', 'chain-labs/lib/spend.php missing']);
    const c = await comps(s);
    assert.strictEqual(c.chainlabs.status, 'installed');
    assert.ok(c.chainlabs.present < c.chainlabs.total);
    const ex = (await s.call('extras')).json;
    assert.ok(ex.php.some((x) => x.p === 'chain-labs/old-lab.php'), 'an unknown PHP file in the Chain Labs folder is listed');
    assert.ok(!ex.php.some((x) => /^chain-labs\/(coin26|spend34|lib\/ledger)\.php$/.test(x.p)), 'Chain Labs files are known, not unknown PHP');
    s.stop();
  });

  await check('advertised but not installed is reported; a service run on another host is not; a ticked component is expected', async () => {
    const root = deployment();
    const file = path.join(root, '.well-known/spatial.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.chainLabs = true; m.directory = { enabled: true, url: 'https://elsewhere.example/dir/' }; m.voiceCalling = { enabled: true, url: 'https://calls.example.test/' };
    fs.writeFileSync(file, JSON.stringify(m));
    const s = await serve(root);
    const c = await comps(s);
    assert.strictEqual(c.chainlabs.status, 'advertised-missing');
    assert.deepStrictEqual(c.chainlabs.advertised, ['chainLabs']);
    assert.strictEqual(c.directory.status, 'not-installed');
    assert.strictEqual(c.call.status, 'not-installed');
    assert.ok(issues(await s.call('scan', { site: 'none' })).includes('chain-labs/spend34.php missing'));
    assert.strictEqual((await comps(s, 'v')).verifier.status, 'expected');
    s.stop();
  });

  await check('the verifier is found wherever it was uploaded, and compared there', async () => {
    const root = deployment({ verifier: 'tools/credential-check' });
    fs.rmSync(path.join(root, 'tools/credential-check/lib/atlas-verify-fetch.php'));
    const s = await serve(root);
    const c = await comps(s);
    assert.strictEqual(c.verifier.status, 'installed');
    assert.strictEqual(c.verifier.mount, 'tools/credential-check');
    assert.deepStrictEqual(issues(await s.call('scan', { site: 'none' })), ['tools/credential-check/lib/atlas-verify-fetch.php missing']);
    const checks = await svc(s);
    assert.strictEqual(find(checks, 'vf-config').status, 'warn');
    fs.writeFileSync(path.join(root, 'tools/credential-check/config.php'), "<?php return ['trustedIssuers' => ['https://" + SECRET + ".example']];");
    const ok = find(await svc(s), 'vf-config');
    assert.strictEqual(ok.status, 'ok');
    assert.ok(!JSON.stringify(ok).includes(SECRET), 'the issuer origins in the settings are counted, not shown');
    s.stop();
  });

  await check('the other optional services: directory, call and presence are each found, compared and checked', async () => {
    const root = deployment({ directory: true, call: true, presence: true, remove: ['atlas/directory/stats.php'] });
    const s = await serve(root);
    const found = issues(await s.call('scan', { site: 'none' }));
    assert.deepStrictEqual(found, ['atlas/directory/stats.php missing']);
    const checks = await svc(s);
    assert.strictEqual(find(checks, 'dir-data').status, 'fail', 'no directory data folder yet');
    assert.strictEqual(find(checks, 'call-config').status, 'warn', 'the call service has no settings file yet');
    fs.mkdirSync(path.join(root, 'presence/lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'presence/lib/atlas-presence-store.json'), '{broken');
    assert.strictEqual(find(await svc(s), 'presence-store').status, 'fail');
    fs.writeFileSync(path.join(root, 'presence/lib/atlas-presence-store.json'), '{"rooms":{}}');
    assert.strictEqual(find(await svc(s), 'presence-store').status, 'ok');
    fs.writeFileSync(path.join(root, 'atlas/call/lib/config.php.off'), '<?php return [];');
    assert.strictEqual(find(await svc(s), 'call-config').status, 'info');
    fs.renameSync(path.join(root, 'atlas/call/lib/config.php.off'), path.join(root, 'atlas/call/lib/config.php'));
    assert.strictEqual(find(await svc(s), 'call-config').status, 'ok');
    s.stop();
  });

  await check('the directory data folder: outside the web root and writable passes, inside fails, missing fails', async () => {
    const parent = fs.mkdtempSync(path.join(tmp, 'acct-'));
    const root = path.join(parent, 'public_html');
    fs.cpSync(deployment({ directory: true }), root, { recursive: true });
    const s = await serve(root);
    assert.strictEqual(find(await svc(s), 'dir-data').status, 'fail', 'no data folder yet');
    const data = path.join(parent, 'atlas-directory-private');
    fs.mkdirSync(data, { mode: 0o700 });
    let d = find(await svc(s), 'dir-data');
    assert.strictEqual(d.status, 'info');
    fs.writeFileSync(path.join(data, 'atlas-directory.sqlite'), 'x');
    assert.strictEqual(find(await svc(s), 'dir-data').status, 'ok');
    const old = new Date(Date.now() - 10 * 86400 * 1000);
    fs.utimesSync(path.join(data, 'atlas-directory.sqlite'), old, old);
    d = find(await svc(s), 'dir-data');
    assert.strictEqual(d.status, 'warn');
    assert.ok(/cron/.test(d.detail));
    writeJson(path.join(root, 'atlas/directory/lib/atlas-directory-config.json'), { dataDir: path.join(root, 'inside-data') });
    fs.mkdirSync(path.join(root, 'inside-data'));
    assert.strictEqual(find(await svc(s), 'dir-data').status, 'fail', 'inside the web root');
    writeJson(path.join(root, 'atlas/directory/lib/atlas-directory-config.json'), { dataDir: path.join(parent, 'gone') });
    assert.strictEqual(find(await svc(s), 'dir-data').status, 'fail', 'missing');
    assert.ok(!JSON.stringify(await svc(s)).includes('x'.repeat(0) + SECRET));
    s.stop();
  });

  await check('signing key: the private key is compared with the published key and never shown', async () => {
    const root = deployment();
    const s = await serve(root);
    assert.strictEqual(find(await svc(s), 'key').status, 'info', 'no key yet');
    const a = ecPair();
    fs.writeFileSync(path.join(root, 'lib/issuer-private-key.pem'), a.pem);
    writeJson(path.join(root, '.well-known/atlas-key.json'), { keys: [{ publicKey: a.pub, validFrom: '2020-01-01T00:00:00Z', validUntil: null }] });
    writeJson(path.join(root, '.well-known/atlas-revocations.json'), { revoked: [] });
    writeJson(path.join(root, '.well-known/atlas-suspensions.json'), { suspended: [] });
    let checks = await svc(s);
    assert.strictEqual(find(checks, 'key').status, 'ok');
    assert.strictEqual(find(checks, 'lists').status, 'ok');
    const b = ecPair();
    writeJson(path.join(root, '.well-known/atlas-key.json'), { keys: [{ publicKey: b.pub, validFrom: '2020-01-01T00:00:00Z', validUntil: null }] });
    assert.strictEqual(find(await svc(s), 'key').status, 'fail', 'a published key that is not the private key');
    writeJson(path.join(root, '.well-known/atlas-key.json'), { keys: [{ publicKey: a.pub, validFrom: '2020-01-01T00:00:00Z', validUntil: '2021-01-01T00:00:00Z' }] });
    assert.strictEqual(find(await svc(s), 'key').status, 'fail', 'no key valid now');
    fs.writeFileSync(path.join(root, 'lib/issuer-private-key.pem'), '-----BEGIN EC PRIVATE KEY-----\n' + SECRET + '\n-----END EC PRIVATE KEY-----\n');
    assert.strictEqual(find(await svc(s), 'key').status, 'fail', 'an unreadable private key');
    fs.rmSync(path.join(root, 'lib/issuer-private-key.pem'));
    assert.strictEqual(find(await svc(s), 'key').status, 'fail', 'a published key with no private key');
    fs.rmSync(path.join(root, '.well-known/atlas-revocations.json'));
    writeJson(path.join(root, '.well-known/atlas-key.json'), { keys: [{ publicKey: a.pub, validFrom: '2020-01-01T00:00:00Z', validUntil: null }] });
    assert.strictEqual(find(await svc(s), 'lists').status, 'fail', 'the revocation list is missing');
    s.stop();
  });

  await check('owner proof: accept is a warning, require passes, off and an old upload fail, and the counts are shown without anything private', async () => {
    const root = deployment();
    const cfg = path.join(root, 'lib/atlas-owner-proof-config.json');
    const s = await serve(root);
    let op = find(await svc(s), 'owner-proof');
    assert.strictEqual(op.status, 'warn');
    assert.ok(/accept/.test(op.title) && /temporary/.test(op.title) && /No signed issuance/.test(op.detail), op.title + ' | ' + op.detail);
    writeJson(path.join(root, 'lib/owner-proof/stats.json'), { version: 1, mode: 'accept', classes: { 'atlas.membership': { signed: 3, unsigned: 0, refused: 1, lastSignedAt: new Date().toISOString(), lastUnsignedAt: null, lastRefusedAt: null }, 'evil <class> ': { signed: 99 } }, refusedByCode: {} });
    op = find(await svc(s), 'owner-proof');
    assert.ok(/can be switched to require/.test(op.detail) && /atlas\.membership: 3 signed, 0 unsigned, 1 refused/.test(op.detail) && !/evil/.test(op.detail), op.detail);
    writeJson(path.join(root, 'lib/owner-proof/stats.json'), { version: 1, classes: { 'atlas.postoffice.membership': { signed: 2, unsigned: 1, refused: 0, lastSignedAt: new Date().toISOString(), lastUnsignedAt: new Date().toISOString() } } });
    op = find(await svc(s), 'owner-proof');
    assert.ok(/would turn a wallet away/.test(op.detail), op.detail);
    writeJson(cfg, { mode: 'require' });
    op = find(await svc(s), 'owner-proof');
    assert.strictEqual(op.status, 'ok');
    assert.ok(/enforcing/.test(op.title));
    writeJson(cfg, { mode: 'off' });
    assert.strictEqual(find(await svc(s), 'owner-proof').status, 'fail');
    writeJson(cfg, { mode: 'maybe' });
    op = find(await svc(s), 'owner-proof');
    assert.strictEqual(op.status, 'warn');
    assert.ok(/not off, accept or require/.test(op.title));
    writeJson(cfg, { mode: 'require' });
    const issue = path.join(root, 'atlas/asset/issue.php');
    const original = fs.readFileSync(issue, 'utf8');
    fs.writeFileSync(issue, original.split('atlas_owner_proof_verdict').join('atlas_old_check'));
    op = find(await svc(s), 'owner-proof');
    assert.strictEqual(op.status, 'fail');
    assert.ok(/atlas\/asset\/issue\.php/.test(op.detail));
    fs.writeFileSync(issue, original);
    fs.rmSync(path.join(root, 'lib/owner-proof.php'));
    assert.ok(/lib\/owner-proof\.php/.test(find(await svc(s), 'owner-proof').detail));
    s.stop();
  });

  await check('owner proof: the environment variable wins over the settings file', async () => {
    const root = deployment();
    writeJson(path.join(root, 'lib/atlas-owner-proof-config.json'), { mode: 'off' });
    const s = await serve(root, { ATLAS_OWNER_PROOF: 'require' });
    const op = find(await svc(s), 'owner-proof');
    assert.strictEqual(op.status, 'ok');
    assert.ok(/environment variable/.test(op.detail));
    assert.strictEqual((await s.call('services')).json.opMode, 'require');
    s.stop();
  });

  await check('owner proof: roster and mail counts are shown for before-and-after comparisons, never their contents', async () => {
    const root = deployment();
    writeJson(path.join(root, 'lib/atlas-subscribers-store.json'), { subscribers: [{ credentialId: SECRET }, { credentialId: SECRET + '2' }] });
    writeJson(path.join(root, 'lib/atlas-postoffice-members-store.json'), { members: [{ handle: SECRET }] });
    writeJson(path.join(root, 'lib/atlas-mail-store.json'), { messages: [{ credentialId: SECRET, body: SECRET }, { body: SECRET }, { body: SECRET }] });
    const s = await serve(root);
    const op = find(await svc(s), 'owner-proof');
    assert.ok(/2 subscribers/.test(op.detail) && /1 Global Mail members/.test(op.detail) && /3 stored messages/.test(op.detail), op.detail);
    assert.ok(!JSON.stringify(op).includes(SECRET));
    s.stop();
  });

  await check('private storage: default in lib/ warns; outside the web root passes; inside, missing or unwritable are named; pending journal entries are counted', async () => {
    const parent = fs.mkdtempSync(path.join(tmp, 'acct-'));
    const root = path.join(parent, 'public_html');
    fs.cpSync(deployment(), root, { recursive: true });
    const s = await serve(root);
    assert.strictEqual(find(await svc(s), 'private-location').status, 'warn');
    const priv = path.join(parent, 'atlas-private');
    for (const d of ['replay', 'holdings', 'txn', 'mint-allowance', 'owner-proof']) fs.mkdirSync(path.join(priv, d), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'lib/atlas-private-dir.txt'), priv + '\n');
    let checks = await svc(s);
    assert.strictEqual(find(checks, 'private-location').status, 'ok');
    for (const d of ['replay', 'holdings', 'txn', 'mint-allowance', 'owner-proof']) assert.strictEqual(find(checks, 'dir-' + d).status, 'ok', d);
    fs.writeFileSync(path.join(priv, 'txn', 'a.json'), '{}');
    assert.strictEqual(find(await svc(s), 'dir-txn').status, 'warn');
    fs.rmSync(path.join(priv, 'txn', 'a.json'));
    fs.writeFileSync(path.join(root, 'lib/atlas-private-dir.txt'), path.join(root, 'lib-private') + '\n');
    fs.mkdirSync(path.join(root, 'lib-private'));
    assert.strictEqual(find(await svc(s), 'private-location').status, 'warn', 'inside the web root');
    fs.writeFileSync(path.join(root, 'lib/atlas-private-dir.txt'), path.join(parent, 'nowhere') + '\n');
    assert.strictEqual(find(await svc(s), 'private-location').status, 'fail', 'missing');
    s.stop();
  });

  await check('component stores: valid with counts, missing is information, damaged fails; only the owning component is looked at', async () => {
    const root = deployment({ remove: ['atlas/trade', 'atlas/admin/trusted-trade-peers'] });
    const s = await serve(root);
    let checks = await svc(s);
    assert.strictEqual(find(checks, 'store-atlas-mail-store.json').status, 'info');
    assert.ok(!find(checks, 'store-atlas-pending-trades-store.json'), 'Trading Station is not installed, so its stores are not looked at');
    writeJson(path.join(root, 'lib/atlas-mail-store.json'), { messages: [1, 2, 3] });
    fs.writeFileSync(path.join(root, 'lib/atlas-subscribers-store.json'), '{ not json');
    checks = await svc(s);
    assert.ok(/3 entries/.test(find(checks, 'store-atlas-mail-store.json').title));
    assert.strictEqual(find(checks, 'store-atlas-subscribers-store.json').status, 'fail');
    assert.ok(!JSON.stringify(checks).includes('not json'));
    s.stop();
  });

  await check('Global Mail without the mail routes (and the reverse) is reported', async () => {
    const root = deployment({ remove: ['atlas/mail'], edit: (m) => { delete m.postOffice; } });
    const s = await serve(root);
    assert.strictEqual(find(await svc(s), 'mail-pair').status, 'fail');
    s.stop();
    const root2 = deployment({ remove: ['atlas/postoffice'], edit: (m) => { delete m.postOffice; } });
    const s2 = await serve(root2);
    assert.strictEqual(find(await svc(s2), 'mail-pair').status, 'warn');
    s2.stop();
  });

  await check('membership cards the manifest asks for must be the ones the wallet issues', async () => {
    const root = deployment();
    const file = path.join(root, '.well-known/spatial.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.postOffice = { enabled: true, requiresCredential: true, credentialClass: 'atlas.membership' };
    m.tradingStation = { enabled: true, requiresCredential: true, credentialClass: 'atlas.tradingstation.membership' };
    fs.writeFileSync(file, JSON.stringify(m));
    const s = await serve(root);
    const checks = await svc(s);
    assert.strictEqual(find(checks, 'class-postOffice').status, 'warn');
    assert.strictEqual(find(checks, 'class-tradingStation').status, 'ok');
    s.stop();
  });

  await check('Chain Labs services: private folder, databases, host list and extensions', async () => {
    const parent = fs.mkdtempSync(path.join(tmp, 'acct-'));
    const root = path.join(parent, 'public_html');
    fs.cpSync(deployment({ chainlabs: true }), root, { recursive: true });
    const s = await serve(root);
    let checks = await svc(s);
    assert.strictEqual(find(checks, 'cl-private').status, 'fail', 'no private folder');
    if (hasExt('openssl') && hasExt('pdo_sqlite')) assert.strictEqual(find(checks, 'cl-ext').status, 'ok');
    const priv = path.join(parent, 'chainblock-labs-private');
    fs.mkdirSync(priv, { mode: 0o700 });
    fs.writeFileSync(path.join(priv, 'coin26.sqlite'), 'x');
    checks = await svc(s);
    assert.strictEqual(find(checks, 'cl-private').status, 'ok');
    assert.ok(/coin26\.sqlite/.test(find(checks, 'cl-private').detail) && /chain34\.sqlite/.test(find(checks, 'cl-private').detail));
    assert.strictEqual(find(checks, 'cl-hosts').status, 'fail', 'the built-in host list does not include this test host');
    writeJson(path.join(priv, 'chainlabs-config.json'), { hosts: ['127.0.0.1', 'other.example.test'] });
    assert.strictEqual(find(await svc(s), 'cl-hosts').status, 'ok');
    writeJson(path.join(priv, 'chainlabs-config.json'), { hosts: ['one.example.test'] });
    assert.strictEqual(find(await svc(s), 'cl-hosts').status, 'fail');
    fs.writeFileSync(path.join(priv, 'chainlabs-config.json'), '{ broken');
    assert.strictEqual(find(await svc(s), 'cl-hosts').status, 'fail');
    fs.chmodSync(priv, 0o777);
    assert.strictEqual(find(await svc(s), 'cl-mode').status, 'fail');
    fs.chmodSync(priv, 0o700);
    fs.writeFileSync(path.join(priv, 'gold-adapter.php'), '<?php // ' + SECRET);
    assert.ok(!JSON.stringify(await svc(s)).includes(SECRET));
    fs.cpSync(path.join(root, 'chain-labs'), path.join(parent, 'unused'), { recursive: true });
    s.stop();
  });

  await check('security: a wrong token is refused for the new actions, an expired doctor refuses them, and none of them writes anything', async () => {
    const root = deployment({ chainlabs: true, directory: true, verifier: true, call: true, presence: true });
    const s = await serve(root);
    for (const action of ['components', 'services']) {
      const r = await s.callWith('0000-0000')(action, {});
      assert.strictEqual(r.status, 403, action);
      assert.deepStrictEqual(r.json, { ok: false, error: 'bad-token' });
    }
    const snapshot = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const st = fs.lstatSync(p); out.push(path.relative(root, p) + ' ' + (st.mode & 0o7777).toString(8) + ' ' + st.size + ' ' + st.mtimeMs); if (e.isDirectory()) walk(p); } }; walk(root); return out.sort().join('\n'); };
    const before = snapshot();
    for (const a of ['env', 'components', 'services', 'services', 'health', 'extras', 'features', 'manifest']) await s.call(a);
    await s.call('scan', { site: 'b', mods: 'slcpdvo' });
    assert.strictEqual(snapshot(), before, 'the doctor changed something on disk');
    s.stop();
    const expiredRoot = deployment();
    fs.writeFileSync(path.join(expiredRoot, 'site-doctor.php'), fs.readFileSync(built.php, 'utf8').replace(/"expires":\d+/, '"expires":1000'));
    const e = await serve(expiredRoot);
    assert.strictEqual((await e.call('components')).status, 410);
    assert.strictEqual((await e.call('services')).status, 410);
    assert.strictEqual((await e.call('delete')).json.deleted, true);
    e.stop();
  });

  await check('no response carried a private key, a message, a credential id or a configuration value', () => {
    const joined = everything.join('\n');
    assert.ok(!joined.includes(SECRET), 'a planted secret reached a response');
    assert.ok(!joined.includes('BEGIN EC PRIVATE KEY'));
    assert.ok(!joined.includes(built.token.replace(/-/g, '')));
  });

  servers.forEach((s) => s.kill());
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? '\n' + failures + ' check(s) failed.' : '\nAll site doctor component checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); servers.forEach((s) => s.kill()); process.exit(1); });
