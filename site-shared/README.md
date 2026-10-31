# Shared site chrome: Terms & Conditions, footer, risk notice

One source of truth for the website terms, the copyright footer and the experimental-platform notice used by
the demo sites. The result is plain static HTML: shared PHP hosting needs no Node, no PHP include and no build
step, and everything works with JavaScript disabled.

## Sources

| File | Purpose |
| --- | --- |
| `terms-content.html` | The Terms & Conditions text. The only place it is written. |
| `terms-page.html` | Shell of the generated `/terms/` page (styles, "Home" link, footer). |
| `footer.html` | Copyright line and the "Terms & Conditions \| Experimental Platform" line. |
| `risk-notice.html` | Short notice shown at interactive entry points. |
| `site.css` | Footer and notice styles, inlined into each stamped page. |
| `pages.json` | Which page gets what, and which files are deliberately excluded (with the reason). |

All links are root-absolute (`/terms/`), so each domain, and any local test server, links to its own terms page.

## Workflow

```
node tools/site-chrome.js           # regenerate: stamp pages, rebuild every terms/index.html
node tools/site-chrome.js --check   # verify without writing (also run by test/site-chrome.js)
node test/site-chrome.js            # links, footer coverage, duplicates, /terms/ resolution
node test/manual-site-chrome-browser.js [screenshot-dir]   # mobile/desktop layout, JS on and off
```

Stamped regions are delimited by `<!-- atlas-site:head|notice|footer:start/end -->` comments. Re-running the tool
replaces them in place; do not edit between the markers. The three `terms/index.html` files are generated and
identical; edit `terms-content.html` and re-run.

### Changing the terms

Edit `terms-content.html`, bump the "Version" line, run `node tools/site-chrome.js`, then upload the three
generated `terms/index.html` files (see `docs/site-terms-deployment.md`).

### Adding a page

Add its repo-relative path to `pages.json` under `notice` (interactive page: footer plus notice) or `footerOnly`
(footer only), then run the tool. A new HTML file that is in neither list nor in `excluded` fails `--check`.

## Pages not covered

Listed under `excluded` in `pages.json`: the browser-extension UI pages, `tools/scene-editor.html`,
`experiments/`, `directory-server/index.html` (a separate reference service with its own host), `docs/` and the
templates in this folder.
