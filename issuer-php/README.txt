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
/atlas/asset/consolidate, /atlas/trade/submit,
/atlas/trade/listings, /atlas/trade/claim, /atlas/trade/cancel,
/atlas/revoke, /atlas/mail/check) either way — this bundle's .htaccess
makes PHP answer those exact clean URLs. (/atlas/mail/send and
/atlas/asset/reissue are the two exceptions — they're demo/admin actions,
meant to be called by you the domain operator, not the wallet — see
"Sending mail to subscribers" and "Updating an already-issued asset" below.)

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
    trade/submit.php         - POST /atlas/trade/submit      (post an open listing — see "Trading Station" below)
    trade/listings.php       - GET  /atlas/trade/listings    (browse open listings — see "Trading Station" below)
    trade/claim.php          - POST /atlas/trade/claim       (fulfill a specific listing by id — see "Trading Station" below)
    trade/cancel.php         - POST /atlas/trade/cancel      (withdraw your own open listing — see "Trading Station" below)
    revoke.php              - POST /atlas/revoke            (revoke by id)
    mail/send.php            - POST /atlas/mail/send         (send mail about a held credential — demo/admin use)
    mail/check.php           - POST /atlas/mail/check        (wallet's periodic mail check)
    postoffice/send.php      - POST /atlas/postoffice/send   (user-to-user mail — see "Post Office" below)
    postoffice/mailmode.php  - POST /atlas/postoffice/mailmode  (self-service: open vs. friends-only — see "Post Office" below)
    postoffice/block.php     - POST /atlas/postoffice/block     (self-service: block a sender)
    postoffice/unblock.php   - POST /atlas/postoffice/unblock   (self-service: undo a block)
    postoffice/mysettings.php - POST /atlas/postoffice/mysettings (self-service: read your own mail mode/block list back)
    postoffice/handle.php    - POST /atlas/postoffice/handle      (self-service: claim/change/clear your handle — see "Handle addressing" below)
    postoffice/resolve.php   - POST /atlas/postoffice/resolve     (public: handle -> public key, single lookup, no auth needed)
    admin/session/nonce.php  - GET  /atlas/admin/session/nonce   (issue a single-use login nonce — see "Admin session primitive" below)
    admin/session/start.php  - POST /atlas/admin/session/start   (sign the nonce as a roster admin, get a session token back)
    admin/session/whoami.php - POST /atlas/admin/session/whoami  (check/refresh a session token, no signature needed)
    admin/session/logout.php - POST /atlas/admin/session/logout  (end a session token early)
    admin/is-admin.php       - GET  /atlas/admin/is-admin  (public, boolean-only: is this key on the roster? — see "Admin panel" below)
    admin/directory.php      - POST /atlas/admin/directory (admin-gated: subscriber + Post Office rosters, for the admin panel's own dropdowns — see "Admin panel" below)
    admin/class-patch.php    - POST /atlas/admin/class-patch   (admin-gated: set/clear a properties+tradeScope patch for a whole non-fungible class — see "Class-wide patches" below)
    admin/class-patches.php  - POST /atlas/admin/class-patches  (admin-gated: list every class patch currently active — see "Class-wide patches" below)
    admin/asset-classes.php  - POST /atlas/admin/asset-classes  (admin-gated: every non-fungible class, bound or not, for the class-patch form's dropdown — see "Class-wide patches" below)
    .htaccess                - makes the URLs above work without a .php
                                extension, matching what the extension calls
  lib/
    bootstrap.php, crypto.php, store.php  - shared code, not web routes
    .htaccess                - blocks direct web access to this folder
                                (this is where the private key file lives
                                once it's generated)
  atlas-admin/
    index.html               - GET /atlas-admin/  (the one-page admin
                                console — see "Admin panel" below; a plain
                                static file, no .htaccess needed)


How to install on your domain (cPanel File Manager)
-----------------------------------------------------
1. Open File Manager, go to your site's document root (public_html, or
   wherever /.well-known/spatial.json already lives).
2. Upload the "atlas" folder, the "lib" folder, and the "atlas-admin"
   folder so they all sit right next to your existing .well-known folder —
   same directory level.
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

To actually send mail to a subscriber, POST to /atlas/mail/send — but note
this endpoint now requires a signed admin proof envelope (require_admin(),
lib/store.php), not a bare body: SPEC.md §11.1 already calls sending
"authenticated as the domain operator, not as any visitor," and a plain
unauthenticated endpoint meant anyone could get your domain to sign and
deliver an arbitrary message (or mint a gift asset, see below) to any
credential id they chose. The wire shape is {payload: {credentialId,
subject, body}, proof}. Since a real ECDSA signature isn't something you
can hand-type into curl, use the small Node tool this project ships for
exactly this — no server-side dependency, it just signs the request the
same way a wallet would:

  node tools/admin-mail-send.js "urn:atlas:asset:..." "New exhibit this week" "..." --print-only

--print-only signs the request and prints two things: the admin public key
to add to lib/atlas-admin-keys-store.json (same "plain operator-edited
JSON file, edit it directly" convention as this bundle's subscriber
roster — see below), and the exact JSON body to curl with once that key
is registered. (Without --print-only, the tool assumes it's talking to
this project's own local Node demo servers and does both steps for you —
not useful for a real remote deployment, which is why --print-only exists.)

The message is signed with your issuer key the same way every credential
is, so the wallet only ever shows something that actually came from you.

A message can also carry a gift: add giftAssetClass (any class in
ATLAS_ASSET_CATALOG), giftOwnerPublicKey (who it's for — not necessarily
the same visitor holding credentialId), and giftQuantity for a fungible
class, inside that same payload object. mail/send.php mints that
credential fresh and attaches it to the message as `attachedAsset` before
signing, so the gift is covered by the same signature as the message
itself — admin-signed the same way as a plain message, nothing extra
needed for the gift case.

The wallet never adds a gift to the recipient's holdings automatically on
arrival the way it does an asset-reissue replacement — the mail card shows
a Claim button, and only clicking it verifies the attached credential and
adds it (SPEC.md §11.2). This is deliberate: unlike a routine mail check,
a gift is new property arriving from someone, which the spec treats as
something a visitor's own client must make an explicit decision about,
never a silent background step.

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
SSH and loop the credential ids into tools/admin-mail-send.js --print-only
calls yourself (see "Sending mail to subscribers" above). There's still no
UI for a one-click broadcast, but the endpoint itself is no longer
unauthenticated — it now requires a signed admin proof envelope
(require_admin(), lib/store.php), the same as /atlas/revoke.


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

Consent/block model (task #94's remaining piece — "both, recipient's
choice")
------------------------------------------------------------------------
Membership (#95) is the baseline gate — both people have to have joined
this Post Office — but a member can narrow who reaches them further, on
top of that, from the wallet's Social -> Mail -> "Who can mail you"
panel:
  - Block list. Name a specific public key and this domain stops relaying
    mail from it to that member, full stop — a block always wins over
    everything below. Also reachable straight from a relayed message
    itself: every mail card from a real sender carries an inline "Block
    sender" button next to Delete.
  - Friends only. A member can switch their membership to friends-only,
    and postoffice/send.php will only relay mail from public keys in a
    snapshot they submitted — pulled from their own wallet's local
    Friends list, which otherwise never leaves the wallet at all; turning
    this on is an explicit, one-time disclosure of that snapshot to this
    one domain. It's a snapshot, not a live sync — someone added to
    Friends later isn't covered until the panel is saved again.

Both settings live on the same roster entry as everything else above
(mailMode, blockedSenders, friends — added lazily, so an entry from
before this task simply has none of them and behaves as "open" with an
empty block list) and are self-service: postoffice/mailmode.php,
postoffice/block.php, and postoffice/unblock.php all authenticate the
caller the same self-signed-envelope way postoffice/send.php already
authenticates a sender (verify_envelope(), $proof['publicKey'] IS the
caller), via update_postoffice_member() in lib/store.php — so nobody can
touch a membership that isn't their own. postoffice/mysettings.php is the
one Post Office roster lookup that IS safe to expose over HTTP despite the
"no public listing" reasoning above: it's gated by that same envelope, so
it only ever hands a caller back their own entry — exactly what the
wallet's settings panel reads on open (and after every save) rather than
trusting local state. Rejections from either rule read identically
("recipient is not accepting mail from you right now") so a sender can't
tell a block from simply not being on a friends-only list.

Handle addressing (task #94's last remaining piece — "hide the raw public
key from users")
------------------------------------------------------------------------
A member can register a short handle at ONE Post Office instead of
handing out their raw public key. Deliberately "handle#domain", NOT
"handle@domain" -- the @ shape reads as a real email address and would
mislead people about what this actually is (no inbox provider, no
password recovery, nothing like SMTP underneath); the # separator reads
more like a Discord-style tag, which is closer to what it actually is.
Unique per DOMAIN, not globally -- same "one card, one Post Office" scope
every other membership setting already has -- matched case-insensitively
("Bob" and "bob" can't both be registered at the same domain, and a
lookup tolerates whatever casing is typed), though the originally-
submitted casing is what's stored and shown back.

Two new endpoints:
  - postoffice/handle.php: claim, change, or clear your OWN handle.
    Self-signed the same way mailmode.php/block.php/unblock.php
    authenticate their caller, via update_postoffice_member() -- so a
    caller can only ever touch their own membership. Format (2-24 chars,
    letters/numbers/underscore/hyphen) and the profanity blocklist are
    both enforced here regardless of what a client's own same-shaped
    check already caught, since a modified client could skip that one.
    Re-submitting your own current handle succeeds as a no-op, not a
    "taken" conflict -- the uniqueness check excludes your own live entry.
  - postoffice/resolve.php: the single-lookup step Compose uses to turn a
    handle into the public key send.php actually needs. No sender
    authentication -- resolving a handle you already know doesn't require
    proving who's asking, any more than already knowing someone's raw
    public key would; the actual send is still gated by every check
    above. Same "one exact answer, never a dump" shape as
    find_postoffice_membership().

The nice part: showing a RECIPIENT's handle instead of their raw key on an
incoming message needs no reverse-lookup endpoint at all. send.php already
stamps `from: {publicKey}` onto outgoing mail (see #95 above) -- it now
also adds the sender's own registered handle, if they have one, to that
same stamp, since it's sitting right there in $senderMembership already.
A sender with no handle produces a `from` with no handle key at all (not
a null one) -- extension/viewer.js's mail card falls back to the old
raw-key fragment exactly as before this task.

With this, task #94 is now fully built -- handle addressing was its last
open piece.


Trading Station — open listings (task #144 Phase 1, v1.14/v1.15, SPEC.md §7)
------------------------------------------------------------------
A visitor posts a listing naming no counterparty at all (submit), anyone
can browse what's currently open at this station (listings), and any other
member can fulfill a specific one by id (claim) — no two visitors ever need
to be present, or even aware of each other, at the same moment. v1.15
removed this station's earlier /atlas/asset/trade endpoint, which required
both sides' signed intents to arrive in the same call (only workable when
both visitors stood at the same in-world stall together); open listings are
now the only trading mechanism this station supports.

Joining is the same one-click shape as Post Office above: request an
atlas.tradingstation.membership credential (POST /atlas/asset/issue with
that assetClass — the extension's own "Join Trading Station" button and
its in-world Trading Post desk both already do this) and hold onto it.
Every submit/claim call must present a currently-valid one, checked fresh
against the request the same way a trade balance itself is — not a
server-side allow-list lookup. Browsing listings needs no membership at
all; reading one reveals nothing its poster didn't already choose to make
public by posting it.

  curl -X POST https://your-domain/atlas/trade/submit \
    -H 'Content-Type: application/json' \
    -d '{"membership": {...your Trading Station membership credential...}, "intent": {"payload": {"offer": {"class":"atlas.element.iron","quantity":10}, "want": {"class":"atlas.element.gold","quantity":5}, "expiresAt": "..."}, "proof": {...your signature over payload...}}, "balance": {...the balance credential covering your offer...}}'

Response: {"status":"pending","pendingId":"...","expiresAt":"..."} — always;
posting only ever queues a listing, it never auto-settles. (Earlier than
v1.14, submit tried to match a fresh submission against whatever was
already pending — dropped, because a listing meant to be browsed shouldn't
silently vanish out from under a browsing buyer due to an unrelated
submission elsewhere.)

  curl https://your-domain/atlas/trade/listings

Response: {"listings":[{"pendingId":"...","posterPublicKey":"...","offer":{...},"want":{...},"expiresAt":"..."}, ...]} —
every currently open, unexpired listing at this station.

  curl -X POST https://your-domain/atlas/trade/claim \
    -H 'Content-Type: application/json' \
    -d '{"pendingId": "urn:atlas:trade:...", "membership": {...your membership...}, "intent": {"payload": {"offer": {"class":"atlas.element.gold","quantity":5}, "want": {"class":"atlas.element.iron","quantity":10}, "expiresAt": "..."}, "proof": {...}}, "balance": {...the balance covering your offer...}}'

Your intent's offer/want must exactly mirror the target listing's want/offer.
Response: {"status":"settled","remainder":{...}|null,"received":{...}} — your
own remainder/received credentials come back directly, since you were live
for this call.

  curl -X POST https://your-domain/atlas/trade/cancel \
    -H 'Content-Type: application/json' \
    -d '{"pendingId": "urn:atlas:trade:...", "intent": {"payload": {"pendingId": "urn:atlas:trade:...", "action": "cancel"}, "proof": {...signed by the same key that posted it...}}}'

Withdraws your own still-open listing. Response: {"status":"canceled"}.
Rejected if the listing's already been claimed, expired, or belongs to a
different key.

Delivery to the poster when THEY aren't live for the claim needs no new
mechanism at all: a remainder credential supersedes the old balance id, so
it arrives automatically the next time that wallet's own /atlas/mail/check
asks about that id (same channel /atlas/asset/reissue already uses below);
a newly-received credential of a class that wallet may never have held
before rides along as a claimable gift attached to a system mail message,
reusing the exact same Claim mechanism "A message can also carry a gift"
above already describes. Both arrive in the one /atlas/mail/check response.

Trading Station roster is stored in lib/atlas-tradingstation-members-store.json
(same "not web-reachable" reasoning as every other roster in this bundle);
open listings live in lib/atlas-pending-trades-store.json and are pruned
lazily (an expired one simply stops appearing in listings, on the next read).


Bound credentials — what can never be traded (task #160, SPEC.md §5)
------------------------------------------------------------------
Every asset carries a third signed flag alongside fungible/presentation:
`tradeScope`. Most classes are `"local"` (the implicit default — a trade
only ever finalizes at the asset's own issuing domain regardless of any
flag, since only that domain holds the signing key to re-mint it). The
three membership classes — atlas.membership, atlas.postoffice.membership,
atlas.tradingstation.membership — are `"bound"` instead: a relationship
credential, not a tradeable good, rejected outright by
check_presented_asset() (in lib/bootstrap.php) with a dedicated "asset is
bound to its owner..." error before it ever reaches the ordinary fungible
check — every split/consolidate/trade/trade-submit endpoint shares that
one function, so this is enforced in exactly one place for all of them.
A reserved `"global"` value exists for a later federated-venue scenario;
nothing in this bundle checks for it yet.


Direct credential transfers
-------------------------------
Loadouts' transfer-on-loss (extension/wallet.js, purely local — no domain
call involved at all) and a Trading Station settlement above (needs a
mirrored counter-offer and a membership card) both assume a specific
context. Neither fits the plainest case: "I hold this, send it straight to
that public key, nothing wanted back." POST /atlas/asset/transfer (SPEC.md
§5.6) covers exactly that: {credential, recipientPublicKey, intent: {payload:
{credentialId, recipientPublicKey, action: 'transfer'}, proof}},
authorized by nothing more than the holder's own signature over exactly
what it authorizes — the same envelope shape /atlas/trade/submit and
/atlas/world/drop already use for theirs. Non-fungible only for now; a
bound credential is rejected with a plain-English reason
(check_presented_giftable_asset() in lib/bootstrap.php), same tradeScope
discipline every other transfer path here already enforces. The actual
instance (serial, any per-instance properties) survives the move — it
reuses the same transfer_unique_asset() primitive World Drops and Trading
Station settlement already share, not a fresh catalog-derived stand-in.
test/manual-asset-transfer.js covers the successful transfer, replay
rejection, the bound rejection, a non-owner's signature being rejected,
self-transfers being rejected, and a mismatched intent being rejected
without spending anything — on both issuers.

This is also what powers demo-domain-a/business-demo.html on the Node
side — a standalone, extension-free page that issues a visitor a giftable
demo coupon (atlas.demo.coupon) alongside a non-transferable badge, lets
them try sending each to a page-local stand-in for "a friend", redeem
either one themselves (see below), and verify any credential's raw JSON
independently against this domain's own public key and revocation files.
That page lives under demo-domain-a/, not this bundle, since it needs
somewhere to be served as a static file, but every endpoint it calls
behaves identically here.


Self-service redemption
-------------------------------
Giving something away (above) and giving something up are different acts.
POST /atlas/asset/redeem (SPEC.md §5.7) is the second one: {credential, intent:
{payload: {credentialId, action: 'redeem'}, proof}} — no recipient field
at all, authorized purely by the holder's own signature. It's the same
envelope discipline as a transfer, checked by
check_presented_redeemable_asset() in lib/bootstrap.php, deliberately
looser in one respect: a bound credential (a membership card, a badge)
can never be transferred to someone else, but its own holder relinquishing
it entirely raises no question of who receives it, so tradeScope is never
checked here — only fungible is excluded, same "non-fungible only for
now" scope the transfer endpoint above already carries. A successful
redeem calls the same atlas_revoke() every other revocation path in this
bundle already uses, reason "issuer-request" — from the protocol's own
point of view, this is still the issuer revoking, just through an
authorization path that trusts the holder's signature instead of the
admin roster. test/manual-asset-redeem.js covers the successful redeem,
replay rejection, a bound credential redeeming successfully where a
transfer of the same credential would not, a non-owner's signature being
rejected, a fungible balance being rejected, and a mismatched intent being
rejected — on both issuers.


Buying something with a balance, and fulfillment
-------------------------------------------------
None of the mechanisms above cover acquiring something NEW by spending
part of a balance a visitor already holds. POST /atlas/asset/purchase
(SPEC.md §5.8) covers it: a class becomes purchasable the moment its own
catalog entry declares a price (purchase => ['priceClass', 'priceAmount']),
and the endpoint debits a presented balance of that class by
priceAmount x quantity while minting the purchased class fresh, atomically
— check_presented_spendable_asset() in lib/bootstrap.php validates the
presented balance the same way check_presented_asset() does for a split,
except a bound balance is NOT rejected (spending your own balance raises
no recipient question, the same reasoning check_presented_redeemable_
asset() already applies to redemption). The purchased asset is minted
FIRST, before the balance is touched at all, so a sold-out or otherwise-
failing purchasedClass never debits anything. Authorized by the balance
owner's own signature, the same intent envelope transfer/redeem above
already use.

POST /atlas/asset/fulfill (SPEC.md §5.9) is the closing act for anything
meant to be handed over once and only once: admin-gated
(require_admin_auth(), the same gate revoke.php/reissue.php already use),
it confirms a presented credential is genuine and unspent
(check_presented_fulfillable_asset()), then revokes it with a new reason
code, "fulfilled" — the mirror image of redeem's holder-authorized
revocation, this time attested by the operator instead of the holder.

demo-domain-a/cafeteria-demo.html is one worked example built on top of
this, not a special case the protocol knows about: a parent tops up a
student's atlas.credit.balance (fungible, bound, minted via the same
ungated /atlas/asset/issue every other class here already uses), the
student spends it on a small menu (atlas.demo.cafeteria.sandwich/.juice/
.snack, each just another catalog entry with its own price), and each
purchase's receipt is later fulfilled on the Admin Panel's new "Fulfill a
purchase" section — the same admin-panel/index.html this bundle already
serves identically to the Node one. test/manual-asset-purchase.js covers
the endpoint itself (atomic debit-and-mint, insufficient balance, wrong
currency, a non-purchasable class, non-fungible quantity, a mismatched
intent, and the fulfill/replay-rejection cycle) on both issuers;
test/manual-cafeteria-demo.js drives both pages end to end.


Credentials that expire on their own, and a museum ticket stall
-------------------------------------------------------------------
Everything above needs an explicit act to stop being valid. Some things are
only ever meant to be valid for a while regardless of anyone acting on them
at all — a day pass, an event ticket. asset.expiresAt (SPEC.md §5.10) is a
second, optional signed field alongside fungible/presentation/tradeScope: a
class opts in by declaring 'expiresInMinutes' in its own catalog entry, and
every credential minted of it (issuance, or a fresh mint following a split,
trade, purchase, or reissue) gets a real deadline computed from that mint's
own clock and signed into 'asset' along with everything else — see
mint_asset_by_class()'s own 'expiresInMinutes' handling in lib/bootstrap.php.
is_expired() (lib/store.php) sits right next to is_revoked() and is wired
into the exact same places: check_presented_asset(), check_presented_
unique_asset(), check_presented_membership(), check_presented_transferable_
asset() (both the local and foreign-credential branches), check_presented_
giftable_asset(), check_presented_redeemable_asset(), check_presented_
spendable_asset(), and check_presented_fulfillable_asset() all reject an
expired credential the same way they already reject a revoked one, with
their own clear reason. There's no list to check — the deadline already
travels inside the credential — so this costs nothing but a clock
comparison. A class that never declares expiresInMinutes is completely
unaffected.

The Museum world (previously an empty room in demo-domain-a/spatial/museum/
scene.json) is the worked, spatial-world example: a "Get Museum Credits"
stall mints the same atlas.credit.balance the cafeteria demo above already
uses, and a "Buy a Day Ticket" stall spends 10 of it on
atlas.demo.museum.ticket, a non-fungible, bound receipt-style class that
also declares expiresInMinutes => 3 (a realistic day pass sped up to a few
minutes, so a visitor can watch one go stale in one sitting). Presenting the
resulting ticket to the Admin Panel's "Fulfill a purchase" section consumes
it at the door before its deadline passes; presenting the identical ticket
after the deadline passes is rejected — expired, not revoked — by the exact
same check_presented_fulfillable_asset() gate every other fulfillment
already goes through. test/manual-asset-expiry.js covers the expiry
mechanism itself at the HTTP layer on both issuers; test/manual-museum-
ticket-stall.js drives the wallet extension into the Museum end to end.


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

To do this, POST to /atlas/asset/reissue — but note this endpoint now
requires a signed admin proof envelope (require_admin(), lib/store.php),
not a bare body, same as /atlas/mail/send above: left open, anyone who
could observe a credential (many are publicly visible via trade listings
or gifts) could silently rewrite its properties or loosen/tighten its
tradeScope without the owner's consent, under your domain's own real
signature. The wire shape is {payload: {credential, properties, tradeScope},
proof} — `credential` is the exact credential JSON being replaced (the one
the visitor is currently holding — get it from them, or from wherever you
keep a record of what you've issued), and at least one of `properties` (an
object naming just the fields that changed) or `tradeScope` (`"local"` or
`"bound"`) is required. Since a real ECDSA signature isn't something you
can hand-type into curl, use the small Node tool this project ships for
exactly this, the same way as admin-mail-send.js above:

  node tools/admin-reissue.js holders-credential.json --properties '{"com.example.condition": "restored"}' --print-only

--print-only signs the request and prints two things: the admin public key
to add to lib/atlas-admin-keys-store.json (same "plain operator-edited
JSON file, edit it directly" convention as this bundle's subscriber
roster), and the exact JSON body to curl with once that key is registered.
(Without --print-only, the tool assumes it's talking to this project's own
local Node demo servers and does both steps for you — not useful for a
real remote deployment, which is why --print-only exists.)

The response is `{"newCredential": {...}}` — a fresh signed credential
with `supersedes` pointing at the old id. There's nothing further to do on
this end: the old id is revoked (`reason: "superseded"`) as part of the
same call, and the next time that visitor's wallet checks in — either the
existing periodic mail check, or immediately if they walk back into a
world on this domain — it picks up the update, re-verifies the new
credential itself, and swaps it in automatically. No admin UI for this
either, same reasoning as /atlas/mail/send above.

Asset-update records are stored in lib/atlas-asset-updates-store.json,
same "next to the private key, not under .well-known" reasoning as the
mail store.

`properties` is a merge onto whatever the credential already has, not a
replacement — a key you don't mention is left alone. Setting a key to
`null` is the one exception: that removes it from the credential entirely
(the standard JSON Merge Patch convention), the only way to actually take
a fact away rather than only ever add or overwrite one.


Class-wide patches
----------------------
Reissue above fixes one already-issued credential at a time — you need the
exact JSON the holder currently has. That doesn't scale to "everyone who
picked up atlas.trophy.chess before I fixed the wording on it" without
either reissuing each holder by hand or keeping a registry of who holds
what — and this bundle deliberately keeps no such registry: it never
records who owns which asset, it only ever re-verifies whatever a wallet
chooses to present.

POST /atlas/admin/class-patch (admin-gated, same {payload, proof} or
{payload, token} shape as every other admin action here) sets a
`properties` patch and/or a `tradeScope` override for an entire
non-fungible asset CLASS, not a specific credential. The wire shape is
{payload: {assetClass, properties, tradeScope}, proof} (or `clear: true`
in place of properties/tradeScope to remove a class's patch entirely); at
least one of properties or tradeScope is required otherwise. Same
non-fungible-only restriction as reissue above — a fungible class's
properties/tradeScope are already uniform across every balance
(mint_asset_by_class() rebuilds them fresh from ATLAS_ASSET_CATALOG on
every mint/split/consolidate/trade), so the endpoint rejects a fungible
assetClass with a clear error. POST /atlas/admin/class-patches (same
auth) lists every class patch currently active.

POST /atlas/admin/asset-classes (same auth) is what feeds the admin
panel's own class-name dropdown: every non-fungible class in
ATLAS_ASSET_CATALOG, bound or not. It's deliberately NOT
atlas/trade/catalog.php — that endpoint exists to advertise what can be
traded, so it excludes a tradeScope: 'bound' class on purpose (a
membership card or a badge can never be the thing traded), but a bound
class is just as valid a class-patch target as a tradeable one. Each
entry also carries the class's own base `properties` and a `randomized`
flag (true when ATLAS_ASSET_CATALOG sets randomizeProperties for it) — the
admin panel uses both to pre-fill the form instead of leaving the operator
to type a patch blind: picking a class fills in its base properties/
tradeScope merged with whatever's in an already-active patch for it (the
patch wins, since that's the fact actually in force), and a randomized
class gets a note that what's shown is only the shared fallback template,
never any specific holder's actual roll.

`properties` here goes through the same merge as /atlas/asset/reissue's
own argument, including the same `null`-deletes-a-key convention — with
one extra wrinkle specific to a class patch: setting a class patch is
itself a patch onto whatever patch is already stored for that class (so
a later call adding one fact doesn't erase an earlier one), and a `null`
has to survive THAT merge as a literal stored marker rather than being
erased the moment it's set, or the deletion would never actually reach
anyone's credential. `merge_properties()` only ever runs where a patch is
actually applied to a real credential (`apply_class_patch_if_stale()`,
and /atlas/asset/reissue itself); `set_class_patch()`'s own merge onto
the stored patch stays a plain `array_merge()` that keeps `null` verbatim.
test/manual-properties-patch-delete.js covers exactly this — deleting a
property via reissue, via a class patch, idempotency of a deletion
(checking in again doesn't reissue forever), and stacking a second
class-patch call that adds a new fact without losing an earlier deletion
— on both issuers.

Nothing already-issued is touched at the moment the patch is set. Instead,
the next time a holder's own wallet checks in with this domain — the same
/atlas/mail/check round trip that already delivers mail, single-credential
reissues, and revocations — it presents whatever credential it currently
holds for that class, this bundle notices the credential is stale against
the active patch, and auto-reissues it on the spot exactly the way a
manual /atlas/asset/reissue call would: revoking the old id and minting a
signed replacement with the patch applied, which the wallet then adopts
through its ordinary "supersede" path. This is why /atlas/mail/check's
request body grew an optional `credentials` field alongside the existing
`credentialIds` array: it's the wallet briefly re-presenting its own
evidence for the ids it's asking about, not a new registry — this bundle
still stores nothing about who holds what between requests, and never
mints anything for a presented credential that doesn't cryptographically
verify against this domain's own key first. A caller that only sends
credentialIds (any older client) gets exactly the old behavior; class
patches simply never apply to it.

Class patch records are stored in lib/atlas-class-patches-store.json,
same "next to the private key" reasoning as the other admin state files —
and bounded by the number of classes you've ever patched, not by visitor
or item count, unlike a per-holder registry would be.

No dedicated admin UI form beyond the panel below exists for this outside
the panel itself; see "Admin panel" below for where it lives.


Admin session primitive
--------------------------
Every admin action above needed a fresh signature from a roster key — fine
for a one-off CLI call, impractical for anything resembling a real admin
page (you'd need the private key reachable for every click, including a
live-updating view that polls). GET /atlas/admin/session/nonce, POST
/atlas/admin/session/start, POST /atlas/admin/session/whoami, and POST
/atlas/admin/session/logout add a short-lived bearer-token session on top
of the roster, without changing what the roster means.

/session/start still requires a full signed proof envelope — over a
single-use nonce from /session/nonce, so the login itself can't be
replayed — checked against the exact same roster require_admin() already
enforces everywhere else in this bundle. Only once that succeeds does it
hand back a random token (lib/atlas-admin-sessions-store.json, next to the
other private state files), good for 30 minutes and sliding forward on
every authenticated request that uses it (not just /whoami —
require_admin_auth(), the shared gate every admin-gated endpoint now
calls, treats any check as activity). /logout (or the token simply
expiring) ends it.

This is deliberately narrow: the roster is still the only thing that can
make a key an admin, a session can't do anything a fresh signature
couldn't, and it only ever shortens how often you have to sign, never
widens who's authorized. atlas/revoke.php, atlas/mail/send.php,
atlas/asset/reissue.php, and atlas/calendar.php's POST side all now accept
{payload, token} as an alternative to {payload, proof} — the missing piece
that makes the session actually useful for something, rather than only
ever being able to answer "am I an admin". See "Admin panel" below for the
page that now actually consumes it.


Admin panel
--------------
atlas-admin/index.html — a one-page admin console, byte-identical to
issuer-server/admin-panel/index.html, served at /atlas-admin/ (a plain
static file; nothing PHP-specific about it, since it only ever calls the
same relative /atlas/... URLs both backends already answer the same way).
Forms for all four gated actions above, each POSTing {payload, token} —
no signature needed per click once you're in.

Getting in requires the wallet extension: its top bar grows a Admin
button, shown only when the currently unlocked identity is on THIS
domain's own admin roster (GET /atlas/admin/is-admin?publicKey=... — a
cheap, ungated, boolean-only check so the button can decide whether to
render itself without spending a real login on every page). Clicking it
logs into (or reuses) an admin session and hands the token to this page —
the wallet runs in an extension-origin iframe, cross-origin from this
domain's own pages, so it can't write to this origin's sessionStorage
directly; it postMessages the token to the extension's content script
instead, which IS same-origin with this domain, does the actual write, and
navigates to the exact atlas-admin/index.html filename rather than the
bare atlas-admin/ directory — deliberately, since a real site sitting on
top of this bundle (WordPress and most other CMSes, notably) commonly runs
its own catch-all rewrite that only excludes an actual FILE, not just an
actual directory, so a bare directory request can 404 there before
Apache's own directory-index resolution ever gets a turn. Naming the file
sidesteps that on any host — if a bare /atlas-admin/ link 404s on your
site, that's why; the wallet's own button never hits that path.
is-admin.php mirrors issuer-server/server.js's own /atlas/admin/is-admin
route exactly.

Locking the wallet ends every admin session it's holding, on any domain,
at once — fire-and-forget against the server so locking stays instant,
with the session's own 30-minute expiry as the backstop if a logout never
lands.

The panel also has an "Online now" section — who's actually here right
now, across every world on this domain, not just one. It reads this
domain's own .well-known/spatial.json for the world list, then queries
each world's presence server (GET /presence/status?domain=X&world=Y — the
same read-only endpoint the viewer's own live-visitor overlay already
uses; the base URL comes from the manifest's own "presence" field, falling
back to http://localhost:8004 for local dev) and totals the counts, with
each world's roster shown underneath (name, and a truncated public key or
"anonymous" for guests). No admin action or credential is involved in
reading it — a separate service is being queried, not this backend. It
loads once on login and otherwise only reloads on demand (the "Refresh"
button) — deliberately no polling timer, so it can't fire against a page
the admin has stepped away from.

Send mail's recipient field is a credential id, not an identity. Reported
live: an operator addressed it using their own public key, then a
handle#domain address, expecting either to reach their own wallet — neither
does, because this form addresses a message by the exact credential id
whoever's supposed to receive it already holds, which mail/send.php never
checks is real (same demo-simplification revoke.php already accepts for
its own id). Both attempts got back a plain "Sent." with nothing to
suggest otherwise. The panel now flags a value that doesn't even look like
one of this domain's own ids (doesn't start with urn:atlas:) instead of
reporting a bare success — it still sends (these endpoints don't block on
a shape guess, only warn), but the operator now has a reason to stop and
check the id before trusting the result.

Typeable/pickable dropdowns for the fields above, not blank text boxes.
Rather than expecting the operator to already know a credential id, world
id, or event id by heart, Mail's recipient field and Calendar's Event id
are <input list="...">s wired to a <datalist> — the browser's own native
combobox, filtered to matching options as the operator types, no library
needed. Mail's recipient field is backed by a new admin-gated endpoint,
atlas/admin/directory.php (require_admin_auth(), same as every other admin
action), which hands back this domain's two subscriber rosters —
atlas.membership subscribers and Global Mail (Post Office) members, kept
separate since they're different credential classes — each already
filtered to currently-unrevoked credentials. atlas_subscribers_file()'s
own long-standing comment in lib/store.php had already flagged exactly
this as the reason no PUBLIC listing endpoint exists ("worth real operator
authentication before ever exposing this over HTTP") — the admin session
token is that authentication. Calendar's World id field, by contrast, is a
plain <select> — a short, always-fully-visible list rather than a typed/
filtered one — listing only worlds whose own manifest entry opted into a
calendar (world.calendar === true, read from this domain's own manifest —
no new endpoint needed) plus an always-present "— domain-wide —" option;
picking one repopulates Event id's own <datalist> from that world's real
events (GET /atlas/calendar?world=..., already public, refreshed again
right after adding, updating, or removing one) and clears Event id AND
Title/Start/End/Notes — a value left over from the PREVIOUS world could
otherwise be submitted against the new one without the operator noticing.
New protocol-level tests (test/manual-admin-directory-php.js) cover the
endpoint itself.

Calendar's Event id follows Action, fills the form back in, and selects
itself on focus. Event id only means anything for update/remove — add
always creates a fresh event, so there's nothing to pick — so it's now
disabled whenever Action is add, and switching back to add also clears
whatever id was left in it (a stale id sitting behind a disabled field is
exactly the kind of thing that gets submitted by surprise if the operator
flips Action back and forth). Once Event id is enabled, picking a real one
there — from its own <datalist> or by typing its exact id — loads that
event's current Title, Start, End, and Notes into the form, so update
starts from the event's actual state instead of the operator having to
already remember or re-look-up what's there. Focusing the field also
selects its whole contents, the same one-keystroke-to-replace convenience
a browser's own address bar gives a full URL.


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
