// Host and peer configuration of the chain labs (chain-labs/lib/hosts.php):
//   - with no configuration file the labs answer for the two original domains and they peer with each other
//   - a valid configuration file replaces the domains and peers
//   - an invalid one leaves no domain at all (every lab refuses), it never falls back to the defaults
//   - every lab that checks the host uses the library, and none still names a domain
//   - the library cannot be fetched directly
//
//   node test/chain-labs-config.js
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, '..', 'chain-labs');
const LIB = path.join(DIR, 'lib', 'hosts.php');
let failures = 0;
let total = 0;
function line(ok, text, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}

// Runs the library in a fresh PHP process with an optional configuration file and prints the results as JSON.
function lib(configJson) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-labs-config-'));
  const env = Object.assign({}, process.env);
  delete env.CHAINLABS_CONFIG;
  if (configJson !== undefined) {
    const file = path.join(tmp, 'chainlabs-config.json');
    fs.writeFileSync(file, configJson);
    env.CHAINLABS_CONFIG = file;
  }
  const code = "require '" + LIB + "'; echo json_encode(['hosts' => chainlabs_hosts(), 'peers' => chainlabs_peer_map(), 'partners' => array_map('chainlabs_partners', chainlabs_hosts()), 'is' => array_map('chainlabs_is_host', ['evtec.co.za', 'a.example', 'EVTEC.co.za', 'evtec.co.za:443', ''])]);";
  const out = execFileSync('php', ['-r', code], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  fs.rmSync(tmp, { recursive: true, force: true });
  return JSON.parse(out);
}
// PHP encodes an empty map as [], so maps are compared as key and value pairs.
const norm = (x) => (Array.isArray(x) && x.length === 0 ? {} : x);
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

console.log('\n== the library');
const dflt = lib();
line(same(dflt.hosts, ['evtec.co.za', 'domain-atlas.co.za']), 'no configuration: the two original domains', dflt.hosts);
line(same(dflt.peers, { 'evtec.co.za': 'domain-atlas.co.za', 'domain-atlas.co.za': 'evtec.co.za' }), 'no configuration: they peer with each other', dflt.peers);
line(same(dflt.is, [true, false, false, false, false]), 'the library matches a host exactly: no other name, case, port or empty string', dflt.is);

const two = lib(JSON.stringify({ hosts: ['a.example', 'b.example'] }));
line(same(two.hosts, ['a.example', 'b.example']) && same(two.peers, { 'a.example': 'b.example', 'b.example': 'a.example' }), 'a configuration of two hosts replaces the defaults and they peer', two);
line(same(two.is, [false, true, false, false, false]), 'the original domains are refused once a configuration names others', two.is);
const three = lib(JSON.stringify({ hosts: ['a.example', 'b.example', 'c.example'] }));
line(three.hosts.length === 3 && same(three.peers, {}), 'three hosts with no peers list have no peers', three);
const withPeers = lib(JSON.stringify({ hosts: ['a.example', 'b.example', 'c.example'], peers: { 'a.example': 'b.example', 'b.example': 'a.example' } }));
line(same(withPeers.peers, { 'a.example': 'b.example', 'b.example': 'a.example' }), 'an explicit peers list is used as given', withPeers.peers);
line(same(withPeers.partners, [['b.example'], ['a.example'], []]), 'without a partners list a host\'s partner is its peer', withPeers.partners);
const withPartners = lib(JSON.stringify({ hosts: ['a.example', 'b.example', 'c.example'], partners: { 'a.example': ['b.example', 'c.example'], 'b.example': ['a.example'] } }));
line(same(withPartners.partners, [['b.example', 'c.example'], ['a.example'], []]), 'a partners list names several partners for a host', withPartners.partners);
const one = lib(JSON.stringify({ hosts: ['solo.example'] }));
line(same(one.hosts, ['solo.example']) && same(one.peers, {}), 'a single host is allowed and has no peer', one);

const bad = {
  'not JSON': '{oops',
  'empty file': '',
  'a list instead of an object': '["a.example"]',
  'no hosts key': '{"peers":{}}',
  'hosts not a list': '{"hosts":{"a":"a.example"}}',
  'empty hosts': '{"hosts":[]}',
  'six hosts': JSON.stringify({ hosts: ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => x + '.example') }),
  'duplicate host': '{"hosts":["a.example","a.example"]}',
  'a host with a port': '{"hosts":["a.example:8080"]}',
  'an upper-case host': '{"hosts":["A.example"]}',
  'a host with a path': '{"hosts":["a.example/x"]}',
  'a host with a scheme': '{"hosts":["https://a.example"]}',
  'a bare name': '{"hosts":["localhost"]}',
  'a non-string host': '{"hosts":[5]}',
  'a peer that is not a host': '{"hosts":["a.example","b.example"],"peers":{"a.example":"c.example"}}',
  'a host that peers with itself': '{"hosts":["a.example","b.example"],"peers":{"a.example":"a.example"}}',
  'peers as a list': '{"hosts":["a.example","b.example"],"peers":["b.example"]}',
  'partners that are not a map': '{"hosts":["a.example","b.example"],"partners":["b.example"]}',
  'a partner that is not a host': '{"hosts":["a.example","b.example"],"partners":{"a.example":["c.example"]}}',
  'a host that is its own partner': '{"hosts":["a.example","b.example"],"partners":{"a.example":["a.example"]}}',
  'the same partner twice': '{"hosts":["a.example","b.example"],"partners":{"a.example":["b.example","b.example"]}}',
  'an empty partner list': '{"hosts":["a.example","b.example"],"partners":{"a.example":[]}}',
  'partners given for a host that is not listed': '{"hosts":["a.example","b.example"],"partners":{"z.example":["b.example"]}}',
  'too large': JSON.stringify({ hosts: ['a.example'], pad: 'x'.repeat(9000) }),
};
for (const [name, content] of Object.entries(bad)) {
  const r = lib(content);
  line(r.hosts.length === 0 && same(r.peers, {}) && r.is.every((x) => x === false), 'invalid configuration (' + name + ') leaves no host at all', r);
}

console.log('\n== the labs use the library');
const php = fs.readdirSync(DIR).filter((f) => f.endsWith('.php'));
const named = php.filter((f) => /evtec\.co\.za|domain-atlas\.co\.za/.test(fs.readFileSync(path.join(DIR, f), 'utf8')));
line(named.length === 0, 'no lab file names a domain any more', named);
const users = ['account30', 'accounts31', 'coin26', 'ledger29', 'supply25', 'market27', 'compare23', 'events21', 'events22', 'federation', 'federation20', 'spend34'];
const missing = users.filter((f) => !/require __DIR__\.'\/lib\/hosts\.php';/.test(fs.readFileSync(path.join(DIR, f + '.php'), 'utf8')));
line(missing.length === 0, 'every lab that checks the host loads the library', missing);

console.log('\n== each lab answers the configured hosts and refuses others');
const REFUSAL = /unknown-host|unknown host|unknown node|unrecognized (host|node)|unexpected host/i;
async function labs() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-labs-hosts-'));
  const root = path.join(work, 'public');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(work, 'chainblock-labs-private'));
  for (const f of php) fs.copyFileSync(path.join(DIR, f), path.join(root, f));
  fs.cpSync(path.join(DIR, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(work, 'prepend.php'), "<?php $_SERVER['HTTPS'] = 'on';\n");
  const port = 21000 + Math.floor(Math.random() * 15000);
  const server = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root, '-d', 'auto_prepend_file=' + path.join(work, 'prepend.php')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const request = (file, host) => new Promise((resolve) => {
    const post = file === 'account30';
    const req = http.request({ host: '127.0.0.1', port, path: '/' + file + '.php?action=' + (post ? 'open' : 'list'), method: post ? 'POST' : 'GET', headers: { host } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
  const refused = async (file, host) => { const r = await request(file, host); return r.status === 400 && REFUSAL.test(r.body); };
  const configFile = path.join(work, 'chainblock-labs-private', 'chainlabs-config.json');
  try {
    // The default configuration, with the private folder present but empty of configuration.
    for (const f of users) {
      const a = await refused(f, 'evtec.co.za'), b = await refused(f, 'domain-atlas.co.za'), c = await refused(f, 'other.example'), d = await refused(f, 'EVTEC.co.za');
      // The labs lower-case the host before checking it, as they always did, so a differently cased name passes too.
      line(!a && !b && c && !d, f + ': the two original domains pass the host check, anything else is refused', { a, b, c, d });
    }
    // A configuration beside the web root replaces them.
    fs.writeFileSync(configFile, JSON.stringify({ hosts: ['a.example', 'b.example'] }));
    for (const f of users) {
      const a = await refused(f, 'a.example'), b = await refused(f, 'b.example'), c = await refused(f, 'evtec.co.za');
      line(!a && !b && c, f + ': after a configuration file, its hosts pass and the original domains are refused', { a, b, c });
    }
    // An invalid configuration refuses everything.
    fs.writeFileSync(configFile, '{broken');
    for (const f of users) {
      const a = await refused(f, 'evtec.co.za'), b = await refused(f, 'a.example');
      line(a && b, f + ': an invalid configuration refuses every host', { a, b });
    }
    const direct = await request('lib/hosts', 'evtec.co.za');
    line(direct.status === 404 && direct.body === '', 'the library answers a direct request with a 404 and nothing else', direct);
    const created = fs.readdirSync(root).concat(fs.readdirSync(path.join(work, 'chainblock-labs-private'))).filter((n) => /sqlite|\.db$/.test(n));
    line(created.length === 0, 'none of those requests created a database', created);
  } finally {
    server.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
labs().then(() => {
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS CONFIG CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
});
