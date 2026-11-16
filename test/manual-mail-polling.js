// How the wallet checks Global Mail on its own, in the real extension against a throw-away demo issuer: the usual rate is one minute
// and a rate the person chose is kept; nothing is asked when nothing is held or the service is switched off; two checks never run
// at once, within a page or across pages; a domain that asks the wallet to wait (Retry-After) is left alone and is not shown as a
// failure; a domain that fails is backed off from, and only the person's own "Check now" tries it sooner; the status colour comes
// from what the checks found and adds no requests.
//
// Needs the local demo domain on 8002:
//   PORT=8002 ATLAS_DOMAIN=localhost:8002 ATLAS_DOCROOT=demo-domain-b ATLAS_STATE_DIR=$(mktemp -d) \
//     ATLAS_PRIVATE_MINT=off ATLAS_MINT_LIMITS=off node issuer-server/server.js
// Run: xvfb-run -a node test/manual-mail-polling.js          (takes about two minutes: it waits out real one-minute timers)
'use strict';
const L = require('./call-e2e-lib');
const { check, until } = L;
const D = L.MAIL_DOMAIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const w = await L.launchWallet('mail-polling');
  let exit = 0;
  try {
    const created = await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'mail-polling-password');
    w.pub = created.publicKey;

    // Everything the wallet sends, and a switch that makes the mail check answer the way a busy or failing domain would.
    await w.sw.evaluate(() => {
      self.__sent = [];
      self.__mode = 'real';
      const real = self.fetch.bind(self);
      self.fetch = async (u, i) => {
        const url = String(u && u.url ? u.url : u);
        self.__sent.push(url + ' ' + ((i && i.method) || 'GET'));
        if (/\/atlas\/mail\/check$/.test(url)) {
          if (self.__mode === 'limit') return new Response(JSON.stringify({ code: 'busy' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '120' } });
          if (self.__mode === 'fail') return new Response(JSON.stringify({ code: 'error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
          if (self.__mode === 'slow') await new Promise((r) => setTimeout(r, 1500));
        }
        return real(u, i);
      };
    });
    const mode = (m) => w.sw.evaluate((x) => { self.__mode = x; }, m);
    // Requests made by the background worker are counted there; requests made by a wallet page are counted by the page.
    let pageChecks = 0;
    const watch = (p) => p.on('request', (req) => { if (req.method() === 'POST' && /\/atlas\/mail\/check$/.test(req.url())) pageChecks++; });
    const checks = async () => (await w.sw.evaluate(() => self.__sent.slice())).filter((s) => /\/atlas\/mail\/check POST/.test(s)).length + pageChecks;
    const anything = async () => (await w.sw.evaluate(() => self.__sent.slice())).filter((s) => !/^chrome-extension:/.test(s));
    const cooldown = () => w.sw.evaluate(() => chrome.storage.session.get('atlasMailCooldowns').then((r) => r.atlasMailCooldowns || {}));
    const clear = () => w.sw.evaluate(() => chrome.storage.session.remove(['atlasMailCooldowns', 'atlasMailLoop']));
    const status = async () => (await w.wallet((d) => AtlasWallet.getServices().service(d, 'postOffice'), D));

    console.log('--- the rate ---');
    let settings = await w.wallet(() => AtlasWallet.getMailSettings());
    check('a wallet that never chose a rate checks every minute', settings.intervalMinutes === 1 && settings.intervalIsDefault === true, settings);
    await w.wallet(() => AtlasWallet.setMailCheckInterval(15));
    settings = await w.wallet(() => AtlasWallet.getMailSettings());
    check('a rate the person chose is kept, not replaced by the new default', settings.intervalMinutes === 15 && settings.intervalIsDefault === false, settings);
    await w.wallet(() => AtlasWallet.checkAllMail());
    settings = await w.wallet(() => AtlasWallet.getMailSettings());
    check('checking does not overwrite it', settings.intervalMinutes === 15, settings);
    await w.wallet(() => AtlasWallet.resetMailCheckInterval());
    settings = await w.wallet(() => AtlasWallet.getMailSettings());
    check('resetting returns to the one-minute default', settings.intervalMinutes === 1 && settings.intervalIsDefault === true, settings);

    console.log('--- nothing is asked when there is nothing to ask ---');
    // A second identity that holds nothing; the main identity gets its card afterwards.
    const empty = await w.wallet(() => AtlasWallet.createSubIdentity('empty'));
    await w.wallet((id) => AtlasWallet.switchIdentity(id), empty.id);
    let r = await w.wallet(() => AtlasWallet.runScheduledMailCheck());
    check('with no card held a scheduled check runs and sends nothing at all', r.ran === true && (await anything()).length === 0, await anything());
    await w.wallet(() => AtlasWallet.switchIdentity(null));
    await clear();

    console.log('--- two checks never run at once ---');
    await w.wallet((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), D);
    await mode('slow');
    const before = await checks();
    const both = await w.wallet(() => Promise.all([AtlasWallet.runScheduledMailCheck(), AtlasWallet.runScheduledMailCheck()]));
    check('started together, exactly one runs and the other waits its turn', both.filter((x) => x.ran).length === 1, both);
    check('and only one request went out', (await checks()) === before + 1, (await checks()) - before);
    await mode('real');
    r = await w.wallet(() => AtlasWallet.runScheduledMailCheck());
    check('another one straight after is skipped: it is not yet time', r.ran === false && r.reason === 'recent', r);
    check('still one request', (await checks()) === before + 1);

    console.log('--- a service that is off, or not listed ---');
    await w.wallet((d) => AtlasWallet.getServices().addDomain(d), D);
    check('adding the domain did not switch anything on or ask the domain for mail', Object.keys((await w.wallet(() => AtlasWallet.getServices().load())).enabled).length === 0);
    await w.wallet((d) => AtlasWallet.getServices().setEnabled(d, 'postOffice', false), D);
    let n = await checks();
    await w.wallet(() => AtlasWallet.checkAllMail({ scheduled: true }));
    check('switched off: the background check does not present the card or contact the domain', (await checks()) === n);
    await w.wallet((d) => AtlasWallet.getServices().setEnabled(d, 'postOffice', true), D);
    await w.wallet(() => AtlasWallet.checkAllMail({ scheduled: true }));
    check('switched on: it asks again', (await checks()) === n + 1);

    console.log('--- a domain that asks the wallet to wait ---');
    await clear();
    await mode('limit');
    n = await checks();
    await w.wallet(() => AtlasWallet.checkAllMail({ scheduled: true }));
    check('the check was made once and was told to wait', (await checks()) === n + 1);
    const wait = Object.values(await cooldown())[0];
    check('the wait it asked for is kept (about two minutes)', wait && wait.asked === true && wait.until - Date.now() > 100000 && wait.until - Date.now() <= 125000, wait);
    await w.wallet(() => AtlasWallet.checkAllMail({ scheduled: true }));
    check('the next scheduled check does not ask during the wait', (await checks()) === n + 1);
    await w.wallet(() => AtlasWallet.checkAllMail({ interactive: true }));
    check('not even the person\'s own check overrides what the domain asked for', (await checks()) === n + 1);
    let s = await status();
    check('being asked to wait is not shown as a problem with the service', s.status.state !== 'problem', s.status);

    console.log('--- a domain that fails ---');
    await clear();
    await mode('fail');
    n = await checks();
    await w.wallet(() => AtlasWallet.checkAllMail({ scheduled: true }));
    check('one request fails', (await checks()) === n + 1);
    let c1 = Object.values(await cooldown())[0];
    check('the wallet backs off from it', c1 && c1.fails === 1 && c1.asked === false && c1.until > Date.now() + 20000, c1);
    await w.wallet(() => AtlasWallet.checkAllMail({ scheduled: true }));
    check('the next scheduled check stays away', (await checks()) === n + 1);
    await w.wallet(() => AtlasWallet.checkAllMail({ interactive: true }));
    check('the person\'s own check may try sooner', (await checks()) === n + 2);
    const c2 = Object.values(await cooldown())[0];
    check('and a repeated failure waits longer', c2 && c2.fails === 2 && c2.until > c1.until, [c1, c2]);
    s = await status();
    check('a verified failure is shown as a problem, with its reason', s.status.state === 'problem' && /failed/.test(s.status.text), s.status);

    console.log('--- recovery ---');
    await mode('real');
    await clear();
    n = await checks();
    await w.wallet(() => AtlasWallet.checkAllMail({ scheduled: true }));
    check('once the domain answers, the wait is gone', (await checks()) === n + 1 && Object.keys(await cooldown()).length === 0, await cooldown());
    s = await status();
    check('and the status turns green only because a check really worked', s.status.state === 'active', s.status);

    console.log('--- the status adds no requests ---');
    n = (await anything()).length;
    for (let i = 0; i < 3; i++) await status();
    check('reading the status sends nothing', (await anything()).length === n);

    console.log('--- real timers, one wallet page ---');
    await clear();
    await w.wallet(() => AtlasWallet.resetMailCheckInterval());
    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    watch(page);
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    const second = await w.context.newPage();
    second.on('pageerror', (e) => errors.push(e.message));
    watch(second);
    await second.goto('chrome-extension://' + w.extId + '/viewer.html');
    await second.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    await second.evaluate(() => routeWalletScreen());
    await second.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    await sleep(3000);
    const base = await checks();
    const started = Date.now();
    // Two wallet pages are open; each has its own timer of about a minute.
    const first = await until(async () => (await checks()) > base, 85000, 500);
    check('a check happens on its own after about a minute', !!first && Date.now() - started > 40000 && Date.now() - started < 80000, Date.now() - started);
    await sleep(15000);
    check('with two wallet pages open it was still one request, not two', (await checks()) === base + 1, (await checks()) - base);
    check('no page errors', errors.length === 0, errors);
  } catch (err) {
    console.log('FAIL unexpected error :: ' + (err && err.stack ? err.stack : err));
    exit = 1;
  } finally {
    await w.close();
  }
  exit = exit || L.finish('mail polling');
  process.exit(exit);
})();
