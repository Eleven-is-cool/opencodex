# 027 — PR #533 npm cache update recovery triage

## Scope

- PR: https://github.com/lidge-jun/opencodex/pull/533
- Live head at phase start: `2f21501e86a267f9112c6b165cdfbce085f14f7b`
- Base: `dev`
- Labels: `bug`
- State at phase start: open draft, `CHANGES_REQUESTED`, mergeability `UNKNOWN`

## Initial live evidence

- PR title: `fix(update): preserve proxy on npm cache failures`
- Changed files: update installer/recovery code, npm cache preflight, process-tree management, config PID identity cache, docs, and focused update tests.
- Latest live checks shown by `gh pr list` are not a full current cross-platform matrix: enforce-target, label, and CodeRabbit are green; draft status remains true.
- Prior maintainer review requested changes after Windows failures and additional review findings. Later commits addressed many comments, but the PR remains draft and reviewDecision remains `CHANGES_REQUESTED`.

## Risk classification

This is a real bugfix candidate, but it touches update/install/recovery process boundaries, PID identity, process-tree cleanup, local filesystem ownership, logging privacy, and automatic restart behavior. It is not eligible for immediate merge. WP15 must decide whether takeover is safe and bounded, or whether the correct action is request-changes / needs-human-security.

## Current working hypothesis

Hold from merge until:

1. current head is rebased/mergeable against latest `origin/dev`;
2. latest actionable review findings are proven addressed or invalid;
3. focused update suites pass locally;
4. hosted Windows/macOS/Linux matrix passes on the latest head;
5. the updater recovery security boundary has explicit maintainer/security review if still changing process spawning, ownership, or kill behavior.

## Current-head recheck and author review

- Latest PR head investigated: `2f21501e86a267f9112c6b165cdfbce085f14f7b`.
- Latest `origin/dev` used for takeover rebase: `800ebc93101f244a77dc61483d3de6741d5f7ca5`.
- Before rebase, the PR stack was behind/ahead `41/14` relative to `origin/dev`; after clean rebase it was `0/14`.
- Latest Wibias review comment: https://github.com/lidge-jun/opencodex/pull/533#issuecomment-5091674612
- Review blockers accepted as valid:
  - High: npm cache preflight checked ownership but not effective access, so same-UID non-writable/cache ACL states could pass before proxy stop.
  - High: installer stdout/stderr could persist raw home/cache paths and uid/gid values into `update-job.json`.
  - Medium: nonzero installer recovery policy remains a maintainer decision; not fixed or merged automatically in this work-phase.

## Independent review

- Epicurus read-only audit classified #533 as `takeover-fix`, but only for the two High blockers. It recommended leaving the medium recovery-policy item to maintainer review.
- Volta post-patch audit returned `PASS` on `d215cbeb9d712e123e3eebadd0ee5ef471747b03`:
  - same-UID access denial now fails closed in `src/update/npm-cache-preflight.mjs`;
  - cache gate remains before proxy stop in both CLI and npm launcher paths;
  - persisted update-job fields are sanitized on write;
  - focused audit verification passed with `86 pass / 0 fail`.

## Takeover implementation

- Worktree: `/Users/jun/.codex/worktrees/260727-pr533-current/opencodex`
- Branch: `codex/pr533-update-recovery-hardening`
- Patch commit: `d215cbeb9d712e123e3eebadd0ee5ef471747b03` (`fix(update): harden npm recovery preflight logs`)
- Code pointers:
  - `src/update/npm-cache-preflight.mjs`: effective access check added with `R_OK|W_OK|X_OK` for directories and `R_OK|W_OK` for files.
  - `src/update/npm-cache-preflight.d.mts`: injectable `access(path, mode)` seam added for regression coverage.
  - `src/update/job.ts`: update-job command/log/error fields sanitized before persistence.
  - `tests/update-npm-cache-preflight.test.ts`: same-UID effective access denial regression.
  - `tests/update-job.test.ts`: installer-derived raw `/home/alice/.npm/_cacache...` and `uid=1001` persistence regression.

## Verification

- `bun test tests/update-npm-cache-preflight.test.ts tests/update-job.test.ts` → `70 pass / 0 fail`
- `bun test tests/update-npm-cache-preflight.test.ts tests/update-stop-first.test.ts tests/update-job.test.ts tests/update-install-process.test.ts tests/config.test.ts tests/ocx-launcher-source.test.ts tests/windows-deploy-close-regressions.test.ts` → `162 pass / 0 fail`
- `bun x tsc --noEmit` → pass
- `git diff --check origin/dev...HEAD` → pass
- `bun run privacy:scan` → pass
- pre-push full gate:
  - `bun run typecheck` → pass
  - `cd gui && bun run lint` → pass
  - `bun scripts/test.ts` → `5127 pass / 0 fail / 25156 expect() calls`
  - `bun scripts/privacy-scan.ts` → pass
  - React Doctor changed scope → no issues found

## External state

- Takeover PR opened as draft: https://github.com/lidge-jun/opencodex/pull/557
- Comment left on original PR #533: https://github.com/lidge-jun/opencodex/pull/533#issuecomment-5092875364
- Initial #557 hosted state: `UNSTABLE` because checks are in progress; CodeRabbit already success, CI/target/label/react-doctor still running at creation time.

## Final classification

`takeover-fix` plus `needs-human/security` before merge.

The two concrete High review blockers have a maintainer takeover PR with local and pre-push evidence. Original PR #533 remains open/draft and is not merged. PR #557 is also draft and must wait for hosted CI plus maintainer/security review on the remaining update recovery policy before any merge decision.
