---
name: Requesting code review
description: Hand a reviewer the context they need to find real problems instead of re-deriving your change.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Requesting Code Review

A reviewer's time goes to whichever question is hardest to answer. If that
question is "what does this change even do", they will not get to "is it
correct".

## Before you request

- Re-read your own diff top to bottom. Roughly half of what a reviewer would
  have caught is visible on a second read.
- Remove debug output, commented-out code, and unrelated formatting churn.
  Unrelated noise is the single biggest tax on review attention.
- Run the tests and record the result. Do not request review on a red build
  without saying it is red and why.

## What the request must contain

1. **What changed and why**, in two or three sentences. The *why* is the part
   the diff cannot show.
2. **The mechanism**, if this is a bug fix — the root cause, not the symptom.
3. **How you verified it.** Which test, and whether you watched it fail before
   the fix. "Tests pass" is not verification; it is a precondition.
4. **What you are unsure about.** Naming your own weak spot is the highest
   value sentence in the whole request, and reviewers reliably go there first.
5. **What you deliberately did not do**, and why — scope you left out, a
   follow-up you think is needed.

## Scope

One reviewable idea per request. If you cannot describe the change without the
word "and", consider whether it should be two.

A large change is sometimes correct and unavoidable. When it is, order the
commits so each one is independently readable and say which one carries the
real logic.

## In AWB

Post the summary as a ticket comment before moving the ticket to the review
column — the reviewer agent reads comments, not your working memory. Include
file paths as `path:line` so they are clickable.
