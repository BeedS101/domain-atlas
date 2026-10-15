# Secure voice calls over the internet: findings, order of work and plan

Status: milestones 1 and 2 are implemented and tested locally (sections 3 and 4). Sections 5
to 8 are design notes for the milestones that follow; nothing in them has been built or run. Nothing is deployed, no production setting is touched, and nothing here may be called
production-ready or banking-grade. Evidence classes are the ones used in
`docs/voice-calls-phase1b.md`: **Proposed**, **Automated** (Chromium under Xvfb, loopback,
synthetic microphone), **Real hardware** (owner; only the local Windows demo with a real
microphone has been done, reported by the owner, not reproduced here).

Goal: two Domain Atlas wallets on different computers and networks make an authenticated,
encrypted voice call whether their domains run the PHP or the Node.js issuer, using only
infrastructure the domain operators host themselves (WebRTC, a self-hosted STUN/TURN
server, a Call Service per operator) and no third-party calling, signalling, STUN or TURN
service. No custom media encryption or voice protocol: media is WebRTC's DTLS-SRTP, and
the wallets authenticate the DTLS certificate fingerprints with their own signatures.

## 1. Findings

### 1.1 What the code does today

* Calling is a separate set of files (`extension/call.js`, `call.html`, `call-protocol.js`,
  `call-server/`), plus a call section in `extension/wallet.js` and a Calls tab in the
  messaging window. A person's calling settings (service address, "private test network"
  switch, contact cards, permissions) live in one encrypted store, `atlasCallState`.
* Authenticity never depends on the Call Service. It relays signed messages; the wallets
  verify identities, signed DTLS fingerprints, the remote certificate and message order.
* The caller posts the invitation to the **callee's** service, named in the callee's signed
  contact card, and both wallets then signal through that one service. A wallet therefore
  needs its own service only to *receive* calls. This matters for cross-domain calling
  (section 6).

### 1.2 The local/online settings problem

Reported: after the local Windows call server was shut down and the same Chrome profile was
used online again, the wallet was slow or frozen and appeared to log off.

Reproduced and confirmed (Automated, `test/manual-call-isolation.js`, and a negative control
against the previous code):

1. **Almost no wallet network call had a timeout.** Of the 43 `fetch` calls in
   `extension/wallet.js`, only the one in the calling code bounded its requests. A leftover local
   domain that accepts a connection and never answers (a stopped server behind a forwarded
   port, such as the Windows port forwards used in the two-PC guide, or a firewall that drops
   packets) left `checkAllMail` waiting indefinitely: still running after 60 s. The login
   handler waited for that check before refreshing the panel, and the periodic loop stalled
   behind it. Other wallet functions stayed responsive, which fits "slow", not a crash. The
   wallet's Post Office membership at `localhost:8002` created by the demo is the leftover
   that triggers it. This is older than calling, but local testing is what leaves it behind.
2. **The private-test-network switch outlived what it was for.** `setCallConfig` stored the
   "allow plain http" switch before it had verified the service. A failed or abandoned
   attempt to add a local address, or an online service saved while the box was ticked, left
   plain http allowed for private addresses. It is now meaningful only while the chosen
   service is itself a plain-http address; with an https service or none, it is off.
3. **Calling hooks in generic flows were unguarded.** `checkAllMail` read the call state
   without a guard, and `background.js` imported the calling module in the same call as the
   wallet, so a fault in either could have stopped the mail check or the whole wallet worker.
4. **Leftovers had no single remedy.** Cards and permissions naming a plain-http address
   stayed in the wallet after the local server was gone, and there was no one-step reset.
5. **A dead call service was retried forever** by an open calling window that was still
   marked Available.

Not reproduced: the wallet **logging off**. Auto-lock is off by default; no code path in
calling locks the wallet (searched: the calling window only reacts to a lock, it never causes
one); a service that is gone does not lock anything (Automated). Reloading the unpacked
extension (to pick up a delivered update) clears the wallet's session storage by design and
locks the wallet, which looks the same to the user. If it happens again without an
extension reload, note whether an auto-lock time is set and what the wallet showed.

### 1.3 Other observations

* The calling window's activity does not count as "activity" for the wallet's idle
  auto-lock (only a connected call does). With auto-lock turned on, a person waiting in the
  calling window as Available is locked out after the idle time and the window shows the
  locked screen. This is conservative; it is documented, not changed.
* `callPost` and the long polls set their own deadlines and are not affected by the new
  wallet-wide timeout.

## 2. Safest order of work

| # | Milestone | Why in this order |
|---|---|---|
| 1 | Configuration isolation and online-readiness review (done, section 3) | The wallet must stay healthy whatever calling does; nothing else is safe to test on real networks until this holds |
| 2 | Node Call Service ready for https on a test host (done as code, tests and a deployment guide, section 4); then wallet to wallet across two networks, **with** a self-hosted STUN (owner, on a real host) | Smallest real-network step: no change to the signed protocol, only safeguards and deployment; shows how often direct connections work |
| 3 | TURN: coturn plus ephemeral credentials issued by the Call Service (Node first), wallet support for TURN credentials (done as code, simulated-server tests and a guide, section 7; **coturn itself not run**) | Direct connections fail on many home and mobile networks; needed before any real demonstration |
| 4 | Multi-domain admission (section 6) | Small server and wallet change; needed before a second operator joins |
| 5 | Native PHP Call Service with shared test vectors and a Node-wallet-to-PHP-service test | The largest piece; built against the now-stable protocol |
| 6 | Cross-implementation matrix: PHP-issuer wallet and Node-issuer wallet, services both ways | The demonstration scenario |
| 7 | Hardening review and the owner's real-hardware runs | Before anyone is invited to use it |

Steps 2 and 3 can be done with the Node service alone; the PHP service is not on the critical
path for proving the internet path works.

## 3. Milestone 1: what changed (Automated)

All in `extension/`; nothing in Domain Atlas Core, the issuers, the presence servers,
`SPEC.md` or `manifest.json`.

| Change | File | Effect |
|---|---|---|
| Bounded `fetch` for every wallet request to a domain (30 s), with a short memory of origins that just failed (30 s, doubling to 10 min) | `wallet.js` | A hung domain costs at most one timeout, then is skipped by the background loops (mail check, forgetting messages, friend notices) until its rest period ends. Anything the person starts by hand still tries. Call service requests keep their own deadlines |
| Login refresh shows stored data first, then checks mail | `viewer.js` | The panel is usable at once even when a domain is slow |
| The private-test-network switch counts only while the saved service is plain http; saving an https service turns it off | `wallet.js` | A switch left on during local testing cannot widen what the wallet connects to online |
| `setCallConfig` stores nothing until the service has answered correctly | `wallet.js` | A failed attempt leaves the settings exactly as they were |
| Cards and permissions naming plain-http addresses are removed when the switch goes off; new `resetCallSettings()` | `wallet.js` | One step returns calling to "not set up"; contacts, verification, mail and assets are untouched. The "Remove" button in the calling window uses it |
| Call state read in `checkAllMail` is guarded | `wallet.js` | Unreadable or malformed calling data cannot stop a mail check |
| `background.js` imports the wallet first and the calling module separately, guarded | `background.js` | A missing or broken calling module leaves the wallet fully working; calling reports that it is unavailable |
| A listening window gives up after 10 minutes of continuous service failure and turns availability off | `call.js` | No endless retrying against a dead service |

Tests: `test/manual-call-isolation.js` (24 checks) covers a hung domain (and that identity
and assets stay available meanwhile), unchanged settings after a failed attempt, the switch
dying with the plain-http service, the wallet refusing a local plain-http address once an
https service is saved, reset, leftover cards, unreadable and wrong-shaped calling data, a
copy of the extension with `call-protocol.js` deleted, and a dead service being given up on.
Run against the previous extension files as a negative control, five of its checks fail,
including the hung-domain ones.

## 4. Running the Node Call Service securely over https (milestone 2)

### 4.1 What was already right (code review, milestone 1)

* https is required for the service address in the wallet (`redirect: 'error'`, plain http only
  behind the test switch for private addresses) and in the service's own configuration.
* Responses are `Cache-Control: no-store` and `nosniff`; requests are size-capped per route,
  rate-limited per source, per caller and per callee; state is bounded and swept.
* The service answers `503` for everything until configured and creates no file unless a state
  file is named. Tags are stored only as SHA-256 hashes. Logging holds no identities.

### 4.2 What changed in milestone 2 (Automated; code in `call-server/`, one small change in `extension/call.js`)

No change to the signed protocol (`protocol.js` and `extension/call-protocol.js` are untouched
and still byte-identical), to authentication, replay protection, fingerprints, consent or audio.

| Gap found in the review | Change | Evidence |
|---|---|---|
| Held connections capped globally only | per-source cap on held listens and polls (`maxWaitersPerSource`, 20), per-source cap on requests in flight (60), sockets per source when exposed directly (100), global connection cap (3000) | `manual-call-internet-security.js` |
| Anonymous keys could fill the held-connection table: a listen needs only a self-made key | owners that hold no tag share a smaller pool (`maxStrangerWaiters`, 500) and cannot create mailboxes past `maxListeners`, so people who can receive calls are still served | same |
| A full table answered `200` with no events, which made a wallet retry in a tight loop | refused with `503 busy` or `429 too-many-connections` and `Retry-After`; the wallet waits 5 s on `429` | same |
| A held request was not released when the client disconnected (it waited out the 25 s hold) | released at once; a wallet that listens again replaces its own earlier request | same; probe against the previous code: waiters stayed at 5 after an abort |
| Slow bodies and large headers | whole body within 10 s (`408`), header block 8 KiB | same |
| CORS `*` on the invite route | none by default; web page `Origin` refused (`403`); `Content-Type: application/json` required (`415`) so a cross-site form post cannot reach the service; optional exact-origin allow-list for the invite route only | same; probe: previous code answered `Access-Control-Allow-Origin: *` |
| `X-Forwarded-For` trusted from any connection when `CALL_TRUST_PROXY=1` | honoured only from `CALL_PROXY_ADDRS` (default loopback), last entry, must be an IP; IPv6 keyed on /64 | same, and through a stand-in TLS proxy in `manual-call-proxy.js` |
| A proxy that forwards plain http, or is bypassed, went unnoticed | with an https origin behind a trusted proxy, requests must come from it and say `X-Forwarded-Proto: https` (`400 https-required`; `info` exempt) | same |
| STUN setting only checked loosely | `stun:host[:port]` only, at most three, names or IP literals, public third-party STUN services refused; wallet passes the browser at most three plain STUN URLs and drops anything else | `manual-call-internet-security.js`, `manual-call-stun.js` (two real browsers; a local STUN responder confirms the browser queries the operator's server) |
| Limits could only be changed in code | `limits` in the settings file or `CALL_LIMIT_<NAME>`, each with a range | same |
| No way to check a deployment from outside | `call-server/check-deployment.js` | `manual-call-proxy.js` |
| No deployment material | `call-server/deploy/` (nginx, Caddy, systemd, settings, STUN-only coturn) and `docs/voice-calls-deploy-node.md` | file contents checked by test; **not started on a real server** |

Still inactive by default: with no settings the service answers `503 calls-not-configured` on
every route but `info`, listens on loopback and creates no file; the new settings add nothing
that starts on its own (`manual-call-unconfigured.js` and the security suite). The wallet side is
unchanged except the STUN filter; calling stays optional and isolated as in milestone 1.

### 4.3 What the operator must provide

See `docs/voice-calls-deploy-node.md`: host name and certificate, a reverse proxy in front of a
loopback-only service, the domain's pinned public key(s) and revocation URL, a state file,
systemd, synchronized clocks, and a firewall that exposes 443 only. A STUN/TURN server needs its
own ports (section 7).

### 4.4 Gaps that remain

| Gap | Status |
|---|---|
| ICE answer lists STUN only (`turn: false`) | done in milestone 3 when `CALL_TURN_URLS` and a secret are set (section 7); still STUN only otherwise |
| `info` reports no admitted domains | not built (section 6.2) |
| No graceful drain on shutdown beyond closing connections | acceptable: callers see "not available" and retry |
| The wallet takes the service address by hand | optional later: a reference-implementation manifest field naming the domain's call service, suggested to the person and confirmed by them, like the existing `presence` and `postOffice` fields (not part of `SPEC.md`) |
| Pinned issuer keys have a documented rotation procedure but no automatic refresh | procedure in `docs/voice-calls-deploy-node.md` section 11; an optional timed refresh from the listed domain's own key document is not built (section 6.2) |
| Nothing has run on a real server, behind real nginx/Caddy, across real networks, or under real load; the limits are starting points | owner, with the guide |
| Several people behind one shared address share one set of per-source limits | tunable; documented |
| Many proxies or a CDN in front change which forwarded address is the real one | not supported at this stage; one proxy on the same host |

## 5. Native PHP signalling service (built in milestone 4)

Status: built and tested on Linux over loopback (`call-php/`, `docs/voice-calls-deploy-php.md`,
`docs/voice-calls-test-plan.md` section 9). Never run on a real PHP host. Where the design below
differs from what was built: it needs PHP 7.4 or newer (not 8.0); the folder is `atlas/call/` in the
domain root, next to the issuer's `atlas/`, not a top-level `call/`; state lives in many small files
(calls, tags, listeners and request records sharded by hash) rather than one JSON file, under one
global lock; the wallet takes its re-ask delay from the service's `nextPollMs` hint; and the shared
vectors became a differential test that compares the PHP and Node implementations on generated and
mutated messages (`test/manual-call-php-protocol.js`).

### 5.1 Feasibility

Technically feasible on conventional PHP hosting, with different performance. The signed
protocol is transport independent (`extension/call-protocol.js` is the specification of every
rule); the PHP service ports the route handlers and the call state, not new cryptography.

* PHP 7.4 or newer with `openssl`, `hash` and `json`; no extensions beyond those the PHP issuer already
  needs (`issuer-php/lib/bootstrap.php` already verifies raw ECDSA P-256 envelopes with
  `openssl_verify`).
* Layout and conventions follow `presence-php/`: a `call/` folder, one PHP file per route, a
  `lib/` folder denied to the web (`.htaccess`), a `bootstrap.php`, JSON state files under
  `lib/` read-modify-written under `flock`, retention by sweeping on every locked write, and a
  `test-router.php` for `php -S` testing. No database, no Composer packages.

### 5.2 Differences from the Node service, and why they are acceptable

| Topic | Node | PHP |
|---|---|---|
| Waiting for events | long poll, held up to 25 s | short poll answered at once, the wallet re-asking every 1 to 2 s (a held connection occupies a PHP worker for its whole length and shared hosts allow few); a hold of 0 to 3 s is a setting |
| Timers (ring, accept to offer, ICE, retention) | in-process | stored as expiry times in the state and enforced when the next request arrives; the wallets also enforce their own timers, so a missing sweep delays cleanup but weakens nothing |
| Rate limits | in-memory counters | counters in the state file, rewritten under the same lock |
| Concurrency | single process | one global file lock per request; adequate for a small site, not a busy one; state is partitioned per call if needed |
| Replay protection | nonce map in memory | nonces with expiry in the state file (same sizes) |

Cost of short polling: call set-up is about six sequential messages, so a 1.5 s poll adds
roughly 5 to 10 s to the first ring and the connection. A listening wallet makes about one
request per interval for as long as it is Available, so the hosting plan's request budget is
the real limit; the wallet needs a poll interval taken from `info` (a small addition) so an
operator can choose it.

### 5.3 What makes the two interoperable (the part that must not drift)

* **Canonical JSON and hashing.** Every signature covers the canonical form produced by
  `canonicalize` in `call-protocol.js`. PHP must reproduce it byte for byte (key order, number
  and string escaping, no insignificant whitespace). The PHP issuer already has a canonicalizer;
  it is reused only after it has been checked against shared vectors.
* **Shared test vectors.** A script generates a JSON file of cases from the JavaScript module
  (valid and invalid payloads of every type with their signatures, hashes, fingerprints and
  expected verdicts). The PHP tests and the Node tests both consume it, and a failing vector is a
  failing build for either side. A second file records full call transcripts captured from the
  Node service that the PHP service must accept unchanged.
* **Cross tests.** The browser tests in `test/manual-call-*.js` already take a service by
  origin; they are run once against Node and once against `php -S`, and a mixed case runs the
  caller's wallet against one implementation and the callee's against the other (two services,
  because the caller uses the callee's).
* **Error semantics.** The `404 unavailable` uniformity, status codes, reason codes and field
  names are part of the protocol document (`docs/voice-calls-endpoints-and-state.md`); the PHP
  code cites section numbers rather than restating them.

Hosting limits that remain: no cron (sweeping on requests only), `flock` on network file
systems can be unreliable, hosts that kill scripts after a short time are fine for short polls
but not for any hold, and the file store does not scale to many simultaneous listeners.

## 6. Cross-domain admission (Proposed; section 6.1 tested in milestone 4)

Milestone 4 tested the situation section 6.1 describes, which needs no new mechanism: two services
on two domains with two issuers, in every Node/PHP pairing that includes PHP, and two real
browser wallets listening on different services. The admission list in section 6.2 was **not**
built.

### 6.1 What is actually restricted today

The service admits only wallets that present a Post Office membership credential from one
configured domain (`CALL_DOMAIN`, signature checked against `CALL_ISSUER_KEYS`, optionally
against that domain's revocation list). Only the **callee** needs this: it is the callee that
creates tags and listens. A **caller** needs no admission at all; it is authorised by the
callee's tag bound to its key and by its own signature. So a wallet of domain A can already call a wallet
of domain B when B's wallet listens on B's service, which is the normal arrangement: each
wallet uses its own domain's service, and a call runs through the callee's.

The restriction bites in two cases: a domain with no call service whose members want to
receive calls elsewhere, and an operator who wants to serve several domains (a hosting
provider or a community).

### 6.2 Proposed minimal mechanism

* **An explicit admission list on the service**, in the shape the presence moderation
  configuration already uses: a list of `{ domain, issuerKeys[] }`, set by the operator
  (`CALL_ADMIT` as JSON, or a config file entry), replacing the single `CALL_DOMAIN` /
  `CALL_ISSUER_KEYS` pair (which stays as the one-entry shorthand). A membership credential is
  accepted only if its `issuer.domain` is in the list and its signature verifies against that
  entry's pinned keys. Optional per-domain revocation URL.
* **`info` advertises the list** (`admits: [domains]`). A wallet picks a membership it holds
  from one of them; a wallet with none is told which Post Offices to join.
* **No fetching on behalf of a request.** Keys are pinned by the operator, not fetched from the
  presenter, which keeps the SSRF and key-substitution surface closed. A later optional step
  may refresh the key sets of listed domains from their `/.well-known/atlas-key.json` over
  https on a timer, never for an unlisted domain.
* **Who is admitted is a resource decision, not an identity decision.** Admission only
  controls who may create tags and consume the operator's capacity; it never makes anyone
  trusted. Authenticity still comes from the wallets' signatures and the contact's safety code.
* The same list shape works in the PHP service (JSON config in `lib/`).

Open points to settle before building: whether the wallet's contact-card delivery (today sent
through the Post Office of the service's domain to the contact's address) works across the PHP and
Node issuers' Post Office federation for all pairs, which is covered by existing relay tests for
mail but has not been run for call cards (needs a PHP issuer and a Node issuer started together).

### 6.3 What is deliberately not proposed

Open admission for any wallet key, or a shared central admission service, or trusting a domain
because a request claims it. Each would either create an abuse surface without an operator
decision or reintroduce a mandatory central party.

## 7. Self-hosted STUN and TURN

Status: milestone 3 implemented the credential scheme, the service and wallet changes and the
tests; the operator guide is `docs/voice-calls-deploy-turn.md`. The text below was the proposal;
where the build differs, the guide and `call-server/README.md` are authoritative (differences:
the user name is `<expiry>:<random label>`, not `<expiry>:<callId>`, so TURN logs hold nothing
about the call; the lifetime is `CALL_TURN_TTL_SECONDS`, default one hour, because the browser
cannot take a new credential during a call; the wallet accepts only ports 80, 443, 3478 and 5349
and refuses private addresses outside the private test network). coturn has not been run.

Use coturn. (`call-server/deploy/coturn-stun-only.conf.example` runs it in `stun-only` mode with no secret and nothing relayed; `coturn-turn.conf.example` adds relaying with credentials.) It is established, open source, supports STUN and TURN over UDP, TCP and TLS, and
has a built-in ephemeral-credential mode (TURN REST API) that needs no database.

* **Where:** a small VPS with a public IPv4 address; it cannot run on shared PHP hosting. One
  operator may serve their own members, or several operators may pool one.
* **Credentials:** `use-auth-secret` with a `static-auth-secret` shared between coturn and the
  Call Service. The service's `ice` route (already authenticated by the call key and answered
  only after the call is accepted) returns `username = <expiry>:<callId>` and
  `credential = base64(HMAC-SHA1(secret, username))`, valid for 10 minutes. This is a few lines
  in Node (`crypto`) and PHP (`hash_hmac`) and is identical in both. TURN never sees an identity
  that the service has not already seen.
* **coturn settings to require:** `no-cli`, `no-tcp-relay` unless needed, `denied-peer-ip` for
  loopback, private, link-local and multicast ranges (so the relay cannot be used to reach the
  operator's internal network), `user-quota` and `total-quota`, `max-bps`, a limited relay port
  range (for example 49152 to 49999) with the matching firewall rule, `fingerprint`, TLS with a
  real certificate on 5349 and, where it helps get through restrictive firewalls, on 443;
  `external-ip` when behind NAT; logging without usernames beyond what the operator needs.
* **Wallet changes needed:** accept `username` and `credential` in the ICE answer, validate the
  URL schemes (`stun:`, `turn:`, `turns:` only), and keep the existing rule that
  nothing is exchanged before both signed confirmations and the certificate check. A
  "relay only" setting (hide the person's own address from the contact) is a later, optional
  step already described in `docs/voice-calls-deployment.md`.
* **What TURN can and cannot see:** the two parties' network addresses and traffic volume. It
  cannot read audio: media stays DTLS-SRTP between the browsers, and the DTLS fingerprints are
  signed by the wallets' identity keys, so a relay cannot substitute itself.
* **Bandwidth:** `docs/voice-calls-deployment.md` section 3 estimates 45 to 60 kbit/s on the wire
  per direction for Opus voice; a relayed call passes both directions through the server, about
  0.1 Mbit/s each way per call, so 100 simultaneous relayed calls are roughly 9 to 12 Mbit/s each
  way. These are estimates; measure on the real host before relying on them.

## 8. What stays unchanged

Wallet-controlled consent (permission is granted per contact, the callee decides each call),
mutual identity authentication, signed fingerprints, verified remote certificate before any
microphone audio, replay protection and the uniform refusal behaviour, no recording, no public
directory of wallets, calling optional and isolated (section 3). Domain Atlas Core,
`SPEC.md`, the issuers and the presence services are untouched by milestone 1.

## 9. Still requires the owner or a real host

* Milestone 1 on the owner's actual wallet profile: the owner reports normal online use
  working with the local calling server off. What the "logging off" turned out to be, if it
  recurs, is still unknown.
* Milestone 2 on a real server (`docs/voice-calls-deploy-node.md`): a host name, a certificate,
  a reverse proxy (the nginx and Caddy examples were never started), systemd, the deployment
  checker against the real address, a STUN server (coturn was never run), and two PCs on
  different internet connections with and without STUN.
* Milestone 3 on a real host: a VPS running coturn with `coturn-turn.conf.example`, `turn-probe.js`
  against it, and relayed calls between two real networks (`docs/voice-calls-deploy-turn.md`
  section 11 lists what is unverified).
* Milestone 4 on real PHP hosting (`docs/voice-calls-deploy-php.md` section 10): Apache with the
  shipped `.htaccess` files, the deployment checker against the real address, the host's request
  and CPU limits with wallets polling, then a real call between two wallets on two networks
  through a PHP-hosted service, tried with direct connections first.
* The checks listed in `docs/voice-calls-phase1b.md` section 3.3 that no automated test can
  make: the real microphone prompt, hidden or sleeping windows, the operating system's
  recording indicator, passkey identities, Firefox and branded Chrome.
