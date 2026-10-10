// Boundary checks for the spike: a web page cannot reach the call window, only the call page can talk
// to the background script, and the spike contains none of the things Phase 1A forbids.
// Run: xvfb-run -a node test/security-boundary.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const H = require('./harness');
const { check, observe } = H;

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..', '..');
const PORT = 9418, BASE = 'http://127.0.0.1:' + PORT;

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

(async () => {
  // ---------- static checks on what the spike contains ----------
  const manifest = JSON.parse(read('extension/manifest.json'));
  check('manifest requests only the notifications and storage permissions', JSON.stringify(manifest.permissions.slice().sort()) === JSON.stringify(['notifications', 'storage']), manifest.permissions);
  check('manifest has no microphone / audioCapture permission (getUserMedia is gated by the browser prompt, not by a manifest grant)', !manifest.permissions.some((p) => /audio|microphone|media/i.test(p)));
  check('manifest declares no content scripts (nothing is injected into web pages)', manifest.content_scripts === undefined);
  check('manifest exposes no web_accessible_resources', manifest.web_accessible_resources === undefined);
  check('manifest declares no externally_connectable (web pages cannot message the extension)', manifest.externally_connectable === undefined);
  check('host permissions are limited to the loopback test relay', JSON.stringify(manifest.host_permissions) === JSON.stringify(['http://127.0.0.1/*']), manifest.host_permissions);

  const sources = { 'call.js': read('extension/call.js'), 'background.js': read('extension/background.js'), 'spike-lib.js': read('extension/spike-lib.js'), 'call.html': read('extension/call.html') };
  const code = Object.entries(sources).filter(([k]) => k.endsWith('.js'));
  check('no recording API is used (MediaRecorder / AudioWorklet capture / createMediaStreamDestination)', !code.some(([, s]) => /MediaRecorder|createMediaStreamDestination|AudioWorklet|ScriptProcessor/.test(s)));
  check('no custom encryption (only SHA-256 hashing and ECDSA signing from WebCrypto; no encrypt / decrypt / AES / wrapKey)', !code.some(([, s]) => /\.encrypt\(|\.decrypt\(|AES-|wrapKey|deriveKey/.test(s)));
  check('no dynamic code (eval / new Function) in the extension', !code.some(([, s]) => /\beval\(|new Function\(/.test(s)));
  check('no browser storage of call material (localStorage / sessionStorage / indexedDB / storage.local)', !code.some(([, s]) => /localStorage|sessionStorage|indexedDB|storage\.local/.test(s)));
  check('every test key is generated non-extractable except where a test explicitly asks', (sources['call.js'].match(/generateTestKeyPair\((\w+)\)/g) || []).every((c) => /false/.test(c)), sources['call.js'].match(/generateTestKeyPair\((\w+)\)/g));
  check('the spike imports no wallet code, keys or issuer code', !code.some(([, s]) => /require\(|importScripts|wallet\.js|atlas-key|presence|post-office|postoffice/i.test(s)));
  check('the call page never uses a persistent identity: no hard-coded key material', !code.some(([, s]) => /-----BEGIN|"d":\s*"/.test(s)));
  check('getUserMedia is called from one place only (acquireMic), reached only from click handlers or the attacker simulation', (sources['call.js'].match(/getUserMedia/g) || []).length === 1);
  const acquireCalls = sources['call.js'].match(/acquireMic\('[\w-]+'\)/g) || [];
  observe('acquireMicCallSites', acquireCalls);
  check('acquireMic call sites are the three click handlers and the test attacker', JSON.stringify(acquireCalls.slice().sort()) === JSON.stringify(["acquireMic('answer-click')", "acquireMic('attacker')", "acquireMic('call-click')", "acquireMic('unmute-click')"].sort()), acquireCalls);
  const html = sources['call.html'];
  check('the UI never claims verification: no "bank" wording and no checkmark / badge glyphs', !/bank|✓|✔|badge/i.test(html) && !/bank|✓|✔/i.test(sources['call.js']));
  check('the only mention of verification in the UI is a disclaimer', (html.match(/verified/gi) || []).length === 1 && /Nothing here is verified or secure/.test(html));

  // ---------- repository: nothing outside the experiment and docs was touched ----------
  const changed = execSync('git status --porcelain', { cwd: REPO }).toString().split('\n').filter(Boolean).map((l) => l.slice(3));
  const outside = changed.filter((f) => !f.startsWith('experiments/secure-comms-spike/') && !f.startsWith('docs/voice-calls-') && f !== 'experiments/');
  observe('changedPaths', changed);
  check('no file outside experiments/secure-comms-spike and the voice-calls docs is modified (wallet, issuer, Post Office, presence, SPEC.md, atlas-key.json untouched)', outside.length === 0, outside);

  // ---------- browser checks ----------
  const srv = await H.startServer(PORT);
  const a = await H.launch('a');
  try {
    // hostile web page
    const hp = await a.context.newPage();
    await hp.goto(BASE + '/hostile?ext=' + a.extId);
    await H.until(() => hp.evaluate(() => !!window.__hostile), 10000);
    const hr = await hp.evaluate(() => window.__hostile);
    observe('hostilePage', hr);
    check('a web page cannot fetch the call page (resource is not web-accessible)', /blocked/.test(hr.fetchCallPage), hr.fetchCallPage);
    check('a web page cannot frame the call page', !/accessible$/.test(hr.iframeAccess) || /blocked|null/.test(hr.iframeAccess), hr.iframeAccess);
    check('a web page has no chrome.runtime route to the extension', hr.chromeRuntime !== 'object' || /no answer|not available|threw/.test(hr.sendMessage), hr);
    check('a window.postMessage from a web page starts nothing', (await a.sw.evaluate(async () => (await chrome.windows.getAll()).length)) <= 2);
    const pagesWithCall = a.context.pages().filter((p) => p.url().includes('call.html'));
    check('no call window was opened by the hostile page', pagesWithCall.length === 0, pagesWithCall.map((p) => p.url()));
    await hp.close();

    // sender distinction in the background script
    const C = await H.openCall(a, { room: 'sec', me: 'alice', peer: 'bob', base: BASE });
    const fromCall = await C.page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'spike-ping' }, (resp) => r({ resp: resp || null, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null }))));
    check('the background answers the call page', fromCall.resp && fromCall.resp.ok === true, fromCall);
    const op = await a.context.newPage();
    await op.goto('chrome-extension://' + a.extId + '/other.html');
    const fromOther = await op.evaluate(() => window.askBackground());
    observe('otherExtensionPage', fromOther);
    check('the background does not answer another page of the same extension (sender.url, not sender.tab or id, decides)', fromOther.answered === false, fromOther);
    await op.close(); await C.page.close();
  } finally {
    await a.close(); srv.kill();
  }
  process.exit(H.finish('security-boundary'));
})().catch((e) => { console.error(e); process.exit(2); });
