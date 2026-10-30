<?php
// Test real competing PHP processes, not two sequential in-process calls.
require_once __DIR__.'/../issuer-php/atlas/studio/inc/mint-attempts.php';
if (PHP_SAPI!=='cli') exit(2);
if (!function_exists('proc_open')) { fwrite(STDERR,"SKIP: proc_open unavailable; concurrency NOT verified\n"); exit(77); }
$root=sys_get_temp_dir().'/studio-attempt-race-'.bin2hex(random_bytes(8));
mkdir($root,0700);mkdir($root.'/mint-receipts',0700);
try {
  for($round=0;$round<5;$round++) {
    $nonce=bin2hex(random_bytes(32));$digest=str_repeat('a',64);$owner=str_repeat('K',64);
    $cmd=[PHP_BINARY,__DIR__.'/asset-studio-attempt-worker.php',$root,$nonce,$digest,$owner];
    $jobs=[];
    for($i=0;$i<2;$i++) {
      $p=proc_open($cmd,[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);
      if(!is_resource($p)) throw new RuntimeException('worker start failed');
      fclose($pipes[0]);$jobs[]=[$p,$pipes[1],$pipes[2]];
    }
    $wins=0;
    foreach($jobs as [$p,$out,$err]) {
      $answer=trim(stream_get_contents($out));$error=stream_get_contents($err);
      fclose($out);fclose($err);$status=proc_close($p);
      if($status!==0 || !in_array($answer,['0','1'],true)) throw new RuntimeException('worker failed: '.$error);
      if($answer==='1') $wins++;
    }
    if($wins!==1) throw new RuntimeException('expected one successful attempt, got '.$wins);
    $record=atlas_studio_read_attempt($root,$nonce);
    if(!is_array($record) || $record['state']!=='pending-reconciliation') throw new RuntimeException('claim record missing');
    if(atlas_studio_claim_attempt($root,$nonce,$digest,$owner)['ok']) throw new RuntimeException('replay accepted');
  }
  echo "Asset Studio mint-attempt concurrency tests passed (five two-worker races)\n";
} finally {
  foreach(glob($root.'/mint-receipts/*')?:[] as $file) unlink($file);
  rmdir($root.'/mint-receipts');rmdir($root);
}
