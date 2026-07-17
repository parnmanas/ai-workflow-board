import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { api } from '../api';
import { tokens } from '../tokens';
import {
  resolveAssistant,
  findAssistantDmRoomId,
  type AssistantResolution,
} from './chat/assistantEntry';

/**
 * Chat-first 랜딩 (에픽 bf65ca00 · Phase 1 · S2 어시스턴트 진입점).
 *
 * 기본(Chat-first) 모드의 진입 화면. workspace 의 `assistant_agent_id`(관리자 지정)를
 * 해석해, 지정된 AWB 어시스턴트 에이전트와의 DM 프리셋으로 연결한다(기존 chat-rooms DM
 * auto-route 재사용 — 멘션 없이 어시스턴트가 응답). 대화·티켓 카드·Artifact 패널은 기존
 * ChatPage 를 그대로 재사용하므로 범용 채팅을 분기 복제하지 않는다(planner 결정 a).
 *
 * 어시스턴트 미지정/무효(삭제·비활성)일 때는 임의 에이전트를 고르지 않고, 관리자에게
 * 지정을 안내하는 명시적 empty state 를 렌더한다. 컨테이너/뷰 분리 — 순수
 * <ChatFirstHomeView>(state props)로 상태별 마크업을 react-dom/server 로 회귀
 * 테스트하고, fetch·라우팅은 컨테이너가 담당한다(TicketArtifact·ArtifactPanel 선례).
 */

export type ChatFirstHomeViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'unset' }
  | { status: 'invalid' }
  | { status: 'ready'; assistantName: string };

const QUICK_LINKS: { label: string; section: string; hint: string }[] = [
  { label: 'Boards', section: 'boards', hint: '칸반 보드 (Advanced)' },
  { label: 'AI Agents', section: 'agents', hint: '에이전트 관리' },
  { label: 'Chat', section: 'chat', hint: '전체 대화 룸' },
];

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '12px 28px',
        fontSize: tokens.typography.fontSizeXl,
        fontWeight: 600,
        fontFamily: 'inherit',
        color: '#fff',
        background: tokens.colors.accent,
        border: 'none',
        borderRadius: tokens.radii.lg,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        boxShadow: tokens.shadows.card,
      }}
    >
      {children}
    </button>
  );
}

/** 순수 표현 컴포넌트 — 부수효과 없음. 상태·핸들러는 전부 props 로 받는다. */
export function ChatFirstHomeView({
  state,
  userName,
  isAdmin,
  starting,
  onStart,
  onOpenSettings,
  onQuick,
}: {
  state: ChatFirstHomeViewState;
  userName?: string;
  isAdmin: boolean;
  starting?: boolean;
  onStart?: () => void;
  onOpenSettings?: () => void;
  onQuick?: (section: string) => void;
}) {
  const greeting = userName ? `${userName} 님, ` : '';

  let body: React.ReactNode;
  if (state.status === 'loading') {
    body = (
      <p style={{ color: tokens.colors.textSecondary, fontSize: tokens.typography.fontSizeLg }}>
        어시스턴트를 불러오는 중…
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <div role="alert" style={{ color: tokens.colors.danger, fontSize: tokens.typography.fontSizeMd, lineHeight: 1.6 }}>
        어시스턴트 정보를 불러오지 못했습니다.
        <div style={{ marginTop: 4, color: tokens.colors.textMuted, fontSize: 12 }}>{state.message}</div>
      </div>
    );
  } else if (state.status === 'ready') {
    body = (
      <>
        <p
          style={{
            fontSize: tokens.typography.fontSizeLg,
            color: tokens.colors.textSecondary,
            lineHeight: tokens.typography.lineHeightBody,
            margin: `${tokens.spacing.sm}px 0 ${tokens.spacing.xl}px`,
          }}
        >
          {greeting}무엇을 도와드릴까요? <strong>{state.assistantName}</strong> 어시스턴트와 대화로 티켓을 만들고,
          찾고, 상태를 확인하세요. 상세 기능은 좌측 메뉴에서 언제든 열 수 있습니다.
        </p>
        <PrimaryButton onClick={onStart} disabled={starting}>
          {starting ? '대화 여는 중…' : '대화 시작하기'}
        </PrimaryButton>
      </>
    );
  } else {
    // unset | invalid — 임의 에이전트 자동선택 금지, 관리자 지정 안내 empty state.
    const message =
      state.status === 'unset'
        ? '이 워크스페이스에는 아직 AWB 어시스턴트가 지정되지 않았습니다.'
        : '지정된 AWB 어시스턴트 에이전트를 사용할 수 없습니다 (삭제·비활성 상태일 수 있습니다).';
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing.md }}>
        <p
          style={{
            fontSize: tokens.typography.fontSizeLg,
            color: tokens.colors.textSecondary,
            lineHeight: tokens.typography.lineHeightBody,
            margin: `${tokens.spacing.sm}px 0 0`,
          }}
        >
          {message}
        </p>
        {isAdmin ? (
          <>
            <p style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textMuted, margin: 0 }}>
              워크스페이스 설정에서 어시스턴트로 사용할 에이전트를 지정하세요.
            </p>
            <PrimaryButton onClick={onOpenSettings}>
              {state.status === 'unset' ? '어시스턴트 지정하기' : '어시스턴트 다시 지정하기'}
            </PrimaryButton>
          </>
        ) : (
          <p style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textMuted, margin: 0 }}>
            관리자에게 AWB 어시스턴트 지정을 요청하세요. 그동안 좌측 메뉴에서 기존 기능을 사용할 수 있습니다.
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: `${tokens.spacing.xl}px ${tokens.spacing.lg}px`,
        background: tokens.gradients.surfacePage,
      }}
    >
      <div style={{ width: '100%', maxWidth: 640, textAlign: 'center' }}>
        <div
          aria-hidden="true"
          style={{
            width: 56,
            height: 56,
            borderRadius: tokens.radii.xl,
            background: tokens.gradients.accent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 26,
            fontWeight: 700,
            color: '#fff',
            marginBottom: tokens.spacing.md,
          }}
        >
          W
        </div>
        <h1
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: tokens.colors.textPrimary,
            margin: 0,
            lineHeight: tokens.typography.lineHeightHeading,
          }}
        >
          AWB 어시스턴트
        </h1>

        <div style={{ marginTop: tokens.spacing.md }}>{body}</div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: tokens.spacing.sm,
            justifyContent: 'center',
            marginTop: tokens.spacing.xl,
          }}
        >
          {QUICK_LINKS.map((q) => (
            <button
              key={q.section}
              type="button"
              onClick={() => onQuick?.(q.section)}
              title={q.hint}
              style={{
                padding: '8px 16px',
                fontSize: tokens.typography.fontSizeMd,
                fontWeight: 500,
                fontFamily: 'inherit',
                color: tokens.colors.textSecondary,
                background: tokens.colors.surfaceCard,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                cursor: 'pointer',
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function viewStateFor(resolution: AssistantResolution | null, loading: boolean, error: string | null): ChatFirstHomeViewState {
  if (loading) return { status: 'loading' };
  if (error) return { status: 'error', message: error };
  if (!resolution) return { status: 'loading' };
  if (resolution.status === 'ready') return { status: 'ready', assistantName: resolution.agent.name };
  return { status: resolution.status };
}

/** 컨테이너 — workspace 어시스턴트 지정을 해석하고 DM 프리셋을 열어 ChatPage 로 라우팅. */
export default function ChatFirstHome() {
  const navigate = useNavigate();
  const { wsId } = useParams<{ wsId: string }>();
  const { user, hasPermission } = useAuth();
  const { showToast } = useToast();

  const [resolution, setResolution] = useState<AssistantResolution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!wsId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // workspace 의 assistant_agent_id 는 light list(getWorkspaces — board_count 만,
    // 티켓 미포함)에서 읽어 랜딩 hot-path 에 무거운 보드/티켓 payload 를 끌어오지 않는다.
    // agents 는 workspace-scoped(getAgents) — 적격성(활성·비매니저) 대조에 쓴다.
    Promise.all([api.getWorkspaces(), api.getAgents()])
      .then(([workspaces, agents]) => {
        if (cancelled) return;
        const ws = Array.isArray(workspaces) ? workspaces.find((w: any) => w.id === wsId) : null;
        setResolution(resolveAssistant(ws, agents as any, wsId));
      })
      .catch((err: any) => {
        if (cancelled) return;
        setError(err?.message || '네트워크 오류');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wsId]);

  const onStart = useCallback(async () => {
    if (!wsId || !resolution || resolution.status !== 'ready' || starting) return;
    const assistantId = resolution.agent.id;
    setStarting(true);
    try {
      // find-or-create: 서버가 동일-멤버 DM 을 dedup 하지 않으므로 기존 어시스턴트 DM 을
      // 먼저 재사용하고, 없을 때만 새로 만든다. 그런 다음 기존 ChatPage 로 ?room= 딥링크.
      const rooms = await api.listChatRooms();
      let roomId = findAssistantDmRoomId(rooms as any, assistantId);
      if (!roomId) {
        const room = await api.createChatRoom([{ participant_type: 'agent', participant_id: assistantId }]);
        roomId = room.id;
      }
      navigate(`/ws/${wsId}/chat?room=${roomId}`);
    } catch (err: any) {
      showToast(err?.message || '대화를 여는 데 실패했습니다', 'error');
      setStarting(false);
    }
  }, [wsId, resolution, starting, navigate, showToast]);

  const onOpenSettings = useCallback(() => {
    if (wsId) navigate(`/ws/${wsId}/settings`);
  }, [wsId, navigate]);

  const onQuick = useCallback(
    (section: string) => {
      if (wsId) navigate(`/ws/${wsId}/${section}`);
    },
    [wsId, navigate],
  );

  return (
    <ChatFirstHomeView
      state={viewStateFor(resolution, loading, error)}
      userName={user?.name}
      isAdmin={hasPermission('admin.access')}
      starting={starting}
      onStart={onStart}
      onOpenSettings={onOpenSettings}
      onQuick={onQuick}
    />
  );
}
