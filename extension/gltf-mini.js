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

  // Same construction as mat4RotateY above, just around X instead of Y —
  // this is what swings the player character's arms/legs forward and back
  // (see buildCharacter/the walk-cycle code near the render loop).
  function mat4RotateX(rad) {
    const c = Math.cos(rad), s = Math.sin(rad);
    return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
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

  // onBytes (task #74, optional — every existing caller still works
  // unchanged without it) reports this one URL's download progress as a
  // sequence of events: {status:'cached'} for a 304 or offline-fallback hit
  // (nothing to download, so it never becomes part of a speed/ETA
  // calculation); {status:'downloading', totalBytes} once headers arrive,
  // totalBytes null if the server didn't send Content-Length (a real
  // possibility with compressed responses — callers must treat that as
  // "unknown," not zero); {status:'progress', bytes} per chunk as the body
  // streams in; and {status:'done', bytes} with the exact final byte count
  // once the download completes — the one moment a caller can always learn
  // this URL's true size, even if totalBytes was never known ahead of time.
  async function fetchModelBuffer(url, onBytes) {
    const cached = await getCachedAsset(url);
    const headers = cached && cached.lastModified ? { 'If-Modified-Since': cached.lastModified } : {};
    let res;
    try {
      // cache: 'no-store' bypasses the browser's own opaque HTTP cache so
      // this conditional check is the only thing deciding freshness — no
      // second, invisible caching layer second-guessing it.
      res = await fetch(url, { cache: 'no-store', headers });
    } catch (networkErr) {
      if (cached) { if (onBytes) onBytes({ status: 'cached' }); return cached.buffer; } // offline/unreachable — stale beats broken
      throw networkErr;
    }
    if (res.status === 304 && cached) { if (onBytes) onBytes({ status: 'cached' }); return cached.buffer; }
    if (!res.ok) throw new Error('Could not fetch model: ' + url);

    const contentLengthHeader = res.headers.get('Content-Length');
    const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : null;
    if (onBytes) onBytes({ status: 'downloading', totalBytes: Number.isFinite(totalBytes) ? totalBytes : null });

    let buffer;
    if (res.body && res.body.getReader) {
      // Streamed read, not a single res.arrayBuffer() — the whole point is
      // visibility into progress partway through, which a one-shot read
      // can never give.
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        if (onBytes) onBytes({ status: 'progress', bytes: value.byteLength });
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
      buffer = merged.buffer;
      if (onBytes) onBytes({ status: 'done', bytes: received });
    } else {
      // No streaming reader available in this environment — the download
      // still counts, just reported as one lump at the end instead of live.
      buffer = await res.arrayBuffer();
      if (onBytes) onBytes({ status: 'progress', bytes: buffer.byteLength });
      if (onBytes) onBytes({ status: 'done', bytes: buffer.byteLength });
    }
    const lastModified = res.headers.get('Last-Modified');
    if (lastModified) putCachedAsset(url, buffer, lastModified); // fire-and-forget
    return buffer;
  }

  // ---------- model loading (cached by URL) ----------

  const modelCache = new Map(); // url -> Promise<parsedModel>

  function loadModel(gl, url, onBytes) {
    if (modelCache.has(url)) return modelCache.get(url);
    const promise = fetchModelBuffer(url, onBytes)
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

  // ---------- player character (#33 — a visible avatar, not just a floating
  // camera) ----------
  //
  // Same "no external asset needed" spirit as the floor and portal markers
  // above: a small blocky humanoid built entirely out of boxes, no GLB
  // required (there's no character model in the furniture kit this project
  // ships with — see the header comment for why that kit is what's here at
  // all). Flat-colored boxes read fine at this art style's scale and don't
  // need a "which way is the front" to look right, which conveniently means
  // the character doesn't need to visually face any particular direction —
  // only the arm/leg SWING direction (see the walk-cycle code in init())
  // actually has to line up with travel direction.

  // A single box, built the same non-indexed-triangle-soup way as
  // buildFloor/buildPortalRing above (this renderer never culls backfaces,
  // so winding order doesn't matter here either). yMin/yMax are measured
  // from the box's own local origin, which is what lets a caller decide
  // whether a part hangs below its pivot (arms, legs — yMin negative, yMax
  // 0) or rises above it (torso, head — yMin 0, yMax positive).
  function buildBox(gl, w, yMin, yMax, d, color) {
    const hw = w / 2, hd = d / 2;
    const positions = [];
    const normals = [];
    function quad(v0, v1, v2, v3, n) {
      positions.push(...v0, ...v1, ...v2, ...v0, ...v2, ...v3);
      for (let i = 0; i < 6; i++) normals.push(...n);
    }
    quad([-hw,yMax,-hd], [-hw,yMax,hd], [hw,yMax,hd], [hw,yMax,-hd], [0,1,0]);   // top
    quad([-hw,yMin,hd], [-hw,yMin,-hd], [hw,yMin,-hd], [hw,yMin,hd], [0,-1,0]);  // bottom
    quad([hw,yMin,-hd], [hw,yMax,-hd], [hw,yMax,hd], [hw,yMin,hd], [1,0,0]);     // right
    quad([-hw,yMin,hd], [-hw,yMax,hd], [-hw,yMax,-hd], [-hw,yMin,-hd], [-1,0,0]); // left
    quad([-hw,yMin,hd], [hw,yMin,hd], [hw,yMax,hd], [-hw,yMax,hd], [0,0,1]);     // front
    quad([hw,yMin,-hd], [-hw,yMin,-hd], [-hw,yMax,-hd], [hw,yMax,-hd], [0,0,-1]);// back
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

  // Proportions are eyeballed against the default 1.6 eye height most
  // scenes start the camera at (see camera.pos below): hip+torso+most of
  // the head lands the eyes roughly inside the head box, so at camera
  // distance 0 (see cameraDistance in init()) the camera sits about where
  // a head would be without anything needing to be perfectly to-scale.
  function buildCharacter(gl) {
    const LEG_LEN = 0.85, LEG_W = 0.15, LEG_D = 0.15;
    const TORSO_H = 0.50, TORSO_W = 0.36, TORSO_D = 0.20;
    const HEAD_SIZE = 0.32;
    const ARM_LEN = 0.52, ARM_W = 0.13, ARM_D = 0.13;
    const hipY = LEG_LEN;
    const shoulderY = hipY + TORSO_H;
    const skin = [0.85, 0.68, 0.53, 1];
    const shirt = [0.24, 0.47, 0.40, 1];
    const pants = [0.17, 0.22, 0.26, 1];
    return {
      hipY, shoulderY, headSize: HEAD_SIZE,
      shoulderOffsetX: TORSO_W / 2 + ARM_W / 2 + 0.02,
      hipOffsetX: TORSO_W / 2 - LEG_W / 2 - 0.02,
      torso: buildBox(gl, TORSO_W, 0, TORSO_H, TORSO_D, shirt),
      head: buildBox(gl, HEAD_SIZE, 0, HEAD_SIZE, HEAD_SIZE, skin),
      armL: buildBox(gl, ARM_W, -ARM_LEN, 0, ARM_D, skin),
      armR: buildBox(gl, ARM_W, -ARM_LEN, 0, ARM_D, skin),
      legL: buildBox(gl, LEG_W, -LEG_LEN, 0, LEG_D, pants),
      legR: buildBox(gl, LEG_W, -LEG_LEN, 0, LEG_D, pants)
    };
  }

  // Bounds for the player-character size setting (Settings -> "Player
  // character" -> Size). Kept in sync by eye with the same bounds on the
  // slider itself (extension/viewer.html's #characterScaleInput min/max)
  // and the storage-side clamp in wallet.js's getCharacterScale/
  // setCharacterScale — this is the last line of defense against a
  // corrupt/out-of-range value ever reaching mat4Scale.
  const MIN_CHARACTER_SCALE = 0.5;
  const MAX_CHARACTER_SCALE = 2;
  function clampCharacterScale(s) {
    const n = Number(s);
    if (!Number.isFinite(n)) return 1;
    return Math.max(MIN_CHARACTER_SCALE, Math.min(MAX_CHARACTER_SCALE, n));
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

    // Visible player character (#33) — built once, independent of which
    // scene is loaded (it's a fixed avatar, not scene content).
    const character = buildCharacter(gl);
    let walkPhase = 0;

    // Camera distance (mouse scroll wheel) replaces the old discrete
    // first-/third-person toggle with one continuous zoom: 0 is exactly
    // the original first-person view (camera = eyes, nothing new added to
    // the frustum — bit-for-bit the same as every release before this),
    // and it smoothly pulls back into a third-person chase view as it
    // increases. Always starts at 0 (first-person) on entering a world —
    // deliberately NOT persisted the way the old toggle setting was, since
    // "scroll to zoom" reads as a live camera control, not a saved
    // preference.
    const MAX_CAMERA_DISTANCE = 5;
    const MAX_FOLLOW_HEIGHT = 1.7;
    const CAMERA_SCROLL_STEP = 0.4;
    const HEAD_VISIBLE_DISTANCE = 0.4; // below this, camera is still basically at eye level — drawing the head would just block the view
    let cameraDistance = 0;

    function onWheel(e) {
      e.preventDefault(); // this is a camera control, not a page-scroll gesture
      const dir = e.deltaY > 0 ? 1 : (e.deltaY < 0 ? -1 : 0);
      cameraDistance = Math.max(0, Math.min(MAX_CAMERA_DISTANCE, cameraDistance + dir * CAMERA_SCROLL_STEP));
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    // The character's own facing, separate from camera.yaw (look
    // direction). Turns to face whatever direction is actually being
    // walked in (see the movement block in frame()) and simply holds its
    // last facing while standing still — deliberately NOT tied to
    // camera.yaw, or strafing (A/D with the mouse untouched) would slide
    // the character sideways without ever turning to face the way it's
    // moving, and the walk-cycle leg swing (a fixed forward/back motion in
    // the character's own local frame) would look like moonwalking.
    let characterYaw = camera.yaw;
    let lastCharBase = mat4Identity(); // see the comment where this gets set, in frame()
    // Stashed the same way as lastCharBase, for the same reason — see
    // getCharacterFloorY() in the returned API below for what this is for
    // (broadcasting a FLOOR-relative height over presence, not the
    // camera's eye height).
    let lastCharacterBaseY = 0;
    // Purely a visual size preference (Settings -> "Player character" ->
    // Size) — doesn't touch collision (PLAYER_RADIUS, below, stays fixed),
    // walk speed, or how far the camera follows; it only scales the
    // rendered mesh in charBase.
    let characterScale = clampCharacterScale(opts.characterScale);

    // Other visitors currently in this same world (#66) — viewer.js owns
    // the actual presence WebSocket connection and message protocol; this
    // file only knows how to render whatever roster it's told about via
    // upsertRemotePlayer/removeRemotePlayer below. Purely visual: no
    // collision, no interaction, and always drawn at the DEFAULT scale (1)
    // regardless of this viewer's own characterScale — that slider is a
    // personal preference about how YOUR OWN character looks, not
    // something meaningful to apply to someone else's model.
    const remotePlayers = new Map(); // id -> { x,y,z,yaw (rendered/interpolated), tx,ty,tz,tyaw (last network target), walkPhase }
    const REMOTE_LERP_RATE = 10; // higher = snaps to the network position faster, lower = smoother but laggier
    function lerpAngle(a, b, t) {
      // Shortest-path angular interpolation — a plain (a + (b-a)*t) lerp
      // would spin the long way around every time a remote player's yaw
      // crosses the -pi/pi wraparound, which happens constantly for
      // perfectly ordinary turning.
      const diff = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      return a + diff * t;
    }

    const keys = {};
    let dragging = false, lastX = 0, lastY = 0;
    let portalCooldown = new Set();

    // Held mouse buttons, tracked separately from the pointerdown/up drag
    // handling below — mousedown/mouseup (unlike pointerdown/up, which only
    // fire on the FIRST button down / LAST button up for a mouse) fire once
    // per individual button, so this is what actually lets "both left and
    // right held together" be detected as its own chord, regardless of
    // whether the player is also drag-looking.
    const heldMouseButtons = new Set();
    function onMouseDown(e) { heldMouseButtons.add(e.button); }
    function onMouseUp(e) { heldMouseButtons.delete(e.button); }

    // Jump/crouch are purely a camera-height effect layered on top of the
    // standing eye height captured here — collision is XZ-only (see
    // tryMove/boundingBoxes) and portal triggers only look at X/Z too, so
    // neither needs to know about this; it's just what the camera shows.
    const standingEyeY = camera.pos[1];
    let jumpOffset = 0, jumpVelocity = 0, airborne = false;
    const JUMP_SPEED = 3.2, GRAVITY = 9.0, CROUCH_AMOUNT = 0.6;

    function onKeyDown(e) {
      // Space scrolling the host page would be a strange side effect of
      // jumping — nothing here is meant to scroll, so stop that specific
      // default without touching any other key's normal behavior.
      if (e.code === 'Space') e.preventDefault();
      keys[e.code] = true;
    }
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
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);

    async function loadScene(newSceneData) {
      sceneData = newSceneData;
      placedPrimitives = [];
      boundingBoxes = [];
      const floor = sceneData.floor || { size: [10, 10], color: '#1b2830' };
      floorPrim = buildFloor(gl, floor.size, floor.color);

      const objects = sceneData.objects || [];
      const urls = objects.map((obj) => opts.resolveAssetUrl(obj.model));
      // Progress (#36) is tracked by UNIQUE url, not by placed object — a
      // scene can place the same furniture piece many times (one couch
      // model, six placements), and loadModel already coalesces repeats to
      // one fetch via modelCache below, so reporting per-placement would
      // both over-count the real download work and jump around instead of
      // advancing steadily. opts.onLoadProgress is optional — every
      // existing caller of MiniGLTF.init that predates this still works
      // unchanged with no progress reporting at all.
      const uniqueUrls = Array.from(new Set(urls));
      let loadedCount = 0;
      if (opts.onLoadProgress) opts.onLoadProgress(0, uniqueUrls.length);

      // ---------- byte-level speed/ETA (task #74), additive to the count
      // above — the count-based fill/percentage keeps working exactly as
      // before for the common case (cache hits, small local assets) where
      // byte tracking wouldn't add much. `perUrlContribution` holds each
      // URL's contribution to the total download, in bytes: 0 for a cache
      // hit (nothing to download), a number once known (from
      // Content-Length at response time, or — if that header was ever
      // missing — from the exact count once that one download finishes),
      // or left unset while still unknown. The total is only trustworthy,
      // and only then is an ETA shown, once every URL has a contribution —
      // otherwise callers get a live speed figure with no ETA rather than
      // an estimate built on a total that's silently still growing.
      const perUrlContribution = new Map();
      let bytesDownloadedSoFar = 0;
      let lastSpeedSampleTime = null;
      let lastSpeedSampleBytes = 0;
      let smoothedSpeedBps = null;
      let lastEmitTime = 0;

      function emitByteProgress(force) {
        if (!opts.onLoadProgress) return;
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (!force && now - lastEmitTime < 150) return; // throttle — a fast local server shouldn't spam one callback per chunk
        lastEmitTime = now;

        if (lastSpeedSampleTime !== null) {
          const dt = (now - lastSpeedSampleTime) / 1000;
          if (dt > 0.05) {
            const instBps = (bytesDownloadedSoFar - lastSpeedSampleBytes) / dt;
            smoothedSpeedBps = smoothedSpeedBps === null ? instBps : (smoothedSpeedBps * 0.6 + instBps * 0.4);
            lastSpeedSampleTime = now;
            lastSpeedSampleBytes = bytesDownloadedSoFar;
          }
        } else {
          lastSpeedSampleTime = now;
          lastSpeedSampleBytes = bytesDownloadedSoFar;
        }

        const totalKnown = perUrlContribution.size === uniqueUrls.length
          && Array.from(perUrlContribution.values()).every((v) => v !== null);
        let totalBytes = null;
        let etaSeconds = null;
        if (totalKnown) {
          totalBytes = Array.from(perUrlContribution.values()).reduce((a, b) => a + b, 0);
          const remaining = Math.max(0, totalBytes - bytesDownloadedSoFar);
          if (smoothedSpeedBps && smoothedSpeedBps > 1) etaSeconds = remaining / smoothedSpeedBps;
        }
        opts.onLoadProgress(loadedCount, uniqueUrls.length, {
          loadedBytes: bytesDownloadedSoFar,
          totalBytes,
          speedBps: smoothedSpeedBps,
          etaSeconds
        });
      }

      const modelByUrl = new Map();
      await Promise.all(uniqueUrls.map((url) =>
        loadModel(gl, url, (info) => {
          if (info.status === 'cached') {
            perUrlContribution.set(url, 0);
            emitByteProgress(true);
          } else if (info.status === 'downloading') {
            perUrlContribution.set(url, info.totalBytes); // may be null — resolved for real at 'done' below if so
            emitByteProgress(true);
          } else if (info.status === 'progress') {
            bytesDownloadedSoFar += info.bytes;
            emitByteProgress(false);
          } else if (info.status === 'done') {
            if (perUrlContribution.get(url) == null) perUrlContribution.set(url, info.bytes); // Content-Length was missing — now we know the real size anyway
            emitByteProgress(true);
          }
        }).then((model) => {
          modelByUrl.set(url, model);
          loadedCount++;
          // Whether this particular url resolved instantly (a 304 cache
          // hit, or an already-in-flight duplicate from modelCache) or took
          // a real download, it counts as one more asset ready — the bar
          // still advances correctly either way, it just may jump quickly
          // through cached entries and pause longer on real downloads.
          if (opts.onLoadProgress) opts.onLoadProgress(loadedCount, uniqueUrls.length);
        })
      ));
      const loaded = urls.map((url) => modelByUrl.get(url));
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
      // Holding left + right mouse buttons together is a walk-forward
      // chord, same idea as W — folded into the same forward vector so it
      // combines and normalizes with the keyboard controls instead of
      // fighting them.
      if (heldMouseButtons.has(0) && heldMouseButtons.has(2)) { mx += forward[0]; mz += forward[1]; }
      const mlen = Math.hypot(mx, mz);
      const isMoving = mlen > 0.0001;
      if (isMoving) {
        mx = (mx / mlen) * speed * dt;
        mz = (mz / mlen) * speed * dt;
        // Try each axis independently so movement "slides" along an
        // obstacle instead of stopping dead the moment either axis collides.
        tryMove(mx, 0);
        tryMove(0, mz);
        // Same [sin(yaw), -cos(yaw)] convention the forward/right vectors
        // above are built from — inverting it here turns "which way am I
        // actually walking" back into a yaw the character can face.
        characterYaw = Math.atan2(mx, -mz);
      }

      // Walk-cycle: a plain sine swing for arms/legs, phase only advancing
      // while actually moving (not merely holding a key against a wall) so
      // the character doesn't visibly "walk in place" when blocked, and
      // snapping straight back to the neutral pose the instant movement
      // stops rather than easing out — simple, and at this art style's
      // scale/duration the difference isn't visible.
      if (isMoving) walkPhase += dt * (speed > 3 ? 11 : 8);
      const limbSwing = isMoving ? Math.sin(walkPhase) * 0.55 : 0;

      // Jump: a simple vertical arc layered on top of the standing eye
      // height. Space only starts a new jump while grounded (the
      // `!airborne` guard), so holding it down doesn't launch a second jump
      // mid-air.
      if (keys['Space'] && !airborne) { airborne = true; jumpVelocity = JUMP_SPEED; }
      if (airborne) {
        jumpOffset += jumpVelocity * dt;
        jumpVelocity -= GRAVITY * dt;
        if (jumpOffset <= 0) { jumpOffset = 0; jumpVelocity = 0; airborne = false; }
      }
      // Crouch: only while grounded, so a mid-air Ctrl press doesn't yank
      // the camera down mid-jump.
      const crouchOffset = (!airborne && (keys['ControlLeft'] || keys['ControlRight'])) ? CROUCH_AMOUNT : 0;
      camera.pos[1] = standingEyeY + jumpOffset - crouchOffset;
      // The character's feet sit at this same relative height (0 = normal
      // standing ground level) — jump lifts it, crouch lowers it, exactly
      // like the camera, since XZ position and vertical offset are shared
      // between "where the camera is" and "where the character stands" in
      // both view modes.
      const characterBaseY = jumpOffset - crouchOffset;
      lastCharacterBaseY = characterBaseY; // see getCharacterFloorY() below

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
      // Scroll-wheel camera distance (replaces the old first-/third-person
      // toggle — see cameraDistance's declaration above): pull the eye
      // back along the same forward vector mat4View itself derives from
      // yaw/pitch, scaled by how far the wheel has zoomed out, then hand
      // it the SAME yaw/pitch to look along — so it ends up looking back
      // over the character toward wherever they're headed, with no
      // separate "look at the character" math needed. At distance 0 this
      // reduces to exactly the plain first-person view (eye = fwd*0 = no
      // offset at all), so there's no seam between the two.
      let view;
      if (cameraDistance > 0) {
        const cosP = Math.cos(camera.pitch), sinP = Math.sin(camera.pitch);
        const fwd = [Math.sin(camera.yaw) * cosP, sinP, -Math.cos(camera.yaw) * cosP];
        const heightOffset = (cameraDistance / MAX_CAMERA_DISTANCE) * MAX_FOLLOW_HEIGHT;
        const eye = [
          camera.pos[0] - fwd[0] * cameraDistance,
          standingEyeY + characterBaseY + heightOffset - fwd[1] * cameraDistance,
          camera.pos[2] - fwd[2] * cameraDistance
        ];
        view = mat4View(eye, camera.yaw, camera.pitch);
      } else {
        view = mat4View(camera.pos, camera.yaw, camera.pitch);
      }
      gl.uniformMatrix4fv(prog.uniforms.projection, false, projection);
      gl.uniformMatrix4fv(prog.uniforms.view, false, view);
      const light = (sceneData.directionalLight && sceneData.directionalLight.direction) || [-0.4, -1, -0.3];
      gl.uniform3fv(prog.uniforms.lightDir, light);
      gl.uniform1f(prog.uniforms.ambient, (sceneData.ambientLight && sceneData.ambientLight.intensity) || 0.55);

      if (floorPrim) bindAndDraw(floorPrim, view, projection);
      portalTriggers.forEach((tr) => { bindAndDraw(tr.ring, view, projection); bindAndDraw(tr.beacon, view, projection); });
      placedPrimitives.forEach((prim) => bindAndDraw(prim, view, projection));

      // Player character. Close to distance 0 the head is deliberately
      // skipped — the camera is still basically at head height there, so
      // drawing it would just put a big colored box in front of the lens
      // — but the rest of the body still draws, so looking down (or
      // scrolling out, where the head fades into view) actually shows a
      // body, which is the point of #33.
      // mat4RotateY and the camera's own [sin(yaw), -cos(yaw)] forward/right
      // convention turn in OPPOSITE directions from each other — they were
      // built independently (mat4RotateY for placing static furniture at an
      // author-chosen angle, forward/right for movement) and nothing tied
      // their sign conventions together until now. A plain box torso/head
      // is symmetric enough that this mismatch was invisible before this
      // feature (walking straight forward always kept characterYaw equal to
      // camera.yaw, so it "looked right" either way); it only shows up once
      // the arms/legs — the one asymmetric part — need to actually turn
      // toward a DIFFERENT direction than the camera, i.e. exactly the
      // strafing case. Negating here is what makes mat4RotateY spin the
      // same way characterYaw's own [sin,-cos] convention expects.
      const charBase = mat4Multiply(
        mat4Translate(camera.pos[0], characterBaseY, camera.pos[2]),
        mat4Multiply(mat4RotateY(-characterYaw), mat4Scale(characterScale))
      );
      // Stashed so getCharacterFacingWorldDir() (below, in the returned
      // API) can read the SAME matrix that actually got used to place the
      // character parts this frame, instead of recomputing its own copy —
      // a recomputed copy would just reapply whatever sign convention it
      // was written with and could never actually catch a mismatch between
      // this line and itself.
      lastCharBase = charBase;
      // Factored out so the exact same draw code places both the local
      // player (below) and every remote player (further below) — the only
      // difference between them is which base matrix and limb-swing phase
      // gets passed in.
      const drawCharacterAt = (base, swing, showHead) => {
        const drawPart = (localMatrix, part) => {
          bindAndDraw({ vao: part.vao, color: part.color, modelMatrix: mat4Multiply(base, localMatrix) }, view, projection);
        };
        if (showHead) drawPart(mat4Translate(0, character.shoulderY, 0), character.head);
        drawPart(mat4Translate(0, character.hipY, 0), character.torso);
        drawPart(mat4Multiply(mat4Translate(-character.shoulderOffsetX, character.shoulderY, 0), mat4RotateX(swing)), character.armL);
        drawPart(mat4Multiply(mat4Translate(character.shoulderOffsetX, character.shoulderY, 0), mat4RotateX(-swing)), character.armR);
        drawPart(mat4Multiply(mat4Translate(-character.hipOffsetX, character.hipY, 0), mat4RotateX(-swing)), character.legL);
        drawPart(mat4Multiply(mat4Translate(character.hipOffsetX, character.hipY, 0), mat4RotateX(swing)), character.legR);
      };
      drawCharacterAt(charBase, limbSwing, cameraDistance > HEAD_VISIBLE_DISTANCE);

      // Other visitors (#66) — interpolate each toward its last known
      // network position/yaw (upsertRemotePlayer, in the returned API,
      // just updates the target; the actual smoothing happens here every
      // frame) and walk-animate from how far it actually moved THIS frame,
      // since a remote player's held keys aren't something this client
      // ever sees — only its reported positions.
      const remoteLerpT = Math.min(1, dt * REMOTE_LERP_RATE);
      remotePlayers.forEach((rp) => {
        const prevX = rp.x, prevZ = rp.z;
        rp.x += (rp.tx - rp.x) * remoteLerpT;
        rp.y += (rp.ty - rp.y) * remoteLerpT;
        rp.z += (rp.tz - rp.z) * remoteLerpT;
        rp.yaw = lerpAngle(rp.yaw, rp.tyaw, remoteLerpT);
        const movedDist = Math.hypot(rp.x - prevX, rp.z - prevZ);
        const rpMoving = movedDist > 0.0004;
        if (rpMoving) rp.walkPhase += dt * 8;
        const rpSwing = rpMoving ? Math.sin(rp.walkPhase) * 0.55 : 0;
        // Same [sin,-cos]-vs-mat4RotateY sign fix as the local character's
        // own charBase above — negate the yaw here too, or a remote
        // player's arms/legs would turn to face the mirror of wherever
        // they're actually walking.
        const rpBase = mat4Multiply(mat4Translate(rp.x, rp.y, rp.z), mat4RotateY(-rp.yaw));
        drawCharacterAt(rpBase, rpSwing, true); // always show the head — this is never our own first-person view
      });

      rafId = requestAnimationFrame(frame);
    }

    function start() { if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(frame); } }
    function stop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
    function destroy() {
      stop();
      remotePlayers.clear();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('wheel', onWheel);
    }

    const ready = loadScene(sceneData).then(() => start());
    return {
      ready, loadScene: (s) => loadScene(s), stop, start, destroy, camera,
      // Camera distance is normally driven by the mouse wheel (see onWheel
      // above), but exposed read/write here too — read for tests/debugging
      // that don't want to simulate real wheel events, write for a test
      // that wants to jump straight to a known distance without depending
      // on CAMERA_SCROLL_STEP's exact value.
      getCameraDistance: () => cameraDistance,
      setCameraDistance: (d) => { cameraDistance = Math.max(0, Math.min(MAX_CAMERA_DISTANCE, Number(d) || 0)); },
      getMaxCameraDistance: () => MAX_CAMERA_DISTANCE,
      // Whether the player is mid-drag actively looking around right now
      // (see `dragging` / onPointerDown/onPointerMove above). viewer.js's
      // fullscreen cursor auto-hide reads this so a look-drag's own
      // continuous mousemove events don't count as "show the cursor" —
      // otherwise turning with the mouse would keep the cursor visible the
      // whole time, defeating the point of hiding it.
      isLookDragging: () => dragging,
      // Purely cosmetic size multiplier on the rendered character model —
      // see characterScale's declaration above for what it does and does
      // NOT affect (collision, speed, camera-follow distance are all
      // untouched). Read for the Settings slider to show the current
      // value, write for it to apply a change live without re-entering
      // the world.
      getCharacterScale: () => characterScale,
      setCharacterScale: (s) => { characterScale = clampCharacterScale(s); },
      // Debug/test hook — lets a script confirm the character actually
      // turns to face its travel direction (see the characterYaw comment
      // above) without needing to read pixels back off the canvas.
      getCharacterYaw: () => characterYaw,
      // The character's FLOOR-relative height (0 = standing on the ground,
      // negative while crouching, positive mid-jump) — see the comment
      // above characterBaseY's own declaration in frame(). This is what
      // viewer.js's currentLocalPose() broadcasts as the `y` of a presence
      // move/sync, NOT camera.pos[1] (the eye height a first-person camera
      // actually sits at, typically ~1.6 units off the ground): every
      // OTHER client places a remote player's character model directly at
      // the y it receives (see upsertRemotePlayer/the remotePlayers.forEach
      // draw loop below) — send eye height and a remote character renders
      // hovering roughly at head height above the floor instead of
      // standing on it, which is exactly the bug this getter exists to
      // prevent from creeping back in.
      getCharacterFloorY: () => lastCharacterBaseY,
      // A second, independent debug hook: where the character's own local
      // -Z ("its front") actually ends up in world space once rendered.
      // Reads lastCharBase — the EXACT matrix frame() used to place every
      // character part this frame — rather than recomputing a fresh one
      // from characterYaw, on purpose: a recomputed copy would just
      // reapply whatever sign convention it was written with and could
      // never catch a mismatch between that formula and charBase's own
      // (which is exactly how the original version of this fix's mirrored
      // bug slipped past this same test — the hook agreed with itself
      // instead of checking the real render matrix). Normalized before
      // returning so characterScale (baked into lastCharBase too) doesn't
      // change this vector's magnitude — callers just want a direction.
      getCharacterFacingWorldDir: () => {
        const x = -lastCharBase[8], z = -lastCharBase[10];
        const len = Math.hypot(x, z) || 1;
        return [x / len, z / len];
      },
      // ---------- presence (#66) ----------
      // viewer.js owns the actual WebSocket connection and join/move/left
      // message protocol against presence-server; this file only renders
      // whatever roster it's told about. upsertRemotePlayer both creates a
      // new remote player (snapping straight to its first reported
      // position — nothing to interpolate in FROM yet) and updates an
      // existing one's target (smoothed toward every frame, see
      // REMOTE_LERP_RATE above).
      upsertRemotePlayer: (id, state) => {
        const x = Number(state.x) || 0, y = Number(state.y) || 0, z = Number(state.z) || 0, yaw = Number(state.yaw) || 0;
        const existing = remotePlayers.get(id);
        if (existing) {
          existing.tx = x; existing.ty = y; existing.tz = z; existing.tyaw = yaw;
        } else {
          remotePlayers.set(id, { x, y, z, yaw, tx: x, ty: y, tz: z, tyaw: yaw, walkPhase: 0 });
        }
      },
      removeRemotePlayer: (id) => { remotePlayers.delete(id); },
      getRemotePlayerCount: () => remotePlayers.size,
      getRemotePlayerIds: () => Array.from(remotePlayers.keys()),
      // Debug/test hook, same convention as getCharacterFacingWorldDir
      // above — reads the actual interpolated render state a test can
      // observe, not the raw network target, so a test can confirm
      // interpolation is genuinely happening frame to frame.
      getRemotePlayerRenderState: (id) => {
        const rp = remotePlayers.get(id);
        return rp ? { x: rp.x, y: rp.y, z: rp.z, yaw: rp.yaw } : null;
      }
    };
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
