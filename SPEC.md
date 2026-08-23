# Domain Atlas Protocol — Specification

**Status:** Draft v1.8 (informational, pre-standardization)
**Date:** 2026-08-25
**Author:** Bruno da Silva
**License:** All rights reserved. This specification is published publicly to establish a dated public record of its content and authorship, but no implementation, distribution, or derivative use is permitted without the author's written permission at this time. A decision on an open license is still under review.

**A note on names.** "Domain Atlas" and the `atlas` prefix used throughout (`atlas.wearable`, `/.well-known/atlas-key.json`, `domain-atlas/1.0`) are working names, not a settled brand — that decision is still open. The technical prefix is deliberately kept separate from whatever the project ends up publicly called, the way `ipfs://` outlived a dozen rebrands of the company behind it. Renaming the project later costs nothing here; only renaming the wire-level prefix would.

**Revision history.** v0.1 through v0.5 were built incrementally, each round closing one open question. v1.0 consolidated all of it into one document and applied a terminology pass (`rules` → `policy`, `category` → `profile`, `worldType` → `scale`, `allowItemDrops` → `itemDropsAllowed`). v1.1 adds the piece needed for scarcity to mean something economically rather than just cryptographically: fungible resources (§5.4) and a live cross-domain exchange mechanism (§7), aimed at letting many independently-run worlds that agree on the same resource vocabulary function as one coherent economy without any of them being in charge of it. v1.2 adds per-page discovery and anchors (§3.5) — a single page can now point straight at its own space or a specific location inside the domain's larger one, instead of every visitor landing at one shared front door. v1.3 adds one security consideration (§9) flagging the regulatory exposure of bridging real-money payments into a resource that's tradeable across domains — no schema change, just an honest warning where a domain owner would look for one. v1.4 closes a gap every prior version had without saying so: §5.2's transfer-on-loss and §7's trade intent were both specified in prose only, with no actual credential shape, and neither one works without an answer to a harder question this spec had also never addressed — how a visitor's WebAuthn passkey signs a specific application payload at all, as distinct from the simpler bare-possession proof (a fresh assertion over a random, disposable challenge) that §6 step 4 and §5 step 3 already relied on and still do. §6.2 specifies that payload-signing mechanism, and §5.2 and §7 now each give the concrete, canonical credential shape their prose already implied, built on it. No behavior described in v1.0–v1.3 changes; this is filling in wire formats a working implementation needed and found, not revising anything decided earlier. v1.5 adds a second, deliberately lower-trust way for a world to exist at all: a **key-anchored world** (§3.6), whose identity is its own signature and public key instead of a domain, for anyone who wants to publish a space without owning one. Nothing about credential verification (§5) or identity (§6) needed to change to allow this — both were already trusted by signature, not by address — only the manifest and portal shapes needed a second option. What's new is mostly the honesty required around it: an explicit client obligation (§3.6.1) to warn hard, every time, before treating a key-anchored world as anything close to a domain's guarantee, plus a third, orthogonal warning for plain HTTP — which, worked through carefully, turns out to hurt a domain-anchored world worse than a key-anchored one, not the other way around. v1.6 lets a domain-anchored world optionally borrow the same signature this version just gave key-anchored worlds, for a reason that has nothing to do with first-contact trust — TLS and DNS already own that job — and everything to do with a domain a visitor's *already seen before*: a persistent, self-signed identity a returning client can notice change even when the certificate and DNS both still check out fine, which is exactly the blind spot §9's domain-takeover bullet already admitted this spec had. §3.7 defines it, strictly optional on both ends and explicitly not a hard lock — the browser world tried a stricter version of this once (HTTP Public Key Pinning) and walked it back after it locked sites out of their own trust, so this reuses §5.3's rotation-history approach instead of a single forever-fixed key. v1.7 makes explicit something the schema already quietly allowed but the prose never actually said: `atlas-key.json` (§5.3) isn't limited to one valid key at a time. §5.3.1 sanctions concurrent keys outright — redundancy across more than one issuing server or delegate, and separate keys for separate purposes (an issuance key need not be the same key §3.7 uses to sign a manifest) — and is explicit that this was always structurally possible, just never stated, which is exactly the kind of gap worth closing before an implementer reasonably assumes the opposite. v1.8 gives a concrete wire format to something §5.4's prose already named as a design goal without ever specifying — a resource balance being "combinable (two balances of the same class becoming one)". `supersedes` (§5.4) may now hold an array of ids, not just a single id or `null`, for the case where one new balance replaces more than one old balance at once (a consolidation) rather than exactly one (a mint's remainder, a trade settlement). Every old id in the array is revoked in the same act as before, under one new §5.3 reason code, `"consolidated"` — kept distinct from `"superseded"` so a client reading the revocation list can still tell a split/trade-remainder from a merge, the same reasoning that gave `"superseded"` its own code in the first place rather than reusing `"issuer-request"`.

## 1. Overview

Domain Atlas lets any existing domain declare a spatial presence — one or more places a visitor can enter, look around, move between, and optionally carry owned items and resources across. It adds nothing to the network layer. Everything here sits on top of standard HTTPS, WebXR, and WebAuthn, and reduces to four things:

1. A **manifest** a domain publishes at a well-known path, so a client can discover that a spatial presence exists — one manifest, one or more declared **worlds**.
2. An **item credential** format for unique ownership claims, and a **resource credential** format for fungible ones (fuel, raw materials, currency) — both verifiable by any domain without trusting the issuer, a shared registry, or a token, a chain, or a gas fee.
3. An **identity flow** built on WebAuthn passkeys, where a person's identity is a public key, and email — if used at all — never reaches a visited domain.
4. A **trading mechanism** (§7) that lets two visitors — and the independent worlds their resources came from — complete a live exchange without a blockchain and without either side being able to walk away holding both sides of the trade.

Nothing here requires a new URI scheme, a new port, or client software beyond a conforming browser extension or, eventually, native browser support.

**The one rule everything else follows** (expanded in §10): the protocol carries only what has to survive leaving the domain — identity, ownership, and the minimum a stranger needs to find and understand a space before entering it. Everything that only matters inside one domain — who can build where, land records, combat balance, quest logic, in-world chat — stays the domain's own business and this spec has nothing to say about it.

## 2. Terminology

- **World** — one declared space a visitor can enter, look around, and move through.
- **Manifest** — the JSON document at `/.well-known/spatial.json` declaring a domain's world or worlds.
- **Portal** — a declared link from one world to another, same-origin or cross-origin.
- **Item** — a unique asset a visitor can own, represented by a signed credential.
- **Resource** — a fungible, stackable quantity a visitor can hold (a raw material, fuel, currency), represented by a signed balance.
- **Wallet** — the client-side store of a visitor's credentials, balances, and keys. Never transmitted whole; individual credentials are presented on request.
- **Loadout** — the subset of a wallet a visitor has explicitly brought into one world's active session.
- **Identity** — a WebAuthn-derived public key. Not a username, not an email address.
- **Anchor** — a named waypoint inside a scene, letting a link enter a world at a specific location rather than only its default spawn point.
- **Key-anchored world** — a world whose manifest is authenticated by its own signature and public key instead of by domain ownership (§3.6). Every world described before §3.6 is domain-anchored, the default this spec assumes unless it says otherwise.

## 3. The manifest

Served at `https://{domain}/.well-known/spatial.json`, `Content-Type: application/json`, cacheable, publicly readable. One manifest per domain, declaring one or more worlds:

```json
{
  "spec": "domain-atlas/1.0",
  "domain": "example.com",
  "owner": {
    "name": "Example Inc.",
    "contact": "spatial@example.com"
  },
  "defaultWorld": "plaza",
  "worlds": [
    {
      "id": "plaza",
      "name": "Example Plaza",
      "entry": {
        "scene": "/spatial/plaza/scene.json",
        "renderer": ["procedural-v1", "gltf"]
      },
      "policy": {
        "guestAccess": "open",
        "discoverable": true,
        "identityRequired": false,
        "itemDropsAllowed": true,
        "acceptedItemClasses": ["atlas.wearable", "atlas.badge"],
        "trustedIssuers": "any"
      },
      "profile": {
        "genre": "fantasy-marketplace",
        "scale": "planet",
        "capabilities": {
          "building": "owner-only",
          "vehicles": true,
          "combat": "pve",
          "landOwnership": true
        }
      },
      "portals": [
        { "kind": "world", "to": "museum", "label": "Enter the Museum" },
        {
          "kind": "domain",
          "to": "neighbor.example",
          "label": "Visit Neighbor",
          "manifest": "https://neighbor.example/.well-known/spatial.json"
        }
      ]
    },
    {
      "id": "museum",
      "name": "Example Museum",
      "entry": { "scene": "/spatial/museum/scene.json", "renderer": ["procedural-v1", "gltf"] },
      "policy": {
        "guestAccess": "open",
        "discoverable": true,
        "identityRequired": false,
        "itemDropsAllowed": false,
        "acceptedItemClasses": [],
        "trustedIssuers": "self"
      },
      "profile": {
        "genre": "gallery",
        "scale": "building",
        "capabilities": { "building": "none", "vehicles": false, "combat": "none", "landOwnership": false }
      },
      "portals": [
        { "kind": "world", "to": "plaza", "label": "Back to the Plaza" }
      ]
    }
  ],
  "updated": "2026-08-22T00:00:00Z"
}
```

Field notes:

- `worlds` is always an array, even for a domain with exactly one world. Nothing about the single-world case is more complicated for it — it's a `worlds` array of length one, `defaultWorld` pointing at it.
- `defaultWorld` is which world a plain visit to the domain resolves to — what a generic client offers first.
- `entry.renderer` is an ordered preference list; a client renders the first entry it supports. `gltf` points `entry.scene` at a `.gltf`/`.glb` asset for production use. `procedural-v1` (§3.2) is a lightweight fallback for spaces that don't want to author 3D assets — what the reference prototype uses.
- `portals[].kind` is `"world"` or `"domain"`. A `"world"` portal is a same-origin scene swap — `to` names another entry in this same manifest's `worlds` array, no network round-trip, no re-verification of anything, because the trust boundary never changed. A `"domain"` portal crosses to a different domain entirely — `to` names it, `manifest` points at its own `/.well-known/spatial.json`, and everything about crossing a real trust boundary (§5, §6) applies in full.
- `policy.guestAccess` (`"open" | "invite-only" | "private" | "closed"`) and `policy.discoverable` (`true`/`false`) are separate on purpose — "who can enter" and "who can find this at all" are different questions. A world can be wide open to anyone with the address but still `discoverable: false`, the spatial equivalent of an unlisted link. Both are enforced by the domain's own backend, not the client; the manifest states intent, the domain remains the authority.
- Absence of this file at the well-known path simply means the domain has no declared space. No error, no penalty — adoption is opt-in and additive, the same way a missing `robots.txt` is silently fine.

### 3.1 One manifest, many worlds — or many domains

A domain with several distinct spaces has two genuinely different mechanisms, and which one fits is a real decision:

**Subdomains** need nothing beyond what §3 already describes. `plaza.example.com` and `museum.example.com` are different origins as far as DNS and the browser are concerned, so each gets its own manifest, its own trust root, its own hosting, connected only by an ordinary `"kind": "domain"` portal. Use this when the worlds genuinely need separate operation — different teams, different hosting, different legal entities, a franchise where each location runs its own world under its own rules.

**One manifest, several `worlds`** is the other option. Every world in it shares one identity, one owner record, one signing key for item issuance (§5) — a visitor who trusts `example.com` trusts all of its worlds equally, and moving between them is a same-origin scene swap rather than a fresh trust decision. Use this when one operator wants several distinct spaces that should feel like rooms in one building, not separate establishments.

The two compose freely. Nothing stops a domain from having three internal worlds *and* a portal out to a fully separate partner domain — a client doesn't treat either as more "real" than the other, only as carrying different trust. The one rule that never bends: identity and item trust follow the domain boundary, never the world boundary. Worlds inside one manifest are as trusted as each other by construction; a domain reached by a `"domain"` portal is exactly as trusted as any address typed into a browser, because it is one.

### 3.2 Procedural scenes

For worlds that don't want to author glTF assets, a `scene.json` can describe a space procedurally instead:

```json
{
  "format": "procedural-v1",
  "floor": { "size": [20, 20], "color": "#1b2830" },
  "objects": [
    { "type": "box", "position": [0, 1, -3], "size": [1, 2, 1], "color": "#c05a1f", "label": "Welcome" }
  ],
  "portalMarkers": [
    { "position": [5, 0, 0], "portalIndex": 0 }
  ]
}
```

`portalMarkers[].portalIndex` indexes into that world's own `portals` array, so a client can place a walkable doorway at a specific point in the scene rather than only as a UI button.

`interactables` is the same idea applied to a world's own on-the-ground fixtures rather than its exits — a clickable point in the scene tied to a client-side action, e.g. `{ "position": [-2, 0.5, -1], "label": "Mine Iron", "action": "mint", "class": "atlas.element.iron", "quantity": 20, "role": "self" }` for a resource stall, or `{ "position": [-4, 0.5, -2], "label": "Bronze Compass", "action": "issue", "class": "atlas.wearable", "oncePerUser": true }` for an item stall. Unlike `portalMarkers`, nothing here needs a manifest cross-reference — every field an action needs travels with the marker itself. This is reference-prototype convenience, not a new protocol primitive: `interactables` itself is unsigned scene data, same as `portalMarkers` — clicking one just triggers the ordinary, already-signed §5/§5.4 issuance flow a visitor could otherwise reach through a settings panel, nothing about the credential that comes out of it is any different. `oncePerUser` is a client-side courtesy on top of that (checking this wallet's own items before asking for another) — the protocol itself has no concept of item scarcity, so this is a per-device nicety, not real enforcement.

### 3.3 Discovery

A world's `policy.discoverable` flag (§3) is what matters here — the difference between "enterable if you have the address" and "surfaced in directories and search."

**Bootstrap.** The end state looks like `sitemap.xml`: a crawler that already indexes the web adds "also check `/.well-known/spatial.json`" to its routine, the same low-cost addition sitemaps and Open Graph tags were for search engines and social platforms. That only happens once there's enough adopted content to be worth indexing, and nothing is adopted yet — the same bootstrap problem as the protocol itself, one layer up. The fix is not to wait for a major search engine: a reference implementation ships its own minimal, open directory, seeded by self-submission the way early web indexes were submitted links before crawling had a large enough graph to work from.

**A concrete interface**, so this isn't left as a suggestion:

- `POST /submit` — `{ "manifest": "https://mydomain.com/.well-known/spatial.json" }`. The directory fetches it, validates `spec` and shape, and indexes every world marked `discoverable: true`.
- `GET /search?genre=...&scale=...&combat=none` — returns matching worlds (domain, world `id`, `name`, a short description drawn straight from the manifest).

A submission naming a key-anchored world (§3.6) is verified the same way any client would verify one, not taken on faith: the directory fetches the manifest and confirms `signature` actually checks out against the submitted `identityKey` before indexing it. Search results distinguish domain-anchored and key-anchored listings rather than presenting them identically, so a client — or a visitor reading directory results directly — can decide how much weight to give each without the directory quietly flattening a real difference.

For ranking, before reaching for anything more elaborate: the count of inbound `"kind": "domain"` portals pointing at a manifest is a simple, self-computed relevance signal — the same insight PageRank started from, applied to a much smaller graph. A world other domains bother to portal to is doing something worth finding. Multi-world manifests give this a small efficiency for free: one fetch indexes every discoverable world a domain has, not one fetch per world. Anyone may run a competing directory against the same public manifests; nothing here designates one as canonical.

### 3.4 Categorization and trust

Two more things a manifest declares, both purely advertisement — a directory or client uses them to filter and warn, no enforcement lives here:

- **`profile`** — `genre` (free text, e.g. `"fantasy-marketplace"`), `scale` (`"room" | "building" | "district" | "planet" | "system" | "galaxy"` — useful for a world that's mostly a portal directory to describe itself as a `"system"` rather than a `"room"`), and `capabilities` (`building`, `vehicles`, `combat`, `landOwnership`) describing what kind of space this is before anyone walks in. `capabilities.building` is `"none" | "owner-only" | "residents" | "anyone"` — a coarse advertisement of policy, not the policy engine itself; the domain's own backend decides who actually counts as a "resident." `capabilities.combat` is `"none" | "pve" | "pvp"` and matters directly to §5.2.
- **`policy.trustedIssuers`** — `"any"` | `"self"` | an explicit array of issuer domains. Independent of `acceptedItemClasses`: class governs *what kind* of item a world knows how to render; `trustedIssuers` governs *whose* items it's willing to render at all. A world can run a closed economy (`"self"`), an open one (`"any"`), or a curated one (an explicit allowlist) — three real, different products, one field.

None of this requires hosting anything beyond the manifest itself. A domain's actual asset catalog — models, textures, authoring tools — is ordinary web hosting and application logic, entirely the domain's business; nothing here standardizes how a domain manages its own inventory, only how another domain decides whether to trust what comes from it.

### 3.5 Per-page discovery and anchors

Everything above works at the domain level — one manifest advertising the worlds a domain has as a whole. That's the right level for a directory or a crawler (§3.3), but it's the wrong level for a visitor already looking at one specific page: a product listing, a blog post, a portfolio piece. That page usually corresponds to something narrower than "the domain's world" — a specific room, a specific display, a specific place — and until now there's been no way for the page itself to say so; every visitor lands at the same `defaultWorld` front door regardless of which page brought them there.

A page opts in with one `<link>` tag in its own `<head>`, the same pattern `<link rel="alternate">` and Open Graph tags already use for per-page metadata:

```html
<link rel="spatial" href="/.well-known/spatial.json#plaza:aisle-12">
```

The fragment names a target inside that domain's existing manifest — `{worldId}` alone drops the visitor at that world's normal entry point, `{worldId}:{anchorId}` drops them at a specific named point inside it. A conforming client checks the current page for this tag before falling back to the domain-wide manifest and its `defaultWorld` — precision when a page offers it, the existing behavior when it doesn't.

This deliberately reuses the domain's already-declared worlds rather than letting a page invent a disconnected space of its own. A world only one page ever links to behaves, in effect, like that page's own standalone space — nothing requires any portal or other page to point at it. A page that links to `plaza:aisle-12` instead reads as a location inside the domain's larger, shared place. Both are the same declaration at different scales; a site owner doesn't choose between "own space" and "location in our space" in the abstract, they choose per page, and the two never collide because they're the same mechanism.

**Anchors** are the one small addition this requires to `scene.json` (§3.2) — named waypoints inside a scene, not just the single implicit spawn point a world has today:

```json
{
  "format": "procedural-v1",
  "floor": { "size": [40, 40], "color": "#1b2830" },
  "objects": [ ],
  "portalMarkers": [ ],
  "anchors": [
    { "id": "aisle-12", "position": [4, 0, -2], "label": "Aisle 12 — Hardware" }
  ]
}
```

`anchors` is optional and additive — a scene with none behaves exactly as it does today. A world only needs to name anchors for the places it expects to be linked to directly; nothing requires anchoring every corner of a large space up front, only the ones a page actually points at.

This costs nothing at the trust layer. §3.1's rule holds without change: identity and item trust still follow the domain boundary, never the world boundary — an anchor is only ever a position inside a world the domain already declared and already owns the policy for, never a new trust surface of its own.

### 3.6 Key-anchored worlds — spaces without a domain

Everything above assumes a world's trust comes from a domain: whoever controls the DNS and the TLS certificate controls what the manifest says, and that's the entire basis for believing any of it. That's a deliberate choice, and a good one for anything that wants to be found and recognized at a glance — but it also means the barrier to publishing a world is the barrier to owning a domain: money, DNS, hosting. Not everyone who wants a space clears that bar, and nothing about the credential mechanisms in §5 or §6 actually requires it — an item credential is already trusted by its signature, not by where it's hosted. A **key-anchored world** applies the same idea to the manifest itself.

Instead of `domain`, its manifest carries the owner's own public key and a signature over its own content:

```json
{
  "spec": "domain-atlas/1.0",
  "identityKey": "base64url-space-owners-public-key",
  "owner": {
    "name": "Alex's Workshop",
    "contact": "alex@example.net"
  },
  "defaultWorld": "workshop",
  "worlds": [ ],
  "updated": "2026-08-25T00:00:00Z",
  "signature": "base64url-signature-over-canonical-manifest-minus-signature"
}
```

`worlds` inside a key-anchored manifest is the exact same shape §3 already defines — worlds, portals, policy, profile, nothing about them changes. A manifest with `domain` is domain-anchored, verified exactly as §3 already describes: trust comes from TLS and DNS, nothing new. A manifest with `identityKey` and no `domain` is key-anchored: a client verifies it by canonicalizing the manifest with `signature` removed (§6.2's canonicalization, reused unchanged) and checking `signature` against `identityKey`. Its authenticity doesn't depend on where the file happens to be hosted — a directory service, a personal file host, anywhere willing to serve JSON over HTTPS — because the proof travels with the content instead of being vouched for by whichever server happens to be holding it.

A portal or directory entry names a key-anchored world by its key, not a hostname:

```json
{
  "kind": "key",
  "identityKey": "base64url-space-owners-public-key",
  "manifest": "https://directory.example/spaces/alex-workshop/spatial.json",
  "label": "Visit Alex's Workshop"
}
```

A client fetches `manifest`, verifies its signature against `identityKey`, and confirms both match the portal's own declared `identityKey` — so nothing hosting that URL can quietly swap in a different key-anchored world underneath an existing link.

**Issuing items and resources without a domain.** Nothing in §5 requires a domain either — an item is already trusted by its issuer's signature, not its address. An issuer's key document today lives at `https://{issuer.domain}/.well-known/atlas-key.json`, a location only meaningful because of domain ownership. A key-anchored issuer instead names that document directly: `issuer` on an item or resource credential may be `{ "identityKey": "...", "keyDocument": "https://wherever-its-hosted/atlas-key.json" }` in place of `{ "domain": "...", "publicKey": "..." }`. Verification step 1 in §5 generalizes accordingly — fetch whichever key document the credential actually names — everything after that (confirming validity at `issuedAt`, checking the signature, checking revocation) is unchanged.

**What this deliberately doesn't solve.** A domain is scarce and human-legible — nobody else can be `anthropic.com`, and a stranger can recognize that string on sight. A public key is neither: anyone can generate as many as they like, and nobody can eyeball one and know whose it is. A key-anchored world's signature proves the manifest wasn't tampered with and genuinely came from whoever holds that key — it proves nothing about who that is. That's not a flaw to quietly work around; it's the actual trade-off for not needing a domain, and §3.6.1 exists because a client can't be honest with a visitor without saying so plainly.

Nothing stops a key-anchored world from later adding a real domain without losing continuity. §3.7's optional domain identity pinning is exactly the field for it: a domain-anchored manifest can publish the same `identityKey` its key-anchored past used, and a client that's seen both can treat it as one continuous world rather than two unrelated ones.

### 3.6.1 Client trust signaling

A conforming client must never render a key-anchored world the same way it renders a domain-anchored one — silently treating both as equally trustworthy would erase exactly the distinction §3.6 exists to be honest about. Before entering one, a client must show a real, unavoidable disclosure — not a dismissible toast, not fine print — the same way §5.2 already requires a real warning before loading an item into a PvP world:

- **Any key-anchored world**, at minimum: a clear statement that this space isn't tied to a registered domain, and that its identity rests entirely on a cryptographic key the visitor has no independent way to recognize.
- **A key-anchored world absent from every directory (§3.3) the client checks** — reached only by a raw link, a pasted address, a QR code — is stronger still: nothing beyond that one link vouches for it at all. A client should present this the way a browser presents an invalid-certificate page: a real interstitial requiring an explicit, deliberate action to proceed, not a warning that quietly gets out of the way on its own.
- **A key-anchored world listed in at least one known directory** may say so in its disclosure — being indexed is a weak positive signal, since a directory can at least confirm the signature checks out and the entry hasn't been reported (§8) — but a client must not present that listing as equivalent to domain ownership. It isn't.

**Plain HTTP, for either anchor type, is worse than either warning above and must block harder.** This is independent of which trust model a world uses, and worth being exact about why. A key-anchored manifest's `signature` still protects its integrity even if fetched over plain HTTP — tampering breaks the signature regardless of transport — but the connection itself is now unencrypted and unauthenticated at the transport layer, open to monitoring or blocking. A domain-anchored manifest has it worse: TLS was never just encryption for it, it was the *entire* mechanism proving domain ownership, so a domain-anchored manifest fetched over plain HTTP has silently lost its whole basis for trust — worse off than an honestly-labeled key-anchored world, which at least still has its own signature to fall back on. A conforming client must treat any manifest, scene, key document, or issuance endpoint fetched over plain HTTP as a hard failure requiring explicit override, the same way a browser treats its own bad-certificate interstitial, and must never silently downgrade a failed HTTPS fetch into a "working" HTTP one.

### 3.7 Optional domain identity pinning

§3.6 gave a world without a domain its own signature to be trusted by. This section gives that same signature to a world that *has* a domain, for a different reason — not to replace TLS and DNS as the first-contact trust root, which they already do well, but to give a visitor's client something to notice with on every visit after the first.

A domain-anchored manifest may optionally add two fields alongside `domain`:

```json
{
  "domain": "example.com",
  "identityKey": "base64url-current-public-key",
  "signature": "base64url-signature-over-canonical-manifest-minus-signature"
}
```

`identityKey` names the domain's current signing key; `signature` covers the canonical manifest with `signature` itself removed, verified exactly as §3.6 already describes — the same canonicalization §6.2 defines, reused a third time now. The key it points at lives in the same rotation-safe document §5.3 already defines for issuer keys — `.well-known/atlas-key.json` — whether or not this domain runs an item issuer at all; a domain with no items to issue may still publish one purely to back this signature, and a domain that does issue items may reuse the same key for both or keep them entirely separate — §5.3.1 covers running more than one concurrently valid key for exactly this kind of purpose separation.

**What a client actually does with this.** On a first visit, nothing changes — there's no memory to compare against, so `identityKey` adds nothing a new visitor didn't already get from TLS and DNS, and a client that ignores this section entirely loses nothing it had before. The value shows up on a *return* visit: a client that chooses to remember a domain's `identityKey` (this is opt-in for the client, exactly as publishing it is opt-in for the domain) can compare what it remembers against what the manifest declares today. A changed key that the domain's current key-history document also lists as a deliberately rotated prior key is an ordinary, expected event — no different from any other key rotation in §5.3, and worth no more than a routine update to what the client remembers. A changed key with no rotation record anywhere is the actual signal: the domain still passes TLS, DNS still resolves, and the certificate is still perfectly valid, yet something a repeat visitor previously verified has quietly changed underneath all of that. A client should disclose this plainly rather than staying silent about it — but, deliberately, it should not hard-block the way §3.6.1 requires for a key-anchored world or plain HTTP. The domain's ordinary trust basis hasn't broken; this is one additional, optional signal layered on top of it, not a replacement for it, and treating an unexplained key change as an unrecoverable lockout is precisely the mistake HTTP Public Key Pinning made before browsers walked it back. A domain that loses its identity key, or never rotates it correctly, should end up with a client that's mildly suspicious on next visit — never one that refuses to load the site at all.

**A second, smaller use.** The same `identityKey` may appear on more than one domain's manifest — an operator running several domains, or a domain and a partner-hosted subdomain, can publish the same key on each to signal they're the same publisher without needing a shared parent domain to prove it. A directory (§3.3) or reputation feed (§8) may use this to link entries belonging to one operator, but a client should trust that link exactly as much as the signature backing it and no more — it's a claim the operator is making about themselves, not an independent confirmation from anyone else.

## 4. Rendering

Scenes render with WebXR directly in the browser, assets delivered as glTF over ordinary HTTPS — no plugin, no new codec, no new transport. This isn't a gap the protocol needs to fill: browser support for WebXR is already broad, and re-solving 3D delivery wasn't the point of this spec. §3.2's procedural fallback exists only for worlds that would rather describe a space in a few lines of JSON than author a 3D asset — the reference prototype's renderer is a deliberately dependency-free stand-in for what a production client does with WebXR and glTF directly.

## 5. Item credentials (ownership)

An item is a signed claim, not a database row. Any domain can verify it without a shared account system:

```json
{
  "credential": "domain-atlas-item/1.0",
  "id": "urn:atlas:item:9f2a6e1c-9b3d-4a2e-8c31-1e6b2f0a7d44",
  "issuer": {
    "domain": "example.com",
    "publicKey": "base64url-ed25519-public-key"
  },
  "asset": {
    "name": "Bronze Compass",
    "class": "atlas.wearable",
    "model": "https://example.com/assets/compass.glb",
    "thumbnail": "https://example.com/assets/compass.png",
    "properties": {
      "atlas.rarity": "common",
      "com.example.era": "Victorian"
    }
  },
  "owner": {
    "publicKey": "base64url-visitor-passkey-public-key"
  },
  "issuedAt": "2026-08-22T00:00:00Z",
  "signature": "base64url-signature-over-canonical-payload"
}
```

The issuer signs the canonical JSON of `{id, asset, owner, issuedAt}`. Verification by any third domain requires no call back to the issuer:

1. Fetch the issuer's published signing key at `https://{issuer.domain}/.well-known/atlas-key.json` and confirm `issuer.publicKey` was valid at `issuedAt` (§5.3 covers why this is a small key history, not one key). This anchors trust in the same domain-ownership root as the manifest itself — whoever controls the domain controls the key, nothing else to bootstrap.
2. Verify `signature` over the canonical payload.
3. Challenge the visitor for a fresh WebAuthn assertion proving they currently hold the private key for `owner.publicKey`. This is what stops a copied credential file from being usable by anyone but the actual owner — possession of the JSON is not possession of the item.
4. Confirm `id` isn't present on the issuer's revocation list (§5.3).

**On terminology.** This mechanism — a portable, cryptographically verifiable ownership claim independent of any platform — is the property NFTs were reaching for, without a token, a chain, or a gas fee. Keep the mechanism; don't borrow the vocabulary. A domain **issues** a credential, it doesn't "mint" one. A visitor **holds** an item, they don't "own an NFT of" it. Calling this an open credential standard rather than a token scheme is both more accurate and doesn't drag in 2022's baggage by association.

### 5.1 Item classes — interoperability without a central catalog

A credential proves *who owns what*. It says nothing about whether the world the owner just walked into knows what to *do* with the thing — whether "Bronze Compass" should render as a wearable, sit on a shelf, or be ignored. That's what `asset.class` is for. A world declares which classes it recognizes (`policy.acceptedItemClasses`, §3); an item outside that list still exists and is still verifiably owned, the world just has no defined behavior for it, and a well-behaved client falls back to an inert collectible rather than failing.

The classes are a namespace, not a catalog someone approves you into:

- **`atlas.*`** is reserved for a small, deliberately boring set of core classes published alongside this spec — `atlas.wearable`, `atlas.badge`, a handful of others — maintained the way Khronos maintains glTF's `KHR_*` prefix: a shared name nobody needs permission to use and nobody can be denied. (`atlas.currency`, mentioned in earlier drafts as a core class, turned out to belong to §5.4 instead — currency is fungible, and this credential shape only fits unique, one-of-a-kind things.)
- **Anything else uses reverse-domain naming** — `com.example.compass` — the same convention Java packages and Android use to avoid collisions. Any domain can mint a custom class with zero coordination; a class that turns out to be broadly useful is a candidate for eventual promotion into `atlas.*`.

This is closer to a MIME type registry than a marketplace: minimal shared vocabulary for the common cases, an open namespace for everything else, no single party who can reject an item type.

`asset.properties` extends the same idea from *what kind of thing this is* down to *arbitrary facts about this particular one* — rarity, an era, a stat block, anything a creator wants a collectible to carry. It's an open object, not a fixed schema: a domain can add a new key the moment it mints a new item, with no coordination and no registration, the same way it can mint a new `asset.class`. The same two-tier namespace applies — `atlas.*` for a small shared vocabulary worth standardizing (`atlas.rarity` and the like), reverse-domain keys (`com.example.era`) for everything a single creator invents on their own. `properties` is entirely optional and, being part of `asset`, is covered by the same signature as `name`, `class`, and `model` — a verifier that doesn't recognize a given key just doesn't render it, exactly as it already falls back gracefully on an unrecognized `asset.class`. This covers facts fixed at mint time. Properties that change during play — durability, damage, charge — are a different problem: `asset` is inside the signed payload, so nothing in it can be edited after issuance without invalidating the signature. Giving an item mutable state means revoking the old credential and issuing a replacement (the same `supersedes`-linked reissue pattern §5.4 already uses for resource balances) — a real feature, deliberately left for later rather than folded into this static properties bag.

### 5.2 Loadouts and consequence

Owning an item and putting it at risk inside one world are different acts, kept different on purpose — it's what makes visiting a `"pvp"` world safe to do at all without exposing an entire wallet everywhere a visitor goes.

- **Wallet** — everything a visitor holds a valid credential for. Always safe, regardless of which worlds they've visited.
- **Loadout** — the subset of the wallet presented into one world's active session (an "equip" action in the client, using the same per-presentation WebAuthn assertion already required above). Only loadout items are ever subject to that world's rules.

A conforming client checks `profile.capabilities.combat` before letting a visitor load anything. If it isn't `"none"`, the client must show a real warning — *"items you load here can be lost under this world's rules; anything left in your wallet stays safe"* — and refuses to load silently.

**Transfer on loss.** A world cannot unilaterally reassign an item it didn't issue — if it could, any world could flip on `"combat": "pvp"` and help itself to visitors' portable belongings, quietly undoing everything above. Authority to transfer an item stays with whoever holds its private key, full stop. What a PvP world's rules actually trigger is the *loser's own client* co-signing a transfer credential to the winner's public key, using the same key that already proved ownership — pre-authorized the moment the visitor chose to load that item into a world they knew was flagged `"pvp"`. The world referees the event; the owner's key is what makes the transfer valid everywhere the item travels next. No world, including the one where the loss happened, can produce a valid transfer for an item it doesn't hold the key to. Net effect: the only new capability a hostile world gains is convincing an informed, consenting visitor to load an item there — never a way to reach into anyone's wallet.

The transfer itself is a small, self-contained credential, signed by the loser's key using the proof mechanism §6.2 defines:

```json
{
  "credential": "domain-atlas-transfer/1.0",
  "itemId": "urn:atlas:item:9f2a6e1c-9b3d-4a2e-8c31-1e6b2f0a7d44",
  "from": { "publicKey": "base64url-losers-passkey-public-key" },
  "to": { "publicKey": "base64url-winners-public-key" },
  "worldContext": { "domain": "example.com", "world": "arena" },
  "transferredAt": "2026-08-24T00:00:00Z",
  "proof": {
    "signerRole": "webauthn",
    "publicKey": "base64url-losers-passkey-public-key",
    "clientDataJSON": "base64url",
    "authenticatorData": "base64url",
    "signature": "base64url-der-ecdsa-signature"
  }
}
```

`proof` covers `{itemId, from, to, worldContext, transferredAt}` under §6.2's mechanism. Anyone holding this credential — the winner, the world that refereed the loss, a third domain the item later travels to — can verify it independently: recompute the payload hash, confirm `proof.publicKey` matches `itemId`'s currently-recorded owner (the same lookup §5 step 1 already does against the issuer's key), and verify the signature. `worldContext` exists so a verifier, or a later dispute, can see *which* world's rules the loss happened under without that fact needing to live anywhere else. This is not a new credential type competing with §5's item credential — it's the event that changes an existing item credential's `owner` field the next time that item is re-issued or re-presented; a conforming implementation treats a verified transfer as authoritative over who `owner.publicKey` names for that `id` going forward, the same way a revocation (§5.3) is authoritative over whether an `id` is still valid at all.

### 5.3 Revocation and key rotation

An issuer publishes revocations alongside its signing key:

```json
// https://example.com/.well-known/atlas-revocations.json
{
  "revoked": [
    { "id": "urn:atlas:item:9f2a6e1c-9b3d-4a2e-8c31-1e6b2f0a7d44", "revokedAt": "2026-09-01T00:00:00Z", "reason": "refunded" }
  ]
}
```

`reason` (`"refunded"` | `"duplicate-exploit"` | `"compromised-key"` | `"issuer-request"` | `"superseded"` | `"consolidated"`) is informational; revoked is revoked regardless of why. `"superseded"` is what a resource balance uses when it's replaced by a newer one issued from it (§5.4) — a split's remainder, a trade's settlement. `"consolidated"` is the same idea for the opposite direction: several balances revoked at once because one new balance now replaces all of them together (§5.4's `supersedes` array). Clients cache this list the way they cache the manifest, short TTL — checking a wallet against it shouldn't mean a network round trip per item on every portal crossing.

Key rotation is the sharper edge of the same problem: a single signing key with no history means a compromise leaves no way to tell a credential the real owner signed from one forged afterward. So `atlas-key.json` holds a small history instead of one key:

```json
// https://example.com/.well-known/atlas-key.json
{
  "keys": [
    { "publicKey": "base64url-current-key", "validFrom": "2026-08-01T00:00:00Z", "validUntil": null },
    { "publicKey": "base64url-old-key", "validFrom": "2025-01-01T00:00:00Z", "validUntil": "2026-08-01T00:00:00Z" }
  ]
}
```

An item issued last year under a since-rotated key still checks out, because verification confirms the key was valid *at `issuedAt`*, not that it's current. A genuine compromise is handled by both mechanisms together: rotate immediately (close the compromised key's `validUntil`) to stop new forgeries, then revoke by `id` any credential issued during the suspected compromise window. Rotation limits future damage; revocation cleans up what already happened.

### 5.3.1 Concurrent keys

The example above shows sequential rotation — one key's `validUntil` meeting the next one's `validFrom` exactly — because that's the common case, but nothing about verification (§5 step 1: was this key valid at `issuedAt`) actually requires the entries in `keys` to be exclusive. Two or more can be valid at once. That's an intentional capacity of the schema, not an accident of it, even though nothing before this version ever said so — worth stating plainly rather than leaving an implementer to assume the opposite and write a verifier that breaks the moment two entries are valid at the same time.

A domain has two distinct reasons to want this:

**Redundancy and delegation** — more than one key valid for the *same* purpose at once, so no single key is a single point of failure. A domain might run issuance from two independent servers, each holding its own key, so rotating or losing one doesn't halt the other; or delegate issuance to a partner team or vendor under a key that's entirely separate from its own, revocable on its own schedule without touching anything else:

```json
{
  "keys": [
    { "publicKey": "base64url-primary-issuer-key", "validFrom": "2026-01-01T00:00:00Z", "validUntil": null, "label": "primary issuer" },
    { "publicKey": "base64url-partner-issuer-key", "validFrom": "2026-06-01T00:00:00Z", "validUntil": null, "label": "partner: example-vendor" }
  ]
}
```

`label` is optional and purely informational — a human-readable note for whoever's reading the document, the same non-enforced advertisement role `profile` and `policy` fields already play elsewhere (§3.4). A verifier ignores it entirely; nothing about credential verification changes for having it.

**Purpose separation** — a different key for a different job, rather than one key stretched across everything a domain signs. §3.7's manifest identity signature and §5's item issuance never had to share a key; a domain can publish one key it only ever uses to sign its manifest and a separate one it only ever uses to sign items, both living in the same `atlas-key.json`. Nothing in the document itself needs to say which entry is for which purpose — purpose is always declared by whoever's *using* the key, never by the key document: a manifest names its own `identityKey` (§3.7), an item credential names its own `issuer.publicKey` (§5). `atlas-key.json` only ever answers one question, for any number of concurrent keys or purposes behind it — was this specific key valid at this specific moment.

**Revocation and rotation stay per-key.** If one of several concurrent keys is compromised, closing its `validUntil` and revoking credentials issued under it during the compromise window (the existing procedure above) doesn't touch any other currently-valid key. Each entry's history is independent, the same way each item's revocation is independent of every other item's.

### 5.4 Fungible resources

A unique item (§5) only ever needs the owner's own key again — that's the whole point of §5.2, nobody but the owner can move it. Raw materials, fuel, currency don't fit that shape: nobody wants a separate signed file for each of the 47 units of iron they're carrying, and giving a friend 10 of them shouldn't require getting a whole new item issued from scratch. That's what a resource credential is for — a balance, not a collectible:

```json
{
  "credential": "domain-atlas-resource/1.0",
  "id": "urn:atlas:resource:9f2a6e1c-9b3d-4a2e-8c31-1e6b2f0a7d44",
  "issuer": {
    "domain": "example.com",
    "publicKey": "base64url-ed25519-public-key"
  },
  "class": "atlas.element.iron",
  "quantity": 47,
  "owner": {
    "publicKey": "base64url-visitor-passkey-public-key"
  },
  "supersedes": null,
  "properties": {
    "atlas.purity": "99.9%"
  },
  "issuedAt": "2026-08-22T00:00:00Z",
  "signature": "base64url-signature-over-canonical-payload"
}
```

Verification is the same four steps as §5. `properties` is the same open, optional bag §5.1 defines for items — with one added constraint specific to a fungible balance: it's a function of `class`, not of the individual balance. An issuer attaches whatever properties that class carries every time it signs a new balance of it (mint, split, consolidate, trade), so two balances of the same class from the same issuer always carry identical properties by construction. That constraint isn't arbitrary — it's what keeps §5.4.1's consolidation sound. Consolidation merges same-class balances purely by summing `quantity`; if two balances of "iron" could carry different purities, merging them would silently blend or discard a fact a holder might actually care about. Keeping properties per-class rather than per-balance means there's never a second value to lose. `supersedes` names the `id`(s) of the balance this one replaces: `null` for a first issuance, a single `id` for the common case of one balance becoming one new balance (a split's remainder, a trade settlement), or an array of ids when several balances are consolidated into this one (§5.4.1). Whichever shape it takes, the issuer revokes every named old `id` — `"reason": "superseded"` for the single-id case, `"consolidated"` for the array case (§5.3) — in the same act as signing the new one, so there's never a moment where two conflicting balances both look valid.

**`class`** reuses the item namespace (§5.1), with a reserved family built for exactly this: `atlas.element.*`, one entry per element on the periodic table (`atlas.element.iron`, `atlas.element.carbon`, `atlas.element.hydrogen`, …) — a shared resource vocabulary that cost nothing to standardize, because chemistry already agreed on it before this spec existed. `atlas.currency` and `atlas.energy` sit alongside it in the same reserved, permissionless family for the non-elemental cases every economy still needs.

**Why a balance instead of a key alone.** This is a real trade-off against §5.2's independence, not an oversight. A unique item's owner can move it forever without the issuer's involvement, because there's nothing to split — the whole thing moves or it doesn't. A resource has to be splittable (give away 10 of 47) and combinable (two balances of the same class becoming one), and only whoever is authorized to sign a new number can do that arithmetic validly — the owner's key alone can't turn a valid "47" into a valid "37," any more than a person can validly rewrite their own bank balance. So a resource credential is initiated by the owner (their WebAuthn assertion authorizes the request, the same challenge-response as issuance in §6) but finalized by whichever domain currently holds issuing authority over that balance — starting with the original issuer, and reassignable, as §7 covers next, to a trading station for the moment a trade actually clears.

#### 5.4.1 Consolidating balances

The combinable half of the trade-off above, made concrete: a wallet accumulates separate balances of the same `class` over time (minted twice, received as a split's remainder and separately as a gift, and so on), and nothing about holding several of them separately is wrong — each verifies independently. Consolidating them into one is a convenience, not a correctness requirement, and it's bound by the same rule as splitting: only whoever finalizes resource credentials for that balance can validly produce the merged total, so this is issuer-mediated the same way a split is, not something a wallet can do to its own records unilaterally.

A consolidation request names two or more balances that all share the same `class`, the same `issuer`, and the same `owner.publicKey` — a domain has no basis to merge balances across different owners, and merging across classes or issuers isn't merging at all. The issuer verifies each named balance the same way it would before honoring a split (signature checks out, not already revoked, owner matches), sums their `quantity`, and signs one new balance for the total, with `supersedes` set to the array of every id it replaces. The old balances are revoked with `"reason": "consolidated"` (§5.3) only once the new balance has been signed, so a failure partway through never leaves a wallet with both an unmerged balance and no merged one to replace it.

## 6. Identity

1. **Registration.** A visitor creates an identity once, client-side: `navigator.credentials.create()` (WebAuthn) generates a keypair in the device's authenticator. The private key never leaves secure hardware. The public key *is* the identity.
2. **No email in the protocol.** Email, if a client offers it at all, is a human-friendly recovery handle for linking a new device's passkey to an existing identity — out-of-band, client-side, never transmitted to a visited domain. A domain owner never sees a visitor's email through this protocol.
3. **Issuance.** When a world wants to grant an item or resource, it issues a WebAuthn challenge; the visitor's client signs it with the passkey, proving control of the public key the domain then binds the credential to (§5).
4. **Presentation.** Walking through a portal carries the wallet, not an account. Each world a visitor's items are checked against re-verifies independently — there is no session to hand off, no SSO provider in the loop.

### 6.1 Wallet portability

The private key doesn't need a bespoke sync mechanism — passkeys already sync across a person's devices through the platform they're on (iCloud Keychain, Google Password Manager, cross-platform FIDO multi-device credentials), correctly a solved problem this spec has no business touching.

What's left is syncing the *credentials* a wallet holds — and those aren't secret. A credential is a signed public claim; anyone can read one, and it's useless to anyone but its owner because presenting it still requires a live WebAuthn assertion only the private key can produce. That changes the shape of the problem: wallet sync needs no trusted channel, because nothing confidential moves through it. So rather than a sync protocol, this spec defines a portable export *format* — `atlas-wallet-export/1.0`, a plain JSON array of held credentials and balances — and leaves the channel to the client: a browser's own account sync, a manual export, or whatever a future client invents. Any of them work, because the format is what needs to be shared, not the channel.

### 6.2 Signing application data with a passkey

Presenting a credential (§6 step 4, §5 step 3) only ever needs to prove *possession* — a fresh assertion over a random, disposable challenge, discarded the moment it's checked. WebAuthn does that natively; there's no gap there. Co-signing a transfer (§5.2) and signing a trade intent (§7) need something stronger: a signature *over a specific payload*, one a third party can later hold up against that exact `itemId` or that exact `offer`/`want` pair and confirm it's what was actually signed — not just that the visitor's key was live at some moment. `navigator.credentials.get()` doesn't take arbitrary bytes to sign for that purpose; it takes a `challenge`, and the signature WebAuthn returns is over a fixed structure the authenticator builds itself (`authenticatorData || SHA-256(clientDataJSON)`), not over an application payload directly. A spec that just says "sign the payload" for a WebAuthn-bound key is describing something WebAuthn cannot do as stated.

The fix is standard practice wherever passkeys sign application data, not something invented here: set the `challenge` to a hash of the payload, and let the verifier walk the chain back.

1. **Canonicalize.** Serialize the payload object with sorted keys at every level, no insignificant whitespace, UTF-8 — the same deterministic form `signature` already presumes everywhere else in this spec (§5, §5.4), made explicit here because two independent implementations need to produce byte-identical output or nothing verifies.
2. **Hash.** `challenge = SHA-256(canonicalize(payload))`.
3. **Sign.** Call `navigator.credentials.get()` with that challenge. The authenticator returns `clientDataJSON` (which embeds the challenge, base64url-encoded), `authenticatorData`, and `signature` — a real assertion, not a workaround; this is the intended use of the `challenge` field, just with an application-defined hash in it instead of a server-issued nonce.
4. **Wrap.** Package the result as a **proof envelope**, attached to whatever it's proving:

```json
{
  "signerRole": "webauthn",
  "publicKey": "base64url-visitor-passkey-public-key",
  "clientDataJSON": "base64url",
  "authenticatorData": "base64url",
  "signature": "base64url-der-ecdsa-signature"
}
```

**Verification** reverses the steps: canonicalize the same payload, hash it, confirm that hash matches the `challenge` embedded in `clientDataJSON`, then verify `signature` over `authenticatorData || SHA-256(clientDataJSON)` against `publicKey` — P-256 assertion signatures are DER-encoded ASN.1, so a verifier written against raw `r‖s` ECDSA (as most non-WebAuthn crypto libraries expect) needs one small conversion step first. None of this is new trust; it's the existing WebAuthn ceremony, pointed at a payload instead of a bare nonce.

`signerRole` exists so a proof envelope names how it should be checked rather than a verifier having to guess. This spec defines exactly one valid value for a real visitor's authority: `"webauthn"`, per above — consistent with §6's identity model, where an identity *is* a passkey-derived public key and nothing else. A test harness or reference client that needs to simulate a second visitor without a second physical authenticator may substitute an ordinary keypair and a different `signerRole` value for its own internal testing, but a conforming implementation must never accept `signerRole !== "webauthn"` as proof of a visitor's authority in production — that would quietly reopen exactly the account-system dependency §6 exists to avoid.

## 7. Trading stations

A trading station is nothing new architecturally — it's a world (§3), like any other, that a client can recognize by `profile.genre` as a venue for live exchange. What's new is the swap itself: two visitors, possibly holding resources issued by two different domains that have never heard of each other, need to trade in real time without either one being able to walk away holding both sides.

This is the same problem real exchanges have always had to solve, and it doesn't need a blockchain to solve it — a station just needs to referee one trade the way §5.2 already has a world referee a PvP loss:

1. **Intent.** Both visitors sign their own proposed trade with their own passkey — *"I'll give 10 `atlas.element.iron`, I want 5 `atlas.element.gold`, from this specific counterparty, expiring at this time."* Nothing has moved yet; this is a signed offer, not a transfer. The intent itself is a small credential, signed the way §6.2 defines:

```json
{
  "credential": "domain-atlas-trade-intent/1.0",
  "offer": { "class": "atlas.element.iron", "quantity": 10 },
  "want": { "class": "atlas.element.gold", "quantity": 5 },
  "from": { "publicKey": "base64url-this-visitors-public-key" },
  "counterparty": { "publicKey": "base64url-other-visitors-public-key" },
  "expiresAt": "2026-08-24T00:10:00Z",
  "proof": {
    "signerRole": "webauthn",
    "publicKey": "base64url-this-visitors-public-key",
    "clientDataJSON": "base64url",
    "authenticatorData": "base64url",
    "signature": "base64url-der-ecdsa-signature"
  }
}
```

`proof` covers `{offer, want, from, counterparty, expiresAt}`. Each visitor presents their own intent alongside a resource balance (§5.4) sufficient to cover `offer`; the station verifies both independently before Match ever runs, the same possession check §5 step 3 already requires for any other presentation.
2. **Match.** The station checks that the two signed intents mirror each other exactly: intent A's `offer` equals intent B's `want`, intent B's `offer` equals intent A's `want`, each names the other's `publicKey` in `counterparty`, and neither `expiresAt` has passed. If any of that fails, nothing happens.
3. **Settle.** Only once both intents are present and matched does the station finalize: for items, the same owner-signed transfer §5.2 already defines; for resources, the station issues fresh balance credentials to both parties, each `supersedes`-ing what they held before (§5.4), and revokes the pre-trade balances in the same act.
4. **Atomicity.** Both sides settle together or neither does. A station that only received one half of a matched pair — the counterparty walked away, the connection dropped, whatever — holds an unmatched intent that expires and changes nothing. There's no partial-trade state visible outside the station.

**The trust surface, stated plainly.** A visitor is trusting the station for the few seconds one trade takes to clear — not with custody of their wallet, not indefinitely, only with correctly matching and settling this one exchange. That's a much narrower thing to trust than a whole platform, and it's the same trust a person already extends to a real-world market operator or exchange desk. Nothing stops many independent stations from existing — no protocol field designates one as canonical, the same anti-monopoly shape as the discovery directory (§3.3) and reputation feeds (§8).

**A further-out option, not v1.** A visitor who doesn't want to trust even the station for those few seconds can use a hash-time-locked exchange — the same cryptographic technique cross-chain crypto trades use for a fully trustless atomic swap, built from plain public-key primitives, no blockchain required. It's real and it's more machinery than a first version needs; noted here as the honest upgrade path rather than specified now.

## 8. Moderation and reputation

Domain sovereignty (§10) rules out a central authority deciding which worlds are acceptable — that would recreate exactly the platform gatekeeper this approach exists to avoid. But "no central authority" doesn't mean "no signal." The web already runs a working pattern: Google Safe Browsing doesn't gate which sites may exist, it publishes a list of known-bad ones a browser consults and acts on independently, and email's DNS blocklists have handled abuse the same way for two decades — list and infrastructure kept separate, anyone free to run a competing list. The same shape applies here, deliberately kept outside the manifest:

- **Reputation feeds** are an ecosystem-layer service, not a protocol field. Any party can publish one — `{ "manifest": "...", "reason": "...", "reportedAt": "..." }` entries at whatever URL they choose. A domain never declares its own reputation; nothing in its manifest says "trust me," because that would be exactly as useless as it sounds coming from the domain itself.
- **Clients and directories subscribe voluntarily** and decide what to do with a hit — warn before entry, exclude from search, refuse to auto-render without confirmation. Nobody is required to consult any feed, or any feed at all.
- **Reporting** mirrors the discovery directory's submission endpoint (§3.3): a `POST /report`, reviewed by a person before it affects anything — auto-actioning raw reports would just hand out a brigading tool.

This is a mitigation, not a solution, worth saying plainly rather than marking closed: a new bad actor is unlisted until reported, competing feeds can disagree, and nothing stops a client from checking none at all. The same limit every blocklist-based system on the internet already lives with, Safe Browsing included.

## 9. Security considerations

- **Issuer key compromise** is scoped to that one domain, the same blast radius as a compromised TLS certificate — not systemic, since there's no shared registry to poison.
- **Visitor key loss** (lost device, no passkey backup) means losing access to items and resources issued to that key, the same failure mode as losing a hardware wallet. Recovery is a client/UX problem, deliberately kept outside the protocol.
- **Replay** of a presented credential is prevented by requiring a fresh WebAuthn assertion per presentation, not by trusting a cached proof.
- **Domain takeover** inherits the same trust an attacker who gains control of a domain already has over its TLS certificate and DNS — no new attack surface beyond what domain ownership already grants. Optional domain identity pinning (§3.7) narrows this, but only for a visitor whose client already remembered the domain's key from before — an attacker who takes over the domain still can't produce a valid signature under the old key, so a returning visitor's client can notice the change even though the certificate and DNS both check out perfectly. It gives nothing to a first-time visitor, and nothing at all to a client that never chose to remember the key in the first place.
- **Revocation and reputation lists** inherit the same domain-ownership trust root as everything else (they're hosted at the issuer's own `.well-known` path) — no new infrastructure to compromise beyond the domain itself.
- **A misbehaving trading station** (§7) can, at worst, refuse to settle a trade or stall it until the intent expires — it never gains custody of a wallet and can't produce a valid transfer for anything it wasn't handed matched, signed intents for. Its blast radius is bounded to trades routed through it, not to anyone's holdings generally.
- **Key-anchored world impersonation.** A key-anchored world (§3.6) has no domain-ownership backstop — its signature proves the content is unaltered and genuinely came from whoever holds that key, nothing more. A bad actor can generate a key and a plausible-sounding name exactly as easily as a good actor can. This is why §3.6.1 requires an explicit, hard-to-miss disclosure rather than treating a key-anchored world as equivalent to a domain-anchored one; reputation feeds (§8) and directory listings (§3.3) are the only mitigation, and both are voluntary and incomplete for the same reasons already noted in §8.
- **A key-anchored world's identity has no recovery path.** Losing the private key behind an `identityKey` (§3.6) is unrecoverable in the same way losing a visitor's passkey is (above) — except a domain-anchored world can at least fall back on proving continuity through DNS if it ever needs to, and a key-anchored world has nothing else to reach for. The only mitigation is the same key-history mechanism §5.3 already defines for issuers: a new identity claiming continuity with an old one has to say so explicitly, and a client only believes that claim if it can actually verify it.
- **Plain HTTP silently strips more from a domain-anchored world than from a key-anchored one.** §3.6.1 covers the client-behavior requirement; stated here as a security fact rather than a client obligation: a domain-anchored manifest's entire trust basis is TLS, so serving it over plain HTTP doesn't degrade that trust, it erases it completely — worse than an honestly-disclosed key-anchored world, which still has its own signature intact regardless of transport. A deployment or client that tolerates plain HTTP for a domain-anchored world isn't degrading gracefully; it has silently become unverifiable.
- **Bridging real money into a tradeable resource** is a domain's own choice (§10) — how a domain accepts payment is entirely its business, the same as any checkout flow — but it isn't a low-risk one once that resource can also move to a different visitor through a trading station (§7). A resource purchasable with real currency and tradeable across independently-run domains is structurally close to what regulators mean by convertible virtual currency, the pattern that has previously pulled virtual-world operators into money-transmission, KYC/AML, and licensing questions they didn't anticipate (Second Life's Linden Dollars being the clearest precedent). This spec has no mechanism to address that, and nothing here is legal advice — a domain considering it should get real counsel in its own jurisdiction before building it, not spec guidance.

## 10. What belongs to the domain vs. the protocol

**The protocol carries what needs to survive leaving the domain.** Identity has to survive because it's the same visitor everywhere. Ownership — of items and of resources — has to survive because it's only portable if a domain that didn't issue it can still verify it. Discoverability and categorization have to be legible to a client or directory that's never seen this domain before. That's the whole list: identity, ownership, and the minimum vocabulary a stranger needs to find and understand a space before entering.

**Everything that only matters inside one domain stays inside it.** Who can build where, land parcels and their records, what a plot is worth, whether a visitor counts as a "resident," combat balance, quest logic, in-world chat moderation — none of it crosses a portal, so none of it belongs in a cross-domain spec, for the same reason HTTP doesn't standardize a website's login system. `profile.capabilities` advertises that a world *has* a building or combat system, the way a store's window display advertises what's inside; it is not the permission system itself, and this spec has no opinion on how a domain implements one. How a resource is *earned* — farmed, mined, grown, quested for — is the same kind of domain-local rule combat balance is; the protocol only cares what happens once it's been earned and needs to travel.

The one place this got genuinely subtle is §5.2: item loss during PvP looks like a domain-side gameplay rule, but the actual *transfer of ownership* has to be protocol-level, because ownership is one of the things that survives leaving the domain. §7 hit the same subtlety from a different angle — a trade looks like it should be entirely up to whichever world hosts the trading station, but settlement has to be protocol-level for the same reason. The resolution in both cases is the same shape: the world (or station) referees the event, but only a signature from whoever actually holds the authority — the owner's key for a transfer, the matched pair of owner-signed intents for a trade — can make it valid anywhere else. When a new domain-side idea shows up, run it through this test: does it need to be legible or valid outside the domain that created it? If yes, it's a schema addition. If no, it's the domain's own backend, and the spec should say nothing about it.
