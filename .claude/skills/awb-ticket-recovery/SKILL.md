---
name: awb-ticket-recovery
description: Recover an AWB ticket that is stuck or never dispatching. Use when a ticket sits in an active column (In Progress, To Do) with no agent activity, was created directly in a terminal column (Done), shows only a "created" activity right after creation, or when you suspect two agent instances are working the same ticket.
---

# AWB Ticket Recovery Runbook

Dispatch is **edge-triggered on column entry**: an agent is triggered only at the moment a ticket *enters* an active column. There is no level-based re-dispatch. Every stuck-ticket symptom below follows from that.

## Symptom → Fix

### 1. Ticket parked in an active column (e.g. In Progress) with no live worker
The dispatch trigger was consumed when the ticket entered the column, and the worker died (crash, kill, exit 143). The ticket will **not** re-dispatch on its own.

**Fix:** `move_ticket` → **To Do** to re-enter an active column and fire a fresh edge. Do not wait — there is nothing to wait for.

### 2. Ticket created in a terminal column (e.g. Done)
A ticket born in a terminal column never fires the assignee loop. It sits silently forever.

**Fix:** `move_ticket` → an active, role-routed column (To Do / In Progress).

### 3. Ticket just created, only a "created" activity, no agent yet
**Not a failure.** Dispatch after create is asynchronous via supervisor poll, ~10–15 s. Check `get_ticket_activity` again after ~20 s before doing anything.

## Before touching a stuck ticket: duplicate-instance check

One ticket can have **two instances running concurrently** (duplicate dispatch). Before editing files or re-triggering:

1. `git log --oneline -10` on the ticket's branch — fresh commits you didn't make mean another instance is alive.
2. `get_ticket` — check current column and recent comments for another worker's activity.

If a twin is active, do **not** clobber its work or hand off the ticket a second time. Let the live instance finish, or coordinate via a ticket comment.

## Quick decision table

| Observation | Action |
|---|---|
| Active column, no worker, trigger long past | `move_ticket` → To Do (new edge) |
| Created in Done/terminal column | `move_ticket` → active column |
| Created <20 s ago, "created" activity only | Wait — normal async dispatch |
| Recent unexplained commits/comments | Twin instance — stand down, coordinate |
