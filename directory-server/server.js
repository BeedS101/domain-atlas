// Domain Atlas — reference directory service (SPEC.md §3.3), port 8003.
//
// This is deliberately a SEPARATE service from either issuer, the same way
// a real search engine is architecturally separate from any one site it
// indexes — an issuer signs credentials for its own domain; a directory
// crawls and ranks OTHER domains' manifests. Mixing the two into one
// process would blur a distinction §3.3 is explicit about: "anyone may run
// a competing directory against the same public manifests; nothing here
// designates one as canonical." A directory is just another client of the
// public manifest format, not a privileged part of the protocol.
//
// What a real search engine actually does, scaled down to this domain's
// size: a crawl frontier (manifests table, each with its own next-crawl
// time and backoff), a document index (worlds table, one row per
// discoverable world), a link graph computed from inbound "kind":"domain"
// portals (the same insight PageRank started from — SPEC.md §3.3 says so
// directly), and a small inverted text index over name/genre/domain for
// free-text queries. All four pieces below are real, not stubbed: the
// crawler actually re-fetches on a schedule and backs off on failure, the
// ranking is actually computed from the actual portal graph, and the text
// index is an actual token -> world-id postings map, not a linear scan
// dressed up to look like one (though at this scale a linear scan would
// perform identically — the point is the shape, not the constant factor).
//
// Zero npm dependencies — Node's built-in http/crypto/fetch only, same
// convention as issuer-server/server.js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const PORT = process.env.PORT || 8003;
// Overridable so tests can run an isolated instance (own port, own
// snapshot file, short crawl interval) without touching the real index a
// developer has running locally.
const SNAPSHOT_FILE = process.env.DIRECTORY_SNAPSHOT_FILE
  ? path.resolve(process.env.DIRECTORY_SNAPSHOT_FILE)
  : path.resolve(__dirname, 'directory-index.json');

// How often a manifest is re-fetched once indexed. Real search engines use
// hours-to-days; this is a demo meant to be watchable, so it defaults much
// shorter. Override with DIRECTORY_CRAWL_INTERVAL_MS for a longer-lived
// deployment.
const CRAWL_INTERVAL_MS = Number(process.env.DIRECTORY_CRAWL_INTERVAL_MS) || 60_000;
// How often the scheduler wakes up to check whether anything in the crawl
// frontier is due. Independent of the per-manifest interval above — this
// is just the granularity of the check, not how often any one manifest
// actually gets re-fetched.
const SCHEDULER_TICK_MS = Math.min(15_000, CRAWL_INTERVAL_MS);
const FETCH_TIMEOUT_MS = 5_000;
// After this many consecutive failed crawls, a manifest's last-known-good
// entries are flagged `stale` in search results instead of silently
// disappearing — the same "serve the cached copy, mark it old" behavior a
// real search index shows when a site goes temporarily unreachable, rather
// than instantly de-indexing on one dropped connection.
const STALE_AFTER_FAILURES = 3;
const MAX_BACKOFF_MS = CRAWL_INTERVAL_MS * 10;

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(str) { return new Uint8Array(Buffer.from(str, 'base64url')); }

// Identical to issuer-server/server.js's canonicalize() and
// extension/wallet.js's — must stay byte-for-byte the same or a
// key-anchored manifest's signature will look "invalid" purely from
// key-ordering differences, not an actual tamper.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// SPEC.md §3.6: "A manifest with identityKey and no domain is key-anchored:
// a client verifies it by canonicalizing the manifest with signature
// removed (§6.2's canonicalization, reused unchanged) and checking
// signature against identityKey." A directory submission gets exactly the
// same treatment a browsing client would give it — "verified the same way
// any client would verify one, not taken on faith" (§3.3) — never indexed
// on the strength of the submitter's say-so alone.
async function verifyKeyAnchoredManifest(manifest) {
  if (typeof manifest.signature !== 'string' || !manifest.signature) return false;
  const { signature, ...unsigned } = manifest;
  try {
    const pub = await subtle.importKey('raw', fromB64url(manifest.identityKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const data = new TextEncoder().encode(canonicalize(unsigned));
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(signature), data);
  } catch {
    return false; // malformed key or signature — same outcome as "doesn't verify"
  }
}

// ---------- storage ----------
//
// Two tables, kept deliberately separate the way a real crawler keeps its
// frontier separate from its document index:
//   manifests — one row per submitted manifest URL: fetch/crawl state.
//   worlds    — one row per discoverable world found inside a manifest,
//               keyed by `${anchorType}:${anchorKey}:${worldId}` so a
//               domain-anchored and a key-anchored submission can never
//               collide even if their content happened to look similar.
// A third structure, the token index, is derived from `worlds` and rebuilt
// whenever `worlds` changes rather than maintained incrementally — simpler
// to keep correct, and at this scale rebuilding is effectively free.
const manifests = new Map(); // url -> { url, anchorType, anchorKey, submittedAt, lastCrawledAt, nextCrawlAt, status, consecutiveFailures, manifestUpdatedAt }
const worlds = new Map();    // worldKey -> { ...indexed fields... }
let tokenIndex = new Map();  // token -> Set(worldKey)
let inboundCounts = new Map(); // domain -> count of inbound "kind":"domain" portals

function loadSnapshot() {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    for (const m of raw.manifests || []) manifests.set(m.url, m);
    for (const w of raw.worlds || []) worlds.set(w.worldKey, w);
    console.log(`Loaded snapshot: ${manifests.size} manifest(s), ${worlds.size} world(s).`);
  } catch {
    // No snapshot yet, or it's corrupt — start empty. Not fatal either way;
    // a directory can always be rebuilt by re-submitting.
  }
}

function saveSnapshot() {
  const doc = { manifests: [...manifests.values()], worlds: [...worlds.values()] };
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(doc, null, 2));
}

// ---------- text index ----------

function tokenize(str) {
  return (str || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function rebuildTokenIndex() {
  const next = new Map();
  for (const w of worlds.values()) {
    const tokens = new Set([
      ...tokenize(w.name),
      ...tokenize(w.genre),
      ...tokenize(w.domain || ''),
      ...tokenize(w.worldId)
    ]);
    for (const t of tokens) {
      if (!next.has(t)) next.set(t, new Set());
      next.get(t).add(w.worldKey);
    }
  }
  tokenIndex = next;
}

// ---------- link graph / ranking ----------
//
// SPEC.md §3.3: "the count of inbound 'kind: domain' portals pointing at a
// manifest is a simple, self-computed relevance signal — the same insight
// PageRank started from, applied to a much smaller graph." Recomputed as a
// full pass over the current index after every crawl batch, the same way
// a real search engine periodically recomputes link-based rank in batches
// rather than trying to maintain it incrementally on every single edit —
// simpler to keep correct, and cheap enough at this scale to just redo.
function rebuildLinkGraph() {
  const counts = new Map();
  for (const w of worlds.values()) {
    for (const portal of w.portalsRaw || []) {
      if (portal.kind === 'domain' && portal.to) {
        counts.set(portal.to, (counts.get(portal.to) || 0) + 1);
      }
    }
  }
  inboundCounts = counts;
}

function inboundCountFor(world) {
  const key = world.anchorType === 'domain' ? world.domain : world.identityKey;
  return inboundCounts.get(key) || 0;
}

// ---------- fetching + validating a manifest ----------

function isAllowedUrl(url) {
  // SPEC.md §3.6.1: plain HTTP is a hard failure for either anchor type in
  // a real deployment. This demo runs entirely over http://localhost, so
  // that one host is an explicit, documented exception — anything else
  // must be https.
  const u = new URL(url);
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  return false;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'not a JSON object';
  if (typeof manifest.spec !== 'string' || !manifest.spec.startsWith('domain-atlas/')) return 'missing or unrecognized "spec"';
  if (!Array.isArray(manifest.worlds)) return 'missing "worlds" array';
  const hasDomain = typeof manifest.domain === 'string' && manifest.domain;
  const hasKey = typeof manifest.identityKey === 'string' && manifest.identityKey;
  if (hasDomain === hasKey) return 'manifest must have exactly one of "domain" or "identityKey"';
  return null;
}

// Fetches, validates, and (re)indexes one manifest. Returns
// { ok, worldsIndexed, error }. Shared by both /submit (first crawl,
// synchronous so the submitter sees a real result) and the background
// scheduler (subsequent re-crawls).
async function crawlOne(url) {
  const record = manifests.get(url);
  try {
    if (!isAllowedUrl(url)) throw new Error('refusing plain HTTP for a non-localhost host (SPEC.md §3.6.1)');
    const manifest = await fetchJson(url);
    const shapeError = validateManifestShape(manifest);
    if (shapeError) throw new Error(shapeError);

    const anchorType = manifest.domain ? 'domain' : 'key';
    const anchorKey = manifest.domain || manifest.identityKey;

    if (anchorType === 'key') {
      const valid = await verifyKeyAnchoredManifest(manifest);
      if (!valid) throw new Error('key-anchored manifest signature does not verify against its own identityKey');
    }

    // Drop this manifest's previously-indexed worlds before re-adding —
    // a world that was discoverable last crawl and isn't anymore (or was
    // renamed/removed) shouldn't linger just because indexing is additive
    // by default.
    for (const [key, w] of worlds) {
      if (w.anchorType === anchorType && (anchorType === 'domain' ? w.domain === anchorKey : w.identityKey === anchorKey)) {
        worlds.delete(key);
      }
    }

    let indexed = 0;
    for (const world of manifest.worlds) {
      if (!world.policy || world.policy.discoverable !== true) continue; // §3: discoverable is what makes a world directory-eligible at all
      const worldKey = `${anchorType}:${anchorKey}:${world.id}`;
      worlds.set(worldKey, {
        worldKey,
        anchorType,
        domain: anchorType === 'domain' ? anchorKey : null,
        identityKey: anchorType === 'key' ? anchorKey : null,
        worldId: world.id,
        name: world.name,
        ownerName: (manifest.owner && manifest.owner.name) || null,
        genre: (world.profile && world.profile.genre) || null,
        scale: (world.profile && world.profile.scale) || null,
        capabilities: (world.profile && world.profile.capabilities) || null,
        guestAccess: (world.policy && world.policy.guestAccess) || null,
        identityRequired: !!(world.policy && world.policy.identityRequired),
        itemDropsAllowed: !!(world.policy && world.policy.itemDropsAllowed),
        acceptedItemClasses: (world.policy && world.policy.acceptedItemClasses) || [],
        trustedIssuers: (world.policy && world.policy.trustedIssuers) || null,
        portalsRaw: world.portals || [],
        manifestUrl: url,
        indexedAt: new Date().toISOString()
      });
      indexed++;
    }

    manifests.set(url, {
      ...(record || { url, submittedAt: new Date().toISOString() }),
      url,
      anchorType,
      anchorKey,
      lastCrawledAt: new Date().toISOString(),
      nextCrawlAt: Date.now() + CRAWL_INTERVAL_MS,
      status: 'ok',
      consecutiveFailures: 0,
      manifestUpdatedAt: manifest.updated || null
    });

    rebuildTokenIndex();
    rebuildLinkGraph();
    return { ok: true, worldsIndexed: indexed };
  } catch (err) {
    const failures = ((record && record.consecutiveFailures) || 0) + 1;
    const backoff = Math.min(CRAWL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
    manifests.set(url, {
      ...(record || { url, submittedAt: new Date().toISOString(), anchorType: null, anchorKey: null }),
      url,
      lastCrawledAt: new Date().toISOString(),
      nextCrawlAt: Date.now() + backoff,
      status: 'error',
      lastError: err.message,
      consecutiveFailures: failures
    });
    return { ok: false, error: err.message };
  }
}

// ---------- background crawl scheduler ----------
//
// The actual "crawler" half of a search engine — walks the frontier on a
// timer, re-fetching anything due, independent of whether anyone is
// actively searching right now. A manifest that changes its worlds,
// portals, or discoverability between crawls is picked up on its next
// scheduled pass, not instantly — the same eventual-consistency a real
// search index has with the live web.
function startScheduler() {
  setInterval(async () => {
    const due = [...manifests.values()].filter((m) => m.nextCrawlAt <= Date.now()).map((m) => m.url);
    if (due.length === 0) return;
    await Promise.all(due.map((url) => crawlOne(url)));
    saveSnapshot();
  }, SCHEDULER_TICK_MS).unref();
}

// ---------- search ----------

function matchesFilters(w, filters) {
  if (filters.genre && !(w.genre || '').toLowerCase().includes(filters.genre.toLowerCase())) return false;
  if (filters.scale && w.scale !== filters.scale) return false;
  if (filters.combat && (!w.capabilities || w.capabilities.combat !== filters.combat)) return false;
  if (filters.domain && w.domain !== filters.domain) return false;
  return true;
}

function search({ q, genre, scale, combat, domain }) {
  let candidates = [...worlds.values()].filter((w) => matchesFilters(w, { genre, scale, combat, domain }));

  let scored;
  if (q && q.trim()) {
    const qTokens = tokenize(q);
    scored = candidates
      .map((w) => {
        const matched = qTokens.filter((t) => tokenIndex.has(t) && tokenIndex.get(t).has(w.worldKey)).length;
        return { w, matched };
      })
      .filter((r) => r.matched > 0)
      .sort((a, b) => (b.matched - a.matched) || (inboundCountFor(b.w) - inboundCountFor(a.w)) || a.w.name.localeCompare(b.w.name));
  } else {
    scored = candidates
      .map((w) => ({ w, matched: null }))
      .sort((a, b) => (inboundCountFor(b.w) - inboundCountFor(a.w)) || a.w.name.localeCompare(b.w.name));
  }

  return scored.map(({ w }) => {
    const m = manifests.get(w.manifestUrl);
    const stale = !!(m && m.consecutiveFailures >= STALE_AFTER_FAILURES);
    return {
      anchorType: w.anchorType,
      domain: w.domain,
      identityKey: w.identityKey,
      worldId: w.worldId,
      name: w.name,
      ownerName: w.ownerName,
      genre: w.genre,
      scale: w.scale,
      capabilities: w.capabilities,
      guestAccess: w.guestAccess,
      identityRequired: w.identityRequired,
      manifestUrl: w.manifestUrl,
      inboundPortalCount: inboundCountFor(w),
      stale
    };
  });
}

// ---------- HTTP layer ----------

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

const STATIC_DIR = __dirname;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(STATIC_DIR, urlPath);
  if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
}

async function main() {
  loadSnapshot();
  rebuildTokenIndex();
  rebuildLinkGraph();
  startScheduler();

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
      const url = new URL(req.url, 'http://localhost');

      // SPEC.md §3.3's concrete interface, verbatim: POST /submit.
      if (req.method === 'POST' && url.pathname === '/submit') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const manifestUrl = body.manifest;
        if (!manifestUrl || typeof manifestUrl !== 'string') return sendJson(res, 400, { error: 'manifest (URL string) is required' });
        try { new URL(manifestUrl); } catch { return sendJson(res, 400, { error: 'manifest must be a valid URL' }); }

        if (!manifests.has(manifestUrl)) {
          manifests.set(manifestUrl, { url: manifestUrl, submittedAt: new Date().toISOString(), nextCrawlAt: Date.now(), consecutiveFailures: 0, status: 'pending' });
        }
        const result = await crawlOne(manifestUrl);
        saveSnapshot();
        if (!result.ok) return sendJson(res, 422, { error: result.error });
        return sendJson(res, 200, { indexed: result.worldsIndexed, manifest: manifestUrl });
      }

      // SPEC.md §3.3's concrete interface, verbatim: GET /search.
      if (req.method === 'GET' && url.pathname === '/search') {
        const results = search({
          q: url.searchParams.get('q'),
          genre: url.searchParams.get('genre'),
          scale: url.searchParams.get('scale'),
          combat: url.searchParams.get('combat'),
          domain: url.searchParams.get('domain')
        });
        return sendJson(res, 200, { count: results.length, results });
      }

      if (req.method === 'GET' && url.pathname === '/stats') {
        return sendJson(res, 200, {
          manifestsTracked: manifests.size,
          worldsIndexed: worlds.size,
          crawlIntervalMs: CRAWL_INTERVAL_MS
        });
      }

      return serveStatic(req, res);
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: 'internal error', detail: err.message });
    }
  });

  server.listen(PORT, () => {
    console.log(`Directory service listening on http://localhost:${PORT}`);
    console.log(`Crawl interval: ${CRAWL_INTERVAL_MS}ms · scheduler tick: ${SCHEDULER_TICK_MS}ms`);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
