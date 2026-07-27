# 026 — PR #556 bridge CodeRabbit follow-ups

## Live snapshot

- Timestamp: 2026-07-27T14:12:56Z
- PR: https://github.com/lidge-jun/opencodex/pull/556
- State: OPEN, non-draft, base `dev`, head `fix/coderabbit-bridge-followups`
- Head SHA: `8959f5e6f794c687cad45439cd310c050793851e`
- Mergeability: `MERGEABLE`
- Labels: `bug`
- Review decision: empty at first snapshot; CodeRabbit review in progress
- CI: `enforce-target` and `label` succeeded; platform matrix, React Doctor, npm-global matrix, and CodeRabbit pending at first snapshot

## Classification

- Bucket: `merge now` candidate, pending independent audit and latest-head hosted checks.
- Priority: P0/P1 bug follow-up because it is a direct #555 bridge correctness follow-up and modifies only `src/bridge.ts` plus `tests/bridge.test.ts`.
- Risk boundary: not auth, permission, data migration, privilege boundary, GUI/UX, or release branch work.

## Diff-level plan

### Scope IN

- Re-check PR #556 live head, diff, checks, reviews, comments, and dev ancestry.
- Independently audit three behavior claims:
  1. Later `text_delta` events with omitted `phase` keep the previous explicit phase in streaming and batch response building.
  2. Batch `done.stopReason === "content_filter"` matches streaming incomplete semantics and excludes compaction replacement.
  3. Adapter heartbeat regression rejects adapter-heartbeat protocol frames by checking any `data.type === "heartbeat"`, not only rich frames.
- Run local focused verification from the exact PR head against current `origin/dev`.
- If exact head remains mergeable and hosted checks are green, squash merge to `dev` with `--match-head-commit`.

### Scope OUT

- No changes to main/preview/release.
- No API redesign or UX decision.
- No unrelated bridge cleanup.
- No merge if CodeRabbit/latest review produces a current-head blocker or checks fail for an in-scope reason.

## Verification plan

- `git merge-base --is-ancestor origin/dev HEAD`
- `git diff --check origin/dev...HEAD`
- `bun test --isolate tests/bridge.test.ts tests/bridge-lifecycle.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`
- Hosted checks from `gh pr view 556 --json statusCheckRollup`

## PABCD notes

- Work class: C2/C3 boundary. It changes shared bridge behavior but is a two-file bugfix with regression tests and no security/data boundary.
- A-gate: Sol medium independent audit must return PASS/MERGE or non-blocking residuals before B/C completion.
- D-gate: record exact local command outputs, hosted checks, and merge URL or blocker.

## Result

- Outcome: DONE / merged.
- Initial live head: `8959f5e6f794c687cad45439cd310c050793851e`
- Maintainer follow-up commit: `de8942f0cad5b7a8aef85f242e9ae02c2e47fe76`
  - Changed `tests/bridge.test.ts` to run the batch `content_filter` case with `{ compaction: true }` and assert no `type: "compaction"` output item.
- Final live head: `18fade98c7d64ff3fc1adf1c21b40bd023526863`
  - Contributor added deterministic timer-seam heartbeat coverage and retained the compaction assertion.
- Merge commit on `dev`: `800ebc93101f244a77dc61483d3de6741d5f7ca5`
- PR URL: https://github.com/lidge-jun/opencodex/pull/556

## Verification evidence

- Local exact-head verification on `8959f5e6`:
  - `git merge-base --is-ancestor origin/dev HEAD`: pass
  - `git diff --check origin/dev...HEAD`: pass
  - `bun test --isolate tests/bridge.test.ts tests/bridge-lifecycle.test.ts`: 63 pass / 0 fail / 160 expect
  - `bun run typecheck`: pass after installing dependencies in the fresh worktree
  - `bun run privacy:scan`: pass
- Local maintainer patch verification on `de8942f0`:
  - `git diff --check origin/dev...HEAD && git diff --check`: pass
  - `bun test --isolate tests/bridge.test.ts tests/bridge-lifecycle.test.ts`: 63 pass / 0 fail / 161 expect
  - `bun run typecheck`: pass
  - `bun run privacy:scan`: pass
  - pre-push hook: `bun run typecheck`, `bun run lint:gui`, root tests 5069 pass / 0 fail / 24949 expect, `bun run privacy:scan`, React Doctor no issues
- Local final-head verification on `18fade98`:
  - `git diff --check origin/dev...HEAD`: pass
  - `bun test --isolate tests/bridge.test.ts tests/bridge-lifecycle.test.ts`: 63 pass / 0 fail / 162 expect
  - `bun run typecheck`: pass
  - `bun run privacy:scan`: pass
- Independent audit:
  - Kepler initial audit on `8959f5e6`: `VERDICT: PASS`; blockers 0; safety auth/security/data/permissions all no.
  - Kepler follow-up audit on `18fade98`: `VERDICT: PASS`; blockers 0; timer seam production-safe and heartbeat/content_filter tests deterministic.
- Hosted exact-head checks on `18fade98`:
  - CodeRabbit: pass, no actionable comments in recent review
  - enforce-target: pass
  - label: pass
  - react-doctor: pass
  - ubuntu-latest: pass
  - macos-latest: pass
  - windows-latest: pass
  - npm-global ubuntu-latest: pass
  - npm-global macos-latest: pass
  - npm-global windows-latest: pass

## Notes

- The final contributor commit widened the test surface but stayed inside the same bridge bugfix unit.
- No linked issue was closed by this PR.
- No security/auth/permission/data-migration boundary was changed.
