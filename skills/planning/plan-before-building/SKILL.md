---
name: Plan before building
description: Produce a reviewable plan for work whose shape is not yet obvious — then stop.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Plan Before Building

Planning is worth its cost when the design space is wide or the change is
expensive to undo. It is waste when the task is mechanical and the answer is
already known. Judge which one you have before spending the turn.

## When a plan earns its keep

- More than one defensible design, with different consequences.
- The change crosses components, contracts, or teams.
- Undoing it later would be expensive (schema, public API, stored data).
- Someone other than you will execute it.

## When it does not

- The path is obvious and reversible.
- A prototype would answer the question faster than an argument would.

## What a usable plan contains

1. **Goal** — the observable outcome, not the activity.
2. **Current state** — what exists now, verified by reading the code rather
   than assumed.
3. **Approach** — the chosen design, in enough detail that someone else could
   execute it without re-deriving it. Name files and functions.
4. **Alternatives considered** — and the specific reason each was rejected.
   Without this, the plan will be re-litigated by the first person who reads it.
5. **Risks and unknowns** — including what would make you abandon this
   approach.
6. **Verification** — how anyone will know it worked.

## Planning discipline

While planning, do not implement. Read the code, yes — write it, no. Mixing
the two produces a plan shaped by whichever file you happened to open first.

The plan is a proposal. Get it agreed before executing, and when execution
diverges from it — which is normal — say so rather than quietly rewriting the
plan to match what you did.
