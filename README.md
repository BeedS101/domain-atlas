# Domain Atlas — prototype (v1.2)

A working proof that the mechanisms in `SPEC.md` are real. A browser
extension reads a domain's manifest, renders whichever worlds it declares,
and lets you walk through two genuinely different kinds of portal — one
that swaps worlds inside a single domain with no network round-trip, and
one that crosses to a completely separate domain. On top of that, a real
wallet: a genuine WebAuthn passkey identity, real ECDSA-signed credentials
issued by an actual small server, verified with real cryptography — items,
fungible resources, PvP loadouts with an owner-signed transfer-on-loss, and
a two-party trade settled atomically by a trading station.

```
domain-atlas/
├── SPEC.md                      the protocol spec
├── extension/                    the Chrome extension (unpacked)
│   ├── content.js                 detects the manifest, injects the entry button
│   ├── viewer.html / viewer.js    renders worlds, hosts the wallet panel
│   └── wallet.js                  identity + credential verification (§5, §6)
├── issuer-server/                a real credential issuer for demo-domain-a
│                                    (also plays the "trading station" role — see §4 below)
├── demo-domain-a/                 "Example Plaza" — FOUR worlds: plaza, museum, arena, market
├── demo-domain-b/                 "Neighbor Workshop" — one world, plain static server
└── test/
    ├── verify.js                  proves the manifest/portal mechanism
    ├── verify-wallet.js           proves the item wallet end to end
    └── verify-loadout-trading.js  proves loadouts/transfer-on-loss and resources/trading
```

Two local servers stand in for two independent domains — same mechanism as
two real domains, just without needing to own and deploy to actual DNS
names to try it. Domain A runs a real issuer (below); Domain B stays a
plain static file server on purpose, to prove it needs zero special
integration with Domain A to trust what Domain A hands out.

## 1. Serve the two demo domains

Domain A needs the real issuer server (Node, zero npm dependencies — there
is nothing to `npm install`):

```bash
node issuer-server/server.js
```

The first run generates a real ECDSA P-256 keypair, writes the public half
to `demo-domain-a/.well-known/atlas-key.json`, and keeps the private half
in `issuer-server/issuer-private-key.jwk.json` (git-ignored — never commit
this file). Every run after that reuses the same key.

Domain B stays a plain static server, unchanged:

```bash
python3 -m http.server 8002 --directory demo-domain-b
```

Confirm both are up:

```bash
curl http://localhost:8001/.well-known/spatial.json      # four worlds: plaza, museum, arena, market
curl http://localhost:8001/.well-known/atlas-key.json    # the issuer's real public key
curl http://localhost:8002/.well-known/spatial.json      # one world: workshop
```

## 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.

## 3. Try it — manifest, portals, and the item wallet

1. Visit `http://localhost:8001` — it looks like an ordinary page.
2. A **🧭 Enter Space: Example Plaza (+3 more)** button appears bottom-right.
3. Click it. The Plaza world renders with four portals: three **orange**
   (same-origin, swap worlds, no re-fetch — to the museum, the arena, and
   the trading post) and one **teal** (crosses to another domain, fetches a
   fresh manifest).
4. Click **Create Atlas Identity** — a real `navigator.credentials.create()`
   call, your device's own passkey prompt, a genuine keypair. It's now
   persisted, not thrown away when you close the panel.
5. Open the **🎒 Wallet** panel and click **Request item from this world**.
   The extension POSTs to the issuer server, gets back a real signed
   `domain-atlas-item/1.0` credential, and verifies it itself — fetching
   `atlas-key.json`, checking the signature with the browser's own Web
   Crypto, checking the revocation list — before showing it with a ✓.
6. Click **Present identity** — a fresh WebAuthn assertion, verified
   client-side against the stored public key. Real proof of key
   possession, no server round trip needed to check it.
7. Cross the teal portal to Neighbor Workshop, then click **Re-verify
   wallet against current issuers**. The Bronze Compass still shows ✓ —
   verified from a domain that has never spoken to Example Plaza's issuer,
   using nothing but that issuer's publicly fetched key.
8. Click **Export wallet** for a real `atlas-wallet-export/1.0` JSON file.

To see revocation actually work: `curl -X POST http://localhost:8001/atlas/revoke -H "Content-Type: application/json" -d '{"id":"<the credential id from the export>"}'`,
then click **Re-verify wallet** again — the item flips to ✗, reason
"revoked by issuer."

## 4. Try it — loadouts, transfer-on-loss, resources, and trading

These all live in the same wallet panel, and use one addition worth being
upfront about: a second **counterparty** identity. Demonstrating a
two-party transfer or a two-sided trade needs two independent signers, and
this demo runs in one browser tab. Rather than fake that, the "self"
identity is a real WebAuthn passkey throughout, exactly as in section 3,
and the "counterparty" is a second, purely local ECDSA P-256 keypair — no
WebAuthn, generated and stored the same way a lightweight non-passkey
client would. It signs for real; it just isn't a hardware-backed key. Click
**Create counterparty identity** in the wallet panel to generate it.

**Loadouts and transfer-on-loss (§5.2):**

1. With an item in your self wallet, walk to the **arena** portal
   (orange). The panel shows a PvP warning — this world's manifest
   declares `profile.capabilities.combat: "pvp"`.
2. Click **Load** on an item card to bring it into this world's loadout.
   A loaded item in a PvP world gets a **Simulate PvP loss** button.
3. Click it. This is the interesting part: the *loser's own key* signs the
   transfer. `wallet.js` builds a `domain-atlas-transfer/1.0` payload
   (`itemId`, `from`, `to`, `worldContext`, timestamp), hashes it, and runs
   it through a real WebAuthn assertion — the same `challenge`-hash trick
   used everywhere else, since a passkey can't sign arbitrary application
   data directly, only the fixed assertion structure. The wallet verifies
   its own signature before applying the move (if that check ever failed,
   it would refuse). The item disappears from the self wallet and appears,
   correctly signed, in the counterparty's — a real ownership change, not
   the server unilaterally reassigning it.

**Fungible resources (§5.4):**

4. Walk back to Plaza, then through the **market** portal into the Trading
   Post. Click **Mine 20 iron (self)** and **Mine 10 gold (counterparty)**
   — each mint POSTs to the issuer, gets back a real signed
   `domain-atlas-resource/1.0` balance credential, and verifies it the
   same way items are verified.
5. Click **Send half** on a resource card to split a balance: the issuer
   validates the presented credential, then issues two new balances (a
   remainder back to the sender, the sent amount to the recipient) both
   pointing at the original via `supersedes`, and revokes the original as
   `"superseded"`. Nothing is ever mutated in place — every balance change
   is a fresh signed credential plus a revocation of the old one.

**Trading stations (§7):**

6. With both parties holding a resource each, click **Settle trade**. Both
   sides' intents are built and independently signed (self via WebAuthn,
   counterparty via its local key), sent to the issuer, which is playing
   the trading-station role here — the spec allows a station to be a
   separate party, but collapsing it onto the issuer keeps this demo to
   one server. It checks both intents actually mirror each other (offering
   what the other wants, at matching quantities, naming each other as
   counterparty, not expired), validates both presented balances, then
   atomically issues four new credentials (remainder + received, for each
   side) and revokes the two pre-trade balances. Either both sides settle
   or neither does — no in-between state where one party paid and the
   other didn't.

## 5. Verify it yourself

```bash
node test/verify.js                    # manifest + portal mechanism
node test/verify-wallet.js             # identity, issuance, cross-domain verification, revocation, export
node test/verify-loadout-trading.js    # loadouts/transfer-on-loss, resources, trading station settlement
```

All three need a display (`xvfb-run -a node test/verify.js` if running
headless on Linux) and both demo domains already running. They use a CDP
virtual authenticator to stand in for a real passkey device — the WebAuthn
ceremonies they drive are still real, just auto-approved instead of
waiting on a fingerprint reader. Each checks, over real network requests
and real signatures, every step described above — including that a
tampered or revoked credential is correctly rejected, and that the
loadout/trading suite's loser-signed transfer and two-party trade actually
require both keys. Screenshots land in `test/` as `01`–`04`
(manifest/portal), `wallet-01`–`wallet-04` (identity/item wallet), and
`lt-01`–`lt-05` (loadout loss and trade settlement).

## What this does and doesn't prove

It proves the `worlds[]` manifest shape end to end, and a real working
slice of §5, §5.2, §5.4, §6, and §7: an issuer signing real credentials, a
wallet verifying them with no shared account system, that verification
holding up unchanged on a domain that was never involved in issuing it, an
owner-signed transfer that moves an item between two independent keys, a
fungible balance that splits and settles by issuing fresh signed
credentials rather than mutating anything in place, and a two-intent trade
that either settles atomically or not at all. That's the actual claim
ownership-without-a-blockchain rests on, and none of it is just written
down anymore — it runs.

It's still not hardened for anything beyond a demo, and a few
simplifications are worth naming plainly rather than leaving implicit:

- The **counterparty identity** is a second real keypair, but not a second
  WebAuthn device — see section 4 above. A production wallet would just be
  two separate installs, each with its own passkey.
- The **issuer also plays the trading station** for §7, instead of being a
  separate party the way the spec allows. The settlement logic (verify
  both intents, verify both balances, atomic issue+revoke) doesn't change
  either way — this just avoids standing up a second server for the demo.
- The issuer's endpoints (`/atlas/revoke`, `/atlas/resource/issue`, and
  so on) have no auth by design, so the tests can exercise them freely.
  The whole thing runs over plain HTTP on localhost. A real deployment
  needs real HTTPS domains and a real access-controlled issuance flow —
  the point here was proving the credential mechanisms themselves work,
  not building a production issuer.
- The renderer is still a dependency-free `<canvas>` stand-in for what a
  production client would do with WebXR and glTF, which real browsers
  already support well, so re-implementing that wasn't the point.

Nothing in `SPEC.md` remains entirely unimplemented as of this build —
§5.2, §5.4, and §7 have all moved from spec-only into working code,
alongside §3 (manifest/portals), §5/§5.1/§5.3 (items, classes,
revocation), and §6/§6.1 (identity, wallet export) from v1.1.
