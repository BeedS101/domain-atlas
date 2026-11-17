// The browser wallet keeps each Post Office's allowed-sender list current: against real local issuers (Node and PHP) and the
// real extension, a friend added or removed, or a pending outgoing friend request sent or cancelled, reaches every Post Office
// where Friends Only is on and none where it is off; a Post Office that cannot be updated is reported (especially after a
// removal, because it may still admit the removed person), kept in storage, retried, and cleared once it works.
// It also checks the wording of the "Who can contact you" setting in the Settings page and the Services tab.
//
// Nothing here contacts a live domain.
// Run: xvfb-run -a node test/manual-friends-allowlist-sync.js
'use strict';
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const L = require('./call-e2e-lib');
const lib = require('./owner-proof-lib');
const { check, until } = L;
const { subtle } = webcrypto;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const POST_OFFICE = 'atlas.postoffice.membership';

async function newPublicKey() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return b64u(await subtle.exportKey('raw', pair.publicKey));
}
// What the issuer holds for one member: the mode and the allowed-sender list.
function memberAt(inst, ownerPublicKey) {
  const doc = lib.readJson(inst.rosterFile('atlas-postoffice-members-store.json'), { members: [] });
  const m = (doc.members || []).find((x) => x.ownerPublicKey === ownerPublicKey);
  return m ? { mode: m.mailMode || 'open', friends: (m.friends || []).slice().sort() } : null;
}
const sorted = (a) => a.slice().sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  let w, exit = 0;
  try {
    const nodeA = await lib.startNode('sync-node-a', 8281, 'accept');
    const phpB = await lib.startPhp('sync-php-b', 8282, 'accept');
    const nodeC = await lib.startNode('sync-node-c', 8283, 'accept');
    w = await L.launchWallet('friends-sync');
    const created = await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'friends-sync-password');
    w.pub = created.publicKey;
    const me = w.pub;

    // Switches for what the wallet's own fetches to an issuer's mail mode route do, and a clock offset.
    await w.sw.evaluate(() => {
      self.__modeCalls = [];
      self.__fail = { domain: null, kind: null };
      self.__skew = 0;
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + self.__skew;
      const real = self.fetch.bind(self);
      self.fetch = async (u, i) => {
        const url = String(u && u.url ? u.url : u);
        if (/\/atlas\/postoffice\/mailmode$/.test(url) && i && i.method === 'POST') {
          const domain = new URL(url).host;
          self.__modeCalls.push(domain);
          if (self.__fail.domain === domain) {
            if (self.__fail.kind === 'throw') throw new TypeError('Failed to fetch');
            return new Response('{"error":"down"}', { status: 500 });
          }
        }
        return real(u, i);
      };
    });
    const failAt = (domain, kind) => w.sw.evaluate((a) => { self.__fail = { domain: a[0], kind: a[1] }; }, [domain, kind]);
    const calls = () => w.sw.evaluate(() => self.__modeCalls.slice());
    const resetCalls = () => w.sw.evaluate(() => { self.__modeCalls = []; });

    for (const inst of [nodeA, phpB, nodeC]) await w.wallet((a) => AtlasWallet.mintAsset('self', a[0], a[1]), [inst.domain, POST_OFFICE]);
    for (const inst of [nodeA, phpB]) await w.wallet((d) => AtlasWallet.setPostOfficeMailMode(d, 'friendsOnly'), inst.domain);
    const on = [nodeA, phpB];
    const listsAre = (expected) => on.every((inst) => { const m = memberAt(inst, me); return m && m.mode === 'friendsOnly' && same(m.friends, sorted(expected)); });
    const f1 = await newPublicKey(), f2 = await newPublicKey(), pending = await newPublicKey();

    console.log('--- adding a friend ---');
    await w.wallet((k) => AtlasWallet.addFriend(k, 'First'), f1);
    check('a new friend reaches the Friends Only Post Offices (Node and PHP) without saving again', !!(await until(() => listsAre([f1]), 8000, 200)), on.map((i) => memberAt(i, me)));
    check('...and the Post Office left open is not given a list', same(memberAt(nodeC, me), { mode: 'open', friends: [] }), memberAt(nodeC, me));
    await w.wallet((k) => AtlasWallet.addFriend(k, 'Second'), f2);
    check('a second friend is added to the list at both', !!(await until(() => listsAre([f1, f2]), 8000, 200)), on.map((i) => memberAt(i, me)));

    console.log('--- removing a friend ---');
    const removed = await w.wallet((k) => AtlasWallet.removeFriend(k), f1);
    check('removing a friend has updated every Friends Only Post Office by the time it returns, and reports no failure', listsAre([f2]) && same(removed.syncFailed, []), { removed, lists: on.map((i) => memberAt(i, me)) });

    console.log('--- a pending outgoing friend request ---');
    const joined = await fetch('http://' + nodeA.domain + '/atlas/asset/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerPublicKey: pending, assetClass: POST_OFFICE }) });
    check('the person asked is a member of the first Post Office', joined.status === 200);
    const sentRequest = await w.wallet((a) => AtlasWallet.sendFriendRequest({ viaDomain: a[0], publicKey: a[1], recipientDomain: a[0], name: 'Pending' }), [nodeA.domain, pending]);
    check('sending a friend request is accepted', sentRequest && sentRequest.accepted === false && !sentRequest.warning, sentRequest);
    check('the person waited on is let through at every Friends Only Post Office, not only the one it was sent through', !!(await until(() => listsAre([f2, pending]), 8000, 200)), on.map((i) => memberAt(i, me)));
    const cancelled = await w.wallet((k) => AtlasWallet.cancelOutgoingFriendRequest(k), pending);
    check('cancelling the request takes them off every list by the time it returns', listsAre([f2]) && same(cancelled.syncFailed, []), { cancelled, lists: on.map((i) => memberAt(i, me)) });

    console.log('--- a Post Office that cannot be updated ---');
    for (const kind of ['throw', 'http500']) {
      await w.wallet((k) => AtlasWallet.addFriend(k, 'Third'), f1);
      await until(() => listsAre([f1, f2]), 8000, 200);
      await failAt(phpB.domain, kind);
      const r = await w.wallet((k) => AtlasWallet.removeFriend(k), f1);
      check('(' + kind + ') removing a friend reports the Post Office that could not be updated', same(r.syncFailed, [phpB.domain]), r);
      check('(' + kind + ') ...the other Post Office has the shorter list and the failing one still has the old one', !memberAt(nodeA, me).friends.includes(f1) && memberAt(phpB, me).friends.includes(f1), on.map((i) => memberAt(i, me)));
      const status = await w.wallet(() => AtlasWallet.getFriendsSyncStatus());
      check('(' + kind + ') ...and the failure is kept for the interface to show', status.automatic === true && status.failures.length === 1 && status.failures[0].domain === phpB.domain && !!status.failures[0].failedAt && !!status.failures[0].message, status);
      const stored = await w.sw.evaluate(() => chrome.storage.local.get('atlasFriendsSyncFailures'));
      check('(' + kind + ') ...in storage, naming no friend', !JSON.stringify(stored).includes(f1) && !JSON.stringify(stored).includes(f2), stored);

      // not hammered: within the retry pause a plain sync does not try the failing domain again
      await resetCalls();
      const quiet = await w.wallet(() => AtlasWallet.syncFriendsToPostOffices());
      check('(' + kind + ') a plain sync inside the pause does not call the failing Post Office again', quiet[phpB.domain] === 'failed' && !(await calls()).includes(phpB.domain), { quiet, calls: await calls() });
      // the pause ends: retried, and the failure is cleared
      await failAt(null, null);
      await w.sw.evaluate(() => { self.__skew = 11 * 60 * 1000; });
      const retried = await w.wallet(() => AtlasWallet.syncFriendsToPostOffices());
      await w.sw.evaluate(() => { self.__skew = 0; });
      check('(' + kind + ') once the pause is over the Post Office is tried again and brought up to date', retried[phpB.domain] === 'synced' && !memberAt(phpB, me).friends.includes(f1), { retried, lists: on.map((i) => memberAt(i, me)) });
      check('(' + kind + ') ...and the warning is cleared', (await w.wallet(() => AtlasWallet.getFriendsSyncStatus())).failures.length === 0);
    }

    console.log('--- try again now ---');
    await w.wallet((k) => AtlasWallet.addFriend(k, 'Fourth'), f1);
    await until(() => listsAre([f1, f2]), 8000, 200);
    await failAt(phpB.domain, 'throw');
    const r2 = await w.wallet((k) => AtlasWallet.removeFriend(k), f1);
    check('a failure is recorded again', same(r2.syncFailed, [phpB.domain]) && (await w.wallet(() => AtlasWallet.getFriendsSyncStatus())).failures.length === 1);
    await failAt(null, null);
    const forced = await w.wallet(() => AtlasWallet.syncFriendsToPostOffices({ force: true }));
    check('"Try again now" (force) retries straight away, without waiting out the pause', forced[phpB.domain] === 'synced' && !memberAt(phpB, me).friends.includes(f1) && (await w.wallet(() => AtlasWallet.getFriendsSyncStatus())).failures.length === 0, forced);

    console.log('--- leaving the Post Office that failed clears its warning ---');
    await w.wallet((k) => AtlasWallet.addFriend(k, 'Fifth'), f1);
    await until(() => listsAre([f1, f2]), 8000, 200);
    await failAt(phpB.domain, 'throw');
    await w.wallet((k) => AtlasWallet.removeFriend(k), f1);
    check('a failure is recorded for the PHP Post Office', (await w.wallet(() => AtlasWallet.getFriendsSyncStatus())).failures.length === 1);
    await failAt(null, null);
    const membership = await w.wallet((a) => AtlasWallet.getPostOfficeMemberships(a), me);
    const phpCard = membership.find((m) => m.domain === phpB.domain);
    await w.wallet((a) => AtlasWallet.deleteAsset(a[0], a[1]), [me, phpCard.credentialId]);
    await w.wallet(() => AtlasWallet.syncFriendsToPostOffices());
    check('after leaving that Post Office its warning is gone', (await w.wallet(() => AtlasWallet.getFriendsSyncStatus())).failures.length === 0);

    console.log('--- the wording, in the Settings page and the Services tab ---');
    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof AtlasWallet !== 'undefined' && !!document.getElementById('postOfficeMailModeInput'), null, { timeout: 15000 });
    const ui = await page.evaluate(() => ({
      options: [...document.getElementById('postOfficeMailModeInput').options].map((o) => [o.value, o.textContent.trim()]),
      note: document.getElementById('postOfficeMailModeSyncNote').textContent,
      help: document.getElementById('postOfficeMailModeHelp').textContent,
      page: document.body.textContent
    }));
    check('the Settings page offers "Anyone from participating Post Offices" and "Friends only"', JSON.stringify(ui.options) === JSON.stringify([['open', 'Anyone from participating Post Offices'], ['friendsOnly', 'Friends only']]), ui.options);
    check('...explains automatic synchronization, public keys only, and what a failure means', /automatically updates the allowed-sender public keys/.test(ui.note) && /add or remove a friend, or change a pending friend request/.test(ui.note) && /Only public keys are shared, not contact names or personal notes/.test(ui.note) && /If synchronization fails, the wallet will warn you/.test(ui.note), ui.note);
    check('...describes both choices, federated senders and friend requests', /eligible members of your Post Office and other federated Post Offices/.test(ui.help) && /approved friends and people you've sent friend requests to/.test(ui.help), ui.help);
    check('...and no longer says the list is a one-time snapshot, or offers the old wording', !/one-time snapshot|save again|Accept mail from anyone at this Post Office/.test(ui.page));
    const servicesSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'services-tab.js'), 'utf8');
    check('the Services tab uses the same wording and not the old', /Anyone from participating Post Offices/.test(servicesSource) && /automatically updates the allowed-sender public keys/.test(servicesSource) && !/Any member of this Post Office|Only your contacts/.test(servicesSource));

    // the warning in the Contacts tab and under the setting
    await w.sw.evaluate((a) => chrome.storage.local.set({ atlasFriendsSyncFailures: { [a[0]]: { [a[1]]: { at: new Date().toISOString(), message: 'no answer in time' } } } }), [me, 'down.example.test']);
    await page.evaluate(() => renderFriendsSyncWarnings());
    const warning = await page.evaluate(() => ({
      contacts: { hidden: document.getElementById('friendsSyncWarning').hidden, text: document.getElementById('friendsSyncWarning').textContent },
      settings: { hidden: document.getElementById('postOfficeFriendsSyncWarning').hidden, text: document.getElementById('postOfficeFriendsSyncWarning').textContent }
    }));
    check('a stored failure is shown in the Contacts tab and under the mail setting, naming the Post Office and the risk, with a retry', [warning.contacts, warning.settings].every((x) => !x.hidden && /down\.example\.test/.test(x.text) && /older list/.test(x.text) && /removed could still be able to message you/.test(x.text) && /Try again now/.test(x.text)), warning);
    await w.sw.evaluate(() => chrome.storage.local.remove('atlasFriendsSyncFailures'));
    await page.evaluate(() => renderFriendsSyncWarnings());
    check('...and it disappears when there is no failure', await page.evaluate(() => document.getElementById('friendsSyncWarning').hidden && document.getElementById('postOfficeFriendsSyncWarning').hidden));
    check('no page errors', errors.length === 0, errors);
  } catch (err) {
    console.log('FAIL unexpected error :: ' + (err && err.stack ? err.stack : err));
    exit = 1;
  } finally {
    if (w) await w.close();
    lib.stopAll();
  }
  exit = exit || L.finish('friends allowed-sender sync');
  process.exit(exit);
})();
