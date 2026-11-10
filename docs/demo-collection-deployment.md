# The public demo collection on both domains

**TEST DEMOS, NO REAL VALUE.** Every demo page runs on both `evtec.co.za` and `domain-atlas.co.za`, from the same page code, unless
it cannot run safely on one of them. In that case the other domain's home page links to the domain that runs it, with the domain's
name on the link. Nothing here changes a ledger, issuer, wallet, key, manifest or security rule, and nothing is copied between the
domains except public, static pages.

## 1. One version of each page

`site-shared/demos.json` lists every public demo: its page, a one-line summary, the backend routes it calls (under `issuer-php/`), what
extra configuration it needs, and, if it does not run on both domains, which domain runs it and why. A page is edited only in its
canonical folder; the other domain's copy is overwritten from it by the tool and must stay byte-identical.

```
node tools/demo-directory.js           # copy shared pages, regenerate both "Demo directory" sections and the table below
node tools/demo-directory.js --check   # exit 1 on drift (also run by node test/demo-directory.js)
node tools/check-demo-deployment.js evtec.co.za   # read-only check of a deployed domain (section 6)
```

A new demo is added by putting its page in its canonical folder, adding an entry to `demos.json`, adding the page to
`site-shared/pages.json`, and running the tool. A page in either domain's folder that `demos.json` does not account for fails `--check`.

Why copies and not one shared folder: each domain's folder is the web root that domain's pages are uploaded from, and the development
server and the browser tests serve a domain's folder directly. A single shared folder would mean changing all of those. The tool and its
check give the same guarantee, one place to edit and no drift, without moving anything.

Where a page needs to know which domain it is on, it reads the address it was loaded from. The federation and reserve bank pages
default their second domain to the *other* deployed domain (`evtec.co.za` pairs with `domain-atlas.co.za` and the reverse); on any other
address, such as a local test copy, they keep the default in their markup.

## 2. The collection

<!-- demo-table:start -->
| Demo | Backend (under `issuer-php/`) | evtec.co.za | domain-atlas.co.za | Extra configuration |
| --- | --- | --- | --- | --- |
| Credential demo | `atlas/asset/issue`, `atlas/asset/transfer`, `atlas/asset/redeem` | Page `business-demo.html` | Page `business-demo.html` | Nothing beyond the issuer. |
| Purchase demo | `atlas/asset/purchase`, `atlas/demo/cafeteria/fulfill` | Page `cafeteria-demo.html` | Page `cafeteria-demo.html` | Nothing beyond the issuer. |
| Login demo | `atlas/login/nonce`, `atlas/login/verify`, `atlas/demo/login/revoke` | Page `login-demo.html` | Page `login-demo.html` | Nothing beyond the issuer. |
| Warranty demo | `atlas/demo/warranty/mint`, `atlas/demo/warranty/stamp-sale`, `atlas/asset/history` | Page `warranty-demo.html` | Page `warranty-demo.html` | Nothing beyond the issuer. |
| Email ticket demo | `atlas/asset/issue` | Page `email-ticket-demo.html` | Page `email-ticket-demo.html` | Nothing beyond the issuer. No mail is sent. |
| Supply-chain recall demo | `atlas/demo/recall/issue`, `atlas/asset/history`, `atlas/mail/check` | Page `recall-demo.html` | Page `recall-demo.html` | Nothing beyond the issuer. |
| Attestation demo | `atlas/demo/attestation/issue`, `atlas/demo/attestation/revoke` | Page `attestation-demo.html` | Page `attestation-demo.html` | The domain's own reviewer key is created on first use in its own private storage; never copy one. |
| Treasury approval demo | `atlas/demo/bank/request-approval`, `atlas/demo/bank/approval` | Page `bank-demo.html` | Page `bank-demo.html` | Nothing beyond the issuer. |
| Suspend and clawback demo | `atlas/demo/clawback/mint`, `atlas/demo/clawback/suspend`, `atlas/demo/clawback/unsuspend`, `atlas/demo/clawback/clawback` | Page `clawback-demo.html` | Page `clawback-demo.html` | Writes the domain's own .well-known/atlas-suspensions.json, as the existing suspend route already does. |
| Governance and voting demo | `atlas/demo/governance/propose`, `atlas/demo/governance/vote`, `atlas/demo/governance/finalize` | Page `governance-demo.html` | Page `governance-demo.html` | Reviewer key created on first use in the domain's own private storage. |
| Oracle-triggered payout demo | `atlas/demo/oracle/attest`, `atlas/demo/oracle/policy/issue`, `atlas/demo/oracle/payout/claim` | Page `oracle-demo.html` | Page `oracle-demo.html` | Reviewer key created on first use in the domain's own private storage. |
| Reserve bank demo | `atlas/demo/reserve/*`, `atlas/demo/attestation/issue`, `atlas/demo/clawback/*`, `atlas/trade/*` | Page `reserve-bank-demo.html` | Page `reserve-bank-demo.html` | Act 8 (consortium mint) needs an administrator login on each domain; the sibling field defaults to the other domain. The pinned example reads evtec.co.za. |
| Cross-domain federation demo | `atlas/postoffice/*`, `atlas/mail/check`, `atlas/asset/issue` | Page `federation-demo.html` | Page `federation-demo.html` | postOffice true in both manifests, outbound https from each domain's PHP to the other, and lib/replacement.php and atlas/asset/issue.php from this release on both domains (each accepts the other's pages for a Post Office membership only). The second domain defaults to the other site. |
| Multi-domain transaction authorization lab | `atlas/demo/txlab/*` | Page `txlab.html` | Page `txlab.html` | Its own private configuration, signing key and database per domain; off until configured (docs/txlab-deployment.md). |
| Multi-issuer portable asset lab | `atlas/demo/multi-issuer/*` | Page `multi-issuer.html` | Page `multi-issuer.html` | Its own private configuration and signing key per domain; off until configured (docs/multi-issuer-deployment.md). |
| Wallet bridge demo | `atlas/asset/issue` | Link only, to domain-atlas.co.za | Page `wallet-bridge-demo.html` | Wallet extension. It needs the ring offer in that domain's wallet-bridge policy, which evtec.co.za does not grant. |
| Product page pinned to a spot in a world | none (static page) | Page `compass-listing.html` | Link only, to evtec.co.za | Wallet extension. It points at Plaza, a world only evtec.co.za declares. |
| Blog post pinned to a spot in a world | none (static page) | Page `blog-post.html` | Link only, to evtec.co.za | Wallet extension. It points at the Lobby, a world only evtec.co.za declares. |
<!-- demo-table:end -->

The four Labs (Asset Studio, Chainblock Labs market, Ledger Scanner, Coin Creation Studio) were already on both domains and are not
part of this table; their home page section is unchanged.

## 3. What is deliberately not shared

- **Each domain's identity and state.** `.well-known/` (manifest, issuer key, reviewer key, revocation and suspension lists),
  `spatial/` scenes and the worlds they describe, the issuer's `lib/` state, every private storage folder, SQLite database and
  configuration file stay where they are. Nothing in this change reads, writes or copies them.
- **Plaza, Museum, Arena, Market, Lobby** belong to `evtec.co.za`; **Workshop and Gallery** belong to `domain-atlas.co.za`. They are
  declared by each domain's own manifest, so the worlds are not duplicated. The two spatial pin pages below follow from that.
- **Cross-domain links instead of copies** (each labelled with the domain's name on the other home page):
  - *Wallet bridge demo* runs on `domain-atlas.co.za` only. It asks the wallet to accept a ring from the domain, which needs the ring
    offer in that domain's wallet-bridge policy. `evtec.co.za`'s policy offers nothing, and the policy is part of its identity, so it
    is left as it is rather than widened for a demo.
  - *Product page* and *Blog post* pinned to Plaza and the Lobby run on `evtec.co.za` only, because their spatial link names worlds
    only that domain declares.

## 4. What to upload

Public static pages, plus two issuer files for the federation demo (below), into each domain's web root (the folder that holds
`.well-known` and `atlas`), in binary mode. Nothing from `.well-known/`, a private folder or any configuration is part of this change.

**evtec.co.za**

| File | Status |
| --- | --- |
| `index.html` | changed (the Demo directory section) |
| `federation-demo.html` | changed (second domain defaults to the other domain) |
| `reserve-bank-demo.html` | changed (sibling domain defaults to the other domain) |
| `email-ticket-demo.html` | new (it was only on `domain-atlas.co.za`) |

**domain-atlas.co.za**

| File | Status |
| --- | --- |
| `index.html` | changed (the Demo directory section) |
| `email-ticket-demo.html` | changed (the back link no longer names one domain) |
| `business-demo.html`, `cafeteria-demo.html`, `login-demo.html`, `warranty-demo.html`, `recall-demo.html`, `attestation-demo.html`, `bank-demo.html`, `clawback-demo.html`, `governance-demo.html`, `oracle-demo.html`, `reserve-bank-demo.html`, `federation-demo.html` | new |

`txlab.html`, `multi-issuer.html`, `wallet-bridge-demo.html`, `compass-listing.html` and `blog-post.html` are unchanged and stay where
they are.

**Both domains, for the federation demo (Act 2 onwards)**

| File | Status |
| --- | --- |
| `lib/replacement.php` | changed |
| `atlas/asset/issue.php` | changed |

The federation demo has a page on one domain create Bob's Post Office membership on the other domain, which the public mint refuses
from any page that is not the domain's own. These two files let each deployed domain accept the other's pages for that one class,
`atlas.postoffice.membership`, and nothing else; every other class and every other origin is refused exactly as before. Upload them to
both domains, otherwise the demo stops at Act 2 with "minting is open to this domain's own pages only". They hold no key, state or
configuration. A site doctor run that reported no differing code before this change is on the matching "before" versions.

## 5. Before uploading the new pages to domain-atlas.co.za

The pages call the domain's own backend, so the backend routes in the table must already be deployed there: the same `issuer-php`
release as `evtec.co.za`. Run the read-only check first:

```
node tools/check-demo-deployment.js domain-atlas.co.za
```

It sends only GET requests. A route that is deployed answers 405 (POST-only), 400 (needs a parameter) or a JSON 404; an HTML 404 is
reported as missing. If a route is missing, upload that route's PHP file from `issuer-php/` at the same path. Those files hold no
configuration or state. Do not replace `lib/store.php` unless the host is on the release its hash table expects
(`docs/demo-authorization-deployment.md`), because it carries every change since.

Things the pages need that are per domain and are not set up by this change:

- **Public minting** is decided by the issuer, not by the pages: `ATLAS_PUBLIC_MINT_CLASSES` in `lib/store.php` lists the demo classes,
  and the route accepts requests from the domain's own pages only. A page copied to a domain mints on that domain, under that domain's
  key, and nowhere else. The one exception is the Post Office membership, which the other deployed domain's pages may also mint (the
  federation demo); it is built into `lib/replacement.php` (`ATLAS_FEDERATION_MINT_ORIGINS`) and needs no setting. Do not add the
  other domain to `ATLAS_MINT_ORIGINS` or `ATLAS_MINT_TRUSTED_ORIGINS`: that would let its pages mint every offered class.
- **Reviewer key** (attestation, governance, oracle, reserve bank): created on first use in the domain's own private storage. The
  private folder must be writable, as it already is for the issuer key. Never copy one domain's key to the other.
- **Federation demo**: `postOffice` must be true in both manifests (it is) and each domain's PHP must be able to make https requests to
  the other.
- **Reserve bank demo, Act 8** needs an administrator login on each domain, as before; the page says so. The pinned example at the
  bottom reads a finished request from `evtec.co.za` on either domain.
- **Transaction lab and multi-issuer lab** stay off until their own private configuration exists on each domain
  (`docs/txlab-deployment.md`, `docs/multi-issuer-deployment.md`).

Copying a page enables nothing on its own. Spending, administrative operations and every experimental switch are controlled by the
domain's server-side configuration, which this change does not touch.

## 6. After uploading

1. `node tools/check-demo-deployment.js evtec.co.za` and `node tools/check-demo-deployment.js domain-atlas.co.za` both end with
   `ALL CHECKS PASSED`. Each lists the pages the domain runs, confirms the pages it does not run are absent, and probes every backend route.
2. Open each home page: the Demo directory follows the Labs section, and each link opens. A link with a domain name opens on that domain.
3. On each domain, open the federation demo: Domain B should show the other domain. Open the reserve bank demo: the sibling field
   should show the other domain.
4. Try one demo that mints (for example the email ticket demo's **Get my demo voucher**) on each domain; the credential names that
   domain as its issuer.

## 7. Rollback

Static pages only. Re-upload the previous `index.html`, `federation-demo.html`, `reserve-bank-demo.html` (and `email-ticket-demo.html`
on `domain-atlas.co.za`), and delete the newly added pages. No data or configuration is touched.

## 8. Tests

- `node test/private-mint.js`: who may use the public mint on the Node and PHP issuers, including the Post Office exception for the other domain.
- `xvfb-run -a node test/manual-federation-demo-php-browser.js`: the federation demo end to end between two PHP issuers.
- `node test/demo-directory.js`: the list is consistent, and each way the collection can drift is reported and repaired.
- `xvfb-run -a node test/manual-demo-collection-browser.js [screenshot-dir]`: two throw-away PHP issuers laid out like the live
  sites, a real browser; the directory, every page and its local files, desktop and phone, the host-based defaults, a demo end to end,
  and the deployment check itself.
- `xvfb-run -a node test/manual-site-labs-links.js`: the Labs section is unchanged.
- The existing click-through tests for the demos (governance, oracle, recall, login, email ticket) pass against either domain's folder.

Checked in Chromium. The pages use plain DOM and Web Crypto only; they have not been run in Firefox or Safari.
