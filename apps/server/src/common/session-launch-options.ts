import type { AgentSessionConfigOption } from './types/agent-sessions';

/** Host-authenticated metadata only; no executable arguments cross this boundary. */
export function sanitizeSessionLaunchOptions(input: unknown): Record<string, AgentSessionConfigOption[]> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return Object.fromEntries(Object.entries(input).slice(0, 32).map(([cli, raw]) => [cli,
    (Array.isArray(raw) ? raw : []).slice(0, 16).filter((o) => o && typeof o.config_id === 'string'
      && ['__permission_mode', '__git_workflow'].includes(o.config_id) && typeof o.name === 'string'
      && Array.isArray(o.options)).map((o) => ({
      config_id: o.config_id, name: o.name.slice(0, 160), description: String(o.description ?? '').slice(0, 1000),
      category: 'launch', type: 'select', current_value: typeof o.current_value === 'string' ? o.current_value.slice(0, 256) : '',
      options: o.options.slice(0, 32).filter((v: any) => v && typeof v.value === 'string' && typeof v.name === 'string')
        .map((v: any) => ({ value: v.value.slice(0, 256), name: v.name.slice(0, 160), description: String(v.description ?? '').slice(0, 1000) })),
    })),
  ]));
}

export function mergeSessionConfig(current: Record<string, string | boolean>, input: unknown, options: AgentSessionConfigOption[]): Record<string, string | boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Session config must be an object.');
  const next = { ...current };
  for (const [key, value] of Object.entries(input)) {
    if (!key || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid session config key.');
    if (value === null) { delete next[key]; continue; }
    if (typeof value !== 'boolean' && !(typeof value === 'string' && value.length <= 256)) throw new Error(`Invalid session config value: ${key}`);
    if (['__permission_mode', '__git_workflow'].includes(key)
      && !options.find((o) => o.config_id === key)?.options.some((o) => o.value === value)) {
      throw new Error(`The Runtime Host does not support ${key}=${String(value)}. Refresh or update the manager.`);
    }
    next[key] = value;
  }
  return next;
}
