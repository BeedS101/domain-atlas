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
// Moderation (lib/moderation.php) reads the anonymous roster from these
// stores. To let a moderator see a presence avatar and a chat member of the
// same visit as one participant, each member may carry `visit`: a keyed hash of
// a per-visit random id the wallet supplies (never the raw id), plus `joinedAt`.
//
// A moderator's mute or kick (lib/restrictions.php) is enforced here: joins
// check for a kick and a chat send checks for a mute, both inside the store
// lock; a removed session's token is remembered so that its next poll is
// answered "removed" rather than "unknown, rejoin".
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
//
// Per-source abuse controls mirror presence-server/server.js (see "network
// sources" below): concurrent-session caps, a join-rate limit with an
// escalating cooldown, a per-source share of any one room, and the
// official-title name guard. A source is REMOTE_ADDR only, hashed with a
// secret kept in atlas-presence-ratelimit-store.json; forwarded-for headers
// are never read.

require_once __DIR__ . '/moderation.php';

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

// Per-source limits, env-overridable under the same names as the Node server.
define('PRESENCE_SOURCE_MAX_PRESENCE', (int) presence_env_number('SOURCE_MAX_PRESENCE', 30));
define('PRESENCE_SOURCE_MAX_PRESENCE_PER_ROOM', (int) presence_env_number('SOURCE_MAX_PRESENCE_PER_ROOM', 10));
define('PRESENCE_SOURCE_MAX_CHAT', (int) presence_env_number('SOURCE_MAX_CHAT', 20));
define('PRESENCE_SOURCE_MAX_CHAT_PER_DOMAIN', (int) presence_env_number('SOURCE_MAX_CHAT_PER_DOMAIN', 10));
define('PRESENCE_SOURCE_SOFT_FULL_RATIO', min(1.0, presence_env_number('SOURCE_SOFT_FULL_RATIO', 0.8)));
define('PRESENCE_SOURCE_SOFT_FULL_MAX', (int) presence_env_number('SOURCE_SOFT_FULL_MAX', 3));
define('PRESENCE_SOURCE_JOIN_MAX', (int) presence_env_number('SOURCE_JOIN_MAX', 60));
define('PRESENCE_SOURCE_JOIN_WINDOW_MS', presence_env_number('SOURCE_JOIN_WINDOW_MS', 60 * 1000));
define('PRESENCE_SOURCE_COOLDOWN_MS', presence_env_number('SOURCE_COOLDOWN_MS', 30 * 1000));
define('PRESENCE_SOURCE_COOLDOWN_MAX_MS', presence_env_number('SOURCE_COOLDOWN_MAX_MS', 5 * 60 * 1000));
define('PRESENCE_SOURCE_STRIKE_MEMORY_MS', presence_env_number('SOURCE_STRIKE_MEMORY_MS', 10 * 60 * 1000));
// Smaller default than the Node server: the whole table is rewritten per join.
require_once __DIR__ . '/restrictions.php';
define('PRESENCE_MAX_SOURCE_ENTRIES', (int) presence_env_number('MAX_SOURCE_ENTRIES', 2000));
define('PRESENCE_SALT_ROTATE_MS', presence_env_number('SOURCE_SALT_ROTATE_MS', 24 * 60 * 60 * 1000));

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

// ---------- network sources ----------
//
// Abuse limits are keyed on REMOTE_ADDR and nothing else; X-Forwarded-For and
// similar headers are client-controlled and are never read. Behind a reverse
// proxy or NAT every client shares one source, so the defaults are generous
// and an operator behind a proxy should raise them.
//
// The address is reduced to a key (IPv4 as is, IPv6 to its /64) and
// HMAC-hashed with a random secret. The hash is stored in two places only:
// on a member record for as long as that member exists (it is swept
// PRESENCE_POLL_TIMEOUT_MS after the last sync), and in the rate-limit table
// for as long as the join window or cooldown lasts. The raw address is never
// written. The secret rotates every PRESENCE_SALT_ROTATE_MS; the previous one
// is kept for one more period so sessions that outlive a rotation are still
// counted. Hashing a 32-bit address is obfuscation, not anonymisation: the
// protection is the short lifetime and that lib/ is not web-reachable.

function atlas_presence_ratelimit_file() {
  return __DIR__ . '/atlas-presence-ratelimit-store.json';
}

function presence_source_key_material($addr) {
  $a = strtolower(explode('%', (string) $addr)[0]);
  if (preg_match('/^::ffff:(\d+\.\d+\.\d+\.\d+)$/', $a, $m)) $a = $m[1];
  if (filter_var($a, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) return $a;
  if (filter_var($a, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false) {
    $bin = inet_pton($a);
    if ($bin === false || strlen($bin) !== 16) return 'unknown';
    if (substr($bin, 0, 12) === str_repeat("\0", 10) . "\xff\xff") return inet_ntop(substr($bin, 12)); // IPv4-mapped, hex spelling
    return bin2hex(substr($bin, 0, 8)) . '/64';
  }
  return 'unknown'; // unparseable peers all share one bucket
}

function presence_source_hash($addr, $salt) {
  return substr(hash_hmac('sha256', presence_source_key_material($addr), $salt), 0, 16);
}

function presence_empty_bucket() {
  return ['t' => [], 'cu' => 0, 'st' => 0, 'ls' => 0];
}

// Records one join attempt for this source and kind ('presence' | 'chat').
// Returns ['srcs' => [hash, ...], 'retryAfter' => null | seconds]. `srcs`
// lists the current hash first and the previous period's second; a member
// belongs to this source when its stored hash is in that list. Attempts made
// during a cooldown are refused without being recorded, so waiting it out
// always works.
function presence_source_gate($kind, $addr) {
  $fh = fopen(atlas_presence_ratelimit_file(), 'c+');
  if ($fh === false) throw new Exception('could not open the presence rate-limit store file');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc)) $doc = [];
  $now = presence_now_ms();
  if (!isset($doc['sources']) || !is_array($doc['sources'])) $doc['sources'] = [];
  if (!isset($doc['salt']) || !is_string($doc['salt']) || !isset($doc['saltAt']) || ($now - $doc['saltAt']) > PRESENCE_SALT_ROTATE_MS) {
    $doc['prevSalt'] = isset($doc['salt']) && is_string($doc['salt']) ? $doc['salt'] : null;
    $doc['salt'] = bin2hex(random_bytes(16));
    $doc['saltAt'] = $now;
    $doc['sources'] = []; // rate history is keyed by the old hash
  }
  $src = presence_source_hash($addr, $doc['salt']);
  $srcs = [$src];
  if (!empty($doc['prevSalt'])) $srcs[] = presence_source_hash($addr, $doc['prevSalt']);

  // Drop idle entries, then the least recently touched if still over the bound.
  foreach (array_keys($doc['sources']) as $k) {
    $e = $doc['sources'][$k];
    $idle = true;
    foreach (['presence', 'chat'] as $kk) {
      $b = isset($e[$kk]) ? $e[$kk] : presence_empty_bucket();
      $last = count($b['t']) ? $b['t'][count($b['t']) - 1] : 0;
      if ($b['cu'] > $now || $last > $now - PRESENCE_SOURCE_JOIN_WINDOW_MS || ($now - $b['ls']) <= PRESENCE_SOURCE_STRIKE_MEMORY_MS) $idle = false;
    }
    if ($idle && $k !== $src) unset($doc['sources'][$k]);
  }
  if (!isset($doc['sources'][$src])) {
    while (count($doc['sources']) >= PRESENCE_MAX_SOURCE_ENTRIES) {
      $oldest = null; $oldestAt = INF;
      foreach ($doc['sources'] as $k => $e) { $at = isset($e['touch']) ? $e['touch'] : 0; if ($at < $oldestAt) { $oldestAt = $at; $oldest = $k; } }
      if ($oldest === null) break;
      unset($doc['sources'][$oldest]);
    }
    $doc['sources'][$src] = ['presence' => presence_empty_bucket(), 'chat' => presence_empty_bucket()];
  }
  $ent = &$doc['sources'][$src];
  $ent['touch'] = $now;
  $b = &$ent[$kind];
  $retry = null;
  if ($b['cu'] > $now) {
    $retry = (int) ceil(($b['cu'] - $now) / 1000);
  } else {
    $cutoff = $now - PRESENCE_SOURCE_JOIN_WINDOW_MS;
    $b['t'] = array_values(array_filter($b['t'], function ($t) use ($cutoff) { return $t > $cutoff; }));
    $b['t'][] = $now;
    if (count($b['t']) > PRESENCE_SOURCE_JOIN_MAX) {
      $b['st'] = (($now - $b['ls']) > PRESENCE_SOURCE_STRIKE_MEMORY_MS ? 0 : $b['st']) + 1;
      $b['ls'] = $now;
      $cooldown = min(PRESENCE_SOURCE_COOLDOWN_MAX_MS, PRESENCE_SOURCE_COOLDOWN_MS * pow(2, $b['st'] - 1));
      $b['cu'] = $now + $cooldown;
      $b['t'] = [];
      $retry = (int) ceil($cooldown / 1000);
    }
  }
  unset($b, $ent);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return ['srcs' => $srcs, 'retryAfter' => $retry];
}

// Concurrency admission for one more session in a room whose members are
// $room (array or null). $totalMine is the source's session count across
// every room of this kind.
function presence_source_admission($mine, $totalMine, $roomSize, $capacity, $totalMax, $perRoomMax) {
  if ($totalMine >= $totalMax) return 'source-limit';
  if ($mine >= $perRoomMax) return 'source-limit';
  if ($roomSize >= $capacity * PRESENCE_SOURCE_SOFT_FULL_RATIO && $mine >= PRESENCE_SOURCE_SOFT_FULL_MAX) return 'source-limit';
  return null;
}

function presence_count_source($members, $srcs) {
  $n = 0;
  foreach ($members as $m) if (is_array($m) && isset($m['src']) && in_array($m['src'], $srcs, true)) $n++;
  return $n;
}

// Readable text for every refusal; the same wording as the Node server.
function presence_denial_text($reason) {
  $t = [
    'invalid' => 'A valid domain and world are required.',
    'server-busy' => 'The presence server is busy. Try again shortly.',
    'room-full' => 'This room is full right now. Try again in a moment.',
    'source-limit' => 'Too many sessions are already open from your network connection. Close other tabs or wait a few seconds, then try again.',
    'join-rate-limited' => 'Too many join attempts from your network connection. Wait a moment, then try again.',
    'removed' => 'A moderator has removed you from this world.',
    'name-not-allowed' => 'That display name looks like an official title (moderator, admin, staff, ...). Display names are not verified, so titles are not allowed. Choose a different name.'
  ];
  return isset($t[$reason]) ? $t[$reason] : $reason;
}

// ---------- display-name guard ----------
//
// A display name is typed by the visitor and nothing authenticates it. This
// guard refuses names that read as an official title or badge so that an
// ordinary visitor cannot present as "Moderator (official)". It is a nuisance
// filter, not identity verification: it misses disguises it does not know,
// and an allowed name proves nothing. A genuine moderator marker must be a
// separate field issued by the server, never text in the name. Same rules as
// nameLooksOfficial() in presence-server/server.js.

function presence_fold_name($raw) {
  $t = (string) $raw;
  if (class_exists('Normalizer') && getenv('PRESENCE_TEST_NO_INTL') !== '1') {
    $n = Normalizer::normalize($t, Normalizer::FORM_KD);
    if (is_string($n)) $t = $n;
  } else {
    $t = presence_fold_fallback($t); // no intl extension: table-based fold
  }
  $t = preg_replace('/\p{M}+/u', '', $t);
  $t = preg_replace('/[\p{Cf}\x{00ad}]/u', '', $t);
  $t = strtr($t, presence_confusables()); // before lowercasing, so both cases are listed
  return function_exists('mb_strtolower') ? mb_strtolower($t, 'UTF-8') : strtolower($t);
}

function presence_confusables() {
  static $map = null;
  if ($map !== null) return $map;
  $pairs = [
    'а' => 'a', 'е' => 'e', 'о' => 'o', 'р' => 'p', 'с' => 'c', 'у' => 'y', 'х' => 'x', 'і' => 'i', 'ѕ' => 's', 'ј' => 'j', 'ԁ' => 'd', 'ӏ' => 'i', 'ı' => 'i',
    'м' => 'm', 'т' => 't', 'н' => 'h', 'к' => 'k', 'в' => 'b', 'ո' => 'n', 'ս' => 'u', 'ɡ' => 'g', 'ɩ' => 'i',
    'α' => 'a', 'ε' => 'e', 'ι' => 'i', 'κ' => 'k', 'ν' => 'v', 'ο' => 'o', 'ρ' => 'p', 'τ' => 't', 'υ' => 'u', 'χ' => 'x', 'η' => 'n', 'μ' => 'u'
  ];
  $map = [];
  foreach ($pairs as $k => $v) {
    $map[$k] = $v;
    $upper = function_exists('mb_strtoupper') ? mb_strtoupper($k, 'UTF-8') : $k;
    if ($upper !== $k) $map[$upper] = $v;
  }
  return $map;
}

// Without the intl extension: fullwidth forms and common accented Latin
// letters, which NFKD would otherwise have reduced to a base letter.
function presence_fold_fallback($t) {
  $t = preg_replace_callback('/[\x{FF01}-\x{FF5E}]/u', function ($m) {
    $cp = mb_ord($m[0], 'UTF-8');
    return chr($cp - 0xFEE0);
  }, $t);
  static $acc = null;
  if ($acc === null) {
    $acc = [];
    $groups = ['a' => 'àáâãäåāăą', 'c' => 'çćĉċč', 'd' => 'ďđ', 'e' => 'èéêëēĕėęě', 'g' => 'ĝğġģ', 'h' => 'ĥħ', 'i' => 'ìíîïĩīĭįı', 'j' => 'ĵ', 'k' => 'ķ', 'l' => 'ĺļľŀł',
      'n' => 'ñńņňŉ', 'o' => 'òóôõöøōŏő', 'r' => 'ŕŗř', 's' => 'śŝşš', 't' => 'ţťŧ', 'u' => 'ùúûüũūŭůűų', 'w' => 'ŵ', 'y' => 'ýÿŷ', 'z' => 'źżž'];
    foreach ($groups as $base => $chars) {
      foreach (preg_split('//u', $chars, -1, PREG_SPLIT_NO_EMPTY) as $c) {
        $acc[$c] = $base;
        $up = function_exists('mb_strtoupper') ? mb_strtoupper($c, 'UTF-8') : $c;
        if ($up !== $c) $acc[$up] = strtoupper($base);
      }
    }
  }
  return strtr($t, $acc);
}

function presence_leet_collapse($s) {
  $s = strtr($s, ['0' => 'o', '1' => 'i', '3' => 'e', '4' => 'a', '5' => 's', '7' => 't', '@' => 'a', '$' => 's', '!' => 'i', '|' => 'i', 'l' => 'i']);
  $s = preg_replace('/[^a-z0-9]/', '', $s);
  return preg_replace('/(.)\1+/', '$1', $s);
}

function presence_name_looks_official($name, $domain = '') {
  static $tokens = null, $subs = null, $negated = null;
  if ($tokens === null) {
    $tokens = array_flip(array_map('presence_leet_collapse', ['mod', 'mods', 'admin', 'admins', 'gm', 'owner', 'staff', 'system', 'support', 'security', 'operator', 'verified', 'official', 'moderator', 'moderators', 'sysop', 'webmaster']));
    $subs = array_map('presence_leet_collapse', ['moderator', 'administrator', 'official', 'verified', 'sysop', 'webmaster', 'superuser', 'domainatlas']);
    $negated = array_map('presence_leet_collapse', ['unofficial', 'unverified']);
  }
  $name = (string) $name;
  $nfkc = (class_exists('Normalizer') && getenv('PRESENCE_TEST_NO_INTL') !== '1') ? Normalizer::normalize($name, Normalizer::FORM_KC) : $name;
  if (preg_match('/[\x{2713}\x{2714}\x{2705}\x{2611}\x{1F6E1}\x{1F530}]/u', is_string($nfkc) ? $nfkc : $name) === 1) return true;
  $folded = presence_fold_name($name);
  foreach (preg_split('/[^a-z0-9@$!|]+/', $folded, -1, PREG_SPLIT_NO_EMPTY) as $tok) {
    if (isset($tokens[presence_leet_collapse(preg_replace('/[0-9]+$/', '', $tok))])) return true;
  }
  $squash = presence_leet_collapse($folded);
  foreach ($negated as $n) $squash = str_replace($n, '', $squash);
  foreach ($subs as $w) if (strpos($squash, $w) !== false) return true;
  if (isset($tokens[$squash])) return true; // letters spread out with punctuation: "m.o.d"
  $dom = preg_replace('/^www/', '', presence_leet_collapse(presence_fold_name($domain)));
  if (strlen($dom) >= 5 && strpos($squash, $dom) !== false) return true;
  return false;
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

// Joins a new member. `$addr` is REMOTE_ADDR. Returns ['ok'=>true,
// 'token'=>..., 'publicId'=>..., 'roster'=>[...]] or ['ok'=>false,
// 'reason'=>..., 'retryAfter'=>?] with reason 'join-rate-limited',
// 'name-not-allowed', 'source-limit', 'room-full' or 'server-busy'. A refused
// join creates no member, so it never changes a room's count.
function presence_join($domain, $world, $name, $addr = '', $visit = null) {
  // A kicked visit cannot rejoin until the kick expires. Checked before the
  // source's join budget is touched, so a removed visitor retrying does not
  // push a shared network address into a cooldown for everyone behind it.
  $visitHash = moderation_visit_hash($domain, $world, $visit);
  $removed = restrictions_removed_answer($visitHash);
  if ($removed !== null) return $removed;
  $gate = presence_source_gate('presence', $addr);
  if ($gate['retryAfter'] !== null) return ['ok' => false, 'reason' => 'join-rate-limited', 'retryAfter' => $gate['retryAfter']];
  if (presence_name_looks_official($name, $domain)) return ['ok' => false, 'reason' => 'name-not-allowed'];
  $srcs = $gate['srcs'];
  return with_presence_store_locked(function (&$doc) use ($domain, $world, $name, $srcs, $visitHash) {
    // Checked again under the store lock: a kick sets its restriction before
    // it removes members, so a join that slipped past the check above is
    // either refused here or already a member the kick will remove.
    $removed = restrictions_removed_answer($visitHash);
    if ($removed !== null) return $removed;
    $roomKey = presence_room_key($domain, $world);
    $exists = isset($doc['rooms'][$roomKey]);
    $total = 0;
    foreach ($doc['rooms'] as $r) $total += presence_count_source($r, $srcs);
    $denied = presence_source_admission(
      $exists ? presence_count_source($doc['rooms'][$roomKey], $srcs) : 0, $total,
      $exists ? count($doc['rooms'][$roomKey]) : 0, PRESENCE_MAX_MEMBERS_PER_ROOM,
      PRESENCE_SOURCE_MAX_PRESENCE, PRESENCE_SOURCE_MAX_PRESENCE_PER_ROOM
    );
    if ($denied) return ['ok' => false, 'reason' => $denied];
    if (!$exists && count($doc['rooms']) >= PRESENCE_MAX_ROOMS) return ['ok' => false, 'reason' => 'server-busy'];
    if (presence_total_members($doc) >= PRESENCE_MAX_TOTAL_MEMBERS) return ['ok' => false, 'reason' => 'server-busy'];
    if ($exists && count($doc['rooms'][$roomKey]) >= PRESENCE_MAX_MEMBERS_PER_ROOM) return ['ok' => false, 'reason' => 'room-full'];
    if (!$exists) $doc['rooms'][$roomKey] = [];

    $token = presence_new_token();
    $publicId = presence_new_id();
    $roster = presence_roster_of($doc['rooms'][$roomKey], null);
    $doc['rooms'][$roomKey][$token] = [
      'publicId' => $publicId, 'name' => $name, 'x' => 0.0, 'y' => 0.0, 'z' => 0.0, 'yaw' => 0.0,
      'lastSeen' => presence_now_ms(), 'joinedAt' => presence_now_ms(), 'src' => $srcs[0]
    ];
    if ($visitHash !== null) $doc['rooms'][$roomKey][$token]['visit'] = $visitHash;
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

// Joins the chat room. `$addr` is REMOTE_ADDR. Returns ['ok'=>true,
// 'id'=>token, 'senderId'=>..., 'messages'=>history] or ['ok'=>false,
// 'reason'=>..., 'retryAfter'=>?] (the same reasons as presence_join). The new
// member's cursor starts at "already seen the history just handed back".
function chat_join_room($domain, $world, $name, $addr = '', $visit = null) {
  $visitHash = moderation_visit_hash($domain, $world, $visit);
  $removed = restrictions_removed_answer($visitHash);
  if ($removed !== null) return $removed;
  $gate = presence_source_gate('chat', $addr);
  if ($gate['retryAfter'] !== null) return ['ok' => false, 'reason' => 'join-rate-limited', 'retryAfter' => $gate['retryAfter']];
  if (presence_name_looks_official($name, $domain)) return ['ok' => false, 'reason' => 'name-not-allowed'];
  $srcs = $gate['srcs'];
  return with_chat_store_locked(function (&$doc) use ($domain, $world, $name, $srcs, $visitHash) {
    $removed = restrictions_removed_answer($visitHash);
    if ($removed !== null) return $removed;
    $exists = isset($doc['domains'][$domain]);
    $total = 0;
    foreach ($doc['domains'] as $d) $total += presence_count_source(isset($d['members']) ? $d['members'] : [], $srcs);
    $denied = presence_source_admission(
      $exists ? presence_count_source($doc['domains'][$domain]['members'], $srcs) : 0, $total,
      $exists ? count($doc['domains'][$domain]['members']) : 0, PRESENCE_MAX_CHAT_MEMBERS_PER_DOMAIN,
      PRESENCE_SOURCE_MAX_CHAT, PRESENCE_SOURCE_MAX_CHAT_PER_DOMAIN
    );
    if ($denied) return ['ok' => false, 'reason' => $denied];
    if (!$exists && count($doc['domains']) >= PRESENCE_MAX_CHAT_DOMAINS) return ['ok' => false, 'reason' => 'server-busy'];
    if ($exists && count($doc['domains'][$domain]['members']) >= PRESENCE_MAX_CHAT_MEMBERS_PER_DOMAIN) return ['ok' => false, 'reason' => 'room-full'];
    if (!$exists) $doc['domains'][$domain] = ['nextSeq' => 0, 'history' => [], 'members' => []];
    $entry = &$doc['domains'][$domain];
    $token = presence_new_token();
    $senderId = presence_new_id();
    $lastSeq = count($entry['history']) ? $entry['history'][count($entry['history']) - 1]['seq'] : 0;
    $entry['members'][$token] = [
      'name' => $name, 'senderId' => $senderId, 'world' => $world,
      'lastSeen' => presence_now_ms(), 'cursor' => $lastSeq, 'lastSendAt' => 0, 'joinedAt' => presence_now_ms(), 'src' => $srcs[0]
    ];
    if ($visitHash !== null) $entry['members'][$token]['visit'] = $visitHash;
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
// 'reason'|'message']. Reasons: 'muted' (with cause, message, retryAfter) |
// 'rate-limited' | 'empty' | 'blocked'.
function chat_send_message($token, $textRaw) {
  return with_chat_store_locked(function (&$doc) use ($token, $textRaw) {
    foreach ($doc['domains'] as $domain => &$entry) {
      if (!isset($entry['members'][$token])) continue;
      $member = &$entry['members'][$token];
      $now = presence_now_ms();
      $member['lastSeen'] = $now;
      // Enforced here, under the store lock, for every send. A muted visit's
      // send is refused before anything else is looked at, so it also leaves
      // the rate-limit clock alone.
      $muted = restrictions_muted_answer(!empty($member['visit']) ? $member['visit'] : 'c:' . $token);
      if ($muted !== null) { unset($member, $entry); return ['found' => true, 'ok' => false] + $muted; }
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
