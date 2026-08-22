import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api';
import type { OrchestrationAssignableAgent, OrchestrationTeam } from '../../types';
import { formatAgentDisplayName } from '../../utils/agentName';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, ConfirmDialog, EmptyState, Input, Modal, Select } from '../common';
import OrchestrationTabs from './OrchestrationTabs';
import { LabeledTextarea } from './OrchestrationPage';

/**
 * Team roster management.
 *
 * The orchestrator is a required, first-class field rather than "a member with
 * a special role_label": the mission state machine addresses it directly and
 * the whole feature is undefined without one, so the UI refuses to create a
 * team until one is picked.
 *
 * `capabilities` gets the most visual weight of any member field because it is
 * the text the orchestrator actually reasons over when assigning work — a team
 * whose members have empty capability blurbs produces noticeably worse plans.
 */
export default function OrchestrationTeamsPage() {
  const { wsId = '' } = useParams<{ wsId: string }>();
  const { showToast } = useToast();

  const [teams, setTeams] = useState<OrchestrationTeam[]>([]);
  const [agents, setAgents] = useState<OrchestrationAssignableAgent[]>([]);
  // 글로벌 팀 로스터에는 글로벌(workspace 비종속) 에이전트만 들어갈 수 있다 — 별도
  // 목록으로 유지하는 이유는 OrchestrationAssignableAgent가 workspace_id를
  // 갖고 있지 않아 클라이언트 쪽에서 필터링할 수 없기 때문.
  const [globalAgents, setGlobalAgents] = useState<OrchestrationAssignableAgent[]>([]);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<OrchestrationTeam | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OrchestrationTeam | null>(null);
  const [memberTarget, setMemberTarget] = useState<OrchestrationTeam | null>(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true);
    try {
      const [teamList, agentList, globalAgentList, workspaceList] = await Promise.all([
        api.listOrchestrationTeams(wsId),
        api.listOrchestrationAgents(wsId).catch(() => [] as OrchestrationAssignableAgent[]),
        api.listOrchestrationAgents(wsId, { globalOnly: true }).catch(() => [] as OrchestrationAssignableAgent[]),
        api.getWorkspaces().catch(() => [] as any[]),
      ]);
      setTeams(teamList);
      setAgents(agentList);
      setGlobalAgents(globalAgentList);
      setWorkspaces(workspaceList.map((w: any) => ({ id: w.id, name: w.name })));
    } catch (e: any) {
      showToast(e?.message || 'Failed to load teams', 'error');
    } finally {
      setLoading(false);
    }
  }, [wsId, showToast]);

  /** 글로벌 팀은 소유 workspace만, workspace 종속 팀은 자기 workspace만 편집할 수 있다. */
  const canWrite = (team: OrchestrationTeam) => !team.is_global || team.owner_workspace_id === wsId;

  useEffect(() => {
    load();
  }, [load]);

  const replaceTeam = (team: OrchestrationTeam) =>
    setTeams((prev) => prev.map((t) => (t.id === team.id ? team : t)));

  const removeMember = async (team: OrchestrationTeam, memberId: string) => {
    try {
      replaceTeam(await api.removeOrchestrationTeamMember(team.id, memberId, wsId));
    } catch (e: any) {
      showToast(e?.message || 'Failed to remove member', 'error');
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteOrchestrationTeam(deleteTarget.id, wsId);
      setTeams((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      showToast('Team deleted', 'success');
    } catch (e: any) {
      showToast(e?.message || 'Failed to delete team', 'error');
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Orchestration"
        description="Teams: one orchestrator agent that plans and delegates, plus the members that execute."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            New team
          </Button>
        }
      />
      <OrchestrationTabs wsId={wsId} active="teams" />

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {loading ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading teams...</div>
        ) : teams.length === 0 ? (
          <EmptyState
            title="No teams yet"
            description="A team pairs one orchestrator with the agents it can delegate to. Missions run on teams."
            action={
              <Button variant="primary" onClick={() => { setEditing(null); setShowForm(true); }}>
                Create a team
              </Button>
            }
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {teams.map((team) => (
              <div
                key={team.id}
                style={{
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: 10,
                  background: tokens.colors.surfaceCard,
                  padding: 16,
                  opacity: team.enabled ? 1 : 0.6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: tokens.colors.textPrimary }}>{team.name}</span>
                      {team.is_global && (
                        <span
                          title={
                            canWrite(team)
                              ? 'Global team — visible from every workspace; this workspace created it and may edit it'
                              : 'Global team — visible from every workspace; only the workspace that created it may edit it'
                          }
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            color: tokens.colors.accentLight,
                            border: `1px solid ${tokens.colors.accent}55`,
                            borderRadius: 4,
                            padding: '1px 6px',
                            textTransform: 'uppercase',
                          }}
                        >
                          global
                        </span>
                      )}
                      {!team.enabled && (
                        <span style={{ fontSize: 10, color: tokens.colors.textMuted, textTransform: 'uppercase' }}>
                          disabled
                        </span>
                      )}
                      {team.active_mission_count > 0 && (
                        <span style={{ fontSize: 11, color: tokens.colors.infoLight }}>
                          {team.active_mission_count} active mission(s)
                        </span>
                      )}
                    </div>
                    {team.description && (
                      <div style={{ marginTop: 3, fontSize: 12, color: tokens.colors.textSecondary }}>{team.description}</div>
                    )}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canWrite(team)}
                    title={canWrite(team) ? undefined : 'Only the workspace that created this global team may edit it'}
                    onClick={() => { setEditing(team); setShowForm(true); }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canWrite(team)}
                    title={canWrite(team) ? undefined : 'Only the workspace that created this global team may edit its roster'}
                    onClick={() => setMemberTarget(team)}
                  >
                    Add member
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={!canWrite(team)}
                    title={canWrite(team) ? undefined : 'Only the workspace that created this global team may delete it'}
                    onClick={() => setDeleteTarget(team)}
                  >
                    Delete
                  </Button>
                </div>

                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: `${tokens.colors.accent}14`,
                    border: `1px solid ${tokens.colors.accent}33`,
                  }}
                >
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: tokens.colors.accentLight, textTransform: 'uppercase' }}>
                    Orchestrator
                  </div>
                  <div style={{ marginTop: 3, fontSize: 13, color: tokens.colors.textPrimary, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <OnlineDot online={team.orchestrator_online} />
                    {team.orchestrator_name || '(agent missing)'}
                    <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
                      · plans and delegates · up to {team.max_parallel_steps} step(s) in parallel ·{' '}
                      {team.max_open_missions > 0
                        ? `up to ${team.max_open_missions} self-created mission(s) open at once per workspace` +
                          (team.is_global ? ` (× ${team.allowed_workspace_ids.length || 0} allowed workspace(s))` : '')
                        : 'agent-created missions disabled'}
                    </span>
                  </div>
                  {team.orchestrator_prompt && (
                    <div style={{ marginTop: 6, fontSize: 11, color: tokens.colors.textSecondary, whiteSpace: 'pre-wrap' }}>
                      {team.orchestrator_prompt}
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: tokens.colors.textMuted, textTransform: 'uppercase' }}>
                    Members ({team.members.length})
                  </div>
                  {team.members.length === 0 ? (
                    <div style={{ marginTop: 6, fontSize: 12, color: tokens.colors.warningLight }}>
                      No members — this team cannot run a mission until it has at least one.
                    </div>
                  ) : (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {team.members.map((m) => (
                        <div
                          key={m.id}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 10,
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: `1px solid ${tokens.colors.border}`,
                            background: tokens.colors.surface,
                          }}
                        >
                          <OnlineDot online={m.is_online} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, color: tokens.colors.textPrimary }}>
                              {m.agent_name}
                              {m.role_label && (
                                <span style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.accentSubtle }}>{m.role_label}</span>
                              )}
                              <span style={{ marginLeft: 8, fontSize: 11, color: tokens.colors.textMuted }}>
                                max {m.max_concurrent} concurrent
                              </span>
                            </div>
                            <div style={{ marginTop: 2, fontSize: 11, color: m.capabilities ? tokens.colors.textSecondary : tokens.colors.warningLight, lineHeight: 1.45 }}>
                              {m.capabilities ||
                                'No capability description — the orchestrator has nothing to match work against. Edit this member.'}
                            </div>
                          </div>
                          <MemberEditButton
                            team={team}
                            memberId={m.id}
                            wsId={wsId}
                            initial={{ role_label: m.role_label, capabilities: m.capabilities, max_concurrent: m.max_concurrent }}
                            onSaved={replaceTeam}
                            disabled={!canWrite(team)}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!canWrite(team)}
                            title={canWrite(team) ? undefined : 'Only the workspace that created this global team may edit its roster'}
                            onClick={() => removeMember(team, m.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <TeamFormModal
        isOpen={showForm}
        wsId={wsId}
        agents={agents}
        globalAgents={globalAgents}
        workspaces={workspaces}
        team={editing}
        onClose={() => setShowForm(false)}
        onSaved={(team) => {
          setShowForm(false);
          setTeams((prev) => (prev.some((t) => t.id === team.id) ? prev.map((t) => (t.id === team.id ? team : t)) : [team, ...prev]));
        }}
      />

      <AddMemberModal
        team={memberTarget}
        wsId={wsId}
        agents={memberTarget?.is_global ? globalAgents : agents}
        onClose={() => setMemberTarget(null)}
        onSaved={(team) => {
          setMemberTarget(null);
          replaceTeam(team);
        }}
      />

      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="Delete team?"
        message={`"${deleteTarget?.name}" and its roster will be removed. Missions that already ran keep their history.`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      title={online ? 'online' : 'offline'}
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        marginTop: 5,
        flexShrink: 0,
        background: online ? tokens.colors.successLight : tokens.colors.textMuted,
      }}
    />
  );
}

export function TeamFormModal({
  isOpen,
  wsId,
  agents,
  globalAgents,
  workspaces,
  team,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  wsId: string;
  agents: OrchestrationAssignableAgent[];
  globalAgents: OrchestrationAssignableAgent[];
  workspaces: { id: string; name: string }[];
  team: OrchestrationTeam | null;
  onClose: () => void;
  onSaved: (team: OrchestrationTeam) => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [orchestratorId, setOrchestratorId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [parallel, setParallel] = useState(3);
  const [openMissionsCap, setOpenMissionsCap] = useState(1);
  const [enabled, setEnabled] = useState(true);
  // 스코프는 생성 시점에만 정해진다 — 기존 팀의 workspace_id는 절대 바뀌지 않으므로
  // 이 상태는 새 팀(`!team`) UI에서만 의미가 있다.
  const [isGlobal, setIsGlobal] = useState(false);
  const [allowedWorkspaceIds, setAllowedWorkspaceIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const effectiveGlobal = team ? team.is_global : isGlobal;
  const orchestratorPool = effectiveGlobal ? globalAgents : agents;

  // 편집 모달의 읽기 전용 스코프 표시용 — 생성 Select의 global 옵션 라벨과 문구를 맞춰
  // 완료 조건("생성/편집 표기 통일")을 만족시킨다. workspace 이름 해석에 실패해도
  // "(undefined)" 같은 값이 나오지 않도록 이름이 없으면 접미사를 붙이지 않는다.
  const scopeLabel = (() => {
    if (!team) return null;
    if (team.is_global) return 'Global — visible to every workspace, global agents only';
    const wsName = workspaces.find((w) => w.id === team.workspace_id)?.name;
    return wsName ? `This workspace (${wsName})` : 'This workspace';
  })();

  useEffect(() => {
    if (!isOpen) return;
    setName(team?.name || '');
    setDescription(team?.description || '');
    setPrompt(team?.orchestrator_prompt || '');
    setParallel(team?.max_parallel_steps ?? 3);
    setOpenMissionsCap(team?.max_open_missions ?? 1);
    setEnabled(team?.enabled ?? true);
    setIsGlobal(team?.is_global ?? false);
    setAllowedWorkspaceIds(team?.allowed_workspace_ids ?? []);
  }, [isOpen, team]);

  // 위 effect와 분리한 이유는 후보 POOL이 바뀔 때도(open/team 변경 때뿐 아니라)
  // 다시 실행되어야 하기 때문이다. 두 가지를 모두 커버한다: 모달이 열릴 때 부모의
  // agents/globalAgents fetch가 아직 진행 중인 경우(New team 버튼은 그 로딩 완료를
  // 기다리지 않는다), 그리고 스코프 토글이 새 팀 생성 중 현재 선택값 아래에서 pool을
  // 바꿔버리는 경우. functional update는 현재 선택값이 더 이상 유효하지 않을 때만
  // 교체하므로, 사용자가 의도적으로 고른 값을 덮어쓰는 일은 없다.
  useEffect(() => {
    if (!isOpen) return;
    setOrchestratorId((prev) =>
      orchestratorPool.some((a) => a.id === prev) ? prev : team?.orchestrator_agent_id || orchestratorPool[0]?.id || '',
    );
  }, [isOpen, team, orchestratorPool]);

  const toggleAllowedWorkspace = (id: string) => {
    setAllowedWorkspaceIds((prev) => (prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]));
  };

  const submit = async () => {
    if (!name.trim() || !orchestratorId) {
      showToast('Name and orchestrator are required', 'error');
      return;
    }
    setSaving(true);
    try {
      const saved = team
        ? await api.updateOrchestrationTeam(team.id, {
            workspace_id: wsId,
            name: name.trim(),
            description: description.trim(),
            orchestrator_agent_id: orchestratorId,
            orchestrator_prompt: prompt.trim(),
            max_parallel_steps: parallel,
            max_open_missions: openMissionsCap,
            enabled,
            ...(team.is_global ? { allowed_workspace_ids: allowedWorkspaceIds } : {}),
          })
        : await api.createOrchestrationTeam({
            workspace_id: wsId,
            name: name.trim(),
            description: description.trim(),
            orchestrator_agent_id: orchestratorId,
            orchestrator_prompt: prompt.trim(),
            max_parallel_steps: parallel,
            max_open_missions: openMissionsCap,
            is_global: isGlobal,
            ...(isGlobal ? { allowed_workspace_ids: allowedWorkspaceIds } : {}),
          });
      showToast(team ? 'Team updated' : 'Team created', 'success');
      onSaved(saved);
    } catch (e: any) {
      showToast(e?.message || 'Failed to save team', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={team ? 'Edit team' : 'New team'}
      maxWidth={600}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="Team name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Platform squad" />
        <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        {team ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label
              style={{
                fontSize: tokens.typography.fontSizeXs,
                fontWeight: tokens.typography.fontWeightSemibold,
                color: tokens.colors.textMuted,
                textTransform: 'uppercase',
                display: 'block',
                marginBottom: tokens.spacing.xs,
              }}
            >
              Scope
            </label>
            <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textStrong }}>{scopeLabel}</div>
            <div
              style={{
                fontSize: tokens.typography.fontSizeXs,
                color: tokens.colors.textSecondary,
                marginTop: tokens.spacing.xs,
              }}
            >
              Scope is fixed at creation — create a new team to use a different scope.
            </div>
          </div>
        ) : (
          <Select
            label="Scope"
            options={[
              { value: 'workspace', label: 'This workspace' },
              { value: 'global', label: 'Global — visible to every workspace, global agents only' },
            ]}
            value={isGlobal ? 'global' : 'workspace'}
            onChange={(e) => setIsGlobal(e.target.value === 'global')}
          />
        )}
        <Select
          label="Orchestrator agent (required)"
          options={orchestratorPool.map((a) => ({
            value: a.id,
            label: `${formatAgentDisplayName(a)}${a.is_online ? '' : ' (offline)'}`,
          }))}
          value={orchestratorId}
          onChange={(e) => setOrchestratorId(e.target.value)}
          placeholder={
            orchestratorPool.length
              ? undefined
              : effectiveGlobal
                ? 'No global agents available'
                : 'No assignable agents in this workspace'
          }
        />
        <LabeledTextarea
          label="Standing instructions (optional)"
          hint="Appended to every mission brief for this team — house rules, review policy, tech constraints."
          value={prompt}
          onChange={setPrompt}
          rows={4}
        />
        <Input
          label="Max steps in parallel"
          type="number"
          min={1}
          max={12}
          value={parallel}
          onChange={(e) => setParallel(Number(e.target.value))}
        />
        <Input
          label="Max open self-created missions"
          type="number"
          min={0}
          max={20}
          value={openMissionsCap}
          onChange={(e) => setOpenMissionsCap(Number(e.target.value))}
        />
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: -8 }}>
          How many missions this team&apos;s orchestrator may have open at once per workspace via
          create_orchestration_mission. Set to 0 to forbid the orchestrator from self-creating missions for this
          team entirely.
        </div>
        {effectiveGlobal && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 6 }}>
              Allowed workspaces
            </div>
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 8 }}>
              Which workspace&apos;s run-budget this team&apos;s orchestrator may bill a self-created mission to.
              Empty means the orchestrator cannot create missions at all until a workspace is checked here.
            </div>
            {workspaces.length === 0 ? (
              <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>No workspaces found.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto' }}>
                {workspaces.map((w) => (
                  <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
                    <input
                      type="checkbox"
                      checked={allowedWorkspaceIds.includes(w.id)}
                      onChange={() => toggleAllowedWorkspace(w.id)}
                    />
                    {w.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {team && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled (a disabled team cannot start new missions)
          </label>
        )}
      </div>
    </Modal>
  );
}

function AddMemberModal({
  team,
  wsId,
  agents,
  onClose,
  onSaved,
}: {
  team: OrchestrationTeam | null;
  wsId: string;
  agents: OrchestrationAssignableAgent[];
  onClose: () => void;
  onSaved: (team: OrchestrationTeam) => void;
}) {
  const { showToast } = useToast();
  const [agentId, setAgentId] = useState('');
  const [roleLabel, setRoleLabel] = useState('');
  const [capabilities, setCapabilities] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [saving, setSaving] = useState(false);

  const available = agents.filter((a) => !team?.members.some((m) => m.agent_id === a.id));

  useEffect(() => {
    if (!team) return;
    setAgentId(available[0]?.id || '');
    setRoleLabel('');
    setCapabilities('');
    setMaxConcurrent(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team]);

  const submit = async () => {
    if (!team || !agentId) return;
    setSaving(true);
    try {
      const saved = await api.addOrchestrationTeamMember(team.id, {
        workspace_id: wsId,
        agent_id: agentId,
        role_label: roleLabel.trim(),
        capabilities: capabilities.trim(),
        max_concurrent: maxConcurrent,
      });
      showToast('Member added', 'success');
      onSaved(saved);
    } catch (e: any) {
      showToast(e?.message || 'Failed to add member', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={!!team}
      onClose={onClose}
      title={`Add member to ${team?.name ?? ''}`}
      maxWidth={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={saving} disabled={!agentId}>
            Add
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {available.length === 0 ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
            Every assignable agent in this workspace is already on this team.
          </div>
        ) : (
          <Select
            label="Agent"
            options={available.map((a) => ({ value: a.id, label: `${formatAgentDisplayName(a)}${a.is_online ? '' : ' (offline)'}` }))}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          />
        )}
        <Input
          label="Role label"
          value={roleLabel}
          onChange={(e) => setRoleLabel(e.target.value)}
          placeholder="backend / frontend / reviewer / researcher"
        />
        <LabeledTextarea
          label="Capabilities"
          hint="What this agent is good at, what it has access to, what it should not be given. The orchestrator reads this verbatim when deciding who gets which step."
          value={capabilities}
          onChange={setCapabilities}
          rows={4}
          placeholder="Server-side NestJS + TypeORM. Owns apps/server. Can run migrations locally. Do not assign UI work."
        />
        <Input
          label="Max concurrent steps"
          type="number"
          min={1}
          max={12}
          value={maxConcurrent}
          onChange={(e) => setMaxConcurrent(Number(e.target.value))}
        />
      </div>
    </Modal>
  );
}

function MemberEditButton({
  team,
  memberId,
  wsId,
  initial,
  onSaved,
  disabled,
}: {
  team: OrchestrationTeam;
  memberId: string;
  wsId: string;
  initial: { role_label: string; capabilities: string; max_concurrent: number };
  onSaved: (team: OrchestrationTeam) => void;
  disabled?: boolean;
}) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [roleLabel, setRoleLabel] = useState(initial.role_label);
  const [capabilities, setCapabilities] = useState(initial.capabilities);
  const [maxConcurrent, setMaxConcurrent] = useState(initial.max_concurrent);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRoleLabel(initial.role_label);
    setCapabilities(initial.capabilities);
    setMaxConcurrent(initial.max_concurrent);
  }, [open, initial.role_label, initial.capabilities, initial.max_concurrent]);

  const submit = async () => {
    setSaving(true);
    try {
      const saved = await api.updateOrchestrationTeamMember(team.id, memberId, {
        workspace_id: wsId,
        role_label: roleLabel.trim(),
        capabilities: capabilities.trim(),
        max_concurrent: maxConcurrent,
      });
      onSaved(saved);
      setOpen(false);
    } catch (e: any) {
      showToast(e?.message || 'Failed to update member', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        title={disabled ? 'Only the workspace that created this global team may edit its roster' : undefined}
        onClick={() => setOpen(true)}
      >
        Edit
      </Button>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Edit member"
        maxWidth={560}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} loading={saving}>
              Save
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input label="Role label" value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} />
          <LabeledTextarea
            label="Capabilities"
            hint="Read verbatim by the orchestrator when assigning steps."
            value={capabilities}
            onChange={setCapabilities}
            rows={4}
          />
          <Input
            label="Max concurrent steps"
            type="number"
            min={1}
            max={12}
            value={maxConcurrent}
            onChange={(e) => setMaxConcurrent(Number(e.target.value))}
          />
        </div>
      </Modal>
    </>
  );
}
