import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useBoard } from '../hooks/useBoard';
import { useToast } from '../contexts/ToastContext';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';
import { Button } from './common';

/**
 * Benchmark leaderboard view (ticket 684c012b). Two panels:
 *   1. Agent leaderboard — every agent ranked by the average score its
 *      candidates received across all runs in this board's workspace
 *      (GET /api/benchmark/leaderboard?workspace_id=…).
 *   2. Per-run breakdown — pick a run (parent ticket) to see each candidate's
 *      per-dimension averages + the raw evaluator score breakdown
 *      (GET /api/benchmark/runs/:runTicketId/leaderboard).
 *
 * Run ids are discovered from the board's root tickets carrying the
 * `benchmark-run` label (the same label create_benchmark_run stamps).
 */

interface PerDimension {
  dimension: string;
  average: number;
  count: number;
}

interface AgentRow {
  agent_id: string;
  agent_name: string;
  candidate_count: number;
  score_count: number;
  average: number | null;
  per_dimension: PerDimension[];
}

interface CandidateScore {
  evaluator_agent_id: string;
  evaluator_name: string;
  dimension: string;
  score: number;
  rationale: string;
}

interface CandidateRow {
  candidate_ticket_id: string;
  title: string;
  assignee_agent_id: string;
  assignee_name: string;
  score_count: number;
  average: number | null;
  per_dimension: PerDimension[];
  scores: CandidateScore[];
}

interface RunOption {
  id: string;
  title: string;
}

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : Number(n).toFixed(2);

const dimSummary = (dims: PerDimension[]) =>
  dims.length === 0 ? '—' : dims.map((d) => `${d.dimension} ${fmt(d.average)}`).join(' · ');

export default function BenchmarkLeaderboardPage() {
  const { wsId, boardId } = useParams<{ wsId: string; boardId: string }>();
  const { showToast } = useToast();
  const { board } = useBoard(boardId ?? '');

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [runs, setRuns] = useState<RunOption[]>([]);
  const [selectedRun, setSelectedRun] = useState<string>('');
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);

  // Agent-aggregate leaderboard + the run list (board's benchmark-run tickets).
  const loadOverview = useCallback(async () => {
    if (!boardId) return;
    setLoading(true);
    try {
      const wid = board?.workspace_id || wsId || undefined;
      const [agg, full] = await Promise.all([
        api.getBenchmarkLeaderboard(wid),
        api.getBoard(boardId).catch(() => null),
      ]);
      setAgents(Array.isArray(agg?.agents) ? agg.agents : []);

      // Discover runs from the board's root tickets labeled `benchmark-run`.
      // labels may arrive as a string[] (board-card projection) or a raw JSON
      // string depending on the path; normalise both.
      const hasRunLabel = (raw: any): boolean => {
        let labels = raw;
        if (typeof labels === 'string') {
          try { labels = JSON.parse(labels); } catch { labels = []; }
        }
        return Array.isArray(labels) && labels.includes('benchmark-run');
      };
      const tickets: any[] = Array.isArray(full?.columns)
        ? full.columns.flatMap((c: any) => c.tickets || [])
        : [];
      const runOpts: RunOption[] = tickets
        .filter((t) => hasRunLabel(t.labels))
        .map((t) => ({ id: t.id, title: t.title || t.id.slice(0, 8) }));
      setRuns(runOpts);
      setSelectedRun((cur) => cur || (runOpts[0]?.id ?? ''));
    } catch (err: any) {
      showToast(err?.message || 'Failed to load leaderboard', 'error');
    } finally {
      setLoading(false);
    }
  }, [boardId, board?.workspace_id, wsId, showToast]);

  const loadRun = useCallback(async (runId: string) => {
    if (!runId) { setCandidates([]); return; }
    setRunLoading(true);
    try {
      const res = await api.getBenchmarkRunLeaderboard(runId);
      setCandidates(Array.isArray(res?.candidates) ? res.candidates : []);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load run leaderboard', 'error');
    } finally {
      setRunLoading(false);
    }
  }, [showToast]);

  useEffect(() => { loadOverview(); }, [loadOverview]);
  useEffect(() => { loadRun(selectedRun); }, [selectedRun, loadRun]);

  const headerActionStyle: React.CSSProperties = useMemo(() => ({
    padding: '6px 12px',
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    color: tokens.colors.textStrong,
    fontSize: 12,
    textDecoration: 'none',
  }), []);

  const cardStyle: React.CSSProperties = {
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    overflow: 'hidden',
    background: tokens.colors.surfaceCard,
  };
  const headRowStyle = (cols: string): React.CSSProperties => ({
    display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '8px 12px',
    background: tokens.colors.surface, fontSize: 11, fontWeight: 600,
    color: tokens.colors.textMuted, textTransform: 'uppercase',
  });
  const dataRowStyle = (cols: string): React.CSSProperties => ({
    display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '10px 12px',
    borderTop: `1px solid ${tokens.colors.border}`, fontSize: 13, alignItems: 'center',
  });
  const sectionTitle: React.CSSProperties = {
    fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary,
    textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 12px',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Leaderboard"
        description={board?.name}
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={loadOverview} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
            {wsId && boardId ? (
              <a href={`/ws/${wsId}/boards/${boardId}`} style={headerActionStyle}>← Back to Board</a>
            ) : null}
          </div>
        }
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24, display: 'flex', flexDirection: 'column', gap: 28 }}>
        {board && board.benchmark_mode !== 'on' && (
          <div style={{ fontSize: 13, color: tokens.colors.warning }}>
            This board is not in benchmark mode. Enable it in Board Settings to run benchmarks.
          </div>
        )}

        {/* Agent-aggregate leaderboard */}
        <section>
          <h2 style={sectionTitle}>Agent leaderboard</h2>
          {agents.length === 0 && !loading ? (
            <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: 16 }}>
              No scores recorded yet.
            </div>
          ) : (
            <div style={cardStyle}>
              <div style={headRowStyle('32px 2fr 1fr 1fr 3fr')}>
                <div>#</div><div>Agent</div><div>Candidates</div><div>Avg</div><div>Per dimension</div>
              </div>
              {agents.map((a, i) => (
                <div key={a.agent_id} style={dataRowStyle('32px 2fr 1fr 1fr 3fr')}>
                  <div style={{ color: tokens.colors.textMuted }}>{i + 1}</div>
                  <div style={{ fontWeight: 600, color: tokens.colors.textStrong }}>{a.agent_name}</div>
                  <div style={{ color: tokens.colors.textSecondary }}>{a.candidate_count} ({a.score_count} scores)</div>
                  <div style={{ fontWeight: 700, color: tokens.colors.textStrong }}>{fmt(a.average)}</div>
                  <div style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>{dimSummary(a.per_dimension)}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Per-run candidate breakdown */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <h2 style={{ ...sectionTitle, margin: 0 }}>Run breakdown</h2>
            {runs.length > 0 && (
              <select
                value={selectedRun}
                onChange={(e) => setSelectedRun(e.target.value)}
                style={{
                  padding: '6px 10px', fontSize: 13, background: tokens.colors.surface,
                  border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                  color: tokens.colors.textStrong, minWidth: 220,
                }}
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>{r.title}</option>
                ))}
              </select>
            )}
          </div>

          {runs.length === 0 ? (
            <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: 16 }}>
              No benchmark runs on this board yet. Create one with the <code>create_benchmark_run</code> MCP tool.
            </div>
          ) : runLoading ? (
            <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: 16 }}>Loading run…</div>
          ) : candidates.length === 0 ? (
            <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: 16 }}>
              No candidates scored for this run yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {candidates.map((c, i) => (
                <div key={c.candidate_ticket_id} style={cardStyle}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 12, padding: '10px 12px', background: tokens.colors.surface,
                  }}>
                    <div>
                      <span style={{ color: tokens.colors.textMuted, marginRight: 8 }}>#{i + 1}</span>
                      <span style={{ fontWeight: 700, color: tokens.colors.textStrong }}>
                        {c.assignee_name || c.title}
                      </span>
                      <span style={{ fontSize: 11, color: tokens.colors.textMuted, fontFamily: 'monospace', marginLeft: 8 }}>
                        {c.candidate_ticket_id.slice(0, 8)}
                      </span>
                    </div>
                    <div style={{ fontSize: 13 }}>
                      <span style={{ color: tokens.colors.textMuted, marginRight: 6 }}>avg</span>
                      <span style={{ fontWeight: 700, color: tokens.colors.textStrong }}>{fmt(c.average)}</span>
                      <span style={{ color: tokens.colors.textMuted, marginLeft: 10 }}>{dimSummary(c.per_dimension)}</span>
                    </div>
                  </div>
                  {c.scores.length > 0 && (
                    <>
                      <div style={headRowStyle('1.5fr 1fr 0.6fr 3fr')}>
                        <div>Evaluator</div><div>Dimension</div><div>Score</div><div>Rationale</div>
                      </div>
                      {c.scores.map((s, si) => (
                        <div key={si} style={dataRowStyle('1.5fr 1fr 0.6fr 3fr')}>
                          <div style={{ color: tokens.colors.textSecondary }}>{s.evaluator_name}</div>
                          <div style={{ color: tokens.colors.textSecondary }}>{s.dimension}</div>
                          <div style={{ fontWeight: 600, color: tokens.colors.textStrong }}>{fmt(s.score)}</div>
                          <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>{s.rationale || '—'}</div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
