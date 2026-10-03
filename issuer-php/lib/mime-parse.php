<?php
// Minimal MIME parser for inbound mail, PHP port of
// issuer-server/lib-mime-parse.js — the receiving-side counterpart to
// lib/smtp.php's atlas_build_mime_message(). Parses exactly what
// SPEC.md §13.3 needs to read back out of a forwarded message: the
// From/To/Cc addresses and any attachment, decoded. Not a
// general-purpose parser — no RFC2047 encoded-word decoding for display
// names (only the bare address inside <...> or a bare address with no
// display name at all is ever extracted), no nested multipart/
// alternative handling beyond one level, no charset conversion beyond
// UTF-8/ASCII.

// Unfolds header continuation lines (RFC 5322: a line starting with
// whitespace is a continuation of the previous header) and splits the
// raw message into [headers (assoc array, lowercase keys), body] at the
// first blank line.
function atlas_mime_split_headers_and_body($raw) {
  $headerEnd = strpos($raw, "\r\n\r\n");
  $headerBlock = ($headerEnd === false) ? $raw : substr($raw, 0, $headerEnd);
  $body = ($headerEnd === false) ? '' : substr($raw, $headerEnd + 4);
  $lines = explode("\r\n", $headerBlock);
  $headers = [];
  $lastKey = null;
  foreach ($lines as $line) {
    if (preg_match('/^[ \t]/', $line) && $lastKey !== null) {
      $headers[$lastKey] = $headers[$lastKey] . ' ' . trim($line);
      continue;
    }
    $idx = strpos($line, ':');
    if ($idx === false) continue;
    $key = strtolower(trim(substr($line, 0, $idx)));
    $value = trim(substr($line, $idx + 1));
    $lastKey = $key;
    $headers[$key] = isset($headers[$key]) ? $headers[$key] . ', ' . $value : $value;
  }
  return [$headers, $body];
}

// Pulls every bare email address out of a header value — handles
// "Display Name <addr@host>", a bare "addr@host", and comma-separated
// lists of either, which is all §13.3's own CC-addressing rule ever
// needs (display names are discardable; only addresses matter for
// identifying recipients).
function atlas_mime_extract_addresses($headerValue) {
  if (!$headerValue) return [];
  if (!preg_match_all('/[^\s<>,"]+@[^\s<>,"]+/', $headerValue, $m)) return [];
  return array_map('strtolower', $m[0]);
}

function atlas_mime_decode_body($body, $encoding) {
  $enc = strtolower($encoding ?: '7bit');
  if ($enc === 'base64') return base64_decode(preg_replace('/\r?\n/', '', $body));
  if ($enc === 'quoted-printable') {
    $body = preg_replace('/=\r\n/', '', $body);
    return preg_replace_callback('/=([0-9A-Fa-f]{2})/', function ($mm) {
      return chr(hexdec($mm[1]));
    }, $body);
  }
  return $body; // 7bit/8bit — already plain text
}

function atlas_mime_parse_header_params($headerValue) {
  $params = [];
  $parts = explode(';', (string) $headerValue);
  for ($i = 1; $i < count($parts); $i++) {
    if (preg_match('/\s*([^=]+)=\s*"?([^"]*)"?\s*$/', $parts[$i], $m)) {
      $params[strtolower(trim($m[1]))] = $m[2];
    }
  }
  return $params;
}

// Splits a multipart body on its boundary and returns each part as
// [headers, body (raw, not yet decoded)]. One level only — a nested
// multipart part is returned as-is, raw, rather than recursed into,
// since nothing this feature sends or expects to receive nests more
// than one level deep (lib/smtp.php's own atlas_build_mime_message()
// never produces anything nested).
function atlas_mime_split_multipart($body, $boundary) {
  $marker = '--' . $boundary;
  $segments = explode($marker, $body);
  array_shift($segments); // drop the preamble before the first boundary
  array_pop($segments);    // drop the closing "--boundary--" tail
  return array_map(function ($seg) {
    $trimmed = preg_replace('/^\r\n/', '', $seg);
    $trimmed = preg_replace('/\r\n$/', '', $trimmed);
    return atlas_mime_split_headers_and_body($trimmed);
  }, $segments);
}

// atlas_parse_mime_message($raw) -> ['from', 'to', 'cc', 'subject',
//   'textBody', 'attachments' => [['filename', 'contentType', 'content']]]
// `content` is the fully decoded text of an attachment (this feature
// only ever attaches application/json, always text, never a genuinely
// binary payload, so decoding straight to a string is always correct
// here).
function atlas_parse_mime_message($raw) {
  [$headers, $body] = atlas_mime_split_headers_and_body($raw);
  $contentType = $headers['content-type'] ?? 'text/plain';
  $fromAddrs = atlas_mime_extract_addresses($headers['from'] ?? null);
  $result = [
    'from' => $fromAddrs[0] ?? null,
    'to' => atlas_mime_extract_addresses($headers['to'] ?? null),
    'cc' => atlas_mime_extract_addresses($headers['cc'] ?? null),
    'subject' => $headers['subject'] ?? '',
    'textBody' => '',
    'attachments' => [],
  ];

  if (!preg_match('#^multipart/#i', $contentType)) {
    $result['textBody'] = atlas_mime_decode_body($body, $headers['content-transfer-encoding'] ?? null);
    return $result;
  }

  $params = atlas_mime_parse_header_params($contentType);
  $boundary = $params['boundary'] ?? null;
  if (!$boundary) return $result;
  foreach (atlas_mime_split_multipart($body, $boundary) as [$partHeaders, $partBody]) {
    $partContentType = $partHeaders['content-type'] ?? 'text/plain';
    $disposition = $partHeaders['content-disposition'] ?? '';
    $paramsSrc = (strpos($disposition, 'filename') !== false) ? $disposition : $partContentType;
    $fileParams = atlas_mime_parse_header_params($paramsSrc);
    $filename = $fileParams['filename'] ?? null;
    $decoded = atlas_mime_decode_body($partBody, $partHeaders['content-transfer-encoding'] ?? null);
    if ($filename || preg_match('#^application/#i', $partContentType)) {
      $result['attachments'][] = [
        'filename' => $filename,
        'contentType' => trim(explode(';', $partContentType)[0]),
        'content' => $decoded,
      ];
    } elseif (preg_match('#^text/plain#i', $partContentType) && $result['textBody'] === '') {
      $result['textBody'] = $decoded;
    }
  }
  return $result;
}
