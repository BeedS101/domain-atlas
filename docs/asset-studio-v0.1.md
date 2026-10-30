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

Studio does not keep a second ledger. A mint is one transaction in the issuer's existing journal and replay store (`lib/replacement.php`), under the request id `studio-mint-<nonce>`:

- Requests for one nonce are serialized by the request-id lease.
- The credential is signed in memory, then committed by writing the transaction journal entry (the commit point), then the replay record is stored and the journal entry removed.
- A credential exists exactly when a journal entry or replay record exists. A crash before the journal write leaves no trace and a retry signs a fresh credential; a crash after it is completed by any retry (or by `atlas_txn_sweep()`), which returns the stored response byte for byte.
- The attempt ledger (`mint-receipts`) only enforces quotas and records the outcome; the challenge file only records `issued` / `completed`. Neither decides whether a credential exists, so a crash between them and the commit is repaired by the next retry. A retry of an existing nonce is never counted twice.
- Studio-class credentials are non-fungible, so there is no holdings or supply state to keep consistent.

## Closing the other issuance routes

The catalog entry sets `restrictedIssuance: 'studio'`. `mint_asset_by_class()` (the shared choke point used by issue, mint, purchase, mail gifts, ticket sending, split, consolidate and convert) refuses it, and `atlas/asset/issue.php` returns `403 studio-authorization-required` before taking any lease. The Node issuer refuses it at the same points. Studio calls `issue_asset()` directly, only from `inc/studio-mint.php`, after authorization. Admin `reissue` and `clawback` copy an existing credential and remain operator-only.

## Operator configuration

Minting is on only when `<ATLAS_STUDIO_STORAGE_ROOT>/studio-config.json` exists, is a regular file under 8 KB, and says:

```json
{ "mintEnabled": true, "domain": "host[:port]", "origins": ["https://host"] }
```

`domain` must equal the request's host. `origins` (default `https://<domain>`) are the only page origins whose wallet signatures are accepted; `http` origins are accepted only for localhost. Optional integer limits: `challengesPerIpPerHour` (30), `mintsPerIpPerHour` (10), `maxMintsPerRecipientPerDay` (3), `maxMintsPerDay` (200), `maxOutstandingChallenges` (500). Any problem with the file turns minting off.

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

- `php test/run-asset-studio.php` runs the PHP unit tests (validation, fingerprint, storage, plan, proof binding with injected time, quota windows and challenge store) and the integration suite.
- `node test/asset-studio-integration.js [name filter]` starts real PHP issuers with fresh keys and signs with real ECDSA and WebAuthn-style assertions. It covers rejected and forged signatures, other keys, origin and context mismatches, altered designs, hostile JSON types, replay, concurrency, quotas, SIGKILL and fault-injected crashes at every commit step, restart persistence, bypass attempts on the general routes (PHP and Node), the trade catalog and no-leak checks.
- `xvfb-run -a node test/manual-studio-wallet-flow.js` is the real-extension browser test.

## Known gaps

- `verify_envelope()` does not check the WebAuthn `rpIdHash` or the `clientDataJSON.origin`; Studio checks the type, user presence and the signed bridge origin only.
- The outstanding-challenge cap counts files without a lock, so a burst can overshoot it slightly. Challenge and attempt files are pruned on use (24 hours / 30 days).
- There is no operator reconciliation tool for attempts left `claimed` after a crash that was never retried; they only occupy a quota slot until they age out. Issuer replay records follow the issuer's existing retention.
- Key rotation: a credential names the issuer key that signed it; Studio does nothing special for rotated keys.
- Admin `reissue` can edit properties of an existing credential, including the `atlas.studio.*` ones; that is an existing operator capability.
- Profanity filtering uses the existing handle-oriented blocklist; it is not a moderation system. Uploads and drafts are not implemented.
- Quotas and rate limits use the connecting address only; behind a proxy, all visitors share one address.
- 3D model URLs are `https`; see above.
