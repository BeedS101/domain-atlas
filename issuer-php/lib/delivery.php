<?php
// Durable, idempotent delivery of a credential to a recipient over a
// transport the issuer cannot confirm (today: email). PHP counterpart of
// issuer-server/lib-delivery.js; the state machine, the safety properties
// and the JSON record shape are the same, so either issuer can read the
// other's store. See that file's header for the states:
//
//   prepared -> held -> sending -> accepted -> original-revoked -> delivered
//   (rolling-back -> rolled-back on a decided failure)
//
// This bundle has no long-lived process: recovery runs from the cron-style
// poll-now endpoint, and opportunistically at the start of any request that
// starts or repeats a delivery. A delivery being driven by a request holds
// its own lock for the duration, so a sweep (or a second request) that finds
// it locked leaves it alone.

require_once __DIR__ . '/smtp.php';
require_once __DIR__ . '/email-tickets.php';

const ATLAS_DELIVERY_TERMINAL = ['delivered', 'rolled-back'];
const ATLAS_DELIVERY_HOLD_REASON = 'delivery-hold';

function atlas_deliveries_file() {
  return __DIR__ . '/atlas-deliveries-store.json';
}

function atlas_delivery_max_attempts() {
  $v = getenv('ATLAS_DELIVERY_MAX_ATTEMPTS');
  return ($v !== false && (int) $v > 0) ? (int) $v : 3;
}
function atlas_delivery_backoff_ms() {
  $v = getenv('ATLAS_DELIVERY_RETRY_BACKOFF_MS');
  return $v !== false ? max(0, (int) $v) : 500;
}
function atlas_delivery_resume_ttl_seconds() {
  return 24 * 60 * 60;
}
function atlas_delivery_keep_terminal_seconds() {
  return 30 * 24 * 60 * 60;
}

function atlas_delivery_hash_recipient($recipient) {
  return hash('sha256', strtolower(trim((string) $recipient)));
}

// Permanent failures are an SMTP 5xx answer to a command or to the message;
// everything else (connection errors, 4xx, a dropped connection) may succeed
// if tried again.
function atlas_delivery_classify_send_error($message) {
  if (preg_match('/got (\d{3}):/', $message, $m) || preg_match('/not accepted: (\d{3})/', $message, $m)) {
    if ($m[1][0] === '5') return 'permanent';
  }
  return 'transient';
}

// Read-modify-write under an exclusive lock. The document always has
// `deliveries` and `byKey` as objects, so the file reads the same in
// issuer-server.
function atlas_delivery_modify($fn) {
  $fh = fopen(atlas_deliveries_file(), 'c+');
  if ($fh === false) throw new Exception('could not open the delivery store');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc)) $doc = [];
  if (!isset($doc['deliveries']) || !is_array($doc['deliveries'])) $doc['deliveries'] = [];
  if (!isset($doc['byKey']) || !is_array($doc['byKey'])) $doc['byKey'] = [];
  $doc['version'] = 1;
  $result = $fn($doc);
  ftruncate($fh, 0);
  rewind($fh);
  $out = $doc;
  $out['deliveries'] = (object) $doc['deliveries'];
  $out['byKey'] = (object) $doc['byKey'];
  fwrite($fh, json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}

function atlas_delivery_read() {
  $file = atlas_deliveries_file();
  $empty = ['version' => 1, 'deliveries' => [], 'byKey' => []];
  if (!file_exists($file)) return $empty;
  $fh = fopen($file, 'r');
  if ($fh === false) return $empty;
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) return $empty;
  if (!isset($doc['deliveries']) || !is_array($doc['deliveries'])) $doc['deliveries'] = [];
  if (!isset($doc['byKey']) || !is_array($doc['byKey'])) $doc['byKey'] = [];
  return $doc;
}

function atlas_delivery_record($deliveryId) {
  $doc = atlas_delivery_read();
  return $doc['deliveries'][$deliveryId] ?? null;
}

function atlas_delivery_latest_for_key($key) {
  if (!$key) return null;
  $doc = atlas_delivery_read();
  $id = $doc['byKey'][$key] ?? null;
  return $id ? ($doc['deliveries'][$id] ?? null) : null;
}

// Replaces a record wholesale (the caller has just worked on a copy).
function atlas_delivery_save($rec) {
  atlas_delivery_modify(function (&$doc) use ($rec) {
    $doc['deliveries'][$rec['deliveryId']] = $rec;
  });
}

function atlas_delivery_set_state(&$rec, $state, $extra = []) {
  $at = atlas_now_iso();
  $rec['state'] = $state;
  $rec['updatedAt'] = $at;
  $rec['transitions'][] = ['state' => $state, 'at' => $at];
  foreach ($extra as $k => $v) $rec[$k] = $v;
  atlas_delivery_save($rec);
}

function atlas_delivery_close(&$rec, $state, $extra = []) {
  if (empty($rec['recipientHash']) && isset($rec['recipient'])) $rec['recipientHash'] = atlas_delivery_hash_recipient($rec['recipient']);
  unset($rec['recipient'], $rec['original'], $rec['minted'], $rec['heldBearer']);
  $rec['closedAt'] = atlas_now_iso();
  atlas_delivery_set_state($rec, $state, $extra);
}

function atlas_delivery_can_resume($rec) {
  return !empty($rec['key']) && $rec['attempts'] < atlas_delivery_max_attempts()
    && time() - strtotime($rec['createdAt']) < atlas_delivery_resume_ttl_seconds();
}

// Creates a record. Returns ['existing' => rec] when an unfinished delivery
// already exists for the key, else ['rec' => rec]. The check and the write
// happen under one lock.
function atlas_delivery_begin($spec) {
  $began = atlas_delivery_modify(function (&$doc) use ($spec) {
    $key = $spec['key'] ?? null;
    if ($key && isset($doc['byKey'][$key]) && isset($doc['deliveries'][$doc['byKey'][$key]])) {
      $prior = $doc['deliveries'][$doc['byKey'][$key]];
      if (!in_array($prior['state'], ATLAS_DELIVERY_TERMINAL, true)) return ['existing' => $prior];
    }
    $at = atlas_now_iso();
    $uuid = bin2hex(random_bytes(16));
    $uuid = substr($uuid, 0, 8) . '-' . substr($uuid, 8, 4) . '-4' . substr($uuid, 13, 3) . '-a' . substr($uuid, 17, 3) . '-' . substr($uuid, 20, 12);
    $rec = [
      'deliveryId' => 'urn:atlas:delivery:' . $uuid,
      'key' => $key ?: null,
      'operation' => 'transfer',
      'transport' => 'email',
      'kind' => $spec['kind'],
      'class' => $spec['class'] ?? null,
      'ownerPublicKey' => $spec['ownerPublicKey'] ?? null,
      'originalId' => isset($spec['original']) ? $spec['original']['id'] : null,
      'original' => $spec['original'] ?? null,
      'mintedId' => $spec['minted']['id'],
      'minted' => $spec['minted'],
      'recipient' => $spec['recipient'],
      'recipientHash' => atlas_delivery_hash_recipient($spec['recipient']),
      'returnTo' => $spec['returnTo'] ?? null,
      'heldBearer' => $spec['heldBearer'] ?? null,
      'archiveReason' => 'email-transferred',
      'attempts' => 0,
      'lastError' => null,
      'state' => 'prepared', 'createdAt' => $at, 'updatedAt' => $at, 'transitions' => [['state' => 'prepared', 'at' => $at]],
    ];
    $doc['deliveries'][$rec['deliveryId']] = $rec;
    if ($key) $doc['byKey'][$key] = $rec['deliveryId'];
    return ['rec' => $rec];
  });
  if (isset($began['rec'])) file_export_fault_point('delivery:prepared');
  return $began;
}

// One lock per delivery (256 stripes), held while this process drives it.
function atlas_delivery_try_lock($deliveryId, $waitSeconds = 0) {
  $stripe = abs(crc32($deliveryId)) % 256;
  $fh = fopen(__DIR__ . '/atlas-delivery-lock-' . $stripe . '.lock', 'c');
  if ($fh === false) return null;
  $deadline = microtime(true) + $waitSeconds;
  while (!flock($fh, LOCK_EX | LOCK_NB)) {
    if (microtime(true) >= $deadline) { fclose($fh); return null; }
    usleep(5000);
  }
  return $fh;
}

function atlas_delivery_send($rec) {
  $config = atlas_email_tickets_config();
  if ($rec['kind'] === 'bearer-original') {
    atlas_smtp_send_mail([
      'host' => $config['smtpHost'], 'port' => $config['smtpPort'], 'secure' => $config['smtpSecure'],
      'user' => $config['smtpUser'], 'pass' => $config['smtpPass'], 'from' => $config['fromAddress'],
      // The forward's VERP envelope sender, so a later bounce can be
      // correlated to this send (SPEC.md §13.3).
      'envelopeFrom' => verp_return_path_for($config, $rec['minted']['id']),
      'to' => $rec['recipient'],
      'subject' => $rec['minted']['asset']['name'] ?? 'Your ticket',
      'textBody' => 'You have been sent "' . ($rec['minted']['asset']['name'] ?? $rec['minted']['asset']['class']) . '" from ' . atlas_domain() .
        ".\n\nThe attached file is your ticket. Keep it safe — forwarding this email, with the new holder CC'd, is how you pass it on.",
      'attachments' => [[
        'filename' => 'ticket-' . substr($rec['minted']['id'], strrpos($rec['minted']['id'], ':') + 1) . '.json',
        'contentType' => 'application/json',
        'content' => json_encode($rec['minted'], JSON_UNESCAPED_SLASHES),
      ]],
    ]);
    return;
  }
  atlas_mail_ticket_to($rec['minted'], $rec['recipient']);
}

function atlas_delivery_hold_original(&$rec) {
  if (!empty($rec['originalId'])) {
    $entry = revocation_entry_of($rec['originalId']);
    if ($entry && ($entry['reason'] ?? null) !== 'email-transferred') return false; // spent some other way
    if ($rec['kind'] === 'bearer-original' && has_bearer($rec['originalId'])) {
      $taken = take_bearer($rec['originalId']);
      if ($taken) $rec['heldBearer'] = $taken;
    }
    if (!$entry && find_suspension($rec['originalId']) === null) atlas_suspend($rec['originalId'], ATLAS_DELIVERY_HOLD_REASON, null);
  }
  return true;
}

function atlas_delivery_rollback_steps($rec) {
  if (!is_revoked($rec['mintedId'])) {
    take_bearer($rec['mintedId']);
    atlas_revoke($rec['mintedId'], 'issuer-request');
  }
  if (!empty($rec['originalId']) && !is_revoked($rec['originalId'])) {
    if ($rec['kind'] === 'bearer-original' && !empty($rec['heldBearer']) && !has_bearer($rec['originalId'])) {
      restore_bearer($rec['originalId'], $rec['heldBearer']);
    }
    $held = find_suspension($rec['originalId']);
    if ($held !== null && ($held['reason'] ?? null) === ATLAS_DELIVERY_HOLD_REASON) atlas_unsuspend($rec['originalId']);
  }
}

function atlas_delivery_rollback(&$rec, $reason) {
  if ($rec['state'] !== 'rolling-back') atlas_delivery_set_state($rec, 'rolling-back', ['rollbackReason' => $reason]);
  file_export_fault_point('delivery:rolling-back');
  atlas_delivery_rollback_steps($rec);
  $snapshot = $rec;
  atlas_delivery_close($rec, 'rolled-back');
  file_export_fault_point('delivery:rolled-back');
  // A forwarded ticket's sender is told the forward did not go through.
  if (($snapshot['kind'] ?? null) === 'bearer-original' && !empty($snapshot['returnTo'])) {
    send_plain_reply(atlas_email_tickets_config(), $snapshot['returnTo'], 'Could not forward your ticket',
      "The new holder's address could not be delivered to, so this forward did not go through. Your original ticket is unaffected.");
  }
}

// Drives a record forward until it is terminal. Idempotent: callable on any
// record in any state, including one an earlier process left part-way.
// Returns ['rec' => record|null, 'busy' => bool].
function atlas_delivery_run($deliveryId, $opts = []) {
  $lock = atlas_delivery_try_lock($deliveryId, $opts['waitSeconds'] ?? 0);
  if ($lock === null) return ['rec' => atlas_delivery_record($deliveryId), 'busy' => true];
  try {
    $maxAttempts = atlas_delivery_max_attempts();
    $attemptsThisCall = 0;
    for ($guard = 0; $guard < 40; $guard++) {
      $rec = atlas_delivery_record($deliveryId);
      if ($rec === null) return ['rec' => null, 'busy' => false];
      if (in_array($rec['state'], ATLAS_DELIVERY_TERMINAL, true)) return ['rec' => $rec, 'busy' => false];

      // A record found in 'sending' when this call starts is an attempt of
      // unknown outcome; it goes back to 'held' so the retry is counted.
      if ($rec['state'] === 'sending' && $guard === 0) {
        atlas_delivery_set_state($rec, 'held');
        continue;
      }
      if ($rec['state'] === 'prepared') {
        if (!atlas_delivery_hold_original($rec)) { atlas_delivery_rollback($rec, 'original-spent'); continue; }
        atlas_delivery_set_state($rec, 'held');
        file_export_fault_point('delivery:held');
        continue;
      }
      if ($rec['state'] === 'held') {
        $rec['attempts'] += 1;
        atlas_delivery_set_state($rec, 'sending');
        file_export_fault_point('delivery:sending');
        continue;
      }
      if ($rec['state'] === 'sending') {
        $attemptsThisCall++;
        try {
          atlas_delivery_send($rec);
        } catch (Exception $e) {
          $rec['lastError'] = $e->getMessage();
          $kind = atlas_delivery_classify_send_error($e->getMessage());
          if ($kind === 'transient' && $rec['attempts'] < $maxAttempts && $attemptsThisCall < $maxAttempts) {
            atlas_delivery_set_state($rec, 'held');
            $backoff = atlas_delivery_backoff_ms();
            if ($backoff > 0) usleep($backoff * 1000);
            continue;
          }
          atlas_delivery_rollback($rec, $kind === 'permanent' ? 'rejected' : 'unreachable');
          continue;
        }
        file_export_fault_point('delivery:sent-unrecorded');
        atlas_delivery_set_state($rec, 'accepted');
        file_export_fault_point('delivery:accepted');
        continue;
      }
      if ($rec['state'] === 'accepted') {
        if (!empty($rec['originalId']) && !is_revoked($rec['originalId'])) {
          atlas_revoke($rec['originalId'], 'email-transferred');
          file_export_fault_point('delivery:original-revoke-fact');
        }
        if (!empty($rec['original']) && find_archived_asset($rec['original']['id']) === null) {
          archive_if_audited(json_decode(json_encode($rec['original']), true), $rec['archiveReason']);
        }
        atlas_delivery_set_state($rec, 'original-revoked');
        file_export_fault_point('delivery:original-revoked');
        continue;
      }
      if ($rec['state'] === 'original-revoked') {
        if (!has_bearer($rec['mintedId']) && !is_revoked($rec['mintedId'])) register_bearer($rec['mintedId'], $rec['class']);
        file_export_fault_point('delivery:bearer-registered');
        if (!empty($rec['originalId'])) atlas_unsuspend($rec['originalId']);
        // A forwarded ticket is tracked until a later bounce can no longer
        // arrive, so the bounce can be reversed to whoever forwarded it.
        if (($rec['kind'] ?? null) === 'bearer-original' && !empty($rec['returnTo']) && find_pending_email_ticket_send($rec['mintedId']) === null) {
          record_pending_email_ticket_send($rec['minted'], $rec['returnTo']);
        }
        atlas_delivery_close($rec, 'delivered');
        file_export_fault_point('delivery:delivered');
        continue;
      }
      if ($rec['state'] === 'rolling-back') {
        atlas_delivery_rollback($rec, $rec['rollbackReason'] ?? 'recovered');
        continue;
      }
      throw new Exception('unknown delivery state ' . $rec['state']);
    }
    throw new Exception('delivery state machine did not settle');
  } finally {
    flock($lock, LOCK_UN);
    fclose($lock);
  }
}

// Finishes what a stopped process left. Records not yet accepted are
// resumed only when they can be identified again (they have a key),
// otherwise rolled back so nothing is left half-done. A delivery another
// process is driving right now is skipped.
function atlas_delivery_sweep() {
  $doc = atlas_delivery_read();
  $results = [];
  foreach ($doc['deliveries'] as $id => $rec) {
    if (in_array($rec['state'], ATLAS_DELIVERY_TERMINAL, true)) continue;
    if (in_array($rec['state'], ['accepted', 'original-revoked', 'rolling-back'], true) || atlas_delivery_can_resume($rec)) {
      $results[] = atlas_delivery_run($id);
      continue;
    }
    $lock = atlas_delivery_try_lock($id, 0);
    if ($lock === null) continue;
    try {
      $live = atlas_delivery_record($id);
      if ($live !== null && !in_array($live['state'], ATLAS_DELIVERY_TERMINAL, true)) {
        atlas_delivery_rollback($live, $live['state'] === 'sending' ? 'uncertain-delivery' : 'abandoned');
        $results[] = ['rec' => atlas_delivery_record($id), 'busy' => false];
      }
    } finally {
      flock($lock, LOCK_UN);
      fclose($lock);
    }
  }
  atlas_delivery_compact();
  return $results;
}

function atlas_delivery_compact() {
  atlas_delivery_modify(function (&$doc) {
    foreach ($doc['deliveries'] as $id => $rec) {
      if (in_array($rec['state'], ATLAS_DELIVERY_TERMINAL, true) && !empty($rec['closedAt'])
          && time() - strtotime($rec['closedAt']) > atlas_delivery_keep_terminal_seconds()) {
        unset($doc['deliveries'][$id]);
        if (!empty($rec['key']) && ($doc['byKey'][$rec['key']] ?? null) === $id) unset($doc['byKey'][$rec['key']]);
      }
    }
  });
}

function atlas_delivery_pending_count() {
  $n = 0;
  foreach (atlas_delivery_read()['deliveries'] as $rec) if (!in_array($rec['state'], ATLAS_DELIVERY_TERMINAL, true)) $n++;
  return $n;
}

// The HTTP answer for a finished email delivery. A delivery that was rolled
// back left the sender exactly as they were.
function atlas_answer_email_delivery($rec, $recipientEmail, $extra = []) {
  if ($rec !== null && ($rec['state'] ?? null) === 'delivered') {
    send_json(200, array_merge(['status' => 'email-transferred', 'to' => $recipientEmail], $extra));
  }
  $why = ($rec['lastError'] ?? null) ?: 'delivery was not completed';
  send_json(502, ['error' => 'could not deliver to ' . $recipientEmail . ': ' . $why]);
}
