// Developer/debug HUD for the gltf-mini-v1 renderer. F3 shows or hides a small
// fixed overlay with performance, resource and active-feature readouts, and
// an optional list of caller-supplied status lines.
//
// It only reads the renderer's getDebugInfo() snapshot; it never touches the
// canvas, the camera, input handling or any renderer state. While hidden it
// costs nothing: no DOM, no timer, only the F3 key listener. While visible it
// refreshes a few times a second from a timer and does no network work.
//
// Exposes window.MiniGLTFHud:
//   install({ getRenderer })  once; getRenderer() returns the current renderer
//                             instance (or null). Idempotent.
//   toggle() / show() / hide() / isVisible()
//   setDebugStatuses([{ label, value }, ...])  extra status lines; [] clears
//   format(info, fps, statuses)  pure text builder (used by tests)
//   uninstall()  removes the listener, timer and overlay
//
// See docs/gltf-mini-debug-hud.md.

(function () {
  'use strict';

  const REFRESH_MS = 250;      // how often the overlay text is rebuilt while visible
  const FPS_SMOOTHING = 0.35;  // weight of the newest sample in the smoothed FPS / frame time
  const MAX_STATUSES = 20;
  const MAX_LABEL = 32;
  const MAX_VALUE = 40;

  let getRenderer = () => null;
  let installed = false;
  let visible = false;
  let el = null;
  let timer = null;
  let statuses = [];
  // frame-rate sampling, reset whenever the renderer instance or frame counter changes
  let sample = null;           // { t, frames, renderer }
  let fps = null;              // smoothed frames per second, null until two samples exist
  let frameMs = null;          // smoothed milliseconds per frame

  const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
  const fixed = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  const vec = (a) => (Array.isArray(a) ? a.map((v) => fixed(v, 2)).join(', ') : '-');

  // Builds the HUD text. `fpsState` is { fps, frameMs } or null.
  function format(info, fpsState, statusList) {
    const lines = [];
    if (!info) {
      lines.push('gltf-mini-v1 HUD', 'no 3D world is loaded');
    } else {
      const r = info.resources || {};
      const f = info.features || {};
      const onOff = (on, n) => (on ? 'ON' + (Number.isFinite(n) ? ' ' + n : '') : 'OFF');
      lines.push('PERFORMANCE');
      lines.push(pad('FPS', 13) + (fpsState && fpsState.fps !== null ? fixed(fpsState.fps, 1) : '-'));
      lines.push(pad('Frame time', 13) + (fpsState && fpsState.frameMs !== null ? fixed(fpsState.frameMs, 1) + ' ms' : '-'));
      lines.push(pad('Renderer', 13) + info.renderer);
      lines.push(pad('Scene', 13) + (info.label || '-'));
      lines.push(pad('Char scale', 13) + fixed(info.characterScale, 2) + (info.characterScaleFromScene ? ' (scene)' : ''));
      lines.push(pad('Player', 13) + vec(info.playerPos));
      lines.push(pad('Camera', 13) + vec(info.cameraPos));
      lines.push('');
      lines.push('RESOURCES');
      lines.push(pad('Models', 13) + r.sceneModels + (r.dropModels ? ' + ' + r.dropModels + ' drop' : '') + '  (cache ' + r.cachedModels + ')');
      lines.push(pad('GPU textures', 13) + r.textures);
      lines.push(pad('Item drops', 13) + r.itemDrops);
      lines.push(pad('Objects', 13) + r.objects + '  (' + r.drawables + ' drawables)');
      lines.push('');
      lines.push('ACTIVE FEATURES');
      lines.push(pad('Fog', 13) + onOff(f.fog));
      lines.push(pad('Normal maps', 13) + onOff(f.normalMaps > 0, f.normalMaps));
      lines.push(pad('Emissive', 13) + onOff(f.emissive > 0, f.emissive));
      lines.push(pad('Alpha MASK', 13) + onOff(f.mask > 0, f.mask));
      lines.push(pad('Unlit', 13) + onOff(f.unlit > 0, f.unlit));
    }
    if (statusList && statusList.length) {
      lines.push('');
      lines.push('STATUS');
      statusList.forEach((s) => lines.push(pad(s.label, 13) + (s.label.length >= 13 ? ' ' : '') + s.value));
    }
    return lines.join('\n');
  }

  function resetSample() { sample = null; fps = null; frameMs = null; }

  // Updates the smoothed FPS / frame time from the renderer's frame counter.
  function sampleFrames(info) {
    const now = performance.now();
    if (!info) { resetSample(); return; }
    const renderer = getRenderer();
    if (!sample || sample.renderer !== renderer || info.frames < sample.frames) {
      sample = { t: now, frames: info.frames, renderer };
      fps = null; frameMs = null;
      return;
    }
    const dt = now - sample.t, df = info.frames - sample.frames;
    if (dt <= 0) return;
    const instFps = df * 1000 / dt;
    const instMs = df > 0 ? dt / df : null;
    fps = fps === null ? instFps : fps + (instFps - fps) * FPS_SMOOTHING;
    if (instMs !== null) frameMs = frameMs === null ? instMs : frameMs + (instMs - frameMs) * FPS_SMOOTHING;
    else frameMs = null;
    sample.t = now; sample.frames = info.frames;
  }

  function currentInfo() {
    const renderer = getRenderer();
    if (!renderer || typeof renderer.getDebugInfo !== 'function') return null;
    try { return renderer.getDebugInfo(); } catch (err) { return null; }
  }

  function refresh() {
    if (!visible || !el) return;
    const info = currentInfo();
    sampleFrames(info);
    el.textContent = format(info, { fps, frameMs }, statuses);
  }

  function createElement() {
    const node = document.createElement('div');
    node.id = 'miniGltfHud';
    node.setAttribute('aria-hidden', 'true');
    // Fixed, never blocks scene input, below the viewer's own dialogs.
    node.style.cssText = [
      'position:fixed', 'top:56px', 'left:8px', 'z-index:9', 'pointer-events:none', 'user-select:none',
      'margin:0', 'padding:6px 9px', 'border-radius:5px', 'background:rgba(8,13,16,0.72)',
      'color:#cfe6dd', 'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'white-space:pre', 'max-width:calc(100vw - 16px)', 'overflow:hidden'
    ].join(';');
    return node;
  }

  function show() {
    if (visible) return;
    visible = true;
    if (!el) el = createElement();
    if (!el.parentNode) document.body.appendChild(el);
    resetSample();
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
  }

  function hide() {
    visible = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (el && el.parentNode) el.parentNode.removeChild(el);
    resetSample();
  }

  function toggle() { if (visible) hide(); else show(); }

  function onKeyDown(e) {
    if (e.code !== 'F3' || e.repeat || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    e.preventDefault(); // F3 is "find next" in most browsers
    toggle();
  }

  function setDebugStatuses(list) {
    statuses = (Array.isArray(list) ? list : []).slice(0, MAX_STATUSES)
      .filter((s) => s && s.label !== undefined && s.label !== null && String(s.label) !== '')
      .map((s) => ({
        label: String(s.label).slice(0, MAX_LABEL),
        value: String(s.value === undefined || s.value === null ? '' : s.value).slice(0, MAX_VALUE)
      }));
    refresh();
  }

  function install(options) {
    if (options && typeof options.getRenderer === 'function') getRenderer = options.getRenderer;
    if (installed) return;
    installed = true;
    window.addEventListener('keydown', onKeyDown);
  }

  function uninstall() {
    hide();
    if (installed) window.removeEventListener('keydown', onKeyDown);
    installed = false;
    getRenderer = () => null;
    statuses = [];
  }

  window.MiniGLTFHud = { install, uninstall, toggle, show, hide, isVisible: () => visible, setDebugStatuses, format };
})();
