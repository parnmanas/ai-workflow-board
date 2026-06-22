// Regression — ticket 59a5d477: chat-attached images were invisible to the
// agent after a session respawn because history replay dropped attachments.
// Three independent gaps are covered here:
//   1. recordRoomMessage must thread `attachments` onto the in-memory ring
//      (the primary history source on respawn).
//   2. composeChatRoomPrompt must render per-history-message attachment blocks
//      when given the historyAttachments map.
//   3. prepareChatAttachments({materialize:false}) must degrade non-inlined
//      images to metadata_only WITHOUT a disk write — so history replay does
//      not re-materialize every past image on every respawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionManager } from '../dist/lib/chat-session-manager.js';
import { composeChatRoomPrompt } from '../dist/lib/prompts.js';
import {
  prepareChatAttachments,
  renderAttachmentBlock,
  approxBase64Bytes,
} from '../dist/lib/chat-attachment-prep.js';

const CONFIG = { url: 'http://localhost:7701', apiKey: 'k' };
const ROOM = 'room-1';

function makeManager() {
  return new ChatSessionManager({ url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: {} });
}

function withFetch(mocks) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [pattern, body] of Object.entries(mocks)) {
      if (u.includes(pattern)) {
        if (body instanceof Error) throw body;
        if (body === null) return new Response('{}', { status: 404, statusText: 'Not Found' });
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  return () => {
    globalThis.fetch = orig;
  };
}

// ── 1. ring stores attachments ──────────────────────────────────────────────

test('recordRoomMessage threads attachments onto the history ring', () => {
  const mgr = makeManager();
  const att = [
    { id: 'img-1', file_name: 'shot.png', mime_type: 'image/png', size_bytes: 9, download_url: '/d/img-1' },
  ];
  mgr.recordRoomMessage({
    room_id: ROOM,
    type: 'message',
    sender_type: 'user',
    sender_name: 'Alice',
    content: 'see this',
    attachments: att,
  });
  const entries = mgr._historyEntries(ROOM);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].attachments, att, 'attachment metadata survives on the ring');
});

test('recordRoomMessage leaves attachments undefined when none present', () => {
  const mgr = makeManager();
  mgr.recordRoomMessage({ room_id: ROOM, type: 'message', sender_type: 'user', content: 'hi' });
  const entries = mgr._historyEntries(ROOM);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].attachments, undefined, 'no empty-array noise when there were no attachments');
});

// ── 2. composer renders history attachments ─────────────────────────────────

test('composeChatRoomPrompt renders per-history-message attachment blocks', () => {
  const past = {
    sender_type: 'user',
    sender_name: 'Alice',
    content: 'here is the screenshot',
    created_at: '2026-06-20T00:00:00Z',
  };
  const history = [past];
  const historyAttachments = new Map();
  historyAttachments.set(past, [
    {
      id: 'h-img',
      filename: 'screenshot.png',
      mime_type: 'image/png',
      size_bytes: 12,
      download_url: '/d/h-img',
      kind: 'image_base64',
      image_base64: 'AAAA',
    },
  ]);

  const p = composeChatRoomPrompt(
    ROOM,
    history,
    { content: 'what does it show?', sender_name: 'Alice', sender_id: 'u1' },
    undefined,
    true,
    historyAttachments,
  );
  assert.ok(p.includes('screenshot.png'), 'history attachment filename rendered');
  assert.ok(p.includes('image content block attached'), 'inlined image flagged in the history block');
  assert.ok(p.includes('Attachments:'), 'history attachment heading present');
});

test('composeChatRoomPrompt without historyAttachments stays text-only (back-compat)', () => {
  const past = { sender_type: 'user', sender_name: 'Alice', content: 'older msg', created_at: 't' };
  const p = composeChatRoomPrompt(
    ROOM,
    [past],
    { content: 'now', sender_name: 'Alice', sender_id: 'u1' },
  );
  assert.ok(p.includes('older msg'), 'history content still rendered');
  assert.ok(!p.includes('Attachments:'), 'no history attachment block when the map is absent');
});

// ── 3. materialize:false degrades images without a fetch/disk write ──────────

test('prep: image with fetchImages=false + materialize=false → metadata_only, no fetch', async () => {
  let fetchCalls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('history prep must not fetch over-budget image bytes');
  };
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'old-img', file_name: 'past.png', mime_type: 'image/png', size_bytes: 9 }],
      { fetchImages: false, materialize: false },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'metadata_only');
    assert.equal(out[0].local_path, undefined, 'no disk write on the history-degrade path');
    assert.equal(fetchCalls, 0, 'no byte fetch when materialize is disabled');
  } finally {
    globalThis.fetch = orig;
  }
});

test('prep: text-ish attachment is still inlined even with materialize=false', async () => {
  const restore = withFetch({
    '/api/agent/chat-rooms/room-1/attachments/log-1': {
      id: 'log-1',
      file_name: 'app.log',
      file_mimetype: 'text/plain',
      file_size: 5,
      file_data: Buffer.from('hello', 'utf8').toString('base64'),
    },
  });
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'log-1', file_name: 'app.log', mime_type: 'text/plain', size_bytes: 5 }],
      { fetchImages: false, materialize: false },
    );
    assert.equal(out[0].kind, 'text_inline', 'small text history attachments are still worth inlining');
    assert.equal(out[0].text_content, 'hello');
  } finally {
    restore();
  }
});

test('prep: binary with materialize=false → metadata_only, no disk write', async () => {
  let fetchCalls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('should not fetch');
  };
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'pdf-1', file_name: 'r.pdf', mime_type: 'application/pdf', size_bytes: 99 }],
      { fetchImages: true, materialize: false },
    );
    assert.equal(out[0].kind, 'metadata_only');
    assert.equal(out[0].local_path, undefined);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('renderAttachmentBlock honours a custom heading', () => {
  const lines = renderAttachmentBlock(
    [{ id: 'a', filename: 'x.png', mime_type: 'image/png', size_bytes: 1, download_url: '/d/a', kind: 'metadata_only' }],
    'Attachments:',
  );
  assert.equal(lines[0], 'Attachments:', 'first line is the supplied heading');
});

test('approxBase64Bytes approximates decoded length and tolerates undefined', () => {
  assert.equal(approxBase64Bytes(undefined), 0);
  // 8 base64 chars → 6 decoded bytes.
  assert.equal(approxBase64Bytes('AAAAAAAA'), 6);
});

// ── 4. end-to-end: respawn re-inlines a history image as a vision block ──────

// Capture the spawn opts (firstTurnImages, firstTurnText) without forking a CLI.
class CapturingChatMgr extends ChatSessionManager {
  constructor(cfg) {
    super(cfg);
    this.captured = null;
  }
  async _spawnSession(sessionKey, _rolePrompt, firstTurnText, opts) {
    this.captured = { firstTurnText, firstTurnImages: opts?.firstTurnImages };
    return {
      sessionKey,
      pid: 70001,
      cli_type: 'claude',
      turnCount: 1,
      roomId: '',
      agentId: '',
    };
  }
}

test('dispatch (Claude respawn): a history-attached image is re-inlined as a vision block', async () => {
  const mgr = new CapturingChatMgr({
    url: 'http://localhost:7701',
    apiKey: 'k',
    delegation: { enabled: true, maxConcurrent: 10, idleMinutes: 999, maxTurnsPerSession: 999 },
  });

  // Seed the ring with a PAST user message that carried an image — this is the
  // state after a respawn rebuilds context from the in-memory ring.
  mgr.recordRoomMessage({
    room_id: ROOM,
    type: 'message',
    sender_type: 'user',
    sender_name: 'Alice',
    content: 'look at this chart',
    created_at: '2026-06-20T00:00:00Z',
    attachments: [
      { id: 'past-img', file_name: 'chart.png', mime_type: 'image/png', size_bytes: 9, download_url: '/d/past-img' },
    ],
  });

  const restore = withFetch({
    '/api/agent/chat-rooms/room-1/attachments/past-img': {
      id: 'past-img',
      file_name: 'chart.png',
      file_mimetype: 'image/png',
      file_size: 9,
      file_data: 'ZmFrZS1ieXRlcw==',
      download_url: '/d/past-img',
    },
  });
  try {
    const res = await mgr.dispatch({
      roomId: ROOM,
      agentId: 'agent-1',
      senderId: 'u1',
      senderName: 'Alice',
      createdAt: '2026-06-20T00:05:00Z',
      content: 'what was the peak value?',
      attachments: [],
      agentContext: { cli: 'claude' },
    });
    assert.equal(res.dispatched, true);
    assert.ok(mgr.captured, 'spawn happened');
    const imgs = mgr.captured.firstTurnImages;
    assert.ok(Array.isArray(imgs) && imgs.length === 1, 'the past image is inlined as a vision block');
    assert.equal(imgs[0].data, 'ZmFrZS1ieXRlcw==', 'vision block carries the fetched bytes');
    assert.equal(imgs[0].media_type, 'image/png');
    assert.ok(mgr.captured.firstTurnText.includes('chart.png'), 'history block names the image file');
  } finally {
    restore();
  }
});

test('dispatch (non-Claude respawn): history image degrades to metadata, no vision block', async () => {
  const mgr = new CapturingChatMgr({
    url: 'http://localhost:7701',
    apiKey: 'k',
    delegation: { enabled: true, maxConcurrent: 10, idleMinutes: 999, maxTurnsPerSession: 999 },
  });
  mgr.recordRoomMessage({
    room_id: ROOM,
    type: 'message',
    sender_type: 'user',
    sender_name: 'Alice',
    content: 'look at this chart',
    created_at: '2026-06-20T00:00:00Z',
    attachments: [
      { id: 'past-img', file_name: 'chart.png', mime_type: 'image/png', size_bytes: 9, download_url: '/d/past-img' },
    ],
  });

  // codex/antigravity: no vision surface. History prep must NOT fetch the
  // image bytes (materialize:false) — assert by throwing on any fetch.
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`non-claude respawn must not fetch history image bytes: ${url}`);
  };
  try {
    const res = await mgr.dispatch({
      roomId: ROOM,
      agentId: 'agent-1',
      senderId: 'u1',
      senderName: 'Alice',
      createdAt: '2026-06-20T00:05:00Z',
      content: 'what was the peak value?',
      attachments: [],
      agentContext: { cli: 'codex' },
    });
    assert.equal(res.dispatched, true);
    assert.equal(mgr.captured.firstTurnImages, undefined, 'no vision blocks for a non-vision CLI');
    assert.ok(mgr.captured.firstTurnText.includes('chart.png'), 'image still surfaced as metadata');
  } finally {
    globalThis.fetch = orig;
  }
});
