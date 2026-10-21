// Removes the runtime state an in-place run of issuer-php leaves in the source tree
// (keys, published documents, stores, locks, replay / holdings / journal entries).
// Without it a later run that copies or reuses the folder starts next to an earlier
// issuer's history, which the issuer treats as an established deployment and so does
// not give a revocation list. Operator configuration (*-config.json, atlas-private-dir.txt)
// and the protective .htaccess files are kept.
const fs = require('fs');
const path = require('path');

function removeMatching(dir, test) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { return; }
  for (const name of names) {
    if (test(name)) { try { fs.rmSync(path.join(dir, name), { force: true, recursive: true }); } catch (err) {} }
  }
}

function cleanIssuerPhpState(bundleDir) {
  const lib = path.join(bundleDir, 'lib');
  removeMatching(lib, (n) => /^atlas-.*\.json$/.test(n) && !/-config\.json$/.test(n));
  removeMatching(lib, (n) => /\.lock$/.test(n) || /-private-key\.pem$/.test(n));
  for (const sub of ['replay', 'holdings', 'txn']) removeMatching(path.join(lib, sub), (n) => n[0] !== '.');
  removeMatching(path.join(bundleDir, '.well-known'), (n) => /^atlas-.*\.json$/.test(n));
}

module.exports = { cleanIssuerPhpState };
