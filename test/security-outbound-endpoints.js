// A production-configured issuer is asked, through its public relay endpoints, to fetch a "published key" from
// destinations a stranger chose: loopback, private and metadata addresses, URLs, userinfo, odd ports. None may be
// contacted, and the answers must not describe the internal network. A flood of made-up domains is bounded. The same
// cases run against both issuers; the local-development federation between two domains is covered by
// security-world-drop-relay.js.
//
// Run: STACK=node node test/security-outbound-endpoints.js   (or STACK=php)
'use strict';
const http = require('http');
const S = require('./support/issuer-stack');

const STACK = process.env.STACK || 'node';
const BASE_PORT = STACK === 'php' ? 8540 : 8530;
let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 240))); }
}

(async () => {
  const production = STACK === 'node' ? { ATLAS_DOMAIN: 'issuer.example' } : { ATLAS_ALLOW_LOCAL_PEERS: '0' };
  const A = await S.startIssuer(STACK, BASE_PORT, Object.assign({ ATLAS_OUTBOUND_TIMEOUT_MS: '2500', ATLAS_OUTBOUND_KEY_RATE: '3', ATLAS_OUTBOUND_KEY_RATE_ALL: '8' }, production));
  const hits = [];
  const trap = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [{ publicKey: 'x', validFrom: '2020-01-01T00:00:00Z' }] })); });
  const trapPort = await new Promise((ok) => trap.listen(0, '127.0.0.1', () => ok(trap.address().port)));
  const sender = await S.generateIdentity();
  const recipient = await S.generateIdentity();
  const LEAK = new RegExp('127\\.0\\.0\\.1|\\[::1\\]|169\\.254|10\\.0\\.0\\.5|' + trapPort + '|ECONN|ENOTFOUND|EAI_AGAIN|curl|getaddrinfo|resolve', 'i');

  async function relayVia(relayingDomain) {
    const payload = { to: { publicKey: recipient.publicKey }, subject: 'hello', body: 'hi' };
    const proof = await S.signPayload(sender, payload);
    return S.post(A.base, '/atlas/postoffice/relay', { payload, proof, relayAttestation: { relayingDomain }, relaySignature: 'AAAA' });
  }

  try {
    console.log('--- destinations a stranger chooses for the key lookup ---');
    const targets = [
      ['loopback with a port', 'localhost:' + trapPort], ['loopback by address', '127.0.0.1:' + trapPort], ['a URL', 'http://127.0.0.1:' + trapPort], ['an https URL', 'https://localhost:' + trapPort + '/'],
      ['IPv6 loopback', '[::1]:' + trapPort], ['the cloud metadata address', '169.254.169.254'], ['the metadata address with a port', '169.254.169.254:80'], ['a private address', '10.0.0.5'], ['a decimal address', '2130706433'],
      ['the metadata name', 'metadata.google.internal'], ['userinfo', 'user@peer.example'], ['credentials', 'user:pw@peer.example'], ['a path', 'peer.example/.well-known/atlas-key.json'], ['a query', 'peer.example?x=1'],
      ['a fragment', 'peer.example#x'], ['a non-standard port', 'peer.example:8080'], ['an internal suffix', 'db.internal'], ['an enormous value', 'a'.repeat(5000) + '.example'], ['a trap path on loopback', '127.0.0.1:' + trapPort + '/.well-known/atlas-key.json#']
    ];
    for (const [label, target] of targets) {
      const r = await relayVia(target);
      const text = JSON.stringify(r.body);
      const bare = text.split(target).join('').split(JSON.stringify(target).slice(1, -1)).join('');
      check('refused: ' + label, r.status >= 400 && !r.body.credential && r.status !== 200, [r.status, text.slice(0, 120)]);
      check('and the answer describes no internal network: ' + label, !LEAK.test(bare.replace(/could not verify/g, '')), text.slice(0, 200));
    }
    check('the trap server was never contacted', hits.length === 0, hits);

    console.log('--- a flood of made-up domains is bounded ---');
    const outcomes = [];
    for (let i = 0; i < 12; i++) outcomes.push((await relayVia('flood-' + i + '-' + Date.now() + '.invalid')));
    const limited = outcomes.map((r) => /too many requests/.test(JSON.stringify(r.body)));
    check('lookups beyond the overall budget are refused without being attempted', limited.slice(0, 8).every((x) => !x) && limited.slice(8).every((x) => x), limited);
    check('they are refused with an error, not accepted', outcomes.every((r) => r.status >= 400));

    console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  } finally {
    A.stop(); trap.close();
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
