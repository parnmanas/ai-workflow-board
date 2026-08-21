---
name: Receiving code review
description: Treat review findings as evidence to verify, not as orders to obey or noise to deflect.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Receiving Code Review

Two failure modes, and they are equally expensive:

- **Reflexive compliance** — applying every suggestion without checking. This
  ships wrong changes with a reviewer's name on them, and reviewers are wrong
  regularly.
- **Reflexive defense** — explaining why each finding does not apply. This
  wastes the review entirely.

The correct response to a finding is to **check it**.

## For each finding

1. **Understand the claim.** What concrete input produces the wrong output the
   reviewer describes? If you cannot state that, ask — do not guess at what
   they meant and fix something else.
2. **Try to reproduce it.** A test that fails is a confirmed finding. A test
   that passes is either a wrong finding or the wrong test; work out which.
3. **Then decide.** Fix it, or explain — with the evidence — why it does not
   hold. Both are complete responses. "Fixed" without a test, on a correctness
   finding, is not.

## Disagreeing well

Say what you checked and what you found. "This path is unreachable because the
guard at `service.ts:44` returns early for that case" ends a disagreement.
"I don't think that's an issue" starts one.

If you and the reviewer still disagree after both have evidence, escalate to
the person who owns the decision rather than iterating. Two more rounds of
comments rarely resolve a genuine judgment split.

## Scope

A review finding is not a licence to widen the change. If a reviewer points at
a real problem outside this ticket's scope, acknowledge it and raise it
separately — do not quietly grow the diff, and do not silently drop it either.

## In AWB

Reply in the ticket comment thread so the trail stays with the ticket. When you
have addressed everything, say explicitly which findings you fixed, which you
pushed back on, and which you deferred — a reviewer should never have to diff
your branch to find out.
