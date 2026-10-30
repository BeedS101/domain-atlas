# Asset Studio v0.1 — independent security review handoff

**Branch:** `feature/asset-studio-v0.1` in `BeedS101/domain-atlas`.

**Status / release decision: NO-GO for public minting.** The current `issuer-php/atlas/studio/api.php` only validates designs with `POST ?op=validate`; all other operations respond with HTTP 403. `Mint to Wallet` is disabled in the preview. No successful real issuer-to-wallet mint has been established.

## Reviewer instructions (Claude or independent auditor)

Please conduct a **read-only adversarial audit** of this branch. Do not enable mint endpoints, update live domains, alter issuer keys, or merge to `main`. Identify concrete vulnerabilities with affected file/line, attack preconditions, impact, exploit outline, recommended fix, and a regression-test idea. Rank findings by critical/high/medium/low. Treat passed helper tests as insufficient evidence of complete end-to-end security. Report uncertainty explicitly.

Examine the interaction between Studio, PHP issuer, wallet bridge and existing issuance/replay paths rather than just checking Studio's isolated helpers.

## Review these files first

- `issuer-php/atlas/studio/index.html`, `studio.js`, `api.php`
- `issuer-php/atlas/studio/inc/design-validator.php`
- `issuer-php/atlas/studio/inc/issuance-plan.php`
- `issuer-php/atlas/studio/inc/mint-authorization.php`
- `issuer-php/atlas/studio/inc/challenges.php`
- `issuer-php/atlas/studio/inc/storage.php`
- `issuer-php/lib/bootstrap.php` (`verify_envelope`, `atlas_unwrap_bridge_signed`, `mint_asset_by_class`, `issue_asset`)
- `issuer-php/lib/store.php` (`ATLAS_ASSET_CATALOG`, supply, holdings, profanity blocklist)
- `issuer-php/atlas/asset/issue.php` and existing issuer routes
- `extension/page-bridge.js`, `extension/content.js`, `extension/confirm-bridge.js`, `extension/wallet.js`
- `test/run-asset-studio.php`, `test/asset-studio-*.php`
- `docs/asset-studio-v0.1.md`, `docs/asset-studio-storage.md`

## Mandatory attack surfaces

1. **Authorization and signing:** Check bridge-sign context, allowed origin, whitelist policy for `atlas.studio.mint/1`, exact canonical payload, public-key encoding, signature verification, WebAuthn user presence, recipient binding, injected signer fields, and cross-origin behavior. Key equality must be cryptographically meaningful, not just string comparison.
2. **Challenge replay/concurrency:** Check nonce generation; expiry; atomic consumption; lock correctness under multiple PHP workers; torn writes; recovery on kill/crash; whether consumed challenges produce exactly one signed credential; and the absence of a durable idempotent issuance journal.
3. **Asset class authority:** Ensure an untrusted design cannot set issuer, owner, class, quantity, tradability, models, capabilities, financial value, or privileged properties. Confirm studio class is a server-owned non-fungible, bound, no-value demo class; no escape via general issue/split/reissue routes.
4. **Abuse prevention:** Rate limits, quotas per verified identity and host, bounded drafts/uploads, CSRF and origin handling, public access policy, moderation and retention. A signed request is **not** proof a user has permission to mint unlimited assets.
5. **Private storage:** Validate realpath/document-root and symlink boundaries, directory ownership and permissions, hard links, JSON write durability, read/rename races, unexpected object structure, path traversal and sensitive file exposure. Ensure Studio cannot touch existing issuer keys or holdings.
6. **Profanity moderation:** Review reuse of PHP handle filter for asset names, bypasses (Unicode/homoglyphs), overly aggressive substring blocking, behavior for non-English names, and whether descriptions require moderation too.
7. **Wallet delivery:** Ensure the issuer signs first, the website may only offer a complete authentic credential, wallet validates it independently, and queue/claim does not treat a preview as ownership.
8. **Tests:** Run all PHP helper tests and integration tests in an isolated environment. Include malformed JSON types, concurrency and SIGKILL cases, legitimate wallet bridge signing, malicious signers, browser denial, replay, restart, and revoked/suspended credentials where applicable.

## Confirmed verifier concern from source review

- `issuer-php/lib/bootstrap.php` provides `verify_envelope()`, which checks WebAuthn challenge/signature but does **not** by itself require `clientDataJSON.type === 'webauthn.get'` or the authenticator user-presence flag. Its existing `verify_mail_envelope()` wrapper does both before delegating. A future Studio mint route must require the stronger checks for WebAuthn assertions, and test missing user presence, wrong type, and valid signatures. This is a code-review finding, not a demonstrated exploit.
- Full PHP suite execution is still outstanding: the current sandbox has PHP installed but could not clone GitHub because DNS resolution of github.com failed. Do not claim the suite passed.

## Known gaps to verify, not assumptions of readiness

- The dedicated Studio mint endpoint **does not exist yet**. There is no proven issuer catalog integration, authorization to issue, rate limiting, durable mint outcome journal or wallet offer flow.
- `atlas_studio_verify_mint_envelope()` accepts a verifier callback, but no route currently supplies the real PHP issuer verifier or checks `verify_envelope(..., ..., true)` in an end-to-end flow.
- An isolated `inc/mint-attempts.php` prototype now records a single pending-reconciliation attempt per challenge nonce; it deliberately does not retry issuance or atomically integrate with issuer holdings, and needs audit, recovery design and real testing.
- The challenge store marks a nonce consumed but is not an issuance transaction. A crash after nonce consumption can permanently lose the mint result.
- The Studio preview works from a local file. PHP validation only works on a PHP-served page.
- Studio private storage helper paths require precreated private directories and remain disconnected from the API.
- The filter is a handle-oriented substring list; watch false positives such as names containing embedded blocked substrings.
- All tests added to the branch need reproducible execution reports. Don't count earlier reconstructed smoke tests as repository CI.

## Reviewer deliverables

1. A clear **GO/NO-GO** for enabling an **isolated, opt-in, no-value Studio demo**, and separately for any live-domain or public rollout.
2. Findings table with severity, code location and exploitation conditions.
3. A small, prioritized remediation plan: blockers first; no speculative rewrites.
4. Concrete adversarial tests and expected assertions.
5. Explicit distinction between verified behavior, inferred design intention, and unimplemented mechanisms.

**Release rule:** Do not enable minting until critical/high findings are remediated, tests are reproducible against exact repo commit, manual wallet/issuer integration is demonstrated, and a second review confirms the result.
