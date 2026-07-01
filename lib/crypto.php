<?php
declare(strict_types=1);

require_once __DIR__ . '/util.php';
require_once __DIR__ . '/desktop.php';   // os_family() (for the device-key location)

/*
 * Crypto primitives for the master-password feature. Pure functions + the
 * machine-bound device key; lib/master.php composes them into setup/unlock/resolve.
 *
 * Choices (see CLAUDE-todo.md item 20):
 *   - AEAD:     AES-256-GCM via OpenSSL (universally present). Blob = iv(12)‖tag(16)‖ct.
 *   - Verifier: Argon2id (password_hash), peppered with the device key.
 *   - KEK:      HKDF( KDF(masterpw, salt) , salt=device.key ). KDF is Argon2id when
 *               ext-sodium is present, else PBKDF2-SHA256(600k). The device key is the
 *               pepper, so a stolen data/ alone is not offline-brute-forceable.
 *   - Device key: 32 random bytes stored OUTSIDE the webroot (per-OS app-data dir),
 *               never in data/, never sent to the browser.
 *
 * Everything that goes into JSON is base64; raw key material never leaves PHP memory
 * except wrapped (encrypted) or as the browser-held session key K.
 */

const CRYPTO_KEY_LEN      = 32;   // AES-256
const CRYPTO_IV_LEN       = 12;   // GCM nonce
const CRYPTO_TAG_LEN      = 16;   // GCM tag
const CRYPTO_SALT_LEN     = 16;   // KDF salt (also sodium pwhash SALTBYTES)
const CRYPTO_PBKDF2_ITERS = 600000;

// ----------------------------------------------------------------- device key

/**
 * Absolute path to the machine-bound device key, OUTSIDE the served tree.
 * Override with the SVNREVIEW_DEVICE_KEY env var (full path to the key file).
 */
function device_key_path(): string {
    $override = getenv('SVNREVIEW_DEVICE_KEY');
    if (is_string($override) && $override !== '') return $override;

    switch (os_family()) {
        case 'windows':
            $base = getenv('LOCALAPPDATA') ?: getenv('APPDATA')
                 ?: ((getenv('USERPROFILE') ?: 'C:') . '\\AppData\\Local');
            return rtrim($base, "\\/") . '\\svnreview\\device.key';
        case 'mac':
            $home = getenv('HOME') ?: sys_get_temp_dir();
            return rtrim($home, '/') . '/Library/Application Support/svnreview/device.key';
        default:
            $base = getenv('XDG_DATA_HOME') ?: ((getenv('HOME') ?: sys_get_temp_dir()) . '/.local/share');
            return rtrim($base, '/') . '/svnreview/device.key';
    }
}

/**
 * Load the 32-byte device key, creating it on first use. Throws on a present-but-
 * corrupt key (wrong length) rather than overwriting it — overwriting would orphan
 * every credential already encrypted under the old key.
 */
function device_key(): string {
    static $cache = null;
    if ($cache !== null) return $cache;

    $path = device_key_path();
    if (is_file($path)) {
        $raw = @file_get_contents($path);
        if ($raw === false) fail('Cannot read the device key at ' . $path, 500);
        if (strlen($raw) !== CRYPTO_KEY_LEN) {
            fail('Device key at ' . $path . ' is corrupt (expected ' . CRYPTO_KEY_LEN
               . ' bytes, got ' . strlen($raw) . '). Restore the backup or reset the master password.', 500);
        }
        return $cache = $raw;
    }

    $dir = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        fail('Cannot create the device-key directory: ' . $dir, 500);
    }
    $key = random_bytes(CRYPTO_KEY_LEN);
    // Write atomically-ish, then tighten perms (no-op on Windows, harmless).
    if (@file_put_contents($path, $key, LOCK_EX) === false) {
        fail('Cannot write the device key to ' . $path, 500);
    }
    @chmod($path, 0600);
    return $cache = $key;
}

// ----------------------------------------------------------------- KDF / KEK

/** Default KDF parameters for a NEW master password (memory-hard if sodium is present). */
function crypto_kdf_default_params(): array {
    if (function_exists('sodium_crypto_pwhash')) {
        return [
            'algo' => 'argon2id',
            'ops'  => defined('SODIUM_CRYPTO_PWHASH_OPSLIMIT_MODERATE') ? SODIUM_CRYPTO_PWHASH_OPSLIMIT_MODERATE : 3,
            'mem'  => defined('SODIUM_CRYPTO_PWHASH_MEMLIMIT_MODERATE') ? SODIUM_CRYPTO_PWHASH_MEMLIMIT_MODERATE : 268435456,
        ];
    }
    return ['algo' => 'pbkdf2', 'iter' => CRYPTO_PBKDF2_ITERS];
}

/**
 * Derive raw 32-byte key material from the master password using the stored params.
 * Re-derivation must use the SAME params recorded at setup, so the caller persists
 * $params alongside the salt. Throws if the recorded algo isn't available here.
 */
function crypto_kdf(string $masterpw, string $salt, array $params): string {
    $algo = $params['algo'] ?? 'pbkdf2';
    if ($algo === 'argon2id') {
        if (!function_exists('sodium_crypto_pwhash')) {
            fail('This credential was created with Argon2id (libsodium), which is not available on this PHP build.', 500);
        }
        return sodium_crypto_pwhash(
            CRYPTO_KEY_LEN, $masterpw,
            substr(str_pad($salt, CRYPTO_SALT_LEN, "\0"), 0, CRYPTO_SALT_LEN),
            (int) ($params['ops'] ?? 3), (int) ($params['mem'] ?? 268435456),
            SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13
        );
    }
    return hash_pbkdf2('sha256', $masterpw, $salt, (int) ($params['iter'] ?? CRYPTO_PBKDF2_ITERS), CRYPTO_KEY_LEN, true);
}

/**
 * The key-encryption key that protects the at-rest credential. Folds the device-key
 * pepper in as the HKDF salt: without the device key (stored outside the webroot) the
 * KEK cannot be reproduced even if data/ and the master password are both known.
 */
function crypto_kek(string $masterpw, string $salt, array $params): string {
    $ikm = crypto_kdf($masterpw, $salt, $params);
    return hash_hkdf('sha256', $ikm, CRYPTO_KEY_LEN, 'svnreview:kek:v1', device_key());
}

// ----------------------------------------------------------------- verifier

/**
 * Peppered Argon2id verifier of the master password. The password is HMAC'd with the
 * device key first, so the stored hash can't even be guessed against without the
 * device key. Returns a self-describing crypt string for password_verify().
 */
function crypto_verifier_make(string $masterpw): string {
    $peppered = base64_encode(hash_hmac('sha256', $masterpw, device_key(), true));
    return password_hash($peppered, PASSWORD_ARGON2ID);
}

function crypto_verifier_check(string $masterpw, string $hash): bool {
    if ($hash === '') return false;
    $peppered = base64_encode(hash_hmac('sha256', $masterpw, device_key(), true));
    return password_verify($peppered, $hash);
}

// ----------------------------------------------------------------- AEAD

/**
 * AES-256-GCM. Returns base64( iv(12) ‖ tag(16) ‖ ciphertext ), suitable for JSON.
 * $aad is authenticated but not encrypted (bind username / version / purpose).
 */
function crypto_encrypt(string $key, string $plain, string $aad = ''): string {
    if (strlen($key) !== CRYPTO_KEY_LEN) fail('crypto_encrypt: bad key length', 500);
    $iv = random_bytes(CRYPTO_IV_LEN);
    $tag = '';
    $ct = openssl_encrypt($plain, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, $aad, CRYPTO_TAG_LEN);
    if ($ct === false) fail('Encryption failed', 500);
    return base64_encode($iv . $tag . $ct);
}

/**
 * Inverse of crypto_encrypt(). Returns the plaintext, or null on ANY failure —
 * wrong key, tampering, AAD mismatch, or malformed input (the GCM tag is the
 * authoritative correctness check, e.g. "wrong master password").
 */
function crypto_decrypt(string $key, string $blobB64, string $aad = ''): ?string {
    if (strlen($key) !== CRYPTO_KEY_LEN) return null;
    $blob = base64_decode($blobB64, true);
    if ($blob === false || strlen($blob) < CRYPTO_IV_LEN + CRYPTO_TAG_LEN) return null;
    $iv  = substr($blob, 0, CRYPTO_IV_LEN);
    $tag = substr($blob, CRYPTO_IV_LEN, CRYPTO_TAG_LEN);
    $ct  = substr($blob, CRYPTO_IV_LEN + CRYPTO_TAG_LEN);
    $pt = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, $aad);
    return $pt === false ? null : $pt;
}

// ----------------------------------------------------------------- HKDF / randoms

/** HKDF-SHA256 convenience (used to derive the cipher key from the 2048-byte DEK, etc.). */
function crypto_hkdf(string $ikm, int $len, string $info, string $salt = ''): string {
    return hash_hkdf('sha256', $ikm, $len, $info, $salt);
}

/** A 16-byte random KDF salt. */
function crypto_salt(): string { return random_bytes(CRYPTO_SALT_LEN); }

/** A raw random key (default 32 bytes). */
function crypto_rand_key(int $len = CRYPTO_KEY_LEN): string { return random_bytes($len); }

/** A filesystem/URL-safe random token (hex). 24 bytes = 192-bit by default. */
function crypto_rand_token(int $bytes = 24): string { return bin2hex(random_bytes($bytes)); }
