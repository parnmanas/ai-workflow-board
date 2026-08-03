# Mainframe Detail Scroll Design

## Problem

The AI Agents page uses a two-pane Mainframe layout. The left Runtime Host list
already has an independent scroll container. The right `InstanceDetail` pane
does not: its header, managed-agent list, subagent list, and logs are laid out
in a height-constrained flex column without a vertical overflow owner. When a
Mainframe manages many agents, the detail content exceeds the available height
and is clipped by an ancestor with `overflow: hidden`.

The existing `mainframe-agent-list-scroll` regression test only protects the
left pane, so it passes while the right pane remains clipped.

## Chosen Behavior

Make the entire right Mainframe detail pane vertically scrollable. The detail
header and every section remain in normal document order, and users scroll the
right pane to reach later managed agents, subagents, and logs. The left Runtime
Host list continues to scroll independently.

This behavior applies at desktop and mobile widths. On mobile, the Back button
stays above the detail scroll area so navigation remains immediately available.

## Implementation Boundary

- Add a stable test marker to the right detail scroll viewport.
- Give that viewport `flex: 1`, `minHeight: 0`, vertical auto overflow, and
  horizontal clipping.
- Remove the detail component's fixed `height: 100%` dependency where it would
  compete with the viewport; its content should be allowed to take natural
  vertical height inside the scroll container.
- Do not change data loading, agent commands, list rendering, or the left pane.

## Verification

1. Extend the regression test so it fails unless the right detail pane owns
   vertical scrolling and the left list retains its existing scroll contract.
2. Run the focused client test and the relevant client test suite/type checks.
3. Confirm a long managed-agent list can reach its final row without moving or
   clipping the application shell.

