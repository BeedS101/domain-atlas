# Secure voice calls: test plan

Status: proposal for review (see `docs/voice-calls-architecture.md`). No test
exists yet. The plan keeps three kinds of evidence separate, and the reports for
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
| S29 | SSRF: the Call Service and wallet asked to use a domain that resolves to a private, loopback or link-local address, or that redirects to another host | no request is made to the internal address; refused with a plain reason (a declared development mode is tested separately) |
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
