<?php
// Source-level regression protecting both supported issuer implementations.
// Real HTTP integration tests remain necessary before enabling Studio minting.
$php=file_get_contents(__DIR__.'/../issuer-php/atlas/asset/issue.php');
$node=file_get_contents(__DIR__.'/../issuer-server/server.js');
if (!is_string($php) || !is_string($node)) {fwrite(STDERR,"Issuer files unavailable\n");exit(1);}
$routes=[
  'PHP'=>[$php,"if (\$assetClass === 'atlas.demo.studio.collectible')","$"."credential = mint_asset_by_class("],
  'Node'=>[$node,"if (assetClass === 'atlas.demo.studio.collectible')","const catalogEntry = ASSET_CATALOG[assetClass];"],
];
foreach($routes as $name=>$parts) {
  [$source,$guard,$later]=$parts;
  $at=strpos($source,$guard);
  $after=$at===false?false:strpos($source,$later,$at);
  if ($at===false || $after===false || !str_contains(substr($source,$at,$after-$at),'studio-authorization-required')) {
    fwrite(STDERR,"FAIL: $name Studio class general issue bypass guard missing\n");
    exit(1);
  }
}
echo "Studio class guards present in PHP and Node issuer source (static check only)\n";
