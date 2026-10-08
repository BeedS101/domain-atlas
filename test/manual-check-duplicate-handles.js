// Manual check of tools/check-duplicate-handles.js: finds handles held twice
// ignoring case, leaves out revoked memberships, and reports nothing for a
// clean store.
//
//   node test/manual-check-duplicate-handles.js

const { findDuplicates } = require('../tools/check-duplicate-handles.js');

function assert(cond, message) {
  if (!cond) { console.error('FAILURE: ' + message); process.exit(1); }
}

const store = { members: [
  { credentialId: 'a', ownerPublicKey: 'K1', handle: 'Bruno' },
  { credentialId: 'b', ownerPublicKey: 'K2', handle: 'bruno' },
  { credentialId: 'c', ownerPublicKey: 'K3', handle: 'alice' },
  { credentialId: 'd', ownerPublicKey: 'K4', handle: 'ALICE' },
  { credentialId: 'e', ownerPublicKey: 'K5' },
  { credentialId: 'f', ownerPublicKey: 'K6', handle: 'carol' }
] };

let dups = findDuplicates(store, null);
assert(dups.length === 2, 'expected two duplicated names, got ' + dups.length);
assert(dups.find(([h]) => h === 'bruno')[1].map((m) => m.ownerPublicKey).join() === 'K1,K2', 'bruno holders in store order');

dups = findDuplicates(store, { revoked: [{ id: 'd' }] });
assert(dups.length === 1 && dups[0][0] === 'bruno', 'a revoked membership no longer counts');

assert(findDuplicates({ members: [{ credentialId: 'x', ownerPublicKey: 'K', handle: 'solo' }] }, null).length === 0, 'a clean store reports nothing');
assert(findDuplicates({}, null).length === 0 && findDuplicates(null, null).length === 0, 'empty input is fine');

console.log('ALL DUPLICATE HANDLE CHECKER CHECKS PASSED');
