import { z } from 'zod';
import { DataSource } from 'typeorm';
import { Project } from '../../entities/Project';
import { Channel } from '../../entities/Channel';
import { BusinessMailConnection } from '../../entities/BusinessMailConnection';
import { Credential } from '../../entities/Credential';
import { decryptStrict } from '../../services/encryption.service';
import type { MailData } from '../business/mail/mail.types';

export const qaResultDeliverySchema = z.object({
  when: z.enum(['always', 'failure']).default('failure'),
  channel_ids: z.array(z.string().min(1)).max(20).default([]),
  email: z.object({
    connection_id: z.string().uuid(),
    from: z.string().trim().email(),
    to: z.array(z.string().trim().email()).min(1).max(10),
  }).nullable().default(null),
}).strict();

export type QaResultDelivery = z.infer<typeof qaResultDeliverySchema>;

export function qaConfigError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

export function normalizeResultDelivery(input: unknown): QaResultDelivery | null {
  if (input == null) return null;
  const parsed = qaResultDeliverySchema.safeParse(input);
  if (!parsed.success) throw qaConfigError(`Invalid result_delivery: ${parsed.error.issues.map(i => i.message).join('; ')}`);
  return { ...parsed.data, channel_ids: [...new Set(parsed.data.channel_ids)] };
}

export async function validateQaProject(ds: DataSource, accountId: string, projectId: string | null | undefined): Promise<void> {
  if (projectId && !await ds.getRepository(Project).existsBy({ id: projectId, account_id: accountId })) {
    throw qaConfigError('같은 계정의 프로젝트(프로젝트)를 선택하세요.');
  }
}

/** Validate references both when saving and before delivering; ownership can change between them. */
export async function validateResultDelivery(ds: DataSource, accountId: string, policy: QaResultDelivery | null): Promise<void> {
  if (!policy) return;
  for (const id of policy.channel_ids) {
    const channel = await ds.getRepository(Channel).findOneBy({ id, account_id: accountId, is_active: 1, type: 'discord' });
    if (!channel?.bot_token || !channel.channel_id) {
      throw qaConfigError('같은 계정의 활성 Discord 공유 채널을 선택하세요.');
    }
  }
  if (policy.email) {
    const email = policy.email;
    const row = await ds.getRepository(BusinessMailConnection).findOneBy({ id: email.connection_id, account_id: accountId, enabled: true });
    if (!row) throw qaConfigError('같은 계정의 활성 메일 연결을 선택하세요.');
    const data: MailData = JSON.parse(decryptStrict(row.encrypted_data));
    if (row.provider === 'smtp_imap' && !data.config.smtp) throw qaConfigError('발신 가능한 메일 연결을 선택하세요.');
    if (!data.config.addresses.some(a => a.toLowerCase() === email.from.toLowerCase())) throw qaConfigError('메일 연결에 등록된 발신 주소를 선택하세요.');
    if (!await ds.getRepository(Credential).existsBy({ id: row.credential_id, account_id: accountId, provider: 'mail', agent_env: false })) {
      throw qaConfigError('메일 연결의 인증 정보를 확인하세요.');
    }
  }
}

export const isQaFailure = (status: string): boolean => ['failed', 'error', 'build_failed'].includes(status);
