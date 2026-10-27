# gltf-mini debug HUD

A small developer overlay for `gltf-mini-v1` worlds, for scene authoring,
testing and debugging. It is hidden by default and does not change rendering,
shaders, materials, collision, movement, the camera or any scene.

## Toggle

Press **F3** while a 3D world is open to show or hide it. There is no other
switch: normal users never see it unless they press the key. From a console in
the viewer page, `MiniGLTFHud.show()`, `MiniGLTFHud.hide()` and
`MiniGLTFHud.toggle()` do the same.

While hidden the HUD costs nothing: no element, no timer, only the key listener.
While shown it is one fixed `pointer-events: none` element (dark translucent
background, small monospace text, top left under the header) rebuilt four times
a second. It never takes focus and never blocks mouse or keyboard input to the
scene. It makes no network requests.

## Fields

PERFORMANCE

- `FPS` and `Frame time`: from the renderer's frame counter, averaged over each
  quarter second and smoothed, so the numbers stay readable. This is the
  rendered frame rate, so it drops if the renderer is stopped or the tab is in
  the background.
- `Renderer`: `gltf-mini-v1`.
- `Scene`: the world id (passed to the renderer as the `debugLabel` option).
- `Char scale`: the character scale in use; `(scene)` when the scene declares it.
- `Player`: x, floor-relative y and z of the character.
- `Camera`: the eye position. It equals the player's eye in first person and sits
  behind the player in third person.

RESOURCES

- `Models`: distinct scene models loaded (`+ N drop` for item-drop models), and
  the size of the renderer's shared model cache.
- `GPU textures`: live GL textures of this renderer's context, including the 1x1
  fallback texture. It is maintained where textures are created and deleted, so it
  matches an independent GL count, and returns to 0 once the renderer is
  destroyed (the models' textures are released on the next microtask turn).
- `Item drops`: drops currently held, drawn as a marker, as their model or as the fallback.
- `Objects` and `drawables`: scene objects, and the primitives drawn for them
  (one object can have several).

DROPS (shown while there are item drops; see `docs/world-drop-render-policy.md`)

- `Rendered`: drops drawn from their own model (`(n preview)` of them from a
  `dropPreviewModel`).
- `Fallback`: drops drawn as the generic fallback shape.
- `Rejected GLB`: the fallbacks that were refused on the world-drop budget, as
  opposed to a model that was missing or corrupt.
- `Pending` and `Marker only` appear only when non-zero.

ACTIVE FEATURES: see below.

STATUS: only shown while there are entries; see below.

With no 3D world loaded (for example in a 2D world) the HUD says so.

## Active features

The indicators describe the content that is loaded now, not what the renderer is
able to do. `ON n` gives the number of drawn primitives that use the feature.

| Feature | ON when |
| --- | --- |
| Fog | the scene has valid `fog` (an invalid one is ignored, as in rendering) |
| Normal maps | a drawn primitive has a normal map on the GPU |
| Emissive | a drawn primitive's material is emissive (a factor, or a factor with a usable texture) |
| Alpha MASK | a drawn primitive uses `alphaMode: "MASK"` |
| Unlit | a drawn primitive uses `KHR_materials_unlit` |

The counts come from the same material state the renderer draws with, so a
texture that failed to decode, or an emissive texture without a usable factor,
does not count. Item-drop models are included. The counts are computed on demand
and cached until the drawn set changes (a scene load, or a drop model loading or
being removed); nothing is traversed per frame.

## Status entries (for later buffs and game state)

```js
MiniGLTFHud.setDebugStatuses([
  { label: 'Speed boost', value: 'ON' },
  { label: 'Portal key', value: 'ACTIVE' }
]);
MiniGLTFHud.setDebugStatuses([]); // clears them and hides the section
```

Entries are display-only text: the call never touches the renderer. Labels are
cut at 32 characters, values at 40, entries without a label are dropped and at
most 20 are kept. The list is kept across world changes and while the HUD is
hidden. No gameplay buffs exist yet; this is only the place they would show up.

## Files

- `extension/gltf-mini-hud.js`: the overlay, the F3 key and the text. Loaded by
  `viewer.html` after `gltf-mini.js` and listed in `manifest.json`
  `web_accessible_resources`. `viewer.js` installs it once with the current
  renderer and passes `debugLabel` when entering a world.
- `extension/gltf-mini.js`: `getDebugInfo()` (a read-only snapshot), a frame
  counter, a per-context live-texture count, and the feature counts. `destroy()`
  now ignores a second call.

## Tests

- `test/manual-3d-hud-unit.js`: toggling, hidden cost, FPS smoothing, text,
  feature ON/OFF text and statuses, against a fake DOM.
- `test/manual-3d-hud-world.js`: in the real viewer: F3, input pass-through,
  FPS, positions, counts against an independent GL texture count across world
  entry, exit and `destroy()`, each feature on and off, pixel parity hidden vs
  shown, and statuses.
