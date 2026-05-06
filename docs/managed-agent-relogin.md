# Managed agent — claude CLI re-login

agent-manager spawns each managed agent's `claude` CLI under an isolated
`CLAUDE_CONFIG_DIR`, so a normal `claude /login` in an operator shell
never reaches the right place. This doc covers two supported re-login
flows and when to use which.

Symptoms that say a re-login is overdue:

- **AWB Admin → Agent Manager → Managed agents** shows a yellow/red
  badge next to the agent (`expires in <N>h`, `expired`, `no refresh`,
  `no credential`). The badge is driven by the manager heartbeat reading
  `agents/<id>/cli-home/.credentials.json` every 30s; a yellow badge means
  re-login proactively, a red badge means turns are already failing.
- `apps/agent-manager` log shows `result subtype=success is_error=true`
  every turn, finishing in 1–2s, and the session is killed as `UNHEALTHY`
  every 25 min and respawned without progress.
- `agents/<id>/cli-home/.credentials.json`'s `claudeAiOauth.expiresAt`
  is in the past (or `refreshToken` is empty and the token has rotated
  past its 5-day window).
- Tickets stop progressing for an agent that worked yesterday.

Layout reference:

```
$AWB_AGENT_MANAGER_HOME/                       # %APPDATA%\awb-agent-manager (Windows)
                                               # ~/.config/awb-agent-manager (Linux/macOS)
├── config.json                                # manager identity (manager apiKey, workspace)
├── agent-manager.log                          # rotating log
└── agents/
    └── <agent_id>/
        ├── config.json                        # name, cli, working_dir, workspace_id
        └── cli-home/                          # CLAUDE_CONFIG_DIR for this agent
            └── .credentials.json              # ← what re-login writes
```

## Method A — Direct (shell on the host)

Use when you already have a shell on the box that runs agent-manager.
Fastest path; no AWB UI round-trip; no credential is persisted to AWB
storage.

Run the helper:

```powershell
# Windows (PowerShell)
pwsh -File scripts\relogin-managed-agent.ps1                    # auto-pick if 1 agent
pwsh -File scripts\relogin-managed-agent.ps1 -List               # show all agents
pwsh -File scripts\relogin-managed-agent.ps1 -AgentId <uuid>     # specific agent
```

```bash
# Linux / macOS
scripts/relogin-managed-agent.sh
scripts/relogin-managed-agent.sh --list
scripts/relogin-managed-agent.sh --agent-id <uuid>
```

The script:

1. Resolves `$AWB_AGENT_MANAGER_HOME/agents/<agent_id>/cli-home`.
2. Sets `CLAUDE_CONFIG_DIR` to that path **only** for the child process.
3. Runs `claude /login` (browser OAuth — the operator must complete it).
4. Reads the resulting `.credentials.json` and prints `expiresAt`,
   `refreshToken` presence, `subscriptionType` for both BEFORE and AFTER.
5. Fails loud if the new token is already expired, warns if
   `refreshToken` is empty (no auto-refresh path).

After the script finishes, restart the agent in AWB so the running
subagent loop picks up the new token:

> Admin → Agent Manager → \<agent\> → **Restart**

(Background: agent-manager re-runs `prepareCliHome` on every spawn, so
any new spawn after the file was rewritten picks up the new token.
Restarting the agent — or just letting the next UNHEALTHY-respawn fire —
is what cuts the loop.)

## Method B — Remote injection (AWB UI)

Use when you don't have shell access to the agent-manager host (or you
want one source-of-truth for the credential, e.g. for rotation across
multiple agents).

You still need to run `claude /login` once on **some** machine that has
a browser. After that the credential lives in AWB and the next renewal
is a UI-only operation.

Steps:

1. **Generate a fresh credential.** Easiest path: run Method A's helper
   on any machine with `-ShowCredential` / `--show-credential` — it
   prints the entire `.credentials.json` body between
   `----- BEGIN credentials_json -----` markers. Copy that JSON.

   *(Or do a regular `claude /login` on any machine and read
   `~/.claude/.credentials.json` / `%USERPROFILE%\.claude\.credentials.json`.
   Same content.)*

2. **Save it as a Credential in AWB.**
   `Admin → Credentials → New`
   - Workspace: the agent's workspace
   - Provider: `Claude (Subscription)`
   - Name: anything memorable (e.g. `claude-gameclient-2026-05`)
   - `credentials_json`: paste the entire JSON
   - Save.

3. **Attach the credential to the agent.**
   `Admin → Agent Manager → <agent> → Edit → CLI credential` → pick the
   credential saved in step 2 → Save.

4. **Restart the agent.**
   `Admin → Agent Manager → <agent> → Restart` (sends
   `agent_manager_command: restart_agent` over SSE).

5. agent-manager's `restart_agent` handler stops the running CLI, then
   `prepareCliHome` overwrites `cli-home/.credentials.json` from the
   credential record (verbatim), and the new spawn uses it.

For renewals, repeat steps 1+2 (paste a fresh JSON into the existing
credential record's `credentials_json` field and Save) then step 4. No
shell access needed.

## When the OAuth has no `refreshToken`

Some `claude /login` runs return a credential with an empty
`refreshToken`. The CLI then can't auto-renew, the access token expires
silently after a few days, and the symptoms above recur.

Two mitigations:

- **Track the expiry.** The helper script prints `expiresAt` so you can
  put a calendar reminder ahead of it.
- **Use API-key auth instead.** AWB has `Claude (API Key)` provider
  alongside `Claude (Subscription)`. The API-key path exports
  `ANTHROPIC_API_KEY` on every spawn (no token rotation, no manual
  re-login). For unattended 24/7 agents this is more robust.

## Don't share one Claude account across multiple managed agents

Anthropic's OAuth flow can rotate or invalidate the access token when
the same account is logged in from another device. If two agents use
the same account, the next login on either side may kill the other.
Mint a separate Anthropic account per agent, or use API-key
credentials, which are per-key and don't have this contention.

## Failure modes table

| Symptom in agent-manager.log                                   | Likely cause                          | Fix                                      |
| -------------------------------------------------------------- | ------------------------------------- | ---------------------------------------- |
| `result subtype=success is_error=true` in 1–2s every turn      | OAuth token expired                   | Method A or B                            |
| `tap … marked dead — server doesn't recognize it`              | downstream of the auth failure        | resolves once auth is fixed              |
| Token had `refreshToken: ""` from the start                    | Anthropic returned no refresh token   | Track expiry, or switch to API key       |
| Many agents on one Anthropic account stop responding together  | account-level token rotation          | Per-agent accounts, or API-key auth      |
| `prepareCliHome` log: cannot symlink (`EPERM`/`EACCES`)        | Windows without Developer Mode        | Harmless — the manager falls back to `copyFile`; next spawn picks it up |

## See also

- `apps/agent-manager/src/lib/cli-adapters/claude.ts` — `prepareCliHome`
  is what consumes the per-agent `.credentials.json` / API-key
  credential on every spawn.
- `apps/server/src/modules/credentials/credentials.controller.ts` —
  `claude_subscription` / `claude_api_key` provider field shapes used
  by Method B.
- `docs/agent-manager.md` — overall internals.
