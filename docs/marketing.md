# Marketing (에이전트 기반 제품 마케팅 루프)

`/marketing` 에서 **캠페인**을 만들면, 캠페인 에이전트가 주기(cycle)마다 깨어나 다음 루프를 돈다.

> 채널 탐색 → 채널별 커뮤니케이션 → 예산 편성 · 집행 → 결제 → 성과 분석 → 피드백 → 제품 개선 티켓

**실행 주체는 에이전트이고, 돈 · 외부 발신 · 채널 개설은 사람이 정한다.**

| 위치 | 경로 |
| --- | --- |
| 서버 모듈 | `apps/server/src/modules/marketing` |
| 순수 규칙 · 상수 | `apps/server/src/common/marketing/*` |
| MCP 툴 | `modules/mcp/tools/marketing-tools.ts` |
| 화면 | `apps/client/src/components/marketing/*` |

- 캠페인과 그 하위 객체는 Account 소유다. 로그인 사용자의 소유 계정 접근과 마케팅 기능 권한을 함께 검사한다(`docs/ownership.md`). `AccountAccessService` 가 `/api/marketing/<종류>/<uuid>` 의 실제 `account_id` 를 요청에 묶는다. 캠페인 에이전트와 제품 개선 담당자는 같은 계정의 활성 Runtime Host를 사용한다. 개인 계정의 업무는 다른 관리자에게도 공개되지 않으며, 조직 멤버십이 도입되기 전에는 다른 사용자가 두 번째 지출 승인을 할 수 없다. 엔티티는 서로를 평문 varchar 로 참조하고 DB FK 는 없다.
- **agent-manager 변경과 SSE contract 변경은 없다.** 사이클은 QA · Automation Schedule 과 같은 방식으로 에이전트를 깨운다: 방을 열고, 에이전트를 앉히고, 첫 메시지를 보낸다.
- `marketing_update` SSE 는 UI 전용 이벤트다(user-only filter). 무엇이 바뀌었는지만 싣고, 화면이 REST 로 다시 읽는다.

## 원칙

1. **에이전트는 제안하고, 사람이 정하고, 서버가 집행한다.**
   - 에이전트에게 결제 키 · 메일 API 키 · 채널 토큰을 주지 않는다. `agent_env` 가 켜진 credential 은 마케팅에서 거부된다.
   - 사람이 화면에서 본 **그 내용 그대로** 서버가 실행한다.
   - 승인 · 거부 · 결제 기록 MCP 툴은 존재하지 않는다.
2. **돈에는 자동 모드가 없다.**
   - 모든 지출은 `marketing.approve_spend` 를 가진 사람이 승인한다. 승인할 때 보는 것은 금액 · 통화 · 수취인 · 목적 · 실행 payload 와 그 해시다.
   - 서버는 승인하는 순간 한도를 **다시** 검사한다.
3. **한도는 원장에서 계산한다.**
   - 잔액 칼럼은 없다. append-only `marketing_ledger_entries` 의 합이 곧 사용액 · 보류액이다.
   - 원장과 감사 로그(`marketing_audit_events`)를 고치거나 지우는 코드 경로는 없다. 둘 다 `db-retention.service.ts` 의 정리 대상이 아니다.
4. **외부 발신은 전부 사람 승인을 거친다.**
   - 게시글 · 댓글 · 메일은 초안으로 쌓이고, 승인해야 나간다.
   - 자동 게시는 없다. 외부인이 쓴 피드백이 사이클 지시문에 들어가므로, 자동 게시가 있으면 프롬프트 주입이 곧 외부 발신이 된다.
   - 메일 수신자는 **사람이 넣은 동의 연락처뿐**이다. 에이전트는 연락처를 보지도, 추가하지도 못한다.
5. **채널은 에이전트가 찾고 사람이 연다.**
   - 에이전트는 근거와 함께 후보를 제안하고, 사람이 승인해야 활성화된다.
   - 에이전트는 `OutreachChannel` 을 만들 수 없다.
6. **제품 개선은 AWB 티켓으로 흘러간다.** bug/feature 피드백은 `TicketService.create` 로 캠페인의 제품 Project 에 들어가고, 그 뒤는 일반 티켓 dispatch 루프가 맡는다.
7. **비신뢰 입력은 데이터로만 다룬다.**
   - 외부에서 온 글은 사이클 지시문에서 비신뢰 블록으로 격리한다. 링크를 지우고, 구분자를 무력화하고, 잘라낸다.
   - MCP 응답에서는 그런 필드 이름 끝에 `_untrusted` 를 붙인다.
   - 수취인은 사람이 관리하는 허용 목록 안에서만, 추적 링크 목적지는 허용 도메인 안에서만 고를 수 있다.

## 엔티티

| 엔티티 | 테이블 | 역할 |
| --- | --- | --- |
| `MarketingCampaign` | `marketing_campaigns` | 제품(Project), 브리프 · 목표 · 대상, capabilities, 에이전트 RuntimeSpec, 주기, 통화, 한도, 결제 방식, 수취인 허용 목록(수취인별 직접 결제 경로), 링크 허용 도메인, 공개 문구, 일일 상한, 피드백 티켓 설정 |
| `MarketingChannel` | `marketing_channels` | 캠페인의 채널(연결 테이블 + 탐색 근거). kind 는 `outreach` · `email` · `manual` |
| `MarketingPost` | `marketing_posts` | 채널별 콘텐츠(게시글 · 답글 · 메일). 서버가 게시한 reddit · GitHub 글은 마지막으로 읽은 참여도 담는다 |
| `MarketingEmailSend` | `marketing_email_sends` | 메일 한 통 = (post × contact). 발송 큐이자 기록. 보낸 credential, 공급자가 알려 온 바운스 · 스팸 신고 |
| `MarketingContact` | `marketing_contacts` | 메일 수신자(설치 전체의 한 목록), 동의 증거, 재확인 안내로 이어진 동의 기간, 수신거부 · 바운스 · 스팸 신고, 억제 해시 |
| `MarketingBudgetAllocation` | `marketing_budget_allocations` | 채널별 예산 편성(버전) |
| `MarketingSpendRequest` | `marketing_spend_requests` | 지출 요청과 그 상태 기계. 직접 결제는 실행 계획과 대상 키(`target_key`)도 담는다 |
| `MarketingLedgerEntry` | `marketing_ledger_entries` | append-only 원장 |
| `MarketingLink` | `marketing_links` | 추적 링크 |
| `MarketingMetric` | `marketing_metrics` | 지표 관측치(링크 클릭은 시간 버킷 합산, 커넥터가 읽은 참여는 변화량) |
| `MarketingFeedback` | `marketing_feedback` | 에이전트 · 사람이 기록한 피드백과 연결 티켓 |
| `MarketingCycle` | `marketing_cycles` | 루프 1회 |
| `MarketingAuditEvent` | `marketing_audit_events` | append-only 감사 로그 |
| `MarketingApprovalNotice` | `marketing_approval_notices` | 승인 대기 알림을 보냈다는 표시. (대상, 종류)마다 한 번 |
| `MarketingListHold` | `marketing_list_holds` | 스팸 신고율이 높아 발송을 멈춘 수신 목록. (계정, 목록)마다 `held` 는 하나, 해제한 것은 이력 |
| `MarketingConsentNotice` | `marketing_consent_notices` | 수신 동의 재확인 안내 한 통. (연락처, 기한)마다 하나 — 법정 통지를 보냈다는 기록 |
| `MarketingConsentNoticeSetting` | `marketing_consent_notice_settings` | 계정의 재확인 안내 설정(켜기 · 발송 시점 · 무응답 처리 · 문구). 계정마다 하나 |

### 기존 것과의 경계 (왜 새로 만들었나 / 무엇을 재사용하나)

- **커넥터는 outreach 것을 그대로 쓴다.**
  - `resolveChannelConnector` · 공용 rate limiter · credential 경계 규칙을 재사용한다.
  - 게시 대상은 그 OutreachChannel 의 `targets` 화이트리스트 안이어야 한다. 글은 자기 채널의 대상으로만 간다.
  - 게시된 글의 참여도 그 커넥터(`readEngagement`)로 읽는다("참여 지표 자동 수집").
- **게시물 원장은 따로 둔다**(`MarketingPost` ≠ `OutreachOutboundPost`).
  - 권한이 다르다: `marketing.manage` 대 `MANAGE_RESOURCES`.
  - OutreachChannel 이 없는 `manual` · `email` 채널이 있다.
  - 공개 문구 · 추적 링크 같은 캠페인 고유 필드가 붙는다.
  - 승인 claim(조건부 UPDATE)과 `(campaign, dedupe_key)` 유일 인덱스는 같은 패턴을 쓴다.
  - 다만 사람이 고친 본문은 **같은 UPDATE 에서** 확정한다. 그래서 승인한 글과 나가는 글 사이에 틈이 없다.
- **폴링 피드백은 `OutreachInboundItem` 에 남는다.** 수집 · 분류 · 티켓은 outreach ingest 가 맡는다. `MarketingFeedback` 은 그 밖의 것만 담는다(manual 채널의 댓글, 메일 답장, 에이전트가 옮긴 글). 메일 답장은 공급자 webhook 이 직접 넣는다("답장").
- **사이클은 자기 tick 을 갖는다.** Automation Schedule 행을 만들지 않는다. 다음 세 가지 때문이다.
  - 지시문은 발화 시점의 상태로 만들어야 한다.
  - 앞 사이클이 아직 돌면 건너뛰어야 한다.
  - 캠페인 정지가 곧 중단이어야 한다.

  cron 의미는 같은 `qa-cron` 헬퍼와 "발화 전에 커서 전진" 규칙을 쓴다. 그래서 cron 구현이 두 벌로 갈리지 않는다.
- 다른 기능이 캠페인 상태 전이에 끼어들 때는 `MarketingCampaignHooks` 를 쓴다(정지 시 정리, 삭제 차단, 자식 삭제, 통화 고정). 그래서 서비스끼리 순환 의존이 없다.

## Capabilities (옵션 조합)

캠페인은 아래 기능을 골라 켠다. 꺼진 기능의 MCP 툴은 그 캠페인에 대해 거부된다.

| key | 의미 |
| --- | --- |
| `channel_discovery` | 채널 후보 제안 |
| `community_post` | 커뮤니티 게시글 · 답글 초안 |
| `email` | 동의 연락처에게 보낼 메일 초안 |
| `feedback_collect` | 피드백 기록 |
| `feedback_to_product` | bug/feature 피드백을 제품 Project 티켓으로 |
| `analytics` | 추적 링크 · 지표 기록 |
| `paid_spend` | 예산 편성 제안 · 지출 요청 |

`get_marketing_report` 는 읽기 전용이라 기능과 무관하게 열려 있다.

### 일일 상한

캠페인 `limits` 로 덮어쓴다. 최근 24시간 동안 에이전트가 만든 수를 센다.

| 항목 | 상한 |
| --- | --- |
| `drafts_per_day` | 20 |
| `spend_requests_per_day` | 5 |
| `allocation_proposals_per_day` | 3 (제안 묶음 수) |
| `links_per_day` | 50 |
| `channel_proposals_per_day` | 10 |
| `feedback_per_day` | 100 |
| `metrics_per_day` | 500 |
| `feedback_tickets_per_day` | 3 |
| `open_feedback_tickets` | 10 |

상한 0 은 그 행동을 금지한다는 뜻이다.

## 채널 탐색

에이전트는 `propose_marketing_channel` 로 후보를 남긴다.

- **플랫폼:** reddit · github · hacker_news · product_hunt · x · linkedin · discord · slack · forum · blog · newsletter · youtube · email · other
- **대상:** reddit 은 subreddit 이름, github 는 owner/repo, 그 밖은 URL 또는 이름이다. 대상은 정규화되고, javascript: 같은 스킴은 거부된다.
- **함께 남기는 근거:**
  - 실제로 연 페이지 `evidence_urls` (http(s), 필수)
  - 적합 이유 `rationale` (필수)
  - 청중 규모와 관측일
  - 홍보 규칙 인용 `rules_summary` 와 그 출처 `rules_url`
  - 제안 톤 · 빈도 `guidelines`
- 같은 (플랫폼, 대상)은 다시 만들지 않고 기존 행을 돌려준다.

사람이 승인할 때 방식을 정한다.

- **`outreach`** (reddit/github)
  - 연결: 기존 OutreachChannel 에 잇는다(그 채널이 대상을 화이트리스트해야 한다). 또는 credential 을 골라 새로 만든다(`OutreachChannelService.create`, 배포 공지 off).
  - 폴링: 새로 만든 채널은 **기본으로 폴링하지 않는다.** 일반 커뮤니티를 폴링하면 제품과 무관한 글이 티켓이 된다. 제품 전용 커뮤니티일 때만 `collect_feedback: true` 로 켠다.
  - 연결할 것이 없으면 `awaiting_credential` 로 두고, 나중에 `connect` 한다.
- **`email`** (email/newsletter)
  - 필수 설정: 메일 credential(`provider`: resend|sendgrid, `api_key`), 발신자 이름 · 주소, 우편 주소, 연락처, 수신 목록 이름.
  - 선택: 광고 표기(기본 `(광고)`). 바운스 · 스팸 신고 · 답장을 받으려면 credential 에 webhook 서명 키를 넣는다("공급자 이벤트").
- **`manual`**: 사람이 직접 올리고 링크를 기록한다.

상태 전이: `proposed → active | awaiting_credential | rejected`, `active ↔ paused`.

## 커뮤니케이션

에이전트는 `draft_marketing_post(channel_id, title, body, reply_to?, rationale)` 로 초안을 만든다. 상태는 `draft` 다.

- capability 는 채널 종류가 정한다. 메일 채널은 `email`, 그 밖은 `community_post` 다.
- 승인 화면은 `preview_body` 를 보여 준다. 실제로 나갈 본문이고, 캠페인 **공개 문구**(`disclosure`, 비울 수 없음)가 붙어 있다.
- 사람은 승인하면서 제목 · 본문을 고칠 수 있다.

| 채널 | 승인 후 | 끝 상태 |
| --- | --- | --- |
| outreach | 커넥터의 `publish` 또는 `reply` | `published` (permalink) 또는 `failed` |
| manual | `approved` | 사람이 permalink 를 기록하면 `published` |
| email | `sending` (발송 큐) | 큐가 다 돌면 `published` |

- outreach 게시가 실패해도 **자동 재시도하지 않는다.** 네트워크 실패 뒤에도 실제로는 올라가 있을 수 있어서다. 다시 보낼지는 사람이 `retry` 로 정한다.
- **답글은 채널 밖으로 가지 않는다.** reddit fullname(`t3_…`/`t1_…`)이나 github 참조만 봐서는 어느 커뮤니티의 스레드인지 알 수 없다.
  - 초안 때 커넥터의 `describeThread`(reddit `/api/info`, github 는 참조 파싱)로 그 스레드가 채널 대상 안인지 확인한다. 결과는 `reply_context`(대상 · 링크 · 제목)로 승인 화면에 보여 준다. 채널 밖이거나 확인할 수 없으면 초안을 만들지 않는다.
  - 게시 직전에 한 번 더 막는다. 초안 때 확인한 대상이 채널 대상과 같아야 한다. 그리고 커넥터의 `reply` 가 호출한 쪽을 믿지 않고 스스로 대상을 확인해, OutreachChannel 화이트리스트 밖이면 보내지 않는다(outreach 의 배포 공지 · 처리 완료 답글도 같다).
  - reddit 은 이 확인도 `/api/info` 조회라 시간당 상한을 쓴다. 스레드의 subreddit 은 바뀌지 않으므로 서버 프로세스 안에서 캐시한다. 그 사이 서버가 재시작하지 않았다면, 초안 때 조회한 스레드에 답글을 달 때 추가 호출이 없다.
- 일시정지된 채널 · 캠페인에서는 승인할 수 없다.
- 거부 사유(`note`)는 다음 사이클 지시문의 "사람의 최근 결정"에 실린다. 에이전트는 이걸 보고 배운다.

## 메일

### 연락처

- 연락처는 설치 전체의 한 목록이다(같은 주소는 한 번). 사람만 가져온다(`POST /api/marketing/contacts/import`).
- 동의 증거를 같이 받는다.
  - 필수: 방법(`signup_form|checkout|event|import|other`), 출처, 시각
  - 선택: 문구 버전, IP, 야간 수신 동의, 국가, 시간대
- 수신거부 · 바운스 · 스팸 신고 · 삭제된 주소는 `email_hash` 로 **억제**된다. 다시 가져와도 되살아나지 않는다.
- 동의는 2년이 지나면 발송에서 빠진다. 기한 전에 재확인 안내가 나가면 이어진다("동의 재확인 안내"). 더 새로운 동의 시각으로 다시 가져오면 증거가 바뀌고 2년을 다시 센다.
- 상태는 `subscribed` · `unsubscribed` · `bounced` · `complained` · `erased`(`CONTACT_STATUSES`)이고, `subscribed` 에게만 보낸다. 억제가 어디서 왔는지는 `unsubscribe_source` 다: `link` · `one_click` · `manual` · `mailto`(List-Unsubscribe 메일 회신) · `bounce` · `complaint` · `provider`(공급자 쪽 수신거부).
- 삭제(erase)하면 주소 · 이름은 지우고 해시만 남긴다.

### 발송

- 승인하기 전에 preflight 로 확인한다: `AWB_PUBLIC_URL`, 발신자 설정, credential, 수신자 수(게시물당 최대 10,000). 하나라도 실패하면 글은 draft 로 남는다.
- 승인하면 목록의 발송 대상만 큐에 넣는다. 대상은 `subscribed` 이면서 동의 기간 안인 연락처다(동의일 또는 재확인 안내로 이어진 기한부터 2년, "동의 재확인 안내").
- 큐는 30초마다 50통씩 처리한다.
  - **보내기 직전에 연락처 상태를 다시 본다.** 그 사이 수신거부했으면 `suppressed` 다.
  - 수신자 현지 21:00–08:00 이고 야간 동의가 없으면 `deferred` 로 두고, 아침 08:00 에 보낸다.
  - 4xx 는 `failed` 다.
  - 다시 보낼지는 "다시 보내면 두 번 받을 수 있는가" 로 정한다. Resend 에는 발송 행 id 를 `Idempotency-Key` 로 보내므로 타임아웃 · 5xx · 429 를 최대 3번까지 다시 시도한다. SendGrid 는 멱등 키가 없어 429 만 다시 시도하고, 타임아웃 · 5xx 는 `failed` 로 닫는다.
  - 보내던 중 끊긴 행은 다시 보내지 않고 `failed` 로 닫는다. 중복 발송보다 누락이 낫다.
  - 캠페인이나 채널이 일시정지되면 큐의 메일은 버리지 않고 `deferred` 로 미룬다. 재개하면 이어서 보낸다. 보관된 캠페인의 메일은 `suppressed` 다.
  - 수신 목록이 스팸 신고율로 멈췄으면 그 목록의 메일도 `deferred` 로 미룬다("목록 발송 중지"). 해제하면 바로 보낸다.
  - 보낼 때 발송 행 id 를 공급자에 싣는다(Resend `tags` 의 `awb_send_id`, SendGrid `custom_args.awb_send_id`). 공급자가 그 메일의 이벤트에 그대로 돌려주므로 이벤트를 정확한 발송 행에 잇는다. 발송 행에는 보낸 credential(`credential_id`)도 남는다.
- 서버가 **강제로** 넣는 것:
  - 제목 앞 광고 표기. 한국 · 국가 미상 수신자는 항상 `(광고)`, 그 밖은 채널 `ad_label`.
  - 본문 끝 꼬리말: 발신자명 · 우편 주소 · 연락처, 무료 수신거부 링크, 수신 동의일.
  - `List-Unsubscribe` 와 `List-Unsubscribe-Post: List-Unsubscribe=One-Click` 헤더.

### 수신거부 (공개 엔드포인트)

- `GET /api/m/u/:token` 은 확인 화면만 보여 준다. 메일 보안 스캐너가 링크를 열어도 처리되지 않게, 아무것도 바꾸지 않는다.
- `POST /api/m/u/:token` 이 실제로 처리한다. 화면의 버튼과 메일 앱의 One-Click 둘 다 이 경로다.
- 응답은 토큰이 유효하든 아니든 같다. IP 당 분당 30회로 제한한다.
- 처리 결과는 화면과 안내 메일로 알린다.
- 토큰은 256-bit 난수이고 REST 응답에 나가지 않는다.

에이전트는 연락처를 볼 수 없다. 메일 채널의 수신 대상 인원(`audience_count`)만 안다.

### 공급자 이벤트 (바운스 · 스팸 신고 · 수신거부)

공급자는 2xx 로 메일을 받은 뒤에 일어난 일을 webhook 으로 알린다. 받는 주소는 **메일 credential 마다 하나**다 — 공급자는 한 계정의 모든 메일 이벤트를 한 주소로 보내므로 채널이 아니라 credential(= 공급자 계정)이 단위다. 메일 채널 카드가 붙여 넣을 주소와 서명 키 설정 여부를 보여 준다(키 값은 화면에 오지 않는다).

| 공급자 | 주소 | 서명 | credential 칸 | 켤 이벤트 |
| --- | --- | --- | --- | --- |
| Resend | `POST /api/m/email/<credential id>/events` | Svix: `svix-id` · `svix-timestamp` · `svix-signature`, HMAC-SHA256(`<id>.<timestamp>.<raw body>`), 5분 | `webhook_secret`(`whsec_…`) | `email.bounced` · `email.complained` · `email.suppressed` · `email.received`(답장) |
| SendGrid Event Webhook | 같은 `/events` | ECDSA P-256: `X-Twilio-Email-Event-Webhook-Signature`(base64 DER) · `…-Timestamp`, 대상은 `<timestamp><raw body>`, 3일 | `webhook_public_key`(SendGrid 화면의 base64 키) | Bounced · Dropped · Spam Reports · Unsubscribes · Group Unsubscribes, Signed Event Webhook 켬 |
| SendGrid Inbound Parse | `POST /api/m/email/<credential id>/inbound` | Event 와 같은 방식, 키는 Parse security policy 의 것 | `inbound_public_key` | 회신 주소 도메인, "raw, full MIME" 은 끈다 |

- **서명이 곧 인증이다.** 서명이 없거나 틀리거나, credential 에 키가 없거나, 없는 credential 이거나, `agent_env` credential 이면 아무것도 하지 않고 같은 401 을 돌려준다. 본문은 서명을 검증하려고 raw 로 받고(events 5MB, inbound 30MB), 검증이 끝나기 전에는 해석하지 않는다.
- 시각 허용: Resend(Svix)는 재시도도 새로 서명하므로 5분. SendGrid 는 재시도가 새로 서명되는지 공급자 문서가 말하지 않아 3일로 넓게 둔다. 처리가 상태 기반이라 같은 이벤트를 다시 받아도 결과가 같다.
- **이벤트는 그 credential 로 보낸 발송 행에만 닿는다**(행의 `credential_id`, 그 칸이 생기기 전 행은 채널의 지금 credential). 발송 행은 실어 보낸 발송 행 id → 공급자 message id(Resend `email_id`, SendGrid `sg_message_id` 의 첫 `.` 앞 = 발송 응답의 `X-Message-Id`) → 수신 주소로 그 credential 을 거쳐 보낸 최근 발송 순으로 찾는다. 같은 순서로 그 credential 로 보낸 동의 재확인 안내 행도 찾는다(주소로 찾을 때는 캠페인 메일이 먼저). 못 찾으면 무시한다.

| 이벤트 | 발송 행 | 연락처 |
| --- | --- | --- |
| 하드 바운스(Resend `Permanent`, SendGrid `bounce`) | `bounce_type` hard | `bounced`(source `bounce`) |
| 소프트 바운스(Resend 그 밖, SendGrid `type: blocked`) | `bounce_type` soft | 그대로 |
| 스팸 신고(Resend `email.complained`, SendGrid `spamreport`) | `complained_at` — 목록 신고율에 센다 | `complained`(source `complaint`, `bounced` 에서도) |
| 공급자 쪽 수신거부(SendGrid `unsubscribe` · `group_unsubscribe`) | — | `unsubscribed`(source `provider`) |
| 공급자가 보내지 않음(Resend `email.suppressed` · subType `Suppressed`, SendGrid `dropped`) | `bounce_type` suppressed | 그 사유대로(예전 바운스 · 잘못된 주소 → `bounced`, 신고 목록 → `complained`, 수신거부 목록 → `unsubscribed`) — 예전 신고의 반복이라 **새 신고로 세지 않는다** |

- 연락처는 이전 상태가 맞을 때만 바꾼다(CAS). 억제는 약해지지 않는다: `erased` · `unsubscribed` 는 그대로고, 신고가 바운스를 덮는다. 바뀌면 감사(`contact.bounced` · `contact.complained` · `contact.unsubscribed`)를 그 메일의 캠페인에 남긴다.
- 공급자의 사유(수신 서버의 SMTP 응답)는 발송 행의 `event_note` 에만 잘라서 둔다 — 사람에게만 보인다.
- 게시물의 발송 현황(`GET /posts/:id/sends`)은 `outcomes`(바운스 종류별 · 스팸 신고 수)를 같이 준다.

### 답장

- 받는 길: Resend 는 같은 webhook 의 `email.received`(본문이 없어 `GET https://api.resend.com/emails/receiving/{id}` 로 읽는다 — credential 의 `api_key` 가 받은 메일을 읽을 수 있어야 한다), SendGrid 는 Inbound Parse(`/inbound`).
- **보낸 사람이 그 credential 로 메일을 받은 연락처일 때만** 기록한다. 그 밖의 메일은 열지도 않는다(Resend 본문 API 를 부르지 않는다) — 회신 주소로 오는 아무 메일이나 피드백이 되지 않게. 자동 응답(`Auto-Submitted` · `Precedence: bulk` · "Automatic reply" · "자동 회신" …)도 기록하지 않는다. 공급자가 보낸 사람 인증이 실패했다고 알린 메일(Resend DMARC `fail`, SendGrid SPF `fail` 이면서 DKIM 통과 없음)도 버린다 — 연락처 주소를 사칭한 글 · 수신거부를 막는다. 인증 결과가 없으면 버리지 않는다.
- 어느 메일에 대한 답장인지: 그 사람이 그 credential 로 받은 최근 메일. 여러 캠페인이면 회신 주소가 이 메일의 받는 주소인 채널의 것을 고른다.
- 기록: `MarketingFeedback`(category `other` — 무엇에 대한 글인지 서버가 판단하지 않는다, `recorded_by_type: system`, 출처 키 `email-reply:<공급자>:<Message-ID>` 로 한 번만). summary 는 `메일 답장 — <승인된 메일 제목>` 이다 — 외부 글을 신뢰 필드에 넣지 않는다.
- **본문은 정리한 것만 남긴다**: 인용 머리("On … wrote:" · "…님이 작성:" · Outlook From/Sent) 아래, `>` 인용 줄, 서명(`-- `) 아래를 버리고, 메일 주소는 `[메일 주소]`, 우리 수신거부 링크(그 사람의 토큰)는 `[수신거부 링크]`, 재확인 안내의 유지 링크는 `[동의 유지 링크]` 로 바꾼 뒤 8000자로 자른다. HTML 만 있으면 인용 블록 앞까지만 글자로 바꾼다. 아무나 회신 주소로 보낼 수 있는 글이라 정리는 선형 스캔으로만 한다(긴 줄 하나로 처리 시간이 제곱으로 늘지 않게).
- 그 뒤는 다른 피드백과 같다: 사이클 지시문의 비신뢰 블록(출처에 "· 메일 답장"), MCP 의 `*_untrusted` 필드.
- **에이전트는 여전히 연락처를 보지 못한다.** 답장한 연락처는 `contact_id` 로만 잇고 author 는 비운다. 사람용 REST(`GET /campaigns/:id/feedback`)만 그 연락처(주소 · 이름 · 상태)를 싣는다.
- 제목이 `unsubscribe`(List-Unsubscribe 의 mailto) · `수신거부` 인 메일은 수신거부로 처리하고(source `mailto`) 처리 안내 메일을 보낸다. 본문의 낱말로는 판단하지 않는다 — 그런 글은 답장으로 기록돼 사람이 본다.

### 목록 발송 중지 (스팸 신고율)

Gmail · Yahoo 의 대량 발신자 기준은 스팸 신고율 0.1% 미만 유지, 0.3% 에는 닿지 말 것이다. 닿은 목록은 발신 도메인 전체의 평판을 깎으므로 사람이 볼 때까지 멈춘다(`MarketingListHoldService`, 규칙은 `common/marketing/email.ts`).

- 단위는 (계정, 수신 목록)이다. 그 계정에서 그 목록을 쓰는 모든 메일 채널(캠페인 무관)을 같이 센다.
- 새 스팸 신고가 발송 행에 기록될 때마다 센다: 기간(30일, 그 안에 해제했으면 해제 이후)에 보낸 메일 · 그중 닿지 않은 것(`bounced_at`) · 그중 신고된 것. **신고 2건 이상이고 신고 ÷ 닿은 메일 ≥ 0.3%** 면 멈춘다(작은 목록에서 한 사람의 신고만으로 멈추지 않게 최소 2건).
- 멈추면: 그 목록의 큐는 버리지 않고 `deferred`, 새 메일은 승인되지 않고(409), 에이전트의 메일 초안도 거부된다. `get_marketing_campaign` 의 채널에 `list_on_hold`, 사이클 지시문의 채널 줄에 "발송 중지" 가 실린다. 그 목록을 쓰는 캠페인마다 감사 `list.held`.
- 해제는 `marketing.manage` 가 사유를 적어서 한다(`POST /api/marketing/list-holds/:id/release`). 보류된 메일은 바로 나가고, 신고율은 해제 이후 보낸 메일만 다시 센다 — 해제 전 메일에 늦게 온 신고로 다시 멈추지 않는다. 감사 `list.released`.

### 동의 재확인 안내 (2년)

정보통신망법 §50⑧ · 시행령 §62의3 은 광고성 정보 수신 동의를 받은 자가 **동의일부터 2년마다, 2년이 되는 해의 동의일과 같은 날 전까지** 받는 사람에게 세 가지를 알리게 한다: 전송자 명칭, 수신 동의 사실과 동의한 날짜, 유지 · 철회 의사를 표시하는 방법. `MarketingConsentNoticeService` 가 이 안내를 보낸다(규칙은 `common/marketing/consent-notice.ts`).

- **동의 기간.** 기준점은 `consent_at` 과 `consent_renewed_at` 중 늦은 쪽이다. 기한은 거기서 **729일**이다(`consentDeadline`).
  - 730일이면 윤일이 끼지 않을 때 그 날 당일이 된다. 하루 앞(같은 날짜의 전날 같은 시각)이라 어느 시간대에서 봐도 "그 날 전" 이다.
  - 발송 대상 판정(`consentFresh`)도 이 기간을 쓴다.
- **설정은 계정마다 운영자가 정한다**(`marketing.manage`, 연락처 화면의 "동의 재확인 안내").

  | 항목 | 값 |
  | --- | --- |
  | 켜기 | 기본은 꺼짐이다. 켜려면 `AWB_PUBLIC_URL` 이 있어야 한다(유지 · 철회 링크) |
  | 발송 시점 | 기한 7–90일 전(기본 30일) |
  | 무응답 처리 | `keep`(기본) · `lapse` |
  | 제목 · 본문 | 자리표시자 `{{name}}` · `{{sender}}` · `{{consent_date}}` · `{{due_date}}`. 모르는 `{{…}}` 는 저장할 때 거부한다 |

  문구나 무응답 처리가 바뀌면 `version` 이 오른다. 보낸 안내와 유지 기록은 그 버전을 가리키고, 그 버전의 문구는 설정 변경 감사(`consent_notice.settings`, append-only)에 그대로 남는다.
- **무응답 처리.** 무응답의 의미는 안내가 무엇을 제시했느냐로 정해진다(KISA 해석). 서버가 붙이는 문단이 받는 사람에게 그대로 말한다.
  - `keep`: 철회 방법을 안내했으니 무응답은 유지다. **기한이 오면**(기한 1시간 전) 그 기한이 `consent_renewed_at` 이 되고, 동의는 거기서 다시 729일이다. 기산일은 원래 동의일이라 안내를 보낸 날부터 세지 않는다.
  - 기한까지 기다리는 까닭: 그 사이에 철회 · 새 동의(가져오기 · 유지 링크) · 미도달(바운스)이 있었으면 잇지 않는다. 새 동의는 그것대로 다음 주기를 정한다. 서버가 멈춰 기한을 지나쳤으면 30일 안에 뒤늦게 잇는다.
  - `lapse`: 유지 방법을 안내했으니 무응답은 철회다. 기한까지 유지 링크를 누르지 않으면 기한에 발송 대상에서 빠진다. 연락처 상태는 바꾸지 않는다 — 새 동의를 가져오면 다시 받는다.
- **줄 세우기 · 보내기**
  - 10분마다 줄을 세운다. 켠 계정의 `subscribed` 연락처 가운데 안내 창(기한 N일 전 ~ 기한 10분 전)에 든 사람마다 (연락처, 기한) 한 행을 넣는다. 유일 인덱스라 서버가 둘이어도 한 번이다.
  - 1분마다 50통씩, 기한이 가까운 것부터 보낸다. 보내기 직전에 다시 본다(그 행을 다루는 시각으로). 수신거부 · 바운스 · 신고 · 삭제됐거나, 새 동의로 기한이 바뀌었거나, 기한 10분 전을 넘겼으면 보내지 않는다(`skipped`). 꺼졌으면 미룬다.
  - 같은 주기인지는 기한이 하루 넘게 달라졌는지로 본다. 저장 왕복(DB 정밀도 · 서머타임) 오차는 같은 주기다.
  - 발신자는 그 사람이 마지막으로 마케팅 메일을 받은 채널이고, 없으면 그 사람의 목록을 쓰는 채널이다(승인된 메일 채널, 보관되지 않은 캠페인). "전송자 명칭" 이 그 사람이 동의한 발신자여야 해서다. 채널이 없으면 1시간마다 다시 본다(현황의 "보낼 메일 채널 없음").
  - 수신자 현지 야간(21–08시)이면 아침으로 미룬다. 광고가 아니라서 야간 제한 대상은 아니지만 배려다. 미루면 기한을 넘기게 될 때는 바로 보낸다.
  - 공급자 결과는 메일 큐와 같다. Resend 는 안내 행 id 를 `Idempotency-Key` 로 3번까지 다시 보내고, SendGrid 는 429 만 다시 보낸다.
  - **공급자에 넘긴 뒤에는 다시 보내지 않는다.** 결과를 기록하지 못했거나 보내던 중 끊긴 행은 10분 뒤 `failed`("닿았을 수 있음")로 닫는다.
  - **실패한 안내 다시 보내기**: 기한 전에 `failed` 가 된 안내(공급자가 거절 · 재시도 소진 · 끊김)는 사람이 메일 설정을 고친 뒤 다시 줄 세운다(`POST /consent-notices/retry-failed`, 감사 `consent_notice.retry`). "닿았을 수 있음" 으로 닫힌 것은 두 번 받을 수 있다 — 화면이 알린다.
- **안내 메일.** 운영자의 제목 · 본문 뒤에 서버가 고정 문단을 붙인다.
  - 보낸 곳, 동의한 날짜(받는 사람의 시간대), 유지 방법(무응답이면 어떻게 되는지까지), 철회(수신거부) 방법
  - "법정 안내이며 광고가 아님", 발신자 이름 · 우편 주소 · 연락처
  - 제목에 광고 표기를 붙이지 않는다. 확인 안내는 광고와 따로 보내야 하므로(KISA) 광고 문구를 섞지 않는다. `List-Unsubscribe` One-Click 헤더는 붙는다.
  - 보낼 때 캠페인 메일과 같은 tag(`awb_send_id`)에 안내 행 id 를 싣는다("공급자 이벤트").
- **이미 지난 동의는 잇지 않는다.** 동의를 다시 묻는 메일은 그 자체가 광고성 정보다. 그래서 기한이 지난 연락처에게는 보내지 않는다. 현황의 "기한이 이미 지난 연락처" 는 새로 동의를 받아 가져와야 다시 보낸다.
- **유지 링크** `GET/POST /api/m/c/:token`. 토큰은 안내마다 256-bit 이고, REST 응답에 나가지 않는다.
  - GET 은 확인 화면만 보여 준다. 메일 보안 스캐너가 열어도 처리되지 않게 아무것도 바꾸지 않는다.
  - POST 는 새 동의로 기록한다: `consent_at` = 지금, method `reconfirm`, source `consent-notice:<안내 id>`, 문구 버전 `consent-notice-v<n>`. 이어진 기간(`consent_renewed_at`)은 지운다 — 기간을 그때부터 다시 센다. IP 원문은 남기지 않고, 이전 증거는 감사 `contact.consent_kept` 에 남는다.
  - 안내 표시 · 연락처 · 감사가 한 트랜잭션이다. 같은 안내로 두 번(동시에) 눌러도 한 번이다.
  - 토큰은 안내 메일에만 있으므로 쥐고 있으면 받은 것이다 — 행이 `failed`("닿았을 수 있음")여도 받는다. 기한 뒤 30일까지 받는다. 수신거부 · 바운스 · 신고 · 삭제된 연락처는 되살리지 않는다.
  - 수신거부와 같은 제한(IP 당 분당 30회)을 쓴다. 철회는 연락처의 수신거부 링크(`/api/m/u/:token`) 그대로다.
- **안내에 온 공급자 이벤트와 회신.** 캠페인 메일을 받은 적 없는 연락처에게 간 안내에도 닿는다("공급자 이벤트"는 안내 행도 찾는다).
  - 스팸 신고 · 하드 바운스 · 공급자 쪽 수신거부는 캠페인 메일과 같은 규칙으로 연락처를 억제한다. 안내 행에는 미도달(`bounce_type`) · 사유(`event_note`)를 남긴다. 닿지 않은 안내(소프트 바운스 포함)로는 동의를 잇지 않는다.
  - 안내는 목록 발송이 아니므로 목록의 스팸 신고율에는 세지 않는다.
  - 제목이 수신거부인 회신(List-Unsubscribe 의 mailto)은 수신거부로 처리하고 처리 안내를 안내의 채널로 보낸다. 그 밖의 회신은 이을 캠페인이 없어 기록하지 않는다. 받은 메일 본문은 우리 메일(캠페인 메일이나 안내)을 받은 사람이 보낸 것만 연다.
- **기록.** 보낸 안내 행이 법정 통지의 기록이다: 기한, 보낸 시각, 발신 채널 · credential, 공급자 message id, 안내한 무응답 처리와 문구 버전, 미도달 · 사유, 유지 클릭 시각, 응답 없이 이어 준 시각. 연락처 목록은 연락처마다 동의 기한(`consent_due_at`)과 최근 안내를 싣는다.
- **한계.** 연락처의 동의는 계정에 하나다. 그래서 안내도 사람마다 한 통이고, 그 사람의 최근 채널 발신자 이름으로 나간다. 한 계정이 서로 다른 발신자(브랜드)로 같은 사람에게 따로 동의를 받는 경우는 다루지 않는다.

## 예산 편성 · 집행 · 결제

금액은 **정수 최소 단위(minor units)** 와 ISO 4217 통화로 다룬다. 캠페인 하나는 통화 하나만 쓴다.

- 지수: KRW · JPY 등은 0, BHD · KWD 등은 3, 그 밖은 2.
- 부동소수 · 0 이하 · 9×10¹² 초과 금액은 거부한다.
- 저장은 `bigint` 칼럼이다. Postgres 는 문자열로 돌려주므로 transformer 로 숫자로 맞춘다.

### 한도

- **캠페인 한도**
  - `budget_total_minor`: 0 이면 지출 불가.
  - `budget_period` (`none|week|month`, UTC, ISO 주) 와 `budget_period_minor`: 기간 한도. 0 이면 기간 한도 없음.
  - `max_transaction_minor`: 건당 한도.
  - `dual_approval_threshold_minor`: 이 금액 이상이면 서로 다른 두 사람이 승인해야 한다. 요청이 들어올 때 `dual_required` 로 고정되므로, 나중에 임계값을 내려도 이미 들어온 요청은 약해지지 않는다(승인 때는 고정값과 그때 임계값 중 더 엄격한 쪽).
- **채널 편성**(`MarketingBudgetAllocation`)
  - 에이전트가 근거와 함께 제안하고, `approve_spend` 가 승인한다. 승인되면 그 채널의 이전 편성은 `superseded` 가 된다.
  - 결정되지 않은 이전 제안도 새 제안이 오면 `superseded` 로 정리된다.
  - active 편성 합이 기간 한도(없으면 총 한도)를 넘으면 승인이 거부된다.
  - **편성이 없는 채널에는 지출할 수 없다.**
- **수취인 허용 목록**(`payees`): 요청의 `payee` 는 이 목록 안이어야 한다. 요청 · 승인 · 실행 때마다 다시 본다.
  - 이름만이 아니라 **경로**(결제 방식 · credential · `ref`)까지 본다. 사람이 요청 뒤에 수취인을 다른 대상으로 돌렸거나 결제 방식을 바꿨으면, 예전 경로의 요청은 승인 · 실행되지 않는다.
  - 수취인마다 직접 결제 경로(`provider` · `credential_id`)를 둘 수 있다("직접 결제 어댑터").
- **돈 설정의 권한:** 한도 · 임계값 · 수취인 · 통화 · 결제 방식을 바꾸는 것은 `marketing.approve_spend` 의 일이다. 임계값을 0 으로 내리면 혼자 승인할 수 있고 수취인을 넣으면 돈이 갈 곳이 생기므로, 캠페인 운영 권한(manage)만으로는 바꾸지 못한다.
- **결제 방식**(`payment_provider`, `payment_credential_id`)
  - 캠페인 설정이고, 에이전트가 고르지 않는다. 직접 결제 경로가 없는 수취인이 이 방식을 쓴다(`manual` · `webhook`).
  - 바꾸려면 `approve_spend` 가 있어야 한다.
  - webhook credential 에는 `webhook_url` 과 `secret`(16자 이상) 필드가 있어야 한다. webhook_url 은 https 여야 한다(loopback 만 http 허용).

### 원장 계산 (`common/marketing/budget.ts`)

- 쓰기 전에 요청별로 `release ≤ reserve`, `capture ≤ reserve`, `refund ≤ capture` 를 강제한다.
- `held = Σreserve − Σrelease`, `spent = Σcapture − Σrefund`.
- 원장 행은 그 요청이 **승인된 기간**(`period_key`)에 묶인다. 다음 달에 결제 · 환불돼도 승인한 달의 사용량이다.
- 총 가용 · 기간 가용 · 채널 가용(편성 − 그 채널의 기간 held + spent)을 같은 함수(`spendViolations`)로, 요청 시점과 승인 시점에 두 번 검사한다.

### 상태 기계

```
pending ──approve──▶ approved ──(자동 실행)──▶ executing ──▶ paid
   │  (2인 규칙: 첫 승인은 pending 유지)          │       ├──▶ failed  (release)
   ├─deny──▶ denied                               │       └──▶ unknown (사람이 대조: paid | failed)
   ├─expire(72h)──▶ expired                        │
   └─cancel(사람 · 캠페인 정지)──▶ cancelled          └ manual: 사람이 "결제 완료"(거래 id 필수) 또는 "실패"를 기록
```

자동 실행은 승인되면 서버가 스스로 보내는 결제 방식이다: `webhook` 과 직접 결제(`meta_ads` · `google_ads` · `stripe_issuing`, "직접 결제 어댑터").

1. **요청.** 에이전트가 `request_marketing_spend` 를 부른다.
   - 인자: `campaign_id`, `channel_id`, `amount_minor`, `currency`, `payee`, `purpose`, `expected_outcome`, `payload?`, `dedupe_key?`
   - 한도 · 통화 · 허용 수취인 · 편성을 미리 검사한다. 넘으면 **저장하지 않고** 거부하고, 사유는 감사 로그(`spend.refused`)에 남긴다.
   - 금액 · 수취인 · 목적 · 공급자 · payload 의 정규화 JSON 해시를 `payload_sha256` 으로 저장한다. 요청 행은 pending 을 떠나면 바뀌지 않는다.
   - 수취인의 경로(결제 방식 · credential · `ref`)를 요청에 스냅샷으로 남긴다(`provider` · `provider_credential_id` · `payee_ref`).
   - 직접 결제 수취인이면 에이전트의 `payload` 를 받지 않는다. 한도 검사를 통과한 뒤에 서버가 대상을 읽어 실행 계획을 만들고, 그 계획이 `payload` 가 된다("직접 결제 어댑터").
2. **승인.** 한 트랜잭션에서 다음 순서로 처리한다.
   1. 캠페인 행의 `spend_version` 을 올린다. Postgres 에서는 행 잠금, sql.js 에서는 직렬화 큐가 된다.
   2. 요청을 다시 읽는다: pending 인지, 만료 전인지 본다.
   3. **승인자가 화면에서 본 `payload_sha256`** 이 일치하는지, 저장된 해시와 다시 계산한 해시가 일치하는지 본다.
   4. 수취인의 지금 경로가 요청 때와 같은지 본다. 직접 결제는 계획의 산수와 credential 지문도 본다.
   5. 원장 합을 다시 계산하고 한도를 재검사한다.
   6. 상태를 CAS 로 바꾸고, `reserve` 행과 감사 행을 쓴다.

   승인자 identity 는 로그인 세션에서만 온다. 2인 규칙 대상이면 첫 승인은 `approvals` 에 기록만 하고, 같은 사람은 두 번 승인할 수 없다.
3. **실행(자동 실행).** 다음 순서로 진행한다. 3–4 는 webhook 의 것이고, 직접 결제는 "직접 결제 어댑터" 의 실행을 따른다.
   1. 캠페인 잠금 트랜잭션 안에서 **지금도 보내도 되는지** 다시 본다: 캠페인 active, 수취인이 아직 허용 목록에 있고 경로가 같음, 채널 active, 저장된 해시 일치. 직접 결제는 계획 · credential 지문 · 승인 1시간 이내도 본다. 하나라도 어긋나면 보내지 않고 `failed`(예산 해제)로 닫는다. 통과하면 같은 트랜잭션에서 `approved → executing` 을 CAS 로 커밋한다.
   2. sql.js 는 이때 파일로 즉시 내려 쓴다(`flushSqljs` — 진행 중인 트랜잭션이 끝난 뒤에 쓴다). 내려 쓰지 못하면 보내지 않는다.
   3. (webhook) 정규화 JSON 본문을 POST 한다. 헤더는 다음과 같다.
      - `X-AWB-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`
      - `Idempotency-Key: <spend request id>` (재시도해도 바뀌지 않는다)
   4. 응답으로 결과를 나눈다.

   | 응답 | 결과 | 예산 |
   | --- | --- | --- |
   | 2xx + `transaction_id` | `paid` | `release` + `capture` |
   | 명확한 거절(400 · 401 · 402 · 403 · 404 · 422) | `failed` | `release` |
   | 그 밖(타임아웃 · 5xx · 리다이렉트 · 408 · 409 · 425 · 429 · `transaction_id` 없는 2xx) | `unknown` | 그대로 보류 |

   409 는 멱등 키 중복(= 이미 처리됐을 수 있음)인 경우가 많아 거절로 보지 않는다.

   - **자동 재전송은 없다.**
   - **보내기 전에 멈춘 것만 `failed` 다.** 어댑터는 그런 실패를 `PaymentNotSentError` 로만 알린다. 그 밖의 예외(보낸 뒤의 해석 실패 · 프로그래밍 오류)는 이미 나갔을 수 있어 `unknown` 이다.
   - 재시작하거나 10분 넘게 걸린 `executing` 은 `unknown` 이 된다. 이 전이도 캠페인 잠금 안에서 한다 — 결과를 기록하는 트랜잭션과 줄을 서서, 기록하던 결과가 사라지지 않게.
   - 그렇게 시스템이 `unknown` 으로 돌린 뒤에 실행이 확정 결과(`paid` · `failed`)를 받으면, 그 결과로 `unknown` 을 닫는다. 서버가 둘일 때 한쪽이 부팅하며 다른 쪽의 실행을 `unknown` 으로 돌리는 경우다. 사람이 이미 대조했으면 결과를 버리지 않고 `spend.late_result` 로 감사에 남긴다.
   - 늦게 온 결과도 `unknown` 이면 상태는 그대로 두고 오류 문장과 응답 요약(`provider_response` — 카드 id 같은 대조 근거)만 채운다. 시스템이 돌릴 때는 공급자 응답이 없어서, 그대로 두면 대조할 근거가 행에 남지 않는다.
   - 승인 직후 프로세스가 죽어서 `approved` 로 남은 자동 실행 요청은 sweep 이 실행한다. 아직 아무것도 보내지 않은 상태라 안전하다.

   본문 필드: `type`, `spend_request_id`, `campaign{id,name,slug}`, `channel{id,platform,target}`, `amount_minor`, `currency`, `payee`, `payee_ref`, `purpose`, `payload`, `payload_sha256`, `approved_by[{name,at}]`, `issued_at`
4. **환불.** `approve_spend` 를 가진 사람이 사유를 적어 기록한다.
   - 결제된 금액 안에서만 기록할 수 있다.
   - 환불은 capture 에 묶이고, 요청을 다시 열지 않는다(`paid` 로 남는다).
   - 직접 결제(상한 · 카드 공급자)는 환불을 기록할 수 없다("직접 결제 어댑터").
5. **취소.** `pending` 은 그대로, 승인됐지만 아직 보내지 않은 `approved` 는 보류한 예산을 풀며 `cancelled` 로 닫는다. `executing` 이후는 이미 나갔을 수 있으니 취소가 아니라 대조의 일이다.
6. **정리.** 캠페인을 일시정지하거나 보관하면 `pending` 요청은 `cancelled` 가 된다. 원장이 생긴 뒤에는 통화를 바꿀 수 없고, 캠페인을 삭제할 수도 없다(보관만 된다).

### 직접 결제 어댑터 (Meta Ads · Google Ads · Stripe Issuing)

서버가 공급자에 직접 지시한다. 순수 규칙은 `common/marketing/payment-routes.ts`, 어댑터는 `marketing-payment-meta.ts` · `marketing-payment-google.ts` · `marketing-payment-stripe.ts`, 등록부는 `marketing-payment-adapters.ts` 에 있다.

직접 어댑터는 **돈을 보내지 않는다.** 공급자는 두 종류다(`DIRECT_PROVIDER_SPECS` — 종류와 배타성). 공급자를 더하면 그 표와 공급자별 switch(`assertNever`)가 빠진 곳을 컴파일 오류로 알려 준다 — "Meta 가 아니면 Google" 같은 분기를 쓰지 않는다.

| 종류 | 공급자 | 하는 일 | 대상마다 열린 요청 하나 |
| --- | --- | --- | --- |
| 상한(`ceiling`) | Meta Ads · Google Ads | 광고 캠페인의 고정 상한을 승인 금액만큼 올린다(compare-and-set) | 예(`target_key`) |
| 카드(`card`) | Stripe Issuing | 승인 금액이 누적 한도인 가상 카드를 한 장 만든다(사람이 그 카드로 결제) | 아니오 — 카드끼리 서로 영향이 없다 |

아래 "상한 공급자" 부분은 Meta · Google 의 것이고, 카드는 "카드 공급자(Stripe Issuing)" 에 따로 적는다. 결제 경로 · 계획 해시 · 사람이 바꾼 결정 · 결과 불명 · 환불 · 연결 확인의 원칙은 둘에 같다.

**상한 공급자 — 돈을 보내지 않고 고정 상한을 올린다.** 광고 플랫폼은 받을 사람에게 돈을 보내는 곳이 아니라, 정해 둔 만큼 쓰게 하는 곳이다. 그래서 직접 어댑터는 **고정 상한**을 올리기만 하고, **승인 금액 = 상한이 늘어나는 양**이다.

| 공급자 | 올리는 상한 | 받지 않는 것 |
| --- | --- | --- |
| Meta Ads (Graph API v26.0) | 캠페인 `spend_cap` — Meta 가 문서화한 캠페인 단위의 유일한 고정 상한. 광고 세트 일 예산 · 예산 일정 · 예산 공유도 이 안에 묶인다 | 일 예산(하루 1.75배 · 주 7배 · 예산 일정 8배까지 쓴다), 한도가 없는 캠페인 |
| Google Ads (REST v26) | 공유하지 않고 이 캠페인에만 붙은 `CUSTOM_PERIOD` 총예산(`total_amount_micros`, 종료일 필요) — Google 이 "hard cap" 으로 명시 | 일 예산(하루 2배 · 월 30.4배, 기간 끝이 없음), 공유 예산, 계정 예산(월 청구서 결제 계정 전용 · 비동기 심사) |

- 일 예산은 기간 끝이 없거나 하루 상한을 넘어 쓰이므로, 원장이 승인 금액으로 묶을 수 없다.
- 처음 상한은 사람이 광고 화면에서 정한다. AWB 는 있는 상한을 올리기만 한다. 그래서 처음 상한(Meta 는 최소 약 100 USD)은 원장 밖이다.
- Google 은 일 예산 캠페인을 총예산으로 바꿀 수 없다. 이 경로를 쓰려면 캠페인을 처음부터 총예산 + 종료일로 만든다.
- `paid` 는 "공급자가 새 상한을 받아들였다" 이다. 돈은 아직 다 쓰이지 않았을 수 있다. 원장은 지금처럼 `release` + 승인 금액 전체 `capture` 로 센다(보수적인 상한). 화면은 "한도 반영됨" 으로 보여 준다.
- 공급자는 상한을 아주 조금 넘길 수 있다(Meta 는 변경 반영에 최대 15분, 지출은 추정치). 원장(`capture ≤ reserve`)에는 담기지 않으므로 대조 때 사람이 본다.

**결제 경로는 수취인마다 정한다.** 수취인 항목에 `provider`(`meta_ads` · `google_ads` · `stripe_issuing`) · `credential_id` · `ref` 를 둔다. 경로가 없는 수취인은 캠페인 결제 방식을 쓴다. 그래서 한 캠페인이 여러 플랫폼에 돈을 댈 수 있고, 돈이 갈 수 있는 곳은 사람이 허용 목록에 넣은 상한 · 카드 소지자뿐이다. 수취인은 돈 설정이다(`approve_spend`).

| 공급자 | `ref`(대상) | credential(`provider` 칼럼 = 공급자 이름) |
| --- | --- | --- |
| Meta Ads | `act_<광고 계정 id>/<캠페인 id>` — 그 캠페인의 `account_id` 와 대조한다 | `access_token`(시스템 사용자 토큰, `ads_management`), `app_secret`(선택 — appsecret_proof) |
| Google Ads | `<고객 id>/<캠페인 id>`(10자리, 대시 허용 — 저장은 숫자만) | `client_id` · `client_secret` · `refresh_token`(adwords 범위), `login_customer_id`(선택 — 관리자 계정), `developer_token`(비워 둔다 — 2026-09-09 폐지, 지금은 무시되고 이후 API 버전은 거부한다. 있으면만 보낸다) |
| Stripe Issuing | 카드 소지자 id `ich_…` | `secret_key` — 운영은 제한된 키 `rk_live_…`(Issuing Cards: Write · Issuing Cardholders: Read)만, 샌드박스는 `rk_test_…` · `sk_test_…`. 전체 운영 키 `sk_live_…` 는 거부한다 |

- credential 은 Credentials 화면에서 그 공급자(Meta Ads · Google Ads · Stripe Issuing)를 골라 **이 계정에** 만든다. 다른 종류(custom 등) · 전역 · 에이전트 노출(`agent_env`) credential 은 거부한다. 이 공급자들은 에이전트 노출을 고를 수 없다.
- Google Ads API 접근 수준은 OAuth client(`client_id`)의 Google Cloud 프로젝트에 붙는다(developer token 대신). 운영 계정에 쓰려면 그 프로젝트에 Explorer 이상의 접근이 있어야 한다 — Test 수준은 테스트 계정만 부를 수 있다.
- 수취인을 저장할 때 ref 형식(정규 형태로 저장)과 credential 을 확인한다. 상한 공급자는 같은 대상을 가리키는 수취인 둘을 거부한다(카드는 같은 카드 소지자를 여러 수취인이 써도 된다).

**요청 때 서버가 실행 계획을 만든다(읽기만).**
- 에이전트는 수취인과 금액만 고르고 `payload` 를 넣을 수 없다.
- 서버가 대상을 읽어 확인한다: 계정 일치, 통화 일치, 계정 · 캠페인 상태, 상한 형태(Meta: `spend_cap` 있음 · 경매 캠페인 · 계정 최소 상한, Google: `CUSTOM_PERIOD` · 비공유 · 이 캠페인에만 붙음 · 종료일 · 청구 단위 배수).
- 확인을 통과하면 계획을 만든다: 대상 · 필드 · `from`(지금 상한) → `to = from + 금액`, 공급자 단위와 AWB 최소 단위를 함께 담고, credential 지문을 넣는다. 공급자 화면의 이름은 `target_name_untrusted` 로 표시용으로만 담는다.
- 이 계획이 `payload` 가 되어 해시된다. 승인 화면은 서버가 쓴 한 문장(`plan_text`)으로 보여 준다. 예: "Meta 광고 계정 act_9 의 캠페인 77 지출 한도(spend_cap)를 1,000.00 USD → 1,300.00 USD 로 올립니다(+300.00 USD)."
- 공급자 확인이 실패하면 저장하지 않고 거부하고 `spend.refused` 로 감사에 남긴다. 거부 문구는 "사람이 고쳐야 함" 과 "다음 사이클에 다시" 를 구분한다.
- 금액 · 통화 단위 문제는 공급자를 읽기 전에 거절하고 쉬지 않는다. 나누어떨어지지 않는 금액은 400(금액을 고친다), 표에 없는 통화는 409(사람이 캠페인 통화나 수취인을 고친다)다.
- 공급자를 읽은 뒤의 거절은 그 (캠페인, 대상, credential) 를 잠시 다시 묻지 않는다 — 에이전트의 되풀이가 공급자 호출로 번지지 않게. 대상 · 인증 문제는 10분, 금액에 달린 것(계정 최소 상한 · 청구 단위 · 상한 최대값)은 1분이다(금액만 바꿔 되풀이해도 그때마다 읽지 않게). 쉬는 동안의 거절 문구는 언제까지 기다리라고 알린다. 수취인이나 credential 을 고치면 키가 바뀌어 바로 다시 묻고, 연결 확인이 정상이면 풀린다.
- **(상한 공급자) 대상마다 열린 요청은 하나다**(`target_key`, 부분 유일 인덱스 `uq_marketing_spend_open_target`). 캠페인 · 계정을 넘어서도 적용된다. 카드 공급자는 `target_key` 를 남기지 않는다(빈 값은 어떤 요청과도 맞지 않는다). 같은 `from` 으로 계획된 요청 둘이 있으면 먼저 실행된 쪽이 다른 쪽의 `from` 을 바꾸고, 동시에 실행되면 둘 다 `from` 을 읽고 쓴다. 요청 · 승인 · 실행 · 결과 불명 동안 열려 있다 — 결과 불명은 대조해야 그 대상에 새 요청을 낼 수 있다.
  - 같은 계정의 열린 요청은 공급자를 읽기 전에 그 id · 상태와 함께 알린다.
  - 다른 계정의 열린 요청은 이 계정의 credential 로 그 대상을 실제로 읽은 뒤에만 알리고, id · 상태는 싣지 않는다(연결 확인에는 `open_request: { id: '', status: 'other_account' }`). 대상 ref 를 짐작해 다른 계정의 지출을 엿보지 못하게 하려는 것이다.
  - 이것도 공급자를 읽은 뒤의 거절이라 그 대상을 쉰다(10분) — 되풀이할 때마다 남의 광고 계정을 읽지 않게. 그 요청이 닫히면(DB 로 본다) 바로 풀린다.

**통화 단위는 닫힌 표로만 바꾼다**(`PAYMENT_CURRENCIES`). 표에 없는 통화는 거부한다. 모르는 통화를 기본 지수로 추측하면 상한이 100배로 움직일 수 있다.
- Meta 는 통화마다 offset 이 있다. COP · CRC · HUF · IDR · TWD 는 Meta 가 정수 단위(ISO 는 소수 둘째 자리), BHD · JOD 는 1/100(ISO 는 1/1000)이다. 나누어떨어지지 않는 금액은 거부한다. KWD · OMR · TND 는 Meta 표에 없어 받지 않는다.
- Google 은 micros(1 단위 = 1,000,000)다. BigInt 로 계산하고, JSON 에서는 문자열로 보낸다.
- 공급자가 준 정수는 숫자 문자열만 받는다 — `''` 가 0 으로 읽히지 않게.

**(상한 공급자) 실행은 compare-and-set 이다.** 두 공급자 모두 조건부 쓰기와 멱등 키가 없다. 그래서 실행 직전에 다시 읽고, 요청 때와 같은 대상 · 통화 · 형태이고 값이 `from` 일 때만 절대값 `to` 를 한 번 쓴다. 같은 값을 다시 써도 결과가 같다.
- 값이 이미 `to` 면 쓰지 않고 `unknown` 이다. 누군가 공급자 화면에서 바꿨으니 사람이 정한다.
- 다른 값이거나, 대상이 바뀌었거나, 읽지 못했으면 보내지 않고 `failed` 다.
- 토큰은 `Authorization` 헤더로만 보낸다. 주소에 넣지 않는다(로그 · 오류 문자열로 샌다). 공급자 주소는 코드에 고정돼 있어 credential 로 바꿀 수 없다. 리다이렉트는 따라가지 않는다.
- Google 은 `partialFailure: false` 로 한 operation 만, `responseContentType: MUTABLE_RESOURCE` 로 보낸다. 돌아온 `totalAmountMicros` 가 `to` 일 때만 확정이다.

| 응답 | Meta | Google |
| --- | --- | --- |
| `paid` | 2xx 이고 본문이 `{"success":true}` | 200 이고 결과가 하나, 그 리소스 · `totalAmountMicros` 가 계획과 같음 |
| `failed`(예산 해제) | 4xx Graph 오류 중 코드 100 · 102 · 190 · 10 · 200–299 · 368 · 2635 · 801, 호출 제한(4 · 17 · 32 · 341 · 613 · 80000–80014). 처리 전에 막힌 것이다. 그 밖의 `is_transient` 는 제외 | 400 · 401 · 403 · 404(원자적 mutate 의 거절), `GoogleAdsFailure` 본문이 붙은 409(동시 수정) · 429(할당량) |
| `unknown`(보류 유지) | 그 밖: 코드 1 · 2, 모르는 코드, Graph 본문이 아닌 4xx, 5xx, 시간 초과, 다른 2xx | 그 밖: 499 · 5xx, 본문 없는 409 · 429, 시간 초과, 리소스 이름만 온 200 |

- `failed` 로 분류해도 한 번 다시 읽는다. 이미 `to` 이면 `unknown` 으로 둔다 — 거절이라던 쓰기가 반영됐는데 예산을 풀면 원장이 덜 센다.
- 토큰 갱신 실패(`invalid_grant` 등)는 보내기 전이라 `failed` 다. "Testing" 상태 OAuth 앱의 refresh token 은 7일 뒤 만료된다 — 앱을 게시한다.
- 테스트 계정 ↔ 운영 계정이 바뀌었으면(Google `test_account`) 보내지 않는다.
- 응답은 허용 목록 요약만 저장한다(`provider_response`: 대상 · from/to · 상태 코드 · 오류 코드 · `fbtrace_id`/`request-id`).
- **오류 문장(`error`)에는 서버가 쓴 문장과 상태 코드 · 오류 코드만 넣는다.** 이 문장은 에이전트(MCP)까지 간다.
  - 공급자가 준 글(오류 메시지)은 비밀 값을 **먼저** `[redacted]` 로 바꾸고(자른 뒤에 바꾸면 경계에 걸린 비밀 값의 앞부분이 남는다) 제어 문자를 지우고 자른 뒤, 응답 요약의 `message_untrusted`(요청 때 거부는 감사의 `provider_message_untrusted`)에만 싣는다(`providerMessage`).
  - 공급자가 준 값 중 형식이 정해진 것(상태 · 통화 · id · 예산 리소스 이름 · 종료 시각 · 추적 id)은 형식에 맞을 때만 받는다. 형식이 틀리면 빈 값으로 읽혀 대조에서 걸린다. 규칙 위반 문장에 자유 글이 섞이지 않게 하려는 것이다.
  - Google 은 고치는 예산이 대상 고객 계정 아래의 것(`customers/<고객 id>/campaignBudgets/…`)인지도 본다.
- 공급자 글(오류 메시지 · 캠페인 이름)은 사이클 지시문의 신뢰 구역과 알림에 싣지 않는다.

**사람이 바꾼 결정이 이긴다.**
- 승인 · 실행 때 수취인의 지금 경로가 요청 때와 같아야 한다.
- credential 지문이 같아야 한다. 지문은 복호화한 필드의 정규화 JSON 을 서버 비밀 키로 서명한 HMAC 이다(암호화 키에서 HKDF 로 끌어낸 지문 전용 키, `keyedDigest`).
  - 그 사이 키를 다른 계정의 키로 바꾸는 등 내용이 바뀌면 그 요청은 실행되지 않는다.
  - 이름 · 설명만 고쳤거나 같은 값을 다시 저장한 것(화면이 가린 값을 그대로 보내 다시 암호화된 경우)은 그대로 실행된다.
  - 계획은 에이전트도 읽지만, 서버 키 없이는 지문에서 비밀 값을 맞혀 볼 수 없다.
- 승인한 지 1시간이 지난 직접 결제는 실행하지 않는다. 장애 · 복구 · 이관 뒤에 묵은 승인이 실행되지 않게 하려는 것이다. 보통은 승인 직후, 늦어도 sweep(5분)이 실행한다.

**결과 불명 대조.**
- 요청 카드의 "공급자에서 확인"(`POST /spend-requests/:id/inspect`, 읽기 전용)이 상한 공급자는 지금 상한이 목표값인지 · 이전 값인지 · 그 밖인지, 카드 공급자는 이 요청의 카드가 있는지(아래) 보여 준다. 판정은 사람이 한다.
- Meta 는 변경 반영에 최대 15분, Google 변경 기록은 몇 분 늦게 보인다.
- 그래서 직접 결제의 결과 불명은 **실행 뒤 15분이 지나야 "실패" 로 기록할 수 있다**(그 전에는 409, 언제부터인지 알려 준다). "아직 안 바뀌었다" 를 보고 일찍 실패로 닫으면 나중에 반영된 상한이 원장 밖에 남는다. "결제 완료" 는 바로 기록할 수 있다 — 원장을 더 세는 쪽이다.
  - 이 판단은 캠페인 잠금 안에서 다시 읽은 상태로 한다. 실행 중에 누른 "실패" 가 잠금을 기다리는 사이 결과 불명이 된 요청을 유예 없이 닫지 않게.
- 결제 기록 창은 거래 id 자리를 서버가 만든 기록용 값(`suggested_provider_ref`, 예: `meta_ads:act_9/77:spend_cap=130000`)으로 미리 채운다. 광고 플랫폼 상한 변경에는 거래 id 가 없다. 카드는 "공급자에서 확인" 이 찾은 **활성** 카드의 id(`ic_…`)만 채운다 — 실행이 받아 둔 카드 id(`suggested_provider_ref`)는 활성화되지 않은 카드일 수 있어 쓰지 않는다.

**환불은 막는다.** 상한 · 카드가 그대로인데 "미사용분" 을 돌려받았다고 적으면, 그 돈은 아직 쓰일 수 있는데 원장은 덜 센다. 상한을 실제로 낮추거나 카드를 해지하고 쓴 돈을 대조해 그만큼 환불을 기록하는 기능은 후속이다. 그때까지 원장은 승인 금액 전체를 사용으로 센다.

**연결 확인(읽기 전용).** `POST /campaigns/:id/payment/check`(`approve_spend`)가 직접 결제 수취인마다 credential 과 대상을 요청 · 실행과 같은 읽기 코드로 읽는다. 보여 주는 것은 정상 · 문제 · 지금 상한 · API 버전 · 열린 요청이다. 아무것도 쓰지 않고, `payment.checked` 로 감사에 남긴다. 실제(또는 테스트) 계정을 돈을 움직이지 않고 검증하는 길이다.
- 읽기가 실패하면 공급자가 준 글도 `provider_message_untrusted` 로 보여 준다. 요청별 확인의 오류 문장도 그 글을 덧붙인다. 둘 다 사람만 부르는 REST 라 에이전트에게 가지 않는다.
- Meta: 개발용 샌드박스 광고 계정은 광고를 내보내지 않는다.
- Google: 테스트 관리자 계정 아래의 테스트 계정은 광고를 내보내지 않고 청구도 없다.

**API 버전.** 코드에 고정한다(Meta `v26.0`, Google `v26`, Stripe `2026-09-30.endive`). 공급자가 버전을 닫으므로 `MARKETING_META_API_VERSION` · `MARKETING_GOOGLE_ADS_API_VERSION` · `MARKETING_STRIPE_API_VERSION` 으로 코드 수정 없이 올릴 수 있다. 형식이 틀린 값은 무시한다. Stripe 는 일회용 카드가 들어온 `2026-03-25.dahlia` 보다 오래된 버전과 `.preview` 채널도 무시한다(계정 기본 버전에 기대지 않고 매 요청에 `Stripe-Version` 을 싣는다). 버전은 계획(해시)에 넣지 않고, 실제로 쓴 버전을 응답 요약 · 연결 확인에 남긴다. 닫힌 버전은 Meta 오류 2635 등으로 거절된다(`failed`, 아무것도 바뀌지 않음).

#### 카드 공급자(Stripe Issuing) — 일회용 발급과 수취인별 재사용 카드

일회용이면 승인마다 서버가 수취인의 카드 소지자(`ich_…`) 아래에 **가상 카드 한 장**을 만든다. 재사용이면 수취인에 지정한 카드(`ic_…`)의 누적 한도를 승인 금액만큼 올리고, 카드 id 가 없으면 첫 승인 때 만들어 수취인에 기록한다. 첫 발급의 누적 한도(`spending_limits[].interval = all_time`)는 승인 금액이고, 사람이 Stripe 대시보드에서 카드 정보를 보고 그 카드로 결제한다. 미국 · 영국 · EEA 에 설립된 사업자만 쓸 수 있고(한국 법인 불가), 카드 통화는 지역에 따라 USD · EUR · GBP 하나다.

- `paid` 는 첫 발급이면 "카드가 발급됐다", 재사용이면 "한도가 반영됐다" 다. 원장은 승인 금액 전체를 사용으로 센다(보수적). 화면은 "카드 발급됨" 또는 "한도 반영됨" 과 대시보드 링크(`https://dashboard.stripe.com/[test/]issuing/cards/<id>`)를 보여 준다.
- **카드 번호 · CVC 는 AWB 가 가져오지 않는다**(`expand[]=number` 를 쓰지 않는다 — PCI). Stripe 응답에 박혀 오는 카드 소지자(이름 · 주소 · 연락처)는 id 말고 읽지 않는다 — 계획 · 응답 요약 · 감사 · MCP 어디에도 없다. 카드 소지자 이름은 사람만 보는 연결 확인에만 `target_name_untrusted` 로 보인다.

**수취인 카드 통제(돈 설정, `approve_spend`).** Stripe 수취인에만 둔다. `card_single_use` · `card_categories` 는 요청의 계획(해시)에 들어가고, 승인 · 실행 때 수취인의 지금 값과 다르면 실행하지 않는다. `card_max_minor` 는 계획에 넣지 않는다 — 승인 · 실행 때 계획의 한도가 수취인의 지금 최대를 넘으면 실행하지 않는다(둘 다 `directPayeeProblem`). 예산 설정에서 캠페인 통화를 바꾸면 화면이 카드당 최대도 비우고 새 통화로 다시 적어야 저장한다(지운 채로 두면 최대가 사라지므로).

| 필드 | 뜻 |
| --- | --- |
| `card_single_use` | 첫 결제 뒤 자동 해지(`lifecycle_controls[cancel_after][payment_count] = 1`). 기본 켬. 여러 번 청구하는 곳(광고 플랫폼 · SaaS 등)에는 끈다 — 같은 카드의 누적 한도를 승인마다 올린다 |
| `card_id` | 재사용 카드 id(`ic_…`). Stripe · `card_single_use=false` 에서만 지정한다. 비우면 첫 승인 때 생성해 저장한다. 해지·교체된 카드는 사람이 이 값을 고친다 |
| `card_categories` | 허용 업종(Stripe merchant category 이름, 소문자 · 정렬 · 20개까지). 비면 업종 제한 없음. 틀린 이름은 Stripe 가 카드를 만들 때 거절한다(아무것도 만들어지지 않는다) |
| `card_max_minor` | 카드 한 장의 누적 한도 최대(재사용은 현재 한도 + 이번 승인 금액). 셀프 서비스 Standard 프로그램은 카드당 하루 500 USD 라 500 을 권한다 |

**요청.**
- 금액은 Stripe 를 부르기 전에 본다: 통화가 카드 통화가 아니면 409(사람이 캠페인 통화를 고친다), 일회용 카드는 승인 한 건의 고정 상한(10,000.00) 이하, 수취인의 카드당 최대 이하(400 — 쓰지 못할 예산이 묶이지 않게).
- 카드 소지자를 읽어 본다(쓰기 없음): `status = active`, `requirements.disabled_reason` 없음, `past_due` 없음, 키의 모드(운영 · 샌드박스)와 카드 소지자의 `livemode` 가 같음.
- 계획: `{ plan: 'issue_card', target: { cardholder }, currency, limit_minor = 금액, interval: 'all_time', single_use, allowed_categories, livemode, credential_fingerprint }`. `plan_text` 예: "Stripe Issuing 카드 소지자 ich_… 에게 누적 한도 300.00 USD 의 일회용(첫 결제 뒤 자동 해지) 가상 카드를 발급합니다(허용 업종: advertising_services)." 샌드박스면 "[샌드박스 카드 …]" 가 붙는다 — 샌드박스 카드도 캠페인 예산은 쓴다.

**재사용 카드의 한도 증가.** 기존 카드가 있으면 요청 때 현재 `all_time` 한도를 읽어 `from → to`(현재 한도 → 현재 한도 + 승인 금액)를 계획한다. 실행 직전 다시 읽어 카드 소지자 · 통화 · 모드 · 업종 · 상태와 한도를 대조하고, 현재 한도가 `from` 일 때만 `to` 로 수정한다. 수정 요청은 요청별 고정 멱등 키를 쓴다. 해지된 카드나 교체가 필요한 카드는 자동으로 다른 카드를 만들지 않고 수취인을 고치게 한다. 응답이 모호하면 `unknown` 으로 남긴다.

`stripe_issuing:<card id>` 를 `target_key` 로 잡아 같은 카드에는 열린 요청을 하나만 허용한다. 첫 발급도 `stripe_issuing:payee:<campaign id>:<정규화한 수취인 이름>` 으로 해당 수취인의 열린 요청을 배타 처리한다. `paid` 는 이번 승인 금액만큼 한도가 반영됐다는 뜻이며 원장은 그 승인 금액 전체를 사용으로 센다. 미사용 한도를 낮춰 환불하는 기능은 별도 후속 범위다. 재사용 한도 증가의 결과 불명은 기존 카드를 자동 해지하지 않는다. 실패 기록은 공급자에서 한도가 아직 `from` 인지 확인하고 사람이 `confirm_no_spend` 를 함께 보내야 한다. 아래 생성·활성화와 카드 검색 절차는 일회용 및 재사용 카드의 첫 발급에 적용된다.

**실행 — 2단계 발급.**
1. 카드 소지자를 다시 본다. 막혔거나 모드가 바뀌었으면 보내지 않고 `failed` 다.
2. 카드를 **비활성**으로 만든다(`POST /v1/issuing/cards`, `status=inactive`, 한도 · 업종 · 일회용 · `metadata[awb_spend_request_id]` 는 만들 때만 정할 수 있다). 멱등 키 `awb-spend-<요청 id>`.
3. 돌아온 카드를 계획과 대조한다(`cardMismatches` — 카드 소지자 · 통화 · 종류 · 상태 · 모드 · metadata · 우리 누적 한도 · 업종 집합 · 일회용). 우리 누적 한도가 있으면 다른 한도는 더 좁힐 뿐이라 받는다. 다르면 **해지**하고(`-cancel` 키) `failed`, 해지하지 못하면 `unknown`. 해지는 Stripe 가 **그 카드(id)가 `canceled` 인 카드 객체**로 답했을 때만 된 것으로 본다 — 다른 카드 · 빈 본문은 해지를 모르는 것이다(이 문서의 "해지하고 `failed`" 는 모두 이 확인을 거친다).
4. 활성화한다(`status=active`, `-activate` 키). 돌아온 카드가 만든 그 카드(id)이고 계획과 같으면 `paid`(거래 id = 카드 id).
   - 같은 카드인데 계획과 다르면 해지하고 `failed`(해지 못 하면 `unknown`) — 승인한 계획과 다른 카드가 살아 있으면 안 된다.
   - 다른 카드로 답하면 그 카드는 무엇인지 모르니 건드리지 않고, 이 요청이 만든 카드만 해지해 두고 `unknown` 이다.

**멈췄던 실행은 카드를 살리지 않는다.** 실행 시작(`executing_at`)에서 5분(`STRIPE_ACTIVATE_WITHIN_MS`)이 지났으면 카드를 만들지 않고(보내지 않았으니 `failed`), 이미 만들었으면 활성화하지 않고 해지한다(`failed`, 해지 못 하면 `unknown`). 멈췄다 깨어난 실행이 늦게 카드를 살리면, 그 사이 요청은 결과 불명(10분)이 되고 사람이 "카드 없음" 을 보고 실패로 닫았을 수 있다(유예 15분) — 예산 밖의 카드가 된다. 요청 시간 초과(읽기 10초 · 쓰기 20초)로 보통은 닿지 않는 한계다. 실행 시각은 실행한 서버의 시계로, 유예는 실패를 기록하는 서버의 시계로 재므로 서버가 여럿이면 시계가 맞아야 한다(NTP).

그래서 모호한 생성으로 생겼을지 모르는 카드나 Stripe 장애 복구로 나중에 생긴 카드는 비활성이라 쓸 수 없고, `failed` 로 닫힌 요청에 쓸 수 있는 카드가 남지 않는다.

| 응답 | 결과 |
| --- | --- |
| 생성 · 활성화 모두 200 이고 계획과 같음 | `paid` |
| Stripe 오류 객체가 붙은 400 · 401 · 402 · 403 · 404 · 429(`idempotency_error` 제외) | 생성: `failed`. 활성화: 카드를 해지하고 `failed`(해지 못 하면 `unknown`) |
| 활성화가 200 인데 계획과 다른 카드 | 같은 카드: 해지하고 `failed`(해지 못 하면 `unknown`). 다른 카드: 이 요청의 카드만 해지하고 `unknown` |
| `idempotency_error`, 409, 424, 5xx, 시간 초과, Stripe 오류 객체가 아닌 본문 | `unknown` |

- 응답 요약: 대상 · 한도 · 단계(`create` · `activate`) · 상태 코드 · `error_type` · `error_code` · `request_id` · `idempotent_replayed` · `card_id` · 다른 항목 이름(`mismatched`). 공급자 글은 Stripe 오류 객체의 `error.message` 만 비밀(가려진 키 조각 포함)을 지워 `message_untrusted` 로 둔다 — 응답 본문은 저장하지 않는다.

**결과 불명 — 카드가 있으면 실패로 기록하지 않는다.**
- 카드 목록에는 metadata 검색이 없어, 서버가 그 카드 소지자의 가상 카드를 실행 시각 ±1일 범위에서 100장씩 10쪽까지 넘기며 요청 id 를 찾는다(`found` · `none` · `incomplete`). 실행이 받아 둔 카드 id(`provider_response.card_id`)는 목록과 따로 직접 읽는다 — metadata 가 다르게 돌아와 목록에서 못 찾는 카드도, 목록을 못 읽을 때(Stripe 장애)도 그 카드가 살아 있으면 실패 기록을 막는다. 두 읽기 중 하나만 실패하면 찾은 카드로 `incomplete` 다.
- **"없음"(`none`)은 범위를 끝까지, 모든 항목을 읽었을 때만이다** — 없음은 사람의 확인 없이 실패 기록(예산 해제)을 허락하기 때문이다. 목록 모양(`object: 'list'` · `data` 배열 · `has_more` 참거짓)이 아닌 답은 읽기 실패, 읽지 못한 항목이 있거나 더 있다는데 넘길 곳이 없거나 10쪽을 넘으면 `incomplete` 다.
- 요청 때와 다른 키(credential 지문)로는 찾지 않는다 — 카드 소지자 id 는 Stripe 계정마다라, 다른 계정의 "없음" 은 이 요청의 답이 아니다. "공급자에서 확인" 은 409, "실패로 기록" 은 찾지 못한 것으로 본다.
- "실패로 기록"(`mark-failed`)은 유예(실행 뒤 15분)가 지난 뒤 그 찾기를 먼저 한다(잠금 밖에서).
  - 해지되지 않은 카드가 있으면 `confirm_no_spend` 가 있어도 거부한다. 활성 카드면 그 카드 id 로 결제 완료를 기록하거나 대시보드에서 해지한 뒤 다시 한다. 비활성 카드는 AWB 가 활성화하지 않은 카드다 — 쓰지 않으면 대시보드에서 해지하고 `confirm_no_spend` 로 실패를 기록하고, 쓰려면 대시보드에서 활성화한 뒤 결제 완료로 기록한다(쓸 수 없는 카드에 예산 전체를 묶지 않게 결제 완료로 이끌지 않는다).
  - 해지된 카드만 있거나, 다 보지 못했거나, 찾지 못했으면(Stripe 장애 · credential 없음 · 바뀐 키) 사람이 대시보드에서 그 카드로 쓴 돈이 없음을 확인했다는 `confirm_no_spend` 를 함께 보내야 한다. 감사(`spend.failed`)의 `card_check` 에 남는다.
  - 카드가 없음이 분명하면 그대로 기록한다.
  - 잠금 안에서 다시 읽은 행이 확인하지 않은 채 결과 불명이 됐거나(실행 중으로 보고 들어온 요청), 찾는 사이 늦게 온 결과가 실행의 카드 id 를 채웠으면 409 — 그 카드를 본 확인으로만 닫는다.
- "공급자에서 확인" 이 찾은 카드(id · 상태 · 한도)를 보여 주고, 결제 기록 창은 활성 카드의 id 로만 미리 채운다.

**한도는 완전한 상한이 아니다.** 팁 · 나중 매입 · 초과 매입 · 강제 매입 · 네트워크 폴백은 한도를 넘을 수 있고, 집계는 30초쯤 늦을 수 있다. 원장은 승인 금액을 세므로, 넘은 몫은 사람이 Stripe 거래 내역과 대조한다. 셀프 서비스 Standard 프로그램의 기본 한도는 주 25장 · 주 5,000 USD · 카드당 하루 500 USD 이고 승인 한 건은 최대 10,000 USD 다 — 일회용 카드의 한도가 500 을 넘으면 승인 창이 경고한다(Stripe 가 밝힌 한도는 USD 라 EUR · GBP 카드에는 같은 숫자를 근사로 쓴다 — "500 USD 상당").

**credential 발급 안내(사이트 안).** Credentials 화면에서 Meta Ads · Google Ads · Stripe Issuing 을 고르면 그 credential 을 발급받는 순서 · 칸마다 넣을 값 · 수취인 대상 · 자주 막히는 곳 · 공식 문서 링크가 펼쳐진다. 마케팅 수취인 설정에서 그 경로를 고르면 같은 안내가 붙는다. 글은 `apps/client/src/components/marketing/paymentCredentialGuides.ts` 한 곳에 있다(2026-10 공식 문서 기준 — 공급자가 화면 · 절차를 바꾸면 이 파일만 고친다). 칸 목록이 credential 필드와 같은지는 `apps/client/test/marketing-payment-contract.test.mjs` 가 본다.

## 분석

- **추적 링크** (`create_marketing_link`)
  - 목적지는 캠페인 `allowed_domains` 안이어야 한다. 그래서 오픈 리다이렉트가 되지 않는다.
  - 코드는 12자 base62 난수다.
  - UTM 은 기존 `utm_*` 를 보존하고 비어 있는 것만 채운다: `utm_source` = platform, `utm_medium` = community|email, `utm_campaign` = 캠페인 slug, `utm_content` = 게시물 또는 코드.
  - `AWB_PUBLIC_URL` 이 없으면 링크를 만들지 않는다.
- **공개 `GET /api/m/:code`**
  - 저장된 주소로만 302 한다. 모르는 코드나 형식이 틀린 코드는 같은 404 다.
  - 이동은 언제나 시킨다. 다만 다음은 클릭으로 **세지 않는다**: HEAD, prefetch, 봇 UA, 같은 클라이언트(IP + UA 해시, 메모리에만 보관)의 30분 내 반복, 분당 120회 초과.
  - 프록시 뒤에서는 X-Forwarded-For 를 쓰므로 조작될 수 있다. 그래서 클릭은 **raw** 로 표시하고, 클릭만 근거로 돈을 쓰지 말라고 리포트가 적는다.
- **지표** (`record_marketing_metrics`)
  - 에이전트나 사람이 관측한 값을 남기고, 출처도 같이 남는다. clicks 는 링크로만 센다.
  - reddit · GitHub outreach 채널(과 그 게시물)의 engagements · replies 는 서버가 읽으므로 기록하지 못한다("참여 지표 자동 수집").
  - 누적형(합): impressions · views · engagements · replies · signups · conversions · revenue_minor
  - 수준형(마지막 값): followers · subscribers
- **리포트** (`get_marketing_report`, `common/marketing/report.ts`)
  - 채널별: 게시 수 · 클릭 · 지표 · 지출(원장 capture − refund) · CPC · 가입/전환당 비용 · CTR · 전환율 · ROAS · 편성액 · 피드백 · 수집 글 · 티켓 수
  - 요약 줄과 경고 문구가 함께 나온다.

### 참여 지표 자동 수집

서버가 reddit · GitHub outreach 채널에 게시한 글은 게시 후 **14일** 동안 서버가 그 채널의 커넥터로 참여를 읽는다(`MarketingEngagementService`, 규칙은 `common/marketing/engagement.ts`). 에이전트 capability 와는 무관하다.

| 플랫폼 | `engagements` | `replies` | 읽는 곳 |
| --- | --- | --- | --- |
| reddit | score(순 추천 수) | 댓글 수(`num_comments`) | `/api/info` — 한 요청에 100개 |
| GitHub | 반응 합계(`reactions.total_count`) | 댓글 수(`comments`) | 이슈 · 이슈 댓글 GET — 한 요청에 하나 |

- 답글(댓글)로 올린 글은 자기 댓글 수가 없어 `engagements` 만 읽는다.
- reddit 이 아직 점수를 감춘 글(`hide_score` · `score_hidden`)은 점수를 건너뛴다.
- 채널 화이트리스트 밖이거나 플랫폼이 돌려주지 않은 글(지워짐 · 다른 저장소로 옮겨진 이슈)은 결과에서 빠진다.

**변화량으로 남긴다.** 플랫폼이 주는 값은 누적 수준값이다. 그대로 누적형 행에 넣으면 읽을 때마다 다시 더해진다.
- 그래서 읽을 때마다 직전에 읽은 값과의 차이를 `MarketingMetric`(source `connector`, 메모 `reddit score 45 → 57`)에 남긴다. 변화가 없으면 행이 없다.
- 행의 합이 곧 플랫폼의 현재 값이다. 리포트의 누적형 합이 그대로 맞고, 기간 합은 그 기간의 증가분이다.
- 점수가 내려가거나 댓글이 지워지면 음수 행이 남는다. 그래서 짧은 기간의 합은 음수일 수 있다.
- 마지막으로 읽은 값은 게시물에 있다: `engagement`(`engagements` · `replies` · `read_at`), `engagement_next_at`(다음 읽기, 끝났으면 null), `engagement_error`(마지막 실패 · 멈춘 이유). 게시물 REST 와 `get_marketing_campaign` 의 `recent_posts` 에 실린다.

**일정.**
- 게시 1시간 뒤 처음 읽는다.
- 그 뒤 글의 나이가 1일 미만이면 1시간, 3일 미만이면 3시간, 그 뒤는 12시간마다 읽는다.
- 14일째(기간 끝)에 마지막으로 읽고 멈춘다. 글 하나를 기간 동안 60번쯤 읽는다. 그 뒤의 변화는 세지 않는다.
- 실패해도 같은 간격을 따른다(막힌 채널을 몇 분마다 두드리지 않는다). 직전 값은 그대로 둔다.
- rate limit 때문에 지금 읽지 못한 글은 30분 뒤에 다시 본다. 기간이 끝날 때까지 몫이 나지 않으면 그대로 끝난다 — 미룬 글이 목록에 영원히 남지 않고, 다음 읽기가 뒤로 밀려 다른 채널의 글을 막지 않는다.
- reddit 처럼 한 요청에 여러 글을 읽는 채널은, 30분 안에 차례가 올 같은 채널의 글도 같은 요청에 싣는다. 글마다 따로 요청하지 않고, 같은 채널 글들의 일정이 한 시각으로 모인다.
- 이 기능 전에 게시된 글도 기간 안이면 다음 sweep 에 일정에 들어간다. 다만 그 글 · 그 채널 · 그 캠페인 전체로 사람 · 에이전트가 손으로 남긴 `engagements` · `replies` 가 있으면 읽지 않는다 — 처음 읽은 값 전체가 첫 변화량이 되어 손으로 남긴 값과 두 번 세어진다. 그 이유가 `engagement_error` 에 남는다.

**rate limit.**
- 연결된 OutreachChannel 의 `rate_limit_per_hour` 가 있으면, 지난 한 시간에 남은 요청이 cap 의 절반보다 많을 때만 그 넘는 만큼 읽는다. **cap 의 절반은 게시 · 폴링 몫으로 남는다.** 요청마다 리미터를 다시 본다 — 커넥터의 재시도(401 · 429)도 같은 cap 에 기록되기 때문이다. 마지막 요청의 재시도만큼은 넘을 수 있다.
- 마케팅이 만든 연결의 기본 cap 은 시간당 6이다. 그러면 수집은 시간당 3요청까지 쓰고, 게시에는 적어도 3요청이 남는다. reddit 은 한 요청에 100개를 읽으므로 보통 채널마다 시간당 한 요청이면 된다. GitHub 은 글마다 한 요청이라, 젊은 글이 많으면 읽기가 늦어진다.
- 몫이 없으면 그 채널의 글은 30분 뒤로 미룬다(위 "일정"). 미룬 이유가 `engagement_error` 에 남고, 미루다 기간이 끝나면 그렇게 적힌다.
- sweep 한 번에 한 채널로는 30요청까지만 보낸다. 이것은 rate limit 이 아니어서, 넘은 글은 쓰지 않고 due 로 두어 다음 sweep(5분 뒤)이 바로 잇는다.
- 플랫폼 자체의 제한(reddit `x-ratelimit-*`, GitHub 429 · secondary limit)은 커넥터가 그대로 다룬다. 그래도 rate limit 에 걸리면 실패로 세지 않고 미룬다. 채널 cap 초과와, GitHub 이 시간당 한도를 다 썼을 때 주는 Retry-After 없는 403("API rate limit exceeded")도 rate limit 으로 본다.
- rate limit · 403 이 나면 그 채널에는 그 sweep 동안 더 묻지 않는다. 진짜 403(차단 · 권한)은 실패라 다음 간격에 다시 읽고, 아직 묻지 않은 글은 그 거절을 적어 미룬다.
- 공용 rate limiter 는 서버 프로세스마다 따로 센다(outreach 와 같은 한계).

**한 번만.**
- 수집기의 모든 쓰기는 그 sweep 이 읽은 `engagement_rev` 그대로일 때만 쓰고 rev 를 올린다(CAS).
- 읽기 전에 그렇게 글을 맡고, 다음 읽기를 15분 lease 로 민다. lease 는 sweep 이 시작한 시각이 아니라 글을 맡는 순간부터 센다.
- 게시물의 값과 변화량 행은 한 트랜잭션에서, 맡은 rev 그대로일 때만 쓴다.
- 그래서 한 서버가 글을 맡거나 값을 쓴 뒤에는, 그 전에 글을 읽어 둔 다른 서버가 낡은 직전 값으로 변화량을 셈해 넣지 못한다. 서버가 둘이어도, 한쪽이 오래 걸려도 같은 변화를 두 번 남기지 않는다.

**멈춤과 계속.**
- 보관된 캠페인의 글은 보관된 동안 읽지 않는다(`engagement_error` 에 이유). 보관은 되돌릴 수 있으므로(archived → paused) 끝내지 않고 읽는 간격대로 다시 본다. 되살리면 기간 안의 남은 일정대로 다시 읽는다.
- 일시정지된 캠페인 · 채널의 글은 계속 읽는다. 읽기만 하고 아무것도 보내지 않는다.
- OutreachChannel 의 차단 · rate limit 표시는 건드리지 않는다. 읽기가 된다고 게시가 되는 것은 아니라서, 읽기 성공이 게시 경로가 남긴 차단 표시를 지우면 안 된다.

**두 번 세지 않는다.**
- 서버가 읽는 채널 — 연결된(active · paused) reddit · GitHub outreach 채널 — 과 그 게시물의 `engagements` · `replies` 는 `record_marketing_metrics` 와 `POST /campaigns/:id/metrics` 가 거부한다. 클릭과 같은 규칙이다. 제안 · 연결 대기 · 거부된 채널은 서버가 게시한 글이 없어 막지 않는다.
- 그런 채널이 있는 캠페인에서는 채널을 정하지 않은 캠페인 전체 `engagements` · `replies` 도 거부한다. 그 채널들의 몫을 다시 담을 수 있어서다.
- 화면도 보내기 전에 막는다. 기간이 끝난 글의 참여도 손으로 남기지 못한다.

화면에서는 두 곳에 보인다.
- 게시물 카드의 "참여": 읽은 값 · 시각 · 다음 읽기 또는 끝 · 실패나 미룬 이유. 수집기가 맡은 글에만 보인다.
- 분석 탭 지표 표의 "자동 수집" 행: 부호 붙은 변화량.

## 피드백 → 제품

에이전트는 `record_marketing_feedback(category, content, source_url, summary?, sentiment?, author?, channel_id?)` 로 피드백을 남긴다.

- 출처 링크는 필수이고, 같은 출처는 한 번만 기록된다. bug/feature 는 요약이 필수다(티켓 제목이 된다).
- `feedback_to_product` 가 켜져 있으면 bug/feature_request 를 `TicketService.create` 로 제품 Project 에 넣는다.

| 티켓 필드 | 값 |
| --- | --- |
| `operational_dedupe_key` | `marketing:{campaign}:{feedback}` |
| tags | `marketing` · `campaign:<slug>` · `feedback:<분류>` |
| status | 캠페인 `feedback_ticket_status` (기본 `backlog` — 사람이 고를 때까지 아무도 일하지 않는다) |
| assignee | `improvement_assignee` (없으면 Project 기본) |
| 본문 | 외부 글을 **인용**으로 넣고, 데이터로만 다루라는 경고를 붙인다 |

- `todo` + assignee 로 설정하면 일반 dispatch 루프가 개선 작업을 바로 이어받는다.
- 일일 티켓 상한이나 열린 티켓 상한을 넘으면, 티켓 없이 `capped` 로 기록만 한다.
- 사람은 상한과 무관하게 `POST /feedback/:id/ticket` 으로 티켓을 만들 수 있다.

## 루프

`MarketingCycleService` 의 tick 이 동작을 정한다.

- 환경 변수: `MARKETING_SCHEDULER_TICK_MS`(기본 60초), `MARKETING_SCHEDULER_ENABLED`. 이 스위치는 지출 sweep · 메일 큐 · 승인 대기 알림 · 동의 재확인 안내 · 참여 지표 수집도 함께 끈다.
- 대상: `next_cycle_at` 이 지난 active 캠페인. 각 캠페인마다 다음 순서로 처리한다.

1. **커서를 먼저 전진한다**(`qa-cron`). 겹친 tick 은 아무것도 하지 않고, 놓친 회차는 한 번만 돈다.
2. **run budget 을 검사한다**(공용 기본값 `hard_budget_config` 의 `max_runs_per_window`, `marketing` 축). 방이나 사이클 행을 만들기 전이다.
3. **앞 사이클이 아직 `running` 이면 시작하지 않는다.** 6시간이 지났으면 `timed_out` 으로 닫는다.
4. **`MarketingCycle` 행과 방을 만든다.** 캠페인 에이전트(RuntimeSpec)를 앉히고 사이클 지시문을 보낸다.
5. **에이전트는 `complete_marketing_cycle(cycle_id, summary, next_actions)` 로 끝낸다.** 한 번만, 그 사이클을 받은 캠페인 에이전트(runtime key)만 부를 수 있다 — 다른 에이전트가 다음 사이클의 "다음 행동" 을 써 넣지 못하게.

지시문(`buildCyclePrompt`)에 실리는 것:

- 브리프 · 목표 · 대상
- 서버가 집행하는 규칙
- 켜진 기능의 단계
- 채널(상태 · 가이드 · 홍보 규칙 · 메일 인원)
- 예산(편성 · 사용 · 남음)
- 대기 중 승인 수
- **사람의 최근 결정과 그 사유**
- 30일 성과 요약
- 직전 사이클 요약과 다음 행동: 에이전트가 쓴 것이라 **메모 블록**(`UNVERIFIED_AGENT_NOTES`)에 참고 기록으로 넣는다.
- 직전 사이클 이후 들어온 **외부 글**: 비신뢰 블록 안에 넣는다. 링크는 지우고, `<` `>` 를 지워 구분자를 흉내 내지 못하게 하고, 15건까지 각 300자로 자르고, 블록 앞뒤에 경고를 붙인다.
- 신뢰 구역(블록 밖)에는 사람이 쓰거나 승인한 것만 둔다: 승인된 채널의 이름 · 가이드 · 홍보 규칙, 사람의 거부 사유. 제안 단계 채널은 id · 플랫폼 · 상태만 보이고, 감사 요약(에이전트가 쓴 제목이 섞인다)은 싣지 않는다.

나머지 규칙:

- 수동 "지금 실행"(`POST /campaigns/:id/cycles/run`)도 같은 경로를 탄다.
- 캠페인을 일시정지하거나 보관하면 실행 중 사이클은 `cancelled` 가 된다.

## 승인 대기 알림

사람의 결정을 기다리는 것을 그 사람의 Discord · Slack · Telegram(사용자 채널, `UserChannel`)으로 알린다. `MarketingApprovalNotifyService` 가 1분마다 돌고, 규칙은 `common/marketing/approval-notice.ts` 에 있다.

| 종류(본문 순서) | 권한 | 알리지 않는 사람 |
| --- | --- | --- |
| 결제 결과 불명(`unknown`) — 대조 필요 | `marketing.approve_spend` | — |
| 두 번째 승인 대기(2인 규칙의 첫 승인 뒤) | `marketing.approve_spend` | 이미 승인한 사람, 요청한 사람 |
| 새 지출 요청(`pending`) | `marketing.approve_spend` | 요청한 사람 |
| 예산 편성 제안 | `marketing.approve_spend` | 제안한 사람 |
| 채널 제안 | `marketing.manage` | 제안한 사람 |
| 게시물 초안 | `marketing.manage` | 만든 사람 |

- **기준은 승인함과 같다.** 무엇이 결정을 기다리는지는 원래 행의 지금 상태가 정한다. 알리기 전에 결정된 것은 알리지 않는다.
  - 승인함이 세는 것 가운데 사람이 방금 스스로 시작한 대기는 알리지 않는다: manual 결제의 결제 기록, manual 게시물의 링크 기록, credential 연결 대기.
  - 보관된 캠페인은 승인함에서 결과 불명 · 수동 결제 기록 대기만 센다. 사용자 채널 알림은 이 중 결과 불명 결제만 알린다 — 결제가 나가던 중에 보관될 수 있고, 돈이 나갔는지 모르는 채로 아무에게도 보이지 않으면 안 된다.
- **전이 코드는 알림을 모른다.** 요청 · 승인 · 결제 결과를 만드는 경로에서 보내지 않는다. 그래서 알림 실패가 돈 · 게시 흐름에 닿지 않고, 경로 하나를 빠뜨려 알림이 사라지는 일도 없다.
- **받는 사람:** 그 계정에 접근할 수 있는 사용자 가운데 그 결정의 권한이 있는 사람이다(`AccountAccessService.usersWithAccess`, `accessibleIds` 의 역방향).
  - 지금은 활성 소유자 한 명이다. 그래서 두 번째 승인 대기 알림은 받을 사람이 없다 — 첫 승인을 한 소유자는 빠진다.
  - 조직 멤버십이 들어오면 같은 조회가 넓어지면서 그대로 닿는다.
- **사용자 채널의 "Mentions of me"(`notify_mention`)를 따른다.** 오케스트레이션 confirm 게이트 알림과 같은 판단이다. 시스템이 당신의 결정을 요구하고, 결정이 없으면 일이 진행되지 않는다(지출 요청은 72시간 뒤 만료된다). 기본값이 켜져 있다.
- **묶어서 보낸다.** 계정 단위로 판단하고, 사람마다 한 통이다.
  - 지출 요청 · 편성 · 채널 · 게시물은 계정에 새 항목이 2분 동안 더 없을 때 보낸다. 그 캠페인의 에이전트 사이클이 아직 돌면 사이클이 끝날 때까지 기다린다.
  - 결과 불명 · 두 번째 승인은 다른 항목을 기다리지 않는다. 생긴 지 2분이면 보낸다(잇달아 생긴 것끼리만 묶는다). 에이전트가 초안을 쏟아내는 중이어도 마찬가지다.
  - 어떤 항목도 15분을 넘겨 기다리지 않는다.
  - 보낼 때는 그 계정의 미알림 항목을 모두 싣는다. 같은 사람이 여러 계정에 접근하면 한 통으로 합친다.
- **한 번만 보낸다.** (대상, 종류)마다 `marketing_approval_notices` 에 한 행을 **보내기 전에** 쓴다(유일 인덱스).
  - 재시작해도 다시 보내지 않는다. 서버가 둘이어도 한 계정의 묶음은 한 서버만 보낸다. 진 서버는 그 계정을 건너뛰고, 다음 sweep 이 남은 것만 본다.
  - 보내기가 실패하면 그 알림만 잃는다. 승인함과 사이드바 배지는 그대로 남는다.
  - 같은 지출 요청도 단계가 바뀌면(새 요청 → 두 번째 승인 → 결과 불명) 다시 알린다.
- **본문:** 캠페인별 종류 · 건수를 싣는다. 지출은 금액 · 수취인 · 만료까지 남은 시간, 채널 제안은 플랫폼을 싣는다. `AWB_PUBLIC_URL` 이 있으면 캠페인 화면 링크(여러 캠페인이면 `/marketing`)를 붙인다.
  - **에이전트가 쓴 글은 싣지 않는다**: 지출 목적, 게시물 제목, 채널 이름, 근거. 에이전트가 읽는 외부 글에 섞인 프롬프트 주입이 AWB 이름의 알림 문구(가짜 링크 · `@everyone`)가 되지 않게 하기 위해서다. 실리는 것은 사람이 정했거나 서버가 계산한 값뿐이다.
- `MARKETING_SCHEDULER_ENABLED=false` 이거나 인스턴스가 quiesce 중이면 보내지 않는다. quiesce 가 풀리면 다음 sweep 이 밀린 것을 보낸다.

## 권한

| 권한 | 할 수 있는 일 | 기본 |
| --- | --- | --- |
| `marketing.manage` | 캠페인 CRUD, 채널 · 콘텐츠 승인, 추적 링크 · 지표 · 피드백, 연락처 | admin 전용 |
| `marketing.approve_spend` | 돈 설정(한도 · 2인 임계값 · 수취인과 그 결제 경로 · 통화 · 결제 방식) 변경, 편성 승인, 지출 승인 · 거부 · 취소, 결제 기록 · 대조 · 환불, 결제 연결 확인 · 요청별 공급자 확인 | admin 전용 |

조회(캠페인 목록 · 상세 · 채널 · 사이클 · 감사 · 예산 · 지출 · 원장 · 승인함 수)는 둘 중 하나만 있어도 된다 — 돈 승인자도 무엇을 승인하는지 봐야 한다. 쓰기는 각 권한의 일만 한다.

## MCP 툴 (에이전트용)

전부 tier `caller` 다. 핸들러가 검사하는 것:

- DB-backed caller 인가
- 호출 키가 캠페인의 실행 키에 접근할 수 있는가(`callerCanAccessAccount`, 다른 MCP 툴과 같은 규칙). 아니면 없는 id 와 똑같이 "없음"으로 답한다.
- 캠페인 상태 · capability · 일일 상한(`MarketingAgentService`)

| 툴 | capability |
| --- | --- |
| `list_marketing_campaigns`, `get_marketing_campaign` | — |
| `complete_marketing_cycle` | — |
| `get_marketing_report` | — (읽기) |
| `propose_marketing_channel` | `channel_discovery` |
| `draft_marketing_post` | `community_post` · `email`(채널 종류에 따라) |
| `create_marketing_link`, `record_marketing_metrics` | `analytics` |
| `record_marketing_feedback`, `list_marketing_feedback` | `feedback_collect` (list 는 읽기) |
| `propose_marketing_budget_allocation`, `request_marketing_spend`, `get_marketing_spend_request` | `paid_spend` (get 은 읽기) |

메일 채널의 수신 목록이 멈췄으면("목록 발송 중지") 그 채널의 `draft_marketing_post` 는 거부되고, `get_marketing_campaign` 의 그 채널에 `list_on_hold: true` 가 실린다.

직접 결제 수취인(`payees[].provider`)에게는 `request_marketing_spend` 에 `payload` 를 넣지 않는다. `amount_minor` 는 상한 공급자에서는 상한 증가분, Stripe Issuing 에서는 카드 한도다(수취인의 카드당 최대 · 일회용 최대 안에서). 툴 설명 · 규칙(`agentRules`) · 사이클 지시문의 "직접 결제 수취인" 줄(수취인마다 하는 일)이 같은 것을 알린다. 그 줄은 허용 목록 줄과 따로 쓴다 — 허용 목록 줄에는 `payee` 에 그대로 넣을 이름만 둔다(이름 뒤에 설명을 붙이면 에이전트가 그대로 베껴 거부된다). 응답의 `plan_text` 가 사람이 승인할 문장이다.

## REST 요약 (`/api/marketing`)

| 묶음 | 엔드포인트 |
| --- | --- |
| 캠페인 | `GET/POST /campaigns`, `GET/PATCH/DELETE /campaigns/:id`, `POST /campaigns/:id/status`, `GET /campaigns/:id/audit`, `GET /campaigns/:id/cycles`, `POST /campaigns/:id/cycles/run` |
| 채널 | `GET/POST /campaigns/:id/channels`, `PATCH /channels/:id`, `POST /channels/:id/{approve,connect,reject,pause,resume}` |
| 게시물 | `GET /campaigns/:id/posts`, `GET /posts/:id`, `POST /posts/:id/{approve,reject,retry,mark-published}`, `GET /posts/:id/sends` |
| 예산 | `GET /campaigns/:id/{budget,allocations,spend-requests,ledger}`, `POST /campaigns/:id/allocations`, `POST /allocations/:id/{approve,reject}`, `GET /spend-requests/:id`, `POST /spend-requests/:id/{approve,deny,cancel,mark-paid,mark-failed,refund}`(카드 공급자의 `mark-failed` 는 경우에 따라 `confirm_no_spend`) |
| 직접 결제 확인(읽기 전용) | `POST /campaigns/:id/payment/check`(연결 확인), `POST /spend-requests/:id/inspect`(요청별 공급자 확인) |
| 분석 | `GET /campaigns/:id/report`, `GET/POST /campaigns/:id/links`, `GET/POST /campaigns/:id/metrics` |
| 피드백 | `GET/POST /campaigns/:id/feedback`, `POST /feedback/:id/ticket` |
| 연락처 | `GET /contacts`, `POST /contacts/import`, `POST /contacts/:id/{unsubscribe,erase}` |
| 목록 발송 중지 | `GET /list-holds`(`?list=&status=`), `POST /list-holds/:id/release` |
| 동의 재확인 안내 | `GET/PUT /consent-notices/settings`(설정 + 현황), `POST /consent-notices/preview`(저장하지 않음), `POST /consent-notices/retry-failed`, `GET /consent-notices`(`?status=&limit=`) |
| 승인함 | `GET /inbox` — 접근 가능한 캠페인의 결정 대기 수. `total` 은 이 사람이 처리할 수 있는 것만 센다(manage: 채널 제안 · 초안 · 기록 대기 게시물, approve_spend: 편성 제안 · 지출 대기 · 결과 불명 · 결제 기록 대기). 보관된 캠페인은 결과 불명 · 수동 결제 기록 대기만 센다. 사이드바 배지가 쓴다. 사용자 채널 알림은 사람이 스스로 시작한 기록 대기를 제외한다("승인 대기 알림"). |

공개 엔드포인트(인증 없음): `GET /api/m/:code`, `GET/POST /api/m/u/:token`(수신거부), `GET/POST /api/m/c/:token`(동의 유지), `POST /api/m/email/:credentialId/{events,inbound}`(공급자 서명이 인증).

## 후속 (이 문서 범위 밖)

- 직접 결제의 미사용분 반납: 상한 공급자는 서버가 상한을 낮추고(CAS) 그만큼 환불을 기록, 카드는 해지한 카드의 거래를 읽어 쓴 돈만큼만 남기고 환불, 플랫폼 지출 보고서로 대조
- 마케팅이 쓰는 credential 보호(사용 중 삭제 · 범위 좁히기 · 에이전트 노출 전환 막기)
- Google Ads 서비스 계정 인증(지금은 OAuth refresh token 만)
- 사람이 직접 올린 manual 채널 글(reddit · GitHub 주소)의 참여 읽기 — 지금은 서버가 게시한 글만 읽는다
- 목록 발송 중지를 승인함 배지 · 승인 대기 알림에 싣기
- 하드 바운스율이 높은 목록의 발송 중지(지금은 스팸 신고율만 본다)
- 메일 답장 분류 → 제품 티켓(지금은 `other` 로만 기록하고, 티켓은 사람이 카드에서 만든다)
- 동의 재확인 안내에 온 회신(수신거부 제목 밖)을 사람이 보게 하기 — 지금은 이을 캠페인이 없어 기록하지 않는다
- 정책 기반 자동 게시
- 승인 대기 리마인더(만료가 가까운 지출 요청, 오래 대조되지 않은 결제)
