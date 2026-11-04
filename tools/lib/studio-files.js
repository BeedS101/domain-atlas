'use strict';
// The files Asset Studio adds to (or changes on) an existing PHP issuer, as [repository path, path under the
// document root]. Shared by tools/studio-deploy-package.js and tools/site-doctor-build.js so the two cannot drift.
const FILES = [];
const issuer = (rel) => FILES.push(['issuer-php/' + rel, rel]);

// New: the Studio application.
['index.html', 'studio.css', 'studio.js', 'model-viewer.js', 'api.php',
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

module.exports = { FILES };
