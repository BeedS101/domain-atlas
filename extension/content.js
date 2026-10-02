// Domain Atlas — content script
// Detects a spatial manifest on the current origin and, if found, offers to
// render the world it declares (v1.0: a manifest may declare several worlds
// under `worlds[]`; the button opens whichever one `defaultWorld` names,
// unless SPEC.md §3.5 below names something more specific).
(function () {
  const domainManifestUrl = location.origin + '/.well-known/spatial.json';

  // SPEC.md §3.5 — per-page discovery and anchors. A page opts in with one
  // <link rel="spatial" href="/.well-known/spatial.json#worldId[:anchorId]">
  // tag in its own <head> — the same "one <link> tag" pattern
  // rel="alternate"/Open Graph already use for per-page metadata. This
  // content script checks the CURRENT PAGE for that tag before falling
  // back to the domain-wide manifest and its defaultWorld: precision when a
  // page offers it, the exact existing behavior when it doesn't. The href
  // itself is resolved like any other link (relative or absolute both
  // work), so pageTarget below falls back to the domain-wide manifest url
  // when there's no tag at all, and to that tag's own manifest url — not
  // necessarily this page's own origin's — when there is one.
  let manifestUrl = domainManifestUrl;
  let pageTarget = null; // { worldId, anchorId } named by the page's own tag, or null
  const spatialLink = document.querySelector('link[rel="spatial"]');
  if (spatialLink && spatialLink.getAttribute('href')) {
    try {
      const linkUrl = new URL(spatialLink.getAttribute('href'), location.href);
      manifestUrl = linkUrl.origin + linkUrl.pathname;
      if (linkUrl.hash.length > 1) {
        const fragment = linkUrl.hash.slice(1); // drop the leading '#'
        const colonAt = fragment.indexOf(':');
        const worldId = colonAt === -1 ? fragment : fragment.slice(0, colonAt);
        const anchorId = colonAt === -1 ? null : fragment.slice(colonAt + 1);
        if (worldId) pageTarget = { worldId, anchorId };
      }
    } catch (err) {
      // A malformed href is the same as no tag at all — fall through to
      // the domain-wide manifest/defaultWorld exactly as if this page
      // never opted in.
      manifestUrl = domainManifestUrl;
    }
  }

  fetch(manifestUrl, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((manifest) => {
      if (!manifest || typeof manifest.spec !== 'string' || !manifest.spec.startsWith('domain-atlas/')) {
        return; // no declared space here — same as a missing robots.txt, not an error
      }
      if (!Array.isArray(manifest.worlds) || manifest.worlds.length === 0) {
        return; // malformed manifest, nothing to enter
      }
      // A page-named world that doesn't actually exist in this manifest
      // (a stale link, a typo) falls back to the ordinary default —
      // exactly "the existing behavior when it doesn't [opt in]," same as
      // never having the tag at all.
      const targetWorld = (pageTarget && manifest.worlds.find((w) => w.id === pageTarget.worldId))
        || manifest.worlds.find((w) => w.id === manifest.defaultWorld)
        || manifest.worlds[0];
      const anchorId = (pageTarget && pageTarget.worldId === targetWorld.id) ? pageTarget.anchorId : null;
      injectButton(manifest, targetWorld, manifestUrl, anchorId);
    })
    .catch(() => {
      // unreachable or not JSON — silently do nothing
    });

  // ---------- SPEC.md §3.7 — optional domain identity pinning ----------
  //
  // This content script runs in the host page's isolated world, with no
  // access to wallet.js's AtlasWallet (that only loads inside the
  // extension's own iframe, a separate execution context — see the
  // "web_accessible_resources" comment on viewer.html). So the small set of
  // crypto helpers it needs are duplicated here rather than shared, the
  // same convention this project already uses for canonicalize()/
  // b64urlDecode() across wallet.js, directory-server/server.js, and
  // issuer-server/server.js — byte-for-byte identical canonicalization is
  // what makes a signature verify the same way everywhere, not a shared
  // module.
  function b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  // Identical verification to wallet.js's verifyKeyAnchoredManifest — §3.7
  // reuses §3.6's algorithm unchanged ("canonicalize the manifest with
  // signature removed, verify against identityKey"), it just applies it to
  // a manifest that also happens to carry a domain.
  async function verifyManifestSignature(manifest) {
    if (typeof manifest.signature !== 'string' || !manifest.signature) return false;
    if (typeof manifest.identityKey !== 'string' || !manifest.identityKey) return false;
    const { signature, ...unsigned } = manifest;
    try {
      const publicKey = await crypto.subtle.importKey('raw', b64urlDecode(manifest.identityKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const data = new TextEncoder().encode(canonicalize(unsigned));
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64urlDecode(signature), data);
    } catch {
      return false;
    }
  }

  // Was this public key ever listed in the domain's own atlas-key.json
  // history (SPEC.md §5.3), even a since-rotated-out entry? A "yes" makes a
  // changed identityKey an ordinary, expected rotation; a "no" is the real
  // anomaly signal. Network failure reads as "no rotation record found" —
  // the same fail-closed-to-disclosure posture §3.7 asks for, never a
  // reason to suppress a warning that would otherwise fire.
  async function wasKeyEverPublished(publicKey) {
    try {
      const res = await fetch(location.origin + '/.well-known/atlas-key.json', { cache: 'no-store' });
      if (!res.ok) return false;
      const doc = await res.json();
      return Array.isArray(doc.keys) && doc.keys.some((k) => k.publicKey === publicKey);
    } catch (err) {
      return false;
    }
  }

  // Checks a domain-anchored manifest's optional identity pin against
  // whatever this browser last saw for this domain (chrome.storage.local —
  // same persistence tier atlasIdentity already uses, since this needs to
  // survive across browser sessions, not just this tab). Returns null when
  // there's nothing to disclose (no pin present, a broken/unverifiable pin,
  // a first sighting, or an unchanged/rotated key), or
  // { previousKey, newKey } when a changed key has no rotation record
  // anywhere — the one case §3.7 says should "disclose plainly," never
  // hard-block (explicitly not §3.6.1's mandatory modal, and explicitly not
  // HTTP Public Key Pinning's all-or-nothing lockout).
  async function checkDomainIdentityPin(manifest) {
    if (typeof manifest.domain !== 'string' || !manifest.domain) return null;
    if (typeof manifest.identityKey !== 'string' || typeof manifest.signature !== 'string') return null;
    const sigOk = await verifyManifestSignature(manifest);
    if (!sigOk) return null; // a broken/garbage pin is never remembered as if it were real

    const domain = manifest.domain;
    let pins;
    try {
      const { atlasPinnedIdentities } = await chrome.storage.local.get('atlasPinnedIdentities');
      pins = atlasPinnedIdentities || {};
    } catch (err) {
      return null; // storage unavailable — nothing to compare against, so nothing to disclose
    }
    const remembered = pins[domain];

    if (!remembered) {
      pins[domain] = { identityKey: manifest.identityKey, firstSeenAt: new Date().toISOString() };
      try { await chrome.storage.local.set({ atlasPinnedIdentities: pins }); } catch (err) {}
      return null; // first visit — nothing to compare against yet
    }
    if (remembered.identityKey === manifest.identityKey) return null; // unchanged — silent

    const rotated = await wasKeyEverPublished(remembered.identityKey);
    const previousKey = remembered.identityKey;
    pins[domain] = { identityKey: manifest.identityKey, firstSeenAt: remembered.firstSeenAt };
    try { await chrome.storage.local.set({ atlasPinnedIdentities: pins }); } catch (err) {}
    if (rotated) return null; // an ordinary, expected rotation — quietly updated, no disclosure

    return { previousKey, newKey: manifest.identityKey };
  }

  function injectButton(manifest, targetWorld, manifestUrl, anchorId) {
    const worldCount = manifest.worlds.length;
    const baseLabel = worldCount > 1
      ? `Enter Space: ${targetWorld.name} (+${worldCount - 1} more)`
      : `Enter Space: ${targetWorld.name}`;
    // SPEC.md §3.5 — a small, constant marker that this button was aimed by
    // the PAGE at a specific point, not just "this domain's front door."
    // Deliberately a plain suffix, not a warning-style prefix (that's
    // §3.7's ⚠ below) — an anchor is a precision improvement, never a
    // trust signal of its own (§3.5's own closing line: "this costs
    // nothing at the trust layer").
    const displayLabel = baseLabel + (anchorId ? ' 📍' : '');

    const btn = document.createElement('button');
    btn.id = 'domain-atlas-enter-btn';
    btn.type = 'button';
    btn.textContent = '🧭 ' + displayLabel;
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
    btn.addEventListener('click', () => openOverlay(manifestUrl, targetWorld.id, anchorId));
    document.documentElement.appendChild(btn);

    const tooltip = attachInfoTooltip(btn, manifest, targetWorld, anchorId);

    // SPEC.md §3.7: resolves asynchronously, well after the button is
    // already up — the same "enrich after initial render" pattern
    // fetchParticipantCount()/computeDownloadSize() already use inside the
    // tooltip itself. Never blocks or delays the button, and a domain with
    // nothing to disclose (no pin, or an unchanged/rotated one — the
    // overwhelming common case) leaves the button exactly as it was. This
    // is deliberately NOT §3.6.1's mandatory disclosure modal: a label
    // prefix, a color change, and a tooltip line a visitor can plainly see
    // without necessarily requiring a click — never a lockout.
    checkDomainIdentityPin(manifest).then((warning) => {
      if (!warning) return;
      btn.textContent = '⚠ ' + displayLabel;
      btn.style.background = '#a4351f';
      tooltip.setIdentityWarning(warning);
    }).catch(() => {});
  }

  // ---------- hover-tooltip info panel (task #65) ----------
  //
  // Detail for whichever world the button itself actually enters — the
  // manifest's own defaultWorld normally, or a more specific one a page's
  // own SPEC.md §3.5 <link rel="spatial"> named instead — never every
  // world the manifest declares; a manifest's OTHER worlds aren't reachable
  // without opening the overlay
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

  // Task #151/#152 — same additions as viewer.js's own
  // portalCapabilitySummary()/effectiveAcceptedItemClasses() (the in-world
  // portal-hover tooltip), extended here too so this Enter button's own
  // hover panel — the FIRST tooltip a visitor ever sees, before even
  // entering — shows the same declared-but-previously-buried manifest
  // data: chat (manifest.chat/world.chat, same two-level opt-in
  // viewer.js's chatEnabledForWorld() checks — inlined here since this
  // content script doesn't share that function), trading (a world a
  // client can recognize as a trading venue by profile.genre, SPEC.md §7 —
  // "trading-station" is this reference implementation's convention), and
  // accepted item classes/trusted issuers (policy.acceptedItemClasses/
  // policy.trustedIssuers — the exact fields task #151's wallet
  // compatibility checkbox also reads, nothing new declared here either).
  // acceptedItemClasses falls back to a domain-level manifest.acceptedItemClasses
  // default (task #152) only when a world doesn't declare its own array at
  // all — an explicit empty array on the world still means "recognizes
  // nothing" and is never overridden by the domain default; a trailing
  // ".*" entry (e.g. "atlas.element.*") is shown verbatim here since this
  // is just a display list, not a match — see viewer.js's classMatchesAny()
  // for where that pattern actually gets interpreted.
  function effectiveAcceptedItemClasses(manifest, world) {
    const policy = world.policy || {};
    if (Array.isArray(policy.acceptedItemClasses)) return policy.acceptedItemClasses;
    if (manifest && Array.isArray(manifest.acceptedItemClasses)) return manifest.acceptedItemClasses;
    return [];
  }
  function capabilitySummary(manifest, world) {
    const cap = (world.profile && world.profile.capabilities) || {};
    const bits = [];
    if (cap.combat && cap.combat !== 'none') bits.push('combat: ' + cap.combat);
    if (cap.building && cap.building !== 'none') bits.push('building: ' + cap.building);
    if (cap.vehicles) bits.push('vehicles');
    if (cap.landOwnership) bits.push('land ownership');
    if ((manifest && manifest.chat === true) || world.chat === true) bits.push('chat');
    if (world.profile && world.profile.genre === 'trading-station') bits.push('trading');
    const policy = world.policy || {};
    if (policy.itemDropsAllowed) {
      const classes = effectiveAcceptedItemClasses(manifest, world);
      bits.push('accepts drops' + (classes.length ? ': ' + classes.join(', ') : ''));
      if (policy.trustedIssuers && policy.trustedIssuers !== 'any') {
        bits.push('issuers: ' + (Array.isArray(policy.trustedIssuers) ? policy.trustedIssuers.join(', ') : policy.trustedIssuers));
      }
    }
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

  // SPEC.md §3.5 — resolves a page-named anchor id to the scene's own
  // label for it ("Aisle 12 — Hardware"), so the tooltip can say exactly
  // where this page's own <link rel="spatial"> points, not just which
  // world. Fetched lazily on hover, same "enrich after initial render"
  // reasoning as fetchParticipantCount/computeDownloadSize just above and
  // below — most page loads are never hovered at all, so there's no reason
  // to spend this fetch on every single one. A dead anchor id (removed
  // from the scene since the page was written, a typo) simply resolves to
  // null — the tooltip already omits the line entirely when this is null,
  // same graceful-degradation the viewer itself gives an unmatched anchor.
  const anchorLabelCache = new Map(); // `${sceneUrl}#${anchorId}` -> Promise<string|null>
  async function fetchAnchorLabel(world, anchorId) {
    if (!anchorId || !world.entry || !world.entry.scene) return null;
    const sceneUrl = location.origin + world.entry.scene;
    const cacheKey = sceneUrl + '#' + anchorId;
    if (anchorLabelCache.has(cacheKey)) return anchorLabelCache.get(cacheKey);
    const promise = (async () => {
      try {
        const res = await fetch(sceneUrl, { cache: 'no-store' });
        if (!res.ok) return null;
        const scene = await res.json();
        const anchor = Array.isArray(scene.anchors) ? scene.anchors.find((a) => a.id === anchorId) : null;
        return anchor ? (anchor.label || anchor.id) : null;
      } catch (err) {
        return null;
      }
    })();
    anchorLabelCache.set(cacheKey, promise);
    return promise;
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

  function attachInfoTooltip(btn, manifest, world, anchorId) {
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

    // SPEC.md §3.7 — set at most once, by injectButton's async
    // checkDomainIdentityPin() call, well after this tooltip already
    // exists. null for the overwhelming common case (no pin, or nothing
    // anomalous to report).
    let identityWarning = null;

    function render({ participants, size, anchorLabel }) {
      const lines = [
        '<div style="font-weight:600;margin-bottom:4px;">' + escapeHtml(world.name) + '</div>',
        '<div>Genre: ' + escapeHtml(genre) + ' · Scale: ' + escapeHtml(scale) + '</div>',
        '<div>' + escapeHtml(capabilitySummary(manifest, world)) + '</div>',
        '<div>👥 Live now: ' + (participants === undefined ? '…' : (participants === null ? 'unavailable' : participants)) + '</div>',
        '<div>📦 Download size: ' + sizeText(size) + '</div>'
      ];
      // SPEC.md §3.5 — only shown once the lazy fetchAnchorLabel() lookup
      // above actually resolves to a real label; a dead/removed anchor id
      // (resolves to null) leaves this line out entirely rather than
      // showing a raw id or a placeholder that never fills in.
      if (anchorId && anchorLabel) {
        lines.push('<div style="margin-top:4px;color:#9fb8e0;">📍 Links to: ' + escapeHtml(anchorLabel) + '</div>');
      }
      if (worldCount > 1) {
        lines.push('<div style="margin-top:4px;color:#c9c2b8;">+' + (worldCount - 1) + ' more space' + (worldCount - 1 === 1 ? '' : 's') + ' at this domain</div>');
      }
      if (identityWarning) {
        lines.push(
          '<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.15);color:#ffb199;">' +
          '⚠ This domain\'s pinned identity key changed since your last visit, with no rotation record on file. ' +
          'It may be a routine key rotation the domain didn\'t document, or it may not be — nothing here blocks you, just worth knowing.' +
          '</div>'
        );
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

    let shown = { participants: undefined, size: undefined, anchorLabel: undefined };

    btn.addEventListener('mouseenter', () => {
      shown = { participants: undefined, size: undefined, anchorLabel: undefined };
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
      if (anchorId) {
        fetchAnchorLabel(world, anchorId).then((anchorLabel) => {
          shown = { ...shown, anchorLabel };
          if (panel.style.display === 'block') render(shown);
        });
      }
    });
    btn.addEventListener('mouseleave', () => {
      panel.style.display = 'none';
    });

    return {
      // Called (at most once) by injectButton once its async identity-pin
      // check resolves. Re-renders immediately if the panel happens to
      // already be open; otherwise the next mouseenter picks it up via the
      // closed-over identityWarning value.
      setIdentityWarning(warning) {
        identityWarning = warning;
        if (panel.style.display === 'block') render(shown);
      }
    };
  }

  // The overlay iframe visually covers the whole viewport (position: fixed;
  // inset: 0), but a native scrollbar is part of the browser's own window
  // chrome, not the page's stacking context — nothing inside the page can
  // draw over it. Left alone, the host page underneath stays scrollable by
  // mouse wheel for as long as the overlay is open, showing a scrollbar
  // that has nothing to do with the wallet or the world inside it. Locking
  // scroll on the host page's own root elements while the overlay is open
  // removes it; hostScrollLocked guards against a re-open (openOverlay can
  // run again while one is already showing) recapturing 'hidden' as if it
  // were the page's original value.
  let hostScrollLocked = false;
  let originalHtmlOverflow = '';
  let originalBodyOverflow = '';
  function lockHostPageScroll() {
    if (hostScrollLocked) return;
    originalHtmlOverflow = document.documentElement.style.overflow;
    originalBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    hostScrollLocked = true;
  }
  function unlockHostPageScroll() {
    if (!hostScrollLocked) return;
    document.documentElement.style.overflow = originalHtmlOverflow;
    document.body.style.overflow = originalBodyOverflow;
    hostScrollLocked = false;
  }

  // Standalone panel width — draggable, persisted across pages and tabs
  // via chrome.storage.local (this content script's own origin-independent
  // storage, same "storage" permission already declared for other wallet
  // state) since the width is a property of this host-page-owned overlay
  // iframe, not of anything inside the extension-origin viewer.html it
  // points at. Loaded once, best-effort, at content-script init below;
  // openOverlay() falls back to the default if that read hasn't resolved
  // yet by the time someone clicks the toolbar button right away.
  const STANDALONE_WIDTH_KEY = 'atlasStandalonePanelWidth';
  const STANDALONE_DEFAULT_WIDTH = 380;
  const STANDALONE_MIN_WIDTH = 280;
  const STANDALONE_MAX_WIDTH = 720;
  let standaloneWidth = STANDALONE_DEFAULT_WIDTH;
  function clampStandaloneWidth(width) {
    return Math.max(STANDALONE_MIN_WIDTH, Math.min(STANDALONE_MAX_WIDTH, width));
  }
  try {
    chrome.storage.local.get([STANDALONE_WIDTH_KEY], (result) => {
      const stored = result && result[STANDALONE_WIDTH_KEY];
      if (typeof stored === 'number' && isFinite(stored)) standaloneWidth = clampStandaloneWidth(stored);
    });
  } catch (err) {
    // storage unavailable (rare, privacy-locked-down browser) — stays at
    // the default width, same as before this feature existed.
  }

  // The drag handle lives OUTSIDE the overlay iframe, as this host page's
  // own sibling element right at the iframe's left edge — not inside
  // viewer.html. A drag that crossed the iframe's cross-origin boundary
  // mid-gesture would otherwise lose mouse events the moment the cursor
  // moved over the iframe's own browsing context, the same problem every
  // iframe-adjacent resizer has. A transparent full-viewport capture layer
  // during the drag (resizeCaptureEl) is what actually prevents that: it
  // sits on top of the iframe for the gesture's duration so every
  // mousemove/mouseup keeps landing on this document, not the iframe's.
  let resizeHandleEl = null;
  let resizeCaptureEl = null;
  let resizeDrag = null; // { startX, startWidth } while a drag is in progress, else null
  function createResizeHandle(iframe) {
    removeResizeHandle();
    resizeHandleEl = document.createElement('div');
    resizeHandleEl.id = 'domain-atlas-resize-handle';
    Object.assign(resizeHandleEl.style, {
      position: 'fixed',
      top: '0',
      bottom: '0',
      right: standaloneWidth + 'px',
      width: '6px',
      cursor: 'ew-resize',
      zIndex: 2147483647
    });
    resizeHandleEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizeDrag = { startX: e.clientX, startWidth: parseInt(iframe.style.width, 10) || standaloneWidth };
      resizeCaptureEl = document.createElement('div');
      Object.assign(resizeCaptureEl.style, { position: 'fixed', inset: '0', zIndex: 2147483647, cursor: 'ew-resize' });
      document.documentElement.appendChild(resizeCaptureEl);
    });
    document.documentElement.appendChild(resizeHandleEl);
  }
  function removeResizeHandle() {
    if (resizeHandleEl) { resizeHandleEl.remove(); resizeHandleEl = null; }
    if (resizeCaptureEl) { resizeCaptureEl.remove(); resizeCaptureEl = null; }
    resizeDrag = null;
  }
  // Dragging LEFT grows the panel (the right edge stays pinned to the
  // browser edge, so width only ever grows toward the left) — clientX
  // decreasing is a negative delta, so width = startWidth - delta.
  document.addEventListener('mousemove', (e) => {
    if (!resizeDrag) return;
    const width = clampStandaloneWidth(resizeDrag.startWidth - (e.clientX - resizeDrag.startX));
    const overlay = document.getElementById('domain-atlas-overlay');
    if (overlay) overlay.style.width = width + 'px';
    if (resizeHandleEl) resizeHandleEl.style.right = width + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!resizeDrag) return;
    resizeDrag = null;
    if (resizeCaptureEl) { resizeCaptureEl.remove(); resizeCaptureEl = null; }
    const overlay = document.getElementById('domain-atlas-overlay');
    standaloneWidth = clampStandaloneWidth(overlay ? parseInt(overlay.style.width, 10) : standaloneWidth);
    try { chrome.storage.local.set({ [STANDALONE_WIDTH_KEY]: standaloneWidth }); } catch (err) { /* same best-effort as the read above */ }
  });

  // startManifestUrl is optional — the toolbar-button listener further
  // down calls this with none at all, for a page that may not declare a
  // manifest (or any relationship to Domain Atlas) in the first place.
  // viewer.js's own startParams()/boot sequence already has a defined,
  // working path for "no manifest" (every wallet-panel display it shows
  // is populated before that check even runs) — this only ever needed
  // the overlay itself to stop requiring a URL to open.
  function openOverlay(startManifestUrl, worldId, anchorId) {
    const existing = document.getElementById('domain-atlas-overlay');
    if (existing) existing.remove();
    removeResizeHandle();

    const iframe = document.createElement('iframe');
    iframe.id = 'domain-atlas-overlay';
    let src = chrome.runtime.getURL('viewer.html');
    if (startManifestUrl) {
      src += '?manifest=' + encodeURIComponent(startManifestUrl);
      if (worldId) src += '&world=' + encodeURIComponent(worldId);
      // SPEC.md §3.5 — the specific named point this page's own <link
      // rel="spatial"> pointed at, if any; viewer.js's startParams()/
      // enterWorld() are what actually act on it (placing the visitor
      // there instead of the world's ordinary entry point).
      if (anchorId) src += '&anchor=' + encodeURIComponent(anchorId);
    }
    iframe.src = src;
    // The viewer is a cross-origin (extension) iframe, so WebAuthn is
    // blocked by default Permissions Policy unless explicitly delegated —
    // this is what actually lets the identity/wallet ceremonies run.
    // (There used to be a "fullscreen" delegation here too, for an
    // in-iframe Fullscreen button — removed in favor of a plain "F11 for
    // fullscreen" hint, see viewer.js, since requestFullscreen() from
    // inside a cross-origin iframe turned out to be an unreliable fight
    // not worth having when the browser's own shortcut already works.)
    iframe.allow = 'publickey-credentials-create; publickey-credentials-get';
    if (startManifestUrl) {
      // Entering an actual world needs the full viewport — there's a
      // real 3D scene about to render, and the host page underneath it
      // isn't meant to stay usable at the same time.
      Object.assign(iframe.style, {
        position: 'fixed',
        inset: '0',
        width: '100vw',
        height: '100vh',
        border: 'none',
        zIndex: 2147483647
      });
      document.documentElement.appendChild(iframe);
      lockHostPageScroll();
    } else {
      // Standalone (toolbar button, no manifest at all): there's no world
      // to render and no reason to cover the page the visitor was already
      // reading — a panel pinned to the browser's edge, full height, the
      // same spirit as a browser extension's own side-panel wallet (not a
      // floating popup), with the host page left fully visible and
      // scrollable underneath it. viewer.js's own "no manifest" branch is
      // what keeps the (otherwise always-visible) #scene canvas and other
      // in-world-only UI from showing through next to the wallet panel
      // inside this frame.
      Object.assign(iframe.style, {
        position: 'fixed',
        top: '0',
        right: '0',
        bottom: '0',
        width: standaloneWidth + 'px',
        height: '100vh',
        border: 'none',
        boxShadow: '-8px 0 30px rgba(0,0,0,0.45)',
        zIndex: 2147483647
      });
      document.documentElement.appendChild(iframe);
      createResizeHandle(iframe);
    }
  }

  // The viewer runs in an extension-origin iframe, cross-origin from the host
  // page, so it can't reach back into this page's DOM directly. It asks to be
  // closed via postMessage instead — and, since setting document.title
  // inside the iframe does nothing visible (an iframe doesn't own the
  // top-level browser tab title), it asks THIS page to set the tab title on
  // its behalf too, the same way.
  //
  // originalDocumentTitle remembers this host page's own title from before
  // the overlay ever touched it, captured lazily on the FIRST title message
  // of an overlay session (not at content-script load time — a "close" reset
  // it back to null already once, and this stays null again until the next
  // 'domain-atlas-title' message actually arrives) so it can be restored on
  // close, and reset to null on close so a later re-open captures a fresh
  // original rather than the stale one from a previous session.
  let originalDocumentTitle = null;
  window.addEventListener('message', (event) => {
    if (event.data === 'domain-atlas-close') {
      const overlay = document.getElementById('domain-atlas-overlay');
      if (overlay) overlay.remove();
      removeResizeHandle();
      unlockHostPageScroll();
      if (originalDocumentTitle !== null) {
        document.title = originalDocumentTitle;
        originalDocumentTitle = null;
      }
      return;
    }
    if (event.data && typeof event.data === 'object' && event.data.type === 'domain-atlas-title') {
      if (originalDocumentTitle === null) originalDocumentTitle = document.title;
      document.title = String(event.data.title);
      return;
    }
    // The other half of viewer.js's 🛡️ Admin button: that iframe is
    // cross-origin from this page (extension origin vs. the domain's own),
    // so it can't put anything into THIS origin's storage directly, and a
    // token in the URL would leak into browser history and any server
    // access log along the way. It hands the token off here instead, and
    // this page — same origin as the admin panel it's about to open — puts
    // it in sessionStorage and navigates there.
    //
    // event.source is checked against the overlay iframe specifically
    // (unlike 'domain-atlas-close'/'domain-atlas-title' above, which are
    // harmless no matter who sends them) because this message carries a
    // live bearer credential: only the wallet this page itself opened
    // should ever be able to plant one.
    if (event.data && typeof event.data === 'object' && event.data.type === 'domain-atlas-admin-handoff') {
      const overlay = document.getElementById('domain-atlas-overlay');
      if (!overlay || event.source !== overlay.contentWindow) return;
      const { domain, token, expiresAt } = event.data;
      if (typeof domain !== 'string' || typeof token !== 'string' || location.host !== domain) return;
      try {
        sessionStorage.setItem('atlasAdminSession', JSON.stringify({ token, expiresAt }));
      } catch (err) {
        // sessionStorage unavailable (a locked-down privacy mode, say) —
        // the admin panel will just show its logged-out state instead of
        // silently pretending this worked.
      }
      // The explicit filename, not the bare directory — a real site often
      // has its own catch-all rewrite in front of this one (a CMS's own
      // "anything not a real file goes to my own router" rule, say), which
      // can 404 a bare /atlas-admin/ request before Apache's own
      // directory-index resolution ever gets a turn, even though the exact
      // same rewrite correctly leaves an actual file alone. Naming the file
      // sidesteps that ambiguity entirely, on any host.
      location.href = '/atlas-admin/index.html';
    }
  });

  // background.js's toolbar-button handler — opens the wallet with no
  // manifest at all, on any page, regardless of whether this content
  // script found one above. Never overwrites an overlay that's already
  // showing: if one's already open (a real manifest entry, or an
  // earlier toolbar click), openOverlay() would otherwise tear it down
  // and rebuild it with nothing, discarding whatever world the visitor
  // was already in.
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'domain-atlas-open-wallet' && !document.getElementById('domain-atlas-overlay')) {
      openOverlay();
    }
  });
})();
