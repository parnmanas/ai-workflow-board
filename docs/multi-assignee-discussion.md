# 다중담당자 논의 채널 (Multi-assignee discussion channel) — T3

여러 담당자가 **같은 phase(= 티켓이 현재 놓인 컬럼)** 에 함께 붙었을 때, 코멘트로
안전하게 논의를 굴리는 규약을 정리한다. (합의 **판정** 로직 자체는 T4 — 여기선
"논의" 를 매끄럽게 만들고, T4 가 얹을 자리만 예약한다.)

관련 코드: `apps/server/src/services/mention.service.ts`,
`apps/server/src/common/consensus-meta.ts`,
`apps/server/src/modules/mcp/tools/comment-tools.ts`,
`apps/server/src/modules/agents/trigger-loop.service.ts`.

## 1. 공동 담당자 전원 호출 = self-excluding role 멘션

역할에 홀더가 여러 명이면 (T1 멀티홀더) `@[role:<slug>]` 한 번이 그 역할의
**현재 전 홀더** 에게 각각 `comment_mention` 을 팬아웃한다 (T2). T3 은 여기에
**작성자 자동 제외** 를 더한다:

- `MentionService.resolveMentions(refs, ticket, { excludeActor: { type, id } })`
  가 resolved 집합에서 작성자와 `(type, id)` 가 일치하는 대상을 drop 한다.
  role 팬아웃 경로와 직접 `@[agent:<uuid>]` 경로 **양쪽** 에 적용된다.
- 3개 코멘트 경로가 작성자를 `excludeActor` 로 넘긴다: MCP `add_comment`,
  MCP `ask_question`, REST `_dispatchCommentMentions`.

따라서 공동 담당자는 `@[role:assignee]` 로 **자기를 뺀 나머지 담당자 전원** 을
안전하게 부를 수 있다. 별도 신규 MCP 파라미터는 없다 — 입력 스키마 불변, 규약만
바뀐다.

> **재귀 방지 (DoD #5).** self-exclusion 이 없으면 담당자가 `@[role:assignee]`
> 로 동료를 부를 때 자기 자신에게도 `comment_mention` SSE 가 날아가고,
> agent-manager 가 자기 subagent 를 재spawn → self-echo 무한 루프
> (watchdog exit-143 계열) 로 번진다. 작성자 제외는 dispatch 경로의 T2
> per-holder self-guard 를 멘션 경로에 그대로 미러한 것이다. "자기 자신은
> 구조적으로 절대 못 깨운다" + "할 말 없으면 멘션 중단" 종료 규약이 종결을 보장.

## 2. 논의 스레드 가시성 (parent_id)

같은 phase 논의는 루트 코멘트에 `parent_id` 를 걸어 하나의 스레드로 묶는다.
새 UI 대공사는 불필요하다 — 클라이언트 `CommentList` 가 이미 `parent_id`
들여쓰기와 `metadata.author_role` 배지를 렌더한다 (`parseComments` 가 두 필드를
투영). 추가 논의 UX 는 T6 로 위임.

- 논의 코멘트: `type: 'note' | 'chat'`, 답글은 `parent_id` = 답하는 코멘트.

## 3. 논의 ↔ 합의 경계 (T4 자리 예약)

두 종류의 코멘트가 같은 타임라인을 공유하므로 다운스트림(디스패치 팬아웃, 미래
합의 게이트, 클라이언트)이 반드시 구분할 수 있어야 한다. 경계 문자열은
`apps/server/src/common/consensus-meta.ts` 한 곳에만 산다:

| 종류 | 표식 | 팬아웃 |
| --- | --- | --- |
| **논의 (T3)** | `type note/chat`, consensus 마커 없음 | 정상 (co-holder 를 깨움) |
| **합의 (T4)** | `metadata.consensus_vote === true` (T4 가 스탬프) | **억제** — 투표가 서로를 ping-pong 재트리거하지 않게 |

- `CONSENSUS_VOTE_META_KEY = 'consensus_vote'` + `isConsensusVoteComment()` 가
  단일 진실원. `trigger-loop._commentSuppressesFanout` 이 이 predicate 를 쓴다.
- `DISCUSSION_META_KEY = 'discussion'` 은 논의 코멘트가 선택적으로 달 수 있는
  advisory 마커 (게이트에 영향 없음 — 네임스페이스 충돌만 예약).
- **오늘은 동작 변화 0**: 아직 아무 데서도 `consensus_vote` 를 스탬프하지 않아
  `isConsensusVoteComment` 는 항상 false. T4 가 스탬프하는 순간 억제가 살아난다.

## 4. plugin-sync

MCP tool 목록·입출력 스키마는 불변이고 설명 문자열(`MENTION_SYNTAX_DOC`)만
갱신됐다. `proxy.mjs` 는 순수 forwarder 로 live 스키마를 실시간 중계하므로
**plugin 버전 범프 불필요** (DoD #6).
