# Chain labs: coin spend protocol (design)

Status: design only. No code, no deployment, no change to the live services. Everything here is a demonstration
ledger with no monetary value.

## 1. Purpose

The chain labs (`chain-labs/`) can register a coin, open an empty account for a wallet key and read a balance, but no
coin balance can ever become non-zero and nothing can be spent. This document defines how two or more independent
domains can hold, fund and spend a coin so that no single domain can move funds alone, and what a wallet needs to
display it. It is the design that the simplified Ledger tab and the next build stages rest on. The creator of a coin
chooses whether the coin is run by this domain alone or by two or more domains together, and a coin can be bought with
Gold (Au) from the demo sites.

## 2. What exists today

Facts taken from the code in `chain-labs/` and the multi-issuer lab, which the design builds on.

| Area | Current state | Where |
| --- | --- | --- |
| Coin registry | One SQLite table per domain; a coin is registered on one domain only. Supply is integer minor units, capped at 10^12. The genesis is an unsigned SHA-256 of the coin record. | `coin26.php` |
| Coin accounts | `accounts(coin_id, owner_key, amount_units)` with `amount_units >= 0`. The only writer is account opening, which inserts zero. Nothing credits or debits it. | `account30.php`, `ledger29.php` |
| TEST-GOLD | A separate store keyed by public key (`accounts`, `claims`, `transfers`). Faucet credits 50 once per key; transfer debits and credits inside `BEGIN IMMEDIATE`. It does not use the coin registry. | `faucet.php`, `transfer.php` |
| Signed requests | Reads and account opening are signed by the wallet key over a canonical JSON object bound to an exact URL, a network, a nonce and a time. Only account opening stores nonces, so only it rejects replays. | `ledger29.php`, `account30.php`, `accounts31.php` |
| Balance proof | A balance answer carries no signature; the response says it relies on TLS. | `ledger29.php` |
| Two domains | Each domain runs its own independent ledger. The federation labs exchange signed demo events and compare signed commitments; they move no balances. | `events21.php`, `compare23.php` |
| Co-approval | The multi-issuer lab already has a state authority, a mandatory second approver, versioned state with compare-and-swap, one-pending-transfer-per-asset, signed chained receipts and crash recovery, for a single unique asset. | `issuer-php/atlas/demo/multi-issuer/inc/mi-core.php` |

Two consequences. First, the coin ledger has no funding path at all: the registry records an initial treasury
figure, but no account holds it. Second, the two domains never agree on balances because there is nothing yet to agree
on.

## 3. Goals and non-goals

Goals:

1. A coin has one authority domain that sequences its ledger, and a second domain that must co-approve every change.
2. No single domain key, and no single compromised server, can create, move or destroy funds.
3. Supply is conserved exactly after every change, and this is checked by every domain in the roster independently.
4. A spend cannot be applied twice, applied out of order, or applied against a stale balance.
5. A tampered or rolled-back authority is detected by the other domains from material they already hold.
6. A wallet needs only a few signed operations and can show a balance that carries a proof.
7. When a coin is created, the creator chooses single authority (this domain alone) or multi authority (this domain
   and a named partner domain). The choice is fixed in the genesis and shown wherever the coin is shown.
8. A coin can be bought with Gold (Au) through a domain-run purchase that delivers the coin once, and never takes Gold
   without delivering.
9. When a coin is created, the creator also chooses public or private visibility. Both can be scanned; a private coin's
   public view shows account references in place of keys (section 4.6).
10. A wallet finds its assets by asking a list of domains, with nothing to open and no ledger state of its own
    (section 11.1).

Non-goals:

- Consensus or Byzantine fault tolerance. This is a two-party approval scheme with one sequencer.
- Trustless atomic swaps or transfers between different coins. The Gold purchase in section 10 is a conversion run by
  the domain, which is always the counterparty.
- Real value, redemption, custody, recovery of lost keys, or a production issuer.
- Changing TEST-GOLD, the federation labs or the live sites.

## 4. Model

### 4.1 Roles

| Role | Who | Does |
| --- | --- | --- |
| Owner | A wallet P-256 key | Signs each spend from its own account. |
| Authority | The coin's issuing domain | Holds the authoritative ledger, orders changes, executes a change once approved, signs receipts. |
| Co-approver | Each other domain in the roster | Holds a mirror of the ledger, independently validates every change, signs or refuses. |

The roster and the approval rule are fixed in the coin's genesis and cannot be changed afterwards (section 4.3). The
authority is the issuing domain by default and is always a mandatory approver. A coin has one authority and zero or
more co-approvers; a single authority coin has none.

### 4.2 Genesis

A coin is created by a genesis record: coin id, symbol, decimals, maximum units, initial units, the treasury account,
the authority mode, the visibility (section 4.6), the roster and the policy. Every domain in the roster signs its digest, replacing the unsigned
genesis hash. A coin whose genesis lacks any roster signature is pending and cannot hold or move funds. The initial units are credited to the treasury account in log entry 0, so the whole
supply is held in accounts from the start and supply never changes afterwards.

### 4.3 Authority mode

The creator picks the mode on the coin creation form. The default is single.

| Mode | Roster and rule | What it protects | What it does not |
| --- | --- | --- | --- |
| Single | The creating domain only; one approval, its own | Supply is conserved, spends are ordered, replays and double spends fail, receipts are signed | Nothing stops this domain from rewriting the ledger or approving a spend the owner never made; no other party can notice |
| Multi | The creating domain plus one or more named partner domains (two to five domains in all); the authority and at least a threshold of the roster must approve every change | Everything in single mode, plus fewer than the threshold of keys or servers cannot move funds, and a rewrite is detected by every mirroring domain | Availability: with a threshold equal to the roster size, any domain being down stops spending |

Both modes use the same log, invariants, receipts and wallet operations. They differ only in the policy in the genesis:
single is a roster of one with a threshold of one, and multi is a roster of `n` domains (2 to 5) with a threshold `k`
(`2 <= k <= n`) and the authority mandatory. The default is `k = n`, every domain must approve; a lower `k`, such as 2
of 3, keeps spending alive while one domain is down. This is the same roster, threshold and mandatory shape the multi-issuer lab uses, evaluated by the same
function, so the rule is data and not separate code. In single mode the co-approval and mirroring steps of sections 5
and 7 are skipped and the authority's own approval is the only one.

For a multi coin the creator names the partners from the domains configured as peers and chooses the threshold. The
coin stays pending until every roster domain has signed the genesis, exactly as a multi-issuer asset stays pending until
its issuers sign. The mode and the roster cannot be
changed afterwards: moving a single coin to more domains means creating a new coin and migrating balances by spending
(open question 8). The wallet and the market page label every coin with its mode and, for multi, the roster size and
threshold ("3 domains, 2 of 3"); a single authority coin is labelled as not independently checked.

### 4.4 The ledger

For each coin the authority keeps an append-only log. Entry `n` holds the change, the owner's authorization, the
approvals, the hash of entry `n-1`, its own hash and the authority's signature. Account state is derived from the
log: for each owner, `units` and `seq`, where `seq` counts that owner's executed spends. The co-approver keeps the same
log by applying the authority's entries, verifying every signature and every invariant as it goes. Both can recompute
every balance from the log alone.

Amounts are non-negative integers in minor units, written as decimal strings in JSON and handled as integers in
code, never as floats. The existing cap of 10^12 units per coin stays.

Each entry exists in two forms, a public form and a private form, described in section 4.6. In a public coin they carry
the same account keys and are served alike.

### 4.5 Messages

All messages are canonical JSON (sorted keys, no whitespace) and signed with P-256 over the canonical bytes. Names and
fields below are the design; exact encodings are fixed in the build stage.

| Message | Signed by | Fields |
| --- | --- | --- |
| Transfer proposal | Owner | `type` (`atlas.ledger.transfer`), `v`, `network`, `coin`, `coinId`, `from`, `to`, `amount`, `baseSeq`, `baseHead`, `nonce`, `issuedAt`, `expiresAt` |
| Approval | Each domain | `type` (`atlas.ledger.transfer.approval`), `v`, `digest` (of the proposal), `approver`, `decision`, `approvedAt` |
| Receipt (log entry) | Authority | `index`, `transfer`, `ownerAuthorization`, `approvals`, `prevHash`, `hash`, `executedAt` |
| Head attestation | Either domain | `coinId`, `index`, `hash`, `issuedAt`, nonce-bound to the requester |

`baseSeq` is the sender's `seq` when the owner signed; `baseHead` is the log head hash. A proposal is valid only while
the sender's `seq` equals `baseSeq`, which is what makes a stale or replayed proposal fail. The wallet signs the
proposal through the existing signing bridge; the page's manifest must list the signing purpose, and the wallet asks
the owner to confirm the request before it signs.

### 4.6 Visibility

The creator picks the visibility on the coin creation form, next to the authority mode, and it is part of the genesis
that every roster domain signs. The default is public. It is fixed for the life of the coin; see open question 13 for
making a private coin public later.

| Visibility | What anyone can read | What only the key's owner can read |
| --- | --- | --- |
| Public | Everything: account keys, balances, every entry, the full history of any key | Nothing is withheld |
| Private | The coin, its roster and policy, total supply, the log head, and every entry in its public form: sequence, time, type, amount, and an account reference in place of each key | The entry in its private form and the key behind a reference, through a lookup signed by that key |

Both kinds are scannable (section 11.2). The difference is whether the scanner can say whose an account is.

**Two entry forms.** In a private coin each log entry has:

- a public form: `index`, `prevHash`, `executedAt`, type, amount, and `fromRef` and `toRef`, the account references. The
  authority signs it and every approving domain signs its digest. The hash chain and the receipts run over this form, so
  anyone can verify the chain, the head and the domain signatures without any key being exposed;
- a private form: the public form plus the real keys, the owner's authorization and the nonce. Only the roster domains
  keep it. Each approving domain validates the private form, including the owner's signature, and signs the public
  digest only after that.

In a public coin the two forms are the same record.

**References.** `ref = HMAC-SHA256(refSecret, key)`, encoded as base64url, where `refSecret` is a random value made per
coin. The secret is not in the genesis, which is public; the genesis carries only a hash of it, so every domain can
check it holds the right one. The authority creates it and sends it to each co-approver over the signed peer channel
while the genesis is being signed, and every roster domain keeps it as private state. The secret must exist because an
unkeyed hash would let anyone who holds a public key compute its reference and look it up. The genesis publishes the treasury's
reference (`treasuryRef`; the key itself in a public coin), so the treasury balance and total supply can be audited.

**What this protects, and what it does not.**

- It hides account keys from the public view. Amounts, times and the pattern of an account's activity stay visible, and
  the same account keeps the same reference, so activity can still be linked and sometimes attributed. References are
  pseudonyms, not anonymity, and the create form says so.
- A public observer cannot re-check owner signatures, because the keys are not in the public form. They rely on the
  authority, and in a multi coin the co-approvers, having checked the owner's signature before signing. That is the
  trust a public coin does not need.
- A reference cannot be checked publicly against a key, because the secret is needed to compute it. An owner who wants
  to prove an account is theirs reveals the key, and a roster domain confirms it with a signed answer.
- A roster domain always sees everything about its own coins, including private ones. Private means private from
  other users and from the public scanner, not from the operators.

## 5. Spend flow

1. The owner signs a transfer proposal and sends it to the authority.
2. The authority validates it: signature, audience and network, time window, nonce unused, coin and policy,
   `from` has at least `amount`, `baseSeq` equals the sender's `seq`, the amount is positive and within the cap, and the
   recipient is a valid key. It then stores the proposal as pending. Only one proposal may be pending per sender
   account. The authority signs its own approval.
3. The authority asks every co-approver to approve, sending the proposal to all of them at once.
4. Each co-approver first catches up: it fetches log entries after its own head, verifies each one's signatures, hash
   chain and conservation, and applies them. It then repeats every check from step 2 against its own mirror, not
   against the authority's statement of the balance. It signs an approval over the proposal digest and its own head
   only if its head equals the proposal's `baseHead`. Otherwise it signs a rejection, or signs nothing when something
   does not verify.
5. When the authority and enough co-approvers to reach the threshold have approved, the authority executes in one
   database transaction: it re-verifies the owner's authorization and every approval, checks that the sender's `seq` and the head hash are unchanged,
   debits the sender, credits the recipient, increments the sender's `seq`, verifies that the sum of all balances still
   equals the initial units, appends the signed log entry, and marks the proposal executed. Any failed check rolls the
   whole transaction back.
6. The authority returns the receipt to the owner. Every co-approver pulls it into its mirror, including any that did
not approve it, and each checks it independently.

A co-approver never trusts a balance the authority states; it checks the balance it has derived itself. That is what
stops an authority that inflates a balance from getting a second signature.

## 6. Invariants and where each is enforced

| Invariant | Enforced by |
| --- | --- |
| Supply equals the initial units after every entry | Sum check inside the executing transaction, and again by the co-approver when it applies the entry |
| No balance below zero | Integer arithmetic plus a `CHECK` constraint; debit guarded by `balance >= amount` |
| A spend applies against the balance the owner saw | `baseSeq` compare-and-swap on the sender's `seq` |
| A proposal executes at most once | Status transition `pending` to `executed` guarded by its current status; recovery completes a satisfied but unexecuted proposal exactly once |
| A signed request cannot be replayed | Per-owner nonce store on every signed operation, not only account opening; proposals also die when `seq` moves |
| The policy's approvals are present | Policy fixed in genesis; execution verifies the authority's approval and enough others to reach the threshold, all over the same digest |
| No history rewrite | Hash chain; each domain holds the head and can attest it |
| Time-limited authority | `expiresAt` on each proposal; expired proposals cannot execute |
| Visibility fixed | Part of the genesis signed by every roster domain; no operation changes it |
| A private coin's keys are never served publicly | Public routes read only the public form; the private form and the reference secret are served only to a request signed by the key concerned, or exchanged between roster domains |

## 7. Mirroring and disagreement

Each domain publishes a signed head attestation for each coin on request. Before approving anything, and on a
schedule, each domain compares heads with every other domain in the roster, not only with the authority. The comparison
from the federation labs is the model, applied to the ledger head instead of the event list. Comparing among the
co-approvers is what catches an authority that shows different histories to different domains.

- Heads equal: normal operation.
- A domain is behind: it catches up from the receipts.
- Heads differ at the same index, or a receipt fails verification, at any domain: that domain stops approving the coin
  and tells the others, who check the evidence before they stop too. The coin is frozen until an operator reviews the
  evidence. Nothing is repaired automatically.
- A partner never holds more entries than the authority: it writes first. A partner that does, or an authority that holds
  fewer than a partner saw, is a restored or rolled-back authority.

This makes a rolled-back or forked authority detectable by every mirroring domain, because each holds signed receipts
the authority cannot retract. With a threshold below the roster size, a domain that did not approve an entry still
checks it, so approving domains that collude are noticed by the rest, though the rest cannot prevent the entry. It does
not make the attack impossible: an authority that withholds service still stops the coin.

## 8. Failure modes

| Event | Result |
| --- | --- |
| Co-approver down, threshold equal to the roster size | No spend executes. Balances stay readable. Safety is chosen over availability. |
| Co-approver down, threshold below the roster size | Spending continues while enough domains remain; the absent domain catches up when it returns. |
| Authority down | Nothing changes. Reads may be served from the mirror, marked as mirrored and possibly behind. |
| Crash after the threshold of approvals, before execution | Recovery finds the satisfied pending proposal and executes it once. |
| Crash during execution | The transaction rolled back; the proposal is still pending and recovery retries. |
| Duplicate submission | Same digest is idempotent; the nonce store rejects a second signed copy. |
| Two spends from one balance at once | One executes; the other fails on `baseSeq`. |
| Authority database restored from an old backup | The co-approvers' heads are ahead, so the heads differ and the coin freezes. |
| Authority shows different histories to different domains | Approvals are bound to the head, and the co-approvers compare heads with each other, so the split is found and the coin freezes. |
| Authority key compromised | It still cannot create a valid entry without the other approvals the threshold needs; the coin is frozen and the key rotated. |
| Fewer than the threshold of co-approver keys compromised | They cannot approve alone: every entry also needs the authority's signature and a valid owner authorization. |
| Threshold or more of the roster colluding | They can approve a bad entry; every other mirroring domain detects it and freezes. This is the limit of the scheme. |
| Owner key compromised | The thief can spend that account; there is no recovery in this design. |
| Clock skew | Approvals and proposals carry a bounded window; outside it they fail closed. |

## 9. Funding

The treasury is an ordinary account created in entry 0. A spend from the treasury is a normal transfer: signed by
the treasury key, approved under the coin's policy, conserving supply. A faucet is then a policy on treasury spends: a
per-key limit, a maximum amount and a cool-down, written into the genesis and checked by every approving domain at approval time.
No code path may credit an account other than by a transfer.

**The policy.** The genesis carries `faucet`, either `null` (treasury spends are unlimited) or three fields:
`maxAmount`, the most one grant may be; `perKeyLimit`, the most one recipient key may ever receive from the treasury;
and `cooldownSeconds`, the least time between two grants to the same key (0 to 30 days). `perKeyLimit` is at least
`maxAmount` and neither exceeds the coin's maximum. The limits apply to every spend whose sender is the treasury key
and to nothing else: units passed on by a recipient, or returned to the treasury, do not reopen a limit. Each domain
that applies an entry checks them against totals it derived from the log, and the checker recomputes them.

**Custody and grants.** The treasury key is an ordinary wallet key pair made by the authority when the coin is created
and kept in the authority's private folder in a file readable by its owner only; it is never in the genesis, which
carries only its reference. Grants are operator-driven: the operator asks the authority to grant an amount to a key, the
authority signs the transfer with the treasury key, and the transfer is approved and committed like any other. A
wallet-initiated claim route is not part of this stage.

**Entry time.** The cool-down relies on each entry's `executedAt`, so every domain checks it: a UTC time that is not
earlier than the previous entry, inside the owner's proposal window (from two minutes before `issuedAt` up to
`expiresAt`), and within two minutes of the committing domain's own clock.

## 10. Purchasing with Gold (Au)

Gold (Au) here is `atlas.element.gold`: a Gen1 fungible credential counted in grams, the domain's base currency at
rate 1, with a holding cap of 500, mined in the demo (`issuer-php/lib/store.php`). It is a signed credential with no
ledger behind it and no link to any Chainblock coin. The domain already sells catalog items for a fungible price with
`POST /atlas/asset/purchase` (`issuer-php/atlas/asset/purchase.php`, SPEC.md section 5.8): the buyer signs an intent,
the purchased asset is created before the balance is touched, and a signed request id makes a retry return the stored
result. A ledger coin is a new kind of purchasable item on the same endpoint, priced in Gold.

### 10.1 Flow

1. The coin's catalog entry declares its price class (`atlas.element.gold`) and a price per unit, fixed in the genesis.
2. The buyer signs a purchase intent naming the Gold credential, the coin, the quantity, the recipient ledger key
   (the buyer's own by default) and a request id.
3. The domain takes the spend locks on the Gold credential and a lease on the request id, checks that the credential is
   its own, valid, unspent and large enough, and computes the price from the genesis rate.
4. It writes the decided result to the transaction journal before anything changes: the Gold remainder and the ledger
   credit, both keyed by the request id.
5. It executes a treasury-to-buyer transfer through the coin's normal spend path (section 5) carrying the request id as
   a unique purchase reference. In single mode the authority executes it; in multi mode the co-approver must approve it
   too (10.2).
6. It then supersedes the Gold credential, issues the remainder, stores the result and returns the transfer receipt and
   the remainder together.

The ledger credit is unique per request id, so the coin is delivered at most once however often a request is retried.

### 10.2 What each co-approver checks in multi mode

A purchase transfer carries the buyer's signed intent and the Gold credential. Each co-approver verifies the buyer's
signature, that the price arithmetic matches the genesis rate, that the credential carries the authority's signature
and is not on its published revocation list, and that the purchase stays inside the limits in the genesis. Co-approvers cannot
see the authority's private spend locks or journal, so they cannot prove that the Gold was really consumed, and Gold is
worth whatever the authority issues. What they enforce is the bound: a minimum price, a limit per key and a limit per
day, so a dishonest authority cannot drain the treasury beyond those limits without the other domains noticing.

### 10.3 Failure handling

| Event | Result |
| --- | --- |
| Ledger step refused or fails before the entry exists | Nothing is debited; the Gold stays valid and the journal entry is abandoned. |
| Crash after the ledger entry, before the Gold is superseded | Recovery finds the ledger entry for the request id and completes the Gold step; the step only moves forward. |
| Crash before the ledger entry | Recovery repeats the transfer; the unique purchase reference stops a second delivery. |
| Buyer retries with the same request id | The stored result is returned. |
| Buyer reuses the Gold elsewhere meanwhile | The spend lock refuses the second use until the request finishes. |
| Treasury lacks the quantity | The purchase is refused before any change. |

### 10.4 Risks to settle before enabling

- Gold is minable for free in the demo, and conversion into a capped class skips the holding cap
  (`docs/incident-gen1-gold-platinum.md`). Unlimited Gold at a fixed price lets one person buy the whole treasury, so
  per-key and per-day limits and a price are required, not optional.
- The Gold integrity fixes (`docs/gen1-fungible-safety-fixes.md`) should be confirmed deployed on the live sites
  before Gold is accepted as payment.
- The purchase is one way. Selling a coin back for Gold is not part of this design.
- This links two test economies; both stay labelled as having no monetary value.

## 11. Wallet-facing surface

### 11.1 The Ledger tab: a list of domains

The tab no longer opens accounts or holds ledger state. It holds a list of domains. For each domain on the list the
wallet asks whether its key has any assets there and shows a reference to each result, built when the tab is opened.
Nothing about the coins is stored in the wallet beyond the list and a cache of the last answers.

- Adding a domain to the list is the consent to ask it. The list is part of the wallet's backup and restore, so a
  restored wallet finds its assets again.
- An account exists when a domain first credits the key (open question 4), so there is nothing to open.
- The lookup is `holdings`: the wallet sends its public key to the domain, and the domain answers with a statement
  signed by its own key, `atlas.ledger.holdings`, listing for each coin the coin id, symbol, visibility, authority
  mode, the balance in minor units, the account `seq`, the log head hash and index, and the time of the statement. The
  wallet verifies the signature against the key pinned from the domain's manifest and ignores any answer that fails,
  is malformed or is larger than a fixed size.
- For a public coin the request carries only the key. For a private coin the request is signed by the key over a fresh
  challenge from the domain, and a domain returns private-coin results only to such a request. A domain answers a
  request that is not signed with its public coins only.
- The wallet asks the listed domains in parallel with a short timeout each and caches the answers. A domain that is down
  shows its last answer with its age. One failing domain never blanks the tab.
- A row reads "Domain X says you hold N of COIN, as of time T", with the mode, the visibility and a proven or reported
  mark. A reference disappears if the domain stops listing it; the wallet does not own the balance.
- The tab is read-only. Sending, Buy with Gold and approvals use the owner-signed spend flow of sections 5 and 10, added
  in later stages and shown as actions on a row.

The issuer-signed account credentials and the receipt adapters are not needed, because the wallet's own signed requests
identify it.

### 11.2 The scanner

A read-only set of pages and routes on each domain that hosts a coin, like a block explorer.

| Page | Shows |
| --- | --- |
| Coin | Genesis, authority mode, roster, threshold, visibility, total supply, treasury, log head and count |
| Entries | The log in order, in pages, each with its hash and signatures |
| Entry | One receipt, with a button that verifies the chain from the genesis to that entry |
| Account | Balance, `seq` and history for a key (public coin) or a reference (private coin) |
| Domains | For a multi coin, each roster domain's head and whether they agree; a frozen coin says so and why |

A public coin shows keys on the account and entry pages. A private coin shows references and amounts and never a key, and
the account page is reached by reference. A holder who knows their key can reach their own pages through the signed
lookup of section 11.1. The scanner is a view over the same signed receipts the domains exchange, so a visitor can
check what it shows.

The scanner needs a small index for each account (its entries by position) and paged reads of the log, so a page view
never walks a whole coin. Both come with the ledger store in stage 2.

## 12. Reuse

| Need | Reuse | Change |
| --- | --- | --- |
| Policy evaluation | `txlab_evaluate` in `issuer-php/atlas/demo/txlab/inc/txlab.php` | None |
| Canonical JSON, signing, pinned-key verification | helpers in the txlab and multi-issuer modules | Gather into one shared library for `chain-labs/` |
| Execute-once, recovery, state chain | `mi_transfer_advance` and `mi_recover` in `mi-core.php`, `mi_state_digest` in `mi-verify.php` | Per-account `seq` and a per-coin log in place of one owner per asset |
| Purchase with a fungible balance, request ids, spend locks, journal and recovery | `issuer-php/atlas/asset/purchase.php`, `atlas_begin_replacement` and the transaction journal in `issuer-php/lib/replacement.php` | A ledger coin as a purchasable kind; the transfer is the idempotent step before the Gold is superseded |
| Atomic spend arbitration, exact amounts | `experiments/spend-coordinator-sqlite.js`, `exact-quantity-conservation.js` in the Next repo | Reference for tests |
| Conservation rules | Core `verifier/conservation.py` | Reference for the invariant checker |

The multi-issuer lab stays as it is; the chain labs get their own tables and endpoints rather than extending it.

## 13. Build plan

Each stage ships separately, with tests, on its own branch.

1. Shared library and host config for `chain-labs/`; the hard-coded host lists move into configuration, including the
   list of peer domains. Behaviour unchanged.
2. Ledger store: genesis with the authority mode, the visibility and every roster signature, the log with its public and
   private forms, the account references, derived accounts, a per-account index, paged reads and the invariant checker,
   with tests including conservation under random operation sequences and a check that no public route returns a key of
   a private coin. This is built as the library `chain-labs/lib/ledger.php` with its tests (stage 2a); the coin
   creation form gaining the single or multi choice and the public or private choice is stage 2b: `coin26.php` records the mode, visibility, partners and threshold in the genesis it hashes, and a multi coin stays pending. Opening the ledger store from that record waits for the funding stage, when the treasury key exists.
3. Funding: treasury account and the faucet policy. Built as the faucet policy in the genesis, enforced by the library
   and the checker, the treasury key custody helpers and the operator grant (the library only).
4. Spend in single mode, end to end on one node: proposal, execution, receipts and recovery, and the signed `holdings`
   lookup with its challenge. This is the first stage a wallet can use.
   Built as `lib/spend.php` and the endpoint `spend34.php`. Proposals are stored pending, one per sender, and
   identified by the digest of the signed payload; a single authority coin executes them at once and answers with the
   receipt (the signed log entry); recovery finishes what a crash left. `holdings` answers public coins to anyone and
   private coins to a request the key signed over a single-use challenge, which names the domain and the key. The
   operator opens a registered coin as a ledger and makes treasury grants through the same endpoint.
5. Spend in multi mode: approval and execution between two and three local PHP nodes in the test suite, with all-of and
   2-of-3 thresholds, including concurrent double spends, a domain down, and crash injection.
   Built as `lib/peer.php`, the `peer` route and the multi paths of `spend34.php`:
   - Domains talk through signed envelopes (`atlas.peer.request`: sender, receiver, action, body, time, nonce) that the
     receiver checks against the key it pinned for the sender; actions are `genesis`, `sync`, `approve` and `notify`.
     Pinned keys and addresses come from `chainlabs-peers.json` in the private folder (or `peer_public_pem_b64` for the
     single peer of a two-domain lab); the domains a host may name as partners come from the optional `partners` list of
     `chainlabs-config.json`.
   - Opening: the authority registers the coin, every roster domain checks the genesis against its own key and the keys it
     pinned for the others, signs it, and picks up entry 0 from the authority. Opening can be repeated while a partner is down.
   - Execution: the authority prepares the entry, stores it with the proposal, asks roster domains until it has the
     threshold, writes the entry and tells the others, who catch up from the authority and apply every entry with the same
     checks as a commit. A crash after the approvals is finished by recovery without asking again.
   - A co-approver catches up first, then checks the entry against its own copy (head, signatures, balance, faucet), and
     refuses a second, different entry for an index it approved less than two skew windows ago.
   - That last rule stops an authority that asks twice only when every domain must approve. Below that, two quorums can
     meet only at the authority, so a fork is detected by head comparison (stage 6), not prevented.
   - Concurrent proposals: partners refuse the loser of a race for one index; the authority asks again once the winner is
     written. An entry takes the time of the entry before it when the request began earlier.
   - A partner catches up lazily when it is asked for a coin, a receipt or a proposal, and when it is asked to approve. A
     holdings lookup does not catch up first; the wallet compares domains in stage 8.
6. Mirroring: catch-up, head comparison and the freeze rule, for multi coins.
   Built in `lib/peer.php` and the `head`, `compare` and `evidence` routes of `spend34.php`:
   - A head statement (`atlas.ledger.head`: coin, domain, index, hash, time) is signed by the domain and carries the
     authority's own signature on that entry and the entry's public form. `GET head` publishes it; roster domains ask for it
     with the `head` peer action.
   - Before an approver signs, and whenever the operator calls `compare`, a domain compares its head with every other roster
     domain, not only the authority. A domain that is behind catches up from the authority first.
   - The coin freezes on evidence the receiving domain checks itself: `fork` (two statements from roster domains for one index
     with different hashes), `rollback` (an entry the authority signed, held by a domain, and a statement from the authority
     made after that entry was executed that holds fewer entries), `authority-equivocation` (two entries for one index, both
     signed by the authority). The domain that finds it freezes and sends the evidence to the others, who verify it and freeze.
   - An entry that fails a check during catch-up freezes that copy and is kept as `invalid-history` evidence; the others are
     told, and they pull and check the history themselves rather than freezing on the report.
   - A frozen copy approves nothing, catches up from nothing and compares nothing. History and receipts stay readable.
     Resuming a frozen coin is an operator's review of the kept evidence; no function does it.
   - A domain that claims entries nobody signed, or an old statement replayed as a new one, proves nothing and freezes nothing.
7. Purchase with Gold, with the limits in the genesis, tested with crash injection at each step of 10.3.
   Built on the chain-labs side as `lib/purchase.php` and the `purchase`, `purchase-recover` and `purchase-cancel` routes of
   `spend34.php`. The code that holds Gold is reached through an adapter (`gold-adapter.php` in the private folder, which returns
   the callables listed at the top of `lib/purchase.php`) and is not changed here; the tests use a stand-in
   (`test/support/gold-stand-in.php`). Wiring the adapter to `issuer-php` is a separate, reviewed step.
   - The genesis may carry a `purchase` policy: the price class, the issuer key that signs the credentials, `unitsPerPrice` (units
     delivered per unit of price, so the rate is fixed in the genesis), `minPrice`, and the limits `perKeyUnits` (ever, per
     receiving key) and `perDayUnits` (in any 24 hours, all keys). A sale is exempt from the faucet policy.
   - A sale is a treasury transfer whose authorization carries `purchase: {requestId, price}`; the buyer's signed intent and the
     credential travel in the private form of the entry. The ledger itself refuses a second entry for one request id, a price
     below the minimum, an amount that is not price times rate, and a sale past either limit, so the authority cannot bypass
     these; every approver re-checks them against its own copy of the log.
   - The authority verifies the intent and credential, takes the lock on the credential, journals the decision, delivers the
     units, then spends the credential and issues the remainder. Every step is repeated safely after a crash, and the result is
     stored per request id. The tests inject a crash after each of the lock, the journal, the submitted transfer, the entry and
     the credential step, on single and multi coins.
   - An approver in multi mode runs the adapter's `verify` and `revoked` for itself (`no-purchase-verifier` when it has none),
     and checks that the verified request id, price and recipient are those of the entry. The intent's expiry is checked when
     the request arrives, not again by approvers, so a sale that waited for a partner can still be finished.
   - Treasury spends share one pending proposal per sender, so sales are delivered one at a time. A sale that meets another
     in flight is journaled and answered 202; the same request, or `purchase-recover`, finishes it, and a request id repeated
     returns the stored result. A sale that partners keep refusing (a credential on their revocation list) waits until the
     operator cancels it with `purchase-cancel`, which frees the credential.
8. Wallet: the Ledger tab as a list of domains with the `holdings` lookup, the transfer signing flow and Buy with Gold,
   in a new file with only small changes to `viewer.js`.
   Built as `extension/chain-labs-wallet.js` (the rules, with no storage, network or page access of its own),
   `extension/chain-labs-tab.js` (the section drawn above the existing account cards of the Ledger tab, which are unchanged)
   and small hooks in `wallet.js`, `viewer.js` and `viewer.html`:
   - The list holds host names and the key pinned for each domain when it was added. There is no independent source for a
     chain labs domain's key yet (the labs 29/38 key document is the issuer's, not the ledger's), so the key a domain answers
     `coins` with is pinned on first use and its fingerprint shown; a later statement signed by any other key is ignored. The
     list is part of the backup and restore; the cache of answers and the unfinished sends and purchases are encrypted like the
     rest of the wallet and are not backed up.
   - A lookup is a signed request over a fresh challenge when the identity can make raw ECDSA signatures, and a plain one
     (public coins only, never shown as proven) when it cannot. A statement is used only if it is signed by the pinned key, is
     for this domain and this key, is not more than five minutes old or two minutes ahead, claims no more than was asked for
     (`proven`) and has exactly the fields the wallet reads; anything else is ignored and the domain keeps its last answer,
     shown with the problem and its age.
   - The signer in `wallet.js` signs only `atlas.ledger.holdings.request`, `atlas.ledger.transfer` and
     `atlas.ledger.purchase.intent`, raw r||s, for a password identity; a passkey identity is refused. The generic signer
     still refuses all `atlas.ledger.*` messages.
   - Send checks the recipient, the amount (exact decimal parsing against the coin's decimals, never rounded) and the balance
     before signing, describes the transfer in words, signs against the balance and head the domain just reported, signs again
     once if the base moved, and accepts the receipt only if it matches what was signed (for a private coin, whose entries name
     accounts by reference, the coin and amount). A transfer through a partner is pointed at the authority. A transfer waiting
     for approvals is kept and checked later.
   - Buy with Gold reads the offer from the coin's public genesis on its authority, which must be on the list, checks price
     against the minimum and the credential, signs an intent (`atlas.ledger.purchase.intent`: coin, credential id, price,
     recipient, request id, expiry) and sends it with the credential. An unfinished purchase is kept with its request id and
     resumed by signing a new intent for the same request. The Gold credentials come from the wallet's own items of class
     `atlas.element.gold`; how the real Gold credential and intent are laid out is settled when the adapter is wired to the
     issuer code.
9. Scanner: the coin, entries, entry, account and domains pages of section 11.2, with tests that a private coin's pages
   never contain a key.
   Built as `chain-labs/scan35.php` (read-only JSON routes) and `chain-labs/scan35.html` (one page with hash routes):
   - The routes are GET only and the database is opened read-only. `coins`, `coin`, `entries` (after an index, at most 100 per
     page), `entry`, `account` (by reference, paged by position) and `domains`. They read public forms only: a private coin's
     answers carry references, amounts, hashes and signatures, and no key, authorization or reference secret. A key finds no
     account in a private coin. A coin still waiting for signatures has no page.
   - The page draws everything with `textContent` and hash links it validated; no server text is parsed as HTML. A public coin
     shows keys in its entries and accounts, a private coin shows references.
   - Verification runs in the browser: from the genesis to the head or to a chosen entry, a page at a time, it recomputes each
     entry's hash from its public form, checks that it extends the entry before, that the authority signed it, that the roster
     domains approved it (at least the threshold, distinct, and not the authority counted twice) and, for entry 0, that every
     roster domain signed the genesis and the entry is the one the genesis gives. The keys are those in the coin's own genesis,
     whose digest is shown. Balances are not replayed, so what a visitor learns is that the log is the one the roster signed,
     not that every balance follows from it.
   - `domains` asks each other roster domain for its signed head (the peer `head` request, so only pinned domains are asked),
     says whether it is level, behind, ahead, holds another entry at the same place (a fork), or did not answer, and returns the
     statements as signed so the page can check them against the genesis keys. The answer is kept 15 seconds so the route
     cannot be used to make a domain's partners answer in bulk. A frozen coin shows the evidence that froze it (the signed
     statements, verified in the page); the record of an invalid entry shows only its index and reason, since it holds the
     private form.
   - The scanner does not catch a partner up with the authority before it answers; it shows this domain's copy.
   - A registered coin is not on the ledger until an operator opens it (stage 5, `open`): the registry (`coin26.sqlite`) and the
     ledger (`chain34.sqlite`) are separate, so a domain with registered coins and no `open` has an empty scanner. The Coin
     Creation Studio page lists each coin's ledger state (none, pending, active, frozen) and has the open and grant operator
     buttons, which call the existing `open` and `grant` routes. Resuming `open` for a multi coin used to leave its partners
     without entry 0 until they were next read, because the unfinished read of the coin's row held a read lock on the
     authority while the partners were told to catch up; the row is now read to its end first.
10. Market figures and the Gold gate (`lib/market.php`, the `market` route of `scan35.php`, `market27.php`, `index.html`).
   - Price, market cap and 24 hour volume come from the authority's ledger and its genesis purchase policy, in demo Gold (Au);
     a figure with no source is a dash. A coin is stated by its authority only, so a multi authority coin is one row. Volume
     counts entries that carry a purchase reference, newest first, at most 500 entries, and says when it is a lower bound.
   - A coin is sellable only if its genesis has a purchase policy. The genesis is immutable, so GOPH, MWC and OSC, opened without
     one, cannot be sold through this route; a new coin gets a policy by passing `purchase` when the operator opens it.
     Giving an existing coin one would need a new kind of entry (a set-once policy signed by the authority, approved by the
     threshold of a multi coin, understood by the scanner's verifier and the wallet), which is not built.
   - Wiring `gold-adapter.php` to `issuer-php` (audit). Every spend path of the issuer takes `atlas_spend_lock()` before it
     checks a credential, but that lock is a file lock held for one request, so it cannot hold a credential across the journal
     and the ledger delivery that the purchase needs, and a buyer could spend the same Gold elsewhere in between. The one
     central place to add a persistent hold the issuer honours is `atlas_spend_lock()` itself. The issuer's intent is
     `{payload, proof}` with a WebAuthn or raw ECDSA envelope and its credentials are `domain-atlas-asset/1.0` with an SPKI owner
     key, where the ledger intent is `{payload, signature}` with a raw point key, so `verify` has to convert and to check the
     issuer signature over `asset_payload_of()`. `finish` can use `atlas_commit_replacement()`, which is idempotent by request id.
     Until this is built and reviewed, purchases against the real issuer stay off (no `gold-adapter.php`, so `purchasesEnabled` is
     false and no Buy button is shown).

## 14. Open questions

1. Which domain is the authority for a coin? Default: the issuing domain.
2. Who holds the treasury key, and is the faucet automatic or operator-driven? Default, now built: an operator key
   held by the authority, with operator-driven faucet grants (section 9).
3. Is the owner's authorization signed through the page bridge, the extension, or both? The bridge needs the page
   manifest to list the purpose; the extension can sign directly. Default: both, same payload.
4. Should a transfer to an unopened recipient create the account? Default: yes, as part of the same entry.
5. Fixed pending limit: one pending proposal per sender account, or one per coin? Default: one per sender.
6. Does TEST-GOLD move onto this ledger, or stay as the single-node demo? Default: stay as is.
7. Gold price and limits: a fixed rate in the genesis, with a per-key and a per-day limit. Default: set by the creator
   within bounds the operator configures.
8. Can a single coin later become multi? Default: no; create a new coin and migrate balances by spending.
9. Can a coin be sold back for Gold? Default: no.
10. Which domains can be named as partners? Default: only those configured as peers with pinned keys.
11. Roster size and threshold limits. Default: two to five domains; the threshold defaults to all of them and may be
    lowered to a minimum of two, with the authority always required.
12. How a domain that has been down for a long time catches up. Default: it pulls missing receipts in order and may
    not approve anything until its head equals the authority's.
13. Can a private coin be made public later? Default: yes, once, by a change signed by every roster domain; never the
    other way.
14. How the reference secret reaches the roster, and whether it can be rotated. Default: the authority sends it over the
    signed peer channel during genesis signing; no rotation in the first version.
15. Are amounts visible on a private coin? Default: yes. Hiding amounts needs different cryptography and is out of scope.
16. Do the references stay fixed for the life of the coin, or can an owner ask for a new account reference? Default:
    fixed; an owner who wants another reference opens a new key.
17. Page size and rate limits for the scanner and the `holdings` lookup. Default: fixed page size, per-address limits
    from the domain's existing abuse limits. The scanner now has the fixed page size (100 at most, 25 by default); the
    per-address limit is not built and is left to the web server, and the `holdings` lookup has none yet.
18. Does the wallet show private-coin results from a domain only after the owner approves each lookup, or automatically
    once the domain is on the list? Default: automatically, since adding the domain was the consent.

## 15. Not claimed

This is not consensus, not atomic settlement and not Byzantine fault tolerant. One domain sequences each coin, and that
domain can stop it. In a multi coin the authority and enough other domains must approve, so fewer than the threshold of
compromised keys cannot move funds, and signed, chained receipts make a rewrite detectable. Owner keys have no recovery.
A single authority coin has no independent check at all. Gold is a credential with no ledger behind it, so a purchase is
worth what its issuer says. A private coin hides account keys from the public scanner and nothing else: amounts, timing and
the pattern of activity stay visible, references are pseudonyms, and every roster domain sees everything. The public
cannot re-verify owner signatures on a private coin. Nothing here has monetary value.
