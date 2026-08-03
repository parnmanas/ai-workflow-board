# Agent Column State Synchronization Implementation Plan

**Goal:** Ensure every agent-facing ticket path carries authoritative current-column state and prevent stale persistent sessions from reacting to generic move notifications.

**Architecture:** Enrich the canonical ticket loader and both SSE payloads with one flat column snapshot. Render it in fresh/reused prompts, and let targeted post-move triggers replace broad move fan-out.

**Tech Stack:** NestJS, TypeORM, TypeScript, Node test runner.

### Task 1: Lock the ticket and SSE contracts

- Add failing regression tests for `loadTicketFull`, `board_update`, and `agent_trigger` column fields.
- Run the focused tests and confirm failure.
- Add the minimal TypeORM resolution and map/flatten fields.
- Re-run focused tests and build the server.

### Task 2: Lock persistent-session behavior

- Add failing tests proving prompts show the authoritative current column and `ticket.moved` is not broadcast to existing sessions.
- Run the focused test and confirm failure.
- Add current-column prompt rendering and move suppression while preserving non-move fan-out.
- Re-run the focused test and build the agent-manager.

### Task 3: Verify and publish

- Run relevant server and agent-manager test suites and builds.
- Inspect the diff and repository status.
- Commit the implementation, synchronize with `origin/main`, push `main`, and verify local/remote commit equality.
