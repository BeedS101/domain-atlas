# Character window

The viewer shows the player's character with one block per equip slot. It opens from the wallet's Character tab, or with the C key anywhere in a world (C again closes the panel; the key is ignored while typing).

## Slots

| Slot | Asset property that makes an item fit | Effect |
| --- | --- | --- |
| Hat | `atlas.avatar.hatColor` | Hat colour and its speed, jump and reach multipliers |
| Outfit | `atlas.avatar.shirtColor` / `atlas.avatar.pantsColor` | Shirt and trousers colour |
| Shoes | `atlas.avatar.shoeColor` | Shoe colour, scale and speed/jump multipliers |
| Hand | `atlas.avatar.handItem` set to `true`, plus an absolute http(s) `model` | The item's model is drawn in the right hand |

Clicking a block lists the wallet items that fit it (`AtlasWallet.avatarSlotsOfAsset`). Choosing one equips it, choosing the equipped one again takes it off. The wallet card buttons stay as shortcuts and use the same storage, so both routes agree.

## Hand item

The hand slot is cosmetic: it changes nothing about gameplay. The model URL travels over presence as `handModel` (an absolute http(s) URL, at most 400 characters; anything else is dropped by the Node and PHP presence servers and again by the viewer). Other players load it under the same limits as dropped items (1 MB, 50k triangles, texture limits) and keep at most eight held models resident.

The Mining Pick from the gallery's tool chest carries `atlas.avatar.handItem`. Any other issuer can make an item holdable by setting that property on a class that has a model.

Test: `xvfb-run -a node test/manual-character-window.js`.
