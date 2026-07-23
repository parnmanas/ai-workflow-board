import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { EmptyState, ErrorState } from '../common';
import type { WorkflowHealthRollup, WorkflowHealthLongTermUsage } from '../../types';

const POLL_INTERVAL = 15000;

// 억제 사유 3종 — count가 0이어도 전부 노출한다(ticket 3970db66 요청사항).
const SUPPRESSION_REASONS: Array<{ key: string; label: string }> = [
  { key: 'repeated_waiting_without_work_target', label: '작업 대상 부재 상태에서 대기 반복' },
  { key: 'pending_user_action', label: '이미 pending 상태(사용자 조치 대기 중 재시도)' },
  { key: 'duplicate_terminal_acknowledgement', label: '중복 종료 확인(terminal ack)' },
];

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}초`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}시간`;
  const day = Math.round(hr / 24);
  return `${day}일`;
}

function formatTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

// null → "no priced runs to estimate from" (never rendered as $0 — see
// WorkflowHealthTokenUsage docstring). Sub-$1 figures need more precision
// than a flat 2-decimal format to stay legible (a $0.03 run would print as
// "$0.00").
function formatUsd(v: number | null): string {
  if (v == null) return '—';
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function SummaryTile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{
      background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
      borderRadius: tokens.radii.lg, padding: '12px 16px',
    }}>
      <div style={{ fontSize: '11px', color: tokens.colors.textSecondary, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 700, color: accent || tokens.colors.textPrimary }}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: '13px', fontWeight: 700, color: tokens.colors.textStrong, margin: '0 0 8px 0' }}>
        {title}
      </h3>
      <div style={{
        background: tokens.colors.surfaceCard, borderRadius: tokens.radii.lg,
        border: `1px solid ${tokens.colors.border}`, overflow: 'hidden',
      }}>
        {children}
      </div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${tokens.colors.border}` }}>
      {children}
    </div>
  );
}

const metaRowStyle: React.CSSProperties = { fontSize: '11px', color: tokens.colors.textMuted, marginTop: 2 };

export default function WorkflowHealthDashboard() {
  const [rollup, setRollup] = useState<WorkflowHealthRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // All-time 누적(ticket 090abc77) — 별도 state/fetch로 분리해 15초
  // autoRefresh 폴링에 얹지 않는다(all-time 집계는 그 정도 신선도가 불요).
  const [longTerm, setLongTerm] = useState<WorkflowHealthLongTermUsage | null>(null);
  const [longTermError, setLongTermError] = useState<string | null>(null);

  const fetchRollup = useCallback(async () => {
    try {
      const data = await api.getWorkflowHealth();
      setRollup(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message || '워크플로 헬스 데이터를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchLongTerm = useCallback(async () => {
    try {
      const data = await api.getLongTermUsage();
      setLongTerm(data);
      setLongTermError(null);
    } catch (err: any) {
      setLongTermError(err?.message || '전체 기간 사용량을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchRollup();
    fetchLongTerm();
  }, [fetchRollup, fetchLongTerm]);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchRollup, POLL_INTERVAL);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchRollup]);

  const handleRefresh = () => {
    setLoading(true);
    fetchRollup();
    fetchLongTerm();
  };

  if (loading && !rollup) {
    return <div style={{ fontSize: '13px', color: tokens.colors.textSecondary, padding: 24 }}>불러오는 중…</div>;
  }

  if (error && !rollup) {
    return <ErrorState message={error} onRetry={handleRefresh} />;
  }

  if (!rollup) return null;

  const { active_storms, top_respawns, suppression_stats, qa_pass_trend, token_usage } = rollup;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: '12px', color: tokens.colors.textMuted }}>
          갱신: {new Date(rollup.generated_at).toLocaleTimeString()} · 관측 window {rollup.window_minutes}분
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: '12px', color: tokens.colors.textSecondary, cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              style={{ accentColor: tokens.colors.accent }}
            />
            자동 새로고침
          </label>
          <button
            onClick={handleRefresh}
            disabled={loading}
            style={{
              padding: '6px 14px', borderRadius: tokens.radii.md,
              background: tokens.colors.border, border: 'none',
              color: tokens.colors.textStrong, fontSize: '12px', fontWeight: 500,
              cursor: loading ? 'default' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? '불러오는 중...' : '새로고침'}
          </button>
        </div>
      </div>

      {/* Summary tiles */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12, marginBottom: 24,
      }}>
        <SummaryTile
          label="현재 halt된 티켓"
          value={String(active_storms.length)}
          accent={active_storms.length > 0 ? tokens.colors.danger : tokens.colors.successLight}
        />
        <SummaryTile label="pending 티켓 (전체 사유)" value={String(rollup.pending_tickets)} />
        <SummaryTile label="지연 대기 알림" value={String(rollup.stale_wait_alerts)} />
        <SummaryTile label="평균 사이클 타임(30일)" value={formatDuration(rollup.avg_cycle_time_ms)} />
        <SummaryTile
          label="QA 통과(7일)"
          value={qa_pass_trend.total > 0 ? `${qa_pass_trend.passed}/${qa_pass_trend.total}` : '—'}
        />
      </div>

      {/* Suppression stats — 억제 횟수 누적치 */}
      <Section title="억제(suppression) 누적 통계">
        <div style={{ padding: '12px 14px', display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>Respawn-storm halt 누적</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>
              {suppression_stats.respawn_storm.total_halts}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>Twin 감지 누적</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>
              {suppression_stats.respawn_storm.total_twins}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>댓글 핑퐁 억제 누적</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>
              {suppression_stats.comment_pingpong.total}
            </div>
          </div>
        </div>
        <div style={{
          padding: '4px 14px 14px 14px', display: 'flex', flexDirection: 'column', gap: 6,
          borderTop: `1px solid ${tokens.colors.border}`,
        }}>
          {SUPPRESSION_REASONS.map(({ key, label }) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', paddingTop: 8 }}>
              <span style={{ color: tokens.colors.textSecondary }}>{label}</span>
              <span style={{ color: tokens.colors.textStrong, fontWeight: 600 }}>
                {suppression_stats.comment_pingpong.by_reason[key] ?? 0}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Token/cost usage — 실측 토큰·비용 + 억제 절감 추정 (ticket 6dd3f968) */}
      <Section title="토큰/비용 사용량 (추정)">
        {!token_usage ? (
          <EmptyState title="사용량 데이터를 불러올 수 없음" description="집계 쿼리가 실패했습니다. 새로고침 후에도 반복되면 서버 로그를 확인하세요." />
        ) : (
          <div>
            <div style={{ padding: '12px 14px', display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>입력 토큰 ({token_usage.window_minutes}분)</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>
                  {formatTokens(token_usage.totals.input_tokens)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>출력 토큰 ({token_usage.window_minutes}분)</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>
                  {formatTokens(token_usage.totals.output_tokens)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>비용 — CLI 보고 기준</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>
                  {formatUsd(token_usage.totals.total_cost_usd)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>억제 절감 추정</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.successLight }}>
                  {formatUsd(token_usage.estimated_saved_usd)}
                </div>
              </div>
            </div>
            <div style={{
              padding: '4px 14px 14px 14px', fontSize: '11px', color: tokens.colors.textMuted,
              borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 8,
            }}>
              계측된 run: {token_usage.coverage.runs_with_usage}/{token_usage.coverage.runs_total}
              {' · '}비용 계측 run(avg {formatUsd(token_usage.avg_cost_per_run_usd_priced_only)}/run): {token_usage.priced_runs}
              {' · '}윈도우 내 억제 이벤트: {token_usage.suppressed_attempts_in_window}건
              {' · '}Codex/Antigravity/DeepSeek 등 미계측·비계측 CLI는 위 비용에서 제외됨(하한 추정)
            </div>
            {token_usage.top_tickets.length > 0 && (
              <div style={{ borderTop: `1px solid ${tokens.colors.border}` }}>
                {token_usage.top_tickets.map(t => (
                  <Row key={t.ticket_id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <div style={{ fontWeight: 600, color: tokens.colors.textPrimary, fontSize: '13px' }}>{t.ticket_title}</div>
                      <div style={{ color: tokens.colors.textStrong, fontWeight: 700, fontSize: '13px' }}>
                        {formatTokens(t.input_tokens + t.output_tokens)} 토큰
                      </div>
                    </div>
                    <div style={metaRowStyle}>run {t.runs}회 · {formatUsd(t.total_cost_usd)}</div>
                  </Row>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* All-time 누적 사용량 (ticket 8d5c6f5d 설계 → 090abc77 노출) — rollup+live
          merge, 마진/gap 없음. 15초 autoRefresh 폴링과 무관하게 mount 시/수동
          새로고침 시에만 갱신된다(위 fetchLongTerm 참고). */}
      <Section title="전체 기간 누적 사용량 (all-time)">
        {longTermError ? (
          <EmptyState title="전체 기간 사용량을 불러올 수 없음" description={longTermError} />
        ) : !longTerm ? (
          <div style={{ padding: '12px 14px', fontSize: '13px', color: tokens.colors.textSecondary }}>불러오는 중…</div>
        ) : (
          <div>
            <div style={{ padding: '12px 14px', display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>입력 토큰 (전체 기간)</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>
                  {formatTokens(longTerm.totals.input_tokens)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>출력 토큰 (전체 기간)</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>
                  {formatTokens(longTerm.totals.output_tokens)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>비용 — CLI 보고 기준 (전체 기간)</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>
                  {formatUsd(longTerm.totals.total_cost_usd)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: tokens.colors.textSecondary }}>run당 평균 비용(비용 계측분)</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary }}>
                  {formatUsd(longTerm.avg_cost_per_run_usd_priced_only)}
                </div>
              </div>
            </div>
            <div style={{
              padding: '4px 14px 14px 14px', fontSize: '11px', color: tokens.colors.textMuted,
              borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 8,
            }}>
              구간: {longTerm.from ? `${longTerm.from} ~ ${longTerm.to}` : `전체 ~ ${longTerm.to}`}
              {' · '}계측된 run: {longTerm.coverage.runs_with_usage}/{longTerm.coverage.runs_total}
              {' · '}비용 계측 run: {longTerm.priced_runs}
              {' · '}영속 롤업(rollup) + 아직 reap 안 된 최근 run(live)을 합산한 값 — 위 윈도우 타일과 달리 마진 없이 정확함
            </div>
          </div>
        )}
      </Section>

      {/* Active storms — 현재 halt 중 */}
      <Section title={`현재 halt 중인 티켓 (${active_storms.length})`}>
        {active_storms.length === 0 ? (
          <EmptyState title="halt 중인 티켓 없음" description="respawn-storm으로 자동 정지된 티켓이 없습니다." />
        ) : (
          <div>
            {active_storms.map(s => (
              <Row key={s.ticket_id}>
                <div style={{ fontWeight: 600, color: tokens.colors.textPrimary, fontSize: '13px' }}>{s.title}</div>
                <div style={metaRowStyle}>
                  {s.board_name} · pending since {formatTime(s.pending_set_at)}
                  {s.first_death_at && <> · 최초 사망(loop 시작점) {formatTime(s.first_death_at)}</>}
                </div>
                {s.agent_ids.length > 0 && (
                  <div style={metaRowStyle}>참여 agent: {s.agent_ids.join(', ')}</div>
                )}
                {s.pending_reason && (
                  <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginTop: 6, whiteSpace: 'pre-wrap' }}>
                    {s.pending_reason}
                  </div>
                )}
              </Row>
            ))}
          </div>
        )}
      </Section>

      {/* Top respawns — quick-death 상위 */}
      <Section title="Quick-death 상위 (ticket × role)">
        {top_respawns.length === 0 ? (
          <EmptyState title="최근 quick-death 없음" description="최근 window 내 비정상 즉사가 감지되지 않았습니다." />
        ) : (
          <div>
            {top_respawns.map(r => (
              <Row key={`${r.ticket_id}-${r.role}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div style={{ fontWeight: 600, color: tokens.colors.textPrimary, fontSize: '13px' }}>{r.title}</div>
                  <div style={{ color: tokens.colors.danger, fontWeight: 700, fontSize: '13px' }}>{r.deaths}회</div>
                </div>
                <div style={metaRowStyle}>{r.board_name} · role={r.role}</div>
                {r.agent_ids.length > 0 && (
                  <div style={metaRowStyle}>참여 agent: {r.agent_ids.join(', ')}</div>
                )}
              </Row>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
