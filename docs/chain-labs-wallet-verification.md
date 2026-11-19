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
it is never read as it stands. This applies to a transfer's reply, to the later check of a waiting transfer (`checkPending` reports the outcome
`bad-receipt`, and a receipt that cannot be checked because the domain is unreachable stays waiting), and to a purchase's reply.

A dishonest authority cannot make up a receipt for a multi authority coin: it holds only its own key, so the approvals it needs are the partners'
signatures, which it cannot produce. A single authority coin has no partners; the receipt shows that the authority signed that entry and that the
authority's own head history holds it at that index, which is all there is to check.

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
`wrong-genesis`, and `bad-receipt` for a waiting transfer. Servers need no update.

## 6. Checks

```
node test/chain-labs-wallet-verify.js   # made-up receipts, missing or forged approvals, a changed genesis, edited purchase terms, first contact
node test/chain-labs-wallet.js          # the wallet as before, with verified receipts
```
