import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketingContact } from '../../entities/MarketingContact';
import { consentFresh, emailHash, isValidTimezone } from '../../common/marketing/email';
import type { MarketingActor } from '../../common/marketing/marketing-constants';
import { MarketingAuditService } from './marketing-audit.service';
import { marketingError } from './marketing-errors';
import { isEmailAddress, normalizeListName } from './marketing-channel.logic';

export const CONSENT_METHODS = ['signup_form', 'checkout', 'event', 'import', 'other'] as const;
const MAX_IMPORT = 5000;

export interface ImportResult {
  created: number;
  updated: number;
  suppressed: number;
  invalid: Array<{ index: number; email: string; error: string }>;
}

export function newUnsubscribeToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * MarketingContactService — 동의 연락처(docs/marketing.md "메일").
 *
 * 가져오기는 동의 증거를 같이 받아야 한다(방법 · 시각 · 출처). 이미 수신거부 · 삭제된 주소는 가져오기로
 * 되살리지 않는다(억제) — 다시 받으려면 그 사람이 새로 동의해야 하고, 그건 AWB 밖(가입 폼)의 일이다.
 * 에이전트용 경로는 없다.
 */
@Injectable()
export class MarketingContactService {
  constructor(
    @InjectRepository(MarketingContact) private readonly contactRepo: Repository<MarketingContact>,
    private readonly audit: MarketingAuditService,
  ) {}

  async list(accountId: string, opts: { list?: string; status?: string; q?: string; limit?: number; offset?: number } = {}) {
    const qb = this.contactRepo.createQueryBuilder('c').where('c.account_id = :a', { a: accountId });
    if (opts.status) qb.andWhere('c.status = :s', { s: opts.status });
    if (opts.q) qb.andWhere('(c.email LIKE :q OR c.name LIKE :q)', { q: `%${opts.q.toLowerCase()}%` });
    qb.orderBy('c.created_at', 'DESC');
    const rows = await qb.getMany();
    const filtered = opts.list ? rows.filter((c) => (c.lists || []).includes(opts.list!.toLowerCase())) : rows;
    const offset = Math.max(opts.offset || 0, 0);
    const limit = Math.min(Math.max(opts.limit || 100, 1), 1000);
    return { total: filtered.length, contacts: filtered.slice(offset, offset + limit) };
  }

  async get(id: string, accountId: string): Promise<MarketingContact> {
    const row = id ? await this.contactRepo.findOne({ where: { id } }) : null;
    if (!row || (accountId && row.account_id !== accountId)) throw marketingError(404, 'contact not found');
    return row;
  }

  /** 목록의 발송 대상 — subscribed · 주소 있음 · 동의 2 년 이내. 빠진 수도 같이 센다. */
  async eligible(accountId: string, listName: string, now: Date = new Date()) {
    // 발송 판단에 필요한 칼럼만 읽는다(사이클 · get_marketing_campaign 마다 불린다).
    const all = await this.contactRepo.find({
      where: { account_id: accountId },
      select: ['id', 'account_id', 'email', 'lists', 'status', 'consent_at'],
    });
    const inList = all.filter((c) => (c.lists || []).includes(listName));
    const out = { contacts: [] as MarketingContact[], excluded: { not_subscribed: 0, consent_expired: 0 } };
    for (const c of inList) {
      if (c.status !== 'subscribed' || !c.email) out.excluded.not_subscribed++;
      else if (!consentFresh(c.consent_at, now)) out.excluded.consent_expired++;
      else out.contacts.push(c);
    }
    return out;
  }

  async import(accountId: string, body: Record<string, unknown>, actor: MarketingActor): Promise<ImportResult> {
    const list = body.contacts;
    if (!Array.isArray(list) || !list.length) throw marketingError(400, 'contacts must be a non-empty array');
    if (list.length > MAX_IMPORT) throw marketingError(400, `at most ${MAX_IMPORT} contacts per import`);
    const defaultLists = Array.isArray(body.lists) ? body.lists.map(normalizeListName) : [];
    const result: ImportResult = { created: 0, updated: 0, suppressed: 0, invalid: [] };
    const now = Date.now();
    for (const [index, raw] of list.entries()) {
      const c = (raw || {}) as Record<string, unknown>;
      const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
      try {
        if (!isEmailAddress(email)) throw new Error('not an email address');
        const method = typeof c.consent_method === 'string' ? c.consent_method.trim() : '';
        if (!(CONSENT_METHODS as readonly string[]).includes(method)) throw new Error(`consent_method must be one of: ${CONSENT_METHODS.join(', ')}`);
        const source = typeof c.consent_source === 'string' ? c.consent_source.trim().slice(0, 300) : '';
        if (!source) throw new Error('consent_source is required (where the consent was given)');
        const consentAt = new Date(String(c.consent_at || ''));
        if (Number.isNaN(consentAt.getTime())) throw new Error('consent_at is required (when the consent was given)');
        if (consentAt.getTime() > now + 60_000) throw new Error('consent_at is in the future');
        const timezone = typeof c.timezone === 'string' && c.timezone.trim() ? c.timezone.trim() : 'Asia/Seoul';
        if (!isValidTimezone(timezone)) throw new Error(`unknown timezone ${timezone}`);
        const country = typeof c.country === 'string' ? c.country.trim().toUpperCase() : '';
        if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('country must be ISO 3166-1 alpha-2');
        const lists = [...new Set([...defaultLists, ...(Array.isArray(c.lists) ? c.lists.map(normalizeListName) : [])])];
        if (!lists.length) throw new Error('at least one list is required');
        const hash = emailHash(email);
        const existing = await this.contactRepo.findOne({ where: { account_id: accountId, email_hash: hash } });
        if (existing && existing.status !== 'subscribed') {
          result.suppressed++;
          continue;
        }
        if (existing) {
          existing.lists = [...new Set([...(existing.lists || []), ...lists])];
          if (typeof c.name === 'string' && c.name.trim()) existing.name = c.name.trim().slice(0, 200);
          // 더 새로운 동의가 오면 증거를 그것으로 바꾼다(2 년 기한도 다시 센다).
          if (consentAt.getTime() > new Date(existing.consent_at).getTime()) {
            existing.consent_method = method;
            existing.consent_source = source;
            existing.consent_at = consentAt;
            existing.consent_text_version = typeof c.consent_text_version === 'string' ? c.consent_text_version.trim().slice(0, 100) : '';
            existing.consent_ip = typeof c.consent_ip === 'string' ? c.consent_ip.trim().slice(0, 64) : '';
          }
          if (c.night_consent !== undefined) existing.night_consent = c.night_consent === true;
          if (country) existing.country = country;
          existing.timezone = timezone;
          await this.contactRepo.save(existing);
          result.updated++;
          continue;
        }
        await this.contactRepo.save(this.contactRepo.create({
          account_id: accountId,
          email,
          email_hash: hash,
          name: typeof c.name === 'string' ? c.name.trim().slice(0, 200) : '',
          lists,
          status: 'subscribed',
          consent_method: method,
          consent_source: source,
          consent_at: consentAt,
          consent_text_version: typeof c.consent_text_version === 'string' ? c.consent_text_version.trim().slice(0, 100) : '',
          consent_ip: typeof c.consent_ip === 'string' ? c.consent_ip.trim().slice(0, 64) : '',
          night_consent: c.night_consent === true,
          country,
          timezone,
          unsubscribe_token: newUnsubscribeToken(),
          unsubscribed_at: null,
          unsubscribe_source: '',
          created_by: actor.id,
        }));
        result.created++;
      } catch (e: any) {
        result.invalid.push({ index, email, error: String(e?.message || e) });
      }
    }
    await this.audit.record({
      accountId,
      campaignId: '',
      entityType: 'contact',
      entityId: '',
      action: 'contacts.imported',
      actor,
      summary: `연락처 가져오기: 새로 ${result.created} · 갱신 ${result.updated} · 억제 ${result.suppressed} · 오류 ${result.invalid.length}`,
      detail: { created: result.created, updated: result.updated, suppressed: result.suppressed, invalid: result.invalid.length },
    });
    return result;
  }

  /** 공개 수신거부. 토큰이 없거나 이미 처리됐어도 같은 결과를 돌려준다(호출자는 구분하지 않는다). */
  async unsubscribeByToken(token: string, source: 'link' | 'one_click'): Promise<MarketingContact | null> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token || '')) return null;
    const contact = await this.contactRepo.findOne({ where: { unsubscribe_token: token } });
    if (!contact || contact.status !== 'subscribed') return null;
    const won = await this.contactRepo.createQueryBuilder().update(MarketingContact)
      .set({ status: 'unsubscribed', unsubscribed_at: new Date(), unsubscribe_source: source })
      .where('id = :id AND status = :s', { id: contact.id, s: 'subscribed' })
      .execute();
    if (!won.affected) return null;
    await this.audit.record({
      accountId: contact.account_id,
      campaignId: '',
      entityType: 'contact',
      entityId: contact.id,
      action: 'contact.unsubscribed',
      actor: { type: 'public', id: '', name: 'recipient' },
      summary: `수신거부(${source === 'one_click' ? '메일 앱 원클릭' : '링크'})`,
      detail: { source },
    });
    return (await this.contactRepo.findOne({ where: { id: contact.id } }))!;
  }

  /** 사람이 다른 경로(전화 · 답장)로 받은 수신거부를 기록한다. */
  async markUnsubscribed(id: string, accountId: string, actor: MarketingActor, note = ''): Promise<MarketingContact> {
    const row = await this.get(id, accountId);
    if (row.status === 'erased') throw marketingError(409, 'contact was erased');
    row.status = 'unsubscribed';
    row.unsubscribed_at = new Date();
    row.unsubscribe_source = 'manual';
    const saved = await this.contactRepo.save(row);
    await this.audit.record({
      accountId: row.account_id, campaignId: '', entityType: 'contact', entityId: row.id, action: 'contact.unsubscribed', actor,
      summary: '수신거부 기록(수동)', detail: { source: 'manual', note: note.slice(0, 500) },
    });
    return saved;
  }

  /** 삭제 요청 — 주소 · 이름을 지우고 억제용 해시만 남긴다. */
  async erase(id: string, accountId: string, actor: MarketingActor): Promise<MarketingContact> {
    const row = await this.get(id, accountId);
    row.email = null;
    row.name = '';
    row.consent_ip = '';
    row.status = 'erased';
    row.lists = [];
    row.unsubscribed_at = row.unsubscribed_at || new Date();
    row.unsubscribe_source = row.unsubscribe_source || 'manual';
    // 토큰도 바꿔 예전 메일의 수신거부 링크가 이 행을 가리키지 않게 한다(어차피 이미 억제됨).
    row.unsubscribe_token = newUnsubscribeToken();
    const saved = await this.contactRepo.save(row);
    await this.audit.record({
      accountId: row.account_id, campaignId: '', entityType: 'contact', entityId: row.id, action: 'contact.erased', actor,
      summary: '연락처 삭제(억제 해시만 보존)',
    });
    return saved;
  }
}
