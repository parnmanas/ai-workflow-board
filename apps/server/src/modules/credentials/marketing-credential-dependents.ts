import { DataSource, In } from 'typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingSpendRequest } from '../../entities/MarketingSpendRequest';

/** simple-json is text in both databases. Let TypeORM decode it and compare
 * exact IDs, avoiding dialect-specific JSON operators and substring matches.
 * Select only reference fields; never expose another Account's names/config. */
export async function findMarketingCredentialDependents(dataSource: DataSource, credentialId: string) {
  const campaigns = await dataSource.getRepository(MarketingCampaign).find({
    select: ['id', 'account_id', 'payment_credential_id', 'payees'],
  });
  const channels = await dataSource.getRepository(MarketingChannel).find({
    select: ['id', 'account_id', 'config'],
  });
  const requests = await dataSource.getRepository(MarketingSpendRequest).find({
    select: ['id', 'account_id'],
    where: [
      { provider_credential_id: credentialId, status: In(['pending', 'approved', 'executing', 'unknown']) },
      { provider_credential_id: credentialId, return_status: In(['executing', 'unknown']) },
    ],
  });
  return [
    { label: 'marketing campaign(s)', rows: campaigns.filter(row =>
      row.payment_credential_id === credentialId
      || (Array.isArray(row.payees) && row.payees.some(payee => payee?.credential_id === credentialId))) },
    { label: 'marketing channel(s)', rows: channels.filter(row => row.config?.credential_id === credentialId) },
    { label: 'open marketing payment request(s)', rows: requests },
  ];
}
