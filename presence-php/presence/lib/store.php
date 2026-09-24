<?php
// Domain Atlas — PHP presence: room/roster storage. This is the PHP port of
// presence-server/server.js's /presence/poll/* routes (task #68) — the
// piece flagged as follow-up work when the polling fallback was first
// built, now filled in for a real shared-hosting deployment.
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
const PRESENCE_MAX_COLOR_LEN = 16; // matches presence-server.js's MAX_COLOR_LEN — '#rrggbb' with room to spare

// Same "loose sanity, not real validation" posture as the bounds above —
// matches presence-server.js's sanitizeColor() exactly.
function presence_sanitize_color($v) {
  return is_string($v) ? substr($v, 0, PRESENCE_MAX_COLOR_LEN) : null;
}

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
      'publicKey' => isset($member['publicKey']) ? $member['publicKey'] : null,
      'shirtColor' => isset($member['shirtColor']) ? $member['shirtColor'] : null,
      'pantsColor' => isset($member['pantsColor']) ? $member['pantsColor'] : null,
      'hatColor' => isset($member['hatColor']) ? $member['hatColor'] : null
    ];
  }
  return $roster;
}

// Opens the store under an exclusive lock, decodes it, lets $mutator
// read/modify $doc (by reference) and compute a return value, then writes
// the whole thing back before releasing the lock. Same flock
// read-modify-write shape as issuer-php/lib/store.php's atlas_revoke()/
// append_mail(), generalized into one reusable helper since presence has
// several routes doing this instead of one.
function with_presence_store_locked($mutator) {
  $fh = fopen(atlas_presence_store_file(), 'c+');
  if ($fh === false) throw new Exception('could not open the presence store file');
  flock($fh, LOCK_EX);
  $raw = stream_get_contents($fh);
  $doc = json_decode($raw, true);
  if (!is_array($doc)) $doc = [];
  if (!isset($doc['rooms']) || !is_array($doc['rooms'])) $doc['rooms'] = [];
  if (!isset($doc['challenges']) || !is_array($doc['challenges'])) $doc['challenges'] = [];
  if (!isset($doc['duplicateJoinLosses']) || !is_array($doc['duplicateJoinLosses'])) $doc['duplicateJoinLosses'] = [];
  // Task #137 — lazy timeout: PHP has no long-running process to run a
  // real setTimeout() the way presence-server.js's own
  // createDuplicateJoinChallenge() does, so instead every single touch of
  // this store (any visitor's join/sync/signal/activity/leave, anywhere)
  // is also a chance to notice a pending challenge whose countdown has
  // run out and settle it — same "lazy instead of timer-based, fine at
  // demo/small-site scale" reasoning presence_sweep_room() already uses
  // for staleness. See presence_sweep_challenges() below.
  presence_sweep_challenges($doc);
  $result = $mutator($doc);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}

// ---------- duplicate-identity join guard (task #137) ----------
//
// PHP port of presence-server/server.js's own "duplicate-identity join
// guard" section (see that file's identical header comment for the full
// design rationale — two timers, "newcomer wins on timeout" default,
// activity tracked separately from the poll heartbeat). The one real
// difference: Node schedules the countdown's default outcome with a real
// setTimeout() so it fires even if nobody polls again; PHP can't do that
// (no long-running process), so a pending challenge is instead resolved
// lazily — by presence_sweep_challenges() above, run on every single
// request that touches this store, from anyone, anywhere. In practice
// that's frequent enough (every visitor syncs roughly every couple of
// seconds) that the countdown still fires close to on time; the one
// difference from Node is a challenge could in principle sit unresolved a
// little longer if literally nobody touches the presence store at all in
// the meantime — an acceptable rough edge for a demo-scale bundle that
// already documents the same tradeoff for staleness sweeping.
//
// Same env var names as presence-server.js's own ACTIVITY_IDLE_MS /
// DUPLICATE_JOIN_COUNTDOWN_MS (not just matching values) so one test
// script can override both backends identically instead of needing to
// remember two different variable names.
define('PRESENCE_ACTIVITY_IDLE_MS', (function () {
  $v = getenv('ACTIVITY_IDLE_MS');
  return ($v !== false && is_numeric($v) && (float) $v > 0) ? (float) $v : 20 * 60 * 1000;
})());
define('PRESENCE_DUPLICATE_JOIN_COUNTDOWN_MS', (function () {
  $v = getenv('DUPLICATE_JOIN_COUNTDOWN_MS');
  return ($v !== false && is_numeric($v) && (float) $v > 0) ? (float) $v : 60000;
})());
// How long a RESOLVED challenge's outcome stays available for a new
// joiner's /presence/poll/join-status to pick up before the sweep drops
// it — same reasoning as presence-server.js's own CHALLENGE_RESULT_GRACE_MS.
const PRESENCE_CHALLENGE_RESULT_GRACE_MS = 30000;

function presence_is_member_active($member) {
  $lastActivity = isset($member['lastActivityAt']) ? $member['lastActivityAt'] : 0;
  return (presence_now_ms() - $lastActivity) <= PRESENCE_ACTIVITY_IDLE_MS;
}

// Linear scan rather than an index — same reasoning as
// presence-server.js's own findMemberByPublicKey(): room sizes stay small
// at this bundle's scale, and this only runs on a join or a chat send,
// not on every move/sync tick. Returns the connId only (not the member
// itself) since every caller already has $room in hand to look it up by.
function presence_find_member_by_public_key($room, $publicKey) {
  if (!$publicKey) return null; // anonymous visitors never dedupe against anyone
  foreach ($room as $connId => $member) {
    if (isset($member['publicKey']) && $member['publicKey'] === $publicKey) return $connId;
  }
  return null;
}

// The dedupe-aware entry point poll/join.php calls instead of adding a
// member directly. $connId is generated by the caller (not here) so that
// if this returns {status:'pending'}, the eventual {status:'joined', id}
// a later /presence/poll/join-status call reveals reuses the SAME id the
// caller was already told about — mirrors presence-server.js's own
// requestJoin(), which threads its connId through the same way.
// Returns:
//   {status:'pending', challengeId, countdownMs}  — ask again via join-status
//   {status:'joined', roster}                     — joined right now
function presence_request_join($domain, $world, $connId, $name, $publicKey) {
  return with_presence_store_locked(function (&$doc) use ($domain, $world, $connId, $name, $publicKey) {
    $roomKey = presence_room_key($domain, $world);
    if (!isset($doc['rooms'][$roomKey])) $doc['rooms'][$roomKey] = [];
    $room = &$doc['rooms'][$roomKey];
    presence_sweep_room($room);

    $existingConnId = presence_find_member_by_public_key($room, $publicKey);
    if ($existingConnId !== null) {
      if (presence_is_member_active($room[$existingConnId])) {
        $challengeId = presence_new_id();
        $doc['challenges'][$challengeId] = [
          'roomKey' => $roomKey, 'existingConnId' => $existingConnId, 'newConnId' => $connId,
          'name' => $name, 'publicKey' => $publicKey,
          'createdAt' => presence_now_ms(), 'resolvedAt' => null, 'resolution' => null
        ];
        // Same delivery path a friend-request signal already uses — this
        // bundle is polling-only, so the existing member finds out on its
        // own next /presence/poll/sync, no separate push mechanism needed.
        if (!isset($room[$existingConnId]['pendingSignals'])) $room[$existingConnId]['pendingSignals'] = [];
        $room[$existingConnId]['pendingSignals'][] = [
          'type' => 'signal', 'kind' => 'duplicate-join-request',
          'challengeId' => $challengeId, 'countdownMs' => PRESENCE_DUPLICATE_JOIN_COUNTDOWN_MS
        ];
        unset($room);
        return ['status' => 'pending', 'challengeId' => $challengeId, 'countdownMs' => PRESENCE_DUPLICATE_JOIN_COUNTDOWN_MS];
      }
      // Stale — nothing worth asking about, just take the slot silently.
      unset($room[$existingConnId]);
    }

    $roster = presence_roster_of($room, null);
    $room[$connId] = [
      'name' => $name, 'publicKey' => $publicKey, 'x' => 0.0, 'y' => 0.0, 'z' => 0.0, 'yaw' => 0.0,
      'lastSeen' => presence_now_ms(), 'lastActivityAt' => presence_now_ms(), 'pendingSignals' => []
    ];
    unset($room);
    return ['status' => 'joined', 'roster' => $roster];
  });
}

// Settles a pending challenge, idempotently (a no-op if already resolved
// — the same countdown-expiry sweep and an explicit duplicate-response
// call can otherwise race each other, exactly like presence-server.js's
// own resolveChallenge() guards against). 'keep' just marks the newcomer
// denied, nothing else changes. 'yield' evicts the existing member (a
// safe no-op if it's already gone — e.g. it left on its own, or was
// separately swept as stale, in the meantime) and admits the newcomer
// under the SAME connId its original /presence/poll/join call already
// told it about. Must be called with $doc already locked (i.e. from
// inside a with_presence_store_locked() mutator).
function presence_resolve_challenge(&$doc, $challengeId, $decision) {
  if (!isset($doc['challenges'][$challengeId])) return;
  $challenge = $doc['challenges'][$challengeId];
  if ($challenge['resolvedAt']) return;
  $doc['challenges'][$challengeId]['resolvedAt'] = presence_now_ms();

  if ($decision !== 'yield' && $decision !== 'keep') $decision = 'yield';
  if ($decision === 'keep') {
    $doc['challenges'][$challengeId]['resolution'] = ['status' => 'denied'];
    return;
  }

  // Task #139 — tag this eviction so /presence/poll/sync's 404 handler
  // can tell the losing side's client WHY its id just went missing (this
  // bundle has no push channel at all, unlike presence-server.js's WS
  // side, which sends an explicit 'duplicate-join-lost' signal instead —
  // here EVERY eviction is discovered the same way, via the next sync's
  // 404, so the reason has to ride along with that response). Auto-
  // rejoining after THIS specific reason would just re-trigger a fresh
  // challenge against whoever won — every other reason an id can go
  // missing (plain staleness) is safe to silently self-heal from.
  $doc['duplicateJoinLosses'][$challenge['existingConnId']] = presence_now_ms() + PRESENCE_CHALLENGE_RESULT_GRACE_MS;

  $roomKey = $challenge['roomKey'];
  if (!isset($doc['rooms'][$roomKey])) $doc['rooms'][$roomKey] = [];
  $room = &$doc['rooms'][$roomKey];
  if (isset($room[$challenge['existingConnId']])) unset($room[$challenge['existingConnId']]);
  $room[$challenge['newConnId']] = [
    'name' => $challenge['name'], 'publicKey' => $challenge['publicKey'],
    'x' => 0.0, 'y' => 0.0, 'z' => 0.0, 'yaw' => 0.0,
    'lastSeen' => presence_now_ms(), 'lastActivityAt' => presence_now_ms(), 'pendingSignals' => []
  ];
  $roster = presence_roster_of($room, $challenge['newConnId']);
  unset($room);
  $doc['challenges'][$challengeId]['resolution'] = ['status' => 'joined', 'id' => $challenge['newConnId'], 'roster' => $roster];
}

// Auto-resolves ('yield' — newcomer wins) any pending challenge whose
// countdown has run out, and drops resolved challenges old enough that no
// join-status poll is realistically still coming for them. See this
// section's own header comment for why this lazy, every-request-touches-
// it sweep replaces presence-server.js's real setTimeout()-based one.
function presence_sweep_challenges(&$doc) {
  if (!isset($doc['challenges']) || !is_array($doc['challenges'])) { $doc['challenges'] = []; return; }
  $now = presence_now_ms();
  foreach (array_keys($doc['challenges']) as $challengeId) {
    $challenge = $doc['challenges'][$challengeId];
    if (!$challenge['resolvedAt'] && ($now - $challenge['createdAt']) >= PRESENCE_DUPLICATE_JOIN_COUNTDOWN_MS) {
      presence_resolve_challenge($doc, $challengeId, 'yield');
    }
  }
  foreach (array_keys($doc['challenges']) as $challengeId) {
    $challenge = $doc['challenges'][$challengeId];
    if ($challenge['resolvedAt'] && ($now - $challenge['resolvedAt']) > PRESENCE_CHALLENGE_RESULT_GRACE_MS) {
      unset($doc['challenges'][$challengeId]);
    }
  }
  // Task #139 — same grace-period cleanup for duplicateJoinLosses; each
  // entry stores its own already-computed expiry timestamp.
  if (!isset($doc['duplicateJoinLosses']) || !is_array($doc['duplicateJoinLosses'])) { $doc['duplicateJoinLosses'] = []; return; }
  foreach (array_keys($doc['duplicateJoinLosses']) as $connId) {
    if ($now > $doc['duplicateJoinLosses'][$connId]) unset($doc['duplicateJoinLosses'][$connId]);
  }
}

// ---------- in-world chat (task #110's PHP port of presence-server.js's
// own "chat" section) ----------
//
// A SEPARATE store file (atlas-chat-store.json, same lib/ folder, same
// deny-all .htaccess) rather than reusing atlas-presence-store.json —
// chat is keyed by domain alone (every visitor anywhere in a domain
// shares one chat room, tagged per-message with `world` so a client can
// offer both a "This World" and a "Domain" tab from the same stream, see
// extension/viewer.js's renderChatMessages()), not by domain+world the
// way presence's rooms are, and giving it its own file keeps a busy chat
// domain's read-modify-write cost from also locking out presence's own
// move/sync traffic in that same domain, and vice versa.
//
// This bundle is polling-only, exactly like the presence half above —
// there is no WebSocket here, and never will be (see this file's own
// header note and presence-php/README.txt's "Why there's no WebSocket
// version of this" section; the same hosting constraint applies to chat
// for the identical reason). A member here has no live connection to push
// to at all, so instead of presence-server.js's node "chat-message" push,
// a chat poll member carries a `cursor` — the seq number of the newest
// message it has already received — and /presence/chat/sync hands back
// only the history entries newer than that, advancing the cursor to
// match. See chat_sync_member() below.
function atlas_chat_store_file() {
  return __DIR__ . '/atlas-chat-store.json';
}

const CHAT_HISTORY_LIMIT = 50; // matches presence-server.js's CHAT_HISTORY_LIMIT
const MAX_CHAT_TEXT_LEN = 500; // matches presence-server.js's MAX_CHAT_TEXT_LEN

// Same blocklist/leetspeak-normalization/space-preserving-substring-match
// idea as presence-server.js's own chatTextContainsBlockedWord (and
// wallet.js's client-side chatMessageContainsBlockedWord) — duplicated
// rather than shared, same "each deployable bundle is self-contained"
// reasoning as everything else in this file. See the Node version's own
// comment for the full reasoning on why this is substring (not
// whole-word-only) matching against punctuation-normalized-to-SPACES
// text: whole-word-only would let inflections like "fucking"/"shitty"
// dodge a blocklist entry for "fuck"/"shit", and preserving word
// boundaries (spaces, not stripped-to-nothing) stops two innocent
// adjacent words from concatenating into a false hit the way the alias
// filter's own stricter normalizer would risk on a multi-word sentence.
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

// Opens atlas-chat-store.json under an exclusive lock, same
// read-modify-write shape as with_presence_store_locked() above, just
// against the top-level 'domains' key instead of 'rooms' — one entry per
// domain: {nextSeq, history: [...], members: {connId: {...}}}.
function with_chat_store_locked($mutator) {
  $fh = fopen(atlas_chat_store_file(), 'c+');
  if ($fh === false) throw new Exception('could not open the chat store file');
  flock($fh, LOCK_EX);
  $raw = stream_get_contents($fh);
  $doc = json_decode($raw, true);
  if (!is_array($doc)) $doc = [];
  if (!isset($doc['domains']) || !is_array($doc['domains'])) $doc['domains'] = [];
  $result = $mutator($doc);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}

function chat_domain_entry(&$doc, $domain) {
  if (!isset($doc['domains'][$domain]) || !is_array($doc['domains'][$domain])) {
    $doc['domains'][$domain] = ['nextSeq' => 0, 'history' => [], 'members' => []];
  }
  return $doc['domains'][$domain];
}

// Removes any chat member that hasn't synced/sent in
// PRESENCE_POLL_TIMEOUT_MS — the chat counterpart of
// presence_sweep_room() above, reusing the exact same timeout constant
// (no separate CHAT_POLL_TIMEOUT_MS — one number to reason about, and a
// visitor's staleness threshold shouldn't differ just because they were
// chatting instead of moving). An abandoned member here has no
// roster-visibility consequence the way a stale presence member would
// (nobody's roster reads from this), it would just sit in 'members'
// forever otherwise.
function chat_sweep_domain(&$entry) {
  $now = presence_now_ms();
  foreach ($entry['members'] as $connId => $member) {
    if (($now - $member['lastSeen']) > PRESENCE_POLL_TIMEOUT_MS) unset($entry['members'][$connId]);
  }
}

// Joins $connId into $domain's chat room, returns the current history
// backlog (same shape sendChatMessage()'s messages have) — publicKey is
// optional, same "reading chat needs no login, only sending does"
// principle as the rest of this app; enforced in chat_send_message()
// below, not here. The new member's cursor is seeded to "already seen
// everything in the history just handed back," so their first sync only
// returns messages that arrive AFTER this join.
function chat_join_room($domain, $world, $name, $publicKey) {
  if ($domain === '' || $world === '') return null;
  return with_chat_store_locked(function (&$doc) use ($domain, $world, $name, $publicKey) {
    $entry = chat_domain_entry($doc, $domain);
    chat_sweep_domain($entry);
    $connId = presence_new_id();
    $lastSeq = count($entry['history']) ? $entry['history'][count($entry['history']) - 1]['seq'] : 0;
    $entry['members'][$connId] = [
      'name' => $name, 'publicKey' => $publicKey, 'world' => $world,
      'lastSeen' => presence_now_ms(), 'cursor' => $lastSeq
    ];
    $doc['domains'][$domain] = $entry;
    return ['id' => $connId, 'messages' => $entry['history']];
  });
}

// Polling sync: bumps lastSeen (counts as activity) and returns every
// history entry newer than this member's cursor, advancing the cursor to
// match — same "what's new since I last looked?" shape as
// pollChatSync() in presence-server.js. Returns null for an unknown/
// expired connId (the route turns that into a 404).
function chat_sync_member($connId) {
  return with_chat_store_locked(function (&$doc) use ($connId) {
    foreach ($doc['domains'] as $domain => &$entry) {
      chat_sweep_domain($entry);
      if (!isset($entry['members'][$connId])) continue;
      $entry['members'][$connId]['lastSeen'] = presence_now_ms();
      $cursor = $entry['members'][$connId]['cursor'];
      $delta = array_values(array_filter($entry['history'], function ($m) use ($cursor) { return $m['seq'] > $cursor; }));
      if (count($delta)) $entry['members'][$connId]['cursor'] = $delta[count($delta) - 1]['seq'];
      unset($entry);
      return ['found' => true, 'messages' => $delta];
    }
    unset($entry);
    return ['found' => false];
  });
}

// Validates and appends a chat send from an already-joined $connId —
// same {ok:true, message} / {ok:false, reason} shape as
// presence-server.js's sendChatMessage(), same fixed short reasons
// ('not-joined' | 'login-required' | 'empty' | 'blocked') the client's
// chatErrorText() in viewer.js already knows how to turn into a message.
// Advances the sender's OWN cursor to the new message's seq too, so a
// poll member sending its own message never sees it a second time as a
// "new" delta entry on its very next sync.
function chat_send_message($connId, $textRaw) {
  return with_chat_store_locked(function (&$doc) use ($connId, $textRaw) {
    foreach ($doc['domains'] as $domain => &$entry) {
      if (!isset($entry['members'][$connId])) continue;
      $member = &$entry['members'][$connId];
      if (empty($member['publicKey'])) { unset($member, $entry); return ['found' => true, 'ok' => false, 'reason' => 'login-required']; }
      $text = trim(substr((string) $textRaw, 0, MAX_CHAT_TEXT_LEN));
      if ($text === '') { unset($member, $entry); return ['found' => true, 'ok' => false, 'reason' => 'empty']; }
      if (chat_text_contains_blocked_word($text)) { unset($member, $entry); return ['found' => true, 'ok' => false, 'reason' => 'blocked']; }

      $seq = $entry['nextSeq'] + 1;
      $entry['nextSeq'] = $seq;
      $message = [
        'seq' => $seq, 'id' => presence_new_id(), 'world' => $member['world'],
        'name' => $member['name'], 'publicKey' => $member['publicKey'],
        'text' => $text, 'sentAt' => gmdate('Y-m-d\TH:i:s\Z')
      ];
      $entry['history'][] = $message;
      if (count($entry['history']) > CHAT_HISTORY_LIMIT) array_shift($entry['history']);
      $member['cursor'] = $seq;

      // Task #137's activity clock: a chat send counts as activity for
      // this same identity's PRESENCE-room membership too, if it has one
      // — chat and presence are deliberately separate stores/rooms (see
      // this file's own header comment above), so this is a lookup by
      // publicKey against the presence room for $member['world'], not a
      // shared connId (a poll visitor gets a different connId for each),
      // same reasoning as presence-server.js's own sendChatMessage().
      $activityRoomKey = presence_room_key($domain, $member['world']);
      $activityPublicKey = $member['publicKey'];
      with_presence_store_locked(function (&$pdoc) use ($activityRoomKey, $activityPublicKey) {
        if (isset($pdoc['rooms'][$activityRoomKey])) {
          $foundConnId = presence_find_member_by_public_key($pdoc['rooms'][$activityRoomKey], $activityPublicKey);
          if ($foundConnId !== null) $pdoc['rooms'][$activityRoomKey][$foundConnId]['lastActivityAt'] = presence_now_ms();
        }
        return null;
      });

      unset($member, $entry);
      return ['found' => true, 'ok' => true, 'message' => $message];
    }
    unset($entry);
    return ['found' => false];
  });
}

// Best-effort explicit leave — removes $connId from whichever domain's
// members it's in, if any. Safe to call on an id that isn't actually
// joined (silent no-op), same as presence's own leave route.
function chat_leave_room($connId) {
  if ($connId === '') return;
  with_chat_store_locked(function (&$doc) use ($connId) {
    foreach ($doc['domains'] as $domain => &$entry) {
      if (isset($entry['members'][$connId])) { unset($entry['members'][$connId]); break; }
    }
    unset($entry);
    return null;
  });
}
