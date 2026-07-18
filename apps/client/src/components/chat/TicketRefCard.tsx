import React, { useState } from 'react';
import { tokens } from '../../tokens';
import { useOpenTicketArtifact } from '../../contexts/ticketArtifactOpener';
import { useTicketMeta } from '../../contexts/TicketMetaContext';

/**
 * 티켓 참조 카드 (에픽 bf65ca00 · Phase 1 · S2).
 *
 * 채팅/코멘트 본문의 `@[ticket:<id>|title]` 토큰이 renderMarkdown 을 통해 이 카드로
 * 렌더된다(멘션 pill 선례 확장, 마이그레이션 0). 어시스턴트가 티켓을 만들거나 참조하면
 * 답장 안에서 인터랙티브 카드로 나타나고, 클릭 시 우측 Artifact 패널에 상세가 열린다(S3).
 *
 * 오프너는 useOpenTicketArtifact() 로 주입받는다 — 프로바이더 밖에서는 no-op 이라
 * 어느 표면(SSR 계약 테스트 포함)에서도 안전하게 렌더된다. 카드 자체는 api 를 모른다.
 *
 * F-1 (ticket 24694916): 선택적 `action` 은 agent-manager 가 tool result 에서 캡처한
 * 티켓 액션(생성/이동/…). 있으면 라벨 앞에 작은 배지로 렌더한다. content-token 경로는
 * action 없이 호출하므로 기존 인라인 카드는 그대로다.
 *
 * F2-4 (ticket d21b28fc):
 *  ⓐ 상태 카드 — useTicketMeta(id) 로 현재 컬럼/우선순위를 lazy fetch·캐시·SSE 갱신해
 *     칩으로 붙인다(프로바이더 밖에선 undefined → 칩 생략, 기존 렌더 불변).
 *  ⓑ 승인 카드 — action 이 propose/consensus 면 승인 변형으로 렌더한다: 다른 톤 배지 +
 *     `detail`(제안 대상 컬럼)을 "→ <컬럼>" 배지로 노출(투표 맥락, 클라 중심).
 */
// 액션 코드 → 한글 배지 라벨. 미매핑 코드는 코드 문자열 그대로 노출.
// agent-manager 의 TICKET_ACTION_LABEL_KO(ticket-ref-capture.ts)와 동일 집합을 유지 —
// 캡처가 방출하는 모든 action 코드가 여기서 한글 배지로 렌더된다(계약 일치, 수용기준 #3).
const ACTION_LABEL: Record<string, string> = {
  create: '생성', move: '이동', update: '수정', comment: '코멘트',
  question: '질문', answer: '답변', decision: '결정',
  claim: '클레임', release: '클레임 해제', pend: '보류', unpend: '보류 해제',
  archive: '아카이브', unarchive: '아카이브 해제', prereq: '선행조건',
  handoff: '핸드오프', propose: '이동 제안', consensus: '합의', reject: '반려', delete: '삭제',
};

// ⓑ 승인 카드 대상 action(제안/합의). 이 두 action 은 승인 변형으로 구분 렌더한다.
const APPROVAL_ACTIONS = new Set(['propose', 'consensus']);

// ⓐ 우선순위 칩 톤(TicketArtifact 와 동일 의미론).
const PRIORITY_CHIP_TONE: Record<string, { bg: string; fg: string }> = {
  high: { bg: `${tokens.colors.danger}1A`, fg: tokens.colors.danger },
  medium: { bg: tokens.overlays.accentSoft, fg: tokens.colors.accentSubtle },
  low: { bg: `${tokens.colors.border}60`, fg: tokens.colors.textMuted },
};

function MetaChip({ label, tone }: { label: string; tone: { bg: string; fg: string } }) {
  return (
    <span
      data-meta-chip=""
      style={{
        fontSize: tokens.typography.fontSizeXs,
        fontWeight: 700,
        padding: '0 5px',
        borderRadius: tokens.radii.sm,
        background: tone.bg,
        color: tone.fg,
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

export default function TicketRefCard({
  id,
  title,
  action,
  detail,
}: {
  id: string;
  title: string;
  action?: string;
  detail?: string;
}) {
  const openTicket = useOpenTicketArtifact();
  const meta = useTicketMeta(id);
  const [hover, setHover] = useState(false);

  const label = title || '티켓';
  const actionLabel = action ? (ACTION_LABEL[action] ?? action) : '';
  const isApproval = !!action && APPROVAL_ACTIONS.has(action);

  return (
    <button
      type="button"
      data-ticket-ref={id}
      data-ticket-approval={isApproval ? '' : undefined}
      onClick={() => openTicket(id, title)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={`${actionLabel ? `티켓 ${actionLabel} — ` : ''}티켓 열기: ${label}`}
      title={label}
      style={{
        // 메시지 텍스트 흐름 안에 자연스럽게 놓이는 인라인 카드.
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        verticalAlign: 'baseline',
        maxWidth: '100%',
        margin: '0 1px',
        padding: '1px 8px 1px 6px',
        fontFamily: 'inherit',
        fontSize: tokens.typography.fontSizeMd,
        fontWeight: 600,
        lineHeight: 1.4,
        // 승인 변형은 accent 대신 성공(승인) 톤으로 구분한다.
        color: isApproval ? tokens.colors.success : tokens.colors.accentSubtle,
        background: isApproval
          ? `${tokens.colors.success}14`
          : hover
            ? tokens.overlays.accentStrong
            : tokens.overlays.accentSoft,
        border: `1px solid ${
          isApproval
            ? `${tokens.colors.success}66`
            : hover
              ? tokens.colors.accent
              : 'rgba(99,102,241,0.30)'
        }`,
        borderRadius: tokens.radii.md,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 12, opacity: 0.85 }}>
        {isApproval ? '🗳️' : '🎫'}
      </span>
      {actionLabel && (
        <span
          style={{
            fontSize: tokens.typography.fontSizeXs,
            fontWeight: 700,
            padding: '0 5px',
            borderRadius: tokens.radii.sm,
            background: isApproval ? `${tokens.colors.success}22` : tokens.overlays.accentStronger,
            color: isApproval ? tokens.colors.success : tokens.colors.accentSubtle,
            flexShrink: 0,
          }}
        >
          {actionLabel}
        </span>
      )}
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 260,
        }}
      >
        {label}
      </span>
      {/* ⓑ 승인 카드: 제안 대상 컬럼(투표 맥락) 배지. */}
      {isApproval && detail && (
        <MetaChip
          label={`→ ${detail}`}
          tone={{ bg: `${tokens.colors.success}22`, fg: tokens.colors.success }}
        />
      )}
      {/* ⓐ 상태 카드: 현재 우선순위/컬럼 칩(메타 있을 때만). */}
      {meta?.priority && (
        <MetaChip
          label={meta.priority}
          tone={PRIORITY_CHIP_TONE[meta.priority] || { bg: tokens.colors.surfaceCard, fg: tokens.colors.textSecondary }}
        />
      )}
      {meta?.status && (
        <MetaChip label={meta.status} tone={{ bg: `${tokens.colors.border}60`, fg: tokens.colors.textMuted }} />
      )}
    </button>
  );
}
