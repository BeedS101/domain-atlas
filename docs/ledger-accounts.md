# Ledger accounts in the Gen 1 wallet

Status: the wallet side of the Ledger tab is built and tested against local test doubles. An
**experimental adapter for the Labs 29 prototype is built but switched off by default**, and no
live testing has been approved. Nothing in this repository has read a real balance.
The issuer in this repository can sign account references through an **experimental endpoint that
is off unless the operator enables it** (see "Issuing account references"); nothing has issued one
on a live site.
The Ledger tab can walk a person through opening an empty account and collecting that reference
(see "Opening an account from the wallet"). It is part of the same experimental interface, so it is
unavailable until the person turns that interface on, and it has not been run against a live site.

Signed balance receipts (Labs 38) are built as a second experimental interface with its own switch:
the PHP issuer can sign a statement of what the Labs 29 ledger held, the wallet checks it against the
issuer's published key and, only then, labels the figure **Signed ledger report — Not final or
spendable** (see "Signed balance receipts"). Both the receipt endpoint and the wallet interface are
off by default, nothing has been deployed or enabled on a live site, and no live receipt has been
requested.

This document keeps three things apart, and says which one each statement is about:

- **Built**: what the wallet does today.
- **Experimental**: the Chainblock Labs 29 prototype (`ledger29.php`, in the Core repository; this
  document was checked against Core commit `606390a`). It is a read-only prototype with no funded
  accounts, no signed discovery, no signed balance receipts and no recovery service. It is not the
  finished contract. The wallet reaches it only through the experimental
  adapter described below, and only if that is turned on.
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

### Canonical forms

Three values feed account identity, so each has exactly one accepted spelling. A ledger or wallet
that receives any other spelling **rejects it; it does not normalize it**.

| Value | Canonical form |
| --- | --- |
| Network ID | The string the ledger's signed discovery document publishes, compared byte for byte. |
| Coin ID | The ledger registry's symbol exactly as registered. For the Labs registry that is upper-case letters and digits, 2 to 10 characters, starting with a letter. |
| Owner public key | Unpadded base64url of the 65-byte uncompressed P-256 point (87 characters). Whatever format an identity uses to sign, its owner key in a credential and in a request is this form. **Built:** the credential check refuses any other spelling, and the wallet files and compares accounts under this form. |

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

**Built:** on the Labs 29 networks (`chainblock-labs29-*`) the wallet requires exactly this derived
ID and refuses any other before it contacts the issuer. Other networks are held to the general ID
rule only, until the derivation is frozen. Core's Labs 30 and Labs 31 files use this derivation (the
earlier text in `LABS30.md` and `LABS31.md` describes a different one and is out of date), and the
issuance endpoint below derives it independently and requires the ledger to name the same ID.

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
- The ledger's **exact operation addresses** are pinned at the first lookup. If the issuer later
  names a different address, even on the same host and differing only in path or query, the wallet
  stops, sends nothing there, and asks again ("Allow new address…"). Moving back to an old address
  is a change too.
- While discovering, requests are limited to the issuing domain. While looking up a balance they are
  limited to the one pinned address, and a message may be signed only if it names exactly that
  address. No redirects, no cookies. Only `https` is accepted, plus `http` on loopback for testing.
- Opening the tab looks up only accounts that have permission, and not again within 30 seconds.
- **Background checks** are a separate, per-account switch, **off by default and opt-in**. They run
  only while a wallet page is open (a 60-second tick, one tab at a time through a Web Lock), at
  most every 10 minutes per account and never faster than 5. There is no service-worker polling.
  They are refused for identities that cannot sign without a prompt.

**Still to come:** the addresses the wallet pins will come from the signed discovery document below.
Today an adapter supplies them from whatever discovery its service offers; for Labs 29 that is
unsigned.

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
  unavailable for it. It **never attempts a proof its ledger cannot check**: each adapter lists the
  proof formats it accepts (`raw-ecdsa-p256` for a password identity; a passkey is
  `webauthn-es256`), and when the identity's format is not listed the wallet makes no request,
  shows lookups as unavailable with the reason, refuses to turn background checks on, and never
  starts the passkey prompt. There is a second guard at the signing step itself. Labs 29 accepts
  only the first format, so a passkey identity cannot be used with it.
- **Built:** the key-format problem is fixed. A passkey identity's stored key is a 91-byte encoded
  key, 122 characters, which the old credential rule (at most 120) would have refused. The
  credential now carries the 65-byte point, and the wallet takes the same point out of the passkey's
  key to compare and to file accounts, so a passkey-owned credential can be added.
- **Intended:** manual lookups with a passkey become possible once a ledger has a compatible
  assertion verifier. Delegated sessions, so a passkey could authorize a short run of background
  checks, can be designed later; the issuer's existing mail session is the precedent.

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
document lists. Until receipts exist, the wallet labels every balance **Reported — Not Cryptographically
Verified** (**built**). The wallet sets that label, not the adapter or the ledger, and there is no
other level for an adapter to claim. The Ledger tab shows it beside every figure, with a sentence
saying nothing signed backs it and that it is not a final or spendable balance, and calls the figure
a "reported balance", never funds. A balance from an experimental interface also names that interface.

## Adapter interface

**Built:** an adapter is how the wallet talks to one kind of ledger:

```
contract                                a string naming the interface it implements
label, experimental                     optional: how the tab names it, and whether it is a prototype
proofFormats                            the identity proofs its ledger can check (default raw-ecdsa-p256)
supports({issuerDomain, network, coin}) true if it can serve that target
discover(target, ctx)                   -> { operations: { balance, accounts? } }   exact https addresses
fetchBalance(target, found, ctx)        -> { amount, decimals, asOf }
listAccounts(target, found, ctx)        -> [ credential, ... ]   optional
```

`target` is `{issuerDomain, network, coin, ownerPublicKey}`. While discovering, `ctx.fetch` reaches
only the issuing domain. While looking up a balance it reaches only the pinned operation address,
`ctx.sign(payload)` signs only `atlas.ledger.*` payloads whose `audience` is exactly that address
and only for a proof format the adapter lists, and `ctx.signal` aborts on removal or when permission
is withdrawn. Until an adapter registers, the tab shows lookups as unavailable and says why. The
wallet registers none by itself except the experimental one, when it has been turned on.

### Adapter design for the intended contract (built for Labs 29 only where noted)

The adapter is the only place that knows a ledger's wire format. The wallet decides who may be
contacted and what a figure may be; the adapter cannot widen either.

1. **Discover.** *(Intended; the Labs 29 adapter reads that prototype's own unsigned discovery
   instead, as described below.)* Fetch `/.well-known/atlas-ledger.json` from the issuer origin and
   `/.well-known/atlas-key.json`. Verify the signature, the issuer, the network, the contract, the
   proof formats and the expiry as above. Return `{ operations, proofFormats, expiresAt }`. The
   wallet pins the operation URLs, and a different set later asks the person again.
2. **Supports.** *(Built.)* The wallet compares the identity's proof format with the adapter's
   `proofFormats`. When it is not listed, lookups show as unavailable and no prompt starts.
3. **Fetch a balance.** Build the request payload, sign it through `ctx.sign` with `audience` set
   to the balance operation URL, and post to exactly that URL. Nothing else is contacted.
4. **Check every response.** *(Built for Labs 29, except the receipt items.)* An answer is used only
   if all of these hold, and any failure is a `bad-response` that stores nothing:
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
Codes and what the wallet shows (**built**, in the Labs 29 adapter; the Labs 29 prototype returns
only some of them, see below):

| Code | Meaning | Wallet problem |
| --- | --- | --- |
| `malformed-request` | Request is not in the agreed shape. | bad response |
| `unsupported-proof` | The proof format is not one the ledger verifies. | this kind of identity is not supported (new) |
| `bad-signature` | The signature or key does not verify. | unauthorized |
| `stale-request` | `issuedAt` is outside the window. Body also carries `serverTime`. | device clock is off (new) |
| `replayed-request` | The nonce was already used. | busy; try again |
| `wrong-audience` | `audience` is not this operation. | bad response |
| `unknown-network` | Not this ledger's network. | not supported |
| `unknown-coin` | The coin is not registered. | unknown coin (new) |
| `no-account` | The coin exists but this identity has no account. | not found |
| `rate-limited` | Too many requests. | try later (new) |
| `unavailable` | The ledger cannot answer now. | network |

A body without a `code`, or with one the wallet does not know, is treated as a bad answer. The
words of the message are never parsed. Two exceptions need no code: a 429 means slow down and a
5xx means a network problem.

### Wallet changes

Built: pin and fetch by exact operation address with a new `discover` result shape; owner keys in
canonical form, including the passkey case; proof formats checked before any prompt; structured
error codes with the new problem messages; the Reported — Not Cryptographically Verified label;
the experimental interface switch.

The derived account ID is checked for the Labs 29 networks (see "Account ID").

Still to do: a helper that verifies the signed discovery document (waits for the contract to be
frozen); re-checking revocation on each refresh; receipt verification.

## The experimental Labs 29 adapter

`extension/ledger-labs29.js`, contract name `chainblock-ledger29/experimental`. It is built in but
**off by default**: nothing is registered, and nothing can contact the prototype, until the person
turns on "Allow the Chainblock Labs 29 test interface" under "Experimental interfaces (testing
only)" on the Ledger tab, and confirms. The choice is stored and followed by every wallet page and
the background worker. Turning it off unregisters the adapter, cancels requests it has in flight
and turns off background checks for accounts left with no interface. Each account still needs its
own permission, its address is still pinned, and background checks are still a separate switch that
starts off.

What it does:

- Serves only `evtec.co.za` and `domain-atlas.co.za`, each with its own network
  (`chainblock-labs29-<host>`), and only coin IDs the prototype could list.
- Reads discovery from `https://<host>/chain-labs/ledger29.php?action=discovery`. It accepts the
  answer only if the contract, issuer and network match, and the balance address the answer names
  is exactly `https://<host>/chain-labs/ledger29.php?action=balance`. Any other address, on any
  host, is refused before anything is signed. Discovery is not signed, so the adapter treats it as
  unverified and the exact-address rule is what limits it.
- Sends `{type, v, audience, network, coin, nonce, issuedAt}` with the exact balance address as
  `audience`, signed by a password identity, and a proof of only `{publicKey, signature}`. It first
  checks that the signing key is the account's owner.
- Accepts an answer only if its network, coin and owner key equal the credential's, the amount is
  1 to 40 digits, decimals are 0 to 18, and the time is not more than ten minutes ahead. It ignores
  the prototype's own `verifiedRequest` and `balanceProof` fields: they are not proof.
- Offers no account listing, because the prototype has no recovery service.

What it will not do: sign for a passkey identity, follow any address other than the one above,
treat a Labs 26 allocation or a credential as a balance, or show a balance as anything but reported
and unverified.

### What Core's prototype does today (checked against `606390a`)

- **Fixed since the review:** payload keys in any order; `audience` must be the exact balance
  address; non-canonical key spellings are refused; discovery names the balance address under
  `operations`.
- **Structured codes it returns:** `malformed-request`, `bad-signature`, `unsupported-proof`,
  `unknown-coin`, `no-account`.
- **Failures with no code:** a request with a wrong audience, network, type, nonce, or a time more
  than two minutes off all answer 401 "Invalid balance challenge"; a wrong operation answers 404 "Unknown operation".
  The adapter shows these as a bad answer. They cannot be told apart, so a device clock that is
  off by a few minutes looks the same as a wrong address. `stale-request` with a `serverTime`,
  and `wrong-audience`, would fix that.
- **Unchanged:** no nonce store (a repeated request is accepted within two minutes), `asOf` is the
  time the server answered, no signed discovery or receipt, no account issuance, no listing.
- `LABS29.md` still describes the earlier request shape and has not been updated for these changes.

## Issuing account references (experimental)

The wallet needs an issuer-signed `domain-atlas-ledger-account/1.0` credential before it will hold
an account. The issuer in this repository (`issuer-php/` and `issuer-server/`) can now sign one,
through an endpoint that is **off unless the operator turns it on**:

`POST /atlas/ledger/account-credential`
(`issuer-php/atlas/ledger/account-credential.php`, `issuer-php/lib/ledger-issuance.php`;
`issuer-server/lib-ledger-issuance.js`, which answers identically)

It signs one thing: *this owner key has an account in this coin on this domain's Labs 29 ledger*.
It signs it only after two independent checks, and it signs with the established issuer key only.

### Request

```json
{
  "payload": {
    "type": "atlas.ledger.account.issue", "v": 1,
    "audience": "https://<domain>/atlas/ledger/account-credential",
    "network": "chainblock-labs29-<domain>", "coin": "GOPH",
    "nonce": "<32-64 lowercase hex>", "issuedAt": "<UTC ISO, within 120 s>",
    "existenceNonce": "<the nonce of the listing request below>"
  },
  "proof": { "signerRole": "raw-ecdsa", "publicKey": "<canonical owner point>", "signature": "<raw 64-byte>" },
  "existence": {
    "payload": { "type": "atlas.ledger.accounts", "v": 1,
                 "audience": "https://<domain>/chain-labs/accounts31.php?action=accounts",
                 "network": "chainblock-labs29-<domain>", "nonce": "<32-64 lowercase hex>", "issuedAt": "<UTC ISO>" },
    "proof": { "publicKey": "<the same owner point>", "signature": "<raw 64-byte>" }
  }
}
```

Both parts are signed by the owner with the same raw P-256 key, over canonical JSON. Passkey
identities are answered `unsupported-proof`: the ledger's own check cannot take an assertion, so
there would be nothing to confirm existence with.

### What the issuer checks, in order

1. The endpoint is enabled; the request is a POST over HTTPS to the configured domain (never taken
   from the Host header alone); the per-client rate limit; the body is at most 8 KiB.
2. Exact field sets and types; `audience` is the exact issuance address; `network` is this domain's;
   `issuedAt` is within 120 seconds (`stale-request` carries `serverTime`).
3. The owner key is the one canonical spelling and the signature verifies (`bad-signature`,
   `unsupported-proof`).
4. The listing request is for this network and the exact ledger address, is signed by the *same*
   key, is the one the signed intent names (`existenceNonce`), is fresh, and verifies.
5. The established issuer key exists on disk and the published `atlas-key.json` lists it as valid
   now. The endpoint never generates a key (`issuer-key-unavailable`).
6. The derived account ID is not on the revocation list (`account-revoked`).
7. The request nonce is spent and the per-owner and global hourly limits are applied in one locked
   step (`replayed-request`, `rate-limited`).
8. The issuer itself sends the owner's listing request, unchanged, to
   `https://<domain>/chain-labs/accounts31.php?action=accounts` (no redirects, 8 s, 64 KiB, TLS
   verified). It issues only if the ledger answers `accounts-found` for this network and owner,
   lists the coin exactly once, and names the account ID the issuer derived itself
   (`account-not-found`, `ledger-mismatch`, `ledger-unavailable`, `existence-proof-rejected`).

Nothing in the request is accepted as proof that the account exists. A claimed account list is
refused as an unknown field. A request that failed at the ledger stays spent; the owner signs a
new one.

### The credential

Exactly the seven fields above, `issuedAt` = the issuer's clock, signed over
`{id, ledger, owner, issuedAt}` with the established issuer key through the existing signing
function. No balance, supply or quantity. Core's offline verifier (`verify34.php`) accepts it.

### Operating it

Disabled with no file. To enable, create `lib/atlas-ledger-issuance-config.json` (PHP) or
`<state folder>/atlas-ledger-issuance-config.json` (Node):

```json
{ "enabled": true, "domain": "evtec.co.za" }
```

`domain` must be one of the two Labs 29 hosts. Optional: `perClientPerMinute` (20),
`perOwnerPerHour` (10), `globalPerHour` (300). `coreBase` exists for tests and accepts only a
loopback `http://` address. Removing the file turns it off. The Node issuer also needs
`ATLAS_LEDGER_TRUST_FORWARDED_PROTO=1` when it sits behind a TLS-terminating proxy.

The issuer keeps `lib/atlas-ledger-issuance-store.json`: spent-nonce hashes, owner hashes for the
hourly limit, and a log of the last 500 issuances (time, account ID, coin). It holds no key and no
signature.

### What it does not do

The wallet asks for these references only through the opening workflow below, never in the
background. The issuer cannot revoke
one account reference without revoking that account ID for good, because the ID is deterministic.
There is no signed existence receipt from the ledger: the issuer trusts the ledger's answer over
TLS to its own domain, the same trust a balance has today.

### Deploying it (only once reviewed and approved)

Nothing below has been done on a live site.

1. **Before anything:** Core's Labs 30, 31 and 33 files work on the domain, and the domain's PHP issuer
   is already installed with its key published: `https://<domain>/.well-known/atlas-key.json` lists
   the key with a `validFrom` in the past and no `validUntil`.
2. **Upload two new files only**, next to the existing ones, and nothing else:
   `issuer-php/lib/ledger-issuance.php` to `lib/`, and
   `issuer-php/atlas/ledger/account-credential.php` to a new `atlas/ledger/` folder. Do not touch
   `issuer-private-key.pem`, `atlas-key.json` or any store. The endpoint is still off.
3. **Confirm it is off:** `POST https://<domain>/atlas/ledger/account-credential` answers 404
   `{"code":"disabled"}`, and the existing endpoints (`/atlas/revoke`, an asset check) behave as before.
4. **Confirm the host can ask itself:** the issuer fetches `https://<domain>/chain-labs/accounts31.php`
   from the server. From the host's terminal or a one-off cron job, a request to that address
   (`curl -s -X POST -d '{}' 'https://<domain>/chain-labs/accounts31.php?action=accounts'`) should
   come back as JSON `malformed-request`. If the host cannot reach itself, stop: see "Open".
5. **Enable it** by creating `lib/atlas-ledger-issuance-config.json` with
   `{"enabled": true, "domain": "<domain>"}` (leave the limits at their defaults).
6. **Smoke test from your own computer:** `node tools/ledger-issuance-smoke.js <domain> <COIN>` expects
   `account-not-found` and creates nothing. `... --open` additionally opens one empty account for a
   throwaway key (permanent, no funds) and checks the credential it gets back.
7. **Roll back** by deleting the config file (the endpoint is off at once) or the two uploaded files.
   Credentials already issued stay valid unless their account ID is revoked.

Open: whether the live hosts allow a server to request its own HTTPS address; the per-client rate
limit sees one shared address behind some proxies; and a signed existence receipt from the ledger.

## Opening an account from the wallet (experimental)

The Ledger tab has an **Open a ledger account (experimental)** panel. It is the wallet half of the
issuance endpoint above, and it never runs on its own. Code: `extension/ledger-open.js` (what may
be asked of whom, the exact signed messages, how answers are read; no network, storage or
signing), and the "opening an account" section of `extension/wallet.js`.

### What the person sees and decides

1. **Identity.** The panel lists the identities on the device (password and passkey) and marks the
   one in use. Choosing the other one switches to it, exactly as the existing identity switch does.
   A passkey identity is shown as unusable here, and nothing is asked of it: the test ledger and
   issuer can check only a raw P-256 proof, so the wallet refuses before any prompt or request
   (`proof-unsupported`).
2. **Coin.** One target is listed today: GOPH on `evtec.co.za`. A coin or host that is not in the
   table in `ledger-open.js` is refused before anything is signed.
3. **Availability.** The panel is unavailable, with the reason in words, until the experimental
   Labs 29 interface is turned on (it is off by default), and while the wallet is locked.
4. **Step 1, open.** The person is told the destination domain and exact address, that the service
   is experimental, what is sent (one signed request naming network, coin and public key), and what
   is not (no minting, deposit or spend, no balance lookup, no credential yet). Only after
   approving does the wallet send it.
5. **Step 2, reference.** A separate question names the issuer address and the Labs 31 address the
   issuer will relay to, says the issuing service may be switched off, and says the signature will
   be checked. Only after approving does the wallet send it.
6. **Balance.** Neither step looks up a balance. The collected reference is stored like any other
   added reference: no permission to contact anything, no balance, background checks off. The
   existing **Allow lookups** question, per account, is the only way a balance is fetched, and the
   existing label *Reported — Not Cryptographically Verified* is the only way one is shown.

### What is signed and sent

All signing happens inside the wallet, by the identity in use, through the same internal function
the Labs 29 adapter uses. That function checks the message's `audience` against an exact list, its
`type` against the three types of this workflow (`atlas.ledger.account.open`,
`atlas.ledger.accounts`, `atlas.ledger.account.issue`) and the kind of proof against what the
service can check. It is not exported, and the generic signer that the website bridge reaches
still refuses any payload containing `atlas.ledger.`.

| Step | Request | Body |
| --- | --- | --- |
| 1 | `POST https://<domain>/chain-labs/account30.php?action=open` (Labs 30) | `{payload: {type, v, audience, network, coin, nonce, issuedAt}, proof: {publicKey, signature}}` |
| 2 | `POST https://<domain>/atlas/ledger/account-credential` (the issuer) | `{payload: {…, existenceNonce}, proof: {signerRole: "raw-ecdsa", publicKey, signature}, existence: {payload: <Labs 31 listing request>, proof: {publicKey, signature}}}` |

Each request goes through a fetch limited to its one exact address: no redirects, no cookies, no
referrer, a 20 second limit. Nonces are 16 random bytes in hex, times are written in whole seconds,
and every attempt makes new ones. The wallet does not call Labs 31 itself; the listing request it
signs travels inside the issuance request and the issuer relays it. Switching the experimental
interface off cancels a request in flight.

### What is kept, and partial failure

Step 1 is idempotent at the ledger: Core answers `account-opened` (201) or `account-exists` (200)
and never changes an existing balance. The wallet checks that the answer is for this network, coin
and owner and that the account ID is the derived one, ignores whatever quantity the answer carries,
and writes a **note** that the account is open (`atlasLedgerOpenings`, per owner, encrypted at rest
for password identities, never a balance).

Step 2 verifies the credential before collecting it: its shape (no balance fields), that it is for
the account asked for (id, domain, network, coin, owner), then the established issuer key and the
revocation document of the issuing domain, through the same check as **Check and add**. Only then
is it stored and the note removed. If anything fails the note stays with the reason, nothing is
stored, and **Try again** repeats only step 2, with fresh nonces. It does not open the account
again, so nothing at the ledger is recreated or reset. The cases that matter:

- the issuer is off (`issuance-off`, 404 `disabled`): the account stays open;
- the issuer or ledger is unavailable or refuses: the account stays open;
- the issuer's answer fails verification, is for another key, or carries a balance
  (`credential-invalid`): not stored;
- the issuer has revoked the account ID (`account-revoked`): not stored, and it will not be signed again;
- **Forget this note** removes only the note on this device. Opening again later finds the account
  (`account-exists`) and notes it afresh.

If the wallet already holds a reference to the account, opening is refused locally
(`already-held`) before any request.

### What it does not do

No minting, deposit, payment or spending. It does not enable the issuer service, create a
configuration file or contact any host other than the one in the table. It does not run in the
background. It does not change what Core or Mobile do. Notes and references are not in backups.

## Signed balance receipts (experimental, Labs 38)

The frozen contract is `LABS38.md` in the Core repository (agreed 2026-10-18). A receipt makes a
*reported* balance cryptographically authenticated: its signature says who stated it and when. It is
not proof of consensus, completeness, solvency, finality or spendability, and the wallet says so.

### Where the signing happens

In the original PHP issuer, with its established issuer key: `POST /atlas/ledger/balance-receipt`
(`issuer-php/atlas/ledger/balance-receipt.php`, logic in `issuer-php/lib/ledger-receipts.php`). The
key is not copied anywhere and the endpoint signs one fixed statement it builds itself; it never signs
a submitted amount or arbitrary JSON. The type literal `atlas.ledger.balance-receipt` exists in no other
signer, and a test checks that.

The issuer reads the ledger itself, read-only: `dirname(DOCUMENT_ROOT)/chainblock-labs-private/`
(the folder the Labs 29 service uses, required to be outside the document root), `coin26.sqlite` for
`coins(domain, symbol)` → `id, decimals`, then `ledger29.sqlite` for `accounts(coin_id, owner_key)` →
`amount_units`. Both are opened `mode=ro` with `PRAGMA query_only=ON`, are never created, and a missing
or unreadable database answers `ledger-unavailable` and signs nothing. There is no unsigned relay to
fall back to. Each database is read inside its own read transaction; the two are separate SQLite files,
so this is not one atomic snapshot of both. A coin's `decimals` are remembered on first use and a later
change refuses to sign (`ledger-mismatch`); losing `lib/atlas-ledger-receipts-store.json` re-pins.

### Off by default, and independent of issuance

`lib/atlas-ledger-receipts-config.json` (`{"enabled": true, "domain": "evtec.co.za"}`, optional
`perClientPerMinute` 30, `perOwnerPerHour` 60, `globalPerHour` 600) is never created automatically. With
no file the route answers 404 `disabled` to GET and POST and touches nothing. It has its own store
(`lib/atlas-ledger-receipts-store.json`: spent nonce hashes kept 600 s, hourly counters, the pinned
decimals, a log of the last 500 receipts with time, account ID and coin — never an amount) and its own
rate-limit bucket. It does not read the credential-issuance flag, so switching issuance off does not
stop receipts, and enabling one never enables the other.

`GET /atlas/ledger/balance-receipt` (when enabled) returns a status document: contract, the operation
address, network, request and receipt types, `state: "no-state-version"`, `signedDiscovery: false` and
`ledgerStorage: "readable" | "unavailable"` (whether the two databases can be opened, so an operator
can check a host before relying on it; no path is named). It is unsigned and appoints no key.

### The request

`{payload, proof}` with exactly these payload fields, signed by the owner (raw P-256 over the
sorted-key canonical JSON):

`{type: "atlas.ledger.balance-receipt.request", v: 1, audience: "https://<domain>/atlas/ledger/balance-receipt", network: "chainblock-labs29-<domain>", coin, nonce (32–64 lowercase hex), issuedAt (±120 s)}`

and `proof` exactly `{publicKey, signature}` (canonical 87-character point, 64-byte signature). The
type and audience differ from Labs 29's, so neither endpoint accepts the other's signature. Any extra
field (a balance, a credential, a signer, an endpoint) is refused. Maximum body 4096 bytes. The nonce
is spent persistently before the ledger is read (simultaneous copies yield one receipt). Order of
checks: configuration, HTTPS, host, client rate limit, shape, audience, network, coin, nonce, time,
proof, issuer key valid now, revoked account, replay and per-owner/global limits, ledger read.

### The receipt

`{ok: true, contract: "chainblock-ledger38/signed-receipt-experimental", payload, signerKey, signature}`
with `payload` exactly

`{type: "atlas.ledger.balance-receipt", v: 1, request: {nonce, hash}, network, coin, account, owner, amount, decimals, observedAt, state: {status: "no-state-version"}}`

`hash` is the lowercase hex SHA-256 of the canonical request *payload* (not the envelope), `account` the
derived `urn:atlas:ledger-account:…`, `amount` an integer string of minor units, `observedAt` the
issuer's own clock in whole seconds. The signature covers only the canonical payload. The ledger has no
state version, so there is no `sequence` and no `asOf`: `observedAt` is when the issuer looked, not a
committed ledger state. A real version column and a `v: 2` receipt are separate future work.

### What the wallet checks

`extension/ledger-labs38.js` (contract `chainblock-ledger38/signed-receipt-experimental`). The adapter
reaches only the address derived from the issuing host, reads the status document (which can only say
the service is on), sends the owner-signed request and hands the answer back as *evidence*. The
**wallet** then fetches the issuing domain's `/.well-known/atlas-key.json` and
`/.well-known/atlas-revocations.json` itself (the origin the person allowed; no redirects, no
credentials) and runs `checkReceipt`. Everything must pass:

- exact envelope, payload, `request` and `state` key sets; the contract, type, version and
  `no-state-version`;
- the request nonce and the SHA-256 of the canonical request just sent; the request type and exact
  audience;
- owner, network, coin and account equal the wallet's credential, and the account equals the
  independently derived ID; an integer-string amount (no signs, fractions, exponents or leading zeros)
  and 0–18 decimals;
- `observedAt` in whole seconds, within ±120 s of the request, not in this device's future and not
  more than five minutes old;
- the signer: the response's `signerKey` is only a selector. The key must be listed in the issuing
  domain's published key document, valid at `observedAt` **and** not ended now; it must not be in the
  revocation list, nor may the account; the signature is checked with the published key. A key
  document that cannot be read fails closed, as does a revocation list that cannot be read (only a
  404, "none published", counts as empty).

Only then does the wallet record the figure with `verification: "signed"`, the signing domain, the key
and the statement time, and show **Signed ledger report — Not final or spendable** with the signing
domain and statement time. Any failure records no balance, shows the reason (`receipts-off`,
`receipt-unavailable`, `receipt-invalid`, `signer-unknown`, `account-revoked` …) and **does not fall
back** to an unsigned lookup. A Labs 29 answer is never relabelled: it stays **Reported — Not
Cryptographically Verified**, and nothing in a response (`verifiedRequest`, `balanceProof`, `ok`, a
matching TLS host) raises the level. The wallet, not the adapter, sets it.

### Consent and switches

"Allow the Chainblock Labs 38 signed-report interface" is its own switch, off by default, separate
from Labs 29. Each account keeps its own permission and pins the exact operation address it first used.
An account pinned to the Labs 29 address stays with Labs 29 even if both interfaces are on; with only
Labs 38 on, the receipt address is a *new* address, so the wallet sends nothing there until the person
approves it (`endpoint-changed`). An account pinned to the receipt address never falls to Labs 29 when
receipts fail. To move an account to signed reports without that prompt, stop and re-allow lookups.
Background checks stay a separate, off-by-default switch and use whichever interface the account is
pinned to. Passkey identities make no request (the interface accepts raw P-256 proofs only).

### Tools

`labs/chainblock-web/verify38.php` in the Core repository is an independent, CLI-only verifier
(`php verify38.php <atlas-key.json> <request.json> < receipt.json`). It does not check live
revocation, database contents, current freshness, finality or spendability. Do not upload it to a site.
The wallet is stricter than the offline verifier in two ways: it requires the key to be unrevoked and
still current, and it applies the freshness rules above.

### Before any live use

Not done and not approved: deploying the endpoint, creating the configuration file on a host, or
requesting a receipt from a live site. On each host, first confirm the issuer's PHP can open the two
databases (`GET /atlas/ledger/balance-receipt` once enabled reports `ledgerStorage`; `open_basedir`
or permissions may forbid it, in which case stop and rethink rather than relay unsigned data), then
test disabled-by-default, replay, an unauthorized signer, tampering and a wrong account. Roll back by
deleting `lib/atlas-ledger-receipts-config.json`.

## Current experimental implementation versus the intended contract

What the wallet cannot do with Labs 29 today, and where each gap belongs. "Core" is the Chainblock
Labs repository; "issuer" is the domain's PHP/Node issuer in this repository.

| Area | Labs 29 today (`606390a`) | Intended | Owner |
| --- | --- | --- | --- |
| Discovery | Unsigned `GET …/ledger29.php?action=discovery`, now naming `operations.balance` | Signed `/.well-known/atlas-ledger.json` with per-operation URLs | Issuer (signing, well-known), Core (content) |
| Endpoint pin | Wallet pins the exact operation address (built) | Same | none |
| Request shape | `{type, v, audience, network, coin, nonce, issuedAt}` plus proof, any key order; `audience` is the exact balance address | Same | none |
| Signature | Raw P-256 over canonical JSON; matches the wallet's local identities (checked by running both) | Same | none |
| Owner key | Canonical 65-byte point only; other spellings refused | Same | none |
| Passkeys | Rejected as `unsupported-proof`; the wallet never sends one | Verifier to come | Core, then wallet |
| Replay | A repeated nonce is accepted within two minutes | Nonce store; repeated nonce refused | Core |
| Errors | Codes on five failures; the clock, audience, network and shape failures carry none | A code on every failure, `stale-request` with `serverTime` | Core |
| Balance response | `{amount, decimals, asOf}` over TLS only, `asOf` is server time | Signed receipt with request binding and state reference | Core, issuer |
| Account credential | Issuer-signed, derived ID, through the experimental endpoint above (off by default; requested by the wallet only through the opening workflow, after two approvals) | Same, plus signed discovery and receipts | Issuer, with Core deciding when an account exists |
| Account creation | No account is created or funded; Labs 26 allocations are not credited | Ledger-authoritative; creation separate from allocation | Core |
| Rediscovery | No listing operation | Signed `accounts` operation returning credentials | Core, issuer |

The amount format already agrees: an integer string of minor units with the coin's decimals.

## What was not changed

Asset signing, Gold, Trading Station, Post Office, Collectibles, Documents, issuer compatibility,
backup and restore, and the manifest permissions. Backups do not carry ledger references; the
recovery paths are rediscovery and the copied credential. Opening an account added an optional
`types` list to the internal ledger signer (the existing adapters do not pass one), a panel in the
Ledger tab, and the new module. Edits to existing logic are the extra
refusal in `signWithSelf`, the derived-ID check in `verifyLedgerCredential` (Labs 29 networks only),
and, in `issuer-server/server.js`, one `require`, two file-path constants and one route that does
nothing unless the issuance config file enables it. The PHP issuer gained new files only. No
existing endpoint, key, credential or store is read or written differently.

## Remaining questions

1. ~~Is `audience` the exact operation URL or the origin?~~ Settled for Labs 29: the exact operation address. Open only for the finished contract.
2. ~~Which key signs balance receipts?~~ For the Labs 38 pilot: the issuer's own established key, in the original issuer. A delegated ledger key would need an authorization chain pinned to the issuer.
3. What is the receipt's state reference: a sequence number, a hash, or both? Labs 38 v1 has none (`no-state-version`); a version column with atomic increment and a `v: 2` receipt are open.
4. How long may a discovery document live, and how stale a cached one may the wallet use?
5. When the issuer re-issues a credential for rediscovery, does `issuedAt` change, and how does that
   interact with key validity windows?
6. What does the passkey verifier check beyond the signature (relying-party ID, user presence), and
   where does it live?
7. ~~Where does credential issuance run, and how does the issuer learn that an account exists?~~ For Labs 29: on the domain's own issuer, which asks the ledger with the owner's own signed listing request. Open: a signed existence receipt, and whether the issuer may read the ledger directly if the host blocks requests to itself.
8. Should refresh re-check credential revocation every time, or on a schedule?
9. Should backups carry ledger references, or stay as they are?
10. What does "vault identity" mean in Core, and can it sign without a prompt?

## Tests

- `node test/manual-ledger-core.js`: credential shape, balance handling, indicator levels.
- `node test/manual-ledger-wallet.js`: storage, consent, scoping, background rules, removal,
  rediscovery, signing refusal, against local doubles in the extension's service worker.
- `xvfb-run -a node test/manual-ledger-tab.js`: the tab through the real extension page, including
  the verification label and the experimental switch.
- `node test/manual-ledger-labs29-adapter.js`: the adapter alone, with canned answers: discovery
  rules, the request it sends, every refused answer, and the error-code table.
- `xvfb-run -a node test/manual-ledger-labs29-wallet.js`: the adapter inside the extension against
  a stand-in service (`test/labs29-standin.js`): off by default, the switch, consent, exact-address
  pinning, scoped fetch and signing, mismatched answers, altered endpoints, structured errors, a
  simulated passkey identity, and background checks staying opt-in.
- `LABS29_PHP=/path/to/ledger29.php node test/manual-ledger-labs29-php.js`: the adapter and the
  wallet's signing against a copy of the real prototype file under PHP. It skips itself when the
  file is not given.
- `node test/manual-ledger-issuance.js`: the issuance endpoint against the real Node and PHP
  issuers, each in a temporary copy with its own key: off by default, valid issuance, missing
  accounts, bad ownership proofs (changed, foreign, non-canonical, passkey-style, wrong audience,
  wrong network, stale), replay (sequential and simultaneous), a ledger that lies or fails,
  revocation, key problems, limits, and that no key or published document was touched. The ledger
  is a stand-in; with `CORE_LABS_DIR=/path/to/labs/chainblock-web` it also runs against Core's real
  `account30.php` and `accounts31.php` under PHP and checks each credential with Core's own
  `verify34.php`.
- `xvfb-run -a node test/manual-ledger-issuance-wallet.js`: the extension's `verifyLedgerCredential`
  and `addLedgerAccount` on credentials the real issuers signed, fetched over HTTPS from the
  issuer the way the wallet would from the live site (a throwaway certificate, local only):
  valid, tampered, revoked, key-window, derived-ID mismatch.

- `node test/manual-ledger-labs38-adapter.js`: the Labs 38 adapter and `checkReceipt` on their own,
  with receipts made by a throwaway key: every tampered field, receipts for another request, owner,
  coin, host or account, time limits, the signer rules (unlisted, expired, not yet valid, revoked),
  and the adapter's request and error table.
- `node test/manual-ledger-receipts.js`: the receipt endpoint against the real PHP issuer and the Node
  test mirror, each with its own key: off by default and independent of issuance, valid receipts
  checked by an independent verifier, a strict request (extra fields, Labs 29 type/audience, stale,
  foreign or malformed proofs), identity and account separation, tampered receipts, replay (sequential
  and simultaneous), expired/unlisted/unreadable signing keys, a revoked account, a missing or
  unreadable ledger, changed decimals, limits, and the signing surface. The ledger databases are Core's
  own (made by `account30.php`) when `CORE_LABS_DIR` is set, otherwise a schema stand-in; the output says which.
- `node test/manual-ledger-verify38.js`: Core's `verify38.php` on genuine receipts from both issuers
  and on about fifty deliberately corrupted fixtures per issuer, each compared with an independent verifier; also
  that it answers 404 when served over HTTP. Needs `CORE_LABS_DIR`.
- `xvfb-run -a node test/manual-ledger-labs38-wallet.js`: the wallet in Chromium against the real PHP
  issuer and the Node mirror over a local HTTPS front that can alter answers: off by default, no
  fallback when receipts are off, a signed report only after the wallet's own check, the Ledger tab
  label, tampering, a replayed or someone else's genuine receipt, key-document and revocation attacks,
  issuer error codes, background checks staying opt-in, a passkey making no request, and (with Core's
  real `ledger29.php`) Labs 29 staying unsigned and each address needing its own approval.
- `node test/manual-ledger-open-core.js`: the opening module alone: the target table, the exact
  messages against the services' field lists, the explanations, every answer shape and code, and
  that the module has no network, storage or signing calls.
- `xvfb-run -a node test/manual-ledger-open-wallet.js`: the workflow inside the extension, against
  the real Node and PHP issuers over a local HTTPS front, with the stand-in ledger and, with
  `CORE_LABS_DIR` set, Core's real `account30.php`, `accounts31.php` and `ledger29.php` under PHP:
  gates (off by default, approval, unsupported targets), the bridge refusing to sign these types,
  both steps and exactly what is sent and signed, re-opening leaving a seeded balance alone, the
  issuer off then on (retry without re-opening), tampered, foreign and balance-carrying
  credentials not stored, revocation, forgetting a note, a lying or absent ledger, a passkey
  identity making no request and no authenticator call, and the separate balance permission.
- `xvfb-run -a node test/manual-ledger-open-tab.js`: the panel through the real extension page:
  identity and coin selection, both questions and their text, cancelling, the issuer-off failure
  and retry, the collected card with no balance and background checks off, forgetting, and the
  passkey identity.

Apart from the real-file test above, the ledger in these tests is a **simulation**. Passing them
shows the wallet's own rules work. They say nothing about the live sites or any funded account.
The real-file test signs with Node's WebCrypto using a copy of the wallet's canonical-JSON rule,
not with the loaded extension, so it checks the format agreement and not the extension's code. The
issuance tests sign the owner's requests the same way. The opening tests are the ones where the
loaded extension signs, and the services verify what it sent.

The stand-in service and the simulated passkey identity (a stored key with no authenticator, where
any attempt to use it is counted) are test doubles. Nothing here has contacted the live sites.
