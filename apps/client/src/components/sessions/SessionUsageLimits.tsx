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

export default function SessionUsageLimits({ events, variant = 'boundary' }: {
  events: AgentSessionEventRecord[]; variant?: 'boundary' | 'details';
}) {
  useLocale();
  const windows = useMemo(() => sessionLimitWindows(events), [events]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const boundary = variant === 'boundary';
  if (boundary && windows.length === 0) return null;
  // The divider keeps a fixed thickness even with multiple model quotas; the menu always lists them all.
  const visible = boundary && windows.length > 2 ? [...windows].sort((a, b) => b.usedPercent - a.usedPercent).slice(0, 2) : windows;
  const formatTime = (iso: string) => new Date(iso).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <span role="group" aria-label={t('Usage limits')} data-session-usage-limits={variant} style={boundary
      ? { position: 'absolute', left: 0, right: 0, bottom: -1, display: 'flex', flexDirection: 'column', gap: 1, height: visible.length === 1 ? 3 : 5 }
      : { display: 'flex', flexDirection: 'column', gap: 12 }}>
      {windows.length === 0 && <span style={{ fontSize: 12, color: tokens.colors.textSecondary }}>{t('No usage limits reported by this CLI')}</span>}
      {visible.map((w) => {
        const expired = w.resetsAt !== null && Date.parse(w.resetsAt) <= now;
        const label = windowLabel(w);
        const color = expired ? tokens.colors.textMuted : w.usedPercent >= 90 ? tokens.colors.dangerLight
          : w.usedPercent >= 75 ? tokens.colors.warningLight : tokens.colors.accentSubtle;
        const usage = expired ? t('Awaiting update') : t('{0}% used', { 0: Math.round(w.usedPercent) });
        const meter = (
          <span role={expired ? undefined : 'meter'} aria-label={label} aria-valuemin={expired ? undefined : 0}
            aria-valuemax={expired ? undefined : 100} aria-valuenow={expired ? undefined : w.usedPercent}
            aria-valuetext={expired ? undefined : usage} title={`${label} · ${usage}`}
            style={{ display: 'block', height: boundary ? (visible.length === 1 ? 3 : 2) : 4, borderRadius: boundary ? 0 : 4, background: tokens.colors.border, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: expired ? '0%' : `${w.usedPercent}%`, background: boundary ? `linear-gradient(90deg, ${color}99, ${color})` : color, borderRadius: boundary ? 0 : 4 }} />
          </span>
        );
        if (boundary) return <span key={w.key}>{meter}</span>;
        return (
          <span key={w.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
              <span style={{ color: tokens.colors.textPrimary }}>{label}</span>
              <span style={{ color, whiteSpace: 'nowrap' }}>{usage}</span>
            </span>
            {meter}
            {w.resetsAt && !expired && <span style={{ fontSize: 11, color: tokens.colors.textSecondary }}>{t('Resets {0}', { 0: formatTime(w.resetsAt) })}</span>}
            <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>{t('Last reported {0}', { 0: formatTime(w.observedAt) })}</span>
          </span>
        );
      })}
    </span>
  );
}
