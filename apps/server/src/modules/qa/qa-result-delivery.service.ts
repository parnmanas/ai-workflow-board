import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { QaRun, TERMINAL_QA_RUN_STATUSES } from '../../entities/QaRun';
import { QaScenario } from '../../entities/QaScenario';
import { Channel } from '../../entities/Channel';
import { Project } from '../../entities/Project';
import { DiscordService } from '../../services/discord.service';
import { BusinessMailService } from '../business/business-mail.service';
import { LogService } from '../../services/log.service';
import { flushSqljs } from '../../db';
import { isQaFailure, validateResultDelivery } from './qa-result-policy';
import { ticketPath } from '../../common/artifact-ref';
import { publicBaseUrl } from '../../common/public-url';

@Injectable()
export class QaResultDeliveryService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly discord: DiscordService,
    private readonly mail: BusinessMailService,
    private readonly log: LogService,
  ) {}

  async deliver(run: QaRun): Promise<void> {
    if (!TERMINAL_QA_RUN_STATUSES.includes(run.status)) return;
    const scenario = run.result_policy_snapshot ?? await this.ds.getRepository(QaScenario).findOneBy({ id: run.scenario_id, account_id: run.account_id });
    const policy = scenario?.result_delivery;
    if (!scenario || !policy || (!policy.channel_ids.length && !policy.email)) return;
    if (policy.when === 'failure' && !isQaFailure(run.status)) return;
    const repo = this.ds.getRepository(QaRun);
    // Claim before network I/O. Ambiguous sends stay visible as 'sending' and
    // are never replayed automatically, including across server restarts.
    const claim = await repo.update({ id: run.id, account_id: run.account_id, delivery_status: IsNull() }, { delivery_status: 'sending' });
    if (claim.affected !== 1) return;
    run.delivery_status = 'sending';
    const results: NonNullable<QaRun['delivery_results']> = [];
    try {
      await flushSqljs(this.ds, true);
      const project = scenario.project_id ? await this.ds.getRepository(Project).findOneBy({ id: scenario.project_id, account_id: run.account_id }) : null;
      const title = `[QA ${run.status}] ${project ? `${project.name} / ` : ''}${scenario.name}`.replace(/[\r\n]/g, ' ').slice(0, 250);
      const base = publicBaseUrl();
      const body = [title, `Run: ${run.id}`, `Project: ${scenario.project_id || '—'}`, run.summary,
        ...(run.step_results || []).map(s => `Step ${s.idx + 1}: ${s.status}${s.log ? ` — ${s.log}` : ''}`),
        run.auto_ticket_id ? `Ticket: ${base}${ticketPath(run.account_id, run.auto_ticket_id)}` : '',
        ...(run.artifact_resource_ids || []).map(id => `Artifact: ${base}/api/resources/${encodeURIComponent(id)}/raw`),
        `QA: ${base}/qa`,
      ].filter(Boolean).join('\n\n').slice(0, 100000);
      for (const id of policy.channel_ids) {
        try {
          await validateResultDelivery(this.ds, run.account_id, { ...policy, channel_ids: [id], email: null });
          const channel = await this.ds.getRepository(Channel).findOneByOrFail({ id, account_id: run.account_id });
          const sent = await this.discord.sendDiscordMessage(channel, { content: '', embeds: [{ title, description: body.slice(0, 4000) }] });
          if (!sent) throw new Error('공유 채널 발송에 실패했습니다.');
          results.push({ target: `channel:${id}`, status: 'sent' });
        } catch {
          results.push({ target: `channel:${id}`, status: 'failed', error: '공유 채널의 소유 계정·활성 상태·인증 정보를 확인하세요.' });
        }
      }
      if (policy.email) {
        try {
          await validateResultDelivery(this.ds, run.account_id, { ...policy, channel_ids: [] });
          await this.mail.activeOwner(run.account_id);
          const result = await this.mail.send([run.account_id], policy.email.connection_id, {
            request_id: run.id, from: policy.email.from, to: policy.email.to, subject: title, text: body, confirm: true,
          }, 'qa');
          if (result.status !== 'accepted') throw new Error('메일 발송 결과를 확인할 수 없습니다.');
          results.push({ target: 'email', status: 'sent' });
        } catch {
          results.push({ target: 'email', status: 'failed', error: '메일 연결·권한·발신 기록을 확인하세요. 중복 발송 방지를 위해 자동 재시도하지 않습니다.' });
        }
      }
    } catch {
      results.push({ target: 'delivery', status: 'failed', error: '결과 전송을 준비하지 못했습니다.' });
    }
    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.some(r => r.status === 'failed');
    run.delivery_status = failed ? (sent ? 'partial' : 'failed') : 'sent';
    run.delivery_results = results;
    await repo.update({ id: run.id }, { delivery_status: run.delivery_status, delivery_results: results });
    if (failed) this.log.warn('QA', `Result delivery ${run.delivery_status} for run ${run.id}`);
  }
}
