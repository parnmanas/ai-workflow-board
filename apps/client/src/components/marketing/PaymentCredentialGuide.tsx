/**
 * 직접 결제 공급자의 credential 발급 안내(접고 펴는 상자) — Credentials 화면과 마케팅 수취인 설정이 함께 쓴다.
 * 글은 paymentCredentialGuides.ts 한 곳에 있다.
 */
import React from 'react';
import { tokens } from '../../tokens';
import type { MarketingDirectPaymentProvider } from '../../types';
import { PAYMENT_CREDENTIAL_GUIDES } from './paymentCredentialGuides';
import { ExternalLink } from './MarketingUi';

const sectionTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: tokens.colors.textSecondary,
  margin: '10px 0 4px',
};

export function PaymentCredentialGuide({ provider, defaultOpen = false }: { provider: MarketingDirectPaymentProvider; defaultOpen?: boolean }) {
  const guide = PAYMENT_CREDENTIAL_GUIDES[provider];
  if (!guide) return null;
  return (
    <details
      data-testid={`payment-credential-guide-${provider}`}
      open={defaultOpen}
      style={{
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
        padding: '8px 10px',
        background: tokens.colors.surface,
        fontSize: 12,
        lineHeight: 1.55,
        color: tokens.colors.textStrong,
      }}
    >
      <summary style={{ cursor: 'pointer', fontWeight: 600, color: tokens.colors.accentLight }}>
        credential 발급 방법 — {guide.title}
      </summary>
      <div style={{ marginTop: 6, color: tokens.colors.textSecondary }}>{guide.summary}</div>
      <div style={sectionTitle}>순서</div>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {guide.steps.map((step, i) => <li key={i} style={{ marginBottom: 2 }}>{step}</li>)}
      </ol>
      <div style={sectionTitle}>어느 칸에 무엇을</div>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {guide.fields.map((f) => (
          <li key={f.field}><code>{f.field}</code> — {f.value}</li>
        ))}
        <li>{guide.target}</li>
      </ul>
      <div style={sectionTitle}>자주 막히는 곳</div>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {guide.pitfalls.map((p, i) => <li key={i}>{p}</li>)}
      </ul>
      <div style={sectionTitle}>공식 문서</div>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {guide.links.map((l) => (
          <li key={l.url}><ExternalLink href={l.url}>{l.label}</ExternalLink></li>
        ))}
      </ul>
    </details>
  );
}
