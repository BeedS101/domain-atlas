<?php
// GET /atlas/world/drops?world=... (task #250, SPEC.md §5.5) — mirrors
// issuer-server/server.js's own /atlas/world/drops handler exactly. Every
// currently-live drop in `world`, from every visitor who's ever dropped
// something there and not yet had it claimed. Deliberately ungated, same
// "read is open, write is gated" asymmetry GET /atlas/trade/listings
// already has against its own write endpoints: this is genuinely public,
// shared scene state — anyone standing in the world can already SEE these
// items sitting there, this just lets a client render them without first
// finding the exact marker.
//
// Lives at drops/index.php, NOT a sibling drops.php next to this same
// drops/ directory (claim.php + relay-claim.php's home) — that's not a
// style choice, it's a real bug this project shipped and had to walk
// back: on this project's own php -S test servers, a sibling drops.php
// happily answered GET /atlas/world/drops (test-router.php has no notion
// of "this name is also a directory"), so every protocol/UI test passed.
// On a real Apache host, though, a bare request for /atlas/world/drops
// collides with the drops/ directory sharing that exact name — Apache's
// own directory handling won this fight over the .htaccess rewrite that
// would otherwise have mapped it to drops.php, and the request came back
// a bare 500 from Apache itself, not even reaching PHP (contrast an
// application-level error, which always comes back as this app's own
// {"error": "..."} JSON — see send_json() in lib/bootstrap.php). That's
// how a drop that had genuinely succeeded server-side (POST
// /atlas/world/drop never touches this file) could still look like it
// never happened: this exact read, right after it, silently 500ing.
// Filing it as drops/index.php instead removes the collision entirely —
// Apache serving a directory's own index.php for a bare directory
// request is default, unglamorous, well-trodden behavior, not a fight
// against the rewrite rule.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_get();

$world = $_GET['world'] ?? null;
if (!$world) send_json(400, ['error' => 'world is required']);

$doc = read_world_drops();
$drops = array_values(array_filter($doc['drops'], function ($d) use ($world) {
  return $d['world'] === $world;
}));
send_json(200, ['domain' => atlas_domain(), 'world' => $world, 'drops' => $drops]);
