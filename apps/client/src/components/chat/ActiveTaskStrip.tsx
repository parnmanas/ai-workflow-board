import { useState } from 'react';
import type { AgentCurrentTask } from '../../types';
import { tokens } from '../../tokens';

export default function ActiveTaskStrip({ tasks, onSelectTicket }: { tasks: AgentCurrentTask[]; onSelectTicket: (ticketId: string, title: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  if (tasks.length === 0) return null;
  return (
    <section aria-label="진행 중 Task" style={{ borderBottom: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceCard, flexShrink: 0 }}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} style={{ width: '100%', padding: '7px 16px', display: 'flex', gap: 8, alignItems: 'center', border: 0, background: 'transparent', color: tokens.colors.textSecondary, cursor: 'pointer', textAlign: 'left' }}>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <strong style={{ color: tokens.colors.textPrimary }}>진행 중 Task</strong>
        <span>{tasks.length}</span>
      </button>
      {expanded && <div style={{ display: 'flex', gap: 6, padding: '0 16px 8px', overflowX: 'auto' }}>
        {tasks.map((task) => {
          const kind = task.kind ?? 'ticket';
          const clickable = kind === 'ticket' && Boolean(task.ticket_id);
          return <button key={`${kind}:${task.ticket_id}`} type="button" disabled={!clickable} onClick={() => clickable && onSelectTicket(task.ticket_id, task.ticket_title)} title={task.ticket_title} style={{ maxWidth: 320, padding: '5px 9px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: clickable ? tokens.colors.accentLight : tokens.colors.textSecondary, cursor: clickable ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ fontSize: 10, textTransform: 'uppercase', marginRight: 6 }}>{kind}</span>{task.ticket_title}
          </button>;
        })}
      </div>}
    </section>
  );
}
