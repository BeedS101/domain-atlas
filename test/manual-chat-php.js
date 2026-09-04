// Manual check for presence-php's chat polling routes (task #110's PHP
// port of in-world chat's #68-style polling fallback — see
// presence-php/README.txt's "In-world chat: what's different from
// presence" section for what this is and why it exists).
//
// Run in isolation from the extension, same reasoning as
// manual-presence-php.js — proves the actual PHP request/response shapes
// are correct before trusting anything in the browser against them.
// Spins up PHP's own built-in dev server (`php -S`) against
// presence-php/test-router.php, which mimics presence/.htaccess's
// clean-URL rewrite closely enough to exercise the exact same
// /presence/poll/chat-join, /chat-sync, /chat-send, /chat-leave paths the
// real Apache deployment and extension/viewer.js's pollChat() both use.
//
// Checks:
//   1. join -> {id, messages:[]} for the first visitor into an empty
//      domain's chat.
//   2. A second visitor joining the SAME domain (different world) gets
//      the SAME empty backlog — chat is domain-scoped, not per-world; a
//      CORS OPTIONS preflight on the route succeeds too (real
//      cross-origin calls need this).
//   3. Sending from an anonymous member (no publicKey at join) is
//      rejected with reason "login-required" — reading never needs an
//      identity, sending always does, enforced server-side regardless of
//      what any client-side check already did.
//   4. Sending from a member WITH a publicKey succeeds and returns the
//      new message; a profanity-laden message is rejected with reason
//      "blocked" and never makes it into history.
//   5. Domain-scoped, not world-scoped: a message sent while "in" world A
//      still shows up in a sync response for a member "in" world B —
//      viewer.js does the This-World-vs-Domain filtering client-side
//      from the `world` tag on each message, this bundle just needs to
//      hand back every message in the domain regardless of who's in
//      which world.
//   6. sync returns only messages newer than the caller's own cursor
//      (incremental, not the whole history every time) — two syncs in a
//      row with nothing new in between both return an empty delta, and a
//      sync right after a message arrives returns exactly that one.
//   7. A visitor in a DIFFERENT domain never sees the first domain's
//      messages — proves domain isolation.
//   8. An explicit leave, followed by a sync against that same id,
//      returns 404 "unknown or expired chat id" — matches what
//      extension/viewer.js's pollChat() is written to treat as "this
//      session is gone" rather than a crash.
//   9. A member that just stops syncing (no explicit leave) is swept out
//      by the next request that touches its domain, once
//      PRESENCE_POLL_TIMEOUT_MS has passed — same staleness-cleanup
//      guarantee presence-server.js's own sweep gives, just triggered
//      lazily per-request instead of on a background timer (PHP has
//      none). Uses a real file edit to fake an old lastSeen instead of
//      actually waiting out the real 15s timeout. This has no visible
//      effect on any roster (chat has none) — it just proves the member
//      bookkeeping doesn't grow unbounded forever.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8097; // isolated port, distinct from manual-presence-php.js's own 8098 and manual-presence-server.js's 8099
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'presence-php');
const PRESENCE_STORE_FILE = path.resolve(BUNDLE_DIR, 'presence', 'lib', 'atlas-presence-store.json');
const CHAT_STORE_FILE = path.resolve(BUNDLE_DIR, 'presence', 'lib', 'atlas-chat-store.json');

function post(urlPath, body) {
  return fetch(BASE + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

(async () => {
  console.log('SETUP: starting PHP\'s built-in dev server against presence-php/test-router.php');
  try { fs.unlinkSync(PRESENCE_STORE_FILE); } catch (err) {}
  try { fs.unlinkSync(CHAT_STORE_FILE); } catch (err) {} // start from a clean chat store
  const serverProc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    serverProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: PHP dev server up on port ' + PORT);

  try {
    console.log('STEP 1: first visitor joins an empty domain\'s chat, gets an empty backlog');
    const joinA = await post('/presence/poll/chat-join', { domain: 'example.com', world: 'plaza', name: 'Alice' });
    if (joinA.status !== 200 || !joinA.body.id || joinA.body.messages.length !== 0) {
      throw new Error('Expected a 200 with empty messages for the first joiner, got: ' + JSON.stringify(joinA));
    }
    const idA = joinA.body.id;
    console.log('PASS: Alice joined chat with empty history, id=' + idA);

    console.log('STEP 2: a second visitor in a DIFFERENT world of the SAME domain gets the same (still empty) backlog; CORS preflight succeeds');
    const preflight = await fetch(BASE + '/presence/poll/chat-join', { method: 'OPTIONS' });
    if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== '*') {
      throw new Error('Expected a 204 CORS preflight with Access-Control-Allow-Origin: *, got status ' + preflight.status);
    }
    const joinB = await post('/presence/poll/chat-join', { domain: 'example.com', world: 'arena', name: 'Bob', publicKey: 'bob-pk' });
    if (joinB.status !== 200 || joinB.body.messages.length !== 0) {
      throw new Error('Expected Bob (different world, same domain) to also see an empty backlog, got: ' + JSON.stringify(joinB.body));
    }
    const idB = joinB.body.id;
    console.log('PASS: Bob (world=arena) sees the same domain-scoped chat as Alice (world=plaza), CORS preflight also succeeded');

    console.log('STEP 3: Alice (no publicKey at join) tries to send — rejected with login-required, server-side');
    const anonSend = await post('/presence/poll/chat-send', { id: idA, text: 'hello from an anonymous visitor' });
    if (anonSend.status !== 200 || anonSend.body.ok !== false || anonSend.body.reason !== 'login-required') {
      throw new Error('Expected {ok:false, reason:"login-required"} for Alice\'s send, got: ' + JSON.stringify(anonSend.body));
    }
    console.log('PASS: anonymous send correctly rejected with reason=login-required');

    console.log('STEP 4: Bob (has a publicKey) sends successfully; a profane message is rejected with reason=blocked and never joins history');
    const bobSend = await post('/presence/poll/chat-send', { id: idB, text: 'hello from Bob in the Arena' });
    if (bobSend.status !== 200 || bobSend.body.ok !== true || bobSend.body.message.text !== 'hello from Bob in the Arena' || bobSend.body.message.world !== 'arena' || bobSend.body.message.name !== 'Bob') {
      throw new Error('Expected Bob\'s send to succeed with the right message shape, got: ' + JSON.stringify(bobSend.body));
    }
    console.log('PASS: Bob\'s send succeeded -> ' + JSON.stringify(bobSend.body.message));

    const blockedSend = await post('/presence/poll/chat-send', { id: idB, text: 'you fucking idiot' });
    if (blockedSend.status !== 200 || blockedSend.body.ok !== false || blockedSend.body.reason !== 'blocked') {
      throw new Error('Expected a profane message to be rejected with reason=blocked, got: ' + JSON.stringify(blockedSend.body));
    }
    console.log('PASS: profane message rejected server-side with reason=blocked, matching the Node version\'s own filter');

    console.log('STEP 5: Bob\'s message (sent while "in" world=arena) shows up for Alice ("in" world=plaza) — chat is domain-scoped, not world-scoped');
    const syncA = await post('/presence/poll/chat-sync', { id: idA });
    if (syncA.status !== 200 || syncA.body.messages.length !== 1 || syncA.body.messages[0].text !== 'hello from Bob in the Arena' || syncA.body.messages[0].world !== 'arena') {
      throw new Error('Expected Alice\'s sync to include Bob\'s Arena message (domain-wide, world-tagged), got: ' + JSON.stringify(syncA.body));
    }
    console.log('PASS: Alice (world=plaza) received Bob\'s world=arena message via sync — client-side world filtering is what viewer.js does with this tag, not this bundle');

    console.log('STEP 6: sync is incremental — a second sync with nothing new returns an empty delta, not the whole history again');
    const syncAAgain = await post('/presence/poll/chat-sync', { id: idA });
    if (syncAAgain.status !== 200 || syncAAgain.body.messages.length !== 0) {
      throw new Error('Expected an empty delta on a sync with nothing new since the last one, got: ' + JSON.stringify(syncAAgain.body));
    }
    console.log('PASS: repeated sync with no new activity returns an empty delta (cursor correctly advanced)');

    const aliceSend2 = await post('/presence/poll/chat-send', { id: idA, text: 'still cant send though' });
    if (aliceSend2.body.ok !== false || aliceSend2.body.reason !== 'login-required') throw new Error('Sanity check failed: Alice should still be unable to send');
    // Give Alice a real identity by re-joining with a publicKey this time — simplest way to prove sending then works, without adding a "grant identity" backdoor route
    const joinA2 = await post('/presence/poll/chat-join', { domain: 'example.com', world: 'plaza', name: 'Alice', publicKey: 'alice-pk' });
    const idA2 = joinA2.body.id;
    if (joinA2.body.messages.length !== 1) throw new Error('Expected Alice\'s re-join to see the 1 existing message in history, got: ' + JSON.stringify(joinA2.body));
    const aliceSend3 = await post('/presence/poll/chat-send', { id: idA2, text: 'now I can chat' });
    if (aliceSend3.body.ok !== true) throw new Error('Expected Alice to be able to send after joining with a publicKey, got: ' + JSON.stringify(aliceSend3.body));
    const syncBAfterAlice = await post('/presence/poll/chat-sync', { id: idB });
    if (syncBAfterAlice.body.messages.length !== 1 || syncBAfterAlice.body.messages[0].text !== 'now I can chat') {
      throw new Error('Expected Bob\'s next sync to pick up exactly Alice\'s new message, got: ' + JSON.stringify(syncBAfterAlice.body));
    }
    console.log('PASS: a re-join with a publicKey can send, and the delta model correctly hands the new message to the other member on their next sync');

    console.log('STEP 7: a visitor in a DIFFERENT domain never sees this domain\'s messages — domain isolation');
    const joinC = await post('/presence/poll/chat-join', { domain: 'other-domain.com', world: 'lobby', name: 'Carol' });
    if (joinC.status !== 200 || joinC.body.messages.length !== 0) {
      throw new Error('Expected Carol (different domain) to see an empty backlog, got: ' + JSON.stringify(joinC.body));
    }
    console.log('PASS: chat rooms are isolated by domain, same as presence-server.js');

    console.log('STEP 8: an explicit leave, then a sync against that id, returns 404 unknown/expired');
    const leaveB = await post('/presence/poll/chat-leave', { id: idB });
    if (leaveB.status !== 200 || leaveB.body.ok !== true) throw new Error('Expected leave to return {ok:true}, got: ' + JSON.stringify(leaveB));
    const syncAfterLeave = await post('/presence/poll/chat-sync', { id: idB });
    if (syncAfterLeave.status !== 404) throw new Error('Expected a 404 syncing an id that just left, got: ' + JSON.stringify(syncAfterLeave));
    console.log('PASS: explicit leave removes the member; syncing that id afterward correctly 404s');

    console.log('STEP 9: a member that stops syncing entirely is swept out once the staleness timeout has passed (no roster to prove it, just that bookkeeping doesn\'t leak forever)');
    const joinD = await post('/presence/poll/chat-join', { domain: 'example.com', world: 'plaza', name: 'Dave', publicKey: 'dave-pk' });
    const idD = joinD.body.id;
    const doc = JSON.parse(fs.readFileSync(CHAT_STORE_FILE, 'utf8'));
    if (!doc.domains['example.com'].members[idD]) throw new Error('Expected Dave to be recorded as a chat member right after joining');
    doc.domains['example.com'].members[idD].lastSeen = Date.now() - 60000; // 60s ago — comfortably past the 15s timeout
    fs.writeFileSync(CHAT_STORE_FILE, JSON.stringify(doc));
    await post('/presence/poll/chat-sync', { id: idA2 }); // touching the domain triggers the lazy sweep
    const docAfterSweep = JSON.parse(fs.readFileSync(CHAT_STORE_FILE, 'utf8'));
    if (docAfterSweep.domains['example.com'].members[idD]) throw new Error('Expected Dave to be swept out as stale, but he\'s still recorded as a member');
    console.log('PASS: an abandoned chat member is swept out on the next request that touches their domain, no explicit leave required');

    console.log('\nALL CHAT-PHP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
    try { fs.unlinkSync(PRESENCE_STORE_FILE); } catch (err) {}
    try { fs.unlinkSync(CHAT_STORE_FILE); } catch (err) {}
  }
})();
