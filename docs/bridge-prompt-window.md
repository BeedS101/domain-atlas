# Wallet-bridge confirmation window

A page that asks the wallet to sign (`requestSignature`), accept an offer (`offerAsset`), buy a coin
(`requestPurchase`) or, on first contact, which identity it should see, is answered through a confirmation the
visitor decides on. This describes where that confirmation is drawn and what the requesting page can and cannot do
to it. It covers `extension/background.js`, `extension/content.js` and `extension/confirm-bridge.*`; the permission
checks in `content.js` (manifest `walletBridge` policy, purpose and class whitelists, the identity bound to the
exact origin) are unchanged.

## What was wrong

The prompt used to be an extension-origin iframe that `content.js` inserted into the requesting page. It could not
be read or scripted, but it was still an element of the page, which left the page in control of everything that is
not its contents:

- **Covering and hiding it.** Page CSS could target the frame (`opacity: 0`, `pointer-events`, `transform`,
  `filter`, `display`, `clip-path`), put its own layer above it, or place a modal `<dialog>` in the top layer.
  An invisible frame still received real clicks, so a decoy button under the Approve button made the visitor
  approve a signature they never saw.
- **Answering it.** The decision came back as a `window.postMessage` from the frame, accepted when
  `event.source === iframe.contentWindow`. A page could navigate that frame to a document of its own; the same
  `contentWindow` then belonged to the page's document, which could post "approved" with any result.
- **Removing or starving it.** Removing the node left the request waiting for its own timeout.

Both the invisible-click and the forged-approval cases were reproduced against the previous code.

## What it is now

`content.js` asks `background.js` (`domain-atlas-bridge-confirm-open`) and waits. `background.js` files the
request under a token it generates, with the origin Chrome reports for the sender, and opens
`confirm-bridge.html#<token>` with `chrome.windows.create({ type: 'popup' })`. Nothing of the prompt is in the
page, so no style, script, DOM operation, focus change or window message of the page reaches it.

- The prompt reads its request once, by token, from `background.js`, and only from the window opened for it.
- Its answer goes to `background.js` (`domain-atlas-bridge-confirm-decision`), which checks the token, that the
  sender is the confirmation page in the window it opened, and then tells the requesting tab with
  `chrome.tabs.sendMessage`. `content.js` accepts that only from extension code and only for its token. No
  `window.postMessage` is read or sent.
- `confirm-bridge.html` and `.js` are no longer web-accessible resources, so a page cannot frame, fetch or open
  them. The page itself also refuses to run when framed.
- Closing the window, closing the tab, or navigating the requesting tab ends the request: declined for a closed
  window, silently dropped when the page that asked is gone. `content.js` keeps its own backstop timeout and
  cancels the window when it fires.
- Pending requests are kept in session storage (as JSON text, to keep payload key order), because the service
  worker can stop while a person is deciding.
- Limits: one pending prompt per tab, three in all, a 500,000-character cap on the request, and a pause after an
  origin has had five prompts declined or closed in a row within a minute (5 s, doubling to 2 min; any approval resets it). A
  refused request is answered as declined, without a window.

The same path serves all four kinds (`sign`, `offer`, `identity`, `buy`). Trusted-offer domains and the display-only
asset preview are unchanged: the first has no prompt, the second is a non-interactive frame whose content comes from
the extension.

## Tests

`test/manual-bridge-prompt-isolation.js` serves a deliberately hostile page (CSS that hides, blurs, shrinks and
disables everything iframe- or extension-looking, a full-page max-z-index layer, a top-layer modal, a mutation
observer that removes and navigates any added frame, continuous forged prompt and decision messages at the page
and every frame, attempts to load the prompt page by URL) and checks that the prompt still appears in its own
window with the real origin and payload, is painted and reachable, is not answered by forged messages, produces a
genuine signature on approval, ends as declined on close, and that repeated declines are paced.
`test/lib/bridge-prompt.js` finds the window for the other bridge tests.

## Not covered

- The world-entry overlay (`#domain-atlas-overlay`) is still an iframe in the page, so a hostile page can restyle or
  cover the whole wallet view it opened for the visitor. It is user-initiated and holds no per-request approval, but
  the same clickjacking applies to anything inside it. The side panel is the surface to move it to.
- `identity-popup.html` and `backup-setup.html` are opened with `chrome.windows.create` but are still listed as
  web-accessible resources.
- A popup is a separate window. A visitor who ignores it can leave it behind other windows; it denies itself after
  120 s of inactivity.
