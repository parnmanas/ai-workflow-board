---
name: Test-driven development
description: Test first, watch it fail, then write the minimum code that passes.
version: 1.0.0
author: AI Workflow Board (pattern adapted from obra/superpowers)
license: MIT
---

# Test-Driven Development

## The rule

```
NO PRODUCTION CODE UNTIL A TEST FAILS FOR THE RIGHT REASON
```

The point is not coverage. The point is that a test you never watched fail has
not been shown to test anything.

## The cycle

**RED** — write one test that expresses the behavior you want. Run it. Read the
failure message and confirm it fails *because the behavior is missing*, not
because of a typo, a missing import, or a bad fixture. This is the step people
skip and it is the step that carries all the value.

**GREEN** — write the least code that makes it pass. Not the general solution;
the specific one. Resist designing here.

**REFACTOR** — now clean it up, with the test holding the behavior still. Run
the test after every structural change, not once at the end.

## When you are fixing a bug

The regression test is written **before** the fix and must fail against the
unfixed code. If you have already written the fix, stash it, write the test,
confirm it fails, then restore the fix. A regression test that has never seen
the bug is decoration.

Verifying this is cheap and it is the difference between a test suite that
catches regressions and one that only reports its own opinions.

## Exceptions

Genuine ones: throwaway spikes you will delete, generated code, pure config.

Not exceptions: "it's a one-line change", "it's obviously correct", "the test
would be harder than the fix", "I'm short on time". Each of those is the
reasoning that produced the bug you are currently fixing.

## In AWB

- Find the project's own test command before inventing one, and check whether
  its suite runs against compiled output — if it does, build first or you will
  be testing the previous revision and reading its green as yours.
- Say in your ticket comment which test you added and that you saw it fail
  first. "Tests pass" alone does not tell the reviewer whether the test is
  load-bearing.
