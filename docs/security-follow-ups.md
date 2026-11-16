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

Fixed after the audit: a site bound to an identity that was later removed (or exported away) used to be answered
by the main identity without a prompt once no sub-identity was left. The binding is now kept as a marker
(`writeSubIdentityVault` only drops unreadable entries), and `getSiteIdentity` answers `ask` for it, in the
remembered vault and in the session-only store, whether one identity or the last one was removed. The site gets a
key only after an explicit choice, which replaces the marker. No stored data is migrated. Sites that never had a
binding keep the normal single-identity answer. Regression test: `test/manual-site-identity-removal.js`.

- Markers are not listed among remembered sites and cannot be forgotten from the list; they count toward the
  500-site limit and are dropped first when the table is full. Choosing an identity for the site replaces one.
- A full backup carries the marker (`siteIdentities`) and a restore keeps it, so a restored wallet still asks.
  Chrome sync merges (`mirrorSubIdentityVaultToSync`) do not carry markers for identities the receiving device
  lacks; that device treats the site as it did before.
- A session-only choice leaves no trace after locking, by design, so once the wallet is locked a site whose
  session-only identity was removed is treated as a site with no binding.
- A marker names the removed identity's public key. If that identity is restored (backup or import), the site is
  bound to it again.
- Bindings already dropped by earlier versions cannot be recovered, so those sites behave as they did.

Observations, not exploitable by a page, left as they are:

- The bridge denial cooldown lives in the service worker's memory and resets when the worker restarts. Prompts per
  origin are bounded by `BRIDGE_CONFIRM_MAX_PENDING`, so the effect is a few extra prompts, not a bypass.
- For a site that has no binding in a wallet that has sub-identities the overlay follows the wallet window's
  selected identity until the person chooses. The page itself cannot see or steer this.

The overlay frame item below still applies to the signing prompt.

## Overlay frame

See "Not covered" in `bridge-prompt-window.md`.

## Services tab: what remains

Described in `docs/services.md`. Open items:

- **Join has no proof of key ownership.** Joining Global Mail or Trading Station from the Services tab uses the same
  request as the Join buttons in a world: `POST /atlas/asset/issue` with the identity's public key and no signature
  proving the requester holds the matching private key. The tab does not widen this (it asks first, names the identity,
  and issues only to the identity the wallet is acting as), but anyone can ask an issuer to issue a membership card to
  any public key. A fix is an issuer protocol change: require a signed challenge from the owner key on
  `/atlas/asset/issue` for membership classes.
- **A manifest that names a key twice.** Confirmed on one of the two live domains that were read (through a summarising
  fetch, so not byte exact): `walletBridge` appears twice at the top level. The first copy has `read`, `sign` with one
  purpose and an `offer` list; the second has two sign purposes and no `offer`. Most JSON parsers (and the wallet) keep the
  last, so the offer is dropped. The other domain has no repeated key. The wallet shows a warning when such a domain is
  added; the domain should remove the duplicate. The service addresses on both are absolute and on their own domain; the
  relative paths in the manifests are world scene addresses.
- **Relative service addresses.** Some manifests could give a service address as a path (`/mail/`). The Services tab resolves a
  path against the domain it was fetched from and refuses anything on another host, scheme or port. `SPEC.md` §3.9 does not
  say a path is allowed; it should.
- **Switching Global Mail off pauses more than mail.** The background check presents one request per issuer domain, and
  update notices, chat, friend mail and call cards ride the same request. With the Global Mail credential left out, those wait
  for that domain until the service is switched on again. Other credentials held at the domain are still presented. The
  settings page now says so; the API cannot separate them.
- **Unreadable saved state fails open for the mail check.** If the Services state cannot be read, the check behaves as it
  did before the tab existed, so a storage fault does not silence mail. Removing a domain from the list also removes its
  switched-off choice, so checks resume; the confirmation says so.
- **A discovered manifest is only trusted for what it says about itself.** A domain's advertisement says what it offers,
  never what the wallet does; an address on another host is dropped. A manifest cannot enable a service, register the
  person or choose an identity.
