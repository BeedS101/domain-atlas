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

The model's own origin is what lands on `position`. Models are not recentered:
the bundled furniture kit puts the origin at a back corner (x from `0` to
width, z from `-depth` to `0`) while a few pieces (TV, plants) are centered. To
put one object on another, compute the supporting object's world extents (for
example with `layout.placedFootprint` from `window.MiniGLTF.layout`) and place
the object inside them at the support's top (or shelf-board) height.
`test/manual-3d-layout-unit.js` checks this for the demo Lobby.

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

The player's center is also kept within the floor (`floor.size`, centered on the
origin) minus `0.1`. A player who starts inside a box (a spawn or anchor placed
too close to furniture) can walk out of it: while overlapping, moves that do not
go deeper are allowed.

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
