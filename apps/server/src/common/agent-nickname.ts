/** A display-only alias, safe to include in an @[agent:id|nickname] token. */
export function normalizeAgentNickname(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('Nickname must be text');
  const nickname = value.trim();
  if (nickname.length > 80) throw new Error('Nickname must be 80 characters or fewer');
  if (/[@\[\]|\x00-\x1f\x7f]/.test(nickname)) {
    throw new Error('Nickname cannot contain @, [, ], | or control characters');
  }
  return nickname;
}
