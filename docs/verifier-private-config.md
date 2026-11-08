# Private configuration for installed verifiers (cPanel and similar)

Status: documented and tested; the package needs no change for it. The deployment wizard does not exist yet. This note says
where a wizard (or an operator) should keep an installation's configuration so that it is outside the web root.

## What the configuration holds

`config.php` lists the issuer origins to trust, optional key pins, optional CORS origins, the size limit and the optional
SHA-256 of an access token. It holds no private key and no secret in the cryptographic sense. A leaked token hash cannot be
turned back into the token, but it does reveal which issuers a site trusts and lets an attacker know that a token exists.
The aim of keeping it private is integrity: nobody who can reach the site through the web server, or write into a
publicly writable folder, should be able to change who the verifier trusts. Changing that list is the way to make a
verifier accept a forged issuer.

## Layout

On shared hosting the account's home directory is above the document root:

```
/home/ACCOUNT/                        home directory, not served
    atlas-private/                    mode 0700, owned by the account
        verify-config.php             mode 0600 (0400 once written)
    public_html/
        atlas-verify/                 the uploaded package
            config.php                a one-line stub, mode 0644
            verify.php
            lib/ ...
```

The stub is the whole of `config.php`:

```php
<?php
return require '/home/ACCOUNT/atlas-private/verify-config.php';
```

and the private file is the ordinary configuration, starting with `<?php` and `return [ ... ];` as in
`config.example.php`. `verify.php` includes `config.php` and uses the array it returns, so no verifier code changes. A
private file that is missing, unreadable, does not return an array, or lists no issuer leaves the verifier refusing every
request (500 or 503, never a verdict).

## Rules for a wizard

1. Create the private directory with mode 0700 before writing the file, and write the file with mode 0600, then 0400 when the
   wizard finishes. Use an absolute path derived from the account's home directory, not from the document root.
2. Place it outside the document root. If the host offers only the document root (no readable home above it), do not
   fall back silently: use the stub-free `config.php` in the package folder, which the package's `.htaccess` blocks on Apache,
   and tell the operator that on nginx or without `AllowOverride` it must be blocked by hand.
3. Write the stub and the private file only after the package files have been verified against `PACKAGE.json`. Write the private
   file first and the stub second, so a half-finished install does not leave a stub pointing at nothing (that is safe, since
   it refuses everything, but it looks broken).
4. Never put a secret in the private file that the verifier does not need. For an access token store only its SHA-256.
   The token itself goes to the caller, not to the server.
5. Keep the path out of responses and logs. The verifier prints nothing from the configuration; a direct request to the
   stub returns an empty 200 and shows neither the path nor the settings (tested).
6. Do not make the stub writable by the web server after install. If the wizard offers to change the configuration later,
   it should do so by rewriting the private file through the same authenticated flow, not by opening the folder for
   writing.

## What this does and does not protect

- It protects against a misconfigured server that serves PHP source or `.php.txt` copies, against backup tools that copy
  the document root, and against a file-listing or path-traversal bug elsewhere in the web root.
- It does not protect against another account on the same host that shares the PHP user (common on cheap shared hosting)
  or against a compromised account. On such hosts the 0700 mode and `open_basedir` are the available controls.
- `open_basedir` that excludes the private directory makes the stub fail closed. If the host sets `open_basedir`,
  include the private directory in it; the test runs with `open_basedir` limited to the package folder and the private
  directory and verifies normally.
- A `chmod` setting that the host's PHP cannot read (some suPHP/FPM setups) has the same failure mode: the verifier refuses
  everything. The wizard's final step should therefore open `verify.php` and require `"configured": true` before it
  reports success.

## Same pattern for the issuer, later

The reference PHP issuer keeps its private key under `lib/` and relies on `.htaccess`. A future wizard should apply the
same layout to the issuer's key and state: a private directory above the document root with mode 0700. This note does not
change the issuer, and no live site or key is touched by it. It is a design input for the wizard, to be verified against the
issuer's code paths (key, state, backup and admin key files) before use.

## Tested

`node test/verifier-private-config.js` (9 checks): the stub loads the private file; credentials verify with
`open_basedir` limited to the package and the private directory; a direct request to the stub exposes nothing; the private
directory is not reachable through the web server; a stub pointing at a missing file, an empty trusted list and a file that
does not return an array each refuse everything; the verifier never writes to the private file.
