// Domain Atlas — gltf-mini (a "gltf-mini-v1" world renderer)
//
// A small, purpose-built GLB loader + WebGL1 renderer, hand-rolled instead
// of using Three.js. Not a design preference — this project vendors zero
// external libraries into the extension (see viewer.js's header comment),
// and this sandbox's own network policy blocks fetching one anyway. So:
// write exactly enough of the glTF 2.0 spec to load this project's own
// furniture-kit GLBs, which turn out to be a genuinely narrow subset — no
// textures, no skinning, no animation, no interleaved buffers, no sparse
// accessors, OPAQUE materials only (confirmed by inspecting the actual
// files). A
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

  // Walks a parsed GLB's node graph into a flat list of world-space
  // primitives (positions/normals/indices/color/nodeMatrix) plus the
  // overall bounding box — the CPU-side half of what loadModel() below used
  // to do inline, pulled out on its own so the Asset Viewer's previewModel()
  // (bottom of this file) can reuse it too without dragging in loadModel's
  // GPU-upload step, which ties buffers to the specific `gl` context passed
  // to loadModel and is cached by URL alone (see modelCache below) — fine
  // for the one long-lived world-renderer context this file always used to
  // serve, wrong for previewModel's short-lived, created-and-destroyed-per-
  // hover contexts, where reusing a cached buffer from a since-lost context
  // would either draw nothing or throw. previewModel does its own, simpler
  // GPU upload instead (see below).
  function extractPrimitives(gltf, bin) {
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
      // Fix: a glTF node's local transform is EITHER a raw 16-element
      // `matrix` OR decomposed translation/rotation/scale — never both,
      // per spec — but this only ever read the TRS form, silently
      // treating any matrix-only node as identity, which renders a model
      // at the wrong orientation/scale wherever an exporter bakes a node
      // that way (commonly an axis-correction rotation for a source tool's
      // Z-up data). glTF's matrix layout is already column-major 16
      // floats, the exact same layout mat4FromTRS/mat4Multiply use
      // everywhere else in this file, so it can be used directly with no
      // conversion.
      const local = node.matrix ? new Float32Array(node.matrix) : mat4FromTRS(
        node.translation || [0, 0, 0],
        node.rotation || [0, 0, 0, 1],
        node.scale || [1, 1, 1]
      );
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

    return {
      primitives,
      bounds: { min, max, size: [max[0]-min[0], max[1]-min[1], max[2]-min[2]] }
    };
  }

  const modelCache = new Map(); // url -> Promise<parsedModel>

  function loadModel(gl, url, onBytes) {
    if (modelCache.has(url)) return modelCache.get(url);
    const promise = fetchModelBuffer(url, onBytes)
      .then((buffer) => {
        const { json: gltf, bin } = parseGLB(buffer);
        const { primitives, bounds } = extractPrimitives(gltf, bin);

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

        return { primitives, bounds };
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
    // Brim-shaped box sitting flush on top of the head, in the same local
    // space as the head (both hang off the same shoulderY translate) —
    // yMin lines up exactly with the head's own yMax so there's no gap or
    // overlap. Only ever drawn when a hat is actually equipped (see
    // drawCharacterAt's hatColor param below); its own baked-in color here
    // is never used for that reason, but buildBox still needs one.
    const HAT_H = 0.12, HAT_SIZE = HEAD_SIZE * 1.25;
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
      hat: buildBox(gl, HAT_SIZE, HEAD_SIZE, HEAD_SIZE + HAT_H, HAT_SIZE, skin),
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

  // Avatar look (equipped appearance, cross-domain since it rides the
  // wallet rather than anything scene- or domain-specific) — a shirt/
  // pants recolor of the shared character model built in buildCharacter()
  // below. Colors travel end to end as plain '#rrggbb' strings (the same
  // format the credential's own atlas.avatar.shirtColor/pantsColor
  // properties use, and what presence broadcasts them as) — this is the
  // one place that format actually gets turned into the [r,g,b,a] 0-1
  // arrays bindAndDraw()'s color uniform expects, whether that hex came
  // from this viewer's own equipped look or a remote player's presence
  // update. Invalid/missing input just yields null, which drawCharacterAt()
  // below already treats as "use this body part's own default color."
  function hexToRgba01(hex) {
    const m = typeof hex === 'string' && /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  function resolveAvatarColors(look) {
    if (!look) return null;
    const shirtColor = hexToRgba01(look.shirtColor);
    const pantsColor = hexToRgba01(look.pantsColor);
    return (shirtColor || pantsColor) ? { shirtColor, pantsColor } : null;
  }

  // ---------- public entry point ----------

  function init(canvas, opts) {
    const gl = canvas.getContext('webgl', { antialias: true }) || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL is not available in this browser.');
    // This project's furniture-kit GLBs use 32-bit (UNSIGNED_INT) indices
    // — plain WebGL1 only guarantees 16-bit index buffers for
    // drawElements without this extension. It's been universally
    // supported for well over a decade, but fail with a clear message
    // rather than a cryptic INVALID_ENUM if it's ever somehow missing.
    if (!gl.getExtension('OES_element_index_uint')) {
      throw new Error('This browser\'s WebGL is missing OES_element_index_uint, needed to load these models.');
    }
    const prog = createProgram(gl);
    gl.enable(gl.DEPTH_TEST);
    // Deliberately NOT culling backfaces: the procedural floor quad's
    // winding didn't match every furniture model's own winding, and
    // rather than chase that per-mesh across 140 varied files, just pay
    // the (tiny, for a scene this size) overdraw cost and never have
    // invisible geometry.
    gl.clearColor(0.055, 0.086, 0.106, 1); // matches the app's dark background

    let sceneData = opts.sceneData;
    let placedPrimitives = [];
    let floorPrim = null;
    let portalTriggers = []; // [{position:[x,z], radius, portalIndex, ring}]
    let boundingBoxes = []; // [{min:[x,z], max:[x,z]}] for simple collision
    // Task #208 — scene.json-declared "walk up and press E" nodes (loot
    // crates today, a mining node's respawn timer tomorrow — see the
    // frame()-loop comment on interactCooldownUntil for why the cooldown
    // is generic rather than crate-specific). Same shape as the 2D
    // renderer's interactableHitboxes/handleInteractable() in viewer.js —
    // marker is the raw scene.json entry (label/action/class/quantity/
    // oncePerUser), passed through untouched so both renderers share the
    // exact same dispatch function instead of two parallel copies of the
    // mint/issue logic.
    let interactTriggers = []; // [{position:[x,z], radius, marker}]
    let interactCooldownUntil = new Map(); // trigger index -> performance.now() ms it becomes interactable again
    let lastInteractPromptLabel = null; // debug/test hook, see getInteractPrompt() below
    let lastInteractPromptMarker = null; // task #213 — the same raw scene.json entry the label was derived from, or null; see getInteractPromptMarker() below
    let lastNearbyInteractMarkers = []; // task #227 — every in-range, not-yet-owned marker (not just the nearest), nearest-first; see getNearbyInteractMarkers() below

    // Dropped items, visible and pickupable in a gltf-mini world (previously
    // this renderer had no idea a drop even existed visually — see
    // beginDropPlacement()'s own comment in viewer.js for how that gap used
    // to be worked around). Deliberately NOT folded into interactTriggers/
    // loadScene() above: a drop appears and disappears live, on the same
    // ~4s poll viewer.js already runs for the 2D renderer's itemMarkers
    // (WORLD_DROPS_POLL_MS), so it gets its own incremental add/remove API
    // (setItemDrops(), below) — the same "diff and patch, don't reload the
    // whole scene" reasoning upsertRemotePlayer/removeRemotePlayer already
    // use for presence, rather than a full loadScene() call every poll
    // tick (which would also leak the previous call's WebGL buffers —
    // loadScene() never frees them, fine for a real world switch, wasteful
    // and eventually leaky if repeated every few seconds).
    //
    // dropId -> { position, radius, marker, primitives, bounds }. `marker`
    // is what flows through to opts.onInteract/onInteractPrompt exactly
    // like a scene.json interactable's marker does, tagged with
    // `kind: 'item-drop'` so viewer.js can route it to pickUpDroppedItem()
    // instead of handleInteractable()'s mint/issue logic. `primitives` is
    // null until (and unless) the dropped asset's own `asset.model` finishes
    // loading — see setItemDrops() below for the glow-marker fallback this
    // enables, and the render loop for how the two are drawn differently.
    let itemDropEntries = new Map();

    const camera = {
      pos: (sceneData.camera && sceneData.camera.start) ? sceneData.camera.start.slice() : [0, 1.6, 4],
      yaw: ((sceneData.camera && sceneData.camera.startYaw) || 0) * Math.PI / 180,
      pitch: 0
    };

    // Visible player character (#33) — built once, independent of which
    // scene is loaded (it's a fixed avatar, not scene content).
    const character = buildCharacter(gl);
    let walkPhase = 0;

    // Shared fallback visual for a dropped item whose asset has no `model`
    // (or whose model failed to load — see setItemDrops() below) — one
    // small box built once and reused, repositioned per drop, rather than
    // one VAO per drop. Same amber (#e0b84c) the 2D/isometric renderer's
    // own drawItemMarker() glow already uses, so a drop reads as "the same
    // kind of thing" across both renderers even though this one is real
    // geometry rather than a canvas gradient.
    const itemGlowPrim = buildBox(gl, 0.28, -0.14, 0.14, 0.28, [0.878, 0.722, 0.298, 1]);

    // Same "×<grams-auto-scaled-to-kg/t>" convention viewer.js's own
    // formatMass() uses for a fungible asset's quantity everywhere else
    // (wallet cards, the Asset Viewer, the Previewer) — duplicated here
    // rather than shared, same reasoning itemGlowPrim's amber color above
    // duplicates the 2D renderer's own drawItemMarker() color instead of
    // importing it: this module is deliberately self-contained (see the
    // file's own header comment) and never reaches into viewer.js.
    function formatMass(grams) {
      if (!Number.isFinite(grams)) return String(grams);
      const trimmed = (n) => n.toFixed(2).replace(/\.?0+$/, '');
      if (grams < 1000) return grams + ' g';
      if (grams < 1000000) return trimmed(grams / 1000) + ' kg';
      return trimmed(grams / 1000000) + ' t';
    }

    // The E-press prompt's own label for a dropped item — asset.name alone
    // for a unique item, or with its quantity suffixed for a fungible one
    // (e.g. "Gold (Au) ×10 g" instead of a bare "Gold (Au)" that gives no
    // hint how much is actually sitting there) — the same info the 2D
    // renderer's drop marker hover and the Previewer already show (see
    // droppedItemDisplayName() in viewer.js).
    function itemDropLabel(credential) {
      const asset = credential && credential.asset;
      if (!asset || !asset.name) return 'Pick up';
      return asset.name + (asset.fungible ? ' ×' + formatMass(credential.quantity) : '');
    }

    // A dropped item's asset.model is authored completely independently of
    // this world's own furniture kit — unlike a scene.json object (which
    // gets an author-chosen `scale` tuned by whoever built the scene, see
    // loadScene()'s objects.forEach below), there's no per-drop scale
    // anywhere in the protocol, and a model built at a different real-world
    // unit convention than this scene can come in far bigger (or smaller)
    // than everything else. setItemDrops() below normalizes every loaded
    // drop model so its largest bounding dimension always lands on this
    // target size, regardless of what units it was actually authored in.
    const ITEM_MODEL_TARGET_SIZE = 0.5;

    // How high a dropped item floats above its drop position, plus the
    // small vertical bob on top of that. Both the render loop and
    // hoverCandidates() below need to agree on this exact height so the
    // hover cursor hint lines up with what's actually drawn, rather than
    // with the drop's raw ground-level position.
    const ITEM_DROP_FLOAT_HEIGHT = 0.15;
    const ITEM_DROP_BOB_AMPLITUDE = 0.05;

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
    // This viewer's own equipped look (see wallet.js's getAvatarLook()) —
    // { shirtColor, pantsColor } as resolved [r,g,b,a] arrays, or null for
    // the character's plain default colors. Read once at construction and
    // updated live via setLocalAvatarLook() below (the equip/unequip
    // wallet-card action), same "no scene reload needed" treatment
    // characterScale's own live setter already gets.
    let localAvatarColors = resolveAvatarColors(opts.localAvatarLook);
    // This viewer's own equipped hat color, or null for no hat — a second,
    // independent equip slot from the outfit above (see wallet.js's
    // getAvatarHat()), so the two can be set/cleared without touching each
    // other. A single resolved [r,g,b,a] array rather than an object, since
    // there's only the one color; hexToRgba01() already returns null on
    // invalid/missing input, same as resolveAvatarColors() does for looks.
    let localAvatarHatColor = hexToRgba01(opts.localAvatarHat);

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
    let wasInteractKeyDown = false; // edge-detect so holding E only fires once, not every frame

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

    // Bug #138: typing a space (or any WASD/arrow/Shift/Ctrl key) into ANY
    // text field — the chat box, a contact's notes, an alias input, a
    // search box, Compose, Calendar, anywhere — was leaking straight
    // through into movement, because this listener is on `window` and
    // never checked what actually had focus. `isTypingTarget()` covers
    // every text-entry control generically (not just the chat input by
    // ID) so this stays correct as new text fields get added elsewhere in
    // the wallet without anyone having to remember to update this list.
    function isTypingTarget(el) {
      if (!el) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (tag !== 'INPUT') return false;
      // Only the input TYPES that actually accept typed/keyed input while
      // focused — a checkbox/radio/range/color/file/button et al. don't
      // consume WASD or Space as text, so movement should keep working
      // if one of those happens to be focused (e.g. tabbing through a
      // settings form shouldn't freeze the character).
      const type = (el.type || 'text').toLowerCase();
      return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
    }

    function onKeyDown(e) {
      // Currently typing somewhere — let the field handle the keystroke
      // completely normally (including Space) and don't register it as a
      // movement key at all.
      if (isTypingTarget(document.activeElement)) return;
      // Space scrolling the host page would be a strange side effect of
      // jumping — nothing here is meant to scroll, so stop that specific
      // default without touching any other key's normal behavior.
      if (e.code === 'Space') e.preventDefault();
      keys[e.code] = true;
    }
    function onKeyUp(e) { keys[e.code] = false; }
    // Covers the case where a movement key was already held down and THEN
    // the player clicks/tabs into a text field without releasing it first
    // (onKeyDown's own guard above only stops a NEW key from registering —
    // it can't retroactively un-stick one already held). The moment focus
    // lands on a typing target, every currently-held key is released, so
    // the character can never keep walking/jumping while someone's mid-
    // sentence in a text box.
    function onFocusIn(e) {
      if (!isTypingTarget(e.target)) return;
      for (const code in keys) keys[code] = false;
    }
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

    // Mouse-hover cursor hint for 3D interactables — cursor as a hint
    // only, nothing else about interaction changes. The ONLY
    // visible effect is canvas.style.cursor switching to 'pointer' while the
    // mouse is over an on-screen interactable or dropped item, at ANY
    // distance — not gated by the proximity radius that drives the E-prompt/
    // Previewer. It never opens the Previewer and never changes what E does;
    // the existing proximity-triggered flow above is completely untouched.
    // It also adds no new authored data — it reuses the exact same
    // position+radius pairs interactTriggers/itemDropEntries already carry
    // for that proximity system, just tested with a ray instead of a planar
    // distance.
    //
    // currentEyeAndBasis() recomputes the eye position and the fwd/right/up
    // camera basis completely independently of the render loop's own inline
    // version further down (rather than refactoring that code to expose it)
    // — same duplication-over-shared-refactor precedent already used
    // elsewhere in this file (see formatMass/itemDropLabel's own comment
    // above). The two must be kept in sync by hand if the camera model ever
    // changes (e.g. a new zoom curve).
    function currentEyeAndBasis() {
      const cosP = Math.cos(camera.pitch), sinP = Math.sin(camera.pitch);
      const cosY = Math.cos(camera.yaw), sinY = Math.sin(camera.yaw);
      const fwd = [sinY * cosP, sinP, -cosY * cosP];
      const right = normalize(cross(fwd, [0, 1, 0]));
      const up = normalize(cross(right, fwd));
      let eye;
      if (cameraDistance > 0) {
        const heightOffset = (cameraDistance / MAX_CAMERA_DISTANCE) * MAX_FOLLOW_HEIGHT;
        eye = [
          camera.pos[0] - fwd[0] * cameraDistance,
          standingEyeY + lastCharacterBaseY + heightOffset - fwd[1] * cameraDistance,
          camera.pos[2] - fwd[2] * cameraDistance
        ];
      } else {
        eye = camera.pos;
      }
      return { eye, fwd, right, up };
    }

    // Ray-sphere intersection (a standard quadratic solve) — origin/dir
    // define the ray, center/radius the sphere. Returns the nearest hit
    // distance in front of the camera (t >= 0), or null; the caller here
    // only needs "did it hit at all" but a distance is cheap to hand back
    // too, in case a future caller wants nearest-target picking.
    function raySphereHit(origin, dir, center, radius) {
      const ox = origin[0] - center[0], oy = origin[1] - center[1], oz = origin[2] - center[2];
      const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
      const c = ox * ox + oy * oy + oz * oz - radius * radius;
      const disc = b * b - c;
      if (disc < 0) return null;
      const sqrtDisc = Math.sqrt(disc);
      const t0 = -b - sqrtDisc, t1 = -b + sqrtDisc;
      if (t0 >= 0) return t0;
      if (t1 >= 0) return t1;
      return null;
    }

    // Builds the same combined interactable+drop list the proximity/E
    // system walks (interactTriggers + itemDropEntries), each reduced to
    // just a world position and radius, so a single ray test is reused
    // across both instead of a third parallel data structure.
    // An earlier version lit the cursor up well before the mouse was
    // actually over the rendered object. That's because the proximity
    // `radius` these two data sources carry is a "walk up and press E"
    // TRIGGER distance, authored with a
    // comfortable approach margin in mind (e.g. the lobby crates' radius:
    // 1.7, around a box only about half a unit across) — never meant to
    // describe how big the thing actually looks on screen. Reusing it
    // as-is for the hover ray made the hit sphere far bigger than the
    // visible object. Shrinking it down for hover specifically (a fixed
    // fraction, capped at a small absolute size so an oversized authored
    // radius like the crates' can't still balloon past it) keeps the
    // "reuse existing data, no new authoring" design intact while making
    // the hit area track what's actually drawn much more closely. Not
    // pixel-perfect (there's still no real per-model visual bounding box
    // to test against — see this file's own header comment on why that
    // was deliberately skipped), but far tighter than before.
    const HOVER_RADIUS_SCALE = 0.35;
    const HOVER_RADIUS_CAP = 0.5;
    function hoverRadiusFor(radius) { return Math.min(radius * HOVER_RADIUS_SCALE, HOVER_RADIUS_CAP); }

    function hoverCandidates() {
      const list = [];
      interactTriggers.forEach((trigger) => { list.push({ position: trigger.position, radius: hoverRadiusFor(trigger.radius) }); });
      itemDropEntries.forEach((entry) => {
        // Center the hit-test sphere on the same elevated position the
        // render loop actually draws the model at — entry.position alone
        // is the drop's ground-level position, one ITEM_DROP_FLOAT_HEIGHT
        // below where the model is drawn, which put the hover hit area
        // noticeably below the visible, floating item.
        const position = [entry.position[0], (entry.position[1] || 0) + ITEM_DROP_FLOAT_HEIGHT, entry.position[2]];
        list.push({ position, radius: hoverRadiusFor(entry.radius) });
      });
      return list;
    }

    function onCanvasHoverMove(e) {
      // Dragging already repurposes the mouse for camera rotation — there's
      // nothing meaningful under a moving look-drag crosshair, and pointer
      // capture during a drag means clientX/Y here aren't a stable canvas
      // position anyway, so skip the ray test entirely while dragging.
      if (dragging) return;
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
      const aspect = canvas.width / Math.max(1, canvas.height);
      const fovY = Math.PI / 3; // same 60° vertical FOV as mat4Perspective's own call in the render loop below
      const tanFov = Math.tan(fovY / 2);
      const { eye, fwd, right, up } = currentEyeAndBasis();
      // Ray direction: straight ahead, plus a slice of right/up scaled by
      // the NDC offset and the same tan(fov/2)*aspect factor a perspective
      // projection itself applies — the inverse of turning a view-space ray
      // into a screen point, done directly against this camera's own
      // already-known basis rather than via a generic unproject/matrix-
      // inverse utility (this file doesn't otherwise carry one).
      const dir = normalize([
        fwd[0] + right[0] * ndcX * tanFov * aspect + up[0] * ndcY * tanFov,
        fwd[1] + right[1] * ndcX * tanFov * aspect + up[1] * ndcY * tanFov,
        fwd[2] + right[2] * ndcX * tanFov * aspect + up[2] * ndcY * tanFov
      ]);
      let hit = false;
      const candidates = hoverCandidates();
      for (let i = 0; i < candidates.length; i++) {
        // The proximity radius interactTriggers/itemDropEntries carry is a
        // walk-up trigger distance, not an authored visual bounding sphere
        // — reusing it directly (per the design Bruno approved: no new
        // scene.json field, no per-model bounding-box extraction) makes the
        // hover target a bit generous rather than pixel-tight, which is
        // fine for a distance hint whose whole job is "something's over
        // there."
        if (raySphereHit(eye, dir, candidates[i].position, candidates[i].radius) !== null) { hit = true; break; }
      }
      canvas.style.cursor = hit ? 'pointer' : '';
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // 'focusin' (not 'focus') because it bubbles — a single listener on
    // window/document sees every element gaining focus anywhere in the
    // document, same reasoning as the delegated click handlers elsewhere
    // in this codebase, rather than needing one listener per text field.
    window.addEventListener('focusin', onFocusIn);
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mousemove', onCanvasHoverMove);

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

      // No geometry of its own (unlike a portal's ring/beacon) — the crate
      // or node's own model, placed as an ordinary scene object just above,
      // is what's actually visible; this only tracks where to stand and
      // what to run when E is pressed there. Re-derived fresh on every
      // loadScene() the same as portalTriggers, so switching worlds can't
      // leave a stale trigger armed from wherever was visited before.
      interactTriggers = (sceneData.interactables || []).map((m) => ({
        position: m.position,
        radius: m.radius || 1.0,
        marker: m
      }));
      interactCooldownUntil = new Map();
      portalCooldown = new Set();
      // A world switch always gets a brand new init() (see viewer.js's
      // active3D.destroy()/MiniGLTF.init() pair around entering a world),
      // so itemDropEntries already starts empty here in practice — cleared
      // anyway so a future caller of loadScene() on a still-alive instance
      // (there is none today) doesn't inherit another world's drops.
      itemDropEntries.clear();
    }

    // Diffs `drops` (viewer.js's live poll of this world's drops, same
    // ~4s cadence and data source as the 2D renderer's own
    // refreshSceneItemMarkers()) against itemDropEntries: removes any
    // entry no longer present (claimed, or picked up by this visitor),
    // and registers any new one immediately as a glow marker — upgraded
    // in place to the asset's own model, if it declares one and it loads
    // successfully (see the render loop for how the two draw differently).
    // Each `drop` is { dropId, position, radius, model (asset.model URL,
    // already absolute — see SPEC.md §5 — or null/undefined), domain,
    // credential }.
    function setItemDrops(drops) {
      const incomingIds = new Set((drops || []).map((d) => d.dropId));
      for (const dropId of itemDropEntries.keys()) {
        if (!incomingIds.has(dropId)) itemDropEntries.delete(dropId);
      }
      (drops || []).forEach((drop) => {
        if (itemDropEntries.has(drop.dropId)) return; // already tracked — a drop's position/model never change after it lands, nothing to update
        const entry = {
          position: drop.position,
          radius: drop.radius || 0.9,
          marker: {
            kind: 'item-drop',
            dropId: drop.dropId,
            domain: drop.domain,
            entry: { credential: drop.credential },
            label: itemDropLabel(drop.credential)
          },
          primitives: null,
          bounds: null
        };
        itemDropEntries.set(drop.dropId, entry);
        if (drop.model) {
          // Cached by URL (modelCache, see loadModel above) — every visitor
          // dropping the same class only pays the fetch once per session,
          // same as any other model this renderer loads.
          loadModel(gl, drop.model).then((model) => {
            if (!itemDropEntries.has(drop.dropId)) return; // picked up/claimed before the model finished loading — don't resurrect a drop that's already gone
            entry.primitives = model.primitives;
            entry.bounds = model.bounds;
            // Normalize to ITEM_MODEL_TARGET_SIZE by the model's own
            // largest bounding dimension — a finely detailed model authored
            // in real-world-scale units (say, meters, with a trophy modeled
            // several units tall) would otherwise render at whatever raw
            // size it happens to carry, dwarfing every other item in the
            // scene. `size` can be non-finite/zero for a degenerate model
            // (no accessor min/max at all) — falls back to no rescaling
            // rather than dividing by zero or NaN-ing the whole matrix.
            const size = model.bounds.size;
            const maxDim = Math.max(size[0], size[1], size[2]);
            entry.scale = (Number.isFinite(maxDim) && maxDim > 0) ? (ITEM_MODEL_TARGET_SIZE / maxDim) : 1;
          }).catch((err) => {
            // Graceful, not fatal — same "no broken-image icon" spirit the
            // Asset Viewer's thumbnail already follows (viewer.js): a bad
            // or missing model just means this drop keeps showing the
            // amber glow fallback forever instead of its real shape.
            console.warn('Dropped item model failed to load (' + drop.model + '), showing a marker instead:', err);
          });
        }
      });
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

      // Interactable proximity + E-to-collect. Deliberately NOT auto-fired
      // on proximity like the portal check just above — walking near a
      // loot crate shouldn't loot it any more than walking near a door
      // should always open it, so this only ever fires on an actual E
      // keydown (edge-detected via wasInteractKeyDown so holding the key
      // down doesn't repeat-fire every frame).
      //
      // Task #227 — collects EVERY in-range, not-yet-owned trigger into
      // `nearby`, sorted nearest-first, instead of tracking only the
      // single closest one: Bruno asked for the Previewer to show a list
      // when the character is close to two or more items at once, and for
      // E to keep working — collecting the nearest one at a time — even
      // when several are in range together. `nearestInteract` (E's actual
      // target, and what the "E — <label>" prompt names) is simply
      // `nearby[0]`, so E always fires on the closest AVAILABLE one; once
      // that one is collected, opts.isMarkerAlreadyOwned starts returning
      // true for it and it drops out of `nearby` on the very next frame —
      // the next-nearest naturally becomes nearby[0], which is exactly
      // "press E multiple times to collect them one at a time" with no
      // extra bookkeeping needed here.
      //
      // opts.isMarkerAlreadyOwned (viewer.js's isOncePerUserClassOwned) is
      // optional and checked once per trigger per frame — a plain sync
      // predicate, never a wallet read from inside this loop; a marker
      // it flags is excluded here, upstream of both E's own target
      // selection AND whatever the Previewer ends up showing, so "the
      // previewer must ignore it" (Bruno's own words) and "E skips an
      // already-owned crate" are the same one filter, not two.
      const nearby = [];
      interactTriggers.forEach((trigger, idx) => {
        const dx = camera.pos[0] - trigger.position[0];
        const dz = camera.pos[2] - trigger.position[2];
        const dist = Math.hypot(dx, dz);
        const cooldownUntil = interactCooldownUntil.get(idx) || 0;
        if (dist < trigger.radius && t >= cooldownUntil && !(opts.isMarkerAlreadyOwned && opts.isMarkerAlreadyOwned(trigger.marker))) {
          nearby.push({ idx, marker: trigger.marker, dist });
        }
      });
      // Dropped items (see setItemDrops() above) fold into the exact same
      // `nearby`/E-press/Previewer pipeline as a scene.json interactable —
      // proximity, nearest-first sort, one E-press collects the closest —
      // rather than a second parallel interaction system. Keyed by dropId
      // (a string) in the shared interactCooldownUntil map, which never
      // collides with a static interactable's numeric idx. No
      // isMarkerAlreadyOwned check here — that predicate is for a
      // repeatable oncePerUser crate; a drop is already a one-shot (it
      // simply stops being in `drops` once claimed, on the very next poll).
      itemDropEntries.forEach((entry, dropId) => {
        const dx = camera.pos[0] - entry.position[0];
        const dz = camera.pos[2] - entry.position[2];
        const dist = Math.hypot(dx, dz);
        const cooldownUntil = interactCooldownUntil.get(dropId) || 0;
        if (dist < entry.radius && t >= cooldownUntil) {
          nearby.push({ idx: dropId, marker: entry.marker, dist });
        }
      });
      nearby.sort((a, b) => a.dist - b.dist);
      const nearestInteract = nearby.length ? nearby[0] : null;
      lastInteractPromptLabel = nearestInteract ? (nearestInteract.marker.label || 'Interact') : null;
      lastInteractPromptMarker = nearestInteract ? nearestInteract.marker : null;
      lastNearbyInteractMarkers = nearby.map((n) => n.marker);
      // Task #213/#227 — the nearest marker (still the "E — <label>"
      // prompt's own target) travels alongside the label as before, plus
      // now the FULL nearby list as a third argument — still backward
      // compatible, since a caller reading only the first one or two
      // arguments (there is none left in this codebase, but the shape is
      // kept anyway) keeps working unchanged. viewer.js uses the full list
      // to drive the Previewer's multi-item view.
      if (opts.onInteractPrompt) opts.onInteractPrompt(lastInteractPromptLabel, lastInteractPromptMarker, lastNearbyInteractMarkers);
      const interactKeyDown = !!keys['KeyE'];
      if (interactKeyDown && !wasInteractKeyDown && nearestInteract && opts.onInteract) {
        // A short cooldown applies regardless of what the action turns out
        // to be — it debounces a mashed/held E key today, and is also the
        // hook a future repeatable mining node's respawn timer would use
        // (via a longer per-marker `cooldownMs`) without any renderer
        // change; a one-time crate's real "can't reopen" enforcement is
        // still the server-side oncePerUser check in handleInteractable(),
        // this alone would never be enough to guarantee that on its own.
        interactCooldownUntil.set(nearestInteract.idx, t + (nearestInteract.marker.cooldownMs || 1500));
        opts.onInteract(nearestInteract.marker);
      }
      wasInteractKeyDown = interactKeyDown;

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

      // Dropped items — a slow spin plus a gentle bob (phase-offset by X so
      // several drops sitting near each other don't all bob in lockstep)
      // reads as "a collectible sitting here," the same signal a portal's
      // own pulse gives for "walk through me." A drop whose model hasn't
      // loaded (or has none — see setItemDrops() above) draws the shared
      // amber itemGlowPrim instead, at the same position/animation, so a
      // fallback marker still reads as "something's here" rather than
      // nothing at all.
      itemDropEntries.forEach((entry) => {
        const bob = Math.sin(t * 0.0026 + entry.position[0]) * ITEM_DROP_BOB_AMPLITUDE;
        const spin = t * 0.0009;
        const placement = mat4Multiply(
          mat4Translate(entry.position[0], (entry.position[1] || 0) + ITEM_DROP_FLOAT_HEIGHT + bob, entry.position[2]),
          mat4RotateY(spin)
        );
        if (entry.primitives) {
          // entry.scale (set once the model finishes loading — see
          // setItemDrops() above) normalizes an arbitrarily-authored model
          // down to ITEM_MODEL_TARGET_SIZE, applied in the model's own
          // local space (before nodeMatrix), the same composition order
          // loadScene()'s objects.forEach already uses for a scene.json
          // object's own author-chosen scale.
          const withScale = mat4Multiply(placement, mat4Scale(entry.scale || 1));
          entry.primitives.forEach((prim) => {
            bindAndDraw({ vao: prim.vao, color: prim.color, modelMatrix: mat4Multiply(withScale, prim.nodeMatrix) }, view, projection);
          });
        } else {
          bindAndDraw({ vao: itemGlowPrim.vao, color: itemGlowPrim.color, modelMatrix: placement }, view, projection);
        }
      });

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
      // difference between them is which base matrix, limb-swing phase,
      // and avatar look (see resolveAvatarColors() above) gets passed in.
      // `colors` overrides just the torso/leg color — arms and head stay
      // the character's own fixed skin tone regardless of equipped look,
      // the same way a real outfit wouldn't recolor someone's hands or face.
      // `hatColor` is a separate, independent override: the hat piece only
      // gets drawn at all when one is equipped (null skips it entirely,
      // rather than drawing it in some "no hat" default color), and its
      // visibility is gated by `showHead` the same way the head itself is —
      // a hat with no head under it wouldn't make sense either.
      const drawCharacterAt = (base, swing, showHead, colors, hatColor) => {
        const shirtColor = colors && colors.shirtColor;
        const pantsColor = colors && colors.pantsColor;
        const drawPart = (localMatrix, part, colorOverride) => {
          bindAndDraw({ vao: part.vao, color: colorOverride || part.color, modelMatrix: mat4Multiply(base, localMatrix) }, view, projection);
        };
        if (showHead) {
          drawPart(mat4Translate(0, character.shoulderY, 0), character.head);
          if (hatColor) drawPart(mat4Translate(0, character.shoulderY, 0), character.hat, hatColor);
        }
        drawPart(mat4Translate(0, character.hipY, 0), character.torso, shirtColor);
        drawPart(mat4Multiply(mat4Translate(-character.shoulderOffsetX, character.shoulderY, 0), mat4RotateX(swing)), character.armL);
        drawPart(mat4Multiply(mat4Translate(character.shoulderOffsetX, character.shoulderY, 0), mat4RotateX(-swing)), character.armR);
        drawPart(mat4Multiply(mat4Translate(-character.hipOffsetX, character.hipY, 0), mat4RotateX(-swing)), character.legL, pantsColor);
        drawPart(mat4Multiply(mat4Translate(character.hipOffsetX, character.hipY, 0), mat4RotateX(swing)), character.legR, pantsColor);
      };
      drawCharacterAt(charBase, limbSwing, cameraDistance > HEAD_VISIBLE_DISTANCE, localAvatarColors, localAvatarHatColor);

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
        drawCharacterAt(rpBase, rpSwing, true, rp.colors, rp.hatColor); // always show the head — this is never our own first-person view
      });

      rafId = requestAnimationFrame(frame);
    }

    function start() { if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(frame); } }
    function stop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
    function destroy() {
      stop();
      remotePlayers.clear();
      itemDropEntries.clear();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('focusin', onFocusIn);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mousemove', onCanvasHoverMove);
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
      // Debug/test hook, task #208 — the same string the on-screen "E —
      // <label>" prompt is currently showing (or null when nothing's in
      // range), computed fresh every frame in the proximity check above.
      // Lets a test confirm the prompt appears/disappears at the right
      // moment without reading canvas pixels, same convention as every
      // other getter here. A test can teleport by writing directly to the
      // already-exposed `camera.pos` array (no separate teleport hook
      // needed) and then poll this to confirm the trigger radius worked.
      getInteractPrompt: () => lastInteractPromptLabel,
      // Task #213 — same debug/test-hook convention as getInteractPrompt()
      // just above, one level less processed: the raw scene.json entry the
      // current prompt label was derived from (or null), so a test can
      // confirm which interactable's `class` a proximity-driven Asset
      // Viewer preview should be showing without re-deriving it from the
      // label string.
      getInteractPromptMarker: () => lastInteractPromptMarker,
      // Task #227 — same debug/test-hook convention as the two getters just
      // above, one step wider: every marker currently in E-range (not just
      // whichever one is nearest/would-be-collected-next), nearest-first,
      // already filtered through opts.isMarkerAlreadyOwned. Lets a test
      // confirm the Previewer's multi-item list matches the renderer's own
      // idea of what's actually in range, without re-deriving proximity
      // math the test has no access to.
      getNearbyInteractMarkers: () => lastNearbyInteractMarkers,
      // Dropped items visible/pickupable in this world — see setItemDrops()
      // and itemDropEntries' own declaration above for the full picture.
      // viewer.js calls this on the same poll/after-drop/after-pickup
      // schedule it already drives the 2D renderer's itemMarkers from
      // (refreshSceneItemMarkers()), so both renderers stay in sync off the
      // one shared drops fetch.
      setItemDrops: (drops) => setItemDrops(drops),
      // Debug/test hooks, same convention as getInteractPrompt() etc. above
      // — let a test confirm a drop actually registered and which visual
      // it's showing (a real model vs. the amber glow fallback) without
      // reading canvas pixels.
      getItemDropCount: () => itemDropEntries.size,
      getItemDropRenderKind: (dropId) => {
        const entry = itemDropEntries.get(dropId);
        return entry ? (entry.primitives ? 'model' : 'marker') : null;
      },
      // The normalization factor actually applied to a loaded drop model
      // (see ITEM_MODEL_TARGET_SIZE above) — lets a test confirm an
      // oversized source model really did get scaled down to a sane size,
      // without reading rendered pixels. null before the model has finished
      // loading, or for a marker-fallback drop that never had one.
      getItemDropScale: (dropId) => {
        const entry = itemDropEntries.get(dropId);
        return entry && entry.primitives ? entry.scale : null;
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
        // A newly-joined member has neither key at all (presence-server's
        // 'joined' broadcast doesn't know their look yet — see that file's
        // moveMember() comment) — leave `colors` alone rather than
        // stomping it to the default the moment they spawn at the origin.
        // A 'moved' broadcast or a roster entry always carries both keys
        // (possibly null, for "no look equipped"), so those DO update it,
        // default included.
        const hasLookUpdate = 'shirtColor' in state || 'pantsColor' in state;
        const colors = hasLookUpdate ? resolveAvatarColors({ shirtColor: state.shirtColor, pantsColor: state.pantsColor }) : null;
        // Same "leave it alone until we actually hear otherwise" treatment
        // as the outfit above, checked independently — a hat and an outfit
        // are separate equip slots (see wallet.js), so one arriving without
        // the other in a given message is normal, not a sign either should
        // be reset.
        const hasHatUpdate = 'hatColor' in state;
        const hatColor = hasHatUpdate ? hexToRgba01(state.hatColor) : null;
        const existing = remotePlayers.get(id);
        if (existing) {
          existing.tx = x; existing.ty = y; existing.tz = z; existing.tyaw = yaw;
          if (hasLookUpdate) existing.colors = colors;
          if (hasHatUpdate) existing.hatColor = hatColor;
        } else {
          remotePlayers.set(id, { x, y, z, yaw, tx: x, ty: y, tz: z, tyaw: yaw, walkPhase: 0, colors: hasLookUpdate ? colors : null, hatColor: hasHatUpdate ? hatColor : null });
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
        return rp ? { x: rp.x, y: rp.y, z: rp.z, yaw: rp.yaw, colors: rp.colors || null, hatColor: rp.hatColor || null } : null;
      },
      // Live setter for this viewer's OWN equipped look (the wallet-card
      // equip/unequip action) — same "no scene reload needed" treatment as
      // setCharacterScale above. Accepts the same { shirtColor, pantsColor }
      // hex-string shape wallet.js's getAvatarLook() returns.
      setLocalAvatarLook: (look) => { localAvatarColors = resolveAvatarColors(look); },
      // Same live-update treatment as setLocalAvatarLook, for the separate
      // hat slot. Accepts the plain hex string wallet.js's getAvatarHat()
      // returns (or null/undefined to take the hat off).
      setLocalAvatarHat: (hex) => { localAvatarHatColor = hexToRgba01(hex); },
      // Debug/test hook — the actual resolved [r,g,b,a] colors currently
      // applied to the local character, or null for the default look.
      getLocalAvatarColors: () => localAvatarColors,
      // Same debug/test hook for the hat slot.
      getLocalAvatarHatColor: () => localAvatarHatColor
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

  // ---------- single-model preview (task #150, Asset Viewer) ----------
  //
  // A SEPARATE, deliberately tiny entry point from init() above. init() is
  // the full first-person world renderer — camera fly-around, keyboard/
  // pointer input, floor, character, portals, collision — none of which an
  // asset-viewer hover panel showing one held item's model wants any part
  // of. previewModel() instead reuses only parseGLB() and extractPrimitives()
  // (both still private to this closure — this function is the one thing
  // that crosses the window.MiniGLTF boundary to call them from outside)
  // and writes its own minimal render loop: no camera controls, no floor,
  // no character, no input handling — just center the model, upload it,
  // spin it slowly, done.
  //
  // Deliberately does NOT go through loadModel()/modelCache — that cache is
  // keyed by URL alone and its uploaded buffers are tied to whichever `gl`
  // context first loaded that URL. A world's canvas/context lives for the
  // whole time a world is open, so that's safe there; this preview's canvas
  // and WebGL context are created fresh per hover-and-click and explicitly
  // torn down on dispose() (see viewer.js's asset-viewer wiring), so caching
  // by URL alone would risk handing a second preview a buffer that belongs
  // to a context already lost. Small enough (a held item, not a scene) that
  // re-fetching and re-uploading per preview is a non-issue.
  //
  // opts is currently unused (reserved for a future rotation-speed/
  // background-color knob) — callers pass {} today.
  function previewModel(canvas, glbArrayBuffer, opts) {
    opts = opts || {};
    const gl = canvas.getContext('webgl', { alpha: true, antialias: true }) || canvas.getContext('experimental-webgl', { alpha: true });
    if (!gl) throw new Error('WebGL is not available in this browser.');
    // Best-effort only, unlike init()'s hard failure on this same extension
    // — a preview missing 32-bit indices on some exotic model just draws
    // nothing useful rather than the whole viewer panel needing to handle a
    // thrown error for what's a minor, small-scale preview.
    gl.getExtension('OES_element_index_uint');

    const { json: gltf, bin } = parseGLB(glbArrayBuffer);
    const { primitives, bounds } = extractPrimitives(gltf, bin);
    const prog = createProgram(gl);

    const gpuPrimitives = primitives.map((prim) => ({
      color: prim.color,
      nodeMatrix: prim.nodeMatrix,
      positionBuffer: createBuffer(gl, gl.ARRAY_BUFFER, prim.positions),
      normalBuffer: prim.normals ? createBuffer(gl, gl.ARRAY_BUFFER, prim.normals) : null,
      indexBuffer: prim.indices ? createBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, prim.indices) : null,
      indexCount: prim.indices ? prim.indices.length : (prim.positions.length / 3),
      indexType: prim.indices ? (prim.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT) : null
    }));

    // Frame the model regardless of whatever scale/units its own author
    // used — center on its bounding-box middle, and pick a camera distance
    // from its bounding radius, the same "fit to view" idea a real asset
    // browser's thumbnail camera would use.
    const center = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2
    ];
    const radius = Math.max(0.05, Math.hypot(bounds.size[0], bounds.size[1], bounds.size[2]) / 2) || 1;
    const cameraDistance = radius * 2.4;
    const view = mat4View([0, radius * 0.4, cameraDistance], 0, -0.15);

    gl.enable(gl.DEPTH_TEST);
    // Transparent clear — the canvas sits inside the Asset Viewer panel's
    // own dark card, so an opaque clear color would paint a visible seam
    // around the model instead of it just sitting on the panel's background.
    gl.clearColor(0, 0, 0, 0);

    let rotation = 0;
    let rafId = null;
    let lost = false;

    function frame() {
      rafId = null; // cleared before any early return so dispose() never double-cancels a stale id
      if (lost) return;
      const w = canvas.width, h = canvas.height;
      if (w === 0 || h === 0) { rafId = requestAnimationFrame(frame); return; } // panel mid-resize/not yet laid out — skip this frame rather than divide by zero in the projection
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      rotation += 0.006; // slow auto-rotate — a preview, not a game

      const projection = mat4Perspective(45 * Math.PI / 180, w / h, 0.02, cameraDistance * 20);
      const spin = mat4RotateY(rotation);
      const centered = mat4Multiply(spin, mat4Translate(-center[0], -center[1], -center[2]));

      gl.useProgram(prog.program);
      gl.uniformMatrix4fv(prog.uniforms.view, false, view);
      gl.uniformMatrix4fv(prog.uniforms.projection, false, projection);
      gl.uniform3fv(prog.uniforms.lightDir, [0.4, -0.7, -0.5]);
      gl.uniform1f(prog.uniforms.ambient, 0.55); // flat-ish lighting is fine for a small preview

      gpuPrimitives.forEach((prim) => {
        const model = mat4Multiply(centered, prim.nodeMatrix);
        gl.bindBuffer(gl.ARRAY_BUFFER, prim.positionBuffer);
        gl.enableVertexAttribArray(prog.attribs.position);
        gl.vertexAttribPointer(prog.attribs.position, 3, gl.FLOAT, false, 0, 0);

        if (prim.normalBuffer) {
          gl.bindBuffer(gl.ARRAY_BUFFER, prim.normalBuffer);
          gl.enableVertexAttribArray(prog.attribs.normal);
          gl.vertexAttribPointer(prog.attribs.normal, 3, gl.FLOAT, false, 0, 0);
        } else {
          gl.disableVertexAttribArray(prog.attribs.normal);
          gl.vertexAttrib3f(prog.attribs.normal, 0, 1, 0);
        }

        gl.uniformMatrix4fv(prog.uniforms.model, false, model);
        gl.uniformMatrix3fv(prog.uniforms.normalMatrix, false, mat3NormalFromMat4(model));
        gl.uniform4fv(prog.uniforms.color, prim.color);

        if (prim.indexBuffer) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, prim.indexBuffer);
          gl.drawElements(gl.TRIANGLES, prim.indexCount, prim.indexType, 0);
        } else {
          gl.drawArrays(gl.TRIANGLES, 0, prim.indexCount);
        }
      });

      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    // The caller (viewer.js) owns exactly when this preview's lifetime
    // ends — hover-away, "Show model" clicked on a different asset, or the
    // whole Asset Viewer panel closing all call dispose() exactly once.
    // Cancels the render loop AND explicitly loses the GL context (not just
    // stopping the rAF loop) — a small panel like this can otherwise leak a
    // real context per hover, and browsers cap how many a page may hold
    // live at once.
    return {
      dispose() {
        if (lost) return;
        lost = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        const loseCtx = gl.getExtension('WEBGL_lose_context');
        if (loseCtx) loseCtx.loseContext();
      }
    };
  }

  // ---------- player-character preview (Settings -> Player character) ----------
  //
  // A third, equally minimal entry point alongside previewModel() above —
  // same reasoning, different subject: a world's full init() wants none of
  // this either (no floor, no input, no portals), it just needs to show
  // whichever colors/hat are currently equipped so changing them in the
  // wallet has somewhere to visibly confirm itself, without opening a
  // world at all. Reuses buildCharacter()/buildBox() (the same shared boxes
  // a real world's character is built from) and writes its own tiny
  // draw loop rather than reusing init()'s drawCharacterAt closure, which
  // is defined inside — and reads several variables scoped to — the full
  // world renderer.
  //
  // opts: { characterScale, avatarLook: {shirtColor, pantsColor} | null,
  // avatarHat: '#rrggbb' | null }. Returns { dispose(), setLook(look),
  // setHat(hex) } — the caller (viewer.js) re-applies both live whenever
  // the wallet-card equip/unequip actions change them, same "no reload"
  // treatment the real 3D view already gives its own character.
  function previewCharacter(canvas, opts) {
    opts = opts || {};
    const gl = canvas.getContext('webgl', { alpha: true, antialias: true }) || canvas.getContext('experimental-webgl', { alpha: true });
    if (!gl) throw new Error('WebGL is not available in this browser.');
    gl.getExtension('OES_element_index_uint');

    const prog = createProgram(gl);
    const character = buildCharacter(gl);
    let scale = clampCharacterScale(opts.characterScale);
    let colors = resolveAvatarColors(opts.avatarLook);
    let hatColor = hexToRgba01(opts.avatarHat);

    // Frame the whole standing character, same "fit to view" idea as
    // previewModel()'s bounding-radius camera, sized off the character's
    // own known proportions instead of a computed bounding box.
    const totalHeight = character.shoulderY + character.headSize;
    const cameraDistance = totalHeight * 1.9;
    const view = mat4View([0, totalHeight * 0.55, cameraDistance], 0, -0.08);

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0); // transparent, same reasoning as previewModel() — sits inside the settings panel's own card background

    let rotation = 0;
    let rafId = null;
    let lost = false;

    function drawPart(base, localMatrix, part, colorOverride, projection) {
      const model = mat4Multiply(base, localMatrix);
      gl.bindBuffer(gl.ARRAY_BUFFER, part.vao.positionBuffer);
      gl.enableVertexAttribArray(prog.attribs.position);
      gl.vertexAttribPointer(prog.attribs.position, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, part.vao.normalBuffer);
      gl.enableVertexAttribArray(prog.attribs.normal);
      gl.vertexAttribPointer(prog.attribs.normal, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(prog.uniforms.model, false, model);
      gl.uniformMatrix3fv(prog.uniforms.normalMatrix, false, mat3NormalFromMat4(model));
      gl.uniform4fv(prog.uniforms.color, colorOverride || part.color);
      gl.drawArrays(gl.TRIANGLES, 0, part.vao.indexCount);
    }

    function frame() {
      rafId = null;
      if (lost) return;
      const w = canvas.width, h = canvas.height;
      if (w === 0 || h === 0) { rafId = requestAnimationFrame(frame); return; }
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      rotation += 0.008; // slow auto-rotate, same pace as previewModel()

      const projection = mat4Perspective(45 * Math.PI / 180, w / h, 0.02, cameraDistance * 20);
      const base = mat4Multiply(mat4RotateY(rotation), mat4Scale(scale));

      gl.useProgram(prog.program);
      gl.uniformMatrix4fv(prog.uniforms.view, false, view);
      gl.uniformMatrix4fv(prog.uniforms.projection, false, projection);
      gl.uniform3fv(prog.uniforms.lightDir, [0.4, -0.7, -0.5]);
      gl.uniform1f(prog.uniforms.ambient, 0.55);

      drawPart(base, mat4Translate(0, character.shoulderY, 0), character.head, null, projection);
      if (hatColor) drawPart(base, mat4Translate(0, character.shoulderY, 0), character.hat, hatColor, projection);
      drawPart(base, mat4Translate(0, character.hipY, 0), character.torso, colors && colors.shirtColor, projection);
      drawPart(base, mat4Translate(-character.shoulderOffsetX, character.shoulderY, 0), character.armL, null, projection);
      drawPart(base, mat4Translate(character.shoulderOffsetX, character.shoulderY, 0), character.armR, null, projection);
      drawPart(base, mat4Translate(-character.hipOffsetX, character.hipY, 0), character.legL, colors && colors.pantsColor, projection);
      drawPart(base, mat4Translate(character.hipOffsetX, character.hipY, 0), character.legR, colors && colors.pantsColor, projection);

      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    return {
      // Live-updated by viewer.js whenever the wallet-card equip/unequip
      // actions change what's equipped while this panel happens to be open
      // — same reasoning setLocalAvatarLook/setLocalAvatarHat already have
      // for the real 3D view.
      setLook(look) { colors = resolveAvatarColors(look); },
      setHat(hex) { hatColor = hexToRgba01(hex); },
      // Same live-update treatment for the Size slider, in case this panel
      // is open while it's dragged.
      setScale(s) { scale = clampCharacterScale(s); },
      // Debug/test hooks, same convention as getLocalAvatarColors/
      // getLocalAvatarHatColor on the real 3D view above.
      getColors: () => colors,
      getHatColor: () => hatColor,
      dispose() {
        if (lost) return;
        lost = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        const loseCtx = gl.getExtension('WEBGL_lose_context');
        if (loseCtx) loseCtx.loseContext();
      }
    };
  }

  window.MiniGLTF = {
    init,
    previewModel,
    previewCharacter,
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
