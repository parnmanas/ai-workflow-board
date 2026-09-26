import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import type {
  OrchestrationMissionDetail,
  OrchestrationTeam,
  OrchestrationUpdateEvent,
  OrchestrationUserChatMode,
} from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, ConfirmDialog, EmptyState, Modal } from '../common';
import { relativeTime } from '../../utils/time';
import PlanGraph from './PlanGraph';
import ConfirmRequestPanel from './ConfirmRequestPanel';
import MissionConversationPanel from './MissionConversationPanel';
import MissionStepRail from './MissionStepRail';
import StepSessionPanel from './StepSessionPanel';
import MissionEvidencePane from './MissionEvidencePane';
import { MissionFormModal } from './OrchestrationPage';
import { missionStyle, progressPercent } from './status';

/**
 * Mission detail — the "watch the team work" view.
 *
 * Three panes answer the three questions an operator actually has:
 *   - the header answers "is this alive and how far along is it"
 *   - the plan graph answers "who is doing what, and what is blocked on what"
 *   - the timeline answers "what has actually happened, in order"
 *
 * Live refresh is signal-driven, not polled: the server pushes an
 * `orchestration_update` headline on every state change and this view refetches
 * the full detail on it (debounced, because a fan-out wave emits several frames
 * within a few hundred milliseconds). A slow safety-net poll runs only while
 * the mission is non-terminal, to cover a dropped SSE frame.
 */
export default function MissionDetailPage() {
  const { wsId = '', missionId = '' } = useParams<{ wsId: string; missionId: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [mission, setMission] = useState<OrchestrationMissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  /**
   * 오른쪽 패널이 무엇을 그리는가. `session` 이 기본이고, 선택된 step 이 있으면 그 step 의
   * 작업 세션, 없으면 미션 대화가 된다 — 탭을 하나 더 만들지 않고 선택 상태가 내용을
   * 가르는 구조다("step 을 고르면 그 세션, 선택을 풀면 메인 세션").
   */
  const [tab, setTab] = useState<'session' | 'graph' | 'evidence' | 'brief'>('session');
  const [busy, setBusy] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showNudge, setShowNudge] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [teams, setTeams] = useState<OrchestrationTeam[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!wsId || !missionId) return;
      if (!opts?.silent) setLoading(true);
      try {
        setMission(await api.getOrchestrationMission(missionId, wsId));
        setNotFound(false);
      } catch (e: any) {
        if (!opts?.silent) setNotFound(true);
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [wsId, missionId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Edit 모달의 (편집 중엔 비활성화된) Team select에 현재 팀 이름을 보여주는
  // 데만 필요하다 — draft 미션만 편집 가능하므로 자주 열리는 경로는 아니다.
  useEffect(() => {
    if (!wsId) return;
    api.listOrchestrationTeams(wsId).then(setTeams).catch(() => setTeams([]));
  }, [wsId]);

  // Debounced refetch: a wave of parallel steps completing emits one frame per
  // step, and each would otherwise trigger its own full detail request.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void load({ silent: true }), 400);
  }, [load]);

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  useBoardStreamEvent('orchestration_update', (data: OrchestrationUpdateEvent) => {
    if (!data || data.mission_id !== missionId) return;
    scheduleRefresh();
  });

  // Safety net for a dropped frame while work is in flight. Terminal missions
  // never change again, so they poll not at all.
  const isLive = mission ? !['completed', 'failed', 'cancelled'].includes(mission.status) : false;
  useEffect(() => {
    if (!isLive) return;
    const handle = setInterval(() => void load({ silent: true }), 30_000);
    return () => clearInterval(handle);
  }, [isLive, load]);

  const act = async (fn: () => Promise<OrchestrationMissionDetail>, successMessage: string) => {
    setBusy(true);
    try {
      setMission(await fn());
      showToast(successMessage, 'success');
    } catch (e: any) {
      showToast(e?.message || 'Action failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 24, color: tokens.colors.textMuted, fontSize: 13 }}>Loading mission...</div>;
  }
  if (notFound || !mission) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState
          title="Mission not found"
          description="It may have been deleted, or it belongs to another workspace."
          action={<Button variant="secondary" onClick={() => navigate(`/ws/${wsId}/orchestration`)}>Back to missions</Button>}
        />
      </div>
    );
  }

  const selectedStep = mission.steps.find((s) => s.id === selectedStepId) || null;
  /**
   * 종료된 미션 되살리기. 성공하면 상태가 running 으로 돌아오고 orchestrator 가 방에서
   * 깨어나므로, 화면은 곧 대화가 이어지는 상태가 된다.
   */
  const reopen = () =>
    act(() => api.reopenOrchestrationMission(mission.id, wsId), '미션을 다시 열었습니다 — orchestrator 를 깨웠습니다');
  const evidenceTotal =
    mission.steps.reduce((n, s) => n + (s.evidence_count ?? 0), 0) + (mission.mission_evidence_count ?? 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>

      <PageHeader
        title={mission.title}
        description={`${mission.team_name}${mission.orchestrator_name ? ` · orchestrated by ${mission.orchestrator_name}` : ''}`}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate(`/ws/${wsId}/orchestration`)}>
              All missions
            </Button>
            {mission.status === 'draft' && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setShowEdit(true)}>
                  Edit
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy}
                  onClick={() => act(() => api.startOrchestrationMission(mission.id, wsId), 'Orchestrator briefed')}
                >
                  Start
                </Button>
              </>
            )}
            {(mission.status === 'planning' || mission.status === 'running') && (
              <>
                <Button variant="secondary" size="sm" loading={busy} onClick={() => setShowNudge(true)}>
                  Nudge orchestrator
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  onClick={() => act(() => api.pauseOrchestrationMission(mission.id, wsId), 'Mission paused')}
                >
                  Pause
                </Button>
              </>
            )}
            {mission.status === 'paused' && (
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                onClick={() => act(() => api.resumeOrchestrationMission(mission.id, wsId), 'Mission resumed')}
              >
                Resume
              </Button>
            )}
            {!['completed', 'failed', 'cancelled'].includes(mission.status) && (
              <Button variant="danger" size="sm" onClick={() => setShowCancel(true)}>
                Cancel
              </Button>
            )}
            {/*
              종료된 미션을 되살린다. 새 미션을 만드는 것보다 이 버튼이 나은 이유는 계획·step
              결과·타임라인·대화가 전부 그대로 남기 때문이다 — 이어서 하려는 사람에게 처음부터
              다시 시작은 제일 비싼 길이다. 무엇을 다시 돌릴지는 그대로 orchestrator 가 정한다.
            */}
            {['completed', 'failed', 'cancelled'].includes(mission.status) && (
              <Button variant="secondary" size="sm" loading={busy} onClick={() => void reopen()}>
                Reopen
              </Button>
            )}
          </>
        }
      />

      {/*
        머리에 남는 것은 **한 줄짜리 상태**뿐이다. 브리핑·완료조건·계획 요약처럼 길고
        거의 변하지 않는 텍스트는 Brief 탭으로 내렸다 — 그것들이 화면 위쪽을 차지하고
        있으면 정작 지금 움직이는 것(진행 중인 step)을 보려고 매번 스크롤해야 한다.
      */}
      <div style={{ padding: '10px 16px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <StatusStrip mission={mission} />
        {/* 미션 전체가 여기서 멈춰 있으므로 접지 않는다 — 사람이 답해야 진행된다. */}
        <ConfirmRequestPanel steps={mission.steps} wsId={wsId} onDecided={() => load({ silent: true })} />
      </div>

      {/*
        본문은 2단이다. 왼쪽은 "무엇을 볼지"(미션 대화 + step 목록), 오른쪽은 고른 것의
        내용. 한 화면에 전부 쌓아 두던 이전 구조는 스크롤 위치가 곧 맥락이라, 대화를
        읽다가 step 상태를 보려면 화면을 잃어버렸다.
      */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', marginTop: 10, borderTop: `1px solid ${tokens.colors.border}` }}>
        <MissionStepRail
          steps={mission.steps}
          graph={mission.graph_spec}
          stepTimeoutMinutes={mission.step_timeout_minutes}
          selectedId={selectedStepId}
          onSelect={(id) => {
            setSelectedStepId(id);
            setTab('session');
          }}
          counts={mission.counts}
          planVersion={mission.plan_version}
          emptyHint={
            mission.status === 'draft'
              ? 'Not started yet — the orchestrator has not been briefed.'
              : mission.status === 'planning'
                ? 'The orchestrator is working out the plan. Steps appear the moment it submits one.'
                : 'No steps in this mission.'
          }
        />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '6px 10px',
              borderBottom: `1px solid ${tokens.colors.border}`,
            }}
          >
            <Tab active={tab === 'session'} onClick={() => setTab('session')}>
              {selectedStep ? 'Step session' : 'Mission conversation'}
            </Tab>
            <Tab active={tab === 'graph'} onClick={() => setTab('graph')}>
              Plan graph
            </Tab>
            <Tab active={tab === 'evidence'} onClick={() => setTab('evidence')}>
              Evidence{evidenceTotal > 0 ? ` (${evidenceTotal})` : ''}
            </Tab>
            <Tab active={tab === 'brief'} onClick={() => setTab('brief')}>
              Brief
            </Tab>
            {/* 종료된 미션에서도 대화가 되므로(되살리기 입구) 이 옵션은 방이 있으면 보인다. */}
            {tab === 'session' && !selectedStep && !!mission.room_id && (
              <label
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: tokens.colors.textMuted }}
              >
                User chat
                <select
                  value={mission.user_chat_mode}
                  disabled={busy}
                  data-testid="mission-user-chat-mode"
                  onChange={(e) =>
                    act(
                      () =>
                        api.updateOrchestrationMission(mission.id, {
                          workspace_id: wsId,
                          // 이 필드 하나만 보낸다 — 브리핑 필드를 함께 실으면 running
                          // 미션에서 서버의 draft 잠금이 409 를 낸다.
                          user_chat_mode: e.target.value as OrchestrationUserChatMode,
                        }),
                      'User chat updated',
                    )
                  }
                  style={{
                    fontSize: 11,
                    padding: '2px 6px',
                    borderRadius: 4,
                    border: `1px solid ${tokens.colors.border}`,
                    background: tokens.colors.surface,
                    color: tokens.colors.textPrimary,
                  }}
                >
                  <option value="open">Open</option>
                  <option value="participants_only">Participants only</option>
                  <option value="off">Off (read-only)</option>
                </select>
              </label>
            )}
          </div>

          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {tab === 'session' ? (
              selectedStep ? (
                /*
                  `key` 로 step 이 바뀌면 패널을 통째로 remount 한다 — 전사·스크롤 위치·
                  페이징 커서가 이전 step 의 것으로 남지 않게 하는 가장 확실한 경계다.
                */
                <StepSessionPanel
                  key={selectedStep.id}
                  step={selectedStep}
                  wsId={wsId}
                  events={mission.events}
                  stepTimeoutMinutes={mission.step_timeout_minutes}
                  onClose={() => setSelectedStepId(null)}
                />
              ) : (
                <MissionConversationPanel
                  key={mission.id}
                  missionId={mission.id}
                  workspaceId={wsId}
                  roomId={mission.room_id}
                  events={mission.events}
                  live={isLive}
                  userChatMode={mission.user_chat_mode}
                  onReopen={reopen}
                />
              )
            ) : tab === 'graph' ? (
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}>
                {mission.steps.length === 0 ? (
                  <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>No steps to draw yet.</div>
                ) : (
                  <>
                    <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 10 }}>
                      {mission.counts.done}/{mission.counts.total} done · up to {mission.max_parallel_steps} in parallel
                      {mission.graph_spec
                        ? ` · graph: ${mission.graph_spec.nodes.length} nodes, ${mission.graph_spec.edges.length} edges` +
                          (mission.graph_spec.edges.some((e) => e.kind === 'loop_back')
                            ? `, ${mission.graph_spec.edges.filter((e) => e.kind === 'loop_back').length} loop`
                            : '') +
                          ` · budget ${mission.total_visits}/${mission.graph_spec.max_total_visits} runs`
                        : ''}
                    </div>
                    <PlanGraph
                      steps={mission.steps}
                      graph={mission.graph_spec}
                      stepTimeoutMinutes={mission.step_timeout_minutes}
                      selectedId={selectedStepId}
                      // 그래프에서 카드를 고르면 곧바로 그 step 의 세션으로 넘어간다 —
                      // 위상을 보다가 "얘는 뭘 하고 있지"로 이어지는 흐름이 자연스럽다.
                      onSelect={(s) => {
                        setSelectedStepId(s.id);
                        setTab('session');
                      }}
                    />
                  </>
                )}
              </div>
            ) : tab === 'evidence' ? (
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                <MissionEvidencePane
                  missionId={mission.id}
                  wsId={wsId}
                  steps={mission.steps}
                  // 미션 상세가 갱신될 때마다(SSE/폴링) 갤러리도 다시 읽는다 — 새 증거는
                  // 곧 updated_at 이나 증거 수의 변화로 드러난다.
                  refreshKey={`${mission.updated_at}:${evidenceTotal}`}
                  onSelectStep={(id) => {
                    setSelectedStepId(id);
                    setTab('session');
                  }}
                />
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
                <BriefPane mission={mission} />
              </div>
            )}
          </div>
        </div>
      </div>

      <MissionFormModal
        isOpen={showEdit}
        wsId={wsId}
        teams={teams}
        mission={mission}
        onClose={() => setShowEdit(false)}
        onSaved={(m) => {
          setMission(m);
          setShowEdit(false);
        }}
      />

      <NudgeModal
        isOpen={showNudge}
        missionId={mission.id}
        wsId={wsId}
        onClose={() => setShowNudge(false)}
        onDone={(m) => {
          setMission(m);
          setShowNudge(false);
        }}
      />

      <ConfirmDialog
        isOpen={showCancel}
        title="Cancel mission?"
        message="Open steps are marked cancelled and no further work is dispatched. Subagents already running are not killed — their late reports are simply rejected."
        confirmLabel="Cancel mission"
        onConfirm={async () => {
          setShowCancel(false);
          await act(() => api.cancelOrchestrationMission(mission.id, wsId, 'cancelled from the mission view'), 'Mission cancelled');
        }}
        onCancel={() => setShowCancel(false)}
      />
    </div>
  );
}

/** 오른쪽 패널의 탭 하나. */
function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        border: 'none',
        borderBottom: `2px solid ${active ? tokens.colors.accent : 'transparent'}`,
        background: 'transparent',
        color: active ? tokens.colors.textPrimary : tokens.colors.textMuted,
        fontSize: 12,
        fontWeight: active ? 700 : 500,
        padding: '5px 10px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function NudgeModal({
  isOpen,
  missionId,
  wsId,
  onClose,
  onDone,
}: {
  isOpen: boolean;
  missionId: string;
  wsId: string;
  onClose: () => void;
  onDone: (m: OrchestrationMissionDetail) => void;
}) {
  const { showToast } = useToast();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) setNote('');
  }, [isOpen]);

  const submit = async () => {
    setSaving(true);
    try {
      onDone(await api.nudgeOrchestrationMission(missionId, wsId, note.trim()));
      showToast('Orchestrator woken', 'success');
    } catch (e: any) {
      showToast(e?.message || 'Failed to nudge', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Nudge the orchestrator"
      maxWidth={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={saving}>
            Send
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary, lineHeight: 1.6 }}>
          Posts a message into the mission room and wakes the orchestrator so it re-reads the mission state and takes
          the next action. Use it when a mission looks stalled, or to redirect the plan without cancelling it.
        </div>
        <textarea
          value={note}
          rows={4}
          placeholder="Optional note (e.g. drop the migration step and ship the API first)"
          onChange={(e) => setNote(e.target.value)}
          style={{
            width: '100%',
            padding: '9px 11px',
            borderRadius: 6,
            border: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surface,
            color: tokens.colors.textPrimary,
            fontSize: 13,
            fontFamily: 'inherit',
            lineHeight: 1.5,
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
      </div>
    </Modal>
  );
}

/**
 * 한 줄짜리 상태 띠 — "살아 있나 / 어디까지 왔나 / 지금 멈춰 있나".
 *
 * 이전의 큰 배너에서 카드 형태와 여백을 덜어냈다. 이 줄의 역할은 눈에 걸리는 것이지
 * 자리를 차지하는 것이 아니고, 아래 2단 본문이 화면의 주인이어야 한다. 실패 사유와
 * planning 안내는 남긴다 — 둘 다 "왜 아무 일도 일어나지 않는가"의 답이라 접으면 안 된다.
 */
function StatusStrip({ mission }: { mission: OrchestrationMissionDetail }) {
  const style = missionStyle(mission.status);
  const pct = progressPercent(mission.counts);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            padding: '2px 9px',
            borderRadius: 999,
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: style.color,
            background: style.background,
          }}
        >
          {style.label}
        </span>
        {style.live && (
          <span
            aria-hidden="true"
            className="awb-activity-live"
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: style.color,
            }}
          />
        )}
        <span style={{ fontSize: 11.5, color: tokens.colors.textSecondary }}>
          {mission.counts.total > 0
            ? `${mission.counts.done} done · ${mission.counts.inFlight} working · ${mission.counts.pending} waiting` +
              `${mission.counts.awaitingUser ? ` · ${mission.counts.awaitingUser} needs your decision` : ''}` +
              `${mission.counts.failed ? ` · ${mission.counts.failed} failed` : ''}`
            : 'No steps yet'}
        </span>
        <div
          style={{
            flex: 1,
            minWidth: 90,
            height: 4,
            borderRadius: 999,
            background: `${tokens.colors.border}80`,
            overflow: 'hidden',
          }}
        >
          <div style={{ width: `${pct}%`, height: '100%', background: style.color, transition: 'width 300ms ease' }} />
        </div>
        <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
          {mission.finished_at
            ? `finished ${relativeTime(mission.finished_at)}`
            : mission.started_at
              ? `started ${relativeTime(mission.started_at)}`
              : `created ${relativeTime(mission.created_at)}`}
        </span>
      </div>

      {mission.failure_reason && (
        <div style={{ marginTop: 7, fontSize: 11.5, color: tokens.colors.dangerLight, lineHeight: 1.5 }}>
          {mission.failure_reason}
        </div>
      )}
      {mission.status === 'planning' && (
        <div style={{ marginTop: 7, fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
          The orchestrator has been briefed in its mission room and is deciding how to break the work up. If nothing
          appears for a while, check that the orchestrator agent is online — the server re-briefs it automatically
          before giving up.
        </div>
      )}
    </div>
  );
}

function postActionStyle(status: string): { color: string; background: string } {
  if (status === 'dispatched') return { color: tokens.colors.successLight, background: `${tokens.colors.success}22` };
  if (status === 'dispatch_failed') return { color: tokens.colors.dangerLight, background: `${tokens.colors.danger}22` };
  if (status === 'skipped') return { color: tokens.colors.textMuted, background: `${tokens.colors.border}55` };
  return { color: tokens.colors.warningLight, background: `${tokens.colors.warning}22` };
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: tokens.colors.textMuted }}>
          {title}
        </h2>
        {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
      </div>
      {children}
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12, marginBottom: 4, fontSize: 11, fontWeight: 700, color: tokens.colors.textSecondary }}>
      {children}
    </div>
  );
}

function Prose({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <div
      style={{
        fontSize: 13,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        color: muted ? tokens.colors.textSecondary : tokens.colors.textPrimary,
      }}
    >
      {text}
    </div>
  );
}


/**
 * 미션의 고정 문서 — 목표·맥락·완료 조건·계획 요약·결과·후속 액션.
 *
 * 전부 **거의 변하지 않는 텍스트**라서 탭으로 내렸다. 예전에는 이것들이 화면 위쪽
 * 절반을 차지하고 있어서, 지금 움직이는 것을 보려면 매번 지나쳐 스크롤해야 했다.
 * 필요할 때 한 번 읽는 자료는 한 번에 찾을 수 있는 자리에 모아 두는 편이 낫다.
 */
function BriefPane({ mission }: { mission: OrchestrationMissionDetail }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 820 }}>
      <Section title="Objective">
        <Prose text={mission.objective} />
        {mission.context && (
          <>
            <SubHeading>Context</SubHeading>
            <Prose text={mission.context} muted />
          </>
        )}
        {mission.method && (
          <>
            <SubHeading>Method</SubHeading>
            <Prose text={mission.method} muted />
          </>
        )}
        {mission.acceptance_criteria && (
          <>
            <SubHeading>Acceptance criteria</SubHeading>
            <Prose text={mission.acceptance_criteria} muted />
          </>
        )}
        <SubHeading>Step workspace</SubHeading>
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary, fontFamily: 'monospace' }}>
          {mission.resolved_workspace_folder}
        </div>
        {/* Qualify the path: it is the root for ISOLATED slots only. A member whose slot
            uses the shared folder scope runs in its own working folder instead, so stating
            this unconditionally would send someone looking for files in a directory that
            never exists. */}
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
          Relative to each member&apos;s working folder, for members whose roster slot uses the
          <strong> isolated</strong> folder scope — each step gets its own subfolder here. Members set to
          <strong> shared</strong> run in their working folder directly; the Teams screen shows which is which.
        </div>
      </Section>

      {mission.completion_criteria.length > 0 && (
        <Section
          title="Completion criteria"
          right={
            <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
              {mission.completion_criteria.filter((c) => c.met).length}/{mission.completion_criteria.length} met
            </span>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {mission.completion_criteria.map((c) => (
              <div key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
                <span style={{ color: c.met ? tokens.colors.successLight : tokens.colors.textMuted }}>
                  {c.met ? '☑' : '☐'}
                </span>
                <div>
                  <span style={{ color: tokens.colors.textPrimary }}>{c.description}</span>{' '}
                  <span style={{ fontFamily: 'monospace', fontSize: 10, color: tokens.colors.textMuted }}>{c.key}</span>
                  {c.note && <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>{c.note}</div>}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {mission.plan_summary && (
        <Section title={`Orchestrator's plan (v${mission.plan_version})`}>
          <Prose text={mission.plan_summary} />
        </Section>
      )}

      {mission.result_summary && (
        <Section title={mission.status === 'completed' ? 'Result' : 'Final report'}>
          <Prose text={mission.result_summary} />
        </Section>
      )}

      {mission.post_actions.length > 0 && (
        <Section title="Post-completion actions">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[...mission.post_actions]
              .sort((a, b) => a.order - b.order)
              .map((pa, i) => {
                const style = postActionStyle(pa.status);
                return (
                  <div key={`${pa.action_id}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span
                      style={{
                        padding: '1px 7px',
                        borderRadius: 999,
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: style.color,
                        background: style.background,
                      }}
                    >
                      {pa.status}
                    </span>
                    <span style={{ fontFamily: 'monospace', color: tokens.colors.textSecondary }}>{pa.action_id}</span>
                    <span style={{ fontSize: 10, color: tokens.colors.textMuted }}>({pa.condition})</span>
                    {pa.error && <span style={{ color: tokens.colors.dangerLight, fontSize: 11 }}>{pa.error}</span>}
                  </div>
                );
              })}
          </div>
        </Section>
      )}
    </div>
  );
}
