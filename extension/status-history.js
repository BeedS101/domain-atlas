// Recent status messages: the top bar's #status line shows one message at a time, and this keeps the last few
// readable. Clicking the status line (or pressing Enter/Space on it) opens a compact list, newest first, with Copy log
// and Clear history.
//
// Capture is one MutationObserver on #status, so every message the viewer writes there is recorded, whatever code set
// it and without any call site knowing about the history. Storage, redaction and the 20-message limit live in
// wallet.js (recordStatusMessage and friends); this file only reports messages and draws the list. It never writes to
// #status itself, so the list's own feedback is not recorded as a message.
//
// While the wallet is locked there is no identity to store messages for, so they are kept in this page's memory only,
// shown only while no identity is active, and never mixed into an identity's stored history.
(function () {
  'use strict';
  const statusEl = document.getElementById('status');
  const panel = document.getElementById('statusHistoryPanel');
  const listEl = document.getElementById('statusHistoryList');
  const copyBtn = document.getElementById('statusHistoryCopy');
  const clearBtn = document.getElementById('statusHistoryClear');
  const closeBtn = document.getElementById('statusHistoryClose');
  if (!statusEl || !panel || !listEl || !copyBtn || !clearBtn || !closeBtn || typeof AtlasWallet === 'undefined' || typeof AtlasWallet.recordStatusMessage !== 'function') return;

  const LEVEL_LABELS = { error: 'Error', warning: 'Warning', success: 'Success', info: 'Info' };
  let sessionOnly = [];
  let shown = [];
  let open = false;
  let renderTicket = 0;

  function report(text, at) {
    const when = at || new Date();
    AtlasWallet.recordStatusMessage(text, when).then((entry) => {
      if (!entry) {
        const clean = AtlasWallet.sanitizeStatusMessage(text);
        if (clean) {
          sessionOnly.unshift({ at: when.toISOString(), level: AtlasWallet.classifyStatusMessage(clean), text: clean });
          sessionOnly = sessionOnly.slice(0, AtlasWallet.STATUS_HISTORY_LIMIT);
        }
      }
      if (open) render();
    }).catch(() => {});
  }

  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') {
        const t = r.target.data;
        if (t && t.trim()) report(t);
        continue;
      }
      for (const node of r.addedNodes) {
        const t = node.textContent;
        if (t && t.trim()) report(t);
      }
    }
  }).observe(statusEl, { childList: true, characterData: true, subtree: true });

  async function load() {
    const stored = await AtlasWallet.getStatusHistory();
    let identity = null;
    try { identity = await AtlasWallet.getIdentity(); } catch (err) { identity = null; }
    return identity ? stored : sessionOnly.slice();
  }

  function whenLabel(iso) {
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour12: false }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour12: false });
  }

  function draw(list) {
    shown = list;
    listEl.textContent = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'sh-empty';
      li.textContent = 'No messages yet.';
      listEl.appendChild(li);
    }
    for (const e of list) {
      const li = document.createElement('li');
      li.className = 'sh-' + e.level;
      const meta = document.createElement('span');
      meta.className = 'sh-meta';
      const time = document.createElement('time');
      time.dateTime = e.at;
      time.title = e.at;
      time.textContent = whenLabel(e.at);
      const level = document.createElement('span');
      level.className = 'sh-level';
      level.textContent = LEVEL_LABELS[e.level] || LEVEL_LABELS.info;
      meta.append(time, level);
      const text = document.createElement('span');
      text.className = 'sh-text';
      text.textContent = e.text;
      li.append(meta, text);
      listEl.appendChild(li);
    }
    copyBtn.disabled = clearBtn.disabled = !list.length;
  }

  async function render() {
    const ticket = ++renderTicket;
    const list = await load();
    if (ticket === renderTicket) draw(list);
  }

  function openPanel() {
    open = true;
    panel.hidden = false;
    statusEl.setAttribute('aria-expanded', 'true');
    render().then(() => { if (open) panel.focus(); });
  }

  function closePanel(returnFocus) {
    if (!open) return;
    open = false;
    panel.hidden = true;
    statusEl.setAttribute('aria-expanded', 'false');
    if (returnFocus) statusEl.focus();
  }

  function flash(button, text) {
    const label = button.dataset.label || button.textContent;
    button.dataset.label = label;
    button.textContent = text;
    setTimeout(() => { button.textContent = label; }, 1500);
  }

  async function copyShown() {
    const text = AtlasWallet.statusHistoryAsText(shown);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // The async clipboard can be refused in an embedded page; a hidden textarea and a copy command still work.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position: fixed; left: -9999px; top: 0;';
      // Inside the dropdown, so moving focus to it does not read as leaving the dropdown.
      panel.appendChild(ta);
      ta.focus({ preventScroll: true });
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      copyBtn.focus({ preventScroll: true });
      if (!ok) { flash(copyBtn, 'Copy failed'); return; }
    }
    flash(copyBtn, 'Copied');
  }

  async function clearShown() {
    let identity = null;
    try { identity = await AtlasWallet.getIdentity(); } catch (err) { identity = null; }
    if (identity) await AtlasWallet.clearStatusHistory();
    else sessionOnly = [];
    await render();
    panel.focus();
  }

  statusEl.addEventListener('click', () => { if (open) closePanel(false); else openPanel(); });
  statusEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (open) closePanel(false); else openPanel(); }
  });
  copyBtn.addEventListener('click', copyShown);
  clearBtn.addEventListener('click', clearShown);
  closeBtn.addEventListener('click', () => closePanel(true));
  // Tabbing out of either end of the dropdown closes it and puts focus back on the status area, which sits earlier in the
  // page than the dropdown does.
  function tabStops() { return [copyBtn, clearBtn, closeBtn, listEl].filter((el) => !el.disabled); }
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(true); return; }
    if (e.key !== 'Tab') return;
    const stops = tabStops();
    const here = document.activeElement;
    if ((!e.shiftKey && here === stops[stops.length - 1]) || (e.shiftKey && (here === stops[0] || here === panel))) {
      e.preventDefault();
      closePanel(true);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (open && !panel.contains(e.target) && !statusEl.contains(e.target)) closePanel(false);
  });
  document.addEventListener('focusin', (e) => {
    if (open && !panel.contains(e.target) && !statusEl.contains(e.target)) closePanel(false);
  });
})();
