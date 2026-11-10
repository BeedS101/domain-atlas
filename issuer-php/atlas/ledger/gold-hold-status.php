<?php
// GET /atlas/ledger/gold-hold-status: EXPERIMENTAL, off with the hold endpoint. See lib/gold-hold.php.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/gold-hold.php';
handle_preflight();
atlas_hold_status_endpoint();
