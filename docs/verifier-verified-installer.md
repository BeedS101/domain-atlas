# Verified PHP verifier installer v0.1 — isolated-test prototype

**Status:** new, unmerged branch. The browser setup assistant in tools/installer/index.html remains a separate configuration generator. This prototype adds the first **server-side installation** path for the pinned Gen 1 verifier. It has NOT been installed on any live domain.

## Purpose and limits

- Installs **only** the fixed atlas-verify **0.1.1** package, once, in an empty atlas-verify/ directory in a separately configured test website.
- Checks the **complete reproducible 0.1.1 ZIP** against its pinned SHA-256 (`e3a431fdc124beba68e157845bcb2f7a6ad11751c7d92774dfbd021ef6a9b365`), as well as the immutable path, size and SHA-256 locks embedded in verified-install.php. It ignores untrusted paths in the ZIP and refuses additions, omissions, duplicates, symlinks and corrupted files. No remote download URLs, no Composer and no shell commands.
- Generates private verifier configuration itself from a server-side allowlist of HTTPS issuers. Defaults to required suspension documents. No issuer, wallet, keys, revocation lists, Domain Atlas Core or live services are modified.
- Before writing anything, validates the test-domain marker, separate writable private directory (0700), trusted issuers and absence of any existing installation. Uses a staged package and an atomic directory rename, and refuses overwrites.
- Has an authenticated HTTPS-only web front-end. The operator provisions the installer settings **outside** the document root. There is no default password, no unauthenticated setup mode and no arbitrary destination path accepted from HTTP.
- **Evaluation only.** This has not been exercised on real cPanel hosting, and the installer cannot prove that your chosen test domain is separate from production. The user is responsible for isolation.

## Server requirements

PHP 7.4+ with ZipArchive available (the installed verifier itself does NOT require ZipArchive), JSON, OpenSSL and curl or allow_url_fopen for outbound HTTPS. The installer needs permission to create files in the test domain's document root and a **separate, pre-existing** private directory with mode 0700. The web installer requires true HTTPS as seen by PHP; it intentionally does not trust X-Forwarded-Proto headers.

If the host cannot provide those requirements, **do not weaken them**. The offline manual installer remains available.

## Test-only operator setup

**Do not perform these steps on evtec.co.za or domain-atlas.co.za.**

1. Set up a completely separate HTTPS test hostname with a dedicated empty document root, such as /home/ACCOUNT/test-verifier-site/. Do not point a test subdomain at the existing issuer's public_html.
2. Place a plain text marker in that document root named .atlas-isolated-test-host. Its entire contents must be the exact expected test hostname, e.g. verifier-test.example (no protocol). This is an affirmative operator check, NOT a security proof that DNS points at that root.
3. Create /home/ACCOUNT/atlas-installer-private/ outside the test site's document root, mode 0700. This directory will hold installer-settings.php, a lock file, and the new private verify-config.php.
4. Generate a random 32-byte (or stronger) **secret operator token**, store its SHA-256 hex hash in a private PHP settings file, and keep the plaintext token only in the operator's password manager. Do not commit either of them, and do not share them in chat.
5. Create /home/ACCOUNT/atlas-installer-private/installer-settings.php with the content pattern below (replace every placeholder, and use a different hostname from any live issuer):

~~~php
<?php
return [
    'tokenSha256' => 'REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS',
    'expectedHost' => 'verifier-test.example',
    'documentRoot' => '/home/ACCOUNT/test-verifier-site',
    'privateDirectory' => '/home/ACCOUNT/atlas-installer-private',
    'trustedIssuers' => ['https://evtec.co.za'],
    'suspensions' => 'required',
];
~~~

6. Place only install-verifier-web.php and verified-install.php in a new password-protected directory served on the **test site**. Keep both installer files **out of the public repository's deployed website** and remove the PHP entrypoint after installation. Use your hosting control panel to set the PHP environment variable ATLAS_INSTALL_SETTINGS to the **absolute path** of your private installer-settings.php; confirm that PHP actually receives it. If cPanel cannot set PHP environment variables, do **not** copy the secret settings into the public web directory to bypass this restriction.
7. Build or download the repository's CI-built atlas-verify-0.1.1.zip (check the source and published SHA-256). The installer independently verifies the *contents* against embedded immutable hashes; it never fetches arbitrary code from the internet.
8. Open the installer over HTTPS on the exact test hostname. Submit the token and upload ZIP, choosing **Preflight only** first. If it says "ready", upload again and choose **Install once**. The installer writes the verifier into the test site's atlas-verify/ directory and the trusted issuer configuration into the outside-webroot private directory.
9. Delete install-verifier-web.php and remove installer access immediately. Remove installer-settings.php when no longer needed and invalidate the one-time token. Keep verify-config.php private.
10. Independently verify server-side access controls: HTTP must not serve /atlas-verify/config.php or /atlas-verify/lib/ source. GET /atlas-verify/verify.php must say configured:true, and a known good, revoked, tampered and unreachable credential must give the expected outcomes. Restrict public verifier callers using a proxy or strong bearer token and rate limits. The default generated verifier configuration has no access token and no CORS permission, so it is **not suitable as an unrestricted public production endpoint**.

## Why the extra work?

An auto-installer that accepts an arbitrary URL or arbitrary destination path could turn a convenient webpage into remote code execution or an issuer compromise. This design refuses both by construction. A real production deployment assistant also requires an operator authentication story, rollback recovery, host-specific permissions audit and a public redistribution licence.

## Automated tests

- node test/verifier-verified-installer.js exercises preflight, modified ZIPs (extra/missing/duplicate/traversal entries, incorrect file hashes, changed PACKAGE.json), unsafe configuration, one-time installation, PHP configuration loading, existing-file refusal and no-write-on-refusal in throwaway directories.
- node test/verifier-installer-http.js exercises the actual multipart upload endpoint, missing configuration, wrong host, missing HTTPS flag, invalid operator token, tampered ZIP, preflight, installation, replay refusal, and GET status from the installed verifier. It uses **loopback HTTP with an artificially set PHP HTTPS environment flag** and does **not** test real HTTPS/TLS or cPanel/proxy security.
- GitHub Actions runs these tests on PHP 7.4, 8.1 and 8.3 with PHP zip enabled.
- The pinned package builder, verifier cryptography, main issuer, live domains and original verifier package lock are unchanged.

**Licensing:** the repository is All Rights Reserved. A general third-party installer offering still requires the copyright holder to choose appropriate permission and distribution terms.
