// Codex CLI adapter — stateless one-shot, mirrors the Gemini path.
// Like Gemini, codex doesn't speak AWB MCP tools natively, so the
// manager collects codex's stdout via collectOneshotResult() and posts
// the answer back through its own REST connection.
//
// configDirEnv returns CODEX_HOME so per-agent isolation puts codex's
// settings / auth / history under <MANAGER_HOME>/agents/<id>/cli-home/
// rather than sharing the operator's $HOME.

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCliBin } from '../cli-resolver.js';
import {
  CliAdapter,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SpawnDescriptor,
} from './base.js';

// Files the per-agent codex home must inherit from the operator's main home
// for spawned children to authenticate and pick up the operator's model /
// provider preferences. Sessions / history / caches stay isolated.
const SHARED_FROM_MAIN_HOME = ['auth.json', 'config.toml'];

export class CodexCliAdapter extends CliAdapter {
  static cliType = 'codex';

  constructor() {
    super();
    this.capabilities = new Set();
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('codex', configured);
  }

  buildOneshotSpawn({ rolePrompt, taskText }: OneshotSpec): SpawnDescriptor {
    const fullPrompt = rolePrompt ? `${rolePrompt}\n\n${taskText}` : taskText || '';
    // `codex` with no subcommand is the interactive TUI and refuses piped
    // stdin ("stdin is not a terminal"). `codex exec` is the non-interactive
    // counterpart and reads the prompt from stdin when none is passed as
    // argv. --json gives us structured events (thread/turn/item) instead of
    // ANSI-decorated TUI output, so collectOneshotResult can extract just
    // the agent's reply. --skip-git-repo-check lets the agent run in cwd
    // that may not be a git worktree, and the bypass flag mirrors how the
    // managed-agent harness already runs claude (the manager spawns under
    // the operator's identity in a sandboxed agent home, so external
    // approvals are redundant).
    return {
      args: [
        'exec',
        '--skip-git-repo-check',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
      ],
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
    // `codex exec --json` emits one JSON object per line. Common types:
    //   thread.started / turn.started / item.started — progress
    //   item.completed — a step finished; agent_message carries the reply
    //   turn.completed — the whole turn ended successfully
    //   turn.failed / error — terminal failure for this turn
    let obj: any = null;
    try {
      obj = JSON.parse(line);
    } catch {
      // Non-JSON lines (codex's own startup banner like
      // "Reading prompt from stdin...", or stray rust tracing output) —
      // treat as composing-stage progress so the watchdog sees activity.
      const trimmed = String(line || '').trim();
      return {
        stage: trimmed ? PARSE_STAGE.COMPOSING : null,
        isResult: false,
        isError: false,
        raw: line,
      };
    }
    const t = obj?.type;
    const isComposing = t === 'item.completed';
    const isResult = t === 'turn.completed';
    const isError = t === 'turn.failed' || t === 'error';
    return {
      stage: isComposing ? PARSE_STAGE.COMPOSING : t ? PARSE_STAGE.THINKING : null,
      isResult,
      isError,
      raw: obj,
    };
  }

  collectOneshotResult(lines: string[]): string | null {
    // Walk the JSONL stream and pull out the assistant's textual replies
    // from `item.completed` events of type `agent_message`. Concatenate
    // multiple messages with blank lines between (rare, but `codex exec`
    // can emit several when the model breaks its reply into parts).
    const parts: string[] = [];
    let lastError: string | null = null;
    for (const line of Array.isArray(lines) ? lines : []) {
      let obj: any = null;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
        const text = String(obj.item.text ?? '').trim();
        if (text) parts.push(text);
      } else if (obj.type === 'turn.failed') {
        lastError = String(obj.error?.message ?? 'codex turn failed');
      } else if (obj.type === 'error' && typeof obj.message === 'string') {
        lastError = obj.message;
      }
    }
    if (parts.length > 0) return parts.join('\n\n').replace(/^\s+|\s+$/g, '');
    if (lastError) return `[codex error] ${lastError}`;
    // Fallback: if codex emitted nothing JSON-parseable (older version,
    // unexpected output), surface raw stdout so the operator can see what
    // happened on the ticket instead of silently posting nothing.
    const raw = (Array.isArray(lines) ? lines : []).join('\n').replace(/^\s+|\s+$/g, '');
    return raw || null;
  }

  configDirEnv(): string {
    return 'CODEX_HOME';
  }

  async prepareCliHome(cliHomeDir: string): Promise<void> {
    // Codex authenticates via auth.json (written by `codex login`) inside
    // CODEX_HOME. A fresh per-agent home has none, so without help every
    // spawn would fail with HTTP 401 from the OpenAI API after a few
    // reconnect attempts (verified manually). We also symlink config.toml
    // so the operator's model / provider / sandbox preferences carry over
    // — without it, codex falls back to compiled-in defaults that may not
    // match the model the operator actually wants this agent to run.
    //
    // Source resolution: $CODEX_HOME if the operator has redirected the
    // manager's main codex home, else ~/.codex. Each entry is best-effort:
    // missing source = operator hasn't `codex login`-ed yet (auth.json) or
    // hasn't customized config (config.toml); codex itself surfaces a
    // clearer error than us spamming "missing file" warnings would.
    const mainHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    for (const name of SHARED_FROM_MAIN_HOME) {
      const src = join(mainHome, name);
      const dst = join(cliHomeDir, name);
      try {
        await fsp.access(src);
      } catch {
        continue;
      }
      try {
        await fsp.unlink(dst);
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
      try {
        await fsp.symlink(src, dst);
      } catch (err: any) {
        // Windows CreateSymbolicLink requires admin or Developer Mode;
        // without that privilege fs.symlink fails with EPERM. Fall back
        // to a plain copy — this hook reruns on every spawn, so a fresh
        // `codex login` / config edit propagates on the next restart.
        // Mirrors the claude adapter's fallback so codex agents work on
        // the same operator hosts that the claude path supports.
        if (err?.code === 'EPERM' || err?.code === 'EACCES') {
          await fsp.copyFile(src, dst);
        } else {
          throw err;
        }
      }
    }
  }
}
