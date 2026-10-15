// call-server/turn-probe.js, the tool an operator runs against their own coturn, exercised against
// the SIMULATED TURN server in test/turn-fixture-lib.js. This shows that the probe reports a
// correctly configured server as passing and a misconfigured one as failing. It does not show
// anything about coturn itself; run the probe against the real server to learn that.
// Run: node test/manual-call-turn-probe.js
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const P = require('../call-server/protocol.js');
const probe = require('../call-server/turn-probe.js');
const { startTurnFixture, selfSignedCert } = require('./turn-fixture-lib.js');
const { check, finish } = require('./call-test-lib.js');

const SECRET = 'a7f3c9d1e5b2a8f4c6d0e9b1a3f5c7d9e1b3a5f7c9d1e3b5a7f9c1d3e5b7a9f1';
const run = async (url, secret, extra) => {
  const lines = [];
  const fails = await probe.runProbe(Object.assign({ url: P.parseIceUrl(url), secret, timeoutMs: 1500 }, extra), (l) => lines.push(l));
  return { fails, lines, text: lines.join('\n') };
};
const cli = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'call-server', 'turn-probe.js')].concat(args), { env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  c.on('exit', (code) => resolve({ code, out }));
});

(async () => {
  console.log('SIMULATED TURN server (test/turn-fixture-lib.js); nothing here involves coturn.\n');
  const cert = selfSignedCert(require('./turn-fixture-lib.js').localIPv4());
  const fx = await startTurnFixture({ secret: SECRET, tls: cert || undefined });

  for (const [name, url] of [['UDP', fx.urls.udp], ['TCP', fx.urls.tcp]].concat(cert ? [['TLS', fx.urls.tls]] : [])) {
    const r = await run(url, SECRET, cert ? { ca: cert.cert } : {});
    check('the probe reports no failures against a correctly configured server over ' + name, r.fails === 0, r.text);
    check('and it ran every check over ' + name + ' (allocation, five refused credentials, denied peers, relay, release)', r.lines.filter((l) => l.startsWith('PASS')).length >= 11, r.lines);
  }
  if (!cert) console.log('SKIPPED TLS probe: openssl is not installed here');

  const wrong = await run(fx.urls.udp, 'ZZ' + SECRET.slice(2));
  check('the probe fails when its secret differs from the server\'s, and says why', wrong.fails > 0 && /secret differs/.test(wrong.text), wrong.text);

  const open = await startTurnFixture({ secret: SECRET, allowPrivatePeers: true });
  const lax = await run(open.urls.udp, SECRET);
  check('the probe fails a server that would relay to loopback and private addresses', lax.fails > 0 && /FAIL permission for/.test(lax.text), lax.text);
  await open.close();

  fx.clockOffsetMs = 15 * 60 * 1000;
  const skew = await run(fx.urls.udp, SECRET);
  check('the probe fails when the server\'s clock is far ahead of the credential\'s', skew.fails > 0, skew.text);
  fx.clockOffsetMs = 0;

  const dead = await startTurnFixture({ secret: SECRET });
  const gone = { udp: dead.urls.udp, tcp: dead.urls.tcp };
  await dead.close();
  const noUdp = await run(gone.udp, SECRET, { timeoutMs: 600 });
  const noTcp = await run(gone.tcp, SECRET, { timeoutMs: 600 });
  check('the probe fails cleanly, without throwing, when nothing is listening (UDP)', noUdp.fails > 0, noUdp.text);
  check('the probe fails cleanly, without throwing, when nothing is listening (TCP)', noTcp.fails > 0 && /accepts a connection/.test(noTcp.text), noTcp.text);

  // command line
  const ok = await cli([fx.urls.tcp], { CALL_TURN_SECRET: SECRET });
  check('the command line exits 0 against a correct server', ok.code === 0 && /No failures/.test(ok.out), ok.out);
  check('and never prints the secret', !ok.out.includes(SECRET));
  const bad = await cli([fx.urls.tcp], { CALL_TURN_SECRET: 'Q' + SECRET.slice(1) });
  check('the command line exits 1 when the secret is wrong', bad.code === 1 && /Failed/.test(bad.out), bad.out);
  const none = await cli([fx.urls.tcp], { CALL_TURN_SECRET: '' });
  check('the command line exits 2 and explains when no secret is given', none.code === 2 && /secret/.test(none.out), none.out);
  const noUrl = await cli(['http://example.com'], { CALL_TURN_SECRET: SECRET });
  check('the command line exits 2 and shows usage for something that is not a TURN URL', noUrl.code === 2 && /usage/.test(noUrl.out), noUrl.out);
  check('the probe left no allocations behind on the simulated server', await (async () => { await new Promise((r) => setTimeout(r, 300)); return fx.allocationCount() === 0; })(), fx.allocationCount());

  await fx.close();
  process.exit(finish('manual-call-turn-probe'));
})().catch((e) => { console.error(e); process.exit(2); });
