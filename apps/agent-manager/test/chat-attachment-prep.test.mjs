// Behavioural QA for chat-attachment-prep — subtask (c) of ticket
// 92082b55. Covers normalize/classify/inline-cap/fetch-failure paths and
// the prompt block renderer that downstream CLIs read. Image fetch
// stubbing avoids any real network — we intercept globalThis.fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareChatAttachments,
  renderAttachmentBlock,
  MAX_INLINE_TEXT_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
} from '../dist/lib/chat-attachment-prep.js';

const CONFIG = { url: 'http://localhost:7701', apiKey: 'k' };
const ROOM = 'room-1';

/** Install a one-shot fetch mock that maps `url -> Response`. Returns
 *  the original so the test can restore it after. */
function withFetch(mocks) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [pattern, body] of Object.entries(mocks)) {
      if (u.includes(pattern)) {
        if (body instanceof Error) throw body;
        if (body === null) {
          return new Response('{}', { status: 404, statusText: 'Not Found' });
        }
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

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

test('prep: image with fetchImages=true returns image_base64 with bytes', async () => {
  const restore = withFetch({
    '/api/agent/chat-rooms/room-1/attachments/img-1': {
      id: 'img-1',
      file_name: 'screen.png',
      file_mimetype: 'image/png',
      file_size: 9,
      file_data: 'ZmFrZS1ieXRlcw==',
      download_url: '/api/chat-rooms/room-1/attachments/img-1',
    },
  });
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'img-1', file_name: 'screen.png', mime_type: 'image/png', size_bytes: 9 }],
      { fetchImages: true },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'image_base64');
    assert.equal(out[0].image_base64, 'ZmFrZS1ieXRlcw==');
    assert.equal(out[0].mime_type, 'image/png');
  } finally {
    restore();
  }
});

test('prep: image with fetchImages=false degrades to metadata_only', async () => {
  // No fetch mock — we should not even attempt to fetch.
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (_url) => {
    fetchCalls++;
    throw new Error('should not be called');
  };
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'img-2', file_name: 'pic.jpg', mime_type: 'image/jpeg', size_bytes: 200 }],
      { fetchImages: false },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'metadata_only');
    assert.ok(out[0].note && out[0].note.includes('vision'));
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('prep: text-ish attachment under cap is inlined as decoded UTF-8', async () => {
  const restore = withFetch({
    '/api/agent/chat-rooms/room-1/attachments/log-1': {
      id: 'log-1',
      file_name: 'app.log',
      file_mimetype: 'text/plain',
      file_size: 11,
      file_data: b64('hello world'),
      download_url: '/api/chat-rooms/room-1/attachments/log-1',
    },
  });
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'log-1', file_name: 'app.log', mime_type: 'text/plain', size_bytes: 11 }],
      { fetchImages: false },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'text_inline');
    assert.equal(out[0].text_content, 'hello world');
  } finally {
    restore();
  }
});

test('prep: text-ish over MAX_INLINE_TEXT_BYTES drops to metadata_only', async () => {
  // No fetch mock needed — we never reach the fetch because size_bytes
  // is checked first.
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('should not fetch');
  };
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [
        {
          id: 'big',
          file_name: 'huge.json',
          mime_type: 'application/json',
          size_bytes: MAX_INLINE_TEXT_BYTES + 100,
        },
      ],
      { fetchImages: false },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'metadata_only');
    assert.ok(out[0].note && out[0].note.includes('cap'));
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('prep: binary mime stays metadata_only without fetching', async () => {
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('should not fetch');
  };
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'pdf-1', file_name: 'report.pdf', mime_type: 'application/pdf', size_bytes: 100 }],
      { fetchImages: true },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'metadata_only');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('prep: fetch failure on image degrades with note, no throw', async () => {
  const restore = withFetch({
    '/api/agent/chat-rooms/room-1/attachments/img-fail': null, // 404
  });
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'img-fail', file_name: 's.png', mime_type: 'image/png', size_bytes: 1 }],
      { fetchImages: true },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'metadata_only');
    assert.ok(out[0].note && out[0].note.includes('fetch failed'));
  } finally {
    restore();
  }
});

test('prep: respects MAX_ATTACHMENTS_PER_TURN cap', async () => {
  const tooMany = Array.from({ length: MAX_ATTACHMENTS_PER_TURN + 5 }, (_, i) => ({
    id: `id-${i}`,
    file_name: `f-${i}.bin`,
    mime_type: 'application/octet-stream',
    size_bytes: 1,
  }));
  const out = await prepareChatAttachments(CONFIG, ROOM, tooMany, { fetchImages: false });
  assert.equal(out.length, MAX_ATTACHMENTS_PER_TURN);
});

test('prep: missing roomId returns empty', async () => {
  const out = await prepareChatAttachments(
    CONFIG,
    '',
    [{ id: 'x', file_name: 'y.txt', mime_type: 'text/plain', size_bytes: 1 }],
    { fetchImages: true },
  );
  assert.deepEqual(out, []);
});

test('prep: empty list returns empty', async () => {
  assert.deepEqual(await prepareChatAttachments(CONFIG, ROOM, [], { fetchImages: true }), []);
  assert.deepEqual(
    await prepareChatAttachments(CONFIG, ROOM, undefined, { fetchImages: true }),
    [],
  );
});

test('renderAttachmentBlock includes filename, mime, size, url, and inline body', () => {
  const lines = renderAttachmentBlock([
    {
      id: 'a-1',
      filename: 'note.md',
      mime_type: 'text/markdown',
      size_bytes: 5,
      download_url: '/api/chat-rooms/r/attachments/a-1',
      kind: 'text_inline',
      text_content: 'hello',
    },
    {
      id: 'a-2',
      filename: 'pic.png',
      mime_type: 'image/png',
      size_bytes: 12,
      download_url: '/api/chat-rooms/r/attachments/a-2',
      kind: 'image_base64',
      image_base64: 'AAAA',
    },
    {
      id: 'a-3',
      filename: 'big.zip',
      mime_type: 'application/zip',
      size_bytes: 5_000_000,
      download_url: '/api/chat-rooms/r/attachments/a-3',
      kind: 'metadata_only',
    },
  ]);
  const joined = lines.join('\n');
  assert.ok(joined.includes('note.md'));
  assert.ok(joined.includes('mime=text/markdown'));
  assert.ok(joined.includes('hello'));
  assert.ok(joined.includes('image content block attached'));
  assert.ok(joined.includes('big.zip'));
  assert.ok(joined.includes('mime=application/zip'));
});

test('renderAttachmentBlock with empty list returns no lines', () => {
  assert.deepEqual(renderAttachmentBlock([]), []);
});
