// Pi CLI adapter — stateless one-shot, credential-free (ticket d72282ad).
// Pi (`pi`, https://pi.dev, npm `@earendil-works/pi-coding-agent`) is a
// terminal coding agent in the same family as Claude Code / Codex /
// Antigravity, but its README states an explicit design philosophy: "No
// MCP. Build CLI tools with READMEs (see Skills), or build an extension
// that adds MCP support." Verified against the CHANGELOG through v0.81.1
// (2026-07-21) — no release has ever mentioned MCP. So unlike codex /
// antigravity, the spawned `pi` process cannot call AWB MCP tools
// (get_ticket / add_comment / move_ticket) itself today: we deliberately do
// NOT write a speculative mcp.json, because no schema for it is verified
// against anything pi actually parses yet (the upstream MCP proposal,
// github.com/earendil-works/pi/issues/563, is still open/unimplemented, and
// third-party bridge extensions have unconfirmed transport support) —
// shipping a guessed config here would repeat the exact codex `transport`
// regression this ticket was warned about, just one layer further out. Chat
// one-shots still work end-to-end (the manager relays pi's reply via REST,
// same as any non-native-MCP adapter); ticket dispatch can run the work but
// won't self-progress the ticket. See the ticket comment on d72282ad and its
// follow-up for revisiting this once pi (or a verified extension) ships a
// real MCP client.
//
// Pi also has no credential concept AWB manages — no per-agent credential
// kind exists to select in the UI. Its own provider auth (API key / OAuth /
// a local llama.cpp server, pi's only genuinely key-free provider) lives in
// the operator's real `~/.pi/agent/{auth.json,settings.json}`.
// prepareCliHome symlinks those two files into the per-agent home (mirrors
// codex's operator-HOME fallback — the ONLY path here, since pi never has a
// per-agent override to prefer) so a spawned agent inherits whatever the
// operator already set up via `pi /login`, without AWB ever touching a
// secret.
//
// configDirEnv() returns 'HOME' (like antigravity) because pi has no
// dedicated config-dir env var of its own — paths always resolve under
// `~/.pi/agent/` (docs/settings.md).

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCliBin } from '../cli-resolver.js';
import {
  type AdapterCredential,
  type AdapterMcpContext,
  CliAdapter,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SpawnDescriptor,
} from './base.js';

// Files the operator's real ~/.pi/agent/ home must lend a fresh per-agent
// HOME so pi can actually authenticate — mirrors codex's
// SHARED_FROM_MAIN_HOME. `auth.json` carries the resolved provider
// credential (API key or OAuth token); `settings.json` carries
// `defaultProvider`/`defaultModel` (including a llama.cpp local-server
// setup). Session history / project state intentionally stay isolated.
const SHARED_FROM_MAIN_HOME = ['auth.json', 'settings.json'];

export class PiCliAdapter extends CliAdapter {
  static cliType = 'pi';

  constructor() {
    super();
    // Stateless one-shot — pi has no stream-json-style persistent session
    // protocol to drive — and no native MCP client (see file banner), so
    // both capability bits stay off. The SubagentManager handles the
    // one-shot spawn, collects stdout via collectOneshotResult(), and posts
    // the result to AWB on this adapter's behalf.
    this.capabilities = new Set();
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('pi', configured);
  }

  buildOneshotSpawn({ rolePrompt, taskText, model }: OneshotSpec): SpawnDescriptor {
    const fullPrompt = rolePrompt ? `${rolePrompt}\n\n${taskText}` : taskText || '';
    // `pi -p "<prompt>"` prints the response and exits — pi's documented
    // automation entry point. Non-interactive modes (-p / --mode json /
    // --mode rpc) never show the interactive project-trust prompt, so this
    // cannot hang waiting on a human; `--approve` additionally auto-trusts
    // whatever project-local `.pi/` the target repo happens to ship for
    // this run instead of silently skipping it (mirrors codex/antigravity's
    // own approval-bypass flags — the spawn already runs in a per-agent
    // sandbox, so an interactive approval would be redundant even if one
    // were possible here). `--no-session` keeps one-shot ticket dispatches
    // from accumulating unbounded session history in the per-agent home.
    // Per-agent default model (Agent.model) is omitted when unset so pi
    // keeps its own configured default — same as codex/antigravity.
    return {
      args: ['-p', fullPrompt, ...(model ? ['--model', model] : []), '--approve', '--no-session'],
      stdio: ['pipe', 'pipe', 'pipe'],
      needsMcpConfig: false,
      writePrompt: undefined,
    };
  }

  parseStdoutLine(line: string): ParseResult {
    // `-p` mode prints plain text, not structured events (pi's `--mode
    // json`/`--mode rpc` exist but their event schema isn't documented
    // anywhere we could verify, so we don't parse against a guess — see
    // file banner). Treat any non-empty line as composing-stage progress,
    // mirroring antigravity.
    const trimmed = String(line || '').trim();
    return {
      stage: trimmed ? PARSE_STAGE.COMPOSING : null,
      isResult: false,
      isError: false,
      raw: line,
    };
  }

  collectOneshotResult(lines: string[]): string | null {
    // Plain-text mode: concatenate all non-empty lines (mirrors antigravity).
    const raw = (Array.isArray(lines) ? lines : [])
      .filter((l) => {
        const s = String(l || '').trim();
        if (!s) return false;
        if (s.startsWith('Warning:')) return false;
        return true;
      })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '') // Strip ANSI escape sequences
      .replace(/^\s+|\s+$/g, '');
    return raw || null;
  }

  configDirEnv(): string {
    return 'HOME';
  }

  async prepareCliHome(
    cliHomeDir: string,
    _credential?: AdapterCredential | null,
    _mcp?: AdapterMcpContext | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    const piAgentDir = join(cliHomeDir, '.pi', 'agent');
    await fsp.mkdir(piAgentDir, { recursive: true, mode: 0o700 });

    // Pi has no per-agent credential AWB manages (see file banner) — always
    // inherit the operator's own already-authenticated ~/.pi/agent/ files,
    // whatever provider they configured via `pi /login` (including a
    // credential-free llama.cpp local server), instead of branching on a
    // credential kind the way codex/antigravity do.
    const mainAgentDir = join(homedir(), '.pi', 'agent');
    for (const name of SHARED_FROM_MAIN_HOME) {
      const src = join(mainAgentDir, name);
      const dst = join(piAgentDir, name);
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
        if (err?.code === 'EPERM' || err?.code === 'EACCES') {
          await fsp.copyFile(src, dst);
        } else {
          throw err;
        }
      }
    }

    return { extraEnv: {} };
  }
}
