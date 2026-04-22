import React, { useEffect, useState } from 'react';
import { tokens } from '../tokens';
import { Button, Input, Modal, Select } from './common';

interface CreateTicketFormProps {
  isOpen: boolean;
  onSubmit: (title: string, description: string, priority: string) => void;
  onCancel: () => void;
}

// Atomic ticket creation — title + description + priority captured together
// and POSTed once. Before this modal, a stub row with title-only was written
// to the board immediately, and the description followed as a separate PATCH;
// agents polling the backlog would scoop up the empty stub and start working
// on it before the human finished typing. Requiring description here gives
// "done composing" an unambiguous signal (the Create button click).
export default function CreateTicketForm({ isOpen, onSubmit, onCancel }: CreateTicketFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [errors, setErrors] = useState<{ title?: string; description?: string }>({});

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setDescription('');
      setPriority('medium');
      setErrors({});
    }
  }, [isOpen]);

  const handleSubmit = () => {
    const nextErrors: { title?: string; description?: string } = {};
    if (!title.trim()) nextErrors.title = 'Title is required.';
    if (!description.trim()) nextErrors.description = 'Description is required — agents start work as soon as the ticket lands, so the brief needs to be complete.';
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onSubmit(title.trim(), description.trim(), priority);
  };

  // Ctrl/Cmd+Enter from anywhere in the form submits — mirrors the shortcut
  // most "new issue" modals (Linear, GitHub) use so returning users don't
  // have to mouse over to the button.
  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="New Ticket"
      maxWidth={560}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit}>Create Ticket</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
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
          <label style={{
            fontSize: tokens.typography.fontSizeXs,
            fontWeight: tokens.typography.fontWeightSemibold,
            color: tokens.colors.textMuted,
            textTransform: 'uppercase',
            display: 'block',
            marginBottom: tokens.spacing.xs,
          }}>Description</label>
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
            <span style={{
              fontSize: tokens.typography.fontSizeXs,
              color: tokens.colors.danger,
              marginTop: tokens.spacing.xs,
            }}>{errors.description}</span>
          )}
        </div>
        <div>
          <label style={{
            fontSize: tokens.typography.fontSizeXs,
            fontWeight: tokens.typography.fontWeightSemibold,
            color: tokens.colors.textMuted,
            textTransform: 'uppercase',
            display: 'block',
            marginBottom: tokens.spacing.xs,
          }}>Priority</label>
          <Select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'critical', label: 'Critical' },
            ]}
          />
        </div>
        <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
          Ctrl/Cmd + Enter to submit
        </div>
      </form>
    </Modal>
  );
}
