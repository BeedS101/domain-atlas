DOMAIN ATLAS — PHP issuer + trading station
==============================================

What this is
-------------
A drop-in replacement for issuer-server/server.js (the Node backend) that
runs on plain PHP + Apache — no Node.js Selector needed, which is what your
Afrihost cPanel plan doesn't have. It does exactly the same job: generates
a real ECDSA P-256 keypair, signs real domain-atlas-asset/1.0 credentials
(unique and fungible alike, one shape — SPEC.md §5), verifies presented
balances before splitting/trading, and settles two-party trades atomically.

Nothing in the browser extension needs to change to use this. It calls the
same URLs (/atlas/asset/issue, /atlas/asset/reissue, /atlas/asset/split,
/atlas/asset/consolidate, /atlas/asset/trade, /atlas/revoke,
/atlas/mail/check) either way — this bundle's .htaccess makes PHP answer
those exact clean URLs. (/atlas/mail/send and /atlas/asset/reissue are the
two exceptions — they're demo/admin actions, meant to be called by you the
domain operator, not the wallet — see "Sending mail to subscribers" and
"Updating an already-issued asset" below.)

This bundle is a standing mirror of issuer-server/server.js, not a
one-time port — whenever the Node server gains a new endpoint or a new
field on something it issues or checks, this bundle gets the matching
change in the same pass, kept automatically rather than needing to be
asked for each time. issuer-server/server.js carries the same note near
its own top.

This has been tested end-to-end against the real extension (not just unit
tests of the crypto) — a full pass of both the wallet and the loadout/
trading regression suites, run through an actual Chrome instance with real
WebAuthn signing, real cross-domain re-verification, and a real atomic
trade settlement, all passing against this PHP backend.


Requirements
-------------
- PHP with the `openssl` extension enabled. This is virtually always on by
  default on cPanel shared hosting (it's one of the most common PHP
  extensions there is) — nothing special to request from Afrihost.
- Apache with mod_rewrite and AllowOverride enabled for your account
  (also virtually always the default on cPanel).
- No composer, no Node, no build step. Just upload the files.


What's in this folder
-----------------------
  atlas/
    asset/issue.php          - POST /atlas/asset/issue       (issue an asset — unique or fungible, per its class)
    asset/reissue.php        - POST /atlas/asset/reissue     (publish an updated version of an already-issued non-fungible asset — demo/admin use)
    asset/split.php          - POST /atlas/asset/split       (split a fungible balance)
    asset/consolidate.php    - POST /atlas/asset/consolidate (merge fungible balances)
    asset/trade.php          - POST /atlas/asset/trade       (settle a fungible trade)
    revoke.php              - POST /atlas/revoke            (revoke by id)
    mail/send.php            - POST /atlas/mail/send         (send mail about a held credential — demo/admin use)
    mail/check.php           - POST /atlas/mail/check        (wallet's periodic mail check)
    postoffice/send.php      - POST /atlas/postoffice/send   (user-to-user mail — see "Post Office" below)
    .htaccess                - makes the URLs above work without a .php
                                extension, matching what the extension calls
  lib/
    bootstrap.php, crypto.php, store.php  - shared code, not web routes
    .htaccess                - blocks direct web access to this folder
                                (this is where the private key file lives
                                once it's generated)


How to install on your domain (cPanel File Manager)
-----------------------------------------------------
1. Open File Manager, go to your site's document root (public_html, or
   wherever /.well-known/spatial.json already lives).
2. Upload BOTH the "atlas" folder and the "lib" folder so they sit right
   next to your existing .well-known folder — same directory level.
3. That's it. There's nothing to configure. The first request to any
   /atlas/... endpoint will:
     - generate a fresh ECDSA P-256 keypair and save it as
       lib/issuer-private-key.pem (never overwrite or delete this file
       once it exists — every credential you've issued becomes
       unverifiable if you do)
     - write .well-known/atlas-key.json (the public half — this is what
       lets anyone re-verify a credential later, including on a totally
       different domain)
     - write .well-known/atlas-revocations.json (starts empty)

If you already have a .htaccess in public_html for something else (like
WordPress), you don't need to touch it — the rewrite rule here lives in
atlas/.htaccess and only affects requests under /atlas/.


A note on identity
--------------------
The issuer automatically uses whatever domain the request came in on
(the Host header) as the "issuer.domain" baked into every credential it
signs. For a single-domain site like example.com this just works with zero
configuration. If you ever host this same account under multiple domain
names pointing at the same files, or behind a proxy that changes the Host
header, open lib/store.php and look at the atlas_domain() function near
the top — there's a one-line override for exactly that case, commented
inline.


Membership cards and the mail system
---------------------------------------
This bundle also issues an "atlas.membership" asset (non-fungible) — the
same "subscribe to this domain" credential the Node demo uses. A visitor
requests one through the extension's normal asset-request flow (already
built, nothing new needed there); holding that credential IS the
subscription, and the wallet's Mail tab periodically asks
/atlas/mail/check which credentials it holds from this domain and shows
anything sent for them. There's no separate subscribe/unsubscribe
endpoint — hiding or deleting the membership card locally in the wallet
is what stops future mail for it.

To actually send mail to a subscriber, POST to /atlas/mail/send with the
credentialId (the membership card's `id`, visible in the wallet or in
whatever record you keep of who requested one), a subject, and a body:

  curl -X POST https://your-domain/atlas/mail/send \
    -H 'Content-Type: application/json' \
    -d '{"credentialId":"urn:atlas:asset:...","subject":"New exhibit this week","body":"..."}'

That's genuinely it — there's no admin UI for this in the bundle (same as
the Node demo), so a small script or a one-off curl call from your own
machine is the intended way to use it until/unless a real send interface
gets built. The message is signed with your issuer key the same way every
credential is, so the wallet only ever shows something that actually came
from you.

Mail is stored in lib/atlas-mail-store.json — deliberately next to the
private key file, not under .well-known, so it isn't a world-readable
static file the way atlas-revocations.json legitimately needs to be.

Every time someone subscribes (requests an atlas.membership card), two
things happen automatically, no action needed from you:
  - it's logged to lib/atlas-subscribers-store.json — a roster of
    {credentialId, ownerPublicKey, subscribedAt} for every subscriber,
    so you have somewhere to actually find credential ids to message
    later instead of needing a visitor to send you theirs
  - a signed welcome message goes out immediately via the same mechanism
    as /atlas/mail/send, so the first thing a new subscriber's wallet
    picks up on its next mail check is confirmation the subscription
    worked (edit the subject/body in atlas/asset/issue.php's `$welcomePayload`
    if you want different wording)

The subscriber roster is private, same reasoning as the mail store — it's
in lib/, not web-reachable, and there's deliberately no API endpoint that
lists it (a public "who's subscribed" endpoint would leak every
subscriber's public key to anyone who asks, unlike /atlas/mail/send or
/atlas/mail/check which at least require already knowing a credential id).
To actually use the roster today — e.g. to message everyone at once —
open lib/atlas-subscribers-store.json directly via cPanel File Manager or
SSH and loop the credential ids into /atlas/mail/send calls yourself. A
real "broadcast to everyone" admin feature would need proper operator
authentication first, which nothing in this bundle has yet.


Post Office — user-to-user mail (task #75/#87/#94/#95/#96, SPEC.md §11.3)
------------------------------------------------------------------
Everything above is domain-to-subscriber: you (the operator) mailing
someone who holds one of your credentials. Post Office is the other
half — two visitors mailing EACH OTHER, addressed by public key, with no
operator involvement per message.

This bundle also issues an "atlas.postoffice.membership" asset
(non-fungible, same "requesting the class is the whole registration step"
shape as atlas.membership) — a visitor who holds one has registered their
public key with this domain as a Global Mail address. That's the only
thing membership does: it's the abuse gate that decides who this domain
is willing to accept, store, and relay mail for. There's nothing further
for you to configure — a visitor requests it through the extension's
normal asset-request flow (or the demo world's "Claim Global Mail
Membership" stall, if you're running the bundled demo content).

Advertising the role (task #94): add `"postOffice": true` to your
manifest's top level (.well-known/spatial.json, right alongside
`defaultWorld`) and the extension shows a "Join" button directly in the
wallet's Mail screen for anyone visiting your domain — no stall or other
in-world object required, though the demo stall pattern still works fine
too, and both mint the exact same credential. This is a plain,
optional, implementation-only field, same as `presence` — not part of
SPEC.md, nothing this backend needs to serve dynamically, just a static
JSON field you add to the manifest file you already publish. A domain
that leaves the field out is simply never offered as a Post Office
option in the wallet UI; nothing else changes.

Membership is symmetric (task #95): holding the card is what makes this
domain that visitor's sending relay AND their inbox here, not just one or
the other. Any wallet POSTs directly to /atlas/postoffice/send with a
self-signed envelope proving who they are and a recipient public key; this
endpoint checks that signature, checks the SENDER holds a membership here,
then checks the RECIPIENT holds one too — and only if all three hold does
it relay the message the same way /atlas/mail/send does (signed with your
issuer key, addressed by the recipient's own membership credential id so
their wallet's ordinary mail-check loop picks it up automatically). A
sender with no membership here is rejected before anything is stored; a
message for a recipient with no membership here is rejected too — neither
case is silently dropped, the sender's wallet gets a clear error back
either way. Two visitors can only mail each other through a Post Office
they've BOTH joined, the same way two people need accounts on the same
mail relay to send through it.

The membership roster lives in lib/atlas-postoffice-members-store.json,
same "next to the private key, not under .well-known" reasoning as every
other store in this bundle, and same welcome-mail-on-join courtesy as
atlas.membership above (edit atlas/asset/issue.php's second
`$welcomePayload` if you want different wording). There's still no public
"who's reachable here" endpoint, same reasoning as the subscriber roster —
an address is meant to be shared out of band, like an email address, not
crawled.

Abuse detection (task #96)
----------------------------
Symmetric membership (#95) means every send is tied to a specific
credential — which is what makes flagging possible at all, there's
someone accountable to flag. Every successful send through
atlas/postoffice/send.php is logged against the SENDER's own membership
entry. More than ATLAS_POSTOFFICE_SPAM_THRESHOLD sends (constant in
lib/store.php, default 5) within ATLAS_POSTOFFICE_SPAM_WINDOW_MS (default
60000ms, a minute) auto-sets `flagged: true` on that member's roster
entry — recomputed live on every send, so a burst that's since gone quiet
un-flags itself with no manual "clear" step. Flagging never blocks a send
by itself, it only marks the entry.

Same reasoning as the roster itself having no public listing endpoint:
seeing who's flagged means opening lib/atlas-postoffice-members-store.json
directly (via cPanel File Manager or SSH, same as every other manual admin
task in this bundle) and reading `flagged`/`recentSendCount` straight off
each entry — not a new HTTP surface that would leak every member's public
key and activity to anyone who asks. Both constants are plain values you
edit directly if the demo defaults don't suit you — this bundle doesn't
rely on env vars anywhere (see atlas_domain()'s $forced pattern), since
typical shared hosting doesn't make those easy to set.

Once you've decided a flagged member deserves it, cutting them off needs
nothing new: call the existing revoke.php with that member's
credentialId, and thanks to #95's symmetric check, one call blocks them
from both sending AND receiving through this domain at once.


Updating an already-issued asset
----------------------------------
An asset credential is signed and immutable the moment it's issued — but a
domain can still publish an UPDATED version of one a visitor already
holds (SPEC.md §5.1.1), by reissuing it: signing a brand-new credential
with the changed properties and revoking the old one as superseded. This
is what lets a museum exhibit's info card change after a visitor already
picked it up, without needing to mutate anything. Reissue only applies to
a non-fungible asset (`asset.fungible: false`) — a fungible class's
properties have to stay identical across every balance of it for
consolidation (SPEC.md §5.4.1) to stay sound, so a fungible credential's
properties only ever change at the class level (edit ATLAS_ASSET_CATALOG
in lib/store.php), never by reissuing one specific balance; the endpoint
rejects a fungible credential with a clear error.

To do this, POST to /atlas/asset/reissue with the exact credential JSON
being replaced (the one the visitor is currently holding — get it from
them, or from wherever you keep a record of what you've issued) and a
`properties` object naming just the fields that changed:

  curl -X POST https://your-domain/atlas/asset/reissue \
    -H 'Content-Type: application/json' \
    -d '{"credential": {...the current credential...}, "properties": {"com.example.condition": "restored"}}'

The response is `{"newCredential": {...}}` — a fresh signed credential
with `supersedes` pointing at the old id. There's nothing further to do on
this end: the old id is revoked (`reason: "superseded"`) as part of the
same call, and the next time that visitor's wallet checks in — either the
existing periodic mail check, or immediately if they walk back into a
world on this domain — it picks up the update, re-verifies the new
credential itself, and swaps it in automatically. No admin UI for this
either, same reasoning and same shape as /atlas/mail/send above.

Asset-update records are stored in lib/atlas-asset-updates-store.json,
same "next to the private key, not under .well-known" reasoning as the
mail store.


One real architectural difference from the Node version, worth knowing
--------------------------------------------------------------------------
The Node server loads its private key once when it starts and keeps it in
memory for as long as the process runs. PHP on shared hosting has no
long-running process like that — every request is its own fresh PHP
execution, so every single request re-reads and re-parses the private key
file from disk. This is not a performance concern at the scale a personal
site or small demo would ever see (parsing a small EC key costs
microseconds), so it's not something worth trying to work around — just
flagging it so the difference is understood rather than mysterious if you
ever go looking at how this compares to the Node version.
