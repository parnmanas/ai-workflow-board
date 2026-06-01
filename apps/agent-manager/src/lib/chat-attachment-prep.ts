// Chat attachment preparation for subagent delivery.
//
// SSE / history payloads from the server carry an `attachments[]` array per
// chat message, but only metadata — `file_data` is omitted from the
// projection to keep wire payloads small. The agent-manager has to fetch the
// bytes itself (via /api/agent/chat-rooms/:roomId/attachments/:id) before it
// can hand them to a CLI subagent.
//
// Responsibilities here:
//  - Normalize the wire shape into a predictable record.
//  - Decide per-attachment how it'll surface in the prompt / turn:
//      * 'image_base64' — image we already have the base64 for, suitable for
//        Claude vision content blocks.
//      * 'text_inline' — text-ish mime (text/*, application/json, csv, log,
//        markdown, xml, yaml) under the inline cap; body is unquoted into
//        the prompt so the subagent can read it directly.
//      * 'materialized_file' — image we can't inline (non-vision adapter)
//        or any binary file. Bytes are fetched once and written to a local
//        path the subagent can pass to its own file/vision tools. This is
//        the path that makes Codex / Antigravity able to actually consume image
//        and PDF / zip / binary attachments end-to-end.
//      * 'metadata_only' — fetch/materialize failed, oversize text, or
//        anything we can't honestly hand the agent. The subagent still
//        sees filename + mime + size + download_url + note.
//  - Fetch bytes when needed. Failure to fetch is silent — the attachment
//    falls through to metadata_only with a `note` so the subagent can tell
//    the user the file isn't reachable.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AwbConfig } from './rest.js';
import { fetchChatAttachment } from './rest.js';

/** Mime types we inline as UTF-8 text into the prompt. Anything else (PDF,
 *  zip, binary blobs) goes through as metadata only — subagents that need
 *  the bytes call out to a tool they trust. */
const TEXTISH_MIME_RE =
  /^(?:text\/.*|application\/(?:json|xml|x-ndjson|x-yaml|yaml|toml|x-toml|javascript|typescript)|application\/.*\+json|application\/.*\+xml|application\/sql)$/i;

/** Filenames that should be treated as text-ish regardless of declared mime
 *  (CLIs sometimes hand us application/octet-stream for source files). */
const TEXTISH_NAME_RE = /\.(?:txt|md|markdown|json|jsonl|ndjson|csv|tsv|log|yaml|yml|toml|xml|html|htm|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|env|ini|conf|cfg|gitignore|dockerignore|dockerfile|makefile|properties|gradle|cmake|graphql|gql|proto)$/i;

/** Max decoded bytes to inline as text in the prompt. Anything bigger falls
 *  through to metadata_only so the prompt doesn't blow past CLI context. */
export const MAX_INLINE_TEXT_BYTES = 64 * 1024;

/** Hard cap on the total number of attachments we'll process per turn. The
 *  server already enforces 20 per message, but we re-cap here defensively in
 *  case a future server change loosens it without bumping context budgets. */
export const MAX_ATTACHMENTS_PER_TURN = 20;

export interface RawChatAttachment {
  id?: string;
  attachment_id?: string;
  filename?: string;
  file_name?: string;
  mime_type?: string;
  file_mimetype?: string;
  size_bytes?: number;
  file_size?: number;
  download_url?: string;
  thumbnail_url?: string;
}

export type PreparedAttachmentKind =
  | 'image_base64'
  | 'text_inline'
  | 'materialized_file'
  | 'metadata_only';

export interface PreparedAttachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  download_url: string;
  kind: PreparedAttachmentKind;
  /** Base64 image payload, set only when kind === 'image_base64'. */
  image_base64?: string;
  /** Inlined UTF-8 text content, set only when kind === 'text_inline'. */
  text_content?: string;
  /** Absolute on-disk path of the fetched bytes, set only when kind ===
   *  'materialized_file'. Subagents reference this path via their own
   *  file-read tools (Codex/Antigravity read source files directly; Claude can
   *  Read it as if the user had attached a local file). */
  local_path?: string;
  /** Human-readable note appended to the prompt entry when the fetch path
   *  degraded the attachment (oversize, fetch failed). */
  note?: string;
}

function isImageMime(mime: string): boolean {
  return /^image\//i.test(mime || '');
}

function isTextishMime(mime: string, filename: string): boolean {
  if (TEXTISH_MIME_RE.test(mime || '')) return true;
  return TEXTISH_NAME_RE.test(filename || '');
}

/** Sanitize a filename for use as the last path segment of a temp file.
 *  Strip anything that could escape the per-room scratch dir or confuse a
 *  shell-style consumer; preserve the extension so the receiving CLI can
 *  still infer the file type. Filenames that lose every character (e.g. all
 *  `..`) fall back to the attachment id. */
function safeFilenameSegment(filename: string, id: string): string {
  const cleaned = filename
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 120);
  return cleaned || id;
}

/** Returns the absolute on-disk path for a (roomId, id, filename) triple,
 *  creating the per-room scratch dir if needed. */
async function reserveMaterializationPath(
  roomId: string,
  id: string,
  filename: string,
): Promise<string> {
  const dir = path.join(os.tmpdir(), 'awb-attachments', roomId);
  await fs.mkdir(dir, { recursive: true });
  const seg = safeFilenameSegment(filename, id);
  return path.join(dir, `${id}-${seg}`);
}

/** Fetch the bytes for `norm` and write them to a local file. On success the
 *  PreparedAttachment flips to `materialized_file` with `local_path` set.
 *  On any failure (no bytes, decode failure, disk write failure) it falls
 *  through to metadata_only with a `note` so the subagent still has a URL
 *  to surface to the user. Mutates `norm` in place and returns it. */
async function materialize(
  config: AwbConfig,
  roomId: string,
  norm: PreparedAttachment,
): Promise<PreparedAttachment> {
  const body = await fetchChatAttachment(config, roomId, norm.id);
  if (!body || typeof body.file_data !== 'string' || body.file_data.length === 0) {
    norm.note = 'attachment fetch failed; only metadata is available';
    return norm;
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(body.file_data, 'base64');
  } catch {
    norm.note = 'attachment payload could not be base64-decoded';
    return norm;
  }
  let outPath: string;
  try {
    outPath = await reserveMaterializationPath(roomId, norm.id, norm.filename);
    await fs.writeFile(outPath, bytes);
  } catch (err: any) {
    norm.note = `attachment could not be written to disk: ${err?.message || err}`;
    return norm;
  }
  norm.kind = 'materialized_file';
  norm.local_path = outPath;
  return norm;
}

function normalize(raw: RawChatAttachment): PreparedAttachment | null {
  const id = String(raw.id || raw.attachment_id || '').trim();
  if (!id) return null;
  return {
    id,
    filename: String(raw.filename || raw.file_name || id).trim(),
    mime_type: String(raw.mime_type || raw.file_mimetype || 'application/octet-stream').trim(),
    size_bytes:
      typeof raw.size_bytes === 'number'
        ? raw.size_bytes
        : typeof raw.file_size === 'number'
          ? raw.file_size
          : 0,
    download_url: String(raw.download_url || '').trim(),
    kind: 'metadata_only',
  };
}

export interface PrepareOptions {
  /** When false (Codex / Antigravity persistent baseline), images are not fetched
   *  and degrade to metadata_only so the prompt stays text-only. The legacy
   *  oneshot path also sets this false because there's no vision content
   *  block to push the bytes into. */
  fetchImages: boolean;
}

export async function prepareChatAttachments(
  config: AwbConfig,
  roomId: string,
  rawList: RawChatAttachment[] | undefined,
  options: PrepareOptions,
): Promise<PreparedAttachment[]> {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  if (!roomId) return [];

  const limited = rawList.slice(0, MAX_ATTACHMENTS_PER_TURN);

  const out: PreparedAttachment[] = [];
  for (const raw of limited) {
    const norm = normalize(raw);
    if (!norm) continue;

    const isImage = isImageMime(norm.mime_type);
    const isText = !isImage && isTextishMime(norm.mime_type, norm.filename);

    if (isImage) {
      if (!options.fetchImages) {
        // CLI cannot consume inline vision content blocks, but it can still
        // read the file off disk via its standard file/read tools. Fetch
        // the bytes once, drop them on the per-room scratch path, and hand
        // the agent a real local path instead of asking the user again.
        await materialize(config, roomId, norm);
        out.push(norm);
        continue;
      }
      const body = await fetchChatAttachment(config, roomId, norm.id);
      if (!body || typeof body.file_data !== 'string' || body.file_data.length === 0) {
        norm.note = 'image fetch failed; only metadata is available';
        out.push(norm);
        continue;
      }
      norm.kind = 'image_base64';
      norm.image_base64 = body.file_data;
      out.push(norm);
      continue;
    }

    if (isText) {
      if (norm.size_bytes > MAX_INLINE_TEXT_BYTES) {
        norm.note = `text attachment exceeds inline cap (${norm.size_bytes} > ${MAX_INLINE_TEXT_BYTES} bytes); only metadata included`;
        out.push(norm);
        continue;
      }
      const body = await fetchChatAttachment(config, roomId, norm.id);
      if (!body || typeof body.file_data !== 'string') {
        norm.note = 'text attachment fetch failed; only metadata is available';
        out.push(norm);
        continue;
      }
      let decoded: string;
      try {
        decoded = Buffer.from(body.file_data, 'base64').toString('utf8');
      } catch {
        norm.note = 'text attachment could not be decoded as UTF-8';
        out.push(norm);
        continue;
      }
      // Same byte cap on the decoded side — base64 size_bytes might
      // under-report when the source was multi-byte UTF-8 but a safe
      // re-check here keeps the prompt budget honest.
      if (Buffer.byteLength(decoded, 'utf8') > MAX_INLINE_TEXT_BYTES) {
        norm.note = `decoded text exceeds inline cap (${MAX_INLINE_TEXT_BYTES} bytes); only metadata included`;
        out.push(norm);
        continue;
      }
      norm.kind = 'text_inline';
      norm.text_content = decoded;
      out.push(norm);
      continue;
    }

    // Binary / unknown mime (PDF, zip, exe, …). Fetch + drop on disk so the
    // subagent can hand the path to its own file/parse tools instead of
    // bouncing back to the user with a download URL. Failure here falls
    // through to metadata_only via the `note` set inside materialize().
    await materialize(config, roomId, norm);
    out.push(norm);
  }
  return out;
}

/** Render a Markdown-ish block listing the prepared attachments for the
 *  prompt body. Used by the chat-room prompt composer so the same text
 *  surface works for every CLI; image content blocks are an additive layer
 *  on top of this (Claude only). */
export function renderAttachmentBlock(attachments: PreparedAttachment[]): string[] {
  if (attachments.length === 0) return [];
  const lines: string[] = [];
  lines.push('Attachments (this turn):');
  for (const att of attachments) {
    const head = `- [${att.filename}] mime=${att.mime_type} size=${att.size_bytes}B id=${att.id}`;
    const trail = att.download_url ? ` url=${att.download_url}` : '';
    lines.push(`${head}${trail}`);
    if (att.note) {
      lines.push(`  note: ${att.note}`);
    }
    if (att.kind === 'image_base64') {
      lines.push('  (image content block attached — read it as you would any vision input)');
    } else if (att.kind === 'materialized_file' && att.local_path) {
      // Surface the absolute path so the subagent can pass it straight to
      // its own file-read / vision tool without re-fetching anything from
      // AWB. Images go through this branch for text-only CLIs (Codex /
      // Antigravity); PDFs and other binaries go through here for everyone.
      lines.push(`  local_path: ${att.local_path}`);
    } else if (att.kind === 'text_inline' && att.text_content !== undefined) {
      const fence = att.text_content.includes('```') ? '~~~' : '```';
      lines.push(`  ${fence}`);
      for (const ln of att.text_content.split('\n')) {
        lines.push(`  ${ln}`);
      }
      lines.push(`  ${fence}`);
    }
  }
  return lines;
}
