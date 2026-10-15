// The rules a wallet applies to the ICE servers a Call Service names, and the same rules the
// service applies to its operator's settings. Pure functions, no network.
// Run: node test/manual-call-ice-validation.js
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../call-server/protocol.js');
const { iceUrlProblem } = require('../call-server/server.js');
const { check, finish } = require('./call-test-lib.js');

const SERVER_TIME = '2026-10-15T12:00:00.000Z';
const t0 = Date.parse(SERVER_TIME);
const unix = (ms) => Math.floor(ms / 1000);
const cred = (over) => {
  const expires = unix(t0 + 3600000);
  return Object.assign({
    urls: ['turn:turn.example.net:3478'], username: expires + ':abcdefghijk', credential: 'dGVzdC1jcmVkZW50aWFsLTEyMzQ1Njc4OTA='
  }, over);
};
const answer = (servers, over) => Object.assign({ iceServers: servers, ttl: 3600, serverTime: SERVER_TIME, credentialExpiresAt: new Date(t0 + 3600000).toISOString() }, over);
const run = (a, o) => P.iceServersFromAnswer(a, o);

(async () => {
  // ---------- the wallet's copy of the rules is the service's copy ----------
  check('the wallet and the service share one protocol file',
    fs.readFileSync(path.join(__dirname, '..', 'call-server', 'protocol.js'), 'utf8') === fs.readFileSync(path.join(__dirname, '..', 'extension', 'call-protocol.js'), 'utf8'));

  // ---------- URL syntax ----------
  const parse = P.parseIceUrl;
  check('turn: with a host and no port means 3478', JSON.stringify(parse('turn:turn.example.net')) === JSON.stringify({ scheme: 'turn', host: 'turn.example.net', port: 3478, transport: null, turn: true }));
  check('turns: with no port means 5349', parse('turns:turn.example.net').port === 5349);
  check('a transport suffix is read', parse('turn:turn.example.net:443?transport=tcp').transport === 'tcp');
  check('an IPv6 literal in brackets is read', parse('turn:[2001:db8::1]:3478').host === '[2001:db8::1]');
  const malformed = [
    '', 'turn:', 'turn:host:0', 'turn:host:65536', 'turn:host:99999999', 'http://turn.example.net', 'turn://turn.example.net', 'turn:user:pw@turn.example.net',
    'turn:turn.example.net/path', 'turn:turn.example.net?transport=sctp', 'turn:turn.example.net?transport=udp&x=1', 'turns:turn.example.net?transport=udp',
    'stun:stun.example.net?transport=tcp', 'turn:bad host', 'turn:-bad.example.net', 'turn:bad-.example.net', 'turn:a..b', 'turn:' + 'a'.repeat(64) + '.example.net',
    'turn:turn.example.net:34 78', 'TURN:turn.example.net', 'turn:2130706433', 'turn:127.1', 'turn:0x7f.0.0.1', 'turn:1.2.3.0x7f', 'turn:300.1.1.1', 'turn:1.2.3',
    'turn:[127.0.0.1]', 'x'.repeat(301), 'turn:turn.example.net\n', 'turn:turn.example.net#frag', 123, null, undefined, {}, []
  ];
  const bad = malformed.filter((u) => parse(u) !== null);
  check('malformed, hostile and ambiguous URLs are not parsed (' + malformed.length + ' cases)', bad.length === 0, bad);

  // ---------- private addresses and ports ----------
  const privateTargets = [
    'turn:127.0.0.1:3478', 'turn:127.8.8.8:3478', 'turn:10.0.0.5:3478', 'turn:172.16.0.1:3478', 'turn:172.31.255.255:3478', 'turn:192.168.1.1:3478',
    'turn:169.254.169.254:3478', 'turn:100.64.0.1:3478', 'turn:0.0.0.0:3478', 'turn:224.0.0.1:3478', 'turn:255.255.255.255:3478', 'turn:198.18.0.1:3478', 'turn:192.0.0.9:3478',
    'turn:[::1]:3478', 'turn:[::]:3478', 'turn:[fe80::1]:3478', 'turn:[fec0::1]:3478', 'turn:[fd00::1]:3478', 'turn:[fc00::1]:3478', 'turn:[ff02::1]:3478',
    'turn:[::ffff:127.0.0.1]:3478', 'turn:[::ffff:10.1.2.3]:3478', 'turn:[::ffff:7f00:1]:3478', 'turn:[::ffff:a9fe:a9fe]:3478',
    'turn:localhost:3478', 'turn:printer.local:3478', 'turn:intranet:3478', 'turn:db.internal:3478', 'turn:router.lan:3478', 'turn:x.localhost:3478', 'turn:host.home.arpa:3478'
  ];
  const leaked = privateTargets.filter((u) => !iceUrlProblem(u, 'turn', false));
  check('TURN URLs naming loopback, private, link-local, carrier-grade, multicast or local names are refused (' + privateTargets.length + ' cases)', leaked.length === 0, leaked);
  const leakedStun = privateTargets.map((u) => u.replace('turn:', 'stun:')).filter((u) => !iceUrlProblem(u, 'stun', false));
  check('the same for STUN URLs', leakedStun.length === 0, leakedStun);
  check('a private address is accepted only on the private test network switch', iceUrlProblem('turn:127.0.0.1:3478', 'turn', true) === null && iceUrlProblem('turn:192.168.1.5:3478', 'turn', true) === null);
  check('documentation and public addresses are ordinary', iceUrlProblem('turn:192.0.2.2:3478', 'turn', false) === null && iceUrlProblem('turn:203.0.113.5:3478', 'turn', false) === null && iceUrlProblem('turn:[2001:db8::1]:3478', 'turn', false) === null && iceUrlProblem('turn:8.8.8.8:3478', 'turn', false) === null);

  const oddPorts = ['turn:turn.example.net:22', 'turn:turn.example.net:25', 'turn:turn.example.net:6379', 'turn:turn.example.net:8080', 'turn:turn.example.net:3306', 'turn:turn.example.net:5432', 'turn:turn.example.net:1'];
  check('TURN on a port other than 80, 443, 3478 or 5349 is refused (' + oddPorts.length + ' cases)', oddPorts.every((u) => iceUrlProblem(u, 'turn', false)), oddPorts.filter((u) => !iceUrlProblem(u, 'turn', false)));
  check('the usual TURN ports are accepted', [80, 443, 3478, 5349].every((p) => iceUrlProblem('turn:turn.example.net:' + p, 'turn', false) === null));
  check('on the private test network any TURN port is accepted', iceUrlProblem('turn:turn.example.net:6000', 'turn', true) === null);
  check('a TURN URL is refused where STUN is expected, and the reverse', iceUrlProblem('turn:turn.example.net', 'stun', false) !== null && iceUrlProblem('stun:stun.example.net', 'turn', false) !== null);

  // ---------- the operator may not name a public third-party service ----------
  const third = ['turn:global.turn.twilio.com:3478', 'turn:turn.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'turn:a.relay.metered.ca:80', 'stun:stun.services.mozilla.com'];
  check('public third-party services are refused in the operator\'s settings', third.every((u) => iceUrlProblem(u, u.startsWith('turn') ? 'turn' : 'stun', false) !== null));

  // ---------- an answer reduced to what a browser may be given ----------
  let r = run(answer([cred()]), {});
  check('a well-formed TURN entry is kept with its credential', r.turn && r.iceServers.length === 1 && r.iceServers[0].username === cred().username && r.iceServers[0].credential === cred().credential, r);
  check('the remaining life is measured against the service clock, not the wallet\'s', r.remainingMs === 3600000, r.remainingMs);
  r = run(answer([{ urls: ['stun:stun.example.net:3478', 'stun:stun2.example.net'] }, cred()]), {});
  check('STUN and TURN together become two entries, STUN without a credential', r.iceServers.length === 2 && !('username' in r.iceServers[0]) && r.iceServers[1].username, r);

  const noExp = answer([cred()]); delete noExp.credentialExpiresAt;
  check('a TURN entry with no stated expiry is dropped', !run(noExp, {}).turn && run(noExp, {}).dropped.includes('turn-expiry-missing'));
  const noTime = answer([cred()]); delete noTime.serverTime;
  check('a TURN entry with no service time is dropped', !run(noTime, {}).turn);
  check('a credential that has expired is dropped', !run(answer([cred({ username: unix(t0 - 60000) + ':abcdefghijk' })], { credentialExpiresAt: new Date(t0 - 60000).toISOString() }), {}).turn);
  check('a credential about to expire is dropped', run(answer([cred({ username: unix(t0 + 5000) + ':abcdefghijk' })], { credentialExpiresAt: new Date(t0 + 5000).toISOString() }), {}).dropped.includes('turn-credential-expired'));
  check('a username that expires sooner than the stated expiry wins', run(answer([cred({ username: unix(t0 + 5000) + ':abcdefghijk' })]), {}).dropped.includes('turn-credential-expired'));
  check('a stated expiry sooner than the username\'s wins', run(answer([cred()], { credentialExpiresAt: new Date(t0 + 5000).toISOString() }), {}).dropped.includes('turn-credential-expired'));
  check('a credential good for days is dropped', run(answer([cred({ username: unix(t0 + 3 * 86400000) + ':abcdefghijk' })], { credentialExpiresAt: new Date(t0 + 3 * 86400000).toISOString() }), {}).dropped.includes('turn-credential-too-long'));
  check('a wrong-looking username is dropped', ['alice', 'abc:def', '12345:x', '1700000000:has space', '1700000000:' + 'a'.repeat(65), '17000000000000:x', ''].every((u) => !run(answer([cred({ username: u })]), {}).turn));
  check('a missing, short or oddly-shaped credential is dropped', [undefined, '', 'short', 'has space has space has space', 'a'.repeat(129), 5, null].every((c) => !run(answer([cred({ credential: c })]), {}).turn));
  check('a TURN entry with no credential at all is dropped', !run(answer([{ urls: ['turn:turn.example.net:3478'] }]), {}).turn);
  check('a TURN entry naming a private address is dropped', !run(answer([cred({ urls: ['turn:127.0.0.1:3478'] })]), {}).turn);
  check('a TURN entry naming a private address is kept on the private test network', run(answer([cred({ urls: ['turn:127.0.0.1:3478'] })]), { allowPrivate: true }).turn);
  check('a TURN entry on an odd port is dropped', !run(answer([cred({ urls: ['turn:turn.example.net:6379'] })]), {}).turn);
  check('a TURN entry with only a non-TURN scheme is dropped', !run(answer([cred({ urls: ['http://turn.example.net/'] })]), {}).turn);
  r = run(answer([cred({ urls: ['turn:turn.example.net:3478', 'turn:127.0.0.1:3478', 'turns:turn.example.net:5349?transport=tcp', 'turn:turn.example.net:6379'] })]), {});
  check('good TURN URLs are kept and bad ones dropped from the same entry', r.turn && JSON.stringify(r.iceServers[0].urls) === JSON.stringify(['turn:turn.example.net:3478', 'turns:turn.example.net:5349?transport=tcp']), r);
  r = run(answer([cred({ urls: ['turn:a.example.net:3478', 'turn:b.example.net:3478', 'turn:c.example.net:3478', 'turn:d.example.net:3478', 'turn:e.example.net:3478'] })]), {});
  check('at most four TURN URLs are kept', r.iceServers[0].urls.length === 4, r.iceServers[0].urls);
  r = run(answer([cred(), cred({ urls: ['turn:other.example.net:3478'], username: unix(t0 + 3600000) + ':zzzzzzzzzzz' })]), {});
  check('only one TURN server\'s credential is passed on, never a second', r.iceServers.length === 1 && r.dropped.includes('second-turn-server') && r.iceServers[0].urls[0] === 'turn:turn.example.net:3478', r);
  r = run(answer([{ urls: ['stun:a.example.net', 'stun:b.example.net', 'stun:c.example.net', 'stun:d.example.net', 'stun:a.example.net'] }]), {});
  check('at most three distinct STUN URLs are kept', r.iceServers.length === 1 && r.iceServers[0].urls.length === 3, r);
  check('extra credential fields on a STUN entry are not passed on', (() => { const x = run(answer([{ urls: ['stun:a.example.net'], username: 'u', credential: 'c'.repeat(30) }]), {}); return x.iceServers.length === 1 && !('username' in x.iceServers[0]) && !('credential' in x.iceServers[0]); })());
  check('unknown fields on a TURN entry are not passed on', (() => { const x = run(answer([cred({ credentialType: 'oauth', extra: 'x' })]), {}); return x.turn && Object.keys(x.iceServers[0]).sort().join() === 'credential,urls,username'; })());
  r = run(answer([{ urls: Array.from({ length: 16 }, (_, i) => 'http://x' + i).concat(['stun:late.example.net:3478']) }]), {});
  check('URLs beyond the first sixteen in one entry are not considered', r.iceServers.length === 0, r);
  check('more than four entries are ignored beyond the fourth', run(answer([{ urls: ['stun:a.example.net'] }, { urls: ['stun:b.example.net'] }, { urls: ['stun:c.example.net'] }, { urls: ['stun:d.example.net'] }, cred()]), {}).turn === false);
  for (const [label, a] of [['null', null], ['a string', 'x'], ['an array', []], ['no iceServers', {}], ['iceServers not a list', { iceServers: {} }], ['entries not objects', { iceServers: [1, null, 'x'] }], ['urls not a list', { iceServers: [{ urls: 'turn:turn.example.net' }] }]]) {
    const x = run(a, {});
    check('an answer that is ' + label + ' yields no servers and does not throw', Array.isArray(x.iceServers) && x.iceServers.length === 0 && !x.turn);
  }
  check('dropped reasons never contain a URL or a credential', (() => {
    const x = run(answer([cred({ urls: ['turn:127.0.0.1:3478', 'turn:turn.example.net:6379'], credential: 'SECRETSECRETSECRETSECRET' })]), {});
    return !JSON.stringify(x.dropped).includes('SECRET') && !JSON.stringify(x.dropped).includes('127.0.0.1');
  })());

  process.exit(finish('manual-call-ice-validation'));
})().catch((e) => { console.error(e); process.exit(2); });
