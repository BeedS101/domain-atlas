// Real-browser walk-through of the Multi-Issuer Portable Asset Lab: a visitor creates a jointly issued
// asset, both independent domains sign, the asset is exported, the owner (a key held in the browser)
// authorizes a transfer, both domains approve, and the receipt verifies; a second visitor on the other
// domain imports and checks old and current copies. Two PHP domains with their own keys and state.
// Screenshots go to $MI_SHOTS (default: the temporary working directory).
//
//   node test/manual-multi-issuer-browser.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Lab, verifyPortableJs } = require('./mi-lab.js');

const REPO = path.resolve(__dirname, '..');
const lab = new Lab('mi-browser-');
const SHOTS = process.env.MI_SHOTS || lab.root;
const BIG = 'callsPerIpPerMinute=10000,approvalsPerIpPerMinute=600,sessionsPerIpPerHour=1000,assetsPerIpPerHour=1000,transfersPerIpPerHour=2000,maxInflightPeer=32';
const assert = (c, m) => { if (!c) throw new Error('ASSERTION FAILED: ' + m); };
const pass = (m) => console.log('PASS: ' + m);
const txt = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();

async function main() {
  const pageA = path.join(REPO, 'demo-domain-a', 'multi-issuer.html'), pageB = path.join(REPO, 'demo-domain-b', 'multi-issuer.html');
  assert(fs.readFileSync(pageA).equals(fs.readFileSync(pageB)), 'the lab page is identical on both demo domains');
  assert(/multi-issuer\.html/.test(fs.readFileSync(path.join(REPO, 'demo-domain-a', 'index.html'), 'utf8')), 'demo-domain-a/index.html links to the lab');
  await lab.network({ names: ['a', 'b'], state: 'a', issuance: { t: 2, m: ['a', 'b'] }, transfer: { t: 2, m: ['a', 'b'] }, pub: BIG });
  fs.copyFileSync(pageA, path.join(lab.sites.a.docroot, 'multi-issuer.html'));
  fs.copyFileSync(pageB, path.join(lab.sites.b.docroot, 'multi-issuer.html'));
  const A = lab.sites.a.base + '/multi-issuer.html', B = lab.sites.b.base + '/multi-issuer.html';

  const browser = await chromium.launch();
  const errors = [], calls = [];
  const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); p.on('request', (r) => calls.push(r.url())); return p; };

  // ---------------------------------------------------------------- visitor 1 on the registry domain
  const ctx1 = await browser.newContext({ viewport: { width: 1100, height: 1800 }, acceptDownloads: true });
  const p1 = watch(await ctx1.newPage());
  await p1.goto(A);
  await p1.waitForSelector('#app', { state: 'visible' });
  await p1.waitForSelector('#visitor', { state: 'visible' });
  assert((await txt(p1, '.banner')).includes('NO REAL VALUE'), 'test banner shown');
  assert((await txt(p1, '#whoami')).includes('a.test'), 'domain identified');
  await p1.waitForFunction(() => document.querySelectorAll('#identTable tbody tr').length === 3);
  assert(!(await p1.isVisible('input[type="password"]')), 'no administrator token field exists');
  pass('visitor opens the page: banner, domain role, three browser-held test identities, no administrator token');

  await p1.fill('#assetLabel', 'browser walk');
  await p1.click('#btnCreate');
  await p1.waitForSelector('#assetPanel', { state: 'visible' });
  assert(/Joint Explorer Certificate #\d{6}/.test(await txt(p1, '#assetTitle')), 'asset name shown');
  assert((await txt(p1, '#issueQuorum')) === '0/2', 'issuance quorum 0/2');
  assert((await txt(p1, '#lvlIssuanceBody')).includes('NOT verified'), 'not verified before any signature');
  assert((await txt(p1, '#lvlOwnershipBody')).includes('not') , 'ownership not claimed before issuance');
  pass('create: a pending asset with the roster of two issuers and no verified issuance yet');

  await p1.click('button[data-issue="a.test"]');
  await p1.waitForFunction(() => document.querySelector('#issueQuorum').textContent === '1/2');
  assert((await txt(p1, '#lvlIssuanceBody')).includes('NOT verified'), 'one signature is not enough');
  assert((await txt(p1, '#aStatus')).includes('pending'), 'still pending after one signer');
  await p1.screenshot({ path: path.join(SHOTS, 'mi-1-one-signer.png'), fullPage: true });
  await p1.click('button[data-issue="b.test"]');
  await p1.waitForFunction(() => document.querySelector('#aStatus').textContent.includes('issued'));
  assert((await txt(p1, '#issueQuorum')) === '2/2', 'quorum 2/2');
  assert((await txt(p1, '#lvlIssuanceBody')).startsWith('Original issuance verified'), 'issuance verified in the browser');
  await p1.waitForFunction(() => document.querySelector('#lvlOwnershipBody').textContent.startsWith('Current ownership verified with the registry'));
  const disc = await txt(p1, '#discTable tbody');
  assert(/a\.test\s*verified/.test(disc) && /b\.test\s*verified/.test(disc) && disc.includes('asset.transfer.approve'), 'discovery results shown for both issuers: ' + disc);
  assert((await txt(p1, '#aOwner')).includes('alice'), 'alice owns it');
  await p1.screenshot({ path: path.join(SHOTS, 'mi-2-issued.png'), fullPage: true });
  pass('joint issuance: A then B approve; the browser itself verifies both signatures and the registry attestation; discovery results listed');

  // ---------------------------------------------------------------- export
  const assetId = await txt(p1, '#aId');
  const dl = p1.waitForEvent('download');
  await p1.click('#btnExport');
  const download = await (await dl).path();
  const exportedV0 = fs.readFileSync(download, 'utf8');
  const asset0 = JSON.parse(exportedV0);
  const js0 = await verifyPortableJs(asset0);
  assert(js0.issuanceVerified && js0.chainValid && js0.version === 0 && asset0.issuance.signatures.length === 2, 'exported file verifies independently');
  assert(!exportedV0.includes('127.0.0.1'), 'no endpoint is embedded in the exported asset');
  pass('export: portable JSON downloaded; verifies in an independent implementation; contains no endpoints');

  // ---------------------------------------------------------------- transfer
  await p1.selectOption('#newOwner', { label: await p1.$$eval('#newOwner option', (o) => o.map((x) => x.textContent).find((t) => t.startsWith('bob'))) });
  await p1.click('#btnPropose');
  await p1.waitForSelector('#xferBox', { state: 'visible' });
  assert((await txt(p1, '#xDigestOk')) === 'matches', 'transfer digest recomputed in the browser');
  await p1.waitForFunction(() => /server check: verified.*this browser: verified/.test(document.querySelector('#xOwnerAuth').textContent.replace(/\s+/g, ' ')));
  assert((await txt(p1, '#xQuorum')) === '0/2' && (await txt(p1, '#xStatus')) === 'pending', 'pending 0/2 after the owner signed');
  await p1.click('button[data-transfer="a.test"]');
  await p1.waitForFunction(() => document.querySelector('#xQuorum').textContent === '1/2');
  assert((await txt(p1, '#aOwner')).includes('alice'), 'ownership unchanged after one approval');
  await p1.click('button[data-transfer="b.test"]');
  await p1.waitForFunction(() => document.querySelector('#xStatus').textContent === 'executed');
  await p1.waitForFunction(() => /registry signature on the receipt: verified in this browser/.test(document.querySelector('#xReceipt').textContent));
  const cards = await txt(p1, '#xCards');
  assert((cards.match(/verified in this browser against the key in the asset/g) || []).length === 2 && (cards.match(/identical to the transfer digest/g) || []).length === 2, 'both approvals bind the identical digest and verify in the browser: ' + cards);
  await p1.waitForFunction(() => document.querySelector('#aOwner').textContent.includes('bob'));
  assert((await txt(p1, '#lvlOwnershipBody')).startsWith('Current ownership verified with the registry'), 'current ownership re-verified at version 1');
  const log = await txt(p1, '#log');
  for (const k of ['peer-approval-requested', 'peer-reply-received', 'quorum-reached', 'executed']) assert(log.includes(k), 'event log shows ' + k);
  await p1.screenshot({ path: path.join(SHOTS, 'mi-3-transferred.png'), fullPage: true });
  pass('transfer: Alice signs in the browser, A and B each validate independently and sign, ownership moves to Bob, receipt verifies; the event log shows the domain-to-domain exchange');

  const dl2 = p1.waitForEvent('download');
  await p1.click('#btnExport');
  const exportedV1 = fs.readFileSync(await (await dl2).path(), 'utf8');
  const asset1 = JSON.parse(exportedV1);
  const js1 = await verifyPortableJs(asset1);
  assert(js1.chainValid && js1.version === 1, 'second export carries the signed transfer');
  const idsDl = p1.waitForEvent('download');
  await p1.click('#btnIdExport');
  const identities = fs.readFileSync(await (await idsDl).path(), 'utf8');

  // alice can no longer move it: no identity in this tab... alice's key is not the owner any more
  assert((await p1.$eval('#newOwner', (s) => [...s.options].map((o) => o.textContent.split(' ')[0]))).indexOf('bob') < 0, 'the current owner is not offered as a recipient');
  pass('export after the transfer carries the signed history; identities exported for the second visitor');

  // ---------------------------------------------------------------- visitor 2 on the approving domain
  const ctx2 = await browser.newContext({ viewport: { width: 1100, height: 1800 } });
  const p2 = watch(await ctx2.newPage());
  await p2.goto(B);
  await p2.waitForSelector('#app', { state: 'visible' });
  assert(!(await p2.isVisible('#visitor')) && await p2.isVisible('#approverNotice'), 'the approving domain does not create assets');
  assert((await txt(p2, '#whoami')).includes('b.test'), 'B identified');
  await p2.fill('#impText', exportedV0);
  await p2.click('#btnImport');
  await p2.waitForSelector('#impResult', { state: 'visible' });
  await p2.waitForFunction(() => document.querySelector('#impOwnership').textContent.includes('Out of date'));
  assert((await txt(p2, '#impIssuance')).startsWith('Original issuance verified'), 'old copy: issuance verified');
  assert(!(await txt(p2, '#impOwnership')).includes('Current ownership verified'), 'old copy is NOT reported as current');
  assert((await txt(p2, '#impTable')).includes('matches this domain'), 'B recognizes its own pinned roster and policy');
  assert(/a\.test\s*verified/.test(await txt(p2, '#impDisc')) && /b\.test\s*verified/.test(await txt(p2, '#impDisc')), 'B discovered both issuers');
  await p2.screenshot({ path: path.join(SHOTS, 'mi-4-stale-import.png'), fullPage: true });
  await p2.fill('#impText', exportedV1);
  await p2.click('#btnImport');
  await p2.waitForFunction(() => document.querySelector('#impOwnership').textContent.startsWith('Current ownership verified'));
  pass('import on the other domain: the old export is "issuance verified" but out of date; the current export is current; policy read from the file');

  const tampered = JSON.parse(exportedV1);
  tampered.definition.metadata.label = 'tampered';
  await p2.fill('#impText', JSON.stringify(tampered));
  await p2.click('#btnImport');
  await p2.waitForFunction(() => document.querySelector('#impIssuance').textContent.includes('NOT verified'));
  const roster = JSON.parse(exportedV1);
  roster.definition.issuancePolicy.threshold = 1;
  await p2.fill('#impText', JSON.stringify(roster));
  await p2.click('#btnImport');
  await p2.waitForFunction(() => document.querySelector('#impIssuance').textContent.includes('NOT verified'));
  pass('import: modified metadata and a weakened threshold are both reported as not verified');

  await p2.fill('#assetId', assetId);
  await p2.click('#btnOpen');
  await p2.waitForSelector('#assetPanel', { state: 'visible' });
  await p2.waitForFunction(() => document.querySelector('#lvlOwnershipBody').textContent.length > 20);
  assert((await txt(p2, '#aStatus')).includes('relayed from a.test') && (await txt(p2, '#aStatus')).includes('matches'), 'B shows the asset relayed from the registry and re-verified under its own keys');
  assert((await txt(p2, '#lvlIssuanceBody')).startsWith('Original issuance verified'), 'B: issuance verified');
  assert((await txt(p2, '#issuerCards')).includes('own signing record: approve'), 'B shows its own signing record');
  assert((await txt(p2, '#xStatus')) === 'executed', 'B displays the executed transfer');
  await p2.waitForFunction(() => /registry signature on the receipt: verified in this browser/.test(document.querySelector('#xReceipt').textContent));
  await p2.screenshot({ path: path.join(SHOTS, 'mi-5-other-domain.png'), fullPage: true });
  pass('the same asset opened on the other domain: relayed, re-verified under its own pinned keys, with its own signing record and the same receipt');

  // ---------------------------------------------------------------- a different visitor cannot move it; the key holder can
  const ctx3 = await browser.newContext({ viewport: { width: 1100, height: 1800 } });
  const p3 = watch(await ctx3.newPage());
  await p3.goto(A);
  await p3.waitForSelector('#visitor', { state: 'visible' });
  await p3.fill('#assetId', assetId);
  await p3.click('#btnOpen');
  await p3.waitForSelector('#assetPanel', { state: 'visible' });
  await p3.waitForFunction(() => document.querySelector('#aOwner').textContent.length > 5);
  assert(await p3.isDisabled('#btnPropose'), 'a visitor with no key for the asset cannot propose');
  assert((await txt(p3, '#xferNote')).includes('None of the identities'), 'and is told why');
  pass('another visitor opens the same asset but cannot transfer it: ownership is the key, not the session');

  // load Bob's identity (exported earlier) into the third tab and move the asset onward
  const idPath = path.join(lab.root, 'ids.json');
  fs.writeFileSync(idPath, identities);
  await p3.setInputFiles('#idFile', idPath);
  await p3.waitForFunction(() => document.querySelector('#identTable').textContent.includes('current owner of the open asset'));
  await p3.waitForFunction(() => !document.querySelector('#btnPropose').disabled);
  const opt = await p3.$$eval('#newOwner option', (o) => o.map((x) => x.textContent).find((t) => t.startsWith('carol')));
  await p3.selectOption('#newOwner', { label: opt });
  await p3.click('#btnPropose');
  await p3.waitForSelector('#xferBox', { state: 'visible' });
  await p3.click('button[data-transfer="a.test"]');
  await p3.waitForFunction(() => document.querySelector('#xQuorum').textContent === '1/2');
  await p3.click('button[data-transfer="b.test"]');
  await p3.waitForFunction(() => document.querySelector('#xStatus').textContent === 'executed');
  await p3.waitForFunction(() => document.querySelector('#aOwner').textContent.includes('carol'));
  assert((await txt(p3, '#lvlOwnershipBody')).startsWith('Current ownership verified with the registry'), 'verified at version 2');
  await p3.screenshot({ path: path.join(SHOTS, 'mi-6-second-transfer.png'), fullPage: true });
  pass('Bob\'s key, imported into a different browser session, authorizes the next transfer; Bob can transfer next and Carol now owns it');

  // Alice's old state is dead
  const stale = await fetch(lab.sites.a.base + '/atlas/demo/multi-issuer/api.php?op=asset&id=' + assetId).then((r) => r.json());
  assert(stale.live.version === 2, 'registry at version 2');
  assert(errors.length === 0, 'no page or console errors: ' + errors.join(' | '));
  assert(!calls.some((u) => /op=(admin|reset|sign|create&|decide)/.test(u)), 'the page called no privileged operation');
  assert(lab.phpErrors().length === 0, 'no PHP errors: ' + lab.phpErrors().join(' | '));
  pass('no page errors, no privileged operations called, no PHP errors; screenshots in ' + SHOTS);
  await browser.close();
}

main().then(async () => { await lab.stopAll(); console.log('\nBROWSER TEST PASSED'); process.exit(0); }, async (e) => { console.error(e); await lab.stopAll(); console.error('workdir kept: ' + lab.root); process.exit(1); });
