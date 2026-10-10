# Secure voice calls: architecture

Status: **proposal for review. No call code exists and none should be written
until this design is reviewed.** Nothing here is deployed, and nothing here may
be described as banking-grade or independently reviewed. This is the first of
five documents:

| Document | Contents |
|---|---|
| `docs/voice-calls-architecture.md` | this file: findings, protocol, routing, domain callers, decisions |
| `docs/voice-calls-threat-model.md` | assets, attackers, threats, mitigations, residual risk |
| `docs/voice-calls-endpoints-and-state.md` | Call Service endpoints, message formats, state machines, timers |
| `docs/voice-calls-test-plan.md` | automated and manual tests, per phase |
| `docs/voice-calls-deployment.md` | STUN/TURN, bandwidth, operator set-up, rollout, degradation |

## 1. Goals and non-goals

Goals, in the order they will be built:

1. Two wallets place an audio call to each other. Both ends are authenticated
   by their wallet keys, and the media keys are cryptographically tied to those
   authenticated identities.
2. An authorized domain places a call to a wallet. The wallet tells apart the
   domain's identity, the domain's authority to call, and (when present) a
   department or employee identity, and never merges them into one "verified"
   badge.
3. Routing that needs no global wallet directory and does not publish a
   permanent wallet key to anyone who has not been handed a way to reach it.
4. Standard WebRTC only: DTLS-SRTP for audio, no custom cipher, no custom key
   exchange, no recording.

Non-goals (all phases covered here): video, screen sharing, group calls,
voicemail, call recording, PSTN/SIP bridging, push notification while the wallet
is closed, persistent call history on any server, changes to Domain Atlas Core.
A signed domain identity is never evidence that a request made during a call is
safe (section 8.4).

## 2. What the repository already provides

Everything below was read in the code; nothing is assumed from memory. The
first column says whether the item is used as is, adapted, or deliberately not
reused.

### 2.1 Wallet identity and signing

* `extension/wallet.js` holds the identity: `getIdentity` (line 342),
  `signWithSelf` (line 536), `adminLoginForDomain` (line 629). There are two
  modes (`SPEC.md` section 6): a WebAuthn passkey whose private key never
  leaves the authenticator, and a local-password P-256 key. For the local mode
  the unlocked private key is kept as a JWK in `chrome.storage.session`
  (`getIdentity`, lines 342-353). No code calls `setAccessLevel`
  (`grep` finds no occurrence in `extension/`), so Chrome's default of
  trusted extension contexts only applies; this is a Chrome default to
  re-verify in Phase 1, not something this repository enforces.
* Signed payloads use the section 6.2 envelope: canonicalize, SHA-256, then
  `webauthn` (challenge = hash) or `raw-ecdsa`. **Adapted**: every call message
  is a section 6.2 payload with a `type` field and an `audience` field for
  domain separation, the same role `adminAuth.action` plays for the admin
  routes.
* **Signature encoding.** A `raw-ecdsa` envelope carries the raw `r || s`
  (IEEE P1363) form that WebCrypto produces and `verifyEnvelope` consumes
  (`wallet.js` line 536, `issuer-server/server.js` line 1629). The example in
  `SPEC.md` section 6.2 labels that field "der", which matches only the
  `webauthn` envelope. The call documents follow the implementation, and the
  spec example should be corrected separately.
* The existing server-side verifier `verifyEnvelope`
  (`issuer-server/server.js` line 1629) accepts a WebAuthn envelope without
  checking `clientDataJSON.type`, the user-present flag, or the relying-party
  hash. `SPEC.md` section 11.8 adds the `type` and user-present checks only for
  mail reads. **Not reused as is**: the call verifier must perform those checks
  itself. The wallet creates passkeys with `userVerification: 'preferred'`
  (`wallet.js` lines 797, 821, 842), so a call must not require the
  user-verified flag; user presence plus an explicit click is the consent
  signal.

### 2.2 Post Office, handles and federation

* Membership is a domain-signed credential held by the member
  (`SPEC.md` section 11.3). Handles resolve with an **unauthenticated** lookup
  (`/atlas/postoffice/resolve`, `issuer-server/server.js` line 9226) that
  returns a handle's public key. That is a per-domain directory of every
  registered handle, deliberately so for mail. **Not used for call routing**:
  calls must not enlarge that surface (section 5).
* Mail reads authenticate with a signed payload, `issuedAt`/`nonce`, optional
  short-lived delegation to a throwaway session key, and a nonce record
  (`SPEC.md` section 11.8). **Adapted** for listening sessions (section 5.4).
* Friend requests travel as ordinary mail with a reserved NUL-prefixed subject
  (`SPEC.md` section 11.5). **Adapted** to hand a "call card" to a contact
  (section 5.3).
* The domain-to-domain relay attestation is
  `{relayingDomain, relayingDomainHandle}` signed once by the domain key and
  carries no reference to the message, the sender, a nonce or a time
  (`issuer-server/server.js` lines 8860-8890 and 8973-9040). It proves "this
  domain signed this object at some point", so a captured copy would verify
  again. **Not reused**: a call invitation must be signed over its own contents.
  (This is an observation about mail, recorded here because the call design
  depends on not copying it. Whether it matters for mail is outside this
  document.)
* `fetchDomainPublicKey` (`issuer-server/server.js` line 2077) returns the first
  key that is valid *now*. Call verification needs "any listed key that was
  valid at the signing time" (`SPEC.md` sections 5.3 and 5.3.1). **Not reused**.

### 2.3 Domain identity, keys and manifests

* A domain's identity is control of its HTTPS site: `/.well-known/atlas-key.json`
  (key history with `validFrom`/`validUntil`, concurrent keys allowed, `SPEC.md`
  sections 5.3 and 5.3.1), `/.well-known/atlas-revocations.json`, and an
  optional pinned `identityKey` in the manifest (section 3.7). Plain HTTP is a
  hard failure (section 3.6.1).
* **A key listed in `atlas-key.json` has no declared purpose.** Section 5.3.1
  says purpose "is always declared by whoever's using the key". The consequence
  for calls is spelled out in section 8.2.
* Moderation grants (`docs/moderation-authorization.md`) are the closest
  existing precedent for "domain-signed, narrowly scoped, short-lived
  authority held by a client with a proof-of-possession key". The call design
  reuses that shape and its operator rules: nothing is switched on by
  deployment, no live configuration file is created by software, and an
  unconfigured service fails closed without affecting anything else.

### 2.4 Services and transports

* Everything server-side is zero-dependency Node (`issuer-server/package.json`
  has no dependencies). `presence-server/server.js` hand-rolls WebSocket
  (RFC 6455, lines 33 and 98) and also offers HTTP polling. `issuer-php/` and
  `presence-php/` are shared-hosting ports.
* **The presence service carries no wallet identity**
  (`presence-server/server.js` line 11) and `docs/moderation-authorization.md`
  builds a guarantee on that. Calls therefore **must not use the presence
  service**, not even as transport.

### 2.5 Browser extension boundaries

* A page reaches the wallet only through `page-bridge.js` (MAIN world) and
  `content.js`, which accepts a request only from its own document
  (`event.source === window && event.origin === location.origin`,
  `content.js` line 1023), checks the manifest-declared `walletBridge`
  permission and `purpose` (lines 107-170), and draws any confirmation in an
  extension-origin iframe the page cannot script (`confirm-bridge.js`; 120 s of
  inactivity denies).
* `background.js` accepts runtime messages only when `sender.tab` is set
  (line 73). That is **not** a way to tell a content script from an extension
  page: an extension page opened as a tab or a window also has `sender.tab`,
  and `sender.id` is the extension's own id for content scripts as well. New
  handlers for call control must check that `sender.url` starts with
  `chrome-extension://<this extension's id>/call.html` (a content script's
  `sender.url` is the host page's URL) and refuse everything else.
* **The signing bridge is a signing oracle for any payload with a whitelisted
  `purpose`.** `content.js` lines 169-179 check only that `payload.purpose` is on
  the manifest list and then, after the confirmation overlay, signs the
  page-supplied payload with the wallet identity. A payload shaped like a call
  message would be signed too if it carried a whitelisted `purpose`. The call
  design therefore requires: the bridge refuses any payload whose `type` begins
  with `atlas.call.`; no call payload may contain a top-level `purpose`; and a
  test covers both (S17).
* `web_accessible_resources` currently exposes `viewer.html`, `wallet.js` and
  the confirmation pages to every origin (`manifest.json`). **The call window
  and call code must not be added to that list**, or any page could frame the
  call UI.
* There is no WebRTC, `getUserMedia`, offscreen document or microphone
  permission anywhere in the extension today (`grep` confirms). A service worker
  cannot hold an `RTCPeerConnection`.

## 3. Components and trust boundaries

```
 Caller device                                        Callee device
 ┌──────────────────────────┐                         ┌──────────────────────────┐
 │ Wallet (extension)       │                         │ Wallet (extension)       │
 │  wallet.js: IK signing   │                         │  wallet.js: IK signing   │
 │  call window (call.html) │                         │  call window (call.html) │
 │   RTCPeerConnection, mic │                         │   RTCPeerConnection, mic │
 └───────────┬──────────────┘                         └───────────┬──────────────┘
             │ signed HTTPS (invite, signals)                     │ signed HTTPS (listen, signals)
             ▼                                                    ▼
        ┌──────────────────────────────────────────────────────────────┐
        │ Call Service (CS), the callee's chosen operator              │
        │ untrusted for authenticity and confidentiality; relays small │
        │ signed JSON; never sees keys, never touches audio            │
        └──────────────────────────────────────────────────────────────┘
             │ optional STUN / TURN (SRTP only, from the same operator)
 Caller ◄══════ DTLS-SRTP audio, peer to peer when ICE succeeds ══════► Callee
```

Trust assumptions, stated plainly:

* **The Call Service is untrusted for authenticity and confidentiality.** It
  can drop, delay, reorder or replay messages, and can read the metadata it
  sees. It cannot make a wallet believe a message came from anyone who did not
  sign it, and it cannot read or alter the audio.
* **TLS to the Call Service and to a domain's `.well-known` files** is the only
  transport trust, exactly the trust the rest of Domain Atlas already places in
  HTTPS.
* **The browser's WebRTC stack** performs DTLS-SRTP and certificate-fingerprint
  verification. The design adds an independent check on top (section 7) but
  does not replace it.
* **Each wallet's device and browser are trusted**, as they are for every
  other wallet operation. A compromised device is out of scope (threat model
  section 8).

## 4. Keys

| Key | Held by | Lifetime | Used for |
|---|---|---|---|
| `IK`, wallet identity key | wallet (`wallet.js`, unchanged) | long | signing `invite` and `accept` between identities; opening listening sessions; creating tags |
| `CK`, call key | the call window, WebCrypto non-extractable P-256 | one call | signing every later signalling message of that call; never leaves the page memory of the call window |
| `PK`, permit key | wallet, non-extractable, in extension IndexedDB | life of one permit | the wallet's pseudonymous principal toward one domain (section 8.5) |
| `SK`, listening session key | wallet, memory only | at most 60 minutes | authenticating `listen` requests; read-only (section 5.4) |
| DTLS certificate | the call window, generated per call with `RTCPeerConnection.generateCertificate` | one call | DTLS-SRTP; its fingerprint is signed before any SDP exists |
| `DK`, domain key | the domain operator, offline | long | signs call delegations (section 8.2) |
| `CAK`, call authority key | the domain's calling backend | at most 90 days | signs agent certificates |
| `EK`, agent session key | one agent's browser or media endpoint | at most 8 hours | signs invitations for that agent |

No key is invented. All are P-256 ECDSA, or the WebAuthn equivalent for `IK`.
No encryption algorithm is added: confidentiality is DTLS-SRTP supplied by the
browser, and the only new use of cryptography is signing with existing
primitives.

The wallet private key never reaches a web page: pages have no call API in
Phase 1 and, in Phase 2, receive only a permit (a routing tag plus a public
key). Today a page can obtain an `IK` signature over a payload with a
whitelisted `purpose` (`SPEC.md` section 3.8.1); the bridge restriction in
section 2.5 keeps that from being turned into a call signature.

## 5. Reachability and routing

### 5.1 No directory, only tags

A wallet is reachable only through a **tag**: a random 128-bit routing secret
that the wallet creates at its **Call Service** and hands to one counterpart (a
contact or a domain). A tag is bound at creation to **who may use it**:

* a wallet-to-wallet tag names one `callerKey`;
* a domain tag names one `domain` and a set of purposes.

An invitation to a tag must be signed by the caller key (or domain) the tag is bound to, so a
leaked tag alone lets nobody ring the wallet. Tags can be revoked one by one
without changing the wallet's identity, carry an expiry and a call budget, and
are the unit of rate limiting. **There is no tag, no ring.** A stranger cannot
ring a wallet at all; at most they can send an ordinary Post Office message
asking to be called, which the existing consent rules (section 11.3 block list
and friends-only mode) already govern.

No lookup service is added. The Call Service maps `tag -> inbox` and does not
list tags, wallets or handles, and never answers differently for "unknown tag"
and "revoked tag" (section 5.5).

### 5.2 The Call Service

The Call Service is the callee's chosen operator and admits only holders of a
live Post Office membership of the domain it is configured for (so the operator
already knows the wallet's key and can be held accountable for abuse). It is a small Node
service, in the style of `presence-server/`: zero dependencies, in-memory call
state, a small atomic JSON file for tags, long-poll HTTP (no WebSocket needed).
It is described in `docs/voice-calls-endpoints-and-state.md`.

Where a wallet registers is the **wallet user's** choice, shown in the wallet:
"Calls to this wallet are delivered through calls.example.com". The wallet may
pre-fill the address from a field the domain publishes in its manifest
(Phase 1 proposal: top-level `"calls": { "service": "https://calls.example.com" }`),
but a manifest only suggests; it never silently selects an operator, in line
with how the moderation design refuses to take a service address from a
manifest. Plain HTTP is refused except `localhost`.

Creating tags requires that **membership credential**, presented with an `IK`
signature. That bounds how many
inboxes anyone can create and lets the operator revoke a member exactly as for
mail. Placing a call requires no membership: a caller needs only a tag.

### 5.3 Handing out a tag between wallets (call card)

Two contacts exchange a **call card** over the existing Post Office mail, with
a reserved subject (the same technique as friend requests, section 11.5). The
card is a **signed** payload, so a mail relay cannot alter it:

```
subject: "\u0000atlas.call.v1"
body:    { "v": 1, "type": "card",
           "card": { "payload": { "type": "atlas.call.card", "v": 1, "service": "https://calls.example.com",
                                  "tag": "<128-bit>", "calleeKey": "<IK>", "expiresAt": "..." },
                     "proof": { "...envelope by that IK..." } } }
```

The receiving wallet accepts a card only if `proof.publicKey` equals the key it
already holds for that contact (it never learns the contact's key from the card
itself) and shows it as a pending permission; nothing is exchanged silently. The
card is made only by explicit user action ("Allow this contact to call me") or
as part of accepting a friend request when the user has turned on "Available
for calls".

**Where the contact's key comes from is the weak point, and it is the same
operator the rest of the design treats as untrusted.** A contact is added through
mail whose sender identity is the relaying domain's `from` stamp
(section 11.3), and federation is open by default (section 11.4). A relay (which
is by default also the Call Service operator) could substitute its own key at
friend-add time; every later check (card signature, `accept` signature) would
then pass against the wrong key while the wallet shows the contact's name. The
design therefore does not claim authenticity against that attacker unless the
user verifies the contact:

* The wallet offers **Verify contact**: it shows a short code derived from both
  identity keys (a fixed-length decimal or word rendering of
  `SHA-256("atlas.call.safety/v1" || sort(IK_a, IK_b))`) for the two people to
  compare over another channel (decision D11, recommended in Phase 1).
* The call screen distinguishes **verified** contacts from contacts that are
  only "added through mail", and never shows the contact's saved name next to a
  key the user has not verified without saying so.
* A key change for an existing contact is a hard warning, never silent.

### 5.4 Receiving: "Available for calls"

A wallet receives invitations only while the user has set **Available for
calls**. That opens a **listening session**: `IK` signs a delegation to a
throwaway `SK` valid for at most 60 minutes (the shape of the mail-read
delegation in section 11.8, with a longer lifetime, decision D4), after which
`SK` signs long-poll `listen` requests. The delegation authorizes `listen`
(including acknowledging events), listing tags, revoking a single tag, and
declining or reporting busy for a ringing call. It cannot place calls, create
tags or accept a call. A stolen `SK` is therefore not harmless: for up to an hour
it can read waiting invitations, consume them by acknowledging, and revoke tags
(a denial of service, recoverable by re-creating tags). When it lapses the wallet says so
and does not listen. Phase 1 has no background listening; the call window must
be open while available (the Manifest V3 service worker cannot hold the
connection reliably and an offscreen document cannot show a microphone
prompt). Missed calls while unavailable simply fail with "unavailable" for the
caller.

### 5.5 Refusals and what a caller can learn

Two groups of callers must be told apart:

* **Anyone who cannot ring** (unknown tag, revoked tag, expired tag, budget
  used, caller key not the one the tag is bound to, malformed or unverifiable
  invite) gets one identical response, `404 unavailable`, after the same work.
  This extends the rule of section 11.3 (a rejection must not let a sender
  distinguish "not a member" from "blocking you") to calls. A guessed tag
  reveals nothing about whether it exists.
* **A holder of a valid tag** (a contact or a permitted domain) can learn
  whether the wallet is currently available and whether it is busy. That is
  presence disclosure to people the user chose to give a card or permit, as in
  any messaging application, and it is accepted (decision D12). A user who does
  not want it turns on **Do not disturb**, which the Call Service answers exactly
  as it answers an unavailable wallet, so DND and "offline" look the same.

## 6. Wallet-to-wallet protocol

All messages are JSON, canonicalized as in section 6.2, and signed either by an
identity key (`IK`/`PK`, envelope `webauthn` or `raw-ecdsa`) or by the call key
`CK` (`raw-ecdsa`). Field-level formats and size limits are in
`docs/voice-calls-endpoints-and-state.md`; this section fixes the logic.

Order of events:

1. **Prepare.** The caller presses *Call* in the wallet. The call window asks
   for the microphone (a user gesture; Chrome's own prompt). It generates `CK_a`
   and a DTLS certificate, and reads the certificate fingerprint. It creates
   no SDP yet.
2. **`invite`** (signed by the caller's `IK`): `callId`, `audience`, `tag`,
   `issuedAt`, `expiresAt` (at most 60 s later), a fresh nonce `Nc`, `CK_a`, the
   caller's DTLS fingerprint, the caller principal, and **the callee key the
   caller intends to reach** (`callee.publicKey`: the contact's `IK` from the
   verified card, or the `PK` the domain received with the permit). The
   Call Service refuses an invite whose `callee.publicKey` is not the key the
   tag was created for, and the callee wallet refuses one that does not name
   itself, so a misrouted or forwarded invitation cannot be answered.
3. **Ring.** The Call Service checks the tag, the budget and the signature, and
   queues the invitation for the callee's listener. The callee's wallet
   verifies everything again (signature, freshness, audience, tag, caller binding, intended callee key,
   not seen before, policy) and only then shows the incoming-call screen.
   **No microphone is opened and no network address is disclosed yet.**
4. **`accept`** (signed by the callee's `IK`, or `PK` for a permit): `callId`,
   `inviteHash`, the callee's nonce `Nb`, `CK_b`, the callee's DTLS fingerprint.
   The user clicked *Accept* (and, for a passkey identity, touched the
   authenticator), then the call window asked for the microphone if it did not
   already hold permission. A `decline` or `busy` is only authenticated to the
   Call Service, not to the caller (section 3 of the threat model): the caller
   shows it as the neutral "not answered". A `cancel` is signed by `CK_a` and
   the callee wallet verifies it.
5. **Offer, answer, candidates** (signed by `CK_a` / `CK_b`): each carries the
   transcript hash `th = SHA-256(canonicalize({ invite, accept }))` over the two
   signed payloads, a per-sender sequence number, and the SDP (or candidate
   batch). All hashes are SHA-256 of the canonical JSON, encoded as unpadded
   base64url; `inviteHash` is the hash of the invite payload alone. The
   `answer` also carries `offerHash`, the hash of the offer payload, so the
   answer is bound to the exact offer it answers. The caller
   sends its SDP and starts ICE only now, after `accept`; a callee that has not
   accepted never receives the caller's network addresses.
6. **Verification** (section 7) of every received SDP against the signed
   fingerprints.
7. **`confirm`** (each side signs its own with its `CK`) after DTLS completes,
   over `th`, `offerHash`, an `answerHash`, both nonces and both fingerprints. **A side sends and plays audio only after
   it has verified the peer's `confirm`**. Before that, local tracks are
   present but disabled.
8. **Active.** Mute, hang-up, timers: see the state machine.

Why two kinds of signature. `IK` (a passkey) needs a user gesture per
signature, which is right for "I place this call" and "I accept this call". `CK`
is a software key created for one call and authorized by those two signatures,
so continuing the call needs no further prompts and, if the call window is
compromised after the call, the attacker obtains nothing durable.

Why this resists the classic attacks:

* **Replayed invite.** At most it makes the callee's wallet ring, once per
  `callId`, inside a 60 s window. It cannot produce `confirm`, because that needs
  `CK_a`'s private half, which exists only inside the original call window.
* **Unknown key share / call forwarding.** The invite names the tag (callee
  side) and carries the caller; the accept names the exact invite hash and the
  callee key. A third party cannot present a victim's accept as its own.
* **Malicious Call Service in the middle.** The service can relay the signed
  fingerprints but cannot substitute its own: the fingerprints are inside
  signatures made before any SDP exists, and every SDP is checked against them.
* **Late substitution after the signed messages.** Every SDP is also bound by
  `th` and signed by `CK`, and the wallet re-checks the certificate actually
  used by DTLS (section 7).

## 7. Binding authenticated identities to the DTLS certificates

1. The DTLS certificate is generated by the call window with
   `RTCPeerConnection.generateCertificate` **before** any invitation, and passed
   into the peer connection. Its SHA-256 fingerprint is therefore known and is
   what is signed in `invite`/`accept`.
2. When an SDP arrives the wallet parses it **strictly** and refuses:
   * any `a=fingerprint` value, at session or media level, that is not exactly
     the peer's signed one;
   * any hash algorithm other than SHA-256;
   * `a=crypto` (SDES), any non-DTLS-SRTP transport profile, `a=identity`,
     data channels, video, and more than one audio section;
   * anything over 16 KiB, or candidate lines inside the SDP (candidates arrive
     in signed batches after verification);
   * any later SDP (no renegotiation or ICE restart in Phase 1).
3. After the transport reports `connected`, the call window reads the remote
   certificate from the DTLS transport (`RTCDtlsTransport.getRemoteCertificates`),
   hashes it itself, and compares with the signed fingerprint. A mismatch
   tears the call down with "could not verify the encryption keys". This check
   is redundant with what the browser already does for the SDP, and is there
   to catch a bug in the wallet's own SDP handling, not a browser flaw.
4. ICE candidates are signed in batches (so the service cannot inject them) but
   their *content* cannot be verified: a malicious peer can still send addresses
   that are not its own. An attacker who gets one accepted can at worst disturb
   connectivity or make the peer probe an address (section 8 of the threat model). They cannot read or alter media because the DTLS peer
   still must present the signed certificate.

The browser's WebRTC "identity assertion" extension (RFC 8827 `a=identity`) is
**not** used: it is not available in Chromium, and the signed-fingerprint
approach above gives the same property with the wallet's existing keys.

## 8. Domain-to-wallet calling (Phase 2)

### 8.1 What the wallet must tell apart

The incoming-call screen shows three separate rows, each with its own state,
and never an overall "verified" badge:

| Row | Question | How it is established |
|---|---|---|
| Domain identity | Is this really `example.com`? | the delegation chain verifies against a key from `https://example.com/.well-known/atlas-key.json` fetched over TLS, valid at signing time, plus a pinned `identityKey` match if the wallet remembered one |
| Authority to call | Did `example.com` authorize *this* endpoint to call for it, for this purpose, now? | a domain-signed delegation names the endpoint, its purposes and validity, and is not revoked; and the wallet user gave this domain a permit |
| Department / employee | Who in the organization? | the department is checked against the list in the domain-signed delegation, but *which agent belongs to which department* is asserted by the domain's calling backend (`CAK`), so it is labelled "department stated by the calling system"; an employee name is labelled the same way and never as independently verified; absent means "caller did not identify an individual" |

The first two rows both rest on the domain's signature over the delegation: the
split is in what each *proves* (control of the domain's published key and web
site, versus a signed grant naming this endpoint, purpose and period), not in
two independent roots of trust. A domain that is compromised at the key level
passes both.

### 8.2 Delegation chain

```
DK  (domain key, offline)
 └─ signs delegation D   : who is the call authority (CAK), purposes, departments, notBefore, notAfter (≤ 90 days)
      CAK (domain's calling backend)
      └─ signs agent certificate A : agent session key EK, department id, optional display name, validity (≤ 8 h)
           EK (the agent's call endpoint)
           └─ signs the invite
```

The invite carries `D` and `A`. The wallet verifies, in order, and stops at the
first failure:

1. Schema, sizes, and that `D.domain`, `invite.caller.domain` and the permit's
   domain are the same exact name, and that `A.delegationId` equals
   `D.delegationId`.
2. Lifetime caps are enforced **by the wallet**, not trusted from the signer:
   `D.notAfter - D.issuedAt` at most 90 days, `A.notAfter - A.issuedAt` at most
   8 hours, `A`'s window inside `D`'s window, neither `issuedAt` in the future
   (30 s allowance), neither expired.
3. `A` verifies against `D.authorityKey`; the invite verifies against
   `A.agentKey`.
4. `D` verifies against a key in the domain's published `atlas-key.json` that is
   **valid now** (not merely valid at `D.issuedAt`), and `D.notAfter` does not
   exceed that key's `validUntil`. A delegation is short-lived, so requiring the
   signing key to be current costs a re-issue after a rotation and closes
   backdating: a rotated-out or stolen key cannot mint a delegation with an
   `issuedAt` inside its old validity window. (Asset credentials keep the
   "valid at `issuedAt`" rule of section 5.3, because they must outlive rotations.)
5. `D.delegationId` is not in the domain's revocation list.
6. `invite.caller.purpose` is in `D.purposes` and in the permit's purposes, and
   `A.department` is in `D.departments`.

All domain files come from the wallet's cache (section 8.6); the wallet does not
fetch them at ring time. If the cache lacks them or is too old, the call is
**not verified**, which for domain callers means it does not ring (section 9).

**Key purpose caveat.** Today any key in `atlas-key.json` can sign anything,
including asset credentials, because purpose is not recorded (section 2.3). A
domain key used for delegations is therefore also an asset-minting key for
existing verifiers. Proposal (decision D6): an optional per-key `usage` list
in `atlas-key.json`, enforced by the new call verifier (a delegation key must
list `call-delegation` when `usage` is present, and the call verifier requires
it to be present). Existing domains are unaffected because no delegations exist
yet. This is a spec addition and needs approval before it is written; until
then the operator guidance is to keep `DK` offline, and the residual risk is
recorded (threat model, key compromise).

### 8.3 Reusing Post Office and service discovery

The domain-side endpoint needs only the callee's `{service, tag}` and a
principal public key `PK`; it never needs a Post Office address or a wallet
key. The Call Service is the callee's chosen Post Office operator. Discovery of
a *domain's* signing material reuses `atlas-key.json`, `atlas-revocations.json`
and the manifest exactly as asset verification does. There is no new central
service.

### 8.4 What a verified domain does not mean

* The wallet shows, on every domain call and unchangeably: "Verification shows
  who is calling, not whether the request is genuine or safe."
* There is no way to approve, sign or authorize anything from within a call.
  The wallet offers no transfer, mint, share or recovery action driven by the
  caller. While a domain call is active, opening a send, transfer or recovery
  screen shows a banner naming the caller and telling the user never to
  approve a payment because of a call. (Phase 2 UI requirement.)
* The `purpose` category in the delegation is the domain's own claim, shown as
  such (for example "support", "delivery notice"). Purposes are a closed list
  in the spec; a domain cannot invent a category the wallet displays as trusted.
* Optional hardening, recorded for the review (decision D8): "hang up and verify
  in the wallet", where the wallet asks the domain over TLS whether it has an
  open call with that `callId`. It defeats a stolen delegation but needs a
  domain endpoint, so it is not in the minimal protocol.

### 8.5 Permits: how a domain obtains a way to call

A domain cannot ring a wallet without a **permit** the user granted. Flow:

1. The user, on the domain's own page, chooses "call me back" or similar. The
   page asks the wallet bridge for a call permit. This is a new bridge request
   (proposal: `walletBridge.callPermit: [<purposes>]`, same domain-default and
   world-override composition as `sign`, section 3.4.1; empty by default).
2. The wallet shows its own confirmation in the extension-origin overlay: the
   **requesting origin as the browser reports it**, the purposes, the duration
   (default 7 days, at most 90), the number of calls (default 3), and "this
   page will receive a way to call you, not your wallet key".
3. On approval the wallet generates `PK`, registers a tag at the user's Call
   Service bound to `{domain, purposes, PK}`, and returns `{service, tag, publicKey: PK,
   expiresAt}` to the page. The page's server uses it with the delegation chain.
4. The permit is listed in the wallet ("example.com may call you until ...")
   with *Revoke* and *Block this domain*.

The domain therefore learns a pseudonymous per-permit key and nothing about
`IK`. **The unlinkability is limited**: the Call Service operator receives `IK`
and `PK` together at tag creation (`pkProof` accompanies the `IK` signature) and
can link them; if the operator is the calling domain itself (a domain whose Post
Office is the user's Call Service), the domain learns `IK`; and the permit
reveals the operator's URL, which two colluding domains can use to correlate. It
is unlinkable only against domains that use a different operator from the user's
and do not collude with it. The callee's
`accept` in a domain call is signed by `PK` (software, no passkey prompt) and
by `CK_b`.

The bridge request must validate its payload **inside the extension** against a
fixed schema for that request type and require the requested domain to equal the
requesting origin's host. This is stricter than the current signing bridge,
which signs a page-supplied payload for a whitelisted purpose and relies on the
user reading the prompt (`docs/moderation-authorization.md`, limitation 28):
the permit bridge must not repeat that.

A permit is also the only way a domain reaches a wallet. A domain that holds a
credential from, or a Post Office membership with, the same wallet gains no
right to call from that fact.

### 8.6 Fetching a domain's files without revealing availability

Fetching `.well-known/atlas-key.json` or the revocation list when a call rings
would tell the calling domain the callee's current IP address and that the
wallet is online, before the user accepted anything. The wallet therefore:

* fetches and caches the domain's key history, revocation list and manifest when
  the permit is granted, and refreshes them on a schedule that is independent of
  any call (keys at most every 24 hours, revocations at most every hour while
  the wallet is available), each fetch made with no cookies or referrer;
* verifies at ring time from the cache only, and displays the cache age, saying
  "revocations last checked 40 minutes ago" when it matters;
* treats a cache older than 24 hours (keys) or 6 hours (revocations) as
  "not verified".

This leaves a revocation delay of up to an hour for a stolen delegation, which is
an accepted trade (decision D13). The scheduled fetches still reveal that some
wallet with a permit for that domain is online, and its IP, to that domain at
the refresh times; the user can turn the schedule off (then domain calls do not
ring).

## 9. Consent, blocking and rate limits

Wallet policy (all decided in the wallet, never by the server):

| Rule | Behaviour |
|---|---|
| Ring only on a valid tag | no tag, no ring |
| Explicit approval | the incoming screen has *Accept*, *Decline*, *Block*; ringing never opens a microphone; nothing auto-accepts, no "accept all from contact" option exists |
| Busy | one call at a time; a second invite is declined as busy with no ring |
| Unverified domain call | not rung (including when cached domain files are missing or stale); listed silently as a missed attempt |
| Do not disturb | tags remain valid, invites are declined silently |
| Block | blocks the principal (key or domain) in the wallet *and* revokes its tags at the Call Service |
| Auto-limit | three explicit declines of calls from one principal in 24 h pause its tag for 24 h; the wallet says so and offers Undo. Rings missed because the wallet was unavailable or in Do not disturb never count, so a legitimate contact who calls while the user is away is not penalised |

Call Service limits (defaults, operator-tunable; the authoritative sizes are in the endpoints document): invite body at most 12 KiB;
one ringing invite per tag; 3 invites per tag per 10 minutes; 10 ringing
invites per callee per minute; per source address and per caller key token
buckets; a global cap on live calls and held long-polls; each tag has a
call budget (domain permits default to 3). A violation produces the uniform
refusal (section 5.5), with `Retry-After` only where it cannot reveal tag state.

## 10. Privacy summary

| Party | Learns |
|---|---|
| Call Service operator | the caller principal (a wallet caller's permanent `IK`, even if the caller never joined this operator) and time for each invitation to a tag, the callee's `IK`, delivery outcome, **and both parties' network addresses**: SDP and candidates pass through it in the clear, host addresses included (decision D15 would seal them to the peer); never audio |
| Callee wallet | caller principal; the caller's network address only after *Accept* |
| Caller | callee `IK` or `PK`; the callee's network address only after *Accept* |
| Domain endpoint | a pseudonymous `PK`; the callee's network address after *Accept* (unless relay-only is on); the user's address and online status at the scheduled cache refreshes (section 8.6) |
| Presence servers, multiplayer, other domains, directories | nothing |
| STUN/TURN operator | network addresses and timing; never audio content |

The Call Service keeps no call history: call state is in memory and is
deleted 60 s after the call ends; tags are the only persistent data (a small
file, 0600). Logs must not contain keys, tags, SDP or candidates (a test
checks this). The pre-accept candidate hold is part of Phase 1; the wallet setting
*Hide my network address* (ICE relay only, available when the operator provides
TURN) is Phase 3 (section 12).

## 11. Extension integration (design constraints, not code)

* A new extension page `call.html` hosts the `RTCPeerConnection`, the microphone,
  `CK`, and the call UI. It is opened by the extension (a small window) and is
  **not** in `web_accessible_resources`.
* Signing happens in that page by calling `wallet.js` directly, as
  `confirm-bridge.js` already does. No private key crosses a message.
* The service worker only opens the window. Any runtime message that controls a
  call is accepted only when `sender.url` begins with
  `chrome-extension://<id>/call.html` (section 2.5), never from a content script
  or any other page.
* The microphone is requested from `call.html` after a click. The side panel is
  not used for media (Chrome permission prompts in side panels are
  unreliable, a Phase 1 spike must confirm on a real device). All tracks are
  stopped on every terminal state; Mute releases the device (`replaceTrack(null)`
  and `track.stop()`), so the browser's recording indicator reflects reality.
* Chrome keeps a microphone grant for the extension's origin after the first
  approval, so the browser prompt appears on the first call only. The explicit
  consent for each call is the *Call* or *Accept* click, a visible call window
  and the browser's recording indicator; tests must not assume a prompt per call.
* A waiting window can be frozen or discarded by the browser's memory saving. The
  wallet must show "Available" only while its `listen` loop has recently
  succeeded, tell the user when it has stopped, and (a Phase 1 spike) find out
  whether a ring while the window is in the background can be surfaced at all;
  until then calls are best effort while the window is open and visible.
* A hostile page can open a look-alike window. The real call window carries a
  personal **security phrase** the user chose, shown on every incoming and
  active call screen and on the permit overlay, which a page cannot read
  (decision D14).
* No `MediaRecorder`, no recording API and no audio sent to any server; a static
  test checks the call code for them.
* Pages get no call API in Phase 1. In Phase 2 they get exactly one new bridge
  request, the permit request of section 8.5.

## 12. Phases

| Phase | Deliverable | Gate |
|---|---|---|
| 0 | these documents | review and approval |
| 1 | Call Service, `call.html`, wallet-to-wallet calls between contacts, tags and call cards, listening sessions, fingerprint binding, tests | two profiles automated, two PCs manual |
| 2 | domain delegation chain verification, permit bridge request, three-row incoming screen, reference agent endpoint in a demo domain (browser based) | supervised acceptance test |
| 3 | STUN/TURN integration, relay-only option, TURN credentials, degradation behaviour, measurements | deployment review |

Each phase ends with a stop for review. Nothing is deployed and no live
configuration is edited in any phase without a separate instruction.

## 13. Decisions that need a reviewer's answer

| # | Decision | Recommendation |
|---|---|---|
| D1 | Call Service placement: new `call-server/` vs routes inside `issuer-server/` | New small service. The issuer holds signing keys and is the highest-value process; a separate service can be restarted, rate-limited and exposed independently. Cost: one more process; membership is checked through the presented credential rather than a roster lookup |
| D2 | Transport: HTTP long-poll vs WebSocket | Long-poll for Phase 1 (works behind any proxy, simple to test, minimal code); WebSocket later if latency requires it |
| D3 | Domain callers: pseudonymous `PK` vs the wallet's `IK` in the permit | `PK`. If `IK` is chosen the permit is simpler but every domain learns a stable identifier |
| D4 | Listening session length and renewal | 60 minutes, renewal needs a user gesture; background listening deferred |
| D5 | Seal the invite to the callee so the Call Service cannot read the caller | Not in the first cut (the tag/principal binding already limits who may call, and the operator already sees mail metadata); revisit if the review wants it. It would reuse the existing ECIES-style mail encryption, no new primitive |
| D6 | `usage` field in `atlas-key.json` for delegation keys | Propose and enforce in the call verifier only; needs spec approval |
| D7 | Calls are Node-only in Phase 1 | Yes. Shared PHP hosts can point wallets at a Node Call Service elsewhere; a PHP port is not planned |
| D8 | "Verify in the wallet" callback check for domain calls | Defer; record as the strongest anti-vishing control |
| D9 | Mute releases the microphone | Yes (small latency cost on unmute) |
| D10 | Domain endpoint technology | Browser-based agent page for the reference endpoint (no server WebRTC dependency); a server-side media gateway is out of scope and would need a heavy dependency |
| D11 | Contact key verification (safety code) in Phase 1 | Yes. It is the only protection against a relay that substitutes a contact's key; without it the design is only as trustworthy as the mail relay (section 5.3) |
| D12 | Availability visible to card holders | Accepted; Do not disturb looks like offline (section 5.5) |
| D13 | Domain-file caching: key refresh 24 h, revocation refresh 1 h, staleness limits 24 h / 6 h | Yes (section 8.6); accepts up to an hour of revocation delay in return for not revealing the wallet's address before Accept |
| D14 | Personal security phrase shown only in real call and permit windows | Recommended; small UI cost, defeats look-alike windows |
| D15 | Seal SDP and candidates to the peer's `CK` so the Call Service cannot read addresses | Defer. It needs an ECIES-style composition from standard WebCrypto primitives (as the mail encryption already has); until then the privacy tables say the operator sees addresses |
| D16 | Key-retired notice to contacts after an identity change | Recommended for a later phase; until then a stolen key's cards and tags stay valid for the thief (threat model K2) |

A domain endpoint that bridges audio to a human through a gateway terminates
DTLS at the gateway: the call is encrypted to the domain's calling endpoint,
not to a particular employee. The wallet says so ("encrypted to example.com's
calling system").
