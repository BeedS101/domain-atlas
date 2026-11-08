// Pinned test-domain verifier installer: positive, negative and repeat-install tests.
// Runs only on local throw-away directories; never contacts live issuers or a remote host.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const builder = require('../tools/package/build-package');

const repo = path.resolve(__dirname, '..');
const library = path.join(repo, 'tools/installer/verified-install.php');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verifier-installer-test-'));
const manifest = builder.readManifest(path.join(repo, 'packages/atlas-verify/manifest.json'));
const sources = builder.loadSources(manifest);
const built = builder.build(manifest, sources);
const packagePath = path.join(tmp, 'atlas-verify-0.1.1.zip');
fs.writeFileSync(packagePath, built.zip);
const known = sources.map(({ f, data }) => ({ name: 'atlas-verify/' + f.path, data }));
known.push({ name: 'atlas-verify/PACKAGE.json', data: builder.packageJson(manifest, sources) });
let checks = 0;

function sandbox(name) {
  const base = path.join(tmp, name);
  fs.mkdirSync(base);
  const web = path.join(base, 'web');
  const priv = path.join(base, 'private');
  fs.mkdirSync(web);
  fs.mkdirSync(priv, { mode: 0o700 });
  fs.chmodSync(priv, 0o700);
  fs.writeFileSync(path.join(web, '.atlas-isolated-test-host'), 'test.example');
  fs.writeFileSync(path.join(web, 'unrelated.txt'), 'KEEP ME');
  return { base, web, priv, settings: {
    documentRoot: web,
    privateDirectory: priv,
    expectedHost: 'test.example',
    trustedIssuers: ['https://issuer.example', 'https://SECOND.example:443'],
    suspensions: 'required'
  }};
}
const harness = [
  'require ' + JSON.stringify(library) + ';',
  '$s = json_decode(file_get_contents($argv[1]), true);',
  'try {',
  '  $out = atlas_install_verifier($argv[2], $s, $argv[3] === "install");',
  '  echo json_encode(["ok"=>true,"out"=>$out]);',
  '} catch (Throwable $e) {',
  '  echo json_encode(["ok"=>false,"error"=>$e->getMessage()]); exit(1);',
  '}'
].join('\n');
function invoke(box, zip, mode = 'check') {
  const file = path.join(box.base, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(box.settings));
  const p = cp.spawnSync('php', ['-r', harness, file, zip, mode], { encoding: 'utf8', timeout: 25000 });
  assert.equal(p.error, undefined, String(p.error));
  let outcome;
  try { outcome = JSON.parse(p.stdout); }
  catch (e) { throw new Error('PHP returned invalid JSON: ' + p.stdout + '\n' + p.stderr); }
  return { status: p.status, ...outcome };
}
function expectRefusal(box, zip, mode, rx) {
  const r = invoke(box, zip, mode);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.status, 1, JSON.stringify(r));
  if (rx) assert.match(r.error, rx);
}
function check(label, fn) {
  try { fn(); checks++; console.log('PASS ' + label); }
  catch (error) { console.error('FAIL ' + label + ': ' + error.stack); process.exitCode = 1; }
}
function alteredZip(name, entries) {
  const file = path.join(tmp, name + '.zip');
  fs.writeFileSync(file, builder.writeZip(entries));
  return file;
}

try {
  const modules = cp.spawnSync('php', ['-r', 'echo class_exists("ZipArchive") ? "zip" : "missing";'], { encoding: 'utf8' });
  if (modules.stdout !== 'zip') throw new Error('Test needs the PHP zip extension');
  const box = sandbox('primary');
  check('a pinned archive passes preflight without modifying the filesystem', () => {
    const result = invoke(box, packagePath);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.out.status, 'ready');
    assert.equal(result.out.fileCount, 12);
    assert.equal(fs.existsSync(path.join(box.web, 'atlas-verify')), false);
    assert.equal(fs.existsSync(path.join(box.priv, 'verify-config.php')), false);
  });
  check('preflight does not overwrite unrelated web files', () => {
    assert.equal(fs.readFileSync(path.join(box.web, 'unrelated.txt'), 'utf8'), 'KEEP ME');
  });
  check('missing or altered isolated test marker is refused', () => {
    const b = sandbox('bad-marker');
    fs.writeFileSync(path.join(b.web, '.atlas-isolated-test-host'), 'some-other-site.example');
    expectRefusal(b, packagePath, 'install', /marker/);
    assert.equal(fs.existsSync(path.join(b.web, 'atlas-verify')), false);
  });
  check('test host cannot be one of the live issuer domains', () => {
    const b = sandbox('bad-host');
    b.settings.expectedHost = 'evtec.co.za';
    fs.writeFileSync(path.join(b.web, '.atlas-isolated-test-host'), 'evtec.co.za');
    expectRefusal(b, packagePath, 'install', /test-only host/);
  });
  check('private directory cannot be nested inside the document root', () => {
    const b = sandbox('bad-private');
    const sub = path.join(b.web, 'secret');
    fs.mkdirSync(sub, { mode: 0o700 });
    fs.chmodSync(sub, 0o700);
    b.settings.privateDirectory = sub;
    expectRefusal(b, packagePath, 'install', /separate/);
  });
  check('invalid trusted issuer schemes and paths fail closed', () => {
    const b = sandbox('bad-issuer');
    b.settings.trustedIssuers = ['http://issuer.example'];
    expectRefusal(b, packagePath, 'install', /HTTPS/);
    b.settings.trustedIssuers = ['https://issuer.example/path'];
    expectRefusal(b, packagePath, 'install', /HTTPS/);
  });
  check('corrupted package file bytes are detected', () => {
    const modified = known.map(x => ({ ...x }));
    const pos = modified.findIndex(x => x.name === 'atlas-verify/verify.php');
    modified[pos] = { name: modified[pos].name, data: Buffer.from(modified[pos].data.toString() + ' ') };
    const bad = alteredZip('corrupted-entry', modified);
    expectRefusal(box, bad, 'install', /locked|oversized/);
    assert.equal(fs.existsSync(path.join(box.web, 'atlas-verify')), false);
  });
  check('unexpected or missing ZIP entries are refused', () => {
    expectRefusal(box, alteredZip('extra-entry', [...known, { name: 'atlas-verify/evil.php', data: Buffer.from('bad') }]), 'install', /extra entries/);
    expectRefusal(box, alteredZip('missing-entry', known.slice(1)), 'install', /missing or extra/);
  });
  check('duplicate and traversal ZIP entries are refused', () => {
    expectRefusal(box, alteredZip('duplicate', [...known.slice(0, -2), known[0], known[known.length - 1]]), 'install', /duplicate|consistent ZIP/);
    const entries = known.map(x => x.name === 'atlas-verify/verify.php' ? { ...x, name: 'atlas-verify/../evil.php' } : x);
    expectRefusal(box, alteredZip('traversal', entries), 'install', /unexpected/);
  });
  check('tampered PACKAGE.json file list is refused', () => {
    const entries = known.map(x => x.name === 'atlas-verify/PACKAGE.json'
      ? { ...x, data: Buffer.from(x.data.toString().replace('domain-atlas-package/1', 'bogus-package/1')) }
      : x);
    expectRefusal(box, alteredZip('wrong-package', entries), 'install', /metadata/);
  });
  check('repacked ZIP with identical files but different entry order is refused', () => {
    const repacked = alteredZip('repacked-same-files', [...known].reverse());
    expectRefusal(box, repacked, 'install', /pinned reproducible/);
    assert.equal(fs.existsSync(path.join(box.web, 'atlas-verify')), false);
  });
  check('successful one-time installation writes only the verified package and private config', () => {
    const result = invoke(box, packagePath, 'install');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.out.status, 'installed');
    assert.equal(result.out.fileCount, 12);
    assert.equal(fs.readFileSync(path.join(box.web, 'unrelated.txt'), 'utf8'), 'KEEP ME');
    for (const { f, data } of sources) {
      assert.deepEqual(fs.readFileSync(path.join(box.web, 'atlas-verify', f.path)), data, f.path);
    }
    assert.deepEqual(fs.readFileSync(path.join(box.web, 'atlas-verify/PACKAGE.json')), builder.packageJson(manifest, sources));
    assert.equal(fs.existsSync(path.join(box.web, 'atlas-verify/config.php')), true);
    assert.equal(fs.existsSync(path.join(box.priv, 'verify-config.php')), true);
    assert.equal(fs.statSync(path.join(box.priv, 'verify-config.php')).mode & 0o077, 0);
    assert.equal(fs.readdirSync(box.web).some(x => x.startsWith('.atlas-verify-stage-')), false);
  });
  check('generated configuration loads as valid PHP and trusts only configured issuers', () => {
    const stub = path.join(box.web, 'atlas-verify/config.php');
    const read = cp.spawnSync('php', ['-r', 'echo json_encode(include ' + JSON.stringify(stub) + ');'], { encoding: 'utf8' });
    assert.equal(read.status, 0, read.stderr);
    const config = JSON.parse(read.stdout);
    assert.deepEqual(Object.keys(config.trustedIssuers).sort(), ['https://issuer.example', 'https://second.example'].sort());
    assert.equal(config.trustedIssuers['https://issuer.example'].suspensions, 'required');
    assert.equal(config.accessTokenSha256, null);
    assert.deepEqual(config.allowedOrigins, []);
  });
  check('existing installation and existing private configuration both refuse overwrite', () => {
    expectRefusal(box, packagePath, 'install', /already exists/);
    const b = sandbox('existing-private');
    fs.writeFileSync(path.join(b.priv, 'verify-config.php'), 'PROTECT');
    expectRefusal(b, packagePath, 'install', /already exists/);
    assert.equal(fs.readFileSync(path.join(b.priv, 'verify-config.php'), 'utf8'), 'PROTECT');
  });
  check('web entrypoint refuses operation when private settings are absent', () => {
    const wrapper = path.join(repo, 'tools/installer/install-verifier-web.php');
    const read = cp.spawnSync('php', [wrapper], { encoding: 'utf8', env: { PATH: process.env.PATH || '' } });
    assert.match(read.stdout, /not privately configured/);
  });
  if (!process.exitCode) console.log('ALL ' + checks + ' VERIFIED INSTALLER CHECKS PASSED');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
