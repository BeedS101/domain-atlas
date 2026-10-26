# Domain Atlas Outdoor Starter Kit

Original low-poly GLB 2.0 assets for the Domain Atlas demo renderer.

## Files and intended scale

- grassPatch.glb — 2.0m x 2.0m ground patch
- pathTile.glb — 1.0m x 1.0m walkway tile
- shrub.glb — about 0.8m tall
- treeSmall.glb — about 2.7m tall
- benchOutdoor.glb — about 1.6m wide
- lampPost.glb — about 2.4m tall
- welcomeSign.glb — about 1.6m tall
- planterBox.glb — about 1.2m wide

Conventions:
- +Y is up.
- Freestanding props use a base-centered origin.
- Models are intentionally low-poly and use solid PBR base colors only.
- No external textures are required.
- These are suitable for the current gltf-mini renderer subset.

The included PNGs are simple identification previews, not pixel-faithful renderer captures.
For final wallet thumbnails, regenerate PNGs through extension/gltf-mini.js previewModel()
(the same approach already used by tools/make-demo-item-models.js).

Suggested repo location:
demo-domain-a/assets/outdoor/

Suggested first scene use:
door -> short pathTile chain -> grassPatch lawn, with 1 bench, 1 lampPost,
2-4 shrubs/planters, 1 small tree and 1 welcome sign.

Do not rescale everything blindly. Test against the Lobby's character scale and collision first.
