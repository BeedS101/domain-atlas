// Installer web-entrypoint integration test: real PHP HTTP form, only local loopback.
// HTTPS=on is deliberately simulated via server environment; this does NOT test a real TLS proxy.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const builder = require('../tools/package/build-package');

const repo = path.resolve(__dirname, '..');
const installerDir = path.join(repo, 'tools/installer');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-installer-http-'));
const documentRoot = path.join(dir, 'public-site');
const privateDir = path.join(dir, 'operator-private');
const zipPath = path.join(dir, 'atlas-verify-0.1.1.zip');
const settingsPath = path.join(privateDir, 'installer-settings.php');
const routerPath = path.join(dir, 'test-only-router.php');
const expectedHost = 'verifier-test.example';
const token = 't'.repeat(48); // test fixture ONLY, never real operator token
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
let checks = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function escapePhp(s) { return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
function assertResult(label, fn) {
  return Promise.resolve().then(fn).then(() => {
    checks++; console.log('PASS ' + label);
  });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function startPhp(docroot, overrides) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = await freePort();
    let stderr = '';
    const proc = spawn('php', ['-d', 'opcache.enable=0', '-S', '127.0.0.1:' + port, '-t', docroot, routerPath], {
      cwd: docroot,
      env: { ...process.env, ...(overrides || {}), PHP_CLI_SERVER_WORKERS: '1' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    let ready = false;
    const url = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 120; i++) {
      if (proc.exitCode !== null) break;
      try {
        const response = await fetch(url + '/install-verifier-web.php', {
          headers: { Host: expectedHost },
          signal: AbortSignal.timeout(500)
        });
        await response.arrayBuffer();
        ready = true; break;
      } catch (_) { await sleep(40); }
    }
    if (ready) return { proc, url, stderr: () => stderr };
    proc.kill();
    await sleep(70);
    if (attempt === 3) throw new Error('PHP server did not start: ' + stderr.slice(-800));
  }
}
async function stopPhp(srv) {
  if (!srv || srv.proc.exitCode !== null) return;
  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 2500);
    srv.proc.once('exit', () => { clearTimeout(timeout); resolve(); });
    srv.proc.kill('SIGTERM');
  });
}
function rawRequest(url, method, host, body, contentType) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (body) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = String(body.length);
    }
    const req = http.request({
      host: '127.0.0.1', port: Number(parsed.port), path: parsed.pathname, method, headers
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    req.end(body || undefined);
  });
}

async function request(srv, method, host, credentials, archive, intent) {
  const hostname = host || expectedHost;
  if (method !== 'POST') return rawRequest(srv.url + '/install-verifier-web.php', method, hostname);
  const boundary = '----atlas-verifier-installer-test-' + crypto.randomBytes(8).toString('hex');
  const file = archive || fs.readFileSync(zipPath);
  const field = (name, value) => Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n');
  const fileHeader = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="package"; filename="atlas-verify-0.1.1.zip"\r\nContent-Type: application/zip\r\n\r\n');
  const body = Buffer.concat([
    field('token', credentials === undefined ? token : credentials),
    field('intent', intent || 'check'),
    fileHeader, file,
    Buffer.from('\r\n--' + boundary + '--\r\n')
  ]);
  return rawRequest(srv.url + '/install-verifier-web.php', 'POST', hostname, body, 'multipart/form-data; boundary=' + boundary);
}

async function main() {
  fs.mkdirSync(documentRoot);
  fs.mkdirSync(privateDir, { mode: 0o700 });
  fs.chmodSync(privateDir, 0o700);
  fs.writeFileSync(path.join(documentRoot, '.atlas-isolated-test-host'), expectedHost);
  const manifest = builder.readManifest(path.join(repo, 'packages/atlas-verify/manifest.json'));
  const archive = builder.build(manifest, builder.loadSources(manifest)).zip;
  fs.writeFileSync(zipPath, archive);
  // PHP's built-in HTTP server correctly does not regard HTTPS=on in its environment
  // as real TLS. A private throw-away router injects that server variable for
  // positive-branch testing only. This file never ships with an installer.
  fs.writeFileSync(routerPath, [
    '<?php',
    "if (getenv('ATLAS_TEST_SIMULATE_TLS') === '1') $_SERVER['HTTPS'] = 'on';",
    "else $_SERVER['HTTPS'] = 'off';",
    '$uri = parse_url($_SERVER[\'REQUEST_URI\'], PHP_URL_PATH);',
    "if ($uri === '/__atlas_test_request') {",
    " header('Content-Type: application/json');",
    " echo json_encode(['host' => $_SERVER['HTTP_HOST'] ?? null, 'https' => $_SERVER['HTTPS'] ?? null]);",
    ' return true;',
    '}',
    "if ($uri === '/install-verifier-web.php') { require " + escapePhp(path.join(installerDir,'install-verifier-web.php')) + "; return true; }",
    'return false;',
    ''
  ].join('\n'));
  const settings = '<?php\nreturn [\n' +
    " 'tokenSha256' => " + escapePhp(tokenHash) + ",\n" +
    " 'expectedHost' => " + escapePhp(expectedHost) + ",\n" +
    " 'documentRoot' => " + escapePhp(documentRoot) + ",\n" +
    " 'privateDirectory' => " + escapePhp(privateDir) + ",\n" +
    " 'trustedIssuers' => ['https://issuer.example'],\n" +
    " 'suspensions' => 'required',\n];\n";
  fs.writeFileSync(settingsPath, settings, { mode: 0o600 });

  let srv;
  let noTls;
  try {
    srv = await startPhp(installerDir, { ATLAS_INSTALL_SETTINGS: '' });
    await assertResult('without out-of-webroot settings web installer fails closed', async () => {
      const r = await request(srv, 'GET');
      assert.equal(r.status, 503, r.text);
      assert.match(r.text, /not privately configured/);
    });
    await stopPhp(srv); srv = null;

    noTls = await startPhp(installerDir, { ATLAS_INSTALL_SETTINGS: settingsPath, ATLAS_TEST_SIMULATE_TLS: '0' });
    await assertResult('operator settings cannot bypass HTTPS requirement', async () => {
      const r = await request(noTls, 'GET');
      assert.equal(r.status, 403, r.text);
      assert.match(r.text, /requires HTTPS/);
    });
    await stopPhp(noTls); noTls = null;

    // Set HTTPS in the PHP process environment to exercise PHP's guarded branch.
    // Requests still use HTTP on loopback: *not* evidence of real TLS enforcement.
    srv = await startPhp(installerDir, { ATLAS_INSTALL_SETTINGS: settingsPath, ATLAS_TEST_SIMULATE_TLS: '1' });
    await assertResult('test-only router supplies the intended Host and simulated TLS state', async () => {
      const response = await rawRequest(srv.url + '/__atlas_test_request', 'GET', expectedHost);
      assert.equal(response.status, 200);
      const j = JSON.parse(response.text);
      assert.equal(j.host, expectedHost);
      assert.equal(j.https, 'on');
    });
    await assertResult('wrong hostname is refused even when operator settings and TLS flag exist', async () => {
      const r = await request(srv, 'GET', 'another-test.example');
      assert.equal(r.status, 403, r.text);
    });
    await assertResult('authorized test hostname presents the installer form', async () => {
      const r = await request(srv, 'GET');
      assert.equal(r.status, 200, r.text);
      assert.match(r.text, /Preflight only/);
      assert.match(r.text, /multipart\/form-data/);
      assert.doesNotMatch(r.text, new RegExp(tokenHash));
    });
    await assertResult('incorrect token cannot preflight or install', async () => {
      const r = await request(srv, 'POST', expectedHost, 'x'.repeat(48));
      assert.equal(r.status, 403, r.text);
      assert.equal(fs.existsSync(path.join(documentRoot, 'atlas-verify')), false);
      assert.equal(fs.existsSync(path.join(privateDir, 'verify-config.php')), false);
    });
    await assertResult('correct token with altered archive is refused', async () => {
      const corrupted = Buffer.from(archive);
      corrupted[60] ^= 0x01;
      const r = await request(srv, 'POST', expectedHost, undefined, corrupted, 'install');
      assert.equal(r.status, 400, r.text);
      assert.match(r.text, /Installation refused/);
      assert.equal(fs.existsSync(path.join(documentRoot, 'atlas-verify')), false);
    });
    await assertResult('valid upload passes preflight without touching destination', async () => {
      const r = await request(srv, 'POST');
      assert.equal(r.status, 200, r.text);
      assert.match(r.text, /preflight passed/i);
      assert.equal(fs.existsSync(path.join(documentRoot, 'atlas-verify')), false);
      assert.equal(fs.existsSync(path.join(privateDir, 'verify-config.php')), false);
    });
    await assertResult('valid upload installs once and keeps secrets outside document root', async () => {
      const r = await request(srv, 'POST', expectedHost, undefined, undefined, 'install');
      assert.equal(r.status, 200, r.text);
      assert.match(r.text, /was installed/);
      assert.equal(fs.existsSync(path.join(documentRoot, 'atlas-verify/verify.php')), true);
      assert.equal(fs.existsSync(path.join(privateDir, 'verify-config.php')), true);
      assert.equal(fs.statSync(path.join(privateDir, 'verify-config.php')).mode & 0o077, 0);
      assert.doesNotMatch(r.text, new RegExp(token));
      assert.equal(r.text.includes(privateDir), false);
    });
    await assertResult('replayed installation cannot overwrite existing package', async () => {
      const r = await request(srv, 'POST', expectedHost, undefined, undefined, 'install');
      assert.equal(r.status, 400, r.text);
      assert.match(r.text, /already exists/);
    });
    await stopPhp(srv); srv = null;
    const site = await startPhp(documentRoot, { ATLAS_INSTALL_SETTINGS: '', ATLAS_TEST_SIMULATE_TLS: '0' });
    try {
      await assertResult('installed verifier answers its own status endpoint as configured', async () => {
        const response = await fetch(site.url + '/atlas-verify/verify.php', { signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 200);
        const j = await response.json();
        assert.equal(j.package, 'atlas-verify');
        assert.equal(j.version, '0.1.1');
        assert.equal(j.configured, true);
        assert.deepEqual(j.trustedIssuers, ['https://issuer.example']);
      });
    } finally { await stopPhp(site); }
  } finally {
    await stopPhp(srv);
    await stopPhp(noTls);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('ALL ' + checks + ' INSTALLER HTTP INTEGRATION CHECKS PASSED');
}
main().catch(e => { console.error('INSTALLER HTTP INTEGRATION FAILED: ' + e.stack); process.exitCode = 1; });
