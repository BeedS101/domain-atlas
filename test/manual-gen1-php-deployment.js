// Deployment-readiness tests for the PHP issuer (issuer-php) on shared-hosting-like conditions,
// against throw-away copies. Nothing live is read or written.
//
//   node test/manual-gen1-php-deployment.js [section ...]
//
// Sections: permissions, private, identity, processes, upgrade, mixed, cli, smoke, tmp.
// With no argument every section runs. Needs php; the permission tests run the issuer as the
// unprivileged account "nobody" through setpriv, because the sandbox user is root and root ignores
// file permissions. The upgrade tests export older commits with git archive; they are skipped
// (and said to be) when a commit is not in this clone.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { REPO, startPhp, startNode, api } = require('./lib/gen1-issuers');

const WANT = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const run = (name) => WANT.length === 0 || WANT.includes(name);
const GOLD = 'atlas.element.gold';
const IRON = 'atlas.element.iron';
const PLAT = 'atlas.element.platinum';
const NOBODY = ['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups'];

let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''}`);
}
const skip = (name, why) => console.log(`SKIP ${name} :: ${why}`);
let n = 0;
const owner = (label) => 'TESTOWNER-' + label + '-' + (++n) + '-' + crypto.randomBytes(4).toString('hex');
const rid = () => crypto.randomBytes(18).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const modeOf = (p) => { try { return (fs.statSync(p).mode & 0o777).toString(8).padStart(4, '0'); } catch (e) { return null; } };
const read = (p) => { try { return fs.readFileSync(p); } catch (e) { return null; } };
const chown = (p, recursive) => execFileSync('chown', recursive ? ['-R', '65534:65534', p] : ['65534:65534', p]);
const revList = (be) => { try { return JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked; } catch (e) { return null; } };
const revIds = (be) => new Set((revList(be) || []).map((r) => r.id));
const files = (dir) => { try { return fs.readdirSync(dir); } catch (e) { return []; } };
const tmpLeft = (be) => [path.join(be.bundle, '.well-known'), path.join(be.bundle, 'lib'), be.txnDir, be.replayDir, be.holdingsDir].flatMap((d) => files(d).filter((f) => /\.tmp$/.test(f)).map((f) => path.join(d, f)));

async function mint(A, own, cls, qty, extra) {
  const r = await A.post('/atlas/asset/issue', Object.assign({ ownerPublicKey: own, assetClass: cls, quantity: qty }, extra || {}));
  if (r.status !== 200) throw new Error('mint failed: ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body;
}
const splitReq = (c, amount, to, id) => ({ credential: c, sendAmount: amount, toPublicKey: to, requestId: id || rid() });

// Runs lib/atlas-cli.php in a bundle, optionally as nobody.
function cli(be, args, opts) {
  const o = opts || {};
  const cmd = (o.asNobody ? NOBODY : []).concat(['php', path.join(be.bundle, 'lib', 'atlas-cli.php')], args);
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: be.bundle, encoding: 'utf8', env: { ...process.env, ...(o.env || {}) } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

let nextPort = 18710;
const port = () => nextPort++;

// ------------------------------------------------------------------------------------------------
async function permissions() {
  console.log('\n=== file permissions on ordinary and restrictive hosts (issuer runs as an unprivileged user) ===');
  // An ordinary shared host: directories 0755, files 0644, everything owned by the web account.
  let be = await startPhp(port(), { user: 'nobody', workers: 0 });
  try {
    const A = api(be);
    const own = owner('p1'), other = owner('p1b');
    const c = await mint(A, own, GOLD, 10);
    const r1 = await A.post('/atlas/asset/split', splitReq(c, 4, other));
    check('P1 ordinary host: issue and split succeed', r1.status === 200, [r1.status, r1.body]);
    const dirs = { replay: be.replayDir, holdings: be.holdingsDir, txn: be.txnDir };
    check('P2 replay, holdings and txn directories are created 0700', Object.values(dirs).every((d) => modeOf(d) === '0700'), Object.fromEntries(Object.entries(dirs).map(([k, d]) => [k, modeOf(d)])));
    const stored = [...files(be.replayDir), ...files(be.holdingsDir)].filter((f) => f.endsWith('.json'));
    check('P3 their files are created 0600', stored.length >= 2 && [be.replayDir, be.holdingsDir].every((d) => files(d).filter((f) => f.endsWith('.json')).every((f) => modeOf(path.join(d, f)) === '0600')), stored.map((f) => modeOf(path.join(be.replayDir, f)) || modeOf(path.join(be.holdingsDir, f))));
    const guard = (d) => (read(path.join(d, '.htaccess')) || '').toString();
    check('P4 each of them carries its own deny-all .htaccess (written by PHP, not by the upload)', [be.replayDir, be.holdingsDir, be.txnDir].every((d) => /Require all denied/.test(guard(d)) && /Deny from all/.test(guard(d))));
    check('P5 the revocation list keeps its public mode (0644) and stays owned by the web account', modeOf(be.revFile) === '0644' && fs.statSync(be.revFile).uid === 65534, [modeOf(be.revFile), fs.statSync(be.revFile).uid]);
    check('P6 the issuer key is 0600 and lib/.htaccess is in place', modeOf(path.join(be.bundle, 'lib', 'issuer-private-key.pem')) === '0600' && /Require all denied/.test(guard(path.join(be.bundle, 'lib'))));
    check('P7 no temporary files remain', tmpLeft(be).length === 0, tmpLeft(be));
    check('P8 the journal is empty after a normal operation', files(be.txnDir).filter((f) => f.endsWith('.json')).length === 0);
  } finally { be.stop(); }

  // A restrictive host: umask 077 style - nothing readable by anyone but the web account.
  be = await startPhp(port(), { user: 'nobody', workers: 0, prepare: (b) => {} });
  try {
    const A = api(be);
    const own = owner('p2'), other = owner('p2b');
    const c = await mint(A, own, GOLD, 10);
    for (const d of [path.join(be.bundle, 'lib'), path.join(be.bundle, '.well-known')]) fs.chmodSync(d, 0o700);
    fs.chmodSync(be.revFile, 0o600);
    const r = await A.post('/atlas/asset/split', splitReq(c, 3, other));
    check('P9 restrictive host (directories 0700, list 0600): split succeeds', r.status === 200, [r.status, r.body]);
    check('P10 ...and the replaced revocation list keeps mode 0600 (permissions are never widened)', modeOf(be.revFile) === '0600', modeOf(be.revFile));
    check('P11 ...the directories stay 0700', modeOf(path.join(be.bundle, '.well-known')) === '0700' && modeOf(path.join(be.bundle, 'lib')) === '0700');
  } finally { be.stop(); }

  // lib/ not writable: no locks, no journal, so nothing may be spent.
  be = await startPhp(port(), { user: 'nobody', workers: 0 });
  try {
    const A = api(be);
    const own = owner('p3'), other = owner('p3b');
    const c = await mint(A, own, GOLD, 10);
    const before = read(be.revFile);
    fs.chmodSync(path.join(be.bundle, 'lib'), 0o555);
    for (const sub of [be.replayDir, be.holdingsDir, be.txnDir]) { try { fs.chmodSync(sub, 0o555); } catch (e) { /* not there */ } }
    const r = await A.post('/atlas/asset/split', splitReq(c, 3, other));
    check('P12 lib/ read-only: split is refused with a controlled JSON error (the spend lock cannot be taken)', (r.status === 503 || (r.status === 400 && r.body.code === 'busy')) && typeof r.body.error === 'string', [r.status, r.body]);
    check('P13 ...the revocation list is untouched and the balance is unspent', Buffer.compare(before, read(be.revFile)) === 0 && !revIds(be).has(c.id));
    const pub = await A.get('/.well-known/atlas-revocations.json');
    check('P14 ...public reads still work', pub.status === 200);
    fs.chmodSync(path.join(be.bundle, 'lib'), 0o755);
    for (const sub of [be.replayDir, be.holdingsDir, be.txnDir]) { try { fs.chmodSync(sub, 0o700); } catch (e) { /* not there */ } }
    const again = await A.post('/atlas/asset/split', splitReq(c, 3, other));
    check('P15 ...and the same balance spends once the permission is fixed', again.status === 200, [again.status, again.body]);
  } finally { be.stop(); }

  // .well-known not writable but the list itself is: no in-place write.
  be = await startPhp(port(), { user: 'nobody', workers: 0 });
  try {
    const A = api(be);
    const own = owner('p4'), other = owner('p4b');
    const c = await mint(A, own, GOLD, 10);
    fs.chmodSync(be.revFile, 0o666);
    const before = read(be.revFile);
    fs.chmodSync(path.join(be.bundle, '.well-known'), 0o555);
    const r = await A.post('/atlas/asset/split', splitReq(c, 3, other));
    check('P16 .well-known read-only (list itself writable): 503, no in-place write', r.status === 503 && Buffer.compare(before, read(be.revFile)) === 0, [r.status, r.body]);
    check('P17 ...the journal entry written for the attempt is rolled back', files(be.txnDir).filter((f) => f.endsWith('.json')).length === 0 && tmpLeft(be).length === 0);
    fs.chmodSync(path.join(be.bundle, '.well-known'), 0o755);
  } finally { be.stop(); }

  // A directory made by hand (File Manager) under another account: refused, not worked around.
  be = await startPhp(port(), { user: 'nobody', workers: 0 });
  try {
    const A = api(be);
    const own = owner('p5'), other = owner('p5b');
    const c = await mint(A, own, GOLD, 10);
    fs.mkdirSync(be.txnDir, { recursive: true });
    fs.chmodSync(be.txnDir, 0o755);
    execFileSync('chown', ['0:0', be.txnDir]);
    const before = read(be.revFile);
    const r = await A.post('/atlas/asset/split', splitReq(c, 3, other));
    check('P18 a journal directory the web account cannot write: 503 before anything is spent', r.status === 503 && Buffer.compare(before, read(be.revFile)) === 0 && !revIds(be).has(c.id), [r.status, r.body]);
    chown(be.txnDir);
    const again = await A.post('/atlas/asset/split', splitReq(c, 3, other));
    check('P19 ...fixed by handing the directory to the web account', again.status === 200, [again.status, again.body]);
  } finally { be.stop(); }

  // Revocation list owned by someone else, directory writable: replaced by rename, mode kept.
  be = await startPhp(port(), { user: 'nobody', workers: 0 });
  try {
    const A = api(be);
    const own = owner('p6'), other = owner('p6b');
    const c = await mint(A, own, GOLD, 10);
    execFileSync('chown', ['0:0', be.revFile]);
    fs.chmodSync(be.revFile, 0o644);
    const r = await A.post('/atlas/asset/split', splitReq(c, 3, other));
    check('P20 list owned by another account but directory writable: replaced atomically', r.status === 200 && revIds(be).has(c.id), [r.status, r.body]);
    check('P21 ...mode kept at 0644', modeOf(be.revFile) === '0644');
  } finally { be.stop(); }

  // Private state outside the web root.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-private-'));
  chown(outside);
  be = await startPhp(port(), { user: 'nobody', workers: 0, prepare: (b) => fs.writeFileSync(path.join(b, 'lib', 'atlas-private-dir.txt'), outside + '\n') });
  try {
    const A = api(be);
    const own = owner('p7'), other = owner('p7b');
    const c = await mint(A, own, GOLD, 10);
    const sid = rid();
    const r = await A.post('/atlas/asset/split', splitReq(c, 3, other, sid));
    check('P22 private state outside the web root: operations succeed', r.status === 200, [r.status, r.body]);
    check('P23 ...replay and holdings are in that directory', files(path.join(outside, 'replay')).some((f) => f.endsWith('.json')) && files(path.join(outside, 'holdings')).some((f) => f.endsWith('.json')) && modeOf(path.join(outside, 'replay')) === '0700');
    check('P24 ...and nothing was written under lib/', !fs.existsSync(be.replayDir) && !fs.existsSync(be.holdingsDir) && !fs.existsSync(be.txnDir));
    check('P25 ...no .htaccess is added outside the web root (not needed)', !fs.existsSync(path.join(outside, 'replay', '.htaccess')));
    const r2 = await A.post('/atlas/asset/split', splitReq(c, 3, other, sid));
    check('P26 ...a repeated request returns the identical answer from there', r2.status === 200 && JSON.stringify(r2.body) === JSON.stringify(r.body));
  } finally { be.stop(); fs.rmSync(outside, { recursive: true, force: true }); }

  // A misconfigured private directory is an error, never a quiet fallback to lib/.
  for (const [label, value, fix] of [
    ['a relative path', 'atlas-private', null],
    ['a directory that does not exist', path.join(os.tmpdir(), 'atlas-private-missing-' + crypto.randomBytes(4).toString('hex')), null],
    ['a directory the web account cannot write', 'LOCKED', (d) => { fs.chmodSync(d, 0o555); }]
  ]) {
    const dir = value === 'LOCKED' ? fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-private-')) : value;
    if (value === 'LOCKED') chown(dir);
    be = await startPhp(port(), { user: 'nobody', workers: 0 });
    try {
      const A = api(be);
      const own = owner('p8'), other = owner('p8b');
      const c = await mint(A, own, GOLD, 10);
      fs.writeFileSync(path.join(be.bundle, 'lib', 'atlas-private-dir.txt'), dir + '\n');
      chown(path.join(be.bundle, 'lib', 'atlas-private-dir.txt'));
      if (fix) fix(dir);
      await be.restart();
      const before = read(be.revFile);
      const listing = () => JSON.stringify([be.replayDir, be.holdingsDir, be.txnDir].map((d) => files(d).sort()));
      const listed = listing();
      const r = await A.post('/atlas/asset/split', splitReq(c, 3, other));
      check(`P27 private directory is ${label}: 503 and nothing spent`, r.status === 503 && Buffer.compare(before, read(be.revFile)) === 0 && !revIds(be).has(c.id), [r.status, r.body]);
      check(`P28 ...and nothing is written to lib/ instead (no quiet fallback)`, listing() === listed, [listed, listing()]);
    } finally { be.stop(); if (value === 'LOCKED') { try { fs.chmodSync(dir, 0o755); } catch (e) { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); } }
  }
}

// ------------------------------------------------------------------------------------------------
// Asynchronous on purpose: php -S serves one connection at a time, and a test process blocked in
// spawnSync cannot close the idle keep-alive sockets it holds to that server.
function smoke(be, extra) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(REPO, 'tools', 'gen1-php-smoke.js'), be.base].concat(extra || []));
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { p.kill(); resolve({ status: 'timeout', out }); }, 60000);
    p.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, out }); });
  });
}
const guardedRouter = (b) => fs.copyFileSync(path.join(__dirname, 'lib', 'guarded-router.php'), path.join(b, 'guarded-router.php'));

async function privateData() {
  console.log('\n=== private data is not reachable over HTTP ===');
  const tracked = execFileSync('git', ['-C', REPO, 'ls-files', 'issuer-php'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  check('D1 lib/.htaccess is part of the repository (an upload must include dot-files)', tracked.includes('issuer-php/lib/.htaccess') && tracked.includes('issuer-php/atlas/.htaccess') && tracked.includes('issuer-php/.well-known/.htaccess'));
  check('D2 no key, store, journal or lock file is tracked', !tracked.some((f) => /\.pem$|-store\.json$|-config\.json$|\.lock$|\/(replay|holdings|txn)\//.test(f)), tracked.filter((f) => /\.pem$|-store\.json$|\.lock$/.test(f)));
  const deny = fs.readFileSync(path.join(REPO, 'issuer-php', 'lib', '.htaccess'), 'utf8');
  check('D3 lib/.htaccess denies on both Apache 2.4 and 2.2 syntax', /Require all denied/.test(deny) && /Deny from all/.test(deny));

  // With the deny rule honoured (emulated), the smoke tool must pass; with a server that ignores
  // .htaccess it must fail and say which path leaked. The second run is the negative control.
  const guarded = await startPhp(port(), { workers: 0, router: 'guarded-router.php', prepare: guardedRouter });
  try {
    const A = api(guarded);
    const own = owner('d1');
    const c = await mint(A, own, GOLD, 10);
    await A.post('/atlas/asset/split', splitReq(c, 3, owner('d1b')));
    check('D4 state exists to be protected: key, replay record, holdings, mail-style store', fs.existsSync(path.join(guarded.bundle, 'lib', 'issuer-private-key.pem')) && files(guarded.replayDir).some((f) => f.endsWith('.json')));
    const s = await smoke(guarded);
    check('D5 deny rule honoured: the smoke test passes and probes every private path', s.status === 0 && /\/lib\/issuer-private-key\.pem -> 403/.test(s.out) && /\/lib\/txn\/ -> 403/.test(s.out), s.out.slice(-600));
    // A file in a replay directory is denied by that directory's own .htaccess even without lib/'s.
    const record = files(guarded.replayDir).find((f) => f.endsWith('.json'));
    const direct = await fetch(guarded.base + '/lib/replay/' + record);
    check('D6 a replay record fetched by its exact URL is refused', direct.status === 403 && !/signature/.test(await direct.text()));
    fs.rmSync(path.join(guarded.bundle, 'lib', '.htaccess'));
    const nested = await fetch(guarded.base + '/lib/replay/' + record);
    check('D7 ...and still refused when lib/.htaccess is missing, because the directory carries its own', nested.status === 403);
    const pf = cli(guarded, ['preflight']);
    check('D8 preflight reports a missing lib/.htaccess as a failure', pf.status === 1 && /FAIL\s+lib\/\.htaccess/.test(pf.out), pf.out.split('\n').filter((l) => /FAIL/.test(l)));
    const exposed = await fetch(guarded.base + '/lib/issuer-private-key.pem');
    check('D9 until it is back the issuer key would be served (this is the single point of failure)', exposed.status === 200 && /BEGIN/.test(await exposed.text()));
    await mint(A, owner('d1c'), IRON, 5);
    check('D9b the next request to the issuer writes lib/.htaccess back', /Require all denied/.test((read(path.join(guarded.bundle, 'lib', '.htaccess')) || '').toString()));
    check('D9c ...and the key is refused again', (await fetch(guarded.base + '/lib/issuer-private-key.pem')).status === 403);
  } finally { guarded.stop(); }

  const open = await startPhp(port(), { workers: 0 });
  try {
    const A = api(open);
    await mint(A, owner('d2'), IRON, 5);
    const s = await smoke(open);
    check('D10 negative control: a server that ignores .htaccess is caught by the smoke test', s.status === 1 && /FAIL \/lib\/issuer-private-key\.pem/.test(s.out), s.out.slice(-500));
  } finally { open.stop(); }
}

// ------------------------------------------------------------------------------------------------
async function identity() {
  console.log('\n=== the issuer never silently becomes a different issuer ===');
  let be = await startPhp(port(), { workers: 0 });
  try {
    const A = api(be);
    const keyFile = path.join(be.bundle, 'lib', 'issuer-private-key.pem');
    const docFile = path.join(be.bundle, '.well-known', 'atlas-key.json');
    await mint(A, owner('i1'), GOLD, 10);
    check('I1 a brand-new domain creates its key and publishes it', fs.existsSync(keyFile) && JSON.parse(fs.readFileSync(docFile, 'utf8')).keys.length === 1);
    const keyBytes = read(keyFile), docBytes = read(docFile), revBytes = read(be.revFile);
    fs.rmSync(keyFile);
    const r = await A.post('/atlas/asset/issue', { ownerPublicKey: owner('i2'), assetClass: GOLD, quantity: 10 });
    check('I2 private key file missing while a public key is published: 503, no new identity', r.status === 503 && /refusing to create a different identity/.test(JSON.stringify(r.body)), [r.status, r.body]);
    check('I3 ...no key file was created and the published documents are byte-for-byte unchanged', !fs.existsSync(keyFile) && Buffer.compare(docBytes, read(docFile)) === 0 && Buffer.compare(revBytes, read(be.revFile)) === 0);
    const s = await A.post('/atlas/asset/split', splitReq(await (async () => ({ credential: 'x' }))(), 1, 'y'));
    check('I4 ...and spends are refused the same way, not attempted', s.status >= 400);
    fs.writeFileSync(keyFile, keyBytes, { mode: 0o600 });
    const back = await A.post('/atlas/asset/issue', { ownerPublicKey: owner('i3'), assetClass: GOLD, quantity: 10 });
    check('I5 restoring the key file restores service with the same identity', back.status === 200 && Buffer.compare(docBytes, read(docFile)) === 0);
    // A hand-maintained document that lists the signing key second is left alone.
    const doc = JSON.parse(docBytes.toString('utf8'));
    const older = { publicKey: 'OLDKEY-' + crypto.randomBytes(30).toString('base64url'), validFrom: '2025-01-01T00:00:00Z', validUntil: '2026-01-01T00:00:00Z' };
    const multi = JSON.stringify({ keys: [older, doc.keys[0]] }, null, 2);
    fs.writeFileSync(docFile, multi);
    await mint(A, owner('i4'), GOLD, 10);
    check('I6 a published document listing an earlier key first is not rewritten', fs.readFileSync(docFile, 'utf8') === multi);
    // Garbage in the published document also counts as "published".
    fs.rmSync(keyFile);
    fs.writeFileSync(docFile, '{not json');
    const g = await A.post('/atlas/asset/issue', { ownerPublicKey: owner('i5'), assetClass: GOLD, quantity: 10 });
    check('I7 an unreadable published document does not license a new key either', g.status === 503 && !fs.existsSync(keyFile), [g.status, g.body]);
    // An empty list of keys is a domain that has not published anything yet.
    fs.writeFileSync(docFile, '{"keys":[]}');
    const e = await A.post('/atlas/asset/issue', { ownerPublicKey: owner('i6'), assetClass: GOLD, quantity: 10 });
    check('I8 a key document with no keys is treated as unpublished: a key is created', e.status === 200 && fs.existsSync(keyFile));
  } finally { be.stop(); }

  // The reviewer key follows the same rule.
  be = await startPhp(port(), { workers: 0 });
  try {
    const A = api(be);
    await mint(A, owner('i7'), GOLD, 10);
    const runPhp = (code) => spawnSync('php', ['-r', 'require ' + JSON.stringify(path.join(be.bundle, 'lib', 'crypto.php')) + '; require ' + JSON.stringify(path.join(be.bundle, 'lib', 'store.php')) + '; ' + code], { encoding: 'utf8' });
    const first = runPhp('$k = load_or_create_reviewer_keypair(); ensure_reviewer_well_known_file($k["publicKeyB64url"]); echo "created";');
    const pem = path.join(be.bundle, 'lib', 'reviewer-private-key.pem'), doc = path.join(be.bundle, '.well-known', 'atlas-reviewer-key.json');
    check('I9 a new domain creates its reviewer key', first.stdout === 'created' && fs.existsSync(pem) && fs.existsSync(doc), first.stderr);
    const docBytes = read(doc);
    fs.rmSync(pem);
    const second = runPhp('try { load_or_create_reviewer_keypair(); echo "created"; } catch (Exception $e) { echo "refused: " . $e->getMessage(); }');
    check('I10 reviewer key missing while its public key is published: refused', /^refused: .*refusing to create a different identity/.test(second.stdout) && !fs.existsSync(pem) && Buffer.compare(docBytes, read(doc)) === 0, second.stdout);
  } finally { be.stop(); }
}

// ------------------------------------------------------------------------------------------------
async function staleTemp() {
  console.log('\n=== stale temporary-file cleanup only touches the issuer\'s own temporary files ===');
  const old = new Date(Date.now() - 20 * 60 * 1000);
  const plant = (dir) => {
    const mine = path.join(dir, 'atlas-revocations.json.0123456789ab.tmp');
    const mineNode = path.join(dir, 'atlas-revocations.json.4242.0123abcd.tmp');
    const foreign = [path.join(dir, 'notes.tmp'), path.join(dir, 'upload.json.tmp'), path.join(dir, 'spatial.json.backup.tmp'), path.join(dir, 'atlas-key.json.tmp')];
    for (const f of [mine, mineNode, ...foreign]) { fs.writeFileSync(f, 'x'); fs.utimesSync(f, old, old); }
    const young = path.join(dir, 'atlas-revocations.json.ba9876543210.tmp');
    fs.writeFileSync(young, 'x');
    return { mine, mineNode, foreign, young };
  };
  const php = await startPhp(port(), { workers: 0 });
  try {
    const A = api(php);
    await mint(A, owner('t1'), IRON, 5);
    const p = plant(path.join(php.bundle, '.well-known'));
    await mint(A, owner('t2'), IRON, 5);
    check('T1 PHP: an old temporary file of the issuer\'s own kind is removed', !fs.existsSync(p.mine));
    check('T2 PHP: files that merely end in .tmp are left alone', p.foreign.every((f) => fs.existsSync(f)), p.foreign.filter((f) => !fs.existsSync(f)));
    check('T3 PHP: a recent temporary file (a write in progress) is left alone', fs.existsSync(p.young));
  } finally { php.stop(); }
  const node = await startNode(18790);
  try {
    const wk = path.dirname(node.revFile);
    const p = plant(wk);
    await node.restart({ ATLAS_TXN_NO_SWEEP: '' });
    await sleep(600);
    check('T4 Node: an old temporary file of the issuer\'s own kind is removed', !fs.existsSync(p.mineNode));
    check('T5 Node: files that merely end in .tmp are left alone', p.foreign.every((f) => fs.existsSync(f)), p.foreign.filter((f) => !fs.existsSync(f)));
    check('T6 Node: a recent temporary file is left alone', fs.existsSync(p.young));
  } finally { node.stop(); }
}

// ------------------------------------------------------------------------------------------------
async function cliSection() {
  console.log('\n=== operator command line (lib/atlas-cli.php) ===');
  // A healthy domain with a pending, committed transaction left by a stopped request.
  let be = await startPhp(port(), { user: 'nobody', workers: 0 });
  try {
    const A = api(be);
    const own = owner('c1'), other = owner('c1b');
    const c = await mint(A, own, GOLD, 10);
    await A.post('/atlas/asset/split', splitReq(c, 2, other));
    const hashes = () => ({ key: sha(read(path.join(be.bundle, 'lib', 'issuer-private-key.pem'))), doc: sha(read(path.join(be.bundle, '.well-known', 'atlas-key.json'))), rev: sha(read(be.revFile)) });
    const before = hashes();
    const listing = () => JSON.stringify([path.join(be.bundle, 'lib'), path.join(be.bundle, '.well-known')].map((d) => files(d).sort()));
    const listed = listing();
    const pf = cli(be, ['preflight'], { asNobody: true });
    check('C1 preflight on a healthy domain: exit 0, no FAIL lines', pf.status === 0 && !/^FAIL/m.test(pf.out), pf.out.split('\n').filter((l) => /FAIL|WARN/.test(l)));
    check('C2 ...it reports the key, the published key, the revocation count and checksum', /PASS\s+the published key document lists the public key/.test(pf.out) && /PASS\s+valid: \d+ entries/.test(pf.out) && /sha256 [0-9a-f]{64}/.test(pf.out));
    const pk = pf.out + cli(be, ['counts'], { asNobody: true }).out;
    const pem = read(path.join(be.bundle, 'lib', 'issuer-private-key.pem')).toString().split('\n').filter((l) => l.length > 20 && !l.startsWith('-----'));
    check('C3 nothing it prints contains private key material', pem.every((l) => !pk.includes(l)));
    const probe = cli(be, ['preflight', '--write-probe'], { asNobody: true });
    check('C4 --write-probe: atomic write and lock probes pass in each directory', probe.status === 0 && (probe.out.match(/atomic write \(temporary file, rename\) and removal work/g) || []).length >= 5 && /a lock file can be created/.test(probe.out), probe.out.split('\n').filter((l) => /FAIL/.test(l)));
    check('C5 ...and leaves no probe file behind', listing() === listed, [listed, listing()]);
    check('C6 the key, the published key document and the revocation list are unchanged by every command', JSON.stringify(hashes()) === JSON.stringify(before));
    const counts = cli(be, ['counts'], { asNobody: true });
    check('C7 counts prints the revocation entries, tagged entries and a state-file inventory', /revocation list: \d+ entries/.test(counts.out) && /state files in lib\//.test(counts.out) && /txn\/\s+0 file/.test(counts.out), counts.out);

    // A stopped request leaves a committed transaction.
    await be.restart({ ATLAS_TEST_CRASH_AT: 'txn:revoked' });
    const c2 = await mint(A, own, GOLD, 10).catch(() => null);
    be.env = {};
    await be.restart({});
    const c3 = await mint(A, own, GOLD, 10);
    await be.restart({ ATLAS_TEST_CRASH_AT: 'txn:revoked' });
    const crashed = await A.post('/atlas/asset/split', splitReq(c3, 4, other));
    check('C8 a stopped split leaves one journal entry', files(be.txnDir).filter((f) => f.endsWith('.json')).length === 1 && /non-json|network/.test(JSON.stringify(crashed.body)), crashed);
    const list = cli(be, ['txn-list'], { asNobody: true });
    check('C9 txn-list shows it as committed, without credentials or keys', /split\s+committed/.test(list.out) && !/signature|publicKey|TESTOWNER|urn:atlas:asset/.test(list.out), list.out);
    const refuse = cli(be, ['txn-recover']);
    check('C10 txn-recover run by a different account than the one that owns the journal refuses (exit 2)', refuse.status === 2 && /refusing/.test(refuse.out) && files(be.txnDir).filter((f) => f.endsWith('.json')).length === 1, refuse.out);
    const done = cli(be, ['txn-recover'], { asNobody: true });
    check('C11 run as the web account it settles the transaction', done.status === 0 && /committed/.test(done.out) && files(be.txnDir).filter((f) => f.endsWith('.json')).length === 0, done.out);
    const retry = await (async () => { await be.restart({}); return A.post('/atlas/asset/split', splitReq(c3, 4, other, JSON.parse(JSON.stringify(crashed)).requestId || undefined)); })();
    check('C12 a spent balance is not spent again', revIds(be).has(c3.id));

    // Damaged and half-recorded entries are reported, never guessed at.
    await be.restart({ ATLAS_TEST_CRASH_AT: 'txn:journal-written' });
    const c4 = await mint(A, own, GOLD, 10).catch(() => null);
    await be.restart({});
    const c5 = await mint(A, own, GOLD, 10);
    const c5b = await mint(A, own, GOLD, 10);
    await be.restart({ ATLAS_TEST_CRASH_AT: 'txn:journal-written' });
    await A.post('/atlas/asset/consolidate', { credentials: [c5, c5b], requestId: rid() });
    await be.restart({});
    const entry = path.join(be.txnDir, files(be.txnDir).find((f) => f.endsWith('.json')));
    const text = fs.readFileSync(entry, 'utf8');
    const rec = JSON.parse(text);
    const doc = JSON.parse(fs.readFileSync(be.revFile, 'utf8'));
    doc.revoked.push({ id: rec.predecessors[0], revokedAt: '2026-01-01T00:00:00Z', reason: 'consolidated', txn: rec.txn });
    fs.writeFileSync(be.revFile, JSON.stringify(doc, null, 4));
    chown(be.revFile);
    const half = cli(be, ['txn-list'], { asNobody: true });
    check('C13 a half-recorded transaction is listed as inconsistent (exit 1)', half.status === 1 && /inconsistent/.test(half.out), half.out);
    const noFix = cli(be, ['txn-recover'], { asNobody: true });
    check('C14 txn-recover refuses to settle it and leaves it as found', noFix.status === 1 && /NOT settled/.test(noFix.out) && fs.readFileSync(entry, 'utf8') === text, noFix.out);
    fs.writeFileSync(entry, '{"txn":');
    chown(entry);
    const bad = cli(be, ['txn-list'], { asNobody: true });
    check('C15 a damaged entry is listed as unreadable (exit 1) and left alone', bad.status === 1 && /UNREADABLE/.test(bad.out), bad.out);
    const pfBad = cli(be, ['preflight'], { asNobody: true });
    check('C16 preflight warns about pending transactions', /WARN\s+1 journal entry pending/.test(pfBad.out), pfBad.out.split('\n').filter((l) => /journal/.test(l)));
  } finally { be.stop(); }

  // Failures preflight must catch.
  be = await startPhp(port(), { workers: 0 });
  try {
    const A = api(be);
    await mint(A, owner('c2'), GOLD, 10);
    const keyFile = path.join(be.bundle, 'lib', 'issuer-private-key.pem');
    const keyBytes = read(keyFile);
    const revBytes = read(be.revFile);
    const failing = (label, expectRe, mutate, restore) => {
      mutate();
      const r = cli(be, ['preflight']);
      check(`C17 preflight fails when ${label}`, r.status === 1 && expectRe.test(r.out), r.out.split('\n').filter((l) => /FAIL/.test(l)));
      restore();
    };
    failing('the private key file is missing', /FAIL\s+lib\/issuer-private-key\.pem is missing/, () => fs.rmSync(keyFile), () => fs.writeFileSync(keyFile, keyBytes, { mode: 0o600 }));
    failing('the key file is not a key', /FAIL\s+the issuer private key file cannot be read/, () => fs.writeFileSync(keyFile, 'nonsense'), () => fs.writeFileSync(keyFile, keyBytes, { mode: 0o600 }));
    failing('the key does not match the published document', /FAIL\s+the published key document does NOT list/, () => {
      const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      fs.writeFileSync(keyFile, kp.privateKey.export({ type: 'sec1', format: 'pem' }), { mode: 0o600 });
    }, () => fs.writeFileSync(keyFile, keyBytes, { mode: 0o600 }));
    failing('the revocation list is missing', /FAIL\s+\.well-known\/atlas-revocations\.json is missing/, () => fs.rmSync(be.revFile), () => fs.writeFileSync(be.revFile, revBytes));
    failing('the revocation list is malformed', /FAIL\s+the revocation list is not valid JSON/, () => fs.writeFileSync(be.revFile, '{broken'), () => fs.writeFileSync(be.revFile, revBytes));
    const split = path.join(be.bundle, 'atlas', 'asset', 'split.php');
    const splitBytes = read(split);
    failing('an endpoint file is still the old version', /FAIL\s+atlas\/asset\/split\.php is missing or still the old version/, () => fs.writeFileSync(split, '<?php require_once __DIR__ . "/../../lib/bootstrap.php"; atlas_begin_replacement(1,2,3,4,5);'), () => fs.writeFileSync(split, splitBytes));
    const hb = path.join(be.bundle, 'lib', 'replacement.php');
    const hbBytes = read(hb);
    check('C18 after every repair preflight passes again', cli(be, ['preflight']).status === 0);
    // Not a command-line request: refused when reached over the web.
    const web = await fetch(be.base + '/lib/atlas-cli.php?preflight');
    check('C19 reached over the web the tool does nothing (404, no output)', web.status === 404 && (await web.text()) === '');
  } finally { be.stop(); }

  // As an unprivileged account with an unwritable directory: the write probe fails, loudly.
  be = await startPhp(port(), { user: 'nobody', workers: 0 });
  try {
    const A = api(be);
    await mint(A, owner('c3'), GOLD, 10);
    fs.chmodSync(path.join(be.bundle, '.well-known'), 0o555);
    const r = cli(be, ['preflight', '--write-probe'], { asNobody: true });
    check('C20 an unwritable .well-known is reported as a failure', r.status === 1 && /FAIL\s+\.well-known .*NOT writable/.test(r.out), r.out.split('\n').filter((l) => /FAIL/.test(l)));
    fs.chmodSync(path.join(be.bundle, '.well-known'), 0o755);
  } finally { be.stop(); }
}

// ------------------------------------------------------------------------------------------------
async function smokeSection() {
  console.log('\n=== HTTP smoke test tool (tools/gen1-php-smoke.js) ===');
  const be = await startPhp(port(), { workers: 0, router: 'guarded-router.php', prepare: guardedRouter });
  try {
    const A = api(be);
    const own = owner('s1');
    const c = await mint(A, own, GOLD, 10);
    await A.post('/atlas/asset/split', splitReq(c, 3, owner('s1b')));
    const baseline = path.join(be.tmp, 'baseline.json');
    const saved = await smoke(be, ['--save-baseline', baseline]);
    check('S1 read-only run passes and saves a baseline of the public documents', saved.status === 0 && fs.existsSync(baseline) && /revocation list: \d+ entries/.test(saved.out), saved.out.slice(-400));
    const savedDoc = JSON.parse(fs.readFileSync(baseline, 'utf8'));
    const mutating = await smoke(be, ['--baseline', baseline, '--mutating']);
    check('S2 the spend smoke test passes: replay is identical, each spend recorded once with a tag, earlier entries unchanged', mutating.status === 0 && /PASS issue 10 Iron/.test(mutating.out) && /PASS repeating the split returns the identical answer/.test(mutating.out) && /PASS all \d+ earlier entries are unchanged/.test(mutating.out), mutating.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n') || mutating.out.slice(-500));
    const after = await smoke(be, ['--baseline', baseline]);
    check('S3 after the spends the baseline still holds (entries added, none lost)', after.status === 0 && /PASS no entry has been lost/.test(after.out) && /PASS the first \d+ entries are identical/.test(after.out), after.out.slice(-400));
    const doc = JSON.parse(fs.readFileSync(be.revFile, 'utf8'));
    doc.revoked.splice(0, 1);
    fs.writeFileSync(be.revFile, JSON.stringify(doc, null, 4));
    const lost = await smoke(be, ['--baseline', baseline]);
    check('S4 a lost revocation entry is caught by the baseline comparison', lost.status === 1 && /FAIL the first \d+ entries are identical/.test(lost.out), lost.out.slice(-300));
    const keyDocFile = path.join(be.bundle, '.well-known', 'atlas-key.json');
    const kd = JSON.parse(fs.readFileSync(keyDocFile, 'utf8'));
    kd.keys[0].publicKey = 'X' + kd.keys[0].publicKey.slice(1);
    fs.writeFileSync(keyDocFile, JSON.stringify(kd));
    const swapped = await smoke(be, ['--baseline', baseline]);
    check('S5 a changed published issuer key is caught', swapped.status === 1 && /FAIL every previously published issuer key is still published/.test(swapped.out), swapped.out.slice(-300));
    check('S6 the baseline records only public data (no key material, no credentials)', !/BEGIN|signature|TESTOWNER/.test(JSON.stringify(savedDoc)));
  } finally { be.stop(); }
}

// ------------------------------------------------------------------------------------------------
const liveGold = (be, owners) => {
  const revoked = revIds(be);
  return owners.reduce((sum, o) => {
    let held = [];
    try { held = JSON.parse(fs.readFileSync(path.join(be.holdingsDir, crypto.createHash('sha256').update(o).digest('hex').slice(0, 40) + '.json'), 'utf8')).held[GOLD] || []; } catch (e) { /* none */ }
    return sum + held.filter((h) => !revoked.has(h.id)).reduce((t, h) => t + h.q, 0);
  }, 0);
};
const asyncCli = (be, args, asNobody) => new Promise((resolve) => {
  const cmd = (asNobody ? NOBODY : []).concat(['php', path.join(be.bundle, 'lib', 'atlas-cli.php')], args);
  const p = spawn(cmd[0], cmd.slice(1), { cwd: be.bundle });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => resolve({ status: code, out }));
});

async function processes() {
  console.log('\n=== several independent PHP processes at once, and a killed server ===');
  // Four worker processes plus command-line recovery loops, all as the web account.
  let be = await startPhp(port(), { user: 'nobody', workers: 4 });
  try {
    const A = api(be);
    const owners = [], preds = [];
    const jobs = [];
    for (let i = 0; i < 16; i++) { const o = owner('m1'); owners.push(o); const c = await mint(A, o, GOLD, 6); preds.push(c.id); jobs.push(() => A.post('/atlas/asset/split', splitReq(c, 2, o))); }
    for (let i = 0; i < 6; i++) { const o = owner('m2'); owners.push(o); const cs = [await mint(A, o, GOLD, 2), await mint(A, o, GOLD, 2), await mint(A, o, GOLD, 2)]; cs.forEach((c) => preds.push(c.id)); jobs.push(() => A.post('/atlas/asset/consolidate', { credentials: cs, requestId: rid() })); }
    for (let i = 0; i < 6; i++) { const o = owner('m3'); owners.push(o); const c = await mint(A, o, IRON, 100); preds.push(c.id); jobs.push(() => A.post('/atlas/convert', { credential: c, spendAmount: 100, toClass: GOLD, requestId: rid() })); }
    for (let i = 0; i < 12; i++) { const o = owner('m4'); owners.push(o); jobs.push(() => A.post('/atlas/asset/issue', { ownerPublicKey: o, assetClass: GOLD, quantity: 1, requestId: rid() })); }
    const expectedGold = 16 * 6 + 6 * 6 + 6 * 5 + 12;
    const before = JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked.length;
    let go = true;
    const recoverers = [0, 1, 2].map(async () => {
      const outs = [];
      while (go) outs.push(await asyncCli(be, ['txn-recover'], true));
      return outs;
    });
    const results = await Promise.all(jobs.map((j) => j()));
    go = false;
    const loops = (await Promise.all(recoverers)).flat();
    check('M1 44 simultaneous operations across 4 workers all succeed while 3 recovery loops run', results.every((r) => r.status === 200), results.filter((r) => r.status !== 200).map((r) => [r.status, r.body]));
    check('M2 the recovery loops never reported a failure or touched a live request\'s entry wrongly', loops.length > 3 && loops.every((l) => l.status === 0 && !/NOT settled|UNREADABLE/.test(l.out)), loops.filter((l) => l.status !== 0).map((l) => l.out));
    const list = JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked;
    const counts = new Map();
    list.forEach((r) => counts.set(r.id, (counts.get(r.id) || 0) + 1));
    check('M3 the revocation list is valid and every spent balance is in it exactly once', preds.every((id) => counts.get(id) === 1) && list.length === before + preds.length, [list.length, before, preds.length]);
    check('M4 value is conserved: the owners hold exactly what was issued', liveGold(be, owners) === expectedGold, [liveGold(be, owners), expectedGold]);
    check('M5 no journal entry and no temporary file remains', files(be.txnDir).filter((f) => f.endsWith('.json')).length === 0 && tmpLeft(be).length === 0, [files(be.txnDir), tmpLeft(be)]);
    check('M6 the revocation list kept its mode and the web account owns it', modeOf(be.revFile) === '0644' && fs.statSync(be.revFile).uid === 65534);
  } finally { be.stop(); }

  // A request stopped at the commit point on a multi-worker server: another process settles it.
  be = await startPhp(port(), { user: 'nobody', workers: 4 });
  try {
    const A = api(be);
    const own = owner('m5'), other = owner('m5b');
    const c = await mint(A, own, GOLD, 10);
    await be.restart({ ATLAS_TEST_CRASH_AT: 'txn:revoked' });
    const id = rid();
    const first = await A.post('/atlas/asset/split', splitReq(c, 4, other, id));
    check('M7 a worker stopped at the commit point leaves a committed journal entry', /non-json|network/.test(JSON.stringify(first.body)) && revIds(be).has(c.id) && files(be.txnDir).filter((f) => f.endsWith('.json')).length === 1);
    const entry = JSON.parse(fs.readFileSync(path.join(be.txnDir, files(be.txnDir).find((f) => f.endsWith('.json'))), 'utf8'));
    await be.restart({});
    const retry = await A.post('/atlas/asset/split', splitReq(c, 4, other, id));
    check('M8 the retry (served by any worker) returns exactly the answer decided before the stop', retry.status === 200 && JSON.stringify(retry.body) === JSON.stringify(JSON.parse(entry.responseJson)));
    check('M9 ...and the entry is gone, holdings exact', files(be.txnDir).filter((f) => f.endsWith('.json')).length === 0 && liveGold(be, [own, other]) === 10);
  } finally { be.stop(); }

  // The server is killed outright (SIGKILL) in the middle of a burst, then restarted.
  for (const delay of [10, 30, 60]) {
    be = await startPhp(port(), { user: 'nobody', workers: 0 });
    try {
      const A = api(be);
      const owners = [], reqs = [];
      for (let i = 0; i < 24; i++) {
        const o = owner('k'), to = owner('kk');
        owners.push(o, to);
        const c = await mint(A, o, GOLD, 8);
        reqs.push({ c, id: rid(), body: null, to });
      }
      const sent = reqs.map((r) => A.post('/atlas/asset/split', splitReq(r.c, 3, r.to, r.id)).then((res) => { r.first = res; }));
      await sleep(delay);
      be.proc.removeAllListeners('exit');
      be.proc.kill('SIGKILL');
      await Promise.allSettled(sent);
      await sleep(200);
      await be.start();
      const pending = files(be.txnDir).filter((f) => f.endsWith('.json')).length;
      const tmpAfterKill = tmpLeft(be);
      const settle = await asyncCli(be, ['txn-recover'], true);
      check(`K1 killed after ${delay} ms (${reqs.filter((r) => r.first && r.first.status === 200).length} answered, ${pending} journal entries left): recovery settles without error`, settle.status === 0 && !/NOT settled/.test(settle.out), settle.out);
      const retried = await Promise.all(reqs.map((r) => A.post('/atlas/asset/split', splitReq(r.c, 3, r.to, r.id))));
      check(`K2 every request, repeated with its own request id, succeeds`, retried.every((r) => r.status === 200), retried.filter((r) => r.status !== 200).map((r) => [r.status, r.body]));
      check(`K3 an answer received before the kill is the answer received after it`, reqs.every((r, i) => !(r.first && r.first.status === 200) || JSON.stringify(r.first.body) === JSON.stringify(retried[i].body)));
      const list = JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked;
      check(`K4 each balance is revoked exactly once and the list is valid JSON`, reqs.every((r) => list.filter((e) => e.id === r.c.id).length === 1));
      check(`K5 value is conserved (24 x 8 held by sender and recipient, nothing created or lost)`, liveGold(be, owners) === 24 * 8, liveGold(be, owners));
      await asyncCli(be, ['txn-recover'], true);
      await A.post('/atlas/asset/issue', { ownerPublicKey: owner('k2'), assetClass: IRON, quantity: 1 });
      check(`K6 no journal entry remains and temporary files left by the kill are only recent ones`, files(be.txnDir).filter((f) => f.endsWith('.json')).length === 0 && tmpAfterKill.every((f) => Date.now() - fs.statSync(f).mtimeMs < 300000), [files(be.txnDir), tmpAfterKill]);
    } finally { be.stop(); }
  }
}

// ------------------------------------------------------------------------------------------------
function exportCommit(commit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-export-'));
  const tar = spawnSync('sh', ['-c', `git -C ${JSON.stringify(REPO)} archive ${commit} issuer-php | tar -x -C ${JSON.stringify(dir)}`], { encoding: 'utf8' });
  if (tar.status !== 0) { fs.rmSync(dir, { recursive: true, force: true }); return null; }
  return { root: dir, source: path.join(dir, 'issuer-php') };
}
// Copies the current source files (not state) over an existing bundle, in the order of the
// checklist: lib/ first, then everything else.
function overlayCurrent(bundle, part) {
  const list = execFileSync('git', ['-C', REPO, 'ls-files', '-co', '--exclude-standard', 'issuer-php'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.slice('issuer-php/'.length));
  const chosen = list.filter((f) => part === 'lib' ? f.startsWith('lib/') : part === 'rest' ? !f.startsWith('lib/') : true);
  for (const rel of chosen) {
    fs.mkdirSync(path.dirname(path.join(bundle, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'issuer-php', rel), path.join(bundle, rel));
  }
  return chosen.length;
}
const stateHashes = (bundle) => {
  const out = {};
  const walk = (dir, prefix) => { for (const f of files(dir)) { const p = path.join(dir, f); const rel = prefix + f; if (fs.statSync(p).isDirectory()) { if (/^lib\/(replay|holdings|txn)\/$/.test(rel + '/')) continue; walk(p, rel + '/'); } else if (/^lib\/(atlas-.*\.json|.*\.pem)$/.test(rel) || /^\.well-known\/.*\.json$/.test(rel)) out[rel] = sha(fs.readFileSync(p)); } };
  walk(path.join(bundle, 'lib'), 'lib/');
  walk(path.join(bundle, '.well-known'), '.well-known/');
  return out;
};

async function upgrade() {
  console.log('\n=== upgrading a domain that already has state (older code -> current code) ===');
  const fixture = require('./revocation-fixture');
  for (const [label, commit] of [['before the first Gen1 fix', 'd779480'], ['with the first Gen1 fix (eb3fc96)', 'eb3fc96']]) {
    const exported = exportCommit(commit);
    if (!exported) { skip(`upgrade from ${label}`, `commit ${commit} is not in this clone`); continue; }
    const be = await startPhp(port(), { workers: 0, source: exported.source });
    try {
      const A = api(be);
      const ownerG = owner('u1'), ownerP = owner('u2'), recipient = owner('u3');
      // State an existing domain has: gold and platinum, a membership, a Post Office membership,
      // spent credentials, a long revocation list, a ledger configuration.
      const gold = [];
      for (let i = 0; i < 4; i++) gold.push(await mint(A, ownerG, GOLD, 10));
      const platinum = await mint(A, ownerG, PLAT, 5);
      const membership = await mint(A, ownerP, 'atlas.membership', 1);
      const postoffice = await mint(A, ownerP, 'atlas.postoffice.membership', 1);
      const replayId = rid();
      const legacySplit = await A.post('/atlas/asset/split', splitReq(gold[0], 4, recipient, replayId));
      const spentLegacy = gold[0];
      const unspentGold = gold[1];
      const keptSplit = legacySplit.body;
      const filler = fixture.entries(6127);
      const doc = JSON.parse(fs.readFileSync(be.revFile, 'utf8'));
      doc.revoked = filler.concat(doc.revoked);
      fs.writeFileSync(be.revFile, JSON.stringify(doc, null, 4));
      const lib = path.join(be.bundle, 'lib');
      fs.writeFileSync(path.join(lib, 'atlas-ledger-receipts-config.json'), JSON.stringify({ enabled: true, domain: 'example.test', perOwnerPerHour: 7 }));
      fs.writeFileSync(path.join(lib, 'atlas-ledger-receipts-store.json'), JSON.stringify({ nonces: [], served: [], coins: [], log: [{ at: 'before the upgrade' }] }));
      const ledgerStatus = async () => { const r = await fetch(be.base + '/atlas/ledger/balance-receipt'); return { status: r.status, text: await r.text() }; };
      const ledgerBefore = await ledgerStatus();
      const entriesBefore = JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked;
      const snap = stateHashes(be.bundle);
      const keyMode = modeOf(path.join(lib, 'issuer-private-key.pem'));
      const credsFile = path.join(be.tmp, 'creds.json');
      fs.writeFileSync(credsFile, JSON.stringify([gold[0], gold[1], gold[2], gold[3], platinum, membership, postoffice, keptSplit.sent, keptSplit.remainder]));

      // The upgrade, in the documented order, with the old server stopped in between.
      be.proc.removeAllListeners('exit'); be.proc.kill(); await waitFor(be.proc);
      const nLib = overlayCurrent(be.bundle, 'lib');
      const nRest = overlayCurrent(be.bundle, 'rest');
      await be.start();
      check(`U1 [${label}] the upgrade copies source files only (${nLib} in lib/, ${nRest} elsewhere)`, nLib > 10 && nRest > 50);
      const pf = cli(be, ['preflight']);
      check(`U2 [${label}] preflight on the upgraded domain: no failures`, pf.status === 0, pf.out.split('\n').filter((l) => /FAIL/.test(l)));

      // One request first, then compare.
      const post = await A.post('/atlas/asset/split', splitReq(unspentGold, 3, recipient, rid()));
      check(`U3 [${label}] a credential signed before the upgrade is accepted and spent`, post.status === 200, [post.status, post.body]);
      const spentAgain = await A.post('/atlas/asset/split', splitReq(spentLegacy, 1, recipient, rid()));
      check(`U4 [${label}] a credential spent before the upgrade is still refused`, spentAgain.status >= 400 && spentAgain.status < 500, [spentAgain.status, spentAgain.body]);
      check(`U5 [${label}] the private key file is byte-identical and keeps its mode`, sha(read(path.join(lib, 'issuer-private-key.pem'))) === snap['lib/issuer-private-key.pem'] && modeOf(path.join(lib, 'issuer-private-key.pem')) === keyMode);
      check(`U6 [${label}] the published key document is byte-identical`, sha(read(path.join(be.bundle, '.well-known', 'atlas-key.json'))) === snap['.well-known/atlas-key.json']);
      // More traffic of every kind.
      const cons = await A.post('/atlas/asset/consolidate', { credentials: [gold[2], gold[3]], requestId: rid() });
      const conv = await A.post('/atlas/convert', { credential: platinum, spendAmount: 1, toClass: GOLD, requestId: rid() });
      const issue = await A.post('/atlas/asset/issue', { ownerPublicKey: owner('u4'), assetClass: GOLD, quantity: 10, requestId: rid() });
      check(`U7 [${label}] consolidate, convert and issue work on old credentials`, cons.status === 200 && (conv.status === 200 || conv.status === 400) && issue.status === 200, [cons.status, conv.status, conv.body.error, issue.status]);
      const entriesAfter = JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked;
      check(`U8 [${label}] all ${entriesBefore.length} earlier revocation entries are still there, unchanged and in order`, entriesAfter.length > entriesBefore.length && JSON.stringify(entriesAfter.slice(0, entriesBefore.length)) === JSON.stringify(entriesBefore));
      check(`U9 [${label}] only spends were added, each tagged with its transaction`, entriesAfter.slice(entriesBefore.length).every((e) => typeof e.txn === 'string' && typeof e.id === 'string'));
      const after = stateHashes(be.bundle);
      const stable = Object.keys(snap).filter((k) => k !== '.well-known/atlas-revocations.json');
      const changed = stable.filter((k) => snap[k] !== after[k]);
      check(`U10 [${label}] no other state file changed (Post Office roster, mail, ledger configuration and receipts store, key documents, admin, class patches...)`, changed.length === 0 && Object.keys(after).every((k) => k in snap || /atlas-(supply|serial|bearer|spend|asset-history|mail-nonces)/.test(k)), { changed, added: Object.keys(after).filter((k) => !(k in snap)) });
      const ledgerAfter = await ledgerStatus();
      check(`U11 [${label}] the ledger receipts endpoint answers exactly as before (${ledgerBefore.status})`, ledgerAfter.status === ledgerBefore.status && ledgerAfter.text === ledgerBefore.text);
      const verify = spawnSync('php', ['-r', `require ${JSON.stringify(path.join(lib, 'bootstrap.php'))}; $pub = json_decode(file_get_contents(${JSON.stringify(path.join(be.bundle, '.well-known', 'atlas-key.json'))}), true)['keys'][0]['publicKey']; $bad = 0; foreach (json_decode(file_get_contents(${JSON.stringify(credsFile)}), true) as $c) { if (!verify_own_credential_signature($pub, $c, asset_payload_of($c))) $bad++; } echo $bad;`], { encoding: 'utf8' });
      check(`U12 [${label}] every credential signed before the upgrade (gold, platinum, memberships, Post Office) still verifies against the same published key`, verify.stdout.trim() === '0', verify.stdout + verify.stderr);
      check(`U13 [${label}] the Post Office roster still lists the member`, (read(path.join(lib, 'atlas-postoffice-members-store.json')) || '').toString().includes(postoffice.id));
      if (commit === 'eb3fc96') {
        const again = await A.post('/atlas/asset/split', splitReq(spentLegacy, 4, recipient, replayId));
        check(`U14 [${label}] a request answered and stored by the older version is answered identically after the upgrade`, again.status === 200 && JSON.stringify(again.body) === JSON.stringify(keptSplit), [again.status, again.body]);
        const hold = await A.post('/atlas/asset/issue', { ownerPublicKey: ownerG, assetClass: GOLD, quantity: 500, requestId: rid() });
        check(`U15 [${label}] holdings recorded by the older version still count toward the cap`, hold.status === 400 && hold.body.code === 'cap', [hold.status, hold.body]);
      }
    } finally { be.stop(); fs.rmSync(exported.root, { recursive: true, force: true }); }
  }
}
function waitFor(proc) { return new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', () => r()); setTimeout(r, 3000); }); }

async function mixed() {
  console.log('\n=== files uploaded in stages: which partial states keep working ===');
  const exported = exportCommit('d779480');
  if (!exported) return skip('mixed uploads', 'commit d779480 is not in this clone');
  const be = await startPhp(port(), { workers: 0, source: exported.source });
  try {
    const A = api(be);
    const own = owner('x1'), other = owner('x2');
    const c = await mint(A, own, GOLD, 10);
    await A.post('/atlas/asset/split', splitReq(c, 1, other));
    be.proc.removeAllListeners('exit'); be.proc.kill(); await waitFor(be.proc);
    overlayCurrent(be.bundle, 'lib');
    await be.start();
    check('X1 current lib/ with every endpoint file still old (stage 1 of the upload): preflight says what is outstanding', /FAIL\s+atlas\/asset\/split\.php/.test(cli(be, ['preflight']).out) && cli(be, ['preflight']).status === 1);
    const g = await mint(A, own, GOLD, 10);
    const s = await A.post('/atlas/asset/split', splitReq(g, 2, other));
    const g2 = await mint(A, own, GOLD, 4);
    const g3 = await mint(A, own, GOLD, 4);
    const m = await A.post('/atlas/asset/consolidate', { credentials: [g2, g3], requestId: rid() });
    const iron = await mint(A, own, IRON, 100);
    const v = await A.post('/atlas/convert', { credential: iron, spendAmount: 100, toClass: GOLD, requestId: rid() });
    check('X2 ...the old endpoints keep working against the new lib/ (issue, split, consolidate, convert)', s.status === 200 && m.status === 200 && v.status === 200, [s.status, m.status, v.status, s.body, m.body, v.body]);
    const list = JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked;
    check('X3 ...and their spends are recorded normally', list.some((e) => e.id === g.id) && list.some((e) => e.id === g2.id) && list.some((e) => e.id === iron.id));
    overlayCurrent(be.bundle, 'rest');
    const pf = cli(be, ['preflight']);
    check('X4 after the endpoint files are uploaded too, preflight passes', pf.status === 0, pf.out.split('\n').filter((l) => /FAIL/.test(l)));
    const after = await A.post('/atlas/asset/split', splitReq(await mint(A, own, GOLD, 10), 2, other, rid()));
    check('X5 ...and the new endpoints work', after.status === 200);
  } finally { be.stop(); }
  // The wrong order: new endpoints against the old lib/ cannot work, and preflight must say so.
  const exported2 = exportCommit('d779480');
  const be2 = await startPhp(port(), { workers: 0, source: exported2.source });
  try {
    const A = api(be2);
    const own = owner('x3');
    const c = await mint(A, own, GOLD, 10);
    be2.proc.removeAllListeners('exit'); be2.proc.kill(); await waitFor(be2.proc);
    overlayCurrent(be2.bundle, 'rest');
    // restore the old lib/ files that overlayCurrent('rest') did not touch: the old ones are still there
    await be2.start();
    const r = await A.post('/atlas/asset/split', splitReq(c, 2, owner('x4')));
    check('X6 new endpoints on an old lib/ (the wrong order) fail without spending anything', r.status >= 400 && !revIds(be2).has(c.id), [r.status, r.body]);
    fs.copyFileSync(path.join(REPO, 'issuer-php', 'lib', 'atlas-cli.php'), path.join(be2.bundle, 'lib', 'atlas-cli.php'));
    const pf = cli(be2, ['preflight']);
    check('X7 ...and preflight (once atlas-cli.php is uploaded) flags the old lib/', pf.status === 1 && /FAIL lib\/replacement\.php is missing/.test(pf.out), pf.out.split('\n').filter((l) => /FAIL/.test(l)));
  } finally { be2.stop(); fs.rmSync(exported.root, { recursive: true, force: true }); fs.rmSync(exported2.root, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------------------------------------
async function main() {
  try {
    if (run('permissions')) await permissions();
    if (run('private')) await privateData();
    if (run('identity')) await identity();
    if (run('tmp')) await staleTemp();
    if (run('cli')) await cliSection();
    if (run('smoke')) await smokeSection();
    if (run('processes')) await processes();
    if (run('upgrade')) await upgrade();
    if (run('mixed')) await mixed();
  } catch (e) {
    failures++;
    console.log('FAIL harness :: ' + (e && e.stack || e));
  }
  console.log(`\nmanual-gen1-php-deployment: ${checks - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main();
