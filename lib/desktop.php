<?php
declare(strict_types=1);

require_once __DIR__ . '/util.php';
require_once __DIR__ . '/store.php';
require_once __DIR__ . '/svn.php';   // svn_exec(), svn_base_tempfile()

/*
 * Cross-platform desktop launching: the external diff tool, "open with default
 * program", and "reveal in file manager". None of this is SVN-specific.
 *
 * The hard part is *visibility*, and it's Windows-only: a Windows service (e.g.
 * Apache under XAMPP) runs in "Session 0", which has no desktop, so any GUI it
 * spawns is invisible to the logged-in user. There are two launch strategies:
 *
 *   DIRECT  — PHP is already running in the user's session (recommended: serve
 *             the app with `php -S` via run.cmd / run.sh, i.e. SAPI 'cli-server').
 *             We just spawn the tool; the window appears. Works on Win/mac/Linux.
 *
 *   QUEUE   — Windows + Apache-as-a-service only. We can't show a window from
 *             Session 0, so we drop a request file in data/extdiff-queue and poke
 *             an interactive Scheduled Task ("SvnReviewDiff") that drains it in the
 *             user's session. This is the legacy path (setup-diff-task.cmd); the
 *             run.cmd app-mode makes it unnecessary.
 *
 * macOS/Linux have no Session-0 split, so they always use DIRECT (the only real
 * blocker there is a web server with no display, which the queue couldn't fix).
 */

const EXTDIFF_TASK = 'SvnReviewDiff';

function os_family(): string {
    if (PHP_OS_FAMILY === 'Windows') return 'windows';
    if (PHP_OS_FAMILY === 'Darwin')  return 'mac';
    return 'linux';
}

/** Can a launched GUI actually be seen by the logged-in user right now? */
function desktop_direct_ok(): bool {
    $override = config_get('direct_launch', null);     // explicit user override
    if ($override === true)  return true;
    if ($override === false) return false;
    if (php_sapi_name() === 'cli-server') return true; // served by `php -S` in-session
    return os_family() !== 'windows';                  // no Session-0 split off Windows
}

function desktop_launch_mode(): string {
    return desktop_direct_ok() ? 'direct' : 'queue';
}

// ---------------------------------------------------------------- spawning

/** Quote one argument for a Windows cmd.exe command line. */
function win_quote(string $s): string {
    return '"' . str_replace('"', '', $s) . '"';   // SVN paths can't contain " on Windows
}

/** Convert a path to the OS-native separator. */
function native_path(string $p): string {
    return os_family() === 'windows' ? str_replace('/', '\\', $p) : $p;
}

/**
 * Run a raw Windows command line through cmd.exe and return immediately (the line
 * should itself detach, e.g. via `start ""`). Non-blocking, fire-and-forget.
 */
function win_run_line(string $line): void {
    $proc = @proc_open($line, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($proc)) fail('Failed to launch the desktop tool.', 500);
    foreach ($pipes as $p) { if (is_resource($p)) fclose($p); }
    proc_close($proc);     // `start`/explorer return at once, so this doesn't block
}

/**
 * Spawn an argv array detached on macOS/Linux (output to /dev/null). We do NOT
 * proc_close — that would block until the GUI exits; letting the handle fall out
 * of scope detaches the child (proc_open doesn't kill on free).
 */
function posix_spawn(array $argv): void {
    $null = ['file', '/dev/null', 'r'];
    $nullw = ['file', '/dev/null', 'w'];
    $proc = @proc_open($argv, [0 => $null, 1 => $nullw, 2 => $nullw], $pipes);
    if (!is_resource($proc)) fail('Failed to launch: ' . ($argv[0] ?? ''), 500);
    // intentionally not closed — detach
}

// ------------------------------------------------------------ tool config

/** Locate an executable by name (where/which), or null. */
function which_exe(string $bin): ?string {
    $finder = os_family() === 'windows' ? ['where', $bin] : ['which', $bin];
    $r = svn_exec($finder, sys_get_temp_dir());
    if ($r['code'] === 0) {
        $first = trim(strtok($r['out'], "\r\n"));
        if ($first !== '') return $first;
    }
    return null;
}

/** Locate TortoiseProc.exe (PATH, then the usual install dirs), or null. */
function find_tortoiseproc(): ?string {
    foreach ([
        'C:\\Program Files\\TortoiseSVN\\bin\\TortoiseProc.exe',
        'C:\\Program Files (x86)\\TortoiseSVN\\bin\\TortoiseProc.exe',
    ] as $p) {
        if (is_file($p)) return $p;
    }
    return which_exe('TortoiseProc.exe');
}

/**
 * A sensible default external-diff command for this machine, with placeholders:
 *   {path}            absolute working-copy path (for tools that self-diff, e.g.
 *                     TortoiseSVN — it computes BASE-vs-working itself)
 *   {base} {working}  two files to compare (we materialise {base} from svn cat)
 * Returns '' when nothing suitable is found (the user must configure one).
 */
function desktop_default_diff(): string {
    $os = os_family();
    if ($os === 'windows') {
        $t = find_tortoiseproc();
        if ($t) return win_quote($t) . ' /command:diff /path:{path} /closeonend:0';
        if (which_exe('code')) return 'code --wait --diff {base} {working}';
        return '';
    }
    if ($os === 'mac') {
        if (which_exe('code')) return 'code --wait --diff {base} {working}';
        return 'opendiff {base} {working}';        // FileMerge, ships with Xcode tools
    }
    if (which_exe('code')) return 'code --wait --diff {base} {working}';
    if (which_exe('meld')) return 'meld {base} {working}';
    return '';
}

/** The effective diff command template: user setting if set, else the default. */
function diff_template(): string {
    $cfg = config_get('tools', []);
    $t = is_array($cfg) ? trim((string)($cfg['diff'] ?? '')) : '';
    return $t !== '' ? $t : desktop_default_diff();
}

// ---------------------------------------------------------------- tokenizer

/** Split a command-line template into argv, honoring "double" and 'single' quotes. */
function tokenize_cmd(string $s): array {
    $tokens = []; $cur = ''; $has = false; $in = false; $q = '';
    $len = strlen($s);
    for ($i = 0; $i < $len; $i++) {
        $c = $s[$i];
        if ($in) {
            if ($c === $q) $in = false;
            else $cur .= $c;
        } elseif ($c === '"' || $c === "'") {
            $in = true; $q = $c; $has = true;
        } elseif ($c === ' ' || $c === "\t") {
            if ($has) { $tokens[] = $cur; $cur = ''; $has = false; }
        } else {
            $cur .= $c; $has = true;
        }
    }
    if ($has) $tokens[] = $cur;
    return $tokens;
}

// ------------------------------------------------------------- the verbs

/**
 * Launch the configured external diff tool for a pending working-copy file.
 * $rel is repo-relative; the file's BASE is materialised on demand for {base}.
 */
function desktop_diff(string $projectPath, string $rel): void {
    $template = diff_template();
    if (trim($template) === '') {
        fail('No diff tool is configured. Open Settings and set an external diff command '
            . '(e.g. "code --diff {base} {working}", or TortoiseSVN on Windows).', 500);
    }
    $working = native_path($projectPath . '/' . $rel);
    $values = ['{path}' => $working, '{working}' => $working, '{name}' => basename($rel)];
    if (strpos($template, '{base}') !== false) {
        $values['{base}'] = native_path(svn_base_tempfile($projectPath, $rel));
    }

    if (os_family() === 'windows') {
        // Build a command-line string, quoting only the substituted path *values*
        // (which may contain spaces) while leaving the template's structure intact.
        // Switches like /command:diff MUST stay unquoted — TortoiseSVN's own parser
        // ignores a quoted switch, which made TortoiseProc open its project window
        // instead of the diff.
        $qmap = [];
        foreach ($values as $k => $v) $qmap[$k] = win_quote($v);
        $line = strtr($template, $qmap);
        if (desktop_direct_ok()) win_run_line('start "" ' . $line);
        else session_enqueue(['run', $line]);
        return;
    }

    // macOS / Linux: spawn an argv array (no shell) — raw values into the tokens.
    $argv = array_map(fn($t) => strtr($t, $values), tokenize_cmd($template));
    if (!$argv) fail('The configured diff command is empty.', 500);
    posix_spawn($argv);
}

/** Open a path with its default associated program. */
function desktop_open(string $abs): void {
    $os = os_family();
    if ($os === 'mac')   { posix_spawn(['open', $abs]); return; }
    if ($os === 'linux') { posix_spawn(['xdg-open', $abs]); return; }
    desktop_win_open($abs);
}

/** Reveal a path in the OS file manager (a file is selected; a folder opens). */
function desktop_reveal(string $abs): void {
    $os = os_family();
    if ($os === 'mac') {
        posix_spawn(is_dir($abs) ? ['open', $abs] : ['open', '-R', $abs]);
        return;
    }
    if ($os === 'linux') {
        posix_spawn(['xdg-open', is_dir($abs) ? $abs : dirname($abs)]);
        return;
    }
    desktop_win_reveal($abs);
}

// ------------------------------------------------- Windows direct/queue split

function desktop_win_open(string $abs): void {
    $win = str_replace('/', '\\', $abs);
    if (desktop_direct_ok()) win_run_line('start "" ' . win_quote($win));
    else session_enqueue(['open', $win]);
}

function desktop_win_reveal(string $abs): void {
    $win = str_replace('/', '\\', $abs);
    if (desktop_direct_ok()) {
        win_run_line(is_dir($abs)
            ? 'start "" ' . win_quote($win)
            : 'explorer /select,' . win_quote($win));
    } else {
        session_enqueue(['explorer', $win]);
    }
}

// ------------------------------------------------- Windows Scheduled-Task queue

/**
 * Drop a request file for the interactive desktop-launcher task and trigger it.
 * One field per line; line 1 is the verb. Windows-only fallback used when the app
 * is served by Apache as a service (Session 0). Registered via setup-diff-task.cmd.
 */
function session_enqueue(array $lines): void {
    $queue = APP_ROOT . '/data/extdiff-queue';
    if (!is_dir($queue) && !@mkdir($queue, 0777, true) && !is_dir($queue)) {
        fail('Could not create the launch queue directory: ' . $queue, 500);
    }
    $reqFile = $queue . '/' . bin2hex(random_bytes(8)) . '.txt';
    if (@file_put_contents($reqFile, implode("\r\n", $lines) . "\r\n") === false) {
        fail('Could not write the launch request file.', 500);
    }

    $r = svn_exec(['schtasks', '/run', '/tn', EXTDIFF_TASK], sys_get_temp_dir());
    if ($r['code'] !== 0) {
        @unlink($reqFile);
        $q = svn_exec(['schtasks', '/query', '/tn', EXTDIFF_TASK], sys_get_temp_dir());
        $msg = $q['code'] !== 0
            ? 'Desktop launching needs the app to run in your session. Easiest fix: start it '
              . 'with run.cmd (serves it via php -S). Otherwise, on Apache-as-a-service, run '
              . 'setup-diff-task.cmd once to register the "' . EXTDIFF_TASK . '" helper task.'
            : 'Could not start the desktop helper task: ' . trim($r['err'] !== '' ? $r['err'] : $r['out']);
        fail($msg, 500);
    }
}
