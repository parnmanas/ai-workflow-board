# AI-First Claude Backend UI Design

**Date:** 2026-07-29  
**Status:** Awaiting written-spec review

## Purpose

Claude backend profiles are configured primarily by an AI running on the same
computer as the Agent Manager. A person should not need to understand profile
IDs, credential UUIDs, adapter JSON, or inheritance internals to confirm which
backend is active and decide where it applies.

The UI becomes an operational status and control surface supporting both:

1. a local AI configuring profiles directly through existing server contracts;
2. a person starting a configuration conversation with **Ask AI to configure**.

The existing profile schema, protocols, adapter contract, credential storage,
and Run > Agent > Board > Workspace > Global resolution order remain
authoritative.

## Product Principles

- Show what is active before showing how it is stored.
- Use recognizable terms: backend, model, endpoint, credential, and scope.
- Keep raw identifiers and JSON behind a collapsed advanced section.
- Preserve the declarative profile contract so new local servers and adapters
  do not require another page redesign.
- Do not add server-side endpoint discovery, model discovery, or an installation
  wizard. The local AI owns discovery and configuration.
- Never imply that a stored profile is reachable without runtime evidence.

## Information Architecture

The existing **Claude Profiles** route remains canonical and contains four
sections.

### Page introduction

Title: **Claude backend**

Description:

> Local AI can configure the model connection used by Claude. Review what is
> active here and choose where it applies.

The primary action, **Ask AI to configure**, opens the existing Workspace
assistant/chat with a prefilled request containing:

- active Workspace ID and name;
- available profile summaries;
- global and Workspace defaults;
- an instruction to inspect the Agent Manager host, configure or update an
  appropriate profile through AWB's existing API, assign it to the Workspace,
  and report what changed.

If no Workspace assistant is assigned, the action opens a handoff dialog with
the generated request, **Copy request**, and a link to assign an assistant. This
supports any local AI without introducing another chat system.

### Current backend

The first card answers: "What will a newly started Claude session use?"

It shows:

- profile name, or **Native Anthropic**;
- model and endpoint host;
- effective source: Global or Workspace;
- compact usage counts for Workspace, Board, Agent, and Run references;
- configuration status.

Configuration status is deliberately conservative:

- **Native**: no custom profile is selected.
- **Configured**: the profile is stored and any required credential is present.
- **Needs credential**: the profile requires a credential but none is bound.

Every custom profile also displays **Runtime not verified**. This iteration does
not add a connection-test endpoint, so **Connected** or **Ready** must not be
displayed.

Actions:

- **Change Workspace default**
- **Use Native Anthropic**
- **View advanced settings**

### Available backends

Each profile is one compact card containing:

- display name;
- protocol;
- model;
- shortened endpoint;
- credential state;
- scope chips;
- global and Workspace default markers.

Selecting a card opens a detail panel without mutating state. Its actions are:

- **Use as Workspace default**
- **Allow in this Workspace** / **Remove from this Workspace**
- **Edit advanced settings** for administrators
- **Delete** for administrators, retaining the existing impact check

Creating or updating a profile triggers one authoritative page reload so the
global catalog and Workspace assignment list update together. A browser reload
must never be required.

### Advanced settings

Advanced settings are collapsed by default and use a responsive single-column
drawer or panel.

Human-readable controls:

- Name
- Protocol
- Model
- Base URL
- Credential selector
- Credential required

The credential selector lists compatible credentials by name and provider. It
never asks for a UUID.

Raw controls are grouped under **Raw adapter configuration**:

- Stable ID
- Adapter JSON

The UI explains that raw controls are normally managed by local AI. Adapter JSON
appears only for OpenAI-compatible profiles. Stable ID is editable during manual
creation and immutable afterwards, matching the server contract.

## Visual Direction

The page retains AWB's dark application shell and token system. Its signature
element is the effective-backend card, visually modeled as a compact runtime
routing card rather than a generic settings form.

Hierarchy:

1. current backend and effective source;
2. Ask AI to configure;
3. available backends;
4. advanced implementation details.

Status uses existing semantic colors plus visible text. Endpoint and model
values use a utility/monospace treatment only where it improves scanning. No new
font or external visual dependency is added.

The layout becomes one column below 900 px. No component may impose a minimum
width that overflows the application main area at a 1280 px viewport with the
primary sidebar open. Keyboard focus remains visible and status never relies on
color alone.

## Component Boundaries

### `ClaudeBackendProfilesPage`

Owns loading and mutation state for the global catalog and active Workspace
assignments. It loads and normalizes all profile data, derives the effective
backend, coordinates one authoritative refresh, renders error/empty states, and
builds the AI request.

### `EffectiveClaudeBackendCard`

Pure presentation component receiving a resolved display model and emitting
intent callbacks. It performs no API calls.

### `ClaudeBackendProfileList`

Renders profile summaries and selection state from the page-owned catalog.

### `ClaudeBackendProfileDetails`

Renders Workspace scope actions and administrator actions for one selected
profile.

### `ClaudeBackendAdvancedEditor`

Contains the manual editor, consumes named credential options, and keeps raw
adapter JSON behind protocol-aware disclosure.

### `ClaudeBackendAiHandoff`

Builds and presents the generated request. It navigates to existing assistant
chat or provides copy/assignment actions when no assistant exists.

## Data Flow

1. Load the global catalog/default and Workspace assignment/catalog responses.
2. Normalize them into one client view model keyed by profile ID.
3. Derive the effective Workspace backend from Workspace then global defaults;
   `none` resolves to Native Anthropic.
4. Complete a profile or assignment mutation through existing APIs.
5. Perform one authoritative reload and provide the same catalog to every
   section.
6. Build the AI request from that normalized state.

Board, Agent, and Run override editors remain in their existing locations.
Their copy links to the canonical page and selectors display profile names
rather than raw IDs.

## Error and Empty States

- No profiles: display Native Anthropic and invite AI configuration.
- Catalog load failure: clear stale success state, show **Backend profiles could
  not be loaded**, and provide **Retry**.
- Workspace assignment failure: keep the catalog read-only and explain that
  Workspace scope could not be loaded.
- Mutation failure: retain the current selection and show the actionable server
  error.
- Missing assistant: open AI handoff rather than disabling the primary action.
- Missing required credential: show **Needs credential** and **Choose
  credential**.
- Concurrent delete/replacement: reload authoritative data and clear invalid
  local selection.

## Permissions

- System administrators create, edit, delete, and set the global default.
- Workspace owners allow profiles and set the Workspace default.
- Other Workspace members view assigned profiles and the effective backend but
  receive no mutation controls.
- AI handoff never bypasses authorization; an AI applying the request must use
  an identity accepted by existing server contracts.

## Testing Strategy

Client tests cover:

- Native Anthropic empty state;
- effective global, Workspace, and explicit `none` derivation;
- credential states without UUID exposure;
- protocol-aware advanced disclosure;
- immediate Workspace availability after profile save;
- assistant navigation with generated request;
- fallback handoff without an assistant;
- admin/owner/member action visibility;
- responsive structure without fixed two-column minimum widths;
- profile names in Agent and Board selectors.

Existing server integration and Agent Manager runtime tests must continue to
pass. Completion also requires a full client build and browser review at 1280
px and a narrow viewport.

## Out of Scope

- Automatic endpoint or model discovery by the AWB server
- Model-server installation
- A new chat system
- Runtime health polling or connection testing
- Claude backend database schema changes
- Dispatch precedence changes
- Adapter process-supervision changes

## Acceptance Criteria

1. A person understands the effective backend without opening advanced settings.
2. The default path contains no UUID or required JSON entry.
3. A stored credential can be selected by name.
4. **Ask AI to configure** always provides an actionable path.
5. A new profile immediately appears in Workspace assignment.
6. The page does not overflow at 1280 px with the sidebar open and becomes one
   column below 900 px.
7. Existing backend resolution and Agent Manager runtime behavior remain
   unchanged.
