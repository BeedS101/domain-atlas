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
const { webcrypto, timingSafeEqual } = require('crypto');
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
// The admin panel (extension/viewer.js's 🛡️ Admin button hands off a
// session token and lands here — see content.js's 'domain-atlas-admin-
// handoff' listener) ships WITH the issuer software, not with any one
// domain's own site content, so it's served from a fixed folder next to
// this file rather than from ATLAS_DOCROOT — every domain running this
// backend gets it at the same /atlas-admin/ path for free, unmodified.
// The identical file also lives at issuer-php/atlas-admin/index.html.
const ADMIN_PANEL_DIR = path.resolve(__dirname, 'admin-panel');
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
// Same "not under .well-known, not web-reachable" reasoning as MAIL_FILE —
// one ECDH P-256 public key per credentialId, submitted by a visitor who
// wants domain-to-subscriber mail addressed to that credential encrypted
// rather than sent in the clear (see /atlas/mail/register-key). Lives next
// to MAIL_FILE for the same reason: this is state /atlas/mail/send needs to
// consult on every send, not a public document.
const MAIL_ENCRYPTION_KEYS_FILE = path.join(STATE_DIR, 'atlas-mail-encryption-keys.json');
const ASSET_UPDATES_FILE = path.join(STATE_DIR, 'atlas-asset-updates-store.json');
// Same "not under .well-known, not web-reachable" reasoning as MAIL_FILE —
// one entry per asset CLASS an operator has ever patched (POST
// /atlas/admin/class-patch), never one per item or per holder: a bulk
// alternative to reissuing each holder's credential by hand, letting an
// operator set a fact once for a whole non-fungible class (fixing a
// mistake, correcting an over/underpowered roll, tightening a
// tradeScope) and having every CURRENT holder's own wallet pick it up
// automatically on its own next check-in — see applyClassPatchIfStale()
// below. Bounded by how many distinct classes ever get touched (at most
// the size of ASSET_CATALOG), never by how many visitors or items exist,
// so this can't grow the way a per-item ledger would.
const CLASS_PATCHES_FILE = path.join(STATE_DIR, 'atlas-class-patches-store.json');
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
// Domain admin roster: the public keys authorized to act as this domain's
// own operator over HTTP, reusing the same visitor-identity mechanism
// (verifyEnvelope below, SPEC.md §6.2) rather than a separate admin
// username/password system. Same "plain operator-edited JSON file, not a
// new admin-auth API surface" posture FEDERATION_BLOCKLIST_FILE already
// uses, for the same reason: there's an unavoidable bootstrap problem
// (something has to seed the very first admin key), so this is edited by
// hand rather than through a self-service registration endpoint. See
// requireAdmin() below for how a request actually gets checked against
// it, and the admin session layer just below for the short-lived bearer
// token a roster key can trade one signature for.
const ADMIN_KEYS_FILE = path.join(STATE_DIR, 'atlas-admin-keys-store.json');
// Short-lived admin session layer on top of the roster above: the roster
// stays the one source of truth for who's an admin — nothing here can
// make a non-roster key an admin — but re-signing every click with an
// ECDSA key gets impractical for something like a live-updating admin
// page, so a session lets a roster key sign in ONCE (over a fresh nonce,
// so the login itself can't be replayed) and use a random bearer token
// for everything after that, until it's logged out or the token times
// out. See issueAdminNonce/consumeAdminNonce and createAdminSession/
// touchAdminSession/deleteAdminSession below.
const ADMIN_NONCES_FILE = path.join(STATE_DIR, 'atlas-admin-nonces-store.json');
const ADMIN_SESSIONS_FILE = path.join(STATE_DIR, 'atlas-admin-sessions-store.json');
const ADMIN_NONCE_TTL_MS = 2 * 60 * 1000; // long enough to sign and post, short enough a stale one is worthless
const ADMIN_SESSION_TTL_MS = 30 * 60 * 1000; // slides forward on every check — see touchAdminSession
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
// World drops (task #250, SPEC.md §5.5): the "others can see it and pick it
// up" half of dropping an item, deliberately left undone when self-only
// dropping first shipped (see extension/wallet.js's dropItem() comment) —
// this is the "world actually hosting shared state" it said this demo
// didn't have yet. One durable entry per dropped item, keyed by which
// world it's lying in on THIS domain (a world is inherently this domain's
// own concern, same as its scene.json), holding the full original signed
// credential so a browsing visitor can render it without a second round
// trip, plus where in the scene it's sitting. Same plain-read-write shape
// as PENDING_TRADES_FILE above and for the same reason (single-threaded
// Node here; issuer-php's mirror flock()s it, same as its own pending-trades
// file) — reservation-safety comes from removing the entry before minting
// anything, not from a lock on the file itself, see removeWorldDrop's own
// call sites in /atlas/world/drops/claim and /atlas/world/drops/relay-claim.
const WORLD_DROPS_FILE = path.join(STATE_DIR, 'atlas-world-drops-store.json');
// Domain calendar (SPEC.md §12): one flat list of
// events, each tagged with the `worldId` it belongs to (`null` for the
// domain-wide calendar), same "one file, filter on read" shape
// PENDING_TRADES_FILE/WORLD_DROPS_FILE already use above rather than one
// file per world — there's no bound on how many worlds might opt in
// (manifest `calendar: true`, §3), and a single small JSON file scales
// fine for a demo of this size. This server does not itself check that a
// given worldId actually has `calendar: true` in the manifest before
// serving or accepting events for it — same "client-side-only gate, no
// server-side enforcement" posture chatEnabledForWorld() already
// documents for the (unrelated, undocumented-in-SPEC.md) chat opt-in;
// the manifest is what a client reads to decide whether to ask at all.
const CALENDAR_FILE = path.join(STATE_DIR, 'atlas-calendar-store.json');
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
    //
    // Task #250 second follow-up (Bruno's own request): the Compass was
    // deliberately left OUT of the first #250 follow-up (atlas.badge/
    // atlas.trinket.pin/atlas.trinket.charm below, all bound) specifically
    // to keep the flagship non-fungible World Drops demo item droppable.
    // Once the demo's own drop/pickup showcase leans on fungibles instead
    // (atlas.element.iron/gold/silver — already droppable, already the
    // subject of the split-then-drop partial-quantity path) there was no
    // reason left to exempt this one, oncePerUser giveaway from the exact
    // same drop-then-re-request courtesy-check loophole atlas.badge's own
    // comment below explains. World Drops UI/protocol test coverage that
    // used to drop a Bronze Compass now mints atlas.trophy.chess directly
    // instead — see test/manual-drop-pickup.js, manual-previewer-2d.js, and
    // manual-world-drops-protocol(-php).js for the swap.
    tradeScope: 'bound',
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
    // Task #250 follow-up (Bruno's own request): a oncePerUser giveaway's
    // "already collected this" check is only a per-device courtesy (see
    // alreadyHasRequestableItem()'s own comment in viewer.js) — it looks
    // at what's CURRENTLY held, not a real issuance ledger. Without this,
    // dropping the badge and requesting it again would quietly re-arm
    // that courtesy check, letting one visitor collect it over and over.
    // tradeScope: 'bound' closes that off the same way it already does
    // for membership cards, at the cost of the badge never being
    // droppable/tradeable at all — the right tradeoff for something
    // that's meant to just mark "this visitor was here once," not
    // circulate.
    tradeScope: 'bound',
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
    // reserveSupply() below); `maxSupply` caps total instances ever
    // issued. Deliberately NOT applied to atlas.element.iron/gold —
    // those are fungible classes exercised heavily by existing tests,
    // and this feature is orthogonal to them (maxSupply alone would work
    // there too, but there's no reason to touch a passing surface for a
    // demo-only feature).
    //
    // Raised 5 -> 20 (Bruno's own request, alongside making this class
    // tradeable at the Trading Station — see checkPresentedUniqueAsset
    // below): 5 was plenty for proving the cap mechanism works at all, but
    // too tight to ever have more than a couple of rings loose enough to
    // actually list/claim through an open Trading Station listing without
    // immediately running the demo dry. reserveSupply()'s running count is
    // unaffected by this — it only compares against whatever maxSupply
    // currently says, so already-issued rings (serials 1-5, if any exist on
    // a given deployment) keep their own serial/editionSize as originally
    // minted; editionSize on any NEW mint reflects the new cap of 20.
    serialized: true,
    maxSupply: 20,
    // Task #250 fourth follow-up (Bruno's own request): rarity/
    // enchantments/stats used to be these same three fixed values on
    // EVERY mint — genuinely identical rings, only the serial number
    // differed. `randomizeProperties` (see its own comment + RING_RARITY_
    // TIERS/RING_ENCHANTMENT_POOL above reserveSupply) is consulted by
    // mintAssetByClass() for every genuinely new mint and overrides
    // atlas.rarity/com.example.enchantments/com.example.stats with a fresh
    // weighted-rarity roll each time — the `properties` below are now only
    // the FALLBACK shown by GET /atlas/asset/class's pre-mint preview
    // (which reads this catalog entry directly and never rolls anything,
    // since there's no instance yet to roll for) and whatever a caller
    // might reissue this class's properties with; they play no part in an
    // actual mint's outcome.
    properties: {
      'atlas.rarity': 'common',
      'com.example.material': 'silver',
      'com.example.origin': 'Coastal Bazaar',
      'com.example.note': 'Rarity, enchantments, and stats are rolled randomly at mint time'
    },
    randomizeProperties: randomRingProperties
  },
  // Task #208: two small collectibles for the lobby's new walk-up-and-
  // open crates (see demo-domain-a/spatial/lobby/scene.json's
  // interactables and gltf-mini.js's proximity-interact support). Same
  // one-per-wallet 'issue' + oncePerUser pattern the plaza's Bronze
  // Compass/Signet Ring already use above — deliberately distinct
  // classes rather than reusing those two, so opening a lobby crate
  // isn't just the plaza's own reward under a different label for
  // someone who already has it. No new art: reuses the badge/compass
  // models the same way iron/gold/silver already reuse badge/ring.
  'atlas.trinket.pin': {
    name: 'Lobby Enamel Pin',
    model: `https://${DOMAIN}/assets/badge.glb`,
    thumbnail: `https://${DOMAIN}/assets/badge.png`,
    fungible: false,
    presentation: 'collectible',
    // Task #250 follow-up — same "closes the drop-then-re-request
    // courtesy-check loophole" reasoning as atlas.badge above.
    tradeScope: 'bound',
    properties: {
      'atlas.rarity': 'common',
      'com.example.issuedFor': 'Opening the lobby crate',
      'com.example.material': 'enamel'
    }
  },
  'atlas.trinket.charm': {
    name: 'Lucky Charm Keychain',
    model: `https://${DOMAIN}/assets/compass.glb`,
    thumbnail: `https://${DOMAIN}/assets/compass.png`,
    fungible: false,
    presentation: 'collectible',
    // Task #250 follow-up — same reasoning as atlas.badge/atlas.trinket.pin above.
    tradeScope: 'bound',
    properties: {
      'atlas.rarity': 'uncommon',
      'com.example.issuedFor': 'Opening the lobby crate',
      'com.example.material': 'pewter'
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
  // `name` carries the domain (task #227) the same way
  // atlas.tradingstation.membership/atlas.postoffice.membership's names
  // already do just below — so a visitor subscribing from example.com
  // gets an "example.com Subscription Card", not a generic one that reads
  // the same regardless of which domain actually issued it.
  'atlas.membership': {
    name: `${DOMAIN} Subscription Card`,
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
  // Task #203: `exchangeRate` and `isBaseCurrency` — catalog-only config,
  // never signed onto the credential itself, same category as `maxSupply`/
  // `serialized` just above rather than a fourth peer to `fungible`/
  // `presentation`/`tradeScope` (SPEC.md's three signed asset flags stay
  // exactly three — a conversion rate isn't a fact about any individual
  // credential, it's a live, domain-set knob POST /atlas/convert looks up
  // fresh on every call, exactly the same "looked up fresh, never copied
  // forward" discipline mintAssetByClass already gives fungible/
  // presentation/properties). `exchangeRate` reads as "how many units of
  // THIS class equal 1 unit of whichever class on this domain carries
  // `isBaseCurrency: true`" — every convertible class needs its own
  // `exchangeRate` including the base currency itself (always 1, so
  // POST /atlas/convert never needs to special-case "is this the base
  // currency" beyond the UI's own default-selection hint). A class with no
  // `exchangeRate` at all is simply not eligible for conversion (checked
  // the same way GET /atlas/trade/catalog already excludes non-fungible/
  // bound classes). Exactly one class per domain should carry
  // `isBaseCurrency: true` — it's a pure UI/display hint (which side of
  // Convert starts pre-selected) with zero effect on the actual math,
  // which is symmetric between any two rated classes regardless of which
  // one is "the" currency — so a domain can pick a different base
  // currency than gold just by moving the flag, no protocol change needed.
  // `holdingCap` (task #203) is the companion piece: since every one of
  // these three classes is also freely mineable via the market's stalls
  // (no real scarcity — see the comment on POST /atlas/asset/issue's own
  // cap check), a fixed conversion rate alone would make the domain a
  // risk-free arbitrage machine (mine unlimited gold, convert at a fixed
  // rate, no real cost). The cap doesn't fix that by itself, but it does
  // mean mining eventually stops being the answer and Convert/Trade
  // actually has to get used once a wallet is sitting at the ceiling.
  'atlas.element.iron': {
    // Task #206: renamed to match the "<Name> (<Symbol>)" convention every
    // generated element already uses (see elements-catalog.js) — was
    // "Iron Ingot" (a leftover from before #204 gave every OTHER element
    // that same naming scheme).
    name: 'Iron (Fe)',
    model: `https://${DOMAIN}/assets/badge.glb`,
    thumbnail: `https://${DOMAIN}/assets/badge.png`,
    fungible: true,
    presentation: 'collectible',
    exchangeRate: 20, // 20 iron == 1 gold — most common of the three, so the most units per gold
    holdingCap: 500,
    // Task #205: the same real-property set (symbol/atomicNumber/category/
    // weight/density/conductivity) task #204 gave the other 115 elements,
    // added here too — reference values, same source/confidence level as
    // elements-catalog.js's own (see that file's header comment).
    properties: {
      'atlas.symbol': 'Fe', 'atlas.atomicNumber': 26, 'atlas.category': 'transition metal',
      'atlas.state': 'solid', 'atlas.weight': { value: 55.845, unit: 'g/mol' },
      'atlas.density': { value: 7.874, unit: 'g/cm3' },
      'atlas.thermalConductivity': { value: 80.4, unit: 'W/(m*K)' },
      'atlas.electricalConductivity': { value: 10.0, unit: 'MS/m' },
      'atlas.purity': '99.9%', 'com.example.source': 'Coastal Bazaar mine'
    }
  },
  'atlas.element.gold': {
    // Task #206: see the matching comment on atlas.element.iron above.
    name: 'Gold (Au)',
    model: `https://${DOMAIN}/assets/ring.glb`,
    thumbnail: `https://${DOMAIN}/assets/ring.png`,
    fungible: true,
    presentation: 'collectible',
    isBaseCurrency: true, // task #203 — this domain's chosen conversion anchor; see the comment above
    exchangeRate: 1,
    holdingCap: 500,
    // Task #205: see the matching comment on atlas.element.iron above.
    properties: {
      'atlas.symbol': 'Au', 'atlas.atomicNumber': 79, 'atlas.category': 'transition metal',
      'atlas.state': 'solid', 'atlas.weight': { value: 196.97, unit: 'g/mol' },
      'atlas.density': { value: 19.32, unit: 'g/cm3' },
      'atlas.thermalConductivity': { value: 317, unit: 'W/(m*K)' },
      'atlas.electricalConductivity': { value: 45.2, unit: 'MS/m' },
      'atlas.purity': '99.99%', 'com.example.form': 'ingot'
    }
  },
  // Added alongside the market's new Mine Silver stall (v1.15) — same
  // reused-art convention as iron/gold above, badge.glb/png again since a
  // mid-tier metal reads closer to iron's "common, everyday-icon" feel than
  // gold's already-rare signet ring.
  'atlas.element.silver': {
    // Task #206: see the matching comment on atlas.element.iron above.
    name: 'Silver (Ag)',
    model: `https://${DOMAIN}/assets/badge.glb`,
    thumbnail: `https://${DOMAIN}/assets/badge.png`,
    fungible: true,
    presentation: 'collectible',
    exchangeRate: 5, // 5 silver == 1 gold — mid-tier, between iron and gold
    holdingCap: 500,
    // Task #205: see the matching comment on atlas.element.iron above.
    properties: {
      'atlas.symbol': 'Ag', 'atlas.atomicNumber': 47, 'atlas.category': 'transition metal',
      'atlas.state': 'solid', 'atlas.weight': { value: 107.87, unit: 'g/mol' },
      'atlas.density': { value: 10.49, unit: 'g/cm3' },
      'atlas.thermalConductivity': { value: 429, unit: 'W/(m*K)' },
      'atlas.electricalConductivity': { value: 63.0, unit: 'MS/m' },
      'atlas.purity': '99.9%', 'com.example.source': 'Coastal Bazaar mine'
    }
  },
  // Task #201: a one-off keepsake for beating the in-world chess bot on
  // Hard difficulty, minted alongside the per-win gold reward (see
  // viewer.js's CHESS_WIN_REWARDS / maybeAwardChessWin()) — not gated by
  // any dedicated endpoint, just another catalog entry POST /atlas/asset/
  // issue already knows how to mint, same as everything else here.
  // Has its own dedicated model/thumbnail now — an originally-authored,
  // procedurally-generated GLB (tools/make-demo-item-models.js), not the
  // signet ring's borrowed model this used to point at before a genuine
  // trophy asset existed. No tradeScope override — this is a genuine
  // achievement, not a relationship or a scarcity-gated giveaway (unlike
  // atlas.badge/
  // atlas.trinket.pin/atlas.trinket.charm above, all 'bound' as of the
  // task #250 follow-up), so it stays ordinarily tradeable/giftable/
  // droppable.
  'atlas.trophy.chess': {
    name: 'Chess Champion Trophy',
    model: `https://${DOMAIN}/assets/trophy.glb`,
    thumbnail: `https://${DOMAIN}/assets/trophy.png`,
    fungible: false,
    presentation: 'collectible',
    properties: {
      'atlas.rarity': 'rare',
      'com.example.awardedFor': 'Defeating the in-world chess bot on Hard difficulty'
    }
  },
  // A giftable, non-collectible credential for the standalone business
  // demo (demo-domain-a/business-demo.html): a voucher a visitor can send
  // straight to another public key via POST /atlas/asset/transfer, next to
  // atlas.badge as the contrasting bound example the same page issues
  // alongside it. `presentation: 'document'` rather than 'collectible' —
  // this is meant to be redeemed and read, not displayed on a shelf. No
  // tradeScope override, so it defaults to 'local' (giftable/tradeable),
  // the whole point of pairing it with a bound class in that demo. Reuses
  // the badge model/thumbnail rather than commissioning new art, same as
  // atlas.membership/atlas.postoffice.membership above.
  'atlas.demo.coupon': {
    name: '10% Off Coupon',
    model: `https://${DOMAIN}/assets/badge.glb`,
    thumbnail: `https://${DOMAIN}/assets/badge.png`,
    fungible: false,
    presentation: 'document',
    properties: {
      'atlas.rarity': 'common',
      'com.example.discount': '10% off your next order',
      'com.example.issuedFor': 'business demo'
    }
  },
  // Equippable looks: no model/thumbnail (an outfit isn't a held or
  // displayed object, just a recolor of the shared character model — see
  // extension/wallet.js's avatarLookPropertiesFromAsset() and
  // extension/gltf-mini.js's drawCharacterAt()). shirtColor/pantsColor are
  // under atlas.*, not com.example.*, because a client actually has to
  // understand these two specific keys to render anything from them — the
  // same "small shared vocabulary worth standardizing" reasoning SPEC.md
  // already gives atlas.rarity/atlas.purity, applied to a pair whose whole
  // point is being interpreted rather than just displayed.
  // Every atlas.avatar.* class below is tradeScope: 'bound' — an equip-slot
  // item is meant to be worn by whoever looted it, not split off into a
  // giftable/tradeable/droppable balance the way an ordinary collectible
  // is, same reasoning atlas.membership/atlas.badge above already apply to
  // a relationship or a one-per-visitor giveaway.
  'atlas.avatar.outfit.forest': {
    name: 'Forest Ranger Outfit',
    fungible: false,
    presentation: 'collectible',
    tradeScope: 'bound',
    properties: {
      'atlas.avatar.shirtColor': '#2f5d3a',
      'atlas.avatar.pantsColor': '#3b2a1e'
    }
  },
  'atlas.avatar.outfit.dusk': {
    name: 'Dusk Wanderer Outfit',
    fungible: false,
    presentation: 'collectible',
    tradeScope: 'bound',
    properties: {
      'atlas.avatar.shirtColor': '#4a3b6b',
      'atlas.avatar.pantsColor': '#22243a'
    }
  },
  // Same reasoning as the outfits above (no model/thumbnail, atlas.* rather
  // than com.example.*), but a separate equip slot rather than another
  // outfit property: a hat sits on its own new geometry piece in
  // buildCharacter() rather than recoloring the torso/legs, and wallet.js
  // keeps it in its own storage key so a hat and an outfit can be equipped
  // at the same time.
  // atlas.avatar.hatSpeedMultiplier/hatJumpMultiplier scale the wearer's own
  // walk/run speed and jump height, stacking with whatever shoes are ALSO
  // equipped (a hat and shoes are separate slots — see gltf-mini.js);
  // atlas.avatar.hatInteractRangeMultiplier widens how far away the wearer
  // can trigger a crate/mining node's "E — <label>" prompt or pick up a
  // dropped item. All three are randomized per mint (see randomHatProperties
  // near RING_RARITY_TIERS above reserveSupply) rather than fixed per class
  // like a shoe's own buffs are — the properties below are only the
  // FALLBACK GET /atlas/asset/class's pre-mint preview shows, same
  // "properties below play no part in an actual mint's outcome" reasoning
  // atlas.wearable.ring's own comment gives.
  'atlas.avatar.hat.sunhat': {
    name: 'Explorer Sun Hat',
    fungible: false,
    presentation: 'collectible',
    tradeScope: 'bound',
    properties: {
      'atlas.avatar.hatColor': '#d9a441',
      'atlas.avatar.hatSpeedMultiplier': 1.15,
      'atlas.avatar.hatJumpMultiplier': 1.15,
      'atlas.avatar.hatInteractRangeMultiplier': 1.25
    },
    randomizeProperties: randomHatProperties
  },
  'atlas.avatar.hat.cap': {
    name: 'Night Watch Cap',
    fungible: false,
    presentation: 'collectible',
    tradeScope: 'bound',
    properties: {
      'atlas.avatar.hatColor': '#26282c',
      'atlas.avatar.hatSpeedMultiplier': 1.15,
      'atlas.avatar.hatJumpMultiplier': 1.15,
      'atlas.avatar.hatInteractRangeMultiplier': 1.25
    },
    randomizeProperties: randomHatProperties
  },
  // Same reasoning as the hats above (no model/thumbnail, atlas.*, own
  // equip slot rather than a property on an existing one): shoes are a
  // third independent slot in buildCharacter()'s geometry, alongside the
  // outfit's torso/leg recolor and the hat, so all three can be worn at
  // once without any of them touching the others.
  // atlas.avatar.shoeSpeedMultiplier/shoeJumpMultiplier scale the wearer's
  // own walk/run speed and jump height (a 3D scene reads these directly off
  // whatever shoes are equipped — see gltf-mini.js); atlas.avatar.shoeVisualScale
  // scales the rendered height of the shoe geometry itself. All three are
  // optional and default to no change (1) when absent, same as any other
  // atlas.* property.
  'atlas.avatar.shoes.boots': {
    name: 'Trailblazer Boots',
    fungible: false,
    presentation: 'collectible',
    tradeScope: 'bound',
    properties: {
      'atlas.avatar.shoeColor': '#4a3222',
      'atlas.avatar.shoeSpeedMultiplier': 1.1,
      'atlas.avatar.shoeJumpMultiplier': 1.1,
      'atlas.avatar.shoeVisualScale': 0.5
    }
  },
  'atlas.avatar.shoes.sneakers': {
    name: 'Court Sneakers',
    fungible: false,
    presentation: 'collectible',
    tradeScope: 'bound',
    properties: {
      'atlas.avatar.shoeColor': '#e8e4dc',
      'atlas.avatar.shoeSpeedMultiplier': 1.2,
      'atlas.avatar.shoeJumpMultiplier': 1.2,
      'atlas.avatar.shoeVisualScale': 0.5
    }
  }
};

// Task #204 — the other 115 periodic-table elements (everything except
// the hand-authored iron/gold/silver above), convert-only, no mining
// stall. See issuer-server/elements-catalog.js's own header comment for
// the full rationale; keep this merge as the ONE place that file's
// entries enter ASSET_CATALOG, so GET /atlas/trade/catalog, /atlas/convert,
// and /atlas/asset/issue's holdingCap check all see them automatically
// with no per-endpoint changes needed.
Object.assign(ASSET_CATALOG, require('./elements-catalog')(DOMAIN));

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

// Gates an admin-only action the same way any other signed action in this
// spec is checked (verifyEnvelope above, §6.2), with one extra condition:
// the signing key also has to appear on ADMIN_KEYS_FILE's roster, not just
// be internally consistent. Returns an error string when the request
// should be rejected, or null when it's authorized — callers just need to
// check truthiness, same shape checkPresentedAsset's own callers already
// use for their per-field validation.
async function requireAdmin(payload, proof) {
  if (!payload || !proof) return 'payload and proof are required';
  const sigOk = await verifyEnvelope(payload, proof);
  if (!sigOk) return 'admin signature does not check out';
  if (!isAdminKey(proof.publicKey)) return 'this key is not a registered domain admin';
  return null;
}

// Random, single-use, short-lived challenge a roster key signs over to
// start a session (ADMIN_SESSIONS_FILE below) — without it, a captured
// login request could just be replayed forever. Pruning expired entries
// happens lazily on read/write here rather than on a timer, same "one
// file, filter on read" convention PENDING_TRADES_FILE/WORLD_DROPS_FILE
// already use.
function readAdminNonces() {
  if (!fs.existsSync(ADMIN_NONCES_FILE)) return { nonces: [] };
  return JSON.parse(fs.readFileSync(ADMIN_NONCES_FILE, 'utf8'));
}
function writeAdminNonces(doc) {
  fs.writeFileSync(ADMIN_NONCES_FILE, JSON.stringify(doc, null, 2));
}
function issueAdminNonce() {
  const now = Date.now();
  const doc = readAdminNonces();
  doc.nonces = doc.nonces.filter((n) => n.expiresAt > now);
  const nonce = b64url(webcrypto.getRandomValues(new Uint8Array(24)));
  doc.nonces.push({ nonce, expiresAt: now + ADMIN_NONCE_TTL_MS });
  writeAdminNonces(doc);
  return nonce;
}
// Single-use: a nonce is deleted the moment it's successfully consumed, so
// the exact same login request can never be replayed even within its own
// TTL window. A failed attempt (bad signature, key not on the roster)
// deliberately does NOT burn the nonce — there's nothing to gain from
// invalidating it early, and it means a genuine admin whose first attempt
// glitched isn't forced to fetch a fresh one.
function consumeAdminNonce(nonce) {
  const now = Date.now();
  const doc = readAdminNonces();
  const idx = doc.nonces.findIndex((n) => n.nonce === nonce && n.expiresAt > now);
  if (idx === -1) { doc.nonces = doc.nonces.filter((n) => n.expiresAt > now); writeAdminNonces(doc); return false; }
  doc.nonces.splice(idx, 1);
  doc.nonces = doc.nonces.filter((n) => n.expiresAt > now);
  writeAdminNonces(doc);
  return true;
}

function readAdminSessions() {
  if (!fs.existsSync(ADMIN_SESSIONS_FILE)) return { sessions: [] };
  return JSON.parse(fs.readFileSync(ADMIN_SESSIONS_FILE, 'utf8'));
}
function writeAdminSessions(doc) {
  fs.writeFileSync(ADMIN_SESSIONS_FILE, JSON.stringify(doc, null, 2));
}
function createAdminSession(publicKey) {
  const now = Date.now();
  const doc = readAdminSessions();
  doc.sessions = doc.sessions.filter((s) => s.expiresAt > now);
  const token = b64url(webcrypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + ADMIN_SESSION_TTL_MS;
  doc.sessions.push({ token, publicKey, expiresAt });
  writeAdminSessions(doc);
  return { token, expiresAt };
}
// Constant-time compare so a session token can't be singled out any faster
// by timing how quickly a near-miss fails — the token is 32 random bytes,
// so this only really matters at "many attempts against many stored
// sessions" scale, but it costs nothing to do properly.
function tokensEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
// Validates a session token and slides its expiry forward on every
// successful check — an admin actively using the page never gets logged
// out mid-session, but an abandoned tab's token still dies on its own.
// Returns the session's public key, or null if the token doesn't match any
// live session.
function touchAdminSession(token) {
  const now = Date.now();
  const doc = readAdminSessions();
  const session = typeof token === 'string' ? doc.sessions.find((s) => s.expiresAt > now && tokensEqual(s.token, token)) : null;
  doc.sessions = doc.sessions.filter((s) => s.expiresAt > now);
  if (!session) { writeAdminSessions(doc); return null; }
  session.expiresAt = now + ADMIN_SESSION_TTL_MS;
  writeAdminSessions(doc);
  return session.publicKey;
}
// Logout is idempotent and looks the same whether or not the token was
// ever valid — nothing here should let a caller distinguish "wrong token"
// from "already logged out."
function deleteAdminSession(token) {
  const now = Date.now();
  const doc = readAdminSessions();
  doc.sessions = doc.sessions.filter((s) => s.expiresAt > now && !(typeof token === 'string' && tokensEqual(s.token, token)));
  writeAdminSessions(doc);
}

// The authorization check every admin-gated route below actually uses:
// EITHER a fresh signed proof envelope (requireAdmin above) OR an active
// session token (touchAdminSession) — the session layer's whole reason to
// exist, so a page holding a token can act as admin without the visitor's
// ECDSA key needing to be reachable for every click. A token, when given,
// takes priority and is checked on its own; payload/proof are only
// consulted when no token was sent, so a request never needs to carry
// both. Using a valid token here also slides its expiry forward, same as
// /whoami — any authenticated action counts as activity, not just an
// explicit status check. Returns { error } when the request should be
// rejected, or { publicKey } when it's authorized.
async function requireAdminAuth(payload, proof, token) {
  if (typeof token === 'string' && token) {
    const publicKey = touchAdminSession(token);
    if (!publicKey) return { error: 'session is missing, unknown, or expired' };
    return { publicKey };
  }
  const error = await requireAdmin(payload, proof);
  if (error) return { error };
  return { publicKey: proof.publicKey };
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

// Shown to a wallet in place of a message's real subject once its body has
// been encrypted (see encryptMailBodyToKey below) — extension/wallet.js
// uses this exact same literal for its own placeholder, though nothing
// programmatic ever compares the two strings; keeping them identical is
// just so the same words show up on both ends of this feature.
const MAIL_ENCRYPTED_SUBJECT_PLACEHOLDER = 'Encrypted message';

// Encrypts a domain-to-subscriber mail body to a registered recipient key
// (see /atlas/mail/register-key) — ECIES-style, a fresh ephemeral ECDH
// keypair generated per message, not the mutual per-pair negotiation
// extension/wallet.js's own Chat/Mail Compose E2EE uses for two visitors
// who've never met. That mechanism exists to keep a relaying domain from
// substituting its own key in the middle; there's no equivalent risk here
// — this domain IS the message's own author, already the thing a wallet
// verifies via the outer message signature (verifyMailMessage, client-
// side) before this body is ever looked at, so only the registered
// recipient key needs trusting, and that was already proven once at
// registration time. No persistent encryption identity needed on this end
// at all — a fresh ephemeral keypair per message is the more conventional
// habit anyway (nothing here needs to look the same across two messages).
async function encryptMailBodyToKey(recipientPublicKeyJwk, plaintextObj) {
  const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const recipientKey = await subtle.importKey('jwk', recipientPublicKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedBits = await subtle.deriveBits({ name: 'ECDH', public: recipientKey }, ephemeral.privateKey, 256);
  // Same domain-separation-label-then-hash approach as extension/wallet.js's
  // own deriveEcdhSharedKey, and the SAME label string ('atlas.mail.e2ee.v1')
  // it uses for domain-to-subscriber mail specifically — the two ends have
  // to agree on this or the derived AES key simply won't match.
  const label = new TextEncoder().encode('atlas.mail.e2ee.v1');
  const combined = new Uint8Array(sharedBits.byteLength + label.length);
  combined.set(new Uint8Array(sharedBits), 0);
  combined.set(label, sharedBits.byteLength);
  const digest = await subtle.digest('SHA-256', combined);
  const aesKey = await subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(JSON.stringify(plaintextObj)));
  const ephemeralPublicKeyJwk = await subtle.exportKey('jwk', ephemeral.publicKey);
  return { v: 1, ephemeralPublicKeyJwk, iv: b64url(iv), ciphertext: b64url(new Uint8Array(ciphertext)) };
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

// Task #250 fourth follow-up (Bruno's own request) — per-mint randomized
// enchantments/stats for the Signet Ring, the first catalog class whose
// `properties` are genuinely different on every new mint rather than fixed
// per class. Every OTHER catalog entry's `properties` is a plain static
// object baked in once at server startup; this is a parallel, opt-in
// mechanism (a catalog entry's own `randomizeProperties` function, only
// ever consulted by mintAssetByClass() below) rather than a change to how
// `properties` itself works, so nothing about the other ~120 classes'
// behavior shifts at all.
//
// A weighted rarity roll first (RING_RARITY_TIERS' `weight`s are relative,
// not required to sum to 100 — pickWeightedTier() normalizes against
// whatever they add up to), then a random, duplicate-free sample of
// enchantment names from a fixed pool, each given a random magnitude drawn
// from that tier's own statRange, plus two named numeric stats (luck,
// defense) drawn from the same range — "enchants AND stats" per Bruno's
// own wording, both scaling with the rolled rarity so a legendary ring is
// meaningfully stronger, not just differently labeled.
const RING_RARITY_TIERS = [
  { name: 'common', weight: 50, statRange: [1, 3] },
  { name: 'uncommon', weight: 30, statRange: [3, 6] },
  { name: 'rare', weight: 15, statRange: [6, 10] },
  { name: 'legendary', weight: 5, statRange: [10, 15] }
];
const RING_ENCHANTMENT_POOL = ['fire resistance', 'silent step', 'water breathing', 'quickened reflexes', 'thorns', 'second wind'];

function randomInt(min, max) {
  // Inclusive of both ends — Math.random() is fine here (this is loot-table
  // flavor for a demo, not anything security- or money-sensitive; contrast
  // webcrypto.randomUUID()/getRandomValues() used elsewhere in this file
  // for actual ids and key material).
  return min + Math.floor(Math.random() * (max - min + 1));
}
function pickWeightedTier(tiers) {
  const total = tiers.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * total;
  for (const tier of tiers) {
    if (roll < tier.weight) return tier;
    roll -= tier.weight;
  }
  return tiers[tiers.length - 1]; // floating-point rounding fallback — never actually reachable in practice
}
function sampleWithoutReplacement(pool, count) {
  const remaining = pool.slice();
  const picked = [];
  for (let i = 0; i < count && remaining.length; i++) {
    picked.push(remaining.splice(Math.floor(Math.random() * remaining.length), 1)[0]);
  }
  return picked;
}
// Enchantment count scales with rarity tier (common: 1, uncommon: 2, rare:
// 3, legendary: 4, capped at the pool's own size) — a higher tier is
// visibly more loaded with effects, not just numerically bigger ones.
function randomRingProperties() {
  const tier = pickWeightedTier(RING_RARITY_TIERS);
  const tierIndex = RING_RARITY_TIERS.indexOf(tier);
  const enchantCount = Math.min(tierIndex + 1, RING_ENCHANTMENT_POOL.length);
  const enchantments = sampleWithoutReplacement(RING_ENCHANTMENT_POOL, enchantCount)
    .map((name) => name + ' +' + randomInt(tier.statRange[0], tier.statRange[1]));
  return {
    'atlas.rarity': tier.name,
    'com.example.enchantments': enchantments,
    'com.example.stats': {
      luck: randomInt(tier.statRange[0], tier.statRange[1]),
      defense: randomInt(tier.statRange[0], tier.statRange[1])
    }
  };
}

// Same mechanism as randomRingProperties() above (a catalog entry's own
// randomizeProperties, consulted by mintAssetByClass() for every genuinely
// new mint), one step simpler: no rarity tier, just three independent whole-
// percent bonus rolls so two mints of the same hat class end up with their
// own distinct mix rather than identical stats. Bounds are deliberately
// modest for speed/jump (they stack with whatever shoes are ALSO equipped —
// see gltf-mini.js) and more generous for interact range (pure utility, no
// movement-balance concern).
const HAT_SPEED_BONUS_PERCENT_RANGE = [5, 30];
const HAT_JUMP_BONUS_PERCENT_RANGE = [5, 30];
const HAT_INTERACT_RANGE_BONUS_PERCENT_RANGE = [10, 50];
function randomHatProperties() {
  return {
    'atlas.avatar.hatSpeedMultiplier': 1 + randomInt(...HAT_SPEED_BONUS_PERCENT_RANGE) / 100,
    'atlas.avatar.hatJumpMultiplier': 1 + randomInt(...HAT_JUMP_BONUS_PERCENT_RANGE) / 100,
    'atlas.avatar.hatInteractRangeMultiplier': 1 + randomInt(...HAT_INTERACT_RANGE_BONUS_PERCENT_RANGE) / 100
  };
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

// Registered mail-encryption public keys — see /atlas/mail/register-key
// for how a key gets here and MAIL_ENCRYPTION_KEYS_FILE's own comment for
// why this lives outside .well-known. A flat object keyed by credentialId
// rather than owner public key, matching how mail is already addressed
// (SPEC.md §11.1) — this domain never needs to track "who currently owns
// this credential" for its own sake, only "what key to encrypt to when
// mailing this id," and the id is exactly what a visitor already proves
// holding when they register one (see that endpoint).
function readMailEncryptionKeys() {
  if (!fs.existsSync(MAIL_ENCRYPTION_KEYS_FILE)) return { keys: {} };
  return JSON.parse(fs.readFileSync(MAIL_ENCRYPTION_KEYS_FILE, 'utf8'));
}
function saveMailEncryptionKey(credentialId, publicKeyJwk) {
  const doc = readMailEncryptionKeys();
  doc.keys[credentialId] = publicKeyJwk;
  fs.writeFileSync(MAIL_ENCRYPTION_KEYS_FILE, JSON.stringify(doc, null, 2));
}
function getMailEncryptionKey(credentialId) {
  return readMailEncryptionKeys().keys[credentialId] || null;
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

// Merges `patch` onto `target` (never mutates either): a key set to any
// value but `null` is added/overwritten same as a plain object spread, and
// a key set to `null` is removed from the result entirely rather than
// being kept as a literal null — the standard JSON Merge Patch convention
// (RFC 7386), adopted here so there's finally a way to actually take a
// property away rather than only ever add or overwrite one. Used wherever
// a properties patch is applied to REAL asset data — a class patch onto a
// credential's properties (applyClassPatchIfStale below), and /atlas/
// asset/reissue's own `properties` argument — so `null` means "delete
// this" in both places a patch actually takes effect. No existing
// property here has any legitimate reason to actually BE null, so this
// doesn't take anything away from what could be expressed before.
//
// Deliberately NOT used by setClassPatch()'s own merge of a new call onto
// an already-stored patch, just below: a stored patch has to keep a `null`
// entry as a literal delete MARKER (something to apply to a credential
// later), not have that key erased from the patch the moment it's set —
// erasing it there would silently forget the deletion was ever asked for,
// which is exactly the bug this function's docs above almost shipped with.
function mergeProperties(target, patch) {
  const result = { ...(target || {}) };
  for (const key of Object.keys(patch || {})) {
    if (patch[key] === null) delete result[key];
    else result[key] = patch[key];
  }
  return result;
}

// Class-patch store (see CLASS_PATCHES_FILE's own comment) — keyed by
// asset class, not by item or holder. `patches[cls]` is `{properties?,
// tradeScope?, updatedAt}`; `properties` is itself a patch, merged onto
// whatever a holder's credential already has (same merge-not-replace
// shape /atlas/asset/reissue's own `properties` argument already uses),
// so setting one fact doesn't clobber another set earlier.
function readClassPatches() {
  if (!fs.existsSync(CLASS_PATCHES_FILE)) return { patches: {} };
  return JSON.parse(fs.readFileSync(CLASS_PATCHES_FILE, 'utf8'));
}
function classPatchOf(cls) {
  return readClassPatches().patches[cls] || null;
}
function setClassPatch(cls, { properties, tradeScope }) {
  const doc = readClassPatches();
  const existing = doc.patches[cls] || {};
  // Plain spread, NOT mergeProperties() — a `null` here has to survive
  // into the stored patch as a literal delete marker, not be erased from
  // it right away. mergeProperties() only ever runs where a patch is
  // actually applied to a real credential's properties, further down.
  const nextProperties = properties ? { ...(existing.properties || {}), ...properties } : existing.properties;
  const nextTradeScope = tradeScope !== undefined ? tradeScope : existing.tradeScope;
  const merged = {
    ...(nextProperties ? { properties: nextProperties } : {}),
    ...(nextTradeScope !== undefined ? { tradeScope: nextTradeScope } : {}),
    updatedAt: new Date().toISOString()
  };
  doc.patches[cls] = merged;
  fs.writeFileSync(CLASS_PATCHES_FILE, JSON.stringify(doc, null, 2));
  return merged;
}
function clearClassPatch(cls) {
  const doc = readClassPatches();
  delete doc.patches[cls];
  fs.writeFileSync(CLASS_PATCHES_FILE, JSON.stringify(doc, null, 2));
}
// True if `credential` disagrees with `patch` on any field the patch
// actually sets — the trigger applyClassPatchIfStale() below acts on.
// JSON.stringify comparison rather than `===` since a property's value
// can itself be an object/array (e.g. a stats bag), not just a scalar. A
// `null` entry (mergeProperties' delete marker) is stale exactly when the
// key is still actually present — once it's gone, checking again must
// stop reporting stale, or a deleted property would reissue forever.
function isCredentialStaleAgainstClassPatch(credential, patch) {
  if (patch.tradeScope !== undefined && credential.asset.tradeScope !== patch.tradeScope) return true;
  if (patch.properties) {
    const current = credential.asset.properties || {};
    for (const key of Object.keys(patch.properties)) {
      const patchValue = patch.properties[key];
      if (patchValue === null) {
        if (Object.prototype.hasOwnProperty.call(current, key)) return true;
      } else if (JSON.stringify(current[key]) !== JSON.stringify(patchValue)) {
        return true;
      }
    }
  }
  return false;
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

// Domain admin roster — same "missing file means the empty case" and flat-
// array shape every other roster in this server already uses. An entry's
// own `revoked` flag (not the shared REVOCATIONS_FILE, which is scoped to
// asset/membership credentials, not admin keys) is how an admin key is
// retired without needing a separate mechanism.
function readAdminKeys() {
  if (!fs.existsSync(ADMIN_KEYS_FILE)) return { keys: [] };
  return JSON.parse(fs.readFileSync(ADMIN_KEYS_FILE, 'utf8'));
}
function isAdminKey(publicKey) {
  return readAdminKeys().keys.some((k) => k.publicKey === publicKey && !k.revoked);
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

// World drops (task #250) — same read/append/remove shape as pending
// trades just above, scoped by `world` (a plain string tag the client
// supplies, same as everywhere else "world" already means "whatever id
// this domain's own scene.json/manifest calls it" — this server has no
// independent notion of what worlds exist or what their policy is; that
// stays a client-enforced concern, same split of responsibility
// itemDropsAllowed/acceptedItemClasses/trustedIssuers already have today).
// No expiry/pruning here unlike readPendingTrades() — a dropped item is
// meant to just sit there until picked up or reclaimed, not vanish on a
// timer.
function readWorldDrops() {
  if (!fs.existsSync(WORLD_DROPS_FILE)) return { drops: [] };
  return JSON.parse(fs.readFileSync(WORLD_DROPS_FILE, 'utf8'));
}
function appendWorldDrop(entry) {
  const doc = readWorldDrops();
  doc.drops.push(entry);
  fs.writeFileSync(WORLD_DROPS_FILE, JSON.stringify(doc, null, 2));
}
// Returns the removed entry (or null if it was already gone) so the caller
// can tell "I just won the reservation" from "someone else already claimed
// this" without a second read — the exact race the claim endpoints below
// exist to close.
function removeWorldDrop(dropId) {
  const doc = readWorldDrops();
  const found = doc.drops.find((d) => d.dropId === dropId) || null;
  if (found) {
    doc.drops = doc.drops.filter((d) => d.dropId !== dropId);
    fs.writeFileSync(WORLD_DROPS_FILE, JSON.stringify(doc, null, 2));
  }
  return found;
}

// Domain calendar (SPEC.md §12) — same plain read/append/update/remove
// shape as PENDING_TRADES_FILE/WORLD_DROPS_FILE above. readCalendarEvents
// is the one GET /atlas/calendar actually calls: filtered to one
// worldId (null meaning the domain-wide calendar) and sorted soonest-
// first, the same ordering AtlasWallet.getCalendarEvents() already
// guarantees for a wallet's own local reminders (extension/wallet.js).
function readCalendarStore() {
  if (!fs.existsSync(CALENDAR_FILE)) return { events: [] };
  return JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
}
function readCalendarEvents(worldId) {
  const normalized = worldId || null;
  return readCalendarStore()
    .events.filter((e) => (e.worldId || null) === normalized)
    .sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
}
function addCalendarEvent(entry) {
  const doc = readCalendarStore();
  doc.events.push(entry);
  fs.writeFileSync(CALENDAR_FILE, JSON.stringify(doc, null, 2));
}
// Returns the updated entry (or null if `id` doesn't exist) so the caller
// can tell a genuine 404 from a successful patch without a second read.
function updateCalendarEvent(id, patch) {
  const doc = readCalendarStore();
  const entry = doc.events.find((e) => e.id === id);
  if (!entry) return null;
  Object.assign(entry, patch);
  fs.writeFileSync(CALENDAR_FILE, JSON.stringify(doc, null, 2));
  return entry;
}
// Returns the removed entry (or null if it was already gone), same
// "hand back what you just removed" convention removeWorldDrop uses above.
function removeCalendarEvent(id) {
  const doc = readCalendarStore();
  const found = doc.events.find((e) => e.id === id) || null;
  if (found) {
    doc.events = doc.events.filter((e) => e.id !== id);
    fs.writeFileSync(CALENDAR_FILE, JSON.stringify(doc, null, 2));
  }
  return found;
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
    'Access-Control-Allow-Headers': 'Content-Type',
    // Every response here is either a write's result or a read of state
    // that can change from one request to the next (world drops being the
    // sharpest case: POST a drop, then GET the list back and need to see
    // it right away) — never something safe for a shared cache to reuse.
    // This project's own dev server has no caching layer in front of it,
    // but a real deployed domain behind a CDN/reverse proxy does, and can
    // cache an uncontrolled GET response — see the matching fix + comment
    // in issuer-php/lib/bootstrap.php's send_json() for the actual bug
    // report this traces back to.
    'Cache-Control': 'no-store, no-cache, must-revalidate'
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

// GET/HEAD /atlas-admin, /atlas-admin/, or /atlas-admin/index.html — the
// one-page admin panel bundled with this server (ADMIN_PANEL_DIR above),
// always index.html regardless of which of those three the request named:
// the page is entirely self-contained (inline CSS/JS, no sub-resources),
// so there's no second file any request here could ever legitimately want.
// content.js links to the explicit /atlas-admin/index.html rather than the
// bare directory — a real site often runs its own catch-all rewrite (a
// CMS's "anything not a real file goes to my own router" rule, say) that
// can 404 a bare directory request before Apache's own directory-index
// resolution gets a turn, even though the same rewrite leaves an actual
// file alone — but the bare paths still work here too, matching what
// PHP's static /atlas-admin/index.html file already does unconditionally.
// Matched before serveStatic's ATLAS_DOCROOT fallback so a domain's own
// docroot content can never shadow it.
function serveAdminPanel(req, res) {
  const filePath = path.join(ADMIN_PANEL_DIR, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(data.length),
      'Access-Control-Allow-Origin': '*'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
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

  // Task #250 fourth follow-up — transfers a NON-fungible credential to a
  // new owner while preserving its exact per-instance asset state (serial,
  // editionSize, a Signet Ring's randomly-rolled enchantments/stats, or any
  // other instance-specific property) rather than rebuilding `asset` fresh
  // from ASSET_CATALOG the way mintAssetByClass() does. Rebuilding fresh is
  // CORRECT for a fungible re-mint (split/consolidate/trade) — SPEC.md
  // §5.1 requires every balance of a fungible class to carry identical
  // properties, so re-deriving from the catalog is exactly the point — but
  // it was silently wrong for a unique item changing hands, discarding
  // whatever made that specific instance unique and replacing it with the
  // class's static fallback. Used by fulfillWorldDropClaim() below (fixing
  // that latent bug — a serialized item like the ring was nominally
  // droppable in the plaza's own acceptedItemClasses before this, so this
  // was a live gap, not just theoretical) and by the Trading Station
  // settlement's own unique-item side (see POST /atlas/trade/claim).
  async function transferUniqueAsset(newOwnerPublicKey, credential) {
    return issueAsset(newOwnerPublicKey, credential.asset, credential.quantity, credential.id);
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

  // Auto-applies a class-wide patch (POST /atlas/admin/class-patch, see
  // CLASS_PATCHES_FILE's own comment) to ONE specific holder's credential
  // the moment they check in with it (/atlas/mail/check below), instead of
  // requiring the operator to already know who holds one. This domain
  // keeps no registry of who holds what — re-verifying the credential the
  // wallet itself just presented is the ONLY way to know it's real before
  // minting a replacement for its owner, the same trust posture every
  // other endpoint here already uses for a presented credential.
  // Non-fungible only, same reasoning /atlas/asset/reissue already gives:
  // a fungible class's properties/tradeScope are already uniform across
  // every balance (mintAssetByClass rebuilds them fresh from ASSET_CATALOG
  // on every mint/split/consolidate/trade), so there's nothing for a class
  // patch to override there. Returns the same {id, status, reason,
  // newCredential} shape a manual reissue already produces (or null if
  // nothing needed to change), so /atlas/mail/check can hand it back
  // through the exact `updates` array wallet.js's processAssetUpdates
  // already knows how to adopt — no wallet-side change needed at all.
  async function applyClassPatchIfStale(credential) {
    if (!credential || credential.credential !== 'domain-atlas-asset/1.0') return null;
    if (!credential.asset || credential.asset.fungible !== false) return null;
    if (!credential.issuer || credential.issuer.domain !== DOMAIN) return null;
    const patch = classPatchOf(credential.asset.class);
    if (!patch || !isCredentialStaleAgainstClassPatch(credential, patch)) return null;
    if (isRevoked(credential.id)) return null; // already handled by /atlas/mail/check's own revocation check — defensive only
    const sigOk = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
    if (!sigOk) return null; // never act on anything that isn't genuinely this domain's own signed credential

    const newAsset = {
      ...credential.asset,
      ...(patch.tradeScope !== undefined ? { tradeScope: patch.tradeScope } : {}),
      ...(patch.properties ? { properties: mergeProperties(credential.asset.properties, patch.properties) } : {})
    };
    const newCredential = await issueAsset(credential.owner.publicKey, newAsset, credential.quantity, credential.id);
    revoke(credential.id, 'class-patch');
    const update = { id: credential.id, status: 'superseded', reason: 'class-patch', newCredential };
    appendAssetUpdate(update);
    console.log('Auto-reissued (class patch)', credential.asset.name, credential.id, '->', newCredential.id);
    return update;
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

    // Task #250 fourth follow-up: a catalog entry's own `randomizeProperties`
    // (see atlas.wearable.ring above, and its comment near RING_RARITY_TIERS
    // for the full reasoning) gets one chance to override the class's static
    // `properties`, same "genuinely new supply only" gate as the serial/cap
    // reservation just above — a reissue's own explicit `properties` patch
    // (handled entirely by the /atlas/asset/reissue route, not here) is a
    // completely separate mechanism and must never get re-rolled by this.
    const baseProperties = catalogEntry.properties || {};
    const randomizedProperties = supersedes === null && typeof catalogEntry.randomizeProperties === 'function'
      ? catalogEntry.randomizeProperties()
      : null;
    const properties = {
      ...baseProperties,
      ...(randomizedProperties || {}),
      ...(catalogEntry.serialized ? { 'atlas.serial': String(serial), 'atlas.editionSize': String(catalogEntry.maxSupply) } : {})
    };

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
    // Task #250 fourth follow-up: "or trade" dropped from this message — a
    // non-fungible asset CAN now be traded at the Trading Station, just not
    // through THIS check (see checkPresentedUniqueAsset below, used by
    // /atlas/trade/submit and /atlas/trade/claim instead whenever the
    // presented balance's own fungible flag says false).
    if (credential.asset.fungible !== true) return 'asset class is not fungible — cannot split or consolidate a unique asset';
    if (typeof credential.quantity !== 'number' || credential.quantity < minQuantity) return 'asset has insufficient quantity';
    if (isRevoked(credential.id)) return 'asset already revoked';
    const ok = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
    if (!ok) return 'asset signature does not check out';
    return null;
  }

  // Task #250 fourth follow-up (Bruno's own request) — checkPresentedAsset's
  // mirror for the OTHER half of SPEC.md §5.1's fungible/non-fungible
  // split: same ownership/class/tradeScope/revocation/signature checks,
  // but requires fungible === false instead of true, and there is no
  // minQuantity to check at all — a non-fungible credential's quantity is
  // definitionally 1 (SPEC.md §5.1), so presenting the right CREDENTIAL
  // (verified as this signer's own, this class, not bound, not revoked,
  // genuinely signed by this issuer) is the entire check. Lets a unique
  // item like the Signet Ring be offered/claimed at the Trading Station —
  // see /atlas/trade/submit and /atlas/trade/claim below, and
  // transferUniqueAsset() for how the actual instance (not a fresh
  // catalog-derived stand-in) is what changes hands on settlement.
  async function checkPresentedUniqueAsset(credential, expectedOwner, expectedClass) {
    if (!credential || credential.credential !== 'domain-atlas-asset/1.0') return 'not an asset credential';
    if (!credential.owner || credential.owner.publicKey !== expectedOwner) return 'asset does not belong to this signer';
    if (!credential.asset || credential.asset.class !== expectedClass) return 'asset is the wrong class';
    if (credential.asset.tradeScope === 'bound') return 'asset is bound to its owner and cannot be traded';
    if (credential.asset.fungible !== false) return 'asset class is fungible — present it as a quantity balance, not a unique item';
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

  // Task #250 — dropping is the FIRST case in this file where a server has
  // to validate a credential it did NOT itself issue: a wearable minted by
  // domain A, carried into and dropped in domain B's plaza, is fully
  // supported (SPEC.md §5.5), and domain B obviously doesn't hold domain
  // A's private key to check it the fast, local way. Mirrors exactly what
  // extension/wallet.js's own verifyCredential() already does client-side
  // for any credential from a domain other than "self": fetch THAT
  // domain's own published key + revocation ledger (never trust
  // credential.issuer.publicKey blindly — it isn't part of the signed
  // payload, see assetPayloadOf() below, so nothing stops someone from
  // stamping a fake issuer.publicKey onto an otherwise-unrelated
  // signature), confirm a key matching it was valid at credential.issuedAt,
  // verify the signature against THAT key, then check THAT domain's own
  // revocation list — never this server's own isRevoked(), which only
  // knows about ids this server itself minted and could never have heard
  // of a foreign one being revoked.
  async function verifyForeignAssetCredential(credential) {
    try {
      const base = baseUrl(credential.issuer.domain);
      const [keyRes, revRes] = await Promise.all([
        fetch(base + '/.well-known/atlas-key.json', { cache: 'no-store' }),
        fetch(base + '/.well-known/atlas-revocations.json', { cache: 'no-store' })
      ]);
      if (!keyRes.ok) return false;
      const keyDoc = await keyRes.json();
      const revDoc = revRes.ok ? await revRes.json() : { revoked: [] };
      const issuedAt = new Date(credential.issuedAt).getTime();
      const activeKey = (keyDoc.keys || []).find((k) => {
        const from = new Date(k.validFrom).getTime();
        const until = k.validUntil ? new Date(k.validUntil).getTime() : Infinity;
        return k.publicKey === credential.issuer.publicKey && issuedAt >= from && issuedAt <= until;
      });
      if (!activeKey) return false;
      const sigOk = await verifyDomainSignature(activeKey.publicKey, assetPayloadOf(credential), credential.signature);
      if (!sigOk) return false;
      if ((revDoc.revoked || []).some((r) => r.id === credential.id)) return false;
      return true;
    } catch (err) {
      return false;
    }
  }

  // Task #250 (World Drops, SPEC.md §5.5): a THIRD sibling of
  // checkPresentedAsset/checkPresentedMembership above, for the one case
  // neither fits — presenting a credential to DROP it, which unlike
  // split/consolidate/trade is equally valid for a fungible stack or a
  // one-of-one wearable (checkPresentedAsset's fungible-must-be-true and
  // minQuantity checks would wrongly reject the latter), and unlike a
  // membership presentation, still has to exclude 'bound' assets — a
  // subscription card is exactly the kind of thing that must NOT become
  // droppable-and-takeable by a stranger. No quantity check at all: the
  // client is responsible for calling POST /atlas/asset/split first if it
  // wants to drop less than a fungible stack's full amount (see wallet.js's
  // dropItem), by the time a credential reaches this check, whatever
  // quantity it carries is the whole of what's being dropped. Also unlike
  // checkPresentedAsset/checkPresentedMembership (which only ever run
  // against credentials THIS domain itself issued, since split/consolidate/
  // trade/membership can only ever apply to a domain's own credentials):
  // branches on credential.issuer.domain, since a drop's credential may
  // well have come from somewhere else entirely — see
  // verifyForeignAssetCredential() just above.
  async function checkPresentedTransferableAsset(credential, expectedOwner, expectedClass) {
    if (!credential || credential.credential !== 'domain-atlas-asset/1.0') return 'not an asset credential';
    if (!credential.owner || credential.owner.publicKey !== expectedOwner) return 'asset does not belong to this signer';
    if (!credential.asset || credential.asset.class !== expectedClass) return 'asset is the wrong class';
    if (credential.asset.tradeScope === 'bound') return 'asset is bound to its owner and cannot be dropped for someone else to take';
    if (!credential.issuer || !credential.issuer.domain) return 'asset has no issuer domain';
    if (credential.issuer.domain === DOMAIN) {
      if (isRevoked(credential.id)) return 'asset already revoked';
      const ok = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
      if (!ok) return 'asset signature does not check out';
      return null;
    }
    const foreignOk = await verifyForeignAssetCredential(credential);
    if (!foreignOk) return 'could not verify this asset against its issuer (' + credential.issuer.domain + ')';
    return null;
  }

  // A fourth sibling of checkPresentedUniqueAsset/checkPresentedMembership/
  // checkPresentedTransferableAsset above, for POST /atlas/asset/transfer
  // below: a direct, one-sided send to a named recipient, with no listing,
  // no location, and no matching counter-offer required — unlike a Trading
  // Station trade (needs a mirrored intent) or a World Drop (needs a world
  // to sit in and a claimant to walk up), this is just "I hold it, send it
  // to this exact public key." Non-fungible only for now, same restriction
  // checkPresentedUniqueAsset already applies, and only ever checked
  // against THIS domain's own credentials (unlike checkPresentedTransferableAsset,
  // there is no foreign-domain branch here — nothing stops that from being
  // added later the same way World Drops' relay-claim already shows how).
  // Same checks as checkPresentedUniqueAsset, just worded for "send" rather
  // than "trade" so a rejected demo visitor gets the right verb back.
  async function checkPresentedGiftableAsset(credential, expectedOwner, expectedClass) {
    if (!credential || credential.credential !== 'domain-atlas-asset/1.0') return 'not an asset credential';
    if (!credential.owner || credential.owner.publicKey !== expectedOwner) return 'asset does not belong to this signer';
    if (!credential.asset || credential.asset.class !== expectedClass) return 'asset is the wrong class';
    if (credential.asset.tradeScope === 'bound') return 'asset is bound to its owner and cannot be sent to anyone else';
    if (credential.asset.fungible !== false) return 'asset class is fungible — this endpoint only transfers a unique item';
    if (isRevoked(credential.id)) return 'asset already revoked';
    const ok = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
    if (!ok) return 'asset signature does not check out';
    return null;
  }

  // checkPresentedGiftableAsset's own sibling for POST /atlas/asset/redeem
  // below, deliberately looser in one respect: a bound credential can't be
  // GIVEN to anyone else, but its own holder giving it up entirely is a
  // different act — voiding your own membership card or badge needs no
  // recipient and creates no question of who receives it, so tradeScope is
  // never checked here. Fungible is still excluded, same "non-fungible only
  // for now" scope every other single-credential action in this file
  // shares — redeeming part of a balance would need a quantity argument
  // this endpoint doesn't take.
  async function checkPresentedRedeemableAsset(credential, expectedOwner, expectedClass) {
    if (!credential || credential.credential !== 'domain-atlas-asset/1.0') return 'not an asset credential';
    if (!credential.owner || credential.owner.publicKey !== expectedOwner) return 'asset does not belong to this signer';
    if (!credential.asset || credential.asset.class !== expectedClass) return 'asset is the wrong class';
    if (credential.asset.fungible !== false) return 'asset class is fungible — this endpoint only redeems a unique item';
    if (isRevoked(credential.id)) return 'asset already revoked';
    const ok = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
    if (!ok) return 'asset signature does not check out';
    return null;
  }

  // Task #250 — the actual custody change once a claim is legitimate,
  // shared by both branches of POST /atlas/world/drops/claim: the local
  // same-domain path (this domain issued the dropped credential itself)
  // and POST /atlas/world/drops/relay-claim (a different domain issued it,
  // and THIS call only happens on that domain's own server, reached via
  // the relay below). Same revoke-old/mint-new-owner primitive every other
  // real transfer in this file already uses (trade settlement, split,
  // consolidate) — a dropped item was never "in limbo" ownership-wise
  // while it sat in the world, so claiming it is exactly as much a fresh
  // mint as any of those, just to a owner nobody negotiated with directly.
  //
  // Fungible drops still go through mintAssetByClass — re-deriving from
  // the catalog is correct there (every balance of a fungible class is
  // identical by definition). A non-fungible drop instead goes through
  // transferUniqueAsset() (task #250 fourth follow-up) so its actual
  // per-instance state survives the claim — see that function's own
  // comment for the bug this fixes.
  async function fulfillWorldDropClaim(credential, claimantPublicKey) {
    const received = credential.asset.fungible === false
      ? await transferUniqueAsset(claimantPublicKey, credential)
      : await mintAssetByClass(claimantPublicKey, credential.asset.class, credential.quantity, credential.id);
    revoke(credential.id, 'claimed from a world drop');
    return received;
  }

  // Task #203: sums an owner's VERIFIED current holdings of one class, off
  // whatever balance credentials the wallet chose to present alongside a
  // mint request — used only by the `holdingCap` check in POST
  // /atlas/asset/issue below. Deliberately forgiving of anything that
  // fails validation (wrong owner, wrong class, already revoked, bad
  // signature) rather than rejecting the whole mint over it: an unverified
  // presented credential just doesn't count towards the total, the same
  // "only what checks out counts" posture as everywhere else, and a wallet
  // presenting nothing at all is trusted as genuinely holding zero — there
  // is no credential a fresh wallet with none yet COULD present to prove a
  // negative, so treating "nothing presented" as "0 held" is the only
  // reading that doesn't lock a brand-new wallet out of ever mining a
  // capped class at all. A wallet that owns some and simply doesn't
  // mention it is undercounted, never overcounted — this cap is a
  // cooperative-client convenience for the reference wallet, not an
  // adversarial-abuse defense (nothing here protects value that could be
  // taken from someone ELSE, only how much a wallet can mint for itself).
  async function currentHeldQuantity(ownerPublicKey, cls, presentedBalances) {
    let total = 0;
    for (const cred of (Array.isArray(presentedBalances) ? presentedBalances : [])) {
      const problem = await checkPresentedAsset(cred, ownerPublicKey, cls, 1);
      if (!problem) total += cred.quantity;
    }
    return total;
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
        const { ownerPublicKey, assetClass, quantity, existingBalances } = JSON.parse((await readBody(req)) || '{}');
        if (!ownerPublicKey) return sendJson(res, 400, { error: 'ownerPublicKey is required' });
        const catalogEntry = ASSET_CATALOG[assetClass];
        if (!catalogEntry) {
          // Task #204: this list used to enumerate every known class by
          // name, which was fine at ~10 classes but stopped being useful
          // once the periodic-table expansion pushed the catalog past 125
          // — pointing at the actual catalog is more useful than a wall of
          // names anyway. GET /atlas/trade/catalog only lists the
          // tradable subset (fungible, non-bound), not every class (e.g.
          // atlas.membership is intentionally excluded there), so this
          // also names ASSET_CATALOG directly for the full picture.
          return sendJson(res, 400, { error: 'Unknown assetClass. See GET /atlas/trade/catalog for tradable classes, or ASSET_CATALOG in issuer-server/server.js (plus issuer-server/elements-catalog.js) for the full list.' });
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

        // Task #203: a fresh mint of a class carrying `holdingCap`
        // (ASSET_CATALOG — today, every one of the three freely-mineable
        // fungible elements) is refused once the requesting owner already
        // holds that much or more, verified against whatever balance
        // credentials the wallet presents alongside the request
        // (currentHeldQuantity above), not merely trusted from the
        // request. This applies uniformly to every path that reaches this
        // one shared endpoint — a market mining stall AND a chess-win gold
        // reward alike — since the point is capping how much of a class
        // can be freely CREATED, not gating one specific UI button. It
        // does NOT apply to mintAssetByClass's other call sites
        // (split/consolidate/convert/trade re-mints all pass a non-null
        // `supersedes`) — receiving a large balance through a legitimate
        // transfer of EXISTING value was never the thing worth capping.
        if (catalogEntry.fungible && typeof catalogEntry.holdingCap === 'number') {
          const currentHeld = await currentHeldQuantity(ownerPublicKey, assetClass, existingBalances);
          if (currentHeld >= catalogEntry.holdingCap) {
            return sendJson(res, 400, {
              error: `already holding ${currentHeld} ${catalogEntry.name} (cap: ${catalogEntry.holdingCap}) — convert some to another element (POST /atlas/convert) or spend it before mining more`
            });
          }
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

      // --- Admin session (short-lived bearer token layered on the roster
      // above — see ADMIN_NONCES_FILE/ADMIN_SESSIONS_FILE's own comment for
      // why) ---
      //
      // GET /atlas/admin/session/nonce — ungated. Handing out a nonce to
      // anyone who asks is harmless: it's worthless without a roster key's
      // signature over it, same "the endpoint's existence isn't the
      // secret" posture every other write endpoint here already has before
      // requireAdmin runs.
      if (req.method === 'GET' && req.url === '/atlas/admin/session/nonce') {
        return sendJson(res, 200, { nonce: issueAdminNonce() });
      }

      // POST /atlas/admin/session/start — {payload: {nonce}, proof}, the
      // same envelope every other admin action here uses, just signing a
      // fresh nonce instead of an action. Trades one real signature for a
      // session token good for ADMIN_SESSION_TTL_MS (slides forward on
      // each /whoami check — see touchAdminSession).
      if (req.method === 'POST' && req.url === '/atlas/admin/session/start') {
        const { payload: loginPayload, proof } = JSON.parse((await readBody(req)) || '{}');
        const authError = await requireAdmin(loginPayload, proof);
        if (authError) return sendJson(res, 401, { error: authError });
        if (typeof loginPayload.nonce !== 'string' || !consumeAdminNonce(loginPayload.nonce)) {
          return sendJson(res, 401, { error: 'nonce is missing, unknown, already used, or expired' });
        }
        const { token, expiresAt } = createAdminSession(proof.publicKey);
        return sendJson(res, 200, { token, expiresAt });
      }

      // POST /atlas/admin/session/whoami — {token}, no signature. The
      // bearer token itself IS the credential once a session exists —
      // that's the whole point of not re-signing every request.
      if (req.method === 'POST' && req.url === '/atlas/admin/session/whoami') {
        const { token } = JSON.parse((await readBody(req)) || '{}');
        const publicKey = touchAdminSession(token);
        if (!publicKey) return sendJson(res, 401, { error: 'session is missing, unknown, or expired' });
        return sendJson(res, 200, { publicKey });
      }

      // POST /atlas/admin/session/logout — {token}. Always 200 regardless
      // of whether the token was ever valid, deliberately — see
      // deleteAdminSession's own comment on why.
      if (req.method === 'POST' && req.url === '/atlas/admin/session/logout') {
        const { token } = JSON.parse((await readBody(req)) || '{}');
        if (typeof token === 'string') deleteAdminSession(token);
        return sendJson(res, 200, { status: 'logged out' });
      }

      // GET /atlas/admin/is-admin?publicKey=... — ungated, boolean-only.
      // Lets a wallet decide whether to show its own "Admin" entry point
      // for the identity it currently has active, without a full sign-a-
      // nonce round trip just to render a button. Confirms membership of
      // ONE presented key rather than exposing the roster itself (which
      // stays unreachable directly — see ADMIN_KEYS_FILE's own comment) —
      // no worse an information leak than every other "is this specific
      // key/id valid" check already on this server (mail check, trade
      // catalog lookups, and so on).
      if (req.method === 'GET' && req.url.split('?')[0] === '/atlas/admin/is-admin') {
        const publicKey = new URLSearchParams(req.url.split('?')[1] || '').get('publicKey');
        return sendJson(res, 200, { isAdmin: !!publicKey && isAdminKey(publicKey) });
      }

      // POST /atlas/admin/directory — admin-gated (requireAdminAuth, same
      // as every other admin action). SUBSCRIBERS_FILE's own comment
      // above already anticipated this exact use ("so the operator can
      // ... message everyone by hand later ... worth real operator
      // authentication before ever exposing this over HTTP") — a session
      // token is that authentication. Hands back both rosters this domain
      // keeps (atlas.membership subscribers and Global Mail/Post Office
      // members — two different credential classes, kept as separate
      // lists rather than merged so the admin panel can label them), each
      // filtered to currently-unrevoked credentials only: a revoked
      // credential id is exactly the kind of dead-end address the mail
      // form's own recipient warning (see /atlas/mail/send above) exists
      // to catch, so there's no reason to offer one as a suggestion here.
      if (req.method === 'POST' && req.url === '/atlas/admin/directory') {
        const { payload, proof, token } = JSON.parse((await readBody(req)) || '{}');
        const auth = await requireAdminAuth(payload, proof, token);
        if (auth.error) return sendJson(res, 401, { error: auth.error });
        const subscribers = readSubscribers().subscribers.filter((s) => !isRevoked(s.credentialId));
        const postOfficeMembers = readPostOfficeMembers().members.filter((m) => !isRevoked(m.credentialId));
        return sendJson(res, 200, { subscribers, postOfficeMembers });
      }

      // §5.1.1 reissue — a domain-initiated replacement for an asset it
      // already issued, carrying updated `asset` state (properties, most
      // often, and now optionally tradeScope — see below). Non-fungible
      // only (SPEC.md §5.1.1): a fungible class's properties/tradeScope
      // have to stay identical across every balance of it for §5.4.1's
      // consolidation to stay sound, so a fungible credential's asset state
      // only ever changes at the class level (ASSET_CATALOG), never by
      // reissuing one specific balance. This is deliberately NOT a generic
      // "any domain can reissue any asset" endpoint either: it only
      // accepts a credential this issuer's own key actually signed
      // (verifyOwnCredentialSignature below), the same restriction that
      // already applies to honoring a presented balance for a split.
      // `properties` here is a patch merged over the existing
      // asset.properties bag, not a full replacement — convenient for the
      // common case (one fact changed) without forcing every caller to
      // resend properties it isn't touching. A key set to `null` is
      // removed from the result entirely rather than kept as a literal
      // null (mergeProperties above) — the only way to actually take a
      // fact away, since there was previously no way to do that at all.
      //
      // `tradeScope` patches the credential's OTHER per-instance flag:
      // since tradeScope is baked into a credential's signed payload at
      // mint time (mintAssetByClass's `catalogEntry.tradeScope || 'local'`),
      // tightening a class's catalog entry to `tradeScope: 'bound'` does
      // NOT retroactively change any credential of that class minted
      // before the catalog entry said so; the old credential's own
      // signature would break if its tradeScope were edited in place, so
      // the only honest fix is the same revoke-and-re-mint this endpoint
      // already does for `properties`. A domain operator who finds
      // themselves holding (or supporting a visitor who holds) a stale
      // pre-tightening credential can call this endpoint once to bring it
      // in line with today's catalog — see README.md's "Fixing a stale
      // tradeScope on an already-issued credential" section.
      //
      // Admin-gated (requireAdminAuth, above): rewriting an already-issued
      // credential's properties or tradeScope is exactly the kind of
      // action SPEC.md §10 puts on the domain's own side, never a
      // visitor's — left open, anyone who could observe a credential
      // (many are publicly visible via trade listings or gifts) could
      // silently alter its properties or loosen/tighten its tradeScope
      // without the owner's consent, under this domain's own real
      // signature. Wire shape is {payload: {credential, properties,
      // tradeScope}, proof} or {payload, token}, the same envelope every
      // other admin action here uses.
      if (req.method === 'POST' && req.url === '/atlas/asset/reissue') {
        const { payload: reissuePayload, proof, token } = JSON.parse((await readBody(req)) || '{}');
        const auth = await requireAdminAuth(reissuePayload, proof, token);
        if (auth.error) return sendJson(res, 401, { error: auth.error });
        const { credential, properties, tradeScope } = reissuePayload;
        if (!credential || credential.credential !== 'domain-atlas-asset/1.0') {
          return sendJson(res, 400, { error: 'payload.credential must be a domain-atlas-asset/1.0 credential' });
        }
        const hasProperties = properties !== undefined;
        const hasTradeScope = tradeScope !== undefined;
        if (!hasProperties && !hasTradeScope) {
          return sendJson(res, 400, { error: 'at least one of properties (a patch onto asset.properties) or tradeScope is required' });
        }
        if (hasProperties && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
          return sendJson(res, 400, { error: 'properties, when given, must be a patch object onto asset.properties' });
        }
        if (hasTradeScope && tradeScope !== 'local' && tradeScope !== 'bound') {
          return sendJson(res, 400, { error: "tradeScope, when given, must be 'local' or 'bound'" });
        }
        if (!credential.issuer || credential.issuer.domain !== DOMAIN) {
          return sendJson(res, 400, { error: 'credential was not issued by this domain' });
        }
        if (!credential.asset || credential.asset.fungible !== false) {
          return sendJson(res, 400, { error: "reissue only applies to a non-fungible asset — a fungible class's properties/tradeScope are fixed per class (SPEC.md §5.1), not per credential" });
        }
        if (isRevoked(credential.id)) return sendJson(res, 400, { error: 'credential is already revoked' });
        const sigOk = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
        if (!sigOk) return sendJson(res, 400, { error: 'credential signature does not check out against this issuer\'s key' });

        const newAsset = {
          ...credential.asset,
          ...(hasTradeScope ? { tradeScope } : {}),
          ...(hasProperties ? { properties: mergeProperties(credential.asset.properties, properties) } : {})
        };
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

      // Admin-gated (requireAdminAuth, same as every other admin action):
      // the bulk alternative to the single-credential reissue just above —
      // sets (or clears) a fact for an entire non-fungible CLASS at once,
      // rather than the operator reissuing every current holder's
      // credential by hand. This never touches an already-issued
      // credential directly: it only records the patch (CLASS_PATCHES_FILE
      // — one entry per class ever touched, never one per item or holder),
      // and each holder's own wallet picks it up automatically the next
      // time it checks in with this domain (see applyClassPatchIfStale()
      // and /atlas/mail/check's own comment) — the same mail check-in
      // cycle that already delivers ordinary mail and revocations. `clear`
      // removes a class's patch entirely rather than setting one; nothing
      // already-applied to a holder is undone by that (there's nothing to
      // undo it FROM without reissuing again), it just stops correcting
      // future check-ins against that class. Same non-fungible-only
      // restriction /atlas/asset/reissue gives above: a fungible class's
      // properties/tradeScope are already uniform across every balance
      // (mintAssetByClass rebuilds them fresh from ASSET_CATALOG on every
      // mint/split/consolidate/trade), so there's nothing a class patch
      // could override there that isn't already true everywhere.
      // `properties` here goes through mergeProperties() the same as
      // /atlas/asset/reissue's own argument — a key set to `null` removes
      // that fact from every credential this patch touches, rather than
      // leaving it stuck at a literal null, and (since setClassPatch()
      // itself merges a new call onto whatever patch is already stored)
      // removes that key's own earlier override from the stored patch too.
      if (req.method === 'POST' && req.url === '/atlas/admin/class-patch') {
        const { payload, proof, token } = JSON.parse((await readBody(req)) || '{}');
        const auth = await requireAdminAuth(payload, proof, token);
        if (auth.error) return sendJson(res, 401, { error: auth.error });
        const { assetClass, properties, tradeScope, clear } = payload || {};
        const catalogEntry = ASSET_CATALOG[assetClass];
        if (!catalogEntry) return sendJson(res, 400, { error: 'Unknown assetClass. See GET /atlas/trade/catalog for tradable classes, or ASSET_CATALOG in issuer-server/server.js for the full list.' });
        if (catalogEntry.fungible) {
          return sendJson(res, 400, { error: "class patches only apply to a non-fungible class — a fungible class's properties/tradeScope are already uniform across every balance (SPEC.md §5.1)" });
        }
        if (clear) {
          clearClassPatch(assetClass);
          console.log('Cleared class patch for', assetClass);
          return sendJson(res, 200, { assetClass, patch: null });
        }
        const hasProperties = properties !== undefined;
        const hasTradeScope = tradeScope !== undefined;
        if (!hasProperties && !hasTradeScope) {
          return sendJson(res, 400, { error: 'at least one of properties (a patch onto asset.properties), tradeScope, or clear is required' });
        }
        if (hasProperties && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
          return sendJson(res, 400, { error: 'properties, when given, must be a patch object onto asset.properties' });
        }
        if (hasTradeScope && tradeScope !== 'local' && tradeScope !== 'bound') {
          return sendJson(res, 400, { error: "tradeScope, when given, must be 'local' or 'bound'" });
        }
        const patch = setClassPatch(assetClass, { properties, tradeScope });
        console.log('Set class patch for', assetClass, '->', JSON.stringify(patch));
        return sendJson(res, 200, { assetClass, patch });
      }

      // Admin-gated (requireAdminAuth, same as every other admin action):
      // every class an operator has ever patched (never one per item or
      // holder — see CLASS_PATCHES_FILE's own comment), so the admin panel
      // can show what's currently active and let the operator edit or
      // clear one instead of guessing from memory what's already set.
      if (req.method === 'POST' && req.url === '/atlas/admin/class-patches') {
        const { payload, proof, token } = JSON.parse((await readBody(req)) || '{}');
        const auth = await requireAdminAuth(payload, proof, token);
        if (auth.error) return sendJson(res, 401, { error: auth.error });
        return sendJson(res, 200, { patches: readClassPatches().patches });
      }

      // Admin-gated (requireAdminAuth, above), for the class-patch form's
      // own dropdown: every non-fungible class in ASSET_CATALOG, bound or
      // not. GET /atlas/trade/catalog deliberately excludes a bound class
      // (it can never be the THING traded — see its own comment above), but
      // a bound class is still a perfectly valid class-patch target — a
      // badge or membership card can carry a wrong fact same as anything
      // else — so this can't just reuse that public list. Gating it behind
      // admin auth (rather than adding a second public endpoint) is what
      // makes exposing bound classes here fine: nothing here reveals who
      // holds one, only the same static catalog config /atlas/trade/catalog
      // already publishes for the non-bound subset.
      if (req.method === 'POST' && req.url === '/atlas/admin/asset-classes') {
        const { payload, proof, token } = JSON.parse((await readBody(req)) || '{}');
        const auth = await requireAdminAuth(payload, proof, token);
        if (auth.error) return sendJson(res, 401, { error: auth.error });
        // `properties`/`randomized` (new) let the class-patch form pre-fill
        // itself instead of asking the operator to type a patch blind: the
        // catalog's own base `properties` are exactly what an untouched
        // credential of this class actually has (merged with any already-
        // active class patch client-side, since that's the accurate "what
        // holders see right now" picture once one exists). `randomized`
        // flags a class whose actual per-instance values are rolled at mint
        // time (randomizeProperties, e.g. the Signet Ring/hats) — for those,
        // the catalog's `properties` are only ever the shared fallback
        // template, never any specific holder's real roll, so the panel
        // shows a caveat rather than implying this is what everyone has.
        const classes = Object.keys(ASSET_CATALOG)
          .filter((cls) => ASSET_CATALOG[cls].fungible === false)
          .map((cls) => ({
            class: cls,
            name: ASSET_CATALOG[cls].name,
            tradeScope: ASSET_CATALOG[cls].tradeScope || 'local',
            properties: ASSET_CATALOG[cls].properties || {},
            randomized: !!ASSET_CATALOG[cls].randomizeProperties
          }));
        return sendJson(res, 200, { classes });
      }

      // Admin-gated (requireAdminAuth, above): revoking an arbitrary
      // credential by id is the single most consequential thing this
      // server can do on an operator's behalf, so it's the first endpoint
      // retrofitted onto the domain admin roster rather than continuing to
      // trust whoever can reach this process. Wire shape is
      // {payload: {id, reason}, proof} — the same signed-payload envelope
      // §7's trade intents and Post Office sends already use — instead of
      // a bare, unauthenticated body; a session `token` (see the admin
      // session endpoints) works in place of proof, for a page that's
      // already logged in rather than signing every click fresh.
      if (req.method === 'POST' && req.url === '/atlas/revoke') {
        const { payload, proof, token } = JSON.parse((await readBody(req)) || '{}');
        if (!payload || !payload.id) return sendJson(res, 400, { error: 'payload.id is required' });
        const auth = await requireAdminAuth(payload, proof, token);
        if (auth.error) return sendJson(res, 401, { error: auth.error });
        revoke(payload.id, payload.reason || 'issuer-request');
        console.log('Revoked', payload.id, 'by admin', auth.publicKey.slice(0, 16) + '...');
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

      // Task #203 (SPEC.md §7's new "Currency conversion" paragraph) —
      // convert one presented fungible balance into another fungible class,
      // via each class's own `exchangeRate` (ASSET_CATALOG, catalog-only
      // config — see that comment for the full reasoning). Deliberately
      // shaped like /atlas/asset/split just above rather than anything in
      // the trading-station section below: there's no counterparty, no
      // listing, no async delivery — the domain itself is always the other
      // side, so this settles synchronously in one call the same way a
      // split does, just minting a DIFFERENT class as the result instead of
      // more of the same one. `toPublicKey` is never a parameter here —
      // conversion always stays with the same owner who presented the
      // balance, unlike split's optional gift-to-someone-else shape.
      //
      // The rate always routes through the shared base-currency unit
      // regardless of which two classes are named (SOURCE/goldRate ->
      // gold-equivalent -> TARGET/goldRate), so any two rated classes
      // convert directly — iron -> silver works exactly the same way
      // gold -> silver does, not just base-currency pairs.
      if (req.method === 'POST' && req.url === '/atlas/convert') {
        const { credential, spendAmount, toClass } = JSON.parse((await readBody(req)) || '{}');
        if (!credential || !toClass || !Number.isInteger(spendAmount) || spendAmount <= 0) {
          return sendJson(res, 400, { error: 'credential, spendAmount, and toClass are required' });
        }
        const expectedOwner = credential.owner && credential.owner.publicKey;
        const fromClass = credential.asset && credential.asset.class;
        const problem = await checkPresentedAsset(credential, expectedOwner, fromClass, spendAmount);
        if (problem) return sendJson(res, 400, { error: problem });

        if (toClass === fromClass) return sendJson(res, 400, { error: 'cannot convert a class into itself' });
        const toEntry = ASSET_CATALOG[toClass];
        if (!toEntry || toEntry.fungible !== true || (toEntry.tradeScope || 'local') === 'bound') {
          return sendJson(res, 400, { error: 'toClass must be a known, fungible, non-bound assetClass' });
        }
        const fromRate = ASSET_CATALOG[fromClass].exchangeRate;
        const toRate = toEntry.exchangeRate;
        if (typeof fromRate !== 'number' || typeof toRate !== 'number') {
          return sendJson(res, 400, { error: 'one or both classes are not eligible for conversion (no exchangeRate set)' });
        }

        // valueInBaseCurrency = how many units of the domain's base
        // currency spendAmount of fromClass is worth; resultQuantity =
        // that same value expressed in toClass units. Floors rather than
        // rejects a non-exact rate — same "round down, don't fail" choice
        // as any other integer-quantity math in this protocol — but a
        // spend too small to produce even 1 unit of toClass is rejected
        // outright rather than silently minting nothing.
        const valueInBaseCurrency = spendAmount / fromRate;
        const resultQuantity = Math.floor(valueInBaseCurrency * toRate);
        if (resultQuantity < 1) {
          return sendJson(res, 400, {
            error: `converting ${spendAmount} ${fromClass} into ${toClass} at this domain's rate rounds down to 0 — convert a larger amount`
          });
        }

        const remainderQty = credential.quantity - spendAmount;
        const [received, remainder] = await Promise.all([
          mintAssetByClass(expectedOwner, toClass, resultQuantity, credential.id),
          remainderQty > 0 ? mintAssetByClass(expectedOwner, fromClass, remainderQty, credential.id) : Promise.resolve(null)
        ]);
        revoke(credential.id, 'superseded');
        console.log('Converted', spendAmount, fromClass, '->', resultQuantity, toClass, 'for', expectedOwner.slice(0, 16) + '...');
        return sendJson(res, 200, { received, remainder });
      }

      // Task #213 — asset-class lookup, for previewing a class the caller
      // does not (yet) hold a credential of at all: a scene's hoverable
      // stall/crate (demo-domain-a/spatial/lobby/scene.json's
      // `interactables`, keyed by `class`) names a class but carries none
      // of ASSET_CATALOG's own name/thumbnail/model/properties — those only
      // travel today inside an actual minted credential. GET
      // /atlas/trade/catalog already establishes that an issuer may
      // voluntarily publish more about its OWN classes than SPEC.md §5.1's
      // "no central catalog" floor requires (a class is a namespace, not an
      // approval-gated registry — see that endpoint's own comment above)
      // — but it's deliberately narrow: fungible-only, tradeScope-filtered,
      // no model/properties at all, since all it ever had to answer was
      // "what can I ask this Trading Station for". This endpoint answers a
      // different question — "what IS this class, whether or not I can
      // trade for it, whether or not I've ever held one" — so it covers
      // every class in the catalog (fungible or not, any tradeScope) and
      // returns the full display shape: model and properties included, the
      // same fields mintAssetByClass signs onto a real credential's `asset`
      // (asset.serial/asset.editionSize aside — those are per-INSTANCE, not
      // per-class, so a pre-mint preview has nothing to show there).
      //
      // Ungated, same "read is open" reasoning as /atlas/trade/catalog and
      // /atlas/trade/listings: nothing here is secret — anyone who walks up
      // to the lobby crate and opens it would see all of this anyway, on
      // their own freshly-minted credential, one action later. Query-string
      // shaped (?class=...) rather than a path segment, matching this
      // codebase's existing convention of putting every parameter in a
      // JSON body or a query string, never in the URL path itself.
      if (req.method === 'GET' && req.url.split('?')[0] === '/atlas/asset/class') {
        const cls = new URLSearchParams(req.url.split('?')[1] || '').get('class');
        if (!cls) return sendJson(res, 400, { error: 'class query parameter is required' });
        const entry = ASSET_CATALOG[cls];
        if (!entry) return sendJson(res, 404, { error: 'unknown assetClass' });
        return sendJson(res, 200, {
          class: cls,
          name: entry.name,
          thumbnail: entry.thumbnail || null,
          model: entry.model || null,
          fungible: entry.fungible,
          presentation: entry.presentation,
          tradeScope: entry.tradeScope || 'local',
          ...(entry.properties && Object.keys(entry.properties).length ? { properties: entry.properties } : {})
        });
      }

      // Direct, one-sided transfer: send a held non-fungible credential
      // straight to a named recipient's public key, no listing posted, no
      // matching counter-offer, no world to drop it in first — the
      // simplest possible "give this to someone else" primitive this
      // protocol offers, sitting alongside the heavier Trading Station
      // (§7, needs a matched intent) and World Drops (§5.5, needs a world
      // and a claimant to walk up) mechanisms without replacing either.
      // Authorized the same way every other signed action here is: a small
      // envelope over exactly the fields it authorizes, checked with
      // verifyEnvelope, same shape /atlas/trade/submit and
      // /atlas/world/drop already use for theirs.
      if (req.method === 'POST' && req.url === '/atlas/asset/transfer') {
        const { credential, recipientPublicKey, intent } = JSON.parse((await readBody(req)) || '{}');
        if (!credential || !recipientPublicKey || !intent) return sendJson(res, 400, { error: 'credential, recipientPublicKey, and intent are all required' });
        if (!intent.payload || !intent.proof) return sendJson(res, 400, { error: 'intent must carry payload and proof' });
        if (intent.payload.credentialId !== credential.id || intent.payload.recipientPublicKey !== recipientPublicKey || intent.payload.action !== 'transfer') {
          return sendJson(res, 400, { error: 'intent does not authorize transferring this credential to this recipient' });
        }

        const envelopeOk = await verifyEnvelope(intent.payload, intent.proof);
        if (!envelopeOk) return sendJson(res, 400, { error: 'intent signature does not check out' });
        const senderPub = intent.proof.publicKey;

        if (recipientPublicKey === senderPub) return sendJson(res, 400, { error: 'cannot transfer a credential to yourself' });

        const problem = await checkPresentedGiftableAsset(credential, senderPub, credential.asset && credential.asset.class);
        if (problem) return sendJson(res, 400, { error: problem });

        const received = await transferUniqueAsset(recipientPublicKey, credential);
        revoke(credential.id, 'transferred');
        console.log('Transferred', credential.asset.class, credential.id, '->', recipientPublicKey.slice(0, 16) + '...');
        return sendJson(res, 200, { status: 'transferred', credential: received });
      }

      // POST /atlas/asset/redeem — a holder giving up their own credential,
      // no recipient involved at all: the plainest possible revocation
      // request, authorized by nothing but the holder's own signature over
      // exactly that intent. Same envelope shape as transfer above, minus
      // the recipient field; same underlying revoke() primitive every other
      // revocation path in this file already calls, just reached through a
      // new authorization route rather than the admin gate. Works on a
      // bound credential too (see checkPresentedRedeemableAsset) — voiding
      // your own membership card needs no recipient to reason about.
      if (req.method === 'POST' && req.url === '/atlas/asset/redeem') {
        const { credential, intent } = JSON.parse((await readBody(req)) || '{}');
        if (!credential || !intent) return sendJson(res, 400, { error: 'credential and intent are both required' });
        if (!intent.payload || !intent.proof) return sendJson(res, 400, { error: 'intent must carry payload and proof' });
        if (intent.payload.credentialId !== credential.id || intent.payload.action !== 'redeem') {
          return sendJson(res, 400, { error: 'intent does not authorize redeeming this credential' });
        }

        const envelopeOk = await verifyEnvelope(intent.payload, intent.proof);
        if (!envelopeOk) return sendJson(res, 400, { error: 'intent signature does not check out' });
        const holderPub = intent.proof.publicKey;

        const problem = await checkPresentedRedeemableAsset(credential, holderPub, credential.asset && credential.asset.class);
        if (problem) return sendJson(res, 400, { error: problem });

        revoke(credential.id, 'issuer-request');
        console.log('Redeemed', credential.asset.class, credential.id, 'for', holderPub.slice(0, 16) + '...');
        return sendJson(res, 200, { status: 'redeemed', id: credential.id });
      }

      // --- §7 trading stations (this server plays the station role — see file header) ---
      // Originally fungible-only: offer/want named a class and a quantity,
      // which is exactly what a fungible balance is and exactly what a
      // fungible:false asset isn't (there's no quantity to negotiate on a
      // one-of-a-kind thing) — checkPresentedAsset enforced this the same
      // way it does for split/consolidate above.
      //
      // Task #250 fourth follow-up (Bruno's own request) widened this: a
      // unique, non-fungible item (the Signet Ring, atlas.wearable.ring) can
      // now also be offered and claimed here. The intent shape didn't need
      // to grow a new field for it — a side is still just {class, quantity},
      // and for a non-fungible class quantity is simply always 1 (its
      // credential's own quantity is definitionally 1 anyway, SPEC.md §5.1)
      // — validateTradeSideShape() below enforces that. What DID need to
      // change: which check function runs against a presented `balance`
      // (checkPresentedAsset for fungible === true, checkPresentedUniqueAsset
      // for fungible === false — decided by the presented credential's own
      // signed fungible flag, not a class lookup), and how settlement mints
      // the received side — a unique item is transferred via
      // transferUniqueAsset() (the ACTUAL instance changing hands, serial/
      // enchantments and all), never re-derived fresh via mintAssetByClass()
      // the way a fungible spend correctly is. See checkPresentedUniqueAsset
      // and transferUniqueAsset's own comments above for the full reasoning.
      //
      // Validates a trade intent's one side ({class, quantity}) shape:
      // class must be a known string, quantity a positive integer, and —
      // the actual new-this-follow-up rule — a class ASSET_CATALOG marks
      // fungible: false must be offered/wanted in quantity exactly 1, since
      // there is no partial share of a unique item to negotiate. Applied to
      // both offer and want in /atlas/trade/submit, and to the claimant's
      // own offer/want in /atlas/trade/claim.
      function validateTradeSideShape(side, label) {
        if (!side || typeof side.class !== 'string' || !side.class) return label + ': class is required';
        if (typeof side.quantity !== 'number' || !Number.isInteger(side.quantity) || side.quantity < 1) return label + ': quantity must be a positive integer';
        const catalogEntry = ASSET_CATALOG[side.class];
        if (catalogEntry && catalogEntry.fungible === false && side.quantity !== 1) {
          return label + ': ' + side.class + ' is not fungible — quantity must be 1';
        }
        return null;
      }

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
        const shapeProblem = validateTradeSideShape(offerSelf, 'offer') || validateTradeSideShape(wantSelf, 'want');
        if (shapeProblem) return sendJson(res, 400, { error: shapeProblem });

        // Task #250 fourth follow-up: which check runs is decided by the
        // presented balance's OWN signed fungible flag, not a class lookup
        // — self-describing, same posture this protocol already takes
        // everywhere else (never re-derive from a live catalog when the
        // signed credential already states it).
        const offerIsUnique = !!(balance && balance.asset && balance.asset.fungible === false);
        const balanceProblem = offerIsUnique
          ? await checkPresentedUniqueAsset(balance, selfPub, offerSelf.class)
          : await checkPresentedAsset(balance, selfPub, offerSelf.class, offerSelf.quantity);
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

      // Task #202 (SPEC.md §7) — catalog discovery: what CAN a wallet ask
      // this domain's Trading Station for in the "You want" side of a trade,
      // without already having one in hand? Before this, the wallet's Sell
      // UI hardcoded the three fungible classes this specific demo happens
      // to define (see viewer.js's refreshTradingSellOfferOptions comment) —
      // fine for one domain, but useless for any other domain running this
      // same code with its own catalog. Deliberately ungated, same "read is
      // open" reasoning as /atlas/trade/listings just above: a catalog entry
      // is already public the moment /atlas/asset/issue exists to hand it
      // out, so listing the classes reveals nothing new.
      //
      // Originally filtered to fungible===true (the only kind a quantity-
      // based trade intent's offer/want shape supported at the time — see
      // SPEC.md §5.4) and tradeScope!=='bound' (a membership card can never
      // be the THING traded, same exclusion checkPresentedAsset already
      // enforces at claim time — see its own tradeScope==='bound' check
      // below). Defaults tradeScope the same way mintAssetByClass does
      // (`|| 'local'`) so an entry that never bothered to set the flag is
      // treated the same at discovery time as it is at mint time.
      //
      // Task #250 fourth follow-up (Bruno's own request): the fungible===
      // true restriction is gone — a unique, non-fungible class (the
      // Signet Ring) can now be offered/claimed too (see
      // checkPresentedUniqueAsset/transferUniqueAsset above), so it belongs
      // in this discovery list the same as any other non-bound class. The
      // response's own `fungible` field (new) is what a client uses to
      // decide whether to render a quantity input or "exactly one" for a
      // given class — tradeScope!=='bound' remains the only exclusion.
      //
      // This same shape is designed to extend to a FOREIGN domain's catalog
      // later (fetched live while composing a trade, per the wallet UX idea
      // discussed for cross-domain trading) — see the private design notes
      // for what changes and what doesn't when that day comes.
      if (req.method === 'GET' && req.url === '/atlas/trade/catalog') {
        const classes = Object.keys(ASSET_CATALOG)
          .filter((cls) => (ASSET_CATALOG[cls].tradeScope || 'local') !== 'bound')
          .map((cls) => ({
            class: cls,
            name: ASSET_CATALOG[cls].name,
            thumbnail: ASSET_CATALOG[cls].thumbnail || null,
            fungible: ASSET_CATALOG[cls].fungible,
            tradeScope: ASSET_CATALOG[cls].tradeScope || 'local',
            // Task #203 — surfaced here (rather than a separate rates
            // endpoint) so the same fetch that already drives the Sell
            // tab's "You want" dropdown also drives Convert's live rate
            // preview. `exchangeRate` is only present when the class is
            // actually eligible for conversion (see POST /atlas/convert);
            // `isBaseCurrency` is a display hint only, never checked by
            // the conversion math itself. Neither ever applies to a
            // non-fungible class — /atlas/convert is fungible-only and
            // always will be, there is no "exchange rate" for a unique item.
            ...(typeof ASSET_CATALOG[cls].exchangeRate === 'number' ? { exchangeRate: ASSET_CATALOG[cls].exchangeRate } : {}),
            ...(ASSET_CATALOG[cls].isBaseCurrency ? { isBaseCurrency: true } : {})
          }));
        return sendJson(res, 200, { domain: DOMAIN, classes });
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

        const claimantShapeProblem = validateTradeSideShape(offerB, 'offer') || validateTradeSideShape(wantB, 'want');
        if (claimantShapeProblem) return sendJson(res, 400, { error: claimantShapeProblem });

        // Mirror check — the claimant's offer/want must exactly match what
        // this listing wants/offers, same shape §7's own Match step uses.
        // Unchanged by task #250 fourth follow-up's unique-item support: a
        // non-fungible side's quantity is always exactly 1 on both ends
        // (validateTradeSideShape enforces this at submit time already), so
        // this plain equality check keeps working without needing to know
        // or care which side is fungible.
        if (offerB.class !== wantA.class || offerB.quantity !== wantA.quantity ||
            wantB.class !== offerA.class || wantB.quantity !== offerA.quantity) {
          return sendJson(res, 400, { error: 'your intent does not mirror this listing\'s offer/want' });
        }

        // Task #250 fourth follow-up: which check runs for each side is
        // decided by that side's own presented balance's signed fungible
        // flag — see /atlas/trade/submit's own comment on this same choice.
        const offerBIsUnique = !!(balanceB && balanceB.asset && balanceB.asset.fungible === false);
        const claimantBalanceProblem = offerBIsUnique
          ? await checkPresentedUniqueAsset(balanceB, claimantPub, offerB.class)
          : await checkPresentedAsset(balanceB, claimantPub, offerB.class, offerB.quantity);
        if (claimantBalanceProblem) return sendJson(res, 400, { error: 'balance: ' + claimantBalanceProblem });

        // Re-checks the poster's own balance fresh (not just trusted from
        // when it was posted) in case it was since spent or revoked some
        // other way.
        const offerAIsUnique = !!(balanceA && balanceA.asset && balanceA.asset.fungible === false);
        const posterBalanceProblem = offerAIsUnique
          ? await checkPresentedUniqueAsset(balanceA, posterPub, offerA.class)
          : await checkPresentedAsset(balanceA, posterPub, offerA.class, offerA.quantity);
        if (posterBalanceProblem) {
          removePendingTrade(posted.id); // no longer honorable — drop it rather than leave a dead listing others keep trying to claim
          return sendJson(res, 400, { error: 'the poster\'s balance no longer checks out (' + posterBalanceProblem + ') — listing withdrawn' });
        }

        // A unique side never has a remainder (its balance's quantity is
        // definitionally 1, exactly what's being offered — SPEC.md §5.1)
        // and is TRANSFERRED rather than re-minted from the catalog, so its
        // actual instance state (serial, a Signet Ring's randomly-rolled
        // enchantments/stats) survives settlement — see
        // transferUniqueAsset()'s own comment for the bug this avoids
        // repeating. A fungible side keeps the original spend/remainder
        // behavior unchanged.
        const remainderA = offerAIsUnique ? 0 : balanceA.quantity - offerA.quantity;
        const remainderB = offerBIsUnique ? 0 : balanceB.quantity - offerB.quantity;
        const [aRemainder, aReceived, bRemainder, bReceived] = await Promise.all([
          remainderA > 0 ? mintAssetByClass(posterPub, offerA.class, remainderA, balanceA.id) : Promise.resolve(null),
          offerBIsUnique ? transferUniqueAsset(posterPub, balanceB) : mintAssetByClass(posterPub, wantA.class, wantA.quantity, balanceA.id),
          remainderB > 0 ? mintAssetByClass(claimantPub, offerB.class, remainderB, balanceB.id) : Promise.resolve(null),
          offerAIsUnique ? transferUniqueAsset(claimantPub, balanceA) : mintAssetByClass(claimantPub, wantB.class, wantB.quantity, balanceB.id)
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

      // --- World Drops (task #250, SPEC.md §5.5): "others can see it and
      // pick it up" — the shared half of dropping an item that self-only
      // dropping (wallet.js's dropItem/getDroppedItemsInWorld) explicitly
      // punted on. A world is inherently this domain's own concern (same
      // as its scene.json), so this domain hosts the drop for VISIBILITY
      // and CLAIM-RESERVATION no matter which domain actually issued the
      // item — but only the item's own issuer can legitimately re-sign it
      // to a new owner, so a claim on a cross-domain item is relayed to
      // that issuer via /atlas/world/drops/relay-claim below, the exact
      // same "sign an attestation, let the home domain verify it against
      // my own published key" trust model /atlas/postoffice/relay already
      // uses for federated mail (SPEC.md §11.4) — this is the second use
      // of that same primitive, not a new one.
      //
      // Proof-of-identity shape throughout (`intent.payload`/`intent.proof`)
      // deliberately mirrors /atlas/trade/submit and /claim: a small signed
      // envelope over just enough to authorize the one action it accompanies
      // and nothing else, verified with the same verifyEnvelope() used
      // everywhere else in this file.
      if (req.method === 'POST' && req.url === '/atlas/world/drop') {
        const { credential, world, position, intent } = JSON.parse((await readBody(req)) || '{}');
        if (!credential || !world || !position || !intent) return sendJson(res, 400, { error: 'credential, world, position, and intent are all required' });
        if (!intent.payload || !intent.proof) return sendJson(res, 400, { error: 'intent must carry payload and proof' });
        if (intent.payload.credentialId !== credential.id || intent.payload.world !== world || intent.payload.action !== 'drop') {
          return sendJson(res, 400, { error: 'intent does not authorize dropping this credential into this world' });
        }

        const envelopeOk = await verifyEnvelope(intent.payload, intent.proof);
        if (!envelopeOk) return sendJson(res, 400, { error: 'intent signature does not check out' });

        const dropperPub = intent.proof.publicKey;
        const problem = await checkPresentedTransferableAsset(credential, dropperPub, credential.asset && credential.asset.class);
        if (problem) return sendJson(res, 400, { error: problem });

        const dropId = 'urn:atlas:worlddrop:' + webcrypto.randomUUID();
        appendWorldDrop({ dropId, world, position, credential, droppedBy: dropperPub, droppedAt: new Date().toISOString() });
        console.log('Dropped in', world + ':', credential.quantity, credential.asset.class, '(issued by', credential.issuer.domain + ')');
        return sendJson(res, 200, { status: 'dropped', dropId });
      }

      // Deliberately ungated, same "read is open" reasoning as
      // /atlas/trade/listings — a drop is already visible to anyone
      // physically standing in the world (that's the whole point), so
      // letting anyone ask this domain "what's on the ground in world W"
      // reveals nothing the dropper didn't already choose to make visible
      // by dropping it there.
      if (req.method === 'GET' && req.url.split('?')[0] === '/atlas/world/drops') {
        const world = new URLSearchParams(req.url.split('?')[1] || '').get('world');
        if (!world) return sendJson(res, 400, { error: 'world is required' });
        const drops = readWorldDrops().drops.filter((d) => d.world === world);
        return sendJson(res, 200, { domain: DOMAIN, world, drops });
      }

      // Claim (pick up) one specific drop by id. Reservation happens by
      // REMOVING the entry before doing anything else — same "the file
      // write is the lock" reasoning as removePendingTrade at trade-claim
      // time (single-threaded Node here; issuer-php's mirror flock()s the
      // equivalent file for the same reason its trade store already does).
      // Whichever concurrent claim call's removeWorldDrop() actually finds
      // and deletes the entry wins; a losing concurrent call gets a plain
      // "gone" 404, the same experience as reaching for something someone
      // else already picked up a half-second earlier.
      if (req.method === 'POST' && req.url === '/atlas/world/drops/claim') {
        const { dropId, intent } = JSON.parse((await readBody(req)) || '{}');
        if (!dropId || !intent) return sendJson(res, 400, { error: 'dropId and intent are both required' });
        if (!intent.payload || !intent.proof) return sendJson(res, 400, { error: 'intent must carry payload and proof' });
        if (intent.payload.dropId !== dropId || intent.payload.action !== 'claim') return sendJson(res, 400, { error: 'intent does not authorize claiming this drop' });

        const envelopeOk = await verifyEnvelope(intent.payload, intent.proof);
        if (!envelopeOk) return sendJson(res, 400, { error: 'intent signature does not check out' });
        const claimantPub = intent.proof.publicKey;

        const won = removeWorldDrop(dropId);
        if (!won) return sendJson(res, 404, { error: 'that item is gone — already picked up, or reclaimed by whoever dropped it' });

        const { credential, world } = won;
        if (credential.issuer.domain === DOMAIN) {
          // Same domain issued it and hosts the drop — no relay needed,
          // straight to the shared mint/revoke primitive.
          const received = await fulfillWorldDropClaim(credential, claimantPub);
          console.log('World drop claimed locally:', credential.quantity, credential.asset.class, '->', claimantPub.slice(0, 16) + '...');
          return sendJson(res, 200, { status: 'claimed', credential: received });
        }

        // Cross-domain: this server can host the listing but cannot
        // legally re-sign someone else's credential — relay to whoever
        // actually issued it, the same attestation-and-verify shape
        // /atlas/postoffice/send already uses to reach a different home
        // domain (SPEC.md §11.4 step 3), just naming a drop instead of a
        // mail envelope.
        const attestation = { relayingDomain: DOMAIN, world, dropId, credentialId: credential.id, claimantPublicKey: claimantPub };
        const attestationSignature = await sign(attestation);
        let relayRes;
        try {
          relayRes = await fetch(baseUrl(credential.issuer.domain) + '/atlas/world/drops/relay-claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential, attestation, attestationSignature })
          });
        } catch (err) {
          // The reservation above already removed the listing — this is
          // the same acknowledged gap trade/claim's own multi-mint
          // Promise.all has (no cross-call rollback in this demo); a
          // network failure here can strand the item rather than restore
          // the listing. Documented, not hidden.
          return sendJson(res, 502, { error: 'could not reach ' + credential.issuer.domain + ' to complete this claim: ' + err.message });
        }
        const relayBody = await relayRes.json().catch(() => ({}));
        if (!relayRes.ok) {
          return sendJson(res, relayRes.status, { error: credential.issuer.domain + ' rejected this claim: ' + (relayBody.error || 'unknown reason') });
        }
        console.log('World drop claimed via relay to', credential.issuer.domain + ':', credential.quantity, credential.asset.class, '->', claimantPub.slice(0, 16) + '...');
        return sendJson(res, 200, relayBody);
      }

      // The far end of the relay above: THIS domain is being told by
      // ANOTHER domain (the one currently hosting the drop in one of its
      // worlds) that a credential this domain itself issued has just been
      // legitimately claimed by someone, naming who should receive it.
      // Trust here rests on the SAME two checks /atlas/postoffice/relay's
      // own receiving side already relies on: the attestation is signed by
      // the domain it claims to be from (fetchDomainPublicKey + a fresh
      // cross-domain fetch, not a cached/self-reported key), and the
      // credential itself is genuinely this domain's own, still-live,
      // unrevoked signature — this domain does NOT re-derive who originally
      // dropped it or re-check the relaying domain's own bookkeeping; that
      // domain's signed word on "this was a legitimate reservation" is the
      // trust boundary, exactly as one federated domain's word on
      // "this sender holds a valid membership" already is for mail relay.
      if (req.method === 'POST' && req.url === '/atlas/world/drops/relay-claim') {
        const { credential, attestation, attestationSignature } = JSON.parse((await readBody(req)) || '{}');
        if (!credential || !attestation || !attestationSignature) return sendJson(res, 400, { error: 'credential, attestation, and attestationSignature are all required' });
        if (!credential.asset || !credential.issuer || credential.issuer.domain !== DOMAIN) return sendJson(res, 400, { error: 'this domain did not issue that credential' });
        if (attestation.credentialId !== credential.id) return sendJson(res, 400, { error: 'attestation does not name the credential it was sent with' });
        if (isRevoked(credential.id)) return sendJson(res, 400, { error: 'that credential has already been revoked — nothing to claim' });

        const ownSignatureOk = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
        if (!ownSignatureOk) return sendJson(res, 400, { error: 'credential signature does not check out against this domain\'s own key' });

        let relayingDomainKey;
        try {
          relayingDomainKey = await fetchDomainPublicKey(attestation.relayingDomain);
        } catch (err) {
          return sendJson(res, 502, { error: 'could not verify ' + attestation.relayingDomain + '\'s own published key: ' + err.message });
        }
        const attestationOk = await verifyDomainSignature(relayingDomainKey, attestation, attestationSignature);
        if (!attestationOk) return sendJson(res, 400, { error: attestation.relayingDomain + '\'s attestation signature does not check out' });

        const received = await fulfillWorldDropClaim(credential, attestation.claimantPublicKey);
        console.log('World drop relay-claimed from', attestation.relayingDomain + ':', credential.quantity, credential.asset.class, '->', attestation.claimantPublicKey.slice(0, 16) + '...');
        return sendJson(res, 200, { status: 'claimed', credential: received });
      }

      // --- mail (correspondence tied to a held credential — see task
      // notes discussed alongside this feature) ---
      //
      // /atlas/mail/send is the demo/admin side of this: standing in for
      // whatever real interface a domain operator would actually use to
      // write to members (this demo has no such interface, so a plain
      // endpoint fills in for it, admin-gated — see requireAdminAuth above
      // this handler). It doesn't check that credentialId was really
      // issued by this server — same demo-simplification level as the
      // rest of this file.
      //
      // A message can optionally carry an attached asset gift —
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
      // /atlas/mail/register-key: a local-mode identity's own encryption
      // public key, scoped to one held credential — the ahead-of-time
      // registration domain-to-subscriber mail needs, since (unlike Chat or
      // Mail Compose) a domain never gets a first message FROM a subscriber
      // to bootstrap a key exchange from — see extension/wallet.js's own
      // registerMailEncryptionKey() for the full reasoning. Requires the
      // actual credential (verified against this domain's own key and
      // checked against revocation, same as any other presented credential)
      // plus a proof of currently holding ITS owner key — proof.publicKey
      // alone is attacker-influenceable input, so it's checked against
      // credential.owner.publicKey explicitly here, the identical MITM
      // concern extension/wallet.js's own verifyChatE2eeKeyAnnouncement
      // already documents for the peer-to-peer case.
      if (req.method === 'POST' && req.url === '/atlas/mail/register-key') {
        const { credential, payload, proof } = JSON.parse((await readBody(req)) || '{}');
        if (!credential || !payload || !proof) return sendJson(res, 400, { error: 'credential, payload, and proof are required' });
        if (!payload.credentialId || !payload.mailEncryptionPublicKeyJwk) {
          return sendJson(res, 400, { error: 'payload.credentialId and payload.mailEncryptionPublicKeyJwk are required' });
        }
        if (payload.credentialId !== credential.id) {
          return sendJson(res, 400, { error: 'payload.credentialId does not match the presented credential' });
        }
        if (isRevoked(credential.id)) return sendJson(res, 400, { error: 'this credential has been revoked' });
        const ownSignatureOk = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
        if (!ownSignatureOk) return sendJson(res, 400, { error: 'credential signature does not check out against this domain\'s own key' });
        if (!credential.owner || proof.publicKey !== credential.owner.publicKey) {
          return sendJson(res, 400, { error: 'proof was not signed by this credential\'s own owner key' });
        }
        const proofOk = await verifyEnvelope(payload, proof);
        if (!proofOk) return sendJson(res, 400, { error: 'proof signature does not check out' });
        saveMailEncryptionKey(credential.id, payload.mailEncryptionPublicKeyJwk);
        console.log('Mail encryption key registered for', credential.id);
        return sendJson(res, 200, { ok: true });
      }

      // Admin-gated (requireAdminAuth, above): SPEC.md §11.1 already says
      // sending is "authenticated as the domain operator, not as any
      // visitor" — this was previously trusted at the network level only
      // (whoever could reach the endpoint), which also meant anyone could
      // get this domain to sign and deliver an arbitrary message, or mint
      // an arbitrary gift asset via giftAssetClass, to any credential id
      // they chose. Wire shape is {payload: {...the same fields as
      // before}, proof} or {payload, token}, the same envelope every other
      // admin action here uses.
      if (req.method === 'POST' && req.url === '/atlas/mail/send') {
        const { payload: sendPayload, proof, token } = JSON.parse((await readBody(req)) || '{}');
        const auth = await requireAdminAuth(sendPayload, proof, token);
        if (auth.error) return sendJson(res, 401, { error: auth.error });
        const { credentialId, subject, body, giftAssetClass, giftOwnerPublicKey, giftQuantity } = sendPayload;
        if (!credentialId || !subject || !body) {
          return sendJson(res, 400, { error: 'payload.credentialId, payload.subject, and payload.body are required' });
        }

        let attachedAsset;
        if (giftAssetClass) {
          if (!giftOwnerPublicKey) return sendJson(res, 400, { error: 'giftOwnerPublicKey is required when giftAssetClass is set' });
          const catalogEntry = ASSET_CATALOG[giftAssetClass];
          if (!catalogEntry) {
            // Task #204: see the matching comment on /atlas/asset/issue's
            // own "Unknown assetClass" message above for why this stopped
            // enumerating every class by name.
            return sendJson(res, 400, { error: 'Unknown giftAssetClass. See GET /atlas/trade/catalog for tradable classes, or ASSET_CATALOG in issuer-server/server.js (plus issuer-server/elements-catalog.js) for the full list.' });
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

        // This feature: when the recipient has registered an encryption
        // key against this exact credentialId (/atlas/mail/register-key,
        // below), subject and body travel encrypted to it instead of in
        // the clear — attachedAsset is deliberately left untouched, since
        // it's a complete, independently verifiable credential in its own
        // right (SPEC.md §11.2) and claimMailGift() reads it directly as
        // one; encrypting it would just break that. No key on file (an
        // opted-out client, a WebAuthn-only subscriber who can't run ECDH
        // at all, or simply hasn't checked mail yet to register one) means
        // this behaves exactly as it always has.
        const encryptionKey = getMailEncryptionKey(credentialId);
        const wireSubject = encryptionKey ? MAIL_ENCRYPTED_SUBJECT_PLACEHOLDER : subject;
        const wireBody = encryptionKey ? JSON.stringify(await encryptMailBodyToKey(encryptionKey, { subject, body })) : body;

        const payload = {
          id: 'urn:atlas:mail:' + webcrypto.randomUUID(),
          credentialId,
          subject: wireSubject,
          body: wireBody,
          ...(attachedAsset ? { attachedAsset } : {}),
          sentAt: new Date().toISOString()
        };
        const signature = await sign(payload);
        const message = { ...payload, signature };
        appendMail(message);
        console.log('Mail sent for', credentialId, '->', subject, attachedAsset ? '(with gift: ' + attachedAsset.asset.name + ')' : '', encryptionKey ? '(encrypted)' : '');
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
      //
      // `credentials` (optional, additive — a caller that only sends
      // `credentialIds` gets exactly the old behavior): the wallet's own
      // current copy of whichever of those ids it still wants to ask
      // about. Lets this same request also catch a class-wide patch (POST
      // /atlas/admin/class-patch) that's moved past what a specific
      // credential says, without this domain ever keeping a registry of
      // who holds what — see applyClassPatchIfStale()'s own comment. Only
      // consulted for an id that isn't already revoked or superseded;
      // never trusted for anything until its own signature checks out.
      if (req.method === 'POST' && req.url === '/atlas/mail/check') {
        const { credentialIds, credentials } = JSON.parse((await readBody(req)) || '{}');
        if (!Array.isArray(credentialIds) || credentialIds.length === 0) {
          return sendJson(res, 400, { error: 'credentialIds must be a non-empty array' });
        }
        const wanted = new Set(credentialIds);
        const messages = readMail().messages.filter((m) => wanted.has(m.credentialId));

        const presentedById = new Map();
        (Array.isArray(credentials) ? credentials : []).forEach((c) => { if (c && c.id) presentedById.set(c.id, c); });

        const assetUpdates = readAssetUpdates().updates;
        const revoked = readRevocations().revoked;
        const updates = [];
        for (const id of wanted) {
          const supersession = assetUpdates.find((u) => u.id === id);
          if (supersession) { updates.push(supersession); continue; }
          const revocation = revoked.find((r) => r.id === id);
          if (revocation) { updates.push({ id, status: 'revoked', reason: revocation.reason }); continue; }
          const presented = presentedById.get(id);
          if (presented) {
            const applied = await applyClassPatchIfStale(presented);
            if (applied) updates.push(applied);
          }
        }

        return sendJson(res, 200, { messages, updates });
      }

      // --- Calendar (SPEC.md §12) ---
      //
      // GET /atlas/calendar, optionally ?world={worldId} — ungated and
      // unsigned, same plain-HTTPS trust boundary as the manifest and
      // GET /atlas/trade/catalog (§12.1: "no new signature scheme for a
      // field that was always going to be public"). No `world` param
      // returns the domain-wide calendar; a `world` naming a world that
      // never opted in (or doesn't exist) gets back an empty `events`
      // array rather than an error, same "nothing to report" posture
      // GET /atlas/trade/listings already takes for a station with
      // nothing open.
      if (req.method === 'GET' && (req.url === '/atlas/calendar' || req.url.startsWith('/atlas/calendar?'))) {
        const queryStart = req.url.indexOf('?');
        const worldId = queryStart === -1 ? null : (new URLSearchParams(req.url.slice(queryStart + 1)).get('world') || null);
        const events = readCalendarEvents(worldId);
        return sendJson(res, 200, { domain: DOMAIN, worldId, events });
      }

      // POST /atlas/calendar — a real, protocol-level write endpoint
      // (§12.2), admin-gated (requireAdminAuth(), above) the same way
      // /atlas/revoke, /atlas/mail/send, and /atlas/asset/reissue are:
      // publishing a domain's or world's calendar is squarely the domain
      // operator's own action, never a visitor's, and left open it meant
      // anyone could plant or overwrite events shown to every visitor of
      // this domain. Wire shape is {payload: {action, worldId, event, id},
      // proof} or {payload, token}, the same envelope every other admin
      // action here uses. `worldId: null` (or omitted) addresses the
      // domain-wide calendar; naming a world addresses that world's own —
      // this server does not check that world's manifest entry actually
      // has `calendar: true` before accepting an event for it (see
      // CALENDAR_FILE's own comment on why).
      if (req.method === 'POST' && req.url === '/atlas/calendar') {
        const { payload: calendarPayload, proof, token } = JSON.parse((await readBody(req)) || '{}');
        const auth = await requireAdminAuth(calendarPayload, proof, token);
        if (auth.error) return sendJson(res, 401, { error: auth.error });
        const { action, worldId, event, id } = calendarPayload || {};
        const normalizedWorldId = worldId || null;

        if (action === 'add') {
          if (!event || !event.title || !event.dateTime) {
            return sendJson(res, 400, { error: 'event.title and event.dateTime are required' });
          }
          const newEvent = {
            id: event.id || ('urn:atlas:calendar:' + webcrypto.randomUUID()),
            worldId: normalizedWorldId,
            title: event.title,
            dateTime: event.dateTime,
            endDateTime: event.endDateTime || null,
            notes: event.notes || ''
          };
          addCalendarEvent(newEvent);
          console.log('Calendar event added' + (normalizedWorldId ? ' (world ' + normalizedWorldId + ')' : ' (domain-wide)') + ':', newEvent.title);
          return sendJson(res, 200, newEvent);
        }

        if (action === 'update') {
          if (!event || !event.id) return sendJson(res, 400, { error: 'event.id is required for update' });
          const patch = {};
          if (event.title !== undefined) patch.title = event.title;
          if (event.dateTime !== undefined) patch.dateTime = event.dateTime;
          if (event.endDateTime !== undefined) patch.endDateTime = event.endDateTime;
          if (event.notes !== undefined) patch.notes = event.notes;
          const updated = updateCalendarEvent(event.id, patch);
          if (!updated) return sendJson(res, 404, { error: 'no calendar event with that id' });
          return sendJson(res, 200, updated);
        }

        if (action === 'remove') {
          if (!id) return sendJson(res, 400, { error: 'id is required for remove' });
          const removed = removeCalendarEvent(id);
          if (!removed) return sendJson(res, 404, { error: 'no calendar event with that id' });
          return sendJson(res, 200, { status: 'removed', id });
        }

        return sendJson(res, 400, { error: 'action must be "add", "update", or "remove"' });
      }

      // --- Post Office (SPEC.md §11.3): user-to-user mail routed through
      // THIS domain, distinct from /atlas/mail/send above in exactly the
      // way that endpoint's own comment flags as the one genuinely new
      // server surface the design needed: /atlas/mail/send authenticates
      // the domain operator (requireAdminAuth, above); this one has to
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

      if ((req.method === 'GET' || req.method === 'HEAD') &&
          (req.url === '/atlas-admin' || req.url === '/atlas-admin/' || req.url === '/atlas-admin/index.html')) {
        return serveAdminPanel(req, res);
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
