import { BadRequestException } from '@nestjs/common';
import type { TrademarkConnector } from './trademark-connector';
import { trademarkResend } from './trademark-resend';
import { trademarkGmail, trademarkMicrosoft } from './trademark-mailboxes';
import { trademarkDocusign } from './trademark-docusign';
import { trademarkClio } from './trademark-clio';
import { trademarkTsdr } from './trademark-tsdr';

/** Add a provider here; service, scheduler and UI consume its capabilities. */
export const TRADEMARK_CONNECTORS: readonly TrademarkConnector[] = [trademarkResend, trademarkGmail, trademarkMicrosoft, trademarkDocusign, trademarkClio, trademarkTsdr];
export function trademarkConnector(provider: string): TrademarkConnector {
  const connector = TRADEMARK_CONNECTORS.find(item => item.descriptor.id === provider);
  if (!connector) throw new BadRequestException('지원하는 상표 커넥터를 선택하세요.');
  return connector;
}
