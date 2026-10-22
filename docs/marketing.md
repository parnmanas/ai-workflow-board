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
| `MarketingCampaign` | `marketing_campaigns` | 제품(Project), 브리프 · 목표 · 대상, capabilities, 에이전트 RuntimeSpec, 주기, 통화, 한도, 결제 방식, 수취인 허용 목록, 링크 허용 도메인, 공개 문구, 일일 상한, 피드백 티켓 설정 |
| `MarketingChannel` | `marketing_channels` | 캠페인의 채널(연결 테이블 + 탐색 근거). kind 는 `outreach` · `email` · `manual` |
| `MarketingPost` | `marketing_posts` | 채널별 콘텐츠(게시글 · 답글 · 메일) |
| `MarketingEmailSend` | `marketing_email_sends` | 메일 한 통 = (post × contact). 발송 큐이자 기록. 보낸 credential, 공급자가 알려 온 바운스 · 스팸 신고 |
| `MarketingContact` | `marketing_contacts` | 메일 수신자(설치 전체의 한 목록), 동의 증거, 재확인 안내로 이어진 동의 기간, 수신거부 · 바운스 · 스팸 신고, 억제 해시 |
| `MarketingBudgetAllocation` | `marketing_budget_allocations` | 채널별 예산 편성(버전) |
| `MarketingSpendRequest` | `marketing_spend_requests` | 지출 요청과 그 상태 기계 |
| `MarketingLedgerEntry` | `marketing_ledger_entries` | append-only 원장 |
| `MarketingLink` | `marketing_links` | 추적 링크 |
| `MarketingMetric` | `marketing_metrics` | 지표 관측치(링크 클릭은 시간 버킷 합산) |
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
- **이벤트는 그 credential 로 보낸 발송 행에만 닿는다**(행의 `credential_id`, 그 칸이 생기기 전 행은 채널의 지금 credential). 발송 행은 실어 보낸 발송 행 id → 공급자 message id(Resend `email_id`, SendGrid `sg_message_id` 의 첫 `.` 앞 = 발송 응답의 `X-Message-Id`) → 수신 주소로 그 credential 을 거쳐 보낸 최근 발송 순으로 찾는다. 못 찾으면 무시한다.

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

정보통신망법 §50⑧ · 시행령 §62의3 은 광고성 정보 수신 동의를 받은 자가 **동의일부터 2년마다, 2년이 되는 날 전까지** 받는 사람에게 세 가지를 알리게 한다: 전송자 명칭, 수신 동의 사실과 동의한 날짜, 유지 · 철회 의사를 표시하는 방법. `MarketingConsentNoticeService` 가 이 안내를 보낸다(규칙은 `common/marketing/consent-notice.ts`).

- **동의 기간.** 기준점은 `consent_at` 과 `consent_renewed_at` 중 늦은 쪽이고, 기한은 거기서 730일이다(`consentDeadline`). 발송 대상 판정(`consentFresh`)도 이 기간을 쓴다.
- **설정은 계정마다 운영자가 정한다**(`marketing.manage`, 연락처 화면의 "동의 재확인 안내").

  | 항목 | 값 |
  | --- | --- |
  | 켜기 | 기본은 꺼짐이다. 켜려면 `AWB_PUBLIC_URL` 이 있어야 한다(유지 · 철회 링크) |
  | 발송 시점 | 기한 7–90일 전(기본 30일) |
  | 무응답 처리 | `keep`(기본) · `lapse` |
  | 제목 · 본문 | 자리표시자 `{{name}}` · `{{sender}}` · `{{consent_date}}` · `{{due_date}}`. 모르는 `{{…}}` 는 저장할 때 거부한다 |

  문구나 무응답 처리가 바뀌면 `version` 이 오른다. 보낸 안내와 유지 기록에 그 버전이 남는다. 설정 변경은 감사 `consent_notice.settings` 로 남는다.
- **무응답 처리.** 무응답의 의미는 안내가 무엇을 제시했느냐로 정해진다(KISA 해석). 서버가 붙이는 문단이 받는 사람에게 그대로 말한다.
  - `keep`: 철회 방법을 안내했으니 무응답은 유지다. 안내가 나가면 그 주기의 **기한**이 `consent_renewed_at` 이 되고, 동의는 거기서 다시 2년이다. 기산일은 원래 동의일이라 안내를 보낸 날부터 세지 않는다.
  - `lapse`: 유지 방법을 안내했으니 무응답은 철회다. 기한까지 유지 링크를 누르지 않으면 기한에 발송 대상에서 빠진다. 연락처 상태는 바꾸지 않는다 — 새 동의를 가져오면 다시 받는다.
- **줄 세우기 · 보내기**
  - 10분마다 줄을 세운다. 켠 계정의 `subscribed` 연락처 가운데 안내 창(기한 N일 전 ~ 기한)에 든 사람마다 (연락처, 기한) 한 행을 넣는다. 유일 인덱스라 서버가 둘이어도 한 번이다.
  - 1분마다 50통씩 보낸다. 보내기 직전에 다시 본다. 수신거부 · 바운스 · 신고 · 삭제됐거나, 새 동의로 기한이 바뀌었거나, 기한이 지났으면 보내지 않는다(`skipped`). 꺼졌으면 미룬다.
  - 발신자는 그 사람이 마지막으로 마케팅 메일을 받은 채널이고, 없으면 그 사람의 목록을 쓰는 채널이다(승인된 메일 채널, 보관되지 않은 캠페인). "전송자 명칭" 이 그 사람이 동의한 발신자여야 해서다. 채널이 없으면 1시간마다 다시 본다(현황의 "보낼 메일 채널 없음").
  - 수신자 현지 야간(21–08시)이면 아침으로 미룬다. 광고가 아니라서 야간 제한 대상은 아니지만 배려다. 미루면 기한을 넘기게 될 때는 바로 보낸다.
  - 공급자 결과는 메일 큐와 같다. Resend 는 안내 행 id 를 `Idempotency-Key` 로 3번까지 다시 보내고, SendGrid 는 429 만 다시 보낸다. 보내던 중 끊긴 행은 `failed` 로 닫는다.
- **안내 메일.** 운영자의 제목 · 본문 뒤에 서버가 고정 문단을 붙인다.
  - 보낸 곳, 동의한 날짜(받는 사람의 시간대), 유지 방법(무응답이면 어떻게 되는지까지), 철회(수신거부) 방법
  - "법정 안내이며 광고가 아님", 발신자 이름 · 우편 주소 · 연락처
  - 제목에 광고 표기를 붙이지 않는다. 확인 안내는 광고와 따로 보내야 하므로(KISA) 광고 문구를 섞지 않는다. `List-Unsubscribe` One-Click 헤더는 붙는다.
- **이미 지난 동의는 잇지 않는다.** 동의를 다시 묻는 메일은 그 자체가 광고성 정보다. 그래서 기한이 지난 연락처에게는 보내지 않는다. 현황의 "기한이 이미 지난 연락처" 는 새로 동의를 받아 가져와야 다시 보낸다.
- **유지 링크** `GET/POST /api/m/c/:token`. 토큰은 안내마다 256-bit 이고, REST 응답에 나가지 않는다.
  - GET 은 확인 화면만 보여 준다. 메일 보안 스캐너가 열어도 처리되지 않게 아무것도 바꾸지 않는다.
  - POST 는 새 동의로 기록한다: `consent_at` = 지금, method `reconfirm`, source `consent-notice:<안내 id>`, 문구 버전 `consent-notice-v<n>`. 이어진 기간(`consent_renewed_at`)은 지운다 — 2년을 그때부터 다시 센다. IP 원문은 남기지 않고, 이전 증거는 감사 `contact.consent_kept` 에 남는다.
  - 같은 안내로 두 번 눌러도 한 번이다. 보낸 안내의 링크만, 기한 뒤 30일까지 받는다. 수신거부 · 바운스 · 신고 · 삭제된 연락처는 되살리지 않는다.
  - 수신거부와 같은 제한(IP 당 분당 30회)을 쓴다. 철회는 연락처의 수신거부 링크(`/api/m/u/:token`) 그대로다.
- **기록.** 보낸 안내 행이 법정 통지의 기록이다: 기한, 보낸 시각, 발신 채널 · credential, 공급자 message id, 안내한 무응답 처리와 문구 버전, 유지 클릭 시각. 연락처 목록은 연락처마다 동의 기한(`consent_due_at`)과 최근 안내를 싣는다.
- 안내의 바운스 · 스팸 신고는 아직 안내 행에 잇지 않는다. 공급자 이벤트는 그 주소로 그 credential 을 거쳐 보낸 최근 마케팅 메일에서 찾는다(후속).

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
- **돈 설정의 권한:** 한도 · 임계값 · 수취인 · 통화 · 결제 방식을 바꾸는 것은 `marketing.approve_spend` 의 일이다. 임계값을 0 으로 내리면 혼자 승인할 수 있고 수취인을 넣으면 돈이 갈 곳이 생기므로, 캠페인 운영 권한(manage)만으로는 바꾸지 못한다.
- **결제 방식**(`payment_provider`, `payment_credential_id`)
  - 캠페인 설정이고, 에이전트가 고르지 않는다.
  - 바꾸려면 `approve_spend` 가 있어야 한다.
  - webhook credential 에는 `webhook_url` 과 `secret`(16자 이상) 필드가 있어야 한다. webhook_url 은 https 여야 한다(loopback 만 http 허용).

### 원장 계산 (`common/marketing/budget.ts`)

- 쓰기 전에 요청별로 `release ≤ reserve`, `capture ≤ reserve`, `refund ≤ capture` 를 강제한다.
- `held = Σreserve − Σrelease`, `spent = Σcapture − Σrefund`.
- 원장 행은 그 요청이 **승인된 기간**(`period_key`)에 묶인다. 다음 달에 결제 · 환불돼도 승인한 달의 사용량이다.
- 총 가용 · 기간 가용 · 채널 가용(편성 − 그 채널의 기간 held + spent)을 같은 함수(`spendViolations`)로, 요청 시점과 승인 시점에 두 번 검사한다.

### 상태 기계

```
pending ──approve──▶ approved ──(webhook)──▶ executing ──▶ paid
   │  (2인 규칙: 첫 승인은 pending 유지)          │       ├──▶ failed  (release)
   ├─deny──▶ denied                               │       └──▶ unknown (사람이 대조: paid | failed)
   ├─expire(72h)──▶ expired                        │
   └─cancel(사람 · 캠페인 정지)──▶ cancelled          └ manual: 사람이 "결제 완료"(거래 id 필수) 또는 "실패"를 기록
```

1. **요청.** 에이전트가 `request_marketing_spend` 를 부른다.
   - 인자: `campaign_id`, `channel_id`, `amount_minor`, `currency`, `payee`, `purpose`, `expected_outcome`, `payload?`, `dedupe_key?`
   - 한도 · 통화 · 허용 수취인 · 편성을 미리 검사한다. 넘으면 **저장하지 않고** 거부하고, 사유는 감사 로그(`spend.refused`)에 남긴다.
   - 금액 · 수취인 · 목적 · 공급자 · payload 의 정규화 JSON 해시를 `payload_sha256` 으로 저장한다. 요청 행은 pending 을 떠나면 바뀌지 않는다.
2. **승인.** 한 트랜잭션에서 다음 순서로 처리한다.
   1. 캠페인 행의 `spend_version` 을 올린다. Postgres 에서는 행 잠금, sql.js 에서는 직렬화 큐가 된다.
   2. 요청을 다시 읽는다: pending 인지, 만료 전인지 본다.
   3. **승인자가 화면에서 본 `payload_sha256`** 이 일치하는지, 저장된 해시와 다시 계산한 해시가 일치하는지 본다.
   4. 원장 합을 다시 계산하고 한도를 재검사한다.
   5. 상태를 CAS 로 바꾸고, `reserve` 행과 감사 행을 쓴다.

   승인자 identity 는 로그인 세션에서만 온다. 2인 규칙 대상이면 첫 승인은 `approvals` 에 기록만 하고, 같은 사람은 두 번 승인할 수 없다.
3. **실행(webhook).** 다음 순서로 진행한다.
   1. 캠페인 잠금 트랜잭션 안에서 **지금도 보내도 되는지** 다시 본다: 캠페인 active, 수취인이 아직 허용 목록에 있음, 채널 active, 저장된 해시 일치. 하나라도 어긋나면 보내지 않고 `failed`(예산 해제)로 닫는다. 통과하면 같은 트랜잭션에서 `approved → executing` 을 CAS 로 커밋한다.
   2. sql.js 는 이때 파일로 즉시 내려 쓴다(`flushSqljs` — 진행 중인 트랜잭션이 끝난 뒤에 쓴다). 내려 쓰지 못하면 보내지 않는다.
   3. 정규화 JSON 본문을 POST 한다. 헤더는 다음과 같다.
      - `X-AWB-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`
      - `Idempotency-Key: <spend request id>` (재시도해도 바뀌지 않는다)
   4. 응답으로 결과를 나눈다.

   | 응답 | 결과 | 예산 |
   | --- | --- | --- |
   | 2xx + `transaction_id` | `paid` | `release` + `capture` |
   | 명확한 거절(400 · 401 · 402 · 403 · 404 · 422) | `failed` | `release` |
   | 그 밖(타임아웃 · 5xx · 리다이렉트 · 408 · 409 · 425 · 429 · `transaction_id` 없는 2xx) | `unknown` | 그대로 보류 |

   409 는 멱등 키 중복(= 이미 처리됐을 수 있음)인 경우가 많아 거절로 보지 않는다. 사람이 이미 대조한 뒤에 도착한 결과는 버리지 않고 `spend.late_result` 로 감사에 남긴다.

   - **자동 재전송은 없다.**
   - 재시작하거나 10분 넘게 걸린 `executing` 은 `unknown` 이 된다.
   - 승인 직후 프로세스가 죽어서 `approved` 로 남은 webhook 요청은 sweep 이 실행한다. 아직 아무것도 보내지 않은 상태라 안전하다.

   본문 필드: `type`, `spend_request_id`, `campaign{id,name,slug}`, `channel{id,platform,target}`, `amount_minor`, `currency`, `payee`, `payee_ref`, `purpose`, `payload`, `payload_sha256`, `approved_by[{name,at}]`, `issued_at`
4. **환불.** `approve_spend` 를 가진 사람이 사유를 적어 기록한다.
   - 결제된 금액 안에서만 기록할 수 있다.
   - 환불은 capture 에 묶이고, 요청을 다시 열지 않는다(`paid` 로 남는다).
5. **취소.** `pending` 은 그대로, 승인됐지만 아직 보내지 않은 `approved` 는 보류한 예산을 풀며 `cancelled` 로 닫는다. `executing` 이후는 이미 나갔을 수 있으니 취소가 아니라 대조의 일이다.
6. **정리.** 캠페인을 일시정지하거나 보관하면 `pending` 요청은 `cancelled` 가 된다. 원장이 생긴 뒤에는 통화를 바꿀 수 없고, 캠페인을 삭제할 수도 없다(보관만 된다).

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
  - 누적형(합): impressions · views · engagements · replies · signups · conversions · revenue_minor
  - 수준형(마지막 값): followers · subscribers
- **리포트** (`get_marketing_report`, `common/marketing/report.ts`)
  - 채널별: 게시 수 · 클릭 · 지표 · 지출(원장 capture − refund) · CPC · 가입/전환당 비용 · CTR · 전환율 · ROAS · 편성액 · 피드백 · 수집 글 · 티켓 수
  - 요약 줄과 경고 문구가 함께 나온다.

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

- 환경 변수: `MARKETING_SCHEDULER_TICK_MS`(기본 60초), `MARKETING_SCHEDULER_ENABLED`. 이 스위치는 지출 sweep · 메일 큐 · 승인 대기 알림 · 동의 재확인 안내도 함께 끈다.
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
  - 보관된 캠페인은 세지 않는다. 결과 불명 결제만은 예외다 — 결제가 나가던 중에 보관될 수 있고, 돈이 나갔는지 모르는 채로 아무에게도 보이지 않으면 안 된다.
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
| `marketing.approve_spend` | 돈 설정(한도 · 2인 임계값 · 수취인 · 통화 · 결제 방식) 변경, 편성 승인, 지출 승인 · 거부 · 취소, 결제 기록 · 대조 · 환불 | admin 전용 |

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

## REST 요약 (`/api/marketing`)

| 묶음 | 엔드포인트 |
| --- | --- |
| 캠페인 | `GET/POST /campaigns`, `GET/PATCH/DELETE /campaigns/:id`, `POST /campaigns/:id/status`, `GET /campaigns/:id/audit`, `GET /campaigns/:id/cycles`, `POST /campaigns/:id/cycles/run` |
| 채널 | `GET/POST /campaigns/:id/channels`, `PATCH /channels/:id`, `POST /channels/:id/{approve,connect,reject,pause,resume}` |
| 게시물 | `GET /campaigns/:id/posts`, `GET /posts/:id`, `POST /posts/:id/{approve,reject,retry,mark-published}`, `GET /posts/:id/sends` |
| 예산 | `GET /campaigns/:id/{budget,allocations,spend-requests,ledger}`, `POST /campaigns/:id/allocations`, `POST /allocations/:id/{approve,reject}`, `GET /spend-requests/:id`, `POST /spend-requests/:id/{approve,deny,cancel,mark-paid,mark-failed,refund}` |
| 분석 | `GET /campaigns/:id/report`, `GET/POST /campaigns/:id/links`, `GET/POST /campaigns/:id/metrics` |
| 피드백 | `GET/POST /campaigns/:id/feedback`, `POST /feedback/:id/ticket` |
| 연락처 | `GET /contacts`, `POST /contacts/import`, `POST /contacts/:id/{unsubscribe,erase}` |
| 목록 발송 중지 | `GET /list-holds`(`?list=&status=`), `POST /list-holds/:id/release` |
| 동의 재확인 안내 | `GET/PUT /consent-notices/settings`(설정 + 현황), `POST /consent-notices/preview`(저장하지 않음), `GET /consent-notices`(`?status=&limit=`) |
| 승인함 | `GET /inbox` — 접근 가능한 캠페인의 결정 대기 수. `total` 은 이 사람이 처리할 수 있는 것만 센다(manage: 채널 제안 · 초안 · 기록 대기 게시물, approve_spend: 편성 제안 · 지출 대기 · 결과 불명 · 결제 기록 대기). 사이드바 배지가 쓴다. 같은 기준으로 사용자 채널에도 알린다("승인 대기 알림"). |

공개 엔드포인트(인증 없음): `GET /api/m/:code`, `GET/POST /api/m/u/:token`(수신거부), `GET/POST /api/m/c/:token`(동의 유지), `POST /api/m/email/:credentialId/{events,inbound}`(공급자 서명이 인증).

## 후속 (이 문서 범위 밖)

- 결제 공급자 직접 어댑터(Stripe Issuing · Google Ads · Meta Ads)
- 플랫폼 참여 지표 자동 수집(reddit score · 댓글 수)
- 목록 발송 중지를 승인함 배지 · 승인 대기 알림에 싣기
- 하드 바운스율이 높은 목록의 발송 중지(지금은 스팸 신고율만 본다)
- 메일 답장 분류 → 제품 티켓(지금은 `other` 로만 기록하고, 티켓은 사람이 카드에서 만든다)
- 동의 재확인 안내의 바운스 · 스팸 신고를 안내 행에 잇기(지금은 그 주소의 최근 마케팅 메일로 찾는다)
- 실패한 동의 재확인 안내를 사람이 다시 보내기(지금은 공급자 거절이면 `failed` 로 끝난다)
- 정책 기반 자동 게시
- 승인함도 보관된 캠페인의 결과 불명 · 결제 기록 대기를 세기(승인 대기 알림은 결과 불명을 이미 알린다)
- 승인 대기 리마인더(만료가 가까운 지출 요청, 오래 대조되지 않은 결제)
