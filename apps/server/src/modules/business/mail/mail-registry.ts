import { BadRequestException } from '@nestjs/common';
import { smtpImapConnector } from './smtp-imap.connector';
import { jmapConnector } from './jmap.connector';
import type { MailConnector } from './mail.types';

export const MAIL_CONNECTORS: MailConnector[] = [smtpImapConnector, jmapConnector];
export function mailConnector(provider: string): MailConnector {
  const connector = MAIL_CONNECTORS.find(c => c.descriptor.id === provider);
  if (!connector) throw new BadRequestException('지원하지 않는 메일 커넥터입니다.');
  return connector;
}
