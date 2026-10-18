#!/usr/bin/env node
// A one-shot smoke check for the experimental ledger-account issuance endpoint, run by the operator
// AFTER enabling it. It uses a throwaway key that exists only for this run.
//
//   node tools/ledger-issuance-smoke.js <domain> <COIN> [--open]
//
// Without --open it only asks for a credential for an owner the ledger has never seen, and expects
// "account-not-found": that proves the endpoint is on, the proof checks pass and the issuer reached
// the ledger, without creating anything.
//
// With --open it first opens an EMPTY account for the throwaway key through Core's Labs 30
// endpoint. That account is permanent and belongs to a key nobody will ever hold again; it holds no
// funds. Then it expects a credential and checks it: the account ID against an independent
// derivation, and the issuer signature against the domain's published atlas-key.json.
//
// Testing only: --connect HOST:PORT sends the issuer's requests there instead, --connect-core
// HOST:PORT does the same for the ledger's, and --plain makes both plain http. The Host header and
// every signed address stay those of the real domain.
'use strict';
const http = require('http');
const https = require('https');
const { webcrypto, createHash } = require('crypto');
const { subtle } = webcrypto;

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--connect', '--connect-core'].includes(argv[i - 1])));
const [domain, coin] = positional;
if (!domain || !coin || !/^[A-Z][A-Z0-9]{1,9}$/.test(coin) || !['evtec.co.za', 'domain-atlas.co.za'].includes(domain)) {
  console.error('Usage: node tools/ledger-issuance-smoke.js <evtec.co.za|domain-atlas.co.za> <COIN> [--open]');
  process.exit(2);
}
const plain = flag('--plain') === true;
const open = flag('--open') === true;
const target = (v) => { if (typeof v !== 'string') return null; const [host, port] = v.split(':'); return { host, port: Number(port) }; };
const connectIssuer = target(flag('--connect')), connectCore = target(flag('--connect-core'));

const NETWORK = 'chainblock-labs29-' + domain;
const ISSUE_URL = 'https://' + domain + '/atlas/ledger/account-credential';
const ACCOUNTS_URL = 'https://' + domain + '/chain-labs/accounts31.php?action=accounts';
const OPEN_URL = 'https://' + domain + '/chain-labs/account30.php?action=open';

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const hex = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('hex');
const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}

function request(method, url, body, via) {
  const u = new URL(url);
  const lib = plain && via ? http : https;
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const req = lib.request({
      host: via ? via.host : u.hostname, port: via ? via.port : undefined, path: u.pathname + u.search, method, timeout: 20000,
      servername: u.hostname, headers: Object.assign({ Host: u.host, Accept: 'application/json', 'X-Forwarded-Proto': 'https' }, raw !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {})
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (e) { json = null; } resolve({ status: res.statusCode, json, text }); });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

(async () => {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const owner = b64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const sign = async (p) => b64(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(canonicalize(p)))));
  console.log('Throwaway owner key: ' + owner.slice(0, 12) + '... (discarded when this run ends)');

  if (open) {
    const payload = { type: 'atlas.ledger.account.open', v: 1, audience: OPEN_URL, network: NETWORK, coin, nonce: hex(16), issuedAt: iso() };
    const r = await request('POST', OPEN_URL, { payload, proof: { publicKey: owner, signature: await sign(payload) } }, connectCore);
    console.log('1. Open an empty account through Core: HTTP ' + r.status + ' ' + (r.json && r.json.code));
    if (r.status !== 201 && r.status !== 200) { console.log('FAIL the ledger would not open the account: ' + r.text.slice(0, 200)); process.exit(1); }
  }

  const listing = { type: 'atlas.ledger.accounts', v: 1, audience: ACCOUNTS_URL, network: NETWORK, nonce: hex(16), issuedAt: iso() };
  const listingProof = { publicKey: owner, signature: await sign(listing) };
  const intent = { type: 'atlas.ledger.account.issue', v: 1, audience: ISSUE_URL, network: NETWORK, coin, nonce: hex(16), issuedAt: iso(), existenceNonce: listing.nonce };
  const r = await request('POST', ISSUE_URL, { payload: intent, proof: { signerRole: 'raw-ecdsa', publicKey: owner, signature: await sign(intent) }, existence: { payload: listing, proof: listingProof } }, connectIssuer);
  console.log((open ? '2' : '1') + '. Ask the issuer for a credential: HTTP ' + r.status + ' ' + (r.json && r.json.code));

  if (!open) {
    if (r.status === 404 && r.json && r.json.code === 'account-not-found') { console.log('PASS the endpoint is on and reached the ledger; it refused, as it should, because this key has no account.'); return; }
    if (r.status === 404 && r.json && r.json.code === 'disabled') { console.log('The endpoint is OFF (no enabled config file). Nothing was signed.'); process.exit(1); }
    console.log('FAIL unexpected answer: ' + r.text.slice(0, 300));
    process.exit(1);
  }

  if (r.status !== 200 || !r.json || !r.json.credential) { console.log('FAIL no credential: ' + r.text.slice(0, 300)); process.exit(1); }
  const c = r.json.credential;
  const expectedId = 'urn:atlas:ledger-account:' + createHash('sha256').update(canonicalize({ coin, network: NETWORK, owner, purpose: 'atlas.ledger.account-id', v: 1 })).digest('hex');
  const keyDoc = (await request('GET', 'https://' + domain + '/.well-known/atlas-key.json', undefined, connectIssuer)).json;
  const issuerKey = keyDoc && (keyDoc.keys || []).find((k) => k.publicKey === c.issuer.publicKey);
  const pub = issuerKey && await subtle.importKey('raw', Buffer.from(issuerKey.publicKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const sigOk = !!pub && await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(c.signature, 'base64url'), new TextEncoder().encode(canonicalize({ id: c.id, ledger: { network: c.ledger.network, coin: c.ledger.coin }, owner: { publicKey: c.owner.publicKey }, issuedAt: c.issuedAt })));
  const shapeOk = JSON.stringify(Object.keys(c).sort()) === '["credential","id","issuedAt","issuer","ledger","owner","signature"]' && c.credential === 'domain-atlas-ledger-account/1.0' && c.issuer.domain === domain && c.ledger.network === NETWORK && c.ledger.coin === coin && c.owner.publicKey === owner;
  console.log('   shape: ' + (shapeOk ? 'ok' : 'WRONG') + ' | derived ID: ' + (c.id === expectedId ? 'ok' : 'WRONG') + ' | signature against the published key: ' + (sigOk ? 'ok' : 'WRONG'));
  if (!shapeOk || c.id !== expectedId || !sigOk) { console.log('FAIL'); process.exit(1); }
  console.log('PASS issued ' + c.id);
})().catch((err) => { console.error('FAIL ' + err.message); process.exit(1); });
