---
name: Systematic debugging
description: Find the root cause before proposing any fix. Four phases; no patch leaves phase one.
version: 1.0.0
author: AI Workflow Board (pattern adapted from obra/superpowers)
license: MIT
---

# Systematic Debugging

A symptom fix is a failure, even when the symptom disappears. It leaves the
cause in place, and the next occurrence is harder to diagnose because the
evidence has been altered.

## The rule

```
NO FIX WITHOUT A ROOT CAUSE THAT EXPLAINS EVERY OBSERVED SYMPTOM
```

If your explanation accounts for the crash but not the warning three lines
above it, you do not have the root cause yet.

## Phase 1 — Reproduce

Do not read code yet. Get the failure to happen on demand.

- Write down the exact command, input, and environment that triggers it.
- Establish the failure rate. "Sometimes" is a measurement, not a description:
  run it ten times and record the count.
- If you cannot reproduce it, say so explicitly and switch to evidence
  gathering (logs, activity history, the ticket's prior comments). Never guess
  a fix for something you have never seen fail.

## Phase 2 — Locate

Narrow until you can point at one function or one boundary.

- Bisect: git history, feature flags, input size, config values.
- Instrument rather than infer. Add a log line, run it, read the output.
- Check the boundary first — serialization, scope filters, null handling, and
  type coercion between two layers produce most "impossible" bugs.

## Phase 3 — Explain

State the mechanism in one or two sentences, in terms of the code path.

> "`resolve()` filters versions by `workspace_id`, but a global skill's
> versions carry NULL, so the assigned skill is dropped from the manifest."

Then check it against **every** symptom you collected in Phase 1. A cause that
explains three of four symptoms is the wrong cause, or there are two bugs.

## Phase 4 — Fix and prove

- Write the failing test **first**, and watch it fail for the reason you
  predicted. A test that passes before your fix was testing the wrong thing.
- Apply the narrowest change that removes the cause.
- Re-run the Phase 1 reproduction. Ten times, if the failure was intermittent.
- Check for the same mistake elsewhere: `grep` for the pattern. A boundary bug
  is rarely alone.

## In AWB

- Post the mechanism (Phase 3) as a ticket comment before the fix comment. The
  next role needs the cause, not just the diff.
- If the cause turns out to be in another component, do not silently widen your
  ticket. State it, and let the reporter decide whether to split.
- `.claude/skills/awb-ticket-recovery` covers the specific case of a ticket
  that never dispatches — check it before debugging the agent loop by hand.
