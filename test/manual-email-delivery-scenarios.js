// Delivery scenarios for handing a credential to a recipient by email, run
// against either issuer and with any unique, giftable asset class:
//
//   node test/manual-email-delivery-scenarios.js node
//   node test/manual-email-delivery-scenarios.js php
//   ASSET_CLASS=atlas.demo.email.ticket node test/manual-email-delivery-scenarios.js node
//
// The mail server is scripted per attempt, so each scenario exercises one
// way delivery can be uncertain. Whatever happens, the invariants are the
// ones the crash matrix checks: the sender's original and a delivered copy
// are never both usable, at most one distinct credential is claimable, and a
// failed delivery leaves the sender exactly as before.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const H = require('./lib/delivery-harness');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = KIND === 'php' ? 8234 : 8233;
const SMTP_PORT = 8982;
const BASE = 'http://localhost:' + PORT;
const ASSET_CLASS = process.env.ASSET_CLASS || 'atlas.demo.attestation.filing';
const GOOD = 'friend@example.com';

let current = null; // { issuer, smtp, owner, location }

async function setup(script, extraEnv) {
  const smtp = await H.startFakeSmtp(SMTP_PORT, script);
  const owner = await H.genIdentity();
  const location = {};
  const env = { ATLAS_DELIVERY_MAX_ATTEMPTS: '3', ATLAS_DELIVERY_RETRY_BACKOFF_MS: '0', ...(extraEnv || {}) };
  let issuer;
  if (KIND === 'node') {
    location.stateDir = H.tmpDir('atlas-scn-state-');
    location.docrootDir = H.tmpDir('atlas-scn-docroot-');
    H.writeAdminRoster('node', location.stateDir, [owner]);
    issuer = await H.startNodeIssuer({ port: PORT, stateDir: location.stateDir, docrootDir: location.docrootDir, env: { ...H.smtpEnvFor(SMTP_PORT), ...env } });
  } else {
    location.bundleDir = H.preparePhpBundle(SMTP_PORT);
    H.writeAdminRoster('php', location.bundleDir, [owner]);
    issuer = await H.startPhpIssuer({ port: PORT, bundleDir: location.bundleDir, env: { PHP_CLI_SERVER_WORKERS: '6', ...env } });
  }
  current = { issuer, smtp, owner, location };
  return current;
}
async function teardown() {
  if (!current) return;
  await H.stopIssuer(current.issuer);
  await current.smtp.close();
  current = null;
}

async function statusOf(id) {
  const st = await H.mailCheckStatus(BASE, id);
  return st ? st.status + (st.reason ? '/' + st.reason : '') : 'valid';
}
function distinctIds(smtp) {
  return new Set(smtp.messages.map((m) => H.attachmentOf(m)).filter(Boolean).map((c) => c.id));
}
async function claimableIds(smtp) {
  const out = [];
  for (const id of distinctIds(smtp)) {
    const st = await H.fileStatus(BASE, id);
    if (st && st.claimable) out.push(id);
  }
  return out;
}

const scenarios = [];
function scenario(name, fn) { scenarios.push({ name, fn }); }

scenario('a delivery the mail server accepts: original revoked, exactly one claimable copy', async () => {
  const { owner, smtp } = await setup(() => 'accept');
  const original = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
  const res = await H.transferToEmail(BASE, original, owner, GOOD);
  H.assert(res.status === 200 && res.body.status === 'email-transferred', 'expected 200 email-transferred, got ' + JSON.stringify(res));
  H.assert((await statusOf(original.id)) === 'revoked/email-transferred', 'original should be revoked as email-transferred, got ' + await statusOf(original.id));
  H.assert(smtp.messages.length === 1, 'expected one message, got ' + smtp.messages.length);
  const claimable = await claimableIds(smtp);
  H.assert(claimable.length === 1, 'expected one claimable credential, got ' + claimable.length);
  const delivered = H.attachmentOf(smtp.messages[0]);
  H.assert(delivered.asset.class === ASSET_CLASS && delivered.supersedes === original.id, 'delivered credential should carry the same asset and supersede the original');
});

scenario('a recipient the server rejects: sender untouched, nothing claimable, a later send works', async () => {
  const { owner, smtp } = await setup((a) => (a.rcpt.includes('bad@') ? 'reject' : 'accept'));
  const original = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
  const res = await H.transferToEmail(BASE, original, owner, 'bad@example.com');
  H.assert(res.status === 502, 'expected 502, got ' + JSON.stringify(res));
  H.assert((await statusOf(original.id)) === 'valid', 'original should be valid again (no lingering hold), got ' + await statusOf(original.id));
  H.assert(smtp.messages.length === 0, 'no message should have been delivered');
  const ok = await H.transferToEmail(BASE, original, owner, GOOD);
  H.assert(ok.status === 200, 'the same asset should still be sendable to a good address, got ' + JSON.stringify(ok));
  H.assert((await claimableIds(smtp)).length === 1, 'exactly one claimable credential after the good send');
});

scenario('an uncertain delivery (message taken, connection dropped): retried, same credential, one claimable copy', async () => {
  const { owner, smtp } = await setup((a) => (a.n === 1 ? 'drop-after-data' : 'accept'));
  const original = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
  const res = await H.transferToEmail(BASE, original, owner, GOOD);
  H.assert(res.status === 200, 'expected the retry to complete the delivery, got ' + JSON.stringify(res));
  H.assert(smtp.messages.length === 2, 'expected the message to be sent twice, got ' + smtp.messages.length);
  H.assert(distinctIds(smtp).size === 1, 'both messages must carry the identical credential, got ' + distinctIds(smtp).size + ' distinct');
  H.assert((await claimableIds(smtp)).length === 1, 'exactly one claimable credential');
  H.assert((await statusOf(original.id)) === 'revoked/email-transferred', 'original should be revoked');
});

scenario('delivery never confirmed (every attempt dropped): rolled back, any copy that arrived is dead', async () => {
  const { owner, smtp } = await setup(() => 'drop-after-data');
  const original = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
  const res = await H.transferToEmail(BASE, original, owner, GOOD);
  H.assert(res.status === 502, 'expected 502 after the attempts ran out, got ' + JSON.stringify(res));
  H.assert((await statusOf(original.id)) === 'valid', 'sender must keep a usable original, got ' + await statusOf(original.id));
  H.assert((await claimableIds(smtp)).length === 0, 'a copy that may have arrived must not be claimable');
  for (const id of distinctIds(smtp)) {
    H.assert((await statusOf(id)) === 'revoked/issuer-request', 'an unconfirmed copy must be revoked, got ' + await statusOf(id));
  }
});

scenario('a temporary failure that clears: delivered after retries, no duplicate credential', async () => {
  const { owner, smtp } = await setup((a) => (a.n <= 2 ? 'tempfail' : 'accept'));
  const original = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
  const res = await H.transferToEmail(BASE, original, owner, GOOD);
  H.assert(res.status === 200, 'expected delivery on the third attempt, got ' + JSON.stringify(res));
  H.assert(smtp.messages.length === 1 && (await claimableIds(smtp)).length === 1, 'one message, one claimable credential');
});

scenario('a temporary failure that does not clear: rolled back, sender untouched', async () => {
  const { owner, smtp } = await setup(() => 'tempfail');
  const original = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
  const res = await H.transferToEmail(BASE, original, owner, GOOD);
  H.assert(res.status === 502, 'expected 502, got ' + JSON.stringify(res));
  H.assert((await statusOf(original.id)) === 'valid' && smtp.messages.length === 0, 'sender untouched, nothing delivered');
});

scenario('the same request twice: the second gets the first answer and sends nothing; another address is refused', async () => {
  const { owner, smtp } = await setup(() => 'accept');
  const original = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
  const first = await H.transferToEmail(BASE, original, owner, GOOD);
  const again = await H.transferToEmail(BASE, original, owner, GOOD);
  H.assert(first.status === 200 && again.status === 200 && JSON.stringify(first.body) === JSON.stringify(again.body), 'replay should repeat the first answer, got ' + JSON.stringify(again));
  H.assert(smtp.messages.length === 1, 'replay must not send again');
  const other = await H.transferToEmail(BASE, original, owner, 'someone-else@example.com');
  H.assert(other.status === 409, 'a different address must be refused, got ' + JSON.stringify(other));
  H.assert(smtp.messages.length === 1, 'still one message');
});

scenario('two simultaneous identical requests: one delivery, one claimable credential', async () => {
  const { owner, smtp } = await setup(() => 'accept');
  const original = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
  const [a, b] = await Promise.all([H.transferToEmail(BASE, original, owner, GOOD), H.transferToEmail(BASE, original, owner, GOOD)]);
  H.assert([a, b].some((r) => r.status === 200), 'at least one request must succeed, got ' + JSON.stringify([a, b]));
  H.assert(distinctIds(smtp).size === 1, 'exactly one distinct credential delivered, got ' + distinctIds(smtp).size);
  H.assert((await claimableIds(smtp)).length === 1, 'exactly one claimable credential');
  H.assert((await statusOf(original.id)) === 'revoked/email-transferred', 'original revoked');
});

scenario('two claimants race for the delivered credential: exactly one wins', async () => {
  const { owner, smtp } = await setup(() => 'accept');
  const original = await H.issueAsset(BASE, owner.publicKey, ASSET_CLASS);
  await H.transferToEmail(BASE, original, owner, GOOD);
  const delivered = H.attachmentOf(smtp.messages[0]);
  const c1 = await H.genIdentity();
  const c2 = await H.genIdentity();
  const [r1, r2] = await Promise.all([H.claimFromFile(BASE, delivered, c1), H.claimFromFile(BASE, delivered, c2)]);
  const wins = [r1, r2].filter((r) => r.status === 200).length;
  H.assert(wins === 1, 'exactly one claim must win, got ' + JSON.stringify([r1.status, r2.status]));
  const loser = r1.status === 200 ? r2 : r1;
  H.assert(loser.body && loser.body.code === 'already-claimed', 'the loser should be told already-claimed, got ' + JSON.stringify(loser.body));
});

scenario('an admin send with an idempotency key: a repeat returns the same ticket and sends nothing', async () => {
  const { owner, smtp } = await setup(() => 'accept');
  const payload = { assetClass: ASSET_CLASS, recipientEmail: GOOD, idempotencyKey: 'order-1' };
  const first = await H.adminSend(BASE, owner, payload);
  const again = await H.adminSend(BASE, owner, payload);
  H.assert(first.status === 200 && again.status === 200 && first.body.ticketId === again.body.ticketId, 'same ticket expected, got ' + JSON.stringify([first.body, again.body]));
  H.assert(smtp.messages.length === 1 && (await claimableIds(smtp)).length === 1, 'one message, one claimable ticket');
  const other = await H.adminSend(BASE, owner, { ...payload, recipientEmail: 'other@example.com' });
  H.assert(other.status === 409, 'the key cannot be reused for a different address, got ' + JSON.stringify(other));
});

scenario('an admin send the mail server rejects: the mint is undone', async () => {
  const { owner, smtp } = await setup(() => 'reject');
  const res = await H.adminSend(BASE, owner, { assetClass: ASSET_CLASS, recipientEmail: GOOD });
  H.assert(res.status === 502, 'expected 502, got ' + JSON.stringify(res));
  H.assert(smtp.messages.length === 0, 'nothing delivered');
});

(async () => {
  console.log('Delivery scenarios (' + KIND + ' issuer), class ' + ASSET_CLASS);
  let failures = 0;
  for (const sc of scenarios) {
    try {
      await sc.fn();
      console.log('PASS: ' + sc.name);
    } catch (err) {
      failures++;
      console.log('FAIL: ' + sc.name + '\n   ' + err.message);
    } finally {
      await teardown();
    }
  }
  if (failures) { console.error('FAILURE: ' + failures + ' scenario(s) failed'); process.exit(1); }
  console.log('\nALL DELIVERY SCENARIOS PASSED (' + KIND + ', ' + ASSET_CLASS + ')');
})().catch((err) => { console.error('FAILURE:', err); process.exit(1); });
