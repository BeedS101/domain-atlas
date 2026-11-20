# Partner consent for a coin of several domains

A coin of several domains is proposed by one domain, its authority, and signed by every domain in its roster before it opens. A partner
domain no longer signs the genesis because a message arrived. It records the proposal, its operator reads every term, and it signs only after
that operator accepted that exact coin and genesis digest with a signed operator request.

This applies to coins proposed after the upgrade. Coins that are open or frozen are not touched, and nothing here changes how a coin spends.

## 1. What a partner operator sees

`spend34/consent-list` (signed request, reading) returns each proposal that names this domain, with:

- the coin id, the genesis digest, where the proposal stands, and what can still be done with it
- symbol, name, decimals, the maximum supply and the starting treasury, in base units and in coins
- the authority, the number of approvals needed ("2 of 3"), and every roster domain with the fingerprint of its key, the authority and this domain marked
- the treasury reference, the faucet policy (or that the treasury is not limited), and the Gold purchase policy (or that there is none)
- for a private coin, the hash of the reference secret. The secret itself is never in a review, and never in the page.

Compare the **genesis digest** with the one the authority's operator reads from its own domain (`spend34.php?action=coin&coin=ID` shows
`genesisDigest`), by a route other than the one the proposal came by. The digest covers every term above, so two operators who hold the same digest hold the same coin.

## 2. Accepting and declining

| Action | Request | What it does |
| --- | --- | --- |
| `spend34/consent-accept` | `{coinId, digest}` | Records that this domain's operator accepted the coin whose genesis has that digest. A different digest, or a coin this domain does not hold, is refused. It does not sign and does not open anything. |
| `spend34/consent-decline` | `{coinId, digest, reason?}` | Records a decline, with an optional reason of at most 200 characters. |

Both take a **signed operator request only**. The operator token of the compatibility period is refused for them, from the first day and
whether or not signed requests were activated, so a consent is never given with the weaker credential. A key whose roster entry lists
`actions` needs these three added (section 6).

A proposal moves like this:

    awaiting ──accept──▶ accepted ──(authority asks for the signature)──▶ signed (final)
        │                   │
      decline             decline (only while no signature was issued)
        ▼                   ▼
     declined ──accept──▶ accepted

- A decline can be reversed by accepting, as long as the domain has not signed.
- An acceptance can be withdrawn by declining, as long as no signature was issued.
- **Once the domain has signed, nothing here takes it back.** The authority may open the coin at any later time, so the Studio then shows
  no Decline button and says so. Accept shortly before the authority's operator is ready to open the coin if you want the least time
  between agreeing and signing.
- Accepting twice, or declining twice, changes nothing.

The signature is issued when the authority next asks for it, which is the authority operator's next `open`. Accepting never opens a coin.

## 3. Opening a coin: the authority's side

1. The authority operator registers the coin in the Studio and presses Open. Every partner is asked in that one attempt, so each one holds the proposal. The answer is
   `409 needs-consent` with the partners and where each stands (`awaiting`, `declined`, or already `signed`). The coin stays pending, with its genesis and reference secret kept.
2. The partner operators review and accept.
3. The authority operator presses Open again. **That is a new signed operator request.** The earlier request, sent again, is answered from its
   record and carries nothing out (`X-Chainlabs-Operator-Replay: 1`), so an acceptance never runs an earlier request by itself. A `needs-consent` answer is recorded as not carried out, so a
   new open can be signed at once, without `repeat`.
4. When every partner has signed, the authority writes entry 0 and tells the partners to pick it up. The answer lists each partner with what it reported about consent.

### What the partner reports

A partner that signs says whether consent was recorded and when (`consent: {status: "accepted", recordedAt}`), or that the coin predates
the upgrade (`predates-upgrade`). The authority keeps that and shows it in the `open` answer and the Studio. **It is the partner's own statement.** The
authority cannot check it, and it is not cryptographic evidence of who approved or whether a person did. A partner that has not been upgraded
reports nothing and signs as before; the authority shows that as `not-reported`. That is why partners are upgraded first (section 7).

## 4. When the consent records cannot be used

A signature is **never** given when the consent state is missing, damaged or ambiguous. The partner answers `503 consent-unavailable` and
registers nothing new. That covers:

- the consent table or its upgrade marker missing, or only one of the two present
- a pending coin with no record, or with a record for another genesis digest
- a record that cannot be read, or a write that fails (including the note that a signature was issued): the signature is not given

The state is kept in `chain34.sqlite` of the partner. Recovery:

- **Storage trouble** (disk full, locked, restored from an older copy): fix it, or restore the database from backup. The authority's next Open asks again; nothing else is needed.
- **One coin has no usable record** (the proposal is listed as `unrecorded`): the operator reads it and accepts or declines it, which writes a fresh record bound to the digest it names. Nothing repairs a record by itself.
- **The table was lost**: the same two steps for each pending coin, after the database itself is back. A new, empty consent table is not installed over a half-present one.

## 5. Coins that were pending before the upgrade

When the upgrade first opens a partner's database it installs the consent records and an upgrade marker in one transaction, and records the
coins that are pending at that moment as `legacy`: this domain had already answered with its signature. They keep working, and cannot be
declined. Only that moment can create `legacy`. A pending coin that appears later without a record is not grandfathered; it
is `unrecorded` and needs an explicit acceptance. A database that has one of the two tables without the other is ambiguous and is not upgraded by itself.

## 6. Operator keys that are limited to some actions

The three consent actions are new, so a roster entry with an `actions` list does not include them. Give a key the actions without removing it:

    php chain-labs/lib/operator-cli.php grant-actions --fingerprint=FP --actions=spend34/consent-list,spend34/consent-accept,spend34/consent-decline
    php chain-labs/lib/operator-cli.php set-actions   --fingerprint=FP --actions=a,b,c     # replaces the list
    php chain-labs/lib/operator-cli.php set-actions   --fingerprint=FP --actions=all       # lifts the limit

The key, its label and whether it was revoked are unchanged, and it takes effect on the next request. A key with no list may take every action, the new ones included.
Activating signed-only requests needs every action that changes something covered by an active, proven key, so a domain with limited keys should grant these before it activates.

## 7. Deployment order

1. Upgrade **every partner domain** first. A partner that has not been upgraded still signs a proposal as soon as it arrives.
2. Install the roster entries for the partner operators (or grant the consent actions to existing keys) and prove a key with `operator/check`.
3. Upgrade the authority domain.
4. Then propose a coin. Rely on consent only when every domain of that coin reports it: the authority's `open` answer shows `not-reported` for a partner that does not.

Rolling back the code leaves the consent tables in place. Code from before the upgrade ignores them.

## 8. Storage is bounded

- A partner holds at most 100 proposals that are waiting (`PEER_MAX_PENDING_COINS`); more are answered `busy`. Declining one frees its slot.
- Declined proposals are kept up to 25 (`CONSENT_MAX_DECLINED`). Past that the oldest declined ones are forgotten entirely: the coin as this domain holds it and every row made for it. Nothing was ever signed for them, so an authority that sends one again makes a new proposal, awaiting consent.
- Reasons are cut at 200 characters.

## 9. Limits of this change

- **A pending coin cannot be withdrawn.** On the authority a coin that never opens stays pending, and its symbol stays registered on that domain. If a partner declines for good, register a new coin with a new symbol. Withdrawing a pending coin and releasing its symbol is a separate change that is not made here.
- Consent is per genesis digest. The terms cannot be changed for a pending coin; a change is a new coin.
- The partner's report to the authority is not proof of human approval (section 3).
- Consent is given with an operator key. Anyone who holds the key of a partner operator can accept in that operator's name; protect it as the other operator keys.

## 10. Checks

    php test/chain-labs-consent.php
    node test/chain-labs-consent-http.js
    node test/chain-labs-operator-cli.js
    xvfb-run -a node test/manual-chain-labs-studio-consent.js
