// The verifier's configuration can live outside the web root: config.php in the package folder is then a one-line stub
// that returns the real file. Checks the arrangement documented in docs/verifier-private-config.md on a clean install.
//
//   node test/verifier-private-config.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startIssuer, freePort } = require('./lib/php-issuer');
const { newOwner } = require('./lib/owner-auth');
const { buildPackage, extractPackage, servePhp, postJson } = require('./lib/package-install');

let failures = 0;
let total = 0;
function line(ok, text, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
const cleanup = [];

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verify-private-'));
  cleanup.push(() => fs.rmSync(work, { recursive: true, force: true }));
  const zip = buildPackage(path.join(work, 'build'));
  const issuer = await startIssuer();
  cleanup.push(() => issuer.stop());
  const credential = await issuer.issue(newOwner(), 'atlas.badge');

  // home/ is the account's home directory (not served); home/public_html/atlas-verify/ is the uploaded package;
  // home/atlas-private/ holds the real configuration
  const home = path.join(work, 'home');
  const docroot = path.join(home, 'public_html');
  const privateDir = path.join(home, 'atlas-private');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const install = extractPackage(zip, path.join(docroot));
  const realConfig = path.join(privateDir, 'verify-config.php');
  fs.writeFileSync(realConfig, '<?php\nreturn [\n  \'trustedIssuers\' => [\'' + issuer.origin + '\'],\n  \'allowInsecureLoopback\' => true,\n];\n', { mode: 0o600 });
  fs.writeFileSync(path.join(install, 'config.php'), "<?php\nreturn require '" + realConfig + "';\n", { mode: 0o644 });

  const server = await servePhp(install, await freePort(), { args: ['-d', 'open_basedir=' + install + ':' + privateDir + ':/tmp', '-d', 'display_errors=0'] });
  cleanup.push(server.stop);
  const info = await (await fetch(server.base + '/verify.php')).json();
  line(info.configured === true && info.trustedIssuers.join() === issuer.origin, 'the stub in the package folder loads the configuration from the private directory', info);
  const verdict = await postJson(server.base + '/verify.php', { credential });
  line(verdict.json && verdict.json.status === 'verified', 'and a credential verifies with it (open_basedir limited to the package and the private directory)', verdict.text.slice(0, 160));

  const stub = await fetch(server.base + '/config.php');
  const stubText = await stub.text();
  line(stubText === '' && !stubText.includes(privateDir), 'requesting the stub directly runs it and prints nothing: neither its path nor the settings appear (' + stub.status + ')', stubText.slice(0, 100));
  const privateUrl = await fetch(server.base + '/../atlas-private/verify-config.php');
  line(privateUrl.status >= 400 || (await privateUrl.text()) === '', 'the private directory is not reachable through the web server');
  line(path.relative(docroot, realConfig).startsWith('..'), 'the real file is outside the document root');

  // misconfiguration is visible and safe
  fs.writeFileSync(path.join(install, 'config.php'), "<?php\nreturn require '" + path.join(privateDir, 'missing.php') + "';\n");
  const missing = await postJson(server.base + '/verify.php', { credential });
  line(missing.status >= 500 || (missing.json && missing.json.valid === false), 'a stub that points at a missing file never verifies anything (' + missing.status + ')', missing.text.slice(0, 120));
  fs.writeFileSync(path.join(install, 'config.php'), "<?php\nreturn require '" + realConfig + "';\n");
  fs.writeFileSync(realConfig, '<?php\nreturn [ \'trustedIssuers\' => [] ];\n');
  const empty = await postJson(server.base + '/verify.php', { credential });
  line(empty.status === 503 && empty.json && empty.json.valid === false, 'an empty trusted list in the private file refuses everything (503)', empty.text.slice(0, 120));
  fs.writeFileSync(realConfig, '<?php\nreturn "not an array";\n');
  const wrongType = await postJson(server.base + '/verify.php', { credential });
  line(wrongType.status === 503 && wrongType.json && wrongType.json.valid === false, 'a private file that does not return an array refuses everything (503)', wrongType.text.slice(0, 120));
  const before = fs.readFileSync(realConfig, 'utf8');
  await postJson(server.base + '/verify.php', { credential });
  line(fs.readFileSync(realConfig, 'utf8') === before, 'the verifier never modifies the configuration');

  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' PRIVATE CONFIG CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
})().catch((err) => { failures++; console.error('FAILURE:', err); }).finally(async () => {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { /* already stopped */ } }
  process.exit(failures === 0 ? 0 : 1);
});
