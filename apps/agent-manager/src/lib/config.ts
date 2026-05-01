import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import {
  AGENT_PATH,
  CONFIG_PATH,
  DELEGATION_DEFAULTS,
  KNOWN_CLI_TYPES,
  REQUEST_TIMEOUT_MS,
  type CliType,
} from './constants.js';
import { log } from './logging.js';
import type { AwbConfig } from './rest.js';

export interface AgentInfo {
  agent_id: string | null;
  agent_name?: string;
  workspace_id?: string;
  _note?: string;
  [key: string]: unknown;
}

export function loadConfig(path: string = CONFIG_PATH): AwbConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.delegation = { ...DELEGATION_DEFAULTS, ...(raw.delegation || {}) };
    const cli = String(raw.cli || 'claude').toLowerCase().trim();
    raw.cli = cli || 'claude';
    if (!(KNOWN_CLI_TYPES as readonly string[]).includes(raw.cli)) {
      log(
        `config.cli="${raw.cli}" is not a known CLI; valid: ${KNOWN_CLI_TYPES.join(', ')}. Adapter will fall back at creation.`,
      );
    }
    return raw as AwbConfig;
  } catch (err: any) {
    log(`config load failed (${path}): ${err?.message ?? err}`);
    return null;
  }
}

export function loadAgentInfo(path: string = AGENT_PATH): AgentInfo | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as AgentInfo) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve agent_id via MCP whoami when agent.json exists but agent_id is null.
 * Writes the resolved UUID back to agent.json so subsequent runs skip this step.
 */
export async function resolveAgentId(
  config: AwbConfig,
  agentPath: string = AGENT_PATH,
): Promise<string | null> {
  const info = loadAgentInfo(agentPath);
  if (!info) return null;
  if (typeof info.agent_id === 'string' && info.agent_id) return info.agent_id;

  log('agent_id is null — resolving via MCP whoami...');
  const base = config.url.replace(/\/$/, '');
  const url = `${base}/mcp`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  try {
    const initResp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: { experimental: { 'awb/schemaVersion': { version: 2 } } },
          clientInfo: { name: 'awb-agent-resolve', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!initResp.ok) throw new Error(`initialize HTTP ${initResp.status}`);
    const sid = initResp.headers.get('mcp-session-id');
    if (!sid) throw new Error('initialize did not return Mcp-Session-Id');
    await initResp.text().catch(() => null);

    const sessionHeaders: Record<string, string> = { ...headers, 'Mcp-Session-Id': sid };

    await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).then((r) => r.text().catch(() => null));

    const whoamiResp = await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!whoamiResp.ok) throw new Error(`whoami HTTP ${whoamiResp.status}`);
    const whoamiBody: any = await whoamiResp.json();

    fetch(url, {
      method: 'DELETE',
      headers: sessionHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
      .then((r) => r.text().catch(() => null))
      .catch(() => {
        /* server TTL */
      });

    const content = whoamiBody?.result?.content;
    if (!Array.isArray(content) || !content[0]?.text) {
      throw new Error('unexpected whoami response shape');
    }
    const parsed = JSON.parse(content[0].text);
    const agentId = parsed?.agent_id;
    if (!agentId || typeof agentId !== 'string') {
      throw new Error(`whoami returned no agent_id: ${content[0].text}`);
    }

    info.agent_id = agentId;
    info._note = `agent_id resolved automatically by agent-manager at ${new Date().toISOString()}`;
    await fsp.writeFile(agentPath, JSON.stringify(info, null, 2) + '\n', 'utf8');
    log(`agent_id resolved: ${agentId.slice(0, 8)}...`);
    return agentId;
  } catch (err: any) {
    log(`agent_id resolve failed: ${err?.message ?? err}`);
    return null;
  }
}

export function getCliType(config: AwbConfig | null | undefined): CliType {
  const raw = String(config?.cli ?? 'claude').toLowerCase().trim();
  if ((KNOWN_CLI_TYPES as readonly string[]).includes(raw)) return raw as CliType;
  return 'claude';
}
