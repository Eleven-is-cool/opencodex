# 020 — PR #528 processing plan

Item: PR #528, `fix(images): Codex P2 follow-ups for image bridge (#424)`.

Planned bucket: `needs-human/security + request-changes`.

Audit update:

- Live re-check on 2026-07-27 confirmed head
  `553e9afc6f16135d83d8ab2d3ab0cb309675b81b`.
- GitHub reports `MERGEABLE/CLEAN` and green checks, but this head is stale relative
  to current `origin/dev@261abb7f`: merge-base `703c6191`, with current dev 143
  commits ahead and PR head 6 commits ahead.
- Owner review at current head has `CHANGES_REQUESTED`: `downloadImageToArtifact()`
  validates the hostname with `assertUrlResolvesPublic(url)` and then calls
  `fetch(url)`, which performs an independent second DNS resolution. A rebinding
  host can pass the public-address validation and connect to private/loopback or
  metadata space during the actual fetch.
- Current code records this as a residual in `src/images/artifacts.ts` lines 92-108
  and does not pin the validated address, validate the connected peer, or constrain
  downloads to a trusted-host contract. The tests cover literal/private/redirect
  rejection, but not the validation-public/connection-private rebinding case.

Scope IN:

- Confirm head `553e9afc`, base `dev`, merge state `MERGEABLE/CLEAN`.
- Compare actual diff and decide whether it can be merged independently.
- Identify paid-provider, download/SSRF, artifact, and routing surfaces.
- Leave or rely on request-changes evidence requiring DNS rebinding-safe remote
  download handling, rebase onto current `dev`, stale review-thread resolution, and
  fresh checks.

Scope OUT:

- Do not accept a new image-generation default, paid xAI routing decision, or
  remote-download SSRF boundary without maintainer/security review.
- Do not merge #424/#528 automatically.
- Do not resolve the #424 vs #355 product choice in this phase.

Verification:

- `gh pr view 528 --json ...`
- independent Sol review verdict
- GitHub comment URL if action is taken
