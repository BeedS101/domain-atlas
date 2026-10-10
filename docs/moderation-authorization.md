# Moderator authorization

Status: Phase 1B. The issuers (Node: `issuer-server/server.js`; PHP:
`issuer-php/`) register moderators and sign short-lived moderation grants; the
presence services (Node: `presence-server/`; PHP: `presence-php/presence/`)
verify those grants and answer one read-only operation, `roster.view`: the
anonymous list of sessions in one world. **There is still no way to mute,
kick, ban or time out anyone and no moderator interface.** The other
operations in the vocabulary exist only as names a grant may carry.

The goal is narrow: a moderator can observe exactly the anonymous sessions of
the domain and worlds they are authorized for, without issuer-administrator
powers and without learning any wallet identity.

Files: roster and routes in `issuer-server/server.js` and `issuer-php/lib/store.php`;
PHP routes `issuer-php/atlas/admin/moderation/grant.php` and
`issuer-php/atlas/moderation/status.php`; presence verification in
`presence-server/lib-moderation.js` and `presence-php/presence/lib/moderation.php`;
PHP route `presence-php/presence/moderation/roster.php`; reference verifier
`tools/lib/moderation-grant.js`; reference lookup `tools/moderation-ref.js`;
tests `test/manual-moderator-authz.js` and `test/manual-presence-moderation.js`.

### Changes from Phase 1A (compatibility)

- **Breaking, issuer:** `POST /atlas/admin/moderation/grant` accepts only a
  signed request `{payload, proof}`. A body with a session `token` and no
  `proof` is refused with `401 signature-required`, even for a valid session.
  If both are sent the token is ignored. No grant was ever consumed by anything
  before this phase, so nothing outside the tests used the token form.
  Sign-in, `whoami` and every other administrator workflow are unchanged.
- **New, issuer:** `GET /atlas/moderation/status` (section 7).
- **Wire format:** grants and requests are unchanged (version 1). For
  `roster.view` the request `target` must be the empty string.
- **New, wallet:** the presence and chat joins carry an optional `visit` field
  (section 9). Servers that do not know it ignore it; a wallet that does not send it works as
  before and its sessions simply are not paired in the list.

## 1. Roles

Each entry in the administrator roster (`atlas-admin-keys-store.json`) may carry:

| Field | Meaning |
|---|---|
| `role` | Absent or `null`: administrator (backward compatible). `"admin"`: administrator. `"moderator"`: moderation only. **Any other value, including a different case, a number or an empty string, gives no authority at all.** |
| `worlds` | Moderators only. Absent: every world. An array of world ids: exactly those worlds. **An empty array: no world.** Present but not an array of valid ids (`null`, a string such as `"*"`, an object, an empty-string entry): no world. |
| `operations` | Moderators only. Same rules as `worlds`, over the vocabulary `roster.view`, `chat.mute`, `session.kick`, `session.timeout`. Absent: all of them. An empty or invalid list: none. |
| `revoked` | `true` ends the entry (unchanged). |

The vocabulary is reserved for later phases; nothing implements an operation.
There is deliberately no `ban`.

A key's authority is computed from its **active** (non-revoked) entries:

- no active entry: no authority;
- one active entry: that entry's role;
- several active entries: authority only if all are administrator entries;
  any mix of roles, or two moderator entries, gives no authority (an ambiguous
  roster must not pick the more generous reading).

Example:

```json
{ "keys": [
  { "publicKey": "<admin key>", "addedAt": "2026-10-10T00:00:00Z" },
  { "publicKey": "<moderator key>", "addedAt": "2026-10-10T00:00:00Z",
    "role": "moderator", "worlds": ["lobby", "gallery"], "operations": ["chat.mute", "session.kick"] }
] }
```

The roster stays a hand-edited file. There is no endpoint to add or change a
moderator (see section 15), and no self-registration.

World ids are compared exactly (case-sensitive). A valid id is 1 to 120 code
points of valid Unicode with no control characters, U+2028 or U+2029, and no
leading or trailing white space (including U+FEFF). Node and PHP apply the same rule.

## 2. Enforcement

`requireAdminAuth` (Node) and `require_admin_auth` (PHP) take a required
scope that **defaults to `admin`**. Every pre-existing admin route therefore
refuses a moderator without having been edited, and a route added later is
admin-only unless it asks for more. Only these accept scope `moderation`
(administrators and moderators): `POST /atlas/admin/moderation/grant` and
`POST /atlas/admin/session/whoami`.

`isAdminKey` / `is_admin_key` now mean "active administrator" only, so the
remaining direct roster checks (`GET /atlas/admin/is-admin`, delivery of
email tickets to administrators) are false for a moderator.

A refused role returns `403 insufficient-role`. It happens after the
signature and roster checks, **before the request nonce is spent** and without
counting against the failed-authentication throttle, so a moderator's own
mistakes cannot lock out a shared address.

Both authentication paths are covered: a session token and a directly signed
proof (`payload.adminAuth`) reach the same check. The role the client sends is
never read; authority always comes from the roster at that moment.

`POST /atlas/admin/session/start` allows any key with authority and returns
`role`. `POST /atlas/admin/session/whoami` returns `{publicKey, role}`.

### Sessions

Sessions store only the public key. The roster is re-read on every request, so:

- revoking a key or removing it deletes its sessions on the next request;
- demoting an administrator to moderator takes effect on the next request of
  the existing session (`403 insufficient-role`);
- promoting a moderator takes effect on the next request;
- changing `worlds` or `operations` takes effect on the next grant request.

Idle expiry, absolute expiry, single-use login nonces, request-nonce spending
and the failed-authentication throttle are unchanged (see
`docs/admin-auth-hardening.md`).

## 3. Trust binding: domain, issuer key, presence endpoint

A grant is only useful to a presence service that agrees with the issuer about
three things. Nothing is discovered from a manifest or fetched from a
third-party endpoint.

**Issuer side.** The operator configures which presence endpoints may receive
grants:

- Node: `ATLAS_MODERATION_AUDIENCES` (comma-separated origins), or
  `atlas-moderation-config.json` in the state directory:
  `{"audiences": ["https://presence.example.com"]}`. The environment variable
  wins when set. The grant's `domain` is `ATLAS_DOMAIN`.
- PHP: `lib/atlas-moderation-config.json`:
  `{"domain": "example.com", "audiences": ["https://presence.example.com"]}`
  (`ATLAS_MODERATION_AUDIENCES` overrides `audiences`). The domain comes from
  this file, **never from the Host header**, and the route answers
  `400 wrong-domain` if the request arrived under another host name.

An audience is an origin (`scheme://host[:port]`, lowercase, no path). With no
audience configured the route answers `503 moderation-not-configured`.

**Presence side.** The presence service is configured with its own audience
and, for each domain it serves, the pinned issuer public key(s) and the URL of
the issuer's status statement (section 12). It does not fetch keys at
verification time and does not take keys, URLs or roles from a request, a grant
or a manifest, so a hostile manifest or client cannot point a presence service
at an attacker's key. The pin is set by whoever operates the presence service,
which for this project is the same operator. (An operator running presence for
other domains needs an out-of-band step to obtain each domain's key; that is a
limitation, section 15.)

## 4. Requesting a grant

`POST /atlas/admin/moderation/grant`

Body: `{payload, proof}`. The request must be freshly signed by the moderator's
own key and carry the usual `payload.adminAuth` with
`action: "/atlas/admin/moderation/grant"`, a current timestamp and a
single-use nonce (the Phase 0A replay protection, domain binding and signed
request validation, unchanged). **A session token is never enough**: a stolen or
left-open admin-panel session cannot mint a grant, because minting needs the
private key to sign again. The one-time signing step per grant is the intended
cost; the moderator's client signs it once per grant (a grant lasts minutes).

Payload (strict; unknown fields are rejected):

| Field | Rules |
|---|---|
| `audience` | Configured presence origin. |
| `worlds` | `"*"` or 1 to 32 distinct valid world ids. |
| `operations` | 1 to 4 distinct names from the vocabulary. |
| `ttlSeconds` | Optional integer 1 to 600. Default 300. |
| `popPublicKey` | Fresh ephemeral raw P-256 public key, 87 base64url characters (65 bytes, `0x04` prefix, a point on the curve, canonical spelling). Must differ from the requester's long-term key and from the issuer key. |
| `adminAuth` | Required. |

The request must lie inside the key's **current** authority: every requested
operation and world must be allowed, and `"*"` is allowed only to a key whose
authority is all worlds. Administrators may also ask for grants.

Errors: `400 bad-request` (malformed or unknown field), `400 wrong-domain`,
`401 signature-required` (no proof object), `401 not-admin` / `bad-signature` /
`replayed-request` / other authentication codes, `403 audience-not-trusted`,
`403 scope-denied`, `429 grant-quota` (more than
`ATLAS_MODERATION_MAX_LIVE_GRANTS`, default 10, unexpired grants for the
moderator), `503 moderation-not-configured`.

Response `200`:

```json
{ "grant": { "payload": { ... }, "proof": { ... } }, "expiresAt": "2026-10-10T09:05:00.000Z" }
```

The issuer keeps a record of each grant (id, moderator reference, audience,
times) for the quota. It stores no keys, signatures or tokens.

## 5. Grant format (version 1)

```json
{
  "payload": {
    "type": "atlas.moderation-grant",
    "version": 1,
    "grantId": "<22 base64url characters, 16 random bytes>",
    "domain": "example.com",
    "audience": "https://presence.example.com",
    "moderatorRef": "<43 base64url characters>",
    "worlds": ["lobby", "gallery"],
    "operations": ["chat.mute"],
    "issuedAt": "2026-10-10T09:00:00.000Z",
    "expiresAt": "2026-10-10T09:05:00.000Z",
    "cnf": { "alg": "ES256", "publicKey": "<ephemeral raw P-256 key>" }
  },
  "proof": { "signerRole": "raw-ecdsa", "publicKey": "<issuer key>", "signature": "<64-byte raw r||s, base64url>" }
}
```

- `worlds`: `"*"` or an array. `operations`: array. Exactly these eleven
  payload fields; a verifier rejects anything else.
- `moderatorRef` is `base64url(SHA-256("atlas-moderator-ref/v1\n" + domain + "\n" + moderatorPublicKey))`.
  It lets audit records refer to a moderator without publishing the key, and
  differs per domain. It is not a secret: anyone who knows a candidate key can
  recompute it, so it is a stable pseudonym, not anonymity.
- Timestamps are `YYYY-MM-DDTHH:MM:SS.mmmZ`.
- Lifetime (`expiresAt - issuedAt`) is at most 600 s.
- The issuer key is the domain's existing signing key (the one in
  `/.well-known/atlas-key.json`).

### Signature

```
signature = ECDSA-P256-SHA256( UTF8("atlas-moderation-grant/v1\n") || UTF8(canonicalize(payload)) )
```

`canonicalize` is the project's canonical JSON (sorted keys, no whitespace),
the same function used for credentials and admin requests. The issuer key also
signs credentials, mail and other payloads over bare canonical JSON; the
prefix keeps a grant signature from verifying as any of them, and no other
signature is made with this prefix (`test/manual-moderator-authz.js` checks
that a grant signature does not verify as a plain canonical-JSON signature).

## 6. Using a grant

The moderator keeps the ephemeral private key generated with the request and
signs every command with it. Presenting the grant alone is never enough.

```json
{
  "grant": { ...as issued... },
  "request": {
    "payload": {
      "type": "atlas.moderation-request", "version": 1,
      "grantId": "<same as the grant>", "audience": "<presence origin>", "domain": "example.com",
      "world": "lobby", "operation": "roster.view", "target": "",
      "issuedAt": "2026-10-10T09:01:00.000Z", "nonce": "<16-128 base64url characters>"
    },
    "signature": "<ECDSA by the grant's cnf key, base64url raw>"
  }
}
```

```
signature = ECDSA-P256-SHA256( UTF8("atlas-moderation-pop/v1\n") || UTF8(canonicalize(request.payload)) )
```

The body has exactly the members `grant` and `request`; anything else is a
`400`. The request payload has exactly the ten fields shown: a client cannot add
a role, a permission or a key.

### Verification a presence service performs, in order

1. Moderation is configured and enabled (`503 moderation-not-configured`).
2. Body shape; the grant names a configured domain (`403 domain-not-configured`).
3. Grant envelope shape; `proof.signerRole == "raw-ecdsa"`.
4. `proof.publicKey` is one of the issuer keys **pinned for that domain**
   (`401 untrusted-issuer`).
5. The signature verifies under that key with the grant context (`401 bad-signature`).
6. Exactly the specified fields; `type`, `version`, id shapes (`400`).
7. `payload.domain` is the configured domain (`403 wrong-domain`);
   `payload.audience` equals this service's own audience (`403 wrong-audience`).
8. Timestamps well formed; lifetime at most 600 s; `now < expiresAt`
   (`401 expired`); `issuedAt` not more than 30 s in the future (`401 not-yet-valid`).
9. `worlds` and `operations` well formed; `cnf.alg == "ES256"`, `cnf.publicKey`
   a valid canonical P-256 point.
10. The operator has not revoked the grant id or the moderator reference
    locally (`403 revoked`).
11. Request: `grantId` matches (`401 wrong-grant`); `audience` and `domain` match
    the grant (`403 wrong-audience`); `operation` is `roster.view` and is in
    `grant.operations` (`403 operation-denied`); `world` is a valid id and is in
    `grant.worlds` (`403 world-denied`); `target` is empty; `issuedAt` within 60 s of
    now (`401 stale-request`); nonce well formed.
12. The request signature verifies under `cnf.publicKey` with the PoP context
    (`401 bad-pop`).
13. **A current issuer status statement lists the moderator, with this operation
    and this world, right now** (section 7). No statement: `503
    authorization-unavailable`. Not listed: `403 moderator-inactive`; operation
    or world no longer permitted: `403 operation-denied` / `403 world-denied`.
14. The nonce has not been used with this `grantId` (`401 replay`). It is spent
    only after every check above passed, kept until the grant expires plus 60 s, and
    bounded (per grant and in total; beyond the bound: `429 rate-limited`).

Failures from one source address are counted; after `MODERATION_FAIL_MAX`
(20) in `MODERATION_FAIL_WINDOW_MS` (60 s) that source gets `429 rate-limited`
with `Retry-After` until its oldest failure ages out. Responses are
`Cache-Control: no-store` and never say whether a room exists.

`tools/lib/moderation-grant.js` is the reference verifier for steps 3 to 12 and
for status statements; the two presence implementations follow the same order and
return the same status and `code` for every case (checked by the matrix run in
`test/manual-presence-moderation.js`).

## 7. The issuer status statement (revocation and scope in force)

A grant lasts up to 10 minutes. Without more, a moderator removed from the
roster would keep acting until the grant expired. Instead the issuer publishes
a signed, short-lived statement of who holds moderation authority **now**, and
a presence service acts only if its current statement lists the grant's
moderator.

`GET /atlas/moderation/status?audience=<presence origin>` (Node:
`issuer-server/server.js`; PHP: `issuer-php/atlas/moderation/status.php`).
Ungated and read-only. `403 audience-not-trusted` unless the audience is one
the issuer is configured to issue grants for, `503 moderation-not-configured`,
`429` when a client exceeds `ATLAS_MODERATION_STATUS_PER_CLIENT_PER_MIN`
(default 120). `Cache-Control: no-store`.

```json
{
  "payload": {
    "type": "atlas.moderation-status", "version": 1,
    "domain": "example.com", "audience": "https://presence.example.com",
    "issuedAt": "2026-10-10T09:00:00.000Z", "expiresAt": "2026-10-10T09:01:00.000Z",
    "moderators": [ { "moderatorRef": "<43 chars>", "worlds": ["lobby"] , "operations": ["roster.view"] } ]
  },
  "proof": { "signerRole": "raw-ecdsa", "publicKey": "<issuer key>", "signature": "..." }
}
```

```
signature = ECDSA-P256-SHA256( UTF8("atlas-moderation-status/v1\n") || UTF8(canonicalize(payload)) )
```

- It lists every key that holds authority at that moment, administrators as
  `worlds: "*"` with all four operations, moderators with their effective
  scope. Revoked, removed, ambiguous and empty-scope entries are omitted.
  Entries are sorted by reference.
- Lifetime is `ATLAS_MODERATION_STATUS_TTL_S` (default 60, clamped to 1 to 120).
- It carries only pseudonymous references and scopes; no keys.

**What a presence service does with it.**

- It accepts a statement only if it is signed by a pinned key for that domain,
  names this service's audience and that domain, is well formed, has a lifetime of at most
  `MODERATION_STATUS_MAX_TTL_S` (120 s), has an `issuedAt` within
  `MODERATION_CLOCK_SKEW_S` (30 s) of the times the fetch was sent and received,
  and has not expired.
- It relies on a statement until `min(expiresAt, requestSentAt + lifetime)`,
  measured from its own request time.
- It fetches a new statement whenever the cached one is older than
  `MODERATION_STATUS_REFRESH_S` (15 s), only on demand (a request arrives). If
  the fetch fails, the cached statement is used only until its own expiry; after that every
  request gets `503 authorization-unavailable`.
- It re-checks a cached statement against the currently pinned keys and URL on
  every use, so removing a key takes effect at once.
- The status URL is fixed in the presence configuration. It must be `https`
  (or `http` to `localhost`/`127.0.0.1`/`[::1]` for development). Redirects are not followed;
  the fetch has a 3 s timeout and a 256 KiB cap; anything other than a
  valid `200` statement is a failure.

Visitors never contact the issuer; only the presence service does, and only
when a moderator's request arrives. There is no account database.

## 8. `roster.view`

`POST /presence/moderation/roster` with the body of section 6 and
`operation: "roster.view"`. Node: `presence-server/server.js`. PHP:
`presence-php/presence/moderation/roster.php`.

Response `200`:

```json
{
  "domain": "example.com", "world": "lobby",
  "generatedAt": "2026-10-10T09:01:00.123Z", "count": 2,
  "participants": [
    {
      "ref": "<22 chars>", "name": "Alice", "world": "lobby",
      "joinedAt": "2026-10-10T08:58:10.000Z", "ageSeconds": 170,
      "presence": { "joined": true, "avatarId": "<public avatar id>" },
      "chat": { "joined": true, "senderId": "<public chat sender id>" },
      "linked": true
    }
  ]
}
```

- `chatName` appears only when the chat display name differs from the presence name.
- Only sessions of the grant's domain, in the requested world, are listed. Chat
  sessions are listed by the world they joined from. A domain's chat is shared
  by all its worlds but a world's list contains only that world's chat sessions.
- `avatarId` and `senderId` are the temporary ids every participant already sees
  on avatars and chat messages.
- `ref` is a **locator**. It is an HMAC of the session group under a secret the
  presence service keeps (Node: random per process; PHP: stored, rotated every 24
  hours), so it changes when the process restarts or the secret rotates and means
  nothing in another domain or world. **It is never accepted as a credential**:
  it is not a connection token, a grant id, a request target or anything else a
  route reads (tested). Later phases may accept it as the *target* of a command, and
  then only together with a valid grant, proof and status.
- Never returned: wallet public keys, credential ids, permanent identities, IP
  addresses or source hashes, connection tokens, Post Office relationships,
  the visit id, other domains or worlds.

## 9. Session association (visit id)

A presence avatar and a chat member have independent random ids. To show them as
one participant the wallet generates a random **visit id** per world visit
(16 random bytes, base64url; `extension/viewer.js`, `visitIdFor`) and sends it in
the presence join and the chat join (WebSocket messages and polling bodies):
`visit`.

- Generated fresh for each visit: replaced when a different domain or world is
  entered, kept across reconnects within the same visit, never derived from a wallet key or
  identity, and not shown to other participants. It is not in any join response,
  roster or broadcast.
- The server accepts `[A-Za-z0-9_-]{16,64}` and ignores anything else. It stores
  only `HMAC(visitKey, "visit/v1\n" + domain + "\n" + world + "\n" + visit)`
  truncated to 32 hex characters, with `visitKey` a server secret (Node: random per
  process; PHP: stored in the moderation state file). The raw id is never stored or
  output. Because the domain and world are in the hash, the same id in another world
  does not pair anything.
- Sessions with the same hash in the same domain and world are shown as one
  entry (at most one presence and one chat per entry; extra sessions with the same
  hash get their own entries).
- Old wallets send no visit id: their sessions are listed unpaired, as separate
  presence-only and chat-only entries.
- No persistent player tracking: the hash lives exactly as long as the session
  record that carries it (the stores are swept as before) and is not logged.

**An untrusted client chooses its own visit id.** It can omit it, send an
invalid one, split its sessions across ids or reuse one id for several of its own
sessions (shown as one linked entry plus extras). None of that gains it anything: the
visit id grants no access, only decides how a session is displayed. Someone who knew
another visitor's id could make that visitor's presence entry display as
linked with their own chat session, but ids are 128 random bits, never broadcast and
never returned. Moderators must treat the pairing as a convenience, not as proof
that two sessions are the same person.

## 10. Revocation: what is bounded, and by how much

| Event | Takes effect | Notes |
|---|---|---|
| Moderator removed or revoked in the issuer roster, issuer reachable | within `MODERATION_STATUS_REFRESH_S` (**15 s** default) of the next request | The cached statement is at most that old before a fresh one is fetched. Measured in the tests. |
| Same, but the presence service cannot reach the issuer | at most the statement lifetime (**60 s** default) after the last good fetch, then every request fails closed | Network isolation, an outage, or a blocked status URL. |
| Same, with an attacker who can replay captured statements to the presence service | at most the statement lifetime from when that statement was **issued** | A captured statement carries its own expiry, so replay cannot extend it. Needs control of the path between presence and issuer, which TLS prevents. If the issuer's clock is ahead of the presence service's by the permitted skew (30 s), a statement's expiry as the presence service sees it is up to 30 s later: with defaults the absolute worst case is 60 s + 30 s = **90 s**. |
| Scope narrowing (worlds, operations) at the issuer | same bounds as removal | The statement carries the scope in force. |
| Emergency: remove the issuer key from `issuerKeys` | next request | Presence host action. Invalidates every grant and statement of that key. |
| Emergency: `revokedModerators`, `revokedGrants` or `"enabled": false` in the presence config | next request | Presence host action; the file is read on every request. |
| Compromised moderator key | issuer: remove from roster (bounds above); presence: add `revokedModerators` for immediate effect | `node tools/moderation-ref.js <domain> <moderator public key>` prints the reference. |
| Compromised ephemeral grant key | that grant only, until it expires | Add its `grantId` to `revokedGrants`. |

So **ordinary revocation is not immediate**: it is bounded by the refresh
interval when everything is reachable and by the statement lifetime when it is not.
Immediate revocation needs an action at the presence host. Nothing here claims
otherwise. The grant lifetime (up to 10 minutes) no longer bounds revocation.
Operators who want tighter bounds lower `ATLAS_MODERATION_STATUS_TTL_S` (issuer)
and `MODERATION_STATUS_REFRESH_S` (presence), at the cost of more status fetches
(about one per refresh interval per active domain).

`test/manual-presence-moderation.js` measures all three windows (reachable,
isolated, replayed statement) with the lifetime scaled to 5 s and the refresh to
2 s; it asserts each is within its bound and prints what it measured. With the
defaults the bounds are 15 s, 60 s and 60 s (90 s with maximum post-dating).

## 11. Attacks considered

- **Minting a grant with a stolen session.** Not possible: the grant route
  needs a fresh signature from the moderator's key (section 4).
- **Replay of a grant request.** Signed requests carry the existing
  single-use `adminAuth` nonce, a timestamp window and the domain.
- **Replay of a moderation command.** The PoP request carries a nonce spent per
  grant (after all checks pass), a timestamp window, and names the audience and domain.
- **Stolen grant.** Useless without the ephemeral private key. The key is
  generated by the moderator's client and sent only as a public key; the issuer
  never sees the private half.
- **Substitution of the PoP key.** `cnf.publicKey` is inside the signed
  payload; swapping it breaks the issuer signature. Substituting it in the
  request fails the request signature.
- **Confused deputy / cross-domain.** The grant names its `domain` and
  `audience`; the presence service accepts only keys pinned for the domain a grant
  names, serves only that domain's sessions, and rejects a grant for another
  presence service. A domain's grant cannot be relabelled for another domain
  (the signature and the pin fail).
- **Visitor-forged grant, key list or role.** Issuer keys come only from the
  presence configuration; the body has a fixed shape; the request payload has a fixed
  set of fields; the verifier never reads a role or permission from a client.
- **Widening or extending.** Worlds, operations and expiry are signed; the
  status statement can only narrow what a grant allows, never widen it.
- **Delegation.** A grant is bound to the ephemeral key. The issuer will not sign
  a grant whose PoP key is the requester's long-term key or the issuer's key.
- **Privilege escalation through the grant route.** The requested scope is
  checked against the live roster, not against what the client claims.
- **Moderator using admin routes.** Refused by role on both authentication
  paths, before any nonce is spent.
- **Ambiguous roster.** Fails closed (section 1).
- **Blocking the status fetch to freeze stale state.** Presence relies on a
  cached statement only until its own expiry (section 10).
- **Hostile status endpoint.** The URL is fixed by the operator; redirects are not
  followed; size and time are capped; the statement must verify under a pinned key
  and name this audience and domain.
- **Using a locator as a credential.** Roster references, avatar ids and sender ids
  are not accepted by any connection route (tested), and `leave` with one removes nobody.
- **Guessing and flooding.** Failed moderation requests are throttled per source
  address; bodies are capped at 32 KiB; nonce storage is bounded.
- **Secrets.** Session tokens, signatures and keys are not logged and the grants store holds
  none. The issuer roster, config and grants store live in the state directory (Node) or `lib/`
  (PHP, covered by `lib/.htaccess`). The presence configuration and state live in
  `presence-server/` (Node; never served: the presence server serves no files) or
  `presence-php/presence/lib/` (PHP, covered by `lib/.htaccess`).

## 12. Operator set-up

### Issuer (per domain)

Node: set `ATLAS_MODERATION_AUDIENCES=https://presence.example.com` (and
`ATLAS_DOMAIN` as already required), or create `atlas-moderation-config.json`
in the state directory. PHP: create `lib/atlas-moderation-config.json` on the
server (not part of the repository):

```json
{ "domain": "example.com", "audiences": ["https://presence.example.com"] }
```

Optional environment: `ATLAS_MODERATION_STATUS_TTL_S` (default 60, 1 to 120),
`ATLAS_MODERATION_STATUS_PER_CLIENT_PER_MIN` (120), `ATLAS_MODERATION_MAX_LIVE_GRANTS` (10).

Add moderator entries to `atlas-admin-keys-store.json` (Node: state directory;
PHP: `lib/`). No restart is needed; the roster is read on every request.

### Presence service

Node: `presence-server/moderation-config.json` (not in the repository, git-ignored) or the file
named by `PRESENCE_MODERATION_CONFIG`. PHP: `presence-php/presence/lib/atlas-presence-moderation-config.json`
(or the same environment variable). Read on every request.

```json
{
  "enabled": true,
  "audience": "https://presence.example.com",
  "domains": {
    "example.com": {
      "issuerKeys": ["<public key from https://example.com/.well-known/atlas-key.json>"],
      "statusUrl": "https://example.com/atlas/moderation/status"
    }
  },
  "revokedModerators": [],
  "revokedGrants": []
}
```

**Safe defaults.** With no file, an unparseable file, `"enabled": false` or an invalid top level
(audience not an origin), every moderation request is `503` and nothing else changes. A domain entry with a
malformed key or an unacceptable status URL is dropped and that domain is refused. To
trust a domain you must list its key(s) yourself. The audience must be one of the origins in that
issuer's `audiences`, and the issuer must have moderation configured, or the status fetch is
refused.

Optional environment (same names, both backends): `MODERATION_STATUS_REFRESH_S` (15),
`MODERATION_STATUS_MAX_TTL_S` (120), `MODERATION_CLOCK_SKEW_S` (30),
`MODERATION_REQUEST_WINDOW_S` (60), `MODERATION_FETCH_TIMEOUT_MS` (3000),
`MODERATION_MAX_TRACKED_GRANTS` (5000), `MODERATION_MAX_NONCES_PER_GRANT` (1000),
`MODERATION_FAIL_MAX` (20), `MODERATION_FAIL_WINDOW_MS` (60000), `MODERATION_MAX_BODY_BYTES` (32768).

PHP presence needs the `openssl` extension, and `curl` or `allow_url_fopen`, only for this
endpoint. State is kept in `lib/atlas-presence-moderation-state.json` (the keys that hash visit ids and
derive references, spent nonces, the cached statement, failure counts).

A moderator signs in exactly as an administrator does and then calls the grant route with a
signed request. No client for this exists yet (the extension has no moderator UI in this phase); the
tests show the calls.

### Key rotation

Add the new issuer key to `issuerKeys` first, then switch the issuer, and remove the old key after at
least the maximum grant lifetime plus clock skew (11 minutes). Both keys are pinned for the same domain,
so accepting both during the overlap is safe. Status statements are signed with the same key, so
presence needs the new key before the issuer switches. **Removing a key from `issuerKeys` invalidates every grant and
statement it signed on the next request.**

## 13. Deployment paths

Two different `lib/store.php` files exist. They belong to different bundles and must never be swapped:

| Repository source | Bundle | Live destination (relative to the site's document root) |
|---|---|---|
| `issuer-php/lib/store.php` | **issuer** | `lib/store.php` |
| `presence-php/presence/lib/store.php` | **presence** | `presence/lib/store.php` |

See the commit hand-off for the complete list of files per bundle.

## 14. Tests

`node test/manual-moderator-authz.js node|php|compat`: administrators unchanged; moderators refused on all 20
admin routes by session and by signed proof; nonce not spent on a refused role; roster rules and fail-closed
entries; every grant validation rule; the fresh-signature rule (a session token alone, or with a bad proof, is
refused); the status statement (content, signature, audience, unconfigured, rate limit, immediate reflection of
roster changes); the reference verifier; proof of possession; quota; Node and PHP structural identity.

`node test/manual-presence-moderation.js node|php|matrix [issuer]`: starts two issuers, a presence service
and a status proxy and checks, with the same assertions for all four Node/PHP pairings:
valid scoped listing; visitors without grants; forged and unpinned issuer signatures; missing or foreign proof
of possession; wrong domain, world, audience and operation; narrowed scope; expired and replayed requests;
another domain's sessions; roster references used as connection credentials; the contents of every response
(no wallet keys, tokens, addresses, hashes or raw visit ids, and none of them in the PHP state files); visit-id
pairing and untrusted-client behaviour; measured revocation windows; issuer isolation; every kind of bad status
statement (redirect, garbage, HTML, oversize, error, wrong audience, slow, down, replayed); key removal,
rotation and local emergency revocation; the per-source throttle; and identical answers across pairings.

## 15. Limitations and unresolved decisions

1. **Ordinary revocation is bounded, not immediate** (section 10). The bound
   assumes the presence host's clock is roughly right and that the issuer's status
   endpoint is reachable. If the issuer is unreachable, moderators lose access
   once the cached statement expires (fail closed): an issuer outage ends moderation until it returns.
2. **No endpoint to manage moderators.** The roster is hand-edited on purpose: an endpoint would let a
   stolen administrator session create persistent moderators. A signed, confirmed, audited endpoint is a
   later decision.
3. **Administrators can obtain grants** (administrator includes moderation scope). Operators who do not
   want that must use separate keys.
4. **World ids are not checked against the manifest.** A grant may name a world that does not exist; the
   list is simply empty.
5. **The issuer key is shared** with credentials, mail and other signatures. The context prefixes
   separate them cryptographically, but a dedicated moderation signing key would let presence pin a key with no other
   power.
6. **The status statement exposes moderator references and scopes** to anyone who can request it for a
   configured audience. References are pseudonyms, not keys, but they are stable per domain, so the number
   of moderators, their scopes and their coming and going are observable. Keeping it private would need
   authentication of the presence service to the issuer, which is not built.
7. **Trust is configured, not discovered.** A presence service run by someone other than the domain operator
   needs the domain's issuer key and status URL delivered out of band.
8. **Timestamps depend on clocks.** Presence and issuer clocks should be within the skew allowances (30 s for
   grants and statements, 60 s for requests).
9. **The visit id is client-chosen** (section 9): pairing is a display convenience, not evidence of identity.
   A moderator sees what the participant chooses to show.
10. **Moderators see display names** exactly as participants entered them; names are not verified, as elsewhere in
    presence. The list does not show the visitor count of other worlds or domains.
11. **Presence is per process (Node).** References and visit hashes change on restart; the list is a view of the
    live sessions, not a record.
12. **PHP presence on shared hosting** makes an outbound request to the issuer when its cache is older than the refresh interval;
    hosting that blocks outbound requests will fail closed.
13. **Hostnames on the PHP issuer.** The PHP issuer refuses grant requests that arrive under a host name other
    than the configured domain; the Node issuer signs for its configured `ATLAS_DOMAIN` whatever the Host header says.
14. **No moderator actions.** Mute, kick, timeout and ban are not implemented and a grant for them authorizes
    nothing in this phase.
