// Domain Atlas — gltf-mini (a "gltf-mini-v1" world renderer)
//
// A small, purpose-built GLB loader + WebGL1 renderer, hand-rolled instead
// of using Three.js. Not a design preference — this project vendors zero
// external libraries into the extension (see viewer.js's header comment),
// and this sandbox's own network policy blocks fetching one anyway. So:
// write exactly enough of the glTF 2.0 spec to load Kenney's furniture-kit
// GLBs, which turn out to be a genuinely narrow subset — no textures, no
// skinning, no animation, no interleaved buffers, no sparse accessors,
// OPAQUE materials only (confirmed by inspecting the actual files). A
// general-purpose glTF loader would be a much bigger undertaking; this one
// only needs to be correct for that subset, not for glTF as a whole.
//
// Exposes window.MiniGLTF — one entry point, init(canvas, sceneUrl, world,
// origin, callbacks), used by viewer.js exactly the way the old canvas
// renderer's render loop was used, so the rest of the app (portals, wallet,
// manifest fetching) doesn't need to know or care which renderer is active
// for a given world.

(function () {
  'use strict';

  // ---------- tiny math (mat4 column-major, vec3, quat) ----------

  function mat4Identity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }

  function mat4Multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function mat4FromTRS(t, q, s) {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = s[0], sy = s[1], sz = s[2];
    const out = new Float32Array(16);
    out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
    out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
    out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
    out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
    return out;
  }

  function mat4Translate(x, y, z) {
    const m = mat4Identity();
    m[12] = x; m[13] = y; m[14] = z;
    return m;
  }

  function mat4RotateY(rad) {
    const c = Math.cos(rad), s = Math.sin(rad);
    return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
  }

  function mat4Scale(s) {
    const m = mat4Identity();
    m[0] = s; m[5] = s; m[10] = s;
    return m;
  }

  function mat4Perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const out = new Float32Array(16);
    out[0] = f / aspect; out[5] = f;
    out[10] = (far + near) / (near - far); out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }

  // View matrix for a camera at `eye` looking along yaw (around Y) / pitch (around X).
  function mat4View(eye, yaw, pitch) {
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    // Forward vector the camera looks along.
    const fwd = [sinY * cosP, sinP, -cosY * cosP];
    const upHint = [0, 1, 0];
    const right = normalize(cross(fwd, upHint));
    const up = normalize(cross(right, fwd));
    // Rotation part is the transpose of [right, up, -fwd] (orthonormal basis),
    // translation part is -R * eye — the standard lookAt construction.
    const out = new Float32Array(16);
    out[0] = right[0]; out[4] = right[1]; out[8] = right[2];
    out[1] = up[0]; out[5] = up[1]; out[9] = up[2];
    out[2] = -fwd[0]; out[6] = -fwd[1]; out[10] = -fwd[2];
    out[15] = 1;
    out[12] = -(right[0] * eye[0] + right[1] * eye[1] + right[2] * eye[2]);
    out[13] = -(up[0] * eye[0] + up[1] * eye[1] + up[2] * eye[2]);
    out[14] = (fwd[0] * eye[0] + fwd[1] * eye[1] + fwd[2] * eye[2]);
    return out;
  }

  function mat3NormalFromMat4(m) {
    // No non-uniform scale in this app's placements, so the upper-left 3x3
    // (rotation part) doubles fine as the normal matrix — skip a full
    // inverse-transpose, it isn't needed for this use case.
    return new Float32Array([m[0],m[1],m[2], m[4],m[5],m[6], m[8],m[9],m[10]]);
  }

  function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
  function normalize(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }

  function hexToRgb(hex) {
    const n = parseInt((hex || '#808080').replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  // ---------- GLB parsing (the narrow subset described above) ----------

  const COMPONENT_TYPES = {
    5120: { array: Int8Array, size: 1 },
    5121: { array: Uint8Array, size: 1 },
    5122: { array: Int16Array, size: 2 },
    5123: { array: Uint16Array, size: 2 },
    5125: { array: Uint32Array, size: 4 },
    5126: { array: Float32Array, size: 4 }
  };
  const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

  function parseGLB(buffer) {
    const dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file (bad magic)');
    const totalLength = dv.getUint32(8, true);
    let offset = 12;
    let json = null, bin = null;
    while (offset < totalLength) {
      const chunkLength = dv.getUint32(offset, true);
      const chunkType = dv.getUint32(offset + 4, true);
      const chunkStart = offset + 8;
      if (chunkType === 0x4e4f534a) { // 'JSON'
        json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, chunkStart, chunkLength)));
      } else if (chunkType === 0x004e4942) { // 'BIN\0'
        bin = buffer.slice(chunkStart, chunkStart + chunkLength);
      }
      offset = chunkStart + chunkLength;
    }
    if (!json) throw new Error('GLB has no JSON chunk');
    return { json, bin };
  }

  function readAccessor(gltf, bin, accessorIndex) {
    const accessor = gltf.accessors[accessorIndex];
    const bufferView = gltf.bufferViews[accessor.bufferView];
    const ctype = COMPONENT_TYPES[accessor.componentType];
    const numComponents = TYPE_COMPONENTS[accessor.type];
    const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
    const count = accessor.count * numComponents;
    // None of the assets this loader targets use interleaved bufferViews
    // (verified against the actual files) so a straight typed-array view
    // over the byte range is safe — no manual stride walking needed.
    return new ctype.array(bin, byteOffset, count);
  }

  // ---------- persistent asset cache (IndexedDB, keyed by URL) ----------
  //
  // GLB models are the one part of a domain-atlas world that can actually be
  // big (a furniture kit runs low-single-digit MB), so unlike the manifest
  // and scene.json — fetched fresh every visit on purpose, since portal and
  // policy changes should apply immediately — these are worth a real local
  // cache. "Real" meaning: not fetch()'s opaque cache: 'force-cache' (which
  // never checks the server again once cached, so an updated model would
  // silently never reach a returning visitor), but an explicit
  // conditional-GET cache we control — store the raw bytes plus the
  // server's Last-Modified, and on every load ask the server "is this still
  // current?" via If-Modified-Since. A 304 skips the download entirely; a
  // 200 means it actually changed, so the cache is replaced. This lives in
  // the extension's own IndexedDB (the viewer iframe is extension-origin,
  // so the cache is shared across every domain visited, not per-site) and
  // degrades to "no cache, always fetch" if IndexedDB is unavailable for
  // any reason — never something this loader should hard-fail over.

  const ASSET_DB_NAME = 'domain-atlas-asset-cache';
  const ASSET_STORE = 'assets';
  let assetDbPromise = null;

  function openAssetDb() {
    if (assetDbPromise) return assetDbPromise;
    assetDbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('indexedDB unavailable'));
      const req = indexedDB.open(ASSET_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(ASSET_STORE, { keyPath: 'url' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    });
    return assetDbPromise;
  }

  async function getCachedAsset(url) {
    try {
      const db = await openAssetDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(ASSET_STORE, 'readonly');
        const req = tx.objectStore(ASSET_STORE).get(url);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      return null; // no cache — every load just behaves like a fresh fetch
    }
  }

  async function putCachedAsset(url, buffer, lastModified) {
    try {
      const db = await openAssetDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(ASSET_STORE, 'readwrite');
        tx.objectStore(ASSET_STORE).put({ url, buffer, lastModified, cachedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      // Non-fatal — the model still rendered from the fetch that just
      // happened; it just won't be cached for next time.
    }
  }

  async function fetchModelBuffer(url) {
    const cached = await getCachedAsset(url);
    const headers = cached && cached.lastModified ? { 'If-Modified-Since': cached.lastModified } : {};
    let res;
    try {
      // cache: 'no-store' bypasses the browser's own opaque HTTP cache so
      // this conditional check is the only thing deciding freshness — no
      // second, invisible caching layer second-guessing it.
      res = await fetch(url, { cache: 'no-store', headers });
    } catch (networkErr) {
      if (cached) return cached.buffer; // offline/unreachable — stale beats broken
      throw networkErr;
    }
    if (res.status === 304 && cached) return cached.buffer;
    if (!res.ok) throw new Error('Could not fetch model: ' + url);
    const buffer = await res.arrayBuffer();
    const lastModified = res.headers.get('Last-Modified');
    if (lastModified) putCachedAsset(url, buffer, lastModified); // fire-and-forget
    return buffer;
  }

  // ---------- model loading (cached by URL) ----------

  const modelCache = new Map(); // url -> Promise<parsedModel>

  function loadModel(gl, url) {
    if (modelCache.has(url)) return modelCache.get(url);
    const promise = fetchModelBuffer(url)
      .then((buffer) => {
        const { json: gltf, bin } = parseGLB(buffer);
        const primitives = [];
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];

        function materialColor(materialIndex) {
          if (materialIndex === undefined) return [0.7, 0.7, 0.7, 1];
          const mat = gltf.materials[materialIndex];
          return (mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor) || [0.7, 0.7, 0.7, 1];
        }

        function walkNode(nodeIndex, parentMatrix) {
          const node = gltf.nodes[nodeIndex];
          const t = node.translation || [0, 0, 0];
          const q = node.rotation || [0, 0, 0, 1];
          const s = node.scale || [1, 1, 1];
          const local = mat4FromTRS(t, q, s);
          const world = mat4Multiply(parentMatrix, local);

          if (node.mesh !== undefined) {
            const mesh = gltf.meshes[node.mesh];
            mesh.primitives.forEach((prim) => {
              const positions = readAccessor(gltf, bin, prim.attributes.POSITION);
              const normals = prim.attributes.NORMAL !== undefined ? readAccessor(gltf, bin, prim.attributes.NORMAL) : null;
              const indices = prim.indices !== undefined ? readAccessor(gltf, bin, prim.indices) : null;
              const posAccessor = gltf.accessors[prim.attributes.POSITION];
              if (posAccessor.min && posAccessor.max) {
                // Bounding box in model space, transformed by this node's
                // world matrix — approximate by transforming all 8 corners.
                for (let cx = 0; cx < 2; cx++) for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 2; cz++) {
                  const corner = [
                    cx ? posAccessor.max[0] : posAccessor.min[0],
                    cy ? posAccessor.max[1] : posAccessor.min[1],
                    cz ? posAccessor.max[2] : posAccessor.min[2]
                  ];
                  const wx = world[0]*corner[0] + world[4]*corner[1] + world[8]*corner[2] + world[12];
                  const wy = world[1]*corner[0] + world[5]*corner[1] + world[9]*corner[2] + world[13];
                  const wz = world[2]*corner[0] + world[6]*corner[1] + world[10]*corner[2] + world[14];
                  min[0] = Math.min(min[0], wx); max[0] = Math.max(max[0], wx);
                  min[1] = Math.min(min[1], wy); max[1] = Math.max(max[1], wy);
                  min[2] = Math.min(min[2], wz); max[2] = Math.max(max[2], wz);
                }
              }
              primitives.push({
                positions, normals, indices,
                color: materialColor(prim.material),
                nodeMatrix: world
              });
            });
          }
          (node.children || []).forEach((childIndex) => walkNode(childIndex, world));
        }

        const sceneIndex = gltf.scene || 0;
        const rootNodes = (gltf.scenes && gltf.scenes[sceneIndex] && gltf.scenes[sceneIndex].nodes) || [];
        rootNodes.forEach((n) => walkNode(n, mat4Identity()));

        // Upload each primitive's geometry to the GPU once; instances at
        // different placements in the scene reuse these same buffers.
        primitives.forEach((prim) => {
          prim.vao = {
            positionBuffer: createBuffer(gl, gl.ARRAY_BUFFER, prim.positions),
            normalBuffer: prim.normals ? createBuffer(gl, gl.ARRAY_BUFFER, prim.normals) : null,
            indexBuffer: prim.indices ? createBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, prim.indices) : null,
            indexCount: prim.indices ? prim.indices.length : (prim.positions.length / 3),
            indexType: prim.indices ? (prim.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT) : null
          };
        });

        return {
          primitives,
          bounds: { min, max, size: [max[0]-min[0], max[1]-min[1], max[2]-min[2]] }
        };
      });
    modelCache.set(url, promise);
    return promise;
  }

  function createBuffer(gl, target, typedArray) {
    const buf = gl.createBuffer();
    gl.bindBuffer(target, buf);
    gl.bufferData(target, typedArray, gl.STATIC_DRAW);
    return buf;
  }

  // ---------- shader ----------

  const VERTEX_SRC = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    uniform mat4 uModel;
    uniform mat4 uView;
    uniform mat4 uProjection;
    uniform mat3 uNormalMatrix;
    varying vec3 vNormal;
    void main() {
      vNormal = uNormalMatrix * aNormal;
      gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
    }
  `;
  const FRAGMENT_SRC = `
    precision mediump float;
    varying vec3 vNormal;
    uniform vec4 uColor;
    uniform vec3 uLightDir;
    uniform float uAmbient;
    void main() {
      vec3 n = normalize(vNormal);
      float diffuse = max(dot(n, -normalize(uLightDir)), 0.0);
      float light = clamp(uAmbient + diffuse * (1.0 - uAmbient), 0.0, 1.0);
      gl_FragColor = vec4(uColor.rgb * light, uColor.a);
    }
  `;

  function compileShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile failed: ' + info);
    }
    return shader;
  }

  function createProgram(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(program));
    }
    return {
      program,
      attribs: { position: gl.getAttribLocation(program, 'aPosition'), normal: gl.getAttribLocation(program, 'aNormal') },
      uniforms: {
        model: gl.getUniformLocation(program, 'uModel'),
        view: gl.getUniformLocation(program, 'uView'),
        projection: gl.getUniformLocation(program, 'uProjection'),
        normalMatrix: gl.getUniformLocation(program, 'uNormalMatrix'),
        color: gl.getUniformLocation(program, 'uColor'),
        lightDir: gl.getUniformLocation(program, 'uLightDir'),
        ambient: gl.getUniformLocation(program, 'uAmbient')
      }
    };
  }

  // ---------- floor (procedural quad — not a glb, just two triangles) ----------

  function buildFloor(gl, size, color) {
    const hw = size[0] / 2, hd = size[1] / 2;
    const positions = new Float32Array([
      -hw, 0, -hd,  hw, 0, -hd,  hw, 0, hd,
      -hw, 0, -hd,  hw, 0, hd,  -hw, 0, hd
    ]);
    const normals = new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0]);
    const [r, g, b] = hexToRgb(color);
    return {
      color: [r, g, b, 1],
      modelMatrix: mat4Identity(),
      vao: {
        positionBuffer: createBuffer(gl, gl.ARRAY_BUFFER, positions),
        normalBuffer: createBuffer(gl, gl.ARRAY_BUFFER, normals),
        indexBuffer: null,
        indexCount: 6,
        indexType: null
      }
    };
  }

  // A small glowing ring to mark a portal's location, generated as a flat
  // ring of triangles — same "no external asset needed" spirit as the floor.
  function buildPortalRing(gl, radius, segments, isCrossDomain) {
    const positions = [];
    const normals = [];
    const inner = radius * 0.82;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p = (a, r) => [Math.cos(a) * r, 0.02, Math.sin(a) * r];
      const verts = [p(a0, inner), p(a0, radius), p(a1, radius), p(a0, inner), p(a1, radius), p(a1, inner)];
      verts.forEach((v) => { positions.push(...v); normals.push(0, 1, 0); });
    }
    const color = isCrossDomain ? [0.34, 0.65, 0.58, 1] : [0.88, 0.54, 0.30, 1];
    return {
      color,
      modelMatrix: mat4Identity(),
      vao: {
        positionBuffer: createBuffer(gl, gl.ARRAY_BUFFER, new Float32Array(positions)),
        normalBuffer: createBuffer(gl, gl.ARRAY_BUFFER, new Float32Array(normals)),
        indexBuffer: null,
        indexCount: positions.length / 3,
        indexType: null
      }
    };
  }

  // A floor ring alone is easy to miss: from typical eye height (~1.6)
  // it's a thin sliver low in frame, and it disappears entirely once
  // something (furniture, a doorway, just distance) sits between the
  // camera and the floor at that spot. This adds a second piece — two
  // perpendicular vertical quads through the same center point, the
  // classic "billboard cross" trick — so there's always a tall, roughly
  // person-height glow to catch the eye from across the room, not just a
  // floor decal you have to be looking almost straight down at.
  function buildPortalBeacon(gl, radius, isCrossDomain) {
    const positions = [];
    const normals = [];
    const h = 2.0; // tall enough to read over most furniture, well above eye height
    const w = Math.max(radius, 0.5);
    const quad = (nx, nz) => {
      const verts = [
        [-w * nz, 0, -w * nx], [w * nz, 0, w * nx], [w * nz, h, w * nx],
        [-w * nz, 0, -w * nx], [w * nz, h, w * nx], [-w * nz, h, -w * nx]
      ];
      verts.forEach((v) => { positions.push(...v); normals.push(nx, 0, nz); });
    };
    quad(1, 0);
    quad(0, 1);
    // No alpha blending is enabled anywhere in this renderer (see the
    // "not culling backfaces" note above for the same simplicity
    // tradeoff), so this draws fully opaque regardless of alpha — the
    // color is intentionally a bit dimmer than the floor ring's so a
    // solid vertical cross doesn't read as a wall.
    const color = isCrossDomain ? [0.30, 0.56, 0.50, 1] : [0.76, 0.47, 0.27, 1];
    return {
      color,
      modelMatrix: mat4Identity(),
      vao: {
        positionBuffer: createBuffer(gl, gl.ARRAY_BUFFER, new Float32Array(positions)),
        normalBuffer: createBuffer(gl, gl.ARRAY_BUFFER, new Float32Array(normals)),
        indexBuffer: null,
        indexCount: positions.length / 3,
        indexType: null
      }
    };
  }

  // ---------- public entry point ----------

  function init(canvas, opts) {
    const gl = canvas.getContext('webgl', { antialias: true }) || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL is not available in this browser.');
    // Kenney's GLBs use 32-bit (UNSIGNED_INT) indices — plain WebGL1 only
    // guarantees 16-bit index buffers for drawElements without this
    // extension. It's been universally supported for well over a decade,
    // but fail with a clear message rather than a cryptic INVALID_ENUM if
    // it's ever somehow missing.
    if (!gl.getExtension('OES_element_index_uint')) {
      throw new Error('This browser\'s WebGL is missing OES_element_index_uint, needed to load these models.');
    }
    const prog = createProgram(gl);
    gl.enable(gl.DEPTH_TEST);
    // Deliberately NOT culling backfaces: the procedural floor quad's
    // winding didn't match Kenney's model winding, and rather than chase
    // that per-mesh across 140 varied files, just pay the (tiny, for a
    // scene this size) overdraw cost and never have invisible geometry.
    gl.clearColor(0.055, 0.086, 0.106, 1); // matches the app's dark background

    let sceneData = opts.sceneData;
    let placedPrimitives = [];
    let floorPrim = null;
    let portalTriggers = []; // [{position:[x,z], radius, portalIndex, ring}]
    let boundingBoxes = []; // [{min:[x,z], max:[x,z]}] for simple collision

    const camera = {
      pos: (sceneData.camera && sceneData.camera.start) ? sceneData.camera.start.slice() : [0, 1.6, 4],
      yaw: ((sceneData.camera && sceneData.camera.startYaw) || 0) * Math.PI / 180,
      pitch: 0
    };

    const keys = {};
    let dragging = false, lastX = 0, lastY = 0;
    let portalCooldown = new Set();

    function onKeyDown(e) { keys[e.code] = true; }
    function onKeyUp(e) { keys[e.code] = false; }
    function onPointerDown(e) { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); }
    function onPointerUp(e) { dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch (err) {} }
    function onPointerMove(e) {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      camera.yaw += dx * 0.006;
      camera.pitch = Math.max(-1.3, Math.min(1.3, camera.pitch - dy * 0.006));
    }
    // onPointerDown doesn't check e.button, so a right-click-drag already
    // rotates the camera same as a left-click-drag (a natural instinct
    // coming from other 3D apps) — but without this, the browser's native
    // right-click context menu pops up on release and eats the drag, so it
    // never felt like it worked. Only suppressing it on the canvas itself,
    // not the whole page.
    function onContextMenu(e) { e.preventDefault(); }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('contextmenu', onContextMenu);

    async function loadScene(newSceneData) {
      sceneData = newSceneData;
      placedPrimitives = [];
      boundingBoxes = [];
      const floor = sceneData.floor || { size: [10, 10], color: '#1b2830' };
      floorPrim = buildFloor(gl, floor.size, floor.color);

      const objects = sceneData.objects || [];
      const loaded = await Promise.all(objects.map((obj) => loadModel(gl, opts.resolveAssetUrl(obj.model))));
      objects.forEach((obj, i) => {
        const model = loaded[i];
        const rotY = ((obj.rotationY || 0) * Math.PI) / 180;
        const scale = obj.scale || 1;
        const placement = mat4Multiply(mat4Translate(obj.position[0], obj.position[1] || 0, obj.position[2]), mat4Multiply(mat4RotateY(rotY), mat4Scale(scale)));
        model.primitives.forEach((prim) => {
          placedPrimitives.push({
            vao: prim.vao,
            color: prim.color,
            modelMatrix: mat4Multiply(placement, prim.nodeMatrix)
          });
        });
        // Bounding box for collision, in XZ, expanded from the model's own
        // bounds and roughly re-centered at the placement (good enough —
        // furniture is placed axis-aligned-ish and this only needs to feel
        // right, not be exact).
        const b = model.bounds;
        if (isFinite(b.min[0])) {
          const cx = obj.position[0], cz = obj.position[2];
          const hx = (b.size[0] * scale) / 2, hz = (b.size[2] * scale) / 2;
          boundingBoxes.push({ min: [cx - hx, cz - hz], max: [cx + hx, cz + hz] });
        }
      });

      portalTriggers = (sceneData.portalMarkers || []).map((m) => {
        const isCrossDomain = opts.isCrossDomainPortal(m.portalIndex);
        // buildPortalRing/buildPortalBeacon both generate geometry centered
        // on the local origin — this translate is what actually places
        // them at the marker's configured position. Without it (this was
        // missing entirely before), both would silently render at world
        // (0,0,0) no matter what portalMarkers said, while the proximity
        // trigger below still correctly used the real position — so the
        // visible marker and the actual walk-in trigger zone could be
        // nowhere near each other.
        const placement = mat4Translate(m.position[0], m.position[1] || 0, m.position[2]);
        const ring = buildPortalRing(gl, m.radius || 1.2, 24, isCrossDomain);
        const beacon = buildPortalBeacon(gl, m.radius || 1.2, isCrossDomain);
        ring.modelMatrix = placement;
        beacon.modelMatrix = placement;
        return { position: m.position, radius: m.radius || 1.2, portalIndex: m.portalIndex, ring, beacon };
      });
      portalCooldown = new Set();
    }

    function resize() {
      const displayWidth = canvas.clientWidth, displayHeight = canvas.clientHeight;
      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
      }
    }

    function bindAndDraw(prim, view, projection) {
      gl.bindBuffer(gl.ARRAY_BUFFER, prim.vao.positionBuffer);
      gl.enableVertexAttribArray(prog.attribs.position);
      gl.vertexAttribPointer(prog.attribs.position, 3, gl.FLOAT, false, 0, 0);

      if (prim.vao.normalBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, prim.vao.normalBuffer);
        gl.enableVertexAttribArray(prog.attribs.normal);
        gl.vertexAttribPointer(prog.attribs.normal, 3, gl.FLOAT, false, 0, 0);
      } else {
        gl.disableVertexAttribArray(prog.attribs.normal);
        gl.vertexAttrib3f(prog.attribs.normal, 0, 1, 0);
      }

      gl.uniformMatrix4fv(prog.uniforms.model, false, prim.modelMatrix);
      gl.uniformMatrix3fv(prog.uniforms.normalMatrix, false, mat3NormalFromMat4(prim.modelMatrix));
      gl.uniform4fv(prog.uniforms.color, prim.color);

      if (prim.vao.indexBuffer) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, prim.vao.indexBuffer);
        gl.drawElements(gl.TRIANGLES, prim.vao.indexCount, prim.vao.indexType, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, prim.vao.indexCount);
      }
    }

    function tryMove(dx, dz) {
      const next = [camera.pos[0] + dx, camera.pos[2] + dz];
      const PLAYER_RADIUS = 0.3;
      for (const box of boundingBoxes) {
        if (next[0] + PLAYER_RADIUS > box.min[0] && next[0] - PLAYER_RADIUS < box.max[0] &&
            next[1] + PLAYER_RADIUS > box.min[1] && next[1] - PLAYER_RADIUS < box.max[1]) {
          return false;
        }
      }
      camera.pos[0] = next[0];
      camera.pos[2] = next[1];
      return true;
    }

    let lastT = performance.now();
    let rafId = null;
    function frame(t) {
      const dt = Math.min(0.1, (t - lastT) / 1000);
      lastT = t;
      resize();

      const speed = (keys['ShiftLeft'] || keys['ShiftRight']) ? 4.5 : 2.4;
      const forward = [Math.sin(camera.yaw), -Math.cos(camera.yaw)];
      const right = [Math.cos(camera.yaw), Math.sin(camera.yaw)];
      let mx = 0, mz = 0;
      if (keys['KeyW'] || keys['ArrowUp']) { mx += forward[0]; mz += forward[1]; }
      if (keys['KeyS'] || keys['ArrowDown']) { mx -= forward[0]; mz -= forward[1]; }
      if (keys['KeyD'] || keys['ArrowRight']) { mx += right[0]; mz += right[1]; }
      if (keys['KeyA'] || keys['ArrowLeft']) { mx -= right[0]; mz -= right[1]; }
      const mlen = Math.hypot(mx, mz);
      if (mlen > 0.0001) {
        mx = (mx / mlen) * speed * dt;
        mz = (mz / mlen) * speed * dt;
        // Try each axis independently so movement "slides" along an
        // obstacle instead of stopping dead the moment either axis collides.
        tryMove(mx, 0);
        tryMove(0, mz);
      }

      // Portal proximity check (planar distance, camera Y ignored).
      portalTriggers.forEach((trigger, idx) => {
        const dx = camera.pos[0] - trigger.position[0];
        const dz = camera.pos[2] - trigger.position[2];
        const dist = Math.hypot(dx, dz);
        if (dist < trigger.radius) {
          if (!portalCooldown.has(idx)) {
            portalCooldown.add(idx);
            opts.onPortalEnter(trigger.portalIndex);
          }
        } else {
          portalCooldown.delete(idx);
        }
      });

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog.program);

      const aspect = canvas.width / Math.max(1, canvas.height);
      const projection = mat4Perspective(Math.PI / 3, aspect, 0.05, 100);
      const view = mat4View(camera.pos, camera.yaw, camera.pitch);
      gl.uniformMatrix4fv(prog.uniforms.projection, false, projection);
      gl.uniformMatrix4fv(prog.uniforms.view, false, view);
      const light = (sceneData.directionalLight && sceneData.directionalLight.direction) || [-0.4, -1, -0.3];
      gl.uniform3fv(prog.uniforms.lightDir, light);
      gl.uniform1f(prog.uniforms.ambient, (sceneData.ambientLight && sceneData.ambientLight.intensity) || 0.55);

      if (floorPrim) bindAndDraw(floorPrim, view, projection);
      portalTriggers.forEach((tr) => { bindAndDraw(tr.ring, view, projection); bindAndDraw(tr.beacon, view, projection); });
      placedPrimitives.forEach((prim) => bindAndDraw(prim, view, projection));

      rafId = requestAnimationFrame(frame);
    }

    function start() { if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(frame); } }
    function stop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
    function destroy() {
      stop();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('contextmenu', onContextMenu);
    }

    const ready = loadScene(sceneData).then(() => start());
    return { ready, loadScene: (s) => loadScene(s), stop, start, destroy, camera };
  }

  // ---------- cache management API (Settings -> Cache) ----------
  //
  // Everything above this manages the cache from the inside, keyed by URL.
  // This is the outside view viewer.js's Settings screen uses: grouped by
  // origin ("site" — this cache is shared extension-wide, not per-domain,
  // so origin is the closest thing to "site" it actually has), with real
  // byte totals, clear-by-site, and a JSON export/import round-trip.
  // IndexedDB can hold an ArrayBuffer directly, but JSON can't, so
  // export/import is the one place this cache touches base64 at all.

  async function getAllCachedAssets() {
    try {
      const db = await openAssetDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(ASSET_STORE, 'readonly');
        const req = tx.objectStore(ASSET_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      return [];
    }
  }

  function originOf(url) {
    try { return new URL(url).origin; } catch (err) { return 'unknown'; }
  }

  async function listCacheBySite() {
    const all = await getAllCachedAssets();
    const bySite = new Map(); // origin -> { origin, bytes, count }
    for (const entry of all) {
      const origin = originOf(entry.url);
      const stat = bySite.get(origin) || { origin, bytes: 0, count: 0 };
      stat.bytes += entry.buffer.byteLength;
      stat.count += 1;
      bySite.set(origin, stat);
    }
    return [...bySite.values()].sort((a, b) => b.bytes - a.bytes);
  }

  async function cacheTotalBytes() {
    const all = await getAllCachedAssets();
    return all.reduce((sum, e) => sum + e.buffer.byteLength, 0);
  }

  async function clearCacheSite(origin) {
    const db = await openAssetDb();
    const all = await getAllCachedAssets();
    const urlsToDelete = all.filter((e) => originOf(e.url) === origin).map((e) => e.url);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ASSET_STORE, 'readwrite');
      urlsToDelete.forEach((url) => tx.objectStore(ASSET_STORE).delete(url));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearAllCache() {
    const db = await openAssetDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ASSET_STORE, 'readwrite');
      tx.objectStore(ASSET_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000; // avoid one giant String.fromCharCode(...bytes) call
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function base64ToBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function exportCache() {
    const all = await getAllCachedAssets();
    return {
      format: 'domain-atlas-asset-cache/1.0',
      exportedAt: new Date().toISOString(),
      entries: all.map((e) => ({ url: e.url, lastModified: e.lastModified, cachedAt: e.cachedAt, bytesBase64: bufferToBase64(e.buffer) }))
    };
  }

  async function importCache(data) {
    if (!data || !Array.isArray(data.entries)) throw new Error('Not a domain-atlas-asset-cache export');
    let imported = 0;
    for (const entry of data.entries) {
      if (!entry.url || !entry.bytesBase64) continue;
      await putCachedAsset(entry.url, base64ToBuffer(entry.bytesBase64), entry.lastModified);
      imported++;
    }
    return { imported };
  }

  window.MiniGLTF = {
    init,
    cache: {
      listBySite: listCacheBySite,
      totalBytes: cacheTotalBytes,
      clearSite: clearCacheSite,
      clearAll: clearAllCache,
      exportAll: exportCache,
      importAll: importCache
    }
  };
})();
