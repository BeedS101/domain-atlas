// Vertical movement regression checks for extension/gltf-mini.js.
// Node only, no browser or WebGL: loads the renderer in a vm sandbox and drives the pure movement core
// (window.MiniGLTF.layout.movement) with synthetic colliders and the real Lobby.
//
// Covers: single and double jumps, landing and the jump count reset, walking off an edge, hurdles and
// platforms at different heights, barriers that no jump gets over, ceilings, crouch clearance, standing
// clearance, claimed crates, large frame steps, and the shipped Lobby's walls and hedges.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8'), {
  window: sandbox.window, document: {}, console, Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array,
  DataView, ArrayBuffer, TextDecoder, Math, Map, Set, Promise, Array, Object, Number, JSON,
  performance: { now: () => 0 }, navigator: {}, indexedDB: {}, isFinite, Infinity, Error, String, Date
});
const L = sandbox.window.MiniGLTF.layout;
const M = sandbox.window.MiniGLTF.movement;

let checks = 0;
function pass(msg) { checks++; console.log('PASS: ' + msg); }

const DT = 1 / 60;
const R = L.PLAYER_RADIUS;
const V = M.JUMP_SPEED;
const peakOf = (v) => (v * v) / (2 * M.GRAVITY);

// A collider with an axis-aligned footprint centered on (x, z), w wide (x), d deep (z), from y0 to y1.
function box(x, z, w, d, y0, y1, extra) {
  const fp = L.placedFootprint({ min: [-w / 2, y0, -d / 2], max: [w / 2, y1, d / 2] }, { position: [x, 0, z], rotationYRad: 0, scale: 1 });
  return Object.assign({ footprint: fp, lootMarker: null }, extra || {});
}

// One body walking along the world: the same per-axis sliding and vertical step the renderer's frame loop runs.
class Sim {
  constructor(colliders, opts) {
    opts = opts || {};
    this.pos = [opts.x || 0, 1.6, opts.z || 0];
    this.body = M.newBodyState();
    this.env = { x: 0, z: 0, colliders, jumpSpeed: opts.jumpSpeed || V, ignore: opts.ignore };
    this.colliders = colliders;
    this.limits = opts.limits || null;
    this.speed = opts.speed || 2.4;
    this.peak = 0;
    this.landings = 0;
    this.wasGrounded = true;
  }
  depthAt(x, z) {
    const floor = this.limits ? L.floorOverrun(this.limits, x, z) : 0;
    return floor + M.bodyPenetration(this.colliders, x, z, this.body.feetY, M.bodyHeightOf(this.body), this.env);
  }
  step(input, dt) {
    dt = dt || DT;
    const dir = input.walk || [0, 0];
    if (dir[0] || dir[1]) {
      const len = Math.hypot(dir[0], dir[1]);
      const dx = (dir[0] / len) * this.speed * dt, dz = (dir[1] / len) * this.speed * dt;
      M.movePosition(this.pos, dx, 0, (x, z) => this.depthAt(x, z));
      M.movePosition(this.pos, 0, dz, (x, z) => this.depthAt(x, z));
    }
    this.env.x = this.pos[0];
    this.env.z = this.pos[2];
    M.stepBody(this.body, { space: !!input.space, crouch: !!input.crouch }, dt, this.env);
    this.peak = Math.max(this.peak, this.body.feetY);
    if (this.body.grounded && !this.wasGrounded) this.landings++;
    this.wasGrounded = this.body.grounded;
    return this;
  }
  run(seconds, input) {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) this.step(typeof input === 'function' ? input(i, this) : input);
    return this;
  }
  settle() { return this.run(1.5, {}); }
}

// ---------- 1. single jump on open ground ----------
{
  const s = new Sim([]);
  s.run(0.02, {});
  assert(s.body.grounded && s.body.feetY === 0 && s.body.jumpsUsed === 0, 'starts grounded at 0');
  let sawAir = false;
  s.run(1.2, (i) => { if (!s.body.grounded) sawAir = true; return { space: i === 0 }; });
  assert(sawAir, 'a Space press leaves the ground');
  assert(Math.abs(s.peak - peakOf(V)) < 0.02, 'single jump peak ' + s.peak.toFixed(3) + ' should match v^2/2g ' + peakOf(V).toFixed(3));
  assert(s.body.grounded && s.body.feetY === 0 && s.body.jumpsUsed === 0 && s.landings === 1, 'lands on the floor and resets the jump count');
  pass('single jump reaches v^2/2g and lands on the floor with the jump count reset');
}

// ---------- 2. holding Space does not chain a double jump ----------
{
  const s = new Sim([]);
  let airFrames = 0, airPeak = 0;
  // Hold Space from the first frame until the first landing.
  for (let i = 0; i < 40; i++) { s.step({ space: true }); if (!s.body.grounded) { airFrames++; airPeak = Math.max(airPeak, s.body.feetY); } }
  assert(Math.abs(airPeak - peakOf(V)) < 0.02, 'held Space is one jump (peak ' + airPeak.toFixed(3) + ')');
  assert.strictEqual(s.body.jumpsUsed, 1, 'held Space uses exactly the first jump while airborne');
  pass('holding Space does not trigger the double jump');
}

// ---------- 3. double jump ----------
{
  const s = new Sim([]);
  // Press, release, press again at the apex.
  const apexFrame = Math.round(V / M.GRAVITY / DT);
  s.run(1.5, (i) => ({ space: i === 0 || i === apexFrame }));
  assert(Math.abs(s.peak - 2 * peakOf(V)) < 0.06, 'double jump from the apex reaches about twice the height, got ' + s.peak.toFixed(3));
  assert(s.body.grounded && s.body.jumpsUsed === 0, 'lands and resets');
  pass('double jump adds a second jump in the air (peak ' + s.peak.toFixed(2) + ')');

  const t = new Sim([]);
  // Press Space for 4 frames out of every 12 while airborne: only the first two presses can launch.
  let maxJumps = 0;
  t.run(0.7, (i) => { maxJumps = Math.max(maxJumps, t.body.jumpsUsed); return { space: i % 12 < 4 }; });
  assert(maxJumps <= 2, 'never more than two jumps before landing, got ' + maxJumps);
  assert(t.peak < 2 * peakOf(V) + 0.5 && t.peak > peakOf(V), 'a third press adds nothing (peak ' + t.peak.toFixed(2) + ')');
  pass('a third press in the air does nothing');

  // The count only resets on a landing: after both jumps are used, falling to the floor is the only way back.
  const u = new Sim([]);
  u.run(0.25, (i) => ({ space: i === 0 || i === 12 }));
  assert.strictEqual(u.body.jumpsUsed, 2);
  u.step({ space: false }); u.step({ space: true });
  assert.strictEqual(u.body.jumpsUsed, 2, 'no third jump while airborne');
  u.run(1.5, {});
  assert(u.body.grounded && u.body.jumpsUsed === 0, 'landing resets it');
  pass('the jump count only resets on a valid landing');
}

// ---------- 4. jump buffs scale both jumps ----------
{
  const buff = Math.sqrt(1.5 * 1.2);
  const s = new Sim([], { jumpSpeed: V * buff });
  s.run(1.2, (i) => ({ space: i === 0 }));
  assert(Math.abs(s.peak - peakOf(V) * 1.5 * 1.2) < 0.03, 'buffed single jump peak ' + s.peak.toFixed(3));
  pass('jump multipliers still scale the jump height (' + s.peak.toFixed(2) + ' for x1.8)');
}

// ---------- 5. hurdles and platforms ----------
{
  // Crate 0.28 high, 1 x 1, centered 2 m ahead along +x.
  const crate = box(2, 0, 1, 1, 0, 0.28);
  const walk = { walk: [1, 0] };

  // Walking into it stops at its face (center ~ 1.5 - R).
  const a = new Sim([crate]);
  a.run(2, walk);
  assert(a.pos[0] < 1.5 - R + 0.05 && a.pos[0] > 1.5 - R - 0.1, 'blocked at the crate face, got x=' + a.pos[0].toFixed(2));
  assert.strictEqual(a.body.feetY, 0);
  pass('a 0.28 crate blocks walking');

  // Jumping lands on top: hop while approaching.
  const b = new Sim([crate]);
  b.run(3, () => {
    if (b.body.feetY > 0.2 && b.body.grounded) return {}; // on the crate: stop
    return { walk: [1, 0], space: b.pos[0] > 1.0 && b.pos[0] < 1.2 && b.body.grounded && b.body.jumpsUsed === 0 };
  });
  assert(b.pos[0] > 1.6, 'got onto the crate, x=' + b.pos[0].toFixed(2));
  assert(Math.abs(b.body.feetY - 0.28) < 1e-6 && b.body.grounded && b.body.jumpsUsed === 0, 'standing on the crate top, feet ' + b.body.feetY);
  pass('a jump lands on top of a low crate and standing on it resets the jumps');

  // From the top, walking on and off the far edge drops to the floor.
  b.run(3, { walk: [1, 0] });
  assert(b.pos[0] > 2.5 && b.body.feetY === 0 && b.body.grounded, 'stepped off the far edge back to the floor, x=' + b.pos[0].toFixed(2) + ' y=' + b.body.feetY);
  pass('walking off a raised surface falls back to the floor');

  // Hopping over a thin low obstacle: a 0.15 wide, 0.28 high bar is cleared and the character keeps going.
  const bar = box(2, 0, 0.15, 3, 0, 0.28);
  const c = new Sim([bar]);
  c.run(3, (i) => ({ walk: [1, 0], space: c.pos[0] > 1.0 && c.pos[0] < 1.1 }));
  assert(c.pos[0] > 2.6 && c.body.feetY === 0, 'hopped over a thin low bar and landed beyond it, x=' + c.pos[0].toFixed(2));
  pass('a jump clears a thin low obstacle');

  // A flat solid (a water sheet, a 0.1 high round table top) keeps blocking as it always did: it cannot be walked
  // onto, hopped or stood on, however many jumps or however much jump height.
  for (const h of [0.06, 0.1]) {
    const flat = box(2, 0, 1, 1, 0, h);
    assert(M.isBarrier(flat.footprint), h + ' high solid is a boundary');
    const e = new Sim([flat], { jumpSpeed: V * 2 });
    let n = 0;
    e.run(3, () => { n++; return { walk: [1, 0], space: n % 6 < 3 }; });
    e.run(1.5, {});
    assert(e.pos[0] < 1.5 && e.body.feetY === 0, 'a ' + h + ' high flat solid still blocks, x=' + e.pos[0].toFixed(2) + ' feet ' + e.body.feetY);
  }
  pass('flat solids (a 0.06 water sheet, a 0.1 table top) block walking and jumping as they did before');

  // Just above that threshold a piece is a platform: a 0.2 slab is hopped onto.
  const slab = box(2, 0, 1, 1, 0, 0.2);
  const f = new Sim([slab]);
  f.run(3, () => {
    if (f.body.feetY > 0.15 && f.body.grounded) return {};
    return { walk: [1, 0], space: f.pos[0] > 1.0 && f.pos[0] < 1.2 && f.body.grounded && f.body.jumpsUsed === 0 };
  });
  assert(Math.abs(f.body.feetY - 0.2) < 1e-6 && f.body.grounded, 'a 0.2 slab is a platform, feet ' + f.body.feetY);
  pass('a 0.2 high slab is a hurdle and a platform');
}

// ---------- 6. medium obstacle needs the double jump ----------
{
  const shelf = box(2, 0, 1, 1, 0, 0.79);
  const approach = (doubleJump) => {
    const s = new Sim([shelf]);
    let jumps = 0, prev = false;
    s.run(4, () => {
      if (s.body.feetY > 0.5 && s.body.grounded) return {}; // on the shelf: stop
      let space = false;
      if (s.body.grounded && s.body.feetY === 0 && s.pos[0] > 0.9 && jumps === 0) { space = true; jumps = 1; }
      else if (doubleJump && jumps === 1 && !s.body.grounded && s.body.vy < 0.3) { space = !prev; jumps = 2; }
      prev = space;
      return { walk: [1, 0], space };
    });
    return s;
  };
  const single = approach(false);
  assert(single.pos[0] < 1.5 - R + 0.05 && single.body.feetY === 0, 'a single jump cannot get onto a 0.79 shelf, x=' + single.pos[0].toFixed(2));
  pass('a 0.79 shelf is too high for one jump');
  const dbl = approach(true);
  assert(dbl.pos[0] > 1.5 && Math.abs(dbl.body.feetY - 0.79) < 1e-6 && dbl.body.grounded, 'double jump lands on the shelf, feet ' + dbl.body.feetY + ' x=' + dbl.pos[0].toFixed(2));
  assert.strictEqual(dbl.body.jumpsUsed, 0);
  pass('the double jump reaches a 0.79 shelf and landing there resets the jumps');
}

// ---------- 7. walking off an edge keeps one air jump ----------
{
  const crate = box(0, 0, 2, 2, 0, 0.28);
  const s = new Sim([crate], { x: 0, z: 0 });
  s.body.feetY = 0.28;
  s.run(0.3, { walk: [1, 0] });
  assert(!s.body.grounded || s.pos[0] < 1.1, 'moving to the edge');
  s.run(1.0, { walk: [1, 0] });
  assert(s.body.grounded && s.body.feetY === 0, 'ended on the floor');
  const t = new Sim([crate], { x: 0.9, z: 0 });
  t.body.feetY = 0.28;
  let jumpedInAir = false;
  t.run(1.2, (i) => {
    const air = !t.body.grounded;
    const press = air && !jumpedInAir && t.body.vy < 0;
    if (press) jumpedInAir = true;
    return { walk: [1, 0], space: press };
  });
  assert(jumpedInAir, 'airborne after leaving the edge');
  assert(t.peak > 0.28 + 0.1, 'one air jump is available after stepping off, peak ' + t.peak.toFixed(2));
  pass('stepping off an edge counts as the first jump: one air jump remains');
}

// ---------- 8. barriers cannot be hopped ----------
{
  const wall = box(2, 0, 0.2, 6, 0, 2.06);
  const hedge = box(2, 0, 0.5, 6, 0, 1.1);
  for (const [label, w] of [['wall 2.06', wall], ['hedge 1.1', hedge]]) {
    for (const mult of [1, 4, 16]) {
      const s = new Sim([w], { jumpSpeed: V * Math.sqrt(mult) });
      let frames = 0;
      s.run(5, () => { frames++; return { walk: [1, 0], space: frames % 5 === 0 }; });
      const wx = w.footprint.min[0] - R;
      assert(s.pos[0] <= wx + 0.05, label + ' with x' + mult + ' jump height: stayed on this side, x=' + s.pos[0].toFixed(2));
      assert(s.peak <= mult * 2 * peakOf(V) + 0.2 || mult > 1, 'peak sanity');
    }
  }
  pass('walls and hedges stop single, double and heavily buffed repeated jumps');

  // Standing on a crate next to a wall: still no way over.
  const crate = box(1, 0, 1, 1, 0, 0.28);
  const s = new Sim([crate, wall], { x: 1, z: 0 });
  s.body.feetY = 0.28;
  let n = 0;
  s.run(4, () => { n++; return { walk: [1, 0], space: n % 4 === 0 }; });
  assert(s.pos[0] <= wall.footprint.min[0] - R + 0.05, 'a crate next to a wall is not a step over it, x=' + s.pos[0].toFixed(2));
  pass('standing on a crate beside a wall does not let you over it');

  // Floor limits still apply at every height.
  const limits = L.floorWalkLimits({ size: [4, 4], center: [0, 0] });
  const f = new Sim([], { limits, jumpSpeed: V * 2 });
  let k = 0;
  f.run(5, () => { k++; return { walk: [1, 0], space: k % 8 === 0 }; });
  assert(L.floorOverrun(limits, f.pos[0], f.pos[2]) === 0, 'airborne movement stays inside the floor limits, x=' + f.pos[0].toFixed(2));
  assert(f.pos[0] <= 2.2, 'did not leave the room edge, x=' + f.pos[0].toFixed(2));
  pass('floor limits apply while airborne');
}

// ---------- 9. ceilings ----------
{
  // A beam above head height: underside at 2.2.
  const beam = box(0, 0, 4, 4, 2.2, 2.6);
  const over = L.selectOverheadItems([{ footprint: beam.footprint, solid: true }]);
  assert.strictEqual(over.length, 1, 'a beam above head height is an overhead collider');
  assert.strictEqual(L.selectOverheadItems([{ footprint: box(0, 0, 1, 1, 0, 1).footprint, solid: true }]).length, 0);
  assert.strictEqual(L.selectOverheadItems([{ footprint: box(0, 0, 1, 1, 9, 10).footprint, solid: true }]).length, 0, 'a roof far above is ignored');
  pass('overhead selection keeps beams and drops low furniture and distant roofs');

  const s = new Sim(over.concat([]), { jumpSpeed: V * 3 });
  s.run(1.5, (i) => ({ space: i === 0 }));
  const top = 2.2 - M.STAND_HEIGHT;
  assert(s.peak <= top + 1e-6 && s.peak > top - 0.05, 'head stops at the beam underside: peak ' + s.peak.toFixed(3) + ' limit ' + top.toFixed(3));
  assert(s.body.grounded, 'falls back down after hitting the ceiling');
  pass('a jump is capped by a beam above the head and falls back');
}

// ---------- 10. crouching ----------
{
  // A lintel: underside at 1.5, top 2.1, across the doorway at x=2, wide in z. Posts either side are separate.
  const lintel = box(2, 0, 0.4, 1.0, 1.5, 2.1);
  const standing = new Sim([lintel]);
  standing.run(2.5, { walk: [1, 0] });
  assert(standing.pos[0] < 1.5, 'standing cannot pass under a 1.5 lintel, x=' + standing.pos[0].toFixed(2));
  pass('a standing character is stopped by a low lintel');

  const crouched = new Sim([lintel]);
  crouched.run(0.1, { crouch: true });
  assert(crouched.body.crouched && M.bodyHeightOf(crouched.body) === M.CROUCH_HEIGHT, 'Ctrl crouches to the lower collision height');
  crouched.run(3, { crouch: true, walk: [1, 0] });
  assert(crouched.pos[0] > 2.5, 'a crouched character passes under the 1.5 lintel, x=' + crouched.pos[0].toFixed(2));
  assert(crouched.body.crouched && crouched.body.feetY === 0, 'still crouched, feet on the floor');
  pass('crouching lowers the collision height so it clears a 1.5 lintel');

  // Stand-up blocked while under it, allowed once clear.
  const u = new Sim([lintel], { x: 2, z: 0 });
  u.run(0.1, { crouch: true });
  u.run(0.5, {});
  assert(u.body.crouched, 'releasing Ctrl under the lintel keeps the character crouched');
  assert(M.standBlocked(u.colliders, u.pos[0], u.pos[2], 0, u.env), 'stand-up is reported blocked');
  pass('standing up is refused while an overhead obstacle blocks the standing height');

  u.run(2, { walk: [1, 0] });
  assert(u.pos[0] > 2.5 && !u.body.crouched, 'walking out from under it, the character stands up, x=' + u.pos[0].toFixed(2));
  pass('the character stands up once the headroom is clear');

  // Cannot jump out of a crouch under the lintel.
  const j = new Sim([lintel], { x: 2, z: 0 });
  j.run(0.1, { crouch: true });
  j.run(0.5, { space: true });
  assert(j.body.grounded && j.body.crouched && j.peak === 0, 'no jump while the standing height is blocked');
  pass('jumping out of a crouch is refused while the headroom is blocked');

  // Ctrl in the air does not crouch; holding Ctrl through the landing crouches.
  const a = new Sim([]);
  a.run(0.15, { space: true });
  assert(!a.body.grounded);
  a.step({ crouch: true, space: false });
  assert(!a.body.crouched, 'no mid-air crouch');
  a.run(1.0, { crouch: true });
  assert(a.body.grounded && a.body.crouched, 'crouches after landing while Ctrl is held');
  pass('crouch only starts on the ground');

  // A crouched character walks under a crouch-height gap with a table: feet stay at floor height, never negative.
  const c = new Sim([]);
  c.run(1, { crouch: true });
  assert(c.body.feetY === 0, 'crouching does not move the feet (they stay on the floor)');
  pass('crouching keeps the feet on the floor');
}

// ---------- 11. crouch height vs low obstacles ----------
{
  // A table-like slab hovering at 0.9..1.0 (underside above the knees): standing blocks, crouched (1.2) also blocks
  // because the head reaches 1.2 > 0.9; verifies the crouched body is not treated as a point.
  const slab = box(2, 0, 1, 1, 0.9, 1.0);
  const c = new Sim([slab]);
  c.run(0.1, { crouch: true });
  c.run(2, { crouch: true, walk: [1, 0] });
  assert(c.pos[0] < 1.5, 'a 0.9 high slab still stops a crouched character');
  pass('the crouched body is 1.2 tall, not zero');
}

// ---------- 12. claimed crates are ignored ----------
{
  const crateBox = box(2, 0, 1, 1, 0, 0.28, { lootMarker: 'm1' });
  let owned = false;
  const ignore = (b) => !!(b.lootMarker && owned);
  const s = new Sim([crateBox], { ignore });
  s.run(2, { walk: [1, 0] });
  assert(s.pos[0] < 1.5, 'unclaimed crate blocks');
  owned = true;
  s.run(2, { walk: [1, 0] });
  assert(s.pos[0] > 2.5 && s.body.feetY === 0, 'once claimed it is not a wall or a platform, x=' + s.pos[0].toFixed(2));
  // Standing on it when it gets claimed drops the character.
  owned = false;
  const t = new Sim([crateBox], { x: 2, z: 0, ignore });
  t.body.feetY = 0.28;
  t.run(0.1, {});
  assert(t.body.feetY === 0.28 && t.body.grounded);
  owned = true;
  t.run(0.5, {});
  assert(t.body.feetY === 0 && t.body.grounded, 'falls when the crate under it disappears');
  pass('a claimed loot crate stops blocking and stops supporting');
}

// ---------- 13. large frame steps ----------
{
  const thin = box(0, 0, 3, 3, 0.4, 0.45);
  // A thin slab at 0.4..0.45 with open space below: its underside is above the knees but it is only a platform if
  // reached from above. Drop from a double jump with a 0.1 s frame.
  const s = new Sim([thin], { jumpSpeed: V * 2.2 });
  s.step({ space: true }, 0.1);
  for (let i = 0; i < 30; i++) s.step({}, 0.1);
  assert(s.body.grounded, 'settles');
  assert(s.body.feetY === 0.45 || s.body.feetY === 0, 'ends on the slab or the floor, never inside, got ' + s.body.feetY);
  const flat = new Sim([]);
  flat.step({ space: true }, 0.1);
  for (let i = 0; i < 20; i++) flat.step({}, 0.1);
  assert(flat.body.grounded && flat.body.feetY === 0, 'a 0.1 s frame never tunnels into the floor');
  pass('0.1 s frames do not tunnel through the floor or a thin platform');
}

// ---------- 14. the shipped Lobby ----------
{
  const lobbyDir = path.join(REPO, 'demo-domain-a');
  const scene = JSON.parse(fs.readFileSync(path.join(lobbyDir, 'spatial', 'lobby', 'scene.json'), 'utf8'));
  const modelCache = new Map();
  function modelFor(url) {
    if (!modelCache.has(url)) {
      const buf = fs.readFileSync(path.join(lobbyDir, url));
      const { json, bin } = L.parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      modelCache.set(url, L.extractPrimitives(json, bin));
    }
    return modelCache.get(url);
  }
  const items = scene.objects.map((o) => ({
    name: path.basename(o.model, '.glb'), obj: o, solid: o.solid !== false && o.collision !== false,
    footprint: L.placedFootprint(modelFor(o.model).bounds, L.normalizePlacement(o))
  }));
  const solids = L.selectSolidItems(items);
  const colliders = solids.concat(L.selectOverheadItems(items));
  const limits = L.floorWalkLimits(scene.floor);
  const start = scene.camera.start;

  // The spawn is free standing, and a jump from the spawn lands back on the floor.
  const sim = () => new Sim(colliders, { x: start[0], z: start[2], limits });
  const s0 = sim();
  s0.run(1.2, (i) => ({ space: i === 0 }));
  assert(s0.body.grounded && s0.body.feetY === 0 && s0.landings === 1, 'a jump at the Lobby spawn lands on the floor');
  pass('a jump at the Lobby spawn lands back on the floor');

  // Every wall and hedge piece is a barrier.
  const tall = solids.filter((i) => /^(wall|wallWindow|wallDoorway|wallDoorwayWide|hedge)$/.test(i.name));
  assert(tall.length > 30, 'the Lobby has many wall and hedge pieces');
  tall.forEach((i) => assert(M.isBarrier(i.footprint), i.name + ' must be a barrier (height ' + i.footprint.maxY.toFixed(2) + ')'));
  pass('every Lobby wall and hedge piece is a barrier (' + tall.length + ' pieces)');

  // Low furniture is standable: a crate is a hurdle, the sofa a platform.
  const crates = solids.filter((i) => i.name === 'cardboardBoxClosed');
  crates.forEach((i) => assert(!M.isBarrier(i.footprint) && i.footprint.maxY < 0.4));
  const sofa = solids.find((i) => i.name === 'loungeSofa');
  assert(sofa && !M.isBarrier(sofa.footprint));
  pass('Lobby crates and sofas are hurdles and platforms, not barriers');

  // The river sheet and the round cafe table keep blocking at every height.
  ['riverWater', 'tableRound'].forEach((n) => {
    const hit = solids.filter((i) => i.name === n);
    assert(hit.length > 0, 'the Lobby has ' + n);
    hit.forEach((i) => assert(M.isBarrier(i.footprint), n + ' must stay a boundary'));
  });
  pass('the Lobby river and cafe table keep blocking as before');

  // Robustness: from beside every wall piece, mashing double jumps toward it never gets onto or past it.
  let probed = 0;
  for (const w of tall) {
    const fp = w.footprint;
    // Approach each of the four sides, from 1 m away, aiming at the piece's center.
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const half = [fp.max[0] - fp.min[0], fp.max[1] - fp.min[1]];
      const sx = fp.cx + ox * (half[0] / 2 + 1.0), sz = fp.cz + oz * (half[1] / 2 + 1.0);
      const s = new Sim(colliders, { x: sx, z: sz, limits, jumpSpeed: V * 1.5 });
      if (s.depthAt(sx, sz) > 0) continue; // the start point is inside something else
      let n = 0;
      const heading = [-ox, -oz];
      s.run(1.2, () => { n++; return { walk: heading, space: n % 6 === 1 }; });
      // It must not end up inside the barrier's footprint, nor higher than a hop.
      assert(L.footprintDepth(fp, s.pos[0], s.pos[2], 0) === 0, w.name + ': ended up inside the piece');
      s.settle();
      assert(s.body.grounded && s.body.feetY < M.BARRIER_HEIGHT, w.name + ': settled at feet ' + s.body.feetY.toFixed(2) + ', standing on a barrier');
      probed++;
    }
  }
  assert(probed > 40, 'probed enough approaches, got ' + probed);
  pass('mashing double jumps at ' + probed + ' wall and hedge faces never gets over them');

  // Jump buffs do not change that: x16 jump height against every wall approach, headed outward from the room center.
  const fc = L.floorCenter(scene.floor);
  let escaped = 0;
  for (let ang = 0; ang < 360; ang += 15) {
    const dx = Math.cos((ang * Math.PI) / 180), dz = Math.sin((ang * Math.PI) / 180);
    const s = new Sim(colliders, { x: start[0], z: start[2], limits, jumpSpeed: V * 4 });
    let n = 0;
    s.run(40, () => { n++; return { walk: [dx, dz], space: n % 7 === 1 }; });
    if (L.floorOverrun(limits, s.pos[0], s.pos[2]) > 0) escaped++;
  }
  assert.strictEqual(escaped, 0, 'no heading walked or jumped out of the floor limits');
  pass('headed in 24 directions with x16 jump height, the character never leaves the Lobby floor');
}

// ---------- 15. visible ground layers ----------
{
  // Synthetic: a flat 0.04 layer over x 0..4, z 0..4 (two triangles), with a ramp triangle on its edge.
  const flat = { positions: new Float32Array([0, 0.04, 0, 4, 0.04, 0, 4, 0.04, 4, 0, 0.04, 0, 4, 0.04, 4, 0, 0.04, 4]) };
  const tris = M.collectGroundTriangles([flat], new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), []);
  assert.strictEqual(tris.length, 2);
  assert(Math.abs(M.groundHeightAt(tris, 1, 1) - 0.04) < 1e-9 && Math.abs(M.groundHeightAt(tris, 3.9, 0.1) - 0.04) < 1e-9, 'height inside the layer');
  assert.strictEqual(M.groundHeightAt(tris, 5, 1), 0, 'no layer outside');
  const shifted = M.collectGroundTriangles([flat], L.placementMatrix({ position: [10, 0, 0], rotationYRad: 0, scale: 1 }), []);
  assert(Math.abs(M.groundHeightAt(shifted, 11, 1) - 0.04) < 1e-9 && M.groundHeightAt(shifted, 1, 1) === 0, 'the placement moves the layer');
  const low = { positions: new Float32Array([0, 0.004, 0, 4, 0.004, 0, 4, 0.004, 4]) };
  assert.strictEqual(M.groundHeightAt(M.collectGroundTriangles([low], new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), []), 3, 1), 0, 'a floor texture below the sole depth does not lift');
  pass('ground-layer height is sampled from the layer triangles, placed correctly, and ignores floor textures');

  // The shipped Lobby: only the outdoor layers are ground layers, and the indoor floor and rugs lift nothing.
  const lobbyDir = path.join(REPO, 'demo-domain-a');
  const scene = JSON.parse(fs.readFileSync(path.join(lobbyDir, 'spatial', 'lobby', 'scene.json'), 'utf8'));
  const gtris = [];
  const flagged = new Set();
  for (const o of scene.objects) {
    const buf = fs.readFileSync(path.join(lobbyDir, o.model));
    const { json, bin } = L.parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const model = L.extractPrimitives(json, bin);
    const pl = L.normalizePlacement(o);
    const item = { footprint: L.placedFootprint(model.bounds, pl), solid: o.solid !== false && o.collision !== false };
    if (M.isGroundLayer(item)) { flagged.add(path.basename(o.model, '.glb')); M.collectGroundTriangles(model.primitives, L.placementMatrix(pl), gtris); }
  }
  assert.deepStrictEqual([...flagged].sort(), ['riverBanks', 'townGround', 'townPaths'], 'ground layers are the town ground, paths and river banks, got ' + [...flagged]);
  const at = (x, z) => M.groundHeightAt(gtris, x, z);
  assert.strictEqual(at(0, 2.5), 0, 'indoors lifts nothing');
  assert.strictEqual(at(-2.28, 1.65), 0, 'a rug indoors lifts nothing');
  assert(at(3.2, 8.8) >= 0.03 && at(3.2, 8.8) <= 0.06, 'the paving outside the entrance is lifted by its thickness, got ' + at(3.2, 8.8));
  assert(Math.abs(at(-18, -12) - 0.015) < 0.002, 'bare ground is lifted by its own 0.015, got ' + at(-18, -12));
  assert(Math.abs(at(0.5, 11) - 0.052) < 0.003, 'the thickest paving is lifted by 0.052, got ' + at(0.5, 11));
  assert.strictEqual(at(200, 200), 0, 'nothing beyond the layers');
  pass('Lobby: outdoor paving and ground lift the drawn feet (' + at(3.2, 8.8).toFixed(3) + ' on the paving, ' + at(-18, -12).toFixed(3) + ' on bare ground), indoors and rugs do not');
}

console.log('\nAll ' + checks + ' movement checks passed.');
