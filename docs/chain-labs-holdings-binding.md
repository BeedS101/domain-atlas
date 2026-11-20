# Chain labs: holdings statements tied to the request that asked for them

## What went wrong

A holdings statement (`atlas.ledger.holdings`, v1) was signed by the domain but said nothing about the request it answered. A wallet
accepts a statement up to 300 seconds old, so anyone able to answer in place of the domain, or to replay a captured answer, could
make the wallet show a balance from before a transfer, and a wallet that read the stale account as "where it stood when the
transfer was signed" could settle a transfer as not made when it had been. A domain's challenge protected the request on the way in
(`docs/chain-labs-challenges.md`) but not the answer on the way back.

## The message (v2)

Every lookup carries a `nonce`: 32 lowercase hex characters, 128 random bits, in the body next to `key` (and `request`).

- A lookup signed by the key (private coins) uses its challenge as the nonce, so the nonce is already covered by the key's signature
  over the request and is single use.
- A public lookup uses a fresh random nonce chosen by the wallet for that lookup.

The domain answers with a v2 statement, which is the v1 statement with `v: 2` and `nonce` added, signed by the domain as before:

    { type: 'atlas.ledger.holdings', v: 2, domain, key, nonce, asOf, proven, coins }

The nonce is inside the signed text. A copy captured for one lookup does not verify for another.

## What the domain checks

1. The key is a wallet key (as before).
2. A nonce, when present, is 32 lowercase hex characters, else `bad-nonce` (400).
3. A signed lookup's nonce equals its challenge, else `nonce-mismatch` (400). This is checked before the challenge is used, so a
   refused lookup does not use the challenge up.
4. Everything else is as before: the request's fields, the key's signature, then the challenge (issued by this domain, fresh, not used).

A lookup with no nonce is answered in v1 until 1 February 2027 00:00 UTC and refused from then as `nonce-required` (400).

## What the wallet checks

A v2 statement is accepted only when its fields are exactly the v2 fields, its nonce is the one the wallet sent, it names this domain
and key, `proven` is what the wallet asked for, the signature verifies against the pinned domain key and it is no older than 300
seconds. A v1 statement is accepted only when all of the following hold:

- its signature verifies and it has exactly the v1 fields;
- the domain has not answered with a v2 statement before;
- it is before 1 February 2027 00:00 UTC on the wallet's clock.

Otherwise it is refused: `downgrade` for a domain that answered in v2 before, `legacy-ended` after the date. Any other failure of a
domain that answered in v2 before (no answer, an HTTP error, text that is not JSON, a statement with fields missing) is also a refused
lookup. The wallet never falls back to a v1 reading for such a domain.

## What the wallet remembers

The first v2 statement a domain returns is recorded in that domain's record as `holdings: { v: 2, since }`. It is part of the list of
domains, so it is in the wallet backup, and is kept when the genesis pins and kept heads change. Nothing removes it except removing the
domain from the list. A wallet restored from a backup made before the mark was recorded reads the domain as not yet known to answer in
v2 and records the mark again on the next v2 answer; until then only the date limit applies.

A domain whose last verified answer was v1 (and that has no mark) shows a short note on its card in the Ledger tab, naming the date. The
note goes when the domain returns a verified v2 statement.

## A transfer with no answer

A transfer whose request got no answer is settled as "not made" only when the domain says it has no record of it, the signed
authorization has lapsed and a fresh statement shows the sender's account where it stood when the transfer was signed. A v1 statement
is not tied to the request, so it can no longer be that evidence: while a domain answers in v1 the transfer stays as unknown, with
the reason shown, and is settled when the domain answers in v2 or a receipt or proposal answer settles it.

## Rollout

1. Deploy the updated server files (`chain-labs/spend34.php`, `chain-labs/lib/spend.php`, and `chain-labs/SOURCE.sha256`) to every
   domain that hosts a chain labs ledger. An earlier wallet keeps working: it sends no nonce and receives v1.
2. Update the browser wallet. It sends a nonce; an updated server answers in v2, a server not yet updated ignores the nonce and
   answers in v1, which the wallet still reads, with the note on the card.
3. Before 1 February 2027 every server must be on the updated files. From that date the servers refuse lookups with no nonce and the
   wallet refuses v1 from any domain.
4. After the date, a later change removes the v1 code from both sides.

## If a server goes back to an older version

The wallet refuses the domain's answers (`downgrade`) and tells the person why. It does not reset anything: the genesis pins, kept
heads and the mark all stay. The domain's operator redeploys the current server files, and the next lookup works. Removing and
re-adding the domain is not needed and would discard the wallet's protection.

## Checks

    php test/chain-labs-spend.php
    node test/chain-labs-holdings-binding.js
    node test/chain-labs-spend-http.js
    node test/chain-labs-challenge-http.js
    xvfb-run -a node test/manual-chain-labs-tab.js   # includes the backup and restore of the mark
