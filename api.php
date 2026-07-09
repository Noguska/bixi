<?php
declare(strict_types=1);

require_once __DIR__ . '/lib/util.php';
require_once __DIR__ . '/lib/store.php';
require_once __DIR__ . '/lib/svn.php';
require_once __DIR__ . '/lib/desktop.php';
require_once __DIR__ . '/lib/auth.php';
require_once __DIR__ . '/lib/master.php';

$action = $_GET['action'] ?? '';

// Request-scoped unlock: if the client sent a session {mtoken, mkey}, resolve the SVN
// credential for THIS request so svn_run() can use it. Opportunistic for reads; commit
// hard-requires it (see the gate in the 'commit' case). $session stays in scope for the
// switch below.
$session = ['ok' => false, 'reason' => 'no_session'];
$__rq = req();
$__mtoken = is_string($__rq['mtoken'] ?? null) ? $__rq['mtoken'] : '';
$__mkey   = is_string($__rq['mkey']   ?? null) ? $__rq['mkey']   : '';
if ($__mtoken !== '' && $__mkey !== '') {
    $session = master_resolve($__mtoken, $__mkey);
    if ($session['ok']) auth_set_session_password($session['password']);
}
master_gc_maybe();   // probabilistic sweep of expired session files

switch ($action) {

    // ----------------------------------------------------- master password / auth

    case 'master_status':
        // Everything the client needs to decide: set-up vs unlock vs ready, plus the
        // svn preflight (so the UI can surface an upgrade prompt even here).
        json_out([
            'ok'         => true,
            'configured' => master_is_configured(),
            'username'   => master_username(),
            'unlocked'   => $session['ok'],
            'svn'        => svn_preflight(),
        ]);

    case 'master_setup': {
        // First-time setup / full reconfigure: master password + SVN credential.
        // Hard cutover — replaces any legacy stored password.
        if (!svn_preflight()['ok']) {
            fail('Subversion ' . SVN_MIN_VERSION . ' or newer is required to store credentials.');
        }
        $master   = req_str('masterPassword');
        $username = trim(req_str('username'));
        $password = req_str('password');
        if ($master === '')   fail('Master password is required');
        if ($username === '') fail('SVN username is required');
        if ($password === '') fail('SVN password is required');

        // Validate the SVN credential against the first registered repo URL (network check).
        $url = '';
        foreach (projects_all() as $p) {
            if (!empty($p['url'])) { $url = $p['url']; break; }
        }
        if ($url !== '') {
            $chk = svn_check_auth($username, $password, $url);
            if (!$chk['ok']) fail($chk['error']);
        }

        master_setup($master, $username, $password);
        master_throttle_reset();
        json_out(['ok' => true, 'username' => $username]);
    }

    case 'master_unlock': {
        if (!svn_preflight()['ok']) {
            fail('Subversion ' . SVN_MIN_VERSION . ' or newer is required.');
        }
        if (($wait = master_throttle_locked()) > 0) {
            fail("Too many failed attempts. Try again in {$wait}s.", 429);
        }
        $master = req_str('masterPassword');
        if ($master === '') fail('Master password is required');

        $res = master_unlock($master);
        if (!$res['ok']) {
            if ($res['reason'] === 'bad_password') { master_throttle_fail(); fail('Incorrect master password.', 401); }
            if ($res['reason'] === 'not_configured') fail('No master password is set yet.', 409);
            fail('Unable to unlock the stored credential (the device key may be missing).', 500);
        }
        master_throttle_reset();
        json_out(['ok' => true, 'token' => $res['token'], 'key' => $res['key'], 'username' => $res['username']]);
    }

    case 'master_change': {
        if (($wait = master_throttle_locked()) > 0) {
            fail("Too many failed attempts. Try again in {$wait}s.", 429);
        }
        $old = req_str('oldPassword');
        $new = req_str('newPassword');
        if ($new === '') fail('New master password is required');

        $res = master_change($old, $new);
        if (!$res['ok']) {
            if ($res['reason'] === 'bad_password') { master_throttle_fail(); fail('Incorrect current master password.', 401); }
            if ($res['reason'] === 'not_configured') fail('No master password is set yet.', 409);
            fail('Unable to change the master password.', 500);
        }
        master_throttle_reset();
        json_out(['ok' => true]);
    }

    case 'master_lock': {
        $token = req_str('mtoken', '');
        if ($token !== '') master_lock($token);
        json_out(['ok' => true]);
    }

    case 'master_reset': {
        // Delete every auth artifact (encrypted credential, sessions, throttle, device
        // key). Not gated — enables recovery from a forgotten master password. Destructive.
        $res = master_reset();
        json_out(['ok' => true, 'removed' => $res['removed']]);
    }

    // ------------------------------------------------------------ settings

    case 'settings_get': {
        // App-wide settings + the host's launch capabilities (for the Settings UI).
        $tools = config_get('tools', []);
        json_out([
            'ok' => true,
            'os' => os_family(),
            'sapi' => php_sapi_name(),
            'launchMode' => desktop_launch_mode(),       // 'direct' | 'queue'
            'directLaunch' => config_get('direct_launch', null),  // true|false|null(auto)
            'tools' => ['diff' => is_array($tools) ? (string)($tools['diff'] ?? '') : ''],
            'defaults' => ['diff' => desktop_default_diff()],
            'workDivisor' => (int) config_get('work_performance_divisor', 0),
        ]);
    }

    case 'settings_save': {
        $patch = [];
        $r = req();
        if (isset($r['tools']) && is_array($r['tools']) && array_key_exists('diff', $r['tools'])) {
            $patch['tools'] = ['diff' => trim((string)$r['tools']['diff'])];
        }
        if (array_key_exists('directLaunch', $r)) {
            $dl = $r['directLaunch'];
            $patch['direct_launch'] = ($dl === true || $dl === 'true') ? true
                : (($dl === false || $dl === 'false') ? false : null);  // null = auto
        }
        if (array_key_exists('workDivisor', $r)) {
            $patch['work_performance_divisor'] = max(0, (int)$r['workDivisor']);
        }
        if ($patch) config_set($patch);
        json_out(['ok' => true]);
    }

    // ------------------------------------------------------------ projects

    case 'projects':
        json_out(['ok' => true, 'projects' => projects_all()]);

    case 'project_save': {
        $name = trim(req_str('name'));
        $path = norm_path(trim(req_str('path')));
        $id = req()['id'] ?? '';
        if ($name === '' || $path === '') fail('Name and path are required');
        if (!is_dir($path)) fail("Directory not found: $path");
        $info = svn_info($path); // also validates it's a working copy
        $project = project_save(['id' => $id, 'name' => $name, 'path' => $path, 'url' => $info['url']]);
        json_out(['ok' => true, 'project' => $project]);
    }

    case 'project_delete':
        project_delete(req_str('id'));
        json_out(['ok' => true]);

    case 'checkout': {
        // Check out a NEW working copy from a repo URL, then register it as a project.
        // Two client round-trips: `precheck` (local, fast — reports whether the
        // destination already exists so the client can confirm) then the real run.
        $r    = req();
        $url  = trim(req_str('url'));
        $dest = norm_path(trim(req_str('path')));
        $name = trim(req_str('name'));

        if ($url === '')  fail('Repository URL is required');
        if ($dest === '') fail('Destination path is required');
        if ($name === '') fail('Name is required');
        // Destination must be an absolute local path (no ambiguous relative dirs).
        if ($dest[0] !== '/' && !preg_match('#^[A-Za-z]:/#', $dest)) {
            fail('Destination must be an absolute path (e.g. D:\\dev\\acme or /home/me/acme).');
        }

        // Optional revision (blank = HEAD) and depth.
        $rev = null;
        $revRaw = $r['rev'] ?? '';
        if (is_int($revRaw)) {
            $rev = $revRaw;
        } elseif (is_string($revRaw) && $revRaw !== '') {
            if (!ctype_digit($revRaw)) fail('Revision must be a whole number.');
            $rev = (int)$revRaw;
        }
        $depth = is_string($r['depth'] ?? null) ? $r['depth'] : 'infinity';
        if (!isset(['infinity' => 1, 'immediates' => 1, 'files' => 1, 'empty' => 1][$depth])) {
            fail('Invalid depth.');
        }

        // Round 1: local-only existence probe so the client can confirm before we
        // create anything or hit the network.
        if (!empty($r['precheck'])) {
            json_out([
                'ok'     => true,
                'exists' => is_dir($dest),
                'isFile' => is_file($dest),
                'isWc'   => is_dir($dest . '/.svn'),
            ]);
        }
        if (is_file($dest)) fail('Destination is a file, not a folder.');

        // Auth/URL preflight: a fast read-only round-trip. For a private repo with no
        // unlocked session, surface needMaster so the client prompts and retries.
        $pre = svn_url_info($url);
        if ($pre['code'] !== 0) {
            $err = trim($pre['err']);
            $isAuth = stripos($err, 'E170001') !== false || stripos($err, 'E215004') !== false
                   || stripos($err, 'authoriz') !== false || stripos($err, 'authentic') !== false;
            if ($isAuth && !$session['ok']) {
                json_out(['ok' => false, 'needMaster' => true,
                          'configured' => master_is_configured(), 'reason' => $session['reason']]);
            }
            fail($isAuth
                ? 'SVN authentication failed — check the saved username and password.'
                : ('Cannot reach that repository URL: ' . ($err !== '' ? $err : 'svn exited with code ' . $pre['code'])));
        }

        // Create the destination (and any missing parents) if it doesn't exist.
        if (!is_dir($dest) && !@mkdir($dest, 0777, true) && !is_dir($dest)) {
            fail('Could not create destination folder: ' . $dest);
        }

        @set_time_limit(0);   // a full checkout can run for minutes; svn_exec never times out

        $co = svn_checkout($url, $dest, $rev, $depth);
        if ($co['code'] !== 0) {
            fail('Checkout failed: ' . (trim($co['err']) !== '' ? trim($co['err']) : 'svn exited with code ' . $co['code']), 500);
        }

        // Register the freshly checked-out working copy (validates it's a WC via svn_info).
        $info = svn_info($dest);
        $project = project_save(['name' => $name, 'path' => $dest, 'url' => $info['url']]);
        json_out(['ok' => true, 'project' => $project]);
    }

    // -------------------------------------------------------------- status

    case 'status': {
        $project = project_get(req_str('id'));
        $rootRevision = (int)svn_info($project['path'])['revision'];
        $files = svn_status($project['path'], !empty(req()['includeIgnored']), !empty(req()['includeUnmodified']));

        // Purge reviews no longer needed (committed/reverted) or stale (file
        // changed since review). Piggybacks on the status list — no extra svn calls.
        $pending = [];
        foreach ($files as $f) $pending[$f['path']] = $f['status'];
        [$reviews, $pruned] = reviews_purge($project['id'], $project['path'], $pending);

        foreach ($files as &$f) {
            $entry = $reviews['entries'][$f['path']] ?? null;
            $f['review'] = $entry ? $entry['status'] : null;
            $f['notes'] = $entry['notes'] ?? null;
        }

        json_out([
            'ok' => true,
            'project' => $project,
            'rootRevision' => $rootRevision,
            'files' => $files,
            'pruned' => $pruned,
            'generated' => gmdate('c'),
        ]);
    }

    // ------------------------------------------------- commit stats (async)

    case 'commit_stats': {
        // Perf-bar data, split out of `status` because a stale cache makes it run
        // `svn log` against the repository — the only network call in the project
        // load. Fetched out of band so a slow/unreachable repo host can never
        // block the file list or the directory tree.
        $project = project_get(req_str('id'));
        $rootRevision = (int)svn_info($project['path'])['revision'];
        $stats = commit_stats($project['id'], $project['path'], $rootRevision);
        // Performance-bar scale: the bar is full (green) at a 1/divisor commit share.
        // Unset or <=1 means "don't show the bar" (the client hides it).
        $stats['divisor'] = (int) config_get('work_performance_divisor', 0);
        json_out(['ok' => true, 'commitStats' => $stats]);
    }

    // ----------------------------------------------------- directory tree (async)

    case 'dirs': {
        // Every working-copy directory (incl. change-free ones) for the nav tree.
        // Loaded separately from `status` so its full-tree scan never blocks the
        // initial file-list render. Honors the show-ignored toggle.
        $project = project_get(req_str('id'));
        json_out(['ok' => true, 'dirs' => wc_dirs($project['path'], !empty(req()['includeIgnored']))]);
    }

    // ---------------------------------------------------------------- diff

    case 'diff': {
        $project = project_get(req_str('id'));
        $rel = safe_rel_path(req_str('path'));
        $status = req_str('status', 'modified');
        json_out(['ok' => true] + svn_diff($project['path'], $rel, $status));
    }

    // ------------------------------------------------- external (Tortoise) diff

    case 'extdiff': {
        $project = project_get(req_str('id'));
        $rel = safe_rel_path(req_str('path'));
        desktop_diff($project['path'], $rel);
        json_out(['ok' => true]);
    }

    // ----------------------------------------------- open / reveal on desktop

    case 'open_path': {
        $project = project_get(req_str('id'));
        $rel = safe_rel_path(req_str('path'));
        desktop_open($project['path'] . '/' . $rel);
        json_out(['ok' => true]);
    }

    case 'reveal': {
        $project = project_get(req_str('id'));
        $rel = req_str('path', '');                // '' = working-copy root
        $target = $rel === '' ? '' : safe_rel_path($rel);
        desktop_reveal($project['path'] . ($target === '' ? '' : '/' . $target));
        json_out(['ok' => true]);
    }

    // ------------------------------------------------------------- history

    case 'log': {
        $project = project_get(req_str('id'));
        $rel = req_str('path', '');
        $target = $rel === '' ? '' : safe_rel_path($rel);
        $limit = max(1, min(500, (int)(req()['limit'] ?? 100)));
        $before = isset(req()['before']) ? (int)req()['before'] : null;
        json_out([
            'ok' => true,
            'project' => ['id' => $project['id'], 'name' => $project['name'], 'path' => $project['path']],
            'entries' => svn_log_path($project['path'], $target, $limit, $before),
            'limit' => $limit,
        ]);
    }

    case 'revdiff': {
        $project = project_get(req_str('id'));
        $rel = req_str('path', '');
        $target = $rel === '' ? '' : safe_rel_path($rel);
        $rev = (int)(req()['rev'] ?? 0);
        if ($rev < 1) fail('Invalid revision');
        json_out(['ok' => true, 'files' => svn_diff_rev($project['path'], $target, $rev)]);
    }

    // -------------------------------------------------------------- review

    case 'review': {
        $project = project_get(req_str('id'));
        $rel = safe_rel_path(req_str('path'));
        $verdict = req_str('verdict'); // approved | rejected | clear
        $notes = trim(req_str('notes', ''));
        if (!in_array($verdict, ['approved', 'rejected', 'clear'], true)) fail('Invalid verdict');

        $data = reviews_load($project['id']);
        if ($verdict === 'clear') {
            unset($data['entries'][$rel]);
        } else {
            $data['entries'][$rel] = [
                'status' => $verdict,
                'notes' => $verdict === 'rejected' ? $notes : null,
                'hash' => review_hash($project['path'] . '/' . $rel),
                'svnStatus' => req_str('svnStatus', ''),
                'when' => gmdate('c'),
            ];
        }
        reviews_save($project['id'], $data);
        json_out(['ok' => true]);
    }

    // ------------------------------------------------------ update / revert

    case 'update_check': {
        // Read-only: is the repo ahead of this working copy? Compares the WC base
        // revision to the repository HEAD (one network round-trip via -r HEAD).
        $project = project_get(req_str('id'));
        $local = (int)svn_info($project['path'])['revision'];
        $head  = svn_remote_revision($project['path']);
        // Local-only `svn status` (one call, no network) for the pending-change
        // count shown on the dashboard card — same total the project view reports.
        $pendingCount = count(svn_status($project['path']));
        json_out([
            'ok' => true,
            'localRevision' => $local,
            'headRevision' => $head,
            'updateAvailable' => $head !== null && $head > $local,
            'pendingCount' => $pendingCount,
        ]);
    }

    case 'update': {
        $project = project_get(req_str('id'));
        $rel = req_str('path', '');               // '' = whole working copy
        $target = $rel === '' ? '.' : safe_rel_path($rel);
        $output = svn_update($project['path'], $target);
        json_out(['ok' => true, 'output' => $output !== '' ? $output : 'Already up to date.']);
    }

    case 'revert': {
        $project = project_get(req_str('id'));
        $rel = req_str('path', '');               // '' = whole working copy
        $target = $rel === '' ? '.' : safe_rel_path($rel);
        $output = svn_revert($project['path'], $target);

        // Drop review entries for anything that's no longer pending after the revert.
        $pendingNow = [];
        foreach (svn_status($project['path']) as $f) $pendingNow[$f['path']] = $f['status'];
        reviews_purge($project['id'], $project['path'], $pendingNow);

        json_out(['ok' => true, 'output' => $output !== '' ? $output : 'Reverted.']);
    }

    // ----------------------------------------------------- add / delete / cleanup

    case 'add': {
        $project = project_get(req_str('id'));
        $rel = safe_rel_path(req_str('path'));
        // recursive defaults to true (svn's own default); the folder context menu
        // sends recursive=false for an "Add — This Directory Only" (--depth=empty).
        $recursive = !array_key_exists('recursive', req()) || !empty(req()['recursive']);
        $output = svn_add($project['path'], $rel, $recursive);
        json_out(['ok' => true, 'output' => $output !== '' ? $output : 'Added.']);
    }

    case 'delete': {
        $project = project_get(req_str('id'));
        $rel = safe_rel_path(req_str('path'));
        $mode = req_str('mode');                  // 'svn' | 'trash' | 'forever'
        $status = req_str('status', '');          // svn status of the target
        $ignore = !empty(req()['ignore']);        // also add the name to parent svn:ignore
        if (!in_array($mode, ['svn', 'trash', 'forever'], true)) fail('Invalid delete mode');
        $abs = $project['path'] . '/' . $rel;
        $versioned = $status !== 'unversioned' && $status !== 'ignored';

        // 'svn' (schedule deletion, keep the working file) only makes sense for
        // versioned items — there's nothing for SVN to schedule otherwise.
        if ($mode === 'svn' && !$versioned) fail('SVN Delete applies only to versioned items.');

        // Optionally add the item's name to its parent directory's svn:ignore. Done
        // first so a failure here (e.g. an unversioned parent) aborts before anything
        // is deleted; the rule takes effect once the deletion is committed.
        if ($ignore) {
            $name = basename($rel);
            $parent = strpos($rel, '/') !== false ? substr($rel, 0, strrpos($rel, '/')) : '';
            $patterns = svn_ignore_get($project['path'], $parent);
            if (!in_array($name, $patterns, true)) {
                $patterns[] = $name;
                svn_ignore_set($project['path'], $parent, $patterns);
            }
        }

        if (!$versioned) {
            // Not tracked by SVN — just remove the file from disk.
            if ($mode === 'trash') recycle_path($abs);
            else delete_path_forever($abs);            // 'forever' ('svn' rejected above)
        } else {
            // Versioned — schedule the deletion so it shows as 'deleted' (committable).
            if ($mode === 'svn') {
                svn_delete($project['path'], $rel, true);  // --keep-local; file stays on disk
            } else if ($mode === 'trash') {
                svn_delete($project['path'], $rel, true);  // --keep-local
                recycle_path($abs);                        // recoverable copy in the bin
            } else {
                svn_delete($project['path'], $rel, false); // --force removes working file
            }
        }

        // Drop review entries for anything no longer pending after the delete.
        $pendingNow = [];
        foreach (svn_status($project['path']) as $f) $pendingNow[$f['path']] = $f['status'];
        reviews_purge($project['id'], $project['path'], $pendingNow);

        json_out(['ok' => true]);
    }

    // ----------------------------------------------------------------- move

    case 'move': {
        // Move one or more pending/working-copy items into a destination folder.
        $project = project_get(req_str('id'));
        $paths = req()['paths'] ?? [];
        if (!is_array($paths) || !$paths) fail('No items to move');
        $destRaw = req_str('dest', '');               // '' = working-copy root
        $dest = $destRaw === '' ? '' : safe_rel_path($destRaw);

        // Map current statuses so svn_move knows which sources are versioned.
        // --no-ignore so ignored items are classified too (disk-move, not svn move).
        $pending = [];
        foreach (svn_status($project['path'], true) as $f) $pending[$f['path']] = $f['status'];

        $sources = [];
        foreach ($paths as $p) {
            $rel = safe_rel_path((string)$p);
            $sources[] = ['rel' => $rel, 'status' => $pending[$rel] ?? ''];
        }
        $result = svn_move($project['path'], $sources, $dest);

        // Refresh + purge like the other write ops (moved-from paths now show as
        // deleted, moved-to as added — re-sync the review set against reality).
        $pendingNow = [];
        foreach (svn_status($project['path']) as $f) $pendingNow[$f['path']] = $f['status'];
        reviews_purge($project['id'], $project['path'], $pendingNow);

        json_out(['ok' => true] + $result);
    }

    // ------------------------------------------------------------ line endings

    case 'eol_scan': {
        $project = project_get(req_str('id'));
        $paths = req()['paths'] ?? [];             // pending new/modified files to check
        if (!is_array($paths)) $paths = [];
        $rels = array_map(fn($p) => safe_rel_path((string)$p), $paths);
        json_out(['ok' => true] + eol_scan($project['path'], $rels));
    }

    case 'eol_info': {
        $project = project_get(req_str('id'));
        $paths = req()['paths'] ?? [];
        if (!is_array($paths)) $paths = [];
        $rels = array_map(fn($p) => safe_rel_path((string)$p), $paths);
        json_out(['ok' => true, 'eol' => eol_info($project['path'], $rels)]);
    }

    case 'eol_fix': {
        $project = project_get(req_str('id'));
        $paths = req()['paths'] ?? [];
        if (!is_array($paths) || !$paths) fail('No files given');
        $style = req_str('style');                 // auto | lf | crlf | cr
        if (!in_array($style, ['auto', 'lf', 'crlf', 'cr'], true)) fail('Invalid line-ending style');
        $base = req_str('base', '');               // scan target, scopes auto's svn:eol-style lookup
        $baseRel = $base === '' ? '' : safe_rel_path($base);
        $rels = array_map(fn($p) => safe_rel_path((string)$p), $paths);
        json_out(['ok' => true] + eol_fix($project['path'], $rels, $style, $baseRel));
    }

    // -------------------------------------------------- hide / unhide (svn:ignore)

    case 'hide': {
        // Add a file's name to its parent directory's svn:ignore property.
        $project = project_get(req_str('id'));
        $rel = safe_rel_path(req_str('path'));
        $name = basename($rel);
        $parent = strpos($rel, '/') !== false ? substr($rel, 0, strrpos($rel, '/')) : '';
        $patterns = svn_ignore_get($project['path'], $parent);
        if (!in_array($name, $patterns, true)) $patterns[] = $name;
        svn_ignore_set($project['path'], $parent, $patterns);
        json_out(['ok' => true]);
    }

    case 'unhide': {
        // Stop ignoring a file. An exact-name rule is dropped silently; when only a
        // glob matches (e.g. *.log), we report it back so the client can confirm
        // removing the pattern (which un-hides everything else it matched too), then
        // re-call with an explicit `remove` list — mirrors SmartSVN's behaviour.
        $project = project_get(req_str('id'));
        $rel = safe_rel_path(req_str('path'));
        $name = basename($rel);
        $parent = strpos($rel, '/') !== false ? substr($rel, 0, strrpos($rel, '/')) : '';
        $patterns = svn_ignore_get($project['path'], $parent);

        $remove = req()['remove'] ?? null;          // confirmed pattern removal
        if (is_array($remove)) {
            $next = array_values(array_filter($patterns, fn($p) => !in_array($p, $remove, true)));
            svn_ignore_set($project['path'], $parent, $next);
            json_out(['ok' => true]);
        }

        if (in_array($name, $patterns, true)) {     // exact rule — just drop it
            $next = array_values(array_filter($patterns, fn($p) => $p !== $name));
            svn_ignore_set($project['path'], $parent, $next);
            json_out(['ok' => true]);
        }

        $globs = svn_ignore_matches($name, $patterns);  // exact already handled above
        if (!$globs) fail("\"$name\" isn't ignored here — no svn:ignore rule matches it.");
        json_out(['ok' => true, 'confirm' => true, 'patterns' => array_values($globs)]);
    }

    case 'get_ignore': {
        // Current svn:ignore patterns for a directory ('' = working-copy root).
        $project = project_get(req_str('id'));
        $rel = req_str('path', '');
        $dir = $rel === '' ? '' : safe_rel_path($rel);
        json_out(['ok' => true, 'value' => implode("\n", svn_ignore_get($project['path'], $dir))]);
    }

    case 'set_ignore': {
        // Replace a directory's svn:ignore with the edited rule list.
        $project = project_get(req_str('id'));
        $rel = req_str('path', '');
        $dir = $rel === '' ? '' : safe_rel_path($rel);
        $patterns = preg_split('/\r\n|\r|\n/', req_str('value', '')) ?: [];
        svn_ignore_set($project['path'], $dir, $patterns);
        json_out(['ok' => true]);
    }

    // ------------------------------------------------ SVN properties editor

    case 'props_get': {
        // Current values of the curated, well-known svn properties on a target
        // ('' = working-copy root). Booleans report presence; ignore is multi-line.
        $project = project_get(req_str('id'));
        $rel = req_str('path', '');
        $target = $rel === '' ? '' : safe_rel_path($rel);
        json_out(['ok' => true, 'props' => [
            'eol-style'  => svn_propget_one($project['path'], $target, 'svn:eol-style'),
            'mime-type'  => svn_propget_one($project['path'], $target, 'svn:mime-type'),
            'keywords'   => svn_propget_one($project['path'], $target, 'svn:keywords'),
            'executable' => svn_propget_one($project['path'], $target, 'svn:executable') !== '',
            'needs-lock' => svn_propget_one($project['path'], $target, 'svn:needs-lock') !== '',
            'ignore'     => implode("\n", svn_ignore_get($project['path'], $target)),
        ]]);
    }

    case 'props_save': {
        // Apply edited curated properties (a pending change the user then commits).
        // Per-property propset/propdel — unknown/custom props on the item are left
        // untouched. Unchanged values are skipped (see svn_prop_sync).
        $project = project_get(req_str('id'));
        $rel = req_str('path', '');
        $target = $rel === '' ? '' : safe_rel_path($rel);
        $p = req()['props'] ?? [];
        if (!is_array($p)) fail('Missing props');

        foreach (['eol-style', 'mime-type', 'keywords'] as $k) {
            if (array_key_exists($k, $p)) {
                svn_prop_sync($project['path'], $target, "svn:$k", trim((string)$p[$k]));
            }
        }
        foreach (['executable', 'needs-lock'] as $k) {
            if (array_key_exists($k, $p)) {
                svn_prop_sync($project['path'], $target, "svn:$k", !empty($p[$k]) ? '*' : '');
            }
        }
        if (array_key_exists('ignore', $p)) {   // dirs only (client gates this)
            $patterns = preg_split('/\r\n|\r|\n/', (string)$p['ignore']) ?: [];
            $cur = svn_ignore_get($project['path'], $target);
            $want = array_values(array_unique(array_filter(array_map('trim', $patterns), fn($x) => $x !== '')));
            if ($want !== $cur) svn_ignore_set($project['path'], $target, $patterns);
        }
        json_out(['ok' => true]);
    }

    case 'cleanup': {
        $project = project_get(req_str('id'));
        $rel = req_str('path', '');               // '' = whole working copy
        $target = $rel === '' ? '.' : safe_rel_path($rel);
        $opts = req()['opts'] ?? [];
        if (!is_array($opts)) $opts = [];
        $output = svn_cleanup($project['path'], $target, [
            'removeUnversioned' => !empty($opts['removeUnversioned']),
            'removeIgnored'     => !empty($opts['removeIgnored']),
            'vacuum'            => !empty($opts['vacuum']),
        ]);
        json_out(['ok' => true, 'output' => $output !== '' ? $output : 'Cleanup complete.']);
    }

    // --------------------------------------------------------------- merge

    case 'merge_list': {
        // Browse a repository URL's children for the branch picker. Defaults to the
        // repo root so the user can drill into /branches, /trunk, /tags.
        $project = project_get(req_str('id'));
        $url = trim(req_str('url', ''));
        if ($url === '') $url = svn_info($project['path'])['root'];
        json_out(['ok' => true, 'url' => $url, 'entries' => svn_list_url($project['path'], $url)]);
    }

    case 'merge_log': {
        // Paged commit history of a source URL (cherry-pick revision picker).
        $project = project_get(req_str('id'));
        $url = trim(req_str('url'));
        if ($url === '') fail('Source URL is required');
        $limit = max(1, min(500, (int)(req()['limit'] ?? 100)));
        $before = isset(req()['before']) ? (int)req()['before'] : null;
        json_out([
            'ok' => true,
            'entries' => svn_log_url($project['path'], $url, $limit, $before),
            'limit' => $limit,
        ]);
    }

    case 'merge_eligible': {
        // Revisions on the source not yet merged into the target (sync preview).
        $project = project_get(req_str('id'));
        $source = trim(req_str('source'));
        if ($source === '') fail('Source URL is required');
        $rel = req_str('target', '');
        $target = $rel === '' ? '' : safe_rel_path($rel);
        json_out(['ok' => true, 'entries' => svn_merge_eligible($project['path'], $source, $target)]);
    }

    case 'merge_preview':
    case 'merge_apply': {
        $project = project_get(req_str('id'));
        $mode = req_str('mode');
        if (!in_array($mode, MERGE_MODES, true)) fail('Invalid merge mode');
        $source = trim(req_str('source'));
        if ($source === '') fail('Source URL is required');
        $accept = req_str('accept', 'postpone');
        if (!in_array($accept, MERGE_ACCEPT_MODES, true)) fail('Invalid accept strategy');
        $depth = req_str('depth', '');
        if ($depth !== '' && !in_array($depth, ['empty', 'files', 'immediates', 'infinity'], true)) {
            fail('Invalid depth');
        }
        $recordOnly = !empty(req()['recordOnly']);
        $rel = req_str('target', '');
        $target = $rel === '' ? '' : safe_rel_path($rel);

        $revs = [];
        if ($mode === 'cherrypick') {
            $raw = req()['revs'] ?? [];
            if (!is_array($raw)) $raw = [];
            foreach ($raw as $v) { if (ctype_digit((string)$v) || (int)$v > 0) $revs[] = (int)$v; }
            $revs = array_values(array_unique(array_filter($revs, fn($n) => $n > 0)));
            if (!$revs) fail('Select at least one revision to cherry-pick');
        }

        if ($action === 'merge_preview') {
            $result = svn_merge_preview($mode, $source, $revs, $target, $accept, $depth, $recordOnly, $project['path']);
            json_out(['ok' => true] + $result);
        }

        // merge_apply — the write op. Mirror the commit/revert post-op: refresh the
        // pending set and purge stale review entries so merged files show for review.
        $result = svn_merge_apply($mode, $source, $revs, $target, $accept, $depth, $recordOnly, $project['path']);
        $pendingNow = [];
        foreach (svn_status($project['path']) as $f) $pendingNow[$f['path']] = $f['status'];
        reviews_purge($project['id'], $project['path'], $pendingNow);
        json_out(['ok' => true] + $result);
    }

    // -------------------------------------------------------------- commit

    case 'commit': {
        // Commit is the only action that writes to the server, so it's the one gated on
        // an unlocked session. needMaster tells the client to prompt for the master
        // password (or run first-time setup if not configured), then retry.
        if (!$session['ok']) {
            json_out(['ok' => false, 'needMaster' => true,
                      'configured' => master_is_configured(),
                      'reason' => $session['reason']], 200);
        }
        $project = project_get(req_str('id'));
        $message = trim(req_str('message'));
        if ($message === '') fail('Commit message is required');

        $explicit = req()['paths'] ?? null;   // optional: commit exactly these (multi-select dialog)
        $paths = [];
        $statuses = [];
        $skipped = [];

        if (is_array($explicit)) {
            // Commit an explicit selection, validated against the current pending set.
            $pending = [];
            foreach (svn_status($project['path']) as $f) $pending[$f['path']] = $f['status'];
            foreach ($explicit as $p) {
                $rel = safe_rel_path((string)$p);
                if (!isset($pending[$rel])) { $skipped[] = $rel; continue; } // no longer pending
                $paths[] = $rel;
                $statuses[$rel] = $pending[$rel];
            }
            if (!$paths) fail('Nothing to commit: none of the selected files are still pending.');
        } else {
            // Commit exactly the currently-approved, still-unchanged files.
            $data = reviews_load($project['id']);
            foreach ($data['entries'] as $rel => $entry) {
                if ($entry['status'] !== 'approved') continue;
                if ($entry['hash'] !== review_hash($project['path'] . '/' . $rel)) {
                    $skipped[] = $rel; // changed since approval — do not commit
                    continue;
                }
                $paths[] = $rel;
                $statuses[$rel] = $entry['svnStatus'];
            }
            if (!$paths) fail('Nothing to commit: no valid approved files' .
                ($skipped ? ' (' . count($skipped) . ' changed since approval)' : ''));
        }

        $output = svn_commit($project['path'], $paths, $statuses, $message);
        auth_clear_session();   // discard the resolved password as soon as we're done with it

        // Purge committed entries (and anything else no longer pending).
        $pendingNow = [];
        foreach (svn_status($project['path']) as $f) $pendingNow[$f['path']] = $f['status'];
        reviews_purge($project['id'], $project['path'], $pendingNow);

        json_out(['ok' => true, 'committed' => $paths, 'skipped' => $skipped, 'output' => $output]);
    }

    default:
        fail("Unknown action: $action", 404);
}
