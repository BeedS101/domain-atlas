// A local HTTPS front for the ledger tests: the browser asks for https://evtec.co.za/..., Chromium
// is told to resolve that name to this server (throwaway certificate, accepted for the run only),
// and the front passes /chain-labs/ to the ledger and everything else to the issuer. Every request
// is recorded. Nothing leaves this machine.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const L = require('./ledger-issuance-lib');

function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=' + L.DOMAIN, '-addext', 'subjectAltName=DNS:' + L.DOMAIN], { stdio: 'pipe' });
  return { dir, key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
}

async function front(issuerPort, core, tls, hits, tamper = {}) {
  const corePort = Number(new URL(core.base).port);
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: raw });
      const toLedger = req.url.startsWith('/chain-labs/');
      const up = http.request({ host: '127.0.0.1', port: toLedger ? corePort : issuerPort, path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: L.DOMAIN, 'x-forwarded-proto': 'https' }) }, (r) => {
        if (!tamper.issue || toLedger || !/account-credential/.test(req.url)) { res.writeHead(r.statusCode, r.headers); r.pipe(res); return; }
        // A test hook: the issuer's answer is altered on its way to the wallet.
        let text = '';
        r.on('data', (c) => { text += c; });
        r.on('end', () => {
          let out = text;
          try { const j = JSON.parse(text); if (j.credential) { tamper.issue(j.credential); out = JSON.stringify(j); } } catch (e) { /* not JSON: passed on as it is */ }
          const headers = Object.assign({}, r.headers); delete headers['content-length']; delete headers['transfer-encoding'];
          res.writeHead(r.statusCode, headers); res.end(out);
        });
      });
      up.on('error', () => { res.writeHead(502); res.end(); });
      up.end(raw);
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}


// Chromium arguments that send the domain to the front.
const chromiumArgs = (port) => ['--host-resolver-rules=MAP ' + L.DOMAIN + ' 127.0.0.1:' + port, '--ignore-certificate-errors', '--no-proxy-server'];

module.exports = { makeCert, front, chromiumArgs };
