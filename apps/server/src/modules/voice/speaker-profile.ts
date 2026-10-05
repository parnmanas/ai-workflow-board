import type { DataSource } from 'typeorm';
import { encrypt, decrypt } from '../../services/encryption.service';

export interface SpeakerProfile {
  enabled: boolean;
  threshold: number;
  model: string;
  embeddings: number[][];
  updated_at: string;
}
export interface SpeakerProfileView {
  enrolled: boolean;
  enabled: boolean;
  threshold: number;
  samples: number;
  updated_at: string | null;
}

// Outside voice.*: never included in engine config or the editable admin settings catalog.
const keyFor = (userId: string) => `voice-speaker-profile.${userId}`;

export async function readSpeakerProfile(source: DataSource, userId: string): Promise<SpeakerProfile | null> {
  const row = await source.getRepository('SystemSetting').findOne({ where: { key: keyFor(userId) } });
  if (!row) return null;
  const profile = JSON.parse(decrypt(row.value)) as SpeakerProfile;
  if (!profile.model || !Array.isArray(profile.embeddings) || !profile.embeddings.length
    || profile.embeddings.some((e) => !validSpeakerEmbedding(e))) throw new Error('Invalid voice profile. Re-enroll in Voice.');
  return profile;
}

export function validSpeakerEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length >= 32 && value.length <= 2048
    && value.every((n) => typeof n === 'number' && Number.isFinite(n)) && value.some((n) => n !== 0);
}

export function speakerSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1;
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
  return dot / Math.sqrt(a.reduce((sum, n) => sum + n * n, 0) * b.reduce((sum, n) => sum + n * n, 0));
}

export function speakerProfileView(profile: SpeakerProfile | null): SpeakerProfileView {
  return {
    enrolled: !!profile, enabled: profile?.enabled ?? false, threshold: profile?.threshold ?? 0.6,
    samples: profile?.embeddings.length ?? 0, updated_at: profile?.updated_at ?? null,
  };
}

export async function saveSpeakerProfile(source: DataSource, userId: string, profile: SpeakerProfile): Promise<void> {
  const repo = source.getRepository('SystemSetting');
  await repo.save(repo.create({ key: keyFor(userId), value: encrypt(JSON.stringify(profile)), is_secret: 1,
    description: 'Private speaker embeddings. Managed only through the authenticated Voice profile API.' }));
}

export async function deleteSpeakerProfile(source: DataSource, userId: string): Promise<void> {
  await source.getRepository('SystemSetting').delete({ key: keyFor(userId) });
}
