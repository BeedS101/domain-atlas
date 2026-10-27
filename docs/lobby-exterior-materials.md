# Lobby exterior and town materials

The outdoor part of the Domain A Lobby (building exterior, trees, hut, mine, river,
pier, plaza props) is retextured with small embedded PNGs. It is a material pass
only: layout, object placement, building dimensions, collisions, entrance, portal,
interactables, crate and drop behaviour, camera, `characterScale` (0.5) and the
reserved activity zones are unchanged, and the object count stays at 265.

Features used (see `docs/gltf-mini-materials.md`): `baseColorTexture`,
`baseColorFactor`, `normalTexture` (building walls only) and one faint
`emissiveFactor` on the lamp lanterns. No alpha MASK or BLEND (leaf and needle
silhouettes come from geometry), no unlit, no fog, no extensions.

## Surfaces

| Surface | Model(s) | Material work |
| --- | --- | --- |
| Building exterior | `lobby/exterior/wall*.glb` (4 wall types, 32 objects) | Exterior face: stucco over a darker block plinth (bottom 20 %), a cornice line and seams, with a faint normal map. Frames get wood grain. The room side keeps the interior plaster. |
| Trees, shrubs | `treeSmall`, `treeSmallB`, `shrub`, `shrubB` | Bark and leaf textures; the B variant has a warmer tint and is picked by hash from the position. |
| Pines | `town/pine`, `town/pineB` | Needle and bark textures, two tints. |
| Hut | `town/hut` | Wood plank grain, roof tiles, a glass gradient in the windows, a dark recess behind the open doorway. |
| Barrels, wood pile | `town/barrel`, `town/woodPile` | Staves with iron bands; bark and end-grain rings. |
| Mine | `town/mineHill`, `town/townPaths`, `town/oreCart`, boulders | Rock and earth, a darker tunnel recess, rail and sleeper textures, ore cart with tinted ore. |
| River, pier | `town/riverBanks`, `town/riverWater`, `town/pier` | Water colour gradient, pebbly bank, pier planks with edge and post tints. |
| Plaza | `town/fountain`, `town/townGround`, `town/flowerBed`, benches, planters, sign | Richer fountain water, soft grass patches, pebbled sand, soil and leaf beds; iron and wood benches, iron lamp posts (emissive lantern), "WELCOME" sign lettering. |

## Why the town models have no normal maps

Normal maps on the large town surfaces (ground, hut, mine) cost about 15-20 % of
frame time in software GL, so only the building walls keep one (no measurable
cost at the entrance view). Town models use base-colour textures only; this is
asserted by `test/manual-3d-lobby-exterior-unit.js`.

## Files

- `demo-domain-a/assets/lobby/exterior/*.glb`: 12 generated models (about 700 KB).
  Textures are not shared between GLB files, so each wall file carries its own
  copy of the interior plaster.
- `demo-domain-a/assets/town/*.glb`: regenerated models plus the new `pineB.glb`.
- `demo-domain-a/spatial/lobby/scene.json`: only `model` URLs change (101 objects:
  walls, trees, shrubs, benches, lamps, planters, sign, pines). The interior wall
  models in `assets/lobby/interior/wall*.glb` are no longer referenced by the scene.
- `tools/make-lobby-exterior-assets.js`: generator for the exterior folder. It
  retextures copies of the original models without moving a vertex. `--scene`
  moves the scene's wall URLs; `--check` verifies models and scene.
- `tools/make-town-assets.js`: town model generator (`--only a,b` rebuilds some).
- `tools/make-lobby-town-scene.js`: rebuilds the outdoor part of the scene and
  chooses the exterior and B variants.
- `tools/lobby-town-shots.js`: fixed-camera screenshots from six viewpoints with
  software-GL frame rates and renderer resource counts.

## Regenerating

```
node tools/make-town-assets.js
node tools/make-lobby-exterior-assets.js
node tools/make-lobby-town-scene.js
node tools/make-lobby-exterior-assets.js --scene
node tools/make-lobby-exterior-assets.js --check
node tools/make-lobby-town-scene.js --check
```

Screenshots: `xvfb-run -a node tools/lobby-town-shots.js <out-dir>`.

## Tests

- `test/manual-3d-lobby-exterior-unit.js`: models match the generators; exterior
  models keep the originals' triangles and bounds; town models keep their bounds;
  the scene differs from the previous one only in model URLs; material features
  stay within the list above; PNGs are embedded, at most 512 px, and the set stays
  under its size budget.
- Existing tests that cover the exterior: `manual-3d-town-layout-unit.js`,
  `manual-3d-town-world.js`, `manual-3d-collision-lobby.js`,
  `manual-3d-town-portal-world.js`, `manual-3d-materials-unit.js`,
  `manual-3d-textures-unit.js`, `manual-3d-lobby-interior-world.js`.
