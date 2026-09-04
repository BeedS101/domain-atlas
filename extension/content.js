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

    attachInfoTooltip(btn, manifest, defaultWorld);
  }

  // ---------- hover-tooltip info panel (task #65) ----------
  //
  // Detail for the DEFAULT world only (the one the button itself enters) —
  // a manifest's other worlds aren't reachable without opening the overlay
  // anyway, so probing all of them here would multiply the network cost of
  // a hover for information most hovers will never need. "+N more worlds"
  // is still shown so the button's own "(+N more)" label isn't a dead end.
  //
  // This is a plain floating div, not a native `title` attribute — a title
  // tooltip can't do multi-line layout or update after it's shown, and two
  // of the fields below (live participant count, download size) only
  // resolve after a short async fetch, so the panel needs to render a
  // "…" placeholder first and fill it in when the data arrives.
  //
  // What's deliberately NOT here: whether the scene is already cached.
  // gltf-mini.js's asset cache lives in the extension's own IndexedDB,
  // opened from viewer.html's iframe (extension-origin) — this content
  // script runs in the HOST page's origin instead, with no shared storage
  // and no overlay open yet to ask. Surfacing that would need a messaging
  // round trip this extension has no background/service-worker channel
  // for today; left for the overlay itself to reveal once it's open,
  // rather than adding that plumbing just for a tooltip.

  const PRESENCE_DEFAULT_BASE = 'http://localhost:8004'; // mirrors viewer.js's own fallback — see README's presence section
  const sizeCache = new Map(); // sceneUrl -> Promise<{bytes:number}|{unknown:true}>

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function capabilitySummary(world) {
    const cap = (world.profile && world.profile.capabilities) || {};
    const bits = [];
    if (cap.combat && cap.combat !== 'none') bits.push('combat: ' + cap.combat);
    if (cap.building && cap.building !== 'none') bits.push('building: ' + cap.building);
    if (cap.vehicles) bits.push('vehicles');
    if (cap.landOwnership) bits.push('land ownership');
    return bits.length ? bits.join(' · ') : 'no special capabilities declared';
  }

  // Live participant count, via presence-server's read-only status
  // endpoint (§7 of README — "reports who's here without creating a
  // member the way joining would"). Presence is a pure enhancement
  // everywhere else in this project, never an error, so a network failure
  // here reads as "unavailable," never a misleading "0 people."
  async function fetchParticipantCount(domain, worldId, presenceBase) {
    const base = presenceBase || PRESENCE_DEFAULT_BASE;
    try {
      const res = await fetch(base + '/presence/status?domain=' + encodeURIComponent(domain) + '&world=' + encodeURIComponent(worldId));
      if (!res.ok) return null;
      const body = await res.json();
      return typeof body.count === 'number' ? body.count : null;
    } catch (err) {
      return null; // presence server not running/unreachable — not an error state to alarm over
    }
  }

  // Total download size, gltf-mini-v1 worlds only — a procedural-v1 world
  // (every demo world except the Lobby) has nothing to download at all, so
  // there's no size worth computing or showing for one. Sums HEAD
  // Content-Length across the scene's UNIQUE model URLs (a repeated
  // furniture piece is one download, not N — same dedup gltf-mini.js's own
  // loadScene() already does). Cached per scene URL so re-hovering the
  // same button doesn't repeat the HEAD requests.
  async function computeDownloadSize(world) {
    if (!Array.isArray(world.entry.renderer) || !world.entry.renderer.includes('gltf-mini-v1')) {
      return { notApplicable: true };
    }
    const sceneUrl = location.origin + world.entry.scene;
    if (sizeCache.has(sceneUrl)) return sizeCache.get(sceneUrl);

    const promise = (async () => {
      try {
        const sceneRes = await fetch(sceneUrl, { cache: 'no-store' });
        if (!sceneRes.ok) return { unknown: true };
        const scene = await sceneRes.json();
        const objects = scene.objects || [];
        const uniqueUrls = Array.from(new Set(objects.map((o) => new URL(o.model, location.origin).href)));
        if (uniqueUrls.length === 0) return { bytes: 0 };

        let total = 0;
        for (const url of uniqueUrls) {
          const headRes = await fetch(url, { method: 'HEAD', cache: 'no-store' });
          const len = headRes.ok ? headRes.headers.get('Content-Length') : null;
          if (!len) return { unknown: true }; // one missing size makes the whole total untrustworthy
          total += Number(len);
        }
        return { bytes: total };
      } catch (err) {
        return { unknown: true };
      }
    })();
    sizeCache.set(sceneUrl, promise);
    return promise;
  }

  function attachInfoTooltip(btn, manifest, world) {
    const panel = document.createElement('div');
    panel.id = 'domain-atlas-info-tooltip';
    Object.assign(panel.style, {
      position: 'fixed',
      right: '20px',
      bottom: '68px',
      zIndex: 2147483647,
      maxWidth: '280px',
      background: 'rgba(20,20,22,0.94)',
      color: '#f2ece4',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '10px',
      padding: '12px 14px',
      fontSize: '12.5px',
      lineHeight: '1.5',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      pointerEvents: 'none', // never itself the target of a hover/click — no need to handle leaving the panel
      display: 'none'
    });
    document.documentElement.appendChild(panel);

    const worldCount = manifest.worlds.length;
    const genre = (world.profile && world.profile.genre) || 'unspecified';
    const scale = (world.profile && world.profile.scale) || 'unspecified';

    function render({ participants, size }) {
      const lines = [
        '<div style="font-weight:600;margin-bottom:4px;">' + escapeHtml(world.name) + '</div>',
        '<div>Genre: ' + escapeHtml(genre) + ' · Scale: ' + escapeHtml(scale) + '</div>',
        '<div>' + escapeHtml(capabilitySummary(world)) + '</div>',
        '<div>👥 Live now: ' + (participants === undefined ? '…' : (participants === null ? 'unavailable' : participants)) + '</div>',
        '<div>📦 Download size: ' + sizeText(size) + '</div>'
      ];
      if (worldCount > 1) {
        lines.push('<div style="margin-top:4px;color:#c9c2b8;">+' + (worldCount - 1) + ' more space' + (worldCount - 1 === 1 ? '' : 's') + ' at this domain</div>');
      }
      panel.innerHTML = lines.join('');
    }

    function sizeText(size) {
      if (size === undefined) return '…';
      if (size.notApplicable) return 'none — procedural scene';
      if (size.unknown) return 'unknown';
      return '~' + formatBytes(size.bytes);
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    let shown = { participants: undefined, size: undefined };

    btn.addEventListener('mouseenter', () => {
      shown = { participants: undefined, size: undefined };
      render(shown);
      panel.style.display = 'block';

      fetchParticipantCount(manifest.domain, world.id, manifest.presence).then((count) => {
        shown = { ...shown, participants: count };
        if (panel.style.display === 'block') render(shown);
      });
      computeDownloadSize(world).then((size) => {
        shown = { ...shown, size };
        if (panel.style.display === 'block') render(shown);
      });
    });
    btn.addEventListener('mouseleave', () => {
      panel.style.display = 'none';
    });
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
