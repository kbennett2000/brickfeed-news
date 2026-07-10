#!/usr/bin/env bash
#
# brickfeed-news — cron-safe cycle wrapper (Slice 8).
#
# Wraps `npm run cycle` in a NON-BLOCKING flock so an overlapping cron tick SKIPS rather
# than racing a still-running cycle (image generation can take minutes). Logs to a file and
# passes through the cycle's exit code so cron/monitoring sees failures.
#
# ---------------------------------------------------------------------------------------
# CRONTAB (configure the schedule placeholder; use an ABSOLUTE path to this script):
#
#   <SCHEDULE>  /abs/path/to/brickfeed-news/scripts/cycle.sh
#
#   e.g. every 30 minutes:
#   */30 * * * *  /home/kris/brickfeed-news/scripts/cycle.sh
#
# ---------------------------------------------------------------------------------------
# ONE-TIME HUMAN PREREQUISITES (run interactively on the box — do NOT automate headless):
#
#   1. Vercel CLI auth + link the project ONCE, in the deploy cwd (default: the render
#      output dir `site/`, so `.vercel/` is created there):
#         cd /abs/path/to/brickfeed-news/site && vercel login && vercel link
#      (Alternatively set deploy.cwd in config.json and link there.)
#   2. The grok CLI logged in via subscription on this box (the keyless "grok-terminal"
#      provider path — set generator.provider and image.provider to "grok-terminal").
#   3. Optional: VERCEL_TOKEN in the environment only for CI-like/headless contexts; the
#      box normally relies on the `vercel login` above and leaves it unset.
#   4. A real config.json (copy config.example.json) and, for Blob storage,
#      BLOB_READ_WRITE_TOKEN + storage.blob.publicBaseUrl.
# ---------------------------------------------------------------------------------------

set -euo pipefail

# Repo root = parent of this script's dir, resolved regardless of the caller's cwd.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LOCK_FILE="${BRICKFEED_LOCK:-/tmp/brickfeed.lock}"
LOG_FILE="${BRICKFEED_LOG:-$REPO_DIR/cycle.log}"

# Acquire the lock on a dedicated fd; -n = non-blocking (skip instead of waiting).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -Is)] cycle.sh: another cycle holds the lock ($LOCK_FILE); skipping." >>"$LOG_FILE"
  exit 0
fi

cd "$REPO_DIR"
echo "[$(date -Is)] cycle.sh: starting 'npm run cycle'" >>"$LOG_FILE"

# Run the cycle, tee output to the log, and capture the cycle's real exit code (not tee's).
set +e
npm run cycle >>"$LOG_FILE" 2>&1
code=$?
set -e

echo "[$(date -Is)] cycle.sh: 'npm run cycle' exited $code" >>"$LOG_FILE"
exit "$code"
