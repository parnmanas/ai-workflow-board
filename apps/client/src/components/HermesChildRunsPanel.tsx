import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { HermesChildRun } from '../types';
import { tokens } from '../tokens';
import { Badge, Button, Card } from './common';

export default function HermesChildRunsPanel({
  workspaceId,
  agentId,
}: {
  workspaceId: string;
  agentId: string;
}) {
  const [runs, setRuns] = useState<HermesChildRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!workspaceId || !agentId) return;
    setLoading(true);
    try {
      setRuns(await api.listAgentChildRuns(workspaceId, agentId));
      setError('');
    } catch (reason: any) {
      setError(reason?.message || 'Failed to load Hermes ChildRuns');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, agentId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 10, alignContent: 'start' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <strong style={{ color: tokens.colors.textPrimary }}>Hermes ChildRuns</strong>
          <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>
            Ephemeral collaborators under a durable AWB parent run; they are not Agents.
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}>
          Refresh
        </Button>
      </div>
      {error && <div style={{ color: tokens.colors.dangerLight }}>{error}</div>}
      {!loading && runs.length === 0 && (
        <Card><span style={{ color: tokens.colors.textMuted }}>No Hermes child collaboration has been recorded.</span></Card>
      )}
      {runs.map((run) => {
        const isExpanded = expanded === run.id;
        return (
          <Card key={run.id} onClick={() => setExpanded(isExpanded ? null : run.id)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ color: tokens.colors.textStrong, flex: 1 }}>
                {run.title || run.runtime_child_id}
              </strong>
              <Badge variant={run.status === 'completed' ? 'success' : run.status === 'running' ? 'warning' : 'danger'}>
                {run.status}
              </Badge>
              <Badge variant="info">{run.strategy}</Badge>
            </div>
            <div style={{ color: tokens.colors.textMuted, fontSize: 11, marginTop: 6 }}>
              Parent {run.parent_run_id} · depth {run.depth}
            </div>
            {isExpanded && (
              <div style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: `1px solid ${tokens.colors.border}`,
                color: tokens.colors.textSecondary,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {run.summary || 'No sanitized summary was reported.'}
                <pre style={{
                  margin: '10px 0 0',
                  color: tokens.colors.textMuted,
                  fontSize: 11,
                  whiteSpace: 'pre-wrap',
                }}>
                  {JSON.stringify(run.runtime_metadata, null, 2)}
                </pre>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
