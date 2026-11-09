// Limits on fresh mints of gold, silver and iron, checked on both issuers (Node and PHP), each a throw-away
// instance with its own state:
//   - at most 1 g per request, at most 3 g per owner key in any rolling 7 days, per element
//   - one shared allowance whoever asks (a mining stall and a chess reward both go through /atlas/asset/issue)
//   - a retry with the same request id is not counted twice
//   - split, convert and trade re-mints are not counted; a refusal by the holding cap uses none of the allowance
//   - an unreadable allowance record refuses the mint
//
//   node test/mint-limits.js
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { startNode, startPhp } = require('./lib/gen1-issuers');
const { newOwner, signSpend } = require('./lib/owner-auth');

const GOLD = 'atlas.element.gold';
const SILVER = 'atlas.element.silver';
const IRON = 'atlas.element.iron';
const DAY = 86400;
let failures = 0;
let total = 0;
function line(ok, text, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
const owner = () => 'limit-test-' + crypto.randomBytes(8).toString('hex');
const post = (be, p, body) => fetch(be.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const mint = (be, ownerKey, cls, quantity, extra) => post(be, '/atlas/asset/issue', Object.assign({ ownerPublicKey: ownerKey, assetClass: cls, quantity }, extra || {}));
const recordFile = (be, ownerKey) => path.join(be.allowanceDir, crypto.createHash('sha256').update(ownerKey).digest('hex').slice(0, 40) + '.json');
const readRecord = (be, ownerKey) => { try { return JSON.parse(fs.readFileSync(recordFile(be, ownerKey), 'utf8')); } catch (e) { return null; } };
const now = () => Math.floor(Date.now() / 1000);

async function suite(be, label) {
  console.log('\n== ' + label);

  // 1. Size of one request.
  const a = owner();
  for (const cls of [GOLD, SILVER, IRON]) {
    const big = await mint(be, a, cls, 2);
    line(big.status === 400 && big.body.code === 'mint-too-large' && big.body.perRequest === 1, cls.split('.').pop() + ': a request for 2 g is refused', big);
  }
  const ten = await mint(be, a, GOLD, 10);
  line(ten.status === 400 && ten.body.code === 'mint-too-large', '10 g, the old stall amount, is refused');
  line(readRecord(be, a) === null, 'a refusal on size uses none of the allowance');

  // 2. The weekly allowance, per element.
  const b = owner();
  const firsts = [];
  for (let i = 0; i < 3; i++) firsts.push(await mint(be, b, GOLD, 1));
  line(firsts.every((r) => r.status === 200 && r.body.quantity === 1 && r.body.asset.class === GOLD), 'three single-gram gold mints succeed', firsts.map((r) => r.status));
  const fourth = await mint(be, b, GOLD, 1);
  line(fourth.status === 400 && fourth.body.code === 'weekly-limit' && fourth.body.used === 3 && fourth.body.limit === 3 && fourth.body.windowSeconds === 7 * DAY, 'the fourth gold mint is refused with the weekly-limit code', fourth);
  const retryAt = Date.parse(fourth.body.retryAt) / 1000;
  line(Math.abs(retryAt - (now() + 7 * DAY)) < 60, 'the answer says when more can be mined (about 7 days after the first mint)', fourth.body.retryAt);
  line(/Weekly limit reached for Gold/.test(fourth.body.error) && /UTC/.test(fourth.body.error), 'the message is readable', fourth.body.error);
  const silver = await mint(be, b, SILVER, 1);
  const iron = await mint(be, b, IRON, 1);
  line(silver.status === 200 && iron.status === 200, 'silver and iron have their own allowance');
  const other = await mint(be, owner(), GOLD, 1);
  line(other.status === 200, 'another owner key has its own allowance');

  // 3. A retry of one request is one mint.
  const c = owner();
  const rid = 'retry-' + crypto.randomBytes(12).toString('hex');
  const r1 = await mint(be, c, IRON, 1, { requestId: rid });
  const again = [];
  for (let i = 0; i < 4; i++) again.push(await mint(be, c, IRON, 1, { requestId: rid }));
  line(r1.status === 200 && again.every((r) => r.status === 200 && r.body.id === r1.body.id), 'repeating a request id returns the same credential', again.map((r) => r.status));
  const c2 = await mint(be, c, IRON, 1);
  const c3 = await mint(be, c, IRON, 1);
  const c4 = await mint(be, c, IRON, 1);
  line(c2.status === 200 && c3.status === 200 && c4.status === 400 && c4.body.used === 3, 'the repeats used one gram of the three, not five', [c2.status, c3.status, c4.status]);

  // A request that reserved its gram and then died before a reply was stored is retried against a full record:
  // its own reservation is recognised, not counted again.
  const c5 = owner();
  const rid5 = 'crashed-' + crypto.randomBytes(12).toString('hex');
  fs.mkdirSync(be.allowanceDir, { recursive: true });
  const t5 = now();
  fs.writeFileSync(recordFile(be, c5), JSON.stringify({ owner: c5, mints: { [IRON]: [{ k: 'x:a', t: t5 - 100, q: 1 }, { k: 'x:b', t: t5 - 50, q: 1 }, { k: 'r:' + rid5, t: t5 - 10, q: 1 }] } }));
  const retried = await mint(be, c5, IRON, 1, { requestId: rid5 });
  line(retried.status === 200, 'a retry whose reservation is already in a full record is accepted', retried);
  line((readRecord(be, c5).mints[IRON] || []).length === 3, 'and it is still three grams, not four', readRecord(be, c5));
  const stranger = await mint(be, c5, IRON, 1, { requestId: 'other-' + rid5 });
  line(stranger.status === 400 && stranger.body.code === 'weekly-limit', 'a different request id is still refused by the full record', stranger);

  // 4. Concurrent requests cannot pass on the same count.
  const d = owner();
  const burst = await Promise.all(Array.from({ length: 10 }, () => mint(be, d, SILVER, 1)));
  const ok = burst.filter((r) => r.status === 200).length;
  const refused = burst.filter((r) => r.status === 400 && r.body.code === 'weekly-limit').length;
  line(ok === 3 && refused === 7, 'ten simultaneous mints: exactly three succeed, seven are refused', burst.map((r) => r.status));

  // 5. The window rolls.
  const e = owner();
  fs.mkdirSync(be.allowanceDir, { recursive: true });
  const t = now();
  fs.writeFileSync(recordFile(be, e), JSON.stringify({ owner: e, mints: { [GOLD]: [{ k: 'x:old', t: t - 8 * DAY, q: 1 }, { k: 'x:mid', t: t - 6 * DAY, q: 1 }, { k: 'x:new', t: t - 1 * DAY, q: 1 }] } }));
  const roll1 = await mint(be, e, GOLD, 1);
  line(roll1.status === 200, 'a mint older than 7 days no longer counts');
  const roll2 = await mint(be, e, GOLD, 1);
  line(roll2.status === 400 && roll2.body.used === 3, 'the allowance is full again with the three still inside the window', roll2);
  line(Math.abs(Date.parse(roll2.body.retryAt) / 1000 - (t - 6 * DAY + 7 * DAY)) < 2, 'the next time is when the oldest counted mint leaves the window', roll2.body.retryAt);
  const rec = readRecord(be, e);
  line(rec && rec.mints[GOLD].every((x) => x.t > t - 7 * DAY), 'entries that left the window are dropped from the record', rec);

  // 6. Things that are not fresh mints.
  const f = newOwner();
  const g = await mint(be, f, GOLD, 1);
  const conv = await post(be, '/atlas/convert', signSpend('/atlas/convert', { credential: g.body, spendAmount: 1, toClass: IRON }));
  line(g.status === 200 && conv.status === 200, 'a gold gram converts into iron', conv);
  const ironAfter = [await mint(be, f, IRON, 1), await mint(be, f, IRON, 1), await mint(be, f, IRON, 1)];
  line(ironAfter.every((r) => r.status === 200), 'converting does not use the iron allowance', ironAfter.map((r) => r.status));
  const split = await post(be, '/atlas/asset/split', signSpend('/atlas/asset/split', { credential: conv.body.received, sendAmount: 5, toPublicKey: newOwner() }));
  line(split.status === 200, 'a split of a converted balance is not limited', split);

  // 7. The holding cap goes first and uses no allowance.
  const h = owner();
  fs.mkdirSync(be.holdingsDir, { recursive: true });
  const holdFile = path.join(be.holdingsDir, crypto.createHash('sha256').update(h).digest('hex').slice(0, 40) + '.json');
  fs.writeFileSync(holdFile, JSON.stringify({ owner: h, held: { [IRON]: [{ id: 'urn:test:seed', q: 500 }] } }));
  const capped = await mint(be, h, IRON, 1);
  line(capped.status === 400 && capped.body.code === 'cap', 'an owner at the holding cap is refused by the cap', capped);
  line(readRecord(be, h) === null, 'and the refusal used none of the weekly allowance');

  // 8. Unreadable records refuse the mint.
  const i = owner();
  fs.mkdirSync(be.allowanceDir, { recursive: true });
  const before = (await mint(be, i, GOLD, 1)).status;
  for (const [name, content] of [['zero-byte', ''], ['not json', '{oops'], ['wrong shape', '{"owner":"x"}']]) {
    fs.writeFileSync(recordFile(be, i), content);
    const res = await mint(be, i, GOLD, 1);
    line(before === 200 && res.status === 503, name + ' record: the mint is refused with 503', res);
    line(fs.readFileSync(recordFile(be, i), 'utf8') === content, name + ' record: left untouched for the operator');
  }

  // 9. Other classes are untouched.
  const j = owner();
  const membership = await mint(be, j, 'atlas.membership');
  line(membership.status === 200, 'a class without limits still mints freely');
}

(async () => {
  const base = 21000 + Math.floor(Math.random() * 6000);
  const on = { env: { ATLAS_MINT_LIMITS: 'on' } };
  const node = await startNode(base, on);
  const php = await startPhp(base + 1, on);
  try {
    await suite(node, 'Node issuer');
    await suite(php, 'PHP issuer');
    console.log('\n== the test switch');
    const off = await startNode(base + 2, { env: { ATLAS_MINT_LIMITS: 'off' } });
    try {
      const big = await mint(off, owner(), GOLD, 10);
      line(big.status === 200 && big.body.quantity === 10, 'ATLAS_MINT_LIMITS=off lets a test instance mint 10 g (live issuers never set it)', big);
    } finally { off.stop(); }
  } finally {
    node.stop();
    php.stop();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' MINT LIMIT CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
