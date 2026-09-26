# Board UX guidelines

AWB uses a chat-first navigation hierarchy. Board navigation separates
operational board pages from reusable automation configuration.

## Navigation

The persistent desktop sidebar is ordered by user intent:

1. Chat and its independently scrollable room list;
2. Work (Boards and AI Agents);
3. Automation (Functions, Actions, Schedules);
4. Knowledge (Resources, Prompt Templates);
5. Quality (QA, Security);
6. Settings;
7. admin-only Operations diagnostics.

Mobile uses the same hierarchy in an off-canvas drawer. Do not create a second
navigation inventory for mobile or for Chat mode.

The Board header and sub-menu expose only board operations:

- board status controls such as Pause / Resume;
- ticket and feature views;
- Archive, Settings, and Benchmark when enabled;
- no reusable-definition manager links.

Reusable definitions retain independent type routes for direct access:

```text
/ws/:workspaceId/:managementType
/ws/:workspaceId/boards/:boardId/:managementType
```

Do not add a new board-only manager page for a reusable automation definition.
Reuse the same type manager and provide the Board context explicitly.

## Management menus

Functions, Resources, Prompt Templates, Actions, QA, Security, and Schedules are
independent feature entries. Credentials and Claude Profiles are independent
Settings entries. There is no intermediate Automation Catalog page.

- Functions, Credentials, Resources, and Prompt Templates use Global,
  Workspace, and Board scopes.
- Their Workspace page lists only Global plus the current Workspace rows.
- New definitions choose between `workspace_id = NULL` (Global) and the current
  Workspace directly on that page.
- Actions, QA, Security, and Schedules use Workspace and Board scopes because
  they bind workspace agents and retain workspace execution history.
- Scope is chosen only when an item is created and is immutable afterward.
- Board scope always requires a board belonging to the selected workspace.
- Every row shows a scope badge.

Claude backend definitions and Workspace assignment share the Claude Profiles
page. Workspace and Board QA definitions remain on the QA page. Agent Manager
runtime operations are integrated into AI Agents, while Workflow Health remains
an independent Admin diagnostic page. The internal system-QA and column-policy
APIs have no standalone navigation.

Settings pages use `/ws/:workspaceId/settings/*`. The Settings Overview page
groups related destinations, while the sidebar keeps direct one-click links to
each destination. Legacy workspace and Admin management URLs must redirect to
the canonical Settings route.

See [Catalog scopes](catalog-scopes.md) for the data model, inheritance rules,
authorization, and implementation checklist.

## Header behavior

- Keep state-changing controls visually separate from navigation.
- Keep primary actions to two or three items; put infrequent pages in overflow.
- Collapse labels before moving navigation into overflow on narrow layouts.
- Use shared tokens and common UI primitives rather than page-local button
  styles.
- Preserve the workspace and board context in every management link.

## New board UI checklist

- Use `PageHeader` and shared common controls.
- Keep routes under `/ws/:workspaceId/boards/:boardId`.
- Put reusable configuration in its type-specific Workspace/Board menu.
- Verify empty, loading, error, and permission-denied states.
- Verify keyboard focus, narrow layouts, and long names.
- Verify the target board belongs to the current workspace server-side.

## Progress indicators (session / chat / board / mission)

"이게 지금 돌고 있나, 내가 뭘 해야 하나, 끝났나?" 는 네 표면에서 같은 질문이고,
화면도 **같은 색·같은 단어·같은 애니메이션**으로 답해야 한다. 그 어휘의 단일 원천은
`apps/client/src/activity.ts` 이고, 그리는 것은 `components/common/ActivityIndicator.tsx`
의 두 프리미티브뿐이다.

| tone | 뜻 | 쓰는 곳 예 |
| --- | --- | --- |
| `idle` | 아무 일도 없음 — **점을 찍지 않는다** | 조용한 방, `pending` step, `todo` 티켓 |
| `queued` | 시작을 기다림 | `ready` step, `starting`/`ready` 세션 |
| `live` | 지금 돌고 있음 (숨쉬는 점) | `busy` 세션, `running` step/mission, `in_progress` 티켓, 작업 중인 방 |
| `attention` | **사람이 답해야** 진행됨 (링 펄스) | `awaiting_permission`, `awaiting_user`, `pending_user_action` |
| `stalled` | 멈춰 있음 | `blocked` step, `paused` mission |
| `done` / `failed` | 종료 | |

규칙:

- **상태 → tone 번역만** 각 표면이 한다. 색을 그 파일에서 고르지 말 것 — 사이드바 세션
  행에 자체 색 표가 있어 같은 `busy` 세션이 왼쪽에선 노란 점, 세션 화면에선 보라 pill 로
  보이던 것이 이 규칙이 생긴 이유다.
- 애니메이션 두 개는 뜻이 다르다: 숨쉬기(`awb-activity-live`)는 "스스로 진행 중",
  링(`awb-activity-attention`)은 "사람을 기다림". `attention` 에 숨쉬기를 주면 "곧 알아서
  될 것"으로 읽혀 정확히 반대 뜻이 된다. 새 `@keyframes` 를 컴포넌트에 인라인으로
  만들지 말 것(표면마다 다른 속도로 깜빡이던 원인).
- 좌측 프레임(사이드바 행, 목록 행, 보드 카드)은 **점**(`ActivityDot`), 우측 프레임
  헤더는 **점 + 라벨**(`ActivityPill`).
- 회귀: `apps/client/test/activity-vocabulary.test.mjs` — 네 표면의 "작업 중"이 같은 색
  값인지, `attention` 이 `live` 가 아닌지, 사이드바가 실제로 점을 그리는지까지 단언한다.
