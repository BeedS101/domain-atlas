// Mining Burrow checks that need no browser: the side-view movement core (extension/side-view.js), the burrow
// scene, and how the demo domain's manifest and Lobby scene wire the two worlds together.
//
// Covers: walking, walls, jump height, variable jump, jump buffer and coyote time, one-way timber platforms,
// the scene format, that every landmark and the blocked tunnel can be reached on foot from the spawn, that no
// reachable spot is a dead end (the exit can be reached from everywhere), the Lobby trigger and return anchor,
// and that the blocked tunnel is only a marker (no reward, no currency, no inventory change in the scene).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'extension', 'side-view.js'), 'utf8'), {
  window: sandbox.window, document: {}, console, Math, Map, Set, Array, Object, Number, JSON, performance: { now: () => 0 }
});
const SV = sandbox.window.AtlasSideView;
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(REPO, ...p), 'utf8'));

let checks = 0;
function pass(msg) { checks++; console.log('PASS: ' + msg); }

const DT = 1 / 60;
const scene = readJson('demo-domain-a', 'spatial', 'mining-burrow', 'scene.json');
const level = SV.parseLevel(scene);

function sim(p, input, seconds) {
  for (let t = 0; t < seconds - 1e-9; t += DT) SV.step(level, p, input, DT);
  return p;
}
function settle(p) { return sim(p, {}, 2); }
const peakOf = (v) => (v * v) / (2 * SV.GRAVITY);

// ---- a flat test room: floor at y = 5, a wall at x = 8, a one-way platform at y = 3 ----
{
  const rows = [];
  for (let y = 0; y < 6; y += 1) {
    let r = '';
    for (let x = 0; x < 12; x += 1) r += (y === 5 || x === 0 || x === 11 || (x === 8 && y >= 2 && y <= 4)) ? '#' : (y === 3 && x >= 3 && x <= 5 ? '=' : '.');
    rows.push(r);
  }
  const room = SV.parseLevel({ tiles: rows });
  const run = (p, input, s) => { for (let t = 0; t < s - 1e-9; t += DT) SV.step(room, p, input, DT); return p; };

  let p = SV.newPlayer(2, 5);
  run(p, {}, 1);
  assert(p.grounded && Math.abs(p.y - 5) < 1e-3, 'stands on the floor');
  pass('a character dropped on the floor stands on it');

  p = SV.newPlayer(2, 5);
  run(p, { right: true }, 0.5);
  assert(p.x > 2 + 1.5 && p.x < 2 + 2.6, 'walks right at about ' + SV.SPEED + ' tiles per second, got ' + (p.x - 2).toFixed(2));
  assert(p.facing === 1, 'faces the way it walks');
  run(p, { left: true }, 0.2);
  assert(p.facing === -1, 'turns round');
  pass('walking moves at the set speed and faces the walking direction');

  p = SV.newPlayer(6, 5);
  run(p, { right: true }, 2);
  assert(p.x < 8 - SV.BODY_W / 2 + 0.01 && p.x > 8 - SV.BODY_W / 2 - 0.2, 'stops against the left face of the wall, x ' + p.x.toFixed(3));
  p = SV.newPlayer(9.8, 5);
  run(p, { left: true }, 2);
  assert(p.x > 9 + SV.BODY_W / 2 - 0.01 && p.x < 9 + SV.BODY_W / 2 + 0.2, 'stops against the right face of the wall, x ' + p.x.toFixed(3));
  pass('a wall stops walking from either side');

  p = SV.newPlayer(2, 5);
  run(p, {}, 0.3);
  let peak = 5;
  const sample = { jump: true };
  for (let t = 0; t < 1.5; t += DT) { SV.step(room, p, sample, DT); peak = Math.min(peak, p.y); }
  assert(Math.abs((5 - peak) - peakOf(SV.JUMP_V)) < 0.1, 'a held jump rises ' + (5 - peak).toFixed(2) + ', expected ' + peakOf(SV.JUMP_V).toFixed(2));
  assert(peakOf(SV.JUMP_V) > 2.2 && peakOf(SV.JUMP_V) < 2.6, 'the full jump clears two tiles but not three');
  pass('a held jump rises ' + (5 - peak).toFixed(2) + ' tiles and lands');
  run(p, {}, 1);
  assert(p.grounded && Math.abs(p.y - 5) < 1e-3, 'lands back on the floor');

  p = SV.newPlayer(2, 5);
  run(p, {}, 0.3);
  let tapPeak = 5;
  SV.step(room, p, { jump: true }, DT);
  for (let t = 0; t < 1.5; t += DT) { SV.step(room, p, {}, DT); tapPeak = Math.min(tapPeak, p.y); }
  assert(5 - tapPeak < 1.1 && 5 - tapPeak > 0.3, 'a tap gives a short hop, rising ' + (5 - tapPeak).toFixed(2));
  pass('releasing the jump key early shortens the jump (tap rises ' + (5 - tapPeak).toFixed(2) + ')');

  // one-way platform: jump up through it from below and land on it, then walk off and fall
  p = SV.newPlayer(4, 5);
  run(p, {}, 0.3);
  SV.step(room, p, { jump: true }, DT);
  for (let t = 0; t < 1.2; t += DT) SV.step(room, p, { jump: true }, DT);
  assert(p.grounded && Math.abs(p.y - 3) < 1e-3, 'jumped up through the platform and landed on it, y ' + p.y.toFixed(3));
  pass('a one-way timber platform can be jumped up through and stood on');
  run(p, { right: true }, 1.2);
  assert(p.y > 3.5, 'walking off the end drops the character, y ' + p.y.toFixed(3));
  run(p, {}, 1);
  assert(p.grounded && Math.abs(p.y - 5) < 1e-3, 'and it lands on the floor below');

  // standing on the platform, a fall-through is not possible by walking (it holds weight)
  p = SV.newPlayer(4, 3);
  run(p, {}, 1);
  assert(p.grounded && Math.abs(p.y - 3) < 1e-3, 'stands on the platform without sinking');
  pass('a character standing on a platform stays on it');

  // jump buffer: a press just before landing still jumps; coyote: a press just after leaving an edge still jumps
  p = SV.newPlayer(2, 5);
  run(p, {}, 0.3);
  SV.step(room, p, { jump: true }, DT);
  for (let t = 0; t < 0.45; t += DT) SV.step(room, p, {}, DT);
  while (!p.grounded) SV.step(room, p, {}, DT);
  p.jumpHeld = false;
  p.y = 4.2; p.vy = 6; p.grounded = false;
  let jumpedOnLanding = false;
  for (let t = 0; t < 0.4; t += DT) {
    SV.step(room, p, { jump: t < 0.05 || t > 0.05 && p.y > 4.9 }, DT);
    if (p.vy < -5) jumpedOnLanding = true;
  }
  assert(jumpedOnLanding, 'a jump pressed just before landing fires on landing');
  pass('a jump pressed just before landing is remembered');

  p = SV.newPlayer(3.5, 3); // on the platform, then walk off its right end and press jump a moment later
  run(p, {}, 0.3);
  let rose = false, leftAt = null;
  for (let t = 0; t < 2 && !rose; t += DT) {
    const wasGrounded = p.grounded;
    if (wasGrounded === false && leftAt === null) leftAt = t;
    const pressing = leftAt !== null && t - leftAt >= 0.04 && t - leftAt < 0.07;
    SV.step(room, p, { right: true, jump: pressing }, DT);
    if (leftAt !== null && p.vy < -5) rose = true;
  }
  assert(rose, 'a jump a moment after walking off an edge still works');
  pass('a jump a moment after leaving an edge still works (coyote time)');
}

// ---- the burrow scene ----
{
  assert.strictEqual(scene.format, 'sideview-v1', 'scene format');
  assert(level.w >= 40 && level.w <= 100 && level.h >= 16 && level.h <= 40, 'a small level, ' + level.w + ' x ' + level.h);
  assert(level.rows.every((r) => r.length === level.w), 'rows are all the same width');
  const edges = [];
  for (let x = 0; x < level.w; x += 1) { edges.push(level.solid[0][x], level.solid[level.h - 1][x]); }
  for (let y = 0; y < level.h; y += 1) { edges.push(level.solid[y][0], level.solid[y][level.w - 1]); }
  assert(edges.every(Boolean), 'the level is closed all round');
  assert(level.rows.join('').split('').every((c) => '#=B.'.includes(c)), 'only known tile characters');
  let timber = 0, blocked = 0;
  for (const r of level.rows) for (const c of r) { if (c === '=') timber += 1; if (c === 'B') blocked += 1; }
  assert(timber >= 8, 'timber platforms: ' + timber);
  assert(blocked >= 8, 'a blocked tunnel of ' + blocked + ' tiles');
  pass('scene: ' + level.w + ' x ' + level.h + ' tiles, closed, ' + timber + ' timber tiles, ' + blocked + ' blocked-tunnel tiles');

  const sp = SV.newPlayer(scene.spawn[0], scene.spawn[1]);
  settle(sp);
  assert(sp.grounded && Math.abs(sp.y - scene.spawn[1]) < 0.01, 'the spawn stands on the floor, y ' + sp.y);
  assert(!scene.exits.some((e) => SV.rectsOverlap(sp, e.rect)), 'the spawn is outside the exit so the exit is not taken on arrival');
  pass('the spawn is on solid ground and clear of the exit');

  assert(scene.exits.length === 1 && scene.exits[0].portalIndex === 0, 'one exit, manifest portal 0');
  assert(scene.blocked.length === 1, 'one blocked tunnel');
  const b = scene.blocked[0];
  for (let y = b.rect[1]; y < b.rect[1] + b.rect[3]; y += 1) for (let x = b.rect[0]; x < b.rect[0] + b.rect[2]; x += 1) assert(level.blocked[y][x], 'blocked rect tile ' + x + ',' + y + ' is a B tile');
  assert(/pick/i.test(b.hint), 'the hint tells a player what is needed');
  const flat = JSON.stringify(scene);
  for (const word of ['reward', 'mint', 'issue', 'currency', 'credential', 'price', 'monster', 'enemy']) assert(!new RegExp('"' + word, 'i').test(flat), 'the scene carries no ' + word);
  pass('the blocked tunnel is only a marker: hint "' + b.hint.slice(0, 40) + '...", no rewards or economy in the scene');

  // The blocked tunnel really blocks.
  const wp = SV.newPlayer(b.rect[0] - 3, b.rect[1] + b.rect[3]);
  settle(wp);
  sim(wp, { right: true }, 3);
  assert(wp.x < b.rect[0] - SV.BODY_W / 2 + 0.01, 'walking into the blocked tunnel stops at its face, x ' + wp.x.toFixed(2));
  for (let i = 0; i < 6; i += 1) sim(wp, { right: true, jump: i % 2 === 0 }, 0.5);
  assert(wp.x < b.rect[0], 'jumping against it does not get through');
  pass('the blocked tunnel stops walking and jumping');
}

// ---- reachability on foot: macro-moves from the spawn ----
{
  const key = (p) => Math.round(p.x * 4) + ',' + p.y.toFixed(1);
  const clone = (p) => Object.assign({}, p);
  function simulate(p, plan) {
    // plan: { dir, walk (s), jump (bool), hold (s of jump key), airWalk (s of direction held, from start) }
    const q = clone(p);
    q.jumpHeld = false;
    let t = 0;
    const T = 3;
    let landed = false;
    while (t < T) {
      const input = {
        left: plan.dir < 0 && t < plan.dirFor,
        right: plan.dir > 0 && t < plan.dirFor,
        jump: !!plan.jump && t < plan.hold
      };
      SV.step(level, q, input, DT);
      t += DT;
      if (t > plan.dirFor + 0.15 && t > (plan.jump ? plan.hold : 0) + 0.05 && q.grounded && Math.abs(q.vy) < 1e-6 && Math.abs(q.vx) < 0.05) { landed = true; break; }
    }
    return landed ? q : null;
  }
  const plans = [];
  for (const dir of [-1, 1]) for (const dirFor of [0.08, 0.2, 0.35, 0.5, 0.7, 1.0, 1.5, 2.5]) {
    plans.push({ dir, dirFor, jump: false, hold: 0 });
    for (const hold of [0.12, 0.45]) plans.push({ dir, dirFor, jump: true, hold });
  }
  for (const hold of [0.12, 0.45]) plans.push({ dir: 0, dirFor: 0, jump: true, hold });

  const start = SV.newPlayer(scene.spawn[0], scene.spawn[1]);
  settle(start);
  const nodes = new Map();
  const edges = new Map();
  nodes.set(key(start), start);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    const ck = key(cur);
    if (!edges.has(ck)) edges.set(ck, new Set());
    for (const plan of plans) {
      const nxt = simulate(cur, plan);
      if (!nxt) continue;
      const nk = key(nxt);
      edges.get(ck).add(nk);
      if (!nodes.has(nk)) { nodes.set(nk, nxt); queue.push(nxt); }
    }
    if (nodes.size > 5000) break;
  }
  const reached = [...nodes.values()];
  assert(reached.length > 100, 'explored ' + reached.length + ' standing spots');

  // every landmark has somewhere to stand near it
  for (const lm of scene.landmarks) {
    const near = reached.some((p) => Math.abs(p.x - lm.x) < 3 && Math.abs((p.y - 1) - lm.y) < 3);
    assert(near, 'landmark "' + lm.label + '" can be reached on foot');
  }
  pass('all ' + scene.landmarks.length + ' landmarks can be reached on foot from the spawn (' + reached.length + ' standing spots explored)');

  // the exit
  const ex = scene.exits[0].rect;
  const touchesExit = (p) => SV.rectsOverlap(p, ex);
  // standing spots from which one walk step touches the exit
  const exitSpots = new Set();
  for (const [k, p] of nodes) {
    const q = clone(p); q.jumpHeld = false;
    let hit = false;
    for (let t = 0; t < 1.5 && !hit; t += DT) { SV.step(level, q, { left: true }, DT); if (touchesExit(q)) hit = true; }
    if (hit) exitSpots.add(k);
  }
  assert(exitSpots.size > 0, 'the exit can be reached on foot from the spawn');

  // from everywhere reachable, the exit spots can be reached again: no dead ends or traps
  const rev = new Map();
  for (const [from, tos] of edges) for (const to of tos) { if (!rev.has(to)) rev.set(to, new Set()); rev.get(to).add(from); }
  const canExit = new Set(exitSpots);
  const stack = [...exitSpots];
  while (stack.length) { const k = stack.pop(); for (const f of rev.get(k) || []) if (!canExit.has(f)) { canExit.add(f); stack.push(f); } }
  const trapped = [...nodes.keys()].filter((k) => !canExit.has(k));
  assert.strictEqual(trapped.length, 0, trapped.length + ' reachable spots cannot get back to the exit, e.g. ' + trapped.slice(0, 5).map((k) => k + ' (' + nodes.get(k).x.toFixed(1) + ',' + nodes.get(k).y.toFixed(1) + ')').join(' '));
  pass('from every one of the ' + nodes.size + ' reachable standing spots the way back to the exit exists: no traps');

  // the deepest spot and the blocked tunnel's face are reachable
  const b = scene.blocked[0];
  assert(reached.some((p) => Math.abs(p.y - (b.rect[1] + b.rect[3])) < 0.01 && p.x > b.rect[0] - 2.5 && p.x < b.rect[0]), 'a character can stand at the face of the blocked tunnel');
  assert(reached.some((p) => p.y <= 7.01), 'the high lookout can be reached');
  assert(reached.some((p) => p.y >= 18.99), 'the lower tunnel can be reached');
  pass('the lookout, the lower tunnel and the face of the blocked tunnel can all be stood on');

  // never inside rock
  for (const p of reached) {
    const tx0 = Math.floor(p.x - SV.BODY_W / 2 + 1e-3), tx1 = Math.floor(p.x + SV.BODY_W / 2 - 1e-3);
    for (let tx = tx0; tx <= tx1; tx += 1) for (let ty = Math.floor(p.y - SV.BODY_H + 1e-3); ty < Math.floor(p.y - 1e-3) + 1; ty += 1) {
      assert(!level.solid[ty][tx], 'standing at ' + p.x.toFixed(2) + ',' + p.y.toFixed(2) + ' overlaps rock at ' + tx + ',' + ty);
    }
  }
  pass('no reachable position overlaps rock');
}

// ---- manifest and Lobby wiring ----
{
  const manifest = readJson('demo-domain-a', '.well-known', 'spatial.json');
  const lobby = manifest.worlds.find((w) => w.id === 'lobby');
  const burrow = manifest.worlds.find((w) => w.id === 'mining-burrow');
  assert(lobby && burrow, 'both worlds are declared');
  assert.deepStrictEqual(burrow.entry.renderer, ['sideview-v1'], 'the burrow uses the side-view renderer');
  assert.strictEqual(burrow.entry.scene, '/spatial/mining-burrow/scene.json');
  assert(fs.existsSync(path.join(REPO, 'demo-domain-a', 'spatial', 'mining-burrow', 'scene.json')));
  assert.strictEqual(burrow.policy.itemDropsAllowed, false, 'nothing can be dropped in the burrow');
  assert.deepStrictEqual(burrow.policy.itemEffects, lobby.policy.itemEffects, 'the burrow applies the same item effects as the Lobby');
  assert.deepStrictEqual(burrow.policy.acceptedItemClasses, lobby.policy.acceptedItemClasses);
  assert.strictEqual(burrow.policy.trustedIssuers, lobby.policy.trustedIssuers);
  assert.strictEqual(burrow.policy.identityRequired, false, 'no identity needed to look around');
  assert.strictEqual(burrow.profile.capabilities.combat, 'none');

  const lobbyPortal = lobby.portals[1];
  assert.deepStrictEqual(lobbyPortal, { kind: 'world', to: 'mining-burrow', label: 'Enter the Mining Burrow' });
  assert.strictEqual(lobby.portals[0].to, 'plaza', 'the existing Plaza portal keeps its index');
  const back = burrow.portals[scene.exits[0].portalIndex];
  assert(back.kind === 'world' && back.to === 'lobby' && back.anchor === 'mine-entrance', 'the burrow exit returns to the Lobby at the mine entrance');
  pass('manifest: Lobby portal 1 enters the burrow, burrow portal 0 returns to the Lobby at "mine-entrance"');

  const ls = readJson('demo-domain-a', 'spatial', 'lobby', 'scene.json');
  assert.strictEqual(ls.portalMarkers.length, 2);
  assert.deepStrictEqual(ls.portalMarkers[0], { position: [0, 0, 4.7], radius: 0.8, portalIndex: 0, hideMarker: true }, 'the Plaza gate marker is unchanged');
  const mk = ls.portalMarkers[1];
  assert.strictEqual(mk.portalIndex, 1);
  const anchor = ls.anchors.find((a) => a.id === 'mine-entrance');
  assert(anchor, 'the Lobby has the mine-entrance anchor');
  assert(ls.anchors.find((a) => a.id === 'reading-nook'), 'the existing anchor is unchanged');
  const planar = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
  assert(planar(anchor.position, mk.position) > mk.radius + 0.5, 'the return point is clear of the trigger by ' + (planar(anchor.position, mk.position) - mk.radius).toFixed(2));
  assert.strictEqual(anchor.yaw, 180, 'the character comes out facing away from the hill');
  // the trigger sits on the open ground in front of the mouth: mine geometry from tools/lib/lobby-town-layout.js
  const L = require(path.join(REPO, 'tools', 'lib', 'lobby-town-layout.js'));
  const M = L.MINE || L.mine;
  if (M) {
    assert(Math.abs(mk.position[0] - M.entranceX) < 0.5, 'the trigger is in line with the mine mouth');
    assert(mk.position[2] > M.maxZ - 0.2 && mk.position[2] < M.maxZ + 1.5, 'the trigger is in front of the hill face (z ' + mk.position[2] + ', face ' + M.maxZ + ')');
  }
  const near = (ls.objects || []).filter((o) => o.position && Math.hypot(o.position[0] - mk.position[0], o.position[2] - mk.position[2]) < 0.7 && o.position[1] === 0);
  assert.strictEqual(near.length, 0, 'no placed object sits on the trigger');
  pass('Lobby scene: trigger at (' + mk.position[0] + ', ' + mk.position[2] + ') in front of the mine mouth, return anchor ' + planar(anchor.position, mk.position).toFixed(1) + ' away facing out');
}

console.log('\nAll ' + checks + ' Mining Burrow checks passed.');
