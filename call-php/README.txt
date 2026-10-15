DOMAIN ATLAS - PHP Call Service
================================

What this is
-------------
A drop-in Call Service for plain PHP + Apache hosting, the same job as
call-server/server.js (the Node service) with no Node process. It carries only
the signed messages that set up an end-to-end encrypted wallet-to-wallet voice
call (invite, accept, offer, answer, candidates, confirmations, hang up). The
audio never touches it: it goes directly between the two browsers (WebRTC).

It speaks the same wire protocol as the Node service: the same signed
messages, the same checks, the same refusals. A wallet cannot tell which one
it is talking to, and a call can run through either. The one visible difference
is that this service never holds a request open: wallets ask again every
second or two, and the service says how long to wait.

Layout
-------
  atlas/call/                the folder to upload (see below)
    .htaccess                clean URLs (/atlas/call/listen -> listen.php)
    info.php listen.php invite.php poll.php signal.php ice.php
    tag/create.php tag/list.php tag/revoke.php
    lib/                     web-denied: code, settings, state
      .htaccess bootstrap.php protocol.php service.php store.php
      config.example.php     copy to config.php on the host and edit
  test-router.php            for `php -S` testing only; do not upload
  tools/                     operator and test tools; do not upload

Installing (summary; docs/voice-calls-deploy-php.md has every step)
------------------------------------------------------------------
1. Upload the contents of atlas/call/ to atlas/call/ in the domain's document
   root, next to the issuer's atlas/ files. 16 files. Nothing else.
2. On the host, copy lib/config.example.php to lib/config.php. Set the origin
   (https://your-domain), the domain, the issuer's public key (from
   /.well-known/atlas-key.json), the path of the issuer's revocations file and a
   state folder outside the web root. chmod 600 the file.
3. From any computer: node call-server/check-deployment.js https://your-domain
   It must show no FAIL, in particular for "settings, state and source files are
   not served".

Until config.php exists every route answers 503 calls-not-configured and writes
nothing. Remove or rename it to switch calling off.

Two domains
------------
Each domain gets the same files and its own config.php (its own origin,
domain, issuer key and state folder). A call always runs through the callee's
service; the caller needs no membership there. See section 6 of the guide.

What it does not do
--------------------
No long polling, no WebSocket, no background process, no database, and no
third-party calling, signalling, STUN or TURN service. STUN and TURN are
optional, are yours, and are set up separately
(docs/voice-calls-deploy-turn.md).

Testing without a host
-----------------------
  node test/manual-call-php-service.js       shared service suite, 108 checks
  node test/manual-call-php-protocol.js      PHP vs Node protocol comparison
  node test/manual-call-php-hosting.js       settings, HTTP layer, bundle
  node test/manual-call-php-cross.js         two domains, Node and PHP pairings
  node test/manual-call-php-concurrency.js   parallel requests
  xvfb-run -a node test/manual-call-php-e2e-cross.js   real browsers
Needs `php` (openssl, curl) on PATH. These use PHP's built-in web server, not
Apache; see docs/voice-calls-deploy-php.md section 10 for what is unverified.
