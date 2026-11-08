# Clean Package Builder and Independent Verifier: review notes

Status: merged to `main` as `e0e83b5` (developed on `feature/clean-verifier-package`, branched from `2d9a407`). The merge
changed no existing source file, issuer, protocol field or installation, and the package is not installed on any site. The
`dist/` rule in `.gitignore` described in the first version of this note did not make it into that merge; it, the CI
workflow and the other items in "Hardening follow-up" at the end of this note came afterwards. The issuing side is
untouched by the milestone itself and the licensing issuer is not started.

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
| `test/verifier-package.js` | 217 end-to-end checks run against the extracted archive |
| `test/verifier-php/matrix.php` | the verdict matrix (179 checks), also run by the test above |
| `test/verifier-php/audit-tokens.php`, `canonical.php`, `test/lib/package-audit.js`, `test/lib/php-issuer.js` | test support |
| `docs/` | the dependency map and these notes |

Result of the run at the merge: 209 of 209 checks passed on `atlas-verify-0.1.0.zip` (about 47 KB, 11 files). After the
hardening follow-up the same suite passes 217 of 217 on `atlas-verify-0.1.1.zip`; two builds from different directories, time zones and locales are byte-identical, and the Python rebuild matches.

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

1. **Suspension list on a fresh issuer.** (Resolved in the hardening follow-up: `issuer-php` now publishes an empty list when it
   creates a new issuer; see below. The original finding follows.) The reference issuer created `atlas-suspensions.json` lazily, so a new issuer
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

- Issuer: publish an empty `atlas-suspensions.json` at initialization (done in the hardening follow-up).
- Issuer: align `canonicalize` with the JavaScript implementations for empty objects and extreme numbers, or document the envelope.
- Issuer and Node server: make `verify_foreign_*` fail closed, or leave it and state why; separate change.
- The wizard step that installs this package: compare the downloaded archive with its published `.zip.sha256` before
  extracting, compare each extracted file with the hashes in `PACKAGE.json`, write `config.php` from the customer's chosen
  issuer origin, and refuse to continue on any mismatch.

## How to reproduce

```
node test/verifier-package.js                      all 217 checks, under a minute
node tools/package/build-package.js packages/atlas-verify/manifest.json --out dist/packages
python3 -I tools/package/check-package.py packages/atlas-verify/manifest.json dist/packages/atlas-verify-0.1.1.zip
sha256sum -c dist/packages/atlas-verify-0.1.1.zip.sha256
```

Requires Node 18 or newer, Python 3, PHP 8.x with openssl and curl, and `unzip`, `sha256sum`.

## Hardening follow-up

Done after the independent review of `e0e83b5`, on branch `hardening/verifier-ci-and-docs`. The credential format, the
existing issuer endpoints and asset behaviour, the Core repository and every live site are unchanged; no key was touched.

1. **CI.** `.github/workflows/verifier-package.yml` runs on every push and pull request: the manifest lock check, the build,
   the independent archive check and published checksum, then the verifier package suite, endpoint abuse limits, protocol
   limits, private configuration, the issuer suspension list and the issuer admin status reads. PHP 8.3 and 8.1 block;
   PHP 7.4 is informational until it has been seen green (it has never been run here). No secrets, no deployment, read-only
   token.
2. **Repository hygiene.** `dist/` is ignored and this note no longer describes the work as unmerged.
3. **Empty suspension list for a new issuer** (`issuer-php/lib/store.php`, kept in its own commits). A fresh PHP issuer now
   publishes `{"suspended": []}` when it creates its revocation list, under the same conditions (key being generated, no
   evidence of an established deployment), as a finished file linked into place in one step. It is never rewritten,
   never created for an existing issuer or in the withheld-state case, and written with the revocation list's mode. An
   earlier version of this change also replaced an existing zero-length list with an empty one; that was withdrawn after
   review, because a zero-length file cannot be told apart from a truncated list and replacing it could erase suspensions.
   Existing state is now handled by a separate rule (`docs/gen1-revocation-state.md`, section 8): a missing list is still
   "nothing suspended" (and is no longer created by a read), a zero-length or otherwise unreadable list makes every
   operation that depends on it answer 503 and is left untouched, and the operator restores or re-initialises it
   deliberately. Suspension changes are now written atomically, so the issuer stops producing zero-length lists itself.
   `test/issuer-suspension-list-php.js` (32 checks, including simultaneous first requests, a crash during creation and
   during a write, and eight kinds of unreadable list) covers all of it; `test/manual-gen1-revocation-state.js` (248),
   `test/manual-suspend-php.js` and `test/admin-site-status-php.js` still pass. The verifier default stays strict
   (`suspensions: required`).
4. **Endpoint abuse limits** (`test/verifier-endpoint-abuse.js`, 55 checks; `docs/verifier-endpoint-protection.md`). The test
   measured the cost model (three requests to the issuer for a genuine credential, one for a bad signature, none for
   anything refused earlier) and found one real defect: a 300,000-character revocation reason came back whole in the
   verdict. Verifier 0.1.1 clips reasons to 200 characters, and a verdict that cannot be encoded now gives a 500 with
   `unavailable`. Rate limiting is deliberately not in the package, because it needs writable state; the document sets out
   the layers to use instead.
5. **Protocol limitation** (`test/verifier-protocol-limits.js`, 11 checks; `docs/verifier-protocol-limitations.md`). The
   signature covers `{id, asset, owner, quantity, supersedes, issuedAt}` only. A credential whose `issuer.domain` is edited
   verifies at any domain that publishes the same key, and each domain has its own revocation list. The verifier's
   configuration (domain match, `pinnedKeys`) is the mitigation. No format change was made.
6. **Private configuration** (`test/verifier-private-config.js`, 9 checks; `docs/verifier-private-config.md`). A one-line
   `config.php` stub can return a file kept above the web root. This works with the existing code.

### Compatibility risks

- The verifier changed from 0.1.0 to 0.1.1 (reason clipping, encoding failure, README, lock). 0.1.0 was never installed on a
  site. A clipped reason is the only change in a response a caller could see; verdicts, status codes and codes are the same.
- The issuer now creates one extra file, `.well-known/atlas-suspensions.json`, the first time a new PHP issuer initialises,
  and one lock file, `lib/atlas-suspensions.json.lock`, the first time the list is read or changed. Anything that treated
  the list's absence as meaningful will see an empty list on a new issuer.
- **An existing issuer whose `atlas-suspensions.json` is zero bytes will refuse spends (503) after this change until the
  operator restores or re-initialises it.** Older code created a zero-length file whenever the list was first read, so
  an issuer that has handled a presentation check but never suspended anything may well have one. Check the file's size
  before upgrading (section 8 of `docs/gen1-revocation-state.md` has the procedure); a missing file needs nothing. Before
  this change such an issuer treated the file as empty and published it as an unreadable document, so verifiers already
  answered `unavailable`; the difference is that the issuer's own spend checks now refuse too, instead of assuming
  nothing is suspended.
- The same strictness applies to a list that is truncated or not a list. Previously a suspend or unsuspend on such a file
  replaced it with a one-entry list, erasing what was there; it now refuses and leaves it.
- A deleted list on an issuer installed after this change is indistinguishable from a legacy issuer that never
  suspended anything, so it is still read as empty; there is no marker to tell the two apart.
- `suspensions: optional` remains available and is still the right setting for issuers installed before this change that
  have never suspended anything.
- The CI workflow has not run on GitHub. Its steps were run locally in the same order, on PHP 8.3 only.

### CI compatibility fixes (after the first GitHub Actions run)

The first run passed 211 of 212 checks on PHP 8.3 and 8.1 and 209 of 212 on PHP 7.4. All three failures were in the tests, not
the package; the package files and the archive are unchanged.

- **Temporary-file check.** It looked at the whole system temp directory for recent `php*` files, so files left by the
  runner's PHP setup (`php8.3_extensions`, `php_8.3-nts+ubuntu24.04.tar.zst`) failed it. The verifier's PHP process now gets a
  temp directory of its own (`sys_temp_dir`, `upload_tmp_dir`, `session.save_path`) and the check requires that directory to
  stay empty, with a control showing a file PHP creates there is seen. Files elsewhere in `/tmp` no longer matter.
- **Token audit on PHP 7.4.** PHP 8 returns `\stdClass` as one token; PHP 7.4 returns a backslash token and a name token, so
  `new \stdClass()` looked like a call to `stdClass` and a class called `\`. `audit-tokens.php` now merges qualified names
  into one token before any rule runs, so both versions give the same result, and looks for PHP 8 syntax (`?->`, `match`,
  `enum`, `readonly`, attributes) in the source text as well as by token, because 7.4 has no tokens for them.
  `test/verifier-audit-tokens.js` (26 checks) runs the audit in a mode that rewrites the PHP 8 token stream into the 7.4 one
  and requires identical output for every package file, plus fixtures for each construct. This is a simulation: the PHP 7.4
  CI job is the real proof and has not been seen green yet. The audit is not weaker: qualified calls such as
  `\file_put_contents()` and static calls on unlisted classes were invisible to the old script on PHP 8 and are now caught.
- **No-OpenSSL check.** It used `php -n`, which removes only extensions loaded from `php.ini`. Where OpenSSL is built in the test
  never removed it (it passed only because the stubbed fetch answered 404), and where `json` is a loadable module (PHP 7.4
  packages) it hit a fatal error and still passed on any non-empty output. It now removes the OpenSSL functions with
  `disable_functions`, loads `json`, `filter`, `hash`, `pcre` and `date` when a build needs them as modules, and requires exit 0,
  empty stderr and the structured verdict `unavailable` / `missing-openssl` with no document fetched, plus a control run that
  proceeds to fetch when OpenSSL is present.
- **A flaky case in the verdict matrix.** The "standard alphabet" signature case translated `-` and `_` to `+` and `/`; about one
  signature in sixteen contains neither, so the translation changed nothing and the valid credential verified. It now signs
  again until the signature contains one of them.
- **Timing in the protocol-limits test (second Actions run).** PHP 8.1 failed two checks with `key-not-valid-at-issuance`.
  A key's `validFrom` is the time its issuer first published it, to the second. The test issued the credential at issuer A
  before the cloned issuer B had published its key, so whenever a second boundary fell in between, B's key history began
  after the credential's `issuedAt` and the relabelled copy was refused for that reason instead of showing the limitation.
  The credential is now issued after both issuers have published, and a setup check asserts both key histories cover it.
  The verifier's key-validity check is unchanged. Reproduced before the fix (2 of 15 runs failed; 5 of 5 with a 1.1 s delay
  forced into each setup step); after it 0 of 60 failed, and 0 of 5 with the forced delays.
