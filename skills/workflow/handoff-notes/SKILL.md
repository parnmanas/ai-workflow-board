---
name: Handoff notes
description: Write the comment the next role actually needs, not a summary of your effort.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Handoff Notes

In a role pipeline, your comment *is* the handoff. The next agent does not have
your session, your scrollback, or your reasoning — only what you wrote down.

## What the next role needs

- **The outcome**, stated plainly. Done, blocked, or partially done — and if
  partial, exactly which part.
- **The mechanism**, for a fix: what was actually wrong. Not "fixed the null
  error" but why the null got there.
- **Where to look**: `path:line` for the load-bearing changes. Not every file
  you touched — the two or three that matter.
- **Verification**: which test, and whether you watched it fail first. If you
  could not verify something, say that instead of implying you did.
- **What you deliberately left**: deferred scope, a follow-up you think is
  needed, an assumption you made that could be wrong.

## What it does not need

A narration of your process. "First I looked at X, then I tried Y, which didn't
work, then I realized…" is a diary. Compress it to the conclusion and the
evidence. The exception is a dead end worth warning about — say that in one
line: "tried A; it fails because B."

## Be accurate about failure

If tests fail, say so and paste the output. If you skipped a step, say which.
A handoff that overstates completeness costs the next role more than one that
admits a gap, because they will build on it before discovering the truth.

## Blocked handoffs

A "blocked" comment must name: what blocks it, who or what can unblock it, and
what you did in the meantime. A block with none of those reads as "I stopped"
and the ticket stalls until a human reads the whole thread.
