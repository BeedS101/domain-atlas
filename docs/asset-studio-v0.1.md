# Domain Atlas Asset Studio v0.1

Asset Studio lets a visitor design a free, no-value, non-fungible, owner-bound demo collectible (trophy, badge or key), then mint it into their own Domain Atlas wallet.

**Status:** integrated with the PHP issuer and the wallet bridge, tested end to end, and **disabled by default**. Public minting stays off until an independent security audit has been done (see `asset-studio-security-audit-handoff.md`).

## Flow

1. The page builds a design (template, name, description, finish). `POST api.php?op=validate` returns the validated design and its canonical SHA-256 fingerprint (`designDigest`). It holds no state and is always available.
2. The page reads the visitor's public key with `window.atlasWallet.getIdentity()`.
3. `op=challenge` (`design`, `recipient`): the issuer validates the design, checks the approved model files exist, and stores a single-use challenge for 120 seconds. It returns the exact payload to sign, `{purpose, nonce, designDigest, recipient, expiresAt, summary}`. The summary is computed by the issuer from the validated design; the page cannot choose it.
4. The page calls `window.atlasWallet.requestSignature(signRequest)`. The wallet shows that payload and the requesting origin. The visitor approves or denies.
5. `op=mint` (`design`, `nonce`, `proof`): the issuer re-validates the design and checks, in this order: the stored challenge, exact proof shape, an origin from its own configured list, the recipient/key/digest/summary/expiry bindings, WebAuthn type and user presence (for passkey identities), and finally the signature with its own `verify_envelope()`. Only then does it sign one `atlas.demo.studio.collectible` credential through `issue_asset()`.
6. The page checks the owner and class and calls `window.atlasWallet.offerAsset(credential)`. The wallet queues it as a pending offer. The visitor claims it; the wallet verifies the issuer signature itself against the issuer's published key before adding it.

The credential carries the approved design in `asset.properties` (`atlas.studio.*`, including the digest) and issuer-controlled `model` and `thumbnail` URLs from a fixed template table (`/assets/{trophy,badge,key}.{glb,png}`). The page never supplies a class, quantity, trade scope, model path or issuer.

## Idempotency and crash safety

Studio does not keep a second ledger. A mint is one transaction in the issuer's existing journal and replay store (`lib/replacement.php`), under the request id `studio:mint:<nonce>`. The colons put it outside what the general `requestId` field accepts (letters, digits, `-`, `_`), so no other route can read or poison a Studio replay record:

- Requests for one nonce are serialized by the request-id lease.
- The credential is signed in memory, then committed by writing the transaction journal entry (the commit point), then the replay record is stored and the journal entry removed.
- A credential exists exactly when a journal entry or replay record exists. A crash before the journal write leaves no trace and a retry signs a fresh credential; a crash after it is completed by any retry (or by `atlas_txn_sweep()`), which returns the stored response byte for byte.
- The attempt ledger (`mint-receipts`) only enforces quotas and records the outcome; the challenge file only records `issued` / `completed`. Neither decides whether a credential exists, so a crash between them and the commit is repaired by the next retry. A retry of an existing nonce is never counted twice.
- Studio-class credentials are non-fungible, so there is no holdings or supply state to keep consistent.

## Closing the other issuance routes

The catalog entry sets `restrictedIssuance: 'studio'`. `mint_asset_by_class()` (the shared choke point used by issue, mint, purchase, mail gifts, ticket sending, split, consolidate and convert) refuses it, and `atlas/asset/issue.php` returns `403 studio-authorization-required` before taking any lease. The Node issuer refuses it at the same points. Studio calls `issue_asset()` directly, only from `inc/studio-mint.php`, after authorization. Admin `reissue` and `admin/class-patch` refuse the class with `403 studio-authorization-required` (a tradeScope or property patch would unbind the item or rewrite what the owner approved; a class patch is applied to every holder at their next wallet check-in, and a patch stored earlier is ignored for this class). Clearing a patch stays allowed. `clawback` re-signs the asset unchanged for a new owner and remains the operator-only recovery path. Owner-signed intents (`asset/transfer`, `transfer-to-email`, `transfer-to-file`, `world/drop`, `trade/submit`) are refused by the bound policy; `redeem` (the owner giving the item up) is allowed. The `inc/` helpers refuse direct web requests (`inc/.htaccess`, plus a guard at the top of each helper and of `lib/*.php`).

## Operator configuration

Minting is on only when `<ATLAS_STUDIO_STORAGE_ROOT>/studio-config.json` exists, is a regular file under 8 KB, and says:

```json
{ "mintEnabled": true, "domain": "host[:port]", "origins": ["https://host"] }
```

`domain` must equal the request's `Host` header exactly and be canonical: lower case, no trailing dot, no leading-zero port (otherwise minting stays off with `domain-mismatch`). Credentials embed the request's host, so differently spelled Host headers must not produce differently spelled issuers or model URLs. `origins` (default `https://<domain>`) are the only page origins whose wallet signatures are accepted; `http` origins are accepted only for localhost.

Optional integer limits: `challengesPerIpPerHour` (30), `mintsPerIpPerHour` (10), `maxMintsPerRecipientPerDay` (3), `maxMintsPerActorPerDay` (10), `maxMintsPerDay` (200), `maxOutstandingChallenges` (500). An "actor" is an IPv4 address or an IPv6 /64; the hourly limits also apply to the enclosing IPv6 /48 at 8 times the per-actor value, so rotating /64s inside one allocation does not multiply the allowance. `maxMintsPerActorPerDay` stops one actor from using up `maxMintsPerDay`. The per-recipient quota counts a key once whichever accepted spelling (raw point or SPKI) it arrives in. Rate-limit counter files expire with their window and are pruned in bounded batches; at 20000 counters, new actors are refused (fail closed) rather than growing the folder.

Optional `webauthnRpIds` (a list of 1 to 4 relying-party ids) pins WebAuthn assertions to those ids by checking the authenticator's `rpIdHash`. It is off by default, and raw-ECDSA identities are not affected.

Replay retention (`ATLAS_REPLAY_TTL_HOURS`, default 168) must be at least 48 hours, which covers the challenge lifetime, the 24-hour challenge retention and the recovery window. A smaller value keeps minting off with `replay-retention-too-short` instead of running with a weaker exactly-once guarantee. Any problem with the file turns minting off.

The storage root must be outside the document root, owned by the PHP account, with `drafts`, `uploads-quarantine`, `mint-receipts`, `tmp` and `rate` subdirectories (see `asset-studio-storage.md`). The issuer's private state directory (`ATLAS_PRIVATE_DIR`) is separate and must be writable too.

The domain manifest must let the Studio page use the bridge. The page links `/.well-known/spatial.json#studio`, so add a policy-only world:

```json
{ "id": "studio", "name": "Asset Studio",
  "policy": { "walletBridge": { "read": true, "sign": ["atlas.studio.mint/1"], "offer": ["atlas.demo.studio.collectible"] } } }
```

The approved model and thumbnail files `trophy`, `badge` and `key` (`.glb`, `.png`) must exist in the docroot `assets/` folder; `tools/make-demo-item-models.js` generates them. If one is missing or is not a glTF/PNG, challenge and mint answer 503 and issue nothing.

## Controlled real-wallet test (local, isolated)

This uses a throwaway issuer with a freshly generated key and empty state. Nothing touches a live domain, production key or real wallet.

1. In Chrome, load the `extension/` folder (Extensions, Developer mode, Load unpacked) and create a wallet identity in the side panel.
2. `node test/studio-local-issuer.js` (optionally a port; default 8788). It prints the Studio page URL, the issuer key URL and the state folders. It needs `php` on the PATH.
3. Open the printed Studio page URL. The wallet line should read "Wallet identity available" and **Mint to Wallet** should enable.
4. Pick a design and press **Mint to Wallet**. The wallet prompt shows the origin, the purpose `atlas.studio.mint/1` and the issuer's summary line. Approve. Then approve the wallet offer prompt.
5. Open the wallet's pending offers. Claim the collectible; the wallet verifies the issuer signature. Check the credential's name, class `atlas.demo.studio.collectible`, trade scope `bound` and owner (your key).
6. Optional negative checks: Deny at the prompt (nothing should appear in the issuer's `replay` folder), and press Mint twice (each press is a separate challenge and yields its own single credential, up to the per-recipient daily limit of 3). Crash and restart behaviour is covered by the automated tests, not by this launcher.
7. Ctrl-C stops the issuer and deletes its folders.

Model URLs in the credential are `https://<host>/assets/...`, like every other catalog class, so a local `http` issuer cannot serve the 3D model to the wallet preview; the credential itself still verifies.

Automated version: `xvfb-run -a node test/manual-studio-wallet-flow.js` drives the real Studio page and extension against a throwaway PHP issuer.

## Tests

- `php test/run-asset-studio.php` runs the PHP unit tests (validation, fingerprint, storage, plan, proof binding with injected time, quota windows, challenge store, multi-process challenge-cap race, rate limits and pruning, replay namespace, key normalisation and approval text) and the integration suite.
- `node test/asset-studio-integration.js [name filter]` starts real PHP issuers with fresh keys and signs with real ECDSA and WebAuthn-style assertions. It covers rejected and forged signatures, other keys, origin and context mismatches, altered designs, hostile JSON types, replay, concurrency, quotas, SIGKILL and fault-injected crashes at every commit step, restart persistence, bypass attempts on the general routes (PHP and Node), the trade catalog and no-leak checks.
- `xvfb-run -a node test/manual-studio-wallet-flow.js` is the real-extension browser test.
- `xvfb-run -a node test/manual-bridge-foreign-manifest.js` checks in a real browser that a page cannot borrow wallet bridge permissions from a manifest on another origin.
- `node test/manual-studio-restricted-parity.js` checks that the Node and PHP issuers both refuse to mint, reissue or patch the Studio class.

## Durability

Every Studio file write is: write to a temporary file in the same directory, `fsync` the file, rename over the target, then `fsync` the directory (`atlas_write_file_atomic()` in `lib/store.php` and `atlas_studio_fsync_dir()` / `atlas_studio_replace_file()` in `inc/storage.php`). A test records the system calls (with `strace`) and checks that order. The challenge and attempt files are replaced the same way, not truncated in place, and crash tests stop the process between writing the temporary file and renaming it.

What this does and does not show. It gives crash-of-the-PHP-process safety, and a reasonable best effort against an operating-system crash on a local POSIX file system. It is not a power-loss guarantee: that also depends on the disk's write cache, the file system's mount options, and any virtualisation or network storage underneath, none of which is tested here. Limits: directory `fsync` needs PHP 8.1 or later (`fsync()` does not exist earlier) and a POSIX platform; on older PHP or on Windows the file and directory flushes are skipped and the rename is still atomic but not known to be durable. The older file-export and claim writers in `lib/store.php` (`write_file_exports`, `write_file_claims`) were not changed.

## Known gaps

- `verify_envelope()` does not check the WebAuthn `rpIdHash` or the `clientDataJSON.origin`. Studio checks the type, user presence and the signed bridge origin, and can pin `rpIdHash` with `webauthnRpIds`. Without the pin any passkey whose signature verifies is accepted, which is fine for a no-value item bound to that key but is an assumption to know about.
- There is no operator reconciliation tool for attempts left `claimed` after a crash that was never retried; they only occupy a quota slot until they age out. Issuer replay records follow the issuer's existing retention.
- Key rotation: a credential names the issuer key that signed it; Studio does nothing special for rotated keys.
- Profanity filtering uses the existing handle-oriented blocklist; it is not a moderation system. Uploads and drafts are not implemented.
- Quotas and rate limits use the connecting address only; behind a proxy, all visitors share one address. Per-actor and IPv6 grouping follow the address PHP sees.
- Durability is as described above; it is not proven against power loss.
- 3D model URLs are `https`; see above.
