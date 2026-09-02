<?php
// Domain Atlas — PHP presence: room/roster storage. This is the PHP port of
// presence-server/server.js's /presence/poll/* routes (task #68) — the
// piece flagged as follow-up work when the polling fallback was first
// built, now filled in for the real evtec.co.za deployment.
//
// This bundle ONLY EVER implements polling — there is no PHP equivalent of
// presence-server.js's WebSocket half. That's not a missing feature to add
// later; WebSocket needs a persistent process bound to a port, and that's
// exactly what plain cPanel/Apache+PHP shared hosting can't run, in any
// language (see issuer-php/README.txt for the same constraint already
// documented for the issuer, and presence-server/server.js's own header
// comment for why presence needed a WebSocket server in the first place).
//
// extension/viewer.js doesn't need to be told any of this. It tries
// WebSocket first regardless of which backend it's talking to (derived
// from the domain's manifest — see the `presence` field noted in this
// bundle's README.txt) and falls back to polling entirely on its own the
// moment that attempt fails or hangs (see PRESENCE_DEFAULT_BASE /
// presenceWsUrlFor() / pollPresence() in viewer.js). There's no "this
// backend is polling-only" flag to set anywhere — a wss://.../presence
// URL that nothing answers just fails fast, exactly like a WS-disabled
// presence-server.js does with its own test-only PRESENCE_DISABLE_WS hook.
// Deploying this bundle is the whole story.
//
// All room/member state lives in ONE JSON file (atlas-presence-store.json,
// next to this file — not under .well-known, not web-reachable, same
// "private working file" reasoning as issuer-php's atlas-mail-store.json
// and atlas-subscribers-store.json), read-modify-written under an
// exclusive flock on every single request — PHP has no long-running
// process to hold this in memory the way presence-server.js does. Fine at
// demo/small-site scale (mirrors issuer-php/README.txt's identical note
// about re-parsing the private key file on every request); a busy site
// with hundreds of concurrent visitors in one room would eventually want a
// real datastore instead of one flat file, but that's a very different
// scale of problem than what this bundle is for.

function atlas_presence_store_file() {
  return __DIR__ . '/atlas-presence-store.json';
}

// Loose sanity bounds — matches presence-server/server.js's MAX_NAME_LEN/
// MAX_ID_LEN/MAX_COORD exactly, same reasoning: not real anti-cheat (see
// that file's own scope note — a modified client can still report any
// position it likes; this bundle doesn't add server-side movement
// authority either), just enough to stop obviously-malformed input from
// propagating into every other visitor's roster.
const PRESENCE_MAX_NAME_LEN = 60;
const PRESENCE_MAX_ID_LEN = 120; // domain/world strings
const PRESENCE_MAX_COORD = 100000;
const PRESENCE_MAX_PUBLIC_KEY_LEN = 200; // matches presence-server.js's MAX_PUBLIC_KEY_LEN

// Signal relay (Friends, #67), PHP side — same closed vocabulary as
// presence-server.js's ALLOWED_SIGNAL_KINDS. See poll/signal.php for what
// this is used for; this bundle is polling-only so there's no WS-vs-poll
// branch here at all — a signal always gets queued into the target
// member's pendingSignals and picked up on their next /presence/poll/sync.
const PRESENCE_ALLOWED_SIGNAL_KINDS = ['friend-request', 'friend-request-accepted', 'friend-request-declined'];

// More generous than presence-server.js's own POLL_TIMEOUT_MS default
// (8000ms) — a real request over the public internet to shared hosting is
// slower and less predictable than the loopback-only Node dev setup that
// default was tuned for, so this leaves more room for a couple of slow or
// dropped polls before treating a visitor as gone. extension/viewer.js's
// own poll interval (2000ms) doesn't need to change either way.
const PRESENCE_POLL_TIMEOUT_MS = 15000;

function presence_now_ms() {
  return microtime(true) * 1000;
}

function presence_new_id() {
  return bin2hex(random_bytes(8));
}

function presence_room_key($domain, $world) {
  return $domain . '::' . $world;
}

// JSON decode never produces NaN/Infinity (JSON itself has no literal for
// either), so checking is_int/is_float is enough here — no separate
// is_finite() needed the way presence-server.js's isFiniteNumber() has to
// check explicitly for a value that arrived as a JS number.
function presence_num($v) {
  return (is_int($v) || is_float($v)) ? (float) $v : null;
}

// Removes any member of this room that hasn't synced in
// PRESENCE_POLL_TIMEOUT_MS — the polling equivalent of presence-server.js's
// periodic background sweep, just done lazily (whenever a request happens
// to touch this room next) instead of on a timer, since PHP has no
// long-running process to run one on. A room nobody visits again just sits
// with stale entries forever, which is harmless: nobody ever asks for that
// room's roster again either.
function presence_sweep_room(&$room) {
  $now = presence_now_ms();
  foreach ($room as $id => $member) {
    if (($now - $member['lastSeen']) > PRESENCE_POLL_TIMEOUT_MS) unset($room[$id]);
  }
}

function presence_roster_of($room, $exceptId) {
  $roster = [];
  foreach ($room as $id => $member) {
    if ($id === $exceptId) continue;
    $roster[] = [
      'id' => $id, 'name' => $member['name'], 'x' => $member['x'], 'y' => $member['y'], 'z' => $member['z'], 'yaw' => $member['yaw'],
      'publicKey' => isset($member['publicKey']) ? $member['publicKey'] : null
    ];
  }
  return $roster;
}

// Opens the store under an exclusive lock, decodes it, lets $mutator
// read/modify $doc (by reference) and compute a return value, then writes
// the whole thing back before releasing the lock. Same flock
// read-modify-write shape as issuer-php/lib/store.php's atlas_revoke()/
// append_mail(), generalized into one reusable helper since presence has
// three routes doing this instead of one.
function with_presence_store_locked($mutator) {
  $fh = fopen(atlas_presence_store_file(), 'c+');
  if ($fh === false) throw new Exception('could not open the presence store file');
  flock($fh, LOCK_EX);
  $raw = stream_get_contents($fh);
  $doc = json_decode($raw, true);
  if (!is_array($doc)) $doc = [];
  if (!isset($doc['rooms']) || !is_array($doc['rooms'])) $doc['rooms'] = [];
  $result = $mutator($doc);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}
