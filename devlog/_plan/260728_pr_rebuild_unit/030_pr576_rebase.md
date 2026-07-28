# 030 — PR #576 리베이스 (WP4)

## 현재 상태

| 항목 | 값 |
| --- | --- |
| 브랜치 | `codex/pr527-rebase` @ `935a0e977` (단일 커밋) |
| base | `dev` |
| mergeable | `CONFLICTING` / `DIRTY` |
| 체크 | `windows-latest` FAIL (WP3가 다루는 무관한 usage-debug 테스트), 나머지 전부 pass |
| 이력 | #527의 대체본. #527은 base가 `codex/catalog-written-signal`이라 enforce-target 실패 |

## 충돌 3파일 — A 게이트에서 초안을 전면 정정

> 초안은 `git merge-tree <base> <a> <b>`(구형 3-인자 형태)의 "changed in both" 출력을
> 충돌로 오독했다. 그 줄은 **양쪽에서 수정된 파일** 목록이지 충돌 목록이 아니다.
> 대부분은 git이 자동 병합한다. 실제 충돌은 `--write-tree`로 확인해야 한다.

`git merge-tree --write-tree --name-only origin/dev origin/codex/pr527-rebase` 실측:

```
4bbd96e83d80214734589bbc9c713b50ce90eb00
gui/src/pages/dashboard-overview-sections.tsx
src/cli/index.ts
src/server/management/config-routes.ts
```

| 파일 | 성격 |
| --- | --- |
| `src/cli/index.ts` | **로직** — CLI 커맨드 분기 |
| `src/server/management/config-routes.ts` | **로직** — 관리 API 라우트 |
| `gui/src/pages/dashboard-overview-sections.tsx` | **로직** — 대시보드 섹션 렌더 |

자동 병합되는 것(충돌 아님): `gui/src/i18n/{de,en,ja,ko,ru,zh}.ts` 6개,
`docs-site/.../codex-integration.md`, `docs-site/.../cli.md`.

**초안이 말한 것과 정반대다.** i18n·docs는 문제가 아니고, 세 개의 로직 파일이 문제다.
"텍스트 추가라 양쪽 다 채택하면 된다"는 해소 규칙은 이 세 파일에 적용하면 위험하다 —
`dev`가 그 사이 넣은 오류 처리 경로를 덮어쓸 수 있다.

## 해소 규칙 (파일별)

세 파일 모두 **헝크 단위로 읽고 판단한다.** 일괄 규칙 금지.

- `src/cli/index.ts` — `dev`가 #601/#602/#593로 커맨드 표를 바꿨다. 우리 PR이 넣는
  건 stale app-server 경고 호출 한 지점이다. `dev`의 구조를 기준으로 삼고 우리 호출을
  그 안에 다시 배치한다.
- `src/server/management/config-routes.ts` — 카탈로그 기록 후 신호를 내보내는 지점.
  `dev`의 응답 형태가 바뀌었으면 그쪽을 따르고 우리 필드를 추가하는 방향으로.
- `gui/src/pages/dashboard-overview-sections.tsx` — `dev`가 drain-and-restart 카드를
  넣었다(#580). 우리 경고 배너는 그와 별개 섹션이므로 공존시킨다.

각 해소마다 `git diff origin/dev -- <file>`로 **우리가 무엇을 추가했는지만** 남았는지
확인한다. `dev`의 라인이 사라졌으면 잘못 해소한 것이다.

## 절차 — 기존 워크트리 사용

> A 게이트 정정: `git worktree add`로 새 워크트리를 만들 수 없다.
> `codex/pr527-rebase`는 이미 `/Users/jun/.codex/worktrees/260728-pr527/opencodex`에
> 체크아웃돼 있어서 git이 거부한다.

```
cd /Users/jun/.codex/worktrees/260728-pr527/opencodex
git status --porcelain        # 더티면 중단
git rev-parse HEAD            # lease 기준 기록
git rebase origin/dev
```

리베이스 전 그 워크트리가 깨끗한지 반드시 확인한다. 더티면 손대지 않고 중단한다 —
다른 세션의 작업일 수 있다.

### 금지

- 다른 사람 브랜치 push 금지.
- `--force-with-lease`는 리베이스 직전 기록한 `origin/codex/pr527-rebase` 해시를
  명시적으로 넘겨서 쓴다.

## 검증

> A 게이트 정정: 초안의 검증 세트는 충돌 파일을 하나도 덮지 않았다.

```
bun run typecheck                     # src/ 만 커버 (tsconfig include: ["src"])
bun run build:gui                     # gui/ 타입체크 — i18n Record<TKey,string> 키 누락은 여기서만 잡힌다
bun run test                          # 충돌 3파일이 어느 테스트에 걸리는지 전수로 확인
bun run lint:gui
```

`bun run typecheck`는 `tsconfig.json`의 `"include": ["src"]` 때문에 `gui/`를 보지
않는다. GUI 타입 오류는 `build:gui`로만 드러난다.

`gui/scripts/sync-locale-keys.mjs`는 **검증 도구가 아니다** — 누락 키를 영어로 채워
`writeFileSync`하는 생성기다. 리베이스 중에 돌리면 작업 트리를 조용히 바꾼다. 쓰지 않는다.

## 완료 조건

- `gh pr view 576 --json mergeable` → `MERGEABLE`
- `gh pr checks 576`에서 잔여 실패가 없거나, 남은 실패가 이 PR과 무관함이 기록됨
- PR에 리베이스 사실과 헝크별 해소 근거 코멘트

## 의존

WP3가 먼저다. usage-debug 타임아웃이 남아 있으면 리베이스 후 windows CI가 다시
빨갛게 나오고, 그게 리베이스 탓인지 기존 결함 탓인지 구분할 수 없다.
