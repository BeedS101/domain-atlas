# Chain labs: scheduled integrity check

`chain-labs/lib/integrity-cli.php` checks every coin of a domain's ledger from the command line, so a database that was put back, a
damaged record or a sale that came back to life is found when it happens and not when someone next uses the coin. It is meant for
cron. It reads and reports; it never repairs.

## What it checks, per coin

| Check | A problem is |
| --- | --- |
| The ledger invariants (`ledger_check`) | a changed entry, a broken hash chain, a bad signature or approval, balances that do not add up, a wrong supply, a sale record that does not match |
| The checkpoint (`ledger_guard_check`, read only) | **FAIL** when the database holds fewer entries than the checkpoint says (rollback), another history at that entry (conflict) or a damaged log. A loss the operator accepted is a warning, since that coin stays stopped for good. A coin with entries and no checkpoint yet is a warning |
| The journal | **FAIL** when it is damaged, or holds another entry than the database at the same index |
| Permanent sale closures | **FAIL** when the closed-sales file is damaged or missing, when a sale the database holds as closed is not in the file (a restored database could reopen it), or when a closed sale also has an entry. A sale closed only in the file is a warning: it stays closed |
| Opening and freezing | a single authority coin whose opening never finished is a warning (repeat the open); a frozen coin is a warning |

Warnings are listed and do not fail the run unless `--strict` is given. A coin waiting for the other domains to sign its genesis is
shown as information only.

## What it never does

- It opens the database read only, with no schema step, so it creates no table and migrates nothing, and it writes nothing beside it. The
  test fingerprints the whole private folder (names, sizes, times and contents) before and after a run, including a run that finds a
  rollback, and they are identical.
- It never repairs, reseals, restores, accepts a rollback or writes a halt line. Those stay operator actions
  (`docs/chain-labs-rollback-protection.md`, section 6).
- It prints coin ids, symbols, modes, states, entry numbers and short reasons. It never prints a path of the machine, a key, a reference
  secret, a token or an operator configuration: paths and long secret-looking strings are removed from every message, and it does not
  read the operator configuration at all.
- A web request for it is a 404 (and `lib/.htaccess` denies the folder).

## Running it

    php chain-labs/lib/integrity-cli.php [--private=DIR] [--database=NAME] [--coin=ID] [--quiet] [--json] [--strict]

With no options it finds the private folder the way the endpoint does: `chainblock-labs-private` beside the web root that the script's
`chain-labs/` folder is in, and the ledger `chain34.sqlite` in it. Run it from each site's own copy. `--quiet` prints nothing when every
coin is ok, `--json` prints the result as JSON, `--coin` checks one coin.

Exit status:

| Status | Meaning |
| --- | --- |
| 0 | nothing wrong (warnings, if any, are listed) |
| 1 | a coin has an integrity problem (or a warning, with `--strict`) |
| 2 | the check could not run: the private folder or database was not found, it is inside the web root, or an option is not valid |

Example output:

    chain labs integrity check 2026-11-20T01:24:47Z
    FAIL    8021a6db95cd3f5ec77b4b12d2a3c18d RBK single active head=2
            FAIL checkpoint-halted: the checkpoint stops this coin: rollback (the checkpoint holds entry 4, the database 2)
    ok      acdb5925b8b07300c899d7afeae85694 OTH single active head=1
    summary: 2 coins, 1 ok, 0 warnings, 1 failed - ATTENTION NEEDED

## cPanel cron

The PHP command line of the account must be PHP 8.1 or later with `pdo_sqlite` and `openssl`. cPanel shows the path of each PHP
version (`/usr/local/bin/php`, or `/opt/cpanel/ea-php82/root/usr/bin/php` for an EasyApache version); use the one the site runs on. The
job must run as the account that owns the files, which cPanel's Cron Jobs page does.

Keep the log outside the web root, readable by the account only:

    mkdir -m 700 /home/ACCOUNT/chainblock-labs-logs

Hourly, silent when everything is fine, and an email only when something needs attention (cPanel mails whatever a job prints; `$?` is the
exit status of the check):

    15 * * * * /usr/local/bin/php -q /home/ACCOUNT/public_html/chain-labs/lib/integrity-cli.php --quiet >> /home/ACCOUNT/chainblock-labs-logs/integrity.log 2>&1 || echo "Chain labs integrity check needs attention (exit $?). Details are in chainblock-labs-logs/integrity.log"

A second job once a day with the whole report, so the log shows that the check is running and what each coin looked like (no email):

    40 3 * * * /usr/local/bin/php -q /home/ACCOUNT/public_html/chain-labs/lib/integrity-cli.php >> /home/ACCOUNT/chainblock-labs-logs/integrity.log 2>&1; true

Replace `ACCOUNT` and the site's folder. For a second site (a different web root) add the same two lines with that site's path: each reads
its own private folder. Set the Cron Email address on the cPanel Cron Jobs page to somewhere that is read. The log holds coin ids and short
reasons only; trim it now and then (`: > integrity.log`), or use only the hourly job, which writes nothing while all is well.

When it reports a problem, run `integrity` for that coin from the operator's tools (`docs/chain-labs-rollback-protection.md`, section 6)
and decide: nothing here changes a ledger.

## Checks

    php test/chain-labs-integrity-cli.php
