// Domain Atlas — presence server, port 8004.
//
// Answers one question in real time: "who else is in this world right now,
// and where are they standing?" A visitor's client (extension/viewer.js)
// opens a WebSocket here on entering a world, announces a display name, and
// gets back a live feed of everyone else in that same domain+world "room" —
// joins, moves, leaves — while broadcasting its own position the same way.
// extension/gltf-mini.js renders whatever roster it's told about as extra
// walking characters.
//
// Presence carries no wallet identity. A member is a display name, a pose
// and an avatar look, tagged with a random per-connection id that exists
// only for the life of that connection. Nothing in this server learns,
// stores or relays a public key, and a new connection is a new, unrelated
// participant: there is no duplicate-session detection and no friend
// signalling here (social identity lives in the Post Office, not in a
// world's room). A display name is whatever the client announced; it is not
// authenticated, and neither is anything else a member sends.
//
// Two ids per member, deliberately different:
//   - publicId: random, broadcast to the room, used by clients to track an
//     avatar (joined / moved / left).
//   - connId: random, never broadcast. For WebSocket it is just the socket's
//     own identity; for the polling fallback it is the bearer token the
//     client presents to sync and leave. Knowing a publicId proves nothing
//     about a connId.
//
// Deliberately a SEPARATE service from the issuer and directory servers:
// this is a distinct concern (who's here right now) from issuing credentials
// or indexing manifests.
//
// Zero npm dependencies — same convention as issuer-server/server.js. That
// means hand-rolling the WebSocket protocol (RFC 6455): the HTTP Upgrade
// handshake, and a minimal frame reader/writer for text frames (messages
// are small JSON; see attachFrameReader() for exactly what that covers).
//
// Scope note: a client reports its OWN position every tick and this server
// just believes it and rebroadcasts — there is no server-side authority over
// movement, so a modified client can report any position it likes. Fine for
// a prototype; a real deployment would want movement validation before
// trusting positions for anything beyond cosmetics.
//
// Two transports, one room: WebSocket is the real-time transport, and a
// plain HTTP polling fallback (POST /presence/poll/join, /sync, /leave)
// reads and writes the same `rooms` state, for hosts that cannot run a
// persistent process (see presence-php/). Polling members get no pushes;
// every sync response returns the room's full roster and the client
// reconciles it locally.
//
// Resource bounds (all env-overridable): rooms, members per room, total
// members, chat rooms and chat members, request body size, WebSocket frame
// size, and a minimum interval between chat messages per member. Chat
// history is capped by count and by age.

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8004;

function envNumber(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ---------- WebSocket handshake ----------

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // fixed by RFC 6455, not a secret

function acceptKeyFor(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

// ---------- WebSocket framing (RFC 6455) ----------
//
// Client->server frames are always masked; server->client frames are never
// masked (both required by the spec). Handles the three payload-length
// encodings and FIN=0 continuation. Ping/pong and close are handled; binary
// frames are rejected, as is any frame (or reassembled message) larger than
// MAX_FRAME_BYTES — every message here is small JSON text.

const OP_CONTINUATION = 0x0, OP_TEXT = 0x1, OP_BINARY = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;
const MAX_FRAME_BYTES = envNumber('MAX_FRAME_BYTES', 16 * 1024);

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
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  try {
    socket.write(Buffer.concat([header, payload]));
  } catch (err) {
    // Socket already gone; the 'close'/'error' handlers do the cleanup.
  }
}

function sendText(socket, obj) {
  writeFrame(socket, OP_TEXT, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function sendClose(socket) {
  try { writeFrame(socket, OP_CLOSE, Buffer.alloc(0)); } catch (err) {}
  try { socket.end(); } catch (err) {}
}

// Wraps a raw socket's byte stream into parsed frames, calling
// onMessage(text) per complete text message. Buffers across chunk
// boundaries: one frame can span several 'data' events and one event can
// hold several frames.
function attachFrameReader(socket, { onMessage, onClose, onPing, onPong }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentBytes = 0;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

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
        // A length with any high bit set is far beyond MAX_FRAME_BYTES.
        if (buffer.readUInt32BE(offset) !== 0) { sendClose(socket); return; }
        len = buffer.readUInt32BE(offset + 4);
        offset += 8;
      }

      if (len > MAX_FRAME_BYTES) { sendClose(socket); return; }
      if (!masked) {
        // A conforming browser client always masks.
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

      buffer = buffer.slice(offset + len);

      if (opcode === OP_PING) { onPing(payload); continue; }
      if (opcode === OP_PONG) { onPong(payload); continue; }
      if (opcode === OP_CLOSE) { onClose(); return; }
      if (opcode === OP_BINARY) { sendClose(socket); return; }

      if (opcode === OP_TEXT || opcode === OP_CONTINUATION) {
        fragmentBytes += payload.length;
        if (fragmentBytes > MAX_FRAME_BYTES) { sendClose(socket); return; }
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          fragmentBytes = 0;
          onMessage(full);
        }
        continue;
      }
      // Unknown opcode — ignore rather than kill the connection over it.
    }
  });
}

// ---------- limits and input hygiene ----------

const MAX_NAME_LEN = 60;
const MAX_ID_LEN = 120; // domain / world strings
const MAX_COORD = 100000;
const MAX_COLOR_LEN = 16; // '#rrggbb' with room to spare
const MAX_SHOE_SCALE = 10;

const MAX_ROOMS = envNumber('MAX_ROOMS', 500);
const MAX_MEMBERS_PER_ROOM = envNumber('MAX_MEMBERS_PER_ROOM', 100);
const MAX_TOTAL_MEMBERS = envNumber('MAX_TOTAL_MEMBERS', 2000);
const MAX_CHAT_DOMAINS = envNumber('MAX_CHAT_DOMAINS', 500);
const MAX_CHAT_MEMBERS_PER_DOMAIN = envNumber('MAX_CHAT_MEMBERS_PER_DOMAIN', 200);
const MAX_BODY_BYTES = envNumber('MAX_BODY_BYTES', 8 * 1024);

// Domain and world strings come from a manifest and name a room; they are
// not validated against anything real. World ids are free-form in the
// manifest, so only length, type and control characters are restricted —
// the value is only ever used as a map key.
const ID_FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029]/;
function cleanId(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s.length >= 1 && s.length <= MAX_ID_LEN && !ID_FORBIDDEN.test(s) ? s : null;
}

// A display name is free text announced by the client: strip control
// characters, trim, bound the length. It is not an identity.
function cleanName(raw) {
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LEN);
  return s || 'Visitor';
}

function randomId() { return crypto.randomBytes(8).toString('hex'); }
function randomToken() { return crypto.randomBytes(16).toString('hex'); }

function isFiniteNumber(n) { return typeof n === 'number' && Number.isFinite(n); }
// Colour and scale values only change how a box renders on someone else's
// screen; the server never acts on them, so this just keeps a malformed
// value from propagating.
function sanitizeColor(v) { return typeof v === 'string' ? v.slice(0, MAX_COLOR_LEN) : null; }
function sanitizeScale(v) {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0 && n <= MAX_SHOE_SCALE) ? n : null;
}

// ---------- rooms ----------
//
// One room per domain+world pair, so multiple domains can share this one
// presence server without their member lists mixing.

const rooms = new Map(); // roomKey -> Map<connId, member>
function roomKeyFor(domain, world) { return domain + '::' + world; }

// member.transport is 'ws' (has a live `socket`) or 'poll' (has `lastSeen`).
// Only 'ws' members can be pushed to; 'poll' members read everyone else
// back on their next sync.
function broadcast(room, exceptConnId, obj) {
  room.forEach((member, connId) => {
    if (connId === exceptConnId) return;
    if (member.transport !== 'ws') return;
    sendText(member.socket, obj);
  });
}

// connId -> { roomKey, room } for every joined member, WS or poll alike, so
// the polling routes (no per-connection closure) find a member's room in O(1).
const connIndex = new Map();

function rosterOf(room, exceptConnId) {
  const roster = [];
  room.forEach((member, id) => {
    if (id === exceptConnId) return;
    roster.push({
      id: member.publicId, name: member.name, x: member.x, y: member.y, z: member.z, yaw: member.yaw,
      shirtColor: member.shirtColor || null, pantsColor: member.pantsColor || null, hatColor: member.hatColor || null, shoeColor: member.shoeColor || null, shoeScale: member.shoeScale || null
    });
  });
  return roster;
}

// Shared join path for both transports. `extra` carries the
// transport-specific fields ({transport:'ws', socket} or {transport:'poll',
// lastSeen}). Returns {ok:true, roomKey, room, roster, publicId}, or
// {ok:false, reason} with reason 'invalid', 'room-full' or 'server-busy'.
function addMember(connId, domainRaw, worldRaw, nameRaw, extra) {
  const domain = cleanId(domainRaw);
  const world = cleanId(worldRaw);
  if (!domain || !world) return { ok: false, reason: 'invalid' };
  const roomKey = roomKeyFor(domain, world);
  let room = rooms.get(roomKey);
  if (!room && rooms.size >= MAX_ROOMS) return { ok: false, reason: 'server-busy' };
  if (connIndex.size >= MAX_TOTAL_MEMBERS) return { ok: false, reason: 'server-busy' };
  if (room && room.size >= MAX_MEMBERS_PER_ROOM) return { ok: false, reason: 'room-full' };
  if (!room) { room = new Map(); rooms.set(roomKey, room); }

  const name = cleanName(nameRaw);
  const publicId = randomId();
  const roster = rosterOf(room, connId);
  const member = Object.assign({ publicId, name, x: 0, y: 0, z: 0, yaw: 0 }, extra);
  room.set(connId, member);
  connIndex.set(connId, { roomKey, room });

  // New members spawn at the origin and get their real position on their
  // first move/sync a moment later.
  broadcast(room, connId, { type: 'joined', id: publicId, name, x: 0, y: 0, z: 0, yaw: 0 });
  return { ok: true, roomKey, room, roster, publicId };
}

// Shared leave path: removes connId from its room, tells that room's WS
// members, and drops the room once empty. Safe on an unknown id.
function removeMember(connId) {
  const loc = connIndex.get(connId);
  if (!loc) return;
  const member = loc.room.get(connId);
  connIndex.delete(connId);
  loc.room.delete(connId);
  if (member) broadcast(loc.room, connId, { type: 'left', id: member.publicId });
  if (loc.room.size === 0) rooms.delete(loc.roomKey);
}

// Shared move path: validates and applies a position update for a joined
// connId, then broadcasts it. `look` ({shirtColor, pantsColor, hatColor,
// shoeColor, shoeScale}) rides alongside position because an equipped look
// can change mid-session; a move is the member's full current pose.
function moveMember(connId, x, y, z, yaw, look) {
  const loc = connIndex.get(connId);
  if (!loc) return false;
  const member = loc.room.get(connId);
  if (!member) return false;
  if (![x, y, z, yaw].every(isFiniteNumber)) return false;
  if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD || Math.abs(z) > MAX_COORD) return false;
  const shirtColor = sanitizeColor(look && look.shirtColor);
  const pantsColor = sanitizeColor(look && look.pantsColor);
  const hatColor = sanitizeColor(look && look.hatColor);
  const shoeColor = sanitizeColor(look && look.shoeColor);
  const shoeScale = sanitizeScale(look && look.shoeScale);
  member.x = x; member.y = y; member.z = z; member.yaw = yaw;
  member.shirtColor = shirtColor; member.pantsColor = pantsColor; member.hatColor = hatColor; member.shoeColor = shoeColor; member.shoeScale = shoeScale;
  broadcast(loc.room, connId, { type: 'moved', id: member.publicId, x, y, z, yaw, shirtColor, pantsColor, hatColor, shoeColor, shoeScale });
  return true;
}

// ---------- chat (in-world text chat) ----------
//
// A separate room concept from `rooms`: presence is keyed by domain+world,
// chat by domain only — every visitor anywhere in a domain shares one chat
// room, each message tagged with the world it was sent from, so a client can
// offer both a "This World" and a "Domain" view from one stream.
//
// A chat member is a display name and a random per-join senderId. The
// senderId lets a client mute or block a sender for as long as that sender's
// connection lasts; it is not an identity and nothing proves who is behind
// a name. Messages carry no wallet key. Reading and sending are open to any
// joined member; abuse control is the per-member send interval, the length
// cap, the word filter and the member/room caps.
//
// History is a rolling in-memory buffer per domain, bounded by count
// (CHAT_HISTORY_LIMIT) and by age (CHAT_HISTORY_TTL_MS), oldest dropped
// first. It is memory only: a restart loses it.
//
// member.transport is 'ws' (messages are pushed) or 'poll' (has `cursor`,
// the seq of the newest message already delivered, and `lastSeen`).
const chatRooms = new Map(); // domain -> Map<connId, {name, senderId, world, transport, socket?, lastSeen?, cursor?, lastSendAt}>
const chatHistory = new Map(); // domain -> array of {seq, id, senderId, world, name, text, sentAt}, oldest first
const chatSeqCounters = new Map(); // domain -> last assigned seq (monotonic, survives trimming)
const chatConnIndex = new Map(); // connId -> {domain, room}
const CHAT_HISTORY_LIMIT = envNumber('CHAT_HISTORY_LIMIT', 50);
const CHAT_HISTORY_TTL_MS = envNumber('CHAT_HISTORY_TTL_MS', 24 * 60 * 60 * 1000);
const MAX_CHAT_TEXT_LEN = 500;
const CHAT_MIN_INTERVAL_MS = envNumber('CHAT_MIN_INTERVAL_MS', 400);

// Same blocklist/leetspeak-normalization idea as extension/wallet.js's
// chatMessageContainsBlockedWord (duplicated, since each server is
// self-contained); this copy is authoritative because a client can skip its
// own check. Punctuation becomes spaces rather than nothing so two innocent
// adjacent words cannot concatenate into a blocked one; matching is plain
// substring so inflections ("fucking") don't slip through.
const CHAT_BLOCKLIST = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dick', 'piss',
  'slut', 'whore', 'fag', 'nigger', 'nigga', 'retard', 'rape'
];
function normalizeForChatFilter(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/!/g, 'i')
    .replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's')
    .replace(/@/g, 'a').replace(/\$/g, 's')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function chatTextContainsBlockedWord(text) {
  const normalized = normalizeForChatFilter(text);
  if (!normalized) return false;
  return CHAT_BLOCKLIST.some((word) => normalized.includes(word));
}

// Drops history entries older than the TTL (and deletes bookkeeping for a
// domain with no history and no members). Called on every read/write and
// from the periodic sweep.
function pruneChatHistory(domain, nowMs) {
  const history = chatHistory.get(domain);
  if (history) {
    const cutoff = nowMs - CHAT_HISTORY_TTL_MS;
    const kept = history.filter((m) => Date.parse(m.sentAt) >= cutoff);
    if (kept.length) chatHistory.set(domain, kept); else chatHistory.delete(domain);
  }
  if (!chatHistory.has(domain) && !chatRooms.has(domain)) chatSeqCounters.delete(domain);
}

function broadcastChat(room, obj) {
  room.forEach((member) => { if (member.transport === 'ws') sendText(member.socket, obj); });
}

function currentChatSeq(domain) {
  const history = chatHistory.get(domain) || [];
  return history.length ? history[history.length - 1].seq : 0;
}

// Joins connId into domain's chat room and returns {ok:true, senderId,
// history} or {ok:false, reason}. A poll member's `cursor` starts at "already
// seen everything in the history handed back", so its first sync only returns
// messages that arrive after this join.
function joinChatRoom(connId, domainRaw, worldRaw, nameRaw, extra) {
  const domain = cleanId(domainRaw);
  const world = cleanId(worldRaw);
  if (!domain || !world) return { ok: false, reason: 'invalid' };
  pruneChatHistory(domain, Date.now());
  let room = chatRooms.get(domain);
  if (!room && chatRooms.size >= MAX_CHAT_DOMAINS) return { ok: false, reason: 'server-busy' };
  if (room && room.size >= MAX_CHAT_MEMBERS_PER_DOMAIN) return { ok: false, reason: 'room-full' };
  if (!room) { room = new Map(); chatRooms.set(domain, room); }
  const history = chatHistory.get(domain) || [];
  const senderId = randomId();
  const member = Object.assign({ name: cleanName(nameRaw), senderId, world, cursor: currentChatSeq(domain), lastSendAt: 0 }, extra);
  room.set(connId, member);
  chatConnIndex.set(connId, { domain, room });
  return { ok: true, senderId, history };
}

function leaveChatRoom(connId) {
  const loc = chatConnIndex.get(connId);
  if (!loc) return;
  chatConnIndex.delete(connId);
  loc.room.delete(connId);
  if (loc.room.size === 0) chatRooms.delete(loc.domain);
}

// Validates and broadcasts a chat send from a joined connId. Returns
// {ok:true, message} or {ok:false, reason} with a short machine reason:
// 'not-joined' | 'rate-limited' | 'empty' | 'blocked'.
function sendChatMessage(connId, textRaw) {
  const loc = chatConnIndex.get(connId);
  if (!loc) return { ok: false, reason: 'not-joined' };
  const member = loc.room.get(connId);
  if (!member) return { ok: false, reason: 'not-joined' };
  const now = Date.now();
  if (now - member.lastSendAt < CHAT_MIN_INTERVAL_MS) return { ok: false, reason: 'rate-limited' };
  const text = String(textRaw || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, MAX_CHAT_TEXT_LEN);
  if (!text) return { ok: false, reason: 'empty' };
  if (chatTextContainsBlockedWord(text)) return { ok: false, reason: 'blocked' };
  member.lastSendAt = now;

  const seq = (chatSeqCounters.get(loc.domain) || 0) + 1;
  chatSeqCounters.set(loc.domain, seq);
  const message = {
    seq,
    id: randomId(),
    senderId: member.senderId,
    world: member.world,
    name: member.name,
    text,
    sentAt: new Date(now).toISOString()
  };
  const history = chatHistory.get(loc.domain) || [];
  history.push(message);
  while (history.length > CHAT_HISTORY_LIMIT) history.shift();
  chatHistory.set(loc.domain, history);
  // The sender's own cursor moves past this message, so a poll member does
  // not receive its own message again as a "new" entry on its next sync.
  member.cursor = seq;

  broadcastChat(loc.room, { type: 'chat-message', message });
  return { ok: true, message };
}

// Polling counterpart of the 'chat-message' push: returns every history
// entry newer than the member's cursor and advances it. Null for an
// unknown/expired id or a WS member.
function pollChatSync(connId) {
  const loc = chatConnIndex.get(connId);
  if (!loc) return null;
  const member = loc.room.get(connId);
  if (!member || member.transport !== 'poll') return null;
  member.lastSeen = Date.now();
  pruneChatHistory(loc.domain, Date.now());
  const history = chatHistory.get(loc.domain) || [];
  const delta = history.filter((m) => m.seq > member.cursor);
  if (delta.length) member.cursor = delta[delta.length - 1].seq;
  return delta;
}

// ---------- connection lifecycle ----------

const HEARTBEAT_MS = 20000; // how often this server pings each connection
const MOVE_MIN_INTERVAL_MS = 30; // drop 'move' messages arriving faster than this from one connection

function handleConnection(socket) {
  const connId = randomId() + randomId(); // never broadcast
  let joined = false;
  let alive = true;
  let lastMoveAt = 0;
  let chatJoined = false; // separate from `joined`: a connection can be either, both, or neither

  function leaveRoom() {
    if (!joined) return;
    joined = false;
    removeMember(connId);
  }

  function leaveChat() {
    if (!chatJoined) return;
    chatJoined = false;
    leaveChatRoom(connId);
  }

  attachFrameReader(socket, {
    onPing: (payload) => writeFrame(socket, OP_PONG, payload),
    onPong: () => { alive = true; },
    onClose: () => { leaveRoom(); leaveChat(); sendClose(socket); },
    onMessage: (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch (err) { return; } // malformed JSON — ignore, don't drop the connection
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'join') {
        if (joined) return; // one join per connection
        const result = addMember(connId, msg.domain, msg.world, msg.name, { transport: 'ws', socket });
        if (!result.ok) { sendText(socket, { type: 'join-denied', reason: result.reason }); return; }
        joined = true;
        sendText(socket, { type: 'welcome', id: result.publicId, roster: result.roster });
        return;
      }

      if (msg.type === 'move') {
        if (!joined) return;
        const now = Date.now();
        if (now - lastMoveAt < MOVE_MIN_INTERVAL_MS) return;
        lastMoveAt = now;
        moveMember(connId, Number(msg.x), Number(msg.y), Number(msg.z), Number(msg.yaw), { shirtColor: msg.shirtColor, pantsColor: msg.pantsColor, hatColor: msg.hatColor, shoeColor: msg.shoeColor, shoeScale: msg.shoeScale });
        return;
      }

      if (msg.type === 'leave') { leaveRoom(); return; }

      // In-world chat rides a dedicated connection (extension/viewer.js's
      // connectChat()) but is handled by this same dispatcher.
      if (msg.type === 'chat-join') {
        if (chatJoined) return; // one chat-join per connection
        const result = joinChatRoom(connId, msg.domain, msg.world, msg.name, { transport: 'ws', socket });
        if (!result.ok) { sendText(socket, { type: 'chat-error', reason: result.reason }); return; }
        chatJoined = true;
        sendText(socket, { type: 'chat-history', senderId: result.senderId, messages: result.history });
        return;
      }

      if (msg.type === 'chat-send') {
        if (!chatJoined) return;
        const result = sendChatMessage(connId, msg.text);
        if (!result.ok) sendText(socket, { type: 'chat-error', reason: result.reason });
        return;
      }

      if (msg.type === 'chat-leave') { leaveChat(); return; }
    }
  });

  socket.on('close', () => { leaveRoom(); leaveChat(); });
  socket.on('error', () => { leaveRoom(); leaveChat(); });

  // Heartbeat: catches connections that went dead without a clean TCP close
  // (a laptop put to sleep with the tab open) so they don't linger.
  const heartbeat = setInterval(() => {
    if (!alive) { clearInterval(heartbeat); try { socket.destroy(); } catch (err) {} leaveRoom(); leaveChat(); return; }
    alive = false;
    try { writeFrame(socket, OP_PING, Buffer.alloc(0)); } catch (err) {}
  }, HEARTBEAT_MS);
  socket.on('close', () => clearInterval(heartbeat));
}

// ---------- polling fallback ----------
//
// No persistent connection to detect a dropped tab with, so a poll member is
// presumed gone once it hasn't synced in POLL_TIMEOUT_MS — generous enough
// for a couple of missed polls. Overridable by env so a test can shrink it.
const POLL_TIMEOUT_MS = envNumber('POLL_TIMEOUT_MS', 8000);
const POLL_SWEEP_INTERVAL_MS = envNumber('POLL_SWEEP_INTERVAL_MS', 4000);

const sweepTimer = setInterval(() => {
  const now = Date.now();
  connIndex.forEach((loc, connId) => {
    const member = loc.room.get(connId);
    if (member && member.transport === 'poll' && now - member.lastSeen > POLL_TIMEOUT_MS) {
      removeMember(connId);
    }
  });
  chatConnIndex.forEach((loc, connId) => {
    const member = loc.room.get(connId);
    if (member && member.transport === 'poll' && now - member.lastSeen > POLL_TIMEOUT_MS) {
      leaveChatRoom(connId);
    }
  });
  const domains = new Set([...chatHistory.keys(), ...chatSeqCounters.keys()]);
  domains.forEach((domain) => pruneChatHistory(domain, now));
}, POLL_SWEEP_INTERVAL_MS);
sweepTimer.unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return; // keep draining so the 413 can be delivered, but stop buffering
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; data = ''; reject(new Error('body too large')); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// CORS is only opened for the read-only status route, which a content
// script on any page calls to show a participant count. Every other route is
// called from the extension's own pages, which do not need it.
function sendJson(res, status, obj, cors) {
  const headers = { 'Content-Type': 'application/json' };
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

function joinFailureStatus(reason) { return reason === 'invalid' ? 400 : 503; }

// ---------- HTTP server + upgrade handling ----------

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    });
    return res.end();
  }

  try {
    // The same verbs the WebSocket protocol has (join/move/leave), as
    // request/response. `id` in every response and request below is the
    // private connection token; `publicId` is the avatar id other members see.
    if (req.method === 'POST' && req.url === '/presence/poll/join') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const connId = randomToken();
      const result = addMember(connId, body.domain, body.world, body.name, { transport: 'poll', lastSeen: Date.now() });
      if (!result.ok) return sendJson(res, joinFailureStatus(result.reason), { error: result.reason === 'invalid' ? 'a valid domain and world are required' : result.reason, reason: result.reason });
      return sendJson(res, 200, { id: connId, publicId: result.publicId, roster: result.roster });
    }

    if (req.method === 'POST' && req.url === '/presence/poll/sync') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const connId = String(body.id || '');
      const loc = connIndex.get(connId);
      if (!loc) return sendJson(res, 404, { error: 'unknown or expired presence id — rejoin' });
      const member = loc.room.get(connId);
      if (!member || member.transport !== 'poll') return sendJson(res, 404, { error: 'unknown or expired presence id — rejoin' });
      member.lastSeen = Date.now();
      if (body.x !== undefined) moveMember(connId, Number(body.x), Number(body.y), Number(body.z), Number(body.yaw), { shirtColor: body.shirtColor, pantsColor: body.pantsColor, hatColor: body.hatColor, shoeColor: body.shoeColor, shoeScale: body.shoeScale });
      return sendJson(res, 200, { roster: rosterOf(loc.room, connId) });
    }

    if (req.method === 'POST' && req.url === '/presence/poll/leave') {
      const body = JSON.parse((await readBody(req)) || '{}');
      removeMember(String(body.id || ''));
      return sendJson(res, 200, { ok: true });
    }

    // In-world chat's polling fallback — same shapes as the WebSocket
    // messages, so presence-php and this server are interchangeable from
    // the client's point of view.
    if (req.method === 'POST' && req.url === '/presence/poll/chat-join') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const connId = randomToken();
      const result = joinChatRoom(connId, body.domain, body.world, body.name, { transport: 'poll', lastSeen: Date.now() });
      if (!result.ok) return sendJson(res, joinFailureStatus(result.reason), { error: result.reason === 'invalid' ? 'a valid domain and world are required' : result.reason, reason: result.reason });
      return sendJson(res, 200, { id: connId, senderId: result.senderId, messages: result.history });
    }

    if (req.method === 'POST' && req.url === '/presence/poll/chat-sync') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const connId = String(body.id || '');
      const delta = pollChatSync(connId);
      if (delta === null) return sendJson(res, 404, { error: 'unknown or expired chat id — rejoin' });
      return sendJson(res, 200, { messages: delta });
    }

    if (req.method === 'POST' && req.url === '/presence/poll/chat-send') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const connId = String(body.id || '');
      const loc = chatConnIndex.get(connId);
      if (!loc) return sendJson(res, 404, { error: 'unknown or expired chat id — rejoin' });
      const member = loc.room.get(connId);
      if (member) member.lastSeen = Date.now(); // sending counts as activity
      const result = sendChatMessage(connId, body.text);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && req.url === '/presence/poll/chat-leave') {
      const body = JSON.parse((await readBody(req)) || '{}');
      leaveChatRoom(String(body.id || ''));
      return sendJson(res, 200, { ok: true });
    }

    // Read-only status: how many people are in this world right now, for a
    // world the caller is not in (Favorites, the on-page participant count).
    // A count only — it names nobody, and it creates no room member.
    if (req.method === 'GET' && req.url.startsWith('/presence/status')) {
      const parsed = new URL(req.url, 'http://presence-server.local');
      const domain = cleanId(parsed.searchParams.get('domain'));
      const world = cleanId(parsed.searchParams.get('world'));
      if (!domain || !world) return sendJson(res, 400, { error: 'a valid domain and world are required' }, true);
      const room = rooms.get(roomKeyFor(domain, world));
      return sendJson(res, 200, { count: room ? room.size : 0 }, true);
    }
  } catch (err) {
    if (err && err.message === 'body too large') {
      res.setHeader('Connection', 'close'); // the unread remainder of the body is discarded with the connection
      return sendJson(res, 413, { error: 'request body too large' });
    }
    return sendJson(res, 400, { error: 'malformed request' });
  }

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Domain Atlas presence server — WebSocket endpoint at /presence, polling fallback at /presence/poll/*\n');
});

// Test-only hook: PRESENCE_DISABLE_WS=1 makes every WebSocket upgrade fail,
// simulating a deployment that can only run the polling routes (plain
// PHP hosting). Never set in a normal run.
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
