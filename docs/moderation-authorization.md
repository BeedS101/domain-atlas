# Moderator authorization

Status: Phase 1D. The issuers (Node: `issuer-server/server.js`; PHP:
`issuer-php/`) register moderators and sign short-lived moderation grants; the
presence services (Node: `presence-server/`; PHP: `presence-php/presence/`)
verify those grants and answer `roster.view` (the anonymous list of sessions in
one world, section 8), `chat.mute`, `chat.unmute` and `session.kick`
(section 8A), which the presence service enforces itself, and `audit.view`
(section 8C). Since this phase there is a moderator interface (section 8B, a
section of the existing admin page, signed through the wallet's signing bridge)
and a private server-side audit log (section 8C). **There is no persistent ban,
no time-out operation and nothing that touches a wallet, credential or Post
Office membership.** `session.timeout` exists only as a name a grant may carry.
Operator set-up is in `docs/moderation-setup.md`.

The goal is narrow: a moderator can observe, and temporarily restrict, exactly
the anonymous sessions of the domain and worlds they are authorized for,
without issuer-administrator powers and without learning any wallet identity.

Files: roster and routes in `issuer-server/server.js` and `issuer-php/lib/store.php`;
PHP routes `issuer-php/atlas/admin/moderation/grant.php` and
`issuer-php/atlas/moderation/status.php`; presence verification in
`presence-server/lib-moderation.js` and `presence-php/presence/lib/moderation.php`;
PHP routes `presence-php/presence/moderation/roster.php` and `command.php`;
restrictions `presence-server/lib-restrictions.js` and
`presence-php/presence/lib/restrictions.php`; reference verifier
`tools/lib/moderation-grant.js`; reference lookup `tools/moderation-ref.js`;
audit log `presence-server/lib-audit.js` and `presence-php/presence/lib/audit.php`
(PHP route `presence-php/presence/moderation/audit.php`); the panel in
`issuer-server/admin-panel/index.html` (identical copy `issuer-php/atlas-admin/index.html`);
tests `test/manual-moderator-authz.js`, `test/manual-presence-moderation.js`,
`test/manual-presence-moderation-actions.js`, `test/manual-presence-moderation-wallet.js`,
`test/manual-moderation-audit.js` and `test/manual-moderation-panel.js`.

### Changes from Phase 1C (compatibility)

- **Vocabulary:** `audit.view` is a sixth operation name (issuers, reference verifier and
  presence services). A grant without it stays valid and simply cannot read the log.
- **Status statement:** each moderator entry may carry `role` (`admin` or `moderator`), used
  only for the audit log. Verifiers accept entries with three or four members.
  **A presence service from before this phase rejects four-member entries, so update the
  presence services before the issuer** (section 13).
- **Grant request:** may carry `purpose: "moderation-grant"` inside the signed payload. The
  wallet's signing bridge requires it (section 8B). A request without it is still valid for
  the issuer.
- **New, issuer:** `POST /atlas/admin/moderation/config` (scope `moderation`; section 8B).
  `GET /atlas/admin/is-admin` also returns `isModerator`.
- **New, presence:** `POST /presence/moderation/audit` and CORS answers (preflight and
  `Access-Control-Allow-Origin`) on the three moderation routes, for the configured
  domains' own origins only.
- **Behaviour:** a command is refused with `503 audit-unavailable` when its record cannot be
  written.
- **Wallet:** shows **Moderate** instead of **Admin** to a moderator-only key.

### Changes from Phase 1B (compatibility)

- **Vocabulary:** `chat.unmute` is a fifth operation name (issuers, reference
  verifier and presence services all accept it). A grant that lists only the old
  four stays valid; it simply cannot unmute.
- **Wire format:** the request payload keeps its ten fixed fields and may carry
  one optional member, `params`, only on `chat.mute` and `session.kick`
  (section 8A). A `roster.view` request with `params` is refused. Requests
  without `params` are byte-for-byte what Phase 1B accepted.
- **New, presence:** `POST /presence/moderation/command` (Node
  `presence-server/server.js`; PHP `presence-php/presence/moderation/command.php`).
  `POST /presence/moderation/roster` now also reports `mutedUntil`.
- **New, presence, visitor-facing:** a refused join answers `403` with
  `reason: "removed"`; a polling id whose session a moderator removed answers
  `403` instead of `404`; a muted chat send answers `reason: "muted"` (section 8A).
- **New, PHP presence:** `lib/restrictions.php` and its state file
  `lib/atlas-presence-restrictions.json` (git-ignored by the existing
  `atlas-*.json` rule, denied by `lib/.htaccess`).
- **Wallet:** shows the removal and mute messages and does not rejoin on its
  own after a removal. No moderator UI.

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
| `operations` | Moderators only. Same rules as `worlds`, over the vocabulary `roster.view`, `chat.mute`, `chat.unmute`, `session.kick`, `audit.view` (and `session.timeout`, which authorizes nothing). Absent: all of them. An empty or invalid list: none. |
| `revoked` | `true` ends the entry (unchanged). |

**An entry that omits `worlds` or `operations` is not restricted, it is unrestricted in that respect.** Operators should always list both.
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
(administrators and moderators): `POST /atlas/admin/moderation/grant`,
`POST /atlas/admin/moderation/config` and `POST /atlas/admin/session/whoami`.

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
signs every command with it. Presenting the grant alone is never enough. The
example is a `roster.view`; commands use the same envelope (section 8A).

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
`400`. The request payload has exactly the ten fields shown, plus `params` where
section 8A allows it: a client cannot add a role, a permission or a key.

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
    the grant (`403 wrong-audience`); `operation` is the one the endpoint implements
    for this request (`roster.view` on the roster route; `chat.mute`,
    `chat.unmute` or `session.kick` on the command route) and is in
    `grant.operations` (`403 operation-denied`); `world` is a valid id and is in
    `grant.worlds` (`403 world-denied`); `issuedAt` within 60 s of
    now (`401 stale-request`); nonce well formed.
12. The request signature verifies under `cnf.publicKey` with the PoP context
    (`401 bad-pop`). Then the arguments: the target and `params` of section 8A
    (`400 bad-request`); nothing has been spent yet.
13. **A current issuer status statement lists the moderator, with this operation
    and this world, right now** (section 7). No statement: `503
    authorization-unavailable`. Not listed: `403 moderator-inactive`; operation
    or world no longer permitted: `403 operation-denied` / `403 world-denied`.
14. For a command, the moderator is within the command rate limit (`429
    rate-limited` with `Retry-After`; section 8A). This comes before the nonce is
    spent, so the same request can be sent again once the window has passed.
15. The nonce has not been used with this `grantId` (`401 replay`). It is spent
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
    "moderators": [ { "moderatorRef": "<43 chars>", "role": "moderator", "worlds": ["lobby"] , "operations": ["roster.view"] } ]
  },
  "proof": { "signerRole": "raw-ecdsa", "publicKey": "<issuer key>", "signature": "..." }
}
```

```
signature = ECDSA-P256-SHA256( UTF8("atlas-moderation-status/v1\n") || UTF8(canonicalize(payload)) )
```

- It lists every key that holds authority at that moment, administrators as
  `worlds: "*"` with every operation in the vocabulary, moderators with their effective
  scope. Revoked, removed, ambiguous and empty-scope entries are omitted.
  Entries are sorted by reference.
- Lifetime is `ATLAS_MODERATION_STATUS_TTL_S` (default 60, clamped to 1 to 120).
- It carries only pseudonymous references, roles and scopes; no keys.

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
  route reads (tested). Its one use is as the *target* of a command (section 8A),
  and then only together with a valid grant, proof and status.
- `mutedUntil` (ISO time) appears on an entry while its visitor is muted.
- Never returned: wallet public keys, credential ids, permanent identities, IP
  addresses or source hashes, connection tokens, Post Office relationships,
  the visit id, other domains or worlds.

## 8A. Commands: `chat.mute`, `chat.unmute`, `session.kick`

`POST /presence/moderation/command`, body `{grant, request}` exactly as in section 6, with
`operation` one of the three and the grant holding it. Nothing else authenticates a command:
there is no second mechanism. The route runs the same checks as the roster route, in the
order of section 6, and, because it changes state, the issuer status statement (section 7)
must list the moderator with this operation and this world at the moment of the command.

```json
{ "type": "atlas.moderation-request", "version": 1, "grantId": "...", "audience": "...",
  "domain": "example.com", "world": "lobby", "operation": "chat.mute",
  "target": "<22-character reference from the roster>", "issuedAt": "...", "nonce": "...",
  "params": { "durationSeconds": 600, "cause": "spam" } }
```

**Target.** The `ref` of a roster entry for the same domain and world. It is resolved
only among the sessions of the world the request names and the grant allows; a reference
from another world or domain, a stale one, or any other string simply is not found
(`404 unknown-participant`; a malformed target is `400`). Wallet keys, addresses, tokens and
visit ids cannot be named. A PHP reference stops matching when the 24-hour key rotates; list again.

**`params`** (only on `chat.mute` and `session.kick`; omit the member when empty):

| Member | Meaning | Limits |
|---|---|---|
| `durationSeconds` | how long the restriction lasts | integer; mute 1 to 86400 (default 600), kick 1 to 3600 (default 300); `MODERATION_MUTE_DEFAULT_S`, `MODERATION_MUTE_MAX_S`, `MODERATION_KICK_DEFAULT_S`, `MODERATION_KICK_MAX_S` |
| `cause` | why, as a fixed code | `spam`, `abuse`, `harassment`, `inappropriate`, `disruption`, `other` (default) |

Anything else (an unknown member, a free-text reason, `params: {}`, params on an unmute) is
`400`. The visitor never sees moderator-written text: they see a fixed sentence per cause code,
produced by the presence service. A reason is not stored beyond the restriction and is not
published (nothing is written under `.well-known`). (A PHP service reads an empty JSON object
as an empty array, so a signed `params: {}` is answered `401 bad-pop` there instead of `400`; wallets omit empty `params`.)

**Answers** (`200`, `Cache-Control: no-store`): `{ok, operation, ref, world}` plus
`mutedUntil`, `durationSeconds`, `cause` for a mute; `wasMuted` for an unmute (unmuting someone
who is not muted is harmless); `removed {presence, chat}`, `durationSeconds`, `cause`,
`rejoinAfter` for a kick. Other answers: `404 unknown-participant`; `409 not-in-chat` (a mute
needs a chat session or a visit id to attach to); `429 rate-limited` (below);
`503 restrictions-full` (the bounded store is full; replacing an existing entry still works).
Nothing in an answer identifies a wallet, visit id, connection token or address.

**Rate limit.** `MODERATION_COMMANDS_PER_MIN` (30) commands per moderator reference per
`MODERATION_COMMAND_WINDOW_MS` (60000); listings are not counted. It is checked before the
nonce is spent: a limited request gets `429` with `Retry-After` and can be sent again unchanged.
The per-source failed-request throttle of section 6 still applies.

### What a restriction is

A restriction is **keyed by the visit** (the keyed hash of section 9, which includes domain and
world), so it covers exactly one visit to one world on one domain. The same visit id in another
world or domain, and a new visit, are not affected. A session without a visit id (an older
wallet) is restricted by its own connection only: a mute lasts as long as that chat connection;
a kick removes the session and, on the Node WebSocket server, refuses a join on that connection;
a new connection is a new participant. Restrictions never touch a wallet, credential or Post
Office membership, are private to the presence service, expire by themselves and are bounded
(`MODERATION_MAX_RESTRICTIONS` 2000, `MODERATION_MAX_RESTRICTIONS_PER_WORLD` 200,
`MODERATION_MAX_TOMBSTONES` 5000). Node keeps them in memory (a restart clears them); PHP keeps them in
`lib/atlas-presence-restrictions.json`, which holds only hashes (of visit ids and of the chat tokens of sessions without a visit id), cause codes and times, plus the connection tokens of sessions that have already been removed.

- **Mute.** The server refuses `chat-send` for the visit, by WebSocket (`chat-error` with
  `reason: "muted"`) and by polling (`200 {ok:false, reason:"muted"}`), each carrying `cause`, the
  templated `message` and `retryAfter`. It is checked before the per-member rate limit. The visitor still
  sees the world and reads chat; reconnecting chat with the same visit stays muted (a mute set before
  the visitor joined chat applies when they do). History is not deleted and no client-side filtering is
  involved. A mute lasts `durationSeconds`, or until `chat.unmute`.
- **Kick.** The presence and chat sessions of the visit are removed together. A WebSocket is sent
  `removed` / `chat-removed` (with `cause`, `message`, `retryAfter`) and stops being a member; it
  cannot send. A polling session's token is remembered for the length of the kick, so its next sync
  or send is answered `403 {reason:"removed", cause, scope, message, retryAfter}` and **not** the
  `404` the wallet treats as "swept, rejoin". A join (WebSocket or polling, presence or chat, over any
  transport) with the same visit is refused `403 {reason:"removed"}` until the kick expires. The kick check comes before the
  source's join budget, so repeated refused rejoins do not put a shared network address into a join cooldown.
  On PHP the restriction is set before the sessions are removed, with the store locks taken first and the
  restriction file last, so a join racing the kick is either refused or removed.
- **Expiry.** At `durationSeconds` the restriction is gone; the same visit may rejoin and chat. There is
  no escalation and no memory of past restrictions.

### Reconnection

| Situation | Result |
|---|---|
| Network drop, same visit, not restricted | joins as before (nothing changed) |
| Muted visit reconnects chat or presence | joins; still cannot send until the mute ends |
| Kicked visit reconnects (WebSocket, polling, either order, presence or chat) | `403 removed` until the kick expires |
| Kicked polling client keeps polling | `403 removed`, not `404`; the wallet stops and shows the message |
| Kicked WebSocket client sends or joins again on the same connection | nothing is accepted; a join answers `join-denied` / `chat-error` with `reason: "removed"` |
| WebSocket to polling fallback | same visit id, so the same restriction |
| Wallet lock/unlock (chat reconnect) | same visit id; the restriction still applies |
| Page reload, or a new visit | a new visit id: **not** restricted (accepted; see section 15) |
| Same visit id in another world or domain | not restricted |
| A bystander in the same world | untouched |

Chat is shared by a whole domain and presence is per world; a command acts on the visit's sessions in the
named world only, so no other world's sessions are affected (tested).

## 8B. The moderation panel

A "World moderation" section of the existing admin page (`/atlas-admin/`, Node
`issuer-server/admin-panel/index.html`, PHP `issuer-php/atlas-admin/index.html`, kept
byte-identical). The wallet opens the page with **Admin** for administrators and
**Moderate** for moderator-only keys. A moderator-only session sees nothing but this
section; every other panel is hidden, and every administration route still refuses the
session (section 2).

**Configuration comes from the issuer.** `POST /atlas/admin/moderation/config {token}`
returns the presence addresses the issuer itself is configured for (`audiences`), the
worlds the signed-in key may moderate, the operations it may use, the signing purpose, the
grant lifetime the panel will request, and a list of `problems` in plain language when
something is missing. The panel contacts only those addresses. It never reads an address
from the manifest, the URL or a visitor.

**Signing.** For each grant the panel creates an ephemeral ECDSA P-256 key in memory
(non-extractable, never stored; the public half goes into the grant request) and asks the
wallet's signing bridge (`window.atlasWallet.requestSignature`) to sign the grant request.
The user sees the wallet's own approval prompt with the requesting site and every field:
worlds, operations, presence address, lifetime and the ephemeral public key. The bridge
signs only for a purpose the domain manifest allows
(`walletBridge.sign: ["moderation-grant"]`); otherwise it shows no prompt and the panel
says what the operator must change. The panel never reads or exports the wallet's private
keys; it receives only the signature.

**Renewal.** A grant is not renewed silently. When it is about to lapse, or has lapsed, the
next action asks the wallet again for the same scope, with a new ephemeral key and nonce.
It cannot widen the scope: the request lists exactly the worlds and operations the issuer
config route returned. A revoked moderator's renewal is refused by the issuer; a grant
already issued stops working at the presence service within the status lifetime (section 10).

**Participants.** Loading the list, and each command, go to the presence service with the
grant and a request signed by the ephemeral key. Display names are visitor-controlled; the
panel builds every element with `textContent` (no `innerHTML`), shows names in isolated
`<bdi>` elements, and truncates them to 60 characters. Rows show a name, presence and/or
chat, join time, mute state and a temporary reference. A confirmation names the visitor and
the world and offers the fixed reasons and the permitted durations before anything is sent;
the result and the expiry are shown afterwards.

## 8C. `audit.view` and the audit log

The presence service writes one record for every moderation request that reaches a verified
grant: the one place all three moderation routes share (Node `handleModeration` in
`presence-server/server.js`; PHP `moderation_serve` in `presence-php/presence/lib/moderation.php`)
does it, so no direct call bypasses it. A request without a verified grant is refused
before any record (it has no trustworthy moderator or world); the existing per-source
failure throttle covers those.

| Field | Meaning |
|---|---|
| `seq`, `t` | position in the log; ISO time |
| `domain`, `world` | where; `world` is null when the request never named a world in the grant's scope |
| `operation` | `roster.view` (refusals only), `chat.mute`, `chat.unmute`, `session.kick`, `audit.view` |
| `moderatorRef`, `role` | the issuer's pseudonymous reference and `admin` or `moderator` |
| `grantId` | the grant's id (a reference, not a credential) |
| `target` | the temporary participant reference |
| `durationSeconds`, `cause` | the length and fixed reason code |
| `outcome`, `code` | `success`, `refused` or `failed`, and a short result or refusal code |

Never written: wallet keys, signatures, bearer tokens, ephemeral keys, request nonces, visit
ids, network addresses, display names or chat content. Fields are checked against fixed
shapes before writing; anything else is dropped, not stored.

**Storage.** A JSON-lines file private to the presence service (Node
`presence-server/moderation-audit.jsonl`, `PRESENCE_MODERATION_AUDIT_FILE`; PHP
`presence/lib/atlas-presence-moderation-audit.jsonl`, in the web-denied `lib/`), created
with mode 0600, git-ignored. It is bounded by size (`MODERATION_AUDIT_MAX_BYTES`, 1 MiB)
and age (`MODERATION_AUDIT_RETENTION_DAYS`, 90); compaction drops the oldest entries and
keeps the chain verifiable. Refusals are limited to `MODERATION_AUDIT_REFUSALS_PER_MIN`
(10) per moderator per minute, then summarised in one `audit-throttled` entry. PHP appends
under `flock`; Node serializes writes in its single thread. A successful `roster.view` is
not recorded (it would only measure how often the list is refreshed). Refusals and `audit.view` reads share one
per-moderator allowance of `MODERATION_AUDIT_REFUSALS_PER_MIN` entries a minute; the excess is summarised.

**Fail closed.** If the file cannot be written, `chat.mute`, `chat.unmute` and `session.kick`
answer `503 audit-unavailable` and change nothing.

**Reading.** `POST /presence/moderation/audit` takes the same signed request as `roster.view`
with operation `audit.view` and a world. It needs a grant that lists `audit.view` for that
world. The answer holds the entries for that domain and world only (newest first, at most
`MODERATION_AUDIT_VIEW_LIMIT`, 200), plus `integrity` (`chain`, `entries`, `lastSeq`, `head`,
`firstBadSeq`) and the retention bounds. Entries with no world appear only to a viewer whose
scope is every world. The read is itself recorded. A moderator cannot reach another world or
domain through it: the scope is taken from the verified grant, not from the request.

**Integrity limits.** Each entry carries `h = SHA-256(previous h || canonical entry)`, so a
changed, removed or reordered entry inside the file is reported as `chain: "broken"`. This is
**not tamper-proofing**. The hash chain lives in the file it protects: anyone who can
write the file (the host's operator, or an attacker with file access) can truncate it or
rewrite every entry and every hash, and the log will report `chain: "ok"`. Compaction
also removes old entries by design. Detecting truncation or a full rewrite needs the `head`
(and entry count) to be copied to somewhere the presence host cannot alter, such as an
operator's own notes or an external service; nothing here does that automatically. The log
is the presence service's own record, not independent evidence.

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

The step-by-step guide is `docs/moderation-setup.md`. Reference follows.

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
Phase 1C: `MODERATION_COMMANDS_PER_MIN` (30), `MODERATION_COMMAND_WINDOW_MS` (60000), `MODERATION_MUTE_DEFAULT_S` (600),
`MODERATION_MUTE_MAX_S` (86400), `MODERATION_KICK_DEFAULT_S` (300), `MODERATION_KICK_MAX_S` (3600),
`MODERATION_MAX_RESTRICTIONS` (2000), `MODERATION_MAX_RESTRICTIONS_PER_WORLD` (200), `MODERATION_MAX_TOMBSTONES` (5000).

PHP presence needs the `openssl` extension, and `curl` or `allow_url_fopen`, only for this
endpoint. State is kept in `lib/atlas-presence-moderation-state.json` (the keys that hash visit ids and
derive references, spent nonces, the cached statement, failure counts).

A moderator signs in exactly as an administrator does and then calls the grant route with a
signed request. The admin page's World moderation section (section 8B) does this through the
wallet; the manifest must list `"walletBridge": {"sign": ["moderation-grant"]}` for the wallet to
show the signing prompt. Optional issuer environment: `ATLAS_MODERATION_PANEL_GRANT_TTL_S` (at most 600).
Phase 1D presence environment: `MODERATION_AUDIT_MAX_BYTES`, `MODERATION_AUDIT_RETENTION_DAYS`,
`MODERATION_AUDIT_REFUSALS_PER_MIN`, `MODERATION_AUDIT_REFUSAL_WINDOW_MS`, `MODERATION_AUDIT_VIEW_LIMIT`,
`PRESENCE_MODERATION_AUDIT_FILE`. Nothing creates or replaces a live configuration file.

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

Phase 1C adds `presence-php/presence/lib/restrictions.php` and
`presence-php/presence/moderation/command.php` (presence bundle, same relative paths under `presence/`) and
`presence-server/lib-restrictions.js` (Node presence). The issuer bundle needs only the updated `lib/store.php`
(vocabulary). See the commit hand-off for the complete list of files per bundle.

Phase 1D, **deploy the presence services first, then the issuer** (the status statement now
states each moderator's role, which an older presence service rejects). Presence bundle
(under `presence/`): `lib/audit.php` (new), `lib/moderation.php`, `lib/store.php`,
`moderation/roster.php`, `moderation/command.php`, `moderation/audit.php` (new). Issuer bundle:
`lib/store.php`, `atlas/admin/moderation/config.php` (new), `atlas/admin/is-admin.php`,
`atlas-admin/index.html`. Node: `presence-server/lib-audit.js` (new), `lib-moderation.js`,
`server.js`; `issuer-server/server.js`, `issuer-server/admin-panel/index.html`. The audit file is
created on first use and is not part of any upload; do not upload a local copy.

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

`node test/manual-presence-moderation-actions.js node|php|matrix [issuer]` (Phase 1C): authorized mute, unmute and
kick over polling and (Node) WebSocket; a muted visitor's chat refused by the server; timed expiry and explicit
unmute; history kept; presence and chat sessions of a visit removed together and nothing else; `403 removed`
instead of `404`; rejoin with the same visit refused until the kick expires, without using up the source's join
budget; a new visit, and the same visit id in another world or domain, unaffected; a presence-only visit muted
before it joins chat; sessions with no visit id; wrong domain, world, unknown and cross-domain references; read-only,
mute-only and expired grants; forged and edited grants and params; replay; every argument rule; revoked moderator and
narrowed operations within the status window; local emergency revocation; the command rate limit and that a limited
request stays retryable; bounded restriction storage; no identifying data in any response or in the PHP restriction
file; identical answers across the four pairings. `node test/manual-presence-moderation-wallet.js` (browser) checks that
the real wallet's presence and chat connections are paired and that a moderator's kick over both transports shows the
visitor the removal message and is not undone by the wallet.

`node test/manual-moderation-audit.js node|php|matrix` (Phase 1D, HTTP level): issuer config and `is-admin`
shapes; role in the status statement; mute, unmute and kick recorded with the right fields and roles;
every refusal kind recorded; entries limited to the viewer's world and domain; a revoked moderator
refused and recorded; no key, token, visit id, address, name or chat text in the file or any response;
file mode 0600 and the PHP `.htaccess`; hash-chain tamper detection; 30 concurrent writers with no
lost or duplicated sequence numbers; size and age bounds and the refusal throttle; commands refused when
the log is not writable; chat and presence working when moderation is unconfigured; CORS only for
configured domains; Node/PHP parity across the four pairings.

`xvfb-run -a node test/manual-moderation-panel.js node|php|matrix` (Phase 1D, real Chromium with the
extension): a stranger gets no button; an administrator still has every existing panel plus the new
section; the wallet's own prompt is shown, can be declined (no session) and approved; the grant names
only what the panel offered; hostile display names (markup, script, svg handler, bidirectional override,
over-long) appear as text and run nothing; mute, unmute and kick through the UI with the server really
enforcing them; replayed and re-targeted commands refused; the audit viewer; a moderator-only key sees
only the moderation section, only its own worlds, and is refused by administration routes; a manifest
without the signing purpose gives no prompt; renewal asks the wallet again for the same scope with a new
key; a mute expires on its own; a revoked moderator is refused; static check that the panel code builds
no HTML from data and touches no wallet storage.

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
14. **Only mute, unmute and kick exist.** `session.timeout`, persistent bans and mandatory membership tickets
    are not implemented; a grant naming `session.timeout` authorizes nothing.
15. **A new visit bypasses a mute or kick.** Restrictions follow the per-visit id the wallet generates, not a
    person: a page reload, or clearing the wallet's state, makes a new visit. This is a deliberate trade-off (no
    fingerprinting, no permanent identifiers, no address matching). Restrictions are cooldowns, not bans.
16. **Sessions with no visit id** (older wallets) are restricted only for the life of the connection: a mute
    follows that chat connection; a kick removes the sessions, but a new connection joins freely.
17. **Chat's world field is declared by the client.** A chat session is listed, and therefore targetable,
    under the world it says it joined from; a visitor that lies is moderated, or missed, accordingly.
18. **PHP clients learn of a kick on their next poll** (there are no pushes), within one polling interval; a
    kicked session is already gone from the roster and can send nothing in the meantime.
19. **Restrictions are not shared between presence processes.** Node keeps them in memory (a restart clears
    them); two presence services for one domain would each need the command. PHP keeps them in a file and
    shares them between requests on one host.
20. **A PHP reference is only valid for the 24-hour key period**; a command with a stale one answers `404` and the
    moderator lists again.
21. **The audit log is not tamper-proof** (section 8C). It detects accidental damage and casual edits only; the
    host's operator can rewrite it. Truncation and full rewrites are detectable only if the operator keeps the
    `head` value elsewhere.
22. **Some events are not recorded.** Successful `roster.view`; requests refused before a grant was verified
    (bad signature, unknown issuer key, malformed body), which only count against the per-source throttle; and
    refusals beyond the per-minute cap (summarised). Nothing is recorded if the host itself is compromised.
23. **The panel's key is as safe as the admin page's origin.** The ephemeral signing key is non-extractable and
    held in a script closure, never stored, but script running on the same origin (an XSS on the domain's
    admin page) could ask it to sign while a session is active. The wallet prompt for each grant, short grant
    lifetimes and the roster/scope limits bound the damage; they do not remove it.
24. **The audit file is only as private as the host.** It is outside public paths and mode 0600, but PHP shared
    hosting relies on `lib/.htaccess`; check that your server honours it. Backups of the host include it.
25. **Retention is bounded by design.** Older entries are dropped (1 MiB or 90 days by default); copy the file
    if you need a longer history.
26. **Update order.** The presence service must be updated before the issuer (section 13).
27. **Not exercised by the tests:** a live deployment, Apache `.htaccess` enforcement (the PHP built-in server used
    in tests ignores it), real HTTPS and cross-site CORS between separate hosts, WebAuthn identity mode with the
    panel, and multi-process Node presence.
28. **Release review (Phase 2) findings left as limitations.**
    - A command can be applied with no audit record if the log write fails after the pre-check (disk full). The
      pre-check refuses most such cases; the PHP write is now checked, but a command already carried out cannot be
      undone. An `audit-unavailable` answer still spends the request nonce and counts against the command rate limit.
    - A moderator can keep issuing real commands (30 a minute) and so push the oldest entries out of the size-bounded log.
    - A moderator key can spend request nonces by sending rejected grant requests (the issuer's signed-request nonce
      store is shared with administrator signed requests); while it is full, signed-proof admin calls answer `503 busy`
      for a few minutes. Administrator session tokens and the panel are unaffected.
    - PHP presence only: chat world ids with leading or trailing Unicode white space (for example U+00A0) are kept as
      sent, whereas Node trims them, so such a participant sits in a world no moderator can name. This is the same
      evasion as limit 17 (a visitor can declare any chat world), not a new one.
    - PHP signed requests with an integral float (`600.0`) are refused where Node accepts them; JavaScript clients
      never send one.
    - PHP: `roster.view` rewrites the restrictions file once per listed participant under its lock and is not rate
      limited; a moderator can slow chat on a busy world. The PHP state and restrictions files are rewritten in place
      (truncate then write), so a crash or full disk mid-write can empty them, which forgets active mutes and spent nonces.
    - The per-source failure throttle is per socket address: behind a shared proxy address or NAT, junk requests from
      one anonymous caller can make moderators on that address wait up to a minute.
    - Without moderation configured the PHP presence still opens and locks `lib/atlas-presence-restrictions.json` on every
      chat send and creates `lib/atlas-presence-moderation-state.json` on joins with a visit id: the `lib/` folder
      must stay writable, as it already must for the other state files.
    - The wallet's signing prompt signs the payload the page supplies for a whitelisted purpose and shows every field.
      A script running on a page of a domain that whitelists `moderation-grant` could ask for a signature over a
      different payload (for example an administrator request); the administrator would have to read the prompt
      (`adminAuth.action` shows the target route) and approve it. Whitelist the purpose only where needed.
    - Anyone can ask `GET /atlas/admin/is-admin?publicKey=` whether a key is an administrator or moderator (the
      wallet's button uses it); public keys are not secret, but the answer confirms a key's role.
