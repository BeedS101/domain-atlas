// The example files an operator copies for TURN: the coturn configuration, the settings file and
// the systemd unit. They are text, so this reads them and checks the settings that matter for
// safety are present and uncommented, that nothing dangerous is switched on, and that the
// placeholders cannot be mistaken for a working secret. It does not start coturn.
// Run: node test/manual-call-turn-deploy.js
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { check, finish } = require('./call-test-lib.js');
const { loadConfig } = require('../call-server/server.js');
const probe = require('../call-server/turn-probe.js');

const dir = path.join(__dirname, '..', 'call-server', 'deploy');
const text = fs.readFileSync(path.join(dir, 'coturn-turn.conf.example'), 'utf8');
const active = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const has = (re) => active.some((l) => re.test(l));
const values = (name) => active.filter((l) => l.startsWith(name + '=')).map((l) => l.slice(name.length + 1));

const v4 = (a) => a.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const inRange = (ip, range) => { const [lo, hi] = range.split('-'); return net.isIPv4(ip) && v4(ip) >= v4(lo) && v4(ip) <= v4(hi); };

// ---------- coturn ----------
check('credentials come from a shared secret, with no static users and no open access', has(/^use-auth-secret$/) && !has(/^(user=|lt-cred-mech$|no-auth$|allow-loopback-peers$|cli-password=|web-admin$)/));
check('the secret in the example is a placeholder that cannot work', values('static-auth-secret').length === 1 && /REPLACE/.test(values('static-auth-secret')[0]));
check('the console is off', has(/^no-cli$/));
check('TCP relays are refused', has(/^no-tcp-relay$/));
check('loopback and multicast peers are refused', has(/^no-loopback-peers$/) && has(/^no-multicast-peers$/));
const denied = values('denied-peer-ip');
check('the probe\'s forbidden peers are all covered by denied-peer-ip ranges', probe.DENIED_PEERS.every((ip) => denied.some((r) => inRange(ip, r))), probe.DENIED_PEERS.filter((ip) => !denied.some((r) => inRange(ip, r))));
check('IPv6 loopback, unique-local and link-local are denied', denied.includes('::1') && denied.some((r) => /^fc00::-/.test(r)) && denied.some((r) => /^fe80::-/.test(r)));
check('allocations and bandwidth are limited', has(/^user-quota=\d+$/) && has(/^total-quota=\d+$/) && has(/^max-bps=\d+$/) && Number(values('user-quota')[0]) >= 4);
check('allocation lifetime is capped', has(/^max-allocate-lifetime=\d+$/) && Number(values('max-allocate-lifetime')[0]) <= 3600);
check('stale nonces are refused', has(/^stale-nonce=\d+$/));
const lo = Number(values('min-port')[0]), hi = Number(values('max-port')[0]);
check('relay ports are a limited range, not the whole space', lo >= 1024 && hi > lo && hi - lo < 5000, { lo, hi });
check('TLS 1.0 and 1.1 are off, a certificate is named, and the unused DTLS listener is off', has(/^no-tlsv1$/) && has(/^no-tlsv1_1$/) && has(/^cert=/) && has(/^pkey=/) && has(/^no-dtls$/));
check('it is not the STUN-only file: it does not set stun-only', !has(/^stun-only$/));
check('it runs unprivileged and logs to a file, not to the console', has(/^proc-user=/) && has(/^log-file=/) && has(/^no-stdout-log$/));
check('the ports are the ones the wallet accepts', Number(values('listening-port')[0]) === 3478 && Number(values('tls-listening-port')[0]) === 5349);
check('the file says it was not run', /has not been run/.test(text));

// ---------- settings file ----------
const jsonText = fs.readFileSync(path.join(dir, 'atlas-call.config.json.example'), 'utf8');
const cfgFile = JSON.parse(jsonText);
check('the settings example lists no TURN server and no secret', Array.isArray(cfgFile.turnUrls) && cfgFile.turnUrls.length === 0 && !/secret/i.test(jsonText.replace(/turnSecretFile/g, '')));
const filled = Object.assign({}, cfgFile, { issuerKeys: ['B' + 'A'.repeat(86)], turnUrls: ['turn:turn.example.org:3478', 'turn:turn.example.org:3478?transport=tcp', 'turns:turn.example.org:5349?transport=tcp'] });
const dirTmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'turn-deploy-'));
fs.writeFileSync(path.join(dirTmp, 'config.json'), JSON.stringify(filled));
const files = { [path.join(dirTmp, 'config.json')]: JSON.stringify(filled), '/run/credentials/turn-secret': 'f3a9c1e7b5d2084a6c9e1f3b5d7a9c0e2f4a6b8c0d1e3f5a7b9c1d3e5f7a9b1c' };
const c = loadConfig({ CALL_CONFIG_FILE: path.join(dirTmp, 'config.json'), CALL_TURN_SECRET_FILE: '/run/credentials/turn-secret' }, (p) => { if (!(p in files)) throw new Error('missing'); return files[p]; });
check('the settings example, filled in as the guide says, is accepted with the secret from a file', c.configured && c.turnUrls.length === 3 && c.turnTtlSeconds === 3600, c.problem);
fs.rmSync(dirTmp, { recursive: true, force: true });

// ---------- systemd unit ----------
const unit = fs.readFileSync(path.join(dir, 'atlas-call.service.example'), 'utf8');
check('the unit passes the secret as a credential file, in lines that are off until the operator opts in', /^#LoadCredential=turn-secret:\/etc\/atlas-call\/turn-secret$/m.test(unit) && /^#Environment=CALL_TURN_SECRET_FILE=%d\/turn-secret$/m.test(unit));
check('the unit never contains a secret value', !/CALL_TURN_SECRET=/.test(unit));

process.exit(finish('manual-call-turn-deploy'));
