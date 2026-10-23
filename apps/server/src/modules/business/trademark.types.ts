import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const optionalEmail = z.union([z.literal(''), z.email().max(254)]);
const optionalUrl = z.string().max(2000).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}, 'HTTPS 링크를 입력하세요.');
const date = z.string().refine(value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value), '날짜를 확인하세요.');
export const TRADEMARK_PHASES = ['preparing', 'counsel', 'contract', 'filing', 'examination', 'registered'] as const;
export const MAIL_KINDS = ['quote', 'engagement', 'filing', 'status', 'office_action'] as const;
export const trademarkSchema = z.object({
  mark: z.string().trim().min(1).max(200),
  mark_type: z.enum(['word', 'design']).default('word'),
  owner_name: z.string().trim().min(1).max(200),
  domicile_country: z.union([z.literal(''), z.string().regex(/^[A-Z]{2}$/)]).default(''),
  goods_services: z.string().trim().max(5000).default(''),
  classes: z.array(z.number().int().min(1).max(45)).max(45).default([]).transform(values => [...new Set(values)].sort((a, b) => a - b)),
  filing_basis: z.enum(['undecided', 'use', 'intent', 'foreign', 'madrid']).default('undecided'),
  evidence_notes: z.string().trim().max(5000).default(''),
  phase: z.enum(TRADEMARK_PHASES).default('preparing'),
  attorney_name: z.string().trim().max(200).default(''),
  attorney_email: optionalEmail.default(''),
  attorney_notes: z.string().trim().max(3000).default(''),
  engagement_url: optionalUrl.default(''),
  serial_number: z.union([z.literal(''), z.string().regex(/^\d{8}$/)]).default(''),
  registration_number: z.union([z.literal(''), z.string().regex(/^\d{6,8}$/)]).default(''),
  next_due_on: date.default(''),
  deadline_source: z.string().trim().max(1000).default(''),
  notes: z.string().trim().max(6000).default(''),
});
export type TrademarkDetails = z.infer<typeof trademarkSchema>;
export type TrademarkMailKind = typeof MAIL_KINDS[number];
export const mailSchema = z.object({
  from: z.email().max(254), to: z.email().max(254), reply_to: z.email().max(254),
  subject: z.string().trim().min(1).max(250).regex(/^[^\r\n]+$/),
  text: z.string().trim().min(1).max(20000),
});
export type TrademarkMailPayload = z.infer<typeof mailSchema>;
export function parseTrademark<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('입력한 상표 정보, 이메일 주소, 기한과 확인 값을 확인하세요.');
  return parsed.data;
}

export function trademarkMailDraft(details: TrademarkDetails, kind: TrademarkMailKind) {
  const purpose = {
    quote: ['Trademark clearance and representation inquiry', 'Please run a conflict check and confirm whether you can represent this owner. Please provide a written, itemized quote separating clearance, attorney fees, USPTO fees per class, office action responses, statements of use, extensions, and any recurring monitoring. Please confirm your US state bar details and who will manage deadlines.'],
    engagement: ['Request for engagement agreement', 'Please provide your engagement agreement for review, including scope, exclusions, fees, additional charges, termination terms, and responsibility for docketing deadlines. Please send a secure signature invitation after the terms are agreed. This message requests a draft; it does not accept terms or authorize payment or filing.'],
    filing: ['Trademark application information for review', 'Please review the information below and advise on the correct owner, domicile, filing basis, classes, goods/services wording and required specimens. Please send the complete application for approval and a personal signature request before submission. This message is preparation material, not authorization to file or pay.'],
    status: ['Trademark matter status request', 'Please provide the latest status, copies of official notices, the next action, the exact deadline and its source, and any proposed additional fees. Please flag anything requiring our review or signature.'],
    office_action: ['Office action review and response quote', 'Please review the official notice and advise on response options, costs, and the exact response or extension deadline. Please provide the proposed response for review. Do not treat this inquiry as approval of a legal position or authority to submit a response.'],
  }[kind];
  const basis = { undecided: 'Not decided; please advise', use: 'Use in commerce (for review)', intent: 'Intent to use (for review)', foreign: 'Foreign application/registration (for review)', madrid: 'Madrid route (for review)' }[details.filing_basis];
  return {
    to: details.attorney_email,
    subject: `${purpose[0]} — ${details.mark}`.slice(0, 250).replace(/[\r\n]/g, ' '),
    text: `Hello${details.attorney_name ? ` ${details.attorney_name}` : ''},\n\n${purpose[1]}\n\nMark: ${details.mark}\nType: ${details.mark_type}\nProposed owner: ${details.owner_name}\nActual domicile country: ${details.domicile_country || 'To confirm'}\nGoods/services: ${details.goods_services || 'To confirm'}\nProposed classes: ${details.classes.join(', ') || 'To confirm'}\nFiling basis: ${basis}\nUse/evidence notes: ${details.evidence_notes || 'To confirm'}\nApplication serial: ${details.serial_number || 'Not filed / to confirm'}\nNext recorded deadline: ${details.next_due_on || 'To confirm'}\nDeadline source: ${details.deadline_source || 'To confirm with counsel'}\n\nPlease confirm the next steps.\nThank you.`,
  };
}
