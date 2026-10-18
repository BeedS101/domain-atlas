// Isolated reproduction harness for the Gen1 portable fungible balance incident
// (Gold / Platinum): holding cap, automatic consolidation, conversion, deleted
// revocation entries, concurrency and revocation-list scale.
//
// Everything runs against throw-away copies of the Node and PHP issuers, each with
// its own temporary state directory, key and revocation list, on private ports.
// No live data, keys or domains are touched. Wallet behaviour is modelled by
// SimWallet, a line-for-line mirror of the HTTP calls and local bookkeeping of
// extension/wallet.js mintAsset(), mergeAssetGroup(), autoConsolidateAssetWallet()
// and convertAsset().
//
// The script records what the issuers actually do; it does not assert that the
// behaviour is correct. Each check prints "FINDING <id>: <observed>" and the run
// ends with a table. A fix should flip the observed value, not break the script.
//
//   node test/manual-gen1-fungible-incident.js [node|php|both] [--quick]
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fixture = require('./revocation-fixture');

const REPO = path.resolve(__dirname, '..');
const WHICH = process.argv.find((a) => ['node', 'php', 'both'].includes(a)) || 'both';
const QUICK = process.argv.includes('--quick');
const GOLD = 'atlas.element.gold';
const PLAT = 'atlas.element.platinum';
const IRON = 'atlas.element.iron';

const findings = [];
function finding(backend, id, text, value) {
  findings.push({ backend, id, text, value });
  console.log(`FINDING [${backend}] ${id}: ${text} => ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let keyCounter = 0;
const newOwner = (label) => 'TESTOWNER-' + label + '-' + (++keyCounter) + '-' + Math.random().toString(36).slice(2, 10);

// ---------- issuer backends ----------
async function startNode(port) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen1-node-'));
  const docroot = path.join(tmp, 'docroot');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(path.join(docroot, '.well-known'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const domain = 'localhost:' + port;
  const proc = spawn('node', ['issuer-server/server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), ATLAS_DOMAIN: domain, ATLAS_DOCROOT: docroot, ATLAS_STATE_DIR: state },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  proc.stdout.on('data', (d) => log.push(d.toString()));
  proc.stderr.on('data', (d) => log.push(d.toString()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('node issuer did not start')), 15000);
    const check = () => { if (log.join('').includes('listening')) { clearTimeout(timer); resolve(); } else setTimeout(check, 50); };
    check();
    proc.on('exit', (c) => reject(new Error('node issuer exited ' + c + ': ' + log.join('').slice(-500))));
  });
  return {
    kind: 'node', base: 'http://localhost:' + port, domain, log,
    revFile: path.join(docroot, '.well-known', 'atlas-revocations.json'),
    revLayout: (doc) => JSON.stringify(doc, null, 2),
    stop: () => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}

async function startPhp(port) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen1-php-'));
  const bundle = path.join(tmp, 'bundle');
  fs.cpSync(path.join(REPO, 'issuer-php'), bundle, { recursive: true });
  for (const f of fs.readdirSync(path.join(bundle, 'lib'))) {
    if (/\.(json|pem|lock)$/.test(f) && /store|key|lock|admin|revoc/.test(f)) fs.rmSync(path.join(bundle, 'lib', f), { force: true });
  }
  fs.mkdirSync(path.join(bundle, '.well-known'), { recursive: true });
  const domain = 'localhost:' + port;
  const proc = spawn('php', ['-S', '127.0.0.1:' + port, 'test-router.php'], {
    cwd: bundle, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' }
  });
  const log = [];
  proc.stderr.on('data', (d) => log.push(d.toString()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php did not start')), 8000);
    const check = () => { if (log.join('').includes('started')) { clearTimeout(timer); resolve(); } else setTimeout(check, 50); };
    check();
    proc.on('exit', (c) => reject(new Error('php exited ' + c)));
  });
  return {
    kind: 'php', base: 'http://127.0.0.1:' + port, domain: '127.0.0.1:' + port, log,
    revFile: path.join(bundle, '.well-known', 'atlas-revocations.json'),
    revLayout: (doc) => JSON.stringify(doc, null, 4),
    stop: () => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}

// ---------- HTTP ----------
function api(be) {
  const call = async (method, p, body) => {
    const t0 = process.hrtime.bigint();
    let res;
    try {
      res = await fetch(be.base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { return { status: 0, body: { error: 'network: ' + e.message }, ms: 0, bytes: 0 }; }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (e) { json = { error: 'non-json: ' + text.slice(0, 120) }; }
    return { status: res.status, body: json, ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: text.length };
  };
  return {
    post: (p, b) => call('POST', p, b),
    get: (p) => call('GET', p),
    revocations: () => {
      try { return JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked; } catch (e) { return null; }
    }
  };
}

// ---------- wallet model (mirrors extension/wallet.js) ----------
class SimWallet {
  constructor(be, label, opts) {
    this.be = be; this.api = api(be); this.owner = newOwner(label); this.label = label;
    this.creds = []; this.opts = opts || {}; this.mergeErrors = []; this.mints = 0; this.refused = [];
  }
  held(cls) { return this.creds.filter((c) => c.asset.class === cls).reduce((s, c) => s + c.quantity, 0); }
  stacks(cls) { return this.creds.filter((c) => c.asset.class === cls).length; }
  // wallet.js mintAsset(): present every same-class credential from this issuer.
  async mint(cls, qty, { present = true } = {}) {
    const existing = present ? this.creds.filter((c) => c.asset.class === cls && c.issuer.domain === this.be.domain) : [];
    const r = await this.api.post('/atlas/asset/issue', {
      ownerPublicKey: this.owner, assetClass: cls, quantity: qty,
      ...(existing.length ? { existingBalances: existing } : {})
    });
    if (r.status !== 200) { this.refused.push(r.body.error); return { ok: false, error: r.body.error, ms: r.ms }; }
    this.creds.push(r.body); this.mints++;
    await this.autoConsolidate();
    return { ok: true, ms: r.ms, credential: r.body };
  }
  // wallet.js mergeAssetGroup(): the whole group in one request.
  async merge(group) {
    const r = await this.api.post('/atlas/asset/consolidate', { credentials: group });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.body.error}`);
    const ids = new Set(group.map((c) => c.id));
    this.creds = this.creds.filter((c) => !ids.has(c.id));
    this.creds.push(r.body);
    return r.body;
  }
  // wallet.js autoConsolidateAssetWallet(): group by class+issuer, swallow errors.
  async autoConsolidate() {
    const groups = new Map();
    for (const c of this.creds) {
      if (!c.asset.fungible) continue;
      const k = c.asset.class + '::' + c.issuer.domain;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    for (const g of groups.values()) {
      if (g.length > 1) {
        try { await (this.opts.chunked ? this.mergeChunked(g) : this.merge(g)); } catch (e) { this.mergeErrors.push(e.message); }
      }
    }
  }
  async mergeChunked(g) {
    for (let i = 0; i < g.length; i += 20) { const part = g.slice(i, i + 20); if (part.length > 1) await this.merge(part); }
  }
  // wallet.js convertAsset()
  async convert(cred, spend, toClass) {
    const r = await this.api.post('/atlas/convert', { credential: cred, spendAmount: spend, toClass });
    if (r.status !== 200) return { ok: false, error: r.body.error };
    this.creds = this.creds.filter((c) => c.id !== cred.id);
    if (r.body.remainder) this.creds.push(r.body.remainder);
    this.creds.push(r.body.received);
    await this.autoConsolidate();
    return { ok: true, received: r.body.received, remainder: r.body.remainder };
  }
  // wallet.js mintAsset() when the HTTP response is lost on the way back.
  async mintLostResponse(cls, qty) {
    const existing = this.creds.filter((c) => c.asset.class === cls);
    await this.api.post('/atlas/asset/issue', { ownerPublicKey: this.owner, assetClass: cls, quantity: qty, ...(existing.length ? { existingBalances: existing } : {}) });
  }
}

const revokedIds = (a) => new Set((a.revocations() || []).map((r) => r.id));
function validity(a, creds) {
  const rev = revokedIds(a);
  return creds.map((c) => ({ id: c.id, qty: c.quantity, cls: c.asset.class, revoked: rev.has(c.id) }));
}
const sumValid = (a, creds, cls) => validity(a, creds).filter((v) => !v.revoked && (!cls || v.cls === cls)).reduce((s, v) => s + v.qty, 0);

// ---------- scenarios ----------
async function s1_cap(be) {
  const A = api(be);
  // 1a. Honest wallet, 10 g clicks until refused.
  const w = new SimWallet(be, 'honest');
  const revBefore = (A.revocations() || []).length;
  let clicks = 0, last;
  for (; clicks < 80; clicks++) { last = await w.mint(GOLD, 10); if (!last.ok) break; }
  const revAfter = (A.revocations() || []).length;
  finding(be.kind, 'S1a', 'honest wallet mining 10 g until refused: clicks accepted / held / stacks / mergeErrors', { clicks, held: w.held(GOLD), stacks: w.stacks(GOLD), mergeErrors: w.mergeErrors.length, refusal: (last.error || '').slice(0, 60) });
  finding(be.kind, 'S1a', 'revocation entries added by mining 500 g in 10 g clicks (with auto-consolidate)', revAfter - revBefore);

  // 1b. Wallet that presents nothing.
  const w2 = new SimWallet(be, 'nopresent');
  let ok2 = 0;
  for (let i = 0; i < 70; i++) { const r = await w2.mint(GOLD, 10, { present: false }); if (r.ok) ok2++; }
  finding(be.kind, 'S1b', 'mints accepted when the wallet presents no existingBalances (70 attempts of 10 g)', { accepted: ok2, held: w2.held(GOLD) });

  // 1c. Presenting only a revoked 500 stack.
  const w3 = new SimWallet(be, 'revokedstack');
  for (let i = 0; i < 50; i++) await w3.mint(GOLD, 10);
  const stale = w3.creds.slice();
  const w3b = new SimWallet(be, 'x'); w3b.owner = w3.owner;
  await w3.api.post('/atlas/convert', { credential: stale[0], spendAmount: stale[0].quantity, toClass: IRON }); // spends it
  const r = await w3.api.post('/atlas/asset/issue', { ownerPublicKey: w3.owner, assetClass: GOLD, quantity: 10, existingBalances: stale });
  finding(be.kind, 'S1c', 'mint while presenting only a spent (revoked) 500 g stack', { status: r.status, error: r.body.error || null });

  // 1d. Boundary overshoot and large quantities.
  const w4 = new SimWallet(be, 'boundary');
  await w4.mint(GOLD, 499);
  const o1 = await w4.mint(GOLD, 400);
  finding(be.kind, 'S1d', 'held 499 then mint 400 (quantity not checked against cap): accepted / held', { accepted: o1.ok, held: w4.held(GOLD) });
  const w5 = new SimWallet(be, 'bigmint');
  const o2 = await w5.mint(GOLD, 100000);
  finding(be.kind, 'S1d', 'single mint of 100000 with nothing held', { accepted: o2.ok, held: w5.held(GOLD) });

  // 1e. Two concurrent mints from the same snapshot.
  const w6 = new SimWallet(be, 'concurrent');
  for (let i = 0; i < 49; i++) await w6.mint(GOLD, 10);
  const snap = w6.creds.slice();
  const owner = w6.owner;
  const results = await Promise.all([0, 1, 2, 3].map(() => w6.api.post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: GOLD, quantity: 10, existingBalances: snap })));
  const accepted = results.filter((x) => x.status === 200);
  finding(be.kind, 'S1e', 'four concurrent 10 g mints from the same 490 g snapshot: accepted', { accepted: accepted.length, statuses: results.map((x) => x.status) });
  return w;
}

async function s2_consolidate_limits(be) {
  // 25 separate 10 g stacks (no auto-consolidation: e.g. some earlier failure).
  const w = new SimWallet(be, 'limit');
  for (let i = 0; i < 25; i++) {
    const r = await w.api.post('/atlas/asset/issue', { ownerPublicKey: w.owner, assetClass: GOLD, quantity: 10, existingBalances: w.creds });
    w.creds.push(r.body);
  }
  const r25 = await w.api.post('/atlas/asset/consolidate', { credentials: w.creds });
  finding(be.kind, 'S2a', 'consolidate 25 balances in one request', { status: r25.status, error: r25.body.error || null });
  // The wallet's automatic path with 25 stacks, five attempts.
  for (let i = 0; i < 5; i++) await w.autoConsolidate();
  finding(be.kind, 'S2b', 'wallet autoConsolidate with 25 stacks, 5 attempts: stacks left / distinct swallowed errors', { stacks: w.stacks(GOLD), errors: [...new Set(w.mergeErrors)] });
  // Does one more 10 g click make it better or worse?
  await w.mint(GOLD, 10);
  finding(be.kind, 'S2b', 'after another mint', { stacks: w.stacks(GOLD), held: w.held(GOLD) });
  // Chunked consolidation works.
  const wc = new SimWallet(be, 'chunk', { chunked: true });
  wc.creds = w.creds.slice();
  wc.owner = w.owner;
  await wc.autoConsolidate();
  finding(be.kind, 'S2c', 'same wallet with 20-at-a-time chunking: stacks left / mergeErrors', { stacks: wc.stacks(GOLD), held: wc.held(GOLD), errors: [...new Set(wc.mergeErrors)] });
  return w;
}

async function s3_poison(be) {
  // A wallet that holds a predecessor the issuer already revoked, next to valid stacks.
  const w = new SimWallet(be, 'poison');
  for (let i = 0; i < 4; i++) {
    const r = await w.api.post('/atlas/asset/issue', { ownerPublicKey: w.owner, assetClass: GOLD, quantity: 10, existingBalances: w.creds });
    w.creds.push(r.body);
  }
  const doomed = w.creds[0];
  const m = await w.api.post('/atlas/asset/consolidate', { credentials: [doomed, w.creds[1]] }); // issuer revokes both
  // The response is "lost": the wallet keeps its pre-merge copies and gains nothing.
  finding(be.kind, 'S3a', 'consolidate whose response is lost: issuer status / wallet still holds revoked predecessors', { status: m.status, walletStillHolds: w.creds.length, revokedHeld: validity(api(be), w.creds).filter((v) => v.revoked).length });
  const before = w.stacks(GOLD);
  for (let i = 0; i < 3; i++) await w.autoConsolidate();
  finding(be.kind, 'S3b', 'autoConsolidate with 2 revoked + 2 valid stacks, 3 attempts: stacks before->after / error', { before, after: w.stacks(GOLD), errors: [...new Set(w.mergeErrors)] });
  const valid = w.creds.filter((c) => !revokedIds(api(be)).has(c.id));
  const ok = await w.api.post('/atlas/asset/consolidate', { credentials: valid });
  finding(be.kind, 'S3c', 'consolidating only the valid stacks of the same group', { status: ok.status });
  // New mints keep landing in the poisoned group.
  const w2 = new SimWallet(be, 'poison2');
  w2.creds = [doomed, w.creds[1]].map((c) => c);
  w2.owner = w.owner;
  await w2.mint(GOLD, 10); await w2.mint(GOLD, 10);
  finding(be.kind, 'S3d', 'two more 10 g clicks in the poisoned group: stacks / swallowed', { stacks: w2.stacks(GOLD), errors: [...new Set(w2.mergeErrors)] });
  const recorded = w2.refused;
  finding(be.kind, 'S3e', 'cap view of the poisoned group (valid only counts toward cap): held displayed vs counted by issuer', { displayed: w2.held(GOLD), counted: sumValid(api(be), w2.creds, GOLD) });
}

async function s4_convert(be) {
  const w = new SimWallet(be, 'convert');
  for (let i = 0; i < 50; i++) await w.mint(GOLD, 10);
  const gold = w.creds.find((c) => c.asset.class === GOLD);
  const r = await w.convert(gold, 500, PLAT);
  finding(be.kind, 'S4a', 'convert 500 Gold -> Platinum: ok / platinum received', { ok: r.ok, platinum: r.ok ? r.received.quantity : null, cap: 500, catalogRate: 'gold 1 : platinum 2.43' });
  const m = await w.mint(PLAT, 10);
  finding(be.kind, 'S4b', 'mint Platinum while holding converted Platinum above its cap', { accepted: m.ok, error: m.error || null });
  // Repeated cycle: mine to the cap, convert everything, repeat.
  let cycles = QUICK ? 2 : 4;
  const cycleStats = [];
  for (let c = 0; c < cycles; c++) {
    let clicks = 0;
    while ((await w.mint(GOLD, 10)).ok) clicks++;
    const g = w.creds.filter((x) => x.asset.class === GOLD);
    for (const cr of g) await w.convert(cr, cr.quantity, PLAT);
    cycleStats.push({ cycle: c + 1, goldClicks: clicks, platinum: w.held(PLAT), gold: w.held(GOLD) });
  }
  finding(be.kind, 'S4c', 'repeated mine-to-cap + convert-all cycles: Platinum after each cycle (uncapped by conversion)', cycleStats);
  finding(be.kind, 'S4c', 'revocation entries in the issuer after the whole scenario', (api(be).revocations() || []).length);
  finding(be.kind, 'S4c', 'wallet stacks: platinum / gold / swallowed merge errors', { platinum: w.stacks(PLAT), gold: w.stacks(GOLD), errors: [...new Set(w.mergeErrors)] });
  return w;
}

async function s5_interrupted(be) {
  const A = api(be);
  // Convert whose response is lost.
  const w = new SimWallet(be, 'interrupt');
  for (let i = 0; i < 10; i++) await w.mint(GOLD, 10);
  const stack = w.creds[0];
  const resp = await A.post('/atlas/convert', { credential: stack, spendAmount: 40, toClass: PLAT }); // client "never sees" this
  const rev = revokedIds(A);
  finding(be.kind, 'S5a', 'convert whose response is lost: predecessor revoked at issuer / successors exist only in the lost response', { status: resp.status, predecessorRevoked: rev.has(stack.id) });
  // Retry the same request.
  const retry = await A.post('/atlas/convert', { credential: stack, spendAmount: 40, toClass: PLAT });
  finding(be.kind, 'S5b', 'retrying the identical convert request', { status: retry.status, error: retry.body.error || null });
  // Can the issuer give the successor back? Search the issuer's HTTP surface for anything keyed by the owner.
  const hist = await A.get('/atlas/asset/history?id=' + encodeURIComponent(resp.body.received.id));
  const hist2 = await A.get('/atlas/asset/history?id=' + encodeURIComponent(stack.id));
  finding(be.kind, 'S5c', 'issuer-side history for the lost successor / for the revoked predecessor', { successorChain: hist.body.chain ? hist.body.chain.length : hist.body, predecessorChain: hist2.body.chain ? hist2.body.chain.length : hist2.body });
  // Mid-sequence crash model: a consolidate that dies after minting but before revoking.
  // (Not injectable over HTTP; documented by reading the handlers: mint, then revoke one by one.)
  // Racing duplicate requests.
  const w2 = new SimWallet(be, 'dup');
  for (let i = 0; i < 6; i++) { const r = await w2.api.post('/atlas/asset/issue', { ownerPublicKey: w2.owner, assetClass: GOLD, quantity: 10, existingBalances: w2.creds }); w2.creds.push(r.body); }
  const group = w2.creds.slice();
  const dup = await Promise.all([A.post('/atlas/asset/consolidate', { credentials: group }), A.post('/atlas/asset/consolidate', { credentials: group })]);
  finding(be.kind, 'S5d', 'two identical consolidate requests at the same time: statuses / valid total afterwards', { statuses: dup.map((d) => d.status), validTotal: dup.filter((d) => d.status === 200).reduce((s, d) => s + d.body.quantity, 0), original: 60 });
  const fresh = (await A.post('/atlas/asset/issue', { ownerPublicKey: w2.owner, assetClass: GOLD, quantity: 30 })).body;
  const dupC = await Promise.all([0, 1, 2].map(() => A.post('/atlas/convert', { credential: fresh, spendAmount: 10, toClass: IRON })));
  finding(be.kind, 'S5e', 'three concurrent converts of one fresh 30 g credential: statuses / iron minted', { statuses: dupC.map((d) => d.status), ironMinted: dupC.filter((d) => d.status === 200).reduce((s, d) => s + d.body.received.quantity, 0), expectedAtMost: 200 });
  // Reversed lock order.
  const w3 = new SimWallet(be, 'order');
  for (let i = 0; i < 6; i++) { const r = await w3.api.post('/atlas/asset/issue', { ownerPublicKey: w3.owner, assetClass: GOLD, quantity: 10, existingBalances: w3.creds }); w3.creds.push(r.body); }
  const ab = w3.creds.slice(0, 3), ba = w3.creds.slice(0, 3).reverse();
  const t0 = Date.now();
  const crossed = await Promise.all([A.post('/atlas/asset/consolidate', { credentials: ab }), A.post('/atlas/asset/consolidate', { credentials: ba })]);
  finding(be.kind, 'S5f', 'two consolidations of the same three stacks in opposite order: statuses / seconds', { statuses: crossed.map((c) => c.status), errors: crossed.map((c) => c.body.error || null).map((e) => e && e.slice(0, 70)), seconds: (Date.now() - t0) / 1000 });
}

async function s6_deleted_revocations(be) {
  const A = api(be);
  const w = new SimWallet(be, 'resurrect');
  for (let i = 0; i < 5; i++) { const r = await w.api.post('/atlas/asset/issue', { ownerPublicKey: w.owner, assetClass: GOLD, quantity: 10, existingBalances: w.creds }); w.creds.push(r.body); }
  const originals = w.creds.slice();                       // e.g. an older wallet export / backup
  const merged = await w.api.post('/atlas/asset/consolidate', { credentials: originals });
  const mergedCred = merged.body;
  finding(be.kind, 'S6a', 'consolidate 5x10 g: merged quantity / predecessors revoked / reason', { merged: mergedCred.quantity, revoked: originals.filter((c) => revokedIds(A).has(c.id)).length, reasons: [...new Set((A.revocations() || []).filter((r) => originals.some((o) => o.id === r.id)).map((r) => r.reason))] });
  // Delete two of the entries by hand, as in the live incident.
  const doc = JSON.parse(fs.readFileSync(be.revFile, 'utf8'));
  doc.revoked = doc.revoked.filter((r) => r.id !== originals[0].id && r.id !== originals[1].id);
  fs.writeFileSync(be.revFile, be.revLayout(doc));
  const wholeTotal = sumValid(A, [mergedCred, ...originals], GOLD);
  finding(be.kind, 'S6c', 'valid Gold across successor + 5 predecessors right after 2 entries were deleted (50 before the deletion)', wholeTotal);
  // The predecessor is spendable again while its successor is also valid.
  const spend = await w.api.post('/atlas/convert', { credential: originals[0], spendAmount: 10, toClass: PLAT });
  finding(be.kind, 'S6b', 'spend a predecessor whose revocation entry was deleted (its successor still valid)', { status: spend.status, platinumMinted: spend.status === 200 ? spend.body.received.quantity : null });
  const split = await w.api.post('/atlas/asset/split', { credential: originals[1], sendAmount: 10, toPublicKey: newOwner('thief') });
  finding(be.kind, 'S6b', 'split of the second resurrected predecessor to another key', { status: split.status });
  // Cap view: presenting successor + resurrected predecessors.
  const cap = await w.api.post('/atlas/asset/issue', { ownerPublicKey: w.owner, assetClass: GOLD, quantity: 10, existingBalances: [mergedCred, originals[0], originals[1]] });
  finding(be.kind, 'S6d', 'cap view when wallet shows successor + 2 resurrected predecessors (50+10+10 presented)', { status: cap.status });
  // Wallet export/backup from before the merge is spendable by anyone holding it (bearer credentials).
  finding(be.kind, 'S6e', 'authorisation needed to spend a credential (no owner signature in split/consolidate/convert requests)', 'bearer: possession of the credential JSON only');
  // Conservation check over the whole scenario.
  return { originals, mergedCred };
}

async function s7_malformed_file(be) {
  const A = api(be);
  const w = new SimWallet(be, 'malformed');
  const r1 = await w.mint(GOLD, 10); const r2 = await w.mint(GOLD, 10);
  const a = (await w.api.post('/atlas/asset/issue', { ownerPublicKey: w.owner, assetClass: IRON, quantity: 100 })).body;
  const spent = await w.api.post('/atlas/convert', { credential: a, spendAmount: 100, toClass: GOLD }); // a is now revoked
  const before = (A.revocations() || []).length;
  // A hand edit that leaves the file unparseable (trailing comma).
  const text = fs.readFileSync(be.revFile, 'utf8');
  fs.writeFileSync(be.revFile, text.replace(/\n\s*\]\s*\n\s*\}\s*$/, ',\n]\n}'));
  const reuse = await w.api.post('/atlas/convert', { credential: a, spendAmount: 100, toClass: GOLD });
  finding(be.kind, 'S7a', 'spend an already-spent credential while the revocation file is syntactically invalid', { status: reuse.status, error: reuse.body.error ? String(reuse.body.error).slice(0, 80) : null });
  const trigger = await w.api.post('/atlas/asset/issue', { ownerPublicKey: w.owner, assetClass: IRON, quantity: 100 });
  const b = trigger.body;
  const tryRevoke = await w.api.post('/atlas/convert', { credential: b, spendAmount: 100, toClass: GOLD });
  let after = null; try { after = JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked.length; } catch (e) { after = 'unparseable'; }
  finding(be.kind, 'S7b', 'revocation entries before the bad edit / after the next successful revoke (does the file lose history?)', { before, after, nextRevokeStatus: tryRevoke.status });
  const pub = be.kind === 'php' ? await w.api.get('/.well-known/atlas-revocations.json') : null;
  fs.writeFileSync(be.revFile, be.revLayout({ revoked: [] }));
}

async function s8_scale(be) {
  const A = api(be);
  const sizes = QUICK ? [0, 6127] : [0, 6127, 20000];
  for (const n of sizes) {
    // Reset the file to a fixture of n entries.
    const doc = { revoked: fixture.entries(n) };
    fs.writeFileSync(be.revFile, be.revLayout(doc));
    const bytes = fs.statSync(be.revFile).size;
    const w = new SimWallet(be, 'scale' + n);
    // 20 stacks of 10 g, one consolidate of 20, one mint presenting 49 balances, one convert.
    const stacks = [];
    for (let i = 0; i < 20; i++) { const r = await A.post('/atlas/asset/issue', { ownerPublicKey: w.owner, assetClass: GOLD, quantity: 10 }); stacks.push(r.body); }
    const c20 = await A.post('/atlas/asset/consolidate', { credentials: stacks });
    const more = [];
    for (let i = 0; i < 49; i++) { const r = await A.post('/atlas/asset/issue', { ownerPublicKey: w.owner, assetClass: IRON, quantity: 10 }); more.push(r.body); }
    const present = await A.post('/atlas/asset/issue', { ownerPublicKey: w.owner, assetClass: IRON, quantity: 10, existingBalances: more });
    const conv = await A.post('/atlas/convert', { credential: c20.body, spendAmount: 100, toClass: PLAT });
    finding(be.kind, 'S8', `list of ${n} entries (${(bytes / 1048576).toFixed(2)} MiB): ms for consolidate-20 / mint presenting 49 balances (request KB) / convert / plain mint`, {
      consolidate20: Math.round(c20.ms), mint49: Math.round(present.ms), mint49Status: present.status, requestKB: Math.round(JSON.stringify(more).length / 1024), convert: Math.round(conv.ms), statuses: [c20.status, present.status, conv.status]
    });
    const plain = await A.post('/atlas/asset/issue', { ownerPublicKey: newOwner('plain'), assetClass: GOLD, quantity: 10 });
    finding(be.kind, 'S8', `  - plain mint with no balances at ${n} entries (ms)`, Math.round(plain.ms));
    const fileAfter = fs.statSync(be.revFile).size;
    finding(be.kind, 'S8', `  - file bytes before -> after these operations at ${n}`, { before: bytes, after: fileAfter, bytesPerEntry: n ? Math.round(bytes / n) : null });
  }
}

async function s9_three_wallets(be) {
  const wallets = ['A', 'B', 'C'].map((l) => new SimWallet(be, 'wallet' + l));
  const cycles = QUICK ? 1 : 3;
  // The tester's procedure: mine to the cap, convert some into Platinum/Iron, mine again - three wallets at once.
  await Promise.all(wallets.map(async (w) => {
    for (let c = 0; c < cycles; c++) {
      while ((await w.mint(GOLD, 10)).ok) { /* until the cap refuses */ }
      const g = w.creds.filter((x) => x.asset.class === GOLD).sort((a, b) => b.quantity - a.quantity)[0];
      if (g) await w.convert(g, Math.floor(g.quantity / 2), c % 2 ? PLAT : IRON);
      await w.mint(GOLD, 10);
    }
  }));
  const A = api(be);
  const rev = revokedIds(A);
  for (const w of wallets) {
    const v = validity(A, w.creds);
    finding(be.kind, 'S9', `wallet ${w.label}: displayed Gold / valid Gold / platinum / stacks Gold / revoked stacks held / swallowed errors`, {
      displayedGold: w.held(GOLD), validGold: sumValid(A, w.creds, GOLD), platinum: w.held(PLAT), iron: w.held(IRON),
      goldStacks: w.stacks(GOLD), revokedHeld: v.filter((x) => x.revoked).length, mergeErrors: [...new Set(w.mergeErrors)], refusals: [...new Set(w.refused.map((e) => e.slice(0, 40)))]
    });
  }
  return wallets;
}

// The reported signature: one ~500 g stack that the issuer has already spent, still shown in the
// wallet, next to 50 separate 10 g stacks. The cap sees none of the spent stack, consolidation
// is refused for the whole group, and mining carries on to a second 500 g.
async function s10_reported_signature(be) {
  const A = api(be);
  const w = new SimWallet(be, 'signature');
  for (let i = 0; i < 50; i++) await w.mint(GOLD, 10);              // one 500 g stack
  const big = w.creds[0];
  const spent = await A.post('/atlas/convert', { credential: big, spendAmount: 500, toClass: PLAT }); // spent at the issuer; the wallet never saw the response
  const platinum = spent.body.received;
  let clicks = 0;
  while ((await w.mint(GOLD, 10)).ok && clicks < 80) clicks++;
  const v = validity(A, w.creds);
  finding(be.kind, 'S10a', 'spent 500 g stack kept in the wallet: further 10 g clicks accepted / stacks shown / displayed Gold / Gold the issuer honours', { clicks, stacks: w.stacks(GOLD), displayed: w.held(GOLD), honoured: sumValid(A, w.creds, GOLD), errors: [...new Set(w.mergeErrors)] });
  // Remove the revocation record of that stack by hand.
  const doc = JSON.parse(fs.readFileSync(be.revFile, 'utf8'));
  doc.revoked = doc.revoked.filter((r) => r.id !== big.id);
  fs.writeFileSync(be.revFile, be.revLayout(doc));
  finding(be.kind, 'S10b', 'after deleting that one revocation record: Gold honoured / Platinum still valid from the same 500 g / stack valid again', { gold: sumValid(A, w.creds, GOLD), platinum: sumValid(A, [platinum], PLAT), stackValid: !revokedIds(A).has(big.id) });
  const again = await w.api.post('/atlas/convert', { credential: big, spendAmount: 500, toClass: PLAT });
  finding(be.kind, 'S10c', 'the same 500 g stack spent into Platinum a second time (its first Platinum still valid)', { status: again.status, platinum: again.status === 200 ? again.body.received.quantity : null });
  const present = await w.api.post('/atlas/asset/consolidate', { credentials: w.creds.filter((c) => c.asset.class === GOLD).slice(0, 20) });
  finding(be.kind, 'S10d', 'a consolidation of the first 20 stacks (incl. the resurrected 500 g) is now accepted (after the stack was spent a second time, so it is refused as revoked again)', { status: present.status, error: present.body.error || null });
}

// ---------- run ----------
(async () => {
  const run = [];
  if (WHICH === 'node' || WHICH === 'both') run.push(['node', () => startNode(8311)]);
  if (WHICH === 'php' || WHICH === 'both') run.push(['php', () => startPhp(8312)]);
  for (const [kind, start] of run) {
    console.log(`\n===== backend: ${kind} (isolated, throw-away state) =====`);
    const be = await start();
    try {
      const steps = [s1_cap, s2_consolidate_limits, s3_poison, s4_convert, s5_interrupted, s6_deleted_revocations, s9_three_wallets, s10_reported_signature, s7_malformed_file, s8_scale];
      for (const step of steps) {
        console.log('--- ' + step.name);
        try { await step(be); } catch (e) { console.log('HARNESS ERROR in ' + step.name + ':', e.stack); findings.push({ backend: kind, id: step.name, text: 'harness error', value: e.message }); }
      }
    } finally { be.stop(); }
  }
  fs.writeFileSync(process.env.GEN1_RESULTS || path.join(os.tmpdir(), 'gen1-incident-results.json'), JSON.stringify(findings, null, 2));
  console.log(`\nDone: ${findings.length} observations written to ${process.env.GEN1_RESULTS || path.join(os.tmpdir(), 'gen1-incident-results.json')}`);
})();
