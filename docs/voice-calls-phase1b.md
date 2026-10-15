# Secure voice calls: Phase 1B (wallet to wallet) implementation and results

Status: local, unreviewed code. Not deployed anywhere, not independently reviewed,
and not to be described as production-ready or banking-grade. It has run only in
Chromium under Xvfb on one Linux machine, over loopback, with a synthetic capture
device. No test has been run by a person on real hardware.

Internet operation, the configuration-isolation fixes made after the first local Windows test, and the plan for
PHP signalling, cross-domain admission and TURN: `docs/voice-calls-internet.md`.

Design: `docs/voice-calls-architecture.md` (section 14 lists the Phase 1A amendments
and the points settled during implementation), `-threat-model.md`,
`-endpoints-and-state.md`, `-deployment.md`. Two-PC set-up for the owner:
`docs/voice-calls-two-pc-setup.md`. Service settings: `call-server/README.md`.

## 1. What was built

Two wallet identities, each in Chrome with the unpacked extension, can place a mutually
authenticated, two-way voice call through a small Call Service. The Call Service carries
signed messages only; wallets verify each other, and no audio touches the service.

| Part | Files | Notes |
|---|---|---|
| Signed protocol (transport independent) | `extension/call-protocol.js`, byte-identical copy `call-server/protocol.js` | canonicalization, strict schemas, signature and hash rules, fingerprint and SDP checks, safety code, candidate address filter. A parity test fails if the copies differ. |
| Call Service | `call-server/server.js`, `call-server/README.md` | zero-dependency HTTP long-poll. Signed invitation verification, caller-bound revocable tags (service stores only SHA-256 of a tag), listening-session authentication, replay protection, rate limits, short-lived state, no audio, no recording, no identities in the log. Refuses everything (`503`) until configured; opens no port beyond the configured one; no automatic configuration. |
| Calling window | `extension/call.html`, `extension/call.js` | a trusted extension-origin window: availability, contacts, safety codes, call screens, Mute, Hang up, cleanup. Not web-accessible. |
| Wallet side | `extension/wallet.js` (call section) | signing of call payloads for the calling window only, contact cards, grants, per-call state encrypted at rest, tag management. Private keys stay in the wallet. |
| Page boundary | `extension/content.js`, `extension/wallet.js` | any signing request from a page whose payload mentions an `atlas.call.` type is refused with no prompt; the wallet's general signing function refuses call payloads. |
| Messaging connection | `extension/viewer.html`, `extension/viewer.js` | the Calls tab reports the window's state and opens it ("Open calling window"); Call on a contact opens it with that contact selected; the idle auto-lock does not lock the wallet during a connected call. |
| Importing the protocol into the background worker | `extension/background.js` | `importScripts('call-protocol.js', 'wallet.js')`. |

Unchanged: Domain Atlas Core, Post Office server behavior, the presence service,
`SPEC.md`, `atlas-key.json`. Contact cards travel over the existing Post Office as
mail with a marker subject; existing messaging, Post Office, presence and moderation
behavior was not intentionally altered.

## 2. Security properties and the evidence behind each

Evidence classes: **Proposed** (design only), **Automated** (ran and passed, as
described above), **Real hardware** (owner; none yet). "Code review" is reading, not
a test; it is stated where it is the only support.

| Property | Evidence |
|---|---|
| A call is accepted only from a contact who granted permission, using a tag created for that caller, signed by that caller's identity key | Automated: `manual-call-service.js` (wrong signer, unbound key, wrong tag, wrong callee, wrong audience, expired, replayed, edited after signing), `manual-call-adversary.js` (forged invitations never ring) |
| The wallet re-checks every invitation itself; the service is not trusted for authenticity | Automated: adversary suite injects invitations the service never saw (stranger, forged caller, wrong callee, wrong audience, expired, replayed): none ring |
| Offer, answer, accept, confirm and end are signed and bound to the invitation by hash chain and per-sender sequence | Automated: `manual-call-protocol.js`, `manual-call-service.js`, adversary suite (tampered offer, tampered and forged accept, wrong-signer accept, replay with a new event number, forged end, cross-call injection) |
| DTLS fingerprints are signed; SDP and the actual remote certificate must match the signed fingerprint before any microphone audio | Automated: substituted SDP fingerprint, a mismatching certificate and an unreadable certificate each end the call with no audio attached (adversary suite). These cases change what the page reports; they are not a network attacker. |
| The microphone is captured at a user click and attached to the connection only after both confirmations and the certificate check; Mute stops and detaches it | Automated: `manual-call-e2e.js` records the state at every capture and attach: exactly one audio attach per side, after both confirmations and a verified certificate; mute and unmute; withheld confirmation case |
| No microphone use without a click; denied permission ends the attempt cleanly | Automated: `manual-call-mic.js` (blocked permission on the caller and on the callee); microphone requests counted at ringing, decline, cancel, Do Not Disturb. The real browser permission prompt in the extension window was not exercised (the denial is simulated by launch flags). |
| Verified and unverified contacts are displayed differently and truthfully | Automated: `manual-call-contacts.js` (six-group safety code derived from the two keys, match button, wording on ready, incoming and active screens) |
| Revocation, Do Not Disturb, wallet lock, window close, timeouts and failures clean up | Automated: `manual-call-e2e.js` (revoke, DND, lock, window close, ring timeout, service-side live calls return to zero), `manual-call-service.js` (timers, retention) |
| Websites cannot start, answer or control calls or obtain `atlas.call.*` signatures | Automated: `manual-call-bridge.js` (page signing refused with no prompt for the invite, accept, nested and look-alike payloads; the page cannot message the extension, fetch, frame or open the calling window; only extension-origin senders are trusted). A page cannot be shown to have no other route; this is the set of routes tested. |
| Private keys are not exposed to pages | Code review of the new call paths and the existing bridge; the bridge tests above. No separate runtime scan of every message was run. |
| No recording, no server audio | Code review: the service has no media route and the wallet no recorder. A static scan for recording APIs was not run (plan S20). |
| Candidate addresses: loopback, link-local, multicast, unspecified and arbitrary host names are dropped on send and on receive | Automated: `manual-call-protocol.js`, `manual-call-adversary.js` |
| Duplicate event deliveries are ignored, replays with a fresh event number end the call | Automated: adversary suite |

## 3. Results

### 3.1 Automated tests actually executed

Command: `xvfb-run -a sh test/run-call-tests.sh` with the demo Domain B issuer on
port 8002 (see the header of that script). Chromium 141 under Xvfb, Node 22, loopback, fake
capture device; the service runs in process (or as a child process for the
unconfigured test).

| Suite | What it covers | Result |
|---|---|---|
| `manual-call-protocol.js` | signed protocol module, canonicalization, schemas, fingerprints, safety code, candidate filter, parity with the service copy | 59 passed, 0 failed |
| `manual-call-service.js` | Call Service without a browser: tags, memberships and revocation, listening sessions, invites, accept, offer and answer, candidates, confirm, end, timers, limits, persistence | 108 passed, 0 failed |
| `manual-call-unconfigured.js` | the service as a real child process: refuses until configured, no file created, rejects bad settings | 15 passed, 0 failed |
| `manual-call-e2e.js` | two real wallets in two browser profiles over a real Post Office: contact cards, Available, ring, answer, audio both ways, mute, hang up, decline, cancel, ring timeout, DND, revoke, lock, window close, ring-rate limit | 41 passed, 0 failed |
| `manual-call-contacts.js` | permissions, safety codes, verified and unverified display, withdraw, availability | 20 passed, 0 failed |
| `manual-call-messaging.js` | Calls tab in the messaging interface, opening the window, one window only, auto-lock behavior | 12 passed, 0 failed |
| `manual-call-mic.js` | microphone permission denied (caller, callee) | 12 passed, 0 failed |
| `manual-call-adversary.js` | forged, replayed, tampered and substituted signaling and certificates, candidates, withheld confirmation, duplicates, forged end, cross-call injection | 35 passed, 0 failed (see the note below the table) |
| `manual-call-bridge.js` | page access to the signing bridge and the calling window | 18 passed, 0 failed |
| `manual-call-isolation.js` | added after the first local Windows test: hung domain, settings isolation, broken or missing calling data (see `docs/voice-calls-internet.md` section 3) | 24 passed, 0 failed |
| `manual-call-internet-security.js` | added for internet exposure: limits, proxy handling, cross-origin rules, STUN settings, shipped examples (see `docs/voice-calls-internet.md` section 4) | 125 passed, 0 failed |
| `manual-call-proxy.js` | the deployment checker through a stand-in TLS proxy | 16 passed, 0 failed |
| `manual-call-stun.js` | two real browsers, operator STUN URLs reach the browser and nothing else does | 13 passed, 0 failed |

Total across the nine suites: 320 checks, all passing in the last full sequential run.

Open item: one adversary check ("the same invitation delivered again is not rung twice")
failed once in a full sequential run and passed in every other run (the final full run
and about ten further runs, alone and in sequence). The cause was not established. The
check also fails if the replay was dropped for a different reason than the one it expects,
so the failure does not by itself show that the window rang. The test now prints the window
logs and trace if it recurs. Treat this check as intermittent until it is explained.

The hostile cases use a proxy in front of the service that can inject or alter events
and page patches that stand in for a hostile peer. They exercise the wallet's checks.
They are not real attackers and not network captures.

Existing suites run after the final code changes (single run each, same machine):

| Suite | Result |
|---|---|
| `manual-messaging-window.js` (messaging interface, edited here) | 21 passed, 0 failed |
| `manual-chat-e2ee.js` | 10 passed, 0 failed |
| `manual-postoffice-mail.js` | 11 passed, 0 failed |
| `manual-add-contact-from-mail.js` | 9 passed, 0 failed on the rerun; one earlier run in the sequence failed on a button that was not visible and was not investigated further |
| `manual-page-wallet-bridge.js` | 11 passed, 0 failed |
| `manual-page-wallet-bridge-sign.js` | 7 passed, 0 failed |
| `manual-page-wallet-bridge-offer.js` | 15 passed, 0 failed |
| `manual-page-wallet-bridge-preview.js` | 8 passed, 0 failed |
| `manual-demo-domain-b-wallet-bridge.js` | 8 passed, 0 failed |
| `manual-postoffice-consent.js` | 7 passed, 0 failed |
| `manual-postoffice-handle.js` | 10 passed, 0 failed |
| `manual-mail.js` | fails at the first step ("issuer key was not valid at issuedAt"); the same failure occurs on the untouched Phase 1A commit |

Not run: the admin suites, the PHP issuer suites, the remaining presence and moderation
suites, and the email-ticket suites. Nothing in this work touches them, but that is a
claim from reading, not from a run.

Failures that predate this work (identical on the untouched Phase 1A commit, and
unrelated to calling): `manual-friends-favorites`, `manual-chat-dynamic-tabs` and
`manual-chat-history-toggle` (in-world chat through the presence service) and
`manual-presence-moderation-wallet` (its issuer-server harness exits early). They were
not fixed here. Several suites keep persistent browser profiles under `test/` and fail
with a timeout at wallet creation if a previous run left one behind (the profiles are
git-ignored); the profiles were deleted before the reruns recorded above.

Defects found by these tests and fixed during the work, so the history is visible:
the protocol module missing in the background worker; a window-close hang-up not
delivered because storage was read before the request; the page-signing guard checking
only the top-level payload (the bridge test caught nested call payloads); and, in the
test itself, a "no audio attached" check that read the page's whole history.

### 3.2 Manual tests actually executed

None by a person. Every browser run above was scripted. No one has used the calling
window with a real keyboard, mouse, microphone or speakers, and no screenshots were
reviewed as an acceptance step.

### 3.3 Tests still requiring the owner on real hardware

Mapped to the test plan (`docs/voice-calls-test-plan.md`, section 1.5, with the
results table in section 5):

| ID | What is needed |
|---|---|
| L1 | two PCs, each with the unpacked extension and an identity, joined to the same Post Office, safety codes compared over another channel (set-up: `docs/voice-calls-two-pc-setup.md`) |
| L2 | a call both ways with real audio heard on both ends and a rough delay impression |
| L3 | the real microphone prompt inside the extension window and when it appears; the browser's recording indicator on only during a call; behavior of a minimized, covered, discarded or sleeping calling window (ring, title, attention request) |
| L4 | decline, no answer, cancel, mute by hand |
| L5 | a second network (phone hotspot) to see whether it connects without a relay; the expected outcome is failure without TURN |
| L6 | disabling the network mid-call: the call should end and the microphone be released within the documented time |
| L7 | a packet capture of the media path: DTLS and SRTP only; no candidates in signaling before accept |
| L8 | a real modified peer sending a tampered fingerprint |
| extra | a wallet using a passkey identity (the passkey signing path was not exercised); Firefox and branded Chrome; Windows specifics (firewall, mDNS, VPN adapters); the operating system's own microphone indicator and device release |

## 4. Known gaps and deliberate limits

* No background listening, no notification: the calling window must be open, the wallet
  unlocked and the status Available. A caller otherwise sees "Not available right now."
* No TURN and no default STUN: the call works between browsers that can reach each other
  directly (same local network, or open paths). Relay-only mode is Phase 3.
* A change of a contact's key is not warned about because contacts are keyed by their
  public key: a new key is a new contact that starts unverified (plan S28 partly).
* No personal security phrase (plan S30), no "busy" test (needs a third wallet), no
  exhaustive one-byte-flip test of every signed field (S4), no replay test across a browser
  restart (the seen-call cache persists but the restart case was not run).
* The Call Service reads the operator's revocation list from the configured address.
  The code refuses private and loopback addresses unless the test flag is set, but no
  automated test drives that refusal (code review and one scripted run with the flag
  only); redirects and DNS rebinding were not examined.
* The service in this phase serves plain http only in the declared test mode; a real
  deployment needs https in front. Nothing was deployed.
* Candidate addresses reach the other browser by ICE design; the post-connect certificate
  check stops media exchange with the wrong endpoint, not contact with it (amendment 4).
* The 600-requests-per-minute per-source default can be hit by many users behind one
  address; it is a setting.
* No bank, issuer-defined or multi-device identities, biometrics or transaction approval
  were built. The signed protocol keeps the caller identity, the audience and the policy
  fields separate so these can be added, and it is independent of HTTP so a PHP polling
  implementation can replace the Node service (see `call-server/README.md`).

## 5. How to repeat the runs

```
node test/manual-call-protocol.js
node test/manual-call-service.js
node test/manual-call-unconfigured.js
PORT=8002 ATLAS_DOMAIN=localhost:8002 ATLAS_DOCROOT=demo-domain-b \
  ATLAS_STATE_DIR=issuer-server/domain-b-state node issuer-server/server.js &   # for the browser tests
xvfb-run -a sh test/run-call-tests.sh
```

Domain A (port 8001) must also be running for the regression suite that opens world
pages and for `manual-messaging-window.js`.
