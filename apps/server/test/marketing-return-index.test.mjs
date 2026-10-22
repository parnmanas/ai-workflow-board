import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { MarketingSpendRequest } from '../dist/entities/MarketingSpendRequest.js';

test('existing database upgrades target index and keeps returns exclusive across campaigns', async () => {
  const db = new DataSource({ type: 'sqljs', entities: [MarketingSpendRequest], synchronize: true });
  await db.initialize();
  try {
    // Reconstruct the previous schema, then exercise the same synchronize path used at boot.
    await db.query('DROP INDEX uq_marketing_spend_open_target_v2');
    await db.query("CREATE UNIQUE INDEX uq_marketing_spend_open_target ON marketing_spend_requests (target_key) WHERE target_key <> '' AND status IN ('pending', 'approved', 'executing', 'unknown')");
    await db.query('ALTER TABLE marketing_spend_requests DROP COLUMN return_status');
    await db.query('ALTER TABLE marketing_spend_requests DROP COLUMN return_operation');
    await db.synchronize();
    await db.synchronize();
    const indexes = await db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'marketing_spend_requests'");
    assert.equal(indexes.some(i => i.name === 'uq_marketing_spend_open_target'), false);
    assert.match(indexes.find(i => i.name === 'uq_marketing_spend_open_target_v2').sql, /return_status/);
    const repo = db.getRepository(MarketingSpendRequest);
    const base = {
      account_id: 'owner', campaign_id: 'campaign-a', channel_id: 'channel', amount_minor: 100,
      currency: 'USD', payee: 'Ads', purpose: 'test', provider: 'meta_ads', payload_sha256: 'hash',
      expires_at: new Date(), target_key: 'meta_ads:act_1/2', status: 'paid', return_status: 'unknown',
    };
    const returning = await repo.save(repo.create(base));
    await assert.rejects(repo.save(repo.create({ ...base, campaign_id: 'campaign-b', account_id: 'other', status: 'pending', return_status: '' })), /UNIQUE/);
    await assert.rejects(repo.save(repo.create({ ...base, campaign_id: 'campaign-b', return_status: 'executing' })), /UNIQUE/);
    await repo.update(returning.id, { return_status: 'completed' });
    await repo.save(repo.create({ ...base, status: 'pending', return_status: '' }));
    await assert.rejects(repo.update(returning.id, { return_status: 'executing' }), /UNIQUE/);
  } finally {
    await db.destroy();
  }
});
