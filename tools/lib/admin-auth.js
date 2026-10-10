// Builds the payload.adminAuth object every signed admin request carries
// (issuer-server/server.js authenticateAdminProof, issuer-php/lib/store.php
// authenticate_admin_proof): the route path, the domain it is for, a
// timestamp, and a single-use nonce. A request is valid for a couple of
// minutes and exactly once, so build a fresh one for every request.
const { randomBytes } = require('crypto');

function adminAuth(domain, action, overrides) {
  return Object.assign({
    action,
    domain,
    issuedAt: new Date().toISOString(),
    nonce: randomBytes(18).toString('base64url')
  }, overrides || {});
}

// Value of `--name <v>` from argv, or undefined.
function argValue(name) {
  const idx = process.argv.indexOf('--' + name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

module.exports = { adminAuth, argValue };
