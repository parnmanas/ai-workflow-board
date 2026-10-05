import { open, stat } from 'node:fs/promises';
import type { CliAsyncQuestion, CliAsyncQuestionWatcher } from '../cli-module.js';

/** Codex emits request_user_input_async as an AgentMessage, not an ACP elicitation. */
export function codexAsyncQuestion(record: any): CliAsyncQuestion | null {
  const item = record?.payload?.item;
  if (record?.type !== 'event_msg' || record.payload?.type !== 'item_completed'
    || item?.type !== 'AgentMessage' || item.delivery !== 'async'
    || typeof item.id !== 'string' || !item.id || !Array.isArray(item.questions) || !item.questions.length) return null;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const titles: string[] = [];
  for (const [i, question] of item.questions.slice(0, 3).entries()) {
    if (typeof question?.title !== 'string' || !question.title.trim()) continue;
    const name = `q_${i + 1}`;
    const title = question.title.trim().slice(0, 2000);
    const options = Array.isArray(question.options)
      ? [...new Set(question.options.filter((v: unknown) => typeof v === 'string' && v).map((v: string) => v.slice(0, 500)))].slice(0, 12)
      : [];
    properties[name] = options.length ? {
      type: 'string', title,
      oneOf: [...options.map((value) => ({ const: value, title: value })), { const: '__other__', title: 'Other / 직접 입력' }],
    } : { type: 'string', title };
    if (options.length) properties[`${name}_note`] = { type: 'string', title: `${title} — additional answer / 직접 입력` };
    titles.push(title);
    required.push(name);
  }
  return required.length ? { id: item.id.slice(0, 180), message: titles.join('\n'), schema: { type: 'object', properties, required } } : null;
}

/** Incremental reads keep a large rollout cheap and never replay questions from an older turn. */
export async function watchCodexAsyncQuestions(
  findFile: () => Promise<string | null>,
  receive: (question: CliAsyncQuestion) => void,
): Promise<CliAsyncQuestionWatcher> {
  let path = await findFile();
  let offset = path ? (await stat(path)).size : 0;
  let carry = '';
  let closed = false;
  let inFlight: Promise<void> | null = null;
  const seen = new Set<string>();
  const read = async () => {
    if (closed) return;
    path ||= await findFile();
    if (!path || closed) return;
    const file = await open(path, 'r');
    try {
      const size = (await file.stat()).size;
      if (size < offset) { offset = 0; carry = ''; }
      while (!closed && offset < size) {
        const buffer = Buffer.alloc(Math.min(256 * 1024, size - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        // Keep bytes until a complete line: a write can split a multibyte Korean character.
        offset += bytesRead;
        carry += buffer.subarray(0, bytesRead).toString('latin1');
        let end: number;
        while ((end = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, end);
          carry = carry.slice(end + 1);
          if (line.length > 64 * 1024 || !line.includes('"questions"')) continue;
          try {
            const question = codexAsyncQuestion(JSON.parse(Buffer.from(line, 'latin1').toString('utf8')));
            if (question && !closed && !seen.has(question.id)) {
              seen.add(question.id);
              if (seen.size > 4096) seen.delete(seen.values().next().value!);
              receive(question);
            }
          } catch { /* incomplete/invalid native record */ }
        }
        if (carry.length > 64 * 1024) carry = ''; // bound an oversized incomplete record
      }
    } finally { await file.close(); }
  };
  const poll = () => {
    if (inFlight) return inFlight;
    inFlight = read().catch(() => undefined).finally(() => { inFlight = null; });
    return inFlight;
  };
  const timer = setInterval(() => { void poll(); }, 500);
  timer.unref();
  return { poll, close: () => { closed = true; clearInterval(timer); } };
}
