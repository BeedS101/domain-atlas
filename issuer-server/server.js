// Domain Atlas — issuer + trading-station demo server (port 8001)
//
// A real implementation of SPEC.md §5 (items), §5.4 (resources), and §7
// (trading stations) — not a mock. It generates a genuine ECDSA P-256
// keypair on first run, signs real credentials with it, and settles real
// two-party trades by checking two independently-signed intents actually
// mirror each other before issuing anything. Nothing here is simulated;
// everything that can be checked cryptographically, is.
//
// Demo simplification, stated plainly: in a real deployment the "trading
// station" in §7 would usually be a different party than the issuer whose
// resources are being traded — the spec deliberately allows that. This
// demo collapses issuer and station into one process because there's only
// one resource-issuing domain in the demo; the settlement logic itself
// (verify both intents, verify both balances, issue four new credentials,
// revoke two) doesn't depend on that and would work unchanged if a
// separate station server called this same issuer's endpoints instead of
// running them in-process.
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
const PORT = process.env.PORT || 8001;
const DOMAIN = process.env.ATLAS_DOMAIN || 'localhost:8001';

// `properties` is an open, per-item-type bag (SPEC.md §5.1) — a creator
// adds or changes keys here freely, no protocol coordination needed. It's
// entirely optional; an entry with no `properties` issues items shaped
// exactly as before this feature existed.
const ITEM_CATALOG = {
  'atlas.wearable': {
    name: 'Bronze Compass',
    model: `https://${DOMAIN}/assets/compass.glb`,
    thumbnail: `https://${DOMAIN}/assets/compass.png`,
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
  // string the way every other item in this catalog happens to use.
  'atlas.wearable.ring': {
    name: "Merchant's Signet Ring",
    model: `https://${DOMAIN}/assets/ring.glb`,
    thumbnail: `https://${DOMAIN}/assets/ring.png`,
    properties: {
      'atlas.rarity': 'rare',
      'com.example.material': 'silver',
      'com.example.origin': 'Coastal Bazaar',
      'com.example.enchantments': ['fire resistance', 'silent step', 'luck +2']
    }
  }
};

// Same idea as ITEM_CATALOG's properties, but per resource CLASS rather
// than per item type — and deliberately looked up fresh by issueResource()
// on every mint/split/consolidate/trade of that class (SPEC.md §5.4), never
// copied from an old balance. That's what keeps auto-consolidation safe:
// every balance of a class always carries the exact same properties by
// construction, so merging quantities can never blend or drop a differing
// value.
const RESOURCE_CATALOG = {
  'atlas.element.iron': {
    properties: { 'atlas.purity': '99.9%', 'atlas.state': 'solid', 'com.example.source': 'Coastal Bazaar mine' }
  },
  'atlas.element.gold': {
    properties: { 'atlas.purity': '99.99%', 'atlas.state': 'solid', 'com.example.form': 'ingot' }
  }
};

const RESOURCE_CLASSES = new Set(['atlas.element.iron', 'atlas.element.gold']);

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css'
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
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': (MIME[ext] || 'application/octet-stream'), 'Access-Control-Allow-Origin': '*' });
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

  // Verifies a resource/item credential this issuer itself signed —
  // used before trusting a balance presented back to us for a split or a
  // trade. Same check a stranger would run against our published key;
  // here we already have it in memory.
  async function verifyOwnCredentialSignature(credential, payload) {
    const pub = await subtle.importKey('raw', fromB64url(publicKeyB64url), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const data = new TextEncoder().encode(canonicalize(payload));
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(credential.signature), data);
  }

  async function issueResource(ownerPublicKey, cls, quantity, supersedes) {
    const catalogEntry = RESOURCE_CATALOG[cls];
    const payload = {
      id: 'urn:atlas:resource:' + webcrypto.randomUUID(),
      class: cls,
      quantity,
      owner: { publicKey: ownerPublicKey },
      supersedes: supersedes || null,
      ...(catalogEntry && catalogEntry.properties ? { properties: catalogEntry.properties } : {}),
      issuedAt: new Date().toISOString()
    };
    const signature = await sign(payload);
    return {
      credential: 'domain-atlas-resource/1.0',
      id: payload.id,
      issuer: { domain: DOMAIN, publicKey: publicKeyB64url },
      class: payload.class,
      quantity: payload.quantity,
      owner: payload.owner,
      supersedes: payload.supersedes,
      ...(payload.properties ? { properties: payload.properties } : {}),
      issuedAt: payload.issuedAt,
      signature
    };
  }

  function resourcePayloadOf(credential) {
    return {
      id: credential.id, class: credential.class, quantity: credential.quantity,
      owner: credential.owner, supersedes: credential.supersedes,
      ...(credential.properties ? { properties: credential.properties } : {}),
      issuedAt: credential.issuedAt
    };
  }

  async function checkPresentedBalance(credential, expectedOwner, expectedClass, minQuantity) {
    if (!credential || credential.credential !== 'domain-atlas-resource/1.0') return 'not a resource credential';
    if (credential.owner.publicKey !== expectedOwner) return 'balance does not belong to this signer';
    if (credential.class !== expectedClass) return 'balance is the wrong class';
    if (credential.quantity < minQuantity) return 'balance has insufficient quantity';
    if (isRevoked(credential.id)) return 'balance already revoked';
    const ok = await verifyOwnCredentialSignature(credential, resourcePayloadOf(credential));
    if (!ok) return 'balance signature does not check out';
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
      // --- §5 items (unchanged from the wallet build) ---
      if (req.method === 'POST' && req.url === '/atlas/issue') {
        const { ownerPublicKey, assetClass } = JSON.parse((await readBody(req)) || '{}');
        if (!ownerPublicKey) return sendJson(res, 400, { error: 'ownerPublicKey is required' });
        const asset = ITEM_CATALOG[assetClass];
        if (!asset) return sendJson(res, 400, { error: 'Unknown assetClass. Try atlas.wearable, atlas.badge, or atlas.wearable.ring.' });
        const payload = {
          id: 'urn:atlas:item:' + webcrypto.randomUUID(),
          asset: {
            name: asset.name, class: assetClass, model: asset.model,
            ...(asset.thumbnail ? { thumbnail: asset.thumbnail } : {}),
            ...(asset.properties ? { properties: asset.properties } : {})
          },
          owner: { publicKey: ownerPublicKey },
          issuedAt: new Date().toISOString()
        };
        const signature = await sign(payload);
        const credential = { credential: 'domain-atlas-item/1.0', ...payload, issuer: { domain: DOMAIN, publicKey: publicKeyB64url }, signature };
        console.log('Issued', payload.asset.name, 'to', ownerPublicKey.slice(0, 16) + '...');
        return sendJson(res, 200, credential);
      }

      if (req.method === 'POST' && req.url === '/atlas/revoke') {
        const { id, reason } = JSON.parse((await readBody(req)) || '{}');
        if (!id) return sendJson(res, 400, { error: 'id is required' });
        revoke(id, reason || 'issuer-request');
        console.log('Revoked', id);
        return sendJson(res, 200, { ok: true });
      }

      // --- §5.4 fungible resources ---
      if (req.method === 'POST' && req.url === '/atlas/resource/issue') {
        const { ownerPublicKey, class: cls, quantity } = JSON.parse((await readBody(req)) || '{}');
        if (!ownerPublicKey) return sendJson(res, 400, { error: 'ownerPublicKey is required' });
        if (!RESOURCE_CLASSES.has(cls)) return sendJson(res, 400, { error: 'Unknown resource class. Try atlas.element.iron or atlas.element.gold.' });
        if (!Number.isInteger(quantity) || quantity <= 0) return sendJson(res, 400, { error: 'quantity must be a positive integer' });
        const credential = await issueResource(ownerPublicKey, cls, quantity, null);
        console.log('Minted', quantity, cls, 'to', ownerPublicKey.slice(0, 16) + '...');
        return sendJson(res, 200, credential);
      }

      if (req.method === 'POST' && req.url === '/atlas/resource/split') {
        const { credential, sendAmount, toPublicKey } = JSON.parse((await readBody(req)) || '{}');
        if (!credential || !toPublicKey || !Number.isInteger(sendAmount) || sendAmount <= 0) {
          return sendJson(res, 400, { error: 'credential, sendAmount, and toPublicKey are required' });
        }
        const problem = await checkPresentedBalance(credential, credential.owner.publicKey, credential.class, sendAmount);
        if (problem) return sendJson(res, 400, { error: problem });

        const remainderQty = credential.quantity - sendAmount;
        const sent = await issueResource(toPublicKey, credential.class, sendAmount, credential.id);
        const remainder = remainderQty > 0 ? await issueResource(credential.owner.publicKey, credential.class, remainderQty, credential.id) : null;
        revoke(credential.id, 'superseded');
        console.log('Split', credential.class, '- sent', sendAmount, 'kept', remainderQty);
        return sendJson(res, 200, { sent, remainder });
      }

      // Merges several balances of the SAME class, from THIS issuer, owned
      // by the SAME public key, into one. Client-side wallet math alone
      // can't produce this — a resource credential's quantity is only
      // meaningful because the issuer's signature vouches for it, so a
      // merged total needs a fresh signature over that total just like a
      // split's remainder does. Mirrors split's shape: the old balances are
      // revoked ('consolidated' instead of 'superseded') only after the new
      // one is signed, and supersedes carries every superseded id instead
      // of just one.
      if (req.method === 'POST' && req.url === '/atlas/resource/consolidate') {
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
        const cls = credentials[0] && credentials[0].class;
        for (const credential of credentials) {
          const problem = await checkPresentedBalance(credential, owner, cls, 1);
          if (problem) return sendJson(res, 400, { error: problem });
        }
        const total = credentials.reduce((sum, c) => sum + c.quantity, 0);
        const merged = await issueResource(owner, cls, total, ids);
        ids.forEach((id) => revoke(id, 'consolidated'));
        console.log('Consolidated', credentials.length, cls, 'balances into', total, 'for', owner.slice(0, 16) + '...');
        return sendJson(res, 200, merged);
      }

      // --- §7 trading stations (this server plays the station role — see file header) ---
      if (req.method === 'POST' && req.url === '/atlas/resource/trade') {
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

        // 3. Settle — check both presented balances actually cover the offer, then issue.
        const probA = await checkPresentedBalance(balanceA, pubA, offerA.class, offerA.quantity);
        if (probA) return sendJson(res, 400, { error: 'balanceA: ' + probA });
        const probB = await checkPresentedBalance(balanceB, pubB, offerB.class, offerB.quantity);
        if (probB) return sendJson(res, 400, { error: 'balanceB: ' + probB });

        const remainderA = balanceA.quantity - offerA.quantity;
        const remainderB = balanceB.quantity - offerB.quantity;

        const [aRemainder, aReceived, bRemainder, bReceived] = await Promise.all([
          remainderA > 0 ? issueResource(pubA, offerA.class, remainderA, balanceA.id) : Promise.resolve(null),
          issueResource(pubA, wantA.class, wantA.quantity, balanceA.id),
          remainderB > 0 ? issueResource(pubB, offerB.class, remainderB, balanceB.id) : Promise.resolve(null),
          issueResource(pubB, wantB.class, wantB.quantity, balanceB.id)
        ]);

        // 4. Atomicity — both sides' pre-trade balances are only revoked
        // once every new credential above has actually been signed, so a
        // failure earlier in this handler leaves nothing settled at all.
        revoke(balanceA.id, 'superseded');
        revoke(balanceB.id, 'superseded');

        console.log('Settled trade:', offerA.quantity, offerA.class, '<->', offerB.quantity, offerB.class);
        return sendJson(res, 200, { aRemainder, aReceived, bRemainder, bReceived });
      }

      if (req.method === 'GET') return serveStatic(req, res);
      res.writeHead(405);
      res.end('Method not allowed');
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: err.message });
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
