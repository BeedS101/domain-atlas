// A transparent HTTP proxy in front of a throw-away issuer whose answer to chosen endpoints a test controls: an endpoint
// can be refused with a status and body, cut off without an answer, or passed through. Everything else, including the Host
// header, reaches the issuer unchanged, so the issuer keeps the identity of the proxy's address.
//
//   const proxy = await startEndpointProxy(proxyPort, issuerPort);
//   proxy.rules['/atlas/trade/relay-settle'] = { status: 400, body: { error: 'refused' } };   // refuse
//   proxy.rules['/atlas/trade/relay-settle'] = 'drop';                                          // no answer at all
//   delete proxy.rules['/atlas/trade/relay-settle'];                                            // pass through
//
// proxy.hits lists the paths that were answered by a rule, in order.
'use strict';
const http = require('http');

async function startEndpointProxy(port, targetPort) {
  const proxy = { rules: {}, hits: [], port };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const pathname = req.url.split('?')[0];
      const rule = proxy.rules[pathname];
      if (rule === 'drop') { proxy.hits.push(pathname); req.socket.destroy(); return; }
      if (rule) {
        proxy.hits.push(pathname);
        res.writeHead(rule.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rule.body || {}));
        return;
      }
      const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end('{"error":"proxy: issuer unreachable"}'); });
      upstream.end(body);
    });
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  proxy.stop = () => { server.close(); server.closeAllConnections && server.closeAllConnections(); };
  return proxy;
}

module.exports = { startEndpointProxy };
