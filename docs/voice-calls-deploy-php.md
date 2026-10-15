# Deploying the PHP Call Service on your PHP domains

Status: instructions only. **Nothing here has been run on a real PHP host.** The service was
exercised on Linux over loopback under PHP 8.4's built-in web server, with a test router that
imitates the `.htaccess` rules (`docs/voice-calls-test-plan.md` section 9). It has not run under
Apache, LiteSpeed or nginx, on PHP older than 8.4, behind a CDN, over real TLS, or across a real
network, and the `.htaccess` files in it have never been read by a real web server. Do not
describe the result as production-ready or banking-grade: it has had no independent security
review. Follow these steps only after you have approved a first deployment; nothing in the
repository uploads or changes any live site.

Goal: a Call Service on a domain you already host with PHP, so that two wallets can place an
authenticated, encrypted voice call with no Node process and no third-party calling service.
Audio goes directly between the browsers (WebRTC). Whether two particular networks can reach each
other directly is exactly what the first real test will show; your own STUN and TURN servers are
a separate, later step (`docs/voice-calls-deploy-turn.md`) and are not needed to try.

## 1. What you need

- PHP **7.4 or newer** with `openssl`, `hash` and `json` (and `curl` only if you take revocations
  from a URL instead of a file). The code avoids newer syntax; it has been tested only on 8.4.
- Apache with `mod_rewrite` and `.htaccess` overrides allowed (`AllowOverride All`, or at least
  `FileInfo` and `Limit`). That is the normal cPanel setup, the same as the PHP issuer and presence
  bundles already use. On nginx you must write the equivalent rules yourself (section 7).
- https on the domain with a valid certificate. Wallets refuse plain http.
- The domain's issuer already installed (`issuer-php/`): it provides the membership credentials,
  `/.well-known/atlas-key.json` and `/.well-known/atlas-revocations.json`.
- A place for the state folder that PHP can write, ideally **outside the web root**.
- Accurate server time. Signed requests are accepted within about 30 seconds of the server clock.

Who needs what: **a person who receives calls** needs a Post Office membership from a domain
whose Call Service they use, and that service's address in their wallet. **The caller** needs
neither: a caller uses the callee's service, named in the callee's signed contact card. See
section 6.

## 2. Which files go to which domain

Every domain that runs its own Call Service gets the **same 16 files** and its **own** settings
file. Nothing is shared between domains: each has its own state folder, issuer key and origin.

Upload the contents of `call-php/atlas/call/` so they sit in `atlas/call/` of the domain's
document root, next to the issuer's `atlas/` files (same directory level as `.well-known`):

```
atlas/call/.htaccess              clean URLs: /atlas/call/listen is served by listen.php
atlas/call/info.php               GET  /atlas/call/info
atlas/call/listen.php             POST /atlas/call/listen
atlas/call/invite.php             POST /atlas/call/invite
atlas/call/poll.php               POST /atlas/call/poll
atlas/call/signal.php             POST /atlas/call/signal
atlas/call/ice.php                POST /atlas/call/ice
atlas/call/tag/create.php         POST /atlas/call/tag/create
atlas/call/tag/list.php           POST /atlas/call/tag/list
atlas/call/tag/revoke.php         POST /atlas/call/tag/revoke
atlas/call/lib/.htaccess          refuses every web request to this folder
atlas/call/lib/bootstrap.php
atlas/call/lib/protocol.php
atlas/call/lib/service.php
atlas/call/lib/store.php
atlas/call/lib/config.example.php
```

Then create `atlas/call/lib/config.php` **on the host** (copy `config.example.php`, edit it; section
3). Do not upload your edited file from a repository checkout, and never commit it: the repository
ignores `lib/config.php` and `lib/state/`.

Do **not** upload `call-php/test-router.php` or anything in `call-php/tools/`. They are test and
operator tools, not part of the service.

Nothing else on the domain changes. The issuer, presence, `.well-known` and the manifest are not
touched, and no existing `.htaccess` is edited. If the domain's `atlas/.htaccess` (from the issuer)
already rewrites `/atlas/...` to `.php`, the `.htaccess` inside `atlas/call/` takes precedence for
requests under it; check that after upload with section 5.

For two domains, A and B, repeat the upload for each: A gets its files and A's `config.php`, B gets
the same files and B's `config.php`.

## 3. Write the settings

Copy `lib/config.example.php` to `lib/config.php` and edit it. The file only returns an array, so
fetching it prints nothing, and `lib/.htaccess` refuses the request in any case. Set its permissions
so only your hosting account can read it (`chmod 600`). Until it exists, every route answers
`503 calls-not-configured` and writes nothing.

| Setting | Meaning |
|---|---|
| `origin` | The exact address wallets use: `https://example.com`. Scheme and host, no path, no trailing slash. Every signed message carries it, so changing it later means everyone sets the service up again. Use the name that does not redirect: wallets refuse redirects, and a `www` to non-`www` redirect on POST breaks calls. |
| `domain` | This domain as its issuer writes it in credentials (`issuer.domain`), for example `example.com`. |
| `issuerKeys` | The issuer's public key from `https://example.com/.well-known/atlas-key.json` (the raw 87-character `publicKey`). Only these keys admit anyone. List two during a key rotation. The service never fetches keys from a manifest or a request. |
| `revocationsFile` | Full file path (starting with `/`) to the issuer's `.well-known/atlas-revocations.json` on this same account. Read on every request that needs it; if it cannot be read, tag creation fails closed (`503 revocations-unavailable`). A URL here is refused; put a URL in `revocationsUrl` (https) instead, if the issuer is elsewhere. In cPanel File Manager the full path of a file is shown above the file list, for example `/home/youraccount/public_html/.well-known/atlas-revocations.json`. With neither, revoked memberships are **not** checked. |
| `stateDir` | A full path starting with `/`; a relative path is refused, because PHP would resolve it against each script's own folder and split the state between routes. Where the service keeps its small files. Prefer a folder outside the web root that only your account can write. The default is `lib/state/`, protected by `.htaccess`, `index.html` and 0600 file permissions, but a folder outside the web root does not depend on those. |
| `stunUrls`, `turnUrls`, `turnSecretFile` | Your own STUN and TURN servers, if any. Third-party public STUN and TURN services are refused. Leave empty for direct connections only. The TURN secret is better in a `chmod 600` file than in `config.php`. |
| `trustProxy`, `proxyAddrs` | Only behind a reverse proxy or CDN you control. Without them the service uses the connecting address and checks that the request arrived over https. |
| `inviteCorsOrigins` | Web pages (exact https origins) allowed to send invitations from a browser. Normally empty. |
| `logRefusals` | Troubleshooting only. `true` records the reason an invitation was refused in `refusals.log` in the state folder and in PHP's error log (section 5.1). Callers still get the same uniform reply. Turn it off again afterwards. |
| `limits`, `timers`, `poll` | Optional tuning, validated on load. Out-of-range values leave the service unconfigured and name the setting in PHP's error log. |

If `config.php` has a mistake, the service answers `calls-not-configured` and writes the first
problem to PHP's error log (`[atlas-call] not configured: ...`). From a terminal on the host,
`php call-php/tools/check-config.php /full/path/to/config.php` (from a checkout of the repository)
prints `OK` or the first problem and whether the state folder is writable.

Create the state folder and give it to your account only (for example `mkdir` then `chmod 700`).
The service creates and deletes the files inside it; it removes expired entries as it runs.

## 4. How it behaves on shared hosting

- **Short polling.** The service holds no connection. A listening wallet asks again about every 3
  seconds while nothing is happening, about every 1.2 seconds while a call rings, about 0.6 seconds
  during set-up and about every 2.5 seconds during a call. The service tells the wallet how long to
  wait (`nextPollMs`). A call therefore starts a few seconds after the callee answers rather than
  at once. Tune with `'poll' => ['listenIdleMs' => 5000]`; if you raise it, also keep
  `timers.listenerFreshMs` at least twice as large (default 20000).
- **Request budget.** One wallet that stays Available makes about 1,200 requests an hour (28,800 a
  day) at the default. Each is a short PHP run. If your plan limits requests or CPU, raise
  `listenIdleMs`, and tell people to use Do Not Disturb when they are away. This is the real
  capacity limit of a shared host; it has not been measured on any real plan.
- **One lock.** All state changes happen under one `flock` on a file in the state folder. Each
  request holds it for a few milliseconds. A request that cannot get it within `timers.lockWaitMs`
  (default 3000) answers `503 busy` and changes nothing; it never proceeds without the lock. File
  locking is unreliable on some network file systems; keep the state folder on the account's local disk.
- **Time limits.** There is no background process. Ring, offer, answer and confirm timers and
  call retention are applied when the next request touches the call, and a cleanup pass runs inside
  requests every few seconds. The wallets enforce their own timers too, so a missing pass delays
  cleanup but does not extend a call.
- **Size.** The service keeps at most `maxLiveCalls`, `maxListeners`, `maxNonces`, `maxTagsTotal`
  (defaults 200, 5,000, 100,000, 20,000) and refuses with a plain error beyond them. Memory per
  request is small; the files are JSON and are not loaded wholesale.
- **Errors.** `display_errors` should be off on a production site (the service also turns it off
  and returns a JSON `500` with no paths). Details go to PHP's error log.

## 5. Check it from outside

From any computer with Node.js 20 or newer and a checkout of this repository:

```
node call-server/check-deployment.js https://example.com
```

It sends a few ordinary requests and one signed listen made with a throwaway key. It creates no tag,
needs no membership, and leaves nothing behind but a listening slot that expires. For the PHP
service it checks that: `info` answers and names exactly this origin; the service is configured;
cross-origin pages are refused; a non-JSON body gets `415` and an oversized one `413`; a listen is
answered at once with a polling interval; the same signed request sent twice is refused as a
replay; and **none of `lib/config.php`, `lib/*.php` or `lib/state/...` can be fetched**. A `FAIL`
on the last line means the host is not applying `lib/.htaccess`: fix that before going further,
because `lib/state/` and `config.php` must never be reachable.

`https://example.com/atlas/call/info` in a browser shows `"configured": true` and `"ready": true`
when the settings are accepted and the state folder is writable.

### 5.1 When every call is refused as "unavailable"

The service gives the same `404 unavailable` for every kind of refusal, so a caller cannot probe
which tags or listeners exist. To find the reason on your own host, add `'logRefusals' => true` to
`lib/config.php`, make one call attempt, and read PHP's error log (cPanel: Errors, or the
`error_log` file next to the scripts). Each refused invitation writes one line such as
`[atlas-call] invite refused: callee-not-listening (listener last seen 41000 ms ago, allowed 20000)`.
The line never contains a tag, key or address. Reasons: `no-such-tag`,
`tag-not-bound-to-this-caller`, `callee-key-differs-from-tag`, `tag-expired`, `tag-used-up`,
`invite-already-expired`, `invite-issued-in-the-future` (clocks differ by more than 30 s),
`call-id-already-seen`, `another-call-is-ringing-on-this-tag`, `callee-not-listening`,
`service-at-live-call-limit`, `callee-rate-limited`. Set it back to off when you are done.

## 6. Two domains calling each other

Each domain runs its own service with its own issuer key. A call always runs through the
**callee's** service:

1. Bob (member of domain B) turns on calling. His wallet creates a tag on **B's** service, bound to
   Alice's key, and sends Alice a signed contact card naming B's service.
2. Alice (member of domain A, with no membership on B) calls Bob. Her wallet invites through the
   service in Bob's card. Alice is authorised by Bob's tag and her own signature, not by B's
   membership list.
3. In the other direction the same happens through A's service.

Nothing about membership is relaxed for this: a membership credential from A does not create a tag
on B or the reverse, a message addressed to one service is refused (`wrong-audience`) when sent to
the other, a tag from one service is unknown on the other, and revoking a credential at A does not
affect B. This is tested at the protocol level for every pairing of the PHP and Node services
(`test/manual-call-php-cross.js`) and with two real browser wallets listening on different services
(`test/manual-call-php-e2e-cross.js`). A domain that has no Call Service of its own can still have
its members call people who do, but cannot receive calls (no service to listen on).

Each wallet sets its own service address (Calls tab). A wallet can use a PHP service, a Node
service, or change between them; the wire format is identical.

## 7. nginx and other servers

The bundle assumes Apache. On another server you must provide, in its configuration:

- the rewrite of `/atlas/call/<route>` (and `/atlas/call/tag/<route>`) to the matching `.php` file;
- a **deny** for everything under `/atlas/call/lib/` (the settings file, the code and the default
  state folder) and for every file in the state folder if you keep it under the web root;
- POST requests with JSON bodies of up to 20 KB passed through (the service itself refuses larger ones with `413`).

Then run section 5's checker, which fails if `lib/` is reachable. Without a working deny rule, put
`stateDir` outside the web root and `config.php`'s secrets in files outside it as well.

## 8. Upgrading and operating

- To upgrade, upload the 16 shipped files again over the old ones. Keep `lib/config.php` and the
  state folder. The state files are plain JSON; a format change would be called out in the release notes.
- To stop the service without deleting anything, remove or rename `lib/config.php`: every route
  answers `calls-not-configured` and nothing else changes.
- To clear all call state, stop the service and delete the contents of the state folder; people
  recreate their tags by turning calling off and on.
- Emergency: revoke a person's membership in the issuer (the service reads the revocation file on
  every tag creation); to revoke one tag, the callee's wallet does it; to refuse everyone, remove
  `config.php`.
- Keep the state folder out of backups you share, and out of version control. It holds only hashes
  of routing tags and wallet keys, short-lived call records and signed messages in transit; it never
  holds audio, a private key, or a membership credential. A TURN secret, if you use one, lives in
  `config.php` or the file you name and must be treated as a password.

## 9. Differences from the Node service

Same signed messages, same state machine, same limits on payloads and counts, same refusal replies
(including the uniform `404 unavailable`). The differences are:

| Topic | Node | PHP |
|---|---|---|
| Waiting for events | long poll, held up to 25 s | short poll; the answer says when to ask again |
| Request records and rate counters | in memory | files, rewritten under the one lock; counts are exact to one second |
| Connection, in-flight and waiter limits | yes | none: PHP has no persistent connection to count |
| Request-record capacity | exact | approximate (per-minute buckets, bounded per bucket) |
| Invalid text | tolerated in some positions | stricter: lone surrogates, invalid UTF-8, trailing bytes in encoded keys are refused |
| Credential with an unparseable expiry | accepted as no expiry | refused (fails closed) |
| Revocation source | URL | file on the same account (read each time) or URL (cached) |

`test/manual-call-php-protocol.js` compares the two implementations on thousands of generated and
mutated signed messages; every accepted message is accepted by both with the same result, and the
only disagreements are the "stricter" rows above.

## 10. Not verified yet

- Apache, LiteSpeed or nginx behaviour: the `.htaccess` rewrite and deny rules were only imitated by
  a test router. `check-deployment.js` is how you learn this on the real host.
- PHP older than 8.4 (the code is written for 7.4).
- Real TLS, a CDN or reverse proxy in front, a real shared plan's request, CPU and process limits,
  file locking on that host's disk, and behaviour under real load.
- Real microphones, real NATs, two different networks, and whether direct connections succeed
  between them (the first real test). Calls that need a relay need your own TURN server.
- Two PHP domains with real issuers and real certificates.
- Any independent security review.
