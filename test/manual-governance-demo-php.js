// Manual, end-to-end check for governance-demo.html against issuer-php —
// same "real HTTP calls against PHP's built-in dev server, no mocking"
// pattern as manual-reserve-bank-demo-php.js; this feature's own Node-side
// companion is manual-governance-demo.js. Not part of the permanent suite,
// same reasoning as the other manual-*.js scripts.
//
// Covers the same checks as the Node version, at the HTTP layer: three
// members joining, a short-deadline proposal, three votes with a live
// tally, a rejected double vote, a rejected non-member vote, a rejected
// early finalize, and a successful finalize once the deadline passes whose
// decision credential independently verifies against the domain's own
// published key.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const path = require('path');

const { subtle } = webcrypto;
const PORT = 8190; // isolated — distinct from every other manual-*.js/-php.js test's chosen port
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');

const GENERATED_FILES = [
  path.resolve(BUNDLE_DIR, 'lib', 'issuer-private-key.pem'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-key.json'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-revocations.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-governance-members-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-governance-proposals-store.json'),
];
function cleanGeneratedFiles() {
  for (const f of GENERATED_FILES) { try { fs.unlinkSync(f); } catch (err) {} }
  try { fs.rmdirSync(path.resolve(BUNDLE_DIR, '.well-known')); } catch (err) {}
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function genIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPublic = await subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: b64url(rawPublic) };
}
async function signPayload(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, data);
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}
function post(urlPath, body) {
  return fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}
function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
async function joinAssembly(identity) {
  const res = await post('/atlas/asset/issue', { ownerPublicKey: identity.publicKey, assetClass: 'atlas.demo.governance.membership', quantity: 1 });
  if (res.status !== 200) throw new Error('Failed to join assembly: ' + JSON.stringify(res.body));
  return res.body;
}
async function propose(identity, title, deadlineIso, description) {
  const payload = { title, deadline: deadlineIso, description: description || '' };
  const proof = await signPayload(identity, payload);
  return post('/atlas/demo/governance/propose', { payload, proof });
}
async function castVote(identity, proposalId, choice) {
  const payload = { proposalId, choice };
  const proof = await signPayload(identity, payload);
  return post('/atlas/demo/governance/vote', { payload, proof });
}
async function finalize(proposalId) {
  return post('/atlas/demo/governance/finalize', { proposalId });
}
async function verifyDecisionIndependently(decision) {
  const keyDoc = await fetch(BASE + '/.well-known/atlas-key.json', { cache: 'no-store' }).then((r) => r.json());
  const issuedAt = new Date(decision.issuedAt).getTime();
  const activeKey = (keyDoc.keys || []).find((k) => {
    const from = new Date(k.validFrom).getTime();
    const until = k.validUntil ? new Date(k.validUntil).getTime() : Infinity;
    return issuedAt >= from && issuedAt <= until;
  });
  if (!activeKey) return { valid: false, reason: 'no currently-valid key at issuedAt' };
  const payload = {
    id: decision.id, proposalId: decision.proposalId, title: decision.title, outcome: decision.outcome,
    yesCount: decision.yesCount, noCount: decision.noCount, totalVotes: decision.totalVotes,
    closedAt: decision.closedAt, issuedAt: decision.issuedAt
  };
  const data = new TextEncoder().encode(canonicalize(payload));
  const publicKey = await subtle.importKey('raw', Buffer.from(activeKey.publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const sigBuf = Buffer.from(decision.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sigOk = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sigBuf, data);
  return { valid: sigOk, reason: sigOk ? 'signature checks out' : "signature doesn't match" };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  console.log('SETUP: starting PHP\'s built-in dev server against issuer-php/test-router.php');
  cleanGeneratedFiles();
  const serverProc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    serverProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: PHP dev server up on port ' + PORT);

  try {
    console.log('STEP 1: Alice, Bob, and Charlie all join the assembly (open enrollment)');
    const alice = await genIdentity(), bob = await genIdentity(), charlie = await genIdentity(), dana = await genIdentity();
    await joinAssembly(alice);
    await joinAssembly(bob);
    await joinAssembly(charlie);
    console.log('PASS: three members minted atlas.demo.governance.membership; Dana deliberately left out');

    console.log('STEP 2: Alice proposes a vote with a short deadline');
    const deadline = new Date(Date.now() + 2000).toISOString();
    const proposeRes = await propose(alice, 'Extend the plaza market\'s opening hours', deadline, 'A short-fuse test proposal.');
    assert(proposeRes.status === 200, 'propose failed: ' + JSON.stringify(proposeRes.body));
    assert(proposeRes.body.status === 'open', 'expected a freshly-proposed vote to be open: ' + JSON.stringify(proposeRes.body));
    const proposalId = proposeRes.body.proposal.id;
    console.log('PASS: proposal', proposalId, 'opened, deadline in ~2s');

    console.log('STEP 3: Alice votes yes, Bob votes yes, Charlie votes no; tally updates live');
    const v1 = await castVote(alice, proposalId, 'yes');
    assert(v1.status === 200 && v1.body.tally.yes === 1 && v1.body.tally.no === 0, 'unexpected tally after Alice\'s vote: ' + JSON.stringify(v1.body));
    const v2 = await castVote(bob, proposalId, 'yes');
    assert(v2.status === 200 && v2.body.tally.yes === 2 && v2.body.tally.no === 0, 'unexpected tally after Bob\'s vote: ' + JSON.stringify(v2.body));
    const v3 = await castVote(charlie, proposalId, 'no');
    assert(v3.status === 200 && v3.body.tally.yes === 2 && v3.body.tally.no === 1, 'unexpected tally after Charlie\'s vote: ' + JSON.stringify(v3.body));
    console.log('PASS: live tally reads 2 yes / 1 no after all three votes');

    console.log('STEP 4: Alice tries to vote a second time — rejected');
    const doubleVote = await castVote(alice, proposalId, 'no');
    assert(doubleVote.status === 400, 'expected a double vote to be rejected, got status ' + doubleVote.status);
    assert(/already voted/.test(doubleVote.body.error || ''), 'unexpected double-vote error text: ' + JSON.stringify(doubleVote.body));
    console.log('PASS: double vote rejected ->', doubleVote.body.error);

    console.log('STEP 5: Dana, who never joined, tries to vote — rejected');
    const nonMemberVote = await castVote(dana, proposalId, 'yes');
    assert(nonMemberVote.status === 400, 'expected a non-member vote to be rejected, got status ' + nonMemberVote.status);
    assert(/join first/.test(nonMemberVote.body.error || ''), 'unexpected non-member error text: ' + JSON.stringify(nonMemberVote.body));
    console.log('PASS: non-member vote rejected ->', nonMemberVote.body.error);

    console.log('STEP 6: finalizing before the deadline passes is rejected');
    const tooEarly = await finalize(proposalId);
    assert(tooEarly.status === 400, 'expected an early finalize to be rejected, got status ' + tooEarly.status);
    assert(/still open/.test(tooEarly.body.error || ''), 'unexpected early-finalize error text: ' + JSON.stringify(tooEarly.body));
    console.log('PASS: early finalize rejected ->', tooEarly.body.error);

    console.log('STEP 7: waiting for the deadline to pass, then finalizing');
    await sleep(2200);
    const finalizeRes = await finalize(proposalId);
    assert(finalizeRes.status === 200, 'finalize failed: ' + JSON.stringify(finalizeRes.body));
    const decision = finalizeRes.body.decision;
    assert(decision.outcome === 'passed', 'expected outcome "passed" with 2 yes / 1 no, got: ' + JSON.stringify(decision));
    assert(decision.yesCount === 2 && decision.noCount === 1 && decision.totalVotes === 3, 'unexpected final counts: ' + JSON.stringify(decision));
    assert(decision.proposalId === proposalId, 'decision should reference the original proposal id');
    console.log('PASS: finalized ->', decision.outcome, '(' + decision.yesCount + ' yes / ' + decision.noCount + ' no)');

    console.log('STEP 8: the returned decision credential independently verifies against the domain\'s own published key');
    const verdict = await verifyDecisionIndependently(decision);
    assert(verdict.valid, 'expected the decision to independently verify, got: ' + verdict.reason);
    console.log('PASS:', verdict.reason);

    console.log('\nALL GOVERNANCE-DEMO CHECKS PASSED against a real PHP dev server.');
  } finally {
    serverProc.kill();
    cleanGeneratedFiles();
  }
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
});
