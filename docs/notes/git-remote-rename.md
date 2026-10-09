# Git Remote Rename (display name vs URL path)

Project-independent reference, gathered 2026-10-09 (gitee/github).

## Two distinct "names"

A hosted git repo has two names that are INDEPENDENT:

- **Display name / full name** (仓库全称) — the human-readable title shown on the page. Changing this does NOT change the clone URL.
- **URL path slug** — the segment in `host/<user>/<slug>.git`. This determines the clone address. Only renaming the PATH changes the URL.

If you "renamed" the repo but the clone/SSH address shown on the page is unchanged, you changed the display name, not the path slug.

## Rename carries history; old path redirects

When the path slug is actually renamed, the host carries ALL history, branches, and tags to the new path and typically sets up an **old-path → new-path redirect**. Existing clones keep working through the redirect, but relying on it is fragile (redirects can be removed). Best practice: update each clone's remote URL.

## Updating a clone after rename

```
git remote set-url origin git@<host>:<user>/<new-slug>.git
git remote -v          # confirm
git ls-remote origin   # verify it resolves
git fetch origin       # refresh tracking refs
```

## The local folder name is irrelevant

Git does not care what the on-disk working directory is called — it tracks everything via `.git/`. The repo can be named `X` on the host while the local folder is named `Y`; both `fetch`/`push` work fine. No need to rename the local folder to match.

## SSH auth success ≠ repo path exists

`ssh -T git@<host>` authenticates against the HOST (returns "Hi <user>!"), confirming your SSH key works. It does NOT confirm any specific repo path exists or that you have access to it. A repo path that doesn't exist (or you lack access to) returns **404 / "repository not found"** at the git-upload-pack/receive-pack layer — distinct from the SSH-auth success. So: a working `ssh -T` + a failing `git ls-remote` points at the repo PATH, not your SSH key.
