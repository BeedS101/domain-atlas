#!/usr/bin/env node
// Action bar (extension/action-bar.js), pure logic: slot layout, key routing, tap and hold on the selector
// slots, selection state, and the rule that nothing here uses or spends an item.
//   node test/action-bar.js
const fs = require('fs');
const path = require('path');
const ab = require('../extension/action-bar.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS: ' + name);
  else { failures += 1; console.log('FAIL: ' + name + (detail ? ' ' + detail : '')); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A model with a manual clock: timers fire only when the test says so.
function rig() {
  const events = [];
  const timers = [];
  const clock = { t: 0 };
  const model = ab.createModel({
    emit: (e) => events.push(e),
    now: () => clock.t,
    setTimer: (fn, ms) => { const t = { fn, ms, dead: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.dead = true; }
  });
  const fire = () => { const t = timers.find((x) => !x.dead); if (t) { t.dead = true; t.fn(); } return !!t; };
  const key = (code, extra) => model.handleKeyDown(Object.assign({ code }, extra || {}), false);
  const up = (code) => model.handleKeyUp({ code });
  const types = () => events.map((e) => e.type + (e.phase ? ':' + e.phase : ''));
  const last = () => events[events.length - 1];
  return { model, events, timers, fire, key, up, types, last, clock };
}
const opts = (n) => Array.from({ length: n }, (_, i) => ({ id: 'item-' + i, label: 'Item ' + i, sub: 'atlas.test.item' + i }));

console.log('STEP: layout');
check('ten slots on 1 2 3 4 5 6 7 8 9 0', same(ab.SLOTS.map((s) => s.key), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']));
check('slot ids and kinds follow the control scheme', same(ab.SLOTS.map((s) => s.id), ['strike-right', 'strike-left', 'kick-right', 'kick-left', 'block', 'item-left', 'item-right', 'potion', 'reserved-9', 'reserved-0']) &&
  same(ab.SLOTS.map((s) => s.kind), ['action', 'action', 'action', 'action', 'action', 'selector', 'selector', 'selector', 'reserved', 'reserved']));
check('codes map to slots, other codes to none', ab.slotForCode('Digit1') === 0 && ab.slotForCode('Digit0') === 9 && ab.slotForCode('KeyW') === -1 && ab.slotForCode('Numpad1') === -1);
check('the hold time is 350 ms', ab.HOLD_MS === 350);

console.log('STEP: typing targets');
const el = (tag, extra) => Object.assign({ tagName: tag }, extra);
check('text fields, textareas, selects and editable content are typing targets',
  ab.isTypingTarget(el('INPUT', { type: 'text' })) && ab.isTypingTarget(el('INPUT', { type: 'password' })) && ab.isTypingTarget(el('INPUT', {})) && ab.isTypingTarget(el('TEXTAREA')) && ab.isTypingTarget(el('SELECT')) && ab.isTypingTarget(el('DIV', { isContentEditable: true })));
check('buttons, checkboxes and other elements are not', !ab.isTypingTarget(el('BUTTON')) && !ab.isTypingTarget(el('INPUT', { type: 'checkbox' })) && !ab.isTypingTarget(el('DIV')) && !ab.isTypingTarget(null));

console.log('STEP: keys 1-5');
{
  const r = rig();
  r.key('Digit1'); r.up('Digit1');
  r.key('Digit2'); r.up('Digit2');
  r.key('Digit3'); r.up('Digit3');
  r.key('Digit4'); r.up('Digit4');
  check('1-4 report a start then an end for their own action', same(r.events.filter((e) => e.phase === 'start').map((e) => e.id), ['strike-right', 'strike-left', 'kick-right', 'kick-left']) && r.events.filter((e) => e.phase === 'end').length === 4);
  r.events.length = 0;
  r.key('Digit5');
  check('5 starts block and block stays on while the key is held', same(r.types(), ['action:start']) && r.model.isDown(4));
  r.key('Digit5', { repeat: true });
  check('key repeat does not retrigger', r.events.length === 1);
  r.up('Digit5');
  check('releasing 5 ends the block', same(r.types(), ['action:start', 'action:end']) && !r.model.isDown(4));
}

console.log('STEP: routing rules');
{
  const r = rig();
  const blocked = r.model.handleKeyDown({ code: 'Digit1' }, true);
  check('a blocked key press does nothing', !blocked.handled && r.events.length === 0);
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) r.key('Digit1', { [mod]: true });
  check('Ctrl, Meta and Alt combinations are left to the browser', r.events.length === 0);
  check('keys that are not slots are not handled', !r.key('KeyW').handled && !r.key('Space').handled && r.events.length === 0);
  r.key('Digit5');
  r.model.handleKeyDown({ code: 'Digit1' }, true);
  r.up('Digit5');
  check('a release always works, even after the context became blocked', r.events.filter((e) => e.id === 'block' && e.phase === 'end').length === 1);
  const r2 = rig();
  r2.key('Digit5'); r2.key('Digit6');
  r2.model.cancelAll();
  check('cancelAll ends a held block and a pending hold without selecting anything', r2.events.filter((e) => e.id === 'block' && e.phase === 'end').length === 1 && r2.timers.every((t) => t.dead) && r2.model.selectedId('item-left') === null && !r2.fire());
  const r3 = rig();
  r3.key('Digit9'); r3.up('Digit9'); r3.key('Digit0'); r3.up('Digit0');
  check('9 and 0 are reserved and do nothing yet', same(r3.types(), ['reserved', 'reserved']));
}

console.log('STEP: tap cycles the selection');
{
  const r = rig();
  r.model.setOptions('item-left', opts(2));
  r.events.length = 0;
  const tap = () => { r.key('Digit6'); r.up('Digit6'); return r.model.selectedId('item-left'); };
  check('the first tap selects the first option', tap() === 'item-0');
  check('the next tap moves on', tap() === 'item-1');
  check('then comes none', tap() === null);
  check('and it wraps to the first again', tap() === 'item-0');
  check('a tap is only a tap: no selector opened, no hold timer left running', r.events.every((e) => e.type === 'tap') && r.timers.every((t) => t.dead));
  check('the hold timer was armed at 350 ms', r.timers.every((t) => t.ms === 350));
  const empty = rig();
  empty.key('Digit8'); empty.up('Digit8');
  check('with nothing eligible a tap leaves the selection empty', empty.model.selectedId('potion') === null);
  check('slots keep their own selections', (() => { const q = rig(); q.model.setOptions('item-left', opts(1)); q.model.setOptions('item-right', opts(2)); q.key('Digit6'); q.up('Digit6'); q.key('Digit7'); q.up('Digit7'); q.key('Digit7'); q.up('Digit7'); return q.model.selectedId('item-left') === 'item-0' && q.model.selectedId('item-right') === 'item-1'; })());
}

console.log('STEP: hold opens the selector');
{
  const r = rig();
  r.model.setOptions('item-right', opts(3));
  r.key('Digit7');
  check('nothing opens before the hold time', !r.model.isOpen() && r.events.length === 1);
  check('the timer fires: the selector opens at the current selection', r.fire() && r.model.isOpen() && r.last().type === 'selector-open' && r.last().cursor === 3);
  r.up('Digit7');
  check('releasing after the hold neither taps nor closes it', r.model.isOpen() && !r.events.some((e) => e.type === 'tap') && r.model.selectedId('item-right') === null);
  r.key('ArrowDown');
  check('arrows move the cursor and wrap', r.model.isOpen().cursor === 0 && r.last().type === 'selector-move');
  r.key('ArrowDown'); r.key('ArrowRight');
  check('the cursor walks through the options', r.model.isOpen().cursor === 2);
  check('moving does not select', r.model.selectedId('item-right') === null);
  const k = r.key('Enter');
  check('Enter confirms the cursor choice, closes, and swallows the key', k.prevent && !r.model.isOpen() && r.model.selectedId('item-right') === 'item-2' && r.last().type === 'selector-confirm');
  r.key('Digit7'); r.fire(); r.up('Digit7');
  check('reopening starts at the current selection', r.model.isOpen().cursor === 2);
  const esc = r.key('Escape');
  check('Escape cancels without changing the selection and is swallowed', esc.prevent && !r.model.isOpen() && r.model.selectedId('item-right') === 'item-2' && r.last().type === 'selector-cancel');
  r.key('Digit7'); r.fire(); r.up('Digit7');
  r.key('ArrowUp'); r.key('ArrowUp'); r.key('ArrowUp');
  r.key('Space');
  check('Space also confirms, and "none" can be chosen', r.model.selectedId('item-right') === null && !r.model.isOpen());
  const c = rig();
  c.model.setOptions('item-left', opts(2));
  c.key('Digit6'); c.fire(); c.up('Digit6');
  c.model.confirm(1);
  check('a click on a row confirms that row', c.model.selectedId('item-left') === 'item-1' && !c.model.isOpen());
  c.key('Digit6'); c.fire(); c.up('Digit6');
  c.model.confirm(2);
  check('the last row is none', c.model.selectedId('item-left') === null);
  const t = rig();
  t.model.setOptions('item-left', opts(2));
  t.key('Digit6'); t.fire(); t.up('Digit6');
  t.key('Digit6'); t.up('Digit6');
  check('pressing the open slot key again moves the cursor on (from none, to the first option)', t.model.isOpen().cursor === 0);
  t.key('Digit7');
  check('another slot key closes the selector and is then handled', !t.model.isOpen() && t.model.isDown(6));
  const m = rig();
  m.model.setOptions('item-left', opts(1));
  m.key('Digit6'); m.fire(); m.up('Digit6');
  const w = m.key('KeyW');
  check('movement keys pass through an open selector', !w.handled && !w.prevent && !!m.model.isOpen());
  m.model.handleKeyDown({ code: 'KeyA' }, true);
  check('a blocked context (wallet opened) closes it', !m.model.isOpen() && m.last().type === 'selector-cancel');
}

console.log('STEP: a stalled page');
{
  const r = rig();
  r.model.setOptions('item-left', opts(2));
  r.key('Digit6');
  r.clock.t = 450; // the release arrives before the timer callback gets to run
  r.up('Digit6');
  check('a release after the hold time opens the selector instead of tapping', !!r.model.isOpen() && r.model.selectedId('item-left') === null && !r.events.some((e) => e.type === 'tap') && r.timers.every((t) => t.dead));
  const q = rig();
  q.model.setOptions('item-left', opts(2));
  q.key('Digit6');
  q.clock.t = 349;
  q.up('Digit6');
  check('a release just under the hold time is still a tap', !q.model.isOpen() && q.model.selectedId('item-left') === 'item-0');
}

console.log('STEP: option changes');
{
  const r = rig();
  r.model.setOptions('potion', opts(2));
  r.key('Digit8'); r.up('Digit8');
  check('a potion is selected', r.model.selectedId('potion') === 'item-0');
  r.model.setOptions('potion', [{ id: 'item-1', label: 'Other' }]);
  check('an item that left the wallet is dropped from the selection', r.model.selectedId('potion') === null);
  r.model.setOptions('potion', [{ id: 'x', label: 'X' }, { bad: true }, null, { id: 5 }]);
  check('malformed options are ignored', r.model.options('potion').length === 1);
  r.model.setOptions('block', [{ id: 'x' }]);
  check('only selector slots take options', same(r.model.options('block'), []));
}

console.log('STEP: selecting never uses anything');
{
  const r = rig();
  r.model.setOptions('item-left', opts(2));
  r.model.setOptions('potion', opts(2));
  for (let i = 0; i < 3; i += 1) { r.key('Digit6'); r.up('Digit6'); }
  r.key('Digit8'); r.fire(); r.up('Digit8'); r.key('Enter');
  check('taps, holds and confirms never raise a use request', !r.events.some((e) => e.type === 'use-request'));
  const u = rig();
  u.model.setOptions('item-left', opts(1));
  u.key('Digit6'); u.up('Digit6');
  u.events.length = 0;
  const armed = u.timers.length;
  u.key('Digit6', { shiftKey: true });
  check('Shift + key is the separate, explicit use request, with no hold timer and no selector', same(u.types(), ['use-request']) && u.last().selected === 'item-0' && u.timers.length === armed && !u.model.isOpen());
  u.up('Digit6');
  check('and releasing it does not also cycle the selection', u.model.selectedId('item-left') === 'item-0' && u.events.length === 1);
  check('use requests need a selector slot', !u.model.requestUse(0) && u.model.requestUse(5));
  check('a use request does not change the selection', u.model.selectedId('item-left') === 'item-0');
  const p = rig();
  p.key('Digit1', { shiftKey: true });
  check('Shift on an action slot is still just that action', same(p.types(), ['action:start']));
}

console.log('STEP: the module has no way to affect a wallet or the network');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'action-bar.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  check('no wallet, storage, network or messaging calls', !/AtlasWallet|chrome\.|fetch\(|XMLHttpRequest|WebSocket|postMessage|localStorage/.test(code));
}

console.log(failures ? '\nACTION BAR CHECKS FAILED (' + failures + ')' : '\nACTION BAR CHECKS PASSED');
process.exit(failures ? 1 : 0);
