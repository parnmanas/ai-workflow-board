import React, { useState, useEffect, useCallback } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import type { Resource, Credential } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Badge, Card } from '../common';
import { relativeTime } from '../../utils/time';

const RESOURCE_TYPES = [
  { value: 'repository', label: 'Repository', icon: 'R' },
  { value: 'document', label: 'Document', icon: 'D' },
  { value: 'image', label: 'Image', icon: 'I' },
  { value: 'link', label: 'Link', icon: 'L' },
  { value: 'comment_attachment', label: 'Comment Attachment', icon: 'A' },
] as const;

// Types that the resource UI treats as "system-managed" — excluded from the
// default list and only shown when the user picks them via the type filter.
const HIDDEN_TYPES = new Set(['comment_attachment']);

function typeIcon(type: string): string {
  const found = RESOURCE_TYPES.find((t) => t.value === type);
  return found ? found.icon : 'L';
}

function typeLabel(type: string): string {
  const found = RESOURCE_TYPES.find((t) => t.value === type);
  return found ? found.label : type;
}

interface ResourceManagerProps {
  workspaceId?: string;
  boardId?: string | null;
}

export default function ResourceManager({ workspaceId, boardId }: ResourceManagerProps) {
  const { showToast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editResource, setEditResource] = useState<Resource | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Resource | null>(null);
  const [saving, setSaving] = useState(false);
  const [filterType, setFilterType] = useState<string>('');

  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formType, setFormType] = useState<string>('link');
  const [formUrl, setFormUrl] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formTags, setFormTags] = useState('');
  const [formFileData, setFormFileData] = useState('');
  const [formFileName, setFormFileName] = useState('');
  const [formFileMimetype, setFormFileMimetype] = useState('');
  const [formCredentialId, setFormCredentialId] = useState<string>('');
  const [formErrors, setFormErrors] = useState<{ name?: string }>({});
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);

  const effectiveWorkspaceId = workspaceId || (getActiveWorkspaceId() || '');

  const loadResources = useCallback(async () => {
    if (!effectiveWorkspaceId) {
      setResources([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [list, creds] = await Promise.all([
        api.listResources(
          effectiveWorkspaceId,
          boardId !== undefined ? (boardId || '') : undefined,
          filterType || undefined,
        ),
        api.listCredentials(effectiveWorkspaceId).catch(() => [] as Credential[]),
      ]);
      setResources(list);
      setCredentials(creds);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load resources', 'error');
    } finally {
      setLoading(false);
    }
  }, [effectiveWorkspaceId, boardId, filterType, showToast]);

  useEffect(() => {
    loadResources();
  }, [loadResources]);

  useEffect(() => {
    if (!lightboxImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxImage(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightboxImage]);

  const openResourceFile = (r: Resource) => {
    const mime = r.file_mimetype || '';
    // Treat as image when the mime says so, or when the user classified the
    // resource as 'image' — some older uploads landed with an empty mimetype
    // and would otherwise fall through to the octet-stream download branch.
    const isImage = mime.startsWith('image/') || (r.type === 'image' && !!r.file_data);
    if (r.file_data && isImage) {
      const effectiveMime = mime.startsWith('image/') ? mime : 'image/png';
      setLightboxImage({ src: `data:${effectiveMime};base64,${r.file_data}`, alt: r.name });
      return;
    }
    if (r.file_data) {
      try {
        const bytes = Uint8Array.from(atob(r.file_data), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const win = window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        if (!win) {
          const a = document.createElement('a');
          a.href = url;
          a.download = r.file_name || r.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
      } catch (err: any) {
        showToast(err?.message || 'Failed to open file', 'error');
      }
      return;
    }
    if (r.url) {
      window.open(r.url, '_blank', 'noopener,noreferrer');
    }
  };

  const startCreate = () => {
    setFormName('');
    setFormDescription('');
    setFormType('link');
    setFormUrl('');
    setFormContent('');
    setFormTags('');
    setFormFileData('');
    setFormFileName('');
    setFormFileMimetype('');
    setFormCredentialId('');
    setFormErrors({});
    setEditResource(null);
    setShowForm(true);
  };

  const startEdit = (resource: Resource) => {
    setFormName(resource.name);
    setFormDescription(resource.description || '');
    setFormType(resource.type || 'link');
    setFormUrl(resource.url || '');
    setFormContent(resource.content || '');
    setFormTags((resource.tags || []).join(', '));
    setFormFileData(resource.file_data || '');
    setFormFileName(resource.file_name || '');
    setFormFileMimetype(resource.file_mimetype || '');
    setFormCredentialId(resource.credential_id || '');
    setFormErrors({});
    setEditResource(resource);
    setShowForm(true);
  };

  const cancelForm = () => {
    setShowForm(false);
    setEditResource(null);
    setFormErrors({});
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] || result;
      setFormFileData(base64);
      setFormFileName(file.name);
      setFormFileMimetype(file.type);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    const errors: { name?: string } = {};
    if (!formName.trim()) errors.name = 'Name is required.';
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }
    if (!effectiveWorkspaceId) {
      showToast('Select a workspace first.', 'error');
      return;
    }

    const parsedTags = formTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    setSaving(true);
    try {
      if (editResource) {
        await api.updateResource(editResource.id, {
          workspace_id: effectiveWorkspaceId,
          name: formName.trim(),
          description: formDescription,
          type: formType,
          url: formUrl,
          content: formContent,
          file_data: formFileData,
          file_name: formFileName,
          file_mimetype: formFileMimetype,
          tags: parsedTags,
          credential_id: formCredentialId || null,
        });
        showToast('Resource updated.', 'success');
      } else {
        await api.createResource({
          workspace_id: effectiveWorkspaceId,
          board_id: boardId || null,
          credential_id: formCredentialId || null,
          name: formName.trim(),
          description: formDescription,
          type: formType,
          url: formUrl,
          content: formContent,
          file_data: formFileData,
          file_name: formFileName,
          file_mimetype: formFileMimetype,
          tags: parsedTags,
        });
        showToast('Resource created.', 'success');
      }
      setShowForm(false);
      setEditResource(null);
      await loadResources();
    } catch (err: any) {
      showToast(err?.message || 'Failed to save resource', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteResource(deleteTarget.id, effectiveWorkspaceId);
      showToast('Resource deleted.', 'success');
      setDeleteTarget(null);
      await loadResources();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete resource', 'error');
    }
  };

  if (!effectiveWorkspaceId) {
    return (
      <div style={{ fontSize: '13px', color: tokens.colors.textSecondary }}>Select a workspace first.</div>
    );
  }

  const iconBadgeStyle = (type: string): React.CSSProperties => {
    const colorMap: Record<string, string> = {
      repository: tokens.colors.accent,
      document: tokens.colors.warning || '#e6a817',
      image: '#8b5cf6',
      link: tokens.colors.textSecondary,
    };
    return {
      width: 28,
      height: 28,
      borderRadius: tokens.radii.md,
      background: `${colorMap[type] || tokens.colors.border}20`,
      color: colorMap[type] || tokens.colors.textSecondary,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '12px',
      fontWeight: 700,
      flexShrink: 0,
    };
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{resources.length} resources</span>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            style={{
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '4px 8px',
              color: tokens.colors.textStrong,
              fontSize: '12px',
              fontFamily: 'inherit',
            }}
          >
            <option value="">All types</option>
            {RESOURCE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <Button variant="primary" size="md" onClick={startCreate}>+ New Resource</Button>
      </div>

      {loading ? (
        <div style={{ fontSize: '13px', color: tokens.colors.textSecondary, padding: 24 }}>Loading…</div>
      ) : resources.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>No resources yet</div>
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
            Add references like repositories, documents, images, or links.
          </div>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: tokens.spacing.md,
        }}>
          {resources.map((r) => (
            <Card key={r.id} padding="12px 14px">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
                <div style={iconBadgeStyle(r.type)}>{typeIcon(r.type)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textStrong, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.name}
                    </div>
                    <Badge variant="neutral">{typeLabel(r.type)}</Badge>
                  </div>
                  {r.description && (
                    <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginTop: 2, lineHeight: 1.4 }}>
                      {r.description}
                    </div>
                  )}
                </div>
              </div>

              {r.url && (
                <div style={{ fontSize: '11px', color: tokens.colors.accent, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                  >
                    {r.url}
                  </a>
                </div>
              )}

              {r.type === 'image' && r.file_data && (
                <div style={{ marginBottom: 6 }}>
                  <img
                    src={`data:${r.file_mimetype || 'image/png'};base64,${r.file_data}`}
                    alt={r.name}
                    onClick={() => openResourceFile(r)}
                    title="Click to view full size"
                    style={{ maxWidth: '100%', maxHeight: 120, borderRadius: tokens.radii.sm, objectFit: 'contain', cursor: 'zoom-in', display: 'block' }}
                  />
                </div>
              )}

              {r.file_name && r.type !== 'image' && (
                <div
                  onClick={() => openResourceFile(r)}
                  title="Click to open"
                  style={{ fontSize: '11px', color: tokens.colors.accent, marginBottom: 4, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.textDecoration = 'underline'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.textDecoration = 'none'; }}
                >
                  File: {r.file_name}
                </div>
              )}

              {r.tags && r.tags.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                  {r.tags.map((tag, i) => (
                    <span key={i} style={{
                      fontSize: '10px',
                      padding: '2px 6px',
                      borderRadius: tokens.radii.sm,
                      background: `${tokens.colors.border}80`,
                      color: tokens.colors.textSecondary,
                    }}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 }}>
                <div style={{ fontSize: '11px', color: tokens.colors.textMuted }}>
                  {relativeTime(r.updated_at || r.created_at)}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {r.file_data && <Button variant="secondary" size="sm" onClick={() => openResourceFile(r)}>View</Button>}
                  <Button variant="secondary" size="sm" onClick={() => startEdit(r)}>Edit</Button>
                  <Button variant="danger" size="sm" onClick={() => setDeleteTarget(r)}>Delete</Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create/edit form modal */}
      <Modal
        isOpen={showForm}
        onClose={cancelForm}
        title={editResource ? 'Edit Resource' : 'New Resource'}
        maxWidth={560}
        footer={
          <>
            <Button variant="secondary" onClick={cancelForm} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving} loading={saving}>
              Save Resource
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
              placeholder="e.g. Main Repository"
              error={formErrors.name}
            />
            <div>
              <label style={{
                fontSize: tokens.typography.fontSizeXs,
                fontWeight: tokens.typography.fontWeightSemibold,
                color: tokens.colors.textMuted,
                textTransform: 'uppercase',
                display: 'block',
                marginBottom: tokens.spacing.xs,
              }}>Type</label>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value)}
                style={{
                  width: '100%',
                  background: tokens.colors.surface,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  padding: '8px 10px',
                  color: tokens.colors.textStrong,
                  fontSize: '12px',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              >
                {RESOURCE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          <Input
            label="Description"
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            placeholder="One-line summary"
          />

          {(formType === 'link' || formType === 'repository') && (
            <Input
              label="URL"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder="https://..."
            />
          )}

          {(formType === 'document' || formType === 'link') && (
            <div>
              <label style={{
                fontSize: tokens.typography.fontSizeXs,
                fontWeight: tokens.typography.fontWeightSemibold,
                color: tokens.colors.textMuted,
                textTransform: 'uppercase',
                display: 'block',
                marginBottom: tokens.spacing.xs,
              }}>Content</label>
              <textarea
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                placeholder="Text content or notes..."
                style={{
                  width: '100%',
                  background: tokens.colors.surface,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  padding: '8px 10px',
                  color: tokens.colors.textStrong,
                  fontSize: '12px',
                  outline: 'none',
                  boxSizing: 'border-box',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  lineHeight: 1.5,
                  resize: 'vertical',
                  minHeight: 120,
                }}
              />
            </div>
          )}

          {formType === 'image' && (
            <div>
              <label style={{
                fontSize: tokens.typography.fontSizeXs,
                fontWeight: tokens.typography.fontWeightSemibold,
                color: tokens.colors.textMuted,
                textTransform: 'uppercase',
                display: 'block',
                marginBottom: tokens.spacing.xs,
              }}>File Upload</label>
              <input
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                style={{
                  fontSize: '12px',
                  color: tokens.colors.textStrong,
                }}
              />
              {formFileName && (
                <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginTop: 4 }}>
                  {formFileName}
                </div>
              )}
              {formFileData && (
                <img
                  src={`data:${formFileMimetype || 'image/png'};base64,${formFileData}`}
                  alt="Preview"
                  style={{ maxWidth: '100%', maxHeight: 160, marginTop: 8, borderRadius: tokens.radii.sm, objectFit: 'contain' }}
                />
              )}
              <div style={{ marginTop: 8 }}>
                <Input
                  label="Or paste image URL"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder="https://example.com/image.png"
                />
              </div>
            </div>
          )}

          {credentials.length > 0 && (
            <div>
              <label style={{
                fontSize: tokens.typography.fontSizeXs,
                fontWeight: tokens.typography.fontWeightSemibold,
                color: tokens.colors.textMuted,
                textTransform: 'uppercase',
                display: 'block',
                marginBottom: tokens.spacing.xs,
              }}>Credential</label>
              <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 4 }}>
                Optional — used for authenticated access (e.g. GitHub sync)
              </div>
              <select
                value={formCredentialId}
                onChange={(e) => setFormCredentialId(e.target.value)}
                style={{
                  width: '100%',
                  background: tokens.colors.surface,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  padding: '8px 10px',
                  color: tokens.colors.textStrong,
                  fontSize: '12px',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              >
                <option value="">None</option>
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>
                ))}
              </select>
            </div>
          )}

          <Input
            label="Tags"
            value={formTags}
            onChange={(e) => setFormTags(e.target.value)}
            placeholder="Comma-separated, e.g. frontend, design"
          />
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete resource?"
        maxWidth={440}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={handleConfirmDelete}>Delete Resource</Button>
          </>
        }
      >
        <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
          {deleteTarget?.name} will be permanently removed.
        </div>
      </Modal>

      {lightboxImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={lightboxImage.alt}
          onClick={() => setLightboxImage(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.92)',
            zIndex: 10000,
            overflow: 'auto',
            cursor: 'zoom-out',
          }}
        >
          <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
            <img
              src={lightboxImage.src}
              alt={lightboxImage.alt}
              onClick={(e) => e.stopPropagation()}
              style={{ cursor: 'default', background: '#fff', borderRadius: tokens.radii.sm, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}
            />
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setLightboxImage(null); }}
            style={{
              position: 'fixed',
              top: 12,
              right: 16,
              background: 'rgba(255, 255, 255, 0.18)',
              color: '#fff',
              border: 'none',
              borderRadius: tokens.radii.sm,
              padding: '8px 14px',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Close (Esc)
          </button>
          <div
            style={{
              position: 'fixed',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(0, 0, 0, 0.6)',
              color: '#fff',
              padding: '6px 12px',
              borderRadius: tokens.radii.sm,
              fontSize: 12,
              maxWidth: '80vw',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            {lightboxImage.alt}
          </div>
        </div>
      )}
    </div>
  );
}
