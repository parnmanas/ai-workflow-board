import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ticket, Agent, Channel, ActivityLog, PromptTemplate } from '../types';
import { api } from '../api';
import { useAuth } from '../contexts/AuthContext';
import ChildTicketList from './SubtaskList';
import { tokens } from '../tokens';

interface TicketDetailProps {
  ticket: Ticket;
  columnName: string;
  agents: Agent[];
  channels: Channel[];
  onClose: () => void;
  onUpdate: (id: string, data: Record<string, any>) => void;
  onDelete: (id: string) => void;
  onCreateChild: (parentId: string, data: { title: string; description?: string; priority?: string; assignee?: string; reporter?: string }) => void;
  onDeleteChild: (childId: string) => void;
  onAddComment: (ticketId: string, content: string, images?: { filename: string; mimetype: string; data: string }[]) => void;
}

const priorityColors: Record<string, string> = {
  // tag/label palette — not tokenized
  low: '#94a3b8',
  medium: '#60a5fa',
  high: '#fbbf24',
  critical: '#ef4444',
};

export default function TicketDetail({
  ticket, columnName, agents, channels, onClose, onUpdate, onDelete,
  onCreateChild, onDeleteChild, onAddComment,
}: TicketDetailProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  // Navigation stack: [root ticket, child, grandchild, ...]
  const [navStack, setNavStack] = useState<Ticket[]>([ticket]);
  const currentTicket = navStack[navStack.length - 1];
  const isRoot = navStack.length === 1;

  const [title, setTitle] = useState(currentTicket.title);
  const [description, setDescription] = useState(currentTicket.description);
  const [priority, setPriority] = useState(currentTicket.priority);
  const [status, setStatus] = useState(currentTicket.status || 'todo');
  const resolveAgentName = (id: string | undefined, name: string) => {
    if (id) {
      const agent = agents.find(a => a.id === id);
      if (agent) return agent.name;
    }
    return name;
  };
  const [assignee, setAssignee] = useState(resolveAgentName(currentTicket.assignee_id, currentTicket.assignee));
  const [reporter, setReporter] = useState(resolveAgentName(currentTicket.reporter_id, currentTicket.reporter));
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>(currentTicket.channel_ids || []);
  const [commentContent, setCommentContent] = useState('');
  const [commentImages, setCommentImages] = useState<{ filename: string; mimetype: string; data: string }[]>([]);
  const [activeTab, setActiveTab] = useState<'detail' | 'activity'>('detail');
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  // Phase 1 ROLE-07 / ROLE-08 — agent prompt section
  const [promptText, setPromptText] = useState(currentTicket.prompt_text || '');
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [confirmReplace, setConfirmReplace] = useState<PromptTemplate | null>(null);

  // Sync nav stack root with incoming ticket prop
  useEffect(() => {
    setNavStack(prev => {
      const newStack = [ticket];
      // Rebuild stack by finding each child in the updated tree
      for (let i = 1; i < prev.length; i++) {
        const parent = newStack[newStack.length - 1];
        const updated = (parent.children || []).find(c => c.id === prev[i].id);
        if (updated) {
          newStack.push(updated);
        } else {
          break; // child was deleted, truncate stack
        }
      }
      return newStack;
    });
  }, [ticket]);

  // Reset form fields when navigating to a different ticket
  useEffect(() => {
    setTitle(currentTicket.title);
    setDescription(currentTicket.description);
    setPriority(currentTicket.priority);
    setStatus(currentTicket.status || 'todo');
    setAssignee(resolveAgentName(currentTicket.assignee_id, currentTicket.assignee));
    setReporter(resolveAgentName(currentTicket.reporter_id, currentTicket.reporter));
    setSelectedChannelIds(currentTicket.channel_ids || []);
    setCommentContent('');
    setCommentImages([]);
    setActiveTab('detail');
    setPromptText(currentTicket.prompt_text || '');
    setSelectedTemplateId('');
    setConfirmReplace(null);
  }, [currentTicket.id, currentTicket.title, currentTicket.description, currentTicket.priority, currentTicket.assignee, currentTicket.reporter, currentTicket.status, currentTicket.updated_at]);

  // Load workspace prompt templates once on mount
  useEffect(() => {
    const workspaceId = typeof window !== 'undefined'
      ? localStorage.getItem('currentWorkspaceId') || ''
      : '';
    if (!workspaceId) return;
    api.listPromptTemplates(workspaceId)
      .then(setTemplates)
      .catch(() => { /* silent — empty dropdown acceptable */ });
  }, []);

  useEffect(() => {
    if (activeTab === 'activity') {
      api.getTicketActivity(currentTicket.id).then(setActivities).catch(() => {});
    }
  }, [activeTab, currentTicket.id]);

  const navigateToChild = useCallback((child: Ticket) => {
    setNavStack(prev => [...prev, child]);
  }, []);

  const navigateBack = useCallback(() => {
    setNavStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev);
  }, []);

  const saveField = (field: string, value: any) => {
    onUpdate(currentTicket.id, { [field]: value });
  };

  const handleImageAttach = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      const newImages: typeof commentImages = [];
      for (let i = 0; i < files.length && commentImages.length + newImages.length < 5; i++) {
        const file = files[i];
        if (file.size > 5 * 1024 * 1024) continue;
        const data = await fileToBase64(file);
        newImages.push({ filename: file.name, mimetype: file.type, data });
      }
      setCommentImages(prev => [...prev, ...newImages].slice(0, 5));
    };
    input.click();
  };

  const handleSubmitComment = () => {
    if (commentContent.trim()) {
      onAddComment(currentTicket.id, commentContent.trim(), commentImages.length > 0 ? commentImages : undefined);
      setCommentContent('');
      setCommentImages([]);
    }
  };

  const statusColors: Record<string, string> = {
    // tag/label palette — not tokenized
    todo: '#94a3b8',
    in_progress: '#fbbf24',
    done: '#34d399',
  };

  const labelStyle = { fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600, textTransform: 'uppercase' as const, display: 'block', marginBottom: 4 };

  return (
    <>
      {/* Backdrop */}
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        zIndex: 1000,
      }} onClick={onClose} />

      {/* Right panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 620, maxWidth: '100vw',
        background: tokens.colors.surfaceCard, borderLeft: `1px solid ${tokens.colors.border}`, zIndex: 1001,
        display: 'flex', flexDirection: 'column',
        boxShadow: tokens.shadows.panel,
        animation: 'slideInRight 0.2s ease-out',
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 16px', borderBottom: `1px solid ${tokens.colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {!isRoot && (
              <button onClick={navigateBack} style={{
                background: tokens.colors.border, color: tokens.colors.textStrong, border: 'none', borderRadius: tokens.radii.md,
                padding: '4px 10px', fontSize: '14px', cursor: 'pointer',
              }}>&#8592;</button>
            )}
            <span style={{
              fontSize: '11px', padding: '3px 8px', borderRadius: tokens.radii.sm,
              background: tokens.colors.surface, color: tokens.colors.textSecondary, fontWeight: 500,
            }}>#{currentTicket.id.length > 8 ? currentTicket.id.slice(0, 8) : currentTicket.id}</span>
            {isRoot && (
              <span style={{
                fontSize: '11px', padding: '3px 8px', borderRadius: tokens.radii.sm,
                background: tokens.colors.surface, color: tokens.colors.textSecondary,
              }}>{columnName}</span>
            )}
            {!isRoot && (
              <span style={{
                fontSize: '10px', padding: '2px 6px', borderRadius: 4,
                background: `${statusColors[status]}20`, color: statusColors[status], fontWeight: 600,
              }}>{status.replace('_', ' ').toUpperCase()}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => {
              if (isRoot) { onDelete(currentTicket.id); onClose(); }
              else { onDeleteChild(currentTicket.id); navigateBack(); }
            }} style={{
              background: tokens.colors.dangerBg, color: tokens.colors.dangerLight, border: 'none', borderRadius: tokens.radii.md,
              padding: '4px 12px', fontSize: '12px', cursor: 'pointer',
            }}>Delete</button>
            <button onClick={onClose} style={{
              background: tokens.colors.border, color: tokens.colors.textStrong, border: 'none', borderRadius: tokens.radii.md,
              padding: '4px 12px', fontSize: '16px', cursor: 'pointer',
            }}>x</button>
          </div>
        </div>

        {/* Breadcrumb */}
        {navStack.length > 1 && (
          <div style={{
            padding: '6px 16px', borderBottom: `1px solid ${tokens.colors.border}`, flexShrink: 0,
            display: 'flex', alignItems: 'center', gap: 4, overflowX: 'auto',
          }}>
            {navStack.map((t, i) => (
              <React.Fragment key={t.id}>
                {i > 0 && <span style={{ color: tokens.colors.borderStrong, fontSize: '11px' }}>/</span>}
                <span
                  onClick={i < navStack.length - 1 ? () => setNavStack(navStack.slice(0, i + 1)) : undefined}
                  style={{
                    fontSize: '11px', color: i < navStack.length - 1 ? tokens.colors.accent : tokens.colors.textSecondary,
                    cursor: i < navStack.length - 1 ? 'pointer' : 'default',
                    whiteSpace: 'nowrap', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >{t.title}</span>
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${tokens.colors.border}`, flexShrink: 0 }}>
          {(['detail', 'activity'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              padding: '8px 16px', background: 'transparent', border: 'none',
              borderBottom: activeTab === tab ? `2px solid ${tokens.colors.accent}` : '2px solid transparent',
              color: activeTab === tab ? tokens.colors.textStrong : tokens.colors.textMuted,
              fontSize: '12px', fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
            }}>{tab}</button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {activeTab === 'detail' ? (
            <>
              {/* Title */}
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                onBlur={() => title !== currentTicket.title && saveField('title', title)}
                style={{
                  width: '100%', background: 'transparent', border: 'none', color: tokens.colors.textPrimary,
                  fontSize: '20px', fontWeight: 700, outline: 'none', marginBottom: 16,
                }}
              />

              {/* Meta row */}
              <div style={{ display: 'grid', gridTemplateColumns: !isRoot ? '1fr 1fr' : '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
                {!isRoot && (
                  <div>
                    <label style={labelStyle}>Status</label>
                    <select value={status} onChange={e => { setStatus(e.target.value); saveField('status', e.target.value); }}
                      style={{ background: tokens.colors.surface, border: `2px solid ${statusColors[status]}`, borderRadius: tokens.radii.md, padding: '6px 10px', color: statusColors[status], fontSize: '12px', fontWeight: 600, width: '100%' }}>
                      <option value="todo">To Do</option>
                      <option value="in_progress">In Progress</option>
                      <option value="done">Done</option>
                    </select>
                  </div>
                )}
                <div>
                  <label style={labelStyle}>Priority</label>
                  <select
                    value={priority}
                    onChange={e => { setPriority(e.target.value as any); saveField('priority', e.target.value); }}
                    style={{
                      background: tokens.colors.surface, border: `2px solid ${priorityColors[priority]}`,
                      borderRadius: tokens.radii.md, padding: '6px 10px',
                      color: priorityColors[priority], fontSize: '12px', fontWeight: 600, width: '100%',
                    }}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>

                <div>
                  <label style={labelStyle}>Assignee (AI)</label>
                  <select
                    value={assignee}
                    onChange={e => {
                      const name = e.target.value;
                      const agent = agents.find(a => a.name === name);
                      setAssignee(name);
                      onUpdate(currentTicket.id, { assignee: name, assignee_id: agent?.id || '' });
                    }}
                    style={{
                      background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                      padding: '6px 10px', color: tokens.colors.textStrong, fontSize: '12px', width: '100%',
                    }}
                  >
                    <option value="">Unassigned</option>
                    {agents.filter(a => a.is_active).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                  </select>
                </div>

                <div>
                  <label style={labelStyle}>Reporter (AI)</label>
                  <select
                    value={reporter}
                    onChange={e => {
                      const name = e.target.value;
                      const agent = agents.find(a => a.name === name);
                      setReporter(name);
                      onUpdate(currentTicket.id, { reporter: name, reporter_id: agent?.id || '' });
                    }}
                    style={{
                      background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                      padding: '6px 10px', color: tokens.colors.textStrong, fontSize: '12px', width: '100%',
                    }}
                  >
                    <option value="">None</option>
                    {agents.filter(a => a.is_active).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                  </select>
                </div>

                {isRoot && (
                  <div>
                    <label style={labelStyle}>Created By</label>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '6px 0',
                    }}>
                      {currentTicket.created_by ? (
                        <>
                          <span style={{
                            fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
                            textTransform: 'uppercase',
                            background: currentTicket.created_by_type === 'agent' ? tokens.colors.badgeAgentBg : tokens.colors.badgeUserBg,
                            color: currentTicket.created_by_type === 'agent' ? tokens.colors.accentLight : tokens.colors.infoLight,
                          }}>{currentTicket.created_by_type === 'agent' ? 'Agent' : 'User'}</span>
                          <span style={{ fontSize: '12px', color: tokens.colors.textStrong, fontWeight: 500 }}>{currentTicket.created_by}</span>
                        </>
                      ) : (
                        <span style={{ fontSize: '12px', color: tokens.colors.textMuted }}>—</span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Description */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ ...labelStyle, marginBottom: 6 }}>Description</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  onBlur={() => description !== currentTicket.description && saveField('description', description)}
                  placeholder="Add description..."
                  rows={4}
                  style={{
                    width: '100%', background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.lg, padding: '10px 12px', color: tokens.colors.textStrong, fontSize: '13px',
                    resize: 'vertical', outline: 'none', lineHeight: 1.6,
                  }}
                />
              </div>

              {/* Agent Prompt section — ROLE-07 / ROLE-08 */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: tokens.colors.textSecondary, textTransform: 'uppercase' }}>Agent Prompt</div>
                  {(() => {
                    const assigneeId = currentTicket.assignee_id;
                    const agentMatch = assigneeId ? agents.find(a => a.id === assigneeId) : null;
                    const disabled = !assigneeId || !agentMatch;
                    const tooltip = !assigneeId
                      ? 'Assign an agent to enable chat.'
                      : !agentMatch
                        ? 'Chat is only available for agent assignees.'
                        : undefined;
                    return (
                      <button
                        type="button"
                        disabled={disabled}
                        title={tooltip}
                        onClick={() => navigate('/chat?agent_id=' + encodeURIComponent(assigneeId || '') + '&ticket_id=' + encodeURIComponent(currentTicket.id))}
                        style={{
                          marginLeft: 'auto',
                          background: tokens.colors.accent,
                          color: 'white',
                          border: 'none',
                          borderRadius: tokens.radii.md,
                          padding: '6px 12px',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          opacity: disabled ? 0.5 : 1,
                          fontFamily: 'inherit',
                        }}
                      >
                        Chat with Agent
                      </button>
                    );
                  })()}
                </div>
                <div style={{ fontSize: '11px', fontWeight: 400, color: tokens.colors.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
                  Instructions passed to the agent when this ticket triggers. Applying a template copies its content here — later template edits will not change this ticket's prompt.
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                  <select
                    value={selectedTemplateId}
                    onChange={e => setSelectedTemplateId(e.target.value)}
                    style={{
                      flex: 1,
                      background: tokens.colors.surface,
                      border: `1px solid ${tokens.colors.border}`,
                      borderRadius: tokens.radii.md,
                      padding: '8px 10px',
                      color: tokens.colors.textStrong,
                      fontSize: '13px',
                      fontFamily: 'inherit',
                      outline: 'none',
                    }}
                  >
                    <option value="">— Select a template —</option>
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                    <option value="__custom">Custom (write your own)</option>
                  </select>
                  <button
                    disabled={!selectedTemplateId || selectedTemplateId === '__custom'}
                    onClick={() => {
                      const tpl = templates.find(t => t.id === selectedTemplateId);
                      if (!tpl) return;
                      if (promptText && promptText.trim().length > 0) {
                        setConfirmReplace(tpl);
                        return;
                      }
                      setPromptText(tpl.content);
                      saveField('prompt_text', tpl.content);
                      setSelectedTemplateId('');
                    }}
                    style={{
                      background: tokens.colors.accent,
                      color: 'white',
                      border: 'none',
                      borderRadius: tokens.radii.md,
                      padding: '8px 14px',
                      fontSize: '13px',
                      fontWeight: 600,
                      cursor: (!selectedTemplateId || selectedTemplateId === '__custom') ? 'not-allowed' : 'pointer',
                      opacity: (!selectedTemplateId || selectedTemplateId === '__custom') ? 0.5 : 1,
                      fontFamily: 'inherit',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Apply Template
                  </button>
                </div>

                {confirmReplace && (
                  <div
                    style={{
                      background: tokens.colors.surface,
                      border: `1px solid ${tokens.colors.border}`,
                      borderRadius: tokens.radii.md,
                      padding: '10px 12px',
                      marginBottom: 10,
                      fontSize: '12px',
                      color: tokens.colors.textStrong,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <span>Replace existing prompt with "{confirmReplace.name}"?</span>
                    <span style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => {
                          const tpl = confirmReplace;
                          setPromptText(tpl.content);
                          saveField('prompt_text', tpl.content);
                          setConfirmReplace(null);
                          setSelectedTemplateId('');
                        }}
                        style={{
                          background: tokens.colors.accent, color: 'white', border: 'none', borderRadius: tokens.radii.xs,
                          padding: '6px 12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        Replace
                      </button>
                      <button
                        onClick={() => setConfirmReplace(null)}
                        style={{
                          background: 'transparent', color: tokens.colors.textSecondary, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.xs,
                          padding: '6px 12px', fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        Cancel
                      </button>
                    </span>
                  </div>
                )}

                <textarea
                  value={promptText}
                  onChange={e => setPromptText(e.target.value)}
                  onBlur={() => {
                    if (promptText !== (currentTicket.prompt_text || '')) {
                      saveField('prompt_text', promptText);
                    }
                  }}
                  placeholder="No prompt set. Select a template above or write a custom prompt here."
                  style={{
                    width: '100%',
                    minHeight: 180,
                    background: tokens.colors.surface,
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.lg,
                    padding: '10px 12px',
                    color: tokens.colors.textStrong,
                    fontSize: '12px',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    lineHeight: 1.5,
                    resize: 'vertical',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Notification Channels */}
              {channels.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ ...labelStyle, marginBottom: 6 }}>Notification Channels</label>
                  <div style={{
                    background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg,
                    padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
                  }}>
                    {channels.map(ch => {
                      const isSelected = selectedChannelIds.includes(ch.id);
                      return (
                        <label key={ch.id} style={{
                          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                          padding: '4px 6px', borderRadius: tokens.radii.sm,
                          background: isSelected ? '#6366f115' : 'transparent',
                        }}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {
                              if (isSelected && selectedChannelIds.length <= 1) return;
                              const next = isSelected
                                ? selectedChannelIds.filter(id => id !== ch.id)
                                : [...selectedChannelIds, ch.id];
                              setSelectedChannelIds(next);
                              onUpdate(currentTicket.id, { channel_ids: next });
                            }}
                            style={{ accentColor: tokens.colors.accent, cursor: isSelected && selectedChannelIds.length <= 1 ? 'not-allowed' : 'pointer' }}
                          />
                          <span style={{ fontSize: '12px', color: tokens.colors.textStrong, fontWeight: 500 }}>{ch.name}</span>
                          <span style={{
                            fontSize: '10px', color: ch.is_active ? tokens.colors.successLight : tokens.colors.textMuted,
                            marginLeft: 'auto',
                          }}>{ch.type}{ch.is_active ? '' : ' (inactive)'}</span>
                        </label>
                      );
                    })}
                    {selectedChannelIds.length === 0 && (
                      <div style={{ fontSize: '11px', color: tokens.colors.danger, padding: '4px 6px', background: '#ef444415', borderRadius: tokens.radii.sm }}>
                        No channel selected — please select at least one channel to receive notifications
                      </div>
                    )}
                    {selectedChannelIds.length === 1 && (
                      <div style={{ fontSize: '11px', color: tokens.colors.warningLight, padding: '2px 6px' }}>
                        Last channel — cannot be removed
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Child Tickets (Subtasks) */}
              <ChildTicketList
                parentTicket={currentTicket}
                agents={agents}
                maxDepth={2}
                onCreateChild={onCreateChild}
                onUpdateChild={(id, data) => onUpdate(id, data)}
                onDeleteChild={onDeleteChild}
                onSelectChild={navigateToChild}
              />

              {/* Comments */}
              <div style={{ marginTop: 20 }}>
                <h4 style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textDisabled, marginBottom: 10 }}>
                  Comments ({(currentTicket.comments || []).length})
                </h4>

                {(currentTicket.comments || []).map(c => {
                  const isSystem = c.author_type === 'system';
                  const badgeConfig = isSystem
                    ? { bg: tokens.colors.badgeSystemBg, color: tokens.colors.badgeSystemText, label: 'System' }
                    : c.author_type === 'agent'
                    ? { bg: tokens.colors.badgeAgentBg, color: tokens.colors.accentLight, label: 'Agent' }
                    : { bg: tokens.colors.badgeUserBg, color: tokens.colors.infoLight, label: 'User' };
                  const images = c.images || [];

                  return (
                    <div key={c.id} style={{
                      background: isSystem ? tokens.colors.badgeSystemSurface : tokens.colors.surface,
                      border: `1px solid ${isSystem ? tokens.colors.badgeSystemBorder : tokens.colors.border}`,
                      borderRadius: tokens.radii.lg,
                      padding: isSystem ? '8px 12px' : 12,
                      marginBottom: 8,
                      ...(isSystem ? { borderLeft: `3px solid ${tokens.colors.badgeSystemText}` } : {}),
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isSystem ? 2 : 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
                            background: badgeConfig.bg, color: badgeConfig.color,
                            textTransform: 'uppercase',
                          }}>{badgeConfig.label}</span>
                          {!isSystem && (
                            <span style={{ fontSize: '12px', fontWeight: 600, color: badgeConfig.color }}>{c.author}</span>
                          )}
                        </div>
                        <span style={{ fontSize: '11px', color: tokens.colors.textMuted }}>{new Date(c.created_at).toLocaleString()}</span>
                      </div>
                      <p style={{
                        fontSize: isSystem ? '12px' : '13px',
                        color: isSystem ? tokens.colors.badgeSystemText : tokens.colors.textDisabled,
                        lineHeight: 1.5, whiteSpace: 'pre-wrap',
                        margin: 0,
                      }}>{c.content}</p>
                      {images.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          {images.map((img, idx) => (
                            <img key={idx}
                              src={`data:${img.mimetype};base64,${img.data}`}
                              alt={img.filename}
                              onClick={() => setImagePreview(`data:${img.mimetype};base64,${img.data}`)}
                              style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: tokens.radii.md, cursor: 'pointer', border: `1px solid ${tokens.colors.border}` }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Comment input */}
                <div style={{ marginTop: 8 }}>
                  {commentImages.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
                      {commentImages.map((img, idx) => (
                        <div key={idx} style={{ position: 'relative' }}>
                          <img src={`data:${img.mimetype};base64,${img.data}`} alt={img.filename}
                            style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: tokens.radii.sm, border: `1px solid ${tokens.colors.border}` }} />
                          <button onClick={() => setCommentImages(prev => prev.filter((_, i) => i !== idx))}
                            style={{ position: 'absolute', top: -4, right: -4, background: tokens.colors.danger, color: 'white', border: 'none', borderRadius: tokens.radii.full, width: 16, height: 16, fontSize: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>x</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={handleImageAttach} title="Attach image" style={{
                      background: tokens.colors.border, color: tokens.colors.textSecondary, border: 'none', borderRadius: tokens.radii.md,
                      padding: '6px 10px', fontSize: '14px', cursor: 'pointer',
                    }}>📎</button>
                    <input
                      value={commentContent}
                      onChange={e => setCommentContent(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmitComment(); } }}
                      placeholder={user ? `${user.name}(으)로 댓글 작성...` : 'Write a comment...'}
                      style={{
                        flex: 1, background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                        padding: '6px 10px', color: tokens.colors.textStrong, fontSize: '12px', outline: 'none',
                      }}
                    />
                    <button onClick={handleSubmitComment} disabled={!commentContent.trim()} style={{
                      background: commentContent.trim() ? tokens.colors.accent : tokens.colors.border, color: 'white', border: 'none', borderRadius: tokens.radii.md,
                      padding: '6px 14px', fontSize: '12px', fontWeight: 600, cursor: commentContent.trim() ? 'pointer' : 'not-allowed',
                    }}>Send</button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* Activity Tab */
            <div>
              <h4 style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textDisabled, marginBottom: 12 }}>
                Activity Log
              </h4>
              {activities.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 20, color: tokens.colors.textMuted, fontSize: '13px' }}>
                  No activity recorded yet.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {activities.map(log => (
                    <div key={log.id} style={{
                      background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                      padding: '8px 12px', fontSize: '12px',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ color: tokens.colors.textStrong, fontWeight: 600 }}>
                          {log.action.replace('_', ' ').toUpperCase()} - {log.entity_type}
                        </span>
                        <span style={{ color: tokens.colors.textMuted, fontSize: '11px' }}>
                          {new Date(log.created_at).toLocaleString()}
                        </span>
                      </div>
                      {log.field_changed && (
                        <div style={{ color: tokens.colors.textSecondary }}>
                          Field: {log.field_changed}
                          {log.old_value && ` | From: ${log.old_value}`}
                          {log.new_value && ` | To: ${log.new_value}`}
                        </div>
                      )}
                      {log.actor_name && (
                        <div style={{ color: tokens.colors.textMuted, marginTop: 2 }}>By: {log.actor_name}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Image preview modal */}
      {imagePreview && (
        <div onClick={() => setImagePreview(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, cursor: 'pointer',
        }}>
          <img src={imagePreview} alt="Preview" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} />
        </div>
      )}
    </>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
