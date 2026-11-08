# Verifier setup assistant v0.1 — offline configuration, manual installation

Status: **feature branch prototype**, not a one-click installer. The assistant generates PHP configuration files in the operator's browser. It makes no HTTP requests, uploads, code fetches, server file writes or key changes.

## What to open and configure

Open tools/installer/index.html directly in a browser, with verifier-setup.js alongside it. No server or build step is required to run the assistant.

The form asks for 1–10 explicit trusted HTTPS issuer origins (one per line), an absolute Unix private config path ending in /verify-config.php, and an optional legacy setting allowing HTTP 404 when an issuer has never published a suspension list. That setting is off by default and does not bypass corrupt published lists.

The assistant provides:
1. **verify-config.php**, containing the trusted origins. Upload it OUTSIDE the document root.
2. **config.php**, a one-line PHP require stub placed beside atlas-verify/verify.php.

The output keeps allowedOrigins empty and accessTokenSha256 null. Operators must restrict public callers (or add a strong bearer token hash manually), and enforce rate limits at the server or proxy. The assistant does not generate tokens.

## Install only on an isolated test domain

1. Build the pinned verifier ZIP using tools/package/build-package.js and verify it with tools/package/check-package.py and the published SHA-256 file. The package is atlas-verify-0.1.1.zip.
2. Extract and upload atlas-verify/ into the test domain. Do not replace existing issuer code, keys, suspension/revocation documents or state. The ZIP intentionally has no config.php.
3. Create a directory outside public_html, e.g. /home/ACCOUNT/atlas-private/ with mode 0700. Put verify-config.php inside, mode 0600 (0400 if the host permits after setup).
4. Place the generated config.php stub beside verify.php inside the package. Ensure the PHP account can read the private file; account for open_basedir.
5. Require Apache .htaccess or equivalent nginx/server protections to deny direct HTTP access to config.php and lib/. The assistant cannot inspect hosting configuration or verify the private path is really outside the web root.
6. GET /atlas-verify/verify.php and require "configured": true; this proves config parsing only. POST a known-valid and a revoked Gen 1 credential, plus a credential whose issuer is unavailable, to verify positive and fail-closed behavior.
7. Restrict public access and apply rate limits before broad exposure. The verifier does not prove credential presenter ownership; that requires a separate signed challenge.

## Boundaries

- This assistant does NOT fetch code or write to servers. A future authenticated, version-pinned, checksum-enforcing automatic installer requires separate security review. Do not expose a PHP installer accepting arbitrary remote URLs.
- This configures only the Gen 1 domain-atlas-asset/1.0 verifier, not an issuer, wallet, licensing service, Core, Chainblock, or production deployment.
- The repository and ZIP are currently All Rights Reserved. Public third-party redistribution/deployment needs licensing permission from the copyright owner.
- Opening this assistant does not contact evtec.co.za or domain-atlas.co.za.
- The wizard is not included in the pinned verifier ZIP and does not change signature verification, manifest hashes, or issuer behavior.

## Tests

Run node test/verifier-setup-wizard.js. This checks origin validation and rejection, duplicate rules, PHP output, configuration defaults, stub form, PHP lint and offline-only page markup.
