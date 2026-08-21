---
name: Root cause tracing
description: Trace a bad value backwards to where it was created, not where it exploded.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Root Cause Tracing

The place a program crashes is where a bad value was *used*. The bug is where
it was *produced*. Those are usually different files, often different layers.

## Method

1. **Capture the bad value exactly.** Not "it's undefined" — log the whole
   object, its type, and the id it belongs to.
2. **Walk one hop back.** Who passed this in? Log it there. Is it already
   wrong at that point?
3. **Repeat until the value is correct on entry and wrong on exit.** That
   function is the producer. Stop walking.
4. **Ask why the producer is allowed to do that.** A missing default? A scope
   filter that dropped the row? A serialization that turned an array into a
   string? The answer determines whether the fix belongs in the producer or in
   its contract.

## Fix at the source

Patching the consumer (`value ?? []`, an extra null check at the crash site)
makes the crash stop and leaves every *other* consumer broken. Ask: "if a
second caller reads this same producer tomorrow, does it get a correct value?"
If not, you have not fixed it.

The exception is a genuine boundary — parsing untrusted input, or a
deliberately optional field. There, defending at the consumer *is* the
contract, and it should be commented as such.

## Common producers

- A scope/tenant filter that silently excludes rows (the query returns `[]`
  rather than an error, so it looks like "no data" rather than "wrong query").
- A `.map()` projection that drops a field the renderer later needs.
- JSON columns read without parsing, so an array arrives as a string.
- A denormalized copy of a value that was never refreshed after the source
  changed.
