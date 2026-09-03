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

// Deliberately NOT under .well-known (which is served as plain static
// files, world-readable to anyone who knows the URL, same as
// atlas-revocations.json above needs to be) — mail is looked up through
// atlas/mail/check.php instead, which at least requires already knowing
// the credential ids being asked about. Lives in lib/ next to the private
// key file for the same "not meant to be a public crawlable file" reason,
// protected by this folder's .htaccess deny. Mirrors issuer-server/
// server.js's MAIL_FILE (which similarly sits next to the Node server's
// own key file rather than under the public docroot).
function atlas_mail_file() {
  return __DIR__ . '/atlas-mail-store.json';
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

// A roster of who subscribed (credential id + owner public key per
// atlas.membership issuance) — same "not web-reachable" reasoning as
// atlas_mail_file() above, since this is a list of subscriber public keys,
// not something to expose at a URL anyone can guess. There's no listing/
// broadcast endpoint reading this yet — it exists so issue.php can look up
// who to auto-welcome, and so you can open this file directly (cPanel File
// Manager or SSH) if you want to message everyone by hand later. A public
// "list subscribers" API would leak every subscriber's public key to
// anyone who requests it, unlike mail/send.php or mail/check.php which at
// least require already knowing a credential id first — this would need
// real operator authentication (which nothing in this bundle has yet)
// before it's ever safe to expose over HTTP.
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
const ATLAS_ASSET_CATALOG = [
  'atlas.wearable' => [
    'name' => 'Bronze Compass', 'modelPath' => '/assets/compass.glb', 'thumbnailPath' => '/assets/compass.png',
    'fungible' => false, 'presentation' => 'collectible',
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
    // Task #42 demo class: serialized + capped. `serialized => true` has
    // mint_asset_by_class() stamp a running per-instance atlas.serial/
    // atlas.editionSize onto every genuinely new mint (never onto a
    // split/consolidate/trade re-mint — those pass a non-null $supersedes,
    // see reserve_supply() below); `maxSupply => 5` caps total instances
    // ever issued. Deliberately NOT applied to the two fungible element
    // classes below — this feature is orthogonal to them and there's no
    // reason to touch a passing surface for a demo-only feature. Mirrors
    // issuer-server/server.js's ASSET_CATALOG entry of the same name.
    'serialized' => true,
    'maxSupply' => 5,
    'properties' => [
      'atlas.rarity' => 'rare',
      'com.example.material' => 'silver',
      'com.example.origin' => 'Coastal Bazaar',
      'com.example.enchantments' => ['fire resistance', 'silent step', 'luck +2'],
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
  // Mirrors issuer-server/server.js's ASSET_CATALOG entry of the same name.
  'atlas.membership' => [
    'name' => 'Domain Atlas Membership Card', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => false, 'presentation' => 'document',
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
    'properties' => [
      'atlas.rarity' => 'common',
      'com.example.tier' => 'postoffice-member',
      'com.example.issuedFor' => 'global mail routing',
    ],
  ],
  'atlas.element.iron' => [
    'name' => 'Iron Ingot', 'modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png',
    'fungible' => true, 'presentation' => 'collectible',
    'properties' => ['atlas.purity' => '99.9%', 'atlas.state' => 'solid', 'com.example.source' => 'Coastal Bazaar mine'],
  ],
  'atlas.element.gold' => [
    'name' => 'Gold Ingot', 'modelPath' => '/assets/ring.glb', 'thumbnailPath' => '/assets/ring.png',
    'fungible' => true, 'presentation' => 'collectible',
    'properties' => ['atlas.purity' => '99.99%', 'atlas.state' => 'solid', 'com.example.form' => 'ingot'],
  ],
];

// Builds the `asset` wrapper (name/class/model/thumbnail/fungible/
// presentation/properties) for a class, resolving model/thumbnail paths
// against the current request's domain. Returns null for an unknown
// class. Mirrors issuer-server/server.js's ASSET_CATALOG lookup inside
// mintAssetByClass().
function atlas_asset_catalog_entry($assetClass) {
  if (!isset(ATLAS_ASSET_CATALOG[$assetClass])) return null;
  $entry = ATLAS_ASSET_CATALOG[$assetClass];
  // '{domain}' is a literal template token some catalog entries carry
  // (currently just atlas.postoffice.membership) — expanded here at
  // request time, same "resolved against the current request's domain"
  // treatment modelPath/thumbnailPath already get just below. A name with
  // no such token round-trips unchanged.
  $name = str_replace('{domain}', atlas_domain(), $entry['name']);
  $result = [
    'name' => $name, 'class' => $assetClass, 'model' => 'https://' . atlas_domain() . $entry['modelPath'],
  ];
  if (!empty($entry['thumbnailPath'])) $result['thumbnail'] = 'https://' . atlas_domain() . $entry['thumbnailPath'];
  $result['fungible'] = $entry['fungible'];
  $result['presentation'] = $entry['presentation'];
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
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
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
    if (isset($m['ownerPublicKey']) && $m['ownerPublicKey'] === $ownerPublicKey && !is_revoked($m['credentialId'])) {
      return true;
    }
  }
  return false;
}

// Same lookup as is_valid_postoffice_member(), but returns the matching
// roster entry (so the caller can pull its credentialId) instead of a
// bare bool — atlas/postoffice/send.php needs the credentialId itself to
// address the outgoing mail message by.
function find_postoffice_membership($ownerPublicKey) {
  $doc = read_postoffice_members();
  foreach ($doc['members'] as $m) {
    if (isset($m['ownerPublicKey']) && $m['ownerPublicKey'] === $ownerPublicKey && !is_revoked($m['credentialId'])) {
      return $m;
    }
  }
  return null;
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
    if (isset($member['ownerPublicKey']) && $member['ownerPublicKey'] === $ownerPublicKey && !is_revoked($member['credentialId'])) {
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
