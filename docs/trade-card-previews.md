# Asset Viewer previews on Trading Station cards

Hovering, focusing or tapping either side of a Buy or Listings card opens the wallet's floating Asset Viewer
(`extension/viewer.js`) beside it. Nothing about posting, claiming, settling or signing changes.

## What a preview shows

| Side | Preview | Label |
| --- | --- | --- |
| Unique item with a listing snapshot | the listed item's own name, class, issuer, image, model and properties | **Exact listed item** |
| Unique item without a snapshot (older station, older record, mismatched class) | the class's name, image, model and class defaults | **Class preview · not this exact item** |
| Unique item that is *asked for* | the class only | **Class preview · not this exact item** |
| Fungible item | the class description and the listed amount | **Class preview** |

Class previews take their description from `GET /atlas/asset/class` (cached by `AtlasWallet.fetchAssetClassInfo`) and
never describe a specific item. The model is fetched only when **Show model** is pressed.

## Where the exact item comes from

- Buy: `GET /atlas/trade/listings` adds `offerAsset` to a listing whose offer is a unique item. It is built from the
  credential the station verified when the listing was posted and carries only `class`, `name`, `fungible: false`,
  `issuerDomain`, `thumbnail`, `model` (http(s) URLs only) and `properties` (at most 4 KB). No credential id,
  signature, owner key or other wallet record is included. The wallet ignores a snapshot whose class differs from the
  listing's offered class.
- Listings: an open listing uses the staked item still in the wallet; the wallet also stores the same trimmed snapshot
  (`offerSnapshot`) when the listing is posted so a settled listing still shows the item. Records made before this have
  none and fall back to a class preview.

Node (`issuer-server/server.js`) and PHP (`issuer-php/atlas/trade/listings.php`) return the same shape.

## Interaction

- Mouse: hover opens; the panel stays open while the pointer moves onto it (same close grace as inventory previews).
- Keyboard: card sides are focusable; focus opens, Enter or Space pins and moves to **Show model**, Escape closes and
  returns to the side, Tab away closes. Escape closes only the preview, not the wallet panel.
- Touch: a tap pins the preview, tapping the same side or anywhere else dismisses it. Mouse events that follow a tap are
  ignored.
- Scrolling, re-rendering the list and moving to a card button close a preview; the Trade, Cancel and Delete buttons are
  not part of any preview target.
- In the narrow standalone frame (no world loaded, viewport under 560 px wide) previews stay closed, as inventory
  previews do.

Test: `xvfb-run -a node test/manual-trade-card-preview.js both`.
