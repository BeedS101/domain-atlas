// Durable, idempotent delivery of a credential to a recipient over a
// transport the issuer cannot confirm (today: email). The same pattern the
// file export uses (a record per delivery, every step written before the
// next, every step safe to repeat), adapted to a transport where the hand-off
// itself can succeed without the issuer learning of it.
//
// States of a delivery record:
//
//   prepared         record durable; nothing else has changed
//   held             the sender's original is frozen (suspended with reason
//                    'delivery-hold'; a bearer original is also taken out of
//                    the bearer registry) so it cannot be used while the
//                    copy is in flight
//   sending          an attempt is, or may be, in progress. The attempt
//                    counter is written BEFORE the conversation with the mail
//                    server, so finding this state later means the outcome
//                    is unknown
//   accepted         the mail server positively accepted the message: the
//                    point of no return; recovery only moves forward
//   original-revoked the sender's original is revoked
//   delivered        the new credential is listed in the bearer registry
//                    (terminal for the delivery; the credential itself stays
//                    claimable until claimed)
//   rolling-back     a failure was decided; undoing is in progress
//   rolled-back      terminal: the sender is exactly as before, the new
//                    credential is revoked
//
// Safety properties:
//   - the original and a claimable copy are never both usable (the original
//     is frozen before the first send and revoked before the copy is listed);
//   - the copy is not claimable or forwardable until acceptance is recorded,
//     so a message that left during an unrecorded attempt carries a
//     credential nobody can act on yet; if the delivery is rolled back that
//     credential is revoked, so a possibly-delivered copy is dead, never live;
//   - a resent message carries the identical credential, so duplicate
//     messages are harmless (one id, one claim wins);
//   - recovery resumes a delivery only when it can be identified again (it
//     has a key: the original's id, or a client-supplied idempotency key);
//     otherwise an unconfirmed delivery is rolled back.
//
// The engine owns no I/O of its own: everything the issuer already does
// (revoke, suspend, bearer registry, sending) is passed in.

const fs = require('fs');
const crypto = require('crypto');

const TERMINAL = new Set(['delivered', 'rolled-back']);
const HOLD_REASON = 'delivery-hold';

function hashRecipient(recipient) {
  return crypto.createHash('sha256').update(String(recipient).trim().toLowerCase()).digest('hex');
}

// Permanent failures are an SMTP 5xx answer to a command or to the message;
// everything else (connection errors, 4xx, a dropped connection) may succeed
// if tried again.
function classifySendError(err) {
  const text = (err && err.message) || String(err);
  const m = text.match(/got (\d{3}):/) || text.match(/not accepted: (\d{3})/);
  if (m && m[1][0] === '5') return 'permanent';
  return 'transient';
}

function createDeliveryEngine(deps) {
  const {
    storeFile, fault = () => {}, now = () => new Date(),
    revoke, isRevoked, revocationEntryOf, suspend, unsuspend, findSuspension,
    registerBearer, takeBearer, restoreBearer, hasBearer, bearerEntryOf, archive, send,
    onDelivered = () => {}, onRolledBack = () => {}
  } = deps;
  const maxAttempts = deps.maxAttempts || 3;
  const resumeTtlMs = deps.resumeTtlMs || 24 * 60 * 60 * 1000;
  const retryBackoffMs = deps.retryBackoffMs === undefined ? 500 : deps.retryBackoffMs;
  const keepTerminalMs = deps.keepTerminalMs || 30 * 24 * 60 * 60 * 1000;
  const inFlight = new Set();

  function read() {
    if (!fs.existsSync(storeFile)) return { version: 1, deliveries: {}, byKey: {} };
    const doc = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    if (!doc.deliveries || Array.isArray(doc.deliveries)) doc.deliveries = {};
    if (!doc.byKey || Array.isArray(doc.byKey)) doc.byKey = {};
    return doc;
  }
  function write(doc) {
    const tmp = storeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, storeFile);
  }
  function setState(doc, rec, state, extra) {
    const at = now().toISOString();
    rec.state = state;
    rec.updatedAt = at;
    rec.transitions.push({ state, at });
    Object.assign(rec, extra || {});
    write(doc);
  }
  function close(doc, rec, state, extra) {
    // The terminal record keeps a compact receipt, not the credentials or
    // the address.
    rec.recipientHash = rec.recipientHash || hashRecipient(rec.recipient);
    delete rec.recipient;
    delete rec.original;
    delete rec.minted;
    delete rec.heldBearer;
    rec.closedAt = now().toISOString();
    setState(doc, rec, state, extra);
  }

  function recordOf(deliveryId) {
    const doc = read();
    return doc.deliveries[deliveryId] || null;
  }
  // The most recent delivery for a key, or null.
  function latestForKey(key) {
    if (!key) return null;
    const doc = read();
    const id = doc.byKey[key];
    return id ? doc.deliveries[id] || null : null;
  }
  function canResume(rec) {
    return !!rec.key && rec.attempts < maxAttempts && now().getTime() - Date.parse(rec.createdAt) < resumeTtlMs;
  }

  // Creates a record. Refuses (returns {existing}) when an unfinished or
  // completed delivery already exists for the key. Synchronous end to end,
  // so no other request can interleave.
  function begin(spec) {
    const doc = read();
    if (spec.key) {
      const prior = doc.byKey[spec.key] ? doc.deliveries[doc.byKey[spec.key]] : null;
      // An unfinished delivery for the key, or one that already completed:
      // either way the key is not delivered a second time. Only a
      // rolled-back delivery leaves the key free to try again.
      if (prior && prior.state !== 'rolled-back') return { existing: prior };
    }
    const at = now().toISOString();
    const rec = {
      deliveryId: 'urn:atlas:delivery:' + crypto.randomUUID(),
      key: spec.key || null,
      operation: 'transfer',
      transport: 'email',
      kind: spec.kind, // 'wallet-original' | 'bearer-original' | 'fresh-mint'
      class: spec.class,
      ownerPublicKey: spec.ownerPublicKey || null,
      originalId: spec.original ? spec.original.id : null,
      original: spec.original || null,
      mintedId: spec.minted.id,
      minted: spec.minted,
      recipient: spec.recipient,
      recipientHash: hashRecipient(spec.recipient),
      returnTo: spec.returnTo || null,
      heldBearer: spec.heldBearer || null,
      archiveReason: 'email-transferred',
      attempts: 0,
      lastError: null,
      state: 'prepared', createdAt: at, updatedAt: at, transitions: [{ state: 'prepared', at }]
    };
    doc.deliveries[rec.deliveryId] = rec;
    if (rec.key) doc.byKey[rec.key] = rec.deliveryId;
    write(doc);
    fault('delivery:prepared');
    return { rec };
  }

  function holdOriginal(doc, rec) {
    if (rec.originalId) {
      const entry = revocationEntryOf(rec.originalId);
      if (entry && entry.reason !== 'email-transferred') return false; // spent some other way
      if (rec.kind === 'bearer-original' && hasBearer(rec.originalId)) {
        // Removing the registry entry is the first durable change to the
        // original, so what is needed to put it back is written first: a
        // stop between the removal and the 'held' state must still leave
        // rollback able to restore the entry.
        if (!rec.heldBearer && bearerEntryOf) {
          rec.heldBearer = bearerEntryOf(rec.originalId);
          write(doc);
          fault('delivery:bearer-recorded');
        }
        rec.heldBearer = takeBearer(rec.originalId) || rec.heldBearer;
        fault('delivery:bearer-taken');
      }
      if (!entry && !findSuspension(rec.originalId)) suspend(rec.originalId, HOLD_REASON);
    }
    return true;
  }

  function rollbackSteps(doc, rec) {
    // Every step is safe to repeat.
    if (!isRevoked(rec.mintedId)) {
      takeBearer(rec.mintedId);
      revoke(rec.mintedId, 'issuer-request');
    }
    if (rec.originalId && !isRevoked(rec.originalId)) {
      if (rec.kind === 'bearer-original' && rec.heldBearer && !hasBearer(rec.originalId)) restoreBearer(rec.originalId, rec.heldBearer);
      const held = findSuspension(rec.originalId);
      if (held && held.reason === HOLD_REASON) unsuspend(rec.originalId);
    }
  }
  async function rollback(doc, rec, reason) {
    if (rec.state !== 'rolling-back') setState(doc, rec, 'rolling-back', { rollbackReason: reason });
    fault('delivery:rolling-back');
    rollbackSteps(doc, rec);
    const info = { rec: { ...rec } };
    close(doc, rec, 'rolled-back');
    fault('delivery:rolled-back');
    try { await onRolledBack(info.rec, reason); } catch (_) { /* best effort */ }
    return rec;
  }

  // Drives a record forward until it is terminal. Idempotent: it may be
  // called on any record in any state, including one an earlier process left
  // part-way.
  async function run(deliveryId, opts) {
    if (inFlight.has(deliveryId)) return { rec: recordOf(deliveryId), busy: true };
    inFlight.add(deliveryId);
    const syncAttempts = (opts && opts.attemptsThisCall) || maxAttempts;
    let attemptsThisCall = 0;
    try {
      for (let guard = 0; guard < 40; guard++) {
        const doc = read();
        const rec = doc.deliveries[deliveryId];
        if (!rec) return { rec: null };
        if (TERMINAL.has(rec.state)) return { rec };

        // A record found in 'sending' when this call starts is an attempt
        // whose outcome is unknown. It goes back to 'held' so the retry is
        // counted like any other attempt.
        if (rec.state === 'sending' && guard === 0) {
          setState(doc, rec, 'held');
          continue;
        }
        if (rec.state === 'prepared') {
          if (!holdOriginal(doc, rec)) { await rollback(doc, rec, 'original-spent'); continue; }
          setState(doc, rec, 'held');
          fault('delivery:held');
          continue;
        }
        if (rec.state === 'held') {
          rec.attempts += 1;
          setState(doc, rec, 'sending');
          fault('delivery:sending');
          continue;
        }
        if (rec.state === 'sending') {
          // Reached either straight from 'held' or by recovery finding an
          // attempt whose outcome is unknown; both just (re)send.
          attemptsThisCall += 1;
          try {
            await send(rec.minted, rec.recipient, rec);
          } catch (err) {
            rec.lastError = (err && err.message) || String(err);
            const kind = classifySendError(err);
            if (kind === 'transient' && rec.attempts < maxAttempts && attemptsThisCall < syncAttempts) {
              setState(doc, rec, 'held');
              if (retryBackoffMs) await new Promise((r) => setTimeout(r, retryBackoffMs));
              continue;
            }
            await rollback(doc, rec, kind === 'permanent' ? 'rejected' : 'unreachable');
            continue;
          }
          fault('delivery:sent-unrecorded');
          setState(doc, rec, 'accepted');
          fault('delivery:accepted');
          continue;
        }
        if (rec.state === 'accepted') {
          if (rec.originalId && !isRevoked(rec.originalId)) {
            revoke(rec.originalId, 'email-transferred');
            fault('delivery:original-revoke-fact');
          }
          if (rec.original) archive(rec.original, rec.archiveReason);
          setState(doc, rec, 'original-revoked');
          fault('delivery:original-revoked');
          continue;
        }
        if (rec.state === 'original-revoked') {
          if (!hasBearer(rec.mintedId) && !isRevoked(rec.mintedId)) registerBearer(rec.mintedId, rec.class);
          fault('delivery:bearer-registered');
          if (rec.originalId) unsuspend(rec.originalId);
          await onDelivered(rec);
          close(doc, rec, 'delivered');
          fault('delivery:delivered');
          continue;
        }
        if (rec.state === 'rolling-back') {
          await rollback(doc, rec, rec.rollbackReason || 'recovered');
          continue;
        }
        throw new Error('unknown delivery state ' + rec.state);
      }
      throw new Error('delivery state machine did not settle');
    } finally {
      inFlight.delete(deliveryId);
    }
  }

  // Background recovery: finishes what a stopped process left. Records not
  // yet accepted are resumed only when they can be identified again,
  // otherwise rolled back so nothing is left half-done.
  async function sweep(opts) {
    const minAgeMs = (opts && opts.minAgeMs !== undefined) ? opts.minAgeMs : 0;
    const doc = read();
    const results = [];
    for (const rec of Object.values(doc.deliveries)) {
      if (TERMINAL.has(rec.state) || inFlight.has(rec.deliveryId)) continue;
      if (now().getTime() - Date.parse(rec.updatedAt) < minAgeMs) continue;
      if (['accepted', 'original-revoked', 'rolling-back'].includes(rec.state)) {
        results.push(await run(rec.deliveryId));
      } else if (canResume(rec)) {
        // 'sending' means an attempt of unknown outcome: send again.
        if (rec.state === 'held' || rec.state === 'prepared') results.push(await run(rec.deliveryId));
        else if (rec.state === 'sending') results.push(await run(rec.deliveryId));
      } else {
        const fresh = read();
        const live = fresh.deliveries[rec.deliveryId];
        if (live && !TERMINAL.has(live.state)) {
          await rollback(fresh, live, live.state === 'sending' ? 'uncertain-delivery' : 'abandoned');
          results.push({ rec: recordOf(rec.deliveryId) });
        }
      }
    }
    compact();
    return results;
  }

  function compact() {
    const doc = read();
    let changed = false;
    for (const [id, rec] of Object.entries(doc.deliveries)) {
      if (TERMINAL.has(rec.state) && rec.closedAt && now().getTime() - Date.parse(rec.closedAt) > keepTerminalMs) {
        delete doc.deliveries[id];
        if (rec.key && doc.byKey[rec.key] === id) delete doc.byKey[rec.key];
        changed = true;
      }
    }
    if (changed) write(doc);
  }

  function pendingCount() {
    return Object.values(read().deliveries).filter((r) => !TERMINAL.has(r.state)).length;
  }

  return { begin, run, sweep, recordOf, latestForKey, pendingCount, canResume, isBusy: (id) => inFlight.has(id), hashRecipient };
}

module.exports = { createDeliveryEngine, classifySendError, hashRecipient, HOLD_REASON };
