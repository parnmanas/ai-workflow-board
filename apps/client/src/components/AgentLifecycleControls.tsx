import React, { useCallback, useMemo, useState } from 'react';
import { api } from '../api';
import type { AgentLifecycleState, AgentManagerCommandKind, AgentManagerInstance } from '../types';
import { tokens } from '../tokens';
import { Button, Badge, Input } from './common';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { waitForCommandAck } from './admin/agentManagerModelRefresh';
import { cliUpdateState } from '../utils/cliVersions';

/**
 * AgentLifecycleControls — per-managed-agent lifecycle surface for the
 * workspace "AI Agents" screen (ticket e371a2b5).
 *
 * The whole control channel already exists end-to-end:
 *   • server: POST /api/admin/agent-manager/instances/:id/command emits the
 *     `agent_manager_command` SSE (all 11 verbs, arg hydration for
 *     spawn_agent).
 *   • agent-manager: AgentManagerCommandHandler executes each verb and reports
 *     the outcome via POST /api/agent-manager/command/ack.
 *   • running-state source: the manager's instance heartbeat carries
 *     `agent_ids[]` — the managed agents it currently supervises (running).
 *
 * This component is pure wiring on top of that: it dispatches through
 * `api.sendAgentManagerCommand` and derives running/stopped from the owning
 * manager instance's `agent_ids[]`. Nothing is optimistic — a dispatch only
 * shows the 202 ack toast; the running/stopped badge flips when the next
 * heartbeat (≤30s) lands and the parent re-fetches instances on the
 * `agent_instance_update` SSE.
 *
 * `managerInstance` is the OWNING manager's live instance (resolved by the
 * parent from the agent's `manager_agent_id`), NOT the managed agent itself —
 * managed agents never heartbeat on their own. Passing it explicitly (rather
 * than reading the agent's own `live_instance`) is what lets a STOPPED agent
 * still be Started: a stopped agent is absent from every `agent_ids[]`, so its
 * own `live_instance` is empty, but the owning manager is still heartbeating
 * and can receive `spawn_agent`.
 */

/** Heartbeat older than this (but still inside the 90s server TTL) reads as
 *  "stale" — matches the AgentManager admin surfaces so all pages agree on
 *  what "live" looks like. */
const HEARTBEAT_STALE_MS = 60_000;

/** Agent.type 에 들어오지만 실제 CLI 가 아닌 값들 — 이 둘에는 올릴 바이너리가
 *  없으므로 Update CLI 버튼을 아예 감춘다('custom' 은 운영자가 직접 정의한
 *  실행 파일, 'manager' 는 페어링으로 발급된 매니저 identity). */
const NON_UPDATABLE_CLI_TYPES = new Set(['custom', 'manager', '']);

interface AgentLifecycleControlsProps {
  agentId: string;
  /** Agent storage directory — seeds the set-working-dir input. */
  workingDir?: string | null;
  /** 이 에이전트가 쓰는 CLI(claude / codex / …). Update CLI 버튼이 **명시적으로**
   *  이 값을 실어 보내므로 에이전트가 중지돼 있어도(= 매니저 컨텍스트가 없어도)
   *  호스트의 CLI 를 올릴 수 있다. 모르면 버튼을 감춘다 — 잘못된 CLI 를 추측해
   *  올리는 것보다 낫다. */
  cli?: string | null;
  /** Owning manager's live instance, or null/undefined when the manager is
   *  not currently heartbeating (then every command is disabled). */
  managerInstance?: AgentManagerInstance | null;
  /** The agent's server lifecycle_state (ticket bfdd80b7). When 'starting' — a
   *  spawn was dispatched but the agent isn't in the manager's agent_ids[] yet —
   *  the status badge shows "시작 중…" instead of "중지됨". */
  lifecycleState?: AgentLifecycleState;
  /** 'compact' (card): status + Start/Stop/Restart only.
   *  'full' (detail): adds maintenance verbs, reload_config, set working dir. */
  layout?: 'compact' | 'full';
  /** Called after a successful dispatch so the parent can re-fetch instances
   *  (the real state change still arrives via the next heartbeat). */
  onDispatched?: () => void;
}

export default function AgentLifecycleControls({
  agentId,
  workingDir,
  cli,
  managerInstance,
  lifecycleState,
  layout = 'compact',
  onDispatched,
}: AgentLifecycleControlsProps) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [pending, setPending] = useState<AgentManagerCommandKind | null>(null);
  const [wdInput, setWdInput] = useState('');

  const instanceId = managerInstance?.instance_id ?? null;
  const managerOnline = !!instanceId;
  const running = !!managerInstance?.agent_ids?.includes(agentId);
  const stale = useMemo(() => {
    if (!managerInstance) return false;
    const seen = new Date(managerInstance.last_seen_at).getTime();
    if (!Number.isFinite(seen)) return false;
    return Date.now() - seen > HEARTBEAT_STALE_MS;
  }, [managerInstance]);

  const dispatch = useCallback(
    async (
      kind: AgentManagerCommandKind,
      opts?: { extraArgs?: Record<string, any>; managerScoped?: boolean; confirmMessage?: string },
    ) => {
      if (!instanceId) {
        showToast('소유 매니저가 오프라인입니다 — 먼저 매니저를 실행하세요.', 'error');
        return;
      }
      if (pending) return;
      if (opts?.confirmMessage) {
        const ok = await confirm({
          title: '명령 확인',
          message: opts.confirmMessage,
          danger: true,
        });
        if (!ok) return;
      }
      setPending(kind);
      try {
        // Manager-scoped verbs (reload_config) carry NO agent_id — they act on
        // the manager process, not a single managed agent.
        const args = opts?.managerScoped
          ? {}
          : { agent_id: agentId, ...(opts?.extraArgs || {}) };
        const resp = await api.sendAgentManagerCommand(instanceId, { command: kind, args });
        showToast(
          `${kind} 디스패치됨 (id=${resp.command_id.slice(0, 8)}) — 실제 반영은 heartbeat(최대 30s)로 확인`,
          'success',
        );
        onDispatched?.();
      } catch (err: any) {
        showToast(`명령 실패: ${err?.message || err}`, 'error');
      } finally {
        setPending(null);
      }
    },
    [agentId, instanceId, pending, confirm, showToast, onDispatched],
  );

  // ── update_cli ──────────────────────────────────────────────────
  // 다른 verb 와 달리 ack 를 직접 기다린다. 업데이트는 npm 왕복이라 수십 초가
  // 걸리고, "디스패치됨" 토스트만 띄우면 운영자는 올라갔는지 실패했는지 끝내 알
  // 수 없다. ack detail 에 `before → after` 와 **어느 경로를 어떤 방법으로** 올렸는지가
  // 그대로 담겨 온다. 창 안에 ack 가 안 오면 실패가 아니라 "아직" 이다 — 매니저가
  // 끝내면 다음 하트비트가 새 버전을 싣고 온다.
  //
  // 여기서는 경로(args.bin)를 싣지 않는다: 이 화면의 단위는 에이전트이고, 그
  // 에이전트가 쓰는 것은 **지금 해석되는 설치본**이기 때문이다. 같은 CLI 의 다른
  // 설치본을 골라 올리는 것은 Runtime Hosts 화면(InstalledCliVersions)의 일이다.
  const updatableCli = cli && !NON_UPDATABLE_CLI_TYPES.has(cli) ? cli : null;
  const currentCliVersion = (updatableCli && managerInstance?.cli_versions?.[updatableCli]) || null;
  const latestCliVersion = (updatableCli && managerInstance?.cli_latest_versions?.[updatableCli]) || null;
  // 이미 최신이면 버튼을 잠근다 — 올릴 게 없는데도 계속 눌리면, 운영자는 눌러
  // 보는 것 말고는 최신 여부를 알 방법이 없다. 최신을 **모르는** 경우(매니저가
  // 조회에 실패했거나 npm 배포가 아닌 CLI)는 잠그지 않는다.
  const cliUpToDate = cliUpdateState(currentCliVersion, latestCliVersion) === 'up-to-date';
  // 버튼이 곧 상태 표시다: 무엇이 깔려 있고 무엇으로 가는지를 누르기 전에 읽는다.
  const cliVersionSuffix = currentCliVersion
    ? ` (${currentCliVersion}${latestCliVersion && !cliUpToDate ? ` → ${latestCliVersion}` : ''})`
    : '';
  const updateCli = useCallback(async () => {
    if (!instanceId || !updatableCli || pending || cliUpToDate) return;
    const ok = await confirm({
      title: 'CLI 업데이트',
      message:
        `이 에이전트가 쓰는 ${updatableCli} 설치본을 최신 버전으로 올립니다` +
        `${currentCliVersion ? ` (현재 ${currentCliVersion}` : ''}` +
        `${currentCliVersion && latestCliVersion ? ` → ${latestCliVersion}` : ''}` +
        `${currentCliVersion ? ')' : ''}. ` +
        '올리는 방법은 그 설치본의 설치 방식이 정합니다(npm prefix 재설치 / CLI 자체 업데이터 …). ' +
        '같은 설치본을 쓰는 이 장비의 모든 에이전트·세션이 다음 spawn 부터 새 버전을 씁니다. 계속할까요?',
      confirmLabel: '업데이트',
      // 파괴적 동작이 아니다 — 기본값(빨간 Delete 버튼)을 그대로 두면 문구와
      // 버튼이 서로 다른 말을 한다.
      danger: false,
    });
    if (!ok) return;
    setPending('update_cli');
    try {
      const resp = await api.sendAgentManagerCommand(instanceId, {
        command: 'update_cli',
        args: { agent_id: agentId, cli: updatableCli },
      });
      const ack = await waitForCommandAck(resp.command_id, { attempts: 120, intervalMs: 2000 });
      if (ack.state === 'ok') showToast(ack.detail || `${updatableCli} 업데이트 완료`, 'success');
      else if (ack.state === 'timeout')
        showToast(
          `${updatableCli} 업데이트가 아직 진행 중입니다 — 끝나면 하트비트로 새 버전이 올라옵니다.`,
          'info',
        );
      else showToast(`update_cli 실패: ${ack.detail || ack.state}`, 'error');
      onDispatched?.();
    } catch (err: any) {
      showToast(`명령 실패: ${err?.message || err}`, 'error');
    } finally {
      setPending(null);
    }
  }, [
    agentId,
    updatableCli,
    currentCliVersion,
    cliUpToDate,
    instanceId,
    pending,
    confirm,
    showToast,
    onDispatched,
  ]);

  // The dispatched-but-not-yet-running gap (ticket bfdd80b7): a spawn was just
  // dispatched (local `pending`) or the server reports lifecycle_state='starting',
  // but the manager heartbeat hasn't listed the agent in agent_ids[] yet. Bridge
  // it with a "시작 중…" badge instead of flashing "중지됨" until the next beat.
  const starting = pending === 'spawn_agent' || lifecycleState === 'starting';

  // ── Status badge ────────────────────────────────────────────────
  const statusBadge = !managerOnline ? (
    <Badge variant="warning" dot>매니저 오프라인</Badge>
  ) : running ? (
    <Badge variant={stale ? 'warning' : 'success'} dot>{stale ? '실행 중 (heartbeat 지연)' : '실행 중'}</Badge>
  ) : starting ? (
    <Badge variant="warning" dot>시작 중…</Badge>
  ) : (
    <Badge variant="neutral" dot>중지됨</Badge>
  );

  const managerOfflineTitle = '소유 매니저가 heartbeat 중이 아닙니다 — 먼저 매니저를 실행하세요.';

  return (
    // stopPropagation so clicking a button inside a navigate-on-click card
    // (AgentsPage wraps each card in an onClick) doesn't also open the detail.
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {statusBadge}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="primary"
            disabled={!managerOnline || running || pending !== null}
            onClick={() => dispatch('spawn_agent')}
            title={
              !managerOnline
                ? managerOfflineTitle
                : running
                ? '이미 실행 중입니다.'
                : 'spawn_agent — 온디스크 디렉터리 + apiKey 부트스트랩, 런타임 컨텍스트 등록.'
            }
          >
            {pending === 'spawn_agent' ? '시작 중…' : 'Start'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={!managerOnline || !running || pending !== null}
            onClick={() =>
              dispatch('stop_agent', {
                confirmMessage:
                  '이 에이전트를 중지합니다(stop_agent). 런타임 컨텍스트를 내리고 온디스크 시크릿을 지웁니다. 진행 중인 subagent 는 계속 실행됩니다. 계속할까요?',
              })
            }
            title={
              !managerOnline
                ? managerOfflineTitle
                : !running
                ? '실행 중이 아닙니다.'
                : 'stop_agent — 런타임 컨텍스트 제거 + 온디스크 시크릿 삭제. 진행 중 subagent 는 유지.'
            }
          >
            {pending === 'stop_agent' ? '중지 중…' : 'Stop'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!managerOnline || pending !== null}
            onClick={() =>
              dispatch('restart_agent', {
                confirmMessage:
                  '이 에이전트를 재시작합니다(restart_agent = stop + spawn, 새 apiKey 재발급). 진행 중이던 작업은 재시작 후 다시 push 됩니다. 계속할까요?',
              })
            }
            title={
              !managerOnline
                ? managerOfflineTitle
                : 'restart_agent — stop + spawn(새 apiKey 재발급). 진행 중 작업은 자동 re-push.'
            }
          >
            {pending === 'restart_agent' ? '재시작 중…' : 'Restart'}
          </Button>
        </div>
      </div>

      {layout === 'full' && (
        <>
          {/* Maintenance verbs operate only on the agent's isolated cli-home. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textMuted, marginRight: 2 }}>
              유지보수:
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={!managerOnline || !running || pending !== null}
              onClick={() => dispatch('update_plugins')}
              title={
                !managerOnline ? managerOfflineTitle
                  : !running ? '먼저 에이전트를 Start 하세요(매니저가 cli-home 을 소유해야 함).'
                  : 'update_plugins — 에이전트 cli-home 아래 모든 claude 마켓플레이스 git pull --ff-only. 재시작 없이 소스만 갱신.'
              }
            >
              Update plugins
            </Button>
            {/* update_cli — 이 에이전트가 아니라 **장비**의 CLI 를 올린다. 에이전트가
                중지돼 있어도 가능하도록 cli 를 명시적으로 실어 보낸다. */}
            {updatableCli && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!managerOnline || pending !== null || cliUpToDate}
                onClick={updateCli}
                title={
                  !managerOnline ? managerOfflineTitle
                    : cliUpToDate
                    ? `${updatableCli} 는 이미 최신입니다 (npm latest ${latestCliVersion}).`
                    : `update_cli — 이 에이전트가 쓰는 ${updatableCli} 설치본을 최신화` +
                      `${currentCliVersion ? ` (현재 ${currentCliVersion})` : ''}` +
                      `${latestCliVersion ? ` → ${latestCliVersion}` : ' (최신 버전 확인 불가 — 눌러서 시도할 수 있습니다)'}. ` +
                      '방법은 설치 방식이 정합니다. 같은 설치본을 쓰는 이 호스트의 다른 에이전트·세션에도 적용됩니다 — ' +
                      '다른 설치본을 고르려면 Runtime Hosts 화면을 쓰세요.'
                }
              >
                {pending === 'update_cli'
                  ? `${updatableCli} 업데이트 중…`
                  : cliUpToDate
                  ? `${updatableCli} ${currentCliVersion} (최신)`
                  : `Update ${updatableCli}${cliVersionSuffix}`}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={!managerOnline || !running || pending !== null}
              onClick={() => dispatch('refresh_mcp_config')}
              title={
                !managerOnline ? managerOfflineTitle
                  : !running ? '먼저 에이전트를 Start 하세요.'
                  : 'refresh_mcp_config — 현재 AWB url + 기존 apiKey 로 mcp-config.json 재작성. 키 회전 안 함.'
              }
            >
              Refresh MCP
            </Button>
            {/* reload_config is manager-scoped (no agent_id) — re-reads the
                manager's config.json. Kept here for completeness per the
                ticket's "set working dir / reload config" list. */}
            <Button
              size="sm"
              variant="ghost"
              disabled={!managerOnline || pending !== null}
              onClick={() => dispatch('reload_config', { managerScoped: true })}
              title={
                !managerOnline ? managerOfflineTitle
                  : 'reload_config — 소유 매니저 프로세스가 config.json 재로드(매니저 전역, 이 에이전트 한정 아님).'
              }
            >
              Reload config
            </Button>
          </div>

          {/* set_working_dir — dispatch a new cwd for the managed agent. The
              manager updates Agent.working_dir on disk; the agent must be
              restarted to actually spawn in the new cwd. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textMuted, marginRight: 2 }}>
              작업 폴더:
            </span>
            <Input
              type="text"
              placeholder={workingDir || '/manager/host/의/절대경로'}
              value={wdInput}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWdInput(e.target.value)}
              style={{ fontSize: 11, padding: '2px 6px', minWidth: 240 }}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!managerOnline || !wdInput.trim() || pending !== null}
              onClick={() => {
                const dir = wdInput.trim();
                if (!dir) return;
                dispatch('set_working_dir', { extraArgs: { working_dir: dir } });
                setWdInput('');
              }}
              title={
                !managerOnline
                  ? managerOfflineTitle
                  : 'set_working_dir — 매니저가 Agent.working_dir 를 갱신. 새 cwd 로 실제 spawn 하려면 Restart 필요.'
              }
            >
              Set
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
