import React, { useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { Button } from '../common';

interface TestResult {
  name: string;
  category: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  duration_ms: number;
  error?: string;
  detail?: string;
}

interface QAReport {
  run_at: string;
  duration_ms: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pass_rate: string;
  };
  categories: Record<string, { passed: number; failed: number; skipped: number }>;
  results: TestResult[];
  cleanup: { workspace_deleted: boolean; error?: string };
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PASS: { bg: '#065f4620', text: tokens.colors.successLight },
  FAIL: { bg: '#7f1d1d20', text: tokens.colors.dangerMid },
  SKIP: { bg: '#78350f20', text: tokens.colors.warningLight },
};

const CATEGORY_ICONS: Record<string, string> = {
  Workspace: 'W',
  Board: 'B',
  Column: 'C',
  Ticket: 'T',
  Subtask: 'S',
  Comment: 'M',
  Activity: 'L',
  User: 'U',
  Agent: 'A',
  Channel: 'N',
  ApiKey: 'K',
  Validation: 'V',
  Cleanup: 'X',
};

export default function QaRunner() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<QAReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const handleRun = async () => {
    setRunning(true);
    setReport(null);
    setError(null);
    try {
      const result = await api.runQa();
      setReport(result);
      // Auto-expand failed categories
      const failedCats = new Set<string>();
      result.results.forEach((r: TestResult) => {
        if (r.status === 'FAIL') failedCats.add(r.category);
      });
      setExpandedCategories(failedCats);
    } catch (err: any) {
      setError(err.message || 'QA test failed');
    } finally {
      setRunning(false);
    }
  };

  const toggleCategory = (cat: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const expandAll = () => {
    if (!report) return;
    setExpandedCategories(new Set(Object.keys(report.categories)));
  };

  const collapseAll = () => {
    setExpandedCategories(new Set());
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>Automated API test suite</span>
        <Button
          variant="primary"
          size="md"
          onClick={handleRun}
          disabled={running}
          loading={running}
        >
          {running ? 'Running...' : 'Run QA Tests'}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          background: '#7f1d1d20', border: `1px solid ${tokens.colors.dangerBg}`, borderRadius: tokens.radii.lg,
          padding: '12px 16px', marginBottom: 16,
        }}>
          <div style={{ color: tokens.colors.dangerMid, fontSize: '13px', fontWeight: 600 }}>Error</div>
          <div style={{ color: tokens.colors.dangerLight, fontSize: '12px', marginTop: 4 }}>{error}</div>
        </div>
      )}

      {/* Running indicator */}
      {running && !report && (
        <div style={{
          background: tokens.colors.surface, borderRadius: tokens.radii.lg, padding: '40px 20px',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
          border: `1px solid ${tokens.colors.border}`,
        }}>
          <div style={{
            width: 40, height: 40,
            border: `3px solid ${tokens.colors.border}`,
            borderTopColor: tokens.colors.accent,
            borderRadius: tokens.radii.full,
            animation: 'spin 0.8s linear infinite',
          }} />
          <div style={{ color: tokens.colors.textSecondary, fontSize: '13px' }}>
            Running all API tests...
          </div>
          <div style={{ color: tokens.colors.textMuted, fontSize: '11px' }}>
            QA Workspace 생성 → API 테스트 → Cleanup
          </div>
        </div>
      )}

      {/* Report */}
      {report && (
        <div>
          {/* Summary Card */}
          <div style={{
            background: tokens.colors.surface, borderRadius: 10, padding: 16,
            border: `1px solid ${tokens.colors.border}`, marginBottom: 16,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 16,
            }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: tokens.colors.textStrong }}>Test Summary</div>
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted }}>
                {new Date(report.run_at).toLocaleString()} &middot; {report.duration_ms}ms
              </div>
            </div>

            {/* Summary Stats */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              {/* Pass Rate */}
              <div style={{
                flex: 1, background: tokens.colors.surfaceCard, borderRadius: tokens.radii.lg, padding: '14px 16px',
                textAlign: 'center', border: `1px solid ${tokens.colors.border}`,
              }}>
                <div style={{
                  fontSize: '28px', fontWeight: 700,
                  color: report.summary.failed === 0 ? tokens.colors.successLight : tokens.colors.dangerMid,
                }}>
                  {report.summary.pass_rate}
                </div>
                <div style={{ fontSize: '10px', color: tokens.colors.textMuted, textTransform: 'uppercase', marginTop: 4 }}>
                  Pass Rate
                </div>
              </div>

              {/* Passed */}
              <div style={{
                flex: 1, background: tokens.colors.surfaceCard, borderRadius: tokens.radii.lg, padding: '14px 16px',
                textAlign: 'center', border: `1px solid ${tokens.colors.border}`,
              }}>
                <div style={{ fontSize: '28px', fontWeight: 700, color: tokens.colors.successLight }}>
                  {report.summary.passed}
                </div>
                <div style={{ fontSize: '10px', color: tokens.colors.textMuted, textTransform: 'uppercase', marginTop: 4 }}>
                  Passed
                </div>
              </div>

              {/* Failed */}
              <div style={{
                flex: 1, background: tokens.colors.surfaceCard, borderRadius: tokens.radii.lg, padding: '14px 16px',
                textAlign: 'center', border: `1px solid ${tokens.colors.border}`,
              }}>
                <div style={{ fontSize: '28px', fontWeight: 700, color: report.summary.failed > 0 ? tokens.colors.dangerMid : tokens.colors.textMuted }}>
                  {report.summary.failed}
                </div>
                <div style={{ fontSize: '10px', color: tokens.colors.textMuted, textTransform: 'uppercase', marginTop: 4 }}>
                  Failed
                </div>
              </div>

              {/* Total */}
              <div style={{
                flex: 1, background: tokens.colors.surfaceCard, borderRadius: tokens.radii.lg, padding: '14px 16px',
                textAlign: 'center', border: `1px solid ${tokens.colors.border}`,
              }}>
                <div style={{ fontSize: '28px', fontWeight: 700, color: tokens.colors.textSecondary }}>
                  {report.summary.total}
                </div>
                <div style={{ fontSize: '10px', color: tokens.colors.textMuted, textTransform: 'uppercase', marginTop: 4 }}>
                  Total
                </div>
              </div>
            </div>

            {/* Cleanup Status */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px', borderRadius: tokens.radii.md,
              background: report.cleanup.workspace_deleted ? '#065f4610' : '#7f1d1d10',
              border: `1px solid ${report.cleanup.workspace_deleted ? '#065f4640' : '#7f1d1d40'}`,
            }}>
              <span style={{
                fontSize: '13px',
                color: report.cleanup.workspace_deleted ? tokens.colors.successLight : tokens.colors.dangerMid,
              }}>
                {report.cleanup.workspace_deleted ? '\u2713' : '\u2717'}
              </span>
              <span style={{ fontSize: '12px', color: tokens.colors.textSecondary }}>
                QA Workspace cleanup: {report.cleanup.workspace_deleted ? 'Deleted successfully' : (report.cleanup.error || 'Not deleted')}
              </span>
            </div>
          </div>

          {/* Expand/Collapse Controls */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button onClick={expandAll} style={{
              background: 'transparent', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
              color: tokens.colors.textMuted, fontSize: '11px', padding: '4px 10px', cursor: 'pointer',
            }}>Expand All</button>
            <button onClick={collapseAll} style={{
              background: 'transparent', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
              color: tokens.colors.textMuted, fontSize: '11px', padding: '4px 10px', cursor: 'pointer',
            }}>Collapse All</button>
          </div>

          {/* Category Results */}
          {Object.entries(report.categories).map(([category, stats]) => {
            const isExpanded = expandedCategories.has(category);
            const categoryResults = report.results.filter(r => r.category === category);
            const hasFails = stats.failed > 0;

            return (
              <div key={category} style={{
                background: tokens.colors.surface, borderRadius: tokens.radii.lg, marginBottom: 8,
                border: `1px solid ${hasFails ? '#7f1d1d40' : tokens.colors.border}`,
                overflow: 'hidden',
              }}>
                {/* Category Header */}
                <button
                  onClick={() => toggleCategory(category)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                    padding: '10px 14px', background: 'transparent', border: 'none',
                    cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  {/* Expand Arrow */}
                  <span style={{
                    color: tokens.colors.textMuted, fontSize: '10px', transition: 'transform 0.15s',
                    transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    display: 'inline-block', width: 12,
                  }}>{'\u25B6'}</span>

                  {/* Category Icon */}
                  <span style={{
                    width: 22, height: 22, borderRadius: 5,
                    background: hasFails ? '#7f1d1d30' : '#33415560',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '10px', fontWeight: 700,
                    color: hasFails ? tokens.colors.dangerMid : tokens.colors.textSecondary,
                    flexShrink: 0,
                  }}>{CATEGORY_ICONS[category] || '?'}</span>

                  {/* Category Name */}
                  <span style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textStrong, flex: 1 }}>
                    {category}
                  </span>

                  {/* Stats Badges */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    {stats.passed > 0 && (
                      <span style={{
                        fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                        background: STATUS_COLORS.PASS.bg, color: STATUS_COLORS.PASS.text,
                      }}>{stats.passed} PASS</span>
                    )}
                    {stats.failed > 0 && (
                      <span style={{
                        fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                        background: STATUS_COLORS.FAIL.bg, color: STATUS_COLORS.FAIL.text,
                      }}>{stats.failed} FAIL</span>
                    )}
                    {stats.skipped > 0 && (
                      <span style={{
                        fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                        background: STATUS_COLORS.SKIP.bg, color: STATUS_COLORS.SKIP.text,
                      }}>{stats.skipped} SKIP</span>
                    )}
                  </div>
                </button>

                {/* Expanded Results */}
                {isExpanded && (
                  <div style={{ borderTop: `1px solid ${tokens.colors.border}`, padding: '8px 14px 10px' }}>
                    {categoryResults.map((r, idx) => (
                      <div key={idx} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 10,
                        padding: '6px 0',
                        borderBottom: idx < categoryResults.length - 1 ? `1px solid ${tokens.colors.surfaceCard}` : 'none',
                      }}>
                        {/* Status Indicator */}
                        <span style={{
                          width: 18, height: 18, borderRadius: tokens.radii.sm, flexShrink: 0, marginTop: 1,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '10px', fontWeight: 700,
                          background: STATUS_COLORS[r.status].bg,
                          color: STATUS_COLORS[r.status].text,
                        }}>
                          {r.status === 'PASS' ? '\u2713' : r.status === 'FAIL' ? '\u2717' : '-'}
                        </span>

                        {/* Test Info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '12px', color: tokens.colors.textStrong, fontWeight: 500 }}>
                            {r.name}
                          </div>
                          {r.detail && (
                            <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 2 }}>
                              {r.detail}
                            </div>
                          )}
                          {r.error && (
                            <div style={{
                              fontSize: '11px', color: tokens.colors.dangerMid, marginTop: 4,
                              background: '#7f1d1d15', padding: '4px 8px', borderRadius: tokens.radii.sm,
                              fontFamily: 'monospace',
                            }}>
                              {r.error}
                            </div>
                          )}
                        </div>

                        {/* Duration */}
                        <span style={{ fontSize: '10px', color: tokens.colors.borderStrong, flexShrink: 0, marginTop: 2 }}>
                          {r.duration_ms}ms
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
