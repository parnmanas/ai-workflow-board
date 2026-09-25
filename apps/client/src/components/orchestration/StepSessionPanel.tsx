import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type {
  OrchestrationStep,
  OrchestrationStepAttachment,
  OrchestrationStepSessionItem,
  OrchestrationTimelineEvent,
} from '../../types';
import { renderMarkdown } from '../chat/utils/markdown';
import { base64ToBlob, formatBytes, triggerBlobDownload } from '../chat/utils/attachments';
import {
  EvidenceLightbox,
  EvidenceThumb,
  isEvidenceMedia,
  useEvidenceUrls,
  type EvidenceMediaMeta,
} from './EvidenceMedia';
import { relativeTime } from '../../utils/time';
import { eventColor, stepStyle } from './status';
import {
  compactActivityLabel,
  describeStepActivity,
  describeStepQuiet,
  runningLabel,
} from './step-activity';

/**
 * 선택된 step 하나의 **작업 세션** — "이 담당자가 무엇을 받아서 무엇을 했고 무엇을
 * 보고했는가" 전체.
 *
 * 왜 채팅 패널을 재사용하지 않는가: step 방은 설계상 **사람이 참여자로 들어가지 않는
 * 방**이다(미션 하나가 수십 개를 만들고, 사람이 낄 대화가 아니다). 그래서 입력창이 있는
 * 채팅 UI 를 여기 붙이면 존재하지 않는 능력을 약속하는 화면이 된다 — 운영자가 방향을
 * 바꾸는 입구는 오직 미션 대화(orchestrator)다. 이 패널은 읽기 전용이고, 그 사실을 바닥에
 * 명시한다.
 *
 * 세 가지 출처를 **시간순 하나의 흐름**으로 엮는다. 따로 두면 "지시 → 실제 작업 → 보고"
 * 라는 인과가 화면에서 끊긴다:
 *   - AWB 가 방에 넣은 지시(work order·재연결 요청) → 접어서 제목만.
 *   - CLI 툴 하트비트(progress) → 한 줄 muted.
 *   - 담당 agent 의 메시지 → 본문.
 *   - 그리고 이 step 의 실행 이벤트(dispatch/failed/completed/lease)를 같은 축에 얹는다.
 *     이벤트는 미션 페이로드에 이미 있으므로 추가 요청이 없다.
 */

/** 한 번에 가져오는 세션 줄 수. 위로 스크롤하면 같은 크기로 이어 붙인다. */
const PAGE_SIZE = 60;

/** 진행 중인 step 의 전사(transcript)를 다시 읽는 주기. SSE 는 미션 단위라 방 내용은 폴링한다. */
const LIVE_POLL_MS = 15_000;

/** 이 거리 안쪽이면 "맨 아래를 보고 있다"고 보고 새 줄에 자동 추종한다. */
const NEAR_BOTTOM_PX = 80;

type Row =
  | { at: number; kind: 'item'; item: OrchestrationStepSessionItem }
  | { at: number; kind: 'event'; event: OrchestrationTimelineEvent };

/**
 * 세션 줄과 실행 이벤트를 시간순으로 병합한다(오래된 것 → 최신). 같은 시각이면 이벤트를
 * 뒤에 둔다 — "그 일이 벌어졌다"는 기록이 원인 뒤에 오는 편이 읽기 자연스럽다.
 */
export function buildStepSessionRows(
  items: OrchestrationStepSessionItem[],
  events: OrchestrationTimelineEvent[],
): Row[] {
  const rows: Row[] = [
    ...items.map((item) => ({ at: new Date(item.at).getTime(), kind: 'item' as const, item })),
    ...events.map((event) => ({ at: new Date(event.created_at).getTime(), kind: 'event' as const, event })),
  ];
  rows.sort((a, b) => a.at - b.at || (a.kind === 'event' ? 1 : 0) - (b.kind === 'event' ? 1 : 0));
  return rows;
}

/** `# Assigned task (RETRY, attempt 2): 제목` → 접힌 블록의 한 줄 제목. */
export function systemBlockTitle(text: string): string {
  const firstLine = String(text ?? '').split('\n').find((l) => l.trim()) ?? '';
  const stripped = firstLine.replace(/^#{1,6}\s*/, '').trim();
  return stripped || 'AWB message';
}

export default function StepSessionPanel({
  step,
  wsId,
  events,
  stepTimeoutMinutes,
  onClose,
}: {
  step: OrchestrationStep;
  wsId: string;
  /** 미션 전체 타임라인. 이 step 의 것만 걸러 쓴다. */
  events: OrchestrationTimelineEvent[];
  stepTimeoutMinutes: number;
  onClose: () => void;
}) {
  const [items, setItems] = useState<OrchestrationStepSessionItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [showOrder, setShowOrder] = useState(false);
  const [lightbox, setLightbox] = useState<{ meta: EvidenceMediaMeta; url: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  // 첨부 바이트는 step 첨부 경로로 읽는다 — 채팅 경로는 참여자 게이트라 step 방에서는
  // 사람이 못 읽는다. 세션 전사와 같은 게이트(orchestration 권한)를 탄다.
  const loadAttachment = useCallback(
    async (meta: EvidenceMediaMeta) => api.getOrchestrationStepAttachment(step.id, wsId, meta.id),
    [step.id, wsId],
  );
  const media = useEvidenceUrls(loadAttachment);

  const style = stepStyle(step.status);
  const inFlight = style.live;

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      try {
        const res = await api.getOrchestrationStepSession(step.id, wsId, { limit: PAGE_SIZE });
        // 서버는 최신순(DESC)으로 준다 — 전사는 오래된 것부터 읽는다.
        setItems([...res.items].reverse());
        setHasMore(res.has_more);
        setNextBefore(res.next_before_id);
        setFailed(null);
      } catch (e: any) {
        setFailed(e?.message || 'Failed to read this step session');
      } finally {
        setLoading(false);
      }
    },
    [step.id, wsId],
  );

  useEffect(() => {
    stickToBottom.current = true;
    void load();
  }, [load]);

  // 진행 중인 step 만 폴링한다. 끝난 step 의 전사는 더 이상 변하지 않는다.
  useEffect(() => {
    if (!inFlight) return;
    const handle = setInterval(() => void load({ silent: true }), LIVE_POLL_MS);
    return () => clearInterval(handle);
  }, [inFlight, load]);

  const loadOlder = async () => {
    if (!nextBefore) return;
    try {
      const res = await api.getOrchestrationStepSession(step.id, wsId, {
        limit: PAGE_SIZE,
        beforeId: nextBefore,
      });
      // 위로 이어 붙이는 동안 아래로 따라가면 읽던 자리를 잃는다.
      stickToBottom.current = false;
      setItems((prev) => [...[...res.items].reverse(), ...prev]);
      setHasMore(res.has_more);
      setNextBefore(res.next_before_id);
    } catch {
      /* 이어 붙이기 실패는 조용히 접는다 — 이미 보이는 전사는 그대로 유효하다. */
    }
  };

  const stepEvents = useMemo(() => events.filter((e) => e.step_id === step.id), [events, step.id]);
  const rows = useMemo(() => buildStepSessionRows(items, stepEvents), [items, stepEvents]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const now = Date.now();
  const activity = describeStepActivity(step, now);
  const quiet = describeStepQuiet(step, stepTimeoutMinutes, now);

  return (
    <div
      data-testid="step-session"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      {/* ── 헤더: 이 step 이 무엇이고 지금 어떤 상태인가 ───────────────────── */}
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${tokens.colors.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: style.color,
              background: style.background,
            }}
          >
            {style.label}
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: tokens.colors.textPrimary }}>{step.title}</span>
          <span style={{ fontSize: 10.5, fontFamily: 'monospace', color: tokens.colors.textMuted }}>
            {step.step_key}
          </span>
          <button
            type="button"
            onClick={onClose}
            title="선택을 풀고 미션 대화로 돌아갑니다"
            style={{
              marginLeft: 'auto',
              border: `1px solid ${tokens.colors.border}`,
              background: 'transparent',
              color: tokens.colors.textSecondary,
              borderRadius: 6,
              fontSize: 11,
              padding: '3px 9px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Back to mission
          </button>
        </div>

        <div
          style={{
            marginTop: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            fontSize: 11,
            color: tokens.colors.textSecondary,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: step.assignee_online ? tokens.colors.successLight : tokens.colors.textMuted,
              }}
            />
            {step.assignee_name || 'unassigned'}
          </span>
          <span>
            attempt {step.attempt}/{step.max_attempts}
          </span>
          {step.verdict && (
            <span>
              verdict <strong style={{ color: tokens.colors.accent }}>{step.verdict}</strong>
            </span>
          )}
          {step.retry_policy === 'manual' && (
            <span
              data-testid="step-retry-policy-manual"
              style={{ color: tokens.colors.warningLight, fontWeight: 700, textTransform: 'uppercase', fontSize: 10 }}
            >
              manual recovery only
            </span>
          )}
          {step.workspace_folder && (
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: tokens.colors.textMuted }}>
              {step.workspace_folder}
            </span>
          )}
        </div>

        {/* 진행 중이면 카드와 **같은 판정**의 두 시계를 여기서도 보여준다. */}
        {inFlight && (
          <div
            data-testid="step-session-activity"
            style={{ marginTop: 6, fontSize: 11, color: tokens.colors.textMuted, display: 'flex', gap: 10, flexWrap: 'wrap' }}
          >
            <span style={{ color: activity.stalled ? tokens.colors.warningLight : tokens.colors.textSecondary }}>
              {compactActivityLabel(activity)}
            </span>
            {runningLabel(activity) && <span>{runningLabel(activity)}</span>}
            {quiet && (
              <span style={{ color: quiet.overdue ? tokens.colors.dangerLight : tokens.colors.textMuted }}>
                {quiet.label}
              </span>
            )}
          </div>
        )}

        {/* 복구 사유는 needs_recovery 의 존재 이유다 — 상태만 보여주고 왜 자동으로
            재실행하지 않는지 숨기면 그냥 멈춘 step 과 구분할 수 없다. */}
        {step.recovery_reason && (
          <div
            data-testid="step-recovery-reason"
            style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 6,
              border: `1px solid ${tokens.colors.dangerLight}55`,
              background: `${tokens.colors.dangerBg}30`,
              fontSize: 11.5,
              lineHeight: 1.6,
              color: tokens.colors.textSecondary,
            }}
          >
            <div style={{ fontWeight: 700, color: tokens.colors.dangerLight, marginBottom: 3 }}>
              자동 복구 불가 — 사람의 확인이 필요합니다
            </div>
            {step.recovery_reason}
          </div>
        )}

        {/* 지시문과 완료 조건은 접어 둔다. 세션을 열어 보는 이유는 대개 "무엇을 하고
            있나" 이고, 지시문은 필요할 때 펼쳐 보는 참고자료다. */}
        <button
          type="button"
          onClick={() => setShowOrder((v) => !v)}
          style={{
            marginTop: 8,
            border: 'none',
            background: 'transparent',
            padding: 0,
            color: tokens.colors.accentSubtle,
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {showOrder ? '▾' : '▸'} Work order · done when · result
        </button>
        {showOrder && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Block title="Work order" text={step.instructions || '(no instructions recorded)'} />
            {step.acceptance_criteria && <Block title="Done when" text={step.acceptance_criteria} muted />}
            {step.result_summary && <Block title="Reported result" text={step.result_summary} />}
            {step.artifacts.length > 0 && (
              <div>
                <Label>Artifacts</Label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {step.artifacts.map((a, i) => (
                    <div key={`${a.ref}-${i}`} style={{ fontSize: 11.5, color: tokens.colors.textSecondary }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 10, color: tokens.colors.textMuted }}>
                        {a.kind}
                      </span>{' '}
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
          </div>
        )}
      </div>

      {/* ── 전사 ───────────────────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 14px' }}
      >
        {hasMore && (
          <button
            type="button"
            onClick={() => void loadOlder()}
            style={{
              display: 'block',
              margin: '0 auto 10px',
              border: `1px solid ${tokens.colors.border}`,
              background: 'transparent',
              color: tokens.colors.textSecondary,
              borderRadius: 6,
              fontSize: 11,
              padding: '3px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Load earlier
          </button>
        )}
        {loading && rows.length === 0 ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading session…</div>
        ) : failed ? (
          <div style={{ fontSize: 12, color: tokens.colors.dangerLight, lineHeight: 1.6 }}>{failed}</div>
        ) : rows.length === 0 ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, lineHeight: 1.7 }}>
            {step.room_id
              ? '이 step 의 방에 아직 아무 기록이 없습니다.'
              : '아직 디스패치되지 않았습니다 — 작업 방은 디스패치 시점에 만들어집니다.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map((row) =>
              row.kind === 'event' ? (
                <EventRow key={`e-${row.event.id}`} event={row.event} />
              ) : (
                <ItemRow
                  key={`i-${row.item.id}`}
                  item={row.item}
                  mediaUrls={media.urls}
                  onEnsureMedia={media.ensure}
                  onOpenMedia={(meta, url) => setLightbox({ meta, url })}
                  onDownload={loadAttachment}
                />
              ),
            )}
          </div>
        )}
      </div>

      {/* 읽기 전용인 이유를 바닥에 한 줄로 남긴다 — 입력창이 없는 화면은 "고장난
          것"처럼 보이기 쉽고, 여기서 지시를 내리면 안 되는 근거가 설계에 있다. */}
      <div
        style={{
          padding: '7px 14px',
          borderTop: `1px solid ${tokens.colors.border}`,
          fontSize: 10.5,
          color: tokens.colors.textMuted,
          lineHeight: 1.5,
        }}
      >
        읽기 전용입니다. step 작업 방은 담당 agent 에게 내리는 지시 채널이라 사람이 참여하지
        않습니다 — 방향을 바꾸려면 미션 대화에서 orchestrator 에게 말하세요.
      </div>

      {lightbox && <EvidenceLightbox meta={lightbox.meta} url={lightbox.url} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function ItemRow({
  item,
  mediaUrls,
  onEnsureMedia,
  onOpenMedia,
  onDownload,
}: {
  item: OrchestrationStepSessionItem;
  mediaUrls: Record<string, string>;
  onEnsureMedia: (meta: EvidenceMediaMeta) => void;
  onOpenMedia: (meta: EvidenceMediaMeta, url: string) => void;
  onDownload: (meta: EvidenceMediaMeta) => Promise<{ file_data: string; mime_type?: string } | null>;
}) {
  const [open, setOpen] = useState(false);
  const attachments = item.attachments ?? [];

  if (item.kind === 'progress') {
    return (
      <div style={{ display: 'flex', gap: 8, fontSize: 11, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
        <span style={{ fontFamily: 'monospace', flexShrink: 0 }}>{timeOf(item.at)}</span>
        <span style={{ wordBreak: 'break-word' }}>{item.text}</span>
      </div>
    );
  }

  if (item.kind === 'system') {
    return (
      <div
        style={{
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: 7,
          background: `${tokens.colors.border}30`,
          padding: '7px 9px',
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            display: 'flex',
            width: '100%',
            gap: 8,
            alignItems: 'baseline',
            border: 'none',
            background: 'transparent',
            padding: 0,
            textAlign: 'left',
            cursor: 'pointer',
            fontFamily: 'inherit',
            color: tokens.colors.textSecondary,
            fontSize: 11.5,
          }}
        >
          <span style={{ color: tokens.colors.textMuted }}>{open ? '▾' : '▸'}</span>
          <span style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{systemBlockTitle(item.text)}</span>
          <span style={{ fontSize: 10, color: tokens.colors.textMuted, flexShrink: 0 }}>
            AWB · {timeOf(item.at)}
          </span>
        </button>
        {open && (
          <div
            style={{
              marginTop: 7,
              fontSize: 12,
              lineHeight: 1.7,
              color: tokens.colors.textSecondary,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {renderMarkdown(item.text)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11 }}>
        <span style={{ fontWeight: 700, color: tokens.colors.textPrimary }}>
          {item.sender_name || (item.kind === 'agent' ? 'agent' : 'user')}
        </span>
        <span style={{ color: tokens.colors.textMuted, fontSize: 10 }}>{timeOf(item.at)}</span>
      </div>
      {item.text && (
        <div
          style={{
            marginTop: 2,
            fontSize: 12.5,
            lineHeight: 1.7,
            color: tokens.colors.textSecondary,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {renderMarkdown(item.text)}
        </div>
      )}
      {attachments.length > 0 && (
        <AttachmentStrip
          attachments={attachments}
          mediaUrls={mediaUrls}
          onEnsureMedia={onEnsureMedia}
          onOpenMedia={onOpenMedia}
          onDownload={onDownload}
        />
      )}
    </div>
  );
}

/**
 * 메시지 아래의 첨부 줄. 이미지·동영상은 썸네일(클릭 → 라이트박스), 그 밖의 파일은
 * 이름·크기·다운로드 버튼. 검증 증거가 대개 여기로 들어온다 — work order 가 담당자에게
 * 스크린샷/녹화를 이 방에 올리라고 지시한다.
 */
function AttachmentStrip({
  attachments,
  mediaUrls,
  onEnsureMedia,
  onOpenMedia,
  onDownload,
}: {
  attachments: OrchestrationStepAttachment[];
  mediaUrls: Record<string, string>;
  onEnsureMedia: (meta: EvidenceMediaMeta) => void;
  onOpenMedia: (meta: EvidenceMediaMeta, url: string) => void;
  onDownload: (meta: EvidenceMediaMeta) => Promise<{ file_data: string; mime_type?: string } | null>;
}) {
  const media = attachments.filter((a) => isEvidenceMedia(a));
  const files = attachments.filter((a) => !isEvidenceMedia(a));
  return (
    <div data-testid="step-session-attachments" style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {media.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {media.map((a) => (
            <EvidenceThumb key={a.id} meta={a} url={mediaUrls[a.id]} onEnsure={onEnsureMedia} onOpen={onOpenMedia} />
          ))}
        </div>
      )}
      {files.map((a) => (
        <div
          key={a.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11.5,
            padding: '5px 8px',
            borderRadius: 6,
            border: `1px solid ${tokens.colors.border}`,
            maxWidth: 360,
          }}
        >
          <span aria-hidden="true">📄</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.file_name}
          </span>
          <span style={{ color: tokens.colors.textMuted, fontSize: 10 }}>{formatBytes(a.size_bytes)}</span>
          <button
            type="button"
            onClick={async () => {
              const full = await onDownload(a);
              if (!full?.file_data) return;
              triggerBlobDownload(base64ToBlob(full.file_data, full.mime_type || a.mime_type), a.file_name);
            }}
            style={{
              border: `1px solid ${tokens.colors.border}`,
              background: 'transparent',
              color: tokens.colors.textSecondary,
              borderRadius: 5,
              fontSize: 10.5,
              padding: '2px 8px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Download
          </button>
        </div>
      ))}
    </div>
  );
}

/** 이 step 의 실행 이벤트 한 줄 — 미션 대화 패널의 이벤트 행과 같은 시각 언어를 쓴다. */
function EventRow({ event }: { event: OrchestrationTimelineEvent }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5 }}>
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          marginTop: 5,
          borderRadius: '50%',
          flexShrink: 0,
          background: eventColor(event.type),
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: tokens.colors.textSecondary, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
          {event.message}
        </div>
        <div style={{ marginTop: 1, fontSize: 10, color: tokens.colors.textMuted, display: 'flex', gap: 7 }}>
          <span style={{ fontFamily: 'monospace' }}>{event.type}</span>
          <span>{relativeTime(event.created_at)}</span>
        </div>
      </div>
    </div>
  );
}

function Block({ title, text, muted }: { title: string; text: string; muted?: boolean }) {
  return (
    <div>
      <Label>{title}</Label>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.7,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: muted ? tokens.colors.textMuted : tokens.colors.textSecondary,
        }}
      >
        {text}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: tokens.colors.textMuted,
        marginBottom: 3,
      }}
    >
      {children}
    </div>
  );
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}
