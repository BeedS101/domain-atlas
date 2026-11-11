// Who may use the public mint (POST /atlas/asset/issue), checked on both issuers (Node and PHP), each a throw-away
// instance with the checks switched on:
//   - the request must come from the issuer's own origin, a browser extension or a listed trusted origin
//   - the class must be one the domain offers; the generated elements (platinum and the rest) are not, so they cannot
//     be minted and converted into gold
//   - the other deployed domain's pages may mint a Post Office membership (the federation demo) and nothing else
//   - restricted and unknown classes keep their own answers
//   - the lists of offered classes in the two issuers are identical and cover every class the demo scenes mint
//
//   node test/private-mint.js
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { startNode, startPhp } = require('./lib/gen1-issuers');

let failures = 0;
let total = 0;
function line(ok, text, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
const owner = () => 'private-mint-' + crypto.randomBytes(8).toString('hex');
const mint = (be, cls, quantity, origin) => {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  return fetch(be.base + '/atlas/asset/issue', { method: 'POST', headers, body: JSON.stringify({ ownerPublicKey: owner(), assetClass: cls, quantity }) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
};

const ROOT = path.resolve(__dirname, '..');
function phpList() {
  const src = fs.readFileSync(path.join(ROOT, 'issuer-php/lib/store.php'), 'utf8');
  const m = src.match(/const ATLAS_PUBLIC_MINT_CLASSES = \[([\s\S]*?)\];/);
  return m[1].match(/'[^']+'/g).map((s) => s.slice(1, -1)).sort();
}
function nodeList() {
  const src = fs.readFileSync(path.join(ROOT, 'issuer-server/server.js'), 'utf8');
  const m = src.match(/const PUBLIC_MINT_CLASSES = new Set\(\[([\s\S]*?)\]\);/);
  return m[1].match(/'[^']+'/g).map((s) => s.slice(1, -1)).sort();
}
function sceneMintClasses() {
  const out = new Set();
  for (const site of fs.readdirSync(ROOT).filter((d) => d.startsWith('demo-domain-'))) {
    const dir = path.join(ROOT, site, 'spatial');
    if (!fs.existsSync(dir)) continue;
    for (const world of fs.readdirSync(dir)) {
      const file = path.join(dir, world, 'scene.json');
      if (!fs.existsSync(file)) continue;
      const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const m of scene.interactables || []) if ((m.action === 'mint' || m.action === 'issue') && m.class) out.add(m.class);
    }
  }
  return [...out];
}

async function suite(be, label) {
  console.log('\n== ' + label);
  const own = be.base;
  const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

  // Origin.
  const noOrigin = await mint(be, 'atlas.element.gold', 1);
  line(noOrigin.status === 403 && noOrigin.body.code === 'mint-origin-refused', 'a request that names no origin is refused', noOrigin);
  const foreign = await mint(be, 'atlas.element.gold', 1, 'https://other-site.example');
  line(foreign.status === 403 && foreign.body.code === 'mint-origin-refused', "a page on another site is refused", foreign);
  const nullOrigin = await mint(be, 'atlas.element.gold', 1, 'null');
  line(nullOrigin.status === 403 && nullOrigin.body.code === 'mint-origin-refused', 'an opaque ("null") origin is refused', nullOrigin);
  const lookalike = await mint(be, 'atlas.element.gold', 1, own + '.other-site.example');
  line(lookalike.status === 403, 'an origin that only starts like this site is refused', lookalike);
  const wrongPort = await mint(be, 'atlas.element.gold', 1, own.replace(/:\d+$/, ':1'));
  line(wrongPort.status === 403, 'the same host on another port is refused', wrongPort);
  const fromOwn = await mint(be, 'atlas.element.gold', 1, own);
  line(fromOwn.status === 200 && fromOwn.body.asset.class === 'atlas.element.gold', "this site's own pages can mint an offered class", fromOwn);
  const fromExt = await mint(be, 'atlas.element.iron', 1, ext);
  line(fromExt.status === 200, 'the wallet extension can mint an offered class', fromExt);

  // The federation demo: the other deployed domain's pages, one class.
  for (const origin of ['https://evtec.co.za', 'https://domain-atlas.co.za']) {
    const po = await mint(be, 'atlas.postoffice.membership', undefined, origin);
    line(po.status === 200 && po.body.asset.class === 'atlas.postoffice.membership', origin + ' may mint a Post Office membership here', po);
    for (const cls of ['atlas.membership', 'atlas.tradingstation.membership', 'atlas.demo.governance.membership', 'atlas.element.gold', 'atlas.wearable.ring']) {
      const r = await mint(be, cls, 1, origin);
      line(r.status === 403 && r.body.code === 'mint-origin-refused', origin + ' may not mint ' + cls.split('.').slice(1).join('.'), r);
    }
  }
  for (const origin of ['https://evtec.co.za.attacker.example', 'http://evtec.co.za', 'https://evtec.co.za:8443', 'https://stranger.example']) {
    const r = await mint(be, 'atlas.postoffice.membership', undefined, origin);
    line(r.status === 403 && r.body.code === 'mint-origin-refused', origin + ' may not mint a Post Office membership', r);
  }

  // Class.
  for (const cls of ['atlas.element.platinum', 'atlas.element.hydrogen', 'atlas.element.uranium']) {
    const r = await mint(be, cls, 100, own);
    line(r.status === 403 && r.body.code === 'mint-not-offered', cls.split('.').pop() + ' is not offered, so it cannot be minted from the page', r);
  }
  const offered = [['atlas.membership'], ['atlas.credit.balance', 5], ['atlas.demo.login.badge'], ['atlas.avatar.hat.cap'], ['atlas.avatar.chest.forest'], ['atlas.avatar.chest.dusk'], ['atlas.avatar.legs.forest'], ['atlas.avatar.legs.dusk'], ['atlas.trophy.chess']];
  for (const [cls, q] of offered) {
    const r = await mint(be, cls, q, own);
    line(r.status === 200, cls + ' is offered and mints', r);
  }
  const restricted = await mint(be, 'atlas.demo.studio.collectible', undefined, own);
  line(restricted.status === 403 && restricted.body.code === 'studio-authorization-required', 'a restricted class keeps its own answer', restricted);
  const unknown = await mint(be, 'atlas.no.such.class', 1, own);
  line(unknown.status === 400, 'an unknown class is still a 400', unknown);
}

(async () => {
  const lists = { php: phpList(), node: nodeList() };
  line(JSON.stringify(lists.php) === JSON.stringify(lists.node), 'the PHP and Node lists of offered classes are identical', { php: lists.php.length, node: lists.node.length });
  line(new Set(lists.php).size === lists.php.length, 'no class is listed twice');
  const missing = sceneMintClasses().filter((c) => !lists.php.includes(c));
  line(missing.length === 0, 'every class a demo scene mints or issues is offered', missing);
  line(!lists.php.some((c) => /^atlas\.element\./.test(c) && !['atlas.element.iron', 'atlas.element.gold', 'atlas.element.silver'].includes(c)), 'no generated element other than iron, gold and silver is offered');

  const base = 27000 + Math.floor(Math.random() * 6000);
  const on = { env: { ATLAS_PRIVATE_MINT: 'on', ATLAS_MINT_LIMITS: 'on' } };
  const node = await startNode(base, on);
  const php = await startPhp(base + 1, on);
  const trusted = { env: { ATLAS_PRIVATE_MINT: 'on', ATLAS_MINT_ORIGINS: 'https://sibling.example/' } };
  const node2 = await startNode(base + 2, trusted);
  const php2 = await startPhp(base + 3, trusted);
  const off = await startNode(base + 4, { env: { ATLAS_PRIVATE_MINT: 'off' } });
  try {
    await suite(node, 'Node issuer');
    await suite(php, 'PHP issuer');
    console.log('\n== trusted origins and the test switch');
    for (const [be, name] of [[node2, 'Node'], [php2, 'PHP']]) {
      const ok = await mint(be, 'atlas.element.gold', 1, 'https://sibling.example');
      const no = await mint(be, 'atlas.element.gold', 1, 'https://stranger.example');
      line(ok.status === 200 && no.status === 403, name + ': a listed trusted origin may mint, another site may not', [ok.status, no.status]);
    }
    const fed = { env: { ATLAS_PRIVATE_MINT: 'on', ATLAS_FEDERATION_MINT_ORIGINS: 'https://test-sibling.example' } };
    const node3 = await startNode(base + 5, fed), php3 = await startPhp(base + 6, fed);
    try {
      for (const [be, name] of [[node3, 'Node'], [php3, 'PHP']]) {
        const ok = await mint(be, 'atlas.postoffice.membership', undefined, 'https://test-sibling.example');
        const other = await mint(be, 'atlas.element.gold', 1, 'https://test-sibling.example');
        line(ok.status === 200 && other.status === 403, name + ': an origin added for federation may mint a Post Office membership and nothing else', [ok.status, other.status]);
      }
    } finally { node3.stop(); php3.stop(); }
    const sw = await mint(off, 'atlas.element.platinum', 100);
    line(sw.status === 200, 'ATLAS_PRIVATE_MINT=off lets a test instance mint without origin or class checks (live issuers never set it)', sw);
  } finally {
    for (const be of [node, php, node2, php2, off]) be.stop();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' PRIVATE MINT CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
