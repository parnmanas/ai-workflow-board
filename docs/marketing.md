# Marketing (에이전트 기반 제품 마케팅 루프)

`/marketing` 에서 **캠페인**을 만들면, 캠페인 에이전트가 주기(cycle)마다 깨어나
채널 탐색 → 채널별 커뮤니케이션 → 예산 편성·집행 → 결제 → 성과 분석 → 피드백 → 제품 개선
티켓의 루프를 돈다. **실행 주체는 에이전트이고, 돈 · 외부 발신 · 채널 개설은 사람이 정한다.**

- 서버 모듈 `modules/marketing`, MCP 툴 `modules/mcp/tools/marketing-tools.ts`,
  화면 `apps/client/src/components/marketing/*`, 상수·순수 규칙 `apps/server/src/common/marketing/*`.
- 엔티티는 전부 Account 소유(`account_id`)이고 서로를 평문 varchar 로 참조한다(DB FK 없음).
  상세·쓰기는 객체의 실제 소유 계정으로 권한을 검사한다(`docs/ownership.md`).
- **agent-manager 변경 없음, SSE contract 변경 없음.** 사이클은 Automation Schedule 과 같은
  "방을 열고 에이전트를 앉혀 첫 메시지를 보낸다" 모양으로 깨운다. `marketing_update` SSE 는
  UI 전용(user-only filter) 이벤트다.

## 원칙

1. **에이전트는 제안하고, 사람이 정하고, 서버가 집행한다.** 에이전트에게 결제 키 · 메일 API 키 ·
   채널 토큰을 주지 않는다(`agent_env` 금지). 에이전트는 MCP 로 "이걸 해 달라" 를 남기고,
   사람이 화면에서 본 **그 내용 그대로** 서버가 실행한다. 승인 MCP 툴은 존재하지 않는다.
2. **돈에는 자동 모드가 없다.** 모든 지출은 `marketing.approve_spend` 를 가진 사람이 금액 · 통화 ·
   수취인 · 목적 · 실행 payload 를 보고 승인해야 한다. 승인 시점에 한도를 **다시** 검사한다.
3. **한도는 원장에서 계산한다.** 잔액 칼럼은 없다. append-only `marketing_ledger_entries` 의
   합이 곧 사용액 · 보류액이다. 원장과 감사 로그를 고치거나 지우는 코드 경로는 없다
   (`db-retention.service.ts` 의 정리 대상도 아니다).
4. **외부 발신은 전부 사람 승인.** 게시글 · 댓글 · 메일은 초안으로 쌓이고 승인해야 나간다.
   자동 게시 정책은 두지 않는다 — 수집한 피드백(외부인이 쓴 글)이 사이클 지시문에 들어가므로
   프롬프트 주입이 곧 외부 발신이 되는 길을 막는다. 메일 수신자는 **사람이 넣은 동의 연락처뿐**이고
   에이전트는 연락처를 추가할 수 없다.
5. **채널은 에이전트가 찾고 사람이 연다.** 에이전트는 근거와 함께 후보를 제안하고, 사람이 승인해야
   활성화된다. 에이전트는 `OutreachChannel` 을 만들 수 없다.
6. **제품 개선은 AWB 티켓으로 흘러간다.** bug/feature 피드백은 캠페인의 제품 Project 에
   `TicketService.create` 로 들어가고, 이후는 일반 티켓 dispatch 루프의 일이다.
7. **비신뢰 입력은 데이터로만.** 외부에서 들어온 글은 사이클 지시문에서 비신뢰 블록으로 격리하고,
   잘라내고, 링크를 지운다. 수취인은 사람이 관리하는 허용 목록 안에서만 고를 수 있다.

## 엔티티

| 엔티티 | 테이블 | 역할 |
| --- | --- | --- |
| `MarketingCampaign` | `marketing_campaigns` | 제품(Project) · 브리프 · 목표 · capabilities · 에이전트 RuntimeSpec · 주기 · 통화 · 한도 · 수취인 허용 목록 · 링크 허용 도메인 · 일일 상한 |
| `MarketingChannel` | `marketing_channels` | 캠페인의 채널(연결 테이블 + 탐색 근거). kind `outreach`(OutreachChannel 연결) / `email` / `manual` |
| `MarketingPost` | `marketing_posts` | 채널별 콘텐츠(게시글 · 댓글 · 메일). draft → approved → publishing → published |
| `MarketingEmailSend` | `marketing_email_sends` | 메일 1통 = (post × contact). 큐 · 야간 보류 · 결과 |
| `MarketingContact` | `marketing_contacts` | 메일 수신자와 동의 증거 · 수신거부 · 삭제 후 억제 해시 |
| `MarketingBudgetAllocation` | `marketing_budget_allocations` | 채널별 예산 편성(append-only 버전). 에이전트 제안 → 사람 승인 |
| `MarketingSpendRequest` | `marketing_spend_requests` | 지출 요청과 상태 기계 |
| `MarketingLedgerEntry` | `marketing_ledger_entries` | append-only 원장 |
| `MarketingLink` | `marketing_links` | 추적 링크 |
| `MarketingMetric` | `marketing_metrics` | 채널/콘텐츠별 지표 관측치 |
| `MarketingFeedback` | `marketing_feedback` | 에이전트·사람이 기록한 피드백과 연결 티켓 |
| `MarketingCycle` | `marketing_cycles` | 루프 1회(방 · 요약 · 다음 행동) |
| `MarketingAuditEvent` | `marketing_audit_events` | append-only 감사 로그 — 모든 결정 · 발신 · 결제 호출 · 동의 변경 · 설정 변경 |

### 기존 것과의 경계 (왜 새로 만들었나 / 무엇을 재사용하나)

- **커넥터는 outreach 것을 그대로 쓴다** — `resolveChannelConnector` · `resolveOutreachCredential` ·
  공용 rate limiter. 게시 대상은 그 OutreachChannel 의 `targets` 화이트리스트 안이어야 한다.
- **게시물 원장은 따로 둔다**(`MarketingPost` ≠ `OutreachOutboundPost`). 권한이 다르고
  (`marketing.manage` vs `MANAGE_RESOURCES`), OutreachChannel 이 없는 `manual` · `email` 채널이 있고,
  캠페인 · 링크 · 공개 문구 같은 캠페인 고유 필드가 붙는다. 승인 claim(`draft→publishing` 조건부
  UPDATE)과 `(channel_id, dedupe_key)` 유일 인덱스 패턴은 같다.
- **폴링 피드백은 `OutreachInboundItem` 에 남는다.** 그 채널의 수집 · 중복 제거 · 분류 · 티켓 생성은
  outreach ingest 의 일이고, 리포트는 연결된 OutreachChannel 의 inbound 를 센다.
  `MarketingFeedback` 은 에이전트 · 사람이 직접 기록하는 것(수동 채널, 메일 답장, 관찰한 댓글)만 담는다.
- **사이클은 자기 tick 을 갖는다**(Automation Schedule 행을 만들지 않는다). 지시문이 발화 시점의
  캠페인 상태로 만들어져야 하고, 앞 사이클이 아직 돌면 건너뛰어야 하며, 캠페인 일시정지가 곧
  중단이어야 한다 — Automation Schedule 은 고정 프롬프트 · fire-and-forget 이라 셋 다 hook 이 필요하고,
  `/schedules` 에서 같은 일정을 따로 편집하는 두 번째 표면이 생긴다. cron 의미는 같은
  `qa-cron` 헬퍼와 "발화 전에 커서 전진" 규칙을 써서 두 벌이 되지 않게 한다.

## Capabilities (옵션 조합)

캠페인은 아래 기능을 골라 켠다. 꺼진 기능의 MCP 툴은 그 캠페인에 대해 거부된다.

| key | 의미 |
| --- | --- |
| `channel_discovery` | 에이전트가 채널 후보를 제안한다 |
| `community_post` | 커뮤니티 게시글/댓글 초안 |
| `email` | 동의 연락처에게 보낼 메일 초안 |
| `feedback_collect` | 피드백 기록(에이전트) + 연결 채널의 수집 |
| `feedback_to_product` | bug/feature 피드백을 제품 Project 티켓으로 |
| `analytics` | 추적 링크 · 지표 기록 · 채널별 성과 리포트 |
| `paid_spend` | 예산 편성 제안 · 지출 요청 |

일일 상한(캠페인 `limits`, 최근 24시간 생성 수): 초안 20 · 지출 요청 5 · 링크 50 · 채널 제안 10 ·
피드백 티켓 3. 열린 피드백 티켓이 10 개 이상이면 새 티켓을 만들지 않고 피드백만 기록한다(`capped`).

## 채널 탐색

에이전트 `propose_marketing_channel` 이 후보를 남긴다: platform(reddit · github · hacker_news · x ·
discord · forum · newsletter · email · other), 대상, **실제로 열어 본** 근거 URL, 청중 규모와 관측일,
홍보 규칙 인용과 그 URL, 적합 이유, 제안 톤 · 빈도. 사람이 승인하면:

- reddit/github — 기존 OutreachChannel 을 고르거나, 화면에서 credential 을 골라 새로 만든다
  (OutreachChannelService 를 거쳐 그 검증을 그대로 탄다). 연결이 없으면 `awaiting_credential`.
- email — 메일 credential · 발신자 · 주소 · 수신 목록을 채우면 `active`.
- 그 밖 — `manual`(사람이 게시하고 링크를 기록).

상태: `proposed → active | awaiting_credential | rejected`, `active ↔ paused`.

## 커뮤니케이션

에이전트 `draft_marketing_post(channel_id, title, body, reply_to?)` → `draft`. 채널 가이드 · 홍보 규칙이
승인 화면에 같이 보인다. 서버가 캠페인의 **공개 문구**(`disclosure`, 기본 "제품 제작자가 작성했으며
AI 도움을 받았습니다")를 본문 끝에 강제로 붙인다. 승인(내용 수정 가능 — 수정은 claim 과 같은
UPDATE 에서 일어나 승인한 글과 나간 글이 갈리지 않는다)하면 서버가 게시한다.

- outreach 채널 — 커넥터 `publish` / `reply`, 결과 permalink 기록. 실패는 `failed` + 사유.
- manual 채널 — `approved` 로 남고, 사람이 직접 올린 뒤 permalink 를 기록하면 `published`.
- email 채널 — 승인이 **발송 큐**를 만든다(아래).

## 메일

- 수신자는 사람이 REST 로 넣는 동의 연락처뿐(JSON/CSV 가져오기). 동의 증거를 같이 받는다:
  방법 · 시각 · 출처 · 동의 문구 버전, 야간 수신 동의 여부, 국가 · 시간대.
- 발송 조건: `subscribed` + 동의 2년 이내(넘으면 재확인 전까지 제외) + 억제 목록 아님.
  수신자 현지 21:00–08:00 이고 야간 동의가 없으면 `deferred` 로 미뤘다가 허용 시간에 보낸다.
- 서버가 강제로 넣는 것: 제목 앞 광고 표기(채널 `ad_label`, 기본 `(광고)`, 비울 수 없음 —
  KR 수신자는 항상 `(광고)`), 본문 끝 발신자명 · 주소 · 연락처 · 수신거부 링크,
  `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` 헤더. 발신자 정보가
  비어 있으면 발송을 거부한다.
- 수신거부: 공개 `GET /api/m/u/:token`(확인 화면) · `POST /api/m/u/:token`(처리, one-click 겸용).
  즉시 처리하고 처리 결과를 페이지와 안내 메일로 알린다. 유효/무효 토큰의 응답이 같다.
  토큰은 256-bit 난수. 연락처 삭제(erase)는 주소를 지우고 `email_hash` 만 남겨 다시 가져와도
  억제된다.
- 공급자: `resend` · `sendgrid` (메일 credential 의 `provider` 필드). 키는 서버만 복호화한다.

## 예산 편성 · 집행 · 결제

금액은 **정수 최소 단위(minor units)** 문자열/정수와 ISO 4217 통화(캠페인 하나에 하나)다.
지수: KRW · JPY = 0, 그 밖 = 2. 부동소수 · 0 이하 · 안전 정수 초과 금액은 거부한다.

### 한도

- 캠페인: `budget_total_minor`(0 = 지출 불가), `budget_period`(`none|week|month`, UTC) +
  `budget_period_minor`, `max_transaction_minor`, `dual_approval_threshold_minor`(0 = 끔).
- 채널 편성(`MarketingBudgetAllocation`): 채널별 기간 금액. 에이전트가 근거와 함께 제안하고
  `marketing.approve_spend` 가 승인하면 그 채널의 이전 편성을 대체한다(행은 남는다).
  **편성이 없는 채널에는 지출할 수 없다** — "분석 → 편성 → 집행" 이 실제 순서가 되게 한다.
- 수취인 허용 목록(`payees`, `marketing.manage`): 요청의 `payee` 는 이 목록 안이어야 한다.

### 원장 계산

요청별로 `release ≤ reserve`, `refund ≤ capture` 를 삽입 시 강제한다.

- `held` = Σreserve − Σrelease, `spent` = Σcapture − Σrefund
- 총 가용 = `budget_total_minor` − spent − held
- 기간 가용 = `budget_period_minor` − (기간 안 reserve/capture 행 기준의 held + spent).
  refund 는 원래 capture 의 기간에 반영한다.
- 채널 가용 = 편성액 − 그 채널의 기간 held + spent

### 상태 기계

```
pending ──approve──▶ approved ──execute──▶ executing ──▶ paid
   │  (2인 규칙: 첫 승인은 pending 유지)         │      ├──▶ failed  (release)
   ├─deny──▶ denied                              │      └──▶ unknown (사람이 대조: paid | failed)
   ├─expire(72h)──▶ expired                       │
   └─cancel(사람/캠페인 정지)──▶ cancelled           └ manual: 사람이 결제 후 "결제 완료" 기록 → paid
```

1. 에이전트 `request_marketing_spend(campaign_id, channel_id, amount_minor, currency, payee, purpose,
   expected_outcome, provider, payload, dedupe_key)` → `pending`. 이 시점에 한도 · 통화 · 허용
   수취인 · capability · 일일 상한을 미리 검사해 넘으면 바로 거부한다. 요청 행은 pending 을 떠나면
   바뀌지 않는다. 실행 payload 의 정규화 JSON 해시(`payload_sha256`)를 저장하고 화면에 보인다.
2. 승인은 한 트랜잭션: (a) 캠페인 행 `spend_version` 증가(Postgres 행 잠금 · sql.js 직렬화 큐),
   (b) 요청 CAS `status='pending' AND expires_at > now` (affected = 1), (c) 원장 합 재계산 ·
   한도 재검사, (d) `reserve` 행 + 감사 이벤트. 승인자 identity 는 로그인 세션에서만 온다.
   2인 규칙 대상이면 첫 승인은 기록만 하고 두 번째(다른 사람) 승인이 위 (a)–(d) 를 수행한다.
3. 실행: `executing` 을 **먼저 커밋**(sql.js 는 즉시 flush)한 뒤 외부 호출. 재시작 시 `executing` 은
   절대 다시 보내지 않고 `unknown` 으로 돌려 사람이 대조한다. 실행 직전 payload 해시를 다시 계산해
   다르면 실행하지 않는다.
   - `manual` — 사람이 AWB 밖에서 결제하고 거래 id · 영수증 URL 을 기록 → `paid`.
   - `webhook` — 결제 credential(`webhook_url`, `secret`)로 운영자 결제 엔드포인트에
     `X-AWB-Signature: t=<unix>,v1=<hmac-sha256(secret, t + "." + body)>` 와
     `Idempotency-Key: <request id>`(재시도에도 불변) 로 POST. 2xx + `transaction_id` → `paid`,
     4xx → `failed`, 타임아웃 · 5xx · 응답 모호 → `unknown`. 자동 재시도는 없다.
   - `paid` → `release` + `capture`, `failed` → `release`.
4. `refund`(사람, `approve_spend`)는 capture 에 묶여 기록되고 요청을 다시 열지 않는다.
5. 캠페인 일시정지 · 보관은 `pending` 요청을 `cancelled` 로 만든다.

## 분석

- 추적 링크: `create_marketing_link(campaign_id, channel_id, destination_url, post_id?)` — 목적지는 캠페인
  `allowed_domains` 안이어야 한다(오픈 리다이렉트 방지). 코드는 12자 base62 난수. 공개
  `GET /api/m/:code` 가 저장된 목적지에만 UTM(`utm_source`=채널 platform, `utm_medium`=marketing,
  `utm_campaign`=캠페인 slug, `utm_content`=post)을 붙여 302. 모르는 코드는 같은 404. HEAD · 봇 UA ·
  같은 (IP 해시, 코드) 30 분 내 반복은 세지 않는다. 시간 버킷으로 `clicks` 지표에 더한다.
- 지표: `record_marketing_metrics(campaign_id, observations[])` — 에이전트/사람이 관측치를 남긴다
  (`impressions` · `engagements` · `replies` · `signups` · `conversions` · `revenue_minor` · `followers` …,
  출처 기록).
- 리포트: `get_marketing_report(campaign_id, since?)` — 채널별 게시 수 · 클릭 · 노출 · 참여 · 전환 ·
  편성액 · 지출 · CPC · 전환당 비용 · 피드백 수 · 생성 티켓 수. 클릭은 "raw" 표시다.

## 피드백 → 제품

`record_marketing_feedback(campaign_id, channel_id?, source_url, author?, content, category, sentiment)`.
`feedback_to_product` 가 켜져 있고 category 가 `bug|feature_request` 면 `TicketService.create` 로
캠페인 제품 Project 에 티켓을 만든다: `operational_dedupe_key = marketing:{campaign}:{feedback}`,
tags `marketing` · `campaign:<slug>`, status = 캠페인 `feedback_ticket_status`(기본 `backlog`),
assignee = 캠페인 `improvement_assignee`(없으면 project 기본). `todo` + assignee 면 일반 dispatch 루프가
이어받아 제품 개선이 자동으로 시작된다. 같은 source_url 은 한 번만 기록한다.

## 루프

`MarketingCycleService` tick(`MARKETING_SCHEDULER_TICK_MS`, `MARKETING_SCHEDULER_ENABLED`)이
`next_cycle_at` 이 지난 active 캠페인마다:

1. 커서를 먼저 전진(cron 또는 interval, `qa-cron`). 앞 사이클이 `running` 이고 6 시간 안이면 건너뛴다.
2. `MarketingCycle` 행 + 방을 만들고, 캠페인 에이전트를 앉혀 사이클 지시문을 보낸다.
3. 지시문(`buildCyclePrompt`) = 브리프 · 목표 · 켜진 기능과 규칙 · 채널(상태 · 가이드 · 규칙) · 예산
   (편성 · 가용 · 대기 요청) · 직전 사이클 요약/다음 행동 · 대기 중 승인 · 리포트 요약 · 최근 피드백
   (**비신뢰 블록**). 끝은 반드시 `complete_marketing_cycle(cycle_id, summary, next_actions)`.
4. 6 시간 안에 완료되지 않은 사이클은 `timed_out`.

수동 "지금 실행" 도 같은 경로다. 캠페인 사이클은 Account run budget(`max_runs_per_window`)의
`marketing` 축으로 센다.

## 권한

- `marketing.manage` — 캠페인 CRUD, 채널 · 콘텐츠 승인, 연락처, 수취인 허용 목록 (기본 admin 전용)
- `marketing.approve_spend` — 편성 승인, 지출 승인/거부, 결제 기록 · 대조 · 환불 (기본 admin 전용)

## MCP 툴 (에이전트용)

전부 tier `caller` + 핸들러에서 DB-backed caller · 캠페인 소유 계정 접근 · capability · 일일 상한 검사.

| 툴 | capability |
| --- | --- |
| `list_marketing_campaigns`, `get_marketing_campaign` | — |
| `complete_marketing_cycle` | — |
| `propose_marketing_channel` | `channel_discovery` |
| `draft_marketing_post` | `community_post` / `email`(채널 kind 에 따라) |
| `create_marketing_link`, `record_marketing_metrics`, `get_marketing_report` | `analytics` |
| `record_marketing_feedback` | `feedback_collect` |
| `propose_marketing_budget_allocation`, `request_marketing_spend`, `get_marketing_spend_request` | `paid_spend` |

## 후속(이 문서 범위 밖)

결제 공급자 직접 어댑터(Stripe Issuing · Google Ads · Meta Ads), 플랫폼 참여 지표 자동 수집
(reddit score/댓글 수), 메일 답장 수집(inbound parse), 2년 동의 재확인 안내 메일, 승인 대기 알림의
사용자 채널(Discord/Slack/Telegram) 발송, 정책 기반 자동 게시.
