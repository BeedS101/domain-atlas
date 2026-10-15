// Call Service tests for the Node service: tags, membership, invites, signalling, replay,
// tampering, limits, cleanup. Runs the service in this process on loopback with short timers.
// The checks live in call-service-suite.js and are shared with the PHP service.
// Run: node test/manual-call-service.js
'use strict';
const T = require('./call-test-lib');
const suite = require('./call-service-suite');

suite({ backend: 'node', label: 'manual-call-service', start: T.startService })
  .then((code) => process.exit(code))
  .catch((e) => { console.error(e); process.exit(2); });
