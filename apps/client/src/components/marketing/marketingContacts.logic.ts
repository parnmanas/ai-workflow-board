import { t as translate } from '../../i18n/core';
// 메일 연락처 가져오기의 순수 규칙(docs/marketing.md "메일") — CSV 파싱 · 열 이름 매핑 · 검증.
// React · DOM 없음(test/marketing-contacts-csv.test.mjs). 서버 MarketingContactService.import 가
// 정본이고, 여기서는 보내기 전에 행마다 무엇이 틀렸는지 보여 주려고 같은 규칙을 미리 본다.
// 동의 증거(방법 · 시각 · 출처)는 법적으로 필요하다 — 증거 시각(consent_at)은 기본값으로 채우지 않는다.

import type { MarketingConsentMethod, MarketingContactImportRow } from '../../types';

// ── CSV(RFC 4180 에 가깝게) ─────────────────────────────────────────────────

export interface CsvParseResult {
  headers: string[];
  rows: string[][];
  /** 각 데이터 행이 원본의 몇 번째 줄에서 시작했는가(1부터, 머리글 포함). */
  lines: number[];
  delimiter: string;
  error: string | null;
}

/** 첫 줄에서 따옴표 밖의 , ; 탭 개수로 구분자를 고른다(엑셀 지역 설정은 ; 를 쓰기도 한다). */
export function detectDelimiter(text: string): string {
  const firstLine: string[] = [];
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    firstLine.push(ch);
  }
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<string, number>;
  inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ',';
}

/**
 * 따옴표 안의 구분자 · 줄바꿈 · `""`(따옴표 하나)를 처리한다. BOM 을 지우고, 빈 줄은 건너뛰고,
 * CRLF · LF · CR 을 모두 줄 끝으로 본다. 닫히지 않은 따옴표는 오류다(그 뒤가 전부 한 칸이 된다).
 */
export function parseCsv(input: string, delimiter?: string): CsvParseResult {
  const text = (input || '').replace(/^﻿/, '');
  const delim = delimiter || detectDelimiter(text);
  const records: string[][] = [];
  const starts: number[] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let quotedField = false;
  let line = 1;
  let recordLine = 1;

  const endField = () => {
    record.push(field);
    field = '';
    quotedField = false;
  };
  const endRecord = () => {
    endField();
    const empty = record.length === 1 && record[0].trim() === '';
    if (!empty) {
      records.push(record);
      starts.push(recordLine);
    }
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === '' && !quotedField) {
      // 칸의 시작(앞 공백 허용)에서만 따옴표가 열린다. 칸 중간의 " 는 글자다.
      field = '';
      inQuotes = true;
      quotedField = true;
    } else if (ch === delim) {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    return { headers: [], rows: [], lines: [], delimiter: delim, error: translate('{0}번째 줄에서 시작한 따옴표가 닫히지 않았습니다', { 0: recordLine }) };
  }
  if (field !== '' || record.length > 0) endRecord();

  if (!records.length) return { headers: [], rows: [], lines: [], delimiter: delim, error: translate('내용이 없습니다') };
  const [headerRow, ...rows] = records;
  const [, ...lines] = starts;
  return { headers: headerRow.map((h) => h.trim()), rows, lines, delimiter: delim, error: null };
}

// ── 열 이름 → 연락처 필드 ──────────────────────────────────────────────────

export const CONTACT_FIELDS = [
  'email',
  'name',
  'lists',
  'consent_method',
  'consent_source',
  'consent_at',
  'consent_text_version',
  'consent_ip',
  'night_consent',
  'country',
  'timezone',
] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

export const CONTACT_FIELD_LABELS: Record<ContactField, string> = {
  get email() { return translate('이메일 *'); },
  get name() { return translate('이름'); },
  get lists() { return translate('수신 목록'); },
  get consent_method() { return translate('동의 방법 *'); },
  get consent_source() { return translate('동의 출처 *'); },
  get consent_at() { return translate('동의 시각 *'); },
  get consent_text_version() { return translate('동의 문구 버전'); },
  get consent_ip() { return translate('동의 IP'); },
  get night_consent() { return translate('야간 수신 동의'); },
  get country() { return translate('국가(ISO 2자리)'); },
  get timezone() { return translate('시간대(IANA)'); },
};

/** 서버 CONSENT_METHODS 와 같은 목록. */
export const CONSENT_METHODS: MarketingConsentMethod[] = ['signup_form', 'checkout', 'event', 'import', 'other'];
export const CONSENT_METHOD_LABELS: Record<string, string> = {
  get signup_form() { return translate('가입 폼'); },
  get checkout() { return translate('결제 과정'); },
  get event() { return translate('이벤트 · 행사'); },
  get import() { return translate('다른 시스템에서 이전'); },
  get other() { return translate('기타'); },
  // 가져오기로는 쓸 수 없다 — 재확인 안내의 유지 링크를 누른 사람(서버 RECONFIRM_CONSENT_METHOD).
  get reconfirm() { return translate('재확인 안내 — 유지'); },
};

/** 공백 · _ · - · . 을 지우고 소문자로 — `Consent At` 와 `consent_at` 이 같은 열이 된다. */
export function normalizeHeader(header: string): string {
  return (header || '').trim().toLowerCase().replace(/[\s_\-.()/]+/g, '');
}

const HEADER_ALIASES: Record<ContactField, string[]> = {
  email: ['email', 'emailaddress', 'mail', 'e-mail', '이메일', '메일', '이메일주소'],
  name: ['name', 'fullname', 'displayname', '이름', '성명'],
  lists: ['lists', 'list', 'listname', '목록', '수신목록', '리스트'],
  consent_method: ['consentmethod', 'method', '동의방법'],
  consent_source: ['consentsource', 'source', '동의출처', '출처'],
  consent_at: ['consentat', 'consentedat', 'consentdate', 'consenttime', 'optinat', '동의시각', '동의일시', '동의일'],
  consent_text_version: ['consenttextversion', 'textversion', 'consentversion', '동의문구버전'],
  consent_ip: ['consentip', 'ip', 'ipaddress', '동의ip'],
  night_consent: ['nightconsent', 'night', '야간동의', '야간수신동의'],
  country: ['country', 'countrycode', '국가'],
  timezone: ['timezone', 'tz', 'timezonename', '시간대'],
};

export type ContactMapping = Record<ContactField, number>;

/** 알려진 이름(영문 · 한글 별칭)으로 열을 찾는다. 못 찾은 필드는 -1. */
export function autoMapHeaders(headers: string[]): ContactMapping {
  const normalized = headers.map(normalizeHeader);
  const mapping = {} as ContactMapping;
  for (const field of CONTACT_FIELDS) {
    const aliases = HEADER_ALIASES[field].map(normalizeHeader);
    mapping[field] = normalized.findIndex((h) => aliases.includes(h));
  }
  return mapping;
}

// ── 검증 · 가져오기 본문 ────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const LIST_RE = /^[a-z0-9][a-z0-9 _.-]*$/;
/** 서버 MAX_IMPORT — 한 번의 가져오기 요청에 실을 수 있는 최대 연락처 수. */
export const MAX_IMPORT_PER_REQUEST = 5000;

export function isEmailAddress(value: string): boolean {
  return EMAIL_RE.test(value) && value.length <= 254;
}

/** 수신 목록 이름 — 서버 normalizeListName 과 같다(소문자, 영문 · 숫자 · 공백 · _ . -). 틀리면 null. */
export function normalizeListName(value: string): string | null {
  const name = (value || '').trim().toLowerCase();
  if (!name || name.length > 100 || !LIST_RE.test(name)) return null;
  return name;
}

/** 칸 하나에 여러 목록을 ; | , 로 적는다. */
export function splitLists(cell: string): string[] {
  return (cell || '').split(/[;|,]/).map((s) => s.trim()).filter(Boolean);
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'o', '예', '네', '동의']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'x', '아니오', '아니요', '미동의']);

/** '' → undefined(보내지 않음), 알 수 없는 값 → 'invalid'. */
export function parseBooleanCell(cell: string): boolean | undefined | 'invalid' {
  const v = (cell || '').trim().toLowerCase();
  if (!v) return undefined;
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  return 'invalid';
}

/** 동의 시각 — ISO · `YYYY-MM-DD` · `YYYY-MM-DD HH:mm[:ss]`(시간대 없으면 이 브라우저의 현지 시각). */
export function parseConsentAt(cell: string): Date | null {
  const v = (cell || '').trim();
  if (!v) return null;
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? v.replace(' ', 'T') : v;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ContactImportDefaults {
  /** 모든 행에 더하는 수신 목록. */
  lists: string[];
  /** 열이 없거나 칸이 비었을 때 쓰는 동의 방법(사람이 그 목록의 출처를 알 때). '' 면 없음. */
  consent_method: string;
  /** 열이 없거나 칸이 비었을 때 쓰는 동의 출처(가입 폼 주소 등). '' 면 없음. */
  consent_source: string;
}

export interface ContactRowResult {
  /** 원본 파일의 줄 번호. */
  line: number;
  email: string;
  contact: MarketingContactImportRow | null;
  errors: string[];
}

export interface ContactImportPlan {
  rows: ContactRowResult[];
  /** 보낼 연락처(검증 통과) — `validLines[i]` 가 그 원본 줄. */
  valid: MarketingContactImportRow[];
  validLines: number[];
  invalidCount: number;
  /** 기본 목록의 이름이 틀렸을 때 — 이 경우 아무것도 보내지 않는다. */
  defaultListErrors: string[];
}

/**
 * 파싱한 CSV · 열 매핑 · 기본값 → 행마다의 연락처와 오류. 서버가 받지 않을 행은 미리 걸러 보여 주고,
 * 같은 파일 안의 중복 주소는 처음 것만 남긴다(뒤엣것이 앞의 동의 증거를 덮지 않게).
 */
export function buildContactImport(
  parsed: Pick<CsvParseResult, 'rows' | 'lines'>,
  mapping: ContactMapping,
  defaults: ContactImportDefaults,
  now: Date = new Date(),
): ContactImportPlan {
  const defaultListErrors: string[] = [];
  const defaultLists: string[] = [];
  for (const raw of defaults.lists) {
    const name = normalizeListName(raw);
    if (name) {
      if (!defaultLists.includes(name)) defaultLists.push(name);
    } else {
      defaultListErrors.push(translate('기본 목록 이름 "{0}" 은 영문 소문자 · 숫자 · 공백 · _ . - 만 쓸 수 있습니다', { 0: raw }));
    }
  }
  const seen = new Set<string>();
  const rows: ContactRowResult[] = [];
  const valid: MarketingContactImportRow[] = [];
  const validLines: number[] = [];

  parsed.rows.forEach((row, i) => {
    const line = parsed.lines[i] ?? i + 2;
    const get = (field: ContactField) => (mapping[field] >= 0 ? (row[mapping[field]] ?? '').trim() : '');
    const errors: string[] = [];
    const email = get('email').toLowerCase();
    if (!isEmailAddress(email)) errors.push(email ? translate('이메일 주소가 아닙니다: {0}', { 0: email }) : translate('이메일이 비었습니다'));
    else if (seen.has(email)) errors.push(translate('파일 안에서 중복된 주소입니다(처음 행만 가져옵니다)'));

    const method = get('consent_method') || defaults.consent_method;
    if (!(CONSENT_METHODS as string[]).includes(method)) {
      errors.push(method
        ? translate('동의 방법 "{0}" 은 {1} 중 하나여야 합니다', { 0: method, 1: CONSENT_METHODS.join(' · ') })
        : translate('동의 방법(consent_method)이 없습니다'));
    }
    const source = get('consent_source') || defaults.consent_source.trim();
    if (!source) errors.push(translate('동의 출처(consent_source)가 없습니다 — 어디서 동의했는지 적어야 합니다'));
    else if (source.length > 300) errors.push(translate('동의 출처는 300자까지입니다'));

    const consentCell = get('consent_at');
    const consentAt = parseConsentAt(consentCell);
    if (!consentCell) errors.push(translate('동의 시각(consent_at)이 없습니다 — 동의한 시각은 증거라 비워 둘 수 없습니다'));
    else if (!consentAt) errors.push(translate('동의 시각을 읽을 수 없습니다: {0}', { 0: consentCell }));
    else if (consentAt.getTime() > now.getTime() + 60_000) errors.push(translate('동의 시각이 미래입니다'));

    const rowLists: string[] = [];
    for (const raw of splitLists(get('lists'))) {
      const name = normalizeListName(raw);
      if (!name) errors.push(translate('목록 이름 "{0}" 은 영문 소문자 · 숫자 · 공백 · _ . - 만 쓸 수 있습니다', { 0: raw }));
      else if (!rowLists.includes(name)) rowLists.push(name);
    }
    if (!rowLists.length && !defaultLists.length) errors.push(translate('수신 목록이 없습니다 — 기본 목록을 정하거나 lists 열을 넣으세요'));

    const night = parseBooleanCell(get('night_consent'));
    if (night === 'invalid') errors.push(translate('야간 수신 동의는 true / false 로 적어 주세요: {0}', { 0: get('night_consent') }));

    const country = get('country').toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) errors.push(translate('국가는 ISO 3166-1 두 글자여야 합니다: {0}', { 0: get('country') }));

    const timezone = get('timezone');
    if (timezone && !isValidTimezone(timezone)) errors.push(translate('알 수 없는 시간대입니다: {0}', { 0: timezone }));

    if (!errors.length && consentAt) {
      seen.add(email);
      const contact: MarketingContactImportRow = {
        email,
        consent_method: method as MarketingConsentMethod,
        consent_source: source,
        consent_at: consentAt.toISOString(),
      };
      const name = get('name');
      if (name) contact.name = name;
      if (rowLists.length) contact.lists = rowLists;
      const textVersion = get('consent_text_version');
      if (textVersion) contact.consent_text_version = textVersion;
      const ip = get('consent_ip');
      if (ip) contact.consent_ip = ip;
      if (night === true || night === false) contact.night_consent = night;
      if (country) contact.country = country;
      if (timezone) contact.timezone = timezone;
      rows.push({ line, email, contact, errors });
      valid.push(contact);
      validLines.push(line);
    } else {
      rows.push({ line, email, contact: null, errors });
    }
  });

  return {
    rows,
    valid: defaultListErrors.length ? [] : valid,
    validLines: defaultListErrors.length ? [] : validLines,
    invalidCount: rows.filter((r) => r.errors.length).length,
    defaultListErrors,
  };
}

/** 서버 한도(한 요청 5,000명)에 맞춰 나눈다. */
export function chunkContacts<T>(items: T[], size: number = MAX_IMPORT_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
