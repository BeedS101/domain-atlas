# Services (wallet tab)

The Services sub-tab of the wallet's Inventory replaces the old Documents sub-tab (the Inventory tabs are Collectibles,
Ledger, Services). It lists only services that need a
membership card or another credential held in the wallet to operate: Global Mail, Trading Station and Domain Membership,
plus any service a domain declares with a card it needs. Services that need no card (Scanner, Directory, Asset Studio,
Calendar, Chain Labs, site chat and the like) are not listed; the directory and the domain's own pages show those. A
person adds the domains they use, joins and configures each card-based service on its own page, and switches it on or off
for the identity they are acting as. The flow is: add a domain, discover its card-based services, configure, use.

## Where things live

- `extension/services-core.js` holds the rules and has no browser dependencies (a UMD module, like the Ledger's
  `chain-labs-wallet.js`). It reads manifests, validates service addresses, keeps the saved state, resolves whether a
  service is on, and computes the status. It is loaded by the wallet pages and the service worker, and required by the tests,
  so a mobile wallet can use it unchanged. It depends on nothing that belongs to a tab, a content script or a page session.
- `extension/wallet.js` supplies what the core needs from its host (per-identity encrypted storage, the held credentials,
  the domain rules of `baseUrl`) and exports `getServices`, `joinService`, `checkService` and `servicesDomain`.
- `extension/services-tab.js` draws the tab. Text that comes from a domain is always set as text, never as markup.
  What belongs to the page it is shown in (which site is open, how a credential card is drawn, the other tabs) is
  handed in by `viewer.js` through `AtlasServicesTab.configure()`.
- `extension/background.js` answers one message, `services-current-site`, for the wallet's own pages only, with the
  origin (nothing else) of the active tab when it is http(s).

## What a domain advertises

`SPEC.md` §3.9 defines the advertisement: a service is `true` or `{ "enabled": true, "url": "…" }`, with the aliases
`chainlabs` and `trading`. An object-style entry may also say which card it needs:
`{ "enabled": true, "requiresCredential": true, "credentialClass": "atlas.postoffice.membership" }`, and a domain can
announce general membership as `domainMembership`. Both are optional and ignored by readers that do not know them (the
directory reads only `enabled` and `url`). The descriptor only says what the domain asks for; it is never proof of
anything. Whether a card is valid comes from the wallet's own verification (signature, owner, revocation, expiry). For
the three services the wallet runs, its own class always wins and a different class in the manifest is ignored with a
warning. A class declared on any other service only tells the wallet which of the person's cards belongs to it, and only
a card issued by that manifest's own domain is attached. Domains that have not added the descriptor keep working: the
wallet's known cards still attach to Global Mail, Trading Station and Domain Membership. The core's table of service types matches the directory server's `SERVICE_TYPES`
(`test/services-core.js` compares them). A service address is shown or opened only when it is on the manifest's domain
or a subdomain, on the same scheme and port, with no credentials or fragment; a path on the domain such as `/mail/`
is resolved against it. A manifest whose `domain` differs from the domain it was fetched from is refused. A top-level
key that appears twice in the manifest text is reported as a warning, since JSON parsers keep different ones.

The manifest is fetched with `GET /.well-known/spatial.json`, no credentials, no cache, redirects refused, a time limit
and a size limit (256 KB). Nothing about the person is sent.

## Domain Membership for someone who holds no card yet

Domain Membership is the card `atlas.membership`; holding it is the subscription (`SPEC.md` §11.1). A person who does not
hold it yet can find and join it from Services in two cases:

- The domain announces `domainMembership` in its manifest: it is listed as announced and Join is offered.
- The domain has not announced it (every manifest written before `domainMembership` existed) but runs a service that needs
  a card from its own issuer, Global Mail or Trading Station: Services still offers Domain Membership, marked "not
  announced by the domain", and the Join step says the domain has not announced it and may decline. The wallet has always
  let a visitor ask any domain for this card (the Subscribe button inside a world), and Join sends that same request. No new
  endpoint is used and the offer is an inference by the wallet, never a claim by the manifest. A domain that sets
  `domainMembership` to `false` or `{ "enabled": false }` is not offered it, and a domain that runs nothing that needs a
  card (only chat, a calendar, a directory and the like) offers nothing at all.

A card held from a domain that does neither is still shown on that domain's Domain Membership page, so no card is ever
without one.

## Adding and discovering

Adding a domain only lists it. It does not register, enable anything, share an identity or send a credential. The tab
offers "Services on this domain that need a membership card" for the site the person is visiting, using the origin the browser reports for
the tab (or for the overlay's parent frame), never a domain a page names itself. Adding is always a separate,
confirmed step, and it reuses what the person was just shown instead of asking the domain again. Services that need no
card are only counted ("2 more services that do not need a card"). A domain with no card-based service has nothing to add,
unless the person already holds one of its cards (those domains are offered under "Found in your wallet").

## Services and credentials

Service credentials are shown inside their services: `atlas.postoffice.membership` under Global Mail,
`atlas.tradingstation.membership` under Trading Station, `atlas.membership` under Domain Membership, and a declared card
under the service that declared it. The cards are the
wallet's own cards, drawn by the same renderer as in the inventory, so verification, actions and file export are
unchanged; nothing is copied or altered. A credential leaves the "Other documents" list only once its domain is on the
person's Services list, so nothing is ever without a place; removing the domain puts the card back, and the card stays in
the wallet either way. A held card of a wallet-run class is shown with its domain even if the manifest no longer mentions
the service. Credentials that belong to no service, or that a domain issued for something else, stay under "Other
documents".

Documents that belong to no service stay under "Other documents" on the same sub-tab, with the same search and the
same compatibility filter.

## Switching a service on or off

Only the explicit choice matters. With no saved choice a service stays on if its credential is held, so nobody's mail
stops because this tab now exists; with no credential it is off, so adding a domain never starts anything. A newly
discovered or added domain is never switched on by the wallet. Global Mail and Domain Membership are what the wallet runs
in the background (`checkAllMail`): while one is switched off, that check does not present its credential to the domain.
Other credentials held at the same domain are still checked.

What a Global Mail check carries: one signed `POST /atlas/mail/check` per domain (at most 200 credentials per request)
returns everything addressed to the presented cards: private mail, friend-request marker messages, chat, call cards, and
notices about the cards themselves (revoked, replaced, suspended, class patches). The API has no way to ask for only one
of these, so the Global Mail switch cannot be split by kind. The settings page says this in words: when off, none of
those arrive for that card and the wallet will not hear of a revocation; nothing else the person holds is affected.

## How often the wallet checks

A wallet page that is open and unlocked checks about once a minute, per identity. One minute is the normal rate and a
target, not a promise: a check waits while another is running, while a domain has asked the wallet to wait, and while
the wallet is locked or closed.

- The timer lives in the wallet page. It sets the next check only when the previous one has finished, at the interval
  plus or minus a tenth so wallets opened together do not ask in step.
- Across wallet pages and the service worker a Web Lock per identity lets one check run at a time, and a check is skipped
  if another began less than 80% of an interval ago, so several open pages still make one request a minute per domain.
- Nothing is asked when no enabled service holds a card, so nothing runs for an identity that holds nothing or has
  switched the service off.
- A domain's `Retry-After` (seconds or date, bounded to 5 s to 1 h) is honoured, and not even "Check now" overrides it.
  Failures (network, 5xx, 429 without a header) back off from 30 s doubling to 15 min; "Check now" may try sooner.
  Both are kept in `chrome.storage.session`, so they end with the browser session.
- A domain that is only busy is not shown as a problem; a failure the wallet verified is.
- A stored interval the person set is kept. Wallets that never set one use the one-minute default; earlier builds wrote
  the old default back with every check, so a stored value may be the old default, and the settings page offers "Use the
  1-minute default". The Mail settings page still lets the person choose any whole number of minutes, one or more.
- The status colours are computed from outcomes of these checks and the person's own "Check now"; reading them sends
  nothing.

Server side: each check costs one signature verification per request, a nonce write (kept 270 s, capped at 20,000, `503
busy` beyond that, without `Retry-After`) and a read of the mailbox files. One request a minute per wallet is within
what the reference Node and PHP issuers do for a small community; a domain with thousands of members online at once
would want a larger nonce cap or `Retry-After` on its `503`, which the wallet already honours when sent.

## Status

Four states, each with an icon and a sentence, never colour alone:

- green, Active and working: a credential that verifies and a successful check or operation within 24 hours;
- amber, Disabled: the person switched it off;
- red, Problem: an expired, revoked or non-verifying credential, or a failed check;
- grey, Unknown or Not set up: nothing joined yet, not checked, a check older than 24 hours, or a service this wallet does
  not operate.

Enabling a service never makes it green. Outcomes are cached and their age is shown; the colours add no requests of their
own. Being asked to wait is not red. A service the wallet shows but does not run (a declared card for something this
wallet cannot use) is grey "Not used from here" while the card is fine, and red only if the card itself is revoked,
expired, spent or does not verify.

## Per-identity state and backup

The list and the choices are stored per identity under `atlasServices`, encrypted at rest like the rest of that
identity's data (`encryptAtRest(identity, 'services', …)`), and are part of the full backup (`services` family). Another
identity has its own empty list. A draw that started for one identity is dropped if the wallet switches meanwhile.
If saved state cannot be read, the tab refuses to overwrite it and the background mail check carries on as before.

## What is not supported

A service that needs a card the wallet cannot use yet is listed only if the manifest declares the card; its page shows
which card, whether the person holds it, and that nothing is sent to the domain for it. Joining is offered for Global
Mail, Trading Station and Domain Membership only, through the same issue request as the Join buttons in a world. Settings
are loaded from the domain only when the person asks.

## Tests

- `node test/services-core.js` — the core, with no browser.
- `xvfb-run -a node test/manual-services-tab.js` — the tab against a local issuer on port 8002 (see the file header).
- `xvfb-run -a node test/manual-services-discovery.js` — discovery, hostile manifests, card-only listing, two domains; no
  issuer needed.
- `xvfb-run -a node test/manual-mail-polling.js` — the one-minute check: rate migration, no overlap across pages,
  `Retry-After`, backoff, nothing asked when off; waits out a real minute (needs the issuer on 8002).

Browser tests that open the extension keep a profile under `test/.chrome-profile-*` and some seed keys in the issuer's state
(`issuer-server/atlas-*-store.json`). A profile left over from an earlier run already holds an identity, so the tests that
expect the first-run screens time out (`verify-wallet`, `manual-mail`, `manual-inventory-filter-persistence` and others). Delete
the profiles, start a fresh issuer on 8001 with the default state folder (so the admin key the tests seed is the one it reads)
and another on 8002, and run one suite at a time. Run in one long sequence against a single issuer, some later suites failed
with "issuer key was not valid at issuedAt" (seen after `manual-mail-check-auth` and `manual-postoffice-mail`); a restarted issuer
with clean state per suite avoids it.
