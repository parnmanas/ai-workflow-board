// Integration test — chat round-trip over the REAL chat-rooms surface.
//
// HISTORY: the original four cases (round-trip, cross-user privacy, agent
// impersonation, workspace boundary) were written against a chat API that never
// shipped — POST /api/chat/messages, GET /api/chat/threads, and an MCP
// send_chat_message tool taking an agent_id (the impersonation vector). Chat
// actually shipped as `api/chat-rooms` (rooms + participants), where sender
// identity is derived from the authenticated caller and message fan-out is
// participant-scoped — so three of those properties are now either structurally
// guaranteed or covered by living tests, and the dead-API cases hung/404'd
// (quarantined → ticket 5e5959ef). The coverage moved to:
//   - cross-user privacy  → qa-flows/multi-user-chat.test.mjs (non-participant
//     user + agent receive nothing; participants do)
//   - agent impersonation → structurally removed (send_chat_room_message has no
//     agent_id param; RoomMessagingService.requireActiveParticipant gates it) —
//     behavioral participant-gate coverage in qa-flows/chat-message-read.test.mjs
//   - workspace boundary  → qa-flows/chat-message-read.test.mjs (room/search
//     scope) + qa-flows/comment-mention.test.mjs (cross-workspace SSE non-leak)
//
// What was NOT covered anywhere was the stitched ROUND-TRIP itself across both
// transports in one flow. This rewrite closes exactly that gap on the real
// surface: a user POSTs a chat-room message over REST → the user's SSE stream
// receives the chat_room_message echo → an agent participant replies via the
// send_chat_room_message MCP tool → the user's SSE stream receives the second
// chat_room_message. This is the seam the proxy.mjs + Claude CLI stack depends on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { RoomMessagingService } from '../dist/modules/chat-rooms/room-messaging.service.js';
import { TriggerLoopService } from '../dist/modules/agents/trigger-loop.service.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '7792';

// Seed a DM room with the given participants directly via repositories — there
// is no chat-room fixture helper and the round-trip only needs the persisted
// room + participant rows (mirrors seedRoom in qa-flows/chat-message-read).
async function seedDmRoom(ds, { workspaceId, participants }) {
  const roomRepo = ds.getRepository('ChatRoom');
  const partRepo = ds.getRepository('ChatRoomParticipant');
  const room = await roomRepo.save(roomRepo.create({
    workspace_id: workspaceId,
    type: 'dm',
    name: '',
  }));
  for (const p of participants) {
    await partRepo.save(partRepo.create({
      room_id: room.id,
      participant_type: p.type,
      participant_id: p.id,
      last_read_at: null,
      left_at: null,
    }));
  }
  return room;
}

test('chat round-trip: user REST POST → SSE echo → agent MCP reply → SSE', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'chat-roundtrip' });

  const user = await createUser(app, getDataSourceToken, { name: 'human' });
  const userToken = app.get(AuthService).createSession(user.id);
  const responder = await createAgent(app, getDataSourceToken, ws.id, { name: 'responder' });
  const responderKey = await createApiKey(app, getDataSourceToken, responder.id, {
    workspaceId: ws.id,
    label: 'responder',
  });

  // DM room with the user and the agent as the two participants.
  const room = await seedDmRoom(ds, {
    workspaceId: ws.id,
    participants: [
      { type: 'user', id: user.id },
      { type: 'agent', id: responder.id },
    ],
  });

  // User SSE stream (recipient under the participant-scoped chat_room_message
  // filter) + the agent's MCP client (the reply transport).
  const userStream = await openSseStream(port, userToken);
  // 소형 컨텍스트 Claude backend profile이 실제로 여는 MCP 세션과 같은
  // compact 헤더를 사용한다. 이 프로필에서도 최종 채팅 도구 등록부터
  // 웹 SSE 수신까지 종단 왕복이 유지되어야 한다.
  const agentMcp = new McpClient({
    baseUrl: base,
    apiKey: responderKey.raw_key,
    extraHeaders: { 'X-AWB-Tool-Profile': 'compact' },
  });
  await agentMcp.initialize();
  t.after(async () => { userStream.close(); await agentMcp.close(); });
  await new Promise((r) => setTimeout(r, 250));

  const rawChatRequests = [];
  const onChatRequest = (event) => rawChatRequests.push(event);
  modules.activityEvents.on('chat_request', onChatRequest);
  t.after(() => modules.activityEvents.removeListener('chat_request', onChatRequest));

  // ── 1. User POSTs a message over REST → 201, and the user's own SSE stream
  //       (a participant) receives the chat_room_message echo.
  const userText = 'hi responder, are you there?';
  const postRes = await fetch(`${base}/api/chat-rooms/${room.id}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
      'X-Workspace-Id': ws.id,
    },
    body: JSON.stringify({ content: userText }),
  });
  const postBody = await postRes.text();
  assert.equal(postRes.status, 201, `user message POST should 201: ${postBody}`);
  const postedMessage = JSON.parse(postBody);

  const echoFrame = await userStream.waitFor(
    'chat_room_message',
    (d) => (d?.content ?? d?.payload?.content) === userText,
    4000,
  );
  assert.ok(echoFrame, 'participant user must receive the SSE echo of their own message');
  assert.equal(rawChatRequests.length, 1, 'a user-to-agent DM emits one canonical chat_request');
  assert.equal(
    rawChatRequests[0].message_id,
    postedMessage.id,
    'chat_request idempotency is anchored to the persisted chat message id',
  );
  const echoData = echoFrame.data ?? echoFrame;
  assert.deepEqual(
    echoData.dispatch_agent_ids,
    [responder.id],
    'the room broadcast marks the agent whose execution is already owned by chat_request',
  );

  // ── 2. Agent replies via the send_chat_room_message MCP tool → the user's SSE
  //       stream receives the second chat_room_message. Note the tool takes NO
  //       agent_id — sender identity is the caller's API-key agent, so there is
  //       no impersonation vector to test (the old Test 3 case is moot).
  const createdTicket = await agentMcp.callTool('create_ticket', {
    title: 'chat artifact round-trip',
    column_id: columns.todo.id,
  });
  assert.ok(createdTicket?.id, `ticket create must succeed: ${JSON.stringify(createdTicket)}`);

  // Agent can only post an approval card. The ticket remains pending until a
  // browser-authenticated user invokes the existing guarded PATCH.
  await ds.getRepository('Ticket').update(createdTicket.id, {
    pending_user_action: true,
    pending_reason: 'human decision required',
  });
  const approvalRes = await agentMcp.callTool('request_ticket_unpend_approval', {
    room_id: room.id,
    ticket_id: createdTicket.id,
  });
  assert.ok(!approvalRes.isError, `approval-card request must succeed: ${JSON.stringify(approvalRes)}`);
  const approvalFrame = await userStream.waitFor(
    'chat_room_message',
    (d) => (d?.type ?? d?.payload?.type) === 'ticket_action',
    4000,
  );
  const approvalData = approvalFrame?.data ?? approvalFrame;
  assert.deepEqual(
    approvalData?.metadata?.ticket_action,
    { kind: 'unpend', ticket_id: createdTicket.id, title: 'chat artifact round-trip' },
    'SSE carries the bounded ticket action card payload',
  );
  assert.equal(
    (await ds.getRepository('Ticket').findOneByOrFail({ id: createdTicket.id })).pending_user_action,
    true,
    'posting the card must not unpend the ticket',
  );

  const outsider = await createAgent(app, getDataSourceToken, ws.id, { name: 'outsider' });
  const outsiderKey = await createApiKey(app, getDataSourceToken, outsider.id, {
    workspaceId: ws.id,
    label: 'outsider',
  });
  const outsiderMcp = new McpClient({ baseUrl: base, apiKey: outsiderKey.raw_key });
  await outsiderMcp.initialize();
  t.after(async () => { await outsiderMcp.close(); });
  const outsiderApproval = await outsiderMcp.callTool('request_ticket_unpend_approval', {
    room_id: room.id,
    ticket_id: createdTicket.id,
  });
  assert.ok(outsiderApproval.isError, 'an agent that is not a room participant cannot post an approval card');

  const { ws: otherWs, columns: otherColumns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'chat-roundtrip-other',
  });
  const crossWorkspaceTicket = await ds.getRepository('Ticket').save(ds.getRepository('Ticket').create({
    workspace_id: otherWs.id,
    board_id: otherColumns.todo.board_id,
    column_id: otherColumns.todo.id,
    title: 'other workspace pending',
    pending_user_action: true,
  }));
  const crossWorkspaceApproval = await agentMcp.callTool('request_ticket_unpend_approval', {
    room_id: room.id,
    ticket_id: crossWorkspaceTicket.id,
  });
  assert.ok(crossWorkspaceApproval.isError, 'ticket and room from different workspaces are rejected');

  const agentPatch = await fetch(`${base}/api/tickets/${createdTicket.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${responderKey.raw_key}`,
      'X-Workspace-Id': ws.id,
    },
    body: JSON.stringify({ pending_user_action: false }),
  });
  assert.equal(agentPatch.status, 401, 'an agent API key cannot use the human-session ticket PATCH');

  const triggerLoop = app.get(TriggerLoopService);
  const originalDispatch = triggerLoop.dispatchCurrentColumn.bind(triggerLoop);
  const unpendDispatches = [];
  triggerLoop.dispatchCurrentColumn = async (...args) => {
    if (args[1] === 'unpend') unpendDispatches.push(args);
    return originalDispatch(...args);
  };
  t.after(() => { triggerLoop.dispatchCurrentColumn = originalDispatch; });

  const resume = () => fetch(`${base}/api/tickets/${createdTicket.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
      'X-Workspace-Id': ws.id,
    },
    body: JSON.stringify({ pending_user_action: false }),
  });
  const firstResume = await resume();
  assert.equal(firstResume.status, 200, `human-session resume must succeed: ${await firstResume.text()}`);
  const secondResume = await resume();
  assert.equal(secondResume.status, 200, `repeated resume must stay idempotent: ${await secondResume.text()}`);
  assert.equal(unpendDispatches.length, 1, 'true→false transition dispatches unpend exactly once');
  assert.equal(unpendDispatches[0][2], user.id, 'dispatch actor is the authenticated user');
  const activity = await ds.getRepository('ActivityLog').findOne({
    where: { ticket_id: createdTicket.id, field_changed: 'pending_user_action' },
    order: { created_at: 'DESC' },
  });
  assert.equal(activity?.actor_id, user.id, 'unpend activity actor is the authenticated user');
  const resolvedApproval = await agentMcp.callTool('request_ticket_unpend_approval', {
    room_id: room.id,
    ticket_id: createdTicket.id,
  });
  assert.ok(resolvedApproval.isError, 'an already-resumed ticket cannot produce a fresh approval card');

  const agentText = 'ticket created — responder here';
  const toolRes = await agentMcp.callTool('send_chat_room_message', {
    room_id: room.id,
    content: agentText,
  });
  assert.ok(!toolRes.isError, `agent MCP send must succeed: ${JSON.stringify(toolRes)}`);

  const replyFrame = await userStream.waitFor(
    'chat_room_message',
    (d) => (d?.content ?? d?.payload?.content) === agentText,
    4000,
  );
  assert.ok(replyFrame, 'user must receive the agent reply over SSE — full round-trip closed');

  // The reply was authored by the agent (identity derived from the caller, not
  // a client-supplied field).
  const replyData = replyFrame.data ?? replyFrame;
  const senderType = replyData?.sender_type ?? replyData?.payload?.sender_type;
  const senderId = replyData?.sender_id ?? replyData?.payload?.sender_id;
  assert.equal(senderType, 'agent', 'reply sender_type is agent');
  assert.equal(senderId, responder.id, 'reply sender_id is the calling agent');
  assert.deepEqual(
    replyData.metadata?.ticket_refs,
    [{ action: 'create', ticket_id: createdTicket.id, title: 'chat artifact round-trip' }],
    'the final reply SSE carries the server-bound create artifact exactly once',
  );

  // A real update in the next turn binds an update artifact; an idempotent
  // no-op update does not manufacture another ref.
  await agentMcp.callTool('update_ticket', {
    ticket_id: createdTicket.id,
    title: 'chat artifact updated',
  });
  await agentMcp.callTool('update_ticket', {
    ticket_id: createdTicket.id,
  });
  const updateText = 'ticket updated';
  await agentMcp.callTool('send_chat_room_message', {
    room_id: room.id,
    content: updateText,
  });
  const updateFrame = await userStream.waitFor(
    'chat_room_message',
    (d) => (d?.content ?? d?.payload?.content) === updateText,
    4000,
  );
  const updateData = updateFrame.data ?? updateFrame;
  assert.deepEqual(
    updateData.metadata?.ticket_refs,
    [{ action: 'update', ticket_id: createdTicket.id, title: 'chat artifact updated' }],
    'the next reply carries one update artifact despite a following no-op update',
  );

  // Establish canonical values (including an assignment row), drain that real
  // update, then prove each same-value payload independently produces no ref.
  await agentMcp.callTool('update_ticket', {
    ticket_id: createdTicket.id,
    title: 'chat artifact updated',
    priority: 'medium',
    labels: ['artifact'],
    channel_ids: [],
    reviewer_id: responder.id,
    on_done_action_ids: [],
    role_assignments: [{ role_slug: 'assignee', agent_id: responder.id }],
  });
  await agentMcp.callTool('send_chat_room_message', {
    room_id: room.id,
    content: 'canonical update drained',
  });
  const sameValuePayloads = [
    { title: 'chat artifact updated' },
    { priority: 'medium' },
    { labels: ['artifact'] },
    { channel_ids: [] },
    { reviewer_id: responder.id },
    { on_done_action_ids: [] },
    { role_assignments: [{ role_slug: 'assignee', agent_id: responder.id }] },
  ];
  for (const [index, payload] of sameValuePayloads.entries()) {
    const updateResult = await agentMcp.callTool('update_ticket', {
      ticket_id: createdTicket.id,
      ...payload,
    });
    assert.ok(!updateResult.isError, `same-value update ${index} succeeds`);
    const noOpSend = await agentMcp.callTool('send_chat_room_message', {
      room_id: room.id,
      content: `same-value update ${index}`,
    });
    assert.equal(
      noOpSend.metadata?.ticket_refs,
      undefined,
      `same-value payload ${JSON.stringify(payload)} must not create an artifact`,
    );
  }

  // Inject a failure immediately after the transaction commits. The first tool
  // call reports failure, but its ref is already durable and must not be
  // restored onto the retry message.
  const postCommitTicket = await agentMcp.callTool('create_ticket', {
    title: 'post-commit artifact exactly once',
    column_id: columns.todo.id,
  });
  const messaging = app.get(RoomMessagingService);
  const originalRoomUpdate = messaging.roomRepo.update.bind(messaging.roomRepo);
  let failOnce = true;
  messaging.roomRepo.update = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('injected post-commit room update failure');
    }
    return originalRoomUpdate(...args);
  };
  t.after(() => { messaging.roomRepo.update = originalRoomUpdate; });
  const failedAfterCommit = await agentMcp.callTool('send_chat_room_message', {
    room_id: room.id,
    content: 'durable before post-commit failure',
  });
  assert.ok(failedAfterCommit.isError, 'post-commit injected failure is observable to the tool caller');
  assert.equal(failedAfterCommit.error.message_persisted, true, 'post-commit error carries a durable ack');
  assert.ok(failedAfterCommit.error.message_id, 'post-commit error identifies the durable message row');
  assert.deepEqual(
    failedAfterCommit.error.metadata?.ticket_refs,
    [{ action: 'create', ticket_id: postCommitTicket.id, title: 'post-commit artifact exactly once' }],
    'post-commit error echoes the artifact binding for manager suppression',
  );
  const retryAfterCommit = await agentMcp.callTool('send_chat_room_message', {
    room_id: room.id,
    content: 'retry after post-commit failure',
  });
  assert.equal(retryAfterCommit.metadata?.ticket_refs, undefined, 'retry does not re-bind a committed ref');

  const historyRows = await ds.getRepository('ChatRoomMessage').find({
    where: { room_id: room.id },
    order: { created_at: 'ASC' },
  });
  const artifactRows = historyRows
    .map((row) => {
      try { return row.metadata ? JSON.parse(row.metadata) : null; } catch { return null; }
    })
    .filter((metadata) => Array.isArray(metadata?.ticket_refs));
  assert.deepEqual(
    artifactRows
      .flatMap((metadata) => metadata.ticket_refs)
      .filter((ref) => ref.ticket_id === postCommitTicket.id),
    [{ action: 'create', ticket_id: postCommitTicket.id, title: 'post-commit artifact exactly once' }],
    'post-commit failure + retry leaves exactly one durable artifact row',
  );

  // No process.exit: the suite runs with --test-force-exit, which hands the real
  // node:test exit code back instead of masking a failed assertion.
});
