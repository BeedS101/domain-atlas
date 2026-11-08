# Clean Package Builder and Independent Verifier: review notes

Branch `feature/clean-verifier-package`, branched from `main` at `2d9a407`. Nothing is deployed or merged. No existing
file was changed except one `.gitignore` line (`dist/`, the builder's default output folder), and no existing installation,
issuer, protocol field or credential is touched. The issuing side is untouched and the licensing issuer is not started.

The dependency map is in `docs/verifier-package-dependency-map.md`.

## What this milestone delivers

One installable package, `atlas-verify`, that answers whether a Domain Atlas credential is genuine and in good standing at
an issuer the operator chose to trust. It has no signing code, no key, no state and no database, makes no request except to
the configured issuer, and installs by uploading a folder and copying one config file: no Terminal, no Composer.

| Path | What it is |
|---|---|
| `verifier-php/` | the verifier source (verify.php, three library files, config template, README, .htaccess files) |
| `packages/atlas-verify/manifest.json` | the explicit, version-locked file list: path, source, mode, SHA-256 and size of every file |
| `tools/package/build-package.js` | builds the ZIP from the manifest; refuses any source that differs from the lock; `--lock` records hashes on purpose, `--check` verifies only |
| `tools/package/check-package.py` | independent checker (shares no code with the builder): re-hashes, parses the ZIP byte by byte, compares both SHA-256 files, rebuilds the archive and requires identical bytes |
| `test/verifier-package.js` | 209 end-to-end checks run against the extracted archive |
| `test/verifier-php/matrix.php` | the verdict matrix (177 checks), also run by the test above |
| `test/verifier-php/audit-tokens.php`, `canonical.php`, `test/lib/package-audit.js`, `test/lib/php-issuer.js` | test support |
| `docs/` | the dependency map and these notes |

Result of the last run: 209 of 209 checks passed. The archive built from this tree is `atlas-verify-0.1.0.zip` (about 47 KB,
11 files); two builds from different directories, time zones and locales are byte-identical, and the Python rebuild matches.

## What the inspection of the three repositories found

- `main` holds everything reusable: the P-256 and base64url primitives in `issuer-php/lib/crypto.php`, the payload shape in
  `issuer-php/lib/bootstrap.php`, the published-document formats in `store.php`, and the browser wallet's reading of them in
  `extension/wallet.js`. The verifier copies the primitives verbatim (a test compares each function body) and reproduces
  the document semantics; the test suite checks the result against credentials produced by the real `issuer-php`.
- `domain-atlas-next` has `experiments/pinned-asset-signature-verifier.js`: signature-only, with trust supplied by server
  setup and strict base64url decoding. Those two rules are adopted. It does not check keys, revocation, suspension or
  expiry, so it could not be used as it stands.
- `domain-atlas-core` is a separate CBOR / chain protocol and contains nothing that verifies `domain-atlas-asset/1.0`.
  Nothing was taken from it, and it was not modified.
- The existing `verify_foreign_*` paths in `issuer-php` and the Node issuer treat an unreadable revocation or suspension list
  as "not revoked". That is reasonable for an issuer that is accepting a presented balance and has its own state; it is not
  acceptable for an independent verifier. The new package fails closed instead. The existing code is unchanged.

## Verification policy

A credential is `verified` only when all of these hold, in this order:

1. The credential names an issuer listed in `config.php` (matched by domain), and, if the operator pinned keys, signs with
   one of them. The `issuer` block of a credential is not part of the signed payload, so trust is bound to configuration
   and never taken from the credential.
2. The issuer publishes the credential's key in `atlas-key.json`, and that key was valid at `issuedAt` (concurrent and
   rotated keys are supported).
3. The 64-byte P-256 signature verifies over the canonical `{id, asset, owner, quantity, supersedes, issuedAt}`.
4. The id is not in `atlas-revocations.json`.
5. It is not suspended in `atlas-suspensions.json`; a suspension whose deadline passed with `onExpire: finalize` is a
   revocation (the "redeemed" case), and one with `lift` is simply over.
6. A signed `asset.expiresAt` has not passed.

Anything that prevents a required check (network error, any HTTP status other than 200, redirect, invalid JSON, wrong shape,
an unreadable entry, an oversize or over-long document, missing openssl) gives `unavailable`, never `verified`. A definite
negative (revoked, suspended, expired) outranks an unreadable document, so the answer is as informative as it can be.
`valid` is true only for `verified`.

## Decisions for approval

1. **Suspension list on a fresh issuer.** The reference issuer creates `atlas-suspensions.json` lazily, so a new issuer
   answers 404 until its first suspension (the test shows this). With the default policy such a credential is `unavailable`,
   not verified. The operator can set `'suspensions' => 'optional'` for an issuer, which treats a 404 on that one document
   (and only that) as "nothing suspended". Recommended: change the issuer, in a separate step, to publish an empty list at
   initialization, and keep the default strict. Until then the future wizard would have to write `optional` for issuers it
   knows publish lazily. Revocation and key documents have no such option.
2. **Canonical JSON.** The issuer's `canonicalize` was adapted (dependency map, section 6.1) so that a credential which verifies
   in the browser wallet also verifies here: empty objects survive, keys sort by UTF-16 code unit, and numbers are written
   with JavaScript's rules. For ordinary credentials the output equals the reference issuer's. For credentials that contain an empty object, a
   supplementary-plane key or an extreme number, `issuer-php` itself signs different bytes than the Node issuer would, and
   the package follows the JavaScript form. Such credentials are not known to exist in the catalog. If you prefer
   byte-for-byte parity with `issuer-php`, that is a small change to `canonicalize`, but then the browser wallet and this verifier would
   disagree on those inputs.
3. **Scope.** Only `domain-atlas-asset/1.0` is verified. Attestation credentials answer `unsupported`. Possession (that the
   presenter holds the owner key) is out of scope; it needs a challenge signed by the owner and would be a separate,
   stateful step.
4. **Public endpoint.** `verify.php` can be called by anyone who can reach it, and each call makes up to three requests to
   the configured issuer. Nothing is cached, by design (revocations must be seen at once), and there is no rate limit in
   the package. Operators who expose it should set `accessTokenSha256` or limit it at the web server. CORS is off unless
   origins are listed.
5. **Versioning.** Changing any packaged file means running `build-package.js --lock` and raising the version; the build and
   the test fail otherwise. The version appears in `VERSION`, `lib/atlas-verify.php` and the manifest, and the builder
   checks that all three agree.

## Known limits and risks

- PHP 7.4 was not run: the sandbox has 8.3 only. The tests check at token level for 8-only syntax and functions, and the
  code avoids them, but the first real 7.4 host is the proof.
- `.htaccess` enforcement was not exercised (PHP's built-in server ignores it). The package also keeps config out of the
  web root's reach by name only: on nginx or a host without `AllowOverride`, `config.php` and `lib/` must be blocked by the
  operator, as the README says. `config.php` holds no secret by itself (issuer origins and an optional token hash), which
  limits the exposure.
- The real HTTPS path is exercised only against the loopback HTTP option; certificate verification is set explicitly
  (peer and host, no redirects, protocol restricted) but was not tested against a live TLS server.
- Time comes from the verifier host's clock, with no skew allowance, for expiry, suspension deadlines and key windows.
  A credential claiming a future `issuedAt` is not rejected for that.
- The verifier checks what the issuer currently publishes. A revocation published after the check is not seen.
- `issuedAt`, `expiresAt` and other timestamps must be RFC 3339; a present but unparseable `expiresAt` makes the credential
  malformed. The existing PHP and Node issuers disagree about that case (one ignores it, one rejects it); strict is the safe choice.

## Follow-ups outside this milestone

- Issuer: publish an empty `atlas-suspensions.json` at initialization (see decision 1).
- Issuer: align `canonicalize` with the JavaScript implementations for empty objects and extreme numbers, or document the envelope.
- Issuer and Node server: make `verify_foreign_*` fail closed, or leave it and state why; separate change.
- The wizard step that installs this package: compare the downloaded archive with its published `.zip.sha256` before
  extracting, compare each extracted file with the hashes in `PACKAGE.json`, write `config.php` from the customer's chosen
  issuer origin, and refuse to continue on any mismatch.

## How to reproduce

```
node test/verifier-package.js                      all 209 checks, under a minute
node tools/package/build-package.js packages/atlas-verify/manifest.json --out dist/packages
python3 -I tools/package/check-package.py packages/atlas-verify/manifest.json dist/packages/atlas-verify-0.1.0.zip
sha256sum -c dist/packages/atlas-verify-0.1.0.zip.sha256
```

Requires Node 18 or newer, Python 3, PHP 8.x with openssl and curl, and `unzip`, `sha256sum`.
