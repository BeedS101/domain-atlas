// Offline setup assistant smoke and refusal checks. No server, network or live-domain traffic.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const setup = require('../tools/installer/verifier-setup.js');

let checks = 0;
function check(name, fn) {
  try { fn(); checks++; console.log('PASS ' + name); }
  catch (e) { console.error('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; }
}
const base = { issuers: 'https://issuer.example', privatePath: '/home/testaccount/atlas-private/verify-config.php' };

check('lowercase issuer and strip HTTPS default port', function () {
  assert.equal(setup.normalizeOrigin('  https://ISSUER.example:443/ '), 'https://issuer.example');
});
check('keep legitimate HTTPS port', function () { assert.equal(setup.normalizeOrigin('https://issuer.example:8443'), 'https://issuer.example:8443'); });
check('reject HTTP, credentials, paths, queries and fragments', function () {
  for (const input of ['http://issuer.example', 'https://user@issuer.example', 'https://issuer.example/path',
    'https://issuer.example/?x=1', 'https://issuer.example#x', 'https://issuer.example:0',
    'https://issuer.example:65536', 'https://issuer.example.evil/path']) {
    assert.throws(function () { setup.normalizeOrigin(input); }, Error, input);
  }
});
check('reject invalid hostnames, IP addresses and localhost', function () {
  for (const input of ['https://localhost', 'https://127.0.0.1', 'https://bad..example',
    'https://-bad.example', 'https://bad-.example', 'https://bad']) {
    assert.throws(function () { setup.normalizeOrigin(input); }, Error, input);
  }
});
check('reject duplicate normalized trusted issuers', function () {
  assert.throws(function () { setup.generate(Object.assign({}, base, { issuers: 'https://ISSUER.example\nhttps://issuer.example:443' })); }, /Duplicate/);
});
check('require 1–10 origins', function () {
  assert.throws(function () { setup.generate(Object.assign({}, base, { issuers: '' })); }, /between 1 and 10/);
  assert.throws(function () { setup.generate(Object.assign({}, base, { issuers: Array.from({ length: 11 }, function (_, i) { return 'https://issuer' + i + '.example'; }).join('\n') })); }, /between 1 and 10/);
});
check('reject the example ACCOUNT path until replaced', function () {
  assert.throws(function () { setup.generate(Object.assign({}, base, { privatePath: '/home/ACCOUNT/atlas-private/verify-config.php' })); }, /Replace ACCOUNT/);
});
check('reject traversal, relative paths, and public web roots', function () {
  for (const p of ['config.php', '/home/test/../verify-config.php', '/home/test//verify-config.php',
    '/home/test/public_html/verify-config.php', '/var/www/verify-config.php',
    '/home/test/atlas private/verify-config.php', '/home/test/atlas-private/stuff.php']) {
    assert.throws(function () { setup.generate(Object.assign({}, base, { privatePath: p })); }, Error, p);
  }
});
check('require known suspension policies', function () {
  assert.throws(function () { setup.generate(Object.assign({}, base, { suspensions: 'disabled' })); }, /Invalid suspension/);
});
check('default to required suspension checking', function () {
  const out = setup.generate(base);
  assert.equal(out.suspensionMode, 'required');
  assert.match(out.privateConfig, /'suspensions' => 'required'/);
  assert.match(out.privateConfig, /'accessTokenSha256' => null/);
  assert.match(out.privateConfig, /'allowInsecureLoopback' => false/);
  assert.match(out.privateConfig, /'allowedOrigins' => \[\]/);
});
check('legacy optional suspension mode must be explicit', function () {
  const out = setup.generate(Object.assign({}, base, { suspensions: 'optional' }));
  assert.match(out.privateConfig, /'suspensions' => 'optional'/);
});
check('generate one stable distinct entry for every origin', function () {
  const out = setup.generate(Object.assign({}, base, { issuers: 'https://a.example\nhttps://b.example:8443' }));
  assert.deepEqual(out.trustedIssuers, ['https://a.example', 'https://b.example:8443']);
  assert.equal((out.privateConfig.match(/'suspensions' =>/g) || []).length, 2);
});
check('stub uses the requested private path, not an embedded issuer list', function () {
  const out = setup.generate(base);
  assert.equal(out.stub, "<?php\n// Install alongside verify.php as config.php.\nreturn require '/home/testaccount/atlas-private/verify-config.php';\n");
  assert.doesNotMatch(out.stub, /trustedIssuers/);
});
check('PHP accepts generated configuration and rejects syntax errors', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verify-setup-test-'));
  try {
    const out = setup.generate(Object.assign({}, base, { issuers: 'https://a.example\nhttps://b.example' }));
    const file = path.join(dir, 'verify-config.php');
    const stub = path.join(dir, 'config.php');
    fs.writeFileSync(file, out.privateConfig);
    fs.writeFileSync(stub, out.stub);
    const lint = child.spawnSync('php', ['-l', file], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stderr);
    const stubLint = child.spawnSync('php', ['-l', stub], { encoding: 'utf8' });
    assert.equal(stubLint.status, 0, stubLint.stderr);
    const read = child.spawnSync('php', ['-r', 'echo json_encode(include ' + JSON.stringify(file) + ');'], { encoding: 'utf8' });
    assert.equal(read.status, 0, read.stderr);
    const config = JSON.parse(read.stdout);
    assert.equal(Object.keys(config.trustedIssuers).length, 2);
    assert.equal(config.trustedIssuers['https://a.example'].suspensions, 'required');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
check('page is local-only, with no third-party scripts or fetch calls', function () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'tools/installer/index.html'), 'utf8');
  assert.match(html, /src="\.\/verifier-setup\.js"/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//i);
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|<form[^>]+action=/);
});
if (!process.exitCode) console.log('ALL ' + checks + ' VERIFIER SETUP ASSISTANT CHECKS PASSED');
