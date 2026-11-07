# Character window

The viewer shows the player's character with one block per equip slot (thirteen in all). It opens from the wallet's Character tab, or with the C key anywhere in a world (C again closes the panel; the key is ignored while typing).

## Slots

| Slot | Asset property that makes an item fit | Effect |
| --- | --- | --- |
| Hat | `atlas.avatar.hatColor` | Hat colour and its speed, jump and reach multipliers |
| Outfit | `atlas.avatar.shirtColor` / `atlas.avatar.pantsColor` | Shirt and trousers colour |
| Shoes | `atlas.avatar.shoeColor` | Shoe colour, scale and speed/jump multipliers |
| Hand | `atlas.avatar.handItem` set to `true`, plus an absolute http(s) `model` | The item's model is drawn in the right hand |

| Off hand | `atlas.avatar.slot` = `offhand`, plus an absolute http(s) `model` | The item's model is drawn in the left hand |
| Gloves | `atlas.avatar.slot` = `gloves`, plus `atlas.avatar.color` (`#rrggbb`) | Hands are drawn in that colour |
| Legs | `atlas.avatar.slot` = `legs`, plus `atlas.avatar.color` | Overrides the trouser colour |
| Shoulders | `atlas.avatar.slot` = `shoulders`, plus `atlas.avatar.color` | Shoulder pads in that colour |
| Neck | `atlas.avatar.slot` = `neck`, plus `atlas.avatar.color` | A collar in that colour |
| Ring 1, Ring 2 | `atlas.avatar.slot` = `ring` | Fits either ring slot; no visual |
| Trinket 1, Trinket 2 | `atlas.avatar.slot` = `trinket` | Fits either trinket slot; no visual |

Clicking a block lists the wallet items that fit it (`AtlasWallet.avatarSlotsOfAsset`). Choosing one equips it, choosing the equipped one again takes it off. The wallet card buttons stay as shortcuts and use the same storage, so both routes agree.

## Extra slots

Items for the nine extra slots name their slot with `atlas.avatar.slot`. Colour slots (gloves, legs, shoulders, neck) need `atlas.avatar.color`; the off hand needs a model; rings and trinkets need nothing else. An item that misses its requirement is not offered for that slot. A ring or trinket is held in one slot at a time: putting it in the other ring (or trinket) slot moves it, and an item used in the hand and off-hand slots at once is taken out of the hand.

An item in any of the nine extra slots may add gameplay buffs with `atlas.avatar.speedMultiplier`, `atlas.avatar.jumpMultiplier` and `atlas.avatar.interactRangeMultiplier`. Each value is clamped to 0.25 to 3, the equipped items' values multiply together and that product is clamped again; the world applies it on top of the hat and shoe multipliers. Items without those properties are purely cosmetic. Properties are signed when an asset is issued, so only newly issued items carry them.

The visible parts (gloves, legs, shoulders, neck colours and the off-hand model) travel over presence as `glovesColor`, `legsColor`, `shouldersColor`, `neckColor` and `offHandModel`, validated like the existing look fields. Rings, trinkets and buffs stay local.

Test: `xvfb-run -a node test/manual-character-slots.js` (set `SHOT_DIR` to save screenshots).

## Hand item

The hand slot is cosmetic: it changes nothing about gameplay. The model URL travels over presence as `handModel` (an absolute http(s) URL, at most 400 characters; anything else is dropped by the Node and PHP presence servers and again by the viewer). Other players load it under the same limits as dropped items (1 MB, 50k triangles, texture limits) and keep at most eight held models resident.

The Mining Pick from the gallery's tool chest carries `atlas.avatar.handItem`. Any other issuer can make an item holdable by setting that property on a class that has a model.

Test: `xvfb-run -a node test/manual-character-window.js`.
