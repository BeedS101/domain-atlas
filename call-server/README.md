# Call Service (Phase 1B, local use only)

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
| `CALL_STUN_URLS` | Optional, comma separated `stun:host:port` URLs handed to wallets. Empty: direct connections only. |
| `CALL_BIND`, `CALL_PORT` | Listen address (default `127.0.0.1`) and port (default `8787`). A non-loopback bind is your decision and needs your own firewall rule; the service opens nothing. |
| `CALL_TRUST_PROXY=1` | Read the client address from `X-Forwarded-For`. Only behind a proxy that sets it. |
| `CALL_DEV_ALLOW_HTTP=1` | Accept an `http` origin. Private test networks only. |
| `CALL_DEV_ALLOW_PRIVATE_FETCH=1` | Let the revocation fetch use a loopback or private host. Test networks only. |

A misconfiguration (bad origin, malformed key, missing domain) leaves the service
unconfigured and says which setting on the console.

## Reverse proxy (when it is ever deployed)

HTTPS only; read timeout above 30 s and response buffering off for
`/atlas/call/listen` and `/atlas/call/poll`; request body cap 20 KiB; no body
logging; NTP-synchronized clocks (30 s skew is allowed on invitations, 120 s on
requests).

## Tests

```
node test/manual-call-protocol.js      # shared signed-protocol module
node test/manual-call-service.js       # the service, in process
node test/manual-call-unconfigured.js  # the service as a real child process
```

The browser-level tests are listed in `docs/voice-calls-phase1b.md`.

## Keeping the PHP option open

`protocol.js` is the transport-independent signed protocol (canonicalization,
schemas, signature verification, hashes). The HTTP handling in `server.js` is a thin
layer over it, so a later PHP polling implementation has to port only the route
handlers and the in-memory call state, not the cryptographic rules. `protocol.js`
must stay byte-identical to `extension/call-protocol.js` (a test checks it).
