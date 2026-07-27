# 023 — Issue #545 64-token classifier retry triage

Item: Issue #545, `Desktop 3P + Auto Mode: Request for Sonnet Permission Classifier Cuts Tokens at 64 and Repeats Up to 5 Times`.

Live state on 2026-07-27:

- State: open.
- Labels: `bug`, `needs-info`.
- Confirmed sub-bug C from the original report, request-log misclassification of
  `response.incomplete / max_output_tokens`, was fixed on `dev` in `7fcaa911`.
- Reporter then supplied an inbound structural capture: five identical Claude Desktop
  3P Auto Mode classifier-shaped inbound requests, each with `max_tokens: 64`,
  `stop_sequences: ["</block>"]`, `thinking.type: disabled`, large system shape, no
  tools, and terminal `response.incomplete` reason `max_output_tokens`.
- Latest maintainer comment states that this confirms repeated 64-token behavior but
  not that OpenCodex created the large system payload or lost the stop sequence. The
  next decisive evidence is one redacted outbound provider request for a failed attempt:
  `max_tokens`, `stop_sequences`, system block count/total chars, and whether the short
  Claude OAuth identity block was prepended.

Code/context check:

- `src/claude/inbound.ts` maps caller `max_tokens` to internal `max_output_tokens`.
- `src/claude/inbound.ts` maps caller `stop_sequences` to internal `stop`.
- `src/claude/outbound.ts` maps internal `response.incomplete` with
  `incomplete_details.reason === "max_output_tokens"` back to Anthropic
  `stop_reason: "max_tokens"`.
- `src/server/request-log.ts` now records structured `max_output_tokens` incomplete
  terminals as successful status 200, while keeping adapter EOF/stall/content-filter
  failures closed. `tests/request-log.test.ts` covers the requested-output-limit case.

Decision:

- Bucket: `needs-info`.
- No functional code change: raising Claude Desktop's explicit 64-token classifier cap
  would change client semantics, and auth/routing/direct-bridge changes are not justified
  without outbound provider-shape evidence.
- No duplicate GitHub comment: the latest maintainer comment already asks for the exact
  remaining artifact.
- Do not add a new outbound structural logger in this workphase; that is a privacy and
  diagnostics surface change, not a proven functional fix.

Verification:

- `gh issue view 545 --json state,labels,comments,title,updatedAt`
- `git branch --contains 7fcaa911 --all`
- targeted code inspection for Claude max-token/stop-sequence mapping and request-log
  incomplete classification.
