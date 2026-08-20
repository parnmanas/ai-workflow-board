---
name: Parallel work safety
description: Avoid clobbering another agent working the same repo, ticket, or folder.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Parallel Work Safety

Multiple agents run at once. Two of them editing the same working tree produces
corruption that neither can diagnose from inside its own session, because each
sees only its own edits plus inexplicable changes.

## Before you start writing

- **Check the ticket is yours.** An in-flight ticket with recent activity from
  another agent means someone is already on it. Say so rather than racing.
- **Check the working folder.** If your run was provisioned a folder, use that
  one. Do not reach into a sibling agent's checkout.
- **Prefer a branch.** Never commit directly to the default branch.

## While working

- Re-read a file immediately before editing it if significant time has passed.
  Another process may have changed it under you.
- If a file you did not touch has unexpected modifications, stop and report it.
  That is evidence of a second writer, not something to work around.
- Do not `git checkout`, `reset --hard`, or `clean` a shared tree. Those
  destroy another agent's uncommitted work with no recovery.

## Shared external state

Databases, queues, and running services are shared too. A test that drops a
table or a fixture that assumes an empty database will fail whoever else is
running. Scope your fixtures — unique ids, isolated schemas, temp directories.

## When you detect a collision

Report it explicitly: what you expected, what you found, and what you did NOT
do because of it. A collision that is worked around silently becomes a data
loss report from someone else later.
