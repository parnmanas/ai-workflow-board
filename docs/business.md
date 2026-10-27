# Business: 회사 설립부터 운영과 성장까지

Business 대메뉴는 회사 설립, 상표·브랜드 보호, 은행, 결제, 회계, 고객지원과 기존 마케팅을 하나의 운영 흐름으로 묶는다.
`/business`는 전체 흐름, `/business/operations`는 영역별 업무와 외부 조회 데이터,
`/business/connectors`는 서비스 가격·기능 비교, 회사별 선택과 연결을 관리한다. 기존 `/marketing` 및 상세 URL과
승인·예산·실행 계약은 유지하며, 같은 Business 내비게이션에서 접근한다.

## 헤더와 모바일 배치

전체 흐름·운영·메일·커넥터와 마케팅 목록·상세·연락처는 `BusinessPageHeader`를 공유한다.
헤더에는 제목과 주요 작업 하나를 두고 새로고침·설정·연결 관리 등은 `⋯` 메뉴에서 제공한다.
좁은 본문에서는 회사 선택을 다음 행 전체에 배치하며, 긴 회사명·캠페인명은 헤더를 밀어내지 않는다.
생략된 제목과 설명은 메뉴에서 전체를 확인할 수 있다. 좁은 화면의 추가 버튼도 접근성 이름과 툴팁을 유지한다.

반응형 기준은 화면 너비가 아닌 `.business-shell`의 컨테이너 너비다. 사이드바가 열린 태블릿에서도
같은 규칙이 적용된다. 대메뉴 다섯 개는 모두 보이며 운영 단계는 한 줄 내부 스크롤을 사용한다.
직접 링크·뒤로 가기·화면 회전 시 선택된 단계를 보이게 하되 본문의 세로 스크롤을 옮기지 않는다.
메일은 회사 필터와 상세 필터 펼치기를 먼저 보여 주며, 접힌 필터의 적용 개수와 URL 상태를 유지한다.

새 페이지도 이 헤더를 사용하고 `test/business-header.e2e.mjs`의 경로 목록에 추가한다.
`npm run test:e2e:responsive -w client`와 기존 CI 브라우저 잡에서 320·390·768·1024·1440px 및
667×375 가로 화면의 실제 배치, 헤더 높이, 44px 터치 영역, 메뉴의 키보드 닫기·포커스 복귀,
긴 이름, 회사 문맥, 운영 탭의 선택 위치와 권한별 동작을 검사한다. 문서 가로 넘침만으로 합격시키지 않는다.

## 현재 제공하는 기능

- 회사 등록·수정, 회사별 캠페인 연결. 새 회사에는 7개 영역, 21개의 기본 업무를 생성한다. 기존 회사에는 상표 영역에서 체크리스트 8개를 명시적으로 추가할 수 있으며 기존 업무는 보존한다.
- 단계 진행률, 다음에 할 수 있는 업무, 기한 초과, 최근 활동. 숫자는 저장된 업무와 조회 결과에서만 계산한다.
- 전체 흐름의 이용 순서와 운영 영역별 진행 가이드: 준비 자료 → 실제 처리 장소와 서비스 링크 →
  AWB에서 확인할 결과, 업무 완료 기준, 연결 제약, 공식 사용자 가이드를 화면에서 제공한다.
  회사 등록 화면에도 관리용 등록과 실제 법인 설립 신청을 구분해 안내한다.
- 사용자 정의 업무, 선행 조건, 담당자 이름, 기한, 진행 메모, 기존 AWB 티켓 연결 및 새 티켓 생성.
  티켓의 실행 상태를 함께 보여 주되 회사 업무를 자동 완료하지 않는다.
- 26개 서비스·직접 처리 카탈로그, 같은 영역 최대 3개 비교, 플랜별 가격·과금 단위·추가 비용·출처·확인일, 회사별 서비스/플랜 선택 저장. 선택만으로 구매하거나 연결을 바꾸지 않는다.
- doola Partner API로 1인 LLC(WY·DE) 신청서 작성 → 비용 검토 → 명시적 제출 → 서명 링크 → 상태 조회.
- 커넥터별 키 등록/선택, 테스트·운영 환경, 연결 설정, 명시적인 조회, 연결 해제.
- 마케팅의 캠페인 실행·승인함·예산·고객 피드백은 기존 마케팅 구현을 사용한다.
- 상표별 출원 준비·변호사·회신·기한 기록, 영문 메일 초안과 Resend·Gmail·Microsoft 365 검토 후 발송, 회신 자동 수집.
- DocuSign 계약 PDF 검토·서명 요청·완료 웹훅·서명본 다운로드, Clio 사건·문서·일정, USPTO TSDR 상태·문서 자동 수집. OAuth 로그인·토큰 갱신과 5/15/60분 주기 조회를 포함한다. 설정·권한·수집 범위는 [상표 출원](trademarks.md)을 참고한다.
- 위 비즈니스 기능 전체를 MCP 도구 50개로 제공한다. REST와 같은 서비스·소유권·revision·검토 원문 검사를 거쳐 실행한다. 사용 순서는 `get_business_workflow_guide`에서 조회한다.

회사를 AWB에 등록하거나 체크리스트를 완료하는 것은 법인 설립·계좌 개설·신고 완료를 뜻하지 않는다.
doola는 파트너 계약과 키를 갖춘 사용자의 내부 설립 신청을 지원한다. 다른 설립 서비스는 외부에서
신청하고 AWB에서 업무를 기록한다. 운영 API 조회 어댑터는 9개이며 나머지 15개는 비교·선택·외부
진행용이다. 여기에 키가 필요 없는 직접 설립·직접 회계 옵션 2개를 제공한다. 공급자 자체의 API 제공 여부와 AWB가 구현한 기능을 별도로 표시한다.
상표의 기존 Resend 발송(`BusinessEmailConnector`)과 새 연동 6개(`TrademarkConnector`)는 별도 레지스트리이며 위 운영 조회 어댑터 수에 포함하지 않는다.
KYB, 송금, 결제 생성·환불, 공급자 장부 쓰기·세무 신고, 고객 응답은 해당 서비스에서 처리한다. 직접 회계는 아래 범위의 AWB 입출금 보조 장부에 기록한다.

## 연결 가능한 서비스

공식 API 문서를 2026-10-23에 확인했다. 실제 계정 키와 공급자 권한이 있어야 조회할 수 있다.

| 커넥터 | 이번 구현 | 인증 / 환경 | 공식 문서 |
| --- | --- | --- | --- |
| doola | 1인 LLC 신청·서명 링크, 기존/신규 회사의 설립 상태, EIN 발급 여부, 연차 보고 기한 | Partner API 키, 회사 ID. sandbox/live | [Partner API](https://docs.doola.com/api/introduction), [Get company](https://docs.doola.com/api/api-reference/companies/get-a-company), [Compliance calendar](https://docs.doola.com/api/api-reference/compliance/get-a-companys-compliance-calendar) |
| Mercury | 계좌 수, 최근 입출금 최대 40건 | 읽기 전용 API 토큰. sandbox/live | [Accounts](https://docs.mercury.com/reference/getaccounts), [Transactions](https://docs.mercury.com/reference/listtransactions) |
| Stripe | 통화별 사용 가능·대기 잔액, 최근 순액 정산 거래 25건 | 조회 권한을 가진 secret/restricted key. sandbox/live | [Balance](https://docs.stripe.com/api/balance), [Balance transactions](https://docs.stripe.com/api/balance_transactions/list) |
| Xero | 조직 정보, 승인된 매출 청구서 첫 페이지(최대 50건) | OAuth access token + tenant ID. live | [Accounting API](https://developer.xero.com/documentation/api/accounting/overview/) |
| Chatwoot Cloud | 진행 중·미배정 대화 수, 인박스 목록 | 사용자 API 토큰 + Chatwoot 숫자 account ID. live | [Conversation counts](https://developers.chatwoot.com/api-reference/conversations/get-conversation-counts) |
| Stripe Atlas | 외부 신청 화면 바로가기 | AWB에 키를 저장하지 않음 | [Atlas](https://docs.stripe.com/atlas) |
| QuickBooks Online | 미수 청구서 메타데이터 최대 50건 | OAuth access token + realm ID. sandbox/live | [Invoice API](https://developer.intuit.com/docs/api/accounting/invoice) |
| Intercom | 전체 상담 수, 최근 목록 30건의 상태 | 미국 리전 private app access token, API 2.17 | [Conversations](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/listconversations) |
| Zendesk | 최근 티켓 30건의 상태 | Support OAuth read 토큰 + subdomain | [Tickets](https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/) |
| Freshdesk | 최근 30일 생성 티켓 중 30건의 상태 | API 키 + subdomain | [Tickets](https://developers.freshdesk.com/api/#list_all_tickets) |

외부 진행용 설립 서비스: Stripe Atlas, Firstbase, Clemta, LegalZoom, ZenBusiness, CorpNet.
은행·결제 외부 진행용: Relay, Brex, Wise Business, PayPal, Paddle. 이들의 API가 공급자에 있더라도
AWB에 어댑터가 구현된 것으로 표시하지 않는다. CorpNet은 파트너 계약 후 확장 가능한 설립 API다.
상표 출원·상담 비교: USPTO, LegalZoom Trademark, Trademarkia, Trademark Engine. 공식 사이트에서
출원·수임을 진행하고 AWB에서 사건과 커뮤니케이션을 관리한다. TSDR 커넥터는 상표별 연결 화면에서 설정하며 공식 상태·문서의 자동 조회와 출원 제출을 구분한다.

가격 데이터는 `connectors/service-offerings.ts` 한 곳에서 관리한다. 공식 가격표 링크·2026-10-23
확인일·플랜·과금 단위·포함/별도 비용을 유지한다. 프로모션 대신 정가를 기본으로 표시하고 USD
소비자 가격과 파트너 API 계약 가격을 구분한다. 실시간 견적·세금 포함 총비용·자동 최저가 정렬은
제공하지 않는다. 가격 변경은 이 파일을 공식 출처로 갱신한다. 직접 처리 조건·가격·공식 근거는 `business-self-service.ts`에서 관리한다(확인 2026-10-24).

Xero·QuickBooks는 발급된 access token을 사용하며 OAuth 동의/자동 갱신은 제공하지 않는다.
Chatwoot은 Cloud만, Intercom은 미국 리전만 지원한다. Zendesk/Freshdesk는 검증한 단일 subdomain을
공급자 고정 도메인에 넣으며 임의 URL·도메인·경로를 받지 않는다.
금융 내역은 제한된 조회 샘플이며 원장 전체나 회계 대사 결과로 취급하지 않는다. 통화별 금액을 합산하지 않는다.

## 직접 설립·직접 회계와 해외 운영자

서비스 카탈로그의 **직접 처리** 필터에서 `직접 LLC 설립`과 `직접 회계 · AWB 장부`를 선택한다.
대행 서비스와 같은 영역에서 가격·기능을 비교할 수 있다. `manual` 방식은 외부 API 키가 필요 없다.
조건 점검은 서버가 제공하며 미응답을 충족으로 간주하지 않는다. 조건이 충족되어야 선택을 저장한다.
운영자 해외 거주와 소유자의 미국 세법상 외국인 여부는 독립 질문이다. 해외 운영자는 거주·실제 운영 국가의 의무를 확인하는 추가 질문에 답한다.
이는 AWB 사용 전 준비 확인이며 법적 자격·면세·세무 신고 완료를 보증하는 판정이 아니다.

| 작업 | 직접 처리 조건·범위 |
| --- | --- |
| 일반 LLC 설립 | 현재 가이드는 US · LLC · WY/DE만 지원. 회사 정보와 선택한 주가 같고 명칭·신청/서명 권한·주내 Registered Agent·후속 의무를 확인해야 한다. 다른 주·형태가 법적으로 직접 설립 불가라는 뜻은 아니다. |
| 해외에서 LLC 설립 | 해외 거주·SSN 미보유만으로 일반 LLC 설립을 금지하지 않는다. WY는 주내 실제 주소와 대리인 동의, DE는 주내 적격 대리인·실제 주소가 필요하다. 직접 대리인을 맡는 자격과 회사 소유·운영 자격은 구분한다. |
| EIN 온라인 | 미국/미국령의 **주된 사업장**과 책임자의 SSN/ITIN이 필요하다. Registered Agent·우편 주소만으로 주된 사업장 요건을 충족하지 않는다. 실제 주정부 설립 후 IRS에서 신청한다. |
| EIN 대체 경로 | 해외 주된 사업장은 전화·팩스·우편, 온라인 식별번호 조건을 못 맞추면 SS-4 팩스·우편 경로를 확인한다. SS-4 7b의 foreign/N/A는 번호 미보유 **및 발급 자격 없음** 조건을 확인해 적용한다. IRS 신청 자체는 무료다. |
| 직접 장부 | 해외에서도 사용 가능. 단일 USD 계좌의 실제 입출금만 기록하고 증빙 원본·은행 명세서를 보관한다. AWB는 증빙 참조를 저장하며 은행 커넥터 샘플을 자동 전기하지 않는다. |
| 직접 세금 신고 | 해외 거주 자체가 회계사 선임 의무가 되지는 않는다. 서식별 서명 권한·식별번호·전자/팩스/우편 제출 요건·기한을 확인해야 한다. AWB는 신고서 작성·제출이나 세액 계산을 수행하지 않는다. |

일반 LLC의 설립자와 대리인 조건은 [WY §17-29-201](https://wyoleg.gov/statutes/compress/title17.pdf),
[WY 대리인 지침](https://sos.wyo.gov/Business/Docs/HowToFindOrBecomeARegisteredAgent.pdf),
[DE 설립 안내](https://corp.delaware.gov/howtoform/)와 [DE의 member/person 정의](https://delcode.delaware.gov/title6/c018/sc01/index.html)를 따른다.
온라인 EIN과 SS-4 경로는 [IRS EIN](https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number),
[해외 신청](https://www.irs.gov/businesses/employer-identification-number), [SS-4 지침](https://www.irs.gov/instructions/iss4)을 근거로 한다.
직접 작성과 서명 권한은 [1120 지침](https://www.irs.gov/instructions/i1120)의 Who Must Sign / Paid Preparer 항목에서 구분된다.

설립 기본비용은 WY $100, DE $110. WY 연간세는 $60과 WY 내 자산 × 0.0002 중 큰 금액이며 설립 기념월 1일까지 연차 보고한다.
DE는 2026 세액부터 연간 $400, 다음 해 6월 1일까지 납부한다. 이전 $300 안내가 남은 페이지 대신
[2026 개정 법안](https://legis.delaware.gov/BillDetail/143069), [2026-08 공식 설립 서식](https://corpfiles.delaware.gov/LLC_Forms/LLC%20Formation.pdf),
[WY 2026 수수료표](https://sos.wyo.gov/Business/docs/BusinessFees.pdf)를 적용한다. 대리인·결제·급행·인허가·세무 비용은 별도다.

외국 소유 회사의 신고를 매출 유무만으로 판정하지 않는다. **외국인이 전부 소유한 미국 disregarded entity에 보고 대상 관계자 거래가 있으면**
Form 5472 + pro forma 1120이 필요하다. 출자·분배·설립 관련 지급도 보고 대상이 될 수 있다.
이 경우 IRS는 현재 전자신고 대신 지정 팩스·우편 경로를 안내한다. [IRS Form 5472 지침](https://www.irs.gov/instructions/i5472).
파트너십은 1065 등 신고를 검토하고, 외국 파트너에 귀속되는 미국 사업 관련 과세소득이 있으면
[1446 원천징수](https://www.irs.gov/individuals/international-taxpayers/partnership-withholding)를 검토한다.
[비거주 외국인은 S-Corp 주주 요건에 맞지 않는다](https://www.irs.gov/businesses/small-businesses-self-employed/s-corporations).
해외에 사는 미국 시민권자와 미국 세법상 외국 소유자를 같은 것으로 취급하지 않는다.
거주 국가·실제 사업 지역의 등록·과세·해외투자/계좌 신고는 미국 절차와 별도로 확인한다.

### AWB 입출금 장부

- `BusinessCashEntry`: USD 정수 센트, 거래일·용도·증빙 참조. 영업 입출금, 출자/인출, 대출 원금, 이체, 환불을 분리한다. 금액/일자/구분은 불변이며 취소 사유를 남긴 뒤 새 거래로 정정한다. `request_id`의 동일 재시도는 기존 기록을 반환하고 내용이 다르면 거부한다.
- `BusinessCashMonth`: 모든 유효 거래의 증빙·은행 대사 확인, 전체 명세서 기록 확인, 기초+순입출금=기말 잔액, 인접 전월 마감 잔액 일치를 검사한다. 현재/미래 월은 마감할 수 없다. 후속 월이 마감됐으면 이전 월을 수정할 수 없고 가장 최근 월부터 사유를 남겨 재개한다.
- 월별 CSV는 취소 기록까지 포함한다. 문자열 수식은 이스케이프하고 금액은 센트로 내보낸다. 서비스 변경 뒤에도 조회·내보내기·마감 재개는 가능하며 새 기록/대사는 직접 회계 조건을 다시 확인해야 한다.
- 월 5,000건(취소 포함), 건별 금액 최대 $20,000,000, 마감 잔액 ±$20,000,000. 보조 장부이므로 복식부기·재고·발생주의·급여·감가상각·여러 통화·세무 결산은 별도 도구와 연결한다. 순입출금과 영업 입출금 차이를 회계이익이나 과세소득으로 표시하지 않는다.
- Account/Company 소유권과 회사 revision을 모든 변경에서 검사한다. 회사명·형태·국가·주 변경은 확인 답변을 초기화한다. 기록·대사·취소·마감·재개는 감사 이벤트를 남기며 금융/조건 본문을 HTTP/MCP 디버그 로그에 남기지 않는다.

MCP에서도 `assess_business_self_service`로 조건을 조회·미리 평가하고 `choose_business_service.self_service_answers`로 확인 답변을 저장한다.
`get_business_cashbook`, `add_business_cashbook_entry`, `reconcile_business_cashbook_entry`, `void_business_cashbook_entry`,
`close_business_cashbook_month`, `reopen_business_cashbook_month`가 화면과 같은 서비스를 호출한다. 미확인 사실에 대한 답을 에이전트가 추측해서 채우면 안 된다.
조회/조건 평가는 읽기 키로, 변경은 full 키로 가능하다. 장부 변경 자체가 외부 송금·세금 신고를 실행하지 않는다.

## 내부 설립 신청

공식 계약: [Company formation](https://docs.doola.com/api/formation),
[인증·중복 방지](https://docs.doola.com/api/authentication),
[SS-4·8821 서명](https://docs.doola.com/api/non-us-formation).

1. 회사 정보를 미국 LLC로 등록하고 doola 카드의 **설립 신청 · 기록**을 연다.
2. 파트너 키와 sandbox/live 환경을 고르고 공식 reference API에서 업종과 주정부 수수료를 가져온다.
3. 1인 자연인 소유(100%)·책임자의 영문 이름·주소·이메일·전화, WY/DE와 사업 내용을 입력한다.
   회사 우편 수취 주소는 소유자 주소, 사업장 주소는 등록 대리인 주소다. 다인 소유·C-Corp·다른 주는
   외부 신청을 이용한다. SSN은 수집하지 않으므로 SS-4 서명 단계가 남는다.
4. 서버에서 다시 확인한 주정부 수수료와 정규화된 신청 내용 전체를 검토한다. 파트너 계약 비용은
   별도이며 일반 doola 구독 가격을 합산해 API 청구 총액으로 표시하지 않는다. 검토는 30분 유효하다.
5. 확인 체크 후 **실제/테스트 신청 제출**. 서버는 원래 키 지문·payload digest·수수료를 대조하고
   DB claim 후 고객 생성 → 회사 생성을 호출한다. 네트워크 I/O는 DB 트랜잭션 밖에서 수행한다.
6. 접수 후 기존 doola 연결이 없을 때 조회 연결을 만든다. 기존 연결은 덮어쓰지 않는다. SS-4 또는
   공급자가 추가 요청한 Form 8821 서명 링크를 발급받아 본인이 서명한다. 접수는 설립 완료가 아니다.
   상태는 조회 버튼으로 확인하며 업무 완료는 증빙을 확인한 사람이 기록한다.

`draft → submitting → submitted | uncertain`. 회사·공급자·환경별 기록은 하나이며 제출을 시도한
신청은 수정/삭제하거나 새로 만들 수 없다. 제출 전 초안만 삭제·재작성할 수 있다. 모호한 결과는
실패로 단정하지 않고 사용자가 원래 신청서·고정 Idempotency-Key로 재확인한다. 자동 재전송하지
않으며 동시 제출은 CAS로 차단한다. 프로세스 중단 후 `submitting`은 2분 뒤 같은 요청으로 재확인한다.
수수료나 원래 키가 달라진 제출 시도는 재확인도 막고 공급자 확인을 안내한다.

고객 정보는 `BusinessFormation.encrypted_request`에 암호화해 저장하고 성공 확정 후 지운다.
일반 회사 상세에는 요약만 반환한다. 본인 Account의 검토 REST와 MCP 도구에서 원문을 복호화하며 REST는 `no-store`다.
SSN·EIN 원문·고객 메시지·서명 URL은 조회 스냅샷이나 활동 기록에 넣지 않는다. HTTP body logging을
켜도 설립 경로와 credential 쓰기의 본문은 기록하지 않는다. 서명 URL은 요청한 사용자 화면 또는 권한을 확인한 MCP 호출에만 반환한다. 에이전트는 이 단기 링크를 실제 서명자에게 비공개로 전달한다.
인스턴스 이관 시 원문은 기존 credential과 같은 TLS 복호화/재암호화 경로를 사용한다. 키 지문과
신청 digest는 공급자 키에서 안정적으로 계산해 AWB 암호화 키가 달라져도 재시도 정체성을 보존한다.
설립 커넥터의 웹훅 수신·자동 주기 동기화·파트너 비용 결제 화면은 아직 제공하지 않는다. 상표 연동의 주기 수집·웹훅과는 별개다.

## 메일 자동화 커넥터

`/business/mail`은 접근 가능한 소유 Account의 메일 연결을 합쳐 보여주는 비즈니스 작업함이다.
Account 선택기나 메일 계정별 페이지는 없으며 회사·연결·주소·업무 용도(대표/회계/마케팅/운영),
수신/발신, 처리 상태, 발신 결과로 필터링한다. 소유 경계는 그대로 유지하며 관리자도 타인의 메일을 읽지 못한다.
회사 지정은 선택이며, 연결의 credential과 같은 소유 Account여야 한다. 기존 상표·마케팅 공급자 연결은 그대로 유지한다.

- 커넥터: `mail/mail-registry.ts`의 `MailConnector` 계약과 SMTP·IMAP / JMAP 어댑터.
  SMTP와 IMAP은 서로 다른 서버를 사용하거나 한쪽만 설정할 수 있다. TLS와 STARTTLS를 지원하며
  인증서 검증을 끌 수 없다. SMTP·IMAP은 비밀번호/앱 비밀번호, JMAP은 Bearer API 토큰을 사용한다.
  OAuth 로그인·refresh token 갱신은 이 커넥터에 아직 포함하지 않는다. OAuth 전용 서비스는 기존 전용 연동을 이용한다.
- Mail credential에는 `smtp_password`, `imap_password`, `jmap_token` 중 사용하는 필드만 저장한다.
  연결 폼에서 등록할 수 있으며 서버 전용(`agent_env=false`)으로 보관한다. 참조 중인 키의 삭제·소유 변경·에이전트 노출을 막는다.
- 서버·로그인·수집 폴더·프로토콜 변경은 새 연결로 등록한다. 기존 연결은 이름·회사·용도·주소·키·수집 간격과 사용 여부를 바꿀 수 있다.
  사용 중지를 하면 수집과 새 발신이 멈추고 이전 기록은 남는다. 연결 및 처리 상태는 revision/CAS로 충돌을 검사한다.
  연결의 revision은 설정 저장 때만 증가한다. 수집·발신의 lease 획득/해제는 편집 중인 설정을 무효화하지 않으며,
  lease 획득 뒤 최신 커서를 읽고 설정 저장도 같은 트랜잭션에서 최신 커서를 보존한다.
- 웹 서버는 IMAP IDLE 또는 JMAP EventSource로 새 메일을 감지하면 즉시 커서 수집을 요청한다.
  연결·인증·DNS 변경과 끊김은 재접속하며 5/15/60분 주기 수집으로 누락을 보완한다. 실시간 기능이 없는 서버는
  주기 수집을 사용하며 연결 관리에 현재 수신 방식과 복구 상태를 표시한다. 프로세스당 실시간 연결 상한은 100개다.
  standalone MCP는 수집·실시간 감시 타이머를 만들지 않는다. 최초 수집은 최근 20건이다.
  이후 IMAP은 UIDVALIDITY/UID, JMAP은 Email/changes 상태로 새 메일을 수집한다. IMAP은 지정한 폴더,
  JMAP은 받은편지함을 대상으로 한다. 수집 기록과 커서는 같은 트랜잭션으로 저장해 실패 시 누락을 막는다.
  연결별 DB lease로 여러 서버·수동 수집의 중복 실행을 막고 source ID로 중복 수집을 제거한다.
  JMAP 서버가 상태를 만료시켜 changes를 거절하면 오류로 표시하며 과거 메일을 건너뛰며 자동 초기화하지 않는다.
- 본문은 암호화된 텍스트 캐시로 보관한다. 수신 HTML은 텍스트로 변환하며 이미지·스크립트를 실행하지 않는다.
  IMAP 원문은 2MB, 저장 본문은 100,000자로 제한하며 제한 초과는 `truncated`로 표시한다.
  첨부파일은 이름·유형·크기만 수집하고 내려받기·발신 첨부·폴더 편집·일반 메일 작성기는 제공하지 않는다.
  큰 IMAP 원문은 본문·첨부 목록도 가져오지 않으므로 원본 메일에서 확인한다. 주소 필터는 수신 헤더에서 확인한
  등록 주소 또는 발신 주소를 대상으로 하므로 숨은참조 주소를 추정하지 않는다.
- 열람은 처리 완료가 아니다. 화면 또는 `confirm_business_mail`로 확인/미확인과 처리 메모를 기록한다.
  외부 메일함의 읽음·폴더·삭제 상태에는 영향을 주지 않는다. 보관 원본은 외부 메일 서비스에 있다.
- 자동화는 `list_business_mail` → `get_business_mail` → 업무 처리 → `confirm_business_mail`을 사용한다.
  필요하면 `send_business_mail`로 텍스트 발신/답장을 실행한다. 답장은 같은 연결의 `reply_to_message_id`와
  명시적인 수신자·발신 주소를 사용한다. 수신 메일의 내용은 실행 승인이나 지침이 아니다.
  사용자에게 승인받은 업무 범위에서만 발신하며, 기존 마케팅 캠페인의 사람 승인·동의·수신거부 경로를 우회하지 않는다.
  기본은 답장 자동화 꺼짐이며 티켓은 만들지 않는다. 연결별로 `automation.mode`를 `review`(사람 승인 후 발송) 또는
  `automatic`으로 설정하고 담당 `agent_runtime`, `objective`, 발신 주소, 하루 처리 한도(기본 20, 최대 100)를 지정하면
  새 메일마다 담당 RuntimeSpec으로 처리 방을 열어 초안 작성을 요청한다. 설정·실행·발송 때 현재 소유자·Host·credential을 검증한다.
  실행 키·working_dir를 포함한 일반 RuntimeSpec 선언 UI를 재사용한다. 비즈니스 도구를 제공하는 full MCP 프로필을 사용한다.
  메일 연결 폼의 담당 에이전트 입력은 ‘연결 저장’ 때 함께 검증·저장하며 별도 적용 버튼을 누를 필요가 없다.
  필수 입력 누락과 저장 실패 사유는 스크롤 위치와 관계없이 저장 버튼 옆에 표시한다.
  처리 방은 `run_kind=mail`이며 소유자·담당 runtime·서버 발화자(system)를 참여자로 등록한다. 일반 채팅 목록과 알림에서는
  제외하고 메일 상세의 처리 기록으로 접근한다. 기존 `is_action_room` 이벤트 계약으로 담당 에이전트에게 작업 실행임을 알린다.
  과거 메일과 IMAP UIDVALIDITY 초기화 때 가져온 메일은 수신 알림·자동 답장을 시작하지 않는다.
  과거 메일은 화면의 ‘에이전트에게 답장 작성 요청’ 또는 `start_business_mail_reply`로 명시적으로 요청한다.
- 새 메일과 답장 확인 요청은 소유자에게만 `business_mail_update` SSE로 전달한다. AWB에서 토스트·소리,
  브라우저 권한을 허용한 경우 백그라운드 탭에서 OS 알림으로 표시하며 클릭하면 해당 메일로 이동한다.
  AWB를 닫아도 알림을 받으려면 개인 알림 채널(Discord/Slack/Telegram)의 `notify_mail`을 사용한다.
  수신 기록과 알림 대기를 같은 트랜잭션으로 저장하고 재시작 후 이어서 처리한다. 외부 알림 실패는 최대 3회 시도한다.
  브라우저는 동일 알림 ID를 중복 표시하지 않는다. 외부 채널에는 공통 멱등 API가 없으므로 장애 복구 시 중복 알림이 가능하다.
- `get_business_mail_reply`, `list_business_mail_replies`로 상태와 초안을 확인한다. 지정한 Host/runtime만
  `submit_business_mail_reply`로 초안을 제출할 수 있다. 수신자와 발신자는 수신 시 설정한 값으로 고정하며 에이전트가 바꾸지 못한다.
  `decision=review`는 자동 모드에서도 사람 확인을 요청하고 `skip`은 답장이 불필요한 이유를 기록한다.
  반자동 승인·수정은 소유자의 로그인 세션에서 처리한다. 수정한 초안을 저장한 후 현재 revision으로 승인해야 하며
  에이전트 MCP에는 사람 승인 기능을 제공하지 않는다. 작업 중 직접 발신·정책 변경 도구로 승인 단계를 우회하는 호출도 거부한다.
  연결 중지·목적·담당·모드 변경은 이전 설정의 대기/작성/검토 작업을 취소한다. 전송을 시작한 작업은 결과를 대조해야 한다.
  동일 Account의 Message-ID/발신자 조합은 연결이 달라도 한 번만 답장하며, 자동 생성·목록·반송·자기 주소·본문 잘림·Message-ID 없는 메일은
  자동 작성하지 않는다. 자동화 발신은 [RFC 3834](https://www.rfc-editor.org/rfc/rfc3834.html)의 `Auto-Submitted: auto-replied`를 표시한다.
  이는 외부 메일을 다루는 에이전트의 샌드박스를 대신하지 않으므로 목적에 맞는 실행 권한·전용 작업 폴더를 설정한다.
- 발신마다 안정적인 `request_id`를 요구한다. DB에 먼저 기록하고(sql.js는 파일 저장 완료까지 확인), 서버에 제출한다.
  같은 요청 ID는 내용이 같을 때 기존 결과를 반환하며 내용이 다르면 거부한다. `accepted`는 서버 접수이지 최종 배달이 아니다.
  전송 도중 장애·부분 수신자 거절은 `uncertain`, 10분 넘게 남은 `sending`도 확인 필요로 표시한다.
  자동 재전송하지 않으며 원본 서버 기록과 대조한 결과를 처리 메모에 남긴다.
- 사용자 입력 호스트는 DNS 검증 후 실제 접속 IP에 고정하고 내부 주소를 기본 차단한다. NAS 등 내부 메일 서버는 운영자가
  `AWB_MAIL_PRIVATE_HOSTS=mail.example.com,nas.example.com`처럼 정확한 호스트를 서버 환경에 등록한다.
  전체 내부망 허용이나 인증서 검증 해제는 없다. JMAP Session URL과 발견한 API URL은 같은 HTTPS origin이어야 하며 redirect는 따르지 않는다.
- `BusinessMailConnection`, `BusinessMailMessage`, `BusinessMailTask`는 엔티티 배럴·이관 레지스트리·암호문 재암호화 목록에 함께 등록한다.
  메일 REST 및 MCP 인수/결과 본문은 요청 로그에서 제외한다. 메일 인증 정보를 에이전트에게 반환하지 않는다.

검증: `test/business-mail.test.mjs`, `test/business-mail-workflow.test.mjs`(SQLite/PostgreSQL), `test/business-mail-connectors.test.mjs`, `test/business-mcp.test.mjs`,
클라이언트 `test/business-mail.test.mjs`. 프로토콜 fixture와 내부 HTTP/MCP를 검증하며 실제 메일 서버 운영 계정으로 송수신하지 않는다.

## MCP로 운영하기

기본 `full` 도구 프로필에서 제공한다. `compact` 프로필은 티켓 중심 목록을 유지하므로 비즈니스 작업에는 `X-AWB-Tool-Profile: full`로 새 MCP 세션을 연결한다. **도구 프로필**과 API 키의 **권한 scope**는 별개다.

모든 도구는 DB에 저장된 활성 Runtime Host/키의 Account와 활성 소유자의 `business.manage`를 호출마다 검사한다. 조회는 `read` 이상, 저장·수집·외부 실행은 `full` scope가 필요하다. 환경변수 키·개발 우회 인증은 비즈니스 도구에서 사용할 수 없다. 관리자도 다른 Account의 회사·상표·문서·credential을 가져올 수 없다.

| 작업 | MCP 도구 |
| --- | --- |
| 흐름·가격·연결 준비 | `get_business_workflow_guide`, `list_business_connectors`, `compare_business_services`, `list_business_credentials` |
| 회사·캠페인 연결 | `list_business_companies`, `get_business_company`, `create_business_company`, `update_business_company` |
| 서비스·업무 | `choose_business_service`, `save_business_task`, `delete_business_task`, `initialize_business_trademark_tasks`, `create_business_task_ticket` |
| 운영 커넥터 | `configure_business_connector`, `sync_business_connector`, `disconnect_business_connector` |
| 설립 | `get_business_formation_references`, `prepare_business_formation`, `review_business_formation`, `discard_business_formation`, `submit_business_formation`, `get_business_formation_signature` |
| 상표·변호사 메일 | `list_business_trademarks`, `save_business_trademark`, `draft_business_trademark_mail`, `prepare_business_trademark_mail`, `review_business_trademark_mail`, `discard_business_trademark_mail`, `send_business_trademark_mail`, `refresh_business_trademark_mail_delivery`, `reconcile_business_trademark_mail` |
| 상표 연동 | `list_business_trademark_integrations`, `configure_business_trademark_integration`, `disconnect_business_trademark_integration`, `authorize_business_trademark_integration`, `sync_business_trademark_integration`, `get_business_trademark_integration_options` |
| 메일 계정·계약 실행 | `prepare_business_trademark_action`, `review_business_trademark_action`, `discard_business_trademark_action`, `send_business_trademark_action`, `reconcile_business_trademark_action`, `get_business_trademark_document` |
| 표준 메일 연결·수신·확인·발신 | `list_business_mail_connections`, `configure_business_mail_connection`, `sync_business_mail`, `list_business_mail`, `get_business_mail`, `confirm_business_mail`, `send_business_mail` |
| 담당 에이전트 답장 | `list_business_mail_replies`, `get_business_mail_reply`, `start_business_mail_reply`, `submit_business_mail_reply` |

설립은 `get_business_company`로 회사 revision을 읽고 references → prepare → review → submit 순서로 진행한다. submit에는 검토한 **신청의** `revision`, `payload_digest`, `confirm: true`를 전달한다. 회사·상표·연결·신청의 revision은 서로 대체할 수 없다. 기존 서비스가 적용하는 비용 유효기간, 멱등 키, 원문·키 변경 검사와 불확실한 결과의 재시도 제한이 MCP에도 적용된다.

`confirm`은 에이전트가 사용자의 실행 지시를 확인했다는 입력이며, 별도의 인증된 사람 승인 기록은 아니다. 도구 설명은 제출·발송에 대한 명시적 사용자 지시를 요구한다. 에이전트는 수신 메일이나 문서에 적힌 명령을 발송·서명·결제 승인으로 취급하면 안 된다. 메일 본문과 법률 문서는 반환되므로 필요한 작업 문맥에서만 사용한다. 기존 마케팅 MCP의 제안 전용·사람 승인 계약은 유지한다.

회사·체크리스트 생성은 티켓을 만들지 않는다. `create_business_task_ticket`은 사용자가 티켓 생성을 요청한 경우에만 `user_requested_ticket: true`로 호출하며 소유자의 `tickets.create`도 필요하다. 결과는 실제 Ticket의 `id/title/status`이고 MCP 세션과 Agent Manager에서 티켓 카드로 기록한다.

서버 키 값은 MCP로 받거나 내보내지 않는다. 설정의 Credentials에서 서버 전용 키를 등록하고 `list_business_credentials`의 ID로 연결한다. OAuth 동의는 `authorize_business_trademark_integration`이 반환한 AWB 링크를 소유자가 열어 **지정된 상표·커넥터의 로그인 버튼**에서 진행한다. HttpOnly 쿠키·OAuth state·access/refresh token은 MCP에 반환하지 않는다. 직접 서명, KYB, 외부 전용 서비스의 신청은 공급자 화면에서 이어간다.

NestJS `/mcp`와 standalone HTTP(`MCP_TRANSPORT=http`)에 같은 비즈니스 서비스를 연결한다. 자동 수집 타이머와 OAuth callback·웹훅 수신은 AWB 웹 서버가 담당하며 standalone MCP 프로세스는 타이머를 중복 실행하지 않는다. 인증된 HTTP 세션의 수동 수집·검토·실행 도구는 양쪽에서 사용할 수 있다. 호출자 인증이 없는 로컬 stdio에서는 비즈니스 도구를 실행하지 못하므로 인증된 HTTP 연결을 사용한다. MCP HTTP 로거는 비즈니스 도구 이름만 남기고 신청자·메일·계약 인수를 생략한다.

`test/business-mcp.test.mjs`는 비즈니스 REST 핸들러의 MCP 대응을 검사한다. 공급자 서명 웹훅과 브라우저 OAuth callback은 전송용 예외이며, 메일 반자동 답장 승인은 인증된 사람만 수행하는 예외다. 같은 테스트에서 61개 도구를 실제 HTTP MCP로 호출하고 소유권·권한·revision·문서·불확실한 발송 대조를 검증한다. 새 비즈니스 REST 핸들러는 이 대응표와 MCP 구현을 함께 추가해야 한다.

## 소유권과 저장

`BusinessCompany`는 Account 소유의 별도 업무 객체다. Account를 법인으로 바꾸거나 Project를
회사로 재해석하지 않는다. Account/Scope 선택기도 추가하지 않는다. 회사 선택기는 같은 사용자에게
허용된 실제 회사 레코드 중 관리할 회사를 고르는 기능이다.

| 엔티티 | 저장 내용 |
| --- | --- |
| `BusinessCompany` | 회사 기본 정보, 연결 캠페인 ID, 서비스/플랜 선택, revision |
| `BusinessTask` | 단계별 업무, 선행 업무, 상태, 담당자·기한·메모, 티켓 참조 |
| `BusinessTaskEntry` | 업무별 진행·결과·결정·추가 요청·처리 결과·변경 전후 기록. append-only |
| `BusinessConnection` | 공급자, credential 참조, 환경·외부 ID, 마지막 조회 결과·시각·오류, revision |
| `BusinessFormation` | 환경별 신청, 검토 digest·비용, 암호화 원문, 키 지문, 제출 상태·외부 ID, revision |
| `BusinessTrademark` | 암호화된 상표·권리자·변호사·계약 링크·출원번호·기한·회신 기록, revision |
| `BusinessTrademarkMail` | 암호화된 검토 원문, 키 지문·검토 digest, 발송 시도·결과·전달 상태, revision |
| `BusinessTrademarkIntegration` | 상표별 커넥터·키 참조, 암호화 설정·OAuth 토큰·커서, 자동 수집 일정·lease |
| `BusinessTrademarkRecord` | 공급자 ID별 암호화 회신·계약·문서·일정·공식 상태 |
| `BusinessTrademarkAction` | Gmail·Microsoft·DocuSign 검토 원문·PDF, 승인 digest, 발송·대조 결과 |
| `BusinessEvent` | 변경 주체와 활동 기록. append-only, REST 수정/삭제 없음 |

전부 `account_id`를 저장하며 엔티티 배럴과 이관 레지스트리에 함께 등록한다.
회사 상세 경로의 실제 소유자는 `AccountAccessService`가 판정한다. 서비스 조회에도 소유 조건을
반복 적용한다. 관리자도 다른 사용자의 회사에 접근할 수 없다. 하위 업무는 회사 ID와 Account를
동시에 검사하며, 연결 티켓·캠페인도 같은 Account에 있어야 한다.

`business.manage`는 기본 admin 권한이다. 다른 사용자에게 명시적으로 부여할 수 있으며
회사·운영 데이터·서버 커넥터를 관리한다. 마케팅을 조회·연결하려면 별도의 기존 마케팅 권한이 필요하다.
새 티켓 생성은 `tickets.create` 권한도 필요하다. 선행 조건을 마친 미완료 업무에서 만들 수 있으며,
저장된 회사·업무·메모·기한을 가져와 **Backlog, 에이전트 미지정**으로 생성한다. 화면은 해당 업무 상세에 머물며,
실행 설정은 보조 메뉴의 실행 티켓 열기에서 진행한다.
담당 에이전트와 실행 상태는 기존 티켓 화면에서 지정한다. 업무의 담당자 이름을 RuntimeSpec으로
해석하지 않으며, 티켓 실행 상태와 회사의 선행 조건을 자동 동기화하지 않는다.
새 키 등록은 기존 `admin.credentials` 권한을 검사한다. 키 선택 API는 해당 Account의 서버 전용
credential 이름·ID·provider만 반환한다.

커넥터 키는 기존 Credential 암호화를 사용하며 회사 테이블에 비밀을 저장하지 않는다. Global 키,
다른 Account 키, 다른 provider 키, `agent_env` 키는 연결할 수 없다. 연결 또는 설립 기록이 참조하는 credential의 삭제,
다른 Account로 이동 및 에이전트 노출도 기존 credential 관리 경로에서 거부한다. 연결 해제는
credential을 삭제하지 않는다. 조회 시에도 유효 소유권·provider·agent_env를 다시 확인한다.

## 상태와 동시성

### 업무 하나에서 과정·결과·수정 이어가기

업무 제목이나 **과정·결과 보기**를 누르면 `/business/operations?company=<id>&stage=<stage>&task=<id>`의
업무 상세를 연다. 편집 창이나 일반 티켓 목록이 기본 작업 화면이 아니다. 새로고침·공유·뒤로 가기에도
같은 회사와 업무를 가리킨다. 상단의 최신 결과와 최근 결정, 남은 추가·수정 요청, 아래의 진행 과정과
변경 내역을 한 화면에서 본다. 설립 업무에는 이 회사의 설립 신청도 표시하고 해당 신청의 검토·제출·서명을
기존 확인 절차로 이어갈 수 있다. 회사의 신청 상태를 개별 업무의 완료 결과로 간주하지 않는다.

- 결과와 결정은 새 기록으로 추가한다. 이전 결과를 덮어쓰지 않는다. 업무 정보 편집도 변경 전후를 같은
  트랜잭션에 보존한다. 기존 업무의 메모는 그대로 읽을 수 있고, 과거에 저장되지 않은 변경 내역을 꾸미지 않는다.
- 추가·수정 요청은 같은 업무에 남긴다. 처리 내용은 원래 요청의 `resolves_entry_id`에 연결한 `resolution`으로
  기록하며, 처리된 요청은 대기 목록에서 빠지고 과거 기록에 남는다. 완료한 업무에도 후속 요청을 남길 수 있다.
  이 기록 자체가 에이전트 실행·외부 신청·비용 승인을 뜻하지 않는다.
- 연결 티켓의 댓글·첨부는 기존 티켓 API로 읽어 같은 시간순 목록에 표시한다. 에이전트 답변을 검토해
  **이 답변으로 결과 정리**로 업무 결과에 남길 수 있다. **연결 티켓에 댓글 보내기**는 기존 티켓 댓글 경로를
  사용하며 실행 중인 담당 에이전트만 기존 dispatch 규칙으로 이어간다. 완료·검토 상태를 자동으로 재실행하지 않는다.
- 업무 기록과 티켓 댓글은 50개씩 이전 기록을 더 읽을 수 있다. 결과·결정·미처리 요청 요약은 페이지와 무관하게
  전체 기록에서 계산한다. 열린 화면은 15초마다 새 기록을 읽고, 편집·저장 중에는 주기 조회를 멈춘다.
- `get_business_task`로 기록과 남은 요청을 읽고 `add_business_task_entry`로 추가한다. 결과에는 산출물 링크와
  확인 근거를 포함한다. 생성한 실행 티켓의 설명에도 회사·업무 ID와 이 절차를 넣는다. MCP 읽기/쓰기는 기존
  Business 소유권·권한 계약을 따른다. 새로운 티켓은 명시적인 생성 동작에서만 만든다.
- 추가 기록은 `request_id` UUID로 동일 요청 재시도를 구분한다. 같은 ID의 다른 내용은 거부한다. 회사 revision을
  선점해 기록 순서와 요청 처리 중복을 검사한다. 기록이 있는 업무의 삭제는 거부하며 기존 기록을 보존한다.

### 업무와 연결 상태

- 업무 상태: `todo`, `in_progress`, `waiting`, `done`. `waiting`은 외부 심사·응답 등을 기다린다는
  사람의 기록이다. `blocked_by`는 선행 업무에서 계산하며 별도로 저장하지 않는다.
- 진행 시작과 완료에는 모든 선행 업무 완료가 필요하다. 순환 연결과 다른 회사의 선행 업무는
  거부한다. 진행/완료된 후속 업무가 있는 선행 업무를 미완료로 되돌릴 수도 없다.
- 회사 설정·업무·커넥터 설정 수정은 화면이 읽은 `revision`으로 회사 행을 조건부 갱신한 뒤
  한 트랜잭션에서 처리한다. 충돌은 409이며 일부만 쓰지 않는다. SQLite와 PostgreSQL 모두 같은 경로다.
- 업무에서 티켓을 만들 때도 `TicketService.create`를 사용한다. 생성·활동 기록·업무 연결을 같은
  트랜잭션에 넣어 충돌이나 저장 오류 시 함께 되돌린다. 이미 연결된 업무의 재요청은 기존 티켓을
  반환한다. 티켓 변경 이벤트는 커밋 이후에 발생하며 생성으로 에이전트를 바로 실행하지 않는다.
- 커넥터는 `configured → syncing → connected | error`. 설정 저장만으로 연결됐다고 표시하지 않는다.
- API 조회 전 연결 revision으로 단일 실행을 claim한다. 네트워크는 DB 트랜잭션 밖에서 호출한다.
  완료 시 같은 revision에만 응답을 반영하므로 연결 변경·해제 뒤 옛 데이터가 덮어쓰이지 않는다.
- 연속 조회는 10초, 진행 중 조회는 60초 동안 중복을 막는다. 프로세스가 끊겨 `syncing`으로 남으면
  60초 후 사용자가 다시 조회할 수 있다. 외부 변경을 실행하지 않으므로 조회 재시도는 지출을 발생시키지 않는다.
- 조회 실패 시 이전 성공 스냅샷과 기준 시각을 유지하고 오래된 데이터라는 표시를 붙인다.
  공급자 오류 본문·헤더·키를 응답이나 활동 이력에 복사하지 않는다.
- 일반 운영 조회는 GET 전용이며, 설립은 `FormationConnector`, 변호사 메일은 `BusinessEmailConnector`의 별도 POST를 사용한다. 공급자가 정한 HTTPS 주소만 사용하며 redirect 거부, 요청 제한 시간 15초, 응답 최대 2 MB를 적용한다.

## 커넥터 추가

1. `apps/server/src/modules/business/connectors/`에 `BusinessConnector` 어댑터를 추가한다.
   `descriptor`에 영역, 환경, 키 종류, 외부 ID 필드, 조회 기능, 문서·서비스 링크를 선언한다.
2. `service-offerings.ts`에 가격·기능·API 조건·공식 출처를 추가하고 `registry.ts`에 등록한다. 화면은 같은 descriptor로 카탈로그와 설정 폼을 렌더한다.
3. 새 키 종류라면 `common/credential-providers.ts`에 provider와 비밀 필드를 추가한다.
4. `sync(context)`에서 명시된 공식 API만 호출하고 `ConnectorSnapshot`으로 필요한 값만 변환한다.
   계정 정보가 응답에 없으면 성공 수치 0을 만들어 내지 말고 실패시킨다. 페이지 제한·기간·단위는 note에 표시한다.
5. 인증·환경·응답 매핑 테스트를 추가한다. 사용자 지정 URL이 필요해지면 기존 SSRF 가드와
   DNS/redirect 방어를 함께 도입한다. 현재는 임의 origin·헤더를 입력받지 않는다. CS subdomain은 공급자의 고정 도메인 안에서만 선택한다.

설립 어댑터는 `FormationConnector`와 `BusinessFormationService`, 변호사 메일은 `BusinessEmailConnector`와 `BusinessTrademarkService`의 검토/실행 경로를 사용한다. 쓰기 커넥터를 확장할 때는 조회 함수에 POST를 끼워 넣지 않는다. 승인 대상 payload 고정,
idempotency, 실행 claim, 모호한 결과 대조 및 감사 기록을 별도 계약으로 먼저 설계해야 한다.
상표 확장은 `TrademarkConnector`와 `trademark-registry.ts`, `BusinessTrademarkIntegrationsService`를 사용한다. OAuth·수집·발송·웹훅·문서 메서드는 기능별로 선언하며 카드·설정 폼은 공통으로 렌더한다. 상세 계약과 설정은 [상표 연동 문서](trademarks.md#연동-저장소와-확장-계약)를 따른다.
기존 마케팅 결제/외부 발신의 승인 경로도 유지한다.

## 검증

- `npm run build`
- 서버: `node --test --test-force-exit test/business-http.test.mjs test/business-connectors.test.mjs test/business-formation.test.mjs test/business-trademark.test.mjs test/business-trademark-integrations.test.mjs`
- 클라이언트: `node --import tsx --test --test-force-exit test/business-page.test.mjs`
- 브라우저: 루트에서 `npm run test:e2e:business -w client` (서버 dist가 먼저 필요)

HTTP 회귀는 임시 DB에서 소유권·권한·선행 조건·동시 수정·키 보호와 조회 중 연결 변경을 검증한다.
설립은 초안 암호화·이관·명시적 확인·키 변경·가격 변경·동시 제출·모호한 결과와 같은 키 재시도·원문 삭제·HTTP 로그 제외를 검증한다. 브라우저는 비교표와 신청→검토→제출→서명 링크를 1440/390/320px에서 확인한다.
티켓 생성은 중복 요청, 링크 저장 실패 시 티켓·활동의 롤백, 커밋 이후 이벤트 발생도 확인한다.
어댑터·브라우저 테스트는 명시적인 공급자 응답 fixture를 사용한다. 실제 공급자 sandbox/운영 키를
이용한 승인·호출 검증을 대체하지 않는다.
