<?php
// Domain Atlas — PHP presence: temporary moderation restrictions. The PHP
// counterpart of presence-server/lib-restrictions.js, with the same rules and
// the same visitor-facing texts.
//
// Holds what a moderator's mute and kick leave behind, in one JSON file
// (atlas-presence-restrictions.json, next to this file, not web-reachable):
// private to this service, never reaching a wallet, credential or Post Office
// membership, never published. Everything expires on its own and is bounded.
//
//   mutes - chat.mute: the visit may not send chat messages until `until`.
//   kicks - session.kick: the visit may not join presence or chat again until
//           `until`. (The sessions themselves are removed by the command.)
//   tombs - what a kicked polling session's connection token gets back instead
//           of "unknown id": a clear "removed" answer, so the client does not
//           read the missing session as a sweep and silently rejoin.
//
// A restriction is keyed by the keyed visit hash (moderation_visit_hash:
// domain + world + the wallet's per-visit random id), so it covers exactly one
// visit to one world on one domain. A chat session without a visit id is
// keyed by its own connection token (`c:<token>`): a mute follows that
// session only.
//
// Lock order: the presence or chat store lock first, this file's lock last
// (innermost). Nothing here ever takes a store lock.

define('RESTRICTIONS_MAX', (int) presence_env_number('MODERATION_MAX_RESTRICTIONS', 2000));
define('RESTRICTIONS_MAX_PER_ROOM', (int) presence_env_number('MODERATION_MAX_RESTRICTIONS_PER_WORLD', 200));
define('RESTRICTIONS_MAX_TOMBS', (int) presence_env_number('MODERATION_MAX_TOMBSTONES', 5000));

function atlas_presence_restrictions_file() {
  return __DIR__ . '/atlas-presence-restrictions.json';
}

// Runs $fn(&$doc) with the file locked and expired entries dropped. Whatever
// $fn leaves in $doc is written back.
function restrictions_locked($fn) {
  $fh = fopen(atlas_presence_restrictions_file(), 'c+');
  if ($fh === false) throw new Exception('could not open the restrictions file');
  flock($fh, LOCK_EX);
  $doc = json_decode((string) stream_get_contents($fh), true);
  if (!is_array($doc)) $doc = [];
  $now = moderation_now_ms();
  foreach (['mutes', 'kicks', 'tombs'] as $k) {
    if (!isset($doc[$k]) || !is_array($doc[$k])) $doc[$k] = [];
    foreach (array_keys($doc[$k]) as $key) if (!is_array($doc[$k][$key]) || !isset($doc[$k][$key]['until']) || $doc[$k][$key]['until'] <= $now) unset($doc[$k][$key]);
  }
  $result = $fn($doc, $now);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}

// ---------- visitor-facing text, by fixed cause code ----------

function restrictions_causes() {
  return ['spam', 'abuse', 'harassment', 'inappropriate', 'disruption', 'other'];
}
function restrictions_cause_label($cause) {
  $t = [
    'spam' => 'spam',
    'abuse' => 'abusive behaviour',
    'harassment' => 'harassment',
    'inappropriate' => 'inappropriate content',
    'disruption' => 'disruption',
    'other' => 'a breach of the rules of this world'
  ];
  return isset($t[$cause]) ? $t[$cause] : $t['other'];
}
function restrictions_human_duration($seconds) {
  $s = max(1, (int) ceil($seconds));
  if ($s < 60) return $s . ($s === 1 ? ' second' : ' seconds');
  if ($s < 3600) { $m = (int) ceil($s / 60); return $m . ($m === 1 ? ' minute' : ' minutes'); }
  $h = (int) ceil($s / 3600);
  return $h . ($h === 1 ? ' hour' : ' hours');
}
function restrictions_mute_message($untilMs, $cause, $now) {
  return 'A moderator has muted you in this world (' . restrictions_cause_label($cause) . '). Time remaining: ' . restrictions_human_duration(($untilMs - $now) / 1000) . '. You can still look around and read chat.';
}
function restrictions_kick_message($untilMs, $cause, $now) {
  return 'A moderator has removed you from this world (' . restrictions_cause_label($cause) . '). You can rejoin in ' . restrictions_human_duration(($untilMs - $now) / 1000) . '.';
}
function restrictions_retry_after($untilMs, $now) {
  return max(1, (int) ceil(($untilMs - $now) / 1000));
}

// ---------- reads ----------

function restrictions_get($kind, $key) {
  if ($key === null || $key === '') return null;
  return restrictions_locked(function (&$doc) use ($kind, $key) {
    return isset($doc[$kind][$key]) ? $doc[$kind][$key] : null;
  });
}
// The key a mute on a chat session with no visit id is stored under. A hash,
// so the state file never holds a token that could be used to speak as that session.
function restrictions_token_key($token) { return 'c:' . hash('sha256', "atlas-restriction-token/v1\n" . (string) $token); }
function restrictions_mute_of($key) { return restrictions_get('mutes', $key); }
function restrictions_kick_of($key) { return restrictions_get('kicks', $key); }
function restrictions_tomb_of($token) { return restrictions_get('tombs', (string) $token); }

// The refusal a kicked visit gets when it tries to join again, or null.
function restrictions_removed_answer($visitHash) {
  if ($visitHash === null) return null;
  $kick = restrictions_kick_of($visitHash);
  if ($kick === null) return null;
  $now = moderation_now_ms();
  return [
    'ok' => false, 'reason' => 'removed', 'cause' => $kick['cause'],
    'message' => restrictions_kick_message($kick['until'], $kick['cause'], $now),
    'retryAfter' => restrictions_retry_after($kick['until'], $now)
  ];
}

// The refusal a muted visit gets when it tries to send chat, or null.
function restrictions_muted_answer($key) {
  $mute = restrictions_mute_of($key);
  if ($mute === null) return null;
  $now = moderation_now_ms();
  return [
    'reason' => 'muted', 'cause' => $mute['cause'],
    'message' => restrictions_mute_message($mute['until'], $mute['cause'], $now),
    'retryAfter' => restrictions_retry_after($mute['until'], $now)
  ];
}

// ---------- writes ----------

// Returns 'ok' or 'full'. Replacing an existing entry for the same key never
// counts against the bounds.
function restrictions_put($kind, $key, $room, $until, $cause) {
  return restrictions_locked(function (&$doc) use ($kind, $key, $room, $until, $cause) {
    if (!isset($doc[$kind][$key])) {
      if (count($doc['mutes']) + count($doc['kicks']) >= RESTRICTIONS_MAX) return 'full';
      $inRoom = 0;
      foreach (['mutes', 'kicks'] as $k) foreach ($doc[$k] as $e) if (isset($e['room']) && $e['room'] === $room) $inRoom++;
      if ($inRoom >= RESTRICTIONS_MAX_PER_ROOM) return 'full';
    }
    $doc[$kind][$key] = ['until' => $until, 'cause' => $cause, 'room' => $room];
    return 'ok';
  });
}
function restrictions_set_mute($key, $room, $until, $cause) { return restrictions_put('mutes', $key, $room, $until, $cause); }
function restrictions_set_kick($key, $room, $until, $cause) { return restrictions_put('kicks', $key, $room, $until, $cause); }
function restrictions_clear_mute($key) {
  return restrictions_locked(function (&$doc) use ($key) {
    $had = isset($doc['mutes'][$key]);
    unset($doc['mutes'][$key]);
    return $had;
  });
}
// Marks polling tokens as removed. $tokens: token => scope ('presence'|'chat').
function restrictions_add_tombs($tokens, $until, $cause) {
  if (!$tokens) return;
  restrictions_locked(function (&$doc) use ($tokens, $until, $cause) {
    foreach ($tokens as $token => $scope) {
      unset($doc['tombs'][(string) $token]);
      $doc['tombs'][(string) $token] = ['until' => $until, 'cause' => $cause, 'scope' => $scope];
    }
    while (count($doc['tombs']) > RESTRICTIONS_MAX_TOMBS) { reset($doc['tombs']); unset($doc['tombs'][key($doc['tombs'])]); }
  });
}
