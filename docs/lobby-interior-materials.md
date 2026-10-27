# Lobby interior materials

The Domain A Lobby interior uses the gltf-mini-v1 material features (base-colour
textures, tangent-space normal maps, emissive, `KHR_materials_unlit`; see
`docs/gltf-mini-materials.md`) on a small set of high-value surfaces. Room
dimensions, furniture placement, collisions, the portal marker and gate, crates,
the reading nook anchor, camera behaviour, `characterScale`, the lights and the
outdoor town are unchanged. Alpha MASK is not used.

## Surfaces

| Surface | Model(s) | Material work |
| --- | --- | --- |
| Floor | `lobbyFloor.glb` | One quad over the grass hole at y = 0.004 (between the base floor at 0 and the 1 cm rugs). Warm flagstone, 0.8 m tiles in a running bond, 3.2 m repeat, matte, with a normal map. |
| Walls | `wall.glb`, `wallWindow.glb`, `wallDoorway.glb`, `wallDoorwayWide.glb` | Plaster on the room-facing (+z) face only, with a baked baseboard and a faint normal map. Exterior face, window frames, glass and bounds are untouched. |
| Wood | `desk`, `bookcaseClosedWide`, `bookcaseOpen`, `cabinetTelevision`, `tableCoffee`, `tableRound` | Grain texture and normal map on the `wood` material only. Geometry unchanged. |
| Screens | `computerScreen`, `televisionModern` | Emissive display texture on the screen glass. |
| Lamps | `lampRoundTable`, `lampSquareTable`, `lampRoundFloor` | Faint emissive factor on the shade. |
| Plaque | `lobbyPlaque.glb` | Small unlit wall plaque with baked text, placed on the north wall. |

Props, rugs, crates, the portal gate and everything outdoors keep their original
materials.

## Why the exterior and collisions do not change

- Wall models are copies of the originals with the same geometry and bounds, so
  footprints are identical. The plaster primitive is split out of `_defaultMat`
  by face normal, so the +z interior face is the only thing retextured; the
  exterior face stays `metalDark`.
- Retextured props keep their original vertices and bounds.
- The floor and plaque are scene objects with `"solid": false`, and the floor is
  a flat layer below 0.05, so neither adds collision.
- The floor sits 4 mm above the base floor and 6 mm below the rugs; the world
  test checks a grazing view for any base floor or stone showing through a rug.

## Files

- `demo-domain-a/assets/lobby/interior/*.glb`: 17 generated models, textures
  embedded as PNG (128-1024 px), about 945 KB in total.
- `demo-domain-a/spatial/lobby/scene.json`: the original wall and prop URLs are
  swapped for the interior copies, and the floor and plaque objects are added.
- `tools/make-lobby-interior-assets.js`: generator. Everything is procedural and
  deterministic. `--scene` also updates `scene.json`; `--check` verifies both
  without writing.
- `tools/lib/glb-read.js`, `tools/lib/png-rgb.js`: GLB reader and RGB PNG encoder
  used by the generator.
- `tools/lobby-interior-shots.js`: fixed-camera screenshots of the interior and
  exterior (real extension plus `issuer-server`), for before/after comparison.

Texture size is kept down with adaptive PNG filters, no per-pixel noise, and
normal-map channels quantised to steps of 4.

## Regenerating

```
node tools/make-lobby-interior-assets.js --scene
node tools/make-lobby-interior-assets.js --check
```

The original `assets/furniture/` models are not modified. Reverting the scene
URLs restores the previous look.

## Tests

- `test/manual-3d-lobby-interior-unit.js`: models and scene match the generator;
  bounds and footprints equal the originals; wall exteriors keep their material;
  every texture is within the size budget.
- `test/manual-3d-lobby-interior-world.js`: in the real renderer, the floor, walls,
  screen and plaque draw; no z-fighting at the floor or rugs; the east and north
  exterior views match the original scene; crates still prompt and a dropped item
  draws on the new floor; walking into the wall stops at the same place as with
  the original models; live GL textures are counted and released on leaving.
