import { DataSource } from 'typeorm';
import { BusinessFormation } from '../../entities/BusinessFormation';
import { BusinessTrademarkMail } from '../../entities/BusinessTrademarkMail';
import { BusinessTrademarkIntegration } from '../../entities/BusinessTrademarkIntegration';
import { BusinessTrademarkAction } from '../../entities/BusinessTrademarkAction';
import { BusinessConnection } from '../../entities/BusinessConnection';
import { findMarketingCredentialDependents } from './marketing-credential-dependents';

/** Every server-only consumer participates in deletion, ownership and agent-env checks. */
export async function findServerCredentialDependents(ds: DataSource, credentialId: string) {
  const marketing = await findMarketingCredentialDependents(ds, credentialId);
  // Narrow module test DataSources may omit Business; the application entity registry always includes it.
  const business = ds.hasMetadata(BusinessConnection) ? await ds.getRepository(BusinessConnection).find({
    where: { credential_id: credentialId }, select: ['id', 'account_id'],
  }) : [];
  const formations = ds.hasMetadata(BusinessFormation) ? await ds.getRepository(BusinessFormation).find({ where: { credential_id: credentialId }, select: ['id', 'account_id'] }) : [];
  const trademarkMail = ds.hasMetadata(BusinessTrademarkMail) ? await ds.getRepository(BusinessTrademarkMail).find({ where: { credential_id: credentialId }, select: ['id', 'account_id'] }) : [];
  const integrations = ds.hasMetadata(BusinessTrademarkIntegration) ? await ds.getRepository(BusinessTrademarkIntegration).find({ where: { credential_id: credentialId }, select: ['id', 'account_id'] }) : [];
  const actions = ds.hasMetadata(BusinessTrademarkAction) ? await ds.getRepository(BusinessTrademarkAction).find({ where: { credential_id: credentialId }, select: ['id', 'account_id'] }) : [];
  return [...marketing, { label: 'business connection(s)', rows: business }, { label: 'business formation(s)', rows: formations }, { label: 'trademark correspondence record(s)', rows: trademarkMail }, { label: 'trademark integration(s)', rows: integrations }, { label: 'trademark action(s)', rows: actions }];
}
