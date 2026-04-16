import React, { useState } from 'react';
import { tokens } from '../tokens';
import { Button, Input, Select } from './common';

interface CreateTicketFormProps {
  onSubmit: (title: string, priority: string) => void;
  onCancel: () => void;
}

export default function CreateTicketForm({ onSubmit, onCancel }: CreateTicketFormProps) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('medium');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onSubmit(title.trim(), priority);
      setTitle('');
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{
      background: tokens.colors.surfaceCard,
      borderRadius: tokens.radii.lg,
      padding: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <Input
        autoFocus
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Enter ticket title..."
        onKeyDown={e => e.key === 'Escape' && onCancel()}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <Select
            value={priority}
            onChange={e => setPriority(e.target.value)}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'critical', label: 'Critical' },
            ]}
          />
        </div>
        <Button variant="primary" size="sm" type="submit">Add</Button>
        <Button variant="secondary" size="sm" type="button" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
