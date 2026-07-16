// Credential firewall — a QA/security run-dispatch `chat_room_message` carries
// the repo git credential at `run_provision.repo.credential` so the agent-manager
// can clone a PRIVATE repo (ticket 4f4d5df2). The SSE stream fans that frame to
// EVERY room member; the token must reach only an agent (manager) recipient,
// never a human's browser — even a user who is a member of the run room. This
// mirrors the worktree path, where the credential only ever flows to the manager
// (via the authenticated /git-credential endpoint), never onto a user surface.
//
// `redactRunProvisionCredential` is the per-recipient strip events.controller
// applies right before JSON.stringify. The load-bearing invariant tested here is
// the SHARED-REFERENCE SAFETY: `flatten()` shallow-spreads the shared envelope,
// so the run_provision object is the SAME reference handed to every subscriber's
// frame (including the manager's) — the strip MUST rebuild the nested object, not
// delete in place, or it would blank the credential for the real consumer.

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';

import { redactRunProvisionCredential } from '../dist/modules/events/events.controller.js';

function runDispatchFrame() {
  // Shape of the flattened chat_room_message wire object (payload spread to top
  // level by the event-registry `flatten`), carrying a run_provision hint.
  return {
    room_id: 'room-1',
    message_id: 'msg-1',
    sender_type: 'user',
    sender_name: 'system',
    content: 'run dispatch',
    run_provision: {
      kind: 'qa',
      run_id: 'run-1',
      workspace_id: 'ws-1',
      workspace_folder: '.awb/qa/scenario',
      checkout_mode: 'reuse',
      repo: {
        url: 'https://github.com/parnmanas/private.git',
        branch: 'main',
        credential: { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' },
      },
    },
  };
}

test('agent recipient keeps the credential (returns the frame unchanged)', () => {
  const frame = runDispatchFrame();
  const out = redactRunProvisionCredential(frame, 'chat_room_message', 'agent');
  assert.equal(out, frame, 'agent frame must pass through by reference (no clone)');
  assert.equal(out.run_provision.repo.credential.token, 'ghp_SECRET_TOKEN');
});

test('user recipient gets the credential stripped, everything else intact', () => {
  const frame = runDispatchFrame();
  const out = redactRunProvisionCredential(frame, 'chat_room_message', 'user');

  assert.equal(out.run_provision.repo.credential, undefined, 'token must be stripped for a human recipient');
  // The rest of the provisioning hint survives — a user's client can still see
  // the room message; only the secret is removed.
  assert.equal(out.run_provision.repo.url, 'https://github.com/parnmanas/private.git');
  assert.equal(out.run_provision.repo.branch, 'main');
  assert.equal(out.run_provision.workspace_folder, '.awb/qa/scenario');
  assert.equal(out.content, 'run dispatch');
  // JSON.stringify (the actual wire step) must not carry the token anywhere.
  assert.ok(!JSON.stringify(out).includes('ghp_SECRET_TOKEN'), 'serialized user frame must not contain the token');
});

test('stripping a user frame does NOT mutate the shared source object (clone, not in-place delete)', () => {
  const frame = runDispatchFrame();
  redactRunProvisionCredential(frame, 'chat_room_message', 'user');
  // The manager's frame shares this run_provision reference — it must still see
  // the credential after a user recipient was served.
  assert.equal(
    frame.run_provision.repo.credential.token,
    'ghp_SECRET_TOKEN',
    'source credential must survive so the concurrent agent recipient still authenticates',
  );
});

test('non-chat_room_message frames are never touched', () => {
  const frame = { run_provision: { repo: { credential: { token: 'ghp_X' } } } };
  const out = redactRunProvisionCredential(frame, 'agent_trigger', 'user');
  assert.equal(out, frame);
  assert.equal(out.run_provision.repo.credential.token, 'ghp_X');
});

test('a chat_room_message with no run_provision credential passes through untouched', () => {
  const plain = { room_id: 'r', content: 'hi' };
  assert.equal(redactRunProvisionCredential(plain, 'chat_room_message', 'user'), plain);

  const noCred = { run_provision: { repo: { url: 'https://x/y.git' } } };
  assert.equal(redactRunProvisionCredential(noCred, 'chat_room_message', 'user'), noCred);
});
