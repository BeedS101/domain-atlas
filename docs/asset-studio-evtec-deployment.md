# Deploying Asset Studio v0.1 to the experimental PHP issuer (cPanel)

This puts Asset Studio on a live PHP issuer that already runs the Domain Atlas demos. Studio ships with minting **off**; you switch it on yourself in step 6. Throughout, `evtec.co.za` stands for the domain and `CPUSER` for the cPanel account name.

What is added: the Studio page and its API (`atlas/studio/`), a one-line "include-only" guard in the shared issuer libraries, the refusal of the Studio class on the general issue/reissue/class-patch routes, and Studio's own model collection in `assets/studio/`. What is **not** touched: the issuer private key, holdings, journals, replay records, `lib/atlas-*.json`, `lib/atlas-private-dir.txt`, `.well-known/*` key and revocation files, the txlab and multi-issuer labs and their private folders. The package contains only source files (41), and `tools/studio-deploy-package.js` refuses to include anything that looks like state.

Studio records a mint in the issuer's existing journal and replay store (the same private folder the issuer already uses) and keeps its own rate counters and mint records in a new private folder. Nothing existing is replaced or moved.

## Before you start

- PHP 7.2 or newer for the domain (cPanel, "MultiPHP Manager"). PHP 8.1 or newer is better: older versions cannot flush directory entries to disk, which the code documents as a durability limit, not a failure.
- The live `lib/` folder should be the one from `main` (the demos you already run). If you uploaded Studio files in an earlier experiment and restored the originals, that is the state this expects.
- Open the site as `https://evtec.co.za` (no `www`). Studio checks the exact host name, see step 4.
- If you earlier uploaded `atlas/studio/index.html` from the Terms & Conditions change, that is fine: it is overwritten by the complete page here.

## 1. Back up (5 minutes)

cPanel File Manager, in `public_html`: tick `lib` and `atlas`, **Compress**, Zip Archive, name it `before-studio.zip`. Move that zip to your **home** folder (above `public_html`), and download a copy. This is only for rollback.

## 2. Create the private Studio folder

In File Manager, in your **home** folder (the one that contains `public_html`, not inside it) create:

```
/home/CPUSER/atlas-studio-data/
    drafts/
    uploads-quarantine/
    mint-receipts/
    tmp/
    rate/
```

Then upload `studio-config.json` from the package's `private-setup/` folder into `atlas-studio-data/`. The file as shipped has minting **off**:

```json
{ "mintEnabled": false, "domain": "evtec.co.za", "origins": ["https://evtec.co.za"] }
```

Folder permissions 0755 are fine on cPanel; they must be writable by your account and must not be inside `public_html`. (Your home folder path is shown at the top of File Manager; it is usually `/home/CPUSER`.)

## 3. Upload the code

1. File Manager, Settings, tick **Show Hidden Files (dotfiles)**.
2. Go into `public_html`, **Upload** `evtec-asset-studio-upload.zip`, then select it and **Extract** into `public_html` itself. Say yes to overwriting.
3. Delete the zip from `public_html` afterwards.

The zip contains exactly these paths, relative to `public_html` (nothing else is written):

```
atlas/studio/index.html, studio.css, studio.js, api.php
atlas/studio/inc/.htaccess
atlas/studio/inc/authorize-design.php  challenges.php  design-fingerprint.php  design-validator.php
atlas/studio/inc/issuance-plan.php  keys.php  mint-attempts.php  mint-authorization.php
atlas/studio/inc/model-catalog.php  storage.php  studio-mint.php  storage-root.php.example
lib/bootstrap.php  crypto.php  delivery.php  demo-authority.php  elements-catalog.php  email-tickets.php
lib/imap.php  ledger-issuance.php  ledger-receipts.php  mime-parse.php  replacement.php
lib/sign-manifest.php  smtp.php  store.php  transfer-policy.php
atlas/asset/issue.php  atlas/asset/reissue.php  atlas/admin/class-patch.php
assets/studio/trophy.glb  trophy.png  badge.glb  badge.png  key.glb  key.png
```

Studio's six models go in their own folder, `assets/studio/`. The site's existing models in `assets/` (including `assets/badge.*` and `assets/trophy.*`) are not in the zip and are not touched: extracting it cannot overwrite them, and Studio never reads them.

## 4. Tell Studio where its private folder is

cPanel cannot set PHP environment variables, so use a one-line config file. In `public_html/atlas/studio/inc/`, copy `storage-root.php.example` to `storage-root.php`, edit it, and set your real path:

```php
<?php
return "/home/CPUSER/atlas-studio-data";
```

Studio refuses to run if this folder is inside `public_html` or not writable, and says nothing public about why. The reason is written to the PHP error log: `public_html/atlas/studio/error_log`, or **Errors** in cPanel (look for `studio: minting off: ...`). Common reasons: `studio-storage-not-configured` (wrong path), `studio-storage-must-be-separate-from-web-root`, `studio-bucket-missing-or-unsafe` (a subfolder is missing), `domain-mismatch` (the `domain` in `studio-config.json` is not exactly the host you opened).

## 5. Add the Studio world to the manifest

The wallet only lets the Studio page sign and receive a collectible if the domain manifest allows it. Edit `public_html/.well-known/spatial.json` (File Manager, Edit). Inside the existing `"worlds": [ ... ]` list, add this object after the last world, remembering the comma between objects:

```json
{
  "id": "studio",
  "name": "Asset Studio",
  "policy": {
    "walletBridge": {
      "read": true,
      "sign": ["atlas.studio.mint/1"],
      "offer": ["atlas.demo.studio.collectible"]
    }
  }
}
```

It has no `entry`, so it is never shown as a place to walk into. Save, then open `https://evtec.co.za/.well-known/spatial.json` and check it still loads as JSON.

## 6. Check it (no minting yet)

From a PC with Node (the repository checkout):

```
node tools/studio-live-check.js https://evtec.co.za
```

It reads only. Expect all PASS and `minting is off`. It checks the Studio files, the status endpoint, the validator, the six model files under `/assets/studio/`, that `inc/` and `lib/` files are not readable over the web, that the manifest has the `studio` world, and that the issuer key and trade catalog answer. Fix any FAIL before going on. You can also look by hand: `https://evtec.co.za/atlas/studio/index.html` shows the page, and `https://evtec.co.za/atlas/studio/api.php?op=status` shows `{"ok":true,"mintEnabled":false}`.

For the other demos, run the existing probe, which changes nothing: `node tools/demo-auth-live-check.js https://evtec.co.za`. Then click through your usual demos (login, bank, trading, txlab, multi-issuer) once.

## 7. Turn minting on for the experiment

Edit `/home/CPUSER/atlas-studio-data/studio-config.json` and change `false` to `true`:

```json
{ "mintEnabled": true, "domain": "evtec.co.za", "origins": ["https://evtec.co.za"] }
```

Reload `.../api.php?op=status`: it should now say `"mintEnabled":true`. If it still says false, read the error log (step 4). Default limits are 3 mints per wallet key per day, 10 per network and 200 per day overall, with 30 challenges and 10 mints per hour per address. They can be changed in the same file (see `docs/asset-studio-v0.1.md`).

**To switch minting off again at any time:** set `"mintEnabled": false` in that file. Nothing else needs to change.

## 8. Real wallet test

Use the wallet extension from this branch (`extension/`), because it contains the bridge changes: in Chrome, Extensions, Developer mode, reload the unpacked `extension/` folder, and create or unlock a wallet identity.

1. Open `https://evtec.co.za/atlas/studio/index.html`. The line under the preview should read "Wallet identity available" and **Mint to Wallet** should enable. If it does not, the manifest (step 5) or the extension version is the usual cause.
2. Pick Trophy, name it, press **Validate with PHP** (should pass), then **Mint to Wallet**.
3. The wallet shows the requesting origin, the purpose `atlas.studio.mint/1`, and the issuer's summary line. Approve the signature.
4. The wallet then shows a pending offer for the collectible. Claim it. The wallet verifies the issuer's signature itself against `https://evtec.co.za/.well-known/atlas-key.json` before adding it.
5. Open the item: class `atlas.demo.studio.collectible`, owner-bound, owner your key.
6. Independent check: in the item viewer use **Copy credential**, paste it into `credential.json`, and run:

   ```
   node tools/verify-credential.js credential.json
   ```

   Expect PASS for the published key, the signature, not revoked, owner-bound, and the design digest. Change one letter in the file and run it again: the signature check must FAIL.
7. Negative check: press **Mint to Wallet** again and click Deny at the prompt. Nothing should be issued.

If something fails, `studio-live-check.js` output and the PHP error log say where.

## Rollback

1. Set `"mintEnabled": false` (stops all Studio issuance immediately).
2. To remove the code: extract `before-studio.zip` back over `public_html` and delete `public_html/atlas/studio/`. Delete the `studio` world from the manifest. Credentials already minted stay valid and signed; the issuer's state is untouched either way.

## Known limits (unchanged from the audit documents)

Not proven against power loss; per-network limits mean a determined attacker with many networks can use up the day's quota; a passkey identity is accepted without pinning its relying-party id unless you add `webauthnRpIds`. This is a no-value experimental collectible, bound to the key that approved it. See `docs/asset-studio-v0.1.md` and `docs/asset-studio-security-audit-handoff.md`.
