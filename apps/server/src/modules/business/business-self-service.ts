import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { BusinessCompany } from '../../entities/BusinessCompany';
import type { BusinessConnector } from './business.types';

export const SELF_SERVICE_VERSION = '2026-10-24';
export const selfAnswersSchema = z.record(z.string().max(60), z.boolean()).refine(v => Object.keys(v).length <= 20);
type Question = { key: string; label: string; detail: string; required_yes: boolean };
const question = (key: string, label: string, detail: string, required_yes = true): Question => ({ key, label, detail, required_yes });
const IRS_EIN = 'https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number';
const IRS_RECORDS = 'https://www.irs.gov/businesses/small-businesses-self-employed/what-kind-of-records-should-i-keep';
const IRS_5472 = 'https://www.irs.gov/instructions/i5472';
const WY = 'https://sos.wyo.gov/Business/docs/BusinessFees.pdf';
const DE = 'https://corpfiles.delaware.gov/LLC_Forms/LLC%20Formation.pdf';
const operatorQuestion = question('operator_abroad', '운영자가 미국 밖에 거주하며 관리하나요?', '해외 거주만으로 일반 LLC 설립·장부 작성이 금지되지는 않습니다. 운영자 거주지와 소유자의 미국 세법상 지위는 별개입니다.', false);
const overseasReview = question('residence_reviewed', '거주·실제 운영 국가의 의무를 확인했나요?', '미국 LLC 설립과 별도로 거주·운영 국가의 세금, 사업 등록, 해외투자·해외계좌 신고 적용 여부를 확인하세요. 미국 절차만 완료해도 해외 의무가 해결되는 것은 아닙니다.');

export const SELF_SERVICE_GUIDES = {
  self_formation: {
    scope: '미국 WY·DE의 일반 LLC 신설 가이드. 다른 주·법인 형태·전문직/규제 업종·Series LLC는 별도 절차 확인이 필요합니다. 이는 AWB 가이드 범위이며 직접 설립의 법적 금지 여부를 판정하지 않습니다.',
    questions: [
      operatorQuestion,
      question('standard_llc', '일반 LLC이며 특수 인허가·구조를 검토했나요?', '실제 영업하는 주의 추가 등록, 업종 허가, 여러 소유자의 지분·운영계약은 별도 검토하세요.'),
      question('name_checked', '주정부에서 사용할 회사명을 확인했나요?', 'LLC 표기와 명칭 중복을 확인하세요. 회사명 승인은 상표권 확보와 다릅니다.'),
      question('registered_agent', '해당 주의 Registered Agent를 확보했나요?', 'WY: 주내 실제 주소와 서면 동의가 필요합니다. 본인이 맡으려면 18세 이상 WY 거주자여야 합니다. DE: 주내 실제 주소를 가진 적격 대리인을 확보하세요. 우편전달 주소만으로 충족하지 않습니다.'),
      question('authorized_filer', '접수·서명을 할 권한이 있나요?', '권한 있는 신청자가 공식 포털에서 서명·결제합니다. AWB는 대신 서명하거나 주정부에 자동 제출하지 않습니다.'),
      question('compliance_plan', '운영계약·연간 의무·세금 신고 담당을 정했나요?', '설립 후 EIN, 운영계약, 별도 계좌, 연간 납부/보고와 사업 지역의 의무를 관리해야 합니다.'),
      question('principal_us', '주된 사업장이 미국 또는 미국령에 있나요?', 'Registered Agent나 우편 주소만 미국에 있다고 주된 사업장이 미국인 것은 아닙니다.', false),
      question('responsible_tax_id', 'EIN 책임자가 SSN 또는 ITIN을 보유하나요?', '보유 여부만 답하세요. 번호 자체를 입력하지 마세요. 없으면 온라인 EIN 대신 대체 경로를 사용합니다.', false),
      question('foreign_owned', '미국 세법상 외국인이 소유에 참여하나요?', '국적만으로 세법상 지위를 판단하지 마세요. 아래 외국 소유 회사 신고 안내를 확인하세요.', false),
    ],
    sources: [{ label: 'WY 수수료', url: WY }, { label: 'WY 대리인 자격', url: 'https://sos.wyo.gov/Business/Docs/HowToFindOrBecomeARegisteredAgent.pdf' }, { label: 'WY 연차 보고', url: 'https://sos.wyo.gov/FAQS.aspx?root=BUS' }, { label: 'DE 설립·수수료', url: DE }, { label: 'DE 설립 절차', url: 'https://corp.delaware.gov/howtoform/' }, { label: 'DE 2026 세액 개정', url: 'https://legis.delaware.gov/BillDetail/143069' }, { label: 'IRS EIN', url: IRS_EIN }, { label: 'IRS 해외 신청', url: 'https://www.irs.gov/businesses/employer-identification-number' }, { label: 'IRS Form 5472', url: IRS_5472 }],
  },
  self_bookkeeping: {
    scope: 'AWB의 직접 회계는 단일 USD 계좌의 실제 입출금 장부와 월별 은행 대사입니다. 복식부기·발생주의 결산·재고/감가상각·급여 계산·환산·세금 신고는 별도 도구나 검토가 필요합니다. 이 범위는 제품의 기능 한계이며 세법상 현금주의 적용 자격 판정이 아닙니다.',
    questions: [
      operatorQuestion,
      question('single_usd_account', '이 장부를 회사의 단일 USD 계좌에 사용하나요?', '개인 돈과 구분되는 하나의 계좌를 계속 사용하세요. 다른 계좌·통화의 거래를 섞지 않습니다.'),
      question('settled_only', '실제 입금·출금된 거래만 기록하나요?', '미수금·미지급금이나 예상 거래를 섞지 않습니다. 출자·인출·대출·이체·환불은 영업 입출금과 분리합니다.'),
      question('evidence_plan', '증빙과 은행 명세서를 보관할 수 있나요?', '거래 일자·금액·상대방·용도와 영수증/청구서/은행 기록을 연결하세요. AWB에는 증빙 위치·참조를 기록합니다.'),
      question('separate_tax_filing', '장부 마감과 세금 신고가 별개임을 확인했나요?', '월 마감은 내부 대사 상태입니다. 신고서 제출·세금 납부·공제 가능 여부 판단을 수행하지 않습니다.'),
      question('complex_activity', '급여·재고·발생주의·여러 통화 또는 여러 소유자 등 추가 회계가 있나요?', '있어도 입출금 보조 장부는 사용할 수 있습니다. 전체 결산은 별도 장부·전문가 검토와 연결하세요.', false),
      question('foreign_owned', '미국 세법상 외국인이 소유에 참여하나요?', '외국 소유 회사의 정보 신고를 별도로 확인하기 위한 질문입니다.', false),
    ],
    sources: [{ label: 'IRS 장부·증빙 요건', url: IRS_RECORDS }, { label: 'IRS 증빙 보관 기간', url: 'https://www.irs.gov/businesses/small-businesses-self-employed/how-long-should-i-keep-records' }, { label: 'IRS Form 5472', url: IRS_5472 }],
  },
} as const;
export type SelfProvider = keyof typeof SELF_SERVICE_GUIDES;
export function isSelfProvider(provider: string): provider is SelfProvider { return Object.hasOwn(SELF_SERVICE_GUIDES, provider); }

export function assessSelfService(company: Pick<BusinessCompany, 'country' | 'entity_type' | 'jurisdiction'>, provider: string, plan: string, answers: Record<string, boolean> = {}) {
  if (!isSelfProvider(provider)) throw new BadRequestException('직접 처리 옵션을 선택하세요.');
  const guide = SELF_SERVICE_GUIDES[provider];
  const parsed = selfAnswersSchema.safeParse(answers);
  if (!parsed.success || Object.keys(answers).some(key => key !== overseasReview.key && !guide.questions.some(q => q.key === key))) throw new BadRequestException('직접 처리 질문의 응답 형식을 확인하세요.');
  const questions = [...guide.questions, ...(answers.operator_abroad === true ? [overseasReview] : [])];
  const state = ({ wy: 'WY', wyoming: 'WY', de: 'DE', delaware: 'DE' } as Record<string, string>)[company.jurisdiction.trim().toLowerCase()];
  const blockers: string[] = [];
  if (provider === 'self_formation' && (company.country !== 'US' || company.entity_type !== 'LLC' || !state || plan !== state)) blockers.push('회사 정보를 US · LLC · WY 또는 DE로 설정하고 같은 주의 플랜을 선택하세요. 다른 경우는 이 직접 설립 가이드의 지원 범위 밖입니다.');
  if (provider === 'self_bookkeeping' && plan !== 'cashbook') blockers.push('직접 회계의 USD 입출금 장부 플랜을 선택하세요.');
  const unanswered = questions.filter(q => typeof answers[q.key] !== 'boolean').map(q => q.key);
  for (const q of questions) if (q.required_yes && answers[q.key] === false) blockers.push(`${q.label} — ${q.detail}`);
  const notices = ['선택·조건 확인은 법인 설립이나 세금 신고 완료를 의미하지 않습니다. 사실관계가 바뀌면 조건을 다시 확인하세요.'];
  if (answers.foreign_owned === true) notices.push('외국인이 전부 소유한 미국 세법상 disregarded entity에 보고 대상 관계자 거래가 있으면 Form 5472 + pro forma Form 1120 신고가 필요합니다. 출자·분배·설립 관련 지급도 포함될 수 있어 매출 0만으로 면제되지 않습니다. 외국 소유 법인·파트너십은 구조에 따른 다른 신고도 검토하세요.');
  if (answers.complex_activity === true) notices.push('추가 회계가 있는 회사: 이 장부는 입출금 보조 기록으로 사용하고 급여·재고·복식부기·결산은 별도로 처리하세요.');
  if (answers.operator_abroad === true) notices.push('해외 운영자: 운영자 거주지와 외국 소유 여부를 구분하세요. 미국 시민권자 등이 해외에 거주한다는 이유만으로 foreign-owned U.S. disregarded entity가 되는 것은 아닙니다. 설립 승인과 은행 계좌·결제 서비스 이용 심사는 별도입니다.');
  const ein_route = provider !== 'self_formation' ? null : answers.principal_us === undefined || answers.responsible_tax_id === undefined ? 'unknown' : answers.principal_us && answers.responsible_tax_id ? 'online' : answers.principal_us === false ? 'international' : 'ss4';
  const steps = provider === 'self_formation' ? [
    { title: '명칭·대리인·설립 서류 준비', where: '직접 준비', detail: '명칭 검색, Registered Agent 동의, 신청 권한과 운영계약을 확인합니다.', url: state === 'DE' ? 'https://corp.delaware.gov/howtoform/' : 'https://sos.wyo.gov/Business/Business.aspx' },
    { title: '주정부에 접수·결제', where: '공식 사이트', detail: state === 'DE' ? 'Certificate of Formation을 서명하고 커버 메모와 함께 Document Filing 서비스로 업로드하거나 우편 접수합니다. 기본 접수비 $110.' : 'WyoBiz에서 Articles of Organization을 작성·서명·결제합니다. 기본 접수비 $100. 특수 명칭·업종은 추가 절차를 확인하세요.', url: state === 'DE' ? 'https://corp.delaware.gov/document-upload-service-information/' : 'https://wyobiz.wyo.gov/' },
    { title: '접수 결과 보관', where: 'AWB 업무 기록', detail: '주정부 승인 서류와 접수번호·일자를 설립 업무 메모에 기록하고 실제 승인 후 해당 업무를 완료하세요.', url: '' },
    { title: '설립 후 EIN 신청', where: ein_route === 'online' ? 'IRS 온라인' : ein_route === 'international' ? 'IRS 전화·팩스·우편' : ein_route === 'ss4' ? 'IRS SS-4 팩스·우편' : '조건 확인 필요', detail: ein_route === 'online' ? '미국/미국령 주된 사업장 + 책임자 SSN/ITIN 조건을 충족하는 경로입니다. 실제 설립 후 IRS에서 무료 신청하세요.' : '온라인 조건을 충족하지 않아도 직접 신청 경로가 있습니다. SS-4 지침을 확인하고 실제 설립 후 팩스·우편으로 신청하세요. 주된 사업장이 해외인 신청자는 국제 전화 경로도 사용할 수 있습니다. IRS 신청은 무료입니다.', url: IRS_EIN },
    { title: '운영·연간 의무 등록', where: 'AWB 업무·기한', detail: state === 'DE' ? 'DE 연간세 $400: 해당 연도 다음 해 6월 1일까지. 2026 세액부터 적용됩니다. 대리인 유지, 연방·사업 지역 신고는 별도입니다.' : 'WY 연차 보고: 설립 기념월 1일까지(첫 기념일부터). 연간세는 $60과 WY 내 자산 × 0.0002 중 큰 금액. 대리인 유지와 세금 신고는 별도입니다.', url: state === 'DE' ? 'https://corp.delaware.gov/alt-entitytaxinstructions/' : 'https://sos.wyo.gov/FAQS.aspx?root=BUS' },
  ] : [
    { title: '입출금과 증빙 기록', where: 'AWB 장부', detail: 'USD 센트 단위로 기록하고 출자·대출·이체·환불을 분리합니다. 잘못된 기록은 취소 후 새 거래로 정정합니다.', url: '' },
    { title: '은행 명세서와 대사', where: 'AWB 월별 마감', detail: '모든 거래의 증빙과 명세서 일치를 확인합니다. 기초 잔액 + 순입출금 = 기말 잔액이어야 마감할 수 있습니다.', url: '' },
    { title: '내부 마감 후 별도 신고', where: '직접 신고 또는 회계 서비스', detail: 'CSV로 기록을 내보내 필요한 결산·세금 신고에 사용하세요. 영업 입출금 차이는 과세소득·회계이익이 아닙니다. 회사 구조·세법상 분류·소유자·사업 지역별 신고와 납부는 따로 진행합니다.', url: IRS_RECORDS },
  ];
  const residency = [
    { subject: '해외 거주자의 LLC 설립', status: '일반적으로 직접 가능', condition: 'WY·DE 일반 LLC의 설립·서명 권한과 명칭·서류 요건을 충족하고 해당 주 Registered Agent를 유지합니다. 운영자의 미국 거주·SSN 보유를 주정부 LLC 설립의 필수 조건으로 두지 않습니다.' },
    { subject: 'Registered Agent 직접 담당', status: '주내 자격 필요', condition: '해외에 거주한다는 사실만으로 주내 대리인 자격을 충족하지 않습니다. WY는 18세 이상 주내 거주 개인 또는 적격 법인과 실제 주내 주소, DE는 주내 적격 대리인·실제 주소가 필요합니다. 필요하면 대리인 서비스만 따로 계약하세요.' },
    { subject: 'EIN 직접 신청', status: ein_route === 'online' ? '온라인 조건 충족' : ein_route === 'unknown' || ein_route === null ? '사업장·책임자 조건 확인' : 'SS-4 대체 경로', condition: '미국/미국령 주된 사업장 + 책임자 SSN/ITIN이면 온라인 경로. 해외 주된 사업장은 전화·팩스·우편, 온라인 식별번호 조건을 못 맞추면 SS-4 팩스·우편 경로를 확인합니다. 번호가 없고 발급 자격도 없을 때 SS-4 7b의 foreign/N/A 지침을 적용합니다. 단순 미보유와 발급 불가를 구분하세요.' },
    { subject: '직접 장부 작성', status: '해외에서도 가능', condition: 'AWB는 운영자 거주지로 장부 사용을 제한하지 않습니다. 단일 USD 계좌의 실제 입출금·증빙·대사를 지원합니다. 거주 국가와 세무 구조에 따른 결산·신고는 별도입니다.' },
    { subject: '직접 신고서 준비·제출', status: '신고별 권한·방법 확인', condition: '외국 거주 자체가 회계사 고용을 강제하는 조건은 아닙니다. 본인 회사 신고서를 준비할 수 있지만 신고 유형별 서명 권한·필요 식별번호·제출 방식·기한을 충족해야 합니다. 예를 들어 1120은 권한 있는 임원 등이 서명합니다. AWB는 신고서를 생성·제출하거나 세액을 계산하지 않습니다.' },
    { subject: '미국 세금·정보 신고', status: '소유·세무 분류별 판단', condition: '외국인이 전부 소유한 disregarded entity + 보고 대상 관계자 거래이면 5472와 pro forma 1120. 이 경우 현재 IRS 지침상 전자신고 대신 지정 팩스·우편을 사용합니다. 파트너십은 1065 등, 외국 파트너 귀속 미국 사업 관련 과세소득이 있으면 1446 원천징수를 검토합니다. 비거주 외국인 주주는 S-Corp 자격에 맞지 않습니다. 장부만으로 신고 의무나 면세를 판정하지 않습니다.' },
  ];
  const sources = [...guide.sources, { label: 'WY 설립 법령 §17-29-201', url: 'https://wyoleg.gov/statutes/compress/title17.pdf' }, { label: 'DE 설립 법령 §18-201', url: 'https://delcode.delaware.gov/title6/c018/sc02/index.html' }, { label: 'IRS LLC 소유·과세 분류', url: 'https://www.irs.gov/businesses/small-businesses-self-employed/limited-liability-company-llc' }, { label: 'IRS SS-4 작성', url: 'https://www.irs.gov/instructions/iss4' }, { label: 'IRS 외국 파트너 원천징수', url: 'https://www.irs.gov/individuals/international-taxpayers/partnership-withholding' }, { label: 'IRS 1120 서명·준비자', url: 'https://www.irs.gov/instructions/i1120' }, { label: 'IRS S-Corp 주주 요건', url: 'https://www.irs.gov/businesses/small-businesses-self-employed/s-corporations' }];
  return { provider, plan, checked_at: SELF_SERVICE_VERSION, scope: guide.scope, questions, sources, answers, unanswered, blockers, notices, ein_route, residency, steps, eligible: !blockers.length && !unanswered.length };
}

export const SELF_SERVICE_CONNECTORS: BusinessConnector[] = [
  { descriptor: { id: 'self_formation', name: '직접 LLC 설립', stage: 'formation', color: '#0d9488', monogram: 'DIY', mode: 'manual', summary: '대행 없이 주정부 접수와 IRS EIN 신청을 직접 진행합니다.', capabilities: ['조건 확인', '공식 접수 경로', '연간 의무', '업무 기록'], setup_note: '조건 점검·절차·접수 기록을 AWB에서 관리합니다. 주정부 접수·결제·서명과 EIN 신청은 본인이 공식 경로에서 진행합니다.', docs_url: IRS_EIN, portal_url: 'https://corp.delaware.gov/howtoform/', fields: [], secret_fields: [], environments: [], offering: {
    best_for: 'WY·DE 일반 LLC를 직접 설립하고 후속 의무를 관리할 수 있는 신청자', features: ['회사·신청자 조건별 EIN 경로', '주정부 공식 접수 안내', '업무·접수 메모·기한 관리'], api_access: 'not_applicable', api_note: '직접 처리 방식이며 외부 제출 API를 사용하지 않습니다. AWB의 조건 조회·서비스 선택·업무 기록은 MCP로 제공합니다.', external_steps: ['신청자가 서명·정부 수수료 결제', '주정부 승인 서류 보관', '설립 후 IRS EIN 신청', '연차 보고·납부·세금 신고'], pricing: { checked_at: SELF_SERVICE_VERSION, url: DE, plans: [{ id: 'WY', name: 'Wyoming LLC', price: '$100 / 접수', detail: '주정부 기본 접수비 · 대행 서비스 비용 없음' }, { id: 'DE', name: 'Delaware LLC', price: '$110 / 접수', detail: '주정부 기본 접수비 · 대행 서비스 비용 없음' }], extra: 'WY 연간 최소 $60(WY 자산 기준 증액), DE 연간 $400(2026 세액부터). Registered Agent·결제 편의료·인증본·급행·인허가·세금 신고는 별도. EIN은 IRS에서 무료입니다.' },
  } } },
  { descriptor: { id: 'self_bookkeeping', name: '직접 회계 · AWB 장부', stage: 'accounting', color: '#0d9488', monogram: 'DIY', mode: 'manual', summary: '수입·지출 증빙부터 은행 대사와 내부 월 마감까지 직접 관리합니다.', capabilities: ['USD 입출금', '증빙 참조', '은행 대사', '월 마감', 'CSV'], setup_note: '단일 USD 계좌의 실제 입출금 보조 장부입니다. 은행 조회 결과를 자동 전기하지 않습니다. 복식부기·급여·재고·세금 신고는 별도로 처리합니다.', docs_url: IRS_RECORDS, portal_url: IRS_RECORDS, fields: [], secret_fields: [], environments: [], offering: {
    best_for: '증빙을 보관하며 단일 USD 계좌의 입출금을 직접 대사할 운영자', features: ['입출금·출자·대출·이체·환불 구분', '증빙·은행 대사 확인', '잔액 일치 검사·마감·사유 있는 재개', 'CSV 내보내기'], api_access: 'not_applicable', api_note: '외부 키 없이 AWB 내부에서 처리합니다. 장부 읽기·기록·대사·취소·마감·재개를 MCP로도 제공합니다.', external_steps: ['은행 명세서·증빙 원본 보관', '필요한 별도 결산·급여·세금 신고'], pricing: { checked_at: SELF_SERVICE_VERSION, url: IRS_RECORDS, plans: [{ id: 'cashbook', name: 'USD 입출금 장부', price: '외부 서비스 요금 없음', detail: 'AWB 내 직접 입력 · 별도 장부 SaaS 가입 불필요' }], extra: 'AWB 운영비, 은행 수수료, 필요 시 세무 신고·전문가·추가 회계 도구 비용은 별도입니다.' },
  } } },
];
