import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Body, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from '../../entities/SystemSetting';
import { AdminGuard } from '../../common/guards/admin.guard';
import { encrypt, decrypt } from '../../services/encryption.service';
import { maskSecret } from '../../common/mask';
import { sessionStore, DEFAULT_MAX_SESSIONS } from '../../modules/mcp/internal/session-store';

const SETTING_DEFINITIONS: Record<string, { description: string; is_secret: boolean; default_value: string }> = {
  'embedding.provider': { description: 'Embedding provider (openai or none)', is_secret: false, default_value: 'none' },
  'embedding.api_key': { description: 'API key for the embedding provider', is_secret: true, default_value: '' },
  'embedding.model': { description: 'Embedding model name', is_secret: false, default_value: 'text-embedding-3-small' },
  'mcp.max_sessions': {
    description: 'Hard cap on concurrent MCP sessions. When exceeded, the oldest-idle session is evicted (LRU). Idle sessions still expire after 10 minutes regardless.',
    is_secret: false,
    default_value: String(DEFAULT_MAX_SESSIONS),
  },
  // Self-improvement remote AWB target. Only consulted when a board has
  // `self_improvement_mode` set to 'remote_awb' or 'both'. The API key is
  // never sent to subagents — `create_remote_improvement_ticket` reads it
  // server-side and forwards directly to the remote instance.
  'self_improvement.remote_awb_url': {
    description: 'Base URL of the remote AWB instance that hosts improvement tickets (e.g. https://awb.example.com). Leave blank to disable remote filing.',
    is_secret: false,
    default_value: '',
  },
  'self_improvement.remote_awb_workspace_id': {
    description: 'Workspace ID on the remote AWB instance where improvement tickets land.',
    is_secret: false,
    default_value: '',
  },
  'self_improvement.remote_awb_board_id': {
    description: 'Board ID on the remote AWB instance where improvement tickets land.',
    is_secret: false,
    default_value: '',
  },
  'self_improvement.remote_awb_column_id': {
    description: 'Column ID on the remote AWB board to drop new improvement tickets into (typically Backlog / To Do).',
    is_secret: false,
    default_value: '',
  },
  'self_improvement.remote_awb_api_key': {
    description: 'API key for authenticating to the remote AWB instance. Stored encrypted; never exposed to subagents.',
    is_secret: true,
    default_value: '',
  },
};

/**
 * Pushes the value freshly-saved-to-DB into the running process. Settings
 * with side effects beyond the DB row (i.e., they configure live state
 * somewhere in the app) opt in here. Called from update() after the row
 * is persisted; new keys with no side effect can omit the entry.
 */
function applyLiveSettingChange(key: string, rawValue: string): void {
  if (key === 'mcp.max_sessions') {
    const n = parseInt(rawValue, 10);
    if (Number.isFinite(n) && n > 0) sessionStore.setMaxSessions(n);
  }
}

@ApiBearerAuth('user-session')
@ApiTags('settings')
@Controller('api/admin/settings')
@UseGuards(AdminGuard)
export class SettingsController {
  constructor(
    @InjectRepository(SystemSetting) private readonly settingRepo: Repository<SystemSetting>,
  ) {}

  @Get()
  async list(@Res() res: Response) {
    const rows = await this.settingRepo.find();
    const rowMap = new Map(rows.map(r => [r.key, r]));

    const settings = Object.entries(SETTING_DEFINITIONS).map(([key, def]) => {
      const row = rowMap.get(key);
      let value = row?.value ?? def.default_value;
      if (def.is_secret && value) {
        value = maskSecret(decrypt(value));
      }
      return {
        key,
        value,
        description: def.description,
        is_secret: def.is_secret,
        updated_at: row?.updated_at || null,
      };
    });

    return res.json(settings);
  }

  @Patch()
  async update(@Body() body: any, @Res() res: Response) {
    const { settings } = body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'settings object is required' });
    }

    const results: any[] = [];
    for (const [key, value] of Object.entries(settings) as [string, string][]) {
      if (!SETTING_DEFINITIONS[key]) continue;
      const def = SETTING_DEFINITIONS[key];

      if (def.is_secret && value && isMasked(value)) continue;

      const storeValue = def.is_secret && value ? encrypt(value) : (value ?? '');

      let existing = await this.settingRepo.findOne({ where: { key } });
      if (existing) {
        existing.value = storeValue;
        existing = await this.settingRepo.save(existing);
      } else {
        existing = await this.settingRepo.save(this.settingRepo.create({
          key,
          value: storeValue,
          description: def.description,
          is_secret: def.is_secret ? 1 : 0,
        }));
      }
      // Push the saved value into any live in-process consumer. Non-secret
      // values are stored as-is; secrets aren't piped through this path
      // (no current setting needs live propagation of an encrypted value).
      if (!def.is_secret) {
        applyLiveSettingChange(key, storeValue);
      }
      results.push({
        key,
        value: def.is_secret && existing.value ? maskSecret(decrypt(existing.value)) : existing.value,
        updated_at: existing.updated_at,
      });
    }

    return res.json({ success: true, updated: results });
  }

  /**
   * Probe the configured remote AWB target so the admin can verify the
   * URL + API key combo works before relying on `create_remote_improvement_ticket`
   * to fire in production. Hits the remote `/api/health` endpoint with the
   * stored X-Agent-Key. Returns { ok, status, message } — never echoes the key
   * back, never returns the raw remote body (just status + a short reason).
   *
   * Auth: AdminGuard at the class level already covers it.
   */
  @Post('self-improvement/test')
  async testRemoteTarget(@Res() res: Response) {
    const rows = await this.settingRepo.find({
      where: [
        { key: 'self_improvement.remote_awb_url' },
        { key: 'self_improvement.remote_awb_api_key' },
      ],
    });
    const byKey = new Map(rows.map(r => [r.key, r.value]));
    const remoteUrl = (byKey.get('self_improvement.remote_awb_url') || '').trim().replace(/\/$/, '');
    const rawKey = byKey.get('self_improvement.remote_awb_api_key') || '';
    if (!remoteUrl) {
      return res.status(400).json({ ok: false, message: 'remote_awb_url is not set' });
    }
    if (!rawKey) {
      return res.status(400).json({ ok: false, message: 'remote_awb_api_key is not set' });
    }
    const apiKey = decrypt(rawKey);
    if (!apiKey) {
      return res.status(400).json({ ok: false, message: 'remote_awb_api_key failed to decrypt — re-save the key' });
    }

    const url = `${remoteUrl}/api/health`;
    try {
      const r = await fetch(url, { headers: { 'X-Agent-Key': apiKey } });
      if (!r.ok) {
        return res.json({ ok: false, status: r.status, message: `Remote returned HTTP ${r.status}` });
      }
      return res.json({ ok: true, status: r.status, message: 'Remote AWB reachable' });
    } catch (e: any) {
      return res.json({ ok: false, message: `Network error: ${e?.message || e}` });
    }
  }
}

function isMasked(value: string): boolean {
  return value.includes('••••');
}
