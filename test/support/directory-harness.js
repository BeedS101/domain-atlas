// Starts an isolated directory service for a test: the Node reference (directory-server/server.js) or the
// PHP port (directory-php, under PHP's built-in server). Both take the same DIRECTORY_* settings.
//
//   const d = await startDirectory({ impl: 'node' | 'php', port, env: { DIRECTORY_ALLOW_LOCAL: '1', ... } });
//   d.base                the URL prefix of the endpoints
//   (PHP: cron.php is run every second to stand in for the cPanel cron job)
//   d.stop()
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

async function waitUntil(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(what + ' did not start in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function startDirectory({ impl = process.env.DIRECTORY_IMPL || 'node', port, env = {} }) {
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
    child = spawn('node', [path.join(repo, 'directory-server', 'server.js')], { env: fullEnv, stdio: 'pipe' });
  }
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  await waitUntil(async () => (await fetch(base + '/stats')).ok, 8000, 'the ' + impl + ' directory');
  return {
    impl, base, dataDir,
    stop() { if (cron) clearInterval(cron); child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  };
}

module.exports = { startDirectory, waitUntil };
