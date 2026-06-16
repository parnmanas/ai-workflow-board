import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { LogService } from '../../services/log.service';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';

/**
 * ST-4 — short-lived pairing tokens that an admin mints from the AWB UI and
 * the awb-agent-manager redeems on first run.
 *
 * Storage is intentionally in-memory: a token is one-shot, scoped to a single
 * workspace, and TTL'd at 10 minutes. Surviving restart isn't worth a
 * persistence layer — if the admin restarts AWB while a token is in flight
 * they regenerate.
 */

export interface PairingToken {
  id: string;
  token: string;             // raw bearer the manager sends back on redeem
  code: string;              // 6-char human-readable display code (admin reads aloud / pastes)
  workspace_id: string;
  created_by_user_id: string;
  // Optional: when set, the redeemed agent identity is created with this
  // name. Otherwise the manager picks (e.g. hostname-derived).
  agent_name?: string;
  created_at: string;        // ISO
  expires_at: string;        // ISO
  redeemed_at: string | null;
  redeemed_instance_id: string | null;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

@Injectable()
export class PairingService implements OnModuleDestroy {
  private readonly tokens = new Map<string, PairingToken>(); // keyed by raw token
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly logService: LogService,
    metrics: MemoryMetricsRegistry,
  ) {
    metrics.register('agentManager.pairingTokens', () => this.tokens.size);
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.timer && typeof (this.timer as any).unref === 'function') {
      (this.timer as any).unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  mint(params: { workspace_id: string; created_by_user_id: string; agent_name?: string }): PairingToken {
    const id = randomBytes(8).toString('hex');
    const token = 'pair_' + randomBytes(20).toString('hex');
    // 6-char alphanumeric — humans paste this into the manager CLI. Drop
    // ambiguous chars (0/O/1/I/l) so a phone-photo-then-type round-trip
    // doesn't silently fail.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(randomBytes(6))
      .map((b) => alphabet[b % alphabet.length])
      .join('');
    const now = new Date();
    const rec: PairingToken = {
      id,
      token,
      code,
      workspace_id: params.workspace_id,
      created_by_user_id: params.created_by_user_id,
      agent_name: params.agent_name,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
      redeemed_at: null,
      redeemed_instance_id: null,
    };
    this.tokens.set(token, rec);
    this.logService.info('AgentManager', `Minted pairing token id=${id} ws=${params.workspace_id}`);
    return rec;
  }

  /**
   * One-shot lookup; consumes the token if still valid + unused. Returns
   * null on any failure (unknown / expired / already redeemed) so the caller
   * just emits a 401 without leaking which condition triggered it.
   */
  redeem(token: string, instanceId: string): PairingToken | null {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (rec.redeemed_at) return null;
    if (Date.now() > new Date(rec.expires_at).getTime()) {
      this.tokens.delete(token);
      return null;
    }
    rec.redeemed_at = new Date().toISOString();
    rec.redeemed_instance_id = instanceId || null;
    return rec;
  }

  /**
   * Admin UI listing — masks the raw token so a UI screenshot doesn't leak
   * the bearer. The display code is what the human types into the manager;
   * the raw token is returned ONCE on mint() and then never again.
   */
  listForWorkspace(workspaceId: string): Array<Omit<PairingToken, 'token'>> {
    const out: Array<Omit<PairingToken, 'token'>> = [];
    for (const rec of this.tokens.values()) {
      if (rec.workspace_id !== workspaceId) continue;
      const { token: _t, ...safe } = rec;
      out.push(safe);
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * Resolve a display code (the 6-char human one) back to the full token.
   * The redeem endpoint uses this when the operator typed the code instead
   * of pasting the raw token.
   */
  findByCode(code: string): PairingToken | null {
    if (!code) return null;
    const normalized = code.trim().toUpperCase();
    for (const rec of this.tokens.values()) {
      if (rec.code === normalized && !rec.redeemed_at) {
        if (Date.now() <= new Date(rec.expires_at).getTime()) return rec;
      }
    }
    return null;
  }

  revoke(id: string, workspaceId: string): boolean {
    for (const [token, rec] of this.tokens) {
      if (rec.id !== id) continue;
      if (rec.workspace_id !== workspaceId) return false;
      this.tokens.delete(token);
      return true;
    }
    return false;
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [token, rec] of this.tokens) {
      if (now > new Date(rec.expires_at).getTime()) {
        this.tokens.delete(token);
        removed++;
      }
    }
    if (removed > 0) {
      this.logService.debug('AgentManager', `Swept ${removed} expired pairing token(s)`);
    }
  }
}
