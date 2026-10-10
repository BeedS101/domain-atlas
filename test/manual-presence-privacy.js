// Manual check for the presence server's privacy and resource contract, run
// against the Node server or the PHP bundle:
//
//   node test/manual-presence-privacy.js node
//   node test/manual-presence-privacy.js php
//
// Presence and chat carry no wallet identity: no public key in any join,
// roster, broadcast, status or chat payload, and nothing key-shaped on disk;
// a member's public avatar id is not the secret that authenticates its poll
// session; a new connection is always a new participant (no duplicate-session
// handling); the friend-signal and duplicate-join routes are gone; status is
// a count; chat history is bounded by age; stale records are swept from every
// room; and the resource limits refuse overload rather than grow.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MODE = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = MODE === 'php' ? 8272 : 8271;
const BASE = 'http://localhost:' + PORT;
const ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'presence-php');
const STORE_DIR = path.join(BUNDLE_DIR, 'presence', 'lib');
const STORES = ['atlas-presence-store.json', 'atlas-chat-store.json'].map((f) => path.join(STORE_DIR, f));

const LEGACY_KEY = 'LEGACYKEY_' + 'Q'.repeat(60);
const KEY = 'WALLETKEY_' + 'Z'.repeat(60); // stands in for a real public key a hostile or old client might send
const POLL_TIMEOUT_MS = 2000;
const CHAT_TTL_MS = 1500;
const LIMITS = { MAX_MEMBERS_PER_ROOM: 3, MAX_ROOMS: 4, MAX_CHAT_MEMBERS_PER_DOMAIN: 3, MAX_CHAT_DOMAINS: 3, MAX_BODY_BYTES: 2048, CHAT_MIN_INTERVAL_MS: 300, SOURCE_SOFT_FULL_MAX: 1000 };

function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('PASS: ' + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(p, body, raw) {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw !== undefined ? raw : JSON.stringify(body || {}) });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (err) {}
  return { status: res.status, body: json, text, headers: res.headers };
}
async function get(p) {
  const res = await fetch(BASE + p);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) {}
  return { status: res.status, body: json, text, headers: res.headers };
}

async function start() {
  const env = Object.assign({}, process.env, { POLL_TIMEOUT_MS: String(POLL_TIMEOUT_MS), POLL_SWEEP_INTERVAL_MS: '300', CHAT_HISTORY_TTL_MS: String(CHAT_TTL_MS) }, Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, String(v)])));
  if (MODE === 'php') {
    for (const f of STORES) { try { fs.unlinkSync(f); } catch (err) {} }
    // Records written by an earlier version of the bundle: keys, friend-signal queues, activity clocks.
    const nowMs = Date.now();
    fs.writeFileSync(STORES[0], JSON.stringify({ rooms: { 'legacy.example::room': { oldtoken1: { name: 'Old', publicKey: LEGACY_KEY, x: 0, y: 0, z: 0, yaw: 0, lastSeen: nowMs, lastActivityAt: nowMs, pendingSignals: [{ type: 'signal', kind: 'friend-request', publicKey: LEGACY_KEY }] } } }, challenges: { c: { publicKey: LEGACY_KEY } }, duplicateJoinLosses: {} }));
    fs.writeFileSync(STORES[1], JSON.stringify({ domains: { 'legacy.example': { nextSeq: 1, history: [{ seq: 1, id: 'm1', world: 'room', name: 'Old', publicKey: LEGACY_KEY, text: 'old message', sentAt: new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z') }], members: {} } } }));
    const proc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
      proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
      proc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
    });
    return proc;
  }
  env.PORT = String(PORT);
  const proc = spawn('node', [path.join(ROOT, 'presence-server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence server did not start in time')), 5000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('presence server exited early with code ' + code)));
  });
  return proc;
}

function noKeyIn(label, value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  check(!s.includes(KEY) && !s.includes(LEGACY_KEY) && !/"publicKey"/.test(s), label + ' carries no wallet key and no publicKey field');
}

(async () => {
  console.log('SETUP: starting ' + MODE + ' presence on port ' + PORT);
  const proc = await start();
  try {
    // ---- STEP 1: nothing key-shaped in any presence payload
    console.log('STEP 1: a join that offers a wallet key (as an older client would) never has it echoed, broadcast or counted');
    const a = await post('/presence/poll/join', { domain: 'example.com', world: 'lobby', name: 'Alice', publicKey: KEY });
    check(a.status === 200 && a.body.id && a.body.publicId, 'join returns a private id and a separate publicId');
    check(a.body.id !== a.body.publicId, 'the private connection token differs from the public avatar id');
    noKeyIn('join response', a.text);
    const b = await post('/presence/poll/join', { domain: 'example.com', world: 'lobby', name: 'Bob' });
    check(b.body.roster.length === 1 && b.body.roster[0].id === a.body.publicId && b.body.roster[0].name === 'Alice', 'a second joiner sees Alice by her publicId and name');
    check(Object.keys(b.body.roster[0]).sort().join(',') === 'hatColor,id,name,pantsColor,shirtColor,shoeColor,shoeScale,x,y,yaw,z', 'roster entries expose only id, name, pose and look');
    noKeyIn('roster', b.text);
    const sync = await post('/presence/poll/sync', { id: b.body.id, x: 1, y: 0, z: 2, yaw: 0.5 });
    noKeyIn('sync response', sync.text);
    check(sync.body.roster.length === 1 && sync.body.signals === undefined, 'sync returns the roster only (no signals channel)');
    const st = await get('/presence/status?domain=example.com&world=lobby');
    check(st.status === 200 && JSON.stringify(st.body) === '{"count":2}', 'status is exactly a count');
    noKeyIn('status', st.text);

    if (MODE === 'php') {
      console.log('STEP 1b: records an earlier version wrote are scrubbed on first use');
      const legacyChat = await post('/presence/poll/chat-join', { domain: 'legacy.example', world: 'room', name: 'New' });
      check(legacyChat.body.messages.length === 1 && legacyChat.body.messages[0].text === 'old message', 'old chat history is still served');
      noKeyIn('migrated chat history', legacyChat.text);
      noKeyIn('presence store after first request', fs.readFileSync(STORES[0], 'utf8'));
      check(!/LEGACYKEY|pendingSignals|challenges/.test(fs.readFileSync(STORES[0], 'utf8') + fs.readFileSync(STORES[1], 'utf8')), 'neither store file keeps the old key, signal queues or challenges');
    }

    // ---- STEP 2: the public id is not a credential
    console.log('STEP 2: knowing another member\'s public avatar id lets nobody move, sync as, or remove them');
    const bobBefore = (await post('/presence/poll/sync', { id: a.body.id })).body.roster.find((m) => m.name === 'Bob');
    const puppet = await post('/presence/poll/sync', { id: a.body.publicId, x: 99, y: 99, z: 99, yaw: 1 });
    check(puppet.status === 404, 'sync with a publicId is refused (404)');
    const bobId = bobBefore.id;
    const puppetBob = await post('/presence/poll/sync', { id: bobId, x: 50, y: 0, z: 50, yaw: 0 });
    check(puppetBob.status === 404, 'sync with Bob\'s publicId is refused');
    await post('/presence/poll/leave', { id: bobId });
    const stillThere = await post('/presence/poll/sync', { id: a.body.id });
    check(stillThere.body.roster.some((m) => m.id === bobId), 'leave with a publicId does not remove the member');
    const bobPose = stillThere.body.roster.find((m) => m.id === bobId);
    check(bobPose.x === 1 && bobPose.z === 2, 'Bob\'s pose is untouched by the spoofed sync');

    // ---- STEP 3: reconnect and duplicate sessions
    console.log('STEP 3: connecting twice is two independent participants — no duplicate-session handling');
    const b2 = await post('/presence/poll/join', { domain: 'example.com', world: 'lobby', name: 'Alice', publicKey: KEY });
    check(b2.status === 200 && b2.body.status === undefined && b2.body.roster.length === 2, 'a second join with the same name and key is admitted immediately, alongside the first');
    check(b2.body.publicId !== a.body.publicId && b2.body.id !== a.body.id, 'it gets fresh, unrelated ids');
    await post('/presence/poll/leave', { id: b2.body.id });
    const afterLeave = await post('/presence/poll/sync', { id: a.body.id });
    check(afterLeave.status === 200 && afterLeave.body.roster.some((m) => m.name === 'Bob') && !afterLeave.body.roster.some((m) => m.id === b2.body.publicId), 'leaving one session removes only that session');

    // ---- STEP 4: removed routes
    console.log('STEP 4: friend signalling and duplicate-join routes no longer exist');
    for (const route of ['signal', 'join-status', 'duplicate-response', 'activity']) {
      const r = await post('/presence/poll/' + route, { id: a.body.id, to: bobId, kind: 'friend-request', publicKey: KEY, name: 'x', challengeId: 'x' });
      check(!(r.body && (r.body.ok === true || r.body.status)), '/presence/poll/' + route + ' is gone (' + r.status + ')');
    }

    // ---- STEP 5: CORS only on status
    console.log('STEP 5: cross-origin access is opened for the status count only');
    check(st.headers.get('access-control-allow-origin') === '*', 'status sends Access-Control-Allow-Origin');
    check(a.headers.get('access-control-allow-origin') === null, 'join does not');
    const pre = await fetch(BASE + '/presence/poll/join', { method: 'OPTIONS' });
    check(pre.status === 204, 'OPTIONS answers 204');

    // ---- STEP 6: chat carries no identity
    console.log('STEP 6: chat messages and history carry a per-join sender id and a display name, never a key');
    const c1 = await post('/presence/poll/chat-join', { domain: 'example.com', world: 'lobby', name: 'Alice', publicKey: KEY });
    check(c1.status === 200 && c1.body.id && c1.body.senderId && c1.body.id !== c1.body.senderId, 'chat-join returns a private id and a separate senderId');
    noKeyIn('chat-join response', c1.text);
    const sent = await post('/presence/poll/chat-send', { id: c1.body.id, text: 'hello there' });
    check(sent.body.ok === true && sent.body.message.senderId === c1.body.senderId && sent.body.message.name === 'Alice', 'a joined member can send; the message carries senderId and name');
    check(!('publicKey' in sent.body.message), 'the message has no publicKey field');
    const c2 = await post('/presence/poll/chat-join', { domain: 'example.com', world: 'plaza', name: 'Alice' });
    check(c2.body.senderId !== c1.body.senderId, 'the same name joining again gets a different senderId');
    check(c2.body.messages.length === 1 && c2.body.messages[0].senderId === c1.body.senderId, 'history is delivered to a later joiner with senderIds only');
    noKeyIn('chat history', c2.text);
    const keyless = await post('/presence/poll/chat-send', { id: c2.body.id, text: 'no wallet needed server-side' });
    check(keyless.body.ok === true, 'sending does not depend on any wallet claim (the server never could verify one)');
    const fast = await post('/presence/poll/chat-send', { id: c2.body.id, text: 'too soon' });
    check(fast.body.ok === false && fast.body.reason === 'rate-limited', 'a second message inside the minimum interval is refused as rate-limited');
    await sleep(LIMITS.CHAT_MIN_INTERVAL_MS + 100);
    const bad = await post('/presence/poll/chat-send', { id: c2.body.id, text: 'you piss me off' });
    check(bad.body.ok === false && bad.body.reason === 'blocked', 'the server word filter still applies');
    await sleep(LIMITS.CHAT_MIN_INTERVAL_MS + 100);
    const empty = await post('/presence/poll/chat-send', { id: c2.body.id, text: '  \u0007  ' });
    check(empty.body.ok === false && empty.body.reason === 'empty', 'control characters are stripped and an empty message refused');
    const syncChat = await post('/presence/poll/chat-sync', { id: c1.body.id });
    check(syncChat.body.messages.length === 1 && syncChat.body.messages[0].text === 'no wallet needed server-side', 'chat-sync delivers what the other member sent');

    // ---- STEP 7: nothing key-shaped on disk (PHP) / ids unguessable
    if (MODE === 'php') {
      console.log('STEP 7: the PHP store files hold no key');
      for (const f of STORES) {
        const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
        check(text.length > 0 && !text.includes(KEY) && !/publicKey/.test(text), path.basename(f) + ' has no wallet key and no publicKey field');
      }
    }

    // ---- STEP 8: bounded chat history (age)
    console.log('STEP 8: chat history expires by age');
    await sleep(CHAT_TTL_MS + 400);
    const late = await post('/presence/poll/chat-join', { domain: 'example.com', world: 'lobby', name: 'Late' });
    check(late.status === 200 && late.body.messages.length === 0, 'a joiner after the TTL gets no old messages');

    // ---- STEP 9: stale members are swept from every room
    console.log('STEP 9: abandoned members are removed from rooms nobody touches again');
    await post('/presence/poll/join', { domain: 'stale.example', world: 'quiet', name: 'Ghost', publicKey: KEY });
    check((await get('/presence/status?domain=stale.example&world=quiet')).body.count === 1, 'the ghost is present at first');
    await sleep(POLL_TIMEOUT_MS + 700);
    await post('/presence/poll/join', { domain: 'other.example', world: 'busy', name: 'Other' }); // touches a different room only
    if (MODE === 'php') {
      const text = fs.readFileSync(STORES[0], 'utf8');
      check(!text.includes('Ghost'), 'the ghost record is gone from the store file after an unrelated request');
    }
    check((await get('/presence/status?domain=stale.example&world=quiet')).body.count === 0, 'status reports the abandoned room as empty');

    // ---- STEP 10: resource limits
    console.log('STEP 10: limits refuse overload');
    await sleep(POLL_TIMEOUT_MS + 700); // let every earlier room and chat member expire so the caps start from zero
    const joins = [];
    for (let i = 0; i < LIMITS.MAX_MEMBERS_PER_ROOM; i++) joins.push(await post('/presence/poll/join', { domain: 'cap.example', world: 'full', name: 'm' + i }));
    check(joins.every((j) => j.status === 200), 'a room admits up to MAX_MEMBERS_PER_ROOM');
    const over = await post('/presence/poll/join', { domain: 'cap.example', world: 'full', name: 'extra' });
    check(over.status === 503 && over.body.reason === 'room-full', 'the next join is refused with room-full');
    await post('/presence/poll/join', { domain: 'r2.example', world: 'x', name: 'r2' });
    await post('/presence/poll/join', { domain: 'r3.example', world: 'x', name: 'r3' });
    await post('/presence/poll/join', { domain: 'r4.example', world: 'x', name: 'r4' });
    const tooMany = await post('/presence/poll/join', { domain: 'r5.example', world: 'x', name: 'r5' });
    check(tooMany.status === 503 && tooMany.body.reason === 'server-busy', 'a new room beyond MAX_ROOMS is refused with server-busy');
    for (const bad of [{ domain: 'bad\ndomain', world: 'x' }, { domain: 'x'.repeat(121), world: 'x' }, { domain: '', world: 'x' }, { domain: 'ok.example', world: '' }, { domain: 'ok.example', world: 'a\u0000b' }]) {
      const r = await post('/presence/poll/join', bad);
      check(r.status === 400, 'invalid domain/world ' + JSON.stringify(bad).slice(0, 48) + ' is refused (400)');
    }
    const big = await post('/presence/poll/join', null, JSON.stringify({ domain: 'big.example', world: 'x', name: 'n'.repeat(LIMITS.MAX_BODY_BYTES + 100) }));
    check(big.status === 413, 'a request body over MAX_BODY_BYTES is refused (413)');
    const longName2 = await post('/presence/poll/join', { domain: 'r3.example', world: 'x', name: 'N'.repeat(500) + '\u0001' });
    check(longName2.status === 200 && longName2.body.roster.every((m) => m.name.length <= 60 && !/[\u0000-\u001f]/.test(m.name)), 'names are bounded and stripped of control characters');
    const cj = [];
    for (let i = 0; i < LIMITS.MAX_CHAT_MEMBERS_PER_DOMAIN; i++) cj.push(await post('/presence/poll/chat-join', { domain: 'chatcap.example', world: 'x', name: 'c' + i }));
    check(cj.every((j) => j.status === 200), 'a chat domain admits up to MAX_CHAT_MEMBERS_PER_DOMAIN');
    const cOver = await post('/presence/poll/chat-join', { domain: 'chatcap.example', world: 'x', name: 'extra' });
    check(cOver.status === 503 && cOver.body.reason === 'room-full', 'the next chat join is refused');
    await post('/presence/poll/chat-join', { domain: 'cd2.example', world: 'x', name: 'c' });
    await post('/presence/poll/chat-join', { domain: 'cd3.example', world: 'x', name: 'c' });
    const cBusy = await post('/presence/poll/chat-join', { domain: 'cd4.example', world: 'x', name: 'c' });
    check(cBusy.status === 503, 'a new chat domain beyond MAX_CHAT_DOMAINS is refused');

    // ---- STEP 11: WebSocket (Node only)
    if (MODE === 'node') {
      console.log('STEP 11: WebSocket join carries no key and an oversized frame is dropped');
      await sleep(POLL_TIMEOUT_MS + 700); // earlier poll rooms must expire so the room cap leaves space
      const open = () => new Promise((res, rej) => { const w = new WebSocket('ws://localhost:' + PORT + '/presence'); w.onopen = () => res(w); w.onerror = rej; });
      const next = (w, type) => new Promise((res) => { const h = (e) => { const m = JSON.parse(e.data); if (m.type === type) { w.removeEventListener('message', h); res(m); } }; w.addEventListener('message', h); });
      const w1 = await open();
      w1.send(JSON.stringify({ type: 'join', domain: 'ws.example', world: 'lobby', name: 'WsA', publicKey: KEY }));
      const welcomeA = await next(w1, 'welcome');
      const w2 = await open();
      const joinedP = next(w1, 'joined');
      w2.send(JSON.stringify({ type: 'join', domain: 'ws.example', world: 'lobby', name: 'WsB', publicKey: KEY }));
      const welcomeB = await next(w2, 'welcome');
      const joined = await joinedP;
      noKeyIn('WS welcome', welcomeB);
      noKeyIn('WS joined broadcast', joined);
      check(welcomeB.roster.length === 1 && welcomeB.roster[0].id === welcomeA.id && joined.name === 'WsB', 'WS roster and joined broadcast carry public ids and names only');
      const sigGot = [];
      w1.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.type === 'signal') sigGot.push(m); });
      w2.send(JSON.stringify({ type: 'signal', to: welcomeA.id, kind: 'friend-request', publicKey: KEY, name: 'x' }));
      await sleep(300);
      check(sigGot.length === 0, 'a WS signal message is ignored (no relay)');
      const w3 = await open();
      w3.send(JSON.stringify({ type: 'join', domain: 'ws.example', world: 'lobby', name: 'WsC' }));
      await next(w3, 'welcome');
      const closed = new Promise((res) => { w3.onclose = () => res(true); });
      w3.send(JSON.stringify({ type: 'move', x: 1, y: 0, z: 0, yaw: 0, shirtColor: 'x'.repeat(20000) }));
      check(await Promise.race([closed, sleep(2000).then(() => false)]), 'a frame over MAX_FRAME_BYTES closes the connection');
      w1.close(); w2.close();
    }

    console.log('\nPRESENCE PRIVACY CHECKS PASSED (' + MODE + ')');
  } finally {
    proc.kill();
    if (MODE === 'php') for (const f of STORES) { try { fs.unlinkSync(f); } catch (err) {} }
  }
})().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
