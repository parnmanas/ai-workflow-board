import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { Feature, FeatureStatus } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Select, Modal, Card, Badge } from '../common';

/**
 * Feature/Epic intake manager (ticket aae7644c) — the human-facing surface of the
 * one-stop automated development loop's entry point.
 *
 * Left: intake list (status + rollup progress). Right: selected feature detail —
 * the structured chain PROPOSAL preview with a 1-click Approve / Reject, and the
 * progress rollup once the chain is running. Intake creation ("New Feature") is a
 * modal (title + requirement + planner agent); on submit the server dispatches a
 * planning round to the planner, which returns a proposal via MCP.
 */

const STATUS_BADGE: Record<FeatureStatus, { variant: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; label: string }> = {
  draft: { variant: 'neutral', label: 'Draft' },
  planning: { variant: 'info', label: 'Planning' },
  proposed: { variant: 'warning', label: 'Proposed · 승인 대기' },
  approved: { variant: 'info', label: 'Approved' },
  running: { variant: 'info', label: 'Running' },
  done: { variant: 'success', label: 'Done' },
  rejected: { variant: 'danger', label: 'Rejected' },
};

interface AgentOpt { id: string; name: string; }

export default function FeatureManager({ workspaceId, boardId }: { workspaceId?: string; boardId?: string }) {
  const [features, setFeatures] = useState<Feature[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Feature | null>(null);
  const [agents, setAgents] = useState<AgentOpt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Intake modal state.
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [requirement, setRequirement] = useState('');
  const [plannerId, setPlannerId] = useState('');

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const rows = await api.listFeatures(workspaceId, boardId ?? null);
      setFeatures(rows);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load features');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, boardId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.getAgents();
        setAgents((list || []).map((a: any) => ({ id: a.id, name: a.name })));
      } catch { /* non-fatal — planner defaults server-side */ }
    })();
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    try {
      setDetail(await api.getFeature(id));
    } catch (e: any) {
      setError(e?.message || 'Failed to load feature');
    }
  }, []);

  const submitIntake = async () => {
    if (!workspaceId || !title.trim() || !requirement.trim()) return;
    setBusy(true);
    try {
      const created = await api.createFeature({
        workspace_id: workspaceId,
        board_id: boardId ?? null,
        title: title.trim(),
        requirement: requirement.trim(),
        planner_agent_id: plannerId || undefined,
      });
      setShowCreate(false);
      setTitle(''); setRequirement(''); setPlannerId('');
      await refresh();
      await loadDetail(created.id);
    } catch (e: any) {
      setError(e?.message || 'Failed to submit feature');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: string) => {
    setBusy(true);
    try {
      await api.approveFeature(id);
      await refresh();
      await loadDetail(id);
    } catch (e: any) {
      setError(e?.message || 'Failed to approve');
    } finally { setBusy(false); }
  };

  const reject = async (id: string) => {
    const feedback = window.prompt('거부 사유 / 수정 요청 (기획자에게 전달되어 재기획됩니다):', '');
    if (feedback === null) return;
    setBusy(true);
    try {
      await api.rejectFeature(id, feedback, true);
      await refresh();
      await loadDetail(id);
    } catch (e: any) {
      setError(e?.message || 'Failed to reject');
    } finally { setBusy(false); }
  };

  const badge = (s: FeatureStatus) => {
    const b = STATUS_BADGE[s] || STATUS_BADGE.draft;
    return <Badge variant={b.variant}>{b.label}</Badge>;
  };

  return (
    <div style={{ display: 'flex', gap: tokens.spacing.lg, height: '100%', minHeight: 0 }}>
      {/* ─── List column ─────────────────────────────────── */}
      <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing.md }}>
          <h3 style={{ margin: 0, fontSize: tokens.typography.fontSizeXl, color: tokens.colors.textStrong }}>Features</h3>
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>+ New Feature</Button>
        </div>
        {error && <div style={{ color: tokens.colors.danger, fontSize: tokens.typography.fontSizeMd, marginBottom: tokens.spacing.sm }}>{error}</div>}
        {loading && features.length === 0 && <div style={{ color: tokens.colors.textMuted }}>Loading…</div>}
        {!loading && features.length === 0 && (
          <div style={{ color: tokens.colors.textMuted, fontSize: tokens.typography.fontSizeMd }}>
            아직 등록된 Feature 가 없습니다. <b>New Feature</b> 로 요구사항 1건을 넣으면 기획 에이전트가 티켓 체인으로 분해합니다.
          </div>
        )}
        <div style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spacing.sm }}>
          {features.map((f) => (
            <Card key={f.id} onClick={() => loadDetail(f.id)} selected={f.id === selectedId}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: tokens.spacing.sm, alignItems: 'flex-start' }}>
                <span style={{ fontWeight: tokens.typography.fontWeightSemibold, color: tokens.colors.textStrong, fontSize: tokens.typography.fontSizeLg }}>{f.title}</span>
                {badge(f.status)}
              </div>
              {f.rollup && f.rollup.total > 0 && (
                <div style={{ marginTop: tokens.spacing.xs, fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
                  진행 {f.rollup.done}/{f.rollup.total} 티켓 완료
                </div>
              )}
            </Card>
          ))}
        </div>
      </div>

      {/* ─── Detail column ───────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {!detail && <div style={{ color: tokens.colors.textMuted, padding: tokens.spacing.lg }}>왼쪽에서 Feature 를 선택하세요.</div>}
        {detail && <FeatureDetail feature={detail} busy={busy} onApprove={() => approve(detail.id)} onReject={() => reject(detail.id)} badge={badge} />}
      </div>

      {/* ─── Intake modal ────────────────────────────────── */}
      <Modal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        title="New Feature — 요구사항 인테이크"
        maxWidth={620}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: tokens.spacing.sm }}>
            <Button variant="ghost" onClick={() => setShowCreate(false)} disabled={busy}>취소</Button>
            <Button variant="primary" onClick={submitIntake} disabled={busy || !title.trim() || !requirement.trim()}>
              {busy ? '제출 중…' : '제출 → 기획 착수'}
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.md }}>
          <Input label="제목" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 카드 마감일 & 지연 알림" />
          <div>
            <label style={{ display: 'block', fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary, marginBottom: 4 }}>요구사항 / 기획 원문</label>
            <textarea
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              rows={8}
              placeholder="구현하고 싶은 기능을 자유롭게 서술하세요. 기획 에이전트가 이걸 실행 가능한 티켓 체인으로 분해합니다."
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                padding: tokens.spacing.sm, borderRadius: tokens.radii.md,
                border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface,
                color: tokens.colors.textPrimary, fontSize: tokens.typography.fontSizeMd, fontFamily: 'inherit',
              }}
            />
          </div>
          <Select
            label="기획 담당 에이전트 (planner)"
            value={plannerId}
            onChange={(e) => setPlannerId(e.target.value)}
            placeholder="미지정 시 서버 기본값(호출자)"
            options={agents.map((a) => ({ value: a.id, label: a.name }))}
          />
          <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
            제출하면 planner 에게 전용 기획 방이 열리고, 구조화된 티켓 체인 제안이 돌아오면 여기서 승인/거부합니다.
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Detail pane: requirement, proposal preview + approve/reject, rollup progress. */
function FeatureDetail({
  feature, busy, onApprove, onReject, badge,
}: {
  feature: Feature;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  badge: (s: FeatureStatus) => React.ReactNode;
}) {
  const p = feature.proposal;
  const roll = feature.rollup;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.lg, padding: `0 ${tokens.spacing.sm}px` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.md }}>
        <h2 style={{ margin: 0, fontSize: tokens.typography.fontSizeXl, color: tokens.colors.textStrong }}>{feature.title}</h2>
        {badge(feature.status)}
      </div>

      <section>
        <SectionTitle>요구사항</SectionTitle>
        <pre style={preStyle}>{feature.requirement}</pre>
      </section>

      {feature.feedback && (
        <section>
          <SectionTitle>최근 거부 피드백</SectionTitle>
          <pre style={{ ...preStyle, borderColor: tokens.colors.warning }}>{feature.feedback}</pre>
        </section>
      )}

      {/* Proposal preview + 1-click approval gate. */}
      {p && p.tickets?.length > 0 && (
        <section>
          <SectionTitle>제안된 티켓 체인 ({p.tickets.length})</SectionTitle>
          {p.summary && <div style={{ color: tokens.colors.textSecondary, fontSize: tokens.typography.fontSizeMd, marginBottom: tokens.spacing.sm }}>{p.summary}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.sm }}>
            {p.tickets.map((t, i) => (
              <div key={t.key} style={proposedRowStyle}>
                <span style={{ fontFamily: 'monospace', color: tokens.colors.accent, fontSize: tokens.typography.fontSizeXs }}>{t.key}</span>
                <span style={{ flex: 1, color: tokens.colors.textStrong, fontSize: tokens.typography.fontSizeMd }}>{i + 1}. {t.title}</span>
                {t.priority && <Badge variant={t.priority === 'critical' || t.priority === 'high' ? 'danger' : 'neutral'}>{t.priority}</Badge>}
                {t.column_name && <span style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>→ {t.column_name}</span>}
              </div>
            ))}
          </div>
          {p.edges && p.edges.length > 0 && (
            <div style={{ marginTop: tokens.spacing.sm, fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
              선행조건: {p.edges.map((e) => `${e.from}→${e.to}`).join(', ')}
            </div>
          )}
          {feature.status === 'proposed' && (
            <div style={{ display: 'flex', gap: tokens.spacing.sm, marginTop: tokens.spacing.md }}>
              <Button variant="primary" onClick={onApprove} disabled={busy}>{busy ? '처리 중…' : '✓ 승인 → 체인 자동 착수'}</Button>
              <Button variant="danger" onClick={onReject} disabled={busy}>✗ 거부 · 재기획</Button>
            </div>
          )}
        </section>
      )}

      {feature.status === 'planning' && (
        <div style={{ color: tokens.colors.info, fontSize: tokens.typography.fontSizeMd }}>
          기획 에이전트가 요구사항을 분석 중입니다. 구조화된 티켓 체인 제안이 돌아오면 여기에 표시됩니다.
        </div>
      )}

      {/* Progress rollup once the chain is running/done. */}
      {roll && roll.total > 0 && (
        <section>
          <SectionTitle>진행 롤업 — {roll.done}/{roll.total} 완료</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.xs }}>
            {roll.tickets.map((t) => (
              <div key={t.id} style={proposedRowStyle}>
                <span style={{ flex: 1, color: tokens.colors.textStrong, fontSize: tokens.typography.fontSizeMd }}>{t.title}</span>
                <Badge variant={t.terminal ? 'success' : 'info'}>{t.column_name || '—'}</Badge>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const preStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
  padding: tokens.spacing.sm, borderRadius: tokens.radii.md,
  border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceSubtle,
  color: tokens.colors.textPrimary, fontSize: tokens.typography.fontSizeMd, fontFamily: 'inherit',
};

const proposedRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: tokens.spacing.sm,
  padding: `${tokens.spacing.xs}px ${tokens.spacing.sm}px`, borderRadius: tokens.radii.sm,
  border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceCard,
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: tokens.typography.fontSizeMd, fontWeight: tokens.typography.fontWeightSemibold, color: tokens.colors.textSecondary, marginBottom: tokens.spacing.sm, textTransform: 'uppercase', letterSpacing: 0.4 }}>{children}</div>;
}
