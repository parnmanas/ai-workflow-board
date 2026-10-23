import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BusinessCompany } from '../../entities/BusinessCompany';
import { BusinessEvent } from '../../entities/BusinessEvent';
import { BusinessTrademark } from '../../entities/BusinessTrademark';
import { BusinessTrademarkMail } from '../../entities/BusinessTrademarkMail';
import { Credential } from '../../entities/Credential';
import { decryptStrict, encrypt } from '../../services/encryption.service';
import { BusinessService } from './business.service';
import { businessEmailConnector } from './connectors/business-email';
import { MAIL_KINDS, mailSchema, parseTrademark, trademarkMailDraft, trademarkSchema, type TrademarkDetails, type TrademarkMailPayload } from './trademark.types';

const approvalSchema = z.object({ payload_digest: z.string().length(64), revision: z.number().int().nonnegative(), confirm: z.literal(true) });
const SEND_LEASE_MS = 120_000;
// Resend keeps idempotency keys for 24 hours. Stop well before expiration, even after restarts.
const RETRY_WINDOW_MS = 23 * 60 * 60_000;
function publicMail(row: BusinessTrademarkMail) {
  const { encrypted_payload, credential_digest, ...safe } = row;
  const payload: TrademarkMailPayload = JSON.parse(decryptStrict(encrypted_payload));
  return { ...safe, subject: payload.subject, to: payload.to };
}
function details(row: BusinessTrademark): TrademarkDetails { return JSON.parse(decryptStrict(row.encrypted_details)); }
function publicCase(row: BusinessTrademark) {
  const { encrypted_details, ...safe } = row;
  return { ...safe, ...details(row) };
}

@Injectable()
export class BusinessTrademarkService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly business: BusinessService) {}

  private async load(companyId: string, accountId: string, id: string, manager = this.ds.manager) {
    await this.business.company(companyId, accountId, manager);
    const row = await manager.getRepository(BusinessTrademark).findOneBy({ id, company_id: companyId, account_id: accountId });
    if (!row) throw new NotFoundException('상표 기록을 찾을 수 없습니다.');
    return row;
  }
  private async mail(companyId: string, accountId: string, caseId: string, id: string, manager = this.ds.manager) {
    await this.load(companyId, accountId, caseId, manager);
    const row = await manager.getRepository(BusinessTrademarkMail).findOneBy({ id, company_id: companyId, account_id: accountId, trademark_id: caseId });
    if (!row) throw new NotFoundException('메일 기록을 찾을 수 없습니다.');
    return row;
  }
  private async event(manager: EntityManager, companyId: string, accountId: string, actor: string, message: string) {
    await manager.getRepository(BusinessEvent).save({ company_id: companyId, account_id: accountId, actor_id: actor, kind: 'trademark', message });
  }
  private async lockCompany(manager: EntityManager, companyId: string, accountId: string) {
    await this.business.company(companyId, accountId, manager);
    await manager.getRepository(BusinessCompany).increment({ id: companyId, account_id: accountId }, 'revision', 1);
  }
  async list(companyId: string, accountId: string) {
    await this.business.company(companyId, accountId);
    const cases = await this.ds.getRepository(BusinessTrademark).find({ where: { company_id: companyId, account_id: accountId }, order: { created_at: 'ASC' } });
    const mailRepo = this.ds.getRepository(BusinessTrademarkMail);
    const where = { company_id: companyId, account_id: accountId };
    const [recent, pending] = await Promise.all([
      mailRepo.find({ where, order: { created_at: 'DESC' }, take: 200 }),
      // An older unresolved send must remain reachable even after other cases have newer mail.
      mailRepo.find({ where: { ...where, status: In(['draft', 'sending', 'uncertain']) } }),
    ]);
    const mail = [...new Map([...recent, ...pending].map(row => [row.id, row])).values()].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return { cases: cases.map(publicCase), mail: mail.map(publicMail) };
  }
  async save(companyId: string, accountId: string, id: string | null, body: any, actor: string) {
    await this.business.company(companyId, accountId);
    const input = parseTrademark(trademarkSchema, body);
    if (['examination', 'registered'].includes(input.phase) && !input.serial_number) throw new BadRequestException('심사·등록 단계에는 실제 출원번호가 필요합니다.');
    if (input.phase === 'registered' && !input.registration_number) throw new BadRequestException('등록증의 등록번호를 입력하세요.');
    if (input.next_due_on && !input.deadline_source) throw new BadRequestException('기한의 출처 또는 담당자 확인 내용을 함께 입력하세요.');
    return this.ds.transaction(async manager => {
      await this.lockCompany(manager, companyId, accountId);
      const repo = manager.getRepository(BusinessTrademark);
      if (id) {
        const current = await this.load(companyId, accountId, id, manager);
        if (current.revision !== body?.revision) throw new ConflictException('상표 기록이 변경되었습니다. 다시 불러오세요.');
        const changed = await repo.update({ id, account_id: accountId, revision: current.revision }, { encrypted_details: encrypt(JSON.stringify(input)), revision: current.revision + 1 });
        if (changed.affected !== 1) throw new ConflictException('다른 요청이 상표를 변경했습니다.');
      } else {
        if (await repo.countBy({ company_id: companyId, account_id: accountId }) >= 50) throw new BadRequestException('회사당 상표 기록은 최대 50개입니다.');
        id = randomUUID();
        await repo.save({ id, company_id: companyId, account_id: accountId, encrypted_details: encrypt(JSON.stringify(input)) });
      }
      await this.event(manager, companyId, accountId, actor, '상표 출원 준비·진행 기록을 저장했습니다. 공식 접수·등록 상태는 공급자에서 확인하세요.');
      return publicCase(await this.load(companyId, accountId, id, manager));
    });
  }
  async draft(companyId: string, accountId: string, id: string, body: unknown) {
    const { kind } = parseTrademark(z.object({ kind: z.enum(MAIL_KINDS) }), body);
    return trademarkMailDraft(details(await this.load(companyId, accountId, id)), kind);
  }
  private async key(credentialId: string, provider: string, accountId: string) {
    const connector = businessEmailConnector(provider);
    const credential = await this.ds.getRepository(Credential).findOneBy({ id: credentialId, account_id: accountId, provider: connector.credential_provider, agent_env: false });
    if (!credential) throw new BadRequestException('같은 소유 계정의 서버 전용 Resend credential을 선택하세요.');
    let apiKey: string;
    try { apiKey = JSON.parse(decryptStrict(credential.encrypted_data)).api_key; } catch { throw new BadRequestException('저장된 API 키를 확인하세요.'); }
    if (typeof apiKey !== 'string' || !apiKey.trim() || /\s/.test(apiKey)) throw new BadRequestException('API 키를 확인하세요.');
    return { connector, apiKey, digest: createHash('sha256').update(apiKey).digest('hex') };
  }
  async prepareMail(companyId: string, accountId: string, caseId: string, body: unknown, actor: string) {
    const input = parseTrademark(z.object({ provider: z.string(), credential_id: z.string().uuid(), trademark_revision: z.number().int().nonnegative(), payload: mailSchema }), body);
    await this.load(companyId, accountId, caseId);
    const { digest } = await this.key(input.credential_id, input.provider, accountId);
    return this.ds.transaction(async manager => {
      await this.lockCompany(manager, companyId, accountId);
      const row = await this.load(companyId, accountId, caseId, manager);
      if (row.revision !== input.trademark_revision) throw new ConflictException('상표 정보가 변경되었습니다. 메일을 다시 작성하세요.');
      if (input.payload.to.toLowerCase() !== details(row).attorney_email.toLowerCase()) throw new BadRequestException('상표 기록에 지정한 변호사 이메일로만 발송할 수 있습니다.');
      const repo = manager.getRepository(BusinessTrademarkMail);
      if (await repo.existsBy({ trademark_id: caseId, account_id: accountId, status: In(['draft', 'sending', 'uncertain']) })) throw new ConflictException('검토 중이거나 발송 결과를 확인할 메일이 있습니다. 기존 기록을 먼저 처리하세요.');
      const id = randomUUID();
      const payloadDigest = createHmac('sha256', digest).update(JSON.stringify({ id, credential_id: input.credential_id, payload: input.payload })).digest('hex');
      const mail = await repo.save({ id, company_id: companyId, account_id: accountId, trademark_id: caseId, trademark_revision: row.revision,
        provider: input.provider, credential_id: input.credential_id, credential_digest: digest, encrypted_payload: encrypt(JSON.stringify(input.payload)), payload_digest: payloadDigest,
        status: 'draft', first_attempted_at: null, attempted_at: null, checked_at: null });
      await this.event(manager, companyId, accountId, actor, '변호사 메일을 검토용으로 저장했습니다. 아직 발송하지 않았습니다.');
      return publicMail(mail);
    });
  }
  async review(companyId: string, accountId: string, caseId: string, id: string) {
    const row = await this.mail(companyId, accountId, caseId, id);
    return { mail: publicMail(row), payload: JSON.parse(decryptStrict(row.encrypted_payload)) as TrademarkMailPayload };
  }
  async discard(companyId: string, accountId: string, caseId: string, id: string, body: any, actor: string) {
    return this.ds.transaction(async manager => {
      const row = await this.mail(companyId, accountId, caseId, id, manager);
      if (row.status !== 'draft' || body?.payload_digest !== row.payload_digest) throw new ConflictException('미발송 초안만 삭제할 수 있습니다.');
      const removed = await manager.getRepository(BusinessTrademarkMail).delete({ id, account_id: accountId, status: 'draft', revision: row.revision });
      if (removed.affected !== 1) throw new ConflictException('메일 상태가 변경되었습니다.');
      await this.event(manager, companyId, accountId, actor, '미발송 메일 초안을 삭제했습니다.');
      return { success: true };
    });
  }
  async send(companyId: string, accountId: string, caseId: string, id: string, body: unknown, actor: string) {
    const input = parseTrademark(approvalSchema, body);
    const row = await this.mail(companyId, accountId, caseId, id);
    if (row.payload_digest !== input.payload_digest) throw new ConflictException('검토한 메일이 변경되었습니다.');
    if (row.status === 'sent') return publicMail(row);
    if (row.revision !== input.revision) throw new ConflictException('메일 상태가 변경되었습니다.');
    if (row.status === 'sending' && row.attempted_at && Date.now() - Date.parse(row.attempted_at) < SEND_LEASE_MS) throw new ConflictException('발송 중입니다. 잠시 후 기록을 확인하세요.');
    if (row.first_attempted_at && Date.now() - Date.parse(row.first_attempted_at) >= RETRY_WINDOW_MS) throw new ConflictException('중복 방지 재시도 시간이 지났습니다. Resend에서 발송 ID를 찾아 원문 대조로 결과를 확정하세요.');
    const { connector, apiKey, digest } = await this.key(row.credential_id, row.provider, accountId);
    if (digest !== row.credential_digest) throw new ConflictException('검토 후 API 키가 변경되었습니다. 원래 키로 확인하거나 미발송 초안을 다시 만드세요.');
    const revision = row.revision + 1;
    const attemptedAt = new Date().toISOString();
    await this.ds.transaction(async manager => {
      await this.lockCompany(manager, companyId, accountId);
      const current = await this.load(companyId, accountId, caseId, manager);
      if (row.status === 'draft' && current.revision !== row.trademark_revision) throw new ConflictException('검토 이후 상표 정보가 바뀌었습니다. 미발송 초안을 다시 만드세요.');
      const result = await manager.getRepository(BusinessTrademarkMail).update({ id, account_id: accountId, status: row.status, revision: row.revision }, {
        status: 'sending', revision, first_attempted_at: row.first_attempted_at || attemptedAt, attempted_at: attemptedAt, last_error: '',
      });
      if (result.affected !== 1) throw new ConflictException('다른 요청이 이미 발송을 시작했습니다.');
      await this.event(manager, companyId, accountId, actor, '검토한 변호사 메일의 실제 발송을 승인했습니다.');
    });
    let providerId: string;
    try { providerId = await connector.send(JSON.parse(decryptStrict(row.encrypted_payload)), apiKey, `awb-trademark-mail-${row.id}`); }
    catch {
      await this.ds.transaction(async manager => {
        const changed = await manager.getRepository(BusinessTrademarkMail).update({ id, account_id: accountId, status: 'sending', revision }, {
          status: 'uncertain', revision: revision + 1, last_error: '접수 결과를 확인하지 못했습니다. 자동 재발송하지 않습니다. 최초 시도 23시간 이내에는 같은 요청으로 재확인하거나 Resend 발송 ID로 대조하세요.',
        });
        if (changed.affected === 1) await this.event(manager, companyId, accountId, actor, '메일 발송 결과 확인이 필요합니다. 원문과 중복 방지 번호를 유지했습니다.');
      });
      return publicMail(await this.mail(companyId, accountId, caseId, id));
    }
    return this.complete(companyId, accountId, caseId, row, revision, providerId, 'accepted', actor);
  }
  private async complete(companyId: string, accountId: string, caseId: string, row: BusinessTrademarkMail, revision: number, providerId: string, delivery: string, actor: string) {
    return this.ds.transaction(async manager => {
      const changed = await manager.getRepository(BusinessTrademarkMail).update({ id: row.id, account_id: accountId, revision }, {
        status: 'sent', provider_message_id: providerId, delivery_status: delivery, checked_at: new Date().toISOString(), revision: revision + 1, last_error: '',
      });
      if (changed.affected !== 1) throw new ConflictException('다른 요청이 메일 상태를 변경했습니다. 기록을 다시 확인하세요.');
      await this.event(manager, companyId, accountId, actor, '공급자의 메일 접수를 확인했습니다. 변호사 회신·수임·계약·출원 완료와는 별도로 확인하세요.');
      return publicMail(await this.mail(companyId, accountId, caseId, row.id, manager));
    });
  }
  async delivery(companyId: string, accountId: string, caseId: string, id: string) {
    const row = await this.mail(companyId, accountId, caseId, id);
    if (row.status !== 'sent' || !row.provider_message_id) throw new ConflictException('발송 접수가 확인된 메일만 조회할 수 있습니다.');
    const { connector, apiKey, digest } = await this.key(row.credential_id, row.provider, accountId);
    if (digest !== row.credential_digest) throw new ConflictException('발송할 때 사용한 API 키로 확인하세요.');
    const delivery = await connector.delivery(row.provider_message_id, apiKey);
    await this.ds.getRepository(BusinessTrademarkMail).update({ id, account_id: accountId, revision: row.revision }, { delivery_status: delivery, checked_at: new Date().toISOString(), revision: row.revision + 1 });
    return publicMail(await this.mail(companyId, accountId, caseId, id));
  }
  async reconcile(companyId: string, accountId: string, caseId: string, id: string, body: unknown, actor: string) {
    const input = parseTrademark(approvalSchema.extend({ provider_message_id: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/) }), body);
    const row = await this.mail(companyId, accountId, caseId, id);
    if (row.status === 'sent') return publicMail(row);
    if (row.status === 'draft' || row.payload_digest !== input.payload_digest || row.revision !== input.revision) throw new ConflictException('발송 시도한 메일의 최신 기록을 선택하세요.');
    if (row.status === 'sending' && row.attempted_at && Date.now() - Date.parse(row.attempted_at) < SEND_LEASE_MS) throw new ConflictException('발송 중입니다. 잠시 후 대조하세요.');
    const { connector, apiKey, digest } = await this.key(row.credential_id, row.provider, accountId);
    if (digest !== row.credential_digest) throw new ConflictException('발송에 사용한 API 키로 대조하세요.');
    const delivery = await connector.reconcile(input.provider_message_id, JSON.parse(decryptStrict(row.encrypted_payload)), apiKey);
    return this.complete(companyId, accountId, caseId, row, row.revision, input.provider_message_id, delivery, actor);
  }
}
