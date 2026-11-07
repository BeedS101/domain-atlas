// Action bar (prototype): ten slots on keys 1 2 3 4 5 6 7 8 9 0, shared by the 2D and 3D viewers.
//
// Everything here is local and cosmetic. Keys 1-5 only report that a pose or flash should play; keys 6-8
// choose which wallet item the bar is "holding" for that slot. Selecting never equips, uses or spends an
// item, and the explicit use request (Shift + 6/7/8, or Shift-click) only raises an event: nothing in this
// file, or anything listening to it so far, spends, hits, mines or rewards anything.
//
// Two layers:
//   createModel(opts)      pure state and input logic, no DOM; opts.emit(event), opts.holdMs, opts.setTimer,
//                          opts.clearTimer (replaceable for tests)
//   create(parent, opts)   a model plus the bar's DOM; also dispatches each event as 'atlas-action-bar' on window
//
// Model events (all plain objects with `type`):
//   action          { slot, id, phase: 'start' | 'end' }       keys 1-5
//   reserved        { slot }                                    keys 9 and 0, nothing bound yet
//   tap             { slot, id, selected }                      6-8 tapped: the selection moved to the next option
//   selector-open   { slot, id, cursor }                        6-8 held for holdMs
//   selector-move   { slot, id, cursor }
//   selector-confirm{ slot, id, selected }                      records the choice only
//   selector-cancel { slot, id }
//   use-request     { slot, id, selected }                      explicit, separate from selecting; no effect
//   options         { slot, id, count }                         the eligible items changed
//
// Key routing: handleKeyDown(e, blocked) / handleKeyUp(e). `blocked` is computed by the host (typing in a
// field, wallet or Character window open, a modal showing); a blocked key press is ignored, and a selector
// that is open is closed.

(function (root) {
  'use strict';

  const HOLD_MS = 350;

  // `code` is the KeyboardEvent.code that triggers the slot.
  const SLOTS = Object.freeze([
    { index: 0, key: '1', code: 'Digit1', id: 'strike-right', kind: 'action', label: 'Right strike', short: 'R Strike' },
    { index: 1, key: '2', code: 'Digit2', id: 'strike-left', kind: 'action', label: 'Left strike', short: 'L Strike' },
    { index: 2, key: '3', code: 'Digit3', id: 'kick-right', kind: 'action', label: 'Right kick', short: 'R Kick' },
    { index: 3, key: '4', code: 'Digit4', id: 'kick-left', kind: 'action', label: 'Left kick', short: 'L Kick' },
    { index: 4, key: '5', code: 'Digit5', id: 'block', kind: 'action', label: 'Block', short: 'Block', hold: true },
    { index: 5, key: '6', code: 'Digit6', id: 'item-left', kind: 'selector', label: 'Left-hand item', short: 'L Item', empty: 'No left-hand item in your wallet' },
    { index: 6, key: '7', code: 'Digit7', id: 'item-right', kind: 'selector', label: 'Right-hand item', short: 'R Item', empty: 'No right-hand item in your wallet' },
    { index: 7, key: '8', code: 'Digit8', id: 'potion', kind: 'selector', label: 'Potion', short: 'Potion', empty: 'No potion in your wallet' },
    { index: 8, key: '9', code: 'Digit9', id: 'reserved-9', kind: 'reserved', label: 'Reserved', short: '' },
    { index: 9, key: '0', code: 'Digit0', id: 'reserved-0', kind: 'reserved', label: 'Reserved', short: '' }
  ]);

  function slotForCode(code) {
    for (const s of SLOTS) if (s.code === code) return s.index;
    return -1;
  }

  // Fields where typed characters mean text. Mirrors what the 3D renderer treats as typing.
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    return TEXT_INPUT_TYPES.has(String(el.type || 'text').toLowerCase());
  }

  function createModel(opts) {
    opts = opts || {};
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const holdMs = Number.isFinite(opts.holdMs) ? opts.holdMs : HOLD_MS;
    const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
    const now = opts.now || (() => Date.now());

    const options = {};   // slot id -> [{ id, label, sub }]
    const selected = {};  // slot id -> option id | null
    const down = new Map(); // slot index -> { timer, opened, shift }
    let open = null;      // { index, cursor } while a selector is showing

    const slotOf = (i) => SLOTS[i];
    const optionsOf = (id) => options[id] || [];
    const selectedOf = (id) => (selected[id] === undefined ? null : selected[id]);
    // The choices are the eligible items followed by "none".
    const choiceCount = (id) => optionsOf(id).length + 1;
    const idAtChoice = (id, n) => (n < optionsOf(id).length ? optionsOf(id)[n].id : null);
    const choiceOf = (id) => {
      const at = optionsOf(id).findIndex((o) => o.id === selectedOf(id));
      return at < 0 ? optionsOf(id).length : at;
    };

    function setOptions(id, list) {
      const slot = SLOTS.find((s) => s.id === id);
      if (!slot || slot.kind !== 'selector') return;
      const clean = (Array.isArray(list) ? list : []).filter((o) => o && typeof o.id === 'string').map((o) => ({ id: o.id, label: String(o.label || o.id), sub: o.sub ? String(o.sub) : '' }));
      options[id] = clean;
      if (selectedOf(id) !== null && !clean.some((o) => o.id === selectedOf(id))) selected[id] = null; // the item left the wallet
      if (open && open.index === slot.index) open.cursor = Math.min(open.cursor, choiceCount(id) - 1);
      emit({ type: 'options', slot: slot.index, id, count: clean.length });
    }

    function closeSelector(type) {
      if (!open) return;
      const s = slotOf(open.index);
      open = null;
      if (type) emit({ type, slot: s.index, id: s.id });
    }

    function press(index, mods) {
      const slot = slotOf(index);
      if (!slot || down.has(index)) return false;
      mods = mods || {};
      if (slot.kind === 'reserved') {
        down.set(index, {});
        emit({ type: 'reserved', slot: index });
        return true;
      }
      if (slot.kind === 'action') {
        down.set(index, {});
        emit({ type: 'action', slot: index, id: slot.id, phase: 'start' });
        return true;
      }
      // Selector slots.
      if (open && open.index !== index) closeSelector('selector-cancel');
      if (open && open.index === index) {
        // Pressing the open slot's own key moves the cursor on.
        down.set(index, { opened: true });
        open.cursor = (open.cursor + 1) % choiceCount(slot.id);
        emit({ type: 'selector-move', slot: index, id: slot.id, cursor: open.cursor });
        return true;
      }
      if (mods.shift) {
        down.set(index, { used: true });
        emit({ type: 'use-request', slot: index, id: slot.id, selected: selectedOf(slot.id) });
        return true;
      }
      const state = { opened: false, at: now() };
      state.timer = setTimer(() => {
        state.timer = null;
        if (!down.has(index) || down.get(index) !== state) return;
        openSelector(index, state);
      }, holdMs);
      down.set(index, state);
      return true;
    }

    function openSelector(index, state) {
      state.opened = true;
      open = { index, cursor: choiceOf(SLOTS[index].id) };
      emit({ type: 'selector-open', slot: index, id: SLOTS[index].id, cursor: open.cursor });
    }

    function release(index) {
      const slot = slotOf(index);
      const state = down.get(index);
      if (!slot || !state) return false;
      down.delete(index);
      if (slot.kind === 'action') {
        emit({ type: 'action', slot: index, id: slot.id, phase: 'end' });
      } else if (slot.kind === 'selector' && state.timer) {
        // Released before the hold time: a tap moves the selection to the next option.
        clearTimer(state.timer);
        state.timer = null;
        if (now() - state.at >= holdMs) {
          // A busy page can deliver the key release before the hold timer runs; the key was held long enough.
          openSelector(index, state);
        } else if (!state.used) {
          const n = (choiceOf(slot.id) + 1) % choiceCount(slot.id);
          selected[slot.id] = idAtChoice(slot.id, n);
          emit({ type: 'tap', slot: index, id: slot.id, selected: selected[slot.id] });
        }
      }
      return true;
    }

    // Ends everything in progress without choosing anything (focus lost, world change, wallet opened).
    function cancelAll() {
      for (const [index, state] of Array.from(down.entries())) {
        if (state.timer) { clearTimer(state.timer); state.timer = null; }
        if (SLOTS[index].kind === 'action') emit({ type: 'action', slot: index, id: SLOTS[index].id, phase: 'end' });
        down.delete(index);
      }
      closeSelector('selector-cancel');
    }

    function moveCursor(dir) {
      if (!open) return false;
      const slot = slotOf(open.index);
      const n = choiceCount(slot.id);
      open.cursor = (open.cursor + (dir < 0 ? -1 : 1) + n) % n;
      emit({ type: 'selector-move', slot: open.index, id: slot.id, cursor: open.cursor });
      return true;
    }

    // Records the cursor's choice as the slot's selection. It does not equip, use or spend anything.
    function confirm(choice) {
      if (!open) return false;
      const slot = slotOf(open.index);
      const at = Number.isInteger(choice) ? Math.max(0, Math.min(choiceCount(slot.id) - 1, choice)) : open.cursor;
      selected[slot.id] = idAtChoice(slot.id, at);
      open = null;
      emit({ type: 'selector-confirm', slot: slot.index, id: slot.id, selected: selected[slot.id] });
      return true;
    }

    function cancel() {
      if (!open) return false;
      closeSelector('selector-cancel');
      return true;
    }

    // Explicit use request for a selector slot (the click path; the keyboard path is Shift + key).
    function requestUse(index) {
      const slot = slotOf(index);
      if (!slot || slot.kind !== 'selector') return false;
      emit({ type: 'use-request', slot: index, id: slot.id, selected: selectedOf(slot.id) });
      return true;
    }

    // Returns { handled, prevent }: handled means the bar took the key; prevent means the host should stop it
    // reaching anything else (movement, the wallet's Escape).
    function handleKeyDown(e, blocked) {
      if (blocked) {
        if (open) closeSelector('selector-cancel');
        return { handled: false, prevent: false };
      }
      if (open) {
        switch (e.code) {
          case 'ArrowUp': case 'ArrowLeft': moveCursor(-1); return { handled: true, prevent: true };
          case 'ArrowDown': case 'ArrowRight': moveCursor(1); return { handled: true, prevent: true };
          case 'Enter': case 'NumpadEnter': case 'Space': if (!e.repeat) confirm(); return { handled: true, prevent: true };
          case 'Escape': cancel(); return { handled: true, prevent: true };
          default: break;
        }
        const i = slotForCode(e.code);
        if (i === open.index && !(e.ctrlKey || e.metaKey || e.altKey)) { if (!e.repeat) press(i, {}); return { handled: true, prevent: true }; }
        // Another slot's key closes the selector and is then handled normally below; any other key (movement
        // included) leaves the selector open and keeps working normally.
        if (i < 0) return { handled: false, prevent: false };
        cancel();
      }
      const i = slotForCode(e.code);
      if (i < 0 || e.ctrlKey || e.metaKey || e.altKey) return { handled: false, prevent: false };
      if (e.repeat) return { handled: true, prevent: false };
      press(i, { shift: !!e.shiftKey });
      return { handled: true, prevent: false };
    }

    function handleKeyUp(e) {
      const i = slotForCode(e.code);
      if (i < 0 || !down.has(i)) return { handled: false };
      release(i);
      return { handled: true };
    }

    return {
      SLOTS, press, release, cancelAll, moveCursor, confirm, cancel, requestUse, handleKeyDown, handleKeyUp, setOptions,
      isOpen: () => (open ? { index: open.index, id: slotOf(open.index).id, cursor: open.cursor } : null),
      isDown: (index) => down.has(index),
      selectedId: selectedOf,
      options: optionsOf,
      state: () => ({ selected: Object.assign({}, selected), open: open ? { index: open.index, cursor: open.cursor } : null, down: Array.from(down.keys()) })
    };
  }

  // ---------- DOM ----------

  const STYLE_ID = 'atlas-action-bar-style';
  function injectStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#actionBar{position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:8;display:none;flex-direction:column;align-items:center;gap:6px;font:600 11px system-ui,sans-serif;color:#e8f0f2;user-select:none}' +
      '#actionBar.shown{display:flex}' +
      '#actionBar .ab-row{display:flex;gap:4px;padding:5px;background:rgba(20,31,38,0.88);border:1px solid #2c3c44;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,0.4)}' +
      '#actionBar .ab-slot{position:relative;width:50px;height:46px;box-sizing:border-box;border:1px solid #3a4b54;border-radius:7px;background:#16222a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;cursor:pointer;padding:2px}' +
      '#actionBar .ab-slot .ab-key{position:absolute;left:4px;top:2px;font-size:10px;color:#8fa4ad}' +
      '#actionBar .ab-slot .ab-name{font-size:10px;line-height:1.1;text-align:center;white-space:nowrap;margin-top:8px}' +
      '#actionBar .ab-slot .ab-pick{max-width:46px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;color:#ffd27a;font-weight:500;min-height:10px}' +
      '#actionBar .ab-slot.reserved{opacity:0.4;cursor:default}' +
      '#actionBar .ab-slot.firing{background:#2c5d4d;border-color:#6fd1a8;transform:translateY(-2px)}' +
      '#actionBar .ab-slot.holding{background:#2c4a5d;border-color:#7ab8e0}' +
      '#actionBar .ab-slot.armed{border-color:#ffd27a}' +
      '#actionBar .ab-selector{position:absolute;bottom:62px;min-width:190px;max-width:260px;max-height:220px;overflow-y:auto;background:rgba(14,22,27,0.97);border:1px solid #4a6270;border-radius:8px;padding:6px;box-shadow:0 4px 14px rgba(0,0,0,0.5);display:none;text-align:left}' +
      '#actionBar .ab-selector.open{display:block}' +
      '#actionBar .ab-selector .ab-title{font-size:11px;color:#a9b8bf;margin-bottom:4px}' +
      '#actionBar .ab-selector .ab-opt{padding:4px 6px;border-radius:5px;cursor:pointer;font-weight:500;font-size:12px;display:flex;flex-direction:column}' +
      '#actionBar .ab-selector .ab-opt.cursor{background:#2c4a5d}' +
      '#actionBar .ab-selector .ab-opt.current .ab-oname::after{content:" (selected)";color:#ffd27a;font-size:10px}' +
      '#actionBar .ab-selector .ab-osub{font-size:10px;color:#8fa4ad}' +
      '#actionBar .ab-selector .ab-note{font-size:10px;color:#8fa4ad;margin-top:4px}' +
      '#actionBar .ab-selector .ab-empty{font-size:11px;color:#a9b8bf;padding:4px 6px}' +
      '#actionBar .ab-toast{position:absolute;bottom:62px;white-space:nowrap;background:rgba(20,31,38,0.92);border:1px solid #3a4b54;border-radius:999px;padding:4px 10px;font-weight:500;font-size:11px;display:none}' +
      '#actionBar .ab-toast.show{display:block}' +
      '@media (max-width:640px){#actionBar .ab-slot{width:30px;height:38px}#actionBar .ab-slot .ab-name,#actionBar .ab-slot .ab-pick{display:none}}';
    doc.head.appendChild(style);
  }

  function create(parent, opts) {
    opts = opts || {};
    const doc = parent.ownerDocument || document;
    injectStyle(doc);
    const win = doc.defaultView || window;

    const el = doc.createElement('div');
    el.id = 'actionBar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Action bar');
    const selectorEl = doc.createElement('div');
    selectorEl.className = 'ab-selector';
    selectorEl.setAttribute('role', 'listbox');
    const toast = doc.createElement('div');
    toast.className = 'ab-toast';
    toast.setAttribute('role', 'status');
    const row = doc.createElement('div');
    row.className = 'ab-row';
    el.appendChild(selectorEl);
    el.appendChild(toast);
    el.appendChild(row);

    const slotEls = SLOTS.map((s) => {
      const b = doc.createElement('div');
      b.className = 'ab-slot' + (s.kind === 'reserved' ? ' reserved' : '');
      b.dataset.slot = s.id;
      b.dataset.key = s.key;
      b.title = s.kind === 'reserved' ? 'Reserved' : s.label;
      const k = doc.createElement('span'); k.className = 'ab-key'; k.textContent = s.key;
      const n = doc.createElement('span'); n.className = 'ab-name'; n.textContent = s.short;
      const p = doc.createElement('span'); p.className = 'ab-pick';
      b.appendChild(k); b.appendChild(n); b.appendChild(p);
      row.appendChild(b);
      return { el: b, pick: p };
    });
    parent.appendChild(el);

    let toastTimer = null;
    function note(text, ms) {
      toast.textContent = text;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), ms || 2400);
    }

    const flashTimers = new Map();
    function flash(index) {
      const b = slotEls[index].el;
      b.classList.add('firing');
      clearTimeout(flashTimers.get(index));
      flashTimers.set(index, setTimeout(() => b.classList.remove('firing'), 220));
    }

    let model = null;
    function renderPicks() {
      for (const s of SLOTS) {
        if (s.kind !== 'selector') continue;
        const id = model.selectedId(s.id);
        const opt = id === null ? null : model.options(s.id).find((o) => o.id === id);
        slotEls[s.index].pick.textContent = opt ? opt.label : '';
        slotEls[s.index].el.classList.toggle('armed', !!opt);
        slotEls[s.index].el.title = s.label + (opt ? ': ' + opt.label : ': none');
      }
    }
    function renderSelector() {
      const o = model.isOpen();
      selectorEl.classList.toggle('open', !!o);
      if (!o) { selectorEl.textContent = ''; return; }
      const s = SLOTS[o.index];
      const slotRect = slotEls[o.index].el.getBoundingClientRect();
      const barRect = el.getBoundingClientRect();
      selectorEl.style.left = Math.max(0, slotRect.left - barRect.left - 20) + 'px';
      selectorEl.textContent = '';
      const title = doc.createElement('div');
      title.className = 'ab-title';
      title.textContent = s.label + ' - choose, then Enter';
      selectorEl.appendChild(title);
      const list = model.options(s.id);
      const choices = list.map((x) => ({ id: x.id, label: x.label, sub: x.sub })).concat([{ id: null, label: 'None', sub: '' }]);
      if (!list.length) {
        const empty = doc.createElement('div');
        empty.className = 'ab-empty';
        empty.textContent = s.empty;
        selectorEl.appendChild(empty);
      }
      choices.forEach((c, n) => {
        if (!list.length && c.id === null) return;
        const r = doc.createElement('div');
        r.className = 'ab-opt' + (n === o.cursor ? ' cursor' : '') + (c.id === model.selectedId(s.id) ? ' current' : '');
        r.setAttribute('role', 'option');
        r.dataset.choice = String(n);
        const nm = doc.createElement('span'); nm.className = 'ab-oname'; nm.textContent = c.label;
        r.appendChild(nm);
        if (c.sub) { const sb = doc.createElement('span'); sb.className = 'ab-osub'; sb.textContent = c.sub; r.appendChild(sb); }
        r.addEventListener('mousedown', (ev) => ev.preventDefault());
        r.addEventListener('click', (ev) => { ev.stopPropagation(); model.confirm(n); });
        selectorEl.appendChild(r);
      });
      const hint = doc.createElement('div');
      hint.className = 'ab-note';
      hint.textContent = 'Selecting only chooses an item. It is never used or spent here. Shift + key asks to use it.';
      selectorEl.appendChild(hint);
    }

    function onEvent(ev) {
      const slot = typeof ev.slot === 'number' ? slotEls[ev.slot] : null;
      switch (ev.type) {
        case 'action':
          if (ev.phase === 'start') { flash(ev.slot); if (SLOTS[ev.slot].hold) slot.el.classList.add('holding'); }
          else slot.el.classList.remove('holding');
          break;
        case 'tap': case 'selector-confirm': renderPicks(); renderSelector(); flash(ev.slot); break;
        case 'options': renderPicks(); renderSelector(); break;
        case 'selector-open': case 'selector-move': case 'selector-cancel': renderSelector(); break;
        case 'use-request': flash(ev.slot); note('Use is not available in this prototype. Nothing was used.'); break;
        default: break;
      }
      el.dataset.last = ev.type;
      if (typeof opts.onEvent === 'function') opts.onEvent(ev);
      try { win.dispatchEvent(new win.CustomEvent('atlas-action-bar', { detail: ev })); } catch (err) { /* no DOM events in this context */ }
    }
    model = createModel(Object.assign({}, opts, { emit: onEvent }));

    // Pointer: a press is a tap or a hold, Shift-click asks to use.
    SLOTS.forEach((s, i) => {
      const b = slotEls[i].el;
      b.addEventListener('mousedown', (ev) => { ev.preventDefault(); model.press(i, { shift: ev.shiftKey }); });
      const end = () => model.release(i);
      b.addEventListener('mouseup', end);
      b.addEventListener('mouseleave', () => { if (model.isDown(i) && !model.isOpen()) model.release(i); });
    });
    renderPicks();

    return {
      el, model,
      setVisible: (on) => el.classList.toggle('shown', !!on),
      isVisible: () => el.classList.contains('shown'),
      note,
      destroy: () => { model.cancelAll(); el.remove(); }
    };
  }

  const api = { HOLD_MS, SLOTS, slotForCode, isTypingTarget, createModel, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AtlasActionBar = api;
})(typeof window !== 'undefined' ? window : globalThis);
