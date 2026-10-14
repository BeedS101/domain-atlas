# Domain B Workshop v2 — isolated staging

A new 3D scene package has been generated for local testing, with a 46×40 floor, 114 scene object placements, 16 custom low-poly GLB model types, portal arch, collectibles, business counters, lounge seating and a gallery. The complete binary package is delivered separately as `domain-b-workshop-v2.zip`, because the connected repository file writer only accepts text and cannot upload GLB binaries.

**Do not enable `gltf-mini-v1` on the existing Domain B manifest until the GLB assets have been copied to the Domain B document root.** Do not merge to main before browser/issuer smoke tests.

The local bundle contains `spatial/workshop/scene.json`, `assets/workshop/*.glb` and deployment notes. Verify GLB compatibility with the mini-renderer, scene load, camera/orientations, collision, portal travel, membership claims and collectible classes before any production upload. Preserve the existing world policies and Post Office credential issuing. The `atlas.wearable.ring` crate is an illustrative placeholder requiring issuer confirmation.

This branch deliberately leaves current `demo-domain-b/.well-known/spatial.json` and the production world untouched until all binary dependencies can be committed and tested together.
