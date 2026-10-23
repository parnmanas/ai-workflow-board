import type { BusinessStage } from './business.types';

// These are operating tasks, not legal determinations. Completion is explicitly recorded by a person.
export const BUSINESS_TEMPLATE: Array<{ key: string; stage: BusinessStage; title: string; description: string; requires: string[] }> = [
  { key: 'formation_plan', stage: 'formation', title: '회사 이름과 설립 계획 정하기', description: '사업 목적, 설립 주, LLC / C-Corp 형태, 소유 구조를 정리하세요.', requires: [] },
  { key: 'formation_file', stage: 'formation', title: '설립 신청 · 서명 · 서류 확인', description: 'doola 또는 Atlas에서 신청하고 주정부 등록 서류를 확인하세요.', requires: ['formation_plan'] },
  { key: 'formation_ein', stage: 'formation', title: 'EIN 발급과 법인 문서 보관', description: 'EIN 발급 확인서와 운영 계약서를 보관하고 필요한 후속 서명을 마치세요.', requires: ['formation_file'] },
  { key: 'bank_open', stage: 'banking', title: '사업자 계좌 신청과 심사', description: 'Mercury에서 법인 정보와 실소유자를 확인하고 계좌 승인을 받으세요.', requires: ['formation_ein'] },
  { key: 'bank_review', stage: 'banking', title: '입출금 확인과 지급 절차 정하기', description: '은행 커넥터를 연결하고 거래 내역, 지출 승인자, 증빙 수집 절차를 확인하세요.', requires: ['bank_open'] },
  { key: 'payments_setup', stage: 'payments', title: '결제 · 정산 계정 연결', description: 'Stripe 계정에서 사업자 인증과 정산 계좌 설정을 완료하세요.', requires: ['bank_open'] },
  { key: 'payments_test', stage: 'payments', title: '결제와 환불 흐름 검증', description: '테스트 환경에서 결제, 정산 내역과 환불 처리 절차를 확인하세요.', requires: ['payments_setup'] },
  { key: 'accounting_setup', stage: 'accounting', title: '장부와 거래 분류 준비', description: 'Xero 또는 QuickBooks에서 회계 기준, 계정 과목, 은행 피드를 설정하세요.', requires: [] },
  { key: 'accounting_close', stage: 'accounting', title: '월 결산 · 신고 일정 관리', description: '장부 대사와 증빙 검토를 마치고 회사에 적용되는 신고 기한을 담당자와 확인하세요.', requires: ['accounting_setup'] },
  { key: 'support_setup', stage: 'support', title: '고객지원 인박스 열기', description: 'Chatwoot에 웹 채팅과 지원 채널을 만들고 담당자와 응대 기준을 정하세요.', requires: [] },
  { key: 'support_feedback', stage: 'support', title: '고객 피드백을 제품 업무로 연결', description: '지원 요청의 분류·응답 절차를 점검하고 개선 사항을 AWB 티켓에 연결하세요.', requires: ['support_setup'] },
  { key: 'growth_launch', stage: 'growth', title: '마케팅 캠페인 시작', description: '연결할 캠페인을 고르고 채널, 콘텐츠, 예산, 승인 절차를 준비하세요.', requires: [] },
  { key: 'growth_learn', stage: 'growth', title: '성과와 피드백으로 다음 사이클 개선', description: '기존 마케팅의 분석과 피드백을 확인하고 다음 실행 계획을 정하세요.', requires: ['growth_launch'] },
];
