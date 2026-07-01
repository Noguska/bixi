<?php
declare(strict_types=1);

require_once __DIR__ . '/util.php';
require_once __DIR__ . '/store.php';
require_once __DIR__ . '/crypto.php';

/*
 * Master-password lifecycle (see CLAUDE-todo.md item 20).
 *
 * At rest — data/auth.json (new format; the old base64 `password` is wiped on setup):
 *   { username, kdf:{algo,..}, salt(b64,16B), verifier(argon2id), secret(AEAD), when }
 *   - secret = AES-256-GCM( KEK, svnpw ), AAD = "user=<username>|v1"
 *   - KEK    = crypto_kek(masterpw, salt, kdf) — peppered with the out-of-webroot device key
 *
 * Active session — data/sessions/<token>.json (token = random hex filename; K never on disk):
 *   { encS, encSvn, user, created, expires, hardExpires }
 *   - S      = 2048-byte data-encryption key (DEK), minted at unlock
 *   - encSvn = AES-256-GCM( HKDF(S), svnpw ), AAD = "user=<username>|v1"
 *   - encS   = AES-256-GCM( HKDF(K), S ) — K (32B) is handed to the browser, not stored
 *
 * Per request the browser sends {token, K}; the server unwraps S with K, then svnpw with
 * S. The session file alone (no K) is useless; data/ alone (no device key) is useless.
 */

const MASTER_AAD_VERSION = 'v1';
const MASTER_IDLE_TTL    = 1800;    // 30 min sliding idle, refreshed on each use
const MASTER_HARD_TTL    = 43200;   // 12 h absolute cap regardless of activity

function master_auth_file(): string { return DATA_DIR . '/auth.json'; }
function master_sessions_dir(): string { return DATA_DIR . '/sessions'; }

function master_load(): array { return store_read(master_auth_file(), []); }

/** True once a master password + encrypted credential have been set up. */
function master_is_configured(): bool {
    $d = master_load();
    return isset($d['verifier'], $d['secret'], $d['salt']) && is_string($d['verifier']) && $d['verifier'] !== '';
}

/** The stored SVN username (cleartext; not secret), or null. */
function master_username(): ?string {
    $u = master_load()['username'] ?? null;
    return (is_string($u) && $u !== '') ? $u : null;
}

/** AAD that binds a ciphertext to its account + format version. */
function master_aad(string $username): string {
    return 'user=' . $username . '|' . MASTER_AAD_VERSION;
}

// ----------------------------------------------------------------- setup / change

/**
 * Configure (or re-key) the master password and store the SVN credential encrypted.
 * Hard cutover: writes the new format and drops any legacy `password` field.
 */
function master_setup(string $masterpw, string $username, string $svnpw): void {
    $username = trim($username);
    if ($masterpw === '') fail('Master password is required');
    if ($username === '') fail('SVN username is required');
    if ($svnpw === '')   fail('SVN password is required');

    device_key();                              // ensure the pepper exists before we depend on it
    $params = crypto_kdf_default_params();
    $salt   = crypto_salt();
    $kek    = crypto_kek($masterpw, $salt, $params);

    store_write(master_auth_file(), [
        'username' => $username,
        'kdf'      => $params,
        'salt'     => base64_encode($salt),
        'verifier' => crypto_verifier_make($masterpw),
        'secret'   => crypto_encrypt($kek, $svnpw, master_aad($username)),
        'when'     => gmdate('c'),
        // NOTE: no `password` field — the legacy base64 credential is intentionally gone.
    ]);
}

/**
 * Change the master password, preserving the stored SVN credential. Verifies the old
 * password, re-encrypts under a fresh salt/verifier, and invalidates all live sessions.
 * Returns ['ok'=>true] or ['ok'=>false, 'reason'=>'not_configured'|'bad_password'|'decrypt_failed'].
 */
function master_change(string $oldpw, string $newpw): array {
    if ($newpw === '') fail('New master password is required');
    if (!master_is_configured()) return ['ok' => false, 'reason' => 'not_configured'];

    $d = master_load();
    if (!crypto_verifier_check($oldpw, $d['verifier'])) return ['ok' => false, 'reason' => 'bad_password'];

    $kek = crypto_kek($oldpw, base64_decode($d['salt']), $d['kdf'] ?? []);
    $svnpw = crypto_decrypt($kek, $d['secret'], master_aad((string) $d['username']));
    if ($svnpw === null) return ['ok' => false, 'reason' => 'decrypt_failed'];

    master_setup($newpw, (string) $d['username'], $svnpw);
    master_lock_all();                         // old sessions can't be re-derived anyway; drop them
    return ['ok' => true];
}

// ----------------------------------------------------------------- unlock

/**
 * Verify the master password and establish a session. On success mints the two-layer
 * envelope, writes the session file, and returns the browser's {token, key}. The master
 * password, KEK, S and cleartext svnpw exist only transiently in this call.
 * Returns ['ok'=>true, token, key, username]
 *      or ['ok'=>false, 'reason'=>'not_configured'|'bad_password'|'decrypt_failed'].
 */
function master_unlock(string $masterpw): array {
    if (!master_is_configured()) return ['ok' => false, 'reason' => 'not_configured'];
    $d = master_load();
    if (!crypto_verifier_check($masterpw, $d['verifier'])) return ['ok' => false, 'reason' => 'bad_password'];

    $username = (string) $d['username'];
    $kek = crypto_kek($masterpw, base64_decode($d['salt']), $d['kdf'] ?? []);
    $svnpw = crypto_decrypt($kek, $d['secret'], master_aad($username));
    if ($svnpw === null) return ['ok' => false, 'reason' => 'decrypt_failed'];

    // Mint the envelope: K (browser) -> S (disk, wrapped) -> svnpw.
    $S    = crypto_rand_key(2048);
    $encSvn = crypto_encrypt(crypto_hkdf($S, CRYPTO_KEY_LEN, 'svnreview:dek:v1'), $svnpw, master_aad($username));
    $K    = crypto_rand_key(CRYPTO_KEY_LEN);
    $encS = crypto_encrypt(crypto_hkdf($K, CRYPTO_KEY_LEN, 'svnreview:wrap:v1'), $S);

    $now = time();
    $token = crypto_rand_token();
    master_session_write($token, [
        'encS'        => $encS,
        'encSvn'      => $encSvn,
        'user'        => $username,
        'created'     => $now,
        'expires'     => $now + MASTER_IDLE_TTL,
        'hardExpires' => $now + MASTER_HARD_TTL,
    ]);

    return ['ok' => true, 'token' => $token, 'key' => base64_encode($K), 'username' => $username];
}

// ----------------------------------------------------------------- per-request resolve

/**
 * Resolve {token, K} from a request into the cleartext SVN credential for one action.
 * Slides the idle expiry on success. The caller MUST use and discard the password
 * immediately (see svn_run_with_password()).
 * Returns ['ok'=>true, username, password]
 *      or ['ok'=>false, 'reason'=>'no_session'|'expired'|'bad_key'].
 */
function master_resolve(string $token, string $keyB64): array {
    if (!preg_match('/^[a-f0-9]{16,96}$/', $token)) return ['ok' => false, 'reason' => 'no_session'];
    $file = master_session_file($token);
    if (!is_file($file)) return ['ok' => false, 'reason' => 'no_session'];

    $s = store_read($file, []);
    $now = time();
    if (($now > (int) ($s['expires'] ?? 0)) || ($now > (int) ($s['hardExpires'] ?? 0))) {
        @unlink($file);
        return ['ok' => false, 'reason' => 'expired'];
    }

    $K = base64_decode($keyB64, true);
    if ($K === false || $K === '') return ['ok' => false, 'reason' => 'bad_key'];

    $S = crypto_decrypt(crypto_hkdf($K, CRYPTO_KEY_LEN, 'svnreview:wrap:v1'), (string) ($s['encS'] ?? ''));
    if ($S === null) return ['ok' => false, 'reason' => 'bad_key'];

    $username = (string) ($s['user'] ?? '');
    $svnpw = crypto_decrypt(crypto_hkdf($S, CRYPTO_KEY_LEN, 'svnreview:dek:v1'), (string) ($s['encSvn'] ?? ''), master_aad($username));
    if ($svnpw === null) return ['ok' => false, 'reason' => 'bad_key'];

    // Slide the idle window (never past the hard cap). Only persist when it advances by
    // at least a minute, so an active session isn't rewriting its file on every request.
    $newExpires = min($now + MASTER_IDLE_TTL, (int) $s['hardExpires']);
    if ($newExpires - (int) $s['expires'] >= 60) {
        $s['expires'] = $newExpires;
        master_session_write($token, $s);
    }

    return ['ok' => true, 'username' => $username, 'password' => $svnpw];
}

// ----------------------------------------------------------------- lock / GC

/** Drop a single session (logout / explicit lock). */
function master_lock(string $token): void {
    if (!preg_match('/^[a-f0-9]{16,96}$/', $token)) return;
    $file = master_session_file($token);
    if (is_file($file)) @unlink($file);
}

/** Drop every session (e.g. after a master-password change). */
function master_lock_all(): void {
    foreach (glob(master_sessions_dir() . '/*.json') ?: [] as $f) @unlink($f);
}

/**
 * Full reset — delete EVERY auth artifact: the encrypted credential (auth.json), all
 * unlock sessions, the throttle state, and the machine-bound device key (pepper). Leaves
 * the app in a fresh "not set up" state; the next setup mints a new device key.
 * Irreversible — the encrypted credential becomes unrecoverable. Returns a human-readable
 * list of what was removed (for the UI). Intentionally does NOT require an unlocked session,
 * so a forgotten master password can still be recovered from.
 */
function master_reset(): array {
    $removed = [];

    if (is_file(master_auth_file()) && @unlink(master_auth_file())) $removed[] = 'encrypted credential';

    $n = 0;
    foreach (glob(master_sessions_dir() . '/*.json') ?: [] as $s) { if (@unlink($s)) $n++; }
    if ($n) $removed[] = $n . ' active session' . ($n === 1 ? '' : 's');
    $ht = master_sessions_dir() . '/.htaccess';
    if (is_file($ht)) @unlink($ht);
    if (is_dir(master_sessions_dir())) @rmdir(master_sessions_dir());

    if (is_file(master_throttle_file()) && @unlink(master_throttle_file())) $removed[] = 'throttle state';

    $dk = device_key_path();
    if (is_file($dk) && @unlink($dk)) $removed[] = 'device key (pepper)';

    return ['removed' => $removed];
}

/** Remove expired session files. Returns the count swept. */
function master_gc(): int {
    $now = time();
    $removed = 0;
    foreach (glob(master_sessions_dir() . '/*.json') ?: [] as $f) {
        $s = store_read($f, null);
        $dead = !is_array($s)
             || $now > (int) ($s['expires'] ?? 0)
             || $now > (int) ($s['hardExpires'] ?? 0);
        if ($dead && @unlink($f)) $removed++;
    }
    return $removed;
}

/** Probabilistic GC (~1-in-$oneIn requests), so we don't scan on every call. */
function master_gc_maybe(int $oneIn = 20): void {
    if ($oneIn < 1) $oneIn = 1;
    if (random_int(1, $oneIn) === 1) master_gc();
}

// ----------------------------------------------------------------- unlock throttle

/*
 * Blunt online guessing against the unlock/change endpoints: count recent failures and,
 * past a threshold, impose an escalating lockout. State is a single small file under data/.
 */
function master_throttle_file(): string { return DATA_DIR . '/auth-throttle.json'; }

/** Remaining lockout in seconds (0 = not currently locked out). */
function master_throttle_locked(): int {
    $until = (int) (store_read(master_throttle_file(), [])['until'] ?? 0);
    $now = time();
    return $until > $now ? $until - $now : 0;
}

/** Record a failed attempt and arm an escalating lockout after a threshold. */
function master_throttle_fail(): void {
    $t = store_read(master_throttle_file(), []);
    $now = time();
    $fails = (($now - (int) ($t['last'] ?? 0)) > 900) ? 0 : (int) ($t['fails'] ?? 0);  // 15-min window
    $fails++;
    $until = $fails >= 5 ? $now + min(300, 10 * (2 ** ($fails - 5))) : 0;               // 10s → cap 5 min
    store_write(master_throttle_file(), ['fails' => $fails, 'last' => $now, 'until' => $until]);
}

/** Clear throttle state after a successful unlock/change. */
function master_throttle_reset(): void {
    $f = master_throttle_file();
    if (is_file($f)) @unlink($f);
}

// ----------------------------------------------------------------- session files

function master_session_file(string $token): string {
    return master_sessions_dir() . '/' . $token . '.json';
}

/** Write a session file, ensuring the directory exists and is web-blocked. */
function master_session_write(string $token, array $data): void {
    master_sessions_dir_ensure();
    store_write(master_session_file($token), $data);
}

/** Create data/sessions/ with a defense-in-depth .htaccess (data/.htaccess already covers it). */
function master_sessions_dir_ensure(): void {
    $dir = master_sessions_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
        fail('Cannot create the sessions directory: ' . $dir, 500);
    }
    $ht = $dir . '/.htaccess';
    if (!is_file($ht)) {
        @file_put_contents($ht,
            "# Transient unlock sessions — never web-accessible.\n" .
            "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n" .
            "<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n");
    }
}
