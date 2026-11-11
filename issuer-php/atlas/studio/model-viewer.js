'use strict';
// Asset Studio 3D viewer: a small GLB reader and WebGL1 renderer for the Studio's own models (triangle meshes with
// positions, normals and a base colour per material). No external library. The surface is lit from a procedural
// studio environment, so metal reads as metal without any image or texture, and the finish recolours the accent
// material of the model.
//
//   const viewer = AtlasModelViewer.create(canvas);   // null when WebGL is unavailable
//   await viewer.load('/assets/studio/badge.glb', { standUp: true });   // stand a flat model on its edge
//   viewer.setFinish('gold' | 'silver' | 'bronze');
//   viewer.setTint('#rrggbb' | null);   // recolour the accent material with the creator's chosen colour
//   viewer.setAutoRotate(true); viewer.resetView();
//
// Drag to rotate, wheel or pinch to zoom, arrow keys and + / - when the canvas has focus.
(function () {
  const FINISHES = {
    gold: { color: [1.0, 0.72, 0.18], metal: 1, rough: 0.28 },
    silver: { color: [0.86, 0.89, 0.93], metal: 1, rough: 0.24 },
    bronze: { color: [0.80, 0.47, 0.25], metal: 1, rough: 0.34 }
  };
  // The models paint their accent in this yellow; any material near it takes the finish colour.
  const ACCENT = [0.95, 0.78, 0.25];
  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.12;

  // ---- small maths (column-major mat4) ----
  const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  function multiply(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = 2 * far * near / (near - far);
    return o;
  }
  function lookAt(eye, target) {
    const z = norm(sub(eye, target)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  function fromTRS(t, q, s) {
    const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    return new Float32Array([(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
      (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
      (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1]);
  }
  const rotateY = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); };
  const translate = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  const rotateX = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); };
  const transformPoint = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  const transformDir = (m, p) => norm([m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]]);

  // ---- GLB: only what the Studio models use (float POSITION and NORMAL, optional indices, baseColorFactor) ----
  const COMPONENTS = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
  const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  function readAccessor(json, bin, index) {
    const acc = json.accessors[index], view = json.bufferViews[acc.bufferView];
    const [Type, size] = COMPONENTS[acc.componentType], width = WIDTH[acc.type];
    const stride = view.byteStride || size * width, start = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const out = new Float32Array(acc.count * width);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const get = { 5126: 'getFloat32', 5125: 'getUint32', 5123: 'getUint16', 5121: 'getUint8', 5122: 'getInt16', 5120: 'getInt8' }[acc.componentType];
    for (let i = 0; i < acc.count; i++) for (let j = 0; j < width; j++) out[i * width + j] = dv[get](start + i * stride + j * size, true);
    return out;
  }
  function parseGLB(buffer) {
    const dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
    let offset = 12, json = null, bin = null;
    while (offset + 8 <= buffer.byteLength) {
      const length = dv.getUint32(offset, true), type = dv.getUint32(offset + 4, true);
      const body = new Uint8Array(buffer, offset + 8, length);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
      else if (type === 0x004e4942 && !bin) bin = body;
      offset += 8 + length + ((4 - (length % 4)) % 4);
    }
    if (!json || !bin) throw new Error('GLB has no JSON or binary chunk');
    const materials = (json.materials || []).map((m) => {
      const p = m.pbrMetallicRoughness || {};
      return { color: (p.baseColorFactor || [1, 1, 1, 1]).slice(0, 3), metal: p.metallicFactor == null ? 1 : p.metallicFactor, rough: p.roughnessFactor == null ? 1 : p.roughnessFactor };
    });
    if (!materials.length) materials.push({ color: [0.8, 0.8, 0.8], metal: 0.2, rough: 0.6 });
    const prims = [];
    const visit = (nodeIndex, parent) => {
      const node = json.nodes[nodeIndex];
      const local = node.matrix ? new Float32Array(node.matrix) : fromTRS(node.translation || [0, 0, 0], node.rotation || [0, 0, 0, 1], node.scale || [1, 1, 1]);
      const world = multiply(parent, local);
      if (node.mesh !== undefined) {
        for (const p of json.meshes[node.mesh].primitives) {
          if (p.mode !== undefined && p.mode !== 4) continue;
          const pos = readAccessor(json, bin, p.attributes.POSITION);
          const nor = p.attributes.NORMAL !== undefined ? readAccessor(json, bin, p.attributes.NORMAL) : null;
          const idx = p.indices !== undefined ? readAccessor(json, bin, p.indices) : null;
          prims.push({ pos, nor, idx, material: p.material || 0, world });
        }
      }
      (node.children || []).forEach((c) => visit(c, world));
    };
    const scene = json.scenes[json.scene || 0];
    scene.nodes.forEach((n) => visit(n, identity()));
    return { prims, materials };
  }

  // ---- shaders ----
  const VERT = `
attribute vec3 aPos; attribute vec3 aNor;
uniform mat4 uModel; uniform mat4 uViewProj;
varying vec3 vNor; varying vec3 vWorld;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz; vNor = mat3(uModel) * aNor;
  gl_Position = uViewProj * w;
}`;
  const FRAG = `
precision highp float;
varying vec3 vNor; varying vec3 vWorld;
uniform vec3 uCam; uniform vec3 uBase; uniform float uMetal; uniform float uRough;
// A studio: dark floor, bright sky gradient, two soft boxes and a cool rim light.
vec3 env(vec3 d, float rough){
  float h = d.y * 0.5 + 0.5;
  vec3 col = mix(vec3(0.05, 0.06, 0.08), vec3(0.86, 0.84, 0.82), smoothstep(0.1, 0.95, h));
  float sharp = mix(90.0, 3.0, rough);
  col += vec3(1.0, 0.96, 0.88) * pow(max(dot(d, normalize(vec3(-0.55, 0.75, 0.55))), 0.0), sharp) * 2.4;
  col += vec3(0.55, 0.72, 1.0) * pow(max(dot(d, normalize(vec3(0.8, 0.35, -0.55))), 0.0), sharp * 0.7) * 1.6;
  col += vec3(1.0, 0.85, 0.7) * pow(max(dot(d, normalize(vec3(0.6, 0.15, 0.8))), 0.0), sharp * 0.5) * 0.7;
  return mix(col, vec3(0.34, 0.4, 0.5), rough * rough * 0.6);
}
void main(){
  vec3 N = normalize(vNor);
  vec3 V = normalize(uCam - vWorld);
  if (dot(N, V) < 0.0) N = -N;
  vec3 R = reflect(-V, N);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec3 f0 = mix(vec3(0.045), uBase, uMetal);
  vec3 fres = f0 + (max(vec3(1.0 - uRough), f0) - f0) * pow(1.0 - ndv, 5.0);
  vec3 diffuse = uBase * (1.0 - uMetal) * (env(N, 1.0) * 0.85 + 0.08);
  vec3 spec = env(R, uRough) * fres * 1.5;
  vec3 L = normalize(vec3(-0.45, 0.8, 0.5));
  float lit = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  spec += vec3(1.0) * pow(max(dot(N, H), 0.0), mix(160.0, 12.0, uRough)) * mix(0.25, 0.9, 1.0 - uRough) * lit;
  vec3 col = diffuse + spec + uBase * lit * 0.12;
  col = col / (col + vec3(0.55));
  col = pow(col * 1.2, vec3(1.0 / 2.0));
  gl_FragColor = vec4(col, 1.0);
}`;
  const SHADOW_VERT = `
attribute vec2 aPos; uniform mat4 uViewProj; uniform vec3 uCenter; uniform float uSize; varying vec2 vUv;
void main(){ vUv = aPos; gl_Position = uViewProj * vec4(uCenter + vec3(aPos.x, 0.0, aPos.y) * uSize, 1.0); }`;
  const SHADOW_FRAG = `
precision mediump float; varying vec2 vUv; uniform float uStrength;
void main(){ float d = length(vUv); float a = smoothstep(1.0, 0.0, d); gl_FragColor = vec4(0.0, 0.0, 0.0, a * a * uStrength); }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram(); gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
    return p;
  }

  function create(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false }) || canvas.getContext('experimental-webgl');
    if (!gl) return null;
    let main, shadow;
    try { main = program(gl, VERT, FRAG); shadow = program(gl, SHADOW_VERT, SHADOW_FRAG); } catch (e) { return null; }
    const loc = {
      aPos: gl.getAttribLocation(main, 'aPos'), aNor: gl.getAttribLocation(main, 'aNor'),
      uModel: gl.getUniformLocation(main, 'uModel'), uViewProj: gl.getUniformLocation(main, 'uViewProj'), uCam: gl.getUniformLocation(main, 'uCam'),
      uBase: gl.getUniformLocation(main, 'uBase'), uMetal: gl.getUniformLocation(main, 'uMetal'), uRough: gl.getUniformLocation(main, 'uRough')
    };
    const sloc = {
      aPos: gl.getAttribLocation(shadow, 'aPos'), uViewProj: gl.getUniformLocation(shadow, 'uViewProj'),
      uCenter: gl.getUniformLocation(shadow, 'uCenter'), uSize: gl.getUniformLocation(shadow, 'uSize'), uStrength: gl.getUniformLocation(shadow, 'uStrength')
    };
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);

    let model = null;          // { draws, floor, radius, centre, float }
    let finish = 'gold';
    let tint = null;           // [r, g, b] 0..1: replaces the accent colour, for items whose colour the creator picks
    const view = { yaw: 0.6, pitch: 0.18, zoom: 1 };
    const goal = { yaw: view.yaw, pitch: view.pitch, zoom: 1 };
    let velocity = 0, autoRotate = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches), interacting = false, lastInput = 0;
    let raf = 0, destroyed = false, t0 = performance.now();

    function materialFor(m) {
      if (near(m.color, ACCENT)) {
        if (tint) return { color: tint, metal: 0.25, rough: 0.55 };
        const f = FINISHES[finish] || FINISHES.gold; return { color: f.color, metal: f.metal, rough: f.rough };
      }
      return { color: m.color, metal: Math.max(m.metal, 0.35), rough: Math.min(m.rough, 0.5) };
    }

    function setModel(parsed, opts) {
      if (model) model.draws.forEach((d) => { gl.deleteBuffer(d.pos); gl.deleteBuffer(d.nor); });
      const tilt = opts && opts.standUp ? rotateX(Math.PI / 2) : identity();
      const draws = [];
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of parsed.prims) {
        const world = multiply(tilt, p.world);
        const count = p.idx ? p.idx.length : p.pos.length / 3;
        const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const v = p.idx ? p.idx[i] : i;
          const q = transformPoint(world, [p.pos[v * 3], p.pos[v * 3 + 1], p.pos[v * 3 + 2]]);
          pos.set(q, i * 3);
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
        }
        // Flat normals when the file has none; otherwise the file's own, rotated with the model.
        for (let i = 0; i < count; i++) {
          let n;
          if (p.nor) { const v = p.idx ? p.idx[i] : i; n = transformDir(world, [p.nor[v * 3], p.nor[v * 3 + 1], p.nor[v * 3 + 2]]); }
          else { const t = i - (i % 3); n = norm(cross(sub([pos[t * 3 + 3], pos[t * 3 + 4], pos[t * 3 + 5]], [pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2]]), sub([pos[t * 3 + 6], pos[t * 3 + 7], pos[t * 3 + 8]], [pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2]]))); }
          nor.set(n, i * 3);
        }
        const pb = gl.createBuffer(), nb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, nor, gl.STATIC_DRAW);
        draws.push({ pos: pb, nor: nb, count, material: parsed.materials[p.material] || parsed.materials[0] });
      }
      const centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
      model = { draws, centre, radius, floor: lo[1], float: !!(opts && opts.standUp) };
      resetView();
    }

    function resetView() { goal.yaw = 0.6; goal.pitch = 0.18; goal.zoom = 1; velocity = 0; }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }

    function frame(now) {
      raf = 0;
      if (destroyed) return;
      if (!document.hidden && model) draw((now - t0) / 1000);
      schedule();
    }
    function schedule() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }

    function draw(t) {
      resize();
      // Easing toward the goal view, spin inertia from a drag, and a slow turn when idle.
      view.zoom += (goal.zoom - view.zoom) * 0.15;
      view.pitch += (goal.pitch - view.pitch) * 0.15;
      if (!interacting) {
        goal.yaw += velocity; velocity *= 0.94;
        if (autoRotate && performance.now() - lastInput > 1800) goal.yaw += 0.006;
      }
      view.yaw += (goal.yaw - view.yaw) * 0.2;

      const aspect = canvas.width / canvas.height, fov = 0.62;
      const fit = model.radius / Math.sin(Math.min(fov, fov * aspect) / 2) * 1.22;
      const dist = fit / view.zoom;
      const bob = model.float ? Math.sin(t * 1.6) * model.radius * 0.035 : 0;
      const target = [model.centre[0], model.centre[1], model.centre[2]];
      const cp = Math.cos(view.pitch);
      const eye = [target[0], target[1] + dist * Math.sin(view.pitch), target[2] + dist * cp];
      const viewProj = multiply(perspective(fov, aspect, dist * 0.05, dist * 8), lookAt(eye, target));
      // The model turns on a turntable about its own centre while the camera and the lights stay put.
      const c = model.centre, ry = rotateY(view.yaw);
      const spin = multiply(translate(c[0], c[1] + bob, c[2]), multiply(ry, translate(-c[0], -c[1], -c[2])));

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // Contact shadow on the floor under the model; it shrinks and fades as the model floats up.
      gl.useProgram(shadow);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(sloc.aPos); gl.vertexAttribPointer(sloc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(sloc.uViewProj, false, viewProj);
      gl.uniform3f(sloc.uCenter, model.centre[0], model.floor - model.radius * 0.04, model.centre[2]);
      gl.uniform1f(sloc.uSize, model.radius * (1.25 - bob / model.radius * 1.5));
      gl.uniform1f(sloc.uStrength, 0.7 - bob / model.radius * 2);
      gl.depthMask(false); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.depthMask(true);
      gl.disableVertexAttribArray(sloc.aPos);

      gl.useProgram(main);
      gl.uniformMatrix4fv(loc.uViewProj, false, viewProj);
      gl.uniform3fv(loc.uCam, new Float32Array(eye));
      gl.uniformMatrix4fv(loc.uModel, false, spin);
      gl.disable(gl.BLEND);
      for (const d of model.draws) {
        const m = materialFor(d.material);
        gl.uniform3fv(loc.uBase, new Float32Array(m.color)); gl.uniform1f(loc.uMetal, m.metal); gl.uniform1f(loc.uRough, m.rough);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.pos); gl.enableVertexAttribArray(loc.aPos); gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.nor); gl.enableVertexAttribArray(loc.aNor); gl.vertexAttribPointer(loc.aNor, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, d.count);
      }
      gl.disableVertexAttribArray(loc.aPos); gl.disableVertexAttribArray(loc.aNor);
    }

    // ---- input ----
    const pointers = new Map();
    let pinch = 0;
    const touch = () => { lastInput = performance.now(); };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      interacting = true; velocity = 0; touch();
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; touch();
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) goal.zoom = Math.min(3, Math.max(0.45, goal.zoom * d / pinch)); pinch = d;
      } else {
        goal.yaw -= dx * 0.01; velocity = -dx * 0.01 * 0.5;
        goal.pitch = Math.min(1.25, Math.max(-0.4, goal.pitch + dy * 0.008));
      }
    });
    const release = (e) => { pointers.delete(e.pointerId); pinch = 0; if (!pointers.size) interacting = false; touch(); };
    canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); touch(); goal.zoom = Math.min(3, Math.max(0.45, goal.zoom * Math.exp(-e.deltaY * 0.0012))); }, { passive: false });
    canvas.addEventListener('keydown', (e) => {
      const k = e.key; touch();
      if (k === 'ArrowLeft') goal.yaw -= 0.18; else if (k === 'ArrowRight') goal.yaw += 0.18;
      else if (k === 'ArrowUp') goal.pitch = Math.min(1.25, goal.pitch + 0.1); else if (k === 'ArrowDown') goal.pitch = Math.max(-0.4, goal.pitch - 0.1);
      else if (k === '+' || k === '=') goal.zoom = Math.min(3, goal.zoom * 1.12); else if (k === '-') goal.zoom = Math.max(0.45, goal.zoom / 1.12);
      else if (k === '0') resetView(); else return;
      e.preventDefault();
    });
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); });
    schedule();

    const cache = new Map();
    return {
      async load(url, opts) {
        let parsed = cache.get(url);
        if (!parsed) {
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok) throw new Error('model ' + res.status);
          parsed = parseGLB(await res.arrayBuffer());
          cache.set(url, parsed);
        }
        setModel(parsed, opts);
      },
      setFinish(name) { if (FINISHES[name]) finish = name; },
      setTint(hex) { const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); tint = m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) : null; },
      setAutoRotate(on) { autoRotate = !!on; lastInput = 0; },
      get autoRotate() { return autoRotate; },
      resetView() { resetView(); lastInput = performance.now(); },
      get ready() { return !!model; },
      destroy() { destroyed = true; if (raf) cancelAnimationFrame(raf); }
    };
  }

  window.AtlasModelViewer = { create };
})();
