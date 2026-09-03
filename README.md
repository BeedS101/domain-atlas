# Domain Atlas — prototype (v1.2)

A working proof that the mechanisms in `SPEC.md` are real. A browser
extension reads a domain's manifest, renders whichever worlds it declares,
and lets you walk through two genuinely different kinds of portal — one
that swaps worlds inside a single domain with no network round-trip, and
one that crosses to a completely separate domain. On top of that, a real
wallet: a genuine WebAuthn passkey identity, real ECDSA-signed credentials
issued by an actual small server, verified with real cryptography — items,
fungible resources, PvP loadouts with an owner-signed transfer-on-loss, and
a two-party trade settled atomically by a trading station.

```
domain-atlas/
├── SPEC.md                      the protocol spec
├── extension/                    the Chrome extension (unpacked)
│   ├── content.js                 detects the manifest, injects the entry button
│   ├── viewer.html / viewer.js    renders worlds, hosts the wallet panel
│   └── wallet.js                  identity + credential verification (§5, §6)
├── issuer-server/                a real credential issuer for demo-domain-a
│                                    (also plays the "trading station" role — see §4 below)
├── directory-server/              crawler/index/search over other domains' manifests (§3.3)
├── presence-server/                hand-rolled WebSocket server for multiplayer presence
├── demo-domain-a/                 "Example Plaza" — FOUR worlds: plaza, museum, arena, market
├── demo-domain-b/                 "Neighbor Workshop" — one world, plain static server
└── test/
    ├── verify.js                  proves the manifest/portal mechanism
    ├── verify-wallet.js           proves the item wallet end to end
    └── verify-loadout-trading.js  proves loadouts/transfer-on-loss and resources/trading
```

Two local servers stand in for two independent domains — same mechanism as
two real domains, just without needing to own and deploy to actual DNS
names to try it. Domain A runs a real issuer (below); Domain B stays a
plain static file server on purpose, to prove it needs zero special
integration with Domain A to trust what Domain A hands out.

## 1. Serve the two demo domains

Domain A needs the real issuer server (Node, zero npm dependencies — there
is nothing to `npm install`):

```bash
node issuer-server/server.js
```

The first run generates a real ECDSA P-256 keypair, writes the public half
to `demo-domain-a/.well-known/atlas-key.json`, and keeps the private half
in `issuer-server/issuer-private-key.jwk.json` (git-ignored — never commit
this file). Every run after that reuses the same key.

**Domain B is now a real issuer too**, not a plain static server — task
#75/#87's Post Office needs it to actually mint credentials and sign mail.
It's the exact same `issuer-server/server.js` file, just pointed at a
different docroot/domain/port/state folder via environment variables (see
that file's own comment on `ATLAS_STATE_DIR` for why a second instance
needs its *own* state folder rather than sharing domain A's):

```bash
PORT=8002 ATLAS_DOMAIN=localhost:8002 ATLAS_DOCROOT=demo-domain-b ATLAS_STATE_DIR=issuer-server/domain-b-state node issuer-server/server.js
```

Confirm both are up:

```bash
curl http://localhost:8001/.well-known/spatial.json      # four worlds: plaza, museum, arena, market
curl http://localhost:8001/.well-known/atlas-key.json    # domain A's real public key
curl http://localhost:8002/.well-known/spatial.json      # one world: workshop
curl http://localhost:8002/.well-known/atlas-key.json    # domain B's real public key — a SEPARATE keypair from domain A's
```

## 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.

## 3. Try it — manifest, portals, and the item wallet

1. Visit `http://localhost:8001` — it looks like an ordinary page.
2. A **🧭 Enter Space: Example Plaza (+3 more)** button appears bottom-right.
3. Click it. The Plaza world renders with four portals: three **orange**
   (same-origin, swap worlds, no re-fetch — to the museum, the arena, and
   the trading post) and one **teal** (crosses to another domain, fetches a
   fresh manifest).
4. Click **Create Atlas Identity** — a real `navigator.credentials.create()`
   call, your device's own passkey prompt, a genuine keypair. It's now
   persisted, not thrown away when you close the panel.
5. Open the **🎒 Wallet** panel and click **Request item from this world**.
   The extension POSTs to the issuer server, gets back a real signed
   `domain-atlas-item/1.0` credential, and verifies it itself — fetching
   `atlas-key.json`, checking the signature with the browser's own Web
   Crypto, checking the revocation list — before showing it with a ✓.
6. Click **Present identity** — a fresh WebAuthn assertion, verified
   client-side against the stored public key. Real proof of key
   possession, no server round trip needed to check it.
7. Cross the teal portal to Neighbor Workshop, then click **Re-verify
   wallet against current issuers**. The Bronze Compass still shows ✓ —
   verified from a domain that has never spoken to Example Plaza's issuer,
   using nothing but that issuer's publicly fetched key.
8. Click **Export wallet** for a real `atlas-wallet-export/1.0` JSON file.

To see revocation actually work: `curl -X POST http://localhost:8001/atlas/revoke -H "Content-Type: application/json" -d '{"id":"<the credential id from the export>"}'`,
then click **Re-verify wallet** again — the item flips to ✗, reason
"revoked by issuer."

## 4. Try it — loadouts, transfer-on-loss, resources, and trading

These all live in the same wallet panel, and use one addition worth being
upfront about: a second **counterparty** identity. Demonstrating a
two-party transfer or a two-sided trade needs two independent signers, and
this demo runs in one browser tab. Rather than fake that, the "self"
identity is a real WebAuthn passkey throughout, exactly as in section 3,
and the "counterparty" is a second, purely local ECDSA P-256 keypair — no
WebAuthn, generated and stored the same way a lightweight non-passkey
client would. It signs for real; it just isn't a hardware-backed key. Click
**Create counterparty identity** in the wallet panel to generate it.

**Loadouts and transfer-on-loss (§5.2):**

1. With an item in your self wallet, walk to the **arena** portal
   (orange). The panel shows a PvP warning — this world's manifest
   declares `profile.capabilities.combat: "pvp"`.
2. Click **Load** on an item card to bring it into this world's loadout.
   A loaded item in a PvP world gets a **Simulate PvP loss** button.
3. Click it. This is the interesting part: the *loser's own key* signs the
   transfer. `wallet.js` builds a `domain-atlas-transfer/1.0` payload
   (`itemId`, `from`, `to`, `worldContext`, timestamp), hashes it, and runs
   it through a real WebAuthn assertion — the same `challenge`-hash trick
   used everywhere else, since a passkey can't sign arbitrary application
   data directly, only the fixed assertion structure. The wallet verifies
   its own signature before applying the move (if that check ever failed,
   it would refuse). The item disappears from the self wallet and appears,
   correctly signed, in the counterparty's — a real ownership change, not
   the server unilaterally reassigning it.

**Fungible resources (§5.4):**

4. Walk back to Plaza, then through the **market** portal into the Trading
   Post. Click **Mine 20 iron (self)** and **Mine 10 gold (counterparty)**
   — each mint POSTs to the issuer, gets back a real signed
   `domain-atlas-resource/1.0` balance credential, and verifies it the
   same way items are verified.
5. Click **Send half** on a resource card to split a balance: the issuer
   validates the presented credential, then issues two new balances (a
   remainder back to the sender, the sent amount to the recipient) both
   pointing at the original via `supersedes`, and revokes the original as
   `"superseded"`. Nothing is ever mutated in place — every balance change
   is a fresh signed credential plus a revocation of the old one.

**Trading stations (§7):**

6. With both parties holding a resource each, click **Settle trade**. Both
   sides' intents are built and independently signed (self via WebAuthn,
   counterparty via its local key), sent to the issuer, which is playing
   the trading-station role here — the spec allows a station to be a
   separate party, but collapsing it onto the issuer keeps this demo to
   one server. It checks both intents actually mirror each other (offering
   what the other wants, at matching quantities, naming each other as
   counterparty, not expired), validates both presented balances, then
   atomically issues four new credentials (remainder + received, for each
   side) and revokes the two pre-trade balances. Either both sides settle
   or neither does — no in-between state where one party paid and the
   other didn't.

## 5. Try the directory service

A reference implementation of SPEC.md §3.3 — a crawler/index/search
service, separate from either issuer on purpose (a directory indexes OTHER
domains; it doesn't issue credentials for its own). Zero dependencies,
same as the issuer:

```bash
node directory-server/server.js
```

With both demo domains already running, submit them and search:

```bash
curl -X POST http://localhost:8003/submit -H "Content-Type: application/json" \
  -d '{"manifest":"http://localhost:8001/.well-known/spatial.json"}'
curl -X POST http://localhost:8003/submit -H "Content-Type: application/json" \
  -d '{"manifest":"http://localhost:8002/.well-known/spatial.json"}'

curl "http://localhost:8003/search?scale=district"
curl "http://localhost:8003/search?q=workshop"
```

Or open `http://localhost:8003` for a small search UI. Results are ranked
by inbound `"kind": "domain"` portal count — the same insight PageRank
started from, applied to this much smaller graph — and domain-anchored vs.
key-anchored listings are always labeled, never presented as equivalent
(§3.6.1). A background scheduler re-crawls every submitted manifest on an
interval (60s by default; override with `DIRECTORY_CRAWL_INTERVAL_MS`), so
a world that changes its name, genre, or `discoverable` flag is picked up
on its next scheduled pass, not instantly — the same eventual consistency
a real search index has with the live web.

## 6. Try multiplayer presence

Other visitors in the same world, visible and moving in real time — a
separate service on purpose (same reasoning as the directory server: this
isn't the issuer's job), zero dependencies, hand-rolled WebSocket framing
(RFC 6455) over Node's own `http`/`crypto` rather than pulling in `ws`:

```bash
node presence-server/server.js
```

It listens on `http://localhost:8004`, upgrading `/presence` connections
to WebSocket. Rooms are keyed by `domain::world`, so visitors only ever see
others in the exact same world. Walk into the Lobby (the one
`gltf-mini-v1` world) from two separate browser profiles at once and each
sees the other's character walking around, positions smoothed between the
network updates rather than snapping.

This is presence, not a production multiplayer backend — there's no
server-side movement authority, anti-cheat, or persistence; a client
reports its own position and the server just relays it to the room. It's
also entirely optional at runtime: if `presence-server` isn't running, or
becomes unreachable mid-session, the extension fails the connection
silently and world entry and single-player movement are completely
unaffected — you just won't see anyone else.

**Polling fallback (no WebSocket needed).** WebSocket needs a persistent
process bound to a port, which plain cPanel/Apache+PHP shared hosting
can't run at all — the same constraint that made the issuer need a PHP
port (see `issuer-php/README.txt`). So `presence-server` also answers a
plain HTTP polling API (`POST /presence/poll/join`, `/sync`, `/leave`)
backed by the exact same rooms as the WebSocket side — a WS visitor and a
polling visitor in the same world see each other correctly either way. The
extension tries WebSocket first and only falls back to polling if that
fails or hangs, entirely on its own; nothing to configure beyond a
manifest field (see below). To see the fallback path itself in action
against the Node server rather than trust it's there, run it with
`PRESENCE_DISABLE_WS=1` (rejects every WebSocket upgrade, simulating a
polling-only host) — multiplayer still works, just on a ~2s update cycle
instead of continuous.

Which endpoint the extension talks to is manifest-declared, not hardcoded:
a domain adds an optional top-level `"presence"` field to its
`.well-known/spatial.json` (e.g. `"presence": "https://example.com"`) and
`extension/viewer.js` derives both the WebSocket URL and the polling base
from it. No manifest field at all (every local demo domain in this repo)
falls back to the Node dev default, `localhost:8004`.

That per-domain field is what makes `presence-php/` real rather than
theoretical: a plain-PHP port of ONLY the polling routes (no WebSocket —
see `presence-php/README.txt` for exactly why that half can't be ported to
shared hosting in any language), deployable to a real domain's actual cPanel
hosting the same way `issuer-php/` already is. Point a domain's `presence`
field at a host running just this PHP bundle and the extension's own
WS-then-poll fallback logic does the rest — there's no separate
"polling-only" flag to set anywhere.

## 7. Friends, Favorites, and the Social tab

The wallet's top tab bar is now Wallet / Social / Settings — the old
standalone Mail tab moved inside Social, alongside two new sections:
Friends (#67) and Favorites (#61). Open the Social tab and its own
sub-tab-bar switches between the three.

**Friends work live, through presence — not through mail.** Adding a
friend needs both people simultaneously in the same `domain::world` room:
open the Friends tab while standing in a world with someone else in it,
and "People here now" lists them with an Add friend button (only if
they've got an unlocked wallet identity announced — an anonymous visitor
can't be friended, same "presence never requires an identity" principle
world entry itself has always had). Clicking it sends a `friend-request`
signal over whichever presence transport is actually connected right now
(WebSocket or the polling fallback, transparently) to exactly that one
other visitor. On their side it shows up under "Friend requests" with
Accept/Decline; accepting saves the friend on both ends — the accepter
immediately, and the original sender automatically once the
`friend-request-accepted` reply signal reaches them back, no second click
needed. This only works while both of you are still in the room: a
request or its reply can't be relayed to someone who's already left, same
as the roster itself only ever shows who's actually there.

This deliberately does NOT go through the existing mail system. Mail
(`AtlasWallet.checkAllMail`) is domain-issuer-to-subscriber only —
messages are addressed by `credentialId` and fetched per-domain from
credentials the wallet already holds, and there's no way to even discover
a stranger's `credentialId` to mail them (see `issuer-php/README.txt`'s
note on why there's deliberately no public subscriber-listing endpoint).
Friends needed a genuine peer-to-peer channel between two arbitrary
visitors, so it rides a new, narrow **signal relay** built into presence
itself instead: `presence-server/server.js`'s `relaySignal()` (WS message
type `'signal'` / `POST /presence/poll/signal`) and `presence-php`'s
`poll/signal.php` twin. The vocabulary is closed to exactly three kinds —
`friend-request`, `friend-request-accepted`, `friend-request-declined` —
the server relays them (pushed immediately to a WebSocket member, queued
into `pendingSignals` and picked up on the next poll `sync` for a polling
one) without ever inspecting or storing anything beyond that.

**Favorites bookmark a domain+world**, independent of the auto-pruned
Recent Worlds list on the main Wallet screen (Favorites are explicit
add/remove only, and you control their order). "Favorite this domain"
appears while you're actually standing in a world; the Favorites list
itself shows every bookmark with a live "N here now" status line, pulled
fresh from that domain's own presence backend every time the list renders
(`GET /presence/status?domain=...&world=...` — reports who's in a room
without creating a member the way joining would). If any of your saved
friends are in that count, they're named right there too — "3 here now ·
friends here: Nomad". That cross-referencing happens **entirely on your
own device**: the status endpoint only ever returns who's actually
present (id, name, publicKey), and your friends list is matched against
it locally. No server, including presence-server itself, ever sees your
friends list.

**Quick lock.** A 🔒 button now sits in the top control bar next to
Wallet, for locking without opening the wallet panel first — distinct
from the existing Lock button buried in Settings → Identity method, which
is still there for anyone who navigates in that way. It only shows up
while there's actually an unlocked local-password identity to lock.

**Post Office — user-to-user mail (task #75/#87/#94/#95/#96, SPEC.md §11.3).**
Everything above this point in "Mail" is domain-to-subscriber only: a
domain mails someone who holds one of ITS credentials. Post Office is the
other half — two people mailing each other, addressed by public key,
routed through a domain both of them have joined. Membership is symmetric:
holding a Global Mail Membership Card at a domain is what makes that
domain your sending relay AND your inbox there, not just one or the
other — you don't have to be standing in that world to send through it,
only to have joined it at some point, same as receiving. Try it with two
identities:

1. Join Domain B's Post Office for BOTH identities you want to mail
   between (a second browser profile, or Domain A's own counterparty
   key) — since task #95, sending only works between two people who've
   both joined the same Post Office. Two ways to do it: walk into Domain
   B's Neighbor Workshop and click the blue **Post Office** stall
   ("Claim Global Mail Membership", the same one-click "collect" pattern
   the Workbench and market stalls already use), or — since task #94 —
   just open Social → Mail while standing in Domain B and click **Join**
   under the "Post Office" heading, no stall-finding required. That
   button only appears at a domain whose manifest advertises
   `"postOffice": true` (see demo-domain-b/.well-known/spatial.json) —
   the same plain, optional, implementation-only field pattern `presence`
   already uses, not part of SPEC.md.
2. Open Social → Mail on each identity. "Your address" shows a copyable
   public key — hand identity B's to identity A (or vice versa).
3. Under "Send mail," the dropdown lists every Post Office this wallet has
   actually joined — pick `localhost:8002`, paste the recipient's public
   key, write a subject and message, and hit Send.
4. On the recipient's wallet, click "Check now" (or just wait for the next
   periodic check) — the message shows up in Mail like anything else, but
   headed "From `<their key>` via localhost:8002" instead of a bare domain
   name, so it's visually distinct from mail the domain itself sent you.

Both sides need membership because that's what makes "send through this
Post Office" mean something — it isn't an open relay for anyone with a
wallet, only for people the domain has already vouched for by handing them
a card. A sender with no membership at the target domain gets rejected
before the message goes anywhere; a recipient with no membership there
gets a plain rejection back too, not a silently-dropped message.

**Abuse detection (task #96).** Symmetric membership (#95) means every
send is now tied to a specific credential, which is what makes flagging
possible at all — there's someone accountable to flag. Every successful
send is logged against the SENDER's own membership; more than
`ATLAS_POSTOFFICE_SPAM_THRESHOLD` sends (default 5) within
`ATLAS_POSTOFFICE_SPAM_WINDOW_MS` (default 60000, i.e. a minute) auto-sets
`flagged: true` on that member's entry, recomputed live on every send —
a burst that's gone quiet un-flags itself, no manual "clear" step exists
or is needed. Flagging never blocks a send by itself; it only marks the
roster entry for a human to look at. There's deliberately no new public
"list activity" endpoint for this — same "would leak every member's
public key to anyone who asks" reasoning already applied to the
subscriber roster elsewhere in this project — so seeing it means opening
`issuer-server/atlas-postoffice-members-store.json` (or the equivalent
PHP state file) directly, the same way an operator already would to see
who's a member at all. Once you've decided a flagged member deserves it,
cutting them off needs nothing new: call the existing
`POST /atlas/revoke` with that member's `credentialId`, and thanks to
#95's symmetric check, one call blocks them from both sending AND
receiving through that domain at once. `test/manual-postoffice-abuse.js`
walks the whole flow end to end — burst past the threshold, confirm the
flag, revoke, confirm both directions are now blocked.

**Consent/block model (task #94's remaining piece — "both, recipient's
choice").** Membership (#95) is the baseline gate — both people have to
have joined the same Post Office — but a member can narrow who reaches
them further, on top of that, from the wallet's Social → Mail → "Who can
mail you" panel:
- **Block list.** Name a specific public key and that domain stops
  relaying mail from it to you, full stop — a block always wins over
  everything else below. Also reachable straight from a relayed message
  itself: every mail card from a real sender (not domain-to-subscriber
  mail) carries an inline **Block sender** button next to Delete.
- **Friends only.** Switch a membership to friends-only and the domain
  will only relay mail from public keys in a snapshot you submit — pulled
  from this wallet's own local Friends list (Social → Friends), which
  otherwise never leaves the wallet at all; turning this on is an explicit,
  one-time disclosure of that snapshot to that one domain. It's a snapshot,
  not a live sync — add someone to Friends later and they're not covered
  until you save the panel again.

Both settings are per membership (a wallet belonging to several Post
Offices sets them separately for each) and self-service — three new
domain endpoints (`POST /atlas/postoffice/mailmode`, `/block`, `/unblock`)
authenticate the caller the same self-signed-envelope way
`/atlas/postoffice/send` already authenticates a sender, so nobody can
touch a membership that isn't their own. A fourth,
`POST /atlas/postoffice/mysettings`, is the one Post Office roster lookup
that IS safe to expose over HTTP despite #96's "no public listing"
reasoning: it's gated by that same envelope, so it only ever hands a
caller back their own entry, which is exactly what the settings panel
reads on open (and after every save) rather than trusting local state.
Rejections from either rule read identically ("recipient is not accepting
mail from you right now") so a sender can't distinguish an outright block
from simply not being on a friends-only list. `test/manual-postoffice-
consent.js` covers the server side end to end (block/unblock, friends-only
admission and exclusion, block-beats-friends-only, mode-switch clearing
the snapshot); `test/manual-postoffice-consent-ui.js` drives the real
wallet panel.

**Handle addressing (task #94's last remaining piece — "hide the raw
public key from users").** A member can register a short handle at ONE
Post Office instead of handing out their raw public key — from the same
"Who can mail you" panel, now headed "Your Post Office settings," under
"Your handle." Deliberately `handle#domain`, **not** `handle@domain` — the
`@` shape reads as a real email address and would mislead people about
what this actually is (no inbox provider, no password recovery, nothing
like SMTP underneath); the `#` separator reads more like a Discord-style
tag, which is closer to what it actually is. Compose's recipient field is
handle-first by default: type a bare handle (the domain comes from the
"Send mail" dropdown already picked above it) or paste a full
`handle#domain` string and it selects the right domain for you; a
**"Paste a raw public key instead"** link swaps in the old raw-key field
for anyone who hasn't registered a handle yet.

A handle is unique per DOMAIN, not globally — the same "one card, one Post
Office" scope every other membership setting already has, matched
case-insensitively (`Bob` and `bob` can't both be registered at the same
domain, and a lookup tolerates whatever casing you type). Two new
endpoints: `POST /atlas/postoffice/handle` (self-signed the same way as
mailmode/block/unblock — claim, change, or clear your own) and
`POST /atlas/postoffice/resolve` (a single lookup, handle in → public key
out, no roster dump, no authentication needed — resolving a handle you
already know doesn't require proving who's asking, any more than already
knowing someone's raw public key would). Format and profanity are both
enforced server-side, independently of whatever the wallet's own
same-shaped check already caught, since a modified client could skip that
one.

The nice part: showing a *recipient's* handle instead of their raw key
needs no reverse-lookup endpoint at all. The relaying domain already
stamps `from: {publicKey}` onto outgoing mail (see #95) — it now also adds
the sender's own registered handle, if they have one, to that same stamp,
since it's already sitting right there in its roster. A mail card headed
"From bruno#localhost:8002" is just that field rendered; a sender with no
handle still falls back to the old raw-key fragment. `test/manual-
postoffice-handle.js` covers the server side end to end (claim/uniqueness/
case-insensitivity/format/profanity/resolve/auto-stamping/clearing, run
clean against both issuers); `test/manual-postoffice-handle-ui.js` drives
the real wallet panel and Compose, including a full round trip by bare
handle, by a pasted `handle#domain` address, and via the raw-key fallback.

With this, task #94 is now fully built — handle addressing was its last
open piece.

## 8. Verify it yourself

```bash
node test/verify.js                    # manifest + portal mechanism
node test/verify-wallet.js             # identity, issuance, cross-domain verification, revocation, export
node test/verify-loadout-trading.js    # loadouts/transfer-on-loss, resources, trading station settlement
node test/verify-directory.js          # directory service: crawl/index/rank, filters, free-text, key-anchored verification
node test/verify-asset-cache.js        # gltf-mini's local GLB cache: fresh on first load, 304'd on repeat, re-fetched on real change
```

The first three (plus `verify-asset-cache.js`) need a display (`xvfb-run -a
node test/verify.js` if running headless on Linux) and both demo domains
already running. `verify.js`, `verify-wallet.js`, and
`verify-loadout-trading.js` use a CDP virtual authenticator to stand in for
a real passkey device — the WebAuthn ceremonies they drive are still real,
just auto-approved instead of waiting on a fingerprint reader. Each checks,
over real network requests and real signatures, every step described
above — including that a tampered or revoked credential is correctly
rejected, and that the loadout/trading suite's loser-signed transfer and
two-party trade actually require both keys. Screenshots land in `test/` as
`01`–`04` (manifest/portal), `wallet-01`–`wallet-04` (identity/item
wallet), and `lt-01`–`lt-05` (loadout loss and trade settlement).

`verify-asset-cache.js` walks into the Lobby (the one `gltf-mini-v1` world,
§3's real-WebGL renderer) twice in two separate page loads sharing one
browser profile. The first visit downloads every referenced GLB fresh
(200). Before the second visit it bumps one file's mtime forward on disk —
a real, on-server change — then confirms only that one file comes back
freshly downloaded (200) while every other, unchanged GLB comes back `304
Not Modified`: proof the cache is honoring a real conditional GET
(`If-Modified-Since` against the server's `Last-Modified`) rather than
either always re-fetching or never checking again. Screenshots land as
`cache-01`/`cache-02`.

While a `gltf-mini-v1` world's models are downloading, a small progress
overlay now shows over the 3D canvas ("Loading world assets… N / 19" for
the Lobby) instead of a blank wait — tracked by unique model url, not by
placed object, so a scene reusing one model many times doesn't inflate the
count past what's actually being fetched, and a cache hit (304, or an
already-loaded model from earlier this session) still counts as "loaded"
the moment it resolves, same as a fresh download. See
`test/manual-scene-load-progress.js` for a check that artificially slows
the network to actually observe it advancing rather than trusting it's
there.

`verify-directory.js` is different — it's testing a JSON API, not a
browser UI, so it needs no display and drives the directory service (with
both demo domains already running) directly over `fetch`. It also spawns
its own short-lived, isolated instance of the directory server on a
throwaway port to prove the background re-crawl scheduler actually picks
up a manifest change on its own, without waiting out or polluting the
main instance's 60-second interval.

## What this does and doesn't prove

It proves the `worlds[]` manifest shape end to end, and a real working
slice of §5, §5.2, §5.4, §6, and §7: an issuer signing real credentials, a
wallet verifying them with no shared account system, that verification
holding up unchanged on a domain that was never involved in issuing it, an
owner-signed transfer that moves an item between two independent keys, a
fungible balance that splits and settles by issuing fresh signed
credentials rather than mutating anything in place, and a two-intent trade
that either settles atomically or not at all. That's the actual claim
ownership-without-a-blockchain rests on, and none of it is just written
down anymore — it runs.

It's still not hardened for anything beyond a demo, and a few
simplifications are worth naming plainly rather than leaving implicit:

- The **counterparty identity** is a second real keypair, but not a second
  WebAuthn device — see section 4 above. A production wallet would just be
  two separate installs, each with its own passkey.
- The **issuer also plays the trading station** for §7, instead of being a
  separate party the way the spec allows. The settlement logic (verify
  both intents, verify both balances, atomic issue+revoke) doesn't change
  either way — this just avoids standing up a second server for the demo.
- The issuer's endpoints (`/atlas/revoke`, `/atlas/resource/issue`, and
  so on) have no auth by design, so the tests can exercise them freely.
  The whole thing runs over plain HTTP on localhost. A real deployment
  needs real HTTPS domains and a real access-controlled issuance flow —
  the point here was proving the credential mechanisms themselves work,
  not building a production issuer.
- The renderer is still a dependency-free `<canvas>` stand-in for what a
  production client would do with WebXR and glTF, which real browsers
  already support well, so re-implementing that wasn't the point.

Nothing in `SPEC.md` remains entirely unimplemented as of this build —
§5.2, §5.4, and §7 have all moved from spec-only into working code,
alongside §3 (manifest/portals), §5/§5.1/§5.3 (items, classes,
revocation), and §6/§6.1 (identity, wallet export) from v1.1.
