# 021 — Issue #543 Kiro Opus 5 queued-message triage

Item: Issue #543, `Kiro claude-opus-5 ignores Claude Code mid-turn queued messages while opus-4.8 works`.

Live state on 2026-07-27:

- State: open.
- Labels: `bug`, `provider-compatibility`, `needs-info`.
- Latest maintainer comment already narrowed the report to the Kiro `claude-opus-5`
  route or its catalog/1M path. The same proxy with `kiro/claude-opus-4.8` works,
  so the original broad claim that OpenCodex drops every Claude Code mid-turn queue
  is no longer supported.
- Remaining decisive artifact: an Opus 5-only inbound `/v1/messages` capture using
  marker `OCX_QUEUE_543`, showing whether the marker is present or absent in the
  first request after Claude Code removes the queued item.

Code/context check:

- `src/lib/debug-settings.ts` exposes `ocx debug claude on|off|status|reset` and
  `OCX_CLAUDE_DEBUG=1`.
- `src/claude/inbound-debug.ts` intentionally stores allowlist scalar metadata only:
  no prompt text, no raw objects, no stable cross-run hashes.
- The docs describe `GET /api/claude/inbound-debug`, but this existing debug ring
  cannot by itself prove marker presence/absence because it intentionally does not
  persist content text or content-block shapes.

Decision:

- Bucket: `needs-info` / `provider-compatibility`.
- No code change in this workphase. A translator fix would be speculative until the
  Opus 5 wire capture proves the marker is present on the inbound Anthropic body and
  then missing after translation.
- No new GitHub comment: the latest maintainer comment already requests exactly the
  decisive Opus 5 wire capture and documents the workaround (`kiro/claude-opus-4.8`
  or native).

Verification:

- `gh issue view 543 --json state,labels,comments,title,updatedAt`
- `rg` for Claude inbound debug support and queued-command mentions.
