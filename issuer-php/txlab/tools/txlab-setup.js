#!/usr/bin/env node
// Node twin of txlab-admin.php's keygen and config commands, for a machine that has Node but no
// PHP command line (for example the PC you upload from). It writes the same private-directory
// files; upload that directory to a location OUTSIDE the web root and chmod the key to 600.
//
//   node txlab-setup.js keygen --dir DIR --domain NAME
//   node txlab-setup.js config --dir DIR --domain NAME --settlement NAME --threshold N --mandatory a,b
//        --roster "name=PUBLICKEY@https://name/txlab/api.php,..." [--ttl 900] [--accounts alice=10000,bob=0] [--enable]
//
// The key is generated on the machine running this script, so prefer the PHP tool on the server
// itself when you can run it there; this exists for hosts without a command line.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const cmd = argv[0];
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
function die(m) { console.error(m); process.exit(1); }
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const phpStr = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

const dir = arg('dir');
if (typeof dir !== 'string') die('--dir is required');

if (cmd === 'keygen') {
  const domain = arg('domain');
  if (typeof domain !== 'string') die('--domain is required');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, 'signing-key.pem');
  if (fs.existsSync(keyFile)) die('signing-key.pem already exists; refusing to overwrite it');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'sec1', format: 'pem' }), { mode: 0o600 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pub = b64u(spki.subarray(spki.length - 65)); // SEC1 uncompressed point 0x04||X||Y
  fs.writeFileSync(path.join(dir, 'public-key.txt'), pub + '\n');
  const token = crypto.randomBytes(20).toString('hex');
  fs.writeFileSync(path.join(dir, 'admin-token.sha256'), crypto.createHash('sha256').update(token).digest('hex') + '\n', { mode: 0o600 });
  console.log('domain:        ' + domain);
  console.log('public key:    ' + pub);
  console.log('admin token:   ' + token);
  console.log('(the token is shown only now; keep it in a password manager. Only its sha256 hash is stored.)');
} else if (cmd === 'config') {
  const domain = arg('domain'), settlement = arg('settlement'), rosterArg = arg('roster');
  const threshold = parseInt(arg('threshold', '0'), 10);
  const mandatory = String(arg('mandatory', '')).split(',').filter(Boolean);
  if (typeof domain !== 'string' || typeof settlement !== 'string' || typeof rosterArg !== 'string' || threshold < 1) die('--domain, --settlement, --roster and --threshold are required');
  const roster = [];
  for (const item of rosterArg.split(',')) {
    const m = /^([^=@]+)=([A-Za-z0-9_-]+)@(https?:\/\/\S+)$/.exec(item.trim());
    if (!m) die('bad roster item: ' + item);
    roster.push([m[1], m[2], m[3]]);
  }
  const hashFile = path.join(dir, 'admin-token.sha256');
  if (!fs.existsSync(hashFile)) die('run keygen first (admin-token.sha256 missing)');
  let accounts = [['alice', 10000], ['bob', 0]];
  if (typeof arg('accounts') === 'string') accounts = arg('accounts').split(',').map((a) => { const [n, v] = a.split('='); return [n, parseInt(v, 10)]; });
  const php = [
    '<?php', '// Transaction lab configuration. Keep this directory outside the web root.', 'return [',
    '  \'enabled\' => ' + (arg('enable', false) ? 'true' : 'false') + ',',
    '  \'domain\' => ' + phpStr(domain) + ',',
    '  \'settlementDomain\' => ' + phpStr(settlement) + ',',
    '  \'threshold\' => ' + threshold + ',',
    '  \'mandatory\' => [' + mandatory.map(phpStr).join(', ') + '],',
    '  \'ttlSeconds\' => ' + parseInt(arg('ttl', '900'), 10) + ',',
    '  \'accounts\' => [' + accounts.map(([n, v]) => phpStr(n) + ' => ' + v).join(', ') + '],',
    '  \'roster\' => [',
    ...roster.map(([d, k, u]) => '    ' + phpStr(d) + ' => [\'publicKey\' => ' + phpStr(k) + ', \'baseUrl\' => ' + phpStr(u) + '],'),
    '  ],',
    '  \'adminTokenHash\' => ' + phpStr(fs.readFileSync(hashFile, 'utf8').trim()) + ',',
    '  \'allowInsecureHttp\' => ' + (arg('allow-insecure-http', false) ? 'true' : 'false') + ',',
    '];', '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'config.php'), php, { mode: 0o600 });
  console.log('wrote ' + path.join(dir, 'config.php') + (arg('enable', false) ? ' (ENABLED)' : ' (disabled; re-run with --enable or set enabled to true)'));
} else {
  die('usage: keygen | config (see the header of this file)');
}
