// A realistic revocation list for tests: entries shaped like the ones the issuers write
// (id, revokedAt, reason), laid out like the PHP issuer's JSON_PRETTY_PRINT output. 6,127 entries
// come to about 1.07 MiB, the size of a live list, which is over the key document's 256 KiB limit
// and well inside the revocation list's 4 MiB limit.
'use strict';
const crypto = require('crypto');

const REASONS = ['redeemed', 'clawback', 'revoked by issuer', 'refunded'];
const REAL_COUNT = 6127;
const REVOCATION_BYTE_LIMIT = 4194304;
const KEY_BYTE_LIMIT = 262144;
const REVOCATION_ENTRY_LIMIT = 20000;

function entry(n) {
  const h = crypto.createHash('sha256').update('revoked-' + n).digest('hex');
  return {
    id: 'urn:atlas:asset:' + h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32),
    revokedAt: new Date(Date.parse('2026-03-01T00:00:00Z') + n * 7919000).toISOString().replace(/\.\d+Z$/, 'Z'),
    reason: REASONS[n % REASONS.length]
  };
}

// `count` entries, then `extra` entries (appended), as a list.
function entries(count, extra) {
  const revoked = [];
  for (let n = 0; n < count; n++) revoked.push(entry(n));
  for (const e of extra || []) revoked.push(e);
  return revoked;
}

const pretty = (revoked) => JSON.stringify({ revoked }, null, 4);

// The same text padded with trailing spaces to exactly `bytes` bytes (valid JSON stays valid).
function padTo(text, bytes) {
  const have = Buffer.byteLength(text);
  if (have > bytes) throw new Error('already longer than ' + bytes);
  return text + ' '.repeat(bytes - have);
}

module.exports = { entry, entries, pretty, padTo, REAL_COUNT, REVOCATION_BYTE_LIMIT, KEY_BYTE_LIMIT, REVOCATION_ENTRY_LIMIT };
