<?php
// Domain Atlas — PHP presence: room/roster and chat storage. This is the PHP
// port of presence-server/server.js's polling routes, for a real
// shared-hosting deployment.
//
// Presence carries no wallet identity. A member is a display name, a pose and
// an avatar look. Two random ids per member, deliberately different:
//   - publicId: broadcast to the room, used by clients to track an avatar.
//   - the connection token (the key of the member in the store): never
//     broadcast; it is the bearer secret the client presents to sync and
//     leave.
// There is no duplicate-session detection and no friend signalling: a new
// connection is a new, unrelated participant, and a display name is not
// authenticated.
//
// This bundle ONLY EVER implements polling — there is no PHP equivalent of
// the Node server's WebSocket half. WebSocket needs a persistent process
// bound to a port, which plain cPanel/Apache+PHP shared hosting cannot run
// (see issuer-php/README.txt for the same constraint on the issuer).
// extension/viewer.js tries WebSocket first regardless of backend and falls
// back to polling on its own when that fails.
//
// All room state lives in ONE JSON file (atlas-presence-store.json, next to
// this file — not web-reachable), read-modify-written under an exclusive
// flock on every request. Fine at demo / small-site scale; a busy site would
// want a real datastore.
//
// Retention: every locked write sweeps ALL rooms (stale members dropped,
// empty rooms deleted), not just the room being touched, so no visitor
// record outlives PRESENCE_POLL_TIMEOUT_MS by more than the next request to
// this bundle. Records written by an earlier version of this bundle may
// still carry publicKey / pendingSignals fields; they are stripped when the
// store is loaded.

function atlas_presence_store_file() {
  return __DIR__ . '/atlas-presence-store.json';
}

function presence_env_number($name, $default) {
  $v = getenv($name);
  return ($v !== false && is_numeric($v) && (float) $v > 0) ? (float) $v : $default;
}

// Loose sanity bounds, matching presence-server/server.js.
const PRESENCE_MAX_NAME_LEN = 60;
const PRESENCE_MAX_ID_LEN = 120; // domain / world strings
const PRESENCE_MAX_COORD = 100000;
const PRESENCE_MAX_COLOR_LEN = 16;
const PRESENCE_MAX_SHOE_SCALE = 10;

// Resource bounds, env-overridable under the same names as the Node server.
define('PRESENCE_MAX_ROOMS', (int) presence_env_number('MAX_ROOMS', 500));
define('PRESENCE_MAX_MEMBERS_PER_ROOM', (int) presence_env_number('MAX_MEMBERS_PER_ROOM', 100));
define('PRESENCE_MAX_TOTAL_MEMBERS', (int) presence_env_number('MAX_TOTAL_MEMBERS', 2000));
define('PRESENCE_MAX_CHAT_DOMAINS', (int) presence_env_number('MAX_CHAT_DOMAINS', 500));
define('PRESENCE_MAX_CHAT_MEMBERS_PER_DOMAIN', (int) presence_env_number('MAX_CHAT_MEMBERS_PER_DOMAIN', 200));
define('PRESENCE_MAX_BODY_BYTES', (int) presence_env_number('MAX_BODY_BYTES', 8 * 1024));

// More generous than the Node server's POLL_TIMEOUT_MS default (8000): a
// real request over the public internet to shared hosting is slower and less
// predictable than loopback.
define('PRESENCE_POLL_TIMEOUT_MS', presence_env_number('POLL_TIMEOUT_MS', 15000));

function presence_now_ms() {
  return microtime(true) * 1000;
}

function presence_new_id() {
  return bin2hex(random_bytes(8));
}

function presence_new_token() {
  return bin2hex(random_bytes(16));
}

// Domain and world strings come from a manifest and name a room; they are
// not validated against anything real. World ids are free-form in the
// manifest, so only length, encoding and control characters are restricted —
// the value is only ever used as an array key. Returns the string, or null.
function presence_clean_id($raw) {
  if (!is_string($raw)) return null;
  $s = trim($raw);
  $len = strlen($s);
  if ($len < 1 || $len > PRESENCE_MAX_ID_LEN) return null;
  if (preg_match('//u', $s) !== 1) return null;
  if (preg_match('/[\x00-\x1f\x7f]|\x{2028}|\x{2029}/u', $s) === 1) return null;
  return $s;
}

// A display name is free text announced by the client: strip control
// characters, trim, bound the length, keep it valid UTF-8. Not an identity.
function presence_clean_name($raw) {
  $s = is_string($raw) ? $raw : '';
  if ($s !== '' && preg_match('//u', $s) !== 1) $s = '';
  $s = trim(preg_replace('/[\x00-\x1f\x7f]/', '', $s));
  if (function_exists('mb_substr')) $s = mb_substr($s, 0, PRESENCE_MAX_NAME_LEN, 'UTF-8');
  else $s = substr($s, 0, PRESENCE_MAX_NAME_LEN);
  if ($s !== '' && preg_match('//u', $s) !== 1) $s = '';
  return $s === '' ? 'Visitor' : $s;
}

function presence_sanitize_color($v) {
  return is_string($v) ? substr($v, 0, PRESENCE_MAX_COLOR_LEN) : null;
}

function presence_sanitize_scale($v) {
  $n = is_numeric($v) ? (float) $v : null;
  return ($n !== null && $n > 0 && $n <= PRESENCE_MAX_SHOE_SCALE) ? $n : null;
}

// JSON decode never produces NaN/Infinity, so is_int/is_float is enough.
function presence_num($v) {
  return (is_int($v) || is_float($v)) ? (float) $v : null;
}

function presence_room_key($domain, $world) {
  return $domain . '::' . $world;
}

// Removes members that haven't synced in PRESENCE_POLL_TIMEOUT_MS, from
// every room, and deletes rooms left empty. Also removes fields earlier
// versions of this bundle stored (see the header note).
function presence_sweep_all(&$doc) {
  $now = presence_now_ms();
  foreach (array_keys($doc['rooms']) as $roomKey) {
    if (!is_array($doc['rooms'][$roomKey])) { unset($doc['rooms'][$roomKey]); continue; }
    foreach (array_keys($doc['rooms'][$roomKey]) as $token) {
      $member = $doc['rooms'][$roomKey][$token];
      if (!is_array($member) || ($now - (isset($member['lastSeen']) ? $member['lastSeen'] : 0)) > PRESENCE_POLL_TIMEOUT_MS) {
        unset($doc['rooms'][$roomKey][$token]);
        continue;
      }
      unset($doc['rooms'][$roomKey][$token]['publicKey'], $doc['rooms'][$roomKey][$token]['pendingSignals'], $doc['rooms'][$roomKey][$token]['lastActivityAt']);
      if (!isset($doc['rooms'][$roomKey][$token]['publicId'])) $doc['rooms'][$roomKey][$token]['publicId'] = presence_new_id();
    }
    if (count($doc['rooms'][$roomKey]) === 0) unset($doc['rooms'][$roomKey]);
  }
  unset($doc['challenges'], $doc['duplicateJoinLosses']);
}

function presence_total_members($doc) {
  $n = 0;
  foreach ($doc['rooms'] as $room) $n += count($room);
  return $n;
}

function presence_roster_of($room, $exceptToken) {
  $roster = [];
  foreach ($room as $token => $member) {
    if ((string) $token === (string) $exceptToken) continue;
    $roster[] = [
      'id' => $member['publicId'], 'name' => $member['name'], 'x' => $member['x'], 'y' => $member['y'], 'z' => $member['z'], 'yaw' => $member['yaw'],
      'shirtColor' => isset($member['shirtColor']) ? $member['shirtColor'] : null,
      'pantsColor' => isset($member['pantsColor']) ? $member['pantsColor'] : null,
      'hatColor' => isset($member['hatColor']) ? $member['hatColor'] : null,
      'shoeColor' => isset($member['shoeColor']) ? $member['shoeColor'] : null,
      'shoeScale' => isset($member['shoeScale']) ? $member['shoeScale'] : null
    ];
  }
  return $roster;
}

// Opens the store under an exclusive lock, decodes it, sweeps it, lets
// $mutator read/modify $doc (by reference) and compute a return value, then
// writes the whole thing back before releasing the lock.
function with_presence_store_locked($mutator) {
  $fh = fopen(atlas_presence_store_file(), 'c+');
  if ($fh === false) throw new Exception('could not open the presence store file');
  flock($fh, LOCK_EX);
  $raw = stream_get_contents($fh);
  $doc = json_decode($raw, true);
  if (!is_array($doc)) $doc = [];
  if (!isset($doc['rooms']) || !is_array($doc['rooms'])) $doc['rooms'] = [];
  presence_sweep_all($doc);
  $result = $mutator($doc);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}

// Joins a new member. Returns ['ok'=>true, 'token'=>..., 'publicId'=>...,
// 'roster'=>[...]] or ['ok'=>false, 'reason'=>'room-full'|'server-busy'].
function presence_join($domain, $world, $name) {
  return with_presence_store_locked(function (&$doc) use ($domain, $world, $name) {
    $roomKey = presence_room_key($domain, $world);
    $exists = isset($doc['rooms'][$roomKey]);
    if (!$exists && count($doc['rooms']) >= PRESENCE_MAX_ROOMS) return ['ok' => false, 'reason' => 'server-busy'];
    if (presence_total_members($doc) >= PRESENCE_MAX_TOTAL_MEMBERS) return ['ok' => false, 'reason' => 'server-busy'];
    if ($exists && count($doc['rooms'][$roomKey]) >= PRESENCE_MAX_MEMBERS_PER_ROOM) return ['ok' => false, 'reason' => 'room-full'];
    if (!$exists) $doc['rooms'][$roomKey] = [];

    $token = presence_new_token();
    $publicId = presence_new_id();
    $roster = presence_roster_of($doc['rooms'][$roomKey], null);
    $doc['rooms'][$roomKey][$token] = [
      'publicId' => $publicId, 'name' => $name, 'x' => 0.0, 'y' => 0.0, 'z' => 0.0, 'yaw' => 0.0,
      'lastSeen' => presence_now_ms()
    ];
    return ['ok' => true, 'token' => $token, 'publicId' => $publicId, 'roster' => $roster];
  });
}

// ---------- in-world chat ----------
//
// A SEPARATE store file (atlas-chat-store.json, same lib/ folder, same
// deny-all .htaccess) from presence: chat is keyed by domain alone (every
// visitor anywhere in a domain shares one chat room, each message tagged with
// the world it came from), not by domain+world, and its own file keeps a
// busy chat from locking out presence's move/sync traffic.
//
// A chat member is a display name and a random per-join senderId. The
// senderId lets a client mute or block a sender for as long as that sender
// stays joined; it is not an identity and nothing proves who is behind a
// name. Messages carry no wallet key. Abuse control is the per-member send
// interval, the length cap, the word filter and the member/domain caps.
//
// History is bounded by count (CHAT_HISTORY_LIMIT) and by age
// (CHAT_HISTORY_TTL_MS, default 24 h). Every locked write sweeps ALL
// domains. A chat poll member has no live connection to push to, so it
// carries a `cursor` — the seq of the newest message already delivered.
function atlas_chat_store_file() {
  return __DIR__ . '/atlas-chat-store.json';
}

define('CHAT_HISTORY_LIMIT', (int) presence_env_number('CHAT_HISTORY_LIMIT', 50));
define('CHAT_HISTORY_TTL_MS', presence_env_number('CHAT_HISTORY_TTL_MS', 24 * 60 * 60 * 1000));
define('CHAT_MIN_INTERVAL_MS', presence_env_number('CHAT_MIN_INTERVAL_MS', 400));
const MAX_CHAT_TEXT_LEN = 500;

// Same blocklist / leetspeak normalization / space-preserving substring
// match as presence-server.js's chatTextContainsBlockedWord (duplicated, each
// bundle is self-contained). The server copy is authoritative since a client
// can skip its own check.
const CHAT_BLOCKLIST = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dick', 'piss',
  'slut', 'whore', 'fag', 'nigger', 'nigga', 'retard', 'rape'
];
function chat_normalize_for_filter($text) {
  $s = strtolower((string) $text);
  $s = strtr($s, ['0' => 'o', '1' => 'i', '!' => 'i', '3' => 'e', '4' => 'a', '5' => 's', '@' => 'a', '$' => 's']);
  $s = preg_replace('/[^a-z0-9]+/', ' ', $s);
  return trim($s);
}
function chat_text_contains_blocked_word($text) {
  $normalized = chat_normalize_for_filter($text);
  if ($normalized === '') return false;
  foreach (CHAT_BLOCKLIST as $word) {
    if (strpos($normalized, $word) !== false) return true;
  }
  return false;
}

function chat_clean_text($raw) {
  $s = is_string($raw) ? $raw : '';
  if ($s !== '' && preg_match('//u', $s) !== 1) return '';
  $s = trim(preg_replace('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/', '', $s));
  if (function_exists('mb_substr')) $s = mb_substr($s, 0, MAX_CHAT_TEXT_LEN, 'UTF-8');
  else $s = substr($s, 0, MAX_CHAT_TEXT_LEN);
  return preg_match('//u', $s) === 1 ? $s : '';
}

// Sweeps every domain: stale members dropped, history trimmed by age and
// count, domains with neither members nor history deleted. Also strips the
// publicKey fields earlier versions of this bundle stored.
function chat_sweep_all(&$doc) {
  $now = presence_now_ms();
  foreach (array_keys($doc['domains']) as $domain) {
    if (!is_array($doc['domains'][$domain])) { unset($doc['domains'][$domain]); continue; }
    $entry = $doc['domains'][$domain];
    $members = isset($entry['members']) && is_array($entry['members']) ? $entry['members'] : [];
    foreach (array_keys($members) as $token) {
      $m = $members[$token];
      if (!is_array($m) || ($now - (isset($m['lastSeen']) ? $m['lastSeen'] : 0)) > PRESENCE_POLL_TIMEOUT_MS) { unset($members[$token]); continue; }
      unset($members[$token]['publicKey']);
      if (!isset($members[$token]['senderId'])) $members[$token]['senderId'] = presence_new_id();
    }
    $history = [];
    $cutoff = ($now / 1000) - (CHAT_HISTORY_TTL_MS / 1000);
    foreach ((isset($entry['history']) && is_array($entry['history']) ? $entry['history'] : []) as $msg) {
      if (!is_array($msg)) continue;
      $t = isset($msg['sentAt']) ? strtotime($msg['sentAt']) : false;
      if ($t === false || $t < $cutoff) continue;
      unset($msg['publicKey']);
      if (!isset($msg['senderId'])) $msg['senderId'] = '';
      $history[] = $msg;
    }
    if (count($history) > CHAT_HISTORY_LIMIT) $history = array_slice($history, -CHAT_HISTORY_LIMIT);
    if (count($members) === 0 && count($history) === 0) { unset($doc['domains'][$domain]); continue; }
    $doc['domains'][$domain] = [
      'nextSeq' => isset($entry['nextSeq']) ? (int) $entry['nextSeq'] : 0,
      'history' => $history,
      'members' => $members
    ];
  }
}

function with_chat_store_locked($mutator) {
  $fh = fopen(atlas_chat_store_file(), 'c+');
  if ($fh === false) throw new Exception('could not open the chat store file');
  flock($fh, LOCK_EX);
  $raw = stream_get_contents($fh);
  $doc = json_decode($raw, true);
  if (!is_array($doc)) $doc = [];
  if (!isset($doc['domains']) || !is_array($doc['domains'])) $doc['domains'] = [];
  chat_sweep_all($doc);
  $result = $mutator($doc);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}

// Joins the chat room. Returns ['ok'=>true, 'id'=>token, 'senderId'=>...,
// 'messages'=>history] or ['ok'=>false, 'reason'=>...]. The new member's
// cursor starts at "already seen the history just handed back".
function chat_join_room($domain, $world, $name) {
  return with_chat_store_locked(function (&$doc) use ($domain, $world, $name) {
    $exists = isset($doc['domains'][$domain]);
    if (!$exists && count($doc['domains']) >= PRESENCE_MAX_CHAT_DOMAINS) return ['ok' => false, 'reason' => 'server-busy'];
    if ($exists && count($doc['domains'][$domain]['members']) >= PRESENCE_MAX_CHAT_MEMBERS_PER_DOMAIN) return ['ok' => false, 'reason' => 'room-full'];
    if (!$exists) $doc['domains'][$domain] = ['nextSeq' => 0, 'history' => [], 'members' => []];
    $entry = &$doc['domains'][$domain];
    $token = presence_new_token();
    $senderId = presence_new_id();
    $lastSeq = count($entry['history']) ? $entry['history'][count($entry['history']) - 1]['seq'] : 0;
    $entry['members'][$token] = [
      'name' => $name, 'senderId' => $senderId, 'world' => $world,
      'lastSeen' => presence_now_ms(), 'cursor' => $lastSeq, 'lastSendAt' => 0
    ];
    $history = $entry['history'];
    unset($entry);
    return ['ok' => true, 'id' => $token, 'senderId' => $senderId, 'messages' => $history];
  });
}

// Polling sync: bumps lastSeen and returns every history entry newer than
// the member's cursor, advancing the cursor to match.
function chat_sync_member($token) {
  return with_chat_store_locked(function (&$doc) use ($token) {
    foreach ($doc['domains'] as $domain => &$entry) {
      if (!isset($entry['members'][$token])) continue;
      $entry['members'][$token]['lastSeen'] = presence_now_ms();
      $cursor = $entry['members'][$token]['cursor'];
      $delta = array_values(array_filter($entry['history'], function ($m) use ($cursor) { return $m['seq'] > $cursor; }));
      if (count($delta)) $entry['members'][$token]['cursor'] = $delta[count($delta) - 1]['seq'];
      unset($entry);
      return ['found' => true, 'messages' => $delta];
    }
    unset($entry);
    return ['found' => false];
  });
}

// Validates and appends a chat send from a joined member. Returns
// ['found'=>false] for an unknown token, else ['found'=>true, 'ok'=>bool,
// 'reason'|'message']. Reasons: 'rate-limited' | 'empty' | 'blocked'.
function chat_send_message($token, $textRaw) {
  return with_chat_store_locked(function (&$doc) use ($token, $textRaw) {
    foreach ($doc['domains'] as $domain => &$entry) {
      if (!isset($entry['members'][$token])) continue;
      $member = &$entry['members'][$token];
      $now = presence_now_ms();
      $member['lastSeen'] = $now;
      if (($now - (isset($member['lastSendAt']) ? $member['lastSendAt'] : 0)) < CHAT_MIN_INTERVAL_MS) { unset($member, $entry); return ['found' => true, 'ok' => false, 'reason' => 'rate-limited']; }
      $text = chat_clean_text($textRaw);
      if ($text === '') { unset($member, $entry); return ['found' => true, 'ok' => false, 'reason' => 'empty']; }
      if (chat_text_contains_blocked_word($text)) { unset($member, $entry); return ['found' => true, 'ok' => false, 'reason' => 'blocked']; }
      $member['lastSendAt'] = $now;

      $seq = $entry['nextSeq'] + 1;
      $entry['nextSeq'] = $seq;
      $message = [
        'seq' => $seq, 'id' => presence_new_id(), 'senderId' => $member['senderId'], 'world' => $member['world'],
        'name' => $member['name'], 'text' => $text, 'sentAt' => gmdate('Y-m-d\TH:i:s\Z')
      ];
      $entry['history'][] = $message;
      if (count($entry['history']) > CHAT_HISTORY_LIMIT) $entry['history'] = array_slice($entry['history'], -CHAT_HISTORY_LIMIT);
      $member['cursor'] = $seq;
      unset($member, $entry);
      return ['found' => true, 'ok' => true, 'message' => $message];
    }
    unset($entry);
    return ['found' => false];
  });
}

// Best-effort explicit leave. Silent no-op for an unknown token.
function chat_leave_room($token) {
  if ($token === '') return;
  with_chat_store_locked(function (&$doc) use ($token) {
    foreach ($doc['domains'] as $domain => &$entry) {
      if (isset($entry['members'][$token])) { unset($entry['members'][$token]); break; }
    }
    unset($entry);
    return null;
  });
}
