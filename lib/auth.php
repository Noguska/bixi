<?php
declare(strict_types=1);

require_once __DIR__ . '/util.php';
require_once __DIR__ . '/store.php';

/*
 * SVN credential access.
 *
 * The username lives in data/auth.json as cleartext (it isn't secret). The PASSWORD is
 * never stored in cleartext — it's encrypted under the master password (see lib/master.php)
 * and, during an unlocked request, resolved into the request-scoped holder below so
 * svn_run() can feed it to svn via --password-from-stdin (never the command line).
 */

function auth_file(): string { return DATA_DIR . '/auth.json'; }

/** Stored SVN username (works for both the new and legacy file shapes), or null. */
function auth_username(): ?string {
    $d = store_read(auth_file(), []);
    $u = $d['username'] ?? null;
    return (is_string($u) && $u !== '') ? $u : null;
}

// ---- request-scoped password (set after a successful master_resolve(), this request only) ----

/** Resolve the SVN password into the per-request holder so svn_run() can use it. */
function auth_set_session_password(?string $password): void {
    $GLOBALS['__svn_session_pw'] = ($password === '' ? null : $password);
}

/** The request-scoped SVN password, or null when locked / not resolved. */
function auth_session_password(): ?string {
    return $GLOBALS['__svn_session_pw'] ?? null;
}

/** Forget the resolved password (best-effort; call once the gated action is done). */
function auth_clear_session(): void {
    $GLOBALS['__svn_session_pw'] = null;
}
