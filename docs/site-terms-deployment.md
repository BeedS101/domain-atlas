# Deploying the Terms & Conditions page and footer

Nothing here runs on the server: the pages are static HTML generated in the repository
(see `site-shared/README.md`). Deployment is an ordinary file upload to each domain's web root.

## What to upload

Each domain's web root is its demo folder with `issuer-php/` laid over it, as before.

1. `terms/index.html` into the web root of every domain (creates `/terms/`). The three copies in the repo
   (`demo-domain-a/terms/`, `demo-domain-b/terms/`, `issuer-php/terms/`) are identical.
2. The updated pages for that domain:
   - Demo domain A: every changed `demo-domain-a/*.html`.
   - Demo domain B: `demo-domain-b/index.html`, `email-ticket-demo.html`, `multi-issuer.html`, `txlab.html`,
     `wallet-bridge-demo.html`.
   - Both domains (from `issuer-php/`): `atlas-admin/index.html` and `atlas/studio/index.html`.
3. Nothing else. `issuer-server/server.js` only affects the Node development server and is not part of the
   shared-hosting deployment.

The root `LICENSE` is unchanged.

## After uploading

- `https://<domain>/terms/` shows the terms. `https://<domain>/terms` redirects to the slash form (Apache does this
  for a directory by default).
- The footer link on each page is `/terms/`, resolved against the domain the visitor is on.
- Check with JavaScript disabled: the footer, the risk notice and the terms page all still appear.

## Local environments

- `php -S` with the merged web root, or the Node dev server (`node issuer-server/server.js`): `/terms/` resolves.
  Opening an HTML file via `file://` does not: root-absolute links need a web server.

## Rollback

Re-upload the previous copies of the changed pages and remove `terms/`. No data or configuration is touched.

## Not covered

See "Pages not covered" in `site-shared/README.md`. The terms are a working draft written for an experimental
demo; have them reviewed by a South African attorney before relying on them. They contain no contact address
and are not a privacy policy.
