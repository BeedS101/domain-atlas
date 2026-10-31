<?php
// Issuance plan and asset body: the design decides only its own properties and one of three approved models.
require_once __DIR__ . '/studio-test-lib.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/issuance-plan.php';
$design = STUDIO_TEST_DESIGN;
$owner = studio_raw_key();

$plan = atlas_studio_issuance_plan($design, $owner);
studio_check($plan['ok'], 'accept a validated design');
studio_check($plan['requiredClass'] === ATLAS_STUDIO_CLASS, 'fixed class');
studio_check($plan['requiredTradeScope'] === 'bound' && $plan['quantity'] === 1 && $plan['nonFungible'] === true, 'fixed bound single collectible');
studio_check($plan['recipient'] === $owner, 'recipient carried');
studio_check($plan['properties']['atlas.studio.name'] === 'First Light', 'chosen name carried');
studio_check($plan['properties']['atlas.studio.designDigest'] === $plan['designDigest'], 'digest recorded in the asset properties');
foreach (['trophy', 'badge', 'key'] as $template) {
  $d = $design; $d['template'] = $template;
  $p = atlas_studio_issuance_plan($d, $owner);
  studio_check($p['ok'] && $p['model']['modelPath'] === "/assets/studio/$template.glb" && $p['model']['thumbnailPath'] === "/assets/studio/$template.png", "approved model for $template");
}
studio_check(atlas_studio_model_for_template('untrusted') === null, 'unknown template has no model');
studio_check(atlas_studio_model_for_template('../../etc/passwd') === null, 'path-like template has no model');

// The design cannot smuggle class, supply, scope, model or issuer choices.
foreach (['assetClass' => 'atlas.element.gold', 'quantity' => 10000, 'tradeScope' => 'global', 'model' => 'https://a.test/x.glb', 'issuer' => 'a.test', 'capabilities' => ['admin']] as $key => $v) {
  $attempt = $design; $attempt[$key] = $v;
  studio_check(!atlas_studio_issuance_plan($attempt, $owner)['ok'], "reject extra field $key");
}
foreach (['', 'short', str_repeat('K', 87), $owner . 'A', 5, null] as $bad) {
  studio_check(!atlas_studio_issuance_plan($design, $bad)['ok'], 'reject recipient ' . json_encode($bad));
}

// Asset body: catalog entry + design properties + issuer-controlled https model references.
$base = ['class' => ATLAS_STUDIO_CLASS, 'name' => 'Studio', 'fungible' => false, 'tradeScope' => 'bound', 'presentation' => 'collectible', 'properties' => ['atlas.demo.noValue' => 'true']];
$asset = atlas_studio_build_asset($base, $plan, 'localhost:9');
studio_check($asset['model'] === 'https://localhost:9/assets/studio/trophy.glb' && $asset['thumbnail'] === 'https://localhost:9/assets/studio/trophy.png', 'absolute model references');
studio_check($asset['name'] === 'First Light' && $asset['properties']['atlas.demo.noValue'] === 'true', 'name and fixed properties');
studio_check($asset['class'] === ATLAS_STUDIO_CLASS && $asset['tradeScope'] === 'bound' && $asset['fungible'] === false, 'class flags cannot be changed by the plan');
studio_check(atlas_studio_build_asset(array_merge($base, ['fungible' => true]), $plan, 'localhost:9') === null, 'refuse a fungible base');
studio_check(atlas_studio_build_asset(array_merge($base, ['tradeScope' => 'global']), $plan, 'localhost:9') === null, 'refuse a tradable base');
studio_check(atlas_studio_build_asset(array_merge($base, ['class' => 'atlas.element.gold']), $plan, 'localhost:9') === null, 'refuse another class');
echo "Asset Studio issuance plan tests passed\n";

// File validation: only Studio's own collection under /assets/studio/ is accepted, never the site's /assets/ models.
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/model-catalog.php';
$web = sys_get_temp_dir() . '/studio-models-' . bin2hex(random_bytes(4));
mkdir($web . '/assets/studio', 0700, true);
$glb = "glTF" . str_repeat("\0", 32); $png = "\x89PNG" . str_repeat("\0", 32);
foreach (['trophy', 'badge', 'key'] as $t) { file_put_contents("$web/assets/studio/$t.glb", $glb); file_put_contents("$web/assets/studio/$t.png", $png); }
foreach (['trophy', 'badge', 'key'] as $t) studio_check(atlas_studio_model_available($web, atlas_studio_model_for_template($t)), "studio models for $t accepted");
$good = atlas_studio_model_for_template('badge');
studio_check(!atlas_studio_model_available($web, ['modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png']), 'the site\'s own /assets/badge.* is not a Studio model');
file_put_contents("$web/assets/badge.glb", $glb); file_put_contents("$web/assets/badge.png", $png);
studio_check(!atlas_studio_model_available($web, ['modelPath' => '/assets/badge.glb', 'thumbnailPath' => '/assets/badge.png']), 'valid files at /assets/badge.* are still refused');
studio_check(!atlas_studio_model_available($web, ['modelPath' => '/assets/studio/badge.png', 'thumbnailPath' => '/assets/studio/badge.glb']), 'model and thumbnail extensions are not interchangeable');
studio_check(!atlas_studio_model_available($web, ['modelPath' => '/assets/studio/other.glb', 'thumbnailPath' => '/assets/studio/badge.png']), 'only the three template names');
studio_check(!atlas_studio_model_available($web, ['modelPath' => '/assets/studio/../badge.glb', 'thumbnailPath' => '/assets/studio/badge.png']), 'no traversal');
studio_check(!atlas_studio_model_available($web, ['modelPath' => '/assets/studio/sub/badge.glb', 'thumbnailPath' => '/assets/studio/badge.png']), 'no subfolders');
file_put_contents("$web/assets/studio/key.glb", 'not a glb at all, just text');
studio_check(!atlas_studio_model_available($web, atlas_studio_model_for_template('key')), 'a corrupt Studio model is refused');
// A /assets/studio folder that is a link out of the document root is refused.
$out = sys_get_temp_dir() . '/studio-models-out-' . bin2hex(random_bytes(4));
mkdir($out, 0700);
file_put_contents("$out/trophy.glb", $glb); file_put_contents("$out/trophy.png", $png);
foreach (['trophy', 'badge', 'key'] as $t) { @unlink("$web/assets/studio/$t.glb"); @unlink("$web/assets/studio/$t.png"); }
rmdir("$web/assets/studio");
if (function_exists('symlink') && @symlink($out, "$web/assets/studio")) {
  studio_check(!atlas_studio_model_available($web, atlas_studio_model_for_template('trophy')), 'a linked studio folder outside the document root is refused');
  unlink("$web/assets/studio");
}
foreach (glob("$out/*") as $f) unlink($f); rmdir($out);
foreach (glob("$web/assets/*") as $f) if (is_file($f)) unlink($f);
rmdir("$web/assets"); rmdir($web);
