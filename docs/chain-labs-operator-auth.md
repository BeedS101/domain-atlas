# Chain labs: operator authentication

The actions that change something on a chain labs domain (opening a coin, granting from the treasury, creating a coin, every recovery
step) are signed requests. A shared static token no longer authorizes them. This page describes the request, the roster of keys that may
sign it, what the domain records, how a lost answer is handled, the end of the old token, how to move over and how to get back in when
a key is lost.

Everything here is for the domains that run `chain-labs/spend34.php` and `chain-labs/coin26.php`. The public ledger routes (coins,
holdings, challenge, receipts, the scanner, the peer routes) never read the operator roster or a token and answer as they did.

## 1. The signed request

A request is `{ payload, proof }`, sent as the JSON body of a POST.

```
payload = {
  type: "atlas.chainlabs.operator", v: 1,
  adminAuth: { action, domain, method: "POST", issuedAt, expiresAt, nonce [, repeat: true] },
  request:   { ...the arguments of the action }
}
proof = { signerRole: "raw-ecdsa", publicKey, signature }
```

`proof.signature` is a raw P-256 signature (r then s, 64 bytes, base64url) over the canonical text of the payload: keys sorted, no
whitespace, no fractions. It is the same canonical form the wallet and the ledger use. The domain acts on the arguments in `request` and
on nothing else: an argument placed beside the signed request is ignored.

| Bound to | How |
| --- | --- |
| The action | `adminAuth.action` must be the action the URL names (`spend34/grant`, `coin26/create`, ...). A grant signature does nothing on `accept-rollback`. |
| The arguments | They are inside the signed text; changing one afterwards fails the signature. |
| The domain | `adminAuth.domain` must equal the domain named in the roster file. The roster is the identity of the domain; the `Host` header of a request is only checked against it, so a forged `Host` cannot make a request for another domain valid. |
| The method | `POST`. A GET is not an operator request. |
| The time | `issuedAt` and `expiresAt`. Actions that change something live 60 seconds at most, the others 120, with 30 seconds of allowance for a clock that is a little off. |
| One use | `nonce` is recorded before the action runs; the same nonce from the same key is never carried out twice. |

Actions: `spend34/open`, `grant`, `recover`, `compare`, `purchase-recover`, `purchase-cancel`, `restore`, `accept-rollback`, `reseal`,
`resume`, `integrity`, `evidence`; `coin26/create`, `preview`; `operator/check`, `activate`, `audit`. In the URL, `operator/check` is
`spend34.php?action=operator-check`. `integrity`, `evidence`, `preview`, `operator/check` and `operator/audit` only read; every other action
changes something.

## 2. The roster

`chainlabs-operators.json` lives in the private folder (`chainblock-labs-private`, beside the web root, never inside it). It is read on
every request, so a change is effective at once.

```json
{
  "domain": "a.example",
  "legacyTokenSha256": "<64 hex, optional, only until 1 March 2027>",
  "keys": [
    { "publicKey": "<wallet key form>", "label": "root" },
    { "publicKey": "...", "label": "studio", "actions": ["coin26/create", "coin26/preview", "spend34/open", "spend34/integrity"] },
    { "publicKey": "...", "label": "treasury", "actions": ["spend34/grant"] },
    { "publicKey": "...", "label": "old laptop", "revoked": true }
  ]
}
```

- A key without `actions` may take every action. With `actions` it may take those and nothing else; every key may take `operator/check`,
  which is how a new key proves itself. A key with an `actions` value that is not a list of known actions has no action at all.
- `revoked: true` stops a key at once and keeps it listed, so it cannot be added again by accident. Taking a key out of the list does the same.
- Rotation is adding the new key, using it once to run `verify`, then revoking the old one.
- The file is refused (every operator action answers 503 `operator-roster-invalid` or `operator-roster-unsafe`) when it is not valid JSON of this
  shape, holds a key twice, holds something that is not a wallet key, is larger than 64 KB, or can be written by anyone. A mistake locks
  operator actions; it never opens them.
- With no file at all, operator actions answer 503 `operator-not-configured`. The public ledger is not affected.
- It holds public keys and the SHA-256 of the token, no secret.

Keep separate keys for separate jobs: one that Studio uses (create, preview, open, grant), one for treasury grants if they are made by
someone else, and one for recovery that is used only from the command line and kept offline. A key that is only for the Studio cannot
reach recovery, rollback or activation, whatever happens to the page.

## 3. What the domain records

State is in `chainlabs-operator.sqlite` in the private folder (mode 0600), apart from the ledger database.

- Every accepted request is recorded with its nonce, key fingerprint and a digest of its arguments before the action runs, and the outcome
  (status and answer) after. A request whose action ended in an error is still answered from the record if it is sent again, but it never blocks signing a new request for the same thing.
- The audit table is a hash chain. Each line holds the time, the event (`accepted`, `outcome`, `refused`, `replay`, `legacy`, `throttled`, `activated`), the action, a
  fingerprint of the key and of the nonce, a digest of the arguments, a short code and a short detail (coin, recipient and amount for a
  grant). It holds no key, no signature, no token and no nonce. `operator/audit` returns the newest lines with the result of verifying
  the chain, and so does `php chain-labs/lib/operator-cli.php audit` and `audit-verify`.
- A client address is kept only as a short hash, to count failed attempts.

## 4. A lost answer, and a request sent twice

The operator tool sends a signed request again, unchanged, when no answer arrives, for as long as the request lives.

- The same signed request that was carried out gets its recorded answer again (header `X-Chainlabs-Operator-Replay: 1`). Nothing is carried out twice.
- The same signed request while the first is still running gets 409 `in-progress`, and the outcome is reported as not known until it ends.
- A new signature for the same action with the same arguments within 5 minutes of one that finished is refused (409 `duplicate-request`).
  Signing `adminAuth.repeat: true` (`--allow-repeat`) says that repeating is meant. A request that failed does not count.
- A request that was accepted and never recorded an outcome (the process ended, the host restarted, the database could not be written) may or
  may not have been carried out. It holds back an identical new request for as long as its record is kept, one day, however long ago it was, and
  the same signed request sent again is answered 409 `in-progress` with `outcomeUnknown`. Neither is carried out. The way on is a decision:
  read the ledger (`integrity`, `evidence`, and the audit table), then sign the request with `repeat` only if it did not happen.
- When no answer ever arrives, the tool says the outcome is not known. Do the same.

## 5. When the records cannot be used

Nothing is carried out without a record of it, so every operator action is refused, reads included, while the records cannot be used. A
token is refused too.

| State | Answer |
| --- | --- |
| No roster file | 503 `operator-not-configured` |
| A roster that is not valid, holds a key twice, is too large, or is cut short | 503 `operator-roster-invalid` |
| A roster anyone can write | 503 `operator-roster-unsafe` |
| An operator database that is damaged, locked, not writable or cannot be opened | 503 `operator-state-unavailable` |

The public ledger routes and the ledger itself never read these records and answer as usual. The operator database holds nonces, the audit
trail, the keys that have proved themselves and a copy of the activation. It can be deleted without harm to the ledger: it starts again, and the
keys prove themselves again before the next activation (activation that is already in force stays in force, see section 6). Nonces of requests
still alive are lost with it, so a signed request issued in the last two minutes could be accepted a second time; that needs file access to the
private folder, which is also all that is needed to change the roster.

## 6. Failed attempts

Ten failed attempts in five minutes from one client address, with a token or a key that is not on the roster or a request that cannot be
read, are answered 429 with `Retry-After`. A request signed by a key on the roster is never turned away by this count, so a stranger cannot
lock the operator out.

## 7. The old token

Until 1 March 2027 at 00:00 UTC a request may carry the old token instead of a signature, in `adminToken` in the body. The domain compares
it with `legacyTokenSha256` of the roster (the token itself is not kept) and sets the response header `X-Chainlabs-Operator-Legacy`.

- The date is a constant in `lib/operator.php` (`OPERATOR_LEGACY_UNTIL`). No setting, roster entry, environment value or hosts file moves it.
  From that second the token is refused for every action, reading included (403 `legacy-ended`).
- `admin_token_hex` in `federation20-config.php` is not the operator token. It is the credential of the older demonstration labs
  (events21, events22, federation, federation20, compare23), which are unchanged. It opens no chain labs operator action, and the chain labs
  operator token opens none of those labs.
- A domain with no `legacyTokenSha256` in its roster never accepts a token.
- **Activation.** Once a key has proved itself, the operator activates signed requests: after that a token is refused for every action that
  changes something (403 `signature-required`), and may still read until the date. Activation is a signed `operator/activate` with
  `{"confirm":"activate-signed-operator"}`. It needs the signer to have run `operator/check` before, and every action that changes
  something to be covered by an active, verified key (one key or several). Otherwise it answers 409 `activation-not-ready` with the
  actions that have no key. A key that was added and never tried does not lock anyone out. Activation is kept in two places, a file in the
  private folder (`chainlabs-operator-ratchet.json`) and a row in the operator database, and either one is enough: a deleted file or a deleted or
  restored database does not bring the token back. Nothing in the code or in a setting turns it off. Putting back a backup of both from before the
  activation does, as it undoes anything else; activate again.

## 8. Moving over

Order matters, because the old token is not honored for these actions without the roster.

1. On a trusted computer: `node tools/chainlabs-operator.js keygen --out operator.json --label root` and, for the Studio,
   `... keygen --out studio.json --label studio --actions coin26/create,coin26/preview,spend34/open,spend34/grant,spend34/integrity`.
   Keep the identity files private. `roster-init` writes a roster with the first key and, unless `--no-token`, a new token whose SHA-256 it
   stores; the token is shown once.
2. Upload `chainlabs-operators.json` to the private folder of each domain, with the domain's own name in `domain`, **before or together with** the new
   `spend34.php` and `coin26.php`. A domain that has the new files and no roster answers operator actions with 503 `operator-not-configured`.
   Its public routes still work.
3. Upload `chain-labs/` (`spend34.php`, `coin26.php`, `coin26.html`, `lib/operator.php`, `lib/operator-cli.php`, `SOURCE.sha256`).
4. Prove the key: `node tools/chainlabs-operator.js verify --identity operator.json --url https://a.example`. Do the same for each key you intend to use.
5. Try a harmless signed action: `... call spend34/integrity --json '{"coinId":"..."}'`.
6. When every key works, activate: `... activate --identity operator.json --url https://a.example --yes`.
7. Remove the token from the roster (`php chain-labs/lib/operator-cli.php clear-token`) once nothing uses it, or leave it to end on its date.

Two independent domains. Each domain has its own roster (with its own name in `domain`), its own operator database and its own activation, and is
moved over on its own: do steps 2 to 6 for the first domain, check it, then the second. The same key may be listed on both. A request signed
for one domain is refused by the other (`wrong-domain`), so a key on both cannot be used to act on the other one. A domain that is not activated yet
keeps accepting its token until the date, and one that is activated does not; neither affects the other. The signed requests that domains send
each other for a multi authority coin (approvals, the peer route) use the domains' own keys, not operator keys, and are not changed.

## 9. If a key is lost

The roster file is a file in the private folder, so the host's file access (FTP, file manager, SSH) is the way back: add a new public key
(`php chain-labs/lib/operator-cli.php add-key --key=... --label=...` or edit the file), run `verify` with it, and revoke the lost one. Activation
does not stand in the way: it only makes a token useless, it never makes a key necessary that nobody can provide. If every key is lost and
the host cannot be reached either, the domain's ledger is not touched; only operator actions wait. Changing keys never writes to the ledger database, the checkpoint
log or the journal, so the trust history of every coin (what each wallet and partner has seen of its head) is as it was; the tests compare the head and the checkpoint
files before and after.

If a roster key is stolen: revoke it first (the file, or `operator-cli.php revoke`), then read the audit (`operator/audit`, or `operator-cli.php audit`)
for what it signed, and compare the ledger with `integrity` and `evidence`.

## 10. The Coin Studio

`coin26.html` signs in the browser. The key file is the same identity file the command line tool writes (`{ publicKey, privateKeyJwk }`).

- The file is read by the browser only. The page reads it as bytes, parses it, imports the private key into WebCrypto as a key that cannot be
  exported, overwrites the bytes it read with zeros, drops the parsed object and empties the file chooser. It is not uploaded, not stored (no
  cookie, no `localStorage`, no `sessionStorage`) and not part of any request.
- **By default the signing handle is forgotten after every action**, a refused one and a preview or a key check included, so the next action
  means choosing the key file again. For a coin with a purchase policy that is twice: the preview, and the confirmation (the review stays on
  the page while the key is chosen again). "Keep the key loaded for up to five minutes between actions" is an explicit choice; the handle is
  then forgotten after five minutes without use, or at "Forget the key".
- What is not cleared: JavaScript strings cannot be overwritten, so the text of the file and the encoded private value it held stay in memory
  until the browser collects them, at a time the page does not control. And a CryptoKey that cannot be exported can still sign while it is
  loaded: JavaScript that runs in the page, if it has been tampered with, can use it to sign requests for anything that key may do, for as long as
  it is held. It cannot take the key away. So give the Studio a key with only the Studio actions, keep the default, and use the command line
  tool, from a key the page never sees, for recovery, rollback and activation.
- The page shows the fingerprint of the loaded key. It matches the one in `operator-cli.php status`.
- A legacy token box remains, marked with its end date; it is used only when no key is loaded.

## 11. Command line

```
node tools/chainlabs-operator.js keygen|roster-init|roster-line|verify|activate|audit|call ...   (signing; --help lists the options)
php chain-labs/lib/operator-cli.php status|audit|audit-verify|add-key|revoke|remove-key|set-token|clear-token   (on the server, over SSH)
```

`call <action> --identity FILE --url https://domain --json '{...}'` signs once and sends. `--host` overrides the signed domain name, for a test
server on this computer (the URL may then be `http://127.0.0.1:port`; any other plain `http` URL is refused). `operator-cli.php` is never served over
the web; a request for it gets a 404. Neither tool prints a private key.

## 12. Checks

```
php test/chain-labs-operator.php             # the library with explicit clocks: binding, time, nonce, replay, duplicates, roster, scoping, throttle, audit, sunset, activation
node test/chain-labs-operator-http.js        # the same through the real endpoints, a lost answer, parallel copies, scoped keys, rotation, ratchet, public routes
node test/chain-labs-operator-cli.js         # both command line tools
node test/chain-labs-operator-sunset.js      # the end of the token over HTTP, and that no setting moves it
node test/chain-labs-operator-separation.js  # the demonstration labs' token and the chain labs operator credential
xvfb-run -a node test/manual-chain-labs-studio.js         # the Studio signs in a real browser, the key never leaves it
xvfb-run -a node test/manual-chain-labs-studio-legacy.js  # the page from before signed requests, until the token ends and after activation
```
