# Presence and chat abuse protection

Presence (who is in a world) and in-world chat are open to anyone who can
reach the server: there is no login, and a display name is whatever the
client typed. This describes the limits that stop one client from filling a
world or a domain's chat with fake sessions, what a refused visitor sees, and
what the limits cannot do. It covers `presence-server/server.js` and
`presence-php/`, which behave the same; `test/manual-presence-abuse.js`
(`node` or `php`) is the regression test.

## What was wrong

One client could open 100 presence sessions in a world (the room limit) and
197 or more chat sessions in a domain (the chat limit), after which every real
visitor was refused with `room-full`. Joins were unlimited, session counts
could be inflated by the same client, and a visitor could take the display
name "Moderator (official)" with nothing to tell it from a real one.

## What a source is

Limits are keyed on the TCP peer address of the request (`socket.remoteAddress`
in Node, `REMOTE_ADDR` in PHP) and nothing else.

- `X-Forwarded-For`, `X-Real-IP`, `Forwarded` and `CF-Connecting-IP` are never
  read: the client controls them.
- IPv4-mapped IPv6 is folded to IPv4; other IPv6 addresses are grouped by /64,
  because one subscriber normally controls a whole /64.
- The key is an HMAC-SHA256 of that, truncated to 16 hex characters, using a
  random secret. In Node the secret is generated at startup and the state is
  memory only. In PHP it lives in `presence/lib/atlas-presence-ratelimit-store.json`
  and rotates every 24 hours; the previous secret is kept for one more period
  so sessions that outlive a rotation are still counted.
- The key is stored in exactly two places: on a visitor's record while that
  visitor exists (a polling visitor is removed `POLL_TIMEOUT_MS` after its last
  sync; a WebSocket visitor when the connection ends), and in the rate-limit
  table while the join window or cooldown lasts. It is not sent to any client,
  is not in any roster, status or chat payload, and is not logged.
- Hashing a 32-bit address is obfuscation, not anonymisation. The protection is
  the short lifetime and keeping it server-side (on PHP, `lib/` is denied to web
  requests by `.htaccess`).
- A source is not an identity and is never banned. A cooldown ends by itself and
  the table forgets idle sources.

## The limits

All are environment variables with the same names on both servers. Counts of
sessions come from the live visitor records, so they cannot drift from reality;
only the join history is separate state.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOURCE_MAX_PRESENCE` | 30 | presence sessions per source across all rooms |
| `SOURCE_MAX_PRESENCE_PER_ROOM` | 10 | presence sessions per source in one room |
| `SOURCE_MAX_CHAT` | 20 | chat sessions per source across all domains |
| `SOURCE_MAX_CHAT_PER_DOMAIN` | 10 | chat sessions per source in one domain |
| `SOURCE_SOFT_FULL_RATIO` / `SOURCE_SOFT_FULL_MAX` | 0.8 / 3 | once a room is 80% full, a source that already holds 3 is refused |
| `SOURCE_JOIN_MAX` / `SOURCE_JOIN_WINDOW_MS` | 60 / 60000 | join attempts per window; presence and chat each |
| `SOURCE_COOLDOWN_MS` / `SOURCE_COOLDOWN_MAX_MS` | 30000 / 300000 | pause after the budget is exceeded; doubles on each repeat inside `SOURCE_STRIKE_MEMORY_MS` (10 min), capped |
| `MAX_SOURCE_ENTRIES` | 10000 Node, 2000 PHP | size bound of the join-history table |
| `SOURCE_MAX_SOCKETS` (Node) | 60 | open WebSocket connections per source, joined or not |
| `SOURCE_SALT_ROTATE_MS` (PHP) | 86400000 | how often the PHP hash secret changes |

With the defaults one source holds at most 10 of a world's 100 places and 10
of a domain's 200 chat places, so at least ten sources are needed to fill
either. Every attempt counts toward the join budget, including refused ones,
so retrying in a tight loop trips the cooldown. An attempt made during a
cooldown is refused without being counted, so waiting it out always works.

## When a room is full

- A source that has reached its share gets `429 source-limit`.
- Once a room is 80% full, a source that already holds 3 places is refused
  with `source-limit`, so the last places go to sources that hold fewer. This is
  fairness between sources, not reserved places: nobody has a guaranteed seat.
- A room that is truly full answers `503 room-full` with `Retry-After: 10`.
- The server is at its overall room or visitor limit: `503 server-busy`,
  `Retry-After: 15`.
- A refused join never creates a visitor, so it never changes a count.

## What the client sees

Polling joins answer `{error, reason, message, retryAfter}` and a `Retry-After`
header. WebSocket denials are `{type:'join-denied'|'chat-error', reason,
message, retryAfter}`. `error` and `message` are the same readable sentence.

| Reason | Status | Meaning |
| --- | --- | --- |
| `source-limit` | 429 | too many sessions open from this network connection |
| `join-rate-limited` | 429 | too many join attempts; wait `retryAfter` seconds |
| `room-full` | 503 | the room is genuinely full |
| `server-busy` | 503 | server-wide limit reached |
| `name-not-allowed` | 400 | the display name reads as an official title |
| `invalid` | 400 | not a usable domain/world |

`join-rate-limited` is deliberately not `rate-limited`, which already means "you
are sending chat messages too fast". `extension/viewer.js` shows a sentence for
each reason in presence and in chat.

## Official-looking display names

Names are not authenticated and cannot be. The guard refuses names that read as
an official title or badge so an ordinary visitor cannot present as
"Moderator (official)": whole words such as moderator, mod, admin, staff, owner,
system, support, security, official, verified, sysop, webmaster (with a trailing
number ignored, so `admin2` is refused); the longer words anywhere in the name;
check-mark, shield and similar badge glyphs; and a name that spells out the
domain being joined. Input is normalised first (compatibility forms such as
fullwidth letters, accents, zero-width characters, common Cyrillic and Greek
look-alikes, digit/symbol substitutions such as `0`, `1`, `3`, `@`, repeated
letters, spacing and punctuation). `unofficial` and `unverified` are allowed.

This is a nuisance filter, not verification. It will miss disguises it does not
know, it refuses a few innocent names ("Mod", "Support Sam"), and an allowed
name proves nothing about who is behind it. A real moderator marker must be a
separate field issued by the server to an authenticated moderator, never text
in the name; none exists yet. The Node guard and the PHP guard give the same
verdicts on the tested names, also when the PHP `intl` extension is missing
(the PHP guard then uses a fallback fold for fullwidth and accented letters).

## Privacy

Unchanged from the previous change: no wallet public key in any presence, chat
or status payload, anonymous per-connection ids, no device fingerprinting, no
tracking across domains, `GET /presence/status` is `{count}` only. The only new
data is the short-lived source hash described above. The test scans every
response for peer addresses and the PHP state files for raw addresses and
`publicKey`.

## Deployment

### Node

Replace `presence-server/server.js` and restart. Nothing else changes. State is
memory only, so a restart clears session counts and cooldowns. Update the
extension (`extension/viewer.js`) to show the new messages; older clients still
work and show their generic "refused" text.

### PHP (plain hosting)

Upload these four files over the old ones, paths from the folder that contains
`presence/`:

- `presence/lib/store.php`
- `presence/lib/bootstrap.php`
- `presence/poll/join.php`
- `presence/poll/chat-join.php`

`presence/lib/atlas-presence-ratelimit-store.json` is created on the first join
(like the other two stores; PHP must be able to write in `presence/lib/`).
Confirm that `/presence/lib/atlas-presence-ratelimit-store.json` does not load
in a browser. Rolling back is uploading the old four files; the old code ignores
the extra `src` field and the new file. If you cannot set environment variables,
the defaults apply.

### Behind a proxy, NAT, school or mobile network

Everyone behind one address is one source. With the defaults a classroom of ten
per world and ten per domain chat is fine; a bigger shared group needs
`SOURCE_MAX_PRESENCE_PER_ROOM` and `SOURCE_MAX_PRESENCE` (and the chat
equivalents) raised, and one abusive visitor who trips the join cooldown pauses
new joins for everyone on that address until it ends (30 s, doubling to 5 min
for repeat offences). If a reverse proxy sits in front of Node or PHP, all
traffic arrives from the proxy's address: raise the limits a lot or enforce
limits at the proxy. The server does not read forwarded-for headers, and there
is no trusted-proxy setting.

## Limits of this change

- It raises the cost of single-source flooding. A distributed attacker with many
  addresses (including many /64s) can still fill a world; counts and names remain
  unauthenticated. Rate limiting at the host or CDN is still advisable.
- Visitor counts can still be inflated, by up to the per-source share per source,
  not by one client alone.
- Duplicate sessions are bounded, not detected: presence has no identity to
  compare, and a reconnect while the old session lingers briefly counts twice.
- A shared address is one budget (see above).
- Node state resets on restart; PHP cooldowns survive a restart (the test asserts
  both). PHP rewrites the whole join-history table on each join, so its table is
  bounded smaller; a very busy site wants a real datastore.
- PHP is polling only, so `SOURCE_MAX_SOCKETS` does not apply there.
- Hex-spelled IPv4-mapped IPv6 peers are folded to IPv4 in both; other IPv6 peers
  are grouped by /64, which the tests check on the key derivation but cannot
  exercise on the wire (loopback has only `::1`).
- Chat message text is not covered: only display names are guarded.

Not in scope and not implemented: moderator commands, persistent bans, reserved
member places, private messaging, proximity chat, trading UI.

## One related fix

A WebSocket client that drops the TCP connection without a close frame now frees
its place at once. Before, the server only noticed at the next heartbeat (about
40 seconds), which let abandoned sessions hold places.
