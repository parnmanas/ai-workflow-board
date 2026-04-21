import React, { useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { Button } from '../common';

interface TraceEvent {
  t: number;
  type: string;
  [k: string]: any;
}

interface TestResult {
  name: string;
  category: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  duration_ms: number;
  error?: string;
  detail?: string;
  trace?: TraceEvent[];
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
  warnings?: string[];
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
  'Flow-Lifecycle': 'F',
  'Flow-Comment': 'F',
  'Flow-MCP': 'F',
  'Flow-Concurrency': 'F',
  'Flow-Chat': 'F',
  'Flow-Scale': 'F',
};

// Copy-to-clipboard helper with short-lived feedback so users can tell the
// button actually fired. Falls back to document.execCommand for older
// browsers / non-HTTPS contexts where navigator.clipboard is undefined.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ payload, label = 'Copy' }: { payload: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(payload);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }
      }}
      style={{
        background: copied ? `${tokens.colors.successLight}20` : 'transparent',
        color: copied ? tokens.colors.successLight : tokens.colors.textMuted,
        border: `1px solid ${copied ? tokens.colors.successLight : tokens.colors.border}`,
        borderRadius: tokens.radii.sm,
        fontSize: '10px',
        fontWeight: 600,
        padding: '2px 8px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}

// ─── Timeline renderer ─────────────────────────────────────────────
//
// The test subprocess writes a structured event log (step() markers,
// fixtures created, SSE frames received, MCP request/response pairs, etc.)
// to a trace file that the server attaches to each TestResult. We render it
// as a vertical timeline with per-event expand-for-details so users can
// inspect the exact wire payloads — especially the MCP tool args + result —
// that the virtual agents exchanged with the server.

const TRACE_TYPE_META: Record<string, { icon: string; color: string; label: string }> = {
  'trace-start':     { icon: '▶', color: '#64748b', label: 'trace start' },
  'trace-end':       { icon: '⏹', color: '#64748b', label: 'trace end' },
  'trace-overflow':  { icon: '⚠', color: '#f59e0b', label: 'trace overflow' },
  'boot-start':      { icon: '⚙', color: '#a78bfa', label: 'boot start' },
  'boot-ok':         { icon: '✓', color: '#a78bfa', label: 'boot ok' },
  'step':            { icon: '◆', color: '#60a5fa', label: 'STEP' },
  'fixture':         { icon: '+', color: '#34d399', label: 'fixture' },
  'sse-open':        { icon: '⇢', color: '#22d3ee', label: 'SSE open' },
  'sse-close':       { icon: '⇠', color: '#22d3ee', label: 'SSE close' },
  'sse-frame':       { icon: '◉', color: '#22d3ee', label: 'SSE frame' },
  'mcp-request':     { icon: '→', color: '#38bdf8', label: 'MCP →' },
  'mcp-response':    { icon: '←', color: '#10b981', label: 'MCP ←' },
  'db-op':           { icon: '→', color: '#fb923c', label: 'DB →' },
  'db-result':       { icon: '←', color: '#f97316', label: 'DB ←' },
  'service-call':    { icon: '→', color: '#c084fc', label: 'SVC →' },
  'service-result':  { icon: '←', color: '#a855f7', label: 'SVC ←' },
};

function formatEventSummary(ev: TraceEvent): string {
  switch (ev.type) {
    case 'trace-start':
      return `${ev.test_file || ''} (pid ${ev.pid || '?'})`;
    case 'trace-end':
      return `${ev.events || '?'} events captured`;
    case 'trace-overflow':
      return `truncated after ${ev.dropped_after} events`;
    case 'boot-start':
      return `port=${ev.port}`;
    case 'boot-ok':
      return `ready on ${ev.port} (${ev.duration_ms}ms)`;
    case 'step':
      return String(ev.label || '');
    case 'fixture': {
      const id = typeof ev.id === 'string' ? ev.id.slice(0, 8) : ev.id;
      const extras: string[] = [];
      if (ev.name) extras.push(ev.name);
      if (ev.role) extras.push(`role=${ev.role}`);
      if (ev.title) extras.push(`"${ev.title}"`);
      if (ev.is_terminal) extras.push('TERMINAL');
      return `${ev.kind} ${id}${extras.length ? ' — ' + extras.join(', ') : ''}`;
    }
    case 'sse-open':
      return `agent=${ev.agent} (id=${(ev.agent_id || '').toString().slice(0, 8)})`;
    case 'sse-close':
      return `agent=${ev.agent}`;
    case 'sse-frame': {
      const d = ev.data || {};
      const bits: string[] = [];
      if (d.ticket_id) bits.push(`ticket=${String(d.ticket_id).slice(0, 8)}`);
      if (d.action) bits.push(`action=${d.action}`);
      if (d.role) bits.push(`role=${d.role}`);
      if (d.trigger_source) bits.push(`src=${d.trigger_source}`);
      if (d?.payload?.content) bits.push(`content="${String(d.payload.content).slice(0, 40)}"`);
      if (d.mention_source) bits.push(`mention=${d.mention_source}`);
      return `[${ev.event}] to agent=${ev.agent}${bits.length ? ' · ' + bits.join(' ') : ''}`;
    }
    case 'mcp-request': {
      const toolName = ev.params?.name ? ` ${ev.params.name}` : '';
      return `${ev.method}${toolName} (id=${ev.id}) agent=${ev.agent || '?'}`;
    }
    case 'mcp-response': {
      const tag = ev.error ? `ERROR ${ev.error.code || ''}` : `${ev.status || '??'} OK`;
      return `${ev.method} (id=${ev.id}) ${tag} ${ev.duration_ms}ms`;
    }
    case 'db-op': {
      const a = ev.args || {};
      const bits: string[] = [];
      if (a.where) bits.push(`where=${JSON.stringify(a.where).slice(0, 60)}`);
      if (a.relations) bits.push(`relations=[${(a.relations || []).join(',')}]`);
      if (a.count !== undefined) bits.push(`batch=${a.count}`);
      if (a.name) bits.push(`name="${a.name}"`);
      if (a.title) bits.push(`title="${a.title}"`);
      return `${ev.entity}.${ev.op}${bits.length ? ' ' + bits.join(' ') : ''}`;
    }
    case 'db-result': {
      if (ev.error) return `${ev.entity}.${ev.op} ERROR (${ev.duration_ms}ms): ${ev.error}`;
      const r = ev.result || {};
      const bits: string[] = [];
      if (r.id) bits.push(`id=${String(r.id).slice(0, 8)}`);
      if (r.count !== undefined) bits.push(`count=${r.count}`);
      if (r.affected !== undefined) bits.push(`affected=${r.affected}`);
      return `${ev.entity}.${ev.op} OK (${ev.duration_ms}ms)${bits.length ? ' · ' + bits.join(' ') : ''}`;
    }
    case 'service-call': {
      const a = ev.args;
      const argLabel = typeof a === 'string' ? `"${a.slice(0, 60)}"`
        : (a && typeof a === 'object' && a.name) ? `name="${a.name}"`
        : '';
      return `${ev.service}.${ev.method}(${argLabel})`;
    }
    case 'service-result': {
      if (ev.error) return `${ev.service}.${ev.method} ERROR (${ev.duration_ms}ms): ${ev.error}`;
      const r = ev.result || {};
      const bits: string[] = [];
      if (r.id) bits.push(`id=${String(r.id).slice(0, 8)}`);
      if (typeof ev.result === 'boolean') bits.push(`ok=${ev.result}`);
      return `${ev.service}.${ev.method} OK (${ev.duration_ms}ms)${bits.length ? ' · ' + bits.join(' ') : ''}`;
    }
    default:
      return '';
  }
}

function TimelineEventRow({ ev }: { ev: TraceEvent }) {
  const meta = TRACE_TYPE_META[ev.type] || { icon: '·', color: '#94a3b8', label: ev.type };
  const summary = formatEventSummary(ev);
  // Build payload for the expandable details. We omit the already-summarized
  // keys so the <details> shows the rest (e.g. full result body of MCP calls).
  const { t, type, ...rest } = ev; void t; void type;
  const hasDetail = Object.keys(rest).length > 0;
  const payloadText = hasDetail ? JSON.stringify(rest, null, 2) : '';

  const tsLabel = `+${String(ev.t).padStart(4, ' ')}ms`;
  const isStep = ev.type === 'step';

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '3px 0',
      borderLeft: isStep ? `2px solid ${meta.color}` : 'none',
      paddingLeft: isStep ? 6 : 8,
      background: isStep ? `${meta.color}10` : 'transparent',
      borderRadius: isStep ? 3 : 0,
      margin: isStep ? '4px 0' : 0,
    }}>
      <span style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '10px', color: tokens.colors.textMuted, flexShrink: 0, paddingTop: 2,
        minWidth: 54, textAlign: 'right',
      }}>{tsLabel}</span>
      <span style={{ color: meta.color, fontWeight: 700, flexShrink: 0, paddingTop: 1, minWidth: 14, textAlign: 'center' }}>
        {meta.icon}
      </span>
      <span style={{
        fontSize: '10px', fontWeight: 600, color: meta.color, flexShrink: 0, paddingTop: 2,
        minWidth: 64, textTransform: 'uppercase', letterSpacing: '0.3px',
      }}>{meta.label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '11px', color: isStep ? tokens.colors.textStrong : tokens.colors.textSecondary,
          fontWeight: isStep ? 600 : 400,
          fontFamily: ev.type.startsWith('mcp-') || ev.type.startsWith('sse-')
            ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
            : undefined,
          wordBreak: 'break-word',
        }}>{summary}</div>
        {hasDetail && (
          <details style={{ marginTop: 2 }}>
            <summary style={{
              cursor: 'pointer', fontSize: '9px', color: tokens.colors.textMuted,
              textTransform: 'uppercase', letterSpacing: '0.3px',
            }}>payload</summary>
            <pre style={{
              margin: '3px 0 0', fontSize: '10px', color: tokens.colors.textSecondary,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              background: tokens.colors.surfaceCard, padding: 6, borderRadius: 3,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              maxHeight: 300, overflowY: 'auto',
            }}>{payloadText}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function traceStatsSummary(trace: TraceEvent[]): string {
  const counts: Record<string, number> = {};
  for (const ev of trace) counts[ev.type] = (counts[ev.type] || 0) + 1;
  const bits: string[] = [];
  if (counts['step']) bits.push(`${counts['step']} step${counts['step'] === 1 ? '' : 's'}`);
  if (counts['fixture']) bits.push(`${counts['fixture']} fixture${counts['fixture'] === 1 ? '' : 's'}`);
  if (counts['db-op']) bits.push(`${counts['db-op']} DB op${counts['db-op'] === 1 ? '' : 's'}`);
  if (counts['service-call']) bits.push(`${counts['service-call']} service call${counts['service-call'] === 1 ? '' : 's'}`);
  const mcpPairs = counts['mcp-request'] || 0;
  if (mcpPairs) bits.push(`${mcpPairs} MCP call${mcpPairs === 1 ? '' : 's'}`);
  if (counts['sse-frame']) bits.push(`${counts['sse-frame']} SSE frame${counts['sse-frame'] === 1 ? '' : 's'}`);
  return bits.join(' · ') || `${trace.length} events`;
}

function buildTimelineCopyText(testName: string, trace: TraceEvent[]): string {
  const lines: string[] = [];
  lines.push(`=== ${testName} timeline (${trace.length} events) ===`);
  for (const ev of trace) {
    const summary = formatEventSummary(ev);
    lines.push(`[+${ev.t}ms] ${ev.type.padEnd(14)} ${summary}`);
    const { t, type, ...rest } = ev; void t; void type;
    if (Object.keys(rest).length > 0) {
      lines.push('  ' + JSON.stringify(rest).slice(0, 500));
    }
  }
  return lines.join('\n');
}

function TestTimeline({ testName, trace }: { testName: string; trace: TraceEvent[] }) {
  const [open, setOpen] = useState(false);
  if (!trace || trace.length === 0) return null;
  return (
    <div style={{ marginTop: 8, borderTop: `1px dashed ${tokens.colors.border}`, paddingTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} style={{
          background: 'transparent', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm,
          color: tokens.colors.textSecondary, fontSize: '10px', padding: '2px 10px', cursor: 'pointer',
          fontWeight: 600,
        }}>
          {open ? '▼' : '▶'} Timeline ({traceStatsSummary(trace)})
        </button>
        <CopyButton payload={buildTimelineCopyText(testName, trace)} label="Copy Timeline" />
      </div>
      {open && (
        <div style={{
          marginTop: 6, padding: '8px 10px',
          background: tokens.colors.surfaceCard, borderRadius: tokens.radii.sm,
          border: `1px solid ${tokens.colors.border}`,
          maxHeight: 500, overflowY: 'auto',
        }}>
          {trace.map((ev, idx) => (
            <TimelineEventRow key={idx} ev={ev} />
          ))}
        </div>
      )}
    </div>
  );
}

function buildFullReportText(report: QAReport, heading: string): string {
  const lines: string[] = [];
  lines.push(`${heading} — run_at=${report.run_at} duration=${report.duration_ms}ms`);
  lines.push(
    `Total=${report.summary.total} Pass=${report.summary.passed} Fail=${report.summary.failed} Skip=${report.summary.skipped} (pass_rate=${report.summary.pass_rate})`,
  );
  if (report.warnings?.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  for (const r of report.results) {
    if (r.status === 'PASS') continue;
    lines.push('');
    lines.push(`[${r.status}] ${r.category} / ${r.name} (${r.duration_ms}ms)`);
    if (r.error) lines.push(r.error);
    if (r.detail && r.detail !== r.error) {
      lines.push('--- detail ---');
      lines.push(r.detail);
    }
  }
  return lines.join('\n');
}

type SuiteKind = 'basic' | 'flow';

export default function QaRunner() {
  const [running, setRunning] = useState<SuiteKind | null>(null);
  const [report, setReport] = useState<QAReport | null>(null);
  const [reportKind, setReportKind] = useState<SuiteKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const runSuite = async (kind: SuiteKind) => {
    setRunning(kind);
    setReport(null);
    setReportKind(null);
    setError(null);
    try {
      const result = kind === 'flow' ? await api.runQaFlows() : await api.runQa();
      setReport(result);
      setReportKind(kind);
      // Auto-expand failed categories so users don't have to hunt for errors.
      const failedCats = new Set<string>();
      result.results.forEach((r: TestResult) => {
        if (r.status === 'FAIL') failedCats.add(r.category);
      });
      setExpandedCategories(failedCats);
    } catch (err: any) {
      setError(err.message || `${kind === 'flow' ? 'Flow' : 'QA'} test failed`);
    } finally {
      setRunning(null);
    }
  };
  const handleRun = () => runSuite('basic');
  const handleRunFlows = () => runSuite('flow');

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
        <div style={{ fontSize: 13, color: tokens.colors.textMuted, lineHeight: 1.5 }}>
          <div><strong style={{ color: tokens.colors.textSecondary }}>Basic QA:</strong> CRUD API coverage on a throwaway workspace (~2s).</div>
          <div>
            <strong style={{ color: tokens.colors.textSecondary }}>Flow Tests:</strong> End-to-end agent/MCP/SSE scenarios in subprocess <code style={{ background: tokens.colors.surfaceCard, padding: '0 4px', borderRadius: 3 }}>node --test</code> (~30-60s).
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <Button
            variant="secondary"
            size="md"
            onClick={handleRun}
            disabled={running !== null}
            loading={running === 'basic'}
          >
            {running === 'basic' ? 'Running...' : 'Run QA Tests'}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleRunFlows}
            disabled={running !== null}
            loading={running === 'flow'}
          >
            {running === 'flow' ? 'Running...' : 'Run Flow Tests'}
          </Button>
        </div>
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
            {running === 'flow' ? 'Running flow tests in subprocess...' : 'Running all API tests...'}
          </div>
          <div style={{ color: tokens.colors.textMuted, fontSize: '11px' }}>
            {running === 'flow'
              ? 'Each flow spins up its own NestJS app (7801+). Expect 30-60s.'
              : 'QA Workspace 생성 → API 테스트 → Cleanup'}
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
              marginBottom: 16, gap: 8,
            }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: tokens.colors.textStrong }}>
                {reportKind === 'flow' ? 'Flow Test Summary' : 'Test Summary'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: '11px', color: tokens.colors.textMuted }}>
                  {new Date(report.run_at).toLocaleString()} &middot; {report.duration_ms}ms
                </div>
                {report.summary.failed > 0 && (
                  <CopyButton
                    payload={buildFullReportText(report, reportKind === 'flow' ? 'Flow Tests' : 'QA Tests')}
                    label="Copy All Errors"
                  />
                )}
              </div>
            </div>

            {/* Warnings (flow runner can surface non-sqlite DB advisory etc.) */}
            {report.warnings && report.warnings.length > 0 && (
              <div style={{
                background: '#78350f20', border: `1px solid ${tokens.colors.warningLight}40`,
                borderRadius: tokens.radii.md, padding: '8px 12px', marginBottom: 12,
                fontSize: '11px', color: tokens.colors.warningLight, lineHeight: 1.5,
              }}>
                {report.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
              </div>
            )}

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

            {/* Cleanup Status — only meaningful for the Basic QA harness
                which creates a shared scratch workspace. Flow tests own
                their own scene per file so there's nothing global to clean. */}
            {reportKind !== 'flow' && (
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
            )}
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
                          {r.trace && r.trace.length > 0 && (
                            <TestTimeline testName={`${r.category}/${r.name}`} trace={r.trace} />
                          )}
                          {r.error && (
                            <div style={{
                              marginTop: 4, background: '#7f1d1d15',
                              padding: '6px 8px', borderRadius: tokens.radii.sm,
                              border: `1px solid ${tokens.colors.dangerMid}30`,
                            }}>
                              <div style={{
                                display: 'flex', justifyContent: 'space-between',
                                alignItems: 'center', gap: 8, marginBottom: 4,
                              }}>
                                <span style={{ fontSize: '10px', fontWeight: 600, color: tokens.colors.dangerMid, textTransform: 'uppercase' }}>
                                  Error
                                </span>
                                <CopyButton
                                  payload={
                                    r.detail && r.detail !== r.error
                                      ? `[${r.category} / ${r.name}]\n${r.error}\n--- detail ---\n${r.detail}`
                                      : `[${r.category} / ${r.name}]\n${r.error}`
                                  }
                                  label="Copy"
                                />
                              </div>
                              <pre style={{
                                margin: 0, fontSize: '11px', color: tokens.colors.dangerMid,
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                maxHeight: 240, overflowY: 'auto',
                              }}>{r.error}</pre>
                              {r.detail && r.detail !== r.error && (
                                <details style={{ marginTop: 6 }}>
                                  <summary style={{
                                    cursor: 'pointer', fontSize: '10px', fontWeight: 600,
                                    color: tokens.colors.textMuted,
                                  }}>Full subprocess output</summary>
                                  <pre style={{
                                    margin: '6px 0 0', fontSize: '10px', color: tokens.colors.textSecondary,
                                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                    maxHeight: 320, overflowY: 'auto',
                                    background: tokens.colors.surfaceCard, padding: 6, borderRadius: 3,
                                  }}>{r.detail}</pre>
                                </details>
                              )}
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
