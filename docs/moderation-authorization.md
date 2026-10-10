# Moderator authorization

Status: Phase 1A. The issuers (Node: `issuer-server/server.js`; PHP:
`issuer-php/`) can register moderators and sign short-lived moderation grants.
**Nothing accepts a grant yet.** The presence service is unchanged, there are no
moderation commands, and nothing in this phase can mute, kick or inspect
anyone. The wire format below is meant to be reviewed before the presence
service starts consuming it.

Files: roster and routes in `issuer-server/server.js` and `issuer-php/lib/store.php`;
PHP route `issuer-php/atlas/admin/moderation/grant.php`; reference verifier
`tools/lib/moderation-grant.js`; tests `test/manual-moderator-authz.js`
(`-php.js` companion).

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
moderator (see section 11), and no self-registration.

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

**Presence side (Phase 1B, to be built).** The presence service is configured
with, for each domain it serves, the pinned issuer public key(s) for that
domain, and its own audience string. It does not fetch keys at verification
time and does not take them from the manifest, so a hostile manifest cannot
point a presence service at an attacker's key. The pin is set by whoever
operates the presence service, which for this project is the same operator.
(An operator running presence for other domains needs an out-of-band step to
obtain each domain's key; that is a limitation, section 11.)

## 4. Requesting a grant

`POST /atlas/admin/moderation/grant`

Body: `{payload, proof}` (signed request) or `{payload, token}` (session).
A signed request carries the usual `payload.adminAuth` with
`action: "/atlas/admin/moderation/grant"`.

Payload (strict; unknown fields are rejected):

| Field | Rules |
|---|---|
| `audience` | Configured presence origin. |
| `worlds` | `"*"` or 1 to 32 distinct valid world ids. |
| `operations` | 1 to 4 distinct names from the vocabulary. |
| `ttlSeconds` | Optional integer 1 to 600. Default 300. |
| `popPublicKey` | Fresh ephemeral raw P-256 public key, 87 base64url characters (65 bytes, `0x04` prefix, a point on the curve, canonical spelling). Must differ from the requester's long-term key and from the issuer key. |
| `adminAuth` | Signed mode only. |

The request must lie inside the key's **current** authority: every requested
operation and world must be allowed, and `"*"` is allowed only to a key whose
authority is all worlds. Administrators may also ask for grants.

Errors: `400 bad-request` (malformed or unknown field), `400 wrong-domain`,
`401 not-admin` / `replayed-request` / `session-invalid` / other
authentication codes, `403 audience-not-trusted`, `403 scope-denied`,
`429 grant-quota` (more than `ATLAS_MODERATION_MAX_LIVE_GRANTS`,
default 10, unexpired grants for the moderator), `503 moderation-not-configured`.

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

## 6. Using a grant (Phase 1B wire format, reviewable now)

The moderator keeps the ephemeral private key generated with the request and
signs every command with it. Presenting the grant alone is never enough.

```json
{
  "grant": { ...as issued... },
  "request": {
    "payload": {
      "type": "atlas.moderation-request", "version": 1,
      "grantId": "<same as the grant>", "audience": "<presence origin>", "domain": "example.com",
      "world": "lobby", "operation": "chat.mute", "target": "<opaque id of the participant>",
      "issuedAt": "2026-10-10T09:01:00.000Z", "nonce": "<16-128 base64url characters>"
    },
    "signature": "<ECDSA by the grant's cnf key, base64url raw>"
  }
}
```

```
signature = ECDSA-P256-SHA256( UTF8("atlas-moderation-pop/v1\n") || UTF8(canonicalize(request.payload)) )
```

### Verification a presence service performs, in order

1. Grant envelope shape; `proof.signerRole == "raw-ecdsa"`.
2. `proof.publicKey` is one of the issuer keys **pinned for `payload.domain`**
   in the presence service's own configuration.
3. The signature verifies under that key with the grant context.
4. Exactly the specified fields; `type`, `version`, id shapes.
5. `payload.domain` is a domain this service serves, and the room being
   acted on belongs to that domain.
6. `payload.audience` equals this service's own configured audience.
7. Timestamps well formed; lifetime at most 600 s; `now < expiresAt`;
   `issuedAt` not more than 30 s in the future.
8. `worlds` and `operations` well formed; `cnf.alg == "ES256"`, `cnf.publicKey`
   a valid canonical P-256 point.
9. Request: `grantId`, `audience`, `domain` match the grant; `operation` is in
   `grant.operations`; `world` is in `grant.worlds` (or the grant has `"*"`);
   `issuedAt` within 60 s of now; nonce well formed.
10. The request signature verifies under `cnf.publicKey` with the PoP context.
11. The nonce has not been used with this `grantId` (kept until the grant
    expires plus 60 s).

`tools/lib/moderation-grant.js` implements steps 1 to 11 and is exercised by
the tests; a PHP port is needed before the PHP presence bundle can accept grants.

## 7. Attacks considered

- **Replay of a grant request.** Signed requests carry the existing
  single-use `adminAuth` nonce; session-token requests need the live session.
- **Replay of a moderation command.** The PoP request carries a nonce spent per
  grant, a timestamp window, and names the audience and domain.
- **Stolen grant.** Useless without the ephemeral private key. The key is
  generated by the moderator's client and sent only as a public key; the issuer
  never sees the private half.
- **Substitution of the PoP key.** `cnf.publicKey` is inside the signed
  payload; swapping it breaks the issuer signature. Substituting it in the
  request fails the request signature.
- **Confused deputy / cross-domain.** The grant names its `domain` and
  `audience`, and the presence service accepts only keys pinned for the domain
  it is acting for. A grant from domain A cannot act on domain B's rooms, and
  a grant for presence service X is rejected by Y.
- **Widening or extending.** Worlds, operations and expiry are signed.
- **Delegation.** A grant is bound to the ephemeral key. Moderators cannot
  re-issue it. The issuer will not sign a grant whose PoP key is the
  requester's own long-term key or the issuer's key.
- **Privilege escalation through the grant route.** The requested scope is
  checked against the live roster, not against what the client claims.
- **Moderator using admin routes.** Refused by role on both authentication
  paths, before any nonce is spent.
- **Ambiguous roster.** Fails closed (section 1).
- **Secrets.** Session tokens, signatures and keys are not logged and the
  grants store holds none. The roster, the config file and the grants store live
  in the state directory (Node) or `lib/` (PHP, covered by `lib/.htaccess`); none is
  served by the document root.

## 8. Rotation and revocation

- **Revoking a moderator** (mark the entry `"revoked": true` or remove it):
  no new grants, no new sessions, existing sessions die on their next
  request. **Grants already issued stay valid until they expire**, at most
  10 minutes. Phase 1A has no revocation feed; if that window is too long,
  lower `ttlSeconds` by policy or build a feed in Phase 1B.
- **Changing a moderator's scope** affects new grants immediately; grants already
  issued keep the scope they were signed with.
- **Rotating the issuer key.** Add the new key to the presence service's pin
  list first, then switch the issuer, and remove the old key after at least the
  maximum grant lifetime plus clock skew (11 minutes). Accepting both keys
  during the overlap is safe because both are pinned for the same domain.
- **Key compromise.** Remove the compromised key from the pin list at once;
  every grant it signed becomes invalid. A compromised moderator key is
  revoked in the roster as above. A compromised *ephemeral* key affects only
  that grant, for at most its remaining lifetime.

## 9. Operator set-up

Node: set `ATLAS_MODERATION_AUDIENCES=https://presence.example.com` (and
`ATLAS_DOMAIN` as already required), or create `atlas-moderation-config.json`
in the state directory.

PHP: create `lib/atlas-moderation-config.json` on the server (the file is not
part of the repository):

```json
{ "domain": "example.com", "audiences": ["https://presence.example.com"] }
```

Add moderator entries to `atlas-admin-keys-store.json` (Node: state directory;
PHP: `lib/`). No restart is needed; the roster is read on every request.

A moderator signs in exactly as an administrator does and then calls the
grant route. No client for this exists yet (the extension has no moderator UI
in this phase); the tests show the calls.

## 10. Tests

`node test/manual-moderator-authz.js node|php|compat` (plus
`test/manual-moderator-authz-php.js`). They cover: legacy and explicit
administrators unchanged; moderators refused on all 20 admin routes by session
and by signed proof; nonce not spent on a refused role; immediate effect of
revocation, demotion, promotion and scope changes; unknown roles and ambiguous
entries; empty and invalid scopes; every grant validation rule; wrong audience,
domain, expired, future-dated, altered and replayed requests; the reference
verifier on the issued grants including tampering; proof-of-possession
failures; the live-grant quota; the unconfigured state; and identical grant
structure from the Node and PHP issuers.

## 11. Limitations and unresolved decisions

1. **Bearer session versus signature for grant requests.** Both work. A stolen
   admin-panel session token can obtain grants for the key's scope for the
   life of the session; requiring a fresh signature per grant would limit that
   at the cost of a wallet prompt per grant. Not decided.
2. **No endpoint to manage moderators.** The roster is hand-edited on purpose:
   an endpoint would let a stolen administrator session create persistent
   moderators. A signed, confirmed, audited endpoint is a later decision.
3. **Administrators can obtain grants** (administrator includes moderation
   scope). Operators who do not want that must use separate keys.
4. **World ids are not checked against the manifest.** A grant may name a world
   that does not exist; presence will simply find no such room.
5. **The issuer key is shared** with credentials, mail and other signatures.
   The context prefix separates them cryptographically, but a dedicated
   moderation signing key would let presence pin a key with no other power.
6. **Revocation latency of up to 10 minutes** for grants already issued.
7. **Presence needs a verifier.** The reference verifier is Node; the PHP
   presence bundle needs a port. Presence also needs a place to hold pinned
   keys and spent nonces.
8. **Trust is configured, not discovered.** A presence service run by someone
   other than the domain operator needs the domain's issuer key delivered out
   of band. A signed, domain-controlled declaration is a possible later step
   and is not trusted by anything here.
9. **Rate limits** on the grant route rely on the existing admin throttles and
   the per-moderator live-grant quota.
10. **Timestamps depend on clocks.** Presence and issuer clocks should be
    within the skew allowances (30 s for grants, 60 s for requests).
11. **Hostnames on the PHP side.** The PHP issuer refuses grant requests that
    arrive under a host name other than the configured domain; the Node issuer
    signs for its configured `ATLAS_DOMAIN` whatever the Host header says.
