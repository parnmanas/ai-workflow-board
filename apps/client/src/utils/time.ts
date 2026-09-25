export function relativeTime(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(mo / 12);
  return `${yr}y ago`;
}

/**
 * 짧은 경과 시간 — `12s` / `8m` / `1h 22m`. `relativeTime` 과 달리 "언제"가 아니라
 * **얼마나 오래**를 말한다(실행 시간, 무신호 구간처럼 구간 자체가 정보인 자리).
 * 음수/NaN 은 `0s` 로 접어 시계가 거꾸로 가는 표시를 만들지 않는다.
 */
export function shortDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (total < 60) return `${total}s`;
  const min = Math.floor(total / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}
