<?php
declare(strict_types=1);

require_once __DIR__ . '/util.php';
require_once __DIR__ . '/auth.php';

/**
 * Low-level: run a fully-formed command array in $cwd. If $stdin is non-null it is
 * written to the child's stdin then closed — used to pass the password to svn via
 * `--password-from-stdin` so it never appears on the command line.
 * Returns ['code' => int, 'out' => string, 'err' => string].
 */
function svn_exec(array $cmd, string $cwd, ?string $stdin = null, int $timeoutSec = 0): array {
    if ($timeoutSec > 0) return svn_exec_timed($cmd, $cwd, $stdin, $timeoutSec);
    $proc = proc_open($cmd, [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ], $pipes, $cwd);
    if (!is_resource($proc)) fail('Failed to start svn process', 500);
    // Password is short (< pipe buffer), so write-then-close before draining stdout
    // can't deadlock. No trailing newline: svn reads stdin verbatim as the password.
    if ($stdin !== null && $stdin !== '') fwrite($pipes[0], $stdin);
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    return ['code' => $code, 'out' => $out, 'err' => $err];
}

/**
 * svn_exec with a hard wall-clock limit, for network ops that would otherwise hang
 * when the repo host silently drops packets (VPN down / IP firewall) — svn has no
 * client-side connect timeout of its own (serf only gives up after ~600s), and
 * PHP's max_execution_time can't interrupt a blocked native read.
 *
 * Windows PHP supports neither stream_select() nor non-blocking mode on proc_open
 * pipes (stream_set_blocking returns false; any pipe read blocks until the child
 * exits). So the child's stdout/stderr go to temp files instead, and the parent
 * polls only proc_get_status() + the clock — which never blocks — then kills the
 * child on expiry and reads the files. stdin stays a pipe (short write, no block).
 */
function svn_exec_timed(array $cmd, string $cwd, ?string $stdin, int $timeoutSec): array {
    $outFile = tempnam(sys_get_temp_dir(), 'svo');
    $errFile = tempnam(sys_get_temp_dir(), 'sve');
    $proc = proc_open($cmd, [
        0 => ['pipe', 'r'],
        1 => ['file', $outFile, 'w'],
        2 => ['file', $errFile, 'w'],
    ], $pipes, $cwd);
    if (!is_resource($proc)) {
        @unlink($outFile);
        @unlink($errFile);
        fail('Failed to start svn process', 500);
    }
    if ($stdin !== null && $stdin !== '') fwrite($pipes[0], $stdin);
    fclose($pipes[0]);

    $deadline = microtime(true) + $timeoutSec;
    $timedOut = false;
    $code = -1;
    for (;;) {
        $st = proc_get_status($proc);
        if (!$st['running']) { $code = $st['exitcode']; break; }
        if (microtime(true) >= $deadline) { $timedOut = true; proc_terminate($proc); break; }
        usleep(50000);   // 50 ms
    }
    proc_close($proc);

    $out = (string)@file_get_contents($outFile);
    $err = (string)@file_get_contents($errFile);
    @unlink($outFile);
    @unlink($errFile);
    if ($timedOut) {
        return ['code' => -1, 'out' => $out, 'timeout' => true,
                'err' => "svn timed out after {$timeoutSec}s — repository unreachable (VPN / firewall / network down?)"];
    }
    return ['code' => $code, 'out' => $out, 'err' => $err];
}

// ------------------------------------------------------------- version / preflight

/**
 * Enforced minimum svn version. 1.10 is the floor because the master-password
 * feature feeds the credential via `--password-from-stdin` (introduced in 1.10) so
 * it never lands on the command line. 1.14 is the reference/tested client.
 */
const SVN_MIN_VERSION = '1.10.0';
const SVN_RECOMMENDED_VERSION = '1.14';

/**
 * Detect the installed svn CLI version without the hard fail() that svn_exec()
 * does — a missing binary is a normal, reportable state here, not a 500.
 * Returns [major, minor, patch], or null if svn isn't callable. Cached per request.
 */
function svn_version(): ?array {
    static $cache = false;
    if ($cache !== false) return $cache;

    $proc = @proc_open(
        ['svn', '--version', '--quiet'],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
        sys_get_temp_dir()
    );
    if (!is_resource($proc)) return $cache = null;     // binary not found / not executable
    fclose($pipes[0]);
    $out = (string) stream_get_contents($pipes[1]);
    $err = (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    if (proc_close($proc) !== 0) return $cache = null;

    if (!preg_match('/(\d+)\.(\d+)\.(\d+)/', $out, $m)
        && !preg_match('/(\d+)\.(\d+)\.(\d+)/', $err, $m)) {
        return $cache = null;
    }
    return $cache = [(int) $m[1], (int) $m[2], (int) $m[3]];
}

/** True if the installed svn is at least $major.$minor.$patch. */
function svn_at_least(int $major, int $minor = 0, int $patch = 0): bool {
    $v = svn_version();
    if ($v === null) return false;
    if ($v[0] !== $major) return $v[0] > $major;
    if ($v[1] !== $minor) return $v[1] > $minor;
    return $v[2] >= $patch;
}

/**
 * App-level svn readiness. Distinguishes "not installed" (binary missing) from
 * "too old" (present but below SVN_MIN_VERSION).
 * Returns ['installed'=>bool, 'version'=>?string, 'ok'=>bool, 'min'=>string, 'recommended'=>string].
 */
function svn_preflight(): array {
    $v = svn_version();
    $installed = $v !== null;
    return [
        'installed'   => $installed,
        'version'     => $installed ? implode('.', $v) : null,
        'ok'          => $installed && svn_at_least(1, 10, 0),
        'min'         => SVN_MIN_VERSION,
        'recommended' => SVN_RECOMMENDED_VERSION,
    ];
}

/**
 * Run the svn CLI with an argument array (no shell quoting issues), injecting the
 * stored username and — when the request is unlocked — the resolved password via
 * stdin (`--password-from-stdin`, never on the command line). Local/read ops work
 * without the password; auth-required network ops need an active unlock session.
 * $timeoutSec > 0 adds a hard wall-clock limit (see svn_exec).
 * Returns ['code' => int, 'out' => string, 'err' => string, 'timeout'? => true].
 */
function svn_run(array $args, string $cwd, int $timeoutSec = 0): array {
    // http-timeout caps serf's socket *inactivity* (default 600s) so http(s)
    // network ops error out rather than hang when the host stops responding;
    // an actively-transferring checkout/update never trips it. Ignored for
    // local operations and file:// / svn:// repos.
    $cmd = ['svn', '--non-interactive', '--config-option', 'servers:global:http-timeout=60'];
    $stdin = null;
    $user = auth_username();
    if ($user !== null) {
        $cmd[] = '--username';
        $cmd[] = $user;
        $pw = auth_session_password();
        if ($pw !== null) {
            $cmd[] = '--password-from-stdin';
            $cmd[] = '--no-auth-cache';
            $stdin = $pw;
        }
    }
    $cmd = array_merge($cmd, $args);
    return svn_exec($cmd, $cwd, $stdin, $timeoutSec);
}

/**
 * Verify a username/password against a repository URL (a real network round-trip).
 * The password is fed via stdin, never the command line.
 * Returns ['ok' => bool, 'error' => string].
 */
function svn_check_auth(string $username, string $password, string $url): array {
    $cmd = [
        'svn', '--non-interactive', '--no-auth-cache',
        '--username', $username, '--password-from-stdin',
        'info', '--xml', '--', $url,
    ];
    $r = svn_exec($cmd, sys_get_temp_dir(), $password, 20);
    if ($r['timeout'] ?? false) return ['ok' => false, 'error' => 'Could not reach the repository (timed out after 20s) — VPN / network down?'];
    if ($r['code'] === 0) return ['ok' => true, 'error' => ''];
    $err = trim($r['err']);
    if (stripos($err, 'E170001') !== false
        || stripos($err, 'authoriz') !== false
        || stripos($err, 'authentic') !== false) {
        return ['ok' => false, 'error' => 'SVN authentication failed — check the username and password.'];
    }
    return ['ok' => false, 'error' => 'Could not verify credentials: ' . ($err !== '' ? $err : 'svn exited with code ' . $r['code'])];
}

/** Verify a path is an SVN working copy; returns info or fails. */
function svn_info(string $path): array {
    $r = svn_run(['info', '--xml', '.'], $path);
    if ($r['code'] !== 0) fail('Not an SVN working copy: ' . trim($r['err']));
    $xml = simplexml_load_string($r['out']);
    $entry = $xml->entry;
    return [
        'url' => (string)$entry->url,
        'root' => (string)$entry->repository->root,
        'revision' => (string)$entry['revision'],
    ];
}

/**
 * Read-only remote probe of a repository URL (validates the URL and, for private
 * repos, the credential). Runs via svn_run so the stored username + unlocked
 * password are used. Returns ['code','out','err'].
 */
function svn_url_info(string $url): array {
    return svn_run(['info', '--xml', '--', $url], sys_get_temp_dir());
}

/**
 * Check out a new working copy from $url into $dest. $rev is a specific revision
 * or null for HEAD; $depth is an svn --depth value ('infinity'|'immediates'|
 * 'files'|'empty'). Runs via svn_run so the stored credential is injected when the
 * session is unlocked. The caller is responsible for lifting the PHP time limit —
 * a full checkout can run for minutes and svn_exec does not time out.
 * Returns ['code','out','err'].
 */
function svn_checkout(string $url, string $dest, ?int $rev, string $depth): array {
    $args = ['checkout', '--depth', $depth];
    if ($rev !== null) { $args[] = '-r'; $args[] = (string)$rev; }
    $args[] = '--';
    $args[] = $url;
    $args[] = $dest;
    return svn_run($args, sys_get_temp_dir());
}

/**
 * Repository HEAD revision for a working copy (contacts the server with -r HEAD).
 * Returns the integer HEAD revision, or null if it couldn't be determined.
 */
function svn_remote_revision(string $path): ?int {
    $r = svn_run(['info', '-r', 'HEAD', '--xml', '.'], $path, 15);
    if ($r['timeout'] ?? false) fail('Timed out contacting the repository (15s) — VPN / network down?', 504);
    if ($r['code'] !== 0) fail('svn info -r HEAD failed: ' . trim($r['err']), 500);
    $xml = simplexml_load_string($r['out']);
    if ($xml === false || !isset($xml->entry)) return null;
    $rev = (string)$xml->entry['revision'];
    return ctype_digit($rev) ? (int)$rev : null;
}

/**
 * Full recursive pending-change list for a working copy.
 * One svn call regardless of tree size. Returns list of
 * ['path' => relpath-with-forward-slashes, 'status' => string, 'isDir' => bool,
 *  'revision' => int|null, 'mtime' => int|null].  `revision` is the working-copy
 * base revision of the entry (null for unversioned/added items that have no base
 * revision yet); `mtime` is filemtime() (null for deleted/missing files).
 */
function svn_status(string $path, bool $includeIgnored = false, bool $includeUnmodified = false): array {
    $args = ['status', '--xml', '--ignore-externals'];
    if ($includeIgnored) $args[] = '--no-ignore';   // surface ignored items too
    if ($includeUnmodified) $args[] = '-v';          // verbose: also list unchanged versioned files
    $args[] = '.';
    $r = svn_run($args, $path);
    if ($r['code'] !== 0) fail('svn status failed: ' . trim($r['err']), 500);
    $xml = simplexml_load_string($r['out']);
    if ($xml === false) fail('Could not parse svn status output', 500);

    // 'normal' (unchanged) is skipped unless the caller asked for unmodified files
    // (verbose mode); 'ignored' unless asked for; externals/none always.
    $skip = ['external' => 1, 'none' => 1];
    if (!$includeUnmodified) $skip['normal'] = 1;
    if (!$includeIgnored) $skip['ignored'] = 1;
    $files = [];
    foreach ($xml->target->entry ?? [] as $entry) {
        $rel = norm_path((string)$entry['path']);
        if ($rel === '.' || $rel === '') continue;
        $item = (string)$entry->{'wc-status'}['item'];
        $props = (string)$entry->{'wc-status'}['props'];
        if (isset($skip[$item])) {
            // property-only changes still count as modified
            if ($props === 'modified' || $props === 'conflicted') $item = 'modified';
            else continue;
        }
        // A surfaced 'normal' entry (verbose mode) is either a property-only change
        // (→ modified) or a truly-unchanged file (→ unmodified).
        if ($item === 'normal') {
            $item = ($props === 'modified' || $props === 'conflicted') ? 'modified' : 'unmodified';
        }
        $abs = $path . '/' . $rel;
        $rev = (string)$entry->{'wc-status'}['revision'];
        $files[] = [
            'path' => $rel,
            'status' => $item,            // modified|added|deleted|unversioned|missing|replaced|conflicted
            'isDir' => is_dir($abs),
            // base revision; '-1'/''/non-numeric (unversioned, added) => null
            'revision' => ctype_digit($rev) && $rev !== '0' ? (int)$rev : null,
            'mtime' => ($mt = @filemtime($abs)) !== false ? $mt : null,
        ];
    }
    // svn never descends into an unversioned directory — it reports only the dir
    // itself as '?'. Expand each one ourselves so its (non-ignored) files and
    // subfolders show individually, just like an unversioned file at the top level.
    $ignoreGlobs = svn_global_ignores();
    $extra = [];
    foreach ($files as $f) {
        if ($f['status'] === 'unversioned' && $f['isDir']) {
            $extra = array_merge($extra,
                expand_unversioned_dir($f['path'], $path . '/' . $f['path'], $ignoreGlobs, $includeIgnored));
        }
    }
    if ($extra) $files = array_merge($files, $extra);

    usort($files, fn($a, $b) => strcmp($a['path'], $b['path']));
    return $files;
}

/** Max synthetic entries surfaced from one unversioned directory (loop/runaway guard). */
const UNVERSIONED_EXPAND_CAP = 20000;

/**
 * SVN's effective global-ignore globs. Since svn won't descend into an
 * unversioned directory, listing such a directory's contents ourselves means
 * reproducing svn's ignore filtering — and the only ignore rules that apply
 * inside an unversioned subtree are the global-ignores (svn:ignore can't be set
 * on an unversioned dir, and an ancestor's svn:ignore only matches its own
 * immediate children). Uses the user's configured `global-ignores` if present,
 * otherwise svn 1.14's compiled-in defaults. Cached for the request.
 */
function svn_global_ignores(): array {
    static $cache = null;
    if ($cache !== null) return $cache;
    $line = '*.o *.lo *.la *.al .libs *.so *.so.[0-9]* *.a *.pyc *.pyo __pycache__ '
          . '*.rej *~ #*# .#* .*.swp .DS_Store';
    foreach ([getenv('APPDATA'), getenv('ALLUSERSPROFILE')] as $base) {
        if (!$base) continue;
        $cfg = $base . '/Subversion/config';
        if (!is_file($cfg)) continue;
        foreach (file($cfg, FILE_IGNORE_NEW_LINES) ?: [] as $row) {
            // an UNcommented `global-ignores = …` line overrides the default set
            if (preg_match('/^\s*global-ignores\s*=\s*(.*)$/', $row, $m)) { $line = trim($m[1]); break 2; }
        }
    }
    $cache = array_values(array_filter(preg_split('/\s+/', trim($line)) ?: [], fn($p) => $p !== ''));
    return $cache;
}

/**
 * List an unversioned directory's contents as synthetic status entries (same
 * shape as svn_status()'s). Every file/subdir is 'unversioned'; names matching
 * the global-ignores are skipped, or returned as 'ignored' when $includeIgnored
 * (mirrors the --no-ignore toggle). Ignored directories and symlinked directories
 * are listed but not descended (svn collapses an ignored dir to one entry; not
 * following links avoids junction loops). Bounded by UNVERSIONED_EXPAND_CAP.
 */
function expand_unversioned_dir(string $relDir, string $absDir, array $ignoreGlobs, bool $includeIgnored): array {
    $out = [];
    $stack = [[$relDir, $absDir]];
    while ($stack) {
        [$rel, $abs] = array_pop($stack);
        $names = @scandir($abs);
        if ($names === false) continue;
        foreach ($names as $name) {
            if ($name === '.' || $name === '..' || $name === '.svn') continue;
            if (count($out) >= UNVERSIONED_EXPAND_CAP) return $out;
            $cAbs = $abs . '/' . $name;
            $cRel = $rel . '/' . $name;
            $isDir = is_dir($cAbs);
            $ignored = svn_ignore_matches($name, $ignoreGlobs) !== [];
            if ($ignored && !$includeIgnored) continue;       // hidden entirely (off by default)
            $out[] = [
                'path' => $cRel,
                'status' => $ignored ? 'ignored' : 'unversioned',
                'isDir' => $isDir,
                'revision' => null,
                'mtime' => ($mt = @filemtime($cAbs)) !== false ? $mt : null,
            ];
            if ($isDir && !$ignored && !is_link($cAbs)) $stack[] = [$cRel, $cAbs];
        }
    }
    return $out;
}

/** Max directories returned by wc_dirs() (runaway guard for pathological trees). */
const WC_DIRS_CAP = 50000;

/**
 * Map of repo-relative directory => its svn:ignore patterns, for the whole working
 * copy, in one `svn propget svn:ignore -R` call. The working-copy root is keyed ''.
 */
function svn_ignore_map(string $projectPath): array {
    $r = svn_run(['propget', 'svn:ignore', '-R', '--xml', '.'], $projectPath);
    if ($r['code'] !== 0) return [];
    $xml = simplexml_load_string($r['out']);
    if ($xml === false) return [];
    $base = norm_path($projectPath) . '/';
    $root = norm_path($projectPath);
    $map = [];
    foreach ($xml->target ?? [] as $t) {
        $p = norm_path((string)$t['path']);
        if ($p === $root || $p === '.' || $p === '') $p = '';
        elseif (stripos($p, $base) === 0) $p = substr($p, strlen($base));
        $pats = array_values(array_filter(
            array_map('trim', preg_split('/\r\n|\r|\n/', (string)$t->property) ?: []),
            fn($x) => $x !== ''
        ));
        if ($pats) $map[$p] = $pats;
    }
    return $map;
}

/**
 * Every directory under the working copy (repo-relative paths, sorted), for the
 * navigation tree — INCLUDING directories with no pending changes. A directory is
 * treated as ignored when its name matches the global-ignores or its parent's
 * svn:ignore (mirroring svn's own decision); ignored directories are listed but
 * not descended when $includeIgnored, and skipped entirely otherwise. `.svn` and
 * symlinked directories are never descended. Excludes the root ('') itself.
 */
function wc_dirs(string $path, bool $includeIgnored = false): array {
    $global = svn_global_ignores();
    $svnIgnore = svn_ignore_map($path);
    $out = [];
    $stack = [['', $path]];
    while ($stack) {
        [$rel, $abs] = array_pop($stack);
        $patterns = array_merge($global, $svnIgnore[$rel] ?? []);
        $names = @scandir($abs);
        if ($names === false) continue;
        foreach ($names as $name) {
            if ($name === '.' || $name === '..' || $name === '.svn') continue;
            $cAbs = $abs . '/' . $name;
            if (!is_dir($cAbs)) continue;
            $ignored = svn_ignore_matches($name, $patterns) !== [];
            if ($ignored && !$includeIgnored) continue;     // skip the whole ignored subtree
            if (count($out) >= WC_DIRS_CAP) { sort($out); return $out; }
            $cRel = $rel === '' ? $name : $rel . '/' . $name;
            $out[] = $cRel;
            if (!$ignored && !is_link($cAbs)) $stack[] = [$cRel, $cAbs];   // don't descend ignored dirs
        }
    }
    sort($out);
    return $out;
}

/**
 * The last $limit commits (newest first) for a working copy, as
 * [['rev' => int, 'author' => string], ...]. Quiet (-q) — no messages fetched.
 */
function svn_log(string $projectPath, int $limit): array {
    $r = svn_run(['log', '--xml', '-q', '-l', (string)$limit, '.'], $projectPath);
    if ($r['code'] !== 0) fail('svn log failed: ' . trim($r['err']), 500);
    $xml = simplexml_load_string($r['out']);
    if ($xml === false) fail('Could not parse svn log output', 500);
    $out = [];
    foreach ($xml->logentry ?? [] as $e) {
        $out[] = ['rev' => (int)$e['revision'], 'author' => (string)$e->author];
    }
    return $out;
}

/**
 * Commit history for one path ('' = working-copy root), newest first.
 * $before (exclusive) pages older entries: only revisions below it are returned.
 * Returns [['rev' => int, 'author' => string, 'date' => string, 'msg' => string], ...]
 */
function svn_log_path(string $projectPath, string $target, int $limit, ?int $before = null): array {
    $args = ['log', '--xml', '-l', (string)$limit];
    if ($before !== null) {
        if ($before <= 1) return [];
        $args[] = '-r';
        $args[] = ($before - 1) . ':0';
    }
    $args[] = '--';
    $args[] = $target === '' ? '.' : $target;
    $r = svn_run($args, $projectPath);
    if ($r['code'] !== 0) fail('svn log failed: ' . trim($r['err']), 500);
    return parse_log_xml($r['out']);
}

/** Parse `svn log --xml` output into [['rev','author','date','msg'], ...], newest first. */
function parse_log_xml(string $xmlText): array {
    $xml = simplexml_load_string($xmlText);
    if ($xml === false) fail('Could not parse svn log output', 500);
    $out = [];
    foreach ($xml->logentry ?? [] as $e) {
        $out[] = [
            'rev' => (int)$e['revision'],
            'author' => (string)$e->author,
            'date' => (string)$e->date,
            'msg' => trim((string)$e->msg),
        ];
    }
    return $out;
}

/**
 * Diff of one committed revision for a path ("what changed in rN here").
 * A directory target can touch several files, so the result is per file:
 * [['file' => relpath, 'binary' => bool, 'lang' => string, 'hunks' => [...]], ...]
 */
function svn_diff_rev(string $projectPath, string $target, int $rev): array {
    $r = svn_run(['diff', '-c', (string)$rev, '--internal-diff', '--', $target === '' ? '.' : $target], $projectPath);
    if ($r['code'] !== 0) fail('svn diff failed: ' . trim($r['err']), 500);

    $files = [];
    $cur = null;
    $buf = [];
    $flush = function () use (&$files, &$cur, &$buf) {
        if ($cur === null) return;
        $text = implode("\n", $buf);
        // Split off the "Property changes on:" tail so its +/- value lines
        // can't bleed into the last text hunk.
        $props = [];
        if (preg_match('/^Property changes on: /m', $text, $m, PREG_OFFSET_CAPTURE)) {
            $props = parse_prop_diff(substr($text, $m[0][1]));
            // Drop the blank separator line(s) svn emits before the property
            // section so they don't render as phantom context lines.
            $text = rtrim(substr($text, 0, $m[0][1]), "\r\n");
        }
        $binary = strpos($text, 'Cannot display: file marked as a binary type') !== false;
        $files[] = [
            'file' => $cur,
            'binary' => $binary,
            'lang' => guess_lang($cur),
            'hunks' => $binary ? [] : parse_unified_diff($text),
            'props' => $props,
        ];
    };
    foreach (explode("\n", $r['out']) as $line) {
        if (preg_match('/^Index: (.+)$/', rtrim($line, "\r"), $m)) {
            $flush();
            $cur = norm_path(trim($m[1]));
            $buf = [];
            continue;
        }
        $buf[] = $line;
    }
    $flush();
    return $files;
}

/**
 * Cached last-50-commit author breakdown for the performance bar. The cached
 * commit log is rebuilt only when the working-copy revision has changed since it
 * was taken (commits/updates inside or outside this app both move that number),
 * so the common path makes no svn call. Returns:
 *   ['revision' => int, 'total' => int, 'mine' => int, 'percent' => ?int]
 * percent is null when no SVN account is signed in (nobody to measure).
 */
function commit_stats(string $projectId, string $projectPath, int $currentRevision): array {
    $cache = commits_load($projectId);
    if ($cache['revision'] !== $currentRevision) {
        $commits = svn_log($projectPath, 50);
        $cache = ['revision' => $currentRevision, 'commits' => $commits, 'when' => gmdate('c')];
        commits_save($projectId, $cache);
    }
    $commits = $cache['commits'];
    $total = count($commits);
    $user = auth_username();
    $mine = 0;
    if ($user !== null) {
        foreach ($commits as $c) {
            if (strcasecmp((string)($c['author'] ?? ''), $user) === 0) $mine++;
        }
    }
    return [
        'revision' => $currentRevision,
        'total' => $total,
        'mine' => $mine,
        'percent' => ($user !== null && $total > 0) ? (int)round($mine / $total * 100) : null,
    ];
}

/** Map file extension to a highlight.js language id. */
function guess_lang(string $relPath): string {
    $ext = strtolower(pathinfo($relPath, PATHINFO_EXTENSION));
    return match ($ext) {
        'php', 'phtml', 'inc' => 'php',
        'js', 'mjs' => 'javascript',
        'ts' => 'typescript',
        'css' => 'css',
        'scss', 'less' => 'scss',
        'html', 'htm', 'xml', 'xsl', 'svg' => 'xml',
        'json' => 'json',
        'sql' => 'sql',
        'sh' => 'bash',
        'bat', 'cmd' => 'dos',
        'ps1' => 'powershell',
        'py' => 'python',
        'md' => 'markdown',
        'ini', 'conf', 'cfg' => 'ini',
        'yml', 'yaml' => 'yaml',
        default => 'plaintext',
    };
}

const BINARY_CHECK_BYTES = 8192;

function looks_binary(string $absFile): bool {
    $fh = @fopen($absFile, 'rb');
    if (!$fh) return false;
    $chunk = fread($fh, BINARY_CHECK_BYTES);
    fclose($fh);
    return $chunk !== false && strpos($chunk, "\0") !== false;
}

/**
 * Structured diff for one file. Returns:
 * ['binary' => bool, 'lang' => string, 'hunks' => [
 *    ['oldStart' => int, 'newStart' => int,
 *     'lines' => [['t' => ' '|'+'|'-', 's' => text], ...]], ...]]
 */
function svn_diff(string $projectPath, string $rel, string $status): array {
    $abs = $projectPath . '/' . $rel;
    $lang = guess_lang($rel);

    // Unversioned: svn diff knows nothing about it — synthesize an all-added diff.
    if ($status === 'unversioned') {
        if (is_dir($abs)) return ['binary' => false, 'lang' => $lang, 'hunks' => [], 'note' => 'Unversioned directory'];
        if (looks_binary($abs)) return ['binary' => true, 'lang' => $lang, 'hunks' => []];
        $text = (string)@file_get_contents($abs);
        $lines = $text === '' ? [] : preg_split('/\r\n|\r|\n/', rtrim($text, "\r\n"));
        $hunk = ['oldStart' => 0, 'newStart' => 1, 'lines' => []];
        foreach ($lines as $l) $hunk['lines'][] = ['t' => '+', 's' => $l];
        return ['binary' => false, 'lang' => $lang, 'hunks' => $lines ? [$hunk] : []];
    }

    // For a directory row, only its own changes (property edits) belong in the
    // panel — children have their own rows. --depth empty stops the recursion.
    $args = ['diff', '--internal-diff'];
    if (is_dir($abs)) { $args[] = '--depth'; $args[] = 'empty'; }
    $args[] = '--';
    $args[] = $rel;
    $r = svn_run($args, $projectPath);
    if ($r['code'] !== 0) fail('svn diff failed: ' . trim($r['err']), 500);
    $out = $r['out'];

    if (strpos($out, 'Cannot display: file marked as a binary type') !== false) {
        return ['binary' => true, 'lang' => $lang, 'hunks' => [], 'props' => []];
    }
    // svn appends a "Property changes on:" section for svn: property edits. Split
    // it off so its +/- lines don't leak into the text hunks, and parse separately.
    $propPos = strpos($out, 'Property changes on:');
    // rtrim drops the blank separator line svn puts before the property section
    // (and the trailing newline) so neither shows up as a spurious empty diff row.
    $mainText = rtrim($propPos !== false ? substr($out, 0, $propPos) : $out, "\r\n");
    $props = $propPos !== false ? parse_prop_changes(rtrim(substr($out, $propPos), "\r\n")) : [];
    return ['binary' => false, 'lang' => $lang, 'hunks' => parse_unified_diff($mainText), 'props' => $props];
}

/**
 * Parse the "Property changes on:" section of an svn diff into per-property
 * change blocks: [['name' => 'svn:ignore', 'action' => 'Added'|'Modified'|'Deleted',
 *                  'lines' => [['t' => ' '|'+'|'-', 's' => text], ...]], ...]
 */
function parse_prop_changes(string $text): array {
    $props = [];
    $cur = null;
    foreach (preg_split('/\r\n|\r|\n/', $text) as $line) {
        if (str_starts_with($line, 'Property changes on:')) continue;
        if (preg_match('/^_{5,}$/', $line)) continue;          // the ___ underline
        if (preg_match('/^(Added|Modified|Deleted): (.+)$/', $line, $m)) {
            if ($cur) $props[] = $cur;
            $cur = ['name' => $m[2], 'action' => $m[1], 'lines' => []];
            continue;
        }
        if ($cur === null) continue;
        if (str_starts_with($line, '## ')) continue;           // prop hunk header (## -1 +1 ##)
        if ($line === '\ No newline at end of property') continue;
        $t = $line === '' ? ' ' : $line[0];
        if ($t === '+' || $t === '-' || $t === ' ') {
            $cur['lines'][] = ['t' => $t, 's' => substr($line, 1)];
        }
    }
    if ($cur) $props[] = $cur;
    return $props;
}

/** Parse unified diff text into hunks of typed lines. */
/**
 * Parse the "Property changes on:" tail of an svn diff block into
 * [['name' => 'svn:ignore', 'action' => 'Modified', 'lines' => [['t','s'],...]], ...].
 * Property hunks use "## ... ##" headers; value lines carry the usual
 * ' '/'+'/'-' prefixes (svn:mergeinfo instead emits "   Merged ..." summary lines,
 * which are kept verbatim as context).
 */
function parse_prop_diff(string $text): array {
    $props = [];
    $cur = null;
    foreach (preg_split('/\r\n|\r|\n/', $text) as $line) {
        if (preg_match('/^(Added|Modified|Deleted): (.+)$/', $line, $m)) {
            if ($cur) $props[] = $cur;
            $cur = ['name' => trim($m[2]), 'action' => $m[1], 'lines' => []];
            continue;
        }
        if ($cur === null || $line === '' || str_starts_with($line, '##')
            || str_starts_with($line, '___') || $line === '\\ No newline at end of property') continue;
        $t = $line[0];
        $cur['lines'][] = ($t === '+' || $t === '-' || $t === ' ')
            ? ['t' => $t, 's' => substr($line, 1)]
            : ['t' => ' ', 's' => $line];
    }
    if ($cur) $props[] = $cur;
    return $props;
}

function parse_unified_diff(string $diff): array {
    $hunks = [];
    $hunk = null;
    // Split on ANY line ending. CR-only (old-Mac) files emit hunk *content* lines
    // separated by bare \r while svn's @@ headers use \n; splitting on \n alone
    // would collapse a whole hunk body into one mis-parsed "context" line.
    foreach (preg_split('/\r\n|\r|\n/', $diff) as $line) {
        if (preg_match('/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/', $line, $m)) {
            if ($hunk) $hunks[] = $hunk;
            $hunk = ['oldStart' => (int)$m[1], 'newStart' => (int)$m[2], 'lines' => []];
            continue;
        }
        if ($hunk === null) continue; // header lines (Index:, ===, ---, +++)
        if ($line === '\\ No newline at end of file') continue;
        $t = $line === '' ? ' ' : $line[0];
        if ($t === ' ' || $t === '+' || $t === '-') {
            $hunk['lines'][] = ['t' => $t, 's' => substr($line, 1)];
        }
    }
    if ($hunk) $hunks[] = $hunk;
    return $hunks;
}

/**
 * Update a path from the repository. $target is a repo-relative path or '.'
 * for the whole working copy. Returns svn update output text.
 */
function svn_update(string $projectPath, string $target): string {
    $r = svn_run(['update', '--accept', 'postpone', '--', $target], $projectPath);
    if ($r['code'] !== 0) fail('svn update failed: ' . trim($r['err']), 500);
    return trim($r['out']);
}

/**
 * Revert local changes for a path (recursively for directories).
 * $target is a repo-relative path or '.' for the whole working copy.
 * Note: revert never deletes unversioned files. Returns svn output text.
 */
function svn_revert(string $projectPath, string $target): string {
    $r = svn_run(['revert', '--depth', 'infinity', '--', $target], $projectPath);
    if ($r['code'] !== 0) fail('svn revert failed: ' . trim($r['err']), 500);
    return trim($r['out']);
}

/**
 * Schedule an unversioned path for addition (with any unversioned parents).
 * With $recursive (the svn default) a directory and everything under it is added;
 * $recursive=false uses --depth=empty to schedule only the directory node itself,
 * leaving its contents unversioned. Returns svn add output text.
 */
function svn_add(string $projectPath, string $rel, bool $recursive = true): string {
    $args = ['add', '--parents'];
    if (!$recursive) $args[] = '--depth=empty';
    array_push($args, '--', $rel);
    $r = svn_run($args, $projectPath);
    if ($r['code'] !== 0) fail('svn add failed: ' . trim($r['err']), 500);
    return trim($r['out']);
}

/**
 * Schedule a versioned path for deletion. With $keepLocal the working-copy
 * file is left on disk (caller may then move it to the Recycle Bin); otherwise
 * --force removes the working file outright. Returns svn delete output text.
 */
function svn_delete(string $projectPath, string $rel, bool $keepLocal): string {
    $r = svn_run(['delete', $keepLocal ? '--keep-local' : '--force', '--', $rel], $projectPath);
    if ($r['code'] !== 0) fail('svn delete failed: ' . trim($r['err']), 500);
    return trim($r['out']);
}

/**
 * Move one or more working-copy items into a destination directory, preserving
 * each item's own name. Versioned sources are moved with `svn move` (history is
 * kept; the change shows as an add+delete pair pending commit); unversioned or
 * ignored sources are renamed on disk (SVN can't move what it doesn't track).
 *
 * $sources is a list of ['rel' => repo-relative source, 'status' => svn status].
 * $destRel is the repo-relative destination directory ('' = working-copy root).
 * Illegal moves (into self / own subtree, onto an existing name, a no-op into the
 * current parent, or a deleted/missing source) fail before anything is touched.
 * Returns ['moved' => [...rel], 'output' => string].
 */
function svn_move(string $projectPath, array $sources, string $destRel): array {
    $destAbs = $projectPath . ($destRel === '' ? '' : '/' . $destRel);
    if (!is_dir($destAbs)) {
        fail('Destination folder not found: ' . ($destRel === '' ? '(working-copy root)' : $destRel));
    }

    // Validate everything first so a bad item never half-moves a batch.
    $versioned = [];
    $unversioned = [];
    foreach ($sources as $s) {
        $rel = $s['rel'];
        $status = (string)($s['status'] ?? '');
        $name = basename($rel);
        $srcParent = strpos($rel, '/') !== false ? substr($rel, 0, strrpos($rel, '/')) : '';

        if ($status === 'deleted' || $status === 'missing') {
            fail("\"$name\" can't be moved — it's already deleted or missing.");
        }
        if ($destRel === $srcParent) {
            fail("\"$name\" is already in that folder.");
        }
        if ($destRel === $rel || strpos($destRel . '/', $rel . '/') === 0) {
            fail("Can't move \"$name\" into itself.");
        }
        if (file_exists($destAbs . '/' . $name)) {
            fail("\"$name\" already exists in the destination folder.");
        }

        if ($status === 'unversioned' || $status === 'ignored') $unversioned[] = $rel;
        else $versioned[] = $rel;   // '' (versioned-unmodified), modified, added, etc.
    }

    $output = [];
    if ($versioned) {
        // `svn move SRC... DST` moves each source into DST when DST is a directory.
        $args = ['move', '--parents', '--'];
        foreach ($versioned as $rel) $args[] = $rel;
        $args[] = $destRel === '' ? '.' : $destRel;
        $r = svn_run($args, $projectPath);
        if ($r['code'] !== 0) fail('svn move failed: ' . trim($r['err']), 500);
        if (trim($r['out']) !== '') $output[] = trim($r['out']);
    }
    foreach ($unversioned as $rel) {
        $name = basename($rel);
        if (!@rename($projectPath . '/' . $rel, $destAbs . '/' . $name)) {
            fail("Could not move unversioned item \"$name\" on disk.", 500);
        }
        $output[] = "A  (on disk)  " . ($destRel === '' ? $name : $destRel . '/' . $name);
    }

    return ['moved' => array_merge($versioned, $unversioned), 'output' => implode("\n", $output)];
}

/**
 * Run `svn cleanup` on $target (a repo-relative path or '.'). Plain lock-clearing
 * by default; optional flags additionally purge unversioned/ignored files (which
 * permanently deletes them) and vacuum the pristine store. Returns output text.
 */
function svn_cleanup(string $projectPath, string $target, array $opts): string {
    $args = ['cleanup'];
    if (!empty($opts['removeUnversioned'])) $args[] = '--remove-unversioned';
    if (!empty($opts['removeIgnored']))     $args[] = '--remove-ignored';
    if (!empty($opts['vacuum']))            $args[] = '--vacuum-pristines';
    $args[] = '--';
    $args[] = $target;
    $r = svn_run($args, $projectPath);
    if ($r['code'] !== 0) fail('svn cleanup failed: ' . trim($r['err']), 500);
    return trim($r['out']);
}

// --------------------------------------------------------------------- merge

/**
 * List the immediate children of a repository URL (for the branch browser).
 * Returns [['name' => str, 'kind' => 'dir'|'file', 'rev' => int|null,
 *           'author' => str, 'date' => str], ...], directories first then by name.
 */
function svn_list_url(string $projectPath, string $url): array {
    $r = svn_run(['list', '--xml', '--', $url], $projectPath);
    if ($r['code'] !== 0) fail('svn list failed: ' . trim($r['err']), 500);
    $xml = simplexml_load_string($r['out']);
    if ($xml === false) fail('Could not parse svn list output', 500);
    $out = [];
    foreach ($xml->list->entry ?? [] as $e) {
        $rev = (string)$e->commit['revision'];
        $out[] = [
            'name'   => (string)$e->name,
            'kind'   => (string)$e['kind'],          // 'dir' | 'file'
            'rev'    => ctype_digit($rev) ? (int)$rev : null,
            'author' => (string)$e->commit->author,
            'date'   => (string)$e->commit->date,
        ];
    }
    usort($out, fn($a, $b) =>
        ($a['kind'] === $b['kind']) ? strcasecmp($a['name'], $b['name'])
                                    : ($a['kind'] === 'dir' ? -1 : 1));
    return $out;
}

/**
 * Commit history for a repository URL (not a working-copy path), newest first.
 * Same shape/paging contract as svn_log_path() — $before (exclusive) pages older
 * entries. Used to pick revisions to cherry-pick from a source branch.
 */
function svn_log_url(string $projectPath, string $url, int $limit, ?int $before = null): array {
    $args = ['log', '--xml', '-l', (string)$limit];
    if ($before !== null) {
        if ($before <= 1) return [];
        $args[] = '-r';
        $args[] = ($before - 1) . ':0';
    }
    $args[] = '--';
    $args[] = $url;
    $r = svn_run($args, $projectPath);
    if ($r['code'] !== 0) fail('svn log failed: ' . trim($r['err']), 500);
    return parse_log_xml($r['out']);
}

/**
 * Revisions on $sourceUrl not yet merged into $target ('' = working-copy root),
 * with their log messages (newest first). One mergeinfo call to find the eligible
 * revision numbers, then one log call to describe them.
 * Returns [['rev','author','date','msg'], ...] (empty if nothing eligible).
 */
function svn_merge_eligible(string $projectPath, string $sourceUrl, string $target): array {
    $tgt = $target === '' ? '.' : $target;
    $r = svn_run(['mergeinfo', '--show-revs', 'eligible', '--', $sourceUrl, $tgt], $projectPath);
    if ($r['code'] !== 0) fail('svn mergeinfo failed: ' . trim($r['err']), 500);

    $revs = [];
    foreach (preg_split('/\r\n|\r|\n/', trim($r['out'])) as $line) {
        if (preg_match('/^r(\d+)/', trim($line), $m)) $revs[] = (int)$m[1];
    }
    if (!$revs) return [];

    // Describe exactly those revisions on the source (one ranged log call).
    sort($revs);
    $lo = $revs[0]; $hi = end($revs);
    $log = svn_run(['log', '--xml', '-r', "$hi:$lo", '--', $sourceUrl], $projectPath);
    if ($log['code'] !== 0) fail('svn log failed: ' . trim($log['err']), 500);
    $eligible = array_flip($revs);
    return array_values(array_filter(
        parse_log_xml($log['out']),
        fn($e) => isset($eligible[$e['rev']])
    ));
}

/** Accept-conflict strategies offered to the user (whitelist for merge actions). */
const MERGE_ACCEPT_MODES = [
    'postpone', 'mine-full', 'theirs-full', 'mine-conflict', 'theirs-conflict', 'merge', 'base',
];
/** Merge workflow modes. */
const MERGE_MODES = ['cherrypick', 'sync', 'reintegrate'];

/**
 * Assemble the `svn merge` argument array. One builder so the dry-run preview and
 * the real apply differ only by --dry-run. $revs (ints) is used by cherrypick only;
 * sync/reintegrate perform an automatic merge of the whole source (SVN 1.14 handles
 * reintegrate automatically — no deprecated --reintegrate flag). $target '' = WC root.
 */
function merge_build_args(string $mode, string $source, array $revs, string $target,
                          string $accept, string $depth, bool $recordOnly, bool $dryRun): array {
    $args = ['merge'];
    if ($mode === 'cherrypick') {
        $list = implode(',', array_map('intval', $revs));
        $args[] = '-c';
        $args[] = $list;
    }
    if ($depth !== '') { $args[] = '--depth'; $args[] = $depth; }
    if ($recordOnly)   { $args[] = '--record-only'; }
    if ($dryRun)       { $args[] = '--dry-run'; }
    $args[] = '--accept';
    $args[] = $accept;
    $args[] = '--';
    $args[] = $source;
    $args[] = $target === '' ? '.' : $target;
    return $args;
}

/**
 * Parse `svn merge` (or its --dry-run) summary output into structure:
 *   ['actions' => [['code' => 'U'|'A'|'D'|'C'|'G'|'E'|'R'|'   ', 'tree' => bool,
 *                   'path' => relpath], ...],
 *    'conflicts' => ['text' => int, 'tree' => int, 'prop' => int],
 *    'raw' => string]
 * Per svn, columns: col1 = content op, col2 = property op, col4 = tree-conflict 'C'.
 */
function parse_merge_output(string $text): array {
    $actions = [];
    $conflicts = ['text' => 0, 'tree' => 0, 'prop' => 0];
    foreach (preg_split('/\r\n|\r|\n/', $text) as $line) {
        if ($line === '') continue;
        if (preg_match('/^Summary of conflicts:/', $line)) continue;
        if (preg_match('/Text conflicts:\s*(\d+)/', $line, $m))     { $conflicts['text'] = (int)$m[1]; continue; }
        if (preg_match('/Tree conflicts:\s*(\d+)/', $line, $m))     { $conflicts['tree'] = (int)$m[1]; continue; }
        if (preg_match('/Property conflicts:\s*(\d+)/', $line, $m)) { $conflicts['prop'] = (int)$m[1]; continue; }
        // "--- Merging r5 into '.':" and similar progress headers — skip.
        if (preg_match('/^---/', $line) || preg_match('/^Merge complete/', $line)) continue;
        // Status line: up to ~4 status columns, then whitespace, then the path.
        if (preg_match('/^([ ACDGRUE][ ACDGRUEM][ C][ C])\s+(.+)$/', $line, $m)) {
            $cols = $m[1];
            $code = trim(substr($cols, 0, 1)) ?: trim(substr($cols, 1, 1)) ?: ' ';
            $tree = substr($cols, 3, 1) === 'C';
            $actions[] = ['code' => $code, 'tree' => $tree, 'path' => norm_path(trim($m[2]))];
        }
    }
    return ['actions' => $actions, 'conflicts' => $conflicts, 'raw' => trim($text)];
}

/**
 * Dry-run a merge (read-only — makes no working-copy change). Returns
 * parse_merge_output() of svn's --dry-run summary.
 */
function svn_merge_preview(string $mode, string $source, array $revs, string $target,
                           string $accept, string $depth, bool $recordOnly,
                           string $projectPath): array {
    $args = merge_build_args($mode, $source, $revs, $target, $accept, $depth, $recordOnly, true);
    $r = svn_run($args, $projectPath);
    if ($r['code'] !== 0) fail('svn merge --dry-run failed: ' . trim($r['err'] !== '' ? $r['err'] : $r['out']), 500);
    return parse_merge_output($r['out']);
}

/**
 * Perform a merge into the working copy (a state-changing op the user triggers and
 * then reviews/commits via the normal pipeline). Returns parse_merge_output().
 */
function svn_merge_apply(string $mode, string $source, array $revs, string $target,
                         string $accept, string $depth, bool $recordOnly,
                         string $projectPath): array {
    $args = merge_build_args($mode, $source, $revs, $target, $accept, $depth, $recordOnly, false);
    $r = svn_run($args, $projectPath);
    if ($r['code'] !== 0) fail('svn merge failed: ' . trim($r['err'] !== '' ? $r['err'] : $r['out']), 500);
    return parse_merge_output($r['out']);
}

/**
 * Read a directory's svn:ignore patterns ('' = working-copy root) as a list of
 * non-empty, trimmed lines. Missing property / non-dir target => empty list.
 */
function svn_ignore_get(string $projectPath, string $dirRel): array {
    $target = $dirRel === '' ? '.' : $dirRel;
    $r = svn_run(['propget', 'svn:ignore', '--', $target], $projectPath);
    if ($r['code'] !== 0) return [];
    $lines = preg_split('/\r\n|\r|\n/', rtrim($r['out'], "\r\n")) ?: [];
    return array_values(array_filter(array_map('trim', $lines), fn($p) => $p !== ''));
}

/**
 * Set a directory's svn:ignore to the given patterns (dedup'd, trimmed). An empty
 * list deletes the property. This is a working-copy property change the user then
 * commits. Returns nothing; fails loudly on error.
 */
function svn_ignore_set(string $projectPath, string $dirRel, array $patterns): void {
    $target = $dirRel === '' ? '.' : $dirRel;
    $patterns = array_values(array_unique(
        array_filter(array_map('trim', $patterns), fn($p) => $p !== '')
    ));
    $r = $patterns
        ? svn_run(['propset', 'svn:ignore', implode("\n", $patterns) . "\n", '--', $target], $projectPath)
        : svn_run(['propdel', 'svn:ignore', '--', $target], $projectPath);
    if ($r['code'] !== 0) {
        fail('svn:ignore update failed: ' . trim($r['err'] !== '' ? $r['err'] : $r['out']), 500);
    }
}

/**
 * Which of $patterns ignore a bare name — exact entries first, then fnmatch globs
 * (e.g. '*.log', 'tmp*'). svn:ignore matching is shell-glob, like SmartSVN's, so a
 * file can be hidden without its literal name appearing in the list.
 */
function svn_ignore_matches(string $name, array $patterns): array {
    return array_values(array_filter(
        $patterns,
        fn($p) => $p === $name || fnmatch($p, $name)
    ));
}

/**
 * Read a single property's value on a target ('' = working-copy root); '' if the
 * property is unset (or the target isn't versioned). Trailing EOLs trimmed.
 */
function svn_propget_one(string $projectPath, string $rel, string $name): string {
    $target = $rel === '' ? '.' : $rel;
    $r = svn_run(['propget', $name, '--', $target], $projectPath);
    if ($r['code'] !== 0) return '';
    return rtrim($r['out'], "\r\n");
}

/**
 * Bring a single property to the desired state (a pending change the user then
 * commits). '' desired = delete the property; short-circuits when already at the
 * desired value, so re-saving an unchanged dialog (and deleting an already-absent
 * property) is a no-op. Boolean props (svn:executable, svn:needs-lock) use '*' as
 * the set value. Fails loudly on error.
 */
function svn_prop_sync(string $projectPath, string $rel, string $name, string $desired): void {
    if (svn_propget_one($projectPath, $rel, $name) === $desired) return;
    $target = $rel === '' ? '.' : $rel;
    $r = $desired === ''
        ? svn_run(['propdel', $name, '--', $target], $projectPath)
        : svn_run(['propset', $name, $desired, '--', $target], $projectPath);
    if ($r['code'] !== 0) {
        fail("$name update failed: " . trim($r['err'] !== '' ? $r['err'] : $r['out']), 500);
    }
}

/**
 * Move a file or directory to the Windows Recycle Bin (recoverable) via the
 * VisualBasic FileSystem helper. Fails loudly on error.
 */
function recycle_path(string $abs): void {
    $abs = str_replace('/', '\\', $abs);
    $method = is_dir($abs) ? 'DeleteDirectory' : 'DeleteFile';
    $lit = "'" . str_replace("'", "''", $abs) . "'"; // PowerShell single-quoted literal
    $script = 'Add-Type -AssemblyName Microsoft.VisualBasic; '
        . "[Microsoft.VisualBasic.FileIO.FileSystem]::{$method}({$lit},'OnlyErrorDialogs','SendToRecycleBin')";
    $r = svn_exec(['powershell', '-NoProfile', '-NonInteractive', '-Command', $script], sys_get_temp_dir());
    if ($r['code'] !== 0) fail('Move to Recycle Bin failed: ' . trim($r['err'] !== '' ? $r['err'] : $r['out']), 500);
}

// Desktop launching (external diff tool, open, reveal) lives in lib/desktop.php —
// it's cross-platform and not SVN-specific. svn_base_tempfile() below feeds the
// {base} placeholder of a two-file diff command.

/**
 * Write a working file's pristine BASE revision to a temp file (for an external
 * two-file diff tool). The temp file keeps the original extension so the editor
 * picks the right language. Returns the temp path.
 */
function svn_base_tempfile(string $projectPath, string $rel): string {
    $r = svn_run(['cat', '--', $rel], $projectPath);   // no rev = BASE for a WC path
    if ($r['code'] !== 0) {
        fail('Could not read the base revision to diff: ' . trim($r['err']), 500);
    }
    $ext = pathinfo($rel, PATHINFO_EXTENSION);
    $tmp = tempnam(sys_get_temp_dir(), 'svnbase_');
    $named = $ext !== '' ? $tmp . '.' . $ext : $tmp;
    if ($named !== $tmp && !@rename($tmp, $named)) $named = $tmp;
    file_put_contents($named, $r['out']);
    return $named;
}

/** Permanently delete a file or directory tree from disk. */
function delete_path_forever(string $abs): void {
    if (is_link($abs) || is_file($abs)) {
        if (!@unlink($abs)) fail('Could not delete file: ' . $abs, 500);
        return;
    }
    if (is_dir($abs)) {
        foreach (scandir($abs) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') continue;
            delete_path_forever($abs . '/' . $entry);
        }
        if (!@rmdir($abs)) fail('Could not delete folder: ' . $abs, 500);
    }
}

// --------------------------------------------------------------- line endings

const EOL_MAX_FILE_BYTES = 20 * 1024 * 1024;   // skip files larger than this

/** Count CRLF / lone-LF / lone-CR in text; mixed = more than one style present. */
function eol_analyze(string $content): array {
    $crlf = substr_count($content, "\r\n");
    $lf = substr_count($content, "\n") - $crlf;   // newlines not part of a CRLF
    $cr = substr_count($content, "\r") - $crlf;    // returns not part of a CRLF
    $styles = ($crlf > 0 ? 1 : 0) + ($lf > 0 ? 1 : 0) + ($cr > 0 ? 1 : 0);
    return ['crlf' => $crlf, 'lf' => $lf, 'cr' => $cr, 'mixed' => $styles > 1];
}

/**
 * Scan the given files (a caller-supplied list — the pending new/modified files
 * under the chosen target) for mixed line endings. Returns:
 *   ['files' => [['path' => relpath, 'crlf'=>int, 'lf'=>int, 'cr'=>int], ...],
 *    'scanned' => int, 'binary' => int, 'skipped' => int]
 * Skips binary files and files over EOL_MAX_FILE_BYTES.
 */
function eol_scan(string $projectPath, array $relPaths): array {
    $mixed = [];
    $scanned = 0; $binary = 0; $skipped = 0;
    foreach ($relPaths as $rel) {
        $abs = $projectPath . '/' . $rel;
        if (!is_file($abs)) { $skipped++; continue; }
        $size = @filesize($abs);
        if ($size === false || $size > EOL_MAX_FILE_BYTES) { $skipped++; continue; }
        if (looks_binary($abs)) { $binary++; continue; }
        $content = @file_get_contents($abs);
        if ($content === false) { $skipped++; continue; }
        $scanned++;
        $a = eol_analyze($content);
        if ($a['mixed']) $mixed[] = ['path' => $rel, 'crlf' => $a['crlf'], 'lf' => $a['lf'], 'cr' => $a['cr']];
    }
    usort($mixed, fn($a, $b) => strcmp($a['path'], $b['path']));
    return ['files' => $mixed, 'scanned' => $scanned, 'binary' => $binary, 'skipped' => $skipped];
}

/**
 * Map of repo-relative path => svn:eol-style value ('native'|'CRLF'|'LF'|'CR')
 * for every file under $relTarget that has the property set. One svn call.
 */
function svn_eol_styles(string $projectPath, string $relTarget): array {
    $target = $relTarget === '' ? '.' : $relTarget;
    $r = svn_run(['propget', 'svn:eol-style', '-R', '--xml', '--', $target], $projectPath);
    if ($r['code'] !== 0) return [];
    $xml = simplexml_load_string($r['out']);
    if ($xml === false) return [];
    // propget may echo absolute paths; reduce to repo-relative to match our keys.
    $base = norm_path($projectPath) . '/';
    $map = [];
    foreach ($xml->target ?? [] as $t) {
        $val = trim((string)$t->property);
        if ($val === '') continue;
        $path = norm_path((string)$t['path']);
        if (stripos($path, $base) === 0) $path = substr($path, strlen($base));
        $map[$path] = $val;
    }
    return $map;
}

/**
 * Rewrite the given files' line endings. $style is 'lf'|'crlf'|'cr', or 'auto'
 * (per file: the file's svn:eol-style if set, otherwise its majority style).
 * $relBase scopes the one svn:eol-style lookup used by 'auto'.
 * Returns ['fixed' => [relpath...], 'failed' => [relpath...]]. Files already at
 * the target (or that can't be read/written/are binary) are reported, not touched.
 */
function eol_fix(string $projectPath, array $relPaths, string $style, string $relBase = ''): array {
    $nativeEol = strtoupper(substr(PHP_OS, 0, 3)) === 'WIN' ? "\r\n" : "\n";
    $svnMap = $style === 'auto' ? svn_eol_styles($projectPath, $relBase) : [];
    $fixed = []; $failed = [];
    foreach ($relPaths as $rel) {
        $abs = $projectPath . '/' . $rel;
        if (!is_file($abs) || looks_binary($abs)) { $failed[] = $rel; continue; }
        $content = @file_get_contents($abs);
        if ($content === false) { $failed[] = $rel; continue; }

        if ($style === 'auto') {
            $eol = match (strtolower($svnMap[$rel] ?? '')) {
                'lf' => "\n", 'crlf' => "\r\n", 'cr' => "\r", 'native' => $nativeEol,
                default => null,
            };
            if ($eol === null) {                                  // no svn:eol-style → majority wins
                $a = eol_analyze($content);
                if ($a['crlf'] >= $a['lf'] && $a['crlf'] >= $a['cr']) $eol = "\r\n";
                elseif ($a['lf'] >= $a['cr']) $eol = "\n";
                else $eol = "\r";
            }
        } else {
            $eol = $style === 'lf' ? "\n" : ($style === 'cr' ? "\r" : "\r\n");
        }

        $normalized = str_replace("\n", $eol, str_replace(["\r\n", "\r"], "\n", $content));
        if ($normalized === $content) { $fixed[] = $rel; continue; }   // already consistent
        if (@file_put_contents($abs, $normalized) === false) { $failed[] = $rel; continue; }
        $fixed[] = $rel;
    }
    return ['fixed' => $fixed, 'failed' => $failed];
}

/**
 * Classify one file's line endings into a single token for the list badge:
 * 'crlf' | 'lf' | 'cr' | 'mixed' | 'none' (no EOLs) | 'binary' | 'large'.
 */
function eol_classify(string $abs): string {
    $size = @filesize($abs);
    if ($size === false) return 'none';
    if ($size > EOL_MAX_FILE_BYTES) return 'large';
    if (looks_binary($abs)) return 'binary';
    $content = @file_get_contents($abs);
    if ($content === false) return 'none';
    $a = eol_analyze($content);
    if ($a['mixed']) return 'mixed';
    if ($a['crlf']) return 'crlf';
    if ($a['lf']) return 'lf';
    if ($a['cr']) return 'cr';
    return 'none';
}

/** Classify several files at once: ['relpath' => token, ...] (see eol_classify). */
function eol_info(string $projectPath, array $relPaths): array {
    $out = [];
    foreach ($relPaths as $rel) {
        $abs = $projectPath . '/' . $rel;
        $out[$rel] = is_file($abs) ? eol_classify($abs) : 'none';
    }
    return $out;
}

/**
 * Commit approved files. Adds unversioned ones first (with parents).
 * Returns svn commit output text.
 */
function svn_commit(string $projectPath, array $relPaths, array $statuses, string $message): string {
    // svn add for unversioned files so they can be committed
    $toAdd = [];
    foreach ($relPaths as $rel) {
        if (($statuses[$rel] ?? '') === 'unversioned') $toAdd[] = $rel;
    }
    if ($toAdd) {
        $r = svn_run(array_merge(['add', '--parents', '--'], $toAdd), $projectPath);
        if ($r['code'] !== 0) fail('svn add failed: ' . trim($r['err']), 500);
    }

    $targets = tempnam(sys_get_temp_dir(), 'svnci');
    file_put_contents($targets, implode("\n", $relPaths) . "\n");
    try {
        // --depth empty: commit exactly the listed targets, never recurse into a
        // listed directory's unlisted children.
        $r = svn_run(['commit', '--depth', 'empty', '--targets', $targets, '-m', $message], $projectPath);
    } finally {
        unlink($targets);
    }
    if ($r['code'] !== 0) fail('svn commit failed: ' . trim($r['err']) . "\n" . trim($r['out']), 500);
    return trim($r['out']);
}
