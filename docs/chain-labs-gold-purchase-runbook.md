# One controlled Gold purchase of AETH

Status: experimental. Test Gold only (it has no monetary value). Nothing in this document is applied by the repository: every step is a file you
upload or a switch you flip by hand, and the last section turns it all off again.

## 1. Why AETH has no price and no Buy button today

Read-only checks of the live domains show this chain of conditions. The first one that fails is the cause; the rest follow from it.

| Condition | What was seen | Result |
|---|---|---|
| AETH's signed genesis has a purchase policy | yes: class `atlas.element.gold`, 10 AETH per Au (`unitsPerPrice` 10000000, 6 decimals), smallest purchase 1 Au, 3,000 AETH per key, 30,000 AETH per 24 h, issuer key `BEsSoECy…tmRc`, 2-of-2 with `evtec.co.za` as authority and `domain-atlas.co.za` as partner | the offer exists |
| The policy's issuer key is the Gold issuer we run | yes: it is the key in `https://evtec.co.za/.well-known/atlas-key.json` | the issuer is `evtec.co.za` |
| The authority has a Gold adapter (`gold-adapter.php` in its `chainblock-labs-private` folder) | **no.** The market endpoint says `offer.available: false`, `unavailableBecause: "this domain has no Gold adapter"`; `spend34.php?action=coin` says `purchasesEnabled: false` | no price, no market cap, no Buy |
| The partner has a Gold adapter | no (`purchasesEnabled: false` there too) | the partner could not approve a sale |
| The issuer's hold endpoint is on | could not be seen from outside: both `/atlas/ledger/gold-hold` and `/gold-hold-status` answer with an HTTP error and no body. Either the hold files are not uploaded yet or `lib/atlas-gold-hold-config.json` does not exist, which is the default | a sale could not hold Gold |

So the blocker is configuration, deliberately: the Buy gate is working. Price and market cap are dashes because the market only prices an offer that is
available; 24h volume is a real 0 because nothing was sold. Nothing here should be bypassed, and nothing in the code lets it be.

## 2. What was finished first

The one security blocker left in `docs/gold-reservation.md` was cancelling a sale after delivery had begun. It now needs the partners' witness: a partner
signs that it never approved an entry for the sale and then approves nothing for it; the issuer frees the Gold only against the authority's closure plus that
witness. Tested with the attacks that matter (authority alone, partner that approved, partner down, a request tried again after it was closed).
`test/manual-chain-labs-aeth-rehearsal.js` rehearses the whole thing below with AETH's own numbers, using the files the tool writes.

## 3. Files to upload

Upload the whole current files; none of them is a patch. They are idempotent, so re-uploading something already there is harmless. Use the `main` of the repository.

On **both** `evtec.co.za` and `domain-atlas.co.za` (the `chain-labs` folder in the web root):

    chain-labs/coin26.php          chain-labs/coin26.html         chain-labs/spend34.php
    chain-labs/lib/gold-issuer.php chain-labs/lib/policy.php      chain-labs/lib/purchase.php
    chain-labs/lib/spend.php       chain-labs/lib/ledger.php      chain-labs/lib/peer.php

On the **issuer** (`evtec.co.za`, the folder that holds `atlas/` and `lib/` of `issuer-php`):

    issuer-php/lib/gold-hold.php                     issuer-php/lib/store.php
    issuer-php/lib/replacement.php                   issuer-php/atlas/ledger/gold-hold.php
    issuer-php/atlas/ledger/gold-hold-status.php

Nothing else changes. Existing coins (GOPH, MWC, OSC, AETH) keep their genesis. The two new database tables are created by the code the first time it
runs. After uploading, the market still shows no price: there is no adapter yet.

## 4. Generate the configuration (on your computer)

The tool reads the two domains' public keys from the live sites (read-only), writes the files into a folder, and never prints the token.

    node tools/chainlabs-gold-setup.js --out C:\gold-setup ^
      --issuer-url https://evtec.co.za --issuer-domain evtec.co.za ^
      --issuer-key BEsSoECye7YN6uNRL7fubOgvJ8tM2VB_lzOuEaQqzwrPDB7-TpSZs95Jo4xIweq-cCBHox-hrZmsNEqojIYmtRc ^
      --authority evtec.co.za ^
      --domain evtec.co.za=https://evtec.co.za/chain-labs/spend34.php?action=coins ^
      --domain domain-atlas.co.za=https://domain-atlas.co.za/chain-labs/spend34.php?action=coins

`--issuer-domain` must be the domain written inside a Gold credential (`issuer.domain`); check one in your wallet. If it differs, a purchase is refused
before anything is held, with "the credential was issued by another domain". Add `--web-path ""` only if `chain-labs` is not a folder of the web root.

The folder `C:\gold-setup` then holds: `issuer\atlas-gold-hold-config.json`, `evtec.co.za\gold-adapter.php` (holds the token: keep it private),
`domain-atlas.co.za\gold-adapter.php` (no token) and `SETUP.txt`. Do not commit these or put them in the repository.

## 5. Install, in this order

1. **Back up** the issuer's private state (`lib/` of the issuer including its revocation list and any folder named in `lib/atlas-private-dir.txt`) and both domains'
   `chainblock-labs-private` folders.
2. **Issuer, header pass-through.** The hold endpoint reads `Authorization: Bearer …`. In the issuer's `.htaccess`, if it is not already there:
   `SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`.
3. **Issuer, hold config.** Upload `issuer\atlas-gold-hold-config.json` to the issuer's `lib/` folder. (`lib/.htaccess` already denies web access to it.)
   Read-only check: `https://evtec.co.za/atlas/ledger/gold-hold-status?credentialId=x&requestId=00000000000000000000000000000000` now answers JSON
   `{"error":"no such hold","code":"unknown-hold"}` with HTTP 404 (before, it answered nothing useful).
4. **Partner first.** Upload `domain-atlas.co.za\gold-adapter.php` to `domain-atlas.co.za`'s `chainblock-labs-private` folder (beside `chain34.sqlite`). It holds
   no token: the partner only checks and approves, and cannot start, spend or cancel anything. `purchasesEnabled` turns true there too; the market and the
   wallet look at the authority.
5. **Authority last.** Upload `evtec.co.za\gold-adapter.php` to `evtec.co.za`'s `chainblock-labs-private` folder. Now `purchasesEnabled` is true on the
   authority, and within seconds the market shows AETH with a price of 0.1 Au, a market cap of 0 Au (nothing circulating yet), volume 0 Au, and a signed-in
   wallet sees **Buy with Gold**. This is the moment the Buy gate opens for everyone with a wallet, within AETH's own limits (3,000 AETH per key,
   30,000 per 24 hours). Do it when you are ready to make the purchase.

## 6. The purchase

1. Give your wallet key some test Gold the way you normally do (for example `tools/admin-mint.js <your wallet key> atlas.element.gold --quantity 10`).
2. On the market page, signed in, press **Buy with Gold** on AETH and buy 1 Au. The wallet extension must be the current build (an older one says it is too old). Its prompt asks to add evtec.co.za to the wallet's list if needed, then shows the 10 AETH, the 1 Au cost, the Gold credential and your receiving key, and signs only when you press **Sign and buy**. AETH then appears in the wallet's Ledger tab.
3. Expected: 10 AETH delivered to your wallet key; your 10 Au credential is replaced by one of 9 Au; the scanner shows one new AETH entry (a purchase, 1 Au,
   approved by both domains); the market shows price 0.1 Au per AETH, market cap 1 Au, 24h volume 1 Au.

If the reply is "pending" (for example the partner did not answer), the sale is journaled and the Gold is held; repeating the same purchase, or the operator
action `purchase-recover` on the authority, finishes it once. The Gold is never spent without the AETH and never released while the AETH could still be delivered.

## 7. Switching it off

* Immediately, per domain: delete `gold-adapter.php` from that domain's `chainblock-labs-private` folder. `purchasesEnabled` goes false, the price and the
  Buy button disappear, purchase requests are refused (503). Sales already journaled stay as they are.
* The issuer: set `"enabled": false` in `lib/atlas-gold-hold-config.json` (or delete it). Holds already made keep blocking those credentials; do not do this
  while a sale is in flight.

## 8. What this does not cover

* PHP on `evtec.co.za` must be allowed to fetch https addresses (`allow_url_fopen`): the authority calls its own issuer that way. If not, a purchase answers "the issuer cannot be reached" and nothing is held.
* The Gold must be demo Gold from this issuer; the issuer's Node server has no holds and cannot back a purchase.
* The hold list is one file (`lib/holds/`): back it up with the issuer, never restore an old copy while a sale is in flight.
* A sale a partner approved but the authority never committed stays `delivering` until the entry commits or the issuer's operator resolves it by hand.
* A coin of one domain cannot cancel a begun sale; only AETH-like multi domain coins can be sold this way.
* Not load tested; limits per address are left to the web server.
