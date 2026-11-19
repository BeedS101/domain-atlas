# Site Doctor: findings from the first live security verification

Both live issuers were checked with the Issuer Security & Deployment Health build: all five critical security files matched the repository, the domain was pinned correctly, owner-proof was enforcing `require` for all three membership classes, the caller-aware outbound limiter was recording key, verify and drop operations, two distinct visitor records were seen, and private storage sits outside the web root. No issuer PHP file needed deploying. The remaining warnings, and what was done about each:

| # | Finding | Kind | Outcome |
|---|---------|------|---------|
| 1 | `GET /atlas/world/drops` reported HTTP 0 | Doctor probe | Fixed. The web server redirects the bare folder name and the page does not follow redirects. The probe now asks `/atlas/world/drops/?world=site-doctor-probe` and expects JSON with `drops`. |
| 2 | `GET /presence/status.php` reported HTTP 400 | Doctor probe | Fixed. The route needs `domain` and `world`; the probe sends this host and a world that does not exist, and expects `{"count":0}`. The presence service is unchanged. |
| 3 | Summary showed fewer warnings than the checklist | Doctor counting | Fixed. The summary counted individual checks; the checklist also held manifest, feature, file and administrator-route problems. WARNING and FAIL are now counted from the checklist itself, and its card (and the report) name the sections they come from. |
| 4 | `/atlas/call/lib/state/meta.json` answered HTTP 500 and was marked OK | Doctor classification | Fixed. A 5xx or no response is now "not confirmed as refused", a warning with advice, not a pass. 4xx and redirects remain refusals. |
| 5 | Large revocation list (7,304 entries, about 1.3 MB) | Housekeeping | Warning kept. Nothing is pruned. A retention and scaling design is a separate piece of work. |
| 6 | Manifest advertises an email intake address, `lib/atlas-email-tickets-config.json` absent | Configuration | Warning kept. Either configure email delivery or remove the address from the manifest; the doctor changes neither. |

## Leads for the service code (not changed)

- **Call Service state folder rules.** `call-php/atlas/call/lib/store.php` writes the state folder's `.htaccess` with an unguarded `Require all denied` followed by an `IfModule !mod_authz_core.c` block. The other `.htaccess` files in the Call and issuer folders wrap both forms in `IfModule`. A host whose server does not load `mod_authz_core` (or otherwise rejects that file) would answer HTTP 500 for everything in the folder, which is the symptom seen on one issuer while the other answered 403. This is a lead, not a confirmed cause: compare that folder's `.htaccess` on the host with the repository text and read the error log line for the request.
- **Presence count rewrites its store on every read.** `presence-php/presence/status.php` goes through `with_presence_store_locked()`, which sweeps expired members and writes the file back even though it only returns a count. It is correct, but it is a write on a public GET, so a flood of reads takes the exclusive store lock each time. Worth a read-only path if presence traffic grows.

Kept as is: the revocation list size warning and the email intake warning are meant to stay visible until someone decides about them.
