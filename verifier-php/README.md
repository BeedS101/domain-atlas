# atlas-verify

A stateless verifier for Domain Atlas credentials (`domain-atlas-asset/1.0`). It answers one question: is this credential
genuine, current and in good standing at the issuer you chose to trust? It runs on ordinary PHP hosting. There is no
Composer, no Terminal step and no database.

It cannot issue, sign, revoke or suspend anything. It holds no private key, writes no file, keeps no cache and makes no
request except to the issuer origins listed in `config.php`.

## Install

1. Upload the contents of this folder to a directory on your web server, for example `atlas-verify/`.
2. Copy `config.example.php` to `config.php` and list the issuer origins you trust.
3. Open `verify.php` in a browser. It reports `"configured": true` when the configuration is usable.

Requirements: PHP 7.4 or newer with the `openssl` and `json` extensions, and either `curl` or `allow_url_fopen` for
outbound HTTPS. `.htaccess` files keep `config.php` and `lib/` from being served on Apache; on other servers block those
paths yourself.

## Use

```
POST verify.php
Content-Type: application/json

{"credential": { ...the credential... }}
```

The response is always JSON. HTTP 200 means the check ran; the result is in the body.

```
{
  "valid": true,
  "status": "verified",
  "code": "verified",
  "reason": "...",
  "credentialId": "urn:atlas:asset:...",
  "issuer": {"domain": "issuer.example", "origin": "https://issuer.example"},
  "checks": {"issuerTrusted": "pass", "keyPublished": "pass", "keyValidAtIssuance": "pass",
             "signature": "pass", "revocation": "pass", "suspension": "pass", "expiry": "pass"},
  "checkedAt": "2026-01-01T00:00:00Z",
  "verifier": {"name": "atlas-verify", "version": "0.1.0"}
}
```

`valid` is true only for `status: "verified"`. The other statuses are `invalid`, `revoked`, `suspended`, `expired`,
`unavailable` (a required document could not be read), `untrusted-issuer` and `unsupported`. Treat anything other than
`verified` as a refusal. Other HTTP codes: 400 (no usable JSON body), 401 (access token missing or wrong), 405, 413 (body too large) and 503
(not configured).

## What is checked

1. The credential names an issuer that `config.php` lists, and carries that issuer's public key.
2. The issuer publishes that key at `/.well-known/atlas-key.json`, and it was valid when the credential was issued.
3. The P-256 signature over the canonical payload verifies.
4. The credential is not in `/.well-known/atlas-revocations.json`.
5. It is not suspended in `/.well-known/atlas-suspensions.json` (an expired suspension that finalizes counts as revoked).
6. A signed `asset.expiresAt` has not passed.

## Failing closed

If the key document, the revocation list or the suspension list cannot be fetched or read (network error, HTTP error,
invalid JSON, oversize, unreadable entries) the result is `unavailable`, never `verified`. The one exception is opt-in
per issuer: `'suspensions' => 'optional'` treats HTTP 404 on the suspension list as "nothing suspended", because an
issuer that has never suspended anything may not publish the file yet. Revocation and key documents have no such option.

## Not checked

- That the person presenting the credential owns it. That needs a signature from the owner's key over a challenge and is
  a separate step.
- Attestation credentials. Only `domain-atlas-asset/1.0` is accepted.

## Configuration

See `config.example.php`. `trustedIssuers` is required. The issuer is always chosen from this list by the domain the
credential names; a request cannot add one. `pinnedKeys` optionally restricts an issuer to specific public keys.
`accessTokenSha256` optionally protects the endpoint with a bearer token. `allowedOrigins` enables CORS for named browser
origins only.
