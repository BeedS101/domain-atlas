# Gen1: the claimant's change after a failed trade claim

A trade claim settles the claimant's balance first and the poster's balance second. When the claimant pays from a
larger balance, the first leg mints **change** (the remainder) for the claimant. If the second leg then fails, the
station refunds what was paid, but the `claim-incomplete` answer used to carry only the refund. The change was signed
and counted in the issuer's holdings but never reached the wallet (observed: the wallet held 5 g Gold, the station
counted 10 g for the owner). This document describes the correction. Context: `docs/gen1-unique-recovery.md`.

## 1. Where the pieces are made

| Step | Node (`issuer-server/server.js`) | PHP (`issuer-php/atlas/trade/claim.php`, `lib/bootstrap.php`) |
|---|---|---|
| Claimant's balance revoked, change and the poster's credit minted | `fulfillTradeSideSettlement` (first leg, local) or `relayTradeSettle` (first leg on another domain) | `fulfill_trade_side_settlement` or `atlas_relay_trade_settle` |
| Change | `bSide.remainder`, signed and added to the holdings index when minted | `$bSide['remainder']` |
| Second leg fails | the poster's settlement throws | same |
| Refund | `refundFailedSecondLeg`: revokes the credit minted for the poster and mints the amount paid back to the claimant; only when the first leg was local | `refund_failed_second_leg` |
| Answer | `502 claim-incomplete` with `refund`, now also `remainder` | same |
| Stored for a repeated request id | `replayStore(..., {status, body})` | exact JSON text |

The change is in memory when the answer is built, and the answer is the thing that is stored for a repeated request.
So the correction adds the **same signed credential** to that answer. Nothing is minted a second time, and a repeat of
the request returns the stored credential again.

The change is not kept anywhere else the wallet can read: not in the transaction journal (the first leg does not use
it), not in the replay store before this change, and not in the poster's mail (the claimant's side has no mail
notice). The holdings index keeps only ids and quantities.

## 2. What the answer carries now

`502 claim-incomplete`: `{error, refund, remainder, code}`.

- `refund`: the amount paid, minted back; `null` when the first leg was on another domain (no refund path exists
  there; none was added) or when the refund itself failed.
- `remainder`: the change minted by the first leg; `null` when the balance was spent exactly. The key is always
  present, which is how a wallet tells this version from the previous one.
- `GET /atlas/capabilities` lists `trade-claim-remainder` for a station that returns the field (PHP only when the
  handler file contains the new answer).

## 3. What the wallet does

The wallet knows from the journalled request what was paid and what change is owed
(`balance.quantity - offer.quantity`). For an incomplete claim it checks, before storing anything:

- the refund and the change are the claimant's own credentials, of the class paid, with the exact quantity (the amount
  paid; the leftover), issued by the right domain (the station for the refund, the balance's issuer for the change);
- the change is present when change is owed and absent when it is not;
- every credential verifies (signature against the issuer key, not revoked). If verification cannot be done
  (issuer unreachable) nothing is applied and the entry stays `pending`.

Then, in one storage write:

| Answer | Result |
|---|---|
| refund + change (or refund alone for an exact balance) | balance removed, credentials added, entry closed, reported as a refunded trade |
| change alone (the spend was on another domain: no refund) | balance removed, change added, entry kept as `needs-attention` (`claim-incomplete`, `applied`), nothing held. The payment is not refunded and has to be taken up with the operator |
| refund alone from the previous station version, change owed | refund applied, entry kept as `needs-attention` (`remainder-not-returned`, `applied`): the missing change stays visible |
| anything malformed (wrong owner, class, quantity, forged signature, change missing or unexpected) | nothing applied, entry `needs-attention`, balance held back |
| exact balance, no refund (foreign spend) | as before: balance held, `needs-attention` |

An entry marked `applied` never applies credentials again (a manual retry that gets the same stored answer only
re-reports it). Automatic recovery never resends a `needs-attention` entry, as before.

## 4. Compatibility and deployment

| Wallet | Station | Result |
|---|---|---|
| new | new | refund and change both arrive |
| new | previous version | refund applied, missing change flagged as above; the station keeps counting it |
| previous | new | the extra field is ignored; the old behavior (refund only) |
| previous | previous | the original behavior |

Deploy the station first, then the wallet. A station that was upgraded to the previous version and holds stored
`claim-incomplete` outcomes keeps returning them without the change until they expire; those cannot be completed
(the change credential was never stored).

## 5. Guarantees

- The change a first leg minted is returned as the same credential, any number of times, within the replay window;
  no repeated request mints another.
- Refund and change are applied together or not at all.
- A response that is malformed, wrongly owned, wrongly classed, wrongly sized or wrongly signed is not applied.
- A claim whose change is missing or unprovable is visible as `needs-attention`, never silently incomplete.
- Settlement and refund rules, amounts, holdings limits and successful claims are unchanged. A trade across domains
  is still not atomic.

## 6. Remaining risks

- A station that crashes after the first leg and before the answer is stored has no stored outcome, so neither the
  refund nor the change can be returned (see `docs/gen1-unique-recovery.md`, gap 2).
- After the replay window the stored answer is gone with the credentials in it.
- A foreign first leg is still not refunded. Only the change is returned; the payment stays with the foreign domain
  against the poster's undelivered credit.
- A claim answered by the previous station version cannot be completed (section 4).

## 7. Tests

`xvfb-run -a node test/manual-gen1-claim-remainder.js [node|php|both] [--only=R3]`

| | |
|---|---|
| R1 R2 | exact balance, larger balance: quantities in the wallet equal the issuer's holdings |
| R3 | lost answer, restart, recovery; repeated direct requests return the same two credentials |
| R4 R5 R6 R7 | concurrent retries, browser killed before storing, wallet locked, backup restored in a fresh profile |
| R8 R10 | wrong owner, quantity, class, forged signatures, missing or unexpected change: nothing applied; the genuine outcome then applies once |
| R9 | previous station version (no change field) |
| R11 R12 R13 | foreign first leg: larger balance, exact balance, lost answer |
| N1 | negative control: previous wallet and issuer: 5 g in the wallet, 10 g at the issuer, no signal |
| N2 N3 N4 N5 | new wallet with previous station, exact balance, previous wallet with new station, successful claims unchanged |

Result: 108 passed, 0 failed (Node 54, PHP 54). The wider regression results are in section 9 of
`docs/gen1-unique-recovery.md`.
