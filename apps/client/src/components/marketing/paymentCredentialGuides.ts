/**
 * 직접 결제 공급자 credential 발급 안내 — Credentials 화면(그 공급자를 고르면)과 마케팅 수취인 설정이 같은 글을 보여 준다.
 * docs/marketing.md "직접 결제 어댑터" → "credential 발급".
 *
 * 공식 문서(2026-10 확인)를 따른 순서다. 공급자 화면의 메뉴 이름은 그 화면에 보이는 영어 그대로 적는다. 화면 이름이 공식 문서로
 * 확인되지 않은 곳은 "예:" 로 적었다 — 공급자가 화면을 바꾸면 이 파일만 고친다.
 * 필드 이름은 서버 DIRECT_PROVIDER_CREDENTIAL_FIELDS 와 같아야 한다(test/marketing-payment-contract.test.mjs 가 대조한다).
 */
import type { MarketingDirectPaymentProvider } from '../../types';

export interface PaymentCredentialGuide {
  /** 한 줄 제목. */
  title: string;
  /** 이 credential 로 AWB 서버가 하는 일 · 전제. */
  summary: string;
  /** 발급 순서. */
  steps: string[];
  /** credential 필드마다 어디서 온 값을 넣는가(필드 이름 그대로). */
  fields: Array<{ field: string; value: string }>;
  /** 수취인 대상(ref)에 무엇을 넣는가. */
  target: string;
  /** 자주 막히는 곳. */
  pitfalls: string[];
  /** 공식 문서. */
  links: Array<{ label: string; url: string }>;
}

export const PAYMENT_CREDENTIAL_GUIDES: Readonly<Record<MarketingDirectPaymentProvider, PaymentCredentialGuide>> = {
  meta_ads: {
    title: 'Meta Ads — 시스템 사용자 토큰 발급',
    summary:
      'AWB 서버가 정해 둔 광고 캠페인의 지출 한도(spend_cap)를 읽고, 승인된 만큼 올리는 데 쓰는 토큰입니다. 광고 계정을 가진 비즈니스 포트폴리오(예전 Business Manager)에서 시스템 사용자를 만들어 발급합니다.',
    steps: [
      '광고 계정이 내 비즈니스 포트폴리오의 소유이거나 그 포트폴리오에 공유돼 있는지 확인합니다.',
      'developers.facebook.com/apps 에서 Create app → 사용 사례 "Create & manage ads with Marketing API" → 비즈니스 포트폴리오 선택 → Go to dashboard. 앱 유형을 묻는 예전 화면이면 Business 를 고릅니다.',
      '내 광고 계정만 다룬다면 앱 검수(App Review)는 필요 없습니다. 접근 등급은 앱 대시보드 App Review → Permissions and Features 에서 봅니다.',
      'Business settings(Meta Business Suite → Settings) → Users → System users → + Add 로 시스템 사용자를 만듭니다. 역할은 Employee 로 둡니다(Admin 불필요).',
      '그 시스템 사용자 → Assign assets → 위 앱 → Manage app(전체 권한)을 줍니다.',
      '다시 Assign assets → 광고 계정 → 캠페인을 수정할 수 있는 권한을 줍니다(예: 캠페인 관리). 보기 전용이면 읽기는 되지만 한도 변경이 거부됩니다.',
      'Generate token → 위 앱 선택 → 만료 없음(non-expiring) → 권한 ads_management 체크 → 만든 토큰을 바로 복사합니다. 다시 볼 수 없습니다.',
      '(선택) 앱 대시보드 App settings → Basic → App secret 을 복사합니다. App settings → Advanced → Security 의 "Require App Secret" 이 켜져 있으면 꼭 필요합니다.',
      'Ads Manager 의 Settings → Account overview 에서 광고 계정 id 를, 캠페인 목록에서 캠페인 id 를 확인합니다(Graph API Explorer 의 GET act_<id>/campaigns?fields=id,name,spend_cap 로도 볼 수 있습니다).',
      '그 캠페인에 Ads Manager 에서 캠페인 지출 한도를 먼저 정합니다 — AWB 는 있는 한도를 올리기만 합니다.',
      '테스트: 앱 대시보드의 사용 사례 → Quickstart → Create Sandbox Ad Account 로 광고가 나가지 않는 샌드박스 광고 계정을 만들 수 있습니다(개발자당 하나).',
    ],
    fields: [
      { field: 'access_token', value: '시스템 사용자 토큰(EAAB…)' },
      { field: 'app_secret', value: '앱의 App secret — "Require App Secret" 이 켜져 있을 때만 필수' },
    ],
    target: '수취인 대상: act_<광고 계정 id>/<캠페인 id> (예: act_1234567890/120210000000000)',
    pitfalls: [
      '60일 토큰을 고르면 60일 뒤 끊깁니다. AWB 는 토큰을 갱신하지 않으니 만료 없음으로 발급합니다.',
      '"Require App Secret" 이 켜져 있는데 app_secret 이 비었거나 다른 앱의 값이면 모든 호출이 실패합니다.',
      '접근 등급 Limited(예전 Standard Access)는 호출량이 작고 개발용입니다. 운영 규모에서는 Full 등급(App Review)이 필요할 수 있습니다.',
      '인증되지 않은 비즈니스 포트폴리오는 광고를 집행할 수 없습니다.',
      '지출 한도는 경매(AUCTION) 캠페인만 쓸 수 있고, 광고 계정 통화가 마케팅 캠페인 통화와 같아야 합니다. 한도를 처음 정할 때는 최소 금액(약 100 USD)이 있습니다.',
    ],
    links: [
      { label: '시스템 사용자 · 토큰 발급', url: 'https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens' },
      { label: 'Marketing API 권한', url: 'https://developers.facebook.com/docs/marketing-api/get-started/authorization' },
      { label: '액세스 토큰', url: 'https://developers.facebook.com/documentation/facebook-login/guides/access-tokens' },
      { label: 'App secret proof', url: 'https://developers.facebook.com/docs/graph-api/securing-requests' },
    ],
  },
  google_ads: {
    title: 'Google Ads — 서비스 계정 또는 OAuth refresh token',
    summary:
      'AWB 서버가 캠페인 총예산(CUSTOM_PERIOD)을 읽고, 승인된 만큼 올리는 데 씁니다. API 접근 수준은 OAuth client 가 속한 Google Cloud 프로젝트에 붙습니다 — developer token 은 2026-09-09 에 폐지됐습니다.',
    steps: [
      'Google Cloud 콘솔에서 이 용도 전용 프로젝트를 만듭니다.',
      'APIs & Services → Library → Google Ads API → Enable.',
      'Google Ads API Overview(console.cloud.google.com/google/ads-apis/overview)에서 접근 수준을 봅니다. Test 면 Upgrade access level → Explorer → Apply for access. Test 수준은 테스트 계정만 부를 수 있습니다.',
      '서비스 계정 방식(권장): IAM & Admin → Service Accounts → Create service account → Keys → Add key → JSON. client_email 과 private_key 를 아래 칸에 넣고 OAuth 세 칸은 비웁니다. 두 인증 방식을 섞으면 거부됩니다.',
      'Google Ads → Access and security 에 서비스 계정 이메일을 Standard 이상 사용자로 추가합니다. 도메인 전체 위임은 필요 없습니다. 이메일당 20계정까지이므로 관리자(MCC) 계정에 추가하고 login_customer_id 를 지정하는 방식을 권장합니다.',
      '서버는 adwords 범위의 RS256 JWT(만료 1시간, 사용자 가장 없음)를 Google access token 으로 교환합니다. 서비스 계정 방식은 아래 OAuth 앱 게시·refresh token 발급 단계를 건너뜁니다.',
      'OAuth 방식: Google Auth Platform → Branding: 앱 이름 · 지원 이메일을 넣고 Audience 는 External(같은 Workspace 사용자만 승인한다면 Internal) → Create.',
      'Data Access → Add or Remove Scopes 에 https://www.googleapis.com/auth/adwords 를 넣고 저장합니다.',
      'Audience → Publish app 으로 "In production" 으로 둡니다. Testing 이면 refresh token 이 7일 뒤 만료됩니다.',
      'Clients → Create Client → Application type: Desktop app → Create → JSON 을 바로 내려받습니다. 전체 secret 은 한 번만 보입니다.',
      '승인할 Google 계정은 광고 계정(또는 그 위 관리자 계정)에 Standard 이상 권한이 있어야 합니다. 읽기 전용으로는 예산을 바꿀 수 없습니다.',
      'refresh token 발급: gcloud auth application-default login --scopes=https://www.googleapis.com/auth/adwords,https://www.googleapis.com/auth/cloud-platform --client-id-file=<내려받은 JSON> 을 실행하고 그 계정으로 승인합니다. 만들어진 application_default_credentials.json 에 client_id · client_secret · refresh_token 이 있습니다(확인되지 않은 앱 경고는 Advanced → Go to … 로 진행).',
      '또는 OAuth 2.0 Playground: Web application client 에 리디렉션 URI https://developers.google.com/oauthplayground 를 넣고 → 톱니 → Use your own OAuth credentials → 범위 입력 → Authorize APIs → Exchange authorization code for tokens. 끝나면 그 리디렉션 URI 를 지웁니다.',
      '고객 id(10자리, 123-456-7890)는 Google Ads 화면의 계정 이름 옆에 있습니다. 관리자(MCC) 계정을 거쳐 접근하면 그 관리자 계정 id 가 login_customer_id 입니다.',
      '캠페인은 처음부터 공유하지 않는 총예산(캠페인 기간 전체 예산) + 종료일로 만듭니다. 일 예산 캠페인은 총예산으로 바꿀 수 없습니다.',
      '테스트: 운영 관리자 계정과 연결되지 않은 Google 계정으로 테스트 관리자 계정(ads.google.com/nav/selectaccount?sf=mt)을 만들고, 그 안에서 만든 계정이 테스트 계정입니다(광고 · 청구 없음).',
    ],
    fields: [
      { field: 'client_id', value: 'OAuth client JSON 의 client_id' },
      { field: 'client_secret', value: 'OAuth client JSON 의 client_secret' },
      { field: 'refresh_token', value: 'gcloud · Playground 로 받은 refresh token(1//…)' },
      { field: 'client_email', value: '서비스 계정 JSON 의 client_email — OAuth 세 칸과 함께 넣지 않습니다' },
      { field: 'private_key', value: '서비스 계정 JSON 의 private_key(PEM). 실제 줄바꿈 또는 JSON의 이스케이프된 줄바꿈을 받습니다' },
      { field: 'login_customer_id', value: '관리자(MCC) 계정을 거쳐 접근할 때만 그 관리자 계정 id' },
      { field: 'developer_token', value: '비워 둡니다(폐지 — 지금은 무시되고 이후 API 버전은 거부)' },
    ],
    target: '수취인 대상: <고객 id>/<캠페인 id> (예: 123-456-7890/22334455)',
    pitfalls: [
      'OAuth 앱이 Testing 이면 refresh token 이 7일짜리입니다.',
      'OAuth client 의 프로젝트와 Explorer 를 받은 프로젝트가 다르거나, gcloud 를 --client-id-file 없이 돌리면 CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION 으로 실패합니다.',
      '관리자 계정을 거치는데 login_customer_id 가 없으면 USER_PERMISSION_DENIED 로 실패합니다.',
      'refresh token 은 6개월 동안 쓰지 않거나 사용자가 취소하면 무효가 됩니다.',
      '광고 계정 통화가 마케팅 캠페인 통화와 같아야 합니다(광고 계정 통화는 바꿀 수 없습니다).',
    ],
    links: [
      { label: '접근 수준(Cloud 프로젝트)', url: 'https://developers.google.com/google-ads/api/docs/api-policy/access-levels' },
      { label: 'developer token 폐지', url: 'https://developers.google.com/google-ads/api/docs/api-policy/developer-token' },
      { label: '서비스 계정 인증', url: 'https://developers.google.com/google-ads/api/docs/oauth/service-accounts' },
      { label: '단일 사용자 OAuth(refresh token)', url: 'https://developers.google.com/google-ads/api/docs/oauth/single-user-authentication' },
      { label: '테스트 계정', url: 'https://developers.google.com/google-ads/api/docs/best-practices/test-accounts' },
    ],
  },
  stripe_issuing: {
    title: 'Stripe Issuing — 제한된 API 키와 카드 소지자',
    summary:
      '승인되면 AWB 서버가 승인 금액이 누적 한도인 가상 카드를 만들고, 사람이 Stripe 대시보드에서 그 카드 정보를 보고 결제합니다. AWB 는 카드 번호를 가져오지 않습니다. Stripe Issuing 은 미국 · 영국 · EEA 에 설립된 사업자만 쓸 수 있습니다(한국 법인 불가).',
    steps: [
      '미국 · 영국 · EEA 사업자의 Stripe 계정이어야 합니다. 카드 통화는 지역에 따라 USD · EUR · GBP 이고, 마케팅 캠페인 통화와 같아야 합니다.',
      '먼저 샌드박스에서 해 봅니다: 대시보드 → Issuing(dashboard.stripe.com/issuing/overview). 샌드박스는 바로 쓸 수 있습니다.',
      '운영: Issuing 에서 카드 프로그램을 시작합니다(Standard 는 셀프 서비스, 자격 심사가 있습니다).',
      'Balances → Issuing balance → Add funds 로 Issuing 잔액을 채웁니다. 잔액이 모자라면 카드 결제가 거절됩니다.',
      'Issuing → Cardholders → Create cardholder: 개인(법적 이름 · 생년월일) 또는 회사(세금 id, 두 단어 이상의 이름) + 청구지 주소. 이름은 24자 이내입니다.',
      '만든 카드 소지자의 id(ich_…)를 복사합니다 — 마케팅 수취인 대상에 넣습니다.',
      'Developers → API keys(dashboard.stripe.com/apikeys) → Create restricted key.',
      '권한: Issuing 의 Cards 를 Write, Cardholders 를 Read 로 둡니다(권한 이름 issuing_card_write · issuing_cardholder_read). 지출 대조·미사용분 반납에는 Issuing Transactions 와 Authorizations 의 Read 도 필요합니다. 나머지는 None 으로 둡니다.',
      'Create key → 키(운영 rk_live_…, 샌드박스 rk_test_…)를 바로 복사합니다. 운영 키는 다시 볼 수 없습니다.',
      '(선택) Access policies 로 IP 정책을 만들어 그 키를 AWB 서버 주소에서만 쓰게 합니다.',
      '운영(live)에서는 5–10 을 다시 합니다 — 샌드박스의 키 · 카드 소지자는 운영에 없습니다.',
      '결제할 때: 승인된 지출 요청의 "Stripe 에서 카드 보기" 링크로 대시보드 Issuing → Cards 를 열어 카드 정보를 보고 결제합니다.',
      '샌드박스에서는 카드 화면의 Create test purchase 로 결제를 흉내 낼 수 있습니다.',
    ],
    fields: [
      { field: 'secret_key', value: '제한된 API 키(rk_live_… / 샌드박스 rk_test_…). 운영의 전체 비밀 키(sk_live_…)는 거부됩니다 — 샌드박스에서만 sk_test_… 를 받습니다' },
    ],
    target: '수취인 대상: 카드 소지자 id ich_… (같은 모드 — 운영 키에는 운영 카드 소지자)',
    pitfalls: [
      '샌드박스 키에 운영 카드 소지자를 쓰거나 그 반대면 실패합니다. "연결 확인" 이 알려 줍니다.',
      '권한이 모자라면 403 으로 실패하고, 그 메시지가 필요한 권한을 알려 줍니다.',
      'Standard 프로그램 기본 한도: 주 25장 · 주 5,000 USD · 카드당 하루 500 USD, 승인 한 건 최대 10,000 USD. 늘리려면 Stripe 에 문의합니다.',
      '한도는 완전한 상한이 아닙니다 — 팁 · 나중 매입이 한도를 넘을 수 있습니다. Stripe 거래 내역과 AWB 원장을 대조하세요.',
      '일회용 카드는 첫 결제 뒤 자동으로 해지됩니다. 여러 번 청구하는 곳(광고 플랫폼 등)에는 수취인에서 일회용을 끕니다 — 누적 한도는 그대로입니다.',
      '허용 업종(merchant category)을 잘못 넣으면 모든 결제가 거절됩니다.',
    ],
    links: [
      { label: 'Issuing 시작하기', url: 'https://docs.stripe.com/issuing/for-your-business' },
      { label: '가상 카드 발급', url: 'https://docs.stripe.com/issuing/cards/virtual/issue-cards' },
      { label: '제한된 API 키', url: 'https://docs.stripe.com/keys/restricted-api-keys' },
      { label: 'Issuing 잔액', url: 'https://docs.stripe.com/issuing/funding/balance' },
    ],
  },
};
