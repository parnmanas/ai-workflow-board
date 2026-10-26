import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { setupDom, mount, typeInto, React, act } from './helpers/jsdom.mjs';
import { getLocale, getLocaleTag, initializeLocale, LANGUAGE_STORAGE_KEY, savedLocale, setLocale, t } from '../src/i18n/core.ts';
import { LocaleProvider, useLocale } from '../src/i18n/react.tsx';
import LanguageSelect from '../src/components/LanguageSelect.tsx';
import { Button } from '../src/components/common/Button.tsx';
import { TICKET_STATUS_LABELS } from '../src/tickets/status.ts';
import { relativeTime } from '../src/utils/time.ts';
import { freshnessBadge } from '../src/components/ontology/freshness.ts';
import { api, getActiveAccountId, setActiveAccountId } from '../src/api.ts';
import { localizeBusinessConnector, localizeMailConnector, localizeSelfServiceAssessment, localizeTrademarkConnector } from '../src/i18n/catalog.ts';
import { BUSINESS_CONNECTORS } from '../../server/src/modules/business/connectors/registry.ts';
import { TRADEMARK_CONNECTORS } from '../../server/src/modules/business/connectors/trademark-registry.ts';
import { smtpImapConnector } from '../../server/src/modules/business/mail/smtp-imap.connector.ts';
import { jmapConnector } from '../../server/src/modules/business/mail/jmap.connector.ts';
import { assessSelfService, SELF_SERVICE_GUIDES } from '../../server/src/modules/business/business-self-service.ts';

test('English is the default even on a Korean browser; only an explicit supported preference is restored', async () => {
  const dom = setupDom();
  try {
    Object.defineProperty(window.navigator, 'language', { value: 'ko-KR', configurable: true });
    await initializeLocale();
    assert.equal(getLocale(), 'en');
    assert.equal(document.documentElement.lang, 'en');
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'unsupported');
    assert.equal(savedLocale(), 'en');
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ja');
    await initializeLocale();
    assert.equal(t('Settings'), '設定');
    assert.equal(getLocaleTag(), 'ja-JP');
  } finally { await setLocale('en'); dom.cleanup(); }
});

test('all languages preserve interpolation values and update module-level status labels', async () => {
  const dom = setupDom();
  try {
    for (const [locale, status] of [['en', 'Done'], ['ko', '완료'], ['ja', '完了'], ['zh-CN', '完成']]) {
      await setLocale(locale);
      assert.equal(TICKET_STATUS_LABELS.done, status);
      assert.equal(window.localStorage.getItem(LANGUAGE_STORAGE_KEY), locale);
      assert.equal(t('missing {value}', { value: '$& <script>中文/한글' }), 'missing $& <script>中文/한글');
      assert.equal(t('missing {value}', { value: '{other}', other: 'Do not interpolate twice' }), 'missing {other}');
      assert.equal(t('toString'), 'toString');
      assert.equal(t(''), '');
      assert.equal(t('승인 대기 {0}건', { 0: 12 }).includes('12'), true);
    }
    assert.equal(document.documentElement.lang, 'zh-Hans');
    assert.match(relativeTime(new Date(Date.now() - 120_000).toISOString()), /分钟前/);
  } finally { await setLocale('en'); dom.cleanup(); }
});

test('English plural suffixes do not leak into Korean, Japanese or Chinese messages', async () => {
  const expected = {
    en: 'Graph is 2 commits behind HEAD (indexed at abcdefg)',
    ko: '그래프가 HEAD보다 커밋 2개 뒤처졌습니다(인덱스: abcdefg)',
    ja: 'グラフは HEAD から2コミット遅れています（索引: abcdefg）',
    'zh-CN': '图谱比 HEAD 落后 2 次提交（索引：abcdefg）',
  };
  try {
    for (const [locale, message] of Object.entries(expected)) {
      await setLocale(locale, false);
      const badge = freshnessBadge({ status: 'stale', commit: 'abcdefghij', behind: 2, ahead: 0, dirtyRatio: null, indexedAt: null, freshnessError: null });
      assert.equal(badge.headline, message);
    }
  } finally { await setLocale('en', false); }
});

test('changing language preserves mounted form state and user content, including text that matches a message key', async () => {
  const dom = setupDom();
  function Form() {
    useLocale();
    const [value, setValue] = React.useState('');
    return React.createElement('div', null,
      React.createElement(LanguageSelect),
      React.createElement('input', { 'data-testid': 'draft', value, onChange: event => setValue(event.target.value) }),
      React.createElement('strong', null, t('Save')),
      React.createElement('p', null, value));
  }
  const view = mount(React.createElement(LocaleProvider, null, React.createElement(Form)));
  try {
    typeInto(view.container.querySelector('input'), '저장 / Settings / 日本語');
    await act(async () => { await setLocale('ja'); });
    assert.equal(view.container.querySelector('strong').textContent, '保存');
    assert.equal(view.container.querySelector('input').value, '저장 / Settings / 日本語');
    assert.equal(view.container.querySelector('p').textContent, '저장 / Settings / 日本語');
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ko');
    await act(async () => {
      window.dispatchEvent(new window.StorageEvent('storage', { key: LANGUAGE_STORAGE_KEY, newValue: 'ko' }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(view.container.querySelector('strong').textContent, '저장');
  } finally { view.unmount(); await setLocale('en'); dom.cleanup(); }
});

test('blocked browser storage does not prevent selecting a language', async () => {
  const dom = setupDom();
  try {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage disabled'); }, configurable: true });
    await initializeLocale();
    assert.equal(getLocale(), 'en');
    await setLocale('ko');
    assert.equal(t('Save'), '저장');
  } finally { await setLocale('en'); dom.cleanup(); }
});

test('catalogs have the same messages and preserve every interpolation slot', () => {
  const load = locale => JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8'));
  const english = load('en');
  const slots = value => [...value.matchAll(/\{([\w.]+)\}/g)].map(match => match[1]).sort();
  for (const key of Object.keys(english)) {
    assert.deepEqual(slots(english[key]), slots(key), `en: ${key}`);
  }
  for (const locale of ['ko', 'ja', 'zh-CN']) {
    const catalog = load(locale);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), locale);
    for (const key of Object.keys(english)) {
      assert.equal(typeof catalog[key], 'string', `${locale}: ${key}`);
      assert.doesNotMatch(catalog[key], /[⁇\uFFFD]/, `${locale}: ${key}`);
      assert.deepEqual(slots(catalog[key]), slots(english[key]), `${locale}: ${key}`);
    }
  }
});

test('loading animations keep valid CSS in every language', async () => {
  const dom = setupDom();
  try {
    for (const locale of ['en', 'ko', 'ja', 'zh-CN']) {
      await setLocale(locale, false);
      const view = mount(React.createElement(Button, { loading: true }, t('Save')));
      try {
        assert.equal(view.container.querySelector('button span').style.animation, 'button-spin 0.6s linear infinite');
        assert.equal(view.container.querySelector('style').sheet.cssRules[0].name, 'button-spin');
      } finally { view.unmount(); }
    }
  } finally { await setLocale('en', false); dom.cleanup(); }
});

test('every literal application message has an English catalog entry', () => {
  const english = JSON.parse(readFileSync(new URL('../src/i18n/locales/en.json', import.meta.url), 'utf8'));
  const missing = [];
  function visitDirectory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) { visitDirectory(file); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['t', 'translate'].includes(node.expression.text)) {
          const message = node.arguments[0];
          if (message && ts.isStringLiteralLike(message) && !Object.hasOwn(english, message.text)) {
            missing.push(`${file.pathname}: ${message.text}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  visitDirectory(new URL('../src/', import.meta.url));
  assert.deepEqual(missing, []);
});

test('server-owned service catalogs and conditional self-service guidance are localized without changing protocol fields', async () => {
  const sources = BUSINESS_CONNECTORS.map(connector => connector.descriptor);
  const connectors = sources.map(localizeBusinessConnector);
  const trademarks = TRADEMARK_CONNECTORS.map(connector => localizeTrademarkConnector(connector.descriptor));
  const mail = [smtpImapConnector, jmapConnector].map(connector => localizeMailConnector(connector.descriptor));
  const assessments = [];
  for (const [provider, guide] of Object.entries(SELF_SERVICE_GUIDES)) {
    const allYes = Object.fromEntries(guide.questions.map(question => [question.key, true]));
    const allNo = Object.fromEntries(guide.questions.map(question => [question.key, false]));
    const variants = [{}, allYes, allNo];
    if (provider === 'self_formation') variants.push({ ...allYes, principal_us: false }, { ...allYes, responsible_tax_id: false });
    for (const state of ['WY', 'DE', 'unsupported']) {
      for (const answers of variants) {
        const result = assessSelfService({ country: 'US', entity_type: 'LLC', jurisdiction: state }, provider, provider === 'self_formation' ? state : 'cashbook', answers);
        assessments.push(localizeSelfServiceAssessment(result));
      }
    }
  }
  try {
    for (const locale of ['en', 'ko', 'ja', 'zh-CN']) {
      await setLocale(locale, false);
      if (locale !== 'ko') {
        const untranslated = new Set();
        function inspect(value) {
          if (typeof value === 'string' && /[가-힣]/.test(value)) untranslated.add(value);
          else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
        }
        inspect({ connectors, trademarks, mail, assessments });
        assert.deepEqual([...untranslated], [], locale);
      }
      for (const [index, connector] of connectors.entries()) {
        const source = sources[index];
        for (const key of ['id', 'stage', 'mode', 'credential_provider', 'secret_fields', 'environments', 'formation', 'docs_url', 'portal_url']) {
          assert.deepEqual(connector[key], source[key], `${locale}: ${source.id}.${key}`);
        }
        assert.deepEqual(connector.fields.map(field => field.key), source.fields.map(field => field.key));
        assert.deepEqual(connector.offering.pricing.plans.map(plan => plan.id), source.offering.pricing.plans.map(plan => plan.id));
        assert.equal(connector.offering.pricing.url, source.offering.pricing.url);
        const amounts = /(?:\$[\d,.]+|[\d.]+%)/g;
        const prices = connector.offering.pricing.plans.map(plan => plan.price.match(amounts));
        assert.deepEqual(prices, source.offering.pricing.plans.map(plan => plan.price.match(amounts)), `${locale}: ${source.id} prices`);
      }
      assert.equal(sources.find(item => item.id === 'self_formation').name, '직접 LLC 설립');
    }
  } finally { await setLocale('en', false); }
});

test('API catalog labels switch without refetching while connection names, credentials and records remain verbatim', async () => {
  const dom = setupDom();
  const previousFetch = globalThis.fetch;
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const record = { title: '직접 LLC 설립', text: '계정 인증', id: 'record-original' };
  const connection = { name: '직접 LLC 설립', id: 'connection-original', config: { domain: 'example.test' } };
  const credential = { name: '계정 인증', id: 'credential-original' };
  let requests = 0;
  try {
    Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true });
    const responses = [
      BUSINESS_CONNECTORS.map(connector => connector.descriptor),
      { connectors: [smtpImapConnector.descriptor], connections: [connection], credentials: [credential] },
      { connectors: TRADEMARK_CONNECTORS.map(connector => connector.descriptor), connections: [connection], records: [record], actions: [] },
    ];
    globalThis.fetch = async () => new Response(JSON.stringify(responses[requests++]), { status: 200 });
    const catalog = await api.listBusinessConnectors();
    const mail = await api.listBusinessMailConnections();
    const trademark = await api.listTrademarkIntegrations('company-original', 'trademark-original');
    const names = { en: 'Form an LLC yourself', ko: '직접 LLC 설립', ja: '自分でLLCを設立', 'zh-CN': '自行设立 LLC' };
    for (const [locale, label] of Object.entries(names)) {
      await setLocale(locale, false);
      assert.equal(catalog.find(item => item.id === 'self_formation').name, label);
      assert.equal(mail.connectors[0].note, t(smtpImapConnector.descriptor.note));
      assert.equal(trademark.connectors[0].setup, t(TRADEMARK_CONNECTORS[0].descriptor.setup));
      assert.deepEqual(mail.connections, [connection]);
      assert.deepEqual(mail.credentials, [credential]);
      assert.deepEqual(trademark.records, [record]);
      assert.equal(requests, 3);
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
    await setLocale('en', false);
    dom.cleanup();
  }
});

test('all locales preserve authentication, Account ownership, API enums and uploaded user content', async () => {
  const dom = setupDom();
  const previousFetch = globalThis.fetch;
  const previousAccount = getActiveAccountId();
  const storageDescriptors = ['localStorage', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  try {
    for (const [key] of storageDescriptors) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
    window.localStorage.setItem('auth_token', 'token+._-{}');
    setActiveAccountId('account-original');
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: new URL(url, window.location.origin), ...options });
      return new Response(JSON.stringify({ id: 'result', title: '사용자 원문' }), { status: 200 });
    };
    const content = { title: '저장 / Settings / 日本語', description: '{0} 원문', priority: 'high', project_id: 'project-original' };
    const file = new File(['사용자가 작성한 내용'], '저장 Settings 日本語.txt', { type: 'text/plain' });
    for (const locale of ['en', 'ko', 'ja', 'zh-CN']) {
      await setLocale(locale, false);
      const result = await api.updateTicket('ticket-original', content);
      assert.equal(result.title, '사용자 원문');
      const update = requests.at(-1);
      assert.equal(update.url.pathname, '/api/tickets/ticket-original');
      assert.equal(update.method, 'PATCH');
      assert.deepEqual(JSON.parse(update.body), content);

      await api.moveTicket('ticket-original', 'review', 2);
      assert.deepEqual(JSON.parse(requests.at(-1).body), { status: 'review', position: 2 });

      await api.uploadResourceFile(file, { account_id: 'account-original', type: 'comment_attachment' });
      const upload = requests.at(-1);
      assert.equal(upload.url.searchParams.get('account_id'), 'account-original');
      assert.equal(upload.url.searchParams.get('type'), 'comment_attachment');
      assert.equal(upload.body, file);
      assert.equal(upload.headers['X-File-Name'], encodeURIComponent(file.name));
      for (const request of requests.splice(0)) {
        assert.equal(request.headers.Authorization, 'Bearer token+._-{}', locale);
        assert.equal(request.headers['X-Account-Id'], 'account-original', locale);
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
    setActiveAccountId(previousAccount);
    for (const [key, descriptor] of storageDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await setLocale('en', false);
    dom.cleanup();
  }
});
