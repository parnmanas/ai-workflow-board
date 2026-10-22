import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { MarketingBrand } from '../dist/entities/MarketingBrand.js';
import { MarketingContactConsent } from '../dist/entities/MarketingContactConsent.js';
import { MarketingContact } from '../dist/entities/MarketingContact.js';
import { MarketingConsentNotice } from '../dist/entities/MarketingConsentNotice.js';
import { MarketingConsentNoticeSetting } from '../dist/entities/MarketingConsentNoticeSetting.js';
import { MarketingConsentNoticeService } from '../dist/modules/marketing/marketing-consent-notice.service.js';
import { CONSENT_MAX_AGE_MS } from '../dist/common/marketing/email.js';

test('notice cycles, keep and renewal are isolated by brand; legacy and global suppression fail closed', async () => {
  const ds = await new DataSource({ type: 'sqljs', synchronize: true, entities: [
    MarketingBrand, MarketingContactConsent, MarketingContact, MarketingConsentNotice, MarketingConsentNoticeSetting,
  ] }).initialize();
  try {
    const contacts = ds.getRepository(MarketingContact);
    const consents = ds.getRepository(MarketingContactConsent);
    const notices = ds.getRepository(MarketingConsentNotice);
    const settings = ds.getRepository(MarketingConsentNoticeSetting);
    const token = () => randomBytes(32).toString('base64url');
    const now = new Date('2026-10-23T03:00:00Z');
    const due = new Date(now.getTime() + 30 * 60000);
    const original = new Date(due.getTime() - CONSENT_MAX_AGE_MS);
    const contact = await contacts.save(contacts.create({
      account_id: 'account', email: 'person@example.com', email_hash: 'hash', unsubscribe_token: token(),
      consent_at: original, consent_method: 'import', consent_source: 'legacy', lists: ['news'],
    }));
    const brands = await ds.getRepository(MarketingBrand).save(['Alpha', 'Beta'].map(name => ({ account_id: 'account', name })));
    const rows = await consents.save(brands.map(brand => ({
      account_id: 'account', contact_id: contact.id, brand_id: brand.id, consent_at: original,
      consent_method: 'signup_form', consent_source: brand.name, unsubscribe_token: token(),
    })));
    await settings.save(settings.create({ account_id: 'account', enabled: true }));
    const audit = { record: async () => {}, notify() {} };
    const service = new MarketingConsentNoticeService(notices, settings, contacts, {}, {}, {}, ds, {}, audit, {}, { warn() {} });
    service.channelRepo = { find: async () => brands.map((b, i) => ({
      id: 'channel-' + i, account_id: 'account', campaign_id: 'campaign', config: { brand_id: b.id, list_name: 'news' },
    })) };
    service.campaignRepo = { find: async () => [{ id: 'campaign', status: 'active' }] };
    service.sendRepo = { findOne: async () => ({ channel_id: 'channel-1' }) };
    service.email = { senderFor: async (channel) => ({ sender: { from_name: channel.id } }) };
    const ctx = { settings: new Map(), channels: new Map(), senders: new Map() };
    assert.equal((await service.senderForContact(contact, brands[0].id, ctx)).channel.id, 'channel-0',
      'recent mail from another brand never determines this notice sender');
    assert.equal(await service.senderForContact(contact, 'unknown-brand', ctx), null);
    assert.equal(await service.plan(now), 2, 'same contact and due date produce independent brand cycles');
    assert.equal(await service.plan(now), 0, 'each brand cycle is idempotent');
    const alpha = await notices.findOneByOrFail({ consent_id: rows[0].id });
    const beta = await notices.findOneByOrFail({ consent_id: rows[1].id });
    assert.equal(await service.keepBrand(alpha.token), 'Alpha');
    assert.equal((await service.keep(alpha.token, now)).kept, true);
    assert.equal((await consents.findOneByOrFail({ id: rows[0].id })).consent_at.getTime(), now.getTime());
    assert.equal((await consents.findOneByOrFail({ id: rows[1].id })).consent_at.getTime(), original.getTime());
    assert.equal((await contacts.findOneByOrFail({ id: contact.id })).consent_at.getTime(), original.getTime());
    await notices.update(beta.id, { status: 'sent', policy: 'keep' });
    assert.equal(await service.renewDue(now), 1);
    assert.equal((await consents.findOneByOrFail({ id: rows[1].id })).consent_renewed_at.getTime(), due.getTime());
    assert.equal((await consents.findOneByOrFail({ id: rows[0].id })).consent_renewed_at, null);
    const legacy = await notices.save(notices.create({
      account_id: 'account', contact_id: contact.id, due_at: due, next_attempt_at: now, token: token(), status: 'sent', policy: 'keep',
    }));
    assert.equal(await service.keepBrand(legacy.token), null);
    assert.equal((await service.keep(legacy.token, now)).kept, false);
    assert.equal(await service.renewDue(now), 0, 'historical account notices cannot renew migrated evidence');
    await contacts.update(contact.id, { status: 'unsubscribed' });
    assert.equal((await service.keep(alpha.token, now)).kept, false, 'global suppression overrides a brand token');
    await notices.update(legacy.id, { status: 'queued' });
    assert.equal((await service.processQueue(now)).skipped, 2);
  } finally {
    await ds.destroy();
  }
});
