# Secure voice calls: endpoints, messages and state machines

Status: proposal for review (see `docs/voice-calls-architecture.md`). Field
names and limits are proposals; they become fixed only when the design is
approved. Nothing here exists in code.

## 1. Conventions

* The **Call Service** (CS) is a new zero-dependency Node service (proposed
  directory `call-server/`). Paths below are on its own origin. It never
  receives or relays audio.
* Bodies are JSON, UTF-8, at most the limit stated per endpoint, with no unknown
  fields (unknown fields are refused, as in the moderation grant). Responses
  carry `Cache-Control: no-store`. Errors are `{ "error": "<text>", "code": "<code>" }`.
* **Signed payloads** follow `SPEC.md` section 6.2: canonicalize, hash, wrap in a
  `webauthn` or `raw-ecdsa` envelope. A `raw-ecdsa` signature is the raw `r || s`
  form, as `wallet.js` produces it and `verifyEnvelope` checks it (the example in
  section 6.2 calls it "der"; that is a spec inconsistency to fix separately).
  Every payload has `type` (a fixed string below, which is the domain
  separation), `v: 1`, `audience` (the CS origin), and `issuedAt` (ISO 8601 with
  milliseconds). **No call payload contains a top-level `purpose` field**, and the
  wallet's signing bridge refuses any payload whose `type` starts with
  `atlas.call.` (architecture section 2.5).
* **Hash encoding.** Every hash named below (`inviteHash`, `offerHash`,
  `answerHash`, `th`, tag hash) is SHA-256 of the canonical JSON of the stated
  payload(s), as unpadded base64url. `th` hashes the object
  `{ "invite": <invite payload>, "accept": <accept payload> }`. Three authentication modes:
  * **A, identity.** Envelope by `IK` (or by `PK` for a permit principal). For a
    passkey the verifier requires `clientDataJSON.type = "webauthn.get"` and the
    user-present flag, and does not require user verification.
  * **B, call key.** `raw-ecdsa` envelope by `CK_a` or `CK_b`, the key announced
    in the identity-signed `invite` or `accept`.
  * **C, listening session.** A delegation by `IK` to `SK`
    (`type: "atlas.call.listen-session"`, `sessionKey`, `issuedAt`, `expiresAt` at
    most 3600 s later) plus a `raw-ecdsa` envelope by `SK` over the request. The
    session may call only `listen`, `tag/list`, `tag/revoke` for **one** tag, and
    `signal` kinds `decline`/`busy`. It cannot create tags, accept, or place a
    call, and cannot revoke all tags.
* Replay: every request payload except `signal` carries a `nonce` (16 to 128
  characters). `signal` messages instead carry the per-sender `seq` described in
  section 2.3 and are checked against the call's state. A nonce is recorded per
  signing key for the acceptance window (120 s plus a 30 s clock allowance) and a
  repeat is refused with `401 replayed-request`; the nonce is recorded only after every
  signature has verified, so an unauthenticated caller cannot fill the record,
  and the record is capped (`503 busy` when full). `issuedAt` must be within 120
  s of the service clock for a request to the service (the mail-read precedent),
  otherwise `401 stale-request`, and the response carries `serverTime` for one
  retry. A *wallet* judging an invitation uses its own tighter rule: it refuses
  one whose `issuedAt` is more than 30 s in the future or whose `expiresAt` is
  more than 30 s in the past, and `expiresAt - issuedAt` is at most 60 s.
* **Uniform refusal.** On `invite`, `poll` and `signal`, every cause of "this
  cannot proceed" that could reveal tag or call state to a caller who is not a
  holder of a valid tag returns the same `404` body
  `{ "error": "unavailable", "code": "unavailable" }` after the same amount of
  work (cheap checks first, then signature verification for both the valid and
  the invalid case). A holder of a valid tag can additionally learn that the
  wallet is unavailable (Do not disturb is answered identically) or busy
  (architecture section 5.5). Only `429 rate-limited` (keyed on the caller's
  own traffic), `413`, `400 bad-request` (malformed JSON or schema) and
  `503 calls-not-configured` differ.
* **Not configured.** With no configuration file or environment, every
  endpoint except `GET /atlas/call/info` answers `503 calls-not-configured`, and
  `info` says `"configured": false`. The wallet then shows that calls are not
  available and nothing else changes.
* CORS: `POST /atlas/call/invite` answers any origin (no credentials are ever
  accepted, and the request is authenticated only by signatures), so that a
  browser-based domain endpoint can call it. Every other route has no CORS
  headers; the wallet calls them from extension pages. `Origin` and cookies are
  never an authentication input.

## 2. Endpoints

| Route | Mode | Purpose | Max body |
|---|---|---|---|
| `GET /atlas/call/info` | none | version, `serverTime`, limits, STUN URLs, whether TURN is offered, which domain's membership is required | none |
| `POST /atlas/call/tag/create` | A (+ membership) | create a tag bound to a caller principal | 8 KiB |
| `POST /atlas/call/tag/revoke` | A or C | revoke one tag or all tags | 2 KiB |
| `POST /atlas/call/tag/list` | A or C | list the caller's own tags (a short id, binding, expiry, calls used) | 2 KiB |
| `POST /atlas/call/listen` | C | long-poll (25 s) for incoming invitations and events | 4 KiB |
| `POST /atlas/call/invite` | A (+ chain, Phase 2) | place a call to a tag | 12 KiB |
| `POST /atlas/call/poll` | B | long-poll (25 s) for events of one call | 2 KiB |
| `POST /atlas/call/signal` | A for `accept`, C for `decline`/`busy`, B for the rest | send one message to the other party | 20 KiB |
| `POST /atlas/call/ice` | B | ICE servers and (Phase 3) short-lived TURN credentials for one call | 2 KiB |

### 2.1 `tag/create`

```json
{ "payload": {
    "type": "atlas.call.tag", "v": 1, "audience": "https://calls.example.com",
    "issuedAt": "2026-10-10T09:00:00.000Z", "nonce": "<16-128 chars>",
    "bind": { "kind": "wallet", "publicKey": "<the one caller key allowed to use this tag>" },
    "calleeKey": "<the key the callee signs `accept` with for this tag: its IK, or PK for a domain permit>",
    "expiresAt": "2026-11-10T09:00:00.000Z", "maxCalls": 20 },
  "proof": { "...envelope by the wallet's IK..." },
  "pkProof": { "...raw-ecdsa envelope by PK over the same payload; required when calleeKey is not the signer of proof..." },
  "membership": { "...the wallet's complete Post Office credential issued by this operator's domain..." } }
```

A domain permit uses `"bind": { "kind": "domain", "domain": "example.com", "purposes": ["support"] }`
(Phase 2) and a `calleeKey` that is the permit key `PK`. Terminology: `bind`
names who may *call* through the tag; `calleeKey` names who *answers*. Rules: `expiresAt` at most 90 days ahead (default 30 for wallet tags,
7 for domain permits), `maxCalls` 1 to 100, at most 200 live tags per wallet.
The service verifies that the credential was signed by its configured domain
key (pinned in configuration, never fetched from the request), is not on the
domain's revocation list, and that its owner is the signer of `proof`.
Response `200`: `{ "tag": "<128-bit base64url>", "expiresAt": "..." }`.
Errors: `400 bad-request`, `401` authentication codes, `403 membership-required`,
`429 tag-quota`, `503 calls-not-configured`.

### 2.2 `invite`

```json
{ "tag": "<128-bit base64url>",
  "invite": { "payload": {
      "type": "atlas.call.invite", "v": 1, "callId": "<128-bit base64url>",
      "audience": "https://calls.example.com", "tag": "<same tag>",
      "issuedAt": "...", "expiresAt": "<issuedAt + 60 s at most>",
      "nonce": "<128-bit base64url>",
      "caller": { "kind": "wallet", "publicKey": "<IK>" },
      "callee": { "publicKey": "<the intended callee key: the tag's calleeKey>" },
      "callKey": "<CK_a raw public key, 87 chars>",
      "media": { "kind": "audio", "fingerprints": ["sha-256 AB:CD:...:EF"] } },
    "proof": { "...envelope by the caller principal..." } },
  "chain": { "delegation": { }, "agentCert": { } } }
```

For a domain caller (Phase 2) `caller` is `{ "kind": "domain", "domain": "example.com", "purpose": "support" }`,
the proof is by `EK`, and `chain` carries the delegation and agent certificate
(formats in section 3).

CS checks, cheapest first: body size and schema; `audience`; tag exists, not
expired, budget left, no ringing invite already on the tag; per-callee and
per-source rate; `issuedAt`/`expiresAt` window; `callId` unseen; the signer
equals the tag's `bind` (for a domain tag the invite's signature must verify and
`caller.domain` must equal the tag's domain); `callee.publicKey` equals the tag's
`calleeKey`. **The Call Service fetches nothing from the caller's domain**: it
does not check the delegation chain (no outbound fetch to a name supplied by a
requester), and the wallet alone verifies the chain from its own cache. On
success: `202 { "ok": true }` and the invite is queued for the callee's listener
for as long as it is valid. The CS stores the verified `callKey` as the caller's
mailbox key for this `callId`.

### 2.3 `signal`

```json
{ "payload": {
    "type": "atlas.call.signal", "v": 1, "audience": "...", "callId": "...",
    "kind": "accept | offer | answer | candidates | confirm | end | cancel | decline | busy",
    "seq": 1, "th": "<transcript hash, base64url>", "body": { } },
  "proof": { "...mode A, B or C according to kind..." } }
```

| `kind` | Sender | Mode | `body` |
|---|---|---|---|
| `accept` | callee | A (the tag's `calleeKey`) | `inviteHash`, `calleeNonce`, `callKey` (`CK_b`), `fingerprints` |
| `offer` | caller | B (`CK_a`) | `sdp` (at most 16 KiB) |
| `answer` | callee | B (`CK_b`) | `sdp`, `offerHash` |
| `candidates` | either | B | `candidates` (at most 8 per message, 20 per call), `end` boolean |
| `confirm` | either | B (its own `CK`) | `fingerprints: { local, remote }`, `nonces: { caller, callee }`, `offerHash`, `answerHash` |
| `end` | either | B | `reason` from the enumeration in section 5 |
| `decline`, `busy` | callee | C | `reason` (authenticated to the service only; the caller cannot verify it and shows "not answered") |
| `cancel` | caller | B (`CK_a`, before accept); the callee verifies it against the `CK_a` in the invite | |

`th` is `SHA-256(canonicalize({ invite: <invite payload>, accept: <accept payload> }))`,
base64url; it is absent only from `accept` itself. `seq` counts each sender's `CK`-signed messages (`offer`/`answer`, `candidates`,
`confirm`, `end`, `cancel`) starting at 1 and increasing by exactly one: the
caller's `offer` is its seq 1, the callee's `answer` is its seq 1, and the
identity-signed `accept` has no `seq`; a repeat or gap is refused. The CS
verifies the signature, the sender's role for this `callId`, that the `kind` is
legal in the call's current state, and then queues the message for the other
party; it does not interpret SDP.

### 2.4 `listen` and `poll`

`listen` returns `{ "events": [...], "serverTime": ... }` after at most 25 s
(immediately if events are waiting, otherwise empty). Event kinds: `invite`
(the full signed invite and chain), `cancel`, `ended`. A request carries `ack`:
event ids it has processed; an event is redelivered until acknowledged or until
the invite's validity ends, and never after. Events are not stored beyond that.
`poll` is the same for a single call, authenticated with that call's `CK`, and
returns `signal` events in order.

Request payloads of the remaining routes (all carry `type`, `v`, `audience`,
`issuedAt`, `nonce`):

| `type` | Extra fields |
|---|---|
| `atlas.call.listen` | `ack`: array of event ids (at most 50) |
| `atlas.call.poll` | `callId`, `after`: the last `seq` the poller has processed |
| `atlas.call.ice` | `callId` |
| `atlas.call.tag-revoke` | `tag` (one tag, mode C) or `all: true` (mode A only) |
| `atlas.call.tag-list` | none | After `accept` the callee polls with `CK_b`, so
the call survives the listening session ending.

### 2.5 `ice`

Returns `{ "iceServers": [ { "urls": ["stun:..."] } ], "ttl": 600 }`. TURN
entries (Phase 3) carry `username`/`credential` valid for at most 10 minutes and
are issued only to a call in state `ACCEPTED` or later, once per call side.

## 3. Phase 2 certificates

Delegation, signed by the domain key (the same `canonicalize` and ECDSA as
asset credentials). Unlike an asset credential, the signing key must be valid in
the published key history **at verification time**, and `notAfter` must not
exceed that key's `validUntil` (architecture section 8.2); it must also carry
`call-delegation` in `usage` if decision D6 is approved:

```json
{ "payload": { "type": "atlas.call.delegation", "v": 1, "delegationId": "urn:atlas:call-delegation:<uuid>",
    "domain": "example.com", "authorityKey": "<CAK>", "purposes": ["support", "notice"],
    "departments": [ { "id": "fraud", "label": "Fraud prevention" } ],
    "issuedAt": "...", "notBefore": "...", "notAfter": "<at most 90 days>" },
  "signature": "<domain key signature>", "signingKey": "<domain key used>" }
```

Agent certificate, signed by `CAK`:

```json
{ "payload": { "type": "atlas.call.agent-cert", "v": 1, "delegationId": "...", "agentKey": "<EK>",
    "department": "fraud", "displayName": "optional, at most 60 characters",
    "issuedAt": "...", "notAfter": "<at most 8 hours>" },
  "signature": "<CAK signature>" }
```

`delegationId` is revoked by listing its id in `/.well-known/atlas-revocations.json`
(section 5.3). A wallet verifying these also applies the lifetime caps and the key-validity
rule of architecture section 8.2 itself (it does not trust the signer's own
`notAfter`).

The wallet limits `displayName` to 60 code points of plain text
with no control, bidirectional-override or line-break characters, and always
renders it as text, never as markup.

## 4. State machines

### 4.1 Call Service, per call

| State | Event | Guard | Next | Action |
|---|---|---|---|---|
| (none) | `invite` | all checks pass | RINGING | store invite, `callKey`, deadline = `expiresAt`; queue to listener |
| RINGING | `accept` | mode A valid, `inviteHash` matches, signer equals the tag's `calleeKey` | ACCEPTED | store `CK_b`; deadline 20 s for `offer` |
| RINGING | `decline`/`busy` (C) | session owns tag | ENDED | notify caller |
| RINGING | `cancel` (B, `CK_a`) | | ENDED | notify callee, who verifies it |
| RINGING | deadline | | ENDED (`timeout`) | |
| ACCEPTED | `offer` | from caller, `seq` 1, `th` matches | NEGOTIATING | relay; deadline 20 s for `answer` |
| NEGOTIATING | `answer` | from callee, `th` matches | ESTABLISHING | relay; deadline 40 s for both `confirm` |
| any live | `candidates` | after the sender's own SDP, caps | same | relay |
| ESTABLISHING | `confirm` from both | | ACTIVE | relay; no further deadline |
| any | `end` from either party | valid `CK` | ENDED | relay |
| any | deadline | | ENDED (`timeout`) | |
| ENDED | (60 s) | | deleted | drop mailboxes |

Any message not legal in the current state is refused as `unavailable` and
counted against the sender's rate limit. The CS holds no media state: `ACTIVE`
only means both confirmations passed through it.

### 4.2 Wallet, caller

| State | Event | Next | Actions |
|---|---|---|---|
| IDLE | user presses Call (contact, tag present, wallet unlocked, not busy) | PREPARING | open call window; ask microphone permission; generate `CK_a`, certificate |
| PREPARING | permission denied or error | ENDED (`mic-denied`) | release everything |
| PREPARING | ready | INVITING | build and sign `invite` (identity prompt for passkeys) |
| INVITING | signing cancelled | ENDED (`cancelled`) | |
| INVITING | `invite` accepted by CS | RINGING | start 45 s ring timer; poll with `CK_a` |
| INVITING | `unavailable` | ENDED (`unavailable`) | |
| RINGING | `accept` verified (signature by the key in the invite's `callee.publicKey`, which equals the stored contact key; `inviteHash`) | NEGOTIATING | create offer, sign with `CK_a`, send; start ICE |
| RINGING | `decline`/`busy`/timer | ENDED | |
| RINGING | user cancels | ENDED (`cancelled`) | send `cancel` |
| NEGOTIATING | `answer` verified (fingerprints, `th`, `seq`) | CONNECTING | apply remote description; accept candidates in signed batches; 30 s ICE timer |
| NEGOTIATING | verification failure | ENDED (`verify-failed`) | tear down |
| CONNECTING | transport connected and remote certificate hash equals signed fingerprint | VERIFYING | send own `confirm`; 10 s timer |
| CONNECTING | ICE fails or timer | ENDED (`connect-failed`) | |
| VERIFYING | peer `confirm` verified | ACTIVE | enable local audio, play remote audio |
| ACTIVE | mute / unmute | ACTIVE | stop and release / re-acquire the microphone track |
| ACTIVE | no audio received 30 s | ACTIVE (warning) | after 60 s end with `network-lost` |
| ACTIVE | hang up or peer `end` | ENDING | send `end` (best effort); ENDED when sent or after 2 s |
| any | wallet locked, window closed, identity switched | ENDED | tear down immediately |

### 4.3 Wallet, callee

| State | Event | Next | Actions |
|---|---|---|---|
| AVAILABLE | listening session open, not busy | (waiting) | `listen` loop |
| (waiting) | `invite` event | VERIFYING_INVITE | verify signature, `audience`, freshness, tag, caller binding, `callee.publicKey`, unseen `callId`, policy, rate |
| VERIFYING_INVITE | any check fails (including a `callee.publicKey` that is not this wallet's, or a cache of domain files that is missing or stale) | (waiting) | silent (domain calls: record a missed attempt) |
| VERIFYING_INVITE | busy | (waiting) | send `busy` |
| VERIFYING_INVITE | ok | INCOMING | show screen; ring until `expiresAt`; **no microphone, no addresses** |
| INCOMING | Decline / Block / timeout | (waiting) | send `decline` (session-authenticated only) |
| INCOMING | `cancel` verified against the invite's `CK_a` | (waiting) | stop ringing |
| INCOMING | Accept | ACCEPTING | open call window; ask microphone permission; generate `CK_b` and certificate; sign `accept` |
| ACCEPTING | permission denied / cancelled | (waiting) | send `decline` |
| ACCEPTING | `accept` sent | AWAIT_OFFER | poll with `CK_b`; 20 s timer |
| AWAIT_OFFER | `offer` verified | NEGOTIATING | create answer, sign, send |
| AWAIT_OFFER | 20 s timer | (waiting) | `end` (`timeout`), release everything |
| NEGOTIATING … ACTIVE | as for the caller | | `confirm` gating applies to both sides |

### 4.4 Timers

| Timer | Value | On expiry |
|---|---|---|
| invite validity | 60 s from `issuedAt` | ring ends |
| caller ring display | 45 s | `noanswer` |
| accept to offer | 20 s | `timeout` |
| offer to answer | 20 s | `timeout` |
| ICE connect | 30 s | `connect-failed` |
| confirm after connected | 10 s | `verify-failed` |
| silent media | 30 s warn, 60 s end | `network-lost` |
| `listen` hold | 25 s | empty response, client re-polls |
| listening session | at most 60 min | stop listening, tell the user |
| CS ended-call retention | 60 s | delete |

## 5. Reason codes

`declined`, `busy`, `noanswer`, `cancelled`, `unavailable`, `timeout`, `mic-denied`,
`verify-failed`, `connect-failed`, `network-lost`, `hangup`, `policy-blocked`.
`declined` and `busy` are reports from the service that the caller cannot
verify, so the caller UI shows both as "not answered" (`busy` is shown to a valid
tag holder as "busy" only because it is availability information that holder is
entitled to, architecture section 5.5). An unauthorised caller sees only
`unavailable`.

## 6. Cleanup on every terminal state

The call window: stops every microphone track and removes them from the peer
connection; closes the peer connection; clears all timers;
drops `CK` and the certificate; removes SDP and candidate text from memory; keeps
only the `callId` in the seen-cache; sends `end` best effort; closes itself. The
CS deletes mailboxes and keys 60 s after `ENDED` and removes any call whose
deadline has passed.

## 7. Wallet-side message verification order

For every received signalling message the wallet checks, in order, and stops at
the first failure: size and schema; `callId` is the active call; the message
kind is legal in the current state; `audience`; `seq` expected; signature by the
right key for that `kind`; `th`; then the content (for SDP, the strict parse of
section 7 of the architecture document). A failure ends the call with
`verify-failed` and tells the user plainly; it never silently ignores a message
that claims to be part of the active call.
