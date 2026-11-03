// Site doctor: the built single-file checker compares a deployed tree with the repository, reports what is
// missing, different or unexpected, never reads or shows private state, refuses a wrong or expired token, and
// can delete itself. Served by PHP's built-in server over temporary document roots.
//   node test/site-doctor.js
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const BASELINE = process.argv[2] || '5547b10';
let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log('ok   ' + name), (e) => { failures++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-doctor-'));
const servers = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const everything = []; // every response body any test saw, searched for planted secrets at the end

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function copyTree(from, to, files) {
  for (const rel of files) {
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, rel), dest);
  }
}
const tracked = (dir) => execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean).map((f) => f.slice(dir.length + 1));

// A document root as an upload would produce it: a demo site with issuer-php laid over it.
function layout(site) {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  copyTree(path.join(REPO, 'demo-domain-' + site), root, tracked('demo-domain-' + site));
  copyTree(path.join(REPO, 'issuer-php'), root, tracked('issuer-php'));
  return root;
}
function baselineLayout() {
  const src = fs.mkdtempSync(path.join(tmp, 'base-src-'));
  execFileSync('sh', ['-c', 'git archive ' + BASELINE + ' demo-domain-a issuer-php | tar -x -C ' + JSON.stringify(src)], { cwd: REPO });
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)).map((f) => e.name + '/' + f) : [e.name]));
  for (const dir of ['demo-domain-a', 'issuer-php']) copyTree(path.join(src, dir), root, walk(path.join(src, dir)));
  return root;
}

function build(hours) {
  const out = fs.mkdtempSync(path.join(tmp, 'build-'));
  const log = execFileSync('node', [path.join(REPO, 'tools/site-doctor-build.js'), out, '--hours', String(hours || 72), '--allow-dirty'], { encoding: 'utf8' });
  const access = fs.readFileSync(path.join(out, 'ACCESS.txt'), 'utf8');
  const token = (access.match(/Token:\s+([0-9a-f-]{39})/) || [])[1];
  assert.ok(token, 'token in ACCESS.txt');
  return { out, php: path.join(out, 'site-doctor.php'), token, log };
}

async function serve(root) {
  const port = await freePort();
  const child = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root], { stdio: 'ignore' });
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    if (ok) break;
    await sleep(50);
  }
  const base = 'http://127.0.0.1:' + port;
  const doctor = (token) => async (action, extra) => {
    const body = new URLSearchParams(Object.assign({ action, token }, extra || {}));
    const r = await fetch(base + '/site-doctor.php', { method: 'POST', body });
    const text = await r.text();
    everything.push(text);
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: r.status, json, text };
  };
  return { base, host: '127.0.0.1:' + port, call: doctor, stop: () => child.kill() };
}

const issue = (res) => res.json.results.map((r) => r[0] + ' ' + r[1]);

(async () => {
  const built = build(72);
  const template = fs.readFileSync(path.join(REPO, 'tools/site-doctor/site-doctor.template.php'), 'utf8');
  const phpSrc = fs.readFileSync(built.php, 'utf8');
  const manifest = JSON.parse(phpSrc.split("<<<'ATLAS_DOCTOR_JSON'\n")[1].split('\nATLAS_DOCTOR_JSON')[0]);

  await check('manifest: has studio-mint.php, the Studio models and no state-like paths', () => {
    const paths = manifest.entries.map((e) => e[0]);
    for (const p of ['atlas/studio/inc/studio-mint.php', 'assets/studio/badge.glb', 'lib/store.php', '.well-known/spatial.json', 'atlas/call/info.php', 'presence/status.php']) assert.ok(paths.includes(p), p);
    const example = manifest.entries.filter((e) => /\.example$/.test(e[0]) && !e[4].includes('o')).map((e) => e[0]);
    assert.deepStrictEqual(example, [], '.example files are optional');
    const state = paths.filter((p) => /(^|\/)(atlas-[^/]*\.(json|lock)|[^/]*\.pem|\.salt|storage-root\.php|private-dir\.php|replay|holdings|txn)(\/|$)/.test(p) || /(^|\/)(state|config\.php)(\/|$)/.test(p));
    assert.deepStrictEqual(state, []);
    assert.ok(!phpSrc.includes(built.token) && !phpSrc.includes(built.token.replace(/-/g, '')), 'token itself is not embedded');
    const bad = manifest.entries.filter((e) => e[5] === '' || !/^[0-9a-f]{64}$/.test(e[1]));
    assert.deepStrictEqual(bad, []);
  });

  await check('template is read-only by construction (no file writes, execution or includes) and PHP 7.2 compatible', () => {
    const code = template.replace(/<<<'ATLAS_DOCTOR_PAGE'[\s\S]*?\nATLAS_DOCTOR_PAGE;/, '');
    const forbidden = /\b(file_put_contents|fopen|fwrite|fputs|mkdir|rmdir|rename|chmod|chown|touch|copy|tempnam|symlink|link|exec|shell_exec|system|passthru|popen|proc_open|eval|include|include_once|require|require_once|curl_init|fsockopen|mail|move_uploaded_file|ini_set|putenv|header_register_callback)\s*\(/;
    assert.strictEqual((code.match(forbidden) || [null])[0], null);
    assert.deepStrictEqual((code.match(/\bunlink\s*\(/g) || []).length, 1, 'unlink appears once (self-delete)');
    assert.ok(/unlink\(\$self\)/.test(code) && /\$self = __FILE__/.test(code));
    const modern = /(\?->|\?\?=|\bfn\s*\(|\bmatch\s*\(|\bstr_contains\s*\(|\bstr_starts_with\s*\(|\bstr_ends_with\s*\(|\barray_key_first\s*\(|\barray_key_last\s*\(|\barray_is_list\s*\(|JSON_THROW_ON_ERROR|\benum\s+\w|\breadonly\b|:\s*(int|string|bool|array)\s*\{)/;
    assert.strictEqual((code.match(modern) || [null])[0], null);
  });

  await check('page script builds the DOM with textContent only (file names are untrusted)', () => {
    const script = template.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/)[1];
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/.test(script));
    new Function(script); // parses
  });

  await check('the unbuilt template refuses to run', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'));
    fs.copyFileSync(path.join(REPO, 'tools/site-doctor/site-doctor.template.php'), path.join(root, 'site-doctor.php'));
    const srv = await serve(root);
    const r = await fetch(srv.base + '/site-doctor.php');
    srv.stop();
    assert.strictEqual(r.status, 404);
    assert.ok(/unbuilt/.test(await r.text()));
  });

  // ---- clean tree ------------------------------------------------------------------------------------------
  const root = layout('a');
  fs.copyFileSync(built.php, path.join(root, 'site-doctor.php'));
  const srv = await serve(root);
  const call = srv.call(built.token);
  const bad = srv.call('0000-0000-0000-0000-0000-0000-0000-0000');

  await check('page without a token shows only the login: no manifest paths, hashes or token hash', async () => {
    const r = await fetch(srv.base + '/site-doctor.php');
    const html = await r.text();
    assert.strictEqual(r.status, 200);
    assert.ok(/Site Doctor/.test(html));
    assert.ok(!html.includes('design-validator.php') && !html.includes(manifest.tokenSha256) && !/[0-9a-f]{64}/.test(html), 'no manifest paths or hashes');
    const csp = r.headers.get('content-security-policy') || '';
    assert.ok(/default-src 'none'/.test(csp) && /script-src 'nonce-/.test(csp) && /frame-ancestors 'none'/.test(csp));
    assert.ok(/noindex/.test(r.headers.get('x-robots-tag') || '') && /no-store/.test(r.headers.get('cache-control') || ''));
    assert.ok(html.includes((csp.match(/script-src 'nonce-([^']+)'/) || [])[1]), 'inline script carries the CSP nonce');
  });

  await check('a wrong token is refused, slowly, and returns nothing', async () => {
    const t0 = Date.now();
    const r = await bad('env');
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.json, { ok: false, error: 'bad-token' });
    assert.ok(Date.now() - t0 >= 1300, 'delay on failure');
    const s = await bad('scan', { site: 'a' });
    assert.strictEqual(s.status, 403);
    const d = await bad('delete');
    assert.strictEqual(d.status, 403);
    assert.ok(fs.existsSync(path.join(root, 'site-doctor.php')), 'a wrong token does not delete');
  });

  await check('token typing: case, dashes and spaces are ignored', async () => {
    const r = await srv.call(' ' + built.token.toUpperCase().replace(/-/g, ' ') + ' ')('env');
    assert.strictEqual(r.status, 200);
  });

  await check('clean tree: every file matches, demo site A detected, no problems', async () => {
    const env = await call('env');
    assert.strictEqual(env.json.ok, true);
    assert.strictEqual(env.json.detected, 'a');
    assert.strictEqual(env.json.meta.entries, manifest.entries.length);
    const fails = env.json.checks.filter((c) => c.status === 'fail').map((c) => c.id);
    assert.deepStrictEqual(fails, []);
    const scan = await call('scan', { site: 'a' });
    assert.strictEqual(scan.json.next, null);
    assert.deepStrictEqual(issue(scan), []);
    assert.strictEqual(scan.json.counts.ok, scan.json.total, JSON.stringify(scan.json.counts));
    assert.ok(scan.json.total > 400);
  });

  await check('scan resumes from a cursor and covers the same entries', async () => {
    const all = await call('scan', { site: 'a' });
    const tail = await call('scan', { site: 'a', cursor: '100' });
    assert.strictEqual(tail.json.total, all.json.total);
    assert.strictEqual(tail.json.counts.ok, all.json.total - 100);
  });

  await check('site selection: issuer-only skips demo pages, site B expects its own pages', async () => {
    const none = await call('scan', { site: 'none' });
    assert.ok(none.json.total < 200 && none.json.total > 100);
    assert.deepStrictEqual(issue(none), []);
    const b = await call('scan', { site: 'b' });
    const missing = issue(b);
    assert.ok(missing.includes('wallet-bridge-demo.html missing'), missing.slice(0, 5).join(' | '));
    assert.ok(!missing.some((m) => m.startsWith('bank-demo.html')), 'site A pages are not expected for site B');
  });

  // ---- problems it must find ---------------------------------------------------------------------------------
  const studioMint = path.join(root, 'atlas/studio/inc/studio-mint.php');
  const keep = fs.readFileSync(studioMint);
  fs.unlinkSync(studioMint);
  await check('a missing studio-mint.php is reported as missing code', async () => {
    const r = await call('scan', { site: 'a' });
    assert.deepStrictEqual(issue(r), ['atlas/studio/inc/studio-mint.php missing']);
    assert.strictEqual(r.json.results[0][2], 'c');
  });
  fs.writeFileSync(studioMint, keep);

  await check('edited code, a changed binary and a replaced symlink are reported; CRLF line endings are not', async () => {
    const lib = path.join(root, 'lib/store.php');
    fs.appendFileSync(lib, '\n// local edit\n');
    const crypto = path.join(root, 'lib/crypto.php');
    fs.writeFileSync(crypto, fs.readFileSync(crypto, 'utf8').replace(/\n/g, '\r\n'));
    const htm = path.join(root, 'index.html');
    fs.writeFileSync(htm, fs.readFileSync(htm, 'utf8').replace(/\n/g, '\r\n'));
    const glb = path.join(root, 'assets/studio/badge.glb');
    const b = fs.readFileSync(glb); b[b.length - 1] ^= 0xff; fs.writeFileSync(glb, b);
    const png = path.join(root, 'assets/studio/key.png');
    fs.writeFileSync(png, Buffer.concat([fs.readFileSync(png), Buffer.from([0])]));
    const keys = path.join(root, 'atlas/studio/inc/keys.php');
    const keysBytes = fs.readFileSync(keys);
    fs.unlinkSync(keys); fs.symlinkSync('/etc/hostname', keys);
    const r = await call('scan', { site: 'a' });
    assert.deepStrictEqual(issue(r).sort(), ['assets/studio/badge.glb differs', 'assets/studio/key.png differs', 'atlas/studio/inc/keys.php symlink', 'lib/store.php differs']);
    assert.strictEqual(r.json.results.find((x) => x[0] === 'lib/store.php')[2], 'c');
    const sz = r.json.results.find((x) => x[0] === 'lib/store.php');
    assert.ok(sz[3] > sz[4] - 1 && Number.isInteger(sz[3]) && Number.isInteger(sz[4]), 'size on the server and in the repository are reported');
    assert.strictEqual(r.json.results.find((x) => x[0] === 'atlas/studio/inc/keys.php')[3], null);
    assert.strictEqual(r.json.results.find((x) => x[0] === 'assets/studio/badge.glb')[2], 'a');
    fs.unlinkSync(keys); fs.writeFileSync(keys, keysBytes);
  });

  await check('a site-specific manifest is "different on purpose", not a problem', async () => {
    const spatial = path.join(root, '.well-known/spatial.json');
    const j = JSON.parse(fs.readFileSync(spatial, 'utf8')); j.worlds.push({ id: 'studio' });
    fs.writeFileSync(spatial, JSON.stringify(j, null, 2));
    const r = await call('scan', { site: 'a' });
    assert.ok(issue(r).includes('.well-known/spatial.json expected-differs'), issue(r).join(' | '));
  });

  await check('unexpected files are listed; private state is listed by name only and never opened', async () => {
    const SECRET = 'SECRET-MARKER-9f3a7c';
    fs.mkdirSync(path.join(root, 'custom'), { recursive: true });
    fs.writeFileSync(path.join(root, 'custom/hello.txt'), 'hi');
    fs.writeFileSync(path.join(root, 'assets/badge.glb'), 'site own model');
    fs.writeFileSync(path.join(root, 'lib/issuer-private-key.pem'), '-----BEGIN EC PRIVATE KEY-----\n' + SECRET + '\n-----END EC PRIVATE KEY-----\n');
    fs.writeFileSync(path.join(root, 'lib/atlas-holdings-store.json'), JSON.stringify({ secret: SECRET }));
    fs.mkdirSync(path.join(root, 'lib/replay'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib/replay/r1.json'), SECRET);
    // storage-root.php holds a folder path (which the readiness check reports), not a secret: it is only listed by name here.
    fs.writeFileSync(path.join(root, 'atlas/studio/inc/storage-root.php'), '<?php return "/nonexistent/studio-data";');
    fs.writeFileSync(path.join(root, 'error_log'), 'warning ' + SECRET);
    fs.writeFileSync(path.join(root, 'evil <img src=x onerror=alert(1)>.txt'), 'x');
    const r = await call('extras');
    assert.strictEqual(r.json.ok, true);
    assert.ok(r.json.other.includes('custom/hello.txt') && r.json.other.includes('assets/badge.glb'));
    assert.ok(r.json.other.includes('evil <img src=x onerror=alert(1)>.txt'), 'hostile names are returned as data');
    const stateNames = r.json.state.map((s) => s[0]);
    for (const n of ['lib/issuer-private-key.pem', 'lib/atlas-holdings-store.json', 'lib/replay/r1.json', 'atlas/studio/inc/storage-root.php']) assert.ok(stateNames.includes(n), n);
    assert.ok(r.json.state.every((s) => /^[0-7]{4}$/.test(s[1]) && Number.isInteger(s[2])));
    assert.deepStrictEqual(r.json.host, ['error_log']);
    assert.ok(!r.text.includes('site-doctor.php') && !r.json.other.includes('site-doctor.php'), 'the doctor does not list itself');
    assert.strictEqual(r.json.partial, false);
  });

  await check('unknown PHP files get their own list; big state and unknown folders collapse to one line', async () => {
    fs.mkdirSync(path.join(root, 'atlas/asset'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atlas/asset/trade.php'), '<?php // an old route');
    fs.mkdirSync(path.join(root, 'atlas/call/lib/state/nonces/1'), { recursive: true });
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(root, 'atlas/call/lib/state/nonces/1/' + i + '.dat'), 'STATE-BYTES-' + i);
    fs.writeFileSync(path.join(root, 'atlas/call/lib/config.php.off'), '<?php return ["secret" => "CALL-SECRET-1"];');
    fs.mkdirSync(path.join(root, 'bulk'), { recursive: true });
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, 'bulk/f' + i + '.txt'), 'x');
    const r = await call('extras');
    const old = r.json.php.find((x) => x.p === 'atlas/asset/trade.php');
    assert.ok(old && old.size > 0 && /^\d{4}-\d\d-\d\d$/.test(old.date) && old.like === null, 'the old route is listed as unknown PHP');
    assert.ok(!r.json.other.includes('atlas/asset/trade.php'));
    // a copy of a repository file in the wrong folder is recognised, and a changed copy is told apart from an identical one
    fs.mkdirSync(path.join(root, 'stray'), { recursive: true });
    fs.copyFileSync(path.join(root, 'atlas/asset/reissue.php'), path.join(root, 'stray/reissue.php'));
    fs.writeFileSync(path.join(root, 'lib/send.php'), '<?php // old copy, not the repository file');
    const r2 = await call('extras');
    const same = r2.json.php.find((x) => x.p === 'stray/reissue.php');
    assert.ok(same && same.same === true && same.like === 'atlas/asset/reissue.php', JSON.stringify(same));
    const diff = r2.json.php.find((x) => x.p === 'lib/send.php');
    assert.ok(diff && diff.same === false && diff.like === 'atlas/mail/send.php', JSON.stringify(diff));
    assert.ok(!r2.text.includes('old copy, not the repository file'), 'contents are hashed, never returned');
    fs.rmSync(path.join(root, 'stray'), { recursive: true }); fs.unlinkSync(path.join(root, 'lib/send.php'));
    assert.ok(r.json.state.some((s) => s[0] === 'atlas/call/lib/state/' && s[3] === 'dir' && s[2] === 25), JSON.stringify(r.json.state.filter((s) => /state/.test(s[0]))));
    assert.ok(r.json.state.some((s) => s[0] === 'atlas/call/lib/config.php.off' && !s[3]), 'disabled call config is private state');
    assert.ok(!r.json.other.some((o) => o.startsWith('atlas/call/lib/state/')), 'state files are not listed as unknown');
    assert.ok(r.json.other.includes('bulk/ [30 files]') && !r.json.other.some((o) => /^bulk\/f/.test(o)));
    assert.strictEqual(r.json.otherTotal >= 30, true);
    assert.ok(!r.text.includes('STATE-BYTES') && !r.text.includes('CALL-SECRET-1'));
  });

  await check('Call and Presence are checked only when selected, and a missing Call file is reported', async () => {
    const none = await call('scan', { site: 'a' });
    const withCall = await call('scan', { site: 'a', mods: 'c' });
    assert.strictEqual(withCall.json.total - none.json.total, manifest.entries.filter((e) => e[5].includes('c')).length);
    const missing = issue(withCall);
    assert.ok(missing.includes('atlas/call/info.php missing'), missing.slice(0, 4).join(' | '));
    assert.ok(!issue(none).some((m) => m.startsWith('atlas/call/')));
    const both = await call('scan', { site: 'a', mods: 'cp' });
    assert.ok(issue(both).includes('presence/status.php missing'));
    const env = await call('env');
    assert.strictEqual(env.json.detectedMods, '');
    fs.mkdirSync(path.join(root, 'atlas/call'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atlas/call/info.php'), '<?php');
    assert.strictEqual((await call('env')).json.detectedMods, 'c');
    fs.unlinkSync(path.join(root, 'atlas/call/info.php'));
    // optional repository files (examples, READMEs) are never "missing"
    const lab = await call('scan', { site: 'a', mods: 'c' });
    assert.ok(!issue(lab).some((m) => /\.example missing/.test(m)));
  });

  // ---- readiness checks ---------------------------------------------------------------------------------------
  const status = (env, id) => (env.json.checks.find((c) => c.id === id) || {}).status;

  await check('readiness: Studio storage not configured is a to-do, with the values to create', async () => {
    fs.unlinkSync(path.join(root, 'atlas/studio/inc/storage-root.php'));
    const env = await call('env');
    assert.strictEqual(status(env, 'studio-root'), 'warn');
    assert.strictEqual(env.json.setup.host, srv.host);
    assert.deepStrictEqual(env.json.setup.buckets, ['drafts', 'uploads-quarantine', 'mint-receipts', 'tmp', 'rate']);
    assert.ok(env.json.setup.suggestedRoot.endsWith('/atlas-studio-data'));
    assert.strictEqual(env.json.setup.spatialWorld.policy.walletBridge.sign[0], 'atlas.studio.mint/1');
  });

  await check('readiness: storage inside the web root, missing sub-folders, domain mismatch, then a good setup', async () => {
    const sf = path.join(root, 'atlas/studio/inc/storage-root.php');
    fs.mkdirSync(path.join(root, 'private-inside'), { recursive: true });
    fs.writeFileSync(sf, '<?php return ' + JSON.stringify(path.join(root, 'private-inside')) + ';');
    assert.strictEqual(status(await call('env'), 'studio-root'), 'fail');

    const priv = fs.mkdtempSync(path.join(tmp, 'private-'));
    fs.writeFileSync(sf, '<?php\n// comment\nreturn ' + JSON.stringify(priv) + ';\n');
    let env = await call('env');
    assert.strictEqual(status(env, 'studio-root'), 'ok');
    assert.strictEqual(status(env, 'studio-buckets'), 'fail');
    for (const b of ['drafts', 'uploads-quarantine', 'mint-receipts', 'tmp', 'rate']) fs.mkdirSync(path.join(priv, b));
    env = await call('env');
    assert.strictEqual(status(env, 'studio-buckets'), 'ok');
    assert.strictEqual(status(env, 'studio-config'), 'info');

    fs.writeFileSync(path.join(priv, 'studio-config.json'), JSON.stringify({ mintEnabled: true, domain: 'example.org', origins: ['https://example.org'] }));
    env = await call('env');
    assert.strictEqual(status(env, 'studio-config'), 'warn');
    assert.ok(/not exactly/.test(env.json.checks.find((c) => c.id === 'studio-config').detail));

    fs.writeFileSync(path.join(priv, 'studio-config.json'), JSON.stringify({ mintEnabled: false, domain: srv.host, origins: ['http://' + srv.host] }));
    env = await call('env');
    assert.strictEqual(status(env, 'studio-config'), 'ok');
    assert.ok(/off/.test(env.json.checks.find((c) => c.id === 'studio-config').title));
    assert.strictEqual(status(env, 'spatial-studio'), 'warn');
    assert.strictEqual(status(env, 'https'), 'warn');
  });

  await check('readiness: a published key without a revocation list is flagged', async () => {
    fs.writeFileSync(path.join(root, '.well-known/atlas-key.json'), '{}');
    assert.strictEqual(status(await call('env'), 'revocations'), 'fail');
    fs.writeFileSync(path.join(root, '.well-known/atlas-revocations.json'), '{"revoked":[]}');
    assert.strictEqual(status(await call('env'), 'issuer'), 'ok');
  });

  await check('no response ever contained private-state contents or the token', () => {
    const joined = everything.join('\n');
    assert.ok(!joined.includes('SECRET-MARKER-9f3a7c'));
    assert.ok(!joined.includes('BEGIN EC PRIVATE KEY'));
    assert.ok(!joined.includes(built.token.replace(/-/g, '')));
  });

  // ---- the original incident: a site from before Studio ---------------------------------------------------
  await check('a pre-Studio site is reported with every missing Studio file and the old shared libraries', async () => {
    const old = await serve((() => { const r = baselineLayout(); fs.copyFileSync(built.php, path.join(r, 'site-doctor.php')); return r; })());
    const r = await old.call(built.token)('scan', { site: 'a' });
    old.stop();
    const found = issue(r);
    for (const p of ['atlas/studio/inc/studio-mint.php', 'atlas/studio/inc/challenges.php', 'atlas/studio/api.php', 'assets/studio/trophy.glb']) assert.ok(found.includes(p + ' missing'), p);
    assert.ok(found.includes('lib/bootstrap.php differs') || found.includes('lib/store.php differs'), 'old shared libraries differ');
    assert.ok(!found.some((x) => /^(bank-demo|index)\.html missing/.test(x)));
  });

  // ---- expiry and self-delete -----------------------------------------------------------------------------
  await check('an expired doctor refuses every check but still deletes itself with the token', async () => {
    const expired = fs.mkdtempSync(path.join(tmp, 'root-'));
    const src = fs.readFileSync(built.php, 'utf8').replace(/"expires":\d+/, '"expires":1000');
    fs.writeFileSync(path.join(expired, 'site-doctor.php'), src);
    const e = await serve(expired);
    const c = e.call(built.token);
    const env = await c('env');
    assert.strictEqual(env.status, 410);
    assert.strictEqual((await c('scan', { site: 'a' })).status, 410);
    const html = await (await fetch(e.base + '/site-doctor.php')).text();
    assert.ok(/"expired":true/.test(html));
    const del = await c('delete');
    assert.strictEqual(del.json.deleted, true);
    assert.ok(!fs.existsSync(path.join(expired, 'site-doctor.php')));
    e.stop();
  });

  await check('delete removes only the doctor file', async () => {
    const before = fs.readdirSync(root).filter((n) => n !== 'site-doctor.php').sort();
    const del = await call('delete');
    assert.strictEqual(del.json.ok, true);
    assert.strictEqual(del.json.deleted, true);
    assert.ok(!fs.existsSync(path.join(root, 'site-doctor.php')));
    assert.deepStrictEqual(fs.readdirSync(root).sort(), before);
    assert.strictEqual((await fetch(srv.base + '/site-doctor.php')).status, 404);
  });

  servers.forEach((s) => s.kill());
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? '\n' + failures + ' check(s) failed.' : '\nAll site doctor checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); servers.forEach((s) => s.kill()); process.exit(1); });
