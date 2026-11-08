// Abuse limits of the installed verifier endpoint (verify.php). Everything runs from the built archive against a
// throw-away issuer-php; what the issuer received is counted, because the cost of a request to the endpoint is mostly
// the requests it makes to the issuer.
//
//   node test/verifier-endpoint-abuse.js
//
// Cost model checked here: a request that never reaches a trusted issuer costs it nothing; a credential that fails
// before its signature check costs one small request (the key document); only a correctly signed credential costs the
// full three. Access control (token) is answered before the body is read or the issuer is contacted.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { startIssuer, freePort } = require('./lib/php-issuer');
const { newOwner } = require('./lib/owner-auth');
const { manifest, buildPackage, extractPackage, writeConfig, servePhp, postJson, sleep } = require('./lib/package-install');

let failures = 0;
let total = 0;
function line(ok, text, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const cleanup = [];

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-verify-abuse-'));
  cleanup.push(() => fs.rmSync(work, { recursive: true, force: true }));
  const zip = buildPackage(path.join(work, 'build'));
  const issuer = await startIssuer();
  cleanup.push(() => issuer.stop());
  const owner = newOwner();
  const credential = await issuer.issue(owner, 'atlas.badge');
  const issuerCalls = () => issuer.requests.filter((r) => r.path.startsWith('/.well-known/')).length;
  const callsDuring = async (fn) => { const before = issuerCalls(); const out = await fn(); await sleep(60); return { out, calls: issuerCalls() - before }; };

  async function install(name, config, options) {
    const dir = extractPackage(zip, path.join(work, name));
    writeConfig(dir, Object.assign({ trustedIssuers: [issuer.origin], allowInsecureLoopback: true }, config || {}));
    const server = await servePhp(dir, await freePort(), Object.assign({ env: { PHP_CLI_SERVER_WORKERS: '4' } }, options || {}));
    cleanup.push(server.stop);
    return Object.assign(server, { post: (body, headers) => postJson(server.base + '/verify.php', body, headers) });
  }

  // ---- baseline cost of a request -------------------------------------------------------------------------------
  console.log('\n== what a request costs the issuer');
  const open = await install('open', {});
  const good = await callsDuring(() => open.post({ credential }));
  line(good.out.json && good.out.json.status === 'verified', 'a genuine credential verifies on the open endpoint');
  line(good.calls === 3, 'a genuine credential costs the issuer exactly three requests', good.calls);

  const tampered = JSON.parse(JSON.stringify(credential)); tampered.quantity = 2;
  const bad = await callsDuring(() => open.post({ credential: tampered }));
  line(bad.out.json.code === 'bad-signature' && bad.calls === 1, 'a credential with a bad signature stops after one request (the key document)', { code: bad.out.json.code, calls: bad.calls });

  const foreign = JSON.parse(JSON.stringify(credential)); foreign.issuer.domain = 'other.example';
  const untrusted = await callsDuring(() => open.post({ credential: foreign }));
  line(untrusted.out.json.status === 'untrusted-issuer' && untrusted.calls === 0, 'a credential naming another issuer costs the issuer nothing', untrusted.calls);

  const flood = await callsDuring(() => Promise.all(Array.from({ length: 40 }, (_, i) => open.post({ credential: i % 2 ? tampered : foreign }))));
  line(flood.out.every((r) => r.status === 200 && r.json && r.json.valid === false), '40 concurrent forged requests are all answered with a refusal', flood.out.map((r) => r.status).join(','));
  line(flood.calls === 20, 'the forged flood cost the issuer one request per signature-failing credential and none for the rest (' + flood.calls + ' for 20 tampered)', flood.calls);

  // ---- requests that never get as far as the issuer ----------------------------------------------------------------
  console.log('\n== malformed and oversize requests never reach the issuer');
  const cases = {
    'not JSON': 'nope',
    'JSON list': '[]',
    'JSON string': '"x"',
    'JSON null': 'null',
    'empty object': '{}',
    'credential of the wrong type': JSON.stringify({ credential: 'x' }),
    'nesting beyond the depth limit': '{"credential":' + '['.repeat(200) + ']'.repeat(200) + '}',
    'a 100 KiB expectIssuer': JSON.stringify({ credential, expectIssuer: 'https://' + 'a'.repeat(100000) + '.example' }),
    'expectIssuer that is not a string': JSON.stringify({ credential, expectIssuer: { a: 1 } }),
    'NUL bytes': '{"credential":"\u0000\u0000"}',
    'invalid UTF-8': Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])
  };
  for (const [label, body] of Object.entries(cases)) {
    const r = await callsDuring(() => fetch(open.base + '/verify.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(async (res) => ({ status: res.status, text: await res.text() })));
    let verdict = null; try { verdict = JSON.parse(r.out.text); } catch (e) { /* not JSON */ }
    line(r.out.status < 500 && verdict !== null && verdict.valid === false && r.calls === 0, label + ': a clean refusal and no request to the issuer', { status: r.out.status, calls: r.calls, text: r.out.text.slice(0, 120) });
  }

  const small = await install('small-limit', { maxBodyBytes: 2048 });
  const sized = async (bytes, server) => { const pad = 'x'.repeat(bytes); return callsDuring(() => (server || small).post(JSON.stringify({ credential, pad }))); };
  const over = await sized(5000);
  line(over.out.status === 413 && over.out.json.code === 'too-large' && over.calls === 0, 'a body over a configured maxBodyBytes is refused with 413 before anything is read or fetched', { status: over.out.status, calls: over.calls });
  const chunked = await callsDuring(() => new Promise((resolve) => {
    const req = http.request({ host: 'localhost', port: small.port, path: '/verify.php', method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
    req.on('error', () => resolve({ status: 0, text: '' }));
    req.write('{"credential":'); req.write('"' + 'x'.repeat(6000) + '"}'); req.end();
  }));
  line([400, 411, 413].includes(chunked.out.status) && chunked.calls === 0, 'a chunked body with no declared length is refused and costs the issuer nothing', { status: chunked.out.status, calls: chunked.calls });
  const lying = await callsDuring(() => new Promise((resolve) => {
    const socket = net.connect(small.port, 'localhost', () => {
      socket.write('POST /verify.php HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 10\r\nConnection: close\r\n\r\n' + '{"a":"' + 'y'.repeat(5000) + '"}');
    });
    let t = ''; socket.on('data', (c) => { t += c; }); socket.on('close', () => resolve(t)); socket.on('error', () => resolve(t));
  }));
  line(!/ 500 /.test(String(lying.out).split('\r\n')[0]) && lying.calls === 0, 'a body longer than its declared Content-Length does not cause a server error or any request', String(lying.out).split('\r\n')[0]);

  const clamped = await install('clamped', { maxBodyBytes: 1000000000 });
  const huge = await sized(1200000, clamped);
  line(huge.out.status === 413 && huge.calls === 0, 'a maxBodyBytes above 1 MiB is clamped to 1 MiB', { status: huge.out.status });
  for (const [label, value] of [['zero', 0], ['negative', -5], ['a string', '65536'], ['a float', 1.5], ['null', null]]) {
    const odd = await install('odd-limit-' + label.replace(/\W/g, ''), { maxBodyBytes: value });
    const r = await odd.post({ credential });
    line(r.status < 500 && r.json && typeof r.json.valid === 'boolean', 'maxBodyBytes ' + label + ' is handled without a server error (' + r.status + '/' + (r.json && r.json.status) + ')', r.text.slice(0, 120));
  }

  // ---- access control ---------------------------------------------------------------------------------------------
  console.log('\n== access token');
  const token = crypto.randomBytes(32).toString('base64url');
  const guarded = await install('guarded', { accessTokenSha256: sha(token) });
  const attempts = {
    'no header': {},
    'wrong token': { Authorization: 'Bearer ' + 'x'.repeat(43) },
    'the right token with a different scheme': { Authorization: 'Basic ' + token },
    'the right token, lower-case scheme': { Authorization: 'bearer ' + token },
    'the right token with trailing text': { Authorization: 'Bearer ' + token + ' extra' },
    'an empty token': { Authorization: 'Bearer ' },
    'a 100 KiB token': { Authorization: 'Bearer ' + 'a'.repeat(100000) },
    'the stored hash used as the token': { Authorization: 'Bearer ' + sha(token) }
  };
  for (const [label, headers] of Object.entries(attempts)) {
    const r = await callsDuring(() => guarded.post({ credential }, headers).catch(() => ({ status: 0 })));
    line([401, 400, 431, 0].includes(r.out.status) && r.out.status !== 200 && r.calls === 0, 'token rejected - ' + label + ' (' + r.out.status + '), issuer not contacted', { status: r.out.status, calls: r.calls });
  }
  const unauthBig = await callsDuring(() => guarded.post(JSON.stringify({ credential, pad: 'x'.repeat(900000) })));
  line(unauthBig.out.status === 401 && unauthBig.calls === 0, 'an unauthenticated oversize body is answered 401 and not processed');
  const unauthOptions = await fetch(guarded.base + '/verify.php', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  line(unauthOptions.status === 204 && unauthOptions.headers.get('access-control-allow-origin') === null, 'a preflight from an unlisted origin gets no CORS grant');
  const authed = await callsDuring(() => guarded.post({ credential }, { Authorization: 'Bearer ' + token }));
  line(authed.out.status === 200 && authed.out.json.status === 'verified' && authed.calls === 3, 'the right token is served normally');
  line(!JSON.stringify(authed.out.json).includes(token) && !authed.out.text.includes(sha(token)), 'neither the token nor its hash appears in a response');
  const brokenHash = await install('broken-hash', { accessTokenSha256: 'not-a-hash' });
  const lockedOut = await brokenHash.post({ credential }, { Authorization: 'Bearer ' + token });
  line(lockedOut.status === 401, 'a malformed accessTokenSha256 locks everyone out instead of opening the endpoint');
  for (const value of ['', false, 0, [], {}]) {
    const odd = await install('hash-' + crypto.randomBytes(3).toString('hex'), { accessTokenSha256: value });
    const r = await callsDuring(() => odd.post({ credential }, { Authorization: 'Bearer ' + token }));
    line(r.out.status === 401 && r.calls === 0, 'accessTokenSha256 ' + JSON.stringify(value) + ' is treated as a broken token setting: everyone is refused', { status: r.out.status, calls: r.calls });
  }

  // ---- methods ---------------------------------------------------------------------------------------------------
  console.log('\n== methods');
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const r = await callsDuring(() => fetch(open.base + '/verify.php', { method, body: '{}' }).then((res) => res.status));
    line(r.out === 405 && r.calls === 0, method + ' is refused with 405 and costs nothing', r.out);
  }
  const head = await callsDuring(() => fetch(open.base + '/verify.php', { method: 'HEAD' }).then((res) => res.status));
  line(head.out < 500 && head.calls === 0, 'HEAD costs the issuer nothing', head.out);
  const getInfo = await callsDuring(() => fetch(open.base + '/verify.php').then((res) => res.json()));
  line(getInfo.calls === 0 && getInfo.out.configured === true && JSON.stringify(Object.keys(getInfo.out).sort()) === JSON.stringify(['configured', 'package', 'trustedIssuers', 'version']), 'GET answers from configuration alone and exposes only package, version and the trusted origins');
  const unconfigured = await install('unconfigured-abuse', { trustedIssuers: [] });
  const refusedAll = await callsDuring(() => unconfigured.post({ credential }));
  line(refusedAll.out.status === 503 && refusedAll.calls === 0, 'an unusable configuration refuses everything with 503');
  const info = await (await fetch(unconfigured.base + '/verify.php')).json();
  line(info.configured === false && info.trustedIssuers.length === 0, 'and reports configured: false without listing anything');

  // ---- response size and hostile issuer content -----------------------------------------------------------------
  console.log('\n== a trusted issuer cannot inflate the answer');
  const revFile = path.join(issuer.dir, '.well-known', 'atlas-revocations.json');
  const susFile = path.join(issuer.dir, '.well-known', 'atlas-suspensions.json');
  const savedRevocations = fs.readFileSync(revFile);
  const victim = await issuer.issue(owner, 'atlas.badge');
  fs.writeFileSync(revFile, JSON.stringify({ revoked: [{ id: victim.id, revokedAt: '2026-01-01T00:00:00Z', reason: 'é'.repeat(300000) }] }));
  const long = await open.post({ credential: victim });
  fs.writeFileSync(revFile, savedRevocations);
  line(long.json && long.json.status === 'revoked' && long.text.length < 4000, 'a 300,000-character revocation reason is clipped in the verdict (' + long.text.length + ' bytes)', long.text.length);
  line(long.json !== null && !/�/.test(long.text), 'the clipped reason is still valid text');

  // ---- a slow or hostile issuer ---------------------------------------------------------------------------------
  console.log('\n== a slow or oversized upstream answer is bounded');
  let bytesSent = 0;
  const hostile = http.createServer((req, res) => {
    if (req.url.endsWith('atlas-key.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = 'x'.repeat(65536);
      const timer = setInterval(() => { if (res.destroyed || bytesSent > 64 * 1024 * 1024) { clearInterval(timer); res.end(); return; } bytesSent += chunk.length; res.write(chunk); }, 1);
      res.on('close', () => clearInterval(timer));
    } else {
      setTimeout(() => { try { res.end('{}'); } catch (e) { /* closed */ } }, 30000);
    }
  });
  await new Promise((r) => hostile.listen(0, '127.0.0.1', r));
  cleanup.push(() => hostile.close());
  const hostileDomain = 'localhost:' + hostile.address().port;
  const dir = extractPackage(zip, path.join(work, 'hostile-install'));
  writeConfig(dir, { trustedIssuers: ['http://' + hostileDomain], allowInsecureLoopback: true });
  const hostileServer = await servePhp(dir, await freePort(), { env: { PHP_CLI_SERVER_WORKERS: '4' } });
  cleanup.push(hostileServer.stop);
  const lure = JSON.parse(JSON.stringify(credential)); lure.issuer.domain = hostileDomain;
  const t0 = Date.now();
  const endless = await postJson(hostileServer.base + '/verify.php', { credential: lure });
  line(endless.json && endless.json.status === 'unavailable' && Date.now() - t0 < 8000, 'an endless key document is cut off at the size cap and answered "unavailable" quickly (' + (Date.now() - t0) + ' ms)', endless.text.slice(0, 160));
  line(bytesSent < 4 * 1024 * 1024, 'the verifier stopped reading after ' + Math.round(bytesSent / 1024) + ' KiB (cap 256 KiB)', bytesSent);

  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' ENDPOINT ABUSE CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
})().catch((err) => { failures++; console.error('FAILURE:', err); }).finally(async () => {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { /* already stopped */ } }
  process.exit(failures === 0 ? 0 : 1);
});
