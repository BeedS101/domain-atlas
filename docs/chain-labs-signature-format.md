# Chain labs: signature format 2

A domain signs two things with its domain key: the genesis of a coin (each partner of a multi authority coin signs the genesis digest) and every
ledger entry (the authority signs the entry hash). Until now both signatures covered a bare 64 character hex string. A signature over a bare hash
says nothing about what the hash was for, so the same signature is valid wherever the same bytes are signed again. Signature format 2 signs a typed
message that names its purpose, the coin, the signer's domain and (for an entry) the index, so a signature made for one purpose cannot be used for
another, and one made for one coin cannot be used for another.

Code: `chain-labs/lib/sigformat.php` (messages, kinds, the ratchet, the durable activation record, the readiness probe), the callers in
`chain-labs/lib/ledger.php`, `chain-labs/lib/peer.php`, `chain-labs/lib/spend.php` and `chain-labs/spend34.php`, the verifiers in
`chain-labs/scan35.html` (`ScanVerify`) and `extension/chain-labs-wallet.js`. Tests: `test/chain-labs-sigformat.php`,
`test/chain-labs-sigformat-activation.php`, `test/chain-labs-sigformat-http.js`, `test/chain-labs-wallet-verify.js`, `test/chain-labs-scan-http.js`.

Signing in format 2 stays **off** on every domain until an operator turns it on (section 6). Nothing in this change signs differently by itself.

## 1. Two different version numbers

"Signature format 2" and the `v: 1` inside the new messages are unrelated.

- **Signature format** says what a signature covers: format 1 (legacy) covers the bare hex digest or entry hash; format 2 covers the typed message below.
  It is the number the operator activates and the number the ratchet follows.
- **`v: 1` in a message** is the version of that message object's own layout. A later change to the layout of the same message would be `v: 2` of
  the message, and would still be signature format 2.

The stored signature is the same shape in both formats, a base64url string. It carries no prefix and no marker; which format it is in is found by
verifying it (section 3).

## 2. The messages

Canonical JSON (the same canonical form the ledger already uses for entries and receipts), UTF-8, then signed with Ed25519 by the domain key:

```
genesis signature:   {"coinId":"<32 hex>","digest":"<64 hex>","domain":"<signer domain>","type":"atlas.ledger.genesis.signature","v":1}
entry authority:     {"coinId":"<32 hex>","domain":"<authority domain>","hash":"<64 hex>","index":<n>,"type":"atlas.ledger.entry.authority","v":1}
```

A message of one type cannot verify as the other, and a message for coin X, index n or domain D does not verify for any other coin, index or domain.
Format 1 remains: the signature over the bare 64 character lowercase hex string.

## 3. Verifying: both formats, in order, never loosely

A verifier tries format 2 first, then format 1. Format 1 is tried only when the thing signed is exactly 64 lowercase hex characters, so a typed
message is never mistaken for a legacy one. A verifier reports which format matched (`v2` or `legacy`) or fails. Both formats are valid
indefinitely for **historical** records: there is no calendar sunset, and an old genesis signature, entry or receipt stays verifiable. What
changes is which format is still acceptable **next** (section 4).

## 4. The ratchet: format 1 may not come after format 2

Derived from the chain itself, so it cannot be argued with and survives copying or replaying a history:

- An entry's authority signature may be in format 1 only if the previous entry's authority signature is not in format 2. Once a coin has a
  verified format 2 authority signature, a later format 1 authority signature is refused (`signature-downgrade`).
- A genesis signature may be in format 1 only if entry 0's authority signature is in format 1. A coin whose entry 0 is in format 2 needs format 2 genesis signatures.
- A coin with a format 2 genesis from the start therefore needs format 2 signatures throughout, and a coin that began in format 1 moves to format 2
  at some entry and stays there.

The same rule is applied everywhere an entry is taken in: `ledger_commit`, a partner mirroring an entry, the journal replay, `ledger_check`
(`spend34/integrity`), a receipt checked on its own (it names the previous hash and the authority, so the previous authority signature and the first
format 2 index are known to the checker), the scanner's `verifyChain` (which reports the index where format 2 began) and the wallet (which keeps
`v2From` per coin, the lowest index it has seen verified in format 2, and then refuses a legacy signature at or after it). A single receipt
therefore cannot be used to step a verifier back to format 1. Evidence exchanged between domains (`peer_check_entry`, a compare) accepts either
format, since evidence describes history; it is the commit and mirror paths that enforce the ratchet.

## 5. Activation is a domain decision that is written down outside the database

A domain signs in format 2 when **either** its activation record says so **or** the previous entry of the coin it is signing for is already in
format 2. The second condition is the ratchet and needs no state. The first is the one-way switch, and it must survive someone putting an older
`chain34.sqlite` back, which would erase an in-database flag and the first format 2 entry together. So the switch lives in two places, and the one
outside the database is the one that counts:

- `<database path>.checkpoints/signature-format.log`: a hash chained, fsynced line `{"v":1,"kind":"activate","format":2,"domain":"<this domain>","at":<time>}`,
  written with the same append routine as the rollback checkpoints (`chain-labs/lib/checkpoint.php`, see `docs/chain-labs-rollback-protection.md`). It is
  written and fsynced **before** the domain signs anything in format 2.
- a table `ledger_sig_format` in the database (`format`, `domain`, `activated_at`), written after, for readers of the database.

State is read from both and compared:

| File line | Database row | State |
| --- | --- | --- |
| yes | yes | active |
| yes | no | active (a database put back from before activation) |
| no | yes | **unavailable** (the file was removed or replaced) |
| no | no | legacy, unless a coin of this domain already has a format 2 authority signature at its head, then **unavailable** |
| damaged, unknown line, wrong domain, or lines that disagree | any | **unavailable** |

When the state is unavailable the domain **refuses to sign anything new**. The refusal is `signature-format-unavailable` (HTTP 503), is made before
a proposal is queued, and never falls back to legacy. Reading and verifying keep working. An operator repairs it with the activation action and
`recover: true` after looking at the file (section 6): the damaged file is kept beside it as `signature-format.log.damaged-<time>` and a fresh record
is written. A write cut short by a crash (no final newline) is read as "not activated" and cleared before the next activation attempt, so an
interrupted activation either did not happen or is completed by running the action again.

A domain that has activated never commits a format 1 authority signature again (`signature-downgrade`), and after activation signs genesis
signatures for coins other domains propose in format 2 whatever the request asked for. A domain that has not activated signs a genesis in format 2 only when the
proposing authority asks for it (`sig: 2` in the request body), so a partner can be upgraded and verify before it ever signs differently by default.

## 6. Operator actions

Both are signed-only actions (the operator token is refused with `signature-required`), listed in `OPERATOR_ACTIONS` and `OPERATOR_SIGNED_ONLY` in
`chain-labs/lib/operator.php`, and named in a key's `actions` list like any other.

`spend34/sigformat-status` (reading) returns the domain's state and, when it is not yet active, the readiness of the other domains:

```
{ "ok": true,
  "sigformat": { "state": "legacy" | "active" | "unavailable", "reason": "...", "domain": "...", "activatedAt": "<ISO time>" | null,
                 "record": { "file": bool, "database": bool } },
  "readiness": null | { "ready": bool,
                        "partners": { "<domain>": { "ok": bool, "reason": "...", "coins": [ "<coinId>", ... ] } },
                        "pendingWithOlderSignatures": [ "<coinId>", ... ] } }
```

`readiness` is `null` once the domain is active.

`spend34/sigformat-activate` (changing) takes `{ "confirm": true }` and, only when needed, `recover: true` and `discardPendingSignatures: true`. It
refuses without `confirm` (`confirm-needed`, 400), and refuses with `not-ready` (409, with the readiness in the answer) unless readiness holds. A
second call changes nothing and says `already: true`.

`tools/chainlabs-operator.js call spend34/sigformat-status --json '{}'` and `call spend34/sigformat-activate --json '{"confirm":true}'` use them. The
scoped key rules apply: a key limited to other actions cannot take either, and `grant-actions` can add the reading action without the changing one.

## 7. Readiness: a partner proves it can verify format 2

Another domain's published version number proves nothing, so activation asks each partner a question that only a domain that verifies format 2 can
answer, and that cannot be answered ahead of time or replayed.

For every multi authority coin of this domain, every other domain on the roster is sent a peer request `sigformat` carrying a fresh random challenge,
a throwaway public key and a shuffled set of samples: valid and invalid format 2 and format 1 signatures, cross-purpose signatures, wrong index, wrong
hash, a genesis in format 2 and one for the wrong purpose, and pairs that the ratchet must accept or refuse. The partner answers with a verdict for
each sample inside a payload `atlas.ledger.capability` (`v: 1`: domain, `to`, challenge, formats, `issuedAt`, results) signed with its **domain key**.
The requester accepts it only if all of these hold: the signature verifies against the key pinned for that partner; the fields are exactly the expected
ones; `domain`, `to` and the challenge are the ones just sent; `issuedAt` is within the peer age limit (`PEER_MAX_AGE_SECONDS`, 120 seconds); and **every verdict equals what the requester
computed** for the sample. A partner that does not know the action answers as an old version does, which counts as "not upgraded". Readiness also
requires that no coin of this domain still waiting for signatures (state `pending`) already holds a format 1 genesis signature, because such a coin
would open with an invalid mixture. `discardPendingSignatures: true` forgets those signatures so they are asked for again, in format 2.

A domain with no multi authority coin has no partners to wait for, and its readiness is simply ready.

## 8. What activation does to coins that already exist

- Single authority coin: new entries are in format 2 from the next commit. Old entries are untouched.
- Multi authority coin, authority side: the next entry is in format 2. Partners mirror it and verify it; a partner that cannot is the failure that readiness is meant to prevent.
- A coin whose genesis signatures are in format 1 keeps them. They are verified as legacy because entry 0 is legacy.
- A coin opened after activation: the authority asks every partner for a format 2 genesis signature (`sig: 2`), refuses a partner's format 1 answer
  (`partner-needs-upgrade`), re-asks a partner whose stored signature is in format 1, and entry 0 is in format 2.
- A partner that has activated while the authority has not: the partner signs genesis in format 2 whatever asked; it mirrors format 1 entries as before.

## 9. Rollout order. Verifier first

1. Release this change to **every** domain, **including the new file `chain-labs/lib/sigformat.php`** (a missing file is a fatal error, not a
   fallback), the scanner (`scan35.html` and `scan35.php`), and the wallet extension. Nothing signs differently yet.
2. Let it run. `sigformat-status` on each domain should show `legacy` and a ready readiness for coins with partners.
3. Activate the **partners** first, then each **authority**, one explicit operator action per domain, only when readiness is `ready`. The action is
   never taken automatically and no deployment script should do it.
4. Wallets older than this change cannot verify a format 2 receipt. Roll the wallet extension out before the first activation on a domain whose coins
   they use.

## 10. After activation: forward, not back

Once a domain has signed in format 2, putting **pre-change code** back is unsupported: it cannot verify the entries, and it would refuse the coin or
accept a legacy signature the ratchet forbids. A problem found after activation is fixed by moving to compatible code, not by reverting. Rolling
back the **database** is a different thing and is still covered by `docs/chain-labs-rollback-protection.md`; the activation record is outside it.

## 11. What this does not do

- An operator who can put back **both** the database and the whole `.checkpoints` folder from before activation undoes the activation. This is the
  same limit as the rollback checkpoints themselves.
- A wallet remembers `v2From` per coin inside its genesis pin, and keeps a bounded number of pins per domain. A pin dropped for being old takes its
  `v2From` with it; the next verified chain read or receipt on that coin learns it again, and until then a single format 1 receipt on that coin would be
  accepted as historical.
- `sig-seal` (an explicit per-coin seal of the first format 2 index) is not part of this change. The ratchet and the activation record are what is enforced.
- Old data is never rewritten. Format 1 signatures already in ledgers, journals, receipts and mirrors stay as they are.

## 12. Checks

```
php test/chain-labs-sigformat.php             # the messages, both formats, the ratchet, mixtures, mirrors, journal, receipts, partner genesis
php test/chain-labs-sigformat-activation.php  # activation record, database put back across activation, interrupted activation, damaged record,
                                              # readiness probe (forged, replayed, stale, wrong key, wrong verdict), pending coins, mixed versions
node test/chain-labs-sigformat-http.js        # the operator actions and the whole path on three live servers, scanner and wallet verifying what they sign
node test/chain-labs-wallet-verify.js         # the wallet in both formats, v2From, a legacy receipt after format 2
node test/chain-labs-scan-http.js             # the scanner's verifier in both formats and at the point of change
```
