// Runs the shared transfer-policy decision table (test/vectors/
// transfer-policy.json) through both implementations and requires each to
// return exactly the expected result for every case:
//   issuer-server/lib-transfer-policy.js   (in process)
//   issuer-php/lib/transfer-policy.php     (php CLI)
// The table is the contract the two issuers share; a new rule is added here
// first, then implemented in both.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const policy = require('../issuer-server/lib-transfer-policy');

const vectorsFile = path.resolve(__dirname, 'vectors', 'transfer-policy.json');
const { cases } = JSON.parse(fs.readFileSync(vectorsFile, 'utf8'));

function runNode(input) {
  const kind = input.kind || 'policy';
  if (kind === 'gate') return policy.evaluateDeliveryGate(input);
  if (kind === 'mint') return policy.evaluateMintForDelivery(input);
  return policy.evaluateTransferPolicy(input);
}
function normalize(v) { return JSON.parse(JSON.stringify(v)); }
function same(a, b) { return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b)); }
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = sortKeys(v[k]); return o; }, {});
  return v;
}

let failures = 0;
const phpOut = JSON.parse(execFileSync('php', [path.resolve(__dirname, 'vectors', 'run-transfer-policy.php'), vectorsFile], { encoding: 'utf8' }));
cases.forEach((c, i) => {
  const node = normalize(runNode(c.input));
  const php = phpOut[i];
  const okNode = same(node, c.expect);
  const okPhp = same(php, c.expect);
  if (okNode && okPhp) { console.log('PASS: [' + c.group + '] ' + c.name); return; }
  failures++;
  console.log('FAIL: [' + c.group + '] ' + c.name);
  if (!okNode) console.log('   node  got ' + JSON.stringify(node) + '\n   expect  ' + JSON.stringify(c.expect));
  if (!okPhp) console.log('   php   got ' + JSON.stringify(php) + '\n   expect  ' + JSON.stringify(c.expect));
});
if (failures) { console.error('FAILURE: ' + failures + ' of ' + cases.length + ' vectors differ'); process.exit(1); }
console.log('\nALL TRANSFER POLICY VECTORS PASSED (' + cases.length + ' cases, node and php identical)');
