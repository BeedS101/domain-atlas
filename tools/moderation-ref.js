#!/usr/bin/env node
// Prints the moderator reference for a domain and moderator public key, for
// use in a presence service's "revokedModerators" list (see
// docs/moderation-authorization.md, section 10).
//
//   node tools/moderation-ref.js <domain> <moderator public key>
//
// The reference is a pseudonym derived from the two arguments. It reveals
// nothing about the key, and anyone who knows a candidate key can recompute it.

const { moderatorRef } = require('./lib/moderation-grant');

const [domain, publicKey] = process.argv.slice(2);
if (!domain || !publicKey || !/^[A-Za-z0-9_-]{87}$/.test(publicKey)) {
  console.error('usage: node tools/moderation-ref.js <domain> <moderator public key (87 base64url characters)>');
  process.exit(2);
}
console.log(moderatorRef(domain, publicKey));
