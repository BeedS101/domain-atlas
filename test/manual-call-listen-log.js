// The calling window logs how its listening requests are going, once per change: the first
// answer, a service that stops answering, and recovery. Needs the local demo domain on 8002
// (see test/manual-call-e2e.js). Run: xvfb-run -a node test/manual-call-listen-log.js
'use strict';
const L = require('./call-e2e-lib');
const { check, sleep, until } = L;

(async () => {
  const svc = await L.startCallService(null, { timers: { listenHoldMs: 600 } });
  const w = await L.launchWallet('listenlog');
  try {
    await w.create();
    await w.wallet((s) => AtlasWallet.setCallConfig({ service: s, devAllowHttp: true }), svc.origin);
    await w.openCallWindow();
    await w.setTimers({ retryMs: 300 });
    await w.available();
    const lines = async (p) => (await w.log()).filter((x) => x.startsWith(p));
    check('the first answer from the service is logged with its address', !!(await until(async () => (await lines('listen-ok:')).length === 1, 8000, 200)) && (await lines('listen-ok:'))[0] === 'listen-ok:' + svc.origin, await lines('listen-ok:'));
    await svc.close();
    check('a service that stops answering is logged as unreachable', !!(await until(async () => (await lines('listen-failed:')).length >= 1, 15000, 200)), await lines('listen-failed:'));
    await sleep(2500);
    check('and only once while it keeps failing', (await lines('listen-failed:')).length === 1, await lines('listen-failed:'));
    check('no uncaught page errors', w.errors.length === 0, w.errors);
  } finally {
    await w.close(); await svc.close().catch(() => {});
  }
  process.exit(L.finish('manual-call-listen-log'));
})();
