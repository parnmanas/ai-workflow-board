import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { RuntimeHost } from '../../../entities/RuntimeHost';
import { Credential } from '../../../entities/Credential';
import { normalizeRuntimeSpec, type RuntimeSpec } from '../../../common/runtime-spec';
import { addressSchema, mailAutomationSchema, type MailAutomation, type MailContent, type MailData } from './mail.types';

export const mailDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const mailAutomation = (data: MailData): MailAutomation => mailAutomationSchema.parse(data.automation || {});
export const automationFingerprint = (data: MailData) => mailDigest({ automation: mailAutomation(data), addresses: data.config.addresses });

export interface MailTaskData {
  automation: MailAutomation;
  fingerprint: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  note: string;
}

export async function validateMailRuntime(ds: DataSource, value: unknown, accountId: string): Promise<RuntimeSpec> {
  let spec: RuntimeSpec;
  try { spec = normalizeRuntimeSpec(value, '담당 에이전트'); }
  catch { throw new BadRequestException('담당 에이전트의 Host·CLI·작업 폴더를 설정하세요.'); }
  const host = await ds.getRepository(RuntimeHost).findOneBy({ id: spec.manager_agent_id, account_id: accountId, is_active: 1 });
  if (!host) throw new BadRequestException('메일과 같은 소유 계정의 활성 Runtime Host를 선택하세요.');
  if (spec.credential_id) {
    const credential = await ds.getRepository(Credential).findOneBy({ id: spec.credential_id });
    if (!credential || (credential.account_id !== null && credential.account_id !== accountId)) throw new BadRequestException('담당 에이전트 credential의 소유 계정을 확인하세요.');
  }
  return spec;
}

/** Received text never decides permissions, recipients or the automation policy. */
export function replyBlockReason(content: Omit<MailContent, 'text'>, ownAddresses: string[]): string {
  const recipient = content.reply_to || content.from;
  if (!addressSchema.safeParse(recipient).success || !addressSchema.safeParse(content.from).success) return '회신 주소를 확인할 수 없습니다.';
  if (content.truncated) return '본문이 잘려 있어 자동으로 답장하지 않습니다.';
  if (!/^<[^<>\s]{1,990}>$/.test(content.message_id)) return '중복 회신을 판별할 Message-ID가 없습니다.';
  if (ownAddresses.some(a => [recipient, content.from].some(b => a.toLowerCase() === b.toLowerCase()))) return '연결된 메일 주소 사이에는 자동으로 답장하지 않습니다.';
  if (content.auto_submitted && content.auto_submitted.toLowerCase().split(';')[0].trim() !== 'no') return '자동 생성·자동 회신 메일입니다.';
  if (content.list_id || /(?:bulk|list|junk)/i.test(content.precedence || '') || /(?:all|autoreply|oof)/i.test(content.auto_response_suppress || '')) return '대량·목록 메일 또는 자동 회신 금지 메일입니다.';
  if (content.return_path?.trim() === '<>' || /^(?:mailer-daemon|postmaster|no[._-]?reply|do[._-]?not[._-]?reply)(?:[+@._-])/i.test(recipient)) return '반송·회신 불가 주소입니다.';
  return '';
}
