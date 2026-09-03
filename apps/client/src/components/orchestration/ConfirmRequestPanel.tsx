import React, { useState } from 'react';
import { api } from '../../api';
import type { OrchestrationStep, OrchestrationStepArtifact } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button } from '../common';

/**
 * 사람이 Pass/Fail 을 답하는 화면(티켓 5dbe4aa2).
 *
 * `awaiting_user` step 하나당 카드 하나. 미션 상세의 **맨 위**에 놓는다 — 이 상태는
 * "사람이 답할 때까지 미션 전체가 멈춰 있다"는 뜻이라, 계획 그래프 아래에 묻히면
 * 운영자가 왜 아무것도 진행되지 않는지 알아내는 데 스크롤이 필요해진다.
 *
 * ── 증거 렌더링 ─────────────────────────────────────────────────────────────
 * 서버가 상류 step 의 artifacts 를 이 step 으로 스냅샷해 둔다. 여기서는 그것을
 * 사람이 **실제로 판정할 수 있는 형태**로 그린다: 이미지는 인라인 `<img>`, 동영상은
 * `<video controls>`, 나머지 http(s) 는 새 탭 링크. 링크 목록만 늘어놓으면 스크린샷을
 * 보고 판정하라는 요구가 "URL 을 하나씩 눌러보라"로 바뀐다.
 *
 * ── stale 화면 ──────────────────────────────────────────────────────────────
 * `visit` 을 그대로 실어 보낸다. loop 가 재진입해 이 게이트가 다음 pass 로 다시 열리면
 * 서버가 409 로 거부하고, 사용자는 지난 pass 의 결과물을 보고 내린 판정이 현재 pass 에
 * 기록되는 일을 겪지 않는다.
 */

/** ref 가 이미지/동영상으로 렌더링 가능한가. `kind` 를 먼저 믿고, 없으면 확장자를 본다. */
function mediaKindOf(artifact: OrchestrationStepArtifact): 'image' | 'video' | 'link' | 'text' {
  const kind = String(artifact.kind || '').toLowerCase();
  const ref = String(artifact.ref || '');
  if (kind === 'image' || kind === 'screenshot') return 'image';
  if (kind === 'video' || kind === 'recording') return 'video';
  const isHttp = /^https?:\/\//i.test(ref);
  // 쿼리스트링이 붙은 URL 도 잡아야 한다 — 서명된 스토리지 링크가 흔한 형태다.
  const path = isHttp ? ref.split(/[?#]/)[0] : ref;
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path)) return 'image';
  if (/\.(mp4|webm|ogg|mov|m4v)$/i.test(path)) return 'video';
  if (isHttp) return 'link';
  return 'text';
}

function Evidence({ artifacts }: { artifacts: OrchestrationStepArtifact[] }) {
  if (artifacts.length === 0) {
    return (
      <div style={{ fontSize: 12, color: tokens.colors.textMuted, lineHeight: 1.6 }}>
        The upstream steps did not attach anything to look at. Decide from the question above and the mission
        timeline.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {artifacts.map((a, i) => {
        const media = mediaKindOf(a);
        const caption = a.label || a.ref;
        return (
          <div key={`${a.kind}-${a.ref}-${i}`} data-testid="confirm-artifact" data-media={media}>
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 4 }}>
              {a.kind}
              {a.label ? ` — ${a.label}` : ''}
            </div>
            {media === 'image' && (
              <img
                src={a.ref}
                alt={caption}
                style={{
                  maxWidth: '100%',
                  maxHeight: 420,
                  borderRadius: 6,
                  border: `1px solid ${tokens.colors.border}`,
                  display: 'block',
                }}
              />
            )}
            {media === 'video' && (
              <video
                src={a.ref}
                controls
                style={{
                  maxWidth: '100%',
                  maxHeight: 420,
                  borderRadius: 6,
                  border: `1px solid ${tokens.colors.border}`,
                  display: 'block',
                }}
              />
            )}
            {media === 'link' && (
              <a
                href={a.ref}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 12, color: tokens.colors.accentLight, wordBreak: 'break-all' }}
              >
                {a.ref}
              </a>
            )}
            {media === 'text' && (
              <code style={{ fontSize: 12, color: tokens.colors.textSecondary, wordBreak: 'break-all' }}>
                {a.ref}
              </code>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ConfirmCard({
  step,
  wsId,
  onDecided,
}: {
  step: OrchestrationStep;
  wsId: string;
  onDecided: () => void;
}) {
  const { showToast } = useToast();
  const [feedback, setFeedback] = useState('');
  // 어느 버튼이 진행 중인지까지 담는다 — 단순 boolean 이면 두 버튼이 똑같이 죽어서
  // 사용자가 자기가 무엇을 눌렀는지 화면에서 확인할 수 없다.
  const [submitting, setSubmitting] = useState<'pass' | 'fail' | null>(null);

  const submit = async (verdict: 'pass' | 'fail') => {
    setSubmitting(verdict);
    try {
      const result = await api.submitOrchestrationStepConfirm(step.id, {
        workspace_id: wsId,
        verdict,
        visit: step.visit,
        feedback: feedback.trim() || undefined,
      });
      showToast(
        result.already_decided
          ? 'This decision was already recorded — the mission is carrying on from it.'
          : verdict === 'pass'
            ? 'Passed — the mission is continuing.'
            : 'Sent back with your feedback.',
        'success',
      );
      onDecided();
    } catch (e: any) {
      showToast(e?.message || 'Failed to submit the decision', 'error');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div
      data-testid="confirm-card"
      data-step-key={step.step_key}
      style={{
        border: `1px solid ${tokens.colors.warningLight}66`,
        background: `${tokens.colors.warningBg}22`,
        borderRadius: 8,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.textStrong }}>{step.title}</div>
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
          <code>{step.step_key}</code>
          {step.visit > 1 ? ` · pass ${step.visit}` : ''}
        </div>
      </div>

      {step.instructions && (
        <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: tokens.colors.textPrimary }}>
          {step.instructions}
        </div>
      )}

      <Evidence artifacts={step.artifacts} />

      <label style={{ display: 'block' }}>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 4 }}>
          Reason / feedback (optional)
        </span>
        <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6, lineHeight: 1.4 }}>
          If you send this back, whatever you write here is handed to the agent that has to redo the work — be
          specific about what is wrong.
        </span>
        <textarea
          aria-label="Reason / feedback (optional)"
          value={feedback}
          rows={3}
          onChange={(e) => setFeedback(e.target.value)}
          style={{
            width: '100%',
            padding: '8px 10px',
            borderRadius: 6,
            border: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surface,
            color: tokens.colors.textPrimary,
            fontSize: 13,
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />
      </label>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          variant="primary"
          onClick={() => submit('pass')}
          loading={submitting === 'pass'}
          disabled={submitting !== null}
        >
          Pass
        </Button>
        <Button
          variant="danger"
          onClick={() => submit('fail')}
          loading={submitting === 'fail'}
          disabled={submitting !== null}
        >
          Fail
        </Button>
      </div>
    </div>
  );
}

export default function ConfirmRequestPanel({
  steps,
  wsId,
  onDecided,
}: {
  steps: OrchestrationStep[];
  wsId: string;
  onDecided: () => void;
}) {
  const waiting = steps.filter((s) => s.status === 'awaiting_user');
  if (waiting.length === 0) return null;

  return (
    <section data-testid="confirm-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: tokens.colors.warningLight,
          }}
        >
          Waiting for your decision
        </h2>
        <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
          The mission is paused here until you answer. It will not time out.
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {waiting.map((s) => (
          <ConfirmCard key={s.id} step={s} wsId={wsId} onDecided={onDecided} />
        ))}
      </div>
    </section>
  );
}
