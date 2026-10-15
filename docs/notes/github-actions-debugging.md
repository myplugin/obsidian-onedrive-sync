# Debugging GitHub Actions without admin log access

## The problem

GitHub Actions run logs require **admin/write access** to the repo. The logs API (`GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`) returns 403 for non-admins. You can see the run status + step conclusions via the public API, but not the actual stdout/stderr.

## Techniques that work without admin access

### 1. Annotations API (public)

```bash
# Get the job ID from the run
curl -s "https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/jobs"
# Get annotations for the job's check-run
curl -s "https://api.github.com/repos/{owner}/{repo}/check-runs/{job_id}/annotations"
```

Annotations include `annotation_level` (`failure`/`warning`/`notice`) + `message`. For build failures, the message is usually just "Process completed with exit code 1." — not the actual error, but it tells you WHICH step failed.

### 2. `$GITHUB_STEP_SUMMARY` (visible on the Actions page)

Write error output to the step summary, which renders on the Actions run page (visible to anyone who can see the repo):

```yaml
- name: Build
  run: |
    set +e
    output=$(npm run build 2>&1)
    code=$?
    echo "$output"
    if [ $code -ne 0 ]; then
      {
        echo "## Build failed (exit $code)"
        echo '```'
        echo "$output" | tail -30
        echo '```'
      } >> "$GITHUB_STEP_SUMMARY"
      exit 1
    fi
```

The step summary is JavaScript-rendered on the Actions page. `webfetch` can't extract it (too short / dynamic), but a **real browser** (via `openchamber_web` → `browser.snapshot`) CAN read it — the full error text appears in the snapshot's `text` field.

### 3. Split steps to isolate failures

Instead of one `npm run build` step, split into separate steps:

```yaml
- name: Typecheck
  run: npx tsc -noEmit -skipLibCheck
- name: Build (esbuild)
  run: node esbuild.config.mjs production
- name: Verify
  run: node scripts/verify-build.mjs
```

The step name appears in the annotations + the Actions UI, so you know WHICH sub-step failed without reading logs.

### 4. Browser snapshot (the nuclear option)

If the step summary has the error but `webfetch` can't see it:

1. `openchamber_web` → `browser.open` the Actions run URL.
2. `browser.snapshot` → the full page text (including JavaScript-rendered step summaries) appears in the `text` field.

This works because the browser renders the JavaScript that `webfetch` can't.
