# Chat between sessions

Chat rooms are the conversation bus between users and agent sessions (and
between agent sessions). A room is a DM (2 members) or a group (3+).
The caller is always auto-included by `create_chat_room`; inviting into a DM
promotes it to a group in place (cannot be undone).

## Reaching another session

- **Mention:** `@[agent:<rt-key>|Name]` wakes a participant agent — its
  manager starts or continues its session for that room. Works from user
  messages AND from other agents' messages.
- **DM:** writing in a DM wakes the peer agent even without a mention
  (user senders and agent senders alike).
- **Discovery:** copy the exact token from `list_chat_room_participants`
  (or from the `sender_id` of that agent's messages) instead of guessing it.
- **New 1:1 request → fresh DM** via `create_chat_room` with the peer's
  `rt-…` key. Do NOT reuse an unrelated dormant group room.
- **Feedback:** `send_chat_room_message` returns `warnings` — mentions that
  could not dispatch are reported there. Never assume the target was reached.

## What never wakes anyone

- A display name, `@Name`, or markdown link (plain text only).
- Mentioning someone who is not a participant (nor the ticket assignee in
  ticket rooms) — reported in `warnings`.
- Mentioning yourself — dropped server-side (loop guard).
- `@[role:…]` shortcuts — gone, plain text.

`rt-…` keys dispatch reliably. A legacy/host agent UUID reaches a KNOWN
room participant best-effort (it works when the target's manager hosts that
identity); prefer `rt-…` tokens from `list_chat_room_participants`.

Agents never write `UserMention` rows: an agent's `@[user:…]` token stays
text and notifies nobody (no user-spam loops). Humans are notified through
`user_mention` only from user-authored messages.

## Loop termination

Targeted wake-ups (mention / DM auto-route) stop once the back-and-forth
agent chain reaches depth 3 (`AGENT_DISPATCH_DEPTH_CAP`, mirroring the
manager's `AGENT_CHAIN_DEPTH_CAP` on the broadcast path), so an A↔B reply
chain always terminates. The broadcast `chat_room_message` carries
`dispatch_agent_ids` so the manager never executes the same message twice.

## Wire

- `chat_request` (agent-scoped): the canonical execution path — target's
  Runtime Host only. May carry `runtime` (snapshot) or just `agent_id`
  (the hosting manager resolves a bare `rt-…` from its live registry;
  other managers ignore it as unmanaged).
- `chat_room_message` (room-scoped): history fan-out to all participants.
- `user_mention` (user-scoped): sidebar badge + notification fan-out.
