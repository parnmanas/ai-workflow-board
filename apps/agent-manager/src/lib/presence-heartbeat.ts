import { HEARTBEAT_INTERVAL_MS, REQUEST_TIMEOUT_MS } from './constants.js';
import { log } from './logging.js';
import type { AwbConfig } from './rest.js';

/**
 * Periodically stamp `last_seen_at` on the AWB Agent row so the dashboard
 * keeps this agent marked online. The server's 90-second sweep flips
 * is_online=0 the moment a heartbeat lapses past that window, so we tick
 * every HEARTBEAT_INTERVAL_MS (30s by default).
 *
 * Single REST POST per tick. Fires once immediately on start() so the
 * dashboard reflects online status within the first second of the process's
 * lifetime instead of waiting 30s.
 */
export class PresenceHeartbeat {
  #config: AwbConfig;
  #agentId: string | null;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(config: AwbConfig, agentId: string | null) {
    this.#config = config;
    this.#agentId = agentId;
  }

  start(): void {
    if (!this.#agentId) {
      log('Presence heartbeat skipped — agent_id not in agent.json (run pairing first)');
      return;
    }
    this.#stopped = false;
    this.#ping().catch((err) =>
      log(`Presence ping (initial) failed: ${err?.message ?? err}`),
    );
    this.#timer = setInterval(() => {
      this.#ping().catch((err) =>
        log(`Presence ping failed: ${err?.message ?? err}`),
      );
    }, HEARTBEAT_INTERVAL_MS);
    this.#timer.unref?.();
    log(
      `Presence heartbeat started (agent=${this.#agentId.slice(0, 8)} interval=${HEARTBEAT_INTERVAL_MS / 1000}s)`,
    );
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Force an immediate ping outside the 30s tick. Called on SSE reconnect so
   * the dashboard recovers ONLINE within seconds of a server restart.
   */
  async pingNow(): Promise<void> {
    if (this.#stopped || !this.#agentId) return;
    try {
      await this.#ping();
    } catch (err: any) {
      log(`Presence ping (forced) failed: ${err?.message ?? err}`);
    }
  }

  async #ping(): Promise<void> {
    if (this.#stopped) return;
    const url = `${this.#config.url.replace(/\/$/, '')}/api/agent/ping`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Key': this.#config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agent_id: this.#agentId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new Error(`POST /api/agent/ping HTTP ${resp.status}`);
    }
    await resp.text().catch(() => null);
  }
}
