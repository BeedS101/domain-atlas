# Lobby town layout

The Domain A Lobby's outdoor area is a 40 x 40 m starter town (the floor is
`size [40, 40]`, `center [0, 3]`, so x runs -20..20 and z -17..23; 1600 m2,
up from 14.4 x 17.4 m). The building keeps its place at the origin and its
entrance (`[3.2, 5.6]`) faces +z (south). There is no activity logic in the
town: the zones below are scenery with room reserved for later use.

World axes: +x east, +z south, +y up, metres. All numbers live in
`tools/lib/lobby-town-layout.js`.

## Zones

| Zone | Where | Contents now | Reserved clear area `[minX, minZ, maxX, maxZ]` |
| --- | --- | --- | --- |
| Main entrance | doorstep `[3.2, 6.4]` | stoop, planters, welcome sign, textured portal gate inside the door | - |
| Plaza | x -3.6..10, z 7..17.6 | pavers, fountain `[3.2, 12.4]`, benches, lamp posts, wayfinding signpost | `[6.9, 8.0, 8.4, 16.2]` |
| Market and social square | x -16.6..-5.6, z 9..19 | flagstone square, lamp posts, barrels, benches, planters | `[-14.4, 11.4, -7.8, 16.8]` |
| Small hut | `[-14.8, 0.8]`, door faces east | non-functional hut, wood pile, barrels | `[-12.0, -0.6, -9.6, 2.2]` |
| Mine and rock yard | north-west, mine front at z -12.8 | rock hill with a dark tunnel recess, rails, ore cart, boulders | `[-13.6, -11.8, -9.6, -8.9]` |
| River and pier | water x 16.4..19.6, pier `[12.8..16.9, 2.8..4.6]` | water (visual, solid), bank, walk-over pier | `[12.8, 2.9, 16.0, 4.5]` |
| Quiet overlook | terrace `[12.4, -10.4]` r 2.5 | benches, low wall, trees, flower beds | `[10.6, -11.8, 13.4, -9.0]` |
| South-east lawn | around `[12.2, 18.6]` | lawn, bench, trees, flower beds | `[11.6, 15.6, 14.0, 19.6]` |

A gravel ring path (2 m wide) goes round the building at x +-9.4, z -8..7.5 so
all four sides can be walked; spurs lead from it to each zone. The reachable
ground is sealed by hedges (south, west, north), the mine hill and the river;
pines and trees beyond the hedges are non-solid backdrop, and a sky box with a
hills texture closes the horizon.

## Files

- `tools/make-town-assets.js` writes the models in
  `demo-domain-a/assets/town/` (ground, paths, river banks and water, sky, mine
  hill, hut, fountain, pier, hedge, boulders, pine, barrel, ore cart, wood pile,
  flower bed, stone wall, signpost). Textures are small embedded PNGs (power of
  two, at most 512 px); the whole set is under 1 MB. Run with `--only a,b` to
  rebuild some.
- `tools/make-lobby-town-scene.js` rebuilds the outdoor part of
  `demo-domain-a/spatial/lobby/scene.json` (the floor and every
  `/assets/outdoor/` and `/assets/town/` object). Everything else in the scene
  is left byte for byte as it was. `--check` verifies the file is current. Outdoor
  props and the building walls use the textured models of
  `assets/lobby/exterior/` (see `docs/lobby-exterior-materials.md`).
- `tools/lib/procedural.js` holds the noise, PNG and mesh helpers shared with
  `tools/make-town-portal-glb.js`.

Ground, paths, banks and sky are "landscape" models placed at `[0, 0, 0]` and
drawn in world coordinates, layered a few millimetres apart (grass 0.015, paths
0.03, paving 0.045, inlay 0.052, water 0.06) so they do not flicker. Flat
layers below 0.05 never collide (the renderer treats them as floor covering);
the water sits above 0.05 on purpose so the river blocks.

## Collision notes

Each model collides as one box from its bounds, so anything that must stay
walkable inside its footprint (ground, paths, sky, signpost, pier, flower
beds, backdrop trees) is placed with `"solid": false`. Solid pieces are the
hedges, fountain, hut, mine hill, river water, boulders, walls, barrels, ore
cart, wood pile and lamp posts.

The building interior's materials are described in
`docs/lobby-interior-materials.md`.

## Tests

- `test/manual-3d-town-layout-unit.js`: floor and scene match the generator;
  interior, gate, interactables, anchor, lights and character scale are
  unchanged; model budget; every zone reachable and back inside; the building
  can be walked round on all sides; no narrow pockets; reserved areas open.
- `test/manual-3d-town-world.js`: the same in the real renderer with held
  keys, plus the engine's collision against the layout model and the portal gate.
