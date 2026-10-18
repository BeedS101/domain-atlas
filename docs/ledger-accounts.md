# Ledger accounts in the Gen 1 wallet

Status: the wallet side is built and tested against local test doubles. The ledger side is **not**
agreed. No production adapter ships, nothing in this repository talks to a real ledger, and the
endpoint contract in the last section is a **draft for discussion**.

## What this adds

A third inventory sub-tab, **Ledger**, beside Collectibles and Documents. It lists *references* to
accounts that live on a remote ledger. The wallet never holds an authoritative quantity for them.

Portable assets (`domain-atlas-asset/1.0`, for example `atlas.element.gold`) are untouched: same
credential, same signing, same storage, same lists. Ledger accounts use their own credential type
and their own store, so nothing that reads or verifies assets can see them or be changed by them.

## The credential

`domain-atlas-ledger-account/1.0`, signed by the issuing domain's key:

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

The signature covers `{id, ledger, owner, issuedAt}` (canonical JSON). Every level of the object
is checked against an allow-list of keys, and any field whose name looks like a figure (balance,
quantity, amount, available, total, holdings, funds, value, supply, decimals, units and similar) is
refused at any depth. A credential cannot carry a balance, so there is nothing for a wallet to
mistake for one.

Labs 26 treasury allocations are not wallet balances and are not read by anything here.

## What the wallet stores

One record per account, under the owning identity's public key:

| Field | Meaning |
| --- | --- |
| `credential` | The credential above, verbatim. |
| `consent` | Absent until the person allows lookups. Holds the ledger origin they allowed. |
| `backgroundSync` | Separate per-account switch. Default **off**. |
| `cache` | The last balance the ledger reported, with the ledger's own time and when it was fetched. Display only. |
| `lastProblem`, `lastAttemptAt` | Last failure code and time, shown in words. |
| `pendingEndpointOrigin` | A changed ledger address waiting for approval. |

The balance is a string of digits plus `decimals`, for example `{"amount":"2000","decimals":2}`
shows as 20.00. It is never added, compared or converted by the wallet.

## Network access and consent

- Adding an account contacts only the issuing domain, to check its signature and revocation. The
  person is asked first and the question names the domain.
- Looking up a balance needs **per-account permission** that names the issuer and says the wallet
  will follow the ledger address the issuer publishes. Until then the wallet sends nothing for
  that account.
- The ledger's origin is **pinned** at the first lookup. If the issuer later publishes a different
  address the wallet stops and asks again ("Allow new address…"); it does not follow silently.
- Requests are limited to the issuer origin and the pinned ledger origin, with no redirects and no
  cookies. Only `https` is accepted, plus `http` on loopback for testing.
- Opening the tab looks up only accounts that have permission, and not again within 30 seconds.
- **Background checks** are a separate, per-account switch, off by default. They run only while a
  wallet page is open (a 60-second tick, one tab at a time through a Web Lock), at most every
  10 minutes per account and never faster than 5. There is no service-worker polling. They are
  refused for identities that cannot sign without a prompt.

## Indicators

Each account shows two indicators, each with a glyph, a word and a visible sentence, so state is
never colour alone:

| Level | Glyph | Meaning |
| --- | --- | --- |
| Unavailable | ⊘ | Cannot happen now (no interface for that ledger, wrong or locked identity, needs a prompt each time). |
| Available | ○ | Possible, but not allowed yet. |
| Enabled | ● | Allowed by the person. |
| Connecting | ◐ | A request is out right now, and to whom. |

"Lookup" and "Background check" are shown separately. A manual request in flight does not claim
to be a background one. The status line is a polite live region; the pulse on Connecting stops
under reduced motion.

## Removing an account

"Remove from wallet…" deletes the local reference only. It cancels any request in flight, makes no
network call at all, and ends background activity because the record is gone. The ledger account
and its balance are not touched, and the confirmation says so.

## Finding an account again

"Find accounts…" takes an issuing domain, asks for permission, discovers the ledger address and
asks the ledger for the accounts belonging to the **active identity**. The identity signs a
request to prove it owns them. Recovered credentials are verified exactly like pasted ones,
recovered accounts come back with **no permission, no balance and background checks off**, and
accounts already held are skipped. "Copy credential" is the other recovery path.

## Multiple identities, including vault identities

- A reference belongs to the **owner public key** in its credential. It is shown only when that
  identity is active and unlocked; the tab names which identity it is showing.
- Nothing assumes the default identity. Adding a credential owned by another identity is refused
  with a plain reason rather than filed under the wrong one.
- This repository has local-password identities (silent signing) and passkey identities (a
  hardware ceremony per signature), plus a local test counterparty. There is **no separate vault
  identity type here**. The rules are written for the property that matters: whether the identity
  can sign without asking. Anything that cannot gets manual lookups only, with background checks
  shown as unavailable and the reason. If a vault identity is added later, it plugs in through
  the same `canSignSilently` decision.
- Ledger messages (`atlas.ledger.*`) are **refused** by the signing function reachable from web
  pages, in the same way `atlas.call.*` is. They are signed only by a dedicated internal path
  that checks the message's `audience` is the issuer or the pinned ledger origin.

## Adapter interface (wallet side)

An adapter is how the wallet talks to one kind of ledger. None ships.

```
contract                                a string naming the interface it implements
supports({issuerDomain, network, coin}) true if it can serve that target
discover(target, ctx)                   -> { endpoint }          the ledger's current origin
fetchBalance(target, endpoint, ctx)     -> { amount, decimals, asOf }
listAccounts(target, endpoint, ctx)     -> [ credential, ... ]   optional
```

`ctx.fetch` is scoped as above, `ctx.sign(payload)` signs with the owning identity only for
`atlas.ledger.*` payloads whose `audience` is an allowed origin, and `ctx.signal` aborts on
removal or when permission is withdrawn. Until an adapter registers, the tab shows lookups as
unavailable and says why.

## What was not changed

Asset signing, Gold, Trading Station, Post Office, Collectibles, Documents, issuer compatibility,
backup and restore, and the manifest permissions. Backups do not carry ledger references; the
recovery paths are rediscovery and the copied credential. The one edit to existing logic is the
extra refusal in `signWithSelf`.

## DRAFT endpoint contract, not implemented

Nothing below is built on the issuer side and nothing in the wallet depends on it yet. It is the
smallest thing that would satisfy the adapter interface, for agreement with Core and the PHP
account API before any adapter is written.

1. **Discovery.** `GET https://<issuer>/.well-known/atlas-ledger.json` returning
   `{ "endpoint": "https://…", "contract": "<name>/<version>" }`. Open question: should this
   document be signed by the issuer key, so a hijacked path cannot redirect balance lookups?
2. **Balance.** `POST <endpoint>/…` with
   `{ payload: { type: "atlas.ledger.balance", v: 1, audience: <endpoint origin>, network, coin, nonce, issuedAt }, proof: { publicKey, signature } }`.
   Response `{ amount: "<integer digits>", decimals: <0-18>, asOf: "<ISO time>" }`. The ledger
   verifies the proof, the audience, a recent `issuedAt` and a fresh `nonce`.
3. **Account listing (rediscovery).** The same shape with `type: "atlas.ledger.accounts"`,
   returning issuer-signed account credentials owned by the proving key.
4. **Errors.** 401 for a bad proof, 404 for no such account, so the wallet can say which.

Open questions:

- Is the amount an integer in minor units with `decimals`, as assumed, or something else?
- Does the account API sign balance responses, or is TLS to the pinned origin the trust anchor?
- Should the credential carry a display `label` (cosmetic, never a figure)?
- What does "vault identity" mean in Core terms, and can it sign a request without a prompt?
- Should refresh re-check credential revocation each time? Add-time checking exists; refresh-time
  does not yet.
- Should backups carry references, or stay as they are?

## Tests

- `node test/manual-ledger-core.js`: credential shape, balance handling, indicator levels.
- `node test/manual-ledger-wallet.js`: storage, consent, scoping, background rules, removal,
  rediscovery, signing refusal, against local doubles in the extension's service worker.
- `xvfb-run -a node test/manual-ledger-tab.js`: the tab through the real extension page.

The ledger in these tests is a **simulation with an invented request shape**. Passing them shows
the wallet's own rules work. They say nothing about any real ledger or the PHP account API.
