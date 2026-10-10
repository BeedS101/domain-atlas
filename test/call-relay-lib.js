// A hostile relay for the call tests: an HTTP proxy that sits between the calling windows and a
// real Call Service and can rewrite, duplicate or fabricate what the service answers on /listen
// and /poll. It stands for a service that has been taken over, or a network attacker where plain
// http is in use. Requests pass through unchanged, so the wallets' own signatures stay valid.
//
// An event the relay adds to a poll answer takes the next event number, so the window's own
// numbering moves past it; tests only add events that are expected to end the call, or use the
// same number twice to show that a duplicate is ignored.
'use strict';
const http = require('http');

// hooks.listen(json, ctx) and hooks.poll(json, ctx) may edit and return the answer.
// ctx = { req, relay, nextN() } where req is the parsed request body.
async function startRelay(targetPort, listenPort, hooks) {
  const relay = { hooks: hooks || {}, seen: { poll: [], listen: [] }, requests: [] };

  const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });

  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const route = req.url.split('?')[0];
    let reqJson = null;
    try { reqJson = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch (e) { /* not json */ }
    relay.requests.push({ route, at: Date.now() });
    const upstream = http.request({ host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: Object.assign({}, req.headers, { 'content-length': raw.length, host: '127.0.0.1:' + targetPort }) }, (ur) => {
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', async () => {
        let body = Buffer.concat(chunks);
        const headers = Object.assign({}, ur.headers);
        let json = null;
        try { json = JSON.parse(body.toString('utf8')); } catch (e) { /* not json */ }
        if (json && ur.statusCode === 200 && Array.isArray(json.events) && reqJson) {
          const ctx = {
            req: reqJson, relay,
            nextN: () => Math.max(reqJson.payload.after || 0, ...json.events.map((e) => e.n || 0)) + 1
          };
          if (route === '/atlas/call/poll') {
            for (const e of json.events) relay.seen.poll.push({ callId: reqJson.payload.callId, poller: reqJson.proof.publicKey, event: JSON.parse(JSON.stringify(e)) });
            if (relay.hooks.poll) json = (await relay.hooks.poll(json, ctx)) || json;
          } else if (route === '/atlas/call/listen') {
            for (const e of json.events) relay.seen.listen.push(JSON.parse(JSON.stringify(e)));
            if (relay.hooks.listen) json = (await relay.hooks.listen(json, ctx)) || json;
          }
          body = Buffer.from(JSON.stringify(json));
        }
        headers['content-length'] = body.length;
        delete headers['transfer-encoding'];
        res.writeHead(ur.statusCode, headers);
        res.end(body);
      });
    });
    upstream.on('error', () => { try { res.writeHead(502); res.end(); } catch (e) { /* gone */ } });
    upstream.end(raw);
  });
  await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve));
  relay.close = () => new Promise((resolve) => { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); });
  return relay;
}

module.exports = { startRelay };
