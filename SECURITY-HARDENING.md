# Security hardening: what changed, compatibility and deployment order

Branch `security/hardening`, from main `9f32151`. Nothing here has been deployed. All testing used throw-away local
issuers with their own keys and state; no live domain was contacted.

## What changed

| Area | Change | Tests (Node and PHP share cases) |
|---|---|---|
| P1 world-drop ownership | A cross-domain claim settles only with the owner's signed drop intent (naming credential, world, hosting domain and drop id) and the claimant's signed claim intent. A relaying domain's attestation alone moves nothing. | `security-world-drop-relay.js`, `security-world-drop-wallet.js` |
| P2 outbound requests | One server-to-server policy in PHP and Node: https on 443 for public peers, no URL-shaped domain strings, no redirects, public-address pinning, size/time/rate limits, loopback only in explicit local-development mode. | `security-outbound-policy.js/.php`, `security-outbound-endpoints.js` |
| P3 foreign revocation | A foreign issuer whose revocation or suspension list cannot be fetched or parsed is refused (fails closed). | `security-foreign-revocation.js` |
| P4 passkey envelopes | `verify_envelope` requires `webauthn.get`, a well-formed authenticator-data structure, user presence, an origin and RP ID hash from the expected contexts (wallet extension origins and this domain's own origins; pinnable), and optionally user verification. The client-supplied origin is not its own authority. The raw-ECDSA path is unchanged. | `security-webauthn-envelope.js/.php`, `security-webauthn-endpoints.js` |
| P5 crash-safe replacement | Reissue, clawback, class patches, legacy transfer, world-drop claims, trade legs and trade refunds all use the existing replacement journal: sign successors, write the journal entry, revoke predecessors in one atomic step, apply effects, store the replay result. Retries return the recorded result; no second transaction system. | `security-replacement-recovery.js`, `security-world-drop-settlement.js`, `security-trade-settlement.js` |
| Cross-domain trade refund | When a trade's second leg is refused for good (HTTP 400 or 403) after the claimant's balance was spent by another domain, the station asks that issuer to undo its first leg (`/atlas/trade/relay-refund`): it revokes the credit it minted for the poster and pays the claimant the same value. A refunded leg is never settled or replayed again. | `security-trade-refund-relay.js` (Node, PHP and mixed) |
| PHP issuer identity | The PHP issuer's domain comes from `ATLAS_DOMAIN` or `lib/atlas-domain-config.json`, not from the request's Host header. A signed request meant for another domain is refused whatever Host it carries. | `security-domain-pin.js` (Node and PHP share the cases) |

## Compatibility implications

- **Wallet.** A pickup or drop of an item at a domain that did not issue it needs a wallet that signs the new intent
  fields (`domain`, `dropId`). Older wallets still work for same-domain drops. Update the wallet before relying on
  cross-domain drops.
- **Legacy drops.** Drops listed before wallets signed intents carry none. An operator may list the relaying domains
  allowed to omit them in `ATLAS_LEGACY_DROP_PEERS` (comma separated). The default is empty.
- **Drop intent expiry.** A new drop needs an owner intent whose `expiresAt` is a canonical UTC timestamp no more than two
  minutes past and no more than fifteen minutes ahead; the wallet signs ten minutes. Intents without `expiresAt`
  (older wallets) are accepted until `ATLAS_DROP_LEGACY_UNTIL` (default `2027-03-31T00:00:00.000Z`) and refused for drops
  accepted after it; a drop the hosting domain accepted before then stays claimable. A placed drop never expires: the
  issuer judges the owner's intent against the time the hosting domain says it accepted the drop (`droppedAt` in the
  signed attestation). Hosting domains and issuers must be updated before the date; an older hosting domain sends no
  `droppedAt`, so an issuer past the date judges its intents against the claim time. Set `ATLAS_DROP_LEGACY_UNTIL` to a
  past date to enforce at once.
- **Peers.** Non-443 public peers and URL-shaped domain strings are now rejected. A foreign issuer that publishes no
  revocation document is refused. `ATLAS_ALLOW_LOCAL_PEERS=1` re-enables loopback peers for development; it is off by
  default and implied only by the built-in development servers.
- **PHP.** curl is required for outbound requests. New state files `lib/atlas-outbound-rate-store.json` and
  `lib/atlas-outbound-key-cache.json` are created at runtime (covered by the existing `lib/atlas-*.json` ignore rule).
- **PHP issuer domain.** Set it explicitly on each PHP deployment: `ATLAS_DOMAIN=evtec.co.za` (or
  `ATLAS_DOMAIN=domain-atlas.co.za`) in the environment or as a web server setting such as `SetEnv`, or create
  `lib/atlas-domain-config.json` containing `{"domain": "evtec.co.za"}` where an environment variable is awkward. Use the
  name wallets and peers already know the issuer by, the `issuer.domain` of its existing credentials, with a port only if
  it has one. The file is in `lib/`, which the web server does not serve, and does not count as issuer state. A value that
  is not a host name stops the issuer from answering (HTTP 500) instead of falling back to the request. Until it is set
  the issuer behaves as before, taking the Host header, except that the host is lower-cased, a Host that is not a host name
  is refused with 400, and a notice is logged at most every six hours. The Node issuer already read `ATLAS_DOMAIN`.
  The passkey module takes its origins from the same setting.
- **Passkeys.** Default accepted origins: wallet extension origins plus this domain's own origins. Pin with
  `ATLAS_WEBAUTHN_ORIGINS` and `ATLAS_WEBAUTHN_RP_IDS` (comma separated); require user verification with
  `ATLAS_WEBAUTHN_REQUIRE_UV=1`.
- **Outbound tuning.** `ATLAS_OUTBOUND_TIMEOUT_MS`, `_MAX_BYTES`, `_RATE`, `_RATE_ALL`, `_RATE_WINDOW_MS`,
  `_KEY_RATE`, `_KEY_RATE_ALL`, `_KEY_CACHE_MS`, `_USER_AGENT`. A peer's key is cached for 60 s by default, so a rotated
  key can stay trusted that long. The budgets are shared out between callers and kinds of operation (key lookups,
  revocation checks, world-drop relays, other relays): `ATLAS_OUTBOUND_RESERVE` (default 0.15; 0 turns it off) and
  `ATLAS_OUTBOUND_FAIR_SHARE` (default 0.25). Callers are told apart by socket address, so behind a reverse proxy set
  `ATLAS_OUTBOUND_RESERVE=0` (see `docs/security-follow-ups.md`).
- **Repeated requests.** An identical repeat of reissue, clawback or legacy transfer within the replay window
  (`ATLAS_REPLAY_TTL_HOURS`, default 168) now returns the recorded result instead of "already revoked". The same request
  with a different recipient is refused.
- **World-drop store.** Listings gain `reservedBy/reservedAt` (while being picked up) and `claimedBy/claimedAt` (kept
  for the replay window, hidden from the public listing, then pruned). A concurrent claimant now gets 409 `busy` while a
  claim is pending, and 404 once it is done. `ATLAS_DROP_RESERVE_SECONDS` (default 120) bounds how long a stopped
  claim blocks others.
- **New endpoint.** `POST /atlas/trade/relay-refund` on both issuers, behind the same trusted-peer list and attestation as
  `relay-lock` and `relay-settle`. It is additive: a station that finds an older issuer without it (HTTP 404) leaves the
  claim open and tells the claimant to ask again or contact the operator, refunds nothing and duplicates nothing, and the
  same claim refunds once that issuer is upgraded. `relay-lock` and `relay-settle` answer HTTP 400 with
  `code: "trade-refunded"` and the refund credential for a leg that was refunded.
- **Old tests changed on purpose:** tests that expected "already revoked" on an identical repeat, and the concurrent
  world-drop race tests (the loser may now get 409 instead of 404).
- **Nothing is reset.** No keys, revocation lists, journals, ledgers or holdings are regenerated or cleared. Existing
  signed credentials stay valid.

## Deployment order

1. Review and merge. Run the full suites listed below on a staging copy with its own issuer keys.
2. Deploy the issuer servers (PHP and Node) before the wallet. Set `ATLAS_DOMAIN` on PHP hosts, confirm curl, and review
   `ATLAS_WEBAUTHN_*` and `ATLAS_LEGACY_DROP_PEERS` for each domain. Roll the domains of a federated pair together or
   issuers first, since the new relay-claim requires the owner and claimant intents.
   Set the PHP domain on both PHP deployments in the same step (see "PHP issuer domain"). Upgrade every issuer that can
   issue a balance a visitor may spend at another domain's Trading Station: the refund runs on that issuer.
3. Release the updated wallet (adds `domain` and `dropId` to drop/claim intents, and applies a trade refund issued by the
   issuer of the spent balance rather than only by the station). An older wallet that receives such a refund holds the
   claim as needing attention and applies nothing; the station keeps the refund, so asking again after the update applies
   it once.
4. Watch for 409 `busy` and stale reservations on world drops, and for refused foreign issuers (missing revocation
   documents) after the change.
5. Rollback: the journal and replay stores are additive; older code ignores the new listing fields. Keep the journal
   directory when rolling back so unfinished entries can still be recovered.

## Unresolved risks

- **Cross-domain trades, foreign poster balance (fixed).** A foreign issuer whose answer to the second leg is lost or
  unusable no longer causes a refund. Only a definite refusal (HTTP 400 or 403 from the issuer, sent before it changes
  anything) refunds the claimant; any other outcome leaves the claim open with `claim-unresolved` and nothing undone.
  The claimant asks again with the same claim: the claim resumes from the committed first leg, the issuer's
  `relay-lock` accepts a balance already settled for the same trade, and `relay-settle` replays the issuer's recorded
  result (or settles it if it never ran). Test: `security-trade-relay-recovery.js`. Compatibility: the station treats an
  older issuer's answer the same way (it never needed new fields); an issuer without this change answers a repeated
  `relay-lock` for an already-settled balance with 400, so such a retry is refused rather than refunded.
- **Cross-domain trades, foreign claimant balance (fixed).** When the claimant's balance is issued by another domain, the
  station writes an attempt record (replay store, op `trade-attempt`, keyed by trade and balance) before it relays
  anything. A retry that finds the record accepts the balance on its signature alone (genuine credential, signed by its
  issuer's published key, owned by the claimant, right class and size, issuer on the trusted-peer list) and lets the
  issuer's `relay-lock`/`relay-settle` decide: they replay a committed leg or settle one that never ran. Without the
  record the retry died on "it has revoked/suspended this credential" (the station's own 120 s lock counts too).
  Test: `security-trade-relay-recovery.js` runs both the poster's and the claimant's issuer being stopped.
- **Cross-domain trades, poster's issuer refuses for good (fixed).** The claimant's balance was spent by one issuer and
  the poster's issuer then answered HTTP 400 or 403: the station asks the claimant's issuer for `relay-refund`. That issuer
  revokes the credit it minted for the poster (never delivered, since the mail carrying it belongs to the leg that did not
  happen) and pays the balance's owner the same value, as one journalled replacement keyed by the credit and the claimant.
  Asking again, after a lost answer or a stop at any point of the refund, returns the same credential; a retried claim for
  a refunded trade gets the refund back and never settles. Test: `security-trade-refund-relay.js` (poster refuses with 400
  and 403, a unique item, a claimant whose balance the station itself issued, the claimant's issuer stopped at four points
  of the refund, an older issuer without the endpoint; Node, PHP and both mixed layouts).
  Trust: the claimant's issuer refunds on a trusted peer's signed word, the same trust `relay-settle` already places in
  it, and the refund always goes to the owner named by the presented credential. A poster's issuer that answers 400 or 403
  after it did settle would pay both sides; a peer should be trusted only if its answers can be.
- A reservation held by a crashed claimant blocks other claimants until it lapses (`ATLAS_DROP_RESERVE_SECONDS`).
- The relay-settle journal replay is covered by review and the existing cross-domain suites, not a dedicated crash test.
- Other PHP services in the repository (`chain-labs/*.php`, `call-php`, `presence-php`, `directory-php`) were not part of this
  change; `issuer-php` is the one that signs credentials. The chain-labs pages check the Host against their own host list.
- A PHP issuer nobody has pinned yet still trusts the Host header until `ATLAS_DOMAIN` is set; that is the compatibility
  cost of not breaking a deployment that was never configured.
- The WebAuthn signature counter is not checked.
- The per-peer key-lookup budget can be exhausted by a flood (a deliberate denial-of-service tradeoff).
- Crash tests stop the process; they do not prove behavior across power loss.
- Paths audited but not changed: Post Office leave, email-ticket and file export/claim deliveries have their own
  recovery.

## How to run the new tests

```
node test/security-world-drop-relay.js        # STACK=node|php
node test/security-world-drop-expiry.js       # STACK=node|php
node test/security-outbound-isolation.js       # STACK=node|php
node test/security-outbound-policy.js ; php test/security-outbound-policy.php
node test/security-webauthn-envelope.js ; php test/security-webauthn-envelope.php
node test/security-replacement-recovery.js both
node test/security-world-drop-settlement.js both
node test/security-trade-settlement.js both
node test/security-trade-relay-recovery.js both
node test/security-trade-refund-relay.js both     # node | php | mixed | both
node test/security-domain-pin.js both
xvfb-run -a node test/security-world-drop-wallet.js
```
Browser suites need `xvfb-run -a`. Old manual suites need `ATLAS_PRIVATE_MINT=off ATLAS_MINT_LIMITS=off`.
`manual-drop-pickup.js` is intermittently flaky at wallet creation, also on unmodified code.
`manual-gen1-claim-remainder.js` and `manual-gen1-unique-recovery.js` rig the poster's issuer to answer HTTP 400 (a refusal)
where a refund is expected and HTTP 500 (outcome unknown) where the claim must be held. `manual-gen1-backup-journal.js` (one
activity-log check) and `manual-gen1-php-deployment.js` / `manual-gen1-fungible-fixes.js` fail identically on unmodified `main`.
Tests that read an issuer's state from the repository (`manual-federation-relay.js`, the mail suites, `manual-world-drops-protocol.js`)
need the two demo domains served locally first (README, "Serve the two demo domains locally").
