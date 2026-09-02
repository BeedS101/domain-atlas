DOMAIN ATLAS — PHP presence (polling fallback)
=================================================

What this is
-------------
A drop-in polling backend for multiplayer presence (task #66/#68) that
runs on plain PHP + Apache — no Node.js Selector needed, same reason
issuer-php exists (see issuer-php/README.txt). It answers the same three
polling routes presence-server/server.js does (/presence/poll/join, /sync,
/leave), backed by one JSON file instead of an in-memory Map, so other
visitors in the same world show up as walking characters exactly like the
Node version — just on a ~2 second update cycle instead of continuous,
since there's no persistent connection to push updates down.

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
      join.php     - POST /presence/poll/join   (a visitor enters a room)
      sync.php      - POST /presence/poll/sync    (heartbeat + move + roster fetch)
      leave.php      - POST /presence/poll/leave   (a visitor explicitly leaves)
    lib/
      bootstrap.php, store.php  - shared code, not web routes
      .htaccess                  - blocks direct web access to this folder
                                    (this is where the room-state JSON file
                                    lives)
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
   presence/lib/atlas-presence-store.json on its own.

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


A note on room state and privacy
------------------------------------
presence/lib/atlas-presence-store.json holds every current visitor's
in-world position and display name, across every room, at all times.
Unlike issuer-php's atlas-mail-store.json (private correspondence) this is
inherently ephemeral and low-stakes — display names default to a short
public-key fragment or "Visitor" unless someone set a wallet alias, and
positions are meaningless outside the 3D scene they belong to — but it's
still real visitor data, so it lives in lib/ behind the same web-access
deny-all .htaccess as everything else private in this bundle, not under
.well-known. There's no admin/listing endpoint for it either, same
reasoning as issuer-php's subscriber roster.


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
