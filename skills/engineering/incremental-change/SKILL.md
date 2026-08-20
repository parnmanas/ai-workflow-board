---
name: Incremental change
description: Keep the tree working after every step, so a failure localizes itself.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Incremental Change

A change that touches thirty files and is verified once at the end gives you
one bit of information: it works, or it does not. When it does not, you have
thirty suspects.

## Work in steps that end green

Each step should leave the repository buildable and the tests passing. Then a
failure names its own cause — it was introduced by the step you just took.

For a migration or a sweep, this usually means:

1. Add the new path alongside the old one. Verify.
2. Move callers over in batches, verifying each batch.
3. Delete the old path once nothing references it. Verify.

Not: change the shape everywhere and fix the compile errors until they stop.

## Commit boundaries

One commit per idea, each one independently revertable. A commit that mixes a
behavior change with a rename means a revert either loses the fix or keeps the
rename — and reviewers cannot see the logic through the churn.

Order them so the risky commit is small and last, where it is easy to roll
back alone.

## Verify at the step, not at the end

Running the suite once at the end is not "saving time", it is deferring the
information you need to work efficiently. Run the narrow test for the step, and
the full suite at natural checkpoints.

## When a step fails

Stop and fix it before taking the next one. Stacking a second change on a
broken tree is how a one-hour debug becomes a day: now you cannot tell which
change caused what, and reverting costs you both.
