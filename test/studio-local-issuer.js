// Starts an isolated, throwaway PHP issuer with Studio minting enabled, for a controlled manual test
// with a real wallet in a real browser:  node test/studio-local-issuer.js [port]
// It copies issuer-php into a temporary docroot with a freshly generated issuer key and empty state,
// so no real key, domain or data is involved. Press Ctrl-C to stop it and delete everything.
const fs = require('fs');
const path = require('path');
const { StudioLab } = require('./studio-lab');

(async () => {
  const port = parseInt(process.argv[2] || '8788', 10);
  const lab = await StudioLab.start({ mint: true, port, config: { mintsPerIpPerHour: 50, challengesPerIpPerHour: 100 } });
  const spatial = {
    spec: 'domain-atlas/1.0', domain: lab.host, owner: { name: 'Local Studio Test', contact: 'demo@localhost' },
    defaultWorld: 'lobby',
    worlds: [
      { id: 'lobby', name: 'Lobby', entry: { scene: '/spatial/lobby/scene.json', renderer: ['procedural-v1'] },
        policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' } },
      { id: 'studio', name: 'Asset Studio', policy: { walletBridge: { read: true, sign: ['atlas.studio.mint/1'], offer: ['atlas.demo.studio.collectible'] } } },
    ],
    updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(spatial, null, 2));
  console.log('Studio test issuer running (isolated, fresh key, minting enabled)');
  console.log('  Studio page : ' + lab.origin + '/atlas/studio/index.html');
  console.log('  Issuer key  : ' + lab.origin + '/.well-known/atlas-key.json');
  console.log('  Issued state: ' + path.join(lab.private, 'replay') + '  (one file per issued credential)');
  console.log('  Studio state: ' + lab.studio);
  console.log('Press Ctrl-C to stop and delete everything.');
  const quit = async () => { await lab.stop(); lab.cleanup(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
})().catch((e) => { console.error(e); process.exit(1); });
