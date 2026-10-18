// Wallet-side reproduction for the Gen1 fungible balance incident: what happens to the stored
// wallet when two balance-changing operations overlap. Uses the real extension in Chromium and an
// isolated Node issuer on a private port with a throw-away key, state and revocation list.
//
// mintAsset(), mergeAssetGroup(), convertAsset() and splitAsset() in extension/wallet.js read the
// wallet, wait on the issuer, then write back what they read, without withWalletLock(). This
// records what that does to the stored wallet, and to the issuer's view of it.
//
// Run: xvfb-run -a node test/manual-gen1-wallet-races.js [trials]
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./call-e2e-lib');
const REPO = path.resolve(__dirname, '..');
const PORT = 8321;
const DOMAIN = 'localhost:' + PORT;
const GOLD = 'atlas.element.gold';
const PLAT = 'atlas.element.platinum';
const TRIALS = parseInt(process.argv[2] || '3', 10);
const out = [];
const note = (id, text, value) => { out.push({ id, text, value }); console.log(`FINDING ${id}: ${text} => ${JSON.stringify(value)}`); };

async function startIssuer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen1-race-'));
  const docroot = path.join(tmp, 'docroot'), state = path.join(tmp, 'state');
  fs.mkdirSync(path.join(docroot, '.well-known'), { recursive: true }); fs.mkdirSync(state);
  const proc = spawn('node', ['issuer-server/server.js'], { cwd: REPO, env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_DOCROOT: docroot, ATLAS_STATE_DIR: state }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 50));
  if (!log.includes('listening')) throw new Error('issuer did not start: ' + log.slice(-300));
  return {
    revFile: path.join(docroot, '.well-known', 'atlas-revocations.json'),
    revoked: () => new Set(JSON.parse(fs.readFileSync(path.join(docroot, '.well-known', 'atlas-revocations.json'), 'utf8')).revoked.map((r) => r.id)),
    stop: () => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}

// What the issuer says about everything the wallet holds.
async function audit(iss, W, pub) {
  const wallet = await W((k) => AtlasWallet.getWallet(k), pub);
  const rev = iss.revoked();
  const gold = wallet.filter((e) => e.credential.asset.class === GOLD);
  return {
    entries: wallet.length,
    goldStacks: gold.length,
    goldDisplayed: gold.reduce((s, e) => s + e.credential.quantity, 0),
    goldValid: gold.filter((e) => !rev.has(e.credential.id)).reduce((s, e) => s + e.credential.quantity, 0),
    revokedHeld: wallet.filter((e) => rev.has(e.credential.id)).length
  };
}

async function trial(iss, n, how) {
  const w = await L.launchWallet('gen1race' + n);
  const W = w.wallet;
  try {
    const pub = (await W((pw) => AtlasWallet.createIdentity(pw), 'gen1-race-test-password')).publicKey;
    const mint = (q, cls) => W((a) => AtlasWallet.mintAsset('self', a.d, a.c, a.q).then(() => 'ok', (e) => 'ERR ' + e.message), { d: DOMAIN, c: cls || GOLD, q });
    // Baseline: five sequential mints.
    for (let i = 0; i < 5; i++) await mint(10);
    const base = await audit(iss, W, pub);
    // Overlap, three rounds in a row in the same wallet.
    const rounds = [];
    let expectedGold = base.goldDisplayed;
    for (let round = 0; round < 3; round++) {
      let results;
      if (how === 'mints') results = await Promise.all([0, 1, 2, 3].map(() => mint(10)));
      else {
        const stack = (await W((k) => AtlasWallet.getWallet(k), pub)).map((e) => e.credential).filter((c) => c.asset.class === GOLD).sort((a, b) => b.quantity - a.quantity)[0];
        results = await Promise.all([
          mint(10),
          W((a) => AtlasWallet.convertAsset('self', a.c, 20, a.t).then(() => 'ok', (e) => 'ERR ' + e.message), { c: stack, t: PLAT }),
          mint(10)
        ]);
        if (results[1] === 'ok') expectedGold -= 20;
      }
      expectedGold += 10 * results.filter((r, i) => r === 'ok' && (how === 'mints' || i !== 1)).length;
      const a = await audit(iss, W, pub);
      rounds.push({ results: results.map((r) => (r === 'ok' ? 'ok' : r.slice(0, 90))), audit: a, expectedGold, goldLostFromWallet: expectedGold - a.goldDisplayed });
    }
    // Five sequential mints afterwards: does the wallet recover?
    const more = [];
    for (let i = 0; i < 5; i++) more.push(await mint(10));
    const later = await audit(iss, W, pub);
    return { how, base, rounds, later, expectedGoldAfterMore: expectedGold + 10 * more.filter((m) => m === 'ok').length, moreRefused: more.filter((m) => m !== 'ok').map((m) => m.slice(0, 80)) };
  } finally { await w.close(); }
}

(async () => {
  const iss = await startIssuer();
  try {
    const summary = [];
    for (const how of ['mints', 'mint+convert']) {
      for (let n = 0; n < TRIALS; n++) {
        const r = await trial(iss, how + n, how);
        summary.push(r);
        console.log(`--- ${how} trial ${n + 1}: before ${JSON.stringify(r.base)}`);
        r.rounds.forEach((x, i) => console.log(`  round ${i + 1}: ${JSON.stringify(x.results)} -> ${JSON.stringify(x.audit)} expectedGold=${x.expectedGold} lostFromWallet=${x.goldLostFromWallet}`));
        console.log(`  after 5 sequential mints: ${JSON.stringify(r.later)} expectedGold=${r.expectedGoldAfterMore}${r.moreRefused.length ? ' refusals=' + JSON.stringify(r.moreRefused) : ''}`);
      }
    }
    const last = (s) => s.rounds[s.rounds.length - 1];
    note('W1', 'trials where overlapping operations left a spent (revoked) credential in the wallet', summary.filter((s) => s.rounds.some((r) => r.audit.revokedHeld > 0)).length + ' of ' + summary.length);
    note('W2', 'trials where valid, issuer-signed Gold was missing from the wallet after overlapping operations', summary.filter((s) => last(s).goldLostFromWallet > 0).length + ' of ' + summary.length);
    note('W2', 'Gold (g) missing per trial', summary.map((s) => [s.how, last(s).goldLostFromWallet]));
    note('W3', 'trials still short after five further sequential mints (no self-repair)', summary.filter((s) => s.expectedGoldAfterMore - s.later.goldDisplayed > 0).length + ' of ' + summary.length);
    fs.writeFileSync(process.env.GEN1_RESULTS || path.join(os.tmpdir(), 'gen1-wallet-races.json'), JSON.stringify({ out, summary }, null, 2));
  } finally { iss.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
