// The wallet's side of Services: a per-identity list of domains the person chose to add, what each domain advertises in its
// manifest (SPEC.md §3.9), which of the person's credentials belong to which service, whether each service is switched on,
// and a status that says what the wallet actually knows about it.
//
// Adding a domain is the only thing that stores a domain. Discovery reads one public file and changes nothing; it never sends
// the wallet's identity or credentials, never enables a service and never registers anyone. The wallet owns every screen: a
// domain supplies service names from a fixed table, validated addresses and nothing else.
//
// Nothing here touches the page, extension storage or the network by itself: everything it needs is passed to create(), so the
// same code runs in the wallet page, in the tests and in a standalone wallet.
//   env.fetch(url, init)            like fetch
//   env.loadState() / saveState(s)  the saved state (encrypted by the wallet, part of the backup); null when none
//   env.ownerKey()                  async; the active identity's public key, or null
//   env.entries()                   async; the active identity's held credentials: [{credential, lastVerdict, spent, ...}]
//   env.now()                       milliseconds
//   env.origin(domain)              the address of a domain (throws for a domain that may not be reached)
//   env.normalizeDomain(input)      the domain in its canonical spelling, or null
//
// One file, loaded as a script (global AtlasServices) by the wallet pages, and required as a module by the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtlasServices = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREVIEW_FOR_MS = 5 * 60 * 1000;
  const MAX_ISSUED = 8;
  const MAX_DOMAINS = 50;
  const MAX_BODY_CHARS = 262144;
  const TIMEOUT_MS = 8000;
  const FRESH_FOR_MS = 24 * 60 * 60 * 1000; // an outcome older than this is not evidence that the service works now
  const MAX_URL_CHARS = 300;
  const MAX_REASON_CHARS = 160;
  const WELL_KNOWN = '/.well-known/spatial.json';

  // The names SPEC.md §3.9 lets a manifest advertise. The reference directory keeps the same table
  // (directory-server/server.js SERVICE_TYPES); test/services-core.js compares the two.
  const SERVICE_TYPES = [
    { key: 'postOffice', label: 'Global Mail', category: 'communication' },
    { key: 'mailRelay', label: 'Mail Relay', category: 'communication' },
    { key: 'chat', label: 'Site chat', category: 'communication' },
    { key: 'inWorldChat', label: 'In-world chat', category: 'communication' },
    { key: 'voiceCalling', label: 'Voice calling', category: 'communication' },
    { key: 'assetStudio', label: 'Asset Studio', category: 'assets' },
    { key: 'chainLabs', label: 'Chain Labs', category: 'ledger', aliases: ['chainlabs'] },
    { key: 'scanner', label: 'Scanner', category: 'ledger' },
    { key: 'tradingStation', label: 'Trading Station', category: 'trading', aliases: ['trading'] },
    { key: 'directory', label: 'Directory', category: 'directory' },
    { key: 'calendar', label: 'Calendar', category: 'other' }
  ];

  // General domain membership. A manifest can announce it as `domainMembership` (SPEC.md §3.9); domains that have not, and
  // every domain for a person who already holds the card, still get it from the card alone: holding the domain's membership
  // card is the subscription (SPEC.md §11.1).
  const MEMBERSHIP = { key: 'membership', label: 'Domain Membership', category: 'communication', manifestName: 'domainMembership', implicit: true };

  // What the wallet can do for a service itself. A service that is not listed here is shown honestly as not used from here.
  //   credentialClass  the credential that proves the person joined
  //   check            which recorded outcome says the service works: 'mail' (a mail check) or 'listings' (a read of the listings)
  const OPERATES = Object.assign(Object.create(null), {
    postOffice: { credentialClass: 'atlas.postoffice.membership', check: 'mail' },
    tradingStation: { credentialClass: 'atlas.tradingstation.membership', check: 'listings' },
    membership: { credentialClass: 'atlas.membership', check: 'mail' }
  });
  // Looked up with class names that come from credentials, so no inherited name can ever match.
  const CREDENTIAL_CLASSES = Object.create(null);
  Object.keys(OPERATES).forEach((k) => { (CREDENTIAL_CLASSES[OPERATES[k].credentialClass] = CREDENTIAL_CLASSES[OPERATES[k].credentialClass] || []).push(k); });

  const TYPE_BY_KEY = new Map(SERVICE_TYPES.concat([MEMBERSHIP]).map((t, i) => [t.key, Object.assign({ order: i }, t)]));

  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function iso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  // ---------- domains ----------

  // A public name (a dotted name whose last label starts with a letter, so no address literal passes) or localhost, with an
  // optional port. The wallet passes its own, stricter rules; this is what a standalone wallet gets without any.
  const DEFAULT_DOMAIN_RE = /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z][a-z0-9-]{0,61}[a-z0-9])(?::([1-9]\d{0,4}))?$/;
  function defaultNormalizeDomain(input) {
    if (typeof input !== 'string') return null;
    const d = input.trim().toLowerCase();
    const m = d.length <= 260 ? DEFAULT_DOMAIN_RE.exec(d) : null;
    return m && (m[1] === undefined || Number(m[1]) <= 65535) ? d : null;
  }

  // ---------- reading a manifest ----------

  // Names that appear twice at the top level of the manifest text. JSON.parse keeps the last one silently, so a manifest that
  // names `walletBridge` twice would mean different things to a reader that kept the first.
  function topLevelDuplicateKeys(text) {
    const seen = new Set();
    const dupes = new Set();
    let depth = 0, expectKey = false, i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (ch === '"') {
        let j = i + 1, out = '';
        while (j < n && text[j] !== '"') { if (text[j] === '\\') { out += text.slice(j, j + 2); j += 2; } else { out += text[j]; j++; } }
        if (depth === 1 && expectKey) {
          expectKey = false;
          if (seen.has(out)) dupes.add(out); else seen.add(out);
        }
        i = j + 1;
        continue;
      }
      if (ch === '{') { depth++; if (depth === 1) expectKey = true; } else if (ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      else if (ch === ',' && depth === 1) expectKey = true;
      i++;
    }
    return Array.from(dupes);
  }

  // A service address the wallet may show or open: on the manifest's own domain (or a subdomain), the same scheme as the
  // domain is reached with, no login details, no fragment, URL-safe characters. A path on the domain ("/atlas/studio/") is
  // accepted and resolved against it. Returns the address, or null.
  function safeServiceUrl(value, baseOrigin) {
    if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS) return null;
    if (/[\u0000- \u007f\\]/.test(value) || value.indexOf('#') !== -1) return null;
    let base;
    try { base = new URL(baseOrigin); } catch (err) { return null; }
    let u;
    try {
      if (value[0] === '/') {
        if (value[1] === '/') return null;
        u = new URL(value, base.origin);
      } else u = new URL(value);
    } catch (err) { return null; }
    if (u.protocol !== base.protocol || u.username || u.password || u.hash) return null;
    if (u.port !== base.port) return null;
    const host = u.hostname.toLowerCase(), want = base.hostname.toLowerCase();
    if (host !== want && !host.endsWith('.' + want)) return null;
    return u.href;
  }

  // A credential class as a manifest names it: dotted lower-case words, no longer than any real class.
  const CLASS_RE = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*){1,6}$/;
  function validClass(v) { return typeof v === 'string' && v.length <= 128 && CLASS_RE.test(v); }

  // Which credential a service needs, if any. A manifest names it (`requiresCredential: true` with a `credentialClass`) but only
  // describes what the domain asks for: it never says a credential is valid, and it cannot change which credential the wallet
  // withholds for a service the wallet runs itself. For those three the wallet's own class stands, which is also what a domain
  // that has not added the descriptor gets. A declared class on any other service only says what card it needs.
  //   returns { class, source: 'known' | 'manifest' } or null (a service that needs no card is not listed in Services)
  function credentialNeed(key, declared, warnings) {
    const known = OPERATES[key] ? OPERATES[key].credentialClass : null;
    let named = null;
    if (isObject(declared) && declared.requiresCredential === true) {
      if (validClass(declared.credentialClass)) named = declared.credentialClass;
      else warnings.push('credential-descriptor-ignored:' + key);
    }
    if (known) {
      if (named && named !== known) warnings.push('credential-class-ignored:' + key);
      return { class: known, source: named === known ? 'manifest' : 'known' };
    }
    return named ? { class: named, source: 'manifest' } : null;
  }

  // What a domain's manifest advertises, as the wallet will show it. `manifest` is whatever the domain served: it is only read,
  // never trusted for which domain it describes (that is the domain it was fetched from).
  function readServices(domain, manifest, baseOrigin, normalize) {
    const warnings = [];
    if (!isObject(manifest)) return { problem: 'bad-manifest', text: 'That domain\'s manifest is not a JSON object.', warnings };
    if (typeof manifest.domain !== 'string' || !manifest.domain) return { problem: 'no-domain', text: 'That manifest does not name a domain, so it cannot be added.', warnings };
    const claimed = normalize(manifest.domain);
    if (claimed !== domain) return { problem: 'domain-mismatch', text: 'That manifest was served by ' + domain + ' but says it belongs to a different domain, so it was not used.', warnings };
    const services = [];
    for (const type of SERVICE_TYPES.concat([MEMBERSHIP])) {
      const name = [type.manifestName || type.key].concat(type.aliases || []).find((n) => Object.prototype.hasOwnProperty.call(manifest, n));
      if (name === undefined) continue;
      const declared = manifest[name];
      let url = null;
      if (declared === true) { /* advertised, no page */ }
      else if (isObject(declared) && declared.enabled === true) {
        if (declared.url !== undefined) {
          url = safeServiceUrl(declared.url, baseOrigin);
          if (!url) warnings.push('url-ignored:' + type.key);
        }
      } else continue;
      services.push({ key: type.key, label: type.label, category: type.category, url, credential: credentialNeed(type.key, declared, warnings) });
    }
    return { problem: null, services, warnings };
  }

  async function readCapped(res, max) {
    const length = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (Number.isFinite(length) && length > max) return null;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) { try { await reader.cancel(); } catch (err) { /* already closed */ } return null; }
        chunks.push(value);
      }
      const all = new Uint8Array(size);
      let at = 0;
      chunks.forEach((c) => { all.set(c, at); at += c.length; });
      return new TextDecoder().decode(all);
    }
    const text = await res.text();
    return typeof text === 'string' && text.length <= max ? text : null;
  }

  // ---------- saved state ----------

  function emptyState() { return { version: 1, domains: [], enabled: {}, manifests: {}, outcomes: {} }; }

  const KEY_SEP = '|';
  function settingKey(domain, key) { return domain + KEY_SEP + key; }

  // The state as it is read back: anything that is not the expected shape is dropped rather than trusted.
  function normalizeState(raw, normalize) {
    const s = emptyState();
    if (!isObject(raw)) return s;
    if (Array.isArray(raw.domains)) {
      for (const d of raw.domains) {
        const domain = isObject(d) && normalize(d.domain);
        if (!domain || s.domains.some((x) => x.domain === domain) || s.domains.length >= MAX_DOMAINS) continue;
        s.domains.push({ domain, addedAt: typeof d.addedAt === 'string' ? d.addedAt : null });
      }
    }
    const listed = new Set(s.domains.map((d) => d.domain));
    const split = (k) => { const at = k.lastIndexOf(KEY_SEP); return at > 0 ? [k.slice(0, at), k.slice(at + 1)] : [null, null]; };
    if (isObject(raw.enabled)) {
      for (const k of Object.keys(raw.enabled)) {
        const [domain, key] = split(k);
        if (listed.has(domain) && TYPE_BY_KEY.has(key) && typeof raw.enabled[k] === 'boolean') s.enabled[k] = raw.enabled[k];
      }
    }
    if (isObject(raw.manifests)) {
      for (const domain of Object.keys(raw.manifests)) {
        const m = raw.manifests[domain];
        if (!listed.has(domain) || !isObject(m) || !Array.isArray(m.services)) continue;
        // A service is kept only when it needs a membership card: one the wallet knows, or one whose class was read from a manifest.
        // Whatever an earlier build saved for services without one is dropped here, so it never comes back into the tab.
        const services = [];
        m.services.forEach((x) => {
          if (!isObject(x) || !TYPE_BY_KEY.has(x.key) || services.some((y) => y.key === x.key)) return;
          const type = TYPE_BY_KEY.get(x.key);
          const own = OPERATES[x.key] ? { class: OPERATES[x.key].credentialClass, source: 'known' } : null;
          const declared = !own && isObject(x.credential) && validClass(x.credential.class) ? { class: x.credential.class, source: 'manifest' } : null;
          const credential = own || declared;
          if (!credential) return;
          services.push({ key: x.key, label: type.label, category: type.category, url: typeof x.url === 'string' && x.url.length <= MAX_URL_CHARS ? x.url : null, credential });
        });
        s.manifests[domain] = {
          fetchedAt: Number.isFinite(m.fetchedAt) ? m.fetchedAt : null,
          services,
          warnings: Array.isArray(m.warnings) ? m.warnings.filter((w) => typeof w === 'string').slice(0, 20).map((w) => w.slice(0, 60)) : [],
          problem: typeof m.problem === 'string' ? m.problem.slice(0, MAX_REASON_CHARS) : null
        };
      }
    }
    if (isObject(raw.outcomes)) {
      for (const k of Object.keys(raw.outcomes)) {
        const [domain, kind] = split(k);
        const o = raw.outcomes[k];
        if (listed.has(domain) && (kind === 'mail' || kind === 'listings') && isObject(o) && typeof o.ok === 'boolean' && Number.isFinite(o.at)) {
          s.outcomes[k] = { ok: o.ok, at: o.at, reason: typeof o.reason === 'string' ? o.reason.slice(0, MAX_REASON_CHARS) : '' };
        }
      }
    }
    return s;
  }

  // Whether a service is on. A choice the person made always wins. With none, a service the person already uses by holding its
  // credential stays on, so nobody's mail stops because this tab now exists; a service with no credential is off, so adding a
  // domain never starts anything by itself.
  function resolveEnabled(state, domain, key, holdsCredential) {
    const explicit = state.enabled[settingKey(domain, key)];
    if (typeof explicit === 'boolean') return explicit;
    return !!OPERATES[key] && !!holdsCredential;
  }

  // ---------- credentials ----------

  function credentialState(entry, nowMs) {
    const c = entry && entry.credential;
    if (!c || !c.asset) return 'invalid';
    if (entry.spent) return 'spent';
    const v = entry.lastVerdict;
    if (v && v.status === 'revoked') return 'revoked';
    if (v && v.status === 'expired') return 'expired';
    const expires = c.asset.expiresAt ? Date.parse(c.asset.expiresAt) : NaN;
    if (Number.isFinite(expires) && expires <= nowMs) return 'expired';
    if (v && v.status === 'invalid') return 'invalid';
    if (entry.pendingOutcome) return 'pending';
    if (v && v.valid === true) return 'valid';
    return 'unverified';
  }

  // The held credentials that belong to `key` at `domain`, each with the state the wallet last saw.
  // `credentialClass` is given for a service whose card the manifest named; the wallet's own services use their own class.
  // Only a card this domain issued counts, and one that names another owner than `ownerKey` does not verify as the person's.
  function credentialsFor(entries, domain, key, normalize, nowMs, credentialClass, ownerKey) {
    const cls = OPERATES[key] ? OPERATES[key].credentialClass : credentialClass;
    if (!cls) return [];
    return (entries || []).filter((e) => e && e.credential && e.credential.asset && e.credential.asset.class === cls
      && e.credential.issuer && normalize(e.credential.issuer.domain) === domain)
      .map((e) => {
        const owner = e.credential.owner && e.credential.owner.publicKey;
        const wrongOwner = !!ownerKey && typeof owner === 'string' && owner !== ownerKey;
        return { id: e.credential.id, state: wrongOwner ? 'invalid' : credentialState(e, nowMs), entry: e };
      });
  }

  const CREDENTIAL_PROBLEM = {
    revoked: 'The domain has revoked your membership card.',
    expired: 'Your membership card has expired.',
    spent: 'Your membership card has been used up or marked spent by the domain.',
    invalid: 'Your membership card does not verify.'
  };

  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return 'a moment ago';
    if (s < 5400) return Math.round(s / 60) + ' minutes ago';
    if (s < 129600) return Math.round(s / 3600) + ' hours ago';
    return Math.round(s / 86400) + ' days ago';
  }

  // What the wallet knows about a service, in four states. Switching a service on never makes it active: that takes a credential
  // that verifies and a recent check or operation that worked.
  //   active (green) · disabled (amber) · problem (red) · unknown (grey)
  function computeStatus(input) {
    const { key, advertised, explicit, enabled, credentials, outcome, nowMs } = input;
    const out = (state, code, label, text, extra) => Object.assign({ state, code, label, text, checkedAt: null, stale: false }, extra || {});
    if (!OPERATES[key]) {
      if (!input.credentialClass) {
        return out('unknown', 'unsupported', 'Not used from here',
          advertised ? 'This domain advertises it, but this wallet has no way to use it from here yet.' : 'This wallet has no way to use this service from here yet.');
      }
      // A service the manifest says needs a card, which this wallet does not run: the card's own state is shown, never a green.
      if (!credentials.length) return out('unknown', 'needs-credential', 'Not set up', 'This domain says it needs a membership card. You do not hold one, and this wallet cannot join it from here yet.');
      const badCard = credentials.find((c) => CREDENTIAL_PROBLEM[c.state]);
      if (badCard && !credentials.some((c) => c.state === 'valid')) return out('problem', 'credential-' + badCard.state, 'Problem', CREDENTIAL_PROBLEM[badCard.state]);
      return out('unknown', 'unsupported', 'Not used from here', 'You hold the card for it, but this wallet has no way to use this service from here yet.');
    }
    if (explicit === false) return out('disabled', 'disabled', 'Disabled', 'You turned this off. The wallet does not contact this domain for it in the background.');
    const usable = credentials.filter((c) => c.state === 'valid');
    if (!credentials.length) {
      return out('unknown', 'not-joined', 'Not set up', enabled ? 'It is switched on, but you have not joined yet, so there is nothing to check.' : 'You have not joined this service at this domain.');
    }
    if (!usable.length) {
      const bad = credentials.find((c) => CREDENTIAL_PROBLEM[c.state]);
      if (bad) return out('problem', 'credential-' + bad.state, 'Problem', CREDENTIAL_PROBLEM[bad.state]);
      return out('unknown', 'credential-unverified', 'Unknown', 'The wallet has not been able to verify your membership card yet. Verifying it again may settle this.');
    }
    if (!outcome) return out('unknown', 'unconfirmed', 'Unknown', 'Your card is valid, but the wallet has not confirmed that the service answers. Use Check now.');
    const age = nowMs - outcome.at;
    if (age > FRESH_FOR_MS) {
      return out('unknown', 'stale', 'Unknown', 'The last check was ' + ago(age) + ' (' + (outcome.ok ? 'it worked' : 'it failed') + '), which is too old to rely on. Use Check now.', { checkedAt: outcome.at, stale: true });
    }
    if (!outcome.ok) return out('problem', 'check-failed', 'Problem', 'The last check ' + ago(age) + ' failed' + (outcome.reason ? ': ' + outcome.reason : '') + '.', { checkedAt: outcome.at });
    if (!enabled) return out('unknown', 'not-enabled', 'Not set up', 'Your card is valid and the domain answered, but this service is not switched on.', { checkedAt: outcome.at });
    return out('active', 'active', 'Active and working', 'Your card verifies and the domain answered ' + ago(age) + '.', { checkedAt: outcome.at });
  }

  // ---------- the module ----------

  function create(env) {
    const issued = new Map();
    const nowMs = () => (env.now ? env.now() : Date.now());
    const normalize = (input) => (env.normalizeDomain ? env.normalizeDomain(input) : defaultNormalizeDomain(input));
    const origin = (domain) => (env.origin ? env.origin(domain) : 'https://' + domain);

    // Changes are made one at a time, each on what the one before left. `ownerKey`, when given, names the identity the change
    // is for; a change begun for one identity is refused rather than applied to another after a switch.
    let queue = Promise.resolve();
    function serial(fn) {
      const run = queue.then(fn, fn);
      queue = run.then(() => undefined, () => undefined);
      return run;
    }
    function identityChanged() { return Object.assign(new Error('The wallet is acting as a different identity now.'), { code: 'identity-changed' }); }
    function fail(code, text) { return Object.assign(new Error(text), { code }); }

    async function load() { return normalizeState(await env.loadState(), normalize); }
    function mutate(fn, ownerKey) {
      return serial(async () => {
        if (ownerKey && (await env.ownerKey()) !== ownerKey) throw identityChanged();
        const s = await load();
        const before = JSON.stringify(s);
        const out = await fn(s);
        // Nothing is written when nothing changed, so using the wallet never creates Services data by itself.
        if (JSON.stringify(s) !== before) await env.saveState(s, ownerKey);
        return out;
      });
    }

    // One bounded read of a domain's public manifest. No identity, no cookies, no redirects.
    async function fetchManifest(domain) {
      const base = origin(domain);
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
      try {
        const init = { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' } };
        if (controller) init.signal = controller.signal;
        let res;
        try { res = await env.fetch(base + WELL_KNOWN, init); } catch (err) { throw fail('network', 'Could not reach ' + domain + '.'); }
        if (res.status === 404) throw fail('no-manifest', domain + ' does not publish a manifest, so it advertises no services.');
        if (!res.ok) throw fail('no-manifest', domain + ' answered with an error (' + res.status + ').');
        let text;
        try { text = await readCapped(res, MAX_BODY_CHARS); } catch (err) { throw fail('network', 'The answer from ' + domain + ' was cut off.'); }
        if (text === null) throw fail('too-large', 'The manifest from ' + domain + ' is larger than the wallet will read.');
        let json;
        try { json = JSON.parse(text); } catch (err) { throw fail('bad-manifest', 'The manifest from ' + domain + ' is not valid JSON.'); }
        return { base, json, duplicates: topLevelDuplicateKeys(text) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // Reads what `input` advertises. Stores nothing and sends nothing about the person.
    async function discover(input) {
      const domain = normalize(typeof input === 'string' ? input.trim() : input);
      if (!domain) throw fail('bad-domain', 'That is not a domain name the wallet can use.');
      try { origin(domain); } catch (err) { throw fail('bad-domain', err && err.message ? err.message : 'That domain cannot be used.'); }
      const { base, json, duplicates } = await fetchManifest(domain);
      const read = readServices(domain, json, base, normalize);
      if (read.problem) throw fail(read.problem, read.text);
      // Only services that need a membership card are kept; the rest of what a domain advertises is the directory's to show.
      const gated = read.services.filter((x) => x.credential);
      const keys = new Set(gated.map((x) => x.key));
      const warnings = read.warnings.filter((w) => { const at = w.indexOf(':'); return at < 0 || !TYPE_BY_KEY.has(w.slice(at + 1)) || keys.has(w.slice(at + 1)); })
        .concat(duplicates.map((k) => 'duplicate-key:' + k));
      const found = { domain, services: gated, others: read.services.length - gated.length, warnings, fetchedAt: nowMs() };
      issued.set(domain, found);
      if (issued.size > MAX_ISSUED) issued.delete(issued.keys().next().value);
      return found;
    }

    // `preview` is a result this instance's own discover() returned a moment ago for the same domain: the person has just been
    // shown it, so adding does not ask the domain again. Anything else is read afresh.
    async function addDomain(input, preview) {
      // The identity is read before the network is asked, so a switch of identity while the manifest is on its way refuses the add.
      const ownerKey = await env.ownerKey();
      if (!ownerKey) throw fail('locked', 'Unlock the wallet first.');
      const wanted = normalize(typeof input === 'string' ? input.trim() : input);
      const reuse = preview && wanted && issued.get(wanted) === preview && nowMs() - preview.fetchedAt < PREVIEW_FOR_MS;
      const found = reuse ? preview : await discover(input);
      return mutate((s) => {
        if (s.domains.some((d) => d.domain === found.domain)) throw fail('exists', found.domain + ' is already in Services.');
        if (s.domains.length >= MAX_DOMAINS) throw fail('full', 'Services is full. Remove a domain first.');
        s.domains.push({ domain: found.domain, addedAt: iso(nowMs()) });
        s.manifests[found.domain] = { fetchedAt: found.fetchedAt, services: found.services, warnings: found.warnings, problem: null };
        return found;
      }, ownerKey);
    }

    // Takes a domain off the list with its settings and what the wallet remembered about it. Credentials are not the module's to
    // touch, and nothing is sent to the domain.
    async function removeDomain(input) {
      const domain = normalize(input);
      const ownerKey = await env.ownerKey();
      if (!domain || !ownerKey) return false;
      return mutate((s) => {
        const before = s.domains.length;
        s.domains = s.domains.filter((d) => d.domain !== domain);
        Object.keys(s.enabled).forEach((k) => { if (k.startsWith(domain + KEY_SEP)) delete s.enabled[k]; });
        Object.keys(s.outcomes).forEach((k) => { if (k.startsWith(domain + KEY_SEP)) delete s.outcomes[k]; });
        delete s.manifests[domain];
        return s.domains.length !== before;
      }, ownerKey);
    }

    // Asks a listed domain what it advertises now. A failure keeps the last answer and records the reason.
    async function refresh(input) {
      const domain = normalize(input);
      const ownerKey = await env.ownerKey();
      if (!domain || !ownerKey) throw fail('bad-domain', 'That is not a domain on the list.');
      if (!(await load()).domains.some((d) => d.domain === domain)) throw fail('not-listed', domain + ' is not in Services.');
      let found = null, problem = null;
      try { found = await discover(domain); } catch (err) { problem = err && err.message ? err.message : 'Could not read the manifest.'; }
      await mutate((s) => {
        if (!s.domains.some((d) => d.domain === domain)) return;
        const prior = s.manifests[domain] || { fetchedAt: null, services: [], warnings: [], problem: null };
        s.manifests[domain] = found
          ? { fetchedAt: found.fetchedAt, services: found.services, warnings: found.warnings, problem: null }
          : Object.assign({}, prior, { problem: problem.slice(0, MAX_REASON_CHARS) });
      }, ownerKey);
      if (!found) throw fail('refresh-failed', problem);
      return found;
    }

    async function setEnabled(input, key, value) {
      const domain = normalize(input);
      const ownerKey = await env.ownerKey();
      if (!domain || !ownerKey || !OPERATES[key] || typeof value !== 'boolean') throw fail('bad-request', 'That setting cannot be changed.');
      return mutate((s) => {
        if (!s.domains.some((d) => d.domain === domain)) throw fail('not-listed', domain + ' is not in Services.');
        s.enabled[settingKey(domain, key)] = value;
        return value;
      }, ownerKey);
    }

    // What a check or an operation found. Kept only for a domain that is listed, so using the wallet never creates Services data
    // for someone who has not added a domain.
    async function recordOutcome(input, kind, ok, reason) {
      const domain = normalize(input);
      const ownerKey = await env.ownerKey();
      if (!domain || !ownerKey || (kind !== 'mail' && kind !== 'listings')) return false;
      return mutate((s) => {
        if (!s.domains.some((d) => d.domain === domain)) return false;
        s.outcomes[settingKey(domain, kind)] = { ok: !!ok, at: nowMs(), reason: ok ? '' : String(reason || '').slice(0, MAX_REASON_CHARS) };
        return true;
      }, ownerKey);
    }

    function serviceRow(s, domain, advertised, entries, now, ownerKey) {
      const type = TYPE_BY_KEY.get(advertised.key);
      const declaredClass = !OPERATES[advertised.key] && advertised.credential ? advertised.credential.class : null;
      const credentials = credentialsFor(entries, domain, advertised.key, normalize, now, declaredClass, ownerKey);
      const explicit = s.enabled[settingKey(domain, advertised.key)];
      const enabled = resolveEnabled(s, domain, advertised.key, credentials.length > 0);
      const spec = OPERATES[advertised.key];
      const outcome = spec ? s.outcomes[settingKey(domain, spec.check)] || null : null;
      return {
        key: advertised.key, label: type.label, category: type.category, url: advertised.url || null, advertised: !advertised.held,
        operates: !!spec, enabled, explicit: typeof explicit === 'boolean' ? explicit : null,
        credentialClass: spec ? spec.credentialClass : declaredClass,
        credentials: credentials.map((c) => ({ id: c.id, state: c.state, entry: c.entry })),
        status: computeStatus({ key: advertised.key, advertised: !advertised.held, explicit, enabled, credentials, outcome, nowMs: now, credentialClass: spec ? spec.credentialClass : declaredClass })
      };
    }

    // Everything the tab draws, from what is saved and what the wallet holds. No network.
    async function rows() {
      const s = await load();
      const entries = await env.entries();
      const ownerKey = await env.ownerKey();
      const now = nowMs();
      const domains = s.domains.map((d) => {
        const m = s.manifests[d.domain] || { fetchedAt: null, services: [], warnings: [], problem: null };
        const services = m.services.map((x) => serviceRow(s, d.domain, x, entries, now, ownerKey));
        // A service the person holds a credential for is shown with its domain whether or not the manifest says anything now, so a
        // card is never left without a page. This also covers Domain Membership for a domain that has no `domainMembership` entry.
        for (const key of ['membership', ...Object.keys(OPERATES)]) {
          if (services.some((x) => x.key === key)) continue;
          if (credentialsFor(entries, d.domain, key, normalize, now, null, ownerKey).length) services.push(serviceRow(s, d.domain, { key, url: null, held: true }, entries, now, ownerKey));
        }
        return { domain: d.domain, addedAt: d.addedAt, fetchedAt: m.fetchedAt, warnings: m.warnings, problem: m.problem, services };
      });
      return { domains, found: foundDomains(s, entries) };
    }

    // Domains the person holds a service credential from but has not added. They are offered, never added by themselves, and
    // they are how a credential is always reachable from here.
    function foundDomains(s, entries) {
      const listed = new Set(s.domains.map((d) => d.domain));
      const byDomain = new Map();
      (entries || []).forEach((e) => {
        const cls = e && e.credential && e.credential.asset && e.credential.asset.class;
        if (!cls || !CREDENTIAL_CLASSES[cls]) return;
        const domain = normalize(e.credential.issuer && e.credential.issuer.domain);
        if (!domain || listed.has(domain)) return;
        if (!byDomain.has(domain)) byDomain.set(domain, new Set());
        CREDENTIAL_CLASSES[cls].forEach((k) => byDomain.get(domain).add(k));
      });
      return Array.from(byDomain, ([domain, keys]) => ({ domain, services: Array.from(keys).map((k) => ({ key: k, label: TYPE_BY_KEY.get(k).label })) })).sort((a, b) => a.domain.localeCompare(b.domain));
    }

    // One service for the settings page.
    async function service(input, key) {
      const domain = normalize(input);
      const view = await rows();
      const d = view.domains.find((x) => x.domain === domain);
      return d ? Object.assign({ domain }, d.services.find((x) => x.key === key) || null) : null;
    }

    // The pairs "domain|class" whose cards belong to a service of a listed domain: the three the wallet runs (even when the manifest
    // no longer says so, so a card is never without a page) and any class a manifest named for a service it advertises.
    async function associations() {
      const s = await load();
      const pairs = new Set();
      s.domains.forEach((d) => {
        Object.keys(CREDENTIAL_CLASSES).forEach((cls) => pairs.add(d.domain + KEY_SEP + cls));
        ((s.manifests[d.domain] || {}).services || []).forEach((x) => { if (x.credential) pairs.add(d.domain + KEY_SEP + x.credential.class); });
      });
      return pairs;
    }

    return { discover, addDomain, removeDomain, refresh, setEnabled, recordOutcome, rows, service, load, associations };
  }

  return {
    create, readServices, credentialNeed, safeServiceUrl, topLevelDuplicateKeys, normalizeState, resolveEnabled, computeStatus, credentialState, credentialsFor,
    normalizeDomain: defaultNormalizeDomain, emptyState, settingKey,
    SERVICE_TYPES, MEMBERSHIP, OPERATES, CREDENTIAL_CLASSES,
    LIMITS: { MAX_DOMAINS, MAX_BODY_CHARS, TIMEOUT_MS, FRESH_FOR_MS }
  };
});
