# Security follow-ups

Findings from the security review that are recorded but not fixed yet. Each says what the risk is, where it is,
and what is known about the fix. Done items are in the commit history, not here.

## Residual limit of the trade refund

`refund_failed_second_leg()` / `refundFailedSecondLeg()` now refuse a refund when the poster's credit is already
spent, split, consolidated, transferred or revoked, and the check is made again in the same step as the
revocation. What a trusted peer can still do is report a definite failure for a leg whose second half did in fact
settle, while the poster's credit is still unspent. The issuer then revokes that credit and pays the claimant, which
is value-neutral at the refunding issuer (one credit out, one in) but takes the poster's side of a completed trade.
Trusted trade peers are operator-configured; removing the peer is the remedy. Closing it needs the poster's issuer
to attest that its own second leg did not settle, which is a protocol change.

## Shared outbound lookup rate budget

Reported in the review and not yet reproduced or fixed. The outbound request budgets (`ATLAS_OUTBOUND_RATE`,
`_ALL`, `_KEY_RATE`, `_KEY_RATE_ALL`) are shared by every lookup a request triggers, so a caller that triggers many
distinct lookups may use up what other callers need (peer key fetches, trade relays, directory lookups). Next step:
reproduce it with a test that exhausts the budget from one caller and measures another, then reserve a share per
purpose so one purpose cannot starve the others, keeping the global cap.

## Drop intents without expiry

Reported in the review and not yet reproduced or fixed. Trade intents are refused once their `expiresAt` has
passed (`issuer-server/server.js`, the trade submit and claim handlers); a drop intent without an `expiresAt`
would stay valid until the drop is consumed. Next step: confirm which drop paths accept an intent with no expiry,
then require an `expiresAt` within a bounded window, with a compatibility period for existing wallets.

## Wallet `baseUrl()` accepts URL-shaped domain strings

`baseUrl(domain)` in `extension/wallet.js` returns the string unchanged (minus a trailing slash) when it merely
starts with `http`, and otherwise prefixes a scheme without validating the rest. A manifest or credential naming a
domain such as `https://host/path`, `http@host` or `httpevil.example` therefore steers wallet requests to a URL the
person never saw as a domain. Next step: accept only a bare host with an optional port, validated once, reject
everything else before any request, and keep the localhost `http` exception.

## Per-site identity feature

`getSiteIdentity` / `setSiteIdentity` (per-origin identity binding, the first-contact prompt, "remember", the locked
states) has had no focused review since it was added. The audit should cover: how the origin is derived and
compared (sender origin vs page-supplied), what a binding survives (identity removal, export, lock, import), the
`ask` and `denied` states and the 30 s decline window, whether any bridge action can be answered with another
identity's key, storage format and migration, and the interaction with trusted offer domains.

## Overlay frame

See "Not covered" in `bridge-prompt-window.md`.
