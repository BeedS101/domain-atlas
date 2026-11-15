// Wallet-facing domain references: one validator (AtlasWallet.domainProblem) and one place a domain becomes a request
// address (AtlasWallet.baseUrl). Legitimate bare hosts with optional ports keep working, with https for public names
// and plain http only for loopback and approved development hosts; anything URL-shaped, deceptive or ambiguous is
// refused before any request is made.
//
// Loads extension/wallet.js in a vm with a recording fetch; no browser, no network.
//
//   node test/wallet-domain-validation.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log('PASS ' + name); } else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); }
};

function load() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'extension', 'wallet.js'), 'utf8');
  const store = {};
  const requests = [];
  const ctx = {
    console, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, btoa, atob,
    crypto: require('crypto').webcrypto,
    chrome: { storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => { Object.assign(store, o); }, remove: async () => {} }, onChanged: { addListener() {} } }, runtime: {} },
    navigator: {},
    fetch: async (url) => { requests.push(String(url)); throw new Error('network is not available in this test'); }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src + '\n;globalThis.__W = AtlasWallet;', ctx);
  return { W: ctx.__W, store, requests };
}

const accepted = {
  'localhost': 'http://localhost',
  'localhost:8001': 'http://localhost:8001',
  '127.0.0.1:18020': 'http://127.0.0.1:18020',
  '127.0.0.1': 'http://127.0.0.1',
  '[::1]:8080': 'http://[::1]:8080',
  'dev.localhost:3000': 'http://dev.localhost:3000',
  'example.com': 'https://example.com',
  'sub.example.co.za': 'https://sub.example.co.za',
  'EXAMPLE.COM:8443': 'https://example.com:8443',
  'a-b.example.org': 'https://a-b.example.org',
  'xn--bcher-kva.example': 'https://xn--bcher-kva.example',
  'httpevil.example': 'https://httpevil.example',
  'httpbin.org': 'https://httpbin.org',
  'example.com:443': 'https://example.com:443',
  'example.com:65535': 'https://example.com:65535',
  '203.0.113.9': 'https://203.0.113.9',
  '1.1.1.1:8443': 'https://1.1.1.1:8443',
  ['a'.repeat(63) + '.example']: 'https://' + 'a'.repeat(63) + '.example'
};

const rejected = [
  // schemes, paths, credentials, queries, fragments
  'https://example.com', 'http://localhost:8001', 'HTTPS://example.com', 'http:evil.example', '//evil.example', 'ftp://example.com',
  'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome-extension://abc/x',
  'example.com/', 'example.com/path', 'example.com/..', 'example.com?x=1', 'example.com#frag', 'example.com:8080/atlas', 'localhost:8001/',
  'user@example.com', 'user:pw@example.com', 'http@host', 'example.com@evil.example', 'localhost:8001@evil.example', 'localhost#@evil.example',
  'evil.example\\@example.com', 'example.com\\evil', 'example.com;evil', 'example.com,evil.example', 'a.example b.example',
  // whitespace, control characters, escapes, non-ASCII
  ' example.com', 'example.com ', 'exa mple.com', 'example.com\n', 'example.com\t', '\u0000', 'example.com\u0000.evil.example',
  'example.com%2f', '%65xample.com', 'example.com%00', 'exämple.com', 'example。com', 'ｅxample.com', 'example.com‮', 'example​.com',
  // ports
  'example.com:', 'example.com:0', 'example.com:65536', 'example.com:080', 'example.com:80:80', 'example.com:abc', 'example.com:-1', 'example.com:99999999',
  // hostnames that are not hostnames
  '', '.', '.example.com', 'example.com.', 'example..com', '-a.example', 'a-.example', 'a_b.example', '*.example.com', 'exa*mple.com', 'a'.repeat(64) + '.example',
  ('a'.repeat(60) + '.').repeat(5) + 'example',
  // numeric shorthand and addresses the URL parser would rewrite
  '127.1', '2130706433', '0x7f.0.0.1', '0x7f000001', '017700000001', '0177.0.0.1', '127.0.0.1.', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '4294967296',
  // loopback look-alikes, other loopback, IPv6
  '127.0.0.2', '127.255.255.254', '[::2]', '[::ffff:127.0.0.1]', '[fe80::1]', '[::1', '::1', '[::1]x', '[0:0:0:0:0:0:0:1]',
  // private, link-local and reserved addresses need an explicit development approval
  '10.0.0.5', '192.168.1.1:80', '169.254.169.254', '172.16.0.1', '172.31.255.255', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
  // single-label names
  'intranet', 'router:8080', 'printer', 'metadata',
  // key-anchored manifests have no domain; their label must never reach a request
  'key:3a4f9c2d1b7e',
  // not strings
  null, undefined, 123, true, {}, [], ['example.com'], { toString() { return 'https://evil.example'; } }, () => 'example.com',
  'a'.repeat(300)
];

function run() {
  // 1. accepted forms and the exact address they become
  {
    const { W } = load();
    for (const [input, expected] of Object.entries(accepted)) {
      let got, problem = 'threw';
      try { got = W.baseUrl(input); problem = W.domainProblem(input); } catch (e) { got = 'ERR ' + e.message; }
      check('accepts ' + JSON.stringify(input.length > 40 ? input.slice(0, 20) + '…' : input) + ' as ' + (expected.length > 50 ? expected.slice(0, 30) + '…' : expected), got === expected && problem === null, { got, problem });
    }
  }

  // 2. everything else is refused, with no request made
  {
    const { W, requests } = load();
    for (const input of rejected) {
      let threw = null;
      try { W.baseUrl(input); } catch (e) { threw = e; }
      const label = typeof input === 'string' ? JSON.stringify(input.length > 40 ? input.slice(0, 20) + '…(' + input.length + ')' : input) : Object.prototype.toString.call(input) + ':' + String(typeof input);
      check('refuses ' + label, !!threw && threw.code === 'bad-domain' && (typeof input !== 'string' || W.domainProblem(input) !== null), threw && threw.message);
    }
    check('refusing a domain made no request', requests.length === 0, requests);
  }

  // 3. every wallet path that takes a domain refuses before any request
  return (async () => {
    const { W, requests } = load();
    const bad = ['https://evil.example/x', 'evil.example/atlas', 'user@evil.example', 'http@host', '127.1', '10.0.0.5', 'key:3a4f9c2d1b7e'];
    const calls = {
      fetchTradeListings: (d) => W.fetchTradeListings(d),
      fetchTradableClasses: (d) => W.fetchTradableClasses(d),
      fetchDomainCalendar: (d) => W.fetchDomainCalendar(d, null),
      fetchDomainManifest: (d) => W.fetchDomainManifest(d),
      fetchAssetClassInfo: (d) => W.fetchAssetClassInfo(d, 'atlas.element.gold'),
      studioUrl: (d) => W.studioUrl(d)
    };
    for (const [name, call] of Object.entries(calls)) {
      if (typeof W[name] !== 'function') { check(name + ' is exported', false); continue; }
      let refused = 0;
      for (const d of bad) { try { await call(d); } catch (e) { if (e.code === 'bad-domain') refused++; } }
      check(name + ' refuses all ' + bad.length + ' malformed domains', refused === bad.length, refused);
    }
    check('no request left the wallet for any malformed domain', requests.length === 0, requests);

    // A credential that names a URL-shaped issuer is "unavailable", never fetched.
    const verdict = await W.verifyCredential({ credential: 'domain-atlas-asset/1.0', id: 'x', issuer: { domain: 'https://evil.example/' + 'a', publicKey: 'k' }, asset: { class: 'c' }, owner: { publicKey: 'o' }, signature: 's', issuedAt: '2026-01-01T00:00:00Z' });
    check('verifying a credential that names a URL as its issuer is refused without a request', verdict && verdict.valid === false && requests.length === 0, { verdict, requests });

    // Legitimate domains reach exactly the intended host.
    for (const [d, origin] of [['example.com', 'https://example.com'], ['localhost:8001', 'http://localhost:8001'], ['127.0.0.1:18000', 'http://127.0.0.1:18000']]) {
      requests.length = 0;
      await W.fetchTradeListings(d).catch(() => null);
      check('a request for ' + d + ' goes to ' + origin + '/atlas/trade/listings', requests.length === 1 && requests[0] === origin + '/atlas/trade/listings', requests);
    }
    requests.length = 0;
    await W.fetchTradeListings('httpevil.example').catch(() => null);
    check('a host that merely starts with "http" is a host, not a URL', requests.length === 1 && requests[0] === 'https://httpevil.example/atlas/trade/listings', requests);

    // Development hosts: explicit, exact, persisted, and removable.
    {
      const t = load();
      check('a private address is refused until approved', t.W.domainProblem('10.0.0.5:8080') !== null);
      check('approving rejects a URL-shaped entry', await t.W.approveDevelopmentHost('http://10.0.0.5:8080').then(() => false, () => true));
      check('approving rejects a non-string entry', await t.W.approveDevelopmentHost({}).then(() => false, () => true));
      const list = await t.W.approveDevelopmentHost('10.0.0.5:8080');
      check('an approved private address is used over plain http', t.W.baseUrl('10.0.0.5:8080') === 'http://10.0.0.5:8080' && list.length === 1, list);
      check('approval is for that host and port only', t.W.domainProblem('10.0.0.5:9090') !== null && t.W.domainProblem('10.0.0.5') !== null && t.W.domainProblem('10.0.0.6:8080') !== null);
      await t.W.approveDevelopmentHost('intranet:8000');
      check('an approved single-label name is used over plain http', t.W.baseUrl('intranet:8000') === 'http://intranet:8000' && t.W.domainProblem('intranet') !== null);
      await t.W.approveDevelopmentHost('staging.example.com:8443');
      check('an approved public name is used over plain http (development environment)', t.W.baseUrl('staging.example.com:8443') === 'http://staging.example.com:8443' && t.W.baseUrl('staging.example.com') === 'https://staging.example.com');
      check('approvals are stored for the next page load', JSON.stringify(t.store.atlasDevHosts) === JSON.stringify(['10.0.0.5:8080', 'intranet:8000', 'staging.example.com:8443']), t.store.atlasDevHosts);
      await t.W.removeDevelopmentHost('10.0.0.5:8080');
      check('removing an approval restores the refusal', t.W.domainProblem('10.0.0.5:8080') !== null);
      // A stored list with hostile or malformed entries is cleaned on load, never trusted.
      const fs2 = load();
      fs2.store.atlasDevHosts = ['https://evil.example', '10.1.1.1:80', 'x@y', 5, null, '10.1.1.1:80'];
      const reloaded = (() => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', 'extension', 'wallet.js'), 'utf8');
        const ctx = { console, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, btoa, atob, crypto: require('crypto').webcrypto, navigator: {}, fetch: async () => { throw new Error('x'); },
          chrome: { storage: { local: { get: async (k) => ({ [k]: fs2.store[k] }), set: async () => {} }, onChanged: { addListener() {} } }, runtime: {} } };
        ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(src + '\n;globalThis.__W = AtlasWallet;', ctx); return ctx.__W;
      })();
      const stored = await reloaded.getDevelopmentHosts();
      check('a stored list is filtered to valid host[:port] entries on load', JSON.stringify(stored) === JSON.stringify(['10.1.1.1:80']), stored);
    }

    // A saved reference keeps its meaning: the same strings that worked before reach the same origins.
    const saved = ['localhost:8001', 'localhost:8002', '127.0.0.1:8080', 'example.com', 'evtec.example', 'domain-atlas.example', 'a.b.c.example:8443'];
    check('existing saved domain references keep their origin', saved.every((d) => W.baseUrl(d) === ((/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(d) ? 'http://' : 'https://') + d)), saved.map((d) => W.baseUrl(d)));
  })();
}

run().then(() => {
  console.log('\nwallet domain validation: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(2); });
