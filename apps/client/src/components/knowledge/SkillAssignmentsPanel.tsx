import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { Project, Skill, SkillAssignment, SkillDetail } from '../../types';
import { Badge, Button, Card } from '../common';
import { groupAssignments, type AssignmentGroup } from './knowledge.logic';

const selectStyle: React.CSSProperties = {
  fontSize: 12.5, padding: '4px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`,
  background: tokens.colors.surface, color: tokens.colors.textPrimary,
};

/**
 * 배정 현황 — 범위별(Shared / 각 프로젝트 / Specific runtime)로 어떤 skill 의 몇 버전이 걸려 있는지.
 * 여기서 바로 더하고(skill · 버전 고르기), 최신 버전으로 다시 핀하고, 해제한다. 해제·재핀은 이미 시작한
 * 티켓 런에는 영향이 없다(그 런은 시작 때 버전을 고정했다).
 */
export default function SkillAssignmentsPanel({ accountId, skills, onOpenSkill, focusProjectId }: {
  accountId: string;
  skills: Skill[];
  onOpenSkill: (skill: Skill) => void;
  /** 프로젝트 메모리 화면에서 들어오면 그 프로젝트 그룹만 보인다. */
  focusProjectId?: string | null;
}) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [assignments, setAssignments] = useState<SkillAssignment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [pickSkill, setPickSkill] = useState('');
  const [pickDetail, setPickDetail] = useState<SkillDetail | null>(null);
  const [pickVersion, setPickVersion] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rows, projectRows] = await Promise.all([
        api.listSkillAssignments(accountId),
        api.listProjects(accountId).catch(() => [] as Project[]),
      ]);
      setAssignments(rows);
      setProjects(projectRows.filter((p) => p.account_id === accountId));
    } catch (err: any) {
      setError(err?.message || 'Failed to load assignments');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!pickSkill) {
      setPickDetail(null);
      setPickVersion('');
      return;
    }
    let cancelled = false;
    api.getSkill(accountId, pickSkill)
      .then((detail) => {
        if (cancelled) return;
        setPickDetail(detail);
        setPickVersion(detail.versions[0]?.id || '');
      })
      .catch((err: any) => { if (!cancelled) showToast(err?.message || 'Failed to load skill', 'error'); });
    return () => { cancelled = true; };
  }, [pickSkill, accountId, showToast]);

  const groups = useMemo(() => {
    const all = groupAssignments(assignments, projects);
    return focusProjectId ? all.filter((g) => g.project_id === focusProjectId) : all;
  }, [assignments, projects, focusProjectId]);

  const activeSkills = skills.filter((s) => s.status === 'active' && !s.shadowed);

  const add = async (group: AssignmentGroup) => {
    if (!pickSkill || !pickVersion) return;
    setBusy(true);
    try {
      await api.assignSkill(accountId, pickSkill, {
        skill_version_id: pickVersion,
        target: group.scope === 'project' && group.project_id ? { scope: 'project', project_id: group.project_id } : { scope: 'account' },
      });
      showToast(`Assigned to ${group.title}`, 'success');
      setAdding(null);
      setPickSkill('');
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Assign failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const repinLatest = async (a: SkillAssignment) => {
    setBusy(true);
    try {
      const detail = await api.getSkill(accountId, a.skill_id);
      const latest = detail.versions[0];
      if (!latest) throw new Error('This skill has no versions');
      await api.repinSkillAssignment(accountId, a.id, latest.id);
      showToast(`Now pinned to v${latest.version}`, 'success');
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Re-pin failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: SkillAssignment) => {
    const ok = await confirm({
      title: `Unassign ${a.skill_slug}?`,
      message: 'New runs stop receiving it. Tickets that already started keep the version they pinned.',
      confirmLabel: 'Unassign',
    });
    if (!ok) return;
    try {
      await api.unassignSkill(accountId, a.id);
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Unassign failed', 'error');
    }
  };

  if (error) return <Card><span style={{ color: tokens.colors.danger }}>{error}</span></Card>;
  if (loading && !assignments.length) return <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading assignments…</div>;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {!focusProjectId && (
        <div style={{ fontSize: 12.5, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
          A run gets every skill assigned to its account (<b>Shared</b>), to the project it works on, and to its own runtime — when the
          same skill is assigned more than once, the narrowest scope wins. Ticket and mission prompts list them; agents load the text
          with the AWB MCP tool <code>get_skill</code>. Ticket runs pin the versions when they start.
        </div>
      )}
      {groups.map((group) => (
        <Card key={group.key} style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ color: tokens.colors.textPrimary }}>{group.title}</strong>
            <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>{group.subtitle}</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.colors.textMuted }}>{group.items.length} skill{group.items.length === 1 ? '' : 's'}</span>
            {group.scope !== 'runtime' && (
              <Button size="sm" variant="secondary" onClick={() => { setAdding(adding === group.key ? null : group.key); setPickSkill(''); }}>
                {adding === group.key ? 'Cancel' : '+ Assign skill'}
              </Button>
            )}
          </div>
          {adding === group.key && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0' }}>
              <select value={pickSkill} onChange={(e) => setPickSkill(e.target.value)} style={selectStyle} aria-label="Skill">
                <option value="">Choose a skill…</option>
                {activeSkills.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.slug}){s.account_id ? '' : ' · global'}</option>)}
              </select>
              {pickDetail && (
                <select value={pickVersion} onChange={(e) => setPickVersion(e.target.value)} style={selectStyle} aria-label="Version">
                  {pickDetail.versions.map((v) => <option key={v.id} value={v.id}>v{v.version}</option>)}
                </select>
              )}
              <Button size="sm" variant="primary" disabled={!pickSkill || !pickVersion || busy} onClick={() => void add(group)}>Assign</Button>
            </div>
          )}
          {group.items.length === 0 ? (
            <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>No skills yet.</div>
          ) : (
            <div style={{ display: 'grid', gap: 4 }}>
              {group.items.map((a) => {
                const skill = skills.find((s) => s.id === a.skill_id);
                const behind = a.version !== null && a.latest_version !== null && a.latest_version > a.version;
                return (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: `1px solid ${tokens.colors.border}` }}>
                    <button
                      type="button"
                      onClick={() => skill && onOpenSkill(skill)}
                      disabled={!skill}
                      style={{ border: 'none', background: 'none', padding: 0, cursor: skill ? 'pointer' : 'default', fontFamily: 'inherit', textAlign: 'left', minWidth: 0 }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.accentSubtle }}>{a.skill_name || a.skill_slug}</span>
                      <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}> {a.skill_slug}</span>
                    </button>
                    <Badge variant="neutral" size="sm">v{a.version ?? '?'}</Badge>
                    {behind && <Badge variant="warning" size="sm">v{a.latest_version} available</Badge>}
                    {a.skill_status !== 'active' && <Badge variant="danger" size="sm">{a.skill_status}</Badge>}
                    {group.scope === 'runtime' && (
                      <span title={a.runtime_key || ''} style={{ fontSize: 11.5, color: tokens.colors.textSecondary }}>{a.target_label || a.runtime_key}</span>
                    )}
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      {behind && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void repinLatest(a)}>Pin latest</Button>}
                      <Button size="sm" variant="ghost" onClick={() => void remove(a)}>Unassign</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
