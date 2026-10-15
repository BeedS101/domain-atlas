// The Call Service behind a TLS-terminating reverse proxy, and the deployment checker run
// against it. The proxy here is a small Node program that behaves like the documented nginx
// settings (it appends to X-Forwarded-For, sets X-Forwarded-Proto, forwards Host, and has a
// read timeout), so this shows how the service and the checker react to correct and to
// faulty proxy settings. It does not run nginx or Caddy; their real configuration files need a
// run on a real host.
// Run: node test/manual-call-proxy.js
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const T = require('./call-test-lib');
const { check, sleep } = T;

const CHECKER = path.join(__dirname, '..', 'call-server', 'check-deployment.js');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function makeCert(dir) {
  const key = path.join(dir, 'key.pem'), crt = path.join(dir, 'crt.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('openssl failed: ' + r.stderr);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt), certFile: crt };
}

// A reverse proxy in the shape of the documented nginx block.
function startProxy(tls, upstreamPort, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      const headers = Object.assign({}, req.headers);
      const prior = headers['x-forwarded-for'];
      headers['x-forwarded-for'] = (prior ? prior + ', ' : '') + req.socket.remoteAddress;
      if (opts.sendProto !== false) headers['x-forwarded-proto'] = 'https'; else delete headers['x-forwarded-proto'];
      const up = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers, timeout: opts.readTimeoutMs || 70000 }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      });
      up.on('timeout', () => { up.destroy(); if (!res.headersSent) { res.writeHead(504); res.end('gateway timeout'); } });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('bad gateway'); } else res.end(); });
      if (opts.maxBody) {
        let n = 0;
        req.on('data', (c) => { n += c.length; if (n > opts.maxBody && !res.headersSent) { res.writeHead(413); res.end('too large'); up.destroy(); } });
      }
      if (opts.hsts !== false) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      req.pipe(up);
    });
    server.listen(opts.port || 0, '127.0.0.1', () => resolve(server));
  });
}

function runChecker(arg, tls, extra) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHECKER, arg].concat(extra || []), { env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: tls.certFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('close', (code) => resolve({ code, text }));
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-call-proxy-'));
  const tls = makeCert(dir);
  const timers = { listenHoldMs: 1500, sweepMs: 100 };
  const proxies = [];
  const services = [];
  async function stack(proxyOpts, svcCfg, svcOpts) {
    const proxyPort = await freePort();
    const origin = 'https://localhost:' + proxyPort;
    const ctx = await T.startService(Object.assign({ origin, devAllowHttp: false, trustProxy: true, stunUrls: ['stun:203.0.113.5:3478'] }, svcCfg || {}), Object.assign({ timers }, svcOpts || {}));
    const upstreamPort = Number(new URL(ctx.base).port);
    const proxy = await startProxy(tls, upstreamPort, Object.assign({ port: proxyPort }, proxyOpts || {}));
    proxies.push(proxy); services.push(ctx);
    return { ctx, origin, proxy };
  }

  // ---- a correct proxy ----
  let s = await stack();
  let r = await runChecker(s.origin, tls);
  check('the checker passes against a correct proxy in front of a configured service', r.code === 0 && /PASS a held listen is answered through the proxy/.test(r.text) && !/^FAIL/m.test(r.text), r.text);
  check('it reads the service origin, the clock, the STUN list and cross-origin rules', /PASS the service names exactly this address/.test(r.text) && /PASS clock agreement/.test(r.text) && /STUN: stun:203\.0\.113\.5:3478/.test(r.text) && /PASS a request from a web page origin is refused/.test(r.text) && /PASS a cross-origin preflight is not approved/.test(r.text), r.text);
  check('it checks content type, oversize bodies, method and HTTPS rules', /PASS a request that is not application\/json is refused/.test(r.text) && /PASS an oversized body is refused with 413/.test(r.text) && /PASS GET on a call route is refused/.test(r.text) && /PASS Strict-Transport-Security is sent/.test(r.text), r.text);
  check('it says plainly what it does not test', /does not test audio, STUN or TURN/.test(r.text));
  check('the checker created no tag and no call on the service', s.ctx.svc.stats().tags === 0 && s.ctx.svc.stats().calls === 0, s.ctx.svc.stats());
  check('its throwaway listener is released after the answer', s.ctx.svc.stats().waiters === 0, s.ctx.svc.stats());

  // ---- spoofed X-Forwarded-For through the proxy ----
  {
    const sp = await stack({}, {}, { limits: { perSourcePerMin: 3 } });
    const port = Number(new URL(sp.origin).port);
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const res = await new Promise((resolve) => {
        const q = https.request({ host: '127.0.0.1', port, method: 'POST', path: '/atlas/call/listen', ca: tls.cert, servername: 'localhost', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.' + i + '.0.1, 192.0.2.' + i, 'Content-Length': 2 } }, (x) => { x.resume(); x.on('end', () => resolve(x.statusCode)); });
        q.on('error', () => resolve(0));
        q.end('{}');
      });
      codes.push(res);
    }
    check('through the proxy a client cannot dodge its limit by inventing X-Forwarded-For entries', codes[2] === 400 && codes[3] === 429 && codes[4] === 429, codes);
  }

  // ---- faults the checker must catch ----
  s = await stack({ sendProto: false });
  r = await runChecker(s.origin, tls);
  check('a proxy that does not send X-Forwarded-Proto is caught with the fix named', r.code === 1 && /FAIL the proxy tells the service the request was https/.test(r.text) && /X-Forwarded-Proto/.test(r.text), r.text);

  s = await stack({ readTimeoutMs: 600 });
  r = await runChecker(s.origin, tls);
  check('a proxy whose read timeout is shorter than the listen hold is caught', r.code === 1 && /FAIL a held listen is answered/.test(r.text) && /504/.test(r.text) && /read timeout/.test(r.text), r.text);

  s = await stack({ hsts: false });
  r = await runChecker(s.origin, tls);
  check('a missing Strict-Transport-Security header is a warning, not a failure', r.code === 0 && /WARN Strict-Transport-Security is sent/.test(r.text), r.text);

  s = await stack({ maxBody: 20000 });
  r = await runChecker(s.origin, tls);
  check('a proxy-level body limit is accepted (413 either way)', r.code === 0 && /PASS an oversized body is refused with 413/.test(r.text), r.text);

  s = await stack();
  const wrong = s.origin.replace('localhost', '127.0.0.1');
  r = await runChecker(wrong, tls);
  check('an address that is not the one the service was configured with is caught', r.code === 1 && /FAIL the service names exactly this address/.test(r.text) && /CALL_ORIGIN must match/.test(r.text), r.text);

  s = await stack({}, { configured: false });
  r = await runChecker(s.origin, tls);
  check('an unconfigured service is reported as such', r.code === 1 && /FAIL the service is configured/.test(r.text), r.text);

  // ---- the checker refuses unsafe input ----
  r = await runChecker('http://127.0.0.1:1', tls);
  check('the checker refuses plain http without --allow-http', r.code === 2 && /must be https/.test(r.text), r.text);
  r = await runChecker('https://calls.example.org/path', tls);
  check('the checker refuses an address with a path', r.code === 2 && /bare origin/.test(r.text), r.text);
  r = await runChecker('https://127.0.0.1:1', tls);
  check('the checker reports an unreachable service', r.code === 1 && /FAIL the service answers/.test(r.text), r.text);

  for (const p of proxies) p.close();
  for (const c of services) await c.svc.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(T.finish('manual-call-proxy'));
})().catch((e) => { console.error(e); process.exit(2); });
