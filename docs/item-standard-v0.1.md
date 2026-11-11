# Domain Atlas Item Standard v0.1

A common shape for items that carry gameplay meaning (rings, compasses, pickaxes, lanterns, dynamite, keys, ore). It keeps three things apart:

1. **Descriptive metadata**: what the item looks like and what it is called. Anyone may read it; it proves nothing.
2. **Issuer-authorized effects**: stats, multipliers and capabilities the issuing domain has declared for the class. These are signed into the credential, so a world can tell an item was really issued with them.
3. **World gameplay rules**: what a world does with an authorized effect (what a pickaxe can break, which locks a key opens). These live in the world's own policy and are never part of the item.

A wallet or world never trusts an item for declaring a capability. It trusts the issuer's `itemSpec` for the class, checked as described under [Foreign worlds](#foreign-worlds-discovery-and-verification).

Phase 1 added this document, the validators and the shared test vectors. Phase 2A, described under [Issuer integration](#issuer-integration), wires the validators into the Node and PHP issuers for classes that declare an `itemSpec`. Wallets, world gameplay, demo manifests and existing assets are not part of either phase yet, and no shipped class declares an `itemSpec`, so live issuance is unchanged.

## Scope

An item is **standard-conforming** when its class has an `itemSpec`, or its signed properties carry `atlas.item.standard`. Only those items are validated. Every other asset is outside the standard and is never rejected by it, including:

- legacy hat, outfit and shoe items with numeric multipliers (`atlas.avatar.hatSpeedMultiplier` and the like),
- items using `atlas.avatar.handItem`, `atlas.avatar.slot`, `atlas.avatar.color` or `atlas.avatar.stat.*` without the marker,
- elements and other classes whose properties are nested values.

Studio keys, class names and the signed credential format are unchanged. The standard adds properties; it does not add or rename credential fields.

## Rarity

Rarity never sets a power ceiling. Limits come from the class's `itemSpec`: each stat and multiplier has a `{min, max}` range there. A class may still use `atlas.rarity` (`common`, `uncommon`, `rare`, `legendary`) to influence its random rolls, but every roll must land inside the spec ranges, and `itemSpec` has no rarity field.

## Class names

- Issuer classes: `atlas.<family>.<name>` or `atlas.<family>.<kind>.<name>`, matching `^atlas(\.[a-z][a-z0-9_]*){2,3}$`.
- Third-party classes: a reverse-domain name with at least three labels, such as `com.example.tool.compass`.

The family must suit the category:

| Category | Families |
| --- | --- |
| equipment | `wearable`, `avatar` |
| tool | `tool` |
| consumable | `consumable` |
| material | `material`, `element` |
| key | `key` |
| currency | `currency`, `credit` |
| credential, collectible | any |

`atlas.wearable.<slotkind>.<name>` must use the item's own slot as `<slotkind>`.

## itemSpec

The issuer declares `itemSpec` on a catalog class:

```json
{
  "category": "tool",
  "slot": "hand",
  "capabilities": ["atlas.cap.mine"],
  "capabilityParams": { "atlas.cap.mine": { "tier": { "min": "1", "max": "2" } } }
}
```

| Field | Meaning |
| --- | --- |
| `category` | Required. `equipment`, `tool`, `consumable`, `material`, `key`, `credential`, `collectible` or `currency`. |
| `slot` | Required for equipment, optional for tools (hand, offhand or trinket only), not allowed elsewhere. |
| `uses` | Consumables only: whole number 1 to 1000 (default `"1"`). |
| `stats` | Equipment and tools. Stat id to `{min, max}`. |
| `multipliers` | Equipment and tools. `speed`, `jump` or `interactRange` to `{min, max}`. |
| `capabilities` | List of capability ids the class is authorized for. No duplicates. |
| `capabilityParams` | Capability id to its parameter ranges. |

Rules that keep the digest identical in every language: all leaf values are printable-ASCII strings (numbers are decimal strings), no empty lists or objects, no unknown keys, and no rarity.

Categories also fix the class shape: equipment, tool, key, collectible and credential are non-fungible; material and currency are fungible; consumables may be either; every category except `credential` is presented as a `collectible`, and `credential` as a `document`.

### Slots

`hat`, `chest`, `outfit` (the older two-colour form, still accepted), `shoes`, `hand`, `offhand`, `gloves`, `legs`, `shoulders`, `neck`, `ring`, `trinket`. The properties a slot needs are the ones the wallet already requires: hat `atlas.avatar.hatColor`; chest `atlas.avatar.color`; outfit `shirtColor` and `pantsColor`; shoes `shoeColor`; gloves, legs, shoulders and neck `atlas.avatar.color`; hand and offhand an absolute http(s) or root-relative model; ring and trinket nothing extra.

### Stats and multipliers

Stat ids: `health`, `mana`, `stamina`, `agility`, `intelligence`, `strength`, `armor`, `defense`, `resistance`, `attackSpeed`, `criticalStrike`, `dexterity`, `focus`, `luck`, `charisma`. A spec range must lie within -100 to 500 and holds whole numbers. An item's value is signed as `atlas.avatar.stat.<id>`.

Multipliers use `atlas.avatar.speedMultiplier`, `atlas.avatar.jumpMultiplier` and `atlas.avatar.interactRangeMultiplier`, within 0.25 to 3. Hat items may also use `atlas.avatar.hatSpeedMultiplier`, `hatJumpMultiplier` and `hatInteractRangeMultiplier`, and shoes `shoeSpeedMultiplier` and `shoeJumpMultiplier`, which map to the same three kinds.

Values are accepted as decimal strings or finite JSON numbers, so numeric properties issued earlier stay valid. A fractional stat is refused, because stats are whole numbers.

### Capabilities

| Capability | Category | Parameters | Meaning |
| --- | --- | --- | --- |
| `atlas.cap.compass` | tool, equipment | none | Heading display. |
| `atlas.cap.mine` | tool | `tier` 1 to 5 | Can mine ore up to that tier. |
| `atlas.cap.dig` | tool | `tier` 1 to 5 | Can dig up to that tier. |
| `atlas.cap.light` | tool, equipment | `radius` 1 to 20 | Light radius. |
| `atlas.cap.blast` | consumable | `radius` 1 to 10 | Blast radius when used. |
| `atlas.cap.unlock` | key | `lock`: `{values: [ids]}` | Opens the listed locks. |

A third party may declare `<reverse-domain>.cap.<name>` capabilities, but only under its own domain, and with parameters that are either `{min, max}` or `{values}`. A capability states what the issuer authorizes; what it does in a world is the world's rule.

Each instance carries the capability list as `atlas.item.capabilities` and each chosen parameter as `<capability>.<parameter>` (for example `atlas.cap.mine.tier`), inside the spec's range.

## Signed properties

For a class with an `itemSpec` the issuer derives and signs:

| Property | Value |
| --- | --- |
| `atlas.item.standard` | `"0.1"` |
| `atlas.item.category` | The spec's category. |
| `atlas.avatar.slot` | The spec's slot, if any. |
| `atlas.item.capabilities` | The spec's capabilities, sorted. |
| `atlas.item.uses` | Consumables only. |
| `atlas.item.specDigest` | SHA-256 of the canonical spec. |

The canonical form is JSON with sorted keys and no whitespace. The test vectors pin the digests for both languages.

### Limits (standard items only)

At most 32 properties; keys at most 64 characters; `atlas.*` string values at most 256 and scalar (string, number or boolean) except the capability list (at most 16 entries of at most 64 characters); other keys' values at most 1024 characters of JSON. Unknown `atlas.item.*`, `atlas.cap.*` and `atlas.avatar.*` keys are refused on a standard item, which keeps the namespace from filling with unreviewed meaning.

## Foreign worlds: discovery and verification

No registry is introduced. A world that receives an item from another domain uses what Domain Atlas already has:

1. Verify the credential as today (signature, issuer key from the issuer's own domain, expiry, revocation).
2. If the properties carry `atlas.item.standard`, fetch the spec from the issuer with the existing class lookup (`GET /atlas/asset/class?class=<class>&specDigest=<signed digest>`, SPEC section 5.1.2). The response carries the `itemSpec` with that digest, whether it is the class's current spec or an earlier one.
3. Recompute the digest of the served `itemSpec` and require it to equal the signed `atlas.item.specDigest`. The issuer's domain is the trust root, so nothing else is needed to know the spec is the issuer's.
4. Run `validateItemSpec` and `validateItemProperties`. A failure makes the item inert for effects.
5. Apply the world's own filters: `acceptedItemClasses`, `trustedIssuers` and, from Phase 2, `policy.itemEffects`.

A spec changed after issuance fails step 3, which is how a widened or extended spec is caught. Issuers keep every spec they have signed retrievable by digest; an item whose spec cannot be fetched is inert rather than guessed at.

## Rollout and compatibility

- Existing hat, shoe and movement effects keep working exactly as today. They are not standard items.
- Standard effects are opt-in per world with `policy.itemEffects`, following the domain-default and per-world override rule (SPEC section 3.4.1). Without it, standard items still display and trade; their effects are ignored.
- Issuance of a standard class is the issuer's choice; no existing class carries an `itemSpec` today.

Known compatibility notes from the catalog lint: the shipped hats, outfits and shoes use legacy numeric multipliers and colour keys, and the PHP catalog also carries `atlas.avatar.handItem` on its pickaxe. All of these stay outside the standard. The only restriction on other classes is that admin mint, reissue and class patch no longer accept `atlas.item.*` or `atlas.cap.*` properties on them, so an unrelated class cannot be made to look standard-conforming.

## Issuer integration

This applies to a catalog class with an `itemSpec`, in both `issuer-server/server.js` and the PHP issuer. Everything else is unchanged.

**Signing.** Minting a standard class builds the final property bag from the class's own properties, any random roll, the serial and any admin patch, removes every `atlas.item.*` key and `atlas.avatar.slot`, adds the derived properties, and runs `validateItemSpec` and `validateItemProperties` on the result. The issuer signs only a bag that passes. A failed check is a 400 `item-properties-invalid` with the error list (a class whose own `itemSpec` is invalid is a 500 `item-spec-invalid`). The check happens before a serial or supply is reserved, so a roll outside the spec reserves nothing; if signing fails after a serial was reserved, the serial is given back when no other mint has taken one since, and otherwise stays an unused gap so serials remain unique.

**Caller properties.** Admin mint, reissue and class patch may not set a derived key (`atlas.item.*`, `atlas.avatar.slot`) on a standard class: 400 `item-patch-reserved-key`. Instance values (stat rolls, capability parameters) are accepted when they stay inside the spec. On a class without an `itemSpec` the same routes refuse non-null `atlas.item.*` and `atlas.cap.*` properties and accept everything else as before.

**Reissue and class patch.** A properties patch on an already-issued asset is checked against the spec its own signed `atlas.item.specDigest` names, not the class's current one: the current spec if the digest matches, otherwise the recorded earlier spec. The result must pass `validateItemProperties`; a signed spec that is no longer on record gives 409 `item-spec-unavailable`. A class patch is also checked against the class's current spec when it is stored, and again against each holder's own spec when it reaches their credential; where it does not fit, that credential is left alone. All checks run before anything is signed, so a refused request does not touch supply, revocations, holdings or stored patches. Reissue keeps the asset on the spec it was signed under; moving an asset to a newer spec is a deliberate reissue by the issuer, which Phase 2A does not provide.

**Fungible re-mints.** A balance of a standard class that was issued under an earlier spec is refused by split, consolidate, convert and purchase until the issuer reissues it, because those re-mint from the class's current definition and would otherwise sign today's spec onto older value.

**Restricted classes.** `restrictedIssuance` classes (Studio collectibles, chest items) are refused by issue, admin mint, reissue and class patch exactly as before, whether or not they have an `itemSpec`; no spec history is recorded for them.

**Class lookup.** `GET /atlas/asset/class?class=` adds `itemStandard`, `itemSpec` and `itemSpecDigest` for a standard class. With `&specDigest=<64 hex>` it returns that class's spec with that digest and `current: true|false`; an unknown digest is 404 `item-spec-unknown`, a malformed one 400 `item-spec-digest-invalid`, and a digest belonging to another class is not served.

**Spec history.** Every spec the issuer signs is recorded by class and digest before the asset is signed (`atlas-item-specs-store.json` in the issuer's state folder), and entries are only ever added. This file must be backed up with the other issuer state: it is the only record of a spec after the catalog entry changes. If it is unreadable the issuer refuses standard issuance (503) rather than replacing it.

## Wallet and world integration

**Recognition.** The wallet treats an equipped or carried item as standard when its signed properties carry `atlas.item.standard`. Everything else, existing hats, shoes, outfits and tools included, follows the code it always did and is never gated by `itemEffects`. The validator ships to the extension as `extension/item-standard.js`, a byte-identical copy of the issuer module (a test enforces this) that hashes with a built-in SHA-256 where Node's `crypto` is absent.

**Verification.** `AtlasWallet.verifyStandardItem(asset, issuerDomain)` returns `verified`, `unverified` or `invalid` (and `legacy` for a non-standard asset). It fetches the spec the signed digest names from the issuing domain (`GET /atlas/asset/class?class=<class>&specDigest=<digest>`), recomputes the digest, runs `validateItemSpec` and then `validateItemProperties` on the item. `invalid` means the issuer says it never signed that spec, the served spec does not hash to the signed digest, or the item does not satisfy the spec. `unverified` means no answer could be had (issuer unreachable, no spec support, a newer standard version). A credential the wallet already holds as invalid is also `invalid`. Only `verified` items contribute effects. A verified spec is cached by issuer, class and digest (at most 200, kept in `chrome.storage.local`) and never expires, because the digest fixes its content; a failed lookup is not retried for a minute.

**World policy.** `policy.itemEffects` (SPEC section 3.4.1) is `{ stats, multipliers, capabilities }`: `stats` and `multipliers` take a list or `"all"`, capabilities are listed by id. Absent, `false` or a non-object enables nothing. An effect applies when the item is verified, the world's `acceptedItemClasses` (if declared) match its class, `trustedIssuers` (if declared) admit its issuer, and the policy lists the effect. Appearance is never withheld. The reasons an effect can be withheld are `item-unverified`, `item-invalid`, `no-world`, `world-effects-off`, `class-not-accepted`, `issuer-not-trusted` and `effect-not-enabled`.

**Numbers.** Applying an effect uses the existing arithmetic: stat bonuses add to the base stat, Agility, Strength and Dexterity move speed, jump and reach, and the multipliers of every equipped slot multiply together, kept between 0.25 and 3. A standard item's generic multiplier keys count in every slot; in the hat and shoe slots they are read as the slot's own keys (`atlas.avatar.hatSpeedMultiplier` and similar), which win if both are present.

**Equipment slots.** A standard item in the `hand` slot with a model can be held (it need not carry `atlas.avatar.handItem`). Equipped item references follow a verified credential supersession: the slot that held the old credential holds its replacement.

**Capability interface.** `AtlasWallet.getActiveCapabilities()` returns `{ capabilityId: [provider] }` for the capabilities that are active in the current world, and `getCapabilityProviders(id)` the providers of one. A provider is `{ id, assetId, slot, source, class, name, params, uses }`: tools and equipment provide while equipped (`source: 'equipped'`), consumables and keys while carried (`source: 'carried'`). Parameters are numbers for `tier` and `radius` and strings otherwise (a lock id stays a string). The viewer publishes the same reads as `AtlasCapabilities.active()` and `.providers(id)`, and `AtlasCapabilities.onChange(fn)` calls back when the world or the equipment changes. The compass, mine, dig, light, blast and unlock ids are `AtlasItemEffects.CAPABILITY_IDS`. The only capability consumed so far is the compass, by the heading display described in docs/bronze-compass-demo.md; no mining, digging, blasting, unlocking, light or consumable spending exists yet.

**Character window.** The Stats view lists the buffs from equipped items that are active, the capabilities the character has here, and under "Not active in this world" each withheld effect with its reason.

## Validation

`validateItemSpec(itemSpec, ctx)` returns `{ok, errors}` for a class definition. `validateItemProperties(itemSpec, properties, ctx)` returns `{applies, ok, errors}` for one item; `applies` is false for items outside the standard. `lintCatalog(catalog)` checks a whole catalog, including random rolls. Errors are `{code, key}`.

Spec errors: `itemspec-invalid`, `itemspec-category-invalid`, `itemspec-category-fungible-mismatch`, `itemspec-presentation-mismatch`, `itemspec-slot-invalid`, `itemspec-slot-required`, `itemspec-slot-not-allowed`, `itemspec-uses-invalid`, `itemspec-effects-not-allowed`, `itemspec-stat-unknown`, `itemspec-stat-range-invalid`, `itemspec-multiplier-unknown`, `itemspec-multiplier-range-invalid`, `itemspec-capability-unknown`, `itemspec-capability-category-mismatch`, `itemspec-capability-param-invalid`, `itemspec-class-name-invalid`, `itemspec-class-family-mismatch`, `itemspec-class-slot-mismatch`.

Item errors: `item-spec-missing`, `item-property-type`, `item-property-limit`, `item-marker-missing`, `item-marker-invalid`, `item-category-mismatch`, `item-spec-digest-missing`, `item-spec-digest-mismatch`, `item-slot-mismatch`, `item-color-invalid`, `item-model-required`, `item-stat-unknown`, `item-stat-not-allowed`, `item-stat-value-invalid`, `item-stat-out-of-range`, `item-multiplier-not-allowed`, `item-multiplier-value-invalid`, `item-multiplier-out-of-range`, `item-capability-unauthorized`, `item-capability-param-invalid`, `item-reserved-key`, `item-uses-invalid`, `item-rarity-invalid`. Catalog lint adds `catalog-reserved-key-without-itemspec`.

## Files and tests

| File | Role |
| --- | --- |
| `issuer-server/item-standard.js` | Node validator. |
| `issuer-php/lib/item-standard.php` | PHP validator (PHP 7.0 compatible). |
| `docs/item-standard-v0.1.json` | Shared vectors: specs, digests, 36 spec cases, 59 item cases, 6 outside-the-standard cases, two catalogs. |
| `test/item-standard.js` | Replays the vectors through both validators, requires identical results, and lints the real catalogs. |
| `test/item-standard-runner.php` | PHP side of that test. |
| `issuer-server/item-standard-issuer.js` | Node issuer integration: sealing, patch checks, spec history. |
| `issuer-php/lib/item-standard-issuer.php` | PHP issuer integration. |
| `extension/item-standard.js` | Browser copy of the validator, identical to the Node module. |
| `extension/item-effects.js` | World policy, per-effect resolution and the capability list. |
| `test/item-effects.js` | Unit checks for the policy, the filters, the reasons and the capability list. |
| `test/manual-item-effects.js` | Real-browser check of the wallet, viewer and Stats window against a PHP issuer with injected standard classes (needs a display). |
| `test/item-standard-issuer.js` | Runs one scenario against both issuers and requires identical outcomes. Test classes come from `test/fixtures/item-standard-issuer.json` and are injected into the running code by `test/lib/item-standard-inject.js` (Node) and a file in the copied PHP bundle; the repository has no standard class. |

Run `node test/item-standard.js` (needs `php` on the path); it also replays the vectors through the browser copy. The vectors include valid and invalid ring, compass and pickaxe definitions, a ring whose rolls exceed its spec, a pickaxe whose tier exceeds its spec, and foreign-issuer cases where the served spec was widened after signing.

## Remaining work

World behaviour for the capabilities (nothing yet acts on compass, mine, dig, light, blast or unlock), consumable spending, an action bar over the capability interface, and an issuer action to move an asset to a newer spec.
