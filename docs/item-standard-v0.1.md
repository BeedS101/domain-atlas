# Domain Atlas Item Standard v0.1

A common shape for items that carry gameplay meaning (rings, compasses, pickaxes, lanterns, dynamite, keys, ore). It keeps three things apart:

1. **Descriptive metadata**: what the item looks like and what it is called. Anyone may read it; it proves nothing.
2. **Issuer-authorized effects**: stats, multipliers and capabilities the issuing domain has declared for the class. These are signed into the credential, so a world can tell an item was really issued with them.
3. **World gameplay rules**: what a world does with an authorized effect (what a pickaxe can break, which locks a key opens). These live in the world's own policy and are never part of the item.

A wallet or world never trusts an item for declaring a capability. It trusts the issuer's `itemSpec` for the class, checked as described under [Foreign worlds](#foreign-worlds-discovery-and-verification).

Phase 1 (this document, the validators and the test vectors) changes nothing at runtime: issuance, wallets, demo manifests and existing assets are untouched. Nothing in the issuers calls the validators yet.

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

`hat`, `outfit`, `shoes`, `hand`, `offhand`, `gloves`, `legs`, `shoulders`, `neck`, `ring`, `trinket`. The properties a slot needs are the ones the wallet already requires: hat `atlas.avatar.hatColor`; outfit `shirtColor` and `pantsColor`; shoes `shoeColor`; gloves, legs, shoulders and neck `atlas.avatar.color`; hand and offhand an absolute http(s) or root-relative model; ring and trinket nothing extra.

### Stats and multipliers

Stat ids: `health`, `mana`, `stamina`, `agility`, `strength`, `focus`, `dexterity`, `defense`, `luck`, `charisma`. A spec range must lie within -100 to 500 and holds whole numbers. An item's value is signed as `atlas.avatar.stat.<id>`.

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
2. If the properties carry `atlas.item.standard`, fetch the class from the issuer with the existing class lookup (`GET /atlas/asset/class?class=`, SPEC section 5.1.2). Phase 2 extends that response with the class's `itemSpec`.
3. Recompute the digest of the served `itemSpec` and require it to equal the signed `atlas.item.specDigest`. The issuer's domain is the trust root, so nothing else is needed to know the spec is the issuer's.
4. Run `validateItemSpec` and `validateItemProperties`. A failure makes the item inert for effects.
5. Apply the world's own filters: `acceptedItemClasses`, `trustedIssuers` and, from Phase 2, `policy.itemEffects`.

A spec changed after issuance fails step 3, which is how a widened or extended spec is caught. Issuers should keep retired specs retrievable by digest; an item whose spec cannot be fetched is inert rather than guessed at.

## Rollout and compatibility

- Existing hat, shoe and movement effects keep working exactly as today. They are not standard items.
- Standard effects are opt-in per world. In Phase 2 a world enables them with `policy.itemEffects`, following the domain-default and per-world override rule (SPEC section 3.4.1). Without it, standard items still display and trade; their effects are ignored.
- Issuance of a standard class is the issuer's choice; no existing class carries an `itemSpec` today.

Known compatibility notes from the catalog lint: the shipped hats, outfits and shoes use legacy numeric multipliers and colour keys, and the PHP catalog also carries `atlas.avatar.handItem` on its pickaxe. All of these stay outside the standard. Admin mint and class patch currently accept arbitrary properties; Phase 2 should run the validator there for standard items only.

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

Run `node test/item-standard.js` (needs `php` on the path). The vectors include valid and invalid ring, compass and pickaxe definitions, a ring whose rolls exceed its spec, a pickaxe whose tier exceeds its spec, and foreign-issuer cases where the served spec was widened after signing.

## Phase 2 (not done)

Return `itemSpec` from the class lookup in Node and PHP; derive and sign the properties at issue time for classes with a spec; run the validator in admin mint and class patch for standard items; add `policy.itemEffects` with the domain-default rule; teach the wallet to verify and apply standard effects.
