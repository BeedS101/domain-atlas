# Chain labs: one approval per ledger position

A multi authority coin needs approvals from roster domains. This describes what an approving domain promises about them, how the promise
survives a restored database or a crash, and what it costs in availability. Code: `peer_on_approve` and `peer_execute` in
`chain-labs/lib/peer.php`, the approval memory in `chain-labs/lib/checkpoint.php`, `spend_expire` in `chain-labs/lib/spend.php`.

## 1. The rule

A roster domain signs at most one entry hash for a coin and ledger index, for as long as it exists. Time does not release it.

Why time cannot: an approval never expires, and a domain that accepts history from the authority does not look at the clock. An authority
that holds an approved entry can commit it at any later moment, and it can show a different log to different domains. If an approver also
signs a second entry for the index once the first is "old enough", the authority can commit the first on one copy and the second on another,
and both carry valid, fully approved signatures. Before this rule the window was twice `LEDGER_CLOCK_SKEW_SECONDS` (240 seconds).

## 2. What an approver keeps

| Where | What |
| --- | --- |
| `ledger_approved` | One row per coin and index: the hash, the signature as it was issued, when, and who asked. Never replaced. |
| `<coin>.log` in the checkpoint folder | An `approve` line with the same facts, written before the signature leaves the domain and before the row exists. |
| `ledger_approval_refusals` | A row for each different entry the authority asked for after an approval: the approved hash, the refused hash, the requester and the time. Evidence only; it does not stop the coin. At most 200 rows per coin. |

An approval is looked up in both places. A row lost with a restored database, or a line that was written before a crash cut off the row,
is enough to refuse a different entry. If the checkpoint cannot be read, the domain approves nothing (`checkpoint-unavailable`,
`checkpoint-corrupt`); it never falls back to the table alone. A database from before this change gets the new columns when it is opened,
and its existing rows count as approvals.

The `approve` lines are not a floor and do not affect the rollback guard (`docs/chain-labs-rollback-protection.md`). The limit stated there
holds here too: an operator who restores both the database and the checkpoint folder from before the approval removes the memory of it.

## 3. Asking again

Asking for the entry that was approved returns the signature that was given, whatever the clock says. That is not a new approval, so it is
safe, and it lets the authority collect approvals again after a crash or an outage. The same checks still run for everything except the
clock: the entry must extend the domain's head, the coin must be active and the checkpoint sound. A different entry for the index is refused
with `equivocation`, and recorded.

## 4. What the authority does so the rule does not stall the coin

Before the rule, an authority that could not finish an entry made a new one, and the partners approved it once 240 seconds had passed.
That recovery is gone, so the authority now stays with the entry it asked for:

- A pending proposal keeps its prepared entry and approvals for as long as the entry extends the head, however old. It is not replaced after
  a refusal, only when the head has moved on.
- An entry older than the clock window is written at the time it was prepared for, so the approvals it holds are enough. Entries stay in
  order because nothing has been written since.
- A proposal holding such an entry is not expired when its owner's authorization runs out; the entry was prepared while it was valid.
- Only one entry for an index is with the partners at a time. A proposal that finds another one waiting finishes that one first, or
  answers `busy`. Two entries asked for at once could each win approvals from different partners, and with a full roster neither could
  ever collect the rest.

Everything else is as it was: the threshold counts the authority, every approval is verified against the roster key, and an approval is
over the entry hash, the index and the coin.

## 5. What it costs: an abandoned or half-approved entry

A domain that approved an entry will approve no other for that index. So an index can stall:

- The authority put entry E to the partners, fewer than the threshold approved, and the rest cannot approve E any more. A partner that has not
  seen E refuses it as too old once the clock window has passed (it will not backdate), and a partner that approved E will not sign another.
  With a full roster one such partner is enough.
- The authority drops the proposal without writing E, or is gone. The approvals that were given stay valid for the index.

The coin then takes no new entry until E is written (`busy`). Nothing unsafe happens: no second approval exists, the copies agree, and
`peer_recover` keeps asking. The proposal stays pending, which blocks its sender from submitting another. This cannot be repaired by the
authority alone, since the authority is the party the rule protects against.

Where it can happen: a partner outage that begins while an entry is being approved and lasts past the clock window, with a threshold that needs
that partner (always, for a full roster). Below a full roster the authority may reach the threshold without the absent partner.
`test/chain-labs-approvals.php` has the case.

### Options, none built yet

1. **Leave it.** The coin stays stopped until the partner that is missing approves E in time or the operators agree out of band. It is the
   safest and the least code; the cost is a stopped coin and an operator decision for each stall.
2. **Release by witness.** The way a sale is closed (`peer_on_close_sale`): the authority asks the other domains for signed statements that
   they never approved E, and a domain that approved E releases it once enough domains have signed that they did not, so that E could not reach
   the threshold. The approvals for E stay as evidence, E is marked void, and the index can then take another entry. This keeps the property that
   no two entries for an index can both be committed, but it needs a new peer action, a threshold rule for how many witnesses are enough (for
   a full roster, one domain that never approved E), and a decision about what a domain does when it has approved E and the witnesses cannot be
   reached.
3. **Operator supersede.** An operator on each approving domain records, with a note, that E is void for the index. It needs no new protocol,
   but it puts the safety of the rule on the operators' care: voiding E on a domain that has since seen E written would let that domain sign a
   second entry.

## 6. Checks

```
php test/chain-labs-approvals.php   # the conflict, the kept approval, restored databases, a lost row, a damaged checkpoint,
                                    # full roster and partial thresholds, retries, one entry in flight, the stall
php test/chain-labs-multi.php       # the multi authority suite, with the 240 second case now refused
```
