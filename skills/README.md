# AWB built-in global skill pack

Every `SKILL.md` under this directory is seeded into AWB's **global** skill
scope (`Skill.workspace_id = NULL`) when the server boots, so a fresh install
comes up with a usable skill set without network access or any operator action.

```
skills/<category>/<slug>/SKILL.md      ← the skill body (required)
skills/<category>/<slug>/<anything>    ← optional support files
```

The directory name is the **slug**, and it must match `[a-z0-9][a-z0-9-]{0,63}`.
This is the same layout Claude Code (`.claude/skills/`), the Hermes skill hub
and Warp's bundled skills use — deliberately, so a repository published for one
of those runtimes can be consumed by AWB as a *tap* without modification.

## Frontmatter

```yaml
---
name: Systematic debugging
description: One line. Shown in listings and used to decide relevance.
version: 1.0.0
author: AI Workflow Board
license: MIT
---
```

`name` / `description` / `version` / `author` / `license` are read; everything
else (`platforms:`, `metadata:`, …) is ignored rather than rejected, so files
carrying another runtime's metadata load unchanged. Only top-level scalars are
parsed — AWB does not run a YAML engine over third-party frontmatter.

## How updates reach a running server

Seeding is **idempotent** and **append-only**:

- Content is hashed (body + support files). If the hash matches the skill's
  current head version, nothing is written — so re-seeding on every boot is
  free.
- A change publishes a **new immutable `SkillVersion`**. Existing versions are
  never edited or deleted.
- Every `AgentSkillAssignment` pins a specific `skill_version_id`, so an update
  never changes what an already-assigned agent runs. Re-point the assignment
  when you are ready.
- A skill an operator **quarantined** is skipped. An upgrade never revives it.
- A global slug already owned by a *tap* or by a hand-authored (`local`) skill
  is reported as a conflict and left alone.

So: **upgrade the AWB server → the pack updates.** That is the whole "always
latest" mechanism; there is no runtime fetch in the boot path.

## Managing the pack in your own repository

Point `AWB_BUILTIN_SKILLS_DIR` at any directory with this layout — typically a
git checkout you pull on your own schedule:

```bash
AWB_BUILTIN_SKILLS_DIR=/srv/our-skills
```

Set `AWB_SKIP_BUILTIN_SKILLS=1` to disable seeding entirely.

For registries that should be tracked continuously, register a **skill tap**
(admin → skill registry) instead: a git repo + ref + subdirectory that AWB
clones and syncs on demand. Taps are **disabled by default** and never sync at
boot — a skill body becomes agent-facing prompt text, so pulling one from a
third-party repository is an explicit operator decision. Use `dry_run` first.

## Workspace forks

A workspace skill **shadows** a global one with the same slug (the precedence
`WorkflowFunction` uses for its key). To diverge from a built-in, fork it into
the workspace — the global keeps receiving upstream updates underneath, and the
fork keeps winning. Editing the global in place is not the way to customize.

## Attribution

Skills adapted from other projects keep their upstream `author:` and `license:`
frontmatter. See each file.
