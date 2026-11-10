<?php
// POST /atlas/ledger/gold-hold: EXPERIMENTAL, off unless enabled in lib/atlas-gold-hold-config.json. See lib/gold-hold.php.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/gold-hold.php';
handle_preflight();
atlas_hold_endpoint();
