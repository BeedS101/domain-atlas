# Secure voice calls: test plan

Status: proposal for review (see `docs/voice-calls-architecture.md`). Phase 1
tests now exist for wallet to wallet calls; section 5 records, per ID, what ran and
what did not (command lines and counts: `docs/voice-calls-phase1b.md`). Phases 2 and 3 have no
test yet. The plan keeps three kinds of evidence separate, and the reports for
each phase must too:

* **Code review**: reading the implementation against the design.
* **Automated tests**: scripts run here or by the owner, with their command, pass
  and fail counts.
* **Live verification**: a person using two real machines and real networks.
  Automated tests never stand in for it, and a check that was not run is
  reported as not run.

Style follows the existing suites (`test/manual-*.js`, Playwright with the
unpacked extension in persistent contexts, run under `xvfb-run -a`, isolated
state directories, fixed documented ports). Proposed new files:
`test/manual-call-service.js` (Call Service without a browser),
`test/manual-call-wallet.js` (two wallets), `test/manual-call-negative.js`,
`test/manual-call-unconfigured.js`, and in Phase 2 `test/manual-call-domain.js`.
Chromium's `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`
supplies a synthetic microphone; the prompt flags are used only to count
requests, never to hide a prompt the test is meant to see.

## 1. Phase 1: wallet to wallet

### 1.1 Functional (two profiles on one machine, automated)

| ID | Scenario | Pass condition |
|---|---|---|
| F1 | call, answer, talk, hang up | both sides reach ACTIVE; each side's received audio is non-silent (the fake source is a tone; the test reads `getStats` inbound audio level); `end` from either side ends both; all tracks stopped |
| F2 | decline | caller sees the neutral "not answered" (never "declined"); nobody opened a microphone on the callee (counted) |
| F3 | no answer | caller `noanswer` at 45 s; callee screen gone at `expiresAt` |
| F4 | caller cancels while ringing | callee screen disappears; no microphone on the callee |
| F5 | mute and unmute | the remote side's inbound level drops to silence and returns; the sender's track is released on mute (device count) |
| F6 | busy | a second invite while in a call is declined with no ring |
| F7 | callee not available | caller sees `unavailable` after the same delay as any other refusal |
| F8 | wallet locked mid-call | call ends at once, microphone released |
| F9 | Call Service restart | tags and budgets survive a restart; calls in progress end cleanly with `unavailable`; a new call works afterwards |

### 1.2 Authentication and binding (negative; each must fail closed)

| ID | Attack | Pass condition |
|---|---|---|
| S1 | malformed invite: missing field, wrong type, extra field, oversize, deep JSON, wrong `v`, unknown `kind` | refused, nothing rung |
| S2 | expired invite; `expiresAt` over 60 s; `issuedAt` in the future beyond skew | refused |
| S3 | replayed invite (same `callId`) to the same service, to the wallet directly, after a wallet restart | rings at most once |
| S4 | one byte changed in each signed field in turn (all fields of invite, accept, offer, answer, candidates, confirm, end) | `bad-signature`; the active call ends with `verify-failed` if it was a call message |
| S5 | invite signed for another service origin | refused |
| S6 | invite by a key not bound to the tag; correct key but a different tag | indistinguishable refusal |
| S7 | `accept` for another invite hash; `accept` replay; `accept` from a key not the tag's principal; accept from the right key but a different expected-callee in the contact | refused; the caller rejects a signature by the wrong callee key |
| S8 | SDP with a substituted fingerprint, an extra fingerprint, a sha-1 fingerprint, no fingerprint, `a=crypto`, `a=identity`, a data channel, video, two audio sections, oversize, candidate lines | each refused; the call ends |
| S9 | the Call Service edits an SDP field (ICE credentials) | `bad-signature` |
| S10 | duplicate, gap, reordered `seq`; message of a kind not legal in the state; offer before accept | refused, call ends |
| S11 | `confirm` withheld; `confirm` with the wrong nonce or fingerprints | no audio is sent or played (inbound and outbound levels read zero) and the call ends at 10 s |
| S12 | candidates before accept (never sent by the wallet); candidate flood above 20; loopback, link-local, multicast candidates | not sent; capped and dropped |
| S13 | a test hook forces the remote certificate hash to differ | wallet tears down with `verify-failed` |
| S14 | crafted passkey envelopes: wrong `clientDataJSON.type`, user-present flag cleared, challenge mismatch, wrong signature encoding | refused by the verifier (unit test; no authenticator needed) |
| S15 | refusal uniformity: unknown, revoked, expired, budget used, wrong principal, not available, busy (server side), do-not-disturb | byte-identical status and body, response time distribution compared across causes |
| S16 | rate limits: per tag, per callee, per source, global live calls, long-poll caps | each trips and recovers; held connections are bounded |
| S22 | listening sessions: expired, replayed nonce, wrong audience, used on a route outside its authority (create tag, accept, call) | refused |
| S23 | timeouts and cleanup: each timer of section 4.4 of the endpoints document | the state ends, the call table returns to its baseline size, no timers or tracks leak |
| S24 | listening events: delivered once after `ack`, redelivered while unacknowledged and still valid, never after the invite expires | pass |
| S25 | Block: tags revoked, later invites refused uniformly, wallet list updated | pass |
| S26 | clock skew: wallet +-20 s works; +-2 min fails with one `serverTime` retry | pass |
| S27 | call-card forgery: a card altered in transit, signed by a key other than the stored contact key, replayed after expiry, naming a different service | refused; nothing stored |
| S28 | contact key substitution: a relay replaces a contact's key at friend-add; the safety code differs; a later key change | the wallet labels the contact unverified, shows the code mismatch when compared, and warns on the key change |
| S29 | Code review only | the service refuses to fetch the revocation list from a private or loopback address unless the declared test flag is set (`call-server/server.js`). No automated test drives this refusal. With the flag set, one scripted manual run read a local revocation list. Redirects and DNS rebinding: not run |
| S30 | the real call, incoming and permit screens show the personal security phrase; a page cannot read it from the DOM, storage or messages | pass |

### 1.3 Browser boundary

| ID | Check | Pass condition |
|---|---|---|
| S17 | a page's script posts bridge messages for any call action; asks the signing bridge to sign a payload with `type` `atlas.call.*` carrying a whitelisted `purpose`; loads `chrome-extension://<id>/call.html` in an iframe or a script tag; a content-script-originated runtime message tries to control a call; the same message sent from an extension page that is not `call.html` (for example the side panel, or `call.html` opened as a tab) | no call starts or changes; the bridge refuses the call payload before any overlay; the call page cannot be framed; handlers accept only `sender.url` beginning with the call page's own URL |
| S18 | wallet private key never in a page: static scan of the call code and the injected scripts for key export and `postMessage` of key material; runtime scan of every message crossing the content-script boundary | none found |
| S19 | microphone discipline: `getUserMedia` call count is zero before the *Call*/*Accept* click, one for the call plus one per unmute click; no live track after any terminal state; Mute releases the device. The tests do not assume a browser prompt on every call (the grant persists after the first) | pass |
| S20 | no recording and no server audio: static grep for `MediaRecorder`, `createMediaStreamDestination` and uploads of media; the Call Service has no route that accepts media; its logs hold no key, tag, SDP or candidate text | pass |
| S21 | Call Service unconfigured, unreachable, or on plain HTTP (non-localhost): wallet shows the plain reason; every other wallet feature (presence, chat, mail, admin) still passes its own suite | pass |

### 1.4 Regression suites that must still pass unchanged

The suites that exercise anything Phase 1 touches: wallet signing and bridge
(`manual-page-wallet-bridge*.js`), presence privacy and abuse (privacy must still
show no wallet identity in public data), mail authentication and federation,
moderation (`manual-moderat*.js`), admin hardening. Results and any pre-existing
failure are reported separately.

### 1.5 Manual acceptance (two separate PCs, two networks), run by the owner

| ID | Step | Record |
|---|---|---|
| L1 | each PC installs the unpacked extension, creates an identity, joins the same Post Office, compares the safety code over another channel, exchanges call cards | pass/fail |
| L2 | call both ways; audio heard both ways; hang up | pass/fail, one-way delay estimate |
| L3 | the first call shows the browser's microphone prompt in the call window and not before; later calls open the microphone only after the click; the recording indicator is on only during a call; background-window ring behaviour (frozen or discarded window) observed | pass/fail, browser version |
| L4 | decline, no answer, cancel, mute | pass/fail |
| L5 | one PC behind a different NAT (mobile hotspot): connects directly, or fails without TURN | selected candidate pair type from the wallet's diagnostic |
| L6 | kill the network mid-call | call ends with `network-lost` within 60 s, microphone released |
| L7 | confirm that a wireshark/pcap of the media path shows only DTLS and SRTP, and the signalling shows no SDP candidates before accept | observation |
| L8 | hostile peer: a modified second client that sends a tampered fingerprint | the genuine wallet refuses |

## 2. Phase 2: domain to wallet

| ID | Scenario | Pass condition |
|---|---|---|
| D-chain | valid chain; each link altered in turn; delegation not yet valid, expired, revoked by id; agent cert expired; `EK` not the signer; delegation names another domain; `A.delegationId` differs from `D`; purpose not in `D` or the permit; department not in `D`; lifetime caps exceeded (`D` over 90 days, `A` over 8 hours, `A` outside `D`'s window); `issuedAt` in the future; a **backdated** delegation signed by a rotated-out key; a key that is not valid now; `notAfter` beyond the key's `validUntil`; `usage` missing (if D6 adopted) | only the valid chain reaches the screen; the others are silent missed attempts |
| D-fetch | domain files missing or stale in the cache (keys over 24 h, revocations over 6 h), malformed, not HTTPS; and, separately, a ring arriving while the domain's server is unreachable | not verified and no ring, no hang; **no network request to the domain is made at ring time** (asserted by capturing requests) |
| D-dept | department in the list, department not in the list, no agent cert, display name with control and bidirectional characters | rows show verified / not verified / "did not identify an individual" correctly; text only; length limited |
| D-domain-IDN | Unicode or mixed-script domain, trailing dots, case, ports, userinfo tricks | the ASCII form is shown; confusable names are flagged |
| D-permit | bridge request: page whose manifest lacks `callPermit`; purpose not listed; payload with a different domain than the origin; extra fields; repeated requests; user denies; prompt left to time out | no prompt where undeclared; schema and origin enforced inside the extension; denial and timeout look the same to the page |
| D-pk | every message sent to the domain and every response | contains no `IK` and no other stable wallet identifier; two domains receive different `PK`s. (The Call Service operator seeing `IK` and `PK` together is expected and documented, not a failure) |
| D-budget | permit calls used up, expired, revoked, domain blocked | uniform refusal |
| D-ui | the three rows and the standing sentence; the banner when a send, transfer or recovery screen is opened during a domain call; no approve action inside a call | screenshot assertions |
| D-agent | reference endpoint: browser-based agent page with `EK`, a call to a test wallet | works end to end; the encrypted-to-the-calling-system label is shown |

## 3. Phase 3: connectivity

| ID | Scenario | Pass condition |
|---|---|---|
| N1 | no ICE servers | LAN/loopback calls work; the wallet says that other networks need a relay |
| N2 | STUN only | works behind a cone NAT (live L5) |
| N3 | TURN: credentials expire (10 min), are per call, are refused before `ACCEPTED`, are not reusable by another call | pass |
| N4 | relay-only setting | every selected candidate pair is `relay`; the peer never sees a host or srflx address (read from the peer's stats) |
| N5 | TURN unreachable or credentials refused | call fails or stays direct, with a clear message; no crash |
| N6 | TURN carries only SRTP | capture shows no cleartext RTP; fingerprint checks identical on a relayed path |
| N7 | measure real bandwidth through TURN for a 5 minute call | compare to `docs/voice-calls-deployment.md` section 3 |

## 4. What the reports must state

For every phase: the exact commands, pass/fail counts, any check that could not
be run (and why), the commit reviewed, and an explicit split between
code-review findings, automated results and live-verification results. A test
that did not execute is not reported as passing.

## 5. Phase 1B results by test ID

Evidence class for every "Automated" entry: Chromium under Xvfb, one Linux machine,
loopback, synthetic capture device, in-process or child-process Call Service. A hostile
peer or relay is simulated by an injecting proxy and page patches, so those results show
that the wallet's checks reject the input, not that a network attacker was defeated.
"Not run" means no test exists or it was not executed; it is not a pass. No Real
hardware entry exists.

| ID | Status | Where / what was actually checked |
|---|---|---|
| F1 | Automated, partial | `manual-call-e2e.js`: both sides active, bytes flow both ways, tracks released. Audio level of the synthetic tone was not measured (byte counts only) |
| F2 | Automated, partial | decline: no microphone request and no connection on the callee. The caller's wording check accepts "declined" or "not answered"; neutral wording was not asserted |
| F3 | Automated | caller ring timer fires and the callee stops ringing (timers shortened for the test) |
| F4 | Automated | cancel while ringing; no microphone on the callee |
| F5 | Automated, partial | mute stops the capture track and detaches it; unmute needs a new capture. The other side's inbound level going silent was not measured |
| F6 | Not run | busy needs a third wallet |
| F7 | Automated, partial | Do Not Disturb and permission withdrawn end as not available with nothing ringing. Equal delay across causes not measured |
| F8 | Automated | lock ends the call, releases tracks and closes the connection |
| F9 | Partial | tags survive a restart (`manual-call-service.js`). Calls in progress ending cleanly across a restart: not run |
| S1 | Automated | service and protocol tests (missing and extra fields, wrong types, oversize, malformed JSON) |
| S2 | Automated | service tests (expired, over 60 s, stale) and adversary suite (expired invitation never rings) |
| S3 | Automated, partial | replay to the service refused; replay delivered to the wallet does not ring twice. After a wallet restart: not run |
| S4 | Partial | edited invite, accept, offer, SDP and tag/create payloads are refused; a tampered offer and accept end the call with no audio. One byte flipped in each field of every message kind: not run |
| S5 | Automated | invitation for another service refused at the service and at the wallet |
| S6 | Automated | key not bound to the tag, other tag, unknown tag: same refusal at the service; no ring at the wallet |
| S7 | Automated | wrong invite hash, replayed accept, wrong signer at the service; accept signed by someone else rejected by the caller |
| S8 | Automated, partial | `manual-call-protocol.js`: substituted, extra, missing and sha-1 fingerprints, candidates in the SDP, non-SDP text. The adversary suite ends a call with a substituted fingerprint. `a=crypto`, `a=identity`, data channel, video, two audio sections and oversize are not each tested separately |
| S9 | Automated | an SDP edited after signing fails verification |
| S10 | Automated | skipped sequence, wrong transcript hash, answer before offer (service); replay with a fresh event number ends the call (adversary) |
| S11 | Automated, partial | withheld confirmation ends the call on the confirm timer with no audio on the side that never received it. The other side may legitimately reach active meanwhile. Wrong nonce or fingerprints in a confirm: protocol tests only |
| S12 | Automated | unusable candidate addresses are neither sent nor used; the per-call caps are enforced by the service (8 per message, the per-call total) |
| S13 | Automated | a certificate that differs from the signed one, and an unreadable one, fail the call before any audio |
| S14 | Not run | passkey envelopes are not part of this phase's tests |
| S15 | Partial | unknown tag and not-listening give identical refusals; revoked tag equals unknown. Byte-identical responses for every cause and timing comparison: not run |
| S16 | Partial | invite rate limit, caps on messages per call and on candidates tested; per-source, long-poll and global call limits are configured but not each driven to the limit |
| S17 | Automated | `manual-call-bridge.js` |
| S18 | Code review only | no static or runtime scan of key material was run |
| S19 | Automated | microphone requests counted: none before the click, one at call or answer, one per unmute; none after terminal states; mute releases the device |
| S20 | Not run as a scan | the service has no media route (code review); no static grep for recording APIs was run |
| S21 | Partial | unconfigured service (`manual-call-unconfigured.js`) and the existing messaging/Post Office regression suites; unreachable and plain-http cases not each run |
| S22 | Automated | session key cannot create tags or revoke all, expired and over-long sessions refused, wrong wallet's session cannot decline |
| S23 | Automated | ring, accept, offer timers and retention in `manual-call-service.js`; the service's live-call count returns to zero in the browser tests. Wallet timer leaks beyond tracks and connections: not inspected |
| S24 | Partial | events delivered once, duplicates ignored (adversary); redelivery after no ack: service tests only |
| S25 | Automated, partial | revoking one tag and the wallet's permission withdrawal tested; "block" in the messaging sense was not run |
| S26 | Partial | stale requests refused with the server time and a clock message in the window; wallet retry with the supplied time not run |
| S27 | Partial | forged, wrong-signer and expired cards are covered by the wallet code and `manual-call-contacts.js` only for the genuine path and withdrawal; altered-in-transit and replay-after-expiry cards were not run |
| S28 | Partial | safety code derivation and match flow tested. A key change is a new, unverified contact; no warning for a substituted key at friend-add exists |
| S29 | Partial | the revocation fetch refuses loopback and private hosts unless the declared test flag is set (service tests). Redirect handling and DNS rebinding: not run |
| S30 | Not implemented | no personal security phrase exists |
| L1 to L8 | Not run | all require the owner on real hardware (`docs/voice-calls-phase1b.md` section 3.3, set-up in `docs/voice-calls-two-pc-setup.md`) |

Items marked "Partial" or "Not run" are open; none was reported as passed.

## 6. Configuration isolation (milestone 1 of internet calling)

Evidence class: Automated, same conditions as section 5. `test/manual-call-isolation.js`.
The "negative control" column records that the check fails against the extension files from the
previous commit.

| ID | Check | Status | Negative control |
|---|---|---|---|
| I1 | a domain that accepts connections and never answers does not stall the mail check; the next check skips it; identity and assets stay available | Automated | fails on previous code (still running after 60 s) |
| I2 | a failed attempt to set the call service leaves the stored settings exactly as they were | Automated | not distinguishing |
| I3 | saving an https service turns the private-test-network switch off even when ticked; a later failed local attempt does not turn it on | Automated | fails on previous code |
| I4 | with an https service saved the wallet refuses to talk to a local plain-http address | Automated | fails on previous code |
| I5 | reset removes the service, the switch and plain-http cards and permissions; contacts, identity and assets remain | Automated | function absent in previous code |
| I6 | unreadable or wrong-shaped calling data does not stop a mail check | Automated | not run against the previous code |
| I7 | an extension copy without `call-protocol.js` still starts the wallet worker, creates an identity and checks mail; calling reports unavailable | Automated | not run against the previous code |
| I8 | a listening window gives up on a service that stays down and turns availability off | Automated | not run against the previous code (the behaviour did not exist) |
| I9 | the same behaviour with the real Windows setup (a stopped local server, a left-over port forward, the owner's own wallet profile) | Not run: owner | |

### 6.1 Existing suites run after the isolation change

Run in the Linux sandbox with Chromium under Xvfb. The ten calling suites (344 checks) pass.
Of 37 older suites, 26 pass with no failures. The following 11 fail with the same message both
with the isolation change and on the previous commit (run in a separate checkout of that
commit), so they are not caused by it and are not investigated here:

- `manual-mail-encryption`, `manual-mail-gift`, `manual-wallet-import`, `manual-mail`:
  "issuer key was not valid at issuedAt" (demo issuer key validity in this environment).
- `manual-mail-management`, `manual-mailbox-housekeeping`, `manual-friend-request-recovery`,
  `manual-wallet-server-delete`, `manual-multiplayer-presence`: waits that time out or find
  no mail, request or player.
- `manual-postoffice-handle`: "that handle is already taken" (state left by an earlier run).
- `manual-asset-update-check`: "this key is not a registered domain admin".

They need a separate look before they can be counted as passing on any machine.

## 7. Internet safeguards of the Node Call Service (milestone 2)

Evidence class: Automated, Linux sandbox, loopback, Chromium under Xvfb, Node 22. Nothing was run on
a real server, behind nginx or Caddy, over a real network, or against coturn. "Probe" means the same
request was sent to the previous commit's service, to show the behaviour changed.

| ID | Check | Suite | Status |
|---|---|---|---|
| N1 | settings: STUN accepted only as `stun:host[:port]` for names and IP literals, at most three; third-party public STUN services, TURN URLs, paths, queries, user parts and bad ports refused; proxy addresses must be IPs; cross-origin entries must be exact https origins; limits must be whole numbers in range; unknown limit names refused | `manual-call-internet-security.js` | Automated |
| N2 | address handling: IPv4-mapped IPv6, IPv6 /64 keying, zone suffix, junk | same | Automated |
| N3 | proxy handling: the last forwarded address decides; client-written earlier entries, malformed headers, a missing header, a disabled proxy setting and a connection from an unlisted address all fall back to the connecting address | same, and through a stand-in TLS proxy in `manual-call-proxy.js` | Automated |
| N4 | https behind a proxy: a request that is not from the proxy or not marked https is refused `400 https-required`; the last `X-Forwarded-Proto` entry decides; `info` is exempt | same | Automated |
| N5 | cross-origin rules: web page origins refused on every route with no cross-origin headers; extension origin and no origin handled; preflight not approved; non-JSON content types `415`; an operator-named origin may use the invite route only, with its own origin echoed | same | Automated. Probe: previous code answered `Access-Control-Allow-Origin: *` |
| N6 | long polls: per-source cap `429 too-many-connections` with `Retry-After`; a wallet's repeat listen replaces its own; another source unaffected; slots released at the end and on client disconnect; strangers' pool full `503 busy` while tag holders are still admitted; global cap `503 busy`; listener-table cap; the poll route obeys the same caps | same | Automated. Probe: previous code held all four listens from one source, and a disconnect left the waiter in place |
| N7 | requests in flight per source; slow body `408` and slot released; oversize body `413`; oversize headers refused; service still answering afterwards | same | Automated |
| N8 | sockets per source when exposed directly; not applied behind a proxy; global connection limit reaches the server | same | Automated |
| N9 | operator STUN reaches the callee's `ice` answer exactly, with no credentials; `info` agrees; none configured gives an empty list | same | Automated |
| N10 | the browser is given exactly the operator's STUN URL (both wallets), at most three URLs, nothing but plain STUN, none when none is configured; a call works in each case; the browser really queries a STUN server on loopback | `manual-call-stun.js` | Automated. Loopback only: it does not show that STUN helps across two NATs |
| N11 | the deployment checker passes against a correct stand-in proxy; catches a missing `X-Forwarded-Proto`, a short read timeout, a wrong origin, an unconfigured service, an unreachable service; treats missing HSTS as a warning; refuses plain http and a path; creates no tag and no call | `manual-call-proxy.js` | Automated against a Node stand-in for the proxy, not nginx or Caddy |
| N12 | the shipped example files: settings file inert until its placeholder key is replaced and valid afterwards, nginx/Caddy/systemd/coturn examples contain the settings the guide relies on (read-only check of their text) | `manual-call-internet-security.js` | Automated text checks. **The files were never started** |
| N13 | defaults: unconfigured service answers `503 calls-not-configured` whatever the request; the real process refuses a third-party STUN and an out-of-range limit and says which setting | same, and `manual-call-unconfigured.js` | Automated |
| N14 | the guide's steps on a real host: systemd unit, nginx or Caddy, certificate, firewall, deployment checker against the real name, two wallets on two networks, with and without a self-hosted STUN | `docs/voice-calls-deploy-node.md` | Not run: owner |
| N15 | behaviour under real load, with a CDN or several proxies in front, and the limits' defaults for shared addresses | | Not run |

### 7.1 Whole call suite after milestone 2

13 suites, 498 checks, 0 failures: protocol 59, service 108, unconfigured 15, internet-security 125,
proxy 16, e2e 41, contacts 20, messaging 12, mic 12, adversary 35, bridge 18, isolation 24, stun 13.
The first ten (344 checks) are the milestone 1 set and pass unchanged. The wider older regression
suites listed in section 6.1 were not rerun: the only wallet file changed is `extension/call.js`
(the STUN URL filter), and its call-level behaviour is covered by the suites above.

## 8. Self-hosted TURN (milestone 3)

Evidence classes are kept apart on purpose.

- **Real code**: the Call Service, the shared validation module, the wallet, Chromium's own TURN
  client and WebRTC stack, DTLS-SRTP, the signed-fingerprint check.
- **Simulated TURN server**: `test/turn-fixture-lib.js`, written for these tests. It is not coturn.
  Every row below marked "simulated" shows the wallets and the service behave correctly against a
  server that enforces coturn-style credentials; none shows that coturn does.
- **Real coturn**: never run for this project. `TURN_URL`/`TURN_SECRET` let the person running the
  tests repeat one relayed call against their own server.

Linux sandbox, Node 22, Chromium 141 under Xvfb, two browser profiles on one machine. The browsers
were launched with `--no-proxy-server` because Chromium sends TCP and TLS connections to TURN
through its proxy settings and this sandbox's environment sets one that cannot reach the test
addresses.

| ID | Check | Suite | Status |
|---|---|---|---|
| T1 | URL syntax: only `stun`, `stuns`, `turn`, `turns` of an exact shape; user info, paths, fragments, odd transports, bad ports, hosts written as numbers or in hexadecimal and over-long input are refused | `manual-call-ice-validation.js` | Automated, real code |
| T2 | private, loopback, link-local, shared-address, multicast and local-name hosts (IPv4, IPv6, IPv4-mapped) are refused for TURN and STUN; TURN ports other than 80, 443, 3478, 5349 refused; both relaxed only on the private test network; third-party services refused in operator settings | same | Automated, real code |
| T3 | the wallet's reduction of an answer: credential form, expiry judged by the service's clock (expired, about to expire, too long, missing), one TURN server only, at most four TURN and three STUN URLs, extra fields dropped, malformed answers, no URL or credential in the dropped reasons | same | Automated, real code |
| T4 | settings: URLs and secret together; secret strength, length, characters, repetition; file form and its permissions; lifetime range; URL count; messages never repeat the secret | `manual-call-turn-service.js` | Automated, real code |
| T5 | who gets a credential: not a ringing, declined or cancelled call; not a stranger's key, another wallet's identity key, or either party's identity key instead of its call key; not a changed, stale, replayed or wrongly addressed request; not malformed bodies; each side up to 3 times, then `429`, independently | same | Automated, real code |
| T6 | the credential: username is an expiry and a random label holding no key, call id or domain; credential equals an independently computed HMAC-SHA1; the two sides differ; lifetime capped by the call's remaining life; none with under 30 s left; stated expiry equals the username's | same | Automated, real code |
| T7 | secrecy: not in `info`, answers, counters, the state file, or the output and files of the real process, with the secret given by environment or by file; a weak secret leaves the service unconfigured | same | Automated, real code, real child process |
| T8 | a service without TURN settings issues nothing and says so | same, and the existing `manual-call-unconfigured.js` | Automated, real code |
| T9 | the probe passes a server that enforces the rules over UDP, TCP and TLS; fails a wrong secret, a server that relays to private peers, a skewed clock and a dead port; exit codes; never prints the secret | `manual-call-turn-probe.js` | Automated against the **simulated** server |
| T10 | the example coturn, settings and unit files contain the safety settings the guide relies on, with the probe's forbidden peers covered by `denied-peer-ip` | `manual-call-turn-deploy.js` | Automated text checks. **coturn never started** |
| T11 | a call completes with the browser limited to relay candidates; the selected pair is a relay on both sides; audio flows both ways; the relay carried only DTLS and SRTP records; no microphone track before both fingerprints are confirmed; the certificate check passes as without TURN | `manual-call-turn.js` | Automated, real Chromium and DTLS-SRTP, **simulated TURN** |
| T12 | the same with the browser reaching TURN over TCP, and over TLS (`turns:`) | same | Automated, **simulated TURN**. TLS used a self-signed certificate with certificate errors ignored |
| T13 | the browser is handed exactly the operator's TURN URL with a credential that the simulated server accepts; both wallets get different ones | same | Automated, **simulated TURN** |
| T14 | with TURN offered and a direct path available, the call stays direct and nothing crosses the relay | same | Automated, **simulated TURN** |
| T15 | TURN server unreachable: a direct-capable call still works and uses the direct path; with relay forced the call ends as not connected, no microphone track is attached, and the log holds an error code and scheme only | same | Automated, **simulated TURN** |
| T16 | credentials the server considers expired: no relay, the server counts the refusals, nothing is relayed; the same call works directly when relay is not forced; works again once the server accepts the credentials | same | Automated, **simulated TURN** |
| T17 | no username, credential or secret is left in either wallet's extension storage, page storage, page text, call log, history or snapshot after the calls | same | Automated, real wallet |
| T18 | a relayed call outlives its credential: Chromium's Refresh is refused and the relay path ends at that point | `manual-call-turn-longcall.js` (about 2 minutes; not in the default run) | Automated, **simulated TURN**. Whether coturn refuses an expired credential on Refresh is unverified |
| T19 | one relayed call against a real coturn | `manual-call-turn.js` with `TURN_URL`, `TURN_SECRET` | **Not run** |
| T20 | the guide on a real host: coturn started with the example, the probe against it from outside, two wallets on two networks, relayed and direct calls, TLS with a real certificate, 443 | `docs/voice-calls-deploy-turn.md` | **Not run: owner** |
| T21 | the older call suites unchanged (protocol, service, unconfigured, internet-security, proxy, e2e, contacts, messaging, mic, adversary, bridge, isolation, stun) | the same suites | Automated; the STUN suite exposed one regression during this work (the wallet looked at only 8 URLs per entry), fixed and covered by T3 |

### 8.1 Whole call suite after milestone 3

18 suites, 692 checks, 0 failures: protocol 59, ice-validation 48, service 108, unconfigured 15,
internet-security 125, proxy 16, turn-service 73, turn-probe 17, turn-deploy 20, e2e 41, contacts 20,
messaging 12, mic 12, adversary 35, bridge 18, isolation 24, stun 13, turn 36. The thirteen
earlier suites (498 checks) pass unchanged. `manual-call-turn-longcall.js` (4 checks) was run
separately and passes. Three older wallet suites that load the same extension
(`manual-auto-backup`, `manual-page-wallet-bridge`, `manual-chat-e2ee`) pass; the eleven older
suites listed in section 6.1 were not rerun, since the only wallet files changed are
`extension/call.js` and `extension/call-protocol.js`.

### 8.2 What found real problems

Writing these tests found, and the changes fixed: the service threw (`500`) when the credential
lifetime setting was absent; IPv6 site-local addresses and hosts written as numbers or in hexadecimal
were not treated as private; the wallet's first filter looked at too few URLs per entry for the existing STUN suite. The
simulated server and probe also showed that Chromium's TCP and TLS TURN connections follow the browser's proxy
settings, and that a relayed call ends when its credential expires (guide section 3).
