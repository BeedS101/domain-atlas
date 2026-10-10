# Secure comms feasibility spike (Phase 1A)

A throwaway experiment that answers browser-behavior questions for the voice-call
design in `docs/voice-calls-*.md`. **It is not the Atlas calling protocol, not a
wallet feature and not a security claim.** Nothing in it is wired to the wallet
extension, the Post Office, the presence service or any deployed component.

* Synthetic test keys only (generated in the page at load, non-extractable, discarded on close).
* Message shapes are simplified and unreviewed; they exist to exercise browser APIs.
* Signalling is a loopback-only, in-memory HTTP relay (`server/signaling-server.js`) that also
  offers `/__test/*` hooks so tests can behave as a hostile relay. Never expose it.
* No recording, no custom encryption, no persistent call storage, no public signalling.
* The UI deliberately shows no "verified" state of any kind. A bank-verification badge is out of
  scope until the complete protocol is implemented and reviewed.

Findings: `docs/voice-calls-phase1a-findings.md`. Raw recorded outcomes: `results/*.json`.

## Layout

| Path | Purpose |
|---|---|
| `extension/` | Unpacked MV3 test extension "Atlas Comms Spike (test only)": call window (`call.html/js`), background worker, `spike-lib.js` (SDP checking, signed bindings) |
| `server/signaling-server.js` | Test-only loopback relay (`/send`, `/poll`, `/__test/*`) |
| `probe/probe.html` | Browser-agnostic capability probe; open `http://127.0.0.1:9401/probe` in any browser (intended for Firefox) |
| `probe/hostile.*` | A page that tries to control the extension |
| `test/` | Playwright (Chromium) experiments and Node unit tests |
| `results/` | JSON written by each test run: pass/fail counts plus the observed values |

## Running

Playwright with its bundled Chromium is required; the tests run headed under a virtual display.

```
node test/unit-lib.js                              # Node only, no browser
xvfb-run -a node test/q1-q2-mic-and-call.js        # microphone gating, two-context call, transport facts
xvfb-run -a node test/q3-q4-binding.js             # certificate / fingerprint APIs and the binding, with attacks
xvfb-run -a node test/q5-teardown.js               # hang-up, decline, lock, error, window close, mute
xvfb-run -a node test/security-boundary.js         # page / extension boundary and static scans
xvfb-run -a node test/q7-incoming.js               # incoming call while inactive; service-worker lifetime (about 7 minutes)
```

Each script starts its own relay on a fixed port in the 9411-9418 range, launches its own browser
profiles and exits non-zero on any failed assertion. Lines starting `OBSERVE:` are measurements,
not assertions.

## Not covered (see the findings document)

Firefox (no browser available in the build environment; use the probe page by hand), the real
microphone permission prompt UI (cannot be clicked by automation), physical device release,
window-manager behaviour such as minimize / occlusion, OS notification clicks, two separate
networks, TURN.
