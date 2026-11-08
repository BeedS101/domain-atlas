<?php
// Lists what a PHP file does, from its tokens: functions it defines and calls, constants and classes it uses, files it
// includes, string literals, and any construct that executes dynamic code. Prints one JSON object.
//   php test/verifier-php/audit-tokens.php <file.php>
$source = file_get_contents($argv[1]);
$tokens = token_get_all($source);
$n = count($tokens);
$defined = []; $calls = []; $classes = []; $includes = []; $strings = []; $dynamic = []; $constants = []; $uses = [];
$significant = [];
foreach ($tokens as $t) {
  if (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
  $significant[] = $t;
}
$m = count($significant);
$text = function ($t) { return is_array($t) ? $t[1] : $t; };
$id = function ($t) { return is_array($t) ? $t[0] : null; };
for ($i = 0; $i < $m; $i++) {
  $t = $significant[$i];
  $prev = $i > 0 ? $significant[$i - 1] : null;
  $next = $i + 1 < $m ? $significant[$i + 1] : null;
  $tid = $id($t);
  if ($tid === T_FUNCTION && $next !== null && $id($next) === T_STRING) $defined[] = $text($next);
  if ($tid === T_STRING && $next !== null && $text($next) === '(') {
    $pid = $prev === null ? null : $id($prev);
    if (!in_array($pid, [T_FUNCTION, T_OBJECT_OPERATOR, T_DOUBLE_COLON, T_NEW], true)) $calls[] = $text($t);
  }
  if ($tid === T_STRING && $next !== null && $id($next) === T_DOUBLE_COLON) $classes[] = $text($t);
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
  foreach ($tokens as $t) if (is_array($t) && $t[0] === constant($name)) $php8[] = $name;
}
$code = '';
foreach ($tokens as $t) {
  if (is_array($t) && in_array($t[0], [T_COMMENT, T_DOC_COMMENT], true)) continue;
  $code .= is_array($t) && in_array($t[0], [T_CONSTANT_ENCAPSED_STRING, T_ENCAPSED_AND_WHITESPACE], true) ? "''" : (is_array($t) ? $t[1] : $t);
}
foreach ([
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
