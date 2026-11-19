// tools/owner-proof-live-check.js against local issuers: it probes an issuer that requires a signed request, leaves no credential,
// roster row, mail, replay record or journal entry behind, raises the refusal counters by exactly the number it prints, and does
// not send anything to an issuer that is not enforcing (an unsigned request there would be served).
//
// Both issuers run twice in require mode: with the origin protection on, as a live issuer runs (an unsigned request with no
// Origin header is refused as mint-origin-refused before the owner proof, and is not counted in its statistics), and with it
// off, as the other owner-proof tests run theirs (the owner proof refuses it, and counts it).
//
// Nothing here contacts a live domain.
// Run: node test/manual-owner-proof-live-check.js
'use strict';
const { execFileSync, spawn, spawnSync } = require('child_process');
const path = require('path');
const lib = require('./owner-proof-lib');

const TOOL = path.resolve(__dirname, '..', 'tools', 'owner-proof-live-check.js');
let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
};
const run = (args) => {
  const r = spawnSync('node', [TOOL].concat(args), { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch (e) { return null; } })() };
};
const refused = (inst) => Object.values((lib.readJson(inst.statsFile, {}).classes) || {}).reduce((n, c) => n + c.refused, 0);
const counted = (inst, k) => Object.values((lib.readJson(inst.statsFile, {}).classes) || {}).reduce((n, c) => n + c[k], 0);

(async () => {
  try {
    const nodeReq = await lib.startNode('lc-node-require', 8261, 'require', true);
    const phpReq = await lib.startPhp('lc-php-require', 8262, 'require', true);
    const nodeLoose = await lib.startNode('lc-node-require-open', 8265, 'require');
    const phpLoose = await lib.startPhp('lc-php-require-open', 8266, 'require');
    const nodeAccept = await lib.startNode('lc-node-accept', 8263, 'accept');
    const nodeOff = await lib.startNode('lc-node-off', 8264, 'off');

    const perClassRefused = (inst) => Object.fromEntries(Object.entries((lib.readJson(inst.statsFile, {}).classes) || {}).map(([k, v]) => [k, v.refused]));
    const STRICT_CODES = 'mint-origin-refused,mint-origin-refused,mint-origin-refused,owner-authorization-required,owner-authorization-required,owner-authorization-required,owner-authorization-required,not-owner,owner-signature-invalid,owner-authorization-required';
    const OPEN_CODES = 'owner-authorization-required,owner-authorization-required,owner-authorization-required,owner-authorization-required,owner-authorization-required,owner-authorization-required,owner-authorization-required,not-owner,owner-signature-invalid,owner-authorization-required';

    for (const inst of [nodeReq, phpReq]) {
      const label = inst.name + ' (origin protection on)';
      const before = lib.snapshot(inst);
      const r = run([inst.base, '--json']);
      const res = r.json && r.json.results[0];
      check(label + ': every probe is refused as expected and the run passes', r.code === 0 && res && res.ok && res.rows.length === 10 && res.rows.every((x) => x.pass), r.out.slice(0, 900));
      check(label + ': the tool reports the origin protection as on', res && res.originProtection === 'on', res && res.originProtection);
      check(label + ': unsigned requests are sent for all three membership classes, without an Origin and with the issuer\'s own', res && res.rows.filter((x) => x.group === 'originless').length === 3 && res.rows.filter((x) => x.group === 'own-origin').length === 3 && res.rows.filter((x) => /^unsigned/.test(x.name)).length === 6);
      check(label + ': refusal codes are the ones expected', res && res.rows.map((x) => x.code).join(',') === STRICT_CODES, res && res.rows.map((x) => x.code));
      check(label + ': no credential, roster row, welcome mail, replay record or journal entry was created', JSON.stringify(before) === JSON.stringify(lib.snapshot(inst)), { before, after: lib.snapshot(inst) });
      check(label + ': the tool says three refusals are counted, and the statistics rose by exactly that', refused(inst) === res.countedExpected && res.countedExpected === 3 && res.refusedExpected === 10, { refused: refused(inst), counted: res && res.countedExpected, refusedExpected: res && res.refusedExpected });
      check(label + ': the counted ones are the three unsigned requests with the issuer\'s own Origin, one per class', Object.values(perClassRefused(inst)).join() === '1,1,1' && Object.keys(perClassRefused(inst)).length === 3, perClassRefused(inst));
      check(label + ': the requests without an Origin header are not in the statistics (the signed ones included)', res.rows.filter((x) => !x.counted).length === 7 && res.rows.filter((x) => x.counted).every((x) => x.group === 'own-origin'));
      check(label + ': signed and unsigned counts did not move', counted(inst, 'signed') === 0 && counted(inst, 'unsigned') === 0);
      const text = run([inst.base]);
      check(label + ': the readable report says PASS and what to expect in the counters', text.code === 0 && /result: PASS/.test(text.out) && /counted in the owner-proof statistics: 3/.test(text.out) && /origin protection: on/.test(text.out) && /mint-origin-refused/.test(text.out), text.out.slice(0, 700));
      check(label + ': a second run adds three more, and nothing else', (() => { const again = run([inst.base, '--json']).json.results[0]; return again.ok && refused(inst) === 6 + 3; })());
    }

    for (const inst of [nodeLoose, phpLoose]) {
      const label = inst.name + ' (origin protection off)';
      const before = lib.snapshot(inst);
      const r = run([inst.base, '--json']);
      const res = r.json && r.json.results[0];
      check(label + ': every probe is refused as expected and the run passes', r.code === 0 && res && res.ok && res.rows.length === 10 && res.rows.every((x) => x.pass), r.out.slice(0, 900));
      check(label + ': the tool reports the origin protection as off, and the owner proof refuses what the origin check would have', res && res.originProtection === 'off' && res.rows.map((x) => x.code).join(',') === OPEN_CODES, res && res.rows.map((x) => x.code));
      check(label + ': every refusal is counted here, and the statistics rose by exactly that', res && res.countedExpected === 10 && refused(inst) === 10, { counted: res && res.countedExpected, refused: refused(inst) });
      check(label + ': nothing was created, and signed and unsigned counts did not move', JSON.stringify(before) === JSON.stringify(lib.snapshot(inst)) && counted(inst, 'signed') === 0 && counted(inst, 'unsigned') === 0);
    }

    for (const inst of [nodeAccept, nodeOff]) {
      const before = lib.snapshot(inst);
      const r = run([inst.base, '--json']);
      const res = r.json && r.json.results[0];
      check(inst.name + ': not probed, because an unsigned request would be served there', r.code === 1 && res && !res.probed && res.rows.length === 0 && !res.ok, r.out.slice(0, 400));
      check(inst.name + ': ...and nothing was created', JSON.stringify(before) === JSON.stringify(lib.snapshot(inst)) && counted(inst, 'unsigned') === 0 && counted(inst, 'signed') === 0);
    }

    // An issuer that behaves wrongly must fail the run, not be excused by the two accepted answers.
    const http = require('http');
    const stub = (handler) => new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'GET') return res.end(JSON.stringify({ requestIds: {}, ownerProof: { version: 1, operation: 'issue', classes: ['atlas.membership', 'atlas.postoffice.membership', 'atlas.tradingstation.membership'], mode: 'require' } }));
          const out = handler(req, body);
          res.statusCode = out.status;
          res.end(JSON.stringify(out.json));
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    // The stubs live in this process, so the tool is run without blocking it.
    const runAsync = (args) => new Promise((resolve) => {
      const p = spawn('node', [TOOL].concat(args));
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      p.on('close', (code) => resolve({ code, out, json: (() => { try { return JSON.parse(out); } catch (e) { return null; } })() }));
    });
    const originRefusal = { status: 403, json: { code: 'mint-origin-refused', error: 'minting is open to this domain\'s own pages only' } };
    const notRecognisingOwnOrigin = await stub(() => originRefusal);
    let seen = [];
    const servingOriginless = await stub((req) => { seen.push(req.headers.origin || null); return req.headers.origin ? { status: 403, json: { code: 'owner-authorization-required' } } : { status: 200, json: { credential: {} } }; });
    try {
      const wrongOwn = await runAsync(['http://127.0.0.1:' + notRecognisingOwnOrigin.address().port, '--json']);
      const wr = wrongOwn.json && wrongOwn.json.results[0];
      check('an issuer that refuses its own Origin as mint-origin-refused fails the run', wrongOwn.code === 1 && wr && !wr.ok && wr.rows.length === 10 && wr.rows.filter((x) => x.group === 'own-origin').length === 3 && wr.rows.filter((x) => x.group === 'own-origin').every((x) => !x.pass), wrongOwn.out.slice(0, 500));
      const serving = await runAsync(['http://127.0.0.1:' + servingOriginless.address().port, '--json']);
      const sr = serving.json && serving.json.results[0];
      check('an issuer that serves an unsigned request without an Origin fails the run and the tool stops at once', serving.code === 1 && sr && sr.issuedByMistake && !sr.ok && sr.rows.length === 1 && seen.length === 1, { code: serving.code, rows: sr && sr.rows.length, seen });
    } finally { notRecognisingOwnOrigin.close(); servingOriginless.close(); }

    const refusedBefore = refused(nodeReq);
    const ro = run([nodeReq.base, '--read-only', '--json']);
    check('--read-only reads the capabilities and sends nothing', ro.code === 0 && ro.json.results[0].rows.length === 0 && refused(nodeReq) === refusedBefore, { code: ro.code, before: refusedBefore, after: refused(nodeReq) });

    const bad = run(['http://example.com', '--json']);
    check('plain http to a non-loopback host is refused before anything is sent', bad.code === 1 && bad.json.results[0].base === null);
    const two = run([nodeReq.base, nodeAccept.base, '--json']);
    check('two domains in one run: one passes, one is reported as not enforcing, exit code 1', two.code === 1 && two.json.results.length === 2 && two.json.results[0].ok && !two.json.results[1].ok);
    const none = spawnSync('node', [TOOL], { encoding: 'utf8' });
    check('no domain given: usage and exit code 2', none.status === 2 && /usage/.test(none.stderr));
  } catch (err) {
    failures++;
    console.log('FAIL unexpected error :: ' + (err && err.stack ? err.stack : err));
  } finally {
    lib.stopAll();
  }
  console.log(failures ? failures + ' check(s) failed' : 'owner proof live check: all passed');
  process.exit(failures ? 1 : 0);
})();
