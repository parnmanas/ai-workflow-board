---
name: Commit messages
description: Write the why. The diff already carries the what.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Commit Messages

The reader of a commit message is someone six months from now trying to work
out whether they may change this line. They can already see what changed.

## Subject

One line, imperative, under ~72 characters, naming the effect:

```
fix(skills): global skills dropped from a run's pinned manifest
```

Not `fix bug`, not `update service.ts`, not `address review comments`.

## Body

Answer, in this order:

1. **What was wrong / what was missing** — the observable problem.
2. **Why it happened** — the mechanism. This is the part with the long shelf
   life.
3. **What this change does about it**, and any alternative you rejected.
4. **How it was verified**.

Wrap at ~72 columns. Reference the ticket and any file that carries the real
logic.

## Things that belong in the body

- A constraint that is not visible from the code ("Postgres treats NULLs as
  distinct, so the composite unique index does not constrain global rows").
- A deliberate omission and why.
- A workaround and the condition under which it can be removed.

## Things that do not

- A list of files changed. That is the diff.
- "Various fixes." If the message needs "various", the commit needs splitting.
- Apologies, or a narration of your process.

## In AWB

Commit or push only when asked. If you are on the default branch, branch first.
