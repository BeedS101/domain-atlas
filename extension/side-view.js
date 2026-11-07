// Side-view renderer ("sideview-v1"): a small side-scrolling world drawn procedurally on a 2D canvas, with a
// walking and jumping character. Nothing is loaded: the level is a text grid in scene.json, and rock, timber,
// light and the character are all drawn from it. No wallet, storage or network access; the viewer passes in
// what it needs (look colours, a portal callback, an input guard).
//
// Scene format:
//   format   "sideview-v1"
//   name     shown by the viewer
//   tiles    array of equal-length strings, one per row (row 0 on top), one character per 1 x 1 tile:
//              #  solid rock        =  timber platform (solid from above only)
//              B  blocked tunnel (solid, drawn as a collapse with ore veins; marker for future mining)
//              .  open space (any other character is also open)
//   spawn    [x, y]  feet position in tiles (y is the floor line the character stands on)
//   exits    [{ rect: [x, y, w, h], portalIndex, label }]  walk in to take manifest portal `portalIndex`
//   decor    [{ type, x, y, ... }]  drawn only: post, beam, lantern, cart, rails, crystals, sign, rubble, mouth,
//            skylight, winch, barrel. x is a tile column (may be fractional), y the floor line (or ceiling for beam).
//   landmarks [{ id, label, x, y }]  named places; the label shows when the character is close
//   blocked  [{ rect: [x, y, w, h], label, hint, requires }]  the B tiles' descriptions; E nearby shows `hint`.
//            `requires` only names what a later version will check, nothing here reads the wallet.

(function (global) {
  'use strict';

  // ---------- physics (pure) ----------

  const BODY_W = 0.6, BODY_H = 1.5;
  const SPEED = 5.0;
  const ACCEL = 50;
  const GRAVITY = 38;
  const JUMP_V = 13.5;
  const MAX_FALL = 22;
  const COYOTE = 0.09;
  const JUMP_BUFFER = 0.1;
  const SUBSTEP = 1 / 120;
  const EPS = 1e-4;

  function parseLevel(scene) {
    const rows = Array.isArray(scene && scene.tiles) ? scene.tiles : [];
    const h = rows.length;
    const w = h ? rows[0].length : 0;
    const solid = [], oneWay = [], blocked = [];
    for (let y = 0; y < h; y += 1) {
      const row = String(rows[y]);
      if (row.length !== w) throw new Error('side-view tiles: row ' + y + ' has ' + row.length + ' columns, expected ' + w);
      solid.push([]); oneWay.push([]); blocked.push([]);
      for (let x = 0; x < w; x += 1) {
        const c = row[x];
        solid[y].push(c === '#' || c === 'B');
        oneWay[y].push(c === '=');
        blocked[y].push(c === 'B');
      }
    }
    return { w, h, solid, oneWay, blocked, rows };
  }

  function isSolid(level, tx, ty) {
    if (tx < 0 || tx >= level.w || ty >= level.h) return true; // the sides and the bottom are walls
    if (ty < 0) return false;
    return level.solid[ty][tx];
  }

  function isOneWay(level, tx, ty) {
    return tx >= 0 && tx < level.w && ty >= 0 && ty < level.h && level.oneWay[ty][tx];
  }

  function newPlayer(x, y) {
    return { x, y, vx: 0, vy: 0, grounded: false, facing: 1, coyote: 0, jumpBuffer: 0, jumpHeld: false, jumpCut: false, anim: 0 };
  }

  // Is there something to stand on right under the feet?
  function supportBelow(level, p) {
    const left = p.x - BODY_W / 2 + EPS, right = p.x + BODY_W / 2 - EPS;
    const ty = Math.floor(p.y + 0.02);
    for (let tx = Math.floor(left); tx <= Math.floor(right); tx += 1) {
      if (isSolid(level, tx, ty)) return true;
      if (isOneWay(level, tx, ty) && p.y <= ty + 0.02 + EPS) return true;
    }
    return false;
  }

  function moveX(level, p, dx) {
    p.x += dx;
    const top = p.y - BODY_H + EPS, bottom = p.y - EPS;
    const ty0 = Math.floor(top), ty1 = Math.floor(bottom);
    if (dx > 0) {
      const tx = Math.floor(p.x + BODY_W / 2);
      for (let ty = ty0; ty <= ty1; ty += 1) if (isSolid(level, tx, ty)) { p.x = tx - BODY_W / 2 - EPS; p.vx = 0; return; }
    } else if (dx < 0) {
      const tx = Math.floor(p.x - BODY_W / 2);
      for (let ty = ty0; ty <= ty1; ty += 1) if (isSolid(level, tx, ty)) { p.x = tx + 1 + BODY_W / 2 + EPS; p.vx = 0; return; }
    }
  }

  function moveY(level, p, dy) {
    const prevY = p.y;
    p.y += dy;
    const left = p.x - BODY_W / 2 + EPS, right = p.x + BODY_W / 2 - EPS;
    const tx0 = Math.floor(left), tx1 = Math.floor(right);
    if (dy > 0) {
      const ty = Math.floor(p.y);
      for (let tx = tx0; tx <= tx1; tx += 1) {
        const hard = isSolid(level, tx, ty);
        const soft = isOneWay(level, tx, ty) && prevY <= ty + EPS;
        if (hard || soft) { p.y = ty - EPS; p.vy = 0; p.grounded = true; return; }
      }
    } else if (dy < 0) {
      const ty = Math.floor(p.y - BODY_H);
      for (let tx = tx0; tx <= tx1; tx += 1) if (isSolid(level, tx, ty)) { p.y = ty + 1 + BODY_H + EPS; p.vy = 0; return; }
    }
  }

  // Advances one character by dt seconds. input: { left, right, jump } (held keys).
  function step(level, p, input, dt) {
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      const target = dir * SPEED;
      const dv = ACCEL * h;
      if (p.vx < target) p.vx = Math.min(target, p.vx + dv * (p.grounded ? 1 : 0.8));
      else if (p.vx > target) p.vx = Math.max(target, p.vx - dv * (p.grounded ? 1.4 : 0.8));
      if (dir) p.facing = dir;

      if (input.jump && !p.jumpHeld) p.jumpBuffer = JUMP_BUFFER;
      p.jumpHeld = !!input.jump;
      p.jumpBuffer = Math.max(0, p.jumpBuffer - h);
      p.coyote = p.grounded ? COYOTE : Math.max(0, p.coyote - h);
      if (p.jumpBuffer > 0 && (p.grounded || p.coyote > 0)) {
        p.vy = -JUMP_V; p.grounded = false; p.coyote = 0; p.jumpBuffer = 0; p.jumpCut = false;
      }
      // Releasing Space early shortens the jump.
      if (!input.jump && p.vy < 0 && !p.jumpCut) { p.vy *= 0.5; p.jumpCut = true; }

      p.vy = Math.min(MAX_FALL, p.vy + GRAVITY * h);
      moveX(level, p, p.vx * h);
      p.grounded = false;
      moveY(level, p, p.vy * h);
      if (!p.grounded && p.vy >= 0 && p.vy < 1 && supportBelow(level, p)) p.grounded = true;
    }
    if (p.grounded && Math.abs(p.vx) > 0.1) p.anim += dt * Math.abs(p.vx) * 1.8;
    else if (!p.grounded) p.anim += dt * 2;
    return p;
  }

  function rectsOverlap(p, r) {
    return p.x + BODY_W / 2 > r[0] && p.x - BODY_W / 2 < r[0] + r[2] && p.y > r[1] && p.y - BODY_H < r[1] + r[3];
  }

  // ---------- drawing ----------

  const TILE_COLORS = ['#2a2430', '#2e2834', '#272130', '#312a36'];

  function hash2(x, y, s) {
    let h = (x * 374761393 + y * 668265263 + (s || 0) * 2147483647) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  function create(canvas, scene, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    const level = parseLevel(scene);
    const spawn = Array.isArray(scene.spawn) ? scene.spawn : [2, 2];
    const exits = (scene.exits || []).map((e) => ({ rect: e.rect, portalIndex: e.portalIndex, label: e.label || '' }));
    const decor = scene.decor || [];
    const landmarks = scene.landmarks || [];
    const blockedInfo = scene.blocked || [];
    let look = normalizeLook(opts.look);
    const player = newPlayer(spawn[0], spawn[1]);
    const keys = {};
    let jumpPressedAt = 0;
    let toast = null; // { text, until }
    let nearLandmark = null;
    let lastInteractDown = false;
    const exitCooldown = new Set();
    const camera = { x: spawn[0], y: spawn[1] - 2 };
    const dark = document.createElement('canvas');
    let rafId = null, last = performance.now(), time = 0, destroyed = false, frames = 0;
    const motes = [];
    for (let i = 0; i < 46; i += 1) motes.push({ x: Math.random() * level.w, y: Math.random() * level.h, s: 0.2 + Math.random() * 0.5, p: Math.random() * 6.28 });

    function normalizeLook(l) {
      l = l || {};
      return { shirt: l.shirtColor || '#2f6f5e', pants: l.pantsColor || '#2b3742', hat: l.hatColor || null, shoes: l.shoeColor || null };
    }

    function sideKeyDown(e) {
      if (opts.isInputBlocked && opts.isInputBlocked(e)) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      keys[e.code] = true;
    }
    function sideKeyUp(e) { keys[e.code] = false; }
    function sideBlur() { for (const k of Object.keys(keys)) keys[k] = false; }
    window.addEventListener('keydown', sideKeyDown);
    window.addEventListener('keyup', sideKeyUp);
    window.addEventListener('blur', sideBlur);

    function input() {
      return {
        left: !!(keys.KeyA || keys.ArrowLeft),
        right: !!(keys.KeyD || keys.ArrowRight),
        jump: !!(keys.Space || keys.KeyW || keys.ArrowUp)
      };
    }

    function say(text, ms, owner) { toast = { text, until: time + (ms || 3500) / 1000, owner: owner || null }; }

    function nearestBlocked() {
      let best = null, bestD = 2.6;
      for (const b of blockedInfo) {
        const cx = b.rect[0] + b.rect[2] / 2, cy = b.rect[1] + b.rect[3] / 2;
        const d = Math.hypot(player.x - cx, (player.y - 0.7) - cy);
        if (d < bestD + b.rect[2] / 2) { best = b; bestD = d; }
      }
      return best;
    }

    function update(dt) {
      step(level, player, input(), dt);
      // exits: entered once, re-armed after leaving
      exits.forEach((ex, i) => {
        if (rectsOverlap(player, ex.rect)) {
          if (!exitCooldown.has(i)) { exitCooldown.add(i); if (opts.onPortalEnter) opts.onPortalEnter(ex.portalIndex); }
        } else exitCooldown.delete(i);
      });
      // A hint about the blocked tunnel goes when the character walks away from it.
      if (toast && toast.owner === 'blocked' && !nearestBlocked()) toast = null;
      nearLandmark = null;
      for (const lm of landmarks) if (Math.hypot(player.x - lm.x, (player.y - 1) - lm.y) < 3.2) { nearLandmark = lm; break; }
      const interactDown = !!keys.KeyE;
      if (interactDown && !lastInteractDown) {
        const b = nearestBlocked();
        if (b) say(b.hint || b.label || 'Blocked.', 5000, 'blocked');
      }
      lastInteractDown = interactDown;
      const tx = player.x, ty = player.y - 1.4;
      camera.x += (tx - camera.x) * Math.min(1, dt * 6);
      camera.y += (ty - camera.y) * Math.min(1, dt * 5);
    }

    // ----- drawing helpers -----
    function view() {
      const w = canvas.width, h = canvas.height;
      const ppt = Math.max(24, Math.min(64, Math.floor(h / 13)));
      let cx = camera.x, cy = camera.y;
      const halfW = w / ppt / 2, halfH = h / ppt / 2;
      cx = level.w <= halfW * 2 ? level.w / 2 : Math.max(halfW, Math.min(level.w - halfW, cx));
      cy = level.h <= halfH * 2 ? level.h / 2 : Math.max(halfH, Math.min(level.h - halfH, cy));
      return { w, h, ppt, ox: w / 2 - cx * ppt, oy: h / 2 - cy * ppt, cx, cy };
    }

    function sx(v, X) { return Math.round(X.ox + v * X.ppt); }
    function sy(v, X) { return Math.round(X.oy + v * X.ppt); }

    function drawBackground(X) {
      const g = ctx.createLinearGradient(0, 0, 0, X.h);
      g.addColorStop(0, '#0d0b14'); g.addColorStop(1, '#1b1520');
      ctx.fillStyle = g; ctx.fillRect(0, 0, X.w, X.h);
      // far rock bands that drift slower than the foreground
      for (let layer = 0; layer < 2; layer += 1) {
        const k = layer ? 0.5 : 0.28;
        ctx.fillStyle = layer ? 'rgba(52,40,58,0.55)' : 'rgba(38,30,46,0.6)';
        const base = X.h * (layer ? 0.7 : 0.55);
        ctx.beginPath(); ctx.moveTo(0, X.h);
        for (let px = 0; px <= X.w + 40; px += 40) {
          const wx = (px - X.ox * k) / X.ppt;
          const n = hash2(Math.floor(wx / 2), layer, 7) * 0.4 + hash2(Math.floor(wx / 5), layer, 3) * 0.6;
          ctx.lineTo(px, base - n * X.ppt * (layer ? 3.2 : 4.5));
        }
        ctx.lineTo(X.w + 40, X.h); ctx.closePath(); ctx.fill();
      }
    }

    function drawTiles(X) {
      const x0 = Math.max(0, Math.floor((0 - X.ox) / X.ppt)), x1 = Math.min(level.w - 1, Math.ceil((X.w - X.ox) / X.ppt));
      const y0 = Math.max(0, Math.floor((0 - X.oy) / X.ppt)), y1 = Math.min(level.h - 1, Math.ceil((X.h - X.oy) / X.ppt));
      const p = X.ppt;
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
        const px = sx(x, X), py = sy(y, X);
        if (level.solid[y][x] && !level.blocked[y][x]) {
          const hv = hash2(x, y, 1);
          ctx.fillStyle = TILE_COLORS[Math.floor(hv * TILE_COLORS.length)];
          ctx.fillRect(px, py, p + 1, p + 1);
          // speckle and cracks
          ctx.fillStyle = 'rgba(255,255,255,0.035)';
          for (let i = 0; i < 3; i += 1) ctx.fillRect(px + hash2(x, y, 10 + i) * (p - 4), py + hash2(x, y, 20 + i) * (p - 4), 2 + hash2(x, y, 30 + i) * 3, 2);
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          if (hv > 0.55) ctx.fillRect(px + hv * (p - 8), py + 3, 1, p * 0.5);
          // lit lip where rock meets open air, dark seam below it
          if (y > 0 && !level.solid[y - 1][x] && !level.oneWay[y - 1][x]) { ctx.fillStyle = 'rgba(190,150,110,0.22)'; ctx.fillRect(px, py, p + 1, 3); }
          if (x > 0 && !level.solid[y][x - 1]) { ctx.fillStyle = 'rgba(190,150,110,0.1)'; ctx.fillRect(px, py, 2, p); }
          if (y + 1 < level.h && !level.solid[y + 1][x]) { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(px, py + p - 3, p + 1, 3); }
        } else if (level.oneWay[y][x]) {
          ctx.fillStyle = '#6b4a2b'; ctx.fillRect(px, py, p + 1, Math.round(p * 0.28));
          ctx.fillStyle = '#8a6239'; ctx.fillRect(px, py, p + 1, 3);
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(px + Math.round(p * 0.45), py, 1, Math.round(p * 0.28));
          ctx.fillStyle = '#4a3320'; ctx.fillRect(px + 2, py + Math.round(p * 0.28), 3, Math.round(p * 0.2));
          ctx.fillRect(px + p - 5, py + Math.round(p * 0.28), 3, Math.round(p * 0.2));
        }
      }
      // collapsed seams
      for (const b of blockedInfo) drawCollapse(b, X);
    }

    function drawCollapse(b, X) {
      const [bx, by, bw, bh] = b.rect, p = X.ppt;
      const px = sx(bx, X), py = sy(by, X), pw = bw * p, ph = bh * p;
      ctx.fillStyle = '#1d1822'; ctx.fillRect(px, py, pw, ph);
      for (let i = 0; i < bw * bh * 5; i += 1) {
        const rx = px + hash2(i, 1, 41) * (pw - p * 0.5), ry = py + hash2(i, 2, 42) * (ph - p * 0.4);
        const s = p * (0.28 + hash2(i, 3, 43) * 0.42);
        ctx.fillStyle = ['#3a3240', '#2b2432', '#463c4a', '#352d3b'][i % 4];
        ctx.beginPath(); ctx.moveTo(rx, ry + s); ctx.lineTo(rx + s * 0.4, ry); ctx.lineTo(rx + s, ry + s * 0.3); ctx.lineTo(rx + s * 0.8, ry + s); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(rx + s * 0.4, ry, s * 0.5, 2);
      }
      // crossed warning planks
      ctx.save(); ctx.translate(px + pw / 2, py + ph / 2);
      ctx.fillStyle = '#7a5530';
      for (const a of [-0.55, 0.55]) { ctx.save(); ctx.rotate(a); ctx.fillRect(-pw * 0.62, -p * 0.12, pw * 1.24, p * 0.24); ctx.fillStyle = '#9a6e3e'; ctx.fillRect(-pw * 0.62, -p * 0.12, pw * 1.24, 3); ctx.fillStyle = '#7a5530'; ctx.restore(); }
      ctx.restore();
    }

    // A small pickaxe glyph (head and handle), used on the sign over the collapsed tunnel.
    function drawPickaxe(cx, cy, p) {
      const pulse = 0.75 + 0.25 * Math.sin(time * 2.6);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.5);
      ctx.fillStyle = '#7a5330'; ctx.fillRect(-p * 0.04, -p * 0.28, p * 0.08, p * 0.7);
      ctx.fillStyle = 'rgba(214,226,236,' + pulse + ')';
      ctx.beginPath(); ctx.moveTo(-p * 0.38, -p * 0.12); ctx.quadraticCurveTo(0, -p * 0.42, p * 0.38, -p * 0.12);
      ctx.lineTo(p * 0.3, -p * 0.04); ctx.quadraticCurveTo(0, -p * 0.28, -p * 0.3, -p * 0.04); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // Ore veins glowing through the gaps of a collapse; drawn over the darkness so they stay lit.
    function drawCollapseGlow(b, X) {
      const [bx, by, bw, bh] = b.rect, p = X.ppt;
      const px = sx(bx, X), py = sy(by, X), pw = bw * p, ph = bh * p;
      const pulse = 0.65 + 0.35 * Math.sin(time * 2.2);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,150,40,' + (0.5 * pulse) + ')'; ctx.lineWidth = Math.max(2, p * 0.08);
      for (let i = 0; i < 4; i += 1) {
        ctx.beginPath();
        let vx = px + hash2(i, 5, 51) * pw, vy = py + ph * 0.1;
        ctx.moveTo(vx, vy);
        for (let k = 0; k < 5; k += 1) { vx += (hash2(i, k, 52) - 0.5) * p * 0.9; vy += ph / 5; ctx.lineTo(vx, vy); }
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,210,110,' + (0.75 * pulse) + ')';
      for (let i = 0; i < 8; i += 1) ctx.fillRect(px + hash2(i, 7, 61) * (pw - 4), py + hash2(i, 8, 62) * (ph - 4), 3, 3);
      const g = ctx.createRadialGradient(px + pw / 2, py + ph / 2, 0, px + pw / 2, py + ph / 2, pw);
      g.addColorStop(0, 'rgba(255,140,40,' + (0.16 * pulse) + ')'); g.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = g; ctx.fillRect(px - pw * 0.5, py - ph * 0.3, pw * 2, ph * 1.6);
      ctx.restore();
    }

    function drawDecor(X, pass) {
      const p = X.ppt;
      for (const d of decor) {
        const front = d.type === 'lantern' || d.type === 'sign' || d.type === 'cart' || d.type === 'barrel' || d.type === 'crystals' || d.type === 'rubble' || d.type === 'winch' || d.type === 'mouth';
        if ((pass === 'front') !== front) continue;
        const px = sx(d.x, X), py = sy(d.y, X);
        if (px < -200 || px > X.w + 200) continue;
        switch (d.type) {
          case 'post': { // floor to ceiling
            let top = d.y; while (top > 0 && !isSolid(level, Math.floor(d.x), Math.floor(top - 0.01))) top -= 1;
            ctx.fillStyle = '#5a3d22'; ctx.fillRect(px - p * 0.14, sy(top, X), p * 0.28, py - sy(top, X));
            ctx.fillStyle = '#7a5330'; ctx.fillRect(px - p * 0.14, sy(top, X), 3, py - sy(top, X));
            ctx.fillStyle = '#4a3019'; ctx.fillRect(px - p * 0.3, py - 5, p * 0.6, 5);
            break;
          }
          case 'beam': { // across the ceiling between x and x + w
            const w = (d.w || 3) * p;
            ctx.fillStyle = '#5a3d22'; ctx.fillRect(px, py, w, p * 0.26);
            ctx.fillStyle = '#7a5330'; ctx.fillRect(px, py, w, 3);
            ctx.fillStyle = '#4a3019'; ctx.fillRect(px, py + p * 0.26, w, 2);
            break;
          }
          case 'rails': {
            const w = (d.w || 4) * p;
            ctx.fillStyle = '#3d3238'; ctx.fillRect(px, py - 3, w, 3);
            ctx.fillStyle = '#5a4a40';
            for (let sxp = 0; sxp < w; sxp += p * 0.5) ctx.fillRect(px + sxp, py - 2, p * 0.28, 4);
            ctx.fillStyle = '#9c8c84'; ctx.fillRect(px, py - 5, w, 2);
            break;
          }
          case 'skylight': { // a pale shaft from the ceiling, drawn behind the rock edge
            const w = (d.w || 2) * p, h = (d.h || 6) * p;
            const g = ctx.createLinearGradient(0, py, 0, py + h);
            g.addColorStop(0, 'rgba(255,240,200,0.28)'); g.addColorStop(1, 'rgba(255,240,200,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + w, py); ctx.lineTo(px + w * 1.7, py + h); ctx.lineTo(px - w * 0.7, py + h); ctx.closePath(); ctx.fill();
            break;
          }
          case 'mouth': { // the tunnel mouth: timber frame around a daylight opening
            const w = (d.w || 3) * p, h = (d.h || 4) * p;
            const g = ctx.createLinearGradient(px, 0, px + w, 0);
            g.addColorStop(0, 'rgba(255,238,190,0.95)'); g.addColorStop(1, 'rgba(255,238,190,0.15)');
            ctx.fillStyle = g; ctx.fillRect(px, py - h, w, h);
            ctx.fillStyle = '#5a3d22'; ctx.fillRect(px - p * 0.2, py - h - p * 0.25, p * 0.2, h + p * 0.25); ctx.fillRect(px + w, py - h - p * 0.25, p * 0.2, h + p * 0.25); ctx.fillRect(px - p * 0.3, py - h - p * 0.3, w + p * 0.6, p * 0.3);
            break;
          }
          case 'lantern': {
            const flick = 0.85 + 0.15 * Math.sin(time * 7 + d.x * 3);
            ctx.strokeStyle = '#2a2024'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, py - p * (d.drop || 0.9)); ctx.lineTo(px, py - p * 0.32); ctx.stroke();
            ctx.fillStyle = '#3a2d2a'; ctx.fillRect(px - p * 0.12, py - p * 0.34, p * 0.24, p * 0.06);
            ctx.fillStyle = 'rgba(255,196,96,' + flick + ')'; ctx.fillRect(px - p * 0.09, py - p * 0.28, p * 0.18, p * 0.22);
            ctx.fillStyle = '#3a2d2a'; ctx.fillRect(px - p * 0.12, py - p * 0.06, p * 0.24, p * 0.05);
            break;
          }
          case 'cart': {
            const w = p * 1.5, h = p * 0.75;
            ctx.fillStyle = '#2f2630'; ctx.fillRect(px - w / 2, py - h - p * 0.14, w, h);
            ctx.fillStyle = '#4a3a3a'; ctx.fillRect(px - w / 2 - 3, py - h - p * 0.14, w + 6, 4);
            ctx.fillStyle = '#5b4a44';
            for (let i = 0; i < 6; i += 1) ctx.fillRect(px - w / 2 + 4 + i * (w - 12) / 5, py - h - p * 0.14 - 4 - hash2(i, 9, 71) * 5, 8 + hash2(i, 8, 72) * 6, 8);
            ctx.fillStyle = 'rgba(255,170,60,0.55)'; ctx.fillRect(px - w * 0.2, py - h - p * 0.14 - 6, 4, 4);
            ctx.fillStyle = '#18141a'; ctx.beginPath(); ctx.arc(px - w * 0.3, py - p * 0.1, p * 0.13, 0, 6.28); ctx.arc(px + w * 0.3, py - p * 0.1, p * 0.13, 0, 6.28); ctx.fill();
            break;
          }
          case 'barrel': {
            ctx.fillStyle = '#5a3d22'; ctx.fillRect(px - p * 0.25, py - p * 0.6, p * 0.5, p * 0.6);
            ctx.fillStyle = '#2f2630'; ctx.fillRect(px - p * 0.26, py - p * 0.45, p * 0.52, 3); ctx.fillRect(px - p * 0.26, py - p * 0.18, p * 0.52, 3);
            break;
          }
          case 'rubble': {
            for (let i = 0; i < (d.n || 5); i += 1) {
              const rx = px + (hash2(i, 1, 81) - 0.5) * p * (d.w || 1.4), s = p * (0.12 + hash2(i, 2, 82) * 0.2);
              ctx.fillStyle = ['#3a3240', '#463c4a', '#2b2432'][i % 3];
              ctx.beginPath(); ctx.moveTo(rx - s, py); ctx.lineTo(rx - s * 0.3, py - s * 1.3); ctx.lineTo(rx + s, py); ctx.closePath(); ctx.fill();
            }
            break;
          }
          case 'crystals': {
            const col = d.color || '#58d6c9';
            const shimmer = 0.75 + 0.25 * Math.sin(time * 2.4 + d.x);
            for (let i = 0; i < (d.n || 5); i += 1) {
              const rx = px + (i - (d.n || 5) / 2) * p * 0.28 + (hash2(i, 3, 91) - 0.5) * p * 0.2;
              const hgt = p * (0.5 + hash2(i, 4, 92) * 1.0), lean = (hash2(i, 5, 93) - 0.5) * p * 0.35;
              ctx.fillStyle = col; ctx.globalAlpha = 0.85 * shimmer;
              ctx.beginPath(); ctx.moveTo(rx - p * 0.12, py); ctx.lineTo(rx + lean, py - hgt); ctx.lineTo(rx + p * 0.12, py); ctx.closePath(); ctx.fill();
              ctx.globalAlpha = 0.35; ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(rx - p * 0.02, py); ctx.lineTo(rx + lean, py - hgt); ctx.lineTo(rx + p * 0.05, py); ctx.closePath(); ctx.fill();
              ctx.globalAlpha = 1;
            }
            break;
          }
          case 'sign': {
            const w = Math.max(p * 1.6, (d.text || '').length * p * 0.17);
            ctx.fillStyle = '#4a3019'; ctx.fillRect(px - 2, py - p * 1.0, 4, p * 1.0);
            ctx.fillStyle = '#7a5330'; ctx.fillRect(px - w / 2, py - p * 1.45, w, p * 0.55);
            ctx.fillStyle = '#9a6e3e'; ctx.fillRect(px - w / 2, py - p * 1.45, w, 3);
            ctx.fillStyle = '#2a1d10'; ctx.font = Math.max(10, Math.round(p * 0.24)) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(d.text || '', px, py - p * 1.12);
            if (d.icon === 'pickaxe') drawPickaxe(px, py - p * 1.95, p);
            break;
          }
          case 'winch': {
            ctx.fillStyle = '#4a3019'; ctx.fillRect(px - p * 0.9, py - p * 1.4, p * 0.18, p * 1.4); ctx.fillRect(px + p * 0.72, py - p * 1.4, p * 0.18, p * 1.4); ctx.fillRect(px - p, py - p * 1.5, p * 2, p * 0.16);
            ctx.fillStyle = '#6b4a2b'; ctx.fillRect(px - p * 0.55, py - p * 1.28, p * 1.1, p * 0.26);
            ctx.strokeStyle = '#8c7c74'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, py - p * 1.02); ctx.lineTo(px, py - p * 0.5); ctx.stroke();
            ctx.fillStyle = '#5b4a44'; ctx.fillRect(px - p * 0.16, py - p * 0.5, p * 0.32, p * 0.26);
            ctx.fillStyle = '#3a2d2a'; ctx.fillRect(px - p * 0.16, py - p * 0.5, p * 0.32, 3);
            break;
          }
          default: break;
        }
      }
    }

    function drawPlayer(X) {
      const p = X.ppt, px = sx(player.x, X), py = sy(player.y, X);
      const f = player.facing;
      const moving = player.grounded && Math.abs(player.vx) > 0.3;
      const swing = moving ? Math.sin(player.anim * 3) * p * 0.17 : 0;
      const air = !player.grounded;
      ctx.save();
      ctx.translate(px, py);
      // legs
      ctx.fillStyle = look.pants;
      const legH = p * 0.55;
      ctx.fillRect(-p * 0.2 + (air ? -2 : swing * 0.2), -legH, p * 0.17, legH - (air ? 3 : 0));
      ctx.fillRect(p * 0.03 + (air ? 3 : -swing * 0.2), -legH, p * 0.17, legH - (air ? 1 : 0));
      if (look.shoes) { ctx.fillStyle = look.shoes; ctx.fillRect(-p * 0.22 + (air ? -2 : swing * 0.2), -p * 0.12, p * 0.22, p * 0.12); ctx.fillRect(p * 0.02 + (air ? 3 : -swing * 0.2), -p * 0.12, p * 0.22, p * 0.12); }
      // torso and arms
      ctx.fillStyle = look.shirt; ctx.fillRect(-p * 0.22, -legH - p * 0.5, p * 0.44, p * 0.52);
      ctx.fillStyle = '#d9a982';
      const armY = -legH - p * 0.46;
      ctx.fillRect(-p * 0.32 + (air ? -3 : -swing * 0.3), armY + (air ? -p * 0.1 : 0), p * 0.1, p * 0.38);
      ctx.fillRect(p * 0.22 + (air ? 3 : swing * 0.3), armY + (air ? -p * 0.1 : 0), p * 0.1, p * 0.38);
      // head
      ctx.fillRect(-p * 0.18, -legH - p * 0.5 - p * 0.36, p * 0.36, p * 0.36);
      ctx.fillStyle = '#2a1d10'; ctx.fillRect(f > 0 ? p * 0.04 : -p * 0.12, -legH - p * 0.5 - p * 0.24, p * 0.08, p * 0.08);
      if (look.hat) { ctx.fillStyle = look.hat; ctx.fillRect(-p * 0.22, -legH - p * 0.5 - p * 0.44, p * 0.44, p * 0.12); ctx.fillRect(-p * 0.16, -legH - p * 0.5 - p * 0.52, p * 0.32, p * 0.1); }
      ctx.restore();
    }

    // Darkness with lit holes: lanterns, crystals, the daylight mouth and a small light on the character.
    function drawLight(X) {
      if (dark.width !== X.w || dark.height !== X.h) { dark.width = X.w; dark.height = X.h; }
      const d = dark.getContext('2d');
      d.globalCompositeOperation = 'source-over';
      d.fillStyle = 'rgba(6,4,12,0.64)'; d.fillRect(0, 0, X.w, X.h);
      d.globalCompositeOperation = 'destination-out';
      const hole = (wx, wy, r, a) => {
        const px = sx(wx, X), py = sy(wy, X), pr = r * X.ppt;
        const g = d.createRadialGradient(px, py, pr * 0.1, px, py, pr);
        g.addColorStop(0, 'rgba(0,0,0,' + a + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
        d.fillStyle = g; d.fillRect(px - pr, py - pr, pr * 2, pr * 2);
      };
      hole(player.x, player.y - 0.9, 4.4, 0.7);
      for (const dc of decor) {
        if (dc.type === 'lantern') hole(dc.x, dc.y - 0.3, 5.2 + 0.2 * Math.sin(time * 7 + dc.x), 0.82);
        else if (dc.type === 'crystals') hole(dc.x, dc.y - 0.5, 3.6, 0.6);
        else if (dc.type === 'mouth') hole(dc.x + (dc.w || 3) / 2, dc.y - (dc.h || 4) / 2, 6.5, 0.95);
        else if (dc.type === 'skylight') hole(dc.x + (dc.w || 2) / 2, dc.y + (dc.h || 6) * 0.5, 5.5, 0.55);
      }
      for (const b of blockedInfo) hole(b.rect[0] + b.rect[2] / 2, b.rect[1] + b.rect[3] / 2, 4.6, 0.5);
      ctx.drawImage(dark, 0, 0);
      // warm and cool tints over the lit parts
      ctx.globalCompositeOperation = 'lighter';
      const tint = (wx, wy, r, rgb, a) => {
        const px = sx(wx, X), py = sy(wy, X), pr = r * X.ppt;
        const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
        g.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); g.addColorStop(1, 'rgba(' + rgb + ',0)');
        ctx.fillStyle = g; ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
      };
      for (const dc of decor) {
        if (dc.type === 'lantern') tint(dc.x, dc.y - 0.3, 3.4, '255,160,70', 0.12 + 0.03 * Math.sin(time * 7 + dc.x));
        else if (dc.type === 'crystals') tint(dc.x, dc.y - 0.5, 3, dc.glow || '70,220,200', 0.14);
      }
      ctx.globalCompositeOperation = 'source-over';
      for (const b of blockedInfo) drawCollapseGlow(b, X);
    }

    function drawMotes(X) {
      ctx.fillStyle = 'rgba(255,220,170,0.35)';
      for (const m of motes) {
        const wx = m.x + Math.sin(time * 0.3 + m.p) * 0.4, wy = m.y + Math.sin(time * 0.2 * m.s + m.p) * 0.3;
        const px = sx(wx, X), py = sy(wy, X);
        if (px > 0 && px < X.w && py > 0 && py < X.h) ctx.fillRect(px, py, 2, 2);
      }
    }

    function drawHud(X) {
      ctx.font = '13px sans-serif'; ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      ctx.fillText('A / D move · Space jump · E inspect', 16, 26);
      if (nearLandmark) {
        ctx.textAlign = 'center'; ctx.font = '600 16px sans-serif';
        const t = nearLandmark.label, w = ctx.measureText(t).width + 28;
        ctx.fillStyle = 'rgba(10,8,16,0.7)'; ctx.fillRect(X.w / 2 - w / 2, 44, w, 30);
        ctx.fillStyle = '#ffd9a0'; ctx.fillText(t, X.w / 2, 65);
      }
      const b = nearestBlocked();
      if (b && !(toast && toast.until > time)) {
        ctx.textAlign = 'center'; ctx.font = '14px sans-serif'; ctx.fillStyle = 'rgba(255,214,150,0.9)';
        ctx.fillText('E - inspect: ' + (b.label || 'blocked tunnel'), X.w / 2, 102);
      }
      if (toast && toast.until > time) {
        ctx.textAlign = 'center'; ctx.font = '15px sans-serif';
        const w = Math.min(X.w - 40, ctx.measureText(toast.text).width + 36);
        ctx.fillStyle = 'rgba(10,8,16,0.82)'; ctx.fillRect(X.w / 2 - w / 2, 84, w, 34);
        ctx.fillStyle = '#ffe9c4'; ctx.fillText(toast.text, X.w / 2, 106);
      }
    }

    function draw() {
      const X = view();
      drawBackground(X);
      drawDecor(X, 'back');
      drawTiles(X);
      drawDecor(X, 'front');
      drawPlayer(X);
      drawMotes(X);
      drawLight(X);
      // exits and signs read through the dark
      for (const ex of exits) {
        const px = sx(ex.rect[0], X), py = sy(ex.rect[1], X);
        ctx.font = '600 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,238,190,0.95)';
        ctx.fillText(ex.label, px + ex.rect[2] * X.ppt / 2, py - 10);
      }
      drawHud(X);
    }

    function frame(now) {
      rafId = null;
      if (destroyed) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now; time += dt; frames += 1;
      if (canvas.width && canvas.height) { update(dt); draw(); }
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    return {
      level,
      player,
      scene,
      destroy() {
        destroyed = true;
        if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener('keydown', sideKeyDown);
        window.removeEventListener('keyup', sideKeyUp);
        window.removeEventListener('blur', sideBlur);
      },
      setLook(l) { look = normalizeLook(l); },
      teleport(x, y) { player.x = x; player.y = y; player.vx = 0; player.vy = 0; player.grounded = false; },
      getState() {
        return {
          x: player.x, y: player.y, vx: player.vx, vy: player.vy, grounded: player.grounded, facing: player.facing,
          frames, nearLandmark: nearLandmark ? nearLandmark.id : null, toast: toast && toast.until > time ? toast.text : null,
          look: Object.assign({}, look)
        };
      },
      // The movement and jump rules are the pure ones above; this advances them without waiting for a frame.
      debugStep(inputState, seconds) { step(level, player, inputState, seconds); }
    };
  }

  const api = {
    create, parseLevel, newPlayer, step, supportBelow, rectsOverlap,
    BODY_W, BODY_H, SPEED, GRAVITY, JUMP_V, MAX_FALL
  };
  global.AtlasSideView = api;
})(typeof window !== 'undefined' ? window : globalThis);
