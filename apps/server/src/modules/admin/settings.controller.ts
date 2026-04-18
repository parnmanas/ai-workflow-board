import { Controller, Get, Patch, Body, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from '../../entities/SystemSetting';
import { AdminGuard } from '../../common/guards/admin.guard';
import { encrypt, decrypt } from '../../services/encryption.service';
import { maskSecret } from '../../common/mask';

const SETTING_DEFINITIONS: Record<string, { description: string; is_secret: boolean; default_value: string }> = {
  'embedding.provider': { description: 'Embedding provider (openai or none)', is_secret: false, default_value: 'none' },
  'embedding.api_key': { description: 'API key for the embedding provider', is_secret: true, default_value: '' },
  'embedding.model': { description: 'Embedding model name', is_secret: false, default_value: 'text-embedding-3-small' },
};

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
      results.push({
        key,
        value: def.is_secret && existing.value ? maskSecret(decrypt(existing.value)) : existing.value,
        updated_at: existing.updated_at,
      });
    }

    return res.json({ success: true, updated: results });
  }
}

function isMasked(value: string): boolean {
  return value.includes('••••');
}
