# AI-FIXES — instructions for AI coding assistants

You (an AI coding assistant) have been pointed at this file because a human
reviewed a Subversion changeset in **Bixi** and **rejected** some files, each
with a note explaining what's wrong. Your job is to apply fixes in the
project's working copy, guided by those notes. The human will re-review and
commit in Bixi afterward.

## Where the rejections live

All Bixi state is plain JSON under `data/` next to this file:

1. **`data/projects.json`** — the registered projects. Find the project the
   user named; take its `id` and `path` (the absolute path of the SVN working
   copy you'll be editing).
2. **`data/reviews/<id>.json`** — the review state for that project. The
   `entries` object maps working-copy-relative paths to review records:

   ```json
   {
     "entries": {
       "lib/orders.php": {
         "status": "rejected",
         "notes": "escape $customer_name before output — see how safedisplay is used elsewhere",
         "hash": "d41d8cd98f00b204e9800998ecf8427e",
         "svnStatus": "modified",
         "when": "2026-07-08T14:00:00+00:00"
       }
     }
   }
   ```

Work through every entry whose `status` is `"rejected"`. The key is the file's
path **relative to the project's `path`**; the `notes` field is the human's
instruction for that file.

## What to do per file

- Read the file and, for context, the pending change that was reviewed
  (`svn diff <file>` inside the working copy shows it).
- Apply a fix that addresses the rejection note. The note describes what's
  wrong; keep the fix minimal and in the style of the surrounding code.
- If a note is ambiguous or you can't fix it confidently, **skip the file and
  report it** at the end instead of guessing.

## Rules

- **Never run state-changing `svn` commands** — no `commit`, `revert`,
  `update`, `add`, `delete`, `move`, `resolve`. Read-only ones (`status`,
  `diff`, `info`, `log`, `cat`) are fine. The human commits through Bixi.
- **Do not edit anything under Bixi's own folder**, including the review JSON.
  You don't need to clear the rejections: Bixi fingerprints each file's content
  at review time, so your edit automatically invalidates the stale rejection
  and the file returns to the review queue as unreviewed.
- Only touch files listed as rejected (plus nothing else), unless the user's
  prompt says otherwise.

## When you're done

Report a short summary: files fixed (with a one-line description of each fix),
and files skipped with the reason. The human takes it from there in Bixi.
