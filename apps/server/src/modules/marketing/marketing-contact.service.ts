import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MarketingBrand } from '../../entities/MarketingBrand';
import { MarketingContactConsent } from '../../entities/MarketingContactConsent';
import { MarketingContactReply } from '../../entities/MarketingContactReply';
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

  private get consents() { return this.contactRepo.manager.getRepository(MarketingContactConsent); }
  private get brands() { return this.contactRepo.manager.getRepository(MarketingBrand); }

  /** Human-only account inbox, independent of campaign feedback. */
  async listReplies(accountId: string, offset = 0) {
    const skip = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const [rows, total] = await this.contactRepo.manager.getRepository(MarketingContactReply).findAndCount({
      where: { account_id: accountId }, order: { created_at: 'DESC', id: 'DESC' }, take: 50, skip,
    });
    const contacts = rows.length ? await this.contactRepo.find({
      where: { account_id: accountId, id: In(rows.map((r) => r.contact_id)) }, select: ['id', 'email', 'name'],
    }) : [];
    const byId = new Map(contacts.map((c) => [c.id, c]));
    return { total, replies: rows.map(({ source_key, account_id, ...row }) => ({
      ...row, contact: byId.get(row.contact_id) || null,
    })) };
  }

  async listBrands(accountId: string) {
    return this.brands.find({ where: { account_id: accountId }, order: { created_at: 'ASC' } });
  }

  async getBrand(id: string, accountId: string) {
    const row = id && accountId ? await this.brands.findOneBy({ id, account_id: accountId }) : null;
    if (!row) throw marketingError(404, 'brand not found');
    return row;
  }

  async createBrand(accountId: string, name: unknown, actor: MarketingActor) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw marketingError(400, 'brand name is required (max 120 characters, no control characters)');
    const row = await this.brands.save(this.brands.create({ account_id: accountId, name: name.trim() }));
    await this.audit.record({ accountId, campaignId: '', entityType: 'contact', entityId: row.id,
      action: 'brand.created', actor, summary: `발신자 생성: ${row.name}` });
    return row;
  }

  async consentFor(contactId: string, accountId: string, brandId: string) {
    if (!brandId || !accountId || !contactId) return null;
    return this.consents.findOneBy({ contact_id: contactId, account_id: accountId, brand_id: brandId });
  }

  /** Explicit operator selection consumes each legacy record once; never infer brand ownership from list/channel names. */
  async migrateLegacy(accountId: string, brandId: string, contactIds: unknown, actor: MarketingActor) {
    await this.getBrand(brandId, accountId);
    if (!Array.isArray(contactIds) || !contactIds.length || contactIds.length > MAX_IMPORT || contactIds.some((id) => typeof id !== 'string')) {
      throw marketingError(400, 'contact_ids must select 1–5000 contacts');
    }
    const count = await this.contactRepo.manager.transaction(async (manager) => {
      const contacts = manager.getRepository(MarketingContact);
      const consents = manager.getRepository(MarketingContactConsent);
      let migrated = 0;
      for (const id of [...new Set(contactIds as string[])]) {
        let c = await contacts.findOneBy({ id, account_id: accountId });
        if (!c) throw marketingError(404, 'contact not found');
        if (c.legacy_consent_migrated) continue;
        const claim = await contacts.update({ id, account_id: accountId, legacy_consent_migrated: false }, { legacy_consent_migrated: true });
        if (!claim.affected) continue;
        c = (await contacts.findOneBy({ id, account_id: accountId }))!;
        if (!await consents.findOneBy({ contact_id: id, account_id: accountId, brand_id: brandId })) {
          await consents.save(consents.create({ ...this.evidence(c), account_id: accountId, contact_id: id, brand_id: brandId,
            status: c.status, unsubscribed_at: c.unsubscribed_at, unsubscribe_source: c.unsubscribe_source,
            unsubscribe_token: newUnsubscribeToken() }));
          migrated++;
        }
      }
      return migrated;
    });
    await this.audit.record({ accountId, campaignId: '', entityType: 'contact', entityId: brandId,
      action: 'consent.legacy_migrated', actor, summary: `기존 동의 ${count}건 발신자 귀속`, detail: { brand_id: brandId, contact_ids: contactIds, migrated: count } });
    return { migrated: count };
  }

  private evidence(c: MarketingContact | MarketingContactConsent) {
    return { consent_method: c.consent_method, consent_source: c.consent_source, consent_at: c.consent_at,
      consent_renewed_at: c.consent_renewed_at, consent_text_version: c.consent_text_version,
      consent_ip: c.consent_ip, night_consent: c.night_consent };
  }

  async list(accountId: string, opts: { brand_id?: string; list?: string; status?: string; q?: string; limit?: number; offset?: number } = {}) {
    const qb = this.contactRepo.createQueryBuilder('c').where('c.account_id = :a', { a: accountId });
    if (opts.brand_id) await this.getBrand(opts.brand_id, accountId);
    if (opts.status && !opts.brand_id) qb.andWhere('c.status = :s', { s: opts.status });
    if (opts.q) qb.andWhere('(c.email LIKE :q OR c.name LIKE :q)', { q: `%${opts.q.toLowerCase()}%` });
    qb.orderBy('c.created_at', 'DESC');
    const rows = await qb.getMany();
    let filtered = opts.list ? rows.filter((c) => (c.lists || []).includes(opts.list!.toLowerCase())) : rows;
    const consents = await this.consents.find({ where: { account_id: accountId, ...(opts.brand_id ? { brand_id: opts.brand_id } : {}) } });
    if (opts.brand_id) filtered = filtered.filter((c) => consents.some((v) => v.contact_id === c.id && (!opts.status || v.status === opts.status)));
    const offset = Math.max(opts.offset || 0, 0);
    const limit = Math.min(Math.max(opts.limit || 100, 1), 1000);
    return { total: filtered.length, contacts: filtered.slice(offset, offset + limit).map((c) => Object.assign(c, { consents: consents.filter((v) => v.contact_id === c.id) })) };
  }

  async get(id: string, accountId: string): Promise<MarketingContact> {
    const row = id ? await this.contactRepo.findOne({ where: { id } }) : null;
    if (!row || (!accountId || row.account_id !== accountId)) throw marketingError(404, 'contact not found');
    return row;
  }

  /** 그 계정의 연락처 몇 개(사람용 화면이 답장한 사람을 보여 줄 때). 다른 계정 · 없는 id 는 빠진다. */
  async byIds(accountId: string, ids: string[]): Promise<Map<string, MarketingContact>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!accountId || !unique.length) return new Map();
    const rows = await this.contactRepo.find({ where: { account_id: accountId, id: In(unique) } });
    return new Map(rows.map((c) => [c.id, c]));
  }

  /** 목록의 발송 대상 — subscribed · 주소 있음 · 동의 2 년 이내(재확인 안내로 이어진 기간 포함). 빠진 수도 같이 센다. */
  async eligible(accountId: string, listName: string, now: Date = new Date(), brandId?: string) {
    const all = await this.contactRepo.find({ where: { account_id: accountId } });
    const inList = all.filter((c) => (c.lists || []).includes(listName));
    const out = { contacts: [] as MarketingContact[], excluded: { not_subscribed: 0, consent_expired: 0 } };
    const consents = brandId ? await this.consents.find({ where: { account_id: accountId, brand_id: brandId } }) : [];
    const byContact = new Map(consents.map((c) => [c.contact_id, c]));
    for (const c of inList) {
      const consent = byContact.get(c.id);
      if (c.status !== 'subscribed' || !c.email || !consent || consent.status !== 'subscribed') out.excluded.not_subscribed++;
      else if (!consentFresh(consent, now)) out.excluded.consent_expired++;
      else out.contacts.push(Object.assign(c, this.evidence(consent), { unsubscribe_token: consent.unsubscribe_token }));
    }
    return out;
  }

  async import(accountId: string, body: Record<string, unknown>, actor: MarketingActor): Promise<ImportResult> {
    const brand = await this.getBrand(String(body.brand_id || ''), accountId);
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
        const prior = existing ? await this.consentFor(existing.id, accountId, brand.id) : null;
        if (prior && prior.status !== 'subscribed') { result.suppressed++; continue; }
        const evidence = {
          consent_method: method, consent_source: source, consent_at: consentAt,
          consent_renewed_at: null,
          consent_text_version: typeof c.consent_text_version === 'string' ? c.consent_text_version.trim().slice(0, 100) : '',
          consent_ip: typeof c.consent_ip === 'string' ? c.consent_ip.trim().slice(0, 64) : '',
          night_consent: c.night_consent === true,
        };
        await this.contactRepo.manager.transaction(async (manager) => {
          const contacts = manager.getRepository(MarketingContact);
          const consents = manager.getRepository(MarketingContactConsent);
          let contact = existing;
          if (contact) {
            // Update identity only; legacy evidence belongs to its eventual explicitly chosen brand.
            const active = await contacts.update({ id: contact.id, account_id: accountId, status: 'subscribed' }, {
              lists: [...new Set([...(contact.lists || []), ...lists])],
              ...(typeof c.name === 'string' && c.name.trim() ? { name: c.name.trim().slice(0, 200) } : {}),
              ...(country ? { country } : {}), timezone,
            });
            if (!active.affected) throw marketingError(409, 'contact is globally suppressed');
          } else {
            contact = await contacts.save(contacts.create({ ...evidence, account_id: accountId, email, email_hash: hash,
              name: typeof c.name === 'string' ? c.name.trim().slice(0, 200) : '', lists, status: 'subscribed', country, timezone,
              legacy_consent_migrated: true, unsubscribe_token: newUnsubscribeToken(), created_by: actor.id }));
          }
          if (prior) {
            if (consentAt.getTime() > new Date(prior.consent_at).getTime()) {
              await consents.createQueryBuilder().update(MarketingContactConsent).set(evidence)
                .where('id = :id AND status = :status AND consent_at < :at', { id: prior.id, status: 'subscribed', at: consentAt })
                .andWhere('(consent_renewed_at IS NULL OR consent_renewed_at < :at)', { at: consentAt })
                .execute();
            }
          } else {
            await consents.save(consents.create({ ...evidence, account_id: accountId, contact_id: contact.id,
              brand_id: brand.id, status: 'subscribed', unsubscribe_token: newUnsubscribeToken() }));
          }
        });
        if (existing) result.updated++; else result.created++;
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
      detail: { brand_id: brand.id, created: result.created, updated: result.updated, suppressed: result.suppressed, invalid: result.invalid.length },
    });
    return result;
  }

  /** 공개 수신거부. 토큰이 없거나 이미 처리됐어도 같은 결과를 돌려준다(호출자는 구분하지 않는다). */
  async unsubscribeByToken(token: string, source: 'link' | 'one_click' | 'mailto' | 'provider'): Promise<(MarketingContact & { brand_id?: string }) | null> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token || '')) return null;
    const consent = await this.consents.findOneBy({ unsubscribe_token: token });
    if (consent) {
      const contact = await this.contactRepo.findOneBy({ id: consent.contact_id, account_id: consent.account_id });
      if (!contact || contact.status !== 'subscribed' || consent.status !== 'subscribed') return null;
      const at = new Date();
      const won = await this.consents.update({ id: consent.id, status: 'subscribed' }, { status: 'unsubscribed', unsubscribed_at: at, unsubscribe_source: source });
      if (!won.affected) return null;
      await this.audit.record({ accountId: contact.account_id, campaignId: '', entityType: 'contact', entityId: contact.id,
        action: 'contact.unsubscribed', actor: { type: 'public', id: '', name: 'recipient' }, summary: '발신자 수신거부', detail: { source, brand_id: consent.brand_id } });
      return Object.assign(contact, { brand_id: consent.brand_id, status: 'unsubscribed', unsubscribed_at: at, unsubscribe_source: source });
    }
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
  async markUnsubscribed(id: string, accountId: string, actor: MarketingActor, note = '', brandId?: string): Promise<MarketingContact> {
    const row = await this.get(id, accountId);
    if (brandId) {
      await this.getBrand(brandId, accountId);
      const consent = await this.consentFor(id, accountId, brandId);
      if (!consent) throw marketingError(404, 'consent not found');
      await this.consents.update({ id: consent.id, status: 'subscribed' }, { status: 'unsubscribed', unsubscribed_at: new Date(), unsubscribe_source: 'manual' });
      await this.audit.record({ accountId, campaignId: '', entityType: 'contact', entityId: id, action: 'contact.unsubscribed', actor,
        summary: '발신자 수신거부 기록(수동)', detail: { brand_id: brandId, note: note.slice(0, 500) } });
      return row;
    }
    if (row.status === 'erased') throw marketingError(409, 'contact was erased');
    row.status = 'unsubscribed';
    row.unsubscribed_at = new Date();
    row.unsubscribe_source = 'manual';
    await this.contactRepo.createQueryBuilder().update(MarketingContact)
      .set({ status: 'unsubscribed', unsubscribed_at: row.unsubscribed_at, unsubscribe_source: 'manual' })
      .where('id = :id AND account_id = :accountId AND status != :erased', { id, accountId, erased: 'erased' }).execute();
    const saved = await this.get(id, accountId);
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
    const saved = await this.contactRepo.manager.transaction(async (manager) => {
      // Lock/update the identity before scrubbing consent evidence, matching import/migration lock order.
      const contacts = manager.getRepository(MarketingContact);
      await contacts.update({ id, account_id: accountId }, {
        email: null, name: '', consent_ip: '', status: 'erased', lists: [],
        unsubscribed_at: row.unsubscribed_at, unsubscribe_source: row.unsubscribe_source, unsubscribe_token: row.unsubscribe_token,
      });
      const saved = (await contacts.findOneBy({ id, account_id: accountId }))!;
      await manager.getRepository(MarketingContactConsent).update({ contact_id: id, account_id: accountId }, { consent_ip: '', status: 'erased' });
      return saved;
    });
    await this.audit.record({
      accountId: row.account_id, campaignId: '', entityType: 'contact', entityId: row.id, action: 'contact.erased', actor,
      summary: '연락처 삭제(억제 해시만 보존)',
    });
    return saved;
  }
}
