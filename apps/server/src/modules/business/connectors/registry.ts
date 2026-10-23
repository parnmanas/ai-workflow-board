import { BadRequestException } from '@nestjs/common';
import type { BusinessConnector } from '../business.types';
import { doolaConnector } from './doola';
import { mercuryConnector } from './mercury';
import { stripeConnector } from './stripe';
import { xeroConnector } from './xero';
import { chatwootConnector } from './chatwoot';

import { quickbooksConnector } from './quickbooks';
import { intercomConnector } from './intercom';
import { zendeskConnector } from './zendesk';
import { freshdeskConnector } from './freshdesk';
import { HANDOFF_CONNECTORS, SERVICE_OFFERINGS } from './service-offerings';

// Descriptors drive setup, comparison and action availability; suppliers' features stay separate.
export const BUSINESS_CONNECTORS: readonly BusinessConnector[] = [
  doolaConnector, mercuryConnector, stripeConnector, xeroConnector, quickbooksConnector,
  chatwootConnector, intercomConnector, zendeskConnector, freshdeskConnector, ...HANDOFF_CONNECTORS,
].map(connector => ({ ...connector, descriptor: { ...connector.descriptor, offering: SERVICE_OFFERINGS[connector.descriptor.id] } }));

export function businessConnector(id: string): BusinessConnector {
  const connector = BUSINESS_CONNECTORS.find(c => c.descriptor.id === id);
  if (!connector) throw new BadRequestException('지원하지 않는 커넥터입니다.');
  return connector;
}
