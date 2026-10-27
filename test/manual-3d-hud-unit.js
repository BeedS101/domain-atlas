// Data checks (no browser) for the gltf-mini debug HUD helper
// (extension/gltf-mini-hud.js), against a fake window/document/timer:
//
//   1. F3 toggles it; other keys, held-key repeats and modified F3 do not.
//   2. Hidden costs nothing: no element, no timer; showing creates one fixed,
//      non-interactive overlay and one timer; hiding removes both.
//   3. FPS and frame time come from the renderer's frame counter, smoothed, and
//      restart when the renderer instance changes.
//   4. The text shows the performance, resource and feature fields; a feature
//      reads OFF when its count is 0 and ON with its count otherwise.
//   5. Status entries: shown in their own section, sanitised and capped, and the
//      section is hidden when there are none.
//   6. A renderer without getDebugInfo (or none at all) never throws.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
let now = 1000;
const listeners = {};
const timers = new Map();
let nextTimer = 1;
const body = { children: [], appendChild(n) { n.parentNode = body; body.children.push(n); }, removeChild(n) { body.children = body.children.filter((c) => c !== n); n.parentNode = null; } };
const window = {
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); }
};
const document = {
  body,
  createElement: () => {
    const el = { style: { cssText: '' }, attrs: {}, textContent: '', parentNode: null, setAttribute(k, v) { el.attrs[k] = v; } };
    return el;
  }
};
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini-hud.js'), 'utf8'), {
  window, document, performance: { now: () => now }, console,
  setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
  clearInterval: (id) => timers.delete(id),
  Number, String, Array, Math
});
const Hud = window.MiniGLTFHud;

let checks = 0;
const pass = (msg) => { checks++; console.log('PASS: ' + msg); };
const key = (init) => {
  const e = { code: 'F3', repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...init };
  (listeners.keydown || []).forEach((fn) => fn(e));
  return e;
};
const tick = () => [...timers.values()].forEach((t) => t.fn());

const baseInfo = (over) => ({
  renderer: 'gltf-mini-v1', label: 'lobby', frames: 0, characterScale: 0.5, characterScaleFromScene: true,
  playerPos: [1, 0, -2.5], cameraPos: [1, 1.6, -2.5], cameraDistance: 0,
  resources: { sceneModels: 7, dropModels: 0, cachedModels: 9, textures: 12, itemDrops: 0, objects: 40, drawables: 55 },
  features: { fog: false, normalMaps: 0, emissive: 0, mask: 0, unlit: 0 },
  ...(over || {})
});
let info = baseInfo();
const renderer = { getDebugInfo: () => info };
Hud.install({ getRenderer: () => renderer });

// ---- 1. keys ----
assert.strictEqual(Hud.isVisible(), false, 'hidden by default');
assert.strictEqual(key({ code: 'KeyW' }).prevented, false); assert.strictEqual(Hud.isVisible(), false);
assert.strictEqual(key({ ctrlKey: true }).prevented, false); assert.strictEqual(Hud.isVisible(), false);
assert.strictEqual(key({ repeat: true }).prevented, false); assert.strictEqual(Hud.isVisible(), false);
// ---- 2. cost while hidden / visible ----
assert.strictEqual(body.children.length, 0, 'no overlay while hidden'); assert.strictEqual(timers.size, 0, 'no timer while hidden');
assert.strictEqual(key().prevented, true, 'F3 default (find next) is suppressed');
assert.strictEqual(Hud.isVisible(), true, 'F3 shows it');
assert.strictEqual(body.children.length, 1); assert.strictEqual(timers.size, 1);
const el = body.children[0];
assert(/position:fixed/.test(el.style.cssText) && /pointer-events:none/.test(el.style.cssText), 'fixed and non-interactive');
assert(/monospace/.test(el.style.cssText) && /rgba\(/.test(el.style.cssText), 'monospace on a translucent background');
assert.strictEqual(el.attrs['aria-hidden'], 'true');
key(); assert.strictEqual(Hud.isVisible(), false, 'F3 again hides it');
assert.strictEqual(body.children.length, 0); assert.strictEqual(timers.size, 0, 'the timer is cleared');
pass('F3 toggles; other keys, repeats and modified F3 do nothing; hidden = no element and no timer; visible = one fixed, non-interactive overlay');

// ---- 3. fps ----
Hud.show();
assert(/FPS\s+-/.test(el.textContent), 'no FPS until a second sample exists');
for (let i = 0; i < 6; i++) { now += 250; info = baseInfo({ frames: info.frames + 15 }); tick(); } // 60 fps
let m = /FPS\s+([\d.]+)/.exec(el.textContent), ms = /Frame time\s+([\d.]+) ms/.exec(el.textContent);
assert(m && Math.abs(parseFloat(m[1]) - 60) < 0.5, 'steady 60 fps reads 60, got ' + (m && m[1]));
assert(ms && Math.abs(parseFloat(ms[1]) - 16.7) < 0.3, 'and 16.7 ms, got ' + (ms && ms[1]));
now += 250; info = baseInfo({ frames: info.frames + 5 }); tick(); // one slow interval: 20 fps instantaneous
m = /FPS\s+([\d.]+)/.exec(el.textContent);
assert(parseFloat(m[1]) > 40 && parseFloat(m[1]) < 55, 'one slow sample is smoothed, not shown raw, got ' + m[1]);
for (let i = 0; i < 20; i++) { now += 250; info = baseInfo({ frames: info.frames + 5 }); tick(); }
m = /FPS\s+([\d.]+)/.exec(el.textContent);
assert(Math.abs(parseFloat(m[1]) - 20) < 0.5, 'it converges to the new rate, got ' + m[1]);
const swapped = { getDebugInfo: () => baseInfo({ frames: 3 }) };
Hud.install({ getRenderer: () => swapped });
now += 250; tick();
assert(/FPS\s+-/.test(el.textContent), 'a different renderer instance restarts the measurement');
Hud.install({ getRenderer: () => renderer });
now += 250; info = baseInfo({ frames: 1000 }); tick(); now += 250; info = baseInfo({ frames: 5 }); tick();
assert(/FPS\s+-/.test(el.textContent), 'a frame counter that goes backwards restarts it');
pass('FPS and frame time follow the frame counter, are smoothed, and restart on a new renderer');

// ---- 4. fields and features ----
info = baseInfo({ frames: 5 }); tick();
const text = el.textContent;
['PERFORMANCE', 'Renderer     gltf-mini-v1', 'Scene        lobby', 'Char scale   0.50 (scene)', 'Player       1.00, 0.00, -2.50', 'Camera       1.00, 1.60, -2.50',
  'RESOURCES', 'Models       7  (cache 9)', 'GPU textures 12', 'Item drops   0', 'Objects      40  (55 drawables)', 'ACTIVE FEATURES']
  .forEach((s) => assert(text.includes(s), 'missing "' + s + '" in:\n' + text));
['Fog', 'Normal maps', 'Emissive', 'Alpha MASK', 'Unlit'].forEach((f) => assert(new RegExp(f + '\\s+OFF\\s*(\\n|$)').test(text), f + ' is OFF with nothing using it'));
info = baseInfo({ frames: 6, resources: { ...baseInfo().resources, dropModels: 2 }, features: { fog: true, normalMaps: 4, emissive: 3, mask: 1, unlit: 2 } }); tick();
const t2 = el.textContent;
assert(/Fog\s+ON\s*\n/.test(t2) && /Normal maps\s+ON 4/.test(t2) && /Emissive\s+ON 3/.test(t2) && /Alpha MASK\s+ON 1/.test(t2) && /Unlit\s+ON 2/.test(t2), 'features show ON with counts:\n' + t2);
assert(t2.includes('7 + 2 drop'), 'drop models are shown');
pass('performance, resource and feature fields are shown; features read OFF at 0 and ON with a count');

// ---- 5. statuses ----
assert(!/STATUS/.test(el.textContent), 'no status section by default');
Hud.setDebugStatuses([{ label: 'Speed boost', value: 'ON' }, { label: 'Portal key', value: 'ACTIVE' }]);
assert(/STATUS\nSpeed boost\s+ON\nPortal key\s+ACTIVE/.test(el.textContent), 'status lines shown at once:\n' + el.textContent);
Hud.setDebugStatuses([{ label: '', value: 'x' }, null, { value: 'y' }, { label: 'A'.repeat(100), value: 7 }, { label: 'n', value: null }]);
assert(/A{32}\s+7/.test(el.textContent) && !/A{33}/.test(el.textContent), 'labels are capped and values stringified');
assert(!/\sx\n|\sy\n/.test(el.textContent), 'entries without a label are dropped');
Hud.setDebugStatuses(Array.from({ length: 50 }, (_, i) => ({ label: 'L' + i, value: i })));
assert(el.textContent.split('\n').filter((l) => /^L\d+/.test(l)).length === 20, 'capped at 20 entries');
Hud.setDebugStatuses([]);
assert(!/STATUS/.test(el.textContent), 'an empty list hides the section');
Hud.setDebugStatuses('nope'); assert(!/STATUS/.test(el.textContent), 'a non-array clears it');
// kept while hidden, shown on the next open
Hud.hide(); Hud.setDebugStatuses([{ label: 'Buff', value: 'ON' }]); Hud.show();
assert(/Buff\s+ON/.test(body.children[0].textContent), 'statuses set while hidden appear when shown');
Hud.setDebugStatuses([]);
pass('statuses are sanitised and capped, shown in their own section, and the section is hidden when empty');

// ---- 6. robustness ----
const none = { r: null };
Hud.install({ getRenderer: () => none.r });
tick(); assert(/no 3D world is loaded/.test(body.children[0].textContent));
none.r = {}; tick(); assert(/no 3D world is loaded/.test(body.children[0].textContent));
none.r = { getDebugInfo: () => { throw new Error('boom'); } }; tick(); assert(/no 3D world is loaded/.test(body.children[0].textContent));
Hud.uninstall();
assert.strictEqual(body.children.length, 0); assert.strictEqual(timers.size, 0); assert.strictEqual((listeners.keydown || []).length, 0, 'uninstall removes the key listener');
pass('a missing or failing renderer never throws; uninstall removes everything');

console.log('\nALL ' + checks + ' HUD UNIT CHECKS PASSED');
