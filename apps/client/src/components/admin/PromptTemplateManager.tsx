import React, { useState, useEffect, useCallback } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import type { BuiltinPromptDefault, CatalogScope, PromptTemplate } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Badge, ConfirmDialog } from '../common';
import { relativeTime } from '../../utils/time';
import { resetAllTemplateDrafts, resetTemplateDraft, type PromptTemplateResetDraft } from '../../utils/promptResetDraft';

const listHeadStyle = (align: 'left' | 'right'): React.CSSProperties => ({
  textAlign: align,
  padding: '8px 12px',
  fontWeight: 600,
});

const listCellStyle = (align: 'left' | 'right'): React.CSSProperties => ({
  textAlign: align,
  padding: '10px 12px',
  verticalAlign: 'middle',
});

export default function PromptTemplateManager({
  workspaceId,
  catalogMode = false,
  createScope = 'workspace',
  allScopes = false,
  canManageGlobal = false,
}: {
  workspaceId?: string;
  catalogMode?: boolean;
  createScope?: CatalogScope;
  allScopes?: boolean;
  canManageGlobal?: boolean;
} = {}) {
  const { showToast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editTemplate, setEditTemplate] = useState<PromptTemplate | null>(null);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<PromptTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [defaults, setDefaults] = useState<BuiltinPromptDefault[]>([]);
  const [resetDraft, setResetDraft] = useState<PromptTemplateResetDraft>({});
  const [resetAllMappings, setResetAllMappings] = useState(false);
  const [resetSaving, setResetSaving] = useState(false);

  // Form state (create + edit use the same object)
  const [formName, setFormName] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formErrors, setFormErrors] = useState<{ name?: string; content?: string }>({});

  const effectiveWorkspaceId = workspaceId || (getActiveWorkspaceId() || '');

  const loadTemplates = useCallback(async () => {
    if (!effectiveWorkspaceId) {
      setTemplates([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await api.listPromptTemplates(effectiveWorkspaceId, {
        includeAllScopes: catalogMode && allScopes,
      });
      setTemplates(list);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load templates', 'error');
    } finally {
      setLoading(false);
    }
  }, [effectiveWorkspaceId, catalogMode, allScopes, showToast]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    if (!effectiveWorkspaceId) return;
    let cancelled = false;
    api.listDefaultPromptTemplates(effectiveWorkspaceId)
      .then(rows => { if (!cancelled) setDefaults(rows); })
      .catch(() => { if (!cancelled) setDefaults([]); });
    return () => { cancelled = true; };
  }, [effectiveWorkspaceId]);

  const displayedTemplates = templates.map(template => {
    const draft = template.scope === 'workspace' ? resetDraft[template.name] : undefined;
    return draft ? { ...template, ...draft } : template;
  });

  const saveResetDraft = async () => {
    const names = Object.keys(resetDraft);
    if (names.length === 0) return;
    setResetSaving(true);
    try {
      await api.resetDefaultPromptTemplates({
        workspace_id: effectiveWorkspaceId,
        names,
        reset_board_mappings: resetAllMappings,
      });
      setResetDraft({});
      setResetAllMappings(false);
      await loadTemplates();
      showToast(resetAllMappings ? 'All column prompts and board mappings reset.' : 'Column prompt reset saved.', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to reset column prompts', 'error');
    } finally {
      setResetSaving(false);
    }
  };

  const startCreate = () => {
    setFormName('');
    setFormCategory('');
    setFormDescription('');
    setFormContent('');
    setFormErrors({});
    setEditTemplate(null);
    setShowForm(true);
  };

  const startEdit = (template: PromptTemplate) => {
    setFormName(template.name);
    setFormCategory(template.category || '');
    setFormDescription(template.description || '');
    setFormContent(template.content || '');
    setFormErrors({});
    setEditTemplate(template);
    setShowForm(true);
  };

  const cancelForm = () => {
    setShowForm(false);
    setEditTemplate(null);
    setFormErrors({});
  };

  const handleSave = async () => {
    const errors: { name?: string; content?: string } = {};
    if (!formName.trim()) errors.name = 'Name is required.';
    if (!formContent.trim()) errors.content = 'Content is required.';
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }
    if (!effectiveWorkspaceId) {
      showToast('Select a workspace first.', 'error');
      return;
    }

    setSaving(true);
    try {
      if (editTemplate) {
        await api.updatePromptTemplate(editTemplate.id, {
          scope: editTemplate.scope,
          workspace_id: editTemplate.workspace_id,
          name: formName.trim(),
          description: formDescription,
          content: formContent,
          category: formCategory,
        });
        showToast('Template updated.', 'success');
      } else {
        await api.createPromptTemplate({
          scope: createScope,
          workspace_id: createScope === 'global' ? null : effectiveWorkspaceId,
          name: formName.trim(),
          description: formDescription,
          content: formContent,
          category: formCategory,
        });
        showToast('Template created.', 'success');
      }
      setShowForm(false);
      setEditTemplate(null);
      await loadTemplates();
    } catch (err: any) {
      showToast(err?.message || 'Failed to save template', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deletePromptTemplate(deleteTarget.id, effectiveWorkspaceId);
      showToast('Template deleted.', 'success');
      setDeleteTarget(null);
      await loadTemplates();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete template', 'error');
    }
  };

  // ─── Empty workspace guard ───
  if (!effectiveWorkspaceId) {
    return (
      <div style={{ fontSize: '13px', color: tokens.colors.textSecondary }}>Select a workspace first.</div>
    );
  }

  // ─── List view ───
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div>
          <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{templates.length} templates</span>
          {Object.keys(resetDraft).length > 0 && (
            <span style={{ marginLeft: 10, fontSize: 12, color: tokens.colors.warning }}>
              {Object.keys(resetDraft).length} unsaved reset{Object.keys(resetDraft).length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Button
            variant="secondary"
            size="sm"
            disabled={defaults.length === 0 || resetSaving}
            onClick={() => {
              setResetDraft(current => resetAllTemplateDrafts(current, defaults));
              setResetAllMappings(true);
            }}
          >
            Reset all column prompts
          </Button>
          {Object.keys(resetDraft).length > 0 && (
            <>
              <Button variant="secondary" size="sm" disabled={resetSaving} onClick={() => { setResetDraft({}); setResetAllMappings(false); }}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" loading={resetSaving} onClick={saveResetDraft}>
                Save changes
              </Button>
            </>
          )}
          <Button variant="primary" size="md" onClick={startCreate}>+ New Template</Button>
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: '13px', color: tokens.colors.textSecondary, padding: 24 }}>Loading…</div>
      ) : templates.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>No templates yet</div>
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>Create a reusable prompt template for tickets in this workspace.</div>
        </div>
      ) : (
        <div
          style={{
            background: tokens.colors.surfaceCard,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            overflowX: 'auto',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr
                style={{
                  background: tokens.colors.surface,
                  color: tokens.colors.textMuted,
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                <th style={listHeadStyle('left')}>Name</th>
                <th style={listHeadStyle('left')}>Category</th>
                <th style={listHeadStyle('left')}>Description</th>
                <th style={listHeadStyle('left')}>Updated</th>
                <th style={listHeadStyle('right')}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedTemplates.map((t) => {
                const builtin = defaults.find(def => def.name === t.name);
                const resetPending = t.scope === 'workspace' && !!resetDraft[t.name];
                return (
                <tr key={t.id} style={{ borderTop: `1px solid ${tokens.colors.border}` }}>
                  <td
                    style={{
                      ...listCellStyle('left'),
                      maxWidth: 240,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: tokens.colors.textStrong,
                      fontWeight: 600,
                    }}
                    title={t.name}
                  >
                    {t.name}
                    {catalogMode && <span style={{ marginLeft: 8 }}><Badge variant="info">{t.scope}</Badge></span>}
                    {resetPending && <span style={{ marginLeft: 8 }}><Badge variant="warning">Reset pending</Badge></span>}
                  </td>
                  <td style={listCellStyle('left')}>
                    {t.category ? <Badge variant="neutral">{t.category}</Badge> : <span style={{ color: tokens.colors.textMuted }}>—</span>}
                  </td>
                  <td
                    style={{
                      ...listCellStyle('left'),
                      maxWidth: 360,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: tokens.colors.textSecondary,
                    }}
                    title={t.description || ''}
                  >
                    {t.description || <span style={{ color: tokens.colors.textMuted }}>—</span>}
                  </td>
                  <td style={{ ...listCellStyle('left'), color: tokens.colors.textMuted, whiteSpace: 'nowrap' }}>
                    {relativeTime(t.updated_at || t.created_at)}
                  </td>
                  <td style={{ ...listCellStyle('right'), whiteSpace: 'nowrap' }}>
                    {t.scope === 'global' && !canManageGlobal ? (
                      <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>Inherited (read-only)</span>
                    ) : (
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        {builtin && t.scope === 'workspace' && (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={resetPending}
                            onClick={() => setResetDraft(current => resetTemplateDraft(current, builtin))}
                          >
                            Reset
                          </Button>
                        )}
                        <Button variant="secondary" size="sm" onClick={() => startEdit(t)}>Edit</Button>
                        <Button variant="danger" size="sm" onClick={() => setDeleteTarget(t)}>Delete</Button>
                      </div>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/edit form in Modal overlay */}
      <Modal
        isOpen={showForm}
        onClose={cancelForm}
        title={editTemplate ? 'Edit Prompt Template' : 'New Prompt Template'}
        maxWidth={560}
        footer={
          <>
            <Button variant="secondary" onClick={cancelForm} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving} loading={saving}>
              Save Template
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Input
              label="Name"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Code Review Checklist"
              error={formErrors.name}
            />
            <Input
              label="Category"
              value={formCategory}
              onChange={(e) => setFormCategory(e.target.value)}
              placeholder="e.g. review, triage (free-form)"
            />
          </div>
          <Input
            label="Description"
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            placeholder="One-line summary shown in the template picker."
          />
          <div>
            <label style={{
              fontSize: tokens.typography.fontSizeXs,
              fontWeight: tokens.typography.fontWeightSemibold,
              color: tokens.colors.textMuted,
              textTransform: 'uppercase',
              display: 'block',
              marginBottom: tokens.spacing.xs,
            }}>
              Content
            </label>
            <div style={{ fontSize: '11px', fontWeight: 400, color: tokens.colors.textMuted, marginBottom: 6 }}>
              Markdown. Copied into a ticket's prompt field when selected.
            </div>
            <textarea
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              placeholder="When processing this ticket, first..."
              style={{
                width: '100%',
                background: tokens.colors.surface,
                border: `1px solid ${formErrors.content ? tokens.colors.danger : tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '8px 10px',
                color: tokens.colors.textStrong,
                fontSize: '12px',
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                lineHeight: 1.5,
                resize: 'vertical',
                minHeight: 220,
              }}
            />
            {formErrors.content && (
              <div style={{ fontSize: '11px', color: tokens.colors.danger, marginTop: 4 }}>
                {formErrors.content}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="Delete template?"
        confirmLabel="Delete Template"
        message={deleteTarget
          ? `${deleteTarget.name} will be removed from this workspace. Tickets that already used this template keep their existing prompt text.`
          : undefined}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
