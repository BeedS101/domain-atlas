// DNS rebinding and "public name, private address" protection of the Node directory (SPEC.md 3.3 hardening).
// A public-looking host name is only worth fetching if EVERY address it resolves to is public, and the connection must go
// to an address that was checked, not to whatever a second lookup says. The test runs the real directory in public mode
// (no DIRECTORY_ALLOW_LOCAL) with test/support/directory-fake-dns.js preloaded: name lookups come from a table, and every
// connection is recorded and refused before it is made. No real DNS, no live domain and no network traffic is involved.
//
// The PHP port has the same checks in test/verify-directory-rebinding.php.
//
//   node test/verify-directory-rebinding.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startDirectory } = require('./support/directory-harness');

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log('PASS ' + label);
  else { failures++; console.log('FAIL ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); }
}

const PUBLIC = '8.8.8.8';
const names = {
  'loopback.example': [['127.0.0.1']],
  'private-ten.example': [['10.1.2.3']],
  'private-172.example': [['172.16.9.9']],
  'private-192.example': [['192.168.0.10']],
  'metadata.example': [['169.254.169.254']],
  'cgnat.example': [['100.64.1.1']],
  'unspecified.example': [['0.0.0.0']],
  'v6-loopback.example': [['::1']],
  'v6-private.example': [['fd00::5']],
  'v6-mapped-loopback.example': [['::ffff:127.0.0.1']],
  'mixed-public-first.example': [[PUBLIC, '10.0.0.5']],
  'mixed-private-first.example': [['10.0.0.5', PUBLIC]],
  'public.example': [[PUBLIC]],
  // Answers a public address the first time it is asked and the loopback address from then on.
  'rebind.example': [[PUBLIC], ['127.0.0.1']],
};
const refusedNames = Object.keys(names).filter((n) => n !== 'public.example' && n !== 'rebind.example');

(async () => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'directory-rebinding-')), 'dns.log');
  fs.writeFileSync(logFile, '');
  const events = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const d = await startDirectory({
    impl: 'node', port: 8207,
    nodeArgs: ['-r', path.join(__dirname, 'support', 'directory-fake-dns.js')],
    env: { DIRECTORY_FAKE_DNS: JSON.stringify(names), DIRECTORY_FAKE_LOG: logFile, DIRECTORY_SUBMITS_PER_HOUR: '1000', DIRECTORY_ALLOW_LOCAL: '' }
  });
  const submit = async (name) => {
    const mark = events().length;
    const res = await fetch(d.base + '/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: 'https://' + name + '/.well-known/spatial.json' }) });
    return { status: res.status, json: await res.json().catch(() => ({})), seen: events().slice(mark) };
  };
  const connects = (r) => r.seen.filter((e) => e.type === 'connect');

  try {
    console.log('--- control: the harness really sees a connection to a public address ---');
    let r = await submit('public.example');
    check('a name with a public address is looked up and the connection is headed for exactly that address',
      connects(r).length >= 1 && connects(r).every((c) => c.port === 443 && c.addresses.length === 1 && c.addresses[0] === PUBLIC), r.seen);
    check('...and it is the answer to that one lookup', r.seen.filter((e) => e.type === 'lookup').every((l) => l.answer.join() === PUBLIC), r.seen);

    console.log('--- public names that resolve to private or loopback addresses ---');
    for (const name of refusedNames) {
      r = await submit(name);
      const answer = names[name][0].join(', ');
      check(name + ' (' + answer + ') is refused as non-public, and no connection is made',
        r.status >= 400 && /non-public/.test(String(r.json.error)) && connects(r).length === 0 && r.seen.some((e) => e.type === 'lookup'), { status: r.status, error: r.json.error, seen: r.seen });
    }
    r = await submit('unresolvable.example');
    check('a name that does not resolve is refused and no connection is made', r.status >= 400 && connects(r).length === 0, { status: r.status, error: r.json.error, seen: r.seen });

    console.log('--- the answer can change between two lookups ---');
    r = await submit('rebind.example');
    check('first lookup (public): the connection is headed for the address that was checked', connects(r).length >= 1 && connects(r).every((c) => c.addresses.join() === PUBLIC), r.seen);
    r = await submit('rebind.example');
    check('second lookup (now loopback): refused, and nothing connects to 127.0.0.1', r.status >= 400 && /non-public/.test(String(r.json.error)) && connects(r).length === 0, { status: r.status, error: r.json.error, seen: r.seen });
    check('no connection in the whole run ever went to a non-public address', events().filter((e) => e.type === 'connect').every((c) => c.addresses.every((a) => a === PUBLIC)), events().filter((e) => e.type === 'connect'));
    check('nothing was listed', (await (await fetch(d.base + '/stats')).json()).manifestsTracked === 0);
  } finally {
    d.stop();
    fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nALL DIRECTORY REBINDING CHECKS PASSED (node)' : '\n' + failures + ' DIRECTORY REBINDING CHECK(S) FAILED (node)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILURE:', e); process.exit(1); });
