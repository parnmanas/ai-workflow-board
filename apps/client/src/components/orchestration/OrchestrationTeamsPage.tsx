import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import type {
  ClaudeBackendProfile,
  Credential,
  OrchestrationRuntimeHost,
  OrchestrationSlotRuntime,
  OrchestrationTeam,
  OrchestrationTeamMember,
} from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, ConfirmDialog, EmptyState, Input, Modal, Select } from '../common';
import { LabeledTextarea } from './OrchestrationPage';
import { TEAMS_CHANGED_EVENT } from '../workNavigation';
import TeamSlotRuntimeFields, {
  emptySlotDraft,
  slotDraftFromRuntime,
  slotDraftProblem,
  slotDraftToSpec,
  type SlotDraft,
  type SlotNeighbour,
} from './TeamSlotRuntimeFields';

/**
 * Team roster management.
 *
 * A roster slot is declared as **Runtime Host + CLI + model + working folder**
 * (see TeamSlotRuntimeFields) rather than picked from a list of Agents someone
 * created first. That is the whole point of this screen: a team spanning three
 * machines is built here, in one pass, and AWB provisions the agent identities
 * behind it. Slots on one host that name the same folder share a working tree —
 * which is how members hand work to each other and reuse one checkout.
 *
 * The orchestrator is a required, first-class field rather than "a member with
 * a special role_label": the mission state machine addresses it directly and
 * the whole feature is undefined without one, so the UI refuses to create a
 * team until one is configured.
 *
 * `capabilities` gets the most visual weight of any member field because it is
 * the text the orchestrator actually reasons over when assigning work — a team
 * whose members have empty capability blurbs produces noticeably worse plans.
 */
/**
 * 사이드바 WORK > Teams 서브메뉴가 같은 목록을 그린다(티켓 03ca8b5b). 보드가
 * `boards-changed` 로 하는 것과 같은 방식으로 팀 목록 변경을 방송해, 이 페이지에서
 * 만들고 지운 팀이 사이드바에 즉시 반영되게 한다.
 */
function broadcastTeamsChanged() {
  window.dispatchEvent(new CustomEvent(TEAMS_CHANGED_EVENT));
}

export default function OrchestrationTeamsPage() {
  const { wsId = '' } = useParams<{ wsId: string }>();
  const { showToast } = useToast();

  const [teams, setTeams] = useState<OrchestrationTeam[]>([]);
  // Slot pickers are fed by machines, not by agents: Runtime Hosts with the CLIs
  // they have installed, the models they enumerated, and the working folders
  // already in use on them. Credentials / backend profiles are the optional
  // per-slot auth knobs the same form offers.
  const [hosts, setHosts] = useState<OrchestrationRuntimeHost[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [backendProfiles, setBackendProfiles] = useState<ClaudeBackendProfile[]>([]);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<OrchestrationTeam | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OrchestrationTeam | null>(null);
  const [memberTarget, setMemberTarget] = useState<OrchestrationTeam | null>(null);
  // 사이드바 서브메뉴에서 팀을 고르면 `?team=<id>` 로 들어온다 — 해당 카드를
  // 강조하고 화면 안으로 스크롤해 "선택 → 상세" 흐름을 잇는다.
  const [searchParams] = useSearchParams();
  const selectedTeamId = searchParams.get('team');
  const selectedCardRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true);
    try {
      const [teamList, hostList, credentialList, profileList, workspaceList] = await Promise.all([
        api.listOrchestrationTeams(wsId),
        api.listOrchestrationRuntimeHosts(wsId).catch(() => [] as OrchestrationRuntimeHost[]),
        api.listCredentials(wsId, { includeAllScopes: true }).catch(() => [] as Credential[]),
        api.listClaudeBackendProfiles().then((r) => r.profiles).catch(() => [] as ClaudeBackendProfile[]),
        api.getWorkspaces().catch(() => [] as any[]),
      ]);
      setTeams(teamList);
      setHosts(hostList);
      setCredentials(credentialList);
      setBackendProfiles(profileList);
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

  useEffect(() => {
    if (!selectedTeamId || loading) return;
    selectedCardRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedTeamId, loading, teams.length]);

  // 목록을 바꾸는 경로는 전부 이 헬퍼를 거친다 — 사이드바가 변경을 놓치지 않도록
  // 상태 갱신과 방송을 한곳에서 처리한다(단순 조회인 load()는 제외).
  const commitTeams = useCallback((updater: (prev: OrchestrationTeam[]) => OrchestrationTeam[]) => {
    setTeams(updater);
    broadcastTeamsChanged();
  }, []);

  const replaceTeam = useCallback(
    (team: OrchestrationTeam) => commitTeams((prev) => prev.map((t) => (t.id === team.id ? team : t))),
    [commitTeams],
  );

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
      commitTeams((prev) => prev.filter((t) => t.id !== deleteTarget.id));
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
        title="Teams"
        description="One orchestrator agent that plans and delegates, plus the members that execute. Missions run on teams."
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
            {teams.map((team) => {
              const selected = team.id === selectedTeamId;
              return (
              <div
                key={team.id}
                ref={selected ? selectedCardRef : undefined}
                data-team-id={team.id}
                aria-current={selected ? 'true' : undefined}
                style={{
                  border: `1px solid ${selected ? tokens.colors.accent : tokens.colors.border}`,
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
                  <div style={{ marginTop: 3, fontSize: 13, color: tokens.colors.textPrimary, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <OnlineDot online={team.orchestrator_online} />
                    {team.orchestrator_name || '(agent missing)'}
                    <RuntimeChip runtime={team.orchestrator_runtime} />
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
                            <div style={{ marginTop: 4 }}>
                              <RuntimeChip runtime={m.runtime} />
                            </div>
                            <div style={{ marginTop: 2, fontSize: 11, color: m.capabilities ? tokens.colors.textSecondary : tokens.colors.warningLight, lineHeight: 1.45 }}>
                              {m.capabilities ||
                                'No capability description — the orchestrator has nothing to match work against. Edit this member.'}
                            </div>
                          </div>
                          <MemberEditButton
                            team={team}
                            member={m}
                            wsId={wsId}
                            hosts={hosts}
                            credentials={credentials}
                            backendProfiles={backendProfiles}
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
              );
            })}
          </div>
        )}
      </div>

      <TeamFormModal
        isOpen={showForm}
        wsId={wsId}
        hosts={hosts}
        credentials={credentials}
        backendProfiles={backendProfiles}
        workspaces={workspaces}
        team={editing}
        onClose={() => setShowForm(false)}
        onSaved={(team) => {
          setShowForm(false);
          commitTeams((prev) => (prev.some((t) => t.id === team.id) ? prev.map((t) => (t.id === team.id ? team : t)) : [team, ...prev]));
        }}
      />

      <AddMemberModal
        team={memberTarget}
        wsId={wsId}
        hosts={hosts}
        credentials={credentials}
        backendProfiles={backendProfiles}
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

/**
 * One-line summary of where a slot runs. Shown on every roster row because
 * "which machine / folder is this member on" is now the defining fact about a
 * member — with several hosts in play, two rows are otherwise indistinguishable.
 */
function RuntimeChip({ runtime }: { runtime: OrchestrationSlotRuntime | null }) {
  if (!runtime) {
    return (
      <span style={{ fontSize: 11, color: tokens.colors.warningLight }}>
        No runtime recorded — open Edit and save to set the host, CLI and working folder.
      </span>
    );
  }
  const shared = runtime.folder_scope === 'shared';
  return (
    <span style={{ fontSize: 11, color: tokens.colors.textMuted, display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      <span title={runtime.manager_online ? 'Runtime Host online' : 'Runtime Host offline'}>
        {runtime.manager_online ? '🟢' : '⚪'} {runtime.manager_name}
      </span>
      <span>·</span>
      <span>{runtime.cli}{runtime.model ? ` (${runtime.model})` : ''}</span>
      <span>·</span>
      <code style={{ fontSize: 10, color: tokens.colors.textSecondary }}>{runtime.working_dir}</code>
      <span style={{ color: shared ? tokens.colors.accentLight : tokens.colors.textMuted }}>
        {shared
          ? runtime.shared_with.length
            ? `· shared with ${runtime.shared_with.join(', ')}`
            : '· works in this folder directly'
          : '· isolated per-step folder'}
      </span>
    </span>
  );
}

/** Every OTHER slot on a team, for the folder-sharing hints in the slot form. */
function neighboursOf(team: OrchestrationTeam | null, exclude?: { memberId?: string; orchestrator?: boolean }): SlotNeighbour[] {
  if (!team) return [];
  const out: SlotNeighbour[] = [];
  if (!exclude?.orchestrator && team.orchestrator_runtime) {
    out.push({
      label: team.orchestrator_name || 'orchestrator',
      manager_agent_id: team.orchestrator_runtime.manager_agent_id,
      working_dir: team.orchestrator_runtime.working_dir,
      folder_scope: team.orchestrator_runtime.folder_scope,
    });
  }
  for (const m of team.members) {
    if (exclude?.memberId === m.id || !m.runtime) continue;
    out.push({
      label: m.agent_name || m.role_label || 'member',
      manager_agent_id: m.runtime.manager_agent_id,
      working_dir: m.runtime.working_dir,
      folder_scope: m.runtime.folder_scope,
    });
  }
  return out;
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
  hosts,
  credentials,
  backendProfiles,
  workspaces,
  team,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  wsId: string;
  hosts: OrchestrationRuntimeHost[];
  credentials: Credential[];
  backendProfiles: ClaudeBackendProfile[];
  workspaces: { id: string; name: string }[];
  team: OrchestrationTeam | null;
  onClose: () => void;
  onSaved: (team: OrchestrationTeam) => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [orchestrator, setOrchestrator] = useState<SlotDraft>(emptySlotDraft);
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
  const orchestratorProblem = slotDraftProblem(orchestrator);

  // 편집 모달의 읽기 전용 스코프 표시용 — 생성 Select의 global 옵션 라벨과 문구를 맞춰
  // 완료 조건("생성/편집 표기 통일")을 만족시킨다. workspace 이름 해석에 실패해도
  // "(undefined)" 같은 값이 나오지 않도록 이름이 없으면 접미사를 붙이지 않는다.
  const scopeLabel = (() => {
    if (!team) return null;
    if (team.is_global) return 'Global — visible to every workspace';
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
    setOrchestrator(slotDraftFromRuntime(team?.orchestrator_runtime ?? null));
  }, [isOpen, team]);

  const toggleAllowedWorkspace = (id: string) => {
    setAllowedWorkspaceIds((prev) => (prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]));
  };

  const submit = async () => {
    if (!name.trim()) {
      showToast('Team name is required', 'error');
      return;
    }
    if (orchestratorProblem) {
      showToast(orchestratorProblem, 'error');
      return;
    }
    setSaving(true);
    try {
      const saved = team
        ? await api.updateOrchestrationTeam(team.id, {
            workspace_id: wsId,
            name: name.trim(),
            description: description.trim(),
            orchestrator: slotDraftToSpec(orchestrator),
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
            orchestrator: slotDraftToSpec(orchestrator),
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
              { value: 'global', label: 'Global — visible to every workspace' },
            ]}
            value={isGlobal ? 'global' : 'workspace'}
            onChange={(e) => setIsGlobal(e.target.value === 'global')}
          />
        )}
        <SlotSection
          title="Orchestrator"
          subtitle="The agent that plans the mission and delegates its steps. It is created from this configuration — you do not have to make an agent first."
          problem={orchestratorProblem}
        >
          <TeamSlotRuntimeFields
            value={orchestrator}
            onChange={setOrchestrator}
            hosts={hosts}
            credentials={credentials}
            backendProfiles={backendProfiles}
            neighbours={neighboursOf(team, { orchestrator: true })}
          />
        </SlotSection>
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

/**
 * Visual grouping for a slot's runtime form, with the "what is still missing"
 * line rendered next to the fields instead of only on a failed submit — the
 * form has enough inputs that a toast alone leaves the operator hunting.
 */
function SlotSection({
  title,
  subtitle,
  problem,
  children,
}: {
  title: string;
  subtitle: string;
  problem: string | null;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.textPrimary }}>{title}</div>
        <div style={{ marginTop: 2, fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>{subtitle}</div>
      </div>
      {children}
      {problem && <div style={{ fontSize: 11, color: tokens.colors.warningLight }}>{problem}</div>}
    </div>
  );
}

function AddMemberModal({
  team,
  wsId,
  hosts,
  credentials,
  backendProfiles,
  onClose,
  onSaved,
}: {
  team: OrchestrationTeam | null;
  wsId: string;
  hosts: OrchestrationRuntimeHost[];
  credentials: Credential[];
  backendProfiles: ClaudeBackendProfile[];
  onClose: () => void;
  onSaved: (team: OrchestrationTeam) => void;
}) {
  const { showToast } = useToast();
  const [draft, setDraft] = useState<SlotDraft>(emptySlotDraft);
  const [roleLabel, setRoleLabel] = useState('');
  const [capabilities, setCapabilities] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  // Put the orchestrator itself on the roster instead of adding a new worker.
  // A slot mints an identity, so re-entering the orchestrator's own settings
  // would give you a second agent that merely looks like it — this is the only
  // way to express "the planner also runs a step".
  const [asOrchestrator, setAsOrchestrator] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!team) return;
    // Seed from the orchestrator's slot: on a single-machine team that is
    // almost always right, and on a multi-machine one it still puts a valid host
    // and CLI in the form so only the folder has to change.
    setDraft(team.orchestrator_runtime ? slotDraftFromRuntime(team.orchestrator_runtime) : emptySlotDraft());
    setRoleLabel('');
    setCapabilities('');
    setMaxConcurrent(1);
    setAsOrchestrator(false);
  }, [team]);

  const problem = asOrchestrator ? null : slotDraftProblem(draft);

  const submit = async () => {
    if (!team) return;
    if (problem) {
      showToast(problem, 'error');
      return;
    }
    setSaving(true);
    try {
      const saved = await api.addOrchestrationTeamMember(team.id, {
        workspace_id: wsId,
        ...(asOrchestrator ? { as_orchestrator: true } : { runtime: slotDraftToSpec(draft) }),
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
      maxWidth={620}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={saving} disabled={!!problem}>
            Add
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input
          label="Role label"
          value={roleLabel}
          onChange={(e) => setRoleLabel(e.target.value)}
          placeholder="backend / frontend / reviewer / researcher"
        />
        <LabeledTextarea
          label="Capabilities"
          hint="What this member is good at, what it has access to, what it should not be given. The orchestrator reads this verbatim when deciding who gets which step."
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
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
          <input
            type="checkbox"
            checked={asOrchestrator}
            onChange={(e) => setAsOrchestrator(e.target.checked)}
            disabled={!team?.orchestrator_agent_id}
          />
          <span>
            This member is the orchestrator itself
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, lineHeight: 1.5 }}>
              Lets the agent that plans the mission also execute steps, on its own runtime. Re-entering its
              settings below would create a second, separate agent instead.
            </div>
          </span>
        </label>
        {!asOrchestrator && (
          <SlotSection
            title="Runtime"
            subtitle="Which machine, CLI, model and folder this member runs on. Point two members at the same folder on the same host to let them work in one tree."
            problem={problem}
          >
            <TeamSlotRuntimeFields
              value={draft}
              onChange={setDraft}
              hosts={hosts}
              credentials={credentials}
              backendProfiles={backendProfiles}
              neighbours={neighboursOf(team)}
            />
          </SlotSection>
        )}
      </div>
    </Modal>
  );
}

function MemberEditButton({
  team,
  member,
  wsId,
  hosts,
  credentials,
  backendProfiles,
  onSaved,
  disabled,
}: {
  team: OrchestrationTeam;
  member: OrchestrationTeamMember;
  wsId: string;
  hosts: OrchestrationRuntimeHost[];
  credentials: Credential[];
  backendProfiles: ClaudeBackendProfile[];
  onSaved: (team: OrchestrationTeam) => void;
  disabled?: boolean;
}) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [roleLabel, setRoleLabel] = useState(member.role_label);
  const [capabilities, setCapabilities] = useState(member.capabilities);
  const [maxConcurrent, setMaxConcurrent] = useState(member.max_concurrent);
  const [draft, setDraft] = useState<SlotDraft>(emptySlotDraft);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRoleLabel(member.role_label);
    setCapabilities(member.capabilities);
    setMaxConcurrent(member.max_concurrent);
    setDraft(slotDraftFromRuntime(member.runtime));
  }, [open, member]);

  const isOrchestratorRow = member.agent_id === team.orchestrator_agent_id;
  const problem = isOrchestratorRow ? null : slotDraftProblem(draft);

  const submit = async () => {
    if (problem) {
      showToast(problem, 'error');
      return;
    }
    setSaving(true);
    try {
      const saved = await api.updateOrchestrationTeamMember(team.id, member.id, {
        workspace_id: wsId,
        ...(isOrchestratorRow ? {} : { runtime: slotDraftToSpec(draft) }),
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
        maxWidth={620}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} loading={saving} disabled={!!problem}>
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
          {isOrchestratorRow ? (
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
              This member is the team&apos;s orchestrator. Its runtime is edited on the team itself — the server
              rejects a runtime change from here, because applying one would split it into a second agent that
              merely looked like the orchestrator.
            </div>
          ) : (
            <SlotSection
              title="Runtime"
              subtitle="Changing the machine gives this member a new identity on that host; changing the folder or model edits the one it already has."
              problem={problem}
            >
              <TeamSlotRuntimeFields
                value={draft}
                onChange={setDraft}
                hosts={hosts}
                credentials={credentials}
                backendProfiles={backendProfiles}
                neighbours={neighboursOf(team, { memberId: member.id })}
              />
            </SlotSection>
          )}
        </div>
      </Modal>
    </>
  );
}
