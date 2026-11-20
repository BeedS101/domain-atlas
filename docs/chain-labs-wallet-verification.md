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

A purchase request is treated the same way: only a 4xx other than 408, 425 and 429 that is the domain's own refusal (`ok: false` with a `code`) ends it. A rate limit,
a timeout, a firewall page or an answer that is not in the domain's form keeps the pending purchase, with its Gold request, and asking again repeats the same
request id, which the domain answers with the entry it already made.

A purchase whose receipt fails stays in the pending purchases as `unconfirmed` or waiting. Asking again repeats the same request id, which the
domain answers with the entry it already made, so the Gold is not delivered twice.

### 1.2 A transfer request that gets no answer

`send` posts `{ authorization }` to `action=propose`. The authorization is the owner's signed transfer: type `atlas.ledger.transfer` v2, the coin,
its authority and genesis digest, the sender, the recipient, the amount, the sender's `baseSeq` and `baseHead`, a one-use nonce, and a window of
about 200 seconds (`issuedAt` five seconds back, `expiresAt` 200 seconds on). It is signed with the owner's key by the wallet before the request.

When the request gets no answer (a timeout after 8 seconds, a dropped connection, a refused one) the wallet sees only status 0 and cannot tell
whether the domain received it. An unanswered `propose` may have transmitted a complete owner-signed authorization, and the domain may have
committed the transfer. What follows from that:

- The domain, or anyone who obtains the request from it (its logs, say), can have the transfer made once, and only that transfer: the authorization
  names the recipient, the amount, the coin, the authority and the genesis, and its nonce and `baseSeq` are used once. It cannot be turned into
  another transfer or used on another coin or domain, and it stops being valid when its window ends. A multi authority entry that was approved in
  time may still be written later, at its own time; it is still that one transfer.
- If the domain did make the transfer, the balance after the next lookup is lower and the recipient holds it. If it did not receive the request,
  nothing happened and the authorization lapses unused.

What the wallet does:

- **It keeps the signed transfer before sending it.** The signed authorization and its digest (the hash of the signed payload) are written to
  the pending transfers, in the `unknown` state, before the request leaves the wallet, so a crash, a restart or a lost answer cannot lose them.
  Pending transfers belong to the wallet's identity and are stored with its other data, so they are still there after a restart.
- **A request with no answer stays `unknown`.** `send` returns `{ status: 'unknown', digest, note }` and the transfer stays on the pending list.
  The wallet does not count it as made or as failed. A 201 with a verified receipt removes it; a 201 whose receipt does not verify makes it
  `unconfirmed` (section 1.1); a 202 makes it `waiting`; only an answer that refuses the transfer (a 4xx `ok: false`) removes it as not made.
  A timeout, a dropped connection, a 5xx or an answer that is not the domain's JSON refusal never does.
- **Only the domain's own refusal says it was not made.** An answer removes the transfer only when it is a 4xx other than 408, 425 and
  429, carries `ok: false` and names one of the codes a domain uses for a transfer it refused before storing it or closed
  (`stale`, `insufficient`, `expired`, `pending-exists`, `bad-signature`, `bad-authorization`, `no-account`, `replayed`,
  `legacy-authorization`, `wrong-authority`, `wrong-genesis`, `unknown-base`, `unknown-coin`, `not-authority`). A rate limit, a timeout from a proxy
  in front of the domain, a firewall page, a `busy` or `wrong-index` answer (after which the domain keeps the proposal and may make it), or a code
  the wallet does not know, may reach the wallet for a transfer that was made, so the transfer stays `unknown` and is settled by the proposal and its
  receipt as above.
- **It never signs another authorization as a retry.** An unknown transfer is not sent again, by the wallet or by `checkPending`. The one case
  where a second authorization is signed is when the domain itself refused the first as `stale` (so it was not made), and then the new one
  is signed on the account as it stands, once. A person who sends again after an unknown outcome signs a new, different transfer, which the
  domain accepts as such; the pending list and the Ledger tab say beforehand that the earlier one is still unresolved.
- **It settles the transfer from what the domain and the ledger show.** `checkPending` asks `action=proposal` for the stored digest, the
  domain's existing way to ask about a transfer. An `executed` proposal is settled by its receipt through the same checks as any receipt
  (section 1), including another roster domain's receipt for a public coin. A `pending` proposal turns the transfer into an ordinary waiting
  one. An `expired` or `rejected` proposal removes it, since the domain has recorded that it was not made.
- **A transfer the domain says it never saw is settled only with evidence.** When the proposal is unknown (404 `unknown-proposal`) the wallet does
  not guess. Once the authorization has lapsed (`expiresAt` plus 600 seconds, so a domain whose clock differs still refused it) and the
  domain's signed holdings, checked with the wallet's own signature as every lookup is, show the sender's account at the `baseSeq` the transfer was
  signed on, the transfer was not made and is removed. Earlier than that, or when the account has moved on, the transfer stays `unknown`: the
  wallet cannot tell from the holdings alone whether the transfer or a later one moved the account.
- **No answer to the check stays unknown.** A domain that does not answer, or answers with anything else, leaves the transfer where it was.
- **The list is bounded without losing any of them.** `unknown` and `unconfirmed` transfers are never pushed off the pending list by newer
  ones, and the wallet refuses a new `send` with `too-many-unresolved` once 50 of them are unresolved.

The Ledger tab shows an unknown transfer as "Outcome unknown at <domain>: sending <amount>", says the transfer may or may not have been made, that the
wallet keeps it and will not send it again, and offers Check now. The send notice and the Check now notice use the same words, and never call
the transfer failed or sent.

The limits: a transfer the domain made but now answers `unknown-proposal` for, on an account that has since moved on, stays `unknown` until the
domain's proposal or a receipt answers; the wallet does not settle it from the account's sequence alone. It also does not search the domain's ledger
history for the transfer by its public fields, because a private coin's entries name accounts by references the wallet cannot compute and a public
coin's fields alone can match a different transfer. A domain that denies a transfer it made is caught only when the signed holdings later show the
account moved.

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

## 4.1 Signature format 2

The wallet verifies a genesis signature and an authority signature in either format (`docs/chain-labs-signature-format.md`): format 2 first, format 1
only for a bare lowercase hex digest. For each coin it keeps `v2From` with the genesis pin, the lowest index at which it has seen a verified
format 2 authority signature, and then refuses a format 1 authority signature at or after it, whether it comes from a whole chain read or from one
receipt (`spend_verify_receipt` on the server side names the previous hash so the same rule applies there). A coin whose entry 0 is in format 2
needs genesis signatures in format 2 from every domain. Receipts and genesis signatures from before stay valid. A wallet from before this
change cannot verify a format 2 receipt, so wallets are released before any domain activates.

## 5. Compatibility

No endpoint or receipt format changed. The wallet's functions keep their names and results; the new outcomes are the error codes `genesis-changed` and
`wrong-genesis`. A pending transfer gained the states `unconfirmed` and `unknown` (and `index`, `reason`, `since`) and keeps its `authorization`; older pending items
without them keep working. `send` can also return `{ status: 'unknown' }`. `checkPending` outcomes are `done`, `waiting`, `unconfirmed`, `unknown`, `not-made`, `expired` and `rejected`. Servers need no update.

## 6. Checks

```
node test/chain-labs-wallet-verify.js   # made-up receipts, missing or forged approvals, a changed genesis, edited purchase terms, first contact,
                                        # unconfirmed transfers and purchases, reconciliation, network failures
node test/chain-labs-wallet.js          # the wallet as before, with verified receipts
node test/chain-labs-wallet-unanswered.js  # a request that gets no answer: before and after sending, after the domain committed it,
                                        # after a restart, never signing a second authorization, settling by proposal, receipt or lapse
```
