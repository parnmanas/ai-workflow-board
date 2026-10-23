import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BusinessFormation } from '../../entities/BusinessFormation';
import { BusinessCompany } from '../../entities/BusinessCompany';
import { BusinessConnection } from '../../entities/BusinessConnection';
import { BusinessEvent } from '../../entities/BusinessEvent';
import { decryptStrict, encrypt } from '../../services/encryption.service';
import { BusinessService } from './business.service';
import { businessConnector } from './connectors/registry';
import { connectorGet, connectorPost } from './connectors/connector-http';
import type { FormationContext, FormationRequest } from './connectors/formation-connector';

const connectionSchema = z.object({ credential_id: z.string().uuid(), environment: z.enum(['sandbox', 'live']) });
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException('신청 정보·환경·확인 값을 확인하세요.');
  return result.data;
}
export function publicFormation(row: BusinessFormation) {
  const { encrypted_request, credential_digest, customer_id, ...safe } = row;
  return safe;
}
@Injectable()
export class BusinessFormationService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly business: BusinessService) {}

  private adapter(provider: string) {
    const adapter = businessConnector(provider).formation;
    if (!adapter) throw new BadRequestException('현재 이 서비스는 외부에서 설립 신청을 진행합니다.');
    return adapter;
  }
  private async context(accountId: string, provider: string, credentialId: string, environment: 'sandbox' | 'live'): Promise<{ context: FormationContext; digest: string }> {
    const secret = await this.business.secret(credentialId, provider, accountId);
    // Provider keys have high entropy; this stable fingerprint survives instance-key re-encryption during migration.
    const digest = createHash('sha256').update(JSON.stringify(secret.fields)).digest('hex');
    const context: FormationContext = { environment, secrets: secret.fields, get: connectorGet, post: async (url, headers, body) => {
      const current = await this.business.secret(credentialId, provider, accountId);
      if (createHash('sha256').update(JSON.stringify(current.fields)).digest('hex') !== digest) throw new ConflictException('검토 이후 키가 변경되었습니다. 기존 키와 신청 결과를 확인하세요.');
      return connectorPost(url, headers, body);
    } };
    return { context, digest };
  }
  private async load(companyId: string, accountId: string, actionId: string) {
    await this.business.company(companyId, accountId);
    const row = await this.ds.getRepository(BusinessFormation).createQueryBuilder('f')
      .where('f.id = :actionId AND f.company_id = :companyId AND f.account_id = :accountId', { actionId, companyId, accountId }).getOne();
    if (!row) throw new NotFoundException('설립 신청 기록을 찾을 수 없습니다.');
    return row;
  }
  private async event(manager: EntityManager, row: BusinessFormation, actor: string, message: string) {
    await manager.getRepository(BusinessEvent).save({ company_id: row.company_id, account_id: row.account_id, actor_id: actor, kind: 'formation', message });
  }
  async references(companyId: string, accountId: string, provider: string, body: unknown) {
    await this.business.company(companyId, accountId);
    const input = parse(connectionSchema, body);
    const { context } = await this.context(accountId, provider, input.credential_id, input.environment);
    return this.adapter(provider).references(context);
  }
  async prepare(companyId: string, accountId: string, provider: string, body: any, actor: string) {
    const company = await this.business.company(companyId, accountId);
    if (company.country !== 'US' || company.entity_type !== 'LLC') throw new BadRequestException('현재 내부 신청은 미국 1인 LLC를 지원합니다. 회사 정보를 확인하세요.');
    const input = parse(connectionSchema.extend({ revision: z.number().int().nonnegative(), application: z.unknown() }), body);
    const adapter = this.adapter(provider);
    const { context, digest } = await this.context(accountId, provider, input.credential_id, input.environment);
    const references = await adapter.references(context);
    const request = adapter.prepare(input.application, references);
    const fee = references.fees.find(f => f.state === request.summary.state);
    if (!fee) throw new BadRequestException('주정부 수수료를 확인하지 못했습니다.');
    return this.ds.transaction(async manager => {
      const claim = await manager.getRepository(BusinessCompany).update({ id: companyId, account_id: accountId, revision: input.revision }, { revision: input.revision + 1 });
      if (claim.affected !== 1) throw new ConflictException('회사 정보가 변경되었습니다. 새로고침 후 다시 검토하세요.');
      if (await manager.getRepository(BusinessConnection).existsBy({ company_id: companyId, account_id: accountId, provider, environment: input.environment })) throw new ConflictException('이미 연결한 회사가 있습니다. 추가 설립 전에 기존 연결을 확인하세요.');
      const repo = manager.getRepository(BusinessFormation);
      const previous = await repo.findOneBy({ company_id: companyId, account_id: accountId, provider, environment: input.environment });
      if (previous && previous.status !== 'draft') throw new ConflictException('이미 제출을 시작한 신청이 있습니다. 기존 신청에서 결과를 확인하세요.');
      const id = previous?.id || randomUUID();
      const canonical = JSON.stringify(request);
      const row = repo.create({ ...previous, id, company_id: companyId, account_id: accountId, provider,
        credential_id: input.credential_id, environment: input.environment, credential_digest: digest,
        encrypted_request: encrypt(canonical), summary: request.summary, state_fee_cents: fee.price_in_cents,
        payload_digest: createHmac('sha256', digest).update(`business-formation:${id}:${fee.price_in_cents}:${canonical}`).digest('hex'),
        quoted_at: new Date().toISOString(), status: 'draft', revision: (previous?.revision || 0) + 1,
        last_error: '', customer_id: '', external_company_id: '', provider_status: '', attempted_at: null,
      });
      await repo.save(row);
      await this.event(manager, row, actor, '설립 신청서와 주정부 수수료를 검토용으로 저장했습니다. 아직 제출하지 않았습니다.');
      return publicFormation(row);
    });
  }
  async review(companyId: string, accountId: string, actionId: string) {
    const row = await this.load(companyId, accountId, actionId);
    return { formation: publicFormation(row), request: row.encrypted_request ? JSON.parse(decryptStrict(row.encrypted_request)) : null };
  }
  async discard(companyId: string, accountId: string, actionId: string, body: any, actor: string) {
    const row = await this.load(companyId, accountId, actionId);
    if (row.status !== 'draft' || body?.payload_digest !== row.payload_digest) throw new ConflictException('제출 전의 현재 신청서만 삭제할 수 있습니다.');
    return this.ds.transaction(async manager => {
      const result = await manager.getRepository(BusinessFormation).delete({ id: row.id, account_id: accountId, status: 'draft', revision: row.revision });
      if (result.affected !== 1) throw new ConflictException('신청 상태가 변경되었습니다.');
      await this.event(manager, row, actor, '제출 전 설립 신청서를 삭제했습니다.');
      return { success: true };
    });
  }
  async submit(companyId: string, accountId: string, actionId: string, body: unknown, actor: string) {
    const input = parse(z.object({ payload_digest: z.string(), revision: z.number().int().nonnegative(), confirm: z.literal(true) }), body);
    const row = await this.load(companyId, accountId, actionId);
    if (input.payload_digest !== row.payload_digest) throw new ConflictException('검토한 신청서가 변경되었습니다. 다시 확인하세요.');
    if (row.status === 'submitted') return publicFormation(row);
    if (row.status === 'submitting' && row.attempted_at && Date.now() - Date.parse(row.attempted_at) < 120_000) throw new ConflictException('제출 중입니다. 잠시 후 신청 기록을 확인하세요.');
    if (row.revision !== input.revision) throw new ConflictException('신청 상태가 변경되었습니다. 새로고침하세요.');
    if (row.status === 'draft' && Date.now() - Date.parse(row.quoted_at) > 30 * 60_000) throw new ConflictException('검토 유효시간 30분이 지났습니다. 신청서를 다시 검토하세요.');
    const adapter = this.adapter(row.provider);
    const { context, digest } = await this.context(accountId, row.provider, row.credential_id, row.environment);
    if (digest !== row.credential_digest) throw new ConflictException('검토 이후 키가 변경되었습니다. 원래 키를 복원해 기존 신청을 확인하세요.');
    const references = await adapter.references(context);
    if (references.fees.find(f => f.state === row.summary.state)?.price_in_cents !== row.state_fee_cents) throw new ConflictException('주정부 수수료가 변경되었습니다. 제출 전 신청서는 다시 검토하고, 제출 시도한 신청은 doola에서 확인하세요.');
    const request: FormationRequest = JSON.parse(decryptStrict(row.encrypted_request));
    const revision = row.revision + 1;
    await this.ds.transaction(async manager => {
      const claimed = await manager.getRepository(BusinessFormation).update({ id: row.id, account_id: accountId, status: row.status, revision: row.revision }, { status: 'submitting', revision, attempted_at: new Date().toISOString(), last_error: '' });
      if (claimed.affected !== 1) throw new ConflictException('다른 요청이 이미 제출을 시작했습니다.');
      await this.event(manager, row, actor, `${row.environment === 'sandbox' ? '테스트' : '실제'} 설립 신청 제출을 승인했습니다.`);
    });
    const repo = this.ds.getRepository(BusinessFormation);
    let result: { id: string; status: string };
    try {
      const customerId = row.customer_id || await adapter.customer(context, request.customer, `awb-formation-${row.id}-customer`);
      const saved = await repo.update({ id: row.id, account_id: accountId, revision, status: 'submitting' }, { customer_id: customerId });
      if (saved.affected !== 1) throw new ConflictException('신청 상태가 변경되었습니다.');
      result = await adapter.submit(context, request.company, customerId, `awb-formation-${row.id}-company`);
    } catch {
      // A timeout is not proof of failure. Keep the immutable encrypted body and keys for an explicit retry.
      await this.ds.transaction(async manager => {
        const changed = await manager.getRepository(BusinessFormation).update({ id: row.id, account_id: accountId, revision, status: 'submitting' }, {
          status: 'uncertain', revision: revision + 1, last_error: '제출 결과를 확정하지 못했습니다. 새 신청을 만들지 말고 이 기록에서 동일 요청으로 재확인하세요. 원래 키·입력값·중복 방지 번호를 그대로 사용합니다.',
        });
        if (changed.affected === 1) await this.event(manager, row, actor, '설립 제출 결과 확인이 필요합니다. 중복 방지 정보와 원래 신청서를 유지했습니다.');
      });
      return publicFormation(await this.load(companyId, accountId, row.id));
    }
    return this.ds.transaction(async manager => {
      const saved = await manager.getRepository(BusinessFormation).update({ id: row.id, account_id: accountId, revision, status: 'submitting' }, {
        status: 'submitted', revision: revision + 1, external_company_id: result.id, provider_status: result.status, last_error: '', encrypted_request: '',
      });
      if (saved.affected !== 1) throw new ConflictException('다른 요청이 결과를 반영하고 있습니다. 신청 기록을 다시 확인하세요.');
      // Lock the company before adding a connection; concurrent manual settings always win.
      await manager.getRepository(BusinessCompany).increment({ id: companyId, account_id: accountId }, 'revision', 1);
      const connections = manager.getRepository(BusinessConnection);
      if (!await connections.existsBy({ company_id: companyId, account_id: accountId, provider: row.provider })) {
        await connections.save({ company_id: companyId, account_id: accountId, provider: row.provider, credential_id: row.credential_id, environment: row.environment,
          config: { company_id: result.id }, status: 'configured', snapshot: null, synced_at: null, attempted_at: null, last_error: '', revision: 1 });
      }
      await this.event(manager, row, actor, `${row.environment === 'sandbox' ? '테스트 ' : ''}설립 신청이 접수되었습니다. 본인 서명과 공급자 심사 결과를 확인하세요.`);
      return publicFormation(await manager.getRepository(BusinessFormation).findOneByOrFail({ id: row.id, account_id: accountId }));
    });
  }
  async signature(companyId: string, accountId: string, actionId: string, body: unknown) {
    const input = parse(z.object({ document_type: z.enum(['SS4', 'FORM8821']) }), body);
    const row = await this.load(companyId, accountId, actionId);
    if (row.status !== 'submitted' || !row.external_company_id) throw new ConflictException('접수된 회사에서 서명을 시작하세요.');
    const { context, digest } = await this.context(accountId, row.provider, row.credential_id, row.environment);
    if (digest !== row.credential_digest) throw new ConflictException('제출할 때 사용한 키를 확인하세요.');
    return this.adapter(row.provider).signature(context, row.external_company_id, input.document_type);
  }
}
