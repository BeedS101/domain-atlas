// TEST-ONLY local signalling relay for the secure-comms feasibility spike.
//
//   node experiments/secure-comms-spike/server/signaling-server.js [port]
//
// Binds to loopback only, keeps everything in memory, has no authentication
// and is not an Atlas service. It relays opaque JSON between two named
// parties over plain HTTP long-poll (so the signalling shape stays
// transport-independent and could be carried over HTTPS polling), and has
// /__test/* hooks that let the tests act as a hostile relay (rewrite,
// redirect, drop). It must never be exposed beyond localhost.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || process.env.SPIKE_PORT || '9401', 10);
const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;
const PROBE_DIR = path.resolve(__dirname, '..', 'probe');

const queues = new Map(); // "room|to" -> [{id, msg}]
const waiters = new Map(); // "room|to" -> Set of resolve fns
let nextId = 1;
const tamper = { mode: 'none', value: null, dropTypes: [], delayMs: 0 };
const redirects = new Map(); // "room|to" -> {to, types|null}  (hostile relay: deliver elsewhere)
const mirrors = new Map(); // "room|to" -> [{copyTo, types|null}]  (hostile relay: also deliver a copy)
const stats = { sent: 0, polled: 0, tampered: 0, dropped: 0 };
const lastPoll = new Map(); // "room|me" -> {count, last}  (lets a test see a service worker still polling without attaching a debugger)
const observations = new Map(); // "room|me" -> [{t, kind, data}]  (test pages report what they saw)

function key(room, who) { return String(room) + '|' + String(who); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function applyTamper(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  if (tamper.dropTypes.includes(msg.type)) { stats.dropped++; return null; }
  if (tamper.mode === 'swap-fingerprint' && typeof msg.sdp === 'string') {
    stats.tampered++;
    const copy = JSON.parse(JSON.stringify(msg));
    copy.sdp = copy.sdp.replace(/^a=fingerprint:(\S+) .*$/gm, 'a=fingerprint:$1 ' + tamper.value);
    return copy;
  }
  return msg;
}

function deliver(room, to, msg) {
  const k = key(room, to);
  const q = queues.get(k) || [];
  q.push({ id: nextId++, msg });
  queues.set(k, q);
  const set = waiters.get(k);
  if (set) { for (const wake of set) wake(); set.clear(); }
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET') {
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, stats, polls: Object.fromEntries(lastPoll) });
    // Static helper pages: the capability probe and a deliberately hostile page.
    const files = { '/probe': 'probe.html', '/probe.js': 'probe.js', '/hostile': 'hostile.html', '/hostile.js': 'hostile.js' };
    const f = files[url.pathname];
    if (f) {
      const type = f.endsWith('.js') ? 'text/javascript' : 'text/html';
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(PROBE_DIR, f)));
    }
    res.writeHead(404); return res.end();
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'bad request' });
  }

  if (url.pathname === '/send') {
    let { room, to, msg } = body;
    if (!room || !to || !msg) return sendJson(res, 400, { error: 'room, to, msg required' });
    stats.sent++;
    const original = to;
    const redirected = redirects.get(key(room, to));
    if (redirected && (!redirected.types || redirected.types.includes(msg.type))) to = redirected.to;
    msg = applyTamper(msg);
    if (msg === null) return sendJson(res, 200, { ok: true });
    for (const m of mirrors.get(key(room, original)) || []) {
      if (!m.types || m.types.includes(msg.type)) deliver(room, m.copyTo, msg);
    }
    if (tamper.delayMs) setTimeout(() => deliver(room, to, msg), tamper.delayMs); else deliver(room, to, msg);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/poll') {
    const { room, me } = body;
    const after = Number(body.after) || 0;
    const waitMs = Math.min(Number(body.waitMs) || 15000, 25000);
    if (!room || !me) return sendJson(res, 400, { error: 'room and me required' });
    stats.polled++;
    const k = key(room, me);
    const lp = lastPoll.get(k) || { count: 0, last: 0 };
    lp.count++; lp.last = Date.now(); lastPoll.set(k, lp);
    const ready = () => (queues.get(k) || []).filter((e) => e.id > after);
    if (ready().length) return sendJson(res, 200, { events: ready() });
    await new Promise((resolve) => {
      const set = waiters.get(k) || new Set();
      waiters.set(k, set);
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); set.delete(finish); resolve(); };
      const timer = setTimeout(finish, waitMs);
      set.add(finish);
      req.on('close', finish);
    });
    return sendJson(res, 200, { events: ready() });
  }

  if (url.pathname === '/__test/tamper') {
    Object.assign(tamper, { mode: 'none', value: null, dropTypes: [], delayMs: 0 }, body);
    return sendJson(res, 200, { ok: true, tamper });
  }
  if (url.pathname === '/__test/redirect') {
    // body: {room, from, to, types?} - messages addressed to `from` are delivered to `to` instead
    if (body.clear) redirects.clear(); else redirects.set(key(body.room, body.from), { to: body.to, types: body.types || null });
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/__test/mirror') {
    // body: {room, to, copyTo, types?} - messages addressed to `to` are also delivered to `copyTo`
    if (body.clear) mirrors.clear();
    else { const k = key(body.room, body.to); const l = mirrors.get(k) || []; l.push({ copyTo: body.copyTo, types: body.types || null }); mirrors.set(k, l); }
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/__test/obs') {
    const k = key(body.room, body.me);
    const l = observations.get(k) || [];
    l.push({ t: Date.now(), kind: body.kind, data: body.data === undefined ? null : body.data });
    observations.set(k, l);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/__test/obs-get') return sendJson(res, 200, { list: observations.get(key(body.room, body.me)) || [] });
  if (url.pathname === '/__test/reset') {
    queues.clear(); redirects.clear(); mirrors.clear(); observations.clear();
    Object.assign(tamper, { mode: 'none', value: null, dropTypes: [], delayMs: 0 });
    return sendJson(res, 200, { ok: true });
  }
  res.writeHead(404); res.end();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => { try { sendJson(res, err.statusCode || 500, { error: 'error' }); } catch (e) { /* closed */ } });
});
server.listen(PORT, HOST, () => console.log('spike signalling relay (TEST ONLY) on http://' + HOST + ':' + PORT));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
