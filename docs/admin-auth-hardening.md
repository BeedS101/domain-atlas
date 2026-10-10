# Administrator authentication hardening

This describes the changes to administrator authentication in the Node issuer
(`issuer-server/server.js`) and the PHP issuer (`issuer-php/`), what breaks for
existing clients, and how to deploy it. It covers only what the code and the
tests in `test/manual-admin-hardening*.js` establish; limits are listed at the
end.

## What changed

1. **The roster is checked on every request.** A session token is no longer
   trusted for its lifetime. Each use looks the session's key up in
   `atlas-admin-keys-store.json` again; if the key is gone or marked
   `"revoked": true`, the request is refused (`401 not-admin`) and every
   session belonging to that key is deleted. Restoring the key later does not
   bring the old sessions back.
2. **Sessions have an absolute lifetime.** Besides the 30-minute idle expiry
   (which still slides forward on use), a session ends `ATLAS_ADMIN_SESSION_MAX_MS`
   (default 8 hours) after it was created, however active it is.
3. **Signed administrator requests are bound and single use.** Every request
   authenticated by a signature (instead of a session token) must carry
   `payload.adminAuth`:

   ```json
   { "action": "/atlas/revoke", "domain": "example.com",
     "issuedAt": "2026-10-10T09:00:00.000Z", "nonce": "<16-128 characters>" }
   ```

   - `action` must equal the route path being called.
   - `domain` must equal the domain the server serves (see Deployment, step 5).
   - `issuedAt` must be within `ATLAS_ADMIN_REQUEST_WINDOW_MS` (default 2
     minutes) of the server clock, in either direction.
   - `nonce` is spent when the request is accepted. Reusing it, from the same
     key, is refused (`401 replayed-request`). The spend happens only after the
     signature and roster checks pass, and the check-and-record is one atomic
     step (synchronous in Node, under an exclusive file lock in PHP).
   - The whole payload, `adminAuth` included, is what gets signed.

   This applies to every route that takes a signature: `/atlas/asset/mint`,
   `/atlas/asset/reissue`, `/atlas/asset/fulfill`, `/atlas/revoke`,
   `/atlas/suspend`, `/atlas/unsuspend`, `/atlas/clawback`, `/atlas/calendar`
   (POST), `/atlas/mail/send`, `/atlas/demo/reserve/consortium/co-sign`, and
   `/atlas/admin/{directory,asset-classes,visits,class-patch,class-patches,send-ticket-to-email}`,
   `/atlas/admin/trusted-trade-peers/`, `.../add`, `.../remove`,
   `/atlas/admin/email-tickets/poll-now`.
4. **Login is bound too.** `POST /atlas/admin/session/start` takes
   `{payload: {nonce, adminAuth: {action: "/atlas/admin/session/start", domain}}, proof}`.
   The server-issued `nonce` is still single use.
5. **Passkeys.** Signed admin requests and logins use the same assertion check
   as the authenticated mailbox reads: a WebAuthn assertion is accepted only if
   it is a `webauthn.get` with the user-present flag set; raw ECDSA is unchanged.
   A passkey on the roster must therefore sign with user presence, which every
   browser prompt does.
6. **Request size limits.** Admin routes accept at most
   `ATLAS_ADMIN_MAX_BODY_BYTES` (default 256 KiB); the session routes at most
   16 KiB; every other JSON route at most 2 MiB. Larger bodies get `413`. A body
   that is not a JSON object gets `400`.
7. **Bounded login nonces.** At most `ATLAS_ADMIN_NONCE_CAP` (default 200)
   unexpired login nonces exist at once (`503 busy` beyond that), and one client
   may request at most `ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN` (default 10) a
   minute (`429`).
8. **Failure throttling.** A client that fails authentication
   `ATLAS_ADMIN_FAIL_LIMIT` (default 10) times within `ATLAS_ADMIN_FAIL_WINDOW_MS`
   (default 5 minutes) gets `429` with a `Retry-After` header on further
   signature logins/requests and on bad tokens. A valid session keeps working
   while the client is throttled. Only failures count: a bad signature, a key
   not on the roster, a replayed request, a bad login nonce, a bad token.
9. Admin error responses now include a machine-readable `code`
   (`auth-required`, `bad-request`, `wrong-domain`, `stale-request` with
   `serverTime`, `bad-signature`, `not-admin`, `replayed-request`, `bad-nonce`,
   `session-invalid`, `rate-limited`, `busy`, `too-large`). The `error` text is
   still present.

## Roles

Roster entries may now carry a `role` (`admin`, the default, or `moderator`).
A moderator can log in but is refused (`403 insufficient-role`) by every route
above; only the moderation grant route accepts it. See
`docs/moderation-authorization.md`.

## Incompatible changes

| Change | Who is affected |
| --- | --- |
| Signed admin requests without `payload.adminAuth` are refused (`401 auth-required`). | Anything that signs admin calls itself: `tools/admin-*.js`, scripts, cron jobs. |
| `/atlas/admin/session/start` requires `adminAuth` in the signed login payload. | `extension/wallet.js` (updated). Older wallets cannot log in to an upgraded server. |
| All existing sessions stop working (they carry no absolute expiry). | Every admin signs in once more after the upgrade. |
| A saved, reusable signed request no longer works. | The `tools/admin-poll-now-sign.js` + `curl` cron recipe. Use `tools/admin-poll-now-sign.js --post https://your-domain` instead. It signs a fresh request on each run, so the cron host needs Node and `tools/.admin-identity.json` (an admin private key). |
| `/atlas/admin/session/start` responds with `absoluteExpiresAt` as well. | Additive. |
| New statuses `413`, `429`, `503` and the `code` field on admin errors. | Additive; clients that only read `error` are unaffected. |
| Passkey assertions must be `webauthn.get` with user presence. | Only identities whose assertions lack the flag, which browsers do not produce for a prompted get. |

Old wallets keep working against old servers, and the new wallet's login payload
carries an extra field that old servers ignore, so the wallet can be updated
first.

## Deployment

1. Update clients first: the browser extension (`extension/wallet.js`), and
   copy the new `tools/` (including `tools/lib/admin-auth.js`) to anywhere you
   run the admin tools from.
2. Replace any cron job that posts a saved poll-now body with the `--post`
   form above, or accept that inbound email-ticket polling stops until you do.
3. Node: replace `issuer-server/server.js` and restart. New state files appear
   in the state directory: `atlas-admin-proof-nonces-store.json`.
4. PHP: upload `lib/store.php`, `lib/bootstrap.php`, and the files under `atlas/`
   listed in the change summary (full paths from the bundle root). New state
   files appear in `lib/`: `atlas-admin-proof-nonces-store.json` and
   `atlas-admin-ratelimit-store.json`. `lib/` is already denied to web
   requests by its `.htaccess`; confirm that on your host.
5. Set `ATLAS_DOMAIN` (Node) explicitly. On PHP the domain is taken from the
   `Host` header unless `$forced` is set in `atlas_domain()` (`lib/store.php`);
   set it to your domain.
6. Ask each admin to sign in again.
7. Optional tuning is by environment variable (all optional): `ATLAS_ADMIN_SESSION_MAX_MS`,
   `ATLAS_ADMIN_REQUEST_WINDOW_MS`, `ATLAS_ADMIN_NONCE_CAP`,
   `ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN`, `ATLAS_ADMIN_FAIL_LIMIT`,
   `ATLAS_ADMIN_FAIL_WINDOW_MS`, `ATLAS_ADMIN_MAX_BODY_BYTES`. On shared PHP
   hosting where you cannot set environment variables, the defaults apply.

Rolling back is replacing the files again; sessions and the new state files are
ignored by the old code.

## Limits

- **Domain binding on PHP follows the `Host` header** unless `atlas_domain()` is
  forced. A request signed for one name the server answers to is accepted on
  that name only, but a server answering on many names accepts any of them.
- **Rate limiting uses the socket address** (`REMOTE_ADDR` / `socket.remoteAddress`)
  and never forwarded-for headers, which a client controls. Behind a reverse proxy
  or CDN every client shares the proxy's address and so one budget: one abusive
  client can throttle signature logins for everyone behind the same proxy.
  Valid sessions are unaffected. If you terminate TLS in front of the server, put
  the limit in front as well.
- **Node's rate-limit counters are in memory** and reset on restart. The PHP
  counters are in a file.
- **Nonce memory is bounded.** If 20,000 unexpired signed-request nonces
  accumulate (several times the rate a legitimate operator produces) further
  signed requests get `503 busy` until old ones age out (about 4.5 minutes).
  Session-token requests are not affected. Because nonces are recorded only after
  a valid admin signature, only an admin key holder can fill it.
- **Session tokens are still stored in plaintext** in the sessions state file.
  Anyone who can read that file can use the tokens in it until they expire.
- **Clock skew:** a signing client whose clock differs from the server's by more
  than the window is refused with `stale-request` and `serverTime`; the clients
  here do not yet retry using it.
- **Passkey tests use a software ES256 key,** not a browser or authenticator.
  They show the server accepts and refuses the right assertion shapes; they do
  not exercise a real authenticator, and, as before, the relying-party ID hash
  and origin inside an assertion are not checked.
- **The 2 MiB default body limit** now also applies to non-admin JSON routes on
  both servers. No route in the test suite needs more.
- Not changed: how a key gets onto the roster (hand-edited file), the
  unauthenticated demo routes, mailbox authentication (SPEC.md §11.8), and
  plaintext storage of the roster.
