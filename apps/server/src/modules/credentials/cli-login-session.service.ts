import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CliLoginSession,
  TERMINAL_CLI_LOGIN_SESSION_STATUSES,
} from '../../entities/CliLoginSession';
import { Credential } from '../../entities/Credential';
import { encrypt, decryptStrict } from '../../services/encryption.service';
import { normalizeCredentialFields } from '../../common/credential-fields';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { AgentManagerCommandService } from '../agent-manager/agent-manager-command.service';
import { InstanceRegistryService } from '../agent-manager/instance-registry.service';
import { agentIsVisibleInWorkspace } from '../../common/agent-workspace-scope';
import { catalogLoginCapable } from '../../common/cli-catalog';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// 아래 세 표는 전부 cli-catalog.ts 의 `login` 블록에서 파생된다 — 자동 로그인을
// 새 CLI 에 붙이려면 그 descriptor 에 `login` 을 채우면 된다. codex(b2e79108)에
// 이어 claude(ticket 06b2b990)도 자동화됨 — claude auth login 이 TTY 없이도
// 동작함을 라이브 호스트에서 확인해 codex 와 동일한 crossSpawn 경로로 구현했다.
// (export 는 테스트가 파생 결과를 예전 리터럴과 대조하기 위한 것.)
const LOGIN_CLIS = catalogLoginCapable();

/** cli → 생성할 Credential.provider. */
export const CLI_PROVIDER: Record<string, string> = Object.fromEntries(
  LOGIN_CLIS.map((d) => [d.id, d.login!.harvest_provider]),
);

/**
 * CLI 자신의 계정이 아니라 **그 CLI 안의 provider** 로 로그인하는 CLI
 * (`-p <provider> -m <method>` 를 반드시 받아야 한다). 빠뜨리면 CLI 가 TTY
 * 선택 UI 를 띄우려다 파이프 뒤에서 조용히 멎어 10분 타임아웃까지 "starting"
 * 으로 남는다(실측), 그래서 fail-fast 한다.
 */
export const PROVIDER_SCOPED_CLIS: ReadonlySet<string> = new Set(
  LOGIN_CLIS.filter((d) => d.login!.provider_scoped).map((d) => d.id),
);

/** provider 별 필수 필드 — 카탈로그에서 파생. agent-manager 는 `clis/<id>/index.ts` 의 credentials 슬라이스에서 같은 값을 읽는다(contract 테스트가 일치를 강제). */
export const REQUIRED_FIELD: Record<string, string> = Object.fromEntries(
  LOGIN_CLIS.map((d) => [d.login!.harvest_provider, d.login!.harvest_field]),
);

export interface StartCliLoginSessionArgs {
  workspaceId: string;
  isGlobal: boolean;
  cli: string;
  /** opencode 전용 — `opencode auth login -p <cliProvider> -m <cliMethod>`. */
  cliProvider?: string;
  cliMethod?: string;
  credentialName: string;
  instanceId: string;
  triggeredById: string;
}

export interface ApplyCliLoginProgressArgs {
  sessionId: string;
  callerAgentId: string;
  commandId: string;
  status: 'awaiting_user' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  verificationUrl?: string;
  userCode?: string;
  rawOutputFallback?: string;
  errorDetail?: string;
  credentialFields?: Record<string, string>;
}

const RAW_OUTPUT_FALLBACK_MAX_CHARS = 4000;

/**
 * CLI device-auth 자동 로그인 세션의 시작/진행/완료/취소를 담당. 실제 로그인
 * 실행은 agent-manager(cli_login_start 커맨드)가 하고, 이 서비스는 세션 상태
 * 저장 + credential 생성 + SSE 진행상황 push만 맡는다.
 */
@Injectable()
export class CliLoginSessionService {
  constructor(
    @InjectRepository(CliLoginSession) private readonly sessionRepo: Repository<CliLoginSession>,
    @InjectRepository(Credential) private readonly credRepo: Repository<Credential>,
    private readonly commandService: AgentManagerCommandService,
    private readonly instanceRegistry: InstanceRegistryService,
    private readonly logService: LogService,
  ) {}

  async startSession(args: StartCliLoginSessionArgs): Promise<CliLoginSession> {
    const provider = CLI_PROVIDER[args.cli];
    if (!provider) {
      throw makeError(400, `Unsupported cli "${args.cli}" — only ${Object.keys(CLI_PROVIDER).join('/')} are automated so far`);
    }
    if (!args.credentialName?.trim()) {
      throw makeError(400, 'credential_name is required');
    }
    const cliProvider = (args.cliProvider || '').trim();
    const cliMethod = (args.cliMethod || '').trim();
    if (PROVIDER_SCOPED_CLIS.has(args.cli) && (!cliProvider || !cliMethod)) {
      throw makeError(400, `${args.cli} login needs both cli_provider and cli_method (e.g. openai / "ChatGPT Pro/Plus (headless)")`);
    }
    const inst = this.instanceRegistry
      .list()
      .find((i) => i.instance_id === args.instanceId && i.mode === 'manager');
    if (!inst) {
      throw makeError(404, 'That Runtime Host instance is not currently online');
    }
    // 리뷰 지적(round 1): instance_id는 클라이언트가 그대로 제출하는 값이라,
    // 이 검증이 없으면 다른 workspace의 manager instance_id를 직접 넣어
    // command를 보낼 수 있었다. 전역(is_global) 세션은 자기 자신의
    // listCliLoginInstances(workspace_id 없음)가 이미 모든 workspace의
    // 인스턴스를 보여주는 것과 동일하게 어떤 instance든 허용하고, workspace
    // 세션은 그 instance가 이 workspace에서 실제로 보이는 경우(전역
    // instance 포함)에만 허용한다.
    if (!args.isGlobal && !agentIsVisibleInWorkspace(inst.workspace_id, args.workspaceId)) {
      throw makeError(403, 'That Runtime Host instance is not available in this workspace');
    }

    const session = await this.sessionRepo.save(
      this.sessionRepo.create({
        workspace_id: args.workspaceId,
        is_global: args.isGlobal,
        cli: args.cli,
        cli_provider: cliProvider,
        cli_method: cliMethod,
        credential_name: args.credentialName.trim(),
        status: 'starting',
        instance_id: inst.instance_id,
        manager_agent_id: inst.agent_id,
        triggered_by_id: args.triggeredById,
        started_at: new Date(),
      }),
    );

    const { command_id } = await this.commandService.issue(
      inst,
      'cli_login_start',
      // cli_provider/cli_method 는 opencode 에서만 의미가 있지만 항상 실어 보낸다 —
      // 매니저가 CLI 별로 해석하고, 구버전 매니저는 모르는 키를 무시한다.
      { session_id: session.id, cli: args.cli, cli_provider: cliProvider, cli_method: cliMethod },
      args.triggeredById,
    );
    session.command_id = command_id;
    await this.sessionRepo.save(session);
    this.emitProgress(session);
    return session;
  }

  async getSession(sessionId: string, workspaceId: string): Promise<CliLoginSession | null> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) return null;
    // 글로벌 세션(is_global)은 어느 workspace에서든 조회 가능 — Credential의
    // "글로벌은 어디서든 read 가능" 규약과 동일.
    if (!session.is_global && session.workspace_id !== workspaceId) return null;
    return session;
  }

  async cancelSession(sessionId: string, workspaceId: string): Promise<CliLoginSession> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session || (!session.is_global && session.workspace_id !== workspaceId)) {
      throw makeError(404, 'Login session not found');
    }
    if (TERMINAL_CLI_LOGIN_SESSION_STATUSES.includes(session.status)) {
      return session; // 이미 끝남 — idempotent no-op.
    }
    const inst = this.instanceRegistry
      .list()
      .find((i) => i.instance_id === session.instance_id && i.mode === 'manager');
    if (inst) {
      // best-effort dispatch — 매니저가 오프라인이어도 세션은 아래에서 즉시
      // 종료 처리되어 UI는 곧바로 반응한다. 매니저 자신의 내부 타임아웃(10분)
      // 이 실제 프로세스/임시 홈 정리의 최종 백스톱이다.
      await this.commandService
        .issue(inst, 'cli_login_cancel', { session_id: session.id }, session.triggered_by_id)
        .catch((err: any) => {
          this.logService.warn(
            'Credentials',
            `cli_login_cancel dispatch failed for session=${session.id.slice(0, 8)}: ${err?.message ?? err}`,
          );
        });
    }
    session.status = 'cancelled';
    session.error_detail = 'Cancelled by user';
    session.finished_at = new Date();
    await this.sessionRepo.save(session);
    this.emitProgress(session);
    return session;
  }

  /**
   * 매니저 → 서버: 진행상황/완료 보고. 소유권(caller가 이 세션을 시작한
   * manager_agent_id와 같은지)을 여기서 검증한다.
   */
  async applyProgress(args: ApplyCliLoginProgressArgs): Promise<CliLoginSession> {
    const session = await this.sessionRepo.findOne({ where: { id: args.sessionId } });
    if (!session) throw makeError(404, 'Login session not found');
    if (session.manager_agent_id !== args.callerAgentId) {
      throw makeError(403, 'caller is not the manager that owns this login session');
    }
    // 리뷰 지적(round 1): args.commandId가 비어 있으면 검사를 통째로
    // 건너뛰던 버그 — 호출자가 command_id를 아예 안 보내는 방식으로 이
    // 검증을 우회할 수 있었다. 이제 항상 비어있지 않아야 한다. session
    // 쪽 command_id가 아직 비어 있는 경우(startSession의 2단계 저장 — 세션
    // 생성 → command 발행 → command_id 되저장 — 사이의 극히 짧은 경합
    // 창)에는 최초 보고를 그대로 신뢰한다: 소유권(manager_agent_id 일치)이
    // 이미 위에서 fail-closed로 강제되므로 이 관용이 보안 경계를 넓히지
    // 않는다 — command_id는 같은 manager의 stale/중복 dispatch를 가려내는
    // 2차 방어선일 뿐이다.
    if (!args.commandId) {
      throw makeError(409, 'command_id is required');
    }
    if (session.command_id && session.command_id !== args.commandId) {
      throw makeError(409, 'command_id does not match this session — stale/superseded report ignored');
    }
    if (TERMINAL_CLI_LOGIN_SESSION_STATUSES.includes(session.status)) {
      // 이미 끝난 세션에 대한 뒤늦은 중복 보고(outbox 재전송 등) — 조용히
      // idempotent 200으로 처리해 매니저 쪽 재시도가 에러로 보이지 않게 한다.
      return session;
    }

    if (args.status === 'awaiting_user') {
      session.status = 'awaiting_user';
      const url = args.verificationUrl?.trim();
      const code = args.userCode?.trim();
      // url 과 code 는 **따로** 온다. codex 는 둘을 한 번에 보내지만 claude 는
      // code 자체가 없어 url 만 보내고(승인은 링크를 여는 것이 전부), opencode 는
      // url 줄과 code 줄이 차례로 나와 두 번에 걸쳐 온다. 예전엔 `url && code` 일
      // 때만 저장해서 — claude 로그인은 링크를 끝내 화면에 못 띄웠다. 온 것만 각각
      // 반영하고, 진짜 url 이 잡히면 raw fallback 은 역할이 끝났으므로 비운다.
      if (url) {
        session.verification_url = url;
        session.raw_output_fallback = null;
      }
      if (code) session.user_code = code;
      if (!url && !code && args.rawOutputFallback?.trim()) {
        // 리뷰 지적(round 1): 티켓이 명시한 파싱 실패 폴백. url/code를 아직
        // 못 찾았을 때만 raw 출력을 보여준다 — 이미 진짜 url/code가 있으면
        // 그걸 덮어쓰지 않는다.
        session.raw_output_fallback = args.rawOutputFallback.trim().slice(0, RAW_OUTPUT_FALLBACK_MAX_CHARS);
      }
      await this.sessionRepo.save(session);
      this.emitProgress(session);
      return session;
    }

    if (args.status === 'succeeded') {
      const provider = CLI_PROVIDER[session.cli];
      const requiredField = REQUIRED_FIELD[provider];
      // Normalize before the required-field check so a CLI whose captured
      // output wrapped the token can't store an unusable secret.
      const fields = normalizeCredentialFields(args.credentialFields || {});
      if (!requiredField || !fields[requiredField]?.trim()) {
        throw makeError(400, `credential_fields.${requiredField || '?'} is required on success`);
      }
      const plaintext = JSON.stringify(fields);
      const encrypted = encrypt(plaintext);
      if (decryptStrict(encrypted) !== plaintext) {
        throw makeError(500, 'Credential encryption verification failed; credential was not saved');
      }
      const credential = await this.credRepo.save(
        this.credRepo.create({
          workspace_id: session.is_global ? null : session.workspace_id,
          board_id: null,
          name: session.credential_name,
          description: session.cli_provider
            ? `Automatically created via CLI device-auth login (${session.cli} / ${session.cli_provider}).`
            : `Automatically created via CLI device-auth login (${session.cli}).`,
          provider,
          encrypted_data: encrypted,
        }),
      );
      session.status = 'succeeded';
      session.created_credential_id = credential.id;
      session.finished_at = new Date();
      await this.sessionRepo.save(session);
      this.emitProgress(session);
      return session;
    }

    // failed | timed_out | cancelled — 매니저가 스스로 보고하는 경우(예: 취소
    // 커맨드 처리 중 프로세스가 이미 실패로 끝나 있음을 발견).
    session.status = args.status;
    session.error_detail = args.errorDetail || session.error_detail;
    session.finished_at = new Date();
    await this.sessionRepo.save(session);
    this.emitProgress(session);
    return session;
  }

  /** CliLoginSessionReaperService가 호출 — 오래 non-terminal인 세션을 회수. */
  async reapStale(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const stale = await this.sessionRepo
      .createQueryBuilder('s')
      .where('s.status IN (:...statuses)', { statuses: ['starting', 'awaiting_user', 'completing'] })
      .andWhere('s.created_at < :cutoff', { cutoff })
      .getMany();
    for (const session of stale) {
      session.status = 'timed_out';
      session.error_detail =
        session.error_detail ||
        '[auto-reaped by CliLoginSessionReaperService] manager did not report completion before timeout';
      session.finished_at = new Date();
      await this.sessionRepo.save(session);
      this.emitProgress(session);
    }
    return stale.length;
  }

  private emitProgress(session: CliLoginSession): void {
    activityEvents.emit('cli_login_progress', {
      session_id: session.id,
      workspace_id: session.workspace_id,
      status: session.status,
      verification_url: session.verification_url,
      user_code: session.user_code,
      raw_output_fallback: session.raw_output_fallback,
      error_detail: session.error_detail,
      created_credential_id: session.created_credential_id,
      triggered_by_id: session.triggered_by_id,
      timestamp: new Date().toISOString(),
    });
  }
}
