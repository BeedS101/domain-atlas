// Test helpers for signed admin requests. Every admin route now requires
// payload.adminAuth {action, domain, issuedAt, nonce}; withAdminAuth() returns
// a copy of a payload carrying a fresh one for `action` on the server at `base`.
const { adminAuth } = require('../../tools/lib/admin-auth');

function hostOf(base) {
  return new URL(base).host;
}

function withAdminAuth(payload, base, action, overrides) {
  return Object.assign({}, payload, { adminAuth: adminAuth(hostOf(base), action, overrides) });
}

module.exports = { adminAuth, hostOf, withAdminAuth };
