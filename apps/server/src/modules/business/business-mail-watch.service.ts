import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BusinessMailConnection } from '../../entities/BusinessMailConnection';
import { BusinessMailService } from './business-mail.service';
import { mailConnector } from './mail/mail-registry';
import { mailDigest } from './mail/mail-automation';

/** IDLE wakes the ordinary, leased cursor sync. No long-running sync lease or remote read-flag writes. */
@Injectable()
export class BusinessMailWatchService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private checking = false;
  private watchers = new Map<string, { signature: string; controller: AbortController }>();
  private wakeups = new Map<string, NodeJS.Timeout>();
  private retryAt = new Map<string, number>();
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly mail: BusinessMailService) {}
  onModuleInit() {
    this.timer = setInterval(() => { void this.reconcile().catch(() => {}); }, 15_000); this.timer.unref();
    void this.reconcile().catch(() => {});
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const w of this.watchers.values()) w.controller.abort();
    for (const timer of this.wakeups.values()) clearTimeout(timer);
    this.watchers.clear(); this.wakeups.clear(); this.mail.watchStates.clear();
  }
  private wake(row: BusinessMailConnection, delay = 250) {
    if (this.stopped || this.wakeups.has(row.id)) return;
    const timer = setTimeout(() => {
      this.wakeups.delete(row.id);
      void this.mail.sync([row.account_id], row.id).then(result => {
        if (result.has_more) this.wake(row, 1000);
      }).catch(() => {
        // Busy during a send/configuration is normal. The persisted polling cursor also catches gaps.
        if (this.watchers.has(row.id)) this.wake(row, 15_000);
      });
    }, delay);
    timer.unref(); this.wakeups.set(row.id, timer);
  }
  async reconcile() {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      const rows = await this.ds.getRepository(BusinessMailConnection).find({ where: { enabled: true }, order: { created_at: 'ASC' }, take: 100 });
      const eligible = new Set(rows.map(r => r.id));
      for (const [id, watcher] of this.watchers) if (!eligible.has(id)) {
        watcher.controller.abort(); this.watchers.delete(id); this.mail.watchStates.delete(id);
      }
      for (const row of rows) {
        const connector = mailConnector(row.provider);
        if (!connector.watch) continue;
        try {
          const context = await this.mail.watchContext(row);
          if (row.provider === 'smtp_imap' && !context.config.imap) continue;
          const signature = mailDigest({ config: context.config, secrets: context.secrets, account: row.account_id });
          const current = this.watchers.get(row.id);
          if (current?.signature === signature) continue;
          if (current) { current.controller.abort(); this.watchers.delete(row.id); }
          if ((this.retryAt.get(row.id) || 0) > Date.now() || this.stopped) continue;
          const watcher = { signature, controller: new AbortController() };
          this.watchers.set(row.id, watcher);
          void connector.watch(context, () => {
            if (watcher.controller.signal.aborted || this.stopped) return;
            this.mail.watchStates.set(row.id, { mode: row.provider === 'jmap' ? 'push' : 'idle' }); this.wake(row);
          }, watcher.controller.signal).catch(() => {}).finally(() => {
            if (this.watchers.get(row.id) !== watcher) return;
            this.watchers.delete(row.id);
            this.retryAt.set(row.id, Date.now() + 30_000);
            this.mail.watchStates.set(row.id, { mode: 'polling', error: '실시간 연결 재시도 중 · 주기 수집은 계속됩니다.' });
          });
        } catch {
          this.watchers.get(row.id)?.controller.abort(); this.watchers.delete(row.id);
          this.mail.watchStates.set(row.id, { mode: 'polling', error: '수신 연결·소유자 권한을 확인하세요.' });
        }
      }
      for (const id of this.retryAt.keys()) if (!eligible.has(id)) this.retryAt.delete(id);
    } finally { this.checking = false; }
  }
}
