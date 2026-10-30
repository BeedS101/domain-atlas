# Domain Atlas Asset Studio v0.1 (preview only)

This is an **editor preview** intended for isolated testing. **It cannot mint credentials** and must not be described as an issuing or wallet-import integration. Its API deliberately returns HTTP 403 for all requests.

## Run

Serve the repository with a local web server and open `/atlas/studio/` from a PHP deployment whose document root is `issuer-php/`. The editor offers trophy, badge and key design templates, copy/export and a wallet identity-detection check using the existing `window.atlasWallet.getIdentity()` bridge.

The JSON export is **only an unsigned design file**, not a `domain-atlas-asset/1.0` credential.

## Next work

Inspect the existing issuer-specific issuance interface and deploy an authorized, demo-class-only mint route behind explicit issuer policy, rate limits, persistence and ownership binding. Then pass **complete signed credentials** via `window.atlasWallet.offerAsset(credential)`. Ensure the domain's manifest `policy.walletBridge.offer` whitelist includes only the allowed demo asset class. The wallet may queue a pending offer requiring a separate claim; do not claim that an approved offer is already in a wallet.

Do not enable ledger minting, splitting, consolidation, conversion, arbitrary classes or privileged capabilities.

## Tests

`python test/asset-studio-preview-check.py`

Do not deploy to a public live issuer until a proper security review and full end-to-end browser test have passed.
