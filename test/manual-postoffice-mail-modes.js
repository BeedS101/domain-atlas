// Who can contact a Post Office member, against real local Post Offices: the Node issuer and the PHP issuer, as the home
// Post Office and as the relaying one, in all four pairings.
//
//   - open mode admits eligible local senders and senders relayed from another Post Office
//   - friends-only mode checks the ORIGINAL sender's public key, for local and relayed mail alike, and a list update
//     (what the wallet's automatic synchronization sends) takes effect at once, in both directions
//   - a blocked sender is refused in every mode, and a block beats the allowed-sender list
//   - friend requests are ordinary mail: the same rules admit or refuse them
//   - going back to open clears the list; a refusal writes no mail
//
// Nothing here contacts a live domain: every issuer is a throw-away local instance with its own state.
// Run: node test/manual-postoffice-mail-modes.js
'use strict';
const { webcrypto } = require('crypto');
const http = require('http');
const { subtle } = webcrypto;
const proofLib = require('../issuer-server/lib-owner-proof');
const { startNode, startPhp, snapshot, stopAll } = require('./owner-proof-lib');

const POST_OFFICE = 'atlas.postoffice.membership';
const FRIEND_SUBJECT = '\u0000atlas.friend.v1';
const REFUSED = 'recipient is not accepting mail from you right now';
const b64u = (buf) => Buffer.from(buf).toString('base64url');

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

async function newKey() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pair, publicKey: b64u(await subtle.exportKey('raw', pair.publicKey)) };
}
async function envelope(key, payload) {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, new TextEncoder().encode(proofLib.canonicalize(payload)));
  return { payload, proof: { signerRole: 'raw-ecdsa', publicKey: key.publicKey, signature: b64u(sig) } };
}
function post(base, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + urlPath);
    const data = JSON.stringify(body);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const join = (inst, key) => post(inst.base, '/atlas/asset/issue', { ownerPublicKey: key.publicKey, assetClass: POST_OFFICE });
// `via` is the Post Office the sender talks to; `home` names the recipient's Post Office when it is another one.
const send = async (via, sender, recipient, subject, home) => post(via.base, '/atlas/postoffice/send', await envelope(sender, {
  to: Object.assign({ publicKey: recipient.publicKey }, home ? { domain: home.domain } : {}), subject, body: 'hello'
}));
const request = (via, sender, recipient, home) => send(via, sender, recipient, FRIEND_SUBJECT, home).catch((e) => ({ status: 0, body: { error: String(e) } }));
const setMode = async (inst, owner, mode, friends) => post(inst.base, '/atlas/postoffice/mailmode', await envelope(owner, mode === 'friendsOnly' ? { mode, friends } : { mode }));
const block = async (inst, owner, key) => post(inst.base, '/atlas/postoffice/block', await envelope(owner, { blockedPublicKey: key.publicKey }));
const unblock = async (inst, owner, key) => post(inst.base, '/atlas/postoffice/unblock', await envelope(owner, { blockedPublicKey: key.publicKey }));

async function suite(relaying, home) {
  const label = relaying.kind + ' relays to ' + home.kind;
  console.log('--- ' + label + ' ---');
  const R = await newKey(), L = await newKey(), F = await newKey(), X = await newKey();
  // R and L belong to the home Post Office; F belongs only to the relaying one.
  for (const [inst, key] of [[home, R], [home, L], [relaying, F], [home, X]]) {
    const r = await join(inst, key);
    if (r.status !== 200) check(label + ': member joined', false, r);
  }
  const mailBefore = () => snapshot(home).mail;
  const admitted = async (name, sender, via, homeArg, subject) => {
    const before = mailBefore();
    const r = subject === FRIEND_SUBJECT ? await request(via, sender, R, homeArg) : await send(via, sender, R, subject || 'hi', homeArg);
    check(label + ': ' + name + ' is delivered', r.status === 200 && !!r.body.id, r);
    check(label + ': ...and left one message', mailBefore() === before + 1);
    return r;
  };
  const refused = async (name, sender, via, homeArg, subject) => {
    const before = mailBefore();
    const r = subject === FRIEND_SUBJECT ? await request(via, sender, R, homeArg) : await send(via, sender, R, subject || 'hi', homeArg);
    const text = r.body.error || '';
    check(label + ': ' + name + ' is refused', r.status !== 200 && (r.status === 400 || r.status === 403) && text.includes(REFUSED), r);
    check(label + ': ...and left no message', mailBefore() === before);
  };
  const local = (sender, subject) => [sender, home, undefined, subject];
  const viaRelay = (sender, subject) => [sender, relaying, home, subject];
  const ok = (name, args, subject) => admitted(name, args[0], args[1], args[2], subject);
  const no = (name, args, subject) => refused(name, args[0], args[1], args[2], subject);

  // open
  await ok('open: a local member', local(L));
  await ok('open: a member of another Post Office, relayed', viaRelay(F));
  await ok('open: a friend request from a local member', local(L), FRIEND_SUBJECT);
  await ok('open: a friend request relayed from another Post Office', viaRelay(F), FRIEND_SUBJECT);

  // friends only, naming the local member
  let r = await setMode(home, R, 'friendsOnly', [L.publicKey]);
  check(label + ': friends only with one allowed sender is accepted', r.status === 200 && r.body.mailMode === 'friendsOnly' && r.body.friendsCount === 1, r);
  await ok('friends only: the allowed local sender', local(L));
  await no('friends only: a local member who is not on the list', local(X));
  await no('friends only: a relayed sender who is not on the list', viaRelay(F));
  await ok('friends only: a friend request from the allowed sender', local(L), FRIEND_SUBJECT);
  await no('friends only: a friend request from a sender who is not on the list', local(X), FRIEND_SUBJECT);
  await no('friends only: a relayed friend request from a sender who is not on the list', viaRelay(F), FRIEND_SUBJECT);

  // the list is replaced (what the wallet's synchronization sends): the relayed sender's own key decides, not the relaying Post Office
  r = await setMode(home, R, 'friendsOnly', [F.publicKey, X.publicKey]);
  check(label + ': a replaced list is accepted', r.status === 200 && r.body.friendsCount === 2, r);
  await ok('friends only: a relayed sender once on the list (the original sender\'s key is checked)', viaRelay(F));
  await ok('friends only: a relayed friend request once on the list', viaRelay(F), FRIEND_SUBJECT);
  await no('friends only: the local sender taken off the list', local(L));

  // a block always wins
  r = await block(home, R, F);
  check(label + ': blocking a sender is accepted', r.status === 200 && r.body.blockedSenders.includes(F.publicKey), r);
  await no('friends only: a relayed sender who is both listed and blocked', viaRelay(F));
  await no('friends only: a relayed friend request from a listed but blocked sender', viaRelay(F), FRIEND_SUBJECT);
  await ok('friends only: another listed sender is unaffected by the block', local(X));
  await setMode(home, R, 'open');
  await no('open: a relayed sender who is blocked', viaRelay(F));
  await no('open: a relayed friend request from a blocked sender', viaRelay(F), FRIEND_SUBJECT);
  await ok('open: a local sender who is not blocked', local(L));
  r = await block(home, R, L);
  await no('open: a blocked local sender', local(L));
  await no('open: a blocked local sender\'s friend request', local(L), FRIEND_SUBJECT);
  await unblock(home, R, F);
  await unblock(home, R, L);
  await ok('open: the relayed sender once unblocked', viaRelay(F));
  await ok('open: the local sender once unblocked', local(L));

  // empty list and mode changes
  r = await setMode(home, R, 'friendsOnly', []);
  check(label + ': friends only with an empty list is accepted', r.status === 200 && r.body.friendsCount === 0, r);
  await no('friends only with an empty list: a local sender', local(L));
  await no('friends only with an empty list: a relayed sender', viaRelay(F));
  r = await setMode(home, R, 'open');
  check(label + ': going back to open clears the list', r.status === 200 && r.body.mailMode === 'open' && r.body.friendsCount === 0, r);
  await ok('open again: a relayed sender', viaRelay(F));

  // list updates are validated the same way by both implementations
  r = await post(home.base, '/atlas/postoffice/mailmode', await envelope(R, { mode: 'friendsOnly' }));
  check(label + ': friends only without a list is refused', r.status === 400, r);
  r = await setMode(home, R, 'friendsOnly', Array.from({ length: 501 }, (_, i) => 'k' + i));
  check(label + ': a list of 501 keys is refused', r.status === 400, r);
  r = await setMode(home, R, 'friendsOnly', [F.publicKey, F.publicKey, 7, null, L.publicKey]);
  check(label + ': duplicates and non-text entries are dropped', r.status === 200 && r.body.friendsCount === 2, r);
  const outsider = await newKey();
  r = await setMode(home, outsider, 'friendsOnly', [F.publicKey]);
  check(label + ': someone without a membership cannot set a list', r.status === 400, r);
  const forged = await envelope(L, { mode: 'open' });
  r = await post(home.base, '/atlas/postoffice/mailmode', { payload: forged.payload, proof: Object.assign({}, forged.proof, { publicKey: R.publicKey }) });
  check(label + ': a list cannot be set for another member (the signature is the caller)', r.status === 400, r);
  await setMode(home, R, 'open');
}

(async () => {
  try {
    const nodeA = await startNode('modes-node-a', 8291, 'accept');
    const nodeB = await startNode('modes-node-b', 8292, 'accept');
    const phpA = await startPhp('modes-php-a', 8293, 'accept');
    const phpB = await startPhp('modes-php-b', 8294, 'accept');
    await suite(nodeA, nodeB);
    await suite(phpA, phpB);
    await suite(nodeA, phpB);
    await suite(phpA, nodeB);
  } catch (err) {
    failures++;
    console.log('FAIL unexpected error :: ' + (err && err.stack ? err.stack : err));
  } finally {
    stopAll();
  }
  console.log(failures ? '\nFAILED: ' + failures : '\nALL POST OFFICE MAIL MODE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
