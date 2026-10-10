# Secure voice calls: threat model

Status: proposal for review, part of the voice-call design set (see
`docs/voice-calls-architecture.md`). This is an analysis of the *design*. No
code exists, so no mitigation below has been tested; each row names the test
that will check it (`docs/voice-calls-test-plan.md`). Nothing here is a claim
of banking-grade security, and the design has had no independent review.

## 1. Assets and assumptions

Assets, most to least sensitive: (a) the privacy of conversation audio;
(b) the wallet identity key and the right to sign as it; (c) the user's
attention and safety (unwanted or deceptive calls); (d) the relationship graph
(who calls whom, when); (e) network addresses of the two endpoints;
(f) availability of calling.

Assumptions the design rests on:

* TLS and DNS for the Call Service and for a domain's `.well-known` files hold.
  A domain takeover gives the attacker what it already gives for assets
  (`SPEC.md` section 9); optional identity pinning (section 3.7) narrows that
  for returning wallets.
* The browser's DTLS-SRTP and certificate-fingerprint verification are correct.
* The user's device, operating system, browser profile and installed
  extensions are not compromised (section 8 lists what follows if they are).
* A user who approves a prompt has read it. The design tries to make the prompt
  worth reading, and does not rely on it alone for domain-bound permits.

## 2. Attacker classes

| Class | Capability |
|---|---|
| A1 network attacker | observes or alters traffic between wallet and Call Service, or between peers; cannot break TLS |
| A2 malicious or compromised Call Service operator | full control of the service: drop, delay, reorder, replay, inject, log, read metadata, lie |
| A3 malicious TURN/STUN operator | relays or observes packets and addresses; cannot read SRTP |
| A4 malicious web page | any origin the user visits, including one whose script runs in the page the extension injects into |
| A5 stranger with a wallet | can generate keys freely, can read anything public |
| A6 malicious or compromised domain | controls its own endpoints, delegations and web content; may be legitimate yet dishonest (voice phishing) |
| A7 compromised agent or endpoint of a legitimate domain | holds an agent key, calls within its delegation |
| A8 malicious or compromised peer | the other participant of a call, who can record or lie |
| A9 local attacker | malware, malicious extension or someone at an unlocked machine (section 8) |

## 3. Messages that are only authenticated to the service

`decline` and `busy` are authenticated to the Call Service by the callee's
listening session (mode C), but the caller cannot verify that session's key and
so cannot tell a real decline from one the service invented. This is accepted:
the service can end any call by dropping messages, so a forged decline gives it
nothing new, except that it can make the caller *believe* the callee refused.
The caller UI therefore shows both as the neutral "not answered" and never as
"X declined your call". After `accept`, every control message including
`cancel` and `end` is signed with `CK`, which costs no user gesture and which the
other side verifies.

## 4. Impersonation

| ID | Threat | Mitigation | Residual | Test |
|---|---|---|---|---|
| I1 | A stranger rings a wallet pretending to be a contact | A tag is bound to one caller key; the invite must be signed by it, and the callee wallet re-verifies. A display name is never an input to any decision; the wallet shows the contact's stored name only after the key matches | none beyond key compromise (section 7) | S6 |
| I2 | Attacker calls using a leaked tag | Tag alone does nothing without the bound principal's signature; tags expire, have budgets, and are revocable | A leaked tag lets the attacker cost the callee a rate-limit slot at the Call Service | S6, S16 |
| I3 | Third party forwards a victim's signed accept to a different invite (unknown key share) | `accept` signs a hash of the exact invite payload, the `callId` and both nonces | none identified | S7 |
| I4 | Look-alike domain (`examp1e.com`, homoglyph/IDN) | Domain identity is the exact registrable name fetched over TLS; the wallet shows the ASCII (punycode) form beside any Unicode form, and flags mixed-script names; a display name is never shown as the domain | A user can still be fooled by a look-alike they have granted a permit to; permits are per-domain, explicit, and listed | D-domain-IDN |
| I5 | An agent claims a department or employee they do not hold | Department is shown verified only when listed in the domain-signed delegation; an employee name is shown as "stated by the calling system", never as verified | A compromised calling backend can name any employee within the delegation | D-dept |
| I6 | A page spoofs the incoming-call or permit screen, including by opening a look-alike window | The real screens are drawn in extension-origin windows or overlays the page cannot script (as the existing signing prompt); the permit prompt takes the origin from the browser, never from the page. A look-alike window cannot be prevented, so the real screens show a personal security phrase the user chose and a page cannot read (D14) | A user who has not set or does not check the phrase can be deceived | S17, D-permit, S30 |
| I7 | Caller-ID style spoofing of the Call Service | Authenticity never comes from the service; it comes from signatures (sections 5 and 6) | none, once the contact's key is correct (I8) | S4 |
| I8 | The mail relay (by default also the Call Service operator) substitutes a contact's key or alters a call card at friend-add time | Cards are signed by the contact's `IK` and accepted only if the signer equals the key already stored for that contact; **but the first key is learned through the relay**. The wallet offers *Verify contact* (a safety code compared over another channel), labels unverified contacts, and warns on any key change. Without verification the design is only as strong as the relay | An unverified contact added through a hostile relay is impersonated, including the saved name. This is the largest residual risk in wallet-to-wallet calling | S27, S28 |

## 5. Man in the middle and malicious services

| ID | Threat | Mitigation | Residual | Test |
|---|---|---|---|---|
| M1 | A2 or A1 swaps the DTLS certificate to relay and listen | Fingerprints are signed by the callers' keys before any SDP exists; every SDP must contain exactly those; after connect the wallet hashes the certificate actually presented by the peer and compares | A bug in SDP parsing is the weak point; covered by strict parsing and the independent post-connect check | S8, S13 |
| M2 | A2 rewrites SDP non-security fields (ICE credentials, codecs) | Every SDP is signed by `CK` and bound to the transcript hash; modification fails verification | none | S9 |
| M3 | A2 mediates both legs (talks to each with its own keys) | It would have to sign the first message with a victim identity key or a call key authorized by one; it has neither. It can do this only for a contact whose key it substituted earlier (I8) | I8 | S4, S7, S28 |
| M4 | A2 delivers the right messages to the wrong wallet (tag misrouting) | For wallet calls the caller knows the expected callee key from the call card and rejects an `accept` signed by any other key. For domain calls the domain cannot detect misrouting, because it deliberately does not know the callee; the callee's `PK` (generated for this permit) is checked, so a service that routes to a *different* wallet cannot answer correctly without the permit key | The Call Service operator can, with the cooperation of a wallet holding the permit, route to it; that is the operator the user chose | S7, D-permit |
| M5 | A3 relays media | TURN sees only SRTP; same fingerprint checks hold on a relayed path | TURN learns addresses and timing | N3, N6 |
| M6 | A2 holds or drops messages (denial of service, targeted) | Not preventable; every state has a timer and ends cleanly, the caller is told "unavailable" | availability depends on the operator | S23 |
| M7 | A2 reorders or duplicates control messages | Per-sender sequence numbers inside signed messages, accepted once and in order; `th` binds invite and accept, `offerHash` binds the answer to the exact offer, and `confirm` carries both hashes | none | S10 |
| M8 | A2 fakes a decline or busy | Cannot be prevented or verified (section 3); the UI shows "not answered", never "declined" | nuisance | S23 |
| M9 | A2 or a stranger enumerates which wallets exist | One identical refusal for every non-tag-holder cause; tags are 128-bit random; no listing endpoint | timing: the refusal must cost the same (test); the operator knows its own members | S15 |
| M10 | TLS stripping or a bad certificate on the Call Service | Plain HTTP refused (except `localhost`); certificate errors are hard failures in the wallet's fetch, like the rest of the protocol | none | S21 |
| M11 | Downgrade to unencrypted or SDES media | SDP validation rejects SDES, non-DTLS profiles, any non-SHA-256 fingerprint | none | S8 |
| M12 | A2 reads the network addresses in SDP and candidates | Not prevented: SDP and candidates pass through the service in the clear (decision D15 would seal them) | the operator learns both parties' addresses, host addresses included | none (documented) |

## 6. Replay

| ID | Threat | Mitigation | Residual | Test |
|---|---|---|---|---|
| R1 | Replay of an old `invite` (to the same Call Service, a second one, or the same wallet again) | `audience` binds a Call Service origin; `expiresAt` at most 60 s; the callee remembers each `callId` for the validity window plus skew (kept in session storage so a restart does not forget); the service dedupes too. A replay can at most ring once and cannot reach `confirm` because `CK_a`'s private key is not in the invite | a replay inside the window to a callee that lost its cache rings a second time | S3 |
| R2 | Replay of `accept` or any `CK`-signed message | bound to `callId`, `th` and a strictly increasing `seq`; the call state machine accepts each message type only in its state | none | S7, S10 |
| R3 | Replay of a domain delegation or agent certificate | A delegation is meant to be presented many times; what stops replay as a *call* is that the invite signed by `EK` has its own `callId`, nonce and 60 s life. A stolen delegation without `EK` rings nothing | a stolen `EK` inside its life (at most 8 h) can place calls within scope, for a user with a permit for that domain | D-chain |
| R4 | Replay of a listening-session request | nonce per `SK` recorded for the acceptance window, as for mail reads; session life at most 60 min | none | S22 |
| R5 | Clock skew makes a valid call fail or a stale one pass | the service accepts request `issuedAt` within 120 s, as mail reads do, and returns `serverTime` for one retry; a wallet judging an invitation allows 30 s and a 60 s life | a user with a wildly wrong clock cannot call | S26 |

## 7. Key rotation and compromise

| ID | Event | Consequence and handling | Test |
|---|---|---|---|
| K1 | Wallet identity key lost or replaced | Tags and call cards bound to the old key stop working (fail closed). There is no continuity claim for visitor keys in this spec; the user re-issues cards from the new identity | S6 |
| K2 | Wallet identity key stolen | The thief can place calls as the user to everyone holding a card for that key, and can open listening sessions for the tags registered under it. Remedy is the existing one: replace the identity and have the operator revoke the membership, which also removes the inbox and its tags. Contacts' cards stay valid for the thief until they are told; a signed key-retired notice is decision D16 | n/a (identity theft is outside this design) |
| K3 | Domain key rotates | The wallet requires the delegation's signing key to be valid **now** and `notAfter` not beyond the key's `validUntil`, so delegations signed by a rotated-out key stop verifying at once and must be re-issued; asset credentials keep the section 5.3 rule because they must outlive rotations | D-chain |
| K3b | Backdated delegation: a rotated-out or stolen key signs a delegation whose `issuedAt` falls inside the key's old validity window | Rejected by the rule in K3 (and `issuedAt` in the future is rejected). Revocation by id alone could not cover a delegation nobody has seen | D-chain |
| K4 | Domain key compromised | The attacker can mint delegations. Rotate immediately (which invalidates its delegations, K3) and revoke known delegations by id in `atlas-revocations.json`. Because keys in `atlas-key.json` have no recorded purpose, a call-delegation key can also mint assets: keep it offline, and see decision D6 (`usage`) | D-chain |
| K5 | `CAK` compromised | Attacker can mint agent certificates inside the delegation's scope until the delegation is revoked. Short delegation life and revocation bound it | D-chain |
| K6 | `EK` / agent endpoint compromised | Attacker calls within the delegation's purposes and the permits users granted, for at most the certificate life (8 h). Wallet shows the department/purpose it was authorized for; revocation by certificate id is not in the minimal protocol (would need a list); the wallet's per-permit call budget limits damage | D-chain |
| K7 | Call Service compromised | No loss of authenticity or confidentiality (section 5). The operator learns metadata and can deny service. It could also hand out *its own* tags, which wallets would only accept from the user's explicit card flow | S15 |
| K8 | `PK` lost | The permit dies; the domain gets "unavailable" and the user re-grants | D-permit |
| K9 | `SK` stolen | For at most 60 min the thief can read waiting invitations (caller identity), acknowledge them (consuming them), decline or report busy, and revoke single tags (denial of service). It cannot call, accept, create tags, revoke all tags, or read any call's `CK`-protected mailbox | S22 |
| K10 | `CK` stolen (a compromised call window) | Authority ends with that call | S10, S23 |

## 8. Compromised devices, pages and peers

| ID | Threat | Handling | Residual / not claimed |
|---|---|---|---|
| C1 | Malware, a malicious extension, or a person at an unlocked machine | Not defended. Such an attacker can open the microphone, sign as the user, or read the screen. The design only avoids making it easier: no background listening, no auto-accept, microphone only in a visible window | out of scope |
| C2 | A web page tries to start, answer or monitor a call, or to sign | Phase 1 exposes no call API to pages. Call control runs only in `call.html`, which is not web-accessible; handlers accept messages only when `sender.url` begins with the call page's own `chrome-extension://` URL (an extension window also has `sender.tab`, and a content script has the extension's `sender.id`, so neither is a usable test). Phase 2 adds only the permit request, with an extension-side schema and origin check | S17 |
| C2b | A page uses the existing signing bridge as a signing oracle for a call message (an `atlas.call.listen-session` naming its own key, or a tag creation) by adding a whitelisted `purpose` | The bridge refuses any payload whose `type` starts with `atlas.call.`; call payloads may not contain `purpose`. The overlay shows the payload but is not relied on | A user would still be asked only for payload types the bridge allows | S17 |
| C3 | A page frames the call UI (clickjacking) | `call.html` is not in `web_accessible_resources`, so it cannot be framed by a page; the permit overlay is extension-drawn with the existing inactivity denial | S17 |
| C4 | A malicious peer records the audio | Not preventable by any encryption: the peer receives plaintext audio. No recording by default in this design; the wallet cannot detect a recorder | analog hole, stated plainly to users |
| C5 | A malicious peer supplies ICE candidates to make the callee send UDP/STUN to arbitrary addresses (internal host probing, reflection) | Candidates are accepted only after the signed offer/answer verified, only in signed batches, capped (20 per call), and filtered: loopback, link-local and multicast are dropped; private ranges are dropped when the peer is a domain caller | wallet-to-wallet on one LAN must accept private ranges; a hostile contact can still probe a bounded number of addresses once per accepted call | S12 |
| C6 | A network address is leaked by ringing | Candidates and SDP are not sent until `accept`. Chrome hides host addresses behind mDNS names only when no microphone permission is held, so after the call window has microphone access local addresses may appear in candidates (to be verified in Phase 1) | relay-only mode (Phase 3) hides the address from the peer; the Call Service still sees addresses (M12) | S12, L7 |
| C7 | Microphone opened without the user's intent | the microphone is opened only from a *Call* or *Accept* click in `call.html` (the browser prompts only the first time; later calls rely on the click and the visible window); tracks are stopped on every terminal state; Mute releases the device; tests count `getUserMedia` calls | none identified | S19 |

## 9. Unwanted calls

| ID | Threat | Mitigation | Residual |
|---|---|---|---|
| U1 | Spam from strangers | no tag, no ring; strangers can only send a mail request subject to existing block list and friends-only rules | spam mail requests (existing mail abuse model) |
| U2 | Harassment by a contact | per-principal block removes tags at the Call Service and in the wallet; three explicit declines in 24 h pause the tag (with Undo; missed rings while unavailable never count); do-not-disturb | a contact can still leave the user a pending request |
| U3 | Robocalling by a domain | domain requires a permit with a call budget; unverified domain calls never ring; per-domain rate limits at the Call Service; *Block this domain* removes all its permits | a legitimate, permitted domain may still call the permitted number of times |
| U4 | Call bombing with a leaked tag or many fake principals | tag binding, per-tag ringing slot (one at a time), per-callee, per-source and global limits, long-poll caps | an attacker with many sources and valid tags is limited by the tags' budgets |
| U5 | Voice phishing by a *verified* domain or compromised agent | Verification shows who is calling, not that the request is safe; the three rows are separate; the purpose is shown as the domain's claim; there is no approve/sign action inside a call; a banner appears if a send or recovery screen is opened during a domain call; a "verify in the wallet" callback is recorded for later (D8) | social engineering remains possible; the cryptography cannot prevent a genuine domain from asking for something harmful |
| U7 | A tag holder learns whether the user is online or busy | Accepted for people the user chose to give a card or permit (D12); Do not disturb is answered like offline | availability is visible to contacts and permitted domains |
| U6 | A caller keeps ringing after hang-up | ring TTL 60 s, one outstanding invite per tag, state deleted on end | none |

## 10. Privacy

| ID | Concern | Handling |
|---|---|---|
| P1 | Permanent wallet identifiers in public data | none are published: no directory, no presence use, tags are random and secret; the Call Service holds only what the wallet registered with it |
| P2 | A domain linking a user across domains | domain calls use a per-permit `PK`, never `IK`. Limits: the Call Service operator sees `IK` and `PK` together; a calling domain that is also the user's operator learns `IK`; the permit reveals the operator's URL, so colluding domains can correlate; unlinkable only against non-colluding domains with a different operator |
| P3 | Metadata held by the Call Service | caller principal (a wallet caller's `IK`, even for a caller who never joined this operator), tag, times, outcome, and both parties' network addresses from SDP and candidates. No call history is kept: state is in memory and deleted 60 s after the end; tags persist; logs hold counters only (test checks that logs contain no keys, tags or SDP) |
| P4 | Network addresses | exchanged between the peers only after accept; the Call Service sees them in transit (M12); relay-only option in Phase 3 hides them from the peer |
| P7 | A calling domain learns that the user is online and their address before Accept by watching file fetches | the wallet verifies from a cache refreshed independently of calls (architecture 8.6), so no fetch happens at ring time; the scheduled refreshes still reveal an online wallet with a permit for that domain | the refresh schedule can be turned off, then domain calls do not ring |
| P5 | Contact exchange leakage | the call card travels as ordinary mail; a relaying domain may read the tag, which is harmless without the bound key |
| P6 | Correlation by timing | out of scope (a global passive adversary is not defended against) |

## 11. Resource abuse and downgrade

| ID | Threat | Mitigation | Test |
|---|---|---|---|
| X1 | Oversized or malformed bodies, SDP bombs, deeply nested JSON | hard size limits (the endpoints document gives them per route), strict schema with no unknown fields, bounded JSON depth | S1 |
| X7 | Server-side request forgery: a requester names a domain so that the Call Service or wallet fetches an internal address or follows a redirect | The Call Service fetches nothing from a requester-supplied name; it reads only the revocation list and keys of its single configured domain, over HTTPS, refusing redirects to other hosts and private or loopback addresses (outside a declared development mode), with size and time caps. The wallet fetches only the domains of permits the user granted, from its cache schedule, with the same URL rules | an operator who points the configuration at an internal address defeats it | S29 |
| X2 | Long-poll exhaustion | cap on held connections globally and per source and per session key; timeouts at 25 s | S16 |
| X3 | Memory growth from half-open calls | timers on every state; call table has a hard cap; test returns the table to baseline | S23 |
| X4 | TURN credential abuse | credentials are short-lived, per call, issued only in state accepted or later (Phase 3) | N3, N6 |
| X5 | Verification cost attacks (signature checks, key fetches) | cheap checks first (size, schema, tag, budget, rate) before any signature or network fetch; domain key fetches cached with a short TTL and rate limited | S16 |
| X6 | Old client behaviour | there is no fallback; a message type or version the receiver does not know is refused | S1 |

## 12. Residual risks and what is not claimed

* The conversation is end-to-end encrypted between the two browser instances
  only if both devices are uncompromised. It is **not** protected from the
  other participant, from malware, or from a domain gateway that terminates
  the media (the wallet labels domain calls "encrypted to the calling system").
* Traffic analysis and a global passive adversary are not addressed.
* The Call Service operator learns who called which tag when, and both parties'
  network addresses.
* A contact added through a hostile mail relay and never verified out of band can
  be impersonated (I8); the safety-code check is optional for the user.
* Domain-file caches mean a stolen delegation can ring for up to about an hour
  after being revoked (architecture 8.6).
* A legitimate, verified domain can still deceive a user over voice.
* The design depends on correct strict SDP handling in the wallet and on
  browser behaviour that must be confirmed on real devices in Phase 1
  (microphone prompt in an extension window, `getRemoteCertificates`,
  host-candidate masking).
* No independent security review has taken place. Until one has, no deployment
  may describe this as secure to a banking standard.
