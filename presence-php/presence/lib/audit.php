<?php
// Domain Atlas — PHP presence: private moderation audit log. The PHP
// counterpart of presence-server/lib-audit.js, with the same fields, bounds and
// visibility rule.
//
// One JSON line per moderation request that reached a verified grant, written by
// moderation_serve() in lib/moderation.php, the only code the moderation
// endpoints share, so no endpoint can act without being recorded.
//
// What an entry holds (nothing else is ever stored):
//   seq, t (ISO time), domain, world, operation, moderatorRef (the issuer's
//   pseudonymous reference, not a wallet key), role (admin | moderator, as the
//   issuer's status statement states it), grantId (a reference, not a
//   credential), target (the temporary participant reference), durationSeconds,
//   cause (a fixed code), outcome (success | refused | failed) and code.
// Never stored: wallet keys, signatures, tokens, ephemeral keys, request nonces,
// visit ids, network addresses, display names or chat text.
//
// The file lives in this folder (lib/.htaccess denies it to the web), is created
// mode 0600, and is bounded by size and age. Writers take an exclusive lock on
// the file itself, so concurrent requests append whole lines in order. Each
// entry carries the hash of the one before it, so edits or deletions inside the
// file are detectable. That is NOT tamper-proofing: whoever can rewrite the file
// can rewrite the whole chain. Only a head hash copied somewhere this host
// cannot change (integrity.head in a read) makes truncation or a full rewrite
// detectable.
//
// Lock order: the presence or chat store lock, then the moderation state lock,
// then this file's lock (innermost); this file never takes another lock while
// holding its own.

define('AUDIT_MAX_BYTES', (int) moderation_env_number('MODERATION_AUDIT_MAX_BYTES', 1024 * 1024));
define('AUDIT_RETENTION_MS', moderation_env_number('MODERATION_AUDIT_RETENTION_DAYS', 90) * 24 * 60 * 60 * 1000);
// Refusals recorded per moderator per window; the rest are summarised by one
// "audit-throttled" entry, so a stolen grant cannot flood the log.
define('AUDIT_REFUSALS_PER_WINDOW', (int) moderation_env_number('MODERATION_AUDIT_REFUSALS_PER_MIN', 10));
define('AUDIT_REFUSAL_WINDOW_MS', moderation_env_number('MODERATION_AUDIT_REFUSAL_WINDOW_MS', 60 * 1000));
define('AUDIT_VIEW_LIMIT', (int) moderation_env_number('MODERATION_AUDIT_VIEW_LIMIT', 200));
define('AUDIT_MAX_THROTTLE_MODERATORS', 5000);

function audit_file() {
  $e = getenv('PRESENCE_MODERATION_AUDIT_FILE');
  return ($e !== false && $e !== '') ? $e : __DIR__ . '/atlas-presence-moderation-audit.jsonl';
}

function audit_chain_hash($prev, $entry) {
  return moderation_b64url_encode(hash('sha256', $prev . "\n" . moderation_canonicalize($entry), true));
}

function audit_sanitize($e) {
  $str = function ($k, $re, $max = 255) use ($e) { return isset($e[$k]) && is_string($e[$k]) && strlen($e[$k]) <= $max && preg_match($re, $e[$k]) === 1 ? $e[$k] : null; };
  return [
    'domain' => isset($e['domain']) && is_string($e['domain']) ? substr($e['domain'], 0, 255) : '',
    'world' => isset($e['world']) && is_string($e['world']) && strlen($e['world']) <= 480 ? $e['world'] : null,
    'operation' => $str('operation', '/^[a-z]+\.[a-z]+$/'),
    'moderatorRef' => $str('moderatorRef', '/^[A-Za-z0-9_-]{43}$/'),
    'role' => isset($e['role']) && in_array($e['role'], ['admin', 'moderator'], true) ? $e['role'] : null,
    'grantId' => $str('grantId', '/^[A-Za-z0-9_-]{22}$/'),
    'target' => $str('target', '/^[A-Za-z0-9_-]{22}$/'),
    'durationSeconds' => isset($e['durationSeconds']) && is_int($e['durationSeconds']) && $e['durationSeconds'] > 0 ? $e['durationSeconds'] : null,
    'cause' => isset($e['cause']) && in_array($e['cause'], MODERATION_CAUSES, true) ? $e['cause'] : null,
    'outcome' => isset($e['outcome']) && in_array($e['outcome'], ['success', 'refused', 'failed'], true) ? $e['outcome'] : 'failed',
    'code' => $str('code', '/^[a-z0-9-]{1,48}$/') ?: 'unknown',
  ];
}

function audit_parse($line) {
  $o = json_decode($line, true);
  return is_array($o) && moderation_is_object($o) ? $o : null;
}

// Opens the log, locks it exclusively and calls $fn($fh). Creates it mode 0600.
function audit_locked($fn) {
  $path = audit_file();
  $fresh = !file_exists($path);
  $fh = fopen($path, 'c+');
  if ($fh === false) throw new Exception('could not open the audit log');
  flock($fh, LOCK_EX);
  if ($fresh) @chmod($path, 0600);
  try {
    return $fn($fh);
  } finally {
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
  }
}
function audit_read_all($fh) {
  rewind($fh);
  return (string) stream_get_contents($fh);
}

// Can an entry be appended right now? Commands are refused when it cannot, so a
// state change is never made without being able to record it.
function audit_writable() {
  try { return audit_locked(function ($fh) { return true; }); } catch (Exception $e) { return false; } catch (Error $e) { return false; }
}

// Rewrites the file keeping only entries inside the retention period and, when
// over the size bound, only the newest ones that fit in 80% of it. A base line
// carries the position and hash of the last dropped entry, so the chain of the
// rest still verifies.
function audit_compact($fh, $text, $now) {
  $base = null;
  $entries = [];
  foreach (explode("\n", $text) as $line) {
    if ($line === '') continue;
    $o = audit_parse($line);
    if ($o !== null && isset($o['base'])) { $base = ['seq' => $o['base']['seq'], 'h' => $o['base']['h']]; continue; }
    $entries[] = ['line' => $line, 'o' => $o];
  }
  $n = count($entries);
  $start = 0;
  while ($start < $n && $entries[$start]['o'] !== null && isset($entries[$start]['o']['t']) && moderation_strict_iso($entries[$start]['o']['t']) !== null && moderation_strict_iso($entries[$start]['o']['t']) < $now - AUDIT_RETENTION_MS) $start++;
  $bytes = 0;
  for ($i = $start; $i < $n; $i++) $bytes += strlen($entries[$i]['line']) + 1;
  while ($n - $start > 1 && $bytes > AUDIT_MAX_BYTES * 0.8) { $bytes -= strlen($entries[$start]['line']) + 1; $start++; }
  if ($start > 0) {
    $last = $entries[$start - 1]['o'];
    if ($last !== null && isset($last['seq'], $last['h']) && is_int($last['seq']) && is_string($last['h'])) $base = ['seq' => $last['seq'], 'h' => $last['h']];
  }
  $out = $base ? json_encode(['base' => $base], JSON_UNESCAPED_SLASHES) . "\n" : '';
  for ($i = $start; $i < $n; $i++) $out .= $entries[$i]['line'] . "\n";
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, $out);
}

// 'yes' | 'note' | 'no': may this refusal be recorded?
function audit_refusal_verdict($ref, $now) {
  return moderation_state_locked(function (&$doc) use ($ref, $now) {
    if (!isset($doc['auditRefusals']) || !is_array($doc['auditRefusals'])) $doc['auditRefusals'] = [];
    $r = isset($doc['auditRefusals'][$ref]) ? $doc['auditRefusals'][$ref] : null;
    if ($r === null || $now - $r['start'] >= AUDIT_REFUSAL_WINDOW_MS) {
      $r = ['start' => $now, 'count' => 0, 'noted' => false];
      unset($doc['auditRefusals'][$ref]);
    }
    $r['count']++;
    $verdict = 'yes';
    if ($r['count'] > AUDIT_REFUSALS_PER_WINDOW) {
      if (!$r['noted']) { $r['noted'] = true; $verdict = 'note'; } else $verdict = 'no';
    }
    $doc['auditRefusals'][$ref] = $r;
    while (count($doc['auditRefusals']) > AUDIT_MAX_THROTTLE_MODERATORS) { reset($doc['auditRefusals']); unset($doc['auditRefusals'][key($doc['auditRefusals'])]); }
    return $verdict;
  });
}

// Appends one entry. Returns true when it was written (or deliberately
// throttled), false when the file could not be written.
function audit_record($e) {
  $now = moderation_now_ms();
  $entry = audit_sanitize($e);
  if ($entry['domain'] === '') return false;
  try {
    if ($entry['outcome'] === 'refused') {
      $verdict = $entry['moderatorRef'] !== null ? audit_refusal_verdict($entry['moderatorRef'], $now) : 'yes';
      if ($verdict === 'no') return true;
      if ($verdict === 'note') { $entry['code'] = 'audit-throttled'; $entry['operation'] = null; $entry['target'] = null; $entry['durationSeconds'] = null; $entry['cause'] = null; }
    }
    return audit_locked(function ($fh) use ($entry, $now) {
      $stat = fstat($fh);
      $size = (int) $stat['size'];
      $text = '';
      $seq = 0; $prev = ''; $endsNl = true;
      if ($size > 0) {
        $len = min($size, 16384);
        fseek($fh, $size - $len);
        $tailText = (string) fread($fh, $len);
        $endsNl = substr($tailText, -1) === "\n";
        if ($len < $size) $tailText = substr($tailText, (int) strpos($tailText, "\n") + 1);
        $lines = array_values(array_filter(explode("\n", $tailText), function ($l) { return $l !== ''; }));
        for ($i = count($lines) - 1; $i >= 0; $i--) {
          $o = audit_parse($lines[$i]);
          if ($o === null) continue;
          if (isset($o['base']['seq'], $o['base']['h'])) { $seq = $o['base']['seq']; $prev = $o['base']['h']; break; }
          if (isset($o['seq'], $o['h']) && is_int($o['seq']) && is_string($o['h'])) { $seq = $o['seq']; $prev = $o['h']; break; }
        }
      }
      $body = ['seq' => $seq + 1, 't' => moderation_iso($now)] + $entry;
      $body['h'] = audit_chain_hash($prev, $body);
      fseek($fh, 0, SEEK_END);
      fwrite($fh, ($endsNl ? '' : "\n") . json_encode($body, JSON_UNESCAPED_SLASHES) . "\n");
      $oldest = null;
      if ($size > 0) {
        rewind($fh);
        $head = (string) fread($fh, 8192);
        foreach (explode("\n", $head) as $l) { $o = $l === '' ? null : audit_parse($l); if ($o !== null && !isset($o['base'])) { $oldest = $o; break; } }
      }
      $tooOld = $oldest !== null && isset($oldest['t']) && moderation_strict_iso($oldest['t']) !== null && moderation_strict_iso($oldest['t']) < $now - AUDIT_RETENTION_MS;
      if ($size > AUDIT_MAX_BYTES || $tooOld) audit_compact($fh, audit_read_all($fh), $now);
      return true;
    });
  } catch (Exception $ex) { return false; } catch (Error $ex) { return false; }
}

// The entries a viewer may see: the same domain, and the requested world (an
// entry with no world, such as a refusal before the request was trusted, only to
// a viewer whose scope is every world). Newest first.
function audit_read($domain, $world, $allWorlds) {
  $text = '';
  try { $text = audit_locked(function ($fh) { return audit_read_all($fh); }); } catch (Exception $e) { $text = ''; }
  $prev = ''; $lastSeq = null; $status = 'ok'; $total = 0; $badSeq = null;
  $visible = [];
  foreach (explode("\n", $text) as $line) {
    if ($line === '') continue;
    $o = audit_parse($line);
    if ($o === null) { if ($status === 'ok') { $status = 'broken'; $badSeq = $lastSeq === null ? null : $lastSeq + 1; } continue; }
    if (isset($o['base'])) {
      if ($lastSeq === null && isset($o['base']['seq'], $o['base']['h']) && is_int($o['base']['seq']) && is_string($o['base']['h'])) { $prev = $o['base']['h']; $lastSeq = $o['base']['seq']; }
      elseif ($status === 'ok') $status = 'broken';
      continue;
    }
    $total++;
    $h = isset($o['h']) ? $o['h'] : null;
    $rest = $o; unset($rest['h']);
    $nextSeq = $lastSeq === null ? 1 : $lastSeq + 1;
    if ($status === 'ok' && ($h !== audit_chain_hash($prev, $rest) || !isset($o['seq']) || $o['seq'] !== $nextSeq)) { $status = 'broken'; $badSeq = isset($o['seq']) ? $o['seq'] : null; }
    if (is_string($h)) $prev = $h;
    if (isset($o['seq']) && is_int($o['seq'])) $lastSeq = $o['seq'];
    $ow = array_key_exists('world', $o) ? $o['world'] : null;
    if (isset($o['domain']) && $o['domain'] === $domain && ($ow === $world || ($ow === null && $allWorlds))) $visible[] = $rest;
  }
  $visible = array_reverse($visible);
  $entries = array_slice($visible, 0, AUDIT_VIEW_LIMIT);
  return [
    'entries' => $entries,
    'truncated' => count($visible) > count($entries),
    'integrity' => ['chain' => $status, 'entries' => $total, 'lastSeq' => $lastSeq, 'head' => $prev !== '' ? $prev : null, 'firstBadSeq' => $badSeq],
    'retention' => ['maxBytes' => AUDIT_MAX_BYTES, 'maxAgeDays' => (int) round(AUDIT_RETENTION_MS / 86400000)],
  ];
}
