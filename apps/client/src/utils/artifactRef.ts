// `board` was dropped with boards (docs/tickets.md) — an old `#[board:…]` token
// in a stored message now renders as plain text.
export const ARTIFACT_REF_TYPES = [
  'ticket', 'agent', 'action', 'function', 'schedule',
] as const;

export type ArtifactRefType = typeof ARTIFACT_REF_TYPES[number];
export const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
export const ARTIFACT_TOKEN_RE =
  new RegExp(`#\\[(ticket|agent|action|function|schedule):(${UUID_PATTERN})\\|([^\\]\\r\\n]+)\\]`, 'g');

export interface ParsedArtifactRef {
  type: ArtifactRefType;
  id: string;
  name: string;
  raw: string;
  index: number;
}

export function parseArtifactRefs(text: string): ParsedArtifactRef[] {
  const refs: ParsedArtifactRef[] = [];
  ARTIFACT_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ARTIFACT_TOKEN_RE.exec(text)) !== null) {
    refs.push({
      type: match[1] as ArtifactRefType,
      id: match[2],
      name: match[3],
      raw: match[0],
      index: match.index,
    });
  }
  return refs;
}
