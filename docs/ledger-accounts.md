# Ledger accounts in the Gen 1 wallet

Status: the wallet side of the Ledger tab is built and tested against local test doubles. **No
adapter ships and nothing in this repository reads a real balance.**

This document keeps three things apart, and says which one each statement is about:

- **Built**: what the wallet does today.
- **Experimental**: the Chainblock Labs 29 prototype (`ledger29.php`, in the Core repository). It is
  a read-only prototype with no funded accounts, no finality and no signed balance receipts. It is
  not the finished contract and the wallet does not talk to it.
- **Intended**: the contract agreed for the finished interface. It is written down here so the
  wallet, the issuer and the ledger can be built to it. Items marked *proposed* are suggested
  encodings that still need to be frozen.

## What the Ledger tab is

A third inventory sub-tab, **Ledger**, beside Collectibles and Documents. It lists *references* to
accounts that live on a remote ledger. The wallet never holds an authoritative quantity for them,
and account existence and balance stay with the ledger.

Portable assets (`domain-atlas-asset/1.0`, for example `atlas.element.gold`) are untouched: same
credential, same signing, same storage, same lists. Ledger accounts use their own credential type
and their own store, so nothing that reads or verifies assets can see them or be changed by them.

## The credential

`domain-atlas-ledger-account/1.0`, signed by the issuing domain's key (**built**):

```json
{
  "credential": "domain-atlas-ledger-account/1.0",
  "id": "urn:atlas:ledger-account:<8-64 chars>",
  "issuer": { "domain": "ledger.example.com", "publicKey": "<base64url>" },
  "ledger": { "network": "<network or scheme id>", "coin": "GOPH" },
  "owner": { "publicKey": "<base64url>" },
  "issuedAt": "2026-10-01T00:00:00Z",
  "signature": "<base64url>"
}
```

The signature covers `{id, ledger, owner, issuedAt}` (canonical JSON, ECDSA P-256 over SHA-256, raw
64-byte `r||s`). Every level of the object is checked against an allow-list of keys, and any field
whose name looks like a figure (balance, quantity, amount, available, total, holdings, funds,
value, supply, decimals, units and similar) is refused at any depth. A credential cannot carry a
balance, so there is nothing for a wallet to mistake for one. Labs 26 treasury allocations are not
wallet balances and are not read by anything here.

### Canonical forms (intended)

Three values feed account identity, so each has exactly one accepted spelling. A ledger or wallet
that receives any other spelling **rejects it; it does not normalize it**.

| Value | Canonical form |
| --- | --- |
| Network ID | The string the ledger's signed discovery document publishes, compared byte for byte. |
| Coin ID | The ledger registry's symbol exactly as registered. For the Labs registry that is upper-case letters and digits, 2 to 10 characters, starting with a letter. |
| Owner public key | Unpadded base64url of the 65-byte uncompressed P-256 point (87 characters). Whatever format an identity uses to sign, its owner key in a credential and in a request is this form. |

### Account ID (intended, *proposed* encoding)

The account ID is derived, not random, so the same account always has the same ID and issuing it
twice is harmless:

```
input = canonicalize({ "coin": C, "network": N, "owner": K,
                       "purpose": "atlas.ledger.account-id", "v": 1 })
id    = "urn:atlas:ledger-account:" + lowercase-hex(SHA-256(UTF-8(input)))
```

`canonicalize` is the same sorted-key JSON used for every other signature in Domain Atlas. The
`purpose` field is the domain separation: a hash made for any other use cannot collide with an
account ID. The result is 64 hex characters and fits the wallet's existing ID rule. The ID names an
account; it does not prove one exists. The ledger decides that.

**Built:** the wallet accepts any ID that matches the ID rule and does not yet check the
derivation. It will start to once the derivation is frozen. No real credentials exist, so the rule
can be part of version 1.0.

## What the wallet stores (built)

One record per account, under the owning identity's public key:

| Field | Meaning |
| --- | --- |
| `credential` | The credential above, verbatim. |
| `consent` | Absent until the person allows lookups. Holds the ledger origin they allowed. |
| `backgroundSync` | Separate per-account switch. Default **off**. |
| `cache` | The last balance the ledger reported, with the ledger's own time and when it was fetched. Display only. |
| `lastProblem`, `lastAttemptAt` | Last failure code and time, shown in words. |
| `pendingEndpointOrigin` | A changed ledger address waiting for approval. |

The balance is an integer string of minor units plus the coin's `decimals`, for example
`{"amount":"2000","decimals":2}` shows as 20.00. It is never added, compared or converted by the
wallet. Decimals are defined by the coin, not by the wallet or the credential.

## Network access and consent

**Built:**

- Adding an account contacts only the issuing domain, to check its signature and revocation. The
  person is asked first and the question names the domain.
- Looking up a balance needs **per-account permission** that names the issuer and says the wallet
  will follow the ledger address the issuer publishes. Until then the wallet sends nothing for
  that account.
- The ledger's **origin** is pinned at the first lookup. If the issuer later publishes a different
  address the wallet stops and asks again ("Allow new address…").
- Requests are limited to the issuer origin and the pinned ledger origin, with no redirects and no
  cookies. Only `https` is accepted, plus `http` on loopback for testing.
- Opening the tab looks up only accounts that have permission, and not again within 30 seconds.
- **Background checks** are a separate, per-account switch, **off by default and opt-in**. They run
  only while a wallet page is open (a 60-second tick, one tab at a time through a Web Lock), at
  most every 10 minutes per account and never faster than 5. There is no service-worker polling.
  They are refused for identities that cannot sign without a prompt.

**Intended change:** the pin becomes the set of exact **per-operation HTTPS URLs** from the signed
discovery document (below), not an origin. An origin pin is too loose: it would follow any path on
the host. The wallet's current origin-only rule also **refuses any endpoint that has a path**, so
it cannot use the Labs 29 address as published. Changing the pin is part of the adapter work and
has not been done.

## Signed discovery (intended)

The issuer publishes `/.well-known/atlas-ledger.json`, signed with the key already published for
that domain in `/.well-known/atlas-key.json` (the same key document the wallet uses to check
credentials, with the same `validFrom`/`validUntil` rule). *Proposed* shape:

```json
{
  "payload": {
    "type": "atlas.ledger.discovery",
    "v": 1,
    "contract": "<contract name and version>",
    "issuer": "ledger.example.com",
    "network": "<network id>",
    "proofFormats": ["raw-ecdsa-p256"],
    "operations": {
      "balance":  "https://ledger.example.com/<path>",
      "accounts": "https://ledger.example.com/<path>"
    },
    "issuedAt": "2026-10-01T00:00:00Z",
    "expiresAt": "2026-10-02T00:00:00Z"
  },
  "issuerKey": "<base64url public key>",
  "signature": "<base64url>"
}
```

The wallet accepts it only if all of these hold:

- The signature checks against a key the issuer's key document lists as valid at `issuedAt`.
- `issuer` equals the credential's issuer domain and `network` equals the credential's network.
- `contract` is one an installed adapter implements.
- It has not expired, and every operation URL is `https` (or `http` on loopback for tests) with no
  credentials or fragment.

Operation URLs may carry a query string, because the experimental service uses one, but they are
compared whole. Nothing in the document may name a balance. An operation URL may be on a different
origin from the issuer, because the person is told every origin before they allow lookups.

## Requests and proof of ownership (intended)

Every ledger request is a signed payload from the owning identity:

```
payload = { type, v, audience, network, coin, nonce, issuedAt }     (type: atlas.ledger.balance)
proof   = { publicKey, signature, ... }
```

- Signing is ECDSA P-256 over SHA-256 of the canonical JSON of `payload`. This is exactly what the
  wallet's local identities produce and what Labs 29 verifies (checked by running it, below).
- `nonce` is 32 to 64 lowercase hex characters, and a ledger must remember a nonce for as long as
  it accepts the request's `issuedAt`. A nonce seen twice is refused.
- `issuedAt` must be within two minutes of the ledger's clock.
- *Proposed:* `audience` is the **exact operation URL**, not the origin, so a signature cannot be
  carried to another operation or path on the same host. Labs 29 uses the origin today.
- Ledgers must not depend on the order of payload keys. Labs 29 does, which is a bug to fix.
- Ledger messages carry `atlas.ledger.*` types and are refused by the wallet's page-facing signing
  function. They are signed only by the wallet's own ledger code.

**Account rediscovery** uses the `accounts` operation with the same kind of signed request (type
`atlas.ledger.accounts`). The signature is the proof of ownership. The ledger returns only
accounts that exist for the proving key, each as an issuer-signed credential, and the wallet
re-verifies every one (issuer signature, owner equals the proving key, derived ID, network, coin)
before keeping it. Recovered accounts come back with no permission and no balance.

## Passkey identities

- **Built:** a passkey identity can only sign through a hardware prompt, so background checks are
  unavailable for it. The Ledger tab does not yet check whether the ledger can verify a passkey
  proof before it asks for the prompt.
- **Intended:** a passkey identity **must not attempt authentication a ledger cannot verify**. The
  wallet checks the proof formats the discovery document lists against the identity's own format
  and, when they do not overlap, shows lookups as unavailable with the reason and starts no
  prompt. Manual lookups with a passkey become possible once the ledger has a compatible assertion
  verifier. Delegated sessions, so a passkey could authorize a short run of background checks, can
  be designed later; the issuer's existing mail session is the precedent.
- **Known gap (built):** a passkey identity's public key is a 91-byte encoded key that is 122
  base64url characters, but the credential validator accepts owner keys of at most 120. A
  passkey-owned credential would be refused today. The canonical owner form above fixes this: the
  credential carries the 65-byte point, and the wallet extracts the same point from the passkey's
  key to compare.

## Indicators (built)

Each account shows two indicators, each with a glyph, a word and a visible sentence, so state is
never colour alone:

| Level | Glyph | Meaning |
| --- | --- | --- |
| Unavailable | ⊘ | Cannot happen now (no interface for that ledger, wrong or locked identity, needs a prompt each time). |
| Available | ○ | Possible, but not allowed yet. |
| Enabled | ● | Allowed by the person. |
| Connecting | ◐ | A request is out right now, and to whom. |

"Lookup" and "Background check" are shown separately. A manual request in flight does not claim to
be a background one. The status line is a polite live region; the pulse on Connecting stops under
reduced motion.

## Removing an account (built)

"Remove from wallet…" deletes the local reference only. It cancels any request in flight, makes no
network call at all, and ends background activity because the record is gone. The ledger account
and its balance are not touched, and the confirmation says so.

## Multiple identities (built)

- A reference belongs to the **owner public key** in its credential. It is shown only when that
  identity is active and unlocked; the tab names which identity it is showing.
- Nothing assumes the default identity. Adding a credential owned by another identity is refused
  with a plain reason rather than filed under the wrong one.
- This repository has local-password identities (silent signing) and passkey identities (a
  hardware ceremony per signature), plus a local test counterparty. There is **no separate vault
  identity type here**; the rules key on whether an identity can sign without asking.

## Balance responses

**Experimental (Labs 29):** the response is `{amount, decimals, asOf, …}` over TLS only. There is no
signature, no binding to the request and no ledger state reference. `asOf` is the time the server
answered, not the time of any ledger state.

**Intended:** the balance response becomes a signed **receipt**, so the wallet can check it without
trusting the connection alone. *Proposed* shape:

```json
{
  "payload": {
    "type": "atlas.ledger.balance-receipt", "v": 1,
    "request": { "nonce": "<from the request>", "hash": "<SHA-256 of the canonical request payload>" },
    "network": "<id>", "coin": "GOPH", "owner": "<canonical owner key>",
    "amount": "2000", "decimals": 2,
    "state": { "sequence": "<integer string>", "asOf": "<time of that ledger state>" }
  },
  "signerKey": "<base64url public key>",
  "signature": "<base64url>"
}
```

`amount` is an integer string of minor units and `decimals` is the coin's own precision. The
receipt names the request it answers and the ledger state it reads, so an old answer cannot be
passed off as a new one. The key that signs it is either the issuer's or one the signed discovery
document lists. Until receipts exist, the wallet should label a balance **reported, not signed**
rather than present it as verified.

## Adapter interface

**Built:** the wallet has the slot and no adapter. An adapter is how the wallet talks to one kind
of ledger:

```
contract                                a string naming the interface it implements
supports({issuerDomain, network, coin}) true if it can serve that target
discover(target, ctx)                   -> { endpoint }          the ledger's current origin
fetchBalance(target, endpoint, ctx)     -> { amount, decimals, asOf }
listAccounts(target, endpoint, ctx)     -> [ credential, ... ]   optional
```

`ctx.fetch` is limited to the issuer origin and the pinned ledger origin, `ctx.sign(payload)` signs
only `atlas.ledger.*` payloads whose `audience` is an allowed origin, and `ctx.signal` aborts on
removal or when permission is withdrawn. Until an adapter registers, the tab shows lookups as
unavailable and says why.

### Adapter design for the intended contract (not built)

The adapter is the only place that knows a ledger's wire format. The wallet decides who may be
contacted and what a figure may be; the adapter cannot widen either.

1. **Discover.** Fetch `/.well-known/atlas-ledger.json` from the issuer origin and
   `/.well-known/atlas-key.json`. Verify the signature, the issuer, the network, the contract, the
   proof formats and the expiry as above. Return `{ operations, proofFormats, expiresAt }`. The
   wallet pins the operation URLs, and a different set later asks the person again.
2. **Supports.** Return false, with a reason, when the identity's proof format is not in
   `proofFormats`. The wallet then shows lookups as unavailable and starts no prompt.
3. **Fetch a balance.** Build the request payload, sign it through `ctx.sign` with `audience` set
   to the balance operation URL, and post to exactly that URL. Nothing else is contacted.
4. **Check every response.** An answer is used only if all of these hold, and any failure is a
   `bad-response` that stores nothing:
   - `network` equals the credential's network;
   - `coin` equals the credential's coin;
   - the owner key equals the credential's owner key in canonical form;
   - `amount` is an integer string of digits and `decimals` an integer in range;
   - once receipts exist: the signature verifies, the request nonce and hash match, and the state
     reference is not older than the cached one.
5. **List accounts.** Send the signed `accounts` request, and return the credentials the ledger
   gives. The wallet verifies each before keeping it.
6. **Never** read a figure from a credential, a discovery document or a Labs 26 allocation.

### Structured errors

The ledger answers failures with a JSON body `{ "ok": false, "code": "<code>", "message": "…" }`.
The status code is secondary, because a wrong path and a missing account must not look alike.
*Proposed* codes and what the wallet shows:

| Code | Meaning | Wallet problem |
| --- | --- | --- |
| `malformed-request` | Request is not in the agreed shape. | bad response |
| `unsupported-proof` | The proof format is not one the ledger verifies. | not supported |
| `bad-signature` | The signature or key does not verify. | unauthorized |
| `stale-request` | `issuedAt` is outside the window. Body also carries `serverTime`. | device clock is off (new) |
| `replayed-request` | The nonce was already used. | busy; try again |
| `wrong-audience` | `audience` is not this operation. | bad response |
| `unknown-network` | Not this ledger's network. | not supported |
| `unknown-coin` | The coin is not registered. | unknown coin (new) |
| `no-account` | The coin exists but this identity has no account. | not found |
| `rate-limited` | Too many requests. | try later (new) |
| `unavailable` | The ledger cannot answer now. | network |

A body without a `code` is treated as `bad-response`, whatever the status.

### Wallet changes this needs (not yet made)

- Pin and fetch by exact operation URL, and a new `discover` result shape.
- A helper that verifies the signed discovery document, and another that checks the derived account ID.
- Compare owner keys in canonical form, and relax the owner-key length rule for the passkey case.
- Check proof formats before any prompt.
- Map structured error codes, and add the three new problem messages.
- A response check shared by every adapter (items in step 4).
- Re-check revocation on each refresh, which is not done today.
- Label unsigned balances as reported, not verified.
- If an adapter for the experimental service is ever installed for testing, it stays off by default
  and is labelled experimental.

## Current experimental implementation versus the intended contract

What the wallet cannot do with Labs 29 today, and where each gap belongs. "Core" is the Chainblock
Labs repository; "issuer" is the domain's PHP/Node issuer in this repository.

| Area | Labs 29 today | Intended | Owner |
| --- | --- | --- | --- |
| Discovery | Unsigned `GET …/ledger29.php?action=discovery`; one endpoint URL with a path | Signed `/.well-known/atlas-ledger.json` with per-operation URLs | Issuer (signing, well-known), Core (content) |
| Endpoint pin | Wallet pins an origin and refuses a path | Wallet pins exact operation URLs | Wallet |
| Request shape | `{type, v, audience, network, coin, nonce, issuedAt}` plus proof; keys must arrive in a fixed order | Same fields, order-independent; `audience` the operation URL (proposed) | Core |
| Signature | Raw P-256 over canonical JSON; matches the wallet's local identities | Same | none |
| Owner key | Accepts the 65-byte point only, compares the string as sent | Canonical spelling only, re-encoded and checked | Core |
| Passkeys | Rejected as malformed | Declined by the wallet; verifier to come | Wallet, Core |
| Replay | A repeated nonce is accepted within two minutes | Nonce store; repeated nonce refused | Core |
| Errors | Free text; 404 for several different causes | Structured `code` field | Core, then wallet |
| Balance response | `{amount, decimals, asOf}` over TLS only | Signed receipt with request binding and state reference | Core, issuer |
| Account credential | None issued | Issuer-signed, derived ID | Issuer, with Core deciding when an account exists |
| Account creation | No account is created or funded; Labs 26 allocations are not credited | Ledger-authoritative; creation separate from allocation | Core |
| Rediscovery | No listing operation | Signed `accounts` operation returning credentials | Core, issuer |

The amount format already agrees: an integer string of minor units with the coin's decimals.

## What was not changed

Asset signing, Gold, Trading Station, Post Office, Collectibles, Documents, issuer compatibility,
backup and restore, and the manifest permissions. Backups do not carry ledger references; the
recovery paths are rediscovery and the copied credential. The one edit to existing logic is the
extra refusal in `signWithSelf`.

## Remaining questions

1. Is `audience` the exact operation URL (proposed) or the origin?
2. Which key signs balance receipts: the issuer's own, or a ledger key the signed discovery lists?
3. What is the receipt's state reference: a sequence number, a hash, or both?
4. How long may a discovery document live, and how stale a cached one may the wallet use?
5. When the issuer re-issues a credential for rediscovery, does `issuedAt` change, and how does that
   interact with key validity windows?
6. What does the passkey verifier check beyond the signature (relying-party ID, user presence), and
   where does it live?
7. Where does credential issuance run, and how does the issuer learn that an account exists?
8. Should refresh re-check credential revocation every time, or on a schedule?
9. Should backups carry ledger references, or stay as they are?
10. What does "vault identity" mean in Core, and can it sign without a prompt?

## Tests

- `node test/manual-ledger-core.js`: credential shape, balance handling, indicator levels.
- `node test/manual-ledger-wallet.js`: storage, consent, scoping, background rules, removal,
  rediscovery, signing refusal, against local doubles in the extension's service worker.
- `xvfb-run -a node test/manual-ledger-tab.js`: the tab through the real extension page.

The ledger in these tests is a **simulation with an invented request shape**. Passing them shows
the wallet's own rules work. They say nothing about any real ledger.

A separate check, run outside the repository and not part of the suite, signed requests the way the
wallet's local identity does and sent them to `ledger29.php` running under PHP. The signature,
key format and canonical JSON agreed. The same run showed the replay, request-order and key-spelling
issues listed in the table above.
