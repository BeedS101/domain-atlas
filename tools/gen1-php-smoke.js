#!/usr/bin/env node
// Checks a deployed PHP issuer over HTTP. Read-only unless --mutating is given.
//
//   node tools/gen1-php-smoke.js https://example.com                      read-only checks
//   node tools/gen1-php-smoke.js https://example.com --save-baseline before.json
//   node tools/gen1-php-smoke.js https://example.com --baseline before.json
//   node tools/gen1-php-smoke.js https://example.com --mutating          also run a spend smoke test
//   node tools/gen1-php-smoke.js https://example.com --private-url /atlas-private/txn/   extra path to probe
//
// Read-only checks:
//   - the published key document and revocation list are served and valid;
//   - private paths (the issuer key, state files, the replay / journal / holdings directories, the
//     command-line tool) are NOT served, and their responses contain nothing that looks like a key
//     or a credential;
//   - with --baseline: every revocation entry recorded earlier is still there, unchanged, in order,
//     and the published keys are still published.
//
// --mutating runs issue, split and consolidate of 10 units of Iron for a throw-away owner key. It
// permanently adds 3 revocation entries and 3 holdings records for that key; nothing else changes.
// It checks that a repeated request returns the same signed answer, that each spend appears in the
// public list exactly once with a transaction tag, and that earlier entries are untouched.
//
// Exit code 0 when every check passes, 1 otherwise.
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
const flag = (name) => args.includes(name);
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const values = (name) => args.reduce((out, a, i) => (a === name && args[i + 1] ? out.concat(args[i + 1]) : out), []);
if (!base) {
  console.error('usage: node tools/gen1-php-smoke.js <base url> [--save-baseline file] [--baseline file] [--mutating] [--private-url /path/]');
  process.exit(2);
}

let failures = 0;
const line = (ok, text, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}${!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''}`);
};
const info = (text) => console.log('INFO ' + text);

async function get(path) {
  try {
    const res = await fetch(base + path, { redirect: 'manual' });
    return { status: res.status, text: await res.text(), headers: res.headers };
  } catch (e) { return { status: 0, text: '', error: e.message }; }
}
async function post(path, body) {
  try {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, text, json };
  } catch (e) { return { status: 0, text: '', json: null, error: e.message }; }
}
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const rid = () => crypto.randomBytes(18).toString('base64url');

// Anything a visitor must never be able to read. A 403 or 404 is the answer; 200 with a body that
// looks like a key, a credential or a state file is a leak. 301/302 to a directory listing is not
// trusted either.
const PRIVATE_PATHS = [
  '/lib/issuer-private-key.pem', '/lib/reviewer-private-key.pem', '/lib/atlas-mail-store.json',
  '/lib/atlas-postoffice-members-store.json', '/lib/atlas-subscribers-store.json', '/lib/atlas-admin-keys-store.json',
  '/lib/atlas-recovery-secret.json', '/lib/atlas-ledger-receipts-config.json', '/lib/atlas-ledger-issuance-config.json',
  '/lib/bootstrap.php', '/lib/store.php', '/lib/atlas-cli.php', '/lib/', '/lib/.htaccess',
  '/lib/replay/', '/lib/holdings/', '/lib/txn/', '/lib/txn/.htaccess', '/lib/atlas-revocations.lock'
].concat(values('--private-url'));
const LOOKS_PRIVATE = /-----BEGIN|"signature"\s*:|"credential"\s*:|"responseJson"|"predecessors"|"held"\s*:|<\?php|function\s+\w+\s*\(/;

async function readDocs() {
  const key = await get('/.well-known/atlas-key.json');
  const rev = await get('/.well-known/atlas-revocations.json');
  let keyDoc = null, revDoc = null;
  try { keyDoc = JSON.parse(key.text); } catch (e) { /* reported below */ }
  try { revDoc = JSON.parse(rev.text); } catch (e) { /* reported below */ }
  return { key, rev, keyDoc, revDoc };
}

(async () => {
  console.log('Gen1 PHP issuer smoke test: ' + base + (flag('--mutating') ? ' (MUTATING)' : ' (read-only)'));
  const before = await readDocs();
  line(before.key.status === 200 && before.keyDoc && Array.isArray(before.keyDoc.keys) && before.keyDoc.keys.length > 0, 'published key document is served and lists a key', before.key.status);
  line(before.rev.status === 200 && before.revDoc && Array.isArray(before.revDoc.revoked), 'published revocation list is served and valid', before.rev.status);
  const entries = (before.revDoc && before.revDoc.revoked) || [];
  info(`revocation list: ${entries.length} entries (${entries.filter((e) => e.txn).length} tagged), ${Buffer.byteLength(before.rev.text)} bytes, ${(before.rev.text.length / 4194304 * 100).toFixed(1)}% of the wallet's 4 MiB read limit`);
  info('published key(s): ' + ((before.keyDoc && before.keyDoc.keys) || []).map((k) => String(k.publicKey).slice(0, 12) + '...').join(', '));

  console.log('\n-- private paths must not be served --');
  for (const p of PRIVATE_PATHS) {
    const r = await get(p);
    const denied = [401, 403, 404, 410].includes(r.status);
    line(denied && !LOOKS_PRIVATE.test(r.text), `${p} -> ${r.status || r.error}`, r.text.slice(0, 80));
  }

  if (valueOf('--baseline')) {
    console.log('\n-- compared with the saved baseline --');
    const saved = JSON.parse(fs.readFileSync(valueOf('--baseline'), 'utf8'));
    const prefix = entries.slice(0, saved.count);
    line(entries.length >= saved.count, `no entry has been lost (${entries.length} now, ${saved.count} before)`);
    line(sha(JSON.stringify(prefix)) === saved.entriesSha256, 'the first ' + saved.count + ' entries are identical to the baseline, in order');
    const publishedNow = new Set(((before.keyDoc && before.keyDoc.keys) || []).map((k) => k.publicKey));
    line(saved.publicKeys.every((k) => publishedNow.has(k)), 'every previously published issuer key is still published');
  }
  if (valueOf('--save-baseline')) {
    const baseline = {
      savedAt: new Date().toISOString(), base, count: entries.length,
      entriesSha256: sha(JSON.stringify(entries)),
      publicKeys: ((before.keyDoc && before.keyDoc.keys) || []).map((k) => k.publicKey),
      keyDocSha256: sha(before.key.text), revocationFileSha256: sha(before.rev.text)
    };
    fs.writeFileSync(valueOf('--save-baseline'), JSON.stringify(baseline, null, 2));
    info('baseline saved to ' + valueOf('--save-baseline'));
  }

  if (flag('--mutating')) {
    console.log('\n-- spend smoke test (throw-away owner, Iron) --');
    const owner = 'SMOKETEST-' + crypto.randomBytes(8).toString('hex');
    const cls = 'atlas.element.iron';
    const issueId = rid(), splitId = rid(), consolidateId = rid();
    const a = await post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: cls, quantity: 10, requestId: issueId });
    line(a.status === 200 && a.json && a.json.signature, 'issue 10 Iron', [a.status, a.text.slice(0, 160)]);
    if (!(a.status === 200 && a.json)) return finish();
    const a2 = await post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: cls, quantity: 10, requestId: issueId });
    line(a2.status === 200 && a2.text === a.text, 'repeating the issue returns the identical signed credential');
    const s = await post('/atlas/asset/split', { credential: a.json, sendAmount: 4, toPublicKey: owner, requestId: splitId });
    line(s.status === 200 && s.json && s.json.sent && s.json.remainder, 'split 4 off', [s.status, s.text.slice(0, 160)]);
    if (!(s.status === 200 && s.json && s.json.sent)) return finish();
    const s2 = await post('/atlas/asset/split', { credential: a.json, sendAmount: 4, toPublicKey: owner, requestId: splitId });
    line(s2.status === 200 && s2.text === s.text, 'repeating the split returns the identical answer and spends nothing again');
    const c = await post('/atlas/asset/consolidate', { credentials: [s.json.sent, s.json.remainder], requestId: consolidateId });
    line(c.status === 200 && c.json && c.json.quantity === 10, 'consolidate back to 10', [c.status, c.text.slice(0, 160)]);
    const c2 = await post('/atlas/asset/consolidate', { credentials: [s.json.sent, s.json.remainder], requestId: consolidateId });
    line(c2.status === 200 && c2.text === c.text, 'repeating the consolidation returns the identical answer');
    const spentAgain = await post('/atlas/asset/split', { credential: a.json, sendAmount: 1, toPublicKey: owner, requestId: rid() });
    line(spentAgain.status >= 400 && spentAgain.status < 500, 'a spent credential is refused with a new request id', [spentAgain.status, spentAgain.text.slice(0, 120)]);

    const after = await readDocs();
    const nowEntries = (after.revDoc && after.revDoc.revoked) || [];
    line(after.rev.status === 200 && Array.isArray(nowEntries), 'revocation list still valid after the spends');
    line(sha(JSON.stringify(nowEntries.slice(0, entries.length))) === sha(JSON.stringify(entries)), 'all ' + entries.length + ' earlier entries are unchanged and in order');
    for (const [label, id] of [['issued credential', a.json.id], ['split part sent', s.json.sent.id], ['split remainder', s.json.remainder.id]]) {
      const hits = nowEntries.filter((e) => e.id === id);
      line(hits.length === 1 && typeof hits[0].txn === 'string', `${label} is recorded as spent exactly once with a transaction tag`, hits);
    }
    line(nowEntries.filter((e) => e.id === c.json.id).length === 0, 'the final credential is not revoked');
    info('left behind: 3 revocation entries and holdings records for owner ' + owner);
  }
  finish();
})();

function finish() {
  console.log(failures === 0 ? '\nRESULT: all checks passed' : `\nRESULT: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
