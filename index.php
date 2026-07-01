<?php
declare(strict_types=1);
require_once __DIR__ . '/lib/preflight.php';
svn_preflight_gate();   // missing / too-old svn → renders the setup page and exits
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bixi — SVN Review</title>
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
<link rel="stylesheet" href="assets/app.css?v=<?= @filemtime(__DIR__ . '/assets/app.css') ?>">
</head>
<body>
<div id="app"></div>
<div id="statusbar" class="statusbar" aria-live="polite"></div>
<script src="assets/vendor/highlight.min.js"></script>
<script src="assets/app.js?v=<?= @filemtime(__DIR__ . '/assets/app.js') ?>"></script>
</body>
</html>
