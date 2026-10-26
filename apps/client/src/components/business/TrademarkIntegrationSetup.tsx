import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type { BusinessCompany, TrademarkConnectorDefinition, TrademarkIntegration } from '../../business.types';
import { useAuth } from '../../contexts/AuthContext';
import { Button, Input, Modal, Select } from '../common';

export function TrademarkIntegrationSetup({ company, trademarkId, connector, connection, onClose, onSaved }: {
  company: BusinessCompany; trademarkId: string; connector: TrademarkConnectorDefinition; connection?: TrademarkIntegration; onClose(): void; onSaved(): Promise<void>;
}) {
  useLocale();
  const { hasPermission } = useAuth();
  const [config, setConfig] = useState<Record<string, string>>(connection?.config || Object.fromEntries(connector.fields.map(field => [field.key, field.options?.[0] || (field.key === 'tenant' ? 'common' : '')])));
  const [credentialId, setCredentialId] = useState(connection?.credential_id || '');
  const [credentials, setCredentials] = useState<Array<{ id: string; name: string }>>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [autoSync, setAutoSync] = useState(connection?.auto_sync ?? true);
  const [interval, setIntervalMinutes] = useState(String(connection?.interval_minutes || 15));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.listBusinessCredentials(company.account_id).then(rows => { if (active) setCredentials(rows.filter(row => row.provider === connector.credential_provider)); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [company.account_id, connector.credential_provider]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      let selected = credentialId;
      if (selected === '__new__') {
        const row = await api.createCredential({ account_id: company.account_id, scope: 'account', name: `${company.name} · ${connector.name}`, provider: connector.credential_provider, credentials: secrets, agent_env: false });
        selected = row.id; setCredentialId(selected); setCredentials(values => [...values, row]); setSecrets({});
      }
      await api.configureTrademarkIntegration(company.id, trademarkId, { provider: connector.id, credential_id: selected, config, auto_sync: autoSync, interval_minutes: Number(interval), revision: connection?.revision });
      await onSaved(); onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal isOpen title={translate('{0} 연결 설정', { 0: connector.name })} maxWidth={740} onClose={() => { if (!busy) onClose(); }} footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>{translate('닫기')}</Button><Button loading={busy} disabled={!credentialId} onClick={() => void save()}>{translate('연결 설정 저장')}</Button></>}>
    <div className="business-form"><p className="business-guide-note">{connector.setup}</p>
      <Select label={translate('서버 전용 연결 키')} aria-label={translate('연동 credential')} value={credentialId} options={[{ value: '', label: translate('키 선택') }, ...credentials.map(c => ({ value: c.id, label: c.name })), ...(hasPermission('admin.credentials') ? [{ value: '__new__', label: translate('+ 새 키 등록') }] : [])]} onChange={e => setCredentialId(e.target.value)} />
      {credentialId === '__new__' && connector.secret_fields.map(key => <Input key={key} label={`${key}${['hmac_secret', 'webhook_secret'].includes(key) ? translate(' · 웹훅 사용 시 입력') : ''}`} aria-label={translate('연동 {0}', { 0: key })} type="password" autoComplete="new-password" value={secrets[key] || ''} onChange={e => setSecrets(previous => ({ ...previous, [key]: e.target.value }))} />)}
      <div className="business-form-grid">{connector.fields.map(field => field.options ? <Select key={field.key} label={field.label} aria-label={field.label} value={config[field.key] || ''} options={field.options.map(value => ({ value, label: value }))} onChange={e => setConfig(previous => ({ ...previous, [field.key]: e.target.value }))} /> :
        <Input key={field.key} label={field.label} aria-label={field.label} value={config[field.key] || ''} placeholder={field.placeholder} onChange={e => setConfig(previous => ({ ...previous, [field.key]: e.target.value }))} />)}</div>
      <label className="business-trademark-consent"><input type="checkbox" checked={autoSync} onChange={e => setAutoSync(e.target.checked)} /><span>{translate('회신·문서·상태를 서버에서 자동 수집')}</span></label>
      <Select label={translate('자동 수집 간격')} aria-label={translate('자동 수집 간격')} value={interval} options={[{ value: '5', label: translate('5분') }, { value: '15', label: translate('15분') }, { value: '60', label: translate('1시간') }]} onChange={e => setIntervalMinutes(e.target.value)} />
      {connector.auth === 'oauth' && <div className="business-integration-address"><strong>{translate('OAuth callback URL')}</strong><code>{connection?.callback_url || `${window.location.origin}/api/business-integrations/oauth/callback`}</code><p>{translate('공급자 앱에 이 주소를 등록한 뒤 저장하고 서비스 로그인을 연결하세요. 서버의 AWB_PUBLIC_URL도 이 사이트 주소로 설정해야 합니다.')}</p></div>}
      <div className="business-guide-actions"><a href={connector.docs_url} target="_blank" rel="noreferrer">{translate('공식 연결 안내 ↗')}</a>{hasPermission('admin.credentials') && <Link to="/settings/credentials" target="_blank">{translate('키 관리 ↗')}</Link>}</div>
      {error && <div role="alert" className="business-error">{error}</div>}
    </div>
  </Modal>;
}
