// The shared Call Service checks (call-service-suite.js) against the PHP service under PHP's
// built-in web server: tags, membership, invites, signalling, replay, tampering, limits,
// cleanup. Requires `php` with the openssl and curl extensions on PATH.
// Run: node test/manual-call-php-service.js
'use strict';
const L = require('./call-php-lib');
const suite = require('./call-service-suite');

suite({ backend: 'php', label: 'manual-call-php-service', start: L.startPhpService })
  .then((code) => process.exit(code))
  .catch((e) => { console.error(e); process.exit(2); });
