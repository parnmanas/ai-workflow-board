import { splitMarkdownFences } from './markdownFences';

export interface MathRange {
  start: number;
  end: number;
  value: string;
  display: boolean;
  closed: boolean;
}

/** Code examples (including unfinished fences) must never become math or media. */
export function markdownCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const segment of splitMarkdownFences(text)) {
    if (segment.kind === 'code') {
      ranges.push([segment.start, segment.end]);
      continue;
    }
    const ticks = /`+/g;
    let opening: RegExpExecArray | null;
    while ((opening = ticks.exec(segment.text))) {
      let closing: RegExpExecArray | null;
      while ((closing = ticks.exec(segment.text))) {
        if (closing[0].length === opening[0].length) break;
      }
      if (!closing) break;
      ranges.push([segment.start + opening.index, segment.start + ticks.lastIndex]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Recognize CLI math delimiters before Markdown can consume their backslashes.
 * Single dollars require non-space boundaries and cannot end before a digit,
 * so ordinary prices such as "$5 and $10" stay text. Incomplete explicit math
 * stays literal while a streamed response is arriving.
 */
export function markdownMathRanges(text: string): MathRange[] {
  const code = markdownCodeRanges(text);
  const ranges: MathRange[] = [];
  let codeIndex = 0;
  for (let i = 0; i < text.length; i++) {
    while (code[codeIndex] && code[codeIndex][1] <= i) codeIndex++;
    if (code[codeIndex] && i >= code[codeIndex][0]) {
      i = code[codeIndex][1] - 1;
      continue;
    }
    // Link destinations and bare URLs are data, even when they contain dollars.
    if (text.startsWith('](', i)) {
      let depth = 1;
      let end = i + 2;
      for (; end < text.length && depth; end++) {
        if (text[end] === '\\') end++;
        else if (text[end] === '(') depth++;
        else if (text[end] === ')') depth--;
        else if (text[end] === '\n') break;
      }
      if (!depth) { i = end - 1; continue; }
    }
    if (text.startsWith('https://', i) || text.startsWith('http://', i)) {
      while (i + 1 < text.length && !/[\s<>]/.test(text[i + 1])) i++;
      continue;
    }
    const pair = text.slice(i, i + 2);
    const opening = pair === '\\[' || pair === '\\(' || pair === '$$' ? pair : text[i] === '$' ? '$' : '';
    if (!opening) {
      if (text[i] === '\\') i++; // Escaped backslashes/dollars are literal.
      continue;
    }
    const single = opening === '$';
    if (single && (!text[i + 1] || /\s/.test(text[i + 1]))) continue;
    const closing = opening === '\\[' ? '\\]' : opening === '\\(' ? '\\)' : opening;
    let end = -1;
    for (let j = i + opening.length; j < text.length; j++) {
      if (single && text[j] === '\n') break;
      if (code[codeIndex] && j >= code[codeIndex][0]) break;
      if (text.startsWith(closing, j)) {
        if (single && (/\s/.test(text[j - 1]) || /\d/.test(text[j + 1] || '') || text[j + 1] === '$')) break;
        end = j;
        break;
      }
      if (text[j] === '\\') j++;
    }
    if (end < 0 && single) continue;
    const stop = end < 0 ? (code[codeIndex]?.[0] ?? text.length) : end + closing.length;
    ranges.push({ start: i, end: stop, value: text.slice(i + opening.length, end < 0 ? stop : end), display: opening === '\\[' || opening === '$$', closed: end >= 0 });
    i = stop - 1;
  }
  return ranges;
}
