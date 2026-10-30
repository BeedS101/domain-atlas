# Asset Studio v0.1 — independent security review handoff

**Branch:** `feature/asset-studio-v0.1` in `BeedS101/domain-atlas`.

**Status / release decision: NO-GO for public minting until this audit is done.** The mint pipeline is implemented and tested end to end against a real PHP issuer and the real wallet extension, but it ships **disabled**: it turns on only when a private `studio-config.json` enables it. Nothing here has been deployed, merged to `main`, or run with a production key. Read `asset-studio-v0.1.md` first for the design.

## Reviewer instructions

Please conduct a **read-only adversarial audit** of this branch. Do not enable mint endpoints on a live domain, alter issuer keys, or merge to `main`. Use `node test/studio-local-issuer.js` for an isolated issuer. For each finding give the file and line, attack preconditions, impact, exploit outline, recommended fix and a regression-test idea, ranked critical/high/medium/low. State uncertainty explicitly. Passing tests are not evidence of security; try to break the design.

## What changed relative to the earlier prototype

- `inc/studio-mint.php` (new) orchestrates challenge and mint. `api.php` exposes `validate`, `status`, `challenge`, `mint`.
- Issuance is one transaction in the issuer's existing journal/replay store (`lib/replacement.php`), request id `studio-mint-<nonce>`. There is no separate Studio ledger. The attempt ledger only enforces quotas and records outcomes.
- The Studio class is `restrictedIssuance`: `mint_asset_by_class()` refuses it, `atlas/asset/issue.php` returns 403 before any lease, and the Node issuer (`issuer-server/server.js`) refuses it on the same routes. Studio calls `issue_asset()` itself.
- `inc/mint-authorization.php` now checks the WebAuthn assertion type and user-presence flag, requires an exact payload shape, only accepts origins from the issuer's configuration, and treats anything but `true` from the verifier as a failure.
- `inc/keys.php` validates recipient and proof keys with OpenSSL (P-256 only; raw 65-byte point or SPKI), so a point off the curve or a different curve is refused.
- `studio.js` requests the signature and offers the credential through the existing bridge (`requestSignature`, `offerAsset`); the wallet queues the offer and verifies the issuer signature at Claim.

## Review these files first

- `issuer-php/atlas/studio/api.php`, `inc/studio-mint.php`, `inc/authorize-design.php`, `inc/mint-authorization.php`, `inc/challenges.php`, `inc/mint-attempts.php`, `inc/keys.php`, `inc/issuance-plan.php`, `inc/model-catalog.php`, `inc/design-validator.php`, `inc/storage.php`
- `issuer-php/lib/bootstrap.php` (`verify_envelope`, `atlas_unwrap_bridge_signed`, `mint_asset_by_class`, `issue_asset`), `lib/store.php` (catalog entry, `atlas_fault_point`), `lib/replacement.php` (lease, journal, replay)
- `issuer-php/atlas/asset/issue.php` and the other callers of `issue_asset()` / `mint_asset_by_class()`
- `issuer-server/server.js` (`RESTRICTED_ISSUANCE_CLASSES`)
- `issuer-php/atlas/studio/studio.js`, `index.html`
- `extension/page-bridge.js`, `content.js`, `confirm-bridge.js`, `wallet.js` (`queueBridgeOffer`, `claimBridgeOffer`, `verifyCredential`)
- `test/studio-lab.js`, `test/asset-studio-integration.js`, `test/manual-studio-wallet-flow.js`, `test/asset-studio-*.php`

## Attack surfaces to cover

1. **Authorization:** bridge-sign context and origin, whitelist for `atlas.studio.mint/1`, canonical payload, key encodings and equality, signature verification, WebAuthn assertions (the verifier ignores `rpIdHash` and `clientDataJSON.origin`), injected fields, cross-origin behaviour, and any way the page can influence the signed summary.
2. **Idempotency and crashes:** lease correctness across PHP workers and processes, the commit point (journal write), recovery by retry and by `atlas_txn_sweep()`, the window between signing and the journal write, torn writes, a replay record or journal entry that is damaged or missing, and whether any ordering can yield two credentials for one authorization or lose one that was returned.
3. **Class authority:** every path that reaches `issue_asset()` or `mint_asset_by_class()` (issue, mint, purchase, mail gift, ticket send, split, consolidate, convert, reissue, clawback, demo routes), the Node equivalents, and whether the class can be minted, edited, split, merged, converted or traded outside Studio. Confirm the credential is non-fungible, owner-bound and no-value.
4. **Abuse limits:** per-address rate limits, per-recipient and global quotas, outstanding-challenge cap, body limits, Origin handling, lack of CORS, fail-closed configuration, and storage growth.
5. **Private storage:** storage root versus document root and symlinks, file modes, TOCTOU on the config and challenge files, hard links, hostile file contents, and pruning.
6. **Models:** that only the three approved template files can be referenced, the magic-byte check, and the https URL construction from the request host (`atlas_domain()` comes from the Host header; the configured `domain` must equal it).
7. **Wallet delivery:** the page only offers a complete issuer-signed credential; the wallet verifies it independently; an offer is never treated as ownership.
8. **Information leakage** in errors and stored files.

## Verified behaviour (reproduce with the commands below)

- Real signatures (raw ECDSA and WebAuthn-style) against a live PHP issuer; rejected: bit-flipped signatures, a different key claiming the recipient, signatures over other payloads, recipient mismatch, other origins and ports, wrong ctx, wrong purpose, swapped nonce/digest, tampered summary, extended expiry, extra/missing payload fields, string/float/array types, unknown proof fields, role/key-kind mismatch, missing user presence, wrong WebAuthn type. Rejections leave the challenge usable and issue nothing.
- Altered design with a genuine signature over the original: refused. Randomised type-confusion over every leaf of a valid request: always 4xx, never 5xx or 200.
- Replay: repeats return the identical bytes; a different design, signer or origin cannot reuse a completed nonce. Twelve simultaneous identical mints yield one credential. Per-recipient and global quotas hold under concurrent load; retries are not double-counted or rate limited.
- Crash at each of: after attempt claim, after signing, before journal write, after journal write, after holdings registration, after revocation step, after replay store, after journal removal, after commit bookkeeping. A retry on a restarted issuer returns exactly one credential, equal to the one committed before the crash when one was; no duplicate; quota counted once. Repeated SIGKILL under concurrent load: one credential per authorized request, no duplicates, journal drained.
- Mutation checks: removing the origin check, the WebAuthn presence check, the replay lookup or the request lease each makes the matching tests fail.
- General routes (`/atlas/asset/issue` on PHP and Node, the shared choke point called directly) refuse the class; admin routes without auth do not return credentials; the class is absent from the trade catalog.
- Real extension: refusal for a page without the studio world, Deny mints nothing, Approve issues one credential, the offer queues unclaimed, the wallet's Claim verifies the issuer signature, and a forged credential is not accepted.

## Commands

- `php test/run-asset-studio.php` (unit tests plus the integration suite)
- `node test/asset-studio-integration.js [filter]`
- `xvfb-run -a node test/manual-studio-wallet-flow.js`
- `node test/studio-local-issuer.js [port]` for manual testing with your own wallet

## Known gaps to weigh

See "Known gaps" in `asset-studio-v0.1.md`. In particular: `verify_envelope()` does not bind WebAuthn assertions to an RP ID or origin; there is no operator reconciliation tool for abandoned attempts; the outstanding-challenge cap is approximate under bursts; quotas key on the connecting address only; admin `reissue` can edit Studio properties; moderation is the existing handle filter. Two existing suites fail the same way on the unmodified branch point and are unrelated (`manual-trade-submit-php.js` step 3 and `manual-clawback-php.js` step 1b expect `split`, which is disabled by design; `manual-trading-catalog.js` expects 121 classes and the catalog has 134).

## Reviewer deliverables

1. A clear **GO/NO-GO** for an isolated, opt-in, no-value Studio demo, and separately for any live-domain or public rollout.
2. A findings table with severity, location and exploitation conditions.
3. A short prioritised remediation plan, blockers first.
4. Any adversarial tests worth adding, with expected assertions.
5. A distinction between verified behaviour, inferred intent and unimplemented mechanisms.

**Release rule:** do not enable minting on a public issuer until critical and high findings are fixed, the tests pass on the exact commit, the manual wallet test has been repeated on the target, and a second review confirms the result.
