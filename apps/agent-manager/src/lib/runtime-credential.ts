/**
 * The one rule for accepting an AWB credential before a CLI process runs on it.
 *
 * Two places start CLI processes on a selected credential: Agent Sessions
 * (`agent-session-runner.ts` → `#prepareAuth`) and runtime identities
 * (`agent-manager-commands.ts` → `materializeRuntimeIdentity`, which spawn_agent,
 * restart_agent and every ticket / chat / mention / mission-step context go
 * through). They used to validate on their own — one threw, the other quietly
 * fell back to the operator's login — so the same credential worked in a
 * session and failed in a ticket. Both now accept a credential only here.
 *
 * Fail-closed: a credential that was selected but cannot be used throws a
 * coded error. Running on the operator's login instead is never a fallback
 * for a selected credential.
 */

import { log } from './logging.js';
import { normalizeCredentialFields } from './credential-fields.js';
import { findCliModule, requiredCredentialFields } from './clis/index.js';

export interface RuntimeCredential {
  credential_id: string;
  provider: string;
  fields: Record<string, string>;
}

export type RuntimeCredentialErrorCode =
  | 'credential_unsupported'
  | 'credential_unavailable'
  | 'credential_provider_mismatch'
  | 'credential_incomplete';

export class RuntimeCredentialError extends Error {
  constructor(readonly code: RuntimeCredentialErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeCredentialError';
  }
}

/**
 * Validate what AWB returned for `credentialId` and return it with its fields
 * normalized (`credential-fields.ts`). `fetched` is null when AWB returned
 * nothing (no grant, decrypt failure, network).
 */
export function acceptRuntimeCredential(
  cli: string,
  credentialId: string,
  fetched: RuntimeCredential | null,
  logLabel: string,
): RuntimeCredential {
  const prefix = findCliModule(cli)?.credentials?.prefix;
  if (!prefix) throw new RuntimeCredentialError('credential_unsupported', `${cli} cannot use an AWB credential.`);
  if (!fetched || fetched.credential_id !== credentialId) {
    throw new RuntimeCredentialError(
      'credential_unavailable',
      `The selected credential ${credentialId.slice(0, 8)} could not be fetched from AWB.`,
    );
  }
  if (!fetched.provider.startsWith(prefix)) {
    throw new RuntimeCredentialError('credential_provider_mismatch', `Credential provider ${fetched.provider} does not match ${cli}.`);
  }
  // Whitespace inside a single-line secret (a `claude setup-token` value copied
  // out of a wrapped terminal) breaks the Authorization header on every request.
  const { fields, repaired } = normalizeCredentialFields(fetched.fields);
  if (repaired.length) {
    log(`${logLabel}: credential ${credentialId.slice(0, 8)} whitespace repaired in: ${repaired.join(', ')} — re-save it in Settings → Credentials.`);
  }
  const missing = (requiredCredentialFields(fetched.provider) ?? []).filter((key) => !fields[key]);
  if (missing.length) {
    throw new RuntimeCredentialError(
      'credential_incomplete',
      `Credential ${fetched.provider} is missing ${missing.join(', ')} — re-save it in Settings → Credentials.`,
    );
  }
  return { credential_id: fetched.credential_id, provider: fetched.provider, fields };
}
