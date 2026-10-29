// Checks that the Node setup tool (tools/mi-setup.js) produces files the PHP side accepts:
// config that passes `mi-admin.php check`, and manifests (plain and key-rotated) that the PHP
// validator accepts under the issuer's pinned key. No ports are used.
//   node test/manual-multi-issuer-setup.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MI = path.join(__dirname, '..', 'issuer-php', 'atlas', 'demo', 'multi-issuer');
const SETUP = path.join(MI, 'tools', 'mi-setup.js');
const ADMIN = path.join(MI, 'tools', 'mi-admin.php');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-setup-'));
let n = 0;
function pass(m) { n++; console.log('PASS ' + m); }
function fail(m) { console.error('FAIL ' + m); process.exitCode = 1; throw new Error(m); }
function run(cmd, args) { return spawnSync(cmd, args, { encoding: 'utf8' }); }
function node(args) { const r = run('node', [SETUP].concat(args)); if (r.status !== 0) fail('mi-setup ' + args[0] + ': ' + r.stderr); return r.stdout; }

const VALIDATE = '<?php putenv("MI_PRIVATE_DIR=" . $argv[1]); require $argv[3] . "/inc/mi.php"; list($cfg) = mi_load_config();' +
  '$w = json_decode(file_get_contents($argv[2]), true); $i = ["domain" => "a.test", "publicKey" => $cfg["roster"]["a.test"]["publicKey"]];' +
  'list($doc, $why) = mi_validate_manifest($cfg, $i, $w); echo json_encode([$doc ? $doc["keyStatus"] : null, $why]);';

try {
  const a = path.join(root, 'a'), b = path.join(root, 'b'), a2 = path.join(root, 'a2');
  node(['keygen', '--dir', a, '--domain', 'a.test']);
  node(['keygen', '--dir', b, '--domain', 'b.test']);
  node(['keygen', '--dir', a2, '--domain', 'a.test']);
  if (node(['keygen', '--dir', path.join(root, 'x'), '--domain', 'x.test']).indexOf('public key') < 0) fail('keygen prints the public key');
  pass('keygen writes distinct keys and prints only the public key');
  if (run('node', [SETUP, 'keygen', '--dir', a, '--domain', 'a.test']).status === 0) fail('keygen overwrote an existing key');
  pass('keygen refuses to overwrite an existing key');
  const ka = fs.readFileSync(path.join(a, 'public-key.txt'), 'utf8').trim();
  const kb = fs.readFileSync(path.join(b, 'public-key.txt'), 'utf8').trim();
  for (const [d, dom] of [[a, 'a.test'], [b, 'b.test']]) {
    node(['config', '--dir', d, '--domain', dom, '--state', 'a.test', '--roster', 'a.test=' + ka + ',b.test=' + kb,
      '--issuance-threshold', '2', '--issuance-mandatory', 'a.test,b.test', '--transfer-threshold', '2', '--transfer-mandatory', 'a.test,b.test', '--public-demo', '--enable']);
  }
  const chk = run('php', [ADMIN, 'check', '--dir', a]);
  if (chk.status !== 0 || !/OK: domain a\.test, state authority a\.test, issuance 2-of-2/.test(chk.stdout)) fail('php check rejected the node-written config: ' + chk.stdout + chk.stderr);
  pass('config written by the Node tool passes the PHP check');
  const bad = run('node', [SETUP, 'config', '--dir', path.join(root, 'bad'), '--domain', 'a.test', '--state', 'a.test', '--roster', 'a.test=short']);
  if (bad.status === 0) fail('a malformed roster key was accepted');
  pass('a malformed roster key is refused');

  const v = path.join(root, 'v.php');
  fs.writeFileSync(v, VALIDATE);
  const svc = 'asset.issue.approve=https://a.test/atlas/demo/multi-issuer/api.php,asset.transfer.approve=https://a.test/atlas/demo/multi-issuer/api.php,asset.state=https://a.test/atlas/demo/multi-issuer/api.php';
  node(['manifest', '--dir', a, '--service', svc]);
  let r = run('php', [v, b, path.join(a, 'manifest.json'), MI]);
  let out = JSON.parse(r.stdout || '[null,"no output: ' + r.stderr.replace(/"/g, "'") + '"]');
  if (!out[0]) fail('php rejected the node-signed manifest: ' + out[1]);
  pass('a manifest signed by the Node tool validates under the pinned key (' + out[0] + ')');
  node(['manifest', '--dir', a, '--signer-dir', a2, '--service', svc]);
  r = run('php', [v, b, path.join(a, 'manifest.json'), MI]);
  out = JSON.parse(r.stdout || '[null,"no output"]');
  if (out[0] !== 'rotated') fail('rotated manifest not accepted as rotated: ' + JSON.stringify(out));
  pass('a rotated manifest is accepted only through the pinned key\'s endorsement');
  const m = JSON.parse(fs.readFileSync(path.join(a, 'manifest.json'), 'utf8'));
  if (m.doc.seq !== 2) fail('sequence did not increment');
  m.doc.services['asset.transfer.approve'] = 'https://evil.test/atlas/demo/multi-issuer/api.php';
  fs.writeFileSync(path.join(root, 'tampered.json'), JSON.stringify(m));
  r = run('php', [v, b, path.join(root, 'tampered.json'), MI]);
  out = JSON.parse(r.stdout || '[null,"no output"]');
  if (out[0]) fail('a tampered manifest was accepted');
  pass('a tampered manifest is rejected (' + out[1] + ')');
  console.log('\nALL ' + n + ' SETUP-TOOL CHECKS PASSED');
} catch (e) {
  console.error(String(e.message || e));
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
