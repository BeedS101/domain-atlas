// Crash-recovery regression for delivering a credential by email, run against
// either issuer and for each way a delivery can start:
//
//   node test/manual-email-delivery-crash.js node [flow]
//   node test/manual-email-delivery-crash.js php  [flow]
//
//   flow  wallet       POST /atlas/asset/transfer-to-email (a held credential)
//         forward      an inbound forward picked up by the mailbox poll
//                      (a bearer credential passed on by CC)
//         admin        POST /atlas/admin/send-ticket-to-email with an
//                      idempotencyKey (a fresh mint straight to an address)
//         admin-nokey  the same without a key (no client retry: that would be a
//                      second send)
//   default: wallet. SMTP_AFTER_CRASH=reject makes the mail server refuse every
//   message once the issuer has come back, so each stop before acceptance ends
//   in a rollback; the original must then be exactly as it was (spendable,
//   and listed again if it is a bearer credential) and no copy claimable.
//   ASSET_CLASS overrides the class (any unique, giftable,
//   non-bound class works; the default is not a ticket).
//
// The issuer is made to stop dead (ATLAS_TEST_CRASH_AT) at each step of the
// delivery, restarted on the same state, and given the chance to recover
// (a restart for issuer-server, the cron-style poll-now call plus a client
// retry for the PHP bundle). Whatever the crash point, the invariants below
// are judged by what the fake mail server actually received (the recipient's
// copy) and by what the issuer says about each credential:
//
//   NO DUPLICATION  the sender's original and a delivered copy are never
//                   both usable.
//   ONE COPY        across every message the recipient received (retries
//                   included), at most one distinct credential is claimable.
//   NO LOSS         if the original is gone, the recipient holds a
//                   claimable copy.
//   NO LIMBO        once recovery and the client's retry have run, no delivery
//                   is left open and the original is not left suspended.
//   FROZEN          from the moment the delivery holds the original, spending
//                   it somewhere else is refused; if it was spent earlier, no
//                   copy may end up claimable.
//   KEYED SEND      an admin send with an idempotencyKey ends with exactly one
//                   claimable ticket, whatever the crash point.
//
// Safety (duplication, one copy) is checked straight after the restart as
// well as after the retry; the end state after the retry.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const H = require('./lib/delivery-harness');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const FLOW = ['wallet', 'forward', 'admin', 'admin-nokey'].includes(process.argv[3]) ? process.argv[3] : 'wallet';
const NODE_PORT = 8231;
const PHP_PORT = 8232;
const SMTP_PORT = 8981;
const IMAP_PORT = 8982;
const PORT = KIND === 'php' ? PHP_PORT : NODE_PORT;
const BASE = 'http://localhost:' + PORT;
const ASSET_CLASS = process.env.ASSET_CLASS || 'atlas.demo.attestation.filing';
const RECIPIENT = FLOW === 'forward' ? 'holder2@example.com' : 'friend@example.com';
const HAS_ORIGINAL = FLOW === 'wallet' || FLOW === 'forward';
const USES_IMAP = FLOW === 'forward';

const ALL_POINTS = 'delivery:minted,delivery:prepared,delivery:held,delivery:sending,delivery:sent-unrecorded,delivery:accepted,delivery:original-revoke-fact,delivery:original-revoked,delivery:bearer-registered,delivery:delivered';
// A fresh mint has no original to revoke.
const NOT_APPLICABLE = HAS_ORIGINAL ? [] : ['delivery:original-revoke-fact', 'delivery:original-revoked'];
// Only a bearer original is taken out of the bearer registry. (bearer-recorded is
// only reached when the caller gives the engine no copy of the entry, which the
// forward route always does; manual-delivery-hold-recovery.js covers it.)
const BEARER_POINTS = FLOW === 'forward' ? ['delivery:bearer-taken'] : [];
const ROLLBACK_VARIANT = process.env.SMTP_AFTER_CRASH === 'reject';
const PAST_ACCEPTANCE = ['delivery:accepted', 'delivery:original-revoke-fact', 'delivery:original-revoked', 'delivery:bearer-registered', 'delivery:delivered'];
const POINTS = (process.env.CRASH_POINTS || ALL_POINTS + (BEARER_POINTS.length ? ',' + BEARER_POINTS.join(',') : '')).split(',').filter((p) => !NOT_APPLICABLE.includes(p));
const FROZEN_POINTS = ['delivery:held', 'delivery:sending', 'delivery:sent-unrecorded', 'delivery:accepted'];

async function startIssuer(location, env) {
  if (KIND === 'node') {
    return H.startNodeIssuer({ port: PORT, stateDir: location.stateDir, docrootDir: location.docrootDir, env: { ...H.smtpEnvFor(SMTP_PORT), ...(USES_IMAP ? H.imapEnvFor(IMAP_PORT) : {}), ...env } });
  }
  return H.startPhpIssuer({ port: PORT, bundleDir: location.bundleDir, env });
}

async function recover(location) {
  // PHP has no daemon: its recovery runs from the cron-style poll-now call.
  if (KIND === 'php') await H.adminPollNow(BASE, location.admin).catch(() => {});
}

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

function openDeliveries(location) {
  const doc = H.readState(KIND, KIND === 'node' ? location.stateDir : location.bundleDir, 'atlas-deliveries-store.json');
  if (!doc || !doc.deliveries) return 0;
  return Object.values(doc.deliveries).filter((r) => r.state !== 'delivered' && r.state !== 'rolled-back').length;
}

async function judge(location, original, smtp) {
  const originalStatus = original ? await H.mailCheckStatus(BASE, location.admin, original) : null;
  const originalUsable = !!original && (!originalStatus || (originalStatus.status !== 'revoked' && originalStatus.status !== 'suspended'));
  const delivered = [];
  for (const m of smtp.messages) {
    if (!m.rcptTo.some((r) => r.includes(RECIPIENT))) continue;
    const cred = H.attachmentOf(m);
    if (!cred) continue;
    const st = await H.getJson(BASE, '/atlas/asset/file-status?id=' + encodeURIComponent(cred.id));
    delivered.push({ id: cred.id, claimable: !!(st.body && st.body.claimable) });
  }
  const claimableIds = new Set(delivered.filter((d) => d.claimable).map((d) => d.id));
  let originalListed = null;
  if (original && FLOW === 'forward') {
    const st = await H.getJson(BASE, '/atlas/asset/file-status?id=' + encodeURIComponent(original.id));
    originalListed = !!(st.body && st.body.claimable);
  }
  return {
    originalListed,
    multiplication: claimableIds.size > 1,
    limbo: !!originalStatus && originalStatus.status === 'suspended',
    open: openDeliveries(location),
    originalStatus: original ? (originalStatus ? originalStatus.status + (originalStatus.reason ? '/' + originalStatus.reason : '') : 'valid') : 'n/a',
    originalUsable,
    delivered,
    duplication: originalUsable && claimableIds.size > 0,
    loss: !!original && !originalUsable && claimableIds.size === 0 && !!originalStatus && originalStatus.status === 'revoked' && originalStatus.reason === 'email-transferred'
  };
}

function distinctClaimable(r) {
  return new Set(r.delivered.filter((d) => d.claimable).map((d) => d.id)).size;
}

// What each flow does to start (and later repeat) the delivery.
function flowOps(ctx) {
  if (FLOW === 'wallet') {
    return {
      async setup() { ctx.original = await H.issueAsset(BASE, ctx.owner.publicKey, ASSET_CLASS); },
      trigger: () => H.transferToEmail(BASE, ctx.original, ctx.owner, RECIPIENT),
      retry: () => H.transferToEmail(BASE, ctx.original, ctx.owner, RECIPIENT),
      spend: (thief) => H.walletTransfer(BASE, ctx.original, ctx.owner, thief.publicKey)
    };
  }
  if (FLOW === 'forward') {
    return {
      async setup() {
        // A bearer ticket in the holder's hands, and their forward of it waiting in the mailbox.
        const first = await H.issueAsset(BASE, ctx.owner.publicKey, ASSET_CLASS);
        const sent = await H.transferToEmail(BASE, first, ctx.owner, 'holder1@example.com');
        H.assert(sent.status === 200, 'setup send failed: ' + JSON.stringify(sent));
        ctx.original = H.attachmentOf(ctx.smtp.messages[0]);
        ctx.imap.mailbox.push({ raw: H.buildForwardMessage('holder1@example.com', [RECIPIENT], ctx.original), seen: false });
      },
      trigger: () => H.adminPollNow(BASE, ctx.owner),
      retry: () => H.adminPollNow(BASE, ctx.owner),
      spend: (thief) => H.claimFromFile(BASE, ctx.original, thief)
    };
  }
  const payload = { assetClass: ASSET_CLASS, recipientEmail: RECIPIENT, ...(FLOW === 'admin' ? { idempotencyKey: 'crash-test-key' } : {}) };
  return {
    async setup() {},
    trigger: () => H.adminSend(BASE, ctx.owner, payload),
    // Without a key a repeated request is a second send by definition, so it
    // is not repeated; recovery alone must leave one ticket or none.
    retry: FLOW === 'admin' ? () => H.adminSend(BASE, ctx.owner, payload) : async () => ({ status: 0 }),
    spend: null
  };
}

async function runPoint(point) {
  let smtpMode = 'accept';
  const smtp = await H.startFakeSmtp(SMTP_PORT, () => smtpMode);
  const imap = USES_IMAP ? await H.startFakeImap(IMAP_PORT, { user: 'tickets@test-domain.local', pass: 'imap-test-pass' }) : null;
  const owner = await H.genIdentity();
  const location = { admin: owner };
  if (KIND === 'node') {
    location.stateDir = H.tmpDir('atlas-crash-state-');
    location.docrootDir = H.tmpDir('atlas-crash-docroot-');
    H.writeAdminRoster('node', location.stateDir, [owner]);
  } else {
    location.bundleDir = H.preparePhpBundle(SMTP_PORT, USES_IMAP ? IMAP_PORT : 0);
    H.writeAdminRoster('php', location.bundleDir, [owner]);
  }
  const ctx = { owner, smtp, imap };
  const ops = flowOps(ctx);
  let issuer = await startIssuer(location, {});
  let result;
  try {
    // Preconditions are set up on an issuer that is not about to crash.
    await ops.setup();
    await H.stopIssuer(issuer);
    issuer = await startIssuer(location, { ATLAS_TEST_CRASH_AT: point });

    const first = await ops.trigger().catch((e) => ({ status: 0, error: e.message }));
    if (KIND === 'node') await Promise.race([issuer.exited, new Promise((r) => setTimeout(r, 3000))]);
    const crashed = KIND === 'node' ? issuer.proc.exitCode === 86 : (first.status !== 200 || (first.body && first.body.raw === ''));
    H.assert(crashed, 'expected the issuer to stop at ' + point + ', request answered ' + JSON.stringify(first));
    await H.stopIssuer(issuer);
    if (ROLLBACK_VARIANT) smtpMode = 'reject';

    // Node's automatic sweeps are off for this restart so the state the stop
    // left behind can be inspected (and poked at) before recovery runs.
    issuer = await startIssuer(location, { ATLAS_DELIVERY_NO_SWEEP: '1' });
    const beforeRecovery = await judge(location, ctx.original, smtp);
    // While the delivery is unresolved, can someone spend the original
    // somewhere else? From the moment it is frozen the answer must be no.
    let spent = false;
    if (ops.spend && !ROLLBACK_VARIANT) {
      const thief = await H.genIdentity();
      const spend = await ops.spend(thief).catch(() => ({ status: 0 }));
      spent = spend.status === 200;
    }
    if (KIND === 'node') {
      await H.stopIssuer(issuer);
      issuer = await startIssuer(location, {});
    }
    await recover(location);
    await nap(1500);
    const afterRestart = await judge(location, ctx.original, smtp);
    // The client repeats its request (it never saw an answer).
    const retried = await ops.retry().catch(() => ({ status: 0 }));
    await recover(location);
    await nap(1500);
    result = { beforeRecovery, spent, afterRestart, retried, end: await judge(location, ctx.original, smtp) };
  } finally {
    await H.stopIssuer(issuer);
    await smtp.close();
    if (imap) await imap.close();
  }
  return result;
}

(async () => {
  console.log('Delivery crash matrix (' + KIND + ' issuer, ' + FLOW + ' flow), class ' + ASSET_CLASS);
  let failures = 0;
  for (const point of POINTS) {
    const { beforeRecovery, spent, afterRestart, retried, end } = await runPoint(point);
    const problems = [];
    if (beforeRecovery.duplication) problems.push('DUPLICATION before recovery');
    if (beforeRecovery.multiplication) problems.push('MULTIPLICATION before recovery');
    if (HAS_ORIGINAL && FROZEN_POINTS.includes(point) && spent) problems.push('ORIGINAL SPENDABLE while a delivery was in flight');
    if (spent && distinctClaimable(end) > 0) problems.push('DUPLICATION: original spent and a copy delivered');
    if (afterRestart.duplication) problems.push('DUPLICATION after restart');
    if (afterRestart.multiplication) problems.push('MULTIPLICATION after restart');
    if (end.duplication) problems.push('DUPLICATION at end');
    if (end.multiplication) problems.push('MULTIPLICATION at end');
    if (end.loss) problems.push('LOSS at end');
    if (end.limbo) problems.push('LIMBO at end');
    if (end.open) problems.push('LIMBO: ' + end.open + ' delivery record(s) left open');
    if (ROLLBACK_VARIANT && HAS_ORIGINAL && !PAST_ACCEPTANCE.includes(point)) {
      if (!end.originalUsable) problems.push('ROLLBACK: original not restored (' + end.originalStatus + ')');
      if (FLOW === 'forward' && !end.originalListed) problems.push('ROLLBACK: bearer original not listed again');
      if (distinctClaimable(end) > 0) problems.push('ROLLBACK: a copy is still claimable');
    }
    if (FLOW === 'admin') {
      if (!ROLLBACK_VARIANT && retried.status !== 200) problems.push('KEYED SEND: retry answered ' + retried.status + ' ' + JSON.stringify(retried.body));
      if (!ROLLBACK_VARIANT && distinctClaimable(end) !== 1) problems.push('KEYED SEND: expected exactly one claimable ticket, found ' + distinctClaimable(end));
    }
    if (problems.length) failures++;
    console.log((problems.length ? 'FAIL' : 'PASS') + ': crash at ' + point + (spent ? ' [original spent meanwhile]' : '') + ' -> after restart: original ' + afterRestart.originalStatus +
      ', ' + afterRestart.delivered.length + ' message(s), ' + distinctClaimable(afterRestart) + ' claimable credential(s); at end: original ' + end.originalStatus +
      ', ' + end.delivered.length + ' message(s), ' + distinctClaimable(end) + ' claimable credential(s)' + (problems.length ? ' => ' + problems.join(', ') : ''));
  }
  if (failures) { console.error('FAILURE: ' + failures + ' crash point(s) violate the delivery invariants'); process.exit(1); }
  console.log('\nALL DELIVERY CRASH CHECKS PASSED (' + KIND + ', ' + FLOW + ')');
})().catch((err) => { console.error('FAILURE:', err); process.exit(1); });
