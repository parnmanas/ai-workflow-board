# 미국 상표 출원과 변호사 커뮤니케이션

조사·구현 기준일: 2026-10-24. 가격 확인일은 서비스 카탈로그에 별도로 표시한다. 기존 미국 법인 설립 흐름에 이어 **Business → 운영 워크플로 → 상표 · 브랜드 보호**에서 사용한다.
회사 등록과 상표권은 별개이며, 한 회사에 여러 문자·로고 상표 기록을 둘 수 있다.

## 온라인으로 진행할 수 있는 범위

자료 준비 → 선행 조사 → 변호사 확인·견적 → 수임계약 → 출원서 검토·본인 서명 → 접수 → 심사·보정 → 등록·유지로 이어진다.
검색 결과만으로 등록 가능성을 확정하지 않으며 상품·서비스, 소유자, 사용 근거와 법률 판단은 담당 변호사와 확인한다.

| 구간 | 온라인/API 경로 | AWB 현재 기능 | 남는 확인 |
| --- | --- | --- | --- |
| 상표·권리자·상품·사용 자료 | 구조화된 입력, 공식 검색·ID Manual | 상표별 기록, 영문 자료 정리, 링크 | 실제 소유자·본점·사용 사실 |
| 선행 조사·수임 문의 | 변호사·대행 서비스 온라인 신청, 이메일 | 서비스·가격 비교, 영문 초안, Resend·Gmail·Microsoft 365 발송 | 면허·이해충돌·견적·법률 검토 |
| 수임계약 | DocuSign eSignature API의 템플릿·서명 요청·이벤트 | 템플릿·PDF·수신자 검토, 서명 요청, 진행·완료 수집, 서명본 다운로드 | 계약 조건 합의·본인 서명 |
| 신규 출원 | USPTO Trademark Center 또는 수임한 대리인 | 검토 자료 전달, 출원번호 기록, 공식 화면 연결 | 최종 문안·서명·수수료·공식 접수 |
| 심사·보정 | TSDR 조회 API, 변호사 메일·로펌 포털 | TSDR 상태·문서와 메일 회신 자동 수집, Clio 사건·문서·일정 조회 | 법률 검토·공식 기한 확인·보정 제출 |
| 등록·유지 | 공식 등록증·유지 서류, 대리인 기한 관리 | 등록번호와 후속 업무 관리 | 사건별 실제 기한과 계속 사용 증빙 |

신규 출원은 Trademark Center에서 진행한다. 일반 이메일로 출원서나 Office Action 답변을 접수할 수 없다.
공개 출원 제출 API는 조사한 공식 문서에서 확인하지 못했다. TSDR은 사건 상태·문서·이미지 조회 API이며
출원번호에 기반한 자동 수집을 구현했다. [온라인 접수 규칙](https://www.uspto.gov/trademarks/laws/mandatory-electronic-filing),
[TSDR API 안내](https://www.uspto.gov/trademarks/apply/check-status-view-documents/trademark-bulk-data).

미국 LLC도 실제 본점이 미국 또는 미국 영토 밖이면 미국 면허 변호사의 대리가 필요하다. 등록 대리인 주소만으로
미국 본점으로 간주하지 않는다. 개인은 실제 주거지, 법인은 경영진이 사업을 지휘하는 본점을 기준으로 확인한다.
[USPTO 해외 본점 규칙](https://www.uspto.gov/trademarks/laws/trademark-rule-requires-foreign-applicants-and-registrants-have-us).

권한 있는 서명자는 직접 서명하거나 직접 서명 소프트웨어를 지시해야 한다. 시스템이나 제3자가 그 사람의 이름을
대신 입력하는 자동서명을 구현하지 않는다. 수임계약의 전자서명과 USPTO 제출 서명은 별도 절차다.
[서명 요건](https://www.uspto.gov/trademarks/laws/verified-statement).

## 서비스와 비용 비교

가격은 USD 참고값이며 실제 수임 견적·관납료는 선택한 상품류, 출원 근거와 계약 범위에 따라 달라진다.
공급자별 플랜·출처·확인일은 서버 `connectors/service-offerings.ts`가 단일 원천이다.

| 서비스 | 공식 표시 가격 | API와 진행 방식 |
| --- | --- | --- |
| USPTO | Section 1/44 기본 $350/류 | 온라인 접수. TSDR 조회 API는 키 필요. 공개 제출 API 미확인 |
| LegalZoom Trademark | $899 + 관납료 | 변호사 검색·검토·대행. 공개 상표 제출 API 미확인 |
| Trademarkia | Entry $499 / Standard $599 / Premium $699 + 관납료 | 변호사 지원. 데이터 API 제휴 안내가 있으며 제출 API와는 구분 |
| Trademark Engine | Basic $49 / Standard $299 + 적용 수수료 | 온라인 신청. 관납료 외 $100 서비스·플랫폼 비용 표기. 공개 제출 API 미확인 |

USPTO 추가료는 정보 누락 $100/류, ID Manual 대신 자유기재 $200/류 등이 있고, 사용 의사 출원의 후속 사용증명과
연장 비용도 별도다. [공식 수수료](https://www.uspto.gov/trademarks/trademark-fee-information).
LegalZoom은 경미한 절차적 보정과 모니터링 갱신 조건을, Trademarkia는 플랜별 검색·모니터링과 추가 법률 업무 범위를,
Trademark Engine은 시작가 이외의 적용 비용을 계약에서 확인한다.
[LegalZoom](https://www.legalzoom.com/business/intellectual-property/trademark-registration-overview.html),
[Trademarkia 가격](https://www.trademarkia.com/),
[Trademarkia 데이터 API 제휴](https://www.trademarkia.com/faqs/about-trademarkia/how-do-i-contact-trademarkia-for-business-development-opportunities),
[Trademark Engine](https://www.trademarkengine.com/trademark-registration/).

## 커뮤니케이션 자동화 구성

현재 연결은 **상표 정보 → 목적별 영문 초안 → 편집 → 발신/수신/회신 주소와 원문 검토 → 명시적 발송 → 전달 조회**다.
견적·이해충돌 확인, 수임계약 요청, 출원 자료 검토, 진행·기한 확인, Office Action 대응 견적의 다섯 초안을 제공한다.
초안은 계약 수락·비용 결제·출원 지시를 자동으로 선언하지 않는다. 실제 문서는 로펌의 보안 업로드 경로로 전달한다.
AWB 메일은 현재 일반 텍스트이며 첨부파일 자동 전송은 제공하지 않는다.

### Resend: 현재 발송·전달 조회 구현

1. Resend에서 발신 도메인을 인증한다.
2. 회사 소유 Account에 `resend` provider, `api_key`, `agent_env=false` credential을 등록한다. 화면에서 새 키 등록도 가능하다.
3. 상표 기록에 변호사 이메일을 지정하고 메일 작성에서 검증한 발신 주소와 회신 받을 주소를 입력한다.
4. 저장된 원문을 확인하고 실제 발송을 승인한다. 키가 없으면 초안 복사·메일 앱 열기로 이어갈 수 있다.
5. 접수된 메일은 전달 상태를 조회한다. 전달됨은 변호사 회신이나 수임·계약·출원 완료를 뜻하지 않는다.

`POST /emails`에 고정 `Idempotency-Key`를 사용하고 `GET /emails/{id}`로 상태를 확인한다.
공급자 중복 방지 보존은 24시간이므로 AWB는 **최초 시도 23시간 이후 재발송을 차단**한다.
응답이 유실되면 원문을 보존하고 자동 재시도하지 않는다. 제한 시간 내 동일 요청을 다시 확인하거나,
Resend 대시보드의 발송 ID를 입력해 발신·수신·회신·제목·본문을 공급자 기록과 대조한다.
[발송 API](https://resend.com/docs/api-reference/emails/send-email),
[중복 방지 보존 기간](https://resend.com/docs/dashboard/emails/idempotency-keys),
[전달 조회](https://resend.com/docs/api-reference/emails/retrieve-email), [요금](https://resend.com/pricing).

### 공통 연결과 운영 설정

상표 기록의 **회신 · 계약 · 사건 자동화**에서 서비스별 연결을 관리한다. 서버 레지스트리가 카드·설정 필드·기능을 제공하며
공급자를 추가할 때 별도 화면을 복제하지 않는다. 각 상표에 서비스별 연결 하나를 둘 수 있다.

1. OAuth 서비스는 서버 환경변수 `AWB_PUBLIC_URL=https://사이트주소`를 설정한다. 경로 없는 HTTPS origin이며,
   로컬 개발만 `http://localhost:포트`를 허용한다. Docker Compose는 `.env`의 값을 컨테이너로 전달한다.
2. 공급자 앱에 `https://사이트주소/api/business-integrations/oauth/callback`을 Web redirect URI로 등록한다.
   개발 중 프런트엔드 주소와 서버 주소를 혼용하지 말고 브라우저가 이용하는 사이트 origin을 사용한다.
3. 연결 설정에서 같은 Account의 서버 전용 키를 선택하거나 등록한다. OAuth는 client ID·secret,
   API 키 연동은 API key를 사용한다. 비밀값은 브라우저에 다시 표시하지 않는다.
4. 저장 후 **서비스 로그인 연결**로 소유 계정을 승인한다. 토큰은 암호화 저장하며 만료 전에 자동 갱신한다.
   공급자 계정이 바뀌는 재로그인은 거부한다. 다른 계정으로 옮기려면 미처리 발송을 정리하고 연결을 해제한 뒤 다시 설정한다.
5. 자동 수집 간격은 5분·15분·1시간 중 선택한다. 기본값은 15분이다. 서버가 실행 중이면 브라우저를 닫아도 계속되며,
   서버가 다시 켜지면 수집 예정인 연결부터 처리한다. **지금 수집**으로 즉시 확인할 수도 있다.
6. 연결 카드의 **연결 방법 · 웹훅 설정**에서 callback·webhook URL과 서비스별 절차를 확인한다.
   연결 해제는 토큰과 수집 설정을 제거하고 기존 기록·발송 이력은 보존한다. 공급자의 OAuth 승인은 해당 서비스에서도 취소할 수 있다.

| 커넥터 | 서버 credential provider | 권한·연결 조건 | 구현된 수집 방식 |
| --- | --- | --- | --- |
| Resend 수신 | `resend_inbound` | `api_key`, 선택 `webhook_secret`; 수신 도메인의 MX/DNS 설정 | Receiving API 주기 조회 + 서명 검증 웹훅 |
| Gmail | `google_oauth` | Web OAuth client, Gmail API, `gmail.readonly`·`gmail.send`, offline 동의 | 지정한 스레드 + AWB 발송 스레드 주기 조회 |
| Microsoft 365 | `microsoft_oauth` | Entra Web OAuth client, 위임 `User.Read`·`Mail.ReadWrite`·`Mail.Send`·`offline_access` | 지정한 대화 + AWB 발송 대화 주기 조회 |
| DocuSign | `docusign_oauth` | OAuth `signature extended`, 템플릿, 운영 API 승인; 선택 `hmac_secret` | AWB 서명 요청 주기 조회 + Connect HMAC 웹훅 |
| Clio Manage | `clio_oauth` | 로펌 계정의 OAuth 앱 승인, 리전·사건 ID | 사건·문서 목록·일정·커뮤니케이션 주기 조회 |
| USPTO TSDR | `uspto_tsdr` | TSDR API key, 상표 기록의 8자리 출원번호 | 공식 상태·변경 시각·문서 목록 주기 조회 |

Google 앱 검증, Microsoft 조직 관리자 동의, DocuSign 운영 전환과 API 요금제, Clio 앱 배포 승인은 공급자 정책에 따른다.
키·OAuth 승인 없이 계정이 연결된 것으로 표시하지 않는다. 연결 설정 저장은 외부 메일·계약 발송을 실행하지 않는다.

### 회신 자동 수집

- **Resend Receiving**: 수신 전용 서브도메인을 설정하고 키를 연결하면 `tm-연결UUID@수신도메인` 주소를 만든다.
  기존 회사 메일을 유지하려면 전용 서브도메인을 사용한다. 이 주소가 Resend 메일과 다른 메일 커넥터의 Reply-To 기본값이 된다.
  `email.received` 웹훅에는 대시보드의 서명 secret을 등록한다. 원문 서명을 먼저 검증하고 해당 수신 주소를 대조한 뒤 Receiving API로 본문을 읽는다.
  웹훅 없이도 주기 조회가 가능하다. 회당 최대 4페이지·해당 사건 메일 10건을 처리하고 커서로 이어 읽는다.
  [수신 설정](https://resend.com/docs/dashboard/receiving/introduction), [Receiving API](https://resend.com/docs/api-reference/emails/retrieve-received-email).
- **Gmail**: 기존 스레드 ID를 지정하거나 AWB에서 메일을 발송하면 해당 대화가 자동 수집 대상이 된다.
  지정·발송 대화를 합쳐 최근 20개, 각 스레드의 최근 100개 메시지를 읽는다. 새 발송은 고유 Message-ID로 기록하며,
  응답이 끊기면 보낸편지함의 해당 Message-ID·주소·제목·본문을 대조한다. 자동 재발송하지 않는다.
  [OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [발송 API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send).
- **Microsoft 365**: 최근 20개 지정·발송 대화, 대화당 최대 100개 메시지를 수집한다.
  발송 전 원격 초안의 Immutable ID를 먼저 DB에 기록한 뒤 `/send`를 호출한다. 응답이 끊기면 해당 메시지의
  초안 여부·요청 헤더·모든 주소·본문을 대조한다. 아직 초안이면 메일함에서 검토·처리한 뒤 대조한다.
  [초안 생성](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0),
  [초안 발송](https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0).

Gmail Pub/Sub와 Graph 변경 알림 구독은 사용하지 않으며 주기 조회로 회신을 수집한다. 자동 수집 범위 밖의 대화는
메일함에서 확인한다. 메일 첨부파일의 자동 다운로드·전송은 제공하지 않는다. 수신 본문은 일반 텍스트로 표시하며
메일 내용으로 계약 수락·법률 기한 확정·자동 답변·출원·결제를 실행하지 않는다.

### DocuSign 계약과 Clio 로펌 업무

- **DocuSign**: sandbox/live, 계정 ID(선택), 합의한 수임계약 템플릿 UUID를 설정한다.
  이메일로 서명하는 역할 기반 템플릿을 지원하며 모든 서명자·참조인(최대 10명)을 입력한다.
  템플릿의 문서 1~5개, PDF 합계 8MB까지 원문 검토용으로 암호화 저장한다. 검토 화면에서 문서를 내려받아 확인하고
  실제 발송을 승인한다. 발송 직전에 템플릿·문서·수신자 설정의 변경 여부를 다시 검사한다.
  `transactionId`는 AWB 요청 ID로 고정하며 접수 결과 유실 시 조회로만 대조한다. 공급자의 transaction 조회 기간(7일)을
  지난 경우 envelope ID를 입력한다. 새 envelope를 자동 생성하지 않는다.
  Connect는 JSON SIM 형식, HMAC 서명을 활성화한다. 이벤트의 Account·envelope를 대조하고 현재 상태를 API로 읽으므로
  오래된 이벤트 재전송으로 상태가 되돌아가지 않는다. 완료 후 서명본과 인증서를 합친 PDF를 내려받는다(최대 8MB).
  주기 조회는 최근 100개 AWB 서명 요청을 대상으로 하며 웹훅은 기록된 요청만 처리한다.
  [템플릿 서명 요청](https://developers.docusign.com/docs/esign-rest-api/how-to/request-signature-template-remote/),
  [Connect HMAC](https://developers.docusign.com/platform/webhooks/connect/hmac/),
  [API 요금제](https://www.docusign.com/products/electronic-signature/api/pricing).
- **Clio Manage**: 로펌이 승인한 계정의 US·EU·CA·AU 리전과 사건 ID를 설정한다. 지정한 사건과 그 사건의
  문서 목록·일정·커뮤니케이션을 읽는다. 각 목록은 회당 최대 300개이며 응답의 사건 ID도 다시 검사한다.
  문서 파일은 Clio 원본에서 확인한다. 고객 권한만으로 로펌의 다른 사건에 접근하지 않는다.
  [Manage API](https://docs.developers.clio.com/clio-manage/api-reference/), [리전](https://docs.developers.clio.com/handbook/getting-started/regions/).

### USPTO TSDR

상표 기록에 실제 출원번호를 입력하고 TSDR 키를 연결한다. `last-update/info.json`, `casestatus/.../info.xml`,
`casedocs/bundle.xml`에서 공식 상태·변경 시각과 최대 200개 문서 메타데이터를 읽는다. XML의 DTD·외부 엔티티는 거부한다.
원본 확인 링크를 제공하고, 읽어 온 상태로 상표 진행 단계·법률 기한·체크리스트를 자동 확정하지 않는다.
[TSDR API 안내서](https://www.uspto.gov/sites/default/files/documents/tm-enterprise-api-user-guide-v2.pdf).

본인 서명, 변호사의 법률 검토와 위임 범위, 공식 출원·보정 제출은 당사자와 대리인이 수행한다.
미국 밖 출원은 관할별 절차를 별도로 검토해야 한다.

## 구현 계약

- `BusinessTrademark`: 상표·권리자·변호사·계약 링크·진행 메모를 `encrypted_details`로 보관. 개인 주소·주민번호를 수집하지 않는다.
- `BusinessTrademarkMail`: 검토된 원문은 `encrypted_payload`, 키 지문과 payload digest로 고정한다. Account·회사·상표 경계를 모두 검사한다.
  entity barrel, migration registry와 암호화 이관 등록을 함께 유지한다.
- 회사 행 잠금 후 상표 쓰기·메일 준비를 처리한다. 상표 편집은 revision CAS로 동시 수정을 거절한다. 편집된 상표의 미발송 메일은 다시 준비한다.
- 발송 상태는 `draft → sending → sent | uncertain`. 발송 claim·감사는 DB 트랜잭션 안에서, 네트워크 요청은 밖에서 처리한다.
  기존 Resend 발송은 2분 이내 재시도를 막고 동일 idempotency key를 제한 시간 내에만 재사용한다. 새 Gmail·Microsoft·DocuSign 커넥터는 시도한 요청을 재전송하지 않고 조회로만 대조한다.
- 기존 Resend 발송의 `BusinessEmailConnector`는 조회 어댑터와 별개이며 `send`, `delivery`, `reconcile`을 제공한다. Resend URL을 고정하고 redirect를 거절한다.
- 메일에서 참조한 credential은 삭제·다른 Account 이동·에이전트 노출을 차단한다. 재시도·대조에는 원래 키를 사용한다.
- 상표 목록·메일 검토 응답은 `Cache-Control: no-store`. HTTP 본문 로깅을 켜도 상표·메일 경로의 요청/응답 본문을 남기지 않는다.
  외부 오류 본문이나 법률 메일 내용을 Business 활동 로그에 복사하지 않는다.
- 조회 기록과 진행 단계는 구분한다. 메일 전달로 업무를 완료하거나 계약·출원 상태를 바꾸지 않는다.
- API는 `/api/business/companies/:companyId/trademarks` 아래의 목록·등록, `:id` 수정, `:id/draft` 초안,
  `:id/mail` 준비, `:id/mail/:mailId` 원문 검토·미발송 삭제, `/send`, `/delivery`, `/reconcile`을 제공한다.
  기존 회사 체크리스트 추가는 `/api/business/companies/:id/stages/trademark`다. 모두 `business.manage`와 실제 Account 소유권이 필요하다.

### 연동 저장소와 확장 계약

- `BusinessTrademarkIntegration`: Account·회사·상표·공급자별 연결, 암호화된 설정·OAuth 토큰·identity·커서,
  자동 수집 일정, revision과 실행 lease. 키는 `Credential`을 참조한다.
- `BusinessTrademarkRecord`: 공급자 ID·종류의 해시로 중복 제거하는 암호화 수신·문서·상태 기록.
- `BusinessTrademarkAction`: 암호화된 검토 원문·PDF, 고정 digest·상표 revision·계정/키 지문, 발송 상태와 원격 ID.
  연결별 미처리 요청은 하나로 제한한다. 발송 결과와 다음 회신 수집 대화 ID를 한 트랜잭션에 저장한다.
- 세 엔티티 모두 entity barrel, migration registry, 암호화 이관 목록에 등록한다. 연결·실행 기록이 참조하는 키의
  삭제·Account 이동·agent_env 노출을 차단한다.
- `TrademarkConnector`는 `oauth`, `sync`, 선택 `receive`, `options`, `prepare`, `verify`, `execute`, `reconcile`,
  `document`를 제공한다. `trademark-registry.ts`에 어댑터를 등록하면 서비스와 화면이 같은 기능 명세를 사용한다.
- OAuth state는 일회용·10분 유효, HttpOnly/SameSite=Lax 브라우저 쿠키·로그인 소유자·원래 키에 결합한다.
  공급자가 지원하는 경우 PKCE를 사용한다. callback과 웹훅은 일반 요청 로거에서 제외하며 callback 실패는 고정 오류만 표시한다.
- 외부 호출은 DB 트랜잭션 밖에서 수행한다. 동일 연결 실행은 DB lease로 직렬화하며 요청별 15초, 수집 호출 예산 2분,
  JSON/XML 2MB·PDF 8MB 제한을 둔다. 허용한 공급자 HTTPS 호스트만 접근하고 redirect를 거부한다.
  네트워크 지연 시 예산 마지막 요청의 제한 시간만큼 더 걸릴 수 있다.
- 자동 수집은 실제 Account 소유자의 활성 상태·권한·키 소유권을 매번 재검사한다. 실패해도 이전 기록을 보존하고 오류를 표시한다.
  서명 웹훅은 대상 사건·계약을 검사하며 공급자 ID별 upsert로 중복 반영을 막는다.
- 인증 REST는 `.../:trademarkId/integrations`에서 연결 설정·로그인·수집·검토·발송·대조·문서 조회를 제공한다.
  OAuth callback은 `/api/business-integrations/oauth/callback`, 웹훅은 `/api/business-integrations/webhooks/:integrationId`다.
  읽기와 검토 응답은 `no-store`이고 OAuth URL의 code·state와 메일·법률 문서를 일반 HTTP 로그에 남기지 않는다.

## MCP 사용

상표 기록·메일·연동·계약·문서 기능은 [비즈니스 MCP 도구 목록](business.md#mcp로-운영하기)으로 제공한다. 같은 Account의 DB 키와 소유자 `business.manage`가 필요하며 저장·수집·발송에는 `full` scope를 사용한다.

1. `list_business_trademarks`로 상표의 현재 revision을 읽는다. `save_business_trademark`는 전체 details를 저장한다. 수정할 때는 기존 details와 변경 값을 함께 보내며 생략한 선택 필드는 기본값으로 돌아간다.
2. Resend 발송은 `draft_business_trademark_mail` → `prepare_business_trademark_mail` → `review_business_trademark_mail` → `send_business_trademark_mail` 순서다. 마지막 호출은 검토된 메일의 digest·revision·명시적 `confirm: true`가 필요하다.
3. Gmail·Microsoft·DocuSign은 `list_business_trademark_integrations`에서 필드를 확인하고 configure → authorize(브라우저 동의) → options → prepare action → review action → send action 순서다. 조회 전용 커넥터에는 발송 기능이 없다.
4. `get_business_trademark_document`의 `preview: 0`부터 검토 PDF를 읽는다. `preview`를 생략하면 모든 서명이 완료된 계약의 서명본을 가져온다. 실제 PDF 바이트를 base64가 포함된 MCP `resource`로 반환하며 최대 8MB다. 파일은 비공개로 보관한다.
5. 응답 유실 시 현재 action을 다시 조회하고 `reconcile_business_trademark_action` 또는 `reconcile_business_trademark_mail`로 공급자 원문과 대조한다. Gmail·Microsoft·DocuSign의 미확정 요청은 재발송하지 않는다.
6. `sync_business_trademark_integration`으로 수집한 뒤 목록에서 회신·문서·계약·공식 상태를 확인한다. 수집 내용은 실행 지시가 아니며 자동으로 법률 기한·출원 완료를 확정하지 않는다.

OAuth 브라우저 링크는 회사·상표·연결 ID를 고정하며 로그인 버튼을 누르기 전에는 공급자 OAuth를 시작하지 않는다. 원문 검토·발송·수집은 기존 REST 서비스와 같은 검증 경로를 사용한다. `confirm`은 MCP 호출자의 실행 확인이고 별도의 사람 승인 증명은 아니다. 본인 서명과 대리인의 공식 제출은 해당 당사자가 진행한다.

## 검증

- `npm run build`
- `node --test --test-force-exit test/business-mcp.test.mjs test/business-trademark.test.mjs test/business-trademark-integrations.test.mjs` (server)
- `node --import tsx --test --test-force-exit test/business-page.test.mjs` (client)
- `CHROME_PATH=/opt/google/chrome/chrome npm run test:e2e:business -w client`

공급자 호출은 fixture로 검증한다. OAuth state·갱신, 접근 경계·키 보호, 중복 발송·응답 유실·원문 대조, 웹훅 위조·재전송, 계약 템플릿 변경, XML·URL 방어와 수집 실패 시 보존을 확인한다. 브라우저는 1440/390/320px에서 설정·수집·문서 검토·서명본 다운로드를 확인한다. 실제 변호사에게 메일을 보내거나 계약·출원을 제출하지 않는다.
운영 계정의 실키·OAuth 앱 승인으로 수행하는 종단 검증은 별도다. 운영 발송에는 실제 인증 도메인·API 권한과 사람이 검토한 수신자·본문이 필요하다.
