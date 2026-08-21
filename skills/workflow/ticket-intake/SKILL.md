---
name: Ticket intake
description: The first five minutes on a ticket — read the whole record before touching code.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Ticket Intake

Most rework on a ticket traces back to starting before reading. The record
usually contains the answer to the question you are about to guess at.

## Read first, in this order

1. **The ticket description**, end to end. Including the parts that look like
   boilerplate.
2. **Every prior comment**, oldest first. A previous role has often already
   investigated, hit a wall, and written down why.
3. **Linked tickets and prerequisites.** A blocked prerequisite changes what
   "done" means for you.
4. **The activity history.** Who moved this, when, and from where. A ticket
   that has bounced between two columns three times has a disagreement in it
   that no comment states outright.

## Then establish the ground truth yourself

Do not ask a question the repository can answer. Check the code, the git
history, the tests. Investigate first; ask only when a genuine decision remains
that the codebase cannot settle — a product choice, a tradeoff between two
valid designs, or missing external context.

When you do ask, ask one specific question with your recommended answer
attached, and keep working on everything that does not depend on it.

## State your interpretation

Before doing substantial work, post a short comment: what you understand the
task to be, what you are assuming, and what you plan to do. This is the cheapest
possible moment to be corrected. After the implementation it costs a rewrite.

## Scope

Deliver what was asked. If you find a real problem with the request as
specified, say so in a sentence or two and then build it anyway under stated
assumptions — narrowing the scope is the reporter's call, not yours.

If part of the work turns out to be blocked, finish every other part and say
explicitly what you left out and why.
