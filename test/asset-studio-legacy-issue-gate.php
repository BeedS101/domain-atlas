<?php
// Static route gate regression, because including issue.php executes HTTP minting.
// This protects the dedicated class against future catalogue additions.
$source=file_get_contents(__DIR__.'/../issuer-php/atlas/asset/issue.php');
if (!is_string($source)) { fwrite(STDERR,"Cannot read issue route\n"); exit(1); }
$marker="if (\$assetClass === 'atlas.demo.studio.collectible')";
$gate=strpos($source,$marker);
$mint=strpos($source,'$credential = mint_asset_by_class(');
if ($gate===false || $mint===false || $gate>=$mint ||
    strpos(substr($source,$gate,$mint-$gate),'studio-authorization-required')===false) {
  fwrite(STDERR,"FAIL: legacy issue route must block Studio class before minting\n");
  exit(1);
}
echo "Studio legacy issuance gate present (static source check only)\n";
