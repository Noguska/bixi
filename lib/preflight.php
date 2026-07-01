<?php
declare(strict_types=1);

require_once __DIR__ . '/svn.php';       // svn_preflight(), SVN_* constants
require_once __DIR__ . '/desktop.php';   // os_family()

/*
 * App-level gate. The whole app shells out to `svn`, so if the client is missing
 * or older than the enforced floor (SVN_MIN_VERSION), there's no point loading the
 * SPA — render a standalone, JS-free setup/download page and stop. This must work
 * even when nothing else does, so it depends on no assets and no client script.
 */

/** Render the setup page and exit() if svn is missing or too old; otherwise return. */
function svn_preflight_gate(): void {
    $pf = svn_preflight();
    if ($pf['ok']) return;
    if (!headers_sent()) {
        http_response_code(503);
        header('Content-Type: text/html; charset=utf-8');
        header('Retry-After: 0');
    }
    echo svn_preflight_page_html($pf);
    exit;
}

/** Per-OS install guidance (HTML string, already escaped where needed). */
function svn_preflight_os_help(): string {
    switch (os_family()) {
        case 'windows':
            return 'Install <b>SlikSVN</b> or <b>TortoiseSVN</b> (during the TortoiseSVN '
                 . 'installer, enable <i>"command line client tools"</i> — it\'s off by '
                 . 'default), then open a new terminal so <code>svn</code> is on your '
                 . '<code>PATH</code>.';
        case 'mac':
            return 'Install via <b>Homebrew</b>: <code>brew install subversion</code> '
                 . '(or use MacPorts: <code>sudo port install subversion</code>).';
        default:
            return 'Install your distribution\'s package, e.g. '
                 . '<code>sudo apt install subversion</code> (Debian/Ubuntu) or '
                 . '<code>sudo dnf install subversion</code> (Fedora/RHEL).';
    }
}

/** Build the full standalone HTML page for a failed preflight. */
function svn_preflight_page_html(array $pf): string {
    $min  = htmlspecialchars((string) $pf['min'], ENT_QUOTES);
    $rec  = htmlspecialchars((string) $pf['recommended'], ENT_QUOTES);
    $help = svn_preflight_os_help();
    $packages = 'https://subversion.apache.org/packages.html';

    if (!$pf['installed']) {
        $headline = 'Subversion is not installed';
        $detail   = 'The <code>svn</code> command-line client was not found on this '
                  . 'machine\'s <code>PATH</code>. Bixi drives the real <code>svn</code> '
                  . 'CLI for every operation, so it can\'t run without it.';
    } else {
        $found    = htmlspecialchars((string) $pf['version'], ENT_QUOTES);
        $headline = 'Your Subversion client is too old';
        $detail   = "Found <b>svn $found</b>, but Bixi requires <b>$min</b> or newer. "
                  . 'The credential is handed to <code>svn</code> via '
                  . '<code>--password-from-stdin</code> (added in 1.10) so it never appears '
                  . 'on the command line — older clients can\'t do that safely.';
    }

    return <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bixi — Subversion required</title>
<style>
  :root {
    --chrome-bg:#101216; --chrome-bg2:#14161b; --chrome-border:#1d2027;
    --body-bg:#0d0e11; --body-border:#262a33; --text:#e6e8ec; --muted:#8b909a;
    --gold:#f5b13d; --red:#f0616a;
    --mono:'IBM Plex Mono',Consolas,monospace;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:var(--body-bg); color:var(--text);
    font-family:-apple-system,'Segoe UI',Roboto,sans-serif; font-size:14px; line-height:1.55;
    padding:24px;
  }
  .card {
    width:100%; max-width:560px; background:var(--chrome-bg); border:1px solid var(--chrome-border);
    border-left:3px solid var(--red); border-radius:8px; padding:28px 30px;
  }
  h1 { margin:0 0 14px; font-size:19px; font-weight:700; }
  p { margin:0 0 14px; color:#CDD5DF; }
  .help { background:var(--chrome-bg2); border:1px solid var(--body-border); border-radius:6px;
          padding:14px 16px; margin:0 0 16px; }
  code { font-family:var(--mono); font-size:12.5px; background:#0E141C; border:1px solid var(--body-border);
         border-radius:4px; padding:1px 5px; }
  b { color:var(--text); }
  a.btn { display:inline-block; margin-top:4px; padding:9px 16px; border-radius:6px;
          background:var(--gold); color:#1A1205; font-weight:700; text-decoration:none; }
  a.btn:hover { filter:brightness(1.06); }
  .foot { margin:18px 0 0; font-size:12px; color:var(--muted); }
  .foot a { color:var(--gold); }
</style>
</head>
<body>
  <div class="card">
    <h1>$headline</h1>
    <p>$detail</p>
    <div class="help">$help</div>
    <p><a class="btn" href="$packages" target="_blank" rel="noopener">Download Subversion →</a></p>
    <p class="foot">
      Official binary packages for every OS are listed on the Apache Subversion site:
      <a href="$packages" target="_blank" rel="noopener">$packages</a>.<br>
      Minimum required: <b>$min</b> &middot; recommended: <b>$rec</b>.
      After installing, reload this page.
    </p>
  </div>
</body>
</html>
HTML;
}
