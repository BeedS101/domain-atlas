// The wallet's own check of an issued ledger-account reference, in a real Chromium with the
// extension loaded: AtlasWallet.verifyLedgerCredential and addLedgerAccount run on credentials
// that the real issuers (Node and PHP, from this repository) signed.
//
// The browser reaches the issuer the way it would reach the live site: it asks for
// https://evtec.co.za/..., which Chromium is told to resolve to a local HTTPS front (a throwaway
// certificate, accepted for this run only) that passes requests to the issuer under test. The ledger
// is the stand-in unless CORE_LABS_DIR names Core's files, in which case the real ones run.
//
// What it does not do: the wallet cannot sign an issuance request yet (it refuses to sign
// atlas.ledger payloads outside an adapter's scoped call, and collecting these references is not
// built), so the owner in the issuer tests is a key held by the test. The add-to-wallet path is
// therefore shown with the test issuer double, whose credentials are signed for the wallet's own key.
//
// Run: xvfb-run -a node test/manual-ledger-issuance-wallet.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const E = require('./call-e2e-lib');
const T = require('./ledger-test-lib');
const L = require('./ledger-issuance-lib');
const { check } = E;

const CORE_DIR = process.env.CORE_LABS_DIR && fs.existsSync(path.join(process.env.CORE_LABS_DIR, 'accounts31.php')) ? process.env.CORE_LABS_DIR : null;
const ALT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const flipLast = (s) => s.slice(0, -1) + ALT[ALT.indexOf(s.slice(-1)) ^ 1];

function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuance-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=' + L.DOMAIN, '-addext', 'subjectAltName=DNS:' + L.DOMAIN], { stdio: 'pipe' });
  return { dir, key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
}

async function front(issuerPort, tls, hits) {
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    hits.push(req.method + ' ' + req.url);
    const up = http.request({ host: '127.0.0.1', port: issuerPort, path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: L.DOMAIN, 'x-forwarded-proto': 'https' }) }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

async function run(kind, core, tls) {
  const tag = '[' + kind + '/' + core.kind + '] ';
  const t = (name, ok, detail) => check(tag + name, ok, detail);
  const issuer = await L.startIssuer(kind, core);
  issuer.enable({ perClientPerMinute: 1000, perOwnerPerHour: 100, globalPerHour: 1000 });
  const hits = [];
  const fr = await front(issuer.port, tls, hits);
  const w = await E.launchWallet('issuance-' + kind, { args: ['--host-resolver-rules=MAP ' + L.DOMAIN + ' 127.0.0.1:' + fr.port, '--ignore-certificate-errors', '--no-proxy-server'] });
  const W = w.wallet;
  try {
    const verify = (c) => W((cred) => AtlasWallet.verifyLedgerCredential(cred), c);
    const obtain = async (coin) => {
      const owner = await L.newOwner();
      await core.openAccount(owner, coin);
      const r = await issuer.post(await L.buildRequest(owner, coin));
      if (r.status !== 200) throw new Error('issuance failed: ' + r.text);
      return { owner, cred: r.json.credential };
    };
    const clone = (c, f) => { const x = JSON.parse(JSON.stringify(c)); f(x); return x; };

    console.log('--- ' + tag + 'the wallet verifies an issued reference ---');
    const { owner, cred } = await obtain('GOPH');
    let v = await verify(cred);
    t('a credential from the real issuer verifies in the extension', v.valid === true && /signature verified/.test(v.reason), v);
    t('the extension fetched the published key from the issuing domain', hits.some((h) => h === 'GET /.well-known/atlas-key.json'), hits);
    v = await verify(clone(cred, (c) => { c.signature = c.signature.slice(0, 10) + ALT[(ALT.indexOf(c.signature[10]) + 1) % 64] + c.signature.slice(11); }));
    t('a changed signature does not', v.valid === false && /signature/.test(v.reason), v);
    v = await verify(clone(cred, (c) => { c.ledger.coin = 'MWC'; c.id = L.derivedId(L.NETWORK, 'MWC', c.owner.publicKey); }));
    t('a changed coin (with the matching derived ID) does not', v.valid === false && /signature does not match/.test(v.reason), v);
    const stranger = await L.newOwner();
    v = await verify(clone(cred, (c) => { c.owner.publicKey = stranger.key; c.id = L.derivedId(L.NETWORK, 'GOPH', stranger.key); }));
    t('a changed owner (with the matching derived ID) does not', v.valid === false && /signature does not match/.test(v.reason), v);
    v = await verify(clone(cred, (c) => { c.issuedAt = L.iso(Date.parse(c.issuedAt) + 1000); }));
    t('a changed issue time does not', v.valid === false, v);
    const before = hits.length;
    v = await verify(clone(cred, (c) => { c.id = 'urn:atlas:ledger-account:' + 'ab'.repeat(32); }));
    t('an ID that is not the derived one is refused on a Labs 29 network', v.valid === false && v.code === 'id-mismatch', v);
    t('...before the issuer is contacted', hits.length === before, hits.slice(before));
    v = await verify(clone(cred, (c) => { c.issuer.publicKey = flipLast(c.issuer.publicKey); }));
    t('a signing key the issuer does not publish does not verify', v.valid === false, v);
    v = await verify(clone(cred, (c) => { c.balance = '5'; }));
    t('a credential carrying a balance is refused', v.valid === false && v.code === 'carries-balance', v);
    v = await verify(clone(cred, (c) => { c.owner.publicKey = owner.spki; }));
    t('an owner key in the passkey (SPKI) form is refused', v.valid === false && v.code === 'bad-owner-key', v);

    console.log('--- ' + tag + 'revocation and key windows ---');
    const doc = issuer.keyDoc();
    const raw = fs.readFileSync(issuer.keyDocPath);
    issuer.setKeyDoc({ keys: [Object.assign({}, doc.keys[0], { validFrom: L.iso(Date.parse(cred.issuedAt) + 3600000) })] });
    v = await verify(cred);
    t('a key that was not yet valid at the issue time does not verify', v.valid === false && /not valid at issuedAt/.test(v.reason), v);
    fs.writeFileSync(issuer.keyDocPath, raw);
    issuer.revoke(cred.id);
    v = await verify(cred);
    t('after the issuer revokes the account ID, the wallet refuses the credential', v.valid === false && /revoked/.test(v.reason), v);
    const again = await issuer.post(await L.buildRequest(owner, 'GOPH'));
    t('...and the issuer will not sign it again', again.status === 409 && again.json.code === 'account-revoked', again);

    console.log('--- ' + tag + 'adding to the wallet ---');
    const created = await W((pw) => AtlasWallet.createIdentity(pw), 'issuance-test-password');
    const mine = created.publicKey;
    const add = (c) => w.sw.evaluate('(async () => { try { return { ok: true, value: await AtlasWallet.addLedgerAccount(' + JSON.stringify(c) + ', { allowNetwork: true }) }; } catch (e) { return { ok: false, code: e.code || null, message: e.message }; } })()');
    const fresh = await obtain('MWC');
    let r = await add(fresh.cred);
    t('a reference for another identity\'s account is not added', r.ok === false && r.code === 'wrong-identity', r);
    t('...and nothing was stored', (await W(() => AtlasWallet.getLedgerOverview())).accounts.length === 0);

    // The test issuer double signs for the wallet's own key; its network is a Labs 29 one, so the derived-ID rule applies.
    const dbl = await T.startIssuer();
    const net = 'chainblock-labs29-' + dbl.domain;
    const wrongId = await dbl.issue(mine, { network: net, coin: 'GOPH' }, { id: 'urn:atlas:ledger-account:' + 'cd'.repeat(32) });
    r = await add(wrongId);
    t('a validly signed reference with an ID that is not the derived one is not added', r.ok === false && r.code === 'credential-invalid', r);
    const right = await dbl.issue(mine, { network: net, coin: 'GOPH' });
    r = await add(right);
    t('the same reference with the derived ID is added', r.ok === true && r.value.id === L.derivedId(net, 'GOPH', mine), r);
    t('it is held as a reference with no balance and no permission to contact anything', (await W(() => AtlasWallet.getLedgerOverview())).accounts.every((a) => a.consent === null && a.balance === null));
    await dbl.close();
  } finally {
    await w.close();
    await fr.close();
    issuer.close();
  }
}

(async () => {
  const tls = makeCert();
  const cores = [await L.startCoreStandin()];
  if (CORE_DIR) cores.push(await L.startCoreReal(CORE_DIR)); else console.log('NOTE CORE_LABS_DIR is not set: the ledger here is the stand-in.');
  try {
    for (const kind of ['node', 'php']) for (const core of cores) await run(kind, core, tls);
  } finally {
    for (const core of cores) await core.close();
    fs.rmSync(tls.dir, { recursive: true, force: true });
  }
  process.exit(E.finish('manual-ledger-issuance-wallet'));
})().catch((err) => { console.log('FATAL', err && err.stack || err); process.exit(1); });
