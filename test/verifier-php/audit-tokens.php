<?php
// Lists what a PHP file does, from its tokens: functions it defines and calls, constants and classes it uses, files it
// includes, string literals, and any construct that executes dynamic code. Prints one JSON object.
//   php test/verifier-php/audit-tokens.php <file.php> [--legacy-tokens]
//
// The result must not depend on the PHP version that runs it. PHP 8 reads a qualified name (\stdClass, A\b, namespace\f)
// as one token; PHP 7.4 reads the same text as T_STRING and T_NS_SEPARATOR pieces, and has no T_MATCH, T_ENUM,
// T_READONLY, T_ATTRIBUTE or T_NULLSAFE_OBJECT_OPERATOR (a `#[` attribute is a comment there). Qualified names are
// therefore merged into one NAME token before any rule runs, and PHP 8 syntax is also looked for in the source text.
// --legacy-tokens rewrites the PHP 8 token stream into what 7.4 produces, so this script can be tested for equal output
// on a machine that only has PHP 8 (test/verifier-audit-tokens.js).
$source = file_get_contents($argv[1]);
$tokens = token_get_all($source);
if (in_array('--legacy-tokens', array_slice($argv, 2), true)) {
  $legacy = [];
  $php8Only = ['T_MATCH' => 'match', 'T_ENUM' => 'enum', 'T_READONLY' => 'readonly'];
  foreach ($tokens as $t) {
    if (!is_array($t)) { $legacy[] = $t; continue; }
    $names = [];
    foreach (['T_NAME_QUALIFIED', 'T_NAME_FULLY_QUALIFIED', 'T_NAME_RELATIVE'] as $c) if (defined($c)) $names[] = constant($c);
    if (in_array($t[0], $names, true)) {
      $parts = explode('\\', $t[1]);
      foreach ($parts as $k => $part) {
        if ($part === '') { $legacy[] = [T_NS_SEPARATOR, '\\', $t[2]]; continue; } // the leading backslash of \Name
        if ($k > 0 && $parts[$k - 1] !== '') $legacy[] = [T_NS_SEPARATOR, '\\', $t[2]];
        $legacy[] = [$part === 'namespace' && $k === 0 ? T_NAMESPACE : T_STRING, $part, $t[2]];
      }
    } elseif (defined('T_NULLSAFE_OBJECT_OPERATOR') && $t[0] === T_NULLSAFE_OBJECT_OPERATOR) {
      $legacy[] = '?'; $legacy[] = [T_OBJECT_OPERATOR, '->', $t[2]];
    } elseif (defined('T_ATTRIBUTE') && $t[0] === T_ATTRIBUTE) {
      $legacy[] = [T_COMMENT, '#[', $t[2]];
    } else {
      $replaced = false;
      foreach ($php8Only as $c => $word) if (defined($c) && $t[0] === constant($c)) { $legacy[] = [T_STRING, $t[1], $t[2]]; $replaced = true; break; }
      if (!$replaced) $legacy[] = $t;
    }
  }
  $tokens = $legacy;
}
$n = count($tokens);
$defined = []; $calls = []; $classes = []; $includes = []; $strings = []; $dynamic = []; $constants = []; $uses = [];
$significant = [];
foreach ($tokens as $t) {
  if (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
  $significant[] = $t;
}
// One NAME token per qualified name, whichever way this PHP version tokenizes it.
$nameTokens = [];
foreach (['T_NAME_QUALIFIED', 'T_NAME_FULLY_QUALIFIED', 'T_NAME_RELATIVE'] as $c) if (defined($c)) $nameTokens[] = constant($c);
$merged = [];
for ($k = 0, $c = count($significant); $k < $c;) {
  $t = $significant[$k];
  $tid = is_array($t) ? $t[0] : null;
  if (in_array($tid, $nameTokens, true)) { $merged[] = ['NAME', $t[1], $t[2]]; $k++; continue; }
  $next = $k + 1 < $c ? $significant[$k + 1] : null;
  $nextIsSeparator = is_array($next) && $next[0] === T_NS_SEPARATOR;
  if ($tid === T_NS_SEPARATOR || (($tid === T_STRING || $tid === T_NAMESPACE) && $nextIsSeparator)) {
    $name = ''; $line = $t[2]; $wantSegment = true;
    while ($k < $c && is_array($significant[$k])) {
      $u = $significant[$k];
      if ($u[0] === T_NS_SEPARATOR) { $name .= '\\'; $wantSegment = true; $k++; continue; }
      if ($wantSegment && ($u[0] === T_STRING || ($name === '' && $u[0] === T_NAMESPACE))) {
        $name .= $u[1]; $wantSegment = false; $k++;
        $after = $k < $c ? $significant[$k] : null;
        if (!(is_array($after) && $after[0] === T_NS_SEPARATOR)) break;
        continue;
      }
      break;
    }
    $merged[] = ['NAME', $name, $line];
    continue;
  }
  $merged[] = $t;
  $k++;
}
$significant = $merged;
$m = count($significant);
$text = function ($t) { return is_array($t) ? $t[1] : $t; };
$id = function ($t) { return is_array($t) ? $t[0] : null; };
for ($i = 0; $i < $m; $i++) {
  $t = $significant[$i];
  $prev = $i > 0 ? $significant[$i - 1] : null;
  $next = $i + 1 < $m ? $significant[$i + 1] : null;
  $tid = $id($t);
  if ($tid === T_FUNCTION && $next !== null && $id($next) === T_STRING) $defined[] = $text($next);
  if (($tid === T_STRING || $tid === 'NAME') && $next !== null && $text($next) === '(') {
    $pid = $prev === null ? null : $id($prev);
    if (!in_array($pid, [T_FUNCTION, T_OBJECT_OPERATOR, T_DOUBLE_COLON, T_NEW], true)) $calls[] = ltrim($text($t), '\\');
  }
  if (($tid === T_STRING || $tid === 'NAME') && $next !== null && $id($next) === T_DOUBLE_COLON) $classes[] = $text($t);
  if ($tid === T_NEW && $next !== null) $classes[] = $text($next);
  if (in_array($tid, [T_REQUIRE, T_REQUIRE_ONCE, T_INCLUDE, T_INCLUDE_ONCE], true)) {
    $expr = '';
    for ($j = $i + 1; $j < $m && $text($significant[$j]) !== ';'; $j++) $expr .= $text($significant[$j]);
    $includes[] = $expr;
  }
  if ($tid === T_CONSTANT_ENCAPSED_STRING || $tid === T_ENCAPSED_AND_WHITESPACE) $strings[] = $text($t);
  if (in_array($tid, [T_EVAL, T_EXIT], true) && $tid === T_EVAL) $dynamic[] = 'eval';
  if ($text($t) === '`') $dynamic[] = 'backtick';
  if ($tid === T_DOLLAR_OPEN_CURLY_BRACES) $dynamic[] = 'complex-interpolation';
  if ($text($t) === '$' && $next !== null && ($text($next) === '$' || $text($next) === '{')) $dynamic[] = 'variable-variable';
  if ($tid === T_VARIABLE && $next !== null && $text($next) === '(' && !in_array($id($prev), [T_FUNCTION, T_OBJECT_OPERATOR], true)) $dynamic[] = 'variable-call:' . $text($t);
  if ($tid === T_USE && $next !== null && in_array($id($next), [T_FUNCTION, T_CONST], true)) {
    $uses[] = $text($significant[$i + 2]);
  }
}
// Constructs that need PHP 8 or later. The package targets PHP 7.4, which cannot be run here, so this is a token-level guard.
$php8 = [];
foreach (['T_MATCH', 'T_NULLSAFE_OBJECT_OPERATOR', 'T_ATTRIBUTE', 'T_ENUM', 'T_READONLY'] as $name) {
  if (!defined($name)) continue;
  foreach ($significant as $i => $t) {
    // `$o->match()` and `Foo::match()` are method calls, not the keyword (PHP 8 still tokenizes the second as T_MATCH)
    $afterMember = $i > 0 && in_array($id($significant[$i - 1]), [T_DOUBLE_COLON, T_OBJECT_OPERATOR], true);
    if (is_array($t) && $t[0] === constant($name) && !$afterMember) $php8[] = $name;
  }
}
$code = '';
foreach ($tokens as $t) {
  if (is_array($t) && in_array($t[0], [T_COMMENT, T_DOC_COMMENT], true)) continue;
  $code .= is_array($t) && in_array($t[0], [T_CONSTANT_ENCAPSED_STRING, T_ENCAPSED_AND_WHITESPACE], true) ? "''" : (is_array($t) ? $t[1] : $t);
}
foreach ($tokens as $t) {
  if (is_array($t) && in_array($t[0], [T_COMMENT, T_DOC_COMMENT], true) && strpos($t[1], '#[') === 0) $php8[] = 'attribute';
}
foreach ([
  'nullsafe operator' => '/\?->/',
  'match expression' => '/(?<![>:$\w\\\\])match\s*\(/',
  'enum declaration' => '/(?<![>:$\w\\\\])enum\s+\w+\s*[:{]/',
  'readonly property' => '/\breadonly\s+(\??[\w\\\\]+\s+)?\$|\b(public|protected|private)\s+readonly\b/',
  'catch without a variable' => '/catch\s*\(\s*[\w\\\\|]+\s*\)/',
  'union type' => '/function[^;{]*\([^)]*[\w\\\\]\|[\w\\\\][^)]*\$|\)\s*:\s*\??[\w\\\\]+\|/',
  'mixed type' => '/\bmixed\s+\$|\)\s*:\s*mixed\b/',
  'constructor promotion' => '/__construct\s*\([^)]*\b(public|protected|private)\b/',
  'trailing comma in a parameter list' => '/function[^;{]*,\s*\)\s*[:{]/',
  'static return type' => '/\)\s*:\s*static\b/',
  'throw as an expression' => '/(=|\?\?|\?|:|=>)\s*throw\b/',
] as $label => $re) {
  if (preg_match($re, $code)) $php8[] = $label;
}
foreach (array_unique($calls) as $f) {
  if (in_array($f, ['str_contains', 'str_starts_with', 'str_ends_with', 'get_debug_type', 'get_resource_id', 'fdiv', 'array_is_list', 'enum_exists', 'iterator_to_array_', 'mb_str_split_', 'preg_last_error_msg', 'http_get_last_response_headers'], true) && !in_array($f, $defined, true)) $php8[] = 'call to ' . $f;
}
$functions = array_values(array_unique($calls));
sort($functions);
$info = [];
foreach ($functions as $f) {
  if (in_array($f, $defined, true)) continue;
  if (function_exists($f)) $info[$f] = (new ReflectionFunction($f))->getExtensionName();
}
echo json_encode([
  'defined' => $defined,
  'calls' => $functions,
  'builtin' => $info,
  'classes' => array_values(array_unique($classes)),
  'includes' => $includes,
  'strings' => $strings,
  'dynamic' => array_values(array_unique($dynamic)),
  'php8' => array_values(array_unique($php8)),
  'uses' => $uses,
], JSON_UNESCAPED_SLASHES), "\n";
