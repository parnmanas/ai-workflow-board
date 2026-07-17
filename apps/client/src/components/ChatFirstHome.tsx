import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { tokens } from '../tokens';

/**
 * Chat-first 랜딩 (에픽 bf65ca00 · Phase 1 · S1 공통 셸).
 *
 * 기본(Chat-first) 모드의 진입 화면. 이 커밋은 셸 프레임과 진입 경험을 제공하고,
 * 실제 AWB 어시스턴트 대화 composer 는 S2 에서 이 화면에 임베드된다(현재는 기존 chat
 * 라우트로 연결하는 CTA + 빠른 링크). dead placeholder 가 아니라 동작하는 랜딩이다.
 * 좁은 화면에서도 자연스럽게 세로 정렬되도록 구성한다.
 */
export default function ChatFirstHome() {
  const navigate = useNavigate();
  const { wsId } = useParams<{ wsId: string }>();
  const { user } = useAuth();

  const go = (section: string) => {
    if (wsId) navigate(`/ws/${wsId}/${section}`);
  };

  const quickLinks: { label: string; section: string; hint: string }[] = [
    { label: 'Boards', section: 'boards', hint: '칸반 보드 (Advanced)' },
    { label: 'AI Agents', section: 'agents', hint: '에이전트 관리' },
    { label: 'Chat', section: 'chat', hint: '전체 대화 룸' },
  ];

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
        <p
          style={{
            fontSize: tokens.typography.fontSizeLg,
            color: tokens.colors.textSecondary,
            lineHeight: tokens.typography.lineHeightBody,
            margin: `${tokens.spacing.sm}px 0 ${tokens.spacing.xl}px`,
          }}
        >
          {user?.name ? `${user.name} 님, ` : ''}무엇을 도와드릴까요? 대화로 티켓을 만들고, 찾고, 상태를
          확인하세요. 상세 기능은 좌측 메뉴에서 언제든 열 수 있습니다.
        </p>

        <button
          type="button"
          onClick={() => go('chat')}
          style={{
            padding: '12px 28px',
            fontSize: tokens.typography.fontSizeXl,
            fontWeight: 600,
            fontFamily: 'inherit',
            color: '#fff',
            background: tokens.colors.accent,
            border: 'none',
            borderRadius: tokens.radii.lg,
            cursor: 'pointer',
            boxShadow: tokens.shadows.card,
          }}
        >
          대화 시작하기
        </button>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: tokens.spacing.sm,
            justifyContent: 'center',
            marginTop: tokens.spacing.xl,
          }}
        >
          {quickLinks.map((q) => (
            <button
              key={q.section}
              type="button"
              onClick={() => go(q.section)}
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
