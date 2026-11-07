# Bronze Compass demonstration

The first playable use of the Item Standard (docs/item-standard-v0.1.md): a newly issued, standard-conforming compass that shows a heading display in a 3D world that enables it.

## What a player sees

1. In Example Plaza, the Compass Stall hands out a **Bronze Compass (Standard)**, once per wallet. It is a different class from the older Bronze Compass (`atlas.wearable`), which is still an ordinary credential that earlier visitors may hold; nothing about it changes.
2. In the Character window the compass fits either trinket slot.
3. In the 3D Example Lobby a small dial appears at the top right, showing N, NE, E, SE, S, SW, W and NW. It turns with the direction the character is actually facing, and the point at the top is the one the character is facing.
4. The dial disappears when the compass is unequipped, in any 2D world, in any 3D world whose policy does not enable the compass, and in another domain that does not enable it. It comes back on returning to the lobby with the compass still equipped.

## The class

`atlas.tool.bronze_compass`, in `issuer-server/server.js` and `issuer-php/lib/store.php`, with the same definition in both (test/compass-demo.js compares them):

```
itemSpec: { category: 'tool', slot: 'trinket', capabilities: ['atlas.cap.compass'] }
```

Items of the class are sealed at issuance like any standard item: the issuer signs `atlas.item.standard`, the category, slot, capabilities and the spec digest. `tradeScope` is `bound`, so a compass stays with the wallet that collected it. The class is not restricted, so the stall collects it through the ordinary public issue route.

## World policy

The demo domain's lobby (`demo-domain-a/.well-known/spatial.json`) now declares

```
"acceptedItemClasses": ["atlas.tool.bronze_compass"],
"trustedIssuers": "self",
"itemEffects": { "capabilities": ["atlas.cap.compass"] }
```

A standard item takes effect in a world only when the world's accepted classes and trusted issuers admit it and `itemEffects` enables the effect, so the compass is listed in `acceptedItemClasses` too (the list previously admitted nothing, and the same list decides which classes may be dropped in the lobby). `itemEffects` lists no stats or multipliers: hats, shoes and other older gear keep their buffs exactly as before, because they are never gated by `itemEffects`. No other world of either demo domain enables the compass.

## The display

`extension/compass-hud.js` builds the dial and holds the pure helpers (heading from a facing vector, nearest point, label layout). `extension/viewer.js` shows it while `AtlasCapabilities.providers('atlas.cap.compass')` is non-empty and a 3D scene is running, and reads the character's facing from the renderer every frame (`getCharacterFacingWorldDir()`). North is the scene's -z direction and east is +x, so a character facing the camera's start direction in a scene with `startYaw` 0 faces north.

## Tests

- `node test/compass-demo.js`: Node and PHP catalogs agree, the spec conforms, the older class is untouched, the plaza stall and the lobby policy are wired, and the HUD helpers are correct.
- `xvfb-run -a node test/manual-compass-demo.js`: the real wallet-to-world flow, from the stall to the lobby HUD in all eight directions, both trinket slots, unequip, a 3D world without the capability, and a portal to another domain and back.

## Upload checklist

Domain with the issuer and the lobby (the first demo domain): upload `issuer-server/server.js` or `issuer-php/lib/store.php` (whichever the domain runs), `.well-known/spatial.json`, and `spatial/plaza/scene.json`. Nothing is minted or changed by uploading; the first compass is issued when a player uses the stall. `compass-listing.html` carries a one-line wording change and is optional.

Every domain whose visitors use the extension: the extension files `compass-hud.js` (new), `viewer.js`, `viewer.html` and `manifest.json` ship with the extension build, not with a domain.

The other demo domain needs no upload: it does not enable the compass, which is what the cross-domain check relies on.
