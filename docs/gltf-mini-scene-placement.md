# gltf-mini-v1 scene placement and collision

Reference-implementation notes for `scene.json` worlds drawn by
`extension/gltf-mini.js`. This format is not part of SPEC.md.

## Placement

Each entry in `objects[]` places one GLB:

- `position` is `[x, y, z]` in world units, `y` up, floor at `y = 0`. A missing
  or non-numeric component is treated as `0`.
- `rotationY` is degrees around the Y axis (`x' = x cos + z sin`,
  `z' = -x sin + z cos`, the same convention as Three.js, so
  `tools/scene-editor.html` and the renderer agree).
- `scale` is a uniform factor, default `1`. Zero or non-numeric means `1`.
- `solid` is `true` by default. `solid: false` (or `collision: false`) removes
  the object's collision box. Use it for pieces whose bounding box is mostly
  empty (a wall piece with a door opening, an open door leaf), for ground cover
  such as lawn patches whose tuft rises above the rug threshold, and for
  decoration such as roof pieces and wall banners.

The model's own origin is what lands on `position`. Models are not recentered:
the bundled furniture kit puts the origin at a back corner (x from `0` to
width, z from `-depth` to `0`) while a few pieces (TV, plants) are centered. To
put one object on another, compute the supporting object's world extents (for
example with `layout.placedFootprint` from `window.MiniGLTF.layout`) and place
the object inside them at the support's top (or shelf-board) height.
`test/manual-3d-layout-unit.js` checks this for the demo Lobby.

Ground cover is sunk so its top sits at the floor: the outdoor kit's
`grassPatch` has a 0.06 base slab with tufts up to 0.23, and `pathTile` is a
thin slab, so the Lobby places them at `y = -0.05` and `y = -0.065`. The
outdoor kit is authored at real-world size, so it is placed at scale `1`, while
the furniture kit is roughly half scale.

A GLB that fails to load is drawn as a 0.5 unit placeholder crate and the rest
of the world still loads.

## Collision

The player is a circle of radius `0.3` on the XZ plane. Each placed object
contributes an oriented box built from the model's real bounds, rotation and
scale, with these exceptions:

- Flat floor coverings (top below `0.05`) such as rugs are walked over.
- Objects whose base is above head height (`1.8`) are not obstacles.
- An object that starts above its supporting object's base, inside that
  object's extent (a monitor on a desk, books on a shelf), is covered by the
  supporting object's box and gets none of its own.
- A looted `oncePerUser` crate stops colliding.

The player's center is also kept within the floor minus `0.1`. The floor is
`floor.size` (`[width, depth]`), centered on the origin unless `floor.center`
(`[x, z]`) moves it; the Lobby's floor is centered at `[0, 3.1]` so that the
south part is a yard outside the building, bounded by the floor edge.

A player who starts inside a box (a spawn or anchor placed too close to
furniture) can walk out of it: while overlapping, moves that do not go deeper
are allowed.

## Character scale

`characterScale` at the top level of `scene.json` is the size of the player's
body in that scene (the Lobby uses `0.5` for its half-scale furniture, the Domain B
Gallery `1.4`). A valid declared value is authoritative: it is applied on entry,
a scale saved from the settings slider (`atlasCharacterScale`,
`AtlasWallet.getSavedCharacterScale`, `null` until they save one) does not
override it, the slider is disabled while the scene owns it, and the saved value
is left untouched. Entering another scene applies that scene's value at once. A
scene that declares none (missing or non-numeric) falls back to the saved
preference, then `1`. The scene value is never written to storage.

The scale only resizes the drawn character (and other visitors' characters,
which are drawn at the scene's size). Positions, collision, the player radius,
eye height, portals, anchors and interaction radii are never multiplied by it.

In first person the eye stays at the scene's eye height while the body scales,
so when the scaled shoulders would reach the eye line (scales above about `1.04`
at the default `1.6` eye height) the torso and arms are not drawn; legs and
shoes still are, and the third-person camera is unaffected.

## Camera

`camera.start` and anchors give `[x, y, z]`; `y` is the standing eye height. A
`y` below `0.5` (for example the ground-level `[x, 0, z]` anchors shown in
SPEC.md section 3.5) is not a plausible eye height and resolves to `1.6`.

The scroll wheel zooms the view from first person (distance `0`) out to a
third-person follow camera (distance `5`). That zoom level is a device-wide
viewer preference, saved in the extension settings (`atlasCameraDistance`,
`AtlasWallet.getCameraDistance`/`setCameraDistance`) and applied whenever a
scene is entered, including through a portal or anchor. It only offsets the
rendered camera: eye height, anchor coordinates, the player position and
collision never depend on it, and a scene cannot set it.

## Facing

The bundled furniture kit's models all face local `+z`, so a model's front in
the world is `(sin(rotationY), cos(rotationY))`: `rotationY: 0` faces `+z`
(south in the Lobby), `90` faces `+x`, `180` faces `-z` (north), `-90` faces
`-x`. A monitor and keyboard therefore need the same `rotationY` as the
direction toward the chair they serve, and a chair faces its desk with the
opposite rotation. The Lobby's reception desk has its chairs on the north side
(`z` smaller than the desk), so its monitor and keyboard use `rotationY: 180`.

## Dropped items

A dropped item's model is normalized to a fixed size and centered on its
bounding-box middle before it floats and spins, so corner-origin models sit on
their drop position instead of orbiting a corner.
