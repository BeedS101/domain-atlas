// Smoke run: two independent browser contexts, one call, no assertions on results (debug aid).
'use strict';
const H = require('./harness');
(async () => {
  const PORT = 9411, BASE = 'http://127.0.0.1:' + PORT;
  const srv = await H.startServer(PORT);
  const a = await H.launch('a'), b = await H.launch('b');
  try {
    const room = 'smoke';
    const A = await H.openCall(a, { room, me: 'alice', peer: 'bob', base: BASE });
    const B = await H.openCall(b, { room, me: 'bob', peer: 'alice', base: BASE });
    await H.pairKeys(A, B);
    await A.page.click('#call');
    await H.until(() => H.spikeState(B.page).then((s) => s === 'ringing'), 10000);
    console.log('bob state', await H.spikeState(B.page));
    await B.page.click('#answer');
    await H.until(() => H.spikeState(A.page).then((s) => s === 'in-call'), 20000);
    await H.sleep(3000);
    console.log('alice', await H.spikeState(A.page), JSON.stringify(await A.page.evaluate(() => window.__spike.getInfo())));
    console.log('bob', await H.spikeState(B.page), JSON.stringify(await B.page.evaluate(() => window.__spike.getInfo())));
    console.log('alice events', (await H.eventsOf(A.page)).join(' | '));
    console.log('bob events', (await H.eventsOf(B.page)).join(' | '));
  } finally {
    await a.close(); await b.close(); srv.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
