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
//
// Per-source abuse controls (see "network sources" below): concurrent
// presence and chat sessions per source, a join-rate limit with an escalating
// cooldown, a per-source share of any one room, and a cap on idle WebSocket
// connections. A source is the socket peer address, hashed with a per-process
// secret; it is kept only in memory, only for the life of a session or a
// rate-limit window, and is never sent to any client. Forwarded-for headers
// are not read.
//
// Moderation (lib-moderation.js): POST /presence/moderation/roster answers a
// moderator holding an issuer-signed grant with the anonymous sessions in one
// world they are authorized for. It is read-only, takes no wallet identity,
// and trusts only issuer keys named in this server's own configuration.
// A client may also send a random per-visit id with its presence and chat joins
// (`visit`); only a keyed hash of it is kept, and it only lets the roster show
// the two sessions of one visit together. See docs/moderation-authorization.md.

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const moderation = require('./lib-moderation');

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

// ---------- network sources ----------
//
// Abuse limits are keyed on the TCP peer address and nothing else. Headers
// such as X-Forwarded-For are client-controlled and are never read. Behind a
// reverse proxy or NAT every client shares one source, so the defaults are
// deliberately generous and operators behind a proxy should raise them (or
// limit in front of this server).
//
// The address is reduced to a key (IPv4 as is, IPv6 to its /64, since one
// subscriber normally controls a whole /64) and HMAC-hashed with a secret
// generated at startup. The key lives in memory only: on a member record for
// as long as the session exists, and in a rate-limit entry for as long as the
// window/cooldown lasts. It is not an identity, is not shared across
// restarts, and is never included in any response.

const SOURCE_MAX_PRESENCE = envNumber('SOURCE_MAX_PRESENCE', 30); // concurrent presence sessions, all rooms
const SOURCE_MAX_PRESENCE_PER_ROOM = envNumber('SOURCE_MAX_PRESENCE_PER_ROOM', 10);
const SOURCE_MAX_CHAT = envNumber('SOURCE_MAX_CHAT', 20); // concurrent chat sessions, all domains
const SOURCE_MAX_CHAT_PER_DOMAIN = envNumber('SOURCE_MAX_CHAT_PER_DOMAIN', 10);
// Once a room is this full, a source that already holds SOURCE_SOFT_FULL_MAX
// sessions in it is refused, so the last free places go to other sources.
const SOURCE_SOFT_FULL_RATIO = Math.min(1, envNumber('SOURCE_SOFT_FULL_RATIO', 0.8));
const SOURCE_SOFT_FULL_MAX = envNumber('SOURCE_SOFT_FULL_MAX', 3);
const SOURCE_MAX_SOCKETS = envNumber('SOURCE_MAX_SOCKETS', 60); // open WebSocket connections, joined or not
const SOURCE_JOIN_MAX = envNumber('SOURCE_JOIN_MAX', 60); // join attempts per window, presence and chat each
const SOURCE_JOIN_WINDOW_MS = envNumber('SOURCE_JOIN_WINDOW_MS', 60 * 1000);
const SOURCE_COOLDOWN_MS = envNumber('SOURCE_COOLDOWN_MS', 30 * 1000); // doubles per repeat trip
const SOURCE_COOLDOWN_MAX_MS = envNumber('SOURCE_COOLDOWN_MAX_MS', 5 * 60 * 1000);
const SOURCE_STRIKE_MEMORY_MS = envNumber('SOURCE_STRIKE_MEMORY_MS', 10 * 60 * 1000);
const MAX_SOURCE_ENTRIES = envNumber('MAX_SOURCE_ENTRIES', 10000);

const SOURCE_SALT = crypto.randomBytes(16);

function ipv6Prefix64(a) {
  if (a.includes('.')) return a; // embedded IPv4 other than ::ffff:a.b.c.d; keep whole
  let groups;
  const i = a.indexOf('::');
  if (i >= 0) {
    const left = a.slice(0, i) ? a.slice(0, i).split(':') : [];
    const right = a.slice(i + 2) ? a.slice(i + 2).split(':') : [];
    groups = left.concat(new Array(Math.max(0, 8 - left.length - right.length)).fill('0'), right);
  } else {
    groups = a.split(':');
  }
  return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':') + '/64';
}

function sourceKeyOf(rawAddress) {
  let a = String(rawAddress || '').split('%')[0].toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mapped) a = mapped[1];
  else if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    a = [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  let key;
  if (net.isIPv4(a)) key = a;
  else if (net.isIPv6(a)) key = ipv6Prefix64(a);
  else key = 'unknown'; // unparseable peers all share one bucket
  return crypto.createHmac('sha256', SOURCE_SALT).update(key).digest('hex').slice(0, 16);
}

// src -> { presence: Bucket, chat: Bucket }, Bucket = {times, cooldownUntil, strikes, lastStrikeAt}.
// Map insertion order doubles as LRU order (entries are re-inserted on use).
const sourceLimits = new Map();

function newBucket() { return { times: [], cooldownUntil: 0, strikes: 0, lastStrikeAt: 0 }; }

function bucketFor(src, kind, now) {
  let ent = sourceLimits.get(src);
  if (ent) {
    sourceLimits.delete(src);
  } else {
    if (sourceLimits.size >= MAX_SOURCE_ENTRIES) pruneSourceLimits(now);
    // Still full of live entries: forget the least recently used one. Caps on
    // sessions are computed from live members, so only rate history is lost.
    while (sourceLimits.size >= MAX_SOURCE_ENTRIES) sourceLimits.delete(sourceLimits.keys().next().value);
    ent = { presence: newBucket(), chat: newBucket() };
  }
  sourceLimits.set(src, ent);
  return ent[kind];
}

// Records one join attempt for (src, kind). Returns null when allowed, else
// the whole seconds until the source may try again. Attempts made during a
// cooldown are refused without being recorded, so waiting it out always works.
function noteJoinAttempt(src, kind, now) {
  const b = bucketFor(src, kind, now);
  if (b.cooldownUntil > now) return Math.ceil((b.cooldownUntil - now) / 1000);
  const cutoff = now - SOURCE_JOIN_WINDOW_MS;
  while (b.times.length && b.times[0] <= cutoff) b.times.shift();
  b.times.push(now);
  if (b.times.length <= SOURCE_JOIN_MAX) return null;
  b.strikes = (now - b.lastStrikeAt > SOURCE_STRIKE_MEMORY_MS ? 0 : b.strikes) + 1;
  b.lastStrikeAt = now;
  const cooldown = Math.min(SOURCE_COOLDOWN_MAX_MS, SOURCE_COOLDOWN_MS * Math.pow(2, b.strikes - 1));
  b.cooldownUntil = now + cooldown;
  b.times = [];
  return Math.ceil(cooldown / 1000);
}

function pruneSourceLimits(now) {
  sourceLimits.forEach((ent, src) => {
    const idle = ['presence', 'chat'].every((k) => {
      const b = ent[k];
      return b.cooldownUntil <= now
        && (!b.times.length || b.times[b.times.length - 1] <= now - SOURCE_JOIN_WINDOW_MS)
        && now - b.lastStrikeAt > SOURCE_STRIKE_MEMORY_MS;
    });
    if (idle) sourceLimits.delete(src);
  });
}

const socketsBySource = new Map(); // src -> open WebSocket connections

// Concurrency admission for one more session in `room` (a Map of members, or
// undefined for a room that does not exist yet). `countAll` counts the
// source's sessions across every room of this kind. Counts come from live
// member records, so they cannot drift from the real state.
function sourceAdmission(src, room, capacity, countAll, totalMax, perRoomMax) {
  if (countAll(src) >= totalMax) return 'source-limit';
  if (room) {
    let mine = 0;
    room.forEach((m) => { if (m.src === src) mine++; });
    if (mine >= perRoomMax) return 'source-limit';
    if (room.size >= capacity * SOURCE_SOFT_FULL_RATIO && mine >= SOURCE_SOFT_FULL_MAX) return 'source-limit';
  }
  return null;
}

// Readable text for every refusal. The server does not hide the reason: the
// client shows `message` and may offer a retry after `retryAfter` seconds.
const DENIAL_TEXT = {
  'invalid': 'A valid domain and world are required.',
  'server-busy': 'The presence server is busy. Try again shortly.',
  'room-full': 'This room is full right now. Try again in a moment.',
  'source-limit': 'Too many sessions are already open from your network connection. Close other tabs or wait a few seconds, then try again.',
  'join-rate-limited': 'Too many join attempts from your network connection. Wait a moment, then try again.',
  'name-not-allowed': 'That display name looks like an official title (moderator, admin, staff, ...). Display names are not verified, so titles are not allowed. Choose a different name.'
};
const DENIAL_RETRY_S = { 'room-full': 10, 'source-limit': 10, 'server-busy': 15 };

function denial(result) {
  const out = { reason: result.reason, message: DENIAL_TEXT[result.reason] || result.reason };
  const retry = result.retryAfter || DENIAL_RETRY_S[result.reason];
  if (retry) out.retryAfter = retry;
  return out;
}

// ---------- display-name guard ----------
//
// A display name is typed by the visitor and nothing authenticates it. This
// guard refuses names that read as an official title or badge so that an
// ordinary visitor cannot present as "Moderator (official)". It is a
// nuisance filter, not identity verification: it will miss disguises it does
// not know, and an allowed name proves nothing. A genuine moderator marker
// must be a separate field issued by the server, never text in the name.

const GLYPH_CONFUSABLES = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ѕ': 's', 'ј': 'j', 'ԁ': 'd', 'ӏ': 'i', 'ı': 'i',
  'м': 'm', 'т': 't', 'н': 'h', 'к': 'k', 'в': 'b', 'ո': 'n', 'ս': 'u', 'ɡ': 'g', 'ɩ': 'i',
  'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'η': 'n', 'μ': 'u'
};
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '|': 'i', 'l': 'i' };
// Check marks, shields and similar badge glyphs read as a verification mark.
const BADGE_GLYPHS = /[\u2713\u2714\u2705\u2611\u{1F6E1}\u{1F530}]/u;

function foldName(raw) {
  let t = String(raw || '').normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[\p{Cf}\u00ad]/gu, '').toLowerCase();
  let out = '';
  for (const ch of t) out += GLYPH_CONFUSABLES[ch] || ch;
  return out;
}
function leetCollapse(s) {
  let out = '';
  for (const ch of s) out += LEET[ch] || ch;
  return out.replace(/[^a-z0-9]/g, '').replace(/(.)\1+/g, '$1');
}

// Titles matched as whole words (a trailing number is ignored: "admin2").
const TITLE_TOKENS = new Set(['mod', 'mods', 'admin', 'admins', 'gm', 'owner', 'staff', 'system', 'support', 'security', 'operator', 'verified', 'official', 'moderator', 'moderators', 'sysop', 'webmaster'].map(leetCollapse));
// Long enough that appearing anywhere in the squashed name is a signal.
const TITLE_SUBSTRINGS = ['moderator', 'administrator', 'official', 'verified', 'sysop', 'webmaster', 'superuser', 'domainatlas'].map(leetCollapse);
const NEGATED = ['unofficial', 'unverified'].map(leetCollapse);

// True when `name` should be refused. `domain` (optional) is the domain being
// joined: a name that spells out the domain itself is refused too.
function nameLooksOfficial(name, domain) {
  const folded = foldName(name);
  if (BADGE_GLYPHS.test(String(name || '').normalize('NFKC'))) return true;
  const rawTokens = folded.split(/[^a-z0-9@$!|]+/).filter(Boolean);
  for (const tok of rawTokens) {
    if (TITLE_TOKENS.has(leetCollapse(tok.replace(/[0-9]+$/, '')))) return true;
  }
  let squash = leetCollapse(folded);
  NEGATED.forEach((n) => { squash = squash.split(n).join(''); });
  if (TITLE_SUBSTRINGS.some((w) => squash.includes(w))) return true;
  if (TITLE_TOKENS.has(squash)) return true; // letters spread out with punctuation: "m.o.d"
  const dom = leetCollapse(foldName(domain)).replace(/^www/, '');
  if (dom.length >= 5 && squash.includes(dom)) return true;
  return false;
}

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
// lastSeen}); `rawAddress` is the socket peer address. Returns
// {ok:true, roomKey, room, roster, publicId}, or {ok:false, reason[,
// retryAfter]} with reason 'invalid', 'join-rate-limited', 'name-not-allowed',
// 'source-limit', 'room-full' or 'server-busy'. A refused join creates no
// member, so it never changes a room's count.
function addMember(connId, domainRaw, worldRaw, nameRaw, extra, rawAddress, visitRaw) {
  const domain = cleanId(domainRaw);
  const world = cleanId(worldRaw);
  if (!domain || !world) return { ok: false, reason: 'invalid' };
  const src = sourceKeyOf(rawAddress);
  const retryAfter = noteJoinAttempt(src, 'presence', Date.now());
  if (retryAfter !== null) return { ok: false, reason: 'join-rate-limited', retryAfter };
  if (nameLooksOfficial(cleanName(nameRaw), domain)) return { ok: false, reason: 'name-not-allowed' };
  const roomKey = roomKeyFor(domain, world);
  let room = rooms.get(roomKey);
  const countAll = (k) => { let n = 0; connIndex.forEach((loc, id) => { const m = loc.room.get(id); if (m && m.src === k) n++; }); return n; };
  if (sourceAdmission(src, room, MAX_MEMBERS_PER_ROOM, countAll, SOURCE_MAX_PRESENCE, SOURCE_MAX_PRESENCE_PER_ROOM)) return { ok: false, reason: 'source-limit' };
  if (!room && rooms.size >= MAX_ROOMS) return { ok: false, reason: 'server-busy' };
  if (connIndex.size >= MAX_TOTAL_MEMBERS) return { ok: false, reason: 'server-busy' };
  if (room && room.size >= MAX_MEMBERS_PER_ROOM) return { ok: false, reason: 'room-full' };
  if (!room) { room = new Map(); rooms.set(roomKey, room); }

  const name = cleanName(nameRaw);
  const publicId = randomId();
  const roster = rosterOf(room, connId);
  const member = Object.assign({ publicId, name, x: 0, y: 0, z: 0, yaw: 0, src, joinedAt: Date.now(), visit: moderation.visitHash(domain, world, visitRaw) }, extra);
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
// history} or {ok:false, reason[, retryAfter]} (the same reasons as
// addMember). A poll member's `cursor` starts at "already seen everything in
// the history handed back", so its first sync only returns messages that
// arrive after this join.
function joinChatRoom(connId, domainRaw, worldRaw, nameRaw, extra, rawAddress, visitRaw) {
  const domain = cleanId(domainRaw);
  const world = cleanId(worldRaw);
  if (!domain || !world) return { ok: false, reason: 'invalid' };
  const src = sourceKeyOf(rawAddress);
  const retryAfter = noteJoinAttempt(src, 'chat', Date.now());
  if (retryAfter !== null) return { ok: false, reason: 'join-rate-limited', retryAfter };
  if (nameLooksOfficial(cleanName(nameRaw), domain)) return { ok: false, reason: 'name-not-allowed' };
  pruneChatHistory(domain, Date.now());
  let room = chatRooms.get(domain);
  const countAll = (k) => { let n = 0; chatConnIndex.forEach((loc, id) => { const m = loc.room.get(id); if (m && m.src === k) n++; }); return n; };
  if (sourceAdmission(src, room, MAX_CHAT_MEMBERS_PER_DOMAIN, countAll, SOURCE_MAX_CHAT, SOURCE_MAX_CHAT_PER_DOMAIN)) return { ok: false, reason: 'source-limit' };
  if (!room && chatRooms.size >= MAX_CHAT_DOMAINS) return { ok: false, reason: 'server-busy' };
  if (room && room.size >= MAX_CHAT_MEMBERS_PER_DOMAIN) return { ok: false, reason: 'room-full' };
  if (!room) { room = new Map(); chatRooms.set(domain, room); }
  const history = chatHistory.get(domain) || [];
  const senderId = randomId();
  const member = Object.assign({ name: cleanName(nameRaw), senderId, world, cursor: currentChatSeq(domain), lastSendAt: 0, src, joinedAt: Date.now(), visit: moderation.visitHash(domain, world, visitRaw) }, extra);
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

function handleConnection(socket, peerAddress) {
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
        const result = addMember(connId, msg.domain, msg.world, msg.name, { transport: 'ws', socket }, peerAddress, msg.visit);
        if (!result.ok) { sendText(socket, Object.assign({ type: 'join-denied' }, denial(result))); return; }
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
        const result = joinChatRoom(connId, msg.domain, msg.world, msg.name, { transport: 'ws', socket }, peerAddress, msg.visit);
        if (!result.ok) { sendText(socket, Object.assign({ type: 'chat-error' }, denial(result))); return; }
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
  // An HTTP-upgraded socket is half-open: a peer that drops the TCP
  // connection without a close frame ends its side but the socket stays open
  // until this side ends too. Release the seat as soon as the peer is gone
  // instead of waiting for the heartbeat to notice.
  socket.on('end', () => { leaveRoom(); leaveChat(); try { socket.end(); } catch (err) {} });

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
  pruneSourceLimits(now);
}, POLL_SWEEP_INTERVAL_MS);
sweepTimer.unref();

function readBody(req, limit) {
  const max = limit || MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return; // keep draining so the 413 can be delivered, but stop buffering
      size += chunk.length;
      if (size > max) { tooLarge = true; data = ''; reject(new Error('body too large')); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// CORS is only opened for the read-only status route, which a content
// script on any page calls to show a participant count. Every other route is
// called from the extension's own pages, which do not need it.
function sendJson(res, status, obj, cors, extraHeaders) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders);
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

const JOIN_FAILURE_STATUS = { 'invalid': 400, 'name-not-allowed': 400, 'join-rate-limited': 429, 'source-limit': 429 };

// Sends a refused polling join: 400 (fix the request or name), 429 (this
// source is over its limits) or 503 (the room or server is full), with
// Retry-After where waiting helps. `error` is the readable message.
function sendJoinFailure(res, result) {
  const d = denial(result);
  const headers = d.retryAfter ? { 'Retry-After': String(d.retryAfter) } : undefined;
  return sendJson(res, JOIN_FAILURE_STATUS[result.reason] || 503, Object.assign({ error: d.message }, d), false, headers);
}

// The anonymous sessions of one world, for an authorized moderator. Presence
// and chat sessions of the same visit (same keyed visit hash) appear as one
// entry. Each entry carries only: a temporary locator (`ref`, derived from a
// per-process secret and never accepted as a credential anywhere), the display
// name(s), the world, when the visit began, whether it is in presence and/or
// chat, and the public avatar and chat sender ids that every participant
// already sees. Never wallet keys, credentials, network addresses or hashes of
// them, connection tokens, or the visit id itself.
function buildModerationRoster(domain, world) {
  const now = Date.now();
  const groups = new Map(); // group key -> entry under construction
  function slot(key, kind) {
    let k = key;
    for (let n = 2; groups.has(k) && groups.get(k)[kind]; n++) k = key + '#' + n; // one presence and one chat per visit
    if (!groups.has(k)) groups.set(k, { key: k, presence: null, chat: null });
    return groups.get(k);
  }
  const room = rooms.get(roomKeyFor(domain, world));
  if (room) room.forEach((m, connId) => { slot(m.visit ? 'v:' + m.visit : 'p:' + connId, 'presence').presence = m; });
  const chat = chatRooms.get(domain);
  if (chat) chat.forEach((m, connId) => { if (m.world === world) slot(m.visit ? 'v:' + m.visit : 'c:' + connId, 'chat').chat = m; });
  const participants = [];
  groups.forEach((g) => {
    const joined = Math.min(g.presence ? g.presence.joinedAt : Infinity, g.chat ? g.chat.joinedAt : Infinity);
    const entry = {
      ref: moderation.participantRef(domain, world, g.key),
      name: g.presence ? g.presence.name : g.chat.name,
      world,
      joinedAt: new Date(joined).toISOString(),
      ageSeconds: Math.max(0, Math.floor((now - joined) / 1000)),
      presence: { joined: !!g.presence, avatarId: g.presence ? g.presence.publicId : null },
      chat: { joined: !!g.chat, senderId: g.chat ? g.chat.senderId : null },
      linked: !!(g.presence && g.chat)
    };
    if (g.presence && g.chat && g.chat.name !== g.presence.name) entry.chatName = g.chat.name;
    participants.push(entry);
  });
  participants.sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : a.ref < b.ref ? -1 : 1));
  return { domain, world, generatedAt: new Date(now).toISOString(), count: participants.length, participants };
}

// POST /presence/moderation/roster — body {grant, request}; see lib-moderation.js
// for what must hold. Failures never reveal whether a room exists.
const MODERATION_MAX_BODY_BYTES = envNumber('MODERATION_MAX_BODY_BYTES', 32 * 1024);
async function handleModerationRoster(req, res) {
  const src = sourceKeyOf(peerOf(req));
  const retryAfter = moderation.failureRetryAfter(src, Date.now());
  if (retryAfter) return sendJson(res, 429, { error: 'too many failed moderation requests; try again later', code: 'rate-limited', retryAfter }, false, { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' });
  let body;
  try { body = JSON.parse((await readBody(req, MODERATION_MAX_BODY_BYTES)) || '{}'); } catch (err) {
    if (err && err.message === 'body too large') throw err;
    moderation.noteFailure(src, Date.now());
    return sendJson(res, 400, { error: 'malformed request', code: 'bad-request' }, false, { 'Cache-Control': 'no-store' });
  }
  const auth = await moderation.authorize(body, { operation: 'roster.view' });
  if (!auth.ok) {
    if (auth.status < 500 && auth.code !== 'rate-limited') moderation.noteFailure(src, Date.now());
    return sendJson(res, auth.status, { error: auth.message, code: auth.code }, false, { 'Cache-Control': 'no-store' });
  }
  return sendJson(res, 200, buildModerationRoster(auth.domain, auth.world), false, { 'Cache-Control': 'no-store' });
}

// The socket peer address; never a header (see "network sources").
function peerOf(req) { return req.socket && req.socket.remoteAddress; }

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
      const result = addMember(connId, body.domain, body.world, body.name, { transport: 'poll', lastSeen: Date.now() }, peerOf(req), body.visit);
      if (!result.ok) return sendJoinFailure(res, result);
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
      const result = joinChatRoom(connId, body.domain, body.world, body.name, { transport: 'poll', lastSeen: Date.now() }, peerOf(req), body.visit);
      if (!result.ok) return sendJoinFailure(res, result);
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

    if (req.method === 'POST' && req.url === '/presence/moderation/roster') {
      return await handleModerationRoster(req, res);
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

  // Cap open connections per source, joined or not, so idle sockets cannot be
  // used to hold resources. A client that is refused falls back to polling.
  const peerAddress = socket.remoteAddress;
  const src = sourceKeyOf(peerAddress);
  const open = socketsBySource.get(src) || 0;
  if (open >= SOURCE_MAX_SOCKETS) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 10\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  socketsBySource.set(src, open + 1);
  socket.once('close', () => {
    const n = (socketsBySource.get(src) || 1) - 1;
    if (n > 0) socketsBySource.set(src, n); else socketsBySource.delete(src);
  });

  const acceptKey = acceptKeyFor(clientKey);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey + '\r\n' +
    '\r\n'
  );
  handleConnection(socket, peerAddress);
});

server.listen(PORT, () => {
  console.log('Domain Atlas presence server listening on http://localhost:' + PORT + ' (WebSocket at /presence)');
});

module.exports = { server, rooms, nameLooksOfficial, sourceKeyOf };
