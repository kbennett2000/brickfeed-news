# ADR-0002: Cycle model

## Status
Accepted. The operating contract below is the authoritative, expanded version in
[../../CLAUDE.md](../../CLAUDE.md) ("How work runs here" / "The cycle contract"); this ADR is
the original record of the decision.

> Renumbered from a duplicate `0001` to `0002` (the previously-unused slot) to remove an ADR
> number collision with `0001-brickfeed-architecture.md`.

## Decision

- Execution runs as headless `claude -p`, one cycle per run.
- Fresh session each cycle; state lives in HANDOFF.md, CLAUDE.md, and ADRs — not resumed context.
- Work happens on a branch, never main. Human merges. (CLAUDE.md is the live authority on the
  delivery step; the project currently lands on `master` directly under an owner directive.)
- When unsure or blocked: commit what exists, write the question into the issue, stop.
