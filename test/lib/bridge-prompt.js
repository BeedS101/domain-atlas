// The wallet-bridge confirmation (sign, offer, identity, buy) is a window of its own, opened by the extension, not an
// element of the requesting page. These helpers find it among the browser context's pages.
//
//   const BP = require('./lib/bridge-prompt');
//   const prompt = await BP.wait(page, { timeout: 10000 });   // the prompt window (a Playwright Page)
//   await prompt.locator('#approveBtn').click();
//   await BP.gone(page);                                      // closed again
//   await BP.count(page);                                     // how many prompt windows are open
//
// Any page or context of the browser can be passed; the prompt is looked up in that page's browser context.
'use strict';

const PROMPT_URL = /\/confirm-bridge\.html/;
const contextOf = (p) => (typeof p.pages === 'function' ? p : p.context());
const isPrompt = (p) => !p.isClosed() && PROMPT_URL.test(p.url());
const prompts = (p) => contextOf(p).pages().filter(isPrompt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, timeout, what) {
  const until = Date.now() + (timeout || 10000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timeout waiting for ' + what);
    await sleep(60);
  }
}

// The newest open prompt window, once it has loaded.
async function wait(p, opts) {
  const win = await poll(() => prompts(p).slice(-1)[0], opts && opts.timeout, 'the confirmation window to open');
  await win.waitForLoadState('domcontentloaded', { timeout: (opts && opts.timeout) || 10000 });
  return win;
}
// The prompt window that is open now, without waiting.
function frame(p) {
  const open = prompts(p);
  if (!open.length) throw new Error('no confirmation window is open');
  return open[open.length - 1];
}
async function gone(p, opts) {
  await poll(() => prompts(p).length === 0, opts && opts.timeout, 'the confirmation window to close');
}
async function count(p) { return prompts(p).length; }

module.exports = { wait, frame, gone, count, prompts, PROMPT_URL };
