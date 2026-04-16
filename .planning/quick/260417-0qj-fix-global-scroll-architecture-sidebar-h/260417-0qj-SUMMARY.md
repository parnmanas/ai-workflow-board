---
phase: 260417-0qj
plan: 01
subsystem: client-layout
tags: [css, layout, scroll, fix]
dependency_graph:
  requires: []
  provides: [viewport-locked-shell-layout]
  affects: [all-pages-using-awb-shell]
tech_stack:
  added: []
  patterns: [viewport-locked-app-shell, overflow-containment]
key_files:
  created: []
  modified:
    - apps/client/src/main.tsx
    - apps/client/src/components/ChatPage.tsx
decisions: []
metrics:
  duration: 40s
  completed: "2026-04-16T15:34:23Z"
---

# Quick Task 260417-0qj: Fix Global Scroll Architecture (Sidebar/Header Fixed)

**One-liner:** Lock .awb-shell to viewport height so sidebar and header stay fixed while only .awb-content scrolls.

## What Changed

### Task 1: Fix .awb-shell and .awb-content CSS in main.tsx (56c0cb5)

Changed `.awb-shell` from `min-height: 100vh` to `height: 100vh` + `overflow: hidden`, which locks the outer shell to the exact viewport size and prevents any scroll on it. Changed `.awb-content` from `overflow: hidden` to `overflow-y: auto` so the main content area becomes the single scroll container. `.awb-main` was left unchanged as it already had correct styles.

**Files modified:** `apps/client/src/main.tsx`

### Task 2: Ensure ChatPage overflow containment (9a5f886)

Added `overflow: 'hidden'` to both the mobile and desktop root `<div>` containers in ChatPage. Added `flex: 1` and `overflow: 'hidden'` to the `<Group>` component so it fills available space without exceeding its container. Inner panels (ChatRoomListPanel, ChatRoomView) already had their own independent scroll behavior via `overflowY: 'auto'`.

**Files modified:** `apps/client/src/components/ChatPage.tsx`

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Commits

| Task | Commit    | Description                                            |
|------|-----------|--------------------------------------------------------|
| 1    | `56c0cb5` | fix(260417-0qj): lock .awb-shell to viewport height   |
| 2    | `9a5f886` | fix(260417-0qj): add overflow containment to ChatPage  |

## Self-Check: PASSED

- [x] `apps/client/src/main.tsx` contains `height: 100vh` and `overflow: hidden` in .awb-shell
- [x] `apps/client/src/main.tsx` contains `overflow-y: auto` in .awb-content
- [x] `apps/client/src/components/ChatPage.tsx` has overflow containment on both layouts
- [x] Both commits exist in git log
