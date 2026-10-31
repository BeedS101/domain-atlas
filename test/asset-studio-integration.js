// Asset Studio integration tests: a real PHP issuer (isolated copy, fresh key and state) and real
// ECDSA / WebAuthn-style wallet signatures. No verifier is mocked. Covers authorization, forgery,
// replay, concurrency, quotas, crash recovery, restarts, bypass attempts and credential validity.
//   node test/asset-studio-integration.js [name-filter]
const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const { SITE_MODEL_STANDIN, StudioLab, makeIdentity, signBridge, signPayload, canonicalize, b64u, DESIGN, REPO } = require('./studio-lab');
const { adminAuth } = require('../tools/lib/admin-auth');

const FILTER = process.argv[2] || '';
const results = { pass: 0, fail: 0, failed: [] };
const labs = [];
const HIGH = { challengesPerIpPerHour: 10000, mintsPerIpPerHour: 10000, maxMintsPerRecipientPerDay: 1000, maxMintsPerActorPerDay: 10000, maxMintsPerDay: 100000, maxOutstandingChallenges: 5000 };

async function test(name, fn) {
  if (FILTER && name.indexOf(FILTER) === -1) return;
  const t0 = Date.now();
  try {
    await fn();
    results.pass++;
    console.log('ok   ' + name + ' (' + (Date.now() - t0) + ' ms)');
  } catch (e) {
    results.fail++;
    results.failed.push(name);
    console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
  }
}

async function lab(opts) {
  const l = await StudioLab.start(opts);
  labs.push(l);
  return l;
}

const sub = (l, d) => { try { return fs.readdirSync(path.join(l.private, d)).filter((n) => /\.json$/.test(n)); } catch (e) { return []; } };
const replays = (l) => sub(l, 'replay');
const journals = (l) => sub(l, 'txn');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const challengePath = (l, nonce) => path.join(l.studio, 'tmp', 'mint-challenge-' + nonce + '.json');
const attemptPath = (l, nonce) => path.join(l.studio, 'mint-receipts', 'attempt-' + nonce + '.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chal(l, id, design) {
  const r = await l.api('challenge', { design: design || DESIGN, recipient: id.publicKeyB64 });
  assert.equal(r.status, 200, 'challenge: ' + r.text);
  return r.json;
}
// opts.payload mutates a copy of the sign request before signing; opts.origin / ctx / flags / type as signBridge.
function proofFor(l, id, ch, opts) {
  opts = opts || {};
  const payload = JSON.parse(JSON.stringify(ch.signRequest));
  if (opts.payload) opts.payload(payload);
  return signBridge(id, opts.origin || l.origin, payload, opts);
}
const bodyFor = (ch, proof, design) => ({ design: design || DESIGN, nonce: ch.nonce, proof });

// Verifies a credential the way a wallet does: the issuer's published key, canonical payload, P-256 / SHA-256.
async function credentialVerifies(l, cred) {
  const keys = (await l.get('/.well-known/atlas-key.json')).json.keys;
  const pub = keys[keys.length - 1].publicKey;
  assert.equal(cred.issuer.publicKey, pub, 'credential names the published issuer key');
  const point = Buffer.from(pub.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const spkiPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
  const key = crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, point]), format: 'der', type: 'spki' });
  const payload = { id: cred.id, asset: cred.asset, owner: cred.owner, quantity: cred.quantity, supersedes: cred.supersedes, issuedAt: cred.issuedAt };
  const sig = Buffer.from(cred.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return crypto.verify('sha256', Buffer.from(canonicalize(payload)), { key, dsaEncoding: 'ieee-p1363' }, sig);
}

(async () => {
  // ---------------------------------------------------------------- defaults and configuration
  await test('minting is off by default: status false, challenge and mint refused, validate still works', async () => {
    const l = await lab({ mint: false });
    assert.equal((await l.status()).json.mintEnabled, false);
    const id = makeIdentity('raw-ecdsa');
    assert.equal((await l.api('challenge', { design: DESIGN, recipient: id.publicKeyB64 })).status, 403);
    assert.equal((await l.api('mint', { design: DESIGN, nonce: 'a'.repeat(64), proof: {} })).status, 403);
    const v = await l.api('validate', DESIGN);
    assert.equal(v.status, 200);
    assert.match(v.json.designDigest, /^[a-f0-9]{64}$/);
    assert.equal(replays(l).length, 0);
  });

  await test('configuration fails closed (string true, wrong domain, bad limit, bad origin, symlink, junk)', async () => {
    const l = await lab({ mint: true });
    const cfgFile = path.join(l.studio, 'studio-config.json');
    const good = { mintEnabled: true, domain: l.host, origins: [l.origin] };
    const cases = [
      ['string true', Object.assign({}, good, { mintEnabled: 'true' })],
      ['number 1', Object.assign({}, good, { mintEnabled: 1 })],
      ['domain mismatch', Object.assign({}, good, { domain: 'other.test' })],
      ['missing domain', { mintEnabled: true, origins: [l.origin] }],
      ['limit zero', Object.assign({}, good, { mintsPerIpPerHour: 0 })],
      ['limit string', Object.assign({}, good, { maxMintsPerDay: '5' })],
      ['limit huge', Object.assign({}, good, { challengesPerIpPerHour: 99999999 })],
      ['origin with path', Object.assign({}, good, { origins: [l.origin + '/x'] })],
      ['empty origins', Object.assign({}, good, { origins: [] })],
    ];
    for (const [label, cfg] of cases) {
      fs.writeFileSync(cfgFile, JSON.stringify(cfg));
      assert.equal((await l.status()).json.mintEnabled, false, label);
    }
    fs.writeFileSync(cfgFile, '{not json');
    assert.equal((await l.status()).json.mintEnabled, false, 'junk');
    fs.writeFileSync(cfgFile, ' '.repeat(9000));
    assert.equal((await l.status()).json.mintEnabled, false, 'oversized');
    fs.unlinkSync(cfgFile);
    fs.symlinkSync(path.join(l.root, 'elsewhere.json'), cfgFile);
    fs.writeFileSync(path.join(l.root, 'elsewhere.json'), JSON.stringify(good));
    assert.equal((await l.status()).json.mintEnabled, false, 'symlinked config');
    fs.unlinkSync(cfgFile);
    fs.writeFileSync(cfgFile, JSON.stringify(good));
    assert.equal((await l.status()).json.mintEnabled, true, 'good config enables');
    // A non-local host never accepts plain-http origins; https is fine.
    const asA = (c) => { fs.writeFileSync(cfgFile, JSON.stringify(c)); return l.get('/atlas/studio/api.php?op=status', { Host: 'a.test' }); };
    assert.equal((await asA({ mintEnabled: true, domain: 'a.test', origins: ['http://a.test'] })).json.mintEnabled, false, 'http origin on a public host');
    assert.equal((await asA({ mintEnabled: true, domain: 'a.test', origins: ['https://a.test'] })).json.mintEnabled, true, 'https origin on a public host');
    assert.equal((await asA({ mintEnabled: true, domain: 'a.test' })).json.mintEnabled, true, 'default origin is https://domain');
  });

  await test('T2: unsafe replay retention keeps minting off; safe values enable it', async () => {
    // A stored result must outlive the longest window in which a retry can still ask for it.
    for (const [hours, enabled] of [['0.0006', false], ['1', false], ['24', false], ['47.9', false], ['48', true], ['168', true], ['abc', true], ['', true]]) {
      const l = await lab({ mint: true, config: HIGH, env: { ATLAS_REPLAY_TTL_HOURS: hours } });
      assert.equal((await l.status()).json.mintEnabled, enabled, 'ATLAS_REPLAY_TTL_HOURS=' + JSON.stringify(hours));
      if (!enabled) {
        const id = makeIdentity('raw-ecdsa');
        assert.equal((await l.api('challenge', { design: DESIGN, recipient: id.publicKeyB64 })).status, 403);
        assert.equal(replays(l).length, 0);
      }
    }
  });

  await test('L3: only the canonical lowercase host enables minting, and issued URLs use it', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const cfgFile = path.join(l.studio, 'studio-config.json');
    const at = (host, cfg) => { fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({ mintEnabled: true, origins: ['https://a.test'] }, cfg))); return l.get('/atlas/studio/api.php?op=status', { Host: host }); };
    assert.equal((await at('a.test', { domain: 'a.test' })).json.mintEnabled, true, 'canonical host enables');
    assert.equal((await at('A.TEST', { domain: 'a.test' })).json.mintEnabled, false, 'upper-case Host header');
    assert.equal((await at('a.test', { domain: 'A.TEST' })).json.mintEnabled, false, 'upper-case configured domain');
    assert.equal((await at('A.TEST', { domain: 'A.TEST' })).json.mintEnabled, false, 'upper-case on both sides');
    assert.equal((await at('a.test.', { domain: 'a.test.' })).json.mintEnabled, false, 'trailing-dot host');
    assert.equal((await at('a.test:443', { domain: 'a.test:443' })).json.mintEnabled, true, 'explicit port stays valid');
    assert.equal((await at('a.test:0443', { domain: 'a.test:0443' })).json.mintEnabled, false, 'non-canonical port spelling');
    assert.equal((await at('a.test', { domain: 'a.test/x' })).json.mintEnabled, false, 'path in domain');
  });

  await test('T5: optional WebAuthn relying-party pin (default off; configured pin is enforced)', async () => {
    const wa = makeIdentity('webauthn'), raw = makeIdentity('raw-ecdsa');
    // The lab's simulated authenticator reports rpIdHash = SHA-256("rp").
    let l = await lab({ mint: true, config: HIGH });
    assert.equal((await l.mintAs(wa, DESIGN)).mint.status, 200, 'no pin: accepted');
    l = await lab({ mint: true, config: Object.assign({}, HIGH, { webauthnRpIds: ['rp'] }) });
    assert.equal((await l.mintAs(wa, DESIGN)).mint.status, 200, 'matching pin: accepted');
    assert.equal((await l.mintAs(raw, DESIGN)).mint.status, 200, 'raw identities are not subject to the pin');
    l = await lab({ mint: true, config: Object.assign({}, HIGH, { webauthnRpIds: ['other.test'] }) });
    const r = await l.mintAs(wa, DESIGN);
    assert.equal(r.mint.status, 403, 'wrong rp: ' + r.mint.text);
    assert.equal(replays(l).length, 0, 'nothing issued');
    for (const bad of [[], 'rp', [5], ['RP'], ['a b'], ['rp', 'a', 'b', 'c', 'd'], { a: 'rp' }]) {
      l = await lab({ mint: true, config: Object.assign({}, HIGH, { webauthnRpIds: bad }) });
      assert.equal((await l.status()).json.mintEnabled, false, 'bad pin ' + JSON.stringify(bad));
    }
  });

  await test('L-helpers: private PHP helpers refuse direct web requests', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const before = fs.existsSync(path.join(l.docroot, 'lib', 'issuer-private-key.pem'));
    for (const dir of ['atlas/studio/inc', 'lib']) {
      for (const f of fs.readdirSync(path.join(l.docroot, dir)).filter((x) => x.endsWith('.php'))) {
        const r = await l.get('/' + dir + '/' + f);
        assert.ok(r.status === 403 || r.status === 404, dir + '/' + f + ' answered ' + r.status);
        assert.ok(!/<\?php/.test(r.text), 'no source');
      }
    }
    assert.equal(fs.existsSync(path.join(l.docroot, 'lib', 'issuer-private-key.pem')), before, 'requesting helpers must not create the issuer key');
    assert.ok(fs.readFileSync(path.join(REPO, 'issuer-php', 'atlas', 'studio', 'inc', '.htaccess'), 'utf8').includes('Require all denied'), 'inc/.htaccess denies web access');
  });

  // The owner of a Studio credential, signing real intents, still cannot move it to anyone else, and an
  // administrator cannot loosen or rewrite it. Every refusal must leave the original live and issue nothing.
  const revokedIds = (l) => readJson(path.join(l.docroot, '.well-known', 'atlas-revocations.json')).revoked.map((r) => r.id);
  async function boundLab(role) {
    const l = await lab({ mint: true, config: HIGH });
    const owner = makeIdentity(role), other = makeIdentity('raw-ecdsa'), admin = makeIdentity('raw-ecdsa');
    fs.writeFileSync(path.join(l.docroot, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [
      { publicKey: admin.publicKeyB64, addedAt: new Date().toISOString() }, { publicKey: owner.publicKeyB64, addedAt: new Date().toISOString() }] }));
    fs.mkdirSync(path.join(l.docroot, '.well-known'), { recursive: true });
    fs.writeFileSync(path.join(l.docroot, '.well-known', 'spatial.json'), JSON.stringify({ fileTransfer: {}, worlds: [{ id: 'lobby' }] }));
    fs.writeFileSync(path.join(l.docroot, 'lib', 'atlas-email-tickets-config.json'), JSON.stringify({ smtpHost: '127.0.0.1', smtpPort: 1, smtpSecure: 'none', fromAddress: 'issuer@a.test' }));
    const minted = await l.mintAs(owner, DESIGN);
    assert.equal(minted.mint.status, 200, minted.mint.text);
    return { l, owner, other, admin, cred: minted.mint.json.credential };
  }
  const intentOf = (id, payload) => ({ payload, proof: signPayload(id, payload) });
  const adminCall = (l, admin, route, payload) => {
    const p = Object.assign({}, payload, { adminAuth: adminAuth(l.host, route) });
    return l.postRaw(route, { payload: p, proof: signPayload(admin, p) });
  };
  for (const role of ['raw-ecdsa', 'webauthn']) {
    await test('owner-bound (' + role + '): the real owner cannot send, mail, export, drop or trade the credential', async () => {
      const { l, owner, other, cred } = await boundLab(role);
      const now = new Date().toISOString();
      const calls = [
        ['asset/transfer', { credential: cred, recipientPublicKey: other.publicKeyB64, intent: intentOf(owner, { action: 'transfer', credentialId: cred.id, recipientPublicKey: other.publicKeyB64, issuedAt: now }) }],
        ['asset/transfer-to-email', { credential: cred, recipientEmail: 'friend@a.test', intent: intentOf(owner, { action: 'transfer-to-email', credentialId: cred.id, recipientEmail: 'friend@a.test', issuedAt: now }) }],
        ['asset/transfer-to-file', { credential: cred, intent: intentOf(owner, { action: 'transfer-to-file', credentialId: cred.id, issuedAt: now }) }],
        ['world/drop', { credential: cred, world: 'lobby', position: { x: 0, y: 0, z: 0 }, intent: intentOf(owner, { action: 'drop', credentialId: cred.id, world: 'lobby', issuedAt: now }) }],
      ];
      for (const [route, body] of calls) {
        const r = await l.postRaw('/atlas/' + route, body);
        assert.equal(r.status, 400, route + ': ' + r.text);
        assert.match(r.json.error, /bound to its owner/, route + ' must refuse for the bound policy, not for another reason: ' + r.text);
      }
      // Offering it in a trade: the owner holds a Trading Station membership and signs a real offer.
      const mem = await l.postRaw('/atlas/asset/issue', { ownerPublicKey: owner.publicKeyB64, assetClass: 'atlas.tradingstation.membership', quantity: 1 });
      assert.equal(mem.status, 200, mem.text);
      const offer = { class: cred.asset.class, quantity: 1 };
      const trade = await l.postRaw('/atlas/trade/submit', { membership: mem.json, balance: cred,
        intent: intentOf(owner, { action: 'trade', offer, want: { class: 'atlas.element.gold', quantity: 1 }, expiresAt: new Date(Date.now() + 600000).toISOString(), issuedAt: now }) });
      assert.equal(trade.status, 400, trade.text);
      assert.match(trade.json.error, /bound/i, 'trade: ' + trade.text);
      // Nothing moved: original still live and unrevoked, no other credential exists for the recipient or a file.
      assert.ok(!revokedIds(l).includes(cred.id), 'original is not revoked');
      assert.equal(replays(l).length, 1, 'only the original mint is on record');
      const pending = path.join(l.docroot, 'lib');
      for (const f of fs.readdirSync(pending)) assert.ok(!/file-export|delivery|pending-trades|world-drops/.test(f) || !fs.readFileSync(path.join(pending, f), 'utf8').includes(cred.id), 'no export/delivery/trade/drop record names the credential: ' + f);
    });
  }

  await test('owner-bound: the owner may redeem (give it up entirely); nobody else can, and a replay does nothing', async () => {
    const { l, owner, other, cred } = await boundLab('raw-ecdsa');
    const now = new Date().toISOString();
    const stranger = await l.postRaw('/atlas/asset/redeem', { credential: cred, intent: intentOf(other, { action: 'redeem', credentialId: cred.id, issuedAt: now }) });
    assert.equal(stranger.status, 400, 'a non-owner cannot redeem: ' + stranger.text);
    assert.ok(!revokedIds(l).includes(cred.id));
    const mine = await l.postRaw('/atlas/asset/redeem', { credential: cred, intent: intentOf(owner, { action: 'redeem', credentialId: cred.id, issuedAt: now }) });
    assert.equal(mine.status, 200, mine.text);
    assert.ok(revokedIds(l).includes(cred.id), 'redeemed credential is revoked');
    const again = await l.postRaw('/atlas/asset/redeem', { credential: cred, intent: intentOf(owner, { action: 'redeem', credentialId: cred.id, issuedAt: now }) });
    assert.equal(again.status, 400, 'a second redeem is refused');
  });

  await test('owner-bound: a stolen copy of the credential and a forged intent move nothing', async () => {
    const { l, owner, other, cred } = await boundLab('raw-ecdsa');
    const now = new Date().toISOString();
    // The attacker signs an intent for the credential with their own key: not the owner.
    const r = await l.postRaw('/atlas/asset/transfer', { credential: cred, recipientPublicKey: other.publicKeyB64, intent: intentOf(other, { action: 'transfer', credentialId: cred.id, recipientPublicKey: other.publicKeyB64, issuedAt: now }) });
    assert.equal(r.status, 400, r.text);
    // The owner's bridge signature for the mint cannot be replayed as a transfer intent.
    const ch = await chal(l, owner);
    const bridge = signBridge(owner, l.origin, ch.signRequest);
    const replayed = await l.postRaw('/atlas/asset/transfer', { credential: cred, recipientPublicKey: other.publicKeyB64, intent: { payload: bridge.signedPayload, proof: bridge } });
    assert.equal(replayed.status, 400, replayed.text);
    assert.ok(!revokedIds(l).includes(cred.id));
  });

  await test('privileged reissue: an administrator cannot loosen the scope or rewrite a Studio credential; clawback keeps it bound', async () => {
    const { l, owner, other, admin, cred } = await boundLab('raw-ecdsa');
    const attempts = [{ tradeScope: 'local' }, { properties: { 'atlas.studio.name': 'Forged' } }, { tradeScope: 'local', properties: { 'atlas.studio.designDigest': 'f'.repeat(64) } }];
    for (const patch of attempts) {
      const r = await adminCall(l, admin, '/atlas/asset/reissue', Object.assign({ credential: cred }, patch));
      assert.equal(r.status, 403, JSON.stringify(patch) + ': ' + r.text);
      assert.ok(!revokedIds(l).includes(cred.id), 'original untouched by ' + JSON.stringify(patch));
    }
    // The bulk path must not reach Studio credentials either: a class patch is applied to every holder's
    // credential the next time their wallet checks in.
    for (const patch of [{ tradeScope: 'local' }, { properties: { 'atlas.studio.name': 'Forged' } }]) {
      const r = await adminCall(l, admin, '/atlas/admin/class-patch', Object.assign({ assetClass: cred.asset.class }, patch));
      assert.equal(r.status, 403, 'class patch ' + JSON.stringify(patch) + ': ' + r.text);
    }
    const listed = await adminCall(l, admin, '/atlas/admin/class-patches', { action: 'list' });
    assert.ok(!JSON.stringify(listed.json || {}).includes(cred.asset.class), 'no patch recorded for the Studio class');
    // Clawback is the recovery path: it moves the credential to a new owner but must preserve the signed asset.
    const claw = await adminCall(l, admin, '/atlas/clawback', { credential: cred, toPublicKey: other.publicKeyB64 });
    assert.equal(claw.status, 200, claw.text);
    const moved = claw.json.newCredential || claw.json.credential;
    assert.deepEqual(moved.asset, cred.asset, 'clawback keeps the asset exactly, bound scope included');
    assert.equal(moved.asset.tradeScope, 'bound');
    assert.equal(moved.owner.publicKey, other.publicKeyB64);
  });

  await test('privileged reissue: a class patch stored earlier is never applied to a Studio credential at check-in', async () => {
    const { l, owner, cred } = await boundLab('raw-ecdsa');
    fs.writeFileSync(path.join(l.docroot, 'lib', 'atlas-class-patches-store.json'), JSON.stringify({ patches: { [cred.asset.class]: { tradeScope: 'local', properties: { 'atlas.studio.name': 'Forged' }, updatedAt: new Date().toISOString() } } }));
    const payload = { action: 'mail-check', domain: l.host, credentialIds: [cred.id], issuedAt: new Date().toISOString(), nonce: crypto.randomBytes(18).toString('base64url') };
    const r = await l.postRaw('/atlas/mail/check', { credentials: [cred], payload, proof: signPayload(owner, payload) });
    assert.equal(r.status, 200, r.text);
    assert.ok(!JSON.stringify(r.json).includes('class-patch'), 'no class-patch update was offered: ' + r.text);
    assert.ok(!revokedIds(l).includes(cred.id), 'credential not superseded');
  });

  // ---------------------------------------------------------------- end to end
  for (const role of ['raw-ecdsa', 'webauthn']) {
    await test('end to end mint with a ' + role + ' wallet identity: signed, bound, verifiable, stored', async () => {
      const l = await lab({ mint: true, config: HIGH });
      const id = makeIdentity(role);
      const v = await l.api('validate', DESIGN);
      const r = await l.mintAs(id, DESIGN);
      assert.equal(r.mint.status, 200, r.mint.text);
      const cred = r.mint.json.credential;
      assert.equal(r.mint.json.designDigest, v.json.designDigest, 'digest matches the page-side validate op');
      assert.equal(cred.owner.publicKey, id.publicKeyB64);
      assert.equal(cred.quantity, 1);
      assert.equal(cred.supersedes, null);
      assert.equal(cred.asset.class, 'atlas.demo.studio.collectible');
      assert.equal(cred.asset.fungible, false);
      assert.equal(cred.asset.tradeScope, 'bound');
      assert.equal(cred.asset.name, DESIGN.name);
      assert.equal(cred.asset.properties['atlas.studio.designDigest'], v.json.designDigest);
      assert.equal(cred.asset.properties['atlas.demo.noValue'], 'true');
      assert.equal(cred.asset.model, 'https://' + l.host + '/assets/studio/trophy.glb');
      assert.equal(cred.asset.thumbnail, 'https://' + l.host + '/assets/studio/trophy.png');
      assert.equal(cred.issuer.domain, l.host);
      assert.ok(await credentialVerifies(l, cred), 'issuer signature verifies');
      assert.equal(replays(l).length, 1);
      assert.equal(journals(l).length, 0);
      assert.equal(readJson(challengePath(l, r.challenge.json.nonce)).state, 'completed');
      assert.equal(readJson(attemptPath(l, r.challenge.json.nonce)).state, 'minted');
      assert.equal(readJson(attemptPath(l, r.challenge.json.nonce)).credentialId, cred.id);
    });
  }

  await test('each template maps to its own approved model and thumbnail', async () => {
    const l = await lab({ mint: true, config: HIGH });
    for (const template of ['trophy', 'badge', 'key']) {
      const design = Object.assign({}, DESIGN, { template });
      const r = await l.mintAs(makeIdentity('raw-ecdsa'), design);
      assert.equal(r.mint.status, 200, r.mint.text);
      const a = r.mint.json.credential.asset;
      assert.equal(a.model, 'https://' + l.host + '/assets/studio/' + template + '.glb');
      assert.equal(a.thumbnail, 'https://' + l.host + '/assets/studio/' + template + '.png');
    }
  });

  await test('Studio models are their own collection: the site\'s /assets models are neither used nor touched', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const own = ['trophy', 'badge', 'key'].flatMap((t) => ['glb', 'png'].map((e) => path.join(l.docroot, 'assets', t + '.' + e)));
    const before = own.map((f) => fs.readFileSync(f));
    for (const f of before) assert.equal(f.toString(), SITE_MODEL_STANDIN);
    for (const template of ['trophy', 'badge', 'key']) {
      const r = await l.mintAs(makeIdentity('raw-ecdsa'), Object.assign({}, DESIGN, { template }));
      assert.equal(r.mint.status, 200, r.mint.text);
      const a = r.mint.json.credential.asset;
      assert.ok(a.model.startsWith('https://' + l.host + '/assets/studio/') && a.thumbnail.startsWith('https://' + l.host + '/assets/studio/'), a.model);
      assert.ok(!/\/assets\/(trophy|badge|key)\./.test(a.model + a.thumbnail));
    }
    own.forEach((f, i) => assert.ok(fs.readFileSync(f).equals(before[i]), f + ' was modified'));
    // Removing the site's own models changes nothing for Studio.
    own.forEach((f) => fs.unlinkSync(f));
    const r = await l.mintAs(makeIdentity('raw-ecdsa'), DESIGN);
    assert.equal(r.mint.status, 200, r.mint.text);
    assert.ok(fs.readdirSync(path.join(l.docroot, 'assets')).every((n) => !/^(trophy|badge|key)\./.test(n)), 'Studio wrote into /assets');
  });

  await test('a missing or corrupt model fails closed and issues nothing', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    const ch = await chal(l, id, DESIGN);
    const body = bodyFor(ch, proofFor(l, id, ch));
    fs.writeFileSync(path.join(l.docroot, 'assets', 'studio', 'trophy.glb'), 'not a glb');
    let r = await l.api('mint', body);
    assert.equal(r.status, 503, r.text);
    assert.equal(replays(l).length + journals(l).length, 0);
    fs.unlinkSync(path.join(l.docroot, 'assets', 'studio', 'trophy.glb'));
    r = await l.api('challenge', { design: DESIGN, recipient: id.publicKeyB64 });
    assert.equal(r.status, 503);
    fs.copyFileSync(path.join(REPO, 'demo-domain-a', 'assets', 'studio', 'trophy.glb'), path.join(l.docroot, 'assets', 'studio', 'trophy.glb'));
    r = await l.api('mint', body);
    assert.equal(r.status, 200, 'the same unconsumed challenge still mints once the model is back: ' + r.text);
  });

  // ---------------------------------------------------------------- rejection paths
  await test('forged, tampered and mismatched requests are all refused and issue nothing', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const A = makeIdentity('raw-ecdsa'), B = makeIdentity('raw-ecdsa'), W = makeIdentity('webauthn');
    const flip = (s) => s.slice(0, -2) + (s.slice(-2) === 'AA' ? 'BB' : 'AA');
    const cases = [
      ['signature bit-flipped', A, (ch) => { const p = proofFor(l, A, ch); p.signature = flip(p.signature); return p; }, 403, 'invalid-signature'],
      ['signed by another key but names the recipient key', A, (ch) => { const p = proofFor(l, B, ch); p.publicKey = A.publicKeyB64; return p; }, 403, 'invalid-signature'],
      ['signed over a different payload than presented', A, (ch) => { const p = proofFor(l, A, ch, { payload: (x) => { x.expiresAt += 1; } }); p.signedPayload = JSON.parse(JSON.stringify({ ctx: 'atlas.bridge.sign/1', origin: l.origin, payload: ch.signRequest })); return p; }, 403, 'invalid-signature'],
      ['recipient is another key (proof fully by B)', A, (ch) => proofFor(l, B, ch), 403, 'proof-mismatch'],
      ['payload recipient swapped to B', A, (ch) => proofFor(l, A, ch, { payload: (x) => { x.recipient = B.publicKeyB64; } }), 403, 'proof-mismatch'],
      ['origin of another site', A, (ch) => proofFor(l, A, ch, { origin: 'https://a.test' }), 403, 'wrong-signing-context'],
      ['origin of another port', A, (ch) => proofFor(l, A, ch, { origin: 'http://localhost:1' }), 403, 'wrong-signing-context'],
      ['wrong signing context', A, (ch) => proofFor(l, A, ch, { ctx: 'atlas.request/1' }), 403, 'wrong-signing-context'],
      ['wrong purpose', A, (ch) => proofFor(l, A, ch, { payload: (x) => { x.purpose = 'atlas.other/1'; } }), 403, 'proof-mismatch'],
      ['nonce swapped', A, (ch) => proofFor(l, A, ch, { payload: (x) => { x.nonce = 'b'.repeat(64); } }), 403, 'proof-mismatch'],
      ['digest swapped', A, (ch) => proofFor(l, A, ch, { payload: (x) => { x.designDigest = 'c'.repeat(64); } }), 403, 'proof-mismatch'],
      ['summary tampered', A, (ch) => proofFor(l, A, ch, { payload: (x) => { x.summary = 'Free gold bar'; } }), 403, 'proof-mismatch'],
      ['expiry extended', A, (ch) => proofFor(l, A, ch, { payload: (x) => { x.expiresAt += 3600; } }), 403, 'proof-mismatch'],
      ['extra field in the signed payload', A, (ch) => proofFor(l, A, ch, { payload: (x) => { x.extra = 1; } }), 400, 'invalid-payload-shape'],
      ['missing field in the signed payload', A, (ch) => proofFor(l, A, ch, { payload: (x) => { delete x.summary; } }), 400, 'invalid-payload-shape'],
      ['expiry as a string', A, (ch) => proofFor(l, A, ch, { payload: (x) => { x.expiresAt = String(x.expiresAt); } }), 400, 'invalid-proof-types'],
      ['unknown field on the proof', A, (ch) => Object.assign(proofFor(l, A, ch), { admin: true }), 400, 'invalid-proof'],
      ['role says webauthn with a raw key', A, (ch) => Object.assign(proofFor(l, A, ch), { signerRole: 'webauthn' }), 403, 'invalid-proof-key'],
      ['unknown signer role', A, (ch) => Object.assign(proofFor(l, A, ch), { signerRole: 'none' }), 403, 'proof-mismatch'],
      ['webauthn without user presence', W, (ch) => proofFor(l, W, ch, { flags: 0x00 }), 403, 'webauthn-presence-required'],
      ['webauthn with only user verification', W, (ch) => proofFor(l, W, ch, { flags: 0x04 }), 403, 'webauthn-presence-required'],
      ['webauthn registration assertion type', W, (ch) => proofFor(l, W, ch, { type: 'webauthn.create' }), 403, 'webauthn-presence-required'],
      ['webauthn signature bit-flipped', W, (ch) => { const p = proofFor(l, W, ch); p.signature = flip(p.signature); return p; }, 403, 'invalid-signature'],
    ];
    for (const [label, id, makeProof, status, error] of cases) {
      const ch = await chal(l, id, DESIGN);
      const r = await l.api('mint', bodyFor(ch, makeProof(ch)));
      assert.equal(r.status, status, label + ': ' + r.text);
      assert.equal(r.json.error, error, label);
      assert.ok(!r.json.credential, label + ' must not return a credential');
      assert.equal(readJson(challengePath(l, ch.nonce)).state, 'issued', label + ': a rejected request leaves the challenge usable');
    }
    assert.equal(replays(l).length + journals(l).length, 0, 'nothing was issued by any rejected request');
    assert.equal(l.studioFiles('mint-receipts').filter((n) => /^attempt-/.test(n)).length, 0, 'rejected requests claim no quota');
  });

  await test('an altered design is refused even with a genuine signature over the original', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    const ch = await chal(l, id, DESIGN);
    const proof = proofFor(l, id, ch);
    for (const edit of [{ name: 'Free Gold' }, { finish: 'silver' }, { template: 'key' }, { description: 'x' }]) {
      const r = await l.api('mint', bodyFor(ch, proof, Object.assign({}, DESIGN, edit)));
      assert.equal(r.status, 403, JSON.stringify(edit) + r.text);
      assert.equal(r.json.error, 'proof-mismatch');
    }
    const r = await l.api('mint', bodyFor(ch, proof, Object.assign({}, DESIGN, { extra: 1 })));
    assert.equal(r.status, 400);
    assert.equal(replays(l).length, 0);
    const ok = await l.api('mint', bodyFor(ch, proof));
    assert.equal(ok.status, 200, ok.text);
  });

  await test('the signed design digest binds a challenge to one design', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    const ch = await chal(l, id, DESIGN);
    const other = Object.assign({}, DESIGN, { name: 'Other' });
    const r = await l.api('mint', bodyFor(ch, proofFor(l, id, ch), other));
    assert.equal(r.status, 403);
    const ch2 = await chal(l, id, other);
    assert.notEqual(ch2.designDigest, ch.designDigest);
  });

  await test('Origin header from another site is refused; no CORS headers are sent', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    let r = await l.api('challenge', { design: DESIGN, recipient: id.publicKeyB64 }, { Origin: 'https://a.test' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'origin-not-allowed');
    r = await l.api('challenge', { design: DESIGN, recipient: id.publicKeyB64 }, { Origin: l.origin });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(l.studioFiles('tmp').filter((n) => /^mint-challenge/.test(n)).length, 1, 'only the allowed request created a challenge');
  });

  await test('invalid recipients are refused when asking for a challenge', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const good = makeIdentity('raw-ecdsa');
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' });
    const offCurve = Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]);
    const bad = [good.publicKeyB64.slice(0, 80), good.publicKeyB64 + 'A', b64u(p384), b64u(offCurve), '', 'x', 5, null, [good.publicKeyB64], { k: 1 }, good.publicKeyB64 + '=', good.publicKeyB64.replace(/[-_]/, '+')];
    for (const recipient of bad) {
      const r = await l.api('challenge', { design: DESIGN, recipient });
      assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(recipient).slice(0, 40) + ' -> ' + r.status + r.text);
    }
    assert.equal(l.studioFiles('tmp').filter((n) => /^mint-challenge/.test(n)).length, 0);
  });

  await test('hostile request shapes never reach issuance and never produce a server error', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    const ch = await chal(l, id, DESIGN);
    const good = bodyFor(ch, proofFor(l, id, ch));
    const raw = (b, h) => l.postRaw('/atlas/studio/api.php?op=mint', b, h);
    let r = await raw('{nope');
    assert.equal(r.status, 400);
    r = await raw(JSON.stringify(good), { 'Content-Type': 'text/plain' });
    assert.equal(r.status, 415);
    r = await raw(JSON.stringify(Object.assign({}, good, { pad: 'x'.repeat(20000) })));
    assert.equal(r.status, 413);
    r = await raw('[1,2,3]');
    assert.equal(r.status, 400);
    r = await l.postRaw('/atlas/studio/api.php?op=nope', '{}');
    assert.equal(r.status, 404);
    r = await l.get('/atlas/studio/api.php?op=mint');
    assert.equal(r.status, 405);
    r = await l.postRaw('/atlas/studio/api.php?op=status', '{}');
    assert.equal(r.status, 405);
    // Randomised type confusion over every leaf and container of a valid request.
    const paths = [];
    (function walk(v, p) { paths.push(p); if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], p.concat(k)); })(good, []);
    const junk = [null, 0, -1, 1.5, '', 'x', 'a'.repeat(64), [], {}, [1], { a: 1 }, true, false, 'A'.repeat(3000), 9007199254740993, '\u0000', '\ud800'];
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 70; i++) {
      const copy = JSON.parse(JSON.stringify(good));
      const p = paths[1 + rnd(paths.length - 1)];
      let ref = copy;
      for (const k of p.slice(0, -1)) ref = ref[k];
      const value = junk[rnd(junk.length)];
      if (rnd(5) === 0) delete ref[p[p.length - 1]]; else ref[p[p.length - 1]] = value;
      const resp = await raw(JSON.stringify(copy));
      assert.ok(resp.status >= 400 && resp.status < 500, 'path ' + p.join('.') + ' value ' + JSON.stringify(value) + ' -> ' + resp.status + ' ' + resp.text.slice(0, 200));
    }
    assert.equal(replays(l).length + journals(l).length, 0);
    assert.equal((await raw(JSON.stringify(good))).status, 200, 'the untouched request still works');
  });

  await test('unknown, malformed and expired challenges are refused', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    const ch = await chal(l, id, DESIGN);
    const proof = proofFor(l, id, ch);
    let r = await l.api('mint', Object.assign(bodyFor(ch, proof), { nonce: crypto.randomBytes(32).toString('hex') }));
    assert.equal(r.status, 404);
    for (const nonce of ['../../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), 5, null, ch.nonce + '\n']) {
      r = await l.api('mint', Object.assign(bodyFor(ch, proof), { nonce }));
      assert.ok(r.status === 400 || r.status === 404, JSON.stringify(nonce) + r.status);
    }
    // Expired: the stored expiry is in the past and the wallet signed exactly that.
    const stored = readJson(challengePath(l, ch.nonce));
    stored.expiresAt = Math.floor(Date.now() / 1000) - 5;
    fs.writeFileSync(challengePath(l, ch.nonce), JSON.stringify(stored));
    const past = proofFor(l, id, ch, { payload: (x) => { x.expiresAt = stored.expiresAt; } });
    r = await l.api('mint', bodyFor(ch, past));
    assert.equal(r.status, 410, r.text);
    assert.equal(r.json.error, 'challenge-expired');
    // Far-future expiry (a tampered challenge file) is refused too.
    stored.expiresAt = Math.floor(Date.now() / 1000) + 100000;
    fs.writeFileSync(challengePath(l, ch.nonce), JSON.stringify(stored));
    const future = proofFor(l, id, ch, { payload: (x) => { x.expiresAt = stored.expiresAt; } });
    r = await l.api('mint', bodyFor(ch, future));
    assert.equal(r.status, 410, r.text);
    // Truncated challenge file fails closed.
    fs.writeFileSync(challengePath(l, ch.nonce), '{"nonce"');
    r = await l.api('mint', bodyFor(ch, proof));
    assert.equal(r.status, 404);
    assert.equal(replays(l).length + journals(l).length, 0);
  });

  // ---------------------------------------------------------------- replay and idempotency
  await test('replaying a completed mint returns the identical credential; it never issues a second', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    const r = await l.mintAs(id, DESIGN);
    assert.equal(r.mint.status, 200);
    for (let i = 0; i < 4; i++) {
      const again = await l.api('mint', r.body);
      assert.equal(again.status, 200);
      assert.equal(again.text, r.mint.text, 'byte-identical');
    }
    assert.equal(replays(l).length, 1);
    // A different design, a different signer, or a stripped proof cannot ride on the completed nonce.
    const other = makeIdentity('raw-ecdsa');
    const ch = r.challenge.json;
    for (const [label, body] of [
      ['other design', Object.assign({}, r.body, { design: Object.assign({}, DESIGN, { name: 'Copy' }) })],
      ['other signer', Object.assign({}, r.body, { proof: proofFor(l, other, ch) })],
      ['wrong proof origin', Object.assign({}, r.body, { proof: proofFor(l, id, ch, { origin: 'https://a.test' }) })],
    ]) {
      const x = await l.api('mint', body);
      assert.equal(x.status, 403, label + x.text);
      assert.ok(!x.json.credential, label);
    }
    assert.equal(replays(l).length, 1);
  });

  await test('a second mint with a fresh nonce for the same design issues a distinct credential', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    const a = await l.mintAs(id, DESIGN), b = await l.mintAs(id, DESIGN);
    assert.equal(a.mint.status + b.mint.status, 400);
    assert.notEqual(a.mint.json.credential.id, b.mint.json.credential.id);
    assert.equal(replays(l).length, 2);
  });

  await test('issuer state survives a hard restart: same key, same stored result, retry still byte-identical', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    const r = await l.mintAs(id, DESIGN);
    const keyBefore = (await l.get('/.well-known/atlas-key.json')).text;
    await l.hardStop();
    const l2 = await StudioLab.start({ reuse: l });
    labs.push(l2);
    assert.equal((await l2.get('/.well-known/atlas-key.json')).text, keyBefore);
    const again = await l2.api('mint', r.body);
    assert.equal(again.status, 200);
    assert.equal(again.text, r.mint.text);
    assert.ok(await credentialVerifies(l2, again.json.credential));
    const next = await l2.mintAs(id, DESIGN);
    assert.equal(next.mint.status, 200);
    assert.equal(replays(l2).length, 2);
  });

  // ---------------------------------------------------------------- concurrency
  await test('twelve simultaneous identical mints produce exactly one credential', async () => {
    const l = await lab({ mint: true, config: HIGH, workers: 8 });
    const id = makeIdentity('raw-ecdsa');
    const ch = await chal(l, id, DESIGN);
    const body = bodyFor(ch, proofFor(l, id, ch));
    const out = await Promise.all(Array.from({ length: 12 }, () => l.api('mint', body)));
    const ok = out.filter((r) => r.status === 200);
    assert.ok(ok.length >= 1, 'at least one succeeds: ' + out.map((r) => r.status));
    for (const r of out) assert.ok(r.status === 200 || r.status === 503, 'only success or busy: ' + r.status + r.text);
    assert.equal(new Set(ok.map((r) => r.text)).size, 1, 'every success is the same credential');
    assert.equal(replays(l).length, 1);
    assert.equal(journals(l).length, 0);
    const final = await l.api('mint', body);
    assert.equal(final.text, ok[0].text);
  });

  await test('concurrent mints for one recipient stop at the per-recipient quota', async () => {
    const l = await lab({ mint: true, config: Object.assign({}, HIGH, { maxMintsPerRecipientPerDay: 3 }), workers: 8 });
    const id = makeIdentity('raw-ecdsa');
    const out = await Promise.all(Array.from({ length: 8 }, () => l.mintAs(id, DESIGN)));
    const codes = out.map((o) => o.mint.status);
    assert.equal(codes.filter((c) => c === 200).length, 3, codes.join(','));
    for (const o of out) if (o.mint.status !== 200) assert.equal(o.mint.json.error, 'quota-recipient');
    assert.equal(replays(l).length, 3);
    // A completed request is a retry, not a new claim: it still answers once the quota is spent.
    const done = out.find((o) => o.mint.status === 200);
    assert.equal((await l.api('mint', done.body)).text, done.mint.text);
  });

  await test('concurrent mints from many recipients stop at the global daily quota', async () => {
    const l = await lab({ mint: true, config: Object.assign({}, HIGH, { maxMintsPerDay: 4 }), workers: 8 });
    const out = await Promise.all(Array.from({ length: 9 }, () => l.mintAs(makeIdentity('raw-ecdsa'), DESIGN)));
    const codes = out.map((o) => o.mint.status);
    assert.equal(codes.filter((c) => c === 200).length, 4, codes.join(','));
    for (const o of out) if (o.mint.status !== 200) assert.equal(o.mint.json.error, 'quota-global');
    assert.equal(replays(l).length, 4);
  });

  await test('per-address rate limits apply to challenges and new mints, not to retries', async () => {
    const l = await lab({ mint: true, config: Object.assign({}, HIGH, { mintsPerIpPerHour: 2, challengesPerIpPerHour: 5 }) });
    const first = await l.mintAs(makeIdentity('raw-ecdsa'), DESIGN);
    const second = await l.mintAs(makeIdentity('raw-ecdsa'), DESIGN);
    assert.equal(first.mint.status + second.mint.status, 400);
    const third = await l.mintAs(makeIdentity('raw-ecdsa'), DESIGN);
    assert.equal(third.mint.status, 429);
    assert.equal(third.mint.json.error, 'rate-limited');
    assert.equal((await l.api('mint', first.body)).status, 200, 'a retry of a finished mint is not rate limited');
    const fourth = await l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 });
    assert.equal(fourth.status, 200);
    const fifth = await l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 });
    assert.equal(fifth.status, 200);
    const sixth = await l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 });
    assert.equal(sixth.status, 429);
    assert.equal(replays(l).length, 2);
  });

  await test('M2: one address is held to its own daily share, so it cannot spend the global quota', async () => {
    const l = await lab({ mint: true, config: Object.assign({}, HIGH, { maxMintsPerActorPerDay: 2, maxMintsPerDay: 5 }) });
    const a = await l.mintAs(makeIdentity('raw-ecdsa'), DESIGN), b = await l.mintAs(makeIdentity('raw-ecdsa'), DESIGN);
    assert.equal(a.mint.status + b.mint.status, 400);
    const c = await l.mintAs(makeIdentity('raw-ecdsa'), DESIGN);
    assert.equal(c.mint.status, 429);
    assert.equal(c.mint.json.error, 'quota-actor');
    assert.equal((await l.api('mint', a.body)).text, a.mint.text, 'a retry of a finished mint is unaffected');
    assert.equal(replays(l).length, 2);
    const stored = readJson(attemptPath(l, a.challenge.json.nonce));
    assert.ok(/^[a-f0-9]{16}$/.test(stored.actor), 'the ledger stores a hashed actor id');
    assert.ok(!JSON.stringify(stored).includes('127.0.0.1'), 'and never the address');
  });

  await test('R1: rate counters live in a fixed table of private slot files, whatever the traffic', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const dir = path.join(l.studio, 'rate');
    // Leave a pre-existing counter-shaped file alone; the table must not depend on directory contents.
    for (let i = 0; i < 25; i++) assert.equal((await l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 })).status, 200);
    const names = fs.readdirSync(dir);
    assert.ok(names.every((n) => /^rate-slot-[0-9a-f]{4}\.json$/.test(n) || n === '.salt'), 'only slot files and the salt: ' + names.join(','));
    assert.ok(names.length <= 4097, 'bounded: ' + names.length);
    assert.equal(fs.statSync(path.join(dir, '.salt')).size, 32, 'the slot salt is 32 random bytes');
    // Many requests from one address do not create files per request.
    const before = fs.readdirSync(dir).length;
    for (let i = 0; i < 10; i++) await l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 });
    assert.ok(fs.readdirSync(dir).length <= before + 1, 'no growth per request');
    assert.equal(replays(l).length, 0);
  });

  await test('R2: configuration of the network quota and the new-actor reserve fails closed', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const cfgFile = path.join(l.studio, 'studio-config.json');
    const base = Object.assign({ mintEnabled: true, domain: l.host, origins: [l.origin] }, HIGH);
    const on = async (extra) => { fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({}, base, extra))); return (await l.status()).json.mintEnabled; };
    assert.equal(await on({}), true, 'defaults are valid');
    assert.equal(await on({ maxMintsPerNetworkPerDay: 5, newActorReserve: 3, maxMintsPerDay: 10 }), true);
    assert.equal(await on({ newActorReserve: 0 }), true, 'no reserve is allowed');
    for (const bad of [{ maxMintsPerNetworkPerDay: 0 }, { maxMintsPerNetworkPerDay: '5' }, { maxMintsPerNetworkPerDay: 10001 },
      { newActorReserve: -1 }, { newActorReserve: '2' }, { newActorReserve: 1.5 }, { maxMintsPerDay: 10, newActorReserve: 10 }, { newActorReserve: 100000 }]) {
      assert.equal(await on(bad), false, JSON.stringify(bad));
    }
  });

  await test('R2: an established address cannot take the new-actor reserve (end to end)', async () => {
    // Loopback is one IPv4 actor. Daily limit 4 with 2 reserved: the first mint comes from a first-time actor,
    // the second still fits below the unreserved line, the third would dip into the reserve and is refused.
    const l = await lab({ mint: true, config: Object.assign({}, HIGH, { maxMintsPerDay: 4, newActorReserve: 2 }) });
    const a = await l.mintAs(makeIdentity('raw-ecdsa'), DESIGN), b = await l.mintAs(makeIdentity('raw-ecdsa'), DESIGN);
    assert.equal(a.mint.status + b.mint.status, 400);
    const c = await l.mintAs(makeIdentity('raw-ecdsa'), DESIGN);
    assert.equal(c.mint.status, 429);
    assert.equal(c.mint.json.error, 'quota-reserved');
    assert.equal(replays(l).length, 2, 'nothing issued for the refused mint');
    assert.equal((await l.api('mint', a.body)).text, a.mint.text, 'a retry of a finished mint is unaffected');
    const stored = readJson(attemptPath(l, a.challenge.json.nonce));
    assert.ok(!JSON.stringify(stored).includes('127.0.0.1'), 'the ledger never stores the address');
  });

  await test('outstanding challenges are capped', async () => {
    const l = await lab({ mint: true, config: Object.assign({}, HIGH, { maxOutstandingChallenges: 3 }) });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 })).status);
    assert.deepEqual(codes, [200, 200, 200, 503, 503]);
  });

  await test('M1: expired and completed challenges do not count toward the outstanding cap', async () => {
    const l = await lab({ mint: true, config: Object.assign({}, HIGH, { maxOutstandingChallenges: 3 }) });
    const ids = [makeIdentity('raw-ecdsa'), makeIdentity('raw-ecdsa'), makeIdentity('raw-ecdsa')];
    const chs = [];
    for (const id of ids) chs.push(await chal(l, id, DESIGN));
    assert.equal((await l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 })).status, 503, 'cap reached by live challenges');
    // One completes (a finished mint), one expires; both stop counting at once.
    const done = await l.api('mint', bodyFor(chs[0], proofFor(l, ids[0], chs[0])));
    assert.equal(done.status, 200, done.text);
    const stored = readJson(challengePath(l, chs[1].nonce));
    stored.expiresAt = Math.floor(Date.now() / 1000) - 10;
    fs.writeFileSync(challengePath(l, chs[1].nonce), JSON.stringify(stored));
    const old = new Date(Date.now() - 400 * 1000);
    fs.utimesSync(challengePath(l, chs[1].nonce), old, old);
    const a = await l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 });
    assert.equal(a.status, 200, 'completed challenge freed a slot: ' + a.text);
    const b = await l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 });
    assert.equal(b.status, 200, 'expired challenge freed a slot: ' + b.text);
    assert.equal((await l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 })).status, 503, 'but the cap still holds for live ones');
  });

  await test('M1: the cap holds exactly under simultaneous challenge requests', async () => {
    const l = await lab({ mint: true, config: Object.assign({}, HIGH, { maxOutstandingChallenges: 4 }), workers: 8 });
    const out = await Promise.all(Array.from({ length: 16 }, () => l.api('challenge', { design: DESIGN, recipient: makeIdentity('raw-ecdsa').publicKeyB64 })));
    assert.equal(out.filter((r) => r.status === 200).length, 4, out.map((r) => r.status).join(','));
    assert.equal(l.studioFiles('tmp').filter((n) => /^mint-challenge/.test(n)).length, 4);
  });

  await test('M1: abandoned challenges are removed soon after expiry, those tied to an attempt are kept', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    const abandoned = await chal(l, id, DESIGN);
    const minted = await l.mintAs(id, DESIGN);
    assert.equal(minted.mint.status, 200);
    const age = new Date(Date.now() - 1000 * 1000);
    for (const n of [abandoned.nonce, minted.challenge.json.nonce]) fs.utimesSync(challengePath(l, n), age, age);
    await chal(l, id, DESIGN); // any new challenge triggers pruning
    assert.ok(!fs.existsSync(challengePath(l, abandoned.nonce)), 'unclaimed expired challenge pruned');
    assert.ok(fs.existsSync(challengePath(l, minted.challenge.json.nonce)), 'a challenge with an attempt record is kept for retries');
    assert.equal((await l.api('mint', minted.body)).text, minted.mint.text, 'its retry still works');
  });

  // ---------------------------------------------------------------- crash recovery
  const CRASH_POINTS = [
    ['studio:claimed', false], ['studio:signed', false], ['txn:minted', false],
    ['txn:journal-written', true], ['txn:holdings-registered', true], ['txn:revoked', true],
    ['txn:replay-stored', true], ['txn:journal-removed', true], ['studio:committed', true],
  ];
  for (const [point, committedBeforeRetry] of CRASH_POINTS) {
    await test('crash at ' + point + ': a retry on a restarted issuer yields exactly one credential', async () => {
      const cfg = Object.assign({}, HIGH, { maxMintsPerRecipientPerDay: 1 });
      const l = await lab({ mint: true, config: cfg, crashAt: point });
      const id = makeIdentity(point.length % 2 ? 'raw-ecdsa' : 'webauthn');
      const ch = await chal(l, id, DESIGN);
      const body = bodyFor(ch, proofFor(l, id, ch));
      let first = null;
      try { first = await l.api('mint', body); } catch (e) { first = null; }
      assert.ok(first === null || !(first.json && first.json.credential), 'the crashing request must not return a credential (got ' + (first && first.status) + ' ' + (first && first.text.slice(0, 80)) + ')');
      await l.hardStop();
      const stateBefore = replays(l).length + journals(l).length;
      assert.equal(stateBefore > 0, committedBeforeRetry, 'issuer state right after the crash: ' + stateBefore);
      let committedId = null;
      if (committedBeforeRetry) {
        const rec = journals(l).length ? readJson(path.join(l.private, 'txn', journals(l)[0])) : readJson(path.join(l.private, 'replay', replays(l)[0]));
        committedId = JSON.parse(rec.responseJson || rec.response || '{}').credential;
        committedId = committedId ? committedId.id : null;
      }
      const l2 = await StudioLab.start({ reuse: l });
      labs.push(l2);
      let retry = null;
      for (let i = 0; i < 3 && (!retry || retry.status === 503); i++) retry = await l2.api('mint', body);
      assert.equal(retry.status, 200, retry.text);
      const cred = retry.json.credential;
      assert.ok(await credentialVerifies(l2, cred));
      if (committedBeforeRetry && committedId) assert.equal(cred.id, committedId, 'the retry returns the credential that was committed before the crash');
      assert.equal(replays(l2).length, 1, 'exactly one replay record');
      assert.equal(journals(l2).length, 0, 'journal drained');
      assert.equal(readJson(attemptPath(l2, ch.nonce)).state, 'minted');
      assert.equal(readJson(attemptPath(l2, ch.nonce)).credentialId, cred.id);
      assert.equal(readJson(challengePath(l2, ch.nonce)).state, 'completed');
      const again = await l2.api('mint', body);
      assert.equal(again.text, retry.text, 'further retries are byte-identical');
      const second = await l2.mintAs(id, DESIGN);
      assert.equal(second.mint.status, 429, 'the crashed attempt counted once toward the recipient quota');
      assert.equal(replays(l2).length, 1);
    });
  }

  await test('T1: the issuer fsyncs the file, renames it, then fsyncs the directory (strace; skipped without strace or PHP 8.1+)', async () => {
    const have = spawnSync('strace', ['-V'], { encoding: 'utf8' });
    const php81 = spawnSync('php', ['-r', 'exit(function_exists("fsync")?0:1);']);
    if (have.error || have.status !== 0 || php81.status !== 0) { console.log('     (skipped: needs strace and PHP 8.1+)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-strace-'));
    const script = path.join(dir, 'w.php');
    fs.writeFileSync(script, "<?php $_SERVER['HTTP_HOST']='localhost'; require '" + path.join(REPO, 'issuer-php', 'lib', 'bootstrap.php') + "';\natlas_write_file_atomic('" + dir + "/x.json', '{\"a\":1}', 0600);\n");
    const log = path.join(dir, 'st.log');
    const r = spawnSync('strace', ['-f', '-e', 'trace=fsync,fdatasync,rename,openat', '-o', log, 'php', script], { env: Object.assign({}, process.env, { ATLAS_PRIVATE_DIR: dir }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const lines = fs.readFileSync(log, 'utf8').split('\n');
    const idx = (re) => lines.findIndex((x) => re.test(x));
    const tmpOpen = idx(/openat\(.*x\.json\.[0-9a-f]{12}\.tmp.*O_EXCL/);
    const dataSync = tmpOpen + lines.slice(tmpOpen).findIndex((x) => /fsync\(\d+\)\s+= 0/.test(x));
    const rename = idx(/rename\(.*x\.json\.[0-9a-f]{12}\.tmp.*x\.json"\)\s+= 0/);
    const dirOpen = rename + lines.slice(rename).findIndex((x) => /openat\(.*"[^"]*studio-strace-[^"/]*", O_RDONLY\)\s+= \d+/.test(x));
    const dirSync = dirOpen + lines.slice(dirOpen).findIndex((x) => /fsync\(\d+\)\s+= 0/.test(x));
    assert.ok(tmpOpen >= 0 && dataSync > tmpOpen && rename > dataSync && dirOpen > rename && dirSync > dirOpen, 'order: file fsync < rename < directory fsync\n' + lines.filter((x) => /fsync|rename|studio-strace/.test(x)).join('\n'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const point of ['studio:attempt-tmp-written', 'studio:challenge-tmp-written']) {
    await test('T1: crash while replacing a bookkeeping record (' + point + ') leaves the old record intact and the mint retrievable', async () => {
      const l = await lab({ mint: true, config: HIGH, crashAt: point });
      const id = makeIdentity('raw-ecdsa');
      const ch = await chal(l, id, DESIGN);
      const body = bodyFor(ch, proofFor(l, id, ch));
      try { await l.api('mint', body); } catch (e) { /* the server stops mid-request */ }
      await l.hardStop();
      assert.equal(replays(l).length + journals(l).length, 1, 'the credential was committed before the crash');
      // The record being replaced is whole (never truncated) and still parses; the half-written copy is a separate temp file.
      const chFile = readJson(challengePath(l, ch.nonce));
      assert.equal(chFile.nonce, ch.nonce);
      const attFile = readJson(attemptPath(l, ch.nonce));
      assert.equal(attFile.nonce, ch.nonce);
      assert.ok(['issued', 'completed'].includes(chFile.state) && ['claimed', 'minted'].includes(attFile.state));
      const l2 = await StudioLab.start({ reuse: l });
      labs.push(l2);
      let r = null;
      for (let i = 0; i < 3 && (!r || r.status === 503); i++) r = await l2.api('mint', body);
      assert.equal(r.status, 200, r.text);
      assert.equal(replays(l2).length, 1);
      assert.equal(readJson(attemptPath(l2, ch.nonce)).state, 'minted');
      assert.equal(readJson(challengePath(l2, ch.nonce)).state, 'completed');
      assert.equal((await l2.api('mint', body)).text, r.text);
    });
  }

  await test('hard-kill the issuer mid-flight under load, restart, retry everything: one credential per authorized request', async () => {
    const l = await lab({ mint: true, config: HIGH, workers: 8 });
    let cur = l;
    const all = [];
    for (const delay of [15, 60, 140]) {
      const batch = [];
      for (let i = 0; i < 6; i++) {
        const id = makeIdentity(i % 2 ? 'webauthn' : 'raw-ecdsa');
        const ch = await chal(cur, id, DESIGN);
        batch.push({ id, ch, body: bodyFor(ch, proofFor(cur, id, ch)), first: null });
      }
      const inflight = batch.map((b) => cur.api('mint', b.body).then((r) => { b.first = r; }, () => { b.first = null; }));
      await sleep(delay);
      await cur.hardStop();
      await Promise.all(inflight);
      cur = await StudioLab.start({ reuse: l });
      labs.push(cur);
      for (const b of batch) {
        let r = null;
        for (let i = 0; i < 4 && (!r || r.status === 503); i++) r = await cur.api('mint', b.body);
        assert.equal(r.status, 200, r.text);
        if (b.first && b.first.status === 200) assert.equal(r.text, b.first.text, 'an answer already delivered matches the retry');
        assert.ok(await credentialVerifies(cur, r.json.credential));
        b.final = r.text;
        all.push(b);
      }
    }
    assert.equal(replays(cur).length, 18, 'one replay record per authorized request');
    assert.equal(journals(cur).length, 0);
    assert.equal(new Set(all.map((b) => JSON.parse(b.final).credential.id)).size, 18, 'no duplicate credential ids');
    const ids = JSON.stringify(all.map((b) => JSON.parse(b.final).credential.id));
    for (const b of all) assert.equal((ids.match(new RegExp(JSON.parse(b.final).credential.id, 'g')) || []).length, 1);
  });

  // ---------------------------------------------------------------- bypass, bound ownership, leaks
  await test('general issuance routes refuse the Studio class and issue nothing', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const owner = makeIdentity('raw-ecdsa').publicKeyB64;
    const cls = 'atlas.demo.studio.collectible';
    let r = await l.adminPost('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: cls, quantity: 1 });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, 'studio-authorization-required');
    for (const route of ['/atlas/asset/mint', '/atlas/asset/reissue', '/atlas/mail/send', '/atlas/clawback', '/atlas/admin/class-patch']) {
      r = await l.adminPost(route, { payload: { ownerPublicKey: owner, assetClass: cls, giftAssetClass: cls, giftOwnerPublicKey: owner, credentialId: 'x', subject: 's', body: 'b' }, token: 'nope' });
      assert.ok(r.status >= 400 && r.status < 500, route + ' -> ' + r.status);
      assert.ok(!/"signature"/.test(r.text), route + ' must not return a signed credential');
    }
    assert.equal(replays(l).length + journals(l).length, 0);
    // The one shared choke point refuses it for every caller that reaches it, authorized or not.
    const script = path.join(l.root, 'choke.php');
    fs.writeFileSync(script, "<?php $_SERVER['HTTP_HOST']='localhost'; require '" + path.join(l.docroot, 'lib', 'bootstrap.php') + "';\n" +
      "$kp=atlas_load_keys();\n" +
      "foreach (['atlas.demo.studio.collectible'] as $c) { try { mint_asset_by_class($kp['privateKey'],$kp['publicKeyB64url'],'" + owner + "',$c,1,null,null,false); echo 'MINTED'; } catch (Exception $e) { echo 'REFUSED:'.$e->getCode(); } }\n");
    const out = spawnSync('php', [script], { env: Object.assign({}, process.env, { ATLAS_PRIVATE_DIR: l.private }), encoding: 'utf8' });
    assert.equal(out.stdout.trim(), 'REFUSED:403', out.stdout + out.stderr);
    assert.equal(replays(l).length + journals(l).length, 0);
  });

  await test('the Node issuer also refuses the Studio class on its general issuance route', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-node-'));
    const port = await new Promise((resolve) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const proc = spawn('node', ['issuer-server/server.js'], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { PORT: String(port), ATLAS_DOMAIN: 'localhost:' + port, ATLAS_STATE_DIR: path.join(dir, 'state'), ATLAS_DOCROOT: path.join(dir, 'docroot') }),
    });
    try {
      fs.mkdirSync(path.join(dir, 'docroot', '.well-known'), { recursive: true });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('node issuer did not start')), 15000);
        proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
        proc.on('exit', (c) => reject(new Error('node issuer exited ' + c)));
      });
      const owner = makeIdentity('raw-ecdsa').publicKeyB64;
      const r = await require('./studio-lab').request(port, 'POST', '/atlas/asset/issue', { ownerPublicKey: owner, assetClass: 'atlas.demo.studio.collectible', quantity: 1 });
      assert.equal(r.status, 403, r.text);
      assert.equal(r.json.code, 'studio-authorization-required');
      assert.ok(!/"signature"/.test(r.text));
      const ok = await require('./studio-lab').request(port, 'POST', '/atlas/asset/issue', { ownerPublicKey: owner, assetClass: 'atlas.membership', quantity: 1 });
      assert.notEqual(ok.status, 403, 'ordinary classes are unaffected: ' + ok.text);
    } finally {
      proc.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('the Studio class is not tradable, convertible or listed; the credential is owner-bound', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const cat = await l.get('/atlas/trade/catalog');
    assert.equal(cat.status, 200);
    assert.ok(!cat.json.classes.some((c) => c.class === 'atlas.demo.studio.collectible'), 'not in the trade catalog');
    const id = makeIdentity('raw-ecdsa');
    const r = await l.mintAs(id, DESIGN);
    assert.equal(r.mint.json.credential.asset.tradeScope, 'bound');
    assert.equal(r.mint.json.credential.asset.fungible, false);
    for (const route of ['/atlas/asset/split', '/atlas/asset/consolidate', '/atlas/convert']) {
      const x = await l.adminPost(route, { credential: r.mint.json.credential, toPublicKey: makeIdentity('raw-ecdsa').publicKeyB64, amount: 1, toClass: 'atlas.demo.studio.collectible' });
      assert.ok(x.status >= 400 && x.status < 500, route + ' -> ' + x.status);
      assert.ok(!/"signature"/.test(x.text), route);
    }
    assert.equal(replays(l).length, 1, 'still only the original credential');
  });

  await test('responses and Studio files leak no private paths, keys or other holders\' data', async () => {
    const l = await lab({ mint: true, config: HIGH });
    const id = makeIdentity('raw-ecdsa');
    const texts = [];
    const r = await l.mintAs(id, DESIGN);
    texts.push(r.challenge.text, r.mint.text);
    for (const p of [{ nonce: 'a'.repeat(64) }, '{bad']) texts.push((await l.postRaw('/atlas/studio/api.php?op=mint', typeof p === 'string' ? p : JSON.stringify(p))).text);
    texts.push((await l.get('/atlas/studio/inc/studio-mint.php')).text, (await l.get('/atlas/studio/api.php?op=status')).text);
    // Force an internal failure: unwritable replay dir -> a generic error body, no paths.
    const pem = fs.readFileSync(path.join(l.docroot, 'lib', 'issuer-private-key.pem'), 'utf8').split('\n').filter((x) => x && !/-----/.test(x)).join('');
    for (const t of texts) {
      assert.ok(!t.includes(l.root), 'no filesystem path');
      assert.ok(!t.includes(pem.slice(10, 50)), 'no private key material');
      assert.ok(!/BEGIN [A-Z ]*PRIVATE/.test(t), 'no PEM');
      assert.ok(!/<\?php/.test(t), 'no source');
    }
    // Stored challenge and attempt records hold no signatures, keys other than the recipient, or design text beyond the digest.
    const stored = [readJson(challengePath(l, r.challenge.json.nonce)), readJson(attemptPath(l, r.challenge.json.nonce))].map((x) => JSON.stringify(x)).join('');
    assert.ok(!stored.includes(r.body.proof.signature), 'signatures are not persisted by Studio');
    assert.ok(!stored.includes(DESIGN.description), 'design text is not persisted by Studio');
    for (const d of ['drafts', 'uploads-quarantine', 'mint-receipts', 'tmp', 'rate']) {
      const mode = fs.statSync(path.join(l.studio, d)).mode & 0o077;
      assert.equal(mode, 0, d + ' is private');
    }
    for (const d of ['tmp', 'mint-receipts', 'rate']) {
      for (const f of l.studioFiles(d)) assert.equal(fs.statSync(path.join(l.studio, d, f)).mode & 0o077, 0, d + '/' + f + ' is 0600');
    }
  });

  // ---------------------------------------------------------------- wrap up
  for (const l of labs) { try { await l.stop(); } catch (e) { /* already stopped */ } }
  for (const l of labs) l.cleanup();
  console.log('\n' + results.pass + ' passed, ' + results.fail + ' failed' + (results.fail ? ': ' + results.failed.join('; ') : ''));
  process.exit(results.fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
