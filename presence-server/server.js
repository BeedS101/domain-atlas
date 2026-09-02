// Domain Atlas — presence server (task #66), port 8004.
//
// Answers one question in real time: "who else is in this world right now,
// and where are they standing?" A visitor's client (extension/viewer.js)
// opens a WebSocket here on entering a gltf-mini-v1 (3D) world, announces
// itself, and gets back a live feed of everyone else in that same
// domain+world "room" — joins, moves, leaves — while broadcasting its own
// position the same way. extension/gltf-mini.js renders whatever roster
// it's told about as extra walking characters (see upsertRemotePlayer /
// removeRemotePlayer in its returned API).
//
// Deliberately a SEPARATE service from the issuer and directory servers,
// same architectural reasoning as directory-server/server.js's own header
// comment: this is a distinct concern (who's here right now) from either
// issuing credentials or indexing manifests, and nothing about it needs to
// live in the same process as those.
//
// Zero npm dependencies — same convention as issuer-server/server.js and
// directory-server/server.js. That does mean hand-rolling the WebSocket
// protocol (RFC 6455) instead of pulling in the `ws` package: the HTTP
// Upgrade handshake, and a minimal frame reader/writer for text frames
// (join/move/leave messages are small JSON, so the framing only needs to
// handle the common case well — see readFrames() below for exactly what
// that does and doesn't cover).
//
// Scope note (deliberately basic, not a shipped multiplayer backend): a
// client reports its OWN position every tick and this server just believes
// it and rebroadcasts — there is no server-side authority over movement
// (no speed/collision checks against what a real client could have done),
// so a modified client could report any position it likes. Fine for a
// prototype demo; a real deployment would want server-side movement
// validation before trusting broadcast positions for anything more than
// cosmetics.
//
// Two transports, one room (task #68): WebSocket is the primary, real-time
// transport (see above), but it needs a persistent process bound to a
// port — something plain cPanel/Apache+PHP shared hosting (e.g. the real
// evtec.co.za deployment, see issuer-php/README.txt for why the issuer
// needed a PHP port in the first place) cannot run at all, in any
// language. So this server ALSO exposes a plain HTTP polling fallback
// (POST /presence/poll/join, /presence/poll/sync, /presence/poll/leave)
// that reads and writes the exact same `rooms` state as the WebSocket
// side — a WS visitor and a polling visitor in the same domain+world see
// each other correctly either way. Polling members don't get pushed
// events (there's no persistent connection to push down), so instead
// every /presence/poll/sync response hands back the room's FULL current
// roster and the client reconciles it locally — see viewer.js's
// syncPollTick(). Slower and choppier than WebSocket, but it's the shape
// that would actually port to plain PHP + a file/DB-backed roster on
// shared hosting, matching how the mail system already gets by on polling
// rather than push.

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8004;

// ---------- WebSocket handshake ----------

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // fixed by RFC 6455, not a secret

function acceptKeyFor(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

// ---------- WebSocket framing (RFC 6455) ----------
//
// Client->server frames are always masked; server->client frames are
// always sent unmasked (both required by the spec, not a choice made
// here). Handles the three payload-length encodings (7-bit direct, 16-bit
// extended, 64-bit extended) and simple continuation (FIN=0 frames
// concatenated until a FIN=1 arrives) since a browser is free to fragment
// a large send even though nothing this protocol sends is likely to be
// large. Ping/pong (opcodes 0x9/0xA) and close (0x8) are handled;
// binary frames (0x2) are rejected — every message here is JSON text.

const OP_CONTINUATION = 0x0, OP_TEXT = 0x1, OP_BINARY = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

function writeFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len <= 125) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    // Payloads here never get remotely close to needing the high 32 bits —
    // JSON position updates are a few hundred bytes at most — so only the
    // low 32 bits are ever meaningful, but the header format still
    // requires all 8 length bytes to be written.
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  try {
    socket.write(Buffer.concat([header, payload]));
  } catch (err) {
    // Socket already gone (client disconnected between checks) — the
    // 'close'/'error' handlers deal with cleanup, this call just no-ops.
  }
}

function sendText(socket, obj) {
  writeFrame(socket, OP_TEXT, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function sendClose(socket) {
  try { writeFrame(socket, OP_CLOSE, Buffer.alloc(0)); } catch (err) {}
  try { socket.end(); } catch (err) {}
}

// Wraps a raw socket's incoming byte stream into parsed frames, calling
// onMessage(text) for each complete text message and onClose()/onPing()
// as those frame types arrive. Buffers across chunk boundaries — a single
// WebSocket frame is not guaranteed to arrive in one 'data' event, and one
// 'data' event can easily contain more than one frame back to back.
function attachFrameReader(socket, { onMessage, onClose, onPing, onPong }) {
  let buffer = Buffer.alloc(0);
  let fragments = []; // accumulated payloads of an in-progress FIN=0...FIN=1 message

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Consume as many complete frames as the buffer currently holds.
    for (;;) {
      if (buffer.length < 2) return;
      const byte0 = buffer[0], byte1 = buffer[1];
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let len = byte1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        // See the writeFrame comment above — only the low 32 bits are ever
        // meaningful for anything this server actually sends or expects.
        len = buffer.readUInt32BE(offset + 4);
        offset += 8;
      }

      if (!masked) {
        // A conforming browser client always masks; a frame that doesn't
        // is either not a real WebSocket client or corrupt either way —
        // drop the connection rather than try to make sense of it.
        sendClose(socket);
        return;
      }
      if (buffer.length < offset + 4) return;
      const maskKey = buffer.slice(offset, offset + 4);
      offset += 4;

      if (buffer.length < offset + len) return; // payload not fully arrived yet
      const maskedPayload = buffer.slice(offset, offset + len);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = maskedPayload[i] ^ maskKey[i % 4];

      buffer = buffer.slice(offset + len); // this frame consumed; loop for any more already buffered

      if (opcode === OP_PING) { onPing(payload); continue; }
      if (opcode === OP_PONG) { onPong(payload); continue; }
      if (opcode === OP_CLOSE) { onClose(); return; }
      if (opcode === OP_BINARY) { sendClose(socket); return; } // not something this protocol uses

      if (opcode === OP_TEXT || opcode === OP_CONTINUATION) {
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          onMessage(full);
        }
        continue;
      }
      // Unknown opcode — ignore rather than kill the connection over it.
    }
  });
}

// ---------- rooms ----------
//
// One room per domain+world pair, so multiple domains can share this one
// presence server without their worlds' member lists ever mixing (a
// "lobby" world id existing under two different domains, say, must stay
// two completely separate rooms).

const rooms = new Map(); // roomKey -> Map<connId, member>
function roomKeyFor(domain, world) { return domain + '::' + world; }

function getOrCreateRoom(roomKey) {
  let room = rooms.get(roomKey);
  if (!room) { room = new Map(); rooms.set(roomKey, room); }
  return room;
}

// member.transport is 'ws' (has a live `socket`) or 'poll' (has a
// `lastSeen` timestamp instead — see the polling routes below). Only 'ws'
// members can be pushed to; 'poll' members find out about everyone else
// (including 'ws' members) by reading the roster back on their next sync.
function broadcast(room, exceptConnId, obj) {
  room.forEach((member, connId) => {
    if (connId === exceptConnId) return;
    if (member.transport !== 'ws') return;
    sendText(member.socket, obj);
  });
}

// connId -> { roomKey, room } for every currently-joined member, WS or
// poll alike — lets the polling HTTP routes (which have no per-connection
// closure the way a WebSocket handler does) find "which room is this id
// in" in O(1) instead of scanning every room on every request.
const connIndex = new Map();

// Loose sanity bounds — not real anti-cheat (see the top-of-file scope
// note), just enough to stop obviously-malformed input from propagating to
// every other client in a room.
const MAX_NAME_LEN = 60;
const MAX_ID_LEN = 120; // domain/world strings
const MAX_COORD = 100000;
const MAX_PUBLIC_KEY_LEN = 200; // base64url WebAuthn/local-identity public keys fit comfortably under this

function isFiniteNumber(n) { return typeof n === 'number' && Number.isFinite(n); }

function rosterOf(room, exceptConnId) {
  const roster = [];
  room.forEach((member, id) => {
    if (id === exceptConnId) return;
    roster.push({ id, name: member.name, x: member.x, y: member.y, z: member.z, yaw: member.yaw, publicKey: member.publicKey || null });
  });
  return roster;
}

// Signal relay (Friends, #67): a tiny point-to-point message primitive
// riding on top of the same rooms this file already tracks, used for
// friend requests between two visitors who are simultaneously present in
// the same room — see README.md's Friends section for why this exists
// instead of the mail system (mail is domain-issuer-to-subscriber only,
// there's no way to even discover a stranger's credentialId to mail them).
// Deliberately a closed, small vocabulary rather than a general messaging
// channel — the server only ever relays these three kinds, never inspects
// or stores the substance of any "conversation".
const ALLOWED_SIGNAL_KINDS = new Set(['friend-request', 'friend-request-accepted', 'friend-request-declined']);

// Shared join path for both transports: validates domain/world/name,
// creates or reuses the room, adds this connId as a member (merging in
// transport-specific fields via `extra` — {transport:'ws', socket} or
// {transport:'poll', lastSeen}), broadcasts 'joined' to the room's WS
// members, and hands back the roster as it stood just before this member
// was added. Returns null on invalid input (caller decides how to signal
// that back — a silently-dropped message for WS, a 400 for HTTP).
//
// publicKeyRaw is optional (task #67) — an anonymous visitor with no
// unlocked identity joins with no publicKey at all, same "presence never
// requires an identity" principle task #63 established; only a visitor
// with an unlocked wallet sends one, and only THEN can anyone friend-
// request them (there's nothing stable to add as a friend otherwise).
function addMember(connId, domainRaw, worldRaw, nameRaw, publicKeyRaw, extra) {
  const domain = String(domainRaw || '').slice(0, MAX_ID_LEN);
  const world = String(worldRaw || '').slice(0, MAX_ID_LEN);
  if (!domain || !world) return null;
  const name = String(nameRaw || 'Visitor').slice(0, MAX_NAME_LEN);
  const publicKey = publicKeyRaw ? String(publicKeyRaw).slice(0, MAX_PUBLIC_KEY_LEN) : null;
  const roomKey = roomKeyFor(domain, world);
  const room = getOrCreateRoom(roomKey);

  const roster = rosterOf(room, connId);
  // pendingSignals holds signals relayed to this member while they're a
  // 'poll' member (no persistent connection to push down) — drained and
  // returned on their next /presence/poll/sync. Harmless but unused on a
  // 'ws' member, who gets signals pushed immediately instead.
  const member = Object.assign({ name, publicKey, x: 0, y: 0, z: 0, yaw: 0, pendingSignals: [] }, extra);
  room.set(connId, member);
  connIndex.set(connId, { roomKey, room });

  // New members spawn at the origin by default and get their real position
  // on their first move/sync a moment later — an accepted minor rough edge
  // rather than something worth extra protocol complexity to avoid.
  broadcast(room, connId, { type: 'joined', id: connId, name, publicKey, x: 0, y: 0, z: 0, yaw: 0 });
  return { roomKey, room, roster };
}

// Relays a signal from fromConnId to toConnId, but ONLY if both are
// members of the SAME room right now — a poll or WS member can't be
// signaled by someone in a different domain+world, same isolation
// guarantee the roster itself gives. Pushes immediately if the target is a
// live WS connection; otherwise queues into target.pendingSignals for
// their next poll sync to pick up. Returns false (silent no-op) for an
// invalid kind, an unknown sender, or a target not in the sender's room —
// deliberately no error detail leaked back about WHY a target id didn't
// match, since that would let a client probe for who's in a room by id.
function relaySignal(fromConnId, toConnIdRaw, kindRaw, publicKeyRaw, nameRaw) {
  const loc = connIndex.get(fromConnId);
  if (!loc) return false;
  const kind = String(kindRaw || '');
  if (!ALLOWED_SIGNAL_KINDS.has(kind)) return false;
  const toConnId = String(toConnIdRaw || '');
  const target = loc.room.get(toConnId);
  if (!target) return false;
  const publicKey = publicKeyRaw ? String(publicKeyRaw).slice(0, MAX_PUBLIC_KEY_LEN) : null;
  const name = String(nameRaw || '').slice(0, MAX_NAME_LEN);
  const payload = { type: 'signal', from: fromConnId, kind, publicKey, name };
  if (target.transport === 'ws') {
    sendText(target.socket, payload);
  } else {
    target.pendingSignals.push(payload);
  }
  return true;
}

// Shared leave path: removes connId from whatever room it's in (if any),
// tells that room's WS members it left, and drops the room entirely once
// empty. Safe to call on an id that isn't actually joined (no-op).
function removeMember(connId) {
  const loc = connIndex.get(connId);
  if (!loc) return;
  connIndex.delete(connId);
  loc.room.delete(connId);
  broadcast(loc.room, connId, { type: 'left', id: connId });
  if (loc.room.size === 0) rooms.delete(loc.roomKey);
}

// Shared move path: validates and applies a position update for an
// already-joined connId, then broadcasts it to the room's WS members.
// Returns false (no-op) for an unknown id or out-of-bounds/non-finite
// coordinates — same validation either transport's move message gets.
function moveMember(connId, x, y, z, yaw) {
  const loc = connIndex.get(connId);
  if (!loc) return false;
  const member = loc.room.get(connId);
  if (!member) return false;
  if (![x, y, z, yaw].every(isFiniteNumber)) return false;
  if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD || Math.abs(z) > MAX_COORD) return false;
  member.x = x; member.y = y; member.z = z; member.yaw = yaw;
  broadcast(loc.room, connId, { type: 'moved', id: connId, x, y, z, yaw });
  return true;
}

// ---------- connection lifecycle ----------

const HEARTBEAT_MS = 20000; // how often this server pings each connection
const MOVE_MIN_INTERVAL_MS = 30; // drop 'move' messages arriving faster than this from one connection

function handleConnection(socket) {
  const connId = crypto.randomBytes(8).toString('hex');
  let joined = false; // becomes true once a valid 'join' has been processed
  let alive = true;
  let lastMoveAt = 0;

  function leaveRoom() {
    if (!joined) return;
    joined = false;
    removeMember(connId);
  }

  attachFrameReader(socket, {
    onPing: (payload) => writeFrame(socket, OP_PONG, payload),
    onPong: () => { alive = true; },
    onClose: () => { leaveRoom(); sendClose(socket); },
    onMessage: (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch (err) { return; } // malformed JSON — ignore, don't drop the connection over it
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'join') {
        if (joined) return; // one join per connection
        const result = addMember(connId, msg.domain, msg.world, msg.name, msg.publicKey, { transport: 'ws', socket });
        if (!result) return;
        joined = true;
        sendText(socket, { type: 'welcome', id: connId, roster: result.roster });
        return;
      }

      if (msg.type === 'move') {
        if (!joined) return;
        const now = Date.now();
        if (now - lastMoveAt < MOVE_MIN_INTERVAL_MS) return;
        lastMoveAt = now;
        moveMember(connId, Number(msg.x), Number(msg.y), Number(msg.z), Number(msg.yaw));
        return;
      }

      if (msg.type === 'signal') {
        // Friend requests etc (#67) — see relaySignal()'s own comment.
        // Silently ignored if not joined, unknown target, or an
        // unrecognized kind; no ack needed on WS, the caller finds out
        // it worked when the relay itself (or its reply) arrives.
        if (!joined) return;
        relaySignal(connId, msg.to, msg.kind, msg.publicKey, msg.name);
        return;
      }

      if (msg.type === 'leave') { leaveRoom(); return; }
    }
  });

  socket.on('close', () => leaveRoom());
  socket.on('error', () => leaveRoom());

  // Heartbeat: catches connections that went dead without a clean TCP
  // close (a laptop put to sleep with the tab open is the common real
  // case) so they don't linger in a room's roster forever.
  const heartbeat = setInterval(() => {
    if (!alive) { clearInterval(heartbeat); try { socket.destroy(); } catch (err) {} leaveRoom(); return; }
    alive = false;
    try { writeFrame(socket, OP_PING, Buffer.alloc(0)); } catch (err) {}
  }, HEARTBEAT_MS);
  socket.on('close', () => clearInterval(heartbeat));
}

// ---------- polling fallback (task #68) ----------
//
// No persistent connection to detect a dropped tab with, so a poll member
// is presumed gone once it hasn't synced in POLL_TIMEOUT_MS — generous
// enough to tolerate a couple of missed polls (a slow request, a brief
// network hiccup) without falsely evicting someone still there.
// Overridable by env (same convention as PORT) so a test can shrink these
// to something worth actually waiting out instead of the real defaults.
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS) || 8000;
const POLL_SWEEP_INTERVAL_MS = Number(process.env.POLL_SWEEP_INTERVAL_MS) || 4000;

setInterval(() => {
  const now = Date.now();
  connIndex.forEach((loc, connId) => {
    const member = loc.room.get(connId);
    if (member && member.transport === 'poll' && now - member.lastSeen > POLL_TIMEOUT_MS) {
      removeMember(connId);
    }
  });
}, POLL_SWEEP_INTERVAL_MS);

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

// ---------- HTTP server + upgrade handling ----------

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
    // Same three verbs the WebSocket protocol has (join/move/leave), just
    // request/response instead of push — see the top-of-file note on why
    // this exists alongside, not instead of, the WebSocket path.
    if (req.method === 'POST' && req.url === '/presence/poll/join') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const connId = crypto.randomBytes(8).toString('hex');
      const result = addMember(connId, body.domain, body.world, body.name, body.publicKey, { transport: 'poll', lastSeen: Date.now() });
      if (!result) return sendJson(res, 400, { error: 'domain and world are required' });
      return sendJson(res, 200, { id: connId, roster: result.roster });
    }

    if (req.method === 'POST' && req.url === '/presence/poll/sync') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const connId = String(body.id || '');
      const loc = connIndex.get(connId);
      if (!loc) return sendJson(res, 404, { error: 'unknown or expired presence id — rejoin' });
      const member = loc.room.get(connId);
      if (!member || member.transport !== 'poll') return sendJson(res, 404, { error: 'unknown or expired presence id — rejoin' });
      member.lastSeen = Date.now();
      if (body.x !== undefined) moveMember(connId, Number(body.x), Number(body.y), Number(body.z), Number(body.yaw));
      // Drain any signals (friend requests etc, #67) queued for this
      // member since their last sync — this poll response IS the only
      // "push" a polling member ever gets, same reasoning as the roster
      // itself being handed back whole every time rather than as a diff.
      const signals = member.pendingSignals;
      member.pendingSignals = [];
      return sendJson(res, 200, { roster: rosterOf(loc.room, connId), signals });
    }

    if (req.method === 'POST' && req.url === '/presence/poll/signal') {
      // Friend requests etc (#67), polling-side. Always just queues on the
      // relay's target (relaySignal handles the ws-vs-poll branch itself);
      // this route's only job is authenticating that the sender's own poll
      // id is real and still in a room before letting them relay anything.
      const body = JSON.parse((await readBody(req)) || '{}');
      const connId = String(body.id || '');
      const loc = connIndex.get(connId);
      if (!loc) return sendJson(res, 404, { error: 'unknown or expired presence id — rejoin' });
      const member = loc.room.get(connId);
      if (!member || member.transport !== 'poll') return sendJson(res, 404, { error: 'unknown or expired presence id — rejoin' });
      member.lastSeen = Date.now(); // sending a signal counts as activity, same as a sync would
      const ok = relaySignal(connId, body.to, body.kind, body.publicKey, body.name);
      return sendJson(res, 200, { ok });
    }

    if (req.method === 'POST' && req.url === '/presence/poll/leave') {
      const body = JSON.parse((await readBody(req)) || '{}');
      removeMember(String(body.id || ''));
      return sendJson(res, 200, { ok: true });
    }

    // Read-only status (Favorites, #61) — "how many people are in this
    // world right now, and who" for a domain+world the caller ISN'T
    // currently present in (a favorited domain the visitor hasn't opened),
    // without creating a room member the way join would. The client
    // cross-references the returned roster's publicKey values against its
    // OWN local friends list to show "N here, including 2 friends" — the
    // server never sees or stores anyone's friends list, so this endpoint
    // can stay simple: it just reports who's here, full stop.
    if (req.method === 'GET' && req.url.startsWith('/presence/status')) {
      const parsed = new URL(req.url, 'http://presence-server.local');
      const domain = String(parsed.searchParams.get('domain') || '').slice(0, MAX_ID_LEN);
      const world = String(parsed.searchParams.get('world') || '').slice(0, MAX_ID_LEN);
      if (!domain || !world) return sendJson(res, 400, { error: 'domain and world are required' });
      const room = rooms.get(roomKeyFor(domain, world));
      if (!room) return sendJson(res, 200, { count: 0, roster: [] });
      return sendJson(res, 200, { count: room.size, roster: rosterOf(room, null) });
    }
  } catch (err) {
    return sendJson(res, 400, { error: 'malformed request' });
  }

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Domain Atlas presence server — WebSocket endpoint at /presence, polling fallback at /presence/poll/*\n');
});

// Test-only hook (task #68): PRESENCE_DISABLE_WS=1 makes every WebSocket
// upgrade attempt fail, simulating a deployment that can only ever run the
// polling routes above — a plain cPanel/PHP host being the real-world
// example. Lets a test prove the client's fallback actually engages end
// to end instead of just trusting it would. Never set in a normal run.
const WS_DISABLED = process.env.PRESENCE_DISABLE_WS === '1';

server.on('upgrade', (req, socket) => {
  if (WS_DISABLED || req.url !== '/presence' || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const clientKey = req.headers['sec-websocket-key'];
  if (!clientKey) { socket.destroy(); return; }

  const acceptKey = acceptKeyFor(clientKey);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey + '\r\n' +
    '\r\n'
  );
  handleConnection(socket);
});

server.listen(PORT, () => {
  console.log('Domain Atlas presence server listening on http://localhost:' + PORT + ' (WebSocket at /presence)');
});

module.exports = { server, rooms };
