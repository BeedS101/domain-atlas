<?php
// Hand-rolled SMTP client, PHP port of issuer-server/lib-smtp.js — same
// zero-dependency philosophy this whole bundle already runs on (no
// composer, nothing to install on a shared host), same protocol surface:
// a plain connect or STARTTLS, AUTH LOGIN, and a multipart/mixed message
// carrying a text body plus attachments. Not a general-purpose mail
// library — no AUTH PLAIN/CRAM-MD5, no 8BITMIME, no pipelining, no retry
// policy. A real SMTP conversation, one line at a time, nothing more than
// SPEC.md §13 actually needs.

// SMTP replies are line-oriented, and a multi-line reply (EHLO's own
// capability list is the common case) marks every line but the last with
// a '-' in the 4th column instead of a space — this keeps reading lines
// until that final line arrives, rather than assuming the first line read
// is the whole reply.
function atlas_smtp_read_reply($socket) {
  $lines = [];
  $raw = '';
  while (!feof($socket)) {
    $line = fgets($socket, 1024);
    if ($line === false) break;
    $raw .= $line;
    $lines[] = rtrim($line, "\r\n");
    if (strlen($line) >= 4 && ctype_digit(substr($line, 0, 3)) && $line[3] === ' ') break;
  }
  if (empty($lines)) throw new Exception('SMTP connection closed unexpectedly');
  $last = $lines[count($lines) - 1];
  return ['code' => (int) substr($last, 0, 3), 'lines' => $lines, 'raw' => $raw];
}

function atlas_smtp_command($socket, $line, $expectCode = null) {
  if ($line !== null) fwrite($socket, $line . "\r\n");
  $reply = atlas_smtp_read_reply($socket);
  if ($expectCode !== null) {
    $expected = is_array($expectCode) ? $expectCode : [$expectCode];
    if (!in_array($reply['code'], $expected, true)) {
      throw new Exception('SMTP command "' . ($line === null ? '(connect)' : $line) . '" got ' . $reply['code'] . ': ' . trim($reply['raw']));
    }
  }
  return $reply;
}

// DATA's own escaping rule: a body line that begins with "." must get a
// second "." prepended, or a receiving server reads it as the end-of-data
// marker and silently truncates the message right there.
function atlas_smtp_dot_stuff($body) {
  $body = preg_replace('/\r\n\./', "\r\n..", $body);
  return preg_replace('/^\./', '..', $body);
}

// A plain-text body plus zero or more attachments, multipart/mixed, 7bit
// for the text part and base64 for every attachment — the minimal shape
// SPEC.md §13.2 needs. Mirrors lib-smtp.js's own buildMimeMessage().
function atlas_build_mime_message($opts) {
  $boundary = '----atlas-' . bin2hex(random_bytes(16));
  $headers = [
    'From: ' . $opts['from'],
    'To: ' . $opts['to'],
    'Subject: ' . $opts['subject'],
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' . $boundary . '"',
  ];
  foreach (($opts['extraHeaders'] ?? []) as $h) $headers[] = $h;

  $parts = [];
  $textBody = preg_replace('/\r?\n/', "\r\n", $opts['textBody']);
  $parts[] = '--' . $boundary . "\r\n" .
    "Content-Type: text/plain; charset=utf-8\r\n" .
    "Content-Transfer-Encoding: 7bit\r\n\r\n" .
    $textBody . "\r\n";
  foreach (($opts['attachments'] ?? []) as $att) {
    $b64 = chunk_split(base64_encode($att['content']), 76, "\r\n");
    $parts[] = '--' . $boundary . "\r\n" .
      'Content-Type: ' . $att['contentType'] . '; name="' . $att['filename'] . "\"\r\n" .
      'Content-Disposition: attachment; filename="' . $att['filename'] . "\"\r\n" .
      "Content-Transfer-Encoding: base64\r\n\r\n" .
      $b64 . "\r\n";
  }
  $parts[] = '--' . $boundary . "--\r\n";
  return implode("\r\n", $headers) . "\r\n\r\n" . implode('', $parts);
}

// atlas_smtp_send_mail(['host', 'port', 'secure', 'user', 'pass', 'from',
//   'to', 'envelopeFrom', 'subject', 'textBody', 'attachments'])
//
// secure: 'tls' (connection is encrypted from the first byte, e.g. port
// 465) | 'starttls' (plain connect, then upgrade mid-conversation, e.g.
// port 587) | 'none' (never do this against a real mail server — only
// exists so test/manual-*.js can point this at a local, unencrypted fake
// SMTP server without needing a throwaway TLS certificate).
//
// `envelopeFrom`, when given, becomes the MAIL FROM address instead of
// `from` — distinct from the visible From: header, same distinction every
// real MTA already draws, and the hook SPEC.md §13.3's own VERP bounce
// correlation sets per-send.
function atlas_smtp_send_mail($opts) {
  $transport = ($opts['secure'] === 'tls') ? 'ssl' : 'tcp';
  $socket = @stream_socket_client($transport . '://' . $opts['host'] . ':' . $opts['port'], $errno, $errstr, 10);
  if (!$socket) throw new Exception('could not connect to ' . $opts['host'] . ':' . $opts['port'] . ' (' . $errstr . ')');
  stream_set_timeout($socket, 10);

  $ehloName = 'localhost';

  atlas_smtp_command($socket, null, 220); // server greeting
  atlas_smtp_command($socket, 'EHLO ' . $ehloName, 250);

  if ($opts['secure'] === 'starttls') {
    atlas_smtp_command($socket, 'STARTTLS', 220);
    if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
      throw new Exception('STARTTLS upgrade to ' . $opts['host'] . ' failed');
    }
    atlas_smtp_command($socket, 'EHLO ' . $ehloName, 250);
  }

  if (!empty($opts['user'])) {
    atlas_smtp_command($socket, 'AUTH LOGIN', 334);
    atlas_smtp_command($socket, base64_encode($opts['user']), 334);
    atlas_smtp_command($socket, base64_encode($opts['pass']), 235);
  }

  $envelopeFrom = $opts['envelopeFrom'] ?? $opts['from'];
  atlas_smtp_command($socket, 'MAIL FROM:<' . $envelopeFrom . '>', 250);
  atlas_smtp_command($socket, 'RCPT TO:<' . $opts['to'] . '>', [250, 251]);
  atlas_smtp_command($socket, 'DATA', 354);

  $message = atlas_build_mime_message($opts);
  fwrite($socket, atlas_smtp_dot_stuff($message) . "\r\n.\r\n");
  $dataReply = atlas_smtp_read_reply($socket);
  if ($dataReply['code'] !== 250) throw new Exception('message not accepted: ' . trim($dataReply['raw']));

  try {
    atlas_smtp_command($socket, 'QUIT', 221);
  } catch (Exception $e) {
    // best-effort — a send that was already accepted (250 above) is
    // already a success regardless of how cleanly QUIT itself goes
  }
  fclose($socket);
  return ['accepted' => true];
}

// Sends a freshly minted ticket to an address as a MIME attachment
// (SPEC.md §13.2). Throws when the mail server does not accept it.
function atlas_mail_ticket_to($minted, $recipientEmail) {
  $config = atlas_email_tickets_config();
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
}
