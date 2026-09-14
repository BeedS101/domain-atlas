// Domain Atlas — issuer + trading-station demo server (port 8001)
//
// A real implementation of SPEC.md §5 (asset credentials — unique and
// fungible in one shape, distinguished by the signed `asset.fungible`
// flag), §5.4 (splitting/consolidating fungible balances), and §7 (trading
// stations) — not a mock. It generates a genuine ECDSA P-256 keypair on
// first run, signs real credentials with it, and settles real two-party
// trades by checking two independently-signed intents actually mirror each
// other before issuing anything. Nothing here is simulated; everything
// that can be checked cryptographically, is.
//
// As of the task #44 merge, there is exactly one credential type on the
// wire — domain-atlas-asset/1.0 — replacing the former domain-atlas-item/1.0
// and domain-atlas-resource/1.0 pair. `asset.fungible` (signed, fixed per
// class) is what used to be implied by which of the two credential types
// showed up: `false` means `quantity` is always 1 and the whole thing
// moves as a unit (§5.2's transfer-on-loss); `true` means `quantity` is
// splittable/consolidatable (§5.4/§5.4.1) and tradeable (§7). Every
// /atlas/asset/split, /consolidate, and /atlas/trade/* endpoint below rejects
// a fungible:false credential outright — there's nothing for that arithmetic
// to do to a quantity that's definitionally 1 — and /atlas/asset/reissue
// rejects the opposite direction, since a fungible class's `properties`
// has to stay identical across every balance of it for consolidation to
// stay sound (SPEC.md §5.1, §5.1.1).
//
// Demo simplification, stated plainly: in a real deployment the "trading
// station" in §7 would usually be a different party than the issuer whose
// assets are being traded — the spec deliberately allows that. This demo
// collapses issuer and station into one process because there's only one
// asset-issuing domain in the demo; the settlement logic itself (verify
// both intents, verify both balances, issue four new credentials, revoke
// two) doesn't depend on that and would work unchanged if a separate
// station server called this same issuer's endpoints instead of running
// them in-process.
//
// Also collapsed for the demo: a second visitor for §5.2's PvP-loss demo,
// which genuinely needs two distinct signers in one browser tab to show at
// all. The extension represents the primary visitor with a real WebAuthn
// passkey (as it already did for the basic wallet) and a second, purely
// local ECDSA keypair standing in for "the other visitor" — see
// extension/wallet.js's counterparty functions and the README for why
// that's an honest way to demo a two-party protocol without needing two
// physical devices. §7's own two-party need is met differently since v1.15
// removed in-person trading: a listing's poster and its claimant are just
// two ordinary wallets, normally demoed with two separate browser profiles
// (see test/manual-remote-trade.js) rather than this counterparty stand-in.
//
// Zero npm dependencies — Node's built-in http/crypto only.
//
// issuer-php/ is a from-scratch PHP port of this same server for shared
// hosting without a Node.js Selector (see issuer-php/README.txt) — it is
// meant to answer every one of these routes identically, byte-for-byte
// response shape. Any protocol-level change made here (a new endpoint, a
// new field on an issued/checked payload, a new revocation reason, etc.)
// needs the matching change ported to issuer-php/ in the same pass, not as
// separate follow-up work — an established, standing convention for this
// project, not a one-off. See issuer-php/README.txt's own note near its top.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

// All three of these are overridable by environment variable so the same
// code runs unchanged in local dev (defaults below) and behind cPanel's
// Node.js App Selector (Phusion Passenger), which assigns its own port and
// needs the issuer's public files to land in the real document root, not a
// sibling "demo-domain-a" folder that only exists in this repo's layout.
//   PORT         — Passenger sets this itself; never hardcode a port under it.
//   ATLAS_DOMAIN — baked into every issued credential's issuer.domain field.
//                  Get this wrong and re-verification tries to fetch the
//                  issuer's key from the WRONG domain later.
//   ATLAS_DOCROOT — where .well-known/atlas-key.json and
//                  atlas-revocations.json get written/read. Point this at
//                  the real public_html (or wherever /.well-known/spatial.json
//                  already lives) in production.
const DEMO_DOMAIN_A = process.env.ATLAS_DOCROOT
  ? path.resolve(process.env.ATLAS_DOCROOT)
  : path.resolve(__dirname, '..', 'demo-domain-a');
// ATLAS_STATE_DIR — where the private key and every server-process-only
// state file below (mail, subscribers, postoffice members, asset updates,
// serial counters) actually live. Defaults to __dirname (this file's own
// folder), preserving exactly what every one of these paths already
// resolved to before this variable existed — a single Node process only
// ever served one domain (domain-a) that way. It has to become overridable
// because the Post Office feature (task #75) needs a SECOND real issuer
// instance for demo-domain-b, and two instances of this same file sharing
// one __dirname would silently read and overwrite each other's private
// key and mail store — not a hypothetical, that's exactly what running
// `ATLAS_DOCROOT=../demo-domain-b node issuer-server/server.js` a second
// time against the unmodified code would do. Point each instance's
// ATLAS_STATE_DIR at its own folder (see README.md's "Serve the two demo
// domains") and they're fully isolated, same as two separate PHP
// deployments already are for free (issuer-php has no shared __DIR__ to
// collide on in the first place — see its store.php).
const STATE_DIR = process.env.ATLAS_STATE_DIR
  ? path.resolve(process.env.ATLAS_STATE_DIR)
  : __dirname;
// Unlike __dirname (this file's own folder, which obviously always
// exists), an explicit ATLAS_STATE_DIR might be a folder nobody's created
// yet — cheap and idempotent to make sure it's there before anything below
// tries to write into it.
fs.mkdirSync(STATE_DIR, { recursive: true });
const KEY_FILE = path.join(STATE_DIR, 'issuer-private-key.jwk.json');
const PUBLIC_KEY_FILE = path.join(DEMO_DOMAIN_A, '.well-known', 'atlas-key.json');
const REVOCATIONS_FILE = path.join(DEMO_DOMAIN_A, '.well-known', 'atlas-revocations.json');
// Deliberately NOT under .well-known (which is served as plain static
// files, world-readable to anyone who knows the URL) — mail is looked up
// through the /atlas/mail/check endpoint instead, which at least requires
// already knowing the credential IDs being asked about, same as any other
// server-side state that isn't meant to be a public crawlable file. Lives
// next to the private key file for the same "server-process-only state"
// reason, not in the public docroot.
const MAIL_FILE = path.join(STATE_DIR, 'atlas-mail-store.json');
// Same "not under .well-known, not web-reachable" reasoning as MAIL_FILE —
// one entry per asset reissue (SPEC.md §5.1.1 — non-fungible only), keyed
// by the SUPERSEDED credential's id so /atlas/mail/check can answer "what
// happened to the id you asked about" in the same request it already
// answers "what mail arrived for the id you asked about." The public
// atlas-revocations.json file already records that the old id was revoked
// with reason "superseded" (§5.3) — this store is the extra, non-public
// piece a wallet actually needs to act on that: the full replacement
// credential, so adopting it doesn't need a second round trip.
const ASSET_UPDATES_FILE = path.join(STATE_DIR, 'atlas-asset-updates-store.json');
// Same "not under .well-known, not web-reachable" reasoning as MAIL_FILE —
// this is a roster of who subscribed (credential id + owner public key per
// atlas.membership issuance), not something to expose at a URL anyone can
// guess. There's no listing/broadcast endpoint reading this yet — it exists
// so /atlas/asset/issue can look up who to auto-welcome, and so the operator can
// open the file directly (this is a demo running as a plain process; a real
// deployment would read it from wherever it actually runs) if they want to
// message everyone by hand later. A public "list subscribers" API would leak
// every subscriber's public key to anyone who requests it, unlike
// /atlas/mail/send or /atlas/mail/check which at least require already
// knowing a credential id — worth real operator authentication before ever
// exposing this over HTTP.
const SUBSCRIBERS_FILE = path.join(STATE_DIR, 'atlas-subscribers-store.json');
// Post Office (task #75/#87): a roster of who holds a currently-valid
// Global Mail membership from THIS domain — one entry per
// atlas.postoffice.membership credential ever issued, same flat-array
// shape as SUBSCRIBERS_FILE above. This is the abuse gate the design
// discussion flagged as needed once addressing has no registration step
// of its own: POST /atlas/postoffice/send only accepts a message for a
// recipient this roster (checked against current revocation status too)
// says actually holds membership here — anyone can attempt to send, but
// this domain only agrees to store/relay mail for someone it issued a
// card to.
const POSTOFFICE_MEMBERS_FILE = path.join(STATE_DIR, 'atlas-postoffice-members-store.json');
// Task #97 (SPEC.md §11.4, domain-to-domain federation): the operator-level
// safety valve federation is explicitly built with, per Bruno's own request
// alongside choosing "auto-federate by default." Federation itself needs no
// registration (any domain publishing a valid atlas-key.json can relay in or
// out, matching this protocol's existing no-registration posture generally)
// — this file is the ONE-SIDED exception: an operator naming a specific
// relaying domain whose attestations (see verifyRelayAttestation below) THIS
// domain will no longer accept, checked before that verification ever runs.
// Deliberately a plain operator-edited JSON file, not a new admin-auth API
// surface, same "state dir, git-ignored, edit it directly" posture the
// issuer's own private key already has — a real admin UI for this is a
// nice-to-have nobody's asked for yet, not a blocker to the mechanism itself
// working. Distinct from POSTOFFICE_MEMBERS_FILE's per-member block list
// (SPEC.md §11.3): that blocks one troublesome SENDER; this blocks an entire
// PEER DOMAIN's relayed mail outright, regardless of which of its members
// sent it.
const FEDERATION_BLOCKLIST_FILE = path.join(STATE_DIR, 'atlas-federation-blocklist.json');
// Trading Station membership roster (task #144 Phase 1) — same flat-array
// shape as POSTOFFICE_MEMBERS_FILE above, kept as its own file for the same
// reason Post Office's is separate from the plain subscriber roster: a
// Trading Station membership is a different class, gating a different
// endpoint (POST /atlas/trade/submit instead of /atlas/postoffice/send).
// Not actually consulted as an abuse gate the way Post Office's roster is
// today — /atlas/trade/submit instead validates the membership credential
// presented WITH the request (same "prove you hold it, right now, signed"
// shape checkPresentedAsset already uses for a trade balance) — this
// roster exists for the same future-facing reason task #144's own notes
// flag for directory federation: a self-contained, appendable record of
// who's joined, ready for a "list this station's members" or federation
// step later without needing a schema change then.
const TRADINGSTATION_MEMBERS_FILE = path.join(STATE_DIR, 'atlas-tradingstation-members-store.json');
// Pending remote trade intents (task #144 Phase 1) — one entry per
// submitted-but-not-yet-matched intent, holding both the signed intent
// envelope and the presented balance credential exactly as submitted, so a
// later matching call has everything it needs to settle without asking the
// original submitter to resend anything. Same plain-read-write shape as
// every other store in this file (POSTOFFICE_MEMBERS_FILE etc.) — safe
// without a lock for the same single-threaded-Node reason documented
// there. Removed once matched (removePendingTrade) or once found expired
// (pruned lazily wherever this store is read for matching, not on a
// timer — same "no background sweep" simplicity as the rest of this demo).
const PENDING_TRADES_FILE = path.join(STATE_DIR, 'atlas-pending-trades-store.json');
// Post Office abuse detection (task #96): how many sends within how large
// a rolling window counts as "irregular" enough to auto-flag a membership
// for the operator's attention — see recordPostOfficeSend() below. Tunable
// via env for a real deployment; the demo defaults are picked to be easy
// to actually trigger and see, not tuned against any real spam pattern.
const POSTOFFICE_SPAM_THRESHOLD = parseInt(process.env.ATLAS_POSTOFFICE_SPAM_THRESHOLD || '5', 10);
const POSTOFFICE_SPAM_WINDOW_MS = parseInt(process.env.ATLAS_POSTOFFICE_SPAM_WINDOW_MS || '60000', 10);
// How long a send timestamp stays in a member's log before being pruned —
// independent of the flagging window above, since an operator reviewing
// the roster later might want to see "N sends over the last day" even
// once the burst that triggered flagging has scrolled out of the
// detection window. Bounds the log's growth for an otherwise-unbounded list.
const POSTOFFICE_SEND_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
// Post Office consent/block model (task #94): a sanity cap on how many
// entries a single member's block list or friends-only snapshot can hold —
// generous for a demo, just a bound against one wallet growing its own
// settings entry without limit. Not a spam-prevention measure in itself
// (that's #96's job); this is only about keeping one member's own roster
// entry from growing unbounded.
const POSTOFFICE_SETTINGS_MAX_LIST = 500;

// Task #94 (handle addressing, the last remaining piece — "hide the raw
// public key from users", per direct instruction): a member can register a
// short, human-typeable handle at a domain's Post Office instead of
// handing out their raw public key. Deliberately NOT `handle@domain` —
// that shape reads as a real email address and would confuse people about
// what this actually is (no inbox provider, no password recovery, nothing
// like SMTP underneath) — so the display/parse separator is `#`, same
// spirit as a Discord-style tag: `bruno#localhost:8002`.
//
// Unique per DOMAIN, not globally — same "one card, one Post Office" scope
// every other membership setting already has; "bruno" can be taken at
// Domain B and free at Domain C. Matching is case-INSENSITIVE (so "Bruno"
// and "bruno" can't both be registered here, and a lookup tolerates the
// caller's capitalization), but the originally-submitted casing is what's
// stored and shown back.
const POSTOFFICE_HANDLE_REGEX = /^[A-Za-z0-9_-]{2,24}$/;
// Server-side port of wallet.js's alias profanity filter (ALIAS_BLOCKLIST/
// normalizeForAliasFilter/aliasContainsBlockedWord) — deliberately
// duplicated rather than shared, since a handle is presented to OTHER
// people (mail cards, "Your address") the exact same way an alias is
// presented over presence, and wallet.js's own comment on that already
// flags why a client-only filter isn't enough for anything actually shown
// to someone else: the check has to run again here, independently,
// because the sender's own client-side check is trivially skippable by
// anyone willing to edit their own extension.
const HANDLE_BLOCKLIST = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dick', 'piss',
  'slut', 'whore', 'fag', 'nigger', 'nigga', 'retard', 'rape'
];
function normalizeForHandleFilter(text) {
  return (text || '')
    .toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/!/g, 'i')
    .replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's')
    .replace(/@/g, 'a').replace(/\$/g, 's')
    .replace(/[^a-z0-9]/g, '');
}
function handleContainsBlockedWord(handle) {
  const normalized = normalizeForHandleFilter(handle);
  return HANDLE_BLOCKLIST.some((word) => normalized.includes(word));
}

// Same "not under .well-known, not web-reachable" reasoning as MAIL_FILE —
// task #42's serialized/limited-edition support. One running count per
// class, incremented only by a genuinely NEW mint (mintAssetByClass()
// below gates this on `supersedes === null`, so a split/consolidate/trade
// re-representing quantity that was already counted the day it was first
// minted — always called with a non-null supersedes — can never be
// double-counted as fresh supply). The same count serves both halves of
// task #42 at once: compared against a class's maxSupply, it's the cap
// enforcement; stamped onto the credential as atlas.serial, it's the
// instance's serial number — "the Nth ever minted" answers both questions.
const SERIAL_COUNTERS_FILE = path.join(STATE_DIR, 'atlas-serial-counters.json');
const PORT = process.env.PORT || 8001;
const DOMAIN = process.env.ATLAS_DOMAIN || 'localhost:8001';

// One catalog for every asset class this issuer knows how to mint —
// unique and fungible alike (SPEC.md §5, task #44's merge of the former
// ITEM_CATALOG and RESOURCE_CATALOG). Each entry carries everything
// `asset` needs: `name`, `model`, an optional `thumbnail`, the two flags
// that are fixed per class and signed fresh on every credential of it
// (`fungible`, `presentation` — SPEC.md §5's "two flags, one discipline"),
// and an optional `properties` bag. Looked up fresh by issueAsset() on
// every mint/split/consolidate/trade/reissue of a class, never copied
// forward from an older credential — that's what keeps auto-consolidation
// of a fungible class safe: every balance of it always carries the exact
// same properties (and the exact same fungible/presentation) by
// construction, so merging quantities can never blend or drop a differing
// value.
const ASSET_CATALOG = {
  'atlas.wearable': {
    name: 'Bronze Compass',
    model: `https://${DOMAIN}/assets/compass.glb`,
    thumbnail: `https://${DOMAIN}/assets/compass.png`,
    fungible: false,
    presentation: 'collectible',
    // Task #160: tradeScope is the third asset-level flag, a peer to
    // fungible/presentation (SPEC.md's "two flags, one discipline" grows a
    // third). 'local' is the default for anything not explicitly set below
    // (see mintAssetByClass's `catalogEntry.tradeScope || 'local'`) — it's
    // the status quo for everything already tradeable today, since a trade
    // can only ever settle at the asset's own issuing domain regardless of
    // any flag (only that domain holds the signing key to re-mint it). Only
    // spelled out explicitly here for classes where it isn't the default.
    properties: {
      'atlas.rarity': 'common',
      'com.example.era': 'Victorian',
      'com.example.material': 'brass',
      'com.example.condition': 'well-worn'
    }
  },
  'atlas.badge': {
    name: 'Plaza Visitor Badge',
    model: `https://${DOMAIN}/assets/badge.glb`,
    thumbnail: `https://${DOMAIN}/assets/badge.png`,
    fungible: false,
    presentation: 'collectible',
    properties: {
      'atlas.rarity': 'common',
      'com.example.issuedFor': 'Plaza visit',
      'com.example.season': 'Season 1'
    }
  },
  // A properties bag showcase: several plain static values (rarity,
  // material, origin) alongside one ARRAY-valued property
  // (com.example.enchantments) — the properties bag (SPEC.md §5.1) is
  // just an open JSON object, so a value doesn't have to be a single
  // string the way every other entry in this catalog happens to use.
  'atlas.wearable.ring': {
    name: "Merchant's Signet Ring",
    model: `https://${DOMAIN}/assets/ring.glb`,
    thumbnail: `https://${DOMAIN}/assets/ring.png`,
    fungible: false,
    presentation: 'collectible',
    // Task #42 demo class: serialized + capped. `serialized: true` has
    // mintAssetByClass() stamp a running per-instance atlas.serial/
    // atlas.editionSize onto every genuinely new mint (never onto a
    // split/consolidate/trade re-mint — those aren't new supply, see
    // reserveSupply() below); `maxSupply: 5` caps total instances ever
    // issued. Deliberately NOT applied to atlas.element.iron/gold —
    // those are fungible classes exercised heavily by existing tests,
    // and this feature is orthogonal to them (maxSupply alone would work
    // there too, but there's no reason to touch a passing surface for a
    // demo-only feature).
    serialized: true,
    maxSupply: 5,
    properties: {
      'atlas.rarity': 'rare',
      'com.example.material': 'silver',
      'com.example.origin': 'Coastal Bazaar',
      'com.example.enchantments': ['fire resistance', 'silent step', 'luck +2']
    }
  },
  // The "subscribe to this domain" credential discussed for the mail
  // system below: requesting one of these is what a wallet's mail-check
  // loop treats as opting in to hearing from this domain (see
  // /atlas/mail/check) — deliberately reuses the ordinary asset-issuance
  // machinery (requestAssetBtn, oncePerUser-style capping) rather than
  // needing any new issuance mechanism. Reuses the badge's model/thumbnail
  // rather than pointing at nonexistent assets. `presentation: 'document'`
  // here rather than 'collectible' — a membership card is administrative,
  // not something a client would show off on a shelf alongside a compass.
  'atlas.membership': {
    name: 'Domain Atlas Membership Card',
    model: `https://${DOMAIN}/assets/badge.glb`,
    thumbnail: `https://${DOMAIN}/assets/badge.png`,
    fungible: false,
    presentation: 'document',
    // Task #160: user-bound — a relationship credential, not a tradeable
    // good. Blocked outright by checkPresentedAsset() below regardless of
    // the fungible check that already excludes it today; this makes the
    // exclusion an explicit, protocol-visible declaration rather than an
    // accident of it not being fungible.
    tradeScope: 'bound',
    properties: {
      'atlas.rarity': 'common',
      'com.example.tier': 'member',
      'com.example.issuedFor': 'domain subscription'
    }
  },
  // Post Office (task #75/#87, SPEC.md §11.3): the credential that gates
  // POST /atlas/postoffice/send — holding one is what makes THIS domain
  // willing to accept and relay user-to-user mail addressed to your
  // public key, the same "abuse needs its own rule once there's no
  // registration step" gap §11.3 flagged. `presentation: 'document'`,
  // same reasoning as atlas.membership just above: administrative, not a
  // collectible. Name is templated with DOMAIN so it reads as "this
  // domain's card" wherever it's issued from, not a fixed brand string —
  // any domain running this same code and offering the role gets its own
  // correctly-labeled version for free.
  'atlas.postoffice.membership': {
    name: `${DOMAIN} Global Mail Membership Card`,
    model: `https://${DOMAIN}/assets/badge.glb`,
    thumbnail: `https://${DOMAIN}/assets/badge.png`,
    fungible: false,
    presentation: 'document',
    tradeScope: 'bound', // task #160 — same reasoning as atlas.membership above
    properties: {
      'atlas.rarity': 'common',
      'com.example.tier': 'postoffice-member',
      'com.example.issuedFor': 'global mail routing'
    }
  },
  // Trading Station membership (task #144 Phase 1): the credential that
  // gates POST /atlas/trade/submit the exact same way
  // atlas.postoffice.membership gates POST /atlas/postoffice/send just
  // above — holding one is what makes THIS domain willing to hold a
  // wallet's trade intent as an open listing, pending whichever other
  // member claims it (SPEC.md §7). Same one-click issuance path
  // (`atlas.tradingstation.membership` is just
  // another ASSET_CATALOG entry — no dedicated endpoint needed), same
  // `tradeScope: 'bound'` reasoning as the other two membership cards
  // above: a membership itself is a relationship, not a good, so it can
  // never be the THING being traded even once trading UI generalizes
  // beyond fungible classes.
  'atlas.tradingstation.membership': {
    name: `${DOMAIN} Trading Station Membership Card`,
    model: `https://${DOMAIN}/assets/badge.glb`,
    thumbnail: `https://${DOMAIN}/assets/badge.png`,
    fungible: false,
    presentation: 'document',
    tradeScope: 'bound',
    properties: {
      'atlas.rarity': 'common',
      'com.example.tier': 'tradingstation-member',
      'com.example.issuedFor': 'remote trade settlement'
    }
  },
  // Fungible classes (SPEC.md §5.4/§5.4.1: splittable, consolidatable,
  // tradeable — gated by `fungible: true` instead of, as before task #44,
  // by being a different credential type). Neither of these ever had a
  // dedicated model/thumbnail even back when RESOURCE_CATALOG was its own
  // object — that catalog had no model/thumbnail fields at all, since
  // nothing in this demo ever served real iron-ingot/gold-ingot art any
  // more than it serves a real compass.glb. Rather than fabricate new,
  // equally-nonexistent binary asset paths, these reuse two existing
  // unique-item entries' model/thumbnail — badge for iron (a common,
  // everyday-icon feel), the signet ring for gold (already flagged
  // 'rare' above, a fitting look for the scarcer metal).
  'atlas.element.iron': {
    name: 'Iron Ingot',
    model: `https://${DOMAIN}/assets/badge.glb`,
    thumbnail: `https://${DOMAIN}/assets/badge.png`,
    fungible: true,
    presentation: 'collectible',
    properties: { 'atlas.purity': '99.9%', 'atlas.state': 'solid', 'com.example.source': 'Coastal Bazaar mine' }
  },
  'atlas.element.gold': {
    name: 'Gold Ingot',
    model: `https://${DOMAIN}/assets/ring.glb`,
    thumbnail: `https://${DOMAIN}/assets/ring.png`,
    fungible: true,
    presentation: 'collectible',
    properties: { 'atlas.purity': '99.99%', 'atlas.state': 'solid', 'com.example.form': 'ingot' }
  },
  // Added alongside the market's new Mine Silver stall (v1.15) — same
  // reused-art convention as iron/gold above, badge.glb/png again since a
  // mid-tier metal reads closer to iron's "common, everyday-icon" feel than
  // gold's already-rare signet ring.
  'atlas.element.silver': {
    name: 'Silver Ingot',
    model: `https://${DOMAIN}/assets/badge.glb`,
    thumbnail: `https://${DOMAIN}/assets/badge.png`,
    fungible: true,
    presentation: 'collectible',
    properties: { 'atlas.purity': '99.9%', 'atlas.state': 'solid', 'com.example.source': 'Coastal Bazaar mine' }
  },
  // Task #201: a one-off keepsake for beating the in-world chess bot on
  // Hard difficulty, minted alongside the per-win gold reward (see
  // viewer.js's CHESS_WIN_REWARDS / maybeAwardChessWin()) — not gated by
  // any dedicated endpoint, just another catalog entry POST /atlas/asset/
  // issue already knows how to mint, same as everything else here.
  // Reuses the signet ring's model/thumbnail for the same "this one's the
  // rare one" reasoning gold already borrows it for above, rather than
  // the plainer badge.glb every common item reuses. No tradeScope override
  // — like atlas.badge, this is an achievement, not a relationship, so it
  // stays ordinarily tradeable/giftable rather than 'bound'.
  'atlas.trophy.chess': {
    name: 'Chess Champion Trophy',
    model: `https://${DOMAIN}/assets/ring.glb`,
    thumbnail: `https://${DOMAIN}/assets/ring.png`,
    fungible: false,
    presentation: 'collectible',
    properties: {
      'atlas.rarity': 'rare',
      'com.example.awardedFor': 'Defeating the in-world chess bot on Hard difficulty'
    }
  }
};

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.glb': 'model/gltf-binary'
};

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(str) { return new Uint8Array(Buffer.from(str, 'base64url')); }

// Deterministic JSON — must match extension/wallet.js exactly, or a real
// signature will look "invalid" purely from byte-ordering differences.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// DER SEQUENCE(INTEGER r, INTEGER s) -> raw 64-byte r||s. WebAuthn
// assertion signatures arrive DER-encoded; Web Crypto's verify() wants raw.
function derToRawEcdsaSig(der) {
  const bytes = new Uint8Array(der);
  let offset = 2;
  function readInt() {
    if (bytes[offset] !== 0x02) throw new Error('malformed signature: expected INTEGER');
    offset++;
    let len = bytes[offset++];
    let val = bytes.slice(offset, offset + len);
    offset += len;
    while (val.length > 32 && val[0] === 0) val = val.slice(1);
    const out = new Uint8Array(32);
    out.set(val, 32 - val.length);
    return out;
  }
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

// Verifies a signed-payload "envelope" as produced by wallet.js's
// signWithSelf() (a real WebAuthn assertion, challenge = hash of the
// payload) or signWithCounterparty() (a direct ECDSA signature). Same
// dual-mode check on both ends of the wire, same as canonicalize().
async function verifyEnvelope(payload, envelope) {
  const dataHash = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(payload))));

  if (envelope.signerRole === 'webauthn') {
    const clientDataJSON = fromB64url(envelope.clientDataJSON);
    const clientData = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'));
    if (clientData.challenge !== b64url(dataHash)) return false;
    const authData = fromB64url(envelope.authenticatorData);
    const clientDataHash = new Uint8Array(await subtle.digest('SHA-256', clientDataJSON));
    const signedData = new Uint8Array(authData.length + clientDataHash.length);
    signedData.set(authData, 0);
    signedData.set(clientDataHash, authData.length);
    const rawSig = derToRawEcdsaSig(fromB64url(envelope.signature));
    const pub = await subtle.importKey('spki', fromB64url(envelope.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, rawSig, signedData);
  }

  if (envelope.signerRole === 'raw-ecdsa') {
    const pub = await subtle.importKey('raw', fromB64url(envelope.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const data = new TextEncoder().encode(canonicalize(payload));
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(envelope.signature), data);
  }

  return false;
}

// Task #97 (SPEC.md §11.4): reads the operator's own federation blocklist —
// see FEDERATION_BLOCKLIST_FILE's own comment above for what this is and
// isn't. Missing file means nothing is blocked, same "absence is the empty
// case" convention every other store file in this server already uses.
function readFederationBlocklist() {
  if (!fs.existsSync(FEDERATION_BLOCKLIST_FILE)) return { blocked: [] };
  return JSON.parse(fs.readFileSync(FEDERATION_BLOCKLIST_FILE, 'utf8'));
}
function isDomainBlocked(domain) {
  return (readFederationBlocklist().blocked || []).includes(domain);
}

// Same http(s)-scheme-by-hostname convention extension/wallet.js's own
// baseUrl() already uses (plain HTTP for localhost/loopback, since every
// demo/test domain in this project runs that way; HTTPS otherwise) — kept
// in exact sync with that function on purpose, since a mismatch here would
// mean this server tries to relay to another domain over the wrong scheme.
function baseUrl(domain) {
  if (domain.startsWith('http')) return domain.replace(/\/$/, '');
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(domain);
  return ((isLocalHost ? 'http://' : 'https://') + domain).replace(/\/$/, '');
}

// Task #97 (SPEC.md §11.4 step 3): fetches ANOTHER domain's own published
// signing key, the exact same cross-domain trust bootstrap
// verifyCredential() in extension/wallet.js already performs client-side
// (§5 step 1) — this is the first time this SERVER itself has ever needed
// to make an outbound request to another domain, since until federation
// existed, every cross-domain trust check in this protocol was a CLIENT's
// job. Picks whichever published key is valid RIGHT NOW (a relay attestation
// is checked at the moment it arrives, not against some earlier issuedAt the
// way an asset credential's own verification is), rather than requiring the
// caller to know which key era they're in.
async function fetchDomainPublicKey(domain) {
  const res = await fetch(baseUrl(domain) + '/.well-known/atlas-key.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('could not fetch ' + domain + '\'s published key (HTTP ' + res.status + ')');
  const keyDoc = await res.json();
  const now = Date.now();
  const activeKey = (keyDoc.keys || []).find((k) => {
    const from = new Date(k.validFrom).getTime();
    const until = k.validUntil ? new Date(k.validUntil).getTime() : Infinity;
    return now >= from && now <= until;
  });
  if (!activeKey) throw new Error(domain + ' has no currently-valid published key');
  return activeKey.publicKey;
}

// Task #97 (SPEC.md §11.4 step 3): verifies a relaying domain's own
// attestation against a public key already fetched via fetchDomainPublicKey
// above — the raw-ecdsa half of verifyEnvelope, but checked against an
// externally-supplied domain key rather than a key pulled out of the
// envelope itself (a client's own identity key is self-declared and only
// meaningful once bound to something else that vouches for it; a domain's
// published key is ALREADY the trust anchor, nothing further to bind it to).
async function verifyDomainSignature(publicKeyB64url, payload, signatureB64url) {
  try {
    const pub = await subtle.importKey('raw', fromB64url(publicKeyB64url), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const data = new TextEncoder().encode(canonicalize(payload));
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(signatureB64url), data);
  } catch (err) {
    return false;
  }
}

async function loadOrCreateKeypair() {
  if (fs.existsSync(KEY_FILE)) {
    const jwk = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    const privateKey = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const publicKey = await subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, []);
    const rawPublic = await subtle.exportKey('raw', publicKey);
    return { privateKey, publicKeyB64url: b64url(rawPublic) };
  }
  console.log('No issuer key found — generating a new ECDSA P-256 keypair (first run only)...');
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  fs.writeFileSync(KEY_FILE, JSON.stringify(jwk, null, 2));
  const rawPublic = await subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, publicKeyB64url: b64url(rawPublic) };
}

function ensureWellKnownFiles(publicKeyB64url) {
  fs.mkdirSync(path.join(DEMO_DOMAIN_A, '.well-known'), { recursive: true });
  const keyDoc = { keys: [{ publicKey: publicKeyB64url, validFrom: new Date().toISOString(), validUntil: null }] };
  fs.writeFileSync(PUBLIC_KEY_FILE, JSON.stringify(keyDoc, null, 2));
  if (!fs.existsSync(REVOCATIONS_FILE)) {
    fs.writeFileSync(REVOCATIONS_FILE, JSON.stringify({ revoked: [] }, null, 2));
  }
}

function readRevocations() {
  return JSON.parse(fs.readFileSync(REVOCATIONS_FILE, 'utf8'));
}
function isRevoked(id) {
  return readRevocations().revoked.some((r) => r.id === id);
}
function revoke(id, reason) {
  const doc = readRevocations();
  doc.revoked.push({ id, revokedAt: new Date().toISOString(), reason });
  fs.writeFileSync(REVOCATIONS_FILE, JSON.stringify(doc, null, 2));
}

// Task #42: serialized/limited-edition support. One running total per
// class, persisted so it survives restarts (same reasoning as
// REVOCATIONS_FILE/MAIL_FILE). Only ever advanced by a genuinely NEW
// mint — mintAssetByClass() below only calls this when supersedes ===
// null, so a split/consolidate/trade (always called with a non-null
// supersedes, since they re-represent quantity that was already counted
// the day it was first minted) can never double-count. The same running
// total answers both halves of task #42 at once: checked against a
// class's maxSupply before minting, it's the cap; returned as `serial`
// and stamped onto the credential, it's "the Nth ever minted".
function readSerialCounters() {
  if (!fs.existsSync(SERIAL_COUNTERS_FILE)) return { counters: {} };
  return JSON.parse(fs.readFileSync(SERIAL_COUNTERS_FILE, 'utf8'));
}
function reserveSupply(cls, quantity, maxSupply) {
  const doc = readSerialCounters();
  const current = doc.counters[cls] || 0;
  if (typeof maxSupply === 'number' && current + quantity > maxSupply) {
    return { ok: false, current, maxSupply };
  }
  doc.counters[cls] = current + quantity;
  fs.writeFileSync(SERIAL_COUNTERS_FILE, JSON.stringify(doc, null, 2));
  return { ok: true, serial: current + quantity };
}

// Mail store: a flat array of signed messages, each tied to one
// credentialId (SPEC.md-style trust scoping discussed alongside this
// feature — a message about a credential carries the same issuer
// signature a re-verifier already knows how to check, no new key
// management needed). Same read/append shape as revocations above.
function readMail() {
  if (!fs.existsSync(MAIL_FILE)) return { messages: [] };
  return JSON.parse(fs.readFileSync(MAIL_FILE, 'utf8'));
}
function appendMail(message) {
  const doc = readMail();
  doc.messages.push(message);
  fs.writeFileSync(MAIL_FILE, JSON.stringify(doc, null, 2));
}

// Asset-update store (SPEC.md §5.1.1) — read/append shape identical to
// mail above. Each entry is exactly the {id, status, reason, newCredential}
// shape /atlas/mail/check hands back for a superseded id: `id` is the OLD
// (now-revoked) credential id, so a lookup by requested credentialId is a
// single scan, same cost as the mail filter right above it.
function readAssetUpdates() {
  if (!fs.existsSync(ASSET_UPDATES_FILE)) return { updates: [] };
  return JSON.parse(fs.readFileSync(ASSET_UPDATES_FILE, 'utf8'));
}
function appendAssetUpdate(update) {
  const doc = readAssetUpdates();
  doc.updates.push(update);
  fs.writeFileSync(ASSET_UPDATES_FILE, JSON.stringify(doc, null, 2));
}

// Subscriber roster: one entry per atlas.membership credential ever issued.
// Same flat-array-in-a-JSON-file shape as mail/revocations above.
function readSubscribers() {
  if (!fs.existsSync(SUBSCRIBERS_FILE)) return { subscribers: [] };
  return JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
}
function appendSubscriber(entry) {
  const doc = readSubscribers();
  doc.subscribers.push(entry);
  fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(doc, null, 2));
}

// Post Office membership roster — same flat-array-in-a-JSON-file shape as
// readSubscribers/appendSubscriber above, kept as its own file/function
// pair rather than folded into it because the two rosters answer different
// questions (who subscribed to hear FROM this domain, vs. who this domain
// will accept mail addressed TO) and a Global Mail membership is a
// different class than atlas.membership.
function readPostOfficeMembers() {
  if (!fs.existsSync(POSTOFFICE_MEMBERS_FILE)) return { members: [] };
  return JSON.parse(fs.readFileSync(POSTOFFICE_MEMBERS_FILE, 'utf8'));
}
function appendPostOfficeMember(entry) {
  const doc = readPostOfficeMembers();
  doc.members.push(entry);
  fs.writeFileSync(POSTOFFICE_MEMBERS_FILE, JSON.stringify(doc, null, 2));
}
// True if ownerPublicKey currently holds AT LEAST ONE valid (non-revoked)
// atlas.postoffice.membership credential from this domain — the send
// endpoint's whole abuse gate. Checks every membership entry for that
// owner, not just the first, so a re-issued/replacement card (or simply a
// second one) still counts — only actually mattering the day this domain
// supports revoking one without silently cutting the owner off mail
// entirely, which nothing here does yet, but the check is written to be
// correct either way at no extra cost.
function isValidPostOfficeMember(ownerPublicKey) {
  const doc = readPostOfficeMembers();
  return doc.members.some((m) => m.ownerPublicKey === ownerPublicKey && !isRevoked(m.credentialId));
}

// Trading Station membership roster — same read/append shape as
// readPostOfficeMembers/appendPostOfficeMember above. See
// TRADINGSTATION_MEMBERS_FILE's own comment for why nothing currently
// reads this back as a gate (that check is done per-request instead,
// against the membership credential the caller actually presents).
function readTradingStationMembers() {
  if (!fs.existsSync(TRADINGSTATION_MEMBERS_FILE)) return { members: [] };
  return JSON.parse(fs.readFileSync(TRADINGSTATION_MEMBERS_FILE, 'utf8'));
}
function appendTradingStationMember(entry) {
  const doc = readTradingStationMembers();
  doc.members.push(entry);
  fs.writeFileSync(TRADINGSTATION_MEMBERS_FILE, JSON.stringify(doc, null, 2));
}

// Pending remote trade store — same read/append shape as the mail/asset-
// update stores above, plus a remove (a settled or cancelled intent
// shouldn't linger and be matchable again) and a prune (an expired one
// should stop being matchable even if nobody's removed it yet). Pruning
// happens lazily, on read, rather than on a timer — same "no background
// sweep in this demo" simplicity as the rest of this file; the only place
// staleness would matter is the matching check right after, which always
// reads fresh via this function.
function readPendingTrades() {
  if (!fs.existsSync(PENDING_TRADES_FILE)) return { trades: [] };
  const doc = JSON.parse(fs.readFileSync(PENDING_TRADES_FILE, 'utf8'));
  const now = Date.now();
  const live = doc.trades.filter((t) => new Date(t.intent.payload.expiresAt).getTime() >= now);
  if (live.length !== doc.trades.length) {
    doc.trades = live;
    fs.writeFileSync(PENDING_TRADES_FILE, JSON.stringify(doc, null, 2));
  }
  return doc;
}
function appendPendingTrade(entry) {
  const doc = readPendingTrades();
  doc.trades.push(entry);
  fs.writeFileSync(PENDING_TRADES_FILE, JSON.stringify(doc, null, 2));
}
function removePendingTrade(id) {
  const doc = readPendingTrades();
  doc.trades = doc.trades.filter((t) => t.id !== id);
  fs.writeFileSync(PENDING_TRADES_FILE, JSON.stringify(doc, null, 2));
}

// Task #96 — records one successful send against the SENDER's own
// membership, called from POST /atlas/postoffice/send right after a
// message actually goes out. Tracking sends (not received mail) because
// that's the half this domain actually controls and can act on: it's the
// domain's own relay being used, not just its inbox being filled.
//
// Deliberately NOT exposed as a new public HTTP endpoint — same "would
// leak every member's public key + activity to anyone who asks, needs
// real operator authentication first" reasoning already written above
// SUBSCRIBERS_FILE. This follows that same established pattern instead:
// the operator opens atlas-postoffice-members-store.json directly (same
// file they'd already open to see who's a member at all) and reads
// `flagged`/`recentSendCount` straight off each entry, plain to see
// without having to eyeball raw timestamps by hand.
//
// `flagged` is a LIVE view, not a sticky bit — recomputed from the
// current log on every write, so a membership that had a burst an hour
// ago and has been quiet since un-flags itself naturally. No separate
// "clear the flag" step exists or is needed. Actually cutting a flagged
// member off is still a deliberate, separate step: the operator decides,
// then calls the existing POST /atlas/revoke with that member's
// credentialId — thanks to #95's symmetric check, that one call already
// cuts off both sending AND receiving through this domain at once.
function recordPostOfficeSend(credentialId) {
  const doc = readPostOfficeMembers();
  const member = doc.members.find((m) => m.credentialId === credentialId);
  if (!member) return; // shouldn't happen — caller already verified this credentialId is a live member
  const now = Date.now();
  const log = (member.sendLog || []).map((iso) => new Date(iso).getTime());
  log.push(now);
  const retained = log.filter((t) => now - t <= POSTOFFICE_SEND_LOG_RETENTION_MS);
  member.sendLog = retained.map((t) => new Date(t).toISOString());
  const recentCount = retained.filter((t) => now - t <= POSTOFFICE_SPAM_WINDOW_MS).length;
  member.recentSendCount = recentCount; // convenience for the operator — avoids recomputing this by hand from sendLog
  member.flagged = recentCount > POSTOFFICE_SPAM_THRESHOLD;
  fs.writeFileSync(POSTOFFICE_MEMBERS_FILE, JSON.stringify(doc, null, 2));
}

// One member's currently-live (non-revoked) roster entry for a given
// owner, from an already-loaded doc — the same lookup senderMembership/
// membership in POST /atlas/postoffice/send do inline, factored out once
// the settings endpoints below needed it a third and fourth time.
function findLiveMember(doc, ownerPublicKey) {
  return doc.members.find((m) => m.ownerPublicKey === ownerPublicKey && !isRevoked(m.credentialId));
}

// Task #94 (consent/block model, "both, recipient's choice" per direct
// instruction): shared read-modify-write for the self-service settings
// endpoints below (mailmode/block/unblock) — finds the CALLER's own live
// membership (never anyone else's — proof.publicKey, once verified by
// verifyEnvelope, IS the caller, so there's no way to name a different
// owner here) and lets it be mutated in place before saving. Returns null
// if the caller isn't a member here at all, same "join first" gate the
// send endpoint's sender-membership check already enforces.
function updatePostOfficeMember(ownerPublicKey, mutate) {
  const doc = readPostOfficeMembers();
  const member = findLiveMember(doc, ownerPublicKey);
  if (!member) return null;
  mutate(member);
  fs.writeFileSync(POSTOFFICE_MEMBERS_FILE, JSON.stringify(doc, null, 2));
  return member;
}

// One LIVE member's roster entry with a given handle, matched case-
// insensitively — the whole point of POST /atlas/postoffice/resolve below,
// and also what POST /atlas/postoffice/handle checks against before
// letting a caller claim one, so both share this single lookup rather than
// two subtly different string-compare implementations drifting apart.
function findMemberByHandle(doc, handle) {
  const target = handle.toLowerCase();
  return doc.members.find((m) => m.handle && m.handle.toLowerCase() === target && !isRevoked(m.credentialId));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

// Handles both GET (task #74 wants real byte progress while a scene loads,
// which needs a working Content-Length; #65's size-estimate tooltip probe
// wants HEAD specifically, to learn a file's size without paying for its
// body) and HEAD (added alongside #65/#74 — previously unsupported, so a
// HEAD request fell through to the 405 in the request handler below,
// which is the actually-standard-but-previously-missing case a tooltip
// probing several asset sizes at once needs; GET's own behavior is
// unchanged). HEAD responds with the exact headers a GET for the same URL
// would send, body omitted, per HTTP's own definition of the method — a
// client can rely on its Content-Length without downloading anything.
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(DEMO_DOMAIN_A, urlPath);
  if (!filePath.startsWith(DEMO_DOMAIN_A)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (statErr, stat) => {
    if (statErr) { res.writeHead(404); return res.end('Not found'); }
    // HTTP-date only carries second precision, so truncate the file's mtime
    // the same way before comparing — otherwise a real unchanged file could
    // spuriously look "newer" than the If-Modified-Since a client echoes
    // back (which itself only has second precision), and would never 304.
    const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString();
    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifModifiedSince && new Date(ifModifiedSince).getTime() >= new Date(lastModified).getTime()) {
      res.writeHead(304, { 'Last-Modified': lastModified, 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    const ext = path.extname(filePath);
    if (req.method === 'HEAD') {
      // Content-Length straight from the stat already in hand — no need to
      // actually read the file just to learn its size.
      res.writeHead(200, {
        'Content-Type': (MIME[ext] || 'application/octet-stream'),
        'Content-Length': String(stat.size),
        'Last-Modified': lastModified,
        'Access-Control-Allow-Origin': '*'
      });
      return res.end();
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': (MIME[ext] || 'application/octet-stream'),
        'Content-Length': String(data.length),
        'Last-Modified': lastModified,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
  });
}

async function main() {
  const { privateKey, publicKeyB64url } = await loadOrCreateKeypair();
  ensureWellKnownFiles(publicKeyB64url);
  console.log('Issuer public key (atlas-key.json):', publicKeyB64url.slice(0, 24) + '...');

  async function sign(payload) {
    const data = new TextEncoder().encode(canonicalize(payload));
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
    return b64url(sig);
  }

  // Verifies an asset credential this issuer itself signed — used before
  // trusting a balance presented back to us for a reissue, split,
  // consolidate, or trade. Same check a stranger would run against our
  // published key; here we already have it in memory.
  async function verifyOwnCredentialSignature(credential, payload) {
    const pub = await subtle.importKey('raw', fromB64url(publicKeyB64url), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const data = new TextEncoder().encode(canonicalize(payload));
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(credential.signature), data);
  }

  // The one issuance path for every asset credential this server signs —
  // unique (fungible: false, quantity always 1) and fungible (quantity any
  // positive integer) alike (SPEC.md §5). Shared by /atlas/asset/issue
  // (supersedes always null — a first minting), /atlas/asset/reissue
  // (supersedes names the id being replaced, non-fungible only), and the
  // split/consolidate/trade endpoints (supersedes names one or more ids
  // being replaced, fungible only). Keeping one signing path for all of
  // them is what guarantees they can never drift out of sync on the
  // payload shape the way independent inline object literals eventually
  // would.
  async function issueAsset(ownerPublicKey, asset, quantity, supersedes) {
    const payload = {
      id: 'urn:atlas:asset:' + webcrypto.randomUUID(),
      asset,
      owner: { publicKey: ownerPublicKey },
      quantity,
      supersedes: supersedes || null,
      issuedAt: new Date().toISOString()
    };
    const signature = await sign(payload);
    return { credential: 'domain-atlas-asset/1.0', ...payload, issuer: { domain: DOMAIN, publicKey: publicKeyB64url }, signature };
  }

  // The signed payload shape (SPEC.md §5: canonicalize({id, asset, owner,
  // quantity, supersedes, issuedAt})) — used both to re-verify a presented
  // credential's signature (before honoring a reissue/split/consolidate/
  // trade request against it) and, via issueAsset() above, to build the
  // payload a fresh signature covers.
  function assetPayloadOf(credential) {
    return {
      id: credential.id, asset: credential.asset, owner: credential.owner,
      quantity: credential.quantity, supersedes: credential.supersedes, issuedAt: credential.issuedAt
    };
  }

  // Builds `asset` fresh from ASSET_CATALOG[cls] and signs it via
  // issueAsset() above — the "looked up fresh on every mint/split/
  // consolidate/trade, never copied from an old balance" discipline
  // SPEC.md §5 requires for `fungible`/`presentation`/`properties`. Used
  // by every endpoint that mints a NEW balance of an existing class
  // (issue, split, consolidate, trade); reissue is the one exception —
  // it patches an existing credential's own `asset` snapshot instead,
  // since a non-fungible asset's properties are deliberately per-instance
  // rather than per-class (SPEC.md §5.1.1).
  async function mintAssetByClass(ownerPublicKey, cls, quantity, supersedes) {
    const catalogEntry = ASSET_CATALOG[cls];
    if (!catalogEntry) throw new Error('unknown asset class: ' + cls);

    // Task #42: cap/serial tracking only applies to genuinely NEW supply
    // (supersedes === null — see reserveSupply()'s comment above), and
    // only when this class opted in via `serialized` and/or `maxSupply`.
    // A split/consolidate/trade re-mint skips this entirely, whatever
    // its supersedes shape, since it's never null for those call sites.
    let serial = null;
    if (supersedes === null && (catalogEntry.serialized || typeof catalogEntry.maxSupply === 'number')) {
      const reservation = reserveSupply(cls, quantity, catalogEntry.maxSupply);
      if (!reservation.ok) {
        const err = new Error(
          `${catalogEntry.name} (${cls}) is sold out: ${reservation.current}/${reservation.maxSupply} already issued`
        );
        err.statusCode = 400;
        throw err;
      }
      serial = reservation.serial;
    }

    const baseProperties = catalogEntry.properties || {};
    const properties = catalogEntry.serialized
      ? { ...baseProperties, 'atlas.serial': String(serial), 'atlas.editionSize': String(catalogEntry.maxSupply) }
      : baseProperties;

    const asset = {
      name: catalogEntry.name, class: cls, model: catalogEntry.model,
      ...(catalogEntry.thumbnail ? { thumbnail: catalogEntry.thumbnail } : {}),
      fungible: catalogEntry.fungible,
      presentation: catalogEntry.presentation,
      // Task #160: the third asset-level flag, always present (never
      // conditionally omitted the way `properties` is) — same discipline
      // fungible/presentation already get, since this is meant to be
      // checked by exact name the same way they are. 'local' is the
      // implicit default for any catalog entry that doesn't set its own
      // (see ASSET_CATALOG's own comment on atlas.wearable).
      tradeScope: catalogEntry.tradeScope || 'local',
      ...(Object.keys(properties).length ? { properties } : {})
    };
    return issueAsset(ownerPublicKey, asset, quantity, supersedes);
  }

  // Validates an asset credential presented back to us for a split,
  // consolidate, or trade — all three of which only make sense for a
  // fungible class (SPEC.md §5.4: quantity is definitionally 1 on a
  // fungible:false credential, so there is nothing for this arithmetic to
  // do to it). Checked directly against the credential's own SIGNED
  // asset.fungible field, not re-derived from ASSET_CATALOG, so this holds
  // even for a credential minted under a since-changed catalog entry.
  async function checkPresentedAsset(credential, expectedOwner, expectedClass, minQuantity) {
    if (!credential || credential.credential !== 'domain-atlas-asset/1.0') return 'not an asset credential';
    if (!credential.owner || credential.owner.publicKey !== expectedOwner) return 'asset does not belong to this signer';
    if (!credential.asset || credential.asset.class !== expectedClass) return 'asset is the wrong class';
    // Task #160: checked ahead of the fungible rejection below so a bound
    // credential gets its own, clearer message rather than the generic
    // "not fungible" one — true for every bound class today anyway (they're
    // all fungible: false), but this is the real, deliberate reason
    // they're excluded, not a side effect of that other check.
    if (credential.asset.tradeScope === 'bound') return 'asset is bound to its owner and cannot be split, consolidated, or traded';
    if (credential.asset.fungible !== true) return 'asset class is not fungible — cannot split, consolidate, or trade a unique asset';
    if (typeof credential.quantity !== 'number' || credential.quantity < minQuantity) return 'asset has insufficient quantity';
    if (isRevoked(credential.id)) return 'asset already revoked';
    const ok = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
    if (!ok) return 'asset signature does not check out';
    return null;
  }

  // Task #144 Phase 1: a lighter check for a held MEMBERSHIP credential
  // presented alongside a request (same shape POST /atlas/trade/submit
  // needs for its "do you actually hold this domain's Trading Station
  // card" gate) — deliberately NOT checkPresentedAsset above, since that
  // function's fungible/minQuantity checks would reject every membership
  // class outright (they're all fungible: false, quantity 1). Everything
  // else is the same discipline: right shape, right owner, right class,
  // not revoked, signature checks out against this issuer's own key.
  async function checkPresentedMembership(credential, expectedOwner, expectedClass) {
    if (!credential || credential.credential !== 'domain-atlas-asset/1.0') return 'not an asset credential';
    if (!credential.owner || credential.owner.publicKey !== expectedOwner) return 'membership does not belong to this signer';
    if (!credential.asset || credential.asset.class !== expectedClass) return 'membership is the wrong class';
    if (isRevoked(credential.id)) return 'membership already revoked';
    const ok = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
    if (!ok) return 'membership signature does not check out';
    return null;
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    try {
      // --- §5 asset credentials ---
      if (req.method === 'POST' && req.url === '/atlas/asset/issue') {
        const { ownerPublicKey, assetClass, quantity } = JSON.parse((await readBody(req)) || '{}');
        if (!ownerPublicKey) return sendJson(res, 400, { error: 'ownerPublicKey is required' });
        const catalogEntry = ASSET_CATALOG[assetClass];
        if (!catalogEntry) {
          return sendJson(res, 400, { error: 'Unknown assetClass. Try atlas.wearable, atlas.badge, atlas.wearable.ring, atlas.membership, atlas.postoffice.membership, atlas.tradingstation.membership, atlas.element.iron, atlas.element.gold, atlas.element.silver, or atlas.trophy.chess.' });
        }

        // fungible: true — quantity is caller-chosen and must be a positive
        // integer. fungible: false — quantity is always exactly 1 (SPEC.md
        // §5): accept it omitted, or explicitly 1, but reject anything else
        // rather than silently ignoring a caller's mistaken request for more
        // than one of a unique class.
        let mintQuantity;
        if (catalogEntry.fungible) {
          if (!Number.isInteger(quantity) || quantity <= 0) {
            return sendJson(res, 400, { error: 'quantity must be a positive integer for a fungible assetClass' });
          }
          mintQuantity = quantity;
        } else {
          if (quantity !== undefined && quantity !== null && quantity !== 1) {
            return sendJson(res, 400, { error: 'quantity must be 1 (or omitted) for a non-fungible assetClass' });
          }
          mintQuantity = 1;
        }

        // A first minting — never a reissue — so supersedes is always null here.
        const credential = await mintAssetByClass(ownerPublicKey, assetClass, mintQuantity, null);
        console.log('Issued', mintQuantity, credential.asset.name, 'to', ownerPublicKey.slice(0, 16) + '...');

        // Subscribing IS requesting this specific asset class (see Mail
        // system notes) — log the subscriber and auto-send a welcome
        // message the same way any other domain-to-subscriber mail works,
        // so the very first thing a new subscriber's wallet picks up on
        // its next mail check is confirmation the subscription worked.
        if (assetClass === 'atlas.membership') {
          appendSubscriber({ credentialId: credential.id, ownerPublicKey, subscribedAt: credential.issuedAt });
          const welcomePayload = {
            id: 'urn:atlas:mail:' + webcrypto.randomUUID(),
            credentialId: credential.id,
            subject: 'Welcome to ' + DOMAIN,
            body: "Thanks for subscribing — you'll hear from us here whenever there's something worth sharing.",
            sentAt: new Date().toISOString()
          };
          const welcomeSignature = await sign(welcomePayload);
          appendMail({ ...welcomePayload, signature: welcomeSignature });
          console.log('Subscriber logged + welcome mail queued for', credential.id);
        }

        // Post Office (task #75/#87): claiming this specific class IS
        // registering for Global Mail here, same "requesting the class is
        // the whole registration step" shape as atlas.membership above —
        // logged to its own roster (see isValidPostOfficeMember, the gate
        // POST /atlas/postoffice/send checks every send against) plus the
        // same welcome-mail courtesy, addressed by THIS credential's id so
        // it arrives through the ordinary /atlas/mail/check loop like
        // anything else this wallet already holds a credential for.
        if (assetClass === 'atlas.postoffice.membership') {
          appendPostOfficeMember({ credentialId: credential.id, ownerPublicKey, joinedAt: credential.issuedAt });
          const welcomePayload = {
            id: 'urn:atlas:mail:' + webcrypto.randomUUID(),
            credentialId: credential.id,
            subject: 'Your address is live',
            body: 'Anyone who has your public key can now reach you through ' + DOMAIN + "'s Global Mail — share it the way you'd share an email address.",
            sentAt: new Date().toISOString()
          };
          const welcomeSignature = await sign(welcomePayload);
          appendMail({ ...welcomePayload, signature: welcomeSignature });
          console.log('Post Office member logged + welcome mail queued for', credential.id);
        }

        // Trading Station (task #144 Phase 1) — same shape as Post Office
        // just above: claiming this class IS joining, logged to its own
        // roster, welcome mail addressed by this credential's own id so it
        // arrives through the ordinary mail-check loop.
        if (assetClass === 'atlas.tradingstation.membership') {
          appendTradingStationMember({ credentialId: credential.id, ownerPublicKey, joinedAt: credential.issuedAt });
          const welcomePayload = {
            id: 'urn:atlas:mail:' + webcrypto.randomUUID(),
            credentialId: credential.id,
            subject: 'Trading Station membership active',
            body: 'You can now submit a remote trade intent to ' + DOMAIN + "'s Trading Station without standing at the stall — it'll hold your offer until a matching counterparty intent arrives.",
            sentAt: new Date().toISOString()
          };
          const welcomeSignature = await sign(welcomePayload);
          appendMail({ ...welcomePayload, signature: welcomeSignature });
          console.log('Trading Station member logged + welcome mail queued for', credential.id);
        }

        return sendJson(res, 200, credential);
      }

      // §5.1.1 reissue — a domain-initiated replacement for an asset it
      // already issued, carrying updated `asset` state (properties, most
      // often). Non-fungible only (SPEC.md §5.1.1): a fungible class's
      // properties have to stay identical across every balance of it for
      // §5.4.1's consolidation to stay sound, so a fungible credential's
      // properties only ever change at the class level (ASSET_CATALOG),
      // never by reissuing one specific balance. This is deliberately NOT
      // a generic "any domain can reissue any asset" endpoint either: it
      // only accepts a credential this issuer's own key actually signed
      // (verifyOwnCredentialSignature below), the same restriction that
      // already applies to honoring a presented balance for a split.
      // `properties` here is a patch merged over the existing
      // asset.properties bag, not a full replacement — convenient for the
      // common case (one fact changed) without forcing every caller to
      // resend properties it isn't touching.
      if (req.method === 'POST' && req.url === '/atlas/asset/reissue') {
        const { credential, properties } = JSON.parse((await readBody(req)) || '{}');
        if (!credential || credential.credential !== 'domain-atlas-asset/1.0') {
          return sendJson(res, 400, { error: 'credential must be a domain-atlas-asset/1.0 credential' });
        }
        if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
          return sendJson(res, 400, { error: 'properties (a patch onto asset.properties) is required' });
        }
        if (!credential.issuer || credential.issuer.domain !== DOMAIN) {
          return sendJson(res, 400, { error: 'credential was not issued by this domain' });
        }
        if (!credential.asset || credential.asset.fungible !== false) {
          return sendJson(res, 400, { error: "reissue only applies to a non-fungible asset — a fungible class's properties are fixed per class (SPEC.md §5.1), not per credential" });
        }
        if (isRevoked(credential.id)) return sendJson(res, 400, { error: 'credential is already revoked' });
        const sigOk = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
        if (!sigOk) return sendJson(res, 400, { error: 'credential signature does not check out against this issuer\'s key' });

        const newAsset = { ...credential.asset, properties: { ...(credential.asset.properties || {}), ...properties } };
        const newCredential = await issueAsset(credential.owner.publicKey, newAsset, credential.quantity, credential.id);
        // Same ordering guarantee §5.4's split/consolidate already give:
        // the new credential is signed FIRST, then the old one revoked —
        // a crash between the two would leave an extra valid asset rather
        // than a holder with neither.
        revoke(credential.id, 'superseded');
        appendAssetUpdate({ id: credential.id, status: 'superseded', reason: 'superseded', newCredential });
        console.log('Reissued', credential.asset.name, credential.id, '->', newCredential.id);
        return sendJson(res, 200, { newCredential });
      }

      if (req.method === 'POST' && req.url === '/atlas/revoke') {
        const { id, reason } = JSON.parse((await readBody(req)) || '{}');
        if (!id) return sendJson(res, 400, { error: 'id is required' });
        revoke(id, reason || 'issuer-request');
        console.log('Revoked', id);
        return sendJson(res, 200, { ok: true });
      }

      // --- §5.4 splitting and consolidating fungible balances ---
      if (req.method === 'POST' && req.url === '/atlas/asset/split') {
        const { credential, sendAmount, toPublicKey } = JSON.parse((await readBody(req)) || '{}');
        if (!credential || !toPublicKey || !Number.isInteger(sendAmount) || sendAmount <= 0) {
          return sendJson(res, 400, { error: 'credential, sendAmount, and toPublicKey are required' });
        }
        const expectedOwner = credential.owner && credential.owner.publicKey;
        const expectedClass = credential.asset && credential.asset.class;
        const problem = await checkPresentedAsset(credential, expectedOwner, expectedClass, sendAmount);
        if (problem) return sendJson(res, 400, { error: problem });

        const remainderQty = credential.quantity - sendAmount;
        const sent = await mintAssetByClass(toPublicKey, expectedClass, sendAmount, credential.id);
        const remainder = remainderQty > 0 ? await mintAssetByClass(expectedOwner, expectedClass, remainderQty, credential.id) : null;
        revoke(credential.id, 'superseded');
        console.log('Split', expectedClass, '- sent', sendAmount, 'kept', remainderQty);
        return sendJson(res, 200, { sent, remainder });
      }

      // Merges several balances of the SAME class, from THIS issuer, owned
      // by the SAME public key, into one. Client-side wallet math alone
      // can't produce this — an asset credential's quantity is only
      // meaningful because the issuer's signature vouches for it, so a
      // merged total needs a fresh signature over that total just like a
      // split's remainder does. Mirrors split's shape: the old balances are
      // revoked ('consolidated' instead of 'superseded') only after the new
      // one is signed, and supersedes carries every superseded id instead
      // of just one. checkPresentedAsset (below) rejects any credential
      // here that isn't fungible, same gate splitting and trading share.
      if (req.method === 'POST' && req.url === '/atlas/asset/consolidate') {
        const { credentials } = JSON.parse((await readBody(req)) || '{}');
        if (!Array.isArray(credentials) || credentials.length < 2) {
          return sendJson(res, 400, { error: 'credentials must be an array of at least two balances' });
        }
        if (credentials.length > 20) {
          return sendJson(res, 400, { error: 'too many balances in one consolidation (max 20 at a time)' });
        }
        const ids = credentials.map((c) => c && c.id);
        if (new Set(ids).size !== ids.length) {
          return sendJson(res, 400, { error: 'duplicate balance in consolidation request' });
        }
        const owner = credentials[0] && credentials[0].owner && credentials[0].owner.publicKey;
        const cls = credentials[0] && credentials[0].asset && credentials[0].asset.class;
        for (const credential of credentials) {
          const problem = await checkPresentedAsset(credential, owner, cls, 1);
          if (problem) return sendJson(res, 400, { error: problem });
        }
        const total = credentials.reduce((sum, c) => sum + c.quantity, 0);
        const merged = await mintAssetByClass(owner, cls, total, ids);
        ids.forEach((id) => revoke(id, 'consolidated'));
        console.log('Consolidated', credentials.length, cls, 'balances into', total, 'for', owner.slice(0, 16) + '...');
        return sendJson(res, 200, merged);
      }

      // --- §7 trading stations (this server plays the station role — see file header) ---
      // Fungible-only, per SPEC.md §7: offer/want only ever name a class
      // and a quantity, which is exactly what a fungible balance is and
      // exactly what a fungible:false asset isn't (there's no quantity to
      // negotiate on a one-of-a-kind thing). checkPresentedAsset enforces
      // this the same way it does for split/consolidate above.

      // Task #144 Phase 1 / v1.14 open listings (SPEC.md §7) — a visitor
      // posts their own half of a trade to the station on its own, with NO
      // counterparty named at all. Posting only ever queues — it never
      // auto-settles against whatever else happens to be pending. That's a
      // deliberate v1.14 change from this endpoint's original Phase 1 shape
      // (which tried to match a fresh submission against a waiting
      // counterparty-pinned intent): once a listing is meant to be publicly
      // browsed and claimed by whoever wants it, silently settling it out
      // from under a browsing buyer because of an unrelated submission
      // elsewhere is exactly backwards. v1.15 removed this server's earlier
      // §7 in-person mechanism (both signed intents arriving in the same
      // call) entirely — this open-listing model is now the only path. See
      // GET /atlas/trade/listings (browse) and POST
      // /atlas/trade/claim (settle) below for the other two-thirds of this.
      //
      // Gated on holding this domain's atlas.tradingstation.membership,
      // presented fresh with the request (checkPresentedMembership) — the
      // same "prove you hold it, right now, signed" shape checkPresentedAsset
      // already uses for the balance itself, not a server-side allow-list
      // lookup (see TRADINGSTATION_MEMBERS_FILE's own comment on why).
      if (req.method === 'POST' && req.url === '/atlas/trade/submit') {
        const { membership, intent, balance } = JSON.parse((await readBody(req)) || '{}');
        if (!membership || !intent || !balance) return sendJson(res, 400, { error: 'membership, intent, and balance are all required' });
        if (!intent.payload || !intent.proof) return sendJson(res, 400, { error: 'intent must carry payload and proof' });

        const envelopeOk = await verifyEnvelope(intent.payload, intent.proof);
        if (!envelopeOk) return sendJson(res, 400, { error: 'intent signature does not check out' });
        const selfPub = intent.proof.publicKey;

        const membershipProblem = await checkPresentedMembership(membership, selfPub, 'atlas.tradingstation.membership');
        if (membershipProblem) return sendJson(res, 400, { error: 'membership: ' + membershipProblem });

        if (new Date(intent.payload.expiresAt).getTime() < Date.now()) return sendJson(res, 400, { error: 'intent has already expired' });

        const offerSelf = intent.payload.offer, wantSelf = intent.payload.want;
        const balanceProblem = await checkPresentedAsset(balance, selfPub, offerSelf.class, offerSelf.quantity);
        if (balanceProblem) return sendJson(res, 400, { error: 'balance: ' + balanceProblem });

        const pendingId = 'urn:atlas:trade:' + webcrypto.randomUUID();
        appendPendingTrade({ id: pendingId, intent, balance, submittedAt: new Date().toISOString() });
        console.log('Listing posted:', offerSelf.quantity, offerSelf.class, '-> wants', wantSelf.quantity, wantSelf.class);
        return sendJson(res, 200, { status: 'pending', pendingId, expiresAt: intent.payload.expiresAt });
      }

      // v1.14 (SPEC.md §7) — browse this station's own open, unexpired
      // listings. Deliberately ungated: reading reveals nothing a poster
      // didn't already choose to make public by posting (offer, want, and
      // their own public key — exactly what a prospective buyer needs),
      // the same "read is open, write is gated" asymmetry Post Office's
      // own inbox-check already has against its send. readPendingTrades()
      // already lazily prunes anything expired, so nothing extra is needed
      // here beyond shaping each entry for a browsing client.
      if (req.method === 'GET' && req.url === '/atlas/trade/listings') {
        const pendingDoc = readPendingTrades();
        const listings = pendingDoc.trades.map((t) => ({
          pendingId: t.id,
          posterPublicKey: t.intent.proof.publicKey,
          offer: t.intent.payload.offer,
          want: t.intent.payload.want,
          expiresAt: t.intent.payload.expiresAt
        }));
        return sendJson(res, 200, { listings });
      }

      // v1.14 (SPEC.md §7) — fulfill one specific open listing by id.
      // Same Intent/Settle discipline §7 already uses, just triggered by a
      // claim naming a listing instead of a live-matched pair arriving
      // together. Delivery to the poster (not live for this call) reuses
      // the same two mechanisms this codebase already has, unmodified: a
      // REMAINDER credential supersedes the old balance id, so it arrives
      // "for free" the next time that wallet's own /atlas/mail/check asks
      // about that (still-held, not-yet-superseded) id — see
      // appendAssetUpdate below, consumed by wallet.js's processAssetUpdates
      // exactly like a reissue. A newly RECEIVED credential (of a class the
      // poster may never have held before, so there's no old id for it to
      // supersede) is instead attached to a system mail message addressed
      // to that same old balance id — task #59's existing, tested
      // gift-claim path (wallet.js's claimMailGift) already knows how to
      // absorb an already-fully-signed credential from a mail attachment,
      // so nothing new is needed on the receiving end at all. The claimant
      // is by definition live for this call, so their own side applies
      // directly in the response — no mail round-trip needed for them.
      if (req.method === 'POST' && req.url === '/atlas/trade/claim') {
        const { pendingId, membership, intent, balance } = JSON.parse((await readBody(req)) || '{}');
        if (!pendingId || !membership || !intent || !balance) return sendJson(res, 400, { error: 'pendingId, membership, intent, and balance are all required' });
        if (!intent.payload || !intent.proof) return sendJson(res, 400, { error: 'intent must carry payload and proof' });

        const envelopeOk = await verifyEnvelope(intent.payload, intent.proof);
        if (!envelopeOk) return sendJson(res, 400, { error: 'intent signature does not check out' });
        const claimantPub = intent.proof.publicKey;

        const membershipProblem = await checkPresentedMembership(membership, claimantPub, 'atlas.tradingstation.membership');
        if (membershipProblem) return sendJson(res, 400, { error: 'membership: ' + membershipProblem });

        if (new Date(intent.payload.expiresAt).getTime() < Date.now()) return sendJson(res, 400, { error: 'intent has already expired' });

        const pendingDoc = readPendingTrades();
        const posted = pendingDoc.trades.find((t) => t.id === pendingId);
        if (!posted) return sendJson(res, 404, { error: 'listing not found — already claimed, withdrawn, or expired' });

        const posterPub = posted.intent.proof.publicKey;
        const offerA = posted.intent.payload.offer, wantA = posted.intent.payload.want;
        const balanceA = posted.balance;
        const offerB = intent.payload.offer, wantB = intent.payload.want, balanceB = balance;

        // Mirror check — the claimant's offer/want must exactly match what
        // this listing wants/offers, same shape §7's own Match step uses.
        if (offerB.class !== wantA.class || offerB.quantity !== wantA.quantity ||
            wantB.class !== offerA.class || wantB.quantity !== offerA.quantity) {
          return sendJson(res, 400, { error: 'your intent does not mirror this listing\'s offer/want' });
        }

        const claimantBalanceProblem = await checkPresentedAsset(balanceB, claimantPub, offerB.class, offerB.quantity);
        if (claimantBalanceProblem) return sendJson(res, 400, { error: 'balance: ' + claimantBalanceProblem });

        // Re-checks the poster's own balance fresh (not just trusted from
        // when it was posted) in case it was since spent or revoked some
        // other way.
        const posterBalanceProblem = await checkPresentedAsset(balanceA, posterPub, offerA.class, offerA.quantity);
        if (posterBalanceProblem) {
          removePendingTrade(posted.id); // no longer honorable — drop it rather than leave a dead listing others keep trying to claim
          return sendJson(res, 400, { error: 'the poster\'s balance no longer checks out (' + posterBalanceProblem + ') — listing withdrawn' });
        }

        const remainderA = balanceA.quantity - offerA.quantity;
        const remainderB = balanceB.quantity - offerB.quantity;
        const [aRemainder, aReceived, bRemainder, bReceived] = await Promise.all([
          remainderA > 0 ? mintAssetByClass(posterPub, offerA.class, remainderA, balanceA.id) : Promise.resolve(null),
          mintAssetByClass(posterPub, wantA.class, wantA.quantity, balanceA.id),
          remainderB > 0 ? mintAssetByClass(claimantPub, offerB.class, remainderB, balanceB.id) : Promise.resolve(null),
          mintAssetByClass(claimantPub, wantB.class, wantB.quantity, balanceB.id)
        ]);
        revoke(balanceA.id, 'superseded');
        revoke(balanceB.id, 'superseded');
        removePendingTrade(posted.id);

        if (aRemainder) appendAssetUpdate({ id: balanceA.id, status: 'superseded', reason: 'superseded', newCredential: aRemainder });
        const noticePayload = {
          id: 'urn:atlas:mail:' + webcrypto.randomUUID(),
          credentialId: balanceA.id,
          subject: 'Listing claimed at ' + DOMAIN,
          body: `Your open listing of ${offerA.quantity} ${offerA.class} for ${wantA.quantity} ${wantA.class} was claimed while you were away.`,
          attachedAsset: aReceived,
          sentAt: new Date().toISOString()
        };
        const noticeSignature = await sign(noticePayload);
        appendMail({ ...noticePayload, signature: noticeSignature });

        console.log('Listing claimed:', offerA.quantity, offerA.class, '<->', offerB.quantity, offerB.class, '(poster notified by mail)');
        return sendJson(res, 200, { status: 'settled', remainder: bRemainder, received: bReceived });
      }

      // v1.14 (SPEC.md §7) — a poster withdraws their own still-open
      // listing. Authorized the same way any other signed action in this
      // spec is: a small envelope over {pendingId, action:'cancel'},
      // accepted only when the signing key matches the listing's own
      // poster. Nothing to withdraw from a listing that's already been
      // claimed or expired — readPendingTrades() has already dropped the
      // latter by the time this looks it up.
      if (req.method === 'POST' && req.url === '/atlas/trade/cancel') {
        const { pendingId, intent } = JSON.parse((await readBody(req)) || '{}');
        if (!pendingId || !intent) return sendJson(res, 400, { error: 'pendingId and intent are both required' });
        if (!intent.payload || !intent.proof) return sendJson(res, 400, { error: 'intent must carry payload and proof' });
        if (intent.payload.pendingId !== pendingId || intent.payload.action !== 'cancel') return sendJson(res, 400, { error: 'intent does not authorize canceling this listing' });

        const envelopeOk = await verifyEnvelope(intent.payload, intent.proof);
        if (!envelopeOk) return sendJson(res, 400, { error: 'intent signature does not check out' });

        const pendingDoc = readPendingTrades();
        const posted = pendingDoc.trades.find((t) => t.id === pendingId);
        if (!posted) return sendJson(res, 404, { error: 'listing not found — already claimed, withdrawn, or expired' });
        if (posted.intent.proof.publicKey !== intent.proof.publicKey) return sendJson(res, 403, { error: 'only the original poster can withdraw this listing' });

        removePendingTrade(pendingId);
        console.log('Listing withdrawn:', posted.intent.payload.offer.quantity, posted.intent.payload.offer.class);
        return sendJson(res, 200, { status: 'canceled' });
      }

      // --- mail (correspondence tied to a held credential — see task
      // notes discussed alongside this feature) ---
      //
      // /atlas/mail/send is the demo/admin side of this: standing in for
      // whatever real interface a domain operator would actually use to
      // write to members (this demo has no such interface, so a plain
      // endpoint fills in for it). It doesn't check that credentialId was
      // really issued by this server — same demo-simplification level as
      // the rest of this file, which trusts its own caller.
      //
      // Task #59: a message can optionally carry an attached asset gift —
      // giftAssetClass/giftOwnerPublicKey/(giftQuantity for a fungible
      // class). When present, the gift is minted right here (same
      // ASSET_CATALOG lookup and fungible/quantity validation
      // /atlas/asset/issue uses, same mintAssetByClass(..., null) — a
      // gift is always fresh NEW supply, never a reissue) and the
      // resulting credential is embedded as `attachedAsset` in the mail
      // payload BEFORE signing, so the mail signature covers it too —
      // nobody, including this server later, can swap in a different
      // gift after the fact without invalidating the message's signature.
      // The wallet does NOT auto-add attachedAsset to the recipient's
      // wallet on mail check the way /atlas/asset/issue does — the whole
      // point of task #59 is an explicit Claim action (see
      // extension/wallet.js's claimMailGift() and viewer.js's mail card),
      // so a gift just sits attached to the message, inert, until claimed.
      if (req.method === 'POST' && req.url === '/atlas/mail/send') {
        const { credentialId, subject, body, giftAssetClass, giftOwnerPublicKey, giftQuantity } = JSON.parse((await readBody(req)) || '{}');
        if (!credentialId || !subject || !body) {
          return sendJson(res, 400, { error: 'credentialId, subject, and body are required' });
        }

        let attachedAsset;
        if (giftAssetClass) {
          if (!giftOwnerPublicKey) return sendJson(res, 400, { error: 'giftOwnerPublicKey is required when giftAssetClass is set' });
          const catalogEntry = ASSET_CATALOG[giftAssetClass];
          if (!catalogEntry) {
            return sendJson(res, 400, { error: 'Unknown giftAssetClass. Try atlas.wearable, atlas.badge, atlas.wearable.ring, atlas.membership, atlas.element.iron, atlas.element.gold, atlas.element.silver, or atlas.trophy.chess.' });
          }
          // Same fungible/quantity validation as /atlas/asset/issue above.
          let mintQuantity;
          if (catalogEntry.fungible) {
            if (!Number.isInteger(giftQuantity) || giftQuantity <= 0) {
              return sendJson(res, 400, { error: 'giftQuantity must be a positive integer for a fungible giftAssetClass' });
            }
            mintQuantity = giftQuantity;
          } else {
            if (giftQuantity !== undefined && giftQuantity !== null && giftQuantity !== 1) {
              return sendJson(res, 400, { error: 'giftQuantity must be 1 (or omitted) for a non-fungible giftAssetClass' });
            }
            mintQuantity = 1;
          }
          attachedAsset = await mintAssetByClass(giftOwnerPublicKey, giftAssetClass, mintQuantity, null);
        }

        const payload = {
          id: 'urn:atlas:mail:' + webcrypto.randomUUID(),
          credentialId,
          subject,
          body,
          ...(attachedAsset ? { attachedAsset } : {}),
          sentAt: new Date().toISOString()
        };
        const signature = await sign(payload);
        const message = { ...payload, signature };
        appendMail(message);
        console.log('Mail sent for', credentialId, '->', subject, attachedAsset ? '(with gift: ' + attachedAsset.asset.name + ')' : '');
        return sendJson(res, 200, message);
      }

      // /atlas/mail/check is what the wallet's periodic check loop calls —
      // give it every credential id you hold that this domain issued, get
      // back whatever's been sent for any of them. The wallet re-verifies
      // each message's signature itself against this domain's published
      // key (the exact same .well-known/atlas-key.json check it already
      // does for credentials) before trusting or displaying anything —
      // this endpoint doesn't need to do anything special to be trustworthy
      // beyond signing what it hands back, same as every other endpoint here.
      //
      // `updates` (SPEC.md §5.1.1, additive to the existing mail response
      // — this endpoint is task #45's mail check-in cycle, reused as the
      // transport rather than standing up a second polling mechanism)
      // rides the same request: for each requested id that isn't simply
      // still active, one entry naming what happened to it. A superseded
      // asset's entry carries the full replacement credential so the
      // wallet can verify and adopt it without a second round trip — the
      // wallet must still run that verification itself before trusting
      // any of it, this endpoint being "the truth" no more than any other
      // network response is. Ids that are still perfectly valid get no
      // entry at all, same lean-response reasoning as `messages` above
      // only ever containing what's actually new.
      if (req.method === 'POST' && req.url === '/atlas/mail/check') {
        const { credentialIds } = JSON.parse((await readBody(req)) || '{}');
        if (!Array.isArray(credentialIds) || credentialIds.length === 0) {
          return sendJson(res, 400, { error: 'credentialIds must be a non-empty array' });
        }
        const wanted = new Set(credentialIds);
        const messages = readMail().messages.filter((m) => wanted.has(m.credentialId));

        const assetUpdates = readAssetUpdates().updates;
        const revoked = readRevocations().revoked;
        const updates = [];
        for (const id of wanted) {
          const supersession = assetUpdates.find((u) => u.id === id);
          if (supersession) { updates.push(supersession); continue; }
          const revocation = revoked.find((r) => r.id === id);
          if (revocation) updates.push({ id, status: 'revoked', reason: revocation.reason });
        }

        return sendJson(res, 200, { messages, updates });
      }

      // --- Post Office (task #75/#87/#94, SPEC.md §11.3): user-to-user mail
      // routed through THIS domain, distinct from /atlas/mail/send above in
      // exactly the way that endpoint's own comment flags as the one
      // genuinely new server surface the design needed: /atlas/mail/send
      // trusts its own caller (the domain operator); this one has to
      // authenticate an arbitrary stranger instead, since anyone with a
      // wallet can attempt to send here.
      //
      // Membership is now symmetric (task #94, per direct feedback on the
      // first cut of this feature): a domain only relays mail between two
      // people who BOTH hold ITS OWN Global Mail membership card. Holding
      // the card is what makes this domain that person's sending relay, not
      // just their inbox — the sender doesn't need to be standing in this
      // world to send through it, only to have joined it at some point, the
      // same way the recipient doesn't need to be standing here to receive.
      // Three checks, in order:
      // 1. Sender authentication — verifyEnvelope(payload, proof), the same
      //    self-signed-envelope check /atlas/trade/submit and /claim already
      //    use for their own intents. proof.publicKey, once verified, IS the
      //    sender's identity — no separate "from" field in the signed
      //    payload is needed for that, same reasoning a trade intent's own
      //    signer identity already relies on (SPEC.md §7).
      // 2. Sender membership — isValidPostOfficeMember(proof.publicKey)
      //    against THIS domain's own roster. This is what makes "send
      //    through this Post Office" mean something: it's not an open
      //    relay for anyone with a wallet, only for people this domain has
      //    already vouched for by handing them a membership card.
      // 3. Recipient consent — same roster, same membership requirement,
      //    now against payload.to.publicKey. Both sides have to belong to
      //    the SAME Post Office for a message to move between them; a
      //    stranger to this domain — sender or recipient — gets a plain
      //    rejection, not a silently-dropped message, so the caller knows
      //    delivery didn't happen rather than assuming it did.
      //
      // Once all three hold, this domain relays the message exactly the way
      // it sends anything else: addressed by credentialId (the recipient's
      // OWN membership credential id, found via the same roster lookup) so
      // checkAllMail()'s existing "poll every domain I hold a credential
      // from" loop picks it up with zero client-side changes, signed with
      // this domain's own key so extension/wallet.js's verifyMailMessage()
      // trusts it the exact same way it trusts domain-to-subscriber mail —
      // the one addition there is the optional `from` field (see that
      // function's comment) so the recipient's client can show who it's
      // actually from rather than implying it came from the domain itself.
      if (req.method === 'POST' && req.url === '/atlas/postoffice/send') {
        const { payload, proof } = JSON.parse((await readBody(req)) || '{}');
        if (!payload || !proof) return sendJson(res, 400, { error: 'payload and proof are required' });
        if (!payload.to || !payload.to.publicKey || !payload.subject || !payload.body) {
          return sendJson(res, 400, { error: 'payload.to.publicKey, payload.subject, and payload.body are required' });
        }

        const senderOk = await verifyEnvelope(payload, proof);
        if (!senderOk) return sendJson(res, 400, { error: 'sender signature does not check out' });

        const doc = readPostOfficeMembers();
        const senderMembership = doc.members.find((m) => m.ownerPublicKey === proof.publicKey && !isRevoked(m.credentialId));
        if (!senderMembership) {
          return sendJson(res, 400, { error: 'you do not hold a Global Mail membership at this domain — join its Post Office before sending through it' });
        }

        // Task #97 (SPEC.md §11.4, domain-to-domain federation): sender
        // authentication and sender membership above are unchanged and were
        // just checked first, exactly as for a local send — this preserves
        // "not an open relay for anyone with a wallet" under federation too.
        // If payload.to names a domain other than this one, this domain
        // isn't the recipient's home — it becomes the RELAYING party instead
        // of attempting local delivery, and everything below this branch
        // (recipient membership, consent, `from`) becomes the HOME domain's
        // job, run on its own copy of this same handler via /atlas/postoffice/relay.
        if (payload.to.domain && payload.to.domain !== DOMAIN) {
          const relayAttestation = { relayingDomain: DOMAIN, relayingDomainHandle: senderMembership.handle || null };
          const relaySignature = await sign(relayAttestation);
          let relayRes;
          try {
            relayRes = await fetch(baseUrl(payload.to.domain) + '/atlas/postoffice/relay', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ payload, proof, relayAttestation, relaySignature })
            });
          } catch (err) {
            return sendJson(res, 502, { error: 'could not reach ' + payload.to.domain + ' to relay this message: ' + err.message });
          }
          const relayBody = await relayRes.json().catch(() => ({}));
          if (!relayRes.ok) {
            return sendJson(res, relayRes.status, { error: payload.to.domain + ' rejected this message: ' + (relayBody.error || 'unknown reason') });
          }
          recordPostOfficeSend(senderMembership.credentialId); // task #96 — relaying still counts as a send from THIS member, same abuse-detection log as a local send
          console.log('Post Office relayed mail from', proof.publicKey.slice(0, 16) + '...', 'via', DOMAIN, '-> home domain', payload.to.domain, ':', payload.subject);
          return sendJson(res, 200, relayBody);
        }

        const membership = doc.members.find((m) => m.ownerPublicKey === payload.to.publicKey && !isRevoked(m.credentialId));
        if (!membership) {
          return sendJson(res, 400, { error: 'recipient does not hold a valid Global Mail membership at this domain — nothing was sent' });
        }

        // Task #94 (consent/block model): the recipient's own settings on
        // THIS membership can narrow who's allowed to reach them beyond
        // "any fellow member" — checked here, after membership, since it's
        // a courtesy the recipient controls on top of the baseline gate
        // above, not a replacement for it. Block list first (an explicit
        // "not this person, regardless of anything else"), then
        // friends-only mode (a snapshot of the recipient's own Friends
        // list, submitted via POST /atlas/postoffice/mailmode — Friends
        // itself otherwise never leaves the wallet, see wallet.js's own
        // comment on getFriends()). Same rejection wording either way, so
        // a sender can't tell from the error whether they were blocked
        // outright or just never added as a friend.
        const blockedSenders = membership.blockedSenders || [];
        if (blockedSenders.includes(proof.publicKey)) {
          return sendJson(res, 400, { error: 'recipient is not accepting mail from you right now' });
        }
        if (membership.mailMode === 'friendsOnly' && !(membership.friends || []).includes(proof.publicKey)) {
          return sendJson(res, 400, { error: 'recipient is not accepting mail from you right now' });
        }

        // Task #94 (handle addressing): if the sender has registered a
        // handle at THIS domain, stamp it onto `from` alongside the public
        // key — the domain already has it right here in senderMembership,
        // so this is the whole mechanism for the recipient's mail card to
        // show "From bruno#domain" instead of a raw key. No reverse-lookup
        // endpoint needed, and no new privacy surface: it's exactly the
        // same information senderMembership.handle already exposes to
        // anyone who resolves that handle via POST /atlas/postoffice/
        // resolve, just delivered proactively instead of on request.
        const outPayload = {
          id: 'urn:atlas:mail:' + webcrypto.randomUUID(),
          credentialId: membership.credentialId,
          subject: payload.subject,
          body: payload.body,
          from: senderMembership.handle ? { publicKey: proof.publicKey, handle: senderMembership.handle } : { publicKey: proof.publicKey },
          sentAt: new Date().toISOString()
        };
        const signature = await sign(outPayload);
        const message = { ...outPayload, signature };
        appendMail(message);
        recordPostOfficeSend(senderMembership.credentialId); // task #96 — abuse-detection log, see its own comment
        console.log('Post Office relayed mail from', proof.publicKey.slice(0, 16) + '...', '->', payload.to.publicKey.slice(0, 16) + '...', ':', payload.subject);
        return sendJson(res, 200, message);
      }

      // Task #97 (SPEC.md §11.4) — the receiving half of domain-to-domain
      // federation: another domain (the RELAYING domain, having already run
      // /atlas/postoffice/send's own sender-auth + sender-membership checks
      // on its own side) asks THIS domain (the recipient's HOME domain) to
      // finish delivery to one of its own members. Four checks, in order,
      // mirroring SPEC.md §11.4 exactly — each meaningless without the one
      // before it, same discipline §11.3's own three-step order already
      // follows:
      //   1. Sender auth (verifyEnvelope) — re-run independently here, not
      //      trusted secondhand from the relaying domain's own say-so.
      //   2. Relaying-domain authentication (see below) — stands in for
      //      §11.3 step 2 (sender membership), which this domain has no way
      //      to check directly since the sender isn't ITS member.
      //   3. Recipient membership + consent — identical to §11.3 step 3,
      //      just keyed off the ORIGINAL sender's public key rather than
      //      whoever happened to relay the message in.
      if (req.method === 'POST' && req.url === '/atlas/postoffice/relay') {
        const { payload, proof, relayAttestation, relaySignature } = JSON.parse((await readBody(req)) || '{}');
        if (!payload || !proof || !relayAttestation || !relaySignature) {
          return sendJson(res, 400, { error: 'payload, proof, relayAttestation, and relaySignature are required' });
        }
        if (!payload.to || !payload.to.publicKey || !payload.subject || !payload.body) {
          return sendJson(res, 400, { error: 'payload.to.publicKey, payload.subject, and payload.body are required' });
        }
        if (!relayAttestation.relayingDomain) {
          return sendJson(res, 400, { error: 'relayAttestation.relayingDomain is required' });
        }
        // Sanity check, defense in depth rather than a correctness
        // requirement — a well-behaved relaying domain would never send us
        // a message addressed elsewhere, but nothing stops a misbehaving one
        // from trying.
        if (payload.to.domain && payload.to.domain !== DOMAIN) {
          return sendJson(res, 400, { error: 'this message is not addressed to this domain' });
        }

        // Step 1 — sender authentication, independently re-verified here
        // exactly as /atlas/postoffice/send does for a local sender; the
        // relaying domain having already checked this once on its own side
        // is not a substitute for this domain checking it too.
        const senderOk = await verifyEnvelope(payload, proof);
        if (!senderOk) return sendJson(res, 400, { error: 'sender signature does not check out' });

        // Task #97's operator safety valve (see FEDERATION_BLOCKLIST_FILE's
        // own comment): checked BEFORE spending a network round-trip
        // fetching the relaying domain's key, since a blocked domain's
        // attestation is never going to be accepted regardless of whether
        // it's genuine.
        if (isDomainBlocked(relayAttestation.relayingDomain)) {
          return sendJson(res, 403, { error: 'this domain is not accepting relayed mail from ' + relayAttestation.relayingDomain });
        }

        // Step 2 — relaying-domain authentication (SPEC.md §11.4 step 3):
        // fetch ITS published key and verify the attestation against it.
        // This is what stands in for sender-membership when this domain has
        // no way to check the sender's membership at the relaying domain
        // directly — a relaying domain can sign its OWN attestation but
        // cannot forge another domain's, the same asymmetry every other
        // domain-key check in this protocol already relies on.
        let relayingDomainKey;
        try {
          relayingDomainKey = await fetchDomainPublicKey(relayAttestation.relayingDomain);
        } catch (err) {
          return sendJson(res, 502, { error: 'could not verify ' + relayAttestation.relayingDomain + ': ' + err.message });
        }
        const attestationOk = await verifyDomainSignature(relayingDomainKey, relayAttestation, relaySignature);
        if (!attestationOk) {
          return sendJson(res, 400, { error: relayAttestation.relayingDomain + '\'s relay attestation does not check out' });
        }

        // Step 3 — recipient membership + consent, byte-for-byte the same
        // check /atlas/postoffice/send runs for a local send, keyed off the
        // ORIGINAL sender's public key (proof.publicKey) rather than the
        // relaying domain's own identity — a trusted relaying domain vouching
        // for its member does not bypass the recipient's own settings.
        const doc = readPostOfficeMembers();
        const membership = doc.members.find((m) => m.ownerPublicKey === payload.to.publicKey && !isRevoked(m.credentialId));
        if (!membership) {
          return sendJson(res, 400, { error: 'recipient does not hold a valid Global Mail membership at this domain — nothing was sent' });
        }
        const blockedSenders = membership.blockedSenders || [];
        if (blockedSenders.includes(proof.publicKey)) {
          return sendJson(res, 400, { error: 'recipient is not accepting mail from you right now' });
        }
        if (membership.mailMode === 'friendsOnly' && !(membership.friends || []).includes(proof.publicKey)) {
          return sendJson(res, 400, { error: 'recipient is not accepting mail from you right now' });
        }

        // `from` gains `homeDomain` here — SPEC.md §11.4's one addition to
        // §11.3's `from` shape — naming the RELAYING domain (which is where
        // the sender actually holds membership and registered any handle),
        // so the recipient's client can render the sender's real address
        // (handle#relayingDomain) instead of misattributing it to whichever
        // domain happened to deliver the message (this one).
        const from = { publicKey: proof.publicKey, homeDomain: relayAttestation.relayingDomain };
        if (relayAttestation.relayingDomainHandle) from.handle = relayAttestation.relayingDomainHandle;
        const outPayload = {
          id: 'urn:atlas:mail:' + webcrypto.randomUUID(),
          credentialId: membership.credentialId,
          subject: payload.subject,
          body: payload.body,
          from,
          sentAt: new Date().toISOString()
        };
        const signature = await sign(outPayload);
        const message = { ...outPayload, signature };
        appendMail(message);
        console.log('Post Office relay accepted: from', proof.publicKey.slice(0, 16) + '...', 'via', relayAttestation.relayingDomain, '-> local member', payload.to.publicKey.slice(0, 16) + '...', ':', payload.subject);
        return sendJson(res, 200, message);
      }

      // Task #94 (consent/block model, "both, recipient's choice" per direct
      // instruction): three self-service settings endpoints below, all
      // sharing the same self-signed-envelope authentication
      // /atlas/postoffice/send already uses for the sender half —
      // proof.publicKey, once verified, IS the caller, and
      // updatePostOfficeMember() above means a caller can only ever touch
      // THEIR OWN membership here, never someone else's roster entry.
      if (req.method === 'POST' && req.url === '/atlas/postoffice/mailmode') {
        const { payload, proof } = JSON.parse((await readBody(req)) || '{}');
        if (!payload || !proof) return sendJson(res, 400, { error: 'payload and proof are required' });
        if (payload.mode !== 'open' && payload.mode !== 'friendsOnly') {
          return sendJson(res, 400, { error: 'payload.mode must be "open" or "friendsOnly"' });
        }
        if (payload.mode === 'friendsOnly' && !Array.isArray(payload.friends)) {
          return sendJson(res, 400, { error: 'payload.friends (an array of public keys) is required when switching to friendsOnly' });
        }
        if (payload.friends && payload.friends.length > POSTOFFICE_SETTINGS_MAX_LIST) {
          return sendJson(res, 400, { error: `friends list too large (max ${POSTOFFICE_SETTINGS_MAX_LIST})` });
        }
        const ok = await verifyEnvelope(payload, proof);
        if (!ok) return sendJson(res, 400, { error: 'signature does not check out' });

        const member = updatePostOfficeMember(proof.publicKey, (m) => {
          m.mailMode = payload.mode;
          // Friends only means anything in friendsOnly mode — clearing it
          // on the way back to open is a small privacy courtesy (no reason
          // to keep a snapshot around once nothing checks it), not a
          // functional requirement.
          m.friends = payload.mode === 'friendsOnly'
            ? Array.from(new Set(payload.friends.filter((k) => typeof k === 'string'))).slice(0, POSTOFFICE_SETTINGS_MAX_LIST)
            : [];
        });
        if (!member) return sendJson(res, 400, { error: 'you do not hold a Global Mail membership at this domain' });
        console.log('Post Office mail mode set for', proof.publicKey.slice(0, 16) + '...', '->', member.mailMode, member.mailMode === 'friendsOnly' ? `(${member.friends.length} friends)` : '');
        return sendJson(res, 200, { ok: true, mailMode: member.mailMode, friendsCount: (member.friends || []).length });
      }

      if (req.method === 'POST' && req.url === '/atlas/postoffice/block') {
        const { payload, proof } = JSON.parse((await readBody(req)) || '{}');
        if (!payload || !proof) return sendJson(res, 400, { error: 'payload and proof are required' });
        if (!payload.blockedPublicKey || typeof payload.blockedPublicKey !== 'string') {
          return sendJson(res, 400, { error: 'payload.blockedPublicKey is required' });
        }
        const ok = await verifyEnvelope(payload, proof);
        if (!ok) return sendJson(res, 400, { error: 'signature does not check out' });

        const member = updatePostOfficeMember(proof.publicKey, (m) => {
          const set = new Set(m.blockedSenders || []);
          if (set.size < POSTOFFICE_SETTINGS_MAX_LIST) set.add(payload.blockedPublicKey);
          m.blockedSenders = Array.from(set);
        });
        if (!member) return sendJson(res, 400, { error: 'you do not hold a Global Mail membership at this domain' });
        console.log('Post Office block added for', proof.publicKey.slice(0, 16) + '...', '->', payload.blockedPublicKey.slice(0, 16) + '...');
        return sendJson(res, 200, { ok: true, blockedSenders: member.blockedSenders });
      }

      if (req.method === 'POST' && req.url === '/atlas/postoffice/unblock') {
        const { payload, proof } = JSON.parse((await readBody(req)) || '{}');
        if (!payload || !proof) return sendJson(res, 400, { error: 'payload and proof are required' });
        if (!payload.blockedPublicKey || typeof payload.blockedPublicKey !== 'string') {
          return sendJson(res, 400, { error: 'payload.blockedPublicKey is required' });
        }
        const ok = await verifyEnvelope(payload, proof);
        if (!ok) return sendJson(res, 400, { error: 'signature does not check out' });

        const member = updatePostOfficeMember(proof.publicKey, (m) => {
          m.blockedSenders = (m.blockedSenders || []).filter((k) => k !== payload.blockedPublicKey);
        });
        if (!member) return sendJson(res, 400, { error: 'you do not hold a Global Mail membership at this domain' });
        return sendJson(res, 200, { ok: true, blockedSenders: member.blockedSenders });
      }

      // Read-your-own-settings — the one Post Office roster lookup that IS
      // safe to expose over HTTP despite the no-public-listing reasoning
      // written above SUBSCRIBERS_FILE and recordPostOfficeSend: it's
      // gated by the exact same self-signed envelope as the write
      // endpoints above, so it only ever hands a caller back THEIR OWN
      // entry — never anyone else's public key, activity, or settings.
      if (req.method === 'POST' && req.url === '/atlas/postoffice/mysettings') {
        const { payload, proof } = JSON.parse((await readBody(req)) || '{}');
        if (!payload || !proof) return sendJson(res, 400, { error: 'payload and proof are required' });
        const ok = await verifyEnvelope(payload, proof);
        if (!ok) return sendJson(res, 400, { error: 'signature does not check out' });

        const doc = readPostOfficeMembers();
        const member = findLiveMember(doc, proof.publicKey);
        if (!member) return sendJson(res, 400, { error: 'you do not hold a Global Mail membership at this domain' });
        return sendJson(res, 200, {
          ok: true,
          mailMode: member.mailMode || 'open',
          blockedSenders: member.blockedSenders || [],
          friendsCount: (member.friends || []).length,
          handle: member.handle || null
        });
      }

      // Task #94 (handle addressing): lets a member claim, change, or
      // clear their own handle at this domain — self-signed the same way
      // as mailmode/block/unblock above, so a caller can only ever touch
      // their own membership. payload.handle is either a string to claim
      // (validated for shape, profanity, and per-domain uniqueness) or an
      // empty string/null to release whatever handle this member currently
      // holds. Re-submitting your OWN current handle is a no-op success,
      // not a "taken" conflict — the uniqueness check below excludes the
      // caller's own live entry from the collision search.
      if (req.method === 'POST' && req.url === '/atlas/postoffice/handle') {
        const { payload, proof } = JSON.parse((await readBody(req)) || '{}');
        if (!payload || !proof) return sendJson(res, 400, { error: 'payload and proof are required' });
        const wantsClear = payload.handle === null || payload.handle === '';
        if (!wantsClear) {
          if (typeof payload.handle !== 'string' || !POSTOFFICE_HANDLE_REGEX.test(payload.handle)) {
            return sendJson(res, 400, { error: 'handle must be 2-24 characters, letters/numbers/underscore/hyphen only' });
          }
          if (handleContainsBlockedWord(payload.handle)) {
            return sendJson(res, 400, { error: 'that handle isn\'t allowed here — try something else' });
          }
        }
        const ok = await verifyEnvelope(payload, proof);
        if (!ok) return sendJson(res, 400, { error: 'signature does not check out' });

        if (!wantsClear) {
          const doc = readPostOfficeMembers();
          const existing = findMemberByHandle(doc, payload.handle);
          if (existing && existing.ownerPublicKey !== proof.publicKey) {
            return sendJson(res, 400, { error: 'that handle is already taken at this Post Office — try another' });
          }
        }

        const member = updatePostOfficeMember(proof.publicKey, (m) => {
          m.handle = wantsClear ? undefined : payload.handle;
        });
        if (!member) return sendJson(res, 400, { error: 'you do not hold a Global Mail membership at this domain' });
        console.log('Post Office handle', wantsClear ? 'cleared for' : 'set for', proof.publicKey.slice(0, 16) + '...', wantsClear ? '' : '-> ' + member.handle);
        return sendJson(res, 200, { ok: true, handle: member.handle || null });
      }

      // Task #94 (handle addressing): the single-lookup resolve step
      // compose uses to turn "bruno" (plus whichever domain is already
      // selected) into the public key sendUserMail actually needs — same
      // "one exact answer if you already know what to ask for, never a
      // dump" shape as every other narrow lookup in this file. No sender
      // authentication here: resolving a handle you already know doesn't
      // require proving who you are, any more than already knowing
      // someone's raw public key would — the actual send is still gated
      // by real membership/consent checks above, this step is purely
      // address lookup.
      if (req.method === 'POST' && req.url === '/atlas/postoffice/resolve') {
        const { handle } = JSON.parse((await readBody(req)) || '{}');
        if (!handle || typeof handle !== 'string') return sendJson(res, 400, { error: 'handle is required' });
        const doc = readPostOfficeMembers();
        const member = findMemberByHandle(doc, handle);
        if (!member) return sendJson(res, 404, { error: 'no one at this Post Office has registered that handle' });
        return sendJson(res, 200, { ok: true, publicKey: member.ownerPublicKey, handle: member.handle });
      }

      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
      res.writeHead(405);
      res.end('Method not allowed');
    } catch (err) {
      console.error(err);
      sendJson(res, err.statusCode || 500, { error: err.message });
    }
  });

  server.listen(PORT, () => {
    console.log(`Issuer + trading station (${DOMAIN}) — listening on port ${PORT}, docroot: ${DEMO_DOMAIN_A}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
