import type { BusinessStage } from './business.types';

// These are operating tasks, not legal determinations. Completion is explicitly recorded by a person.
export const BUSINESS_TEMPLATE: Array<{ key: string; stage: BusinessStage; title: string; description: string; requires: string[] }> = [
  { key: 'formation_plan', stage: 'formation', title: '회사 이름과 설립 계획 정하기', description: '사업 목적, 설립 주, LLC / C-Corp 형태, 소유 구조를 정리하세요.', requires: [] },
  { key: 'formation_file', stage: 'formation', title: '설립 신청 · 서명 · 서류 확인', description: 'doola 또는 Atlas에서 신청하고 주정부 등록 서류를 확인하세요.', requires: ['formation_plan'] },
  { key: 'formation_ein', stage: 'formation', title: 'EIN 발급과 법인 문서 보관', description: 'EIN 발급 확인서와 운영 계약서를 보관하고 필요한 후속 서명을 마치세요.', requires: ['formation_file'] },
  { key: 'trademark_scope', stage: 'trademark', title: '상표와 실제 권리자 · 상품 범위 정리', description: '문자/로고, 실제 소유자와 본점 소재지, 상품·서비스, 사용 여부와 증빙을 정리하세요. 미국 LLC 설립만으로 상표권이 생기지는 않습니다.', requires: [] },
  { key: 'trademark_search', stage: 'trademark', title: '선행 상표 조사와 충돌 검토', description: 'USPTO 검색과 시장의 실제 사용을 조사하고 변호사에게 등록 가능성과 지정상품 검토를 요청하세요.', requires: ['trademark_scope'] },
  { key: 'trademark_counsel', stage: 'trademark', title: '미국 변호사 확인 · 견적 요청', description: '변호사의 주별 면허와 이해충돌 확인을 요청하고 관납료·클래스·Office Action·사용증명 비용을 구분한 견적을 받으세요. 실제 본점이 미국·미국 영토 밖이면 미국 변호사 대리가 필요합니다.', requires: ['trademark_scope'] },
  { key: 'trademark_engagement', stage: 'trademark', title: '수임 범위 검토 · 계약 서명', description: '수임계약, 추가 비용과 기한 관리 책임을 검토하고 본인이 전자서명하세요. 문의 메일 발송은 계약 체결을 뜻하지 않습니다.', requires: ['trademark_counsel'] },
  { key: 'trademark_filing', stage: 'trademark', title: '출원서 검토 · 서명 · 온라인 접수', description: '권리자·출원 근거·상품류·사용증명을 확정하고 권한 있는 사람이 서명한 뒤 Trademark Center 또는 대리인을 통해 접수합니다. 접수증과 출원번호를 기록하세요.', requires: ['trademark_search', 'trademark_engagement'] },
  { key: 'trademark_examination', stage: 'trademark', title: '심사 · 보정 · 공고 대응', description: 'TSDR와 변호사 회신을 확인하고 Office Action, 공고·이의신청, 사용증명 관련 기한을 실제 통지서와 대조하세요.', requires: ['trademark_filing'] },
  { key: 'trademark_registration', stage: 'trademark', title: '등록증과 등록 범위 확인', description: '접수와 등록은 다릅니다. 공식 등록증, 소유자와 지정상품 범위를 확인한 뒤 완료로 표시하세요.', requires: ['trademark_examination'] },
  { key: 'trademark_maintenance', stage: 'trademark', title: '사용 증빙 · 유지와 갱신 관리', description: '실제 사용 증빙과 유지·갱신 기한을 담당 변호사와 확인하고 반복 업무로 관리하세요.', requires: ['trademark_registration'] },
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
