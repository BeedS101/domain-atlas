// Domain Atlas - reference directory service (SPEC.md §3.3), port 8003.
//
// A directory is a separate service from any issuer: an issuer signs credentials for its own domain,
// a directory crawls and ranks OTHER domains' manifests. Anyone may run a competing directory against
// the same public manifests; nothing here is canonical.
//
// The pieces: a crawl frontier (the manifests table: per-manifest next-crawl time and backoff), a
// document index (the worlds table, one row per discoverable world), a link graph from inbound
// "kind":"domain" portals, and a small token -> world postings index for free-text queries.
//
// Because anyone can submit anything, a submission is never trusted for what it says about itself:
//   - a domain-anchored manifest must be served from /.well-known/spatial.json on the very host it
//     claims as its `domain`, so one site cannot list worlds under another site's name;
//   - a key-anchored manifest must verify against its own identityKey (SPEC.md §3.6);
//   - the crawler only talks to public https hosts: the address a name resolves to is checked at
//     connect time (so a name that later points inside a network is refused), redirects are not
//     followed, and a response is cut off at MAX_MANIFEST_BYTES;
//   - /submit is rate limited per client, request bodies are small, and the number of tracked
//     manifests is capped.
// DIRECTORY_ALLOW_LOCAL=1 lifts the public-host rules so a demo or test can crawl localhost.
//
// Zero npm dependencies: Node's built-in modules only, same convention as issuer-server/server.js.

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const PORT = process.env.PORT || 8003;
const SNAPSHOT_FILE = process.env.DIRECTORY_SNAPSHOT_FILE
  ? path.resolve(process.env.DIRECTORY_SNAPSHOT_FILE)
  : path.resolve(__dirname, 'directory-index.json');

const ALLOW_LOCAL = process.env.DIRECTORY_ALLOW_LOCAL === '1';
const TRUST_PROXY = process.env.DIRECTORY_TRUST_PROXY === '1';
// Domains (or identity keys) this directory will not list, comma separated. A listed site is dropped on its next crawl.
const BLOCKED = new Set((process.env.DIRECTORY_BLOCKED || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));

// How often a manifest is re-fetched once indexed. The demo default is short so it is watchable; a
// deployment sets DIRECTORY_CRAWL_INTERVAL_MS to hours.
const CRAWL_INTERVAL_MS = Number(process.env.DIRECTORY_CRAWL_INTERVAL_MS) || 60_000;
const SCHEDULER_TICK_MS = Math.min(15_000, CRAWL_INTERVAL_MS);
const FETCH_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_CRAWLS = 5;
// After this many consecutive failed crawls a manifest's last good entries are flagged `stale`
// instead of disappearing; after DROP_AFTER_FAILURES the manifest and its worlds are dropped.
const STALE_AFTER_FAILURES = 3;
const DROP_AFTER_FAILURES = 20;
const MAX_BACKOFF_MS = CRAWL_INTERVAL_MS * 10;

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_WORLDS_PER_MANIFEST = 100;
const MAX_PORTALS_PER_WORLD = 50;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_MANIFESTS = Number(process.env.DIRECTORY_MAX_MANIFESTS) || 500;
const SUBMITS_PER_HOUR = Number(process.env.DIRECTORY_SUBMITS_PER_HOUR) || 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const WELL_KNOWN_PATH = '/.well-known/spatial.json';

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(str) { return new Uint8Array(Buffer.from(str, 'base64url')); }

// Identical to issuer-server/server.js's canonicalize() and extension/wallet.js's: a key-anchored
// manifest's signature breaks if key ordering differs.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// SPEC.md §3.6: canonicalize the manifest with `signature` removed and check it against identityKey.
async function verifyKeyAnchoredManifest(manifest) {
  if (typeof manifest.signature !== 'string' || !manifest.signature) return false;
  const { signature, ...unsigned } = manifest;
  try {
    const pub = await subtle.importKey('raw', fromB64url(manifest.identityKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const data = new TextEncoder().encode(canonicalize(unsigned));
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(signature), data);
  } catch {
    return false;
  }
}

// ---------- storage ----------
const manifests = new Map(); // url -> crawl state
const worlds = new Map();    // worldKey -> indexed fields
let tokenIndex = new Map();  // token -> Set(worldKey)
let inboundCounts = new Map(); // domain or key -> number of distinct other anchors linking to it

function loadSnapshot() {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    for (const m of raw.manifests || []) {
      // A snapshot from before lastSuccessAt existed: a manifest whose last crawl worked was last seen at that crawl.
      if (m.lastSuccessAt === undefined && m.status === 'ok' && m.lastCrawledAt) m.lastSuccessAt = m.lastCrawledAt;
      manifests.set(m.url, m);
    }
    for (const w of raw.worlds || []) worlds.set(w.worldKey, w);
    console.log(`Loaded snapshot: ${manifests.size} manifest(s), ${worlds.size} world(s).`);
  } catch {
    // No snapshot yet, or it is corrupt: start empty. A directory can always be rebuilt by re-submitting.
  }
}

// Written to a temporary file and renamed, so a crash mid-write never leaves a half-written index.
function saveSnapshot() {
  const doc = { manifests: [...manifests.values()], worlds: [...worlds.values()] };
  const tmp = SNAPSHOT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, SNAPSHOT_FILE);
}

// ---------- text index ----------
function tokenize(str) {
  return (str || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function rebuildTokenIndex() {
  const next = new Map();
  for (const w of worlds.values()) {
    const tokens = new Set([...tokenize(w.name), ...tokenize(w.genre), ...tokenize(w.domain || ''), ...tokenize(w.worldId)]);
    for (const t of tokens) {
      if (!next.has(t)) next.set(t, new Set());
      next.get(t).add(w.worldKey);
    }
  }
  tokenIndex = next;
}

// ---------- link graph / ranking ----------
// SPEC.md §3.3: the count of inbound "kind: domain" portals is the relevance signal. Counted per
// distinct linking site, and a site linking to itself adds nothing, so one operator cannot raise a
// rank by adding portals to its own worlds.
function anchorOf(w) { return w.anchorType === 'domain' ? w.domain : w.identityKey; }

function rebuildLinkGraph() {
  const sources = new Map(); // target -> Set(source anchors)
  for (const w of worlds.values()) {
    const from = anchorOf(w);
    for (const portal of w.portalsRaw || []) {
      if (portal.kind === 'domain' && portal.to && portal.to !== from) {
        if (!sources.has(portal.to)) sources.set(portal.to, new Set());
        sources.get(portal.to).add(from);
      }
    }
  }
  inboundCounts = new Map([...sources].map(([to, set]) => [to, set.size]));
}

function inboundCountFor(world) { return inboundCounts.get(anchorOf(world)) || 0; }

// ---------- safe fetching ----------

// Addresses a public directory must never contact: loopback, private, link-local, shared, documentation,
// multicast and reserved ranges, and IPv6 forms that carry an IPv4 address.
function isPublicAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]);
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if (lower === '::' || lower === '::1') return false;
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (lower.startsWith('2001:db8') || lower.startsWith('2001:0db8')) return false;
    if (lower.startsWith('64:ff9b') || first === 0x2002 || lower.startsWith('2001:0:') || lower.startsWith('2001::')) return false;
    return true;
  }
  return false;
}

function isLocalHostName(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

// The URL rules, before any network use. Throws a plain-language reason.
function checkUrl(urlText) {
  let u;
  try { u = new URL(urlText); } catch { throw new Error('not a valid URL'); }
  if (u.username || u.password) throw new Error('a manifest URL cannot carry credentials');
  if (u.hash) throw new Error('a manifest URL cannot carry a fragment');
  if (ALLOW_LOCAL) {
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHostName(u.hostname))) throw new Error('only https is accepted (SPEC.md §3.6.1)');
    return u;
  }
  if (u.protocol !== 'https:') throw new Error('only https is accepted (SPEC.md §3.6.1)');
  if (u.port && u.port !== '443') throw new Error('only the default https port is accepted');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) throw new Error('a manifest must be served from a host name, not an address');
  if (!host.includes('.') || isLocalHostName(host)) throw new Error('not a public host name');
  return u;
}

// Resolves a host name and refuses it when any address it points at is not public. Used as the
// socket's own lookup, so the address that is checked is the address that is connected to.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length) return callback(new Error('host name did not resolve'));
    if (!ALLOW_LOCAL && addresses.some((a) => !isPublicAddress(a.address))) return callback(new Error('host resolves to a non-public address'));
    if (options && options.all) return callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

// GET a JSON document: no redirects, a time limit, a size limit enforced while the body streams in.
function fetchJson(urlText) {
  const u = checkUrl(urlText);
  const transport = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(u, { method: 'GET', lookup: guardedLookup, headers: { Accept: 'application/json', 'User-Agent': 'domain-atlas-directory/2' }, timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return reject(new Error('redirects are not followed')); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const declared = Number(res.headers['content-length']);
      if (declared > MAX_MANIFEST_BYTES) { res.destroy(); return reject(new Error('manifest is larger than ' + MAX_MANIFEST_BYTES + ' bytes')); }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_MANIFEST_BYTES) { res.destroy(); reject(new Error('manifest is larger than ' + MAX_MANIFEST_BYTES + ' bytes')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('manifest is not valid JSON')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('the host did not answer in time')));
    req.on('error', reject);
    req.end();
  });
}

// ---------- reading a manifest ----------

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function normalizeHost(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\.$/, '') : '';
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return 'not a JSON object';
  if (typeof manifest.spec !== 'string' || !manifest.spec.startsWith('domain-atlas/')) return 'missing or unrecognized "spec"';
  if (!Array.isArray(manifest.worlds)) return 'missing "worlds" array';
  const hasDomain = typeof manifest.domain === 'string' && manifest.domain;
  const hasKey = typeof manifest.identityKey === 'string' && manifest.identityKey;
  // SPEC.md §3.7: a domain-anchored manifest MAY also carry a pinned identityKey. Neither is invalid.
  if (!hasDomain && !hasKey) return 'manifest must have at least one of "domain" or "identityKey"';
  return null;
}

// SPEC.md §3.4.1: a world's own value wins outright, including an empty array or an explicit false;
// the manifest's top-level value fills in only when the world's policy does not carry the field.
function effectivePolicyField(manifest, world, field) {
  const policy = world.policy || {};
  return policy[field] !== undefined ? policy[field] : manifest[field];
}

function indexWorld(manifest, world, anchorType, anchorKey, pinnedIdentityKey, url) {
  const policy = world.policy || {};
  const profile = world.profile || {};
  const accepted = effectivePolicyField(manifest, world, 'acceptedItemClasses');
  const portals = (Array.isArray(world.portals) ? world.portals : []).slice(0, MAX_PORTALS_PER_WORLD)
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({ kind: str(p.kind, 20), to: p.kind === 'domain' ? normalizeHost(p.to) || str(p.to, 300) : null }));
  const caps = profile.capabilities && typeof profile.capabilities === 'object' ? profile.capabilities : null;
  return {
    worldKey: `${anchorType}:${anchorKey}:${String(world.id).slice(0, 80)}`,
    anchorType,
    domain: anchorType === 'domain' ? anchorKey : null,
    identityKey: anchorType === 'key' ? anchorKey : pinnedIdentityKey,
    worldId: String(world.id).slice(0, 80),
    name: str(world.name, 120) || String(world.id).slice(0, 80),
    description: str(world.description, 300) || str(profile.description, 300),
    ownerName: str(manifest.owner && manifest.owner.name, 120),
    genre: str(profile.genre, 80),
    scale: str(profile.scale, 20),
    capabilities: caps ? { combat: str(caps.combat, 10), building: str(caps.building, 20), vehicles: caps.vehicles === true, landOwnership: caps.landOwnership === true } : null,
    guestAccess: str(policy.guestAccess, 20),
    identityRequired: !!effectivePolicyField(manifest, world, 'identityRequired'),
    itemDropsAllowed: !!policy.itemDropsAllowed,
    acceptedItemClasses: Array.isArray(accepted) ? accepted.filter((c) => typeof c === 'string').slice(0, 50).map((c) => c.slice(0, 80)) : [],
    trustedIssuers: policy.trustedIssuers === 'any' || policy.trustedIssuers === 'self' ? policy.trustedIssuers
      : Array.isArray(policy.trustedIssuers) ? policy.trustedIssuers.filter((d) => typeof d === 'string').slice(0, 50).map((d) => d.slice(0, 253)) : null,
    portalsRaw: portals,
    manifestUrl: url,
    indexedAt: new Date().toISOString()
  };
}

// Fetches, validates and (re)indexes one manifest. Shared by /submit (first crawl, synchronous so the
// submitter sees a real result) and the scheduler.
async function crawlOne(url) {
  const record = manifests.get(url);
  try {
    const parsed = checkUrl(url);
    const manifest = await fetchJson(url);
    const shapeError = validateManifestShape(manifest);
    if (shapeError) throw new Error(shapeError);

    const anchorType = manifest.domain ? 'domain' : 'key';
    const anchorKey = anchorType === 'domain' ? normalizeHost(manifest.domain) : manifest.identityKey;

    if (BLOCKED.has(String(anchorKey).toLowerCase())) { dropManifest(url); throw new Error('this directory does not list that site'); }

    if (anchorType === 'domain') {
      // The listing is for the host that served the manifest, never for a name the manifest merely claims.
      if (normalizeHost(parsed.host) !== anchorKey) throw new Error('the manifest names domain "' + String(manifest.domain).slice(0, 100) + '" but was served from ' + parsed.host);
      if (parsed.pathname !== WELL_KNOWN_PATH || parsed.search) throw new Error('a domain-anchored manifest is read from ' + WELL_KNOWN_PATH);
    } else if (!(await verifyKeyAnchoredManifest(manifest))) {
      throw new Error('key-anchored manifest signature does not verify against its own identityKey');
    }

    // SPEC.md §3.7: an optional identityKey pin on a domain-anchored manifest. A pin that does not
    // verify is ignored, never a reason to reject the manifest.
    let pinnedIdentityKey = null;
    if (anchorType === 'domain' && typeof manifest.identityKey === 'string' && manifest.identityKey && await verifyKeyAnchoredManifest(manifest)) {
      pinnedIdentityKey = manifest.identityKey;
    }

    // A world that was discoverable last crawl and is not now must not linger.
    for (const [key, w] of worlds) {
      if (w.anchorType === anchorType && anchorOf(w) === anchorKey) worlds.delete(key);
    }

    let indexed = 0;
    for (const world of manifest.worlds.slice(0, MAX_WORLDS_PER_MANIFEST)) {
      if (!world || typeof world !== 'object' || typeof world.id !== 'string' || !world.id) continue;
      if (!world.policy || world.policy.discoverable !== true) continue; // §3: discoverable is what makes a world directory-eligible
      const entry = indexWorld(manifest, world, anchorType, anchorKey, pinnedIdentityKey, url);
      worlds.set(entry.worldKey, entry);
      indexed++;
    }

    manifests.set(url, {
      ...(record || { url, submittedAt: new Date().toISOString() }),
      url,
      anchorType,
      anchorKey,
      lastCrawledAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(), // only a fetched and validated manifest sets this; a failed crawl keeps the old value
      nextCrawlAt: Date.now() + CRAWL_INTERVAL_MS,
      status: 'ok',
      lastError: undefined,
      consecutiveFailures: 0,
      manifestUpdatedAt: str(manifest.updated, 40)
    });

    rebuildTokenIndex();
    rebuildLinkGraph();
    return { ok: true, worldsIndexed: indexed };
  } catch (err) {
    const failures = ((record && record.consecutiveFailures) || 0) + 1;
    const firstTime = !record || !record.lastCrawledAt || record.status === 'pending';
    // A submission that never worked leaves nothing behind, so junk URLs do not pile up.
    if (firstTime || failures >= DROP_AFTER_FAILURES) {
      dropManifest(url);
      return { ok: false, error: err.message };
    }
    const backoff = Math.min(CRAWL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
    manifests.set(url, {
      ...record,
      url,
      lastCrawledAt: new Date().toISOString(),
      nextCrawlAt: Date.now() + backoff,
      status: 'error',
      lastError: String(err.message).slice(0, 200),
      consecutiveFailures: failures
    });
    return { ok: false, error: err.message };
  }
}

function dropManifest(url) {
  const record = manifests.get(url);
  manifests.delete(url);
  if (record && record.anchorKey) {
    for (const [key, w] of worlds) {
      if (w.manifestUrl === url) worlds.delete(key);
    }
    rebuildTokenIndex();
    rebuildLinkGraph();
  }
}

// One crawl per URL at a time: a second submit of the same address while the first is running shares its result.
const inFlight = new Map();
function crawlShared(url) {
  if (!inFlight.has(url)) inFlight.set(url, crawlOne(url).finally(() => inFlight.delete(url)));
  return inFlight.get(url);
}

// ---------- background crawl scheduler ----------
function startScheduler() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const due = [...manifests.values()].filter((m) => m.nextCrawlAt <= Date.now()).map((m) => m.url);
      for (let i = 0; i < due.length; i += MAX_CONCURRENT_CRAWLS) {
        await Promise.all(due.slice(i, i + MAX_CONCURRENT_CRAWLS).map((url) => crawlShared(url)));
      }
      if (due.length) saveSnapshot();
    } finally {
      running = false;
    }
  }, SCHEDULER_TICK_MS).unref();
}

// ---------- search ----------
function matchesFilters(w, f) {
  if (f.genre && !(w.genre || '').toLowerCase().includes(f.genre.toLowerCase())) return false;
  if (f.scale && w.scale !== f.scale) return false;
  if (f.combat && (!w.capabilities || w.capabilities.combat !== f.combat)) return false;
  if (f.domain && w.domain !== normalizeHost(f.domain)) return false;
  if (f.anchorType && w.anchorType !== f.anchorType) return false;
  if (f.identityRequired === 'true' && !w.identityRequired) return false;
  if (f.identityRequired === 'false' && w.identityRequired) return false;
  return true;
}

function search(params) {
  const candidates = [...worlds.values()].filter((w) => matchesFilters(w, params));
  let scored;
  if (params.q && params.q.trim()) {
    const qTokens = tokenize(params.q);
    scored = candidates
      .map((w) => ({ w, matched: qTokens.filter((t) => tokenIndex.has(t) && tokenIndex.get(t).has(w.worldKey)).length }))
      .filter((r) => r.matched > 0)
      .sort((a, b) => (b.matched - a.matched) || (inboundCountFor(b.w) - inboundCountFor(a.w)) || a.w.name.localeCompare(b.w.name) || (a.w.worldKey < b.w.worldKey ? -1 : a.w.worldKey > b.w.worldKey ? 1 : 0));
  } else {
    scored = candidates.map((w) => ({ w })).sort((a, b) => (inboundCountFor(b.w) - inboundCountFor(a.w)) || a.w.name.localeCompare(b.w.name) || (a.w.worldKey < b.w.worldKey ? -1 : a.w.worldKey > b.w.worldKey ? 1 : 0));
  }
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
  if (params.groupBy === 'site') return searchBySite(scored, limit, offset);
  const page = scored.slice(offset, offset + limit).map(({ w }) => worldResult(w));
  return { count: scored.length, limit, offset, results: page };
}
function worldResult(w) {
  const m = manifests.get(w.manifestUrl);
  return {
    anchorType: w.anchorType,
    domain: w.domain,
    identityKey: w.identityKey,
    worldId: w.worldId,
    name: w.name,
    description: w.description,
    ownerName: w.ownerName,
    genre: w.genre,
    scale: w.scale,
    capabilities: w.capabilities,
    guestAccess: w.guestAccess,
    identityRequired: w.identityRequired,
    acceptedItemClasses: w.acceptedItemClasses,
    portals: w.portalsRaw,
    manifestUrl: w.manifestUrl,
    inboundPortalCount: inboundCountFor(w),
    stale: !!(m && m.consecutiveFailures >= STALE_AFTER_FAILURES)
  };
}
// groupBy=site: the same matches, grouped under the site that published them (its domain, or for a key-anchored manifest its
// verified identity key). Groups are paged, not worlds, and worldCount is the number of matching worlds in all groups, so
// the counts stay right however many pages there are.
function searchBySite(scored, limit, offset) {
  const groups = new Map();
  for (const { w, matched } of scored) {
    const anchor = anchorOf(w);
    let g = groups.get(anchor);
    if (!g) {
      g = { anchorType: w.anchorType, domain: w.domain, identityKey: w.identityKey, ownerName: w.ownerName, anchor, matched: matched || 0, worlds: [] };
      groups.set(anchor, g);
    }
    if (!g.identityKey && w.identityKey) g.identityKey = w.identityKey;
    if (!g.ownerName && w.ownerName) g.ownerName = w.ownerName;
    g.matched = Math.max(g.matched, matched || 0);
    g.worlds.push(w);
  }
  const ordered = [...groups.values()].sort((a, b) => (b.matched - a.matched) || (inboundCountFor(b.worlds[0]) - inboundCountFor(a.worlds[0])) || a.anchor.toLowerCase().localeCompare(b.anchor.toLowerCase()) || (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0));
  const page = ordered.slice(offset, offset + limit).map((g) => {
    const results = g.worlds.map(worldResult);
    const distinct = (field) => [...new Set(g.worlds.map((w) => w[field]).filter(Boolean))];
    // The newest successful check among the manifests this site's worlds came from (UTC, to the second).
    let seen = 0;
    for (const w of g.worlds) {
      const t = Date.parse((manifests.get(w.manifestUrl) || {}).lastSuccessAt);
      if (t > seen) seen = t;
    }
    return {
      anchorType: g.anchorType, domain: g.domain, identityKey: g.identityKey, ownerName: g.ownerName,
      worldCount: g.worlds.length, genres: distinct('genre').slice(0, 5), scales: distinct('scale'),
      inboundPortalCount: inboundCountFor(g.worlds[0]), stale: results.some((r) => r.stale),
      lastSeenAt: seen ? new Date(seen).toISOString().replace(/\.\d+Z$/, 'Z') : null, worlds: results
    };
  });
  return { count: ordered.length, worldCount: scored.length, limit, offset, groups: page };
}

// ---------- HTTP layer ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (over) return; // keep draining so the 413 can be delivered, but store nothing more
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) { over = true; chunks.length = 0; reject(new HttpError(413, 'request body is too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

function sendJson(res, status, obj, extra) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...CORS, ...(extra || {}) });
  res.end(JSON.stringify(obj));
}

// Only the search page is served; nothing else in this folder is reachable over HTTP.
function serveIndex(res) {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'" });
    res.end(data);
  });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

const submitLog = new Map(); // ip -> timestamps within the last hour
function submitAllowed(ip) {
  const now = Date.now();
  const recent = (submitLog.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= SUBMITS_PER_HOUR) { submitLog.set(ip, recent); return false; }
  recent.push(now);
  submitLog.set(ip, recent);
  if (submitLog.size > 5000) for (const [k, v] of submitLog) { if (!v.some((t) => now - t < 3_600_000)) submitLog.delete(k); }
  return true;
}

async function handleSubmit(req, res) {
  const ip = clientIp(req);
  if (!submitAllowed(ip)) return sendJson(res, 429, { error: 'too many submissions from this address; try again later' }, { 'Retry-After': '3600' });
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch (err) {
    if (err instanceof HttpError) throw err;
    return sendJson(res, 400, { error: 'the request body must be JSON' });
  }
  const manifestUrl = body && body.manifest;
  if (!manifestUrl || typeof manifestUrl !== 'string' || manifestUrl.length > 2000) return sendJson(res, 400, { error: 'manifest (URL string) is required' });
  try { checkUrl(manifestUrl); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  if (!manifests.has(manifestUrl) && manifests.size >= MAX_MANIFESTS) return sendJson(res, 503, { error: 'this directory is not accepting new manifests right now' });

  if (!manifests.has(manifestUrl)) {
    manifests.set(manifestUrl, { url: manifestUrl, submittedAt: new Date().toISOString(), nextCrawlAt: Date.now() + CRAWL_INTERVAL_MS, consecutiveFailures: 0, status: 'pending' });
  }
  const result = await crawlShared(manifestUrl);
  saveSnapshot();
  if (!result.ok) return sendJson(res, 422, { error: result.error });
  return sendJson(res, 200, { indexed: result.worldsIndexed, manifest: manifestUrl });
}

async function main() {
  loadSnapshot();
  rebuildTokenIndex();
  rebuildLinkGraph();
  startScheduler();

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'POST' && url.pathname === '/submit') return await handleSubmit(req, res);

      if (req.method === 'GET' && url.pathname === '/search') {
        const q = url.searchParams;
        return sendJson(res, 200, search({
          q: (q.get('q') || '').slice(0, 200), genre: q.get('genre'), scale: q.get('scale'), combat: q.get('combat'), domain: q.get('domain'),
          anchorType: q.get('anchorType'), identityRequired: q.get('identityRequired'), limit: q.get('limit'), offset: q.get('offset'), groupBy: q.get('groupBy')
        }));
      }

      if (req.method === 'GET' && url.pathname === '/stats') {
        return sendJson(res, 200, { manifestsTracked: manifests.size, worldsIndexed: worlds.size, crawlIntervalMs: CRAWL_INTERVAL_MS });
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveIndex(res);

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, { Connection: 'close' });
      console.error(err);
      return sendJson(res, 500, { error: 'internal error' });
    }
  });

  server.listen(PORT, () => {
    console.log(`Directory service listening on http://localhost:${PORT}`);
    console.log(`Crawl interval: ${CRAWL_INTERVAL_MS}ms - scheduler tick: ${SCHEDULER_TICK_MS}ms${ALLOW_LOCAL ? ' - local hosts allowed (demo mode)' : ''}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { isPublicAddress, checkUrl, canonicalize };
