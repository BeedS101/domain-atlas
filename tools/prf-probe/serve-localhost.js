// Optional control test: serves only probe.html and probe.js at http://localhost:8251/ so the same probe can run
// from a plain web origin. Compare with the extension page to tell an extension-origin problem from a general
// Windows Hello problem. Stores nothing and binds to the loopback interface only.
//
// Run from this folder:  node serve-localhost.js     then open http://localhost:8251/ and stop it with Ctrl+C.
const http = require('http');
const fs = require('fs');
const path = require('path');
const types = { '.html': 'text/html', '.js': 'text/javascript' };
http.createServer((req, res) => {
  const name = req.url === '/' ? 'probe.html' : path.basename(req.url.split('?')[0]);
  const ext = path.extname(name);
  const file = path.join(__dirname, name);
  if (!['probe.html', 'probe.js'].includes(name) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[ext] });
  res.end(fs.readFileSync(file));
}).listen(8251, '127.0.0.1', () => console.log('Probe served at http://localhost:8251/ (Ctrl+C to stop)'));
