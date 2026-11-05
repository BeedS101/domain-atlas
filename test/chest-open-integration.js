// Reward chests opened with a Studio key (issuer-php/atlas/asset/open-chest.php): a real PHP issuer (isolated
// copy, fresh key and state) and real ECDSA wallet signatures. Covers the key being spent exactly once with its
// reward, one opening per owner key per chest, authorization, replay, crash recovery and concurrency.
//   node test/chest-open-integration.js [name-filter]
const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { StudioLab, makeIdentity, signPayload, canonicalize, DESIGN } = require('./studio-lab');

const FILTER = process.argv[2] || '';
const results = { pass: 0, fail: 0 };
const labs = [];
const HIGH = { challengesPerIpPerHour: 10000, mintsPerIpPerHour: 10000, maxMintsPerRecipientPerDay: 1000, maxMintsPerActorPerDay: 10000, maxMintsPerDay: 100000, maxOutstandingChallenges: 5000 };
const KEY = Object.assign({}, DESIGN, { template: 'key', name: 'Gallery Key' });
const TROPHY = Object.assign({}, DESIGN, { template: 'trophy', name: 'Not A Key' });

async function test(name, fn) {
  if (FILTER && name.indexOf(FILTER) === -1) return;
  try { await fn(); results.pass++; console.log('ok   ' + name); }
  catch (e) { results.fail++; console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
}

async function newLab(opts) {
  const l = await StudioLab.start(Object.assign({ mint: true, config: HIGH }, opts || {}));
  labs.push(l);
  return l;
}
const newRid = () => crypto.randomBytes(16).toString('hex');
const revoked = (l) => JSON.parse(fs.readFileSync(path.join(l.docroot, '.well-known', 'atlas-revocations.json'), 'utf8')).revoked.map((r) => r.id);
const files = (l, d) => { try { return fs.readdirSync(path.join(l.private, d)).filter((n) => /\.json$/.test(n)); } catch (e) { return []; } };

async function mintFor(l, owner, design) {
  const m = await l.mintAs(owner, design || KEY);
  assert.equal(m.mint.status, 200, m.mint.text);
  return m.mint.json.credential;
}
function openBody(owner, key, chestId, opts) {
  opts = opts || {};
  const requestId = opts.requestId || newRid();
  const payload = Object.assign({ action: 'open-chest', chestId, credentialId: key.id, requestId, domain: key.issuer.domain }, opts.payload || {});
  const body = { credential: key, chestId, requestId, intent: { payload, proof: signPayload(opts.signer || owner, payload) } };
  if (opts.omitRequestId) delete body.requestId;
  return body;
}
const open = (l, body) => l.postRaw('/atlas/asset/open-chest', body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await test('opening a chest spends the key and signs the reward for the key owner', async () => {
    const l = await newLab();
    const owner = makeIdentity('raw-ecdsa');
    const key = await mintFor(l, owner);
    const r = await open(l, openBody(owner, key, 'gallery-gem'));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.opened, true);
    assert.equal(r.json.consumed, key.id);
    assert.equal(r.json.reward.asset.class, 'atlas.gem.ruby');
    assert.equal(r.json.reward.owner.publicKey, owner.publicKeyB64);
    assert.equal(r.json.reward.asset.fungible, false);
    assert.equal(r.json.reward.asset.tradeScope, 'local', 'the reward is giftable');
    assert.ok(revoked(l).includes(key.id), 'key is revoked');
    assert.ok(!revoked(l).includes(r.json.reward.id), 'reward is live');
    const st = await l.get('/atlas/chest/status?chestId=gallery-gem&owner=' + encodeURIComponent(owner.publicKeyB64));
    assert.equal(st.json.opened, true);
    const other = await l.get('/atlas/chest/status?chestId=gallery-pick&owner=' + encodeURIComponent(owner.publicKeyB64));
    assert.equal(other.json.opened, false);
    const caps = await l.get('/atlas/capabilities');
    assert.ok(caps.json.requestIds.operations.includes('open-chest'));
  });

  await test('a wallet opens each chest once; a second key is not spent on the same chest', async () => {
    const l = await newLab();
    const owner = makeIdentity('raw-ecdsa');
    const k1 = await mintFor(l, owner), k2 = await mintFor(l, owner);
    assert.equal((await open(l, openBody(owner, k1, 'gallery-gem'))).status, 200);
    const again = await open(l, openBody(owner, k2, 'gallery-gem'));
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.code, 'chest-already-opened');
    assert.ok(!revoked(l).includes(k2.id), 'the second key is untouched');
    const pick = await open(l, openBody(owner, k2, 'gallery-pick'));
    assert.equal(pick.status, 200, pick.text);
    assert.equal(pick.json.reward.asset.class, 'atlas.tool.pickaxe');
    assert.equal(pick.json.reward.asset.properties['atlas.avatar.handItem'], 'true');
    // another wallet can still open the gem chest
    const owner2 = makeIdentity('webauthn');
    const k3 = await mintFor(l, owner2);
    assert.equal((await open(l, openBody(owner2, k3, 'gallery-gem'))).status, 200);
  });

  await test('a repeated request id returns the stored result and signs nothing more', async () => {
    const l = await newLab();
    const owner = makeIdentity('raw-ecdsa');
    const key = await mintFor(l, owner);
    const body = openBody(owner, key, 'gallery-gem');
    const a = await open(l, body), b = await open(l, body);
    assert.equal(a.status, 200);
    assert.equal(b.text, a.text, 'byte-identical replay');
    const diff = await open(l, openBody(owner, key, 'gallery-pick', { requestId: body.requestId }));
    assert.equal(diff.status, 409, 'same id for another chest: ' + diff.text);
  });

  await test('authorization: no intent, wrong signer, altered intent and a copied key are all refused with the key intact', async () => {
    const l = await newLab();
    const owner = makeIdentity('raw-ecdsa'), thief = makeIdentity('raw-ecdsa');
    const key = await mintFor(l, owner);
    const good = openBody(owner, key, 'gallery-gem');
    const noIntent = Object.assign({}, good); delete noIntent.intent;
    assert.equal((await open(l, noIntent)).status, 403);
    const stolen = await open(l, openBody(thief, key, 'gallery-gem'));
    assert.equal(stolen.status, 403, stolen.text);
    assert.equal(stolen.json.code, 'not-owner');
    const swapped = Object.assign({}, good, { chestId: 'gallery-pick' });
    assert.equal((await open(l, swapped)).status, 403, 'intent names another chest');
    const forged = openBody(owner, key, 'gallery-gem', { payload: { credentialId: 'urn:atlas:asset:other' } });
    assert.equal((await open(l, forged)).status, 403);
    const tamperedKey = JSON.parse(JSON.stringify(key)); tamperedKey.asset.name = 'Edited';
    assert.equal((await open(l, openBody(owner, tamperedKey, 'gallery-gem'))).status, 400, 'edited credential');
    assert.equal((await open(l, openBody(owner, key, 'gallery-gem', { omitRequestId: true }))).status, 400, 'request id is required');
    assert.ok(!revoked(l).includes(key.id), 'key still live');
    assert.equal(files(l, 'chests').length, 0, 'no chest record from refused requests');
  });

  await test('only a key opens a chest; unknown chests and spent keys are refused', async () => {
    const l = await newLab();
    const owner = makeIdentity('raw-ecdsa');
    const trophy = await mintFor(l, owner, TROPHY), key = await mintFor(l, owner);
    const t = await open(l, openBody(owner, trophy, 'gallery-gem'));
    assert.equal(t.status, 400, t.text);
    assert.match(t.json.error, /not a key/);
    assert.ok(!revoked(l).includes(trophy.id));
    const u = await open(l, openBody(owner, key, 'no-such-chest'));
    assert.equal(u.status, 404, u.text);
    assert.ok(!revoked(l).includes(key.id));
    assert.equal((await open(l, openBody(owner, key, 'gallery-gem'))).status, 200);
    const spent = await open(l, openBody(owner, key, 'gallery-pick'));
    assert.equal(spent.status, 400, 'a spent key cannot open a second chest');
    assert.match(spent.json.error, /revoked/);
  });

  await test('reward classes cannot be minted through any general path', async () => {
    const l = await newLab();
    const owner = makeIdentity('raw-ecdsa');
    const r = await l.postRaw('/atlas/asset/issue', { ownerPublicKey: owner.publicKeyB64, assetClass: 'atlas.gem.ruby', quantity: 1 });
    assert.equal(r.status, 403, r.text);
    const cat = await l.get('/atlas/trade/catalog');
    const classes = (cat.json.classes || []).map((c) => c.class);
    assert.ok(!classes.includes('atlas.gem.ruby') && !classes.includes('atlas.tool.pickaxe'));
  });

  await test('a request that dies before the key is spent leaves it usable and does not lock the chest', async () => {
    const l = await newLab({ crashAt: 'chest:marked' });
    const owner = makeIdentity('raw-ecdsa');
    const key = await mintFor(l, owner), key2 = await mintFor(l, owner);
    const body = openBody(owner, key, 'gallery-gem');
    await open(l, body).catch(() => null);
    assert.ok(!revoked(l).includes(key.id), 'nothing committed');
    assert.equal((await l.get('/atlas/chest/status?chestId=gallery-gem&owner=' + encodeURIComponent(owner.publicKeyB64))).json.opened, false);
    await l.hardStop();
    const l2 = await StudioLab.start({ reuse: l }); labs.push(l2);
    assert.equal((await open(l2, body)).status, 200, 'the same request completes');
    assert.equal((await open(l2, openBody(owner, key2, 'gallery-gem'))).status, 409);
  });

  await test('a request that dies after the key is spent is completed by a retry with the same id', async () => {
    const l = await newLab();
    const owner = makeIdentity('raw-ecdsa');
    const key = await mintFor(l, owner);
    const body = openBody(owner, key, 'gallery-gem');
    await l.hardStop();
    const crashing = await StudioLab.start({ reuse: l, crashAt: 'txn:revoked' }); labs.push(crashing);
    await open(crashing, body).catch(() => null);
    assert.ok(revoked(l).includes(key.id), 'the spend committed');
    await crashing.hardStop();
    const l3 = await StudioLab.start({ reuse: l }); labs.push(l3);
    const r = await open(l3, body);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.reward.asset.class, 'atlas.gem.ruby');
    assert.equal(r.json.consumed, key.id);
    assert.equal(files(l, 'txn').length, 0, 'journal finished');
  });

  await test('two keys racing for one chest: exactly one opens it', async () => {
    const l = await newLab();
    const owner = makeIdentity('raw-ecdsa');
    const keys = [];
    for (let i = 0; i < 4; i++) keys.push(await mintFor(l, owner));
    const rs = await Promise.all(keys.map((k) => open(l, openBody(owner, k, 'gallery-gem'))));
    const ok = rs.filter((r) => r.status === 200), dup = rs.filter((r) => r.status === 409);
    assert.equal(ok.length, 1, rs.map((r) => r.status).join(','));
    assert.equal(dup.length, 3);
    assert.equal(keys.filter((k) => revoked(l).includes(k.id)).length, 1, 'only one key was spent');
  });

  for (const l of labs) { await l.stop(); l.cleanup(); }
  console.log('\n' + results.pass + ' passed, ' + results.fail + ' failed');
  process.exit(results.fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
