import { useEffect, useMemo, useState } from 'react';
import { getLocale, t } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import { tokens } from '../../tokens';
import type { AgentSessionEventRecord } from '../../types';
import { sessionLimitWindows, type SessionLimitWindow } from './sessionUsageLimits.logic';

function windowLabel(window: SessionLimitWindow): string {
  const minutes = window.windowMinutes;
  const duration = minutes === null ? t(window.id === 'secondary' ? 'Secondary limit' : 'Primary limit')
    : minutes % 1440 === 0 ? t('{0}d limit', { 0: minutes / 1440 })
    : minutes % 60 === 0 ? t('{0}h limit', { 0: minutes / 60 })
    : t('{0}m limit', { 0: minutes });
  return window.limitName ? `${window.limitName} · ${duration}` : duration;
}

export default function SessionUsageLimits({ events }: { events: AgentSessionEventRecord[] }) {
  useLocale();
  const windows = useMemo(() => sessionLimitWindows(events), [events]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const formatTime = (iso: string) => new Date(iso).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <section aria-label={t('Usage limits')} data-session-usage-limits style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 16px', padding: '7px 16px',
      borderBottom: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceSubtle, flexShrink: 0,
    }}>
      <span style={{ fontSize: 11, color: tokens.colors.textSecondary }}>{t('Usage limits')}</span>
      {windows.length === 0 ? (
        <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>{t('No usage limits reported by this CLI')}</span>
      ) : windows.map((w) => {
        const expired = w.resetsAt !== null && Date.parse(w.resetsAt) <= now;
        const label = windowLabel(w);
        const color = expired ? tokens.colors.textMuted : w.usedPercent >= 90 ? tokens.colors.dangerLight
          : w.usedPercent >= 75 ? tokens.colors.warningLight : tokens.colors.accentSubtle;
        const percent = Math.round(w.usedPercent);
        return (
          <div key={w.key} title={t('Last reported {0}', { 0: formatTime(w.observedAt) })} style={{ flex: '1 1 125px', maxWidth: 260, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, lineHeight: '16px' }}>
              <span style={{ color: tokens.colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
              <span style={{ color, whiteSpace: 'nowrap' }}>{expired ? t('Awaiting update') : t('{0}% used', { 0: percent })}</span>
            </div>
            <div role={expired ? undefined : 'meter'} aria-label={label} aria-valuemin={expired ? undefined : 0}
              aria-valuemax={expired ? undefined : 100} aria-valuenow={expired ? undefined : w.usedPercent}
              aria-valuetext={expired ? undefined : t('{0}% used', { 0: percent })}
              style={{ height: 4, margin: '3px 0', borderRadius: 4, background: tokens.colors.border, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: expired ? '0%' : `${w.usedPercent}%`, background: color, borderRadius: 4 }} />
            </div>
            {w.resetsAt && !expired && <div style={{ fontSize: 10, color: tokens.colors.textMuted }}>{t('Resets {0}', { 0: formatTime(w.resetsAt) })}</div>}
          </div>
        );
      })}
    </section>
  );
}
