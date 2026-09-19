// Manual check for a real bug Bruno found by hand: converting gold into
// boron on the live site showed "✗ signature does not match" on the
// resulting boron card.
//
// Root cause: issuer-php/lib/crypto.php's canonicalize() used PHP's plain
// (string) cast for floats, on the old assumption (documented right above
// where that comment used to live) that no float ever reached anything
// hashed. That was true before task #204/#205/#206 gave every element a
// properties bag full of real physical constants — some of which, like
// boron's atlas.electricalConductivity (1e-10 MS/m — it barely conducts at
// all), are small enough to force scientific notation. PHP's (string) cast
// and JS's Number::toString (what extension/wallet.js's canonicalize()
// uses, via JSON.stringify) disagree on that notation: PHP's (string)1e-10
// is "1.0E-10", JS's is "1e-10" — different bytes signed vs. different
// bytes re-verified, so the ECDSA check correctly (if confusingly) fails.
// Boron is just the one Bruno happened to convert into first; sulfur,
// selenium, and iodine's own electricalConductivity values (1e-15, 1e-7,
// 1e-13) hit the exact same bug and are covered here too.
//
// The fix (crypto.php's canonicalize(), see its own comment) uses
// json_encode() with serialize_precision=-1, which matches JS's
// "shortest round-trippable decimal" algorithm for every value actually
// in the catalog, with one small patch for a systematic remaining gap
// (PHP keeps a redundant ".0" on a whole-number scientific-notation
// mantissa where JS drops it).
//
// This test converts gold into all four affected elements on the PHP
// backend and independently re-verifies each resulting credential's
// signature the exact way wallet.js's verifyCredential() does (fresh
// Web Crypto ECDSA verify against the issuer's own published key) —
// not just "did the HTTP call return 200", which the existing currency-
// conversion test already covers and which this bug passed right through
// undetected. Also converts into the two SAFE elements bracketing the
// four broken ones alphabetically (beryllium, carbon) as a control, and
// checks the Node backend for parity, since Node's canonicalize() (plain
// JS) was never affected by this — confirming the fix didn't need to
// touch anything there.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts (spins up its own isolated server instances).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { subtle } = require('crypto').webcrypto;

const NODE_PORT = 8101;
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const PHP_PORT = 8102; // isolated from every other manual-*.js test's chosen port
const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sciNotation-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sciNotation-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sciNotation-php-'));

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(str) { return new Uint8Array(Buffer.from(str, 'base64url')); }
// Byte-for-byte copy of extension/wallet.js's canonicalize() — this test
// is specifically about the client's re-verification agreeing with
// whichever backend signed the credential, so it has to use the SAME
// algorithm the real wallet does, not just "some" canonical JSON.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
function assetPayloadOf(c) {
  return { id: c.id, asset: c.asset, owner: c.owner, quantity: c.quantity, supersedes: c.supersedes, issuedAt: c.issuedAt };
}
async function verifyCredential(credential, base) {
  const keyDoc = await fetch(base + '/.well-known/atlas-key.json', { cache: 'no-store' }).then((r) => r.json());
  const issuedAt = new Date(credential.issuedAt).getTime();
  const activeKey = (keyDoc.keys || []).find((k) => {
    const from = new Date(k.validFrom).getTime();
    const until = k.validUntil ? new Date(k.validUntil).getTime() : Infinity;
    return k.publicKey === credential.issuer.publicKey && issuedAt >= from && issuedAt <= until;
  });
  if (!activeKey) return { valid: false, reason: 'issuer key was not valid at issuedAt' };
  const data = new TextEncoder().encode(canonicalize(assetPayloadOf(credential)));
  const publicKey = await subtle.importKey('raw', fromB64url(activeKey.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const sigOk = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromB64url(credential.signature), data);
  return { valid: sigOk, reason: sigOk ? 'ok' : 'signature does not match' };
}
async function issueGold(base, owner, quantity) {
  const res = await fetch(base + '/atlas/asset/issue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerPublicKey: owner, assetClass: 'atlas.element.gold', quantity })
  });
  if (!res.ok) throw new Error('mint failed: ' + await res.text());
  return res.json();
}
async function convert(base, goldCredential, toClass) {
  const res = await fetch(base + '/atlas/convert', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: goldCredential, spendAmount: goldCredential.quantity, toClass })
  });
  if (!res.ok) throw new Error('convert to ' + toClass + ' failed: ' + await res.text());
  return res.json();
}

const BROKEN_ELEMENTS = ['atlas.element.boron', 'atlas.element.sulfur', 'atlas.element.selenium', 'atlas.element.iodine'];
const CONTROL_ELEMENTS = ['atlas.element.beryllium', 'atlas.element.carbon'];

(async () => {
  console.log('SETUP: starting an isolated issuer-server instance on port ' + NODE_PORT);
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(NODE_PORT), ATLAS_DOMAIN: NODE_DOMAIN, ATLAS_STATE_DIR: NODE_STATE_DIR, ATLAS_DOCROOT: NODE_DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + NODE_PORT);

  console.log('SETUP: copying issuer-php into an isolated bundle and starting php -S on port ' + PHP_PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), PHP_BUNDLE_DIR, { recursive: true });
  const phpProc = spawn('php', ['-S', 'localhost:' + PHP_PORT, 'test-router.php'], { cwd: PHP_BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    phpProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    phpProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-php dev server up on port ' + PHP_PORT);

  const NODE_BASE = 'http://localhost:' + NODE_PORT;
  const PHP_BASE = 'http://localhost:' + PHP_PORT;
  const OWNER = 'test-owner-sci-notation-signature';

  try {
    for (const [label, base] of [['Node', NODE_BASE], ['PHP', PHP_BASE]]) {
      console.log('\n--- ' + label + ' backend ---');
      for (const toClass of [...BROKEN_ELEMENTS, ...CONTROL_ELEMENTS]) {
        const gold = await issueGold(base, OWNER, 1000000);
        const result = await convert(base, gold, toClass);
        const verdict = await verifyCredential(result.received, base);
        const tag = BROKEN_ELEMENTS.includes(toClass) ? '(previously broken on PHP)' : '(control)';
        if (!verdict.valid) {
          throw new Error(label + ' backend: converting into ' + toClass + ' produced an unverifiable credential ' + tag + ' -> ' + verdict.reason);
        }
        console.log('PASS:', label, '->', toClass, tag, '- signature verifies (' + result.received.quantity + ' units)');
      }
    }
    console.log('\nALL SCIENTIFIC-NOTATION SIGNATURE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    nodeProc.kill();
    phpProc.kill();
    fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true });
    fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true });
    fs.rmSync(PHP_BUNDLE_DIR, { recursive: true, force: true });
  }
})().catch((err) => { console.error('FAILURE:', err); process.exitCode = 1; });
