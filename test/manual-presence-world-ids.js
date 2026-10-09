// Manual check that presence and chat accept any reasonable manifest world
// id, run against the Node server or the PHP bundle:
//
//   node test/manual-presence-world-ids.js node
//   node test/manual-presence-world-ids.js php
//
// World ids are free-form in a manifest (spaces, slashes, non-ASCII). Join,
// chat-join and status must all agree on the same id and treat it as one
// room; only empty, over-long, non-string and control-character ids are
// refused, with the 'invalid' reason the client turns into a visible message.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MODE = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = MODE === 'php' ? 8274 : 8273;
const BASE = 'http://localhost:' + PORT;
const ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'presence-php');
const STORE_DIR = path.join(BUNDLE_DIR, 'presence', 'lib');
const STORES = ['atlas-presence-store.json', 'atlas-chat-store.json'].map((f) => path.join(STORE_DIR, f));

function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('PASS: ' + msg);
}

async function post(p, body) {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) {}
  return { status: res.status, body: json };
}
async function status(domain, world) {
  const res = await fetch(BASE + '/presence/status?domain=' + encodeURIComponent(domain) + '&world=' + encodeURIComponent(world));
  let json = null;
  try { json = await res.json(); } catch (err) {}
  return { status: res.status, body: json };
}

async function start() {
  if (MODE === 'php') {
    for (const f of STORES) { try { fs.unlinkSync(f); } catch (err) {} }
    const proc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
      proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
      proc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
    });
    return proc;
  }
  const proc = spawn('node', [path.join(ROOT, 'presence-server', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence server did not start in time')), 5000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('presence server exited early with code ' + code)));
  });
  return proc;
}

(async () => {
  const proc = await start();
  try {
    const worlds = ['plaza', 'Main Hall', 'north/wing', 'lobby #1', 'café', '大厅', 'a+b@c', 'x'.repeat(120)];
    const domains = ['example.com', 'localhost:8002', 'Example.COM', 'sub.example.com:8443'];

    for (const world of worlds) {
      const label = JSON.stringify(world.length > 20 ? world.slice(0, 8) + '…(' + world.length + ')' : world);
      const j = await post('/presence/poll/join', { domain: 'example.com', world, name: 'A' });
      check(j.status === 200 && typeof j.body.id === 'string' && typeof j.body.publicId === 'string', 'presence join accepts world id ' + label);
      const st = await status('example.com', world);
      check(st.status === 200 && st.body.count === 1, 'status counts the member under world id ' + label);
      const s = await post('/presence/poll/sync', { id: j.body.id, x: 1, y: 0, z: 1, yaw: 0 });
      check(s.status === 200, 'sync works for world id ' + label);
      const c = await post('/presence/poll/chat-join', { domain: 'example.com', world, name: 'A' });
      check(c.status === 200 && typeof c.body.id === 'string' && typeof c.body.senderId === 'string', 'chat-join accepts world id ' + label);
      await post('/presence/poll/leave', { id: j.body.id });
      await post('/presence/poll/chat-leave', { id: c.body.id });
      const after = await status('example.com', world);
      check(after.body.count === 0, 'leave empties the room for world id ' + label);
    }

    for (const domain of domains) {
      const j = await post('/presence/poll/join', { domain, world: 'plaza', name: 'A' });
      check(j.status === 200, 'presence join accepts domain ' + JSON.stringify(domain));
      const c = await post('/presence/poll/chat-join', { domain, world: 'plaza', name: 'A' });
      check(c.status === 200, 'chat-join accepts domain ' + JSON.stringify(domain));
    }

    // Same room regardless of transport or which route asked.
    const a = await post('/presence/poll/join', { domain: 'example.com', world: 'Main Hall', name: 'A' });
    const b = await post('/presence/poll/join', { domain: 'example.com', world: 'Main Hall', name: 'B' });
    check(b.body.roster.length === 1 && b.body.roster[0].id === a.body.publicId, 'two visitors in a spaced world id share one room');
    check((await status('example.com', 'Main Hall')).body.count === 2, 'status sees both visitors');
    check((await status('example.com', 'MainHall')).body.count === 0, 'a different id is a different room');

    // Still refused: empty, over-long, control characters, wrong types.
    const bad = [['', 'empty'], ['   ', 'blank'], ['x'.repeat(121), 'over-long'], ['a\u0000b', 'NUL'], ['a\nb', 'newline'], ['a\u007fb', 'DEL'], ['a b', 'line separator']];
    for (const [world, what] of bad) {
      const j = await post('/presence/poll/join', { domain: 'example.com', world, name: 'A' });
      check(j.status === 400 && j.body && j.body.reason === 'invalid', 'presence join refuses ' + what + ' world id with reason invalid');
      const c = await post('/presence/poll/chat-join', { domain: 'example.com', world, name: 'A' });
      check(c.status === 400 && c.body && c.body.reason === 'invalid', 'chat-join refuses ' + what + ' world id with reason invalid');
    }
    for (const [world, what] of [[null, 'null'], [42, 'number'], [['plaza'], 'array'], [{ a: 1 }, 'object']]) {
      const j = await post('/presence/poll/join', { domain: 'example.com', world, name: 'A' });
      check(j.status === 400, 'presence join refuses ' + what + ' world id');
    }
    const noDomain = await post('/presence/poll/join', { world: 'plaza', name: 'A' });
    check(noDomain.status === 400, 'presence join refuses a missing domain');
    check((await status('example.com', '')).status === 400, 'status refuses an empty world id');

    console.log('All checks passed.');
  } finally {
    proc.kill();
    if (MODE === 'php') for (const f of STORES) { try { fs.unlinkSync(f); } catch (err) {} }
  }
})().catch((err) => { console.error('FAIL: ' + err.message); process.exit(1); });
