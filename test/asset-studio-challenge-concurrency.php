<?php
// Run only on CLI. Launch two separate PHP workers against one challenge.
require_once __DIR__.'/../issuer-php/atlas/studio/inc/challenges.php';
if (PHP_SAPI !== 'cli') { fwrite(STDERR,"CLI only\n"); exit(2); }
if (!function_exists('proc_open')) { echo "SKIP: proc_open unavailable (concurrency unverified)\n"; exit(0); }
$base=sys_get_temp_dir().'/studio-race-'.bin2hex(random_bytes(8));
mkdir($base,0700);mkdir($base.'/tmp',0700);
try {
  $now=time();$digest=str_repeat('a',64);$recipient=str_repeat('K',64);
  for($round=0;$round<5;$round++) {
    $challenge=atlas_studio_new_challenge($base,$digest,$recipient,$now);
    $cmd=[PHP_BINARY,__DIR__.'/asset-studio-challenge-worker.php',$base,$challenge['nonce'],$digest,$recipient,(string)$now];
    $workers=[];
    for($i=0;$i<2;$i++) {
      $descriptors=[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
      $p=proc_open($cmd,$descriptors,$pipes);
      if(!is_resource($p)) throw new RuntimeException('worker-start-failed');
      fclose($pipes[0]);$workers[]=[$p,$pipes[1],$pipes[2]];
    }
    $successes=0;
    foreach($workers as [$p,$stdout,$stderr]) {
      $output=trim(stream_get_contents($stdout));
      $error=stream_get_contents($stderr);
      fclose($stdout);fclose($stderr);
      $exit=proc_close($p);
      if($exit!==0 || !in_array($output,['0','1'],true)) throw new RuntimeException('worker-failed: '.$error);
      if($output==='1') $successes++;
    }
    if($successes!==1) throw new RuntimeException('race allowed '.$successes.' consumers');
    if(atlas_studio_read_challenge($base,$challenge['nonce'],$now)!==null) throw new RuntimeException('consumed challenge remains issued');
  }
  echo "Asset Studio concurrent challenge tests passed (five two-worker races)\n";
} finally {
  foreach (glob($base.'/tmp/*') ?: [] as $f) unlink($f);
  rmdir($base.'/tmp');rmdir($base);
}
