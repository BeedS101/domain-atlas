// The operator command line tools: tools/chainlabs-operator.js (keys, roster, signed calls) and chain-labs/lib/operator-cli.php (roster care on the server).
//
//   node test/chain-labs-operator-cli.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const S = require('./support/chain-labs-servers');
const { A, nodes, start } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + String(JSON.stringify(detail)).slice(0, 400) : '')); };
const ROOT = path.join(__dirname, '..');
const cli = (args) => spawnSync('node', [path.join(ROOT, 'tools/chainlabs-operator.js'), ...args], { encoding: 'utf8' });
const php = (priv, args) => spawnSync('php', [path.join(ROOT, 'chain-labs/lib/operator-cli.php'), ...args, '--private=' + priv], { encoding: 'utf8' });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-cli-'));
  await start(nodes[A]);
  const a = nodes[A];
  try {
    console.log('== keys and the roster');
    const idFile = path.join(tmp, 'operator.json');
    const k = cli(['keygen', '--out', idFile, '--label', 'laptop']);
    line(k.status === 0 && /public key: /.test(k.stdout), 'keygen writes an identity', k);
    line((fs.statSync(idFile).mode & 0o077) === 0, 'readable by its owner only');
    line(cli(['keygen', '--out', idFile]).status !== 0, 'and does not overwrite one');
    const rosterFile = path.join(tmp, 'chainlabs-operators.json');
    const init = cli(['roster-init', '--identity', idFile, '--domain', 'A.Example', '--out', rosterFile, '--label', 'laptop']);
    const roster = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    const token = (init.stdout.match(/\n([a-f0-9]{64})\n/) || [])[1];
    line(roster.domain === 'a.example' && roster.keys.length === 1 && token && roster.legacyTokenSha256 === S.OP.sha256(token), 'roster-init makes a roster with the key and the hash of a token', init.stdout);
    line(!fs.readFileSync(rosterFile, 'utf8').includes('privateKeyJwk') && !fs.readFileSync(rosterFile, 'utf8').includes(token), 'which holds no private key and not the token');
    const noTok = cli(['roster-init', '--identity', idFile, '--domain', 'a.example', '--out', path.join(tmp, 'r2.json'), '--no-token']);
    line(noTok.status === 0 && !('legacyTokenSha256' in JSON.parse(fs.readFileSync(path.join(tmp, 'r2.json'), 'utf8'))), 'a roster can start without a token');
    line(cli(['roster-init', '--identity', idFile, '--domain', 'a.example', '--out', path.join(tmp, 'r3.json'), '--actions', 'spend34/nonsense']).status !== 0, 'an unknown action is refused');

    console.log('\n== signed calls');
    const identity = S.OP.loadIdentity(idFile);
    S.writeRoster(a, { keys: [{ publicKey: identity.publicKey, label: 'laptop' }] });
    const url = 'http://127.0.0.1:' + a.port;
    const ver = cli(['verify', '--identity', idFile, '--url', url, '--host', A]);
    line(ver.status === 0 && JSON.parse(ver.stdout).verified === true, 'verify proves the key', ver);
    const act = cli(['activate', '--identity', idFile, '--url', url, '--host', A]);
    line(act.status !== 0 && /--yes/.test(act.stderr), 'activate asks for --yes first');
    const coin = cli(['call', 'coin26/create', '--identity', idFile, '--url', url, '--host', A, '--json', JSON.stringify(S.coinRequest('CLI'))]);
    const created = coin.status === 0 ? JSON.parse(coin.stdout) : null;
    line(created && created.ok && created.id, 'a call creates a coin', coin);
    const open = cli(['call', 'spend34/open', '--identity', idFile, '--url', url, '--host', A, '--json', JSON.stringify({ coinId: created && created.id })]);
    line(open.status === 0, 'and opens it', open);
    const g = ['call', 'spend34/grant', '--identity', idFile, '--url', url, '--host', A, '--json', JSON.stringify({ coinId: created && created.id, to: S.wallet().key, amount: '5' })];
    line(cli(g).status === 0, 'and grants');
    const dup = cli(g);
    line(dup.status !== 0 && /duplicate-request/.test(dup.stdout), 'the same grant a moment later is refused as a duplicate', dup.stdout);
    line(cli([...g, '--allow-repeat']).status === 0, 'unless --allow-repeat is given');
    const aud = cli(['audit', '--identity', idFile, '--url', url, '--host', A]);
    line(aud.status === 0 && JSON.parse(aud.stdout).chain.ok === true, 'audit reads the trail', aud.stderr);
    const wrong = cli(['call', 'spend34/grant', '--identity', idFile, '--url', url, '--host', 'b.example', '--json', '{}']);
    line(wrong.status !== 0, 'a call signed for another domain fails');
    line(cli(['call', 'spend34/unknown', '--identity', idFile, '--url', url]).status !== 0, 'an unknown action is refused before anything is sent');
    const down = cli(['verify', '--identity', idFile, '--url', 'http://127.0.0.1:9', '--host', A]);
    line(down.status === 3 && /not known/.test(down.stderr), 'when no answer arrives the outcome is reported as unknown', down);
    line(cli(['verify', '--identity', idFile, '--url', 'http://example.com']).status !== 0, 'plain http to another computer is refused');

    console.log('\n== the roster on the server');
    const priv = fs.mkdtempSync(path.join(tmp, 'priv-'));
    const root = path.join(tmp, 'web'); fs.mkdirSync(root);
    const st0 = php(priv, ['status', '--domain=a.example']);
    line(st0.status === 0 && /roster\s+none/.test(st0.stdout), 'status works with no roster yet', st0);
    const second = S.OP.newIdentity();
    const add = php(priv, ['add-key', '--domain=a.example', '--key=' + identity.publicKey, '--label=laptop']);
    line(add.status === 0, 'add-key starts a roster', add);
    line((fs.statSync(path.join(priv, 'chainlabs-operators.json')).mode & 0o777) === 0o600, 'with strict permissions');
    line(php(priv, ['add-key', '--key=' + identity.publicKey]).status !== 0, 'the same key is not added twice');
    line(php(priv, ['add-key', '--key=' + second.publicKey, '--actions=spend34/grant,nonsense']).status !== 0, 'an unknown action is refused');
    line(php(priv, ['add-key', '--key=not-a-key']).status !== 0, 'and so is a key that is not one');
    line(php(priv, ['add-key', '--key=' + second.publicKey, '--label=treasury', '--actions=spend34/grant']).status === 0, 'a key limited to one action is added');
    // A limited key is given more actions, or a new list, without being removed and added again.
    const rosterNow = () => JSON.parse(fs.readFileSync(path.join(priv, 'chainlabs-operators.json'), 'utf8'));
    const fp2 = require('crypto').createHash('sha256').update(second.publicKey).digest('hex').slice(0, 16);
    const consent = ['spend34/consent-list', 'spend34/consent-accept', 'spend34/consent-decline'];
    const g1 = php(priv, ['grant-actions', '--fingerprint=' + fp2, '--actions=' + consent.join(',')]);
    line(g1.status === 0 && JSON.stringify(rosterNow().keys[1].actions) === JSON.stringify(['spend34/grant', ...consent]), 'grant-actions adds actions to a limited key and keeps the ones it had', [g1.stdout, rosterNow().keys[1]]);
    line(php(priv, ['grant-actions', '--fingerprint=' + fp2, '--actions=spend34/consent-list,spend34/grant']).status === 0 && rosterNow().keys[1].actions.length === 4, 'granting an action the key has already changes nothing');
    line(rosterNow().keys[1].publicKey === second.publicKey && rosterNow().keys[1].label === 'treasury' && !rosterNow().keys[1].revoked, 'the key, its label and its standing are untouched');
    line(php(priv, ['grant-actions', '--fingerprint=' + fp2, '--actions=nonsense']).status !== 0 && rosterNow().keys[1].actions.length === 4, 'an unknown action is refused and nothing is written');
    line(php(priv, ['grant-actions', '--fingerprint=0000000000000000', '--actions=spend34/grant']).status === 2, 'a key that is not on the roster is refused');
    const g0 = php(priv, ['grant-actions', '--key=' + identity.publicKey, '--actions=spend34/consent-list']);
    line(g0.status === 0 && !('actions' in rosterNow().keys[0]) && /every action/.test(g0.stdout), 'a key that may take every action stays that way, and the tool says so', g0.stdout);
    line(php(priv, ['set-actions', '--fingerprint=' + fp2, '--actions=spend34/integrity']).status === 0 && JSON.stringify(rosterNow().keys[1].actions) === JSON.stringify(['spend34/integrity']), 'set-actions replaces the list');
    line(php(priv, ['set-actions', '--fingerprint=' + fp2, '--actions=all']).status === 0 && !('actions' in rosterNow().keys[1]), 'set-actions with all lifts the limit');
    line(php(priv, ['set-actions', '--fingerprint=' + fp2]).status === 2 && php(priv, ['set-actions', '--fingerprint=' + fp2, '--actions=']).status === 2, 'set-actions needs an explicit list or all');
    php(priv, ['set-actions', '--fingerprint=' + fp2, '--actions=spend34/grant']);
    line(/spend34\/grant/.test(php(priv, ['status']).stdout), 'status shows a key\'s actions');
    line(['consent-list', 'consent-accept', 'consent-decline'].every((x) => S.OP.ACTIONS.has('spend34/' + x)) && S.OP.READING.has('spend34/consent-list') && S.OP.CHANGING.has('spend34/consent-accept') && S.OP.CHANGING.has('spend34/consent-decline'), 'the command line tool knows the three consent actions, the list as a read and the other two as changes');
    const saved = JSON.parse(fs.readFileSync(path.join(priv, 'chainlabs-operators.json'), 'utf8'));
    line(saved.keys.length === 2 && saved.keys[1].actions[0] === 'spend34/grant', 'it is in the file');
    const tok = php(priv, ['set-token']);
    const newToken = (tok.stdout.match(/\n([a-f0-9]{64})\n/) || [])[1];
    const afterTok = JSON.parse(fs.readFileSync(path.join(priv, 'chainlabs-operators.json'), 'utf8'));
    line(newToken && afterTok.legacyTokenSha256 === S.OP.sha256(newToken) && !JSON.stringify(afterTok).includes(newToken), 'set-token stores only the hash', tok.stdout);
    const fp = require('crypto').createHash('sha256').update(second.publicKey).digest('hex').slice(0, 16);
    const st1 = php(priv, ['status']);
    line(st1.status === 0 && st1.stdout.includes(fp) && !st1.stdout.includes(second.publicKey) && /treasury/.test(st1.stdout), 'status lists keys by fingerprint, never the whole key', st1.stdout);
    line(php(priv, ['revoke', '--fingerprint=' + fp]).status === 0 && JSON.parse(fs.readFileSync(path.join(priv, 'chainlabs-operators.json'), 'utf8')).keys[1].revoked === true, 'revoke marks a key');
    line(/revoked/.test(php(priv, ['status']).stdout), 'and status says so');
    line(php(priv, ['remove-key', '--key=' + second.publicKey]).status === 0 && JSON.parse(fs.readFileSync(path.join(priv, 'chainlabs-operators.json'), 'utf8')).keys.length === 1, 'remove-key takes it off');
    line(php(priv, ['clear-token']).status === 0 && !('legacyTokenSha256' in JSON.parse(fs.readFileSync(path.join(priv, 'chainlabs-operators.json'), 'utf8'))), 'clear-token removes the token');
    line(php(priv, ['audit-verify']).status === 0, 'audit-verify passes on an empty trail');
    line(php(priv, ['bogus']).status === 2 && php(priv, ['status', '--wat=1']).status === 2, 'unknown commands and options are refused');
    fs.writeFileSync(path.join(priv, 'chainlabs-operators.json'), '{"domain":"a.example"}');
    line(php(priv, ['add-key', '--key=' + second.publicKey]).status === 2, 'a damaged roster is not rewritten');
    const hit = await S.call(a, 'lib/operator-cli', 'GET', '');
    line(hit.status === 404, 'the tool is not served over the web', hit.status);
  } finally {
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    S.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS OPERATOR CLI CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
