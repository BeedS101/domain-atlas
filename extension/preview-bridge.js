// Domain Atlas — page-supplied asset preview (SPEC.md §3.8.5)
//
// Runs in the extension-origin iframe content.js injects for
// atlasWallet.previewAsset(). The host page can't script into this frame;
// the only input is the flat `view` object content.js builds from the
// page's credential (see bridgePreviewViewOf()), and every string in it is
// written with textContent so it can never be interpreted as markup. The
// panel says plainly that the item is a preview from the page's origin and
// is not in the wallet.
(function () {
  const bodyEl = document.getElementById('body');
  const panelEl = document.getElementById('panel');
  const parentOrigin = '*'; // reply target is the injecting page; the payload carries nothing secret (sizes and a ready ping)

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render(origin, view) {
    bodyEl.textContent = '';
    const name = view.name + (typeof view.quantity === 'number' ? ' ×' + view.quantity : '');
    bodyEl.appendChild(el('div', 'name', name));
    bodyEl.appendChild(el('div', 'meta', view.assetClass + (view.issuer ? ' · issued by ' + view.issuer : '')));
    bodyEl.appendChild(el('div', 'note', 'Preview from ' + origin + ' — not in your wallet'));
    if (typeof view.thumbnail === 'string' && /^https?:\/\//i.test(view.thumbnail)) {
      const img = el('img', 'thumb');
      img.alt = '';
      img.src = view.thumbnail;
      img.addEventListener('load', reportSize);
      bodyEl.appendChild(img);
    }
    if (Array.isArray(view.properties) && view.properties.length) {
      const props = el('div', 'props');
      view.properties.forEach((pair) => {
        if (Array.isArray(pair) && pair.length === 2) props.appendChild(el('div', '', String(pair[0]) + ': ' + String(pair[1])));
      });
      bodyEl.appendChild(props);
    }
    reportSize();
  }

  function reportSize() {
    window.parent.postMessage({ type: 'domain-atlas-bridge-preview-size', height: panelEl.getBoundingClientRect().height }, parentOrigin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== 'domain-atlas-bridge-preview-show' || !data.view || typeof data.view !== 'object') return;
    render(typeof data.origin === 'string' ? data.origin : 'this page', data.view);
  });

  // Any later change in the panel's height (an image finishing loading, say)
  // is reported too, so the frame always fits it with no scrollbar.
  if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(panelEl);

  window.parent.postMessage({ type: 'domain-atlas-bridge-preview-ready' }, parentOrigin);
})();
