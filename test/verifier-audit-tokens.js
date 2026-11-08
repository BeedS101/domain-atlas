// The package audit reads PHP through token_get_all(), whose output differs between PHP versions: PHP 8 returns a
// qualified name such as \stdClass as one token, PHP 7.4 as T_NS_SEPARATOR and T_STRING pieces, and 7.4 has no tokens for
// match, enum, readonly, attributes or ?->. test/verifier-php/audit-tokens.php normalises both, and --legacy-tokens turns
// a PHP 8 token stream into the 7.4 one, so this test can check the two give the same answer on any machine.
//
//   node test/verifier-audit-tokens.js
//
// The real proof for 7.4 is the CI job that runs the package suite under PHP 7.4; this keeps the normalisation honest
// where only PHP 8 is available, and checks that the audit still catches what it is there to catch.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'verifier-php', 'audit-tokens.php');
const PACKAGE = path.join(__dirname, '..', 'verifier-php');
let failures = 0;
let total = 0;
function line(ok, text, detail) {
  total++;
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}
const audit = (file, legacy) => JSON.parse(execFileSync('php', [SCRIPT, file].concat(legacy ? ['--legacy-tokens'] : []), { encoding: 'utf8' }));
const both = (file) => ({ native: audit(file, false), legacy: audit(file, true) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-audit-tokens-'));
const snippet = (name, code) => { const file = path.join(work, name + '.php'); fs.writeFileSync(file, '<?php\n' + code + '\n'); return file; };

try {
  console.log('\n== the package files read the same under PHP 8 and PHP 7.4 tokenization');
  for (const rel of ['verify.php', 'lib/atlas-verify.php', 'lib/atlas-verify-crypto.php', 'lib/atlas-verify-fetch.php', 'config.example.php']) {
    const { native, legacy } = both(path.join(PACKAGE, rel));
    line(same(native, legacy), rel + ': identical audit result in both modes', { native: native.calls, legacy: legacy.calls });
  }
  const { legacy: verifyLegacy } = both(path.join(PACKAGE, 'lib', 'atlas-verify.php'));
  line(!verifyLegacy.calls.includes('stdClass'), 'a class name after "new \\" is not reported as a function call');
  line(verifyLegacy.classes.every((c) => c !== '\\' && /[A-Za-z]/.test(c)), 'a lone backslash is never reported as a class', verifyLegacy.classes);
  line(verifyLegacy.classes.includes('\\stdClass'), '\\stdClass is reported as one class name', verifyLegacy.classes);

  console.log('\n== names, calls and classes');
  const names = both(snippet('names', `namespace A\\B;
$x = new \\stdClass();
$y = $o instanceof \\stdClass;
$z = \\strlen('a');
\\openssl_sign($a, $b, $c);
Foo\\bar(1);
namespace\\baz();
echo \\Vendor\\Thing::run();
$e = new \\Evil\\Thing();
$f = new Plain();
function local_helper($p) { return $p; }
local_helper(1);
$o->method(2);
Klass::staticCall(3);`));
  line(same(names.native, names.legacy), 'a file with every kind of qualified name gives the same result in both modes');
  line(same(names.legacy.calls, ['Foo\\bar', 'local_helper', 'namespace\\baz', 'openssl_sign', 'strlen']), 'calls: fully qualified and qualified functions are found, methods and class names are not', names.legacy.calls);
  line(same(names.legacy.classes.slice().sort(), ['Klass', 'Plain', '\\Evil\\Thing', '\\Vendor\\Thing', '\\stdClass'].sort()), 'classes: each class used with new or :: appears once, qualified', names.legacy.classes);
  line(names.legacy.defined.join() === 'local_helper', 'defined: only the function the file declares', names.legacy.defined);
  line(!names.legacy.calls.includes('A\\B') && !names.legacy.classes.includes('A\\B'), 'a namespace declaration is neither a call nor a class');
  const forbidden = both(snippet('forbidden', 'echo \\openssl_sign($a, $b, $c); echo \\file_put_contents("x", "y"); $o = new \\Evil\\Thing(); eval("1");'));
  line(forbidden.native.calls.includes('openssl_sign') && forbidden.legacy.calls.includes('openssl_sign') && forbidden.native.calls.includes('file_put_contents'), 'a fully qualified forbidden call is found in both modes (PHP 8 used to hide it behind a single name token)', forbidden.native.calls);
  line(forbidden.native.dynamic.includes('eval') && forbidden.legacy.dynamic.includes('eval'), 'eval is found in both modes');

  console.log('\n== PHP 8 only syntax is found whichever PHP runs the audit');
  const eightOnly = {
    'nullsafe operator': '$a = $b?->c;',
    'match expression': '$a = match ($x) { 1 => 2, default => 3 };',
    'attribute': '#[Attr]\nfunction f() {}',
    'enum declaration': 'enum Suit { case Hearts; }',
    'readonly property': 'class C { public readonly int $x; }',
    'union type': 'function f(int|string $v) {}',
    'catch without a variable': 'try { f(); } catch (Exception) {}',
    'trailing comma in a parameter list': 'function f($a, $b,) {}',
    'throw as an expression': '$a = $b ?? throw new Exception();',
    'call to str_contains': '$a = str_contains("a", "b");'
  };
  for (const [label, code] of Object.entries(eightOnly)) {
    const r = both(snippet('php8-' + label.replace(/\W+/g, '-'), code));
    line(r.native.php8.length > 0 && r.legacy.php8.length > 0, label + ' is flagged in both modes', { native: r.native.php8, legacy: r.legacy.php8 });
  }
  const clean = both(snippet('clean74', `namespace A\\B;
function f(?int $a, array $b = []): ?string { try { return null; } catch (\\Exception $e) { return $e->getMessage(); } }
$m = 'match'; $o->match(1); Foo::match(2); $x = $o->enum; $s = fn($v) => $v + 1; $n = $a ?? 'd';
echo "tail";`));
  line(clean.native.php8.length === 0 && clean.legacy.php8.length === 0, 'ordinary PHP 7.4 code, including ->match() and ::match() calls, is not flagged', { native: clean.native.php8, legacy: clean.legacy.php8 });

  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' AUDIT TOKEN CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
