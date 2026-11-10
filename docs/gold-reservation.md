# Holding Gold for a ledger purchase

Status: experimental. Off by default. Not enabled on any live domain. Test Gold only.

A ledger purchase (`chain-labs/lib/purchase.php`) takes several steps in several requests: the buyer's Gold is reserved, the coin is
delivered on a ledger, and only then is the Gold spent. The issuer's per-request spend lock (`atlas_spend_lock`) lives for one
request, so it cannot span that. This document describes the durable hold that does, what it guarantees and what it does not.

## 1. What was wrong

1. `atlas_spend_lock` is a stripe `flock` held until the request ends. It orders two spends against each other and nothing more:
   once the request that took it is over, anyone can split, convert, consolidate, transfer or revoke the same Gold.
2. The purchase engine's `lock` / `release` / `finish` adapter had no real implementation. The test stand-in kept its own table, so
   a ledger sale could deliver coins for Gold the owner then spent elsewhere.
3. Every spend funnels through `atlas_revoke_many`, but it did not know about any reservation.
4. The ledger refused a retry of a finished sale whose credential was spent (`revoked-credential`), because it checked the
   revocation list before looking at its own journal.
5. A pending treasury proposal stayed executable after its sale was abandoned, so coins could be delivered after the Gold was released.
6. A Gold credential carries numbers with fractions (element properties); the ledger's canonical form refuses them, so a real
   credential could not be journaled at all.

## 2. Design

One record per credential in `lib/holds/holds.json` (private folder, mode 0600), replaced atomically under a lock.
`issuer-php/lib/gold-hold.php`; endpoint `POST /atlas/ledger/gold-hold`; adapter `chain-labs/lib/gold-issuer.php`.

States: `held` -> `delivering` -> `finalized`, or `held` / `delivering` -> `cancelled`.

| State | Meaning | Ends by |
|---|---|---|
| held | reserved; no delivery attempted | `begin`, `cancel`, or lapse after 900 s (safe: delivery starts only after `begin`) |
| delivering | the ledger is about to be asked, or has been | `finalize`, or `cancel` with a closure signed by a trusted ledger domain (section 3a). **Never by time.** |
| finalized | the credential was spent in one journaled transaction | terminal |
| cancelled | Gold free again | terminal |

### Binding

`reserve` takes the Gold credential and the owner's signed intent, the same `atlas.ledger.purchase.intent` the wallet signs for the
ledger. The issuer verifies the owner's raw ECDSA signature itself and stores the signed intent. The hold binds the credential id,
owner key, price, receiving ledger key, ledger coin id and request id. `finalize` takes none of these from the caller: it spends
exactly that price of exactly that credential, returns the rest to the owner and burns the price. The operator token only
says which caller may ask; it never stands in for the owner.

### Enforcement

* `atlas_spend_lock` (every spend path takes it) refuses a held credential after taking the stripe lock.
* `atlas_revoke_many` (every spend and the operator's own `/atlas/revoke` end here) takes the credential's stripe lock and refuses
  to revoke a held credential unless it is that hold's own finalize. The check is made under the same lock the hold is made under,
  so a revoke and a reserve cannot interleave.
* A hold list that exists but cannot be read stops every spend (503). It is never read as empty. A missing file means no holds.

### Finalize and crash recovery

Finalize runs through the existing replacement journal (`atlas_commit_replacement`) under a secret random key stored in the hold
(`txnKey`), so no request id a caller picks can occupy it and a repeat after any crash recovers (`atlas_txn_recover_key`) and returns
the same stored result. The remainder is signed before the journal entry is written. A repeat after the entry was written returns that credential; a repeat before it starts over, and the unrecorded credential from the first try is never registered or revoked.
Crash points tested: `hold:reserved`, `hold:begun`, `hold:cancelled`, `txn:minted`, `txn:journal-written`,
`txn:holdings-registered`, `txn:revoked`, `txn:replay-stored`, `txn:journal-removed`, `hold:spent`.

### Replay

A signed intent is used once. A hold that ended (cancelled or lapsed) keeps its intent digest; reserving the same signed intent
again is refused (`intent-used`), so a leaked intent cannot be used to freeze the Gold again. The buyer signs a new one. One
request id cannot hold two credentials; one credential has one active hold; one owner has at most 5 active holds; at most 500 overall.

## 3. Ledger side

`chain-labs/lib/purchase.php` calls, in order: `lock(requestId, credential, intent)` (reserve) before journaling, `begin(requestId,
credential)` before every attempt to deliver, `finish` after the entry exists, `release(requestId, credentialId)` only when the ledger
has ruled delivery out. Changes made for this:

* `begin` hook: from there the hold does not lapse. A refusal ends the sale.
* On a final failure the pending treasury proposal is rejected first, and the sale is abandoned only if no entry exists. Otherwise it
  continues as delivered.
* `release` runs before the sale is marked abandoned; if it fails the sale stays journaled and is retried. It carries the ledger's signed closure (3a).
* `holding` hook: every domain that approves a sale asks the issuer whether the credential is held for it (3b).
* A request already journaled is answered from its journal even if its credential is now spent or its intent has expired.
* Optional `pack` hook: the credential is kept in the ledger as `{id, gold: <canonical text>}` (see 4).

### 3a. Cancelling a hold that was begun

The word of whoever holds the issuer's token is not evidence that a delivery cannot happen. A hold that is `held` (delivery never begun)
is still cancelled by the token alone, since nothing can have been delivered. A `delivering` hold is cancelled only with a **closure**:
`{payload: {type: 'atlas.ledger.purchase.closure', v: 1, domain, coinId, requestId, credentialId, price, headIndex, headHash, closedAt}, signature}`,
signed with the ledger domain's key (`purchase_closure` in `chain-labs/lib/purchase.php`). The ledger makes one only after it looked: no entry
delivers the request and the sale's pending treasury transfer was rejected, so it cannot be executed later; a delivered sale gets none
(`cannot-cancel`). The issuer accepts it only from a domain listed in `ledgerAuthorities` of `lib/atlas-gold-hold-config.json`
(`{"a.example": "<PEM public key>"}`), only for exactly this coin, request, credential and price, and only if it is at most 15 minutes old.
It keeps the closure in the hold record. With no `ledgerAuthorities`, a delivering hold cannot be cancelled by anyone until the file is changed.

### 3b. Partner verification

`GET /atlas/ledger/gold-hold-status?credentialId=...&requestId=...` (public, read-only, on only while holds are on) returns the hold's state
signed with the issuer's key: `atlas.gold.hold.status` with the credential, request, coin, price, receiving key, owner, a digest of the owner's
signed intent and the state (`held`, `delivering`, `finalized`, `cancelled`, `lapsed`). Nothing is returned for a request id that holds
nothing, and the id cannot be guessed. A domain that approves a sale (the `holding` hook of `chain-labs/lib/gold-issuer.php`, called from
`purchase_check_entry`) fetches this itself and approves only if the signature is the issuer's named in the coin's policy, every field matches the
entry's sale (same coin, price, receiving key, owner and the digest of the intent in the entry), the status is under five minutes old, and the state is
`delivering` or `finalized`. An issuer that cannot be reached is a transient refusal (the sale waits); a hold that is missing, only `held`, cancelled,
or for another sale is a refusal. So an authority that never held the Gold, held it without beginning delivery, or held it for a different
sale cannot collect the partner's approval, and a hold the issuer has cancelled cannot gain approvals afterwards.

## 4. Integration notes (intent format and keys)

* A wallet key and a Gold owner key are the same thing: the raw uncompressed P-256 point (65 bytes, base64url). Signatures are raw
  r||s over the canonical text of the payload. Nothing is converted. The ledger's `{payload, signature}` becomes the issuer's
  `{payload, proof: {signerRole: 'raw-ecdsa', publicKey: <owner>, signature}}`. WebAuthn (SPKI) owners are refused for holds.
* Both canonical forms are byte-identical for the intent payload (strings and integers only). They differ for numbers with
  fractions, which the ledger refuses and a Gold credential contains, hence `pack`. The balance returned to the buyer after a sale is
  `{id, gold: <canonical text of the credential>}`; a wallet reads it with `JSON.parse(balance.gold)`.
* The genesis purchase policy names the issuer's raw public key in `issuerKey`.
* The adapter checks the credential offline (issuer signature, class, owner, domain); the issuer re-checks everything on `reserve`.

## 5. Enabling (separately, not part of this change)

Issuer: `lib/atlas-gold-hold-config.json` = `{"enabled": true, "tokenSha256": "<sha256 of the operator token>", "ledgerAuthorities": {"<ledger domain>": "<its public key PEM>"}}`. Apache must pass the
`Authorization` header to PHP (`SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1` or a rewrite rule). Chain labs: a
`gold-adapter.php` in the private folder returning `gold_issuer_adapter([...])`; the authority adapter holds the token, partners'
adapters do not. Neither is done on evtec.co.za or domain-atlas.co.za.

## 6. Remaining limitations

Real purchases stay off on every live domain: no `gold-adapter.php`, no hold config. What the two blockers look like now:

1. **Partners see holds.** Closed by 3b, for multi authority coins. A single authority coin has no other domain to ask; its buyer trusts that
   authority, as with any single authority coin. A partner whose adapter has no `holding` hook (the test stand-in) does not ask.
2. **A compromised authority (its signing key and its token) can still lie.** It can sign a closure for a sale it did deliver, or collect
   approvals while the hold is `delivering` and cancel the hold with a forged closure before committing the entry. The closure removes the
   token alone as a way to free Gold that is being delivered, ties each cancel to the sale and keeps the evidence; it does not make the ledger's
   own word independent. Closing this needs the partners to witness the closure (they refuse to approve the request ever again and sign that
   they hold no entry for it) or to check the hold when they receive the committed entry. Not built.
3. **The hold file is a single file.** Losing it (restore from an old backup, deletion) removes holds. Credentials with a
   `delivering` hold would then be spendable while a sale may be delivered. A missing file is read as no holds because that is the
   state of a fresh issuer; the issuer cannot tell the two apart. Backups must include `lib/holds/`.
4. **Node issuer.** `issuer-server` has no hold endpoint and does not enforce holds. It cannot back a purchase.
5. **A lapse needs a new intent.** After a crash between `lock` and journaling, the hold lapses after 15 minutes and the same signed
   intent cannot be reused.
6. **No owner-signed cancel.** Only the ledger (with a closure) ends a begun hold early; the owner waits for the lapse (held) or the ledger.
7. **Status is polled, not pushed, and not rate limited here.** Limits per address are left to the web server in front of it.
8. **Test scale.** File-based, sized for the demo (500 active holds). Not load tested.
