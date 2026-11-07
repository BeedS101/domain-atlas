// Compass heading display. Shown by the viewer while an equipped Item Standard item provides
// atlas.cap.compass in the current 3D world.
//
// World space: the character's facing vector is [x, z] on the ground plane, north is -z and east is +x, so
// the heading in degrees clockwise from north is atan2(x, -z).
//
// Exposes window.AtlasCompassHud (and module.exports under Node, for the pure helpers):
//   LABELS                 the eight points with their headings
//   headingOf(dir)         [x, z] -> degrees in [0, 360), or null for a zero or non-finite vector
//   pointOf(heading)       nearest of the eight labels
//   layout(heading, r)     { label, x, y } per point, rotated so the facing heading sits at the top
//   create(parent)         builds the element; returns { el, setVisible, isVisible, update, destroy }

(function (root) {
  'use strict';

  const LABELS = [
    { label: 'N', deg: 0 }, { label: 'NE', deg: 45 }, { label: 'E', deg: 90 }, { label: 'SE', deg: 135 },
    { label: 'S', deg: 180 }, { label: 'SW', deg: 225 }, { label: 'W', deg: 270 }, { label: 'NW', deg: 315 }
  ];

  function normalize(deg) {
    return ((deg % 360) + 360) % 360;
  }

  function headingOf(dir) {
    if (!Array.isArray(dir) || !Number.isFinite(dir[0]) || !Number.isFinite(dir[1])) return null;
    if (Math.hypot(dir[0], dir[1]) < 1e-9) return null;
    const deg = Math.atan2(dir[0], -dir[1]) * 180 / Math.PI;
    const out = normalize(deg);
    return out >= 359.9999999 ? 0 : out;
  }

  function pointOf(heading) {
    const idx = Math.round(normalize(heading) / 45) % 8;
    return LABELS[idx].label;
  }

  function layout(heading, radius) {
    return LABELS.map((p) => {
      const a = (p.deg - heading) * Math.PI / 180;
      return { label: p.label, x: Math.sin(a) * radius, y: -Math.cos(a) * radius };
    });
  }

  const STYLE_ID = 'atlas-compass-hud-style';
  const SIZE = 96;
  const RADIUS = 34;

  function injectStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#atlasCompassHud{position:fixed;top:68px;right:14px;width:' + SIZE + 'px;height:' + SIZE + 'px;border-radius:50%;' +
      'background:rgba(20,31,38,0.82);border:2px solid #b0803a;box-shadow:0 2px 8px rgba(0,0,0,0.45);' +
      'pointer-events:none;user-select:none;z-index:40;display:none;font:600 11px system-ui,sans-serif;color:#e8f0f2}' +
      '#atlasCompassHud.active{display:block}' +
      '#atlasCompassHud .ch-pt{position:absolute;left:50%;top:50%;width:0;height:0;display:flex;align-items:center;justify-content:center}' +
      '#atlasCompassHud .ch-pt span{white-space:nowrap;opacity:0.72}' +
      '#atlasCompassHud .ch-pt.cardinal span{opacity:1;font-size:13px}' +
      '#atlasCompassHud .ch-pt.n span{color:#ff8a65;opacity:1}' +
      '#atlasCompassHud .ch-pt.front span{color:#ffd27a;opacity:1}' +
      '#atlasCompassHud .ch-tick{position:absolute;left:50%;top:2px;width:0;height:0;margin-left:-5px;' +
      'border-left:5px solid transparent;border-right:5px solid transparent;border-top:8px solid #ffd27a}' +
      '#atlasCompassHud .ch-read{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;' +
      'font-size:12px;color:#e8f0f2;opacity:0.9}';
    doc.head.appendChild(style);
  }

  function create(parent) {
    const doc = parent.ownerDocument || document;
    injectStyle(doc);
    const el = doc.createElement('div');
    el.id = 'atlasCompassHud';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Compass');
    const tick = doc.createElement('div');
    tick.className = 'ch-tick';
    el.appendChild(tick);
    const points = LABELS.map((p) => {
      const node = doc.createElement('div');
      node.className = 'ch-pt' + (p.deg % 90 === 0 ? ' cardinal' : '') + (p.deg === 0 ? ' n' : '');
      node.dataset.point = p.label;
      const text = doc.createElement('span');
      text.textContent = p.label;
      node.appendChild(text);
      el.appendChild(node);
      return node;
    });
    const read = doc.createElement('div');
    read.className = 'ch-read';
    el.appendChild(read);
    parent.appendChild(el);

    let visible = false;
    let lastKey = null;

    function update(heading) {
      if (!Number.isFinite(heading)) return;
      const key = Math.round(heading * 4);
      if (key === lastKey) return;
      lastKey = key;
      const front = pointOf(heading);
      layout(heading, RADIUS).forEach((pos, i) => {
        const node = points[i];
        node.style.transform = 'translate(' + pos.x.toFixed(1) + 'px,' + pos.y.toFixed(1) + 'px)';
        node.classList.toggle('front', pos.label === front && pos.label !== 'N');
      });
      read.textContent = Math.round(heading) % 360 + '\u00b0';
      el.dataset.heading = String(Math.round(heading));
      el.dataset.facing = front;
    }

    return {
      el,
      isVisible: () => visible,
      setVisible: (on) => {
        visible = !!on;
        el.classList.toggle('active', visible);
        if (!visible) lastKey = null;
      },
      update,
      destroy: () => { visible = false; el.remove(); }
    };
  }

  const api = { LABELS, headingOf, pointOf, layout, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AtlasCompassHud = api;
})(typeof window !== 'undefined' ? window : globalThis);
