# Secure voice calls: connectivity and deployment considerations

Status: proposal for review (see `docs/voice-calls-architecture.md`), amended
after Phase 1A and Phase 1B (section 8). `call-server/` now exists as local code
and has been run only on loopback. Nothing here is deployed, no configuration
file is created by any software, and no live setting is to be edited until a
separate, supervised deployment is authorized.
Figures marked *estimate* are planning arithmetic from stated assumptions, not
measurements; Phase 3 replaces them with measured values.

## 1. What would be deployed

| Piece | Where | New dependencies |
|---|---|---|
| Call Service (`call-server/`, proposed) | one Node process per operator, behind the operator's TLS reverse proxy | none (Node built-ins only, like `issuer-server/` and `presence-server/`) |
| Wallet extension update (call window, `wallet.js` additions) | the extension package | none; adds the `microphone` use in an extension page, no new host permission (the extension already has `<all_urls>`) |
| Manifest field (`calls.service`, Phase 2 `walletBridge.callPermit`) | the domain's `.well-known/spatial.json` | none; both optional |
| STUN/TURN (Phase 3, optional) | the operator's own coturn or equivalent | a TURN server is a separate daemon, not an application dependency |
| PHP | **nothing** | calls are Node-only; a PHP-only domain points its wallets at a Node Call Service hosted elsewhere |

No database. State is: an atomic JSON file of tags (mode 0600, denied to the web,
git-ignored by the existing `atlas-*.json` convention if it lives in a state
directory) and in-memory call state.

## 2. Operator configuration (all by hand, nothing created automatically)

Proposed environment or file (names are placeholders for review):

| Setting | Meaning |
|---|---|
| `CALL_ORIGIN` | the service's public origin (`https://calls.example.com`); this is the `audience` every message must carry |
| `CALL_DOMAIN`, `CALL_ISSUER_KEYS` | the domain whose Post Office memberships admit people to create tags, and that domain's public key(s) **copied by the operator** from its `atlas-key.json` (pinned, never fetched from a request), as the moderation setup does |
| `CALL_REVOCATIONS_URL` | where to read that domain's revocation list for membership checks |
| `CALL_STATE_FILE` | tag store path |
| `CALL_STUN_URLS` | STUN URLs to advertise (empty: LAN-only calls) |
| `CALL_TURN_URLS`, `CALL_TURN_SECRET` | Phase 3 only |
| limits | invite size, per-tag/callee/source rates, live-call cap, long-poll caps, tag quota |

With none of it present the service answers `503 calls-not-configured` on every
route except `info`, and the wallet shows that calls are not available. A
service started without the file creates nothing, exactly as the moderation
components behave.

Reverse proxy requirements: HTTPS only; **read timeout above 30 s and response
buffering off for `/atlas/call/listen` and `/atlas/call/poll`** (they hold for
25 s); a request body cap equal to the largest route limit; no logging of bodies;
a modest connection limit per source. Clocks must be synchronized (NTP): the
protocol allows 30 s of skew.

**Outbound fetches.** The Call Service fetches nothing from a name a requester
supplies. It reads only the key document and revocation list of its single
configured domain, over HTTPS, refusing redirects to other hosts and addresses
in private, loopback, link-local and multicast ranges (a development flag may
allow `localhost`), with size and time limits, and caches the result.

Keep out of any log, metric or error message: tags, keys, signatures, SDP,
candidates. Counters (invites, refusals by coarse class, live calls) are fine.

## 3. Connectivity: direct, STUN, TURN

| Path | How it works | Needs | Fails when |
|---|---|---|---|
| Direct on a LAN | host candidates | nothing | peers on different networks |
| Peer to peer through NATs | STUN reveals each side's public mapping, then ICE finds a path | a STUN server (cheap, UDP, no media) | either side has symmetric NAT or UDP is blocked |
| Relayed | both sides send SRTP to a TURN server that forwards it | a TURN server with bandwidth | the relay is down or unreachable |

**Where TURN is unavoidable.** (1) Both peers behind symmetric or otherwise
endpoint-dependent NATs (common on some mobile carriers using carrier-grade
NAT); (2) a corporate or institutional network that blocks outbound UDP, which
needs TURN over TCP or TLS on port 443 (and may block even that); (3) a
callee or caller who chooses *Hide my network address*. How large that share is
depends entirely on the audience (commonly quoted figures are a minority of
calls, often cited around ten to twenty percent, but that is folklore for this
purpose). Phase 3 should record the selected candidate-pair type locally in the
wallet's diagnostic view and ask the owner to report it from the two-PC test;
no telemetry leaves the device.

**What degrades if relay infrastructure is unavailable.** Calls between peers
with an open path still work. Calls that needed a relay fail after the ICE timer
(30 s) with a plain message ("this network blocks direct calls, and no relay is
available"); nothing falls back to an unencrypted or server-terminated path,
ever. *Hide my network address* becomes unavailable and the wallet says so
rather than quietly using a direct path. Signalling, tags, mail and every other
feature are unaffected.

**Never relayed in the clear.** The Call Service has no media route and no media
dependency. A TURN server forwards DTLS-SRTP packets it cannot decrypt (the DTLS
keys are negotiated end to end between the two browsers, verified against the
signed fingerprints). There is no configuration under which the project's
software terminates or records media, and the test plan checks it.

**STUN privacy.** Every STUN server learns the address of each wallet that asks.
The wallet therefore never contacts a third-party STUN server by default; it
uses only the STUN URLs advertised by the Call Service the user chose, which is
operator-run in the intended deployment. A user may add their own.

### Bandwidth through a relay (*estimate*)

Assumptions: Opus voice at 24 to 32 kbit/s payload, 20 ms packets (50 per
second), per-packet overhead of IPv4 (20 B) + UDP (8) + RTP (12) + SRTP
authentication tag (10) = 50 B, about 20 kbit/s, plus a few kbit/s for header
extensions, RTCP and ICE keep-alives.

| Quantity | Value |
|---|---|
| per direction, on the wire | about 45 to 60 kbit/s (roughly 340 to 450 KB/min) |
| one relayed call, relay egress | two streams out: about 0.7 to 0.9 MB/min, 40 to 54 MB/h |
| one relayed call, relay ingress | the same |
| 100 concurrent relayed calls | about 9 to 12 Mbit/s each way |
| 1000 concurrent relayed calls | about 90 to 120 Mbit/s each way |
| TURN over TCP/TLS | more framing and head-of-line blocking; expect higher delay and worse audio under loss |
| signalling (Call Service) | a few KB per call; each available wallet makes about one small request every 25 s, on the order of 100 KB/h |

Most calls will not use the relay, so the capacity needed is the relayed
fraction of the busiest hour, not the call volume. Capacity planning is a Phase 3
measurement.

### TURN configuration guidance

Short-lived per-call credentials from the shared-secret scheme that coturn
supports (`use-auth-secret`): username `"<expiry>:<callId>"`, password the
HMAC of the username with the secret, lifetime at most 10 minutes. (This is the
TURN server's own credential format, not a protocol invented here; its HMAC
choice is dictated by the server, and it protects relay allocation, not
audio.) The Call Service issues them only to a call in state `ACCEPTED` or
later, and only over the authenticated `ice` route. On the TURN server: deny
relaying to private and loopback ranges (`denied-peer-ip`), disable the CLI,
set per-user and total quotas, enable TLS on 443 if blocked-UDP clients matter,
and keep it off any host that stores wallet or issuer state.

## 4. Rollout and rollback

1. Phase 1 on a loopback or private test network only, two profiles then the
   owner's two PCs. No public Call Service.
2. A separately authorized, supervised deployment: Call Service first (it is
   inert until a wallet registers), then the extension update. The service ships
   unconfigured and does nothing; configuration is the owner's explicit step.
3. Kill switch: unset the configuration or stop the service; wallets show
   "calls not available" and every other feature is unaffected. Removing the
   extension update removes the call window.
4. No data migration. Tags are disposable: deleting the state file revokes
   every tag.

## 5. Abuse operations

The operator can: revoke a member's Post Office membership (inbox and tags
vanish), delete a tag, lower per-source limits, block a domain from using
permits. The service keeps counters, not content. Nothing is recorded by
default and nothing is published.

## 6. Degradation matrix

| Failure | Effect |
|---|---|
| Call Service down or unconfigured | no calls in or out ("not available"); everything else works |
| Call Service restarted | live calls end; tags survive; listening resumes after the wallet re-opens its session |
| STUN down | direct calls on open paths still work; others fail at the ICE timer |
| TURN down | as above; relay-only mode unavailable |
| Domain's `.well-known` unreachable (Phase 2) | domain calls are not verified and do not ring |
| Clock far off | calls refuse with a clear "check your clock" message |
| Wallet locked or closed | the wallet is unavailable; callers see "unavailable" |

## 7. Scope reminders

This is not a telephone replacement: no emergency calling, no call recording,
no voicemail, no lawful-intercept feature, and no guarantee of delivery to an
unavailable wallet. Whether any deployment raises legal or regulatory questions
(recording laws, telecom rules for domain-originated calls, data protection for
the metadata the Call Service sees) is for the operator to settle with counsel;
this document is not legal advice. No deployment may be described as secure to a
banking standard until an independent security review of the finished system has
been done.

## 8. Amendments from Phase 1A and Phase 1B

Evidence classes as in the architecture document. Everything below is
**Automated** on one machine (loopback) or **Proposed**; no real network, TLS
terminator, second PC or TURN server has been used.

**What exists.** `call-server/server.js` (zero dependencies, written for Node 20 or newer and run only on Node 22, the
shared `protocol.js` is byte-identical to the wallet's `extension/call-protocol.js`
and a test enforces that). `call-server/README.md` lists every setting.

**Settings as implemented** (environment variables, or a JSON file named by
`CALL_CONFIG_FILE` using the same names without the prefix, camel-cased):
`CALL_ORIGIN`, `CALL_DOMAIN`, `CALL_ISSUER_KEYS` (comma separated, 1 to 8 raw
P-256 keys copied by the operator), `CALL_REVOCATIONS_URL`, `CALL_STATE_FILE`,
`CALL_STUN_URLS`, plus `CALL_BIND` (default `127.0.0.1`), `CALL_PORT` (default
`8787`), `CALL_TRUST_PROXY=1` (take the client address from `X-Forwarded-For`; only
behind a proxy that sets it), `CALL_DEV_ALLOW_HTTP=1` (accept an `http` origin; for
a private test network only) and `CALL_DEV_ALLOW_PRIVATE_FETCH=1` (let the
revocation fetch use a private or loopback host). With none set the process
answers `503 calls-not-configured` and creates no file; an invalid setting leaves
it unconfigured and says why on the console without echoing values. The console
prints only coarse lines (start, bind address, unconfigured reason); it never
prints a tag, key, call id, nonce or SDP, and a test asserts that.

**Binding.** The default bind is loopback. Reaching the service from a second
machine needs the operator to set `CALL_BIND` to a LAN address (or `0.0.0.0`) and
to allow the port in the operating system firewall; the software never opens a
port, and says on the console when it is bound beyond loopback.

**Connectivity as built.** STUN is advertised only if `CALL_STUN_URLS` is set;
there is no TURN. On one LAN the host candidates connect directly. Across two
different home networks, calls work only when both sides are behind cone-type NAT
and a STUN server is configured, and fail otherwise (symmetric NAT, carrier-grade
NAT, many corporate networks). This matches the Phase 3 plan: Phase 1B does not
try to solve it.

**Plain http.** `https` is required for the call service address. The private
test network switch (wallet) and `CALL_DEV_ALLOW_HTTP` (service) allow `http` for
`localhost` and private-range addresses only, so two PCs can be tried on one LAN
without a certificate. Do not describe a deployment in that mode as secure
signalling (threat model M10).

**Post Office dependency.** Creating a permission needs a Post Office membership
credential issued by `CALL_DOMAIN`, and both wallets reach that domain's Post Office
to exchange contact cards. A wallet builds `http` URLs only for `localhost`,
`127.0.0.1` and `[::1]`; every other domain is `https`. So two PCs need either an
existing `https` Post Office, or a local demo domain made reachable as
`localhost:<port>` on each PC. `docs/voice-calls-two-pc-setup.md` describes both.

**Long-poll.** The service holds `listen` and `poll` for 25 s. The polling
transport is plain request/response JSON, so a later PHP implementation can serve
the same signed messages with shorter holds; the window already tolerates empty
answers and re-polls.
