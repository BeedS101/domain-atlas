// Domain Atlas — viewer (v1.0)
// Fetches a manifest, resolves a world within it, and renders that world's
// scene isometrically on a plain <canvas> — no external rendering library.
// A "world" portal swaps to another entry in the SAME cached manifest with
// no re-fetch (proving the spec's "no network round-trip" claim for
// same-origin portals); a "domain" portal fetches a different origin's
// manifest entirely. (A production client would prefer WebXR + glTF per
// the spec; this renderer exists so the prototype has zero dependencies.)

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const scene3dCanvas = document.getElementById('scene3d');
const scene3dHint = document.getElementById('scene3dHint');
const hintEl = document.getElementById('hint');
const placeLabel = document.getElementById('placeLabel');
const statusEl = document.getElementById('status');
const closeBtn = document.getElementById('closeBtn');

// ---------- stale extension context ----------
// Reloading the unpacked extension (chrome://extensions -> Reload, or an
// auto-update) invalidates every chrome.* binding any ALREADY-OPEN page
// still holds — this overlay iframe included. Nothing short of reloading
// this page can restore it, so every chrome.storage/chrome.runtime call
// wallet.js makes from that point on throws the same
// "Extension context invalidated" error. Without this handler that surfaces
// as an opaque uncaught-promise-rejection in the console (e.g. from the
// unawaited refreshIdentityDisplay() call at the bottom of this file,
// which runs on load and touches chrome.storage right away); with it, the
// user gets a plain-language, actionable status message instead.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = (reason && reason.message) || (typeof reason === 'string' ? reason : '');
  if (!message.includes('Extension context invalidated')) return;
  event.preventDefault();
  if (statusEl) statusEl.textContent = 'This page lost its connection to the extension (it was reloaded) — refresh the page to reconnect.';
  console.warn('[Domain Atlas] Extension context invalidated — refresh this page to reconnect.');
});

// Which world is "in front" right now can use either renderer: the
// original flat-canvas isometric one (below), or gltf-mini.js's small
// hand-rolled WebGL renderer for worlds that declare "gltf-mini-v1". Only
// one is ever active — entering a world tears down whichever was running
// for the previous one. See enterWorld().
let active3D = null;

const walletBtn = document.getElementById('walletBtn');
const walletBadge = document.getElementById('walletBadge');
const walletPanel = document.getElementById('walletPanel');

// The wallet panel is one of several mutually-exclusive "screens" — see
// showWalletScreen() / routeWalletScreen() below.
const walletScreens = document.querySelectorAll('.wallet-screen');

const onboardingChoiceScreen = document.getElementById('onboardingChoiceScreen');
const chooseNewBtn = document.getElementById('chooseNewBtn');
const chooseImportBtn = document.getElementById('chooseImportBtn');
const chooseWebAuthnBtn = document.getElementById('chooseWebAuthnBtn');

const createScreen = document.getElementById('createScreen');
const newPasswordInput = document.getElementById('newPasswordInput');
const newPasswordConfirmInput = document.getElementById('newPasswordConfirmInput');
const createScreenStatus = document.getElementById('createScreenStatus');
const confirmCreateBtn = document.getElementById('confirmCreateBtn');
const createScreenImportInsteadBtn = document.getElementById('createScreenImportInsteadBtn');
const backFromCreateBtn = document.getElementById('backFromCreateBtn');

const webauthnCreateScreen = document.getElementById('webauthnCreateScreen');
const webauthnCreateScreenStatus = document.getElementById('webauthnCreateScreenStatus');
const confirmWebAuthnCreateBtn = document.getElementById('confirmWebAuthnCreateBtn');
const backFromWebAuthnCreateBtn = document.getElementById('backFromWebAuthnCreateBtn');

const seedRevealBox = document.getElementById('seedRevealBox');
const seedPhraseTextEl = document.getElementById('seedPhraseText');
const seedConfirmCheck = document.getElementById('seedConfirmCheck');
const seedConfirmBtn = document.getElementById('seedConfirmBtn');

const importScreen = document.getElementById('importScreen');
const onboardImportFileInput = document.getElementById('onboardImportFileInput');
const onboardImportPasswordInput = document.getElementById('onboardImportPasswordInput');
const onboardImportSeedInput = document.getElementById('onboardImportSeedInput');
const importScreenStatus = document.getElementById('importScreenStatus');
const confirmImportBtn = document.getElementById('confirmImportBtn');
const backFromImportBtn = document.getElementById('backFromImportBtn');

const unlockScreen = document.getElementById('unlockScreen');
const unlockPasswordInput = document.getElementById('unlockPasswordInput');
const unlockScreenStatus = document.getElementById('unlockScreenStatus');
const unlockBtn = document.getElementById('unlockBtn');

const identityModeLabelEl = document.getElementById('identityModeLabel');
const switchIdentityModeBtn = document.getElementById('switchIdentityModeBtn');
const lockWalletBtn = document.getElementById('lockWalletBtn');
const changePasswordSection = document.getElementById('changePasswordSection');
const changePasswordCurrentInput = document.getElementById('changePasswordCurrentInput');
const changePasswordNewInput = document.getElementById('changePasswordNewInput');
const changePasswordConfirmInput = document.getElementById('changePasswordConfirmInput');
const changePasswordBtn = document.getElementById('changePasswordBtn');
const changePasswordStatusEl = document.getElementById('changePasswordStatus');
const backupLocalSection = document.getElementById('backupLocalSection');
const backupWebAuthnNote = document.getElementById('backupWebAuthnNote');
const exportPasswordInput = document.getElementById('exportPasswordInput');
const exportSeedInput = document.getElementById('exportSeedInput');
const exportIdentityBtn = document.getElementById('exportIdentityBtn');
const exportStatusEl = document.getElementById('exportStatus');
const exportBtn = document.getElementById('exportBtn');
const importWalletBtn = document.getElementById('importWalletBtn');
const importWalletFileInput = document.getElementById('importWalletFileInput');
const importWalletStatusEl = document.getElementById('importWalletStatus');
const hiddenItemsListEl = document.getElementById('hiddenItemsList');
const recentWorldsListEl = document.getElementById('recentWorldsList');
const backFromSettingsBtn = document.getElementById('backFromSettingsBtn');

const mainWalletScreen = document.getElementById('mainWalletScreen');
const walletIdentityEl = document.getElementById('walletIdentity');
const aliasInput = document.getElementById('aliasInput');
const setAliasBtn = document.getElementById('setAliasBtn');
const aliasStatusEl = document.getElementById('aliasStatus');
const openSettingsBtn = document.getElementById('openSettingsBtn');
const counterpartyIdentityEl = document.getElementById('counterpartyIdentity');
const createCounterpartyBtn = document.getElementById('createCounterpartyBtn');

const requestItemBtn = document.getElementById('requestItemBtn');
const presentBtn = document.getElementById('presentBtn');
const reverifyBtn = document.getElementById('reverifyBtn');
const loadoutNoteEl = document.getElementById('loadoutNote');
const itemsSearchInput = document.getElementById('itemsSearchInput');
const selfItemsListEl = document.getElementById('selfItemsList');
const droppedItemsSectionEl = document.getElementById('droppedItemsSection');
const droppedItemsListEl = document.getElementById('droppedItemsList');
const counterpartyItemsSearchInput = document.getElementById('counterpartyItemsSearchInput');
const counterpartyItemsListEl = document.getElementById('counterpartyItemsList');
const mintIronBtn = document.getElementById('mintIronBtn');
const mintGoldBtn = document.getElementById('mintGoldBtn');
const resourcesSearchInput = document.getElementById('resourcesSearchInput');
const selfResourceListEl = document.getElementById('selfResourceList');
const counterpartyResourceListEl = document.getElementById('counterpartyResourceList');
const tradeNoteEl = document.getElementById('tradeNote');
const tradeBtn = document.getElementById('tradeBtn');
const tradeStatusEl = document.getElementById('tradeStatus');

let portalHitboxes = []; // [{sx, sy, radius, portal}]
let itemMarkerHitboxes = []; // [{sx, sy, radius, marker}] — dropped items, 2D renderer only for now
let interactableHitboxes = []; // [{sx, sy, radius, marker}] — scene.json-declared clickable stalls (mining, etc.), 2D renderer only
let interactableBusy = false; // guards against a rapid double-click firing two mints at once
let pendingDropCredentialId = null; // set while waiting for the next canvas click to choose a drop spot
let currentManifest = null;   // cached manifest object
let currentManifestUrl = null;
let currentOrigin = null;
let currentWorld = null;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight - 56;
}
resize();
window.addEventListener('resize', resize);

closeBtn.addEventListener('click', () => window.parent.postMessage('domain-atlas-close', '*'));

function startParams() {
  const params = new URLSearchParams(window.location.search);
  return { manifest: params.get('manifest'), world: params.get('world') };
}

async function loadManifest(manifestUrl, worldId) {
  statusEl.textContent = 'Fetching manifest…';
  const res = await fetch(manifestUrl, { cache: 'no-store' });
  const manifest = await res.json();
  currentManifest = manifest;
  currentManifestUrl = manifestUrl;
  currentOrigin = new URL(manifestUrl).origin;
  await enterWorld(worldId || manifest.defaultWorld);
}

function show3DCanvas(active) {
  canvas.style.display = active ? 'none' : '';
  hintEl.style.display = active ? 'none' : '';
  scene3dCanvas.classList.toggle('active', active);
  scene3dHint.classList.toggle('active', active);
}

async function enterWorld(worldId) {
  portalHitboxes = [];
  const manifest = currentManifest;
  const world = manifest.worlds.find((w) => w.id === worldId) || manifest.worlds[0];
  currentWorld = world;
  refreshRequestButton();
  refreshWorldGates();

  placeLabel.innerHTML = world.name + ' <span class="domain">' + manifest.domain + ' · ' + world.id + '</span>';
  document.title = 'Domain Atlas — ' + world.name;
  await AtlasWallet.recordWorldVisit({
    domain: manifest.domain,
    world: world.id,
    worldName: world.name,
    manifestUrl: currentManifestUrl
  });

  // Leaving whichever world was active before — if it was a 3D one, its
  // render loop and input listeners need tearing down before anything else
  // starts, same idea as window.__atlasScene just getting overwritten below
  // for the 2D path.
  if (active3D) { active3D.destroy(); active3D = null; }

  // A pending "click where you want to drop it" from whichever world was
  // active before doesn't carry over to a new one.
  pendingDropCredentialId = null;
  canvas.style.cursor = '';

  const is3D = !!(world.entry.renderer && world.entry.renderer.includes('gltf-mini-v1'));
  show3DCanvas(is3D);

  if (is3D) {
    try {
      statusEl.textContent = 'Fetching scene…';
      const sceneUrl = currentOrigin + world.entry.scene;
      const sceneRes = await fetch(sceneUrl, { cache: 'no-store' });
      const sceneData = await sceneRes.json();
      // itemMarkers isn't populated for the 3D renderer yet (see the
      // "Dropping items" note in wallet.js) — kept in the shape for
      // consistency, just always empty here for now. Dropping still fully
      // works in a gltf-mini world; there's just no in-scene marker to
      // walk up to, only the "Dropped in this world" list's Pick up button.
      window.__atlasScene = { floor: sceneData.floor || { size: [10, 10], color: '#1b2830' }, objects: [], portalMarkers: [], itemMarkers: [], interactables: [] };

      active3D = MiniGLTF.init(scene3dCanvas, {
        sceneData,
        resolveAssetUrl: (path) => currentOrigin + path,
        isCrossDomainPortal: (portalIndex) => !!(world.portals[portalIndex] && world.portals[portalIndex].kind === 'domain'),
        onPortalEnter: (portalIndex) => followPortal(world.portals[portalIndex])
      });
      await active3D.ready;
      statusEl.textContent = 'In sync with ' + manifest.domain + ' · ' + world.id;
      history.replaceState(null, '', '?manifest=' + encodeURIComponent(currentManifestUrl) + '&world=' + encodeURIComponent(world.id));
    } catch (err) {
      statusEl.textContent = 'Could not load world: ' + err.message;
    }
    return;
  }

  try {
    statusEl.textContent = 'Fetching scene…';
    const sceneUrl = currentOrigin + world.entry.scene;
    const sceneRes = await fetch(sceneUrl, { cache: 'no-store' });
    const scene = await sceneRes.json();

    window.__atlasScene = {
      floor: scene.floor || { size: [10, 10], color: '#1b2830' },
      objects: scene.objects || [],
      portalMarkers: (scene.portalMarkers || []).map((m) => ({
        position: m.position,
        portal: world.portals[m.portalIndex]
      })),
      itemMarkers: [],
      // Scene-declared clickable stalls (e.g. the Trading Post's iron/gold
      // stands) — self-contained config, unlike portalMarkers there's no
      // manifest cross-reference needed since every field a mint needs
      // (class, quantity, which identity mines it) lives right in
      // scene.json. See handleInteractable() for what "action" values do.
      interactables: scene.interactables || []
    };
    await refreshSceneItemMarkers();

    statusEl.textContent = 'In sync with ' + manifest.domain + ' · ' + world.id;
    history.replaceState(null, '', '?manifest=' + encodeURIComponent(currentManifestUrl) + '&world=' + encodeURIComponent(world.id));
  } catch (err) {
    statusEl.textContent = 'Could not load world: ' + err.message;
    window.__atlasScene = { floor: { size: [10, 10], color: '#2a1a1a' }, objects: [], portalMarkers: [], itemMarkers: [], interactables: [] };
  }
}

async function followPortal(portal) {
  if (!portal) return;
  if (portal.kind === 'world') {
    // Same-origin scene swap: reuse the already-cached manifest, no re-fetch.
    await enterWorld(portal.to);
  } else if (portal.kind === 'domain') {
    // Crossing a real trust boundary: fetch the other domain's own manifest.
    await loadManifest(portal.manifest);
  }
}

// --- isometric rendering (unchanged mechanics, world-agnostic) ---

const SCALE = 26;
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

function project(x, y, z, originX, originY) {
  return {
    x: originX + (x - z) * COS30 * SCALE,
    y: originY + (x + z) * SIN30 * SCALE - y * SCALE
  };
}

function drawFloor(floor, originX, originY) {
  const [w, d] = floor.size;
  const hw = w / 2, hd = d / 2;
  const corners = [
    project(-hw, 0, -hd, originX, originY),
    project(hw, 0, -hd, originX, originY),
    project(hw, 0, hd, originX, originY),
    project(-hw, 0, hd, originX, originY)
  ];
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  corners.slice(1).forEach((c) => ctx.lineTo(c.x, c.y));
  ctx.closePath();
  ctx.fillStyle = floor.color || '#1b2830';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.stroke();
}

function drawBox(obj, originX, originY) {
  const [x, y, z] = obj.position;
  const [sx, sy, sz] = obj.size;
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const cy = y;
  const top = [
    project(x - hx, cy + hy, z - hz, originX, originY),
    project(x + hx, cy + hy, z - hz, originX, originY),
    project(x + hx, cy + hy, z + hz, originX, originY),
    project(x - hx, cy + hy, z + hz, originX, originY)
  ];
  const frontLeft = [
    project(x - hx, cy - hy, z + hz, originX, originY),
    project(x - hx, cy + hy, z + hz, originX, originY),
    top[3],
    project(x - hx, cy - hy, z - hz, originX, originY)
  ];
  const frontRight = [
    project(x + hx, cy - hy, z + hz, originX, originY),
    project(x + hx, cy + hy, z + hz, originX, originY),
    top[2],
    project(x + hx, cy - hy, z - hz, originX, originY)
  ];

  const base = obj.color || '#c05a1f';
  drawFace(top, shade(base, 1.15));
  drawFace(frontLeft, shade(base, 0.85));
  drawFace(frontRight, shade(base, 0.65));

  if (obj.label) {
    const labelPt = project(x, cy + hy + 0.4, z, originX, originY);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#e7edef';
    ctx.textAlign = 'center';
    ctx.fillText(obj.label, labelPt.x, labelPt.y);
  }
}

function drawFace(points, color) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function shade(hex, factor) {
  const n = parseInt(hex.replace('#', ''), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.min(255, Math.round(r * factor));
  g = Math.min(255, Math.round(g * factor));
  b = Math.min(255, Math.round(b * factor));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function drawPortal(marker, originX, originY, pulse) {
  const [x, y, z] = marker.position;
  const base = project(x, 0, z, originX, originY);
  const top = project(x, 2.2, z, originX, originY);
  const radius = 16 + Math.sin(pulse) * 3;
  const isCrossDomain = marker.portal && marker.portal.kind === 'domain';

  const grad = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
  if (isCrossDomain) {
    grad.addColorStop(0, 'rgba(87,165,147,0.15)');
    grad.addColorStop(1, 'rgba(87,165,147,0.9)');
  } else {
    grad.addColorStop(0, 'rgba(192,90,31,0.15)');
    grad.addColorStop(1, 'rgba(224,138,76,0.85)');
  }

  ctx.beginPath();
  ctx.ellipse((base.x + top.x) / 2, (base.y + top.y) / 2, radius * 0.55, radius, 0, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.shadowColor = isCrossDomain ? '#57a593' : '#e08a4c';
  ctx.shadowBlur = 18 + Math.sin(pulse) * 6;
  ctx.fill();
  ctx.shadowBlur = 0;

  if (marker.portal) {
    const tag = isCrossDomain ? '⇢ domain' : '↻ world';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = isCrossDomain ? '#57a593' : '#e08a4c';
    ctx.textAlign = 'center';
    ctx.fillText(marker.portal.label || tag, (base.x + top.x) / 2, base.y + 18);
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(tag, (base.x + top.x) / 2, base.y + 32);
  }

  return { sx: (base.x + top.x) / 2, sy: (base.y + top.y) / 2, radius: radius + 20, marker };
}

// A dropped item's marker — visually distinct from a portal (a small
// bobbing amber glow at ground level with the item's name above it,
// rather than a tall glowing doorway), since it's a very different kind
// of thing to click: "pick this up," not "go somewhere."
function drawItemMarker(marker, originX, originY, pulse) {
  const [x, , z] = marker.position;
  const bob = Math.sin(pulse * 1.6) * 3;
  const base = project(x, 0, z, originX, originY);
  const cy = base.y - 14 - bob;
  const radius = 9;

  const grad = ctx.createRadialGradient(base.x, cy, 1, base.x, cy, radius);
  grad.addColorStop(0, 'rgba(224,184,76,0.95)');
  grad.addColorStop(1, 'rgba(224,184,76,0.2)');
  ctx.beginPath();
  ctx.arc(base.x, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.shadowColor = '#e0b84c';
  ctx.shadowBlur = 14;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#e0b84c';
  ctx.textAlign = 'center';
  ctx.fillText(marker.name, base.x, cy - radius - 8);
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = '#a9b8bf';
  ctx.fillText('click to pick up', base.x, base.y + 14);

  return { sx: base.x, sy: cy, radius: radius + 12, marker };
}

// A scene-declared clickable stall (see the "interactables" note in
// enterWorld) — visually its own thing again: a small steady teal glow
// (portals are the amber/teal doorway pillars, dropped items are the amber
// ground glow; teal-at-ground-level reads as "a fixture you interact with
// in place," not "go somewhere" or "carry this").
function drawInteractable(marker, originX, originY, pulse) {
  const [x, y, z] = marker.position;
  const base = project(x, y || 0, z, originX, originY);
  const cy = base.y - 16;
  const radius = 10 + Math.sin(pulse * 1.2) * 1.5;

  const grad = ctx.createRadialGradient(base.x, cy, 1, base.x, cy, radius);
  grad.addColorStop(0, 'rgba(87,165,147,0.9)');
  grad.addColorStop(1, 'rgba(87,165,147,0.15)');
  ctx.beginPath();
  ctx.arc(base.x, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.shadowColor = '#57a593';
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#57a593';
  ctx.textAlign = 'center';
  ctx.fillText(marker.label || 'Collect', base.x, cy - radius - 8);
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = '#a9b8bf';
  ctx.fillText('click to collect', base.x, base.y + 22);

  return { sx: base.x, sy: cy, radius: radius + 14, marker };
}

// The inverse of project() at ground level (y=0) — turns a canvas click
// back into the world (x, z) under the cursor, so "drop it here" in the 2D
// renderer can mean an actual chosen spot rather than one fixed location.
// Solving project()'s two equations for x and z:
//   sx - originX = (x - z) * COS30 * SCALE  =>  A = x - z
//   sy - originY = (x + z) * SIN30 * SCALE  =>  B = x + z
//   x = (A + B) / 2, z = (B - A) / 2
function unprojectGround(sx, sy, originX, originY) {
  const a = (sx - originX) / (COS30 * SCALE);
  const b = (sy - originY) / (SIN30 * SCALE);
  return { x: (a + b) / 2, z: (b - a) / 2 };
}

function render(t) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const originX = canvas.width / 2;
  const originY = canvas.height / 2 + 40;
  const scene = window.__atlasScene;
  portalHitboxes = [];
  itemMarkerHitboxes = [];
  interactableHitboxes = [];

  if (scene) {
    drawFloor(scene.floor, originX, originY);

    const drawables = [
      ...scene.objects.map((o) => ({ kind: 'box', obj: o, depth: o.position[0] + o.position[2] })),
      ...scene.portalMarkers.map((m) => ({ kind: 'portal', obj: m, depth: m.position[0] + m.position[2] })),
      ...(scene.itemMarkers || []).map((m) => ({ kind: 'item', obj: m, depth: m.position[0] + m.position[2] })),
      ...(scene.interactables || []).map((m) => ({ kind: 'interactable', obj: m, depth: m.position[0] + m.position[2] }))
    ].sort((a, b) => a.depth - b.depth);

    const pulse = t / 260;
    drawables.forEach((d) => {
      if (d.kind === 'box') {
        drawBox(d.obj, originX, originY);
      } else if (d.kind === 'portal') {
        const hitbox = drawPortal(d.obj, originX, originY, pulse);
        portalHitboxes.push(hitbox);
      } else if (d.kind === 'item') {
        const hitbox = drawItemMarker(d.obj, originX, originY, pulse);
        itemMarkerHitboxes.push(hitbox);
      } else {
        const hitbox = drawInteractable(d.obj, originX, originY, pulse);
        interactableHitboxes.push(hitbox);
      }
    });
  }

  requestAnimationFrame(render);
}

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  // A drop-in-progress claims this click regardless of what's underneath
  // it — the whole point of "click where you want to drop it" is that the
  // next click IS the answer, not a normal scene interaction.
  if (pendingDropCredentialId) {
    const originX = canvas.width / 2;
    const originY = canvas.height / 2 + 40;
    const { x, z } = unprojectGround(cx, cy, originX, originY);
    const id = pendingDropCredentialId;
    pendingDropCredentialId = null;
    canvas.style.cursor = '';
    finalizeDrop(id, [x, 0, z]);
    return;
  }

  for (const hb of itemMarkerHitboxes) {
    const dist = Math.hypot(cx - hb.sx, cy - hb.sy);
    if (dist < hb.radius) {
      pickUpDroppedItem(hb.marker.credentialId);
      return;
    }
  }

  for (const hb of interactableHitboxes) {
    const dist = Math.hypot(cx - hb.sx, cy - hb.sy);
    if (dist < hb.radius) {
      handleInteractable(hb.marker);
      return;
    }
  }

  for (const hb of portalHitboxes) {
    const dist = Math.hypot(cx - hb.sx, cy - hb.sy);
    if (dist < hb.radius && hb.marker.portal) {
      followPortal(hb.marker.portal);
      return;
    }
  }
});

// Escape backs out of "click where you want to drop it" without dropping
// anywhere — otherwise the very next canvas click, whenever it happens
// (possibly long after the person closed the wallet panel and forgot),
// would silently place the item instead of doing whatever they actually
// clicked for.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pendingDropCredentialId) {
    pendingDropCredentialId = null;
    canvas.style.cursor = '';
    statusEl.textContent = 'Drop cancelled.';
  }
});

// --- identity + wallet (real WebAuthn + real ECDSA verification, not mocked) ---

function short(b64url, n) {
  return b64url ? b64url.slice(0, n) + '…' : '';
}

function manifestDomainOf(manifest) {
  return manifest.domain;
}

function combatOf(world) {
  return (world && world.profile && world.profile.capabilities && world.profile.capabilities.combat) || 'none';
}

function refreshRequestButton() {
  const world = currentWorld;
  const classes = world && world.policy && world.policy.itemDropsAllowed ? (world.policy.acceptedItemClasses || []) : [];
  requestItemBtn.disabled = classes.length === 0;
  requestItemBtn.textContent = classes.length
    ? 'Request ' + classes[0] + ' from ' + world.name
    : 'This world issues nothing';
}

function refreshWorldGates() {
  const world = currentWorld;
  const risky = combatOf(world) !== 'none';
  loadoutNoteEl.textContent = risky
    ? '⚠ This world is flagged "' + combatOf(world) + '" — items you load here can be lost under its rules. Anything left in your wallet stays safe.'
    : '';

  const isStation = world && world.profile && world.profile.genre === 'trading-station';
  tradeBtn.disabled = !isStation;
  tradeNoteEl.style.display = isStation ? 'none' : '';

  refreshItemsDisplay();
}

async function refreshIdentityDisplay() {
  const identity = await AtlasWallet.getIdentity();
  const alias = identity ? await AtlasWallet.getAlias(identity.publicKey) : null;
  walletIdentityEl.textContent = identity
    ? (alias ? alias + ' · ' : 'Identity: ') + short(identity.publicKey, 28)
    : 'Locked.';
  // Reflects whichever identity is active right now — switching identity
  // mode or unlocking a different one re-runs this and repopulates the
  // field with THAT key's own alias (or blank, if it has none yet).
  aliasInput.value = alias || '';
  aliasStatusEl.textContent = '';
  const counterparty = await AtlasWallet.getCounterparty();
  counterpartyIdentityEl.textContent = counterparty
    ? 'Counterparty: ' + short(counterparty.publicKey, 28)
    : 'No counterparty yet — a second local keypair standing in for another visitor (see README).';

  await refreshIdentityModeControls();
}

// The active "self" mechanism can be either the local password identity or
// a WebAuthn passkey identity — see wallet.js's atlasIdentityMode. This
// keeps the mode label, the switch/set-up button, the Lock button (which
// only means anything for the local password identity), and the Backup
// section (which only applies to the local identity — passkeys can't be
// exported) all in sync with whichever is currently active.
async function refreshIdentityModeControls() {
  const mode = await AtlasWallet.getIdentityMode();
  const hasLocal = await AtlasWallet.hasLocalIdentity();
  const hasWebAuthn = await AtlasWallet.hasWebAuthnIdentity();

  identityModeLabelEl.textContent = mode === 'webauthn'
    ? 'Using: passkey identity'
    : mode === 'local'
      ? 'Using: password identity'
      : '';

  if (mode === 'webauthn') {
    switchIdentityModeBtn.textContent = hasLocal ? 'Switch to password identity' : 'Set up a password identity';
  } else {
    switchIdentityModeBtn.textContent = hasWebAuthn ? 'Switch to passkey identity' : 'Set up a passkey identity';
  }

  lockWalletBtn.style.display = mode === 'webauthn' ? 'none' : '';
  changePasswordSection.style.display = mode === 'webauthn' ? 'none' : '';
  backupLocalSection.style.display = mode === 'webauthn' ? 'none' : '';
  backupWebAuthnNote.style.display = mode === 'webauthn' ? '' : 'none';
}

// ---------- wallet panel screen routing ----------
// Which "screen" shows depends on two things: whether an identity has ever
// been set up on this device (hasIdentity), and whether it's been unlocked
// this browser session (isUnlocked). Exactly one of these ever shows.

function showWalletScreen(id) {
  walletScreens.forEach((el) => el.classList.toggle('active', el.id === id));
  seedRevealBox.classList.remove('show');
}

async function routeWalletScreen() {
  if (await AtlasWallet.isUnlocked()) {
    showWalletScreen('mainWalletScreen');
    await refreshIdentityDisplay();
    await refreshItemsDisplay();
    await refreshResourcesDisplay();
  } else if (await AtlasWallet.hasIdentity()) {
    showWalletScreen('unlockScreen');
  } else {
    showWalletScreen('onboardingChoiceScreen');
  }
}

// "Back" from create/import/webauthn-create screens: those screens are
// reachable either from onboarding (no identity yet) or from the main
// wallet's "set up the other identity mechanism" button (an identity
// already exists, just not this kind) — go home to whichever is right.
async function backToWalletHome() {
  if (await AtlasWallet.hasIdentity()) {
    showWalletScreen('mainWalletScreen');
    await refreshIdentityDisplay();
    await refreshItemsDisplay();
    await refreshResourcesDisplay();
  } else {
    showWalletScreen('onboardingChoiceScreen');
  }
}

// Search/filter: every .wallet-item and .resource-group-header carries a
// lowercased dataset.search (and resource rows a dataset.group linking a
// card back to its group header) so applyListFilter can match on name/
// class/issuer text without re-parsing rendered HTML. See applyListFilter
// below for how these are consumed.
// Open, per-item properties bag (SPEC.md §5.1) — an issuer can attach any
// key it likes at mint time (atlas.rarity, com.example.era, ...); this
// client doesn't need to know any specific key in advance, it just lists
// whatever came back on the credential. `null`/`undefined`/`{}` all mean
// "nothing to show," same as an item minted before this feature existed.
// A property's VALUE (SPEC.md §5.1/§5.4) is deliberately open — the spec
// only constrains the KEY namespacing, not the shape of what's behind it,
// so an issuer is just as free to sign a single static value
// ("atlas.rarity": "rare") as an array of them
// ("com.example.enchantments": ["fire resistance", "silent step"]). Plain
// string-concatenation (`key + ': ' + value`) renders an array as
// "fire resistance,silent step" — technically readable but not a good
// example of "this can be a list," and would render a nested object as the
// useless "[object Object]" — so give each shape its own formatting rather
// than leaning on JS's default stringification.
function formatPropertyValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatItemProperties(properties) {
  if (!properties || typeof properties !== 'object') return '';
  const entries = Object.entries(properties);
  if (entries.length === 0) return '';
  return entries.map(([key, value]) => key + ': ' + formatPropertyValue(value)).join(' · ');
}

// Renders the small "Properties (N) ▸" link + its hidden detail panel for
// a card's open properties bag (SPEC.md §5.1/§5.4) — same idea as the
// settings-category accordion's chevron, just per-card and much smaller
// in scope. Returns '' when there's nothing to show, so a card with no
// properties gets no link at all, same as before this feature existed.
// The toggle itself is a plain show/hide on the very next sibling element
// (see the "toggle-properties" branch in itemActionHandler and
// resourceActionHandler below) — no wallet call, no list refresh, so
// opening it doesn't disturb anything else on the card, and it resets
// closed the next time the list re-renders, same as every other
// per-card DOM detail in this file.
function renderPropertiesToggle(properties) {
  if (!properties || typeof properties !== 'object') return '';
  const entries = Object.entries(properties);
  if (entries.length === 0) return '';
  const detailHtml = entries.map(([key, value]) => '<div>' + key + ': ' + formatPropertyValue(value) + '</div>').join('');
  return (
    '<button type="button" class="properties-link" data-action="toggle-properties">' +
    'Properties (' + entries.length + ')<span class="chevron">▸</span></button>' +
    '<div class="properties-detail" hidden>' + detailHtml + '</div>'
  );
}

function renderItemCard(entry, container, opts) {
  const el = document.createElement('div');
  el.className = 'wallet-item';
  const propsText = formatItemProperties(entry.credential.asset.properties);
  el.dataset.search = (
    entry.credential.asset.name + ' ' + entry.credential.asset.class + ' ' + entry.credential.issuer.domain + ' ' + propsText
  ).toLowerCase();
  const v = entry.lastVerdict || { valid: false, reason: 'not yet verified' };
  let html =
    '<div class="name">' + entry.credential.asset.name + '</div>' +
    '<div class="meta">' + entry.credential.asset.class + ' · issued by ' + entry.credential.issuer.domain + '</div>' +
    renderPropertiesToggle(entry.credential.asset.properties) +
    '<div class="verdict ' + (v.valid ? 'valid' : 'invalid') + '">' + (v.valid ? '✓ ' : '✗ ') + v.reason + '</div>';

  // Asset-management actions: load/unload and PvP loss only make sense for
  // self's own items in a risky world, but every item — self or
  // counterparty's — can be removed from this wallet's local view.
  html += '<div class="item-actions">';
  if (opts.loadable) {
    const loaded = opts.loadout.includes(entry.credential.id);
    html += '<button data-action="toggle-load" data-id="' + entry.credential.id + '">' + (loaded ? 'Unload' : 'Load into this world') + '</button>';
    if (loaded && opts.risky) {
      html += '<button data-action="lose" data-id="' + entry.credential.id + '">Simulate PvP loss</button>';
    }
  }
  if (opts.droppable) {
    html += '<button data-action="drop" data-id="' + entry.credential.id + '" class="btn-secondary">Drop here</button>';
  }
  html += '<button data-action="hide" data-id="' + entry.credential.id + '" class="btn-secondary">Hide</button>';
  html += '</div>';
  el.innerHTML = html;
  container.appendChild(el);
}

// The "Dropped in this world" management row — same info-card shape as
// Hidden items / Recent worlds, and the same reasoning: a click on the
// item's marker in the scene itself is the primary way to pick it back
// up, but this list is the always-works fallback that doesn't depend on
// finding the marker, being in exactly the right spot, or (for the 2D
// renderer) clicking precisely on a small icon.
function renderDroppedItemCard(entry, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  el.innerHTML =
    '<div class="name">' + entry.credential.asset.name + '</div>' +
    '<div class="meta">' + entry.credential.asset.class + ' · left in the scene</div>' +
    '<div class="item-actions">' +
    '<button data-action="pick-up" data-id="' + entry.credential.id + '">Pick up</button>' +
    '</div>';
  container.appendChild(el);
}

async function refreshItemsDisplay() {
  const identity = await AtlasWallet.getIdentity();
  const counterparty = await AtlasWallet.getCounterparty();
  const loadout = await AtlasWallet.getLoadout();
  const risky = combatOf(currentWorld) !== 'none';
  // refreshItemsDisplay() runs once, unawaited, at the bottom of this file
  // as soon as the script parses — well before enterWorld() has resolved
  // the manifest fetch and set currentManifest/currentWorld. An identity
  // can already exist at that point (a returning user), so this needs its
  // own guard rather than relying on identity alone, the way combatOf()
  // above already guards on currentWorld being possibly null.
  const droppedHere = (identity && currentManifest && currentWorld)
    ? await AtlasWallet.getDroppedItemsInWorld(identity.publicKey, manifestDomainOf(currentManifest), currentWorld.id)
    : [];

  const selfWalletAll = identity ? await AtlasWallet.getWallet(identity.publicKey) : [];
  // Dropped items (any world, not just this one — see below) are filtered
  // out here the same way hidden ones are: not in your hands right now,
  // so they don't belong in the normal carrying list. They're not lost —
  // still fully in this wallet's credential store — just visually "left
  // somewhere," surfaced instead via the scene marker and the "Dropped in
  // this world" list below (only for the world they're actually in).
  const allDroppedIds = identity ? new Set((await AtlasWallet.getDroppedItems(identity.publicKey)).map((d) => d.credentialId)) : new Set();
  const selfWallet = selfWalletAll.filter((e) => !e.hidden && !allDroppedIds.has(e.credential.id));
  selfItemsListEl.innerHTML = '';
  if (selfWallet.length === 0) {
    selfItemsListEl.innerHTML = '<div class="empty-note">' + (selfWalletAll.length ? 'Everything here is hidden or dropped somewhere — manage it below or in Settings.' : 'Wallet is empty.') + '</div>';
  } else {
    selfWallet.forEach((entry) => renderItemCard(entry, selfItemsListEl, { loadable: risky, loadout, risky, droppable: true }));
  }

  droppedItemsListEl.innerHTML = '';
  droppedItemsSectionEl.hidden = droppedHere.length === 0;
  if (droppedHere.length > 0) {
    const walletById = new Map(selfWalletAll.map((e) => [e.credential.id, e]));
    droppedHere.forEach((d) => {
      const entry = walletById.get(d.credentialId);
      if (entry) renderDroppedItemCard(entry, droppedItemsListEl);
    });
  }

  const cpWalletAll = counterparty ? await AtlasWallet.getWallet(counterparty.publicKey) : [];
  const cpWallet = cpWalletAll.filter((e) => !e.hidden);
  counterpartyItemsListEl.innerHTML = '';
  if (cpWallet.length === 0) {
    counterpartyItemsListEl.innerHTML = '<div class="empty-note">' + (cpWalletAll.length ? 'Everything here is hidden — manage it in Settings.' : 'Counterparty holds nothing yet.') + '</div>';
  } else {
    cpWallet.forEach((entry) => renderItemCard(entry, counterpartyItemsListEl, { loadable: false }));
  }

  const totalHeld = selfWallet.length + cpWallet.length;
  walletBadge.textContent = String(totalHeld);
  walletBadge.classList.toggle('show', totalHeld > 0);

  // Every refresh rebuilds these lists from scratch (innerHTML = ''), so
  // any active search text has to be re-applied afterward — it isn't part
  // of the underlying data, just a view-layer filter over freshly-rendered
  // cards.
  applyListFilter(selfItemsListEl, itemsSearchInput.value);
  applyListFilter(counterpartyItemsListEl, counterpartyItemsSearchInput.value);

  await refreshHiddenItemsDisplay();
  await refreshRecentWorldsDisplay();
}

// Rebuilds window.__atlasScene.itemMarkers from whatever's currently
// dropped in THIS world (2D renderer only for now — see the note where
// itemMarkers is set up in enterWorld()'s 3D branch). Called after
// entering a world and after every drop/pick-up, same pattern as the
// portalMarkers it sits alongside.
async function refreshSceneItemMarkers() {
  if (!window.__atlasScene || active3D || !currentManifest || !currentWorld) return;
  const identity = await AtlasWallet.getIdentity();
  if (!identity) {
    window.__atlasScene.itemMarkers = [];
    return;
  }
  const dropped = await AtlasWallet.getDroppedItemsInWorld(identity.publicKey, manifestDomainOf(currentManifest), currentWorld.id);
  if (dropped.length === 0) {
    window.__atlasScene.itemMarkers = [];
    return;
  }
  const wallet = await AtlasWallet.getWallet(identity.publicKey);
  const byId = new Map(wallet.map((e) => [e.credential.id, e]));
  window.__atlasScene.itemMarkers = dropped
    .map((d) => {
      const entry = byId.get(d.credentialId);
      return entry ? { position: d.position, credentialId: d.credentialId, name: entry.credential.asset.name } : null;
    })
    .filter(Boolean);
}

// Entry point for the "Drop here" button on an item card.
function beginDropPlacement(id) {
  if (active3D) {
    // The gltf-mini (3D) renderer doesn't have a place-by-click flow or
    // item-marker rendering yet — drop it immediately with a placeholder
    // position so dropping/picking up still fully works via the "Dropped
    // in this world" list, just without a glowing marker to walk up to
    // here. See the note in wallet.js's dropping-items section.
    finalizeDrop(id, [0, 0, 0]);
    return;
  }
  pendingDropCredentialId = id;
  statusEl.textContent = 'Click where you want to drop it (Esc to cancel).';
  canvas.style.cursor = 'crosshair';
}

async function finalizeDrop(id, position) {
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;
  await AtlasWallet.dropItem(identity.publicKey, id, manifestDomainOf(currentManifest), currentWorld.id, position);
  await refreshItemsDisplay();
  await refreshSceneItemMarkers();
  statusEl.textContent = 'Dropped. Pick it back up here whenever you like — nobody else can.';
}

async function pickUpDroppedItem(credentialId) {
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;
  await AtlasWallet.pickUpItem(identity.publicKey, credentialId);
  await refreshItemsDisplay();
  await refreshSceneItemMarkers();
  statusEl.textContent = 'Picked it back up.';
}

// Hides (via the `hidden` attribute, which the existing CSS already
// respects since nothing overrides its default display:none) any
// .wallet-item / .resource-group-header in listEl whose dataset.search
// doesn't contain the query. A resource-group-header stays visible if ANY
// card sharing its dataset.group is still visible after filtering, so
// filtering to one balance inside a multi-balance group doesn't also hide
// that group's "Consolidate" header. Re-run this after every list refresh
// (the lists are fully rebuilt each time) and on every search input event.
function applyListFilter(listEl, rawQuery) {
  if (!listEl) return;
  const query = (rawQuery || '').trim().toLowerCase();
  const cards = listEl.querySelectorAll('.wallet-item, .info-card');
  const groupHasVisible = new Map();
  cards.forEach((card) => {
    const match = !query || (card.dataset.search || '').includes(query);
    card.hidden = !match;
    if (card.dataset.group) {
      groupHasVisible.set(card.dataset.group, groupHasVisible.get(card.dataset.group) || match);
    }
  });
  listEl.querySelectorAll('.resource-group-header').forEach((header) => {
    header.hidden = query && !groupHasVisible.get(header.dataset.group);
  });

  let noMatchEl = listEl.querySelector('.filter-empty-note');
  const anyVisible = Array.from(cards).some((card) => !card.hidden);
  if (query && cards.length > 0 && !anyVisible) {
    if (!noMatchEl) {
      noMatchEl = document.createElement('div');
      noMatchEl.className = 'empty-note filter-empty-note';
      listEl.appendChild(noMatchEl);
    }
    noMatchEl.textContent = 'No matches for "' + rawQuery.trim() + '".';
  } else if (noMatchEl) {
    noMatchEl.remove();
  }
}

itemsSearchInput && itemsSearchInput.addEventListener('input', () => applyListFilter(selfItemsListEl, itemsSearchInput.value));
counterpartyItemsSearchInput && counterpartyItemsSearchInput.addEventListener('input', () => applyListFilter(counterpartyItemsListEl, counterpartyItemsSearchInput.value));
resourcesSearchInput && resourcesSearchInput.addEventListener('input', () => {
  applyListFilter(selfResourceListEl, resourcesSearchInput.value);
  applyListFilter(counterpartyResourceListEl, resourcesSearchInput.value);
});

// The Settings-screen counterpart to the filtering above: lists every
// hidden item (self and counterparty) with an Unhide button, so hiding is
// never a one-way trip. Cheap to recompute on every refreshItemsDisplay —
// this list is normally short, and Settings isn't open most of the time.
function renderHiddenItemCard(entry, ownerLabel, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  el.innerHTML =
    '<div class="name">' + entry.credential.asset.name + '</div>' +
    '<div class="meta">' + entry.credential.asset.class + ' · ' + ownerLabel + '</div>' +
    renderPropertiesToggle(entry.credential.asset.properties) +
    '<div class="item-actions">' +
    '<button data-action="unhide" data-owner="' + ownerLabel + '" data-id="' + entry.credential.id + '">Unhide</button>' +
    '</div>';
  container.appendChild(el);
}

async function refreshHiddenItemsDisplay() {
  if (!hiddenItemsListEl) return;
  const identity = await AtlasWallet.getIdentity();
  const counterparty = await AtlasWallet.getCounterparty();
  const selfHidden = identity ? (await AtlasWallet.getWallet(identity.publicKey)).filter((e) => e.hidden) : [];
  const cpHidden = counterparty ? (await AtlasWallet.getWallet(counterparty.publicKey)).filter((e) => e.hidden) : [];
  hiddenItemsListEl.innerHTML = '';
  if (selfHidden.length === 0 && cpHidden.length === 0) {
    hiddenItemsListEl.innerHTML = '<div class="empty-note">No hidden items.</div>';
    return;
  }
  selfHidden.forEach((entry) => renderHiddenItemCard(entry, 'self', hiddenItemsListEl));
  cpHidden.forEach((entry) => renderHiddenItemCard(entry, 'counterparty', hiddenItemsListEl));
}

hiddenItemsListEl && hiddenItemsListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.action === 'toggle-properties') {
    const detail = btn.nextElementSibling;
    if (!detail) return;
    detail.hidden = !detail.hidden;
    btn.classList.toggle('open', !detail.hidden);
    return;
  }
  if (btn.dataset.action !== 'unhide') return;
  const owner = btn.dataset.owner === 'self' ? await AtlasWallet.getIdentity() : await AtlasWallet.getCounterparty();
  if (!owner) return;
  await AtlasWallet.unhideItem(owner.publicKey, btn.dataset.id);
  await refreshItemsDisplay();
});

// ---------- recent worlds (Settings -> "Recent worlds") ----------

function renderRecentWorldCard(entry, container) {
  const el = document.createElement('div');
  el.className = 'info-card';
  const isHere = !!(currentWorld && currentManifest && entry.domain === currentManifest.domain && entry.world === currentWorld.id);
  el.innerHTML =
    '<div class="name">' + entry.worldName + '</div>' +
    '<div class="meta">' + entry.domain + ' · ' + entry.world + '</div>' +
    '<div class="item-actions">' +
    (isHere
      ? '<span class="empty-note">You are here</span>'
      : '<button data-action="travel" data-manifest="' + entry.manifestUrl + '" data-world="' + entry.world + '">Go</button>') +
    '</div>';
  container.appendChild(el);
}

async function refreshRecentWorldsDisplay() {
  if (!recentWorldsListEl) return;
  const list = await AtlasWallet.getRecentWorlds();
  recentWorldsListEl.innerHTML = '';
  if (list.length === 0) {
    recentWorldsListEl.innerHTML = '<div class="empty-note">Nowhere visited yet.</div>';
    return;
  }
  list.forEach((entry) => renderRecentWorldCard(entry, recentWorldsListEl));
}

// Re-fetches that domain's manifest and enters the specific recorded world
// (not necessarily the manifest's defaultWorld), then closes the wallet
// panel so the newly entered scene is visible — the same effect as
// following a portal, just triggered from Settings instead of the scene.
async function travelToRecentWorld(manifestUrl, worldId) {
  try {
    await loadManifest(manifestUrl, worldId);
    walletPanel.classList.remove('open');
  } catch (err) {
    statusEl.textContent = 'Could not travel there: ' + err.message;
  }
}

recentWorldsListEl && recentWorldsListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.dataset.action !== 'travel') return;
  await travelToRecentWorld(btn.dataset.manifest, btn.dataset.world);
});

function renderResourceCard(entry, container, opts) {
  const el = document.createElement('div');
  el.className = 'wallet-item';
  // Resource properties (SPEC.md §5.4) are attached per CLASS, not per
  // individual balance — the issuer looks them up fresh from the class on
  // every mint/split/consolidate/trade, so every balance of a class always
  // carries identical properties. That's what makes auto-consolidation
  // (which merges same-class balances purely by quantity) safe: it can
  // never blend two different property sets, because there's only ever
  // one set per class to begin with.
  const propsText = formatItemProperties(entry.credential.properties);
  el.dataset.search = (entry.credential.class + ' ' + entry.credential.issuer.domain + ' ' + propsText).toLowerCase();
  if (opts.groupKey) el.dataset.group = opts.groupKey;
  const v = entry.lastVerdict || { valid: false, reason: 'not yet verified' };
  const half = Math.floor(entry.credential.quantity / 2);
  const supersedesNote = Array.isArray(entry.credential.supersedes)
    ? ' · consolidated from ' + entry.credential.supersedes.length + ' balances'
    : entry.credential.supersedes ? ' · supersedes prior balance' : '';
  let html =
    '<div class="name">' + entry.credential.quantity + ' × ' + entry.credential.class + '</div>' +
    '<div class="meta">issued by ' + entry.credential.issuer.domain + supersedesNote + '</div>' +
    renderPropertiesToggle(entry.credential.properties) +
    '<div class="verdict ' + (v.valid ? 'valid' : 'invalid') + '">' + (v.valid ? '✓ ' : '✗ ') + v.reason + '</div>';
  html += '<div class="item-actions">';
  if (half > 0) {
    html += '<button data-action="split" data-id="' + entry.credential.id + '" data-amount="' + half + '">Send ' + half + ' to ' + opts.otherLabel + '</button>';
  }
  html += '<button data-action="delete" data-id="' + entry.credential.id + '" class="danger-btn">Delete</button>';
  html += '</div>';
  el.innerHTML = html;
  container.appendChild(el);
}

// Groups same-wallet resource entries by class + issuer — the two things
// that have to match for balances to be mergeable at all (see
// consolidateResources in wallet.js). A group of 2+ gets a header offering
// to consolidate the whole group into one balance; a lone balance renders
// with no header, same as before this feature existed.
function groupResourceEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.credential.class + '::' + entry.credential.issuer.domain;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()];
}

function renderResourceGroup(group, container, opts) {
  const key = group[0].credential.class + '::' + group[0].credential.issuer.domain;
  if (group.length > 1) {
    const total = group.reduce((sum, e) => sum + e.credential.quantity, 0);
    const header = document.createElement('div');
    header.className = 'resource-group-header';
    header.dataset.group = key;
    header.innerHTML =
      '<span>' + group.length + ' balances of ' + group[0].credential.class + ' (' + total + ' total)</span>' +
      '<button data-action="consolidate-group" data-key="' + key + '">Consolidate</button>';
    container.appendChild(header);
  }
  group.forEach((entry) => renderResourceCard(entry, container, { ...opts, groupKey: group.length > 1 ? key : null }));
}

async function refreshResourcesDisplay() {
  const identity = await AtlasWallet.getIdentity();
  const counterparty = await AtlasWallet.getCounterparty();

  const selfRes = identity ? await AtlasWallet.getResourceWallet(identity.publicKey) : [];
  selfResourceListEl.innerHTML = '';
  if (selfRes.length === 0) {
    selfResourceListEl.innerHTML = '<div class="empty-note">You hold no resources yet.</div>';
  } else {
    groupResourceEntries(selfRes).forEach((group) => renderResourceGroup(group, selfResourceListEl, { otherLabel: 'counterparty', role: 'self' }));
  }

  const cpRes = counterparty ? await AtlasWallet.getResourceWallet(counterparty.publicKey) : [];
  counterpartyResourceListEl.innerHTML = '';
  if (cpRes.length === 0) {
    counterpartyResourceListEl.innerHTML = '<div class="empty-note">Counterparty holds no resources yet.</div>';
  } else {
    groupResourceEntries(cpRes).forEach((group) => renderResourceGroup(group, counterpartyResourceListEl, { otherLabel: 'self', role: 'counterparty' }));
  }

  applyListFilter(selfResourceListEl, resourcesSearchInput.value);
  applyListFilter(counterpartyResourceListEl, resourcesSearchInput.value);
}

// ---------- wallet: onboarding / unlock / create / import / export ----------
//
// One identity, one password. hasIdentity() says whether this device has
// ever set one up; isUnlocked() says whether it's been unlocked THIS
// browser session (chrome.storage.session — memory-only, cleared when the
// browser fully closes). Opening the wallet routes to exactly the right
// screen for that state; every action below re-routes afterward.

walletBtn.addEventListener('click', async () => {
  if (walletPanel.classList.contains('open')) {
    walletPanel.classList.remove('open');
    return;
  }
  walletPanel.classList.add('open');
  await routeWalletScreen();
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'session' && changes.atlasUnlockedIdentity) {
    await refreshIdentityDisplay();
  }
});

chooseNewBtn.addEventListener('click', () => showWalletScreen('createScreen'));
backFromCreateBtn.addEventListener('click', backToWalletHome);
createScreenImportInsteadBtn.addEventListener('click', () => showWalletScreen('importScreen'));
chooseImportBtn.addEventListener('click', () => showWalletScreen('importScreen'));
backFromImportBtn.addEventListener('click', backToWalletHome);
chooseWebAuthnBtn.addEventListener('click', () => showWalletScreen('webauthnCreateScreen'));
backFromWebAuthnCreateBtn.addEventListener('click', backToWalletHome);

confirmWebAuthnCreateBtn.addEventListener('click', async () => {
  confirmWebAuthnCreateBtn.disabled = true;
  webauthnCreateScreenStatus.textContent = 'Waiting for your passkey…';
  try {
    await AtlasWallet.createWebAuthnIdentity();
    webauthnCreateScreenStatus.textContent = '';
    showWalletScreen('mainWalletScreen');
    await refreshIdentityDisplay();
    await refreshItemsDisplay();
    await refreshResourcesDisplay();
  } catch (err) {
    webauthnCreateScreenStatus.textContent = err.message;
  } finally {
    confirmWebAuthnCreateBtn.disabled = false;
  }
});

switchIdentityModeBtn.addEventListener('click', async () => {
  const mode = await AtlasWallet.getIdentityMode();
  const targetMode = mode === 'webauthn' ? 'local' : 'webauthn';
  const targetExists = targetMode === 'local' ? await AtlasWallet.hasLocalIdentity() : await AtlasWallet.hasWebAuthnIdentity();

  if (!targetExists) {
    // Nothing to switch to yet — send the user to set it up. Those
    // screens' own confirm handlers activate the new identity as "self"
    // automatically (see createIdentity()/createWebAuthnIdentity() in
    // wallet.js), so returning here will find the switch already done.
    showWalletScreen(targetMode === 'local' ? 'createScreen' : 'webauthnCreateScreen');
    return;
  }

  switchIdentityModeBtn.disabled = true;
  try {
    await AtlasWallet.setIdentityMode(targetMode);
    await routeWalletScreen();
  } catch (err) {
    statusEl.textContent = 'Switch failed: ' + err.message;
  } finally {
    switchIdentityModeBtn.disabled = false;
  }
});

confirmCreateBtn.addEventListener('click', async () => {
  createScreenStatus.textContent = '';
  if (newPasswordInput.value !== newPasswordConfirmInput.value) {
    createScreenStatus.textContent = 'Passwords do not match.';
    return;
  }
  confirmCreateBtn.disabled = true;
  try {
    const { seedPhrase } = await AtlasWallet.createIdentity(newPasswordInput.value);
    newPasswordInput.value = '';
    newPasswordConfirmInput.value = '';
    showWalletScreen(null);
    seedPhraseTextEl.textContent = seedPhrase;
    seedConfirmCheck.checked = false;
    seedConfirmBtn.disabled = true;
    seedRevealBox.classList.add('show');
  } catch (err) {
    createScreenStatus.textContent = err.message;
  } finally {
    confirmCreateBtn.disabled = false;
  }
});

seedConfirmCheck.addEventListener('change', () => {
  seedConfirmBtn.disabled = !seedConfirmCheck.checked;
});

seedConfirmBtn.addEventListener('click', async () => {
  seedRevealBox.classList.remove('show');
  seedPhraseTextEl.textContent = '';
  showWalletScreen('mainWalletScreen');
  await refreshIdentityDisplay();
  await refreshItemsDisplay();
  await refreshResourcesDisplay();
});

let pendingOnboardImportFile = null;
onboardImportFileInput.addEventListener('change', async () => {
  pendingOnboardImportFile = null;
  const file = onboardImportFileInput.files && onboardImportFileInput.files[0];
  if (!file) return;
  try {
    pendingOnboardImportFile = JSON.parse(await file.text());
    importScreenStatus.textContent = 'File loaded — enter its password and seed phrase.';
  } catch (err) {
    importScreenStatus.textContent = 'Could not read that file: ' + err.message;
  }
});

confirmImportBtn.addEventListener('click', async () => {
  if (!pendingOnboardImportFile) {
    importScreenStatus.textContent = 'Choose a backup file first.';
    return;
  }
  confirmImportBtn.disabled = true;
  importScreenStatus.textContent = 'Decrypting…';
  try {
    await AtlasWallet.importIdentity(pendingOnboardImportFile, onboardImportPasswordInput.value, onboardImportSeedInput.value);
    onboardImportPasswordInput.value = '';
    onboardImportSeedInput.value = '';
    showWalletScreen('mainWalletScreen');
    await refreshIdentityDisplay();
    await refreshItemsDisplay();
    await refreshResourcesDisplay();
  } catch (err) {
    // Deliberately the same message whether the password, the seed
    // phrase, or both were wrong — see wallet.js's importIdentity.
    importScreenStatus.textContent = err.message;
  } finally {
    confirmImportBtn.disabled = false;
  }
});

unlockBtn.addEventListener('click', async () => {
  unlockBtn.disabled = true;
  unlockScreenStatus.textContent = 'Unlocking…';
  try {
    await AtlasWallet.unlockIdentity(unlockPasswordInput.value);
    unlockPasswordInput.value = '';
    unlockScreenStatus.textContent = '';
    showWalletScreen('mainWalletScreen');
    await refreshIdentityDisplay();
    await refreshItemsDisplay();
    await refreshResourcesDisplay();
  } catch (err) {
    unlockScreenStatus.textContent = err.message;
  } finally {
    unlockBtn.disabled = false;
  }
});

lockWalletBtn.addEventListener('click', async () => {
  await AtlasWallet.lockIdentity();
  walletPanel.classList.remove('open');
});

// Collapsible categories: a .settings-category has a heading (the
// .settings-category-toggle button) and a body (.settings-category-body)
// that's shown only while its category carries an .open class — present in
// the HTML by default on categories meant to start open (Identity, Items,
// Resources on the main wallet screen), absent on ones that start closed
// (everything on Settings, plus Counterparty's items / Trading station /
// Recent worlds on the main wallet screen). One delegated listener on
// walletPanel — the shared ancestor of every wallet-screen — covers both
// screens' categories, and any future one, without needing a listener per
// screen.
walletPanel.addEventListener('click', (e) => {
  const toggle = e.target.closest('.settings-category-toggle');
  if (!toggle) return;
  toggle.closest('.settings-category').classList.toggle('open');
});

// Lives in a footer row at the bottom of #mainWalletScreen, outside every
// accordion category, rather than as a small cog next to #walletBtn on the
// scene overlay — #walletBtn already doubles as the onboarding entry point
// when there's no identity yet, and making a cog icon there appear only
// "when logged in" would mean teaching the always-visible scene chrome a
// new async login-state check for a rarely-used action. Anchoring it here
// instead needs no new visibility logic (the whole wallet panel already
// only reaches this screen once unlocked) and reads like the familiar
// "gear icon in the footer" pattern.
openSettingsBtn.addEventListener('click', async () => {
  await refreshIdentityModeControls();
  await refreshHiddenItemsDisplay();
  showWalletScreen('settingsScreen');
});

backFromSettingsBtn.addEventListener('click', routeWalletScreen);

// Blank input + Save = clear the alias back to the raw key; anything else
// = set/replace it (setAlias runs the profanity filter — see wallet.js).
setAliasBtn.addEventListener('click', async () => {
  aliasStatusEl.textContent = '';
  const identity = await AtlasWallet.getIdentity();
  if (!identity) return;
  setAliasBtn.disabled = true;
  try {
    const clearing = aliasInput.value.trim() === '';
    if (clearing) {
      await AtlasWallet.clearAlias(identity.publicKey);
    } else {
      await AtlasWallet.setAlias(identity.publicKey, aliasInput.value);
    }
    // Refreshes walletIdentityEl and re-fills aliasInput from storage —
    // and, as a side effect, clears aliasStatusEl — so the success message
    // is set AFTER, not before, or this refresh would wipe it right back out.
    await refreshIdentityDisplay();
    aliasStatusEl.textContent = clearing ? 'Nickname cleared.' : 'Saved.';
  } catch (err) {
    aliasStatusEl.textContent = err.message;
  } finally {
    setAliasBtn.disabled = false;
  }
});

createCounterpartyBtn.addEventListener('click', async () => {
  createCounterpartyBtn.disabled = true;
  await AtlasWallet.createCounterparty();
  await refreshIdentityDisplay();
  createCounterpartyBtn.disabled = false;
});

exportIdentityBtn.addEventListener('click', async () => {
  exportIdentityBtn.disabled = true;
  exportStatusEl.textContent = 'Encrypting…';
  try {
    const data = await AtlasWallet.exportIdentity(exportPasswordInput.value, exportSeedInput.value);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'atlas-identity-export.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    exportStatusEl.textContent = 'Exported — keep the file, your password, and your seed phrase stored separately from each other.';
    exportPasswordInput.value = '';
    exportSeedInput.value = '';
  } catch (err) {
    exportStatusEl.textContent = 'Export failed: ' + err.message;
  } finally {
    exportIdentityBtn.disabled = false;
  }
});

changePasswordBtn.addEventListener('click', async () => {
  changePasswordStatusEl.textContent = '';
  if (changePasswordNewInput.value !== changePasswordConfirmInput.value) {
    changePasswordStatusEl.textContent = 'New passwords do not match.';
    return;
  }
  changePasswordBtn.disabled = true;
  try {
    await AtlasWallet.changePassword(changePasswordCurrentInput.value, changePasswordNewInput.value);
    changePasswordCurrentInput.value = '';
    changePasswordNewInput.value = '';
    changePasswordConfirmInput.value = '';
    changePasswordStatusEl.textContent = 'Password changed.';
  } catch (err) {
    changePasswordStatusEl.textContent = 'Change failed: ' + err.message;
  } finally {
    changePasswordBtn.disabled = false;
  }
});

exportBtn.addEventListener('click', async () => {
  const data = await AtlasWallet.exportWallet();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'atlas-wallet-export.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// Import is the counterpart to exportBtn above — re-populates this
// wallet's item/resource lists from a previously exported
// atlas-wallet-export/1.0 file. Every credential in it gets independently
// re-verified against its own issuer before being trusted (see
// importWallet in wallet.js), the same as a freshly issued one.
importWalletBtn.addEventListener('click', () => importWalletFileInput.click());

importWalletFileInput.addEventListener('change', async () => {
  const file = importWalletFileInput.files && importWalletFileInput.files[0];
  importWalletFileInput.value = '';
  if (!file) return;
  importWalletStatusEl.textContent = 'Importing…';
  try {
    const fileData = JSON.parse(await file.text());
    const result = await AtlasWallet.importWallet(fileData);
    const parts = [];
    if (result.itemsAdded) parts.push(result.itemsAdded + ' item(s) added');
    if (result.resourcesAdded) parts.push(result.resourcesAdded + ' resource balance(s) added');
    const skippedDup = result.itemsSkippedDuplicate + result.resourcesSkippedDuplicate;
    const skippedOwner = result.itemsSkippedNotOwned + result.resourcesSkippedNotOwned;
    if (skippedDup) parts.push(skippedDup + ' already in this wallet');
    if (skippedOwner) parts.push(skippedOwner + ' skipped (belong to a different identity)');
    importWalletStatusEl.textContent = parts.length ? parts.join(', ') + '.' : 'Nothing new to import.';
    await refreshItemsDisplay();
    await refreshResourcesDisplay();
  } catch (err) {
    importWalletStatusEl.textContent = 'Import failed: ' + err.message;
  }
});

requestItemBtn.addEventListener('click', async () => {
  const world = currentWorld;
  const assetClass = world.policy.acceptedItemClasses[0];
  requestItemBtn.disabled = true;
  requestItemBtn.textContent = 'Requesting…';
  try {
    await AtlasWallet.requestItem(manifestDomainOf(currentManifest), assetClass);
    await refreshItemsDisplay();
  } catch (err) {
    statusEl.textContent = 'Issuance failed: ' + err.message;
  } finally {
    refreshRequestButton();
  }
});

presentBtn.addEventListener('click', async () => {
  presentBtn.disabled = true;
  presentBtn.textContent = 'Signing…';
  try {
    const ok = await AtlasWallet.presentIdentity();
    presentBtn.textContent = ok ? '✓ Presented — signature verified' : '✗ Signature check failed';
  } catch (err) {
    presentBtn.textContent = 'Presentation failed';
    statusEl.textContent = err.message;
  } finally {
    setTimeout(() => { presentBtn.disabled = false; presentBtn.textContent = 'Present identity (verify possession)'; }, 2500);
  }
});

reverifyBtn.addEventListener('click', async () => {
  reverifyBtn.disabled = true;
  reverifyBtn.textContent = 'Re-verifying…';
  await AtlasWallet.reverifyAll();
  await refreshItemsDisplay();
  await refreshResourcesDisplay();
  reverifyBtn.disabled = false;
  reverifyBtn.textContent = 'Re-verify wallet against current issuers';
});

// Event delegation for per-item buttons (load/unload, simulate loss,
// delete) since the item cards are re-rendered from scratch on every
// refresh. One handler covers both self's and the counterparty's item
// list — self gets the extra loadout/PvP actions, delete is common to both.
function itemActionHandler(listEl, role) {
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'toggle-properties') {
      const detail = btn.nextElementSibling;
      if (!detail) return;
      detail.hidden = !detail.hidden;
      btn.classList.toggle('open', !detail.hidden);
    } else if (btn.dataset.action === 'toggle-load') {
      const loadout = await AtlasWallet.getLoadout();
      if (loadout.includes(id)) await AtlasWallet.unloadItem(id); else await AtlasWallet.loadItem(id);
      await refreshItemsDisplay();
    } else if (btn.dataset.action === 'lose') {
      btn.disabled = true;
      btn.textContent = 'Signing…';
      try {
        const identity = await AtlasWallet.getIdentity();
        const selfWallet = await AtlasWallet.getWallet(identity.publicKey);
        const entry = selfWallet.find((x) => x.credential.id === id);
        await AtlasWallet.loseItemToCounterparty(entry.credential, { domain: manifestDomainOf(currentManifest), world: currentWorld.id });
        await refreshItemsDisplay();
      } catch (err) {
        statusEl.textContent = 'Transfer failed: ' + err.message;
      }
    } else if (btn.dataset.action === 'hide') {
      const who = role === 'self' ? await AtlasWallet.getIdentity() : await AtlasWallet.getCounterparty();
      if (!who) return;
      await AtlasWallet.hideItem(who.publicKey, id);
      await refreshItemsDisplay();
    } else if (btn.dataset.action === 'drop') {
      beginDropPlacement(id);
    }
  });
}
itemActionHandler(selfItemsListEl, 'self');
itemActionHandler(counterpartyItemsListEl, 'counterparty');

droppedItemsListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.dataset.action !== 'pick-up') return;
  pickUpDroppedItem(btn.dataset.id);
});

// Event delegation for resource cards: split, delete, and consolidating a
// same-class-same-issuer group into one balance.
function resourceActionHandler(listEl, role, toRole) {
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.action) return;
    if (btn.dataset.action === 'toggle-properties') {
      const detail = btn.nextElementSibling;
      if (!detail) return;
      detail.hidden = !detail.hidden;
      btn.classList.toggle('open', !detail.hidden);
      return;
    }
    const who = role === 'self' ? await AtlasWallet.getIdentity() : await AtlasWallet.getCounterparty();
    if (!who) return;

    if (btn.dataset.action === 'split') {
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const wallet = await AtlasWallet.getResourceWallet(who.publicKey);
        const entry = wallet.find((x) => x.credential.id === btn.dataset.id);
        await AtlasWallet.splitResource(role, entry.credential, Number(btn.dataset.amount), toRole);
        await refreshResourcesDisplay();
      } catch (err) {
        statusEl.textContent = 'Split failed: ' + err.message;
      }
    } else if (btn.dataset.action === 'delete') {
      if (!confirm('Remove this balance from view here? This only clears it locally — it does not revoke the credential.')) return;
      await AtlasWallet.deleteResource(who.publicKey, btn.dataset.id);
      await refreshResourcesDisplay();
    } else if (btn.dataset.action === 'consolidate-group') {
      const sepIndex = btn.dataset.key.indexOf('::');
      const cls = btn.dataset.key.slice(0, sepIndex);
      const issuerDomain = btn.dataset.key.slice(sepIndex + 2);
      btn.disabled = true;
      btn.textContent = 'Consolidating…';
      try {
        const wallet = await AtlasWallet.getResourceWallet(who.publicKey);
        const group = wallet.filter((x) => x.credential.class === cls && x.credential.issuer.domain === issuerDomain);
        await AtlasWallet.consolidateResources(role, group.map((entry) => entry.credential));
        await refreshResourcesDisplay();
      } catch (err) {
        statusEl.textContent = 'Consolidate failed: ' + err.message;
      }
    }
  });
}
resourceActionHandler(selfResourceListEl, 'self', 'counterparty');
resourceActionHandler(counterpartyResourceListEl, 'counterparty', 'self');

mintIronBtn.addEventListener('click', async () => {
  mintIronBtn.disabled = true;
  mintIronBtn.textContent = 'Mining…';
  try {
    await AtlasWallet.mintResource('self', manifestDomainOf(currentManifest), 'atlas.element.iron', 20);
    await refreshResourcesDisplay();
  } catch (err) {
    statusEl.textContent = 'Mint failed: ' + err.message;
  } finally {
    mintIronBtn.disabled = false;
    mintIronBtn.textContent = 'Mine 20 iron (self)';
  }
});

mintGoldBtn.addEventListener('click', async () => {
  mintGoldBtn.disabled = true;
  mintGoldBtn.textContent = 'Mining…';
  try {
    await AtlasWallet.mintResource('counterparty', manifestDomainOf(currentManifest), 'atlas.element.gold', 10);
    await refreshResourcesDisplay();
  } catch (err) {
    statusEl.textContent = 'Mint failed: ' + err.message;
  } finally {
    mintGoldBtn.disabled = false;
    mintGoldBtn.textContent = 'Mine 10 gold (counterparty)';
  }
});

// Dispatch for a clicked in-scene interactable (see the "interactables"
// note in enterWorld). Only one action exists today — "mint", which does
// exactly what the Settings-panel mine buttons above do, just triggered by
// clicking the stall itself instead of opening the wallet. The busy guard
// exists because — unlike a portal (leaves the scene) or a dropped item
// (removes its own marker once picked up) — a mint stall stays put and
// stays clickable, so nothing else stops a fast double-click from firing
// two mints at once.
async function handleInteractable(marker) {
  if (interactableBusy) return;
  interactableBusy = true;
  try {
    if (marker.action === 'mint') {
      statusEl.textContent = 'Mining ' + marker.class + '…';
      await AtlasWallet.mintResource(marker.role || 'self', manifestDomainOf(currentManifest), marker.class, marker.quantity);
      await refreshResourcesDisplay();
      statusEl.textContent = 'Collected ' + marker.quantity + ' × ' + marker.class + '.';
    } else if (marker.action === 'issue') {
      // Unlike a resource balance, an item credential isn't quantity-based
      // — every "collect" issues a brand-new unique credential, and the
      // issuer has no concept of "already gave this owner one" (there's no
      // protocol-level item scarcity — see SPEC.md's item-class section).
      // marker.oncePerUser is a purely client-side stand-in for that: check
      // this wallet for an existing credential of the same class from this
      // same issuer before asking for another, so a stall that's meant to
      // read as "one keepsake per visitor" doesn't let repeated clicks
      // quietly fill the wallet with duplicates. It only looks at THIS
      // wallet, so it's a per-device courtesy, not real scarcity — an
      // intentional, disclosed simplification, same spirit as the drop/
      // pick-up feature being local-only.
      const identity = await AtlasWallet.getIdentity();
      if (!identity) throw new Error('Create an identity first.');
      if (marker.oncePerUser) {
        const wallet = await AtlasWallet.getWallet(identity.publicKey);
        const already = wallet.some((e) => e.credential.asset.class === marker.class && e.credential.issuer.domain === manifestDomainOf(currentManifest));
        if (already) {
          statusEl.textContent = "Already collected " + (marker.label || 'this') + " — check your wallet.";
          return;
        }
      }
      statusEl.textContent = 'Collecting ' + (marker.label || marker.class) + '…';
      await AtlasWallet.requestItem(manifestDomainOf(currentManifest), marker.class);
      await refreshItemsDisplay();
      statusEl.textContent = 'Collected ' + (marker.label || marker.class) + '.';
    }
  } catch (err) {
    statusEl.textContent = (marker.action === 'mint' ? 'Mint failed: ' : 'Collect failed: ') + err.message;
  } finally {
    interactableBusy = false;
  }
}

tradeBtn.addEventListener('click', async () => {
  tradeBtn.disabled = true;
  tradeStatusEl.textContent = 'Proposing intents…';
  try {
    const identity = await AtlasWallet.getIdentity();
    const counterparty = await AtlasWallet.getCounterparty();
    if (!identity || !counterparty) throw new Error('Create both identities first.');

    const selfRes = await AtlasWallet.getResourceWallet(identity.publicKey);
    const cpRes = await AtlasWallet.getResourceWallet(counterparty.publicKey);
    const ironBalance = selfRes.map((e) => e.credential).find((c) => c.class === 'atlas.element.iron' && c.quantity >= 10);
    const goldBalance = cpRes.map((e) => e.credential).find((c) => c.class === 'atlas.element.gold' && c.quantity >= 5);
    if (!ironBalance) throw new Error('Self needs at least 10 iron — mine some first.');
    if (!goldBalance) throw new Error('Counterparty needs at least 5 gold — mine some first.');

    const offerSelf = { class: 'atlas.element.iron', quantity: 10 };
    const wantSelf = { class: 'atlas.element.gold', quantity: 5 };
    const intentSelf = await AtlasWallet.proposeIntent('self', offerSelf, wantSelf, counterparty.publicKey, 10);

    const offerCp = { class: 'atlas.element.gold', quantity: 5 };
    const wantCp = { class: 'atlas.element.iron', quantity: 10 };
    const intentCp = await AtlasWallet.proposeIntent('counterparty', offerCp, wantCp, identity.publicKey, 10);

    tradeStatusEl.textContent = 'Settling…';
    await AtlasWallet.settleTrade(manifestDomainOf(currentManifest), intentSelf, intentCp, ironBalance, goldBalance);
    await refreshResourcesDisplay();
    tradeStatusEl.textContent = '✓ Settled: self sent 10 iron and received 5 gold; counterparty mirrored it.';
  } catch (err) {
    tradeStatusEl.textContent = 'Trade failed: ' + err.message;
  } finally {
    tradeBtn.disabled = !(currentWorld && currentWorld.profile && currentWorld.profile.genre === 'trading-station');
  }
});

// Enter-to-submit on the password fields that each drive exactly one
// primary action — unlocking, creating an identity, and changing a
// password. preventDefault just to be safe, though none of these sit in an
// actual <form>. Deliberately NOT applied to the export/import password
// fields: those forms mix a textarea (seed phrase) where Enter should
// insert a newline, not submit.
function bindEnterToClick(input, btn) {
  if (!input || !btn) return;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    btn.click();
  });
}
bindEnterToClick(unlockPasswordInput, unlockBtn);
bindEnterToClick(newPasswordInput, confirmCreateBtn);
bindEnterToClick(newPasswordConfirmInput, confirmCreateBtn);
bindEnterToClick(changePasswordCurrentInput, changePasswordBtn);
bindEnterToClick(changePasswordNewInput, changePasswordBtn);
bindEnterToClick(changePasswordConfirmInput, changePasswordBtn);
bindEnterToClick(aliasInput, setAliasBtn);

refreshIdentityDisplay();
refreshItemsDisplay();
refreshResourcesDisplay();

const start = startParams();
if (start.manifest) {
  loadManifest(start.manifest).then(() => {
    if (start.world && start.world !== currentManifest.defaultWorld) {
      return enterWorld(start.world);
    }
  }).then(() => {
    requestAnimationFrame(render);
  });
} else {
  statusEl.textContent = 'No manifest specified.';
}
