# Chain labs: what the wallet verifies itself

The wallet (`extension/chain-labs-wallet.js`) asks domains it has agreed to ask, and pins the key each domain answered with when it was added.
Holdings statements and head statements are signed by that key. Receipts, genesis documents and purchase terms were not: the wallet read
them from plain answers and compared amounts. This is what it now checks before it relies on them.

## 1. Receipts

A receipt is `{coinId, entry, hash, authoritySignature, approvals}`. The wallet accepts one only when every part holds, against the keys of the
coin's verified genesis (section 2):

1. the entry is a transfer of this coin and its hash is the SHA-256 of its canonical text;
2. the authority signed that hash;
3. each approval is from a distinct roster domain other than the authority, signed over the approval text for this coin, index and hash;
4. the authority and the approvers together reach the genesis threshold (all of the roster for a full roster coin);
5. the domain's own signed head statement at that index names the same hash.

Only then are the entry's fields compared with what the person signed. A receipt that fails any step is refused with `bad-receipt` and the reason;
it is never read as it stands. This applies to a transfer's reply, to the later check of a waiting transfer, and to a purchase's reply. What happens
to the transfer itself is in section 1.1.

A dishonest authority cannot make up a receipt for a multi authority coin: it holds only its own key, so the approvals it needs are the partners'
signatures, which it cannot produce. A single authority coin has no partners; the receipt shows that the authority signed that entry and that the
authority's own head history holds it at that index, which is all there is to check.

### 1.1 A transfer whose receipt does not verify

A domain that answers 201 has committed the transfer, so a receipt that fails does not show that nothing happened. The wallet therefore never drops the
transfer because of it. Three cases are kept apart:

- **The receipt failed.** The transfer stays on the pending list as `unconfirmed`, with the signed authorization, the digest that names it, the
  reason, the entry number the domain names and the time. `send` throws `bad-receipt` with `unconfirmed: true` and the digest. The wallet does not
  count the transfer as made or as failed, and nothing sends it again.
- **The receipt could not be checked yet.** When the domain, or the coin's genesis, cannot be reached (no connection, or a server error), the transfer
  stays waiting and is asked about again. A domain that answers but does not show the entry in its history is not in this case.
- **The domain's receipt verifies later.** `checkPending` asks for the proposal again; a receipt that verifies settles it and removes it.

An unconfirmed public coin transfer can also be settled without the domain that gave the bad receipt: `checkPending` asks the other domains of the
coin's pinned roster for the receipt of the entry number, and accepts one only if it passes every check in section 1 and matches the transfer.
Receipts of other domains are never trusted without those checks. The limits are: a private coin is not reconciled this way, because its entries name
accounts by reference and another domain's receipt cannot show which transfer it was; a single authority coin has no other domain; and two
unconfirmed transfers that look alike in their public fields are not both settled by one entry, so a second claim on the same entry stays unconfirmed.
An unconfirmed transfer is never pushed off the pending list by newer ones. The pending list shows it as unresolved, with the reason.

A purchase whose receipt fails stays in the pending purchases as `unconfirmed` or waiting. Asking again repeats the same request id, which the
domain answers with the entry it already made, so the Gold is not delivered twice.

### 1.2 A transfer request that gets no answer

`send` posts `{ authorization }` to `action=propose`. The authorization is the owner's signed transfer: type `atlas.ledger.transfer` v2, the coin,
its authority and genesis digest, the sender, the recipient, the amount, the sender's `baseSeq` and `baseHead`, a one-use nonce, and a window of
about 200 seconds (`issuedAt` five seconds back, `expiresAt` 200 seconds on). It is signed with the owner's key by the wallet before the request.

When the request gets no answer (a timeout after 8 seconds, a dropped connection, a refused one) the wallet sees only status 0 and cannot tell
whether the domain received it. So an unanswered `propose` may have transmitted a complete owner-signed authorization. What follows from that:

- The domain, or anyone who obtains the request from it (its logs, say), can have the transfer made once, and only
  that transfer: the authorization names the recipient, the amount, the coin, the authority and the genesis, and its nonce and `baseSeq` are
  used once. It cannot be turned into another transfer or used on another coin or domain, and it stops being valid when its window ends. A
  multi authority entry that was approved in time may still be written later, at its own time; it is still that one transfer.
- The wallet keeps no record of such a request. `send` throws `network` ("The domain did not answer.") and no pending transfer is written, so
  `checkPending` does not look for it, although its digest (the hash of the signed payload) is known to the wallet at that point.
- If the domain did make the transfer, the balance shown after the next lookup is lower and the recipient holds it. A second `send` signs a new
  authorization against the refreshed `baseSeq` and the domain accepts it as a different transfer, so a person who repeats the transfer without
  looking at the balance first sends it twice. Nothing is taken beyond what the person signed in each authorization.
- If the domain did not receive it, nothing happened, and the authorization lapses unused.

The wallet never resubmits an unanswered request by itself; it asks again only by the person's choice. Keeping the digest as a waiting transfer
for status 0, so that `checkPending` settles it, is a separate change that has not been made.

## 2. The genesis, and pinning

The genesis of a coin names its authority, roster keys, threshold and purchase terms; its digest is the coin's identity for every signature.
The wallet now:

- works out the digest itself and requires the domain's stated digest to equal it;
- requires the shape the ledger writes (distinct roster domains with P-256 keys, the authority first, a threshold that fits the mode);
- requires the key for the domain being asked to be the key pinned for it, and the key for any other domain on the wallet's list to be the key pinned
  for that domain;
- the first time, fetches the coin's first entry and checks that the authority signed it and that every roster domain signed this genesis digest, so
  the purchase terms are ones the whole roster agreed to and not only the domain being asked;
- pins the digest in the domain's record (`genesis[coinId]`, with the domain list and so in the wallet backup), with the roster domains whose keys it
  could not compare with a pinned key (`unpinned`).

After that, a genesis with a different digest under the same coin id is refused with `genesis-changed`, before anything is signed. A genesis that
fails the checks above is refused with `wrong-genesis`. Signing a transfer or a purchase intent uses only this verified genesis for the authority and
genesis digest it names.

## 3. Purchase terms

`offer()` reads the terms from the verified, pinned genesis and not from the plain answer, so edited terms are refused (`wrong-genesis` or
`genesis-changed`) and the coin shows as not for sale. The answer's `state` and `purchasesEnabled` still come from the domain's plain answer: they only
decide whether to offer Buy, and the domain refuses anything it cannot do.

## 4. First contact, and what is left

- **The first sight is trusted.** The wallet has no other source for a coin's genesis the first time. The pin stops later change; it does not tell a
  genuine first genesis from a made-up one. Roster domains that are not on the wallet's list are known only by the keys the genesis gives them. An
  authority that makes up a coin with partner keys of its own is accepted at first sight, and its receipts verify against those keys. Adding the real
  partner domain to the list is the check: from then on the coin is refused (`wrong-genesis`) if its genesis names a different key for that domain.
  `test/chain-labs-wallet-verify.js` shows both sides.
- **Wallets from before the pins** have none. Each coin is pinned the first time it is used after the update, with the same first-sight limit; nothing
  stored is changed, and balances, identities and the domain list are kept.
- **A coin's genesis cannot change.** If a domain legitimately starts over with another genesis for a coin id, the wallet refuses it; removing the domain
  from the list and adding it again clears its pins.
- **Below a full roster, two quorums can exist.** With a threshold below the roster size, two different entries for one index can each carry a quorum
  if they come from different partners; the partners sign only one entry per index, but the authority can ask different partners. A receipt proves a
  quorum signed it, and the domain's head statement shows it in that domain's history; a fork is found by comparing heads (`docs/chain-labs-spend-protocol.md`),
  not by one receipt.
- **A single authority coin** rests on its authority alone.

## 5. Compatibility

No endpoint or receipt format changed. The wallet's functions keep their names and results; the new outcomes are the error codes `genesis-changed` and
`wrong-genesis`. A pending transfer gained the states `unconfirmed` (and `index`, `reason`, `since`) and keeps its `authorization`; older pending items
without them keep working. `checkPending` outcomes are `done`, `waiting`, `unconfirmed`, `expired` and `rejected`. Servers need no update.

## 6. Checks

```
node test/chain-labs-wallet-verify.js   # made-up receipts, missing or forged approvals, a changed genesis, edited purchase terms, first contact,
                                        # unconfirmed transfers and purchases, reconciliation, network failures
node test/chain-labs-wallet.js          # the wallet as before, with verified receipts
```
