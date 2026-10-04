import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { installedVersionBadge, managerUpdateAction, updateFailureBadge } from './managerUpdateAction';
import type {
  AgentManagerInstance,
  CliInstallEntry,
  PrivilegedCommandRequest,
  PairingTokenMint,
  PairingTokenSafe,
  AcpAdapterReport,
} from '../../types';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { Button, Input, Modal } from '../common';
// Runtime Hosts와 실행 설정은 같은 모델 목록 갱신 경로를 사용한다.
import { refreshHostModels, summarizeHostModels } from '../../cli/hostModels';
import { reloadInstance, waitForCommandAck } from './agentManagerModelRefresh';
import { INSTANCE_OP, finishInstanceOp, pendingAdapterClis, pendingInstallKeys, startInstanceOp, useInstanceOps } from './instanceOps';
import { cliUpdateState, compareCliVersionStrings } from '../../utils/cliVersions';

/**
 * Runtime Host administration and observability.
 *
 * Layout: master/detail split. Left column lists every heartbeating instance
 * grouped by host; right column shows connection health, manager/CLI versions,
 * recent host logs, and a restart button that
 * dispatches `restart_manager` over the agent_manager_command SSE channel
 * (re-execs the Runtime Host in place, no git pull).
 *
 * Real-time refresh: subscribes to `agent_instance_update` SSE events fired
 * by InstanceRegistryService on every upsert / TTL eviction. Steady-state
 * heartbeats (every 30s) keep `last_seen_at` ticking; missing instances drop
 * off automatically when their TTL (90s) expires server-side.
 */

const REFRESH_FALLBACK_MS = 15_000;
const RECENT_ERROR_WINDOW_MS = 10 * 60_000;

function degradedReason(inst: AgentManagerInstance): string | null {
  // 아예 실행조차 못 하는 CLI 가 가장 심각한 degraded 상태 — 먼저 노출한다
  // (ticket e299c6b3). 매니저는 해당 CLI 가 다시 정상 spawn 되면 last_spawn_error
  // 를 null 로 지우므로, 회복된 호스트는 여기서 사라진다.
  if (inst.last_spawn_error) {
    const cli = inst.last_spawn_error_cli ? `${inst.last_spawn_error_cli} ` : '';
    return `${cli}spawn failing: ${inst.last_spawn_error}`;
  }
  const breakerCount = inst.open_breaker_count ?? 0;
  const errorAt = inst.last_error_upload_at ? new Date(inst.last_error_upload_at).getTime() : 0;
  const recentError = Number.isFinite(errorAt) && errorAt > 0 && Date.now() - errorAt <= RECENT_ERROR_WINDOW_MS;
  if (breakerCount > 0 && recentError) return `${breakerCount} open breaker(s); recent error upload`;
  if (breakerCount > 0) return `${breakerCount} open circuit breaker(s)`;
  if (recentError) return `recent error upload (${formatRelative(inst.last_error_upload_at)})`;
  return null;
}

function formatRelative(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    const then = new Date(ts).getTime();
    if (!Number.isFinite(then)) return ts;
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  } catch {
    return ts ?? '—';
  }
}

function formatDuration(startIso: string): string {
  try {
    const ms = Date.now() - new Date(startIso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ${min % 60}m`;
    const days = Math.floor(hr / 24);
    return `${days}d ${hr % 24}h`;
  } catch {
    return '—';
  }
}

interface InstanceRowProps {
  inst: AgentManagerInstance;
  selected: boolean;
  onSelect(): void;
}

function InstanceRow({ inst, selected, onSelect }: InstanceRowProps) {
  const stale = Date.now() - new Date(inst.last_seen_at).getTime() > 60_000;
  const degraded = degradedReason(inst);
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '10px 12px',
        marginBottom: 6,
        background: selected ? tokens.colors.surfaceHover : tokens.colors.surfaceCard,
        border: `1px solid ${selected ? tokens.colors.accent : tokens.colors.border}`,
        borderRadius: tokens.radii.md,
        color: tokens.colors.textStrong,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 4,
              background: `${tokens.colors.accent}20`,
              color: tokens.colors.accent,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              flexShrink: 0,
            }}
          >
            Runtime Host
          </span>
          <span
            style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={inst.agent_name && inst.agent_name !== inst.hostname ? `host: ${inst.hostname}` : inst.hostname}
          >
            {inst.agent_name || inst.hostname}
          </span>
        </div>
        {degraded && (
          <span
            style={{ fontSize: 10, fontWeight: 700, color: tokens.colors.warning, textTransform: 'uppercase' }}
            title={degraded}
          >
            degraded
          </span>
        )}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: stale || degraded ? tokens.colors.warning : tokens.colors.success,
            flexShrink: 0,
          }}
          title={stale ? 'Heartbeat stale' : degraded || 'Heartbeating'}
        />
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: tokens.colors.textMuted }}>
        v{inst.plugin_version} · {inst.cli_adapters.join(', ') || 'CLI 정보 없음'}
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: tokens.colors.textMuted }}>
        last seen {formatRelative(inst.last_seen_at)} · up {formatDuration(inst.started_at)}
      </div>
    </button>
  );
}

/** 회귀 테스트가 Details 진입 경로를 실제로 마운트해 검증할 수 있도록 노출한다
 *  (ticket 20fff298). 페이지 전체를 띄우지 않고 이 컴포넌트만 렌더하면 되므로,
 *  버튼 렌더 조건을 소스 정규식이 아니라 실제 DOM 으로 단언할 수 있다. */
export function InstanceDetail({ inst }: { inst: AgentManagerInstance }) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const degraded = degradedReason(inst);
  const [logs, setLogs] = useState<any[] | null>(null);
  // 진행 중 플래그는 **호스트별 스토어**에서 읽는다(instanceOps.ts). 이 컴포넌트는 선택된
  // 호스트 하나만 그리고 호스트를 바꿔도 재사용되므로, useState 로 두면 A 의 진행 중이 B 화면을
  // 잠갔다 — A 의 CLI 를 올리는 동안 B 의 CLI 를 못 올린 원인이다.
  const activeOps = useInstanceOps(inst.instance_id);
  const restartPending = activeOps.has(INSTANCE_OP.restart);
  const updatePending = activeOps.has(INSTANCE_OP.updateManager);
  const refreshModelsPending = activeOps.has(INSTANCE_OP.refreshModels);
  // 진행 중인 **설치본 키** 집합 — 같은 호스트의 다른 설치본은 동시에 올릴 수 있다. 진짜
  // 레이스(같은 npm prefix 공유)는 매니저의 withCliUpdateLock 이 막는다.
  const updateCliPending = pendingInstallKeys(activeOps);
  const adapterPending = pendingAdapterClis(activeOps);
  const updateAllCliPending = activeOps.has(INSTANCE_OP.updateAllClis);
  // 권한 상승이 필요한 설치본의 Update 를 눌렀을 때 뜨는 비밀번호 모달의 대상.
  // 비밀번호 자체는 이 컴포넌트가 아니라 모달 안에서만 살고, 제출되는 즉시
  // 티켓으로 바뀌어 사라진다 — 여기에 담아 두지 않는다.
  const [sudoPrompt, setSudoPrompt] = useState<{ cli: string; bin: string; method: string } | null>(null);
  // 이 패널은 호스트를 바꿔도 재사용된다 — 호스트 A 에서 연 sudo 대상(A 의 설치본 경로)이
  // 남아 있으면 B 의 instance id 로 제출되어 "그런 설치본 없음" 으로 거절된다. 바뀌면 비운다.
  useEffect(() => {
    setSudoPrompt(null);
  }, [inst.instance_id]);
  const loadLogs = useCallback(async () => {
    try {
      const data = await api.getAgentManagerInstanceLogs(inst.instance_id, 100);
      setLogs(data);
    } catch (err: any) {
      showToast(`Failed to load logs: ${err?.message || err}`, 'error');
      setLogs([]);
    }
  }, [inst.instance_id, showToast]);

  useEffect(() => {
    setLogs(null);
    loadLogs();
  }, [inst.instance_id, loadLogs]);

  // Dispatch restart_manager SSE command via the /restart admin endpoint.
  // Server returns 202 with command_id + a short message; the manager later
  // re-execs and reappears as an `agent_instance_update` event with the
  // same manager version (the wire field is plugin_version; no polling needed here).
  const handleRestart = async () => {
    const id = inst.instance_id;
    if (restartPending) return;
    const ok = await confirm({
      title: 'Restart manager',
      message: 'Restart this manager? Every in-flight subagent, chat session, and ticket session on this host will be terminated. The manager will re-exec in place and reappear in ~30s.',
      confirmLabel: 'Restart',
    });
    if (!ok) return;
    if (!startInstanceOp(id, INSTANCE_OP.restart)) return;
    try {
      const resp: any = await api.restartAgentManagerInstance(id);
      const idTail = typeof resp?.command_id === 'string' ? ` (id=${resp.command_id.slice(0, 8)})` : '';
      showToast(
        `${resp?.message || 'restart_manager dispatched'}${idTail} — manager will reappear in ~30s.`,
        'success',
      );
    } catch (err: any) {
      showToast(`Restart failed: ${err?.message || err}`, 'error');
    } finally {
      finishInstanceOp(id, INSTANCE_OP.restart);
    }
  };

  const handleUpdate = async () => {
    const id = inst.instance_id;
    if (updatePending) return;
    const action = managerUpdateAction(inst);
    const ok = await confirm({
      title: action.kind === 'restart' ? 'Restart manager' : 'Update manager',
      message:
        action.kind === 'restart' || action.kind === 'update'
          ? action.confirm
          : 'Update this manager? It will reinstall from npm and restart.',
      confirmLabel: action.kind === 'restart' ? 'Restart' : 'Update',
      danger: false,
    });
    if (!ok) return;
    if (!startInstanceOp(id, INSTANCE_OP.updateManager)) return;
    try {
      const resp = await api.sendAgentManagerCommand(id, { command: 'update_manager' });
      showToast(
        action.kind === 'restart'
          ? `update_manager dispatched (id=${resp.command_id.slice(0, 8)}) — the installed build is already on disk; the manager restarts into it and reappears in ~30s.`
          : `update_manager dispatched (id=${resp.command_id.slice(0, 8)}) — manager will rebuild + re-exec; ` +
            `it'll reappear in ~30s with the new version.`,
        'success',
      );
    } catch (err: any) {
      showToast(`update_manager failed: ${err?.message || err}`, 'error');
    } finally {
      finishInstanceOp(id, INSTANCE_OP.updateManager);
    }
  };

  // ticket 40110b64 — 호스트에서 claude / codex CLI 를 업그레이드한 뒤, 매니저를
  // 재시작하지 않고 모델 목록만 다시 열거한다. 매니저 프로세스와 실행 중인 세션은
  // 그대로 유지된다(재열거는 어댑터 introspection 일 뿐이다).
  //
  // 완료 판정은 **발급된 command_id 의 ack** 로만 한다. 202 는 디스패치 수락일
  // 뿐이고, 하트비트는 30초마다 알아서 돌기 때문에 "하트비트가 왔다" 를 완료로
  // 쓰면 커맨드와 무관한 정기 하트비트가 조건을 충족시켜 재열거 전 값을 성공으로
  // 오표시한다(리뷰 지적). 성공 ack 이후에만 인스턴스 목록을 다시 읽는다.
  const handleRefreshModels = async () => {
    const id = inst.instance_id;
    if (!startInstanceOp(id, INSTANCE_OP.refreshModels)) return;
    try {
      // 모든 모델 화면과 같은 경로 — 서버가 재열거 커맨드의 ack 를 기다린 뒤 새 목록을 준다.
      const fresh = await refreshHostModels(inst.agent_id);
      if (!fresh) throw new Error('갱신 결과를 받지 못했습니다');
      const summary = summarizeHostModels(fresh);
      showToast(`모델 목록 갱신 완료${summary ? ` — ${summary}` : ''}`, 'success');
    } catch (err: any) {
      showToast(`refresh_available_models failed: ${err?.message || err}`, 'error');
    } finally {
      finishInstanceOp(id, INSTANCE_OP.refreshModels);
    }
  };

  // 호스트에 설치된 CLI **한 설치본**을 올린다. 올리는 방법은 매니저가 그 설치본의
  // 레이아웃에서 정한다(`npm --prefix …` / 자체 업데이터 / …). refresh_available_models
  // 와 같은 이유로 **ack 를 직접 기다린다**: 업데이터는 npm 왕복이라 수십 초가
  // 걸리고, 디스패치 토스트만으로는 올라갔는지 알 수 없다. 매니저 프로세스는
  // 재시작되지 않지만, 이후 spawn 되는 CLI 는 새 버전이다.
  //
  // `bin` 은 같은 CLI 가 여러 벌 깔린 호스트에서 어느 설치본인지 못 박는다 —
  // 생략하면 매니저가 지금 해석되는 설치본을 고른다.
  const handleUpdateCli = async (cli: string, bin?: string, sudoTicket?: string) => {
    // 호출 시점의 호스트를 붙잡는다 — 끝날 때 사용자는 이미 다른 호스트를 보고 있을 수 있다.
    const id = inst.instance_id;
    const host = inst.hostname;
    const op = INSTANCE_OP.updateCli(bin || cli);
    // 같은 호스트의 같은 설치본 중복 클릭만 막는다. 다른 설치본·다른 호스트는 동시에 된다.
    if (!startInstanceOp(id, op)) return;
    try {
      const resp = await api.sendAgentManagerCommand(id, {
        command: 'update_cli',
        // sudo_ticket 은 **티켓 id 일 뿐 비밀번호가 아니다**. 매니저가 권한 상승이
        // 실제로 필요한 순간에 이 id 로 서버에서 1회 당겨 간다.
        args: { cli, ...(bin ? { bin } : {}), ...(sudoTicket ? { sudo_ticket: sudoTicket } : {}) },
      });
      const idTail = ` (id=${resp.command_id.slice(0, 8)})`;
      // CLI 업데이터는 모델 재열거보다 훨씬 오래 걸리므로 창을 넓게 잡는다(~4분).
      const ack = await waitForCommandAck(resp.command_id, { attempts: 120, intervalMs: 2000 });
      if (ack.state === 'error') {
        showToast(`[${host}] ${cli} 업데이트 실패${idTail} — ${ack.detail || '사유 미상'}`, 'error');
        return;
      }
      if (ack.state !== 'ok') {
        showToast(
          `[${host}] update_cli 전송됨${idTail} — 아직 진행 중입니다. 끝나면 다음 하트비트에 새 버전이 실립니다.`,
          'info',
        );
        return;
      }
      await reloadInstance(id);
      showToast(`[${host}] ${ack.detail || `${cli} 업데이트 완료${idTail}`}`, 'success');
    } catch (err: any) {
      showToast(`[${host}] update_cli failed: ${err?.message || err}`, 'error');
    } finally {
      finishInstanceOp(id, op);
    }
  };

  // ACP 어댑터 하나를 올린다. 매니저 홈에 최신을 설치하고, 매니저는 홈 설치본과 번들본 중 더 새
  // 것을 쓴다 — 번들본은 매니저 의존성 범위에 묶여 새 어댑터를 따라오지 못하기 때문이다. 매니저는
  // 재시작되지 않는다. 이미 열린 세션은 옛 어댑터 프로세스를 그대로 쓰므로 Restart 해야 적용된다.
  const handleUpdateAdapter = async (cli: string) => {
    const id = inst.instance_id;
    const host = inst.hostname;
    const op = INSTANCE_OP.updateAdapter(cli);
    if (!startInstanceOp(id, op)) return;
    try {
      const resp = await api.sendAgentManagerCommand(id, { command: 'update_acp_adapter', args: { cli } });
      const idTail = ` (id=${resp.command_id.slice(0, 8)})`;
      const ack = await waitForCommandAck(resp.command_id, { attempts: 150, intervalMs: 2000 });
      if (ack.state === 'error') {
        showToast(`[${host}] ${cli} 어댑터 업데이트 실패${idTail} — ${ack.detail || '사유 미상'}`, 'error');
        return;
      }
      if (ack.state !== 'ok') {
        showToast(`[${host}] update_acp_adapter 전송됨${idTail} — 아직 진행 중입니다. 끝나면 다음 하트비트에 새 버전이 실립니다.`, 'info');
        return;
      }
      await reloadInstance(id);
      showToast(`[${host}] ${ack.detail || `${cli} 어댑터 업데이트 완료${idTail}`}`, 'success');
    } catch (err: any) {
      showToast(`[${host}] update_acp_adapter failed: ${err?.message || err}`, 'error');
    } finally {
      finishInstanceOp(id, op);
    }
  };

  // 올릴 수 있는 설치본을 한 번에 전부. 매니저가 자기 설치 열거로 대상을 정하고
  // 설치본 단위로 실패를 격리한 뒤 요약 한 줄로 ack 한다 — 하나라도 실패하면
  // error ack 이므로 "다 됐다" 로 뭉개지지 않는다.
  const handleUpdateAllClis = async () => {
    const id = inst.instance_id;
    const host = inst.hostname;
    if (updateAllCliPending) return;
    const ok = await confirm({
      title: '모든 CLI 업데이트',
      message:
        `${inst.hostname} 에서 올릴 수 있는 CLI 설치본과 뒤처진 ACP 어댑터를 전부 최신으로 올립니다. ` +
        '같은 설치 디렉터리를 공유하는 설치본끼리만 차례로 돌고, 나머지는 동시에 올라갑니다. ' +
        'sudo 가 필요한 설치본은 건너뛰고 결과에 그렇다고 적습니다. ' +
        '이 장비의 모든 에이전트·세션이 다음 spawn 부터 새 버전을 씁니다. 계속할까요?',
      confirmLabel: '전부 업데이트',
      danger: false,
    });
    if (!ok) return;
    if (!startInstanceOp(id, INSTANCE_OP.updateAllClis)) return;
    try {
      const resp = await api.sendAgentManagerCommand(id, {
        command: 'update_all_clis',
        args: {},
      });
      const idTail = ` (id=${resp.command_id.slice(0, 8)})`;
      // 여러 벌을 올리므로 한 벌짜리(~4분)보다 창을 넓게 잡는다.
      const ack = await waitForCommandAck(resp.command_id, { attempts: 240, intervalMs: 2000 });
      if (ack.state === 'error') {
        showToast(`[${host}] CLI 전체 업데이트 실패${idTail} — ${ack.detail || '사유 미상'}`, 'error');
        return;
      }
      if (ack.state !== 'ok') {
        showToast(
          `[${host}] update_all_clis 전송됨${idTail} — 아직 진행 중입니다. 끝나면 다음 하트비트에 새 버전이 실립니다.`,
          'info',
        );
        return;
      }
      await reloadInstance(id);
      showToast(`[${host}] ${ack.detail || `CLI 전체 업데이트 완료${idTail}`}`, 'success');
    } catch (err: any) {
      showToast(`[${host}] update_all_clis failed: ${err?.message || err}`, 'error');
    } finally {
      finishInstanceOp(id, INSTANCE_OP.updateAllClis);
    }
  };

  const sudoModal = sudoPrompt ? (
    <SudoPasswordModal
      instanceId={inst.instance_id}
      hostname={inst.hostname}
      target={sudoPrompt}
      onClose={() => setSudoPrompt(null)}
      onTicket={(ticketId) => {
        const { cli, bin } = sudoPrompt;
        setSudoPrompt(null);
        void handleUpdateCli(cli, bin, ticketId);
      }}
    />
  ) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: '100%' }}>
      {sudoModal}
      {/* Header */}
      <div
        style={{
          padding: 16,
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: '3px 8px',
              borderRadius: 4,
              background: `${tokens.colors.accent}20`,
              color: tokens.colors.accent,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Runtime Host
          </span>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: tokens.colors.textPrimary }}>
            {inst.agent_name || inst.hostname}
          </h2>
          {inst.agent_name && inst.agent_name !== inst.hostname && (
            <span
              style={{ fontSize: 12, color: tokens.colors.textMuted }}
              title="매니저가 실행되는 장비의 호스트 이름"
            >
              host: {inst.hostname}
            </span>
          )}
          <span style={{ fontSize: 12, color: tokens.colors.textMuted, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
            {inst.instance_id}
          </span>
          {degraded && (
            <span
              style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4, color: tokens.colors.warning, background: tokens.colors.warningBg }}
              title={degraded}
            >
              DEGRADED · {degraded}
            </span>
          )}
        </div>
        <dl
          style={{
            margin: '12px 0 0 0',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
            gap: '8px 16px',
            fontSize: 12,
            color: tokens.colors.textSecondary,
          }}
        >
          <div>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Host ID
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
              {inst.host_id || inst.agent_id}
            </dd>
          </div>
          <div>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              PID / CLI
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
              {inst.pid || '—'} / {inst.cli}
            </dd>
          </div>
          <div>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Started
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
              {formatRelative(inst.started_at)} (up {formatDuration(inst.started_at)})
            </dd>
          </div>
          <div>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Last heartbeat
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
              {formatRelative(inst.last_seen_at)}
            </dd>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Registered CLI adapters
            </dt>
            <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
              {inst.cli_adapters.length === 0 ? '—' : inst.cli_adapters.join(', ')}
            </dd>
          </div>
          {inst.mode === 'manager' && (
            <>
              {inst.paired_at && (
                <div>
                  <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Paired
                  </dt>
                  <dd style={{ margin: 0, color: tokens.colors.textStrong }}>
                    {formatRelative(inst.paired_at)}
                  </dd>
                </div>
              )}
              {/* ticket d34075b5 — durable, server-visible dispatch-block signal.
                  Cumulative per-reason count of dispatches dropped at the manager's
                  worktree / push-credential preflight gate (a shared-pool
                  `pool_exhausted` starvation was previously invisible until
                  e7c87517's 24h no-progress backstop). Shown only when non-empty;
                  pool exhaustion is highlighted since it self-recovers via the
                  manager's on-demand reclaim but signals a leaking / undersized pool. */}
              {inst.dispatch_block_counts && Object.keys(inst.dispatch_block_counts).length > 0 && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Dispatch blocks (cumulative since boot)
                  </dt>
                  <dd style={{ margin: '4px 0 0', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(inst.dispatch_block_counts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([kind, n]) => {
                        const isPool = kind === 'worktree:pool_exhausted';
                        return (
                          <span
                            key={kind}
                            title={
                              isPool
                                ? 'Shared warm-pool exhausted — every slot was an active lease (usually a leaked lease from a worker that died uncleanly). The manager reclaims on-demand + on a 5-min tick; a persistent count signals a leaking or undersized pool.'
                                : 'Dispatch dropped at the worktree / push-credential preflight gate.'
                            }
                            style={{
                              fontSize: 11,
                              fontFamily: 'monospace',
                              padding: '2px 8px',
                              borderRadius: 4,
                              color: isPool ? tokens.colors.warning : tokens.colors.textStrong,
                              background: isPool ? tokens.colors.warningBg : tokens.colors.surfaceSubtle,
                            }}
                          >
                            {kind} ×{n}
                          </span>
                        );
                      })}
                  </dd>
                </div>
              )}
            </>
          )}
        </dl>

        {/* Agent Manager 자신의 버전과 업데이트.

            예전에는 Update 버튼이 `update_available` 일 때만 액션 줄 한복판에
            나타났다. 그래서 최신인 호스트에서는 "여기서 매니저를 올릴 수 있다" 는
            사실 자체가 화면에서 사라졌고, 운영자는 어디서 올리는지 찾을 수 없었다.
            버전과 상태는 늘 보이고, 올릴 수 있을 때만 버튼이 활성화된다. */}
        {inst.mode === 'manager' && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${tokens.colors.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: tokens.colors.textMuted, marginBottom: 8 }}>
              Agent Manager
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textStrong, fontFamily: 'monospace' }}>
                v{inst.plugin_version}
              </span>
              <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                {inst.install_mode || 'install mode unknown'}
              </span>
              {installedVersionBadge(inst) && (
                <span
                  data-testid="manager-restart-required"
                  style={{ fontSize: 11, color: tokens.colors.warning, fontFamily: 'monospace' }}
                  title="The package on disk was replaced (e.g. npm i -g from a shell or session) while this process kept running the older build. Restart to load it."
                >
                  ({installedVersionBadge(inst)})
                </span>
              )}
              <ManagerVersionBadge inst={inst} />
              <UpdateFailureBadge inst={inst} />
              <div style={{ flex: 1 }} />
              {managerUpdateAction(inst).kind === 'restart' || managerUpdateAction(inst).kind === 'update' ? (
                <button
                  onClick={handleUpdate}
                  disabled={updatePending}
                  style={{
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: 600,
                    background: updatePending ? tokens.colors.surfaceHover : tokens.colors.success,
                    color: updatePending ? tokens.colors.textMuted : tokens.colors.surface,
                    border: 'none',
                    borderRadius: tokens.radii.md,
                    cursor: updatePending ? 'wait' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                  title={managerUpdateAction(inst).title}
                >
                  {updatePending ? (managerUpdateAction(inst).kind === 'restart' ? 'Restarting…' : 'Updating…') : managerUpdateAction(inst).label}
                </button>
              ) : (
                // 버튼을 숨기지 않고 비활성으로 남긴다 — "여기가 매니저를 올리는
                // 자리" 라는 사실은 최신일 때도 보여야 한다.
                <button
                  disabled
                  style={{
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: 600,
                    background: 'transparent',
                    color: tokens.colors.textMuted,
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md,
                    cursor: 'default',
                    fontFamily: 'inherit',
                  }}
                  title={managerUpdateAction(inst).title}
                >
                  {managerUpdateAction(inst).label}
                </button>
              )}
            </div>
          </div>
        )}

        {/* CLI 설치본 — 예전에는 사실 나열(<dl>) 한복판에 끼어 있어서, 정작
            "이 장비의 claude 가 몇 버전이고 어디서 올리나" 를 찾을 수가 없었다.
            버전과 Update 버튼은 이 화면에 온 이유 그 자체라 제목을 단 자기 자리에
            둔다. */}
        {inst.mode === 'manager' && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${tokens.colors.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: tokens.colors.textMuted, marginBottom: 8 }}>
              CLI 설치본
            </div>
            <InstalledCliVersions
              inst={inst}
              hideLabel
              pending={updateCliPending}
              onUpdateAll={handleUpdateAllClis}
              updateAllPending={updateAllCliPending}
              onUpdateAdapter={(cli) => void handleUpdateAdapter(cli)}
              adapterPending={adapterPending}
              onUpdate={(cli, bin, needsSudo, method) => {
                // 권한 상승이 필요한 설치본에서만 비밀번호를 묻는다. 필요 없는
                // 설치본에 대고 묻는 것은 운영자의 root 비밀번호를 괜히 네트워크에
                // 태우는 일이다.
                if (needsSudo && bin) setSudoPrompt({ cli, bin, method: method || '' });
                else void handleUpdateCli(cli, bin);
              }}
            />
          </div>
        )}

        {/* 호스트 단위 동작. `flexWrap` 이 필요한 이유: manager 인스턴스에서는 이 줄이
            최대 7개까지 늘어나는데, 감싸지 않으면 창이 좁을 때 버튼들이 눌려 라벨이
            잘리고 마지막 것이 컨테이너 밖으로 밀려 나간다. */}
        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {inst.mode === 'manager' && (
            <button
              onClick={handleRefreshModels}
              disabled={refreshModelsPending}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                background: 'transparent',
                color: tokens.colors.textStrong,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                cursor: refreshModelsPending ? 'wait' : 'pointer',
                fontFamily: 'inherit',
                opacity: refreshModelsPending ? 0.6 : 1,
              }}
              title={
                '이 호스트에 설치된 CLI 들의 모델 목록을 다시 열거합니다. ' +
                '매니저는 재시작되지 않고 실행 중인 세션도 끊기지 않습니다. ' +
                'CLI 를 업그레이드한 뒤 Agent 템플릿과 실행 설정의 모델 목록을 갱신할 때 쓰세요.'
              }
            >
              {refreshModelsPending ? '모델 갱신 중…' : 'Refresh models'}
            </button>
          )}
          <button
            onClick={handleRestart}
            disabled={restartPending}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              background: restartPending ? tokens.colors.surfaceHover : tokens.colors.warning,
              color: restartPending ? tokens.colors.textMuted : tokens.colors.surface,
              border: 'none',
              borderRadius: tokens.radii.md,
              cursor: restartPending ? 'wait' : 'pointer',
              fontFamily: 'inherit',
            }}
            title="이 Host의 매니저를 재시작합니다. 실행 중인 세션과 작업이 종료됩니다."
          >
            매니저 재시작
          </button>
          <button
            onClick={() => { loadLogs(); }}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              background: 'transparent',
              color: tokens.colors.textStrong,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Logs */}
      <section
        style={{
          flex: 1,
          minHeight: 0,
          padding: 16,
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <h3 style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
          Recent logs ({logs?.length ?? 0})
        </h3>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {logs === null ? (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>
          ) : logs.length === 0 ? (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
              No matching log entries in the in-memory buffer.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {logs.map((entry, idx) => (
                <li
                  key={entry.id ?? idx}
                  style={{
                    padding: '6px 8px',
                    background: tokens.colors.surface,
                    borderRadius: tokens.radii.xs,
                    fontFamily: 'monospace',
                    fontSize: 11,
                    color: tokens.colors.textStrong,
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
                    gap: 8,
                  }}
                >
                  <span style={{ color: tokens.colors.textMuted }}>{entry.timestamp}</span>
                  <span style={{ color: entry.level === 'error' ? tokens.colors.danger : entry.level === 'warn' ? tokens.colors.warning : tokens.colors.info, fontWeight: 600 }}>
                    {entry.level}
                  </span>
                  <span style={{ color: tokens.colors.accentLight }}>{entry.category}</span>
                  <span style={{ gridColumn: '1 / -1', overflowWrap: 'anywhere' }}>{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

export default function AgentManagerPage() {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [instances, setInstances] = useState<AgentManagerInstance[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listAgentManagerInstances();
      setInstances(data);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || 'Runtime Host 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_FALLBACK_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Live updates over SSE — server emits agent_instance_update on every
  // heartbeat upsert and TTL eviction. We treat each event as a hint to
  // refetch (cheap: in-memory map) so the list reflects the registry truth
  // even if a single SSE event is dropped on the wire.
  useBoardStreamEvent('agent_instance_update', () => {
    refresh();
  });

  const grouped = useMemo(() => {
    const byHost = new Map<string, AgentManagerInstance[]>();
    for (const inst of instances) {
      const list = byHost.get(inst.hostname) || [];
      list.push(inst);
      byHost.set(inst.hostname, list);
    }
    return Array.from(byHost.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [instances]);

  // Auto-select the first instance once data arrives so the right pane has
  // something to render. Drops the selection if the instance disappears.
  useEffect(() => {
    if (instances.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!isMobile && (!selectedId || !instances.some((i) => i.instance_id === selectedId))) {
      setSelectedId(instances[0].instance_id);
    }
  }, [instances, isMobile, selectedId]);

  const selected = instances.find((i) => i.instance_id === selectedId) || null;
  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* Master pane */}
      <div
        style={{
          width: isMobile ? '100%' : 320,
          flexShrink: 0,
          display: isMobile && selected ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          style={{
            marginBottom: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 11, color: tokens.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {loading ? 'Loading…' : `연결된 인스턴스 ${instances.length}`}
          </span>
          <Button size="sm" variant="primary" onClick={() => setPairOpen(true)}>
            Host 연결
          </Button>
        </div>
        {loadError && (
          <div role="alert" style={{ marginBottom: 12, fontSize: 12, color: tokens.colors.dangerLight }}>
            {loadError}
            <Button size="sm" variant="secondary" onClick={refresh} style={{ marginTop: 8 }}>다시 시도</Button>
          </div>
        )}
        <div
          data-testid="runtime-hosts-list"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
        >
          {grouped.length === 0 && !loading && !loadError && (
            <div
              style={{
                padding: 16,
                fontSize: 12,
                color: tokens.colors.textMuted,
                background: tokens.colors.surfaceCard,
                border: `1px dashed ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                textAlign: 'center',
              }}
            >
              현재 연결된 Runtime Host가 없습니다.
              ‘Host 연결’에서 코드를 발급받아 실행할 장비의 <code>awb-agent-manager</code>와 연결하세요.
            </div>
          )}
          {grouped.map(([host, list]) => (
            <div key={host} style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: tokens.colors.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 6,
                  padding: '0 4px',
                }}
              >
                {host}
              </div>
              {list.map((inst) => (
                <InstanceRow
                  key={inst.instance_id}
                  inst={inst}
                  selected={inst.instance_id === selectedId}
                  onSelect={() => setSelectedId(inst.instance_id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Detail pane */}
      <div
        style={{
          display: isMobile && !selected ? 'none' : 'flex',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {isMobile && selected && (
          <Button size="sm" variant="secondary" onClick={() => setSelectedId(null)} style={{ alignSelf: 'flex-start' }}>
            ← Host 목록
          </Button>
        )}
        <div
          data-testid="mainframe-detail-scroll"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
        >
          {/* 루트 권한 요청은 사람이 기다리는 상태라 어느 호스트를 보고 있든
              먼저 눈에 들어와야 한다. 대기 중인 것이 없으면 아무것도 그리지 않는다. */}
          <div style={{ marginBottom: 8 }}>
            <PrivilegedCommandApprovals />
          </div>
          {selected ? (
            <InstanceDetail
              inst={selected}
            />
          ) : (
            <div
              style={{
                padding: 24,
                fontSize: 12,
                color: tokens.colors.textMuted,
                background: tokens.colors.surfaceCard,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
              }}
            >
              Host를 선택하면 연결 상태, 매니저·CLI 버전과 로그를 확인할 수 있습니다.
            </div>
          )}
        </div>
      </div>

      <PairingDialog isOpen={pairOpen} onClose={() => setPairOpen(false)} />
    </div>
  );
}

// ─── Pairing wizard ────────────────────────────────────────────────────

interface PairingDialogProps {
  isOpen: boolean;
  onClose(): void;
}

function PairingDialog({ isOpen, onClose }: PairingDialogProps) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [pairings, setPairings] = useState<PairingTokenSafe[] | null>(null);
  const [hostName, setHostName] = useState('');
  const [minted, setMinted] = useState<PairingTokenMint | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listAgentManagerPairings();
      setPairings(data);
    } catch (err: any) {
      showToast(`Failed to load pairings: ${err?.message || err}`, 'error');
      setPairings([]);
    }
  }, [showToast]);

  useEffect(() => {
    if (!isOpen) return;
    setMinted(null);
    refresh();
  }, [isOpen, refresh]);

  const handleMint = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const rec = await api.mintAgentManagerPairing({ agent_name: hostName.trim() || undefined });
      setMinted(rec);
      setHostName('');
      refresh();
    } catch (err: any) {
      showToast(`Mint failed: ${err?.message || err}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (id: string) => {
    const ok = await confirm({
      title: 'Revoke pairing token',
      message: 'Revoke this pairing token? Any in-flight bootstrap using it will fail.',
      confirmLabel: 'Revoke',
    });
    if (!ok) return;
    try {
      await api.revokeAgentManagerPairing(id);
      refresh();
    } catch (err: any) {
      showToast(`Revoke failed: ${err?.message || err}`, 'error');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Runtime Host 연결" maxWidth={640}>
      <p style={{ margin: '0 0 12px 0', fontSize: 12, color: tokens.colors.textSecondary }}>
        Mint a one-time token, hand it to <code>awb-agent-manager pair --code &lt;CODE&gt;</code> on the host that
        will run the manager process. Tokens expire in 10 minutes; they cannot be retrieved after the modal closes.
      </p>

      {minted && <MintedTokenPanel rec={minted} onDismiss={() => setMinted(null)} />}

      {!minted && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
              Host 이름 (선택 사항)
            </label>
            <Input
              type="text"
              value={hostName}
              placeholder="e.g. desktop-mac-mini"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHostName(e.target.value)}
            />
          </div>
          <Button onClick={handleMint} disabled={busy} variant="primary">
            Mint token
          </Button>
        </div>
      )}

      <h3 style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Active tokens ({pairings?.length ?? 0})
      </h3>
      {pairings === null ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>
      ) : pairings.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>No pairing tokens outstanding.</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {pairings.map((t) => (
            <li
              key={t.id}
              style={{
                padding: 10,
                background: tokens.colors.surface,
                borderRadius: tokens.radii.sm,
                fontSize: 12,
                color: tokens.colors.textStrong,
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
              }}
            >
              <div>
                <code
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                    color: tokens.colors.accent,
                  }}
                >
                  {t.code}
                </code>
                {t.agent_name && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.textMuted }}>· {t.agent_name}</span>
                )}
                <div style={{ marginTop: 2, fontSize: 11, color: tokens.colors.textMuted }}>
                  expires {formatRelative(t.expires_at)}
                  {t.redeemed_at && ` · redeemed ${formatRelative(t.redeemed_at)}`}
                </div>
              </div>
              {!t.redeemed_at && (
                <Button size="sm" variant="danger" onClick={() => handleRevoke(t.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

interface MintedTokenPanelProps {
  rec: PairingTokenMint;
  onDismiss(): void;
}

function MintedTokenPanel({ rec, onDismiss }: MintedTokenPanelProps) {
  const { showToast } = useToast();

  const copy = (value: string, label: string) => {
    if (!navigator.clipboard) {
      showToast(`Copy not supported in this browser — value: ${value}`, 'info');
      return;
    }
    navigator.clipboard
      .writeText(value)
      .then(() => showToast(`${label} copied`, 'success'))
      .catch(() => showToast('Copy failed', 'error'));
  };

  return (
    <div
      style={{
        padding: 12,
        marginBottom: 16,
        background: tokens.colors.surfaceHover,
        border: `1px solid ${tokens.colors.accent}`,
        borderRadius: tokens.radii.md,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.warning }}>
        ⚠ Show ONCE. The raw token is not retrievable later.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>Display code</span>
        <code
          style={{
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: '0.15em',
            color: tokens.colors.accent,
            background: tokens.colors.surface,
            padding: '4px 10px',
            borderRadius: tokens.radii.sm,
          }}
        >
          {rec.code}
        </code>
        <Button size="sm" variant="secondary" onClick={() => copy(rec.code, 'Code')}>
          Copy code
        </Button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>Raw token</span>
        <code
          style={{
            fontSize: 11,
            fontFamily: 'monospace',
            color: tokens.colors.textStrong,
            background: tokens.colors.surface,
            padding: '4px 8px',
            borderRadius: tokens.radii.sm,
            wordBreak: 'break-all',
            flex: 1,
            minWidth: 200,
          }}
        >
          {rec.token}
        </code>
        <Button size="sm" variant="secondary" onClick={() => copy(rec.token, 'Token')}>
          Copy token
        </Button>
      </div>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>
        Expires {formatRelative(rec.expires_at)}.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss (acknowledge that I copied it)
        </Button>
      </div>
    </div>
  );
}

// ─── PrivilegedCommandApprovals — agent 가 요청한 root 명령의 승인 대기열 ───────
//
// agent 는 요청만 할 수 있고, 실행은 운영자가 **명령을 읽고** 승인하면서 비밀번호를
// 칠 때만 일어난다. agent 에게 상시 sudo 를 주면 그 agent 가 곧 root 이고, 프롬프트
// 인젝션 한 번이 루트 권한 탈취가 된다.
//
// 화면이 보여주는 argv 가 곧 실행되는 argv 다 — 매니저는 서버가 보관한 정본을 다시
// 받아 가서 돌린다. 그래서 여기서 읽은 것과 도는 것이 갈라질 수 없다.
//
// 기본값은 거부다: 아무도 결정하지 않으면 창이 지나며 만료된다. 그래서 이 패널은
// "대기 중일 때만" 나타나고, 평소에는 아무것도 그리지 않는다.
function PrivilegedCommandApprovals() {
  const { showToast } = useToast();
  const [requests, setRequests] = useState<PrivilegedCommandRequest[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRequests(await api.listPrivilegedCommands());
    } catch {
      // 목록 조회 실패가 화면을 망가뜨리면 안 된다 — 다음 폴링이 복구한다.
    }
  }, []);

  useEffect(() => {
    refresh();
    // 승인 대기는 사람이 기다리는 상태다. 하트비트(30초)보다 촘촘히 본다.
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (requests.length === 0) return null;

  const deciding = requests.find((r) => r.request_id === decidingId) ?? null;

  const approve = async () => {
    if (!deciding || !password || busy) return;
    setBusy(true);
    try {
      await api.approvePrivilegedCommand(deciding.request_id, password);
      setPassword('');
      setDecidingId(null);
      showToast(`승인됨 — ${deciding.hostname} 에서 실행 중입니다.`, 'success');
      await refresh();
    } catch (err: any) {
      setPassword('');
      showToast(`승인 실패: ${err?.message || err}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const deny = async (req: PrivilegedCommandRequest) => {
    try {
      await api.denyPrivilegedCommand(req.request_id);
      showToast('거부했습니다.', 'info');
      await refresh();
    } catch (err: any) {
      showToast(`거부 실패: ${err?.message || err}`, 'error');
    }
  };

  return (
    <div
      style={{
        padding: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.warning}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 4 }}>
        루트 권한 요청 {requests.length}건 — 승인 대기
      </div>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
        아래 명령은 <strong>그대로</strong> root 로 실행됩니다. 승인할 때 입력하는 비밀번호는 저장되지
        않으며, 일회용 티켓으로 해당 호스트의 매니저에게 한 번만 전달됩니다. 결정하지 않으면 만료되어
        아무 일도 일어나지 않습니다.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {requests.map((req) => (
          <div
            key={req.request_id}
            style={{
              padding: 10,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.sm,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>
              <strong>{req.agent_name}</strong> → <code>{req.hostname}</code>
            </div>
            <code
              style={{
                fontSize: 12,
                fontFamily: 'monospace',
                color: tokens.colors.textStrong,
                wordBreak: 'break-all',
              }}
            >
              sudo {req.command} {req.args.join(' ')}
            </code>
            <div style={{ fontSize: 11, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
              {req.reason}
            </div>
            {deciding?.request_id === req.request_id ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <Input
                    type="password"
                    autoFocus
                    value={password}
                    placeholder={`${req.hostname} 의 sudo 비밀번호`}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === 'Enter') void approve();
                    }}
                  />
                </div>
                <Button size="sm" variant="primary" onClick={approve} disabled={!password || busy}>
                  {busy ? '실행 중…' : '승인하고 실행'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setPassword('');
                    setDecidingId(null);
                  }}
                >
                  취소
                </Button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6 }}>
                <Button size="sm" variant="primary" onClick={() => setDecidingId(req.request_id)}>
                  승인…
                </Button>
                <Button size="sm" variant="danger" onClick={() => deny(req)}>
                  거부
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── SudoPasswordModal — 일회용 sudo 비밀번호 입력 ────────────────────────────
//
// 비밀번호는 여기서만 존재한다. 제출하면 곧바로 **일회용 티켓**으로 바뀌고(서버
// 메모리, TTL 120초, 1회용) 이 컴포넌트의 상태는 비워진다. AWB 는 이 값을 어디에도
// 저장하지 않는다 — DB 에도, 브라우저에도, 로그에도.
//
// 커맨드에 실려 나가는 것은 티켓 id 뿐이라, SSE 페이로드·커맨드 원장·활동 로그에
// 비밀번호가 남지 않는다. 매니저는 권한 상승이 실제로 필요한 순간에 그 id 로
// 서버에서 한 번만 당겨 간다.
function SudoPasswordModal({
  instanceId,
  hostname,
  target,
  onClose,
  onTicket,
}: {
  instanceId: string;
  hostname: string;
  target: { cli: string; bin: string; method: string };
  onClose: () => void;
  onTicket: (ticketId: string) => void;
}) {
  const { showToast } = useToast();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    try {
      const { ticket_id } = await api.mintSudoTicket(instanceId, {
        password,
        // scope 를 발급 시점에 못 박는다 — 티켓 id 가 새더라도 다른 설치본에
        // 쓸 수 없다.
        scope: { kind: 'cli_update', cli: target.cli, bin: target.bin },
      });
      // 성공하든 말든 화면에서 비밀번호를 즉시 지운다.
      setPassword('');
      onTicket(ticket_id);
    } catch (err: any) {
      setPassword('');
      showToast(`sudo 티켓 발급 실패: ${err?.message || err}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`sudo 비밀번호 — ${hostname}`}
      maxWidth={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button variant="primary" onClick={submit} disabled={!password || busy}>
            {busy ? '확인 중…' : '업데이트'}
          </Button>
        </>
      }
    >
      <p style={{ margin: '0 0 10px 0', fontSize: 12, color: tokens.colors.textSecondary, lineHeight: 1.6 }}>
        <code>{target.bin}</code> 는 root 소유라 현재 권한으로는 올릴 수 없습니다.
        {target.method ? <> 올리는 방법: <code>{target.method}</code>.</> : null}
      </p>
      <p style={{ margin: '0 0 12px 0', fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.6 }}>
        입력한 비밀번호는 <strong>저장되지 않습니다</strong>. 서버 메모리에서 120초만 유지되는 일회용
        티켓으로 바뀌고, 그 호스트의 매니저가 <strong>한 번만</strong> 받아 가 <code>sudo</code> 의 stdin 으로
        전달합니다. 실행되는 명령은 매니저가 그 설치본의 설치 방식에서 직접 만든 것이며, 이 화면이
        명령 문자열을 보내지는 않습니다.
      </p>
      <Input
        type="password"
        autoFocus
        value={password}
        placeholder={`${hostname} 의 sudo 비밀번호`}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') void submit();
        }}
      />
    </Modal>
  );
}

// ─── InstalledCliVersions — 설치본 단위의 버전 + Update ────────────────────────
//
// InstanceDetail 과 같은 이유로 노출한다 — 이 패널의 잠금 규칙(최신/구버전/모름)
// 을 인스턴스 전체를 부팅하지 않고 직접 마운트해 검사하기 위해서다.
//
// 한 Runtime Host 에 같은 CLI 가 여러 벌 깔려 있는 것은 정상 구성이다(vLLM
// 백엔드용 두 번째 claude). 그러므로 화면의 단위는 CLI 가 아니라 설치본이고,
// 각 행은 자기 경로·버전·설치 방법을 갖는다. Update 는 그 경로를 명시해 보내므로
// "어느 것이 올라갈지" 가 눌러 보기 전에 결정돼 있다.
//
// 버튼 잠금은 삼항이다(utils/cliVersions): 최신이면 잠그고, 구버전이면 목표
// 버전을 보여주고, **최신을 모르면 잠그지 않는다** — 모른다고 잠그면 npm 조회가
// 실패한 호스트에서 올릴 길이 사라진다.
const EMPTY_SET: ReadonlySet<string> = new Set();

export function InstalledCliVersions({
  inst,
  pending,
  onUpdate,
  onUpdateAll,
  updateAllPending = false,
  onUpdateAdapter,
  adapterPending = EMPTY_SET,
  hideLabel = false,
}: {
  inst: AgentManagerInstance;
  /** 지금 올리는 중인 설치본 키 집합. 한 설치본의 진행이 다른 행을 잠그면 안 된다. */
  pending: ReadonlySet<string>;
  onUpdate: (cli: string, bin: string | undefined, needsSudo: boolean, method: string) => void;
  /** "전부 올리기". 무엇을 올릴지는 매니저가 자기 설치 열거로 정하므로 목록을 싣지 않는다. */
  onUpdateAll?: () => void;
  updateAllPending?: boolean;
  /** ACP 어댑터 하나 올리기(cli 단위). */
  onUpdateAdapter?: (cli: string) => void;
  /** 올리는 중인 어댑터(cli) 집합. */
  adapterPending?: ReadonlySet<string>;
  /** 제목 달린 섹션 안에 놓을 때는 자체 라벨을 끈다 — 같은 말이 두 줄 겹친다. */
  hideLabel?: boolean;
}) {
  // 매니저가 설치본 목록을 보내면 그것이 진실이다. 안 보내면(구버전) cli_versions
  // 를 CLI 당 한 줄짜리 가짜 설치본으로 접어 같은 렌더 경로를 태운다.
  const installs: CliInstallEntry[] = inst.cli_installs?.length
    ? inst.cli_installs
    : Object.entries(inst.cli_versions ?? {}).map(([cli, version]) => ({
        cli,
        path: '',
        version,
        method: '',
        updatable: inst.cli_adapters.includes(cli),
        // 구버전 매니저는 이 값을 모른다. 모르면 묻지 않는다 — 어차피 그 매니저는
        // sudo 티켓을 쓸 줄 모르므로, 비밀번호를 받아 봐야 쓰이지 않는다.
        needs_sudo: false,
        // latest_version 은 일부러 넣지 않는다(undefined) — 이 합성 행은 CLI 단위
        // 값으로 접혀야 예전 동작이 그대로 유지된다.
        active: true,
      }));
  // 설치본이 없어도 어댑터 줄은 그린다 — 설치본 열거가 실패한 호스트에서 어댑터 Update 까지
  // 숨으면 안 된다(둘은 별개의 출처다).
  const hasAdapters = (inst.acp_adapters ?? []).some((a) => a.source !== 'builtin');
  if (installs.length === 0 && !hasAdapters) return null;

  const perCli = new Map<string, number>();
  for (const row of installs) perCli.set(row.cli, (perCli.get(row.cli) ?? 0) + 1);

  // 같은 CLI 중 이 호스트에서 가장 높은 버전. "최신" 이라는 라벨이 절대적 주장으로
  // 읽히지 않게 하려면 이게 필요하다 — snap 설치본은 **자기 채널 기준으로는** 최신일
  // 수 있지만, 바로 옆 줄에 더 높은 버전이 있는데 "최신" 이라고 쓰면 말이 안 된다
  // (rolf: 죽은 채널의 snap codex 0.114.0 vs 공식 npm 0.156.1).
  const newestPerCli = new Map<string, string>();
  for (const row of installs) {
    if (!row.version) continue;
    const best = newestPerCli.get(row.cli);
    if (!best || (compareCliVersionStrings(row.version, best) ?? 0) > 0) {
      newestPerCli.set(row.cli, row.version);
    }
  }

  const sorted = [...installs].sort(
    (a, b) => a.cli.localeCompare(b.cli) || Number(b.active) - Number(a.active) || a.path.localeCompare(b.path),
  );

  // 최신 버전은 CLI 가 아니라 **설치본**에 속한다. 매니저가 행마다 알려주면 그것을
  // 쓰고(snap/brew 는 null — npm 의 숫자를 들이대면 안 되는 채널이다), 아예 안 보내는
  // 구버전 매니저일 때만 CLI 단위 값으로 접는다.
  const latestFor = (row: CliInstallEntry): string | null =>
    row.latest_version !== undefined ? row.latest_version : inst.cli_latest_versions?.[row.cli] ?? null;
  // "전부 올리기" 를 켤지 정하는 규칙은 **행의 Update 버튼이 뜨는 규칙과 같아야 한다** —
  // 갈리면 버튼이 화면과 다른 것을 올린다고 말하게 된다.
  const updatableRows = sorted.filter(
    (row) => row.updatable && cliUpdateState(row.version, latestFor(row)) !== 'up-to-date',
  );
  // "전부" 에는 뒤처진 ACP 어댑터도 들어간다 — 매니저의 update_all_clis 가 같은 규칙으로 올린다.
  const behindAdapters = behindAcpAdapters(inst);

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      {!hideLabel && (
        <dt style={{ color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Installed CLI versions
        </dt>
      )}
      <dd style={{ margin: '4px 0 0', color: tokens.colors.textStrong, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {sorted.map((row) => {
          // 최신 버전은 CLI 가 아니라 **설치본**에 속한다. 매니저가 행마다 알려주면
          // 그것을 쓴다(snap/brew 는 null — npm 의 숫자를 들이대면 안 되는 채널이다).
          // 구버전 매니저는 아예 안 보내므로(undefined) 그때만 CLI 단위 값으로 접는다.
          const latest = latestFor(row);
          const state = cliUpdateState(row.version, latest);
          const upToDate = state === 'up-to-date';
          // 자기 채널로는 최신인데 같은 호스트에 더 새 설치본이 있는 경우. 이때
          // "최신" 은 사실이지만 오해를 부른다 — 무엇 기준인지, 그리고 더 새 것이
          // 어디 있는지를 함께 말해야 운영자가 다음 행동을 정할 수 있다.
          const newestOnHost = newestPerCli.get(row.cli) ?? null;
          const superseded =
            upToDate &&
            Boolean(newestOnHost) &&
            (compareCliVersionStrings(newestOnHost, row.version) ?? 0) > 0;
          const newerRow = superseded
            ? sorted.find((r) => r.cli === row.cli && r.version === newestOnHost) ?? null
            : null;
          const supersededTitle = newerRow
            ? `이 설치본은 자기 배포 채널에서는 최신이지만, 같은 호스트의 ` +
              `${newerRow.path || '다른 설치본'} 이 ${newerRow.version} 으로 더 새롭습니다` +
              `${newerRow.active ? ' (AWB 는 그쪽을 실행합니다)' : ''}. ` +
              '이 채널에서는 더 올라갈 곳이 없으므로, 쓰지 않는다면 지우는 편이 낫습니다.'
            : '';
          const key = row.path || row.cli;
          const busy = pending.has(key);
          // **이 행만** 잠근다. 예전엔 `pending !== null` 이라 다른 설치본까지 전부
          // 죽었고, ack 대기가 최대 4분이라 그동안 아무것도 못 눌렀다.
          const disabled = busy || upToDate;
          // 같은 CLI 가 한 벌뿐이면 경로는 소음이다 — 여러 벌일 때만 짚어 준다.
          const showPath = Boolean(row.path) && (perCli.get(row.cli) ?? 0) > 1;
          return (
            <span
              key={`${row.cli}:${key}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 6px 2px 8px',
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                fontSize: 11,
                width: 'fit-content',
                maxWidth: '100%',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontFamily: 'monospace' }}>
                {row.cli} {row.version ?? 'unknown'}
              </span>
              {state === 'outdated' && (
                <span style={{ fontWeight: 600, color: tokens.colors.success }}>→ {latest}</span>
              )}
              {upToDate && !superseded && <span style={{ color: tokens.colors.textMuted }}>최신</span>}
              {superseded && (
                <span style={{ color: tokens.colors.warning, fontWeight: 600 }} title={supersededTitle}>
                  뒤처짐 · 이 채널 최신
                </span>
              )}
              {row.active && (perCli.get(row.cli) ?? 0) > 1 && (
                <span
                  style={{ color: tokens.colors.textMuted }}
                  title="지정 없이 spawn 하면 실행되는 설치본입니다."
                >
                  · 활성
                </span>
              )}
              {showPath && (
                <span style={{ fontFamily: 'monospace', color: tokens.colors.textMuted }}>{row.path}</span>
              )}
              {row.method && (
                <span style={{ color: tokens.colors.textMuted }} title="이 설치본을 올리는 방법">
                  ({row.method})
                </span>
              )}
              {row.needs_sudo && (
                <span
                  style={{ color: tokens.colors.warning }}
                  title="이 설치본은 root 소유라, Update 를 누르면 sudo 비밀번호를 한 번 묻습니다. 비밀번호는 저장되지 않습니다."
                >
                  🔒 sudo
                </span>
              )}
              {row.updatable && (
                <button
                  onClick={() => onUpdate(row.cli, row.path || undefined, row.needs_sudo, row.method)}
                  disabled={disabled}
                  style={{
                    padding: '2px 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    background: 'transparent',
                    color: tokens.colors.textStrong,
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.sm,
                    cursor: busy ? 'wait' : disabled ? 'default' : 'pointer',
                    fontFamily: 'inherit',
                    opacity: disabled && !busy ? 0.5 : 1,
                  }}
                  title={
                    superseded
                      ? supersededTitle
                      : upToDate
                      ? `${row.cli} 는 이 설치본의 배포 채널 기준 최신입니다 (${latest}).`
                      : `update_cli — ${row.path || `이 장비의 ${row.cli}`} 를 올립니다` +
                        `${row.method ? ` (${row.method})` : ''}` +
                        `${state === 'outdated' ? ` · ${row.version} → ${latest}` : ' · 최신 버전 확인 불가 — 눌러서 시도할 수 있습니다'}. ` +
                        '매니저는 재시작되지 않지만 이후 spawn 되는 에이전트·세션은 새 버전을 씁니다.'
                  }
                >
                  {busy ? '업데이트 중…' : 'Update'}
                </button>
              )}
            </span>
          );
        })}
        {/* 한 번에 전부 올리기. 설치본마다 따로 누르던 것을 모아서 할 뿐이라 켜고 끄는
            규칙은 행 버튼과 같다(updatableRows). 무엇을 올릴지는 매니저가 자기 설치
            열거로 정하므로 여기서 목록을 실어 보내지 않는다 — 화면이 낡은 순간
            엉뚱한 설치본을 올리게 된다. */}
        <AcpAdapterVersions inst={inst} pending={adapterPending} onUpdate={onUpdateAdapter} />
        {onUpdateAll && updatableRows.length + behindAdapters.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <button
              onClick={onUpdateAll}
              disabled={updateAllPending}
              style={{
                padding: '3px 10px',
                fontSize: 11,
                fontWeight: 700,
                background: 'transparent',
                color: tokens.colors.textStrong,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.sm,
                cursor: updateAllPending ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
              title={
                `update_all_clis — 올릴 수 있는 설치본 ${updatableRows.length}개` +
                `${behindAdapters.length ? `와 뒤처진 ACP 어댑터 ${behindAdapters.length}개` : ''}를 한 번에 올립니다 ` +
                `(${[...updatableRows.map((r) => r.cli), ...behindAdapters.map((a) => `${a.cli}-acp`)].join(', ')}). ` +
                '같은 설치 디렉터리를 공유하는 것끼리만 차례로 돌고 나머지는 동시에 올라갑니다. ' +
                'sudo 가 필요한 설치본은 건너뛰고 그렇다고 알려줍니다 — 그건 행의 Update 로 올리세요.'
              }
            >
              {updateAllPending ? `전부 업데이트 중…` : `전부 업데이트 (${updatableRows.length + behindAdapters.length})`}
            </button>
          </div>
        )}
      </dd>
    </div>
  );
}

/** 이 매니저가 `update_acp_adapter` 를 아는가. 모르는 매니저에 버튼을 내면 누를 때마다
 *  `unknown command` 로 거절된다(1.6.257 이하에서 실제로 그랬다). */
export function canUpdateAcpAdapters(inst: AgentManagerInstance): boolean {
  return (inst.manager_capabilities ?? []).includes('acp_adapter_update');
}

/** 이 호스트의 어댑터 중 최신보다 뒤처진 것(최신을 모르면 넣지 않는다 — "모름" ≠ "뒤처짐").
 *  매니저가 어댑터 업데이트를 지원하지 않으면 비어 있다 — "전부 업데이트" 가 올릴 수 없는 것을
 *  세면 안 된다. */
export function behindAcpAdapters(inst: AgentManagerInstance): AcpAdapterReport[] {
  if (!canUpdateAcpAdapters(inst)) return [];
  return (inst.acp_adapters ?? []).filter((a) => {
    if (a.source !== 'managed' && a.source !== 'bundled') return false;
    const latest = (a.package && inst.acp_adapter_latest_versions?.[a.package]) || null;
    return !!(a.version && latest && cliUpdateState(a.version, latest) === 'outdated');
  });
}

/**
 * ACP 어댑터 버전 — 세션의 모델 목록·capability 를 **실제로** 정하는 값.
 *
 * 어댑터는 모델 id 를 자기 번들에 하드코딩한다. 그래서 CLI 를 최신으로 올려도 어댑터가
 * 뒤처지면 새 모델을 세션에서 고를 수 없다(2026-10-01: claude-agent-acp 0.79.0 이 세 호스트에서
 * 조용히 5버전 썩어 Opus 5.5 가 세션에 안 떴다).
 *
 * **Update 는 `update_acp_adapter` 다** — 매니저 홈에 최신을 설치하고 해석이 홈 설치본과 매니저
 * 번들본 중 더 새 것을 쓴다. 전역 `npm i -g` 로는 안 된다(번들본이 PATH 보다 앞이다). 이미 열린
 * 세션은 옛 어댑터 프로세스를 그대로 쓰므로 새 세션이나 세션 Restart 부터 적용된다.
 */
function AcpAdapterVersions({
  inst,
  pending,
  onUpdate,
}: {
  inst: AgentManagerInstance;
  pending: ReadonlySet<string>;
  onUpdate?: (cli: string) => void;
}) {
  const rows = (inst.acp_adapters ?? []).filter((a) => a.source !== 'builtin');
  if (rows.length === 0) return null;
  const latestOf = (pkg: string | null): string | null =>
    (pkg && inst.acp_adapter_latest_versions?.[pkg]) || null;
  const supported = canUpdateAcpAdapters(inst);
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ fontSize: 10.5, color: tokens.colors.textMuted }}>
        ACP 어댑터 — 세션의 모델 목록을 정합니다
      </div>
      {!supported && onUpdate && (
        <div data-acp-adapter-unsupported style={{ fontSize: 10.5, color: tokens.colors.warning }}>
          이 매니저(v{inst.plugin_version})는 어댑터 업데이트를 지원하지 않습니다 — 매니저를 먼저 업데이트하세요.
        </div>
      )}
      {rows.map((a) => {
        const latest = latestOf(a.package);
        const state = a.version && latest ? cliUpdateState(a.version, latest) : null;
        const behind = state === 'outdated';
        const upToDate = state === 'up-to-date';
        const busy = pending.has(a.cli);
        // 올릴 수 있는 것은 패키지 어댑터뿐이다 — env 로 고정한 것(override)은 AWB 가 손대면 안 된다.
        const updatable = !!a.package && a.source !== 'override';
        return (
          <div
            key={`${a.cli}:${a.package ?? ''}`}
            data-acp-adapter={a.cli}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: tokens.colors.textSecondary }}
          >
            <span style={{ fontWeight: 600 }}>{a.cli}</span>
            <span style={{ fontFamily: 'monospace' }}>{a.version ?? '버전 미상'}</span>
            {behind && (
              <span style={{ color: tokens.colors.warning }} title={`npm 최신 ${latest}`}>
                → {latest} 뒤처짐
              </span>
            )}
            {upToDate && <span style={{ color: tokens.colors.textMuted }}>(최신)</span>}
            <span
              style={{ color: a.source === 'bundled' || a.source === 'managed' ? tokens.colors.textMuted : tokens.colors.warning }}
              title={
                a.source === 'managed'
                  ? '운영자가 올린 어댑터(매니저 홈)를 쓰고 있습니다 — 매니저 번들본보다 새 버전입니다.'
                  : a.source === 'bundled'
                  ? '매니저와 함께 설치된 어댑터를 쓰고 있습니다.'
                  : a.source === 'path'
                  ? '장비에 전역 설치된 어댑터를 쓰고 있습니다 — 이 매니저는 어댑터를 번들하지 않는 구버전입니다.'
                  : a.source === 'npx'
                  ? '설치돼 있지 않아 실행할 때마다 npx 로 당겨옵니다.'
                  : '운영자가 AWB_ACP_COMMAND 로 어댑터 명령을 고정했습니다 — 버전은 AWB 가 알 수 없습니다.'
              }
            >
              ({a.source})
            </span>
            {updatable && onUpdate && supported && (
              <button
                onClick={() => onUpdate(a.cli)}
                disabled={busy || upToDate}
                style={{
                  padding: '2px 8px',
                  fontSize: 11,
                  fontWeight: 600,
                  background: 'transparent',
                  color: tokens.colors.textStrong,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.sm,
                  cursor: busy ? 'wait' : upToDate ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                  opacity: upToDate && !busy ? 0.5 : 1,
                }}
                title={
                  upToDate
                    ? `${a.package} 는 최신입니다 (${latest}).`
                    : `update_acp_adapter — ${a.package} 를 최신으로 올립니다` +
                      `${latest ? ` (${a.version} → ${latest})` : ' (최신 버전 확인 불가 — 눌러서 시도할 수 있습니다)'}. ` +
                      '매니저 홈에 설치하므로 매니저는 재시작되지 않습니다. 이미 열린 세션은 Restart 해야 새 어댑터를 씁니다.'
                }
              >
                {busy ? '업데이트 중…' : 'Update'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── UpdateFailureBadge — 업데이트 시도 실패 사유. 실패한 버전만 스킵하고 새 버전
// 오퍼는 막지 않으므로, 이 배지는 "왜 저 버전이 안 뜨나"의 답이다. 핀이 없으면(구버전
// 매니저) 아무것도 그리지 않는다. 핀 해제는 호스트의 핀 파일 삭제(사람만).
function UpdateFailureBadge({ inst }: { inst: AgentManagerInstance }) {
  const badge = updateFailureBadge(inst);
  if (!badge) return null;
  return (
    <span
      style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.warning }}
      title={badge.title}
    >
      ⚠ {badge.label}
    </span>
  );
}

// ─── ManagerVersionBadge — render `(→ vX.Y.Z available)` next to the manager version
// when the manager's UpdateChecker says a newer build is on origin/<branch>. A
// pre-update manager (no UpdateChecker fields in the heartbeat) renders nothing
// so we don't gaslight operators on instances that genuinely don't ship the
// self-update path.
function ManagerVersionBadge({ inst }: { inst: AgentManagerInstance }) {
  // Field absence vs `false` matters here: undefined === pre-update manager
  // (silent fallback), false === checker ran and there's no update, true ===
  // checker ran and an update is on origin.
  if (inst.update_available === undefined) return null;
  // npm-global is the only auto-updatable install (the Update button runs
  // `npm i -g`). Everything else — 'unknown' mode, the retired 'git' mode from a
  // manager that hasn't updated yet, or a manager too old to report install_mode
  // at all — gets the "manual updates only" hint instead.
  if (inst.install_mode !== 'npm-global') {
    return (
      <span
        style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.textMuted }}
        title="This manager can't auto-update — upgrade it manually with npm i -g --ignore-scripts awb-agent-manager@latest."
      >
        (manual updates only)
      </span>
    );
  }
  // Operator pinned this build (AWB_AGENT_MANAGER_UPDATE_CHANNEL=off) — the
  // checker is deliberately idle, so no update badge would be honest.
  if (inst.update_channel === 'off') {
    return (
      <span
        style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.textMuted }}
        title="Auto-update is off (AWB_AGENT_MANAGER_UPDATE_CHANNEL=off) — this build is pinned."
      >
        (pinned)
      </span>
    );
  }
  if (inst.update_last_error && !inst.latest_version) {
    // Hard failure: fetch failed AND no cached remote ref to fall back on.
    return (
      <span
        style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.warning }}
        title={`Self-update checker error: ${inst.update_last_error}`}
      >
        (update check failed)
      </span>
    );
  }
  if (!inst.update_available) {
    return (
      <span
        style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.textMuted }}
        title={
          inst.update_skipped_version
            ? `v${inst.update_skipped_version} was skipped (failed before) — newer versions are still offered. Up to date otherwise${inst.update_last_checked_at ? ` as of ${inst.update_last_checked_at}` : ''}`
            : inst.update_last_checked_at
              ? `Up to date as of ${inst.update_last_checked_at}`
              : 'Update checker has not yet completed its first poll'
        }
      >
        (up to date)
      </span>
    );
  }
  return (
    <span
      style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: tokens.colors.success }}
      title={
        `Latest on the ${inst.update_channel || 'latest'} npm channel: v${inst.latest_version}. ` +
        'Use the Update button to reinstall (npm i -g) + restart.'
      }
    >
      → v{inst.latest_version} available
    </span>
  );
}
