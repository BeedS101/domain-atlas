// Starts the PHP Call Service (call-php/) under PHP's built-in web server for tests, with a
// temporary settings file and state folder, and presents the same handle the Node tests use:
// { svc, cfg, issuer, base, origin }. `svc` reads the service's state files to answer the
// questions the Node tests ask of the in-process service.
//
// PHP's built-in server is a test stand-in for a web host: it runs one PHP process per
// request, like shared hosting, and with PHP_CLI_SERVER_WORKERS runs requests concurrently.
// It does not read .htaccess; call-php/test-router.php reproduces the clean-URL rule and the
// refusal of lib/.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const T = require('./call-test-lib');

const ROOT = path.join(__dirname, '..', 'call-php');
const PHP_TIMER_KEYS = ['acceptToOfferMs', 'offerToAnswerMs', 'confirmMs', 'endedRetainMs', 'seenCallIdMs', 'sweepMs', 'silentActiveMs', 'maxCallMs', 'listenerFreshMs', 'revocationCacheMs', 'fetchTimeoutMs', 'lockWaitMs'];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

function writeSettings(file, cfg) {
  fs.writeFileSync(file, '<?php\nreturn json_decode(<<<\'JSON\'\n' + JSON.stringify(cfg) + '\nJSON\n, true);\n', { mode: 0o600 });
}

async function waitReady(base, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('php server exited early');
    try { const r = await fetch(base + '/atlas/call/info'); if (r.ok) return; } catch (e) { /* not up yet */ }
    await T.sleep(50);
  }
  throw new Error('php server did not start');
}

// over: settings (same names as call-php/atlas/call/lib/config.example.php, plus origin).
// opts: { issuer, timers, limits, poll, workers, stateDir, keep }
async function startPhpService(over, opts) {
  opts = opts || {};
  over = over || {};
  const issuer = opts.issuer || await T.newIssuer('example.com');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-call-php-'));
  const port = opts.port || await freePort();
  const timers = {};
  for (const k of Object.keys(opts.timers || {})) if (PHP_TIMER_KEYS.includes(k)) timers[k] = k === 'revocationCacheMs' ? opts.timers[k] : Math.max(200, opts.timers[k]);
  const cfg = Object.assign({
    origin: 'http://127.0.0.1:' + port, domain: issuer.domain, issuerKeys: [issuer.ident.pub],
    stateDir: opts.stateDir || path.join(dir, 'state'), devAllowHttp: true, devAllowPrivateFetch: true
  }, over);
  if (Object.keys(timers).length) cfg.timers = Object.assign({}, cfg.timers, timers);
  if (opts.limits) cfg.limits = Object.assign({}, cfg.limits, opts.limits);
  if (cfg.timers && cfg.timers.listenerFreshMs && !(opts.poll && opts.poll.listenIdleMs)) cfg.poll = Object.assign({ listenIdleMs: Math.max(200, Math.floor(cfg.timers.listenerFreshMs / 3)) }, cfg.poll);
  if (opts.poll) cfg.poll = Object.assign({}, cfg.poll, opts.poll);
  const settings = path.join(dir, 'config.php');
  if (opts.rawSettings !== undefined) fs.writeFileSync(settings, opts.rawSettings); else writeSettings(settings, cfg);
  const log = fs.openSync(path.join(dir, 'server.log'), 'a');
  const env = Object.assign({}, process.env, { ATLAS_CALL_CONFIG: opts.noSettingsFile ? path.join(dir, 'missing.php') : settings, PHP_CLI_SERVER_WORKERS: String(opts.workers || 4) });
  delete env.ATLAS_CALL_STATE_DIR;
  const args = ['-d', 'display_errors=0', '-d', 'error_log=' + path.join(dir, 'php-errors.log'), '-S', '127.0.0.1:' + port, '-t', ROOT, path.join(ROOT, 'test-router.php')];
  const child = spawn('php', args, { env, stdio: ['ignore', log, log] });
  const base = 'http://127.0.0.1:' + port;
  await waitReady(base, child);
  const stateDir = cfg.stateDir;
  const retain = (cfg.timers && cfg.timers.endedRetainMs) || 60000;
  const sweepMs = (cfg.timers && cfg.timers.sweepMs) || 2000;

  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  const svc = {
    dir, stateDir, settings, port, child,
    // Runs a sweep: waits until one is due and makes any request that takes the rate limit.
    async sweep() {
      await T.sleep(sweepMs + 60);
      await fetch(base + '/atlas/call/listen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    },
    async callState(id) {
      await this.sweep();
      const c = readJson(path.join(stateDir, 'calls', sha(id).slice(0, 2), sha(id) + '.json'));
      if (!c) return null;
      if (c.endedAt > 0 && Date.now() - c.endedAt >= retain) return null;
      return c.state;
    },
    call(id) { return readJson(path.join(stateDir, 'calls', sha(id).slice(0, 2), sha(id) + '.json')); },
    async stats() {
      await this.sweep();
      const index = readJson(path.join(stateDir, 'calls', 'index.json')) || {};
      const now = Date.now();
      const entries = Object.values(index);
      return {
        calls: entries.filter((e) => e[1] === 0 || now - e[1] < retain).length,
        liveCalls: entries.filter((e) => e[1] === 0).length,
        meta: readJson(path.join(stateDir, 'meta.json'))
      };
    },
    log() { try { return fs.readFileSync(path.join(dir, 'server.log'), 'utf8') + (fs.existsSync(path.join(dir, 'php-errors.log')) ? fs.readFileSync(path.join(dir, 'php-errors.log'), 'utf8') : ''); } catch (e) { return ''; } },
    async close() {
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 1500); }); }
      try { fs.closeSync(log); } catch (e) { /* closed */ }
      if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  return { svc, cfg, issuer, base, origin: cfg.origin };
}

module.exports = { startPhpService, writeSettings, sha, ROOT };
