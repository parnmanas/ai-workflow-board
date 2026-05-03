/**
 * Common types for the user-channel notification provider abstraction.
 *
 * Each provider (discord/slack/telegram) implements `INotificationProvider`
 * and is dispatched to per UserChannel binding by `notification-dispatcher.service.ts`.
 *
 * `target` and `credentials` are stored on UserChannel; provider implementations
 * are responsible for parsing their own provider-specific shape out of those.
 */

export type ProviderId = 'discord' | 'slack' | 'telegram';

export const PROVIDER_IDS: ProviderId[] = ['discord', 'slack', 'telegram'];

export interface NotifyPayload {
  /** Short single-line title; surfaced as the message header. */
  title: string;
  /** Plain-text body. Providers strip / down-format markdown as needed. */
  body: string;
  /** Optional deep-link back into AWB (board / ticket / chat-room view). */
  url?: string;
  /** Free-form actor display name shown in the body. */
  actor?: string;
}

export interface ProviderResult {
  ok: boolean;
  error?: string;
}

export interface INotificationProvider {
  readonly id: ProviderId;

  /**
   * Send a notification to the configured `target` using the decrypted
   * credential blob for this binding. Returns ok=false (with error) on any
   * provider-side failure rather than throwing — the dispatcher logs and
   * moves on rather than killing the whole event loop.
   */
  send(target: string, credentials: Record<string, string>, payload: NotifyPayload): Promise<ProviderResult>;

  /**
   * Probe the configured target to confirm the credentials are valid and the
   * target is reachable. Used by the "test" REST endpoint and to set
   * verified_at on a successful save.
   */
  test(target: string, credentials: Record<string, string>): Promise<ProviderResult>;
}
