#!/usr/bin/env bash
#
# brickfeed-news — cron-safe cycle wrapper (Slice 8).
#
# Wraps `npm run cycle` in a NON-BLOCKING flock so an overlapping cron tick SKIPS rather than
# racing a still-running cycle (image generation can take minutes). Passes through the cycle's
# exit code so cron/monitoring sees failures.
#
# PROGRESS VISIBILITY (so a long run is never mistaken for a frozen one):
#   • The cycle itself logs every stage (ingest → generate → image → ageout → render → deploy)
#     and per-story progress as it goes.
#   • A HEARTBEAT prints elapsed time every ${BRICKFEED_HEARTBEAT_SECS:-30}s, so even a quiet
#     stage (e.g. resolving feed redirects) is visibly alive, not hung.
#   • When run in a terminal, output is mirrored to BOTH the console and the log; from cron
#     (no TTY) it goes to the log only (so cron doesn't email every run).
#   • Watch a run live from another terminal any time:   tail -f cycle.log
#
# ---------------------------------------------------------------------------------------
# CRONTAB (configure the schedule placeholder; use an ABSOLUTE path to this script):
#
#   <SCHEDULE>  /abs/path/to/brickfeed-news/scripts/cycle.sh
#
#   e.g. every 4 hours on the hour:
#   0 */4 * * *  /home/kris/brickfeed-news/scripts/cycle.sh
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
#
# ---------------------------------------------------------------------------------------
# ENV OVERRIDES:
#   BRICKFEED_LOCK           lock file            (default /tmp/brickfeed.lock)
#   BRICKFEED_LOG            log file             (default <repo>/cycle.log)
#   BRICKFEED_HEARTBEAT_SECS heartbeat interval s (default 30)
# ---------------------------------------------------------------------------------------

set -uo pipefail

# Repo root = parent of this script's dir, resolved regardless of the caller's cwd.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LOCK_FILE="${BRICKFEED_LOCK:-/tmp/brickfeed.lock}"
LOG_FILE="${BRICKFEED_LOG:-$REPO_DIR/cycle.log}"
HEARTBEAT_SECS="${BRICKFEED_HEARTBEAT_SECS:-30}"

# Route all output to the log; ALSO mirror to the console when attached to a terminal, so an
# interactive run streams live progress while a cron run (no TTY) stays log-only (no mail spam).
if [ -t 1 ]; then
  exec > >(tee -a "$LOG_FILE") 2>&1
else
  exec >>"$LOG_FILE" 2>&1
fi

# Timestamped wrapper log line (distinct "cycle.sh:" prefix from the cycle's own "cycle:" lines).
say() { printf '[%s] cycle.sh: %s\n' "$(date -Is)" "$*"; }

# Acquire the lock on a dedicated fd; -n = non-blocking (skip instead of waiting).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  say "another cycle holds the lock ($LOCK_FILE); skipping this tick."
  exit 0
fi

cd "$REPO_DIR" || { say "cannot cd to repo dir ($REPO_DIR); aborting."; exit 1; }

start_epoch=$(date +%s)
say "starting 'npm run cycle'"
say "stages: ingest → generate → image → ageout → render → deploy (each is logged below as it runs)"

# Heartbeat: while the cycle runs, print elapsed time every HEARTBEAT_SECS so a quiet stage
# doesn't look frozen. Runs in the background; the EXIT trap guarantees it's cleaned up.
(
  while true; do
    sleep "$HEARTBEAT_SECS"
    say "… still working (${SECONDS}s elapsed) — cycle in progress, not frozen"
  done
) &
heartbeat_pid=$!
trap 'kill "$heartbeat_pid" 2>/dev/null' EXIT

# Run the cycle; its own per-stage / per-story logging streams through here as it goes.
npm run cycle
code=$?

kill "$heartbeat_pid" 2>/dev/null
trap - EXIT

dur=$(( $(date +%s) - start_epoch ))
if [ "$code" -eq 0 ]; then
  say "cycle finished OK in ${dur}s (exit 0)"
else
  say "cycle FAILED in ${dur}s (exit $code) — see the stage summary above"
fi
exit "$code"
