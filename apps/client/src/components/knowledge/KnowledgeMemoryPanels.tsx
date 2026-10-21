import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { MemoryBatchResultItem, MemoryHostInfo, MemoryHostSnapshot, Project, SkillAssignment } from '../../types';
import { Button, Card } from '../common';
import MemoryDiffView from '../memory/MemoryDiffView';
import { estimateTokens } from '../memory/memoryFormat.logic';
import { knowledgeBlockId, sharedKnowledgeBody, syncOps, syncStatus, syncTargets, type SyncStatus, type SyncTarget } from './knowledge.logic';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** 서버 KNOWLEDGE_MEMORY_MAX 와 같은 값. */
const SHARED_MEMORY_MAX = 32_000;

const textareaStyle: React.CSSProperties = {
  width: '100%', minHeight: 260, boxSizing: 'border-box', resize: 'vertical', fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6,
  padding: '10px 12px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary,
};
const selectStyle: React.CSSProperties = {
  fontSize: 12.5, padding: '4px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary,
};

function WhereItApplies({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: tokens.colors.textSecondary, lineHeight: 1.6 }}>
      {items.map((t) => <li key={t}>{t}</li>)}
    </ul>
  );
}

function SkillChips({ items, empty, onManage }: { items: SkillAssignment[]; empty: string; onManage: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {items.length === 0 && <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>{empty}</span>}
      {items.map((a) => (
        <span key={a.id} title={a.skill_name} style={{ border: `1px solid ${tokens.colors.accent}55`, color: tokens.colors.accentSubtle, borderRadius: 999, padding: '2px 9px', fontSize: 11.5, fontWeight: 600 }}>
          {a.skill_slug} v{a.version ?? '?'}
        </span>
      ))}
      <button type="button" onClick={onManage} style={{ border: 'none', background: 'none', color: tokens.colors.accentSubtle, cursor: 'pointer', fontSize: 12 }}>
        Manage in Skills →
      </button>
    </div>
  );
}

const STATUS_LABEL: Record<SyncStatus, { text: string; color: string }> = {
  current: { text: 'up to date', color: tokens.colors.success },
  outdated: { text: 'outdated', color: tokens.colors.warning },
  missing: { text: 'not synced', color: tokens.colors.textMuted },
  unknown: { text: 'large file — checked on sync', color: tokens.colors.textMuted },
};

/**
 * 공용 지식을 한 호스트의 CLI 전역 메모리 파일에 관리 블록으로 넣는다 — 사람이 직접 여는 CLI 세션(그리고
 * credential 세션 홈)은 AWB 지시문을 받지 않으므로 이 블록으로 같은 지식을 읽는다. 나머지 내용은 그대로 두고,
 * 다시 동기화하면 블록만 바뀐다. 매니저가 쓰기 전에 백업한다(Memory → Host files → History).
 */
function HostSync({ accountId, body }: { accountId: string; body: string }) {
  const { showToast } = useToast();
  const [hosts, setHosts] = useState<MemoryHostInfo[] | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostId, setHostId] = useState('');
  const [snapshot, setSnapshot] = useState<MemoryHostSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<MemoryBatchResultItem[] | null>(null);
  const id = knowledgeBlockId(accountId);

  useEffect(() => {
    api.listMemoryHosts()
      .then((rows) => {
        const usable = rows.filter((h) => h.supported);
        setHosts(usable);
        if (usable.length === 1) setHostId(usable[0].manager_id);
      })
      .catch((err: any) => setHostError(err?.status === 403 ? 'Syncing to hosts needs the CLI Memory permission.' : err?.message || 'Failed to list hosts'));
  }, []);

  const loadSnapshot = useCallback(async (managerId: string) => {
    setLoading(true);
    setResults(null);
    try {
      setSnapshot(await api.getMemorySnapshot(managerId));
    } catch (err: any) {
      showToast(err?.message || 'Failed to read that host', 'error');
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { if (hostId) void loadSnapshot(hostId); else setSnapshot(null); }, [hostId, loadSnapshot]);

  const targets = useMemo(() => (snapshot ? syncTargets(snapshot) : []), [snapshot]);
  const keyOf = (t: SyncTarget) => `${t.cli.cli}|${t.file.path}`;
  useEffect(() => {
    setSelected(new Set(targets.filter((t) => syncStatus(t.file, id, body) !== 'current').map(keyOf)));
  }, [targets, id, body]);

  const run = async () => {
    if (!snapshot) return;
    setRunning(true);
    try {
      // 내용이 생략된 큰 파일은 전문을 읽은 뒤에 블록을 넣는다(남의 내용을 잘라 쓰지 않게).
      const chosen: SyncTarget[] = [];
      for (const t of targets.filter((x) => selected.has(keyOf(x)))) {
        if (t.file.exists && (t.file.content === null || t.file.truncated || t.file.omitted)) {
          chosen.push({ ...t, file: await api.readMemoryFile(snapshot.manager_id, t.cli.cli, t.file.path) });
        } else {
          chosen.push(t);
        }
      }
      const ops = syncOps(chosen, id, body);
      if (!ops.length) {
        showToast('Everything selected is already up to date.', 'info');
        return;
      }
      const { results: out } = await api.memoryBatch(snapshot.manager_id, ops);
      setResults(out);
      const ok = out.filter((r) => r.ok).length;
      showToast(`Synced ${ok} of ${out.length} file(s).`, ok === out.length ? 'success' : 'error');
      await loadSnapshot(snapshot.manager_id);
    } catch (err: any) {
      showToast(err?.message || 'Sync failed', 'error');
    } finally {
      setRunning(false);
    }
  };

  if (hostError) return <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>{hostError}</div>;
  if (!hosts) return <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading hosts…</div>;
  if (!hosts.length) return <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>No Runtime Host with an up-to-date agent-manager is connected.</div>;

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={hostId} onChange={(e) => setHostId(e.target.value)} style={selectStyle} aria-label="Runtime Host">
          <option value="">Choose a Runtime Host…</option>
          {hosts.map((h) => <option key={h.manager_id} value={h.manager_id}>{h.name}</option>)}
        </select>
        <button type="button" onClick={() => setPreview(preview === null ? body : null)} style={{ border: 'none', background: 'none', color: tokens.colors.accentSubtle, cursor: 'pointer', fontSize: 12 }}>
          {preview === null ? 'Show the block' : 'Hide the block'}
        </button>
        {snapshot && (
          <Button size="sm" variant="primary" disabled={running || !selected.size} onClick={() => void run()} style={{ marginLeft: 'auto' }}>
            {running ? 'Syncing…' : `Sync ${selected.size} file${selected.size === 1 ? '' : 's'}`}
          </Button>
        )}
      </div>
      {preview !== null && <pre style={{ margin: 0, padding: 10, borderRadius: tokens.radii.md, background: tokens.colors.surfaceSubtle, fontFamily: MONO, fontSize: 11.5, whiteSpace: 'pre-wrap', color: tokens.colors.textPrimary }}>{preview}</pre>}
      {loading && <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Reading that host…</div>}
      {snapshot && !loading && (
        targets.length === 0 ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>No CLI global instruction file on this host.</div>
        ) : (
          <div style={{ display: 'grid', gap: 2 }}>
            {targets.map((t) => {
              const status = syncStatus(t.file, id, body);
              const home = t.cli.homes.find((h) => h.id === t.file.home_id);
              const result = results?.find((r) => r.path === t.file.path);
              return (
                <label key={keyOf(t)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '3px 0', color: tokens.colors.textPrimary }}>
                  <input
                    type="checkbox"
                    checked={selected.has(keyOf(t))}
                    onChange={(e) => setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(keyOf(t)); else next.delete(keyOf(t));
                      return next;
                    })}
                  />
                  <b style={{ minWidth: 100 }}>{t.cli.label}</b>
                  <span style={{ fontFamily: MONO, fontSize: 11.5, color: tokens.colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.file.display_path}</span>
                  {home && home.kind !== 'operator' && (
                    <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>({home.kind === 'session' ? `session · ${home.credential_name || home.credential_id?.slice(0, 8)}` : `profile · ${home.profile}`})</span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, color: result ? (result.ok ? tokens.colors.success : tokens.colors.danger) : STATUS_LABEL[status].color, whiteSpace: 'nowrap' }}>
                    {result ? (result.ok ? '✓ synced' : `✗ ${result.code || result.error}`) : STATUS_LABEL[status].text}
                  </span>
                </label>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

/** 공용 메모리 — 계정의 모든 Agent 가 알아야 할 것. */
export function SharedMemoryPanel() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { currentAccountId, availableAccounts } = useAuth();
  const [accountId, setAccountId] = useState(currentAccountId || availableAccounts[0]?.id || '');
  const [accountName, setAccountName] = useState('');
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [assignments, setAssignments] = useState<SkillAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const account = await api.getAccount(accountId);
      setAccountName(account.name);
      setSaved(account.knowledge_memory || '');
      setDraft(account.knowledge_memory || '');
      setAssignments(await api.listSkillAssignments(accountId).catch(() => [] as SkillAssignment[]));
    } catch (err: any) {
      showToast(err?.message || 'Failed to load the account', 'error');
    } finally {
      setLoading(false);
    }
  }, [accountId, showToast]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const account = await api.updateAccount(accountId, { knowledge_memory: draft });
      setSaved(account.knowledge_memory ?? draft);
      setDraft(account.knowledge_memory ?? draft);
      setShowDiff(false);
      showToast('Shared memory saved — the next ticket and mission step will carry it.', 'success');
    } catch (err: any) {
      showToast(err?.status === 403 ? 'Only an owner of this account can change its shared memory.' : err?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const shared = assignments.filter((a) => a.scope === 'account');
  const body = sharedKnowledgeBody({
    accountName: accountName || 'AWB',
    memory: saved,
    skills: shared.map((a) => ({ slug: a.skill_slug, name: a.skill_name, version: a.version })),
  });
  const dirty = draft !== saved;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ color: tokens.colors.textPrimary, fontSize: 15 }}>Shared memory</strong>
          {availableAccounts.length > 1 && (
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={selectStyle} aria-label="Account">
              {availableAccounts.map((a: any) => <option key={a.id} value={a.id}>{a.name || a.id.slice(0, 8)}</option>)}
            </select>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: draft.length > SHARED_MEMORY_MAX ? tokens.colors.danger : tokens.colors.textMuted }}>
            {draft.length.toLocaleString()} / {SHARED_MEMORY_MAX.toLocaleString()} chars · ≈{estimateTokens(draft).toLocaleString()} tokens
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: tokens.colors.textSecondary }}>
          What every agent of this account should know — conventions, preferences, how you like work reported. Keep it short: it is read on every run.
          <WhereItApplies items={[
            'Every ticket work order and mission step prompt (Knowledge section)',
            'Any agent via the AWB MCP tool get_knowledge — including Agent Sessions',
            'CLI sessions you open yourself, once synced to a host below',
          ]} />
        </div>
        {loading ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>Loading…</div>
        ) : (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              placeholder={'- Report what changed and how you verified it.\n- Never push red builds to main.\n- Prefer small commits.'}
              style={textareaStyle}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {dirty && <button type="button" onClick={() => setShowDiff((v) => !v)} style={{ border: 'none', background: 'none', color: tokens.colors.accentSubtle, cursor: 'pointer', fontSize: 12 }}>{showDiff ? 'Hide changes' : 'Show changes'}</button>}
              <Button size="sm" variant="secondary" disabled={!dirty || saving} onClick={() => setDraft(saved)} style={{ marginLeft: 'auto' }}>Revert</Button>
              <Button size="sm" variant="primary" disabled={!dirty || saving || draft.length > SHARED_MEMORY_MAX} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
            {showDiff && dirty && <MemoryDiffView before={saved} after={draft} maxHeight={260} />}
          </>
        )}
      </Card>

      <Card style={{ display: 'grid', gap: 8 }}>
        <strong style={{ color: tokens.colors.textPrimary }}>Shared skills</strong>
        <SkillChips items={shared} empty="No skill is assigned to every agent yet." onManage={() => navigate('/skills')} />
      </Card>

      <Card style={{ display: 'grid', gap: 8 }}>
        <strong style={{ color: tokens.colors.textPrimary }}>Sync to a host's CLI files</strong>
        <div style={{ fontSize: 12.5, color: tokens.colors.textSecondary }}>
          Writes the shared memory and the shared skill list as one managed block into each CLI's global instruction file
          ({'CLAUDE.md, AGENTS.md, GEMINI.md'} …), including AWB credential session homes. The rest of each file stays as it is;
          syncing again replaces only the block, and every write is backed up first.
          {dirty && <b style={{ color: tokens.colors.warning }}> Save first — the block uses the saved memory.</b>}
        </div>
        {accountId && <HostSync accountId={accountId} body={body} />}
      </Card>
    </div>
  );
}

/** 프로젝트 메모리 — 그 프로젝트의 작업에만(Project.instructions). */
export function ProjectMemoryPanel() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { currentAccountId } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [assignments, setAssignments] = useState<SkillAssignment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.listProjects(currentAccountId || '');
      setProjects(rows);
      setProjectId((prev) => prev || rows[0]?.id || '');
    } catch (err: any) {
      showToast(err?.message || 'Failed to load projects', 'error');
    } finally {
      setLoading(false);
    }
  }, [currentAccountId, showToast]);

  useEffect(() => { void load(); }, [load]);

  const project = projects.find((p) => p.id === projectId) ?? null;
  useEffect(() => {
    setDraft(project?.instructions || '');
    if (!project) return;
    api.listSkillAssignments(project.account_id)
      .then((rows) => setAssignments(rows.filter((a) => a.scope === 'project' && a.project_id === project.id)))
      .catch(() => setAssignments([]));
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!project) return;
    setSaving(true);
    try {
      const updated = await api.updateProject(project.id, { instructions: draft });
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      showToast(`Saved — ${project.name}'s next ticket and mission step will carry it.`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !projects.length) return <div style={{ fontSize: 13, color: tokens.colors.textMuted }}>Loading projects…</div>;
  if (!projects.length) {
    return <Card><span style={{ color: tokens.colors.textMuted, fontSize: 13 }}>No projects yet. Register a repository under Knowledge → Projects first.</span></Card>;
  }
  const dirty = !!project && draft !== (project.instructions || '');

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
      <div style={{ display: 'grid', gap: 4 }}>
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setProjectId(p.id)}
            style={{
              textAlign: 'left', padding: '7px 10px', borderRadius: tokens.radii.md, cursor: 'pointer', fontFamily: 'inherit',
              border: `1px solid ${p.id === projectId ? tokens.colors.accent : tokens.colors.border}`,
              background: p.id === projectId ? tokens.colors.badgeAgentBg : 'transparent',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>{p.name}</div>
            <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>{(p.instructions || '').trim() ? `≈${estimateTokens(p.instructions).toLocaleString()} tokens` : 'empty'}</div>
          </button>
        ))}
      </div>
      {project && (
        <div style={{ display: 'grid', gap: 14 }}>
          <Card style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <strong style={{ color: tokens.colors.textPrimary, fontSize: 15 }}>{project.name}</strong>
              <span style={{ fontSize: 11.5, color: tokens.colors.textMuted }}>{project.repo_url}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: tokens.colors.textMuted }}>≈{estimateTokens(draft).toLocaleString()} tokens</span>
            </div>
            <div style={{ fontSize: 12.5, color: tokens.colors.textSecondary }}>
              What agents need for this project only — build and test commands, conventions, where things live. The repository's own
              CLAUDE.md / AGENTS.md still apply; use this for what is not in the repo.
              <WhereItApplies items={[
                'Every ticket of this project (work order → Project instructions)',
                'Every mission step that works on this project',
                'Any agent via get_knowledge with this project',
              ]} />
            </div>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} style={textareaStyle} placeholder={'Build: npm run build\nTest: npm test (server suites need dist)\nNever commit generated files.'} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="secondary" disabled={!dirty || saving} onClick={() => setDraft(project.instructions || '')} style={{ marginLeft: 'auto' }}>Revert</Button>
              <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
            {dirty && <MemoryDiffView before={project.instructions || ''} after={draft} maxHeight={220} />}
          </Card>
          <Card style={{ display: 'grid', gap: 8 }}>
            <strong style={{ color: tokens.colors.textPrimary }}>Project skills</strong>
            <SkillChips items={assignments} empty="No skill is assigned to this project yet." onManage={() => navigate('/skills')} />
          </Card>
        </div>
      )}
    </div>
  );
}
