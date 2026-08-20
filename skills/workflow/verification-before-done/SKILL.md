---
name: Verification before done
description: Move a ticket to Done only with evidence that the change works, not that it compiles.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Verification Before Done

"Done" is a claim other people build on. Making it without evidence transfers
your uncertainty to everyone downstream, where it is more expensive.

## The bar

A green build is a **precondition**, not verification. It proves the code
parses and the existing tests still pass — neither of which is what you
changed.

Verification means: **you observed the new behavior happen.**

## What counts

- A test you added that fails on the previous revision and passes on this one.
  Actually check both directions; a test written after the fix that has never
  seen the bug proves nothing.
- The reproduction from the bug report, re-run, now behaving correctly.
- For UI: the actual screen, not the component's unit test.
- For a wiring or contract change: the end-to-end path, not the unit that was
  easiest to test.

## What does not count

- "The types check."
- "The build passes."
- "It should work now."
- A test that passes both before and after your change.

## Report it honestly

State what you verified and how. If part of the change is unverified — an edge
case you could not reproduce, a platform you cannot run — say so explicitly
rather than letting "done" imply full coverage. A named gap gets handled; an
unnamed one gets discovered in production.

If something is still failing, say so with the output. A ticket moved to Done
with a red test is a defect in the handoff, independent of the code.
