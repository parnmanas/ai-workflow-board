import React, { useEffect, useMemo, useState } from 'react';
import { tokens } from '../tokens';
import { api } from '../api';
import type { TicketCreateInput } from '../api';
import type { Project, RepoBranch, TicketTagCount } from '../types';
import { Button, Input, Modal, Select } from './common';
import { TagInput } from './common/TagInput';
import RuntimeSpecEditor, { emptyRuntimeSpec, type RuntimeHostChoice, type RuntimeSpecDraft } from './runtime/RuntimeSpecEditor';
import { isRuntimeSpecComplete } from '../runtime/runtimeSpec';
import { applyProjectFolder, prefillAssigneeForProject } from '../projects/projectFolders';
import { mergeTagSuggestions } from '../tickets/tagInput';
import { useTicketTags } from '../tickets/useTicketTags';
import {
  DEFAULT_TICKET_STATUS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketPriority,
  type TicketStatus,
} from '../tickets/status';

interface CreateTicketFormProps {
  isOpen: boolean;
  accountId: string;
  projects: Project[];
  /** Known tags (facet counts from the list) for the tag input suggestions. */
  knownTags?: ReadonlyArray<TicketTagCount | string>;
  /** Pre-selected values when the form opens (e.g. the project filter in effect). */
  initialStatus?: TicketStatus;
  initialProjectId?: string;
  /** Resolves when the ticket was created; a rejection keeps the form open. */
  onSubmit: (body: TicketCreateInput) => Promise<void> | void;
  onCancel: () => void;
}

const labelStyle: React.CSSProperties = {
  fontSize: tokens.typography.fontSizeXs,
  fontWeight: tokens.typography.fontWeightSemibold,
  color: tokens.colors.textMuted,
  textTransform: 'uppercase',
  display: 'block',
  marginBottom: tokens.spacing.xs,
};

// Atomic ticket creation — every field captured together and POSTed once to
// POST /accounts/:wsId/tickets. Before this modal, a stub row with title-only
// was written immediately and the description followed as a separate PATCH;
// the assignee picked up the empty stub before the human finished typing.
// Requiring description here gives "done composing" an unambiguous signal.
//
// Assignee: one RuntimeSpec (docs/tickets.md). Picking a project prefills it
// with the project's `default_assignee`, and whenever the chosen host has a
// main clone folder for the project, an empty working_dir is filled with it.
// Leaving it unset sends no `assignee`, so the server applies the project's
// default (or leaves the ticket unassigned — never dispatched).
export default function CreateTicketForm({
  isOpen,
  accountId,
  projects,
  knownTags = [],
  initialStatus,
  initialProjectId,
  onSubmit,
  onCancel,
}: CreateTicketFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TicketStatus>(DEFAULT_TICKET_STATUS);
  const [priority, setPriority] = useState<TicketPriority>('medium');
  const [tags, setTags] = useState<string[]>([]);
  const [projectId, setProjectId] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<RepoBranch[]>([]);
  const [branchesState, setBranchesState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [assigneeOn, setAssigneeOn] = useState(false);
  const [assignee, setAssignee] = useState<RuntimeSpecDraft>(emptyRuntimeSpec);
  // The user changed the assignee by hand — a project switch must not
  // overwrite it with the project's default any more.
  const [assigneeTouched, setAssigneeTouched] = useState(false);
  const [hosts, setHosts] = useState<RuntimeHostChoice[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ title?: string; description?: string; assignee?: string }>({});

  const project = useMemo(() => projects.find((p) => p.id === projectId) || null, [projects, projectId]);
  // Whole-workspace tags (not just the current filter's facet).
  const workspaceTags = useTicketTags(accountId, isOpen);
  const tagSuggestions = useMemo(() => mergeTagSuggestions(workspaceTags, knownTags), [workspaceTags, knownTags]);

  useEffect(() => {
    if (!isOpen) return;
    setTitle('');
    setDescription('');
    setStatus(initialStatus || DEFAULT_TICKET_STATUS);
    setPriority('medium');
    setTags([]);
    setBaseBranch('');
    setAssigneeOn(false);
    setAssignee(emptyRuntimeSpec());
    setAssigneeTouched(false);
    setErrors({});
    setSubmitting(false);
    selectProject(initialProjectId || '', { touched: false, open: false, draft: emptyRuntimeSpec() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    api.listTemplateHosts()
      .then((rows) => { if (!cancelled) setHosts((rows || []).map((h) => ({ id: h.id, name: h.name || h.id.slice(0, 8) }))); })
      .catch(() => { if (!cancelled) setHosts([]); });
    return () => { cancelled = true; };
  }, [isOpen]);

  // Branches of the selected project (base branch picker).
  useEffect(() => {
    if (!isOpen || !projectId) { setBranches([]); setBranchesState('idle'); return; }
    let cancelled = false;
    setBranchesState('loading');
    api.listProjectBranches(projectId)
      .then((res) => { if (!cancelled) { setBranches(res?.branches || []); setBranchesState('idle'); } })
      .catch(() => { if (!cancelled) { setBranches([]); setBranchesState('error'); } });
    return () => { cancelled = true; };
  }, [isOpen, projectId]);

  function selectProject(
    nextId: string,
    state: { touched: boolean; open: boolean; draft: RuntimeSpecDraft },
  ) {
    setProjectId(nextId);
    setBaseBranch('');
    const next = projects.find((p) => p.id === nextId) || null;
    if (!next) return;
    const prefilled = prefillAssigneeForProject(state.open ? state.draft : null, next, { assigneeTouched: state.touched });
    if (prefilled && prefilled !== (state.open ? state.draft : null)) {
      setAssignee(prefilled);
      setAssigneeOn(true);
    }
  }

  const handleAssigneeChange = (next: RuntimeSpecDraft) => {
    setAssigneeTouched(true);
    // RuntimeSpecEditor clears working_dir on a host switch — refill it with the
    // project's main clone folder on the new host when there is one.
    const hostChanged = next.manager_agent_id !== assignee.manager_agent_id;
    setAssignee(hostChanged ? applyProjectFolder(next, project) : next);
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const nextErrors: { title?: string; description?: string; assignee?: string } = {};
    if (!title.trim()) nextErrors.title = 'Title is required.';
    if (!description.trim()) nextErrors.description = 'Description is required — the assignee starts work as soon as the ticket is queued, so the brief needs to be complete.';
    const wantsAssignee = assigneeOn && !!(assignee.manager_agent_id || assignee.cli || assignee.working_dir.trim());
    if (wantsAssignee && !isRuntimeSpecComplete(assignee)) {
      nextErrors.assignee = 'Host·CLI·절대경로 working dir 를 모두 입력하거나 담당자를 비우세요.';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setSubmitting(true);
    try {
      let spec: Record<string, any> | null | undefined;
      if (wantsAssignee) {
        const result = await api.validateRuntimeSpec(accountId, assignee);
        if (!result.ok || !result.spec) {
          setErrors({ assignee: result.error || '담당자 설정이 올바르지 않습니다.' });
          return;
        }
        spec = result.spec;
      } else if (assigneeTouched && !assigneeOn) {
        // Explicitly cleared (e.g. dropped the project's default) — say so.
        spec = null;
      }
      const body: TicketCreateInput = {
        title: title.trim(),
        description: description.trim(),
        status,
        priority,
        ...(tags.length ? { tags } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        ...(projectId && baseBranch.trim() ? { base_branch: baseBranch.trim() } : {}),
        ...(spec !== undefined ? { assignee: spec } : {}),
      };
      await onSubmit(body);
    } catch {
      // The page toasts the failure; keep the form open with the user's input.
    } finally {
      setSubmitting(false);
    }
  };

  // Ctrl/Cmd+Enter from anywhere in the form submits — mirrors the shortcut
  // most "new issue" modals (Linear, GitHub) use so returning users don't
  // have to mouse over to the button.
  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const branchOptions = [
    { value: '', label: `Project default (${project?.default_branch || 'origin/HEAD'})` },
    ...(baseBranch && !branches.some((b) => b.name === baseBranch) ? [{ value: baseBranch, label: baseBranch }] : []),
    ...branches.map((b) => ({ value: b.name, label: b.name })),
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="New Ticket"
      maxWidth={640}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Ticket'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }}
        onKeyDown={handleFormKeyDown}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <Input
          autoFocus
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Short, action-oriented summary"
          error={errors.title}
        />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <label style={labelStyle}>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What needs to happen, why it matters, acceptance criteria. Markdown supported."
            rows={6}
            style={{
              background: tokens.colors.surface,
              border: `1px solid ${errors.description ? tokens.colors.danger : tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '8px 10px',
              color: tokens.colors.textStrong,
              fontSize: tokens.typography.fontSizeMd,
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'inherit',
              lineHeight: 1.5,
              resize: 'vertical',
            }}
          />
          {errors.description && (
            <span style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.danger, marginTop: tokens.spacing.xs }}>
              {errors.description}
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as TicketStatus)}
            options={TICKET_STATUSES.map((s) => ({ value: s, label: TICKET_STATUS_LABELS[s] }))}
          />
          <Select
            label="Priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as TicketPriority)}
            options={TICKET_PRIORITIES.map((p) => ({ value: p, label: TICKET_PRIORITY_LABELS[p] }))}
          />
        </div>
        <TagInput label="Tags" value={tags} onChange={setTags} suggestions={tagSuggestions} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Select
            label="Project"
            value={projectId}
            onChange={(e) => selectProject(e.target.value, { touched: assigneeTouched, open: assigneeOn, draft: assignee })}
            options={[
              { value: '', label: '— 없음 —' },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          {projectId && branchesState === 'error' ? (
            <Input
              label="Base branch"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder={`비우면 ${project?.default_branch || 'origin/HEAD'}`}
            />
          ) : (
            <Select
              label="Base branch"
              value={baseBranch}
              disabled={!projectId || branchesState === 'loading'}
              onChange={(e) => setBaseBranch(e.target.value)}
              options={branchesState === 'loading' ? [{ value: baseBranch, label: 'Loading branches…' }] : branchOptions}
            />
          )}
        </div>

        <div style={{ border: `1px dashed ${tokens.colors.border}`, borderRadius: tokens.radii.sm, padding: 10 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={assigneeOn}
              onChange={(e) => { setAssigneeOn(e.target.checked); setAssigneeTouched(true); }}
            />
            Assignee (담당 에이전트)
          </label>
          {!assigneeOn && (
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 6 }}>
              {project?.default_assignee
                ? '비워 두면 프로젝트의 기본 담당자가 적용됩니다.'
                : '담당자가 없으면 티켓은 디스패치되지 않습니다.'}
            </div>
          )}
          {assigneeOn && (
            <div style={{ marginTop: 10 }}>
              <RuntimeSpecEditor value={assignee} onChange={handleAssigneeChange} hosts={hosts} accountId={accountId} disabled={submitting} />
            </div>
          )}
          {errors.assignee && (
            <div role="alert" style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.danger, marginTop: 6 }}>{errors.assignee}</div>
          )}
        </div>

        <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
          Ctrl/Cmd + Enter to submit
        </div>
      </form>
    </Modal>
  );
}
