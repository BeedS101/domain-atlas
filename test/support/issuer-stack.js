// Starts throw-away issuers (Node or PHP) on localhost for the security regression tests, plus a controllable stand-in
// domain that serves a published key and nothing else. State lives in scratch directories; nothing leaves this machine.
'use strict';
const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { subtle } = webcrypto;
const REPO = path.resolve(__dirname, '..', '..');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function generateIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { privateKey: pair.privateKey, publicKey: b64url(await subtle.exportKey('raw', pair.publicKey)) };
}
async function signPayload(identity, payload) {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, new TextEncoder().encode(canonicalize(payload)));
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}
async function signDetached(identity, payload) {
  return (await signPayload(identity, payload)).signature;
}
const request = (method) => (base, urlPath, body) => fetch(base + urlPath, {
  method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = request('POST');
const get = request('GET');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function waitUp(base, ms) {
  const until = Date.now() + (ms || 15000);
  while (Date.now() < until) {
    try { const r = await fetch(base + '/.well-known/atlas-key.json'); if (r.status < 500) return; } catch (e) { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('issuer at ' + base + ' did not start');
}

// stack: 'node' or 'php'. Returns { base, domain, dir, stop(), env }.
async function startIssuer(stack, port, extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sec-' + stack + '-' + port + '-'));
  const domain = 'localhost:' + port;
  const base = 'http://' + domain;
  let proc;
  if (stack === 'node') {
    const docroot = path.join(dir, 'docroot');
    fs.cpSync(path.join(REPO, 'demo-domain-a'), docroot, { recursive: true });
    // A fresh issuer: no keys, revocation or suspension documents carried over from the demo folder.
    for (const f of fs.readdirSync(path.join(docroot, '.well-known'))) if (/^atlas-.*\.json$/.test(f)) fs.rmSync(path.join(docroot, '.well-known', f), { force: true });
    proc = spawn('node', [path.join(REPO, 'issuer-server', 'server.js')], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { ATLAS_PRIVATE_MINT: 'off', PORT: String(port), ATLAS_DOMAIN: domain, ATLAS_DOCROOT: docroot, ATLAS_STATE_DIR: path.join(dir, 'state') }, extraEnv || {})
    });
  } else {
    const bundle = path.join(dir, 'bundle');
    fs.cpSync(path.join(REPO, 'issuer-php'), bundle, { recursive: true });
    proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
      cwd: bundle, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { ATLAS_PRIVATE_MINT: 'off', PHP_CLI_SERVER_WORKERS: '4' }, extraEnv || {})
    });
  }
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));
  await waitUp(base);
  return {
    base, domain, dir, log, stack,
    stop() { try { proc.kill(); } catch (e) { /* already gone */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
  };
}

// A domain that publishes only a signing key, standing in for a federated peer whose operator the issuers have never heard of.
async function startStandInDomain(port) {
  const identity = await generateIdentity();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/.well-known/atlas-key.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ publicKey: identity.publicKey, validFrom: '2020-01-01T00:00:00Z' }] }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return { identity, domain: 'localhost:' + port, stop() { server.close(); } };
}

// A federated issuer whose published documents the test controls, and which signs asset credentials with its own key.
// modes: key / rev / sus, each one of 'ok', '404', '500', 'malformed', 'hang', 'redirect', 'huge'; `revoked` and `suspended` list ids.
async function startStandInIssuer(port) {
  const identity = await generateIdentity();
  const state = { key: 'ok', rev: 'ok', sus: 'ok', revoked: [], suspended: [], hits: [] };
  const answer = (res, mode, okBody) => {
    if (mode === '404') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"none"}'); }
    if (mode === '500') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"boom"}'); }
    if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"revoked": [ not json'); }
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:9/' }); return res.end(); }
    if (mode === 'huge') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"pad":"' + 'x'.repeat(6 * 1024 * 1024) + '"}'); }
    if (mode === 'hang') return; // never answers
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(okBody));
  };
  const server = http.createServer((req, res) => {
    state.hits.push(req.url);
    if (req.url.startsWith('/.well-known/atlas-key.json')) return answer(res, state.key, { keys: [{ publicKey: identity.publicKey, validFrom: '2020-01-01T00:00:00Z' }] });
    if (req.url.startsWith('/.well-known/atlas-revocations.json')) return answer(res, state.rev, { revoked: state.revoked.map((id) => ({ id, revokedAt: '2026-01-01T00:00:00Z', reason: 'test' })) });
    if (req.url.startsWith('/.well-known/atlas-suspensions.json')) return answer(res, state.sus, { suspended: state.suspended.map((id) => ({ id })) });
    res.writeHead(404); res.end('{}');
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const domain = 'localhost:' + port;
  return {
    identity, domain, state,
    async issue(owner, cls) {
      const payload = {
        id: 'urn:atlas:asset:' + require('crypto').randomUUID(),
        asset: { name: 'Stand-in trophy', class: cls || 'atlas.trophy.chess', fungible: false, tradeScope: 'local' },
        owner: { publicKey: owner.publicKey }, quantity: 1, supersedes: null, issuedAt: new Date().toISOString()
      };
      return Object.assign({ credential: 'domain-atlas-asset/1.0' }, payload, { issuer: { domain, publicKey: identity.publicKey }, signature: await signDetached(identity, payload) });
    },
    stop() { server.closeAllConnections && server.closeAllConnections(); server.close(); }
  };
}

module.exports = { startStandInIssuer, REPO, b64url, canonicalize, generateIdentity, signPayload, signDetached, post, get, sleep, startIssuer, startStandInDomain };
