#!/usr/bin/env node
// Checks a deployed Call Service from the outside, through whatever sits in front of it.
//
//   node call-server/check-deployment.js https://calls.example.org
//
// It sends a handful of ordinary requests and one signed listen made with a throwaway key.
// It creates no tag, needs no membership, signs nothing with a real identity, and leaves
// nothing behind on the service beyond a listening slot that expires within a minute.
// Plain http is accepted only with --allow-http, for a private test network.
// Exit status 0 when nothing failed (warnings do not fail), 1 otherwise.
'use strict';

const P = require('./protocol');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const target = args.find((a) => !a.startsWith('--'));
const holdWait = (() => { const i = args.indexOf('--max-hold-seconds'); return i >= 0 ? Number(args[i + 1]) : 70; })();
const skipHold = flag('--skip-hold');

let fails = 0, warns = 0;
const out = (kind, name, detail) => {
  if (kind === 'FAIL') fails++;
  if (kind === 'WARN') warns++;
  console.log(kind + ' ' + name + (detail ? ' :: ' + detail : ''));
};
const ok = (name, detail) => out('PASS', name, detail);
const bad = (name, detail) => out('FAIL', name, detail);
const warn = (name, detail) => out('WARN', name, detail);

async function request(url, init, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
  const started = Date.now();
  try {
    const res = await fetch(url, Object.assign({ redirect: 'manual', signal: ctl.signal }, init));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, headers: res.headers, json, text, ms: Date.now() - started };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'no answer in time' : String(e.cause && e.cause.code || e.message), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function throwawayIdentity() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { priv: kp.privateKey, pub: P.b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))) };
}
async function signed(payload, ident) {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ident.priv, new TextEncoder().encode(P.canonicalize(payload))));
  return { signerRole: 'raw-ecdsa', publicKey: ident.pub, signature: P.b64urlEncode(sig) };
}

async function main() {
  if (!target) {
    console.log('usage: node call-server/check-deployment.js https://calls.example.org [--max-hold-seconds 70] [--skip-hold] [--allow-http]');
    return 2;
  }
  let u;
  try { u = new URL(target); } catch (e) { console.log('That is not a URL.'); return 2; }
  const origin = u.origin;
  if (target !== origin) { console.log('Give the bare origin, for example https://calls.example.org (no path, no trailing slash).'); return 2; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && flag('--allow-http'))) {
    console.log('The service address must be https. (Plain http is for a private test network only: --allow-http.)');
    return 2;
  }
  if (u.protocol === 'http:') warn('plain http', 'allowed by --allow-http; wallets refuse plain http outside a private test network');

  // ---- info ----
  const info = await request(origin + '/atlas/call/info');
  if (info.error) { bad('the service answers', info.error); return 1; }
  if (info.status !== 200 || !info.json || info.json.service !== 'atlas-call') {
    bad('GET /atlas/call/info is the Call Service', 'status ' + info.status + (info.status >= 500 ? ' (proxy cannot reach the service?)' : ''));
    return 1;
  }
  ok('GET /atlas/call/info answers');
  if (info.json.configured === true) ok('the service is configured');
  else { bad('the service is configured', 'it reports configured:false; read its console for the setting that is wrong'); return 1; }
  if (info.json.audience === origin) ok('the service names exactly this address as its origin', origin);
  else bad('the service names exactly this address as its origin', 'it says ' + info.json.audience + ' but you typed ' + origin + '; CALL_ORIGIN must match');
  console.log('INFO domain admitted: ' + info.json.domain + '; STUN: ' + ((info.json.ice && info.json.ice.stun || []).join(', ') || 'none') + '; TURN: ' + (info.json.ice && info.json.ice.turn ? 'yes' : 'no'));
  const skew = Math.abs(Date.parse(info.json.serverTime) - Date.now());
  if (skew > 25000) bad('clock agreement', 'this computer and the service differ by ' + Math.round(skew / 1000) + ' s; invitations allow 30 s');
  else if (skew > 5000) warn('clock agreement', 'differs by ' + Math.round(skew / 1000) + ' s');
  else ok('clock agreement');

  // ---- headers ----
  if (u.protocol === 'https:') {
    if (info.headers.get('strict-transport-security')) ok('Strict-Transport-Security is sent');
    else warn('Strict-Transport-Security is sent', 'add it at the proxy');
  }
  const aco = info.headers.get('access-control-allow-origin');
  if (aco) bad('no cross-origin access is offered on info', 'Access-Control-Allow-Origin: ' + aco); else ok('no cross-origin access is offered on info');
  if ((info.headers.get('cache-control') || '').includes('no-store')) ok('responses are not cacheable'); else bad('responses are not cacheable', 'Cache-Control lacks no-store; check proxy caching');
  if (info.headers.get('x-content-type-options') === 'nosniff') ok('X-Content-Type-Options: nosniff is passed through'); else warn('X-Content-Type-Options: nosniff is passed through');

  // ---- request rules ----
  const post = (route, init) => request(origin + route, Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, init));
  let r = await post('/atlas/call/invite', { headers: { 'Content-Type': 'text/plain' } });
  if (r.status === 415) ok('a request that is not application/json is refused');
  else bad('a request that is not application/json is refused', 'status ' + (r.status || r.error));
  r = await post('/atlas/call/invite', { headers: { 'Content-Type': 'application/json', Origin: 'https://not-allowed.invalid' } });
  if (r.status === 403 && r.json && r.json.code === 'origin-not-allowed') ok('a request from a web page origin is refused');
  else bad('a request from a web page origin is refused', 'status ' + (r.status || r.error));
  if (r.headers && r.headers.get('access-control-allow-origin')) bad('no cross-origin access is offered', 'Access-Control-Allow-Origin was sent for a stranger');
  r = await request(origin + '/atlas/call/invite', { method: 'OPTIONS', headers: { Origin: 'https://not-allowed.invalid', 'Access-Control-Request-Method': 'POST' } });
  if (r.headers && !r.headers.get('access-control-allow-origin')) ok('a cross-origin preflight is not approved');
  else bad('a cross-origin preflight is not approved', r.error || 'Access-Control-Allow-Origin was sent');
  r = await post('/atlas/call/invite');
  if (r.status === 400 && r.json && r.json.code === 'https-required') {
    bad('the proxy tells the service the request was https', 'the service answers https-required: set "X-Forwarded-Proto https" at the proxy (docs: call-server/deploy)');
  } else if (r.status === 400 && r.json && r.json.code === 'bad-request') ok('a malformed request is rejected as malformed (proxy headers accepted)');
  else bad('a malformed request is rejected as malformed', 'status ' + (r.status || r.error) + (r.status === 502 || r.status === 504 ? ' (the proxy lost the service)' : ''));
  r = await post('/atlas/call/invite', { body: 'x'.repeat(64 * 1024) });
  if (r.status === 413) ok('an oversized body is refused with 413');
  else bad('an oversized body is refused with 413', 'status ' + (r.status || r.error));
  r = await request(origin + '/atlas/call/listen', { method: 'GET' });
  if (r.status === 405) ok('GET on a call route is refused'); else bad('GET on a call route is refused', 'status ' + (r.status || r.error));
  if (u.protocol === 'https:') {
    r = await request('http://' + u.host + '/atlas/call/info', {}, 6000);
    if (r.error) ok('plain http on the same host is not served', r.error);
    else if (r.status >= 300 && r.status < 400) warn('plain http on the same host', 'redirects (' + r.status + '); fine for browsers, wallets refuse redirects and use https directly');
    else if (r.status === 200) bad('plain http on the same host is not served', 'the service also answers on http; close port 80 or redirect it');
    else ok('plain http on the same host is not served', 'status ' + r.status);
  }

  // ---- a long poll survives the proxy ----
  if (skipHold) { warn('a long poll survives the proxy', 'skipped'); }
  else {
    const holdMs = (info.json.limits && info.json.limits.listenHoldMs) || 25000;
    const ident = await throwawayIdentity();
    const session = await throwawayIdentity();
    const iso = (ms) => new Date(ms).toISOString();
    const delegationPayload = { type: 'atlas.call.listen-session', v: 1, audience: origin, issuedAt: iso(Date.now()), expiresAt: iso(Date.now() + 120000), sessionKey: session.pub };
    const delegation = { payload: delegationPayload, proof: await signed(delegationPayload, ident) };
    const listenPayload = { type: 'atlas.call.listen', v: 1, audience: origin, issuedAt: iso(Date.now()), nonce: P.randomId(16), ack: [] };
    console.log('INFO waiting up to ' + Math.round(holdMs / 1000) + ' s for the service to answer a listen with nothing to report');
    r = await post('/atlas/call/listen', { body: JSON.stringify({ payload: listenPayload, proof: await signed(listenPayload, session), session: delegation }) });
    if (r.error) bad('a held listen is answered', r.error + ' after ' + Math.round(r.ms / 1000) + ' s');
    else if (r.status === 401 && r.json && r.json.code === 'stale-request') bad('a held listen is answered', 'the service says this computer\'s clock is out of step');
    else if (r.status !== 200 || !r.json || !Array.isArray(r.json.events)) bad('a held listen is answered', 'status ' + r.status + ' after ' + Math.round(r.ms / 1000) + ' s' + (r.status === 504 || r.status === 502 ? ': the proxy gave up before the service answered; raise its read timeout above ' + Math.round(holdMs / 1000 + 5) + ' s' : ''));
    else if (r.ms < holdMs - 4000) warn('a held listen is answered', 'answered after ' + Math.round(r.ms / 1000) + ' s, earlier than the ' + Math.round(holdMs / 1000) + ' s hold (a limit may have applied)');
    else if (r.ms > holdMs + holdWait * 1000) bad('a held listen is answered', 'took ' + Math.round(r.ms / 1000) + ' s');
    else ok('a held listen is answered through the proxy', 'after ' + (r.ms / 1000).toFixed(1) + ' s');
  }

  console.log('\n' + (fails ? 'Failed: ' + fails + ' check(s)' : 'No failures') + (warns ? ', ' + warns + ' warning(s)' : '') + '. This does not test audio, STUN or TURN.');
  return fails ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
