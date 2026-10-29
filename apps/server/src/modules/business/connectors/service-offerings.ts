import type { BusinessStage, ConnectorDescriptor, ServiceOffering } from '../business.types';

// Retail list prices, not a quote for partner API usage. Keep price units and exclusions explicit.
// doola · Northwest were re-checked on 2026-10-29 (Northwest via archived pages; its site blocks automated reads).
const checked = '2026-10-23';
const price = (url: string, extra: string, plans: ServiceOffering['pricing']['plans'], checkedAt = checked): ServiceOffering['pricing'] => ({ url, extra, plans, checked_at: checkedAt });
const plan = (id: string, name: string, price: string, detail: string) => ({ id, name, price, detail });
export const SERVICE_OFFERINGS: Record<string, ServiceOffering> = {
  uspto: {
    best_for: '공식 미국 상표 검색·출원·사건 확인', features: ['Trademark Search · ID Manual', 'Trademark Center 온라인 출원', 'TSDR 사건·문서 조회'],
    api_access: 'public', api_note: 'TSDR은 키 기반 상태·문서 조회 API입니다. 공개 출원 제출 API는 확인하지 못했습니다. AWB 상표별 커넥터에서 TSDR 상태·문서를 자동 수집하며 공식 출원은 Trademark Center 또는 대리인에게 진행합니다.', external_steps: ['계정 인증 · 본인 서명 · 접수', '해외 본점 출원인은 미국 변호사 대리', '심사 대응 · 사용증명 · 유지 신고'],
    pricing: price('https://www.uspto.gov/trademarks/trademark-fee-information', 'Section 1/44 기본 요건 충족 기준. 정보 누락 $100/류, 자유기재 $200/류 등 추가료 가능. 사용증명 $150/류, 연장 $125/류 별도. 변호사 비용 별도이며 Madrid 수수료는 다릅니다.', [plan('base', '미국 기본 출원', '$350 / 상품·서비스류', '관납료 · 심사 결과나 등록을 보장하지 않음')]),
  },
  legalzoom_trademark: {
    best_for: '검색·변호사 검토·출원 대행을 묶어서 진행', features: ['연방 · common-law 검색', '변호사 상품류 선정 · 제출', '일부 절차적 Office Action 대응'],
    api_access: 'unverified', api_note: '공개 상표 출원 API는 확인되지 않았습니다. 온라인 신청 후 담당 변호사와 진행합니다.', external_steps: ['범위 · 견적 · 수임계약 확인', '본인 서명 · 추가 자료 제출', '실체적 거절 대응 비용 별도 확인'],
    pricing: price('https://www.legalzoom.com/business/intellectual-property/trademark-registration-overview.html', '관납료 별도. 모니터링은 3개월 후 $249/년 자동 갱신 조건을 확인하세요. 포함되는 보정 대응과 추가 법률 비용을 계약에서 확인하세요.', [plan('premium', 'Premium Trademark', '$899 + 관납료', '변호사 지원 출원 패키지')]),
  },
  trademarkia: {
    best_for: '변호사 출원 지원과 국제 상표 상담', features: ['담당 변호사 · 사전 상담', '검색 · 모니터링 옵션', '국제 상표 지원'],
    api_access: 'partner', api_note: '개발자용 데이터 API 제휴를 안내합니다. 이것이 출원 제출 API를 뜻하지는 않으며 제출 API 계약은 확인이 필요합니다.', external_steps: ['온라인 신청 · 변호사 수임', '계약 · 서명', '관할·상품류별 범위 확인'],
    pricing: price('https://www.trademarkia.com/', '관납료 별도. 상품류별 요금과 추가 법률업무는 견적 확인. Entry 모니터링 1개월/Premium 1년 이후 $99/분기 조건을 확인하세요.', [plan('entry', 'Entry', '$499 + 관납료', '기본 변호사 지원'), plan('standard', 'Standard', '$599 + 관납료', '확장 법률 지원'), plan('premium', 'Premium', '$699 + 관납료', '확장 검색 · 모니터링')]),
  },
  trademark_engine: {
    best_for: '온라인 자료 입력과 변호사 검토 출원', features: ['온라인 신청 정보 수집', '미국 변호사 검토', 'Standard 전담 변호사 · 상담'],
    api_access: 'unverified', api_note: '공개 출원 API는 확인되지 않았습니다. 법률서비스는 Swyft Legal의 수임 범위와 해외 출원인 지원 여부를 확인하세요.', external_steps: ['관납료 · 플랫폼 비용 확인', '수임 범위 · 본인 서명', '담당 법률팀과 접수 확인'],
    pricing: price('https://www.trademarkengine.com/trademark-registration/', '공식 페이지의 applicable fees에는 $350/류 관납료 외 $100 서비스·플랫폼 비용이 포함됩니다. 기본 표시가만으로 총액을 판단하지 마세요.', [plan('basic', 'Basic', '$49 + 적용 수수료', '표시 시작가 · 추가 비용 별도'), plan('standard', 'Standard', '$299 + 적용 수수료', '전담 변호사 · 15분 상담')]),
  },
  doola: {
    best_for: '설립부터 미국 세금 신고까지 한 서비스로 운영', features: ['LLC · C-Corp 설립 (1–2 영업일 접수)', 'EIN · 등록 대리인 · 미국 주소 · 운영 계약서', '세무 · 장부 · 연차 보고 옵션'],
    api_access: 'mcp', api_note: 'doola MCP(mcp.doola.com)를 doola 고객 계정 OAuth로 사용합니다. 별도 계약·API 키·MCP 이용료는 안내되지 않았습니다. 화이트라벨 Formation API는 운영 사용에 파트너 계약이 필요해 AWB는 사용하지 않습니다. MCP 접수 주는 공식 안내가 엇갈려(WY 전용 vs 50개 주) 진행 시 확인하세요.',
    external_steps: ['Stripe 결제 링크에서 소유자가 결제', '본인 서명 · 추가 서류', '대시보드에서 서류 · EIN · 계좌 후속 확인'],
    pricing: price('https://www.doola.com/pricing/', '모든 플랜 연간 청구, 주정부 수수료 별도(doola가 대신 납부). Starter에는 연차 보고 대행이 없습니다. 장부 Pulse $300/년 별도. ITIN·등록 대리인 단독 갱신가는 공개 가격표에서 확인하지 못했습니다.', [plan('starter', 'Starter', '$297 / 년', '설립 · EIN · 등록 대리인 · 미국 주소 · 운영 계약서'), plan('tax', 'Tax & Compliance', '$1,999 / 년', '연방·주 세금 신고 · 연차 보고 · 세무 상담'), plan('box', 'Business-in-a-Box', '$2,999 / 년', '월 $329 선택 가능 · 전담 장부 · 분기 예상세 포함')], '2026-10-29'),
  },
  northwest: {
    best_for: '저렴한 설립과 장기 등록 대리인 · 개인정보 보호', features: ['50개 주 + DC 설립', '등록 대리인 · 우편 스캔 · Northwest 주소로 개인정보 보호', 'EIN(SSN 없이 가능) · 연차 보고 · 도메인/메일/전화 옵션'],
    api_access: 'mcp', api_note: 'Northwest MCP(mcp.northwestregisteredagent.com)를 Northwest 고객 계정 로그인으로 사용합니다. 별도 계약·MCP 이용료는 안내되지 않았습니다. 2026-10-30부터 공용 로그인 클라이언트가 Claude·ChatGPT·Cursor 주소만 허용하므로, AWB에서 로그인하려면 Northwest가 발급한 OAuth 클라이언트를 관리자 설정에 넣어야 합니다. 체크아웃·청구서 결제는 계정에 저장된 결제수단으로 청구되므로 AWB는 대신 실행하지 않습니다.',
    external_steps: ['Northwest 화면에서 장바구니 결제 · 결제수단 관리', '본인 서명', '연차 보고 · 갱신 확인'],
    pricing: price('https://www.northwestregisteredagent.com/registered-agent', '주정부 수수료 별도(WY $100, DE $110 기준). 등록 대리인 갱신은 1–4개 주 $125/년·주, 5개 주 이상 $100/년·주. 일반 우편 5건 무료 전달 후 $15/건. EIN·운영 계약서·급행·가상 사무실은 별도이며 LLC 상위 패키지 가격은 공식 페이지에서 직접 확인하세요(웹 보관본 2026-10 기준 확인).', [plan('formation', '설립', '$39 + 주정부 수수료', 'LLC · Corporation 신고 + 1년 등록 대리인 포함'), plan('agent', 'Registered Agent', '$125 / 년·주', '등록 대리인 갱신 · 우편 스캔 포함')], '2026-10-29'),
  },
  atlas: {
    best_for: 'Delaware 창업과 Stripe 결제 생태계', features: ['Delaware LLC · C-Corp', 'EIN', '설립 문서 · 등록 대리인'],
    api_access: 'unverified', api_note: '공개 설립 API는 확인되지 않았습니다. Stripe 결제 API와 Atlas 설립 절차는 별개입니다.', external_steps: ['신청 · 비용 결제', '서명 · 설립 진행 확인'],
    pricing: price('https://stripe.com/atlas', '주정부 설립 수수료와 첫해 등록 대리인 포함. 이후 주정부 세금·신고 비용 별도. 갱신료는 공식 가격표에서 확인하세요.', [plan('atlas', 'Atlas', '$500 / 1회', 'Delaware 설립 패키지')]),
  },
  firstbase: {
    best_for: '설립·주소·회계 옵션을 조합하는 해외 창업자', features: ['Delaware · Wyoming 설립', 'EIN · 법률 문서', '주소 · 세무 · 장부 옵션'],
    api_access: 'unverified', api_note: '공개 설립 API 계약은 확인되지 않았습니다. 제휴·임베딩 조건은 공급자에게 문의하세요.', external_steps: ['설립 신청 · 결제 · 서명', '진행 상태 확인'],
    pricing: price('https://www.firstbase.io/pricing', '주정부 수수료 별도. 할인 전 Start 기준. 등록 대리인·주소·세무는 선택한 상품의 포함 범위를 확인하세요.', [plan('start', 'Start', '$399 / 1회', '설립 패키지 정가 · 프로모션 별도'), plan('agent', 'Agent', '$299 / 년·주', '등록 대리인 단독 서비스')]),
  },
  clemta: {
    best_for: '설립·주소·청구·장부 기능을 함께 사용', features: ['미국 법인 설립 · EIN', '등록 대리인 · 주소', '장부 · 청구 · 세무 옵션'],
    api_access: 'unverified', api_note: '화이트라벨 제휴는 제공하지만 AWB용 설립 REST 계약은 확인되지 않았습니다.', external_steps: ['가입 · 설립 신청 · 서명', '세무 서비스 설정'],
    pricing: price('https://clemta.com/pricing', '연간 선결제 금액. 주정부 수수료 별도. 세무·연차 신고 포함 범위는 플랜별로 다릅니다.', [plan('essentials', 'Essentials', '$349 / 년', '설립 · 주소 · 장부 도구'), plan('pro', 'Pro', '$1,068 / 년', '연간 세무 · 주정부 보고 포함 상품')]),
  },
  legalzoom: {
    best_for: '법률 문서와 전문가 서비스까지 선택', features: ['LLC 설립', '법률 문서 옵션', '등록 대리인 · EIN 옵션'],
    api_access: 'unverified', api_note: '일반 고객용 공개 설립 API는 확인되지 않았습니다.', external_steps: ['신청 · 결제 · 서명', '주정부 제출 결과 확인'],
    pricing: price('https://www.legalzoom.com/business/business-formation/llc-overview.html', '주정부 수수료 별도. EIN·등록 대리인·추가 법률 서비스는 상품별 별도 비용입니다.', [plan('basic', 'Basic LLC', '$0 + 주정부 수수료', '기본 설립 제출 서비스')]),
  },
  zenbusiness: {
    best_for: '낮은 초기 비용으로 LLC를 시작', features: ['LLC 설립', '컴플라이언스 옵션', 'EIN · 웹사이트 옵션'],
    api_access: 'unverified', api_note: '일반 고객용 공개 설립 API는 확인되지 않았습니다.', external_steps: ['신청 · 결제 · 서명', '설립 진행 확인'],
    pricing: price('https://www.zenbusiness.com/pricing-products/', '주정부 수수료 별도. 무료 시작과 유료 구독·자동 갱신 옵션을 구분해 확인하세요.', [plan('starter', 'Starter', '$0 + 주정부 수수료', '기본 LLC 설립')]),
  },
  corpnet: {
    best_for: '다수 고객의 설립·고용주 등록을 다루는 플랫폼', features: ['50개 주 설립', '고용주 세금 등록', '컴플라이언스 · 화이트라벨 API'],
    api_access: 'partner', api_note: '파트너 REST API 제공. 계약·키 발급 후 어댑터 추가가 필요하며 현재 AWB는 외부 진행을 지원합니다.', external_steps: ['파트너 상담 · 계약', '설립 신청 · 진행 확인'],
    pricing: price('https://www.corpnet.com/corpnet-api/', '파트너 계약과 주정부·업무별 수수료에 따라 달라집니다.', [plan('partner', 'API 파트너', '별도 견적', '설립 · 세금 등록 · 컴플라이언스')]),
  },
  mercury: {
    best_for: '미국 회사의 은행 업무와 입출금 조회', features: ['미국 비즈니스 계좌', '송금 · 카드 · Bill Pay', '계좌 · 거래 API'],
    api_access: 'public', api_note: '계좌 승인 후 API 토큰 발급. 계좌 개설과 심사는 Mercury에서 진행합니다.', external_steps: ['계좌 개설 · 신원 확인 · 심사', '송금 실행 · 승인'],
    pricing: price('https://mercury.com/pricing', '추가 재무 도구·국제송금·환전 등은 상품과 사용량에 따라 별도 비용입니다.', [plan('base', '기본 Banking', '$0 / 월', '기본 계좌 서비스')]),
  },
  relay: {
    best_for: '다중 계좌로 현금 흐름과 팀 지출을 분리', features: ['다중 비즈니스 계좌', 'Bill Pay · 지출 관리', '회계 연동'],
    api_access: 'unverified', api_note: 'AWB에서 사용할 공개 계좌 API 계약은 확인되지 않았습니다. 현재 외부 서비스로 연결합니다.', external_steps: ['계좌 신청 · 심사', '입출금 · 계좌 현황 관리'],
    pricing: price('https://relayfi.com/pricing/', '송금·환전 등 거래 수수료 별도. Scale은 할인 전 정가입니다.', [plan('starter', 'Starter', '$0 / 월', '기본 계좌 · 지출 관리'), plan('grow', 'Grow', '$30 / 월', '승인 · 장부 자동화'), plan('scale', 'Scale', '$120 / 월', '확장 계좌 · 우대 거래 요금')]),
  },
  brex: {
    best_for: '카드·팀 지출·청구서 승인을 통합', features: ['법인 카드 · 비즈니스 계좌', '지출 · 출장 · Bill Pay', '공개 API'],
    api_access: 'public', api_note: '계좌·지출 API 제공. 현재 AWB 어댑터는 외부 진행용입니다.', external_steps: ['계정 신청 · 심사', '계좌 · 지출 관리'],
    pricing: price('https://www.brex.com/pricing', '카드·계좌 자격 심사 별도. Enterprise는 견적 방식입니다.', [plan('essentials', 'Essentials', '$0 / 사용자·월', '기본 지출 관리'), plan('premium', 'Premium', '$12 / 사용자·월', '정책 · 승인 자동화')]),
  },
  wise: {
    best_for: '다중 통화 수취와 해외 송금', features: ['다중 통화 잔액', '국제 송금 · 환전', 'Business API'],
    api_access: 'public', api_note: 'API 접근 범위는 지역·계정·제휴 유형에 따라 다릅니다. 현재 AWB는 외부 진행을 지원합니다.', external_steps: ['계정 인증', '송금 · 환전 · 현황 확인'],
    pricing: price('https://wise.com/us/pricing/business', '미국 Business 기준. 송금·환전·수취 수수료는 통화와 경로에 따라 별도 계산됩니다.', [plan('business', 'US Business', '$31 / 초기 설정', '전체 Business 기능 설정료')]),
  },
  stripe: {
    best_for: '온라인 결제와 구독·청구 자동화', features: ['결제 · Checkout', '구독 · 청구 옵션', 'Tax · Connect 옵션'],
    api_access: 'public', api_note: '공개 API. AWB는 잔액·거래를 조회하며 결제·환불 생성은 Stripe에서 진행합니다.', external_steps: ['사업자 인증 · 결제 설정', '환불 · 정산 설정'],
    pricing: price('https://stripe.com/us/pricing', '미국 온라인 국내 카드 기준. 해외 카드·환전·Billing·Tax 등 별도 요금.', [plan('standard', 'Standard', '2.9% + $0.30 / 결제', '성공한 온라인 국내 카드 결제')]),
  },
  paypal: {
    best_for: 'PayPal 지갑을 사용하는 고객에게 결제 제공', features: ['PayPal Checkout', '청구 · 구독', '결제 API'],
    api_access: 'public', api_note: 'REST API 제공. 현재 AWB는 외부 결제 관리 화면으로 연결합니다.', external_steps: ['사업자 인증', '결제 · 환불 · 정산 관리'],
    pricing: price('https://www.paypal.com/us/business/paypal-business-fees', '미국 국내 PayPal Checkout 기준. 고정 수수료는 수취 통화별로 다르며 해외·환전 비용 별도.', [plan('checkout', 'PayPal Checkout', '3.49% + 통화별 고정 수수료', '다른 결제 수단은 요율이 다릅니다')]),
  },
  paddle: {
    best_for: 'SaaS 판매의 결제·간접세 처리를 맡기기', features: ['Merchant of Record', '구독 · 청구', '판매세 · VAT 처리'],
    api_access: 'public', api_note: 'Billing API·웹훅 제공. 현재 AWB는 외부 운영 화면으로 연결합니다.', external_steps: ['판매자 · 상품 심사', '구독 · 환불 관리'],
    pricing: price('https://www.paddle.com/pricing', '일반 종량 요금 기준. 저가 상품·대량 거래 별도 상담. 회사 소득세·연차 신고는 포함하지 않습니다.', [plan('payg', 'Pay as you go', '5% + $0.50 / 거래', '결제 · 구독 · 판매 관련 세무')]),
  },
  xero: {
    best_for: '은행 연동·장부·회계사 협업', features: ['청구 · 매입 · 은행 대사', '재무 보고', '회계 API'],
    api_access: 'public', api_note: 'OAuth 접근 토큰과 tenant ID 필요. 현재 AWB는 기존 토큰을 사용하며 갱신은 별도입니다.', external_steps: ['OAuth 동의 · 토큰 갱신', '분개 · 대사 · 세금 신고'],
    pricing: price('https://www.xero.com/us/pricing-plans/', '미국 정가 기준. 할인 제외. 결제 처리·급여·추가 앱 비용 별도.', [plan('early', 'Early', '$27 / 월', '청구서·매입 건수 제한'), plan('growing', 'Growing', '$59 / 월', '성장 기업의 장부 관리'), plan('established', 'Established', '$97 / 월', '다중 통화 등 확장 기능')]),
  },
  quickbooks: {
    best_for: '미국 장부·청구와 회계사 협업', features: ['장부 · 청구 · 은행 대사', '재무 보고', 'QuickBooks Online API'],
    api_access: 'public', api_note: 'OAuth 접근 토큰과 realm ID 필요. 현재 기존 토큰 입력 방식이며 자동 갱신은 지원하지 않습니다.', external_steps: ['OAuth 동의 · 토큰 갱신', '분개 · 대사 · 세무 처리'],
    pricing: price('https://quickbooks.intuit.com/pricing/', '미국 Simple Start 정가 기준, 초기 할인 제외. 급여·결제·세금 신고 비용 별도. Free 플랜의 API 이용 가능 여부는 별도 확인하세요.', [plan('simple', 'Simple Start', '$38 / 월', '1인 장부 · 청구 · 회계사 협업')]),
  },
  chatwoot: {
    best_for: '오픈소스 기반의 통합 고객지원', features: ['통합 상담함 · 웹 채팅', '다중 채널 · 자동화', 'Cloud API · 셀프호스팅'],
    api_access: 'public', api_note: '현재 AWB는 Chatwoot Cloud 계정의 상담 수·채널을 조회합니다.', external_steps: ['상담 채널 설치 · 연결', '고객 응답 · 자동화 설정'],
    pricing: price('https://www.chatwoot.com/pricing', 'Cloud 가격. 무료 플랜은 최대 2명·웹 채팅 등 제한. 셀프호스팅 운영비와 별도 라이선스는 별개입니다.', [plan('hacker', 'Hacker', '$0 / 상담원·월', '제한된 무료 Cloud'), plan('startups', 'Startups', '$19 / 상담원·월', '팀 고객지원'), plan('business', 'Business', '$39 / 상담원·월', '확장 운영 기능')]),
  },
  intercom: {
    best_for: '제품 내 메신저와 AI 고객지원', features: ['메신저 · 통합 상담함', '헬프센터 · 워크플로', 'Fin AI 옵션'],
    api_access: 'public', api_note: 'Private app 접근 토큰 필요. 미국 리전 조회를 지원하며 상담 본문은 저장하지 않습니다.', external_steps: ['앱·메신저 설치', '답변 · Fin · 워크플로 설정'],
    pricing: price('https://www.intercom.com/pricing', '연간 결제 기준 월 환산 정가. Fin은 결과당 $0.99부터 별도, 프로모션 제외.', [plan('essential', 'Essential', '$29 / 좌석·월', '상담함 · 메신저'), plan('advanced', 'Advanced', '$85 / 좌석·월', '자동화 · 다중 상담함'), plan('expert', 'Expert', '$132 / 좌석·월', '확장 관리 · 지원')]),
  },
  zendesk: {
    best_for: '규모 있는 티켓·옴니채널 CS 조직', features: ['티켓 · 자동화 · 보고', '헬프센터 · 다중 채널 옵션', '공개 Support API'],
    api_access: 'public', api_note: 'OAuth 토큰과 Zendesk subdomain 필요. 최근 티켓 목록의 상태만 조회합니다.', external_steps: ['채널 · 라우팅 설정', '고객 답변 · SLA 운영'],
    pricing: price('https://www.zendesk.com/pricing/', '연간 결제 기준 월 환산. AI·음성 등 추가 기능 요금 별도.', [plan('support', 'Support Team', '$19 / 상담원·월', '기본 티켓 지원'), plan('suite', 'Suite Team', '$55 / 상담원·월', '다중 채널 · 헬프센터')]),
  },
  freshdesk: {
    best_for: '이메일 티켓과 고객지원 자동화', features: ['공유 상담함 · 티켓', '헬프센터 · SLA', '자동화 · 공개 API'],
    api_access: 'public', api_note: 'Freshdesk API 키와 subdomain 필요. 최근 티켓 상태를 조회하며 고객 본문은 저장하지 않습니다.', external_steps: ['이메일 · 채널 연결', '고객 답변 · 자동화 운영'],
    pricing: price('https://www.freshworks.com/freshdesk/pricing/', '연간 결제 기준 월 환산. AI와 사용량 기반 기능은 추가 요금.', [plan('growth', 'Growth', '$19 / 상담원·월', '기본 고객지원'), plan('pro', 'Pro', '$55 / 상담원·월', '확장 자동화'), plan('enterprise', 'Enterprise', '$89 / 상담원·월', '기업 관리 기능')]),
  },
};

const handoff = (id: string, name: string, stage: BusinessStage, color: string, portal: string, docs: string): { descriptor: ConnectorDescriptor } => ({ descriptor: {
  id, name, stage, color, monogram: name.slice(0, 1), mode: 'handoff', summary: SERVICE_OFFERINGS[id].best_for,
  capabilities: ['외부 서비스 열기', '업무 · 결과 기록'], setup_note: SERVICE_OFFERINGS[id].api_note,
  docs_url: docs, portal_url: portal, fields: [], secret_fields: [], environments: [],
} });
export const HANDOFF_CONNECTORS = [
  handoff('uspto', 'USPTO', 'trademark', '#93c5fd', 'https://trademarkcenter.uspto.gov/', 'https://www.uspto.gov/trademarks/apply/check-status-view-documents/trademark-bulk-data'),
  handoff('legalzoom_trademark', 'LegalZoom Trademark', 'trademark', '#a5b4fc', 'https://www.legalzoom.com/business/intellectual-property/trademark-registration-overview.html', 'https://www.legalzoom.com/business/intellectual-property/trademark-registration-overview.html'),
  handoff('trademarkia', 'Trademarkia', 'trademark', '#f9a8d4', 'https://www.trademarkia.com/', 'https://www.trademarkia.com/faqs/about-trademarkia/how-do-i-contact-trademarkia-for-business-development-opportunities'),
  handoff('trademark_engine', 'Trademark Engine', 'trademark', '#fcd34d', 'https://www.trademarkengine.com/trademark-registration/', 'https://www.trademarkengine.com/trademark-registration/'),
  handoff('atlas', 'Stripe Atlas', 'formation', '#c7d2fe', 'https://dashboard.stripe.com/atlas', 'https://docs.stripe.com/atlas'),
  handoff('firstbase', 'Firstbase', 'formation', '#93c5fd', 'https://www.firstbase.io', 'https://www.firstbase.io/pricing'),
  handoff('clemta', 'Clemta', 'formation', '#c4b5fd', 'https://clemta.com', 'https://clemta.com/pricing'),
  handoff('legalzoom', 'LegalZoom', 'formation', '#93c5fd', 'https://www.legalzoom.com', 'https://www.legalzoom.com/business/business-formation/llc-overview.html'),
  handoff('zenbusiness', 'ZenBusiness', 'formation', '#f9a8d4', 'https://www.zenbusiness.com', 'https://www.zenbusiness.com/pricing-products/'),
  handoff('corpnet', 'CorpNet', 'formation', '#fdba74', 'https://www.corpnet.com/corpnet-api/', 'https://apidocs.corpnet.com/docs/getting-started'),
  handoff('relay', 'Relay', 'banking', '#86efac', 'https://relayfi.com', 'https://relayfi.com/pricing/'),
  handoff('brex', 'Brex', 'banking', '#fdba74', 'https://www.brex.com', 'https://developer.brex.com'),
  handoff('wise', 'Wise Business', 'banking', '#bef264', 'https://wise.com/business/', 'https://docs.wise.com'),
  handoff('paypal', 'PayPal', 'payments', '#93c5fd', 'https://www.paypal.com/businessmanage/', 'https://developer.paypal.com/api/rest/'),
  handoff('paddle', 'Paddle', 'payments', '#fde047', 'https://vendors.paddle.com', 'https://developer.paddle.com'),
];
