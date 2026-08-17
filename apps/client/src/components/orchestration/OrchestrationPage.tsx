import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import type {
  OrchestrationMissionListItem,
  OrchestrationTeam,
  OrchestrationUpdateEvent,
} from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, EmptyState, Input, Modal, Select } from '../common';
import { relativeTime } from '../../utils/time';
import OrchestrationTabs from './OrchestrationTabs';
import { missionStyle, progressPercent } from './status';

/**
 * Mission list — the landing surface of Orchestration mode.
 *
 * Live updates come from the `orchestration_update` SSE frame, which carries
 * status + counts, so an active mission's row animates without polling. The
 * frame is a headline only: anything richer (the plan, the timeline) lives in
 * the detail view, which refetches on the same signal.
 */
export default function OrchestrationPage() {
  const { wsId = '' } = useParams<{ wsId: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [missions, setMissions] = useState<OrchestrationMissionListItem[]>([]);
  const [teams, setTeams] = useState<OrchestrationTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'active'>('all');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true);
    try {
      const [missionList, teamList] = await Promise.all([
        api.listOrchestrationMissions(wsId),
        api.listOrchestrationTeams(wsId).catch(() => [] as OrchestrationTeam[]),
      ]);
      setMissions(missionList);
      setTeams(teamList);
    } catch (e: any) {
      showToast(e?.message || 'Failed to load missions', 'error');
    } finally {
      setLoading(false);
    }
  }, [wsId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  // Patch the affected row in place rather than refetching the whole list — a
  // busy mission emits an update per step transition and a full reload per
  // frame would thrash the list while the user is reading it.
  useBoardStreamEvent('orchestration_update', (data: OrchestrationUpdateEvent) => {
    if (!data || data.workspace_id !== wsId) return;
    setMissions((prev) => {
      const idx = prev.findIndex((m) => m.id === data.mission_id);
      if (idx === -1) {
        // A mission created elsewhere (or by an agent) — pull the list once so
        // it appears without a manual refresh.
        void load();
        return prev;
      }
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        status: data.status,
        counts: data.counts,
        plan_version: data.plan_version,
        updated_at: data.timestamp,
      };
      return next;
    });
  });

  const visible = useMemo(
    () =>
      filter === 'active'
        ? missions.filter((m) => !['completed', 'failed', 'cancelled'].includes(m.status))
        : missions,
    [missions, filter],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Orchestration"
        description="Hand a whole task to a team of agents — the orchestrator plans it, delegates it, and reports back."
        actions={
          <>
            <Select
              aria-label="Filter missions"
              options={[
                { value: 'all', label: 'All missions' },
                { value: 'active', label: 'Active only' },
              ]}
              value={filter}
              onChange={(e) => setFilter(e.target.value as 'all' | 'active')}
            />
            <Button variant="primary" onClick={() => setShowCreate(true)} disabled={teams.length === 0}>
              New mission
            </Button>
          </>
        }
      />
      <OrchestrationTabs wsId={wsId} active="missions" />

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {loading ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading missions...</div>
        ) : teams.length === 0 ? (
          <EmptyState
            title="No teams yet"
            description="A mission runs on a team: one orchestrator agent that plans, plus the members it delegates to. Create a team first."
            action={<Button variant="primary" onClick={() => navigate(`/ws/${wsId}/orchestration/teams`)}>Create a team</Button>}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title={filter === 'active' ? 'No active missions' : 'No missions yet'}
            description="Describe a task and pick a team — the orchestrator breaks it into steps and assigns them itself."
            action={<Button variant="primary" onClick={() => setShowCreate(true)}>New mission</Button>}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {visible.map((mission) => (
              <MissionRow
                key={mission.id}
                mission={mission}
                onOpen={() => navigate(`/ws/${wsId}/orchestration/missions/${mission.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateMissionModal
        isOpen={showCreate}
        wsId={wsId}
        teams={teams}
        onClose={() => setShowCreate(false)}
        onCreated={(id) => {
          setShowCreate(false);
          navigate(`/ws/${wsId}/orchestration/missions/${id}`);
        }}
      />
    </div>
  );
}

function MissionRow({
  mission,
  onOpen,
}: {
  mission: OrchestrationMissionListItem;
  onOpen: () => void;
}) {
  const style = missionStyle(mission.status);
  const pct = progressPercent(mission.counts);

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '14px 16px',
        borderRadius: 10,
        border: `1px solid ${tokens.colors.border}`,
        borderLeft: `3px solid ${style.color}`,
        background: tokens.colors.surfaceCard,
        color: tokens.colors.textPrimary,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: style.color,
            background: style.background,
          }}
        >
          {style.label}
        </span>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0 }}>{mission.title}</span>
        <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
          {mission.finished_at
            ? `finished ${relativeTime(mission.finished_at)}`
            : mission.started_at
              ? `started ${relativeTime(mission.started_at)}`
              : `created ${relativeTime(mission.created_at)}`}
        </span>
      </div>

      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: tokens.colors.textSecondary }}>
        <span>
          Team <strong style={{ color: tokens.colors.textStrong }}>{mission.team_name}</strong>
        </span>
        {mission.orchestrator_name && <span>Orchestrator {mission.orchestrator_name}</span>}
        {mission.plan_version > 0 && <span>Plan v{mission.plan_version}</span>}
        <span style={{ marginLeft: 'auto' }}>
          {mission.counts.done}/{mission.counts.total} steps
          {mission.counts.inFlight > 0 && ` · ${mission.counts.inFlight} working`}
          {mission.counts.failed > 0 && ` · ${mission.counts.failed} failed`}
        </span>
      </div>

      <div
        style={{
          marginTop: 8,
          height: 4,
          borderRadius: 999,
          background: `${tokens.colors.border}80`,
          overflow: 'hidden',
          display: 'flex',
        }}
      >
        <div style={{ width: `${pct}%`, background: style.color, transition: 'width 300ms ease' }} />
      </div>
    </button>
  );
}

function CreateMissionModal({
  isOpen,
  wsId,
  teams,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  wsId: string;
  teams: OrchestrationTeam[];
  onClose: () => void;
  onCreated: (missionId: string) => void;
}) {
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [teamId, setTeamId] = useState('');
  const [objective, setObjective] = useState('');
  const [context, setContext] = useState('');
  const [criteria, setCriteria] = useState('');
  const [startNow, setStartNow] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setTitle('');
    setObjective('');
    setContext('');
    setCriteria('');
    setStartNow(true);
    setTeamId(teams.find((t) => t.enabled && t.members.length > 0)?.id || teams[0]?.id || '');
  }, [isOpen, teams]);

  const selectedTeam = teams.find((t) => t.id === teamId) || null;

  const submit = async () => {
    if (!title.trim() || !objective.trim() || !teamId) {
      showToast('Title, objective and team are required', 'error');
      return;
    }
    setSaving(true);
    try {
      const mission = await api.createOrchestrationMission({
        workspace_id: wsId,
        team_id: teamId,
        title: title.trim(),
        objective: objective.trim(),
        context: context.trim(),
        acceptance_criteria: criteria.trim(),
        start: startNow,
      });
      if (mission.start_error) {
        showToast(`Mission created but not started: ${mission.start_error}`, 'error');
      } else {
        showToast(startNow ? 'Mission briefed to the orchestrator' : 'Mission saved as a draft', 'success');
      }
      onCreated(mission.id);
    } catch (e: any) {
      showToast(e?.message || 'Failed to create mission', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New mission"
      maxWidth={640}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={saving}>
            {startNow ? 'Create & brief orchestrator' : 'Save draft'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ship the billing export" />

        <Select
          label="Team"
          options={teams.map((t) => ({
            value: t.id,
            label:
              `${t.name} — ${t.orchestrator_name || 'no orchestrator'} + ${t.members.length} member(s)` +
              (t.enabled ? '' : ' (disabled)'),
          }))}
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
        />
        {selectedTeam && selectedTeam.members.length === 0 && (
          <div style={{ fontSize: 11, color: tokens.colors.warningLight }}>
            This team has no members — the orchestrator will have nobody to delegate to.
          </div>
        )}

        <LabeledTextarea
          label="Objective"
          hint="What must be achieved. The orchestrator plans directly from this, so be concrete about scope."
          value={objective}
          onChange={setObjective}
          rows={5}
          placeholder="Add a CSV export of monthly invoices to the billing page, behind the existing feature flag."
        />
        <LabeledTextarea
          label="Context (optional)"
          hint="Background, links, prior art, constraints."
          value={context}
          onChange={setContext}
          rows={3}
        />
        <LabeledTextarea
          label="Acceptance criteria (optional)"
          hint="How the orchestrator decides the mission is finished. It is told to verify these before completing."
          value={criteria}
          onChange={setCriteria}
          rows={3}
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
          <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
          Brief the orchestrator immediately
        </label>
      </div>
    </Modal>
  );
}

export function LabeledTextarea({
  label,
  hint,
  value,
  onChange,
  rows = 4,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 4 }}>
        {label}
      </span>
      {hint && (
        <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6, lineHeight: 1.4 }}>
          {hint}
        </span>
      )}
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
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
    </label>
  );
}
