import { useEffect, useState } from 'react';
import { api } from '../api';
import { t as translate } from '../i18n/core';

export interface RuntimeHostChoice {
  id: string;
  name: string;
  /** Undefined for offline/older hosts; an empty report means no runnable CLI. */
  clis?: string[];
  chat_workdir_root?: string | null;
}

/** One host catalog for all execution editors; never discard its capabilities. */
export function useRuntimeHosts(enabled = true, accountId?: string) {
  const [hosts, setHosts] = useState<RuntimeHostChoice[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setHosts([]); setLoading(true); setError('');
    api.listTemplateHosts().then((rows) => {
      if (!cancelled) setHosts(rows.map((host) => ({ ...host, name: host.name || translate('(이름 없는 호스트)') })));
    }).catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, accountId]);
  return { hosts, loading, error };
}
