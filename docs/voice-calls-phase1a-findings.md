# Secure voice calls: Phase 1A browser feasibility findings

Status: findings for review. Nothing here is deployed, nothing in the wallet,
Post Office, presence service, `SPEC.md` or `atlas-key.json` was changed, and the
experiment in `experiments/secure-comms-spike/` is **not** the calling protocol:
it uses synthetic test keys, simplified message shapes and a loopback-only test
relay, and its UI deliberately shows no "verified" state. No bank-verification
badge is justified by anything below.

Evidence is kept in three classes, as in `docs/voice-calls-test-plan.md`:

* **Automated (Chromium)**: assertions that ran and passed, with the command.
* **Observed (Chromium)**: a measurement or behavior that was recorded but is not
  an assertion about the design. Version specific.
* **Not exercised**: not run in this environment. Reported as unknown, not as
  expected to work.

Environment of every result below: Playwright's bundled Chromium (the probe reports
Chrome/141), headed under Xvfb (no window manager), Linux, loopback network,
`--use-fake-device-for-media-stream`, and (except where stated) the
`--use-fake-ui-for-media-stream` auto-grant flag. **Firefox was not exercised**
(its download was blocked by the environment's egress policy, and I did not work
around that).

## 1. Answers to the seven questions

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Microphone only from a dedicated call window after an explicit click? | Yes, in Chromium: zero `getUserMedia` requests on load or while ringing; one on a trusted click; script-generated clicks are ignored by the page's own `isTrusted` guard. The **real permission prompt** inside an extension window was not seen. | Automated; prompt not exercised |
| 2 | Two independent browser contexts establish WebRTC audio? | Yes. Two profiles, both directions, DTLS 1.2 + SRTP, non-zero received audio energy, no `a=crypto` | Automated |
| 3 | How does the browser expose DTLS certificate fingerprints and remote certificate information? | Local: `RTCCertificate.getFingerprints()` and the SDP. Remote: `RTCDtlsTransport.getRemoteCertificates()` and `getStats()` (`certificate` + `transport.remoteCertificateId`). All present and mutually consistent, with three quirks in section 3 | Automated + observed |
| 4 | Is the proposed fingerprint binding implementable with supported APIs? | **Yes.** It is the standard approach (fingerprints exchanged in the offer/answer SDP, authenticated out of band), no alternative is needed. Three independent layers each stop a substituted endpoint; with all of them switched off the attack succeeds, so the layers are doing real work. | Automated |
| 5 | Mic tracks and peer connections reliably stopped on hang-up, lock, close, error? | Yes for every trigger tried (hang-up, decline, cancel, lock, uncaught error, verification failure, window close, mute). Release of the **physical** device and the OS recording indicator were not observable. | Automated; hardware not exercised |
| 6 | Firefox vs Chromium differences | Cannot say. Chromium behavior is documented; Firefox is unknown. A probe page and checklist are provided for the owner. | Not exercised |
| 7 | Can an inactive extension call window reliably receive and show an incoming call? | In the cases reachable here, yes: a **hidden background tab** received and presented the call at +25 s, +120 s and +402 s (45 to 113 ms). The service worker can also hold a long-poll and receive invites with no window open. Frozen/discarded pages, minimized or occluded windows, sleep, and a click on an OS notification were **not** exercised. | Automated (limited) |

## 2. Q1: microphone gating

Automated (`test/q1-q2-mic-and-call.js`):

* `getUserMedia` count is 0 when the call window opens, on both sides, and stays 0
  on the callee while the call rings; no capture track exists before the click.
* A script-generated `click()` on Call or Answer does nothing (the handlers return
  unless `event.isTrusted`); it is counted as ignored. A real click (Playwright
  dispatches real input events) requests the microphone exactly once.
* The callee never captures if it declines or the caller cancels (`q5`).
* One `getUserMedia` per side for the whole call (a second only on unmute).
* The microphone is captured at the click (the user gesture and prompt have to be
  there) but is **not attached to the connection** until both sides have exchanged
  confirms (section 5). Before that, no RTP packets are sent at all
  (`outbound packetsSent = 0`).

Observed without the auto-grant flag: the permission state for the extension page
is `prompt`; after the click `getUserMedia` stays pending for the 6 s watched and no
media starts. Automation cannot see or click that browser prompt, and
`context.grantPermissions` refuses `chrome-extension://` origins ("Permission can't
be granted to opaque origins"). **Whether the prompt appears clearly, and what the
user sees, for a popup window of an extension is not exercised.** Owner checklist
item 1 covers it. The static check that the manifest has no microphone permission
and that `getUserMedia` is called from exactly one function reachable only from
click handlers is in `test/security-boundary.js`.

## 3. Q2 and Q3: connection and certificate APIs

Automated and observed in Chromium 141:

| Fact | Value |
|---|---|
| Available | `RTCPeerConnection.generateCertificate`, `RTCCertificate.getFingerprints`, `RTCDtlsTransport`, `RTCDtlsTransport.getRemoteCertificates`, `setCodecPreferences` |
| Transport | DTLS 1.2 (`tlsVersion FEFD`), `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256`, SRTP `AES_CM_128_HMAC_SHA1_80`; no `a=crypto` anywhere |
| Fingerprint in SDP | one `a=fingerprint:sha-256` line, **media level only** (no session-level line), plus `a=setup:actpass` |
| Generated certificate | ECDSA P-256, `expires` about 30 days out |
| Certificate used | the one passed in `certificates` is the one in the SDP and on the wire (a fresh certificate per call works and is cheap) |
| Remote view 1 | `transport.getRemoteCertificates()` (DER); its SHA-256 equals the peer's SDP fingerprint |
| Remote view 2 | `getStats()`: `transport.remoteCertificateId` -> `certificate.base64Certificate`; SHA-256 equals the same value, so both views agree |
| Selected pair | `host`/`host`, with the real local address visible in stats once capture is granted (no mDNS obfuscation was seen in this environment) |
| SDP after gathering | contains `a=candidate` lines; the description returned by `createOffer` did not |

Quirks that change implementation, all measured:

1. **`RTCCertificate.getFingerprints()` returns lower-case hex; the SDP and the stats
   return upper-case.** Compare case-insensitively (the spike normalizes to upper
   case). A byte-for-byte comparison would reject every honest call.
2. **`pc.connectionState === 'connected'` can precede the DTLS transport reaching
   `connected`.** In the final recorded run, on both
   sides, the first `getRemoteCertificates()` call returned `[]` while
   `transport.state` was `connecting`, and returned the certificate on the second
   attempt 100 ms later (it was non-empty on the first attempt in other runs). An empty list must mean "not yet
   known", never a pass. The spike retries for up to 2 s, requires at least one
   non-empty source, requires all non-empty sources to match the signed set, and
   fails closed if both are empty.
3. **Use the description returned by `createOffer`/`createAnswer`, not
   `localDescription` read later.** The latter accumulates candidates, which the
   strict checker (correctly) refuses; candidates travel as separate messages.

Not exercised: IPv6, TURN/relay candidates, mDNS candidates when no capture
permission is held, network change mid-call, two machines on different networks.

## 4. Q4: the fingerprint binding

The design: the wallet identity key signs the DTLS fingerprints (and a per-call key)
**before any SDP exists**; the peer checks the signed binding against its pinned key
and the call identifiers; the SDP must carry exactly the signed fingerprints; and
after connecting, the live remote certificate must hash to a signed fingerprint
before any audio is attached or played. `spike-lib.js` implements the pieces,
`test/q3-q4-binding.js` and `test/unit-lib.js` test them.

Automated attacks and which layer stopped them (Alice calls Bob; Mallory is a
second browser acting as the relay's accomplice):

| Attack | Layer that stops it | Result |
|---|---|---|
| Accept from a genuine call replayed into another call | binding fields (`callId`) | refused `field-mismatch:callId`, mic released |
| Accept signed by a key other than the pinned one | key pin | refused `unexpected-signer` |
| Relay rewrites the SDP fingerprint | per-message signature | Bob refuses `bad-message-signature` |
| same, message signatures disabled | SDP-vs-signed-fingerprint check | refused `fingerprint-not-signed` |
| same, both disabled | browser DTLS itself | connection `failed` in about 100 ms, both sides tear down |
| Mallory answers with her own certificate while presenting Bob's genuine, copied accept | per-message signature (her key is not Bob's call key) | refused `bad-message-signature`, no connection |
| same, signatures disabled | SDP check | refused `fingerprint-not-signed`, no connection |
| same, signatures and SDP check disabled | post-connect certificate check | the browser **does** complete DTLS with Mallory; the check refuses `remote-cert-mismatch`; Alice never attached her microphone and Mallory received no audio energy |
| **Control**: all three checks disabled | none | Alice reaches `in-call` with Mallory and Mallory hears Alice's audio |

The control row matters: it shows the attack harness works, so the passes above are
not vacuous. It also shows the layers are independent: any one of them alone
suffices in these scenarios.

Two properties to keep in the design, both visible in the table:

* **The post-connect check stops audio, not network contact.** In the third
  Mallory row ICE and DTLS completed with the attacker before the check ran. The
  attacker therefore learns the caller's address (the Call Service already could).
  This is a reason to keep the *Hide my network address* (relay only) option in the
  design and to attach media only after the check, as the spike does.
* The binding makes the connection endpoint match a key the wallet already trusts;
  it says nothing about who is holding that key. That is the job of the contact and
  safety-code layers in the architecture document, which this spike does not test.

Standard-interoperable alternative: **not needed**, because the planned approach is
implementable. `a=identity` / WebRTC identity assertions were not used and are
refused by the checker; whether browsers support them was not tested.

## 5. Q5: stopping the microphone and the connection

Automated (`test/q5-teardown.js`, 37 assertions). For each trigger the test reads a
snapshot taken by the page inside its teardown: every capture track `readyState ===
'ended'`, no live tracks left, `RTCPeerConnection.connectionState === 'closed'`, and
the peer's reaction.

| Trigger | Local result | Peer |
|---|---|---|
| hang-up click | released, closed | signed `end`, peer ends |
| callee declines | caller releases (it captured at Call); callee never captured | caller ends `peer-decline` |
| caller cancels while ringing | released | callee stops ringing, never captured |
| wallet lock (session-storage flag changed by the background) | released within 10 ms of the signal | peer ends |
| lock while still ringing | released | n/a |
| uncaught error or unhandled rejection | released | peer ends |
| verification failure (`q3-q4`) | released, `liveTracksAfter 0` | n/a |
| window closed by the user (`chrome.windows.remove`) | `pagehide` handler released everything | signed `end` delivered by a keep-alive request in about 110 ms |
| mute | capture track **stopped** (not just disabled) and sender detached; the peer receives no further packets; unmute needs a new click and a second `getUserMedia` | n/a |

`teardown()` is idempotent (a second call is a no-op). Design points confirmed:

* Dropping the track from the sender and calling `track.stop()` are both done;
  `enabled = false` alone is not enough, because a disabled track still sends
  silent RTP (first-run measurement: packets flow, energy about 1e-9).
* Locking must be a signal the call window can observe; the spike used a
  `chrome.storage.session` change from the background worker. In the real wallet
  the equivalent is whatever already propagates "locked" to extension pages.

Not exercised: the physical microphone and the OS "recording" indicator (the fake
device has none), a browser crash or kill (no `pagehide`; the peer would depend on
ICE consent expiry, which was not measured), laptop sleep, extension reload or
update during a call, a Chromium window close without a running service worker.

## 6. Q6: Firefox and Chromium

Firefox: **not exercised**. Playwright's Firefox could not be downloaded
(`CONNECT tunnel failed, response 403` from the organization's egress policy) and no
other route was attempted. Nothing in this document is a statement about Firefox.

Provided for the owner: the browser-agnostic probe,
`experiments/secure-comms-spike/probe/probe.html`, served by the test relay at
`http://127.0.0.1:9401/probe` (`node experiments/secure-comms-spike/server/signaling-server.js`).
"Run probe" reports which of the APIs above exist, whether `getFingerprints()` case
and the SDP agree, whether remote certificates are readable by both methods, and
what happens to a tampered answer fingerprint; "Test microphone" asks once, on the
click. Questions the probe answers for Firefox: is `getRemoteCertificates` present,
is the stats `certificate` entry with `base64Certificate` present, what case does
`getFingerprints()` use, does DTLS fail on a tampered fingerprint. Questions it
cannot answer (they need the extension): MV3 background model (service worker vs
event page), window `drawAttention`, notifications, `storage.session`, and the
extension-page microphone prompt.

Chromium differences from the Phase 0 assumptions are in sections 3 and 8.

## 7. Q7: incoming call while the window is not in front

Automated and observed (`test/q7-incoming.js`; Part B uses Chromium launched
directly with **no debugger attached**, because an attached debugger keeps
extension service workers alive and an earlier version of the experiment was
invalidated for exactly that reason). The test copies the extension into a
temporary folder with a `startup.json` that opens a background tab and starts the
polls; the shipped spike has no such file.

| Case | Result |
|---|---|
| visible popup window | call presented in 108 ms; title changed; `chrome.windows.update(drawAttention)` and `chrome.notifications.create` both accepted without API error |
| listener in a **hidden background tab** (`visibilityState hidden`, no focus), +25 s | received and presented in 113 ms, attention calls accepted |
| same tab at +122 s and +402 s | received at 55 ms and 45 ms; no `freeze` or `resume` event recorded over the whole run |
| service worker long-poll (25 s requests), **no call window open**, invite at +30 s, +120 s and +400 s | received each time (3 to 8 ms), same worker instance throughout, poll count increased steadily (18 polls in 400 s) |
| same, loop that makes **no** `chrome.*` call except on invites | also survived 400 s and received each invite |

What this means and does not mean:

* A call window that is merely in the background still receives. The SW can hold a
  poll in this Chromium and this is the most promising route for "ring when no
  window is open", but **the lifetime of a service worker is a browser policy, not
  a contract**: it held for 400 s on a zero-latency loopback here; nothing says it
  will on other versions, under memory pressure, or after sleep. The design must
  not depend on it and needs a fallback (re-establish on browser start and on the
  next wallet interaction, and show missed calls).
* The notification was **created**; whether the OS showed it, whether it makes a
  sound, and whether clicking it can open the call window (a user gesture) were not
  exercised.
* `Page.setWebLifecycleState('frozen')` was accepted on a visible page in the
  Playwright runs, but no `freeze` event followed, so a frozen-page case was not
  achieved. Real freezing/discarding of an idle hidden page, minimize and occlusion
  (no window manager under Xvfb), and system sleep are **not exercised**.
* Playwright keeps every page "visible", so hidden-tab results come only from the
  directly launched browser.

## 8. Security-boundary results

Automated (`test/security-boundary.js`, 25 assertions):

* Manifest: permissions are only `notifications` and `storage`; no content scripts,
  no `web_accessible_resources`, no `externally_connectable`; host access only to
  `http://127.0.0.1/*`.
* A hostile web page (`probe/hostile.*`) cannot `fetch` the call page, has no
  `chrome.runtime` route to the extension, cannot start a call with
  `window.postMessage`; no call window opened. (The iframe probe reports a null
  document, which is consistent with blocking but is not proof on its own; the
  `fetch` failure and the missing manifest entries are the evidence.)
* The background answers the call page and does **not** answer another page of the
  same extension: the check is on `sender.url`, not on `sender.tab` or `sender.id`
  (both are the same for any page of the extension).
* Static scans: no `MediaRecorder` or other capture-to-data API, no encrypt/decrypt
  or AES (only SHA-256 hashing and ECDSA signing from WebCrypto), no `eval`, no
  persistent storage of call material, no imports of wallet or issuer code, all test
  keys generated non-extractable (and a test confirms `exportKey` is refused).
* `git status` shows no change outside `experiments/secure-comms-spike/`.

Existing suites run to check nothing else moved (the spike touches none of them;
this is a sanity run, not coverage of the spike): moderation-unconfigured matrix 50,
presence-privacy (node) 57, presence-abuse (node) 89, mail 7, Post Office abuse 6,
page-wallet-bridge 11, bridge-sign 7, bridge-offer 15, bridge-preview 8, demo
domain B bridge 8; 258 passed, 0 failed.

## 9. Recommended changes to the Phase 0 documents (not made)

1. State that fingerprints are compared case-insensitively and normalized to one
   spelling; `getFingerprints()` is lower-case in Chromium.
2. In the verification step, specify: wait for the DTLS transport to be connected
   (do not trust `connectionState` alone); an empty `getRemoteCertificates()` is
   "unknown" and is retried; require at least one source; if two sources return
   values they must agree; fail closed.
3. Specify that no microphone track is attached to the sender until both confirms
   are exchanged (not `enabled = false`), and that mute stops the capture track.
4. Say plainly that the post-connect check cannot prevent contact with the wrong
   endpoint (address exposure), only media exchange; keep relay-only mode.
5. Specify that only the description returned by `createOffer`/`createAnswer`
   (without candidates) is signed and checked.
6. For incoming calls: a hidden window receives; do not rely on a service worker
   poll staying alive; define missed-call display and the notification-click path as
   items to verify on real hardware.
7. Cert lifetime: a generated certificate lives about 30 days; per-call certificates
   keep the signed fingerprint short-lived and avoid reuse.

## 10. Owner checklist (live verification, not done here)

1. **Real microphone prompt** (Chrome/Chromium, one machine): load the unpacked
   `experiments/secure-comms-spike/extension/`; start the relay
   (`node experiments/secure-comms-spike/server/signaling-server.js`); click the
   toolbar icon twice (two windows); paste each window's test key into the other's
   "Peer's test key" box and press Set; press Call in the first. Confirm the browser's
   prompt appears for the extension window, that nothing was requested before the
   click, that Deny leaves the call at "calling" with no media, and that Hang up
   ends the browser's recording indicator.
2. **Firefox**: open `http://127.0.0.1:9401/probe`, run both buttons, and send me the
   JSON (or screenshot) from the page.
3. **Inactive window on real hardware**: with the listener window minimized, behind
   another window, and after the machine has slept, ring it and note whether the
   notification appears, whether it is audible, and whether clicking it can open the
   call window.
4. **Two machines on different networks** and **TURN** are for Phase 1B/3; the
   relay is loopback-only and must not be exposed to do this.
5. Anything involving the real wallet, bridge refusal of `atlas.call.*`, contact
   safety codes, domain permits and cache lifetimes is untouched by 1A.

## 11. Commands and counts

All run from `experiments/secure-comms-spike/` (`./run-all.sh` runs them in order);
each writes `results/<script>.json` with its counts and observations.

| Command | Result |
|---|---|
| `node test/unit-lib.js` | 30 passed, 0 failed |
| `xvfb-run -a node test/q1-q2-mic-and-call.js` | 32 passed, 0 failed |
| `xvfb-run -a node test/q3-q4-binding.js` | 36 passed, 0 failed |
| `xvfb-run -a node test/q5-teardown.js` | 37 passed, 0 failed |
| `xvfb-run -a node test/security-boundary.js` | 25 passed, 0 failed |
| `xvfb-run -a node test/q7-incoming.js` (about 7 minutes) | 15 passed, 0 failed |

Flakiness seen and handled while building: a stats report once lacked
`inbound-rtp` for an instant (the teardown test now waits for it; three consecutive
reruns of that script passed 37/37 afterwards, and `results/q5-teardown.json` is from
one of them); the empty `getRemoteCertificates()` result in section 3 is a real
browser behavior, handled in the page code. Timing figures are from one machine's
loopback and will differ on real networks.

175 assertions in the spike. These are automated Chromium results on one
configuration; they are neither code review of the future protocol nor live
verification.
