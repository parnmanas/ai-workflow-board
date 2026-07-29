export const ARTIFACT_REF_TYPES = [
  'ticket',
  'agent',
  'board',
  'action',
  'function',
  'schedule',
] as const;

export type ArtifactRefType = typeof ARTIFACT_REF_TYPES[number];

export interface ArtifactRef {
  type: ArtifactRefType;
  id: string;
  name: string;
  raw: string;
  index: number;
}

const TYPE_PATTERN = ARTIFACT_REF_TYPES.join('|');
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const ARTIFACT_TOKEN_RE = new RegExp(
  `#\\[(${TYPE_PATTERN}):(${UUID_PATTERN})\\|([^\\]\\r\\n]+)\\]`,
  'gi',
);

export const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'i');

function cleanLabel(value: string): string {
  return value.replace(/[\]\r\n|]+/g, ' ').trim();
}

export function formatArtifactRef(type: ArtifactRefType, id: string, name: string): string {
  if (!ARTIFACT_REF_TYPES.includes(type)) throw new Error(`Unsupported artifact type: ${type}`);
  if (!UUID_RE.test(id)) throw new Error('Artifact references require a full UUID');
  const label = cleanLabel(name);
  if (!label) throw new Error('Artifact references require a human-readable name');
  return `#[${type}:${id}|${label}]`;
}

export function formatUnavailableArtifact(
  type: ArtifactRefType,
  id: string,
  name: string,
  reason: string,
): string {
  const label = cleanLabel(name) || type;
  const stableId = UUID_RE.test(id) ? id : String(id || 'unknown');
  return `${label} (${type} ${stableId}; 연결 불가: ${cleanLabel(reason) || '존재하지 않거나 권한 없음'})`;
}

export function parseArtifactRefs(text: string): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
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

export const ARTIFACT_REF_DOC =
  'ARTIFACT REFERENCES — whenever naming an AWB entity, use the non-notifying clickable token ' +
  '`#[type:<full-uuid>|Human-readable name]`; never identify an entity only by a shortened id. ' +
  'Supported types: ticket, agent, board, action, function, schedule. Examples:\n' +
  '  • `#[ticket:<uuid>|Fix checkout race]`\n' +
  '  • `#[agent:<uuid>|BuildBot]`\n' +
  '  • `#[board:<uuid>|Platform Board]`\n' +
  '  • `#[action:<uuid>|Deploy staging]`\n' +
  '  • `#[function:<uuid>|release_notes]`\n' +
  '  • `#[schedule:<uuid>|Nightly QA]`\n' +
  'Use `@[agent:...]` only when notification/dispatch is intended. Resolve the full id and access first. ' +
  'If the entity is missing or forbidden, do not emit a token or invent a link; state its name, stable full id, ' +
  'and why it cannot be linked.';
