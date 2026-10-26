import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useState } from 'react';
import type { Skill, SkillProposal } from '../../types';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { useToast } from '../../contexts/ToastContext';
import { Badge, Button, Card } from '../common';

interface Props {
  accountId: string;
  proposal: SkillProposal;
  skills: Skill[];
  onReviewed: () => void;
}

export default function SkillProposalReview({
  accountId,
  proposal,
  skills,
  onReviewed,
}: Props) {
  useLocale();
  const { showToast } = useToast();
  const [targetSkillId, setTargetSkillId] = useState(proposal.skill_id || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  const review = async (decision: 'approve' | 'reject') => {
    if (decision === 'approve' && !targetSkillId) {
      showToast(translate('Choose a target skill before approval'), 'error');
      return;
    }
    setBusy(decision);
    try {
      await api.reviewSkillProposal(accountId, proposal.id, decision, {
        note,
        skill_id: targetSkillId,
      });
      showToast(
        decision === 'approve'
          ? translate('Proposal approved as a new immutable version')
          : translate('Proposal rejected'),
        'success',
      );
      onReviewed();
    } catch (error: any) {
      showToast(error?.message || translate('Proposal review failed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ color: tokens.colors.textPrimary }}>{proposal.title}</strong>
        <Badge variant={proposal.status === 'pending' ? 'warning' : proposal.status === 'approved' ? 'success' : 'danger'}>
          {proposal.status}
        </Badge>
      </div>
      <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>
        {translate('Agent')} {proposal.source_agent_id || translate('human')} {translate('· Run')} {proposal.source_run_id || translate('manual')}
      </div>
      <pre style={{
        margin: 0,
        padding: 12,
        maxHeight: 220,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        background: tokens.colors.surface,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
        color: tokens.colors.textStrong,
      }}>
        {proposal.body}
      </pre>
      <div style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        color: tokens.colors.textMuted,
        wordBreak: 'break-all',
      }}>
        SHA-256 {proposal.digest}
      </div>
      {proposal.status === 'pending' && (
        <>
          <label style={{ display: 'grid', gap: 4, color: tokens.colors.textSecondary, fontSize: 12 }}>
            {translate('Target skill')}<select
              value={targetSkillId}
              onChange={(event) => setTargetSkillId(event.target.value)}
              style={{
                background: tokens.colors.surface,
                color: tokens.colors.textStrong,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '8px 10px',
              }}
            >
              <option value="">{translate('Select a governed skill')}</option>
              {skills.filter((skill) => skill.status === 'active').map((skill) => (
                <option key={skill.id} value={skill.id}>{skill.name} ({skill.slug})</option>
              ))}
            </select>
          </label>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={translate('Review note')}
            rows={2}
            style={{
              background: tokens.colors.surface,
              color: tokens.colors.textStrong,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: 10,
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => review('approve')} loading={busy === 'approve'}>
              {translate('Approve new version')}</Button>
            <Button variant="danger" onClick={() => review('reject')} loading={busy === 'reject'}>
              {translate('Reject')}</Button>
          </div>
        </>
      )}
    </Card>
  );
}
