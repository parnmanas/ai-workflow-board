import { Injectable } from '@nestjs/common';
import { DiscordUserProvider } from './discord.provider';
import { SlackUserProvider } from './slack.provider';
import { TelegramUserProvider } from './telegram.provider';
import { INotificationProvider, ProviderId } from './types';

/**
 * Lookup table for user-channel notification providers.
 *
 * Adding a new provider: implement `INotificationProvider`, register it in
 * the constructor below, and extend `ProviderId` in `types.ts`. The REST /
 * dispatcher / UI layers all walk through this registry rather than knowing
 * about concrete provider classes.
 */
@Injectable()
export class NotificationProviderRegistry {
  private readonly byId = new Map<ProviderId, INotificationProvider>();

  constructor(
    discord: DiscordUserProvider,
    slack: SlackUserProvider,
    telegram: TelegramUserProvider,
  ) {
    for (const p of [discord, slack, telegram] as INotificationProvider[]) {
      this.byId.set(p.id, p);
    }
  }

  get(id: string): INotificationProvider | null {
    return this.byId.get(id as ProviderId) || null;
  }

  list(): INotificationProvider[] {
    return [...this.byId.values()];
  }

  isSupported(id: string): boolean {
    return this.byId.has(id as ProviderId);
  }
}
