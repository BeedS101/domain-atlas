// Trading Station bookkeeping in the wallet: a seller's listing becomes Settled only on authoritative evidence (the issuer's
// signed settlement mail), including when the staked item was issued by another domain than the station; a listing that has
// merely left the marketplace is never called settled and never offers Cancel; a claimed Mail attachment is recorded in
// Activity with the balances that were actually held, once, and a consolidation is not counted as something received;
// quantities are shown exactly in whole grams; the Sell form never rewrites an amount the seller typed.
//
// Disposable Chromium profiles with the real extension; throw-away Node or PHP issuers (own keys, state, revocation lists).
// S is the Trading Station, X issues the seller's ring. Nothing live is read or written.
//
//   xvfb-run -a node test/manual-trading-reconcile-activity.js [node|php|both] [--only=T2]
'use strict';
const U = require('./manual-gen1-unique-recovery');
const { check, scenario, mint, live, sum, trustPeers } = U;
const IRON = U.constants.IRON;
const { GOLD, MEMBER } = U.constants;
const RING = 'atlas.wearable.ring';
const which = U.which;

// ---------------------------------------------------------------- helpers
const records = (w) => w.W((k) => AtlasWallet.getSubmittedTrades(k), w.pub);
const refresh = (w) => w.W((k) => AtlasWallet.refreshSubmittedTrades(k), w.pub);
const checkMail = (w) => w.W(() => AtlasWallet.checkAllMail());
const activity = (w) => w.W(() => AtlasWallet.getActivityLog());
const mailOf = (w) => w.W((k) => AtlasWallet.getMail(k), w.pub);

// Two wallets, a station S and the ring's issuer X that trust each other as trading peers.
async function setup(w, S, ctx, kind, opts) {
  opts = opts || {};
  const X = await ctx.issuer(kind, { workers: 4 });
  trustPeers(S, [X.domain]); trustPeers(X, [S.domain]);
  const b = await ctx.fresh('buyer'); await b.create();
  for (const [wallet, who] of [[w, 'seller'], [b, 'buyer']]) {
    const r = await mint(wallet, S, MEMBER); if (r !== 'ok') throw new Error(who + ' membership: ' + JSON.stringify(r));
  }
  if (opts.sellerRing !== false) { const r = await mint(w, X, RING); if (r !== 'ok') throw new Error('ring: ' + JSON.stringify(r)); }
  if (opts.sellerGold) { const r = await mint(w, S, GOLD, opts.sellerGold); if (r !== 'ok') throw new Error('seller gold: ' + JSON.stringify(r)); }
  if (opts.buyerGold) { const r = await mint(b, S, GOLD, opts.buyerGold); if (r !== 'ok') throw new Error('buyer gold: ' + JSON.stringify(r)); }
  if (opts.buyerRing) { const r = await mint(b, X, RING); if (r !== 'ok') throw new Error('buyer ring: ' + JSON.stringify(r)); }
  return { X, b };
}

// The wallet posts a listing at S offering one of its held balances.
const post = (w, S, offerClass, offerQty, wantClass, wantQty, minutes) => w.W(async (a) => {
  const held = (await AtlasWallet.getWallet(a.k)).map((e) => e.credential);
  const membership = held.find((c) => c.asset.class === a.m && c.issuer.domain === a.s);
  const balance = held.find((c) => c.asset.class === a.oc && c.quantity >= a.oq);
  try { return await AtlasWallet.submitTradeIntent(a.s, membership, { class: a.oc, quantity: a.oq }, { class: a.wc, quantity: a.wq }, balance, a.min); }
  catch (e) { return { error: String(e.message).slice(0, 200) }; }
}, { k: w.pub, m: MEMBER, s: S.domain, oc: offerClass, oq: offerQty, wc: wantClass, wq: wantQty, min: minutes || 60 });

// The buyer claims the station's first listing with a balance of `payClass`.
const claimFirst = (b, S, payClass) => b.W(async (a) => {
  const held = (await AtlasWallet.getWallet(a.k)).map((e) => e.credential);
  const membership = held.find((c) => c.asset.class === a.m && c.issuer.domain === a.s);
  const balance = held.find((c) => c.asset.class === a.pc);
  const listings = await AtlasWallet.fetchTradeListings(a.s);
  try { await AtlasWallet.claimTradeListing(a.s, membership, listings[0], balance); return 'ok'; }
  catch (e) { return { message: String(e.message).slice(0, 200) }; }
}, { k: b.pub, m: MEMBER, s: S.domain, pc: payClass });

async function openViewer(w) {
  const id = new URL(w.sw.url()).host;
  const page = await w.context.newPage();
  await page.goto('chrome-extension://' + id + '/viewer.html');
  await page.waitForFunction(() => typeof AtlasWallet !== 'undefined' && typeof refreshTradingListingsList === 'function', null, { timeout: 20000 });
  return page;
}

// ---------------------------------------------------------------- scenarios
async function scenarios(kind) {
  await scenario(kind, 'T1 a ring issued by another domain is sold at the station: Settled only on the issuer\'s settlement mail', async (w, S, ctx) => {
    const { X, b } = await setup(w, S, ctx, kind, { sellerGold: 4, buyerGold: 10 });
    const posted = await post(w, S, RING, 1, GOLD, 5);
    const [rec] = await records(w);
    check('the listing is recorded as pending, with what was staked and who issued it', posted.status === 'pending' && !!rec && rec.status === 'pending' && rec.offerIssuer === X.domain && rec.domain === S.domain && !!rec.balanceId, { posted, rec });
    const view0 = await refresh(w);
    check('while the station lists it, it can be cancelled (listed)', view0[rec.pendingId] === 'listed', view0);

    const out = await claimFirst(b, S, GOLD);
    check('the buyer claims it: ring received, 5 gold paid, 5 gold left', out === 'ok' && (await live(b, RING)).length === 1 && sum(await live(b, GOLD)) === 5, { out });

    // The listing is gone from the marketplace, but nothing has proven yet that it was settled.
    const view1 = await refresh(w);
    const [rec1] = await records(w);
    check('off the marketplace without evidence: not Settled, not cancellable (unconfirmed, off-market)', view1[rec.pendingId] === 'off-market' && rec1.status === 'unconfirmed' && !rec1.settledEvidence, { view1, rec1 });

    // The settlement mail comes from the ring's issuer X, not from the station.
    await checkMail(w);
    const [rec2] = await records(w);
    check('after the mail check the listing is Settled, on the settlement mail naming the staked ring', rec2.status === 'settled' && !!rec2.settledAt && rec2.settledEvidence && rec2.settledEvidence.kind === 'settlement-mail', rec2);
    const view2 = await refresh(w);
    const [rec3] = await records(w);
    check('a further refresh leaves it Settled', rec3.status === 'settled' && view2[rec.pendingId] === undefined, { view2, rec3 });

    // The payment arrived as a mail attachment: 5 gold on top of the 4 already held.
    const mail = (await mailOf(w)).find((e) => e.message.subject === 'Listing claimed at ' + S.domain);
    check('the payment is waiting in Mail as a 5 g attachment, from the ring\'s issuer\'s mailbox', !!mail && mail.message.attachedAsset.quantity === 5 && mail.message.credentialId === rec.balanceId && !mail.claimed, mail && mail.message);
    const goldBefore = (await live(w, GOLD)).map((r) => r.q);
    const claimed = await w.W(async (a) => { try { const r = await AtlasWallet.claimMailGift(a.k, a.id); return { ok: true, q: r.credential.quantity }; } catch (e) { return { error: String(e.message) }; } }, { k: w.pub, id: mail.message.id });
    const log = await activity(w);
    const entries = log.filter((e) => e.meta && e.meta.kind === 'mail-claim');
    const m = entries[0] && entries[0].meta;
    check('claiming it records one Activity entry with the exact before, change and after', claimed.ok === true && entries.length === 1 && m.quantity === 5 && m.previousBalance === 4 && m.newBalance === 9 && m.domain === S.domain && m.source === 'Trading Station payment' && m.assetClass === GOLD && m.messageId === mail.message.id, { claimed, entries });
    check('the entry reads like the requested example', entries[0].text === 'Received 5 g Gold (Au)', entries[0] && entries[0].text);
    const rowsAfter = await live(w, GOLD);
    check('automatic consolidation merged 4 + 5 into one 9 g balance and was not counted as received', goldBefore.length === 1 && rowsAfter.length === 1 && rowsAfter[0].q === 9 && log.filter((e) => /^Received/.test(e.text)).length === 1, { goldBefore, rowsAfter, texts: log.map((e) => e.text).slice(0, 6) });

    const again = await w.W(async (a) => { try { await AtlasWallet.claimMailGift(a.k, a.id); return 'claimed twice'; } catch (e) { return String(e.message); } }, { k: w.pub, id: mail.message.id });
    const log2 = await activity(w);
    check('claiming the same message again is refused and adds no second entry or balance', /already been claimed/.test(again) && log2.filter((e) => e.meta && e.meta.kind === 'mail-claim').length === 1 && sum(await live(w, GOLD)) === 9, { again });

    // What the user sees.
    const page = await openViewer(w);
    await page.evaluate(() => refreshTradingListingsList());
    const card = await page.evaluate((id) => {
      const el = document.querySelector('#tradingListingsList .trade-card[data-pending-id="' + id + '"]');
      return el ? { status: el.dataset.status, text: el.textContent.replace(/\s+/g, ' '), cancel: !!el.querySelector('.trading-cancel-btn'), del: !!el.querySelector('.trading-delete-listing-btn') } : null;
    }, rec.pendingId);
    check('the Listings card says Settled and offers no Cancel, only Delete', !!card && card.status === 'settled' && /Settled/.test(card.text) && !card.cancel && card.del, card);
    check('the card shows what was offered with its issuing domain, and the exact amount asked for', !!card && card.text.includes('Unique item') && card.text.includes(RING) && card.text.includes('Issued by ' + X.domain) && card.text.includes('5 g ' + GOLD) && card.text.includes('Trading at ' + S.domain), card && card.text);
    await page.evaluate(() => refreshActivityLogDisplay());
    const act = await page.evaluate(() => document.getElementById('activityLogList').textContent.replace(/\s+/g, ' '));
    check('Activity shows the claim with Previous balance 4 g, Change +5 g and New balance 9 g', /Received 5 g Gold \(Au\)/.test(act) && /Previous balance:\s*4 g/.test(act) && /Change:\s*\+5 g/.test(act) && /New balance:\s*9 g/.test(act) && /Source:\s*Trading Station payment/.test(act), act.slice(0, 400));
    await page.close();
  }, { workers: 4 });

  await scenario(kind, 'T2 a listing withdrawn or expired elsewhere is never called Settled and never offers Cancel', async (w, S, ctx) => {
    const { b } = await setup(w, S, ctx, kind, { sellerGold: 10 });
    // Withdrawn from another device: the station drops it, this wallet's record is untouched.
    const posted = await post(w, S, GOLD, 5, IRON, 3);
    const [rec] = await records(w);
    check('a listing is posted', posted.status === 'pending' && rec.status === 'pending', posted);
    const withdrawn = await w.W(async (a) => {
      const payload = { pendingId: a.id, action: 'cancel' };
      const proof = await AtlasWallet.signWithSelf(payload);
      const res = await fetch('http://' + a.d + '/atlas/trade/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pendingId: a.id, intent: { payload, proof } }) });
      return res.status;
    }, { id: rec.pendingId, d: S.domain });
    check('it is withdrawn at the station by another device', withdrawn === 200, withdrawn);
    await refresh(w);
    const [rec1] = await records(w);
    check('the local record becomes unconfirmed, never settled', rec1.status === 'unconfirmed' && !rec1.settledEvidence, rec1);
    await checkMail(w);
    const [rec2] = await records(w);
    check('a mail check finds no settlement evidence, so it stays unconfirmed', rec2.status === 'unconfirmed', rec2);
    const cancel = await w.W(async (a) => { try { await AtlasWallet.cancelTradeListing(a.d, a.id); return 'cancelled'; } catch (e) { return String(e.message); } }, { d: S.domain, id: rec.pendingId });
    const [rec3] = await records(w);
    check('trying to cancel it explains that it is no longer listed and does not mark it canceled', /no longer on the marketplace/.test(cancel) && rec3.status === 'unconfirmed', { cancel, rec3 });
    const page = await openViewer(w);
    await page.evaluate(() => refreshTradingListingsList());
    const card = await page.evaluate((id) => {
      const el = document.querySelector('#tradingListingsList .trade-card[data-pending-id="' + id + '"]');
      return el ? { status: el.dataset.status, text: el.textContent.replace(/\s+/g, ' '), cancel: !!el.querySelector('.trading-cancel-btn'), check: !!el.querySelector('.trading-check-btn'), remove: !!el.querySelector('.trading-delete-listing-btn') } : null;
    }, rec.pendingId);
    check('the card says it is waiting for confirmation and offers Check again and Remove, not Cancel', !!card && card.status === 'unconfirmed' && /Waiting for confirmation/.test(card.text) && !card.cancel && card.check && card.remove, card);
    await page.close();
    // Expired: past its time and gone from the station.
    const second = await post(w, S, GOLD, 2, IRON, 1, 0.03);
    check('a short-lived listing is posted', second.status === 'pending', second);
    await U.sleep(3500);
    const view = await refresh(w);
    const recs = await records(w);
    const expired = recs.find((r) => r.pendingId === second.pendingId);
    check('after its time it is Expired, never Settled', expired.status === 'expired' && view[second.pendingId] === 'off-market', { expired, view });

    // Unreachable station: nothing is changed and Cancel is not offered.
    const third = await post(w, S, GOLD, 1, IRON, 1, 60);
    S.stop();
    const viewDown = await refresh(w);
    const recDown = (await records(w)).find((r) => r.pendingId === third.pendingId);
    check('with the station unreachable the record is left as it was and reported unreachable', viewDown[third.pendingId] === 'unreachable' && recDown.status === 'pending', { viewDown, recDown });
    const page2 = await openViewer(w);
    await page2.evaluate(() => refreshTradingListingsList());
    const card2 = await page2.evaluate((id) => {
      const el = document.querySelector('#tradingListingsList .trade-card[data-pending-id="' + id + '"]');
      return el ? { status: el.dataset.status, cancel: !!el.querySelector('.trading-cancel-btn'), check: !!el.querySelector('.trading-check-btn') } : null;
    }, third.pendingId);
    check('its card shows an unknown status with Check again and no Cancel', !!card2 && card2.status === 'unknown' && !card2.cancel && card2.check, card2);
    await page2.close();
    void b;
  }, { workers: 4 });

  await scenario(kind, 'T3 a unique item received through Mail is recorded without mass units', async (w, S, ctx) => {
    const { X, b } = await setup(w, S, ctx, kind, { sellerRing: false, sellerGold: 6, buyerRing: true });
    const posted = await post(w, S, GOLD, 5, RING, 1);
    check('the seller lists 5 gold for a ring', posted.status === 'pending', posted);
    const out = await claimFirst(b, S, RING);
    check('the buyer claims it with their ring', out === 'ok', out);
    await checkMail(w);
    const mail = (await mailOf(w)).find((e) => e.message.attachedAsset && e.message.attachedAsset.asset.class === RING);
    check('the ring arrives as a mail attachment', !!mail, null);
    const claimed = await w.W(async (a) => { try { await AtlasWallet.claimMailGift(a.k, a.id); return 'ok'; } catch (e) { return String(e.message); } }, { k: w.pub, id: mail.message.id });
    const entries = (await activity(w)).filter((e) => e.meta && e.meta.kind === 'mail-claim');
    const m = entries[0] && entries[0].meta;
    check('one entry: the item, its issuer and source, with no mass units and no balances', claimed === 'ok' && entries.length === 1 && m.fungible === false && m.assetClass === RING && m.domain === X.domain && m.previousBalance === undefined && m.newBalance === undefined && !/\bg\b/.test(entries[0].text), entries);
    const rec = (await records(w))[0];
    check('the seller\'s gold listing is Settled by the station\'s own settlement mail', rec.status === 'settled' && rec.settledEvidence.kind === 'settlement-mail', rec);
    const page = await openViewer(w);
    await page.evaluate(() => refreshActivityLogDisplay());
    const act = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('#activityLogList .info-card')).find((c) => c.querySelector('.name').textContent.startsWith('Received'));
      return card ? card.textContent.replace(/\s+/g, ' ') : '';
    });
    check('the claim card shows the issuer and source but no balance lines', /Issuer:\s*/.test(act) && /Source:\s*/.test(act) && !/Previous balance/.test(act), act.slice(0, 300));
    await page.close();
  }, { workers: 4 });

  await scenario(kind, 'T4 exact quantities and the Sell form', async (w, S) => {
    void S;
    const page = await openViewer(w);
    const shownMass = await page.evaluate(() => [0, 1, 999, 1000, 4992, 4993, 10000, 999999, 1000000, 1234567].map((n) => formatMass(n)));
    check('whole grams are exact, the larger unit is only a convenience', JSON.stringify(shownMass) === JSON.stringify(['0 g', '1 g', '999 g', '1,000 g (1 kg)', '4,992 g (4.992 kg)', '4,993 g (4.993 kg)', '10,000 g (10 kg)', '999,999 g (999.999 kg)', '1,000,000 g (1 t)', '1,234,567 g (1.234567 t)']), shownMass);
    check('a change of 1 g is visible: 4,992 g and 4,993 g read differently', shownMass[4] !== shownMass[5], shownMass);

    const form = await page.evaluate(async () => {
      // Two fungible classes with different rates and one unique class, as the Sell form would have loaded them.
      sellCatalogCache = [{ class: 'cls.a', name: 'A', exchangeRate: 1, fungible: true }, { class: 'cls.b', name: 'B', exchangeRate: 4, fungible: true }, { class: 'cls.u', name: 'U', fungible: false }];
      sellOfferHoldingsCache = new Map([['cls.a', { quantity: 500, name: 'A', fungible: true }], ['cls.u', { quantity: 1, name: 'U', fungible: false }]]);
      const fill = (sel, values) => { sel.innerHTML = values.map((v) => '<option value="' + v + '">' + v + '</option>').join(''); };
      fill(tradingSellOfferClassSelect, ['cls.a', 'cls.u']); fill(tradingSellWantClassSelect, ['cls.b', 'cls.u']);
      tradingSellOfferClassSelect.value = 'cls.a'; tradingSellWantClassSelect.value = 'cls.b';
      const type = (input, v) => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); };
      const out = {};
      type(tradingSellOfferQtyInput, '20');
      out.wantAfterOffer = tradingSellWantQtyInput.value;
      out.hintShown = !tradingSellSuggestionEl.hidden; out.hintText = tradingSellSuggestionTextEl.textContent;
      type(tradingSellWantQtyInput, '7');
      type(tradingSellOfferQtyInput, '30');
      out.wantKeptManualPrice = tradingSellWantQtyInput.value;
      out.offerKept = tradingSellOfferQtyInput.value;
      tradingSellUseSuggestionBtn.click();
      out.wantAfterButton = tradingSellWantQtyInput.value;
      type(tradingSellWantQtyInput, '9');
      tradingSellOfferClassSelect.dispatchEvent(new Event('change', { bubbles: true }));
      tradingSellWantClassSelect.dispatchEvent(new Event('change', { bubbles: true }));
      out.wantAfterClassChange = tradingSellWantQtyInput.value; out.offerAfterClassChange = tradingSellOfferQtyInput.value;
      tradingSellOfferClassSelect.value = 'cls.u'; tradingSellOfferClassSelect.dispatchEvent(new Event('change', { bubbles: true }));
      out.uniqueLocked = tradingSellOfferQtyInput.disabled && tradingSellOfferQtyInput.value === '1';
      out.hintHiddenForUnique = tradingSellSuggestionEl.hidden;
      out.wantUntouchedByUnique = tradingSellWantQtyInput.value;
      return out;
    });
    check('typing an offer amount does not write into the requested amount', form.wantAfterOffer === '0', form);
    check('the rate is shown as an optional hint, worked out from the exact amount typed', form.hintShown && /20 g of cls\.a is worth about 80 g of cls\.b/.test(form.hintText), form.hintText);
    check('a manually entered price is kept when the offered amount changes', form.wantKeptManualPrice === '7' && form.offerKept === '30', form);
    check('only the hint\'s button applies the suggestion (30 g at 1:4 = 120 g)', form.wantAfterButton === '120', form);
    check('changing a class does not overwrite either typed amount', form.wantAfterClassChange === '9' && form.offerAfterClassChange === '30', form);
    check('a unique item stays locked to 1, shows no hint, and leaves the other amount alone', form.uniqueLocked === true && form.hintHiddenForUnique === true && form.wantUntouchedByUnique === '9', form);
    await page.close();
  }, { workers: 4 });
}

async function main() {
  const kinds = which === 'both' ? ['node', 'php'] : [which];
  for (const kind of kinds) await scenarios(kind);
  const { passes, failures } = U.counts();
  console.log(`\ntrading reconcile and activity: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
