# 022 — Issue #547 Claude Desktop custom-model visibility triage

Item: Issue #547, `Cannot use custom models in claude desktop`.

Live state on 2026-07-27:

- State: open.
- Labels: `bug`, `needs-info`.
- Latest maintainer comment already asks the reporter to retry with a build containing
  #552 (`7c74e0a2`), fully quit Claude Desktop including the tray process, run
  `ocx claude desktop`, `ocx claude desktop show --json`, and verify the Windows
  `%LOCALAPPDATA%\Claude-3p\configLibrary\_meta.json` path.

Code/context check:

- #552 is on current `dev` and on this triage branch.
- `src/claude/desktop-3p-paths.ts` now mirrors Claude Desktop's 3P `GE()` resolver:
  explicit `CLAUDE_USER_DATA_DIR` is used verbatim, Windows prefers
  `%LOCALAPPDATA%\Claude-3p`, and the normal macOS/Linux roots append `-3p`.
- `tests/claude-desktop-config-path.test.ts` covers Windows `LOCALAPPDATA`,
  explicit user-data roots, Linux/macOS defaults, and status active-profile detection.
- Existing issue evidence does not yet prove a remaining second-stage Desktop model-picker
  bug after #552.

Small docs/SOT repair:

- While processing this issue, the English Claude guide and `structure/04_transports-and-sidecars.md`
  still described the old non-3P `Claude/configLibrary` path. They were updated to match
  the current #552 resolver and the maintainer's issue instructions.

Decision:

- Functional bucket: `needs-info`; leave the issue open.
- No duplicate GitHub comment: the latest maintainer comment already contains the exact
  retry commands and required evidence.
- Docs bucket: small safe fix on `dev` for stale path documentation.

Verification:

- `gh issue view 547 --json state,labels,comments,title,updatedAt`
- `git branch --contains 7c74e0a2 --all`
- targeted docs/code pointer inspection.
