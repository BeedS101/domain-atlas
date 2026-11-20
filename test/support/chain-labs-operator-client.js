// Operator requests for the tests that run their own server instead of test/support/chain-labs-servers.js: a roster for the private folder,
// and signed request bodies. `repeat` is signed by default, because those tests repeat actions on purpose to look at what the ledger answers.
'use strict';
const fs = require('fs');
const path = require('path');
const OP = require('../../tools/lib/chainlabs-operator');

// Puts a roster with a new operator key in `priv`, and returns the identity.
function install(priv, domain, over = {}) {
  const identity = OP.newIdentity();
  fs.writeFileSync(path.join(priv, 'chainlabs-operators.json'), JSON.stringify(Object.assign({ domain, keys: [{ publicKey: identity.publicKey, label: 'test' }] }, over)), { mode: 0o600 });
  return identity;
}

const sign = (identity, domain, action, request, opts = {}) => OP.signRequest(identity, { domain, action, request: request || {}, repeat: opts.repeat !== false, at: opts.at });
const coinRequest = (symbol, extra = {}) => ({ name: 'Coin ' + symbol, symbol, decimals: 2, maxSupply: '100000', initialSupply: '1000', description: '', ...extra });

module.exports = { OP, install, sign, coinRequest };
