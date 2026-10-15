# Call Service

A small zero-dependency Node HTTP service that carries **signed** call signalling
between two Domain Atlas wallets. It is not deployed anywhere, is not a banking-grade
or reviewed component, and has been run only on loopback. Design and threat model:
`docs/voice-calls-architecture.md`, `docs/voice-calls-endpoints-and-state.md`,
`docs/voice-calls-threat-model.md`.

What it does: admits wallets that hold a Post Office membership from one configured
domain to create revocable, caller-bound routing tags; checks signatures, freshness,
nonces and message order; holds short-lived call state; relays signed messages
(invite, accept, offer, answer, candidates, confirm, end) by HTTP long-poll.

What it does not do: it never sees or relays audio, never records, never decides who
is who (wallets verify each other's signatures themselves), never fetches anything
from a name a caller supplies, never opens a port or writes a file you did not ask
for, and keeps no identity in its log (only coarse start-up lines).

## Run

```
node call-server/server.js
```

With no configuration it answers `503 calls-not-configured` on every route except
`GET /atlas/call/info`, listens on `127.0.0.1:8787` and creates no file.

## Settings

Environment variables, or a JSON file named by `CALL_CONFIG_FILE` whose keys are the
same names without `CALL_`, camel-cased (`issuerKeys`, `stateFile`, ...).

| Variable | Meaning |
|---|---|
| `CALL_ORIGIN` | The origin wallets use for this service, e.g. `https://calls.example.com`. Every signed message carries it as `audience`. A bare origin, no path. `https` unless `CALL_DEV_ALLOW_HTTP=1`. |
| `CALL_DOMAIN` | The domain whose Post Office memberships admit people to create tags. |
| `CALL_ISSUER_KEYS` | Comma separated public key(s) of that domain: the `publicKey` values in its `/.well-known/atlas-key.json`, copied by you. Pinned; never fetched from a request. |
| `CALL_REVOCATIONS_URL` | Optional. That domain's revocation list. If set and unreadable, tag creation fails closed. |
| `CALL_STATE_FILE` | Optional. Path of the tag store (hashes of tags only, mode 0600, atomic writes). Without it tags are lost on restart. |
| `CALL_STUN_URLS` | Optional, comma separated `stun:host[:port]` URLs of a STUN server **you operate**, at most three, handed to wallets after a call is accepted. Public third-party STUN servers (Google, Cloudflare, Twilio, Mozilla and similar) are refused. Empty: direct connections only. |
| `CALL_TURN_URLS` | Optional, comma separated `turn:` / `turns:` URLs of a TURN server **you operate** (coturn), at most four, ports 80, 443, 3478 or 5349. Needs a secret. With both set, each side of an accepted call may fetch a short-lived credential for them. Unset: no TURN, no credential. Setting up coturn: `docs/voice-calls-deploy-turn.md`. |
| `CALL_TURN_SECRET`, `CALL_TURN_SECRET_FILE` | The secret shared with coturn (`static-auth-secret`), 32 to 256 printable characters, for example `openssl rand -hex 32`. Prefer the file form (mode 600, for example a systemd credential); a file readable by group or others is refused. Never logged, never in `info`, never in any answer, never in the state file. |
| `CALL_TURN_TTL_SECONDS` | Lifetime of a TURN credential, 60 to 86400, default 3600, never beyond the call's own maximum. A relayed call lasts about this long. |
| `CALL_BIND`, `CALL_PORT` | Listen address (default `127.0.0.1`) and port (default `8787`). A non-loopback bind is your decision and needs your own firewall rule; the service opens nothing. |
| `CALL_TRUST_PROXY=1` | A reverse proxy is in front. The client address is then the last `X-Forwarded-For` entry, honoured only when the connection comes from a `CALL_PROXY_ADDRS` address, and with an https origin every request must carry `X-Forwarded-Proto: https`. |
| `CALL_PROXY_ADDRS` | Optional, comma separated addresses the proxy connects from. Default `127.0.0.1,::1`. |
| `CALL_INVITE_CORS_ORIGINS` | Optional, comma separated exact https origins allowed to call `POST /atlas/call/invite` from a web page. Default none: no cross-origin access at all. No wildcard. |
| `CALL_LIMIT_<NAME>` | Optional connection and long-poll limits, for example `CALL_LIMIT_MAX_WAITERS_PER_SOURCE=20`; also the `limits` object of the settings file. Names, defaults and ranges: `docs/voice-calls-deploy-node.md` section 10. |
| `CALL_DEV_ALLOW_HTTP=1` | Accept an `http` origin. Private test networks only. |
| `CALL_DEV_ALLOW_PRIVATE_FETCH=1` | Let the revocation fetch use a loopback or private host. Test networks only. |

A misconfiguration (bad origin, malformed key, missing domain) leaves the service
unconfigured and says which setting on the console.

Running it on the internet: `docs/voice-calls-deploy-node.md` is the step-by-step guide
(settings, systemd, https reverse proxy, checking it, testing with two wallets, optional STUN),
`docs/voice-calls-deploy-turn.md` adds your own TURN server,
`call-server/deploy/` holds the examples (nginx, Caddy, systemd, settings file, STUN-only
coturn, coturn with credentials), and `docs/voice-calls-internet.md` section 4 records the review behind them. The
service has not been deployed anywhere.

## Checking a deployment

```
node call-server/check-deployment.js https://calls.example.org
```

Run from another computer. It sends ordinary requests and one signed listen made with a
throwaway key (no tag, no real identity), and reports whether the address matches, the proxy
passes `X-Forwarded-Proto`, long polls survive the proxy, cross-origin access is closed and
oversized or wrongly typed requests are refused. It does not test audio, STUN or TURN; for a
TURN server use `call-server/turn-probe.js` (below).

## Checking a TURN server

```
CALL_TURN_SECRET=... node call-server/turn-probe.js turn:turn.example.org:3478
```

Talks to the TURN server like a browser would, with a credential made from the shared secret, and
reports whether valid credentials work, expired, wrong-secret and TCP-relay requests are refused,
loopback, private and link-local peers are refused, and relaying works. Exit 0 means no failed
check. See `docs/voice-calls-deploy-turn.md` section 6 for what it does not cover.

## What it refuses on its own

- Requests whose `Content-Type` is not `application/json` (`415`), and requests carrying a web
  page `Origin` (`403 origin-not-allowed`) unless that origin is named in
  `CALL_INVITE_CORS_ORIGINS` and the route is the invite route.
- More held connections than a source, the stranger pool or the whole service may have
  (`429 too-many-connections`, `503 busy`, both with `Retry-After`); a request body that does not
  arrive within 10 s (`408`); headers over 8 KiB.
- With a proxy in front and an https origin: any request not from the proxy or not marked https
  (`400 https-required`; `GET /atlas/call/info` is exempt so health checks work).

## Tests

```
node test/manual-call-protocol.js      # shared signed-protocol module
node test/manual-call-service.js       # the service, in process
node test/manual-call-unconfigured.js  # the service as a real child process
node test/manual-call-internet-security.js  # limits, proxy handling, cross-origin rules, STUN settings
node test/manual-call-proxy.js         # the deployment checker through a stand-in TLS proxy
node test/manual-call-ice-validation.js  # the rules for STUN/TURN URLs and credentials, shared with the wallet
node test/manual-call-turn-service.js  # TURN settings, who gets a credential and when, its form and lifetime
node test/manual-call-turn-probe.js    # turn-probe.js against a SIMULATED TURN server
node test/manual-call-turn-deploy.js   # the example files for coturn and the service
```

The browser-level tests are listed in `docs/voice-calls-phase1b.md`.

## Keeping the PHP option open

`protocol.js` is the transport-independent signed protocol (canonicalization,
schemas, signature verification, hashes). The HTTP handling in `server.js` is a thin
layer over it, so a later PHP polling implementation has to port only the route
handlers and the in-memory call state, not the cryptographic rules. `protocol.js`
must stay byte-identical to `extension/call-protocol.js` (a test checks it).
