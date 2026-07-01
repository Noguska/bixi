<?php
declare(strict_types=1);

const APP_ROOT = __DIR__ . '/..';
const DATA_DIR = APP_ROOT . '/data';

function json_out($data, int $code = 200): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function fail(string $message, int $code = 400): never {
    json_out(['ok' => false, 'error' => $message], $code);
}

/** Decoded JSON request body (POST) merged over query params. */
function req(): array {
    static $req = null;
    if ($req === null) {
        $body = file_get_contents('php://input');
        $json = $body !== '' ? json_decode($body, true) : null;
        $req = array_merge($_GET, is_array($json) ? $json : []);
    }
    return $req;
}

function req_str(string $key, ?string $default = null): string {
    $v = req()[$key] ?? $default;
    if (!is_string($v)) fail("Missing parameter: $key");
    return $v;
}

function new_id(): string {
    return bin2hex(random_bytes(8));
}

/** Normalize to forward slashes, no trailing slash. */
function norm_path(string $path): string {
    $p = str_replace('\\', '/', $path);
    return rtrim($p, '/');
}

/**
 * Validate a repo-relative path: no traversal, no absolute, no drive letters.
 * Returns the normalized relative path.
 */
function safe_rel_path(string $rel): string {
    $rel = norm_path($rel);
    if ($rel === '' || $rel[0] === '/' || preg_match('#^[A-Za-z]:#', $rel)) {
        fail("Invalid path: $rel");
    }
    foreach (explode('/', $rel) as $part) {
        if ($part === '..' || $part === '') fail("Invalid path: $rel");
    }
    return $rel;
}
