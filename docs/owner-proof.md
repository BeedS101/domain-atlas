# Signed membership issuance (owner proof)

Joining a membership service (`atlas.membership`, `atlas.postoffice.membership`, `atlas.tradingstation.membership`) asks the
issuer to issue a card to a public key. Without a proof, anyone can ask for a card for a key they do not hold. With it, the
wallet signs one exact request with the key the card is for, and the issuer checks it before it issues anything. The wire
format is `SPEC.md` §5.13; this page is for whoever runs an issuer.

## What a person sees

Nothing new. Join is still one click and existing cards are untouched. The wallet signs in the background with the identity
it is acting as (a passkey identity asks for its passkey, as it does for a transfer). A wallet that predates the check, joining
at an issuer that requires it, shows: "This domain requires a newer version of Domain Atlas Wallet to join this service. Please
update your wallet and try again."

## Modes

| Mode | A request with a signed intent | A request without one |
| --- | --- | --- |
| `off` | not checked; the issuer looks like one that predates the check | served |
| `accept` (default) | checked; a bad one is refused | served, counted as unsigned |
| `require` | checked; a bad one is refused | refused: `403 owner-authorization-required`, `updateWallet: true` |

`accept` is a temporary compatibility mode, not a completed fix: while an issuer is in it, anyone can still ask for a card for
a key they do not hold. Move each issuer to `require` once it is ready (below). A bad signature is refused in every mode
except `off`.

Refusal codes: `owner-authorization-required` (missing or malformed intent, or it does not authorize exactly this request),
`owner-signature-invalid`, `not-owner` (signed by a key other than the recipient), `request-id-required` (400),
`stale-request` (401, carries `serverTime`; the request is more than two minutes from the issuer's clock). Every refusal is
decided before a request id is leased, a card is minted, a roster row is written or mail is sent.

A repeat of a request the issuer already completed is answered from the stored result without a time check, so a join whose
answer was lost is recovered with the same signed bytes however long it took.

## Setting the mode

- Node issuer: environment variable `ATLAS_OWNER_PROOF=off|accept|require`. Unset means `accept`; an unknown value falls back
  to `accept` and says so in the log. The startup log states the mode.
- PHP issuer: the same environment variable where the host allows one; otherwise `lib/atlas-owner-proof-config.json` containing
  `{"mode": "require"}`. Unset means `accept`.

The mode is advertised in `GET /atlas/capabilities` as `ownerProof`, which is how a wallet knows to sign. The PHP issuer lists
`ownerProof` only when `atlas/asset/issue.php` contains the check and `lib/owner-proof.php` is present, so a half-uploaded bundle
never claims a check it does not run.

## PHP upload

Upload together: `atlas/asset/issue.php`, `atlas/capabilities.php`, `lib/owner-proof.php` and `lib/webauthn.php`. The first
three are the check; the last accepts passkey assertions made by the wallet extension itself (see below).

## When is an issuer ready for `require`?

Each issuer keeps a small count of outcomes per class (signed, unsigned, refused, and the last time of each; no keys,
credentials or request ids):

- Node: `atlas-owner-proof-stats-store.json` in the state folder.
- PHP: `owner-proof/stats.json` in the issuer's private folder (the folder named in `lib/atlas-private-dir.txt`, or `lib/`).

```
node tools/owner-proof-readiness.js <stats file or state folder> [--days 7] [--json]
```

States: `ready` (signed issuances seen, nothing unsigned within the window), `not-ready` (an unsigned request arrived within the
window, so a wallet in use would be turned away), `no-signed-yet` (no signed issuance seen, so the signed path is not yet proven
on this deployment), `enforcing`, `off`. Exit code 0 for ready or enforcing, 1 otherwise, 2 if the file cannot be read.

Suggested order: deploy the issuer update in `accept`, deploy the wallet update, join once at each class from the new wallet,
read the report, then switch that issuer to `require` and read it again.

## Passkey identities

An assertion made by a page of the wallet extension carries a relying-party hash of the extension's own origin, not of a host name.
The issuers' passkey check (`issuer-server/lib-webauthn.js`, `issuer-php/lib/webauthn.php`) now also accepts that form for an extension
origin, and still refuses another extension's origin and the extension form for a web origin. Without this update a passkey
identity's signature is refused as `owner-signature-invalid`. It is a separate change from the owner proof.

## Tests

- `node test/manual-owner-proof-vectors.js` — 79 shared cases run through the Node module, the PHP module and the wallet's core.
- `node test/manual-owner-proof-issuers.js` — live Node and PHP issuers in every mode: bad signatures, replay, concurrency, stale
  and future time, cross-domain and cross-implementation, and no credential, roster row or mail left by a refusal.
- `xvfb-run -a node test/manual-owner-proof-wallet.js` — the real extension against local issuers, including a wrong clock, a lost
  answer and a passkey identity.
