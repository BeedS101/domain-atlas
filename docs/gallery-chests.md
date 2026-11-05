# Gallery chests

The Atlas Showcase Gallery has two chests that open with a key made in the Asset Studio. This is a reference-implementation feature: the protocol (SPEC.md) does not define it, and only the PHP issuer implements it. The Node issuer has no chest route and does not list `open-chest` in `/atlas/capabilities`.

## Scene fields

A chest is an `interactables` entry in the world's `scene.json`:

```json
{ "position": [16, 1, -9], "radius": 2.2, "label": "Open the Gem Chest (needs a key)",
  "action": "open-chest", "chestId": "gallery-gem", "chestName": "gem chest",
  "class": "atlas.gem.ruby" }
```

`chestId` names an entry in `ATLAS_CHEST_CATALOG` (`issuer-php/lib/chests.php`); `class` is the reward class, used by the previewer; `chestName` is the wording used in prompts. The marker has no `oncePerUser`, so the chest model stays visible after it is opened.

## Opening

1. The viewer asks `GET /atlas/chest/status` whether this wallet has already opened the chest.
2. It looks in the wallet for an unexpired credential of the key class (`atlas.demo.studio.collectible`, template `key`) issued by the same domain. With none, it offers to open the Asset Studio.
3. With a key, it asks for confirmation ("A key will be consumed to open the chest, do you want to continue?").
4. On confirmation the wallet signs an `open-chest` intent and posts it to `POST /atlas/asset/open-chest` with a `requestId`. The issuer revokes the key (reason `consumed`), signs the reward and answers with both, as one journalled replacement.

A chest opens once per wallet. The issuer records `{requestId, keyId, openedAt}` under a hash of chest and owner before it spends the key. A chest counts as opened only when that marker exists and its key is revoked, so a request that died before the key was spent does not lock the chest. Repeating a request with the same `requestId` returns the stored answer.

## Rewards

`atlas.gem.ruby` and `atlas.tool.pickaxe` are non-fungible collectibles with `restrictedIssuance: 'chest'`: they cannot be minted through the Studio, the trade catalog or `mint_asset_by_class`, only by the chest route. The pickaxe is a collectible only.

## Gallery assets

`tools/gen-gallery-assets.py` builds the textured gallery models (`demo-domain-b/assets/gallery/`), the chest and reward models and thumbnails. The untextured originals are in `tools/gallery-source/`; run `python3 tools/gen-gallery-assets.py [--only a,b] [--from dir]`.

## Tests

- `node test/chest-open-integration.js`: the issuer route (consume, once per wallet, races, crash recovery).
- `xvfb-run -a node test/manual-chest-flow.js`: the whole flow in a browser, including making a key in the Studio.
