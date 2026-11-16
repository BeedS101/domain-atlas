// The Services module (extension/services-core.js) on its own, with no browser: reading a manifest, the address rules,
// bounded and redirect-free fetching, the domain list and its per-identity state, which credentials belong to which service,
// whether a service is on, and the four statuses.
//
//   node test/services-core.js
'use strict';
const S = require('../extension/services-core.js');

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const NOW = Date.parse('2026-11-16T12:00:00Z');
const HOUR = 3600 * 1000;

// ---------- an environment: one in-memory store per owner, a scripted network ----------
function makeEnv(opts) {
  opts = opts || {};
  const stores = {};
  const calls = [];
  const env = {
    owner: opts.owner || 'owner-A',
    clock: NOW,
    held: opts.held || [],
    pages: opts.pages || {},
    stores, calls,
    now: () => env.clock,
    ownerKey: async () => env.owner,
    loadState: async () => (stores[env.owner] === undefined ? null : JSON.parse(JSON.stringify(stores[env.owner]))),
    saveState: async (s, expected) => { if (expected && expected !== env.owner) throw new Error('wrong owner'); stores[env.owner] = JSON.parse(JSON.stringify(s)); },
    entries: async () => env.held,
    origin: (d) => { if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(d)) return 'http://' + d; return 'https://' + d; },
    normalizeDomain: (x) => S.normalizeDomain(x),
    fetch: async (url, init) => {
      calls.push({ url, init });
      const page = env.pages[url];
      if (page === 'network') throw new TypeError('fetch failed');
      if (page === 'redirect') throw new TypeError('redirect mode is set to error');
      if (!page) return new Response('not found', { status: 404 });
      return new Response(page.body, { status: page.status || 200, headers: page.headers || {} });
    }
  };
  return env;
}

const manifestFor = (domain, extra) => JSON.stringify(Object.assign({ spec: 'domain-atlas/1.0', domain, owner: { name: 'X' }, defaultWorld: 'a', worlds: [] }, extra));
const URL_OF = (d) => 'https://' + d + '/.well-known/spatial.json';

const FULL = { postOffice: true, tradingStation: true, chat: true, calendar: true, directory: { enabled: true }, chainLabs: { enabled: true }, assetStudio: { enabled: true }, scanner: { enabled: true }, walletBridge: { read: true } };
const LEAN = { postOffice: true, chat: true, calendar: true, directory: { enabled: true, url: '/atlas/directory/index.html' }, chainLabs: { enabled: true, url: '/chain-labs/index.html' }, assetStudio: { enabled: true, url: '/atlas/studio/index.html' }, scanner: { enabled: true, url: '/chain-labs/scan35.html' } };

function credential(cls, domain, id, opts) {
  opts = opts || {};
  return { credential: { id: id || 'urn:atlas:asset:' + cls + ':' + domain, asset: { class: cls, expiresAt: opts.expiresAt }, issuer: { domain }, owner: { publicKey: 'owner-A' } }, lastVerdict: opts.verdict === undefined ? { valid: true, status: 'verified' } : opts.verdict, spent: !!opts.spent, pendingOutcome: opts.pending };
}

(async () => {
  console.log('--- reading a manifest ---');
  const norm = (x) => S.normalizeDomain(x);
  let r = S.readServices('full.example', JSON.parse(manifestFor('full.example', FULL)), 'https://full.example', norm);
  line(r.problem === null && same(r.services.map((s) => s.key), ['postOffice', 'chat', 'assetStudio', 'chainLabs', 'scanner', 'tradingStation', 'directory', 'calendar']), 'an full-service manifest lists the services it advertises, in the table order', r);
  line(r.services.every((s) => s.url === null) && r.warnings.length === 0, 'services with no address are listed without one', r);
  line(r.services.find((s) => s.key === 'postOffice').label === 'Global Mail', 'the Post Office service is shown as Global Mail');
  r = S.readServices('lean.example', JSON.parse(manifestFor('lean.example', LEAN)), 'https://lean.example', norm);
  line(r.problem === null && !r.services.some((s) => s.key === 'tradingStation'), 'a partial-service manifest does not gain a service it does not advertise', r.services.map((s) => s.key));
  line(r.services.find((s) => s.key === 'directory').url === 'https://lean.example/atlas/directory/index.html', 'a path on the domain is resolved against it', r.services.find((s) => s.key === 'directory'));
  line(r.services.find((s) => s.key === 'scanner').url === 'https://lean.example/chain-labs/scan35.html', 'and so is a second one');

  const base = 'https://example.com';
  const urlCases = [
    ['https://example.com/studio/', 'https://example.com/studio/'], ['https://tools.example.com/x', 'https://tools.example.com/x'], ['/atlas/x?y=1', 'https://example.com/atlas/x?y=1'],
    ['https://evil.example/x', null], ['https://example.com.evil.example/x', null], ['https://notexample.com/x', null], ['http://example.com/x', null],
    ['https://user:pw@example.com/x', null], ['https://example.com/x#frag', null], ['//evil.example/x', null], ['/\\evil.example', null],
    ['javascript:alert(1)', null], ['data:text/html,x', null], ['https://example.com:8443/x', null], ['https://example.com/a b', null], ['', null], [42, null], ['x'.repeat(400), null]
  ];
  urlCases.forEach(([input, want]) => line(S.safeServiceUrl(input, base) === want, 'service address ' + JSON.stringify(String(input).slice(0, 40)) + (want ? ' is accepted' : ' is refused'), S.safeServiceUrl(input, base)));
  line(S.safeServiceUrl('http://localhost:8001/x', 'http://localhost:8001') === 'http://localhost:8001/x', 'a development domain may use its own http address');
  line(S.safeServiceUrl('https://localhost:8001/x', 'http://localhost:8001') === null, 'but not a different scheme');

  r = S.readServices('example.com', { domain: 'example.com', postOffice: { enabled: true, url: 'https://evil.example/' }, chat: { enabled: false }, calendar: 'yes', trading: true, chainlabs: { enabled: true }, nonsense: true }, base, norm);
  line(same(r.services.map((s) => s.key), ['postOffice', 'chainLabs', 'tradingStation']) && r.services[0].url === null, 'an off-domain address is dropped, "enabled: false" and odd values advertise nothing, aliases work', r);
  line(r.warnings.includes('url-ignored:postOffice'), 'and the dropped address is reported', r.warnings);
  r = S.readServices('example.com', { domain: 'example.com', chainLabs: { enabled: true }, chainlabs: false }, base, norm);
  line(r.services.length === 1 && r.services[0].key === 'chainLabs', 'when both spellings are present the main name decides', r);

  console.log('--- a manifest cannot name another domain ---');
  line(S.readServices('full.example', { domain: 'victim.example', postOffice: true }, 'https://full.example', norm).problem === 'domain-mismatch', 'a manifest served by one domain that names another is refused');
  line(S.readServices('full.example', { domain: 'FULL.EXAMPLE', postOffice: true }, 'https://full.example', norm).problem === null, 'spelling in capitals is the same domain');
  line(S.readServices('full.example', { domain: 'https://full.example', postOffice: true }, 'https://full.example', norm).problem === 'domain-mismatch', 'a URL in the domain field is refused');
  line(S.readServices('full.example', { identityKey: 'abc', worlds: [] }, 'https://full.example', norm).problem === 'no-domain', 'a key-anchored manifest names no domain and cannot be added');
  [null, [], 'text', 7].forEach((bad) => line(S.readServices('full.example', bad, 'https://full.example', norm).problem === 'bad-manifest', 'a manifest that is ' + JSON.stringify(bad) + ' is refused'));

  console.log('--- duplicate top-level names ---');
  line(same(S.topLevelDuplicateKeys('{"a":1,"walletBridge":{"x":1},"b":[{"k":1,"k":2}],"walletBridge":{"y":2}}'), ['walletBridge']), 'a name that appears twice at the top level is found');
  line(S.topLevelDuplicateKeys('{"a":{"k":1},"b":{"k":2},"c":"a\\",\\"a"}').length === 0, 'the same name in two nested objects, or inside a string, is not a duplicate');
  line(S.topLevelDuplicateKeys('{"a":"{","b":"}","a2":1}').length === 0, 'braces inside strings do not confuse it');

  console.log('--- fetching ---');
  let env = makeEnv({ pages: { [URL_OF('full.example')]: { body: manifestFor('full.example', FULL) } } });
  let svc = S.create(env);
  let found = await svc.discover('FULL.example');
  line(found.domain === 'full.example' && same(found.services.map((x) => x.key), ['postOffice', 'tradingStation', 'membership']) && found.others === 6, 'discovery keeps the services that need a membership card and counts the rest', found);
  const call = env.calls[0];
  line(call.url === URL_OF('full.example') && call.init.method === 'GET' && call.init.credentials === 'omit' && call.init.redirect === 'error' && call.init.body === undefined, 'it is one plain GET: no cookies, no redirects, no body', call.init);
  line(!JSON.stringify(call.init.headers).match(/authorization|cookie|owner|key/i), 'and it carries nothing about the person', call.init.headers);
  line(env.stores['owner-A'] === undefined, 'discovery stores nothing');
  line(env.calls.length === 1, 'and makes exactly one request');

  console.log('--- Domain Membership: announced, not announced, declined ---');
  const member = (extra, domain) => { const d = domain || 'm.example'; const e = makeEnv({ pages: { [URL_OF(d)]: { body: manifestFor(d, extra) } } }); return { e, svc: S.create(e), d }; };
  let m = member({ postOffice: true, domainMembership: { enabled: true, requiresCredential: true, credentialClass: 'atlas.membership' } });
  found = await m.svc.discover(m.d);
  line(same(found.services.map((x) => x.key), ['postOffice', 'membership']) && !found.services.find((x) => x.key === 'membership').implied, 'a domain that announces Domain Membership lists it as announced', found.services);
  m = member({ postOffice: true });
  found = await m.svc.discover(m.d);
  line(found.services.find((x) => x.key === 'membership') && found.services.find((x) => x.key === 'membership').implied === true, 'a domain that runs Global Mail but never announced Domain Membership still offers it, marked as not announced', found.services);
  line(found.services.find((x) => x.key === 'membership').credential.class === 'atlas.membership', 'with the wallet\'s own card class');
  line(found.others === 0, 'and the offer is not counted as one of the services that need no card', found.others);
  m = member({ tradingStation: true });
  line((await m.svc.discover(m.d)).services.some((x) => x.key === 'membership' && x.implied), 'a Trading Station alone is enough to offer it');
  m = member({ postOffice: true, domainMembership: false });
  line(!(await m.svc.discover(m.d)).services.some((x) => x.key === 'membership'), 'a domain that says it does not offer Domain Membership is not offered it');
  m = member({ postOffice: true, domainMembership: { enabled: false } });
  line(!(await m.svc.discover(m.d)).services.some((x) => x.key === 'membership'), 'nor one that says it is disabled');
  m = member({ chat: true, calendar: true, directory: { enabled: true } });
  found = await m.svc.discover(m.d);
  line(found.services.length === 0 && found.others === 3, 'a domain that runs nothing that needs a card from its own issuer offers nothing, so a site with only a manifest gets no Join', found);
  m = member({ postOffice: true });
  const asked = m.e.calls.length;
  const preview = await m.svc.discover(m.d);
  m.e.held = [];
  await m.svc.addDomain(m.d, preview);
  let mview = await m.svc.service(m.d, 'membership');
  line(mview && mview.implied === true && mview.advertised === false && mview.credentials.length === 0 && mview.operates === true, 'once added, a person with no card sees Domain Membership as joinable and not yet joined', mview && { implied: mview.implied, advertised: mview.advertised, credentials: mview.credentials.length });
  line(mview.status.state === 'unknown' && mview.status.code === 'not-joined' && mview.enabled === false, 'it is grey and off, not green, until a card is held and checked', mview.status);
  const saved = JSON.parse(JSON.stringify(m.e.stores['owner-A']));
  line(saved.manifests[m.d].services.some((x) => x.key === 'membership' && x.implied === true), 'the not-announced mark is kept with the saved domain');
  m.e.held = [credential('atlas.membership', m.d, 'urn:atlas:asset:m1')];
  mview = await m.svc.service(m.d, 'membership');
  line(mview.credentials.length === 1 && mview.credentials[0].state === 'valid' && mview.implied === true, 'after joining, the card appears under Domain Membership with its verification state', mview.credentials);
  line(mview.enabled === true, 'and holding the card keeps the service on, as it does for every card holder');
  m = member({ chat: true, calendar: true });
  m.e.held = [credential('atlas.membership', m.d, 'urn:atlas:asset:m2')];
  await m.svc.addDomain(m.d);
  mview = await m.svc.service(m.d, 'membership');
  line(mview && mview.advertised === false && mview.implied === false && mview.credentials.length === 1, 'a card held from a domain that offers nothing is still shown with that domain, never without a page', mview && { advertised: mview.advertised, implied: mview.implied });

  async function fails(input, setup, code) {
    const e = makeEnv({ pages: setup });
    try { await S.create(e).discover(input); return { ok: false, code: 'none', calls: e.calls.length }; } catch (err) { return { ok: err.code === code, code: err.code, calls: e.calls.length }; }
  }
  for (const bad of ['https://full.example', 'full.example/path', 'user@full.example', 'full.example:99999', '127.0.0.2', '10.0.0.1', '', 'a b.example', 'localdomain', 'xn--.example']) {
    const out = await fails(bad, {}, 'bad-domain');
    line(out.ok && out.calls === 0, 'discovery refuses ' + JSON.stringify(bad) + ' before any request', out);
  }
  let out = await fails('full.example', { [URL_OF('full.example')]: 'redirect' }, 'network');
  line(out.ok, 'a redirect is an error, not followed', out);
  out = await fails('full.example', { [URL_OF('full.example')]: 'network' }, 'network');
  line(out.ok, 'an unreachable domain is reported as unreachable', out);
  out = await fails('full.example', {}, 'no-manifest');
  line(out.ok, 'a domain with no manifest advertises nothing', out);
  out = await fails('full.example', { [URL_OF('full.example')]: { body: 'not json' } }, 'bad-manifest');
  line(out.ok, 'an answer that is not JSON is refused', out);
  out = await fails('full.example', { [URL_OF('full.example')]: { body: '{}', headers: { 'content-length': '999999999' } } }, 'too-large');
  line(out.ok, 'a declared size over the limit is refused without reading it', out);
  out = await fails('full.example', { [URL_OF('full.example')]: { body: '{"domain":"full.example","pad":"' + 'x'.repeat(300000) + '"}' } }, 'too-large');
  line(out.ok, 'an answer that turns out larger than the limit is cut off', out);
  out = await fails('full.example', { [URL_OF('full.example')]: { body: manifestFor('other.example', FULL) } }, 'domain-mismatch');
  line(out.ok, 'a manifest for another domain is refused', out);
  env = makeEnv({ pages: { [URL_OF('full.example')]: { body: '{"domain":"full.example","postOffice":true,"walletBridge":{"a":1},"walletBridge":{"b":2}}' } } });
  found = await S.create(env).discover('full.example');
  line(found.warnings.includes('duplicate-key:walletBridge'), 'discovery reports a duplicated top-level name', found.warnings);

  console.log('--- the same names as the reference directory ---');
  const dir = require('../directory-server/server.js');
  const vectors = require('./support/directory-service-vectors.json');
  line(same(dir.SERVICE_TYPES.map((t) => [t.key, t.category, t.aliases || []]), S.SERVICE_TYPES.concat([{ key: S.MEMBERSHIP.manifestName, category: S.MEMBERSHIP.category }]).map((t) => [t.key, t.category, t.aliases || []])), 'the wallet recognizes exactly the service names the directory does, in the same order');
  vectors.declarationCases.filter((c) => c.anchorType === 'domain' && c.manifest && !c.manifest.worlds).forEach((c) => {
    const got = S.readServices(c.anchorKey, Object.assign({ domain: c.anchorKey }, c.manifest), 'https://' + c.anchorKey, norm).services;
    line(same(got.map((x) => (x.key === 'membership' ? 'domainMembership' : x.key)), c.expect.map((x) => x.service)), 'declaration case: ' + c.note, { got: got.map((x) => x.key), want: c.expect.map((x) => x.service) });
  });

  console.log('--- the list, per identity ---');
  env = makeEnv({ pages: { [URL_OF('full.example')]: { body: manifestFor('full.example', FULL) }, [URL_OF('lean.example')]: { body: manifestFor('lean.example', LEAN) } } });
  svc = S.create(env);
  await svc.addDomain('full.example');
  await svc.addDomain('lean.example');
  let view = await svc.rows();
  line(same(view.domains.map((d) => d.domain), ['full.example', 'lean.example']), 'both domains can be kept at once', view.domains.map((d) => d.domain));
  line(Object.keys(env.stores['owner-A'].enabled).length === 0, 'adding a domain enables nothing', env.stores['owner-A'].enabled);
  line(view.domains.every((d) => d.services.every((s) => s.explicit === null && s.enabled === false)), 'every service starts off for a person who holds no credential');
  try { await svc.addDomain('full.example'); line(false, 'a duplicate is refused'); } catch (err) { line(err.code === 'exists', 'a duplicate is refused', err.code); }

  env.owner = 'owner-B';
  view = await svc.rows();
  line(view.domains.length === 0, 'another identity has its own, empty list');
  await svc.addDomain('full.example');
  await svc.setEnabled('full.example', 'postOffice', true);
  env.owner = 'owner-A';
  view = await svc.rows();
  line(view.domains.length === 2 && view.domains[0].services.find((s) => s.key === 'postOffice').explicit === null, 'a setting made as one identity does not appear for another');
  env.owner = 'owner-B';
  line((await svc.rows()).domains[0].services.find((s) => s.key === 'postOffice').explicit === true, 'and is still there for the identity that made it');
  env.owner = 'owner-A';

  console.log('--- a change begun for one identity is not applied to another ---');
  const slow = makeEnv({ pages: { [URL_OF('full.example')]: { body: manifestFor('full.example', FULL) } } });
  const origFetch = slow.fetch;
  slow.fetch = async (u, i) => { const res = await origFetch(u, i); slow.owner = 'owner-B'; return res; };
  try { await S.create(slow).addDomain('full.example'); line(false, 'switching identity mid-add is refused'); } catch (err) { line(err.code === 'identity-changed' || err.message === 'wrong owner', 'switching identity during an add refuses it', err.message); }
  line(slow.stores['owner-A'] === undefined && slow.stores['owner-B'] === undefined, 'and nothing is saved for either identity');

  console.log('--- switching, outcomes and removal ---');
  await svc.setEnabled('full.example', 'postOffice', true);
  line(await svc.recordOutcome('full.example', 'mail', true) === true, 'an outcome is recorded for a listed domain');
  line(await svc.recordOutcome('unlisted.example', 'mail', true) === false && env.stores['owner-A'].outcomes['unlisted.example|mail'] === undefined, 'but not for a domain that was never added');
  try { await svc.setEnabled('unlisted.example', 'postOffice', true); line(false, 'a setting for an unlisted domain is refused'); } catch (err) { line(err.code === 'not-listed', 'a setting for an unlisted domain is refused', err.code); }
  for (const bad of [['full.example', 'assetStudio', true], ['full.example', 'postOffice', 'yes'], ['full.example', '__proto__', true]]) {
    try { await svc.setEnabled(...bad); line(false, 'setting ' + JSON.stringify(bad) + ' is refused'); } catch (err) { line(err.code === 'bad-request', 'setting ' + JSON.stringify(bad) + ' is refused', err.code); }
  }
  const held = [credential('atlas.postoffice.membership', 'full.example', 'cred-pm')];
  env.held = held;
  await svc.removeDomain('full.example');
  view = await svc.rows();
  line(view.domains.length === 1 && view.domains[0].domain === 'lean.example', 'removing a domain takes it off the list');
  line(Object.keys(env.stores['owner-A'].enabled).length === 0 && Object.keys(env.stores['owner-A'].outcomes).length === 0 && !env.stores['owner-A'].manifests['full.example'], 'with its settings and what was remembered about it');
  line(env.held === held && held.length === 1 && env.calls.every((c) => c.init.method === 'GET'), 'it never touches credentials and sends nothing to the domain');
  line(view.found.length === 1 && view.found[0].domain === 'full.example' && view.found[0].services[0].key === 'postOffice', 'the credential is still reachable: its domain is offered under "found"', view.found);

  console.log('--- which credentials belong to which service ---');
  env.held = [
    credential('atlas.postoffice.membership', 'full.example'), credential('atlas.tradingstation.membership', 'full.example'), credential('atlas.membership', 'full.example'),
    credential('atlas.postoffice.membership', 'lean.example', 'pm-atlas'), credential('atlas.postoffice.membership', 'evil.example', 'pm-evil'), credential('atlas.demo.ticket', 'full.example')
  ];
  await svc.addDomain('full.example');
  view = await svc.rows();
  const fullRow = view.domains.find((d) => d.domain === 'full.example');
  const row = (d, k) => d.services.find((s) => s.key === k);
  line(row(fullRow, 'postOffice').credentials.length === 1 && row(fullRow, 'tradingStation').credentials.length === 1, 'each membership class finds its own service by issuer domain');
  line(row(fullRow, 'membership') && row(fullRow, 'membership').credentials.length === 1 && row(fullRow, 'membership').advertised === false, 'Domain Membership appears because the card is held, and is not presented as advertised');
  line(row(fullRow, 'postOffice').credentials[0].id !== 'pm-evil' && !fullRow.services.some((s) => s.credentials.some((c) => c.id === 'pm-evil' || c.id === 'pm-atlas')), 'a card from another domain is never attached to this domain');
  line(!fullRow.services.some((s) => s.credentials.some((c) => c.entry.credential.asset.class === 'atlas.demo.ticket')), 'a document that belongs to no service stays out of every service');
  line(!row(fullRow, 'chat') && !row(fullRow, 'calendar') && !row(fullRow, 'chainLabs'), 'services that need no membership card are not in the list at all');
  line(row(fullRow, 'postOffice').enabled === true && row(fullRow, 'postOffice').explicit === null, 'a service already used through its credential stays on without any saved setting');
  line(same(view.found.map((f) => f.domain), ['evil.example']) || same(view.found.map((f) => f.domain).sort(), ['evil.example']), 'domains with credentials that are not listed are offered, not added', view.found.map((f) => f.domain));
  line(S.CREDENTIAL_CLASSES['atlas.postoffice.membership'][0] === 'postOffice' && S.CREDENTIAL_CLASSES['atlas.tradingstation.membership'][0] === 'tradingStation' && S.CREDENTIAL_CLASSES['atlas.membership'][0] === 'membership', 'the three classes map to Global Mail, Trading Station and Domain Membership');

  env.held = [credential('constructor', 'full.example', 'x1'), credential('__proto__', 'full.example', 'x2'), credential('toString', 'full.example', 'x3')];
  line(same((await svc.rows()).found, []) && (await svc.rows()).domains.every((d) => d.services.every((sv) => sv.credentials.length === 0)), 'a class name that matches a built-in property name is just an unknown class');

  console.log('--- whether a service is on ---');
  const st = S.emptyState();
  line(S.resolveEnabled(st, 'a.example', 'postOffice', true) === true, 'holding the credential keeps an existing service on');
  line(S.resolveEnabled(st, 'a.example', 'postOffice', false) === false, 'with no credential nothing starts by itself');
  st.enabled['a.example|postOffice'] = false;
  line(S.resolveEnabled(st, 'a.example', 'postOffice', true) === false, 'a choice to turn it off always wins');
  line(S.resolveEnabled(st, 'a.example', 'assetStudio', true) === false, 'a service the wallet does not operate is never on');

  console.log('--- the four statuses ---');
  const status = (o) => S.computeStatus(Object.assign({ key: 'postOffice', advertised: true, explicit: undefined, enabled: true, credentials: [{ id: 'c', state: 'valid' }], outcome: null, nowMs: NOW }, o));
  const good = { ok: true, at: NOW - 2 * HOUR, reason: '' };
  let x = status({ outcome: good });
  line(x.state === 'active' && x.label === 'Active and working' && x.checkedAt === good.at, 'green: enabled, a valid card and a check that worked recently', x);
  x = status({ outcome: null });
  line(x.state === 'unknown' && x.code === 'unconfirmed', 'switched on with a valid card is still grey until something confirms it', x);
  x = status({ explicit: true, enabled: true, credentials: [{ id: 'c', state: 'valid' }], outcome: null });
  line(x.state !== 'active', '"Enabled" alone never makes a service green', x);
  x = status({ explicit: false, enabled: false, outcome: good });
  line(x.state === 'disabled' && x.label === 'Disabled', 'amber: the person turned it off', x);
  line(status({ explicit: false, enabled: false, credentials: [{ id: 'c', state: 'revoked' }] }).state === 'disabled', 'and a deliberate off stays amber whatever else is wrong');
  for (const [cs, code] of [['revoked', 'credential-revoked'], ['expired', 'credential-expired'], ['spent', 'credential-spent'], ['invalid', 'credential-invalid']]) {
    x = status({ credentials: [{ id: 'c', state: cs }], outcome: good });
    line(x.state === 'problem' && x.code === code && x.text.length > 10, 'red: a card that is ' + cs + ' explains itself', x);
  }
  x = status({ outcome: { ok: false, at: NOW - HOUR, reason: 'the domain refused the request' } });
  line(x.state === 'problem' && x.code === 'check-failed' && /refused/.test(x.text), 'red: a recent failed check says why', x);
  x = status({ credentials: [], enabled: false });
  line(x.state === 'unknown' && x.code === 'not-joined', 'grey: not joined', x);
  x = status({ credentials: [{ id: 'c', state: 'unverified' }], outcome: good });
  line(x.state === 'unknown' && x.code === 'credential-unverified', 'grey: a card the wallet could not verify is not called good', x);
  x = status({ outcome: { ok: true, at: NOW - 30 * HOUR, reason: '' } });
  line(x.state === 'unknown' && x.stale === true && x.code === 'stale', 'a check that is too old is marked stale and is not green', x);
  x = status({ outcome: { ok: false, at: NOW - 30 * HOUR, reason: 'x' } });
  line(x.state === 'unknown' && x.stale === true, 'and an old failure is stale too, not red');
  x = status({ credentials: [{ id: 'a', state: 'revoked' }, { id: 'b', state: 'valid' }], outcome: good });
  line(x.state === 'active', 'a valid card is enough when an old one was revoked');
  x = S.computeStatus({ key: 'chat', advertised: true, explicit: undefined, enabled: false, credentials: [], outcome: null, nowMs: NOW });
  line(x.state === 'unknown' && x.code === 'unsupported', 'a service this wallet does not operate is grey and says so, never green', x);
  line(['active', 'disabled', 'problem', 'unknown'].every((k) => typeof k === 'string'), 'four states');

  console.log('--- statuses in the rows, from what was recorded ---');
  env.clock = NOW;
  env.held = [credential('atlas.postoffice.membership', 'full.example'), credential('atlas.postoffice.membership', 'lean.example', 'pm-atlas')];
  await svc.recordOutcome('full.example', 'mail', true);
  view = await svc.rows();
  line(row(view.domains.find((d) => d.domain === 'full.example'), 'postOffice').status.state === 'active', 'a domain that answered a mail check is green');
  line(row(view.domains.find((d) => d.domain === 'lean.example'), 'postOffice').status.state === 'unknown', 'a second domain with a card but no check is grey: the two are independent');
  env.clock = NOW + 3 * 24 * HOUR;
  line(row((await svc.rows()).domains.find((d) => d.domain === 'full.example'), 'postOffice').status.stale === true, 'days later the same answer is stale');
  env.clock = NOW;
  await svc.setEnabled('full.example', 'postOffice', false);
  line(row((await svc.rows()).domains.find((d) => d.domain === 'full.example'), 'postOffice').status.state === 'disabled', 'turning it off shows amber');

  console.log('--- a manifest can say which card a service needs ---');
  const need = (key, declared) => { const w = []; return { got: S.credentialNeed(key, declared, w), w }; };
  let n = need('postOffice', true);
  line(n.got && n.got.class === 'atlas.postoffice.membership' && n.got.source === 'known' && n.w.length === 0, 'a service declared as plain true keeps the wallet\'s own association');
  n = need('postOffice', { enabled: true, requiresCredential: true, credentialClass: 'atlas.postoffice.membership' });
  line(n.got && n.got.source === 'manifest' && n.w.length === 0, 'the descriptor that agrees with the wallet is accepted');
  n = need('postOffice', { enabled: true, requiresCredential: true, credentialClass: 'atlas.demo.ticket' });
  line(n.got.class === 'atlas.postoffice.membership' && n.got.source === 'known' && same(n.w, ['credential-class-ignored:postOffice']), 'a different class cannot change which card the wallet ties to a service it runs', n);
  n = need('assetStudio', { enabled: true, requiresCredential: true, credentialClass: 'atlas.studio.membership' });
  line(n.got && n.got.class === 'atlas.studio.membership' && n.got.source === 'manifest', 'a service the wallet does not run can name the card it needs');
  line(need('assetStudio', { enabled: true }).got === null && need('assetStudio', true).got === null && need('assetStudio', { enabled: true, requiresCredential: false, credentialClass: 'atlas.studio.membership' }).got === null, 'without requiresCredential: true there is no card, however the class is spelled');
  for (const bad of ['', 'Atlas.Studio', 'atlas', 'atlas..x', '../x', 'a.b c', 'atlas.' + 'x'.repeat(130), 42, null, ['atlas.x'], { a: 1 }]) {
    n = need('calendar', { enabled: true, requiresCredential: true, credentialClass: bad });
    line(n.got === null && same(n.w, ['credential-descriptor-ignored:calendar']), 'a class that is not a class name is ignored with a note: ' + JSON.stringify(bad).slice(0, 30), n);
  }
  n = need('tradingStation', { enabled: true, requiresCredential: true, credentialClass: '__proto__.x' });
  line(n.got.class === 'atlas.tradingstation.membership', 'a class that spells a built-in name is just text');

  let rr = S.readServices('d.example', { domain: 'd.example', domainMembership: { enabled: true, requiresCredential: true, credentialClass: 'atlas.membership' }, assetStudio: { enabled: true, requiresCredential: true, credentialClass: 'atlas.studio.membership', url: 'https://evil.example/x' }, calendar: true }, 'https://d.example', norm);
  line(same(rr.services.map((x) => x.key), ['assetStudio', 'calendar', 'membership']) && rr.services.find((x) => x.key === 'membership').credential.class === 'atlas.membership', 'domainMembership is read as Domain Membership', rr.services.map((x) => x.key));
  line(rr.services.find((x) => x.key === 'calendar').credential === null, 'a service with no descriptor and no known card needs none');
  env = makeEnv({ pages: { [URL_OF('d.example')]: { body: manifestFor('d.example', { domainMembership: true, assetStudio: { enabled: true, requiresCredential: true, credentialClass: 'atlas.studio.membership', url: 'https://evil.example/x' }, calendar: true, scanner: { enabled: true, url: 'https://evil.example/y' } }) } } });
  svc = S.create(env);
  found = await svc.discover('d.example');
  line(same(found.services.map((x) => x.key), ['assetStudio', 'membership']) && found.others === 2, 'discovery lists only the services that need a card', found);
  line(found.warnings.includes('url-ignored:assetStudio') && !found.warnings.includes('url-ignored:scanner'), 'and warns only about the ones it lists');
  await svc.addDomain('d.example', found);
  const rawSaved = env.stores['owner-A'].manifests['d.example'].services;
  line(same(rawSaved.map((x) => x.key), ['assetStudio', 'membership']) && rawSaved[0].credential.class === 'atlas.studio.membership', 'what is saved is the card-based list with the named class');
  const reread = S.normalizeState({ version: 1, domains: [{ domain: 'd.example' }], manifests: { 'd.example': { services: [{ key: 'chat' }, { key: 'scanner', url: null }, { key: 'postOffice' }, { key: 'assetStudio', credential: { class: 'atlas.studio.membership' } }, { key: 'calendar', credential: { class: 'Bad Class' } }, { key: 'membership' }] } } }, norm);
  line(same(reread.manifests['d.example'].services.map((x) => x.key), ['postOffice', 'assetStudio', 'membership']), 'state saved by an earlier build loses services that need no card, and keeps the rest', reread.manifests['d.example'].services.map((x) => x.key));

  env.held = [credential('atlas.studio.membership', 'd.example', 'st1'), credential('atlas.studio.membership', 'other.example', 'st-other'), credential('atlas.membership', 'd.example', 'mem1', { verdict: { valid: false, status: 'revoked' } })];
  view = await svc.rows();
  const dRow = view.domains[0];
  const studio = dRow.services.find((x) => x.key === 'assetStudio');
  line(studio.operates === false && studio.credentials.length === 1 && studio.credentials[0].id === 'st1' && studio.credentialClass === 'atlas.studio.membership', 'a named class finds the card this domain issued, and only that one', studio);
  line(studio.status.state === 'unknown' && studio.status.code === 'unsupported' && studio.explicit === null, 'a service the wallet does not run is never green and has no switch', studio.status);
  line((await svc.associations()).has('d.example|atlas.studio.membership') && !(await svc.associations()).has('other.example|atlas.studio.membership'), 'the card moves under its service only for a domain on the list');
  const mem = dRow.services.find((x) => x.key === 'membership');
  line(mem.advertised === true && mem.credentials.length === 1, 'Domain Membership is advertised by the manifest and holds the card');
  env.held = [credential('atlas.studio.membership', 'd.example', 'st2', { expiresAt: '2020-01-01T00:00:00Z' })];
  const studio2 = (await svc.rows()).domains[0].services.find((x) => x.key === 'assetStudio');
  line(studio2.credentials[0].state === 'expired' && studio2.status.state === 'problem', 'an expired card shows as a problem whatever the manifest says');
  env.held = [];
  const studio3 = (await svc.rows()).domains[0].services.find((x) => x.key === 'assetStudio');
  line(studio3.status.code === 'needs-credential' && studio3.status.state === 'unknown', 'with no card it says the domain needs one');
  env.held = [Object.assign(credential('atlas.studio.membership', 'd.example', 'st3'), {})];
  env.held[0].credential.owner.publicKey = 'someone-else';
  line((await svc.rows()).domains[0].services.find((x) => x.key === 'assetStudio').credentials[0].state === 'invalid', 'a card that names another owner is not the person\'s');

  const hostile = S.create(makeEnv({ pages: { [URL_OF('h.example')]: { body: manifestFor('h.example', { calendar: { enabled: true, requiresCredential: true, credentialClass: 'atlas.postoffice.membership' } }) } }, held: [credential('atlas.postoffice.membership', 'h.example', 'pm-h')] }));
  await hostile.addDomain('h.example');
  const hv = (await hostile.rows()).domains[0];
  const hcal = hv.services.find((x) => x.key === 'calendar');
  line(hcal.operates === false && hcal.enabled === false && hcal.explicit === null, 'a manifest cannot give another service a switch by naming the Global Mail card');
  line(hv.services.find((x) => x.key === 'postOffice').operates === true && hv.services.find((x) => x.key === 'postOffice').credentials.length === 1, 'Global Mail keeps its own card');
  try { await hostile.setEnabled('h.example', 'calendar', false); line(false, 'and no setting can be saved for it'); } catch (err) { line(err.code === 'bad-request', 'and no setting can be saved for it', err.code); }

  console.log('--- reusing what the person was just shown ---');
  env = makeEnv({ pages: { [URL_OF('full.example')]: { body: manifestFor('full.example', FULL) } } });
  svc = S.create(env);
  const shown = await svc.discover('full.example');
  const reads = env.calls.length;
  await svc.addDomain('full.example', shown);
  line(env.calls.length === reads && env.stores['owner-A'].domains.length === 1, 'adding the preview that was just shown asks the domain nothing more');
  env = makeEnv({ pages: { [URL_OF('full.example')]: { body: manifestFor('full.example', FULL) } } });
  svc = S.create(env);
  const forged = { domain: 'full.example', services: [{ key: 'chat', label: 'Site chat', category: 'communication', url: null }], warnings: [], fetchedAt: env.clock };
  await svc.addDomain('full.example', forged);
  line(env.calls.length === 1 && env.stores['owner-A'].manifests['full.example'].services.length > 1, 'a preview the module did not produce is ignored and the domain is asked');
  env = makeEnv({ pages: { [URL_OF('full.example')]: { body: manifestFor('full.example', FULL) } } });
  svc = S.create(env);
  const aged = await svc.discover('full.example');
  env.clock = NOW + 10 * 60 * 1000;
  const readsAged = env.calls.length;
  await svc.addDomain('full.example', aged);
  line(env.calls.length === readsAged + 1, 'a preview that is minutes old is read again before it is kept');

  console.log('--- a card is never left without a page ---');
  env = makeEnv({ pages: { [URL_OF('full.example')]: { body: manifestFor('full.example', { chat: true }) } }, held: [credential('atlas.postoffice.membership', 'full.example', 'urn:atlas:asset:pm1')] });
  svc = S.create(env);
  await svc.addDomain('full.example');
  const kept = (await svc.rows()).domains[0].services.find((x) => x.key === 'postOffice');
  line(kept && kept.advertised === false && kept.credentials.length === 1 && kept.operates === true, 'a Global Mail card is shown with its domain even when the manifest no longer advertises it', kept);

  console.log('--- a saved state is checked when it is read back ---');
  const junk = S.normalizeState({
    version: 1,
    domains: [{ domain: 'a.example', addedAt: '2026-01-01' }, { domain: 'https://evil.example' }, { domain: 'a.example' }, null, 7, { domain: '__proto__.example' }],
    enabled: { 'a.example|postOffice': true, 'a.example|bogus': true, 'b.example|postOffice': true, 'a.example|chat': 'yes', '__proto__|x': true },
    manifests: { 'a.example': { fetchedAt: 5, services: [{ key: 'chat', url: 'https://a.example/x' }, { key: 'membership' }, { key: 'nope' }, { key: 'postOffice', url: 'x'.repeat(500) }], warnings: ['w', 3], problem: 'p' }, 'b.example': { services: [] } },
    outcomes: { 'a.example|mail': { ok: true, at: 5, reason: 'r' }, 'a.example|other': { ok: true, at: 5 }, 'b.example|mail': { ok: true, at: 5 }, 'a.example|listings': { ok: 'yes', at: 5 } }
  }, norm);
  line(same(junk.domains.map((d) => d.domain), ['a.example']), 'only valid, unique domains are kept', junk.domains);
  line(same(Object.keys(junk.enabled), ['a.example|postOffice']), 'only settings for a listed domain and a known, operated service are kept', junk.enabled);
  line(same(junk.manifests['a.example'].services.map((s) => s.key), ['membership', 'postOffice']) && junk.manifests['a.example'].services[1].url === null && !junk.manifests['b.example'], 'cached services are limited to the known table, to those that need a card, and to sane addresses', junk.manifests);
  line(same(Object.keys(junk.outcomes), ['a.example|mail']), 'only well-formed outcomes for a listed domain are kept', junk.outcomes);
  line(same(S.normalizeState('garbage', norm), S.emptyState()) && same(S.normalizeState(null, norm), S.emptyState()), 'something that is not a state reads as an empty one');

  console.log('--- the list is bounded ---');
  const bulk = makeEnv({});
  for (let i = 0; i < S.LIMITS.MAX_DOMAINS + 3; i++) bulk.pages[URL_OF('d' + i + '.example')] = { body: manifestFor('d' + i + '.example', { postOffice: true }) };
  const bs = S.create(bulk);
  let refused = null;
  for (let i = 0; i < S.LIMITS.MAX_DOMAINS + 3; i++) { try { await bs.addDomain('d' + i + '.example'); } catch (err) { refused = refused || err.code; } }
  line(refused === 'full' && bulk.stores['owner-A'].domains.length === S.LIMITS.MAX_DOMAINS, 'the list stops at its limit', refused);

  console.log('\n' + (failures ? failures + ' of ' + total + ' FAILED' : 'services core: ' + total + ' passed, 0 failed'));
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('FATAL', err); process.exit(1); });
