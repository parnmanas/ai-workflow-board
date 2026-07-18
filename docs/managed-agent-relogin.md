# Managed agent — claude CLI re-login

agent-manager spawns each managed agent's `claude` CLI under an isolated
`CLAUDE_CONFIG_DIR`, so a normal `claude /login` in an operator shell
never reaches the right place. This doc covers two supported re-login
flows and when to use which.

> **An empty per-agent `credential_id` is not a missing credential.** When an
> agent has no per-agent credential attached, the adapter falls back to the
> login already on the **manager host** ("operator HOME") — for `claude`/`codex`
> a host CLI login (`claude login` / `codex login`), for `deepseek`/`antigravity`
> a host env var. This is a valid, common setup; it surfaces as the neutral
> `operator HOME` badge, **not** the red `no credential` one. Don't treat a blank
> `credential_id` as an auth failure — the per-adapter fallback table is in
> [`docs/agent-manager.md` → "Per-agent credential fallback"](agent-manager.md#per-agent-credential-fallback-empty-credential_id).
> Attach a per-agent credential (Methods B/C below) only when you want **isolated**
> auth rather than the host login.

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

## Method C — Long-lived OAuth token (recommended for shared accounts)

Use when **multiple machines / agents share one Claude account** and the
rotating subscription token (Method B) logs everyone out daily — see
"Don't share one Claude account" below for why that happens. This is the
no-rotation fix: `claude setup-token` mints a **~1-year, non-rotating**
OAuth token (`sk-ant-oat...`, billed to the Pro/Max/Team/Enterprise
subscription, inference-only scope). AWB injects it as
`CLAUDE_CODE_OAUTH_TOKEN`, which the CLI honors directly (auth precedence
**#5**) and which **never touches the rotating `.credentials.json`** — so
one token registered once feeds every agent-manager with no daily
re-login.

Steps:

1. **Mint the token (once).** On any machine with a browser:

   ```bash
   claude setup-token
   ```

   It runs an OAuth flow and prints the token (`sk-ant-oat...`). It only
   prints — nothing is persisted to disk. Copy it.

2. **Save it as a Credential in AWB.**
   `Admin → Credentials → New`
   - Workspace: the agents' workspace
   - Provider: `Claude (OAuth Token)`
   - Name: e.g. `claude-shared-oauth-2026`
   - `oauth_token`: paste the `sk-ant-oat...` value
   - Save.

3. **Attach to each agent.**
   `Admin → Agent Manager → <agent> → Edit → CLI credential` → pick the
   credential from step 2 → Save. The same credential can back any number
   of agents.

4. **Propagate.** `Admin → Agent Manager → Restart all agents` — agents
   re-fetch the credential on the next spawn and inject
   `CLAUDE_CODE_OAUTH_TOKEN`. No `.credentials.json` is written, so there
   is nothing to rotate and no daily logout.

**Renewal** (once a ~year): re-run `claude setup-token`, paste the new
value into the existing credential record's `oauth_token` field and Save,
then **Restart all agents**. UI-only, no shell, all machines at once.

> Quick host-only workaround (no AWB record): set
> `CLAUDE_CODE_OAUTH_TOKEN=<setup-token>` in the agent-manager process
> environment (systemd unit / shell profile). The adapter never strips
> this key, so it just works — but it's per-machine and not centrally
> renewable, which is what Method C formalizes.

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
Mint a separate Anthropic account per agent, use API-key credentials
(per-key, no contention), or — to keep one shared subscription account —
use **Method C's long-lived `setup-token`**, which doesn't rotate and so
never triggers the cross-device invalidation in the first place.

## Failure modes table

| Symptom in agent-manager.log                                   | Likely cause                          | Fix                                      |
| -------------------------------------------------------------- | ------------------------------------- | ---------------------------------------- |
| `result subtype=success is_error=true` in 1–2s every turn      | OAuth token expired                   | Method A or B                            |
| `tap … marked dead — server doesn't recognize it`              | downstream of the auth failure        | resolves once auth is fixed              |
| Token had `refreshToken: ""` from the start                    | Anthropic returned no refresh token   | Track expiry, or switch to API key       |
| Many agents on one Anthropic account stop responding together  | account-level token rotation          | Per-agent accounts, API-key auth, or Method C `setup-token` |
| All machines log out ~once a day on a shared account           | per-machine `.credentials.json` refresh rotates the shared upstream token | Method C — `claude setup-token` (non-rotating) |
| `prepareCliHome` log: cannot symlink (`EPERM`/`EACCES`)        | Windows without Developer Mode        | Harmless — the manager falls back to `copyFile`; next spawn picks it up |

## See also

- `apps/agent-manager/src/lib/cli-adapters/claude.ts` — `prepareCliHome`
  is what consumes the per-agent `.credentials.json` / API-key
  credential on every spawn.
- `apps/server/src/modules/credentials/credentials.controller.ts` —
  `claude_subscription` / `claude_api_key` / `claude_oauth_token`
  provider field shapes used by Methods B and C.
- `docs/agent-manager.md` — overall internals.
