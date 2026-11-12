<?php
// The scheduled crawl. Run from a cPanel cron job, for example every 15 minutes:
//   php /home/ACCOUNT/public_html/atlas/directory/cron.php
// It re-fetches every manifest that is due (how often is crawlIntervalSeconds) and does nothing
// else. It refuses to run over the web.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/lib/bootstrap.php';
$report = dir_crawl_due(200);
echo gmdate('c') . ' due=' . $report['due'] . ' ok=' . $report['ok'] . ' failed=' . $report['failed'] . "\n";
