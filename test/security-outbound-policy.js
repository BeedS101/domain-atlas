// The Node issuer's policy for requests to other domains (issuer-server/lib-outbound.js): which peers are acceptable,
// which addresses a connection may use, and how a request behaves (pinned address, TLS, no redirects, size and time
// limits, rate limits, client-safe errors). Uses local servers and an injected resolver only; nothing leaves this machine.
//
// Run: node test/security-outbound-policy.js
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createOutbound, OutboundError, isPublicAddress, parsePeer, createRateLimiter } = require('../issuer-server/lib-outbound');
const vectors = require('./support/outbound-vectors.json');

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 240))); }
}
const accepts = (text, local) => { try { parsePeer(text, local); return true; } catch (e) { return false; } };
const PUBLIC = '93.184.216.34';

function makeCerts(dir, names) {
  const sh = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  sh(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Test CA', '-days', '2']);
  sh(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=' + names[0]]);
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=' + names.map((n) => 'DNS:' + n).join(',') + '\n');
  sh(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext.cnf']);
  return { ca: fs.readFileSync(path.join(dir, 'ca.pem')), key: fs.readFileSync(path.join(dir, 'leaf.key')), cert: fs.readFileSync(path.join(dir, 'leaf.pem')) };
}
const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
const rejection = async (promise) => { try { await promise; return null; } catch (e) { return e; } };

(async () => {
  console.log('--- which peers are acceptable ---');
  for (const text of vectors.production.accept) check('production accepts ' + JSON.stringify(text), accepts(text, false));
  for (const text of vectors.production.reject) check('production rejects ' + JSON.stringify(text), !accepts(text, false), text);
  for (const value of vectors.production.rejectNonStrings) check('production rejects non-string ' + JSON.stringify(value), !accepts(value, false) && !accepts(value, true));
  for (const text of vectors.local.accept) check('a local development server accepts ' + JSON.stringify(text), accepts(text, true));
  for (const text of vectors.local.reject) check('a local development server rejects ' + JSON.stringify(text), !accepts(text, true), text);
  check('production never accepts a loopback peer', ['localhost:8001', '127.0.0.1:8001', '[::1]:8001'].every((t) => !accepts(t, false)));

  console.log('--- which addresses a connection may use ---');
  for (const ip of vectors.addresses.public) check('public address ' + ip, isPublicAddress(ip) === true);
  for (const ip of vectors.addresses.nonPublic) check('non-public address ' + JSON.stringify(ip), isPublicAddress(ip) === false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-outbound-'));
  const tls = makeCerts(dir, ['peer-a.example', 'peer-b.example']);
  const hits = [];
  let behave = 'ok';
  const handler = (req, res) => {
    hits.push(req.url);
    if (behave === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); return res.end(); }
    if (behave === 'hang') return;
    if (behave === 'huge-declared') { res.writeHead(200, { 'content-length': String(9 * 1024 * 1024) }); return res.end('x'); }
    if (behave === 'huge-streamed') { res.writeHead(200); return res.end('x'.repeat(5 * 1024 * 1024)); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ publicKey: 'k', validFrom: '2020-01-01T00:00:00Z' }], host: req.headers.host }));
  };
  const tlsServer = https.createServer({ key: tls.key, cert: tls.cert }, handler);
  const tlsPort = await listen(tlsServer);
  const plainServer = http.createServer(handler);
  const plainPort = await listen(plainServer);
  const dialTo = (port, withCa) => (peer, pinned) => ({ host: '127.0.0.1', port, ca: withCa ? tls.ca : undefined, pinned: pinned.address });
  const prod = (extra) => createOutbound(Object.assign({ ownDomain: 'issuer.example', env: { ATLAS_OUTBOUND_RATE_WINDOW_MS: '60000' }, resolve: async () => [{ address: PUBLIC, family: 4 }], dial: dialTo(tlsPort, true) }, extra || {}));

  try {
    console.log('--- normal https federation between two domains ---');
    behave = 'ok';
    let res = await prod().request('peer-a.example', '/.well-known/atlas-key.json', { kind: 'key' });
    check('a public peer with a valid certificate answers', res.status === 200 && res.json().keys.length === 1, res.status);
    check('the request carries the peer\'s own host name', res.json().host === 'peer-a.example', res.json());
    res = await prod().request('peer-b.example', '/atlas/postoffice/relay', { method: 'POST', body: { hello: 'world' } });
    check('a JSON POST to the second domain works the same way', res.status === 200, res.status);
    const wrongName = await rejection(prod({ resolve: async () => [{ address: PUBLIC, family: 4 }] }).request('peer-c.example', '/x'));
    check('a certificate that does not name the peer is refused', wrongName instanceof OutboundError && wrongName.code === 'unreachable', wrongName && wrongName.message);
    const untrusted = await rejection(prod({ dial: dialTo(tlsPort, false) }).request('peer-a.example', '/x'));
    check('a certificate from an untrusted authority is refused', untrusted instanceof OutboundError && untrusted.code === 'unreachable', untrusted && untrusted.message);

    console.log('--- destinations the policy refuses before connecting ---');
    const before = hits.length;
    const bad = [['http://127.0.0.1:' + plainPort, 'a URL'], ['127.0.0.1:' + plainPort, 'loopback'], ['localhost:' + plainPort, 'localhost'], ['169.254.169.254', 'the metadata address'], ['10.0.0.5', 'a private address'], ['metadata.google.internal', 'the metadata name'], ['user@peer-a.example', 'userinfo'], ['peer-a.example/x', 'a path']];
    for (const [peer, what] of bad) {
      const err = await rejection(prod().request(peer, '/.well-known/atlas-key.json'));
      check('production refuses ' + what, err instanceof OutboundError && err.code === 'peer-invalid' && !/10\.0\.0|127\.0|169\.254/.test(err.message.replace(peer, '')), err && [err.code, err.message]);
    }
    check('none of those reached a server', hits.length === before);
    const internalName = await rejection(prod({ resolve: async () => [{ address: '10.1.2.3', family: 4 }] }).request('looks-public.example', '/x'));
    check('a public-looking name that resolves to a private address is refused', internalName && internalName.code === 'peer-invalid' && !/10\.1\.2\.3/.test(internalName.message), internalName && internalName.message);
    const mixed = await rejection(prod({ resolve: async () => [{ address: PUBLIC, family: 4 }, { address: '127.0.0.1', family: 4 }] }).request('mixed.example', '/x'));
    check('a name with one public and one internal address is refused', mixed && mixed.code === 'peer-invalid');
    const v6 = await rejection(prod({ resolve: async () => [{ address: '::1', family: 6 }] }).request('v6.example', '/x'));
    check('a name that resolves to ::1 is refused', v6 && v6.code === 'peer-invalid');
    const mapped = await rejection(prod({ resolve: async () => [{ address: '::ffff:169.254.169.254', family: 6 }] }).request('mapped.example', '/x'));
    check('a name that resolves to an IPv4-mapped metadata address is refused', mapped && mapped.code === 'peer-invalid');
    const noAnswer = await rejection(prod({ resolve: async () => [] }).request('nothing.example', '/x'));
    check('a name that does not resolve is refused as unreachable', noAnswer && noAnswer.code === 'unreachable');

    console.log('--- DNS rebinding: the address that was checked is the address connected to ---');
    let call = 0; const dialed = [];
    const rebinding = createOutbound({ ownDomain: 'issuer.example', env: {}, resolve: async () => (++call === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]), dial: (peer, pinned) => { dialed.push(pinned.address); return dialTo(tlsPort, true)(peer, pinned); } });
    await rebinding.request('peer-a.example', '/x');
    const second = await rejection(rebinding.request('peer-a.example', '/x'));
    check('the connection is made to the address that passed the check', dialed.length === 1 && dialed[0] === PUBLIC, dialed);
    check('a later answer pointing inside is refused, and nothing is dialed for it', second && second.code === 'peer-invalid' && dialed.length === 1);
    check('the name is resolved once per request', call === 2);

    console.log('--- redirects, size, time ---');
    behave = 'redirect';
    let hitsBefore = hits.length;
    let err = await rejection(prod().request('peer-a.example', '/x'));
    check('a redirect is refused, not followed', err && err.code === 'redirect-refused' && hits.length === hitsBefore + 1, err && err.code);
    behave = 'huge-declared';
    err = await rejection(prod({ env: { ATLAS_OUTBOUND_MAX_BYTES: String(1024 * 1024) } }).request('peer-a.example', '/x'));
    check('a response that declares too much is refused', err && err.code === 'too-large', err && err.code);
    behave = 'huge-streamed';
    err = await rejection(prod({ env: { ATLAS_OUTBOUND_MAX_BYTES: String(1024 * 1024) } }).request('peer-a.example', '/x'));
    check('a response that streams past the limit is cut off', err && err.code === 'too-large', err && err.code);
    behave = 'hang';
    const t0 = Date.now();
    err = await rejection(prod({ env: { ATLAS_OUTBOUND_TIMEOUT_MS: '700' } }).request('peer-a.example', '/x'));
    check('a peer that never answers times out', err && err.code === 'timeout' && Date.now() - t0 < 4000, err && err.code);
    behave = 'ok';
    const refusedPort = await rejection(prod({ dial: () => ({ host: '127.0.0.1', port: 1, ca: tls.ca }) }).request('peer-a.example', '/x'));
    check('a refused connection gives a client-safe message', refusedPort && refusedPort.message === 'could not reach peer-a.example' && /ECONNREFUSED/.test(refusedPort.detail || ''), refusedPort && [refusedPort.message, refusedPort.detail]);

    console.log('--- rate limits count attempts, failures included ---');
    const limited = prod({ env: { ATLAS_OUTBOUND_KEY_RATE: '3', ATLAS_OUTBOUND_KEY_RATE_ALL: '5', ATLAS_OUTBOUND_RATE_WINDOW_MS: '60000' } });
    hitsBefore = hits.length;
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await rejection(limited.request('peer-a.example', '/.well-known/atlas-key.json', { kind: 'key' })));
    check('the fourth key lookup for one domain is refused before connecting', outcomes[3] && outcomes[3].code === 'rate-limited' && outcomes[4] && outcomes[4].code === 'rate-limited' && hits.length === hitsBefore + 3, outcomes.map((o) => o && o.code));
    check('the refusal says nothing about the network', outcomes[3] && !/\d+\.\d+\.\d+\.\d+/.test(outcomes[3].message));
    const others = [];
    for (let i = 0; i < 3; i++) others.push(await rejection(limited.request('peer-b.example', '/.well-known/atlas-key.json', { kind: 'key' })));
    check('another domain has its own budget until the overall budget is spent', others[0] === null && others[1] === null && others[2] && others[2].code === 'rate-limited', others.map((o) => o && o.code));
    const failing = prod({ env: { ATLAS_OUTBOUND_KEY_RATE: '2', ATLAS_OUTBOUND_KEY_RATE_ALL: '50' }, dial: () => ({ host: '127.0.0.1', port: 1, ca: tls.ca }) });
    const failedAttempts = [];
    for (let i = 0; i < 4; i++) failedAttempts.push((await rejection(failing.request('dead.example', '/x', { kind: 'key' }))).code);
    check('failed lookups use up the budget too', failedAttempts.join() === 'unreachable,unreachable,rate-limited,rate-limited', failedAttempts);
    const manyDomains = prod({ env: { ATLAS_OUTBOUND_KEY_RATE: '5', ATLAS_OUTBOUND_KEY_RATE_ALL: '6' }, dial: () => ({ host: '127.0.0.1', port: 1, ca: tls.ca }) });
    const codes = [];
    for (let i = 0; i < 9; i++) codes.push((await rejection(manyDomains.request('made-up-' + i + '.example', '/x', { kind: 'key' }))).code);
    check('a flood of made-up domains hits the overall budget', codes.slice(0, 6).every((c) => c === 'unreachable') && codes.slice(6).every((c) => c === 'rate-limited'), codes);

    console.log('--- budgets are shared out between callers and kinds of operation ---');
    // 20 per domain and 120 overall for three classes, with a 15% reserve (a slice of 3 per domain, 18 overall and as each class's floor).
    const fairLimiter = (opts) => createRateLimiter(60000, 20, 120, Object.assign({ reserve: 0.15, share: 0.25, classes: ['verify', 'drop', 'relay'] }, opts));
    const grants = (take, n, who, klass, domain) => { let ok = 0; for (let i = 0; i < n; i++) if (take(typeof domain === 'function' ? domain(i) : domain, 0, who, klass)) ok++; return ok; };
    let lim = fairLimiter();
    check('a caller that keeps asking for one domain is stopped before that domain\'s budget is gone', grants(lim, 100, 'abuser', 'verify', 'a.example') === 17);
    check('so another caller still has the reserved slice for that domain', grants(lim, 10, 'other', 'verify', 'a.example') === 3);
    check('and the same domain\'s budget for another kind of operation is untouched (its own caller limit still applies)', grants(lim, 30, 'other', 'relay', 'a.example') === 17);
    lim = fairLimiter();
    check('one kind of operation cannot take more than the overall budget less the others\' floors', grants(lim, 400, 'abuser', 'verify', (i) => 'd' + i + '.example') === 84);
    check('the other kinds can still be served after it', grants(lim, 5, 'other', 'drop', 'x.example') === 5 && grants(lim, 5, 'other', 'relay', 'y.example') === 5);
    lim = fairLimiter();
    const spread = ['verify', 'drop', 'relay'];
    let taken = 0;
    for (let i = 0; i < 400; i++) if (lim('d' + i + '.example', 0, 'c' + (i % 40), spread[i % 3])) taken++;
    check('however many callers there are, the overall budget is never exceeded', taken === 120, taken);
    lim = fairLimiter();
    check('work with no caller (this server\'s own) is not held to the fair share', grants(lim, 100, null, 'relay', 'a.example') === 20);
    lim = fairLimiter({ reserve: 0 });
    check('with the reserve turned off the budgets are plain caps again', grants(lim, 100, 'abuser', 'verify', 'a.example') === 20 && grants(lim, 400, 'abuser', 'verify', (i) => 'd' + i + '.example') === 100);
    lim = createRateLimiter(60000, 3, 5, { reserve: 0.15, share: 0.25, classes: ['key'] });
    check('a budget too small for a whole reserved slice is unchanged', grants(lim, 10, 'someone', 'key', 'a.example') === 3 && grants(lim, 10, 'someone', 'key', (i) => 'e' + i + '.example') === 2);
    lim = fairLimiter();
    grants(lim, 100, 'abuser', 'verify', 'a.example');
    check('a spent budget is available again once the window has passed', lim('a.example', 61000, 'abuser', 'verify') === true);

    console.log('--- local development ---');
    const dev = createOutbound({ ownDomain: 'localhost:8001', env: {} });
    behave = 'ok';
    res = await dev.request('localhost:' + plainPort, '/.well-known/atlas-key.json');
    check('a local development server reaches a loopback peer over http', res.status === 200, res.status);
    res = await dev.request('127.0.0.1:' + plainPort, '/.well-known/atlas-key.json');
    check('including by address', res.status === 200, res.status);
    err = await rejection(dev.request('10.0.0.5', '/x'));
    check('but still refuses a private address', err && err.code === 'peer-invalid');
    err = await rejection(dev.request('http://localhost:' + plainPort, '/x'));
    check('and still refuses a URL', err && err.code === 'peer-invalid');
    const wrongOwn = createOutbound({ ownDomain: 'issuer.example', env: {} });
    hitsBefore = hits.length;
    err = await rejection(wrongOwn.request('localhost:' + plainPort, '/x'));
    check('a server with a public domain never reaches loopback', err && err.code === 'peer-invalid' && hits.length === hitsBefore);
    check('local mode follows its configured domain, or an explicit setting', createOutbound({ ownDomain: 'issuer.example', env: { ATLAS_ALLOW_LOCAL_PEERS: '1' } }).allowLocal === true && createOutbound({ ownDomain: 'localhost:8001', env: { ATLAS_ALLOW_LOCAL_PEERS: '0' } }).allowLocal === false);

    console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  } finally {
    tlsServer.closeAllConnections && tlsServer.closeAllConnections(); plainServer.closeAllConnections && plainServer.closeAllConnections();
    tlsServer.close(); plainServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
