# Chain labs

Experimental Chainblock test services and their pages: wallet verification, a test faucet and transfer, a coin
registry, signed balance reads, account opening and discovery, and the two-domain federation experiments. Everything
here is a demonstration with no monetary value.

## Contents

| Labs | Files | What it does |
| --- | --- | --- |
| 16 | `login.html`, `verify.php` | Wallet signs a challenge; PHP verifies it. No assets involved. |
| 17, 18 | `gold.html`, `send.html`, `faucet.php`, `transfer.php` | Single-domain TEST-GOLD faucet and wallet-approved transfer on SQLite. |
| 19, 20 | `federation.html`, `federation.php`, `federation20.html`, `federation20.php` | Two domains exchange signed ping messages. |
| 21, 22, 23 | `events21.*`, `events22.*`, `compare23.*` | Signed demo events, offline catch-up, and signed state-commitment comparison. No balances move. |
| 25 | `supply25.*` | Read-only audit of each domain's own TEST-GOLD ledger. |
| 26 | `coin26.*` | Coin registry. A coin is registered on one domain only. It is created as single or multi authority and as a public or private ledger; a multi coin names its partner domains and threshold and stays pending until they sign. Registering a coin does not open a ledger for it: the registry is `coin26.sqlite` and the ledger is `chain34.sqlite`, both in the private folder, and an operator opens a registered coin with the `open` route of `spend34.php`. The page lists where each coin stands on the ledger and has the operator buttons for it: open (or finish opening) a coin, and grant units from the treasury of an open one. |
| 27, 28 | `index.html`, `market27.*`, `market-login28.php` | Read-only coin directory aggregating both registries, with the market figures of the coins that are open on a ledger (below); wallet login for it. |
| 29 | `ledger29.php` | Read-only signed balance query. |
| 30, 31 | `account30.php`, `accounts31.php` | Signed zero-balance account opening and account discovery. |
| 33 | `account-test33.html` | Runs account opening, discovery and a balance read with a throwaway test key. |
| 34 | `spend34.php` | Spending, receipts and holdings. An owner-signed transfer is executed at once by a single authority coin and answered with a signed receipt; a multi authority coin's authority collects approvals from the other domains first (HTTP 202 while it waits); a signed `holdings` lookup lists a key's coins, private coins only to a key-signed challenge; the operator opens a registered coin as a ledger (a multi coin together with its partner domains), makes treasury grants, recovers waiting proposals, compares heads with the other domains and reads the evidence behind a frozen coin; `GET head` is the domain's signed head statement; the `peer` route takes requests from the other domains of a coin. A coin whose genesis has a purchase policy is sold for a price credential through `purchase` (the authority only; the code that holds the credentials is reached through `gold-adapter.php` in the private folder, and without it the route answers 503); the operator finishes or cancels waiting sales with `purchase-recover` and `purchase-cancel`. Not imported: written for the chain build. |
| 35 | `scan35.php`, `scan35.html` | The scanner: a read-only view of the coins of a domain, like a block explorer. `scan35.html` is one page with hash routes (`#/coins`, `#/coin/ID`, `#/coin/ID/entries`, `#/coin/ID/entry/N`, `#/coin/ID/account/REF`, `#/coin/ID/domains`); `scan35.php` serves the read-only JSON routes it uses (`coins`, `coin`, `entries`, `entry`, `account`, `domains`), all GET, opened on the database read-only and paged to at most 100 entries. A public coin shows keys; a private coin shows references and amounts, never a key, and its accounts are reached by reference. The page verifies the log in the browser, from the genesis to the head or to one entry: each hash, the chain, the authority's signature and the roster's approvals, against the keys in the coin's own genesis (balances are not replayed). The domains page shows the signed head each roster domain states and whether they agree; a frozen coin says so and why. Not imported: written for the chain build. |

## Running state

- The data endpoints require HTTPS. Eleven of them (`account30`, `accounts31`, `coin26`, `ledger29`, `supply25`,
  `market27`, `compare23`, `events21`, `events22`, `federation`, `federation20`) refuse any host that is not on the
  configured list of domains, described below. The TEST-GOLD faucet and transfer and the two login verifiers do not
  check the list; they accept any well-formed host and bind what they sign to it.
- Databases are created in `chainblock-labs-private`, a directory beside the web root and never inside it. This folder
  holds no keys, tokens or databases.
- The federation pages ask for an operator token and do not store it in the page.
- The two domains keep independent ledgers. Nothing here replicates balances between them.

## Domains and peers

`lib/hosts.php` holds the list of domains the labs answer for and which domain each one exchanges messages with. With no
configuration it is the two original domains, peering with each other, exactly as before. To change it, put
`chainlabs-config.json` in the `chainblock-labs-private` folder beside the web root (or point the `CHAINLABS_CONFIG`
environment variable at a file):

    { "hosts": ["a.example", "b.example"], "peers": { "a.example": "b.example", "b.example": "a.example" } }

`hosts` is one to five lower-case host names with no port. `peers` is optional: two hosts peer with each other, and any
other number have no peer unless `peers` names them. A configuration file that exists but is invalid leaves no domain at
all, so every lab refuses every request, and the problem is written to the PHP error log. The `lib` folder must be
uploaded with the PHP files; it holds a deny rule and the library refuses a direct request. The HTML pages still carry
their own copy of the two domain names.

## Ledger store

`lib/ledger.php` is the storage and rules layer for the coin ledger described in `docs/chain-labs-spend-protocol.md`. No
lab uses it yet. It is a library over one SQLite file per node:

- a genesis (authority mode, visibility, roster, threshold, supply) that every roster domain signs before the coin opens
  with entry 0, which credits the treasury;
- a hash-chained log in which each entry has a public form and a private form. A public coin's two forms are the same
  record; a private coin's public form carries `HMAC-SHA256` account references instead of keys;
- owner-signed transfers (raw P-256 key and signature, as the wallet produces them), a per-account sequence number and
  a per-owner nonce, an authority signature, and approvals from other roster domains up to the coin's threshold;
- paged public reads by coin, by entry range and by account reference, an owner view that resolves references for the
  key holder only, and `ledger_check`, which recomputes every balance, sequence number, reference, index row and
  signature from the log and reports any difference from the stored tables.

A genesis may carry a faucet policy (`maxAmount`, `perKeyLimit`, `cooldownSeconds`) that limits every spend from the
treasury key; the commit, the prepare step and the checker all enforce it, and an entry's `executedAt` is checked against
the previous entry and the owner's proposal window so the cool-down cannot be gamed. The treasury key is made by
`ledger_treasury_key_create` into the private folder (mode 0600, never overwritten), and `ledger_grant` builds an
operator grant signed with it. The coin creation form does not offer a faucet policy yet; the operator gives one when opening a coin.

`lib/spend.php` adds owner proposals kept until they execute (one waiting per sender, expiring, the same proposal answered
the same way), execution by the authority of a single authority coin with a signed receipt, recovery that finishes the
proposals a crash left waiting, and the signed holdings statement with its single-use challenges. `spend34.php` serves
them over HTTPS; its tests run the real endpoint with keys and signatures made the way a wallet makes them.

`lib/peer.php` is the multi authority side: signed requests between the domains of a coin, opening a coin together, keeping
each domain's copy of the log level, and approvals. Each domain pins the public keys of its partners in
`chainlabs-peers.json` in the private folder (`{"keys": {"b.example": "<base64 PEM>"}, "urls": {...}}`; the single peer of a
two-domain lab may use `peer_public_pem_b64` of `federation20-config.php`), and `chainlabs-config.json` may carry a
`partners` list naming the domains a host can use as partners. A domain without a pinned key is never contacted and its
requests are refused. A co-approver checks every entry against its own copy before it signs; with a threshold below the
roster size a dishonest authority can still fork the log; the domains find that by comparing signed head statements (`GET
head`, the `compare` operator route and the check an approver makes before it signs), and a split view, a rolled-back
authority or an invalid entry freezes the coin on every domain that checks the evidence. Resuming a frozen coin is an
operator's review of the kept evidence (`evidence`); nothing resumes it by itself.

`lib/purchase.php` sells a coin for a price credential held elsewhere. The genesis carries the policy (price class, issuer key,
units per unit of price, minimum price, a limit per receiving key and a limit per 24 hours); the ledger refuses a request id
delivered twice, a price below the minimum, an amount that is not price times rate and a sale past either limit, and every
approver checks them again. The authority locks the credential, journals the decision, delivers the units through the normal
spend path and then spends the credential, and every step can be repeated after a crash. The code that holds the credentials
is reached through `gold-adapter.php` in the private folder, which returns `verify`, `revoked`, `lock`, `release` and `finish`
callables (the contract is at the top of `lib/purchase.php`); each domain that approves sales needs `verify` and `revoked`.
`test/support/gold-stand-in.php` is the stand-in the tests use. Sales are delivered one at a time per coin; a sale that meets
another in flight answers 202 and is finished by repeating the request or by `purchase-recover`.

`lib/gold-issuer.php` is the adapter for real Gold credentials held by a Domain Atlas issuer (`issuer-php`, test Gold only, not used by
any live domain). The authority's adapter reserves the Gold at the issuer from the buyer's own signed intent (`lock`), tells it before
each attempt to deliver (`begin`), and has it spend the credential once the units exist (`finish`); `release` is used only when the
ledger has ruled delivery out. While a hold exists nothing else can spend the credential, and a hold that is delivering never lapses
by time. The credential is kept in the ledger as `{id, gold}` (`pack`) because it carries numbers the ledger's canonical form refuses.
Design, enforcement, crash recovery and the remaining limitations are in `docs/gold-reservation.md`. Tests:
`node test/chain-labs-gold-issuer-http.js` (needs `php`) and `node test/manual-gold-hold.js` for the issuer side.

The market page (`index.html`, `market27.php`, and the `market` route of `scan35.php`, with the figures in `lib/market.php`) shows
Price, Market cap and 24h volume in demo Gold (Au) from the ledger, and a dash wherever a figure has no source. Each domain states
the coins it is the authority of; `market27.php` takes a coin from its authority only, so a multi authority coin is one row. Issued
supply is what the genesis put into the ledger and the treasury is its account, so circulating supply is the difference. The price is
the offer price of the genesis purchase policy (`10^decimals / unitsPerPrice` Au per coin) and exists only when the coin is active,
the domain has a `gold-adapter.php`, the treasury holds at least the smallest purchase and the 24 hour limit is not used up. Market
cap is circulating supply times that price. 24h volume is the sum of the prices paid in the entries of the last 24 hours that carry a
purchase reference, read newest first and bounded to 500 entries (past that the figure says it is a lower bound); grants and ordinary
transfers carry no purchase reference and never count. A coin whose genesis has no purchase policy has no price, market cap or volume.
Buy with Gold shows on the page and in the wallet only for a coin with a usable offer, and `spend34.php?action=coin` says whether
the domain can take Gold at all (`purchasesEnabled`).

Pressing Buy with Gold calls `window.atlasWallet.requestPurchase({ domain, coinId })` (the wallet extension's page bridge, allowed by the
site's `walletBridge.read`). The wallet opens its own prompt over the page and runs the same `offer`, `prepareBuy` and `buy` steps as its
Ledger tab, so a wallet that holds none of the coin can buy it: the prompt first asks to add the authority domain to the wallet's list, then
shows the coin quantity, the Gold cost, the chosen Gold credential and the receiving key, and signs the purchase only when the owner presses
Sign and buy. The page passes only the domain and the coin; the terms are read from the domain. Without the extension, with an outdated one,
with a locked wallet or on a site the extension is not allowed to serve, the button says which. The Ledger tab refreshes when the purchase settles.

The scanner shows only public forms. Entries are read from the public form of the log, so a private coin's pages hold references,
amounts, hashes and signatures and nothing that names a key; the private form of an entry, and an owner's authorization, are
never read by it. Evidence of a frozen coin is shown as the signed statements that prove it, and a record of an entry that
failed the checks only by its index and reason. The domains route asks the other roster domains for their signed heads, which
makes it the one route that causes requests elsewhere, so its answer is kept for 15 seconds (`scan35-heads-<coin>.json` in the
private folder) and the page checks every statement's signature itself. The scanner does not catch a partner up with the
authority; it shows this domain's copy, and the domains page shows how far each other domain is. Limits per address are left to
the web server in front of it.

Opening a registered coin: the operator calls `open` on the authority domain with the operator token (the studio page has the
button). The coin is opened once; a second call is refused, and a multi coin that stopped because a partner did not answer is
finished by the same call, which asks only the domains that have not signed. A multi coin is open only when every roster
domain has signed its genesis. A partner needs the authority's key pinned (`chainlabs-peers.json` in its private folder, or
`peer_public_pem_b64` of its federation configuration for the two-domain pair) and the authority needs the partner's; `open`
names a partner with no pinned key. Nothing is minted into any wallet: a key holds units only after a `grant` from the treasury.

### Selling a coin for Gold (purchase policy)

The Coin Creation Studio can give a coin an optional Gold purchase policy. It is the `purchase` object of the genesis that `lib/ledger.php`
already validates (`priceClass`, `issuerKey`, `unitsPerPrice`, `minPrice`, `perKeyUnits`, `perDayUnits`); the form asks for it in coins and Au and
`lib/policy.php` turns it into ledger units. Coins per 1 Au sets the price (1 coin costs 1 / rate Au), the smallest purchase is a whole number of
Au, and the limits per receiving key and per 24 hours are in coins. Everything the ledger would refuse is refused, and so are a smallest purchase
the limits cannot cover and a per-key limit above the daily one.

* `coin26.php?action=preview` (operator token) checks the policy and returns it in full, as lines to read, with warnings and a fingerprint. It stores nothing.
* `create` with a policy needs `purchaseDigest`, the fingerprint of the policy that was shown for the same name, symbol, decimals and supply, otherwise 409 `policy-not-confirmed`. The form shows the review first and creates on a second press; changing any field withdraws the review.
* The registry keeps the policy in the `purchase` column. `spend34.php?action=open` uses only that policy, re-validates it, and writes it into the signed genesis; a policy sent with the request that differs from the registered one is refused (`policy-mismatch`). A coin registered without a policy opens with the genesis it always had, so existing registered coins do not change unless the operator registers a new one.
* `chainlabs-gold-issuers.json` in the private folder (optional) lists the issuers whose keys and classes may be chosen: `{"issuers": [{"name": "...", "domain": "...", "key": "<raw public key>", "classes": ["atlas.element.gold"]}]}`. Without it only `atlas.element.gold` is accepted, with any well-formed key, and the review says the key is not checked. A list that cannot be read, or an empty one, authorises nobody. The list is checked again when the coin is opened.
* `docs/chain-labs-gold-purchase-runbook.md` is the step by step for one controlled purchase, and `tools/chainlabs-gold-setup.js` writes its configuration files.
* Having a policy does not turn real purchases on. Buying needs a `gold-adapter.php` in the private folder and an issuer with its hold endpoint enabled (see `docs/gold-reservation.md`); neither exists on the live domains.

Every commit runs in one `BEGIN IMMEDIATE` transaction that re-checks the entry index, previous hash, signatures, nonce,
sequence number and balance, so concurrent commits of one index have exactly one winner. Amounts are decimal strings of
whole units, at most 10^12 (13 digits, so the largest legal supply is written with 13 digits and anything above it is refused). The `lib` folder must be uploaded with the PHP files; the library refuses a direct request.

## Provenance

The PHP files were imported from the deployed files. `SOURCE.sha256` records the SHA-256 of each file as it stands (PHP
hashed with LF line endings, since the deployed copies use CRLF). Eleven of them differ from the received copies in one
line each, where a hard-coded domain list was replaced by a call to `lib/hosts.php`; nothing else changed. The HTML pages
differ from the received copies only in removed decorative text and emoji. `coin26.php`, `coin26.html` and `spend34.php` were then extended for the coin creation choices and the purchase policy and also differ from the received copies. Change a PHP file deliberately, then refresh
its line in `SOURCE.sha256`.

## Checks

    node test/chain-labs-import.js
    node test/chain-labs-config.js
    php test/chain-labs-ledger.php
    node test/chain-labs-coin-form.js
    php test/chain-labs-spend.php
    node test/chain-labs-spend-http.js
    php test/chain-labs-multi.php
    node test/chain-labs-multi-http.js
    php test/chain-labs-purchase.php
    node test/chain-labs-purchase-http.js
    node test/chain-labs-wallet.js
    node test/chain-labs-scan-http.js
    node test/chain-labs-policy-http.js

The wallet screen and the scanner page are checked in a real browser (needs Chromium and a display; not part of the workflow):

    xvfb-run -a node test/manual-chain-labs-tab.js
    xvfb-run -a node test/manual-chain-labs-scanner.js
    xvfb-run -a node test/manual-chain-labs-studio.js
    xvfb-run -a node test/manual-chain-labs-studio-policy.js
    xvfb-run -a node test/manual-chain-labs-gold-e2e.js
    xvfb-run -a node test/manual-chain-labs-aeth-rehearsal.js
