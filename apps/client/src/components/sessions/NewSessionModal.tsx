import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { AgentSessionAgentOption, AgentSessionSnapshot } from '../../types';
import { Button, Input, Modal } from '../common';
import { runtimeLabel } from './sessionTranscript.logic';

/**
 * 새 Agent Session — 에이전트 하나, 작업 폴더, 권한 정책을 고른다. Chat 의
 * NewChatModal(참여자 여러 명, DM/그룹) 과 의도적으로 다른 모양이다.
 */
export interface NewSessionModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (session: AgentSessionSnapshot) => void;
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: tokens.radii.md,
  border: `1px solid ${tokens.colors.border}`,
  background: tokens.colors.surface,
  color: tokens.colors.textPrimary,
  fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: tokens.colors.textSecondary,
  marginBottom: 4,
};

function reasonText(reason: string | null): string {
  switch (reason) {
    case 'no_acp_adapter':
      return 'no ACP adapter for this CLI type';
    case 'manager_identity':
      return 'Runtime Host identity';
    case 'agent_type_missing':
      return 'CLI type not set';
    default:
      return reason || 'unsupported';
  }
}

export default function NewSessionModal({ open, onClose, onCreated }: NewSessionModalProps) {
  const [agents, setAgents] = useState<AgentSessionAgentOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [cwd, setCwd] = useState('');
  const [cwdTouched, setCwdTouched] = useState(false);
  const [policy, setPolicy] = useState<'ask' | 'auto_allow'>('ask');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCwdTouched(false);
    api.listAgentSessionAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        const first = list.find((a) => a.supported);
        setAgentId((prev) => (prev && list.some((a) => a.id === prev && a.supported) ? prev : first?.id || ''));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load agents');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const selected = useMemo(() => agents.find((a) => a.id === agentId) || null, [agents, agentId]);

  useEffect(() => {
    if (!selected || cwdTouched) return;
    setCwd(selected.working_dir || '');
  }, [selected, cwdTouched]);

  const supportedCount = agents.filter((a) => a.supported).length;

  const create = async () => {
    if (!selected || !selected.supported || creating) return;
    setCreating(true);
    setError(null);
    try {
      const session = await api.createAgentSession({
        agent_id: selected.id,
        cwd: cwd.trim(),
        permission_policy: policy,
      });
      onCreated(session);
    } catch (err: any) {
      setError(err?.message || 'Failed to create the session');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="New session"
      maxWidth={520}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={onClose} disabled={creating}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={!selected?.supported || creating} loading={creating}>
            Start session
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
          Drive one agent&apos;s CLI directly (Claude Code, Codex, Hermes). The CLI&apos;s own session is the
          source of truth — output streams here, and tool permissions are yours to approve.
        </p>

        <div>
          <label htmlFor="new-session-agent" style={labelStyle}>Agent</label>
          <select
            id="new-session-agent"
            style={selectStyle}
            value={agentId}
            disabled={loading || agents.length === 0}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {loading && <option value="">Loading agents…</option>}
            {!loading && agents.length === 0 && <option value="">No agents in this workspace</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.supported}>
                {a.name} · {runtimeLabel(a.type)}{a.supported ? (a.is_online ? '' : ' · offline') : ` · ${reasonText(a.reason)}`}
              </option>
            ))}
          </select>
          {!loading && agents.length > 0 && supportedCount === 0 && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: tokens.colors.warningLight }}>
              None of these agents has an ACP adapter. Sessions need a claude / codex / hermes agent, or
              <code style={{ fontFamily: 'monospace' }}> runtime_config.extra.acp_command</code> on a custom one.
            </div>
          )}
          {selected && !selected.is_online && selected.supported && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: tokens.colors.textMuted }}>
              This agent&apos;s Runtime Host is offline right now — the session opens when it reconnects.
            </div>
          )}
        </div>

        <Input
          label="Working directory (on the Runtime Host)"
          value={cwd}
          placeholder={selected?.working_dir || '/path/to/repo'}
          onChange={(e) => {
            setCwdTouched(true);
            setCwd(e.target.value);
          }}
        />

        <div>
          <label htmlFor="new-session-policy" style={labelStyle}>Tool permissions</label>
          <select
            id="new-session-policy"
            style={selectStyle}
            value={policy}
            onChange={(e) => setPolicy(e.target.value === 'auto_allow' ? 'auto_allow' : 'ask')}
          >
            <option value="ask">Ask me every time (recommended)</option>
            <option value="auto_allow">Allow automatically</option>
          </select>
        </div>

        {error && (
          <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>
        )}
      </div>
    </Modal>
  );
}
