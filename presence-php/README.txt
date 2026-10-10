DOMAIN ATLAS — PHP presence + chat (polling fallback)
=========================================================

What this is
-------------
A drop-in polling backend for multiplayer presence AND in-world chat that
runs on plain PHP + Apache — no
Node.js Selector needed, same reason issuer-php exists (see
issuer-php/README.txt). It answers the same polling routes
presence-server/server.js does — /presence/poll/join, /sync, /leave for
presence; /presence/poll/chat-join, /chat-sync, /chat-send,
/chat-leave for chat — backed by JSON files instead of in-memory Maps, so
other visitors in the same world show up as walking characters, and chat
messages show up for everyone in the domain, exactly like the Node
version — just on a ~2 second update cycle instead of continuous, since
there's no persistent connection to push updates down.

This bundle deliberately does NOT include a WebSocket server, and never
will — see "Why there's no WebSocket version of this" below. It's not a
missing feature; it's a hosting constraint that has nothing to do with
PHP specifically.

Nothing in the browser extension needs to change to use this, beyond one
line in your manifest (see "Turning this on" below) — it calls the exact
same /presence/poll/join, /sync, /leave shapes either way.


Moderator session list (optional)
------------------------------------
presence/moderation/roster.php lets a moderator whose domain issuer has
signed a grant see who is in one world: display name, world, when they
joined, whether they are in presence and/or chat, and the public avatar and
chat ids (and whether the visitor is currently muted). It never returns wallet
keys, credential ids, network addresses or connection tokens.
presence/moderation/command.php lets the same moderator mute, unmute or kick
one of those listed sessions for a limited time (the only other things a
grant can do). A mute refuses the visitor's chat messages; a kick removes
their presence and chat sessions and refuses the same visit for a while.
Both are private to this service: they are kept in
presence/lib/atlas-presence-restrictions.json (hashes, cause codes and
expiry times only; created on first use, ignored by Git, web-denied with the
rest of lib/), expire by themselves and are bounded. There is no persistent ban.
Starting a new visit (a page reload) is not blocked: this is a cooldown, not
an identity ban. Moderation is off until you create
presence/lib/atlas-presence-moderation-config.json (not part of the repository; lib/ is web-denied by .htaccess):

  {
    "enabled": true,
    "audience": "https://presence.example.com",
    "domains": {
      "example.com": {
        "issuerKeys": ["<the domain's public key from /.well-known/atlas-key.json>"],
        "statusUrl": "https://example.com/atlas/moderation/status"
      }
    },
    "revokedModerators": [],
    "revokedGrants": []
  }

- "audience" is this presence service's own origin; it must equal one of the
  origins listed in the issuer's moderation config.
- "issuerKeys" are the ONLY keys trusted for that domain. Nothing is fetched
  from a manifest or taken from a request. During an issuer key rotation list
  both keys, then remove the old one.
- "statusUrl" must be https (http only for localhost). Each request checks a
  short-lived signed statement from the issuer saying who is still a
  moderator; if it cannot be obtained the request is refused (fail closed).
- Emergency revocation: add a moderator's reference to "revokedModerators"
  (print it on any machine with Node: node tools/moderation-ref.js <domain>
  <moderator public key>), or a grant id to "revokedGrants", or set "enabled"
  to false, or delete the key from "issuerKeys". Each takes effect on the
  next request; the file is read every time.
- An unparseable or invalid file turns moderation off. A bad domain entry
  is ignored and that domain is refused.

Moderator panel and audit log
------------------------------
The domain's admin page has a "World moderation" section (a "Moderate" button
in the wallet) that talks to roster.php, command.php and audit.php. It needs
this config file, the issuer's own moderation config (see the setup guide) and
"walletBridge": {"sign": ["moderation-grant"]} in the domain manifest. The
browser calls cross-origin; these three files answer the browser's check only
for https://<domain> of the domains listed in the config above.

moderation/audit.php returns the audit entries of one world to a moderator
whose grant allows "audit.view" there. Every moderation request that reached a
verified grant is written to presence/lib/atlas-presence-moderation-audit.jsonl
(created on first use, mode 0600, ignored by Git, web-denied with the rest of
lib/ - request it by URL once to confirm your host really refuses it). It holds
references, world, action, length, reason code and outcome only: never names,
chat text, keys, tokens, visit ids or network addresses. It is capped at 1 MiB
and 90 days (MODERATION_AUDIT_MAX_BYTES, MODERATION_AUDIT_RETENTION_DAYS); writes
are serialized with flock. If the file cannot be written, mute/unmute/kick are
refused. Entries are hash-chained, which exposes accidental damage and casual
edits but is NOT tamper-proof: whoever can write the file can rewrite it.

Upload presence/lib/audit.php, lib/moderation.php, lib/store.php and
moderation/roster.php, command.php, audit.php. Update this presence service
BEFORE the issuer (the issuer's status statement now includes a role that older
presence code rejects). Never upload a local audit or config file.

Full design, wire format, revocation bounds and limits:
docs/moderation-authorization.md in the main repository; step-by-step setup:
docs/moderation-setup.md.


Requirements
-------------
- Apache with mod_rewrite and AllowOverride enabled for your account
  (virtually always the default on cPanel, same as issuer-php needs).
- PHP with nothing special enabled for presence and chat — no openssl
  needed for those (they are not signed/credentialed operations). The
  OPTIONAL moderation endpoint (see "Moderator session list" below) verifies
  ECDSA signatures and needs the openssl extension plus curl or
  allow_url_fopen to reach your issuer; without a moderation config file it
  answers 503 and nothing else is affected.
- No composer, no Node, no build step. Just upload the files.


What's in this folder
-----------------------
  presence/
    poll/
      join.php       - POST /presence/poll/join    (a visitor enters a room)
      sync.php       - POST /presence/poll/sync     (heartbeat + move + roster fetch)
      leave.php      - POST /presence/poll/leave    (a visitor explicitly leaves)
      chat-join.php  - POST /presence/poll/chat-join  (a visitor joins a domain's chat)
      chat-sync.php  - POST /presence/poll/chat-sync  (heartbeat + fetch new messages)
      chat-send.php  - POST /presence/poll/chat-send  (send one chat message)
      chat-leave.php - POST /presence/poll/chat-leave (a visitor explicitly leaves chat)
    status.php       - GET /presence/status (how many are in a world right now; a count only)
    moderation/
      roster.php     - POST /presence/moderation/roster (read-only anonymous
                        session list for an authorized moderator; answers 503
                        until you configure it — see "Moderator session list")
      audit.php      - POST /presence/moderation/audit (the private audit log
                        of one world, for a moderator allowed "audit.view")
      command.php    - POST /presence/moderation/command (mute, unmute or
                        kick one listed session, for an authorized moderator;
                        same configuration)
    lib/
      moderation.php             - moderator-grant verification (shared code,
                                    not a web route)
      restrictions.php           - temporary mutes and kicks (shared code)
      audit.php                  - the private moderation audit log (shared
                                    code; its file is created on first use)
      bootstrap.php, store.php  - shared code, not web routes — store.php
                                    holds BOTH the presence room logic and
                                    the chat room logic (see its own
                                    "in-world chat" section)
      .htaccess                  - blocks direct web access to this folder
                                    (this is where the two state JSON files
                                    live: atlas-presence-store.json,
                                    atlas-chat-store.json and
                                    atlas-presence-ratelimit-store.json;
                                    all are runtime state, created on first
                                    use, and ignored by Git)
    .htaccess        - makes the URLs above work without a .php extension,
                        matching what the extension calls


How to install on your domain (cPanel File Manager)
-----------------------------------------------------
1. Open File Manager, go to your site's document root (public_html, or
   wherever /.well-known/spatial.json already lives — same place you
   uploaded issuer-php's atlas/ and lib/ folders, if you're running that
   too).
2. Upload the "presence" folder so it sits right next to your existing
   .well-known folder — same directory level.
3. That's it. There's nothing to configure and nothing to generate — no
   keypair, no first-run setup. The first poll request will create
   presence/lib/atlas-presence-store.json on its own, and the first chat
   poll request will likewise create presence/lib/atlas-chat-store.json.

If you already have a .htaccess in public_html for something else (like
WordPress, or issuer-php's own atlas/.htaccess), you don't need to touch
it — the rewrite rule here lives in presence/.htaccess and only affects
requests under /presence/.


Turning this on — the one line you actually need
----------------------------------------------------
Uploading the files makes the routes reachable, but nothing points your
visitors' extensions at them until your domain's manifest
(.well-known/spatial.json) says so. Add a top-level "presence" field:

  {
    "spec": "domain-atlas/1.0",
    "domain": "example.com",
    "presence": "https://example.com",
    "defaultWorld": "...",
    "worlds": [ ... ]
  }

This is NOT part of SPEC.md — it's a plain, optional, implementation-only
convenience field, the same way presence itself isn't a formal protocol
claim yet. A manifest with no "presence" field gets the Node dev default
(localhost:8004) only when the manifest is itself served from a loopback
host, so every local demo domain keeps working; a remote manifest with no
field gets no presence or chat.

Which origin the extension will talk to is the VISITOR'S decision: a
presence server on the manifest's own origin (the example above) is used
automatically, while one on any other origin is only used after the visitor
approves that pair of sites in a prompt (recorded under Settings ->
Presence servers). Point "presence" at your own domain unless you have a
reason not to.

With "presence" set to your own domain, extension/viewer.js derives:
  - a WebSocket URL: wss://example.com/presence — nothing answers this on
    plain PHP hosting, so the connection attempt fails fast (or hangs
    briefly, then times out after ~2.5s)
  - an HTTP polling base: https://example.com — which IS what this bundle
    answers, at /presence/poll/join etc.

The extension always tries WebSocket first and falls back to polling on
its own the moment that attempt fails — there's no "this domain is
polling-only" flag to set. Pointing "presence" at a domain that only runs
this PHP bundle is enough; the fallback logic (already built and tested,
see extension/viewer.js and test/manual-presence-polling-fallback.js in
the main repo) does the rest.

This SAME "presence" field is also where in-world chat gets its base URL
from (extension/viewer.js's connectChat()/pollChat() reuse it) — there is
no separate manifest field for chat. Uploading this bundle and setting
"presence" lights up both presence AND chat on the polling fallback at
once; nothing extra to configure.


Why there's no WebSocket version of this
--------------------------------------------
A WebSocket server has to stay running continuously, holding open
connections in memory and answering them the instant something changes.
That needs a persistent process bound to a port. Plain cPanel/Apache+PHP
shared hosting runs the opposite model on purpose: every request is its
own short-lived PHP execution that starts, answers, and exits — the exact
same reason issuer-php exists instead of running issuer-server/server.js
directly (see issuer-php/README.txt's own explanation). Porting the
WebSocket half to PHP wouldn't help: even a PHP WebSocket library (like
Ratchet) needs a long-running daemon process with shell access, which is
precisely what this kind of hosting doesn't give you. If your hosting
plan ever gains a way to run a persistent process (a Node.js Selector, a
VPS, anything that lets you `node presence-server/server.js` and leave it
running), that gets you the real thing — continuous updates, not a ~2s
poll cycle — and you'd point "presence" in your manifest at that instead.


In-world chat: what's different from presence
--------------------------------------------------
Chat rides the SAME polling model as presence above — try
WebSocket first (nothing answers it here), fall back to
/presence/poll/chat-join, /chat-sync, /chat-send, /chat-leave — but the
room shape is different in one way worth knowing: presence rooms are
keyed by domain+world (one roster per world), while chat is keyed by
DOMAIN ALONE. Every visitor anywhere on your domain shares one chat room,
and every message is tagged with whichever world its sender was in —
that's what lets extension/viewer.js offer both a "This World" tab
(filtered to the current world) and a "Domain" tab (everyone) from the
exact same message stream, without this bundle needing to track two
separate histories.

Reading chat never requires a wallet identity — any visitor sees the
backlog and live messages with no login. Chat carries no identity at all:
a message has a display name and a random per-join senderId this bundle
assigns, and no public key. A display name is whatever the sender typed, so
it proves nothing, and senderId only tells connections apart. The
extension enables the chat input only while the wallet is unlocked, but
that is a client-side choice; this bundle does not (and cannot) verify it,
and instead rate-limits each connection (CHAT_MIN_INTERVAL_MS) and filters
every message server-side (lib/store.php's chat_text_contains_blocked_word(),
a plain substring match against a punctuation-normalized-to-spaces version
of the text — see that function's own comment for why substring rather than
whole-word-only) before it's ever added to the history or handed back to
anyone else, same as the Node version's identical check.

A poll-based chat member has no persistent connection to be pushed a new
message on, so instead each member carries a `cursor` (the highest
message sequence number it has already seen) and /presence/poll/chat-sync
hands back only what's newer, advancing the cursor to match — a small
delta each poll (~2s cycle) instead of re-fetching the whole history
every time.


A note on room state and privacy
------------------------------------
presence/lib/atlas-presence-store.json holds every current visitor's
in-world position, look and display name, across every room, plus a random
public id and a private poll token per member. No wallet public key or
other persistent identifier is stored: a member is a name, a pose and a
look, and both identifiers are random per join. presence/lib/
atlas-chat-store.json holds every domain's recent chat history plus current
chat-poll member bookkeeping. Both files are inherently ephemeral and
low-stakes, but they are still real visitor data, so both live in lib/
behind the same web-access deny-all .htaccess as everything else private in
this bundle, not under .well-known, and both are ignored by Git. There is no
admin/listing endpoint for either, and GET /presence/status returns only a
count.

Retention and cleanup:
  - A presence member that stops syncing is removed after
    POLL_TIMEOUT_MS (default 15000). Every locked write sweeps ALL rooms,
    not only the one being touched, so rooms nobody visits again are still
    cleaned up as soon as anyone anywhere makes a request.
  - Chat history keeps at most CHAT_HISTORY_LIMIT messages (default 50)
    and drops anything older than CHAT_HISTORY_TTL_MS (default 24 hours).
    Chat domains with no members and no history are deleted.
  - Store files written by older versions (which carried a wallet public
    key, pending friend signals or duplicate-join bookkeeping) are scrubbed
    of those fields the first time any request touches them.

Limits (environment variables; the Node server reads the same names): each
request is bounded and an over-limit join is refused with 503 room-full or
server-busy:
  MAX_ROOMS (500)  MAX_MEMBERS_PER_ROOM (100)  MAX_TOTAL_MEMBERS (2000)
  MAX_CHAT_DOMAINS (500)  MAX_CHAT_MEMBERS_PER_DOMAIN (200)
  MAX_BODY_BYTES (8192; larger bodies get 413)  CHAT_MIN_INTERVAL_MS (400)
  CHAT_HISTORY_LIMIT (50)  CHAT_HISTORY_TTL_MS (86400000)
  POLL_TIMEOUT_MS (15000)
domain and world ids must be 1-120 characters of valid UTF-8 with no control
characters (spaces, slashes and non-ASCII are fine; they are only room keys).


Abuse limits per network source
---------------------------------
One visitor must not be able to fill a world or a domain's chat with fake
sessions, so joins are also limited per SOURCE. A source is the connection's
REMOTE_ADDR (IPv6 grouped by /64) and nothing else: X-Forwarded-For and
similar headers are ignored because a visitor controls them. The address is
stored only as a keyed hash, never raw, and only for as long as it is needed:
on a visitor's record until that record times out, and in the rate-limit
table until the join window / cooldown has passed. It is never returned by any
route or shown to other visitors or to world administrators.

Defaults (environment variables, same names as the Node server):
  SOURCE_MAX_PRESENCE (30)            presence sessions per source, all rooms
  SOURCE_MAX_PRESENCE_PER_ROOM (10)   presence sessions per source in one room
  SOURCE_MAX_CHAT (20)                chat sessions per source, all domains
  SOURCE_MAX_CHAT_PER_DOMAIN (10)     chat sessions per source in one domain
  SOURCE_SOFT_FULL_RATIO (0.8)        once a room is this full, a source that
  SOURCE_SOFT_FULL_MAX (3)            already holds this many is refused, so
                                      the last seats go to other sources
  SOURCE_JOIN_MAX (60)                join attempts per window, presence and
  SOURCE_JOIN_WINDOW_MS (60000)       chat counted separately
  SOURCE_COOLDOWN_MS (30000)          pause after exceeding the budget;
  SOURCE_COOLDOWN_MAX_MS (300000)     doubles on repeat offences, capped
  SOURCE_STRIKE_MEMORY_MS (600000)    how long repeat offences are remembered
  MAX_SOURCE_ENTRIES (2000)           size bound of the rate-limit table
  SOURCE_SALT_ROTATE_MS (86400000)    how often the hash secret changes

A refused join answers {error, reason, message, retryAfter} plus a
Retry-After header: 429 source-limit (too many sessions open from this
address) or 429 join-rate-limited (too many attempts; wait retryAfter
seconds), 503 room-full / server-busy, 400 name-not-allowed (see
docs/presence-abuse-protection.md). Refused joins create no visitor, so
they never change a room's count.

Everyone behind one shared address (a school, an office, a mobile carrier's
NAT, or a reverse proxy in front of this bundle) counts as ONE source. The
defaults leave room for a classroom of ten per world, but a larger shared
group needs SOURCE_MAX_PRESENCE_PER_ROOM / SOURCE_MAX_PRESENCE raised, and
one abusive visitor who trips the join cooldown pauses new joins for
everyone on that address until it ends. On hosting where you cannot set
environment variables, the defaults apply. See docs/presence-abuse-protection.md.

Display names that read as an official title (moderator, admin, staff,
verified, a check-mark badge, the domain's own name, and look-alike
spellings of those) are refused with 400 name-not-allowed. That is a
nuisance filter: display names are still not authenticated, and an allowed
name proves nothing about who is behind it.


Reconnects and duplicate sessions
----------------------------------
There is no duplicate-session guard by identity: presence has no identity to
compare, so a reconnect or a second tab simply joins as another visitor with
a new random id; the old entry disappears when it stops syncing. What bounds
duplicates is the per-source limit above: a source can hold at most
SOURCE_MAX_PRESENCE_PER_ROOM sessions in a room, however often it rejoins. A poll session
whose token has been swept gets 404 from /presence/poll/sync and the
extension rejoins with a fresh id.


One real architectural difference from the Node version, worth knowing
--------------------------------------------------------------------------
presence-server.js holds every room's state in memory for as long as the
process runs, and pushes updates down open WebSocket connections the
instant they happen. This bundle has no long-running process to hold
anything in — every single poll request opens
presence/lib/atlas-presence-store.json fresh, locks it, reads the whole
thing, makes its change, and writes the whole thing back before releasing
the lock. That's a real cost difference (a full file read+write per poll,
not a Map lookup) but not one that matters at demo/small-site scale — the
same "not worth optimizing for the scale this is actually for" reasoning
issuer-php/README.txt gives for re-parsing the private key on every
request. A busy site with hundreds of concurrent visitors in one room
would eventually want a real datastore instead of one flat file; that's a
very different scale of problem than what this bundle is for.


Upgrading from an earlier version
----------------------------------
Upload the files in lib/ and poll/ over the old ones. For the per-source
abuse limits, the files that must be replaced are (paths from the folder that
contains "presence"):
  presence/lib/store.php
  presence/lib/bootstrap.php
  presence/poll/join.php
  presence/poll/chat-join.php
The new state file presence/lib/atlas-presence-ratelimit-store.json is
created on the first join; the folder must be writable by PHP, as it already
is for the other two stores, and lib/ stays denied to web requests by its
.htaccess (open /presence/lib/atlas-presence-ratelimit-store.json in a
browser; it must not load). Rolling back is replacing the four files again;
the old code ignores the extra "src" field on stored visitors and the new
file.

Then DELETE these
files from the live host, which no longer exist and must not stay reachable:
  presence/poll/signal.php
  presence/poll/join-status.php
  presence/poll/duplicate-response.php
  presence/poll/activity.php
Existing atlas-presence-store.json / atlas-chat-store.json files can stay;
they are scrubbed in place. Upgrade the server before (or together with)
the extension: an old server still lists wallet keys to new clients, and
the new extension no longer sends a key, so old servers would reject chat
sends that they require a key for.
