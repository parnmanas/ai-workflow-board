import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { ArtifactRefType } from '../../utils/artifactRef';

const ICON: Record<ArtifactRefType, string> = {
  ticket: '🎫', agent: '🤖', action: '▶️', function: 'ƒ', schedule: '🗓️',
};

type Resolution = {
  type: ArtifactRefType;
  id: string;
  available: boolean;
  label: string;
  deepLink: string | null;
  accountName?: string;
  reason?: string;
};

const REASON: Record<string, string> = {
  get malformed_id() { return translate('잘못된 UUID'); },
  get account_access_denied() { return translate('소유 계정 접근 권한 없음'); },
  get not_found() { return translate('존재하지 않음'); },
  get outside_account() { return translate('다른 소유 계정의 엔터티'); },
  get no_detail_surface() { return translate('상세 화면 없음'); },
  get resolving() { return translate('확인 중'); },
  get resolver_failed() { return translate('확인 실패'); },
};

export default function ResolvedArtifactRef({
  type, id, claimedLabel,
}: {
  type: ArtifactRefType;
  id: string;
  claimedLabel: string;
}) {
  useLocale();
  const [resolved, setResolved] = useState<Resolution | null>(null);
  const [failure, setFailure] = useState('resolving');

  useEffect(() => {
    let active = true;
    api.resolveArtifactRefs('', [{ type, id }])
      .then(rows => {
        if (!active) return;
        setResolved(rows[0] || null);
        setFailure(rows[0]?.reason || '');
      })
      .catch(() => active && setFailure('resolver_failed'));
    return () => { active = false; };
  }, [type, id]);

  const common = {
    'data-entity-ref': `${type}:${id}`,
    'data-artifact-state': resolved?.available ? 'available' : failure,
    title: [
      resolved?.label || claimedLabel,
      resolved?.accountName,
      id,
    ].filter(Boolean).join(' · '),
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px',
      borderRadius: tokens.radii.sm, color: resolved?.available ? tokens.colors.accentSubtle : tokens.colors.textMuted,
      background: resolved?.available ? tokens.overlays.accentSoft : tokens.colors.surfaceCard,
      fontWeight: 600, textDecoration: 'none',
    } as React.CSSProperties,
  };

  if (resolved?.available && resolved.deepLink) {
    const context = resolved.accountName || '';
    return (
      <a {...common} href={resolved.deepLink} aria-label={translate('{0} 열기: {1}', { 0: type, 1: resolved.label })}>
        {ICON[type]} {resolved.label}{context ? ` · ${context}` : ''}
      </a>
    );
  }
  const reason = REASON[resolved?.reason || failure] || resolved?.reason || failure;
  const context = resolved?.accountName || '';
  return (
    <span {...common} aria-disabled="true">
      {ICON[type]} {type} · {resolved?.label || claimedLabel || type}
      {context ? ` · ${context}` : ''} ({id}{translate(') — 연결 불가:')} {reason}
    </span>
  );
}
