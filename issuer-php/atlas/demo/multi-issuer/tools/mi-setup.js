#!/usr/bin/env node
// Node twin of mi-admin.php's keygen, config and manifest commands, for a machine that has Node
// but no PHP command line (for example the PC you upload from). It writes the same private-directory
// files; upload that directory to a location OUTSIDE the web root, chmod the key to 600, and delete
// the local copy of signing-key.pem afterwards. Prefer mi-admin.php on the server itself when a shell
// is available, so the private key never exists anywhere else.
//
//   node mi-setup.js keygen --dir DIR --domain NAME
//   node mi-setup.js config --dir DIR --domain NAME --state NAME --roster "name=PUBLICKEY,..."
//        --issuance-threshold N --issuance-mandatory a,b --transfer-threshold N --transfer-mandatory a,b
//        [--classes joint-explorer-certificate] [--allow-insecure-http] [--open-discovery]
//        [--override "name=http://127.0.0.1:PORT/api.php?op=discovery,..."]
//        [--public-demo [--public-set maxSessions=100,transferTtlSeconds=300]] [--enable]
//   node mi-setup.js manifest --dir DIR --service "asset.issue.approve=URL,asset.transfer.approve=URL[,asset.state=URL]"
//        [--valid-days 30] [--signer-dir NEWKEYDIR] [--domain NAME]
//
// The state authority must be mandatory in both policies; the server-side check refuses to enable
// the lab otherwise. Run `php mi-admin.php check --dir DIR` on the server after uploading.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DISCOVERY_VERSION = 'domain-atlas-multi-issuer-discovery/1';
const ENDORSEMENT_VERSION = 'domain-atlas-mi-key-endorsement/1';
const WELL_KNOWN_PATH = '/.well-known/atlas-multi-issuer.json';
const CAPABILITIES = ['asset.issue.approve', 'asset.transfer.approve', 'asset.state'];

const argv = process.argv.slice(2);
const cmd = argv[0];
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
function die(m) { console.error(m); process.exit(1); }
const csv = (s) => String(s === undefined || s === true ? '' : s).split(',').map((x) => x.trim()).filter(Boolean);
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const phpStr = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

// Matches lib/crypto.php canonicalize(): sorted keys, no whitespace, JSON string escaping.
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
function pubOf(privateKey) {
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return b64u(spki.subarray(spki.length - 65)); // SEC1 uncompressed point 0x04||X||Y
}
function signRaw(privateKey, message) {
  return b64u(crypto.sign('sha256', Buffer.from(message, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
}
function readKey(dir) {
  const f = path.join(dir, 'signing-key.pem');
  if (!fs.existsSync(f)) die(f + ' missing; run keygen first');
  return crypto.createPrivateKey(fs.readFileSync(f));
}

const dir = arg('dir');
if (typeof dir !== 'string') die('--dir is required');

if (cmd === 'keygen') {
  const domain = arg('domain');
  if (typeof domain !== 'string') die('--domain is required');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, 'signing-key.pem');
  if (fs.existsSync(keyFile)) die('signing-key.pem already exists; refusing to overwrite it');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'sec1', format: 'pem' }), { mode: 0o600 });
  const pub = pubOf(privateKey);
  fs.writeFileSync(path.join(dir, 'public-key.txt'), pub + '\n');
  console.log('domain:      ' + domain);
  console.log('public key:  ' + pub);
  console.log('(only the public key is ever shared; the private key stays in signing-key.pem)');
} else if (cmd === 'config') {
  const domain = arg('domain'), state = arg('state'), rosterArg = arg('roster');
  if (typeof domain !== 'string' || typeof state !== 'string' || typeof rosterArg !== 'string') die('--domain, --state and --roster are required');
  const roster = [];
  for (const item of csv(rosterArg)) {
    const m = /^([a-z0-9][a-z0-9.-]*)=([A-Za-z0-9_-]{87})$/.exec(item);
    if (!m) die('bad roster item (expected name=PUBLICKEY): ' + item);
    roster.push([m[1], m[2]]);
  }
  const list = (a) => '[' + csv(a).map(phpStr).join(', ') + ']';
  const classes = typeof arg('classes') === 'string' ? csv(arg('classes')) : ['joint-explorer-certificate'];
  const lines = [
    '<?php', '// Multi-issuer lab configuration. Keep this directory outside the web root.', 'return [',
    "  'enabled' => " + (arg('enable', false) ? 'true' : 'false') + ',',
    "  'domain' => " + phpStr(domain) + ',',
    "  'stateAuthority' => " + phpStr(state) + ',',
    "  'roster' => [", ...roster.map(([d, k]) => '    ' + phpStr(d) + " => ['publicKey' => " + phpStr(k) + '],'), '  ],',
    "  'issuance' => ['threshold' => " + parseInt(arg('issuance-threshold', '0'), 10) + ", 'mandatory' => " + list(arg('issuance-mandatory', '')) + '],',
    "  'transfer' => ['threshold' => " + parseInt(arg('transfer-threshold', '0'), 10) + ", 'mandatory' => " + list(arg('transfer-mandatory', '')) + '],',
    "  'assetClasses' => [" + classes.map(phpStr).join(', ') + '],',
    "  'allowInsecureHttp' => " + (arg('allow-insecure-http', false) ? 'true' : 'false') + ',',
    "  'openDiscovery' => " + (arg('open-discovery', false) ? 'true' : 'false') + ',',
  ];
  if (typeof arg('override') === 'string') {
    const items = csv(arg('override')).map((kv) => {
      const i = kv.indexOf('=');
      if (i < 1) die('bad --override item: ' + kv);
      return phpStr(kv.slice(0, i)) + ' => ' + phpStr(kv.slice(i + 1));
    });
    lines.push("  'discoveryOverrides' => [" + items.join(', ') + '],');
  }
  if (arg('public-demo', false)) {
    const items = ["'enabled' => true"];
    if (typeof arg('public-set') === 'string') {
      for (const kv of csv(arg('public-set'))) {
        const m = /^([A-Za-z]+)=([0-9]+)$/.exec(kv);
        if (!m) die('bad --public-set item: ' + kv);
        items.push(phpStr(m[1]) + ' => ' + parseInt(m[2], 10));
      }
    }
    lines.push("  'publicDemo' => [" + items.join(', ') + '],');
  }
  lines.push('];', '');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'config.php'), lines.join('\n'), { mode: 0o600 });
  console.log('wrote ' + path.join(dir, 'config.php') + (arg('enable', false) ? ' (ENABLED)' : ' (disabled; re-run with --enable or set enabled to true)'));
} else if (cmd === 'manifest') {
  const services = {};
  for (const kv of csv(arg('service', ''))) {
    const i = kv.indexOf('=');
    if (i < 1 || !CAPABILITIES.includes(kv.slice(0, i))) die('bad --service item: ' + kv);
    services[kv.slice(0, i)] = kv.slice(i + 1);
  }
  if (!Object.keys(services).length) die('--service is required');
  const pinned = readKey(dir);
  const pinnedPub = pubOf(pinned);
  let domain = typeof arg('domain') === 'string' ? arg('domain') : null;
  const cfgFile = path.join(dir, 'config.php');
  if (!domain && fs.existsSync(cfgFile)) {
    const m = /'domain'\s*=>\s*'([^']+)'/.exec(fs.readFileSync(cfgFile, 'utf8'));
    if (m) domain = m[1];
  }
  if (!domain) die('config.php with a domain (or --domain) is required before the manifest can be built');
  const now = Date.now();
  const manifestFile = path.join(dir, 'manifest.json');
  let seq = 1;
  if (fs.existsSync(manifestFile)) {
    try { seq = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).doc.seq + 1; } catch (e) { seq = 1; }
  }
  let signer = pinned;
  const keys = [{ publicKey: pinnedPub, validFrom: iso(now - 60000), validUntil: null }];
  if (typeof arg('signer-dir') === 'string') {
    signer = readKey(arg('signer-dir'));
    const newPub = pubOf(signer);
    const from = iso(now - 60000);
    const endorse = { v: ENDORSEMENT_VERSION, domain, publicKey: newPub, validFrom: from };
    keys.push({ publicKey: newPub, validFrom: from, validUntil: null, endorsement: { by: pinnedPub, signature: signRaw(pinned, canonicalize(endorse)) } });
  }
  const validDays = parseInt(arg('valid-days', '30'), 10);
  const doc = { domain, seq, issuedAtMs: now, validUntilMs: now + validDays * 86400000, keys, services };
  const wrap = { spec: DISCOVERY_VERSION, doc, signedBy: pubOf(signer), signature: signRaw(signer, canonicalize(doc)) };
  fs.writeFileSync(manifestFile, JSON.stringify(wrap, null, 4) + '\n');
  console.log('wrote ' + manifestFile + ' (sequence ' + seq + ', valid until ' + iso(doc.validUntilMs) + ')');
  console.log('publish it at https://' + domain + WELL_KNOWN_PATH);
} else {
  die('usage: keygen | config | manifest (see the header of this file)');
}
