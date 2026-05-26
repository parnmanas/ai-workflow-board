// Behavioural QA for chat-attachment-prep — subtask (c) of ticket
// 92082b55. Covers normalize/classify/inline-cap/fetch-failure paths and
// the prompt block renderer that downstream CLIs read. Image fetch
// stubbing avoids any real network — we intercept globalThis.fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
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

test('prep: image with fetchImages=false materializes to a local file', async () => {
  // Reviewer bounce 2026-05-26: previously degraded to metadata_only with
  // "ask the user again". Non-vision CLIs (Codex / Gemini) need a real
  // file path they can pass to their own file-read tools.
  const PNG_B64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
  ]).toString('base64');
  const restore = withFetch({
    '/api/agent/chat-rooms/room-1/attachments/img-2': {
      id: 'img-2',
      file_name: 'pic.jpg',
      file_mimetype: 'image/jpeg',
      file_size: 14,
      file_data: PNG_B64,
      download_url: '/api/chat-rooms/room-1/attachments/img-2',
    },
  });
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'img-2', file_name: 'pic.jpg', mime_type: 'image/jpeg', size_bytes: 200 }],
      { fetchImages: false },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'materialized_file');
    assert.ok(out[0].local_path && out[0].local_path.length > 0, 'local_path must be populated');
    const st = await stat(out[0].local_path);
    assert.ok(st.isFile(), 'materialized file must exist on disk');
    const bytes = await readFile(out[0].local_path);
    assert.equal(bytes.length, 14, 'on-disk byte count must match the fetched payload');
  } finally {
    restore();
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

test('prep: binary mime materializes the bytes to a local file', async () => {
  // Reviewer bounce 2026-05-26: PDF / zip / generic binary used to drop to
  // metadata_only with just a download_url; subagents had no way to act on
  // the file. Now fetch + write so the subagent can hand the path to its
  // own parser.
  const PDF_B64 = Buffer.from('%PDF-1.4\n%example body bytes\n', 'utf8').toString('base64');
  const restore = withFetch({
    '/api/agent/chat-rooms/room-1/attachments/pdf-1': {
      id: 'pdf-1',
      file_name: 'report.pdf',
      file_mimetype: 'application/pdf',
      file_size: 30,
      file_data: PDF_B64,
      download_url: '/api/chat-rooms/room-1/attachments/pdf-1',
    },
  });
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'pdf-1', file_name: 'report.pdf', mime_type: 'application/pdf', size_bytes: 30 }],
      { fetchImages: true },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'materialized_file');
    assert.ok(out[0].local_path && out[0].local_path.endsWith('report.pdf'));
    const bytes = await readFile(out[0].local_path);
    assert.equal(bytes.toString('utf8').startsWith('%PDF-1.4'), true);
  } finally {
    restore();
  }
});

test('prep: materialize falls through to metadata_only when fetch fails', async () => {
  // The downgrade path must keep the prompt rendering — the subagent
  // still sees the URL + a `note` instead of a hard throw.
  const restore = withFetch({
    '/api/agent/chat-rooms/room-1/attachments/bin-fail': null,
  });
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [{ id: 'bin-fail', file_name: 'x.bin', mime_type: 'application/octet-stream', size_bytes: 9 }],
      { fetchImages: true },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'metadata_only');
    assert.ok(out[0].note && /fetch failed/i.test(out[0].note));
    assert.equal(out[0].local_path, undefined);
  } finally {
    restore();
  }
});

test('prep: materialize sanitizes filename so a malicious name cannot escape the scratch dir', async () => {
  const restore = withFetch({
    '/api/agent/chat-rooms/room-1/attachments/escape-1': {
      id: 'escape-1',
      file_name: '../../etc/passwd',
      file_mimetype: 'application/octet-stream',
      file_size: 4,
      file_data: Buffer.from('safe', 'utf8').toString('base64'),
    },
  });
  try {
    const out = await prepareChatAttachments(
      CONFIG,
      ROOM,
      [
        {
          id: 'escape-1',
          file_name: '../../etc/passwd',
          mime_type: 'application/octet-stream',
          size_bytes: 4,
        },
      ],
      { fetchImages: true },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'materialized_file');
    assert.ok(out[0].local_path.includes('awb-attachments'), 'must be under the scratch dir');
    assert.ok(!out[0].local_path.includes('../'), 'must not contain path-traversal segments');
    assert.ok(!out[0].local_path.includes('/etc/'), 'must not have escaped into /etc');
  } finally {
    restore();
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
  // Materialization tries to fetch each binary, so wire up matching mocks
  // and verify the cap before that path even runs.
  const tooMany = Array.from({ length: MAX_ATTACHMENTS_PER_TURN + 5 }, (_, i) => ({
    id: `id-${i}`,
    file_name: `f-${i}.bin`,
    mime_type: 'application/octet-stream',
    size_bytes: 1,
  }));
  const mocks = {};
  for (let i = 0; i < MAX_ATTACHMENTS_PER_TURN; i++) {
    mocks[`/api/agent/chat-rooms/${ROOM}/attachments/id-${i}`] = {
      id: `id-${i}`,
      file_name: `f-${i}.bin`,
      file_mimetype: 'application/octet-stream',
      file_size: 1,
      file_data: Buffer.from([0]).toString('base64'),
    };
  }
  const restore = withFetch(mocks);
  try {
    const out = await prepareChatAttachments(CONFIG, ROOM, tooMany, { fetchImages: false });
    assert.equal(out.length, MAX_ATTACHMENTS_PER_TURN);
  } finally {
    restore();
  }
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
    {
      id: 'a-4',
      filename: 'screen.png',
      mime_type: 'image/png',
      size_bytes: 40,
      download_url: '/api/chat-rooms/r/attachments/a-4',
      kind: 'materialized_file',
      local_path: '/tmp/awb-attachments/r/a-4-screen.png',
    },
  ]);
  const joined = lines.join('\n');
  assert.ok(joined.includes('note.md'));
  assert.ok(joined.includes('mime=text/markdown'));
  assert.ok(joined.includes('hello'));
  assert.ok(joined.includes('image content block attached'));
  assert.ok(joined.includes('big.zip'));
  assert.ok(joined.includes('mime=application/zip'));
  // Materialized files must surface the local_path so a non-vision CLI
  // (Codex / Gemini) can pass it straight to its own file/read tools.
  assert.ok(joined.includes('local_path: /tmp/awb-attachments/r/a-4-screen.png'));
});

test('renderAttachmentBlock with empty list returns no lines', () => {
  assert.deepEqual(renderAttachmentBlock([]), []);
});
