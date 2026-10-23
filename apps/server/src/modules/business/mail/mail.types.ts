import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const line = (max: number) => z.string().trim().max(max).refine(s => !/[\r\n\x00]/.test(s));
export const addressSchema = z.string().trim().email().max(254);
const endpointSchema = z.object({
  host: line(253).min(1).refine(s => /^[a-zA-Z0-9.:[\]-]+$/.test(s)),
  port: z.number().int().min(1).max(65535),
  tls: z.enum(['implicit', 'starttls']),
  username: line(320).min(1),
});
export const mailConfigSchema = z.object({
  addresses: z.array(addressSchema).min(1).max(30),
  smtp: endpointSchema.optional(),
  imap: endpointSchema.extend({ folder: line(200).min(1).default('INBOX') }).optional(),
  jmap_url: z.string().url().max(2000).optional(),
  jmap_account_id: line(200).optional(),
});
export const mailConnectionSchema = z.object({
  id: z.string().uuid().optional(), revision: z.number().int().nonnegative().optional(),
  company_id: z.string().uuid().nullable().default(null),
  name: line(120).min(1), provider: z.enum(['smtp_imap', 'jmap']),
  purpose: z.enum(['general', 'accounting', 'marketing', 'operations']).default('operations'),
  credential_id: z.string().uuid(), config: mailConfigSchema,
  enabled: z.boolean().default(true), interval_minutes: z.union([z.literal(5), z.literal(15), z.literal(60)]).default(5),
});
export const mailFiltersSchema = z.object({
  address: addressSchema.optional(),
  company_id: z.string().uuid().optional(), connection_id: z.string().uuid().optional(),
  purpose: z.enum(['general', 'accounting', 'marketing', 'operations']).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  status: z.enum(['received', 'sending', 'accepted', 'uncertain']).optional(),
  confirmation: z.enum(['pending', 'confirmed']).optional(),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const mailSendSchema = z.object({
  request_id: z.string().uuid().describe('Stable automation operation ID. Reuse unchanged on retries.'),
  from: addressSchema, to: z.array(addressSchema).min(1).max(10),
  subject: line(500).min(1), text: z.string().min(1).max(100000),
  reply_to_message_id: z.string().uuid().optional(),
  confirm: z.literal(true),
});
export const mailConfirmSchema = z.object({
  revision: z.number().int().nonnegative(), confirmed: z.boolean(), note: z.string().max(2000).default(''),
});
export function parseMail<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('메일 연결 또는 입력 값을 확인하세요.');
  return parsed.data;
}
export type MailConfig = z.infer<typeof mailConfigSchema>;
export interface MailData { config: MailConfig; cursor?: Record<string, any> }
export interface MailContent {
  source_id: string; message_id: string; from: string; to: string[]; reply_to?: string;
  subject: string; text: string; date: string; truncated?: boolean;
  attachments: Array<{ name: string; type: string; size: number }>;
  in_reply_to?: string; references?: string[]; note?: string;
}
export interface MailContext { config: MailConfig; cursor: Record<string, any>; secrets: Record<string, string> }
export interface MailConnector {
  descriptor: { id: string; name: string; credential_provider: string; note: string };
  sync(context: MailContext): Promise<{ messages: MailContent[]; cursor: Record<string, any>; has_more?: boolean }>;
  send(context: MailContext, content: MailContent): Promise<void>;
}
