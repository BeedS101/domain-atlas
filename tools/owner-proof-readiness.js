// Says whether an issuer can switch membership issuance to ATLAS_OWNER_PROOF=require without turning anyone away.
//
// Reads the outcome counts the issuer keeps (no keys, credentials or request ids in them):
//   Node issuer   <state folder>/atlas-owner-proof-stats-store.json
//   PHP issuer    <private folder>/owner-proof/stats.json   (the folder in lib/atlas-private-dir.txt, or lib/ when none)
//
//   node tools/owner-proof-readiness.js <stats file or state folder> [--days 7] [--json]
//
// Exit code: 0 ready (or already enforcing), 1 not ready or not enough information, 2 the file could not be read.
// 'accept' mode is a temporary compatibility step: until an issuer is on 'require', anyone can still ask it to issue a
// membership card to a key they do not hold.
'use strict';
const fs = require('fs');
const path = require('path');
const proof = require('../issuer-server/lib-owner-proof');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const days = (() => { const i = args.indexOf('--days'); return i >= 0 ? Number(args[i + 1]) || 7 : 7; })();
let target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--days');
if (!target) {
  console.error('usage: node tools/owner-proof-readiness.js <stats file or state folder> [--days 7] [--json]');
  process.exit(2);
}
if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
  const candidates = ['atlas-owner-proof-stats-store.json', path.join('owner-proof', 'stats.json'), 'stats.json'].map((f) => path.join(target, f));
  target = candidates.find((f) => fs.existsSync(f)) || candidates[0];
}
let doc;
try { doc = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (err) {
  console.error('could not read ' + target + ': ' + err.message + '\nThe issuer writes this file the first time it starts with the owner-proof check (Node) or handles a membership request (PHP).');
  process.exit(2);
}
const r = proof.readiness(doc, Date.now(), days);
if (flag('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(r.state === 'ready' || r.state === 'enforcing' ? 0 : 1); }

const line = (s) => console.log(s);
line('Membership owner proof (' + target + ')');
line('  mode: ' + (r.mode || 'unknown') + (r.modeSince ? ' since ' + r.modeSince : '') + '    last activity: ' + (r.updatedAt || 'none'));
for (const row of r.rows) {
  line('  ' + row.assetClass.padEnd(34) + ' signed ' + String(row.signed).padStart(5) + '   unsigned ' + String(row.unsigned).padStart(5) + '   refused ' + String(row.refused).padStart(5)
    + (row.lastUnsignedAt ? '   last unsigned ' + row.lastUnsignedAt : ''));
}
if (Object.keys(r.refusedByCode || {}).length) line('  refusals by code: ' + Object.entries(r.refusedByCode).map(([k, v]) => k + ' ' + v).join(', '));
line('');
if (r.state === 'enforcing') line('REQUIRE is on: unsigned membership requests are refused.');
else if (r.state === 'off') line('OFF: no check is made. Set ATLAS_OWNER_PROOF to accept, then require.');
else if (r.state === 'not-ready') line('NOT READY for require: unsigned issuance within the last ' + days + ' days for ' + r.unsignedRecently.join(', ') + '. Those wallets would be turned away.');
else if (r.state === 'no-signed-yet') line('NOT ENOUGH INFORMATION: no signed membership issuance has been seen yet. Join once with an updated wallet, then check again.');
else line('READY for require: no unsigned issuance in the last ' + days + ' days and signed issuance works on this issuer. Accept mode is still only a compatibility step: set ATLAS_OWNER_PROOF=require to finish the fix.');
process.exit(r.state === 'ready' || r.state === 'enforcing' ? 0 : 1);
