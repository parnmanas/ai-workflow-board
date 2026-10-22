import test from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { MarketingContact } from '../dist/entities/MarketingContact.js';
import { MarketingBrand } from '../dist/entities/MarketingBrand.js';
import { MarketingContactConsent } from '../dist/entities/MarketingContactConsent.js';
import { MarketingContactService } from '../dist/modules/marketing/marketing-contact.service.js';

const actor = { type: 'user', id: 'operator', name: 'operator' };
const entry = { email: 'reader@example.com', consent_at: new Date().toISOString(), consent_method: 'signup_form', consent_source: 'signup', night_consent: true };

test('brand consent isolates imports, withdrawals and legacy migration, preserves global suppression', async (t) => {
  const ds = new DataSource({ type: 'sqljs', entities: [MarketingContact, MarketingBrand, MarketingContactConsent], synchronize: true });
  await ds.initialize();
  t.after(() => ds.destroy());
  const repo = ds.getRepository(MarketingContact);
  const service = new MarketingContactService(repo, { record: async () => {} });
  await assert.rejects(service.createBrand('account', 'Brand\r\nInjected', actor), /control characters/);
  const a = await service.createBrand('account', 'Brand A', actor);
  const b = await service.createBrand('account', 'Brand B', actor);
  await assert.rejects(service.import('account', { lists: ['news'], contacts: [entry] }, actor), /brand not found/);
  await assert.rejects(service.import('foreign', { brand_id: a.id, lists: ['news'], contacts: [entry] }, actor), /brand not found/);
  for (const brand of [a, b]) assert.equal((await service.import('account', { brand_id: brand.id, lists: ['news'], contacts: [entry] }, actor)).invalid.length, 0);
  const contact = await repo.findOneByOrFail({ account_id: 'account' });
  const ca = await service.consentFor(contact.id, 'account', a.id);
  const cb = await service.consentFor(contact.id, 'account', b.id);
  assert.notEqual(ca.unsubscribe_token, cb.unsubscribe_token);
  assert.equal((await service.eligible('account', 'news')).contacts.length, 0);
  assert.equal((await service.eligible('account', 'news', new Date(), b.id)).contacts.length, 1);
  const withdrawn = await service.unsubscribeByToken(ca.unsubscribe_token, 'one_click');
  assert.equal(withdrawn.brand_id, a.id);
  assert.equal((await service.eligible('account', 'news', new Date(), a.id)).contacts.length, 0);
  assert.equal((await service.eligible('account', 'news', new Date(), b.id)).contacts.length, 1);
  assert.equal((await service.import('account', { brand_id: a.id, lists: ['news'], contacts: [entry] }, actor)).suppressed, 1);
  assert.equal((await service.migrateLegacy('account', b.id, [contact.id], actor)).migrated, 0, 'new imports cannot be reinterpreted as legacy evidence');
  await service.unsubscribeByToken(contact.unsubscribe_token, 'link');
  assert.equal((await service.eligible('account', 'news', new Date(), b.id)).contacts.length, 0, 'old global links still suppress every brand');

  const legacy = await repo.save(repo.create({ ...contact, id: undefined, email: 'legacy@example.com', email_hash: 'legacy', unsubscribe_token: 'old-legacy-token', status: 'subscribed', legacy_consent_migrated: false }));
  assert.equal((await service.migrateLegacy('account', a.id, [legacy.id], actor)).migrated, 1);
  assert.equal((await service.migrateLegacy('account', b.id, [legacy.id], actor)).migrated, 0);
  assert.equal(await service.consentFor(legacy.id, 'account', b.id), null);
  await assert.rejects(service.migrateLegacy('foreign', a.id, [legacy.id], actor), /brand not found/);
  await service.erase(legacy.id, 'account', actor);
  assert.equal((await service.consentFor(legacy.id, 'account', a.id)).status, 'erased');
});


test('schema upgrade preserves legacy token and evidence and initializes an unassigned migration marker', async (t) => {
  const ds = new DataSource({ type: 'sqljs', entities: [MarketingContact, MarketingBrand, MarketingContactConsent], synchronize: true });
  await ds.initialize();
  t.after(() => ds.destroy());
  const repo = ds.getRepository(MarketingContact);
  const legacy = await repo.save(repo.create({ account_id: 'account', email: 'legacy@example.com', email_hash: 'hash',
    consent_method: 'event', consent_source: 'original event', consent_at: new Date('2025-01-01T00:00:00Z'),
    unsubscribe_token: 'legacy-stable-token', lists: ['original-list'], night_consent: true }));
  await ds.query('ALTER TABLE marketing_contacts DROP COLUMN legacy_consent_migrated');
  await ds.query('DROP TABLE marketing_contact_consents');
  await ds.query('DROP TABLE marketing_brands');
  await ds.synchronize();
  const upgraded = await repo.findOneByOrFail({ id: legacy.id });
  assert.equal(upgraded.unsubscribe_token, legacy.unsubscribe_token);
  assert.equal(upgraded.consent_source, 'original event');
  assert.equal(upgraded.consent_at.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(upgraded.night_consent, true);
  assert.equal(upgraded.legacy_consent_migrated, false);
  assert.equal(await ds.getRepository(MarketingContactConsent).count(), 0, 'upgrade must not infer a brand');
});
