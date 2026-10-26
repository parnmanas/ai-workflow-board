import { t as translate, getLocale } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, getActiveAccountId } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { tokens } from '../../tokens';
import type { ChatRoomDetail } from '../../types';
import { formatAgentDisplayName } from '../../utils/agentName';
import { assigneeDisplayName } from '../../tickets/assignee';
import { isRuntimeSpecComplete } from '../../runtime/runtimeSpec';
import { Button, Input, Modal } from '../common';
import RuntimeSpecEditor, { emptyRuntimeSpec, type RuntimeHostChoice, type RuntimeSpecDraft } from '../runtime/RuntimeSpecEditor';
import { loadAddPeopleCandidates } from './utils/participantFlow';
import { cliLabel } from '../../cli/catalog';
import { defaultChatWorkdir, findSameRuntimeAgent, isChatWorkdir, newChatShape } from './utils/chatAgents';

// ─── Participant type for picker ──────────────────────────────────────────────

export interface PickerParticipant {
  id: string;
  name: string;
  type: 'user' | 'agent';
}

/** 방에 넣을 Agent 하나 — 서버 `POST /runtime-specs/validate` 가 정규화한 spec. */
interface ChatAgentEntry {
  key: string;
  spec: Record<string, any>;
}

// ─── NewChatModal ─────────────────────────────────────────────────────────────

export interface NewChatModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (room: ChatRoomDetail | null) => void;
  /** If provided, modal is in "Add People" mode */
  addToRoomId?: string;
  /** Participants already in the room (excluded from picker) */
  existingParticipantIds?: string[];
  /**
   * 이 초대가 DM 을 group 으로 승격시키는가 (티켓 70e62a9d). 되돌릴 수 없는 전이라
   * 확정 전에 알려야 한다 — 별도 confirm 다이얼로그를 띄우지 않고 이 모달 안에서
   * 경고 한 줄과 버튼 라벨로 처리한다(새 레이아웃/새 모달 금지).
   */
  promotesDmToGroup?: boolean;
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: tokens.typography.fontSizeXs,
  fontWeight: 600,
  color: tokens.colors.textMuted,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

const hintStyle: React.CSSProperties = {
  margin: '4px 0 0',
  fontSize: tokens.typography.fontSizeXs,
  color: tokens.colors.textSecondary,
  lineHeight: 1.5,
};

/**
 * 새 채팅 / 사람 추가 — 여러 Agent 와 사람을 한 방에 모은다.
 *
 * Agent 는 목록에서 고르는 대상이 아니라 실행 선언이다(Agent 테이블 없음, P4c-4): Runtime
 * Host + CLI (+ 작업 폴더·모델·credential·label·역할)를 적어 하나씩 추가하고, 서버가
 * 저장 시점에 실행 신원을 매긴다. 작업 폴더를 비우면 그 Host 의 채팅 전용 폴더를 쓴다
 * (chatAgents.defaultChatWorkdir). 사람은 계정 사용자 목록에서 고른다.
 */
export default function NewChatModal({ open, onClose, onCreated, addToRoomId, existingParticipantIds = [], promotesDmToGroup = false }: NewChatModalProps) {
  useLocale();
  const { user: currentUser } = useAuth();
  const accountId = getActiveAccountId() || '';
  const [people, setPeople] = useState<PickerParticipant[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPeople, setSelectedPeople] = useState<PickerParticipant[]>([]);
  const [agents, setAgents] = useState<ChatAgentEntry[]>([]);
  const [hosts, setHosts] = useState<RuntimeHostChoice[]>([]);
  // null = Agent 편집기 닫힘, '' = 새 Agent, 그 외 = 편집 중인 Agent 의 key.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuntimeSpecDraft>(emptyRuntimeSpec());
  const [draftError, setDraftError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setSearchQuery('');
    setSelectedPeople([]);
    setAgents([]);
    setEditingKey(null);
    setDraft(emptyRuntimeSpec());
    setDraftError(null);
    setRoomName('');
    setError(null);

    // 후보 로드(users/agents fetch → 기존 참여자·본인·Agent Manager 제외 → set)는
    // participantFlow.loadAddPeopleCandidates 에 있고, 회귀 테스트가 같은 코드를 구동한다
    // (apps/client/test/chat-participants.test.mjs). 여기선 api·세터만 주입한다.
    // P4c-4: Agent 목록 없음 — 후보는 사용자이고 Agent 는 아래에서 선언한다.
    loadAddPeopleCandidates({
      getUsers: () => api.getUsers(),
      getAgents: async () => [],
      existingParticipantIds,
      currentUserId: currentUser?.id,
      formatAgentName: formatAgentDisplayName,
      setParticipants: setPeople,
    });
    let cancelled = false;
    api.listTemplateHosts()
      .then((rows) => {
        if (!cancelled) setHosts((rows || []).map((h) => ({ id: h.id, name: h.name || h.id.slice(0, 8), chat_workdir_root: h.chat_workdir_root ?? null })));
      })
      .catch(() => { if (!cancelled) setHosts([]); });
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const hostNames = useMemo(() => Object.fromEntries(hosts.map((h) => [h.id, h.name])), [hosts, getLocale()]);
  const agentName = (spec: Record<string, any>) => assigneeDisplayName(spec, hostNames) || translate('Agent');

  const filteredPeople = useMemo(() => {
    if (!searchQuery.trim()) return people;
    const q = searchQuery.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().includes(q));
  }, [people, searchQuery, getLocale()]);

  // 표시 이름이 겹치면 @멘션 후보에서 구별할 수 없다 — 막지는 않고 알린다.
  const duplicateNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of agents) {
      const name = agentName(a.spec);
      seen.set(name, (seen.get(name) || 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
  }, [agents, hostNames, getLocale()]); // eslint-disable-line react-hooks/exhaustive-deps

  function togglePerson(p: PickerParticipant) {
    setSelectedPeople((prev) => (
      prev.some((s) => s.id === p.id) ? prev.filter((s) => s.id !== p.id) : [...prev, p]
    ));
  }

  function openAgentEditor(entry?: ChatAgentEntry) {
    setDraftError(null);
    if (!entry) {
      setDraft(emptyRuntimeSpec());
      setEditingKey('');
      return;
    }
    const base = emptyRuntimeSpec();
    setDraft({
      ...base,
      ...entry.spec,
      model: entry.spec.model ?? null,
      folder_scope: entry.spec.folder_scope || base.folder_scope,
      credential_id: entry.spec.credential_id ?? null,
      cli_runtime_profile: entry.spec.cli_runtime_profile ?? null,
      runtime_config: entry.spec.runtime_config || base.runtime_config,
      label: entry.spec.label || '',
      role_prompt: entry.spec.role_prompt || '',
    });
    setEditingKey(entry.key);
  }

  function closeAgentEditor() {
    setEditingKey(null);
    setDraftError(null);
  }

  async function saveAgent() {
    // 폴더를 비웠으면 그 Host 의 채팅 전용 폴더(<root>/<이름>)를 쓴다. 이름도 비웠으면 CLI 이름을
    // 붙인다 — 그러지 않으면 서버 기본 label(`<폴더 끝>/<cli>`)이 `claude/claude` 가 된다.
    let candidate = draft;
    if (draft.manager_agent_id && draft.cli && !draft.working_dir.trim()) {
      const root = hosts.find((h) => h.id === draft.manager_agent_id)?.chat_workdir_root ?? null;
      const label = (draft.label || '').trim();
      const picked = defaultChatWorkdir(root, label || draft.cli, (dir) => !!findSameRuntimeAgent(agents, { ...draft, working_dir: dir }, editingKey));
      if (!picked) {
        setDraftError(translate('이 Runtime Host 는 채팅 전용 폴더를 알리지 않았습니다(꺼져 있거나 매니저가 오래됨) — 작업 폴더를 직접 입력하세요.'));
        return;
      }
      candidate = {
        ...draft,
        working_dir: picked.dir,
        label: label || (picked.n > 1 ? `${cliLabel(draft.cli)} ${picked.n}` : cliLabel(draft.cli)),
      };
    }
    if (!isRuntimeSpecComplete(candidate)) {
      setDraftError(translate('Runtime Host 와 CLI 를 고르세요. 작업 폴더를 적었다면 Host 절대 경로여야 합니다.'));
      return;
    }
    setResolving(true);
    setDraftError(null);
    try {
      const result = await api.validateRuntimeSpec(accountId, candidate);
      if (!result.ok || !result.spec) throw new Error(result.error || translate('Runtime 설정이 올바르지 않습니다.'));
      const spec = result.spec;
      const same = findSameRuntimeAgent(agents, spec, editingKey);
      if (same) {
        setDraftError(
          translate('‘{0}’와 CLI·작업 폴더·credential 이 같습니다. 같은 실행 신원은 방에서 한 참여자로 합쳐지므로 작업 폴더나 credential 을 다르게 지정하세요.', { 0: agentName(same.spec) }),
        );
        return;
      }
      if (editingKey) {
        setAgents((prev) => prev.map((a) => (a.key === editingKey ? { ...a, spec } : a)));
      } else {
        agentSeq.current += 1;
        setAgents((prev) => [...prev, { key: `agent-${agentSeq.current}`, spec }]);
      }
      setEditingKey(null);
      setError(null);
    } catch (err: any) {
      setDraftError(err?.message || translate('Runtime 설정을 확인하지 못했습니다.'));
    } finally {
      setResolving(false);
    }
  }

  // 작업 폴더 안내 — 고른 Host 가 채팅 전용 폴더를 알렸을 때만 "비워도 된다" 고 말한다.
  const draftRoot = hosts.find((h) => h.id === draft.manager_agent_id)?.chat_workdir_root ?? null;
  const chatFolderHint = !draft.manager_agent_id
    ? translate('비워 두면 그 Host 의 채팅 전용 폴더를 씁니다. 프로젝트 파일을 다룰 Agent 만 폴더를 고르세요.')
    : draftRoot
    ? translate('비워 두면 {0} 아래 전용 폴더를 씁니다. 프로젝트 파일을 다룰 Agent 만 폴더를 고르세요.', { 0: draftRoot })
    // 그 Host 가 지원하지 않으면 폴더는 필수다 — "선택" 표시를 내지 않는다(저장할 때 사유를 알린다).
    : null;

  const isAddMode = !!addToRoomId;
  const shape = newChatShape({ agents: agents.length, people: selectedPeople.length });
  const editorOpen = editingKey !== null;
  const canCreate = shape !== 'empty' && !creating && !editorOpen;

  async function handleCreate() {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      // Agent 는 id 를 비우고 runtime 을 실어 보낸다 — 실행 신원 키는 서버가 매긴다.
      const apiParticipants = [
        ...selectedPeople.map((p) => ({ participant_type: p.type, participant_id: p.id })),
        ...agents.map((a) => ({ participant_type: 'agent', participant_id: '', runtime: a.spec })),
      ];
      if (isAddMode && addToRoomId) {
        await api.addChatRoomParticipants(addToRoomId, apiParticipants);
        onCreated(null); // signal completion (add-people mode)
      } else {
        const room = await api.createChatRoom(apiParticipants, roomName.trim() || undefined);
        onCreated(room);
      }
    } catch (err: any) {
      const msg = err?.message || translate('Failed to create room.');
      if (msg.includes('50') || msg.includes('full') || msg.includes('limit')) {
        setError(translate('This room is full (50 participant limit).'));
      } else {
        setError(msg);
      }
    } finally {
      setCreating(false);
    }
  }

  // 승격 경고는 "Add People" 모드에서 DM 방일 때만 의미가 있다.
  const showPromotionNotice = isAddMode && promotesDmToGroup;
  const title = isAddMode ? translate('Add People') : translate('New Chat');
  const createBtnLabel = isAddMode
    ? (creating ? translate('Adding…') : showPromotionNotice ? translate('Convert to Group & Add') : translate('Add to Room'))
    : shape === 'dm'
    ? (creating ? translate('Creating…') : translate('Start Chat'))
    : (creating ? translate('Creating…') : translate('Create Group'));

  const shapeHint = isAddMode
    ? (shape === 'empty' ? translate('추가할 Agent 나 사람을 고르세요.') : translate('Agent {0} · 사람 {1} 추가', { 0: agents.length, 1: selectedPeople.length }))
    : shape === 'empty'
    ? translate('Agent 를 추가하거나 사람을 고르세요.')
    : shape === 'dm'
    ? (agents.length ? translate('1:1 대화 — 보내는 모든 메시지에 Agent 가 답합니다.') : translate('1:1 대화'))
    : translate('그룹 대화 · Agent {0} · 사람 {1} — Agent 는 @멘션을 받으면 답합니다.', { 0: agents.length, 1: selectedPeople.length });

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={title}
      maxWidth={640}
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm, width: '100%' }}>
          <span data-testid="new-chat-shape" style={{ flex: 1, minWidth: 0, fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textSecondary }}>
            {shapeHint}
          </span>
          <Button variant="secondary" onClick={onClose} disabled={creating}>{translate('Cancel')}</Button>
          <Button variant="primary" onClick={() => void handleCreate()} disabled={!canCreate}>
            {createBtnLabel}
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.lg }}>
        {/* DM → group 승격 경고 (티켓 70e62a9d). 되돌릴 수 없고, 초대받은 사람은
            스크롤하면 이전 대화를 전부 볼 수 있다는 점까지 확정 전에 알린다. */}
        {showPromotionNotice && (
          <div
            data-testid="dm-promotion-notice"
            style={{
              padding: '8px 12px',
              border: `1px solid ${tokens.colors.warning}`,
              borderRadius: tokens.radii.sm,
              color: tokens.colors.warning,
              fontSize: tokens.typography.fontSizeXs,
              lineHeight: 1.5,
            }}
          >
            {translate('이 대화는 1:1 DM 입니다. 사람을 추가하면')} <strong>{translate('그룹 대화로 바뀌며 되돌릴 수 없습니다.')}</strong> {translate('지금까지의 대화 기록은 그대로 남고, 초대된 사람도 스크롤하면 이전 내용을 볼 수 있습니다.')}</div>
        )}

        {!isAddMode && (
          <Input
            label={translate('Room name (optional)')}
            value={roomName}
            disabled={creating}
            placeholder={translate('비워두면 참여자 이름으로 자동 지정')}
            onChange={(e) => setRoomName(e.target.value)}
          />
        )}

        {/* Agents — 실행 선언을 하나씩 추가한다. */}
        <section aria-label={translate('Agents')}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacing.sm }}>
            <span style={sectionTitleStyle}>{translate('Agents ·')} {agents.length}</span>
            <Button variant="secondary" size="sm" onClick={() => openAgentEditor()} disabled={editorOpen || creating}>
              {translate('+ Agent 추가')}</Button>
          </div>
          <p style={hintStyle}>
            {translate('각 Agent 는 Runtime Host 의 CLI 로 이 방에 참여합니다. Label 은 방에서 보이는 이름이자 @멘션 대상입니다.')}</p>

          {agents.length === 0 && !editorOpen && (
            <div style={{ marginTop: tokens.spacing.sm, padding: '12px', border: `1px dashed ${tokens.colors.border}`, borderRadius: tokens.radii.md, fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted, textAlign: 'center' }}>
              {translate('아직 추가한 Agent 가 없습니다.')}</div>
          )}

          {agents.length > 0 && (
            <ul style={{ listStyle: 'none', margin: `${tokens.spacing.sm}px 0 0`, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacing.xs }}>
              {agents.map((a) => {
                const name = agentName(a.spec);
                const root = hosts.find((h) => h.id === a.spec.manager_agent_id)?.chat_workdir_root;
                const folder = isChatWorkdir(a.spec.working_dir, root) ? translate('채팅 전용 폴더') : a.spec.working_dir;
                const meta = [a.spec.cli, a.spec.model || translate('CLI 기본 모델'), folder].filter(Boolean).join(' · ');
                const isEditing = editingKey === a.key;
                return (
                  <li
                    key={a.key}
                    data-testid="new-chat-agent"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing.sm,
                      padding: '8px 12px',
                      border: `1px solid ${isEditing ? tokens.colors.accent : tokens.colors.border}`,
                      borderRadius: tokens.radii.md,
                      background: tokens.colors.surface,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: tokens.typography.fontSizeMd, fontWeight: 600, color: tokens.colors.textPrimary, overflowWrap: 'anywhere' }}>{name}</div>
                      <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textSecondary, overflowWrap: 'anywhere' }}>{meta}</div>
                      {a.spec.role_prompt && (
                        <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {translate('역할:')} {a.spec.role_prompt}
                        </div>
                      )}
                      {duplicateNames.has(name) && (
                        <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.warning }}>
                          {translate('같은 이름의 Agent 가 있습니다 — Label 로 구분하세요.')}</div>
                      )}
                    </div>
                    <Button variant="ghost" size="sm" disabled={editorOpen || creating} onClick={() => openAgentEditor(a)}>{translate('편집')}</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={editorOpen || creating}
                      aria-label={translate('Remove {0}', { 0: name })}
                      onClick={() => setAgents((prev) => prev.filter((x) => x.key !== a.key))}
                    >
                      {translate('제거')}</Button>
                  </li>
                );
              })}
            </ul>
          )}

          {editorOpen && (
            <div
              data-testid="new-chat-agent-editor"
              style={{ marginTop: tokens.spacing.sm, padding: tokens.spacing.md, border: `1px solid ${tokens.colors.accent}`, borderRadius: tokens.radii.md }}
            >
              <div style={{ ...sectionTitleStyle, marginBottom: tokens.spacing.sm }}>
                {editingKey ? translate('Agent 편집') : translate('새 Agent')}
              </div>
              {!hosts.length && (
                <p style={{ ...hintStyle, marginTop: 0, marginBottom: tokens.spacing.sm }}>
                  {translate('연결된 Runtime Host 가 없습니다. Hosts 에서 Agent Manager 를 먼저 연결하세요.')}</p>
              )}
              <RuntimeSpecEditor
                value={draft}
                onChange={(next) => { setDraft(next); setDraftError(null); }}
                hosts={hosts}
                accountId={accountId}
                folderOptionalHint={chatFolderHint}
                disabled={resolving}
              />
              {draftError && (
                <div role="alert" style={{ marginTop: tokens.spacing.sm, fontSize: tokens.typography.fontSizeXs, color: tokens.colors.danger, lineHeight: 1.5 }}>
                  {draftError}
                </div>
              )}
              <div style={{ marginTop: tokens.spacing.md, display: 'flex', justifyContent: 'flex-end', gap: tokens.spacing.sm }}>
                <Button variant="ghost" size="sm" onClick={closeAgentEditor} disabled={resolving}>{translate('취소')}</Button>
                <Button variant="primary" size="sm" onClick={() => void saveAgent()} disabled={resolving}>
                  {resolving ? translate('확인 중…') : editingKey ? translate('변경 저장') : translate('Agent 추가')}
                </Button>
              </div>
            </div>
          )}
        </section>

        {/* People — 계정 사용자 중에서 고른다. */}
        <section aria-label={translate('People')}>
          <span style={sectionTitleStyle}>{translate('People ·')} {selectedPeople.length}</span>

          {selectedPeople.length > 0 && (
            <div style={{ marginTop: tokens.spacing.sm, display: 'flex', flexWrap: 'wrap', gap: tokens.spacing.xs }}>
              {selectedPeople.map((p) => (
                <span
                  key={p.id}
                  style={{
                    background: tokens.colors.accent,
                    color: 'white',
                    borderRadius: tokens.radii.xl,
                    padding: '4px 8px',
                    fontSize: tokens.typography.fontSizeXs,
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: tokens.spacing.xs,
                  }}
                >
                  {p.name}
                  <button
                    onClick={() => togglePerson(p)}
                    style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}
                    aria-label={translate('Remove {0}', { 0: p.name })}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <input
            type="text"
            aria-label={translate('Search people')}
            placeholder={translate('Search people…')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              marginTop: tokens.spacing.sm,
              width: '100%',
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '8px 12px',
              fontSize: tokens.typography.fontSizeMd,
              color: tokens.colors.textPrimary,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />

          <div style={{ marginTop: tokens.spacing.xs, overflowY: 'auto', maxHeight: 220, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md }}>
            {filteredPeople.length === 0 ? (
              <div style={{ padding: 16, fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textMuted, textAlign: 'center' }}>
                {people.length ? translate('No matches. Try a different name.') : translate('추가할 수 있는 사람이 없습니다.')}
              </div>
            ) : (
              filteredPeople.map((p) => {
                const isSelected = selectedPeople.some((s) => s.id === p.id);
                const initials = p.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
                return (
                  <label
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing.sm,
                      padding: '0 12px',
                      height: 40,
                      cursor: 'pointer',
                      background: isSelected ? tokens.overlays.accentFaint : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => togglePerson(p)}
                      style={{ accentColor: tokens.colors.accent, width: 14, height: 14, flexShrink: 0 }}
                    />
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: tokens.radii.full,
                        background: tokens.colors.border,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: tokens.typography.fontSizeXs,
                        fontWeight: 600,
                        color: tokens.colors.textPrimary,
                        flexShrink: 0,
                      }}
                    >
                      {initials}
                    </div>
                    <span style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textPrimary, flex: 1 }}>{p.name}</span>
                  </label>
                );
              })
            )}
          </div>
        </section>

        {error && (
          <div
            role="alert"
            style={{
              padding: '8px 12px',
              border: `1px solid ${tokens.colors.danger}`,
              borderRadius: tokens.radii.sm,
              color: tokens.colors.danger,
              fontSize: tokens.typography.fontSizeMd,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
