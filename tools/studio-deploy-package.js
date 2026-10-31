#!/usr/bin/env node
// Copies exactly the files that Asset Studio adds to (or changes on) an existing Domain Atlas PHP issuer into
// <out>/public_html, laid out as the document root of the site (demo-domain-a/ with issuer-php/ laid over it).
//
//   node tools/studio-deploy-package.js <out dir>
//
// Nothing that holds issuer state (keys, journals, holdings, replay records, per-domain config) is in the list,
// and the list refuses anything under lib/ that is not a source file, so extracting the result over a live site
// cannot overwrite state. Run from the repository root.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const out = process.argv[2];
if (!out) { console.error('usage: node tools/studio-deploy-package.js <out dir>'); process.exit(2); }

// [repository path, path under the document root]
const FILES = [];
const issuer = (rel) => FILES.push(['issuer-php/' + rel, rel]);

// New: the Studio application.
['index.html', 'studio.css', 'studio.js', 'api.php',
  'inc/.htaccess', 'inc/authorize-design.php', 'inc/challenges.php', 'inc/design-fingerprint.php', 'inc/design-validator.php',
  'inc/issuance-plan.php', 'inc/keys.php', 'inc/mint-attempts.php', 'inc/mint-authorization.php', 'inc/model-catalog.php',
  'inc/storage.php', 'inc/studio-mint.php', 'inc/storage-root.php.example',
].forEach((f) => issuer('atlas/studio/' + f));

// Changed: shared issuer libraries (include-only guard; store.php and bootstrap.php also refuse the Studio class
// on the general mint paths) and the three routes that must refuse that class.
['bootstrap', 'crypto', 'delivery', 'demo-authority', 'elements-catalog', 'email-tickets', 'imap', 'ledger-issuance',
  'ledger-receipts', 'mime-parse', 'replacement', 'sign-manifest', 'smtp', 'store', 'transfer-policy',
].forEach((f) => issuer('lib/' + f + '.php'));
['atlas/asset/issue.php', 'atlas/asset/reissue.php', 'atlas/admin/class-patch.php'].forEach(issuer);

// New: Studio's own model collection, assets/studio/{trophy,badge,key}.{glb,png}. The site's own models in
// assets/ (including assets/badge.* and assets/trophy.*) are never part of the package.
['trophy', 'badge', 'key'].forEach((t) => ['glb', 'png'].forEach((e) => FILES.push(['demo-domain-a/assets/studio/' + t + '.' + e, 'assets/studio/' + t + '.' + e])));

// Every asset file in the package must sit in assets/studio/, never directly in assets/.
for (const [, dest] of FILES) {
  if (dest.startsWith('assets/') && !/^assets\/studio\/(trophy|badge|key)\.(glb|png)$/.test(dest)) { console.error('refusing a model outside assets/studio/: ' + dest); process.exit(1); }
}

const STATE = /(^|\/)(atlas-[^/]*\.(json|txt)|[^/]*\.pem|[^/]*private[^/]*|[^/]*config[^/]*\.json|\.salt|replay|journal|holdings)(\/|$)/i;
let bad = 0;
for (const [src, dest] of FILES) {
  if (!fs.existsSync(path.join(ROOT, src))) { console.error('missing: ' + src); bad++; }
  if (dest.startsWith('lib/') && !/^lib\/[a-z-]+\.php$/.test(dest)) { console.error('refusing non-source file under lib/: ' + dest); bad++; }
  if (STATE.test(dest) && !/\.example$/.test(dest)) { console.error('refusing a state-looking path: ' + dest); bad++; }
}
if (bad) process.exit(1);

const dest0 = path.join(path.resolve(out), 'public_html');
for (const [src, dest] of FILES) {
  const to = path.join(dest0, dest);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(ROOT, src), to);
  fs.chmodSync(to, 0o644);
}
console.log(FILES.length + ' files written under ' + dest0);
for (const [, dest] of FILES) console.log('  ' + dest);
