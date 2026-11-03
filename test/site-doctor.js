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

async function serve(root, phpArgs) {
  const port = await freePort();
  const child = spawn('php', (phpArgs || []).concat(['-S', '127.0.0.1:' + port, '-t', root]), { stdio: 'ignore' });
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
    const state = paths.filter((p) => /(^|\/)(atlas-[^/]*\.(json|lock)|[^/]*\.pem|\.salt|storage-root\.php|private-dir\.php|replay|holdings|txn)(\/|$)/.test(p) || /(^|\/)state(\/|$)/.test(p) || /(^|\/)lib\/config\.php(\.off|\.bak)?$/.test(p));
    assert.deepStrictEqual(state, []);
    assert.ok(paths.includes('atlas/admin/moderation/config.php'), 'a route that is called config.php is compared, not treated as private state');
    assert.ok(!phpSrc.includes(built.token) && !phpSrc.includes(built.token.replace(/-/g, '')), 'token itself is not embedded');
    const bad = manifest.entries.filter((e) => e[5] === '' || !/^[0-9a-f]{64}$/.test(e[1]));
    assert.deepStrictEqual(bad, []);
  });

  await check('template is read-only by construction (no file writes, execution or includes) and PHP 7.2 compatible', () => {
    // The built file is what runs: the template plus the issuer's feature readers (lib/site-features.php).
    const code = phpSrc.replace(/<<<'ATLAS_DOCTOR_JSON'[\s\S]*?\nATLAS_DOCTOR_JSON\n/, '').replace(/<<<'ATLAS_DOCTOR_PAGE'[\s\S]*?\nATLAS_DOCTOR_PAGE;/, '');
    assert.ok(code.includes('function atlas_sf_feature_json_enabled'), 'the feature readers are spliced into the built file');
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

  // ---- feature switches (read-only) ---------------------------------------------------------------------------
  const PLANTED = ['PLANTED-SMTP-PASS-1', 'PLANTED-IMAP-PASS-2', 'PLANTED-ADMIN-HASH-3', 'PLANTED-TURN-SECRET-4', 'PLANTED-EXTRA-KEY-5', 'planted-from@secret.example', 'PLANTED-SMTP-USER-6', 'PLANTED-REVOKED-MOD-7'];
  const feats = async () => { const r = await call('features'); assert.strictEqual(r.json.ok, true, r.text.slice(0, 200)); return Object.fromEntries(r.json.features.map((f) => [f.id, f])); };
  const put = (rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); };
  const drop = (rel) => fs.rmSync(path.join(root, rel), { force: true });
  const phpConfig = (obj) => execFileSync('php', ['-r', 'echo "<?php\n// lab config\nreturn " . var_export(json_decode($argv[1], true), true) . ";\n";', JSON.stringify(obj)], { encoding: 'utf8' });
  const storeDir = () => { const m = fs.readFileSync(path.join(root, 'atlas/studio/inc/storage-root.php'), 'utf8').match(/return "(.*)";/); return JSON.parse('"' + m[1] + '"'); };

  await check('features: a wrong token is refused; the list covers every switch with how to change it', async () => {
    assert.strictEqual((await bad('features')).status, 403);
    const f = await feats();
    assert.deepStrictEqual(Object.keys(f).sort(), manifest.features.map((x) => x.id).sort());
    for (const x of Object.values(f)) {
      assert.ok(['on', 'off', 'problem', 'absent'].includes(x.state), x.id + ' ' + x.state);
      assert.ok(x.enable.length > 10 && x.disable.length > 10 && x.label && Array.isArray(x.reasons) && Array.isArray(x.facts), x.id);
      assert.deepStrictEqual(Object.keys(x).sort(), ['about', 'disable', 'enable', 'facts', 'group', 'id', 'label', 'pausable', 'reasons', 'state']);
    }
    assert.strictEqual(f['studio-mint'].state, 'off');
    assert.strictEqual(f['presence-moderation'].state, 'absent', 'presence files are not on this domain');
    assert.strictEqual(f['call-service'].state, 'absent');
  });

  await check('features: Studio minting follows studio-config.json, and flags a wrong domain or origin', async () => {
    const cfg = path.join(storeDir(), 'studio-config.json');
    const write = (o) => fs.writeFileSync(cfg, typeof o === 'string' ? o : JSON.stringify(o));
    write({ mintEnabled: true, domain: srv.host, origins: ['https://' + srv.host], apiKey: 'PLANTED-EXTRA-KEY-5' });
    let x = (await feats())['studio-mint'];
    assert.strictEqual(x.state, 'on', JSON.stringify(x));
    assert.ok(x.facts.some((l) => l.startsWith('domain: ')));
    write({ mintEnabled: true, domain: 'example.org', origins: ['https://example.org'] });
    x = (await feats())['studio-mint'];
    assert.strictEqual(x.state, 'problem');
    assert.ok(x.reasons.some((r) => /domain-mismatch/.test(r)) && x.reasons.some((r) => /bad-origins/.test(r)));
    write('{ not json');
    assert.strictEqual((await feats())['studio-mint'].state, 'problem');
    write({ mintEnabled: 'yes', domain: srv.host });
    assert.strictEqual((await feats())['studio-mint'].state, 'off', 'only the boolean true switches it on');
    write({ mintEnabled: false, domain: srv.host, origins: ['http://' + srv.host] });
    assert.strictEqual((await feats())['studio-mint'].state, 'off');
  });

  await check('features: JSON switches (ledger) are off until the file says enabled, and must name this host', async () => {
    const rel = 'lib/atlas-ledger-issuance-config.json';
    assert.strictEqual((await feats())['ledger-issuance'].state, 'off');
    put(rel, { enabled: true, domain: srv.host, perClientPerMinute: 5, secret: 'PLANTED-EXTRA-KEY-5' });
    let x = (await feats())['ledger-issuance'];
    assert.strictEqual(x.state, 'on');
    assert.ok(x.facts.includes('perClientPerMinute: 5') && !x.facts.some((l) => /secret|PLANTED/.test(l)), 'only whitelisted fields are shown');
    put(rel, { enabled: true, domain: 'example.org' });
    assert.strictEqual((await feats())['ledger-issuance'].state, 'problem');
    put(rel, { enabled: 'true', domain: srv.host });
    assert.strictEqual((await feats())['ledger-issuance'].state, 'off');
    put(rel, '{ oops');
    assert.strictEqual((await feats())['ledger-issuance'].state, 'problem');
    assert.strictEqual((await feats())['ledger-receipts'].state, 'off', 'receipts are an independent switch');
    drop(rel);
  });

  await check('features: email tickets report servers and "login set", never passwords, user names or the from address', async () => {
    const rel = 'lib/atlas-email-tickets-config.json';
    put(rel, { smtpHost: 'smtp.example.net', smtpPort: 465, smtpSecure: 'ssl', smtpUser: 'PLANTED-SMTP-USER-6', smtpPass: 'PLANTED-SMTP-PASS-1', fromAddress: 'planted-from@secret.example', imapHost: 'imap.example.net', imapUser: 'u', imapPass: 'PLANTED-IMAP-PASS-2' });
    let x = (await feats())['email-tickets'];
    assert.strictEqual(x.state, 'on', JSON.stringify(x));
    const text = x.facts.join('\n');
    assert.ok(/smtp\.example\.net:465/.test(text) && /outgoing login: set/.test(text) && /imap\.example\.net:993/.test(text));
    for (const p of PLANTED) assert.ok(!JSON.stringify(x).includes(p), p);
    put(rel, { smtpHost: 'smtp.example.net', smtpPass: 'PLANTED-SMTP-PASS-1' });
    x = (await feats())['email-tickets'];
    assert.strictEqual(x.state, 'problem');
    assert.ok(/fromAddress/.test(x.reasons.join(' ')));
    put(rel, {});
    assert.strictEqual((await feats())['email-tickets'].state, 'off');
    drop(rel);
    assert.strictEqual((await feats())['email-tickets'].state, 'off');
  });

  await check('features: the file-transfer opt-in is read from the manifest', async () => {
    const spatial = path.join(root, '.well-known/spatial.json');
    const keepJson = fs.readFileSync(spatial, 'utf8');
    const j = JSON.parse(keepJson);
    assert.deepStrictEqual(j.fileTransfer, { classes: ['atlas.wearable.ring'] }, 'the sample manifest opts in');
    assert.strictEqual((await feats())['file-transfer'].state, 'on');
    delete j.fileTransfer;
    fs.writeFileSync(spatial, JSON.stringify(j));
    assert.strictEqual((await feats())['file-transfer'].state, 'off');
    j.fileTransfer = {};
    fs.writeFileSync(spatial, JSON.stringify(j));
    let x = (await feats())['file-transfer'];
    assert.strictEqual(x.state, 'on'); assert.ok(/every eligible class/.test(x.facts.join(' ')));
    j.fileTransfer = { classes: ['a.b', 'c.d'] };
    fs.writeFileSync(spatial, JSON.stringify(j));
    x = (await feats())['file-transfer'];
    assert.ok(x.state === 'on' && /classes \(2\): a\.b, c\.d/.test(x.facts.join(' ')));
    j.fileTransfer = [1, 2];
    fs.writeFileSync(spatial, JSON.stringify(j));
    assert.strictEqual((await feats())['file-transfer'].state, 'problem');
    fs.writeFileSync(spatial, keepJson);
  });

  await check('features: moderation on the issuer and on the presence service', async () => {
    put('lib/atlas-moderation-config.json', { domain: srv.host, audiences: ['https://presence.example.net'] });
    let x = (await feats())['moderation-issuer'];
    assert.strictEqual(x.state, 'on', JSON.stringify(x));
    assert.ok(x.facts.join(' ').includes('https://presence.example.net'));
    put('lib/atlas-moderation-config.json', { domain: 'example.org', audiences: ['https://presence.example.net'] });
    assert.strictEqual((await feats())['moderation-issuer'].state, 'problem');
    put('lib/atlas-moderation-config.json', { domain: srv.host, audiences: ['not a url'] });
    assert.strictEqual((await feats())['moderation-issuer'].state, 'problem');
    drop('lib/atlas-moderation-config.json');
    assert.strictEqual((await feats())['moderation-issuer'].state, 'off');

    put('presence/status.php', '<?php');
    const rel = 'presence/lib/atlas-presence-moderation-config.json';
    assert.strictEqual((await feats())['presence-moderation'].state, 'off');
    put(rel, { audience: 'https://presence.example.net', domains: { 'issuer.example.net': { key: 'k' } }, revokedModerators: ['PLANTED-REVOKED-MOD-7'] });
    x = (await feats())['presence-moderation'];
    assert.strictEqual(x.state, 'on', JSON.stringify(x));
    assert.ok(x.facts.some((l) => l === 'revoked moderators: 1') && !JSON.stringify(x).includes('PLANTED'));
    put(rel, { enabled: false, audience: 'https://presence.example.net', domains: {} });
    assert.strictEqual((await feats())['presence-moderation'].state, 'off');
    put(rel, { enabled: 'no' });
    assert.strictEqual((await feats())['presence-moderation'].state, 'problem');
    put(rel, '{ nope');
    assert.strictEqual((await feats())['presence-moderation'].state, 'problem');
    drop(rel); drop('presence/status.php');
  });

  await check('features: lab switches follow the private folder, the DISABLED file and config.php, and never show the admin token hash', async () => {
    const priv = fs.mkdtempSync(path.join(tmp, 'lab-'));
    const pointer = 'atlas/demo/txlab/inc/private-dir.php';
    assert.strictEqual((await feats()).txlab.state, 'off', 'no pointer file');
    put(pointer, '<?php return "/nonexistent/lab-private";');
    let x = (await feats()).txlab;
    assert.ok(x.state === 'problem' && /does not exist/.test(x.reasons.join(' ')), JSON.stringify(x));
    put(pointer, '<?php return ' + JSON.stringify(priv) + ';');
    assert.ok(/config\.php is missing/.test((await feats()).txlab.reasons.join(' ')));
    const config = (extra) => fs.writeFileSync(path.join(priv, 'config.php'), phpConfig(Object.assign({ enabled: true, domain: srv.host, adminTokenHash: 'PLANTED-ADMIN-HASH-3', publicDemo: { enabled: true } }, extra || {})));
    config();
    x = (await feats()).txlab;
    assert.strictEqual(x.state, 'on', JSON.stringify(x));
    assert.ok(x.facts.includes('public demo for visitors: on') && !JSON.stringify(x).includes('PLANTED'));
    fs.writeFileSync(path.join(priv, 'DISABLED'), '');
    x = (await feats()).txlab;
    assert.ok(x.state === 'off' && /DISABLED/.test(x.reasons.join(' ')));
    fs.unlinkSync(path.join(priv, 'DISABLED'));
    config({ enabled: false });
    assert.strictEqual((await feats()).txlab.state, 'off');
    config({ domain: 'example.org' });
    assert.strictEqual((await feats()).txlab.state, 'problem');
    config({ allowInsecureHttp: true });
    x = (await feats()).txlab;
    assert.ok(x.state === 'problem' && /allowInsecureHttp/.test(x.reasons.join(' ')));
    fs.writeFileSync(path.join(priv, 'config.php'), '<?php return ["enabled"=>true];');
    assert.strictEqual((await feats()).txlab.state, 'problem', 'a hand-edited file is reported, not guessed');
    // a private folder inside the web root is a problem even when everything else is right
    const inside = path.join(root, 'lab-inside');
    fs.mkdirSync(inside);
    fs.writeFileSync(path.join(inside, 'config.php'), phpConfig({ enabled: true, domain: srv.host, adminTokenHash: 'PLANTED-ADMIN-HASH-3' }));
    put(pointer, '<?php return ' + JSON.stringify(inside) + ';');
    x = (await feats()).txlab;
    assert.ok(x.state === 'problem' && /inside the web root/.test(x.reasons.join(' ')));
    // the second lab is independent and reads its own pointer
    assert.strictEqual((await feats())['multi-issuer'].state, 'off');
    drop(pointer); fs.rmSync(inside, { recursive: true });
  });

  await check('features: Call is switched by renaming config.php, and its secrets are never output', async () => {
    put('atlas/call/info.php', '<?php');
    drop('atlas/call/lib/config.php.off');
    const on = 'atlas/call/lib/config.php', off = on + '.off';
    assert.ok(/not configured/.test((await feats())['call-service'].reasons.join(' ')));
    assert.strictEqual((await feats())['call-service'].state, 'off');
    const body = (o) => '<?php\nreturn ' + o + ';\n';
    put(off, body("[\n  'domain' => 'example.com',\n  'turnSecret' => 'PLANTED-TURN-SECRET-4',\n]"));
    let x = (await feats())['call-service'];
    assert.ok(x.state === 'off' && /switched off/.test(x.reasons.join(' ')), JSON.stringify(x));
    fs.renameSync(path.join(root, off), path.join(root, on));
    x = (await feats())['call-service'];
    assert.ok(x.state === 'problem' && /example\.com placeholder/.test(x.reasons.join(' ')), JSON.stringify(x));
    put(on, body("[\n  'domain' => '" + srv.host + "',\n  'origin' => 'https://" + srv.host + "',\n  'issuerKeys' => [ 'PLANTED-EXTRA-KEY-5' ],\n  'turnUrls' => [ 'turn:t.example.net' ],\n  'turnSecret' => 'PLANTED-TURN-SECRET-4',\n]"));
    x = (await feats())['call-service'];
    assert.strictEqual(x.state, 'on', JSON.stringify(x));
    assert.ok(x.facts.includes('TURN relay: configured') && x.facts.includes('issuer key: set'));
    assert.ok(!JSON.stringify(x).includes('PLANTED'));
    drop(on); drop('atlas/call/info.php');
  });

  await check('features: the issuer private state folder must be absolute, existing, writable and outside the web root', async () => {
    const rel = 'lib/atlas-private-dir.txt';
    assert.strictEqual((await feats())['private-state-dir'].state, 'off');
    put(rel, 'relative/path\n');
    assert.strictEqual((await feats())['private-state-dir'].state, 'problem');
    put(rel, '/nonexistent/state-dir\n');
    assert.strictEqual((await feats())['private-state-dir'].state, 'problem');
    put(rel, path.join(root, 'lib') + '\n');
    assert.ok(/inside the web root/.test((await feats())['private-state-dir'].reasons.join(' ')));
    const good = fs.mkdtempSync(path.join(tmp, 'state-'));
    put(rel, good + '\n');
    assert.strictEqual((await feats())['private-state-dir'].state, 'on');
    drop(rel);
  });

  await check('features: a feature whose files are not installed is "absent", not a failure', async () => {
    const f = path.join(root, 'lib/ledger-receipts.php');
    const keepLib = fs.readFileSync(f);
    fs.unlinkSync(f);
    assert.strictEqual((await feats())['ledger-receipts'].state, 'absent');
    fs.writeFileSync(f, keepLib);
  });

  await check('features: the response is the same size class regardless of how many secrets are planted (no raw config echoed)', async () => {
    const r = await call('features');
    assert.ok(r.text.length < 20000, String(r.text.length));
    for (const p of PLANTED) assert.ok(!r.text.includes(p), p);
  });

  // ---- manifest inspector (read-only) ---------------------------------------------------------------------------
  const spatialPath = path.join(root, '.well-known/spatial.json');
  const baseManifest = fs.readFileSync(spatialPath, 'utf8');
  const withManifest = async (edit) => {
    const j = JSON.parse(baseManifest); j.domain = srv.host;
    const r = edit(j); fs.writeFileSync(spatialPath, typeof r === 'string' ? r : JSON.stringify(j));
    const res = await call('manifest');
    assert.strictEqual(res.json.ok, true, res.text.slice(0, 200));
    return res.json.manifest;
  };
  const probs = (m) => m.problems.map((p) => p[0] + ': ' + p[1]);
  const has = (m, re, level) => m.problems.some((p) => re.test(p[1]) && (!level || p[0] === level));

  await check('manifest: a wrong token is refused; a healthy manifest lists its worlds, effective policy and portals', async () => {
    assert.strictEqual((await bad('manifest')).status, 403);
    const keyDoc = path.join(root, '.well-known/atlas-key.json');
    const keyKept = fs.existsSync(keyDoc) ? fs.readFileSync(keyDoc) : null;
    if (keyKept) fs.unlinkSync(keyDoc);
    const m = await withManifest(() => {});
    if (keyKept) fs.writeFileSync(keyDoc, keyKept);
    assert.strictEqual(m.state, 'ok');
    assert.strictEqual(m.anchor, 'domain');
    assert.deepStrictEqual(m.worlds.map((w) => w.id), JSON.parse(baseManifest).worlds.map((w) => w.id));
    const plaza = m.worlds.find((w) => w.id === 'plaza');
    assert.ok(plaza.default && plaza.playable);
    assert.ok(plaza.facts.some((f) => /^scene: \/spatial\/plaza\/scene\.json - \d+ bytes, \d+ object\(s\), 2 anchor/.test(f)), plaza.facts.join(' | '));
    assert.ok(plaza.facts.includes('guest access: open') && plaza.facts.includes('identity required: no'));
    assert.ok(plaza.portals.some((x) => /^world -> museum/.test(x) && !/\[/.test(x)));
    assert.ok(plaza.portals.some((x) => /^key -> /.test(x)));
    // real, specific findings on the sample site: no mail config, and "self" issuers without a published key
    assert.ok(has(m, /email intake address/, 'warn'), probs(m).join(' | '));
    assert.ok(has(m, /World "museum": trusts only its own issuer/, 'warn'));
    assert.ok(!has(m, /domain" is/), 'domain matches the host');
    assert.ok(!probs(m).some((x) => x.startsWith('fail')), probs(m).join(' | '));
  });

  await check('manifest: a domain that is not this host is flagged; a key-anchored manifest needs a signature', async () => {
    fs.writeFileSync(spatialPath, baseManifest);
    let res = await call('manifest');
    assert.ok(has(res.json.manifest, /"domain" is "localhost:8001" but this site is served as/, 'warn'));
    let m = await withManifest((j) => { delete j.domain; j.identityKey = 'KEY'; });
    assert.ok(/identity key/.test(m.anchor) && has(m, /must carry a "signature"/, 'fail'));
    m = await withManifest((j) => { j.identityKey = 'KEY'; });
    assert.strictEqual(m.anchor, 'domain, with a pinned identity key');
    m = await withManifest((j) => { delete j.domain; });
    assert.ok(has(m, /neither "domain" nor "identityKey"/, 'fail'));
  });

  await check('manifest: broken JSON, a missing file, a non-list "worlds" and an empty list are each reported plainly', async () => {
    let m = await withManifest(() => '{ "domain": ');
    assert.strictEqual(m.state, 'invalid'); assert.ok(has(m, /not a valid JSON object/, 'fail')); assert.deepStrictEqual(m.worlds, []);
    m = await withManifest(() => '[1,2]');
    assert.strictEqual(m.state, 'invalid');
    fs.unlinkSync(spatialPath);
    m = (await call('manifest')).json.manifest;
    assert.strictEqual(m.state, 'missing'); assert.ok(has(m, /declares no space/, 'warn'));
    m = await withManifest((j) => { j.worlds = { plaza: {} }; });
    assert.ok(has(m, /"worlds" must be a list/, 'fail'));
    m = await withManifest((j) => { j.worlds = []; });
    assert.ok(has(m, /"worlds" is empty/, 'warn'));
  });

  await check('manifest: duplicate ids, a bad defaultWorld and world references that do not resolve are found', async () => {
    let m = await withManifest((j) => { j.worlds.push({ id: 'plaza', name: 'dup', entry: { scene: '/x.json', renderer: ['gltf'] } }); });
    assert.ok(has(m, /share the id "plaza"/, 'fail'));
    m = await withManifest((j) => { j.defaultWorld = 'nowhere'; });
    assert.ok(has(m, /"defaultWorld" names "nowhere"/, 'fail'));
    m = await withManifest((j) => { delete j.defaultWorld; });
    assert.ok(has(m, /no "defaultWorld"/, 'warn'));
    m = await withManifest((j) => { j.worlds.push({ id: 'checkout', policy: { walletBridge: { read: true } } }); j.defaultWorld = 'checkout'; });
    assert.ok(has(m, /"defaultWorld" is a world with no "entry"/, 'fail'));
    assert.strictEqual(m.worlds.find((w) => w.id === 'checkout').playable, false);
    m = await withManifest((j) => { j.worlds[0].portals.push({ kind: 'world', to: 'ghost', label: 'Into the void' }); });
    assert.ok(has(m, /portal "Into the void" leads to world "ghost", which does not exist/, 'fail'));
    assert.ok(m.worlds[0].portals.some((x) => /BROKEN: no world "ghost"/.test(x)));
    m = await withManifest((j) => { j.worlds.push({ id: 'policy-only', policy: {} }); j.worlds[0].portals.push({ kind: 'world', to: 'policy-only', label: 'Nowhere' }); });
    assert.ok(has(m, /portal "Nowhere" leads to "policy-only", which has no "entry"/, 'warn'));
    m = await withManifest((j) => { j.worlds.push({ id: 'bad id:1', entry: { scene: '/spatial/plaza/scene.json', renderer: ['procedural-v1'] } }); });
    assert.ok(has(m, /contains a space, colon or #/, 'warn'));
  });

  await check('manifest: other portal kinds are checked for the fields they need', async () => {
    const m = await withManifest((j) => {
      j.worlds[0].portals = [
        { kind: 'domain', to: 'a.example', label: 'no manifest' },
        { kind: 'domain', to: 'a.example', manifest: 'ftp://a.example/x', label: 'ftp' },
        { kind: 'domain', to: 'a.example', manifest: 'https://b.example/.well-known/spatial.json', label: 'other host' },
        { kind: 'domain', to: 'a.example', manifest: 'https://a.example/.well-known/spatial.json', label: 'fine' },
        { kind: 'key', label: 'keyless' }, { kind: 'teleport', label: 'odd' }, 'not an object'
      ];
    });
    for (const re of [/domain portal "no manifest" needs both/, /domain portal "ftp" has a "manifest" that is not an http/, /domain portal "other host" names "a\.example" but its manifest is on "b\.example"/, /key portal "keyless" needs/, /portal "odd" has an unknown kind "teleport"/, /portal #7 is not an object/]) assert.ok(has(m, re, 'warn'), String(re));
    assert.ok(!has(m, /portal "fine"/));
  });

  await check('manifest: scene files are checked on disk (missing, bad path, invalid JSON, external are told apart)', async () => {
    const own = path.join(root, 'spatial/custom'); fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(own, 'model.glb'), 'glb');
    const world = (id, scene) => ({ id, entry: { scene, renderer: ['procedural-v1'] }, policy: {} });
    const m = await withManifest((j) => { j.worlds.push(world('w-missing', '/spatial/custom/nope.json'), world('w-broken', '/spatial/custom/broken.json'), world('w-glb', '/spatial/custom/model.glb?v=2'), world('w-ext', 'https://cdn.example/scene.json'), world('w-up', '/../../etc/passwd'), { id: 'w-none', entry: { renderer: ['gltf'] } }); });
    assert.ok(has(m, /World "w-missing": the scene file \/spatial\/custom\/nope\.json is not on this domain/, 'warn'));
    assert.ok(has(m, /World "w-broken": the scene file is not valid JSON/, 'warn'));
    assert.ok(has(m, /World "w-up": "entry\.scene" is not a usable path/, 'warn'));
    assert.ok(has(m, /World "w-none": "entry\.scene" is missing/, 'warn'));
    const f = (id) => m.worlds.find((w) => w.id === id).facts.join(' | ');
    assert.ok(/scene: \/spatial\/custom\/model\.glb\?v=2 - 3 bytes/.test(f('w-glb')) && !has(m, /World "w-glb"/));
    assert.ok(/scene: external: https:\/\/cdn\.example/.test(f('w-ext')) && !has(m, /World "w-ext"/));
    assert.ok(/MISSING/.test(f('w-missing')) && /NOT VALID JSON/.test(f('w-broken')));
    assert.ok(!JSON.stringify(m).includes('root:'), 'nothing from /etc/passwd or a file system path is returned');
  });

  await check('manifest: effective policy follows the domain default; bad policy values are flagged', async () => {
    let m = await withManifest((j) => {
      j.acceptedItemClasses = ['atlas.default'];
      j.walletBridge = { read: true };
      j.worlds[1].policy = { guestAccess: 'invite-only' };
      j.worlds[2].policy = { acceptedItemClasses: [], walletBridge: { read: false } };
    });
    const facts = (i) => m.worlds[i].facts.join(' | ');
    assert.ok(/accepted item classes: 1: atlas\.default \(domain default\)/.test(facts(1)), facts(1));
    assert.ok(/guest access: invite-only/.test(facts(1)) && /wallet bridge: read yes \(domain default\)/.test(facts(1)));
    assert.ok(/accepted item classes: none(?! \()/.test(facts(2)), 'an explicit empty list wins over the default: ' + facts(2));
    assert.ok(/wallet bridge: read no(?! \()/.test(facts(2)));
    m = await withManifest((j) => { Object.assign(j.worlds[0].policy, { guestAccess: 'whenever', discoverable: 'yes', identityRequired: 1, acceptedItemClasses: [1, 2], trustedIssuers: 'friends', walletBridge: { read: 'yes' } }); j.worlds[0].profile.scale = 'continent'; });
    for (const re of [/"guestAccess" must be open/, /"discoverable" must be true or false/, /"identityRequired" must be true or false/, /"acceptedItemClasses" must be a list of class names/, /"trustedIssuers" must be "any"/, /"walletBridge" must look like/, /profile "scale" is not one of/]) assert.ok(has(m, re, 'warn'), String(re));
  });

  await check('manifest: the intake address and file-transfer opt-in are cross-checked with what is installed', async () => {
    fs.writeFileSync(path.join(root, 'lib/atlas-email-tickets-config.json'), JSON.stringify({ smtpHost: 'smtp.example.net', fromAddress: 'f@example.net' }));
    let m = await withManifest(() => {});
    assert.ok(has(m, /IMAP \(incoming\) is not configured/, 'warn') && !has(m, /email delivery is not configured/));
    assert.ok(fs.existsSync(path.join(root, '.well-known/atlas-key.json')) && !has(m, /trusts only its own issuer/), 'a published issuer key satisfies "self"');
    fs.writeFileSync(path.join(root, 'lib/atlas-email-tickets-config.json'), JSON.stringify({ smtpHost: 'smtp.example.net', fromAddress: 'f@example.net', imapHost: 'imap.example.net' }));
    m = await withManifest(() => {});
    assert.ok(!has(m, /intake address/));
    fs.unlinkSync(path.join(root, 'lib/atlas-email-tickets-config.json'));
    const t = path.join(root, 'atlas/asset/transfer-to-file.php'); const keepT = fs.readFileSync(t); fs.unlinkSync(t);
    m = await withManifest(() => {});
    assert.ok(has(m, /opts into "fileTransfer", but atlas\/asset\/transfer-to-file\.php is not on this domain/, 'warn'));
    fs.writeFileSync(t, keepT);
  });

  await check('manifest: a huge manifest is reported without being parsed, and long or hostile text is clipped and returned as data', async () => {
    fs.writeFileSync(spatialPath, '{"domain":"' + srv.host + '","worlds":[],"pad":"' + 'x'.repeat(2200000) + '"}');
    let r = await call('manifest');
    assert.strictEqual(r.json.manifest.state, 'unreadable'); assert.ok(/larger than 2 MB/.test(r.json.manifest.problems[0][1]));
    const m = await withManifest((j) => { j.worlds[0].name = '<img src=x onerror=alert(1)>' + 'N'.repeat(500); j.worlds[0].portals[0].label = 'L'.repeat(500); });
    assert.ok(m.worlds[0].name.length <= 80 && m.worlds[0].name.startsWith('<img src=x'));
    assert.ok(m.worlds[0].portals[0].length < 200);
    assert.ok(r.text.length < 5000);
  });

  fs.writeFileSync(spatialPath, baseManifest);

  // ---- housekeeping, permissions and administrator-side checks ---------------------------------------------
  const fresh = async (phpArgs) => {
    const r = layout('a');
    fs.copyFileSync(built.php, path.join(r, 'site-doctor.php'));
    const s = await serve(r, phpArgs);
    return { root: r, srv: s, call: s.call(built.token) };
  };
  const find = (res, id) => res.json.checks.find((c) => c.id === id);

  await check('health: a wrong token is refused; a plain tree has no failures and every check has the same shape', async () => {
    const f = await fresh();
    assert.strictEqual((await f.srv.call('0000-0000-0000-0000-0000-0000-0000-0000')('health')).status, 403);
    const r = await f.call('health');
    assert.strictEqual(r.json.ok, true);
    for (const c of r.json.checks) assert.ok(['housekeeping', 'permissions', 'admin'].includes(c.group) && ['ok', 'info', 'warn', 'fail'].includes(c.status) && c.id && c.title && typeof c.detail === 'string' && typeof c.fix === 'string', JSON.stringify(c));
    assert.deepStrictEqual(r.json.checks.filter((c) => c.status === 'fail').map((c) => c.id), []);
    f.srv.stop();
  });

  await check('extras: the 64 empty lock files per kind become one line per folder', async () => {
    const f = await fresh();
    for (let i = 0; i < 64; i++) { fs.writeFileSync(path.join(f.root, 'lib/atlas-rid-lock-' + i + '.lock'), ''); fs.writeFileSync(path.join(f.root, 'lib/atlas-claim-lock-' + i + '.lock'), ''); }
    fs.writeFileSync(path.join(f.root, 'lib/atlas-revocations.lock'), '');
    const r = await f.call('extras');
    const locks = r.json.state.filter((s) => s[3] === 'locks');
    assert.strictEqual(locks.length, 1, JSON.stringify(locks));
    assert.deepStrictEqual([locks[0][0], locks[0][2], locks[0][4]], ['lib/*.lock', 129, 0]);
    assert.ok(!r.json.state.some((s) => /\.lock$/.test(s[0]) && s[0] !== 'lib/*.lock'), 'no individual lock file is listed');
    f.srv.stop();
  });

  await check('housekeeping: the revocation list is validated, counted, and a large one is flagged (ids never shown)', async () => {
    const f = await fresh();
    const rev = path.join(f.root, '.well-known/atlas-revocations.json');
    fs.writeFileSync(rev, JSON.stringify({ revoked: [{ id: 'urn:atlas:asset:SECRET-ID-1' }, { id: 'urn:atlas:asset:SECRET-ID-1' }, { id: 'urn:atlas:asset:SECRET-ID-2' }, { reason: 'no id' }] }));
    let r = await f.call('health');
    let c = find(r, 'revocations-json');
    assert.strictEqual(c.status, 'warn'); assert.ok(/1 entries have no id/.test(c.detail) && /1 repeated/.test(c.detail) && /4 entries/.test(c.detail), c.detail);
    fs.writeFileSync(rev, JSON.stringify({ revoked: [{ id: 'urn:atlas:asset:SECRET-ID-3' }] }));
    c = find(await f.call('health'), 'revocations-json');
    assert.strictEqual(c.status, 'ok'); assert.ok(/1 entries/.test(c.detail));
    const big = []; for (let i = 0; i < 9000; i++) big.push({ id: 'urn:atlas:asset:' + 'x'.repeat(100) + i, revokedAt: '2026-01-01T00:00:00Z', reason: 'issuer-request' });
    fs.writeFileSync(rev, JSON.stringify({ revoked: big }));
    c = find(await f.call('health'), 'revocations-size');
    assert.strictEqual(c.status, 'warn'); assert.ok(/MB/.test(c.title), c.title);
    fs.writeFileSync(rev, '{ "revoked": [');
    c = find(await f.call('health'), 'revocations-json');
    assert.strictEqual(c.status, 'fail'); assert.ok(/refuses to run/.test(c.detail));
    fs.writeFileSync(rev, '{"other": []}');
    assert.strictEqual(find(await f.call('health'), 'revocations-json').status, 'fail');
    const all = (await f.call('health')).text;
    assert.ok(!/SECRET-ID/.test(all));
    f.srv.stop();
  });

  await check('housekeeping: suspensions are validated and expired-but-not-lifted entries are reported', async () => {
    const f = await fresh();
    const sus = path.join(f.root, '.well-known/atlas-suspensions.json');
    const recent = new Date(Date.now() - 3600e3).toISOString(), old = '2020-01-01T00:00:00Z', future = new Date(Date.now() + 3600e3).toISOString();
    fs.writeFileSync(sus, JSON.stringify({ suspended: [{ id: 'a', expiresAt: recent }, { id: 'b', expiresAt: future }, { id: 'c', expiresAt: null }] }));
    let r = await f.call('health');
    assert.strictEqual(find(r, 'suspensions-json').status, 'ok');
    assert.strictEqual(find(r, 'suspensions-expired').status, 'info'); assert.ok(/^1 suspension/.test(find(r, 'suspensions-expired').title));
    fs.writeFileSync(sus, JSON.stringify({ suspended: [{ id: 'a', expiresAt: old }, { id: 'a2', expiresAt: old }, { nope: 1 }] }));
    r = await f.call('health');
    assert.strictEqual(find(r, 'suspensions-expired').status, 'warn'); assert.ok(/2020-01-01/.test(find(r, 'suspensions-expired').detail));
    assert.strictEqual(find(r, 'suspensions-json').status, 'warn');
    fs.writeFileSync(sus, 'nonsense');
    assert.strictEqual(find(await f.call('health'), 'suspensions-json').status, 'fail');
    fs.writeFileSync(sus, '{"suspended": []}');
    assert.ok(!find(await f.call('health'), 'suspensions-expired'));
    f.srv.stop();
  });

  await check('housekeeping: holdings records are checked for valid JSON, counted, and never shown', async () => {
    const f = await fresh();
    const dir = path.join(f.root, 'lib/holdings');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'h' + i + '.json'), JSON.stringify({ held: { cls: [{ id: 'HOLDING-SECRET-' + i, q: 1 }] } }));
    let c = find(await f.call('health'), 'holdings');
    assert.strictEqual(c.status, 'ok'); assert.ok(/5 records/.test(c.detail));
    fs.writeFileSync(path.join(dir, 'h6.json'), '{ broken');
    fs.writeFileSync(path.join(dir, 'h7.json'), JSON.stringify({ nothing: true }));
    const r = await f.call('health');
    c = find(r, 'holdings');
    assert.strictEqual(c.status, 'fail'); assert.ok(/^2 holdings/.test(c.title));
    assert.ok(!/HOLDING-SECRET/.test(r.text));
    f.srv.stop();
  });

  await check('permissions: world-writable folders and files fail, readable keys warn, and nothing is changed', async () => {
    if (process.platform === 'win32') return;
    const f = await fresh();
    fs.writeFileSync(path.join(f.root, 'lib/issuer-private-key.pem'), 'PEM-SECRET-X');
    fs.chmodSync(path.join(f.root, 'lib/issuer-private-key.pem'), 0o644);
    fs.writeFileSync(path.join(f.root, 'lib/atlas-admin-keys-store.json'), '{"keys":[]}');
    fs.chmodSync(path.join(f.root, 'lib/atlas-admin-keys-store.json'), 0o600);
    let r = await f.call('health');
    let c = find(r, 'modes-readable');
    assert.strictEqual(c.status, 'warn'); assert.ok(/issuer-private-key\.pem \(0644\)/.test(c.detail) && !/admin-keys/.test(c.detail), c.detail);
    fs.chmodSync(path.join(f.root, 'lib'), 0o777);
    c = find(await f.call('health'), 'modes-writable');
    assert.strictEqual(c.status, 'fail'); assert.ok(/lib\//.test(c.detail));
    fs.chmodSync(path.join(f.root, 'lib'), 0o755);
    fs.chmodSync(path.join(f.root, 'lib/issuer-private-key.pem'), 0o600);
    r = await f.call('health');
    assert.strictEqual(find(r, 'modes').status, 'ok');
    assert.strictEqual(fs.statSync(path.join(f.root, 'lib/issuer-private-key.pem')).mode & 0o777, 0o600, 'the doctor changes no modes');
    assert.ok(!/PEM-SECRET-X/.test(r.text));
    f.srv.stop();
  });

  await check('permissions: PHP limits are judged (memory, uploads, post size) and plain values pass', async () => {
    const good = await fresh(['-d', 'memory_limit=256M', '-d', 'upload_max_filesize=16M', '-d', 'post_max_size=20M']);
    let r = await good.call('health');
    assert.deepStrictEqual(['php-memory', 'php-uploads'].map((id) => find(r, id).status), ['ok', 'ok']);
    good.srv.stop();
    const tight = await fresh(['-d', 'memory_limit=32M', '-d', 'upload_max_filesize=1M', '-d', 'post_max_size=512K']);
    r = await tight.call('health');
    assert.strictEqual(find(r, 'php-memory').status, 'warn');
    assert.strictEqual(find(r, 'php-uploads').status, 'warn');
    assert.strictEqual(find(r, 'php-post').status, 'warn');
    tight.srv.stop();
    const unlimited = await fresh(['-d', 'memory_limit=-1']);
    assert.strictEqual(find(await unlimited.call('health'), 'php-memory').status, 'ok');
    unlimited.srv.stop();
  });

  await check('permissions: open_basedir that excludes a configured private folder is a failure', async () => {
    const f = await fresh();
    const outside = fs.mkdtempSync(path.join(tmp, 'private-'));
    fs.writeFileSync(path.join(f.root, 'lib/atlas-private-dir.txt'), outside);
    f.srv.stop();
    const g = await serve(f.root, ['-d', 'open_basedir=' + f.root + ':/tmp/zzz-not-the-private-folder']);
    const r = await g.call(built.token)('health');
    const c = find(r, 'open-basedir');
    assert.ok(c && c.status === 'fail' && c.title.includes(outside), JSON.stringify(c));
    g.stop();
  });

  await check('admin side: the roster is validated and counted; keys are never shown', async () => {
    const f = await fresh();
    const roster = path.join(f.root, 'lib/atlas-admin-keys-store.json');
    let c = find(await f.call('health'), 'admin-keys');
    assert.strictEqual(c.status, 'warn'); assert.ok(/No administrator keys/.test(c.title));
    fs.writeFileSync(roster, '{ nope');
    assert.strictEqual(find(await f.call('health'), 'admin-keys').status, 'fail');
    const K1 = 'ADMINKEY-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', K2 = 'MODKEY-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', K3 = 'OFFKEY-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    fs.writeFileSync(roster, JSON.stringify({ keys: [{ publicKey: K1 }, { publicKey: K2, role: 'moderator' }, { publicKey: K3, revoked: true }] }));
    let r = await f.call('health');
    c = find(r, 'admin-keys');
    assert.strictEqual(c.status, 'ok'); assert.ok(/1 administrator\(s\), 1 moderator\(s\), 1 switched off/.test(c.detail), c.detail);
    assert.ok(!/ADMINKEY|MODKEY|OFFKEY/.test(r.text));
    fs.writeFileSync(roster, JSON.stringify({ keys: [{ publicKey: K2, role: 'moderator' }] }));
    assert.strictEqual(find(await f.call('health'), 'admin-keys').status, 'warn');
    fs.writeFileSync(roster, JSON.stringify({ keys: [{ publicKey: K1 }, { publicKey: K2, role: 'moderater' }] }));
    c = find(await f.call('health'), 'admin-keys');
    assert.strictEqual(c.status, 'warn'); assert.ok(/role/.test(c.fix));
    f.srv.stop();
  });

  await check('admin side: last activity comes from the session store date, and the session store is never opened', async () => {
    const f = await fresh();
    assert.ok(/No administrator has signed in/.test(find(await f.call('health'), 'admin-last').title));
    const sessions = path.join(f.root, 'lib/atlas-admin-sessions-store.json');
    fs.writeFileSync(sessions, JSON.stringify({ sessions: [{ token: 'BEARER-TOKEN-SECRET', publicKey: 'k' }] }));
    const when = new Date('2026-03-04T10:20:00Z'); fs.utimesSync(sessions, when, when);
    const r = await f.call('health');
    assert.ok(/Last administrator activity: 2026-03-04/.test(find(r, 'admin-last').title), find(r, 'admin-last').title);
    assert.strictEqual(find(r, 'admin-stores').status, 'ok');
    assert.ok(!/BEARER-TOKEN-SECRET/.test(r.text));
    f.srv.stop();
  });

  await check('no response ever contained private-state contents or the token', () => {
    const joined = everything.join('\n');
    assert.ok(!joined.includes('SECRET-MARKER-9f3a7c'));
    assert.ok(!joined.includes('BEGIN EC PRIVATE KEY'));
    for (const p of PLANTED) assert.ok(!joined.includes(p), 'a planted secret reached a response: ' + p);
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
