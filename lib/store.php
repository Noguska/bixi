<?php
declare(strict_types=1);

require_once __DIR__ . '/util.php';

function store_read(string $file, $default) {
    if (!is_file($file)) return $default;
    $raw = file_get_contents($file);
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $default;
}

function store_write(string $file, $data): void {
    $dir = dirname($file);
    if (!is_dir($dir)) mkdir($dir, 0775, true);
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if (file_put_contents($file, $json, LOCK_EX) === false) {
        fail("Failed to write $file", 500);
    }
}

// ------------------------------------------------------------- app config
//
// data/config.json — global (not per-project) app settings, e.g.
// { "work_performance_divisor": 2 }

function config_file(): string { return DATA_DIR . '/config.json'; }

function config_all(): array {
    return store_read(config_file(), []);
}

/** One config value, or $default when it isn't set. */
function config_get(string $key, $default = null) {
    $cfg = config_all();
    return array_key_exists($key, $cfg) ? $cfg[$key] : $default;
}

/** Merge $patch into config.json (shallow, top-level keys). Returns the new config. */
function config_set(array $patch): array {
    $cfg = config_all();
    foreach ($patch as $k => $v) $cfg[$k] = $v;
    store_write(config_file(), $cfg);
    return $cfg;
}

// ---------------------------------------------------------------- projects

function projects_file(): string { return DATA_DIR . '/projects.json'; }

function projects_all(): array {
    return store_read(projects_file(), []);
}

function project_get(string $id): array {
    foreach (projects_all() as $p) {
        if ($p['id'] === $id) return $p;
    }
    fail("Unknown project: $id", 404);
}

function project_save(array $project): array {
    $projects = projects_all();
    if (empty($project['id'])) {
        $project['id'] = new_id();
        $projects[] = $project;
    } else {
        $found = false;
        foreach ($projects as $i => $p) {
            if ($p['id'] === $project['id']) { $projects[$i] = $project; $found = true; break; }
        }
        if (!$found) fail("Unknown project: {$project['id']}", 404);
    }
    store_write(projects_file(), $projects);
    return $project;
}

function project_delete(string $id): void {
    $projects = array_values(array_filter(projects_all(), fn($p) => $p['id'] !== $id));
    store_write(projects_file(), $projects);
    foreach ([reviews_file($id), commits_file($id)] as $f) {
        if (is_file($f)) unlink($f);
    }
}

// ----------------------------------------------------------- commit log cache
//
// data/commits/<projectId>.json — a running log of the last 50 commit
// revisions to author names, used for the performance bar. Refreshed only when
// the working-copy revision advances (see commit_stats()).
// {
//   "revision": 12345,                              // base revision the log was taken at
//   "commits": [ { "rev": 12345, "author": "..." }, ... ],  // newest first, up to 50
//   "when": "2026-06-11T12:00:00Z"
// }

function commits_file(string $projectId): string {
    return DATA_DIR . '/commits/' . preg_replace('/[^a-f0-9]/', '', $projectId) . '.json';
}

function commits_load(string $projectId): array {
    $data = store_read(commits_file($projectId), []);
    return [
        'revision' => isset($data['revision']) ? (int)$data['revision'] : null,
        'commits' => is_array($data['commits'] ?? null) ? $data['commits'] : [],
        'when' => $data['when'] ?? null,
    ];
}

function commits_save(string $projectId, array $data): void {
    store_write(commits_file($projectId), $data);
}

// ---------------------------------------------------------------- reviews
//
// data/reviews/<projectId>.json:
// {
//   "meta": { "lastPurge": "2026-06-11T12:00:00Z" },
//   "entries": {
//     "rel/path.php": { "status": "approved"|"rejected", "notes": "...",
//                       "hash": "<md5|deleted>", "svnStatus": "modified",
//                       "when": "2026-06-11T12:00:00Z" }
//   }
// }

function reviews_file(string $projectId): string {
    return DATA_DIR . '/reviews/' . preg_replace('/[^a-f0-9]/', '', $projectId) . '.json';
}

function reviews_load(string $projectId): array {
    $data = store_read(reviews_file($projectId), []);
    return [
        'meta' => $data['meta'] ?? [],
        'entries' => $data['entries'] ?? [],
    ];
}

function reviews_save(string $projectId, array $data): void {
    store_write(reviews_file($projectId), $data);
}

/** Current content hash used to detect changes since review time. */
function review_hash(string $absFile): string {
    if (!file_exists($absFile)) return 'deleted';
    if (is_dir($absFile)) return 'dir';
    $md5 = @md5_file($absFile);
    return $md5 === false ? 'unreadable' : $md5;
}

/**
 * Purge review entries that are stale (file content changed since review)
 * or no longer needed (path is no longer SVN-pending). $pending is a map of
 * relpath => svn status for everything currently pending.
 * Returns [data, prunedCount].
 */
function reviews_purge(string $projectId, string $projectPath, array $pending): array {
    $data = reviews_load($projectId);
    $pruned = 0;
    foreach ($data['entries'] as $rel => $entry) {
        $drop = false;
        if (!isset($pending[$rel])) {
            $drop = true; // committed, reverted, or otherwise no longer pending
        } elseif ($entry['hash'] !== review_hash($projectPath . '/' . $rel)) {
            $drop = true; // file changed since it was reviewed
        }
        if ($drop) { unset($data['entries'][$rel]); $pruned++; }
    }
    $data['meta']['lastPurge'] = gmdate('c');
    reviews_save($projectId, $data);
    return [$data, $pruned];
}
