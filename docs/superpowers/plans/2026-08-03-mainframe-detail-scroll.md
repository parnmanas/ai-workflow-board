# Mainframe Detail Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI Agents Mainframe detail pane vertically scrollable so every managed-agent row remains reachable.

**Architecture:** Keep the two-pane layout and the left Runtime Host scroll viewport unchanged. Turn the right detail column into a flex shell with a dedicated, marked scroll viewport around `InstanceDetail`; let the detail content use natural vertical height inside that viewport.

**Tech Stack:** React, TypeScript, inline CSS, Node.js test runner

## Global Constraints

- The entire right Mainframe detail pane scrolls; the managed-agent list does not get a separate scrollbar.
- The mobile Back button remains outside and above the detail scroll viewport.
- Data loading, commands, and left-pane behavior remain unchanged.

---

### Task 1: Add and verify the Mainframe detail scroll viewport

**Files:**
- Modify: `apps/client/test/mainframe-agent-list-scroll.test.mjs`
- Modify: `apps/client/src/components/admin/AgentManagerPage.tsx`

**Interfaces:**
- Consumes: `InstanceDetail` and the existing right detail-pane flex column.
- Produces: one DOM viewport marked `data-testid="mainframe-detail-scroll"` with `flex: 1`, `minHeight: 0`, `overflowY: 'auto'`, and `overflowX: 'hidden'`.

- [x] **Step 1: Write the failing regression test**

Add an assertion that locates `data-testid="mainframe-detail-scroll"` and requires the scroll ownership properties. Also require the Back button to appear before the viewport and require `InstanceDetail` to use natural height rather than `height: '100%'`.

```js
test('Mainframe detail pane owns vertical scrolling without trapping the mobile Back button', () => {
  assert.match(
    agentManagerPageSource,
    /data-testid="mainframe-detail-scroll"[\s\S]*?flex:\s*1,[\s\S]*?minHeight:\s*0,[\s\S]*?overflowY:\s*'auto',[\s\S]*?overflowX:\s*'hidden'/,
  );
  assert.ok(
    agentManagerPageSource.indexOf('Back to agents') <
      agentManagerPageSource.indexOf('data-testid="mainframe-detail-scroll"'),
  );
  assert.match(
    agentManagerPageSource,
    /function InstanceDetail[\s\S]*?display:\s*'flex',\s*flexDirection:\s*'column',\s*gap:\s*16,\s*minHeight:\s*'100%'/,
  );
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test apps/client/test/mainframe-agent-list-scroll.test.mjs`

Expected: the new test fails because `mainframe-detail-scroll` does not exist.

- [x] **Step 3: Implement the minimal viewport change**

Wrap the selected/empty detail content in the marked viewport while leaving the mobile Back button as its preceding sibling.

```tsx
<div
  data-testid="mainframe-detail-scroll"
  style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
>
  {selected ? <InstanceDetail ... /> : <div ...>...</div>}
</div>
```

Change the `InstanceDetail` root from fixed height to natural content with a viewport-height floor:

```tsx
<div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: '100%' }}>
```

- [x] **Step 4: Run focused and client verification**

Run:

```powershell
node --test apps/client/test/mainframe-agent-list-scroll.test.mjs
npm --workspace apps/client test
npm --workspace apps/client run build
```

Expected: all commands exit successfully.

- [x] **Step 5: Commit the implementation and plan**

```powershell
git add -- apps/client/test/mainframe-agent-list-scroll.test.mjs apps/client/src/components/admin/AgentManagerPage.tsx docs/superpowers/plans/2026-08-03-mainframe-detail-scroll.md
git commit -m "fix(client): scroll Mainframe detail pane"
```
