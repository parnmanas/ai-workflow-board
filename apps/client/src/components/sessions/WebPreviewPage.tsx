import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { api } from '../../api';
import { getServerUrl } from '../../serverConfig';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import { tokens } from '../../tokens';
import { Button, Input } from '../common';
import PageHeader from '../PageHeader';
import SessionWebAppFrame, { type OpenSessionWebApp } from './SessionWebAppFrame';

export default function WebPreviewPage() {
  const { managerId = '', cli = '', sessionId = '' } = useParams();
  const { hash, pathname } = useLocation();
  let initial = '';
  try { initial = decodeURIComponent(hash.slice(1)); } catch { /* A pasted address can be replaced in the form. */ }
  return <PreviewForm key={pathname + hash} managerId={managerId} cli={cli} sessionId={sessionId} initial={initial} />;
}

function PreviewForm({ managerId, cli, sessionId, initial }: { managerId: string; cli: string; sessionId: string; initial: string }) {
  useLocale();
  const [options, setOptions] = useState<Awaited<ReturnType<typeof api.getWebPreview>> | null>(null);
  const [url, setUrl] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [app, setApp] = useState<OpenSessionWebApp | null>(null);
  const currentApp = useRef<OpenSessionWebApp | null>(null);
  const mounted = useRef(false);
  const handoff = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let current = true;
    mounted.current = true;
    const refresh = () => api.getWebPreview(managerId, cli, sessionId).then(data => {
      if (!current) return;
      setOptions(data);
      const port = data.ports?.[0];
      if (port) setUrl(value => value || `http://localhost:${port}/`);
    }).catch(err => { if (current) setError(err.message); });
    void refresh();
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) void refresh(); };
    const release = () => {
      const closing = currentApp.current;
      if (closing) void api.closeSessionWebApp(managerId, cli, sessionId, closing.id, closing.grant).catch(() => {});
    };
    const onHide = (event: PageTransitionEvent) => { if (!event.persisted) release(); };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      current = false;
      mounted.current = false;
      window.removeEventListener('pageshow', onShow);
      window.removeEventListener('pagehide', onHide);
      release();
    };
  }, [managerId, cli, sessionId]);

  async function open(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { action, ticket } = await api.openWebPreview(managerId, cli, sessionId, url.trim());
      const form = handoff.current;
      if (!form) return;
      form.action = action;
      (form.elements.namedItem('ticket') as HTMLInputElement).value = ticket;
      form.submit();
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function openApp(id: string) {
    // A device configured to use another AWB server needs that site's first-party app cookie.
    const site = new URL(getServerUrl(window.location.pathname), window.location.href);
    if (site.origin !== window.location.origin) {
      window.location.assign(site.href);
      return;
    }
    setError('');
    setClosed(false);
    setBusy(true);
    try {
      const opened = { ...await api.openSessionWebApp(managerId, cli, sessionId, id), id };
      if (!mounted.current) {
        await api.closeSessionWebApp(managerId, cli, sessionId, id, opened.grant);
        return;
      }
      currentApp.current = opened;
      setApp(opened);
    } catch (err: any) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function closeApp() {
    if (!app) return;
    setBusy(true);
    try {
      await api.closeSessionWebApp(managerId, cli, sessionId, app.id, app.grant);
      currentApp.current = null;
      setApp(null);
      setError('');
      setOptions(await api.getWebPreview(managerId, cli, sessionId));
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function close() {
    setBusy(true);
    setError('');
    try {
      await api.closeWebPreviews(managerId, cli, sessionId);
      setOptions(value => value && { ...value, active: 0 });
      setClosed(true);
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  }

  const available = !!(options?.configured && options.ports?.length);
  let hint = '';
  if (options && !options.configured) hint = translate('Configure a separate HTTPS site with AWB_PREVIEW_DOMAIN on the AWB server.');
  else if (options?.ports === null) hint = translate('Update the Agent Manager on this Runtime Host to use web previews.');
  else if (options && !options.ports?.length) hint = translate('Add the web server port to web_preview_ports in the Agent Manager config and restart the manager.');
  else if (options?.ports) hint = translate('Allowed ports on this host: {0}', { 0: options.ports.join(', ') });

  if (app) return <section>
    <PageHeader title={app.name} actions={<Button variant="secondary" disabled={busy} onClick={closeApp}>{translate('Close')}</Button>} />
    {error && <div role="alert">{error}</div>}
    <SessionWebAppFrame app={app} managerId={managerId} cli={cli} sessionId={sessionId} onError={setError} />
  </section>;

  const showAddress = !options?.apps?.length || available;
  return <section>
    <PageHeader title={translate('Local web preview')} />
    <div style={{ maxWidth: 560, padding: tokens.spacing.lg }}>
      {!!options?.apps?.length && <div style={{ display: 'grid', gap: tokens.spacing.sm, marginBottom: tokens.spacing.lg }}>
        {options.apps.map(item => <Button key={item.id} disabled={busy} onClick={() => void openApp(item.id)}>
          {translate('Open {0}', { 0: item.name })}
        </Button>)}
      </div>}
      <form onSubmit={open} style={{ display: 'grid', gap: tokens.spacing.md }}>
        {showAddress && <label>
          {translate('Web address on the Runtime Host')}
          <Input type="url" required maxLength={8192} placeholder="http://localhost:5173/" value={url}
            onChange={e => setUrl(e.target.value)} autoCapitalize="none" autoComplete="off" spellCheck={false} />
        </label>}
        {showAddress && hint && <div style={{ color: tokens.colors.textSecondary }}>{hint}</div>}
        {available && <div>{translate('Read-only access lasts 15 minutes. Signing out closes the preview.')}</div>}
        {error && <div role="alert" style={{ color: tokens.colors.danger }}>{error}</div>}
        <div style={{ display: 'flex', gap: tokens.spacing.sm, flexWrap: 'wrap' }}>
          {showAddress && <Button type="submit" disabled={!available || busy}>{translate('Open preview')}</Button>}
          {!!options?.active && <Button type="button" variant="secondary" disabled={busy} onClick={close}>{translate('Close previews for this session')}</Button>}
        </div>
        {closed && <div role="status">{translate('Previews closed.')}</div>}
      </form>
      <form hidden ref={handoff} method="post"><input type="hidden" name="ticket" /></form>
    </div>
  </section>;
}
