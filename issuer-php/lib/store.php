<?php
// Domain Atlas — PHP issuer: configuration, key storage, revocation ledger.
//
// Mirrors issuer-server/server.js's three overridable settings, but PHP has
// no long-lived process to read environment variables from at startup — a
// shared host runs this fresh per request — so ATLAS_DOMAIN defaults to the
// Host header instead (correct almost all the time on real hosting) and can
// still be forced below if you're reverse-proxied or the Host header isn't
// trustworthy for some reason.

// ATLAS_DOMAIN — baked into every issued credential's issuer.domain field.
// Get this wrong and re-verification tries to fetch the issuer's key from
// the WRONG domain later. Auto-detected from the request; override if needed.
function atlas_domain() {
  $forced = null; // e.g. 'example.com' — set this if Host-header detection isn't right for your setup
  if ($forced) return $forced;
  return isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : 'localhost';
}

// ATLAS_TRUSTED_TRADE_PEERS (SPEC.md §7) — the only other domains this
// domain will treat as a genuine cross-domain trading counterpart, in
// BOTH roles a trade can put it in: accepting a foreign-issued balance at
// this domain's own Trading Station (checked in
// check_presented_asset()/check_presented_unique_asset()), and honoring a
// relay-lock/relay-settle request against a credential THIS domain itself
// issued, sent by another domain's station on a visitor's behalf (checked
// in atlas/trade/relay-lock.php and atlas/trade/relay-settle.php). Empty
// by default: a deployment that never edits this never accepts, and never
// honors, a cross-domain trade with anyone. Mutual by convention, not by
// enforcement — list a domain here only once you'd also want it listing
// you back, the same opted-in-both-ways posture Post Office membership
// and Trading Station membership already require elsewhere in this
// bundle, applied here to a domain rather than a visitor. Admin-managed
// (see the atlas/admin/trusted-trade-peers/ endpoints) rather than a
// hand-edited literal, same file-backed posture atlas_suspensions_file()
// already uses — unlike atlas_federation_blocklist_file(), which stays
// deliberately hand-edited-only (see its own comment below), this one
// gets a real admin UI because adding a trading counterpart is routine
// operator work, not a rare emergency action. Lives in lib/, same
// not-web-reachable reasoning as atlas_mail_file() above — no other
// domain ever needs to fetch this one, it's only ever checked locally.
// Mirrors issuer-server/server.js's TRUSTED_TRADE_PEERS_FILE/
// readTrustedTradePeers().
function atlas_trusted_trade_peers_file() {
  return __DIR__ . '/atlas-trusted-trade-peers-store.json';
}

// Same flock-guarded shared-read shape as read_suspensions() below.
// Missing file means no peers are trusted yet, same "absence is the
// empty case" convention every other store file here uses.
function read_trusted_trade_peers() {
  $fh = fopen(atlas_trusted_trade_peers_file(), 'c+');
  if ($fh === false) return ['peers' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) && isset($doc['peers']) ? $doc : ['peers' => []];
}

function atlas_trusted_trade_peers() {
  return read_trusted_trade_peers()['peers'];
}

function atlas_is_trusted_trade_peer($domain) {
  return in_array($domain, atlas_trusted_trade_peers(), true);
}

// Dedupes on add (re-adding an already-trusted domain is a no-op, not a
// second entry) and reports back whether this call actually changed
// anything, same "tell the caller what happened" convention
// atlas_unsuspend() uses for removal below. Same flock-guarded
// read-modify-write shape as atlas_suspend().
function atlas_add_trusted_trade_peer($domain) {
  $file = atlas_trusted_trade_peers_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc) || !isset($doc['peers'])) $doc = ['peers' => []];
  if (in_array($domain, $doc['peers'], true)) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return false;
  }
  $doc['peers'][] = $domain;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return true;
}

function atlas_remove_trusted_trade_peer($domain) {
  $file = atlas_trusted_trade_peers_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc) || !isset($doc['peers'])) $doc = ['peers' => []];
  $before = count($doc['peers']);
  $doc['peers'] = array_values(array_filter($doc['peers'], function ($d) use ($domain) { return $d !== $domain; }));
  $removed = count($doc['peers']) !== $before;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $removed;
}

// ATLAS_DOCROOT — where .well-known/atlas-key.json and
// atlas-revocations.json get written/read, and where the private key file
// lives. Defaults to the folder ABOVE this atlas/ directory, i.e. wherever
// you dropped the whole atlas-php bundle — normally your site's document
// root, right next to your existing .well-known/spatial.json.
function atlas_docroot() {
  return realpath(__DIR__ . '/..');
}

// The private key never goes under .well-known or any URL-reachable path on
// purpose. It lives in lib/, and the bundled .htaccess denies web access to
// *.pem inside atlas/ as defense in depth — but the real protection is that
// lib/ isn't linked from .well-known/spatial.json or anywhere a visitor
// would think to fetch, and cPanel doesn't serve directory listings by default.
function atlas_key_file() {
  return __DIR__ . '/issuer-private-key.pem';
}

function atlas_public_key_file() {
  return atlas_docroot() . '/.well-known/atlas-key.json';
}

function atlas_revocations_file() {
  return atlas_docroot() . '/.well-known/atlas-revocations.json';
}

// A second, reversible way a credential can stop being usable, alongside
// the permanent atlas_revocations_file() above — a pause, not a death
// sentence. Published under .well-known the same way revocations are, so
// a foreign domain checking a credential this domain issued
// (verify_foreign_asset_credential() below) sees a live suspension the
// same way it already sees a revocation. Mirrors issuer-server/server.js's
// SUSPENSIONS_FILE.
function atlas_suspensions_file() {
  return atlas_docroot() . '/.well-known/atlas-suspensions.json';
}

// SPEC.md §5.11 — a second, independent keypair this SAME domain also
// generates and publishes, used only for third-party attestations, never
// for anything issue_asset() issues. Mirrors issuer-server/server.js's
// REVIEWER_KEY_FILE/REVIEWER_PUBLIC_KEY_FILE — see that file's own comment
// for why this exists: it lets attestation-demo.html's "independent
// reviewer" work on a single deployed domain instead of needing a literal
// second domain reachable somewhere else. Lives in lib/, same
// not-web-reachable reasoning as atlas_key_file() above.
function atlas_reviewer_key_file() {
  return __DIR__ . '/reviewer-private-key.pem';
}

function atlas_reviewer_public_key_file() {
  return atlas_docroot() . '/.well-known/atlas-reviewer-key.json';
}

// Deliberately NOT under .well-known (which is served as plain static
// files, world-readable to anyone who knows the URL, same as
// atlas-revocations.json above needs to be) — mail is read through the
// signed atlas/mail/check.php (SPEC.md §11.8) instead. Lives in lib/ next to the private
// key file for the same "not meant to be a public crawlable file" reason,
// protected by this folder's .htaccess deny. Mirrors issuer-server/
// server.js's MAIL_FILE (which similarly sits next to the Node server's
// own key file rather than under the public docroot).
function atlas_mail_file() {
  return __DIR__ . '/atlas-mail-store.json';
}

// Hard per-recipient mailbox cap — defense in depth against unbounded mail
// storage (read_mail()/append_mail() never pruned or expired anything
// before this), applying equally to a local send and a federated relay.
// Mirrors issuer-server/server.js's MAILBOX_CAP. Plain constant rather
// than an env var, same "shared hosting doesn't make those easy to set"
// reasoning as the Post Office thresholds below.
const ATLAS_MAILBOX_CAP = 200;

// Email-delivered bearer credentials (SPEC.md §13) — outbound SMTP config
// for the mailbox named by this domain's own manifest.emailTickets.
// intakeAddress (§13.1). Unlike issuer-server/server.js's own
// EMAIL_TICKETS_CONFIG (read fresh from environment variables at every
// call site), this bundle has no long-lived process to read those from —
// same reasoning ATLAS_MAILBOX_CAP's own comment above already gives —
// so this is a small JSON file instead, same "missing file means the
// empty/disabled case" convention atlas_trusted_trade_peers_file() and
// atlas_federation_blocklist_file() already use, and hand-edited by the
// operator the same deliberate way those two are. Lives in lib/, same
// not-web-reachable reasoning as atlas_mail_file() above. A missing
// smtpHost means this domain has not actually turned this on yet,
// whatever its manifest claims — every call site checks that directly
// rather than trusting the manifest's say-so.
function atlas_email_tickets_config_file() {
  return __DIR__ . '/atlas-email-tickets-config.json';
}
function atlas_email_tickets_config() {
  $defaults = [
    'smtpHost' => null, 'smtpPort' => 587,
    // 'tls' (encrypted from the first byte, e.g. port 465), 'starttls'
    // (plain connect then upgrade, e.g. port 587 — the common case), or
    // 'none' (test-only, see lib/smtp.php's own atlas_smtp_send_mail()).
    'smtpSecure' => 'starttls',
    'smtpUser' => null, 'smtpPass' => null, 'fromAddress' => null,
    // Inbound side (SPEC.md §13.3) — the same mailbox's IMAP credentials.
    // Unlike issuer-server/server.js (polls on a timer, ATLAS_EMAIL_IMAP_
    // POLL_MS), this bundle has no long-lived process to run a timer in at
    // all — a missing imapHost means inbound transfers are off, the same
    // deliberate-absence posture smtpHost above already takes for
    // outbound, and atlas/admin/email-tickets/poll-now.php (triggered by
    // an operator-configured cron job in a real deployment, or a test's
    // own admin call) is this bundle's entire inbound mechanism.
    'imapHost' => null, 'imapPort' => 993, 'imapSecure' => 'tls',
    'imapUser' => null, 'imapPass' => null,
  ];
  if (!file_exists(atlas_email_tickets_config_file())) return $defaults;
  $doc = json_decode(file_get_contents(atlas_email_tickets_config_file()), true);
  return array_merge($defaults, is_array($doc) ? $doc : []);
}

// Whether this domain can actually send mail right now.
function atlas_email_delivery_configured() {
  $config = atlas_email_tickets_config();
  return !empty($config['smtpHost']) && !empty($config['fromAddress']);
}

// SPEC.md §13.3's bounce bookkeeping — one entry per forward send still
// genuinely in flight (acceptance by the recipient's mail server isn't
// proof of a real inbox, so a later bounce needs the original credential
// on hand to reissue). Flock-guarded, same shape as the pending-trades
// store above. Mirrors issuer-server/server.js's readEmailTicketSends()/
// recordPendingEmailTicketSend()/findPendingEmailTicketSend()/
// removePendingEmailTicketSend().
function atlas_email_ticket_sends_file() {
  return __DIR__ . '/atlas-email-ticket-sends-store.json';
}
function read_email_ticket_sends() {
  $fh = fopen(atlas_email_ticket_sends_file(), 'r');
  if ($fh === false) return ['sends' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['sends' => []];
}
function record_pending_email_ticket_send($credential, $returnToAddress) {
  $file = atlas_email_ticket_sends_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['sends' => []];
  $doc['sends'][] = ['ticketId' => $credential['id'], 'credential' => $credential, 'returnToAddress' => $returnToAddress, 'sentAt' => gmdate('Y-m-d\TH:i:s\Z')];
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}
function find_pending_email_ticket_send($ticketId) {
  foreach (read_email_ticket_sends()['sends'] as $s) {
    if (($s['ticketId'] ?? null) === $ticketId) return $s;
  }
  return null;
}
// Removed once a bounce for this id has been handled (reversed or found
// already moot) — the store is only ever meant to hold sends still
// genuinely in flight, not a permanent log of every send that ever went
// out clean.
function remove_pending_email_ticket_send($ticketId) {
  $file = atlas_email_ticket_sends_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['sends' => []];
  $doc['sends'] = array_values(array_filter($doc['sends'], function ($s) use ($ticketId) {
    return ($s['ticketId'] ?? null) !== $ticketId;
  }));
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// Asset-update store (SPEC.md §5.1.1, non-fungible only) — same "not
// web-reachable, flock-guarded flat array" shape as atlas_mail_file()
// above. Each entry is exactly the {id, status, reason, newCredential}
// shape atlas/mail/check.php hands back for a superseded id: `id` is the
// OLD (now-revoked) credential id, so a lookup by requested credentialId
// is a single scan, same cost as the mail filter right next to it.
// Mirrors issuer-server/server.js's ASSET_UPDATES_FILE.
function atlas_asset_updates_file() {
  return __DIR__ . '/atlas-asset-updates-store.json';
}

// Opt-in archive of a superseded credential's own full body, for any class
// whose ATLAS_ASSET_CATALOG entry sets 'auditHistory' => true (see
// atlas.demo.warranty.certificate above for the first one) — off by
// default, so every other class's supersession events cost this nothing.
// Not a new mechanism: every credential already carries `supersedes`, a
// signed pointer to whatever it replaced (SPEC.md §5's own "On
// terminology" note already calls this a verifiable lineage), but nothing
// requires an issuer to keep serving a superseded body once it's revoked.
// This is that missing piece — see archive_if_audited() below, and GET
// /atlas/asset/history for what it's for. Mirrors issuer-server/
// server.js's ASSET_HISTORY_FILE.
function atlas_asset_history_file() {
  return __DIR__ . '/atlas-asset-history-store.json';
}

// Same "not web-reachable" reasoning as atlas_mail_file() above — one
// entry per asset CLASS an operator has ever patched (POST /atlas/admin/
// class-patch), never one per item or per holder: a bulk alternative to
// reissuing each holder's credential by hand, letting an operator set a
// fact once for a whole non-fungible class and having every CURRENT
// holder's own wallet pick it up automatically on its own next check-in —
// see apply_class_patch_if_stale() in lib/bootstrap.php. Bounded by how
// many distinct classes ever get touched (at most the size of
// ATLAS_ASSET_CATALOG), never by how many visitors or items exist.
// Mirrors issuer-server/server.js's CLASS_PATCHES_FILE.
function atlas_class_patches_file() {
  return __DIR__ . '/atlas-class-patches-store.json';
}

// A roster of who subscribed (credential id + owner public key per
// atlas.membership issuance) — same "not web-reachable" reasoning as
// atlas_mail_file() above, since this is a list of subscriber public keys,
// not something to expose at a URL anyone can guess. There's no listing/
// broadcast endpoint reading this yet — it exists so issue.php can look up
// who to auto-welcome, and so you can open this file directly (cPanel File
// Manager or SSH) if you want to message everyone by hand later. A public
// "list subscribers" API would leak every subscriber's public key to
// anyone who requests it — this would need real operator authentication
// (which nothing in this bundle has yet) before it's ever safe to expose
// over HTTP.
function atlas_subscribers_file() {
  return __DIR__ . '/atlas-subscribers-store.json';
}

// Post Office (task #75/#87, SPEC.md §11.3): a roster of who holds a
// currently-valid Global Mail membership from THIS domain — same
// "not web-reachable" reasoning and shape as atlas_subscribers_file()
// above, kept as its own file because it answers a different question
// (who this domain will accept mail addressed TO, vs. who subscribed to
// hear FROM it) for a different credential class. This is the abuse gate
// atlas/postoffice/send.php checks every send against: anyone can attempt
// to send, but this domain only agrees to store/relay mail for someone it
// actually issued a Global Mail membership to. Mirrors issuer-server/
// server.js's POSTOFFICE_MEMBERS_FILE.
function atlas_postoffice_members_file() {
  return __DIR__ . '/atlas-postoffice-members-store.json';
}

// Task #97 (SPEC.md §11.4, domain-to-domain federation): the operator-level
// safety valve federation is explicitly built with — see
// issuer-server/server.js's FEDERATION_BLOCKLIST_FILE for the full
// reasoning, mirrored here. A plain operator-edited JSON file (no admin-auth
// API surface exists in this bundle to gate one), same "not web-reachable,
// lib/ + .htaccess deny" posture as the private key file. Distinct from
// atlas_postoffice_members_file()'s per-member blockedSenders (SPEC.md
// §11.3): that blocks one troublesome SENDER; this blocks an entire PEER
// DOMAIN's relayed mail outright.
function atlas_federation_blocklist_file() {
  return __DIR__ . '/atlas-federation-blocklist.json';
}
function is_domain_blocked($domain) {
  $path = atlas_federation_blocklist_file();
  if (!file_exists($path)) return false;
  $doc = json_decode(file_get_contents($path), true);
  $blocked = is_array($doc) && isset($doc['blocked']) ? $doc['blocked'] : [];
  return in_array($domain, $blocked, true);
}

// Federation relay rate limiting (SPEC.md §11.4) — mirrors issuer-server/
// server.js's RELAY_RATE_THRESHOLD/_WINDOW_MS. Unlike
// ATLAS_POSTOFFICE_SPAM_THRESHOLD above, which only flags a local member
// for the operator to review, a relaying domain has no membership here to
// leverage that way — nothing stops a throwaway domain from minting
// itself a fresh identity and relaying again — so relay_rate_limited()
// below actually rejects once a relaying domain crosses this threshold
// within the window, rather than just flagging. Plain constants, same
// "shared hosting doesn't make env vars easy to set" reasoning as the
// Post Office thresholds.
const ATLAS_RELAY_RATE_THRESHOLD = 30;
const ATLAS_RELAY_RATE_WINDOW_MS = 60000;
const ATLAS_RELAY_RATE_LOG_RETENTION_MS = 86400000; // 24 hours, in ms — same "keep more history than the detection window" reasoning as ATLAS_POSTOFFICE_SEND_LOG_RETENTION_MS
function atlas_federation_relay_rate_file() {
  return __DIR__ . '/atlas-federation-relay-rate-store.json';
}

// Domain admin roster — mirrors issuer-server/server.js's ADMIN_KEYS_FILE.
// The public keys authorized to act as this domain's own operator over
// HTTP, reusing the same visitor-identity mechanism (verify_envelope
// above) rather than a separate admin username/password system. Same
// "plain operator-edited JSON file, no admin-auth API surface to gate one"
// posture as atlas_federation_blocklist_file() above, for the same
// bootstrap reason: something has to seed the very first admin key by
// hand. See the admin session layer just below for the short-lived bearer
// token a roster key can trade one signature for.
function atlas_admin_keys_file() {
  return __DIR__ . '/atlas-admin-keys-store.json';
}
// An entry may carry a role (mirrors issuer-server/server.js):
//   - no `role` (or null): "admin", full issuer administration, so entries
//     written before roles existed keep working unchanged.
//   - "admin": the same.
//   - "moderator": world moderation only. Optional `worlds` (list of world ids)
//     and `operations` (subset of ATLAS_MODERATION_OPERATIONS). An absent list
//     means "all"; an EMPTY list means none; anything that is not a list of
//     valid strings means none. A moderator is never an admin.
//   - anything else: no authority at all (a typo must not fall back to admin).
const ATLAS_MODERATION_OPERATIONS = ['roster.view', 'chat.mute', 'session.kick', 'session.timeout'];
const ATLAS_MODERATION_MAX_WORLDS = 32;
const ATLAS_MODERATION_EDGE_SPACE = '\x{0009}-\x{000d}\x{0020}\x{0085}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}';

// A world id as a moderation scope names it: 1 to 120 characters (code
// points), valid UTF-8, no control characters or line/paragraph separators,
// and no leading or trailing white space. Same rule as the Node issuer.
function atlas_valid_world_id($w) {
  if (!is_string($w) || preg_match('//u', $w) !== 1) return false;
  $n = preg_match_all('/./su', $w);
  if ($n < 1 || $n > 120) return false;
  if (preg_match('/[\x00-\x1f\x7f\x{2028}\x{2029}]/u', $w) === 1) return false;
  if (preg_match('/^[' . ATLAS_MODERATION_EDGE_SPACE . ']|[' . ATLAS_MODERATION_EDGE_SPACE . ']$/u', $w) === 1) return false;
  return true;
}
// '*' when the field is absent, otherwise the validated list. Anything that
// is present but not a list of valid entries yields [] (none), never '*'.
function atlas_parse_scope_list($entry, $field, $isValid, $max) {
  if (!array_key_exists($field, $entry)) return '*';
  $raw = $entry[$field];
  if (!is_array($raw) || count($raw) > $max || ($raw !== [] && !atlas_array_is_list($raw))) return [];
  foreach ($raw as $v) if (!$isValid($v)) return [];
  return array_values(array_unique($raw));
}
// The effective authority of a roster key RIGHT NOW: null (not on the roster,
// revoked, unknown role, or ambiguous) or ['role', 'worlds', 'operations'],
// the last two '*' or a list. Read from the roster file on every call. If a
// key has several active entries they must all be plain admin entries; any
// mix, or two moderator entries, is ambiguous and grants nothing.
function admin_authority($publicKey) {
  if (!is_string($publicKey) || $publicKey === '') return null;
  $path = atlas_admin_keys_file();
  if (!file_exists($path)) return null;
  $doc = json_decode(file_get_contents($path), true);
  $keys = is_array($doc) && isset($doc['keys']) && is_array($doc['keys']) ? $doc['keys'] : [];
  $active = [];
  foreach ($keys as $k) {
    if (is_array($k) && isset($k['publicKey']) && $k['publicKey'] === $publicKey && empty($k['revoked'])) $active[] = $k;
  }
  if (!$active) return null;
  $allAdmin = true;
  foreach ($active as $k) {
    $role = array_key_exists('role', $k) ? $k['role'] : null;
    if (!($role === null || $role === 'admin')) $allAdmin = false;
  }
  if ($allAdmin) return ['role' => 'admin', 'worlds' => '*', 'operations' => '*'];
  if (count($active) === 1 && ($active[0]['role'] ?? null) === 'moderator') {
    return [
      'role' => 'moderator',
      'worlds' => atlas_parse_scope_list($active[0], 'worlds', 'atlas_valid_world_id', 256),
      'operations' => atlas_parse_scope_list($active[0], 'operations', function ($o) { return is_string($o) && in_array($o, ATLAS_MODERATION_OPERATIONS, true); }, count(ATLAS_MODERATION_OPERATIONS))
    ];
  }
  return null;
}
// True only for a FULL administrator. Every pre-existing check of "is this an
// admin?" goes through here, so a moderator can never satisfy one.
function is_admin_key($publicKey) {
  $a = admin_authority($publicKey);
  return $a !== null && $a['role'] === 'admin';
}
// What each scope needs: 'admin' (the default for every route) is the
// administrator role only; 'moderation' is the moderation-grant route and
// accepts administrators and moderators.
function admin_authority_allows($authority, $need) {
  if (!$authority) return false;
  if ($authority['role'] === 'admin') return true;
  return $authority['role'] === 'moderator' && $need === 'moderation';
}
function admin_insufficient_role($authority) {
  return admin_failure(403, 'insufficient-role', 'this key is registered as ' . $authority['role'] . ' and may not use this endpoint');
}

// Admin session layer on top of the roster above — mirrors
// issuer-server/server.js's ADMIN_NONCES_FILE/ADMIN_SESSIONS_FILE. The
// roster stays the one source of truth for who's an admin; this lets a
// roster key sign in ONCE (over a fresh single-use nonce, so the login can't
// be replayed) and use a random bearer token afterwards. Every file below is
// written by concurrent HTTP requests, so each read/modify/write runs under
// one exclusive flock (atlas_admin_locked()).
function atlas_admin_nonces_file() {
  return __DIR__ . '/atlas-admin-nonces-store.json';
}
function atlas_admin_sessions_file() {
  return __DIR__ . '/atlas-admin-sessions-store.json';
}
function atlas_admin_proof_nonces_file() {
  return __DIR__ . '/atlas-admin-proof-nonces-store.json';
}
function atlas_admin_ratelimit_file() {
  return __DIR__ . '/atlas-admin-ratelimit-store.json';
}

function atlas_env_positive_int($name, $fallback) {
  $v = getenv($name);
  if ($v === false || !preg_match('/^[1-9][0-9]*$/', $v)) return $fallback;
  return (int) $v;
}
const ATLAS_ADMIN_NONCE_TTL_MS = 120000; // login nonce lifetime
const ATLAS_ADMIN_SESSION_TTL_MS = 1800000; // idle expiry; slides forward on every check
const ATLAS_ADMIN_PROOF_NONCE_CAP = 20000;
const ATLAS_ADMIN_LIMITER_MAX_CLIENTS = 5000;
const ATLAS_ADMIN_SESSION_MAX_BODY_BYTES = 16384;
function atlas_admin_session_max_ms() { return atlas_env_positive_int('ATLAS_ADMIN_SESSION_MAX_MS', 8 * 60 * 60 * 1000); }
function atlas_admin_request_window_ms() { return atlas_env_positive_int('ATLAS_ADMIN_REQUEST_WINDOW_MS', 2 * 60 * 1000); }
function atlas_admin_proof_nonce_retain_ms() { return 2 * atlas_admin_request_window_ms() + 30000; }
function atlas_admin_nonce_cap() { return atlas_env_positive_int('ATLAS_ADMIN_NONCE_CAP', 200); }
function atlas_admin_nonce_per_client_per_min() { return atlas_env_positive_int('ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN', 10); }
function atlas_admin_fail_limit() { return atlas_env_positive_int('ATLAS_ADMIN_FAIL_LIMIT', 10); }
function atlas_admin_fail_window_ms() { return atlas_env_positive_int('ATLAS_ADMIN_FAIL_WINDOW_MS', 5 * 60 * 1000); }
function atlas_admin_max_body_bytes() { return atlas_env_positive_int('ATLAS_ADMIN_MAX_BODY_BYTES', 256 * 1024); }

function atlas_now_ms() { return (int) round(microtime(true) * 1000); }

// Runs $fn(array $doc) under an exclusive lock on $file and writes back the
// document it returns as [$newDoc, $result]. Returns $result. Everything in
// $fn is atomic with respect to other requests using the same file.
function atlas_admin_locked($file, $default, $fn) {
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc)) $doc = $default;
  list($newDoc, $result) = $fn($doc);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($newDoc, JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}

// Returns a fresh login nonce, or null while atlas_admin_nonce_cap() unexpired
// ones are already outstanding.
function issue_admin_nonce() {
  return atlas_admin_locked(atlas_admin_nonces_file(), ['nonces' => []], function ($doc) {
    $nowMs = atlas_now_ms();
    $nonces = array_values(array_filter(isset($doc['nonces']) && is_array($doc['nonces']) ? $doc['nonces'] : [], function ($n) use ($nowMs) { return ($n['expiresAt'] ?? 0) > $nowMs; }));
    if (count($nonces) >= atlas_admin_nonce_cap()) return [['nonces' => $nonces], null];
    $nonce = b64url_encode(random_bytes(24));
    $nonces[] = ['nonce' => $nonce, 'expiresAt' => $nowMs + ATLAS_ADMIN_NONCE_TTL_MS];
    return [['nonces' => $nonces], $nonce];
  });
}
// Single-use: removed the moment it's consumed, under the same lock that
// finds it, so two concurrent logins carrying one nonce cannot both succeed.
// Call it only after the signature and roster checks pass; a failed attempt
// does not burn the nonce.
function consume_admin_nonce($nonce) {
  return atlas_admin_locked(atlas_admin_nonces_file(), ['nonces' => []], function ($doc) use ($nonce) {
    $nowMs = atlas_now_ms();
    $found = false;
    $remaining = [];
    foreach (isset($doc['nonces']) && is_array($doc['nonces']) ? $doc['nonces'] : [] as $n) {
      if (($n['expiresAt'] ?? 0) <= $nowMs) continue;
      if (!$found && is_string($nonce) && ($n['nonce'] ?? null) === $nonce) { $found = true; continue; }
      $remaining[] = $n;
    }
    return [['nonces' => $remaining], $found];
  });
}

// Spent request nonces for signed admin requests, as [sha256(signerKey|nonce),
// expiresAtMs] pairs; check and write happen under one exclusive lock.
// Returns 'ok', 'replayed' or 'full'. Mirrors consumeAdminProofNonce().
function consume_admin_proof_nonce($signerKey, $nonce, $nowMs) {
  return atlas_admin_locked(atlas_admin_proof_nonces_file(), ['nonces' => []], function ($doc) use ($signerKey, $nonce, $nowMs) {
    $live = [];
    foreach (isset($doc['nonces']) && is_array($doc['nonces']) ? $doc['nonces'] : [] as $n) {
      if (is_array($n) && count($n) === 2 && $n[1] > $nowMs) $live[] = $n;
    }
    $key = rtrim(strtr(base64_encode(hash('sha256', $signerKey . '|' . $nonce, true)), '+/', '-_'), '=');
    foreach ($live as $n) { if ($n[0] === $key) return [['nonces' => $live], 'replayed']; }
    if (count($live) >= ATLAS_ADMIN_PROOF_NONCE_CAP) return [['nonces' => $live], 'full'];
    $live[] = [$key, $nowMs + atlas_admin_proof_nonce_retain_ms()];
    return [['nonces' => $live], 'ok'];
  });
}

// Failed-authentication and nonce-issue history per client. The key is the
// socket peer address (REMOTE_ADDR) only — never a forwarded-for header, which
// a client controls — hashed so addresses aren't stored. Behind a reverse
// proxy every client shares the proxy's address and so one budget. Bounded to
// ATLAS_ADMIN_LIMITER_MAX_CLIENTS entries per bucket.
function atlas_admin_client_key() {
  $addr = isset($_SERVER['REMOTE_ADDR']) && is_string($_SERVER['REMOTE_ADDR']) ? preg_replace('/^::ffff:/', '', $_SERVER['REMOTE_ADDR']) : 'unknown';
  return substr(hash('sha256', $addr), 0, 16);
}
// $mode: 'peek' (retry-after only), 'note' (record a hit), 'take' (record a hit
// only when under the limit). Returns seconds until the client may try again,
// or 0 when it is under the limit (for 'take', 0 means the hit was recorded).
function atlas_admin_limiter($bucket, $mode, $limit, $windowMs) {
  return atlas_admin_locked(atlas_admin_ratelimit_file(), ['failures' => [], 'nonceIssues' => [], 'moderationStatus' => []], function ($doc) use ($bucket, $mode, $limit, $windowMs) {
    $nowMs = atlas_now_ms();
    $client = atlas_admin_client_key();
    $map = isset($doc[$bucket]) && is_array($doc[$bucket]) ? $doc[$bucket] : [];
    foreach ($map as $k => $hits) {
      $kept = array_values(array_filter(is_array($hits) ? $hits : [], function ($t) use ($nowMs, $windowMs) { return is_int($t) && $nowMs - $t < $windowMs; }));
      if ($kept) $map[$k] = $kept; else unset($map[$k]);
    }
    $hits = isset($map[$client]) ? $map[$client] : [];
    $retry = 0;
    if ($mode !== 'note' && count($hits) >= $limit) $retry = max(1, (int) ceil(($hits[0] + $windowMs - $nowMs) / 1000));
    if ($mode === 'note' || ($mode === 'take' && !$retry)) {
      $hits[] = $nowMs;
      unset($map[$client]); // re-insert so array order stays oldest-first
      $map[$client] = $hits;
      while (count($map) > ATLAS_ADMIN_LIMITER_MAX_CLIENTS) { reset($map); unset($map[key($map)]); }
    }
    $doc[$bucket] = $map;
    return [$doc, $retry];
  });
}
function atlas_admin_failure_retry_after() { return atlas_admin_limiter('failures', 'peek', atlas_admin_fail_limit(), atlas_admin_fail_window_ms()); }
function atlas_admin_record_failure() { atlas_admin_limiter('failures', 'note', atlas_admin_fail_limit(), atlas_admin_fail_window_ms()); }
// Seconds until another login nonce may be issued to this client, or 0 after
// recording the issue.
function atlas_admin_take_nonce_slot() { return atlas_admin_limiter('nonceIssues', 'take', atlas_admin_nonce_per_client_per_min(), 60000); }
// Same, for moderation status statements.
function atlas_moderation_take_status_slot() { return atlas_admin_limiter('moderationStatus', 'take', atlas_moderation_status_per_client_per_min(), 60000); }

// Result shape shared by every admin gate: ['error','status','code'(,
// 'retryAfter','serverTime')] on refusal, ['publicKey'] on success.
function admin_failure($status, $code, $message, $extra = []) {
  return array_merge(['error' => $message, 'status' => $status, 'code' => $code], $extra);
}
function admin_rate_limited($retryAfter) {
  return admin_failure(429, 'rate-limited', 'too many failed admin authentication attempts; try again later', ['retryAfter' => $retryAfter]);
}
// Ends the request with the response for a refusal from admin_failure().
function admin_auth_fail($auth) {
  if (!empty($auth['retryAfter'])) header('Retry-After: ' . (int) $auth['retryAfter']);
  $body = ['error' => $auth['error'], 'code' => $auth['code']];
  if (!empty($auth['serverTime'])) $body['serverTime'] = $auth['serverTime'];
  if (!empty($auth['retryAfter'])) $body['retryAfter'] = (int) $auth['retryAfter'];
  send_json($auth['status'] ?? 401, $body);
}

// Checks payload.adminAuth = {action, domain, issuedAt, nonce} against the
// route being called. Returns a refusal, or null when it is well formed and
// fresh. Does not look at the signature.
function check_admin_auth_fields($payload, $action, $nowMs) {
  $a = is_array($payload) ? ($payload['adminAuth'] ?? null) : null;
  if (!is_array($a) || (array_keys($a) === range(0, count($a) - 1) && count($a) > 0)) {
    return admin_failure(401, 'auth-required', 'signed admin requests must carry payload.adminAuth {action, domain, issuedAt, nonce}');
  }
  if (($a['action'] ?? null) !== $action) return admin_failure(400, 'bad-request', 'payload.adminAuth.action must be ' . $action);
  if (($a['domain'] ?? null) !== atlas_domain()) return admin_failure(400, 'wrong-domain', 'payload.adminAuth.domain does not name this domain');
  $nonce = $a['nonce'] ?? null;
  if (!is_string($nonce) || strlen($nonce) < 16 || strlen($nonce) > 128) return admin_failure(400, 'bad-request', 'payload.adminAuth.nonce must be a string of 16 to 128 characters');
  $issuedMs = parse_iso_ms($a['issuedAt'] ?? null);
  if ($issuedMs === null) return admin_failure(400, 'bad-request', 'payload.adminAuth.issuedAt must be an ISO timestamp');
  if (abs($nowMs - $issuedMs) > atlas_admin_request_window_ms()) {
    return admin_failure(401, 'stale-request', 'request is outside the allowed time window', ['serverTime' => gmdate('Y-m-d\TH:i:s', intdiv($nowMs, 1000)) . sprintf('.%03dZ', $nowMs % 1000)]);
  }
  return null;
}

// Authenticates one signed admin request for $action (the route path). Shape
// and freshness first (cheap, no secret), then signature and roster, and the
// nonce is spent only after both pass, so unauthenticated traffic can never
// fill the nonce store. Mirrors authenticateAdminProof().
function authenticate_admin_proof($payload, $proof, $action, $need = 'admin') {
  if (!is_array($payload) || !is_array($proof)) return admin_failure(401, 'auth-required', 'payload and proof are required');
  $retryAfter = atlas_admin_failure_retry_after();
  if ($retryAfter) return admin_rate_limited($retryAfter);
  $nowMs = atlas_now_ms();
  $fieldError = check_admin_auth_fields($payload, $action, $nowMs);
  if ($fieldError) return $fieldError;
  if (!is_string($proof['publicKey'] ?? null) || $proof['publicKey'] === '' || !verify_mail_envelope($payload, $proof)) {
    atlas_admin_record_failure();
    return admin_failure(401, 'bad-signature', 'admin signature does not check out');
  }
  $authority = admin_authority($proof['publicKey']);
  if (!$authority) {
    atlas_admin_record_failure();
    return admin_failure(401, 'not-admin', 'this key is not a registered domain admin');
  }
  // A valid signature from a key without the needed role is refused before the
  // nonce is spent; it is not a failed authentication, so it is not throttled.
  if (!admin_authority_allows($authority, $need)) return admin_insufficient_role($authority);
  $spent = consume_admin_proof_nonce($proof['publicKey'], $payload['adminAuth']['nonce'], $nowMs);
  if ($spent === 'replayed') {
    atlas_admin_record_failure();
    return admin_failure(401, 'replayed-request', 'this request has already been used');
  }
  if ($spent === 'full') return admin_failure(503, 'busy', 'too many recent admin requests; try again shortly');
  return ['publicKey' => $proof['publicKey'], 'authority' => $authority];
}

// Authenticates a login: a roster key's signature over a server-issued
// single-use nonce, bound to this route and domain. Returns a refusal, or
// null (the nonce is then spent). Mirrors authenticateAdminLogin().
function authenticate_admin_login($payload, $proof) {
  if (!is_array($payload) || !is_array($proof)) return admin_failure(401, 'auth-required', 'payload and proof are required');
  $retryAfter = atlas_admin_failure_retry_after();
  if ($retryAfter) return admin_rate_limited($retryAfter);
  $a = $payload['adminAuth'] ?? null;
  if (!is_array($a) || ($a['action'] ?? null) !== '/atlas/admin/session/start') {
    return admin_failure(401, 'auth-required', 'login payload must carry adminAuth {action: "/atlas/admin/session/start", domain}');
  }
  if (($a['domain'] ?? null) !== atlas_domain()) return admin_failure(400, 'wrong-domain', 'payload.adminAuth.domain does not name this domain');
  if (!is_string($payload['nonce'] ?? null) || $payload['nonce'] === '') return admin_failure(400, 'bad-request', 'payload.nonce is required');
  if (!is_string($proof['publicKey'] ?? null) || $proof['publicKey'] === '' || !verify_mail_envelope($payload, $proof)) {
    atlas_admin_record_failure();
    return admin_failure(401, 'bad-signature', 'admin signature does not check out');
  }
  // Any active roster role may sign in; what the session can then do is
  // decided per request by require_admin_auth().
  if (!admin_authority($proof['publicKey'])) {
    atlas_admin_record_failure();
    return admin_failure(401, 'not-admin', 'this key is not a registered domain admin');
  }
  if (!consume_admin_nonce($payload['nonce'])) {
    atlas_admin_record_failure();
    return admin_failure(401, 'bad-nonce', 'nonce is missing, unknown, already used, or expired');
  }
  return null;
}

// Demo login (atlas-admin/../login-demo.html): same single-use-nonce
// mechanics as issue_admin_nonce()/consume_admin_nonce() above, kept in a
// separate file rather than shared — an admin nonce and a demo-login nonce
// authorize completely different things, and there's no roster check here
// at all: holding a live, unrevoked atlas.demo.login.badge (an ordinary,
// ungated credential) IS the authorization, checked fresh at sign-in time
// by check_presented_membership().
function atlas_login_nonces_file() {
  return __DIR__ . '/atlas-login-nonces-store.json';
}
const ATLAS_LOGIN_NONCE_TTL_MS = 120000;

function issue_login_nonce() {
  $fh = fopen(atlas_login_nonces_file(), 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['nonces'])) $doc = ['nonces' => []];
  $nowMs = (int) round(microtime(true) * 1000);
  $doc['nonces'] = array_values(array_filter($doc['nonces'], function ($n) use ($nowMs) { return ($n['expiresAt'] ?? 0) > $nowMs; }));
  $nonce = b64url_encode(random_bytes(24));
  $doc['nonces'][] = ['nonce' => $nonce, 'expiresAt' => $nowMs + ATLAS_LOGIN_NONCE_TTL_MS];
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $nonce;
}
function consume_login_nonce($nonce) {
  $fh = fopen(atlas_login_nonces_file(), 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['nonces'])) $doc = ['nonces' => []];
  $nowMs = (int) round(microtime(true) * 1000);
  $found = false;
  $remaining = [];
  foreach ($doc['nonces'] as $n) {
    if (($n['expiresAt'] ?? 0) <= $nowMs) continue;
    if (!$found && is_string($nonce) && ($n['nonce'] ?? null) === $nonce) { $found = true; continue; }
    $remaining[] = $n;
  }
  $doc['nonces'] = $remaining;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $found;
}

// Spent request nonces for authenticated mail reads (SPEC.md §11.8), as
// [sha256(signerKey|nonce), expiresAtMs] pairs. Check and write happen under
// one exclusive lock, so concurrent requests carrying the same nonce cannot
// both pass. Mirrors issuer-server/server.js's consumeMailNonce().
const ATLAS_MAIL_NONCE_CAP = 20000;
function atlas_mail_nonces_file() {
  return __DIR__ . '/atlas-mail-nonces-store.json';
}
function consume_mail_nonce($signerKey, $nonce, $nowMs, $retainMs) {
  $fh = fopen(atlas_mail_nonces_file(), 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  $live = [];
  if (is_array($doc) && isset($doc['nonces']) && is_array($doc['nonces'])) {
    foreach ($doc['nonces'] as $n) {
      if (is_array($n) && count($n) === 2 && $n[1] > $nowMs) $live[] = $n;
    }
  }
  $key = rtrim(strtr(base64_encode(hash('sha256', $signerKey . '|' . $nonce, true)), '+/', '-_'), '=');
  $result = 'ok';
  foreach ($live as $n) { if ($n[0] === $key) { $result = 'replayed'; break; } }
  if ($result === 'ok' && count($live) >= ATLAS_MAIL_NONCE_CAP) $result = 'full';
  if ($result === 'ok') {
    $live[] = [$key, $nowMs + $retainMs];
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode(['nonces' => $live]));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}

// A session records when it was created and the latest moment it may live
// until however active it is (absoluteExpiresAt). Sessions written before
// absoluteExpiresAt existed carry neither and are refused (see
// check_admin_session()), so every admin signs in again once after an upgrade.
function create_admin_session($publicKey) {
  return atlas_admin_locked(atlas_admin_sessions_file(), ['sessions' => []], function ($doc) use ($publicKey) {
    $nowMs = atlas_now_ms();
    $sessions = array_values(array_filter(isset($doc['sessions']) && is_array($doc['sessions']) ? $doc['sessions'] : [], function ($s) use ($nowMs) { return ($s['expiresAt'] ?? 0) > $nowMs; }));
    $token = b64url_encode(random_bytes(32));
    $absoluteExpiresAt = $nowMs + atlas_admin_session_max_ms();
    $expiresAt = min($nowMs + ATLAS_ADMIN_SESSION_TTL_MS, $absoluteExpiresAt);
    $sessions[] = ['token' => $token, 'publicKey' => $publicKey, 'createdAt' => $nowMs, 'expiresAt' => $expiresAt, 'absoluteExpiresAt' => $absoluteExpiresAt];
    return [['sessions' => $sessions], ['token' => $token, 'expiresAt' => $expiresAt, 'absoluteExpiresAt' => $absoluteExpiresAt]];
  });
}
// Validates a session token and, on success, slides its idle expiry forward
// (never past absoluteExpiresAt). The session is re-checked against the
// CURRENT roster on every call: when its key has been removed or marked
// revoked, all of that key's sessions are deleted and the request is refused.
// Returns ['publicKey', 'authority'] or ['code' => 'unknown'|'not-admin']. hash_equals()
// keeps the token comparison constant-time.
function check_admin_session($token) {
  return atlas_admin_locked(atlas_admin_sessions_file(), ['sessions' => []], function ($doc) use ($token) {
    $nowMs = atlas_now_ms();
    $live = [];
    foreach (isset($doc['sessions']) && is_array($doc['sessions']) ? $doc['sessions'] : [] as $s) {
      if (($s['expiresAt'] ?? 0) <= $nowMs) continue;
      if (!isset($s['absoluteExpiresAt']) || !is_int($s['absoluteExpiresAt']) || $s['absoluteExpiresAt'] <= $nowMs) continue;
      $live[] = $s;
    }
    $idx = null;
    if (is_string($token) && $token !== '') {
      foreach ($live as $i => $s) {
        if (hash_equals((string) ($s['token'] ?? ''), $token)) { $idx = $i; break; }
      }
    }
    if ($idx === null) return [['sessions' => $live], ['code' => 'unknown']];
    $publicKey = $live[$idx]['publicKey'];
    // The role is looked up now, not stored in the session: a demotion or
    // removal applies to the next request.
    $authority = admin_authority($publicKey);
    if (!$authority) {
      $kept = array_values(array_filter($live, function ($s) use ($publicKey) { return $s['publicKey'] !== $publicKey; }));
      return [['sessions' => $kept], ['code' => 'not-admin']];
    }
    $live[$idx]['expiresAt'] = min($nowMs + ATLAS_ADMIN_SESSION_TTL_MS, $live[$idx]['absoluteExpiresAt']);
    return [['sessions' => $live], ['publicKey' => $publicKey, 'authority' => $authority]];
  });
}
// Idempotent and constant-shape whether or not the token was ever valid —
// same reasoning as issuer-server/server.js's deleteAdminSession().
function delete_admin_session($token) {
  atlas_admin_locked(atlas_admin_sessions_file(), ['sessions' => []], function ($doc) use ($token) {
    $nowMs = atlas_now_ms();
    $sessions = array_values(array_filter(isset($doc['sessions']) && is_array($doc['sessions']) ? $doc['sessions'] : [], function ($s) use ($nowMs, $token) {
      if (($s['expiresAt'] ?? 0) <= $nowMs) return false;
      if (is_string($token) && hash_equals((string) ($s['token'] ?? ''), $token)) return false;
      return true;
    }));
    return [['sessions' => $sessions], null];
  });
}

// The authorization check every admin-gated route uses: EITHER an active
// session token (check_admin_session()) OR a freshly signed request
// (authenticate_admin_proof()) bound to $action, the route path. A token,
// when given, takes priority and is checked on its own. A valid session is
// honoured even while the client's failed-attempt budget is spent; only a
// failed one counts against it.
//
// $need is the scope the route requires and defaults to 'admin': a route that
// says nothing is administrator-only, so a moderator reaches only the routes
// that explicitly ask for 'moderation'. Returns a refusal (isset($r['error']);
// pass it to admin_auth_fail()) or ['publicKey', 'authority'].
function require_admin_auth($payload, $proof, $token, $action, $need = 'admin') {
  if (is_string($token) && $token !== '') {
    $checked = check_admin_session($token);
    if (isset($checked['publicKey'])) {
      if (!admin_authority_allows($checked['authority'], $need)) return admin_insufficient_role($checked['authority']);
      return ['publicKey' => $checked['publicKey'], 'authority' => $checked['authority']];
    }
    $retryAfter = atlas_admin_failure_retry_after();
    if ($retryAfter) return admin_rate_limited($retryAfter);
    atlas_admin_record_failure();
    return $checked['code'] === 'not-admin'
      ? admin_failure(401, 'not-admin', 'this key is not a registered domain admin')
      : admin_failure(401, 'session-invalid', 'session is missing, unknown, or expired');
  }
  return authenticate_admin_proof($payload, $proof, $action, $need);
}

// ---------- Moderation grants ----------
//
// Mirrors issuer-server/server.js. A grant is a short-lived statement, signed
// by this domain's issuer key, that one roster key may perform named
// moderation operations in named worlds at one presence service, provable only
// by whoever holds an ephemeral private key. Format, trust model and
// verification steps: docs/moderation-authorization.md. Nothing here moderates
// anything.
const ATLAS_MODERATION_GRANT_TYPE = 'atlas.moderation-grant';
const ATLAS_MODERATION_GRANT_VERSION = 1;
const ATLAS_MODERATION_GRANT_SIGN_CONTEXT = "atlas-moderation-grant/v1\n";
const ATLAS_MODERATION_REF_CONTEXT = "atlas-moderator-ref/v1\n";
const ATLAS_MODERATION_GRANT_MAX_TTL_S = 600; // hard ceiling, 10 minutes
const ATLAS_MODERATION_GRANT_DEFAULT_TTL_S = 300;
const ATLAS_MODERATION_REQUEST_FIELDS = ['audience', 'worlds', 'operations', 'ttlSeconds', 'popPublicKey', 'adminAuth'];
// Moderation status statement: an issuer-signed, short-lived list of the keys
// that hold moderation authority right now, which a presence service must see
// (and re-fetch) before it acts on any grant. Mirrors issuer-server/server.js.
const ATLAS_MODERATION_STATUS_TYPE = 'atlas.moderation-status';
const ATLAS_MODERATION_STATUS_VERSION = 1;
const ATLAS_MODERATION_STATUS_SIGN_CONTEXT = "atlas-moderation-status/v1\n";
function atlas_moderation_status_ttl_s() { return min(120, max(1, atlas_env_positive_int('ATLAS_MODERATION_STATUS_TTL_S', 60))); }
function atlas_moderation_status_per_client_per_min() { return atlas_env_positive_int('ATLAS_MODERATION_STATUS_PER_CLIENT_PER_MIN', 120); }

function atlas_moderation_config_file() {
  return __DIR__ . '/atlas-moderation-config.json';
}
function atlas_moderation_grants_file() {
  return __DIR__ . '/atlas-moderation-grants-store.json';
}
function atlas_moderation_max_live_grants() { return atlas_env_positive_int('ATLAS_MODERATION_MAX_LIVE_GRANTS', 10); }

// Operator-edited, like the roster: {"domain": "example.com", "audiences":
// ["https://presence.example.com"]}. `domain` is the domain name the grants
// carry; it is configured here, never taken from the Host header, and the
// grant route refuses when Host disagrees. `audiences` lists the only presence
// endpoints a grant may be addressed to; the environment variable
// ATLAS_MODERATION_AUDIENCES (comma-separated) overrides the file's list.
function atlas_moderation_config() {
  $cfg = ['domain' => null, 'audiences' => []];
  $path = atlas_moderation_config_file();
  if (file_exists($path)) {
    $f = json_decode(file_get_contents($path), true);
    if (is_array($f)) {
      if (isset($f['domain']) && is_string($f['domain']) && $f['domain'] !== '') $cfg['domain'] = $f['domain'];
      if (isset($f['audiences']) && is_array($f['audiences'])) $cfg['audiences'] = $f['audiences'];
    }
  }
  $env = getenv('ATLAS_MODERATION_AUDIENCES');
  if ($env !== false) $cfg['audiences'] = array_values(array_filter(array_map('trim', explode(',', $env)), 'strlen'));
  $cfg['audiences'] = array_values(array_filter($cfg['audiences'], 'atlas_is_presence_origin'));
  return $cfg;
}
// A presence endpoint identifier: scheme://host[:port], lowercase, no path.
function atlas_is_presence_origin($s) {
  return is_string($s) && strlen($s) <= 255 && preg_match('#^https?://(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$#', $s) === 1;
}
// Stable, non-reversible reference to a moderator for one domain.
function atlas_moderator_ref($domain, $publicKey) {
  return b64url_encode(hash('sha256', ATLAS_MODERATION_REF_CONTEXT . $domain . "\n" . $publicKey, true));
}
function atlas_valid_pop_public_key($b64) {
  if (!is_string($b64) || preg_match('/^[A-Za-z0-9_-]{87}$/', $b64) !== 1) return false;
  $raw = b64url_decode($b64);
  if (!is_string($raw) || strlen($raw) !== 65 || ord($raw[0]) !== 4) return false;
  if (b64url_encode($raw) !== $b64) return false; // one canonical spelling per key
  try {
    return openssl_pkey_get_public(ec_raw_point_to_pem($raw)) !== false; // rejects points not on the curve
  } catch (Exception $e) {
    return false;
  }
}
// Validates a grant request payload. Returns ['request' => [...]] or
// ['error' => admin_failure(...)]. Strict: an unknown field is an error.
function atlas_parse_grant_request($payload, $requesterKey, $issuerKey) {
  $bad = function ($m) { return ['error' => admin_failure(400, 'bad-request', $m)]; };
  if (!is_array($payload) || ($payload !== [] && atlas_array_is_list($payload))) return $bad('payload must be an object');
  foreach (array_keys($payload) as $k) if (!in_array($k, ATLAS_MODERATION_REQUEST_FIELDS, true)) return $bad('unknown field in payload: ' . $k);
  $audience = $payload['audience'] ?? null;
  if (!is_string($audience) || !atlas_is_presence_origin($audience)) return $bad('payload.audience must be a presence origin such as https://presence.example.com');
  $worlds = $payload['worlds'] ?? null;
  if ($worlds !== '*') {
    if (!is_array($worlds) || !atlas_array_is_list($worlds) || count($worlds) < 1 || count($worlds) > ATLAS_MODERATION_MAX_WORLDS) {
      return $bad('payload.worlds must be "*" or an array of 1 to ' . ATLAS_MODERATION_MAX_WORLDS . ' distinct world ids');
    }
    foreach ($worlds as $w) if (!atlas_valid_world_id($w)) return $bad('payload.worlds must be "*" or an array of 1 to ' . ATLAS_MODERATION_MAX_WORLDS . ' distinct world ids');
    if (count(array_unique($worlds)) !== count($worlds)) return $bad('payload.worlds must be "*" or an array of 1 to ' . ATLAS_MODERATION_MAX_WORLDS . ' distinct world ids');
  }
  $ops = $payload['operations'] ?? null;
  $opsMsg = 'payload.operations must be 1 or more distinct names from: ' . implode(', ', ATLAS_MODERATION_OPERATIONS);
  if (!is_array($ops) || !atlas_array_is_list($ops) || count($ops) < 1 || count($ops) > count(ATLAS_MODERATION_OPERATIONS)) return $bad($opsMsg);
  foreach ($ops as $o) if (!is_string($o) || !in_array($o, ATLAS_MODERATION_OPERATIONS, true)) return $bad($opsMsg);
  if (count(array_unique($ops)) !== count($ops)) return $bad($opsMsg);
  $ttl = ATLAS_MODERATION_GRANT_DEFAULT_TTL_S;
  if (array_key_exists('ttlSeconds', $payload)) {
    $t = $payload['ttlSeconds'];
    $isInt = is_int($t) || (is_float($t) && floor($t) == $t && is_finite($t));
    if (!$isInt || $t < 1 || $t > ATLAS_MODERATION_GRANT_MAX_TTL_S) return $bad('payload.ttlSeconds must be an integer from 1 to ' . ATLAS_MODERATION_GRANT_MAX_TTL_S);
    $ttl = (int) $t;
  }
  $pop = $payload['popPublicKey'] ?? null;
  if (!atlas_valid_pop_public_key($pop)) return $bad('payload.popPublicKey must be a raw P-256 public key (65 bytes, base64url)');
  if ($pop === $requesterKey || $pop === $issuerKey) return $bad('payload.popPublicKey must be a fresh ephemeral key, not a long-term identity or issuer key');
  return ['request' => ['audience' => $audience, 'worlds' => $worlds, 'operations' => array_values($ops), 'ttl' => $ttl, 'popPublicKey' => $pop]];
}
// Is every requested world and operation inside the key's CURRENT authority?
function atlas_grant_within_authority($authority, $request) {
  foreach ($request['operations'] as $o) {
    if ($authority['operations'] !== '*' && !in_array($o, $authority['operations'], true)) return false;
  }
  if ($request['worlds'] === '*') return $authority['worlds'] === '*';
  if ($authority['worlds'] === '*') return true;
  foreach ($request['worlds'] as $w) if (!in_array($w, $authority['worlds'], true)) return false;
  return true;
}
// Reserves one live-grant slot for the moderator and records the grant, in one
// locked step. Returns false when the moderator already holds the maximum.
function atlas_record_moderation_grant($entry, $nowMs) {
  return atlas_admin_locked(atlas_moderation_grants_file(), ['grants' => []], function ($doc) use ($entry, $nowMs) {
    $live = array_values(array_filter(isset($doc['grants']) && is_array($doc['grants']) ? $doc['grants'] : [], function ($g) use ($nowMs) { return is_array($g) && ($g['expiresAtMs'] ?? 0) > $nowMs; }));
    $mine = 0;
    foreach ($live as $g) if (($g['moderatorRef'] ?? null) === $entry['moderatorRef']) $mine++;
    if ($mine >= atlas_moderation_max_live_grants()) return [['grants' => $live], false];
    $live[] = $entry;
    return [['grants' => $live], true];
  });
}

// Every roster key that holds authority right now, as the status statement
// lists it: the moderator reference and the worlds and operations in force.
// Administrators appear with every world and operation. A key with no
// authority, or with an empty scope, is left out.
function atlas_moderation_status_moderators($domain) {
  $path = atlas_admin_keys_file();
  if (!file_exists($path)) return [];
  $doc = json_decode(file_get_contents($path), true);
  $keys = is_array($doc) && isset($doc['keys']) && is_array($doc['keys']) ? $doc['keys'] : [];
  $seen = [];
  $out = [];
  foreach ($keys as $k) {
    if (!is_array($k) || !isset($k['publicKey']) || !is_string($k['publicKey']) || isset($seen[$k['publicKey']])) continue;
    $seen[$k['publicKey']] = true;
    $a = admin_authority($k['publicKey']);
    if (!$a) continue;
    $operations = $a['operations'] === '*' ? ATLAS_MODERATION_OPERATIONS : $a['operations'];
    if ($a['worlds'] !== '*' && !count($a['worlds'])) continue;
    if (!count($operations)) continue;
    $out[] = ['moderatorRef' => atlas_moderator_ref($domain, $k['publicKey']), 'worlds' => $a['worlds'], 'operations' => array_values($operations)];
  }
  usort($out, function ($x, $y) { return strcmp($x['moderatorRef'], $y['moderatorRef']); });
  return $out;
}

// Trading Station membership roster — same flat-array
// shape as atlas_postoffice_members_file() above, kept as its own file for
// the same reason Post Office's is separate from the plain subscriber
// roster: a Trading Station membership is a different class, gating a
// different endpoint (POST /atlas/trade/submit instead of
// /atlas/postoffice/send). Not actually consulted as an abuse gate the way
// Post Office's roster is — /atlas/trade/submit instead validates the
// membership credential presented WITH the request (same "prove you hold
// it, right now, signed" shape check_presented_asset already uses for a
// trade balance) — this roster exists for the same future-facing reason
// as directory federation: a self-contained,
// appendable record of who's joined. Mirrors issuer-server/server.js's
// TRADINGSTATION_MEMBERS_FILE.
function atlas_tradingstation_members_file() {
  return __DIR__ . '/atlas-tradingstation-members-store.json';
}

// Pending remote trade intents (task #144 Phase 1) — one entry per
// submitted-but-not-yet-matched intent, holding both the signed intent
// envelope and the presented balance credential exactly as submitted, so a
// later matching call has everything it needs to settle without asking the
// original submitter to resend anything. Same flock-guarded flat-array
// shape as every other store in this file. Removed once matched
// (remove_pending_trade()) or once found expired (pruned lazily wherever
// this store is read for matching, not on a timer — same "no background
// sweep" simplicity as the rest of this demo). Mirrors issuer-server/
// server.js's PENDING_TRADES_FILE.
function atlas_pending_trades_file() {
  return __DIR__ . '/atlas-pending-trades-store.json';
}

// Relay-settle result store (SPEC.md §7 v1.35), keyed by tradeId — makes
// POST /atlas/trade/relay-settle idempotent. Without this, a relaying
// station that genuinely settled a foreign leg but never received the
// HTTP response (a dropped connection, a timeout after this domain
// already committed) had no way to tell that apart from the settle
// never having happened at all — atlas_relay_trade_settle()'s own retry
// treated BOTH the same way, which meant a caller that then (wrongly)
// assumed failure could revoke the very mail gift this domain just
// delivered for real. Recording the result here lets a retry of the
// EXACT SAME (tradeId, credentialId) replay what already happened
// instead of erroring on "already revoked" or re-mutating anything —
// see atlas/trade/relay-settle.php's own comment on where this is
// consulted. Same flock-guarded flat-array shape as every other store
// in this file; never pruned, same reasoning as atlas_asset_updates_file()
// above (a small, slow-growing demo-scale log). Mirrors issuer-server/
// server.js's RELAY_SETTLE_RESULTS_FILE.
function atlas_relay_settle_results_file() {
  return __DIR__ . '/atlas-relay-settle-results-store.json';
}

// World drops (task #250, SPEC.md §5.5): "others can see it and pick it up"
// needs a world to actually host and mutate shared state — this is that
// state, one flat array of currently-live drops across every world this
// domain hosts (scoped by each entry's own `world` string, whatever the
// requesting client's own scene/manifest happens to call it — this bundle
// has no independent notion of what worlds exist, same as issuer-server/
// server.js). Same "not web-reachable, flock-guarded flat array" shape as
// mail/asset-updates/subscribers above. Mirrors issuer-server/server.js's
// WORLD_DROPS_FILE/readWorldDrops()/appendWorldDrop()/removeWorldDrop().
function atlas_world_drops_file() {
  return __DIR__ . '/atlas-world-drops-store.json';
}

// Domain calendar (SPEC.md §12): one flat list of events, each tagged with
// the `worldId` it belongs to (null for the domain-wide calendar), same
// "one file, filter on read" shape atlas_world_drops_file() above uses —
// this bundle has no bound on how many worlds might opt in (manifest
// `calendar: true`, §3), and a single small JSON file scales fine for a
// demo of this size. Mirrors issuer-server/server.js's CALENDAR_FILE. This
// bundle does not itself check that a given worldId actually has
// `calendar: true` in the manifest before serving or accepting events for
// it — same "client-side-only gate" posture the (unrelated,
// undocumented-in-SPEC.md) chat opt-in already has; the manifest is what a
// client reads to decide whether to ask at all.
function atlas_calendar_file() {
  return __DIR__ . '/atlas-calendar-store.json';
}

function read_world_drops() {
  $fh = fopen(atlas_world_drops_file(), 'c+');
  if ($fh === false) return ['drops' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['drops' => []];
}

function append_world_drop($entry) {
  $file = atlas_world_drops_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['drops' => []];
  $doc['drops'][] = $entry;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// Third-party attestations (SPEC.md §5.11) — same plain flock()-guarded
// read/append shape as read_world_drops()/append_world_drop() above.
// Mirrors issuer-server/server.js's ATTESTATIONS_FILE/readAttestations()/
// appendAttestation(). No remove function: an attestation only ever stops
// being valid by revocation (is_revoked(), the same list every other
// credential id already uses), never by being deleted out from under a
// client that might still be showing it.
function atlas_attestations_file() {
  return __DIR__ . '/atlas-attestations-store.json';
}
function read_attestations() {
  $fh = fopen(atlas_attestations_file(), 'c+');
  if ($fh === false) return ['attestations' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['attestations' => []];
}
function append_attestation($entry) {
  $file = atlas_attestations_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['attestations' => []];
  $doc['attestations'][] = $entry;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// K-of-N treasury approvals (bank-demo.html) — mirrors
// issuer-server/server.js's BANK_APPROVALS_FILE/readBankApprovals()/
// saveBankApproval(). Unlike that single-threaded Node store, this one
// needs the same flock-guarded read/modify/write shape as the admin
// nonces/sessions above: two officers signing at nearly the same moment
// is exactly the case a plain read-then-write would race on PHP's
// multi-process model. Deliberately does NOT back the approver roster
// with a persistent, revocable membership credential the way a real
// deployment should — each request simply names its own authorized
// public keys inline; see the Node store's own comment for the full
// reasoning.
const ATLAS_BANK_APPROVAL_TTL_MS = 3600000; // an hour, in ms — plenty for one demo walkthrough
const ATLAS_BANK_APPROVAL_MIN_APPROVERS = 2;
const ATLAS_BANK_APPROVAL_MAX_APPROVERS = 10;
const ATLAS_BANK_APPROVAL_MAX_AMOUNT = 1000000;
const ATLAS_DEMO_BANK_ASSET_CLASS = 'atlas.credit.balance'; // the existing spendable-balance class, reused rather than minting a second one

// reserve-bank-demo.html's own K-of-N mint request store — mirrors
// issuer-server/server.js's RESERVE_MINT_APPROVALS_FILE (own file rather
// than sharing atlas-bank-approvals-store.json, so the two demos' pending
// requests never collide). Same TTL/approver/amount limits as the
// treasury-transfer demo above.
function atlas_reserve_mint_approvals_file() {
  return __DIR__ . '/atlas-reserve-mint-approvals-store.json';
}

// reserve-bank-demo.html's own "sibling domains vote" extension — mirrors
// issuer-server/server.js's RESERVE_MINT_CONSORTIUM_FILE. The same K-of-N
// mint above, except the N approvers are other DOMAINS' own servers, not
// individual officers simulated in one browser tab — each approving
// domain's own admin has to actually act, from that domain's own admin
// panel (see atlas/demo/reserve/consortium/co-sign.php). Own file for the
// same reason atlas_reserve_mint_approvals_file() is its own file rather
// than sharing the bank-demo one.
function atlas_reserve_mint_consortium_file() {
  return __DIR__ . '/atlas-reserve-mint-consortium-store.json';
}
// Twice ATLAS_BANK_APPROVAL_TTL_MS's hour — a real multi-domain rollout
// spans separately-run infrastructure, so getting a human admin at each
// sibling domain to notice and act takes longer than one browser tab's
// own simulated officer clicking a button.
const ATLAS_CONSORTIUM_APPROVAL_TTL_MS = 7200000;
// Deliberately smaller than the officer committees above (up to 10): this
// models a handful of real, separately-run sibling domains, not a large
// anonymous committee.
const ATLAS_CONSORTIUM_MIN_DOMAINS = 2;
const ATLAS_CONSORTIUM_MAX_DOMAINS = 5;

// Governance/voting demo (governance-demo.html) — mirrors
// issuer-server/server.js's GOVERNANCE_MEMBERS_FILE/GOVERNANCE_PROPOSALS_FILE.
function atlas_governance_members_file() {
  return __DIR__ . '/atlas-governance-members-store.json';
}
function atlas_governance_proposals_file() {
  return __DIR__ . '/atlas-governance-proposals-store.json';
}

// Oracle-triggered payout demo (oracle-demo.html) — mirrors
// issuer-server/server.js's ORACLE_POLICIES_FILE.
function atlas_oracle_policies_file() {
  return __DIR__ . '/atlas-oracle-policies-store.json';
}
// Mirrors issuer-server/server.js's ORACLE_FLIGHT_NUMBER_RE/
// ORACLE_DELAY_PAYOUT_THRESHOLD_MINUTES.
const ATLAS_ORACLE_FLIGHT_NUMBER_RE = '/^[A-Z]{2}[0-9]{2,4}$/';
const ATLAS_ORACLE_DELAY_PAYOUT_THRESHOLD_MINUTES = 120;

// Supply-chain provenance + recall demo (recall-demo.html) — the one class
// this domain lets a live visitor issue a recall against, same "hardcoded
// to its own toy" narrowing atlas_demo_suspendable_classes() gives
// clawback-demo.html's fraud act, kept as a short list for the same reason
// even though there's only one entry today. Mirrors issuer-server/
// server.js's DEMO_SUPPLYCHAIN_WIDGET_CLASS/DEMO_RECALLABLE_CLASSES.
const ATLAS_DEMO_SUPPLYCHAIN_WIDGET_CLASS = 'atlas.demo.supplychain.widget';
function atlas_demo_recallable_classes() {
  return [ATLAS_DEMO_SUPPLYCHAIN_WIDGET_CLASS];
}
// Fixed recall notice text, same short-allow-list-instead-of-free-text
// discipline atlas_demo_attestation_claims() already applies — a visitor
// picks one of these, never writes the property value directly. Mirrors
// issuer-server/server.js's DEMO_RECALL_REASONS.
function atlas_demo_recall_reasons() {
  return [
    'battery-defect' => 'RECALLED: battery cell defect poses a fire risk. Stop using immediately and contact the manufacturer for a replacement.',
    'choking-hazard' => 'RECALLED: a small part may detach and present a choking hazard. Stop using immediately and contact the manufacturer for a replacement.',
  ];
}

const ATLAS_DEMO_CLAWBACK_TOKEN_CLASS = 'atlas.demo.clawback.token';
const ATLAS_DEMO_ALPHA_DOLLAR_CLASS = 'atlas.currency.alpha';
const ATLAS_DEMO_BETA_DOLLAR_CLASS = 'atlas.currency.beta';
const ATLAS_DEMO_RESERVE_CLASS = 'atlas.currency.reserve';

// reserve-bank-demo.html's own fraud/clawback act reuses the suspend/
// unsuspend/clawback endpoints below, widened from a single hardcoded
// class to this short allow-list — mirrors issuer-server/server.js's
// DEMO_SUSPENDABLE_CLASSES.
function atlas_demo_suspendable_classes() {
  return [ATLAS_DEMO_CLAWBACK_TOKEN_CLASS, ATLAS_DEMO_ALPHA_DOLLAR_CLASS, ATLAS_DEMO_BETA_DOLLAR_CLASS];
}

function atlas_bank_approvals_file() {
  return __DIR__ . '/atlas-bank-approvals-store.json';
}
// Read-only view, expired pending entries filtered out — same "one file,
// filter on read" convention as read_pending_trades(). A plain shared-lock
// read is safe here even though writers use an exclusive lock elsewhere:
// nothing here mutates the file.
function read_bank_approvals() {
  $fh = fopen(atlas_bank_approvals_file(), 'c+');
  if ($fh === false) return ['approvals' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc) || !isset($doc['approvals'])) $doc = ['approvals' => []];
  $nowMs = (int) round(microtime(true) * 1000);
  $doc['approvals'] = array_values(array_filter($doc['approvals'], function ($a) use ($nowMs) {
    return ($a['status'] ?? 'pending') !== 'pending' || strtotime($a['expiresAt']) * 1000 > $nowMs;
  }));
  return $doc;
}
function find_bank_approval($id) {
  foreach (read_bank_approvals()['approvals'] as $a) {
    if ($a['id'] === $id) return $a;
  }
  return null;
}
// Upserts one approval under an exclusive lock held across the whole
// read-modify-write — the actual concurrency guard POST
// /atlas/demo/bank/approval/sign depends on: two officers' signatures
// arriving as two nearly-simultaneous requests must never both read the
// same pre-signature state and each write back only their own addition,
// silently dropping one.
function save_bank_approval($approval) {
  $file = atlas_bank_approvals_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['approvals'])) $doc = ['approvals' => []];
  $found = false;
  foreach ($doc['approvals'] as $i => $a) {
    if ($a['id'] === $approval['id']) { $doc['approvals'][$i] = $approval; $found = true; break; }
  }
  if (!$found) $doc['approvals'][] = $approval;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}
// The exact bytes every approver signs (SPEC.md §6.2's canonical-payload
// mechanism, verify_envelope() in bootstrap.php) — mirrors
// issuer-server/server.js's bankApprovalPayloadOf(). See that function's
// own comment for why this excludes everything but id/action — WYSIWYS.
function bank_approval_payload_of($approval) {
  return ['id' => $approval['id'], 'action' => $approval['action']];
}

// The actual concurrency-sensitive operation — everything from "find this
// request" through "write the new signature (and mint, if it just
// crossed the threshold) back" happens under ONE lock held for the whole
// sequence, unlike find_bank_approval()/save_bank_approval() above (each
// its own separate lock, fine for a plain read or an already-fully-formed
// write, but exactly what would race here: two officers' signatures
// arriving as nearly-simultaneous requests must never both read the same
// pre-signature state and each write back only their own addition,
// silently dropping one). Returns ['error' => '...'] or ['approval' =>
// the current/updated record] — atlas/demo/bank/approval/sign.php just
// turns that straight into the HTTP response.
function sign_bank_approval($id, $proof) {
  $file = atlas_bank_approvals_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['approvals'])) $doc = ['approvals' => []];

  $nowMs = (int) round(microtime(true) * 1000);
  $idx = null;
  foreach ($doc['approvals'] as $i => $a) {
    if ($a['id'] !== $id) continue;
    if (($a['status'] ?? 'pending') === 'pending' && strtotime($a['expiresAt']) * 1000 <= $nowMs) break; // expired — treat as not found, same as read_bank_approvals()'s filter
    $idx = $i;
    break;
  }
  if ($idx === null) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'no such approval request (or it already expired)'];
  }

  $approval = $doc['approvals'][$idx];
  if ($approval['status'] !== 'pending') {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'this request is already ' . $approval['status']];
  }
  if (!in_array($proof['publicKey'] ?? null, $approval['approvers'], true)) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'this key is not an authorized approver for this request'];
  }
  foreach ($approval['signatures'] as $s) {
    if ($s['publicKey'] === $proof['publicKey']) {
      flock($fh, LOCK_UN);
      fclose($fh);
      return ['approval' => $approval]; // already signed — idempotent, not an error
    }
  }

  $sigOk = verify_envelope(bank_approval_payload_of($approval), $proof);
  if (!$sigOk) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'approval signature does not check out'];
  }

  $approval['signatures'][] = [
    'publicKey' => $proof['publicKey'],
    'signerRole' => $proof['signerRole'],
    'signature' => $proof['signature'],
    'signedAt' => iso_now(),
  ];
  if (count($approval['signatures']) >= $approval['requiredApprovals']) {
    $kp = atlas_load_keys();
    $credential = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $approval['action']['toPublicKey'], $approval['action']['assetClass'], $approval['action']['amount'], null);
    $approval['status'] = 'executed';
    $approval['executedCredentialId'] = $credential['id'];
  }
  $doc['approvals'][$idx] = $approval;

  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return ['approval' => $approval];
}

// K-of-N reserve-mint approvals (reserve-bank-demo.html) — identical
// flock-guarded shape to the bank-approval quartet above, mirrors
// issuer-server/server.js's readReserveMintApprovals()/
// saveReserveMintApproval()/sign_reserve_mint_approval, kept in its own
// file/functions rather than shared (see atlas_reserve_mint_approvals_file()'s
// own comment).
function read_reserve_mint_approvals() {
  $fh = fopen(atlas_reserve_mint_approvals_file(), 'c+');
  if ($fh === false) return ['approvals' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc) || !isset($doc['approvals'])) $doc = ['approvals' => []];
  $nowMs = (int) round(microtime(true) * 1000);
  $doc['approvals'] = array_values(array_filter($doc['approvals'], function ($a) use ($nowMs) {
    return ($a['status'] ?? 'pending') !== 'pending' || strtotime($a['expiresAt']) * 1000 > $nowMs;
  }));
  return $doc;
}
function find_reserve_mint_approval($id) {
  foreach (read_reserve_mint_approvals()['approvals'] as $a) {
    if ($a['id'] === $id) return $a;
  }
  return null;
}
function save_reserve_mint_approval($approval) {
  $file = atlas_reserve_mint_approvals_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['approvals'])) $doc = ['approvals' => []];
  $found = false;
  foreach ($doc['approvals'] as $i => $a) {
    if ($a['id'] === $approval['id']) { $doc['approvals'][$i] = $approval; $found = true; break; }
  }
  if (!$found) $doc['approvals'][] = $approval;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}
// Same WYSIWYS reasoning as bank_approval_payload_of() above.
function reserve_mint_approval_payload_of($approval) {
  return ['id' => $approval['id'], 'action' => $approval['action']];
}
// Same one-lock-held-across-the-whole-sequence reasoning as
// sign_bank_approval() above — see that function's own comment.
function sign_reserve_mint_approval($id, $proof) {
  $file = atlas_reserve_mint_approvals_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['approvals'])) $doc = ['approvals' => []];

  $nowMs = (int) round(microtime(true) * 1000);
  $idx = null;
  foreach ($doc['approvals'] as $i => $a) {
    if ($a['id'] !== $id) continue;
    if (($a['status'] ?? 'pending') === 'pending' && strtotime($a['expiresAt']) * 1000 <= $nowMs) break;
    $idx = $i;
    break;
  }
  if ($idx === null) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'no such mint request (or it already expired)'];
  }

  $approval = $doc['approvals'][$idx];
  if ($approval['status'] !== 'pending') {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'this request is already ' . $approval['status']];
  }
  if (!in_array($proof['publicKey'] ?? null, $approval['approvers'], true)) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'this key is not an authorized approver for this request'];
  }
  foreach ($approval['signatures'] as $s) {
    if ($s['publicKey'] === $proof['publicKey']) {
      flock($fh, LOCK_UN);
      fclose($fh);
      return ['approval' => $approval]; // already signed — idempotent, not an error
    }
  }

  $sigOk = verify_envelope(reserve_mint_approval_payload_of($approval), $proof);
  if (!$sigOk) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'approval signature does not check out'];
  }

  $approval['signatures'][] = [
    'publicKey' => $proof['publicKey'],
    'signerRole' => $proof['signerRole'],
    'signature' => $proof['signature'],
    'signedAt' => iso_now(),
  ];
  if (count($approval['signatures']) >= $approval['requiredApprovals']) {
    $kp = atlas_load_keys();
    $credential = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $approval['action']['toPublicKey'], $approval['action']['assetClass'], $approval['action']['amount'], null);
    $approval['status'] = 'executed';
    $approval['executedCredentialId'] = $credential['id'];
    // Mirrors issuer-server/server.js's same addition — reserve-bank-demo.html
    // spends this credential onward (splitting reserves out to each bank
    // next), and no "look up a credential by id" endpoint exists anywhere
    // in this protocol, so this is the one chance to deliver it.
    $approval['executedCredential'] = $credential;
  }
  $doc['approvals'][$idx] = $approval;

  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return ['approval' => $approval];
}

// Domain-quorum reserve-mint requests — mirrors issuer-server/server.js's
// readReserveMintConsortiumRequests()/findReserveMintConsortiumRequest()/
// saveReserveMintConsortiumRequest(). Same plain-read-write shape as
// read_reserve_mint_approvals() above, but each "approval" is a domain's
// own signed attestation rather than one officer's raw signature.
function atlas_read_reserve_mint_consortium_requests() {
  $file = atlas_reserve_mint_consortium_file();
  if (!file_exists($file)) return ['requests' => []];
  $fh = fopen($file, 'c+');
  if ($fh === false) return ['requests' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc) || !isset($doc['requests'])) $doc = ['requests' => []];
  $nowMs = (int) round(microtime(true) * 1000);
  $doc['requests'] = array_values(array_filter($doc['requests'], function ($r) use ($nowMs) {
    return ($r['status'] ?? 'pending') !== 'pending' || strtotime($r['expiresAt']) * 1000 > $nowMs;
  }));
  return $doc;
}
function atlas_find_reserve_mint_consortium_request($id) {
  foreach (atlas_read_reserve_mint_consortium_requests()['requests'] as $r) {
    if ($r['id'] === $id) return $r;
  }
  return null;
}
function atlas_save_reserve_mint_consortium_request($request) {
  $file = atlas_reserve_mint_consortium_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['requests'])) $doc = ['requests' => []];
  $found = false;
  foreach ($doc['requests'] as $i => $r) {
    if ($r['id'] === $request['id']) { $doc['requests'][$i] = $request; $found = true; break; }
  }
  if (!$found) $doc['requests'][] = $request;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// The inbound half of atlas/demo/reserve/consortium/co-sign.php — called
// by a sibling domain's own server, trust coming from the attestation's
// own signature (verified against that domain's freshly-fetched published
// key), never from anything the caller merely asserts. Same
// one-lock-held-across-the-whole-sequence reasoning as
// sign_reserve_mint_approval() above, except the domain-key fetch/verify
// happens BEFORE the lock is taken (it's a network round trip, not pure
// local computation, so there's no reason to hold the file lock through
// it). Mints the instant the threshold is reached, in the same request
// that pushes it over.
function atlas_approve_reserve_mint_consortium($id, $attestation, $attestationSignature) {
  $request = atlas_find_reserve_mint_consortium_request($id);
  if (!$request) return ['error' => 'no such consortium mint request (or it already expired)'];
  if ($request['status'] !== 'pending') return ['error' => 'this request is already ' . $request['status']];
  if (($attestation['id'] ?? null) !== $id || ($attestation['requestingDomain'] ?? null) !== atlas_domain()) {
    return ['error' => 'attestation does not name this request and this domain'];
  }
  // Binds the attestation to the EXACT pending action, so a domain can
  // never be tricked into having its signature count toward a different
  // action than the one it actually reviewed.
  if (canonicalize($attestation['action'] ?? null) !== canonicalize($request['action'])) {
    return ['error' => 'attestation does not name the pending action exactly'];
  }
  $domain = $attestation['domain'] ?? null;
  if (!$domain || !in_array($domain, $request['approverDomains'], true)) {
    return ['error' => 'that domain is not named as an approver for this request', 'status' => 403];
  }
  foreach ($request['approvals'] as $a) {
    if ($a['domain'] === $domain) return ['request' => $request]; // already approved — idempotent, not an error
  }

  try {
    $domainKey = fetch_domain_public_key($domain);
  } catch (Exception $e) {
    return ['error' => "could not verify " . $domain . "'s own published key: " . $e->getMessage(), 'status' => 502];
  }
  if (!verify_domain_signature($domainKey, $attestation, $attestationSignature)) {
    return ['error' => $domain . "'s attestation signature does not check out"];
  }

  $file = atlas_reserve_mint_consortium_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['requests'])) $doc = ['requests' => []];
  $idx = null;
  foreach ($doc['requests'] as $i => $r) {
    if ($r['id'] === $id) { $idx = $i; break; }
  }
  if ($idx === null) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'no such consortium mint request (or it already expired)'];
  }
  $request = $doc['requests'][$idx];
  if ($request['status'] !== 'pending') {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'this request is already ' . $request['status']];
  }
  foreach ($request['approvals'] as $a) {
    if ($a['domain'] === $domain) {
      flock($fh, LOCK_UN);
      fclose($fh);
      return ['request' => $request]; // already approved under the lock too — idempotent
    }
  }
  $request['approvals'][] = ['domain' => $domain, 'attestationSignature' => $attestationSignature, 'approvedAt' => iso_now()];
  if (count($request['approvals']) >= $request['requiredApprovals']) {
    $kp = atlas_load_keys();
    $credential = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $request['action']['toPublicKey'], $request['action']['assetClass'], $request['action']['amount'], null);
    $request['status'] = 'executed';
    $request['executedCredentialId'] = $credential['id'];
    $request['executedCredential'] = $credential;
  }
  $doc['requests'][$idx] = $request;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return ['request' => $request];
}

// Fixed claim text an attestation-demo.html visitor can request FROM the
// second, independent domain playing "the reviewer" (SPEC.md §5.11) — a
// short allow-list rather than free text, same discipline every other
// self-serve atlas/demo/*.php route already applies, so this domain's
// real signing key never ends up on arbitrary caller-supplied text.
// Mirrors issuer-server/server.js's DEMO_ATTESTATION_CLAIMS.
function atlas_demo_attestation_claims() {
  return [
    'reviewed' => 'Independently reviewed on the date shown, and found to be in order.',
    'in-good-standing' => 'Currently in good standing with this reviewer.',
    'certified' => "Certified as meeting this reviewer's own compliance standard.",
    'reserves-verified' => "Reserve holdings independently confirmed sufficient to back this bank's circulating retail currency.",
  ];
}

// Reservation-by-removal (task #250's concurrency mechanism, same as
// remove_pending_trade() above): whichever concurrent claim's removal
// actually finds-and-deletes the entry wins the item; a losing concurrent
// claim gets a clean "already gone" error from the caller instead. Returns
// the removed entry (so the caller can still act on it), or null if it was
// already gone. Mirrors issuer-server/server.js's removeWorldDrop().
function remove_world_drop($dropId) {
  $file = atlas_world_drops_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['drops' => []];
  $found = null;
  foreach ($doc['drops'] as $d) {
    if ($d['dropId'] === $dropId) { $found = $d; break; }
  }
  if ($found !== null) {
    $doc['drops'] = array_values(array_filter($doc['drops'], function ($d) use ($dropId) {
      return $d['dropId'] !== $dropId;
    }));
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $found;
}

// Task #42: serialized/limited-edition support — one running total minted
// per class, persisted the same "not web-reachable" way as everything
// else in this file. Mirrors issuer-server/server.js's
// SERIAL_COUNTERS_FILE (see that file's comment for the full "why one
// counter answers both the cap AND the serial-number question" reasoning).
function atlas_serial_counters_file() {
  return __DIR__ . '/atlas-serial-counters-store.json';
}

// One catalog for every asset class this issuer knows how to mint —
// unique and fungible alike (SPEC.md §5, task #44's merge of the former
// ATLAS_ITEM_CATALOG and ATLAS_RESOURCE_CLASSES/ATLAS_RESOURCE_PROPERTIES).
// Each entry carries everything `asset` needs: `name`, a `modelPath`/
// `thumbnailPath` resolved against this domain, the two flags that are
// fixed per class and signed fresh on every credential of it (`fungible`,
// `presentation` — SPEC.md §5's "two flags, one discipline"), and an
// optional `properties` bag. `properties` is an open, per-class bag — a
// creator adds or changes keys here freely, no protocol coordination
// needed. Looked up fresh by atlas_asset_catalog_entry() on every mint/
// split/consolidate/trade/reissue of a class, never copied forward from
// an older credential — that's what keeps auto-consolidation of a
// fungible class safe: every balance of it always carries the exact same
// properties (and the exact same fungible/presentation) by construction,
// so merging quantities can never blend or drop a differing value.
// Mirrors issuer-server/server.js's ASSET_CATALOG.
const ATLAS_ASSET_CATALOG_BASE = [
  'atlas.wearable' => [
    'name' => 'Bronze Compass', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => false, 'presentation' => 'collectible',
    // Task #250 second follow-up (Bruno's own request): the Compass was
    // deliberately left OUT of the first #250 follow-up (atlas.badge/
    // atlas.trinket.pin/atlas.trinket.charm below, all bound) specifically
    // to keep the flagship non-fungible World Drops demo item droppable.
    // Once the demo's own drop/pickup showcase leans on fungibles instead
    // (atlas.element.iron/gold/silver — already droppable, already the
    // subject of the split-then-drop partial-quantity path) there was no
    // reason left to exempt this one, oncePerUser giveaway from the exact
    // same drop-then-re-request courtesy-check loophole atlas.badge's own
    // comment below explains. Mirrors issuer-server/server.js's
    // ASSET_CATALOG entry. World Drops UI/protocol test coverage that used
    // to drop a Bronze Compass now mints atlas.trophy.chess directly
    // instead — see test/manual-drop-pickup.js, manual-previewer-2d.js, and
    // manual-world-drops-protocol(-php).js for the swap.
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.era' => 'Victorian',
      'com.example.material' => 'brass',
      'com.example.condition' => 'well-worn',
    ],
  ],
  'atlas.badge' => [
    'name' => 'Plaza Visitor Badge', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => false, 'presentation' => 'collectible',
    // Task #250 follow-up (Bruno's own request): a oncePerUser giveaway's
    // "already collected this" check is only a per-device courtesy (see
    // alreadyHasRequestableItem() in extension/viewer.js) — it looks at
    // what's CURRENTLY held, not a real issuance ledger. Without this,
    // dropping the badge and requesting it again would quietly re-arm
    // that courtesy check, letting one visitor collect it over and over.
    // 'tradeScope' => 'bound' closes that off the same way it already
    // does for membership cards, at the cost of never being
    // droppable/tradeable at all — the right tradeoff for something
    // that's meant to just mark "this visitor was here once," not
    // circulate. Mirrors issuer-server/server.js's ASSET_CATALOG entry.
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.issuedFor' => 'Plaza visit',
      'com.example.season' => 'Season 1',
    ],
  ],
  // A properties bag showcase: several plain static values (rarity,
  // material, origin) alongside one ARRAY-valued property
  // (com.example.enchantments) — the properties bag (SPEC.md §5.1) is just
  // an open JSON object, so a value doesn't have to be a single string the
  // way every other entry in this catalog happens to use. A plain PHP list
  // (no string keys) here canonicalizes to a JSON array, same as the JS
  // array on the Node side — see atlas_array_is_list() in crypto.php.
  'atlas.wearable.ring' => [
    'name' => "Merchant's Signet Ring", 'modelPath' => '/assets/ring.glb', 'thumbnailPath' => '/assets/ring.png',
    'fungible' => false, 'presentation' => 'collectible',
    // Serialized + capped demo class. `serialized => true` has
    // mint_asset_by_class() stamp a running per-instance atlas.serial/
    // atlas.editionSize onto every genuinely new mint (never onto a
    // split/consolidate/trade re-mint, which pass a non-null $supersedes,
    // see reserve_supply()); `maxSupply` caps total instances ever issued.
    // Not applied to the fungible element classes. Mirrors
    // issuer-server/server.js's ASSET_CATALOG entry of the same name.
    //
    // The cap is large enough that the demo pages can hand rings out
    // without selling out. reserve_supply() only compares its running
    // count against the CURRENT maxSupply, so rings already issued under a
    // smaller cap keep the editionSize they were minted with; only NEW
    // mints carry the current cap.
    'serialized' => true,
    'maxSupply' => 30000,
    // Rarity/enchantments/stats differ per ring rather than being fixed
    // per class. 'randomizeProperties' (see random_ring_properties() below, and
    // RING_RARITY_TIERS/RING_ENCHANTMENT_POOL near reserve_supply() in this
    // same file) is consulted by mint_asset_by_class() for every genuinely
    // new mint and overrides atlas.rarity/com.example.enchantments/
    // com.example.stats with a fresh weighted-rarity roll each time — the
    // 'properties' below are now only the FALLBACK shown by GET
    // /atlas/asset/class's pre-mint preview (which reads this catalog entry
    // directly and never rolls anything, since there's no instance yet to
    // roll for). Mirrors issuer-server/server.js's ASSET_CATALOG entry.
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.material' => 'silver',
      'com.example.origin' => 'Coastal Bazaar',
      'com.example.note' => 'Rarity, enchantments, and stats are rolled randomly at mint time',
    ],
    'randomizeProperties' => 'random_ring_properties',
  ],
  // Task #208: two small collectibles for the lobby's new walk-up-and-
  // open crates. Same one-per-wallet 'issue' + oncePerUser pattern as the
  // plaza's Bronze Compass/Signet Ring above, kept as distinct classes so
  // opening a lobby crate isn't just the plaza's own reward relabeled for
  // someone who already has it. No new art — reuses the badge/compass
  // models. Mirrors issuer-server/server.js's ASSET_CATALOG entries of
  // the same name.
  'atlas.trinket.pin' => [
    'name' => 'Lobby Enamel Pin', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => false, 'presentation' => 'collectible',
    // Task #250 follow-up — same "closes the drop-then-re-request
    // courtesy-check loophole" reasoning as atlas.badge above.
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.issuedFor' => 'Opening the lobby crate',
      'com.example.material' => 'enamel',
    ],
  ],
  'atlas.trinket.charm' => [
    'name' => 'Lucky Charm Keychain', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => false, 'presentation' => 'collectible',
    // Task #250 follow-up — same reasoning as atlas.badge/atlas.trinket.pin above.
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.rarity' => 'uncommon',
      'com.example.issuedFor' => 'Opening the lobby crate',
      'com.example.material' => 'pewter',
    ],
  ],
  // The "subscribe to this domain" credential for the mail system below:
  // requesting one of these is what a wallet's mail-check loop treats as
  // opting in to hearing from this domain (see atlas/mail/check.php) —
  // reuses the ordinary asset-issuance machinery rather than needing any
  // new issuance mechanism. Reuses the badge's model/thumbnail rather than
  // pointing at nonexistent assets. `presentation` is 'document' rather
  // than 'collectible' here — a membership card is administrative, not
  // something a client would show off on a shelf alongside a compass.
  // 'name' carries a literal '{domain}' token (task #227), same as
  // atlas.postoffice.membership's own entry below — expanded by
  // atlas_asset_catalog_entry() at request time, so a visitor subscribing
  // from example.com gets an "example.com Subscription Card", not a
  // generic one. Mirrors issuer-server/server.js's ASSET_CATALOG entry of
  // the same name.
  'atlas.membership' => [
    'name' => '{domain} Subscription Card', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => false, 'presentation' => 'document',
    // Task #160: user-bound — a relationship credential, not a tradeable
    // good. Blocked outright by check_presented_asset() below regardless
    // of the fungible check that already excludes it today; this makes
    // the exclusion an explicit, protocol-visible declaration rather than
    // an accident of it not being fungible. Mirrors issuer-server/
    // server.js's ASSET_CATALOG entry of the same name.
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.tier' => 'member',
      'com.example.issuedFor' => 'domain subscription',
    ],
  ],
  // Fungible classes (SPEC.md §5.4/§5.4.1: splittable, consolidatable,
  // tradeable — gated by `fungible => true` instead of, as before task
  // #44, by being a different credential type). Neither of these ever had
  // a dedicated model/thumbnail even back when this was its own
  // ATLAS_RESOURCE_PROPERTIES array — that array had no model/thumbnail
  // fields at all, since nothing in this bundle ever served real
  // iron-ingot/gold-ingot art any more than it serves a real compass.glb.
  // Rather than fabricate new, equally-nonexistent binary asset paths,
  // these reuse two existing unique-item entries' model/thumbnail — badge
  // for iron (a common, everyday-icon feel), the signet ring for gold
  // (already flagged 'rare' above, a fitting look for the scarcer metal).
  // Post Office (task #75/#87, SPEC.md §11.3): the credential that gates
  // atlas/postoffice/send.php — holding one is what makes THIS domain
  // willing to accept and relay user-to-user mail addressed to your public
  // key, the same "abuse needs its own rule once there's no registration
  // step" gap §11.3 flagged. 'presentation' => 'document', same reasoning
  // as atlas.membership just above: administrative, not a collectible.
  // 'name' carries a literal '{domain}' token, expanded by
  // atlas_asset_catalog_entry() below at request time the same way
  // modelPath/thumbnailPath already are — so it reads as "this domain's
  // card" wherever it's issued from, not a fixed brand string. Mirrors
  // issuer-server/server.js's ASSET_CATALOG entry of the same name.
  'atlas.postoffice.membership' => [
    'name' => '{domain} Global Mail Membership Card', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => false, 'presentation' => 'document',
    'tradeScope' => 'bound', // task #160 — same reasoning as atlas.membership above
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.tier' => 'postoffice-member',
      'com.example.issuedFor' => 'global mail routing',
    ],
  ],
  // Trading Station membership (task #144 Phase 1): the credential that
  // gates POST /atlas/trade/submit the exact same way
  // atlas.postoffice.membership gates POST /atlas/postoffice/send just
  // above — holding one is what makes THIS domain willing to hold a
  // wallet's remote trade intent pending a counterparty match, instead of
  // requiring both visitors to stand at the same in-world stall at once
  // (SPEC.md §7's original, still-supported, synchronous shape). Same
  // one-click issuance path (just another ATLAS_ASSET_CATALOG entry — no
  // dedicated endpoint needed), same 'tradeScope' => 'bound' reasoning as
  // the other two membership cards above. Mirrors issuer-server/
  // server.js's ASSET_CATALOG entry of the same name.
  'atlas.tradingstation.membership' => [
    'name' => '{domain} Trading Station Membership Card', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => false, 'presentation' => 'document',
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.tier' => 'tradingstation-member',
      'com.example.issuedFor' => 'remote trade settlement',
    ],
  ],
  // Task #203: 'exchangeRate'/'isBaseCurrency'/'holdingCap' — mirrors
  // issuer-server/server.js's ASSET_CATALOG comment on these same three
  // fields verbatim; see there for the full reasoning. Short version:
  // 'exchangeRate' is catalog-only config (never signed onto the
  // credential, same category as 'maxSupply'/'serialized'), read as "units
  // of this class per 1 unit of whichever class carries
  // 'isBaseCurrency' => true" — every convertible class needs its own,
  // including the base currency (always 1). 'isBaseCurrency' is a pure
  // UI/display hint with no effect on the math itself. 'holdingCap' caps
  // how much of a freely-mineable class atlas/asset/issue.php will mint to
  // an owner who already holds that much or more (verified against
  // presented current-holdings credentials, not trusted from the request).
  'atlas.element.iron' => [
    // Task #206: renamed to match the "<Name> (<Symbol>)" convention every
    // generated element already uses (see elements-catalog.php) — was
    // "Iron Ingot" (a leftover from before #204 gave every OTHER element
    // that same naming scheme).
    'name' => 'Iron (Fe)', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => true, 'presentation' => 'collectible',
    'exchangeRate' => 20, // 20 iron == 1 gold
    'holdingCap' => 500,
    // Task #205: the same real-property set (symbol/atomicNumber/category/
    // weight/density/conductivity) task #204 gave the other 115 elements,
    // added here too — mirrors issuer-server/server.js's entry exactly.
    'properties' => [
      'atlas.symbol' => 'Fe', 'atlas.atomicNumber' => 26, 'atlas.category' => 'transition metal',
      'atlas.state' => 'solid', 'atlas.weight' => ['value' => 55.845, 'unit' => 'g/mol'],
      'atlas.density' => ['value' => 7.874, 'unit' => 'g/cm3'],
      'atlas.thermalConductivity' => ['value' => 80.4, 'unit' => 'W/(m*K)'],
      'atlas.electricalConductivity' => ['value' => 10.0, 'unit' => 'MS/m'],
      'atlas.purity' => '99.9%', 'com.example.source' => 'Coastal Bazaar mine',
    ],
  ],
  'atlas.element.gold' => [
    // Task #206: see the matching comment on atlas.element.iron above.
    'name' => 'Gold (Au)', 'modelPath' => '/assets/ring.glb', 'thumbnailPath' => '/assets/ring.png',
    'fungible' => true, 'presentation' => 'collectible',
    'isBaseCurrency' => true, // task #203 — this domain's chosen conversion anchor
    'exchangeRate' => 1,
    'holdingCap' => 500,
    // Task #205: see the matching comment on atlas.element.iron above.
    'properties' => [
      'atlas.symbol' => 'Au', 'atlas.atomicNumber' => 79, 'atlas.category' => 'transition metal',
      'atlas.state' => 'solid', 'atlas.weight' => ['value' => 196.97, 'unit' => 'g/mol'],
      'atlas.density' => ['value' => 19.32, 'unit' => 'g/cm3'],
      'atlas.thermalConductivity' => ['value' => 317, 'unit' => 'W/(m*K)'],
      'atlas.electricalConductivity' => ['value' => 45.2, 'unit' => 'MS/m'],
      'atlas.purity' => '99.99%', 'com.example.form' => 'ingot',
    ],
  ],
  // Added alongside the market's new Mine Silver stall (v1.15) — mirrors
  // issuer-server/server.js's ASSET_CATALOG entry of the same name.
  'atlas.element.silver' => [
    // Task #206: see the matching comment on atlas.element.iron above.
    'name' => 'Silver (Ag)', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => true, 'presentation' => 'collectible',
    'exchangeRate' => 5, // 5 silver == 1 gold
    'holdingCap' => 500,
    // Task #205: see the matching comment on atlas.element.iron above.
    'properties' => [
      'atlas.symbol' => 'Ag', 'atlas.atomicNumber' => 47, 'atlas.category' => 'transition metal',
      'atlas.state' => 'solid', 'atlas.weight' => ['value' => 107.87, 'unit' => 'g/mol'],
      'atlas.density' => ['value' => 10.49, 'unit' => 'g/cm3'],
      'atlas.thermalConductivity' => ['value' => 429, 'unit' => 'W/(m*K)'],
      'atlas.electricalConductivity' => ['value' => 63.0, 'unit' => 'MS/m'],
      'atlas.purity' => '99.9%', 'com.example.source' => 'Coastal Bazaar mine',
    ],
  ],
  // reserve-bank-demo.html's own currencies — mirrors issuer-server/
  // server.js's ASSET_CATALOG entries of the same names. See that file's
  // own comment for the full reasoning (SPEC.md §5.4/§5.6/§5.8/§7 as a
  // two-tier issuance chain); all three are ordinary, non-bound fungible
  // classes, unlike atlas.credit.balance's bound "receipt" shape above.
  'atlas.currency.reserve' => [
    'name' => 'Reserve Credit', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => true, 'presentation' => 'collectible',
  ],
  'atlas.currency.alpha' => [
    'name' => 'Alpha Dollar', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => true, 'presentation' => 'collectible',
    'purchase' => ['priceClass' => 'atlas.currency.reserve', 'priceAmount' => 1],
  ],
  'atlas.currency.beta' => [
    'name' => 'Beta Dollar', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => true, 'presentation' => 'collectible',
    'purchase' => ['priceClass' => 'atlas.currency.reserve', 'priceAmount' => 1],
  ],
  // Governance/voting demo (governance-demo.html): open enrollment, same
  // "claiming this specific class IS joining" shape as
  // atlas.postoffice.membership/atlas.tradingstation.membership below —
  // free to mint on purpose, so this proves the MECHANISM (one
  // credential, one vote, a transparent tally, a real deadline), not a
  // Sybil-resistant one-person-one-vote system. Mirrors
  // issuer-server/server.js's ASSET_CATALOG entry of the same name.
  'atlas.demo.governance.membership' => [
    'name' => '{domain} Assembly Membership', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => false, 'presentation' => 'document', 'tradeScope' => 'bound',
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.tier' => 'governance-member',
      'com.example.issuedFor' => 'assembly voting rights',
    ],
  ],
  // Oracle-triggered payout demo (oracle-demo.html): a flight-delay
  // insurance policy, bound like the governance membership above — a
  // personal claim on its own holder's eligibility, not something to
  // gift away. Per-instance flight/payout terms live in
  // atlas-oracle-policies-store.json (see atlas_oracle_policies_file()
  // below), keyed by this credential's own id, not in this fixed catalog
  // entry. Mirrors issuer-server/server.js's ASSET_CATALOG entry of the
  // same name.
  'atlas.demo.insurance.policy' => [
    'name' => 'Flight Delay Policy', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => false, 'presentation' => 'document', 'tradeScope' => 'bound',
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.tier' => 'insurance-policy',
      'com.example.issuedFor' => 'flight delay payout eligibility',
    ],
  ],
  // The payout itself — ordinary fungible currency, minted only once a
  // claim clears every check in atlas/demo/oracle/payout/claim.php.
  // Mirrors issuer-server/server.js's ASSET_CATALOG entry of the same
  // name.
  'atlas.demo.insurance.payout' => [
    'name' => 'Flight Delay Payout', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => true, 'presentation' => 'collectible',
  ],
  // Supply-chain provenance + recall demo (recall-demo.html) — an ordinary
  // physical good, changing hands by plain atlas/asset/transfer.php like
  // any other giftable non-fungible item (no tradeScope override — that
  // only gets set to 'bound' the moment a recall is actually issued
  // against this class, via POST /atlas/demo/recall/issue.php below).
  // 'auditHistory' => true is what makes its full custody chain walkable
  // via GET /atlas/asset/history.php — see that comment. Mirrors
  // issuer-server/server.js's ASSET_CATALOG entry of the same name.
  'atlas.demo.supplychain.widget' => [
    'name' => 'Demo Widget', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => false, 'presentation' => 'collectible', 'auditHistory' => true,
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.batch' => 'demo-batch-01',
    ],
  ],
  // Task #201: a one-off keepsake for beating the in-world chess bot on
  // Hard difficulty, minted alongside the per-win gold reward (see
  // extension/viewer.js's CHESS_WIN_REWARDS / maybeAwardChessWin()) — just
  // another catalog entry atlas/asset/issue.php already knows how to mint,
  // no dedicated endpoint needed. Has its own dedicated model/thumbnail
  // now — an originally-authored, procedurally-generated GLB
  // (tools/make-demo-item-models.js), not the signet ring's borrowed
  // model this used to point at before a genuine trophy asset existed.
  // No tradeScope override — this is a genuine achievement, not a
  // relationship or a scarcity-gated giveaway (unlike
  // atlas.badge/atlas.trinket.pin/atlas.trinket.charm above, all 'bound'
  // as of the task #250 follow-up), so it stays ordinarily tradeable/
  // giftable/droppable. Mirrors issuer-server/server.js's ASSET_CATALOG
  // entry of the same name.
  'atlas.trophy.chess' => [
    'name' => 'Chess Champion Trophy', 'modelPath' => '/assets/trophy.glb', 'thumbnailPath' => '/assets/trophy.png',
    'fungible' => false, 'presentation' => 'collectible',
    'properties' => [
      'atlas.rarity' => 'rare',
      'com.example.awardedFor' => 'Defeating the in-world chess bot on Hard difficulty',
    ],
  ],
  // A giftable, non-collectible credential for the standalone business
  // demo (demo-domain-a/business-demo.html): a voucher a visitor can send
  // straight to another public key via POST /atlas/asset/transfer, next to
  // atlas.badge as the contrasting bound example the same page issues
  // alongside it. 'presentation' => 'document' rather than 'collectible' —
  // this is meant to be redeemed and read, not displayed on a shelf. No
  // tradeScope override, so it defaults to 'local' (giftable/tradeable).
  // Reuses the badge model/thumbnail, same as atlas.membership/
  // atlas.postoffice.membership above. Mirrors issuer-server/server.js's
  // ASSET_CATALOG entry of the same name.
  'atlas.demo.coupon' => [
    'name' => '10% Off Coupon', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => false, 'presentation' => 'document',
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.discount' => '10% off your next order',
      'com.example.issuedFor' => 'business demo',
    ],
  ],
  // SPEC.md §13's email-delivered bearer credential demo
  // (demo-domain-b/email-ticket-demo.html) — eligible the same way
  // atlas.demo.coupon above already is: fungible: false and no
  // tradeScope override (so it defaults to 'local'), the two conditions
  // §13.1 requires before a class can be offered through
  // /atlas/asset/transfer-to-email at all. Reuses the ring model/
  // thumbnail already on hand for demo-domain-b rather than commissioning
  // new art. Mirrors issuer-server/server.js's ASSET_CATALOG entry of the
  // same name.
  'atlas.demo.email.ticket' => [
    'name' => 'Workshop Visitor Voucher', 'modelPath' => '/assets/ring.glb', 'thumbnailPath' => '/assets/ring.png',
    'fungible' => false, 'presentation' => 'document',
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.voucherFor' => 'one free Neighbor Workshop visit',
    ],
  ],
  // SPEC.md §5.8's spendable balance, for the cafeteria-demo.html example.
  // 'tradeScope' => 'bound' — a top-up is meant to be spent by whoever it
  // was minted for, not gifted, traded, or consolidated away;
  // check_presented_spendable_asset() deliberately does not check
  // tradeScope, the same "spending your own balance raises no recipient
  // question" reasoning check_presented_redeemable_asset() already applies
  // to redeeming a bound credential whole. Mirrors issuer-server/server.js's
  // ASSET_CATALOG entry of the same name.
  'atlas.credit.balance' => [
    'name' => 'Spending Balance', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => true, 'presentation' => 'collectible',
    'tradeScope' => 'bound',
  ],
  // Three purchasable classes for the same example — each is just another
  // catalog entry with its own 'purchase' => ['priceClass', 'priceAmount'],
  // nothing about atlas/asset/purchase.php itself knows or cares that these
  // happen to be food. Mirrors issuer-server/server.js's ASSET_CATALOG
  // entries of the same names.
  'atlas.demo.cafeteria.sandwich' => [
    'name' => 'Sandwich', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => false, 'presentation' => 'document', 'tradeScope' => 'bound',
    'purchase' => ['priceClass' => 'atlas.credit.balance', 'priceAmount' => 5],
  ],
  'atlas.demo.cafeteria.juice' => [
    'name' => 'Juice', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => false, 'presentation' => 'document', 'tradeScope' => 'bound',
    'purchase' => ['priceClass' => 'atlas.credit.balance', 'priceAmount' => 2],
  ],
  'atlas.demo.cafeteria.snack' => [
    'name' => 'Snack Bar', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => false, 'presentation' => 'document', 'tradeScope' => 'bound',
    'purchase' => ['priceClass' => 'atlas.credit.balance', 'priceAmount' => 3],
  ],
  // SPEC.md §5.1's expiresAt, worked example: the Museum's ticket booth
  // sells this for the SAME atlas.credit.balance the cafeteria demo already
  // uses — a completely different UI (a 3D spatial stall, not a 2D page)
  // spending the exact same balance class through the exact same generic
  // purchase endpoint. 'expiresInMinutes' => 3 is a deliberately short,
  // sped-up stand-in for "valid for the day" — long enough to walk it
  // around and present it at the door, short enough to actually watch it
  // go stale in one sitting. Mirrors issuer-server/server.js's
  // ASSET_CATALOG entry of the same name.
  'atlas.demo.museum.ticket' => [
    'name' => 'Museum Day Ticket', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => false, 'presentation' => 'document', 'tradeScope' => 'bound',
    'purchase' => ['priceClass' => 'atlas.credit.balance', 'priceAmount' => 10],
    'expiresInMinutes' => 3,
  ],
  // demo-domain-a/login-demo.html's second factor: an ordinary credential
  // from the ungated /atlas/asset/issue, presented and signed over a fresh
  // nonce at every sign-in. No expiresInMinutes on purpose — the
  // interesting failure mode for a login credential is being revoked (a
  // lost or compromised device), not going stale on a timer. Mirrors
  // issuer-server/server.js's ASSET_CATALOG entry of the same name.
  'atlas.demo.login.badge' => [
    'name' => 'Demo Login Credential', 'modelPath' => '/assets/badge.glb',
    'fungible' => false, 'presentation' => 'document', 'tradeScope' => 'bound',
  ],
  // demo-domain-a/warranty-demo.html: one certificate per physical unit,
  // minted via the admin-gated POST /atlas/asset/mint so the factory's own
  // serial number is an authenticated fact, not something a self-serve
  // mint could fake. Sale-date/warranty-length/retailer facts are added
  // later, in one /atlas/asset/reissue call, when a retailer (another
  // operator on this same domain) stamps the actual sale. No tradeScope
  // override — a warranty is meant to follow the product through
  // /atlas/asset/transfer to a new owner, so it stays at the 'local'
  // default. No expiresInMinutes either — "expired" is read off the
  // stamped properties by whoever's looking, not enforced by is_expired(),
  // since that would also block transferring a product whose warranty
  // already lapsed. `auditHistory` => true is the first real use of
  // archive_if_audited() (see atlas_asset_history_file()'s own comment) —
  // every stamp-sale and every resale supersedes the certificate with a
  // fresh credential, so without this nothing on the current one alone
  // could tell a later owner whether it was ever resold before, or what
  // the factory/retailer set at each step. GET /atlas/asset/history?id=...
  // walks it back to the original mint. Mirrors issuer-server/server.js's
  // ASSET_CATALOG entry of the same name.
  'atlas.demo.warranty.certificate' => [
    'name' => 'Warranty Certificate', 'modelPath' => '/assets/badge.glb',
    'fungible' => false, 'presentation' => 'document', 'auditHistory' => true,
  ],
  // demo-domain-a/attestation-demo.html (SPEC.md §5.11) — the asset a
  // completely separate domain then independently attests to. An ordinary
  // document credential, nothing special about the class itself. Mirrors
  // issuer-server/server.js's ASSET_CATALOG entry of the same name.
  'atlas.demo.attestation.filing' => [
    'name' => 'Business Filing', 'modelPath' => '/assets/badge.glb',
    'fungible' => false, 'presentation' => 'document',
    'properties' => ['com.example.filingType' => 'Annual Compliance Filing'],
  ],
  // demo-domain-a/clawback-demo.html (SPEC.md §5.3's suspend-style
  // reversible freeze and §5.12's clawback) — mirrors issuer-server/
  // server.js's ASSET_CATALOG entry of the same name; see that entry's own
  // comment. No modelPath override to 'bound': it has to move hands via an
  // ordinary transfer for the demo's "theft" step to be genuine.
  'atlas.demo.clawback.token' => [
    'name' => 'Demo Recovery Token', 'modelPath' => '/assets/badge.glb',
    'fungible' => false, 'presentation' => 'collectible',
    'properties' => ['com.example.note' => 'Stands in for anything worth protecting once a key is compromised.'],
  ],
  // Test-only fixture for manual-asset-expiry.js — mirrors issuer-server/
  // server.js's ASSET_CATALOG entry of the same name; see that entry's own
  // comment for why this exists.
  'atlas.test.expiring' => [
    'name' => 'Test Expiring Item', 'modelPath' => '/assets/badge.glb',
    'fungible' => false, 'presentation' => 'document',
    'expiresInMinutes' => 0.05,
  ],
  // A fungible sibling of the fixture above — mirrors issuer-server/
  // server.js's ASSET_CATALOG entry of the same name.
  'atlas.test.expiring.balance' => [
    'name' => 'Test Expiring Balance', 'modelPath' => '/assets/compass.glb',
    'fungible' => true, 'presentation' => 'collectible',
    'expiresInMinutes' => 0.05,
  ],
  // Equippable looks: no modelPath/thumbnailPath (an outfit isn't a held
  // or displayed object, just a recolor of the shared character model).
  // shirtColor/pantsColor are under atlas.*, not com.example.*, because a
  // client actually has to understand these two specific keys to render
  // anything from them. Mirrors issuer-server/server.js's ASSET_CATALOG
  // entries of the same name.
  // Every atlas.avatar.* class below is tradeScope 'bound' — an equip-slot
  // item is meant to be worn by whoever looted it, not split off into a
  // giftable/tradeable/droppable balance. Mirrors issuer-server/server.js's
  // ASSET_CATALOG.
  'atlas.avatar.outfit.forest' => [
    'name' => 'Forest Ranger Outfit',
    'fungible' => false, 'presentation' => 'collectible',
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.avatar.shirtColor' => '#2f5d3a',
      'atlas.avatar.pantsColor' => '#3b2a1e',
    ],
  ],
  'atlas.avatar.outfit.dusk' => [
    'name' => 'Dusk Wanderer Outfit',
    'fungible' => false, 'presentation' => 'collectible',
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.avatar.shirtColor' => '#4a3b6b',
      'atlas.avatar.pantsColor' => '#22243a',
    ],
  ],
  // Same reasoning as the outfits above, but a separate equip slot — a hat
  // is its own new geometry piece in gltf-mini.js's buildCharacter(), not a
  // recolor of the torso/legs, and wallet.js keeps it in its own storage
  // key so a hat and an outfit can be worn together.
  // atlas.avatar.hatSpeedMultiplier/hatJumpMultiplier scale the wearer's own
  // walk/run speed and jump height, stacking with whatever shoes are ALSO
  // equipped; atlas.avatar.hatInteractRangeMultiplier widens how far away
  // the wearer can trigger a crate/mining node's prompt or pick up a
  // dropped item. All three are randomized per mint (see
  // random_hat_properties() near random_ring_properties() below) rather
  // than fixed per class — the properties below are only the fallback
  // GET /atlas/asset/class preview shows. Mirrors issuer-server/server.js's
  // ASSET_CATALOG entries of the same name.
  'atlas.avatar.hat.sunhat' => [
    'name' => 'Explorer Sun Hat',
    'fungible' => false, 'presentation' => 'collectible',
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.avatar.hatColor' => '#d9a441',
      'atlas.avatar.hatSpeedMultiplier' => 1.15,
      'atlas.avatar.hatJumpMultiplier' => 1.15,
      'atlas.avatar.hatInteractRangeMultiplier' => 1.25,
    ],
    'randomizeProperties' => 'random_hat_properties',
  ],
  'atlas.avatar.hat.cap' => [
    'name' => 'Night Watch Cap',
    'fungible' => false, 'presentation' => 'collectible',
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.avatar.hatColor' => '#26282c',
      'atlas.avatar.hatSpeedMultiplier' => 1.15,
      'atlas.avatar.hatJumpMultiplier' => 1.15,
      'atlas.avatar.hatInteractRangeMultiplier' => 1.25,
    ],
    'randomizeProperties' => 'random_hat_properties',
  ],
  // Same reasoning as the hats above, a third independent equip slot.
  // Mirrors issuer-server/server.js's ASSET_CATALOG entries of the same
  // name.
  // atlas.avatar.shoeSpeedMultiplier/shoeJumpMultiplier scale the wearer's
  // own walk/run speed and jump height (a 3D scene reads these directly off
  // whatever shoes are equipped — see gltf-mini.js); atlas.avatar.shoeVisualScale
  // scales the rendered height of the shoe geometry itself. All three are
  // optional and default to no change (1) when absent, same as any other
  // atlas.* property. Mirrors issuer-server/server.js's ASSET_CATALOG.
  'atlas.avatar.shoes.boots' => [
    'name' => 'Trailblazer Boots',
    'fungible' => false, 'presentation' => 'collectible',
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.avatar.shoeColor' => '#4a3222',
      'atlas.avatar.shoeSpeedMultiplier' => 1.1,
      'atlas.avatar.shoeJumpMultiplier' => 1.1,
      'atlas.avatar.shoeVisualScale' => 0.5,
    ],
  ],
  'atlas.avatar.shoes.sneakers' => [
    'name' => 'Court Sneakers',
    'fungible' => false, 'presentation' => 'collectible',
    'tradeScope' => 'bound',
    'properties' => [
      'atlas.avatar.shoeColor' => '#e8e4dc',
      'atlas.avatar.shoeSpeedMultiplier' => 1.2,
      'atlas.avatar.shoeJumpMultiplier' => 1.2,
      'atlas.avatar.shoeVisualScale' => 0.5,
    ],
  ],
];

// Task #204 — the other 115 periodic-table elements (everything except
// the hand-authored iron/gold/silver above), convert-only, no mining
// stall. See issuer-php/lib/elements-catalog.php's own header comment for
// the full rationale. ATLAS_ASSET_CATALOG_BASE stays a plain `const` (all
// its entries are compile-time literals); the merged, request-agnostic
// result below is what every other file in this codebase actually looks
// up by the name ATLAS_ASSET_CATALOG, unchanged from before this task —
// `define()` (not `const`) is used here because its value is computed at
// include time, not a constant expression. Mirrors
// issuer-server/server.js's `Object.assign(ASSET_CATALOG, require(...))`.
require_once __DIR__ . '/elements-catalog.php';
define('ATLAS_ASSET_CATALOG', array_merge(ATLAS_ASSET_CATALOG_BASE, atlas_elements_catalog()));

// Builds the `asset` wrapper (name/class/model/thumbnail/fungible/
// presentation/properties) for a class, resolving model/thumbnail paths
// against the current request's domain. Returns null for an unknown
// class. Mirrors issuer-server/server.js's ASSET_CATALOG lookup inside
// mintAssetByClass().
function atlas_asset_catalog_entry($assetClass) {
  if (!isset(ATLAS_ASSET_CATALOG[$assetClass])) return null;
  $entry = ATLAS_ASSET_CATALOG[$assetClass];
  // '{domain}' is a literal template token some catalog entries carry
  // (atlas.membership and atlas.postoffice.membership) — expanded here at
  // request time, same "resolved against the current request's domain"
  // treatment modelPath/thumbnailPath already get just below. A name with
  // no such token round-trips unchanged.
  $name = str_replace('{domain}', atlas_domain(), $entry['name']);
  $result = [
    'name' => $name, 'class' => $assetClass,
  ];
  // Both optional per SPEC.md §5 (mirrors issuer-server/server.js's
  // `model: catalogEntry.model` — undefined there just drops the key from
  // the signed JSON the same way omitting it here does): the first
  // catalog entries with neither field at all are the avatar-look outfits
  // below, an appearance recolor with no held/displayed object of its own.
  if (!empty($entry['modelPath'])) $result['model'] = 'https://' . atlas_domain() . $entry['modelPath'];
  if (!empty($entry['thumbnailPath'])) $result['thumbnail'] = 'https://' . atlas_domain() . $entry['thumbnailPath'];
  $result['fungible'] = $entry['fungible'];
  $result['presentation'] = $entry['presentation'];
  // Task #160: the third asset-level flag, always present (never
  // conditionally omitted the way 'properties' is) — same discipline
  // fungible/presentation already get, since this is meant to be checked
  // by exact value the same way they are. 'local' is the implicit default
  // for any catalog entry that doesn't set its own (see
  // ATLAS_ASSET_CATALOG's own comment on atlas.wearable in the Node
  // version this mirrors). Mirrors issuer-server/server.js's
  // mintAssetByClass()'s `catalogEntry.tradeScope || 'local'`.
  $result['tradeScope'] = isset($entry['tradeScope']) ? $entry['tradeScope'] : 'local';
  if (!empty($entry['properties'])) $result['properties'] = $entry['properties'];
  return $result;
}

// ---------- keypair ----------

function load_or_create_keypair() {
  $keyFile = atlas_key_file();
  if (file_exists($keyFile)) {
    $pem = file_get_contents($keyFile);
    $priv = openssl_pkey_get_private($pem);
    if ($priv === false) throw new Exception('could not load issuer private key: ' . openssl_error_string());
  } else {
    $priv = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
    if ($priv === false) throw new Exception('could not generate issuer keypair: ' . openssl_error_string());
    openssl_pkey_export($priv, $pem);
    file_put_contents($keyFile, $pem, LOCK_EX);
    @chmod($keyFile, 0600);
  }
  $details = openssl_pkey_get_details($priv);
  if (!isset($details['ec']['x']) || !isset($details['ec']['y'])) {
    throw new Exception('issuer key is not a valid EC key');
  }
  $x = str_pad($details['ec']['x'], 32, "\x00", STR_PAD_LEFT);
  $y = str_pad($details['ec']['y'], 32, "\x00", STR_PAD_LEFT);
  $rawPoint = "\x04" . $x . $y;
  return ['privateKey' => $priv, 'publicKeyB64url' => b64url_encode($rawPoint)];
}

function ensure_well_known_files($publicKeyB64url) {
  @mkdir(atlas_docroot() . '/.well-known', 0755, true);
  $keyFile = atlas_public_key_file();
  $keyDoc = ['keys' => [['publicKey' => $publicKeyB64url, 'validFrom' => gmdate('Y-m-d\TH:i:s\Z'), 'validUntil' => null]]];
  // Only (re)write atlas-key.json if it doesn't exist or is stale — avoids a
  // pointless write on every single request. (server.js does write it every
  // boot, but that's once per process start, not once per request.)
  $needsWrite = true;
  if (file_exists($keyFile)) {
    $existing = json_decode(file_get_contents($keyFile), true);
    if (is_array($existing) && isset($existing['keys'][0]['publicKey']) && $existing['keys'][0]['publicKey'] === $publicKeyB64url) {
      $needsWrite = false;
    }
  }
  if ($needsWrite) {
    file_put_contents($keyFile, json_encode($keyDoc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
  }
  $revFile = atlas_revocations_file();
  if (!file_exists($revFile)) {
    file_put_contents($revFile, json_encode(['revoked' => []], JSON_PRETTY_PRINT), LOCK_EX);
  }
}

// SPEC.md §13's "entering the system": a credential delivered by email has
// no wallet on the receiving end, so there is no real public key for
// owner.publicKey to name — but SPEC.md §5's credential shape still
// requires the field. Generating a keypair and keeping only the public
// half satisfies the shape without pretending anyone holds a working
// private key for it: the private key is never written anywhere, never
// returned to a caller, and nothing in SPEC.md §13.3's forward-to-transfer
// or §13.4's redemption ever checks a signature against this field again —
// authority over an email-delivered credential is bearer-only from this
// point on (possession of the attachment, or the short token), never this
// key. Mirrors issuer-server/server.js's generateDiscardedOwnerPublicKey().
function generate_discarded_owner_public_key() {
  $pair = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
  if ($pair === false) throw new Exception('could not generate a discarded keypair: ' . openssl_error_string());
  $details = openssl_pkey_get_details($pair);
  $x = str_pad($details['ec']['x'], 32, "\x00", STR_PAD_LEFT);
  $y = str_pad($details['ec']['y'], 32, "\x00", STR_PAD_LEFT);
  return b64url_encode("\x04" . $x . $y);
}

// SPEC.md §5.11's single-domain stand-in for "a second, independent
// identity" — see atlas_reviewer_key_file()'s own comment above. Same shape
// as load_or_create_keypair() just above, deliberately duplicated rather
// than parameterized, mirroring issuer-server/server.js's
// loadOrCreateReviewerKeypair(): these two keys serve genuinely different
// roles and keeping them as two plainly-named, independent code paths makes
// that obvious at a glance.
function load_or_create_reviewer_keypair() {
  $keyFile = atlas_reviewer_key_file();
  if (file_exists($keyFile)) {
    $pem = file_get_contents($keyFile);
    $priv = openssl_pkey_get_private($pem);
    if ($priv === false) throw new Exception('could not load reviewer private key: ' . openssl_error_string());
  } else {
    $priv = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
    if ($priv === false) throw new Exception('could not generate reviewer keypair: ' . openssl_error_string());
    openssl_pkey_export($priv, $pem);
    file_put_contents($keyFile, $pem, LOCK_EX);
    @chmod($keyFile, 0600);
  }
  $details = openssl_pkey_get_details($priv);
  if (!isset($details['ec']['x']) || !isset($details['ec']['y'])) {
    throw new Exception('reviewer key is not a valid EC key');
  }
  $x = str_pad($details['ec']['x'], 32, "\x00", STR_PAD_LEFT);
  $y = str_pad($details['ec']['y'], 32, "\x00", STR_PAD_LEFT);
  $rawPoint = "\x04" . $x . $y;
  return ['privateKey' => $priv, 'publicKeyB64url' => b64url_encode($rawPoint)];
}

function ensure_reviewer_well_known_file($publicKeyB64url) {
  @mkdir(atlas_docroot() . '/.well-known', 0755, true);
  $keyFile = atlas_reviewer_public_key_file();
  $keyDoc = ['keys' => [['publicKey' => $publicKeyB64url, 'validFrom' => gmdate('Y-m-d\TH:i:s\Z'), 'validUntil' => null]]];
  $needsWrite = true;
  if (file_exists($keyFile)) {
    $existing = json_decode(file_get_contents($keyFile), true);
    if (is_array($existing) && isset($existing['keys'][0]['publicKey']) && $existing['keys'][0]['publicKey'] === $publicKeyB64url) {
      $needsWrite = false;
    }
  }
  if ($needsWrite) {
    file_put_contents($keyFile, json_encode($keyDoc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
  }
  // No separate revocation file: an attestation's id still lives on this
  // same domain's one atlas_revocations_file() (ids are UUIDs, so there's
  // no collision risk with an asset id).
}

// ---------- revocations (flock-guarded — unlike the single-threaded Node
// demo, PHP requests can genuinely run concurrently on a real host) ----------

function read_revocations() {
  $fh = fopen(atlas_revocations_file(), 'r');
  if ($fh === false) return ['revoked' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['revoked' => []];
}

function is_revoked($id) {
  $doc = read_revocations();
  foreach ($doc['revoked'] as $r) {
    if (isset($r['id']) && $r['id'] === $id) return true;
  }
  return false;
}

// Mirrors issuer-server/server.js's isExpired() — a second, orthogonal way
// a credential can stop being valid, alongside revocation above (SPEC.md
// §5.1's optional signed `asset.expiresAt`). Pure arithmetic against the
// credential's own signed deadline, no file I/O at all — see
// mint_asset_by_class()'s own `expiresInMinutes` handling for where that
// deadline gets set.
function is_expired($credential) {
  $expiresAt = isset($credential['asset']['expiresAt']) ? $credential['asset']['expiresAt'] : null;
  if (!is_string($expiresAt)) return false;
  return time() > strtotime($expiresAt);
}

function atlas_revoke($id, $reason) {
  $file = atlas_revocations_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['revoked' => []];
  $doc['revoked'][] = ['id' => $id, 'revokedAt' => gmdate('Y-m-d\TH:i:s\Z'), 'reason' => $reason];
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// ---------- suspensions (same flock-guarded shape as revocations above)
// ---------- See atlas_suspensions_file()'s own comment. find_suspension()
// is the one real piece of logic here — everything else about a
// suspension is a plain list entry — since "is this id suspended" depends
// on the clock, not just presence in the list: an entry with a past
// expiresAt is no longer in effect. What happens next depends on
// `onExpire` (SPEC.md §13.4): the default, `'lift'` — the only behavior
// before this field existed — treats it the same as if
// atlas_unsuspend() had been called, just no longer in effect.
// `'finalize'` is the opposite: the thing is not meant to come back once
// its suspension window ends (a door-scanned ticket, suspended for an
// event's duration rather than instantly revoked, is the first real use
// of this — see §13.4) — a `'finalize'` entry's expiry revokes the
// credential outright (reason 'redeemed') instead of silently
// reactivating it. This resolution lives in read_suspensions() itself,
// the one shared read path every other function here goes through,
// rather than duplicated into find_suspension() and atlas_suspend()'s
// own pruning separately — that would let a 'finalize' entry slip past
// un-revoked if atlas_suspend() (for some OTHER id) happened to prune it
// first. Any access resolves every expired entry the same way, same
// "no background job, lazy cleanup on next access" posture as
// everything else in this file. Mirrors issuer-server/server.js's
// readSuspensions()/findSuspension()/isSuspended().

function read_suspensions() {
  $file = atlas_suspensions_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return ['suspended' => []];
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['suspended' => []];
  $now = time();
  $changed = false;
  $doc['suspended'] = array_values(array_filter($doc['suspended'], function ($s) use ($now, &$changed) {
    $expiresAt = $s['expiresAt'] ?? null;
    if ($expiresAt === null || strtotime($expiresAt) > $now) return true; // still in effect, keep
    if (($s['onExpire'] ?? 'lift') === 'finalize') atlas_revoke($s['id'], 'redeemed');
    $changed = true;
    return false; // expired — drop it either way; 'finalize' already got its revoke above
  }));
  if ($changed) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $doc;
}

function find_suspension($id) {
  foreach (read_suspensions()['suspended'] as $s) {
    if (($s['id'] ?? null) === $id) return $s;
  }
  return null;
}

function is_suspended($id) {
  return find_suspension($id) !== null;
}

// $expiresAt (a string) is optional — an admin can choose either behavior
// per suspension: give it a deadline for an automatic lift/finalize, or
// pass null for one that stays in effect until atlas_unsuspend() is
// called explicitly ($onExpire is meaningless without an $expiresAt to
// trigger it). $onExpire defaults to 'lift' — every call site before
// this parameter existed keeps its exact original behavior unchanged.
// Replaces any existing entry for the same id rather than stacking
// duplicates; read_suspensions() above already resolved anything expired
// before this function ever sees the list.
function atlas_suspend($id, $reason, $expiresAt, $onExpire = 'lift') {
  $file = atlas_suspensions_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['suspended' => []];
  $doc['suspended'] = array_values(array_filter($doc['suspended'], function ($s) use ($id) { return ($s['id'] ?? null) !== $id; }));
  $doc['suspended'][] = ['id' => $id, 'suspendedAt' => gmdate('Y-m-d\TH:i:s\Z'), 'reason' => $reason ?: 'issuer-request', 'expiresAt' => $expiresAt ?: null, 'onExpire' => $onExpire === 'finalize' ? 'finalize' : 'lift'];
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// Returns whether an entry was actually there to remove — lets the
// endpoint tell an admin "there was nothing to lift" from "done" without
// a separate lookup first.
function atlas_unsuspend($id) {
  $file = atlas_suspensions_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['suspended' => []];
  $before = count($doc['suspended']);
  $doc['suspended'] = array_values(array_filter($doc['suspended'], function ($s) use ($id) { return ($s['id'] ?? null) !== $id; }));
  $wasSuspended = count($doc['suspended']) !== $before;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $wasSuspended;
}

// See atlas_asset_history_file()'s own comment above. Called alongside
// atlas_revoke() at every site that supersedes a credential with a
// freshly minted replacement — a no-op for any class that hasn't opted
// in, so this adds nothing to the ordinary path except one cheap catalog
// lookup. Archives the OLD credential's full signed body (still
// independently verifiable later against this domain's key history) plus
// why it was superseded and when, keyed by the id that's about to stop
// being served anywhere else. Same flock-guarded read-modify-write shape
// as atlas_revoke() above — PHP requests can genuinely run concurrently,
// unlike the single-threaded Node demo.
function read_asset_history() {
  $fh = fopen(atlas_asset_history_file(), 'c+');
  if ($fh === false) return ['archived' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) && isset($doc['archived']) ? $doc : ['archived' => []];
}
function archive_if_audited($credential, $reason) {
  $cls = $credential['asset']['class'] ?? null;
  $catalogEntry = $cls !== null && isset(ATLAS_ASSET_CATALOG[$cls]) ? ATLAS_ASSET_CATALOG[$cls] : null;
  if (!$catalogEntry || empty($catalogEntry['auditHistory'])) return;
  $file = atlas_asset_history_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['archived'])) $doc = ['archived' => []];
  $doc['archived'][] = array_merge($credential, ['archivedAt' => gmdate('Y-m-d\TH:i:s\Z'), 'reason' => $reason]);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}
function find_archived_asset($id) {
  foreach (read_asset_history()['archived'] as $a) {
    if (($a['id'] ?? null) === $id) return $a;
  }
  return null;
}
// Walks backward from $id through archived predecessor bodies, following
// each one's own `supersedes` in turn, and returns them oldest-first. See
// issuer-server/server.js's walkAssetHistory() for the full reasoning,
// including why this stops rather than guesses the moment `supersedes` is
// an array (a fungible consolidation, genuinely branching, not a single
// chain).
function walk_asset_history($id) {
  $chain = [];
  $seen = [];
  $current = $id;
  while (is_string($current) && $current !== '' && !isset($seen[$current])) {
    $seen[$current] = true;
    $archived = find_archived_asset($current);
    if (!$archived) break;
    $chain[] = $archived;
    $current = $archived['supersedes'] ?? null;
  }
  return array_reverse($chain);
}

// ---------- mail (flock-guarded, same reasoning as revocations above —
// a flat array of signed messages, each tied to one credentialId) ----------

function read_mail() {
  $fh = fopen(atlas_mail_file(), 'c+');
  if ($fh === false) return ['messages' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['messages' => []];
}

function append_mail($message) {
  $file = atlas_mail_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['messages' => []];
  $doc['messages'][] = $message;

  // ATLAS_MAILBOX_CAP enforcement (see its own comment above): only this
  // message's own mailbox is ever pruned, and only its oldest entries —
  // every other recipient's mail is untouched.
  $own = array_values(array_filter($doc['messages'], function ($m) use ($message) {
    return ($m['credentialId'] ?? null) === $message['credentialId'];
  }));
  if (count($own) > ATLAS_MAILBOX_CAP) {
    $dropIds = array_flip(array_map(function ($m) { return $m['id']; }, array_slice($own, 0, count($own) - ATLAS_MAILBOX_CAP)));
    $doc['messages'] = array_values(array_filter($doc['messages'], function ($m) use ($dropIds) {
      return !isset($dropIds[$m['id'] ?? null]);
    }));
  }

  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// Removes the given messages from the mailboxes of the given credential ids.
// A message only goes if both match, so naming an id that lives in someone
// else's mailbox deletes nothing. Returns how many were removed.
function delete_mail_messages($messageIds, $credentialIds) {
  $wantedIds = array_flip($messageIds);
  $mailboxes = array_flip($credentialIds);
  $file = atlas_mail_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return 0;
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['messages' => []];
  $before = count($doc['messages']);
  $doc['messages'] = array_values(array_filter($doc['messages'], function ($m) use ($wantedIds, $mailboxes) {
    return !(isset($wantedIds[$m['id'] ?? null]) && isset($mailboxes[$m['credentialId'] ?? null]));
  }));
  $removed = $before - count($doc['messages']);
  if ($removed > 0) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $removed;
}

// Removes every message held for one mailbox. Returns how many were removed.
function delete_mailbox($credentialId) {
  $file = atlas_mail_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return 0;
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['messages' => []];
  $before = count($doc['messages']);
  $doc['messages'] = array_values(array_filter($doc['messages'], function ($m) use ($credentialId) {
    return ($m['credentialId'] ?? null) !== $credentialId;
  }));
  $removed = $before - count($doc['messages']);
  if ($removed > 0) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $removed;
}

// ---------- asset updates (same flock-guarded shape as mail above) ----------

function read_asset_updates() {
  $fh = fopen(atlas_asset_updates_file(), 'c+');
  if ($fh === false) return ['updates' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['updates' => []];
}

function append_asset_update($update) {
  $file = atlas_asset_updates_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['updates' => []];
  $doc['updates'][] = $update;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// ---------- relay-settle results (same flock-guarded shape as asset updates above) ----------

function find_relay_settle_result($tradeId, $credentialId) {
  $fh = fopen(atlas_relay_settle_results_file(), 'c+');
  if ($fh === false) return null;
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  $results = is_array($doc) && isset($doc['results']) ? $doc['results'] : [];
  foreach ($results as $r) {
    if ($r['tradeId'] === $tradeId && $r['credentialId'] === $credentialId) return $r;
  }
  return null;
}

function record_relay_settle_result($tradeId, $credentialId, $received, $remainder) {
  $file = atlas_relay_settle_results_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['results' => []];
  $doc['results'][] = ['tradeId' => $tradeId, 'credentialId' => $credentialId, 'received' => $received, 'remainder' => $remainder, 'settledAt' => gmdate('Y-m-d\TH:i:s\Z')];
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// Merges $patch onto $target (never mutates either): a key set to any
// value but null is added/overwritten same as array_merge, and a key set
// to null is removed from the result entirely rather than kept as a
// literal null — the standard JSON Merge Patch convention (RFC 7386),
// adopted here so there's finally a way to actually take a property away
// rather than only ever add or overwrite one. Used wherever a properties
// patch is applied to REAL asset data — a class patch onto a credential's
// properties (apply_class_patch_if_stale(), lib/bootstrap.php), and
// atlas/asset/reissue.php's own `properties` argument — so null means
// "delete this" in both places a patch actually takes effect.
//
// Deliberately NOT used by set_class_patch()'s own merge of a new call
// onto an already-stored patch, just below: a stored patch has to keep a
// null entry as a literal delete MARKER (something to apply to a
// credential later), not have that key erased from the patch the moment
// it's set. Mirrors issuer-server/server.js's mergeProperties().
function merge_properties($target, $patch) {
  $result = is_array($target) ? $target : [];
  foreach (($patch ?? []) as $key => $value) {
    if ($value === null) unset($result[$key]);
    else $result[$key] = $value;
  }
  return $result;
}

// ---------- class patches (same flock-guarded shape as mail above,
// keyed by asset class rather than by item or holder) ----------

function read_class_patches() {
  $fh = fopen(atlas_class_patches_file(), 'c+');
  if ($fh === false) return ['patches' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['patches' => []];
}

function class_patch_of($cls) {
  $doc = read_class_patches();
  return isset($doc['patches'][$cls]) ? $doc['patches'][$cls] : null;
}

// `properties` is itself a patch, merged onto whatever was already set for
// this class (same merge-not-replace shape atlas/asset/reissue.php's own
// `properties` argument already uses), so setting one fact doesn't clobber
// another set earlier. `tradeScope`, when given, replaces the stored value
// outright (a scalar, nothing to merge).
function set_class_patch($cls, $properties, $tradeScope) {
  $file = atlas_class_patches_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['patches' => []];
  $existing = isset($doc['patches'][$cls]) ? $doc['patches'][$cls] : [];
  $merged = [];
  // array_merge, NOT merge_properties() — a null here has to survive into
  // the stored patch as a literal delete marker, not be erased from it
  // right away. merge_properties() only ever runs where a patch is
  // actually applied to a real credential's properties.
  $nextProperties = $properties !== null ? array_merge(isset($existing['properties']) ? $existing['properties'] : [], $properties) : (isset($existing['properties']) ? $existing['properties'] : null);
  $nextTradeScope = $tradeScope !== null ? $tradeScope : (isset($existing['tradeScope']) ? $existing['tradeScope'] : null);
  if ($nextProperties !== null) $merged['properties'] = $nextProperties;
  if ($nextTradeScope !== null) $merged['tradeScope'] = $nextTradeScope;
  $merged['updatedAt'] = iso_now();
  $doc['patches'][$cls] = $merged;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $merged;
}

function clear_class_patch($cls) {
  $file = atlas_class_patches_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['patches' => []];
  unset($doc['patches'][$cls]);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// ---------- visit counts (mirrors issuer-server/server.js's VISITS_FILE) ----------
//
// Anonymous per-world visit counts for the admin panel's Visits section
// (POST /atlas/visit records one, POST /atlas/admin/visits reads them
// back). Shape: {days: {"YYYY-MM-DD": {worldId: count}}}, UTC dates.
// Holds nothing identifying — no keys, no addresses, no timestamps finer
// than a day — and is bounded by (retention window x number of worlds),
// never by how many people visit. Lives in lib/ next to every other store
// for the same "not web-reachable" reason.
const ATLAS_VISITS_RETENTION_DAYS = 90;
function atlas_visits_file() {
  return __DIR__ . '/atlas-visits-store.json';
}

function read_visits() {
  $file = atlas_visits_file();
  if (!file_exists($file)) return ['days' => []];
  $fh = fopen($file, 'r');
  if ($fh === false) return ['days' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return (is_array($doc) && isset($doc['days']) && is_array($doc['days'])) ? $doc : ['days' => []];
}

// Counts one visit to $worldId against today's (UTC) bucket and drops any
// bucket older than the retention window while it's writing anyway. Same
// flock-guarded read/modify/write shape as the other stores above —
// concurrent requests are real here, unlike the Node version.
function record_visit($worldId, $nowTs = null) {
  $nowTs = $nowTs === null ? time() : $nowTs;
  $today = gmdate('Y-m-d', $nowTs);
  $cutoff = gmdate('Y-m-d', $nowTs - ATLAS_VISITS_RETENTION_DAYS * 86400);
  $fh = fopen(atlas_visits_file(), 'c+');
  if ($fh === false) return;
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['days']) || !is_array($doc['days'])) $doc = ['days' => []];
  foreach (array_keys($doc['days']) as $day) {
    if ($day < $cutoff) unset($doc['days'][$day]);
  }
  if (!isset($doc['days'][$today])) $doc['days'][$today] = [];
  $doc['days'][$today][$worldId] = (isset($doc['days'][$today][$worldId]) ? $doc['days'][$today][$worldId] : 0) + 1;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// ---------- bearer registry (SPEC.md §13.5) ----------
// Mirrors issuer-server/server.js's bearer registry: {bearers: {<credentialId>:
// {class, registeredAt}}}. A credential in an exported file is claimable only
// while its id is listed here; see SPEC.md §13.5 for why the credential's own
// validity can't be what authorizes a claim. Lives in lib/ with every other
// store.
function atlas_bearer_file() {
  return __DIR__ . '/atlas-bearer-store.json';
}

// Exports and claims run one at a time. Held for the whole request by the
// endpoints, so a second export or claim of the same credential waits and
// then finds the first one's result (a revoked credential) instead of racing
// it. Released when the request ends.
function atlas_bearer_lock() {
  $fh = fopen(atlas_bearer_file() . '.lock', 'c');
  if ($fh === false) throw new Exception('could not open the bearer lock');
  flock($fh, LOCK_EX);
  return $fh;
}

// Per-credential spend lock. Spending a credential is check (not revoked,
// owner matches), then a signature check or mint, then revoke, so two
// requests for the same credential could both pass the check. A request takes
// this lock on each credential it is about to spend before it checks it and
// keeps it until the request ends; a second request for the same credential
// waits, then finds it revoked and is refused in the usual way.
//
// The lock is one of 64 files chosen by a hash of the credential id, so no
// per-credential files pile up (two ids sharing a file only wait for each
// other). A stripe this request already holds is not taken again. Waiting is
// bounded: a request that cannot get the lock in 15 seconds (two requests
// locking the same credentials in opposite order, or a stuck one) gets the
// returned message rather than hanging. Order against the bearer lock above:
// bearer lock first, then this.
// Returns null when held, or a message when it could not be taken.
function atlas_spend_lock($credentialId) {
  static $held = [];
  if (!is_string($credentialId) || $credentialId === '') return null;
  $stripe = abs(crc32($credentialId)) % 64;
  if (isset($held[$stripe])) return null;
  $fh = fopen(__DIR__ . '/atlas-spend-lock-' . $stripe . '.lock', 'c');
  if ($fh === false) return 'could not take the spend lock';
  $deadline = microtime(true) + 15;
  while (!flock($fh, LOCK_EX | LOCK_NB)) {
    if (microtime(true) > $deadline) {
      fclose($fh);
      return 'this item is being used by another request right now - try again';
    }
    usleep(2000);
  }
  $held[$stripe] = $fh;
  return null;
}

function atlas_bearer_modify($fn) {
  $fh = fopen(atlas_bearer_file(), 'c+');
  if ($fh === false) throw new Exception('could not open the bearer registry');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['bearers']) || !is_array($doc['bearers'])) $doc = ['bearers' => []];
  $result = $fn($doc);
  ftruncate($fh, 0);
  rewind($fh);
  // Always an object, even when empty, so the file reads the same in
  // issuer-server.
  $out = $doc;
  $out['bearers'] = (object)$doc['bearers'];
  fwrite($fh, json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}

function read_bearers() {
  $file = atlas_bearer_file();
  if (!file_exists($file)) return ['bearers' => []];
  $fh = fopen($file, 'r');
  if ($fh === false) return ['bearers' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return (is_array($doc) && isset($doc['bearers']) && is_array($doc['bearers'])) ? $doc : ['bearers' => []];
}

function register_bearer($id, $assetClass) {
  atlas_bearer_modify(function (&$doc) use ($id, $assetClass) {
    $doc['bearers'][$id] = ['class' => $assetClass, 'registeredAt' => gmdate('Y-m-d\TH:i:s\Z')];
  });
}

function has_bearer($id) {
  $doc = read_bearers();
  return array_key_exists($id, $doc['bearers']);
}

// Removes and returns the entry, or null if the id is not listed. The
// removal is the claim's reservation.
function take_bearer($id) {
  return atlas_bearer_modify(function (&$doc) use ($id) {
    if (!array_key_exists($id, $doc['bearers'])) return null;
    $entry = $doc['bearers'][$id];
    unset($doc['bearers'][$id]);
    return $entry;
  });
}

function restore_bearer($id, $entry) {
  atlas_bearer_modify(function (&$doc) use ($id, $entry) {
    $doc['bearers'][$id] = $entry;
  });
}

// ---------- file export records (SPEC.md §13.5.1) ----------
// Mirrors issuer-server/server.js's export records: one entry per exported
// credential, advanced through prepared -> original-revoked -> pending ->
// claimed | abandoned | revoked, the original revoked BEFORE the file is
// listed so the two are never both live. The JSON shape is identical to the
// Node store's, so either issuer can read the other's file. The endpoints
// hold atlas_bearer_lock() for the whole request, which serializes every
// step below against every other export, recovery and claim.
function atlas_file_exports_file() {
  return __DIR__ . '/atlas-file-exports-store.json';
}
function atlas_recovery_secret_file() {
  return __DIR__ . '/atlas-recovery-secret.json';
}
function atlas_now_iso() {
  return gmdate('Y-m-d\TH:i:s\Z');
}

// The file and original credential inside a record are kept as decoded
// objects (not arrays) so an empty `{}` is not turned into `[]` on the way
// through: the file returned by a recovery must be byte-for-byte the one the
// export first returned.
function read_file_exports() {
  $file = atlas_file_exports_file();
  $raw = file_exists($file) ? file_get_contents($file) : '';
  $decoded = $raw === '' ? null : json_decode($raw, false);
  $doc = ['version' => 1, 'exports' => [], 'usedChallenges' => []];
  if (!is_object($decoded)) return $doc;
  foreach ((isset($decoded->exports) && is_object($decoded->exports)) ? get_object_vars($decoded->exports) : [] as $id => $rec) {
    $r = get_object_vars($rec);
    $r['transitions'] = array_map('get_object_vars', isset($r['transitions']) ? $r['transitions'] : []);
    $doc['exports'][$id] = $r;
  }
  if (isset($decoded->usedChallenges) && is_object($decoded->usedChallenges)) $doc['usedChallenges'] = get_object_vars($decoded->usedChallenges);
  return $doc;
}
// Written to a temporary file and renamed, so a stop mid-write never leaves
// a half-written store.
function write_file_exports($doc) {
  $out = ['version' => 1, 'exports' => (object)$doc['exports'], 'usedChallenges' => (object)$doc['usedChallenges']];
  $file = atlas_file_exports_file();
  $tmp = $file . '.tmp';
  file_put_contents($tmp, json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  rename($tmp, $file);
}
function file_export_of($doc, $id) {
  return array_key_exists($id, $doc['exports']) ? $doc['exports'][$id] : null;
}
function set_export_state(&$doc, $id, $state) {
  $at = atlas_now_iso();
  $doc['exports'][$id]['state'] = $state;
  $doc['exports'][$id]['updatedAt'] = $at;
  $doc['exports'][$id]['transitions'][] = ['state' => $state, 'at' => $at];
  write_file_exports($doc);
}
function close_export(&$doc, $id, $state, $reason, $extra = []) {
  $doc['exports'][$id]['outcomeReason'] = $reason;
  $doc['exports'][$id]['closedAt'] = atlas_now_iso();
  foreach ($extra as $k => $v) $doc['exports'][$id][$k] = $v;
  unset($doc['exports'][$id]['file'], $doc['exports'][$id]['original']);
  set_export_state($doc, $id, $state);
}
function revocation_entry_of($id) {
  foreach (read_revocations()['revoked'] as $r) {
    if (isset($r['id']) && $r['id'] === $id) return $r;
  }
  return null;
}
// Test-only: ATLAS_TEST_CRASH_AT=<point> makes the request stop dead right
// after that step has been written, with no response, as if it had crashed.
function file_export_fault_point($name) {
  if (getenv('ATLAS_TEST_CRASH_AT') === $name) exit(86);
}

// Creates the record for a freshly minted file.
function create_file_export($credential, $minted, $ownerPublicKey, $assetClass) {
  $doc = read_file_exports();
  $at = atlas_now_iso();
  $doc['exports'][$credential['id']] = [
    'exportId' => 'urn:atlas:file-export:' . bin2hex(random_bytes(16)),
    'originalId' => $credential['id'], 'fileId' => $minted['id'], 'ownerPublicKey' => $ownerPublicKey, 'class' => $assetClass,
    'state' => 'prepared', 'createdAt' => $at, 'updatedAt' => $at, 'transitions' => [['state' => 'prepared', 'at' => $at]],
    'original' => $credential, 'file' => $minted
  ];
  write_file_exports($doc);
  file_export_fault_point('export:prepared');
}

// Advances the export for $originalId as far as it safely can and says where
// it stands: ['outcome' => 'pending' | 'in-progress' | 'claimed' | 'abandoned'
// | 'revoked' | 'not-found', 'rec' => record].
function reconcile_file_export($originalId) {
  $doc = read_file_exports();
  if (file_export_of($doc, $originalId) === null) return ['outcome' => 'not-found'];
  for ($guard = 0; $guard < 8; $guard++) {
    $rec = $doc['exports'][$originalId];
    $terminal = ['claimed', 'abandoned', 'revoked'];
    if (in_array($rec['state'], $terminal, true)) return ['outcome' => $rec['state'], 'rec' => $rec];
    if ($rec['state'] === 'prepared') {
      $origRevoked = revocation_entry_of($rec['originalId']);
      if ($origRevoked && ($origRevoked['reason'] ?? null) !== 'file-transferred') {
        close_export($doc, $originalId, 'abandoned', 'original-spent');
        return ['outcome' => 'abandoned', 'rec' => $doc['exports'][$originalId]];
      }
      if (!$origRevoked) {
        atlas_revoke($rec['originalId'], 'file-transferred');
        file_export_fault_point('export:original-revoked-fact');
      }
      if (find_archived_asset($rec['originalId']) === null) {
        archive_if_audited(json_decode(json_encode($rec['original']), true), 'file-transferred');
      }
      set_export_state($doc, $originalId, 'original-revoked');
      file_export_fault_point('export:original-revoked');
      continue;
    }
    if ($rec['state'] === 'original-revoked') {
      if (!has_bearer($rec['fileId']) && revocation_entry_of($rec['fileId']) === null) register_bearer($rec['fileId'], $rec['class']);
      file_export_fault_point('export:bearer-registered');
      $doc['exports'][$originalId]['armedAt'] = atlas_now_iso();
      set_export_state($doc, $originalId, 'pending');
      file_export_fault_point('export:pending');
      continue;
    }
    if ($rec['state'] === 'pending') {
      // A committed claim that stopped before it finished is finished first,
      // so the claim record and the export record settle together.
      $claimRec = file_claim_of(read_file_claims(), $rec['fileId']);
      if ($claimRec !== null && ($claimRec['state'] ?? null) === 'committed') {
        finish_file_claim($rec['fileId'], null);
        return reconcile_file_export($originalId);
      }
      $fileRevoked = revocation_entry_of($rec['fileId']);
      if ($fileRevoked) {
        if (($fileRevoked['reason'] ?? null) === 'file-claimed') close_export($doc, $originalId, 'claimed', 'file-claimed', ['claimedAt' => $fileRevoked['revokedAt'] ?? atlas_now_iso()]);
        else close_export($doc, $originalId, 'revoked', $fileRevoked['reason'] ?? 'revoked');
        return ['outcome' => $doc['exports'][$originalId]['state'], 'rec' => $doc['exports'][$originalId]];
      }
      // Listed means still claimable. Not listed, not revoked and no claim
      // record means a claim from before claim records has not finished.
      return ['outcome' => has_bearer($rec['fileId']) ? 'pending' : 'in-progress', 'rec' => $rec];
    }
    throw new Exception('unknown export state ' . $rec['state']);
  }
  throw new Exception('export state machine did not settle');
}

// Called by claim-from-file.php once a file has been claimed, so the receipt
// is written and the file body dropped right away. reconcile_file_export()
// derives the same outcome from the revocation list if this never runs.
function note_file_claimed($fileId, $claimCredentialId) {
  $doc = read_file_exports();
  foreach ($doc['exports'] as $id => $rec) {
    if ($rec['fileId'] !== $fileId) continue;
    if (in_array($rec['state'], ['claimed', 'abandoned', 'revoked'], true)) return;
    close_export($doc, $id, 'claimed', 'file-claimed', ['claimedAt' => atlas_now_iso(), 'claimCredentialId' => $claimCredentialId]);
    return;
  }
}

// ---------- file claim records (SPEC.md §13.5.2) ----------
// Mirrors issuer-server/server.js's claim records. A claim commits a record
// (claimer key + minted credential) after minting and before the bearer
// registry or the revocation list is touched; taking the registry entry and
// revoking the file come after and are repeatable, so any later request for
// the file finishes the claim and the claimer's retry gets the same
// credential back. The JSON shape is identical to the Node store's. The
// endpoints hold atlas_bearer_lock() for the whole request.
//
//   committed   record durable; registry entry and revocation may or may
//               not be written yet
//   claimed     file taken out of the registry and revoked; the minted
//               credential is kept for replay until the replay window ends,
//               then dropped and a compact receipt remains
function atlas_file_claims_file() {
  return __DIR__ . '/atlas-file-claims-store.json';
}
function atlas_claim_replay_seconds() {
  $days = (int)getenv('ATLAS_CLAIM_REPLAY_DAYS');
  return ($days > 0 ? $days : 30) * 86400;
}
// The minted credential inside a record is kept as a decoded object so it
// is returned exactly as it was first sent.
function read_file_claims() {
  $file = atlas_file_claims_file();
  $raw = file_exists($file) ? file_get_contents($file) : '';
  $decoded = $raw === '' ? null : json_decode($raw, false);
  $doc = ['version' => 1, 'claims' => []];
  if (!is_object($decoded)) return $doc;
  foreach ((isset($decoded->claims) && is_object($decoded->claims)) ? get_object_vars($decoded->claims) : [] as $id => $rec) {
    $r = get_object_vars($rec);
    $r['transitions'] = array_map('get_object_vars', isset($r['transitions']) ? $r['transitions'] : []);
    $doc['claims'][$id] = $r;
  }
  return $doc;
}
function write_file_claims($doc) {
  $out = ['version' => 1, 'claims' => (object)$doc['claims']];
  $file = atlas_file_claims_file();
  $tmp = $file . '.tmp';
  file_put_contents($tmp, json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  rename($tmp, $file);
}
function file_claim_of($doc, $fileId) {
  return array_key_exists($fileId, $doc['claims']) ? $doc['claims'][$fileId] : null;
}
function set_claim_state(&$doc, $fileId, $state) {
  $at = atlas_now_iso();
  $doc['claims'][$fileId]['state'] = $state;
  $doc['claims'][$fileId]['updatedAt'] = $at;
  $doc['claims'][$fileId]['transitions'][] = ['state' => $state, 'at' => $at];
  write_file_claims($doc);
}
// Drops the stored credential from claims old enough that nobody is still
// expected to ask for it again; the receipt stays.
function compact_file_claims(&$doc) {
  $changed = false;
  $limit = time() - atlas_claim_replay_seconds();
  foreach ($doc['claims'] as $id => $rec) {
    if (($rec['state'] ?? null) === 'claimed' && isset($rec['minted']) && !empty($rec['claimedAt']) && strtotime($rec['claimedAt']) < $limit) {
      unset($doc['claims'][$id]['minted']);
      $changed = true;
    }
  }
  if ($changed) write_file_claims($doc);
}
// The caller must have just checked that the file has no claim record.
function create_file_claim($file, $minted, $claimantPublicKey) {
  $doc = read_file_claims();
  compact_file_claims($doc);
  $at = atlas_now_iso();
  $doc['claims'][$file['id']] = [
    'claimId' => 'urn:atlas:file-claim:' . bin2hex(random_bytes(16)),
    'fileId' => $file['id'], 'mintedId' => $minted['id'], 'claimantPublicKey' => $claimantPublicKey,
    'class' => $file['asset']['class'] ?? null,
    'state' => 'committed', 'createdAt' => $at, 'updatedAt' => $at, 'transitions' => [['state' => 'committed', 'at' => $at]],
    'minted' => json_decode(json_encode($minted), false)
  ];
  write_file_claims($doc);
  file_export_fault_point('claim:committed');
}
// Finishes a committed claim: takes the registry entry if it is still there,
// revokes the file if it is not revoked yet, marks the record claimed.
// Repeatable from any point. $file (an array) is only needed to archive the
// file the first time. Returns the record, or null when there is none.
function finish_file_claim($fileId, $file) {
  $doc = read_file_claims();
  $rec = file_claim_of($doc, $fileId);
  if ($rec === null) return null;
  if ($rec['state'] === 'claimed') return $rec;
  take_bearer($fileId);
  file_export_fault_point('claim:bearer-taken');
  if (revocation_entry_of($fileId) === null) atlas_revoke($fileId, 'file-claimed');
  file_export_fault_point('claim:revoked');
  if ($file !== null && find_archived_asset($fileId) === null) archive_if_audited($file, 'file-claimed');
  $revoked = revocation_entry_of($fileId);
  $doc['claims'][$fileId]['claimedAt'] = ($revoked && isset($revoked['revokedAt'])) ? $revoked['revokedAt'] : atlas_now_iso();
  set_claim_state($doc, $fileId, 'claimed');
  try { note_file_claimed($fileId, $rec['mintedId']); } catch (Throwable $e) { /* the receipt is derived at the next recovery instead */ }
  file_export_fault_point('claim:claimed');
  return $doc['claims'][$fileId];
}

// Recovery challenges: stateless HMAC over the credential id, a random nonce
// and an expiry; the nonce is recorded when used and forgotten after expiry.
// See issuer-server/server.js for the reasoning.
const ATLAS_RECOVERY_CHALLENGE_TTL = 300;
function recovery_secret() {
  $file = atlas_recovery_secret_file();
  if (!file_exists($file)) {
    file_put_contents($file, json_encode(['secret' => b64url_encode(random_bytes(32))]));
    @chmod($file, 0600);
  }
  return b64url_decode(json_decode(file_get_contents($file), true)['secret']);
}
function recovery_mac($credentialId, $nonce, $expiryMs) {
  return b64url_encode(hash_hmac('sha256', 'recover-file-export|v1|' . $credentialId . '|' . $nonce . '|' . $expiryMs, recovery_secret(), true));
}
function issue_recovery_challenge($credentialId) {
  $nonce = b64url_encode(random_bytes(16));
  $expiryMs = (int)round(microtime(true) * 1000) + ATLAS_RECOVERY_CHALLENGE_TTL * 1000;
  return ['challenge' => $nonce . '.' . $expiryMs . '.' . recovery_mac($credentialId, $nonce, $expiryMs), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', intdiv($expiryMs, 1000))];
}
// -> ['nonce' =>, 'expiry' =>] when well-formed, signed by this issuer for
// this id and unexpired; else ['error' => 'invalid-challenge' | 'expired-challenge'].
function check_recovery_challenge($credentialId, $challenge) {
  if (!is_string($challenge)) return ['error' => 'invalid-challenge'];
  $parts = explode('.', $challenge);
  if (count($parts) !== 3 || !preg_match('/^\d+$/', $parts[1])) return ['error' => 'invalid-challenge'];
  list($nonce, $expiryText, $mac) = $parts;
  if (!hash_equals(recovery_mac($credentialId, $nonce, $expiryText), $mac)) return ['error' => 'invalid-challenge'];
  if ((int)round(microtime(true) * 1000) > (int)$expiryText) return ['error' => 'expired-challenge'];
  return ['nonce' => $nonce, 'expiry' => (int)$expiryText];
}
// Records a challenge as used. False if it already was.
function consume_recovery_challenge($nonce, $expiryMs) {
  $doc = read_file_exports();
  $now = (int)round(microtime(true) * 1000);
  foreach ($doc['usedChallenges'] as $n => $e) if ($e < $now) unset($doc['usedChallenges'][$n]);
  if (array_key_exists($nonce, $doc['usedChallenges'])) return false;
  $doc['usedChallenges'][$nonce] = $expiryMs;
  write_file_exports($doc);
  return true;
}

// The revocation reason recorded for $id, or null if it is not revoked.
function revocation_reason_of($id) {
  foreach (read_revocations()['revoked'] as $r) {
    if (isset($r['id']) && $r['id'] === $id) return isset($r['reason']) ? $r['reason'] : '';
  }
  return null;
}

// SPEC.md §13.5's manifest opt-in: the top-level `fileTransfer` field.
// Returns null when the domain has not opted in, else ['classes' => list|null]
// (null = every eligible class). Read fresh each call so an edit to the
// manifest takes effect immediately.
function file_transfer_config() {
  $path = atlas_docroot() . '/.well-known/spatial.json';
  if (!file_exists($path)) return null;
  $manifest = json_decode(file_get_contents($path), true);
  if (!is_array($manifest) || !isset($manifest['fileTransfer'])) return null;
  $cfg = $manifest['fileTransfer'];
  // An empty JSON object decodes to an empty array here, which is an
  // opt-in with no class limit; a JSON list or scalar is not a valid opt-in.
  if (!is_array($cfg) || ($cfg !== [] && array_keys($cfg) === range(0, count($cfg) - 1))) return null;
  $classes = null;
  if (isset($cfg['classes']) && is_array($cfg['classes'])) {
    $classes = array_values(array_filter($cfg['classes'], 'is_string'));
  }
  return ['classes' => $classes];
}

// The world ids this domain's own manifest declares — the only ids a visit
// is accepted for, so an unauthenticated endpoint can't be made to grow
// the store with arbitrary names. Read fresh each time (a small file) so a
// manifest edit takes effect immediately.
function declared_world_ids() {
  $path = atlas_docroot() . '/.well-known/spatial.json';
  if (!file_exists($path)) return [];
  $manifest = json_decode(file_get_contents($path), true);
  $ids = [];
  foreach ((is_array($manifest) && isset($manifest['worlds']) && is_array($manifest['worlds'])) ? $manifest['worlds'] : [] as $w) {
    if (is_array($w) && isset($w['id']) && is_string($w['id'])) $ids[] = $w['id'];
  }
  return $ids;
}

// True if $credential disagrees with $patch on any field the patch
// actually sets. JSON-encode comparison rather than === since a
// property's value can itself be an array (e.g. a stats bag), not just a
// scalar. A null entry (merge_properties' delete marker) is stale exactly
// when the key is still actually present — once it's gone, checking again
// must stop reporting stale, or a deleted property would reissue forever.
// Mirrors issuer-server/server.js's isCredentialStaleAgainstClassPatch().
function is_credential_stale_against_class_patch($credential, $patch) {
  if (isset($patch['tradeScope']) && (!isset($credential['asset']['tradeScope']) || $credential['asset']['tradeScope'] !== $patch['tradeScope'])) return true;
  if (isset($patch['properties'])) {
    $current = isset($credential['asset']['properties']) ? $credential['asset']['properties'] : [];
    foreach ($patch['properties'] as $key => $value) {
      if ($value === null) {
        if (array_key_exists($key, $current)) return true;
      } else {
        $currentValue = isset($current[$key]) ? $current[$key] : null;
        if (json_encode($currentValue) !== json_encode($value)) return true;
      }
    }
  }
  return false;
}

// ---------- subscribers (same flock-guarded shape as mail above) ----------

function read_subscribers() {
  $fh = fopen(atlas_subscribers_file(), 'c+');
  if ($fh === false) return ['subscribers' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['subscribers' => []];
}

function append_subscriber($entry) {
  $file = atlas_subscribers_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['subscribers' => []];
  $doc['subscribers'][] = $entry;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// ---------- Post Office members (same flock-guarded shape as
// subscribers above) ----------

// Post Office abuse detection (task #96): how many sends within how large
// a rolling window counts as "irregular" enough to auto-flag a membership
// for the operator's attention — see record_postoffice_send() below.
// Mirrors issuer-server/server.js's POSTOFFICE_SPAM_THRESHOLD/WINDOW_MS.
// Plain constants rather than env vars — this bundle doesn't rely on env
// vars anywhere else either (see atlas_domain()'s $forced pattern above),
// since typical shared hosting doesn't make those easy to set; an
// operator who wants different values just edits them here directly.
const ATLAS_POSTOFFICE_SPAM_THRESHOLD = 5;
const ATLAS_POSTOFFICE_SPAM_WINDOW_MS = 60000;
// How long a send timestamp stays in a member's log before being pruned —
// independent of the flagging window above, same reasoning as the Node
// version: an operator reviewing the roster later might want to see
// "N sends over the last day" even once the burst that triggered
// flagging has scrolled out of the detection window.
const ATLAS_POSTOFFICE_SEND_LOG_RETENTION_MS = 86400000; // 24 hours, in ms

function read_postoffice_members() {
  $fh = fopen(atlas_postoffice_members_file(), 'c+');
  if ($fh === false) return ['members' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['members' => []];
}

function append_postoffice_member($entry) {
  $file = atlas_postoffice_members_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['members' => []];
  $doc['members'][] = $entry;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// True if $ownerPublicKey currently holds at least one valid (non-revoked)
// atlas.postoffice.membership credential from this domain — the send
// endpoint's whole abuse gate. Mirrors issuer-server/server.js's
// isValidPostOfficeMember().
function is_valid_postoffice_member($ownerPublicKey) {
  $doc = read_postoffice_members();
  foreach ($doc['members'] as $m) {
    if (isset($m['ownerPublicKey']) && $m['ownerPublicKey'] === $ownerPublicKey && !is_revoked($m['credentialId']) && !is_suspended($m['credentialId'])) {
      return true;
    }
  }
  return false;
}

// Governance/voting demo — membership roster, identical shape to
// Post Office's own just above. Mirrors issuer-server/server.js's
// readGovernanceMembers()/appendGovernanceMember()/isValidGovernanceMember().
function read_governance_members() {
  $fh = fopen(atlas_governance_members_file(), 'c+');
  if ($fh === false) return ['members' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['members' => []];
}
function append_governance_member($entry) {
  $file = atlas_governance_members_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['members' => []];
  $doc['members'][] = $entry;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}
function is_valid_governance_member($ownerPublicKey) {
  $doc = read_governance_members();
  foreach ($doc['members'] as $m) {
    if (isset($m['ownerPublicKey']) && $m['ownerPublicKey'] === $ownerPublicKey && !is_revoked($m['credentialId']) && !is_suspended($m['credentialId'])) {
      return true;
    }
  }
  return false;
}

// Governance/voting demo — proposals. Mirrors issuer-server/server.js's
// governanceTally()/governanceStatus(): status is never stored, always
// derived fresh from the wall clock against the proposal's own
// pre-committed deadline.
function governance_tally($proposal) {
  $yes = 0; $no = 0;
  foreach ($proposal['votes'] as $v) {
    if (($v['choice'] ?? null) === 'yes') $yes++;
    elseif (($v['choice'] ?? null) === 'no') $no++;
  }
  return ['yes' => $yes, 'no' => $no, 'total' => count($proposal['votes'])];
}
function governance_status($proposal) {
  $nowMs = (int) round(microtime(true) * 1000);
  return $nowMs >= strtotime($proposal['deadline']) * 1000 ? 'closed' : 'open';
}

// Read-only single-proposal lookup, shared lock — safe alongside the
// exclusive-lock writers below since nothing here mutates the file.
function find_governance_proposal($id) {
  $fh = fopen(atlas_governance_proposals_file(), 'c+');
  if ($fh === false) return null;
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc) || !isset($doc['proposals'])) return null;
  foreach ($doc['proposals'] as $p) {
    if ($p['id'] === $id) return $p;
  }
  return null;
}

// Validates and appends a new proposal under one exclusive lock — no
// two-writer race to close here specifically (each proposal gets its own
// fresh random id), but held for the whole sequence anyway for the same
// reason append_postoffice_member() is, rather than a bare read-then-write.
// Returns ['error' => '...'] or ['proposal' => the new record].
function create_governance_proposal($payload, $proof) {
  $sigOk = verify_envelope($payload, $proof);
  if (!$sigOk) return ['error' => 'signature does not check out'];
  if (!is_valid_governance_member($proof['publicKey'] ?? null)) {
    return ['error' => 'you must hold a live Assembly membership to propose something — join first'];
  }
  $proposal = [
    'id' => 'urn:atlas:governance:' . atlas_uuid(),
    'title' => $payload['title'],
    'description' => $payload['description'] ?? '',
    'deadline' => $payload['deadline'],
    'createdAt' => iso_now(),
    'createdBy' => $proof['publicKey'],
    'votes' => [],
  ];
  $file = atlas_governance_proposals_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['proposals'])) $doc = ['proposals' => []];
  $doc['proposals'][] = $proposal;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return ['proposal' => $proposal];
}

// Validates and casts one vote under ONE exclusive lock held across the
// entire find/validate/mutate/write sequence — exactly sign_bank_approval()'s
// own reasoning: two votes on the SAME proposal arriving at nearly the
// same moment must never both read the same pre-vote state and each
// write back only their own addition, silently dropping one, and the
// "already voted" check is meaningless unless it's checked against the
// same state the write is about to commit. Returns ['error' => '...'] or
// ['proposal' => the updated record].
function cast_governance_vote($proposalId, $payload, $proof) {
  $sigOk = verify_envelope($payload, $proof);
  if (!$sigOk) return ['error' => 'signature does not check out'];
  if (!is_valid_governance_member($proof['publicKey'] ?? null)) {
    return ['error' => 'you must hold a live Assembly membership to vote — join first'];
  }

  $file = atlas_governance_proposals_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['proposals'])) $doc = ['proposals' => []];

  $idx = null;
  foreach ($doc['proposals'] as $i => $p) {
    if ($p['id'] === $proposalId) { $idx = $i; break; }
  }
  if ($idx === null) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'no such proposal'];
  }

  $proposal = $doc['proposals'][$idx];
  if (governance_status($proposal) === 'closed') {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'voting on this proposal has closed'];
  }
  foreach ($proposal['votes'] as $v) {
    if ($v['voterPublicKey'] === $proof['publicKey']) {
      flock($fh, LOCK_UN);
      fclose($fh);
      return ['error' => 'you have already voted on this proposal'];
    }
  }

  $proposal['votes'][] = ['voterPublicKey' => $proof['publicKey'], 'choice' => $payload['choice'], 'votedAt' => iso_now()];
  $doc['proposals'][$idx] = $proposal;

  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return ['proposal' => $proposal];
}

// Oracle-triggered payout demo — one flat store of policies, keyed by
// the policy CREDENTIAL's own id, same "one file, filter/derive on
// read" shape as every other demo store above. Mirrors
// issuer-server/server.js's readOraclePolicies()/findOraclePolicy().
function find_oracle_policy($credentialId) {
  $fh = fopen(atlas_oracle_policies_file(), 'c+');
  if ($fh === false) return null;
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc) || !isset($doc['policies'])) return null;
  foreach ($doc['policies'] as $p) {
    if ($p['credentialId'] === $credentialId) return $p;
  }
  return null;
}
// Upsert-by-credentialId under one exclusive lock — used both for a
// fresh policy's first save and for recording payoutCredentialId once a
// claim mints its payout (by which point claim_oracle_policy() below has
// already marked `claimed` under its own lock; this second write only
// ever touches a policy id that isn't racing against anything else).
// Mirrors issuer-server/server.js's saveOraclePolicy().
function save_oracle_policy($policy) {
  $file = atlas_oracle_policies_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['policies'])) $doc = ['policies' => []];
  $idx = null;
  foreach ($doc['policies'] as $i => $p) {
    if ($p['credentialId'] === $policy['credentialId']) { $idx = $i; break; }
  }
  if ($idx === null) $doc['policies'][] = $policy;
  else $doc['policies'][$idx] = $policy;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}
// Atomically checks and marks one policy's own claimed flag, holding a
// single exclusive lock across the whole find/validate/mutate/write
// sequence — cast_governance_vote()'s own reasoning: two near-
// simultaneous claims against the SAME policy is a real race under
// PHP's multi-process model, and a bare read-then-write would let both
// requests observe claimed=false before either's write lands, minting
// two payouts for one policy. The attestation's SIGNATURE is verified by
// the caller before this is ever called (that check doesn't touch this
// store, so it stays outside the lock); flightNumber/delayMinutes are
// passed in already-trusted, straight from that verified attestation.
// The payout itself is minted by the caller AFTER this returns
// successfully — signing a credential and appending a revocation both
// touch different files this lock doesn't cover. Returns
// ['error' => '...'] or ['policy' => the now-claimed record].
function claim_oracle_policy($credentialId, $flightNumber, $delayMinutes) {
  $file = atlas_oracle_policies_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $doc = json_decode(stream_get_contents($fh), true);
  if (!is_array($doc) || !isset($doc['policies'])) $doc = ['policies' => []];

  $idx = null;
  foreach ($doc['policies'] as $i => $p) {
    if ($p['credentialId'] === $credentialId) { $idx = $i; break; }
  }
  if ($idx === null) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'no policy record on file for this credential'];
  }

  $policy = $doc['policies'][$idx];
  // Flight match is checked BEFORE the claimed flag on purpose — see
  // issuer-server/server.js's own comment on this same ordering: an
  // attestation for a different flight tells you nothing about THIS
  // policy regardless of whether it's already been paid out.
  if ($policy['flightNumber'] !== $flightNumber) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'that attestation is about a different flight than this policy covers'];
  }
  if ($policy['claimed']) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'this policy has already been paid out'];
  }
  if ($delayMinutes < ATLAS_ORACLE_DELAY_PAYOUT_THRESHOLD_MINUTES) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'the attested delay (' . $delayMinutes . ' min) does not meet this policy\'s ' .
      ATLAS_ORACLE_DELAY_PAYOUT_THRESHOLD_MINUTES . '-minute payout threshold'];
  }

  $policy['claimed'] = true;
  $doc['policies'][$idx] = $policy;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return ['policy' => $policy];
}

// Same lookup as is_valid_postoffice_member(), but returns the matching
// roster entry (so the caller can pull its credentialId) instead of a
// bare bool — atlas/postoffice/send.php needs the credentialId itself to
// address the outgoing mail message by.
function find_postoffice_membership($ownerPublicKey) {
  $doc = read_postoffice_members();
  foreach ($doc['members'] as $m) {
    if (isset($m['ownerPublicKey']) && $m['ownerPublicKey'] === $ownerPublicKey && !is_revoked($m['credentialId']) && !is_suspended($m['credentialId'])) {
      return $m;
    }
  }
  return null;
}

// The credential id mail for an owner is addressed to: the newest live card.
// Consent settings (block list, mode) stay on the owner's first live entry;
// only the addressing follows the newest card. A wallet that deleted its card
// and joined again presents only the new card when it fetches mail, so mail
// addressed to the old one could never be collected.
function postoffice_delivery_credential_id($ownerPublicKey, $fallback) {
  $doc = read_postoffice_members();
  $id = $fallback;
  foreach ($doc['members'] as $m) {
    if (isset($m['ownerPublicKey']) && $m['ownerPublicKey'] === $ownerPublicKey && !is_revoked($m['credentialId']) && !is_suspended($m['credentialId'])) $id = $m['credentialId'];
  }
  return $id;
}

// atlas/clawback.php's roster fix-up: re-points an EXISTING roster entry
// (found by its OLD credentialId, regardless of that id's own revoked
// state — it's about to be revoked by the caller, if it isn't already) at
// a freshly-clawed-back credential and a new owner, rather than leaving
// the new owner invisible to is_valid_postoffice_member()/
// find_postoffice_membership() until they separately rejoin. Whatever the
// account already had (a claimed handle, mail-mode/block-list settings)
// is preserved — that belongs to the account being returned, not to
// whoever most recently misused it — but sendLog/recentSendCount/flagged
// are reset, since abuse-tracking describes recent behavior under the OLD
// holder, not the account itself. Returns whether an entry was found to
// fix up. Mirrors issuer-server/server.js's inline roster fix-up in its
// own /atlas/clawback handler.
function reassign_postoffice_membership($oldCredentialId, $newCredentialId, $newOwnerPublicKey) {
  $file = atlas_postoffice_members_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return false;
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['members' => []];

  $found = false;
  foreach ($doc['members'] as &$member) {
    if (!isset($member['credentialId']) || $member['credentialId'] !== $oldCredentialId) continue;
    $member['credentialId'] = $newCredentialId;
    $member['ownerPublicKey'] = $newOwnerPublicKey;
    $member['sendLog'] = [];
    $member['recentSendCount'] = 0;
    $member['flagged'] = false;
    $found = true;
    break;
  }
  unset($member);

  if ($found) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $found;
}

// ---------- Trading Station members (task #144 Phase 1) — same
// flock-guarded read/append shape as Post Office members above. Nothing
// currently reads this back as a gate (see
// atlas_tradingstation_members_file()'s own comment on why) — that check
// is done per-request instead, against the membership credential the
// caller actually presents. Mirrors issuer-server/server.js's
// readTradingStationMembers()/appendTradingStationMember(). ----------

function read_tradingstation_members() {
  $fh = fopen(atlas_tradingstation_members_file(), 'c+');
  if ($fh === false) return ['members' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['members' => []];
}

function append_tradingstation_member($entry) {
  $file = atlas_tradingstation_members_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['members' => []];
  $doc['members'][] = $entry;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// atlas/clawback.php's roster fix-up for a Trading Station membership —
// same idea as reassign_postoffice_membership() above (see that
// function's own comment), just without abuse-tracking fields to reset.
function reassign_tradingstation_membership($oldCredentialId, $newCredentialId, $newOwnerPublicKey) {
  $file = atlas_tradingstation_members_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return false;
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['members' => []];

  $found = false;
  foreach ($doc['members'] as &$member) {
    if (!isset($member['credentialId']) || $member['credentialId'] !== $oldCredentialId) continue;
    $member['credentialId'] = $newCredentialId;
    $member['ownerPublicKey'] = $newOwnerPublicKey;
    $found = true;
    break;
  }
  unset($member);

  if ($found) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $found;
}

// ---------- Pending remote trades (task #144 Phase 1) — same
// flock-guarded shape as the mail/asset-update stores above, plus a
// remove (a settled or cancelled intent shouldn't linger and be matchable
// again) and a lazy prune on every read (an expired one should stop being
// matchable even if nobody's removed it yet — no background sweep in this
// demo, same reasoning as everywhere else in this file). Mirrors
// issuer-server/server.js's readPendingTrades()/appendPendingTrade()/
// removePendingTrade(). ----------

function read_pending_trades() {
  $file = atlas_pending_trades_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return ['trades' => []];
  flock($fh, LOCK_EX); // exclusive, not shared — a prune below may write back
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['trades' => []];

  $nowMs = (int) round(microtime(true) * 1000);
  $live = array_values(array_filter($doc['trades'], function ($t) use ($nowMs) {
    $exp = strtotime($t['intent']['payload']['expiresAt'] ?? '');
    return $exp !== false && ($exp * 1000) >= $nowMs;
  }));
  if (count($live) !== count($doc['trades'])) {
    $doc['trades'] = $live;
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $doc;
}

function append_pending_trade($entry) {
  $file = atlas_pending_trades_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['trades' => []];
  $doc['trades'][] = $entry;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

function remove_pending_trade($id) {
  $file = atlas_pending_trades_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['trades' => []];
  $doc['trades'] = array_values(array_filter($doc['trades'], function ($t) use ($id) {
    return $t['id'] !== $id;
  }));
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// Domain calendar (SPEC.md §12) — same flock-guarded read/append/update/
// remove shape as world drops above. read_calendar_events() is the one
// GET /atlas/calendar actually calls: filtered to one $worldId (null
// meaning the domain-wide calendar) and sorted soonest-first, the same
// ordering AtlasWallet.getCalendarEvents() already guarantees for a
// wallet's own local reminders (extension/wallet.js). Mirrors
// issuer-server/server.js's readCalendarStore()/readCalendarEvents()/
// addCalendarEvent()/updateCalendarEvent()/removeCalendarEvent().
function read_calendar_store() {
  $fh = fopen(atlas_calendar_file(), 'c+');
  if ($fh === false) return ['events' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['events' => []];
}

function read_calendar_events($worldId) {
  $normalized = $worldId ?: null;
  $events = read_calendar_store()['events'];
  $filtered = array_values(array_filter($events, function ($e) use ($normalized) {
    return (isset($e['worldId']) ? $e['worldId'] : null) === $normalized;
  }));
  usort($filtered, function ($a, $b) {
    return strtotime($a['dateTime']) <=> strtotime($b['dateTime']);
  });
  return $filtered;
}

function add_calendar_event($entry) {
  $file = atlas_calendar_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['events' => []];
  $doc['events'][] = $entry;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// Returns the updated entry (or null if $id doesn't exist), same "hand
// back what you just changed" convention as everywhere else in this file.
function update_calendar_event($id, $patch) {
  $file = atlas_calendar_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['events' => []];
  $found = null;
  foreach ($doc['events'] as &$e) {
    if ($e['id'] === $id) {
      foreach ($patch as $key => $value) $e[$key] = $value;
      $found = $e;
      break;
    }
  }
  unset($e);
  if ($found !== null) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $found;
}

// Returns the removed entry (or null if it was already gone). Mirrors
// issuer-server/server.js's removeCalendarEvent().
function remove_calendar_event($id) {
  $file = atlas_calendar_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['events' => []];
  $found = null;
  foreach ($doc['events'] as $e) {
    if ($e['id'] === $id) { $found = $e; break; }
  }
  if ($found !== null) {
    $doc['events'] = array_values(array_filter($doc['events'], function ($e) use ($id) {
      return $e['id'] !== $id;
    }));
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $found;
}

// Task #96 — records one successful send against the SENDER's own
// membership, called from atlas/postoffice/send.php right after a message
// actually goes out. Mirrors issuer-server/server.js's
// recordPostOfficeSend() exactly, including why: tracking sends (not
// received mail) because that's the half this domain actually controls
// and can act on, and NOT exposing this as a new public endpoint — same
// "would leak every member's public key + activity to anyone who asks"
// reasoning this file already applies to the subscriber roster. The
// operator reads flagged/recentSendCount straight off
// atlas-postoffice-members-store.json instead.
//
// `flagged` is a LIVE view, recomputed from the current log on every
// write, not a sticky bit — a membership quiet since its last burst
// un-flags itself with no separate "clear the flag" step. Acting on a
// flagged member is still a deliberate, separate step: the operator calls
// the existing POST /atlas/revoke with that member's credentialId, which
// (thanks to task #95's symmetric check) cuts off both sending AND
// receiving through this domain in one call.
function record_postoffice_send($credentialId) {
  $file = atlas_postoffice_members_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return;
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['members' => []];

  // Reuse iso_now() (bootstrap.php) for the new entry rather than
  // hand-rolling a timestamp format — keeps sendLog entries in exactly
  // the same shape as every other timestamp this bundle writes. Old
  // entries are kept as their original strings; strtotime() below parses
  // ISO 8601 with fractional seconds fine for the second-precision
  // comparisons this needs (nothing here cares about sub-second gaps).
  $nowMs = (int) round(microtime(true) * 1000);
  foreach ($doc['members'] as &$member) {
    if (!isset($member['credentialId']) || $member['credentialId'] !== $credentialId) continue;
    $log = $member['sendLog'] ?? [];
    $log[] = iso_now();
    $retained = array_values(array_filter($log, function ($iso) use ($nowMs) {
      return ($nowMs - strtotime($iso) * 1000) <= ATLAS_POSTOFFICE_SEND_LOG_RETENTION_MS;
    }));
    $member['sendLog'] = $retained;
    $recentCount = count(array_filter($retained, function ($iso) use ($nowMs) {
      return ($nowMs - strtotime($iso) * 1000) <= ATLAS_POSTOFFICE_SPAM_WINDOW_MS;
    }));
    $member['recentSendCount'] = $recentCount; // convenience for the operator — avoids recomputing this by hand from sendLog
    $member['flagged'] = $recentCount > ATLAS_POSTOFFICE_SPAM_THRESHOLD;
    break;
  }
  unset($member);

  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// ---------- federation relay rate limiting (same flock-guarded shape as
// record_postoffice_send() above, keyed by relayingDomain since there's no
// membership record to hang this off of for a peer domain) ----------

function read_relay_rate_log() {
  $fh = fopen(atlas_federation_relay_rate_file(), 'c+');
  if ($fh === false) return ['domains' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['domains' => []];
}

// Checked BEFORE fetch_domain_public_key()'s network round-trip in
// relay.php, so a domain already over the threshold gets an immediate 429
// instead of this domain paying for a key fetch it would just discard.
function relay_rate_limited($relayingDomain) {
  $doc = read_relay_rate_log();
  $log = $doc['domains'][$relayingDomain] ?? [];
  $nowMs = (int) round(microtime(true) * 1000);
  $recentCount = count(array_filter($log, function ($iso) use ($nowMs) {
    return ($nowMs - strtotime($iso) * 1000) <= ATLAS_RELAY_RATE_WINDOW_MS;
  }));
  return $recentCount >= ATLAS_RELAY_RATE_THRESHOLD;
}

// Called only once a relay attempt's attestation signature has actually
// checked out (see relay.php) — never for a raw, unverified request — so
// naming another domain in relayAttestation without holding its key can
// never spend that domain's own rate-limit budget.
function record_relay_attempt($relayingDomain) {
  $file = atlas_federation_relay_rate_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return;
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['domains' => []];
  $nowMs = (int) round(microtime(true) * 1000);
  $log = $doc['domains'][$relayingDomain] ?? [];
  $log[] = iso_now();
  $retained = array_values(array_filter($log, function ($iso) use ($nowMs) {
    return ($nowMs - strtotime($iso) * 1000) <= ATLAS_RELAY_RATE_LOG_RETENTION_MS;
  }));
  $doc['domains'][$relayingDomain] = $retained;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
}

// Task #94 (consent/block model, "both, recipient's choice" per direct
// instruction): a sanity cap on how many entries a single member's block
// list or friends-only snapshot can hold — generous for a demo, just a
// bound against one wallet growing its own settings entry without limit,
// not a spam-prevention measure itself (that's #96's job). Mirrors
// issuer-server/server.js's POSTOFFICE_SETTINGS_MAX_LIST.
const ATLAS_POSTOFFICE_SETTINGS_MAX_LIST = 500;

// Shared read-modify-write for the self-service settings endpoints
// (atlas/postoffice/mailmode.php, block.php, unblock.php) — finds the
// CALLER's own live (non-revoked) membership by owner public key, under
// the same exclusive lock the whole operation runs under, and hands it to
// $mutate to change in place before saving. Same flock-guarded
// c+/ftruncate/rewind/fwrite pattern record_postoffice_send() above
// already uses. Returns the updated member, or null if the caller isn't a
// member here at all — same "join first" gate send.php's sender-
// membership check already enforces. Mirrors issuer-server/server.js's
// updatePostOfficeMember().
function update_postoffice_member($ownerPublicKey, callable $mutate) {
  $file = atlas_postoffice_members_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return null;
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['members' => []];

  $found = null;
  foreach ($doc['members'] as &$member) {
    if (isset($member['ownerPublicKey']) && $member['ownerPublicKey'] === $ownerPublicKey && !is_revoked($member['credentialId']) && !is_suspended($member['credentialId'])) {
      $mutate($member);
      $found = $member;
      break;
    }
  }
  unset($member);

  if ($found !== null) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $found;
}

// Ends one membership for its owner: clears the handle and consent lists on
// the roster entry. Returns the entry, or null if that credential is not
// listed under that owner. Revoking the credential and emptying its mailbox
// are separate steps for the caller (atlas_revoke, delete_mailbox).
function leave_postoffice_membership($credentialId, $ownerPublicKey) {
  $file = atlas_postoffice_members_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return null;
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['members' => []];
  $found = null;
  foreach ($doc['members'] as &$member) {
    if (($member['credentialId'] ?? null) === $credentialId && ($member['ownerPublicKey'] ?? null) === $ownerPublicKey) {
      unset($member['handle']);
      $member['blockedSenders'] = [];
      $member['friends'] = [];
      $member['mailMode'] = 'open';
      if (empty($member['leftAt'])) $member['leftAt'] = gmdate('Y-m-d\TH:i:s\Z');
      $found = $member;
      break;
    }
  }
  unset($member);
  if ($found !== null) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $found;
}

// Claims a handle for the caller's live membership. The "is it taken" check
// and the write happen under one exclusive lock, so two members claiming
// the same name at once cannot both succeed. A suspended member still holds
// their handle (the operator can lift the suspension, and two members must
// not share a name then); only a revoked membership releases it.
// Returns ['ok' => true, 'member' => ...], ['error' => 'taken'] or
// ['error' => 'not-a-member'].
function claim_postoffice_handle($ownerPublicKey, $handle) {
  $file = atlas_postoffice_members_file();
  $fh = fopen($file, 'c+');
  if ($fh === false) return ['error' => 'not-a-member'];
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['members' => []];

  $target = strtolower($handle);
  $own = null;
  foreach ($doc['members'] as $i => $m) {
    if (!empty($m['handle']) && strtolower($m['handle']) === $target && !is_revoked($m['credentialId']) && ($m['ownerPublicKey'] ?? null) !== $ownerPublicKey) {
      flock($fh, LOCK_UN);
      fclose($fh);
      return ['error' => 'taken'];
    }
    if ($own === null && ($m['ownerPublicKey'] ?? null) === $ownerPublicKey && !is_revoked($m['credentialId']) && !is_suspended($m['credentialId'])) {
      $own = $i;
    }
  }
  if ($own === null) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['error' => 'not-a-member'];
  }
  $doc['members'][$own]['handle'] = $handle;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return ['ok' => true, 'member' => $doc['members'][$own]];
}

// Task #94 (handle addressing, the last remaining Post Office piece —
// "hide the raw public key from users", per direct instruction): a member
// can register a short handle at a domain's Post Office instead of handing
// out their raw public key. Deliberately `handle#domain`, NOT
// `handle@domain` — the @ shape reads as a real email address and would
// mislead people about what this actually is. Unique per domain (not
// globally), matched case-insensitively; the originally-submitted casing
// is what's stored and shown back. Mirrors issuer-server/server.js's
// POSTOFFICE_HANDLE_REGEX/HANDLE_BLOCKLIST.
const ATLAS_POSTOFFICE_HANDLE_PATTERN = '/^[A-Za-z0-9_-]{2,24}$/';
// Server-side port of wallet.js's alias profanity filter — deliberately
// duplicated (not shared) because a handle is presented to OTHER people
// the same way an alias is, and a client-only check is trivially skippable
// by anyone willing to edit their own extension.
const ATLAS_HANDLE_BLOCKLIST = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dick', 'piss',
  'slut', 'whore', 'fag', 'nigger', 'nigga', 'retard', 'rape',
];
function atlas_normalize_for_handle_filter($text) {
  $text = strtolower((string) $text);
  $text = strtr($text, ['0' => 'o', '1' => 'i', '!' => 'i', '3' => 'e', '4' => 'a', '5' => 's', '@' => 'a', '$' => 's']);
  return preg_replace('/[^a-z0-9]/', '', $text);
}
function atlas_handle_contains_blocked_word($handle) {
  $normalized = atlas_normalize_for_handle_filter($handle);
  foreach (ATLAS_HANDLE_BLOCKLIST as $word) {
    if (strpos($normalized, $word) !== false) return true;
  }
  return false;
}

// One LIVE member's roster entry with a given handle, matched case-
// insensitively — used by both atlas/postoffice/resolve.php (the whole
// point of that endpoint) and atlas/postoffice/handle.php (checking a
// handle isn't already taken before letting a caller claim it). Mirrors
// issuer-server/server.js's findMemberByHandle().
function find_postoffice_member_by_handle($handle) {
  $target = strtolower($handle);
  $doc = read_postoffice_members();
  foreach ($doc['members'] as $m) {
    if (!empty($m['handle']) && strtolower($m['handle']) === $target && !is_revoked($m['credentialId']) && !is_suspended($m['credentialId'])) {
      return $m;
    }
  }
  return null;
}

// ---------- serial counters (task #42, flock-guarded like everything
// else above — a real host can genuinely run two mint requests for the
// same class concurrently, unlike the Node demo's single-threaded event
// loop, so the read-check-increment-write below all happens under one
// exclusive lock rather than relying on nothing-else-can-run-in-between
// the way issuer-server/server.js's synchronous version safely can) ----------

function read_serial_counters() {
  $fh = fopen(atlas_serial_counters_file(), 'c+');
  if ($fh === false) return ['counters' => []];
  flock($fh, LOCK_SH);
  $data = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $doc = json_decode($data, true);
  return is_array($doc) ? $doc : ['counters' => []];
}

// Reserves $quantity more units of $cls against $maxSupply (null =
// uncapped). Returns ['ok' => true, 'serial' => N] (N = the count of
// units ever minted after this reservation, 1-based — "the Nth ever
// minted") on success, or ['ok' => false, 'current' => ..., 'maxSupply'
// => ...] if it would exceed the cap. Mirrors issuer-server/server.js's
// reserveSupply() — same "only a genuinely new mint calls this" contract,
// enforced by the caller (mint_asset_by_class() below) checking
// $supersedes === null first.
function reserve_supply($cls, $quantity, $maxSupply) {
  $file = atlas_serial_counters_file();
  $fh = fopen($file, 'c+');
  flock($fh, LOCK_EX);
  $data = stream_get_contents($fh);
  $doc = json_decode($data, true);
  if (!is_array($doc)) $doc = ['counters' => []];
  $current = isset($doc['counters'][$cls]) ? $doc['counters'][$cls] : 0;
  if ($maxSupply !== null && $current + $quantity > $maxSupply) {
    flock($fh, LOCK_UN);
    fclose($fh);
    return ['ok' => false, 'current' => $current, 'maxSupply' => $maxSupply];
  }
  $doc['counters'][$cls] = $current + $quantity;
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return ['ok' => true, 'serial' => $current + $quantity];
}

// Task #250 fourth follow-up (Bruno's own request) — per-mint randomized
// enchantments/stats for the Signet Ring. Mirrors issuer-server/server.js's
// RING_RARITY_TIERS/RING_ENCHANTMENT_POOL/randomRingProperties() exactly in
// shape (same tier names/weights/ranges, same enchantment pool) — the
// actual rolls will obviously never match between two independently
// running instances, but the STRUCTURE (a rarity tier, a duplicate-free
// enchantment list scaled by tier, two named stats in range) is meant to
// be identical, same "same protocol, same shape, independently rolled" bar
// this project already holds cross-domain signature verification to.
$GLOBALS['ATLAS_RING_RARITY_TIERS'] = [
  ['name' => 'common', 'weight' => 50, 'statRange' => [1, 3]],
  ['name' => 'uncommon', 'weight' => 30, 'statRange' => [3, 6]],
  ['name' => 'rare', 'weight' => 15, 'statRange' => [6, 10]],
  ['name' => 'legendary', 'weight' => 5, 'statRange' => [10, 15]],
];
$GLOBALS['ATLAS_RING_ENCHANTMENT_POOL'] = ['fire resistance', 'silent step', 'water breathing', 'quickened reflexes', 'thorns', 'second wind'];

function atlas_pick_weighted_tier($tiers) {
  $total = array_sum(array_column($tiers, 'weight'));
  $roll = mt_rand() / mt_getrandmax() * $total;
  foreach ($tiers as $tier) {
    if ($roll < $tier['weight']) return $tier;
    $roll -= $tier['weight'];
  }
  return $tiers[count($tiers) - 1]; // floating-point rounding fallback — never actually reachable in practice
}
function atlas_sample_without_replacement($pool, $count) {
  $remaining = array_values($pool);
  $picked = [];
  for ($i = 0; $i < $count && count($remaining) > 0; $i++) {
    $idx = random_int(0, count($remaining) - 1);
    $picked[] = $remaining[$idx];
    array_splice($remaining, $idx, 1);
  }
  return $picked;
}
// Enchantment count scales with rarity tier (common: 1, uncommon: 2, rare:
// 3, legendary: 4, capped at the pool's own size), same as the Node side.
function random_ring_properties() {
  $tiers = $GLOBALS['ATLAS_RING_RARITY_TIERS'];
  $pool = $GLOBALS['ATLAS_RING_ENCHANTMENT_POOL'];
  $tier = atlas_pick_weighted_tier($tiers);
  $tierIndex = array_search($tier, $tiers);
  $enchantCount = min($tierIndex + 1, count($pool));
  $enchantments = array_map(
    function ($name) use ($tier) { return $name . ' +' . random_int($tier['statRange'][0], $tier['statRange'][1]); },
    atlas_sample_without_replacement($pool, $enchantCount)
  );
  return [
    'atlas.rarity' => $tier['name'],
    'com.example.enchantments' => $enchantments,
    'com.example.stats' => [
      'luck' => random_int($tier['statRange'][0], $tier['statRange'][1]),
      'defense' => random_int($tier['statRange'][0], $tier['statRange'][1]),
    ],
  ];
}

// Same mechanism as random_ring_properties() above, one step simpler: no
// rarity tier, just three independent whole-percent bonus rolls, mirroring
// issuer-server/server.js's randomHatProperties() exactly in shape (same
// three property keys, same percent ranges).
$GLOBALS['ATLAS_HAT_SPEED_BONUS_PERCENT_RANGE'] = [5, 30];
$GLOBALS['ATLAS_HAT_JUMP_BONUS_PERCENT_RANGE'] = [5, 30];
$GLOBALS['ATLAS_HAT_INTERACT_RANGE_BONUS_PERCENT_RANGE'] = [10, 50];
function random_hat_properties() {
  $speedRange = $GLOBALS['ATLAS_HAT_SPEED_BONUS_PERCENT_RANGE'];
  $jumpRange = $GLOBALS['ATLAS_HAT_JUMP_BONUS_PERCENT_RANGE'];
  $rangeRange = $GLOBALS['ATLAS_HAT_INTERACT_RANGE_BONUS_PERCENT_RANGE'];
  return [
    'atlas.avatar.hatSpeedMultiplier' => 1 + random_int($speedRange[0], $speedRange[1]) / 100,
    'atlas.avatar.hatJumpMultiplier' => 1 + random_int($jumpRange[0], $jumpRange[1]) / 100,
    'atlas.avatar.hatInteractRangeMultiplier' => 1 + random_int($rangeRange[0], $rangeRange[1]) / 100,
  ];
}
