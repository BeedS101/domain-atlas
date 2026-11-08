# Protecting the verifier endpoint

`verify.php` is a public endpoint unless the operator restricts it. This note states what the package itself limits, what it
deliberately does not, and the layers an operator should add. The behaviour described in "What the package limits" is
pinned by `node test/verifier-endpoint-abuse.js` (55 checks, run from the built archive against a throw-away issuer).

## What a request costs

The verifier keeps no state and no cache, so every request is independent and every cost is paid again on the next one.
The cost is mostly requests made to the trusted issuer, not work on the verifier host.

| Request | Requests to the issuer | Notes |
|---|---|---|
| Genuine credential | 3 | key document, revocation list, suspension list |
| Credential whose signature fails | 1 | the key document only |
| Credential naming an issuer that is not listed | 0 | refused from configuration |
| Malformed JSON, wrong shape, wrong type label, oversize body | 0 | refused before anything is fetched |
| Missing or wrong access token | 0 | answered before the body is read |
| GET, HEAD, OPTIONS, other methods | 0 | |

Forging a credential that costs the issuer three requests needs a valid signature from a key the issuer publishes, which
an outsider does not have. An outsider can replay a genuine credential, though, and each replay costs the issuer three
small requests. The published documents are static files, so for most hosts this is cheap; it matters when the issuer is a
metered or rate-limited host, or when the revocation list is large (up to 4 MiB per fetch).

## What the package limits

- The body is capped at `maxBodyBytes` (default 256 KiB, hard maximum 1 MiB). A larger declared length is answered 413
  without reading it. A chunked body without a length is refused.
- Each upstream fetch has a 5 s connect and 10 s total timeout and a size cap while streaming (key document 256 KiB,
  revocation and suspension lists 4 MiB and 20,000 entries). An endless or very slow upstream answer is cut off and gives
  `unavailable`.
- Only configured issuers are ever contacted; neither the credential nor the request can name a host.
- A revocation reason is clipped to 200 characters in the verdict, so a hostile or broken issuer cannot make the verifier
  return megabytes (added in 0.1.1; before that a 300,000-character reason came back in full).
- `accessTokenSha256` turns the endpoint into a bearer-token endpoint. The token is compared in constant time, a malformed
  setting locks everyone out instead of opening the endpoint, and neither the token nor its hash appears in a response.
- CORS is off unless `allowedOrigins` names origins; a preflight from an unlisted origin gets no grant.
- The verdict is always JSON; an encoding failure gives a 500 with `unavailable`, never a blank or partial body.

## What the package does not do

There is no rate limit, no counter, no IP tracking and no cache. This is on purpose: a counter needs writable state, and
the package is designed to write nothing and to run from a read-only folder. A cache would delay a revocation. Rate
limiting belongs to the layer in front of PHP, where it is cheaper and cannot be bypassed by a slow script.

A request is still handled by PHP before it is refused, so a flood of requests costs the host a PHP worker for each one
even when the issuer is not contacted. The test exercises 40 concurrent forged requests and shows they are all refused;
it does not measure host load, and the limits below are not a substitute for a capacity check on the real host.

## Recommended approach

Pick the layers that fit the host. They are listed from most to least effective, and they combine.

1. **Do not expose it if it is not needed.** If only the operator's own server calls the verifier, put it behind that
   server: restrict by IP or run it on an internal path, and set `accessTokenSha256`.
2. **Access token for known callers.** Generate a long random token, store only its SHA-256 in `config.php`
   (`hash('sha256', $token)`), and send `Authorization: Bearer <token>` from the calling server. Keep the token on the
   server side: a token shipped in browser JavaScript is public. Rotate it by changing the hash.
3. **Rate limit at the web server or CDN** when the endpoint must be public. Typical settings: a per-IP request rate on
   the `verify.php` path (for example a few requests per second with a small burst), a cap on concurrent connections per
   IP, a body size limit at or below `maxBodyBytes`, and a request timeout. On Apache use `mod_evasive`, `mod_security` or
   the host's firewall rules; on nginx `limit_req` and `limit_conn`; on cPanel hosting, the host's ModSecurity or CDN
   rules, or Cloudflare rate limiting rules on the exact path. Cloudflare-style limits apply before PHP runs.
4. **Lower `maxBodyBytes`.** A genuine credential is under a kilobyte (about 860 bytes from the reference issuer). `16384` is ample for ordinary credentials and cuts the
   largest request a caller can make by a factor of sixteen. Raise it only if real credentials need it.
5. **Trust few issuers.** Each listed issuer is an upstream the endpoint can be made to contact. List only those the
   customer chose, and pin their keys when the key is known (`pinnedKeys`).
6. **Watch the upstream.** If the issuer is the same host as the verifier, a flood hits it twice. Prefer a separate path
   limit for `/.well-known/` on the issuer; those are static files and cache well on the issuer side (the verifier never
   caches, but the issuer's own CDN may, subject to the revocation-delay trade-off).

## Decisions left to the operator

- Whether a short cache at the verifier is acceptable. It would cut issuer traffic for repeated credentials, but a
  revocation would take as long as the cache time to be seen. The package has none; adding one needs writable state and a
  decision about that delay.
- Whether the endpoint should be public at all. Verification of a credential is not secret, but the cost of it is the
  operator's and the issuer's.

## Not covered

Possession of the credential is not checked (see `docs/verifier-protocol-limitations.md`), so anyone holding a copy of a
credential's text can have it verified. A leaked or copied credential is not made harmless by endpoint protection.
