import { toneStyle, isNoteworthy } from '../../activity';
import type { ActivityTone, ActivityView } from '../../activity';

/**
 * 진행 상태를 그리는 **유일한** 프리미티브 쌍. session / chat / board / mission 이
 * 같은 색·같은 단어·같은 애니메이션으로 "지금 돌고 있다 / 내가 답해야 한다"를 말하게
 * 한다. 상태 → tone 번역은 `src/activity.ts` 가, 그리기는 여기가 맡는다.
 *
 * - `ActivityDot`  좁은 곳(좌측 목록 행, 카드) — 점 하나. idle 이면 아무것도 그리지 않는다.
 * - `ActivityPill` 넓은 곳(우측 프레임 헤더) — 점 + 라벨.
 *
 * 애니메이션 클래스는 main.tsx 의 전역 CSS 에서 온다(awb-activity-live /
 * awb-activity-attention). 인라인 @keyframes 를 새로 만들지 말 것 — 그렇게 늘어난
 * 사본이 표면마다 다른 속도로 깜빡이던 원인이었다.
 */

function pulseClass(tone: ActivityTone, live: boolean): string | undefined {
  if (toneStyle(tone).attention) return 'awb-activity-attention';
  return live ? 'awb-activity-live' : undefined;
}

export function ActivityDot({
  view,
  size = 7,
  title,
}: {
  view: ActivityView;
  size?: number;
  /** 없으면 라벨을 툴팁으로 쓴다 — 점만 있는 자리에서 뜻을 잃지 않게. */
  title?: string;
}) {
  if (!isNoteworthy(view.tone)) return null;
  const { color } = toneStyle(view.tone);
  return (
    <span
      className={pulseClass(view.tone, view.live)}
      data-activity-tone={view.tone}
      title={title ?? view.label}
      aria-label={title ?? view.label}
      role="img"
      style={{
        display: 'inline-block', flexShrink: 0,
        width: size, height: size, borderRadius: '50%', background: color,
      }}
    />
  );
}

export function ActivityPill({
  view,
  dataAttr,
  title,
}: {
  view: ActivityView;
  /** 표면별 테스트 훅(예: `{ 'data-session-status': 'busy' }`). */
  dataAttr?: Record<string, string>;
  title?: string;
}) {
  const { color } = toneStyle(view.tone);
  return (
    <span
      {...dataAttr}
      data-activity-tone={view.tone}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color,
        border: `1px solid ${color}55`, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden="true"
        className={pulseClass(view.tone, view.live)}
        style={{ width: 7, height: 7, borderRadius: '50%', background: color }}
      />
      {view.label}
    </span>
  );
}
