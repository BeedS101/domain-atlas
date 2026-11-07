# 3D Movement v0.1 (gltf-mini)

Jumping, a double jump and crouching in the 3D renderer now use heights, not only the horizontal footprint. The character can clear low obstacles, land on crates and furniture, and crouch under low openings. It is a small vertical layer on the existing collision, not a physics engine: 2D movement, combat, stamina and enemies are untouched.

## Controls

| Key | Behaviour |
| --- | --- |
| Space | Jump. A fresh press in the air jumps once more (double jump). Holding Space is still one jump. |
| Ctrl (left or right) | Crouch while on the ground. The model compresses toward the feet and the eye lowers. |

Walking and running speed, camera controls, first-person mode, equipment and jump or speed buffs are unchanged. Jump buffs scale both jumps.

## Rules

- **Body.** Standing height 1.8, crouched height 1.2, same radius as before. Collision uses the real vertical extent of each placed object.
- **Hurdles and platforms.** An object blocks you only where it overlaps your body in height. If your feet are at or above its top (within a small tolerance) you walk over it or land on it. Crates (0.28), sofas (0.46) and low bookcases (0.79) can be jumped onto: one jump reaches roughly 0.57, a double jump roughly 1.1 (more with jump buffs).
- **Landing.** You stand on the highest thing under your feet. Walking off an edge makes you fall, and that fall counts as your first jump, so one air jump remains. The jump count only resets when you land on something.
- **Barriers.** An object 1.0 or taller (walls, hedges, columns, tall plinths) can never be stood on or hopped, whatever the buff or the number of jumps. The floor limits apply at every height, so the room edge cannot be jumped over either.
- **Flat solids.** Solids under 0.15 high (the Lobby river sheet, the round cafe table) keep blocking exactly as before; they are not stepped on or hopped.
- **Overhead.** An object whose underside is above 1.8 is walked under, and caps a jump at its underside. An object whose underside is between 1.2 and 1.8 (a lintel) is passable only crouched.
- **Standing up.** Releasing Ctrl while something is in the headroom keeps you crouched until it is clear. You cannot jump out of a crouch under a low overhead either.
- **Portals and loot.** Portal triggers still use ground distance only, so a jump over a portal marker still enters it. A claimed loot crate stops blocking and stops supporting.
- **Action Bar.** Poses and blocking are drawn on the model only and do not affect jumping or crouching. In the air the legs hold the neutral pose.

- **Outdoor ground.** Grass, paving and river banks are thin non-solid layers 0.015 to 0.05 above the floor level. The drawn model and the eye are lifted to the visible layer under the character (eased across edges), so shoes stay above the ground when standing, crouching or landing. Support and collision are unchanged (`getMovementState().feetY`); indoor floors and rugs are not affected. `getMovementState().surfaceLift` shows the current lift.

Known limit: small items resting on a larger piece (a monitor on a desk) are covered by the piece underneath and are not separate colliders, so a character standing on the desk can walk through them.

## Try it in the Lobby

1. Load the extension, open the demo domain, enter the Lobby (portal in the Plaza).
2. Press Space for a jump, Space twice for a double jump, hold Ctrl to crouch (the model squashes and stays on the floor; the eye lowers).
3. Jump onto a cardboard crate (small, so aim for its centre) or the sofas; walk off the far side and fall.
4. Run at a wall or a hedge and mash Space: you stay on this side.
5. Walk over the portal marker while jumping: it still triggers.

## Obstacle scene

`test/fixtures/movement-obstacles/scene.json` is a purpose-built scene with one lane per case. Lanes run along z, the obstacle sits at z = 0:

| x | Obstacle | Expected |
| --- | --- | --- |
| -11 | low crate, 0.28 | blocks walking, a jump clears it |
| -8 | crate, 0.56 | one jump lands on top |
| -5 | sofa, 0.46 | one jump lands on top |
| -2 | bookcase, 0.79 | one jump is not enough, a double jump lands on top |
| 1 | wall, 2.06 | cannot be hopped |
| 4 | lintel, underside 1.4 | blocked standing, passable crouched |
| 7 | beam, underside 2.2 | walk under; a jump is capped at 0.4 |
| 10 | hedge, 1.1 | cannot be hopped |

To walk it yourself, serve a copy of the demo domain with the fixture at `/spatial/movement-test/scene.json` and add a world whose `entry.scene` points at it (see the top of `test/manual-movement-3d.js`). Nothing in `demo-domain-a` or `demo-domain-b` changed.

## Tests

```
node test/movement-3d.js                         # pure movement core and the Lobby layout, no browser
xvfb-run -a node test/manual-movement-3d.js      # real browser: Lobby, then the obstacle scene
MOVEMENT_ONLY=obstacles xvfb-run -a node test/manual-movement-3d.js   # skip the Lobby part
```

The browser test takes a few minutes under software rendering. It drives real key presses and reads the `getMovementState()` debug hook (feet height, vertical speed, grounded, jumps used, crouch, body height, model squash).

## Code

All in `extension/gltf-mini.js`: `stepBody` and its helpers (pure, exported as `MiniGLTF.movement`) hold the vertical rules; `collisionDepth` and the frame loop call them, so the horizontal sliding and "walk out if already overlapping" rules are the ones that were there. `getCharacterFloorY()` (broadcast as presence `y`) is now the feet height: 0 on the floor, never negative while crouching.
