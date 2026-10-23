import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Between, DataSource, EntityManager, MoreThan } from 'typeorm';
import { z } from 'zod';
import { BusinessCashEntry } from '../../entities/BusinessCashEntry';
import { BusinessCashMonth } from '../../entities/BusinessCashMonth';
import { BusinessService } from './business.service';
import { assessSelfService, SELF_SERVICE_VERSION } from './business-self-service';

export const CASH_KINDS = ['income', 'expense', 'capital_in', 'capital_out', 'loan_in', 'loan_out', 'transfer_in', 'transfer_out', 'refund_in', 'refund_out'] as const;
export const cashMonthSchema = z.string().regex(/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const date = new Date(v);
  return cashMonthSchema.safeParse(v.slice(0, 7)).success && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
});
const balance = z.number().int().min(-2_000_000_000).max(2_000_000_000);
export const cashEntrySchema = z.object({
  request_id: z.string().uuid(), date: dateSchema, kind: z.enum(CASH_KINDS),
  amount_minor: z.number().int().positive().max(2_000_000_000), currency: z.literal('USD'),
  description: z.string().trim().min(1).max(500), evidence: z.string().trim().max(1000),
});
export const cashReconcileSchema = z.object({ evidence: z.string().trim().min(1).max(1000), reconciled: z.boolean() });
export const cashCloseSchema = z.object({ opening_minor: balance, closing_minor: balance, statement_reference: z.string().trim().min(1).max(1000), confirm_complete: z.literal(true) });
export const cashReasonSchema = z.object({ reason: z.string().trim().min(1).max(500) });
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}
const incoming = (kind: string) => kind === 'income' || kind.endsWith('_in');
const safeEntry = ({ request_payload, ...entry }: BusinessCashEntry) => entry;

@Injectable()
export class BusinessCashbookService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly business: BusinessService) {}

  private async claim(manager: EntityManager, id: string, accountId: string, revision: unknown, requireSelection = true) {
    const company = await this.business.claim(manager, id, accountId, revision);
    const saved = company.self_service?.self_bookkeeping;
    if (requireSelection && (company.service_choices?.accounting?.provider !== 'self_bookkeeping' || saved?.version !== SELF_SERVICE_VERSION || !assessSelfService(company, 'self_bookkeeping', 'cashbook', saved?.answers || {}).eligible)) {
      throw new ConflictException('직접 회계 옵션의 사용 조건을 확인하고 선택하세요. 기존 장부 조회·내보내기·마감 재개는 계속 가능합니다.');
    }
    return company;
  }
  private async writable(manager: EntityManager, id: string, accountId: string, month: string) {
    if (await manager.getRepository(BusinessCashMonth).existsBy({ company_id: id, account_id: accountId, month, closed: true })) throw new ConflictException('마감된 월입니다. 사유를 입력하고 마감을 재개하세요.');
    if (await manager.getRepository(BusinessCashMonth).existsBy({ company_id: id, account_id: accountId, month: MoreThan(month), closed: true })) throw new ConflictException('후속 월이 마감되어 있습니다. 가장 최근 월부터 마감을 재개하세요.');
  }
  private entries(manager: EntityManager, id: string, accountId: string, month: string) {
    return manager.getRepository(BusinessCashEntry).find({ where: { company_id: id, account_id: accountId, date: Between(`${month}-01`, `${month}-31`) }, order: { date: 'ASC', created_at: 'ASC', id: 'ASC' } });
  }
  private summary(entries: BusinessCashEntry[]) {
    const active = entries.filter(e => !e.voided);
    const sum = (filter: (e: BusinessCashEntry) => boolean) => active.filter(filter).reduce((total, e) => total + e.amount_minor, 0);
    const inflow_minor = sum(e => incoming(e.kind)); const outflow_minor = sum(e => !incoming(e.kind));
    return { inflow_minor, outflow_minor, net_minor: inflow_minor - outflow_minor,
      operating_in_minor: sum(e => e.kind === 'income'), operating_out_minor: sum(e => e.kind === 'expense'),
      active_count: active.length, unreconciled_count: active.filter(e => !e.reconciled || !e.evidence.trim()).length };
  }
  async read(id: string, accountId: string, rawMonth: unknown) {
    const month = parse(cashMonthSchema, rawMonth);
    const company = await this.business.company(id, accountId);
    const entries = await this.entries(this.ds.manager, id, accountId, month);
    const period = await this.ds.getRepository(BusinessCashMonth).findOneBy({ company_id: id, account_id: accountId, month });
    return { month, currency: 'USD', company_revision: company.revision, entries: entries.map(safeEntry), period, summary: this.summary(entries),
      note: '단일 USD 계좌의 실제 입출금 보조 장부입니다. 순입출금·영업 입출금 차이는 회계이익이나 과세소득이 아닙니다. 월 마감은 세금 신고를 수행하지 않습니다.' };
  }
  async add(id: string, accountId: string, body: any, actor: string) {
    const input = parse(cashEntrySchema, body);
    if (input.date > new Date().toISOString().slice(0, 10)) throw new BadRequestException('실제 입출금된 거래의 날짜를 입력하세요. 미래 거래는 기록할 수 없습니다.');
    return this.ds.transaction(async manager => {
      await this.business.company(id, accountId, manager);
      const repo = manager.getRepository(BusinessCashEntry);
      const existing = await repo.findOneBy({ company_id: id, account_id: accountId, request_id: input.request_id });
      if (existing) {
        if (existing.request_payload !== JSON.stringify(input)) throw new ConflictException('같은 request_id의 내용이 다릅니다. 새 거래에는 새 request_id를 사용하세요.');
        return safeEntry(existing);
      }
      const company = await this.claim(manager, id, accountId, body?.revision);
      const month = input.date.slice(0, 7);
      await this.writable(manager, id, accountId, month);
      if ((await this.entries(manager, id, accountId, month)).length >= 5000) throw new BadRequestException('월별 장부 기록 한도 5,000건입니다.');
      const entry = await repo.save({ ...input, account_id: accountId, company_id: id, actor_id: actor, request_payload: JSON.stringify(input), reconciled: false, voided: false, void_reason: '' });
      await this.business.event(manager, company, actor, 'cashbook', `장부 기록 ${entry.id} · ${input.date} · ${input.kind} · ${input.amount_minor} USD cents`);
      return safeEntry(entry);
    });
  }
  async reconcile(id: string, accountId: string, entryId: string, body: any, actor: string) {
    const input = parse(cashReconcileSchema, body);
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, body?.revision);
      const entry = await manager.getRepository(BusinessCashEntry).findOneBy({ id: entryId, company_id: id, account_id: accountId });
      if (!entry) throw new NotFoundException('장부 기록을 찾을 수 없습니다.');
      await this.writable(manager, id, accountId, entry.date.slice(0, 7));
      if (entry.voided) throw new ConflictException('취소된 기록은 대사할 수 없습니다.');
      await manager.getRepository(BusinessCashEntry).update({ id: entryId, account_id: accountId }, input);
      await this.business.event(manager, company, actor, 'cashbook', `장부 ${entryId} · ${input.reconciled ? '은행 대사 확인' : '대사 확인 취소'} · 증빙 참조 갱신`);
      return safeEntry({ ...entry, ...input });
    });
  }
  async void(id: string, accountId: string, entryId: string, body: any, actor: string) {
    const input = parse(cashReasonSchema, body);
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, body?.revision);
      const entry = await manager.getRepository(BusinessCashEntry).findOneBy({ id: entryId, company_id: id, account_id: accountId });
      if (!entry) throw new NotFoundException('장부 기록을 찾을 수 없습니다.');
      await this.writable(manager, id, accountId, entry.date.slice(0, 7));
      if (entry.voided) throw new ConflictException('이미 취소된 기록입니다.');
      await manager.getRepository(BusinessCashEntry).update({ id: entryId, account_id: accountId }, { voided: true, void_reason: input.reason });
      await this.business.event(manager, company, actor, 'cashbook', `장부 ${entryId} 취소 · ${input.reason}`);
      return safeEntry({ ...entry, voided: true, void_reason: input.reason });
    });
  }
  async close(id: string, accountId: string, rawMonth: unknown, body: any, actor: string) {
    const month = parse(cashMonthSchema, rawMonth); const input = parse(cashCloseSchema, body);
    if (month >= new Date().toISOString().slice(0, 7)) throw new BadRequestException('월 전체 명세서가 확정된 지난달까지 마감할 수 있습니다.');
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, body?.revision);
      await this.writable(manager, id, accountId, month);
      const summary = this.summary(await this.entries(manager, id, accountId, month));
      if (summary.unreconciled_count) throw new ConflictException('모든 유효 거래에 증빙을 연결하고 은행 대사를 확인하세요.');
      if (input.opening_minor + summary.net_minor !== input.closing_minor) throw new ConflictException('기초 잔액 + 순입출금이 은행 기말 잔액과 일치하지 않습니다.');
      const before = new Date(`${month}-01T00:00:00.000Z`); before.setUTCMonth(before.getUTCMonth() - 1);
      const repo = manager.getRepository(BusinessCashMonth);
      const previous = await repo.findOneBy({ company_id: id, account_id: accountId, month: before.toISOString().slice(0, 7) });
      if (previous?.closed && previous.closing_minor !== input.opening_minor) throw new ConflictException('전월의 마감 잔액과 이번 달 기초 잔액이 다릅니다.');
      const existing = await repo.findOneBy({ company_id: id, account_id: accountId, month });
      const period = await repo.save({ ...existing, company_id: id, account_id: accountId, month, opening_minor: input.opening_minor, closing_minor: input.closing_minor, statement_reference: input.statement_reference, closed: true, closed_at: new Date().toISOString(), reopen_reason: '', actor_id: actor });
      await this.business.event(manager, company, actor, 'cashbook', `${month} 내부 마감 · 기초 ${input.opening_minor} / 기말 ${input.closing_minor} USD cents · 세금 신고 별도`);
      return period;
    });
  }
  async reopen(id: string, accountId: string, rawMonth: unknown, body: any, actor: string) {
    const month = parse(cashMonthSchema, rawMonth); const input = parse(cashReasonSchema, body);
    return this.ds.transaction(async manager => {
      const company = await this.claim(manager, id, accountId, body?.revision, false);
      const repo = manager.getRepository(BusinessCashMonth);
      const period = await repo.findOneBy({ company_id: id, account_id: accountId, month, closed: true });
      if (!period) throw new ConflictException('마감된 월을 선택하세요.');
      if (await repo.existsBy({ company_id: id, account_id: accountId, month: MoreThan(month), closed: true })) throw new ConflictException('가장 최근 월부터 마감을 재개하세요.');
      await repo.update({ id: period.id, account_id: accountId }, { closed: false, reopen_reason: input.reason, actor_id: actor });
      await this.business.event(manager, company, actor, 'cashbook', `${month} 마감 재개 · ${input.reason}`);
      return { ...period, closed: false, reopen_reason: input.reason, actor_id: actor };
    });
  }
}
