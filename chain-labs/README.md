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

- The data endpoints require HTTPS and, apart from the Labs 16 and 28 login verifiers, refuse any host outside a fixed
  allow-list written into the PHP file.
- Databases are created in `chainblock-labs-private`, a directory beside the web root and never inside it. This folder
  holds no keys, tokens or databases.
- The federation pages ask for an operator token and do not store it in the page.
- The two domains keep independent ledgers. Nothing here replicates balances between them.

## Provenance

The PHP files are a verbatim import of the deployed files; `SOURCE.sha256` records the SHA-256 of every file as
received (PHP hashed with LF line endings, since the deployed copies use CRLF). The HTML pages differ from the received copies only in removed decorative text and emoji. Change a PHP file
deliberately, then refresh its line in `SOURCE.sha256`.

## Checks

    node test/chain-labs-import.js
