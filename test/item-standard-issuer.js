#!/usr/bin/env node
// Item Standard v0.1, issuer integration (docs/item-standard-v0.1.md): runs the same scenario against the Node
// and the PHP issuer and requires identical outcomes. The shipped catalogs have a single class with an itemSpec
// (the Bronze Compass), so the test injects its own classes (test/fixtures/item-standard-issuer.json) into the running code; nothing in
// the repository changes. Needs php on the PATH.
//   node test/item-standard-issuer.js
//
// Covers: signed derived properties, reserved properties from callers, randomized rolls checked before
// signing, admin mint / reissue / class-patch, restricted classes, class lookup and spec history, a spec edited
// after assets were signed, failed requests leaving supply / revocation / history untouched, and unrelated
// classes keeping their behaviour.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = crypto;
const { subtle } = webcrypto;
const { withAdminAuth } = require('./lib/admin-auth');
const { register, signSpend } = require('./lib/owner-auth');
const fixture = require('./lib/item-standard-fixture');

const ROOT = path.resolve(__dirname, '..');
const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'item-standard-v0.1.json'), 'utf8'));
const digestOf = (name) => vectors.digests.find((d) => d.spec === name).sha256;

const NODE_PORT = 8381;
const PHP_PORT = 8382;

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('PASS: ' + msg);
  else { failures += 1; console.log('FAIL: ' + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { kp, publicKey: b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))) };
}
async function signWithSelf(who, payload) {
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.kp.privateKey, new TextEncoder().encode(canonicalize(payload))));
  return { signerRole: 'raw-ecdsa', publicKey: who.publicKey, signature: b64url(sig) };
}
async function request(method, base, route, body) {
  const r = await fetch(base + route, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json };
}
const post = (base, route, body) => request('POST', base, route, body);
const get = (base, route) => request('GET', base, route);
async function adminPost(base, admin, route, payload) {
  const signed = withAdminAuth(payload, base, route);
  return post(base, route, { payload: signed, proof: await signWithSelf(admin, signed) });
}
async function checkMail(base, owner, credential) {
  const payload = { action: 'mail-check', domain: new URL(base).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: b64url(webcrypto.getRandomValues(new Uint8Array(18))) };
  return post(base, '/atlas/mail/check', { credentials: [credential], payload, proof: await signWithSelf(owner, payload) });
}

function sha(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function readIfExists(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } }
function dirFingerprint(dir) {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).sort().map((n) => n + ':' + sha(readIfExists(path.join(dir, n)))).join('|');
}

class Backend {
  constructor(name, port) {
    this.name = name;
    this.port = port;
    this.base = 'http://localhost:' + port;
    this.outcomes = [];
  }
  record(label, res) {
    const j = res.json || {};
    const errs = Array.isArray(j.errors) ? j.errors.map((e) => e.code + '@' + e.key).sort() : [];
    this.outcomes.push({ label, status: res.status, code: j.code || null, errs });
  }
  serialCounters() {
    const file = this.name === 'node' ? path.join(this.state, 'atlas-serial-counters.json') : path.join(this.bundle, 'lib', 'atlas-serial-counters-store.json');
    try { return JSON.parse(readIfExists(file) || '{}').counters || {}; } catch (e) { return {}; }
  }
  specsFile() {
    return this.name === 'node' ? path.join(this.state, 'atlas-item-specs-store.json') : path.join(this.bundle, 'lib', 'atlas-item-specs-store.json');
  }
  holdingsDir() {
    return this.name === 'node' ? path.join(this.state, 'holdings') : path.join(this.bundle, 'lib', 'holdings');
  }
  patchesFile() {
    return this.name === 'node' ? path.join(this.state, 'atlas-class-patches-store.json') : path.join(this.bundle, 'lib', 'atlas-class-patches-store.json');
  }
  async revocations() {
    const r = await get(this.base, '/.well-known/atlas-revocations.json');
    return JSON.stringify(r.json);
  }
  // What a failed request must not change.
  async fingerprint() {
    return JSON.stringify({
      serial: this.serialCounters(), revocations: await this.revocations(), holdings: dirFingerprint(this.holdingsDir()),
      patches: sha(readIfExists(this.patchesFile()))
    });
  }
}

async function startNode(b, variant) {
  b.proc = spawn('node', ['-r', path.join(__dirname, 'lib', 'item-standard-inject.js'), 'issuer-server/server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ATLAS_PRIVATE_MINT: 'off', PORT: String(b.port), ATLAS_DOMAIN: 'localhost:' + b.port, ATLAS_STATE_DIR: b.state, ATLAS_DOCROOT: b.docroot, ITEMSTD_VARIANT: String(variant) }
  });
  let log = '';
  b.proc.stderr.on('data', (d) => { log += d; });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('node did not start: ' + log)), 15000);
    b.proc.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); res(); } });
    b.proc.on('exit', (code) => rej(new Error('node exited early (' + code + '): ' + log)));
  });
}
function writePhpClasses(b, variant) {
  fs.writeFileSync(path.join(b.bundle, 'lib', 'item-standard-test-classes.php'), fixture.phpFile(variant));
}
async function startPhp(b, variant) {
  b.bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'itemstd-php-'));
  fs.cpSync(path.join(ROOT, 'issuer-php'), b.bundle, { recursive: true });
  const store = path.join(b.bundle, 'lib', 'store.php');
  const text = fs.readFileSync(store, 'utf8');
  const anchor = "define('ATLAS_ASSET_CATALOG', array_merge(ATLAS_ASSET_CATALOG_BASE, atlas_elements_catalog()));";
  if (!text.includes(anchor)) throw new Error('store.php no longer has the catalog line the item standard test injects at');
  fs.writeFileSync(store, text.replace(anchor, "define('ATLAS_ASSET_CATALOG', array_merge(ATLAS_ASSET_CATALOG_BASE, atlas_elements_catalog(), require __DIR__ . '/item-standard-test-classes.php'));"));
  writePhpClasses(b, variant);
  b.proc = spawn('php', ['-d', 'opcache.enable=0', '-S', 'localhost:' + b.port, 'test-router.php'], { cwd: b.bundle, env: { ...process.env, ATLAS_PRIVATE_MINT: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('php did not start')), 8000);
    b.proc.stderr.on('data', (d) => { if (String(d).includes('started')) { clearTimeout(t); res(); } });
  });
}

const C = {
  ring: 'atlas.wearable.ring.itemstd_luck', flaky: 'atlas.wearable.ring.itemstd_flaky', compass: 'atlas.tool.itemstd_compass',
  pickaxe: 'atlas.tool.itemstd_pickaxe', restricted: 'atlas.tool.itemstd_restricted', numbered: 'atlas.tool.itemstd_numbered', dynamite: 'atlas.consumable.itemstd_dynamite',
  fuse: 'atlas.consumable.itemstd_fuse', hat: 'atlas.avatar.hat.sunhat', trophy: 'atlas.trophy.chess'
};

async function phaseOne(b, ctx) {
  const { admin, owner } = ctx;
  const say = (m) => console.log('  [' + b.name + '] ' + m);
  const issue = (cls) => post(b.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: cls });
  const mint = (cls, properties) => adminPost(b.base, admin, '/atlas/asset/mint', { ownerPublicKey: owner.publicKey, assetClass: cls, ...(properties ? { properties } : {}) });
  const reissue = (credential, properties, extra) => adminPost(b.base, admin, '/atlas/asset/reissue', { credential, ...(properties ? { properties } : {}), ...(extra || {}) });
  const patch = (cls, properties) => adminPost(b.base, admin, '/atlas/admin/class-patch', { assetClass: cls, properties });
  const props = (res) => (res.json && res.json.asset && res.json.asset.properties) || {};
  const R = (label, res) => { b.record(label, res); return res; };

  console.log('STEP: [' + b.name + '] unrelated classes keep their behaviour');
  const hat = R('issue legacy hat', await issue(C.hat));
  check(hat.status === 200 && !Object.keys(props(hat)).some((k) => k.startsWith('atlas.item.')), b.name + ': legacy hat issues with no standard properties');
  check(typeof props(hat)['atlas.avatar.hatSpeedMultiplier'] === 'number', b.name + ': legacy hat keeps its numeric multiplier');
  const trophy = R('issue legacy trophy', await issue(C.trophy));
  const legacyReissue = R('reissue legacy with a plain property', await reissue(trophy.json, { 'com.example.note': 'ok', 'atlas.avatar.speedMultiplier': 1.5 }));
  check(legacyReissue.status === 200, b.name + ': legacy reissue with ordinary and numeric properties still works');
  const legacyMarker = R('reissue legacy with the marker', await reissue(legacyReissue.json.newCredential, { 'atlas.item.standard': '0.1' }));
  check(legacyMarker.status === 400 && legacyMarker.json.code === 'item-patch-reserved-key', b.name + ': an unrelated class cannot be given the standard marker');
  const legacyCap = R('class-patch legacy with a capability key', await patch(C.trophy, { 'atlas.cap.mine.tier': '2' }));
  check(legacyCap.status === 400 && legacyCap.json.code === 'item-patch-reserved-key', b.name + ': a class patch on an unrelated class cannot use the capability namespace');
  const legacyMint = R('mint legacy with the marker', await mint(C.trophy, { 'atlas.item.standard': '0.1' }));
  check(legacyMint.status === 400 && legacyMint.json.code === 'item-patch-reserved-key', b.name + ': admin mint on an unrelated class cannot use the standard marker');
  const lookupLegacy = R('class lookup legacy', await get(b.base, '/atlas/asset/class?class=' + C.hat));
  check(lookupLegacy.status === 200 && lookupLegacy.json.itemSpec === undefined, b.name + ': class lookup for an unrelated class has no itemSpec');

  console.log('STEP: [' + b.name + '] standard classes: derived properties are signed');
  const compass = R('issue compass', await issue(C.compass));
  const cp = props(compass);
  check(compass.status === 200 && cp['atlas.item.standard'] === '0.1' && cp['atlas.item.category'] === 'tool' && cp['atlas.avatar.slot'] === 'trinket', b.name + ': compass carries marker, category and slot');
  check(JSON.stringify(cp['atlas.item.capabilities']) === '["atlas.cap.compass"]', b.name + ': compass carries its authorized capability');
  check(cp['atlas.item.specDigest'] === digestOf('compass'), b.name + ': compass digest equals the Phase 1 vector digest');
  const pick = R('issue pickaxe', await issue(C.pickaxe));
  check(pick.status === 200 && props(pick)['atlas.cap.mine.tier'] === '1' && props(pick)['atlas.item.specDigest'] === digestOf('pickaxe'), b.name + ': pickaxe carries its tier and the Phase 1 digest');
  const dyn = R('issue dynamite', await issue(C.dynamite));
  check(dyn.status === 200 && props(dyn)['atlas.item.uses'] === '1' && props(dyn)['atlas.item.category'] === 'consumable', b.name + ': dynamite carries its use count');
  let ringsOk = true;
  for (let i = 0; i < 8; i++) {
    const ring = await issue(C.ring);
    const luck = Number(props(ring)['atlas.avatar.stat.luck']);
    if (ring.status !== 200 || !(luck >= 1 && luck <= 3) || props(ring)['atlas.item.specDigest'] !== digestOf('ring')) ringsOk = false;
  }
  check(ringsOk, b.name + ': eight rolled rings all sit inside the spec range with the ring digest');

  console.log('STEP: [' + b.name + '] caller-supplied reserved properties');
  const reservedCases = [
    ['capability list', { 'atlas.item.capabilities': ['atlas.cap.mine', 'atlas.cap.dig'] }],
    ['digest', { 'atlas.item.specDigest': 'x' }],
    ['marker', { 'atlas.item.standard': '9.9' }],
    ['slot', { 'atlas.avatar.slot': 'ring' }],
    ['uses', { 'atlas.item.uses': '50' }]
  ];
  for (const [label, p] of reservedCases) {
    const res = R('mint pickaxe with ' + label, await mint(C.pickaxe, p));
    check(res.status === 400 && res.json.code === 'item-patch-reserved-key', b.name + ': admin mint refuses a supplied ' + label);
  }
  const tierOk = R('mint pickaxe tier 2', await mint(C.pickaxe, { 'atlas.cap.mine.tier': '2' }));
  check(tierOk.status === 200 && props(tierOk)['atlas.cap.mine.tier'] === '2', b.name + ': admin mint may set a capability parameter inside the spec');
  const tierHigh = R('mint pickaxe tier 3', await mint(C.pickaxe, { 'atlas.cap.mine.tier': '3' }));
  check(tierHigh.status === 400 && tierHigh.json.code === 'item-properties-invalid' && tierHigh.json.errors.some((e) => e.code === 'item-capability-param-invalid'), b.name + ': a tier above the spec is refused');
  const unauthorized = R('mint pickaxe with dig tier', await mint(C.pickaxe, { 'atlas.cap.dig.tier': '1' }));
  check(unauthorized.status === 400 && unauthorized.json.code === 'item-properties-invalid', b.name + ': a capability parameter the spec does not authorize is refused');
  const compassTier = R('mint compass with mine tier', await mint(C.compass, { 'atlas.cap.mine.tier': '1' }));
  check(compassTier.status === 400, b.name + ': a compass cannot be given a mining tier');
  const ringHigh = R('mint ring luck 4', await mint(C.ring, { 'atlas.avatar.stat.luck': '4' }));
  check(ringHigh.status === 400 && ringHigh.json.errors.some((e) => e.code === 'item-stat-out-of-range'), b.name + ': a stat above the spec range is refused');
  const ringFraction = R('mint ring luck 2.5', await mint(C.ring, { 'atlas.avatar.stat.luck': 2.5 }));
  check(ringFraction.status === 400, b.name + ': a fractional stat is refused');
  const ringOk = R('mint ring luck 3', await mint(C.ring, { 'atlas.avatar.stat.luck': '3' }));
  check(ringOk.status === 200, b.name + ': a stat at the top of the range is accepted');
  const ringNumeric = R('mint ring luck numeric 2', await mint(C.ring, { 'atlas.avatar.stat.luck': 2 }));
  check(ringNumeric.status === 200, b.name + ': a numeric stat inside the range is accepted (existing numeric properties stay valid)');

  console.log('STEP: [' + b.name + '] randomized properties are checked before signing, supply untouched');
  const before = b.serialCounters()[C.flaky];
  const f1 = R('flaky roll 1', await issue(C.flaky));
  check(f1.status === 400 && f1.json.code === 'item-properties-invalid', b.name + ': a roll outside the spec is refused');
  check(b.serialCounters()[C.flaky] === before, b.name + ': the refused roll reserved no serial');
  const f2 = R('flaky roll 2', await issue(C.flaky));
  check(f2.status === 200 && props(f2)['atlas.serial'] === '1', b.name + ': the next valid roll gets serial 1');
  const f3 = R('flaky roll 3', await issue(C.flaky));
  const f4 = R('flaky roll 4', await issue(C.flaky));
  check(f3.status === 400 && f4.status === 200 && props(f4)['atlas.serial'] === '2', b.name + ': serials stay consecutive across refused rolls');
  const f5 = await issue(C.flaky);
  const f6 = await issue(C.flaky);
  const f7 = await issue(C.flaky);
  const f8 = R('flaky sold out', await issue(C.flaky));
  check(f5.status === 400 && f6.status === 200 && props(f6)['atlas.serial'] === '3' && f7.status === 400 && f8.status === 400 && /sold out/.test(f8.json.error), b.name + ': the supply cap is reached exactly by valid mints');
  check(b.serialCounters()[C.flaky] === 3, b.name + ': counter stands at the cap');

  const n1 = R('issue numbered 1', await issue(C.numbered));
  check(n1.status === 200 && props(n1)['atlas.serial'] === '1' && props(n1)['atlas.item.specDigest'] === digestOf('compass'), b.name + ': a serialized standard class gets its serial and derived properties');

  console.log('STEP: [' + b.name + '] restricted-issuance classes stay restricted');
  const restrictedBefore = await b.fingerprint();
  const r1 = R('issue restricted', await issue(C.restricted));
  const r2 = R('mint restricted', await mint(C.restricted));
  const r3 = R('class-patch restricted', await patch(C.restricted, { 'com.example.x': '1' }));
  check(r1.status === 403 && r2.status === 403 && r3.status === 403, b.name + ': issue, admin mint and class-patch all refuse a restricted standard class');
  check(await b.fingerprint() === restrictedBefore, b.name + ': the refusals changed no supply, revocation, holdings or patch state');
  const studio = R('mint studio', await mint('atlas.demo.studio.collectible'));
  check(studio.status === 403 && studio.json.code === 'studio-authorization-required', b.name + ': the Studio collectible is still refused by admin mint');
  check(!/itemstd_restricted/.test(readIfExists(b.specsFile())), b.name + ': no spec history was recorded for the restricted class');

  console.log('STEP: [' + b.name + '] reissue and class-patch of standard assets');
  const pickA = R('issue pickaxe A', await issue(C.pickaxe));
  const failBefore = await b.fingerprint();
  const badReissue = R('reissue pickaxe tier 3', await reissue(pickA.json, { 'atlas.cap.mine.tier': '3' }));
  check(badReissue.status === 400 && badReissue.json.code === 'item-properties-invalid', b.name + ': reissue above the spec is refused');
  const digestReissue = R('reissue pickaxe digest', await reissue(pickA.json, { 'atlas.item.specDigest': digestOf('compass') }));
  const markerDelete = R('reissue pickaxe marker delete', await reissue(pickA.json, { 'atlas.item.standard': null }));
  const capsReissue = R('reissue pickaxe caps', await reissue(pickA.json, { 'atlas.item.capabilities': ['atlas.cap.mine', 'atlas.cap.dig'] }));
  check(digestReissue.status === 400 && markerDelete.status === 400 && capsReissue.status === 400 && [digestReissue, markerDelete, capsReissue].every((x) => x.json.code === 'item-patch-reserved-key'), b.name + ': reissue cannot change, remove or add derived properties');
  check(await b.fingerprint() === failBefore, b.name + ': refused reissues changed no supply, revocation, holdings or patch state');
  const goodReissue = R('reissue pickaxe tier 2', await reissue(pickA.json, { 'atlas.cap.mine.tier': '2' }));
  check(goodReissue.status === 200 && props({ json: goodReissue.json.newCredential })['atlas.cap.mine.tier'] === '2', b.name + ': the original was still reissuable after the refusals, and tier 2 is accepted');
  const pickB = goodReissue.json.newCredential;
  check(pickB.asset.properties['atlas.item.specDigest'] === digestOf('pickaxe'), b.name + ': reissue keeps the signed digest');
  const scopeOnly = R('reissue tradeScope only', await reissue(pickB, null, { tradeScope: 'bound' }));
  check(scopeOnly.status === 200, b.name + ': a tradeScope-only reissue of a standard asset still works');
  const pickC = scopeOnly.json.newCredential;

  const patchHigh = R('class-patch tier 3', await patch(C.pickaxe, { 'atlas.cap.mine.tier': '3' }));
  const patchDigest = R('class-patch digest', await patch(C.pickaxe, { 'atlas.item.specDigest': 'x' }));
  const patchSlot = R('class-patch slot', await patch(C.pickaxe, { 'atlas.avatar.slot': 'ring' }));
  check(patchHigh.status === 400 && patchDigest.status === 400 && patchSlot.status === 400, b.name + ': class patches outside the spec or on derived keys are refused');
  const patchBefore = await b.fingerprint();
  check(!readIfExists(b.patchesFile()).includes(C.pickaxe), b.name + ': refused class patches stored nothing');
  const patchOk = R('class-patch tier 2', await patch(C.pickaxe, { 'atlas.cap.mine.tier': '2' }));
  check(patchOk.status === 200, b.name + ': a class patch inside the spec is stored');
  const pickOld = pick.json; // tier 1, same class
  const applied = R('mail check applies patch', await checkMail(b.base, owner, pickOld));
  check(applied.status === 200 && applied.json.updates.length === 1 && applied.json.updates[0].newCredential.asset.properties['atlas.cap.mine.tier'] === '2' && applied.json.updates[0].newCredential.asset.properties['atlas.item.specDigest'] === digestOf('pickaxe'), b.name + ': the class patch reaches a holder and keeps the signed spec digest');
  ctx.pickaxeForVariant2 = pickC;
  ctx.patchBefore = patchBefore;

  console.log('STEP: [' + b.name + '] class lookup exposes the spec and its digest');
  const look = R('lookup compass', await get(b.base, '/atlas/asset/class?class=' + C.compass));
  check(look.status === 200 && JSON.stringify(look.json.itemSpec) === JSON.stringify(vectors.specs.compass) && look.json.itemSpecDigest === digestOf('compass') && look.json.itemStandard === '0.1', b.name + ': class lookup returns the compass spec and its Phase 1 digest');
  const lookDigest = R('lookup compass by digest', await get(b.base, '/atlas/asset/class?class=' + C.compass + '&specDigest=' + digestOf('compass')));
  check(lookDigest.status === 200 && lookDigest.json.current === true && lookDigest.json.itemSpecDigest === digestOf('compass'), b.name + ': the current spec is returned by its digest');
  const lookUnknown = R('lookup unknown digest', await get(b.base, '/atlas/asset/class?class=' + C.compass + '&specDigest=' + '0'.repeat(64)));
  check(lookUnknown.status === 404 && lookUnknown.json.code === 'item-spec-unknown', b.name + ': an unknown digest is a 404');
  const lookBad = R('lookup bad digest', await get(b.base, '/atlas/asset/class?class=' + C.compass + '&specDigest=nope'));
  check(lookBad.status === 400 && lookBad.json.code === 'item-spec-digest-invalid', b.name + ': a malformed digest is a 400');
  const lookOther = R('lookup digest of another class', await get(b.base, '/atlas/asset/class?class=' + C.ring + '&specDigest=' + digestOf('compass')));
  check(lookOther.status === 404, b.name + ': a digest belonging to another class is not served for this one');

  console.log('STEP: [' + b.name + '] fungible standard class');
  const fuse = R('issue fuse', await post(b.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: C.fuse, quantity: 4 }));
  check(fuse.status === 200 && props(fuse)['atlas.item.specDigest'] && fuse.json.quantity === 4, b.name + ': a fungible standard class issues with derived properties');
  ctx.fuseBalance = fuse.json;
  ctx.fuseDigest1 = props(fuse)['atlas.item.specDigest'];
  ctx.pickDigest1 = digestOf('pickaxe');
  say('phase one done');
}

async function phaseTwo(b, ctx) {
  const { admin, owner } = ctx;
  const R = (label, res) => { b.record(label, res); return res; };
  const props = (res) => (res.json && res.json.asset && res.json.asset.properties) || {};
  const reissue = (credential, properties) => adminPost(b.base, admin, '/atlas/asset/reissue', { credential, properties });

  console.log('STEP: [' + b.name + '] a spec edited after assets were signed');
  const look = R('v2 lookup pickaxe', await get(b.base, '/atlas/asset/class?class=' + C.pickaxe));
  check(look.status === 200 && look.json.itemSpecDigest !== ctx.pickDigest1, b.name + ': the class now declares a different spec');
  const old = R('v2 lookup old pickaxe digest', await get(b.base, '/atlas/asset/class?class=' + C.pickaxe + '&specDigest=' + ctx.pickDigest1));
  check(old.status === 200 && old.json.current === false && JSON.stringify(old.json.itemSpec) === JSON.stringify(vectors.specs.pickaxe), b.name + ': the earlier spec is still retrievable by its digest');

  const up = R('v2 reissue old pickaxe tier 3', await reissue(ctx.pickaxeForVariant2, { 'atlas.cap.mine.tier': '3' }));
  check(up.status === 400 && up.json.code === 'item-properties-invalid', b.name + ': an asset signed under the old spec cannot be raised to what only the new spec allows');
  const same = R('v2 reissue old pickaxe tier 2', await reissue(ctx.pickaxeForVariant2, { 'atlas.cap.mine.tier': '2' }));
  check(same.status === 200 && same.json.newCredential.asset.properties['atlas.item.specDigest'] === ctx.pickDigest1, b.name + ': changes inside the old spec still work and keep the old digest');
  const fresh = R('v2 issue pickaxe', await post(b.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: C.pickaxe }));
  check(fresh.status === 200 && props(fresh)['atlas.item.specDigest'] === look.json.itemSpecDigest, b.name + ': new items carry the new digest');
  const freshHigh = R('v2 mint pickaxe tier 3', await adminPost(b.base, admin, '/atlas/asset/mint', { ownerPublicKey: owner.publicKey, assetClass: C.pickaxe, properties: { 'atlas.cap.mine.tier': '3' } }));
  check(freshHigh.status === 200, b.name + ': the new spec allows tier 3 on new items');
  const freshReissue = R('v2 reissue new pickaxe tier 3', await reissue(freshHigh.json, { 'atlas.cap.mine.tier': '3' }));
  check(freshReissue.status === 200, b.name + ': an asset signed under the new spec is checked against the new spec');

  const patchHigh = R('v2 class-patch tier 3', await adminPost(b.base, admin, '/atlas/admin/class-patch', { assetClass: C.pickaxe, properties: { 'atlas.cap.mine.tier': '3' } }));
  check(patchHigh.status === 200, b.name + ': the class patch is validated against the current spec');
  const oldHolder = R('v2 mail check old pickaxe', await checkMail(b.base, owner, same.json.newCredential));
  check(oldHolder.status === 200 && oldHolder.json.updates.length === 0, b.name + ': a patch the old spec does not allow is not applied to an asset signed under it');
  const freshHolder = R('v2 mail check new pickaxe', await checkMail(b.base, owner, fresh.json));
  check(freshHolder.status === 200 && freshHolder.json.updates.length === 1 && freshHolder.json.updates[0].newCredential.asset.properties['atlas.cap.mine.tier'] === '3', b.name + ': the same patch is applied to an asset signed under the new spec');

  const split = R('v2 split old fuse balance', await post(b.base, '/atlas/asset/split', signSpend('/atlas/asset/split', { credential: ctx.fuseBalance, sendAmount: 1, toPublicKey: (await genIdentity()).publicKey })));
  check(split.status === 400 && /earlier item spec/.test(split.json.error || ''), b.name + ': an old fungible balance cannot be re-minted under the new spec');
  const fuse2 = await post(b.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: C.fuse, quantity: 2 });
  check(fuse2.status === 200 && fuse2.json.asset.properties['atlas.item.specDigest'] !== ctx.fuseDigest1, b.name + ': a new fungible issue carries the new digest');

  console.log('STEP: [' + b.name + '] spec history is relied on and protected');
  const history = readIfExists(b.specsFile());
  const parsed = JSON.parse(history);
  delete parsed.specs[C.pickaxe][ctx.pickDigest1];
  fs.writeFileSync(b.specsFile(), JSON.stringify(parsed));
  const noHistory = R('v2 reissue without history', await reissue(same.json.newCredential, { 'atlas.cap.mine.tier': '2' }));
  check(noHistory.status === 409 && noHistory.json.code === 'item-spec-unavailable', b.name + ': an asset whose signed spec is no longer on record cannot be changed');
  const gone = R('v2 lookup removed digest', await get(b.base, '/atlas/asset/class?class=' + C.pickaxe + '&specDigest=' + ctx.pickDigest1));
  check(gone.status === 404, b.name + ': and the lookup reports it unknown');
  fs.writeFileSync(b.specsFile(), '{ not json');
  const flakyBefore = b.serialCounters();
  const corrupt = R('v2 issue with corrupt history', await post(b.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: C.pickaxe }));
  check(corrupt.status === 503, b.name + ': an unreadable spec history stops standard issuance');
  check(fs.readFileSync(b.specsFile(), 'utf8') === '{ not json', b.name + ': the unreadable history was left as found');
  const numberedBefore = b.serialCounters()[C.numbered];
  const corruptNumbered = R('v2 issue numbered with corrupt history', await post(b.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: C.numbered }));
  check(corruptNumbered.status === 503 && b.serialCounters()[C.numbered] === numberedBefore, b.name + ': a serialized mint that fails after reserving its serial gives the serial back');
  const legacyStill = await post(b.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: C.hat });
  check(legacyStill.status === 200, b.name + ': unrelated classes are unaffected by the spec history');
  fs.writeFileSync(b.specsFile(), history);
  check(JSON.stringify(b.serialCounters()) === JSON.stringify(flakyBefore), b.name + ': the refused issues touched no counters');
  const numberedNext = R('v2 issue numbered after restore', await post(b.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: C.numbered }));
  check(numberedNext.status === 200 && props(numberedNext)['atlas.serial'] === '2', b.name + ': the next serial is the one that was given back');
}

async function main() {
  const admin = await genIdentity();
  const owner = register(await genIdentity());
  const node = new Backend('node', NODE_PORT);
  const php = new Backend('php', PHP_PORT);
  node.state = fs.mkdtempSync(path.join(os.tmpdir(), 'itemstd-node-'));
  node.docroot = fs.mkdtempSync(path.join(os.tmpdir(), 'itemstd-docroot-'));
  const roster = JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] });
  fs.writeFileSync(path.join(node.state, 'atlas-admin-keys-store.json'), roster);
  const procs = [];
  try {
    await startNode(node, 1);
    await startPhp(php, 1);
    procs.push(node.proc, php.proc);
    fs.writeFileSync(path.join(php.bundle, 'lib', 'atlas-admin-keys-store.json'), roster);
    const ctx = { admin, owner };
    const ctxs = { node: { ...ctx }, php: { ...ctx } };
    console.log('SETUP: node on ' + NODE_PORT + ', php on ' + PHP_PORT + '; fixture classes: ' + Object.keys(fixture.FIXTURE.classes).length);
    for (const b of [node, php]) await phaseOne(b, ctxs[b.name]);

    console.log('SETUP: restarting both with edited specs');
    node.proc.kill();
    await sleep(500);
    await startNode(node, 2);
    procs[0] = node.proc;
    writePhpClasses(php, 2);
    for (const b of [node, php]) await phaseTwo(b, ctxs[b.name]);

    console.log('STEP: Node and PHP agree on every outcome');
    check(node.outcomes.length === php.outcomes.length, 'both ran the same ' + node.outcomes.length + ' recorded requests');
    let diffs = 0;
    node.outcomes.forEach((o, i) => {
      const p = php.outcomes[i];
      if (JSON.stringify(o) !== JSON.stringify(p)) { diffs += 1; console.log('  DIFF: ' + JSON.stringify(o) + ' vs ' + JSON.stringify(p)); }
    });
    check(diffs === 0, 'status, error code and error list match for every recorded request');
  } finally {
    for (const p of procs) { try { p.kill(); } catch (e) { /* already gone */ } }
    for (const d of [node.state, node.docroot, php.bundle]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
  }
  console.log(failures ? '\nITEM STANDARD ISSUER CHECKS FAILED (' + failures + ')' : '\nITEM STANDARD ISSUER CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
