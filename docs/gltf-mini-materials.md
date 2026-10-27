# gltf-mini-v1 materials and scene fog

Reference-implementation notes for what `extension/gltf-mini.js` draws from a
GLB material, and the optional scene `fog`. This format is not part of
SPEC.md. Placement, collision and base-colour textures are described in
[gltf-mini-scene-placement.md](gltf-mini-scene-placement.md).

The renderer is one WebGL 1 program with simple lighting (an ambient term plus
one directional light, no shadows). Every feature below is optional: a model
that uses none of them draws exactly as it always did, and any feature that
cannot be used falls back to the plain material and logs a console warning;
it never stops a model or a scene from loading.

## Supported

| Feature | glTF source | Notes |
| --- | --- | --- |
| Base colour | `pbrMetallicRoughness.baseColorFactor` | Multiplied by the texture below. |
| Base-colour texture | `baseColorTexture`, `texCoord` 0 | Embedded PNG/JPEG only. See the scene placement notes. |
| Emissive | `emissiveFactor`, `emissiveTexture` | Added after lighting. |
| Normal map | `normalTexture`, `texCoord` 0, `scale` | Tangent space, TEXCOORD_0. |
| Alpha cut-out | `alphaMode: "MASK"`, `alphaCutoff` | Default cutoff 0.5. |
| Opaque | `alphaMode: "OPAQUE"` (the default) | Texture alpha is ignored. |
| Unlit | `extensions.KHR_materials_unlit` | Honoured on the material. |
| Scene fog | `scene.json` `fog` | Linear, applies to the whole world. |

### Emissive

`emissive = emissiveFactor * emissiveTexture.rgb`, added after the lighting
term, so a glowing surface stays visible with the light off. The factor
defaults to `[0, 0, 0]` as in glTF, so an emissive texture without a factor
adds nothing. Factor components are clamped to 0-1. An `emissiveTexture` needs
`TEXCOORD_0`; if the texture cannot be decoded or the primitive has no UVs,
the material is not emissive at all (not "emissive without the texture"). An
`emissiveFactor` that is not three finite numbers is ignored. Emissive is
ignored on an unlit material. `KHR_materials_emissive_strength` is not read.

### Normal maps

The tangent frame is built per pixel from screen-space derivatives of the
position and UV (`OES_standard_derivatives`), so no tangents are needed in the
file and no vertex attribute is added. The map must be tangent space in
OpenGL convention (green up), as glTF defines it. `scale` multiplies the
x/y of the sampled normal (default 1; 0 gives the vertex normal). The primitive needs `TEXCOORD_0` and
`NORMAL`. When either is missing, when the texture cannot be decoded, or when
the browser lacks `OES_standard_derivatives`, the model shades with its vertex
normals as if it had no normal map.

### Alpha MASK

Pixels whose alpha (`baseColorFactor` alpha times base-colour texture alpha)
is below `alphaCutoff` are discarded, so they write no depth and whatever is
behind shows through. Pixels that survive are fully opaque. `OPAQUE` draws as
before. `BLEND` is not supported: such a material draws opaque, exactly as it
did before this feature existed (several bundled models rely on that), and no
warning is logged for it.

### Unlit

A material with `KHR_materials_unlit` shows `baseColorFactor * baseColorTexture`
without the ambient or directional light; the normal map and emissive do not
apply. The material counts even when the file does not list the extension in
`extensionsUsed`. Fog still applies.

### Fog

`scene.json` may carry a top-level `fog`:

```json
"fog": { "color": "#9ab4c8", "near": 20, "far": 60 }
```

- `color`: `#rgb` or `#rrggbb`.
- `near`: distance in metres from the camera where fading starts (finite, 0 or more).
- `far`: distance where the surface is fully the fog colour (finite, greater than `near`).

The blend is linear in the eye distance of each pixel: `0` at `near`, `1` at
`far`. It covers the floor, scene objects, characters and item drops, but not
the sky/background colour, so choose a fog colour close to the scene background
if the horizon should disappear. Without a `fog` key nothing changes. An
invalid `fog` (wrong types, a colour name, `far` not greater than `near`, a
missing field) is ignored with a console warning. Model previews (`previewModel`)
do not use fog.

## Not supported

- `alphaMode: "BLEND"` (see above).
- Metallic-roughness shading, occlusion textures, `KHR_materials_*` other than
  `unlit`, `KHR_texture_transform`, environment maps and reflections.
- Shadows, post-processing, bloom, tone mapping, colour-space conversion.
- Animation and skinning.
- External image URIs and `data:` URIs; only images embedded in the GLB BIN
  chunk (`image/png`, `image/jpeg`).
- `texCoord` other than 0 on any texture.
- WebGL 2-only features.

## Resource notes

Each distinct embedded image is uploaded once, whichever slots use it, and
shared by every primitive and every placed copy of the model. All textures are
deleted when the world is destroyed. Base colour, emissive and normal textures
use texture units 0, 1 and 2; models without them bind a 1 x 1 fallback.

## Tests

- `test/manual-3d-materials-unit.js`: material parsing, fallbacks, `normalizeFog`
  and an extraction check over every bundled GLB (no new keys, no new warnings).
- `test/manual-3d-materials-world.js`: one small generated model per feature
  drawn in a browser, with exact pixel colours.
- `tools/lib/glb-builder.js` (`buildMultiGlb`) builds the test models; its
  material spec accepts `emissiveFactor`, `emissiveTexture`, `normalTexture`,
  `alphaMode`, `alphaCutoff` and `unlit`.
