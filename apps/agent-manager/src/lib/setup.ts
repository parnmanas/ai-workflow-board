// ─── Interactive setup wizard ────────────────────────────────────────
// `awb-agent-manager setup` — first-run UX. Mirrors the openclaw / claude
// CLI feel: one command, prompts you for the few things it can't infer,
// writes the config file with the right perms, tells you the next step.
//
// Two modes:
//   - interactive: prompts via readline for missing fields
//   - non-interactive: --url / --token / --cli passed on argv. No prompts.
//     Used by provisioning scripts / Ansible / CI.
//
// The redeem endpoint is single-use + 10-min TTL on the server side. We
// never log the raw token (just the first 4 chars) and never log the raw
// apiKey returned (just the masked form). On success: config.json is
// written with mode 0600 and a friendly "next step" line is printed.

import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { CONFIG_PATH } from './constants.js';

export interface SetupOptions {
  /** Override config.json target path. Default: $AWB_AGENT_MANAGER_HOME/config.json */
  configPath?: string;
  /** AWB server base URL (no trailing slash). Prompted if absent. */
  url?: string;
  /** Pairing token (raw or 6-char display code). Prompted if absent. */
  token?: string;
  /** CLI to drive (claude / codex / gemini). Default claude. */
  cli?: string;
  /** Stable instance id reported on every heartbeat. Default `<hostname>-<rand>`. */
  instanceId?: string;
  /** When true, never prompt — fail fast on missing fields. */
  nonInteractive?: boolean;
  /** Overwrite an existing config without asking. */
  force?: boolean;
}

export interface SetupResult {
  ok: true;
  configPath: string;
  agentId: string;
  workspaceId: string;
}

const DEFAULT_CLI_CHOICES = ['claude', 'codex', 'gemini'] as const;
const DEFAULT_URL_HINT = 'https://awb.example.com:7700';

function maskKey(raw: string): string {
  if (!raw) return '';
  if (raw.length <= 12) return raw.slice(0, 4) + '***';
  return raw.slice(0, 8) + '***' + raw.slice(-4);
}

function maskToken(raw: string): string {
  if (!raw) return '';
  if (raw.length <= 6) return raw.slice(0, 2) + '***';
  return raw.slice(0, 4) + '***';
}

function autoInstanceId(): string {
  const host = (hostname() || 'host').replace(/\W+/g, '-').slice(0, 32);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${host}-${rand}`;
}

class Prompt {
  #rl: ReadlineInterface;
  constructor() {
    this.#rl = createInterface({ input: process.stdin, output: process.stderr });
  }
  ask(question: string, fallback?: string): Promise<string> {
    const suffix = fallback ? ` [${fallback}]` : '';
    return new Promise((resolve) => {
      this.#rl.question(`${question}${suffix}: `, (raw) => {
        const trimmed = raw.trim();
        resolve(trimmed || fallback || '');
      });
    });
  }
  close(): void {
    this.#rl.close();
  }
}

interface RedeemResponse {
  api_key: string;
  agent_id: string;
  workspace_id: string;
}

async function redeem(url: string, token: string, instanceId: string): Promise<RedeemResponse> {
  const trimmed = url.replace(/\/$/, '');
  const resp = await fetch(`${trimmed}/api/agent-manager/pair/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token, instance_id: instanceId }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) detail = parsed.error;
    } catch {
      /* keep raw text */
    }
    throw new Error(`pair/redeem ${resp.status} ${resp.statusText}: ${detail || '(empty body)'}`);
  }
  const body = (await resp.json()) as RedeemResponse;
  if (!body?.api_key || !body?.agent_id) {
    throw new Error(`pair/redeem returned malformed body: ${JSON.stringify(body)}`);
  }
  return body;
}

function writeConfigJson(path: string, body: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  // chmod separately so writeFileSync's umask doesn't matter.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows / FAT */
  }
}

/**
 * Run the setup flow. Caller is expected to have parsed argv into
 * SetupOptions and passed `nonInteractive=true` if no TTY is available
 * (CI, Ansible, etc.). Returns SetupResult on success; throws on failure
 * (caller maps to a friendly stderr line + exit code).
 */
export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const targetPath = options.configPath ?? CONFIG_PATH;

  if (existsSync(targetPath) && !options.force) {
    throw new Error(
      `config already exists at ${targetPath} — pass --force to overwrite, ` +
        `or delete the file first and re-run setup.`,
    );
  }

  let url = options.url?.trim() || '';
  let token = options.token?.trim() || '';
  let cli = (options.cli || '').trim().toLowerCase();
  const instanceId = options.instanceId?.trim() || autoInstanceId();

  if (!options.nonInteractive) {
    process.stderr.write('\n  awb-agent-manager — first-run pairing\n\n');
    const prompt = new Prompt();
    try {
      if (!url) url = await prompt.ask('AWB server URL', DEFAULT_URL_HINT);
      if (!token) {
        token = await prompt.ask(
          'Pairing token (paste from AWB Admin → Agent Manager → Pair manager…)',
        );
      }
      if (!cli) cli = await prompt.ask(`CLI to drive (${DEFAULT_CLI_CHOICES.join('/')})`, 'claude');
    } finally {
      prompt.close();
    }
  } else {
    if (!cli) cli = 'claude';
  }

  if (!url) throw new Error('AWB server URL is required (--url or interactive prompt)');
  if (!token) throw new Error('Pairing token is required (--token or interactive prompt)');
  if (!DEFAULT_CLI_CHOICES.includes(cli as any) && cli !== 'custom') {
    process.stderr.write(`  warn: cli="${cli}" is not a known adapter; manager will fall back to claude.\n`);
  }
  // Light URL sanity check — pair/redeem will fail anyway on garbage but a
  // local error is friendlier than the round-trip.
  try {
    new URL(url);
  } catch {
    throw new Error(`AWB server URL is not a valid URL: ${url}`);
  }

  process.stderr.write(`\n  Pairing with ${url}…\n`);
  process.stderr.write(`  token=${maskToken(token)}  instance_id=${instanceId}\n\n`);

  const issued = await redeem(url, token, instanceId);

  const configBody = {
    url,
    apiKey: issued.api_key,
    workspace_id: issued.workspace_id,
    agent_id: issued.agent_id,
    cli,
  };
  writeConfigJson(targetPath, configBody);

  process.stderr.write(`  ✓ paired\n`);
  process.stderr.write(`    agent_id     ${issued.agent_id}\n`);
  process.stderr.write(`    workspace_id ${issued.workspace_id}\n`);
  process.stderr.write(`    apiKey       ${maskKey(issued.api_key)}\n`);
  process.stderr.write(`  ✓ wrote ${targetPath} (mode 0600)\n\n`);
  process.stderr.write(`  Next: run \`awb-agent-manager\` to start the manager.\n`);

  return {
    ok: true,
    configPath: targetPath,
    agentId: issued.agent_id,
    workspaceId: issued.workspace_id,
  };
}
