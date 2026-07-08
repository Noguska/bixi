# SVN Review — Install & Setup

A self-contained PHP app for reviewing pending SVN changes, then approving and
committing them. No database, no Composer, no build step. It runs on
**Windows, macOS, and Linux**.

---

## 1. Requirements

- **PHP 8.2 or newer** on your `PATH`. Check with `php -v`.
- **Subversion command-line client 1.14+** (`svn`) on your `PATH`. Check with `svn --version`.
- An **SVN working copy** to review — either one you already have on disk, or a
  fresh one you check out from a repository URL directly in the app (see
  [§4](#4-first-time-setup-in-the-app)).
- A modern browser.
- *(Optional)* an external **diff tool** — VS Code, TortoiseSVN, Meld, Beyond
  Compare, FileMerge, etc. — if you want side-by-side diffs in a desktop app.
  The app also has a built-in in-browser diff, so this is purely optional.

---

## 2. Get the files

Copy the whole `svnreview` folder anywhere on the machine. That's the install.

The `data/` folder holds **your** settings and is created/updated as you use the
app (registered projects, saved SVN login, review state, caches). It ships empty —
nothing in it is shared between installs. Keep it private (it can contain your SVN
password); the included `data/.htaccess` blocks web access to it under Apache.

---

## 3. Run it

### Recommended: app mode (built-in PHP server)

This is the simplest, most portable way and it makes desktop tools (diff / open /
reveal) "just work" with no extra setup.

- **Windows:** double-click **`run.cmd`**.
- **macOS / Linux:**
  ```bash
  chmod +x run.sh   # first time only
  ./run.sh
  ```

It serves the app at <http://127.0.0.1:8787/> and opens your browser. Leave the
window open; close it (or Ctrl+C) to stop. Change the port with `PORT=9000`
(`set PORT=9000` on Windows) before launching.

### Alternative: host under Apache / XAMPP / nginx

Point a vhost or web root at the `svnreview` folder and browse to it
(e.g. `http://localhost/svnreview/`). Everything works — **except** that launching
external desktop apps (the diff viewer, "Open", "Reveal") needs an extra step on
Windows; see [§5](#5-external-diff-tool--desktop-launching).

---

## 4. First-time setup in the app

1. **Sign in to SVN** (top-right) — one global username/password used for all repo
   access. It's stored under `data/` on this machine only.
2. **Add a project** — on the dashboard, pick one of two tabs:
   - **Register existing** — a name and the path to a working copy you already
     have (e.g. `C:\projects\myproject` or `/home/me/projects/app`).
   - **Check out new** — a repository URL and a destination folder; Bixi runs
     `svn checkout` (optionally at a specific revision, or with a shallow depth
     for very large repos) and registers the result. Private repos use your saved
     SVN login. Large checkouts run best in app mode (no request timeout).

   Add as many as you like.
3. Click a project to start reviewing. **Settings** (top-right) is covered next.

---

## 5. External diff tool & desktop launching

Open **Settings** (top-right on the dashboard) to configure the diff tool and how
desktop apps are launched.

### The diff command

Set any command line you like. Two placeholder styles are supported:

| Placeholder            | Meaning                                                        |
|------------------------|----------------------------------------------------------------|
| `{path}`               | The working-copy file path (for tools that diff BASE↔working themselves, e.g. TortoiseSVN). |
| `{base}` and `{working}` | Two files to compare. The app writes the pristine BASE revision to a temp file and substitutes it for `{base}`. |

Examples:

```text
# VS Code (any OS)
code --wait --diff {base} {working}

# Meld (Linux)
meld {base} {working}

# FileMerge (macOS, ships with Xcode command-line tools)
opendiff {base} {working}

# TortoiseSVN (Windows) — it computes the diff itself
"C:\Program Files\TortoiseSVN\bin\TortoiseProc.exe" /command:diff /path:{path} /closeonend:0
```

Click **Use detected default** to fill in a sensible command for what's installed
on the machine. Leave it blank to rely on the built-in in-browser diff only.

### "Launch mode" (why a window might not appear)

A GUI app can only appear on your desktop if the web server is running **in your
logged-in session**:

- **app mode (`run.cmd` / `run.sh`)** → runs in your session → tools launch
  directly. **Recommended.** Settings shows launch mode = **direct**.
- **Apache as a Windows service** → runs in the hidden "Session 0" → a launched
  window would be invisible. Settings shows launch mode = **queue**. Two options:
  1. **Switch to app mode** with `run.cmd` (easiest), or
  2. keep Apache and run **`setup-diff-task.cmd` once** (double-click it as your
     logged-in Windows user). It registers an interactive helper task that pops the
     window into your session. This is the legacy path; app mode makes it unneeded.

macOS and Linux have no "Session 0" split, so they always launch directly — just
use `run.sh`.

The **Desktop launch** radios in Settings let you force *Direct* or *Helper task*
if the automatic choice is wrong (e.g. you run Apache in your own session).

---

## 6. Updating

Replace the program files with a newer copy. **Don't overwrite `data/`** — that's
your settings and review state.

---

## 7. Security notes

- The app shells out to `svn` and to your configured diff tool, and it can commit
  to your repository. Run it for **trusted, local/LAN use** — don't expose it to
  the public internet.
- Your SVN password is stored under `data/` (web-access-blocked under Apache via
  `data/.htaccess`). Anyone who can reach the app can use that saved login.

---

## 8. Troubleshooting

- **"PHP not found" / "svn not found"** — install them and ensure they're on
  `PATH` (`php -v`, `svn --version`).
- **Diff button does nothing** — open Settings: if launch mode is **queue**, switch
  to app mode (`run.cmd`) or run `setup-diff-task.cmd`. Also confirm the diff
  command is set and the tool is installed.
- **"No diff tool is configured"** — set a command in Settings, or use the built-in
  in-browser diff (click a file row).
- **Port already in use** — start with a different `PORT` (see §3).
- **Move to Trash fails on macOS/Linux** — sending deletions to the OS trash is
  currently Windows-only; use *Delete Forever* (or revert) on macOS/Linux.
