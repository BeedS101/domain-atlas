<?php
// SPEC.md §13.3's inbound half — PHP port of issuer-server/server.js's
// sendPlainReply()/processEmailTicketForward()/pollEmailTicketsOnce().
// VERP-based bounce correlation (processInboundBounce, extractBounced
// TicketId, the pending-sends store) is its own later port — this file
// only forwards a ticket on CC, the same scope the Node side had before
// bounce monitoring was added to it.
//
// pollEmailTicketsOnce()'s PHP counterpart below has no background timer
// to live in at all (this bundle has no long-lived process — see
// atlas_email_tickets_config()'s own comment in lib/store.php) — it runs
// exactly once per call, driven entirely by atlas/admin/email-tickets/
// poll-now.php, itself meant to be cron-triggered in a real deployment.

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

  $recipientEmail = $parsed['cc'][0];
  $discardedOwnerKey = generate_discarded_owner_public_key();
  $minted = transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $discardedOwnerKey, $credential);

  try {
    atlas_smtp_send_mail([
      'host' => $config['smtpHost'],
      'port' => $config['smtpPort'],
      'secure' => $config['smtpSecure'],
      'user' => $config['smtpUser'],
      'pass' => $config['smtpPass'],
      'from' => $config['fromAddress'],
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
    atlas_revoke($minted['id'], 'issuer-request');
    send_plain_reply($config, $parsed['from'], 'Could not forward your ticket',
      "The new holder's address could not be delivered to, so this forward did not go through. Your original ticket is unaffected.");
    return ['outcome' => 'failed', 'reason' => $e->getMessage()];
  }

  atlas_revoke($credential['id'], 'email-transferred');
  archive_if_audited($credential, 'email-transferred');
  return ['outcome' => 'transferred', 'to' => $recipientEmail];
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
  $summary = ['checked' => 0, 'transferred' => 0, 'denied' => 0, 'failed' => 0, 'ignored' => 0];
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
        $result = process_email_ticket_forward($kp, $config, $parsed);
        if ($result['outcome'] === 'transferred') $summary['transferred']++;
        elseif ($result['outcome'] === 'denied') $summary['denied']++;
        elseif ($result['outcome'] === 'failed') $summary['failed']++;
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
