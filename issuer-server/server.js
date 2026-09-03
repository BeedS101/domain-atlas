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
// /atlas/asset/split, /consolidate, and /trade endpoint below rejects a
// fungible:false credential outright — there's nothing for that arithmetic
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
// Also collapsed for the demo: a second visitor. §5.2 and §7 both need two
// distinct signers to mean anything. The extension represents the primary
// visitor with a real WebAuthn passkey (as it already did for the basic
// wallet) and a second, purely local ECDSA keypair standing in for "the
// other visitor" — see extension/wallet.js's counterparty functions and
// the README for why that's an honest way to demo a two-party protocol
// without needing two physical devices.
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
const KEY_FILE = path.resolve(__dirname, 'issuer-private-key.jwk.json');
const PUBLIC_KEY_FILE = path.join(DEMO_DOMAIN_A, '.well-known', 'atlas-key.json');
const REVOCATIONS_FILE = path.join(DEMO_DOMAIN_A, '.well-known', 'atlas-revocations.json');
// Deliberately NOT under .well-known (which is served as plain static
// files, world-readable to anyone who knows the URL) — mail is looked up
// through the /atlas/mail/check endpoint instead, which at least requires
// already knowing the credential IDs being asked about, same as any other
// server-side state that isn't meant to be a public crawlable file. Lives
// next to the private key file for the same "server-process-only state"
// reason, not in the public docroot.
const MAIL_FILE = path.resolve(__dirname, 'atlas-mail-store.json');
// Same "not under .well-known, not web-reachable" reasoning as MAIL_FILE —
// one entry per asset reissue (SPEC.md §5.1.1 — non-fungible only), keyed
// by the SUPERSEDED credential's id so /atlas/mail/check can answer "what
// happened to the id you asked about" in the same request it already
// answers "what mail arrived for the id you asked about." The public
// atlas-revocations.json file already records that the old id was revoked
// with reason "superseded" (§5.3) — this store is the extra, non-public
// piece a wallet actually needs to act on that: the full replacement
// credential, so adopting it doesn't need a second round trip.
const ASSET_UPDATES_FILE = path.resolve(__dirname, 'atlas-asset-updates-store.json');
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
const SUBSCRIBERS_FILE = path.resolve(__dirname, 'atlas-subscribers-store.json');
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
const SERIAL_COUNTERS_FILE = path.resolve(__dirname, 'atlas-serial-counters.json');
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
    properties: {
      'atlas.rarity': 'common',
      'com.example.tier': 'member',
      'com.example.issuedFor': 'domain subscription'
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
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(filePath);
      res.writeHead(200, {
        'Content-Type': (MIME[ext] || 'application/octet-stream'),
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
    if (!credential.asset || credential.asset.fungible !== true) return 'asset class is not fungible — cannot split, consolidate, or trade a unique asset';
    if (typeof credential.quantity !== 'number' || credential.quantity < minQuantity) return 'asset has insufficient quantity';
    if (isRevoked(credential.id)) return 'asset already revoked';
    const ok = await verifyOwnCredentialSignature(credential, assetPayloadOf(credential));
    if (!ok) return 'asset signature does not check out';
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
          return sendJson(res, 400, { error: 'Unknown assetClass. Try atlas.wearable, atlas.badge, atlas.wearable.ring, atlas.membership, atlas.element.iron, or atlas.element.gold.' });
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
      if (req.method === 'POST' && req.url === '/atlas/asset/trade') {
        const { intentA, intentB, balanceA, balanceB } = JSON.parse((await readBody(req)) || '{}');
        if (!intentA || !intentB || !balanceA || !balanceB) return sendJson(res, 400, { error: 'intentA, intentB, balanceA, balanceB are all required' });

        // 1. Intent — each side's own signature over their own offer.
        const okA = await verifyEnvelope(intentA.payload, intentA.proof);
        const okB = await verifyEnvelope(intentB.payload, intentB.proof);
        if (!okA) return sendJson(res, 400, { error: 'intentA signature does not check out' });
        if (!okB) return sendJson(res, 400, { error: 'intentB signature does not check out' });

        const pubA = intentA.proof.publicKey, pubB = intentB.proof.publicKey;
        if (intentA.payload.counterparty !== pubB || intentB.payload.counterparty !== pubA) {
          return sendJson(res, 400, { error: 'intents do not name each other as counterparty' });
        }
        if (new Date(intentA.payload.expiresAt).getTime() < Date.now() || new Date(intentB.payload.expiresAt).getTime() < Date.now()) {
          return sendJson(res, 400, { error: 'an intent has expired' });
        }

        // 2. Match — do the two offers actually mirror each other?
        const offerA = intentA.payload.offer, wantA = intentA.payload.want;
        const offerB = intentB.payload.offer, wantB = intentB.payload.want;
        const mirrors = offerA.class === wantB.class && offerA.quantity === wantB.quantity &&
                         offerB.class === wantA.class && offerB.quantity === wantA.quantity;
        if (!mirrors) return sendJson(res, 400, { error: 'intents do not mirror — offer/want mismatch' });

        // 3. Settle — check both presented balances actually cover the offer (and are fungible), then issue.
        const probA = await checkPresentedAsset(balanceA, pubA, offerA.class, offerA.quantity);
        if (probA) return sendJson(res, 400, { error: 'balanceA: ' + probA });
        const probB = await checkPresentedAsset(balanceB, pubB, offerB.class, offerB.quantity);
        if (probB) return sendJson(res, 400, { error: 'balanceB: ' + probB });

        const remainderA = balanceA.quantity - offerA.quantity;
        const remainderB = balanceB.quantity - offerB.quantity;

        const [aRemainder, aReceived, bRemainder, bReceived] = await Promise.all([
          remainderA > 0 ? mintAssetByClass(pubA, offerA.class, remainderA, balanceA.id) : Promise.resolve(null),
          mintAssetByClass(pubA, wantA.class, wantA.quantity, balanceA.id),
          remainderB > 0 ? mintAssetByClass(pubB, offerB.class, remainderB, balanceB.id) : Promise.resolve(null),
          mintAssetByClass(pubB, wantB.class, wantB.quantity, balanceB.id)
        ]);

        // 4. Atomicity — both sides' pre-trade balances are only revoked
        // once every new credential above has actually been signed, so a
        // failure earlier in this handler leaves nothing settled at all.
        revoke(balanceA.id, 'superseded');
        revoke(balanceB.id, 'superseded');

        console.log('Settled trade:', offerA.quantity, offerA.class, '<->', offerB.quantity, offerB.class);
        return sendJson(res, 200, { aRemainder, aReceived, bRemainder, bReceived });
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
            return sendJson(res, 400, { error: 'Unknown giftAssetClass. Try atlas.wearable, atlas.badge, atlas.wearable.ring, atlas.membership, atlas.element.iron, or atlas.element.gold.' });
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

      if (req.method === 'GET') return serveStatic(req, res);
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
