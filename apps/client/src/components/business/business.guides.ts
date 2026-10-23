import type { BusinessStage } from '../../business.types';

interface BusinessGuide {
  prepare: string[];
  execute: string[];
  track: string[];
  completed: string;
  connectionNote: string;
  sources: Array<{ label: string; url: string }>;
}

// Product guidance, separate from editable tasks. Existing companies also see updates.
// Provider instructions verified against the linked official guides on 2026-10-23.
export const BUSINESS_GUIDES: Record<BusinessStage, BusinessGuide> = {
  formation: {
    prepare: ['회사 이름, 사업 내용, 소유자 정보를 정리합니다.', '설립 주와 LLC / C-Corp 형태, 필요한 서비스를 확인합니다.'],
    execute: ['커넥터에서 설립 서비스를 비교합니다. doola 파트너 키가 있으면 AWB의 설립 신청에서 1인 LLC(WY·DE)를 입력·검토·제출할 수 있습니다.', '다른 서비스는 외부 신청 화면으로 이어집니다. doola 접수 후 서명 링크에서 본인 서명을 하고, 추가 자료·설립 문서·EIN 결과를 확인합니다.'],
    track: ['아래 업무에 담당자와 기한을 지정하고, 심사 중에는 외부 응답 대기로 기록합니다.', 'doola 조회를 연결하거나 서비스에서 확인한 결과를 업무 메모에 남깁니다.'],
    completed: '설립 신청 업무는 주정부 등록 문서와 서명 완료를, EIN 업무는 발급 확인서를 확인한 뒤 각각 완료로 표시하세요.',
    connectionNote: 'doola는 내부 신청 또는 기존 회사 ID 연결을 지원합니다. 파트너 계약 비용은 일반 구독료와 별개이며, 제출 성공은 설립 완료를 뜻하지 않습니다. Atlas·Firstbase·Clemta·LegalZoom·ZenBusiness·CorpNet은 현재 외부 진행과 업무 기록을 지원합니다.',
    sources: [
      { label: 'doola 설립 순서', url: 'https://help.doola.com/what-is-the-overall-process-to-form-a-company-doola-help-center' },
      { label: 'Stripe Atlas 설립 안내', url: 'https://docs.stripe.com/atlas' },
    ],
  },
  banking: {
    prepare: ['설립 문서, EIN 확인서, 대표자·소유자 신분증을 준비합니다.', '사업 내용, 실제 사업 주소, 자금 출처를 정리하고 Mercury 신청 요건을 확인합니다.'],
    execute: ['Mercury에서 계좌를 신청하고 요청된 서류와 추가 질문에 답합니다.', '승인 후 계좌 정보를 확인합니다. 송금과 지급 승인은 Mercury에서 진행합니다.'],
    track: ['계좌 승인 결과를 업무 메모에 기록합니다.', 'Mercury 읽기 전용 키를 커넥터에 연결하고 조회를 누르면 계좌 수와 최근 거래를 확인할 수 있습니다.'],
    completed: '계좌 신청 접수와 승인 결과를 구분하세요. 계좌 승인·이용 가능 상태를 확인한 뒤 계좌 개설 업무를 완료로 표시합니다.',
    connectionNote: 'API 키 연결은 계좌를 개설하거나 송금을 실행하지 않습니다. 현재 조회는 최근 거래 최대 40건이며 전체 잔액·장부 대사는 Mercury와 회계 서비스에서 확인하세요.',
    sources: [
      { label: 'Mercury 신청 요건', url: 'https://support.mercury.com/hc/en-us/articles/28770467511060-Eligibility-and-requirements-for-opening-a-Mercury-account' },
      { label: '준비할 서류', url: 'https://support.mercury.com/hc/en-us/articles/28770957425172-Gathering-your-documents' },
    ],
  },
  payments: {
    prepare: ['판매할 상품·서비스, 사업자 정보와 정산 계좌를 준비합니다.', '고객에게 표시할 사업자 이름, 지원 연락처와 결제 방식을 정합니다.'],
    execute: ['Stripe에서 사업자 인증과 정산 설정을 마치고 결제 수단을 구성합니다.', 'Stripe 테스트 환경에서 결제·실패·환불 흐름을 검증한 뒤 운영 환경을 활성화합니다.'],
    track: ['검증 결과와 정산 확인 사항을 업무 메모에 남깁니다.', '조회 권한을 가진 Stripe 키를 연결해 통화별 잔액과 최근 정산 거래를 확인합니다.'],
    completed: '사업자 인증·정산 설정과 테스트 결제·환불 결과를 각각 확인하세요. 테스트 성공과 실제 운영 계정 활성화는 별도로 확인합니다.',
    connectionNote: '이 커넥터는 결제 화면을 만들거나 결제·환불을 실행하지 않습니다. 테스트 키는 Sandbox, 운영 키는 Live로 연결하고 조회 데이터의 환경을 확인하세요.',
    sources: [
      { label: 'Stripe 계정 활성화', url: 'https://docs.stripe.com/get-started/account/set-up' },
      { label: '테스트 결제 안내', url: 'https://docs.stripe.com/testing' },
    ],
  },
  accounting: {
    prepare: ['은행 거래, 매출·비용 증빙과 기존 장부를 정리합니다.', '회계 담당자와 결산 주기, 회사에 적용되는 신고 일정을 정합니다.'],
    execute: ['Xero 또는 QuickBooks에서 회사 장부와 은행 연결을 설정합니다.', '거래를 분류하고 증빙과 대사한 뒤 결산·신고를 담당자와 진행합니다.'],
    track: ['월별 결산·신고 업무를 추가하고 담당자, 기한, 확인 결과를 기록합니다.', 'Xero의 조직·청구서 또는 QuickBooks Online의 미수 청구서를 연결해 조회합니다.'],
    completed: '결산 업무는 대사·검토 결과를, 신고 업무는 실제 제출 확인을 근거로 완료하세요. 청구서 조회 성공만으로 결산이나 신고가 완료되지는 않습니다.',
    connectionNote: 'Xero는 OAuth access token과 tenant ID, QuickBooks Online은 access token과 realm ID를 사용합니다. 두 서비스 모두 토큰 만료 시 직접 갱신해야 하며 장부 쓰기·신고는 공급자에서 진행합니다.',
    sources: [
      { label: 'Xero 시작하기', url: 'https://central.xero.com/0/article/Start-using-Xero-US' },
      { label: '거래 대사 안내', url: 'https://www.xero.com/us/guides/how-to-do-bank-reconciliation/' },
    ],
  },
  support: {
    prepare: ['지원할 웹사이트·메일 채널과 응대 담당자를 정합니다.', '응답 시간, 문의 분류와 다른 담당자에게 넘기는 기준을 준비합니다.'],
    execute: ['Chatwoot·Intercom·Zendesk·Freshdesk를 비교하고 선택한 서비스에서 채널과 담당자를 설정합니다.', '웹 채팅 위젯 또는 지원 채널을 연결하고 테스트 문의의 수신·답변·종료를 확인합니다.'],
    track: ['선택한 CS 서비스의 키를 연결해 상담·티켓 현황을 조회합니다. Chatwoot은 인박스와 미처리 대화 수를 제공합니다.', '개선할 문제는 아래 업무에서 티켓으로 만들거나 기존 티켓을 연결합니다.'],
    completed: '고객의 테스트 문의가 도착하고 담당자가 답변·종료할 수 있는지 확인한 뒤 인박스 개설 업무를 완료하세요.',
    connectionNote: '채널 생성과 고객 답변은 각 서비스에서 진행합니다. AWB는 제한된 목록의 상태를 조회하며 고객 본문·이메일을 저장하지 않습니다. Chatwoot은 Cloud, Intercom은 미국 리전을 지원합니다.',
    sources: [{ label: 'Chatwoot 첫 인박스와 답변', url: 'https://www.chatwoot.com/hc/user-guide/articles/1677229173-lesson-1-your-first-chatwoot-conversation' }],
  },
  growth: {
    prepare: ['목표 고객, 제품 메시지, 사용할 채널과 예산을 정합니다.', '콘텐츠와 지출을 확인할 담당자, 실행할 에이전트를 지정합니다.'],
    execute: ['AWB 마케팅에서 캠페인을 만들고 채널과 실행 설정을 구성합니다.', '캠페인의 승인함에서 콘텐츠·지출을 검토하고 기존 실행 흐름으로 진행합니다.'],
    track: ['전체 흐름의 회사 정보 · 캠페인 연결에서 이 회사의 캠페인을 선택합니다.', '캠페인의 분석·피드백을 확인하고 다음 실행 업무와 개선 티켓에 반영합니다.'],
    completed: '캠페인의 실제 실행 결과와 수집된 피드백을 확인한 뒤 해당 업무를 완료하세요. 캠페인 연결만으로 실행이 시작되지는 않습니다.',
    connectionNote: '마케팅은 AWB의 기존 캠페인·승인·실행 기능을 사용합니다. 회사 업무의 완료 상태와 캠페인 실행 상태는 별도로 관리합니다.',
    sources: [],
  },
};
