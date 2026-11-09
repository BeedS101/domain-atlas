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
| 26 | `coin26.*` | Coin registry. A coin is registered on one domain only. |
| 27, 28 | `index.html`, `market27.*`, `market-login28.php` | Read-only coin directory aggregating both registries; wallet login for it. |
| 29 | `ledger29.php` | Read-only signed balance query. |
| 30, 31 | `account30.php`, `accounts31.php` | Signed zero-balance account opening and account discovery. |
| 33 | `account-test33.html` | Runs account opening, discovery and a balance read with a throwaway test key. |

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

## Provenance

The PHP files were imported from the deployed files. `SOURCE.sha256` records the SHA-256 of each file as it stands (PHP
hashed with LF line endings, since the deployed copies use CRLF). Eleven of them differ from the received copies in one
line each, where a hard-coded domain list was replaced by a call to `lib/hosts.php`; nothing else changed. The HTML pages
differ from the received copies only in removed decorative text and emoji. Change a PHP file deliberately, then refresh
its line in `SOURCE.sha256`.

## Checks

    node test/chain-labs-import.js
    node test/chain-labs-config.js
