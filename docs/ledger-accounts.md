# Ledger accounts in the Gen 1 wallet

Status: the wallet side of the Ledger tab is built and tested against local test doubles. An
**experimental adapter for the Labs 29 prototype is built but switched off by default**, and no
live testing has been approved. Nothing in this repository has read a real balance.

This document keeps three things apart, and says which one each statement is about:

- **Built**: what the wallet does today.
- **Experimental**: the Chainblock Labs 29 prototype (`ledger29.php`, in the Core repository; this
  document was checked against Core commit `606390a`). It is a read-only prototype with no funded
  accounts, no signed discovery, no signed balance receipts, no account issuance and no recovery
  service. It is not the finished contract. The wallet reaches it only through the experimental
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
document lists. Until receipts exist, the wallet labels every balance **Reported \u2014 Not Cryptographically
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
error codes with the new problem messages; the Reported \u2014 Not Cryptographically Verified label;
the experimental interface switch.

Still to do: a helper that verifies the signed discovery document and another that checks the
derived account ID (both wait for the contract to be frozen); re-checking revocation on each
refresh; receipt verification.

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

1. ~~Is `audience` the exact operation URL or the origin?~~ Settled for Labs 29: the exact operation address. Open only for the finished contract.
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

Apart from the real-file test above, the ledger in these tests is a **simulation**. Passing them
shows the wallet's own rules work. They say nothing about the live sites or any funded account.
The real-file test signs with Node's WebCrypto using a copy of the wallet's canonical-JSON rule,
not with the loaded extension, so it checks the format agreement and not the extension's code.

The stand-in service and the simulated passkey identity (a stored key with no authenticator, where
any attempt to use it is counted) are test doubles. Nothing here has contacted the live sites.
