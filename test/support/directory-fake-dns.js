// Preload for a directory under test (node -r): answers host-name lookups from a table and stops every outgoing
// connection before it is made, so a test can see what the directory WOULD connect to without any traffic.
//
//   DIRECTORY_FAKE_DNS   JSON {"name.example": [["8.8.8.8"], ["127.0.0.1"]]}: for each name, the answer to its 1st lookup, its 2nd,
//                        ...; the last one repeats. A name that is not listed does not resolve.
//   DIRECTORY_FAKE_LOG   file that receives one JSON line per lookup ({type:'lookup', host, n, answer}) and per connection
//                        that would have been made ({type:'connect', host, port, addresses}).
//
// For test use only. Nothing in the directory itself reads these variables.
'use strict';
const dns = require('dns');
const net = require('net');
const fs = require('fs');

const table = JSON.parse(process.env.DIRECTORY_FAKE_DNS || '{}');
const logFile = process.env.DIRECTORY_FAKE_LOG;
const counts = {};
const log = (entry) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + '\n'); };
const familyOf = (a) => (a.includes(':') ? 6 : 4);

dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  options = options || {};
  const sequence = table[hostname];
  const n = counts[hostname] = (counts[hostname] || 0) + 1;
  if (!sequence) {
    log({ type: 'lookup', host: hostname, n, answer: null });
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND ' + hostname), { code: 'ENOTFOUND', hostname });
    return setImmediate(callback, err);
  }
  const answer = sequence[Math.min(n, sequence.length) - 1];
  log({ type: 'lookup', host: hostname, n, answer });
  const list = answer.map((address) => ({ address, family: familyOf(address) }));
  if (options.all) return setImmediate(callback, null, list);
  return setImmediate(callback, null, list[0].address, list[0].family);
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const options = args[0];
  if (!options || typeof options !== 'object' || Array.isArray(options)) return realConnect.apply(this, args);
  const stop = (addresses) => {
    log({ type: 'connect', host: options.host, port: options.port, addresses });
    return Object.assign(new Error('connect ECONNREFUSED (blocked by the test)'), { code: 'ECONNREFUSED' });
  };
  const innerLookup = options.lookup || dns.lookup;
  // Whatever the lookup hands on is what the socket would connect to. It is recorded and the connection is refused.
  const wrapped = (host, opts, cb) => innerLookup(host, opts, (err, result, family) => {
    if (err) return cb(err);
    const addresses = Array.isArray(result) ? result.map((r) => r.address) : [result];
    return cb(stop(addresses));
  });
  if (net.isIP(options.host)) { setImmediate(() => this.destroy(stop([options.host]))); return this; }
  return realConnect.apply(this, [{ ...options, lookup: wrapped }, ...args.slice(1)]);
};
