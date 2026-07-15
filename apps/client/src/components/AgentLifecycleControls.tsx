import React, { useCallback, useMemo, useState } from 'react';
import { api } from '../api';
import type { AgentManagerCommandKind, AgentManagerInstance } from '../types';
import { tokens } from '../tokens';
import { Button, Badge, Input } from './common';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';

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

interface AgentLifecycleControlsProps {
  agentId: string;
  /** Agent storage directory — seeds the set-working-dir input. */
  workingDir?: string | null;
  /** Owning manager's live instance, or null/undefined when the manager is
   *  not currently heartbeating (then every command is disabled). */
  managerInstance?: AgentManagerInstance | null;
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
  managerInstance,
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

  // ── Status badge ────────────────────────────────────────────────
  const statusBadge = !managerOnline ? (
    <Badge variant="warning" dot>매니저 오프라인</Badge>
  ) : running ? (
    <Badge variant={stale ? 'warning' : 'success'} dot>{stale ? '실행 중 (heartbeat 지연)' : '실행 중'}</Badge>
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
