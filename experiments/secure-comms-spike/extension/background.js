// Background service worker of the spike extension (test only).
//
// Opens the dedicated call window, accepts runtime messages only from the
// call page itself, and hosts two experiments: a lock signal through
// chrome.storage.session and a service-worker long-poll for the
// inactive-window notification question.
'use strict';

const CALL_URL = chrome.runtime.getURL('call.html');

async function openCallWindow(params) {
  const p = Object.assign({ base: 'http://127.0.0.1:9401' }, params || {});
  const win = await chrome.windows.create({
    url: CALL_URL + '?' + new URLSearchParams(p).toString(),
    type: 'popup', width: 420, height: 560, focused: p.focused !== '0'
  });
  return { windowId: win.id, tabId: win.tabs && win.tabs[0] && win.tabs[0].id };
}
globalThis.openCallWindow = openCallWindow; // test hook (Playwright serviceWorker.evaluate)

// Toolbar button, for manual checks in one browser: the first click opens the 'alice' window, the second
// the 'bob' window of the same room (paste each window's test key into the other, then press Call / Answer).
let clicks = 0;
chrome.action.onClicked.addListener(() => {
  clicks++;
  openCallWindow(clicks % 2 === 1 ? { room: 'manual', me: 'alice', peer: 'bob' } : { room: 'manual', me: 'bob', peer: 'alice' });
});

// Only the call page may talk to the background script. sender.tab is set for
// extension pages opened as windows or tabs as well, so the check is on
// sender.url, not on whether a tab exists.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!sender.url || !(sender.url === CALL_URL || sender.url.startsWith(CALL_URL + '?'))) return;
  if (message && message.type === 'spike-ping') { sendResponse({ ok: true, url: sender.url }); return; }
});

// Lock signal: the real wallet's background watches storage for the unlocked
// identity going away. The spike models it with a session-storage flag the
// call page listens to.
globalThis.signalLock = async () => { await chrome.storage.session.set({ spikeLocked: true, spikeLockedAt: Date.now() }); };
globalThis.clearLock = async () => { await chrome.storage.session.remove(['spikeLocked', 'spikeLockedAt']); };

// Experiment: can the service worker itself hold a long-poll and surface an incoming call?
// opts.touch: also call a chrome.* API every cycle (storage write). Without it the loop is a pure fetch
// loop, which shows whether the worker survives on the network request alone. Each invite is acknowledged to
// the relay mailbox 'ack-<label>' so a test can observe it without attaching a debugger (a debugger keeps
// service workers alive and would invalidate the lifetime measurement).
const swPolls = new Map();
async function startSwPoll(base, room, me, label, opts) {
  const o = opts || {};
  const run = (swPolls.get(label) || 0) + 1;
  swPolls.set(label, run);
  const instance = Math.random().toString(36).slice(2, 8);
  let after = 0, beats = 0;
  if (o.touch) await chrome.storage.session.set({ ['swpoll-' + label]: { instance, startedAt: Date.now(), beats: 0, invites: [] } });
  fetch(base + '/__test/obs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room, me: 'sw-' + label, kind: 'sw-started', data: { instance, touch: !!o.touch } }) }).catch(() => {});
  (async () => {
    while (swPolls.get(label) === run) {
      try {
        const res = await fetch(base + '/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room, me, after, waitMs: 25000 }) });
        const body = await res.json();
        beats++;
        for (const e of body.events || []) {
          after = Math.max(after, e.id);
          if (e.msg && e.msg.type === 'invite') {
            const receivedAt = Date.now();
            chrome.notifications.create('swpoll-' + label + '-' + e.id, { type: 'basic', iconUrl: 'icon.png', title: 'Incoming call (service worker)', message: 'test' }, () => { void chrome.runtime.lastError; });
            fetch(base + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room, to: 'ack-' + label, msg: { type: 'ack', n: e.msg.n, sentAt: e.msg.sentAt, receivedAt, instance, beats } }) }).catch(() => {});
          }
        }
        if (o.touch) await chrome.storage.session.set({ ['swpoll-' + label]: { instance, beats, lastBeatAt: Date.now() } });
      } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  })();
  return { instance };
}
globalThis.startSwPoll = startSwPoll;
globalThis.stopSwPoll = (label) => { if (label) swPolls.set(label, (swPolls.get(label) || 0) + 1); else for (const k of swPolls.keys()) swPolls.set(k, swPolls.get(k) + 1); };

// Test-only: a harness that launches the browser without a debugger copies this extension, adds a
// startup.json and gets pages opened and polls started when the worker starts. The shipped spike has no
// startup.json, so this does nothing.
(async () => {
  try {
    const res = await fetch(chrome.runtime.getURL('startup.json'));
    if (!res.ok) return;
    const cfg = await res.json();
    for (const t of cfg.tabs || []) await chrome.tabs.create({ url: chrome.runtime.getURL(t.path), active: !!t.active });
    for (const p of cfg.swpolls || []) await startSwPoll(p.base, p.room, p.me, p.label, { touch: !!p.touch });
  } catch (err) { /* no startup.json */ }
})();
