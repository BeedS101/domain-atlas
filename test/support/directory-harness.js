// Starts an isolated directory service for a test: the Node reference (directory-server/server.js) or the
// PHP port (directory-php, under PHP's built-in server). Both take the same DIRECTORY_* settings.
//
//   const d = await startDirectory({ impl: 'node' | 'php', port, env: { DIRECTORY_ALLOW_LOCAL: '1', ... } });
//   d.base                the URL prefix of the endpoints
//   d.phpVersion          (PHP) the version the running server reported
//   (PHP: cron.php is run every second to stand in for the cPanel cron job)
//   d.stop()
//
// With DIRECTORY_EXPECT_PHP=7.4 (or 8.1, 8.3.2 ...) a PHP directory refuses to start unless the server
// process itself reports a version beginning with that, and the cron script runs under the same one. CI
// sets it from its PHP matrix, so a job cannot go green while testing a different PHP.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

async function waitUntil(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(what + ' did not start in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

let announced = false;
async function startDirectory({ impl = process.env.DIRECTORY_IMPL || 'node', port, env = {}, nodeArgs = [] }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-test-'));
  const repo = path.resolve(__dirname, '..', '..');
  const fullEnv = { ...process.env, DIRECTORY_CRAWL_INTERVAL_MS: '2000', ...env };
  let child;
  let base;
  let cron = null;
  if (impl === 'php') {
    fullEnv.DIRECTORY_DATA_DIR = dataDir;
    base = 'http://127.0.0.1:' + port + '/atlas/directory';
    child = spawn('php', ['-S', '127.0.0.1:' + port, path.join(repo, 'directory-php', 'test-router.php')], { cwd: path.join(repo, 'directory-php'), env: fullEnv, stdio: 'pipe' });
    // Asynchronous on purpose: the manifests being crawled are served by the test process itself.
    let running = false;
    cron = setInterval(() => {
      if (running) return;
      running = true;
      const c = spawn('php', [path.join(repo, 'directory-php', 'atlas', 'directory', 'cron.php')], { env: fullEnv, stdio: 'ignore' });
      c.on('exit', () => { running = false; });
    }, 1000);
  } else {
    fullEnv.PORT = String(port);
    fullEnv.DIRECTORY_SNAPSHOT_FILE = path.join(dataDir, 'index.json');
    base = 'http://127.0.0.1:' + port;
    child = spawn('node', [...nodeArgs, path.join(repo, 'directory-server', 'server.js')], { env: fullEnv, stdio: 'pipe' });
  }
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  await waitUntil(async () => (await fetch(base + '/stats')).ok, 8000, 'the ' + impl + ' directory');
  let phpVersion = null;
  if (impl === 'php') {
    phpVersion = (await (await fetch('http://127.0.0.1:' + port + '/__php_version')).text()).trim();
    const cli = spawnSync('php', ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' }).stdout.trim();
    const expect = process.env.DIRECTORY_EXPECT_PHP;
    const mismatch = (expect && !(phpVersion === expect || phpVersion.startsWith(expect + '.'))) || cli !== phpVersion;
    if (mismatch) {
      child.kill(); if (cron) clearInterval(cron); fs.rmSync(dataDir, { recursive: true, force: true });
      throw new Error('PHP version mismatch: the server reports ' + phpVersion + ', the cron script would run ' + cli + (expect ? ', expected ' + expect : ''));
    }
    if (!announced) { announced = true; console.log('Directory under test: PHP ' + phpVersion + (expect ? ' (expected ' + expect + ')' : '')); }
  } else if (!announced) { announced = true; console.log('Directory under test: Node ' + process.version); }
  return {
    impl, base, dataDir, phpVersion,
    stop() { if (cron) clearInterval(cron); child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  };
}

module.exports = { startDirectory, waitUntil };
