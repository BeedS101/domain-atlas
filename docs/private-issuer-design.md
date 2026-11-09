# Private issuer: only the domain's own code can sign (design)

Status: design only. No code in this document exists yet, except the interim controls in section 3. Nothing here changes
what a verifier checks: credentials, revocation lists and public keys stay public and unchanged.

## 1. Purpose

The issuer signs credentials with the domain's private key. Today several HTTP routes will sign a credential for a
caller who names the class, the quantity and the owner, and the only checks are the ones each route adds for itself. A
visitor's browser, or any program, is the client of those routes. The browser is not a trust boundary: whatever the
site's pages send, a program can send too.

The goal is that the signing key and the function that uses it are reachable only from the domain's own server code, and
that visitors, pages and other domains can ask the server for something specific but can never choose what gets
signed. A mint is decided by the server from rules the operator wrote down, not by the request.

## 2. What exists today

Facts about the current code, checked while writing this:

- The PHP issuer (`issuer-php/`) has about 108 route files under `atlas/` outside the Studio. Of those, 27 call the
  administrator or moderator check (`require_admin_auth` and the session variants), and 59 accept a POST with no
  administrator or owner-signature check of their own.
- The signing key is a PEM file in `lib/` (`issuer-private-key.pem`), with the other state files, and `lib/` is protected
  only by its own `.htaccess`, which the code writes back if an upload tool dropped it. Only the replay, holdings,
  transaction journal and mint allowance directories can be moved outside the document root, with `ATLAS_PRIVATE_DIR` or
  `lib/atlas-private-dir.txt`; the key cannot.
- `mint_asset_by_class()` in `lib/bootstrap.php` is the one signing function for credentials. Routes call it directly:
  `asset/issue.php`, `asset/mint.php` (administrator), split, consolidate, convert, purchase, drops, several demo routes,
  and the approval executors in `store.php`.
- Value-moving routes already require proof from the owner: split, consolidate, convert and open-chest check an owner
  signature over the request. The Asset Studio issues through a wallet-authorized challenge and response, which is the
  nearest thing to the target model.
- The administrator side has sessions and role scopes (`docs/admin-auth-hardening.md`).
- `issuer-server/server.js` is the Node issuer. It runs the demo sites on ports 8001 and 8002 and must stay in parity
  with the PHP issuer; the live hosting runs PHP.
- Safety machinery that the target design reuses: striped leases, the holdings index, the request-id replay store, the
  transaction journal with recovery, `atlas_private_subdir`, and the mint allowance record added for the weekly limits.

## 3. Interim controls already in place

These narrow the problem and are not the final design.

1. Weekly limits on gold, silver and iron: 1 g per request, 3 g per owner key per rolling 7 days per element, enforced by
   the issuer on both backends (`mintLimits` in the catalog, `mint-allowance` state).
2. The public mint answers only for classes on `ATLAS_PUBLIC_MINT_CLASSES` and only for requests whose origin is the
   issuer's own site, a browser extension or a trusted origin. Platinum and the other generated elements are not
   mintable from outside, which closed the route of minting an unlimited element and converting it into gold.

What they do not do: a program that writes its own origin header can still mint an offered class within its weekly
limits, a new key starts with a fresh allowance, the demo currencies still take any quantity per request, and the chess
reward is decided in the browser.

## 4. Threat model

In scope:

1. A visitor or script minting more than the domain offers, by direct calls, by new keys, or by replaying requests.
2. A page on another site driving the wallet to mint or spend.
3. A bug or a leak in one route exposing the signing function to a caller-chosen class, quantity or owner.
4. A compromised web-facing request path trying to reach the key file.
5. Another domain asking this issuer to sign something on its behalf.

Out of scope: a compromised server (it holds the key), a compromised operator key, denial of service by volume beyond the
limits below, and the monetary value of anything. This is a demo protocol; nothing here has real value.

## 5. Target architecture

Three layers, with one rule between them: only layer 3 can create value, and layer 3 is not an HTTP route.

1. **Public routes.** Everything a browser or another domain calls: reading and verifying (public key, revocation list,
   class lookup, mail check), and the narrow claim and spend routes below. They validate, authenticate and rate limit;
   they never sign.
2. **Grant service (server-only PHP).** One internal function, `atlas_grant($offerId, $ownerKey, $context)`. It reads
   the offer from the offers registry, checks every precondition and limit, takes the leases, reserves the allowance,
   writes the journal entry and only then calls the signer. Callers pass an offer id, never a class or quantity.
3. **Signer.** `mint_asset_by_class()` and the key, reachable only from the grant service and the move operations
   (split, convert, trade settlement), none of which create value.

### 5.1 The offers registry

A private file, hand-edited by the operator and validated at load, listing each thing visitors can obtain:

| Field | Meaning |
|---|---|
| `id` | stable name, for example `stall.market.gold` |
| `class`, `quantity` | what is minted, fixed by the offer |
| `source` | `scene` (a mint or issue stall in the domain's own `scene.json`), `page` (a demo page), `game`, `purchase`, `admin` |
| `limits` | per request, per owner key per window, per client address per window, global per day |
| `requires` | proofs the claim must carry: owner signature, membership credential, key age, verified email |
| `oncePerOwner` | for membership and badge classes |

For `scene` offers the quantity and class are read from the scene file at the time of the claim, so editing a stall
changes what it pays without touching code. Everything else is a static entry. An offer that is not in the registry
cannot be granted by any route.

### 5.2 The claim route

One route replaces the public form of `asset/issue`: `POST /atlas/claim` with `{ offer, ownerPublicKey, requestId,
proof }`. The server:

1. checks the origin as it does now, as a cheap filter and not as security;
2. looks the offer up and rejects unknown ids;
3. verifies the owner's signature over `{offer, requestId, issuedAt, domain}`, so the request is bound to a key the
   caller holds, to this domain and to a short validity window;
4. checks the requirements and limits in the offer;
5. calls `atlas_grant()`.

The old `asset/issue` route is removed from the router, or left answering 410. The wallet's `mintAsset` becomes
`claimOffer(domain, offerId)`; stalls and pages already know which marker was clicked.

### 5.3 Who may claim

Limits keyed only on a public key bound nothing, because keys are free. Three additions raise the cost without
requiring accounts, each switchable per offer:

- key age: a key must have existed (been seen by the issuer) for a minimum time before it can claim a limited offer;
- client address limits, using the connecting address and the forwarded address only when a trusted proxy is configured;
- a membership or verified-email requirement for the offers worth protecting. This is the one control that stops a
  determined script, and it changes what a first visit feels like, so it is a per-offer switch and not a default.

### 5.4 Games and server-decided rewards

A reward that depends on something the browser does (a chess win) is claimable only if the server can verify it. For
chess: the server creates a game with a signed seed and the player's colour and difficulty; the client sends the move
list; the server replays it with the same rules engine and checks that it ends in a win against the bot's deterministic
replies. This needs a rules engine on the server. The chess engine is JavaScript (`extension/chess.js`), so either a PHP
port with a shared test vector set, or the Node issuer is the only host for chess rewards. See open question 3.

### 5.5 Domain to domain

Another domain never calls the claim route. Cross-domain trade already uses relay routes with the peer list
(`ATLAS_TRUSTED_TRADE_PEERS`); those stay, and their requests are signed with the sending domain's key and checked against
the peer's pinned key, replacing the origin allowlist (`ATLAS_MINT_TRUSTED_ORIGINS`) for the federation demo.

### 5.6 Key and state handling

The key and every state file move outside the document root. `ATLAS_PRIVATE_DIR` already supports this for the replay,
holdings, journal and allowance directories; the key and the other store files in `lib/` need the same option, with the
key path configurable and the current `lib/` location kept as the fallback for existing installs. The site doctor flags a
key under the web root, and the grant service refuses to run if the private directory is unwritable or unreadable
rather than falling back to another place. Backups of the key are an operator procedure documented
beside the deployment checklist.

## 6. Route classification

Every file under `atlas/` is assigned one class in stage 1, and a test fails if a new route file is not classified:

| Class | Examples | Rule |
|---|---|---|
| Read | public key, revocation list, class lookup, mail check, trade catalog | no state change, rate limited |
| Claim | `claim` | offers registry, owner signature, limits |
| Move | split, consolidate, convert, transfer, trade claim, relay routes | possession of the credential plus an owner signature; never creates net value |
| Admin | mint, reissue, revoke, suspend, class patch, site status | administrator session and scope |
| Demo | everything under `atlas/demo/` | off unless the demo switch is on; mint through offers like any other route |
| Studio | `atlas/studio/` | its own wallet-authorized issuance, unchanged |

The 59 anonymous POST routes found today are each put in one of Move, Claim, Demo or Read, or removed. Value-creating
demo routes (for example clawback mint, warranty mint, the recall and attestation issue routes, oracle policy issue) become
offers.

## 7. Node parity

The Node issuer gets the same layers: an offers registry loaded from the same file format, `grant()` as the only caller of
the signer, and the same route classes. The parity test used for the offered-class list is extended to compare the
registry the two issuers load, the route table and the refusal codes. The Node issuer keeps its test-only environment
switches; the live PHP issuer has none.

## 8. Wallet and pages

- `mintAsset` is replaced by `claimOffer`, which signs the claim with the owner key (the same identity the wallet
  already holds) and sends it. Stall clicks, chess rewards after server verification, and the membership buttons use it.
- Demo pages call the same route. A page that needs a quantity chosen by the visitor (the demo currencies) gets a fixed
  offer or an operator-only flow instead.
- The extension no longer needs to be a listed origin for any mint, because origin stops being a control.

## 9. Failure modes

| Situation | Result |
|---|---|
| Grant crashes after reserving the allowance and before signing | the journal and the allowance reservation are released by recovery on the next request with the same id |
| Offers file missing or unreadable | no grants; reads and moves keep working; the site doctor reports it |
| Scene file changed under a stall | the next claim uses the new values; no cache |
| Clock skew on the signature window | claim refused with the server time in the answer so the wallet can retry |
| Two claims for one offer at once | the owner lease serialises them; the second sees the first's reservation |

## 10. Build plan

Each stage ships separately with tests, on its own branch, PHP first and Node mirrored in the same stage.

1. Classify every route and add the test that fails on an unclassified route. Behaviour unchanged.
2. The offers registry and `atlas_grant()`; `asset/issue` becomes a thin caller of it. Behaviour unchanged for the
   existing offered classes.
3. The claim route with owner-signed requests; wallet `claimOffer`; remove the public `asset/issue`. Stalls and pages
   move over.
4. Demo routes become offers or are put behind the demo switch.
5. Limits: key age, address limits, per-day global caps, with tests for each and for the proxy configuration.
6. Optional membership or verified-email requirement per offer.
7. Server-verified chess.
8. Domain-to-domain signing replaces the trusted origin list.
9. Configurable key and store location outside the web root, and the site doctor check for it.

## 11. Tests

- A route that is not classified fails the suite.
- No route can reach the signer with a class or quantity taken from the request body (a static check over the route files
  plus runtime tests with hostile bodies).
- Every offer: refused without a signature, with another domain's signature, with an expired window, with a replayed
  request id, over each limit, and concurrently (exactly the limit succeeds).
- Platinum, any generated element, a restricted class and an unknown class cannot be obtained through any public route.
- Crash injection at each step of the grant.
- Parity between the PHP and Node registries and route tables.

## 12. Open questions

1. Is a verified email or membership required for the gold, silver and iron stalls, or only for offers above a threshold?
   Default: not required, key age and address limits only.
2. Is the address limit usable on the live hosting, where the connecting address may be a proxy? Default: use the
   forwarded address only when a proxy list is configured, otherwise the connecting address.
3. Chess verification: a PHP port of the rules engine, or Node-only? Default: a PHP port with shared test vectors.
4. Should the existing public `asset/issue` answer 410 for a period or be removed at once? Default: 410 for one release.
5. Should the demo currencies (`currency.alpha`, `currency.beta`, `credit.balance`, clawback funds) stay visitor-claimable
   at all? Default: fixed-quantity offers only.
6. Where does the operator edit the offers file on shared hosting, and is a form in the admin panel worth building?
   Default: hand-edited file, validated by the site doctor.
7. How long a key must exist before it can claim, and does a new wallet identity get a grace allowance? Default: one
   hour and no grace.

## 13. Not claimed

This does not stop a person who creates many identities and passes whatever the offers require, for example many email
addresses; it makes each one cost something and bounds what each can take. It does not protect against a server
compromise or a leaked key. It does not make the Node development issuer safe to expose; it is a mirror for testing. A
signature over a claim proves the caller holds a key, not that a person is behind it. Nothing here has monetary value.
