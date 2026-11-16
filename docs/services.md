# Services (wallet tab)

The Services sub-tab of the wallet's Inventory replaces the old Documents sub-tab. A person adds the domains they use,
sees what each advertises, opens one settings page per service, and switches services on or off for the identity they
are acting as. The flow is: add a domain, discover its services, configure, use.

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
`chainlabs` and `trading`. The core's table of service types matches the directory server's `SERVICE_TYPES`
(`test/services-core.js` compares them). A service address is shown or opened only when it is on the manifest's domain
or a subdomain, on the same scheme and port, with no credentials or fragment; a path on the domain such as `/mail/`
is resolved against it. A manifest whose `domain` differs from the domain it was fetched from is refused. A top-level
key that appears twice in the manifest text is reported as a warning, since JSON parsers keep different ones.

The manifest is fetched with `GET /.well-known/spatial.json`, no credentials, no cache, redirects refused, a time limit
and a size limit (256 KB). Nothing about the person is sent.

## Adding and discovering

Adding a domain only lists it. It does not register, enable anything, share an identity or send a credential. The tab
offers "Discover services on this domain" for the site the person is visiting, using the origin the browser reports for
the tab (or for the overlay's parent frame), never a domain a page names itself. Adding is always a separate,
confirmed step, and it reuses what the person was just shown instead of asking the domain again.

## Services and credentials

Service credentials are shown inside their services: `atlas.postoffice.membership` under Global Mail,
`atlas.tradingstation.membership` under Trading Station, `atlas.membership` under Domain Membership. The cards are the
wallet's own cards, drawn by the same renderer as in the inventory, so verification, actions and file export are
unchanged; nothing is copied or altered. A credential leaves the "Other documents" list only once its domain is on the
person's Services list, so nothing is ever without a place; removing the domain puts the card back. A credential can
belong to more than one service.

Documents that belong to no service stay under "Other documents" on the same sub-tab, with the same search and the
same compatibility filter.

## Switching a service on or off

Only the explicit choice matters. With no saved choice a service stays on if its credential is held, so nobody's mail
stops because this tab now exists; with no credential it is off, so adding a domain never starts anything. Global Mail
is the one service the wallet runs in the background (`checkAllMail`): while it is switched off, that check does not
present the credential for that service to the domain. Other credentials held at the same domain are still checked.

## Status

Four states, each with an icon and a sentence, never colour alone:

- green, Active and working: a credential that verifies and a successful check or operation within 24 hours;
- amber, Disabled: the person switched it off;
- red, Problem: an expired, revoked or non-verifying credential, or a failed check;
- grey, Unknown or Not set up: nothing joined yet, not checked, a check older than 24 hours, or a service this wallet does
  not operate.

Enabling a service never makes it green. Outcomes are cached and their age is shown; nothing polls.

## Per-identity state and backup

The list and the choices are stored per identity under `atlasServices`, encrypted at rest like the rest of that
identity's data (`encryptAtRest(identity, 'services', …)`), and are part of the full backup (`services` family). Another
identity has its own empty list. A draw that started for one identity is dropped if the wallet switches meanwhile.
If saved state cannot be read, the tab refuses to overwrite it and the background mail check carries on as before.

## What is not supported

Services the wallet does not operate (Mail Relay, site chat, voice calling, Asset Studio, Scanner, Directory, Calendar)
are listed with their address and an honest "not used from here" page. Chain Labs points at the Ledger tab. Joining is
offered for Global Mail and Trading Station only. Settings are loaded from the domain only when the person asks.

## Tests

- `node test/services-core.js` — the core, with no browser.
- `xvfb-run -a node test/manual-services-tab.js` — the tab against a local issuer on port 8002 (see the file header).
- `xvfb-run -a node test/manual-services-discovery.js` — discovery, hostile manifests, two domains; no issuer needed.
