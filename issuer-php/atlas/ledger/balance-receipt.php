<?php
// GET/POST /atlas/ledger/balance-receipt: EXPERIMENTAL, off unless enabled in
// lib/atlas-ledger-receipts-config.json. See lib/ledger-receipts.php.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/ledger-receipts.php';
handle_preflight();
atlas_receipt_serve();
