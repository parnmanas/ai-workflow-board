export type MarkdownFenceSegment =
  | { kind: 'text'; text: string; start: number; end: number }
  | { kind: 'code'; text: string; code: string; language: string; start: number; end: number };

/** Keep fenced content literal, including incomplete blocks arriving in a stream. */
export function splitMarkdownFences(text: string): MarkdownFenceSegment[] {
  const segments: MarkdownFenceSegment[] = [];
  const lines = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/gm;
  let cursor = 0;
  let opening: RegExpExecArray | null;
  while ((opening = lines.exec(text))) {
    const fence = opening[1];
    if (fence[0] === '`' && opening[2].includes('`')) continue;
    if (opening.index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, opening.index), start: cursor, end: opening.index });
    const bodyStart = text[lines.lastIndex] === '\n' ? lines.lastIndex + 1 : lines.lastIndex;
    let bodyEnd = text.length;
    let end = text.length;
    let closing: RegExpExecArray | null;
    while ((closing = lines.exec(text))) {
      if (closing[1][0] === fence[0] && closing[1].length >= fence.length && !closing[2].trim()) {
        bodyEnd = closing.index;
        end = lines.lastIndex;
        break;
      }
    }
    segments.push({ kind: 'code', text: text.slice(opening.index, end), code: text.slice(bodyStart, bodyEnd), language: opening[2].trim().split(/\s+/)[0] || '', start: opening.index, end });
    cursor = end;
    if (!closing) break;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor), start: cursor, end: text.length });
  return segments;
}
