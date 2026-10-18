// A STAND-IN for the Chainblock Labs 29 balance prototype, served on a test issuer's host. It
// follows the prototype's documented behaviour (discovery document, the balance operation, the
// request checks, the structured error codes it returns) so the wallet can be driven against it,
// and it can be told to misbehave. It is not the prototype: test/manual-ledger-labs29-php.js runs
// the real file.
'use strict';
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;
const T = require('./ledger-test-lib');

const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));
const COINS = { GOPH: 2, MWC: 3 };

function attachLabs29(issuer) {
  const host = issuer.domain;
  const origin = issuer.origin;
  const base = origin + '/chain-labs/ledger29.php';
  const network = 'chainblock-labs29-' + host;
  const st = {
    balanceUrl: base + '?action=balance', discoveryUrl: base + '?action=discovery', network,
    accounts: new Map(), bodies: [], balanceRequests: 0, discoveryRequests: 0, otherRequests: [],
    mode: 'ok', delayMs: 0, discovery: {}, discoveryStatus: 200
  };
  const send = (res, obj, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  const read = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });

  issuer.state.handler = async (req, res) => {
    if (!req.url.startsWith('/chain-labs/ledger29.php')) return false;
    const url = new URL(req.url, origin);
    const action = url.searchParams.get('action');
    if (req.method === 'GET' && action === 'discovery') {
      st.discoveryRequests++;
      if (st.discoveryStatus !== 200) { send(res, { ok: false }, st.discoveryStatus); return true; }
      send(res, Object.assign({ ok: true, contract: 'chainblock-ledger29/experimental', endpoint: base, operations: { balance: st.balanceUrl }, network, issuer: host, signedDiscovery: false, warning: 'Experimental endpoint' }, st.discovery));
      return true;
    }
    if (req.method !== 'POST' || action !== 'balance') { st.otherRequests.push(req.method + ' ' + req.url); send(res, { ok: false, error: 'Unknown operation' }, 404); return true; }
    st.balanceRequests++;
    const text = await read(req);
    if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* handled below */ }
    st.bodies.push(body);
    const p = body && body.payload, proof = body && body.proof;
    if (!p || !proof || typeof p !== 'object' || typeof proof !== 'object') { send(res, { ok: false, error: 'Expected signed request' }, 400); return true; }
    const want = ['type', 'v', 'audience', 'network', 'coin', 'nonce', 'issuedAt'];
    if (Object.keys(p).some((k) => !want.includes(k)) || want.some((k) => !(k in p))) { send(res, { ok: false, code: 'malformed-request', error: 'Unexpected payload shape' }, 400); return true; }
    const timeOk = typeof p.issuedAt === 'string' && Math.abs(Date.now() - Date.parse(p.issuedAt)) <= 120000;
    if (p.type !== 'atlas.ledger.balance' || p.v !== 1 || p.audience !== st.balanceUrl || p.network !== network || !/^[A-Z][A-Z0-9]{1,9}$/.test(String(p.coin)) || !/^[a-f0-9]{32,64}$/.test(String(p.nonce)) || !timeOk) { send(res, { ok: false, error: 'Invalid balance challenge' }, 401); return true; }
    const key = proof.publicKey;
    const point = typeof key === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(key) ? unb64(key) : null;
    if (point && Buffer.from(point).toString('base64url') !== key) { send(res, { ok: false, code: 'bad-signature', error: 'Non-canonical identity key' }, 401); return true; }
    if (!point || point.length !== 65 || point[0] !== 4 || typeof proof.signature !== 'string' || unb64(proof.signature).length !== 64) { send(res, { ok: false, code: 'unsupported-proof', error: 'Malformed or unsupported identity proof' }, 401); return true; }
    let valid = false;
    try {
      const pub = await subtle.importKey('raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      valid = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64(proof.signature), new TextEncoder().encode(T.canonicalize(p)));
    } catch (e) { valid = false; }
    if (!valid) { send(res, { ok: false, code: 'bad-signature', error: 'Wallet signature verification failed' }, 401); return true; }
    if (!(p.coin in COINS)) { send(res, { ok: false, code: 'unknown-coin', error: 'Coin not registered on this domain' }, 404); return true; }
    const row = st.accounts.get(p.coin + '|' + key);
    if (row === undefined) { send(res, { ok: false, code: 'no-account', error: 'No ledger account for this wallet identity' }, 404); return true; }
    const good = { ok: true, amount: String(row), decimals: COINS[p.coin], asOf: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), network, coin: p.coin, ownerKey: key, verifiedRequest: true, balanceProof: 'TLS-only; signed ledger-state receipts not yet implemented', warning: 'Labs 29 prototype; no finality' };
    const modes = {
      ok: () => send(res, good),
      'wrong-owner': () => send(res, Object.assign({}, good, { ownerKey: T.b64url(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)])) })),
      'wrong-coin': () => send(res, Object.assign({}, good, { coin: p.coin === 'GOPH' ? 'MWC' : 'GOPH' })),
      'wrong-network': () => send(res, Object.assign({}, good, { network: 'chainblock-labs29-other.example' })),
      'bad-amount': () => send(res, Object.assign({}, good, { amount: '12.5' })),
      'future': () => send(res, Object.assign({}, good, { asOf: new Date(Date.now() + 3600000).toISOString() })),
      'status500': () => send(res, { ok: false }, 500),
      'rate-limited': () => send(res, { ok: false, code: 'rate-limited' }, 429),
      'stale': () => send(res, { ok: false, code: 'stale-request', serverTime: new Date().toISOString() }, 401),
      'garbage': () => send(res, '<html>not json</html>')
    };
    (modes[st.mode] || modes.ok)();
    return true;
  };

  return {
    state: st,
    open(ownerKey, coin, units) { st.accounts.set(coin + '|' + ownerKey, units); },
    close(ownerKey, coin) { st.accounts.delete(coin + '|' + ownerKey); }
  };
}

module.exports = { attachLabs29 };
