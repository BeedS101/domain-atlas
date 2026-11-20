#!/usr/bin/env node
// Signs and sends operator requests to a chain labs domain, and prepares the operator roster. The private key stays in the identity file on
// this computer: it is read here, used to sign, and never sent.
//
//   node tools/chainlabs-operator.js keygen --out operator.json [--label TEXT]
//   node tools/chainlabs-operator.js roster-init --identity operator.json --domain a.example --out chainlabs-operators.json [--label TEXT] [--actions a,b] [--no-token]
//   node tools/chainlabs-operator.js roster-line --identity operator.json [--label TEXT] [--actions a,b]
//   node tools/chainlabs-operator.js verify   --identity operator.json --url https://a.example
//   node tools/chainlabs-operator.js activate --identity operator.json --url https://a.example --yes
//   node tools/chainlabs-operator.js audit    --identity operator.json --url https://a.example [--limit 50]
//   node tools/chainlabs-operator.js call <action> --identity operator.json --url https://a.example [--json '{"coinId":"..."}'] [--json-file FILE] [--allow-repeat]
//
// <action> is one of spend34/{open,grant,recover,compare,purchase-recover,purchase-cancel,restore,accept-rollback,reseal,resume,integrity,evidence,
// consent-list,consent-accept,consent-decline,sigformat-status,sigformat-activate},
// coin26/{create,preview} or operator/{check,activate,audit}. The three consent actions are for the operator of a partner domain, and take a
// signed request only: `call spend34/consent-list` shows the coins other domains propose, with every term; `call spend34/consent-accept --json
// '{"coinId":"...","digest":"..."}'` accepts exactly that coin and genesis digest; consent-decline takes the same and an optional "reason". sigformat-status and sigformat-activate (signed
// request only) show and switch on signature format 2 (docs/chain-labs-signature-format.md); activation needs `--json '{"confirm":true}'` and cannot be undone. --url names the domain; --host overrides the name that is signed, for a test server.
// A request whose answer is lost is sent again, the same signed request, until it expires: the domain answers it from its record and never carries
// the action out twice. When no answer ever arrives the outcome is reported as unknown; read the ledger (integrity, evidence) before signing it again.
'use strict';
const fs = require('fs');
const OP = require('./lib/chainlabs-operator');

function parse(argv) {
  const out = { _: [], flags: {} };
  const bool = new Set(['yes', 'allow-repeat', 'no-token', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    if (bool.has(name)) { out.flags[name] = true; continue; }
    if (i + 1 >= argv.length) throw new Error('--' + name + ' needs a value');
    out.flags[name] = argv[++i];
  }
  return out;
}

function fail(text, code = 2) { process.stderr.write(text + '\n'); process.exit(code); }

function identityOf(flags) {
  if (!flags.identity) fail('--identity FILE is needed');
  try { return OP.loadIdentity(flags.identity); } catch (e) { fail('the identity file could not be read: ' + e.message); }
}

function targetOf(flags) {
  if (!flags.url) fail('--url https://domain is needed');
  let url;
  try { url = new URL(flags.url); } catch (e) { fail('--url is not a URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) fail('--url must be https (http only for this computer)');
  const dir = url.pathname.replace(/^\/+|\/+$/g, '');
  return { base: url.protocol + '//' + url.host, host: flags.host || url.hostname, dir: dir ? dir : undefined };
}

function actionList(text) {
  if (text === undefined) return undefined;
  const list = text.split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of list) if (!OP.ACTIONS.has(a)) fail('unknown action ' + a);
  return list;
}

function rosterEntry(identity, flags) {
  const entry = { publicKey: identity.publicKey, label: flags.label || '' };
  const actions = actionList(flags.actions);
  if (actions) entry.actions = actions;
  return entry;
}

async function send(flags, action, request) {
  const identity = identityOf(flags);
  const target = targetOf(flags);
  const res = await OP.callOperator(target, identity, action, request, { repeat: !!flags['allow-repeat'] });
  if (res.outcomeUnknown) {
    process.stderr.write('No answer arrived before the request expired, so it is not known whether the action was carried out.\n'
      + 'Check the ledger first (spend34/integrity, spend34/evidence) and sign it again only if it did not happen.\n');
    process.exit(3);
  }
  if (res.headers && res.headers['x-chainlabs-operator-replay'] === '1') process.stderr.write('(answered from the record of an earlier request; nothing was carried out again)\n');
  process.stdout.write((res.json ? JSON.stringify(res.json, null, 2) : res.raw) + '\n');
  process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
}

async function main() {
  const { _: words, flags } = parse(process.argv.slice(2));
  const command = words[0];
  if (!command || flags.help) { process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') + '\n'); return; }

  if (command === 'keygen') {
    if (!flags.out) fail('--out FILE is needed');
    if (fs.existsSync(flags.out)) fail('that file exists already; it is not overwritten');
    const identity = OP.newIdentity();
    OP.saveIdentity(flags.out, identity);
    process.stdout.write('identity written (keep it private; it is never sent anywhere)\npublic key: ' + identity.publicKey + '\n'
      + 'roster entry: ' + JSON.stringify(rosterEntry(identity, flags)) + '\n');
    return;
  }
  if (command === 'roster-line') { process.stdout.write(JSON.stringify(rosterEntry(identityOf(flags), flags)) + '\n'); return; }
  if (command === 'roster-init') {
    if (!flags.domain || !flags.out) fail('--domain and --out are needed');
    if (fs.existsSync(flags.out)) fail('that file exists already; it is not overwritten');
    const roster = { domain: flags.domain.toLowerCase(), keys: [rosterEntry(identityOf(flags), flags)] };
    let token = null;
    if (!flags['no-token']) { token = require('crypto').randomBytes(32).toString('hex'); roster.legacyTokenSha256 = OP.sha256(token); }
    fs.writeFileSync(flags.out, JSON.stringify(roster, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write('roster written. Upload it to the private folder next to the web root as chainlabs-operators.json.\n');
    if (token) process.stdout.write('operator token for the period of compatibility (shown once; the roster holds only its SHA-256):\n' + token + '\n');
    return;
  }
  if (command === 'verify') return send(flags, 'operator/check', {});
  if (command === 'activate') {
    if (!flags.yes) fail('activating makes every action that changes something need a signed request, with no way back in code. Run verify first, then add --yes.');
    return send(flags, 'operator/activate', { confirm: 'activate-signed-operator' });
  }
  if (command === 'audit') return send(flags, 'operator/audit', { limit: Math.max(1, Math.min(200, parseInt(flags.limit || '50', 10) || 50)) });
  if (command === 'call') {
    const action = words[1];
    if (!action || !OP.ACTIONS.has(action)) fail('<action> is one of: ' + [...OP.ACTIONS].join(', '));
    let request = {};
    try {
      if (flags['json-file']) request = JSON.parse(fs.readFileSync(flags['json-file'], 'utf8'));
      else if (flags.json) request = JSON.parse(flags.json);
    } catch (e) { fail('the arguments are not valid JSON'); }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) fail('the arguments must be a JSON object');
    return send(flags, action, request);
  }
  fail('unknown command; --help lists them');
}

main().catch((e) => fail('failed: ' + e.message));
