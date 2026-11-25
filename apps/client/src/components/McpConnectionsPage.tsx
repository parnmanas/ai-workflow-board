import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { t } from '../i18n/core';
import { useLocale } from '../i18n/react';
import CodeBlock from './common/CodeBlock';
import PageHeader from './PageHeader';
import './McpConnectionsPage.css';

type ConnectionInfo = Awaited<ReturnType<typeof api.getMcpConnections>>;

function AccountConnections({ accountId }: { accountId: string }) {
  const locale = useLocale();
  const { hasPermission } = useAuth();
  const confirm = useConfirm();
  const [info, setInfo] = useState<ConnectionInfo>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    api.getMcpConnections(accountId).then(data => {
      if (active) setInfo(data);
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [accountId, attempt]);

  async function disconnect(connection: ConnectionInfo['connections'][number]) {
    if (!await confirm({ title: t('Disconnect {0}?', { 0: connection.client_name }),
      message: t('This app will need your permission to access AWB again.'), confirmLabel: t('Disconnect') })) return;
    setPending(connection.id);
    setError('');
    try {
      await api.disconnectMcp(connection.id, accountId);
      setInfo(prev => prev && { ...prev, connections: prev.connections.filter(c => c.id !== connection.id) });
    } catch (e) {
      setError((e as Error).message);
    } finally { setPending(''); }
  }

  return <div className="mcp-guide-scroll"><div className="mcp-guide">
    <section>
      <h2>{t('MCP server URL')}</h2>
      {info?.endpoint ? <CodeBlock language="Streamable HTTP" code={info.endpoint} />
        : info ? <p>{t('Ask your AWB administrator to configure a public HTTPS address for this instance.')}</p>
        : !error && <p role="status">{t('Loading…')}</p>}
      <p>{t('Sign in with Google and choose the AWB account the app can use. Account actions follow your AWB permissions, including access to Host sessions.')}</p>
    </section>
    <div className="mcp-guide-apps">
      <section>
        <h2>ChatGPT</h2>
        <ol>
          <li>{t('On ChatGPT web, open Plugins → + → Add custom MCP server.')}</li>
          <li>{t('Name it AWB, paste the server URL and choose OAuth with Dynamic Client Registration (DCR).')}</li>
          <li>{t('Create and install the plugin. Connect with Google and select Allow account actions in AWB.')}</li>
        </ol>
        <a href="https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt" target="_blank" rel="noreferrer">{t('ChatGPT setup and availability')} ↗</a>
      </section>
      <section>
        <h2>Claude</h2>
        <ol>
          <li>{t('Open Settings → Connectors → + Add → Add custom connector.')}</li>
          <li>{t('Name it AWB, paste the server URL and continue. Select Sign in now and Register automatically.')}</li>
          <li>{t('Add the connector, select Connect, and sign in with Google. Select Allow account actions in AWB.')}</li>
        </ol>
        <a href="https://claude.com/docs/connectors/custom/add-unlisted" target="_blank" rel="noreferrer">{t('Claude connector guide')} ↗</a>
      </section>
    </div>
    <section>
      <h2>{t('Try the connection')}</h2>
      <p>{t('Select AWB and ask “List my running sessions, ask the selected session for progress and read its reply.” Reconnect a read-only app to approve account actions.')}</p>
    </section>
    <section>
      <h2>{t('Connected apps')}</h2>
      {error && <p role="alert">{error} <button type="button" onClick={() => { setError(''); setAttempt(a => a + 1); }}>{t('Retry')}</button></p>}
      {info?.connections.length === 0 && <p>{t('No apps are connected to this account.')}</p>}
      {!!info?.connections.length && <ul>{info.connections.map(c =>
        <li key={c.id}><span><strong>{c.client_name}</strong> · {c.scope?.split(' ').includes('awb.manage') ? t('Account actions') : t('Read-only connection')}
          {c.scope?.split(' ').includes('awb.keys') && <> · {t('API Keys')}</>} · {t('Expires {0}', { 0: new Date(c.expires_at).toLocaleString(locale) })}</span>
          <button type="button" disabled={!!pending} onClick={() => void disconnect(c)}>{t('Disconnect')}</button></li>)}</ul>}
    </section>
    <section>
      <h2>{t('Other MCP clients')}</h2>
      <p>{t('For another OAuth app, ask your AWB administrator to register its HTTPS callback URL, then choose automatic registration in the app.')}</p>
      <p>{t('For clients that accept custom headers, use Streamable HTTP with a read-only AWB API key in the Authorization header.')}</p>
      <code>Authorization: Bearer &lt;AWB_API_KEY&gt;</code>
      {hasPermission('admin.api_keys') && <p><Link to="/settings/api-keys">{t('API Keys')}</Link></p>}
    </section>
  </div></div>;
}

export default function McpConnectionsPage() {
  useLocale();
  const { currentAccountId } = useAuth();
  return <div className="mcp-guide-page">
    <PageHeader title={t('MCP connections')} description={t('Connect ChatGPT or Claude to AWB with Google.')} />
    <AccountConnections key={currentAccountId} accountId={currentAccountId || ''} />
  </div>;
}
