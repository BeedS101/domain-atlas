# Character window

The viewer shows the player's character with one block per equip slot (thirteen in all, the Outfit slot being the Chest slot), under two sub-menus: Character (the default) and Stats. It opens from the wallet's Character tab, or with the C key anywhere in a world (C again closes the panel; the key is ignored while typing).

## Slots

| Slot | Asset property that makes an item fit | Effect |
| --- | --- | --- |
| Hat | `atlas.avatar.hatColor` | Hat colour and its speed, jump and reach multipliers |
| Chest | `atlas.avatar.slot` = `chest` plus `atlas.avatar.color` (`#rrggbb`), or the older `atlas.avatar.shirtColor` / `atlas.avatar.pantsColor` | Shirt colour (an older outfit item also sets the trousers colour) |
| Shoes | `atlas.avatar.shoeColor` | Shoe colour, scale and speed/jump multipliers |
| Hand | `atlas.avatar.handItem` set to `true`, plus an absolute http(s) `model` | The item's model is drawn in the right hand |

| Off hand | `atlas.avatar.slot` = `offhand`, plus an absolute http(s) `model` | The item's model is drawn in the left hand |
| Gloves | `atlas.avatar.slot` = `gloves`, plus `atlas.avatar.color` (`#rrggbb`) | Hands are drawn in that colour |
| Legs | `atlas.avatar.slot` = `legs`, plus `atlas.avatar.color` | Trouser colour; overrides the one an older outfit item sets |
| Shoulders | `atlas.avatar.slot` = `shoulders`, plus `atlas.avatar.color` | Shoulder pads in that colour |
| Neck | `atlas.avatar.slot` = `neck`, plus `atlas.avatar.color` | A collar in that colour |
| Ring 1, Ring 2 | `atlas.avatar.slot` = `ring` | Fits either ring slot; no visual |
| Trinket 1, Trinket 2 | `atlas.avatar.slot` = `trinket` | Fits either trinket slot; no visual |

The lobby crates give chest and legs pieces in two sets, Forest Ranger (`atlas.avatar.chest.forest`, `atlas.avatar.legs.forest`) and Dusk Wanderer (`atlas.avatar.chest.dusk`, `atlas.avatar.legs.dusk`), each with a few stat points. The earlier two-colour outfit classes (`atlas.avatar.outfit.forest`, `atlas.avatar.outfit.dusk`) stay declared so items already issued keep working, but the crates no longer offer them.

Clicking a block lists the wallet items that fit it (`AtlasWallet.avatarSlotsOfAsset`). Choosing one equips it, choosing the equipped one again takes it off. The wallet card buttons stay as shortcuts and use the same storage, so both routes agree.

## Extra slots

Items for the nine extra slots name their slot with `atlas.avatar.slot`. Colour slots (gloves, legs, shoulders, neck) need `atlas.avatar.color`; the off hand needs a model; rings and trinkets need nothing else. An item that misses its requirement is not offered for that slot. A ring or trinket is held in one slot at a time: putting it in the other ring (or trinket) slot moves it, and an item used in the hand and off-hand slots at once is taken out of the hand.

An item in any of the nine extra slots may add gameplay buffs with `atlas.avatar.speedMultiplier`, `atlas.avatar.jumpMultiplier` and `atlas.avatar.interactRangeMultiplier`. Each value is clamped to 0.25 to 3, the equipped items' values multiply together and that product is clamped again; the world applies it on top of the hat and shoe multipliers. Items without those properties are purely cosmetic. Properties are signed when an asset is issued, so only newly issued items carry them.

The visible parts (gloves, legs, shoulders, neck colours and the off-hand model) travel over presence as `glovesColor`, `legsColor`, `shouldersColor`, `neckColor` and `offHandModel`, validated like the existing look fields. Rings, trinkets and buffs stay local.

Test: `xvfb-run -a node test/manual-character-slots.js` (set `SHOT_DIR` to save screenshots).

## Stats

The Stats sub-menu lists fifteen stats in three groups and, under them, the buffs of everything equipped, totalled.

| Group | Stat | Base | Effect |
| --- | --- | --- | --- |
| Primary | Health, Mana, Stamina | 100 | The resources. Each is raised or lowered by the Secondary stat that feeds it (below) |
| Secondary | Agility | 10 | Each point above or below 10 changes speed by 1% and Stamina by 5 |
| Secondary | Intelligence | 10 | Each point above or below 10 changes interaction reach by 1% and Mana by 5 |
| Secondary | Strength | 10 | Each point above or below 10 changes jump height by 1% and Health by 5 |
| Tertiary | Armor, Defense, Resistance, Attack Speed, Critical Strike, Dexterity, Focus, Luck, Charisma | 10 | Shown only |

Dexterity no longer moves interaction reach; Intelligence does. The Stats list shows each group under its own heading, and the buff list names the Primary change a Secondary stat causes (for example "Stamina +125 from Agility").

Any equipped item, in any of the thirteen slots, adds to a stat with the property `atlas.avatar.stat.<id>` (`health`, `mana`, `stamina`, `agility`, `intelligence`, `strength`, `armor`, `defense`, `resistance`, `attackSpeed`, `criticalStrike`, `dexterity`, `focus`, `luck`, `charisma`): a whole number from -100 to 500 per item, and a stat's total never drops below 0. The buff list shows each stat bonus plus the combined Speed, Jump and Reach multipliers of the hat, shoes and extra slots with the stat contribution folded in. The world uses the same numbers: the stat factors multiply into the extra-slot multipliers, which stay clamped to 0.25 to 3 before the hat and shoe multipliers apply.

Stat properties are signed when an asset is issued, so only newly issued items carry them. The stats are local to the player's wallet; they are not sent over presence.

### Item Standard items in the Stats view

An item that carries `atlas.item.standard` (docs/item-standard-v0.1.md) adds its stat bonuses, multipliers and capabilities only where the current world lets it: the item must verify against its issuer's spec, pass the world's `acceptedItemClasses` and `trustedIssuers` when declared, and the effect must be listed in `policy.itemEffects`. Items that are not standard keep working exactly as before in every world.

The Stats view therefore has three more parts. The totals and the buff list include only effects that apply. Capabilities lists what the character can do here (compass, mine, dig, light, blast, unlock), each with the item that provides it; a consumable or key counts while it is carried. Not active in this world lists every withheld effect of an equipped standard item with the reason: the item could not be checked or does not match its issuer's spec, the world does not support item effects, does not accept the class, does not trust the issuer, or does not enable that effect. The view updates when the character enters another world, including through a portal to another domain, and when equipment changes.

Equipped references follow a verified credential supersession: when the issuer reissues an equipped item, the slot keeps holding the replacement.

Test: `xvfb-run -a node test/manual-item-effects.js`; the policy and resolver logic has its own unit test, `node test/item-effects.js`.

## Hand item

The hand slot is cosmetic: it changes nothing about gameplay. The model URL travels over presence as `handModel` (an absolute http(s) URL, at most 400 characters; anything else is dropped by the Node and PHP presence servers and again by the viewer). Other players load it under the same limits as dropped items (1 MB, 50k triangles, texture limits) and keep at most eight held models resident.

A held tool or weapon is scaled so its longest side is 0.8 units, gripped 18% up from its lowest point (handle at the bottom, head at the top) and swung forward about 80 degrees from hanging, so a blade points forward. The character faces -z, so the model's front (+z, the side its thumbnail shows) is turned to face forward. A flat, broad item (a shield: less than 40% as thick front to back as it is wide, and at least half as tall as it is wide) is instead carried against the outside of the arm, centred on the hand, 0.6 units across, facing outward; its face should be on +z. The same rules apply in the off hand.

The Mining Pick from the gallery's tool chest carries `atlas.avatar.handItem`. Any other issuer can make an item holdable by setting that property on a class that has a model.

Test: `xvfb-run -a node test/manual-character-window.js`.
