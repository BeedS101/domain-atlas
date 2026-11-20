'use strict';
// A holdings lookup made by hand carries a nonce, as the wallet's does: a signed one uses its challenge, a public one a random value.
// A test that wants the earlier form, with no nonce, passes `nonce: null`.
const crypto = require('crypto');

function withNonce(query, body) {
  if (!/(^|&)action=holdings(&|$)/.test(query) || !body || typeof body !== 'object' || 'nonce' in body) return body;
  const challenge = body.request && body.request.payload && body.request.payload.challenge;
  const nonce = typeof challenge === 'string' && /^[a-f0-9]{32}$/.test(challenge) ? challenge : crypto.randomBytes(16).toString('hex');
  return Object.assign({}, body, { nonce });
}

module.exports = { withNonce };
