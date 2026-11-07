# Mining Burrow v0.1

The first explorable section of the adventure: a player walking in the 3D Lobby's village can walk into the mine, explore a small side-scrolling burrow on foot, and walk back out to the village. It is an exploration prototype. There is no mining, no reward, no currency, no inventory spending, no enemy and no combat in it, and it uses no new assets: the burrow is drawn from a text grid.

## What a player does

1. In the Lobby (Plaza portal, then Lobby), walk out to the hill with the mine in the north-west of the village. The mine mouth holds the Lobby's orange stone travel gate, the same gate the Plaza portal uses, with the plaque "Enter the Mining Burrow".
2. Walk up to the gate (the trigger is the ground just in front of the mine mouth). The view changes to the Mining Burrow, a 2D side view.
3. In the burrow: A / D (or the arrow keys) walk, Space (or W / Up) jumps, E inspects the blocked tunnel. The jump is about 2.3 tiles high at most and shorter if Space is released early; one tap is a hop.
4. To leave, walk left through the daylight at the mine mouth ("Back to the village"). The character comes out in the village just outside the mine mouth, facing away from the hill.

The burrow is dark. Only fixed features light their immediate surroundings: lanterns, glowing crystals, the daylight at the mine mouth, a crack of daylight over the winch and the ore glowing in the collapse. The character carries no light. Away from those, a small ambient level keeps the floor lines and timber platforms faintly visible, the character shows as a dim figure, and a "< Back to the village" hint appears at the screen edge whenever the exit is off-screen.

The burrow has a timber hall with platforms up to a lookout, a rail gallery with a mine cart, an old winch under a crack of daylight, an open shaft with a timber ladder down to a lower tunnel and cart yard, a glowing crystal cavern, and a collapsed tunnel at the far end marked "Needs a pickaxe". Pressing E near the collapse reads a hint. Nothing happens beyond that: it is only a marker for a future pickaxe feature. Falling down the shaft is harmless and the timber on both walls climbs back out.

## What stays the same

The wallet, equipment, Action Bar and Bronze Compass are not touched by the trip. Entering the burrow only changes which renderer is drawing; nothing is read from or written to the wallet by it.

| Part | In the burrow | Back in the Lobby |
| --- | --- | --- |
| Wallet and equipment | unchanged; the equipped hat and shoe colours are shown on the side-view character | unchanged |
| Compass | the capability stays active, but the HUD needs a 3D scene, so it is hidden | HUD returns at once |
| Action Bar | still shown; slot keys flash and selecting items still works; poses are drawn on the 3D character only | same bar, poses work |
| Chat and presence | the burrow is its own world room, joined and left like any other world | the Lobby room is rejoined |
| Item drops | not allowed in the burrow (`itemDropsAllowed: false`) | as before |

Speed and jump buffs from equipment are not applied in the burrow: they belong to the 3D renderer's movement and the side view has one fixed speed and jump.

## How it is built

- **Renderer.** `extension/side-view.js` is a new small renderer, `sideview-v1`. The 2D `procedural-v1` renderer is a static isometric viewer with no character and no movement, so there was nothing to reuse for walking and jumping, and the isometric renderer was not changed. The side view has a pure movement core (tile collision, walking, variable jump, one-way timber platforms, jump buffer, coyote time) exported as `AtlasSideView.step`, and draws everything procedurally on the viewer's 2D canvas with lantern and crystal lighting.
- **World.** `demo-domain-a/spatial/mining-burrow/scene.json` (`format: "sideview-v1"`). `tiles` is the level, one character per tile: `#` rock, `=` timber platform (solid from above only), `B` blocked tunnel, `.` open. `spawn`, `exits` (rectangles that take a manifest portal), `landmarks` (named places whose label shows when the character is near), `blocked` (the description of the blocked tunnel) and `decor` (posts, beams, lanterns, rails, cart, crystals, signs, rubble, winch, skylight, mouth) complete it.
- **Manifest.** `demo-domain-a/.well-known/spatial.json` adds the world `mining-burrow` and a second Lobby portal, `Enter the Mining Burrow`. The burrow's single portal goes back to `lobby` with `anchor: "mine-entrance"`. The burrow's policy copies the Lobby's item-effects and accepted-class settings so equipment behaves the same, and turns drops off.
- **Lobby.** `demo-domain-a/spatial/lobby/scene.json` adds one portal marker (index 1) on the open ground in front of the mine mouth at (-11.6, -12.0), radius 0.9 (trigger only, `hideMarker`), the orange gate placed inside the dark recess at (-11.6, 0.03, -13.35), scale 1.1, non-solid, and the anchor `mine-entrance` 1.8 units out from it, facing away from the hill (`yaw: 180`). The village layout, the existing Plaza gate marker, the reading-nook anchor and every other object are unchanged; `node tools/make-lobby-town-scene.js --check` still passes.
- **Viewer.** `extension/viewer.js` accepts `sideview-v1` as a known renderer, runs it on the existing canvas, tears it down when the world changes, stops drawing the 2D scene while it runs, and passes a same-world portal's `anchor` on to `enterWorld` (it was only used for cross-page links before). `extension/gltf-mini.js` gains one small optional field: an anchor's `yaw`.

- **The gate.** `demo-domain-a/assets/portals/minePortal.glb` is the existing stone gate from `tools/make-town-portal-glb.js` (new target `minePortal`, orange same-domain palette, plaque text taken from the Lobby's portal 1 label), the same geometry and textures as `townPortal.glb`; only the plaque lettering differs. Colours keep the viewer's convention: orange same-domain, blue cross-domain, amber key-anchored (`--palette`). It is non-solid and sits inside the recess (the hill is one solid piece, so the collision against the hill face is unchanged); the trigger and the return anchor are as before.
- **Light.** `AtlasSideView.lightSources` and `lightAt` are pure: the sources are read from the scene's decor and blocked tunnel, there is no character source, and the renderer reads no wallet, item or capability data. Portable light is not implemented. A later version can add a source at the character only for an equipped, verified item with `atlas.cap.light` that the world's `policy.itemEffects` lists (the burrow's policy lists only the compass today), never because an item is named or looks like a lantern.

Two reference-implementation extensions to note, neither a SPEC.md change: a world portal may name an `anchor` in the target world, and an anchor may carry a `yaw` in degrees. Older viewers ignore both. An older extension that meets the new manifest says it cannot render `sideview-v1` rather than failing.

## Upload instructions

Nothing here touches the issuer (no PHP or Node issuer file changes), mints or changes any credential, or needs a new endpoint, currency or asset. There is nothing to run on the server.

**1. The extension build (ship this first).** These files are part of the extension, not a domain:

- `extension/side-view.js` (new)
- `extension/viewer.js`
- `extension/viewer.html`
- `extension/manifest.json`
- `extension/gltf-mini.js`

**2. The PHP domain that serves the demo domain's worlds** (the first demo domain, the one with the Lobby; document root = the folder that holds `.well-known/`, `spatial/` and `assets/`). Upload these four, keeping the folder structure:

| Local file | Place on the domain | Note |
| --- | --- | --- |
| `demo-domain-a/.well-known/spatial.json` | `/.well-known/spatial.json` | replaces the file: adds the world and the Lobby portal |
| `demo-domain-a/spatial/lobby/scene.json` | `/spatial/lobby/scene.json` | replaces the file: adds the mine marker and anchor |
| `demo-domain-a/spatial/mining-burrow/scene.json` | `/spatial/mining-burrow/scene.json` | new folder `mining-burrow` and new file |
| `demo-domain-a/assets/portals/minePortal.glb` | `/assets/portals/minePortal.glb` | new file next to `townPortal.glb` (about 200 KB, served as `model/gltf-binary` or `application/octet-stream` like the other models) |

Upload `minePortal.glb` before `spatial/lobby/scene.json`, so the Lobby never points at a missing model.

Nothing else needs uploading. Make sure the web server serves `/spatial/mining-burrow/scene.json` as JSON (`application/json`, like the other scene files) and that a cached copy of `/.well-known/spatial.json` is not held by a CDN or a browser cache rule; the viewer fetches scenes with `no-store`.

The second demo domain (`demo-domain-b`) needs nothing.

To check after upload: enter the Lobby, walk up to the orange gate in the mine mouth, walk left to the daylight to come back. If the manifest is uploaded but `/spatial/mining-burrow/scene.json` is missing, entering the mine shows "Could not load world" and the player can leave with the Plaza portal or Close; the Lobby itself is unaffected.

To roll back: restore the previous `.well-known/spatial.json` and `spatial/lobby/scene.json`; the new burrow folder can stay or go.

## Tests

```
node test/mining-burrow.js                         # movement core, the burrow scene, manifest and Lobby wiring; no browser
xvfb-run -a node test/manual-mining-burrow.js      # real browser: 3D to 2D to 3D, three visits
BURROW_SHOT_DIR=/some/folder xvfb-run -a node test/manual-mining-burrow.js   # also saves screenshots
```

The unit test drives the movement rules, then explores the level on foot with macro-moves from the spawn: every landmark, the lookout, the lower tunnel and the face of the blocked tunnel are reachable, and from every reachable spot the exit can be reached again (no one-way traps). The browser test uses a real wallet with an equipped hat and compass and real key presses: the orange gate in the mine mouth (read from a screenshot) and the hill's collision beside it, entry by walking into the trigger, walking, jumping, a timber platform, the blocked tunnel and its hint (wallet unchanged), typing and wallet-open guards, the dark (luminance of the dark around the character is the same whether it stands 1.6 or 8 tiles away, a lantern lights its surroundings, the silhouette, floor line and off-screen exit hint stay readable), the Action Bar, exit by walking, return position and facing, no bounce back into the mine, the compass HUD, hat buff, wallet and Action Bar after the trip, 3D jump and crouch afterwards, and two more visits (one entered with a portal call) that leave no key listeners or loops behind.

## Known limits

- One fixed speed and jump; equipment buffs and Action Bar poses do not apply in the burrow.
- The compass HUD is hidden in the burrow.
- Other visitors are not drawn in the burrow (presence is joined for the online count and chat only).
- The blocked tunnel is only a marker: the `requires` field in its description names what a later version will check, and nothing reads the wallet.
