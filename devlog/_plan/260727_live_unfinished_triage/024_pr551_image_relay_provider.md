# 024 — PR #551 custom Images relay provider

## Scope

- Unit: PR #551 `fix(images): support custom image relay providers`, linked issue #549.
- Bucket: takeover-fix / merge-candidate after live checks.
- Target branch: `dev` only.
- Worktree used for PR head verification and takeover patch:
  `/Users/jun/.codex/worktrees/260727-pr551-current/opencodex`.

## Live baseline

- Initial live head checked in this work-phase: `050347f1936df9f6c6554ff3c058e83c43bfaf8c`.
- Contributor had already addressed the original owner blockers from `35fb1f8b`:
  - explicit keyed Images provider can accept Bearer admission without forwarding the proxy secret;
  - structure docs narrowed unsupported multipart-forwarding claims to JSON Images requests.
- PR branch was still behind live `origin/dev`; rebased cleanly onto
  `261abb7ff7826f82713e0ae033ab930cb78923f7`.
- Rebased PR head pushed to fork branch:
  `ab652affb9333d5f586424970c05f8c76418e867`.

## Original blocker audit

- Plato reviewer verdict: both owner blockers at `35fb1f8b` were concrete and narrowly fixable, but current contributor head `050347f1` had already implemented them.
- Local verification before rebase:
  - `bun test tests/server-images.test.ts` — 27 pass / 0 fail.
  - `bun x tsc --noEmit` — pass.
  - `bun run privacy:scan` — pass.
  - `git diff --check origin/dev...HEAD` — pass.
- Local verification after rebase:
  - `bun test tests/server-images.test.ts` — 27 pass / 0 fail.
  - `bun x tsc --noEmit` — pass.
  - `bun run privacy:scan` — pass.
  - `git diff --check origin/dev...HEAD` — pass.
- Pre-push hook after rebase:
  - `bun run typecheck` — pass.
  - `bun run lint:gui` — pass.
  - `bun run test` — 5065 pass / 0 fail.
  - `bun run privacy:scan` — pass.
  - `bun run doctor:gui:if-changed` — React Doctor no issues.

## Current CodeRabbit blocker on `ab652aff`

CodeRabbit found one valid current-head issue:

- `src/server/images.ts`: invalid explicit `images.provider` plus
  `Authorization: Bearer <OPENCODEX_API_AUTH_TOKEN>` on a non-loopback bind returned 401 before surfacing the explicit provider configuration error.
- Expected behavior: selection/config errors for explicit Images provider return existing `400 invalid_request_error` before forward-admission validation, because no upstream request can be selected and no secret forwarding path exists.

## Takeover patch / concurrent author patch

- `src/server/images.ts`
  - Move `candidates.error` handling immediately after `selectImagesProvider(config)`.
  - Keep `validateForwardAdmissionCredential()` for non-explicit-keyed paths.
  - Preserve valid explicit keyed provider Bearer admission behavior.
- `tests/server-images.test.ts`
  - Add regression:
    `an invalid explicit Images provider returns its configuration error before bearer admission`.
  - Scenario: non-loopback hostname, invalid `images.provider`, Bearer proxy admission secret.
  - Expected: HTTP 400, no upstream request, message includes the provider configuration error.

## Local verification after takeover patch

- `bun test tests/server-images.test.ts` — 28 pass / 0 fail.
- `bun x tsc --noEmit` — pass.
- `bun run privacy:scan` — pass.
- `git diff --check origin/dev...HEAD && git diff --check` — pass.
- Sol reviewer Peirce verdict on the local equivalent patch: PASS.
- Local pre-push gate on takeover commit `a3a9fae3` before the safe push rejection:
  - `bun run typecheck` — pass.
  - `bun run lint:gui` — pass.
  - `bun run test` — 5066 pass / 0 fail.
  - `bun run privacy:scan` — pass.
  - `bun run doctor:gui:if-changed` — React Doctor no issues.
- The PR author concurrently pushed the same behavioral fix before the local force-with-lease push could land:
  - remote moved from `ab652affb9333d5f586424970c05f8c76418e867` to
    `f51b64ae281091b0e4580e02f42b44d55af3ea2b`;
  - force-with-lease rejected the local push as intended;
  - the remote head was verified instead of overwriting contributor work.

## Current remote head verification

- Current remote head: `f51b64ae281091b0e4580e02f42b44d55af3ea2b`.
- Base: `dev` at `261abb7ff7826f82713e0ae033ab930cb78923f7`.
- `git merge-base --is-ancestor origin/dev HEAD` — exit 0.
- `src/server/images.ts:51-53` returns `400 invalid_request_error` before `validateForwardAdmissionCredential()`.
- `tests/server-images.test.ts:430-459` covers non-loopback invalid explicit provider + Bearer admission and verifies 400/no upstream call.
- `bun test tests/server-images.test.ts` — 28 pass / 0 fail.
- `bun x tsc --noEmit` — pass.
- `bun run privacy:scan` — pass.
- `git diff --check origin/dev...HEAD` — pass.
- GitHub visible check: `label` — pass.
- `mergeable`: MERGEABLE.
- `reviewDecision`: CHANGES_REQUESTED from stale owner review on old head; every named blocker has current-head verification.

## Next gate

- Merged PR #551 with exact-head guard:
  - command used `--match-head-commit f51b64ae281091b0e4580e02f42b44d55af3ea2b`;
  - merge commit: `14ae6fe991c3b2e3517336d23dc8b4a393a6b565`;
  - PR URL: https://github.com/lidge-jun/opencodex/pull/551.
- Fetched `origin/dev` after merge:
  - `origin/dev` = `14ae6fe991c3b2e3517336d23dc8b4a393a6b565`.
- Closed issue #549 with fix evidence:
  - issue URL: https://github.com/lidge-jun/opencodex/issues/549.
