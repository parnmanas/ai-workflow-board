// Gemini CLI adapter — stateless one-shot. Gemini doesn't speak AWB's MCP
// tools, so the manager collects gemini's stdout via collectOneshotResult()
// and posts the answer back to AWB through its own REST connection.

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { resolveCliBin } from '../cli-resolver.js';
import {
  type AdapterCredential,
  CliAdapter,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SpawnDescriptor,
} from './base.js';

export class GeminiCliAdapter extends CliAdapter {
  static cliType = 'gemini';

  constructor() {
    super();
    this.capabilities = new Set();
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('gemini', configured);
  }

  buildOneshotSpawn({ rolePrompt, taskText }: OneshotSpec): SpawnDescriptor {
    const fullPrompt = rolePrompt ? `${rolePrompt}\n\n${taskText}` : taskText || '';
    return {
      args: [],
      stdio: ['pipe', 'pipe', 'pipe'],
      needsMcpConfig: false,
      writePrompt: (child) => {
        try {
          child.stdin?.write(fullPrompt);
          child.stdin?.end();
        } catch {
          /* spawn already failed; manager's error handler logs it */
        }
      },
    };
  }

  parseStdoutLine(line: string): ParseResult {
    const trimmed = String(line || '').trim();
    return {
      stage: trimmed ? PARSE_STAGE.COMPOSING : null,
      isResult: false,
      isError: false,
      raw: line,
    };
  }

  collectOneshotResult(lines: string[]): string | null {
    const text = (Array.isArray(lines) ? lines : []).join('\n');
    return text.replace(/^\s+|\s+$/g, '');
  }

  configDirEnv(): string {
    // Gemini CLI uses GEMINI_HOME (matches `gemini --help`'s config-dir
    // override). Per-agent isolation puts its settings + auth + history
    // under <MANAGER_HOME>/agents/<id>/cli-home/.
    return 'GEMINI_HOME';
  }

  authEnvKeys(): string[] {
    // Both GEMINI_API_KEY and GOOGLE_API_KEY are honored by the gemini CLI
    // (and various Google AI SDKs) for direct-key auth; either would shadow
    // the per-agent oauth_creds.json (subscription kind) or the per-agent
    // GEMINI_API_KEY (api_key kind).
    return ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  }

  async prepareCliHome(
    cliHomeDir: string,
    credential?: AdapterCredential | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    // The gemini CLI persists its OAuth credential under the config-dir as
    // `oauth_creds.json`. We don't sync from operator HOME here (no legacy
    // hook existed) — only honour the per-agent credential. When none is
    // set the CLI itself surfaces a clearer "not authenticated" error
    // than us scribbling files to disk would.
    const oauthDst = join(cliHomeDir, 'oauth_creds.json');
    try {
      await fsp.unlink(oauthDst);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    if (credential && credential.provider === 'gemini_subscription') {
      const body = credential.fields?.oauth_creds_json ?? '';
      if (body) {
        await fsp.writeFile(oauthDst, body, { mode: 0o600 });
      }
      return { extraEnv: {} };
    }

    if (credential && credential.provider === 'gemini_api_key') {
      const apiKey = credential.fields?.api_key ?? '';
      // GEMINI_API_KEY is the canonical env var; some integrations also
      // honour GOOGLE_API_KEY, set both for compatibility.
      return {
        extraEnv: apiKey ? { GEMINI_API_KEY: apiKey, GOOGLE_API_KEY: apiKey } : {},
      };
    }

    return { extraEnv: {} };
  }
}
