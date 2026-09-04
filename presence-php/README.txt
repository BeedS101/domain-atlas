DOMAIN ATLAS — PHP presence + chat (polling fallback)
=========================================================

What this is
-------------
A drop-in polling backend for multiplayer presence (task #66/#68) AND
in-world chat (task #105-110) that runs on plain PHP + Apache — no
Node.js Selector needed, same reason issuer-php exists (see
issuer-php/README.txt). It answers the same polling routes
presence-server/server.js does — /presence/poll/join, /sync, /signal,
/leave for presence; /presence/poll/chat-join, /chat-sync, /chat-send,
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


Requirements
-------------
- Apache with mod_rewrite and AllowOverride enabled for your account
  (virtually always the default on cPanel, same as issuer-php needs).
- PHP with nothing special enabled — no openssl needed here (presence
  isn't a signed/credentialed operation, unlike everything in issuer-php).
- No composer, no Node, no build step. Just upload the files.


What's in this folder
-----------------------
  presence/
    poll/
      join.php       - POST /presence/poll/join    (a visitor enters a room)
      sync.php       - POST /presence/poll/sync     (heartbeat + move + roster fetch)
      signal.php     - POST /presence/poll/signal   (friend-request relay, #67)
      leave.php      - POST /presence/poll/leave    (a visitor explicitly leaves)
      chat-join.php  - POST /presence/poll/chat-join  (a visitor joins a domain's chat)
      chat-sync.php  - POST /presence/poll/chat-sync  (heartbeat + fetch new messages)
      chat-send.php  - POST /presence/poll/chat-send  (send one chat message)
      chat-leave.php - POST /presence/poll/chat-leave (a visitor explicitly leaves chat)
    status.php       - GET /presence/status (who's in a world right now, #61)
    lib/
      bootstrap.php, store.php  - shared code, not web routes — store.php
                                    holds BOTH the presence room logic and
                                    the chat room logic (see its own
                                    "in-world chat" section)
      .htaccess                  - blocks direct web access to this folder
                                    (this is where the two state JSON files
                                    live: atlas-presence-store.json and
                                    atlas-chat-store.json)
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
claim yet. A manifest with no "presence" field (every local demo domain in
this repo) just keeps using the Node dev default
(ws://localhost:8004/presence) — nothing about local development changes
because of this bundle existing.

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
Chat (task #105-110) rides the SAME polling model as presence above — try
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
backlog and live messages with no login. SENDING requires an unlocked
wallet identity (this app's own rule, not a hosting constraint): a
chat-join with no publicKey can read fine but any chat-send from that
member is rejected server-side with reason "login-required", the same
authoritative check the WebSocket/Node version enforces — never trust a
client-side gate alone, since a modified client could always skip it.
Every message is also profanity-filtered server-side (lib/store.php's
chat_text_contains_blocked_word(), a plain substring match against a
punctuation-normalized-to-spaces version of the text — see that
function's own comment for why substring rather than whole-word-only)
before it's ever added to the history or handed back to anyone else, same
as the Node version's identical check.

A poll-based chat member has no persistent connection to be pushed a new
message on, so instead each member carries a `cursor` (the highest
message sequence number it has already seen) and /presence/poll/chat-sync
hands back only what's newer, advancing the cursor to match — a small
delta each poll (~2s cycle) instead of re-fetching the whole history
every time.


A note on room state and privacy
------------------------------------
presence/lib/atlas-presence-store.json holds every current visitor's
in-world position and display name, across every room, at all times.
presence/lib/atlas-chat-store.json holds every domain's recent chat
history (capped at CHAT_HISTORY_LIMIT messages, oldest dropped first —
same rolling-buffer size as the Node version) plus current chat-poll
member bookkeeping. Unlike issuer-php's atlas-mail-store.json (private
correspondence) both of these are inherently ephemeral and low-stakes —
display names default to a short public-key fragment or "Visitor" unless
someone set a wallet alias, positions are meaningless outside the 3D
scene they belong to, and chat messages are, well, a public chat room
anyone in the domain can already read — but it's still real visitor data,
so both files live in lib/ behind the same web-access deny-all .htaccess
as everything else private in this bundle, not under .well-known. There's
no admin/listing endpoint for either, same reasoning as issuer-php's
subscriber roster.


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
