import React, { useId, useState } from 'react';
import { LANGUAGES, setLocale, t, type Locale } from '../i18n/core';
import { useLocale } from '../i18n/react';
import { tokens } from '../tokens';

export default function LanguageSelect() {
  const locale = useLocale();
  const id = useId();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div style={{ minWidth: 0 }}>
      <label htmlFor={id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
        <span>{t('Language')}</span>
        <select
          id={id}
          data-testid="language-select"
          value={locale}
          disabled={loading}
          onChange={async event => {
            setLoading(true);
            setError(false);
            try { await setLocale(event.target.value as Locale); }
            catch { setError(true); }
            finally { setLoading(false); }
          }}
          style={{ flex: '1 1 120px', minWidth: 0, maxWidth: '100%', minHeight: 44, padding: '6px 10px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, font: 'inherit' }}
        >
          {LANGUAGES.map(language => <option key={language.code} value={language.code} lang={language.code}>{language.name}</option>)}
        </select>
      </label>
      {error && <p role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{t('Could not load this language. Please try again.')}</p>}
    </div>
  );
}
