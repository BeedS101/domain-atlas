// Security regression test for presence and chat abuse controls, run against
// the Node server or the PHP bundle (same assertions for both):
//
//   node test/manual-presence-abuse.js node
//   node test/manual-presence-abuse.js php
//
// Source addresses are real: every request is made from a distinct loopback
// address (127.0.0.N) by binding the client socket, so the server sees
// different peer addresses exactly as it would on the network. Covered:
//
//   - the original room-flooding attack (130 presence joins and 230 chat
//     joins from one source) no longer excludes a legitimate visitor
//   - 100+ joins from one source hit the per-source cap, then a join-rate
//     cooldown with Retry-After; cooldowns escalate and expire
//   - X-Forwarded-For / X-Real-IP / Forwarded are ignored
//   - two legitimate simultaneous sessions from one address, a school-sized
//     group on a shared address (and the knob that admits a bigger one)
//   - separate sources have separate budgets
//   - rapid world switching and reconnects without a leave
//   - fair allocation near capacity, and the defined "room full" answer
//   - official-title display names are refused and leave no trace
//   - expiry of sessions and rate-limit history; restart behaviour
//   - nothing about a source reaches any response or (PHP) the store files in
//     raw form; DA-002's no-wallet-key payload shapes are unchanged
//   - Node only: WebSocket joins, chat joins, the idle-socket cap, and both
//     transports counting against one budget

const { spawn, execFileSync } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODE = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = MODE === 'php' ? 8282 : 8281;
const ROOT = path.resolve(__dirname, '..');
const ip = (n) => '127.0.0.' + n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('PASS: ' + msg);
}

const seen = []; // every response body, scanned at the end for source leakage

// ---------- HTTP from a chosen source address ----------

function rq(src, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, localAddress: src, headers: h, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        seen.push(text);
        let json = null;
        try { json = JSON.parse(text); } catch (err) {}
        resolve({ status: res.statusCode, body: json, text, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const join = (src, domain, world, name, headers) => rq(src, 'POST', '/presence/poll/join', { domain, world, name }, headers);
const leave = (src, id) => rq(src, 'POST', '/presence/poll/leave', { id });
const chatJoin = (src, domain, world, name, headers) => rq(src, 'POST', '/presence/poll/chat-join', { domain, world, name }, headers);
const chatLeave = (src, id) => rq(src, 'POST', '/presence/poll/chat-leave', { id });
const status = async (domain, world) => (await rq(ip(250), 'GET', '/presence/status?domain=' + encodeURIComponent(domain) + '&world=' + encodeURIComponent(world))).body.count;

// ---------- backend control ----------

let phpDir = null;
let proc = null;

async function start(extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  if (MODE === 'php') {
    if (!phpDir) {
      phpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abuse-php-'));
      fs.cpSync(path.join(ROOT, 'presence-php'), phpDir, { recursive: true });
      for (const f of fs.readdirSync(path.join(phpDir, 'presence/lib'))) if (/^atlas-.*\.json/.test(f)) fs.unlinkSync(path.join(phpDir, 'presence/lib', f));
    }
    env.PHP_CLI_SERVER_WORKERS = '4';
    proc = spawn('php', ['-S', '127.0.0.1:' + PORT, 'test-router.php'], { cwd: phpDir, env, stdio: 'ignore' });
  } else {
    env.PORT = String(PORT);
    proc = spawn('node', [path.join(ROOT, 'presence-server', 'server.js')], { env, stdio: 'ignore' });
  }
  for (let i = 0; i < 50; i++) {
    try { await rq(ip(250), 'GET', '/presence/status?domain=ready&world=ready'); return; } catch (err) { await sleep(100); }
  }
  throw new Error('backend did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  p.kill();
  await new Promise((r) => { p.on('exit', r); setTimeout(r, 1000); });
  await sleep(200);
}
async function fresh(extraEnv) { // brand new state
  await stop();
  if (phpDir) for (const f of fs.readdirSync(path.join(phpDir, 'presence/lib'))) if (/^atlas-.*\.json/.test(f)) fs.unlinkSync(path.join(phpDir, 'presence/lib', f));
  await start(extraEnv);
}

const BASE_ENV = { POLL_TIMEOUT_MS: '60000', POLL_SWEEP_INTERVAL_MS: '300' };
const BAD_NAMES = ['Moderator', 'Moderator (official)', 'MODERATOR', 'M0d3r4t0r', 'Mоderator', 'Admin', 'Domain Staff', '✓ Bob', 'Offıcial', 'Support Team', 'victimexample', 'm.o.d', 'Ａｄｍｉｎ'];
const GOOD_NAMES = ['Alice', 'Bob', 'Model Citizen', 'Unofficial Joe', 'Badminton Fan', 'Staffan', '日本語'];

(async () => {
  const cleanupDirs = [];
  try {
    // ================= A: defaults =================
    console.log('SETUP: ' + MODE + ' presence on port ' + PORT + ', default limits');
    await fresh(BASE_ENV);
    const D = 'victim.example';

    console.log('STEP 1: the original flood (130 presence joins from one source) against the patched backend');
    let accepted = 0; const denied = []; const retryHeaders = [];
    for (let i = 0; i < 130; i++) {
      const r = await join(ip(1), D, 'Main Hall', 'bot' + i);
      if (r.status === 200) accepted++; else { denied.push(r); retryHeaders.push(r.headers['retry-after']); }
    }
    check(accepted === 10, 'one source holds exactly SOURCE_MAX_PRESENCE_PER_ROOM (10) sessions of the 100-member room, not 100 (accepted ' + accepted + ')');
    check(denied.every((r) => r.status === 429), 'every refusal is a 429, not a 503 that looks like a full room');
    const reasons = new Set(denied.map((r) => r.body.reason));
    check(reasons.has('source-limit') && reasons.has('join-rate-limited'), 'refusals are source-limit first, then join-rate-limited once the window budget is spent (' + [...reasons].join(', ') + ')');
    check(denied.every((r) => /^\d+$/.test(r.headers['retry-after'] || '') && r.body.retryAfter > 0), 'every 429 carries Retry-After and retryAfter');
    check(denied.every((r) => typeof r.body.error === 'string' && r.body.error.length > 20 && r.body.error !== r.body.reason && r.body.message === r.body.error), 'every refusal has a readable message');
    const legit = await join(ip(2), D, 'Main Hall', 'LegitUser');
    check(legit.status === 200, 'a legitimate visitor from another source still gets in after the flood');
    check(legit.body.roster.length === 10, 'and sees the 10 flood sessions, not 100');
    check(await status(D, 'Main Hall') === 11, 'status counts 11 sessions; the 120 refused joins did not inflate it');

    console.log('STEP 2: the chat flood (230 chat joins from one source)');
    let chatOk = 0; const chatDenied = [];
    for (let i = 0; i < 230; i++) {
      const r = await chatJoin(ip(1), D, 'Main Hall', 'c' + i);
      if (r.status === 200) chatOk++; else chatDenied.push(r);
    }
    check(chatOk === 10, 'one source holds exactly SOURCE_MAX_CHAT_PER_DOMAIN (10) of the 200 chat seats (accepted ' + chatOk + ')');
    check(chatDenied.every((r) => r.status === 429 && r.body.reason !== undefined && r.headers['retry-after']), 'chat refusals are 429 with Retry-After');
    const legitChat = await chatJoin(ip(2), D, 'Main Hall', 'LegitUser');
    check(legitChat.status === 200 && legitChat.body.messages !== undefined, 'a legitimate visitor from another source still joins the domain chat');

    console.log('STEP 3: a join-rate cooldown is per source and per kind');
    const stillBlocked = await join(ip(1), D, 'Main Hall', 'again');
    check(stillBlocked.status === 429 && stillBlocked.body.reason === 'join-rate-limited', 'the flooding source is in cooldown for presence');
    const other = await join(ip(7), D, 'Other Room', 'Seven');
    check(other.status === 200, 'a different source is unaffected by that cooldown');

    console.log('STEP 4: forwarded-for headers are ignored');
    let xffOk = 0; const xffDenied = [];
    for (let i = 0; i < 16; i++) {
      const r = await join(ip(3), D, 'xff-room', 'x' + i, { 'X-Forwarded-For': '203.0.113.' + (i + 1) + ', 10.0.0.' + i, 'X-Real-IP': '198.51.100.' + (i + 1), 'Forwarded': 'for=192.0.2.' + (i + 1), 'CF-Connecting-IP': '203.0.113.' + (100 + i) });
      if (r.status === 200) xffOk++; else xffDenied.push(r);
    }
    check(xffOk === 10 && xffDenied.length === 6 && xffDenied.every((r) => r.body.reason === 'source-limit'), 'rotating X-Forwarded-For / X-Real-IP / Forwarded / CF-Connecting-IP does not buy more sessions (accepted ' + xffOk + ')');
    const xffChat = [];
    for (let i = 0; i < 12; i++) xffChat.push(await chatJoin(ip(3), 'xff.example', 'w', 'y' + i, { 'X-Forwarded-For': '203.0.113.' + (i + 1) }));
    check(xffChat.filter((r) => r.status === 200).length === 10, 'and the same for chat');

    console.log('STEP 5: two legitimate simultaneous wallets, and a small shared-address group');
    const w1 = await join(ip(5), 'wallets.example', 'hall', 'Wallet One');
    const w2 = await join(ip(5), 'wallets.example', 'hall', 'Wallet Two');
    check(w1.status === 200 && w2.status === 200 && w2.body.roster.some((m) => m.name === 'Wallet One'), 'two sessions from one address both join and see each other');
    check(await status('wallets.example', 'hall') === 2, 'both are counted');
    let schoolOk = 0;
    for (let i = 0; i < 8; i++) if ((await join(ip(6), 'school.example', 'class', 'Pupil ' + i)).status === 200) schoolOk++;
    check(schoolOk === 8, 'eight visitors behind one shared address all join (below the per-source room share)');

    console.log('STEP 6: rapid world switching and reconnects');
    let switchOk = 0;
    let prev = null;
    for (let i = 0; i < 40; i++) {
      const r = await join(ip(8), 'switch.example', 'world ' + (i % 5) + '/大', 'Switcher');
      if (r.status === 200) switchOk++;
      if (prev) await leave(ip(8), prev); // the client joins the next world, then leaves the previous one
      prev = r.body && r.body.id;
    }
    await leave(ip(8), prev);
    check(switchOk === 40, '40 world switches in quick succession (join new, leave old) are all admitted');
    let live = 0; for (let w = 0; w < 5; w++) live += await status('switch.example', 'world ' + w + '/大');
    check(live === 0, 'explicit leaves release the sessions (nothing left counted)');
    const reconnect = [];
    for (let i = 0; i < 3; i++) reconnect.push(await join(ip(8), 'switch.example', 'reconnect', 'Flaky')); // reconnect without leaving: old sessions linger until they time out
    check(reconnect.every((r) => r.status === 200), 'reconnects while the old session lingers are admitted (the share cap, not a duplicate check, bounds them)');
    check(await status('switch.example', 'reconnect') === 3, 'lingering sessions are counted, bounded by the per-source cap');
    for (const r of reconnect) await leave(ip(8), r.body.id);

    console.log('STEP 7: official-title display names');
    for (const name of BAD_NAMES) {
      const r = await join(ip(9), D, 'names', name);
      check(r.status === 400 && r.body.reason === 'name-not-allowed' && /official title/.test(r.body.error), 'presence refuses "' + name + '"');
    }
    check(await status(D, 'names') === 0, 'refused names create no session');
    const chatBad = await chatJoin(ip(9), 'names.example', 'w', 'Moderator (official)');
    check(chatBad.status === 400 && chatBad.body.reason === 'name-not-allowed', 'chat refuses a moderator-style name too');
    for (const name of GOOD_NAMES) {
      const r = await join(ip(9), D, 'names', name);
      check(r.status === 200, 'presence admits "' + name + '"');
      await leave(ip(9), r.body.id);
    }
    const defaultName = await join(ip(9), D, 'names', '');
    check(defaultName.status === 200 && defaultName.body.roster !== undefined, 'an empty name still becomes the default "Visitor"');

    console.log('STEP 8: DA-002 shapes are unchanged');
    check(Object.keys(w2.body).sort().join(',') === 'id,publicId,roster', 'join response is exactly id, publicId, roster');
    check(Object.keys(w2.body.roster[0]).sort().join(',') === 'hatColor,id,name,pantsColor,shirtColor,shoeColor,shoeScale,x,y,yaw,z', 'roster entries expose only id, name, pose and look');
    check(JSON.stringify((await rq(ip(250), 'GET', '/presence/status?domain=wallets.example&world=hall')).body) === '{"count":2}', 'status is exactly a count');
    check(!seen.some((t) => /"publicKey"/.test(t)), 'no response carries a publicKey field');

    // ================= B: cooldown, escalation, recovery, restart =================
    console.log('SETUP: tight rate limits (20 joins/window, 1.5 s base cooldown, 6 s cap)');
    await fresh(Object.assign({}, BASE_ENV, { SOURCE_JOIN_MAX: '20', SOURCE_COOLDOWN_MS: '1500', SOURCE_COOLDOWN_MAX_MS: '6000' }));
    async function trip(src, room) {
      const tokens = []; let last = null;
      for (let i = 0; i < 25; i++) {
        const r = await join(src, 'cd.example', room, 'n' + i);
        if (r.status === 200) tokens.push(r.body.id);
        if (r.body && r.body.reason === 'join-rate-limited') { last = r; break; }
      }
      for (const t of tokens) await leave(src, t);
      return last;
    }
    console.log('STEP 9: cooldown length doubles on repeat offences, is capped, and recovers');
    const t1 = await trip(ip(1), 'a');
    check(t1 && t1.headers['retry-after'] === '2', 'first offence: cooldown 1.5 s, Retry-After 2');
    const during = await join(ip(1), 'cd.example', 'a', 'late');
    check(during.status === 429 && during.body.reason === 'join-rate-limited', 'attempts during the cooldown are refused');
    await sleep(1700);
    const t2 = await trip(ip(1), 'a');
    check(t2 && t2.headers['retry-after'] === '3', 'second offence inside the strike memory: cooldown 3 s, Retry-After 3');
    await sleep(3200);
    const t3 = await trip(ip(1), 'a');
    check(t3 && t3.headers['retry-after'] === '6', 'third offence: cooldown capped at 6 s, Retry-After 6');
    await sleep(6200);
    const after = await join(ip(1), 'cd.example', 'a', 'back');
    check(after.status === 200, 'after the cooldown the source is admitted again (nothing permanent)');
    await leave(ip(1), after.body.id);
    check((await join(ip(2), 'cd.example', 'a', 'other')).status === 200, 'another source was never affected');

    console.log('STEP 10: server restart');
    const t4 = await trip(ip(1), 'a');
    check(t4 && t4.headers['retry-after'] === '6', 'a fresh offence puts the source back in cooldown');
    await stop();
    await start(Object.assign({}, BASE_ENV, { SOURCE_JOIN_MAX: '20', SOURCE_COOLDOWN_MS: '1500', SOURCE_COOLDOWN_MAX_MS: '6000' }));
    const post = await join(ip(1), 'cd.example', 'a', 'restart');
    if (MODE === 'node') check(post.status === 200, 'Node: rate-limit state is memory only, so a restart clears it');
    else check(post.status === 429 && post.body.reason === 'join-rate-limited', 'PHP: the cooldown is in the rate-limit store file and survives a restart');

    // ================= C: bigger shared group via configuration =================
    console.log('SETUP: SOURCE_MAX_PRESENCE_PER_ROOM=50 for a campus-sized shared address');
    await fresh(Object.assign({}, BASE_ENV, { SOURCE_MAX_PRESENCE_PER_ROOM: '50', SOURCE_MAX_PRESENCE: '60', SOURCE_JOIN_MAX: '200', SOURCE_SOFT_FULL_MAX: '100' }));
    console.log('STEP 11: the shared-address limit is configurable');
    let campus = 0;
    for (let i = 0; i < 40; i++) if ((await join(ip(1), 'campus.example', 'quad', 'Student ' + i)).status === 200) campus++;
    check(campus === 40, '40 visitors behind one address are admitted once the operator raises the limit');

    // ================= D: fairness near capacity, room full =================
    console.log('SETUP: 10-seat rooms (80% soft threshold, 2 sessions per source beyond it)');
    await fresh(Object.assign({}, BASE_ENV, { MAX_MEMBERS_PER_ROOM: '10', MAX_CHAT_MEMBERS_PER_DOMAIN: '10', SOURCE_SOFT_FULL_MAX: '2' }));
    console.log('STEP 12: fair allocation near capacity and a defined "room full"');
    for (const n of [2, 3, 4, 5]) for (let i = 0; i < 2; i++) await join(ip(n), 'fair.example', 'room', 'm' + n + i);
    check(await status('fair.example', 'room') === 8, 'four sources hold two seats each (8 of 10)');
    const greedy = await join(ip(2), 'fair.example', 'room', 'more');
    check(greedy.status === 429 && greedy.body.reason === 'source-limit', 'at 80% a source already holding 2 is refused, keeping seats for others');
    const n1 = await join(ip(6), 'fair.example', 'room', 'newcomer1');
    const n2 = await join(ip(6), 'fair.example', 'room', 'newcomer2');
    check(n1.status === 200 && n2.status === 200, 'a source holding none is still admitted up to its share');
    check(await status('fair.example', 'room') === 10, 'the room is now full');
    const full = await join(ip(7), 'fair.example', 'room', 'late');
    check(full.status === 503 && full.body.reason === 'room-full' && full.headers['retry-after'] === '10' && /full/.test(full.body.error), 'a genuinely full room answers 503 room-full with Retry-After and a readable message');
    check(await status('fair.example', 'room') === 10, 'refused joins never change the count');
    for (const n of [2, 3, 4, 5]) for (let i = 0; i < 2; i++) await chatJoin(ip(n), 'fair.example', 'room', 'c' + n + i);
    const chatGreedy = await chatJoin(ip(2), 'fair.example', 'room', 'more');
    check(chatGreedy.status === 429 && chatGreedy.body.reason === 'source-limit', 'chat applies the same fair-share rule');
    await chatJoin(ip(6), 'fair.example', 'room', 'cn1'); await chatJoin(ip(6), 'fair.example', 'room', 'cn2');
    const chatFull = await chatJoin(ip(7), 'fair.example', 'room', 'late');
    check(chatFull.status === 503 && chatFull.body.reason === 'room-full', 'a full chat domain answers 503 room-full');

    // ================= E: expiry =================
    console.log('SETUP: 1.5 s session timeout, 5 joins per 1.5 s window, 3 sessions per room');
    await fresh({ POLL_TIMEOUT_MS: '1500', POLL_SWEEP_INTERVAL_MS: '300', SOURCE_JOIN_MAX: '5', SOURCE_JOIN_WINDOW_MS: '1500', SOURCE_COOLDOWN_MS: '2000', SOURCE_MAX_PRESENCE_PER_ROOM: '3' });
    console.log('STEP 13: sessions and rate-limit history expire on their own');
    const e1 = [];
    for (let i = 0; i < 5; i++) e1.push(await join(ip(1), 'exp.example', 'r', 'e' + i));
    check(e1.filter((r) => r.status === 200).length === 3 && e1.slice(3).every((r) => r.body.reason === 'source-limit'), 'three sessions admitted, the next two refused at the share cap');
    check((await join(ip(1), 'exp.example', 'r', 'e5')).body.reason === 'join-rate-limited', 'the sixth attempt in the window is rate limited');
    await sleep(3000);
    check(await status('exp.example', 'r') === 0, 'abandoned sessions time out and stop being counted');
    const e2 = [];
    for (let i = 0; i < 3; i++) e2.push(await join(ip(1), 'exp.example', 'r', 'f' + i));
    check(e2.every((r) => r.status === 200), 'the same source is admitted again after sessions and its cooldown expire');
    const kept = await join(ip(2), 'exp.example', 'kept', 'Keeper');
    for (let i = 0; i < 4; i++) { await sleep(600); await rq(ip(2), 'POST', '/presence/poll/sync', { id: kept.body.id, x: 0, y: 0, z: 0, yaw: 0 }); }
    check(await status('exp.example', 'kept') === 1, 'a session that keeps syncing stays alive and counted');

    // ================= unit: source keys =================
    console.log('STEP 14: source key derivation');
    const addrs = ['127.0.0.1', '::ffff:127.0.0.1', '::1', '2001:db8:1:2::1', '2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:3::1', '127.0.0.2', '::ffff:7f00:2'];
    let keys;
    if (MODE === 'node') {
      process.env.PORT = '0';
      const mod = require(path.join(ROOT, 'presence-server', 'server.js'));
      keys = addrs.map((a) => mod.sourceKeyOf(a));
    } else {
      const code = "require(" + JSON.stringify(path.join(ROOT, 'presence-php/presence/lib/store.php')) + "); $s='salt'; echo json_encode(array_map(function($a) use ($s){return presence_source_hash($a,$s);}, json_decode(" + JSON.stringify(JSON.stringify(addrs)) + ", true)));";
      keys = JSON.parse(execFileSync('php', ['-r', code]).toString());
    }
    check(keys[0] === keys[1], 'an IPv4-mapped IPv6 peer is the same source as its IPv4 address');
    check(keys[3] === keys[4] && keys[3] !== keys[5], 'IPv6 peers are grouped by /64');
    check(keys[0] !== keys[2] && keys[0] !== keys[6], 'distinct addresses are distinct sources');
    check(keys.every((k) => /^[0-9a-f]{16}$/.test(k)) && !keys.some((k) => addrs.includes(k)), 'keys are 16 hex characters of an HMAC, never the address');
    check(keys[6] === keys[7], 'the hex spelling of a mapped IPv4 peer is also folded to the IPv4 source');

    // ================= privacy of stored/returned state =================
    console.log('STEP 15: source data never leaves the server');
    check(!seen.some((t) => /127\.0\.0\.\d|::1\b/.test(t)), 'no response body (' + seen.length + ' captured) contains a peer address');
    if (MODE === 'php') {
      const lib = path.join(phpDir, 'presence/lib');
      const files = fs.readdirSync(lib).filter((f) => /^atlas-.*\.json$/.test(f));
      check(files.includes('atlas-presence-ratelimit-store.json'), 'the rate-limit table is its own file in lib/ (' + files.join(', ') + ')');
      const all = files.map((f) => fs.readFileSync(path.join(lib, f), 'utf8')).join('\n');
      check(!/127\.0\.0\.\d|::1\b/.test(all) && !/publicKey/.test(all), 'no state file holds a raw address or a wallet key');
      const rl = JSON.parse(fs.readFileSync(path.join(lib, 'atlas-presence-ratelimit-store.json'), 'utf8'));
      check(Object.keys(rl.sources).every((k) => /^[0-9a-f]{16}$/.test(k)) && Object.keys(rl.sources).length <= 20, 'the table holds only hashed keys and stays small (' + Object.keys(rl.sources).length + ' entries)');
      const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
      check(/presence-php\/presence\/lib\/atlas-\*\.json/.test(gitignore), 'the new state file is covered by .gitignore');
      cleanupDirs.push(phpDir);
    }

    if (MODE === 'node') await wsSection();

    console.log('\nPRESENCE ABUSE CHECKS PASSED (' + MODE + ')');
  } catch (err) {
    console.log(err.message || err);
    process.exitCode = 1;
  } finally {
    await stop();
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) {} }
    process.exit(process.exitCode || 0);
  }
})();

// ---------- WebSocket (Node only) ----------

function wsOpen(src, headers) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: PORT, localAddress: src });
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const frames = []; const waiters = [];
    function pump() {
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) return;
        const op = buf[0] & 0x0f;
        const payload = buf.slice(off, off + len); buf = buf.slice(off + len);
        if (op === 1) { const obj = JSON.parse(payload.toString('utf8')); seen.push(JSON.stringify(obj)); if (waiters.length) waiters.shift()(obj); else frames.push(obj); }
      }
    }
    const api = {
      socket: sock,
      send(obj) {
        const p = Buffer.from(JSON.stringify(obj)); const mask = crypto.randomBytes(4);
        const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
        const masked = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ mask[i % 4];
        sock.write(Buffer.concat([head, mask, masked]));
      },
      next(ms) { return new Promise((res) => { if (frames.length) return res(frames.shift()); const t = setTimeout(() => res(null), ms || 1500); waiters.push((o) => { clearTimeout(t); res(o); }); }); },
      close() { try { sock.destroy(); } catch (err) {} }
    };
    sock.on('error', reject);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end).toString();
        buf = buf.slice(end + 4);
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)[1]);
        const retry = /retry-after: *(\d+)/i.exec(head);
        if (status !== 101) { sock.destroy(); resolve({ refused: true, status, retryAfter: retry && retry[1] }); return; }
        upgraded = true;
        resolve(api);
      }
      pump();
    });
    const extra = Object.entries(headers || {}).map(([k, v]) => k + ': ' + v + '\r\n').join('');
    sock.write('GET /presence HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n' + extra + '\r\n');
  });
}

async function wsSection() {
  console.log('SETUP: node WebSocket checks (default limits, 100 sockets per source)');
  await fresh(Object.assign({}, BASE_ENV, { SOURCE_MAX_SOCKETS: '100' }));
  console.log('STEP 16: WebSocket presence and chat floods, forwarded-for ignored');
  const socks = []; let welcomed = 0; const denials = [];
  for (let i = 0; i < 30; i++) {
    const s = await wsOpen(ip(20), { 'X-Forwarded-For': '203.0.113.' + (i + 1) });
    s.send({ type: 'join', domain: 'ws.example', world: 'plaza', name: 'w' + i });
    const m = await s.next();
    if (m && m.type === 'welcome') welcomed++; else denials.push(m);
    socks.push(s);
  }
  check(welcomed === 10, 'WebSocket: one source gets 10 presence sessions out of 30 attempts (' + welcomed + ')');
  check(denials.length === 20 && denials.every((m) => m.type === 'join-denied' && m.reason === 'source-limit' && /Too many sessions/.test(m.message) && m.retryAfter > 0), 'denials are join-denied with reason, readable message and retryAfter');
  check(await status('ws.example', 'plaza') === 10, 'status counts 10, not 30');
  socks.slice(0, 10).forEach((s) => s.close());
  await sleep(300);
  check(await status('ws.example', 'plaza') === 0, 'dropping the connections releases the seats at once, without waiting for the heartbeat');
  const again = await wsOpen(ip(20));
  again.send({ type: 'join', domain: 'ws.example', world: 'plaza', name: 'back' });
  const back = await again.next();
  check(back && back.type === 'welcome', 'after the sockets close, the same source can join again (counts are derived from live members)');
  socks.forEach((s) => s.close()); again.close();

  let chatOk = 0; const chatErr = []; const cs = [];
  for (let i = 0; i < 30; i++) {
    const s = await wsOpen(ip(21));
    s.send({ type: 'chat-join', domain: 'ws.example', world: 'plaza', name: 'c' + i });
    const m = await s.next();
    if (m && m.type === 'chat-history') chatOk++; else chatErr.push(m);
    cs.push(s);
  }
  check(chatOk === 10 && chatErr.every((m) => m.type === 'chat-error' && m.reason === 'source-limit' && m.message && m.retryAfter > 0), 'WebSocket chat: 10 of 30 chat joins from one source, the rest chat-error source-limit');
  cs.forEach((s) => s.close());

  const bad = await wsOpen(ip(22));
  bad.send({ type: 'join', domain: 'ws.example', world: 'plaza', name: 'Moderator (official)' });
  const badRes = await bad.next();
  check(badRes && badRes.type === 'join-denied' && badRes.reason === 'name-not-allowed', 'WebSocket: a moderator-style name is refused');
  bad.send({ type: 'chat-join', domain: 'ws.example', world: 'plaza', name: 'Admin' });
  const badChat = await bad.next();
  check(badChat && badChat.type === 'chat-error' && badChat.reason === 'name-not-allowed', 'WebSocket chat: the same');
  bad.close();

  console.log('STEP 17: both transports share one budget');
  const mixed = [];
  for (let i = 0; i < 5; i++) { const s = await wsOpen(ip(23)); s.send({ type: 'join', domain: 'mix.example', world: 'm', name: 'ws' + i }); await s.next(); mixed.push(s); }
  let pollOk = 0; for (let i = 0; i < 6; i++) if ((await join(ip(23), 'mix.example', 'm', 'p' + i)).status === 200) pollOk++;
  check(pollOk === 5, 'five WebSocket and five polling sessions fill one source\'s share; the sixth polling join is refused (' + pollOk + ' polling accepted)');
  mixed.forEach((s) => s.close());

  console.log('STEP 18: idle WebSocket connections per source');
  await fresh(Object.assign({}, BASE_ENV, { SOURCE_MAX_SOCKETS: '5' }));
  const idle = [];
  for (let i = 0; i < 5; i++) idle.push(await wsOpen(ip(30)));
  const sixth = await wsOpen(ip(30));
  check(sixth.refused && sixth.status === 429 && sixth.retryAfter === '10', 'the 6th open socket from one source is refused with 429 and Retry-After');
  const otherSock = await wsOpen(ip(31));
  check(!otherSock.refused, 'another source can still open a socket');
  idle[0].close(); await sleep(300);
  const seventh = await wsOpen(ip(30));
  check(!seventh.refused, 'closing a socket frees a slot');
  [...idle, otherSock, seventh].forEach((s) => s.close && s.close());
}
