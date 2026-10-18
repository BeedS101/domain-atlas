<?php
// POST /atlas/ledger/account-credential: EXPERIMENTAL, off unless enabled in
// lib/atlas-ledger-issuance-config.json. See lib/ledger-issuance.php.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/ledger-issuance.php';
handle_preflight();
atlas_ledger_issue_account();
