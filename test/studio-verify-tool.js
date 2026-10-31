// tools/verify-credential.js against a real minted Studio credential: passes, and fails when the credential is altered.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { StudioLab, makeIdentity, DESIGN } = require('./studio-lab');

(async () => {
  const lab = await StudioLab.start({ mint: true });
  let failed = false;
  try {
    const owner = makeIdentity('raw-ecdsa');
    const r = await lab.mintAs(owner, DESIGN);
    if (r.mint.status !== 200) throw new Error('mint failed: ' + JSON.stringify(r.mint.json));
    const cred = r.mint.json.credential;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cred-'));
    const run = (c) => {
      const f = path.join(dir, 'c.json');
      fs.writeFileSync(f, JSON.stringify(c));
      return spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'verify-credential.js'), f, '--base', lab.base], { encoding: 'utf8' });
    };
    const good = run(cred);
    if (good.status !== 0) throw new Error('genuine credential did not verify:\n' + good.stdout + good.stderr);
    console.log('ok   a minted Studio credential verifies');
    const forged = JSON.parse(JSON.stringify(cred));
    forged.asset.properties['atlas.studio.name'] = 'Forged';
    const bad = run(forged);
    if (bad.status === 0 || !/FAIL issuer signature verifies/.test(bad.stdout)) throw new Error('altered credential was not rejected:\n' + bad.stdout);
    console.log('ok   an altered credential is rejected');
    const other = JSON.parse(JSON.stringify(cred));
    other.owner.publicKey = makeIdentity('raw-ecdsa').publicKeyB64;
    if (run(other).status === 0) throw new Error('credential with another owner was not rejected');
    console.log('ok   a credential re-addressed to another owner is rejected');
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    failed = true;
    console.error('FAIL ' + e.message);
  } finally {
    await lab.stop();
    lab.cleanup();
  }
  process.exit(failed ? 1 : 0);
})();
