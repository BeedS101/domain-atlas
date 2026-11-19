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

Fixed, with limits that remain. Reproduced first (`test/security-outbound-isolation.js`, Node and PHP): a visitor
with no account can make an issuer look up another domain by presenting a credential that names it as its issuer
(`POST /atlas/world/drop` and the other endpoints that verify a foreign credential: one key lookup plus the
revocation and suspension lists, none of it cached). The budgets were two pools (`key`, and everything else), each
counted per remote domain and overall, and not tied to who caused the lookup. In the test one caller on its own:

- used the whole overall key budget with made-up domains, so a legitimate relayed claim from a federated domain
  the issuer had not seen recently was refused ("too many requests to other domains");
- used one peer's whole revocation budget, so another caller's credential from that peer could not be verified and a
  pick-up that had to be relayed to that peer never reached it.

What changed (`issuer-server/lib-outbound.js` `createRateLimiter`; `issuer-php/lib/outbound.php`
`atlas_outbound_rate_take`). The overall caps are unchanged, so total outbound traffic is bounded as before. Within them:

- Operations are classes with a reserved floor: `key`, and for everything else `verify` (a credential's revocation and
  suspension lists), `drop` (world-drop relays) and `relay` (trade, mail and other relays). Per-domain budgets are kept per
  class, and a class cannot take what would push another class below its floor (15% of the overall budget each).
- Callers are the socket address of the request that caused the lookup (never a forwarded-for header; hashed in PHP).
  A caller that has used a quarter of a budget cannot take the last 15% of it, overall or for one domain, which stays
  for callers that have not. Only attempts that were let through are remembered, so what is held is bounded by the
  overall budget and cannot be grown by changing identities, request fields or domains.
- Work this server starts itself has no caller and is never held to the share rule.

New settings, both optional: `ATLAS_OUTBOUND_RESERVE` (default `0.15`, range 0 to 0.3; `0` turns the sharing rules
off and leaves plain caps) and `ATLAS_OUTBOUND_FAIR_SHARE` (default `0.25`). A budget too small to have a whole reserved
slice (under 7) is unchanged, so the existing `_RATE`/`_KEY_RATE` settings keep their meaning; at the defaults one caller
can use at most about 85% of a budget (17 of 20 for one domain, 102 of 120 key lookups).

Remaining:

- The caller is the socket address. Behind a reverse proxy that does not pass the visitor's address on, every visitor
  shares the proxy's address and so one fair share: the per-caller rule then does nothing useful (it neither helps nor
  harms), while the budgets and each operation class's reserved floor still hold. Keep the defaults. Do not set
  `ATLAS_OUTBOUND_RESERVE=0` as a workaround: it also removes the class floors, so one kind of lookup could again use
  up the budget that credential checks depend on. Fix the address instead (for Apache, `mod_remoteip` with the proxy's
  address trusted, so `REMOTE_ADDR` is the visitor's). Site Doctor's "Visitor address handling" check shows whether
  visitors can be told apart.
- Several callers (several addresses) that each stay under their share can still use a whole budget together; the
  protection is against one caller, not a botnet. The overall caps still bound the traffic, and what stays guaranteed
  is each class's floor.
- Verifying a foreign credential still fetches the issuer's key without the peer-key memory (it needs the current key
  document alongside the revocation lists). Caching that fetch would cut the cost of the commonest legitimate case and
  is a separate change.
- Directory lookups live outside the issuer (`directory-php`) and were not part of this change.

## Drop intents without expiry

Fixed, with a compatibility period still to close. Reproduced first (`test/security-world-drop-expiry.js`, Node and
PHP): the owner's drop intent had no `expiresAt` and its `droppedAt` was signed but never read, so a hosting domain
accepted any intent however old, and an issuer settled a relayed claim for an intent signed years earlier.

What expires and what does not: the owner's signed intent is an authorization to *place* the credential, and it now
lapses (`expiresAt`, enforced by the hosting domain at `POST /atlas/world/drop`: at most two minutes past and fifteen
minutes ahead of its own clock; the wallet signs ten minutes). A drop the hosting domain accepted stays listed and
claimable indefinitely. To let the issuer judge the authorization without making accepted drops die, the hosting
domain adds `droppedAt` (the time it accepted the drop) to the attestation it signs, and the issuer requires the
intent to have been valid at that moment (`drop-intent-expired`, `drop-intent-expiry-required`,
`drop-intent-expiry-invalid`, `drop-time-invalid`). Changing `expiresAt` after signing fails the signature check.
Claim intents and same-domain claims are unchanged.

Compatibility: intents without `expiresAt` (older wallets) are accepted for drops accepted before
`ATLAS_DROP_LEGACY_UNTIL` (default `2027-03-31T00:00:00.000Z`), and a drop accepted before it stays claimable after it.
After it, a missing expiry is refused. A dated intent relayed by a hosting domain that sends no `droppedAt` is not
held to the window until that date either; afterwards the issuer judges it against the claim time.

Remaining:

- The cut-off date is a deployment decision: update hosts, issuers and the wallet first, and move the date if wallet
  rollout needs longer. Setting it to a past date enforces strictly at once.
- A hosting domain that predates `droppedAt` and is never updated cannot vouch for when it accepted a drop, so after
  the cut-off its cross-domain drops whose intent has lapsed are refused by an updated issuer. Update the hosts.
- The accepted-at time is the hosting domain's word, signed with its own key: a hosting domain that lies can back-date
  `droppedAt` to make a stale intent look valid. It could equally have fabricated a drop, which the owner's signed intent
  already limits to the credential, world, domain and drop id the owner named. `ATLAS_LEGACY_DROP_PEERS` (relays that
  omit both intents) is unchanged and remains an operator opt-in bypass.
- The wallet does not yet retry with the server's clock when a hosting domain answers `stale-request` for a drop; a
  device clock more than two minutes out surfaces as a failed drop with the server's message.

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

- **Join proof of key ownership: fixed in code, not yet enforced.** Joining a membership service now sends a request signed
  by the identity the card is for (`SPEC.md` §5.13, `docs/owner-proof.md`). Each issuer starts in `accept` mode, which still
  serves an unsigned request so wallets that have not updated keep working. That is a temporary compatibility mode, not the
  fix: until an issuer is switched to `require`, anyone can still ask it to issue a card to a key they do not hold. Switch
  each issuer once `node tools/owner-proof-readiness.js` reports it ready.
- **A manifest that names a key twice.** Found on one of the two live domains that were read: `walletBridge` appeared twice
  at the top level, the first copy with one sign purpose and an `offer` list, the second with two sign purposes and no
  `offer`. Most JSON parsers (and the wallet) keep the last, so the offer was dropped. The domain owner has since merged
  them into one entry (read, both sign purposes, the offer), checked again on 2026-11-16 with a cache-busting request
  (a plain request was still answered from a cache). The other domain never had a repeated key. The wallet still shows a
  warning when it adds any domain whose manifest repeats a top-level key, so a repeat is caught wherever it appears. The
  service addresses on both domains are absolute and on their own domain; the relative paths in the manifests are world
  scene addresses.
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
