// Pass/fail counting and results output shared by the spike tests (no browser dependency).
'use strict';
const path = require('path');
const fs = require('fs');

const RESULTS_DIR = path.resolve(__dirname, '..', 'results');
const counts = { pass: 0, fail: 0 };
const observations = {};

function check(name, ok, detail) {
  if (ok) { counts.pass++; console.log('PASS: ' + name); } else { counts.fail++; console.log('FAIL: ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
  return ok;
}
function observe(key, value) { observations[key] = value; console.log('OBSERVE: ' + key + ' = ' + JSON.stringify(value)); }

function finish(name, browser) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, name + '.json'), JSON.stringify({
    script: name, ranAt: new Date().toISOString(), browser: browser || null, passed: counts.pass, failed: counts.fail, observations
  }, null, 2));
  console.log('\n' + name + ': ' + counts.pass + ' passed, ' + counts.fail + ' failed');
  return counts.fail === 0 ? 0 : 1;
}
module.exports = { check, observe, finish, counts, observations };
