import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import type {
  OrchestrationMissionDetail,
  OrchestrationStep,
  OrchestrationTeam,
  OrchestrationTimelineEvent,
  OrchestrationUpdateEvent,
} from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, ConfirmDialog, EmptyState, Modal } from '../common';
import { relativeTime } from '../../utils/time';
import PlanGraph from './PlanGraph';
import { MissionFormModal } from './OrchestrationPage';
import { eventColor, missionStyle, progressPercent, stepStyle } from './status';

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

  const style = missionStyle(mission.status);
  const selectedStep = mission.steps.find((s) => s.id === selectedStepId) || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <style>{`@keyframes awb-orch-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }`}</style>

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
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  onClick={() => setShowNudge(true)}
                >
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
          </>
        }
      />

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <StatusBanner mission={mission} />

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
          <SubHeading>Workspace</SubHeading>
          <div style={{ fontSize: 12, color: tokens.colors.textSecondary, fontFamily: 'monospace' }}>
            {mission.resolved_workspace_folder}
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
                  <span style={{ color: c.met ? tokens.colors.successLight : tokens.colors.textMuted }}>{c.met ? '☑' : '☐'}</span>
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

        <Section
          title="Plan"
          right={
            mission.steps.length > 0 ? (
              <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                {mission.counts.done}/{mission.counts.total} done · up to {mission.max_parallel_steps} in parallel
                {mission.graph_spec
                  ? ` · graph: ${mission.graph_spec.nodes.length} nodes, ${mission.graph_spec.edges.length} edges` +
                    (mission.graph_spec.edges.some((e) => e.kind === 'loop_back')
                      ? `, ${mission.graph_spec.edges.filter((e) => e.kind === 'loop_back').length} loop`
                      : '') +
                    ` · budget ${mission.total_visits}/${mission.graph_spec.max_total_visits} runs`
                  : ''}
              </span>
            ) : undefined
          }
        >
          {mission.steps.length === 0 ? (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted, lineHeight: 1.6 }}>
              {mission.status === 'draft'
                ? 'Not started yet — the orchestrator has not been briefed.'
                : mission.status === 'planning'
                  ? 'The orchestrator has the brief and is working out the plan. Steps appear here the moment it submits one.'
                  : 'No steps in this mission.'}
            </div>
          ) : (
            <PlanGraph
              steps={mission.steps}
              graph={mission.graph_spec}
              selectedId={selectedStepId}
              onSelect={(s) => setSelectedStepId(s.id)}
            />
          )}
        </Section>

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

        <Section title="Timeline" right={<span style={{ fontSize: 11, color: tokens.colors.textMuted }}>{mission.events.length} events</span>}>
          <Timeline events={mission.events} onSelectStep={(stepId) => setSelectedStepId(stepId)} />
        </Section>
      </div>

      <StepDetailModal step={selectedStep} onClose={() => setSelectedStepId(null)} />

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

/**
 * Operator → orchestrator channel.
 *
 * This is deliberately the ONLY way a human injects direction into a running
 * mission: it posts into the orchestrator's room and wakes it, so whatever the
 * operator says goes through the same agent that owns the plan. The alternative
 * — letting the UI edit steps directly — would desync the orchestrator's model
 * of the mission from the database with no channel to reconcile them.
 */
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

function StatusBanner({ mission }: { mission: OrchestrationMissionDetail }) {
  const style = missionStyle(mission.status);
  const pct = progressPercent(mission.counts);
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: 10,
        border: `1px solid ${tokens.colors.border}`,
        borderLeft: `3px solid ${style.color}`,
        background: tokens.colors.surfaceCard,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            padding: '3px 10px',
            borderRadius: 999,
            fontSize: 11,
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
            style={{ width: 7, height: 7, borderRadius: '50%', background: style.color, animation: 'awb-orch-pulse 1.4s ease-in-out infinite' }}
          />
        )}
        <span style={{ fontSize: 12, color: tokens.colors.textSecondary }}>
          {mission.counts.total > 0
            ? `${mission.counts.done} done · ${mission.counts.inFlight} working · ${mission.counts.pending} waiting${mission.counts.failed ? ` · ${mission.counts.failed} failed` : ''}`
            : 'No steps yet'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: tokens.colors.textMuted }}>
          {mission.finished_at
            ? `finished ${relativeTime(mission.finished_at)}`
            : mission.started_at
              ? `started ${relativeTime(mission.started_at)}`
              : `created ${relativeTime(mission.created_at)}`}
        </span>
      </div>

      <div style={{ marginTop: 10, height: 5, borderRadius: 999, background: `${tokens.colors.border}80`, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: style.color, transition: 'width 300ms ease' }} />
      </div>

      {mission.failure_reason && (
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.colors.dangerLight, lineHeight: 1.5 }}>
          {mission.failure_reason}
        </div>
      )}
      {mission.status === 'planning' && (
        <div style={{ marginTop: 10, fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
          The orchestrator has been briefed in its mission room and is deciding how to break the work up. If nothing
          appears for a while, check that the orchestrator agent is online — the server re-briefs it automatically
          before giving up.
        </div>
      )}
    </div>
  );
}

/** post_action 한 행의 "디스패치 결과" 색상 — 그 ActionRun의 최종 결과는 아니다(여기선 추적하지 않음, 서버쪽 MissionPostAction 문서 참고). */
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

function Timeline({
  events,
  onSelectStep,
}: {
  events: OrchestrationTimelineEvent[];
  onSelectStep: (stepId: string) => void;
}) {
  if (events.length === 0) {
    return <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Nothing has happened yet.</div>;
  }
  // Newest first: on a live mission the thing that just happened is what the
  // operator came to see, and a long-running mission's timeline is far taller
  // than the viewport.
  const ordered = [...events].reverse();
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {ordered.map((event) => (
        <div key={event.id} style={{ display: 'flex', gap: 10, padding: '6px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, paddingTop: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: eventColor(event.type) }} />
            <span style={{ flex: 1, width: 1, background: tokens.colors.border, marginTop: 3 }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: tokens.colors.textPrimary, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
              {event.message}
            </div>
            <div style={{ marginTop: 2, fontSize: 10, color: tokens.colors.textMuted, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontFamily: 'monospace' }}>{event.type}</span>
              {event.actor_name && <span>{event.actor_name}</span>}
              <span>{relativeTime(event.created_at)}</span>
              {event.step_id && (
                <button
                  type="button"
                  onClick={() => onSelectStep(event.step_id!)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: tokens.colors.accentSubtle,
                    cursor: 'pointer',
                    fontSize: 10,
                    fontFamily: 'inherit',
                    padding: 0,
                  }}
                >
                  {event.step_key ? `open ${event.step_key}` : 'open step'}
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function StepDetailModal({ step, onClose }: { step: OrchestrationStep | null; onClose: () => void }) {
  if (!step) return null;
  const style = stepStyle(step.status);
  return (
    <Modal
      isOpen={!!step}
      onClose={onClose}
      title={step.title}
      maxWidth={720}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span
            style={{
              padding: '2px 9px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              color: style.color,
              background: style.background,
            }}
          >
            {style.label}
          </span>
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: tokens.colors.textMuted }}>{step.step_key}</span>
          <span style={{ fontSize: 11, color: tokens.colors.textSecondary }}>
            {step.assignee_name || 'unassigned'}
          </span>
          <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
            attempt {step.attempt}/{step.max_attempts}
          </span>
        </div>

        {step.workspace_folder && (
          <div style={{ fontSize: 11, color: tokens.colors.textSecondary, fontFamily: 'monospace' }}>
            {step.workspace_folder}
          </div>
        )}

        {step.depends_on.length > 0 && (
          <div style={{ fontSize: 11, color: tokens.colors.textSecondary }}>
            Depends on: {step.depends_on.join(', ')}
          </div>
        )}

        <div>
          <SubHeading>Work order</SubHeading>
          <Prose text={step.instructions || '(no instructions recorded)'} />
        </div>

        {step.acceptance_criteria && (
          <div>
            <SubHeading>Done when</SubHeading>
            <Prose text={step.acceptance_criteria} muted />
          </div>
        )}

        {step.result_summary && (
          <div>
            <SubHeading>Reported result</SubHeading>
            <Prose text={step.result_summary} />
          </div>
        )}

        {step.artifacts.length > 0 && (
          <div>
            <SubHeading>Artifacts</SubHeading>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {step.artifacts.map((a, i) => (
                <div key={`${a.ref}-${i}`} style={{ fontSize: 12, color: tokens.colors.textSecondary }}>
                  <span style={{ color: tokens.colors.textMuted, fontFamily: 'monospace', fontSize: 10 }}>{a.kind}</span>{' '}
                  {/^https?:\/\//.test(a.ref) ? (
                    <a href={a.ref} target="_blank" rel="noreferrer" style={{ color: tokens.colors.accentLight }}>
                      {a.label || a.ref}
                    </a>
                  ) : (
                    <span>{a.label ? `${a.label} — ${a.ref}` : a.ref}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.6 }}>
          {step.dispatched_at && <>Dispatched {relativeTime(step.dispatched_at)}. </>}
          {step.finished_at && <>Finished {relativeTime(step.finished_at)}. </>}
          Plan version {step.plan_version}.
        </div>
      </div>
    </Modal>
  );
}
