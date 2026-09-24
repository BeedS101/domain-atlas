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

// Trading Station membership roster (task #144 Phase 1) — same flat-array
// shape as atlas_postoffice_members_file() above, kept as its own file for
// the same reason Post Office's is separate from the plain subscriber
// roster: a Trading Station membership is a different class, gating a
// different endpoint (POST /atlas/trade/submit instead of
// /atlas/postoffice/send). Not actually consulted as an abuse gate the way
// Post Office's roster is — /atlas/trade/submit instead validates the
// membership credential presented WITH the request (same "prove you hold
// it, right now, signed" shape check_presented_asset already uses for a
// trade balance) — this roster exists for the same future-facing reason
// task #144's own notes flag for directory federation: a self-contained,
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
    // Task #42 demo class: serialized + capped. `serialized => true` has
    // mint_asset_by_class() stamp a running per-instance atlas.serial/
    // atlas.editionSize onto every genuinely new mint (never onto a
    // split/consolidate/trade re-mint — those pass a non-null $supersedes,
    // see reserve_supply() below); `maxSupply` caps total instances
    // ever issued. Deliberately NOT applied to the two fungible element
    // classes below — this feature is orthogonal to them and there's no
    // reason to touch a passing surface for a demo-only feature. Mirrors
    // issuer-server/server.js's ASSET_CATALOG entry of the same name.
    //
    // Raised 5 -> 20 (Bruno's own request, alongside making this class
    // tradeable at the Trading Station — see check_presented_unique_asset()
    // below): 5 was too tight to ever have more than a couple of rings
    // loose enough to actually list/claim through an open Trading Station
    // listing without immediately running the demo dry. reserve_supply()'s
    // running count only ever compares against the CURRENT maxSupply, so
    // already-issued rings keep the serial/editionSize they were minted
    // with; editionSize on any new mint reflects the new cap of 20.
    'serialized' => true,
    'maxSupply' => 20,
    // Task #250 fourth follow-up (Bruno's own request): rarity/
    // enchantments/stats used to be these same three fixed values on EVERY
    // mint. 'randomizeProperties' (see random_ring_properties() below, and
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
  // Equippable looks: no modelPath/thumbnailPath (an outfit isn't a held
  // or displayed object, just a recolor of the shared character model).
  // shirtColor/pantsColor are under atlas.*, not com.example.*, because a
  // client actually has to understand these two specific keys to render
  // anything from them. Mirrors issuer-server/server.js's ASSET_CATALOG
  // entries of the same name.
  'atlas.avatar.outfit.forest' => [
    'name' => 'Forest Ranger Outfit',
    'fungible' => false, 'presentation' => 'collectible',
    'properties' => [
      'atlas.avatar.shirtColor' => '#2f5d3a',
      'atlas.avatar.pantsColor' => '#3b2a1e',
    ],
  ],
  'atlas.avatar.outfit.dusk' => [
    'name' => 'Dusk Wanderer Outfit',
    'fungible' => false, 'presentation' => 'collectible',
    'properties' => [
      'atlas.avatar.shirtColor' => '#4a3b6b',
      'atlas.avatar.pantsColor' => '#22243a',
    ],
  ],
  // Same reasoning as the outfits above, but a separate equip slot — a hat
  // is its own new geometry piece in gltf-mini.js's buildCharacter(), not a
  // recolor of the torso/legs, and wallet.js keeps it in its own storage
  // key so a hat and an outfit can be worn together. Mirrors
  // issuer-server/server.js's ASSET_CATALOG entries of the same name.
  'atlas.avatar.hat.sunhat' => [
    'name' => 'Explorer Sun Hat',
    'fungible' => false, 'presentation' => 'collectible',
    'properties' => [
      'atlas.avatar.hatColor' => '#d9a441',
    ],
  ],
  'atlas.avatar.hat.cap' => [
    'name' => 'Night Watch Cap',
    'fungible' => false, 'presentation' => 'collectible',
    'properties' => [
      'atlas.avatar.hatColor' => '#26282c',
    ],
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
    if (!empty($m['handle']) && strtolower($m['handle']) === $target && !is_revoked($m['credentialId'])) {
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
