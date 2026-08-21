---
name: Defensive boundaries
description: Validate at the edges, trust inside. Know which code you are writing.
version: 1.0.0
author: AI Workflow Board
license: MIT
---

# Defensive Boundaries

Defensive checks scattered through internal code hide bugs: a swallowed
`?? []` turns "the query was wrong" into "there was no data", and the wrong
query survives to production. Validation belongs at the boundary, where
untrusted data enters.

## Boundaries — validate hard, fail loudly

- HTTP request bodies and query parameters
- Tool / RPC arguments from an external caller
- Parsed files, JSON columns, environment variables
- Third-party API responses

Here: check types, reject with a specific error, and say which field was wrong.
A boundary that accepts garbage and normalizes it silently is how impossible
values get into the database.

## Inside — trust the types, assert the invariants

Once past the boundary, a value that the type system says is a `string[]` is a
`string[]`. Re-checking it everywhere adds noise and makes the real boundary
harder to find.

Where an invariant genuinely matters, **assert** it — throw — rather than
quietly coercing. A crash with a clear message is diagnosable; a default value
substituted at 3 a.m. is not.

```ts
// Boundary: reject
if (!Array.isArray(body.labels)) throw badRequest('labels must be an array');

// Inside: assert, don't coerce
if (!skill.workspace_id && scope === 'workspace') {
  throw new Error('invariant: workspace scope requires a workspace_id');
}
```

## The failure mode to avoid

```ts
const rows = await repo.find({ where }) ?? [];   // the ?? hides a broken query
return rows.map(...) // ...and the page renders empty instead of erroring
```

Empty-and-correct and empty-because-broken must not look the same to the
caller. If they can, log or distinguish them.

## Comment the choice

When you *do* defend inside — because the value crosses a real trust boundary
that is not obvious from the call site — say so in a comment. Otherwise the
next reader deletes it as redundant, or copies it as a style.
