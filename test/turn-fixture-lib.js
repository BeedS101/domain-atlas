// A SIMULATED TURN server for tests. It is not coturn and not a production component.
//
// It implements just enough of RFC 8656 (TURN) and RFC 5389 (STUN) for a real Chromium and for
// call-server/turn-probe.js to allocate, authenticate with coturn-style time-limited credentials
// (username "<unix expiry>:<label>", password base64(HMAC-SHA1(secret, username))), grant
// permissions, bind channels and relay datagrams between two allocations over UDP, TCP and TLS.
// It enforces the rules the deployment guide asks coturn to enforce: credentials must carry an
// unexpired timestamp and a valid MAC, loopback/private/link-local/CGNAT peers are refused, TCP
// relays are refused. What it shows about those rules is that the wallet and the Call Service
// behave correctly against a server that enforces them; it does not show that coturn does.
'use strict';
const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');
const S = require('../call-server/turn-probe.js');
const { METHOD, CLASS, ATTR } = S;

function localIPv4() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}
const isDeniedPeer = (ip) => {
  const o = ip.split('.').map(Number);
  return o[0] === 0 || o[0] === 10 || o[0] === 127 || o[0] >= 224 || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || (o[0] === 169 && o[1] === 254) ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
};
const classify = (b) => (b.length ? (b[0] <= 3 ? 'stun' : b[0] >= 20 && b[0] <= 63 ? 'dtls' : b[0] >= 128 && b[0] <= 191 ? 'rtp' : b[0] >= 64 && b[0] <= 79 ? 'channel' : 'other') : 'empty');

// A throwaway self-signed certificate for `host` (an IP address or a name), made with the openssl
// command line. Returns null when openssl is not installed.
function selfSignedCert(host) {
  const cp = require('child_process'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-cert-'));
  try {
    const san = (net.isIP(host) ? 'IP:' : 'DNS:') + host;
    cp.execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=' + host,
      '-addext', 'subjectAltName=' + san, '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } catch (e) { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// opts: { secret, host, realm, tls: {key, cert}, allowPrivatePeers, maxAllocations, clockOffsetMs, lifetime }
async function startTurnFixture(opts) {
  const o = Object.assign({ host: localIPv4(), realm: 'atlas-test', clockOffsetMs: 0, lifetime: 600, maxAllocations: 50, allowPrivatePeers: false }, opts);
  const fx = {
    host: o.host, realm: o.realm, clockOffsetMs: o.clockOffsetMs, secret: o.secret,
    events: [], stats: { challenges: 0, authOk: 0, authFailed: { expired: 0, badMac: 0, noStamp: 0, staleNonce: 0 }, allocations: 0, refreshes: 0, relayedPackets: 0, relayedBytes: 0, relayedClasses: {}, permissionsDenied: 0, tcpRelayRefused: 0, byTransport: { udp: 0, tcp: 0, tls: 0 } },
    users: new Set()
  };
  const emit = (type, data) => fx.events.push(Object.assign({ type, at: Date.now() }, data));
  const allocations = new Map();     // client key -> allocation
  const nonces = new Map();          // nonce -> expiry
  const clientsByKey = new Map();
  const nowSeconds = () => Math.floor((Date.now() + fx.clockOffsetMs) / 1000);

  const newNonce = () => { const n = crypto.randomBytes(12).toString('hex'); nonces.set(n, Date.now() + 300000); return n; };
  function reply(client, method, cls, txid, attrs, key) {
    let msg = S.encode(method, cls, txid, attrs);
    if (key) msg = S.withIntegrity(msg, key);
    client.write(msg);
  }
  const errAttrs = (code, reason, extra) => [[ATTR.ERROR, S.errorValue(code, reason)]].concat(extra || []);
  const challenge = (client, m, code, reason) => reply(client, m.method, CLASS.ERROR, m.txid, errAttrs(code, reason, [[ATTR.REALM, Buffer.from(fx.realm)], [ATTR.NONCE, Buffer.from(newNonce())]]));

  // Returns the long-term key when the request is properly authenticated; otherwise answers and returns null.
  function authenticate(client, m) {
    const u = S.attrOf(m, ATTR.USERNAME), mi = S.attrOf(m, ATTR.INTEGRITY), nonce = S.attrOf(m, ATTR.NONCE);
    if (!u || !mi || !nonce) { fx.stats.challenges++; challenge(client, m, 401, 'Unauthorized'); return null; }
    const username = u.toString();
    if (!nonces.has(nonce.toString()) || nonces.get(nonce.toString()) < Date.now()) { fx.stats.authFailed.staleNonce++; challenge(client, m, 438, 'Stale Nonce'); return null; }
    const stamp = /^(\d{1,12})(?::.*)?$/.exec(username);
    if (!stamp) { fx.stats.authFailed.noStamp++; emit('auth-failed', { reason: 'no-stamp' }); challenge(client, m, 401, 'Unauthorized'); return null; }
    if (Number(stamp[1]) <= nowSeconds()) { fx.stats.authFailed.expired++; emit('auth-failed', { reason: 'expired' }); challenge(client, m, 401, 'Unauthorized'); return null; }
    const password = crypto.createHmac('sha1', fx.secret).update(username).digest('base64');
    const key = S.longTermKey(username, fx.realm, password);
    if (!S.integrityOk(m, key)) { fx.stats.authFailed.badMac++; emit('auth-failed', { reason: 'bad-mac' }); challenge(client, m, 401, 'Unauthorized'); return null; }
    fx.stats.authOk++;
    fx.users.add(username);
    return { key, username };
  }

  function peerOf(m, attrIndex) {
    const all = m.attrs.filter((a) => a.type === ATTR.XOR_PEER);
    return all.map((a) => S.parseXorAddress(a.value, m.txid));
  }
  const peerProblem = (p) => (p.family !== 1 ? 443 : (!o.allowPrivatePeers && isDeniedPeer(p.ip)) ? 403 : 0);

  function sendChannelData(alloc, ch, data) {
    const head = Buffer.alloc(4); head.writeUInt16BE(ch, 0); head.writeUInt16BE(data.length, 2);
    const pad = alloc.client.kind === 'udp' ? 0 : (4 - (data.length % 4)) % 4;
    alloc.client.write(Buffer.concat([head, data, Buffer.alloc(pad)]));
  }
  function toPeer(alloc, ip, port, data) {
    if (!alloc.perms.has(ip) || alloc.perms.get(ip) < Date.now()) return;
    alloc.relay.send(data, port, ip);
    fx.stats.relayedPackets++; fx.stats.relayedBytes += data.length;
    const c = classify(data); fx.stats.relayedClasses[c] = (fx.stats.relayedClasses[c] || 0) + 1;
  }

  function dropAllocation(client) {
    const a = allocations.get(client.key);
    if (!a) return;
    allocations.delete(client.key);
    clearTimeout(a.timer);
    try { a.relay.close(); } catch (e) { /* closed */ }
  }

  async function handle(client, buf) {
    if (buf[0] >= 0x40 && buf[0] <= 0x7F) {
      const a = allocations.get(client.key);
      if (!a || buf.length < 4) return;
      const ch = buf.readUInt16BE(0), len = buf.readUInt16BE(2);
      const peer = a.channels.get(ch);
      if (peer && buf.length >= 4 + len) toPeer(a, peer.ip, peer.port, buf.subarray(4, 4 + len));
      return;
    }
    const m = S.decode(buf);
    if (!m) return;
    if (m.cls === CLASS.INDICATION && m.method === METHOD.SEND) {
      const a = allocations.get(client.key), peer = S.attrOf(m, ATTR.XOR_PEER), data = S.attrOf(m, ATTR.DATA);
      if (a && peer && data) { const p = S.parseXorAddress(peer, m.txid); if (p.family === 1) toPeer(a, p.ip, p.port, Buffer.from(data)); }
      return;
    }
    if (m.cls !== CLASS.REQUEST) return;
    if (m.method === METHOD.BINDING) {
      return reply(client, m.method, CLASS.SUCCESS, m.txid, [[ATTR.XOR_MAPPED, S.xorAddress(client.remote.ip, client.remote.port, m.txid)]]);
    }
    if (![METHOD.ALLOCATE, METHOD.REFRESH, METHOD.CREATE_PERMISSION, METHOD.CHANNEL_BIND].includes(m.method)) return;
    const auth = authenticate(client, m);
    if (!auth) return;
    const { key } = auth;
    const a = allocations.get(client.key);

    if (m.method === METHOD.ALLOCATE) {
      if (a) return reply(client, m.method, CLASS.ERROR, m.txid, errAttrs(437, 'Allocation Mismatch'), key);
      const rt = S.attrOf(m, ATTR.REQ_TRANSPORT);
      if (!rt || rt[0] !== 17) { fx.stats.tcpRelayRefused++; return reply(client, m.method, CLASS.ERROR, m.txid, errAttrs(442, 'Unsupported Transport Protocol'), key); }
      if (allocations.size >= o.maxAllocations) return reply(client, m.method, CLASS.ERROR, m.txid, errAttrs(486, 'Allocation Quota Reached'), key);
      const relay = dgram.createSocket('udp4');
      await new Promise((r) => relay.bind(0, fx.host, r));
      const alloc = { client, relay, perms: new Map(), channels: new Map(), byPeer: new Map(), user: auth.username, expires: Date.now() + o.lifetime * 1000 };
      relay.on('message', (data, rinfo) => {
        if (!alloc.perms.has(rinfo.address) || alloc.perms.get(rinfo.address) < Date.now()) return;
        fx.stats.relayedPackets++; fx.stats.relayedBytes += data.length;
        const c = classify(data); fx.stats.relayedClasses[c] = (fx.stats.relayedClasses[c] || 0) + 1;
        const ch = alloc.byPeer.get(rinfo.address + ':' + rinfo.port);
        if (ch) return sendChannelData(alloc, ch, data);
        const txid = crypto.randomBytes(12);
        client.write(S.encode(METHOD.DATA, CLASS.INDICATION, txid, [[ATTR.XOR_PEER, S.xorAddress(rinfo.address, rinfo.port, txid)], [ATTR.DATA, data]]));
      });
      alloc.timer = setTimeout(() => dropAllocation(client), o.lifetime * 1000);
      allocations.set(client.key, alloc);
      fx.stats.allocations++; fx.stats.byTransport[client.kind]++;
      emit('allocated', { transport: client.kind });
      const lifetimeBuf = Buffer.alloc(4); lifetimeBuf.writeUInt32BE(o.lifetime, 0);
      return reply(client, m.method, CLASS.SUCCESS, m.txid, [
        [ATTR.XOR_RELAYED, S.xorAddress(fx.host, relay.address().port, m.txid)], [ATTR.XOR_MAPPED, S.xorAddress(client.remote.ip, client.remote.port, m.txid)], [ATTR.LIFETIME, lifetimeBuf]
      ], key);
    }
    if (!a) return reply(client, m.method, CLASS.ERROR, m.txid, errAttrs(437, 'Allocation Mismatch'), key);
    if (m.method === METHOD.REFRESH) {
      const l = S.attrOf(m, ATTR.LIFETIME);
      const lifetime = l ? l.readUInt32BE(0) : o.lifetime;
      if (lifetime === 0) { dropAllocation(client); const z = Buffer.alloc(4); return reply(client, m.method, CLASS.SUCCESS, m.txid, [[ATTR.LIFETIME, z]], key); }
      clearTimeout(a.timer); a.timer = setTimeout(() => dropAllocation(client), Math.min(lifetime, 3600) * 1000);
      fx.stats.refreshes++; emit('refreshed', { lifetime: Math.min(lifetime, 3600) });
      const lb = Buffer.alloc(4); lb.writeUInt32BE(Math.min(lifetime, 3600), 0);
      return reply(client, m.method, CLASS.SUCCESS, m.txid, [[ATTR.LIFETIME, lb]], key);
    }
    if (m.method === METHOD.CREATE_PERMISSION) {
      const peers = peerOf(m);
      if (!peers.length) return reply(client, m.method, CLASS.ERROR, m.txid, errAttrs(400, 'Bad Request'), key);
      for (const p of peers) { const bad = peerProblem(p); if (bad) { fx.stats.permissionsDenied++; emit('permission-denied', { ip: p.ip }); return reply(client, m.method, CLASS.ERROR, m.txid, errAttrs(bad, bad === 403 ? 'Forbidden IP' : 'Peer Address Family Mismatch'), key); } }
      for (const p of peers) a.perms.set(p.ip, Date.now() + 300000);
      return reply(client, m.method, CLASS.SUCCESS, m.txid, [], key);
    }
    if (m.method === METHOD.CHANNEL_BIND) {
      const chv = S.attrOf(m, ATTR.CHANNEL), peers = peerOf(m);
      if (!chv || peers.length !== 1) return reply(client, m.method, CLASS.ERROR, m.txid, errAttrs(400, 'Bad Request'), key);
      const ch = chv.readUInt16BE(0), p = peers[0];
      if (ch < 0x4000 || ch > 0x7FFE) return reply(client, m.method, CLASS.ERROR, m.txid, errAttrs(400, 'Bad Request'), key);
      const bad = peerProblem(p);
      if (bad) { fx.stats.permissionsDenied++; emit('permission-denied', { ip: p.ip }); return reply(client, m.method, CLASS.ERROR, m.txid, errAttrs(bad, 'Forbidden IP'), key); }
      a.perms.set(p.ip, Date.now() + 300000);
      a.channels.set(ch, { ip: p.ip, port: p.port });
      a.byPeer.set(p.ip + ':' + p.port, ch);
      return reply(client, m.method, CLASS.SUCCESS, m.txid, [], key);
    }
  }

  // ----- transports -----
  const udp = dgram.createSocket('udp4');
  udp.on('message', (buf, r) => {
    const key = 'udp:' + r.address + ':' + r.port;
    let c = clientsByKey.get(key);
    if (!c) { c = { kind: 'udp', key, remote: { ip: r.address, port: r.port }, write: (b) => udp.send(b, r.port, r.address) }; clientsByKey.set(key, c); }
    handle(c, buf).catch((e) => emit('error', { message: String(e && e.message) }));
  });
  const onStream = (kind) => (sock) => {
    const key = kind + ':' + crypto.randomBytes(6).toString('hex');
    const c = { kind, key, remote: { ip: sock.remoteAddress.replace(/^::ffff:/, ''), port: sock.remotePort }, write: (b) => { try { sock.write(b); } catch (e) { /* closed */ } } };
    const framer = new S.Framer((f) => handle(c, Buffer.from(f)).catch((e) => emit('error', { message: String(e && e.message) })));
    sock.on('data', (d) => framer.push(d));
    sock.on('close', () => dropAllocation(c));
    sock.on('error', () => {});
  };
  // One port number for UDP and TCP, as a real deployment has.
  let port = 0;
  for (let tries = 0; tries < 50 && !port; tries++) {
    const p = 20000 + Math.floor(Math.random() * 20000);
    try {
      await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(p, fx.host, () => { udp.removeListener('error', reject); resolve(); }); });
      fx.tcp = net.createServer(onStream('tcp'));
      await new Promise((resolve, reject) => { fx.tcp.once('error', reject); fx.tcp.listen(p, fx.host, resolve); });
      port = p;
    } catch (e) { try { udp.close(); } catch (x) { /* retry */ } if (fx.tcp) { try { fx.tcp.close(); } catch (x) { /* retry */ } } if (tries === 49) throw e; }
  }
  fx.port = port;
  if (o.tls) {
    fx.tls = tls.createServer({ key: o.tls.key, cert: o.tls.cert }, onStream('tls'));
    await new Promise((resolve) => fx.tls.listen(0, fx.host, resolve));
    fx.tlsPort = fx.tls.address().port;
  }
  fx.urls = {
    udp: 'turn:' + fx.host + ':' + port, tcp: 'turn:' + fx.host + ':' + port + '?transport=tcp',
    tls: fx.tlsPort ? 'turns:' + fx.host + ':' + fx.tlsPort + '?transport=tcp' : null
  };
  fx.allocationCount = () => allocations.size;
  fx.users = new Set();
  fx.close = async () => {
    for (const a of [...allocations.values()]) dropAllocation(a.client);
    try { udp.close(); } catch (e) { /* closed */ }
    await new Promise((r) => fx.tcp.close(() => r()));
    if (fx.tls) await new Promise((r) => fx.tls.close(() => r()));
  };
  return fx;
}

module.exports = { selfSignedCert, startTurnFixture, localIPv4, classify, isDeniedPeer };
