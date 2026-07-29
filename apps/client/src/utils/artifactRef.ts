export const ARTIFACT_REF_TYPES = [
  'ticket', 'agent', 'board', 'action', 'function', 'schedule',
] as const;

export type ArtifactRefType = typeof ARTIFACT_REF_TYPES[number];
export const ARTIFACT_TOKEN_RE =
  /#\[(ticket|agent|board|action|function|schedule):([0-9a-fA-F-]{36})\|([^\]\r\n]+)\]/g;

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

export function entityDeepLink(type: ArtifactRefType, id: string, workspaceId: string): string | null {
  const ws = encodeURIComponent(workspaceId);
  const entity = encodeURIComponent(id);
  switch (type) {
    case 'agent': return `/ws/${ws}/agents/${entity}`;
    case 'board': return `/ws/${ws}/boards/${entity}`;
    case 'action': return `/ws/${ws}/actions?artifact=${entity}`;
    case 'function': return `/ws/${ws}/functions?artifact=${entity}`;
    case 'schedule': return `/ws/${ws}/schedules?artifact=${entity}`;
    // Tickets are opened through TicketRefCard because a board id cannot be
    // inferred safely from a ticket id.
    case 'ticket': return null;
  }
}

export function workspaceIdFromPath(pathname: string): string {
  return pathname.match(/\/ws\/([^/]+)/)?.[1] || '';
}
