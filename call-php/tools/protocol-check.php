<?php
// Runs protocol checks for the Node-versus-PHP comparison test (test/manual-call-php-protocol.js).
// Reads a JSON array of cases on standard input and writes a JSON array of results.
// Not part of what is uploaded to a web host.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/../atlas/call/lib/protocol.php';

$cases = json_decode(stream_get_contents(STDIN), true);
$out = [];
foreach ($cases as $c) {
  $op = $c['op'];
  $raw = isset($c['raw']) ? json_decode($c['raw'], false) : null;
  switch ($op) {
    case 'canonicalize': $r = CallProto::canonicalize($raw); break;
    case 'hashOf': $r = CallProto::hashOf($raw); break;
    case 'transcriptHash': $r = CallProto::transcriptHash($raw->invite, $raw->accept); break;
    case 'tagHash': $r = CallProto::tagHash($c['str']); break;
    case 'validatePayload': $r = CallProto::validatePayload($raw); break;
    case 'validateEnvelope': $r = CallProto::validateEnvelope($raw); break;
    case 'verifySigned': $r = CallProto::verifySigned($raw); unset($r['payload']); break;
    case 'verifyEnvelope': $r = CallProto::verifyEnvelope($raw->payload, $raw->proof); break;
    case 'parseTime': $r = CallProto::parseTime($c['str']); break;
    case 'isTime': $r = CallProto::isTime($c['str']); break;
    case 'jsNumber': $r = CallProto::jsNumber($raw); break;
    case 'parseIceUrl': $r = CallProto::parseIceUrl($c['str']); break;
    case 'iceUrlProblem': $r = CallProto::iceUrlProblem($c['str'], isset($c['opts']) ? $c['opts'] : []); break;
    case 'privateHost': $r = CallProto::privateHost($c['str']); break;
    case 'isStr': $r = CallProto::isStr($raw, $c['min'], $c['max']); break;
    case 'derToRaw':
      try { $r = CallProto::b64urlEncode(CallProto::derToRaw(CallProto::b64urlDecode($c['str']))); } catch (Throwable $e) { $r = null; }
      break;
    case 'b64urlDecode':
      try { $r = CallProto::b64urlEncode(CallProto::b64urlDecode($c['str'])); } catch (Throwable $e) { $r = null; }
      break;
    default: $r = 'unknown-op';
  }
  $out[] = $r;
}
echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
