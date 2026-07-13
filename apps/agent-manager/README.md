# awb-agent-manager

Standalone subagent runner for [AI Workflow Board](../../README.md). Connects to
an AWB server over SSE + REST, spawns CLI-driven agents (Claude, Codex, Antigravity,
or any custom binary that speaks MCP), and reports liveness back to the AWB
admin dashboard.

This package replaces the daemon that used to live inside the
`@parnmanas/awb` Claude plugin. The plugin (in
[`submodules/claude-plugins/ai-workflow-board/`](../../../claude-plugins/ai-workflow-board/))
is now a pure stdio↔HTTP MCP forwarder. agent-manager owns everything else:
SSE event delivery, persistent ticket/chat sessions, subagent supervision, fs
browser, instance heartbeats, and CLI lifecycle management.

```
┌─────────────────────────────────────────────────────────────────┐
│  AWB server (NestJS)                                            │
│   ├── /api/agent-manager/*    pairing, agent identity RPC       │
│   ├── /api/admin/agent-manager/*    instance dashboard, command │
│   └── SSE event stream  ─────────────┐                          │
└─────────────────────────────────────┬─┘                          │
                                      │ HTTP (Bearer key)          │
                                      ▼                            │
┌─────────────────────────────────────────────────────────────────┐│
│  awb-agent-manager  (this package)                              ││
│   ├── EventStream       SSE consumer + reconnect                ││
│   ├── EventDispatcher   route → ticket / chat / fs / command    ││
│   ├── ManagedAgents     spawn / stop / restart CLI children     ││
│   └── InstanceHeartbeat per-process registry ping ──────────────┘
└─────────────────────────────────────────────────────────────────┘
       │ stdio
       ▼
   claude / codex / antigravity / custom CLI
```

## Install

### npm (recommended)

```bash
npm i -g awb-agent-manager
awb-agent-manager --version
```

Published to the public npm registry as
[`awb-agent-manager`](https://www.npmjs.com/package/awb-agent-manager) (unscoped);
`npm i -g` always pulls the latest release. Every `version` bump that lands on
`main` is published automatically by
[`.github/workflows/publish-agent-manager.yml`](../../.github/workflows/publish-agent-manager.yml),
so npm stays in lockstep with the repo.

> A git-checkout install (see "Development") also self-updates from `origin/main`;
> a plain `npm i -g` install upgrades via `npm i -g awb-agent-manager@latest` and
> the admin badge reads "manual updates only" for it (no git checkout to pull).

### Docker

```bash
docker run --rm -it \
  -v "$HOME/.config/awb-agent-manager:/data" \
  -e AWB_AGENT_MANAGER_HOME=/data \
  ghcr.io/parnmanas/awb-agent-manager:latest
```

The image bundles `node:22-alpine` plus the manager binary. Mount a host
directory for `AWB_AGENT_MANAGER_HOME` so config + lockfile survive container
restarts. Bind-mount each agent's working directory the same way (e.g.
`-v $HOME/repos:/repos`) and configure those paths inside AWB.

## First run — pairing with an AWB server

The manager bootstraps from a one-time pairing token minted by an AWB admin.
After redeeming, the manager stores its API key and agent identity in
`$AWB_AGENT_MANAGER_HOME/config.json` (default
`~/.config/awb-agent-manager/config.json`).

1. **Mint** — In the AWB admin UI: _Admin → Agent Manager → Pair manager…_.
   The dialog returns a raw token (long-form) and a 6-char display code; copy
   either. Both are shown only once. TTL 10 minutes, single-use.
2. **Run the wizard** — On the host that will run the manager:

   ```bash
   awb-agent-manager setup
   ```

   You'll be prompted for:
   - AWB server URL (e.g. `https://awb.example.com:7700`)
   - Pairing token (paste from step 1)
   - CLI to drive (`claude` / `codex` / `antigravity`, default `claude`)

   The wizard calls `/api/agent-manager/pair/redeem`, then writes
   `~/.config/awb-agent-manager/config.json` with mode 0600. Output:

   ```
     ✓ paired
       agent_id     <uuid>
       workspace_id <uuid>
       apiKey       awb_abcd***xyz9
     ✓ wrote ~/.config/awb-agent-manager/config.json (mode 0600)

     Next: run `awb-agent-manager` to start the manager.
   ```

   Non-interactive form (CI / Ansible — fails fast on missing fields):

   ```bash
   awb-agent-manager setup \
     --url https://awb.example.com:7700 \
     --token ABCXYZ123 \
     --cli claude \
     --non-interactive
   ```

   `instance_id` defaults to `<hostname>-<rand6>` — pass `--instance-id <id>`
   for a stable label across re-pairings on the same box. `--force`
   overwrites an existing config.json.

3. **Start** — `awb-agent-manager`. The process registers with the AWB
   instance dashboard and starts listening for `agent_manager_command` SSE
   events.

4. **Add managed agents** — Back in AWB, _Agent Manager → Managed Agents →
   Create_. Pick the CLI (`claude` / `codex` / `antigravity` / `custom`), point at
   a working directory, and leave _Spawn on this manager after create_ on for
   one-click setup. The manager provisions a per-agent apiKey, writes its
   on-disk config + mcp-config.json, and starts routing matching ticket /
   chat / mention events to subagents that run under that agent's identity.

   On manager restart, agents previously spawned this way auto-rehydrate
   from disk — no need to re-click Spawn.

## Run as a background service

`awb-agent-manager service install` registers the manager so it starts on
boot/logon and auto-restarts on crash. The installer detects your host's
service manager and dispatches accordingly:

| Host                         | Backend                | Default unit path                                  |
|------------------------------|------------------------|----------------------------------------------------|
| Linux + systemd              | systemd unit           | `~/.config/systemd/user/awb-agent-manager.service` |
| Linux + Synology DSM         | rc.d boot script       | `/usr/local/etc/rc.d/awb-agent-manager.sh`         |
| Linux without systemd        | sysvinit               | `/etc/init.d/awb-agent-manager`                    |
| macOS                        | launchd                | `~/Library/LaunchAgents/com.awb.agent-manager.plist` |
| Windows                      | Task Scheduler         | task `awb-agent-manager` (logon trigger)           |

```bash
# user scope (no admin/sudo) — runs at logon, recommended for laptops
awb-agent-manager service install

# system scope — runs at boot, requires sudo / Administrator shell
awb-agent-manager service install --system

# preview without writing or running registrar
awb-agent-manager service install --dry-run

# force a specific backend (e.g. testing sysvinit on a systemd host)
awb-agent-manager service install --platform sysvinit

# remove
awb-agent-manager service uninstall [--system]
```

Notes:
- Linux user-mode systemd services stop at logout. Run
  `sudo loginctl enable-linger $USER` to keep the manager running after the
  installing user logs out.
- Synology DSM and bare sysvinit always install at system scope (the boot
  directories are root-owned). The `--system` flag is implied.
- Windows user-mode tasks fire at logon only. Re-run with `--system` from
  an elevated PowerShell for a boot-time task running as `LocalSystem`.
- macOS uses `launchctl bootstrap` on modern macOS and falls back to
  `launchctl load -w` on older releases. Logs land in `/tmp/awb-agent-manager.log`.

## Migration from the claude-plugin daemon (≤ v0.39)

The plugin daemon is gone as of plugin v0.40.0. Everything it owned moved
here. Migration is opt-in but easy:

- agent-manager auto-imports `~/.claude/channels/awb/{config,agent}.json` on
  first run if `~/.config/awb-agent-manager/config.json` is missing. A
  `MIGRATED-TO-AGENT-MANAGER.txt` marker is dropped next to the legacy files;
  subsequent starts skip the import. Legacy files are never deleted — the
  plugin's stdio MCP proxy still reads them.
- The first run will refuse to start while the legacy daemon's
  `~/.claude/channels/awb/agent.lock` is owned by a live PID. Stop the old
  Claude session (or `kill` the daemon) first, then start
  `awb-agent-manager`. Pass `--force` to take over a stale lock owned by a
  dead PID.

## Configuration

| Source                                           | Precedence       |
|--------------------------------------------------|------------------|
| `--config <path>` flag                           | 1 (highest)      |
| `$AWB_AGENT_MANAGER_HOME/config.json`            | 2                |
| `$XDG_CONFIG_HOME/awb-agent-manager/config.json` | 3 (Linux)        |
| `%APPDATA%\awb-agent-manager\config.json`        | 3 (Windows)      |
| `~/.config/awb-agent-manager/config.json`        | 4 (fallback)     |

Schema (`config.json`):

```json
{
  "url": "https://awb.example.com",
  "apiKey": "<bearer key from pairing>",
  "workspace_id": "<workspace uuid>",
  "agent_id": "<manager agent uuid>",
  "cli": "claude",
  "delegation": {
    "enabled": true,
    "max_concurrent_subagents": 4
  }
}
```

CLI flags (`awb-agent-manager --help`):

| Flag                    | Meaning                                                 |
|-------------------------|---------------------------------------------------------|
| `-c, --config <path>`   | Override config.json path                               |
| `-w, --workspace <id>`  | Override `workspace_id` from config                     |
| `-f, --force`           | Take over a lockfile owned by a stale or live owner     |
| `--dry-run`             | Load config, log what would happen, exit                |
| `-h, --help`            | Show full usage                                         |
| `-v, --version`         | Print version                                           |

Signals:

| Signal       | Behavior                                                  |
|--------------|-----------------------------------------------------------|
| `SIGTERM`/`SIGINT` | Graceful drain (stop subagents, release lock)       |
| `SIGHUP`     | Re-read `config.json` (delegation tunables hot-reload)    |
| `SIGUSR1`    | Self-update hook (currently a stub — upgrade via npm)     |

## Development

```bash
# from this directory
npm install            # workspace install at the repo root also works
npm run build          # tsc → dist/
npm run dev            # tsx watch src/main.ts
node dist/main.js -h
```

The full AWB workspace builds via turbo from the repo root:

```bash
cd ../..               # submodules/ai-workflow-board
npm install
npm run build          # builds agent-manager + client + server
```

For deep reference (config schema, SSE event types, security model, internals)
see [`docs/agent-manager.md`](../../docs/agent-manager.md).
