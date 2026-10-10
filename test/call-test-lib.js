// Shared helpers for the call tests: key generation, signing, a minimal signalling client
// and a fake issuer. This signs with plain WebCrypto and canonicalizes with the shared
// protocol module, independently of the wallet code under test.
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', 'call-server', 'protocol.js'));
const { createCallService } = require(path.join(__dirname, '..', 'call-server', 'server.js'));

const subtle = crypto.subtle;
let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
function finish(label) {
  console.log('\n' + label + ': ' + passes + ' passed, ' + failures + ' failed');
  return failures ? 1 : 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { priv: kp.privateKey, pub: P.b64urlEncode(raw) };
}
async function sign(payload, ident) {
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ident.priv, new TextEncoder().encode(P.canonicalize(payload))));
  return { signerRole: 'raw-ecdsa', publicKey: ident.pub, signature: P.b64urlEncode(sig) };
}
const iso = (ms) => new Date(ms).toISOString();

// A fake domain issuer: signs Post Office membership credentials the way issuer-server does.
async function newIssuer(domain) {
  const ident = await newIdentity();
  const revoked = [];
  return {
    ident, domain, revoked,
    async membership(ownerKey, over) {
      const cred = Object.assign({
        credential: 'domain-atlas-asset/1.0', id: 'urn:atlas:asset:' + P.randomId(12),
        asset: { class: 'atlas.postoffice.membership', fungible: false, tradeScope: 'bound' },
        owner: { publicKey: ownerKey }, quantity: 1, supersedes: null, issuedAt: iso(Date.now() - 1000),
        issuer: { domain }
      }, over || {});
      const payload = { id: cred.id, asset: cred.asset, owner: cred.owner, quantity: cred.quantity, supersedes: cred.supersedes, issuedAt: cred.issuedAt };
      cred.signature = (await sign(payload, ident)).signature;
      return cred;
    }
  };
}

async function post(base, route, body, raw) {
  const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw !== undefined ? raw : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, json };
}

const nonce = () => P.randomId(16);

function base(type, origin, extra) {
  return Object.assign({ type, v: 1, audience: origin, issuedAt: iso(Date.now()) }, extra);
}

// Starts a service in this process on a random loopback port.
async function startService(over, opts) {
  const issuer = (opts && opts.issuer) || await newIssuer('example.com');
  const cfg = Object.assign({
    configured: true, origin: 'http://127.0.0.1:0', domain: issuer.domain, issuerKeys: [issuer.ident.pub], revocationsUrl: null,
    stateFile: null, stunUrls: [], bind: '127.0.0.1', port: 0, trustProxy: false, devAllowHttp: true, devAllowPrivateFetch: true
  }, over || {});
  // The audience is the service's own origin, so the port is chosen first and then fixed.
  const net = require('net');
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  cfg.port = port;
  if (!over || !over.origin) cfg.origin = 'http://127.0.0.1:' + port;
  const svc = createCallService(cfg, Object.assign({ quiet: true }, opts || {}));
  await svc.listen();
  return { svc, cfg, issuer, base: 'http://127.0.0.1:' + port, origin: cfg.origin };
}

// Protocol-level client for tests: one wallet identity talking to a service.
class Wallet {
  constructor(ident, ctx, name) { this.ident = ident; this.ctx = ctx; this.name = name || 'wallet'; }
  static async create(ctx, name) { return new Wallet(await newIdentity(), ctx, name); }
  get pub() { return this.ident.pub; }

  async createTag(callerKey, over, membership) {
    const payload = Object.assign(base('atlas.call.tag', this.ctx.origin, {
      nonce: nonce(), bind: { kind: 'wallet', publicKey: callerKey }, calleeKey: this.pub,
      expiresAt: iso(Date.now() + 3600000), maxCalls: 10
    }), over || {});
    const proof = await sign(payload, this.ident);
    const m = membership !== undefined ? membership : await this.ctx.issuer.membership(this.pub);
    return post(this.ctx.base, '/atlas/call/tag/create', { payload, proof, membership: m });
  }

  async session(ttlMs) {
    const sk = await newIdentity();
    const payload = base('atlas.call.listen-session', this.ctx.origin, { expiresAt: iso(Date.now() + (ttlMs || 600000)), sessionKey: sk.pub });
    return { sk, delegation: { payload, proof: await sign(payload, this.ident) } };
  }

  async sessionRequest(route, type, extra, session) {
    session = session || this.sess || (this.sess = await this.session());
    const payload = base(type, this.ctx.origin, Object.assign({ nonce: nonce() }, extra));
    return post(this.ctx.base, route, { payload, proof: await sign(payload, session.sk), session: session.delegation });
  }
  listen(ack, session) { return this.sessionRequest('/atlas/call/listen', 'atlas.call.listen', { ack: ack || [] }, session); }
  listTags(session) { return this.sessionRequest('/atlas/call/tag/list', 'atlas.call.tag-list', {}, session); }
  revokeTag(tag, session) { return this.sessionRequest('/atlas/call/tag/revoke', 'atlas.call.tag-revoke', { tag }, session); }
  async revokeAll() {
    const payload = base('atlas.call.tag-revoke', this.ctx.origin, { nonce: nonce(), all: true });
    return post(this.ctx.base, '/atlas/call/tag/revoke', { payload, proof: await sign(payload, this.ident) });
  }

  // Builds (does not send) an invite and returns {body, callId, callKey, invitePayload}.
  async buildInvite(tag, calleeKey, over) {
    const ck = await newIdentity();
    const callId = P.randomId(16);
    const payload = Object.assign(base('atlas.call.invite', this.ctx.origin, {
      callId, tag, nonce: P.randomId(16), expiresAt: iso(Date.now() + 45000),
      caller: { kind: 'wallet', publicKey: this.pub }, callee: { publicKey: calleeKey }, callKey: ck.pub,
      media: { kind: 'audio', fingerprints: [fp('A')] }
    }), over || {});
    const proof = await sign(payload, this.ident);
    return { body: { tag, invite: { payload, proof } }, callId, ck, payload, proof };
  }
  invite(built) { return post(this.ctx.base, '/atlas/call/invite', built.body); }

  async poll(callId, ck, after, over) {
    const payload = base('atlas.call.poll', this.ctx.origin, Object.assign({ nonce: nonce(), callId, after: after || 0 }, over));
    return post(this.ctx.base, '/atlas/call/poll', { payload, proof: await sign(payload, ck) });
  }
  async ice(callId, ck) {
    const payload = base('atlas.call.ice', this.ctx.origin, { nonce: nonce(), callId });
    return post(this.ctx.base, '/atlas/call/ice', { payload, proof: await sign(payload, ck) });
  }
}

function fp(seed) {
  const hex = [];
  for (let i = 0; i < 32; i++) hex.push(((seed.charCodeAt(0) * 7 + i * 13) & 255).toString(16).toUpperCase().padStart(2, '0'));
  return 'sha-256 ' + hex.join(':');
}

function signalPayload(ctx, callId, kind, body, seq, th) {
  const p = { type: 'atlas.call.signal', v: 1, audience: ctx.origin, callId, kind, body };
  if (seq !== undefined) p.seq = seq;
  if (th !== undefined) p.th = th;
  return p;
}
async function sendSignal(ctx, payload, ident, session) {
  const msg = { payload, proof: await sign(payload, ident) };
  if (session) msg.session = session;
  return post(ctx.base, '/atlas/call/signal', msg);
}

module.exports = { P, check, finish, sleep, newIdentity, sign, iso, newIssuer, post, nonce, base, startService, Wallet, fp, signalPayload, sendSignal };
