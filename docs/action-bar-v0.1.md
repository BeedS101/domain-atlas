# Action Bar v0.1 (prototype)

A compact bar of ten slots near the bottom of the viewer, shared by 2D and 3D worlds. It is a local, cosmetic prototype: no enemies, damage, collisions, stamina, consumable spending, mining or capability execution exists, and nothing in the bar claims one.

## Controls

| Key | Slot | Behaviour now |
| --- | --- | --- |
| 1 | Right strike | Slot flashes; in 3D the right arm swings forward |
| 2 | Left strike | Slot flashes; in 3D the left arm swings forward |
| 3 | Right kick | Slot flashes; in 3D the right leg swings forward |
| 4 | Left kick | Slot flashes; in 3D the left leg swings forward |
| 5 | Block | Slot stays lit while the key is held; in 3D both arms rise until release |
| 6 | Left-hand item | Selector (below), eligible off-hand items |
| 7 | Right-hand item | Selector, eligible hand-slot items |
| 8 | Potion | Selector, eligible standard consumables |
| 9, 0 | Reserved | Nothing |

The poses are drawn on the local character only. They are not sent to other players and are not read back as any game outcome.

## Item selector (keys 6, 7, 8)

- **Tap** moves the slot's selection to the next eligible item, then to none, then around again.
- **Hold** for about 350 ms (also when the key release arrives first on a busy page) opens a list. Arrow keys or the same key move the cursor, **Enter** or **Space** confirms, **Escape** cancels, clicking a row confirms that row. Escape closes the list without also opening the wallet.
- **Shift + key** (or Shift-click) is a separate, explicit *use request*. In this prototype it only raises an `atlas-action-bar` event of type `use-request` and shows "Use is not available in this prototype. Nothing was used."
- Selecting only records which item the slot is holding. It does not equip it, use it, spend a use, hide it or change the wallet. Equipment is still changed in the Character window.
- Eligible items come from the unlocked wallet and are refreshed when a key on a selector slot is pressed, when a world loads and when item effects change. Hidden, pending and fungible entries are left out. The selection lives in the page: it survives world and domain changes, and is dropped if the item leaves the wallet.

## When keys are ignored

Nothing happens while typing in a text field, while the wallet or the Character window is open, or while a modal is showing. An open selector closes in those cases. Ctrl, Meta and Alt combinations are left to the browser. A key release always ends what its press started. A held block and an open selector end when the character changes world.

While the wallet or Character window is open the bar and the compass HUD are hidden, so neither sits over the panel.

## Layout

Fixed, centred, 84 px above the bottom edge: clear of the chat widget (left), the control hints and interaction prompt (bottom centre) and the compass HUD (top right). Below 640 px wide the slots shrink to key numbers only. Layer order: bar 8, above chat and below the wallet panel and modals.

## Code

- `extension/action-bar.js`: `createModel` (pure input and selection logic) and `create` (DOM). Has no access to the wallet, storage or network; a unit test enforces that.
- `extension/viewer.js`: shows the bar once a world has loaded, supplies eligible items, decides when keys are blocked, and plays poses on the 3D renderer.
- `extension/gltf-mini.js`: `playAction(name)`, `setBlocking(on)` and `getActionPose()` on the 3D handle.
- Other code can listen for `atlas-action-bar` window events (`action`, `tap`, `selector-open`, `selector-confirm`, `use-request` and so on) without changing the bar.

## Tests

- `node test/action-bar.js`: slot layout, key routing, tap and hold, selection state, stalled pages, and that no use request comes from selecting.
- `xvfb-run -a node test/manual-action-bar.js`: the real flow in the demo plaza and lobby and a second domain, including poses, selectors, typing and wallet guards, the compass HUD and equipment, and world transitions.
