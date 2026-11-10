#!/usr/bin/env node
// Writes the configuration files for a controlled Gold purchase on the chain labs, from public information and one new random token. It
// changes nothing on any server: it only writes files into --out, which are then uploaded by hand (see docs/chain-labs-gold-purchase-runbook.md).
//
//   node tools/chainlabs-gold-setup.js --out ./gold-setup \
//     --issuer-url https://issuer.example --issuer-domain issuer.example --issuer-key <the issuer's raw public key from the coin's policy> \
//     --authority a.example \
//     --domain a.example=https://a.example/chain-labs/spend34.php?action=coins \
//     --domain b.example=https://b.example/chain-labs/spend34.php?action=coins
//
// Each --domain is NAME=SOURCE, where SOURCE is either the https address that answers with the domain's public key (spend34.php?action=coins
// has a "domainKey") or a file holding that key as PEM. --web-path is the folder of the chain labs under the web root (default chain-labs; use
// an empty value if they are in the web root itself).
//
// Output (nothing is printed that is secret):
//   issuer/atlas-gold-hold-config.json     into the issuer's lib folder: turns the hold endpoint on, holds the SHA-256 of the token and the domain keys it trusts to close sales
//   <authority>/gold-adapter.php           into the authority's chainblock-labs-private folder: holds the token. Keep it private.
//   <other domain>/gold-adapter.php        into each partner's chainblock-labs-private folder: no token, only the checks.
//   SETUP.txt                              where each file goes
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

function parse(argv) {
  const out = { domains: [] };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (!k || !k.startsWith('--') || v === undefined) throw new Error('every option needs a value: ' + (k || ''));
    if (k === '--domain') out.domains.push(v); else out[k.slice(2)] = v;
  }
  return out;
}
const fetchText = (url) => new Promise((resolve, reject) => {
  const u = new URL(url);
  if (u.protocol !== 'https:') return reject(new Error('only https addresses are read: ' + url));
  https.get(u, { headers: { Accept: 'application/json' }, timeout: 15000 }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => (res.statusCode === 200 ? resolve(b) : reject(new Error(url + ' answered HTTP ' + res.statusCode))));
  }).on('error', reject);
});
async function domainKey(source) {
  let pem;
  if (/^https:/.test(source)) pem = JSON.parse(await fetchText(source)).domainKey;
  else pem = fs.readFileSync(source, 'utf8');
  if (typeof pem !== 'string') throw new Error('no public key found in ' + source);
  const key = crypto.createPublicKey(pem);
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== 'ec' || !details || details.namedCurve !== 'prime256v1') throw new Error('the key from ' + source + ' is not a P-256 key');
  return key.export({ type: 'spki', format: 'pem' });
}
const plain = (s, what) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9._:\/=-]{1,300}$/.test(s)) throw new Error(what + ' has characters this tool does not write into a file');
  return s;
};

(async () => {
  const o = parse(process.argv);
  for (const need of ['out', 'issuer-url', 'issuer-domain', 'issuer-key', 'authority']) if (!o[need]) throw new Error('--' + need + ' is required');
  if (o.domains.length < 1) throw new Error('at least one --domain NAME=SOURCE is needed');
  const issuerUrl = plain(o['issuer-url'].replace(/\/+$/, ''), '--issuer-url');
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(issuerUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(issuerUrl)) throw new Error('--issuer-url must be https://host (no path)');
  const issuerDomain = plain(o['issuer-domain'], '--issuer-domain');
  const issuerKey = plain(o['issuer-key'], '--issuer-key');
  if (!/^[A-Za-z0-9_-]{87}$/.test(issuerKey)) throw new Error('--issuer-key must be the 87 character raw public key from the coin\'s purchase policy');
  const web = o['web-path'] === undefined ? 'chain-labs' : o['web-path'].replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9._\/-]*$/.test(web)) throw new Error('--web-path has odd characters');
  const keys = {};
  for (const d of o.domains) {
    const eq = d.indexOf('=');
    const name = d.slice(0, eq), source = d.slice(eq + 1);
    if (eq < 1 || !/^[a-z0-9.-]{3,253}$/.test(name)) throw new Error('--domain must be NAME=SOURCE: ' + d);
    keys[name] = await domainKey(source);
  }
  if (!keys[o.authority]) throw new Error('--authority must be one of the --domain names');
  const token = crypto.randomBytes(32).toString('hex');
  const tokenSha256 = crypto.createHash('sha256').update(token).digest('hex');
  const out = path.resolve(o.out);
  fs.mkdirSync(path.join(out, 'issuer'), { recursive: true });
  fs.writeFileSync(path.join(out, 'issuer', 'atlas-gold-hold-config.json'), JSON.stringify({ enabled: true, tokenSha256, ledgerAuthorities: keys }, null, 2) + '\n');
  const adapter = (withToken) => {
    const cfg = { issuerUrl, issuerDomain, issuerKey, timeout: 10, ...(withToken ? { token } : {}) };
    return '<?php\ndeclare(strict_types=1);\n// The price adapter of this domain for Gold held by ' + issuerDomain + '. ' + (withToken ? 'It holds the operator token of the issuer\'s hold endpoint: keep this file private.' : 'It only checks; it holds no token.') + '\n'
      + '$lib = rtrim((string) realpath((string) ($_SERVER[\'DOCUMENT_ROOT\'] ?? \'\')), \'/\\\\\') . \'' + (web ? '/' + web : '') + '/lib/gold-issuer.php\';\n'
      + 'if (!is_file($lib)) return null;\nrequire_once $lib;\n'
      + 'return gold_issuer_adapter(json_decode(\'' + JSON.stringify(cfg) + '\', true));\n';
  };
  for (const name of Object.keys(keys)) {
    fs.mkdirSync(path.join(out, name), { recursive: true });
    fs.writeFileSync(path.join(out, name, 'gold-adapter.php'), adapter(name === o.authority), { mode: 0o600 });
  }
  const lines = [
    'Chain labs Gold purchase setup (generated; contains a secret token inside ' + o.authority + '/gold-adapter.php)', '',
    'issuer/atlas-gold-hold-config.json   ->  ' + issuerDomain + ': the issuer\'s lib folder (beside lib/gold-hold.php). Turns the hold endpoint on.',
    ...Object.keys(keys).map((n) => n + '/gold-adapter.php   ->  ' + n + ': the chainblock-labs-private folder (beside chain34.sqlite)' + (n === o.authority ? '. Holds the token.' : '. No token.')),
    '', 'The issuer must pass the Authorization header to PHP (see the runbook). Delete a domain\'s gold-adapter.php to switch purchases off there at once.', '',
  ];
  fs.writeFileSync(path.join(out, 'SETUP.txt'), lines.join('\n'));
  console.log('Wrote ' + out + '\n' + lines.slice(2, -3).join('\n'));
})().catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
