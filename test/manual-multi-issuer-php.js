// Security and workflow tests for the Multi-Issuer Portable Asset Lab (issuer-php/atlas/demo/multi-issuer).
// Every domain is a separate `php -S` server with its own docroot, signing key, private directory and
// SQLite file; the domains reach each other only over HTTP through the discovery manifests they publish.
// A third site that is not an issuer, and servers with three and four independently keyed domains,
// take part where the scenario needs them.
//
//   node test/manual-multi-issuer-php.js
//
// Needs php with pdo_sqlite, openssl and curl. Exits non-zero on the first failed check.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Lab, makeOwner, buildTransfer, reqId, canonicalize, sha256hex, digestOf, keyIdOf, signWithPem, verifySig, verifyPortableJs, php, sleep, freePort, API, MI_SRC, REPO, TOOL } = require('./mi-lab.js');

let lab = new Lab('mi-php-');
const assert = (c, m) => lab.assert(c, m);
let total = 0;
const pass = (m) => { total++; console.log('PASS: ' + m); };
const BIG = 'callsPerIpPerMinute=10000,approvalsPerIpPerMinute=600,sessionsPerIpPerHour=1000,assetsPerIpPerHour=1000,transfersPerIpPerHour=2000,maxSessions=5000,maxAssetsPerSession=50,maxTransfersPerSession=100,maxPendingTransfersGlobal=1000,maxInflightPeer=32,peerRequestsPerHour=100000';
const call = (label, op, o) => lab.raw(label, op, o);

async function session(label) {
  const r = await call(label, 'public-start', { body: {} });
  assert(r.status === 200, 'session start: ' + r.status + ' ' + JSON.stringify(r.body));
  return { sid: r.body.sid, token: r.body.token, label };
}
const auth = (s) => ({ sid: s.sid, token: s.token });
async function createAsset(label, s, owner, extra) {
  const r = await call(label, 'public-asset-create', { body: Object.assign({}, auth(s), { requestId: reqId(), ownerPublicKey: owner.pub, label: 'test' }, extra || {}) });
  return r;
}
const issueOne = (label, s, id, domain) => call(label, 'public-issue-approve', { body: Object.assign({}, auth(s), { assetId: id, domain }) });
async function issued(label, s, owner, domains) {
  const r = await createAsset(label, s, owner);
  assert(r.status === 200, 'create asset: ' + JSON.stringify(r.body));
  const id = r.body.asset.definition.assetId;
  for (const d of domains || ['a.test', 'b.test']) {
    const x = await issueOne(label, s, id, d);
    assert(x.status === 200 && x.body.decision === 'approve', 'issuance approval by ' + d + ': ' + JSON.stringify(x.body));
  }
  const v = (await call(label, 'asset', { id })).body;
  assert(v.status === 'issued', 'asset issued: ' + v.status);
  return { id, view: v };
}
const view = async (label, id, nonce) => (await call(label, 'asset', { id, nonce })).body;
const txView = async (label, id) => (await call(label, 'tx', { id })).body;
const propose = (label, s, t) => call(label, 'public-transfer-propose', { body: Object.assign({}, auth(s), { payload: t.payload, ownerAuthorization: t.auth, ownerSignature: t.signature }) });
const approveTx = (label, s, txId, domain) => call(label, 'public-transfer-approve', { body: Object.assign({}, auth(s), { txId, domain }) });
async function fullTransfer(label, s, id, from, toPub, domains) {
  const v = await view(label, id);
  const t = buildTransfer(v, from, toPub, s.sid);
  const p = await propose(label, s, t);
  assert(p.status === 200, 'propose: ' + JSON.stringify(p.body));
  for (const d of domains || ['a.test', 'b.test']) {
    const x = await approveTx(label, s, t.payload.txId, d);
    assert(x.status === 200, 'approve ' + d + ': ' + JSON.stringify(x.body));
  }
  return t;
}
const keyOf = (name) => lab.ids[name];
const pemOf = (name) => lab.ids[name].pem;
function peerRequest(from, to, op, ref, digest, over0) {
  const over = Object.assign({}, over0 || {});
  const signer = over.signWith || from;
  delete over.signWith;
  const req = Object.assign({ v: 'domain-atlas-mi-peer-request/1', op, ref, digest, requester: keyOf(from).domain, target: keyOf(to).domain, requestedAtMs: Date.now(), nonce: crypto.randomBytes(16).toString('hex') }, over || {});
  return { request: req, signature: signWithPem(pemOf(signer), req) };
}
function approvalFrom(signer, refId, digest, decision, approverDomain) {
  const a = { v: 'domain-atlas-txlab-approval/1', txId: refId, payloadDigest: digest, approver: approverDomain || keyOf(signer).domain, decision: decision || 'approve', approvedAtMs: Date.now() };
  return { approval: a, signature: signWithPem(pemOf(signer), a) };
}
const copyJson = (o) => JSON.parse(JSON.stringify(o));
let step = 0;
async function T(name, fn) { step++; await fn(); pass(name); }

// A stand-in state authority the tests control completely; used to hand an approving domain evidence
// that the real registry would never produce.
function fakeAuthority() {
  const srv = { handler: null, hits: 0 };
  srv.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      srv.hits++;
      let out = { status: 404, json: { error: 'none' } };
      try { out = await srv.handler(req.url, raw ? JSON.parse(raw) : null); } catch (e) { out = { status: 500, json: { error: String(e) } }; }
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => srv.server.listen(0, '127.0.0.1', () => { srv.port = srv.server.address().port; srv.url = 'http://127.0.0.1:' + srv.port + '/api.php'; resolve(srv); }));
}

async function main() {
  // ============================================================ the live shape: two independent domains
  await lab.network({ names: ['a', 'b'], state: 'a', issuance: { t: 2, m: ['a', 'b'] }, transfer: { t: 2, m: ['a', 'b'] }, pub: BIG });
  // a third Domain Atlas site that is not an issuer: it knows nobody and only fetches what an asset points to
  lab.identity('t', 't.test');
  await lab.site('t', { identity: 't', state: 't', roster: ['t'], issuance: { t: 1, m: ['t'] }, transfer: { t: 1, m: ['t'] }, pub: BIG, open: true, extraOverrides: ['a', 'b'] });
  lab.configure('t'); lab.publish('t'); await lab.start('t');
  // same, but with open discovery off
  lab.identity('t2', 't2.test');
  await lab.site('t2', { identity: 't2', state: 't2', roster: ['t2'], issuance: { t: 1, m: ['t2'] }, transfer: { t: 1, m: ['t2'] }, pub: BIG, open: false, extraOverrides: ['a', 'b'] });
  lab.configure('t2'); lab.publish('t2'); await lab.start('t2');

  const alice = makeOwner('alice'), bob = makeOwner('bob'), carol = makeOwner('carol'), mallory = makeOwner('mallory');

  // ============================================================ health, fail-closed configuration
  await T('health: both domains report their role, roster and policies (no secrets)', async () => {
    const ha = (await call('a', 'health')).body, hb = (await call('b', 'health')).body;
    assert(ha.enabled && ha.role === 'state-authority' && hb.enabled && hb.role === 'approver', 'roles');
    assert(ha.stateAuthority === 'a.test' && hb.stateAuthority === 'a.test', 'state authority');
    assert(ha.keyId !== hb.keyId, 'independent keys');
    assert(ha.issuance.threshold === 2 && ha.transfer.mandatory.length === 2, 'policies');
    const text = JSON.stringify([ha, hb]);
    assert(!/PRIVATE KEY|signing-key|token_hash/.test(text), 'no secrets in health');
  });

  await T('the lab is off by default: no config means 503 and no operation works', async () => {
    lab.identity('off', 'off.test');
    await lab.site('off', { identity: 'off', state: 'off', roster: ['off'], issuance: { t: 1, m: ['off'] }, transfer: { t: 1, m: ['off'] }, pub: '' });
    await lab.start('off'); // no configure(): the private directory holds only a key
    const h = await call('off', 'health');
    assert(h.status === 200 && h.body.enabled === false && h.body.reasons.length > 0, 'health says disabled: ' + JSON.stringify(h.body));
    for (const [op, body] of [['public-start', {}], ['asset', undefined], ['peer-fetch', {}]]) {
      const r = await call('off', op, body === undefined ? { id: crypto.randomUUID() } : { body });
      assert(r.status === 503, op + ' refused while disabled: ' + r.status);
    }
  });

  await T('fail closed: a private directory inside the web root, a world-readable key or a mismatched key disables the lab', async () => {
    lab.identity('bad', 'bad.test');
    lab.identity('other', 'other.test');
    const mk = async (label, mutate) => {
      await lab.site(label, { identity: 'bad', state: 'bad', roster: ['bad'], issuance: { t: 1, m: ['bad'] }, transfer: { t: 1, m: ['bad'] }, pub: '' });
      lab.configure(label);
      mutate(lab.sites[label]);
      await lab.start(label);
      return (await call(label, 'health')).body;
    };
    let h = await mk('bad1', (s) => fs.chmodSync(path.join(s.privDir, 'signing-key.pem'), 0o644));
    assert(h.enabled === false && /readable by other/.test(JSON.stringify(h.reasons)), 'group-readable key refused: ' + JSON.stringify(h));
    h = await mk('bad2', (s) => fs.copyFileSync(path.join(lab.ids.other.dir, 'signing-key.pem'), path.join(s.privDir, 'signing-key.pem')));
    assert(h.enabled === false && /does not match/.test(JSON.stringify(h.reasons)), 'mismatched key refused: ' + JSON.stringify(h));
    // private directory moved under the document root
    await lab.site('bad3', { identity: 'bad', state: 'bad', roster: ['bad'], issuance: { t: 1, m: ['bad'] }, transfer: { t: 1, m: ['bad'] }, pub: '' });
    lab.configure('bad3');
    const s3 = lab.sites.bad3;
    const inside = path.join(s3.docroot, 'private');
    fs.cpSync(s3.privDir, inside, { recursive: true });
    s3.privDir = inside;
    await lab.start('bad3');
    h = (await call('bad3', 'health')).body;
    assert(h.enabled === false && /inside the web root/.test(JSON.stringify(h.reasons)), 'private dir inside the web root refused: ' + JSON.stringify(h));
    // policy that does not require the state authority is invalid
    await lab.site('bad4', { identity: 'bad', state: 'bad', roster: ['bad', 'other'], issuance: { t: 1, m: ['other'] }, transfer: { t: 1, m: ['bad'] }, pub: '' });
    lab.configure('bad4');
    await lab.start('bad4');
    h = (await call('bad4', 'health')).body;
    assert(h.enabled === false && /state authority/.test(JSON.stringify(h.reasons)), 'a policy without the state authority is refused: ' + JSON.stringify(h));
  });

  // ============================================================ joint issuance
  const S = await session('a');
  let main; // the asset used through the first scenarios
  await T('joint issuance: one issuer alone leaves the asset pending and valid for nobody', async () => {
    const r = await createAsset('a', S, alice);
    assert(r.status === 200 && r.body.status === 'pending', 'create: ' + JSON.stringify(r.body));
    const id = r.body.asset.definition.assetId;
    assert(r.body.asset.definition.metadata.testOnly === true && /^Joint Explorer Certificate #\d{6}$/.test(r.body.asset.definition.name), 'test-only certificate');
    const x = await issueOne('a', S, id, 'a.test');
    assert(x.status === 200 && x.body.decision === 'approve', 'A approves: ' + JSON.stringify(x.body));
    const v = await view('a', id);
    assert(v.status === 'pending', 'still pending');
    assert(v.verification.issuance.signedBy.length === 1 && v.verification.issuance.signedBy[0] === 'a.test', 'only A signed');
    assert(v.verification.issuance.roster.length === 2, 'roster still lists both');
    assert(v.verification.originalIssuanceVerified === false, 'issuance NOT verified with one signer');
    assert(v.live === null, 'no ownership exists before issuance completes');
    const js = await verifyPortableJs(v.asset);
    assert(js.issuanceVerified === false && js.signedBy.length === 1, 'independent JS verifier agrees');
    // a transfer proposal against a pending asset is refused
    const t = buildTransfer({ asset: v.asset, live: { version: 0, stateDigest: '0'.repeat(64) } }, alice, bob.pub, S.sid);
    const p = await propose('a', S, t);
    assert(p.status === 409, 'cannot transfer an unissued asset: ' + p.status);
    main = { id, view: v };
  });

  await T('joint issuance: the second issuer validates independently and the asset becomes valid', async () => {
    const x = await issueOne('a', S, main.id, 'b.test');
    assert(x.status === 200 && x.body.signedBy === 'b.test' && x.body.decision === 'approve', 'B approves: ' + JSON.stringify(x.body));
    const v = await view('a', main.id);
    assert(v.status === 'issued' && v.verification.originalIssuanceVerified === true, 'issued and verified');
    assert(v.verification.issuance.signedBy.sort().join() === 'a.test,b.test', 'both signed');
    assert(v.live.version === 0 && v.live.owner === alice.pub, 'registered to the original owner at version 0');
    const d = v.asset.definition;
    for (const k of ['assetId', 'class', 'metadata', 'originalOwner', 'issuers', 'issuancePolicy', 'transferPolicy', 'stateAuthority']) assert(d[k] !== undefined, 'definition carries ' + k);
    assert(d.issuers.length === 2 && d.issuers.every((i) => i.keyId && i.publicKey && i.discovery.manifest.startsWith('https://') && i.discovery.capabilities.length), 'roster with keys and discovery references');
    assert(!JSON.stringify(d).includes('127.0.0.1'), 'no endpoint is embedded in the asset');
    assert(v.asset.issuance.signatures.length === 2, 'both signatures embedded');
    const js = await verifyPortableJs(v.asset);
    assert(js.definitionDigestOk && js.issuanceVerified && js.chainValid && js.version === 0 && js.owner === alice.pub, 'independent verification of the whole document: ' + JSON.stringify(js));
    // approvals reference the identical digest
    assert(v.asset.issuance.signatures.every((s) => s.approval.payloadDigest === v.asset.definitionDigest && s.approval.txId === d.assetId), 'identical digest');
  });

  await T('independence: B holds no asset or ownership state, only its own signing record', async () => {
    assert(lab.sql('b', 'SELECT COUNT(*) AS n FROM assets')[0].n == 0, 'B has no asset rows');
    assert(lab.sql('b', 'SELECT COUNT(*) AS n FROM asset_state')[0].n == 0, 'B has no ownership state');
    const sl = lab.sql('b', "SELECT kind, decision, ref_id FROM signed_log WHERE kind='issue'");
    assert(sl.length === 1 && sl[0].ref_id === main.id && sl[0].decision === 'approve', 'B recorded its own signature');
    const ev = lab.sql('b', "SELECT kind FROM events WHERE ref_id = '" + main.id + "'").map((e) => e.kind);
    assert(ev.includes('peer-approval-signed'), 'B logged that it validated and signed: ' + ev.join());
    const keysA = fs.readFileSync(path.join(lab.sites.a.privDir, 'signing-key.pem'), 'utf8'), keysB = fs.readFileSync(path.join(lab.sites.b.privDir, 'signing-key.pem'), 'utf8');
    assert(keysA !== keysB && lab.sites.a.privDir !== lab.sites.b.privDir, 'separate keys and storage');
  });

  await T('B and a third site display and re-verify the same asset', async () => {
    const vb = await view('b', main.id);
    assert(vb.role === 'approver' && vb.relayedFrom === 'a.test', 'B relays from the state authority');
    assert(vb.verification.originalIssuanceVerified === true && vb.trust.ok === true, 'B verifies under its own pinned keys');
    assert(vb.currentOwnership.status === 'current' && vb.currentOwnership.checked === true, 'B checked the signed, nonce-bound registry attestation: ' + JSON.stringify(vb.currentOwnership));
    assert(vb.thisDomainSigned && vb.thisDomainSigned.decision === 'approve', 'B shows its own signature');
    assert(vb.discovery.every((d) => d.ok && d.services['asset.transfer.approve']), 'B discovered both issuers');
    const exported = JSON.parse(JSON.stringify((await view('a', main.id)).asset));
    for (const [label, opts] of [['t', { trustOk: false, online: 'current' }], ['t2', { trustOk: false, online: 'unreachable' }]]) {
      const r = await call(label, 'verify', { body: { asset: exported, online: true } });
      assert(r.status === 200, label + ' verify: ' + JSON.stringify(r.body));
      assert(r.body.verification.originalIssuanceVerified === true, label + ': original issuance verifies offline');
      assert(r.body.trust.ok === opts.trustOk, label + ': does not pin these issuers');
      assert(r.body.currentOwnership.status === opts.online, label + ' current ownership: ' + JSON.stringify(r.body.currentOwnership));
      if (label === 't') assert(r.body.discovery.every((d) => d.ok && d.services['asset.state'] !== undefined || d.domain === 'b.test'), 't discovered the issuers from the asset alone');
      if (label === 't2') assert(r.body.discovery.every((d) => d.status === 'skipped'), 't2: open discovery off, nothing was requested');
    }
    // offline: the document alone says nothing about CURRENT ownership
    const off = await call('t', 'verify', { body: { asset: exported, online: false } });
    assert(off.body.currentOwnership.checked === false && off.body.currentOwnership.status === 'not-checked', 'offline check never claims current ownership');
    assert(off.body.verification.ownership.chainValid === true, 'the evidence chain itself verifies');
    assert(off.body.policy.transfer.threshold === 2 && off.body.policy.stateAuthority.domain === 'a.test', 'a third site reads the authorization policy from the asset');
  });

  // ============================================================ forged / tampered issuance
  await T('forged, duplicate, unauthorized and altered issuance approvals are all refused', async () => {
    const r = await createAsset('a', S, bob);
    const id = r.body.asset.definition.assetId, dg = r.body.asset.definitionDigest;
    await issueOne('a', S, id, 'a.test');
    const pending = await view('a', id);
    // B's approval forged with another key
    const forged = approvalFrom('other', id, dg, 'approve', 'b.test');
    let x = await call('a', 'submit-approval', { body: { kind: 'issue', id, approval: forged.approval, signature: forged.signature } });
    assert(x.status === 400 && /does not verify/.test(x.body.error), 'forged signature refused: ' + JSON.stringify(x.body));
    // A's key claiming to be B
    const swap = approvalFrom('a', id, dg, 'approve', 'b.test');
    x = await call('a', 'submit-approval', { body: { kind: 'issue', id, approval: swap.approval, signature: swap.signature } });
    assert(x.status === 400, 'a signature by A cannot stand in for B: ' + JSON.stringify(x.body));
    // an issuer outside the roster
    const evil = approvalFrom('other', id, dg, 'approve', 'other.test');
    x = await call('a', 'submit-approval', { body: { kind: 'issue', id, approval: evil.approval, signature: evil.signature } });
    assert(x.status === 403, 'unauthorized issuer refused: ' + JSON.stringify(x.body));
    // a genuine B approval but over a different digest
    const wrongDigest = approvalFrom('b', id, '0'.repeat(64), 'approve');
    x = await call('a', 'submit-approval', { body: { kind: 'issue', id, approval: wrongDigest.approval, signature: wrongDigest.signature } });
    assert(x.status === 400, 'approval over a different digest refused: ' + JSON.stringify(x.body));
    // duplicate approval from A (a domain counts once)
    const dup = pending.asset.issuance.signatures.find((s) => s.domain === 'a.test');
    x = await call('a', 'submit-approval', { body: { kind: 'issue', id, approval: dup.approval, signature: dup.signature } });
    assert(x.status === 409 && /duplicate/.test(x.body.error), 'duplicate approval refused: ' + JSON.stringify(x.body));
    const v = await view('a', id);
    assert(v.status === 'pending' && v.verification.issuance.signedBy.length === 1, 'nothing changed; still one signer');
    assert(v.events.some((e) => e.kind === 'issuance-approval-rejected'), 'the refusals are in the history');
    // a replay of B's approval from a different asset does not apply here
    const other = (await issued('a', S, alice)).view;
    const bSig = other.asset.issuance.signatures.find((s) => s.domain === 'b.test');
    x = await call('a', 'submit-approval', { body: { kind: 'issue', id, approval: bSig.approval, signature: bSig.signature } });
    assert(x.status === 400, 'an approval of another asset is refused: ' + JSON.stringify(x.body));
  });

  await T('modified metadata, roster or threshold breaks verification; a self-made roster is never trusted by the real domains', async () => {
    const good = copyJson((await view('a', main.id)).asset);
    const muts = {
      metadata: (a) => { a.definition.metadata.label = 'tampered'; },
      roster: (a) => { a.definition.issuers = a.definition.issuers.slice(0, 1); a.definition.issuancePolicy.roster = ['a.test']; a.definition.transferPolicy.roster = ['a.test']; },
      threshold: (a) => { a.definition.transferPolicy.threshold = 1; },
      owner: (a) => { a.definition.originalOwner = { keyId: mallory.keyId, publicKey: mallory.pub }; },
      issuerKey: (a) => { a.definition.issuers[1].publicKey = mallory.pub; a.definition.issuers[1].keyId = mallory.keyId; },
    };
    for (const [name, fn] of Object.entries(muts)) {
      const a = copyJson(good);
      fn(a);
      const r = await call('a', 'verify', { body: { asset: a } });
      assert(r.status === 200 && r.body.verification.originalIssuanceVerified === false, name + ': tampered asset must not verify (' + JSON.stringify(r.body.verification.problem) + ')');
      const js = await verifyPortableJs(a);
      assert(!js.issuanceVerified && !js.chainValid, name + ': independent verifier also rejects');
    }
    // re-digested so the structure is self-consistent: the original signatures no longer cover it
    const a = copyJson(good);
    a.definition.transferPolicy.threshold = 1;
    a.definitionDigest = digestOf(a.definition);
    let r = await call('a', 'verify', { body: { asset: a } });
    assert(r.body.verification.originalIssuanceVerified === false, 'a re-digested weaker policy is not covered by the issuers\' signatures');
    // a wholly self-issued asset (attacker as sole issuer) verifies internally but is not trusted by A or B
    const rogueDef = copyJson(good.definition);
    const rogue = lab.ids.other;
    rogueDef.issuers = [{ domain: rogue.domain, keyId: keyIdOf(rogue.pub), publicKey: rogue.pub, discovery: { capabilities: ['asset.issue.approve', 'asset.transfer.approve', 'asset.state'], manifest: 'https://' + rogue.domain + '/.well-known/atlas-multi-issuer.json' } }];
    rogueDef.issuancePolicy = { mandatory: [rogue.domain], roster: [rogue.domain], threshold: 1 };
    rogueDef.transferPolicy = { mandatory: [rogue.domain], roster: [rogue.domain], threshold: 1 };
    rogueDef.stateAuthority = { capability: 'asset.state', domain: rogue.domain, keyId: keyIdOf(rogue.pub) };
    const rogueAsset = { format: 'domain-atlas-mi-portable-asset/1', definition: rogueDef, definitionDigest: digestOf(rogueDef), issuance: { signatures: [] }, ownership: { registry: rogue.domain, evidence: [] } };
    const ap = { v: 'domain-atlas-txlab-approval/1', txId: rogueDef.assetId, payloadDigest: rogueAsset.definitionDigest, approver: rogue.domain, decision: 'approve', approvedAtMs: Date.now() };
    rogueAsset.issuance.signatures.push({ domain: rogue.domain, approval: ap, signature: signWithPem(rogue.pem, ap) });
    for (const label of ['a', 'b']) {
      r = await call(label, 'verify', { body: { asset: rogueAsset } });
      assert(r.body.verification.originalIssuanceVerified === true, label + ': internally consistent');
      assert(r.body.trust.ok === false && /roster|pinned/.test(r.body.trust.problem), label + ': refuses to trust it: ' + JSON.stringify(r.body.trust));
    }
  });

  await T('a duplicated signer never counts twice toward the issuance threshold', async () => {
    const a = copyJson((await view('a', main.id)).asset);
    a.issuance.signatures = [a.issuance.signatures[0], a.issuance.signatures[0]];
    const r = await call('a', 'verify', { body: { asset: a } });
    assert(r.body.verification.originalIssuanceVerified === false && r.body.verification.issuance.approved === 1, 'one domain counted once: ' + JSON.stringify(r.body.verification.issuance));
    assert(r.body.verification.invalidEntries.some((e) => /duplicate/.test(e.reason)), 'the duplicate is called out');
  });

  // ============================================================ transfer: success, replay, double transfer
  let transfer1;
  await T('transfer: Alice signs, both domains independently validate and approve, ownership moves to Bob exactly once', async () => {
    const before = await view('a', main.id);
    const t = buildTransfer(before, alice, bob.pub, S.sid);
    const p = await propose('a', S, t);
    assert(p.status === 200 && p.body.status === 'pending' && p.body.ownerAuthorization.verified === true, 'proposal accepted: ' + JSON.stringify(p.body));
    assert((await view('a', main.id)).live.owner === alice.pub, 'nothing moved on proposal');
    let x = await approveTx('a', S, t.payload.txId, 'a.test');
    assert(x.status === 200 && x.body.view.status === 'pending' && x.body.view.evaluation.approved.length === 1, 'one approval is not enough');
    assert((await view('a', main.id)).live.version === 0, 'still Alice after one approval');
    x = await approveTx('a', S, t.payload.txId, 'b.test');
    assert(x.status === 200 && x.body.view.status === 'executed', 'executed after the second independent approval: ' + JSON.stringify(x.body));
    const after = await view('a', main.id);
    assert(after.live.version === 1 && after.live.owner === bob.pub, 'ownership is now Bob at version 1');
    // B validated against the registry itself, from the original transaction
    const bev = lab.sql('b', "SELECT kind, detail FROM events WHERE ref_id = '" + t.payload.txId + "'");
    assert(bev.some((e) => e.kind === 'peer-approval-signed'), 'B validated independently and signed');
    const sl = lab.sql('b', "SELECT digest, decision FROM signed_log WHERE kind='transfer'");
    assert(sl.length === 1 && sl[0].digest === t.digest && sl[0].decision === 'approve', 'B signed the identical canonical digest');
    // the receipt
    const ta = await txView('a', t.payload.txId), tb = await txView('b', t.payload.txId);
    assert(ta.status === 'executed' && tb.status === 'executed' && ta.receipt && tb.receipt, 'both domains serve the executed transfer and its receipt');
    assert(canonicalize(ta.receipt) === canonicalize(tb.receipt), 'the receipt is identical from either domain');
    const rc = ta.receipt.receipt;
    assert(await verifySig(lab.ids.a.pub, ta.receipt.signature, rc), 'receipt verifies against the state authority key');
    assert(rc.approvals.length === 2 && rc.approvals.every((a) => a.approval.payloadDigest === t.digest), 'all approvals reference the identical digest');
    for (const a of rc.approvals) assert(await verifySig(lab.ids[a.approver === 'a.test' ? 'a' : 'b'].pub, a.signature, a.approval), a.approver + '\'s approval signature verifies');
    assert(await verifySig(alice.pub, rc.ownerAuthorization.signature, rc.ownerAuthorization.object), 'Alice\'s signature on the exact transfer is in the receipt');
    const js = await verifyPortableJs(after.asset);
    assert(js.chainValid && js.version === 1 && js.owner === bob.pub, 'the exported asset verifies independently at version 1');
    transfer1 = t;
  });

  await T('Alice cannot reuse the old state; replay is idempotent; Bob can transfer next', async () => {
    // same transfer again: no second execution
    let p = await propose('a', S, transfer1);
    assert(p.status === 200 && p.body.status === 'executed', 'replay returns the existing executed transfer: ' + JSON.stringify(p.body));
    assert((await view('a', main.id)).live.version === 1, 'still version 1');
    // fresh transfer id over the old state
    const stale = buildTransfer({ asset: (await view('a', main.id)).asset, live: { version: 0, stateDigest: transfer1.payload.baseStateDigest } }, alice, carol.pub, S.sid);
    p = await propose('a', S, stale);
    assert(p.status === 409 && /stale/.test(p.body.error), 'stale state refused: ' + JSON.stringify(p.body));
    // Alice no longer owns the current state
    const cur = await view('a', main.id);
    const notOwner = buildTransfer(cur, alice, carol.pub, S.sid);
    p = await propose('a', S, notOwner);
    assert(p.status === 409, 'a former owner cannot transfer: ' + JSON.stringify(p.body));
    // a different txId with identical content is a different (stale) transfer
    // a re-sent approval after execution
    const x = await approveTx('a', S, transfer1.payload.txId, 'b.test');
    assert(x.status === 409, 'approvals after execution are refused: ' + x.status);
    // Bob transfers to Carol
    const t2 = await fullTransfer('a', S, main.id, bob, carol.pub);
    const v = await view('a', main.id);
    assert(v.live.version === 2 && v.live.owner === carol.pub, 'Bob\'s transfer executed');
    const js = await verifyPortableJs(v.asset);
    assert(js.chainValid && js.version === 2 && js.owner === carol.pub, 'chain of three states verifies');
    assert(v.asset.ownership.evidence.length === 3, 'full signed history is carried by the asset');
    main.exportV2 = copyJson(v.asset);
  });

  await T('an older export reports "stale" against the registry; the current one reports "current"', async () => {
    const v = await view('a', main.id);
    const old = copyJson(v.asset);
    old.ownership.evidence = old.ownership.evidence.slice(0, 2);
    const r = await call('t', 'verify', { body: { asset: old, online: true } });
    assert(r.body.verification.ownership.chainValid && r.body.verification.ownership.version === 1, 'old copy verifies as version 1');
    assert(r.body.currentOwnership.status === 'stale' && r.body.currentOwnership.currentVersion === 2 && r.body.currentOwnership.currentOwnerKeyId === carol.keyId, 'registry says the copy is stale: ' + JSON.stringify(r.body.currentOwnership));
    const cur = await call('b', 'verify', { body: { asset: v.asset, online: true } });
    assert(cur.body.currentOwnership.status === 'current', 'full copy is current');
    // a copy that claims more than the registry knows
    const fut = copyJson(v.asset);
    const extra = copyJson(fut.ownership.evidence[2]);
    fut.ownership.evidence.push(extra);
    const f = await call('a', 'verify', { body: { asset: fut, online: true } });
    assert(f.body.verification.ownership.chainValid === false, 'a fabricated extra step does not verify');
  });

  // (the remaining groups are appended below)
  await rest({ alice, bob, carol, mallory, S, main });
  await lab.stopAll();
  console.log('\nALL ' + total + ' CHECKS PASSED');
}

async function rest(ctx) {
  const { alice, bob, carol, mallory, S, main } = ctx;
  await adversarialPeer(ctx);
  await quorumAndRaces(ctx);
  await availabilityAndRecovery(ctx);
  await discoveryAndRelocation(ctx);
  await kOfN();
  await limitsAndIsolation(ctx);
}

// ================================================================ approving domain fed adversarial evidence
async function adversarialPeer(ctx) {
  const { alice, bob, carol, mallory, S } = ctx;
  const fake = await fakeAuthority();
  const baseAsset = (await issued('a', S, alice)).view;          // version 0, owner alice, really issued
  const movedAsset = (await view('a', ctx.main.id));              // version 2 (alice -> bob -> carol)
  const defId = baseAsset.asset.definition.assetId;

  // evidence builder: what the (fake) state authority will serve for one transfer
  function evidence(asset, live, t, over) {
    return Object.assign({
      asset: asset.asset || asset, status: 'issued', live: live || asset.live, createdAtMs: Date.now(), expiresAtMs: Date.now() + 600000,
      transfer: { payload: t.payload, digest: t.digest, ownerAuth: t.auth, ownerSignature: t.signature, status: 'pending', expiresAtMs: t.payload.expiresAtMs },
    }, over || {});
  }
  let served = null;
  fake.handler = async (url, body) => {
    if (url.startsWith('/api.php?op=peer-fetch')) {
      // the request itself must be signed by B's key
      const ok = await verifySig(lab.ids.b.pub, body.signature, body.request).catch(() => false);
      return ok && served ? { status: 200, json: typeof served === 'function' ? served(body.request) : served } : { status: 403, json: { error: 'nope' } };
    }
    return { status: 404, json: { error: 'none' } };
  };
  // point a.test's discovery at the fake, as an authenticated manifest update
  lab.publish('a', { api: fake.url });

  const ask = (to, kind, t, over) => {
    const op = kind === 'issue' ? 'approve-issuance' : 'approve-transfer';
    const pr = peerRequest('a', to, op, kind === 'issue' ? t.ref : t.payload.txId, kind === 'issue' ? t.digest : t.digest, over);
    return call(to, kind === 'issue' ? 'peer-issue-approve' : 'peer-transfer-approve', { body: pr });
  };

  await T('approver validates independently: a good transfer from the registry is approved with B\'s own signature', async () => {
    const t = buildTransfer(baseAsset, alice, bob.pub, S.sid);
    served = evidence(baseAsset, baseAsset.live, t);
    const r = await ask('b', 'transfer', t);
    assert(r.status === 200 && r.body.decision === 'approve' && r.body.approval.payloadDigest === t.digest && r.body.approval.approver === 'b.test', 'approved: ' + JSON.stringify(r.body));
    assert(await verifySig(lab.ids.b.pub, r.body.signature, r.body.approval), 'signed with B\'s key');
    ctx.firstApproved = t;
    // idempotent: asking again returns the stored decision
    const r2 = await ask('b', 'transfer', t);
    assert(r2.status === 200 && r2.body.repeat === true && r2.body.signature === r.body.signature, 'idempotent retry');
    // a competing transfer of the same ownership state is never also approved
    const t2 = buildTransfer(baseAsset, alice, carol.pub, S.sid);
    served = evidence(baseAsset, baseAsset.live, t2);
    const c = await ask('b', 'transfer', t2);
    assert(c.status === 200 && c.body.decision === 'reject' && /competing/.test(c.body.reason), 'second transfer of the same state rejected: ' + JSON.stringify(c.body));
    assert(lab.sql('b', "SELECT COUNT(*) AS n FROM signed_log WHERE kind='transfer' AND decision='approve' AND asset_id='" + defId + "'")[0].n == 1, 'exactly one approval per ownership state');
  });

  await T('stale-state approval: the transfer was authorized for an older version, so B refuses to approve', async () => {
    const old = buildTransfer({ asset: movedAsset.asset, live: { version: 0, stateDigest: movedAsset.asset.ownership.evidence[0].receipt.stateDigest } }, alice, carol.pub, S.sid);
    served = evidence(movedAsset, movedAsset.live, old);
    const r = await ask('b', 'transfer', old);
    assert(r.status === 200 && r.body.decision === 'reject' && /stale/.test(r.body.reason), 'stale base rejected: ' + JSON.stringify(r.body));
    assert((await ask('b', 'transfer', old)).body.repeat === true, 'the rejection is stable');
  });

  await T('registry lying about live state: state not matching its own signed evidence is rejected', async () => {
    const t = buildTransfer(baseAsset, alice, bob.pub, S.sid);
    served = evidence(baseAsset, { version: 0, owner: mallory.pub, stateDigest: baseAsset.live.stateDigest }, t);
    let r = await ask('b', 'transfer', t);
    assert(r.status === 200 && r.body.decision === 'reject' && /does not match/.test(r.body.reason), 'owner mismatch rejected: ' + JSON.stringify(r.body));
    const t2 = buildTransfer(baseAsset, alice, bob.pub, S.sid);
    served = evidence(baseAsset, { version: 3, owner: alice.pub, stateDigest: 'f'.repeat(64) }, t2);
    r = await ask('b', 'transfer', t2);
    assert(r.body.decision === 'reject', 'version mismatch rejected: ' + JSON.stringify(r.body));
  });

  await T('invalid owner signature: B rejects a transfer the current owner did not sign', async () => {
    const t = buildTransfer(baseAsset, alice, bob.pub, S.sid, { signer: mallory });
    served = evidence(baseAsset, baseAsset.live, t);
    const r = await ask('b', 'transfer', t);
    assert(r.body.decision === 'reject' && /owner/.test(r.body.reason), 'forged owner signature rejected: ' + JSON.stringify(r.body));
    const t2 = buildTransfer(baseAsset, alice, bob.pub, S.sid, { fromOwner: mallory.pub, signer: mallory });
    served = evidence(baseAsset, baseAsset.live, t2);
    const r2 = await ask('b', 'transfer', t2);
    assert(r2.body.decision === 'reject', 'a non-owner as sender rejected: ' + JSON.stringify(r2.body));
  });

  await T('altered digest: the request digest, the served transfer and its payload must all agree', async () => {
    const t = buildTransfer(baseAsset, alice, bob.pub, S.sid);
    served = evidence(baseAsset, baseAsset.live, t);
    const pr = peerRequest('a', 'b', 'approve-transfer', t.payload.txId, 'e'.repeat(64));
    let r = await call('b', 'peer-transfer-approve', { body: pr });
    assert(r.status === 409, 'request digest differing from the transfer refused: ' + JSON.stringify(r.body));
    // the registry serves a payload that was altered after the owner signed
    const t3 = buildTransfer(baseAsset, alice, bob.pub, S.sid);
    const altered = copyJson(t3);
    altered.payload.toOwner = mallory.pub;
    served = evidence(baseAsset, baseAsset.live, { payload: altered.payload, digest: t3.digest, auth: t3.auth, signature: t3.signature });
    r = await call('b', 'peer-transfer-approve', { body: peerRequest('a', 'b', 'approve-transfer', t3.payload.txId, t3.digest) });
    assert(r.status === 409, 'payload not matching its digest refused: ' + JSON.stringify(r.body));
    // approvals bound to a different digest cannot be redirected onto this transfer
    const sub = await call('a', 'submit-approval', { body: { kind: 'transfer', id: t3.payload.txId, ...approvalFrom('b', t3.payload.txId, t3.digest) } });
    assert(sub.status === 404 || sub.status === 400, 'unknown transfer on the real registry: ' + sub.status);
  });

  await T('tampered or unverifiable asset evidence is rejected (missing signature, forged chain, wrong policy)', async () => {
    const t = buildTransfer(baseAsset, alice, bob.pub, S.sid);
    const noB = copyJson(baseAsset.asset);
    noB.issuance.signatures = noB.issuance.signatures.filter((s) => s.domain === 'a.test');
    served = evidence({ asset: noB, live: baseAsset.live }, baseAsset.live, t);
    let r = await call('b', 'peer-transfer-approve', { body: peerRequest('a', 'b', 'approve-transfer', t.payload.txId, t.digest) });
    assert(r.body.decision === 'reject' && /issuance/.test(r.body.reason), 'missing issuer signature rejected: ' + JSON.stringify(r.body));
    const t2 = buildTransfer(baseAsset, alice, bob.pub, S.sid);
    const forgedChain = copyJson(movedAsset.asset);
    forgedChain.ownership.evidence[1].receipt.transfer.toOwner = mallory.pub;
    const t2b = buildTransfer({ asset: forgedChain, live: movedAsset.live }, carol, bob.pub, S.sid);
    served = evidence({ asset: forgedChain, live: movedAsset.live }, movedAsset.live, t2b);
    r = await call('b', 'peer-transfer-approve', { body: peerRequest('a', 'b', 'approve-transfer', t2b.payload.txId, t2b.digest) });
    assert(r.body.decision === 'reject' && /ownership evidence/.test(r.body.reason), 'forged ownership chain rejected: ' + JSON.stringify(r.body));
    const weak = copyJson(baseAsset.asset);
    weak.definition.transferPolicy.threshold = 1;
    weak.definitionDigest = digestOf(weak.definition);
    const t3 = buildTransfer({ asset: weak, live: baseAsset.live }, alice, bob.pub, S.sid);
    served = evidence({ asset: weak, live: baseAsset.live }, baseAsset.live, t3);
    r = await call('b', 'peer-transfer-approve', { body: peerRequest('a', 'b', 'approve-transfer', t3.payload.txId, t3.digest) });
    assert(r.body.decision === 'reject' && /policy/.test(r.body.reason), 'a weaker policy than B\'s own is rejected: ' + JSON.stringify(r.body));
    assert(t2 && t3, 'built');
  });

  await T('a transfer that is no longer pending, or whose window closed, is refused rather than signed', async () => {
    const t = buildTransfer(baseAsset, alice, bob.pub, S.sid);
    served = evidence(baseAsset, baseAsset.live, t, {});
    served.transfer.status = 'executed';
    let r = await call('b', 'peer-transfer-approve', { body: peerRequest('a', 'b', 'approve-transfer', t.payload.txId, t.digest) });
    assert(r.status === 409, 'executed transfer refused: ' + JSON.stringify(r.body));
    const t2 = buildTransfer(baseAsset, alice, bob.pub, S.sid, { ttlMs: 1 });
    await sleep(60);
    served = evidence(baseAsset, baseAsset.live, t2);
    r = await call('b', 'peer-transfer-approve', { body: peerRequest('a', 'b', 'approve-transfer', t2.payload.txId, t2.digest) });
    assert(r.status === 409 && /window/.test(r.body.error), 'expired window refused: ' + JSON.stringify(r.body));
    const t3 = buildTransfer(baseAsset, alice, bob.pub, S.sid, { ttlMs: 3600000 });
    served = evidence(baseAsset, baseAsset.live, t3);
    r = await call('b', 'peer-transfer-approve', { body: peerRequest('a', 'b', 'approve-transfer', t3.payload.txId, t3.digest) });
    assert(r.body.decision === 'reject' && /longer/.test(r.body.reason), 'B\'s own maximum window enforced: ' + JSON.stringify(r.body));
    const none = buildTransfer(baseAsset, alice, bob.pub, S.sid);
    served = null;
    r = await call('b', 'peer-transfer-approve', { body: peerRequest('a', 'b', 'approve-transfer', none.payload.txId, none.digest) });
    assert(r.status === 502 || r.status === 403 || r.status === 404, 'registry that refuses to serve evidence means no signature: ' + r.status);
    assert(lab.sql('b', "SELECT COUNT(*) AS n FROM signed_log WHERE ref_id='" + none.payload.txId + "'")[0].n == 0, 'nothing was signed');
  });

  await T('issuance on the approver side: invalid definitions and mismatching digests are rejected or refused', async () => {
    const pend = (await createAsset('a', S, alice)).body;
    const dg = pend.asset.definitionDigest;
    const mk = (portable, status) => ({ asset: portable, status: status || 'pending', live: null, createdAtMs: portable.definition.createdAtMs, expiresAtMs: portable.definition.createdAtMs + 600000 });
    const base = copyJson(pend.asset);
    served = mk(base);
    let r = await call('b', 'peer-issue-approve', { body: peerRequest('a', 'b', 'approve-issuance', base.definition.assetId, dg) });
    assert(r.status === 200 && r.body.decision === 'approve', 'valid pending definition approved: ' + JSON.stringify(r.body));
    // roster that includes an extra domain, a lower threshold, a class B does not allow, and a window already closed
    const variants = {
      threshold: (d) => { d.issuancePolicy.threshold = 1; },
      roster: (d) => { const x = lab.ids.other; d.issuers.push({ domain: x.domain, keyId: keyIdOf(x.pub), publicKey: x.pub, discovery: { capabilities: ['asset.issue.approve'], manifest: 'https://' + x.domain + '/.well-known/atlas-multi-issuer.json' } }); d.issuancePolicy.roster.push(x.domain); d.transferPolicy.roster.push(x.domain); },
      class: (d) => { d.class = 'real-money'; },
      key: (d) => { d.issuers[1].publicKey = mallory.pub; d.issuers[1].keyId = mallory.keyId; },
    };
    for (const [k, fn] of Object.entries(variants)) {
      const fresh = (await createAsset('a', S, alice)).body.asset;
      const d = copyJson(fresh.definition);
      fn(d);
      const portable = { format: fresh.format, definition: d, definitionDigest: digestOf(d), issuance: { signatures: [] }, ownership: { registry: 'a.test', evidence: [] } };
      served = mk(portable);
      r = await call('b', 'peer-issue-approve', { body: peerRequest('a', 'b', 'approve-issuance', d.assetId, portable.definitionDigest) });
      assert(r.status === 200 && r.body.decision === 'reject', 'variant ' + k + ' rejected: ' + JSON.stringify(r.body));
    }
    const fresh2 = copyJson((await createAsset('a', S, alice)).body.asset);
    served = mk(fresh2);
    r = await call('b', 'peer-issue-approve', { body: peerRequest('a', 'b', 'approve-issuance', fresh2.definition.assetId, 'd'.repeat(64)) });
    assert(r.status === 409, 'digest not matching the asset refused: ' + JSON.stringify(r.body));
    served = mk(fresh2, 'issued');
    r = await call('b', 'peer-issue-approve', { body: peerRequest('a', 'b', 'approve-issuance', fresh2.definition.assetId, fresh2.definitionDigest) });
    assert(r.status === 409, 'an asset that is no longer pending is not signed: ' + JSON.stringify(r.body));
  });

  await T('peer identity: requests must be signed by the pinned key of a roster peer, addressed to this domain, fresh and unique', async () => {
    const t = buildTransfer(baseAsset, alice, bob.pub, S.sid);
    served = evidence(baseAsset, baseAsset.live, t);
    const good = peerRequest('a', 'b', 'approve-transfer', t.payload.txId, t.digest);
    // signed by someone else's key
    let r = await call('b', 'peer-transfer-approve', { body: { request: good.request, signature: signWithPem(pemOf('other'), good.request) } });
    assert(r.status === 401, 'wrong signing key refused: ' + r.status);
    // an unknown requester claiming to be a roster member / a non-roster requester
    const alien = peerRequest('other', 'b', 'approve-transfer', t.payload.txId, t.digest);
    r = await call('b', 'peer-transfer-approve', { body: alien });
    assert(r.status === 403, 'a domain outside the roster refused: ' + r.status);
    // B asking itself, or a request addressed to a third domain
    const wrongTarget = peerRequest('a', 'b', 'approve-transfer', t.payload.txId, t.digest, { target: 'a.test' });
    r = await call('b', 'peer-transfer-approve', { body: wrongTarget });
    assert(r.status === 403, 'request addressed elsewhere refused: ' + r.status);
    // only the state authority may ask an approver to sign (a peer approver is not the registry)
    const fromB = peerRequest('b', 'a', 'approve-transfer', t.payload.txId, t.digest);
    r = await call('b', 'peer-transfer-approve', { body: fromB });
    assert(r.status === 403 || r.status === 401, 'a request from B to B refused: ' + r.status);
    // stale timestamp
    const old = peerRequest('a', 'b', 'approve-transfer', t.payload.txId, t.digest, { requestedAtMs: Date.now() - 600000 });
    r = await call('b', 'peer-transfer-approve', { body: old });
    assert(r.status === 400, 'stale request refused: ' + r.status);
    // wrong operation for the endpoint
    const wrongOp = peerRequest('a', 'b', 'fetch-transfer', t.payload.txId, t.digest);
    r = await call('b', 'peer-transfer-approve', { body: wrongOp });
    assert(r.status === 403, 'wrong operation refused: ' + r.status);
    // replay of a request that was accepted once
    r = await call('b', 'peer-transfer-approve', { body: good });
    assert(r.status === 200, 'first use accepted: ' + JSON.stringify(r.body));
    r = await call('b', 'peer-transfer-approve', { body: good });
    assert(r.status === 409 && /replay/.test(r.body.error), 'the identical signed request replayed is refused: ' + JSON.stringify(r.body));
    // unauthenticated and unsigned
    r = await call('b', 'peer-transfer-approve', { body: { request: good.request } });
    assert(r.status === 400, 'unsigned refused');
    r = await call('a', 'peer-fetch', { body: peerRequest('b', 'a', 'fetch-asset', defId, baseAsset.asset.definitionDigest, { signWith: 'other' }) });
    assert(r.status === 401, 'the registry also refuses a forged fetch: ' + r.status);
  });

  await T('the real registry refuses a fetch with a wrong digest and serves evidence only to roster peers', async () => {
    lab.publish('a'); // back to the real service
    const real = await view('a', defId);
    let r = await call('a', 'peer-fetch', { body: peerRequest('b', 'a', 'fetch-asset', defId, 'c'.repeat(64)) });
    assert(r.status === 409, 'digest mismatch: ' + JSON.stringify(r.body));
    r = await call('a', 'peer-fetch', { body: peerRequest('b', 'a', 'fetch-asset', defId, real.asset.definitionDigest) });
    assert(r.status === 200 && r.body.asset.definitionDigest === real.asset.definitionDigest && r.body.live.version === 0, 'roster peer served: ' + JSON.stringify(r.body).slice(0, 200));
    r = await call('a', 'peer-fetch', { body: peerRequest('other', 'a', 'fetch-asset', defId, real.asset.definitionDigest) });
    assert(r.status === 403, 'a non-roster domain is not served: ' + r.status);
    r = await call('b', 'peer-fetch', { body: peerRequest('a', 'b', 'fetch-asset', defId, real.asset.definitionDigest) });
    assert(r.status === 400, 'an approver does not serve registry evidence: ' + r.status);
    fake.server.close();
  });
}
function insertApprovals(label, txId, pairs) {
  for (const p of pairs) {
    lab.sqlExec(label, "INSERT INTO transfer_approvals (tx_id, approver, decision, approval_json, signature, stored_ms) VALUES ('" + txId + "', '" + p.approval.approver + "', '" + p.approval.decision + "', '" + canonicalize(p.approval) + "', '" + p.signature + "', " + Date.now() + ")");
  }
}

// ================================================================ owner authorization, quorum, races
async function quorumAndRaces(ctx) {
  const { alice, bob, carol, mallory, S } = ctx;

  await T('ownership is proved by the owner\'s key alone: missing, forged and foreign authorizations are refused', async () => {
    const { id, view: v } = await issued('a', S, alice);
    const good = buildTransfer(v, alice, bob.pub, S.sid);
    let r = await call('a', 'public-transfer-propose', { body: Object.assign({}, auth(S), { payload: good.payload }) });
    assert(r.status === 400, 'no owner authorization at all: ' + r.status);
    r = await call('a', 'public-transfer-propose', { body: Object.assign({}, auth(S), { payload: good.payload, ownerAuthorization: good.auth }) });
    assert(r.status === 400, 'authorization without a signature: ' + r.status);
    const forged = buildTransfer(v, alice, bob.pub, S.sid, { signer: mallory });
    r = await propose('a', S, forged);
    assert(r.status === 403 && /signature/.test(r.body.error), 'signed by someone else: ' + JSON.stringify(r.body));
    const notOwner = buildTransfer(v, mallory, bob.pub, S.sid);
    r = await propose('a', S, notOwner);
    assert(r.status === 409, 'a stranger as the sender: ' + JSON.stringify(r.body));
    // an authorization for a different transfer cannot be attached to this one
    const other = buildTransfer(v, alice, carol.pub, S.sid);
    r = await call('a', 'public-transfer-propose', { body: Object.assign({}, auth(S), { payload: good.payload, ownerAuthorization: other.auth, ownerSignature: other.signature }) });
    assert(r.status === 403, 'an authorization signed for another transfer: ' + r.status);
    // the owner's signed transfer cannot be submitted from another session (it is bound to the proposer's session)
    const S2 = await session('a');
    r = await propose('a', S2, good);
    assert(r.status === 400 && /session/.test(r.body.error), 'bound to the proposing session: ' + JSON.stringify(r.body));
    // a visitor cannot drive someone else's issuance or transfer
    r = await issueOne('a', S2, id, 'a.test');
    assert(r.status === 404, 'cannot approve another visitor\'s asset: ' + r.status);
    const p = await propose('a', S, good);
    assert(p.status === 200, 'the genuine proposal is accepted');
    r = await approveTx('a', S2, good.payload.txId, 'a.test');
    assert(r.status === 404, 'cannot approve another visitor\'s transfer: ' + r.status);
    r = await call('a', 'public-transfer-approve', { body: { sid: S.sid, token: S2.token, txId: good.payload.txId, domain: 'a.test' } });
    assert(r.status === 401, 'wrong session token: ' + r.status);
    assert((await view('a', id)).live.owner === alice.pub, 'nobody but Alice\'s key moved anything');
    ctx.pendingOne = { id, t: good };
  });

  await T('transfer without the full quorum never executes; a forged approval cannot complete it', async () => {
    const { id, t } = ctx.pendingOne;
    let x = await approveTx('a', S, t.payload.txId, 'a.test');
    assert(x.status === 200 && x.body.view.status === 'pending', 'one approval: pending');
    const forgedB = approvalFrom('other', t.payload.txId, t.digest, 'approve', 'b.test');
    let r = await call('a', 'submit-approval', { body: { kind: 'transfer', id: t.payload.txId, approval: forgedB.approval, signature: forgedB.signature } });
    assert(r.status === 400, 'forged approval refused: ' + JSON.stringify(r.body));
    const asA = approvalFrom('a', t.payload.txId, t.digest, 'approve', 'b.test');
    r = await call('a', 'submit-approval', { body: { kind: 'transfer', id: t.payload.txId, approval: asA.approval, signature: asA.signature } });
    assert(r.status === 400, 'A\'s key cannot be passed off as B: ' + JSON.stringify(r.body));
    const wrongDigest = approvalFrom('b', t.payload.txId, 'a'.repeat(64), 'approve');
    r = await call('a', 'submit-approval', { body: { kind: 'transfer', id: t.payload.txId, approval: wrongDigest.approval, signature: wrongDigest.signature } });
    assert(r.status === 400, 'approval over a different digest refused');
    // B\'s genuine approval of ANOTHER transfer is a replay here
    const elsewhere = lab.sql('b', "SELECT approval_json, signature FROM signed_log WHERE kind='transfer' AND decision='approve' LIMIT 1")[0];
    r = await call('a', 'submit-approval', { body: { kind: 'transfer', id: t.payload.txId, approval: JSON.parse(elsewhere.approval_json), signature: elsewhere.signature } });
    assert(r.status === 400, 'a replayed approval of another transfer refused: ' + JSON.stringify(r.body));
    const v = await view('a', id);
    assert(v.live.version === 0 && v.live.owner === alice.pub, 'still Alice; the quorum is incomplete');
    const dup = await call('a', 'submit-approval', { body: { kind: 'transfer', id: t.payload.txId, approval: x.body.view.approvals[0].approval, signature: x.body.view.approvals[0].signature } });
    assert(dup.status === 409, 'a duplicate approval is refused');
    x = await approveTx('a', S, t.payload.txId, 'b.test');
    assert(x.body.view.status === 'executed', 'executes once the real second approval arrives');
    assert((await view('a', id)).live.owner === bob.pub, 'Bob owns it');
  });

  await T('competing transfers: of two simultaneous transfers of the same state exactly one is accepted', async () => {
    const { id, view: v } = await issued('a', S, alice);
    const t1 = buildTransfer(v, alice, bob.pub, S.sid), t2 = buildTransfer(v, alice, carol.pub, S.sid);
    const rs = await Promise.all([propose('a', S, t1), propose('a', S, t2)]);
    const ok = rs.filter((r) => r.status === 200), no = rs.filter((r) => r.status === 409);
    assert(ok.length === 1 && no.length === 1, 'one accepted, one refused: ' + rs.map((r) => r.status));
    const win = ok[0].body.txId === t1.payload.txId ? t1 : t2;
    // hammer the approvals concurrently: execution still happens exactly once
    const calls = [];
    for (let i = 0; i < 3; i++) for (const d of ['a.test', 'b.test']) calls.push(approveTx('a', S, win.payload.txId, d));
    const res = await Promise.all(calls);
    assert(res.every((r) => r.status === 200 || r.status === 409 || r.status === 503), 'no server errors under contention: ' + res.map((r) => r.status));
    const fin = await view('a', id);
    assert(fin.live.version === 1 && fin.live.owner === win.payload.toOwner, 'ownership moved exactly once');
    assert(lab.sql('a', "SELECT COUNT(*) AS n FROM transitions WHERE asset_id='" + id + "'")[0].n == 2, 'one genesis + one transition');
    assert(lab.sql('a', "SELECT COUNT(*) AS n FROM transfers WHERE asset_id='" + id + "' AND status='executed'")[0].n == 1, 'one executed transfer');
    // the database itself refuses a second pending transfer for an asset
    let refused = false;
    const v2 = fin;
    const t3 = buildTransfer(v2, win.payload.toOwner === bob.pub ? bob : carol, alice.pub, S.sid);
    const ok3 = await propose('a', S, t3);
    assert(ok3.status === 200, 'next owner can propose');
    try {
      lab.sqlExec('a', "INSERT INTO transfers (tx_id, asset_id, session_sid, request_id, payload_json, digest, owner_auth_json, owner_signature, base_version, status, created_ms, expires_ms) VALUES ('" + crypto.randomUUID() + "', '" + id + "', 'x', 'x:y', '{}', 'd', '{}', 's', 1, 'pending', 1, 2)");
    } catch (e) { refused = /UNIQUE|constraint/i.test(String(e.stderr || e.message)); }
    assert(refused, 'the unique pending-transfer index blocks a second pending row at the database level');
  });

  await T('committed-transaction recovery: a satisfied quorum that was never executed is completed exactly once', async () => {
    const { id, view: v } = await issued('a', S, alice);
    const t = buildTransfer(v, alice, bob.pub, S.sid);
    assert((await propose('a', S, t)).status === 200, 'proposed');
    // both approvals are durably stored but the process died before execution
    insertApprovals('a', t.payload.txId, [approvalFrom('a', t.payload.txId, t.digest), approvalFrom('b', t.payload.txId, t.digest)]);
    assert(lab.sql('a', "SELECT status FROM transfers WHERE tx_id='" + t.payload.txId + "'")[0].status === 'pending', 'pending in storage');
    const fin = await view('a', id); // any read triggers recovery
    assert(fin.live.version === 1 && fin.live.owner === bob.pub, 'recovered and executed');
    assert(lab.sql('a', "SELECT COUNT(*) AS n FROM transitions WHERE asset_id='" + id + "'")[0].n == 2, 'exactly one transition');
    await view('a', id); await view('a', id);
    assert((await view('a', id)).live.version === 1, 'repeat recovery does nothing more');
    const js = await verifyPortableJs(fin.asset);
    assert(js.chainValid && js.owner === bob.pub, 'the recovered receipt verifies');
  });

  await T('execution re-checks the authoritative state: approvals gathered for an older version are never executed', async () => {
    const { id, view: v } = await issued('a', S, alice);
    const t = buildTransfer(v, alice, bob.pub, S.sid);
    assert((await propose('a', S, t)).status === 200, 'proposed');
    // the ownership state moves underneath the pending transfer (simulated out-of-band change at the registry)
    lab.sqlExec('a', "UPDATE asset_state SET version = 1, state_digest = '" + 'b'.repeat(64) + "' WHERE asset_id = '" + id + "'");
    insertApprovals('a', t.payload.txId, [approvalFrom('a', t.payload.txId, t.digest), approvalFrom('b', t.payload.txId, t.digest)]);
    await view('a', id);
    const row = lab.sql('a', "SELECT status, fail_reason FROM transfers WHERE tx_id='" + t.payload.txId + "'")[0];
    assert(row.status === 'failed' && /changed|stale/.test(row.fail_reason), 'refused at execution: ' + JSON.stringify(row));
    assert(lab.sql('a', "SELECT owner_pub FROM asset_state WHERE asset_id='" + id + "'")[0].owner_pub === alice.pub, 'ownership did not move');
    let step1 = false;
    try { lab.sqlExec('a', "UPDATE asset_state SET version = 7 WHERE asset_id = '" + id + "'"); } catch (e) { step1 = /exactly one/.test(String(e.stderr || e.message)); }
    assert(step1, 'the database refuses to skip versions');
  });

  await T('finished records are immutable at the database level', async () => {
    let errs = 0;
    for (const q of ["UPDATE transitions SET signature = 'x'", "UPDATE issuance_approvals SET decision = 'reject'", "UPDATE transfer_approvals SET decision = 'reject'", "UPDATE assets SET definition_json = '{}'", "UPDATE signed_log SET decision = 'approve'"]) {
      try { lab.sqlExec('a', q); } catch (e) { if (/immutable|final/.test(String(e.stderr || e.message))) errs++; }
    }
    assert(errs === 5, 'all five tables refuse edits: ' + errs);
    try { lab.sqlExec('a', "UPDATE assets SET status = 'pending' WHERE status = 'issued'"); errs = -1; } catch (e) { /* expected */ }
    assert(errs === 5, 'a finished issuance cannot be reopened');
  });
}

// ================================================================ outages, restarts, bounded waits
async function availabilityAndRecovery(ctx) {
  const { alice, bob, S } = ctx;

  await T('peer unavailable: the pending item is kept, A is not wedged, and a retry completes it', async () => {
    const r0 = await createAsset('a', S, alice);
    const id = r0.body.asset.definition.assetId;
    assert((await issueOne('a', S, id, 'a.test')).status === 200, 'A signed');
    await lab.stop('b');
    const down = await issueOne('a', S, id, 'b.test');
    assert(down.status === 502 && down.body.state === 'peer-unavailable', 'B down is reported plainly: ' + JSON.stringify(down.body));
    let v = await view('a', id);
    assert(v.status === 'pending' && v.verification.issuance.signedBy.length === 1, 'still pending with A\'s signature kept');
    assert(v.events.some((e) => e.kind === 'peer-approval-failed'), 'the failure is in the history');
    assert((await call('a', 'health')).body.enabled === true, 'A stays healthy');
    await lab.start('b');
    const up = await issueOne('a', S, id, 'b.test');
    assert(up.status === 200 && up.body.decision === 'approve', 'retry works: ' + JSON.stringify(up.body));
    v = await view('a', id);
    assert(v.status === 'issued', 'issued after the retry');
    // the same for a transfer
    const t = buildTransfer(v, alice, bob.pub, S.sid);
    assert((await propose('a', S, t)).status === 200, 'proposed');
    assert((await approveTx('a', S, t.payload.txId, 'a.test')).status === 200, 'A approved');
    await lab.stop('b');
    const d2 = await approveTx('a', S, t.payload.txId, 'b.test');
    assert(d2.status === 502 && d2.body.state === 'peer-unavailable', 'transfer waits for B: ' + JSON.stringify(d2.body));
    assert((await view('a', id)).live.version === 0, 'no ownership change while a required domain is unreachable');
    await lab.start('b');
    const d3 = await approveTx('a', S, t.payload.txId, 'b.test');
    assert(d3.status === 200 && d3.body.view.status === 'executed', 'retry executes: ' + JSON.stringify(d3.body));
  });

  await T('bounded waits: a peer that accepts the connection but never answers cannot hang the registry', async () => {
    const hang = await fakeAuthority();
    hang.handler = () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, json: {} }), 60000));
    const r0 = await createAsset('a', S, alice);
    const id = r0.body.asset.definition.assetId;
    await issueOne('a', S, id, 'a.test');
    lab.publish('b', { api: hang.url });
    const t0 = Date.now();
    const slow = await issueOne('a', S, id, 'b.test');
    const took = Date.now() - t0;
    assert(slow.status === 502 && took < 30000, 'gave up after a bounded time (' + took + ' ms): ' + JSON.stringify(slow.body));
    assert((await call('a', 'health')).status === 200, 'registry still serves');
    lab.publish('b');
    const ok = await issueOne('a', S, id, 'b.test');
    assert(ok.status === 200, 'completes once the real service is advertised again: ' + JSON.stringify(ok.body));
    hang.server.closeAllConnections && hang.server.closeAllConnections();
    hang.server.close();
  });

  await T('restart: stopping and starting the registry loses nothing (assets, ownership, pending transfers)', async () => {
    const { id, view: v } = await issued('a', S, alice);
    const t = buildTransfer(v, alice, bob.pub, S.sid);
    assert((await propose('a', S, t)).status === 200, 'proposed');
    assert((await approveTx('a', S, t.payload.txId, 'a.test')).status === 200, 'A approved');
    const before = await view('a', id);
    await lab.stop('a');
    await lab.start('a');
    const after = await view('a', id);
    assert(canonicalize(after.asset) === canonicalize(before.asset), 'portable document identical after restart');
    assert(after.live.version === 0 && after.transfers.length === 1 && after.transfers[0].status === 'pending', 'pending transfer survived');
    const x = await approveTx('a', S, t.payload.txId, 'b.test');
    assert(x.status === 200 && x.body.view.status === 'executed', 'and still completes');
    await lab.stop('b');
    await lab.start('b');
    assert((await view('b', id)).currentOwnership.status === 'current', 'B restarted and agrees');
    assert(lab.sql('b', "SELECT COUNT(*) AS n FROM signed_log WHERE asset_id='" + id + "'")[0].n >= 1, 'B\'s signing record persisted');
  });
}
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
function craftManifest(site, o) {
  o = o || {};
  const id = lab.ids[site];
  const now = Date.now();
  const doc = Object.assign({ domain: id.domain, seq: 1, issuedAtMs: now - 1000, validUntilMs: now + 86400000, keys: [{ publicKey: id.pub, validFrom: iso(now - 60000), validUntil: null }], services: {} }, o.doc || {});
  const signer = lab.ids[o.signer || site];
  const wrap = { spec: 'domain-atlas-multi-issuer-discovery/1', doc, signedBy: o.signedBy || signer.pub, signature: signWithPem(signer.pem, doc) };
  fs.writeFileSync(path.join(lab.sites[site].wkRoot, '.well-known', 'atlas-multi-issuer.json'), JSON.stringify(wrap));
  return wrap;
}
const svcAll = (url) => ({ 'asset.issue.approve': url, 'asset.transfer.approve': url });

// ================================================================ authenticated discovery and service relocation
async function discoveryAndRelocation(ctx) {
  const { alice, bob, carol, S } = ctx;
  const { id: xid, view: xv } = await issued('a', S, alice);
  const exportedText = JSON.stringify(xv.asset);   // the portable file a visitor saved before anything moved
  const bDiscovery = async (via) => {
    const r = await call(via || 'a', 'verify', { body: { asset: JSON.parse(exportedText), online: true } });
    return { r, d: r.body.discovery.find((x) => x.domain === 'b.test') };
  };
  const bUrl = lab.sites.b.base + API;

  await T('discovery is authenticated: forged manifests, public-key substitution and wrong-domain manifests are rejected', async () => {
    let { d } = await bDiscovery();
    assert(d.ok && d.services['asset.transfer.approve'] === bUrl && d.keyStatus === 'pinned', 'baseline resolves B\'s real endpoint: ' + JSON.stringify(d));
    craftManifest('b', { signer: 'other', doc: { services: svcAll('http://127.0.0.1:9/api.php') } });
    ({ d } = await bDiscovery());
    assert(!d.ok && d.status === 'rejected' && /substitution/.test(d.reason), 'manifest signed by an unrelated key: ' + JSON.stringify(d));
    const adv = lab.ids.other;
    craftManifest('b', { signer: 'other', doc: { keys: [{ publicKey: adv.pub, validFrom: iso(Date.now() - 60000), validUntil: null }], services: svcAll(bUrl) } });
    ({ d } = await bDiscovery());
    assert(!d.ok && /substitution/.test(d.reason), 'attacker lists only its own key: ' + JSON.stringify(d));
    const inForged = await issueOne('a', S, (await createAsset('a', S, alice)).body.asset.definition.assetId, 'b.test');
    assert(inForged.status === 502 && inForged.body.state === 'discovery-failed', 'a signing request does not go to an unauthenticated endpoint: ' + JSON.stringify(inForged.body));
    craftManifest('b', { doc: { domain: 'a.test', services: svcAll(bUrl) } });
    ({ d } = await bDiscovery());
    assert(!d.ok && /different domain/.test(d.reason), 'manifest for another domain: ' + JSON.stringify(d));
    craftManifest('b', { doc: { services: svcAll(bUrl), validUntilMs: Date.now() - 1000 } });
    ({ d } = await bDiscovery());
    assert(!d.ok && /expired/.test(d.reason), 'expired manifest: ' + JSON.stringify(d));
    craftManifest('b', { doc: { services: svcAll(bUrl), keys: [{ publicKey: lab.ids.b.pub, validFrom: iso(Date.now() + 3600000), validUntil: null }] } });
    ({ d } = await bDiscovery());
    assert(!d.ok && /not valid now/.test(d.reason), 'key not yet valid: ' + JSON.stringify(d));
    const good = craftManifest('b', { doc: { services: svcAll(bUrl) } });
    good.doc.services['asset.transfer.approve'] = 'http://127.0.0.1:9/api.php'; // tampered after signing
    fs.writeFileSync(path.join(lab.sites.b.wkRoot, '.well-known', 'atlas-multi-issuer.json'), JSON.stringify(good));
    ({ d } = await bDiscovery());
    assert(!d.ok && /does not verify/.test(d.reason), 'edited services break the signature: ' + JSON.stringify(d));
    lab.publish('b');
    ({ d } = await bDiscovery());
    assert(d.ok, 'the genuine manifest is accepted again');
  });

  await T('arbitrary URLs are refused as service endpoints even when the manifest is genuinely signed', async () => {
    const bad = {
      'https://evil.example/api.php': /outside the issuer/,
      'http://b.test/api.php': /not https/,
      'https://b.test:8443/api.php': /non-standard port/,
      'https://user:pw@b.test/api.php': /credentials/,
      'https://b.test/api.php?x=1': /query/,
      'https://b.test/other.php': /api\.php/,
      'https://b.test.evil.example/api.php': /outside the issuer/,
      'https://evilb.test/api.php': /outside the issuer/,
    };
    for (const [url, re] of Object.entries(bad)) {
      craftManifest('b', { doc: { seq: 1, services: svcAll(url) } });
      const { d } = await bDiscovery();
      assert(!d.ok && re.test(d.reason), url + ' refused: ' + JSON.stringify(d));
    }
    lab.publish('b', { services: ['asset.issue.approve=' + bUrl] });
    const { d } = await bDiscovery();
    assert(d.ok && !d.services['asset.transfer.approve'], 'a missing capability is simply not advertised');
    const miss = await call('a', 'public-transfer-approve', { body: { sid: S.sid, token: S.token, txId: crypto.randomUUID(), domain: 'b.test' } });
    assert(miss.status === 404, 'unknown transfer');
    lab.publish('b');
    // an asset that points at an arbitrary manifest URL is not a valid asset
    const a = JSON.parse(exportedText);
    a.definition.issuers[1].discovery.manifest = 'https://evil.example/manifest.json';
    a.definitionDigest = digestOf(a.definition);
    const r = await call('a', 'verify', { body: { asset: a, online: true } });
    assert(r.body.verification.shapeOk === false && /well-known/.test(r.body.verification.problem), 'embedded arbitrary manifest URL refused: ' + JSON.stringify(r.body.verification.problem));
  });

  await T('redirects are never followed and rollback to an older manifest is refused', async () => {
    // a web server for B's well-known path that answers with a redirect
    const wkPort = lab.sites.b.wkPort;
    await lab.stop('wk-b');
    const redir = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:9/.well-known/atlas-multi-issuer.json' }); res.end(); });
    await new Promise((r) => redir.listen(wkPort, '127.0.0.1', r));
    let { d } = await bDiscovery();
    assert(!d.ok && d.status === 'refused' && /redirect/.test(d.reason), 'redirect refused: ' + JSON.stringify(d));
    await new Promise((r) => redir.close(r));
    await lab.start('b');
    lab.publish('b');
    ({ d } = await bDiscovery());
    assert(d.ok, 'back to normal');
    const seqNow = d.seq;
    craftManifest('b', { doc: { seq: seqNow - 1 || 1, services: svcAll(bUrl) } });
    ({ d } = await bDiscovery());
    assert(!d.ok && /rollback/.test(d.reason), 'older sequence refused: ' + JSON.stringify(d));
    lab.publish('b');
    ({ d } = await bDiscovery());
    assert(d.ok && d.seq > seqNow, 'a newer sequence is accepted');
  });

  await T('key rotation: an endorsed new key is accepted; an unendorsed or attacker-endorsed key never replaces the pinned authority', async () => {
    lab.identity('bnew', 'b.test');
    let { d } = await bDiscovery();
    const now = Date.now();
    const newKey = lab.ids.bnew;
    craftManifest('b', { signer: 'bnew', doc: { seq: 1, services: svcAll(bUrl), keys: [{ publicKey: lab.ids.b.pub, validFrom: iso(now - 60000), validUntil: null }, { publicKey: newKey.pub, validFrom: iso(now - 60000), validUntil: null }] } });
    ({ d } = await bDiscovery());
    assert(!d.ok && /substitution/.test(d.reason), 'a new key with no endorsement is refused: ' + JSON.stringify(d));
    const fake = { v: 'domain-atlas-mi-key-endorsement/1', domain: 'b.test', publicKey: newKey.pub, validFrom: iso(now - 60000) };
    craftManifest('b', { signer: 'bnew', doc: { seq: 1, services: svcAll(bUrl), keys: [{ publicKey: lab.ids.b.pub, validFrom: iso(now - 60000), validUntil: null }, { publicKey: newKey.pub, validFrom: iso(now - 60000), validUntil: null, endorsement: { by: lab.ids.other.pub, signature: signWithPem(lab.ids.other.pem, fake) } }] } });
    ({ d } = await bDiscovery());
    assert(!d.ok && /substitution/.test(d.reason), 'an endorsement by a stranger is refused: ' + JSON.stringify(d));
    lab.publish('b', { signerDir: newKey.dir });
    ({ d } = await bDiscovery());
    assert(d.ok && d.keyStatus === 'rotated' && d.services['asset.transfer.approve'] === bUrl, 'a key endorsed by the pinned key is accepted, identity unchanged: ' + JSON.stringify(d));
    const sigAfter = await issueOne('a', S, (await createAsset('a', S, alice)).body.asset.definition.assetId, 'b.test');
    assert(sigAfter.status === 200 && sigAfter.body.decision === 'approve', 'signing still works and B\'s identity key in the asset is unchanged');
    lab.publish('b');
    ({ d } = await bDiscovery());
    assert(d.ok && d.keyStatus === 'pinned', 'back to the pinned key');
  });

  await T('service relocation: B\'s service moves to a new server; the exported asset is unchanged and still finds it', async () => {
    const before = await view('a', xid);
    // the new home: same identity, same key, state copied across; a different host/port
    const b2 = await lab.site('b2', { identity: 'b', state: 'a', roster: ['a', 'b'], issuance: { t: 2, m: ['a', 'b'] }, transfer: { t: 2, m: ['a', 'b'] }, pub: BIG });
    fs.copyFileSync(path.join(lab.sites.b.privDir, 'config.php'), path.join(b2.privDir, 'config.php'));
    for (const f of fs.readdirSync(lab.sites.b.privDir)) if (f.startsWith('mi.sqlite') && !f.endsWith('-shm')) fs.copyFileSync(path.join(lab.sites.b.privDir, f), path.join(b2.privDir, f));
    await lab.start('b2');
    const b2Url = b2.base + API;
    lab.publish('b', { api: b2Url });
    await lab.stop('b');                                  // the old host is gone
    const { r, d } = await bDiscovery();
    assert(d.ok && d.services['asset.transfer.approve'] === b2Url && d.services['asset.issue.approve'] === b2Url, 'discovery resolves the NEW endpoint: ' + JSON.stringify(d));
    assert(JSON.stringify(JSON.parse(exportedText).definition) === JSON.stringify(before.asset.definition), 'the asset definition is byte-for-byte what was exported');
    assert(r.body.verification.originalIssuanceVerified, 'the exported file still verifies');
    // use the moved service for a real transfer of the same asset
    const t = await fullTransfer('a', S, xid, alice, bob.pub);
    const after = await view('a', xid);
    assert(after.live.owner === bob.pub && after.live.version === 1, 'transfer executed through the relocated service');
    assert(lab.sql('b2', "SELECT COUNT(*) AS n FROM signed_log WHERE kind='transfer' AND ref_id='" + t.payload.txId + "'")[0].n == 1, 'the relocated B signed it');
    assert(lab.sql('b', "SELECT COUNT(*) AS n FROM signed_log WHERE kind='transfer' AND ref_id='" + t.payload.txId + "'")[0].n == 0, 'the old host saw nothing');
    assert(canonicalize(JSON.parse(exportedText).definition) === canonicalize(after.asset.definition) && after.asset.definitionDigest === JSON.parse(exportedText).definitionDigest, 'identity unchanged after the move; only ownership evidence grew');
    // a third site that never saw B before follows the same asset to the new endpoint
    const tv = await call('t', 'verify', { body: { asset: after.asset, online: true } });
    const td = tv.body.discovery.find((x) => x.domain === 'b.test');
    assert(td.ok && td.services['asset.transfer.approve'] === b2Url && tv.body.currentOwnership.status === 'current', 'third site resolves the new endpoint from the old file: ' + JSON.stringify(td));
    // move back
    await lab.start('b');
    lab.publish('b');
    await lab.stop('b2');
    const back = await bDiscovery();
    assert(back.d.ok && back.d.services['asset.transfer.approve'] === bUrl, 'and back again, still without editing the asset');
  });
}

// ================================================================ K-of-N with independently keyed domains
async function kOfN() {
  const mainLab = lab;
  const variants = [
    { name: '2-of-3, A mandatory', names: ['a', 'b', 'c'], t: 2, m: ['a'] },
    { name: '3-of-3', names: ['a', 'b', 'c'], t: 3, m: ['a'] },
    { name: '2-of-3 with A and C mandatory', names: ['a', 'b', 'c'], t: 2, m: ['a', 'c'] },
    { name: '3-of-4, A mandatory', names: ['a', 'b', 'c', 'd'], t: 3, m: ['a'] },
  ];
  for (const v of variants) {
    lab = new Lab('mi-k-');
    try {
      await lab.network({ names: v.names, state: 'a', issuance: { t: v.t, m: v.m }, transfer: { t: v.t, m: v.m }, pub: BIG });
      const owner = makeOwner('o'), next = makeOwner('n'), third = makeOwner('x');
      const s = await session('a');
      const dom = (n) => n + '.test';
      const keys = new Set(v.names.map((n) => lab.ids[n].pub));
      assert(keys.size === v.names.length, v.name + ': every domain has its own key');
      const asset = await createAsset('a', s, owner);
      const id = asset.body.asset.definition.assetId;
      assert(asset.body.asset.definition.issuers.length === v.names.length, v.name + ': roster has all ' + v.names.length + ' domains');
      // approve in a deliberately unhelpful order: non-mandatory domains first
      const order = v.names.filter((n) => !v.m.includes(n)).concat(v.names.filter((n) => v.m.includes(n)));
      const signers = [];
      let issuedAt = null;
      for (const n of order) {
        const r = await issueOne('a', s, id, dom(n));
        assert(r.status === 200 && r.body.decision === 'approve', v.name + ': ' + n + ' approves');
        signers.push(n);
        const st = (await view('a', id)).status;
        if (st === 'issued' && issuedAt === null) issuedAt = signers.slice();
        if (issuedAt === null) {
          const ev = await view('a', id);
          const enough = signers.length >= v.t;
          if (enough) assert(ev.events.some((e) => e.kind === 'issuance-blocked'), v.name + ': threshold reached but a mandatory domain missing is blocked, not issued');
        }
      }
      const fin = await view('a', id);
      assert(fin.status === 'issued' && issuedAt && issuedAt.length >= v.t, v.name + ': issued after ' + (issuedAt ? issuedAt.join(',') : 'never'));
      for (const m of v.m) assert(issuedAt.includes(m), v.name + ': mandatory ' + m + ' signed before issuance');
      // distinguish the authorized roster from the signers who satisfied the threshold: approve only the minimum
      const fresh = await createAsset('a', s, owner);
      const fid = fresh.body.asset.definition.assetId;
      const minimal = v.m.concat(v.names.filter((n) => !v.m.includes(n))).slice(0, Math.max(v.t, v.m.length));
      for (const n of minimal) assert((await issueOne('a', s, fid, dom(n))).status === 200, v.name + ': ' + n + ' signs');
      const fv = await view('a', fid);
      assert(fv.status === 'issued', v.name + ': minimal quorum issues');
      assert(fv.verification.issuance.roster.length === v.names.length, v.name + ': the roster still lists everyone');
      assert(fv.verification.issuance.signedBy.length === minimal.length, v.name + ': only ' + minimal.length + ' domains signed');
      const js = await verifyPortableJs(fv.asset);
      assert(js.issuanceVerified && js.signedBy.slice().sort().join() === minimal.map(dom).sort().join(), v.name + ': independent verifier sees exactly the signers');
      const silent = v.names.filter((n) => !minimal.includes(n));
      for (const n of silent) assert(fv.verification.issuers.find((i) => i.domain === dom(n)).signed === false, v.name + ': ' + n + ' did not sign and is not shown as signed');
      // a domain that was never asked cannot be added afterwards once the asset is final
      if (silent.length) {
        const late = await issueOne('a', s, fid, dom(silent[0]));
        assert(late.status === 409, v.name + ': issuance is final: ' + late.status);
      }
      // transfers use the same rule
      const t1 = buildTransfer(fv, owner, next.pub, s.sid);
      assert((await propose('a', s, t1)).status === 200, v.name + ': proposed');
      let blocked = false;
      for (const n of order) {
        const r = await approveTx('a', s, t1.payload.txId, dom(n));
        assert(r.status === 200, v.name + ': transfer approval by ' + n + ': ' + JSON.stringify(r.body));
        if (r.body.view.status === 'executed') break;
        if (r.body.view.evaluation.approved.length >= v.t) blocked = true;
      }
      const post = await view('a', fid);
      assert(post.live.version === 1 && post.live.owner === next.pub, v.name + ': transfer executed');
      const tv = await txView('a', t1.payload.txId);
      assert(tv.receipt.receipt.approvals.length >= v.t, v.name + ': receipt carries at least the threshold of approvals');
      assert(new Set(tv.receipt.receipt.approvals.map((a) => a.approver)).size === tv.receipt.receipt.approvals.length, v.name + ': no domain twice');
      const js2 = await verifyPortableJs(post.asset);
      assert(js2.chainValid && js2.owner === next.pub, v.name + ': chain verifies independently');
      // every approving domain validated by itself: each holds its own signing record, none holds the asset
      for (const n of tv.receipt.receipt.approvals.map((a) => a.approver.replace('.test', ''))) {
        if (n === 'a') continue;
        assert(lab.sql(n, "SELECT COUNT(*) AS n FROM signed_log WHERE kind='transfer' AND ref_id='" + t1.payload.txId + "'")[0].n == 1, v.name + ': ' + n + ' signed on its own');
        assert(lab.sql(n, 'SELECT COUNT(*) AS n FROM assets')[0].n == 0, v.name + ': ' + n + ' holds no asset');
      }
      // a quorum without a mandatory domain never executes, even with every other domain's approval
      if (v.m.length >= 1) {
        const lone = await createAsset('a', s, owner);
        const lid = lone.body.asset.definition.assetId;
        for (const n of order.filter((x) => !v.m.includes(x))) await issueOne('a', s, lid, dom(n));
        const lv = await view('a', lid);
        assert(lv.status === 'pending', v.name + ': without the mandatory domain(s) the asset stays pending');
        assert(lv.verification.originalIssuanceVerified === false, v.name + ': and is not valid');
      }
    } finally {
      mainLab.seen.push(...lab.seen);
      await lab.stopAll();
    }
    lab = mainLab;
    pass('K-of-N ' + v.name + ': ' + v.names.length + ' independently keyed PHP domains, quorum, mandatory domains and signers vs roster');
  }
  lab = mainLab;
}
const SMALL = 'callsPerIpPerMinute=10000,approvalsPerIpPerMinute=600,sessionsPerIpPerHour=1000,assetsPerIpPerHour=1000,transfersPerIpPerHour=2000,maxSessions=5000,maxAssetsPerSession=50,maxTransfersPerSession=100,maxPendingTransfersGlobal=1000,maxInflightPeer=32';
const withSet = (over) => { const m = {}; for (const kv of SMALL.split(',')) { const [k, v] = kv.split('='); m[k] = v; } for (const kv of over.split(',')) { const [k, v] = kv.split('='); m[k] = v; } return Object.entries(m).map(([k, v]) => k + '=' + v).join(','); };

// Runs fn against a fresh lab of 1 domain ('r') or 2 domains ('a','b'), with the given public-demo settings.
async function withLab(names, over, fn) {
  const prev = lab;
  const l = new Lab('mi-x-');
  lab = l;
  try {
    await l.network({ names, state: names[0], issuance: { t: names.length, m: names }, transfer: { t: names.length, m: names }, pub: over === null ? null : withSet(over || '') });
    await fn(l, names.map((n) => n + '.test'));
  } finally {
    prev.seen.push(...l.seen);
    const errs = l.phpErrors();
    await l.stopAll();
    lab = prev;
    assert(errs.length === 0, 'no PHP errors logged: ' + errs.slice(0, 3).join(' | '));
  }
}

// ================================================================ public limits, isolation, no privileged paths
async function limitsAndIsolation(ctx) {
  const { alice, bob, carol, mallory } = ctx;

  await T('public resource limits: assets and transfers per session, global pending cap, and session capacity', async () => {
    await withLab(['r'], 'maxAssetsPerSession=2,maxTransfersPerSession=1,maxPendingTransfersGlobal=1,maxSessions=3', async () => {
      const s1 = await session('r');
      const a1 = await issued('r', s1, alice, ['r.test']);
      const a2 = await issued('r', s1, alice, ['r.test']);
      let r = await createAsset('r', s1, alice);
      assert(r.status === 429 && /test assets/.test(r.body.error), 'third asset in one session refused: ' + JSON.stringify(r.body));
      const t1 = buildTransfer(a1.view, alice, bob.pub, s1.sid);
      assert((await propose('r', s1, t1)).status === 200, 'first transfer');
      r = await propose('r', s1, buildTransfer(a2.view, alice, bob.pub, s1.sid));
      assert(r.status === 429 && /test transfers/.test(r.body.error), 'transfer cap per session: ' + JSON.stringify(r.body));
      const s2 = await session('r');
      const b1 = await issued('r', s2, alice, ['r.test']);
      r = await propose('r', s2, buildTransfer(b1.view, alice, bob.pub, s2.sid));
      assert(r.status === 503 && /busy/.test(r.body.error), 'global pending cap: ' + JSON.stringify(r.body));
      await session('r');
      const s4 = await call('r', 'public-start', { body: {} });
      assert(s4.status === 503 && /capacity/.test(s4.body.error), 'session capacity: ' + JSON.stringify(s4.body));
    });
  });

  await T('public rate limits per address: sessions, assets, approvals, transfers and calls', async () => {
    await withLab(['r'], 'sessionsPerIpPerHour=2', async () => {
      await session('r'); await session('r');
      const r = await call('r', 'public-start', { body: {} });
      assert(r.status === 429 && r.body.retryAfterSeconds >= 1, 'third session in an hour: ' + JSON.stringify(r.body));
    });
    await withLab(['r'], 'assetsPerIpPerHour=2', async () => {
      const s1 = await session('r'), s2 = await session('r');
      assert((await createAsset('r', s1, alice)).status === 200 && (await createAsset('r', s2, alice)).status === 200, 'two assets');
      const r = await createAsset('r', await session('r'), alice);
      assert(r.status === 429, 'third asset from the same address (new session does not help): ' + r.status);
    });
    await withLab(['r'], 'approvalsPerIpPerMinute=2', async () => {
      const s = await session('r');
      const id = (await createAsset('r', s, alice)).body.asset.definition.assetId;
      await issueOne('r', s, id, 'r.test'); await issueOne('r', s, id, 'r.test');
      const r = await issueOne('r', s, id, 'r.test');
      assert(r.status === 429, 'third approval request in a minute: ' + r.status);
    });
    await withLab(['r'], 'callsPerIpPerMinute=10', async () => {
      let last = null;
      for (let i = 0; i < 12; i++) last = await call('r', 'asset', { id: crypto.randomUUID() });
      assert(last.status === 429, 'calls per minute ceiling: ' + last.status);
    });
    await withLab(['r'], 'transfersPerIpPerHour=1', async () => {
      const s = await session('r');
      const a1 = await issued('r', s, alice, ['r.test']), a2 = await issued('r', s, alice, ['r.test']);
      assert((await propose('r', s, buildTransfer(a1.view, alice, bob.pub, s.sid))).status === 200, 'first transfer');
      const r = await propose('r', s, buildTransfer(a2.view, alice, bob.pub, s.sid));
      assert(r.status === 429, 'second transfer from the same address in an hour: ' + r.status);
    });
  });

  await T('time limits: the authorization window is capped by each domain and an unfinished issuance expires', async () => {
    await withLab(['r'], 'transferTtlSeconds=5,issuanceWindowSeconds=10', async () => {
      const s = await session('r');
      const a = await issued('r', s, alice, ['r.test']);
      const long = buildTransfer(a.view, alice, bob.pub, s.sid, { ttlMs: 60000 });
      let r = await propose('r', s, long);
      assert(r.status === 400 && /longer/.test(r.body.error), 'window longer than the domain allows: ' + JSON.stringify(r.body));
      const short = buildTransfer(a.view, alice, bob.pub, s.sid, { ttlMs: 4000 });
      assert((await propose('r', s, short)).status === 200, 'a short window is fine');
      await sleep(5500);
      r = await approveTx('r', s, short.payload.txId, 'r.test');
      assert(r.status === 409 && /expired/.test(r.body.error), 'approval after the window closed: ' + JSON.stringify(r.body));
      assert((await txView('r', short.payload.txId)).status === 'expired', 'marked expired');
      assert((await view('r', a.id)).live.version === 0, 'nothing moved');
      const p = (await createAsset('r', s, alice)).body.asset.definition.assetId;
      await sleep(11000);
      r = await issueOne('r', s, p, 'r.test');
      assert(r.status === 409, 'issuance window closed: ' + JSON.stringify(r.body));
      assert((await view('r', p)).status === 'expired', 'unfinished issuance expired');
    });
  });

  await T('overload is bounded: a burst of simultaneous issuer-to-issuer exchanges is shed with 503, never deadlocks, and retries succeed', async () => {
    await withLab(['a', 'b'], 'maxInflightPeer=1', async () => {
      const s = await session('a');
      const ids = [];
      for (let i = 0; i < 8; i++) { const r = await createAsset('a', s, alice); ids.push(r.body.asset.definition.assetId); await issueOne('a', s, ids[i], 'a.test'); }
      const t0 = Date.now();
      const rs = await Promise.all(ids.map((id) => issueOne('a', s, id, 'b.test')));
      assert(Date.now() - t0 < 60000, 'finished promptly');
      const busy = rs.filter((r) => r.status === 503), ok = rs.filter((r) => r.status === 200);
      assert(rs.every((r) => r.status === 200 || r.status === 503 || r.status === 502), 'only success or load-shedding: ' + rs.map((r) => r.status));
      assert(ok.length >= 1, 'progress was made');
      assert(busy.length >= 1, 'the limiter actually shed load: ' + rs.map((r) => r.status));
      for (let i = 0; i < ids.length; i++) if (rs[i].status !== 200) { const r = await issueOne('a', s, ids[i], 'b.test'); assert(r.status === 200, 'retry succeeds: ' + JSON.stringify(r.body)); }
      for (const id of ids) assert((await view('a', id)).status === 'issued', 'all issued eventually');
    });
  });

  await T('sessions: expiry blocks the visitor, expired sessions and their assets are pruned, tokens are per-session secrets', async () => {
    const s = await session('a');
    const id = (await createAsset('a', s, alice)).body.asset.definition.assetId;
    lab.sqlExec('a', "UPDATE sessions SET expires_ms = " + (Date.now() - 1000) + " WHERE sid = '" + s.sid + "'");
    let r = await call('a', 'public-session', { body: auth(s) });
    assert(r.status === 401, 'expired session refused: ' + r.status);
    r = await issueOne('a', s, id, 'a.test');
    assert(r.status === 401, 'cannot drive an asset after the session expired');
    lab.sqlExec('a', "UPDATE sessions SET expires_ms = " + (Date.now() - 200000) + " WHERE sid = '" + s.sid + "'");
    await session('a'); // starting a session prunes
    assert(lab.sql('a', "SELECT COUNT(*) AS n FROM assets WHERE asset_id='" + id + "'")[0].n == 0, 'expired session\'s asset was removed');
    assert((await call('a', 'asset', { id })).status === 404, 'and no longer served');
    const good = await session('a');
    for (const bad of [{ sid: good.sid, token: 'x'.repeat(43) }, { sid: 'ffffffffffffffff', token: good.token }, { sid: good.sid }, { sid: 5, token: 5 }]) {
      assert((await call('a', 'public-session', { body: bad })).status === 401, 'bad credentials: ' + JSON.stringify(bad));
    }
    assert(lab.sql('a', 'SELECT token_hash FROM sessions').every((x) => x.token_hash.length === 64 && x.token_hash !== good.token), 'only token hashes are stored');
  });

  await T('request hygiene: size limits, content type, methods, and strict input validation', async () => {
    const s = await session('a');
    let r = await call('a', 'public-start', { body: { pad: 'x'.repeat(20000) } });
    assert(r.status === 413, 'oversized body: ' + r.status);
    r = await call('a', 'verify', { body: { asset: { pad: 'x'.repeat(70000) } } });
    assert(r.status === 413, 'import size limit: ' + r.status);
    r = await call('a', 'public-start', { body: '{}', type: 'text/plain' });
    assert(r.status === 415, 'a form-style content type is refused (no cross-site posts): ' + r.status);
    r = await call('a', 'public-start', { body: '[1]' });
    assert(r.status === 400, 'a JSON array is not an object');
    r = await call('a', 'public-start', { method: 'GET' });
    assert(r.status === 405, 'GET on a POST operation');
    r = await call('a', 'asset', { method: 'POST', body: {} });
    assert(r.status === 405, 'POST on a GET operation');
    const base = Object.assign({ requestId: reqId(), ownerPublicKey: alice.pub, label: 'ok' }, auth(s));
    for (const [why, over] of [['non-ascii label', { label: 'café' }], ['markup in label', { label: '<script>' }], ['overlong label', { label: 'x'.repeat(41) }], ['real-value class', { class: 'real-money' }], ['bad owner key', { ownerPublicKey: 'AAAA' }], ['bad request id', { requestId: 'x' }], ['non-string class', { class: 7 }]]) {
      r = await call('a', 'public-asset-create', { body: Object.assign({}, base, over) });
      assert(r.status === 400, why + ' refused: ' + r.status + ' ' + JSON.stringify(r.body));
    }
    assert((await call('a', 'asset', { id: 'not-a-uuid' })).status === 400, 'malformed id');
    assert((await call('a', 'asset', { id: crypto.randomUUID(), nonce: 'zz' })).status === 400, 'malformed nonce');
  });

  await T('no public bypasses: no admin token, no unrestricted signing, no reset; public mode off means the public operations are closed', async () => {
    const api = fs.readFileSync(path.join(MI_SRC, 'api.php'), 'utf8');
    const ops = [...api.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]).sort();
    assert(ops.join() === ['asset', 'discovery', 'peer-fetch', 'peer-issue-approve', 'peer-transfer-approve', 'public-asset-create', 'public-issue-approve', 'public-session', 'public-start', 'public-transfer-approve', 'public-transfer-propose', 'submit-approval', 'tx', 'verify'].join(), 'the complete operation list: ' + ops.join());
    for (const op of ['sign', 'public-sign', 'admin-check', 'create', 'decide', 'reset', 'public-reset', 'issue', 'transfer', 'rotate-key', 'config']) {
      assert((await call('a', op, { body: {} })).status === 404, op + ' does not exist');
    }
    const src = fs.readdirSync(path.join(MI_SRC, 'inc')).filter((f) => f.endsWith('.php')).map((f) => fs.readFileSync(path.join(MI_SRC, 'inc', f), 'utf8')).join('\n') + api;
    assert(!/adminToken|admin-token|require_admin|admin_token/i.test(src), 'no administrator token in the module code');
    // every signature the server makes is over an object the server built itself
    const signs = [...src.matchAll(/mi_sign_obj\(\$cfg, (\$[a-z]+)\)|txlab_sign\(\$cfg, ([^)]+)\)/g)].map((m) => m[1] || m[2]);
    assert(signs.length > 0 && signs.every((x) => ['$approval', '$obj', '$req', '$json', 'canonicalize($obj'].includes(x.trim())), 'signing call sites are over server-built values only: ' + signs.join());
    await withLab(['r'], null, async () => {
      assert((await call('r', 'public-start', { body: {} })).status === 403, 'public-start closed');
      assert((await call('r', 'public-asset-create', { body: {} })).status === 403, 'asset creation closed');
      assert((await call('r', 'peer-fetch', { body: {} })).status === 403, 'peer-fetch closed');
      assert((await call('r', 'asset', { id: crypto.randomUUID() })).status === 404, 'read-only inspection still answers');
      const h = (await call('r', 'health')).body;
      assert(h.enabled === true && h.publicDemo === false, 'health reports public demo off');
    });
  });

  await T('isolation: the lab never touches issuer keys, wallets, ledgers or other databases', async () => {
    // decoys that stand for existing issuer data sit next to the lab in the same document root
    const root = lab.sites.a.docroot;
    const decoys = {
      'issuer-private/issuer-key.pem': '-----BEGIN PRIVATE KEY-----\nDECOY-ISSUER-KEY\n-----END PRIVATE KEY-----\n',
      'issuer-private/store.sqlite': 'DECOY-STORE',
      'atlas/reserve-bank/ledger.sqlite': 'DECOY-RESERVE-LEDGER',
      'atlas/wallet/wallet.json': '{"decoy":"wallet"}',
      'atlas/trade/orders.sqlite': 'DECOY-TRADES',
    };
    const sums = {};
    for (const [f, c] of Object.entries(decoys)) { const p = path.join(root, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); sums[f] = sha256hex(c); }
    const s = await session('a');
    const i = await issued('a', s, alice);
    await fullTransfer('a', s, i.id, alice, bob.pub);
    await call('a', 'verify', { body: { asset: (await view('a', i.id)).asset, online: true } });
    for (const [f, h] of Object.entries(sums)) assert(sha256hex(fs.readFileSync(path.join(root, f), 'utf8')) === h, f + ' untouched');
    // what the lab wrote, and where
    for (const l of ['a', 'b']) {
      const files = fs.readdirSync(lab.sites[l].privDir).filter((f) => !/-(wal|shm)$/.test(f)).sort();
      assert(files.join() === ['config.php', 'manifest.json', 'mi.sqlite', 'public-key.txt', 'signing-key.pem'].join(), l + ' private directory holds only the lab\'s own files: ' + files.join());
      const strays = [];
      (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(sqlite|db|pem|key)(-wal|-shm)?$/.test(e.name) && !Object.keys(decoys).some((k) => p.endsWith(k))) strays.push(p); } })(lab.sites[l].docroot);
      assert(strays.length === 0, l + ' wrote no database or key into the web root: ' + strays.join());
    }
    // the lab's key is not any other key, and its code can reach nothing but its own directory plus the shared crypto/txlab helpers
    assert(fs.readFileSync(path.join(lab.sites.a.privDir, 'signing-key.pem'), 'utf8') !== fs.readFileSync(path.join(lab.sites.a.docroot, 'issuer-private', 'issuer-key.pem'), 'utf8'), 'distinct key material');
    const incs = [];
    for (const f of [...fs.readdirSync(path.join(MI_SRC, 'inc')).map((x) => path.join('inc', x)), 'api.php']) {
      if (!f.endsWith('.php') || f.endsWith('.example')) continue;
      for (const m of fs.readFileSync(path.join(MI_SRC, f), 'utf8').matchAll(/^\s*(?:[^'"\n]*=\s*)?(?:require|include)(?:_once)?\b\s*\(?\s*([^;]+);/gm)) incs.push(m[1].trim());
    }
    const allowed = ["__DIR__ . '/inc/mi.php'", "__DIR__ . '/../../txlab/inc/txlab.php'", "__DIR__ . '/mi-verify.php'", "__DIR__ . '/mi-core.php'", "__DIR__ . '/mi-public.php'", '$pointer', '$file'];
    assert(incs.every((x) => allowed.includes(x.replace(/\)$/, ''))), 'the module includes only itself and the Transaction Lab helpers: ' + incs.join(' | '));
    const code = fs.readdirSync(path.join(MI_SRC, 'inc')).filter((f) => f.endsWith('.php')).map((f) => fs.readFileSync(path.join(MI_SRC, 'inc', f), 'utf8')).join('\n');
    assert(!/issuer-server|reserve|ledger\.sqlite|wallet\.json|store\.json|chainblock|\/trade\//i.test(code), 'no reference to production stores');
    const sqlite = [...code.matchAll(/sqlite:'?\s*\.\s*([^)]+)\)/g)].map((m) => m[1]);
    assert(sqlite.length === 1 && /\$cfg\['dir'\]/.test(sqlite[0]), 'the only database opened is in the lab\'s private directory: ' + sqlite.join());
  });

  await T('no secrets leak: no key material or other visitors\' tokens in any response', async () => {
    const all = lab.seen.join('\n');
    assert(!/BEGIN (EC )?PRIVATE KEY|BEGIN PRIVATE|token_hash|ip_hash/.test(all), 'no key material or storage fields in any response');
    for (const id of Object.values(lab.ids)) {
      const body = id.pem.replace(/-----[A-Z ]+-----|\s/g, '');
      assert(!all.includes(body.slice(10, 60)), id.name + '\'s private key never appears');
    }
    const tokens = [...all.matchAll(/"token":"([A-Za-z0-9_-]{43})"/g)].map((m) => m[1]);
    for (const tk of new Set(tokens)) assert(all.split(tk).length - 1 === 1, 'a session token appears only in its own start response');
    assert(lab.phpErrors().length === 0, 'no PHP errors or warnings were logged by any site: ' + lab.phpErrors().slice(0, 3).join(' | '));
  });
}

main().then(() => process.exit(0), async (e) => { console.error(e); console.error(lab.phpErrors().slice(0, 20).join('\n')); await lab.stopAll(); console.error('workdir kept: ' + lab.root); process.exit(1); });
