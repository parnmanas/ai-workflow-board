# Documentation

Start with the [main README](../README.md) for installation, host pairing, and
your first session, ticket, or mission. This index separates current feature
contracts from dated implementation plans and research.

## Current model

- Work opens at `/sessions`, `/tickets`, `/projects`, `/teams`, `/missions`, and
  `/chat`. Accessible accounts are combined; there is no workspace selector.
- Accounts own work and govern membership, credentials, execution policy, and
  budgets. New API integrations use `account_id` and `X-Account-Id`.
- Tickets use fixed statuses, tags, an optional Project, and one RuntimeSpec
  assignee. Projects represent repositories and their per-host main clone folders.
- Executions are declared by RuntimeSpec. Agent templates copy preferences;
  they are not execution identities. The old Agent table and CRUD are removed.
- Native CLI transcripts remain on Runtime Hosts. AWB persists session ownership
  and execution settings separately. Terminals are live processes only.

The ownership and ticket references below are the starting point when an older
document uses boards, configurable columns, workspace navigation, or Agent rows.

## Work and ownership

| Guide | Use it for |
| --- | --- |
| [Ownership](ownership.md) | Accessible-account lists, actual-owner authorization, creation defaults, session bindings, and compatibility. |
| [Tickets & Projects](tickets.md) | Fixed statuses, queue/dispatch, prerequisites, repository worktrees, REST/MCP, and server/manager events. |
| [Agent Sessions](agent-sessions.md) | Native history, live turns, credentials/config, interaction, images, restart, and session recovery. |
| [Orchestration](orchestration.md) | Team slots, missions, step plans, graph execution, confirmations, leases, and evidence. |
| [Catalog scopes](catalog-scopes.md) | Global/Account definitions, shadowing, scope changes, and credential visibility. |
| [Entity references](entity-references.md) | Canonical `#[type:id|name]` references in comments/chat and MCP results. |

## Runtime Hosts

| Guide | Use it for |
| --- | --- |
| [Manager quickstart](../apps/agent-manager/README.md) | Installation, pairing, background services, config, and local builds. |
| [Runtime Host reference](agent-manager.md) | Runtime policy, permissions, capabilities, CLI updates, process ownership, and self-update. |
| [CLI modules](cli-modules.md) | The CLI descriptor contract and the shared source of model/effort options. |
| [CLI runtime profiles](cli-runtime-profiles.md) | Backend/profile selection and pinned session settings. |
| [Hermes runtime](hermes-runtime.md) | ACP execution, delegated/swarm budgets, and runtime skill enforcement. |
| [Credential relogin](managed-agent-relogin.md) | Credential preparation and reauthentication for existing runtime homes. |
| [Worktree cleanup](worktree-orphan-cleanup.md) | Recovery and reclamation of ticket/run folders. |
| [Terminals](terminals.md) | Browser shells, PTY support, permissions, and process lifetime. |
| [Voice operator](voice-operator.md) | Speech engines, reports/questions, notifications, hands-free input, and implemented/future voice work. |
| [Self-hosted speech service](../services/voice-server/README.md) | The optional voice engine service. |

## Automation and quality

| Guide | Use it for |
| --- | --- |
| [Functions](functions.md) | Typed operations, their implementations, and run contracts. |
| [Automation schedules](automation-schedules.md) | Scheduled prompts/Actions, inline RuntimeSpec targets, UTC cadence, and cron migration. |
| [On-done Actions](on-ticket-done-action-hook.md) | Completion hooks, tag filters, prompt variables, and idempotency. |
| [QA scenarios](qa-scenarios.md) | Starter scenario catalogue and seeding. |
| [QA driver guide](qa-driver-guide.md) | Browser/game/API drivers and evidence capture. |
| [QA phases](qa-phases.md) | Per-phase timeout budgets. |
| [QA scheduler](qa-scheduler.md) | Scheduled scenario batches and overlap policy. |
| [Rerun on fix](qa-rerun-on-fix.md) | Failure tickets, bounded retries, and deployment-aware reruns. |
| [Security scheduler](security-scheduler.md) | Security batches, checklist refresh, schedules, and scan evidence. |
| [Skills](skills.md) | Immutable versions, runtime-key assignments, registry sync, quarantine, and proposals. |

## Development and operations

| Guide | Use it for |
| --- | --- |
| [Repository instructions](../AGENTS.md) | Constraints and conventions for implementation. |
| [Server modules](architecture/modules.md) | NestJS composition, shared services, and feature dependencies. |
| [Runtime plugin guide](agent-runtime-plugin-guide.md) | Adapter/plugin boundaries and CLI module registration. |
| [Runtime inventory](architecture/agent-runtime-inventory.md) | Runtime-refactor baseline and preserved execution paths; source counts are dated measurements. |
| [Account migration](runbooks/account-ownership-migration.md) | Pre-sync preparation, upgrade, preservation, and backup-based rollback. |
| [Manager release](runbooks/agent-manager-release.md) | Coordinated wire changes and automatically computed npm releases. |
| [CLI wiring](runbooks/cli-module-wiring.md) | Adding a CLI without duplicating runtime knowledge. |
| [MCP wiring](runbooks/mcp-tool-wiring.md) | Registration, authorization, ownership, and tool classification. |
| [Field wiring](runbooks/field-wiring.md) | Persisting/projecting ticket fields and SSE payloads. |
| [Display names](runbooks/agent-display-name.md) | Host/runtime labels and snapshot-carried names. |
| [Server QA tests](../apps/server/test/qa-flows/README.md) | QA suites and SQLite/PostgreSQL test execution. |
| [Client tests](../apps/client/test/README.md) | Client tests and browser smoke tests. |

See the [responsive UI audit](audit/2026-10-responsive-ui.md) for tested viewports, interaction checks, and browser test limits.

## Historical designs, research, and audits

These preserve decisions and observations **at their recorded date**. They may
include removed entities, menus, routes, or proposed work that never shipped.
Use the current contracts above and source code for present behavior; do not
apply an old plan as a new installation procedure.

- [Superpowers plans](superpowers/plans/) and [specifications](superpowers/specs/):
  implementation/design records from earlier versions.
- [Ticket hierarchy implementation plan](2026-04-07-ticket-hierarchy-and-comment-images.md)
  and [its design](2026-04-07-ticket-hierarchy-and-comment-images-design.md):
  April 2026 context; current ticket semantics are in [Tickets](tickets.md).
- [Runtime architecture ADR](adr/agent-runtime-plugin-architecture.md): decisions
  behind the runtime refactor, complemented by current CLI/plugin guides.
- [Ontology Graph design](ontology-graph/DESIGN.md), research, scouts, and review
  notes in [ontology-graph/](ontology-graph/): design evidence. The design's
  current-integration note explains Project IDs and Account ownership.
- [Audit records](audit/): findings and checks at a particular revision, including
  [the October documentation reconciliation](audit/2026-10-documentation-sync.md).

## Keeping documentation current

Update a feature's contract when its API, UI route, ownership, runtime selection,
or wire behavior changes. Check commands against workspace scripts and flags,
versions against manifests/lockfile, and URLs against controllers and `App.tsx`.
Keep old migration/index/wire names only when they are actual compatibility
contracts, and label them accordingly. Avoid fixed tool counts and duplicated
model lists; those are discovered from their registered sources.
