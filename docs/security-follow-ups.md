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

## Wallet domain references: what remains

Wallet-facing issuer, ledger and service domains now go through one validator (`parseDomainReference` /
`baseUrl` in `extension/wallet.js`; tests in `test/wallet-domain-validation.js`). A domain is a bare host with an
optional port: public names use `https`, loopback (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`) and hosts
approved with `approveDevelopmentHost()` use `http`. Schemes, paths, credentials, query strings, fragments,
whitespace, backslashes, percent escapes, non-ASCII hosts, numeric shorthand IPs, private/reserved IP literals and
single-label names are refused before any request. Interfaces that take a complete URL (manifest and scene URLs,
`portal.manifest`, the presence and call service URLs, published-document fetches) are separate and unchanged.

Behaviour that differs from before for saved references: a trailing slash is no longer accepted, the host is
lower-cased, and a private IP literal, single-label name or a loopback address other than `127.0.0.1` needs
`approveDevelopmentHost()`. Saved `localhost:port`, `127.0.0.1:port` and public host references keep their meaning.

- Approved development hosts are stored in `chrome.storage.local` (`atlasDevHosts`) and managed through
  `getDevelopmentHosts` / `approveDevelopmentHost` / `removeDevelopmentHost`. There is no UI for them yet.
- Theoretical: the wallet's `fetch` calls follow redirects, so a valid domain that is under an attacker's control
  can answer with a redirect to another host. The response is still checked against signatures and keys, but the
  request itself reaches the redirect target. Fix would be `redirect: 'error'` on issuer calls, as
  `publishedDocFetch` already does; deferred because some deployments redirect `http` to `https` or add `www`.

## Per-site identity: audit results

Audited: `getSiteIdentity`, `setSiteIdentity`, origin derivation (`page-bridge.js` → `content.js` → `background.js`
→ `confirm-bridge.js`), the ask / remember / denied / locked states, binding persistence, backup and sync restore,
identity removal and switching, trusted asset offers and the extension-controlled signing popup. Regression
test: `test/manual-site-identity-audit.js` (three origins, two remembered identities, a hostile page).

Confirmed vulnerabilities: none. A page cannot obtain another origin's identity or a signature from an identity
that was not authorized for its own origin:

- The origin comes from Chrome's `sender.origin` / `sender.url` in `background.js` (top frame only), never from the
  page's message. A forged bridge message naming another site, and forged `origin`, `ctx`, `publicKey` or
  `identity` fields in a signing payload, are answered with the requesting site's own identity; the signed envelope
  carries the real origin and the page's claims stay inside its own payload.
- `getSiteIdentity` / `setSiteIdentity` accept only an exact `http(s)` origin (no path, query, userinfo, `null`,
  `file:` or extension origins).
- A site with no binding is `ask` and receives no key until the person chooses; declining gives it nothing and
  starts the 30 s decline window with no new prompt. A locked wallet answers nothing and shows a locked prompt with
  nothing to approve.
- Switching the wallet window's identity does not change what any site is answered with.
- A frame cannot use another page's bridge; only top frames get a bridge at all.

Observations, not exploitable by a page, left as they are:

- Removing the last sub-identity returns the wallet to single-identity mode, so a site that was bound to it is
  then answered by the main identity without a prompt (`writeSubIdentityVault` drops bindings to removed
  identities, and `getSiteIdentity` answers `default` when no sub-identity exists). While another sub-identity
  remains, the site asks again. The option is to keep a "bound to a removed identity" marker so such a site always
  asks; it changes the single-identity behaviour and the stored binding format, so it needs a decision first.
- The bridge denial cooldown lives in the service worker's memory and resets when the worker restarts. Prompts per
  origin are bounded by `BRIDGE_CONFIRM_MAX_PENDING`, so the effect is a few extra prompts, not a bypass.
- For a site that has no binding in a wallet that has sub-identities the overlay follows the wallet window's
  selected identity until the person chooses. The page itself cannot see or steer this.

The overlay frame item below still applies to the signing prompt.

## Overlay frame

See "Not covered" in `bridge-prompt-window.md`.
