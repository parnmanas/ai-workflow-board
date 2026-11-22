import React, { useEffect, useRef } from 'react';
import { api } from '../../api';
import { getServerUrl } from '../../serverConfig';

export type OpenSessionWebApp = Awaited<ReturnType<typeof api.openSessionWebApp>> & { id: string };

interface Props {
  app: OpenSessionWebApp;
  managerId: string;
  cli: string;
  sessionId: string;
  onError: (message: string) => void;
}

export default function SessionWebAppFrame({ app, managerId, cli, sessionId, onError }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef<MessageChannel | null>(null);
  const stop = useRef(new AbortController());
  useEffect(() => {
    stop.current = new AbortController();
    return () => { channel.current?.port1.close(); stop.current.abort(); channel.current = null; };
  }, [app]);

  function connect() {
    const child = frame.current?.contentWindow;
    if (!child || channel.current) return;
    const bridge = new MessageChannel();
    channel.current = bridge;
    const signal = stop.current.signal;
    let pending = 0;
    bridge.port1.onmessage = async ({ data }) => {
      if (!data || !Number.isSafeInteger(data.id) || typeof data.path !== 'string' || data.path.length > 256
          || typeof data.body !== 'string' || data.body.length > 32768 || signal.aborted) return;
      if (pending >= 4) {
        bridge.port1.postMessage({ id: data.id, error: 'Application busy' });
        return;
      }
      pending++;
      try {
        const result = await api.sessionWebAppRequest(managerId, cli, sessionId, app.id, {
          grant: app.grant, path: data.path, body: data.body,
        }, signal);
        if (!signal.aborted) bridge.port1.postMessage({ id: data.id, ...result });
      } catch (err: any) {
        if (!signal.aborted) {
          onError(err.message);
          bridge.port1.postMessage({ id: data.id, error: 'Application request failed' });
        }
      } finally { pending--; }
    };
    // A sandbox without allow-same-origin has an opaque origin. The channel is
    // transferred once, to this exact frame. Authentication stays in the parent.
    child.postMessage({ type: 'awb-web-app', html: app.html }, '*', [bridge.port2]);
  }

  return <iframe ref={frame} title={app.name} src={getServerUrl('/api/agent-sessions/web-app-frame')} onLoad={connect}
    sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ width: '100%', height: 'calc(100dvh - 9rem)', minHeight: 320, border: 0, display: 'block' }} />;
}
