#!/usr/bin/env node
// Lists Post Office handles held by more than one member in a members
// store, ignoring case. New claims cannot create duplicates (SPEC.md, handle
// addressing in the Post Office section), but a store written before that check may contain
// them, and resolving such a handle delivers to the first member in the
// store that is neither revoked nor suspended.
//
//   node tools/check-duplicate-handles.js <atlas-postoffice-members-store.json> [atlas-revocations.json]
//
// With the revocation list given, revoked memberships are left out, as the
// issuer leaves them out. Exits 1 when a duplicate is found, so it can run
// in a script. Reads only; nothing is changed.

const fs = require('fs');

function findDuplicates(membersDoc, revocationsDoc) {
  const revoked = new Set(((revocationsDoc && revocationsDoc.revoked) || []).map((r) => r.id));
  const byHandle = new Map();
  for (const m of (membersDoc && membersDoc.members) || []) {
    if (!m.handle || revoked.has(m.credentialId)) continue;
    const key = m.handle.toLowerCase();
    if (!byHandle.has(key)) byHandle.set(key, []);
    byHandle.get(key).push(m);
  }
  return [...byHandle.entries()].filter(([, list]) => list.length > 1);
}

module.exports = { findDuplicates };

if (require.main === module) {
  const [membersPath, revocationsPath] = process.argv.slice(2);
  if (!membersPath) {
    console.error('usage: node tools/check-duplicate-handles.js <members-store.json> [revocations.json]');
    process.exit(2);
  }
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const dups = findDuplicates(read(membersPath), revocationsPath ? read(revocationsPath) : null);
  if (dups.length === 0) {
    console.log('No handle is held by more than one member.');
    process.exit(0);
  }
  for (const [handle, list] of dups) {
    console.log('"' + handle + '" is held by ' + list.length + ' members (resolving picks the first that is not revoked or suspended):');
    list.forEach((m, i) => console.log('  ' + (i === 0 ? '* ' : '  ') + m.ownerPublicKey + '  joined ' + (m.joinedAt || '?') + '  membership ' + m.credentialId));
  }
  process.exit(1);
}
