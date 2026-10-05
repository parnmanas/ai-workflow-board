# awb-agent-manager

The host-side execution service for [AI Workflow Board](../../README.md). Run it on the machine where your AI CLIs, repositories, and native session history live, then pair that machine with an AWB server.

The architectural name is **Runtime Host**. The npm package, binary, configuration directory, and API retain `agent-manager` for compatibility. The manager handles SSE delivery, ticket/chat execution, subagent supervision, native CLI sessions, terminals, filesystem browsing, heartbeats, and CLI lifecycle. AWB owns work, authorization, runtime selection, policy, and audit records. Native transcripts remain with the CLI.

```text
AWB server: work, accounts, permissions, MCP tools
              ↕ SSE + REST
awb-agent-manager: processes, sessions, terminals, capabilities
              ↕ CLI / ACP
Installed runtimes + repositories + native CLI history
```

For the full application setup, start with the [main README](../../README.md). Deep reference: [Runtime Host](../../docs/agent-manager.md), [Agent Sessions](../../docs/agent-sessions.md), and [CLI modules](../../docs/cli-modules.md).

## Requirements

- **Node.js 22+** for the published manager; **22.12+** when building the entire AWB repository.
- npm, and connectivity to the AWB server.
- A supported CLI installed/configured as the OS user running the manager. Installing this package does not install or sign in to every CLI.
- Git for repository checkout/worktrees. Browser terminals also need the optional PTY dependency to load successfully.

The host can run multiple runtimes. Ticket/chat/team/automation RuntimeSpecs and native session forms select the CLI per execution; there is no manager-wide CLI selection during setup. Capabilities and models are reported to AWB and determine what the UI offers.

## Install

```bash
npm i -g --ignore-scripts awb-agent-manager
awb-agent-manager --version
```

npm is the release/update channel. Self-update verifies the published package's provenance and installs from npm; it does not fetch or build a Git checkout. The `--ignore-scripts` flag matches self-update's installation path.

## Pair and start

1. Sign in to AWB as an administrator and open **Hosts** (`/hosts`) → **Runtime Hosts** → **Pair manager…**.
2. Copy the pairing token or six-character code. Both are single-use and expire after ten minutes; an AWB server restart also invalidates outstanding tokens.
3. Run the wizard on the execution machine:

   ```bash
   awb-agent-manager setup
   ```

   It asks for the **server base URL** and **pairing token**. For a local server use `http://localhost:7701`; for another machine use its reachable hostname or deployed HTTPS URL. Do not append `/mcp`.

4. Start in the foreground:

   ```bash
   awb-agent-manager
   ```

5. Confirm the host is online in AWB. Use **Sessions → New session**, select a ticket assignee, or declare a team/automation runtime to start work. There is no New Managed Agent creation step.

Setup redeems `/api/agent-manager/pair/redeem` and writes **both** `config.json` and `agent.json` with private file permissions where supported. New pairings create a Runtime Host and a host-bound key. The compatibility `agent_id` field contains the Host identity; it does not refer to an Agent database row. `account_id` is the canonical ownership field.

Non-interactive setup:

```bash
awb-agent-manager setup \
  --url https://awb.example.com \
  --token YOUR_PAIRING_TOKEN \
  --instance-id my-workstation \
  --non-interactive
```

`--instance-id` is optional (default `<hostname>-<random>`). `setup --force` overwrites an existing pairing configuration; back it up when replacing a host binding used by saved specs.

## Run as a background service

After verifying a foreground connection, stop that process and install the service:

```bash
awb-agent-manager service install
```

The installer detects the platform, writes the service definition, and registers it. Ensure the service's OS user can find and run your CLIs, read its login configuration, and access the chosen working folders.

| Host | Backend | Default user/system location |
| --- | --- | --- |
| Linux with systemd | systemd | `~/.config/systemd/user/awb-agent-manager.service` |
| Synology DSM | rc.d boot script | `/usr/local/etc/rc.d/awb-agent-manager.sh` |
| Linux without systemd | sysvinit | `/etc/init.d/awb-agent-manager` |
| macOS | launchd | `~/Library/LaunchAgents/com.awb.agent-manager.plist` |
| Windows | Task Scheduler | Task `awb-agent-manager` (logon trigger) |

```bash
awb-agent-manager service install --dry-run  # preview only
awb-agent-manager service install --system   # boot/system scope; needs elevation
awb-agent-manager service install --platform sysvinit
awb-agent-manager service uninstall
```

For system-scope removal, use `service uninstall --system`.

- Linux user services normally stop at logout. `sudo loginctl enable-linger "$USER"` keeps the service running after logout.
- Synology and sysvinit require system scope because their service directories are root-owned.
- Windows user tasks start at logon. System scope uses a boot-time task running as `LocalSystem`; that account has different files, credentials, and PATH from your user. The service uses a hidden script wrapper to avoid a console window.
- macOS uses launchd; logs are written to `/tmp/awb-agent-manager.log`.

See [process ownership](../../docs/agent-manager.md#process-and-session-ownership) and [self-update policy](../../docs/agent-manager.md#self-update-policy) before changing an existing service.

## Configuration

Config search order:

| Priority | Source |
| --- | --- |
| 1 | `--config <path>` |
| 2 | `$AWB_AGENT_MANAGER_HOME/config.json` |
| 3 | `$XDG_CONFIG_HOME/awb-agent-manager/config.json` on Linux, or `%APPDATA%\awb-agent-manager\config.json` on Windows |
| 4 | `~/.config/awb-agent-manager/config.json` |

Pairing writes a configuration of this shape:

```json
{
  "url": "https://awb.example.com",
  "apiKey": "<host key from pairing>",
  "account_id": "<pairing account UUID>",
  "agent_id": "<Runtime Host UUID>",
  "host_id": "<Runtime Host UUID>"
}
```

Optional delegation settings can be added:

```json
{
  "delegation": {
    "enabled": true,
    "max_concurrent_subagents": 4
  }
}
```

Legacy `workspace_id` config is still read as `account_id`. The owner UUID and existing credential/MCP filename suffixes and native session home paths are preserved. A paired host supervises authorized work across accounts; selecting an account is not needed for ordinary host use.

| Flag | Purpose |
| --- | --- |
| `-c, --config <path>` | Override config path. |
| `--account <id>` | Optional manual `account_id` override. |
| `-w, --workspace <id>` | Deprecated alias for `--account`. |
| `--runtime-profile <path\|none>` | Manager-run profile override. |
| `-f, --force` | Lock takeover; supervised managers hand restart to their service. |
| `--dry-run` | Load config and exit without starting execution. |
| `-h, --help` | Show commands and current options. |
| `-v, --version` | Print the installed binary's version. |

Signals on platforms that support them:

| Signal | Behavior |
| --- | --- |
| `SIGTERM` / `SIGINT` | Graceful drain, release lock, exit. |
| `SIGHUP` | Reload config/delegation tunables. |
| `SIGUSR1` | Request npm self-update, draining before restart. |
| `SIGUSR2` | Restart in place without installing a package. |

The service retains runtime-local files for resume/recovery. These filesystem identities are separate from optional **Agent templates**, which only copy reusable preferences into new execution forms.

## Updates

Hosts shows the running version, installed version, and whether restart is required. Installing a newer global package does not replace code already loaded by the process; use the Hosts update/restart action to apply it.

`AWB_AGENT_MANAGER_UPDATE_CHANNEL` selects the update target:

| Value | Behavior |
| --- | --- |
| unset / `latest` | Published release line. |
| dist-tag, e.g. `next` | A release line published by the same provenance-signed workflow. |
| exact version | Pin the update target to that published version. |
| `off` | Disable automatic updates. |

The channel selects **what** can be installed; update policy controls **when**. Automatic scheduled updates use the documented approval policy. Manual actions, draining, retry/backoff, and service restart details are in [self-update policy](../../docs/agent-manager.md#self-update-policy).

The [publishing workflow](../../.github/workflows/publish-agent-manager.yml) computes the release version at publish time and records it in the tarball/tag, without committing it back to `main`. The source `package.json` version is a seed floor and may lag the published release. Do not bump it manually. README/test-only changes do not trigger a package publish.

## Development and unpublished builds

From the repository root:

```bash
npm ci --ignore-scripts
npm run build                       # client + server + manager
npm run dev:agent-manager            # local manager, requires pairing config
npm test -w awb-agent-manager
```

To test the compiled binary without starting it:

```bash
node apps/agent-manager/dist/main.js --help
```

To install an unpublished local package:

```bash
npm run build -w awb-agent-manager
npm pack -w awb-agent-manager
# Replace the filename with the tarball printed by npm pack.
npm i -g --ignore-scripts "./awb-agent-manager-<version>.tgz"
```

Set `AWB_AGENT_MANAGER_UPDATE_CHANNEL=off` **in the environment of the process/service** so automatic updates do not replace that build. Restore the normal channel to return to published releases. A local tarball is for local testing and does not have registry provenance.

Manager source/wire changes require a full repository build and coordinated server changes. Follow the [release runbook](../../docs/runbooks/agent-manager-release.md).

## Troubleshooting

- **Host offline:** verify the URL/key, network access, and service logs. Re-pair with a fresh token if the binding was lost.
- **CLI missing in AWB:** check the executable and login as the service's OS user, then refresh capabilities/models in Hosts.
- **Session does not resume:** preserve the native CLI history and manager homes; check the pinned credential/backend and [session troubleshooting](../../docs/agent-sessions.md#운영-메모).
- **Terminals unavailable:** the optional PTY module must load on that platform. See [Terminals](../../docs/terminals.md).
- **Updated but behavior is old:** compare running and installed versions; restart the supervised process through Hosts.

## License

[MIT](LICENSE).
