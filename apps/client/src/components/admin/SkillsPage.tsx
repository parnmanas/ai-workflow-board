import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { Agent, Skill, SkillDetail, SkillProposal } from '../../types';
import { tokens } from '../../tokens';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Badge, Button, Card, Input } from '../common';
import SkillProposalReview from './SkillProposalReview';

const textareaStyle: React.CSSProperties = {
  background: tokens.colors.surface,
  color: tokens.colors.textStrong,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.md,
  padding: 10,
  resize: 'vertical',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

export default function SkillsPage() {
  const { currentWorkspaceId } = useAuth();
  const { showToast } = useToast();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<SkillDetail | null>(null);
  const [tab, setTab] = useState<'catalog' | 'proposals'>('catalog');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('# Skill\n');
  const [newVersionBody, setNewVersionBody] = useState('');
  const [assignmentAgent, setAssignmentAgent] = useState('');
  const [assignmentVersion, setAssignmentVersion] = useState('');
  const [assignmentBoard, setAssignmentBoard] = useState('');
  const [assignmentRole, setAssignmentRole] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!currentWorkspaceId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [skillRows, proposalRows, agentRows] = await Promise.all([
        api.listSkills(currentWorkspaceId),
        api.listSkillProposals(currentWorkspaceId),
        api.getAgents(currentWorkspaceId),
      ]);
      setSkills(skillRows);
      setProposals(proposalRows);
      setAgents(agentRows as Agent[]);
      if (selected) {
        const fresh = await api.getSkill(currentWorkspaceId, selected.id);
        setSelected(fresh);
        setAssignmentVersion(fresh.versions[0]?.id || '');
      }
    } catch (error: any) {
      showToast(error?.message || 'Failed to load governed skills', 'error');
    } finally {
      setLoading(false);
    }
  }, [currentWorkspaceId, selected?.id, showToast]);

  useEffect(() => { void load(); }, [currentWorkspaceId]);

  const openSkill = async (skill: Skill) => {
    if (!currentWorkspaceId) return;
    try {
      const detail = await api.getSkill(currentWorkspaceId, skill.id);
      setSelected(detail);
      setNewVersionBody(detail.versions[0]?.body || '# Skill\n');
      setAssignmentVersion(detail.versions[0]?.id || '');
      setAssignmentAgent(agents[0]?.id || '');
    } catch (error: any) {
      showToast(error?.message || 'Failed to load skill', 'error');
    }
  };

  const create = async () => {
    if (!currentWorkspaceId || !slug.trim() || !body.trim()) return;
    setSaving(true);
    try {
      await api.createSkill(currentWorkspaceId, {
        slug: slug.trim(),
        name: name.trim() || slug.trim(),
        description,
        body,
      });
      showToast('Governed skill created at version 1', 'success');
      setCreating(false);
      setSlug('');
      setName('');
      setDescription('');
      setBody('# Skill\n');
      await load();
    } catch (error: any) {
      showToast(error?.message || 'Failed to create skill', 'error');
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!currentWorkspaceId || !selected || !newVersionBody.trim()) return;
    setSaving(true);
    try {
      await api.publishSkillVersion(currentWorkspaceId, selected.id, {
        body: newVersionBody,
      });
      showToast('New immutable skill version published', 'success');
      await load();
    } catch (error: any) {
      showToast(error?.message || 'Failed to publish version', 'error');
    } finally {
      setSaving(false);
    }
  };

  const assign = async () => {
    if (!currentWorkspaceId || !selected || !assignmentAgent || !assignmentVersion) return;
    setSaving(true);
    try {
      await api.assignSkill(currentWorkspaceId, selected.id, {
        skill_version_id: assignmentVersion,
        agent_id: assignmentAgent,
        board_id: assignmentBoard,
        role_slug: assignmentRole,
      });
      showToast('Exact skill version assigned', 'success');
    } catch (error: any) {
      showToast(error?.message || 'Failed to assign skill', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!currentWorkspaceId) {
    return <div style={{ color: tokens.colors.textMuted }}>Select a workspace to manage skills.</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong style={{ color: tokens.colors.textPrimary }}>AWB owns skill truth</strong>
          <div style={{ color: tokens.colors.textMuted, fontSize: 12, marginTop: 4 }}>
            Versions are immutable. Runs pin a digest. Runtime learning creates proposals only.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant={tab === 'catalog' ? 'primary' : 'secondary'} onClick={() => setTab('catalog')}>
            Catalog
          </Button>
          <Button variant={tab === 'proposals' ? 'primary' : 'secondary'} onClick={() => setTab('proposals')}>
            Proposals ({proposals.filter((proposal) => proposal.status === 'pending').length})
          </Button>
        </div>
      </Card>

      {tab === 'proposals' ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {proposals.length === 0 && <Card><span style={{ color: tokens.colors.textMuted }}>No proposals.</span></Card>}
          {proposals.map((proposal) => (
            <SkillProposalReview
              key={proposal.id}
              workspaceId={currentWorkspaceId}
              proposal={proposal}
              skills={skills}
              onReviewed={() => void load()}
            />
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 0.8fr) minmax(420px, 2fr)', gap: 16 }}>
          <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
            <Button onClick={() => setCreating((value) => !value)}>
              {creating ? 'Close creator' : 'New skill'}
            </Button>
            {creating && (
              <Card style={{ display: 'grid', gap: 10 }}>
                <Input label="Slug" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="review-checklist" />
                <Input label="Name" value={name} onChange={(event) => setName(event.target.value)} />
                <Input label="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
                <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={8} style={textareaStyle} />
                <Button onClick={create} loading={saving}>Create version 1</Button>
              </Card>
            )}
            {loading && <div style={{ color: tokens.colors.textMuted }}>Loading…</div>}
            {skills.map((skill) => (
              <Card key={skill.id} onClick={() => void openSkill(skill)} selected={selected?.id === skill.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ color: tokens.colors.textPrimary }}>{skill.name}</strong>
                  <Badge variant={skill.status === 'active' ? 'success' : 'danger'}>{skill.status}</Badge>
                </div>
                <div style={{ color: tokens.colors.textMuted, fontSize: 12, marginTop: 6 }}>{skill.slug}</div>
              </Card>
            ))}
          </div>

          {selected ? (
            <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
              <Card style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <strong style={{ color: tokens.colors.textPrimary }}>{selected.name}</strong>
                  {selected.status === 'active' && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={async () => {
                        await api.quarantineSkill(currentWorkspaceId, selected.id);
                        showToast('Skill quarantined for future snapshots', 'success');
                        await load();
                      }}
                    >
                      Quarantine
                    </Button>
                  )}
                </div>
                <div style={{ color: tokens.colors.textMuted }}>{selected.description || 'No description'}</div>
                {selected.versions.map((version) => (
                  <div key={version.id} style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10 }}>
                    <strong style={{ color: tokens.colors.textSecondary }}>v{version.version}</strong>
                    <div style={{
                      color: tokens.colors.textMuted,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 11,
                      wordBreak: 'break-all',
                    }}>
                      {version.digest}
                    </div>
                  </div>
                ))}
              </Card>

              <Card style={{ display: 'grid', gap: 10 }}>
                <strong style={{ color: tokens.colors.textPrimary }}>Publish a new version</strong>
                <textarea value={newVersionBody} onChange={(event) => setNewVersionBody(event.target.value)} rows={10} style={textareaStyle} />
                <Button onClick={publish} loading={saving}>Publish immutable version</Button>
              </Card>

              <Card style={{ display: 'grid', gap: 10 }}>
                <strong style={{ color: tokens.colors.textPrimary }}>Pin assignment</strong>
                <select value={assignmentAgent} onChange={(event) => setAssignmentAgent(event.target.value)} style={textareaStyle}>
                  <option value="">Select Agent</option>
                  {agents.filter((agent) => agent.type !== 'manager').map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
                <select value={assignmentVersion} onChange={(event) => setAssignmentVersion(event.target.value)} style={textareaStyle}>
                  {selected.versions.map((version) => (
                    <option key={version.id} value={version.id}>v{version.version} · {version.digest.slice(0, 12)}</option>
                  ))}
                </select>
                <Input label="Board id (optional)" value={assignmentBoard} onChange={(event) => setAssignmentBoard(event.target.value)} />
                <Input label="Role slug (optional)" value={assignmentRole} onChange={(event) => setAssignmentRole(event.target.value)} />
                <Button onClick={assign} loading={saving}>Assign exact version</Button>
              </Card>
            </div>
          ) : (
            <Card><span style={{ color: tokens.colors.textMuted }}>Choose a skill to inspect immutable versions and assignments.</span></Card>
          )}
        </div>
      )}
    </div>
  );
}
