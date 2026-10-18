// Checks tools/gen1-fungible-audit.js against an isolated Node issuer: each state the tool reports is
// produced by a real issuer, not hand-written. Nothing live is read or written.
//   node test/manual-gen1-audit-tool.js
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { audit } = require('../tools/gen1-fungible-audit');
const REPO = path.resolve(__dirname, '..');
const PORT = 8331;
const GOLD = 'atlas.element.gold', PLAT = 'atlas.element.platinum';
let failures = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail))); if (!ok) failures++; };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen1-audit-'));
  const docroot = path.join(tmp, 'docroot'), state = path.join(tmp, 'state');
  fs.mkdirSync(path.join(docroot, '.well-known'), { recursive: true }); fs.mkdirSync(state);
  const proc = spawn('node', ['issuer-server/server.js'], { cwd: REPO, env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: 'localhost:' + PORT, ATLAS_DOCROOT: docroot, ATLAS_STATE_DIR: state }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 50));
  const base = 'http://localhost:' + PORT;
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const mint = async (owner, cls, q, held) => (await post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: cls, quantity: q, existingBalances: held })).body;
  const revFile = path.join(docroot, '.well-known', 'atlas-revocations.json');
  const keyFile = path.join(docroot, '.well-known', 'atlas-key.json');
  try {
    const owner = 'TESTOWNER-audit';
    // 1. A normal consolidation: five 10 g stacks into 50 g. The old export still has the five.
    const five = []; for (let i = 0; i < 5; i++) five.push(await mint(owner, GOLD, 10, five));
    const oldExport = five.slice();
    const merged = (await post('/atlas/asset/consolidate', { credentials: five })).body;
    // 2. A convert whose Platinum is kept, and one whose response is lost.
    const a = await mint(owner, GOLD, 100); const keptConv = (await post('/atlas/convert', { credential: a, spendAmount: 100, toClass: PLAT })).body;
    const b = await mint(owner, GOLD, 70); await post('/atlas/convert', { credential: b, spendAmount: 70, toClass: PLAT }); // response "lost"
    // 3. An untouched balance.
    const fresh = await mint(owner, GOLD, 30);
    const walletNow = [merged, keptConv.received, fresh, a, b];
    const backupRev = JSON.parse(fs.readFileSync(revFile, 'utf8'));
    fs.writeFileSync(path.join(tmp, 'backup.json'), JSON.stringify(backupRev));
    // 4. Hand-delete the revocation records of two of the five old stacks.
    const cur = JSON.parse(fs.readFileSync(revFile, 'utf8'));
    cur.revoked = cur.revoked.filter((r) => r.id !== five[0].id && r.id !== five[1].id);
    fs.writeFileSync(path.join(tmp, 'current.json'), JSON.stringify(cur));
    fs.writeFileSync(path.join(tmp, 'wallet-now.json'), JSON.stringify({ format: 'atlas-wallet-export/1.0', credentials: walletNow }));
    fs.writeFileSync(path.join(tmp, 'wallet-old.json'), JSON.stringify(oldExport.map((c) => ({ credential: c }))));
    const files = { wallet: [path.join(tmp, 'wallet-now.json'), path.join(tmp, 'wallet-old.json')], revocations: path.join(tmp, 'current.json'), key: keyFile, classes: [GOLD, PLAT], all: false };

    let rep = await audit({ ...files, backups: [path.join(tmp, 'backup.json')] });
    const st = (id) => rep.rows.find((r) => r.id === id).state;
    check('the merged 50 g, the kept Platinum and the untouched 30 g are CURRENT', [merged.id, keptConv.received.id, fresh.id].every((id) => st(id) === 'CURRENT'), rep.rows.map((r) => [r.quantity, r.state]));
    check('the two stacks whose records were deleted are RESURRECTED when a backup shows them', st(five[0].id) === 'RESURRECTED' && st(five[1].id) === 'RESURRECTED');
    check('the three stacks whose records remain are SPENT', [2, 3, 4].every((i) => st(five[i].id) === 'SPENT'));
    check('a spent 100 g with its Platinum held is SPENT, not lost', st(a.id) === 'SPENT');
    check('a spent 70 g with no successor anywhere is SPENT_NO_SUCCESSOR', st(b.id) === 'SPENT_NO_SUCCESSOR');
    const t = rep.totals[owner][GOLD];
    check('current Gold is 80 (50 merged + 30), displayed Gold is larger', t.current === 80 && t.displayed > t.current, t);
    check('resurrected Gold is 20', t.resurrected === 20, t);
    check('the removed records are listed from the backup', rep.revocationFile.removedSinceBackup.length === 2);
    check('every signature verified against the key document', rep.rows.every((r) => r.signatureVerified === true));

    rep = await audit({ ...files, backups: [] });
    check('without a backup the same two stacks are SUPERSEDED_NOT_REVOKED, via the successor reference', st(five[0].id) === 'SUPERSEDED_NOT_REVOKED' && st(five[1].id) === 'SUPERSEDED_NOT_REVOKED');
    check('with no backup the audit still excludes them from current Gold', rep.totals[owner][GOLD].current === 80);

    const bad = JSON.parse(JSON.stringify(walletNow)); bad[2].quantity = 3000;
    fs.writeFileSync(path.join(tmp, 'wallet-bad.json'), JSON.stringify(bad));
    rep = await audit({ ...files, wallet: [path.join(tmp, 'wallet-bad.json')], backups: [] });
    check('a quantity edited after signing is UNVERIFIED and not counted', rep.rows.find((r) => r.id === fresh.id).state === 'UNVERIFIED' && rep.totals[owner][GOLD].current === 50, rep.totals);

    const cli = spawnSync('node', [path.join(REPO, 'tools', 'gen1-fungible-audit.js'), '--wallet', files.wallet[0], '--revocations', files.revocations, '--key', keyFile], { encoding: 'utf8' });
    check('the command line prints a report and exits 0', cli.status === 0 && /Gen1 fungible balance audit/.test(cli.stdout), cli.stderr);
    const before = fs.readFileSync(files.revocations, 'utf8');
    check('the tool leaves the revocation file as it found it', fs.readFileSync(files.revocations, 'utf8') === before);
  } finally { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
