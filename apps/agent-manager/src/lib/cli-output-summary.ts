// Compact, human-readable summaries of CLI stream-json events for the
// silent-exit fallback tail (ticket ac958c06).
//
// Background: when a persistent CLI session (claude/deepseek stream-json) or a
// one-shot subagent (`--output-format json`) dies without leaving a ticket
// comment, the agent-manager posts a "silent-exit" system comment whose body
// SHOULD carry the last few lines of CLI output so an operator can see WHY it
// died. But the tail ring used to buffer only NON-JSON stdout + bare stderr —
// and in stream-json mode every stdout line IS a JSON event, so the ring was
// almost always empty → "(no buffered CLI output captured)". The diagnostic
// signal (the `result` event's subtype/is_error/text, the assistant's last
// text + tool_use names, error/tool_result-error events) lives INSIDE those
// discarded JSON events.
//
// This module turns a single stream-json line into a short prose line for the
// tail. Pure + side-effect-free so it can be unit-tested directly, and shared
// by both buffering paths (base-session-manager + subagent-manager) so the
// fallback body is identical whether the agent ran persistent or one-shot.

/** Per-event cap so one giant assistant message / result blob can't dominate
 *  the bounded tail ring. The tail is trimmed again (to ~4KB) at collect time;
 *  this just keeps any single line readable. */
const PER_EVENT_MAX_CHARS = 600;

function clip(s: string, max = PER_EVENT_MAX_CHARS): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** Flatten a Claude/Anthropic `message.content` array into a prose line:
 *  text blocks verbatim, tool_use blocks as `→ tool(<name>)`, tool_result
 *  errors as `✗ tool_result error: …`. Returns '' when nothing notable. */
function summarizeContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) {
    // Some providers put a bare string in `content`.
    return typeof content === 'string' ? clip(content) : '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, any>;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim());
        break;
      case 'thinking':
        // Thinking is verbose and rarely the cause of death; keep a short hint.
        if (typeof b.thinking === 'string' && b.thinking.trim()) {
          parts.push('(thinking)');
        }
        break;
      case 'tool_use':
        if (typeof b.name === 'string') parts.push(`→ tool(${b.name})`);
        break;
      case 'tool_result': {
        // Only surface FAILED tool results — successful ones are noise.
        if (b.is_error === true) {
          const inner =
            typeof b.content === 'string'
              ? b.content
              : summarizeContentBlocks(b.content);
          parts.push(`✗ tool_result error: ${inner}`);
        }
        break;
      }
      default:
        break;
    }
  }
  return clip(parts.join(' '));
}

/**
 * Summarize a single CLI stdout line for the silent-exit tail.
 *
 * Returns a short prose line for diagnostic stream-json events, or `null` when
 * the line carries no useful signal (init banners, normal tool_result echoes,
 * unparseable/empty input) so callers can skip it and keep the tail meaningful.
 *
 * Recognized claude/deepseek stream-json shapes (`obj.type`):
 *   - `assistant`  → the model's last text + tool_use names (what it was doing)
 *   - `user`       → only tool_result ERRORS (skips normal results)
 *   - `result`     → `result: subtype=… is_error=… turns=…` + result text on
 *                    error (THE key diagnostic for a crashed/limit-hit turn)
 *   - `error` / `stream_error` → the error message verbatim
 *   - `system`     → skipped (init/setup noise)
 *
 * Unknown shapes that still carry an obvious error field (`error`/`message`
 * with `is_error`) get a generic fallback so non-claude CLIs aren't silent.
 */
export function summarizeCliJsonLine(line: string): string | null {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || trimmed[0] !== '{') return null;

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  switch (obj.type) {
    case 'assistant': {
      const summary = summarizeContentBlocks(obj.message?.content);
      return summary ? `assistant: ${summary}` : null;
    }
    case 'user': {
      // Tool results echoed back to the model. Only errors are worth keeping.
      const summary = summarizeContentBlocks(obj.message?.content);
      return summary ? summary : null;
    }
    case 'result': {
      const subtype = obj.subtype ?? (obj.is_error ? 'error' : 'success');
      const bits = [`result: subtype=${subtype}`, `is_error=${obj.is_error === true}`];
      if (typeof obj.num_turns === 'number') bits.push(`turns=${obj.num_turns}`);
      let head = bits.join(' ');
      // A `result` carries the final answer/error text in `.result` (claude) or
      // `.error`. Surface it whenever present — on error it's the cause; on a
      // clean exit-0-no-comment it's "what the agent decided to do instead".
      const text =
        typeof obj.result === 'string'
          ? obj.result
          : typeof obj.error === 'string'
            ? obj.error
            : '';
      if (text.trim()) head += ` — ${clip(text)}`;
      return head;
    }
    case 'error':
    case 'stream_error': {
      const text =
        typeof obj.error === 'string'
          ? obj.error
          : typeof obj.message === 'string'
            ? obj.message
            : JSON.stringify(obj);
      return `error: ${clip(text)}`;
    }
    case 'system':
      // init/setup metadata — proves a start, not a death. Skip as noise.
      return null;
    default: {
      // Unknown event type: keep it only if it obviously reports a failure.
      if (obj.is_error === true || obj.error) {
        const text =
          typeof obj.error === 'string' ? obj.error : JSON.stringify(obj);
        return `error: ${clip(text)}`;
      }
      return null;
    }
  }
}
