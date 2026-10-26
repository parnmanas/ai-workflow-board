import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import DeclareRuntimeSection from '../runtime/DeclareRuntimeSection';
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { formatAgentDisplayName } from '../../utils/agentName';
import type { Project, Skill, SkillDetail, SkillProposal } from '../../types';
import { tokens } from '../../tokens';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Badge, Button, Card, Input } from '../common';
import SkillProposalReview from './SkillProposalReview';
import SkillAssignmentsPanel from '../knowledge/SkillAssignmentsPanel';

type AssignScope = 'account' | 'project' | 'runtime';

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
  useLocale();
  const { currentAccountId } = useAuth();
  const { showToast } = useToast();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [selected, setSelected] = useState<SkillDetail | null>(null);
  // 배정(범위별 현황)이 기본 — "누가 무엇을 받는가" 가 가장 먼저 묻는 질문이다(docs/skills.md "배정 범위").
  const [tab, setTab] = useState<'assignments' | 'catalog' | 'proposals'>('assignments');
  const [assignScope, setAssignScope] = useState<AssignScope>('account');
  const [assignProject, setAssignProject] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [assignmentsNonce, setAssignmentsNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState(translate('# Skill\n'));
  const [newVersionBody, setNewVersionBody] = useState('');
  const [assignmentRuntime, setAssignmentRuntime] = useState<Record<string, any> | null>(null);
  const [assignmentVersion, setAssignmentVersion] = useState('');
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);

  const load = useCallback(async () => {
    if (!currentAccountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [skillRows, proposalRows] = await Promise.all([
        // include_shadowed: an overridden global must stay visible, otherwise
        // "why isn't the built-in applying" has no answer in the UI.
        api.listSkills(currentAccountId, true),
        api.listSkillProposals(currentAccountId),
      ]);
      setSkills(skillRows);
      setProposals(proposalRows);
      if (selected) {
        const fresh = await api.getSkill(currentAccountId, selected.id);
        setSelected(fresh);
        setAssignmentVersion(fresh.versions[0]?.id || '');
      }
    } catch (error: any) {
      showToast(error?.message || translate('Failed to load governed skills'), 'error');
    } finally {
      setLoading(false);
    }
  }, [currentAccountId, selected?.id, showToast]);

  useEffect(() => { void load(); }, [currentAccountId]);

  useEffect(() => {
    if (!currentAccountId) return;
    api.listProjects(currentAccountId)
      .then((rows) => setProjects(rows.filter((p) => p.account_id === currentAccountId)))
      .catch(() => setProjects([]));
  }, [currentAccountId]);

  // Global skills are inherited by every account; publishing/quarantining
  // one from a account is refused server-side, so the UI offers Fork instead.
  const isGlobal = !!selected && !selected.account_id;

  const openSkill = async (skill: Skill) => {
    if (!currentAccountId) return;
    try {
      const detail = await api.getSkill(currentAccountId, skill.id);
      setSelected(detail);
      setNewVersionBody(detail.versions[0]?.body || translate('# Skill\n'));
      setAssignmentVersion(detail.versions[0]?.id || '');
      setAssignmentRuntime(null);
    } catch (error: any) {
      showToast(error?.message || translate('Failed to load skill'), 'error');
    }
  };

  const create = async () => {
    if (!currentAccountId || !slug.trim() || !body.trim()) return;
    setSaving(true);
    try {
      await api.createSkill(currentAccountId, {
        slug: slug.trim(),
        name: name.trim() || slug.trim(),
        description,
        body,
      });
      showToast(translate('Governed skill created at version 1'), 'success');
      setCreating(false);
      setSlug('');
      setName('');
      setDescription('');
      setBody(translate('# Skill\n'));
      await load();
    } catch (error: any) {
      showToast(error?.message || translate('Failed to create skill'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!currentAccountId || !selected || !newVersionBody.trim()) return;
    setSaving(true);
    try {
      await api.publishSkillVersion(currentAccountId, selected.id, {
        body: newVersionBody,
      });
      showToast(translate('New immutable skill version published'), 'success');
      await load();
    } catch (error: any) {
      showToast(error?.message || translate('Failed to publish version'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const assign = async () => {
    if (!currentAccountId || !selected || !assignmentVersion) return;
    const target = assignScope === 'account'
      ? { scope: 'account' as const }
      : assignScope === 'project'
      ? (assignProject ? { scope: 'project' as const, project_id: assignProject } : null)
      : (assignmentRuntime ? { scope: 'runtime' as const, runtime: assignmentRuntime } : null);
    if (!target) return;
    setSaving(true);
    try {
      await api.assignSkill(currentAccountId, selected.id, {
        skill_version_id: assignmentVersion,
        target,
      });
      showToast(assignScope === 'account' ? translate('Assigned to every agent in this account') : assignScope === 'project' ? translate('Assigned to the project') : translate('Assigned to that runtime'), 'success');
      setAssignmentsNonce((n) => n + 1);
    } catch (error: any) {
      showToast(error?.message || translate('Failed to assign skill'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!currentAccountId) {
    return <div style={{ color: tokens.colors.textMuted }}>{translate('Ownership defaults are unavailable.')}</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong style={{ color: tokens.colors.textPrimary }}>{translate('Skills agents can use')}</strong>
          <div style={{ color: tokens.colors.textMuted, fontSize: 12, marginTop: 4 }}>
            {translate('Assign a version to every agent (Shared), to a project, or to one runtime. Versions are immutable; ticket runs pin them. Runtime learning creates proposals only.')}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant={tab === 'assignments' ? 'primary' : 'secondary'} onClick={() => setTab('assignments')}>
            {translate('Assignments')}</Button>
          <Button variant={tab === 'catalog' ? 'primary' : 'secondary'} onClick={() => setTab('catalog')}>
            {translate('Catalog')}</Button>
          <Button variant={tab === 'proposals' ? 'primary' : 'secondary'} onClick={() => setTab('proposals')}>
            {translate('Proposals (')}{proposals.filter((proposal) => proposal.status === 'pending').length})
          </Button>
        </div>
      </Card>

      {tab === 'assignments' ? (
        <SkillAssignmentsPanel
          key={assignmentsNonce}
          accountId={currentAccountId}
          skills={skills}
          onOpenSkill={(skill) => { setTab('catalog'); void openSkill(skill); }}
        />
      ) : tab === 'proposals' ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {proposals.length === 0 && <Card><span style={{ color: tokens.colors.textMuted }}>{translate('No proposals.')}</span></Card>}
          {proposals.map((proposal) => (
            <SkillProposalReview
              key={proposal.id}
              accountId={currentAccountId}
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
              {creating ? translate('Close creator') : translate('New skill')}
            </Button>
            {creating && (
              <Card style={{ display: 'grid', gap: 10 }}>
                <Input label={translate('Slug')} value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="review-checklist" />
                <Input label={translate('Name')} value={name} onChange={(event) => setName(event.target.value)} />
                <Input label={translate('Description')} value={description} onChange={(event) => setDescription(event.target.value)} />
                <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={8} style={textareaStyle} />
                <Button onClick={create} loading={saving}>{translate('Create version 1')}</Button>
              </Card>
            )}
            {loading && <div style={{ color: tokens.colors.textMuted }}>{translate('Loading…')}</div>}
            {skills.map((skill) => (
              <Card key={skill.id} onClick={() => void openSkill(skill)} selected={selected?.id === skill.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ color: tokens.colors.textPrimary }}>{skill.name}</strong>
                  <Badge variant={skill.status === 'active' ? 'success' : 'danger'}>{skill.status}</Badge>
                </div>
                <div style={{ color: tokens.colors.textMuted, fontSize: 12, marginTop: 6 }}>{skill.slug}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {/* Scope is the first thing to know about a row: a global
                      skill is read-only here and is edited by forking. */}
                  <Badge variant={skill.account_id ? 'info' : 'neutral'} size="sm">
                    {skill.account_id ? translate('account') : translate('global')}
                  </Badge>
                  {skill.source_kind && skill.source_kind !== 'local' && (
                    <Badge variant="neutral" size="sm">{skill.source_kind}</Badge>
                  )}
                  {skill.shadowed && (
                    <span title={translate('An account skill with this slug overrides it')}>
                      <Badge variant="warning" size="sm">{translate('shadowed')}</Badge>
                    </span>
                  )}
                </div>
              </Card>
            ))}
          </div>

          {selected ? (
            <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
              <Card style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ color: tokens.colors.textPrimary }}>{selected.name}</strong>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {/* A global skill is inherited by every account, so it is
                        read-only from here — diverging means forking it, which
                        leaves the global free to keep receiving updates. */}
                    {isGlobal ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={forking}
                        onClick={async () => {
                          setForking(true);
                          try {
                            await api.forkSkill(currentAccountId, selected.id, selected.versions[0]?.id);
                            showToast(translate('Forked into this account — it now shadows the global skill'), 'success');
                            setSelected(null);
                            await load();
                          } catch (error: any) {
                            showToast(error?.message || translate('Fork failed'), 'error');
                          } finally {
                            setForking(false);
                          }
                        }}
                      >
                        {translate('Fork into account')}</Button>
                    ) : selected.status === 'active' && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={async () => {
                          await api.quarantineSkill(currentAccountId, selected.id);
                          showToast(translate('Skill quarantined for future snapshots'), 'success');
                          await load();
                        }}
                      >
                        {translate('Quarantine')}</Button>
                    )}
                  </div>
                </div>
                {isGlobal && (
                  <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>
                    {translate('Global skill')}{selected.source_kind && selected.source_kind !== 'local'
                      ? translate(' · managed by the {0} it came from', { 0: selected.source_kind === 'builtin' ? translate('built-in pack') : translate('skill tap') })
                      : ''}
                    {selected.source_author ? ` · ${selected.source_author}` : ''}
                    {selected.source_license ? ` · ${selected.source_license}` : ''}
                    {translate('. Read-only here — fork it to diverge, or manage it in Admin → Skill registry.')}</div>
                )}
                <div style={{ color: tokens.colors.textMuted }}>{selected.description || translate('No description')}</div>
                {selected.versions.map((version) => (
                  <div key={version.id} style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10 }}>
                    <strong style={{ color: tokens.colors.textSecondary }}>{translate('v')}{version.version}</strong>
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
                <strong style={{ color: tokens.colors.textPrimary }}>{translate('Publish a new version')}</strong>
                <textarea value={newVersionBody} onChange={(event) => setNewVersionBody(event.target.value)} rows={10} style={textareaStyle} />
                <Button onClick={publish} loading={saving}>{translate('Publish immutable version')}</Button>
              </Card>

              <Card style={{ display: 'grid', gap: 10 }}>
                <strong style={{ color: tokens.colors.textPrimary }}>{translate('Assign')}</strong>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13, color: tokens.colors.textPrimary }}>
                  {([
                    ['account', translate('Shared — every agent')],
                    ['project', translate('A project')],
                    ['runtime', translate('One runtime')],
                  ] as Array<[AssignScope, string]>).map(([value, label]) => (
                    <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                      <input type="radio" name="skill-assign-scope" checked={assignScope === value} onChange={() => setAssignScope(value)} />
                      {label}
                    </label>
                  ))}
                </div>
                {assignScope === 'project' && (
                  <select value={assignProject} onChange={(event) => setAssignProject(event.target.value)} style={textareaStyle} aria-label={translate('Project')}>
                    <option value="">{translate('Choose a project…')}</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                )}
                {assignScope === 'runtime' && (
                  <>
                    <DeclareRuntimeSection accountId={currentAccountId || ''} onResolved={setAssignmentRuntime} />
                    {assignmentRuntime && <span>{assignmentRuntime.label || assignmentRuntime.cli} · {assignmentRuntime.working_dir}</span>}
                  </>
                )}
                <select value={assignmentVersion} onChange={(event) => setAssignmentVersion(event.target.value)} style={textareaStyle}>
                  {selected.versions.map((version) => (
                    <option key={version.id} value={version.id}>{translate('v')}{version.version} · {version.digest.slice(0, 12)}</option>
                  ))}
                </select>
                <Button
                  onClick={assign}
                  loading={saving}
                  disabled={(assignScope === 'project' && !assignProject) || (assignScope === 'runtime' && !assignmentRuntime)}
                >
                  {translate('Assign this version')}</Button>
              </Card>
            </div>
          ) : (
            <Card><span style={{ color: tokens.colors.textMuted }}>{translate('Choose a skill to inspect immutable versions and assignments.')}</span></Card>
          )}
        </div>
      )}
    </div>
  );
}
