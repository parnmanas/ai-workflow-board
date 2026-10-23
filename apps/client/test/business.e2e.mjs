// Real browser layout and navigation; external services and authentication use fixtures.
import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';
import { BUSINESS_TEMPLATE } from '../../server/dist/modules/business/business-template.js';
import { BUSINESS_CONNECTORS } from '../../server/dist/modules/business/connectors/registry.js';

const account = { id: 'business-browser-account', name: 'Personal' };
const company = { id: 'business-browser-company', account_id: account.id, name: 'Orbit Labs LLC', entity_type: 'LLC', country: 'US', jurisdiction: 'Delaware', description: '아이디어를 제품으로, 제품을 지속 가능한 비즈니스로.', campaign_ids: ['campaign-1'], revision: 3 };
const tasks = BUSINESS_TEMPLATE.map((item, i) => ({ id: item.key, account_id: account.id, company_id: company.id, title: item.title, description: item.description, stage: item.stage, status: i < 3 ? 'done' : i === 3 ? 'in_progress' : 'todo', depends_on: item.requires, blocked_by: item.requires.filter(key => !BUSINESS_TEMPLATE.slice(0, 3).some(t => t.key === key)), due_on: i === 3 ? '2026-10-28' : null, owner: i === 3 ? 'Finance' : '', notes: '', ticket_id: null, ticket: null, position: i }));

async function fixture(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ accountId }) => {
    localStorage.setItem('auth_token', 'browser-fixture-token');
    localStorage.setItem('currentAccountId', accountId);
    window.EventSource = class extends EventTarget { readyState = 1; close() { this.readyState = 2; } };
  }, { accountId: account.id });
  const detail = { company: { ...company, service_choices: {} }, formations: [], tasks: structuredClone(tasks), connections: [], campaigns: [{ id: 'campaign-1', name: 'Orbit 첫 고객 찾기', goal: '실제 고객의 피드백으로 제품의 다음 단계를 정합니다.', status: 'active', cycle_count: 4 }], events: [
    { id: 'event-1', message: 'EIN 발급과 법인 문서 보관 · 완료', kind: 'task', created_at: '2026-10-23T03:40:00Z' },
    { id: 'event-2', message: '설립 신청 · 서명 · 서류 확인 · 완료', kind: 'task', created_at: '2026-10-22T05:10:00Z' },
    { id: 'event-3', message: 'Orbit Labs LLC의 운영 워크플로를 만들었습니다.', kind: 'company', created_at: '2026-10-20T01:10:00Z' },
  ] };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/auth/me') body = { id: 'owner', name: 'Orbit owner', role: 'admin', status: 'active', permissions: [], resolved_permissions: ['business.manage', 'marketing.manage', 'admin.credentials', 'tickets.create'], accounts: [account] };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/cli-catalog') body = { clis: cliCatalog() };
    else if (path === '/voice/config') body = { stt: { ready: false }, tts: { ready: false }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path === '/business/companies') body = [company];
    else if (path === '/business/connectors') body = BUSINESS_CONNECTORS.map(c => c.descriptor);
    else if (path === `/business/companies/${company.id}`) body = detail;
    else if (path === '/business/credentials') body = [{ id: 'doola-fixture-key', provider: 'doola', name: 'doola Sandbox' }];
    else if (path.endsWith('/formation/doola/references')) body = { industries: ['Custom Computer Programming Services'], fees: [{ state: 'WY', price_in_cents: 10000 }, { state: 'DE', price_in_cents: 11000 }] };
    else if (path.endsWith('/formation/doola/prepare')) {
      const input = request.postDataJSON();
      detail.formationRequest = { customer: { firstName: input.application.first_name, lastName: input.application.last_name, email: input.application.email }, company: { description: input.application.description, responsibleParty: { address: input.application.address } } };
      body = { id: 'formation-fixture', company_id: company.id, provider: 'doola', credential_id: input.credential_id, environment: input.environment, payload_digest: 'reviewed-digest', revision: 1, status: 'draft', summary: { name: `${input.application.name} LLC`, state: input.application.state, entity_type: 'LLC', industry: input.application.industry }, state_fee_cents: 10000, quoted_at: '2026-10-23T05:00:00Z', attempted_at: null, external_company_id: '', provider_status: '', last_error: '' };
      detail.formations = [body]; detail.company.revision++;
    }
    else if (path.endsWith('/formations/formation-fixture/review')) body = { formation: detail.formations[0], request: detail.formationRequest };
    else if (path.endsWith('/formations/formation-fixture/submit')) {
      expect(request.postDataJSON()).toEqual({ payload_digest: 'reviewed-digest', revision: 1, confirm: true });
      detail.formations[0] = { ...detail.formations[0], status: 'submitted', revision: 3, external_company_id: 'doola-company-fixture', provider_status: 'PENDING' }; body = detail.formations[0];
    }
    else if (path.endsWith('/formations/formation-fixture/signature')) body = { url: 'https://sign.doola.com/browser-fixture', expires_at: '2026-10-23T06:00:00Z' };
    else if (path === '/marketing/campaigns') body = detail.campaigns;
    else if (path === '/marketing/inbox') body = { total: 0, campaigns: [] };
    else if (path === '/accounts') body = [account];
    else if (path === `/accounts/${account.id}`) body = account;
    else if (path.includes('/unread') || path.endsWith('counts') || path.includes('/mentions')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return errors;
}

for (const viewport of [{ width: 1440, height: 1080 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test(`Business workflow, connectors and dialogs fit ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const errors = await fixture(page);
    await page.goto('/business');
    await expect(page.getByRole('heading', { name: 'Orbit Labs LLC', exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(6);
    await expect(page.locator('.business-stage-card').first()).toContainText('3 / 3 완료');
    await expect(page.getByRole('img', { name: '업무 완료율 23%' })).toBeVisible();
    const fits = async () => {
      const widths = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.business-content, .business-page, .business-stage-guide, .business-guide-steps > li')].map(el => ({ width: el.clientWidth, scroll: el.scrollWidth })));
      for (const width of widths) expect(width.scroll).toBeLessThanOrEqual(width.width + 1);
    };
    await fits();
    await page.screenshot({ path: info.outputPath('overview.png'), fullPage: true });
    if (viewport.width === 1440) await page.screenshot({ path: '/tmp/awb-business-overview.png', fullPage: true });
    await page.getByRole('button', { name: '단계별 진행 방법' }).click();
    await expect(page).toHaveURL(/business\/operations.*stage=banking/);
    await expect(page.getByRole('heading', { name: '계좌 · 입출금', exact: true })).toBeVisible();
    const guide = page.getByRole('region', { name: '실제 진행 방법', exact: true });
    await expect(guide.getByRole('link', { name: 'Mercury 열기' })).toHaveAttribute('href', 'https://mercury.com');
    await guide.getByText('연결 전에 알아둘 점 · 공식 진행 안내', { exact: true }).click();
    await expect(guide.getByRole('link', { name: '준비할 서류', exact: true })).toHaveAttribute('href', /support\.mercury\.com/);
    await fits();
    await guide.screenshot({ path: info.outputPath('guide.png') });
    if (viewport.width === 1440 || viewport.width === 390) await guide.screenshot({ path: `/tmp/awb-business-guide-${viewport.width}.png` });
    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '업무 이름', exact: true })).toBeVisible();
    await fits();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await guide.getByRole('link', { name: '조회 커넥터 설정' }).click();
    await expect(page).toHaveURL(/business\/connectors\?company=business-browser-company/);
    await expect(page.locator('.business-connector-card')).toHaveCount(BUSINESS_CONNECTORS.length);
    await page.locator('.business-connector-card').filter({ has: page.getByRole('heading', { name: 'Mercury', exact: false }) }).getByRole('button', { name: '조회 연결' }).click();
    await expect(page.getByRole('dialog', { name: 'Mercury 연결' })).toBeVisible();
    await expect(page.getByLabel('연결 환경')).toHaveValue('sandbox');
    await page.getByLabel('연결 키').selectOption('__new__');
    await expect(page.getByLabel('api_token', { exact: true })).toHaveAttribute('type', 'password');
    await page.keyboard.press('Escape');
    await fits();
    await page.screenshot({ path: info.outputPath('connectors.png'), fullPage: true });
    if (viewport.width === 1440) await page.screenshot({ path: '/tmp/awb-business-connectors.png', fullPage: true });
    await page.getByLabel('doola 비교', { exact: true }).check();
    await page.getByLabel('Stripe Atlas 비교', { exact: true }).check();
    await page.getByRole('button', { name: '가격 · 기능 비교', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('$297 / 년');
    await expect(page.getByRole('dialog')).toContainText('$500 / 1회');
    await fits();
    await page.getByRole('dialog').screenshot({ path: `/tmp/awb-business-comparison-${viewport.width}.png` });
    await page.getByRole('button', { name: '비교를 마치고 선택하기' }).click();
    await page.getByRole('button', { name: '설립 신청 · 기록' }).click();
    const formation = page.getByRole('dialog', { name: 'doola 설립 신청' });
    await formation.getByLabel('설립 파트너 키', { exact: true }).selectOption('doola-fixture-key');
    await formation.getByRole('button', { name: '업종 · 주정부 수수료 불러오기' }).click();
    await formation.getByLabel('설립 업종', { exact: true }).fill('Custom Computer Programming Services');
    await formation.getByLabel('설립 사업 설명', { exact: true }).fill('Software products');
    await formation.getByLabel('소유자 이름', { exact: true }).fill('Min');
    await formation.getByLabel('소유자 성', { exact: true }).fill('Kim');
    await formation.getByLabel('소유자 이메일', { exact: true }).fill('founder@example.invalid');
    await formation.getByLabel('전화번호 (국가번호 포함)', { exact: true }).fill('+821012345678');
    await formation.getByLabel('영문 도로명 주소', { exact: true }).fill('123 Test Road');
    await formation.getByLabel('도시', { exact: true }).fill('Seoul');
    await formation.getByLabel('주 · 시도', { exact: true }).fill('Seoul');
    await formation.getByLabel('우편번호', { exact: true }).fill('06134');
    await fits();
    await formation.getByRole('button', { name: '신청서 · 비용 검토' }).click();
    await expect(formation).toContainText('founder@example.invalid');
    await expect(formation).toContainText('$100.00');
    await expect(formation.getByRole('button', { name: '테스트 신청 제출' })).toBeDisabled();
    await fits();
    await formation.screenshot({ path: `/tmp/awb-business-formation-${viewport.width}.png` });
    await formation.getByLabel('설립 제출 확인', { exact: true }).check();
    await formation.getByRole('button', { name: '테스트 신청 제출' }).click();
    await expect(formation).toContainText('doola-company-fixture');
    await formation.getByRole('button', { name: 'SS-4 서명 링크 받기' }).click();
    await expect(formation.getByRole('link', { name: 'doola 서명 화면 열기' })).toHaveAttribute('href', 'https://sign.doola.com/browser-fixture');
    await fits();
    expect(errors).toEqual([]);
  });
}
