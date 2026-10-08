// Delivery engine contract checks that need no particular route, run against
// either engine:
//
//   node test/manual-delivery-hold-recovery.js node
//   node test/manual-delivery-hold-recovery.js php
//
//   1. HOLD WINDOW  Holding a bearer original removes its registry entry
//      before the delivery reaches 'held'. A stop right after the removal,
//      for a delivery whose caller did not hand over a copy of the entry,
//      must still leave rollback able to put the entry back. (The route that
//      forwards a ticket does hand one over; the engine must not depend on
//      that.)
//   2. DELIVERED KEY  A key whose delivery completed is never delivered
//      again: starting another delivery for it is refused.
//   3. ROLLED-BACK KEY  A key whose delivery was rolled back may be tried again.
//
// The Node engine is driven directly with in-memory stand-ins for the issuer's
// stores; the PHP engine is driven through a throwaway route added to an
// isolated copy of the bundle. Not part of the permanent suite, same
// reasoning as the other manual-*.js scripts.

const fs = require('fs');
const path = require('path');
const H = require('./lib/delivery-harness');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = 8241;
const SMTP_PORT = 8991;
const BASE = 'http://localhost:' + PORT;
const ASSET_CLASS = process.env.ASSET_CLASS || 'atlas.demo.attestation.filing';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}

// ---------- Node: engine with in-memory stand-ins ----------
function nodeWorld() {
  const state = { bearers: new Map(), revoked: new Map(), suspended: new Map(), sent: [], sendMode: 'accept' };
  const storeFile = path.join(H.tmpDir('atlas-hold-'), 'deliveries.json');
  const { createDeliveryEngine } = require('../issuer-server/lib-delivery');
  const engineWith = (fault, withBearerEntry = true) => createDeliveryEngine({
    storeFile, fault, retryBackoffMs: 0,
    revoke: (id, reason) => state.revoked.set(id, { id, reason }),
    isRevoked: (id) => state.revoked.has(id),
    revocationEntryOf: (id) => state.revoked.get(id) || null,
    suspend: (id, reason) => state.suspended.set(id, { id, reason }),
    unsuspend: (id) => state.suspended.delete(id),
    findSuspension: (id) => state.suspended.get(id) || null,
    registerBearer: (id, cls) => state.bearers.set(id, { class: cls, registeredAt: 'x' }),
    takeBearer: (id) => { const e = state.bearers.get(id) || null; state.bearers.delete(id); return e; },
    restoreBearer: (id, e) => state.bearers.set(id, e),
    hasBearer: (id) => state.bearers.has(id),
    ...(withBearerEntry ? { bearerEntryOf: (id) => state.bearers.get(id) || null } : {}),
    archive: () => {},
    send: async (minted) => {
      state.sent.push(minted.id);
      if (state.sendMode === 'reject') throw new Error('SMTP command RCPT TO got 550: no such user');
    }
  });
  return { state, engineWith };
}

class Crash extends Error {}
const crashAt = (point) => (name) => { if (name === point) throw new Crash(point); };

async function runNode() {
  for (const point of ['delivery:bearer-taken', 'delivery:bearer-recorded']) {
    const { state, engineWith } = nodeWorld();
    const original = { id: 'urn:test:original-' + point };
    const minted = { id: 'urn:test:copy-' + point, asset: { class: ASSET_CLASS } };
    state.bearers.set(original.id, { class: ASSET_CLASS, registeredAt: 't0' });
    const first = engineWith(crashAt(point));
    const began = first.begin({ key: original.id, kind: 'bearer-original', class: ASSET_CLASS, original, minted, recipient: 'a@example.com' });
    let crashed = false;
    try { await first.run(began.rec.deliveryId); } catch (e) { crashed = e instanceof Crash; }
    check('hold window: engine stops at ' + point, crashed, 'did not stop');
    // A fresh engine on the same store, as after a restart; the mail server refuses.
    state.sendMode = 'reject';
    const second = engineWith(() => {});
    await second.sweep();
    const rec = second.recordOf(began.rec.deliveryId);
    check('hold window (' + point + '): delivery rolled back', rec && rec.state === 'rolled-back', JSON.stringify(rec && rec.state));
    check('hold window (' + point + '): bearer original listed again', state.bearers.has(original.id), 'registry entry lost');
    check('hold window (' + point + '): original not left suspended', !state.suspended.has(original.id), 'still suspended');
    check('hold window (' + point + '): copy revoked', state.revoked.has(minted.id), 'copy not revoked');
  }

  {
    const { state, engineWith } = nodeWorld();
    const engine = engineWith(() => {});
    const minted = { id: 'urn:test:minted-1' };
    const b1 = engine.begin({ key: 'admin-send:k1', kind: 'fresh-mint', class: ASSET_CLASS, minted, recipient: 'a@example.com' });
    await engine.run(b1.rec.deliveryId);
    check('delivered key: first delivery completes', engine.recordOf(b1.rec.deliveryId).state === 'delivered', 'not delivered');
    const b2 = engine.begin({ key: 'admin-send:k1', kind: 'fresh-mint', class: ASSET_CLASS, minted: { id: 'urn:test:minted-2' }, recipient: 'a@example.com' });
    check('delivered key: a second delivery for it is refused', !!b2.existing && b2.existing.state === 'delivered', JSON.stringify(b2.rec ? 'a new record was created' : b2));

    const engine2 = engineWith(() => {});
    state.sendMode = 'reject';
    const b3 = engine2.begin({ key: 'admin-send:k2', kind: 'fresh-mint', class: ASSET_CLASS, minted: { id: 'urn:test:minted-3' }, recipient: 'a@example.com' });
    await engine2.run(b3.rec.deliveryId);
    check('rolled-back key: first delivery rolls back', engine2.recordOf(b3.rec.deliveryId).state === 'rolled-back', 'not rolled back');
    state.sendMode = 'accept';
    const b4 = engine2.begin({ key: 'admin-send:k2', kind: 'fresh-mint', class: ASSET_CLASS, minted: { id: 'urn:test:minted-4' }, recipient: 'a@example.com' });
    check('rolled-back key: may be tried again', !!b4.rec, JSON.stringify(b4));
  }
}

// ---------- PHP: throwaway route in an isolated bundle ----------
const ENGINE_ROUTE = `<?php
require_once __DIR__ . '/../lib/bootstrap.php';
require_once __DIR__ . '/../lib/smtp.php';
require_once __DIR__ . '/../lib/email-tickets.php';
handle_preflight();
require_post();
$body = read_json_body();
switch ($body['op']) {
  case 'register': register_bearer($body['id'], $body['class']); send_json(200, ['ok' => true]);
  case 'begin': send_json(200, atlas_delivery_begin($body['spec']));
  case 'run': $r = atlas_delivery_run($body['id']); send_json(200, ['state' => $r['rec']['state'] ?? null]);
  case 'state': $r = atlas_delivery_record($body['id']); send_json(200, ['state' => $r['state'] ?? null]);
  case 'status': send_json(200, ['listed' => has_bearer($body['id']), 'revoked' => is_revoked($body['id']), 'suspended' => is_suspended($body['id'])]);
}
send_json(400, ['error' => 'unknown op']);
`;

async function runPhp() {
  let smtpMode = 'accept';
  const smtp = await H.startFakeSmtp(SMTP_PORT, () => smtpMode);
  const bundleDir = H.preparePhpBundle(SMTP_PORT);
  fs.writeFileSync(path.join(bundleDir, 'atlas', 'test-engine.php'), ENGINE_ROUTE);
  const owner = await H.genIdentity();
  H.writeAdminRoster('php', bundleDir, [owner]);
  const call = (body) => H.postJson(BASE, '/atlas/test-engine', body).then((r) => r.body);
  let issuer = await H.startPhpIssuer({ port: PORT, bundleDir });
  try {
    for (const point of ['delivery:bearer-taken', 'delivery:bearer-recorded']) {
      const original = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
      const minted = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
      await call({ op: 'register', id: original.id, class: ASSET_CLASS });
      const began = await call({ op: 'begin', spec: { key: original.id, kind: 'bearer-original', class: ASSET_CLASS, original, minted, recipient: 'a@example.com' } });
      await H.stopIssuer(issuer);
      issuer = await H.startPhpIssuer({ port: PORT, bundleDir, env: { ATLAS_TEST_CRASH_AT: point } });
      const stopped = await call({ op: 'run', id: began.rec.deliveryId }).catch(() => ({ raw: '' }));
      check('hold window: PHP engine stops at ' + point, !stopped.state, JSON.stringify(stopped));
      await H.stopIssuer(issuer);
      issuer = await H.startPhpIssuer({ port: PORT, bundleDir });
      smtpMode = 'reject';
      const after = await call({ op: 'run', id: began.rec.deliveryId });
      smtpMode = 'accept';
      const st = await call({ op: 'status', id: original.id });
      const cp = await call({ op: 'status', id: minted.id });
      check('hold window (' + point + '): delivery rolled back', after.state === 'rolled-back', JSON.stringify(after));
      check('hold window (' + point + '): bearer original listed again', st.listed === true, 'registry entry lost');
      check('hold window (' + point + '): original not left suspended', st.suspended === false, 'still suspended');
      check('hold window (' + point + '): copy revoked', cp.revoked === true, 'copy not revoked');
    }

    const m1 = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
    const b1 = await call({ op: 'begin', spec: { key: 'admin-send:k1', kind: 'fresh-mint', class: ASSET_CLASS, minted: m1, recipient: 'a@example.com' } });
    await call({ op: 'run', id: b1.rec.deliveryId });
    check('delivered key: first delivery completes', (await call({ op: 'state', id: b1.rec.deliveryId })).state === 'delivered', 'not delivered');
    const m2 = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
    const b2 = await call({ op: 'begin', spec: { key: 'admin-send:k1', kind: 'fresh-mint', class: ASSET_CLASS, minted: m2, recipient: 'a@example.com' } });
    check('delivered key: a second delivery for it is refused', !!b2.existing && b2.existing.state === 'delivered', b2.rec ? 'a new record was created' : JSON.stringify(b2));

    const m3 = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
    smtpMode = 'reject';
    const b3 = await call({ op: 'begin', spec: { key: 'admin-send:k2', kind: 'fresh-mint', class: ASSET_CLASS, minted: m3, recipient: 'a@example.com' } });
    await call({ op: 'run', id: b3.rec.deliveryId });
    check('rolled-back key: first delivery rolls back', (await call({ op: 'state', id: b3.rec.deliveryId })).state === 'rolled-back', 'not rolled back');
    smtpMode = 'accept';
    const m4 = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
    const b4 = await call({ op: 'begin', spec: { key: 'admin-send:k2', kind: 'fresh-mint', class: ASSET_CLASS, minted: m4, recipient: 'a@example.com' } });
    check('rolled-back key: may be tried again', !!b4.rec, JSON.stringify(b4));
  } finally {
    await H.stopIssuer(issuer);
    await smtp.close();
  }
}

(async () => {
  console.log('Delivery engine hold-window and key-reuse checks (' + KIND + ' engine), class ' + ASSET_CLASS);
  if (KIND === 'node') await runNode(); else await runPhp();
  if (failures) { console.error('\nFAILURE: ' + failures + ' check(s) failed'); process.exit(1); }
  console.log('\nALL HOLD-WINDOW AND KEY-REUSE CHECKS PASSED (' + KIND + ')');
})().catch((err) => { console.error('FAILURE:', err); process.exit(1); });
