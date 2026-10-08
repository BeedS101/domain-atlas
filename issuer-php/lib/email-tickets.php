<?php
// SPEC.md §13.3's inbound half — PHP port of issuer-server/server.js's
// sendPlainReply()/verpReturnPathFor()/extractBouncedTicketId()/
// processEmailTicketForward()/processInboundBounce()/
// pollEmailTicketsOnce().
//
// poll_email_tickets_once() below has no background timer to live in at
// all (this bundle has no long-lived process — see
// atlas_email_tickets_config()'s own comment in lib/store.php) — it runs
// exactly once per call, driven entirely by atlas/admin/email-tickets/
// poll-now.php, itself meant to be cron-triggered in a real deployment.

// A unique per-send envelope Return-Path so a later bounce can be
// correlated back to the exact send that produced it, without ever
// having to parse a bounce body (which varies too much across mail
// servers to parse reliably). Built from this domain's own configured
// fromAddress — `localpart+bounce-<ticketId>@domain` — rather than a
// separate address, so the bounce is guaranteed to land in the exact
// same mailbox poll_email_tickets_once() already watches, under
// ordinary mail-provider "+" sub-addressing.
function verp_return_path_for($config, $ticketId) {
  $at = strpos($config['fromAddress'], '@');
  $localPart = substr($config['fromAddress'], 0, $at);
  $domainPart = substr($config['fromAddress'], $at + 1);
  return $localPart . '+bounce-' . substr($ticketId, strrpos($ticketId, ':') + 1) . '@' . $domainPart;
}

// The other half of verp_return_path_for() — recognizes one of this
// domain's own VERP addresses among an inbound message's "To" recipients
// and recovers the ticket id it names, or null if this message isn't a
// correlated bounce at all.
function extract_bounced_ticket_id($config, $parsed) {
  if (!$config['fromAddress'] || strpos($config['fromAddress'], '@') === false) return null;
  $at = strpos($config['fromAddress'], '@');
  $prefix = strtolower(substr($config['fromAddress'], 0, $at) . '+bounce-');
  $suffix = strtolower('@' . substr($config['fromAddress'], $at + 1));
  foreach ($parsed['to'] as $addr) {
    if (strpos($addr, $prefix) === 0 && substr($addr, -strlen($suffix)) === $suffix) {
      return 'urn:atlas:asset:' . substr($addr, strlen($prefix), strlen($addr) - strlen($prefix) - strlen($suffix));
    }
  }
  return null;
}

// A no-attachment reply, for the denial/failure notices a forward
// attempt can produce below. Reuses the same outbound SMTP settings as
// the wallet-to-email send; best-effort only — a reply that fails to
// send is swallowed, not retried or surfaced as an error of its own.
function send_plain_reply($config, $to, $subject, $textBody) {
  if (!$config['smtpHost'] || !$config['fromAddress']) return;
  try {
    atlas_smtp_send_mail([
      'host' => $config['smtpHost'],
      'port' => $config['smtpPort'],
      'secure' => $config['smtpSecure'],
      'user' => $config['smtpUser'],
      'pass' => $config['smtpPass'],
      'from' => $config['fromAddress'],
      'to' => $to,
      'subject' => $subject,
      'textBody' => $textBody,
    ]);
  } catch (Exception $e) {
    // best-effort — see comment above
  }
}

// The forward-to-transfer mechanics for one already-parsed inbound
// message: possession passes on by forwarding the original delivery
// email with the new holder CC'd, the attachment (not the reply body)
// carrying the credential. Mint-then-send-then-revoke, same delivery-
// check-before-finalizing discipline as transfer-to-email.php — a
// rejected send leaves the forwarded-from credential completely
// untouched. Never throws for an ordinary bad forward; a denial here is
// a reply email, not an exception.
function process_email_ticket_forward($kp, $config, $parsed) {
  $credential = null;
  foreach ($parsed['attachments'] as $att) {
    if ($att['contentType'] !== 'application/json') continue;
    $candidate = json_decode($att['content'], true);
    if (!is_array($candidate)) continue;
    if (($candidate['credential'] ?? null) === 'domain-atlas-asset/1.0' &&
        ($candidate['issuer']['domain'] ?? null) === atlas_domain()) {
      $credential = $candidate;
      break;
    }
  }
  if (!$credential) return ['outcome' => 'ignored', 'reason' => 'no recognized ticket attachment'];

  $signatureOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
  if (!$signatureOk) return ['outcome' => 'ignored', 'reason' => 'attached credential does not check out'];

  // Deliberately redacted — never names the real current holder or
  // destination back to whoever forwarded a stale copy, the same posture
  // the mail-check endpoint already takes for anything it won't confirm.
  if (is_revoked($credential['id'])) {
    send_plain_reply($config, $parsed['from'], 'Could not forward your ticket',
      'This ticket has already moved on and can no longer be forwarded from this message.');
    return ['outcome' => 'denied', 'reason' => 'already-transferred'];
  }

  if (count($parsed['cc']) === 0) return ['outcome' => 'ignored', 'reason' => 'no CC recipient named'];

  if (count($parsed['cc']) > 1) {
    send_plain_reply($config, $parsed['from'], 'Could not forward your ticket',
      'This ticket can only be forwarded to one new holder at a time — CC exactly one address next time.');
    return ['outcome' => 'denied', 'reason' => 'more-than-one-cc'];
  }

  // Only a credential this domain itself minted as an email ticket is
  // forwardable (SPEC.md §13.3): it is listed in the bearer registry when
  // it is minted. An ordinary wallet credential is a public claim anyone
  // can copy, so a valid signature alone must never move it. Taking the
  // entry also makes two forwards of one ticket mutually exclusive. No
  // reply is sent: answering would tell a stranger which credential ids
  // this domain has issued as tickets.
  $taken = take_bearer($credential['id']);
  if (!$taken) return ['outcome' => 'ignored', 'reason' => 'attached credential is not an email ticket'];

  $recipientEmail = $parsed['cc'][0];
  try {
    $discardedOwnerKey = generate_discarded_owner_public_key();
    $minted = transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $discardedOwnerKey, $credential);
  } catch (Exception $e) {
    restore_bearer($credential['id'], $taken);
    throw $e;
  }
  register_bearer($minted['id'], $taken['class'] ?? null);

  try {
    atlas_smtp_send_mail([
      'host' => $config['smtpHost'],
      'port' => $config['smtpPort'],
      'secure' => $config['smtpSecure'],
      'user' => $config['smtpUser'],
      'pass' => $config['smtpPass'],
      'from' => $config['fromAddress'],
      // SPEC.md §13.3's VERP — a bounce against THIS send, arriving any
      // time after this poll pass, carries this exact Return-Path back
      // to the mailbox poll_email_tickets_once() watches, letting it be
      // correlated to $minted['id'] without parsing the bounce body.
      'envelopeFrom' => verp_return_path_for($config, $minted['id']),
      'to' => $recipientEmail,
      'subject' => $minted['asset']['name'] ?? 'Your ticket',
      'textBody' => 'You have been sent "' . ($minted['asset']['name'] ?? $minted['asset']['class']) . '" from ' . atlas_domain() .
        ".\n\nThe attached file is your ticket. Keep it safe — forwarding this email, with the new holder CC'd, is how you pass it on.",
      'attachments' => [[
        'filename' => 'ticket-' . substr($minted['id'], strrpos($minted['id'], ':') + 1) . '.json',
        'contentType' => 'application/json',
        'content' => json_encode($minted, JSON_UNESCAPED_SLASHES),
      ]],
    ]);
  } catch (Exception $e) {
    take_bearer($minted['id']);
    atlas_revoke($minted['id'], 'issuer-request');
    restore_bearer($credential['id'], $taken);
    send_plain_reply($config, $parsed['from'], 'Could not forward your ticket',
      "The new holder's address could not be delivered to, so this forward did not go through. Your original ticket is unaffected.");
    return ['outcome' => 'failed', 'reason' => $e->getMessage()];
  }

  // Acceptance here only means the recipient's mail server took the
  // message, not that it actually reached an inbox — recorded as still
  // in flight so a bounce arriving later can still be traced back to
  // this exact send and reversed (process_inbound_bounce, below).
  record_pending_email_ticket_send($minted, $parsed['from']);
  atlas_revoke($credential['id'], 'email-transferred');
  archive_if_audited($credential, 'email-transferred');
  return ['outcome' => 'transferred', 'to' => $recipientEmail];
}

// SPEC.md §13.3's "ongoing bounce monitoring" — handles one inbound
// message already identified (by extract_bounced_ticket_id(), in
// poll_email_tickets_once() below) as a correlated bounce against
// $ticketId. A credential already resolved some other way (or with no
// matching in-flight record at all — a stale or forged bounce) is left
// alone rather than acted on, the same "only touch what's genuinely
// still live" posture process_email_ticket_forward()'s own is_revoked()
// check already takes.
function process_inbound_bounce($kp, $config, $ticketId) {
  $pending = find_pending_email_ticket_send($ticketId);
  if (!$pending || is_revoked($ticketId)) {
    if ($pending) remove_pending_email_ticket_send($ticketId);
    return ['outcome' => 'ignored', 'reason' => 'no matching in-flight send'];
  }

  atlas_revoke($ticketId, 'bounced');
  remove_pending_email_ticket_send($ticketId);

  $discardedOwnerKey = generate_discarded_owner_public_key();
  $replacement = transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $discardedOwnerKey, $pending['credential']);
  register_bearer($replacement['id'], $replacement['asset']['class'] ?? null);

  try {
    atlas_smtp_send_mail([
      'host' => $config['smtpHost'],
      'port' => $config['smtpPort'],
      'secure' => $config['smtpSecure'],
      'user' => $config['smtpUser'],
      'pass' => $config['smtpPass'],
      'from' => $config['fromAddress'],
      'envelopeFrom' => verp_return_path_for($config, $replacement['id']),
      'to' => $pending['returnToAddress'],
      'subject' => $replacement['asset']['name'] ?? 'Your ticket',
      // Never names the address delivery actually failed to reach —
      // the same "never name the address the ticket actually went to"
      // rule applied here for the identical reason.
      'textBody' => "This ticket was returned to you because delivery to the address you sent it to failed.\n\n" .
        "The attached file is your ticket again — forwarding this email, with the new holder CC'd, is how you pass it on.",
      'attachments' => [[
        'filename' => 'ticket-' . substr($replacement['id'], strrpos($replacement['id'], ':') + 1) . '.json',
        'contentType' => 'application/json',
        'content' => json_encode($replacement, JSON_UNESCAPED_SLASHES),
      ]],
    ]);
  } catch (Exception $e) {
    // The reissue itself couldn't be delivered either — nothing left to
    // revoke back to ($pending['credential']'s own trail already ends
    // at $ticketId, revoked above), so this is logged by the caller's
    // summary rather than retried further.
    take_bearer($replacement['id']);
    atlas_revoke($replacement['id'], 'issuer-request');
    return ['outcome' => 'failed', 'reason' => $e->getMessage()];
  }

  return ['outcome' => 'bounced', 'to' => $pending['returnToAddress']];
}

// Checks the mailbox once and processes every unseen message found,
// returning a short summary. Sequential by message, not parallel: a
// second forward naming the same credential within the same pass needs
// the first forward's atlas_revoke() to have already landed before it's
// evaluated, so is_revoked() correctly denies the replay instead of
// racing it. This is the entire inbound mechanism this bundle has — no
// background timer, just this one synchronous pass, called from
// atlas/admin/email-tickets/poll-now.php.
function poll_email_tickets_once($kp, $config) {
  if (!$config['imapHost']) return ['skipped' => true];
  $summary = ['checked' => 0, 'transferred' => 0, 'denied' => 0, 'failed' => 0, 'ignored' => 0, 'bounced' => 0];
  $client = atlas_imap_connect([
    'host' => $config['imapHost'],
    'port' => $config['imapPort'],
    'secure' => $config['imapSecure'],
    'user' => $config['imapUser'],
    'pass' => $config['imapPass'],
  ]);
  try {
    $unseen = $client->searchUnseen();
    foreach ($unseen as $seq) {
      $summary['checked']++;
      try {
        $raw = $client->fetchRfc822($seq);
        $parsed = atlas_parse_mime_message($raw);
        // A correlated bounce (SPEC.md §13.3) is checked for before ever
        // treating this message as a forward — a real bounce (DSN)
        // rarely carries this domain's own ticket attachment at all, so
        // falling through to process_email_ticket_forward() for one
        // would just land on the ordinary "no recognized ticket
        // attachment" no-op anyway, but checking the Return-Path match
        // first is more direct about what's actually being recognized
        // here.
        $bouncedTicketId = extract_bounced_ticket_id($config, $parsed);
        $result = $bouncedTicketId
          ? process_inbound_bounce($kp, $config, $bouncedTicketId)
          : process_email_ticket_forward($kp, $config, $parsed);
        if ($result['outcome'] === 'transferred') $summary['transferred']++;
        elseif ($result['outcome'] === 'denied') $summary['denied']++;
        elseif ($result['outcome'] === 'failed') $summary['failed']++;
        elseif ($result['outcome'] === 'bounced') $summary['bounced']++;
        else $summary['ignored']++;
      } catch (Exception $e) {
        $summary['failed']++;
      }
      $client->markSeen($seq);
    }
  } finally {
    $client->logout();
  }
  return $summary;
}
