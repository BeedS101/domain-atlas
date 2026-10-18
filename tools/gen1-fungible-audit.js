#!/usr/bin/env node
// Read-only audit of Gen1 portable fungible balances (Gold, Platinum and the other mined elements)
// from copies of wallet exports and revocation lists. Writes nothing except, when asked, its own
// report; it contacts no issuer, changes no wallet and repairs no revocation list.
//
//   node tools/gen1-fungible-audit.js \
//     --wallet walletA.json --wallet walletB.json --wallet walletC.json \
//     --revocations atlas-revocations.current.json \
//     [--revocations-backup atlas-revocations.backup1.json ...] \
//     [--key atlas-key.json] [--class atlas.element.gold --class atlas.element.platinum] \
//     [--json report.json]
//
// A wallet file can be a wallet export ({format:"atlas-wallet-export/1.0", credentials:[...]}), a bare
// array of credentials, an array of {credential} wallet entries, or an object with `wallet` / `data.wallet`.
// Work on COPIES of live files. Nothing here is proof of what was spent: a revocation record says an
// issuer spent a credential, and a missing record says nothing either way.
'use strict';
const fs = require('fs');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

function parseArgs(argv) {
  const a = { wallet: [], backups: [], classes: [], revocations: null, key: null, json: null, all: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error('missing value after ' + k); return argv[++i]; };
    if (k === '--wallet') a.wallet.push(v());
    else if (k === '--revocations') a.revocations = v();
    else if (k === '--revocations-backup') a.backups.push(v());
    else if (k === '--key') a.key = v();
    else if (k === '--class') a.classes.push(v());
    else if (k === '--all') a.all = true;
    else if (k === '--json') a.json = v();
    else if (k === '--help' || k === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
    else throw new Error('unknown argument ' + k);
  }
  if (!a.wallet.length || !a.revocations) throw new Error('need at least one --wallet and --revocations (see --help)');
  if (!a.classes.length && !a.all) a.classes = ['atlas.element.gold', 'atlas.element.platinum'];
  return a;
}

const b64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function credentialsOf(doc) {
  let list = Array.isArray(doc) ? doc : doc.credentials || doc.wallet || (doc.data && doc.data.wallet) || [];
  return list.map((e) => (e && e.credential && typeof e.credential === 'object' ? e.credential : e)).filter((c) => c && c.credential === 'domain-atlas-asset/1.0');
}

async function signatureOk(cred, keyDoc) {
  if (!keyDoc) return null;
  const t = Date.parse(cred.issuedAt);
  const keys = (keyDoc.keys || []).filter((k) => (!k.validFrom || Date.parse(k.validFrom) <= t) && (!k.validUntil || t <= Date.parse(k.validUntil)));
  const payload = { id: cred.id, asset: cred.asset, owner: cred.owner, quantity: cred.quantity, supersedes: cred.supersedes, issuedAt: cred.issuedAt };
  for (const k of keys) {
    try {
      const key = await subtle.importKey('raw', b64u(k.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u(cred.signature), new TextEncoder().encode(canonicalize(payload)))) return true;
    } catch (e) { /* try the next key */ }
  }
  return false;
}

const supersedesOf = (c) => (Array.isArray(c.supersedes) ? c.supersedes : c.supersedes ? [c.supersedes] : []);

async function audit(args) {
  const keyDoc = args.key ? readJson(args.key) : null;
  const cur = readJson(args.revocations);
  const current = new Map();
  const problems = [];
  if (!Array.isArray(cur.revoked)) problems.push('current revocation file has no "revoked" list');
  for (const r of cur.revoked || []) {
    if (!r || typeof r.id !== 'string') { problems.push('current revocation list has an entry without a string id'); continue; }
    if (current.has(r.id)) problems.push('duplicate revocation entry for ' + r.id);
    current.set(r.id, r);
  }
  // Entries present in any older copy but absent now.
  const backupEntries = new Map();
  const backupInfo = [];
  for (const f of args.backups) {
    const d = readJson(f);
    const list = d.revoked || [];
    backupInfo.push({ file: f, entries: list.length });
    for (const r of list) if (r && typeof r.id === 'string' && !backupEntries.has(r.id)) backupEntries.set(r.id, { ...r, backup: f });
  }
  const removed = [...backupEntries.values()].filter((r) => !current.has(r.id));

  // Every credential in every wallet file, once per id.
  const byId = new Map();
  for (const f of args.wallet) {
    const doc = readJson(f);
    for (const c of credentialsOf(doc)) {
      if (!byId.has(c.id)) byId.set(c.id, { cred: c, sources: [] });
      byId.get(c.id).sources.push(f);
    }
  }
  const all = [...byId.values()];
  const wanted = (c) => c.asset && c.asset.fungible === true && (args.all || args.classes.includes(c.asset.class));
  const successors = new Map();
  for (const { cred } of all) for (const p of supersedesOf(cred)) { if (!successors.has(p)) successors.set(p, []); successors.get(p).push(cred.id); }
  const isRevoked = (id) => current.has(id);

  const rows = [];
  for (const { cred, sources } of all) {
    if (!wanted(cred)) continue;
    const sig = await signatureOk(cred, keyDoc);
    const succ = (successors.get(cred.id) || []).map((id) => ({ id, held: byId.has(id), revoked: isRevoked(id) }));
    const rev = current.get(cred.id) || null;
    const deleted = !rev && backupEntries.get(cred.id) ? backupEntries.get(cred.id) : null;
    let state, note;
    if (sig === false) { state = 'UNVERIFIED'; note = 'signature does not verify against the supplied key document'; }
    else if (deleted) { state = 'RESURRECTED'; note = `revocation record (${deleted.reason}, ${deleted.revokedAt}) is in ${deleted.backup} but missing now: not to be counted`; }
    else if (rev) {
      const lost = !succ.length && ['consolidated', 'superseded'].includes(rev.reason);
      state = lost ? 'SPENT_NO_SUCCESSOR' : 'SPENT';
      note = lost ? `revoked (${rev.reason}, ${rev.revokedAt}); no successor in the files supplied: value may be lost or held elsewhere` : `revoked (${rev.reason}, ${rev.revokedAt}); display copy only`;
    } else if (succ.length) { state = 'SUPERSEDED_NOT_REVOKED'; note = 'a later credential names this one as its predecessor but no revocation record exists: probably deleted, or the response was lost between mint and revoke'; }
    else { state = 'CURRENT'; note = ''; }
    rows.push({ id: cred.id, class: cred.asset.class, owner: cred.owner.publicKey, quantity: cred.quantity, issuedAt: cred.issuedAt, state, signatureVerified: sig, successors: succ, supersedes: supersedesOf(cred), sources: sources.length === 1 ? sources[0] : sources, note });
  }

  // Conservation across consolidation: successor quantity == sum of its predecessors, when all are known.
  const conservation = [];
  for (const { cred } of all) {
    if (!wanted(cred) || !Array.isArray(cred.supersedes)) continue;
    const preds = cred.supersedes.map((id) => byId.get(id)).filter(Boolean);
    if (preds.length === cred.supersedes.length) {
      const sum = preds.reduce((s, p) => s + p.cred.quantity, 0);
      if (sum !== cred.quantity) conservation.push({ successor: cred.id, quantity: cred.quantity, predecessorsSum: sum });
    }
  }

  // Per owner and class.
  const totals = {};
  for (const r of rows) {
    const t = (totals[r.owner] = totals[r.owner] || {});
    const c = (t[r.class] = t[r.class] || { displayed: 0, current: 0, resurrected: 0, supersededNotRevoked: 0, spentHeld: 0, spentNoSuccessor: 0, unverified: 0, stacksCurrent: 0, stacksTotal: 0 });
    c.stacksTotal++; c.displayed += r.quantity;
    if (r.state === 'CURRENT') { c.current += r.quantity; c.stacksCurrent++; }
    else if (r.state === 'RESURRECTED') c.resurrected += r.quantity;
    else if (r.state === 'SUPERSEDED_NOT_REVOKED') c.supersededNotRevoked += r.quantity;
    else if (r.state === 'SPENT') c.spentHeld += r.quantity;
    else if (r.state === 'SPENT_NO_SUCCESSOR') c.spentNoSuccessor += r.quantity;
    else c.unverified += r.quantity;
  }
  const heldIds = new Set(all.map((x) => x.cred.id));
  const orphanRevocations = [...current.values()].filter((r) => !heldIds.has(r.id)).length;
  return {
    revocationFile: { path: args.revocations, entries: current.size, problems, backups: backupInfo, removedSinceBackup: removed },
    credentialsRead: all.length, considered: rows.length, totals, rows, conservationMismatches: conservation,
    revocationsNotInAnyWallet: orphanRevocations,
    caveats: [
      'A missing revocation record is not evidence that a credential was never spent.',
      'SUPERSEDED_NOT_REVOKED and RESURRECTED rows are excluded from "current" because a later credential already carries their value.',
      'CURRENT only means: nothing supplied says otherwise. It is not proof the issuer will honour it; only a spend request to the issuer decides that.',
      'Credentials that exist only in the lost response of an interrupted request cannot appear here.'
    ]
  };
}

function print(rep) {
  const L = (s) => console.log(s);
  L('Gen1 fungible balance audit (read-only)');
  L('Revocation file: ' + rep.revocationFile.entries + ' entries' + (rep.revocationFile.problems.length ? ', PROBLEMS: ' + rep.revocationFile.problems.join('; ') : ''));
  for (const b of rep.revocationFile.backups) L('  backup ' + b.file + ': ' + b.entries + ' entries');
  L('  entries present in a backup but missing now: ' + rep.revocationFile.removedSinceBackup.length);
  for (const r of rep.revocationFile.removedSinceBackup.slice(0, 50)) L(`    ${r.id}  ${r.reason}  ${r.revokedAt}`);
  L(`Credentials read: ${rep.credentialsRead}; fungible and in scope: ${rep.considered}`);
  L('');
  for (const [owner, classes] of Object.entries(rep.totals)) {
    L('Owner ' + owner.slice(0, 16) + '...');
    for (const [cls, c] of Object.entries(classes)) {
      L(`  ${cls}: displayed ${c.displayed} g in ${c.stacksTotal} stacks | current ${c.current} g in ${c.stacksCurrent} | resurrected ${c.resurrected} | superseded-not-revoked ${c.supersededNotRevoked} | spent copies ${c.spentHeld} | spent-no-successor ${c.spentNoSuccessor} | unverified ${c.unverified}`);
    }
  }
  if (rep.conservationMismatches.length) { L(''); L('Consolidations whose total does not equal their predecessors: ' + JSON.stringify(rep.conservationMismatches)); }
  L('');
  L('Revocation entries that no supplied wallet holds a copy of: ' + rep.revocationsNotInAnyWallet + ' (normal for spent credentials)');
  rep.caveats.forEach((c) => L('Note: ' + c));
}

module.exports = { audit, canonicalize, parseArgs };

if (require.main === module) {
  (async () => {
    try {
      const args = parseArgs(process.argv);
      const rep = await audit(args);
      print(rep);
      if (args.json) fs.writeFileSync(args.json, JSON.stringify(rep, null, 2));
    } catch (e) { console.error('error: ' + e.message); process.exit(2); }
  })();
}
