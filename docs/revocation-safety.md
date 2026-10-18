# Revocation safety in the wallet

The wallet decides whether a credential is revoked from two documents the issuing domain publishes
under `/.well-known/`: `atlas-key.json` (who may sign, and when) and `atlas-revocations.json` (what
the issuer has withdrawn). Not being able to read the revocation list is not the same as the
credential not being on it. Before this change two checks in `extension/wallet.js` turned a failed
fetch into an empty list; a revoked or already-spent credential then looked good whenever the list
could not be had.

This describes how the wallet reads those documents now, what it reports, and what it does with that.

## Three outcomes

`verifyCredential()` (asset credentials) and `verifyLedgerCredential()` (ledger-account references)
return the same fields:

| Field | Values |
|---|---|
| `valid` | `true` only when `status` is `verified`. Every existing caller already tests this. |
| `status` | `verified`, `revoked`, `expired`, `invalid` (signature or key), or `unavailable` |
| `revocation` | `not-revoked`, `revoked`, `unavailable`, or `null` when the check stopped earlier |
| `reason` | text for the person; an unavailable check always begins `not verified:` |

`unavailable` means the issuer's key document or revocation list could not be read, so nothing is
claimed either way. It is not a success, and it is not a finding against the credential, so it is
never reported as "invalid" or "revoked" and never as "verified". The Wallet tab shows it with a
warning mark and its own colour instead of the green tick or the red cross.

A definite finding is still reported as such when the revocation list cannot be read: a signature
that does not match, a key not valid at `issuedAt`, and a signed `expiresAt` that has passed are
reported as `invalid` and `expired`. A credential that is on a list that was read is `revoked`
whichever other document is missing.

## How the documents are read

One reader (`readPublishedDoc`) serves asset credentials, ledger-account references and the Labs 38
signed-receipt check:

- from the issuing domain's own origin; no redirects, no credentials, no referrer, no cache;
- limits counted in bytes after decoding and enforced while the body streams in: **256 KiB** for the key
  document and **4 MiB** for the revocation list; an honest `Content-Length` over the limit is refused
  before the body is read; nothing past the limit is held in memory;
- at most **20,000 entries** examined in a revocation list, in one pass;
- 20 seconds for a document (headers and body together); a domain that goes quiet, or stops part-way,
  is unavailable after that. (The signed-receipt check passes its own fetch, which carries the person's
  cancel button instead.)

The following are all "unavailable", never an empty list: a network error, a dropped connection,
a timeout, an HTTP status other than 200 (a 404 only for the classes named below), a redirect,
a body over its limit, a body that is not valid UTF-8, text that is not JSON, a document that is not an
object, a revocation document with no `revoked` list or one that is not a list, a list over the entry
limit, and any entry that is not an object with a string `id` (it could be a revocation the wallet
cannot interpret). A key document without a `keys` list is unavailable; a readable one that lists no
suitable key is `invalid`.

The 4 MiB limit leaves room for roughly three times the size of the live list (about 6,100 entries,
1.1 MB). The options for a list that outgrows it are in `docs/ledger-accounts.md`, "Size limits for the
published documents".

## Does a missing revocation list mean "nothing revoked"?

Decided class by class, not generalised:

| Class | A 404 on the revocation list | Why |
|---|---|---|
| Asset credentials (Gold and every other class, gifts, offers, transfer files, saved copies) | **Unavailable** | SPEC.md §5.3 has an issuer publish the list alongside its key, and both reference issuers create it on first use. Every spend is "check, then sign or mint, then revoke", so a spent credential is exactly what a missing list would let through. Many different domains issue these, so a missing list is more likely a fault than a choice. |
| Ledger-account references | Counts as empty, **and the verdict says so** (`the issuer publishes no revocation list`) | This is the rule `docs/ledger-accounts.md` has always stated for the ledger classes. The wallet only looks up balances for them at the Labs hosts, they carry no value of their own, and the ledger and the issuer both refuse a revoked account when it is used. Kept for compatibility, not as a precedent; `LEDGER_ABSENT_REVOCATIONS_IS_EMPTY` in `wallet.js` turns it off. |
| Signed ledger receipts (Labs 38) | Counts as empty (as above) | Same class and the same documented rule. |
| Key document (any class) | **Unavailable** | There is no meaningful "no key document". |

Every other failure to read the list is unavailable for all classes.

## What each caller does with an unavailable verdict

The wallet never uses a stored verdict as permission to spend: spends are authorised by the issuer's
own check when the credential is presented to it. The verdict is used to decide whether to take a
credential in, what to tell the person, and, in two places, to decide something irreversible.

| Caller | Unavailable verdict |
|---|---|
| Credentials just handed back by an issuer (mint, split, merge, purchase, trade settlement, pick-up) | Kept and tagged `unavailable`. The issuer has already spent the old credentials, so refusing the new ones would lose the person's property. |
| Wallet import | Kept and tagged `unavailable`; **Re-verify wallet** replaces the tag. |
| Re-verify, and the check after an issuer-reported revocation | The credential is kept; the tag becomes `unavailable` (never `verified`). |
| Restore a saved copy; gift claim; offer claim | Refused, in words about the check ("could not be checked ... try again later"), not as "no longer valid". Nothing is added. |
| Opening a transfer file (claim screen) | Shown as `unreachable` with the reason; neither claim nor restore is offered. Previously matched on the reason text. |
| Recovering an interrupted export | **Was:** a failed read counted as "not revoked", so the item could be reported as safe. **Now:** answered `waiting`; the record is untouched, and it is only called `lost` when the original is actually found revoked. |
| Adopting a superseding credential from a mail check | Not adopted; the held credential stays as it is. |
| Adding a ledger-account reference ("Check and add", opening an account, looking for accounts) | Not added; the new problem `revocation-unavailable` says the issuer's documents could not be read and nothing was changed. |
| PvP demo transfer to the counterparty test identity | Unchanged: it copies the sender's stored verdict and does not verify. |

## Compatibility

- A domain whose revocation list is missing, unreadable or malformed now yields `unavailable` for its
  asset credentials instead of `valid`. Both reference issuers always publish it, so nothing from
  them changes; a third-party issuer that does not publish one will no longer verify until it does.
- A revocation list with an entry the wallet cannot read (not an object, or without a string `id`)
  used to be tolerated; it is now unavailable. The reference issuers only write `{id, revokedAt, reason}`.
- A revocation list over 4 MiB or 20,000 entries is unavailable. The key document's 256 KiB limit is unchanged.
- Credentials stored before this change have no `status`; the Wallet tab shows them as before.
- `verifyCredential()` results gain `status` and `revocation`; `valid` and `reason` keep their meaning
  and, for revoked credentials, their text (`revoked by issuer`).

## Not covered by this change

These read the same lists but are not wallet code and were left alone:

- `issuer-server/server.js` `verifyForeignAssetCredential()` and `issuer-php/lib/bootstrap.php`
  `verify_foreign_asset_credential()` treat a missing, unreachable or unreadable revocation (and
  suspension) document of another domain as empty, by design ("fail-open"). They authorise
  cross-domain trades and purchases on the issuer's side.
- About ten demo pages under `demo-domain-a/` fetch the list with `.catch(() => ({ revoked: [] }))`.
- The call service (`call-server/server.js`) fails closed but caps the list at 1 MiB, which a list of
  the live size would exceed.
- The wallet does not consult the suspension documents.

## Tests

- `xvfb-run -a node test/manual-revocation-safety.js`: a real Chromium with the extension against local
  issuers. A realistic 6,127-entry list (`test/revocation-fixture.js`, 1.07 MiB, in the PHP issuer's layout),
  accepted when it does not name the credential and refused wherever it does; 28 ways a revocation list can
  fail to be read, each unavailable; both limits at and one past their edges; the key document's own
  limit; definite findings that outrank an unreadable list; a domain that goes quiet; the callers above
  (import, re-verify, restore, transfer file, interrupted export); and ledger-account references including the
  documented 404 exception.
- `test/manual-ledger-labs38-wallet.js` and `test/manual-ledger-labs38-adapter.js` still cover the
  signed-receipt check, which now reads the documents through the same reader.
