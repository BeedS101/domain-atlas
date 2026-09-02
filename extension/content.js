// Domain Atlas — content script
// Detects a spatial manifest on the current origin and, if found, offers to
// render the world it declares (v1.0: a manifest may declare several worlds
// under `worlds[]`; the button opens whichever one `defaultWorld` names).
(function () {
  const manifestUrl = location.origin + '/.well-known/spatial.json';

  fetch(manifestUrl, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((manifest) => {
      if (!manifest || typeof manifest.spec !== 'string' || !manifest.spec.startsWith('domain-atlas/')) {
        return; // no declared space here — same as a missing robots.txt, not an error
      }
      if (!Array.isArray(manifest.worlds) || manifest.worlds.length === 0) {
        return; // malformed manifest, nothing to enter
      }
      const defaultWorld = manifest.worlds.find((w) => w.id === manifest.defaultWorld) || manifest.worlds[0];
      injectButton(manifest, defaultWorld, manifestUrl);
    })
    .catch(() => {
      // unreachable or not JSON — silently do nothing
    });

  function injectButton(manifest, defaultWorld, manifestUrl) {
    const worldCount = manifest.worlds.length;
    const label = worldCount > 1
      ? `🧭 Enter Space: ${defaultWorld.name} (+${worldCount - 1} more)`
      : `🧭 Enter Space: ${defaultWorld.name}`;

    const btn = document.createElement('button');
    btn.id = 'domain-atlas-enter-btn';
    btn.type = 'button';
    btn.textContent = label;
    Object.assign(btn.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: 2147483647,
      background: '#c05a1f',
      color: '#fff6ef',
      border: 'none',
      borderRadius: '999px',
      padding: '12px 20px',
      fontSize: '14px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(0,0,0,0.35)'
    });
    btn.addEventListener('click', () => openOverlay(manifestUrl));
    document.documentElement.appendChild(btn);
  }

  function openOverlay(startManifestUrl) {
    const existing = document.getElementById('domain-atlas-overlay');
    if (existing) existing.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'domain-atlas-overlay';
    iframe.src = chrome.runtime.getURL('viewer.html') + '?manifest=' + encodeURIComponent(startManifestUrl);
    // The viewer is a cross-origin (extension) iframe, so WebAuthn is
    // blocked by default Permissions Policy unless explicitly delegated —
    // this is what actually lets the identity/wallet ceremonies run.
    // (There used to be a "fullscreen" delegation here too, for an
    // in-iframe Fullscreen button — removed in favor of a plain "F11 for
    // fullscreen" hint, see viewer.js, since requestFullscreen() from
    // inside a cross-origin iframe turned out to be an unreliable fight
    // not worth having when the browser's own shortcut already works.)
    iframe.allow = 'publickey-credentials-create; publickey-credentials-get';
    Object.assign(iframe.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      border: 'none',
      zIndex: 2147483647
    });
    document.documentElement.appendChild(iframe);
  }

  // The viewer runs in an extension-origin iframe, cross-origin from the host
  // page, so it can't reach back into this page's DOM directly. It asks to be
  // closed via postMessage instead.
  window.addEventListener('message', (event) => {
    if (event.data === 'domain-atlas-close') {
      const overlay = document.getElementById('domain-atlas-overlay');
      if (overlay) overlay.remove();
    }
  });
})();
