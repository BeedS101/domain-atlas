// tools/owner-proof-live-check.js against local issuers: it probes an issuer that requires a signed request, leaves no credential,
// roster row, mail, replay record or journal entry behind, raises the refusal counters by exactly the number it prints, and does
// not send anything to an issuer that is not enforcing (an unsigned request there would be served).
//
// Nothing here contacts a live domain.
// Run: node test/manual-owner-proof-live-check.js
'use strict';
const { execFileSync, spawnSync } = require('child_process');
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
    const nodeReq = await lib.startNode('lc-node-require', 8261, 'require');
    const phpReq = await lib.startPhp('lc-php-require', 8262, 'require');
    const nodeAccept = await lib.startNode('lc-node-accept', 8263, 'accept');
    const nodeOff = await lib.startNode('lc-node-off', 8264, 'off');

    for (const inst of [nodeReq, phpReq]) {
      const before = lib.snapshot(inst);
      const r = run([inst.base, '--json']);
      const res = r.json && r.json.results[0];
      check(inst.name + ': every probe is refused as expected and the run passes', r.code === 0 && res && res.ok && res.rows.length === 7 && res.rows.every((x) => x.pass), r.out.slice(0, 600));
      check(inst.name + ': the unsigned requests are refused for all three membership classes', res && res.rows.filter((x) => /^unsigned/.test(x.name)).length === 3);
      check(inst.name + ': ' + 'refusal codes are the ones expected', res && res.rows.map((x) => x.code).join(',') === 'owner-authorization-required,owner-authorization-required,owner-authorization-required,owner-authorization-required,not-owner,owner-signature-invalid,owner-authorization-required', res && res.rows.map((x) => x.code));
      check(inst.name + ': no credential, roster row, welcome mail, replay record or journal entry was created', JSON.stringify(before) === JSON.stringify(lib.snapshot(inst)), { before, after: lib.snapshot(inst) });
      check(inst.name + ': the refusal counters rose by the number the tool reports', refused(inst) === res.refusedExpected && res.refusedExpected === 7, { refused: refused(inst), reported: res && res.refusedExpected });
      check(inst.name + ': signed and unsigned counts did not move', counted(inst, 'signed') === 0 && counted(inst, 'unsigned') === 0);
      const text = run([inst.base]);
      check(inst.name + ': the readable report says PASS', text.code === 0 && /result: PASS/.test(text.out) && /refusals that should now be counted: 7/.test(text.out), text.out.slice(0, 400));
    }

    for (const inst of [nodeAccept, nodeOff]) {
      const before = lib.snapshot(inst);
      const r = run([inst.base, '--json']);
      const res = r.json && r.json.results[0];
      check(inst.name + ': not probed, because an unsigned request would be served there', r.code === 1 && res && !res.probed && res.rows.length === 0 && !res.ok, r.out.slice(0, 400));
      check(inst.name + ': ...and nothing was created', JSON.stringify(before) === JSON.stringify(lib.snapshot(inst)) && counted(inst, 'unsigned') === 0 && counted(inst, 'signed') === 0);
    }

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
