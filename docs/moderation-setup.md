# World moderation: operator setup guide

This is the short version. The design, wire format and limits are in
`docs/moderation-authorization.md`.

World moderation lets people you name mute, unmute or remove (kick) anonymous
visitors from the worlds you name, from a **Moderate** button in the wallet that
opens the domain's existing admin page (`/atlas-admin/`). Every action is written
to a private audit log kept by the presence service.

Nothing here is switched on by deploying the code. **You create each
configuration file yourself, on the server, when you are ready.** Neither the
repository nor the software creates or overwrites a live configuration file.
Chat and multiplayer keep working exactly as before if you never do any of this,
or do only part of it.

## What you need

Three pieces have to agree. If one is missing the panel says which, in plain
words, and nothing else is affected.

| Piece | Where | What it says |
|---|---|---|
| Issuer config | the domain's issuer | which presence service(s) it will sign moderation grants for |
| Presence config | the presence service | which issuer key(s) it trusts for the domain, and its own address |
| Domain manifest | `.well-known/spatial.json` on the site | that the admin page may ask the wallet to sign a moderation grant |

Plus a moderator entry for each person, in the issuer's admin key list.

## 1. Issuer: which presence service to trust

Set one of these (Node), or create the file (PHP). The presence address must be
an origin: scheme, host and optional port, with no path.

* Node issuer: environment variable `ATLAS_MODERATION_AUDIENCES=https://presence.example.com`
  (comma separated for several), or create `atlas-moderation-config.json` in the
  issuer's state directory (`ATLAS_STATE_DIR`, see `issuer-server/server.js`).
* PHP issuer: create `lib/atlas-moderation-config.json` on the server.

```json
{ "domain": "example.com", "audiences": ["https://presence.example.com"] }
```

The panel only ever contacts addresses listed here. It never takes a presence
address from the manifest, from the page's URL or from anything a visitor can
influence.

Optional: `ATLAS_MODERATION_PANEL_GRANT_TTL_S` (seconds, at most 600) is how long
the grant the panel asks the wallet for lasts. The default is a few minutes. A
shorter value means the wallet asks for approval more often.

## 2. Presence service: which issuer to trust

Create the file yourself (it is git-ignored and web-denied):

* Node presence: `presence-server/moderation-config.json`, or the file named by
  `PRESENCE_MODERATION_CONFIG`.
* PHP presence: `presence/lib/atlas-presence-moderation-config.json` on the
  server (the `presence-php/presence/` bundle's `lib/` folder).

```json
{
  "enabled": true,
  "audience": "https://presence.example.com",
  "domains": {
    "example.com": {
      "issuerKeys": ["<public key from https://example.com/.well-known/atlas-key.json>"],
      "statusUrl": "https://example.com/atlas/moderation/status"
    }
  },
  "revokedModerators": [],
  "revokedGrants": []
}
```

`issuerKeys` takes the `publicKey` value of the first entry under `keys` in
`https://example.com/.well-known/atlas-key.json` (copy it; do not let software fetch
it for you, the point is that you chose it). `audience` must be the same origin you
listed in step 1. With no file, an
invalid file or `"enabled": false`, moderation answers "not available" and
everything else about the presence service is unchanged.

The admin page runs on your site and talks to the presence service on another
origin, so the presence service answers the browser's cross-origin check only for
`https://<domain>` of the domains you list here (`http://` only for `localhost`).
No other site can use these endpoints from a browser.

## 3. Manifest: allow the signing prompt

In `.well-known/spatial.json`, at the top level (or in the world the admin page is
shown for), add:

```json
"walletBridge": { "sign": ["moderation-grant"] }
```

Without it the wallet will not show a signing prompt to the admin page. The panel
then explains that the operator has to allow it, and does nothing else. Existing
entries in `walletBridge` stay as they are; add `"moderation-grant"` to the `sign`
list.

## 4. Name the moderators

Add entries to the issuer's admin key list (`atlas-admin-keys-store.json`; Node: the
state directory, PHP: `lib/`). This is hand-edited on purpose. The file is
`{ "keys": [ ... ] }`: **add the new entry to the existing `keys` list; do not replace the
file or remove existing entries**, or you lock out the current administrators. An entry
with no `role` is an administrator.

```json
{ "publicKey": "<moderator's wallet public key>", "addedAt": "2026-10-10T00:00:00Z",
  "role": "moderator", "worlds": ["lobby", "plaza"],
  "operations": ["roster.view", "chat.mute", "chat.unmute", "session.kick", "audit.view"] }
```

* **Always list both `worlds` and `operations`.** A moderator entry that leaves either
  out is not "none", it is **everything**: no `worlds` means every world, no
  `operations` means every operation (including `session.kick` and `audit.view`). Only
  a field that is present but empty, or invalid, means none.
* `worlds` limits which worlds the person can see and act on.
* `operations` limits what they may do. `roster.view` is needed to see anyone.
  `audit.view` lets them read the audit log for their own worlds.
* Administrators keep every moderation operation in every world. A moderator-only
  key can use none of the other admin functions (no minting, revoking, clawing
  back, mail or settings); the page shows them only the moderation section.
* To remove someone, delete the entry or set `"revoked": true`. It takes effect
  within the status lifetime (60 seconds by default). For an emergency, add the
  person's reference to `revokedModerators` in the presence config (print it with
  `node tools/moderation-ref.js <domain> <public key>`); that applies on the next
  request.

## 5. Using it

Open the wallet on the domain, press **Moderate** (moderators) or **Admin**
(administrators), and find *World moderation*. Choose the world and press
*Start moderating*. The wallet asks you to approve one signed request, listing the
worlds, actions, service address and lifetime; nothing is sent until you approve.
The admin page never touches the wallet's private keys. When the grant lapses the
wallet asks again, for exactly the same scope.

Visitors appear only as a name, whether they are in presence or chat, when they
joined, and a temporary reference. Wallet keys, network addresses and tokens are
never shown. Mute, unmute and kick each ask for confirmation, a fixed reason
(spam, abuse, harassment, inappropriate, disruption, other) and a permitted
duration; the result and when it ends are shown afterwards. All of these expire
by themselves. There is no permanent ban: a visitor who reloads starts a new visit.

### If the panel says something is not set up

| The panel says | Fix |
|---|---|
| no presence service is configured | step 1 |
| the wallet will not sign for this page | step 3 |
| the service does not trust this domain / is not available | step 2 |
| your entry lists no world | step 4 |
| the service could not confirm you are still a moderator | the issuer's status URL is unreachable from the presence host, or the key list in step 2 is out of date |

## 6. The audit log

Every moderation request that reaches a verified grant is recorded by the
presence service: time, domain, world, who (a pseudonymous moderator reference and
role), the action, the temporary reference of the target, length and reason code,
the outcome (success, refused or failed, with a short code) and the grant id. It
never contains chat text, display names, wallet keys, tokens, ephemeral keys, raw
visit ids or network addresses.

* Node: `presence-server/moderation-audit.jsonl` (override with
  `PRESENCE_MODERATION_AUDIT_FILE`).
* PHP: `presence/lib/atlas-presence-moderation-audit.jsonl` (inside the web-denied `lib/`).
* The file is created on first use with mode 0600. Keep it outside any folder the
  web server publishes. The PHP location relies on the `lib/.htaccess` deny rule, so
  check that your host honours it. The audit file does not exist until the first
  moderation request, so a 404 for it proves nothing; instead request a file that does
  exist once any visitor has joined, such as
  `https://example.com/presence/lib/atlas-presence-store.json`. It must answer 403 (or
  404), never the file's contents.
* It is bounded: 1 MiB and 90 days by default (`MODERATION_AUDIT_MAX_BYTES`,
  `MODERATION_AUDIT_RETENTION_DAYS`); the oldest entries are dropped first. Copy it
  somewhere safe if you need a longer history.
* Refusals and audit reads are rate-limited per moderator together
  (`MODERATION_AUDIT_REFUSALS_PER_MIN`, 10 a minute), so a stolen grant cannot fill it
  with them; the rest are summarised in one entry. Real mute/unmute/kick entries are
  limited only by the command rate limit (30 a minute per moderator), so a moderator
  who keeps issuing commands can still push the oldest entries out of the 1 MiB file:
  copy the file somewhere safe from time to time.
* If the log cannot be written, mute, unmute and kick are refused ("audit unavailable"),
  so an action is never taken without a record. Chat and presence are unaffected.
* In the panel, *Show audit log* lists the entries for the selected world only, from
  the presence service, and only for a moderator whose entry allows `audit.view` for
  that world.

**Integrity.** Each entry carries a hash of the one before it, and the panel
reports whether the chain still checks out. This reveals accidental damage and
casual edits. It is **not tamper-proof**: anyone who can write the file can rewrite
the whole chain. To make truncation or a full rewrite detectable, periodically
copy the `head` value shown in the audit view (and the entry count) somewhere the
presence host's operator cannot change.

## 7. Deployment order

1. Update and restart the **presence** service first (Node: `presence-server/`,
   PHP: upload the presence bundle files). On PHP, upload `presence/lib/audit.php` in the
   same batch as (or before) `presence/lib/store.php`, which now requires it: a
   `store.php` without `audit.php` beside it stops presence and chat entirely until the
   missing file is uploaded.
2. Then update the **issuer**. Its status statement now states each moderator's
   role, and an older presence service rejects that.
3. Add the manifest line (step 3), the config files (steps 1 and 2) and the moderator
   entries (step 4), in that order, when you want it on.

PHP uploads (relative to each bundle's document root; the two `lib/store.php` files
are different files and must not be swapped):

| Repository file | Bundle | Upload to |
|---|---|---|
| `issuer-php/lib/store.php` | issuer | `lib/store.php` |
| `issuer-php/atlas/admin/moderation/config.php` (new) | issuer | `atlas/admin/moderation/config.php` |
| `issuer-php/atlas/admin/is-admin.php` | issuer | `atlas/admin/is-admin.php` |
| `issuer-php/atlas-admin/index.html` | issuer | `atlas-admin/index.html` |
| `presence-php/presence/lib/audit.php` (new) | presence | `presence/lib/audit.php` |
| `presence-php/presence/lib/moderation.php` | presence | `presence/lib/moderation.php` |
| `presence-php/presence/lib/store.php` | presence | `presence/lib/store.php` |
| `presence-php/presence/moderation/roster.php` | presence | `presence/moderation/roster.php` |
| `presence-php/presence/moderation/command.php` | presence | `presence/moderation/command.php` |
| `presence-php/presence/moderation/audit.php` (new) | presence | `presence/moderation/audit.php` |

The extension (`extension/wallet.js`, `extension/viewer.js`) shows the **Moderate**
button; reload the unpacked extension or update the store listing.
