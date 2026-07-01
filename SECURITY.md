# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue or disclose the problem publicly before it's
fixed.

Bixi uses **GitHub's private vulnerability reporting**. To report a security issue:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Include as much detail as you can — affected version or commit, steps to
   reproduce, and the impact.

You'll get an acknowledgement, and we'll coordinate a fix and disclosure with you.
(Public Issues are disabled on this repository, so private reporting is the right
channel.)

## Scope

Bixi shells out to the `svn` CLI and stores an SVN credential locally under
`data/` (encrypted with a machine-bound device key; see `lib/crypto.php` and
`lib/master.php`). It is designed for **trusted, local or LAN use** and should not
be exposed to the public internet.

Especially welcome are reports about:

- credential storage and the master-password / unlock flow,
- command construction passed to `svn` (argument/shell handling),
- path handling and directory traversal,
- the diff, checkout, and commit flows.

Out of scope: consequences of deliberately exposing the app to an untrusted
network, which the documentation advises against.

## Supported versions

Fixes are applied to the latest `main`; there are no separate maintenance
branches.
