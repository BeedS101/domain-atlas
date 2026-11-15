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

## Compatibility implications

- **Wallet.** A pickup or drop of an item at a domain that did not issue it needs a wallet that signs the new intent
  fields (`domain`, `dropId`). Older wallets still work for same-domain drops. Update the wallet before relying on
  cross-domain drops.
- **Legacy drops.** Drops listed before wallets signed intents carry none. An operator may list the relaying domains
  allowed to omit them in `ATLAS_LEGACY_DROP_PEERS` (comma separated). The default is empty.
- **Peers.** Non-443 public peers and URL-shaped domain strings are now rejected. A foreign issuer that publishes no
  revocation document is refused. `ATLAS_ALLOW_LOCAL_PEERS=1` re-enables loopback peers for development; it is off by
  default and implied only by the built-in development servers.
- **PHP.** curl is required for outbound requests. Set `ATLAS_DOMAIN`: the passkey module takes this domain's own
  origins from it (it no longer depends on the request's Host header). New state files
  `lib/atlas-outbound-rate-store.json` and `lib/atlas-outbound-key-cache.json` are created at runtime (covered by the
  existing `lib/atlas-*.json` ignore rule).
- **Passkeys.** Default accepted origins: wallet extension origins plus this domain's own origins. Pin with
  `ATLAS_WEBAUTHN_ORIGINS` and `ATLAS_WEBAUTHN_RP_IDS` (comma separated); require user verification with
  `ATLAS_WEBAUTHN_REQUIRE_UV=1`.
- **Outbound tuning.** `ATLAS_OUTBOUND_TIMEOUT_MS`, `_MAX_BYTES`, `_RATE`, `_RATE_ALL`, `_RATE_WINDOW_MS`,
  `_KEY_RATE`, `_KEY_RATE_ALL`, `_KEY_CACHE_MS`, `_USER_AGENT`. A peer's key is cached for 60 s by default, so a rotated
  key can stay trusted that long.
- **Repeated requests.** An identical repeat of reissue, clawback or legacy transfer within the replay window
  (`ATLAS_REPLAY_TTL_HOURS`, default 168) now returns the recorded result instead of "already revoked". The same request
  with a different recipient is refused.
- **World-drop store.** Listings gain `reservedBy/reservedAt` (while being picked up) and `claimedBy/claimedAt` (kept
  for the replay window, hidden from the public listing, then pruned). A concurrent claimant now gets 409 `busy` while a
  claim is pending, and 404 once it is done. `ATLAS_DROP_RESERVE_SECONDS` (default 120) bounds how long a stopped
  claim blocks others.
- **Old tests changed on purpose:** tests that expected "already revoked" on an identical repeat, and the concurrent
  world-drop race tests (the loser may now get 409 instead of 404).
- **Nothing is reset.** No keys, revocation lists, journals, ledgers or holdings are regenerated or cleared. Existing
  signed credentials stay valid.

## Deployment order

1. Review and merge. Run the full suites listed below on a staging copy with its own issuer keys.
2. Deploy the issuer servers (PHP and Node) before the wallet. Set `ATLAS_DOMAIN` on PHP hosts, confirm curl, and review
   `ATLAS_WEBAUTHN_*` and `ATLAS_LEGACY_DROP_PEERS` for each domain. Roll the domains of a federated pair together or
   issuers first, since the new relay-claim requires the owner and claimant intents.
3. Release the updated wallet (adds `domain` and `dropId` to drop/claim intents).
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
- **Remaining cross-domain gap.** If the poster's leg is refused for good (HTTP 400/403 from its issuer) after the
  claimant's foreign balance was already spent, the station cannot refund it: there is no cross-domain refund relay.
  The claimant is told to contact the operator, as before.
- A reservation held by a crashed claimant blocks other claimants until it lapses (`ATLAS_DROP_RESERVE_SECONDS`).
- The relay-settle journal replay is covered by review and the existing cross-domain suites, not a dedicated crash test.
- PHP `atlas_domain()` is still derived from the Host header elsewhere in the codebase.
- The WebAuthn signature counter is not checked.
- The per-peer key-lookup budget can be exhausted by a flood (a deliberate denial-of-service tradeoff).
- Crash tests stop the process; they do not prove behavior across power loss.
- Paths audited but not changed: Post Office leave, email-ticket and file export/claim deliveries have their own
  recovery.

## How to run the new tests

```
node test/security-world-drop-relay.js        # STACK=node|php
node test/security-webauthn-envelope.js ; php test/security-webauthn-envelope.php
node test/security-replacement-recovery.js both
node test/security-world-drop-settlement.js both
node test/security-trade-settlement.js both
xvfb-run -a node test/security-world-drop-wallet.js
```
Browser suites need `xvfb-run -a`. Old manual suites need `ATLAS_PRIVATE_MINT=off ATLAS_MINT_LIMITS=off`.
`manual-drop-pickup.js` is intermittently flaky at wallet creation, also on unmodified code.
