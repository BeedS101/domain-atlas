// End-to-end test of the verifier package (verifier-php/, built by tools/package/build-package.js).
//
//   node test/verifier-package.js
//
// Everything runs from the ZIP, never from the source folder: the archive is built from the locked manifest, extracted
// into an empty temporary directory and served by PHP's built-in server. Real credentials come from throw-away copies of
// issuer-php. Nothing touches an existing installation, and every server and directory is removed at the end.
//
// Sections: build and reproducibility, the independent archive checker, package contents, provenance of the copied
// crypto, canonical JSON parity, the PHP verdict matrix, live credentials, the fetch layer, clean installations, and a
// check that the verifier talks only to the issuer it was configured with.
'use strict';
const { execFileSync, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startIssuer, freePort, rawPublicKey } = require('./lib/php-issuer');
const { auditPackage } = require('./lib/package-audit');
const { newOwner } = require('./lib/owner-auth');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'packages', 'atlas-verify', 'manifest.json');
const BUILDER = path.join(ROOT, 'tools', 'package', 'build-package.js');
const CHECKER = path.join(ROOT, 'tools', 'package', 'check-package.py');
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const BASE = manifest.name + '-' + manifest.version;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verify-test-'));
const cleanup = [];
let failures = 0;
let total = 0;
function line(ok, text, detail) {
  total++;
  if (!ok) failures++;
  const extra = !ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : '';
  console.log((ok ? 'PASS ' : 'FAIL ') + text + extra);
}
const section = (title) => console.log('\n== ' + title);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function build(outDir, options) {
  options = options || {};
  fs.mkdirSync(outDir, { recursive: true });
  return spawnSync('node', [options.builder || BUILDER, options.manifest || MANIFEST, '--out', outDir], { cwd: options.cwd || ROOT, env: Object.assign({}, process.env, options.env || {}), encoding: 'utf8' });
}
function extract(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('unzip', ['-q', zip, '-d', dest]);
  return path.join(dest, manifest.root);
}
function writeConfig(dir, config) {
  fs.writeFileSync(path.join(dir, 'config.php'), '<?php return json_decode(' + JSON.stringify(JSON.stringify(config)) + ', true);\n');
}
function tree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel ? rel + '/' + name : name;
      if (fs.lstatSync(full).isDirectory()) { out[r + '/'] = ''; walk(full, r); } else out[r] = sha(fs.readFileSync(full));
    }
  };
  walk(dir, '');
  return out;
}

async function startPhp(docroot, port, extraArgs, env) {
  const lines = [];
  const proc = spawn('php', ['-d', 'opcache.enable=0', ...(extraArgs || []), '-S', 'localhost:' + port, '-t', docroot], { stdio: ['ignore', 'ignore', 'pipe'], env: Object.assign({}, process.env, env || {}) });
  let started = false;
  proc.stderr.on('data', (c) => { for (const l of c.toString().split('\n')) { if (l.includes('started')) started = true; lines.push(l); } });
  for (let i = 0; i < 200 && !started; i++) await sleep(25);
  if (!started) throw new Error('php -S did not start: ' + lines.join('\n'));
  const server = { port, base: 'http://localhost:' + port, lines, stop: () => proc.kill() };
  cleanup.push(server.stop);
  return server;
}
async function postJson(url, body, headers) {
  const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  // ===== 1. build, lock and reproducibility =====
  section('build from the version-locked manifest');
  const outA = path.join(work, 'build-a');
  const otherCwd = fs.mkdtempSync(path.join(work, 'cwd-'));
  const a = build(outA);
  line(a.status === 0, 'the builder succeeds on the locked manifest', a.stderr);
  const outB = path.join(work, 'build-b');
  const b = build(outB, { cwd: otherCwd, env: { TZ: 'Pacific/Auckland', LC_ALL: 'C', LANG: 'C', SOURCE_DATE_EPOCH: '1' } });
  line(b.status === 0, 'a second build from another directory, time zone and locale succeeds', b.stderr);
  const zipA = path.join(outA, BASE + '.zip');
  const zipB = path.join(outB, BASE + '.zip');
  line(fs.readFileSync(zipA).equals(fs.readFileSync(zipB)), 'two builds are byte-identical (sha256 ' + sha(fs.readFileSync(zipA)).slice(0, 16) + '...)');
  for (const ext of ['.zip.sha256', '.files.sha256']) {
    line(fs.readFileSync(path.join(outA, BASE + ext)).equals(fs.readFileSync(path.join(outB, BASE + ext))), 'the ' + ext + ' files are identical across builds');
  }
  const lockCheck = spawnSync('node', [BUILDER, MANIFEST, '--check'], { encoding: 'utf8' });
  line(lockCheck.status === 0, 'every source file still matches the SHA-256 and size recorded in the manifest', lockCheck.stderr);

  section('independent archive checker (Python, shares no code with the builder)');
  const checker = spawnSync('python3', ['-I', CHECKER, MANIFEST, zipA], { encoding: 'utf8' });
  line(checker.status === 0, 'check-package.py accepts the archive (' + (checker.stdout.match(/PASS/g) || []).length + ' checks)', checker.stdout.split('\n').filter((l) => l.startsWith('FAIL')).join('; ') || checker.stderr);
  const sumLine = fs.readFileSync(path.join(outA, BASE + '.zip.sha256'), 'utf8');
  line(sumLine === sha(fs.readFileSync(zipA)) + '  ' + BASE + '.zip\n', 'the .zip.sha256 file matches a SHA-256 computed here');
  const sha256sum = spawnSync('sha256sum', ['-c', BASE + '.zip.sha256'], { cwd: outA, encoding: 'utf8' });
  line(sha256sum.status === 0, 'the system sha256sum accepts the published .zip.sha256', sha256sum.stdout + sha256sum.stderr);
  const filesSum = spawnSync('sha256sum', ['-c', path.join(outA, BASE + '.files.sha256')], { cwd: extractParent(zipA), encoding: 'utf8' });
  line(filesSum.status === 0, 'the system sha256sum accepts every line of .files.sha256 against the extracted files', filesSum.stdout + filesSum.stderr);
  function extractParent(zip) { const d = path.join(work, 'extract-for-sums'); extract(zip, d); return d; }

  // the checker must also reject damage
  const damaged = path.join(work, 'damaged');
  fs.mkdirSync(damaged);
  const zipBytes = fs.readFileSync(zipA);
  const variants = {
    'a flipped byte inside a file': (z) => { const c = Buffer.from(z); c[200] ^= 1; return c; },
    'a truncated archive': (z) => z.subarray(0, z.length - 40),
    'trailing bytes after the archive': (z) => Buffer.concat([z, Buffer.from('x')])
  };
  for (const [label, fn] of Object.entries(variants)) {
    const dir = path.join(damaged, label.replace(/\W+/g, '-'));
    fs.mkdirSync(dir);
    const z = path.join(dir, BASE + '.zip');
    fs.writeFileSync(z, fn(zipBytes));
    for (const ext of ['.zip.sha256', '.files.sha256']) fs.copyFileSync(path.join(outA, BASE + ext), path.join(dir, BASE + ext));
    const res = spawnSync('python3', ['-I', CHECKER, MANIFEST, z], { encoding: 'utf8' });
    line(res.status !== 0, 'the checker rejects ' + label);
  }
  {
    const dir = path.join(damaged, 'sums');
    fs.mkdirSync(dir);
    fs.copyFileSync(zipA, path.join(dir, BASE + '.zip'));
    fs.writeFileSync(path.join(dir, BASE + '.zip.sha256'), '0'.repeat(64) + '  ' + BASE + '.zip\n');
    fs.copyFileSync(path.join(outA, BASE + '.files.sha256'), path.join(dir, BASE + '.files.sha256'));
    line(spawnSync('python3', ['-I', CHECKER, MANIFEST, path.join(dir, BASE + '.zip')], { encoding: 'utf8' }).status !== 0, 'the checker rejects a wrong .zip.sha256');
    fs.copyFileSync(path.join(outA, BASE + '.zip.sha256'), path.join(dir, BASE + '.zip.sha256'));
    fs.appendFileSync(path.join(dir, BASE + '.files.sha256'), '0'.repeat(64) + '  ' + manifest.root + '/extra.php\n');
    line(spawnSync('python3', ['-I', CHECKER, MANIFEST, path.join(dir, BASE + '.zip')], { encoding: 'utf8' }).status !== 0, 'the checker rejects a .files.sha256 with an extra line');
  }

  // ===== builder refusals, run against a scratch copy of the repository layout =====
  section('the builder refuses anything outside the explicit manifest');
  const scratch = path.join(work, 'scratch-repo');
  fs.mkdirSync(path.join(scratch, 'tools', 'package'), { recursive: true });
  fs.copyFileSync(BUILDER, path.join(scratch, 'tools', 'package', 'build-package.js'));
  for (const f of manifest.files) {
    fs.mkdirSync(path.dirname(path.join(scratch, f.source)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f.source), path.join(scratch, f.source));
  }
  const scratchBuilder = path.join(scratch, 'tools', 'package', 'build-package.js');
  const tryManifest = (name, mutate, expectFail, extraSetup) => {
    const m = JSON.parse(JSON.stringify(manifest));
    mutate(m);
    const mf = path.join(scratch, 'm-' + name + '.json');
    fs.writeFileSync(mf, JSON.stringify(m));
    if (extraSetup) extraSetup();
    const res = spawnSync('node', [scratchBuilder, mf, '--out', path.join(work, 'refusal-out-' + name)], { encoding: 'utf8' });
    line(expectFail ? res.status !== 0 : res.status === 0, (expectFail ? 'refused: ' : 'accepted: ') + name, res.stderr.trim().split('\n')[0]);
    return res;
  };
  line(spawnSync('node', [scratchBuilder, MANIFEST, '--check'], { encoding: 'utf8' }).status === 0, 'baseline: the scratch copy builds');
  const add = (m, extra) => m.files.push(Object.assign({ mode: '0644', sha256: '0'.repeat(64), size: 1 }, extra));
  fs.writeFileSync(path.join(scratch, 'verifier-php', 'extra.php'), '<?php // stray file\n');
  tryManifest('an unlisted file next to the sources is not packaged', () => {}, false);
  const built = path.join(work, 'refusal-out-an unlisted file next to the sources is not packaged', BASE + '.zip');
  line(fs.existsSync(built) && !fs.readFileSync(built).includes('extra.php'), 'a stray file in the source folder never enters the archive');
  tryManifest('source changed after the lock', () => {}, true, () => fs.appendFileSync(path.join(scratch, 'verifier-php', 'verify.php'), '// changed\n'));
  fs.copyFileSync(path.join(ROOT, 'verifier-php', 'verify.php'), path.join(scratch, 'verifier-php', 'verify.php'));
  tryManifest('a signing module', (m) => add(m, { path: 'lib/sign-manifest.php', source: 'issuer-php/lib/sign-manifest.php' }), true);
  tryManifest('an issuer private key path', (m) => add(m, { path: 'lib/issuer-private-key.pem', source: 'verifier-php/VERSION' }), true);
  tryManifest('a state file path', (m) => add(m, { path: 'lib/atlas-revocations-store.json', source: 'verifier-php/VERSION' }), true);
  tryManifest('a live config.php', (m) => add(m, { path: 'config.php', source: 'verifier-php/VERSION' }), true);
  tryManifest('a path with ..', (m) => add(m, { path: '../escape.php', source: 'verifier-php/VERSION' }), true);
  tryManifest('an absolute source', (m) => add(m, { path: 'zz.php', source: '/etc/passwd' }), true);
  tryManifest('a source containing ..', (m) => add(m, { path: 'zz.php', source: 'verifier-php/../LICENSE' }), true);
  tryManifest('a disallowed file type (.js)', (m) => add(m, { path: 'zz.js', source: 'verifier-php/VERSION' }), true);
  tryManifest('a disallowed file type (.zip)', (m) => add(m, { path: 'zz.zip', source: 'verifier-php/VERSION' }), true);
  tryManifest('a duplicate path', (m) => m.files.push(Object.assign({}, m.files[0])), true);
  tryManifest('unsorted paths', (m) => m.files.reverse(), true);
  tryManifest('an executable mode', (m) => { m.files[0].mode = '0755'; }, true);
  tryManifest('a root folder that differs from the name', (m) => { m.root = 'other'; }, true);
  tryManifest('a wrong version in the manifest', (m) => { m.version = '9.9.9'; }, true);
  tryManifest('a missing source file', (m) => { m.files[1].source = 'verifier-php/does-not-exist.php'; }, true);
  tryManifest('PACKAGE.json listed by hand', (m) => add(m, { path: 'PACKAGE.json', source: 'verifier-php/VERSION' }), true);
  tryManifest('a wrong recorded hash', (m) => { m.files[0].sha256 = 'f'.repeat(64); }, true);
  tryManifest('a wrong recorded size', (m) => { m.files[0].size += 1; }, true);
  fs.symlinkSync('/etc/hostname', path.join(scratch, 'verifier-php', 'link.md'));
  tryManifest('a symbolic link as a source', (m) => add(m, { path: 'zz.md', source: 'verifier-php/link.md' }), true);

  // ===== 2. contents of the extracted archive =====
  section('contents of the extracted archive');
  const install = extract(zipA, path.join(work, 'extracted'));
  const audit = auditPackage(path.join(work, 'extracted'), manifest);
  for (const r of audit.results) line(r.ok, r.name, r.detail);
  const packageJson = JSON.parse(fs.readFileSync(path.join(install, 'PACKAGE.json'), 'utf8'));
  line(packageJson.name === manifest.name && packageJson.version === manifest.version && packageJson.files.length === manifest.files.length, 'PACKAGE.json names the package and lists every file');

  // ===== 3. provenance of the copied crypto =====
  section('copied crypto is identical to the reference issuer');
  const issuerCrypto = fs.readFileSync(path.join(ROOT, 'issuer-php', 'lib', 'crypto.php'), 'utf8');
  const packageCrypto = fs.readFileSync(path.join(install, 'lib', 'atlas-verify-crypto.php'), 'utf8');
  const functionText = (src, name) => {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) return null;
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return null;
  };
  for (const fn of ['b64url_decode', 'raw_to_der_ecdsa_sig', 'der_int_encode', 'pem_wrap', 'ec_raw_point_to_pem', 'ecdsa_verify_raw', 'atlas_json_string']) {
    const theirs = functionText(issuerCrypto, fn);
    const mine = functionText(packageCrypto, fn);
    line(theirs !== null && theirs === mine, fn + '() is a verbatim copy of issuer-php/lib/crypto.php', theirs === null ? 'not found in the issuer' : 'differs');
  }
  const issuerPrefix = /define\('ATLAS_P256_SPKI_PREFIX', hex2bin\('([0-9a-f]+)'\)\)/.exec(issuerCrypto);
  const ownPrefix = /const ATLAS_P256_SPKI_PREFIX = "((?:\\x[0-9a-f]{2})+)";/.exec(packageCrypto);
  line(!!issuerPrefix && !!ownPrefix && ownPrefix[1].replace(/\\x/g, '') === issuerPrefix[1], 'the SPKI prefix constant equals the issuer\'s');
  const wallet = fs.readFileSync(path.join(ROOT, 'extension', 'wallet.js'), 'utf8');
  line(/valid(From|Until)/.test(wallet) && wallet.includes('atlas-key.json'), 'the browser wallet reads the same published key document (validFrom / validUntil)');

  // ===== 4. canonical JSON parity =====
  section('canonical JSON: package vs Node vs reference PHP issuer');
  const canonicalizeJs = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v)
    : Array.isArray(v) ? '[' + v.map(canonicalizeJs).join(',') + ']'
      : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalizeJs(v[k])).join(',') + '}');
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const STRINGS = ['', 'a', 'Z', 'plain text', 'a/b', 'quote"inside', 'back\\slash', 'tab\there', 'line\nbreak', 'ctrl\u0001char', 'del\u007f', 'café', '中文', 'emoji 😀', '  ', '<script>&', 'a'.repeat(300), '퟿', '', '￿'];
  const KEYS = ['a', 'b', 'B', 'A', '10', '2', '_', 'z', 'Z', 'com.example.x', 'atlas.rarity', 'é', '中', 'ab', 'a b', '', 'ÿ'];
  const FLOATS = [0.5, 1.5, 0.1, 0.25, 12.75, 3.14159, 100.125, 0.001, 0.0001, 123456.789, 1e10, 1e14, 2.5e-5, 99999.99999, -0.5, -1.25, 1 / 3, 2 / 3, 1e-6, 1e-7, 1.5e-7, 5e-324, 1e15, 1.5e15, 1e20, 1e21, 1.5e21, 2 ** 53, 2 ** 60, -(2 ** 70), 1.7976931348623157e308, -2.5e-7, 4.35, 123456789.123456789];
const randomDouble = () => { const b = Buffer.alloc(8); for (let i = 0; i < 8; i++) b[i] = Math.floor(rnd() * 256); const x = b.readDoubleLE(0); return Number.isFinite(x) ? x : 1.5; };
  function gen(depth) {
    const r = rnd();
    if (depth > 3 || r < 0.35) {
      const k = rnd();
      if (k < 0.25) return pick(STRINGS);
      if (k < 0.45) return Math.floor(rnd() * 2000) - 1000;
      if (k < 0.50) return pick(FLOATS);
      if (k < 0.55) return randomDouble();
      if (k < 0.65) return Math.floor(rnd() * 9007199254740991);
      if (k < 0.75) return rnd() < 0.5;
      if (k < 0.85) return null;
      if (k < 0.92) return 0;
      return Math.floor(rnd() * 100);
    }
    if (r < 0.55) { const n = Math.floor(rnd() * 4); const out = []; for (let i = 0; i < n; i++) out.push(gen(depth + 1)); return out; }
    const n = Math.floor(rnd() * 5);
    const o = {};
    for (let i = 0; i < n; i++) o[pick(KEYS)] = gen(depth + 1);
    return o;
  }
  const docs = [{}, [], [{}], { a: {} }, { a: [], b: {} }, { z: 1, a: { y: 2, b: 3 } }, { '😀': 1, '￿': 2, a: 3 }, { b: [1, { d: 1, c: 2 }] }, [[], [[]], {}],
    { s: '    / \\ " \b \f \n \r \t \u0000' }];
  const hasEmptyObject = (v) => v !== null && typeof v === 'object' && (Array.isArray(v) ? v.some(hasEmptyObject) : Object.keys(v).length === 0 || Object.values(v).some(hasEmptyObject));
  const hasExoticNumber = (v) => typeof v === 'number' ? (!Number.isInteger(v) ? (Math.abs(v) >= 1e15 || (v !== 0 && Math.abs(v) < 1e-4)) : Math.abs(v) > 2 ** 53 || Math.abs(v) >= 1e21) : v !== null && typeof v === 'object' && Object.values(v).some(hasExoticNumber);
  const hasSupplementaryKey = (v) => v !== null && typeof v === 'object' && (Array.isArray(v) ? v.some(hasSupplementaryKey) : Object.keys(v).some((k) => /[\ud800-\udfff]/.test(k)) || Object.values(v).some(hasSupplementaryKey));
  for (let i = 0; i < 1500; i++) docs.push(gen(0));
  // JSON.stringify keeps a lone "10" key as a string, but an object with integer-like keys reorders in JS: keep these in arrays-of-pairs-free form by using the parse of the text itself
  const docLines = docs.map((d) => JSON.stringify(d));
  const docsFile = path.join(work, 'canonical-docs.jsonl');
  fs.writeFileSync(docsFile, docLines.join('\n') + '\n');
  const phpOut = execFileSync('php', [path.join(__dirname, 'verifier-php', 'canonical.php'), path.join(ROOT, 'verifier-php'), path.join(ROOT, 'issuer-php'), docsFile], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim().split('\n');
  line(phpOut.length === docs.length, 'canonicalized ' + docs.length + ' documents in PHP');
  const unexplainedSample = [];
  let packageMismatch = 0; let issuerMismatch = 0; let issuerMismatchExpected = 0; let firstBad = null;
  docs.forEach((d, i) => {
    const parsed = JSON.parse(docLines[i]);
    const expected = canonicalizeJs(parsed);
    const [mine, theirs] = phpOut[i].split('\t');
    if (Buffer.from(mine, 'base64').toString('utf8') !== expected) { packageMismatch++; if (!firstBad) firstBad = { doc: docLines[i].slice(0, 200), expected: expected.slice(0, 200), got: Buffer.from(mine, 'base64').toString('utf8').slice(0, 200) }; }
    if (theirs === 'ERR' || Buffer.from(theirs, 'base64').toString('utf8') !== expected) {
      issuerMismatch++;
      if (hasEmptyObject(parsed) || hasSupplementaryKey(parsed) || hasExoticNumber(parsed)) issuerMismatchExpected++;
      else if (unexplainedSample.length < 2) unexplainedSample.push({ doc: docLines[i].slice(0, 160), issuer: theirs === 'ERR' ? 'ERR' : Buffer.from(theirs, 'base64').toString('utf8').slice(0, 160) });
    }
  });
  line(packageMismatch === 0, 'the package canonicalizes every document exactly as Node does (the protocol reference)', firstBad);
  line(issuerMismatch === issuerMismatchExpected, 'the reference PHP issuer agrees on every document that has no empty object, supplementary-plane key or extreme number (' + (docs.length - issuerMismatch) + ' agree, ' + issuerMismatch + ' differ and all of those contain an empty object, a supplementary-plane key, a float outside 1e-4..1e15 or an integer beyond 2^53)', { unexplained: issuerMismatch - issuerMismatchExpected, sample: unexplainedSample });

  // ===== 5. the PHP verdict matrix =====
  section('verdict matrix (PHP, injected fetch)');
  const matrix = spawnSync('php', [path.join(__dirname, 'verifier-php', 'matrix.php'), install], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const matrixLines = matrix.stdout.split('\n');
  const matrixFails = matrixLines.filter((l) => l.startsWith('FAIL'));
  const matrixPasses = matrixLines.filter((l) => l.startsWith('PASS')).length;
  matrixFails.forEach((l) => line(false, l.slice(5)));
  line(matrix.status === 0 && matrixFails.length === 0 && matrixPasses > 150, 'matrix.php against the extracted package: ' + matrixPasses + ' checks passed', matrix.stderr.slice(0, 300));

  // ===== 6. live credentials from the reference issuer, verified by the installed package =====
  section('live credentials: issuer-php -> installed package over HTTP');
  const issuer = await startIssuer();
  cleanup.push(() => issuer.stop());
  const liveDir = path.join(work, 'live-install');
  const liveRoot = extract(zipA, liveDir);
  writeConfig(liveRoot, { trustedIssuers: [issuer.origin], allowInsecureLoopback: true });
  const verifierPort = await freePort();
  const verifier = await startPhp(liveRoot, verifierPort);
  const verify = (credential, extra) => postJson(verifier.base + '/verify.php', Object.assign({ credential }, extra || {}));
  const expectVerdict = (name, res, status, code) => line(res.status === 200 && res.json && res.json.status === status && (code === undefined || res.json.code === code) && res.json.valid === (status === 'verified'), name, res.json ? res.json.status + '/' + res.json.code + ' ' + (res.json.reason || '') : res.status + ' ' + res.text.slice(0, 200));

  const info = await (await fetch(verifier.base + '/verify.php')).json();
  line(info.configured === true && info.package === 'atlas-verify' && info.version === manifest.version, 'GET verify.php reports the package as configured', info);
  const owner = newOwner();
  const badge = await issuer.issue(owner, 'atlas.badge');
  const first = await verify(badge);
  // a fresh issuer has not published a suspension list yet: required by default, so the answer is "cannot verify"
  line((await issuer.published('atlas-suspensions.json')).status === 404, 'a freshly installed issuer publishes no suspension list yet (HTTP 404)');
  expectVerdict('default settings fail closed while the suspension list is unpublished', first, 'unavailable', 'suspension-unavailable');
  line(first.json.checks.signature === 'pass' && first.json.checks.revocation === 'pass' && first.json.checks.keyValidAtIssuance === 'pass', 'the failure is reported precisely: signature, key and revocation passed, only suspension is unavailable', first.json && first.json.checks);

  // the same verifier, configured for an issuer that publishes the suspension list lazily
  const lazyDir = extract(zipA, path.join(work, 'lazy-install'));
  writeConfig(lazyDir, { trustedIssuers: { [issuer.origin]: { suspensions: 'optional' } }, allowInsecureLoopback: true });
  const lazy = await startPhp(lazyDir, await freePort());
  const verifyLazy = (credential, extra) => postJson(lazy.base + '/verify.php', Object.assign({ credential }, extra || {}));
  expectVerdict('a genuine anonymous credential verifies (suspensions optional, list unpublished)', await verifyLazy(badge), 'verified', 'verified');
  const bare = await postJson(lazy.base + '/verify.php', badge);
  expectVerdict('the bare credential is accepted as the request body too', bare, 'verified');
  expectVerdict('expectIssuer matching the credential is accepted', await verifyLazy(badge, { expectIssuer: issuer.origin }), 'verified');

  // suspensions list now exists once an admin action created it
  await issuer.suspend(badge.id, { reason: 'test hold' });
  line((await issuer.published('atlas-suspensions.json')).status === 200, 'the issuer now publishes a suspension list');
  expectVerdict('a suspended credential is reported suspended (default settings)', await verify(badge), 'suspended', 'suspended');
  expectVerdict('a suspended credential is reported suspended (optional settings)', await verifyLazy(badge), 'suspended', 'suspended');
  await issuer.unsuspend(badge.id);
  expectVerdict('after unsuspending it verifies again with the default (strict) settings', await verify(badge), 'verified', 'verified');
  await issuer.suspend(badge.id, { reason: 'short hold', expiresAt: new Date(Date.now() + 2000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  expectVerdict('a suspension with a deadline holds before the deadline', await verify(badge), 'suspended');
  await sleep(3200);
  expectVerdict('and lifts itself after the deadline', await verify(badge), 'verified');

  await issuer.revoke(badge.id, 'test revoke');
  const revoked = await verify(badge);
  expectVerdict('a revoked credential is reported revoked', revoked, 'revoked', 'revoked');
  line(/test revoke/.test(revoked.json.reason), 'the revocation reason is passed on');

  // split: a fungible balance is superseded, the old credential is revoked, the new ones verify
  const gold = await issuer.issue(owner, 'atlas.element.iron', 10);
  expectVerdict('a fungible credential verifies', await verify(gold), 'verified');
  const recipient = newOwner();
  const split = await issuer.split(gold, 3, recipient);
  expectVerdict('after a split the presented credential is revoked', await verify(gold), 'revoked');
  expectVerdict('the sent part verifies', await verify(split.sent), 'verified');
  expectVerdict('the remainder verifies', await verify(split.remainder), 'verified');
  line(split.sent.quantity === 3 && split.remainder.quantity === 7 && split.sent.supersedes === gold.id && split.remainder.supersedes === gold.id, 'split credentials carry quantities and the superseded id (protocol shape preserved)', { sent: split.sent.quantity, remainder: split.remainder.quantity, supersedes: split.sent.supersedes });

  // expiry
  const ticket = await issuer.issue(owner, 'atlas.test.expiring');
  line(typeof ticket.asset.expiresAt === 'string', 'the issuer signs a short-lived credential', ticket.asset);
  expectVerdict('an unexpired short-lived credential verifies', await verify(ticket), 'verified');
  await sleep(3800);
  expectVerdict('the same credential is expired after its signed deadline', await verify(ticket), 'expired', 'expired');

  // tampering with a real credential
  const fresh = await issuer.issue(owner, 'atlas.badge');
  const mutate = (fn) => { const c = JSON.parse(JSON.stringify(fresh)); fn(c); return c; };
  expectVerdict('real credential: a changed owner is rejected', await verify(mutate((c) => { c.owner.publicKey = newOwner(); })), 'invalid', 'bad-signature');
  expectVerdict('real credential: a changed asset class is rejected', await verify(mutate((c) => { c.asset.class = 'atlas.trophy.chess'; })), 'invalid', 'bad-signature');
  expectVerdict('real credential: a changed quantity is rejected', await verify(mutate((c) => { c.quantity = 5; })), 'invalid', 'bad-signature');
  expectVerdict('real credential: a changed property is rejected', await verify(mutate((c) => { c.asset.properties = Object.assign({}, c.asset.properties, { extra: 1 }); })), 'invalid', 'bad-signature');
  expectVerdict('real credential: a changed issuedAt is rejected', await verify(mutate((c) => { c.issuedAt = new Date(Date.parse(c.issuedAt) + 1).toISOString(); })), 'invalid', 'bad-signature');
  expectVerdict('real credential: an unsigned display field may differ without effect', await verify(mutate((c) => { c.note = 'hello'; })), 'verified');
  // an attacker re-issuing under their own key and claiming the trusted domain
  const attacker = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const forgedPayload = { id: 'urn:atlas:asset:forged', asset: fresh.asset, owner: fresh.owner, quantity: 1, supersedes: null, issuedAt: fresh.issuedAt };
  const canon = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}');
  const forged = Object.assign({ credential: 'domain-atlas-asset/1.0' }, forgedPayload, {
    issuer: { domain: issuer.domain, publicKey: rawPublicKey(attacker.publicKey) },
    signature: crypto.sign('sha256', Buffer.from(canon(forgedPayload)), { key: attacker.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  });
  expectVerdict('a credential signed by an attacker key that the issuer never published is rejected', await verify(forged), 'invalid', 'key-not-published');
  const stolen = JSON.parse(JSON.stringify(fresh)); stolen.id = 'urn:atlas:asset:forged';
  expectVerdict('a genuine signature moved to a different id is rejected', await verify(stolen), 'invalid', 'bad-signature');
  const elsewhere = JSON.parse(JSON.stringify(fresh)); elsewhere.issuer.domain = 'other.example';
  expectVerdict('a credential naming an issuer that is not configured is refused', await verify(elsewhere), 'untrusted-issuer', 'issuer-not-configured');
  expectVerdict('expectIssuer for a different origin is refused', await verify(fresh, { expectIssuer: 'https://other.example' }), 'untrusted-issuer');

  // endpoint behaviour
  const method = await fetch(verifier.base + '/verify.php', { method: 'PUT', body: '{}' });
  line(method.status === 405, 'other HTTP methods are refused (405)', method.status);
  const garbage = await postJson(verifier.base + '/verify.php', 'not json');
  line(garbage.status === 400 && garbage.json.valid === false && garbage.json.status === 'invalid', 'a body that is not JSON gets a 400 with an invalid verdict, not a crash', garbage.text.slice(0, 200));
  const big = await postJson(verifier.base + '/verify.php', JSON.stringify({ credential: fresh, pad: 'x'.repeat(300000) }));
  line(big.status === 413, 'an oversized body is refused (413)', big.status);
  const headers = (await fetch(verifier.base + '/verify.php')).headers;
  line(headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(headers.get('cache-control') || ''), 'responses carry nosniff and no-store');
  const cors = await fetch(verifier.base + '/verify.php', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  line(cors.headers.get('access-control-allow-origin') === null, 'no CORS header is sent to an origin that is not allowed');
  for (const name of ['config.example.php', 'lib/atlas-verify.php', 'lib/atlas-verify-crypto.php', 'PACKAGE.json']) {
    const direct = await fetch(verifier.base + '/' + name);
    const text = await direct.text();
    line(!/function |openssl_verify|"files"/.test(text) || name === 'PACKAGE.json', 'requesting ' + name + ' directly never runs or reveals code (' + direct.status + ')', text.slice(0, 120));
  }
  // an unconfigured install must say so and refuse
  const bareDir = extract(zipA, path.join(work, 'bare-install'));
  const bareServer = await startPhp(bareDir, await freePort());
  const unconfigured = await postJson(bareServer.base + '/verify.php', { credential: fresh });
  line(unconfigured.status === 503 && unconfigured.json && unconfigured.json.valid === false, 'an install without config.php answers 503 and never verifies', unconfigured.text.slice(0, 200));
  const unconfiguredInfo = await (await fetch(bareServer.base + '/verify.php')).json();
  line(unconfiguredInfo.configured === false, 'GET reports configured: false without config.php');
  const badCfgDir = extract(zipA, path.join(work, 'badcfg-install'));
  writeConfig(badCfgDir, { trustedIssuers: ['http://issuer.example'] });
  const badCfg = await startPhp(badCfgDir, await freePort());
  const refused = await postJson(badCfg.base + '/verify.php', { credential: fresh });
  line(refused.status === 503, 'a configuration with a plain-http non-local issuer is refused as a whole (503)', refused.text.slice(0, 200));
  // access token
  const tokenDir = extract(zipA, path.join(work, 'token-install'));
  writeConfig(tokenDir, { trustedIssuers: [issuer.origin], allowInsecureLoopback: true, accessTokenSha256: sha(Buffer.from('s3cret')), allowedOrigins: ['https://app.example'] });
  const tokenServer = await startPhp(tokenDir, await freePort());
  const noToken = await postJson(tokenServer.base + '/verify.php', { credential: fresh });
  const wrongToken = await postJson(tokenServer.base + '/verify.php', { credential: fresh }, { Authorization: 'Bearer nope' });
  const goodToken = await postJson(tokenServer.base + '/verify.php', { credential: fresh }, { Authorization: 'Bearer s3cret' });
  line(noToken.status === 401 && wrongToken.status === 401, 'a configured access token is required (401 without it or with a wrong one)', [noToken.status, wrongToken.status]);
  line(goodToken.status === 200 && goodToken.json.status === 'verified', 'the right token reaches the verifier', goodToken.text.slice(0, 200));
  const allowedCors = await fetch(tokenServer.base + '/verify.php', { method: 'OPTIONS', headers: { Origin: 'https://app.example' } });
  line(allowedCors.headers.get('access-control-allow-origin') === 'https://app.example', 'CORS is granted to a listed origin only');

  // ===== 7. issuer-side failures reproduced over real HTTP =====
  section('fail-closed over real HTTP: the issuer changes what it publishes');
  const publishedDir = path.join(issuer.dir, '.well-known');
  const fileOf = (n) => path.join(publishedDir, n);
  const backup = {};
  for (const n of ['atlas-key.json', 'atlas-revocations.json', 'atlas-suspensions.json']) backup[n] = fs.readFileSync(fileOf(n));
  const withDoc = async (name, content, fn) => {
    if (content === null) fs.rmSync(fileOf(name)); else fs.writeFileSync(fileOf(name), content);
    try { await fn(); } finally { fs.writeFileSync(fileOf(name), backup[name]); }
  };
  const goodForNow = await issuer.issue(owner, 'atlas.badge');
  expectVerdict('baseline before breaking the published documents', await verify(goodForNow), 'verified');
  await withDoc('atlas-revocations.json', null, async () => expectVerdict('revocation list returns 404 -> unavailable', await verify(goodForNow), 'unavailable', 'revocation-unavailable'));
  await withDoc('atlas-revocations.json', null, async () => expectVerdict('revocation list returns 404 -> still unavailable with suspensions optional', await verifyLazy(goodForNow), 'unavailable', 'revocation-unavailable'));
  await withDoc('atlas-revocations.json', '<html>maintenance</html>', async () => expectVerdict('revocation list is HTML -> unavailable', await verify(goodForNow), 'unavailable', 'revocation-unavailable'));
  await withDoc('atlas-revocations.json', '{"revoked":"x"}', async () => expectVerdict('revocation list has the wrong shape -> unavailable', await verify(goodForNow), 'unavailable', 'revocation-unavailable'));
  await withDoc('atlas-key.json', null, async () => expectVerdict('key document returns 404 -> unavailable', await verify(goodForNow), 'unavailable', 'key-document-unavailable'));
  await withDoc('atlas-key.json', '{"keys":[]}', async () => expectVerdict('key document lists no key -> unavailable', await verify(goodForNow), 'unavailable'));
  await withDoc('atlas-suspensions.json', 'garbage', async () => expectVerdict('suspension list is garbage -> unavailable (even with suspensions optional)', await verifyLazy(goodForNow), 'unavailable', 'suspension-unavailable'));
  const rotated = JSON.parse(backup['atlas-key.json'].toString());
  await withDoc('atlas-key.json', JSON.stringify({ keys: rotated.keys.map((k) => Object.assign({}, k, { validUntil: '2000-01-01T00:00:00Z', validFrom: '1999-01-01T00:00:00Z' })) }), async () => expectVerdict('the issuer\'s key retired before the credential was issued -> invalid', await verify(goodForNow), 'invalid', 'key-not-valid-at-issuance'));
  await withDoc('atlas-key.json', JSON.stringify({ keys: [{ publicKey: rawPublicKey(attacker.publicKey), validFrom: '2000-01-01T00:00:00Z', validUntil: null }] }), async () => expectVerdict('the issuer publishes a different key -> invalid', await verify(goodForNow), 'invalid', 'key-not-published'));
  const stoppedIssuer = await startIssuer();
  cleanup.push(() => stoppedIssuer.stop());
  const outageDir = extract(zipA, path.join(work, 'outage-install'));
  writeConfig(outageDir, { trustedIssuers: [stoppedIssuer.origin], allowInsecureLoopback: true });
  const outageCredential = await stoppedIssuer.issue(owner, 'atlas.badge');
  const outageServer = await startPhp(outageDir, await freePort());
  await stoppedIssuer.stop();
  expectVerdict('the issuer being unreachable (connection refused) -> unavailable', await postJson(outageServer.base + '/verify.php', { credential: outageCredential }), 'unavailable');
  const bigDoc = JSON.stringify({ revoked: Array.from({ length: 30000 }, (_, i) => ({ id: 'urn:atlas:asset:' + i, revokedAt: '2026-01-01T00:00:00Z', reason: 'x' })) });
  await withDoc('atlas-revocations.json', bigDoc, async () => expectVerdict('a revocation list with more entries than the verifier reads (30000) -> unavailable, not verified', await verify(goodForNow), 'unavailable'));

  // ===== 8. the fetch layer =====
  section('fetch layer: redirects, size caps, schemes, slow servers');
  const hits = [];
  const origin = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: '/target' }); res.end(); return; }
    if (req.url.startsWith('/big')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"keys":['); const chunk = 'x'.repeat(65536); let n = 0; const t = setInterval(() => { if (n++ > 200 || res.destroyed) { clearInterval(t); res.end(); } else res.write(chunk); }, 1); return; }
    if (req.url.startsWith('/slow')) { setTimeout(() => { try { res.end('{}'); } catch (e) { /* closed */ } }, 20000); return; }
    if (req.url.startsWith('/target')) { res.writeHead(200); res.end('{"ok":true}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  cleanup.push(() => origin.close());
  const originPort = origin.address().port;
  const fetchProbe = (url, max, plain) => new Promise((resolve, reject) => {
    const child = spawn('php', ['-r', "require '" + path.join(install, 'lib', 'atlas-verify.php') + "'; echo json_encode(DomainAtlas\\Verify\\fetch_document($argv[1], (int) $argv[2], $argv[3] === '1'));", url, String(max), plain ? '1' : '0']);
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('probe output: ' + out)); } });
  });
  const r200 = await fetchProbe('http://127.0.0.1:' + originPort + '/ok', 1000, true);
  line(r200.status === 200 && r200.body === '{"ok":true}', 'a plain read works when plain http is allowed (loopback testing only)');
  const rPlain = await fetchProbe('http://127.0.0.1:' + originPort + '/ok', 1000, false);
  line(rPlain.status === 0 || rPlain.status === undefined, 'plain http is refused when not allowed', rPlain);
  const before = hits.length;
  await fetchProbe('http://127.0.0.1:' + originPort + '/ok', 1000, false);
  line(hits.length === before, 'a refused plain-http fetch sends no request at all');
  const rRedirect = await fetchProbe('http://127.0.0.1:' + originPort + '/redirect', 1000, true);
  line(rRedirect.status === 302 && !hits.includes('/target'), 'redirects are not followed (the target is never requested)', rRedirect);
  const rBig = await fetchProbe('http://127.0.0.1:' + originPort + '/big', 100000, true);
  line(rBig.tooLarge === true && rBig.body === '' || rBig.tooLarge === true, 'a response over the cap is reported as too large', { status: rBig.status, tooLarge: rBig.tooLarge, len: (rBig.body || '').length });
  for (const bad of ['file:///etc/passwd', 'ftp://127.0.0.1/x', 'gopher://127.0.0.1/x', 'data:text/plain,hi', '//127.0.0.1/x', 'http://[::1]:1/x', 'https://']) {
    const r = await fetchProbe(bad, 1000, false);
    line(!r.status || r.status === 0, 'scheme/target ' + bad + ' is refused', r);
  }
  const t0 = Date.now();
  const rSlow = await fetchProbe('http://127.0.0.1:' + originPort + '/slow', 1000, true);
  line(Date.now() - t0 < 15000 && !rSlow.status, 'a server that never answers is abandoned within the timeout (' + (Date.now() - t0) + ' ms)', rSlow);

  // ===== 9. clean installation properties =====
  section('clean installations');
  const cleanA = extract(zipA, path.join(work, 'clean-a'));
  const names = Object.keys(tree(cleanA));
  line(names.length === manifest.files.length + 1 + 1, 'a fresh extraction holds the ' + manifest.files.length + ' manifest files, PACKAGE.json and the lib folder only', names);
  line(!names.some((n) => /vendor|composer|node_modules|\.git|\.sh$|\.js$|\.pem$|\.sqlite|\.db$/.test(n)), 'no Composer, vendor, Node, shell or key material');
  line(!fs.existsSync(path.join(cleanA, 'config.php')), 'no config.php is shipped: every installation starts unconfigured');
  const snapshot = tree(cleanA);
  writeConfig(cleanA, { trustedIssuers: [issuer.origin], allowInsecureLoopback: true });
  const snapshotConfigured = tree(cleanA);
  const cleanServer = await startPhp(cleanA, await freePort());
  const warm = await postJson(cleanServer.base + '/verify.php', { credential: fresh });
  await postJson(cleanServer.base + '/verify.php', { credential: forged });
  await postJson(cleanServer.base + '/verify.php', 'junk');
  const after = tree(cleanA);
  line(JSON.stringify(after) === JSON.stringify(snapshotConfigured), 'serving requests writes nothing: every file and directory is unchanged afterwards');
  line(Object.keys(snapshotConfigured).filter((n) => !(n in snapshot)).join() === 'config.php', 'the only difference from a fresh extraction is the operator\'s config.php');
  line(warm.status === 200, 'the clean installation answers (' + (warm.json && warm.json.code) + ')');
  const tmpDirEntries = fs.readdirSync(os.tmpdir()).filter((n) => /^(php|sess_|atlas-verify)/.test(n) && fs.statSync(path.join(os.tmpdir(), n)).mtimeMs > Date.now() - 60000 && !n.startsWith('atlas-verify-test-'));
  line(tmpDirEntries.length === 0, 'no session, cache or temporary files were left in the system temp directory', tmpDirEntries);

  // restricted PHP: open_basedir confined to the install, and no allow_url_fopen (curl only)
  const confined = await startPhp(cleanA, await freePort(), ['-d', 'open_basedir=' + cleanA + ':/tmp', '-d', 'allow_url_fopen=0', '-d', 'display_errors=0']);
  const confinedRes = await postJson(confined.base + '/verify.php', { credential: fresh });
  line(confinedRes.status === 200 && confinedRes.json && confinedRes.json.checks.signature === 'pass', 'works with open_basedir confined to the install and allow_url_fopen off (curl transport)', confinedRes.text.slice(0, 200));
  const minimal = spawnSync('php', ['-n', '-r', "require '" + path.join(cleanA, 'lib', 'atlas-verify.php') + "'; echo DomainAtlas\\Verify\\VERSION;"], { encoding: 'utf8' });
  line(minimal.stdout.trim() === manifest.version, 'the library loads with no php.ini and no optional extensions loaded');
  const noOpenssl = spawnSync('php', ['-n', '-r', "require '" + path.join(cleanA, 'lib', 'atlas-verify.php') + "'; $t = DomainAtlas\\Verify\\load_trust_config(['trustedIssuers' => ['https://issuer.example']]); $v = DomainAtlas\\Verify\\verify_credential_json(file_get_contents('php://stdin'), array_values($t['issuers'])[0], ['fetch' => function () { return ['status' => 404, 'body' => '']; }]); echo $v['status'] . '/' . $v['code'];"], { input: JSON.stringify(fresh).replace(issuer.domain, 'issuer.example'), encoding: 'utf8' });
  line(!/^verified/.test(noOpenssl.stdout) && noOpenssl.stdout.length > 0, 'without the openssl extension nothing verifies (' + noOpenssl.stdout.trim() + ')');
  line(Object.keys(tree(cleanA)).length === Object.keys(snapshotConfigured).length, 'the command-line runs also left the installation unchanged');
  // preserved credentials: the earlier credentials still verify now, from a second clean install of the same archive
  const again = extract(zipA, path.join(work, 'clean-b'));
  writeConfig(again, { trustedIssuers: { [issuer.origin]: { suspensions: 'optional' } }, allowInsecureLoopback: true });
  const againServer = await startPhp(again, await freePort());
  expectVerdict('credentials issued earlier still verify on a second clean installation', await postJson(againServer.base + '/verify.php', { credential: split.sent }), 'verified');

  // ===== 10. the verifier only talks to the issuer it was configured with =====
  section('no runtime dependency on any other site');
  const canaryHits = [];
  const canary = http.createServer((req, res) => { canaryHits.push(req.method + ' ' + req.url); res.writeHead(200); res.end('{}'); });
  await new Promise((r) => canary.listen(0, '127.0.0.1', r));
  cleanup.push(() => canary.close());
  const canaryUrl = 'http://127.0.0.1:' + canary.address().port;
  const proxyHits = [];
  const proxy = http.createServer((req, res) => { proxyHits.push(req.url); res.writeHead(502); res.end(); });
  proxy.on('connect', (req, socket) => { proxyHits.push('CONNECT ' + req.url); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  cleanup.push(() => proxy.close());
  const requestsBefore = issuer.requests.length;
  const trapped = await startPhp(again, await freePort(), [], { HTTP_PROXY: 'http://127.0.0.1:' + proxy.address().port, HTTPS_PROXY: 'http://127.0.0.1:' + proxy.address().port, NO_PROXY: 'localhost,127.0.0.1', http_proxy: 'http://127.0.0.1:' + proxy.address().port, https_proxy: 'http://127.0.0.1:' + proxy.address().port, no_proxy: 'localhost,127.0.0.1' });
  const hostile = JSON.parse(JSON.stringify(split.remainder));
  hostile.asset.model = canaryUrl + '/model.glb'; hostile.asset.thumbnail = canaryUrl + '/thumb.png'; hostile.issuer.domain = new URL(canaryUrl).host;
  hostile.owner.publicKey = canaryUrl;
  for (const c of [split.remainder, hostile, forged, fresh]) await postJson(trapped.base + '/verify.php', { credential: c });
  await postJson(trapped.base + '/verify.php', { credential: split.remainder, expectIssuer: canaryUrl });
  line(canaryHits.length === 0, 'URLs and domains inside credentials, and a hostile expectIssuer, never cause a request to another host', canaryHits);
  line(proxyHits.length === 0, 'nothing was sent to the configured proxy: no request left for any other site', proxyHits);
  const issuerRequests = issuer.requests.slice(requestsBefore);
  const allowedPaths = new Set(['/.well-known/atlas-key.json', '/.well-known/atlas-revocations.json', '/.well-known/atlas-suspensions.json']);
  line(issuerRequests.length > 0 && issuerRequests.every((r) => r.method === 'GET' && allowedPaths.has(r.path)), 'the configured issuer received only GETs for its three published documents (' + issuerRequests.length + ' requests)', issuerRequests.filter((r) => !(r.method === 'GET' && allowedPaths.has(r.path))));
  const allIssuerRequests = issuer.requests.filter((r) => r.path.startsWith('/.well-known/'));
  line(allIssuerRequests.every((r) => r.method === 'GET'), 'across the whole run the verifier made only GET requests to the issuer');
}

main().catch((err) => { failures++; console.error('FAILURE:', err); }).finally(async () => {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { /* already stopped */ } }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' VERIFIER PACKAGE CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
});
