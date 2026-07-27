# 025 — PR #555 / Issue #521 web-search SSE heartbeat triage

## Scope

- Work phase: WP13
- PR: #555 `fix(bridge): keep wire heartbeats during adapter-only progress (#521)`
- Issue: #521 `499 client_closed_request errors during web-search tool usage`
- Target branch: `dev`
- Original live PR head: `953eaf92e89e9d6dda75d229a694f83be7d2264a`
- Rebased / merged head: `d2bef1345f6f14de22902d365191bb8f3fa352e9`
- Merge commit on `origin/dev`: `df57bd96025ea322321a16b504f95eb7bfb42026`

## Live state and classification

Live PR #555 was a non-draft bugfix PR against `dev`, initially `MERGEABLE` but behind current `origin/dev` by 60 commits and ahead by 1 commit:

```text
git rev-list --left-right --count origin/dev...HEAD
60  1
```

Classification: `merge now` after maintainer rebase and verification.

Reason:

- Issue #521 had actionable evidence: Desktop received `200 OK` / `text/event-stream`, then no decoded frames for about five minutes until SSE idle timeout.
- PR #555 changed only `src/bridge.ts` and `tests/bridge.test.ts`.
- The change separates upstream liveness from client-visible wire activity:
  - `src/bridge.ts`: `upstreamActivity` resets only the stall watchdog.
  - `src/bridge.ts`: `wireActivity` controls whether a parser-ignored `response.heartbeat` must be emitted.
  - `tests/bridge.test.ts`: regression proves `response.heartbeat` keeps firing while only adapter heartbeats flow.

## Verification

Local focused / rebased head:

```text
git rebase origin/dev
HEAD=d2bef1345f6f14de22902d365191bb8f3fa352e9
git rev-list --left-right --count origin/dev...HEAD
0  1
git diff --check origin/dev...HEAD
bun test tests/bridge.test.ts
46 pass / 0 fail / 129 expect() calls
bun x tsc --noEmit
pass
bun run privacy:scan
Privacy scan passed
```

Pre-push full gate before force-with-lease push to contributor branch:

```text
bun run typecheck
pass
cd gui && bun run lint
pass
bun scripts/test.ts
5067 pass / 0 fail / 24942 expect() calls
bun scripts/privacy-scan.ts
Privacy scan passed
bun scripts/doctor-gui-if-changed.ts
React Doctor: No issues found
```

Hosted PR checks on `d2bef1345f6f14de22902d365191bb8f3fa352e9`:

```text
CodeRabbit: pass
enforce-target: pass
label: pass
react-doctor: pass
ubuntu-latest: pass
windows-latest: pass
macos-latest: pass after rerun
npm-global ubuntu-latest: pass
npm-global windows-latest: pass
npm-global macos-latest: pass
```

The first hosted `macos-latest` attempt failed with one unrelated timeout:

```text
1 tests failed:
(fail) shellStreamExec completion acknowledgement > appends structured shellResult and streamClose after the exit event [5006.59ms]
^ this test timed out after 5000ms.
5066 pass / 1 fail
```

The failed macOS job was rerun and passed. This failure did not touch the PR's bridge/web-search code path.

Independent Sol audit:

```text
VERDICT: MERGE
No auth/security surface changed; the new frame contains no credentials or request data.
Missing verification: no fresh real Alibaba qwen3.8-max-preview + Codex Desktop run lasting over five minutes or raw SSE capture.
This is desirable post-merge confirmation, not a blocker.
```

## External actions

- Rebased contributor branch using maintainer permission:
  - `953eaf92` → `d2bef134`
  - force-with-lease used against the previous head.
- PR #555 squash-merged into `dev` with exact head guard:
  - PR: https://github.com/lidge-jun/opencodex/pull/555
  - merge commit: `df57bd96025ea322321a16b504f95eb7bfb42026`
- Issue #521 was still open after merge and was closed manually with fix evidence:
  - https://github.com/lidge-jun/opencodex/issues/521

## Decision

Done. PR #555 is merged, Issue #521 is closed, and the only hosted failure was rerun to green.
