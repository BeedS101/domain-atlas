#!/usr/bin/env node
// Checks a TURN server (coturn, as configured by call-server/deploy/coturn-turn.conf.example) from
// the outside, with the same time-limited credentials the Call Service would issue.
//
//   CALL_TURN_SECRET=... node call-server/turn-probe.js turn:turn.example.org:3478
//   node call-server/turn-probe.js turn:turn.example.org:3478?transport=tcp --secret-file /etc/atlas-call/turn-secret
//   node call-server/turn-probe.js turns:turn.example.org:5349 --secret-file F [--ca ca.pem]
//
// It allocates a relay, then checks that the server refuses what it must refuse: a wrong secret,
// an expired credential, a username without an expiry, permission for loopback, private, link-local
// and CGNAT peers, and TCP relaying; and that it does relay between two allocations. It sends no
// audio and uses no call. Every allocation it makes is released before it exits. Run it from a
// computer that is not the TURN server, because loopback and local-network rules are checked by
// asking the server for them, not by looking at its configuration.
//
// The file also holds the small STUN/TURN message codec and client the tests use. Zero dependencies.
'use strict';

const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const MAGIC = 0x2112A442;
const METHOD = { BINDING: 0x001, ALLOCATE: 0x003, REFRESH: 0x004, SEND: 0x006, DATA: 0x007, CREATE_PERMISSION: 0x008, CHANNEL_BIND: 0x009 };
const CLASS = { REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 };
const ATTR = {
  MAPPED: 0x0001, USERNAME: 0x0006, INTEGRITY: 0x0008, ERROR: 0x0009, CHANNEL: 0x000C, LIFETIME: 0x000D, XOR_PEER: 0x0012,
  DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015, XOR_RELAYED: 0x0016, REQ_TRANSPORT: 0x0019, XOR_MAPPED: 0x0020, SOFTWARE: 0x8022, FINGERPRINT: 0x8028
};

// ---------- message codec ----------

const typeOf = (method, cls) => (method & 0x000F) | ((cls & 1) << 4) | ((method & 0x0070) << 1) | ((cls & 2) << 7) | ((method & 0x0F80) << 2);
const parseType = (t) => ({ method: (t & 0xF) | ((t >> 1) & 0x70) | ((t >> 2) & 0xF80), cls: ((t >> 4) & 1) | ((t >> 7) & 2) });

function ipToBytes(ip) {
  if (net.isIPv4(ip)) return { family: 1, bytes: Buffer.from(ip.split('.').map(Number)) };
  if (!net.isIPv6(ip)) throw new Error('not an IP address');
  let [head, tail] = ip.split('::');
  const groups = (part) => (part ? part.split(':') : []).flatMap((g) => (g.includes('.') ? [((+g.split('.')[0] << 8) | +g.split('.')[1]).toString(16), ((+g.split('.')[2] << 8) | +g.split('.')[3]).toString(16)] : [g]));
  const h = groups(head), t = tail === undefined ? [] : groups(tail);
  const all = h.concat(tail === undefined ? [] : new Array(8 - h.length - t.length).fill('0'), t);
  const b = Buffer.alloc(16);
  all.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16), i * 2));
  return { family: 2, bytes: b };
}
function bytesToIp(b, family) {
  if (family === 1) return Array.from(b.subarray(0, 4)).join('.');
  const g = []; for (let i = 0; i < 16; i += 2) g.push(b.readUInt16BE(i).toString(16));
  return g.join(':');
}
function xorAddress(ip, port, txid) {
  const { family, bytes } = ipToBytes(ip);
  const out = Buffer.alloc(4 + bytes.length);
  out.writeUInt8(0, 0); out.writeUInt8(family, 1);
  out.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xA4, 0x42]), txid]);
  for (let i = 0; i < bytes.length; i++) out[4 + i] = bytes[i] ^ mask[i];
  return out;
}
function parseXorAddress(v, txid) {
  const family = v[1], len = family === 1 ? 4 : 16;
  const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xA4, 0x42]), txid]);
  const raw = Buffer.alloc(len);
  for (let i = 0; i < len; i++) raw[i] = v[4 + i] ^ mask[i];
  return { family, ip: bytesToIp(raw, family), port: v.readUInt16BE(2) ^ (MAGIC >>> 16) };
}
function errorValue(code, reason) {
  const r = Buffer.from(reason || '');
  return Buffer.concat([Buffer.from([0, 0, Math.floor(code / 100), code % 100]), r]);
}

// attrs: [[type, Buffer], ...]
function encode(method, cls, txid, attrs) {
  const parts = [];
  for (const [type, value] of attrs || []) {
    const h = Buffer.alloc(4); h.writeUInt16BE(type, 0); h.writeUInt16BE(value.length, 2);
    parts.push(h, value, Buffer.alloc((4 - (value.length % 4)) % 4));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(typeOf(method, cls), 0); head.writeUInt16BE(body.length, 2); head.writeUInt32BE(MAGIC, 4);
  txid.copy(head, 8);
  return Buffer.concat([head, body]);
}
// Appends MESSAGE-INTEGRITY computed with `key` (the length field covers the attribute, as RFC 5389 requires).
function withIntegrity(msg, key) {
  const copy = Buffer.from(msg);
  copy.writeUInt16BE(msg.length - 20 + 24, 2);
  const mac = crypto.createHmac('sha1', key).update(copy).digest();
  const attr = Buffer.alloc(24); attr.writeUInt16BE(ATTR.INTEGRITY, 0); attr.writeUInt16BE(20, 2); mac.copy(attr, 4);
  const out = Buffer.concat([msg, attr]);
  out.writeUInt16BE(out.length - 20, 2);
  return out;
}
function decode(buf) {
  if (buf.length < 20 || buf[0] > 0x3F || buf.readUInt32BE(4) !== MAGIC) return null;
  const len = buf.readUInt16BE(2);
  if (len % 4 !== 0 || buf.length < 20 + len) return null;
  const { method, cls } = parseType(buf.readUInt16BE(0));
  const attrs = [];
  let o = 20;
  while (o + 4 <= 20 + len) {
    const type = buf.readUInt16BE(o), l = buf.readUInt16BE(o + 2);
    if (o + 4 + l > 20 + len) return null;
    attrs.push({ type, value: buf.subarray(o + 4, o + 4 + l), offset: o });
    o += 4 + l + ((4 - (l % 4)) % 4);
  }
  return { method, cls, txid: buf.subarray(8, 20), attrs, raw: buf.subarray(0, 20 + len) };
}
function integrityOk(m, key) {
  const a = m.attrs.find((x) => x.type === ATTR.INTEGRITY);
  if (!a || a.value.length !== 20) return false;
  const copy = Buffer.from(m.raw.subarray(0, a.offset));
  copy.writeUInt16BE(a.offset - 20 + 24, 2);
  const mac = crypto.createHmac('sha1', key).update(copy).digest();
  return crypto.timingSafeEqual(mac, a.value);
}
const attrOf = (m, type) => { const a = m.attrs.find((x) => x.type === type); return a ? a.value : null; };
const errorCodeOf = (m) => { const v = attrOf(m, ATTR.ERROR); return v ? v[2] * 100 + v[3] : null; };
const longTermKey = (username, realm, password) => crypto.createHash('md5').update(username + ':' + realm + ':' + password).digest();

// Splits a TCP byte stream into STUN messages and ChannelData frames.
class Framer {
  constructor(onFrame) { this.buf = Buffer.alloc(0); this.onFrame = onFrame; }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 4) return;
      let total;
      if (this.buf[0] <= 0x3F) { if (this.buf.length < 20) return; total = 20 + this.buf.readUInt16BE(2); } else { total = 4 + this.buf.readUInt16BE(2); total += (4 - (total % 4)) % 4; }
      if (this.buf.length < total) return;
      const frame = this.buf.subarray(0, total);
      this.buf = this.buf.subarray(total);
      this.onFrame(frame);
    }
  }
}

// ---------- credentials, as the Call Service issues them ----------

function restCredential(secret, ttlSeconds, label) {
  const username = (Math.floor(Date.now() / 1000) + ttlSeconds) + ':' + (label || crypto.randomBytes(6).toString('base64url'));
  return { username, credential: crypto.createHmac('sha1', secret).update(username).digest('base64') };
}

// ---------- client ----------

class TurnClient {
  // opts: { transport: 'udp' | 'tcp' | 'tls', host, port, ca, servername, timeoutMs }
  constructor(opts) { this.o = Object.assign({ timeoutMs: 3000 }, opts); this.pending = new Map(); this.onData = null; this.creds = null; }
  open() {
    return new Promise((resolve, reject) => {
      const o = this.o;
      if (o.transport === 'udp') {
        this.sock = dgram.createSocket(net.isIPv6(o.host) ? 'udp6' : 'udp4');
        this.sock.on('message', (m) => this.frame(m));
        this.sock.on('error', reject);
        this.sock.connect(o.port, o.host, () => resolve(this));
        return;
      }
      const framer = new Framer((f) => this.frame(f));
      const onConnect = () => resolve(this);
      this.sock = o.transport === 'tls'
        ? tls.connect({ host: o.host, port: o.port, ca: o.ca, servername: o.servername || (net.isIP(o.host) ? undefined : o.host) }, onConnect)
        : net.connect(o.port, o.host, onConnect);
      this.sock.on('data', (c) => framer.push(c));
      this.sock.on('error', reject);
    });
  }
  close() {
    try { if (this.o.transport === 'udp') this.sock.close(); else this.sock.destroy(); } catch (e) { /* closed */ }
    for (const p of this.pending.values()) { clearInterval(p.timer); p.resolve(null); }
    this.pending.clear();
  }
  frame(buf) {
    const m = decode(buf);
    if (!m) return;
    if (m.cls === CLASS.INDICATION && m.method === METHOD.DATA) {
      const peer = attrOf(m, ATTR.XOR_PEER), data = attrOf(m, ATTR.DATA);
      if (peer && data && this.onData) this.onData({ peer: parseXorAddress(peer, m.txid), data: Buffer.from(data) });
      return;
    }
    const p = this.pending.get(m.txid.toString('hex'));
    if (p) { this.pending.delete(m.txid.toString('hex')); clearInterval(p.timer); p.resolve(m); }
  }
  write(buf) { if (this.o.transport === 'udp') this.sock.send(buf); else this.sock.write(buf); }
  // attrs is a list of [type, Buffer], or a function of the transaction id that returns one (addresses are masked with it).
  request(method, attrs, key) {
    const txid = crypto.randomBytes(12);
    let msg = encode(method, CLASS.REQUEST, txid, typeof attrs === 'function' ? attrs(txid) : attrs);
    if (key) msg = withIntegrity(msg, key);
    return new Promise((resolve) => {
      const id = txid.toString('hex');
      const tries = this.o.transport === 'udp' ? 3 : 1;
      let n = 0;
      const send = () => { this.write(msg); n++; };
      const timer = setInterval(() => { if (n >= tries) { clearInterval(timer); this.pending.delete(id); resolve(null); } else send(); }, Math.ceil(this.o.timeoutMs / tries));
      this.pending.set(id, { resolve, timer });
      send();
    });
  }
  authed(method, attrs) {
    const c = this.creds;
    const extra = [[ATTR.USERNAME, Buffer.from(c.username)], [ATTR.REALM, Buffer.from(c.realm)], [ATTR.NONCE, Buffer.from(c.nonce)]];
    return this.request(method, typeof attrs === 'function' ? (t) => attrs(t).concat(extra) : attrs.concat(extra), c.key);
  }
  async authedRetry(method, attrs) {
    let r = await this.authed(method, attrs);
    if (r && r.cls === CLASS.ERROR && errorCodeOf(r) === 438) {
      const nonce = attrOf(r, ATTR.NONCE);
      if (nonce) { this.creds.nonce = nonce.toString(); r = await this.authed(method, attrs); }
    }
    return r;
  }
  result(r) {
    if (!r) return { ok: false, code: 0, timeout: true };
    if (r.cls === CLASS.SUCCESS) return { ok: true, msg: r };
    return { ok: false, code: errorCodeOf(r) || 0 };
  }
  // protocol: 17 = UDP relay, 6 = TCP relay (which a well-configured server refuses)
  async allocate(username, password, protocol) {
    const attrs = [[ATTR.REQ_TRANSPORT, Buffer.from([protocol || 17, 0, 0, 0])]];
    const first = await this.request(METHOD.ALLOCATE, attrs);
    if (!first) return this.result(first);
    if (!(first.cls === CLASS.ERROR && errorCodeOf(first) === 401)) return first.cls === CLASS.SUCCESS ? this.parseAllocate(first) : this.result(first);
    const realm = attrOf(first, ATTR.REALM), nonce = attrOf(first, ATTR.NONCE);
    if (!realm || !nonce) return { ok: false, code: 401, noChallenge: true };
    this.creds = { username, realm: realm.toString(), nonce: nonce.toString(), key: longTermKey(username, realm.toString(), password) };
    const r = await this.authedRetry(METHOD.ALLOCATE, attrs);
    return r && r.cls === CLASS.SUCCESS ? this.parseAllocate(r) : this.result(r);
  }
  parseAllocate(r) {
    const rel = attrOf(r, ATTR.XOR_RELAYED), map = attrOf(r, ATTR.XOR_MAPPED), life = attrOf(r, ATTR.LIFETIME);
    return { ok: true, relayed: rel ? parseXorAddress(rel, r.txid) : null, mapped: map ? parseXorAddress(map, r.txid) : null, lifetime: life ? life.readUInt32BE(0) : null };
  }
  async createPermission(ip) {
    return this.result(await this.authedRetry(METHOD.CREATE_PERMISSION, (t) => [[ATTR.XOR_PEER, xorAddress(ip, 0, t)]]));
  }
  async refresh(lifetime) {
    const r = await this.authedRetry(METHOD.REFRESH, [[ATTR.LIFETIME, Buffer.from([lifetime >>> 24, (lifetime >>> 16) & 255, (lifetime >>> 8) & 255, lifetime & 255])]]);
    return this.result(r);
  }
  send(ip, port, data) {
    const txid = crypto.randomBytes(12);
    this.write(encode(METHOD.SEND, CLASS.INDICATION, txid, [[ATTR.XOR_PEER, xorAddress(ip, port, txid)], [ATTR.DATA, Buffer.from(data)]]));
  }
}

// ---------- the probe ----------

// Peers a relay must never reach: this computer, local networks, link-local (cloud metadata),
// carrier-grade NAT, and the "this network" block.
const DENIED_PEERS = ['127.0.0.1', '127.8.8.8', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0'];

async function runProbe(o, say) {
  const { url, secret } = o;
  let fails = 0;
  const pass = (n, d) => say('PASS ' + n + (d ? ' :: ' + d : ''));
  const bad = (n, d) => { fails++; say('FAIL ' + n + (d ? ' :: ' + d : '')); };
  const warn = (n, d) => say('WARN ' + n + (d ? ' :: ' + d : ''));
  const transport = url.scheme === 'turns' ? 'tls' : (url.transport || 'udp');
  const open = () => new TurnClient({ transport, host: url.host.replace(/^\[|\]$/g, ''), port: url.port, ca: o.ca, timeoutMs: o.timeoutMs || 3000 }).open();
  const cleanup = [];
  try {
    let a;
    try { a = await open(); cleanup.push(a); } catch (e) { bad('the server accepts a connection', String(e && e.code || e && e.message)); return fails; }
    pass('the server accepts a ' + transport.toUpperCase() + ' connection');

    // a valid credential
    const good = restCredential(secret, 300);
    const al = await a.allocate(good.username, good.credential, 17);
    if (al.ok && al.relayed) pass('a valid time-limited credential gets a relay', al.relayed.ip + ':' + al.relayed.port + ', lifetime ' + al.lifetime + ' s');
    else { bad('a valid time-limited credential gets a relay', 'error ' + al.code + (al.code === 401 ? ' (secret differs from the one in the server, or use-auth-secret is off)' : '') + (al.timeout ? ' (no answer)' : '')); return fails; }
    if (al.lifetime && al.lifetime > 3700) warn('allocation lifetime', al.lifetime + ' s; consider max-allocate-lifetime');

    // credentials that must not work
    const refused = async (name, username, password, protocol) => {
      const c = await open(); cleanup.push(c);
      const r = await c.allocate(username, password, protocol);
      if (r.ok) { bad(name, 'the server granted a relay'); try { await c.refresh(0); } catch (e) { /* ignore */ } } else pass(name, r.timeout ? 'no answer' : 'error ' + r.code);
      c.close();
    };
    const wrong = restCredential(crypto.randomBytes(32).toString('hex'), 300);
    await refused('a credential made with a different secret is refused', wrong.username, wrong.credential, 17);
    const expired = restCredential(secret, -120);
    await refused('an expired credential is refused', expired.username, expired.credential, 17);
    const noStamp = 'probe-' + crypto.randomBytes(4).toString('hex');
    await refused('a username without an expiry is refused', noStamp, crypto.createHmac('sha1', secret).update(noStamp).digest('base64'), 17);
    await refused('an empty password is refused', good.username, '', 17);
    const tcpRelay = restCredential(secret, 300);
    await refused('a TCP relay (RFC 6062) is refused', tcpRelay.username, tcpRelay.credential, 6);

    // addresses a relay must not reach
    let denied = 0;
    for (const ip of DENIED_PEERS) {
      const r = await a.createPermission(ip);
      if (r.ok) bad('permission for ' + ip + ' is refused', 'the server would relay to it; add denied-peer-ip'); else denied++;
    }
    if (denied === DENIED_PEERS.length) pass('permission for loopback, private, link-local, carrier-grade NAT and unspecified peers is refused', denied + ' addresses');
    const v6 = await a.createPermission('::1');
    if (v6.ok) bad('permission for an IPv6 peer is refused on an IPv4 relay', 'granted'); else pass('permission for an IPv6 peer is refused on an IPv4 relay', 'error ' + v6.code);

    // relaying between two allocations
    const b = await open(); cleanup.push(b);
    const credB = restCredential(secret, 300);
    const bl = await b.allocate(credB.username, credB.credential, 17);
    if (!bl.ok) { warn('relay between two allocations', 'second allocation failed with ' + bl.code + (bl.code === 486 ? ' (quota reached; raise user-quota for the probe)' : '')); }
    else {
      const control = await a.createPermission('203.0.113.9');
      if (control.ok) pass('permission for an ordinary public address is granted (so the refusals above mean something)');
      else warn('permission for an ordinary public address is granted', 'error ' + control.code + '; the refusals above may not be specific');
      const pa = await a.createPermission(bl.relayed.ip), pb = await b.createPermission(al.relayed.ip);
      if (!pa.ok || !pb.ok) warn('relay between two allocations', 'permission for the relay address itself was refused (' + (pa.code || pb.code) + '); a relay on a private address cannot be probed this way');
      else {
        const got = new Promise((resolve) => { b.onData = (d) => resolve(d); setTimeout(() => resolve(null), 3000); });
        const payload = crypto.randomBytes(24);
        a.send(bl.relayed.ip, bl.relayed.port, payload);
        const d = await got;
        if (d && d.data.equals(payload)) pass('data sent through one relay reaches the other', transport.toUpperCase() + ' to the server, UDP between relays');
        else warn('data sent through one relay reaches the other', 'nothing arrived; check relay port range and external-ip');
      }
      await b.refresh(0);
    }

    // release
    const rel = await a.refresh(0);
    if (rel.ok) pass('the probe\'s allocation was released'); else warn('the probe\'s allocation was released', 'error ' + rel.code);
  } finally {
    for (const c of cleanup) c.close();
  }
  return fails;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const fs = require('fs');
  const P = require('./protocol');
  const url = args.map((a) => P.parseIceUrl(a)).find((u) => u && u.turn);
  if (!url) { console.log('usage: [CALL_TURN_SECRET=...] node call-server/turn-probe.js turn:host[:port][?transport=tcp] | turns:host[:port] [--secret-file F] [--ca ca.pem]'); process.exit(2); }
  let secret = process.env.CALL_TURN_SECRET || null;
  if (opt('--secret-file')) { try { secret = fs.readFileSync(opt('--secret-file'), 'utf8').trim(); } catch (e) { console.log('cannot read the secret file'); process.exit(2); } }
  if (!secret) { console.log('give the shared secret in CALL_TURN_SECRET or --secret-file'); process.exit(2); }
  runProbe({ url, secret, ca: opt('--ca') ? fs.readFileSync(opt('--ca')) : undefined }, (l) => console.log(l)).then((fails) => {
    console.log('\n' + (fails ? 'Failed: ' + fails + ' check(s)' : 'No failures') + '. This does not test a call, audio quality or user quotas.');
    process.exit(fails ? 1 : 0);
  }, (e) => { console.error(e); process.exit(2); });
}

module.exports = { MAGIC, METHOD, CLASS, ATTR, typeOf, parseType, ipToBytes, bytesToIp, xorAddress, parseXorAddress, errorValue, encode, withIntegrity, decode, integrityOk, attrOf, errorCodeOf, longTermKey, Framer, restCredential, TurnClient, runProbe, DENIED_PEERS };
