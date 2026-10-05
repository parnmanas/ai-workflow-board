# Documentation reconciliation — 2026-10-05

Baseline: `dfec0684` (`main`, after Account ownership removal). This is a dated
record of documentation checks, not a replacement for the feature contracts in
the [documentation index](../README.md).

## Method and scope

Compared the root/manager READMEs, active feature guides, contributor instructions,
module map, environment example, and operational runbooks against checked-out
source, manifests, scripts, migrations, and UI routes. Recent Git history helped
identify board removal, Agent cleanup/templates, ownership rename, session
binding, model-source, and voice changes. Historical plans/research remain dated
evidence; their index and entry notices explain how to find current behavior.

## Reconciled differences

| Earlier description | Current contract | Evidence |
| --- | --- | --- |
| Node 20+, Vite 6; dev starts only client/server | Full build needs Node 22.12+; Vite 8; root dev starts all workspaces and clears ports. The getting-started command filters to client/server. | Workspace manifests, `apps/client/vite.config.ts`, `scripts/clear-ports.mjs`. |
| Pairing asks for a CLI; create a Managed Agent afterward | Pair in `/hosts`; setup takes URL/token. Select inline RuntimeSpecs/native sessions. Pairing creates a Host and host-bound key, with no Agent row. | `App.tsx`, manager `lib/setup.ts`, `agent-manager.controller.ts`, `agent-auth.guard.ts`. |
| Agent rows/managed-agent directory are the work selection model | The Agent table is removed. Templates copy preferences; specs declare execution. Historical runtime IDs remain execution data. | `AgentTemplate.ts`, `common/runtime-spec.ts`, `pre-sync-agent-cleanup.ts`, migration 0090. |
| Changing Host changes the runtime identity key | The key hashes CLI, working folder, and credential. Host/model/label are not hash inputs; the spec separately addresses the host. | Server and manager `runtimeIdentityKey()` implementations. |
| Team models come directly from heartbeat `available_models` | `HostModelsService` / `useHostModels` select the first non-empty live ACP, persisted ACP, or heartbeat source. | `host-models.service.ts`, `orchestration-hosts.service.ts`, client `cli/hostModels.ts`. |
| Workspace routes/classes/entities are canonical ownership names | Work routes have no workspace selector. `Account`, `account_id`, account REST/MCP, and automation schedule names are canonical. Existing wire/route/file aliases are documented as compatibility. | `ownership.md`, entities, controllers, migration 0092, client routing. |
| An inline schedule targets a saved Agent ID | New inline schedules require `target_runtime`; the response's target ID is computed. Action-based schedules use `action_id`. QA/Security retain dedicated batch schedulers. | `AutomationSchedule.ts`, `automation-schedule.service.ts`. |
| sql.js automatically saves every write; production has synchronize off | sql.js persistence is batched and flushed on graceful shutdown. Current production configurations also enable synchronize; upgrades require backups. | `db.ts`, `DatabaseModule`, flush services. |
| Empty MCP keys implicitly enable development access | An explicit local bypass is required; MCP bypass is disabled in production and when active keys exist. Agent API has its own guard. | `shared/mcp-http-auth.ts`, `agent-auth.guard.ts`. |
| Compose root `.env` is the backend dotenv file | Source scripts load `apps/server/.env`; Compose substitutes root `.env` values and only forwards service-declared variables. | npm scripts, `main.ts`, `docker-compose.yml`. |
| A `main` merge deploys every installation; manager release uses version bumps | Server deployment depends on the operator/image. Manager source/publish changes trigger npm publishing; the version is computed and not committed back. | `.github/workflows/`, Docker/Compose, manager version-computation script. |
| Global skill updates change an Agent assignment; sql.js lacks partial indexes | Runtime assignments pin immutable versions by `runtime_key`. Entity-declared partial indexes enforce Global/Account slug uniqueness in both supported databases. | `Skill.ts`, `RuntimeSkillAssignment.ts`, built-in skill service. |

README now includes two installation routes, initial administration, pairing,
first-session/ticket/mission walkthroughs, MCP connection, configuration,
backup/update instructions, troubleshooting, developer commands, and a document
map. Unsupported fixed tool counts and the unverified manager Docker-image
installation recipe were removed.

## Validation

- `npm run build`: all three workspaces succeeded (client/server cache hits,
  manager compiled). Validation environment: Node 24.14.1, npm 11.11.0; the Node
  22.12 prerequisite is derived from dependency engine requirements.
- Isolated compiled-server smoke: temporary absolute SQLite paths/data directory;
  `/api/health` healthy, fresh `/api/auth/setup-status`, built UI, Swagger, and
  unauthenticated `/mcp` rejection verified. Graceful termination wrote both
  SQLite files. Temporary files were removed; existing data was not used.
- Compiled manager `--help`: pairing/account/service options checked against
  the updated examples.
- Local Markdown links/anchors in changed documents and `git diff --check`
  checked before completion.

Docker/PostgreSQL deployment and live paid CLI/provider execution were not run
for this documentation change. Operational examples were checked against the
repository configuration/source; this audit does not certify an external image,
host installation, or the historical plans' proposed features.
