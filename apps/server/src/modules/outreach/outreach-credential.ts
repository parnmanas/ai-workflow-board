/**
 * Resolve an OutreachChannel's credential into a decrypted token.
 *
 * Deliberately mirrors git-branches.ts's `resolveGitCredential` — NOT
 * GitHubConnectorService.getTokenForCredential, which has no workspace check
 * (bare `findOne({where:{id}})`), swallows failures, and falls back to
 * `process.env.GITHUB_TOKEN` (ticket 2500fea3 planning decision D1).
 * OutreachChannel is a workspace-scoped resource; a bare findOne() would let
 * workspace A's channel resolve workspace B's token. There is intentionally
 * NO env-var fallback here — a missing/invalid credential must fail the poll
 * loudly, not silently degrade to anonymous access or another workspace's
 * identity.
 */
import { Repository } from 'typeorm';
import { Credential } from '../../entities/Credential';
import { decryptStrict } from '../../services/encryption.service';

export class OutreachCredentialResolutionError extends Error {
  readonly code = 'credential_unavailable';
}

export interface OutreachCredential {
  username?: string;
  token: string;
  // Every OTHER string field the credential blob carries beyond
  // username/token/api_key — e.g. Reddit's `client_id`/`client_secret`
  // (ticket d86d0c24 C1). A connector that needs channel-specific fields
  // reads them from here instead of this module growing a per-kind return
  // shape; fields that aren't plain strings (or are empty) are dropped.
  extra: Record<string, string>;
}

/** Accepts a GLOBAL credential (workspace_id=NULL) or one scoped to
 *  `workspaceId`; throws (never silently degrades) for a missing row, a
 *  cross-workspace row, a legacy Board-scoped row, or an unreadable/empty
 *  token. Returns null only when `credentialId` itself is empty — "this
 *  channel has no credential configured" is a valid, callable-safe state. */
export async function resolveOutreachCredential(
  credRepo: Repository<Credential>,
  credentialId: string | null | undefined,
  workspaceId: string,
): Promise<OutreachCredential | null> {
  if (!credentialId) return null;
  const cred = await credRepo.findOne({ where: { id: credentialId } });
  if (!cred) throw new OutreachCredentialResolutionError(`Selected credential ${credentialId} does not exist`);
  if (cred.workspace_id !== null && cred.workspace_id !== workspaceId) {
    throw new OutreachCredentialResolutionError('Selected credential belongs to a different workspace');
  }
  if (cred.board_id !== null && cred.board_id !== undefined) {
    throw new OutreachCredentialResolutionError('Selected credential has not been migrated to Workspace scope');
  }
  try {
    const data = JSON.parse(decryptStrict(cred.encrypted_data));
    const token = String(data.token || data.api_key || '').trim();
    if (!token) throw new OutreachCredentialResolutionError('Selected credential has no token');
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === 'token' || key === 'api_key' || key === 'username') continue;
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) extra[key] = trimmed;
    }
    return { username: data.username ? String(data.username).trim() : undefined, token, extra };
  } catch (err: any) {
    if (err instanceof OutreachCredentialResolutionError) throw err;
    throw new OutreachCredentialResolutionError(`Selected credential is unreadable: ${String(err?.message || err)}`);
  }
}
