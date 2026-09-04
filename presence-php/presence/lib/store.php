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
