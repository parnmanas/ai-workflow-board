import { useAuth } from '../../contexts/AuthContext';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import type {
  Action,
  ClaudeBackendProfile,
  Credential,
  OrchestrationFolderScope,
  OrchestrationMissionDetail,
  OrchestrationMissionExtraMemberInput,
  OrchestrationMissionListItem,
  OrchestrationConfirmPolicy,
  OrchestrationUserChatMode,
  OrchestrationPostActionCondition,
  OrchestrationRuntimeHost,
  OrchestrationTeam,
  OrchestrationUpdateEvent,
  Project,
} from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, EmptyState, Input, Modal, Select } from '../common';
import { relativeTime, shortDuration } from '../../utils/time';
import { missionStyle, progressPercent } from './status';
import { MISSIONS_CHANGED_EVENT } from '../workNavigation';
import DirectoryPicker from '../admin/DirectoryPicker';
import { notifyProjectsChanged, useProjects } from '../../projects/useProjects';
import {
  addMissionProject,
  makePrimaryProject,
  missionStartProblems,
  slotCoverage,
  type CoverageSlot,
  type MissionProjectDraft,
} from './missionProjects.logic';
import TeamSlotRuntimeFields, {
  emptySlotDraft,
  slotDraftFromRuntime,
  slotDraftProblem,
  slotDraftToSpec,
  type SlotDraft,
} from './TeamSlotRuntimeFields';

/**
 * Mission list — the landing surface of Orchestration mode.
 *
 * Live updates come from the `orchestration_update` SSE frame, which carries
 * status + counts, so an active mission's row animates without polling. The
 * frame is a headline only: anything richer (the plan, the timeline) lives in
 * the detail view, which refetches on the same signal.
 */
export default function OrchestrationPage() {
  const { currentAccountId } = useAuth();
  const accountId = currentAccountId || '';
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [missions, setMissions] = useState<OrchestrationMissionListItem[]>([]);
  const [teams, setTeams] = useState<OrchestrationTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'active'>('all');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [missionList, teamList] = await Promise.all([
        api.listOrchestrationMissions(accountId),
        api.listOrchestrationTeams(accountId).catch(() => [] as OrchestrationTeam[]),
      ]);
      setMissions(missionList);
      setTeams(teamList);
    } catch (e: any) {
      showToast(e?.message || 'Failed to load missions', 'error');
    } finally {
      setLoading(false);
    }
  }, [accountId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  // Patch the affected row in place rather than refetching the whole list — a
  // busy mission emits an update per step transition and a full reload per
  // frame would thrash the list while the user is reading it.
  useBoardStreamEvent('orchestration_update', (data: OrchestrationUpdateEvent) => {
    if (!data) return;
    // 삭제된 미션은 제자리 패치가 아니라 목록에서 빼야 한다 — 아래 분기는
    // "아는 미션이면 패치"라서, 그대로 두면 사라진 미션이 행으로 남는다.
    if (data.deleted) {
      setMissions((prev) => prev.filter((m) => m.id !== data.mission_id));
      return;
    }
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
      {/* 진행 중 step 점의 맥박. MissionDetailPage 와 같은 이름/정의를 쓴다 — 여기에
          없으면 목록 카드의 점만 조용히 정적으로 굳는다(애니메이션은 실패해도 조용하다). */}
      <PageHeader
        title="Missions"
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

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {loading ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading missions...</div>
        ) : teams.length === 0 ? (
          <EmptyState
            title="No teams yet"
            description="A mission runs on a team: one orchestrator agent that plans, plus the members it delegates to. Create a team first."
            action={<Button variant="primary" onClick={() => navigate(`/teams`)}>Create a team</Button>}
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
                onOpen={() => navigate(`/missions/${mission.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      <MissionFormModal
        isOpen={showCreate}
        accountId={accountId}
        teams={teams}
        mission={null}
        onClose={() => setShowCreate(false)}
        onSaved={(mission) => {
          setShowCreate(false);
          navigate(`/missions/${mission.id}`);
        }}
      />
    </div>
  );
}

/**
 * 목록의 미션 카드 한 줄. `export` 인 이유는 테스트가 라우터/컨텍스트 전체를 세우지
 * 않고 카드 렌더 계약(진행 중 step 줄 포함)을 직접 단언하기 때문이다.
 */
export function MissionRow({
  mission,
  onOpen,
}: {
  mission: OrchestrationMissionListItem;
  onOpen: () => void;
}) {
  const style = missionStyle(mission.status);
  const pct = progressPercent(mission.counts);
  // 구 서버 응답(필드 없음)에서는 조용히 빈 목록 — 카드가 깨지지 않는다.
  const liveSteps = mission.live_steps ?? [];

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
      <div className="awb-mission-heading" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
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

      <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, fontSize: 11, color: tokens.colors.textSecondary }}>
        <span>
          Team <strong style={{ color: tokens.colors.textStrong }}>{mission.team_name}</strong>
        </span>
        {mission.orchestrator_name && <span>Orchestrator {mission.orchestrator_name}</span>}
        {mission.plan_version > 0 && <span>Plan v{mission.plan_version}</span>}
        <span style={{ marginLeft: 'auto' }}>
          {mission.counts.done}/{mission.counts.total} steps
          {mission.counts.inFlight > 0 && ` · ${mission.counts.inFlight} working`}
          {/* 목록에서도 보여야 한다 — 이 미션은 사람이 열어서 답하기 전에는 절대
              스스로 진행되지 않으므로, 카드가 조용한 것과 구분되지 않으면 방치된다. */}
          {mission.counts.awaitingUser > 0 && (
            <span style={{ color: tokens.colors.warningLight }}>
              {` · ${mission.counts.awaitingUser} needs your decision`}
            </span>
          )}
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

      {/*
        "몇 개가 돌고 있다"만으로는 목록에서 이 미션이 살아 있는지 알 수 없다 — 카운트는
        step 이 죽어서 lease 만 남아 있어도 똑같이 N working 으로 보인다(2026-09-25
        EmberDelve). 무엇이 돌고 있고 마지막 신호가 언제인지까지 여기서 읽히게 한다.
        CLI 활동 텍스트는 싣지 않는다 — 목록에서 미션마다 step 방을 훑는 비용을 지지
        않기로 했고, 그 깊이는 상세 화면의 몫이다.
      */}
      {liveSteps.length > 0 && (
        <div
          data-testid="mission-live-steps"
          style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          {liveSteps.map((s) => {
            const quietFor = s.last_signal_at ? Date.now() - new Date(s.last_signal_at).getTime() : null;
            return (
              <div
                key={s.id}
                style={{ display: 'flex', gap: 8, fontSize: 11, color: tokens.colors.textSecondary, minWidth: 0 }}
              >
                <span
                  aria-hidden="true"
                  className="awb-activity-live"
                  style={{
                    width: 5,
                    height: 5,
                    marginTop: 5,
                    flexShrink: 0,
                    borderRadius: '50%',
                    background: tokens.colors.infoLight,
                  }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                {quietFor !== null && (
                  <span
                    style={{ marginLeft: 'auto', flexShrink: 0, color: tokens.colors.textMuted }}
                    title="이 step 의 마지막 생존 신호 이후 경과 시간 (에이전트의 진행 보고 기준)"
                  >
                    quiet {shortDuration(quietFor)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </button>
  );
}

/**
 * Mission 생성/편집 모달 — `mission`이 null이면 생성, 그렇지 않으면 그 draft
 * 미션의 편집(TeamFormModal이 팀에 대해 쓰는 것과 동일한 단일-컴포넌트
 * create/edit 패턴). 편집은 서버 `updateMission`이 draft 상태에서만 브리핑
 * 필드 편집을 허용하므로 draft 미션에서만 열린다(MissionDetailPage 참고).
 */
export function MissionFormModal({
  isOpen,
  accountId,
  teams,
  mission,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  accountId: string;
  teams: OrchestrationTeam[];
  mission: OrchestrationMissionDetail | null;
  onClose: () => void;
  onSaved: (mission: OrchestrationMissionDetail) => void;
}) {
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [teamId, setTeamId] = useState('');
  const [objective, setObjective] = useState('');
  const [context, setContext] = useState('');
  const [criteria, setCriteria] = useState('');
  const [startNow, setStartNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [method, setMethod] = useState('');
  const [workspaceFolder, setWorkspaceFolder] = useState('');
  const [checkoutMode, setCheckoutMode] = useState<'reuse' | 'fresh'>('reuse');
  const [completionCriteria, setCompletionCriteria] = useState<Array<{ key: string; description: string }>>([]);
  const [postActions, setPostActions] = useState<
    Array<{ action_id: string; order: number; condition: OrchestrationPostActionCondition }>
  >([]);
  const [graphEnabled, setGraphEnabled] = useState(false);
  const [confirmPolicy, setConfirmPolicy] = useState<OrchestrationConfirmPolicy>('auto');
  const [userChatMode, setUserChatMode] = useState<OrchestrationUserChatMode>('open');
  // 미션이 다루는 project 들(첫 항목이 primary) — 멤버는 각 project 의 **자기 Host** 폴더에서
  // 일한다. 팀은 폴더를 모른다(여러 미션에 재사용되므로).
  const [projectDrafts, setProjectDrafts] = useState<MissionProjectDraft[]>([]);
  const [folderScope, setFolderScope] = useState<OrchestrationFolderScope>('shared');
  const [actions, setActions] = useState<Action[]>([]);
  // ── 미션별 로스터 오버라이드 ──────────────────────────────────────────
  // 팀을 고른 뒤 이번 미션에서만 빼고 쓸 멤버(excludedIds)와 임시로 얹을
  // 멤버(extraMembers)다. 팀 로스터 자체는 건드리지 않으므로 다음 미션에
  // 영향을 주지 않는다 — usage limit 에 걸린 모델 슬롯을 빼고 돌리는 용도다.
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [extraMembers, setExtraMembers] = useState<OrchestrationMissionExtraMemberInput[]>([]);
  const [showAdHocForm, setShowAdHocForm] = useState(false);
  const [adHocDraft, setAdHocDraft] = useState<SlotDraft>(emptySlotDraft);
  const [adHocRole, setAdHocRole] = useState('');
  const [adHocCapabilities, setAdHocCapabilities] = useState('');
  const [adHocMaxConcurrent, setAdHocMaxConcurrent] = useState(1);
  const [hosts, setHosts] = useState<OrchestrationRuntimeHost[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [backendProfiles, setBackendProfiles] = useState<ClaudeBackendProfile[]>([]);
  const [hostsLoading, setHostsLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    api.listActions(accountId).then(setActions).catch(() => setActions([]));
    setTitle(mission?.title || '');
    setObjective(mission?.objective || '');
    setContext(mission?.context || '');
    setCriteria(mission?.acceptance_criteria || '');
    setStartNow(true);
    setShowAdvanced(!!mission && (!!mission.method || mission.completion_criteria.length > 0 || mission.post_actions.length > 0 || !!mission.graph_enabled));
    setMethod(mission?.method || '');
    setWorkspaceFolder(mission?.workspace_folder || '');
    setCheckoutMode(mission?.checkout_mode || 'reuse');
    setGraphEnabled(!!mission?.graph_enabled);
    setConfirmPolicy(mission?.confirm_policy || 'auto');
    setUserChatMode(mission?.user_chat_mode || 'open');
    setCompletionCriteria((mission?.completion_criteria || []).map((c) => ({ key: c.key, description: c.description })));
    setPostActions((mission?.post_actions || []).map((p) => ({ action_id: p.action_id, order: p.order, condition: p.condition })));
    setProjectDrafts((mission?.projects ?? []).map((p) => ({ project_id: p.project_id, branch: p.branch || '' })));
    setFolderScope(mission?.folder_scope || 'shared');
    setTeamId(mission?.team_id || teams.find((t) => t.enabled && t.members.length > 0)?.id || teams[0]?.id || '');
    // 편집(draft) 모드에서는 저장된 오버라이드를 복원하고, 생성 모드에서는 빈 값으로 시작한다.
    setExcludedIds(mission?.excluded_member_ids ?? []);
    setExtraMembers(
      (mission?.extra_members ?? []).map((e) => ({
        runtime: { ...e.spec },
        role_label: e.role_label,
        capabilities: e.capabilities,
        max_concurrent: e.max_concurrent,
      })),
    );
    setShowAdHocForm(false);
    setAdHocDraft(emptySlotDraft());
    setAdHocRole('');
    setAdHocCapabilities('');
    setAdHocMaxConcurrent(1);
  }, [isOpen, mission, teams, accountId]);

  const selectedTeam = teams.find((t) => t.id === teamId) || null;

  // 미션은 계정 소유 팀이면 그 팀의 계정에 귀속되고(서버 account-access), project 는 미션
  // 계정 소유여야 한다 — 그래서 고를 수 있는 project 목록도 그 계정의 것이다. 이미 있는
  // 미션(draft 편집)은 자기 계정이 정해져 있다(글로벌 팀 미션은 primary project 의 계정).
  const projectAccountId = mission?.account_id || selectedTeam?.account_id || accountId;
  const { projects: listedProjects, loading: projectsLoading, error: projectsError } = useProjects(projectAccountId);
  // GET /api/projects 는 인자와 무관하게 접근 가능한 모든 계정의 project 를 합쳐 준다 — 미션 계정 것만
  // 남긴다(다른 계정의 project 는 서버가 "not found in this mission's account" 로 거부한다).
  const accountProjects = useMemo(
    () => listedProjects.filter((p) => p.account_id === projectAccountId),
    [listedProjects, projectAccountId],
  );

  // 팀이 바뀌면 제외 목록에서 더 이상 그 팀에 없는 id 는 걷어낸다 — 다른 팀의
  // 제외를 들고 있으면 제출 때 서버가 400 으로 거부한다. 임시 멤버는 팀과
  // 무관하므로 유지한다.
  const handleTeamChange = useCallback((nextTeamId: string) => {
    setTeamId(nextTeamId);
  }, []);

  useEffect(() => {
    if (!selectedTeam) return;
    setExcludedIds((prev) => {
      const valid = new Set(selectedTeam.members.map((m) => m.id));
      const pruned = prev.filter((id) => valid.has(id));
      return pruned.length === prev.length ? prev : pruned;
    });
  }, [selectedTeam]);

  // 다른 계정의 팀으로 바꾸면 그 계정에 없는 project 는 고를 수 없다 — 목록이 도착한 뒤에만
  // 걷어낸다(로딩 중이나 조회 실패 중에 비우면 편집 중인 draft 의 선택이 사라진다).
  useEffect(() => {
    if (projectsLoading || projectsError) return;
    setProjectDrafts((prev) => {
      const known = new Set(accountProjects.map((p) => p.id));
      const kept = prev.filter((p) => known.has(p.project_id));
      return kept.length === prev.length ? prev : kept;
    });
  }, [accountProjects, projectsLoading, projectsError]);

  // 누가 어느 project 를 맡을 수 있는가 — 서버의 resolveMissionRoster 와 같은 규칙으로,
  // 시작하기 전에 폼에서 보여 주고 막는다.
  const coverageSlots = useMemo(() => {
    const members: CoverageSlot[] = (selectedTeam?.members ?? [])
      .filter((m) => !excludedIds.includes(m.id) && m.runtime)
      .map((m) => ({ key: m.id, label: m.agent_name, host_ids: [m.runtime!.manager_agent_id] }));
    extraMembers.forEach((e, i) => {
      members.push({
        key: `extra:${i}`,
        label: e.role_label || e.runtime.cli,
        host_ids: [e.runtime.manager_agent_id],
      });
    });
    const orchestrator: CoverageSlot | null = selectedTeam?.orchestrator_runtime
      ? {
          key: 'orchestrator',
          label: selectedTeam.orchestrator_name || 'orchestrator',
          host_ids: [selectedTeam.orchestrator_runtime.manager_agent_id],
        }
      : null;
    return { orchestrator, members };
  }, [selectedTeam, excludedIds, extraMembers]);
  const startProblems = useMemo(
    () => missionStartProblems({ projects: accountProjects, selected: projectDrafts, ...coverageSlots }),
    [accountProjects, projectDrafts, coverageSlots],
  );

  // 폼 안에서 바로 "이 Host 의 이 project 폴더" 를 등록한다 — 등록은 Projects 화면과 같은
  // API 이고, 그 Host 의 모든 멤버에게 함께 적용된다.
  const [folderTarget, setFolderTarget] = useState<{ project: Project; hostId: string } | null>(null);
  const registerFolder = async (path: string) => {
    const target = folderTarget;
    setFolderTarget(null);
    if (!target) return;
    try {
      await api.setProjectHostFolder(target.project.id, target.hostId, path);
      notifyProjectsChanged();
      showToast(`${target.project.name}: folder set on this host`, 'success');
    } catch (e: any) {
      showToast(e?.message || 'Failed to set the project folder', 'error');
    }
  };

  // 임시 멤버 폼을 열 때만 호스트·인증 정보를 가져온다 — 미션 모달을 열 때마다
  // 무겁게 들고 있지 않기 위함이다. 팀 편집 화면과 같은 피드다.
  const ensureHostsLoaded = useCallback(async () => {
    if (hosts.length > 0 || hostsLoading) return;
    setHostsLoading(true);
    try {
      const [hostList, credentialList, profileList] = await Promise.all([
        api.listOrchestrationRuntimeHosts(accountId).catch(() => [] as OrchestrationRuntimeHost[]),
        api.listCredentials(accountId, { includeAllScopes: true }).catch(() => [] as Credential[]),
        api.listClaudeBackendProfiles().then((r) => r.profiles).catch(() => [] as ClaudeBackendProfile[]),
      ]);
      setHosts(hostList);
      setCredentials(credentialList);
      setBackendProfiles(profileList);
    } finally {
      setHostsLoading(false);
    }
  }, [hosts.length, hostsLoading, accountId]);

  const includedCount = (selectedTeam?.members.filter((m) => !excludedIds.includes(m.id)).length ?? 0) + extraMembers.length;

  const submit = async () => {
    if (!title.trim() || !objective.trim() || !teamId) {
      showToast('Title, objective and team are required', 'error');
      return;
    }
    if (selectedTeam && selectedTeam.members.length > 0 && includedCount === 0) {
      showToast('All members are excluded — include at least one member or add an ad-hoc member', 'error');
      return;
    }
    // 시작까지 하는 생성만 막는다 — draft 저장은 project 를 나중에 채워도 된다.
    if (!mission && startNow && startProblems.length > 0) {
      showToast(startProblems[0], 'error');
      return;
    }
    const cleanCriteria = completionCriteria
      .map((c) => ({ key: c.key.trim(), description: c.description.trim() }))
      .filter((c) => c.key && c.description);
    // "+ Add"는 order를 그 시점의 postActions.length로, "Remove"는 재번호 없이
    // 그 자리만 뺀다 — 추가/삭제를 반복하면 order가 중복되거나 건너뛸 수 있다.
    // order는 이제 post-action의 상관관계 키(orchestration:<mission>:<order>)
    // 일부라 유일성이 실제로 중요하므로(리뷰 지적 반영, 티켓 2dc3c62f), 제출
    // 직전에 최종 배열 순서 그대로 0..N-1로 다시 매긴다.
    const cleanPostActions = postActions.filter((p) => p.action_id).map((p, idx) => ({ ...p, order: idx }));
    const projects = projectDrafts.map((p) => ({ project_id: p.project_id, ...(p.branch.trim() ? { branch: p.branch.trim() } : {}) }));
    setSaving(true);
    try {
      const saved = mission
        ? await api.updateOrchestrationMission(mission.id, {
            account_id: accountId,
            title: title.trim(),
            objective: objective.trim(),
            context: context.trim(),
            acceptance_criteria: criteria.trim(),
            method: method.trim(),
            completion_criteria: cleanCriteria,
            post_actions: cleanPostActions,
            projects,
            folder_scope: folderScope,
            workspace_folder: workspaceFolder.trim(),
            checkout_mode: checkoutMode,
            graph_enabled: graphEnabled,
            confirm_policy: confirmPolicy,
            user_chat_mode: userChatMode,
            excluded_member_ids: excludedIds,
            extra_members: extraMembers,
          })
        : await api.createOrchestrationMission({
            account_id: accountId,
            team_id: teamId,
            title: title.trim(),
            objective: objective.trim(),
            context: context.trim(),
            acceptance_criteria: criteria.trim(),
            method: method.trim(),
            completion_criteria: cleanCriteria.length ? cleanCriteria : undefined,
            post_actions: cleanPostActions.length ? cleanPostActions : undefined,
            projects,
            folder_scope: folderScope,
            workspace_folder: workspaceFolder.trim(),
            checkout_mode: checkoutMode,
            graph_enabled: graphEnabled,
            confirm_policy: confirmPolicy,
            user_chat_mode: userChatMode,
            excluded_member_ids: excludedIds.length ? excludedIds : undefined,
            extra_members: extraMembers.length ? extraMembers : undefined,
            start: startNow,
          });
      if (!mission && saved.start_error) {
        showToast(`Mission created but not started: ${saved.start_error}`, 'error');
      } else {
        showToast(mission ? 'Mission updated' : startNow ? 'Mission briefed to the orchestrator' : 'Mission saved as a draft', 'success');
      }
      // 사이드바 WORK > Orchestrations 서브메뉴가 같은 목록을 그린다(티켓 03ca8b5b).
      // 생성/이름변경 모두 이 한 곳을 지나므로 여기서 방송한다.
      window.dispatchEvent(new CustomEvent(MISSIONS_CHANGED_EVENT));
      onSaved(saved);
    } catch (e: any) {
      showToast(e?.message || 'Failed to save mission', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mission ? 'Edit mission' : 'New mission'}
      maxWidth={640}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={saving}>
            {mission ? 'Save' : startNow ? 'Create & brief orchestrator' : 'Save draft'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ship the billing export" />

        <Select
          label="Team"
          disabled={!!mission}
          options={teams.map((t) => ({
            value: t.id,
            label:
              `${t.name} — ${t.orchestrator_name || 'no orchestrator'} + ${t.members.length} member(s)` +
              (t.enabled ? '' : ' (disabled)'),
          }))}
          value={teamId}
          onChange={(e) => handleTeamChange(e.target.value)}
        />
        {selectedTeam && selectedTeam.members.length === 0 && extraMembers.length === 0 && (
          <div style={{ fontSize: 11, color: tokens.colors.warningLight }}>
            This team has no members — add an ad-hoc member below so the orchestrator has somebody to delegate to.
          </div>
        )}

        <MissionProjectsSection
          projects={accountProjects}
          loading={projectsLoading}
          selected={projectDrafts}
          onChange={setProjectDrafts}
          folderScope={folderScope}
          onFolderScopeChange={setFolderScope}
          workspaceFolder={workspaceFolder}
          onWorkspaceFolderChange={setWorkspaceFolder}
          checkoutMode={checkoutMode}
          onCheckoutModeChange={setCheckoutMode}
        />

        {selectedTeam && (
          <MissionRosterAdjust
            team={selectedTeam}
            projects={accountProjects}
            selectedProjects={projectDrafts}
            coverage={coverageSlots}
            onSetFolder={(project, hostId) => setFolderTarget({ project, hostId })}
            excludedIds={excludedIds}
            onToggleExclude={(memberId, exclude) =>
              setExcludedIds((prev) => (exclude ? [...prev, memberId] : prev.filter((id) => id !== memberId)))
            }
            extraMembers={extraMembers}
            onRemoveExtra={(idx) => setExtraMembers((prev) => prev.filter((_, i) => i !== idx))}
            showAdHocForm={showAdHocForm}
            onToggleAdHocForm={() => {
              if (!showAdHocForm) {
                void ensureHostsLoaded();
                if (selectedTeam.orchestrator_runtime) {
                  setAdHocDraft(slotDraftFromRuntime(selectedTeam.orchestrator_runtime));
                }
              }
              setShowAdHocForm((v) => !v);
            }}
            hosts={hosts}
            hostsLoading={hostsLoading}
            credentials={credentials}
            backendProfiles={backendProfiles}
            adHocDraft={adHocDraft}
            onAdHocDraftChange={setAdHocDraft}
            adHocRole={adHocRole}
            onAdHocRoleChange={setAdHocRole}
            adHocCapabilities={adHocCapabilities}
            onAdHocCapabilitiesChange={setAdHocCapabilities}
            adHocMaxConcurrent={adHocMaxConcurrent}
            onAdHocMaxConcurrentChange={setAdHocMaxConcurrent}
            onAddAdHoc={() => {
              const problem = slotDraftProblem(adHocDraft);
              if (problem) {
                showToast(problem, 'error');
                return;
              }
              setExtraMembers((prev) => [
                ...prev,
                {
                  runtime: slotDraftToSpec(adHocDraft),
                  role_label: adHocRole.trim(),
                  capabilities: adHocCapabilities.trim(),
                  max_concurrent: adHocMaxConcurrent,
                },
              ]);
              setShowAdHocForm(false);
              setAdHocDraft(emptySlotDraft());
              setAdHocRole('');
              setAdHocCapabilities('');
              setAdHocMaxConcurrent(1);
            }}
          />
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

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          style={{
            alignSelf: 'flex-start',
            border: 'none',
            background: 'transparent',
            color: tokens.colors.accentSubtle,
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'inherit',
            padding: 0,
          }}
        >
          {showAdvanced ? '▾' : '▸'} Advanced — execution contract
        </button>

        {showAdvanced && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingLeft: 4, borderLeft: `2px solid ${tokens.colors.border}` }}>
            <LabeledTextarea
              label="Method (optional)"
              hint="How the team should approach it — constraints, non-negotiables, preferred approach. Separate from the objective (what)."
              value={method}
              onChange={setMethod}
              rows={2}
            />

            {/* 실행 그래프 + 사용자 확인(티켓 5dbe4aa2).
                두 컨트롤을 반드시 **함께** 노출한다: confirm 노드는 graph 모드에서만
                만들 수 있으므로, 정책만 내놓으면 골라도 아무 일도 일어나지 않는
                죽은 컨트롤이 된다. */}
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
                <input
                  type="checkbox"
                  checked={graphEnabled}
                  onChange={(e) => setGraphEnabled(e.target.checked)}
                />
                Execution graph — let the orchestrator use conditional branches, join policies and bounded loops
              </label>
              <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.4 }}>
                Off (default) runs the plain dependency plan. Required for user confirmation gates.
              </div>
            </div>

            <div>
              <Select
                label="User confirmation"
                options={[
                  { value: 'none', label: 'None — never ask, run straight through' },
                  { value: 'auto', label: 'Auto — the orchestrator decides where a person should look' },
                  { value: 'key_steps', label: 'Key steps — before each deliverable and anything outward-facing' },
                  { value: 'every_step', label: 'Every step — ask after each reviewable result' },
                ]}
                value={confirmPolicy}
                onChange={(e) => setConfirmPolicy(e.target.value as OrchestrationConfirmPolicy)}
              />
              <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.4 }}>
                {graphEnabled
                  ? 'The mission pauses at each gate until you answer Pass or Fail in the mission page. It does not time out.'
                  : 'Turn on the execution graph above for this to have any effect — confirmation gates only exist in graph mode.'}
              </div>
            </div>

            {/*
              미션 대화의 chat 옵션(티켓 9cfd8161). confirm 정책 바로 아래에 둔 이유는
              둘 다 "사람이 이 미션에 얼마나 개입하는가" 축이기 때문이다 — confirm 은
              미션이 사람에게 묻는 쪽, 이건 사람이 미션에게 말하는 쪽이다.

              여기서 바꾼 값은 draft 에만 적용된다. 이미 시작된 미션은 Mission 화면의
              Conversation 섹션에서 바로 바꾼다 — 이 모달의 Edit 버튼 자체가 draft 에서만
              뜨고, 실행 중 변경이 이 옵션의 요구사항이기 때문이다.
            */}
            <div>
              <Select
                label="User chat"
                options={[
                  { value: 'open', label: 'Open — any operator here can join the conversation and speak' },
                  { value: 'participants_only', label: 'Participants only — only people added to the room can speak' },
                  { value: 'off', label: 'Off — read-only, nobody can send messages' },
                ]}
                value={userChatMode}
                onChange={(e) => setUserChatMode(e.target.value as OrchestrationUserChatMode)}
              />
              <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.4 }}>
                Controls who can talk to the orchestrator in the mission conversation. Reading the transcript
                is always allowed. Speaking also requires the Manage Actions permission — this option does not
                grant it. You can change this later while the mission runs.
              </div>
            </div>
            <div>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 4 }}>
                Structured completion criteria (optional)
              </span>
              <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6, lineHeight: 1.4 }}>
                On top of the acceptance-criteria prose above — when set, the mission cannot be marked "completed"
                until the orchestrator has flipped every one of these to met.
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {completionCriteria.map((c, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={c.key}
                      placeholder="key, e.g. tests-pass"
                      onChange={(e) => {
                        const next = [...completionCriteria];
                        next[i] = { ...next[i], key: e.target.value };
                        setCompletionCriteria(next);
                      }}
                      style={{ width: 140, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                    />
                    <input
                      value={c.description}
                      placeholder="Description — how it's verified"
                      onChange={(e) => {
                        const next = [...completionCriteria];
                        next[i] = { ...next[i], description: e.target.value };
                        setCompletionCriteria(next);
                      }}
                      style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                    />
                    <Button variant="ghost" size="sm" onClick={() => setCompletionCriteria(completionCriteria.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setCompletionCriteria([...completionCriteria, { key: '', description: '' }])}
                >
                  + Add criterion
                </Button>
              </div>
            </div>
            <div>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 4 }}>
                Post-completion actions (optional)
              </span>
              <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6, lineHeight: 1.4 }}>
                Actions to dispatch once the mission ends. Fire-and-forget — a dispatch failure is recorded but never
                changes the mission's own outcome.
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {postActions.map((p, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6 }}>
                    <select
                      value={p.action_id}
                      onChange={(e) => {
                        const next = [...postActions];
                        next[i] = { ...next[i], action_id: e.target.value };
                        setPostActions(next);
                      }}
                      style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                    >
                      <option value="">Select an action…</option>
                      {actions.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={p.condition}
                      onChange={(e) => {
                        const next = [...postActions];
                        next[i] = { ...next[i], condition: e.target.value as OrchestrationPostActionCondition };
                        setPostActions(next);
                      }}
                      style={{ width: 130, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                    >
                      <option value="always">always</option>
                      <option value="on_success">on_success</option>
                      <option value="on_failure">on_failure</option>
                    </select>
                    <Button variant="ghost" size="sm" onClick={() => setPostActions(postActions.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPostActions([...postActions, { action_id: '', order: postActions.length, condition: 'always' }])}
                >
                  + Add post-action
                </Button>
              </div>
            </div>
          </div>
        )}

        {!mission && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
            <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
            Brief the orchestrator immediately
          </label>
        )}
        {!mission && startNow && startProblems.length > 0 && (
          <div data-testid="mission-start-problems" style={{ fontSize: 11, color: tokens.colors.warningLight, lineHeight: 1.5 }}>
            {startProblems.map((p) => <div key={p}>{p}</div>)}
          </div>
        )}
      </div>
      <DirectoryPicker
        isOpen={!!folderTarget}
        onClose={() => setFolderTarget(null)}
        managerAgentId={folderTarget?.hostId ?? ''}
        onPick={(path) => void registerFolder(path)}
      />
    </Modal>
  );
}

/**
 * 미션이 다루는 project 들과 폴더 범위.
 *
 * 팀은 폴더를 모른다 — 여러 미션에 재사용되기 때문이다. 대신 미션이 project 를 고르고,
 * 멤버는 각 project 의 **자기 Host** 폴더(Projects → host folders)에서 일한다. 첫 project 가
 * primary 다(오케스트레이터는 자기 Host 에 폴더가 있는 첫 project 에서 돈다).
 */
function MissionProjectsSection({
  projects,
  loading,
  selected,
  onChange,
  folderScope,
  onFolderScopeChange,
  workspaceFolder,
  onWorkspaceFolderChange,
  checkoutMode,
  onCheckoutModeChange,
}: {
  projects: Project[];
  loading: boolean;
  selected: MissionProjectDraft[];
  onChange(next: MissionProjectDraft[]): void;
  folderScope: OrchestrationFolderScope;
  onFolderScopeChange(next: OrchestrationFolderScope): void;
  workspaceFolder: string;
  onWorkspaceFolderChange(next: string): void;
  checkoutMode: 'reuse' | 'fresh';
  onCheckoutModeChange(next: 'reuse' | 'fresh'): void;
}) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const addable = projects.filter((p) => !selected.some((s) => s.project_id === p.id));
  return (
    <div
      data-testid="mission-projects"
      style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong }}>Projects</span>
        <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, lineHeight: 1.4 }}>
          Where this mission works. Each member works in a project&apos;s folder on its own host; the orchestrator
          assigns every step to one project. The first one is the primary.
        </span>
      </div>
      {selected.length === 0 && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>
          {loading ? 'Loading projects…' : projects.length === 0
            ? 'This account has no projects yet — create one on the Projects page first.'
            : 'No project selected.'}
        </div>
      )}
      {selected.map((p, i) => {
        const project = byId.get(p.project_id);
        return (
          <div key={p.project_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', color: tokens.colors.textStrong }}>
                {project?.name ?? p.project_id}
                {i === 0 && <span style={{ color: tokens.colors.textMuted }}> · primary</span>}
              </span>
              {project?.repo_url && (
                <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted }}>{project.repo_url}</span>
              )}
            </span>
            <input
              aria-label={`Branch for ${project?.name ?? p.project_id}`}
              value={p.branch}
              placeholder={project?.default_branch ? `branch (${project.default_branch})` : 'branch (default)'}
              onChange={(e) => onChange(selected.map((x) => (x.project_id === p.project_id ? { ...x, branch: e.target.value } : x)))}
              style={{ width: 150, padding: '6px 8px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
            />
            {i > 0 && (
              <Button variant="ghost" size="sm" onClick={() => onChange(makePrimaryProject(selected, p.project_id))}>
                Make primary
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => onChange(selected.filter((x) => x.project_id !== p.project_id))}>
              Remove
            </Button>
          </div>
        );
      })}
      {addable.length > 0 && (
        <Select
          aria-label="Add a project"
          value=""
          options={[
            { value: '', label: selected.length ? '+ Add another project' : 'Select a project' },
            ...addable.map((p) => ({ value: p.id, label: p.repo_url ? `${p.name} · ${p.repo_url}` : p.name })),
          ]}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(addMissionProject(selected, e.target.value))}
        />
      )}
      <Select
        label="Folders"
        value={folderScope}
        options={[
          { value: 'shared', label: 'Shared — steps run directly in the project folder' },
          { value: 'isolated', label: 'Isolated — each step gets its own checkout' },
        ]}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onFolderScopeChange(e.target.value as OrchestrationFolderScope)}
      />
      {folderScope === 'shared' ? (
        <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.4 }}>
          Members on one host share the project&apos;s checkout and can hand files to each other. Nothing is cloned
          or wiped — the folder must already hold the checkout. Another shared mission already working in the same
          folder blocks this one from starting.
        </span>
      ) : (
        <>
          <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.4 }}>
            Each step gets a fresh <code>.awb/orch/&lt;mission&gt;/&lt;step&gt;</code> checkout of its project under the
            project folder. Steps cannot see each other&apos;s files — results travel through reports and artifacts.
          </span>
          <Input
            label="Checkout root (optional)"
            value={workspaceFolder}
            onChange={(e) => onWorkspaceFolderChange(e.target.value)}
            placeholder=".awb/orch/<mission id> (default)"
          />
          <Select
            label="Checkout mode"
            options={[
              { value: 'reuse', label: 'Reuse — fetch + fast-forward before each step' },
              { value: 'fresh', label: 'Fresh — wipe + re-checkout before each step' },
            ]}
            value={checkoutMode}
            onChange={(e) => onCheckoutModeChange(e.target.value as 'reuse' | 'fresh')}
          />
        </>
      )}
    </div>
  );
}

/**
 * 한 슬롯이 고른 project 들 중 무엇을 맡을 수 있는가 — 그 Host 에 폴더가 있으면 그 경로를,
 * 없으면 그 자리에서 등록하는 버튼을 보여 준다. 등록은 그 Host 의 모든 멤버에게 함께 적용된다.
 */
function SlotProjectFolders({
  projects,
  selectedProjects,
  slot,
  onSetFolder,
}: {
  projects: Project[];
  selectedProjects: MissionProjectDraft[];
  slot: CoverageSlot;
  onSetFolder(project: Project, hostId: string): void;
}) {
  if (selectedProjects.length === 0) return null;
  const coverage = slotCoverage(projects, selectedProjects, slot);
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
      {coverage.folders.map((f) => {
        const project = projects.find((p) => p.id === f.project_id);
        const name = project?.name ?? f.project_id;
        return f.folder ? (
          <span key={f.project_id} style={{ fontSize: 11, color: tokens.colors.textMuted }}>
            ✓ {name} — <code style={{ fontSize: 10 }}>{f.folder}</code>
          </span>
        ) : (
          <span key={f.project_id} style={{ fontSize: 11, color: tokens.colors.textMuted, display: 'flex', alignItems: 'center', gap: 6 }}>
            ✗ {name} — no folder on this host
            {project && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  onSetFolder(project, slot.host_ids[0]);
                }}
                style={{ border: 'none', background: 'transparent', color: tokens.colors.accentSubtle, cursor: 'pointer', fontSize: 11, padding: 0, fontFamily: 'inherit' }}
              >
                Set folder…
              </button>
            )}
          </span>
        );
      })}
      {!coverage.workable && (
        <span style={{ fontSize: 11, color: tokens.colors.warningLight }}>
          Cannot work on any selected project — set a folder, or leave this member out.
        </span>
      )}
    </span>
  );
}

/**
 * 팀을 고른 뒤 이번 미션에서만 쓸 멤버를 정하는 섹션.
 *
 * 새 팀을 만들지 않고 usage limit 에 걸린 모델 슬롯을 빼거나 임시 멤버를 얹는
 * 입구다. 팀 로스터 자체는 건드리지 않으므로 다음 미션에 영향을 주지 않는다.
 * 체크 해제 = 이번 미션에서 제외, 임시 멤버 = 팀에 없는 슬롯을 이번에만 추가.
 * 멤버마다 고른 project 의 폴더가 그 Host 에 있는지 함께 보여 준다.
 */
function MissionRosterAdjust({
  team,
  projects,
  selectedProjects,
  coverage,
  onSetFolder,
  excludedIds,
  onToggleExclude,
  extraMembers,
  onRemoveExtra,
  showAdHocForm,
  onToggleAdHocForm,
  hosts,
  hostsLoading,
  credentials,
  backendProfiles,
  adHocDraft,
  onAdHocDraftChange,
  adHocRole,
  onAdHocRoleChange,
  adHocCapabilities,
  onAdHocCapabilitiesChange,
  adHocMaxConcurrent,
  onAdHocMaxConcurrentChange,
  onAddAdHoc,
}: {
  team: OrchestrationTeam;
  projects: Project[];
  selectedProjects: MissionProjectDraft[];
  coverage: { orchestrator: CoverageSlot | null; members: CoverageSlot[] };
  onSetFolder(project: Project, hostId: string): void;
  excludedIds: string[];
  onToggleExclude(memberId: string, exclude: boolean): void;
  extraMembers: OrchestrationMissionExtraMemberInput[];
  onRemoveExtra(idx: number): void;
  showAdHocForm: boolean;
  onToggleAdHocForm(): void;
  hosts: OrchestrationRuntimeHost[];
  hostsLoading: boolean;
  credentials: Credential[];
  backendProfiles: ClaudeBackendProfile[];
  adHocDraft: SlotDraft;
  onAdHocDraftChange(next: SlotDraft): void;
  adHocRole: string;
  onAdHocRoleChange(v: string): void;
  adHocCapabilities: string;
  onAdHocCapabilitiesChange(v: string): void;
  adHocMaxConcurrent: number;
  onAdHocMaxConcurrentChange(v: number): void;
  onAddAdHoc(): void;
}) {
  const included = team.members.filter((m) => !excludedIds.includes(m.id));
  const adHocProblem = showAdHocForm ? slotDraftProblem(adHocDraft) : null;
  const slotFor = (key: string) => coverage.members.find((c) => c.key === key) ?? null;
  return (
    <div
      style={{
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong }}>
          Members for this mission — {included.length + extraMembers.length} of {team.members.length + extraMembers.length} participating
        </span>
        <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, lineHeight: 1.4 }}>
          Uncheck a member to exclude it from this mission only (e.g. a model on usage limit).
          The team itself is unchanged — the next mission still sees everybody.
        </span>
      </div>
      {coverage.orchestrator && (
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>
          <span style={{ display: 'block', color: tokens.colors.textStrong }}>
            {coverage.orchestrator.label} <span style={{ color: tokens.colors.textMuted }}>· orchestrator</span>
          </span>
          <SlotProjectFolders projects={projects} selectedProjects={selectedProjects} slot={coverage.orchestrator} onSetFolder={onSetFolder} />
        </div>
      )}
      {team.members.length === 0 && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>
          No team members to choose from.
        </div>
      )}
      {team.members.map((m) => {
        const excluded = excludedIds.includes(m.id);
        const rt = m.runtime;
        const detail = [
          m.role_label || rt?.cli || m.agent_type,
          rt?.model || '',
        ].filter(Boolean).join(' · ');
        const slot = slotFor(m.id);
        return (
          <label
            key={m.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 12,
              color: excluded ? tokens.colors.textMuted : tokens.colors.textSecondary,
              cursor: 'pointer',
              opacity: excluded ? 0.65 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={!excluded}
              onChange={(e) => onToggleExclude(m.id, !e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', color: tokens.colors.textStrong, textDecoration: excluded ? 'line-through' : 'none' }}>
                {m.agent_name}
                {!m.is_online && <span style={{ color: tokens.colors.textMuted }}> (offline)</span>}
              </span>
              {detail && (
                <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted }}>{detail}</span>
              )}
              {!excluded && slot && (
                <SlotProjectFolders projects={projects} selectedProjects={selectedProjects} slot={slot} onSetFolder={onSetFolder} />
              )}
            </span>
          </label>
        );
      })}
      {extraMembers.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.textStrong }}>
            Ad-hoc members for this mission ({extraMembers.length})
          </span>
          {extraMembers.map((e, i) => {
            const slot = slotFor(`extra:${i}`);
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: tokens.colors.textSecondary,
                  border: `1px dashed ${tokens.colors.border}`,
                  borderRadius: 6,
                  padding: '6px 8px',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', color: tokens.colors.textStrong }}>
                    {e.role_label || e.runtime.cli}{e.runtime.model ? ` · ${e.runtime.model}` : ''}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted }}>
                    {e.runtime.cli} · {hosts.find((h) => h.manager_agent_id === e.runtime.manager_agent_id)?.manager_name ?? e.runtime.manager_agent_id}
                  </span>
                  {slot && (
                    <SlotProjectFolders projects={projects} selectedProjects={selectedProjects} slot={slot} onSetFolder={onSetFolder} />
                  )}
                </span>
                <Button variant="ghost" size="sm" onClick={() => onRemoveExtra(i)}>
                  Remove
                </Button>
              </div>
            );
          })}
        </div>
      )}
      {!showAdHocForm ? (
        <Button variant="secondary" size="sm" onClick={onToggleAdHocForm}>
          + Add ad-hoc member for this mission
        </Button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10 }}>
          <span style={{ fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.4 }}>
            A slot used only by this mission — it is not added to the team.
            Seed from the orchestrator; usually only the model needs changing.
          </span>
          <Input
            label="Role label"
            value={adHocRole}
            onChange={(e) => onAdHocRoleChange(e.target.value)}
            placeholder="backend / reviewer / researcher"
          />
          <LabeledTextarea
            label="Capabilities"
            hint="The orchestrator reads this verbatim when deciding who gets which step."
            value={adHocCapabilities}
            onChange={onAdHocCapabilitiesChange}
            rows={2}
          />
          <Input
            label="Max concurrent steps"
            type="number"
            min={1}
            max={12}
            value={adHocMaxConcurrent}
            onChange={(e) => onAdHocMaxConcurrentChange(Number(e.target.value))}
          />
          {hostsLoading ? (
            <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>Loading Runtime Hosts…</div>
          ) : (
            <TeamSlotRuntimeFields
              value={adHocDraft}
              onChange={onAdHocDraftChange}
              hosts={hosts}
              credentials={credentials}
              backendProfiles={backendProfiles}
            />
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={onToggleAdHocForm}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={onAddAdHoc} disabled={!!adHocProblem}>
              Add to this mission
            </Button>
          </div>
          {adHocProblem && (
            <div style={{ fontSize: 11, color: tokens.colors.warningLight }}>{adHocProblem}</div>
          )}
        </div>
      )}
    </div>
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
